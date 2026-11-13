/**
 * CAN-4099 golden: the scoped `file:read-content` branch pinned at the IPC
 * boundary on real temporary filesystems. Captured on the reader that opened
 * the caller's path directly, before the branch became a projection over
 * `worker.filesystem.file.read`. Only the harness (`registerHandlers` and
 * the open hook's path spellings) and the cases marked as deliberate
 * differences changed across that move.
 */
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type FileContentRequest,
  type FileContentResponse,
} from '@canopy/desktop-shared/types';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

jest.mock('electron', () => ({
  nativeImage: { createThumbnailFromPath: jest.fn() },
  shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
}));

jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
  getFileBrowserSupplementalWatchPaths: jest.fn(() => []),
}));

/**
 * Runs once after the next open of one of `paths` (the requested and the
 * resolved spelling of one file) resolves, before the reader continues.
 */
let afterOpen: { paths: string[]; run: () => Promise<void> } | null = null;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
  return {
    ...actual,
    open: jest.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const hook = afterOpen;
      if (hook && hook.paths.includes(String(args[0]))) {
        afterOpen = null;
        await hook.run();
      }
      return handle;
    }),
  };
});

import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { registerFilePreviewHandlers } from '../file-preview';

const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);

const FIVE_MIB = 5 * 1024 * 1024;
const workspaceTarget = { projectId: 'project-1', worktreeId: 'wt-1' };
// The reader ignores the event before CAN-4099; afterwards it derives the
// trusted caller from this sender.
const invokeEvent = { sender: { id: 41 } };

let runtime: DesktopCanopyDispatcher | undefined;

/** The only part of this file that follows the handler's registration. */
function registerHandlers(): void {
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  registerFilePreviewHandlers(runtime, (event) => ({
    principalId: 'local',
    clientInstanceId: `electron-web-contents:${event.sender.id}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  }));
}

function readContent(
  request: FileContentRequest,
): Promise<FileContentResponse> {
  const handler = handlers.get(IPC_CHANNELS.fileReadContent);
  if (!handler) throw new Error('file:read-content is not registered.');
  return Promise.resolve(handler(invokeEvent, request)).then(
    (value) => value as FileContentResponse,
  );
}

function scoped(absolutePath: string): Promise<FileContentResponse> {
  return readContent({ absolutePath, workspaceTarget });
}

function root(
  repoId: string,
  absolutePath: string,
  rootKind: FileBrowserRoot['rootKind'],
  excludedDescendantRoots: string[] = [],
): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind,
    gitAware: rootKind === 'git-repo',
    excludedDescendantRoots,
  };
}

function setRoots(roots: FileBrowserRoot[]): void {
  mockedGetFileBrowserRoots.mockImplementation(() =>
    Promise.resolve({
      roots,
      rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
    }),
  );
}

async function put(path: string, content: string | Buffer): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

async function mtimeMs(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'file-read-content-golden-'));
  handlers.clear();
  afterOpen = null;
  mockedGetFileBrowserRoots.mockReset();
  registerHandlers();
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await rm(tempRoot, { recursive: true, force: true });
});

describe('single-repository worktree', () => {
  let repo = '';
  let attachments = '';

  beforeEach(async () => {
    repo = join(tempRoot, 'single', 'repo');
    attachments = join(tempRoot, 'single', 'attachments');
    await mkdir(repo, { recursive: true });
    await mkdir(attachments, { recursive: true });
    setRoots([
      root('project-1', repo, 'git-repo'),
      root('attachments', attachments, 'attachments'),
    ]);
  });

  it('reads text with its stat size and exact modification time', async () => {
    const file = join(repo, 'src', 'index.ts');
    await put(file, 'export const answer = 42;\n');
    await expect(scoped(file)).resolves.toEqual({
      kind: 'text',
      content: 'export const answer = 42;\n',
      filename: 'index.ts',
      sizeBytes: 26,
      truncated: false,
      modifiedAtMs: await mtimeMs(file),
    });
  });

  it('classifies markdown and HTML by extension', async () => {
    const markdown = join(repo, 'README.MD');
    const html = join(repo, 'docs', 'page.htm');
    await put(markdown, '# Title\n');
    await put(html, '<p>hi</p>');
    await expect(scoped(markdown)).resolves.toMatchObject({
      kind: 'markdown',
      content: '# Title\n',
      filename: 'README.MD',
    });
    await expect(scoped(html)).resolves.toMatchObject({
      kind: 'html',
      content: '<p>hi</p>',
      filename: 'page.htm',
    });
  });

  it('returns an image at the 5 MiB limit as a data URL', async () => {
    const file = join(repo, 'art', 'limit.png');
    const bytes = Buffer.alloc(FIVE_MIB, 7);
    await put(file, bytes);
    const result = await scoped(file);
    expect(result.kind).toBe('image');
    expect(result.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(
      createHash('sha256')
        .update(
          Buffer.from(
            result.content.slice('data:image/png;base64,'.length),
            'base64',
          ),
        )
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result).toMatchObject({
      filename: 'limit.png',
      sizeBytes: FIVE_MIB,
      truncated: false,
      modifiedAtMs: await mtimeMs(file),
    });
  });

  it('maps every image extension to its media type', async () => {
    const types: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
    };
    for (const [extension, mediaType] of Object.entries(types)) {
      const file = join(repo, `image${extension.toUpperCase()}`);
      await put(file, 'xy');
      await expect(scoped(file)).resolves.toMatchObject({
        kind: 'image',
        content: `data:${mediaType};base64,${Buffer.from('xy').toString('base64')}`,
      });
    }
  });

  it('returns an image over 5 MiB as unsupported without content', async () => {
    const file = join(repo, 'art', 'huge.jpg');
    await put(file, Buffer.alloc(FIVE_MIB + 1, 1));
    await expect(scoped(file)).resolves.toEqual({
      kind: 'unsupported',
      content: '',
      filename: 'huge.jpg',
      sizeBytes: FIVE_MIB + 1,
      truncated: false,
      modifiedAtMs: await mtimeMs(file),
    });
  });

  it('truncates text at 5 MiB and reports the full size', async () => {
    const file = join(repo, 'big.log');
    await put(file, Buffer.alloc(FIVE_MIB + 10, 'a'));
    const result = await scoped(file);
    expect(result.kind).toBe('text');
    expect(result.content).toHaveLength(FIVE_MIB);
    expect(result).toMatchObject({
      filename: 'big.log',
      sizeBytes: FIVE_MIB + 10,
      truncated: true,
    });
  });

  it('decodes invalid UTF-8 with replacement characters', async () => {
    const file = join(repo, 'latin1.txt');
    await put(file, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await expect(scoped(file)).resolves.toMatchObject({
      kind: 'text',
      content: 'caf�',
      sizeBytes: 4,
    });
  });

  it('returns a NUL-bearing text file as unsupported', async () => {
    const file = join(repo, 'data.txt');
    await put(file, Buffer.from([0x48, 0x00, 0x49]));
    await expect(scoped(file)).resolves.toEqual({
      kind: 'unsupported',
      content: '',
      filename: 'data.txt',
      sizeBytes: 3,
      truncated: false,
      modifiedAtMs: await mtimeMs(file),
    });
  });

  it('returns an empty file as empty text', async () => {
    const file = join(repo, 'empty.md');
    await put(file, '');
    await expect(scoped(file)).resolves.toMatchObject({
      kind: 'markdown',
      content: '',
      sizeBytes: 0,
      truncated: false,
    });
  });

  it('returns a known binary extension as unsupported without reading it', async () => {
    const file = join(repo, 'manual.PDF');
    await put(file, 'plain text in a pdf name');
    await expect(scoped(file)).resolves.toEqual({
      kind: 'unsupported',
      content: '',
      filename: 'manual.PDF',
      sizeBytes: 24,
      truncated: false,
      modifiedAtMs: await mtimeMs(file),
    });
  });

  it('returns a missing file as missing with the requested name', async () => {
    await expect(scoped(join(repo, 'gone', 'later.ts'))).resolves.toEqual({
      kind: 'missing',
      content: '',
      filename: 'later.ts',
      sizeBytes: 0,
      truncated: false,
      modifiedAtMs: 0,
    });
  });

  it('returns a dangling symlink as missing', async () => {
    await symlink(join(repo, 'nowhere.txt'), join(repo, 'dangling.txt'));
    await expect(scoped(join(repo, 'dangling.txt'))).resolves.toMatchObject({
      kind: 'missing',
      filename: 'dangling.txt',
    });
  });

  it('reads a file inside .git like any contained file', async () => {
    const file = join(repo, '.git', 'config');
    await put(file, '[core]\n');
    await expect(scoped(file)).resolves.toMatchObject({
      kind: 'text',
      content: '[core]\n',
      filename: 'config',
    });
  });

  it('reads through a symlink into another root of the scope', async () => {
    const target = join(attachments, 'brief.md');
    await put(target, '# Brief\n');
    await symlink(target, join(repo, 'brief-link.txt'));
    await expect(scoped(join(repo, 'brief-link.txt'))).resolves.toEqual({
      kind: 'markdown',
      content: '# Brief\n',
      filename: 'brief.md',
      sizeBytes: 8,
      truncated: false,
      modifiedAtMs: await mtimeMs(target),
    });
  });

  it('classifies a symlinked file by its resolved name', async () => {
    const target = join(repo, 'plan.md');
    await put(target, '# Plan\n');
    await symlink(target, join(repo, 'notes.txt'));
    await expect(scoped(join(repo, 'notes.txt'))).resolves.toMatchObject({
      kind: 'markdown',
      filename: 'plan.md',
    });
  });

  it('reads a path given through a symlinked root path', async () => {
    const alias = join(tempRoot, 'repo-alias');
    await symlink(repo, alias);
    await put(join(repo, 'a.txt'), 'via alias');
    await expect(scoped(join(alias, 'a.txt'))).resolves.toMatchObject({
      kind: 'text',
      content: 'via alias',
    });
  });

  it('rejects a symlink whose target leaves every root', async () => {
    const outside = join(tempRoot, 'outside', 'secret.txt');
    await put(outside, 'secret');
    await symlink(outside, join(repo, 'escape.txt'));
    await expect(scoped(join(repo, 'escape.txt'))).rejects.toThrow(
      'Cannot read file outside the target project roots',
    );
  });

  it('rejects a path outside every root', async () => {
    const outside = join(tempRoot, 'outside', 'plain.txt');
    await put(outside, 'plain');
    await expect(scoped(outside)).rejects.toThrow(
      'Cannot read file outside the target project roots',
    );
  });

  it('rejects a lexical traversal that resolves outside every root', async () => {
    await put(join(tempRoot, 'outside', 'up.txt'), 'up');
    await expect(scoped(`${repo}/../../outside/up.txt`)).rejects.toThrow(
      'Cannot read file outside the target project roots',
    );
  });

  // CAN-4099 deliberate difference: captured as the platform's
  // `EISDIR: illegal operation on a directory, read`; a directory is now
  // refused as not a regular file before it is opened.
  it('rejects a directory', async () => {
    await mkdir(join(repo, 'folder'), { recursive: true });
    await expect(scoped(join(repo, 'folder'))).rejects.toThrow(
      'Cannot read a path that is not a regular file',
    );
  });

  it('rejects a file replaced after it was opened', async () => {
    const file = join(repo, 'swap.txt');
    await put(file, 'original');
    await put(join(repo, 'replacement.txt'), 'replacement');
    afterOpen = {
      paths: [file, await realpath(file)],
      run: (): Promise<void> => rename(join(repo, 'replacement.txt'), file),
    };
    await expect(scoped(file)).rejects.toThrow(
      'Cannot read a file that changed while being validated',
    );
  });

  it('keeps the request validation errors', async () => {
    await expect(
      readContent({ absolutePath: 'relative/path.txt', workspaceTarget }),
    ).rejects.toThrow('Invalid absolutePath: must be an absolute path');
    await expect(
      readContent({
        absolutePath: join(repo, 'a.txt'),
        workspaceTarget: { projectId: 'Bad Id', worktreeId: 'wt-1' },
      }),
    ).rejects.toThrow(
      'Invalid projectId: must be lowercase alphanumeric with hyphens',
    );
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
  });

  // CAN-6175 D3: a cloud file's path is no host path, so it fails closed here.
  it('refuses a cloud file path and a cloud scope', async () => {
    const cloudPath = 'web-core:chat-1/workspace/src/index.ts';
    await expect(
      readContent({ absolutePath: cloudPath, workspaceTarget }),
    ).rejects.toThrow('Invalid absolutePath: must be an absolute path');
    await expect(readContent({ absolutePath: cloudPath })).rejects.toThrow(
      'Invalid absolutePath: must be an absolute path',
    );
    await expect(
      readContent({
        absolutePath: join(repo, 'a.txt'),
        workspaceTarget: {
          projectId: 'project-1',
          worktreeId: 'web-core:chat-1',
        },
      }),
    ).rejects.toThrow('Invalid worktreeId');
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
  });

  it('propagates a roots failure unchanged', async () => {
    mockedGetFileBrowserRoots.mockRejectedValue(
      new Error('Project project-1 not found'),
    );
    await expect(scoped(join(repo, 'a.txt'))).rejects.toThrow(
      'Project project-1 not found',
    );
  });
});

describe('multi-repository worktree', () => {
  it('reads child checkouts through their own root and the workspace root', async () => {
    const workspace = join(tempRoot, 'multi', 'root');
    const repos = join(workspace, 'repos');
    const api = join(repos, 'api');
    const attachments = join(tempRoot, 'multi', 'attachments');
    await mkdir(api, { recursive: true });
    await mkdir(attachments, { recursive: true });
    setRoots([
      root('__workspace_root__', workspace, 'workspace-root', [repos, api]),
      root('api', api, 'git-repo'),
      root('attachments', attachments, 'attachments'),
    ]);
    await put(join(api, 'server.ts'), 'serve();\n');
    await put(join(workspace, 'AGENTS.md'), '# Agents\n');
    await put(join(attachments, 'note.txt'), 'attached');

    await expect(scoped(join(api, 'server.ts'))).resolves.toMatchObject({
      kind: 'text',
      content: 'serve();\n',
      filename: 'server.ts',
    });
    await expect(scoped(join(workspace, 'AGENTS.md'))).resolves.toMatchObject({
      kind: 'markdown',
      content: '# Agents\n',
    });
    await expect(scoped(join(attachments, 'note.txt'))).resolves.toMatchObject({
      kind: 'text',
      content: 'attached',
    });
  });
});

describe('Cowork project', () => {
  it('reads the project folder and its managed roots', async () => {
    const home = join(tempRoot, 'cowork', 'home');
    const managed = join(home, '.canopy');
    const notes = join(managed, 'notes');
    const prompts = join(managed, 'prompts');
    const attachments = join(managed, 'attachments');
    await mkdir(notes, { recursive: true });
    await mkdir(prompts, { recursive: true });
    await mkdir(attachments, { recursive: true });
    setRoots([
      root('workspace', home, 'standalone', [notes, prompts, attachments]),
      root('notes', notes, 'standalone'),
      root('prompts', prompts, 'standalone'),
      root('attachments', attachments, 'attachments'),
    ]);
    await put(join(home, 'draft.md'), '# Draft\n');
    await put(join(notes, 'today.md'), '- one\n');
    await put(join(prompts, 'ask.txt'), 'ask');

    await expect(scoped(join(home, 'draft.md'))).resolves.toMatchObject({
      kind: 'markdown',
      content: '# Draft\n',
    });
    await expect(scoped(join(notes, 'today.md'))).resolves.toMatchObject({
      kind: 'markdown',
      content: '- one\n',
    });
    await expect(scoped(join(prompts, 'ask.txt'))).resolves.toMatchObject({
      kind: 'text',
      content: 'ask',
    });
  });
});
