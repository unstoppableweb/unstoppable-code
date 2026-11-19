/**
 * CAN-4101 golden: explorer `file-tree:mutate` behavior pinned at the IPC
 * boundary on real temporary filesystems. Captured on the Electron-main
 * mutation service (after CAN-5176) and kept unmodified while move, copy,
 * rename and delete become `worker.filesystem.entry.*` instructions. Only
 * `registerHandlers` follows the handler's registration; Trash is observed
 * through `electron.shell.trashItem` and faults through `node:fs/promises`.
 * CAN-4100 extended the create cases on the unchanged service and kept them
 * while create became `worker.filesystem.directory.create` and `.file.write`;
 * the cases marked as deliberate differences changed with it.
 */
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { buildCoworkRootCatalog } from '@canopy/core-runtime/node';
import {
  COWORK_WORKSPACE_FILE_ROOT_ID,
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type FileTreeMutationResponse,
} from '@canopy/desktop-shared/types';
import type * as FileBrowserRootsModule from '../../lib/file-browser-roots';
import type * as ElectronMock from '../../../__tests__/electronMock';
import type {
  DesktopAppWindow,
  DesktopIpcEvent,
} from '../../canopy-runtime/desktop-ipc-caller';

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

const mockTrashItem = jest.fn<Promise<void>, [string]>();
jest.mock('electron', () => {
  const actual = jest.requireActual<typeof ElectronMock>('electron');
  return {
    ...actual,
    shell: {
      ...actual.shell,
      trashItem: (path: string): Promise<void> => mockTrashItem(path),
    },
  };
});

interface MockFault {
  method: string;
  /** Matches one argument's exact path, since staging paths are random. */
  argIndex: number;
  path: string;
  run: () => Promise<void>;
}
/** One-shot faults, each run before the next matching write call. */
let mockFaults: MockFault[] = [];
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
  function faulted<Args extends unknown[], Result>(
    method: string,
    run: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return async (...args: Args): Promise<Result> => {
      const index = mockFaults.findIndex(
        (fault) =>
          fault.method === method &&
          String(args[fault.argIndex]) === fault.path,
      );
      if (index !== -1) {
        const [fault] = mockFaults.splice(index, 1);
        await fault?.run();
      }
      return run(...args);
    };
  }
  return {
    ...actual,
    cp: faulted('cp', actual.cp),
    copyFile: faulted('copyFile', actual.copyFile),
    link: faulted('link', actual.link),
    mkdir: faulted('mkdir', actual.mkdir),
    rename: faulted('rename', actual.rename),
    rm: faulted('rm', actual.rm),
    rmdir: faulted('rmdir', actual.rmdir),
    symlink: faulted('symlink', actual.symlink),
    unlink: faulted('unlink', actual.unlink),
  };
});

jest.mock('../../lib/file-browser-roots', () => {
  const actual = jest.requireActual<typeof FileBrowserRootsModule>(
    '../../lib/file-browser-roots',
  );
  return {
    ...actual,
    getFileBrowserRoots: jest.fn(actual.getFileBrowserRoots),
  };
});
jest.mock('../../lib/paths', () => ({
  getWorkspaceHomeDir: jest.fn(),
  getWorkspaceWorktreeRepoDir: jest.fn(),
  getWorkspaceWorktreeReposDir: jest.fn(),
  getWorkspaceWorktreeRootRepoDir: jest.fn(),
  getWorktreeAttachmentsDir: jest.fn(),
  getWorkspaceWorktreeAttachmentsDir: jest.fn(),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
  resolveWorktreeTargetIds: jest.fn(),
}));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
  isCoworkWorkspace: jest.fn(() => false),
}));

import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  getWorkspaceWorktreeAttachmentsDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeReposDir,
  getWorkspaceWorktreeRootRepoDir,
  getWorktreeAttachmentsDir,
} from '../../lib/paths';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../../lib/resolve-worktree';
import { readWorkspaceConfig } from '../../lib/workspace-persistence';
import { isMultiRepoWorkspace } from '../../lib/workspace-registry';
import {
  acquireSplitLock,
  releaseSplitLock,
} from '../../services/split-lock-service';
import { useFakeSplitLockKeys } from '../../__tests__/split-lock-key-fixture';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { deriveDesktopIpcCaller } from '../../canopy-runtime/desktop-ipc-caller';
import { registerFileTreeHandlers } from '../file-tree';

const fs = jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedResolveWorktreeTargetIds = jest.mocked(resolveWorktreeTargetIds);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);

const isPosixHost = process.platform !== 'win32';
const itPosix = isPosixHost ? it : it.skip;
const APP_URL = 'file:///app/renderer/index.html';
const BRIDGE_SENDER_ID = 902;

function createEvent(id: number): DesktopIpcEvent {
  const mainFrame = {
    url: APP_URL,
    detached: false,
    isDestroyed: (): boolean => false,
  };
  return {
    sender: {
      id,
      mainFrame,
      getURL: (): string => APP_URL,
      isDestroyed: (): boolean => false,
    },
    senderFrame: mainFrame,
  };
}

const windowEvent = createEvent(901);
const bridgeEvent = createEvent(BRIDGE_SENDER_ID);
const appWindow: DesktopAppWindow = {
  isDestroyed: () => false,
  webContents: windowEvent.sender,
};

let runtime: DesktopCanopyDispatcher | undefined;

/** The only part of this file that follows the handler's registration. */
function registerHandlers(): void {
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  registerFileTreeHandlers(
    runtime,
    (event): CanopyCallerDescriptor =>
      deriveDesktopIpcCaller(event, {
        getAppWindows: () => [appWindow],
        packagedRendererUrls: [APP_URL],
        resolveRemoteBridgeSender: (sender) =>
          sender.id === BRIDGE_SENDER_ID ? 'controller-device' : null,
      }),
  );
}

function isMutationResponse(value: unknown): value is FileTreeMutationResponse {
  return typeof value === 'object' && value !== null && 'operation' in value;
}

async function mutate(
  request: Record<string, unknown>,
  event: DesktopIpcEvent = windowEvent,
): Promise<FileTreeMutationResponse> {
  const handler = handlers.get(IPC_CHANNELS.fileTreeMutate);
  if (!handler) throw new Error('file-tree:mutate is not registered.');
  const response = await handler(event, request);
  if (!isMutationResponse(response)) {
    throw new Error('Expected a file-tree mutation response.');
  }
  return response;
}

/** What the renderer sees: `${name}: ${message}`, plus a Node error code. */
async function failure(
  request: Record<string, unknown>,
): Promise<{ rendered: string; code: unknown }> {
  try {
    await mutate(request);
  } catch (error) {
    return {
      rendered: String(error),
      code:
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined,
    };
  }
  throw new Error('Expected the mutation to fail.');
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code });
}

function injectFault(
  method: string,
  firstArg: string,
  run: () => Promise<void>,
): void {
  mockFaults.push({ method, argIndex: 0, path: firstArg, run });
}

function injectTargetFault(
  method: string,
  targetArg: string,
  run: () => Promise<void>,
): void {
  mockFaults.push({ method, argIndex: 1, path: targetArg, run });
}

async function stagingLeftovers(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).filter((name) =>
    name.startsWith('.canopy-'),
  );
}

function failWith(code: string): () => Promise<void> {
  return () => Promise.reject(errno(code));
}

/** Every entry under `root`: file content, `dir`, or `-> link target`. */
async function tree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const name of (await fs.readdir(directory)).sort()) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = await fs.lstat(path);
      if (info.isSymbolicLink()) {
        entries[relativePath] = `-> ${await fs.readlink(path)}`;
      } else if (info.isDirectory()) {
        entries[`${relativePath}/`] = 'dir';
        await walk(path, relativePath);
      } else {
        entries[relativePath] = await fs.readFile(path, 'utf8');
      }
    }
  }
  await walk(root, '');
  return entries;
}

async function put(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
}

const OLD_TIME = new Date('2020-01-02T03:04:05.000Z');

async function expectOldMtime(path: string): Promise<void> {
  const { mtimeMs } = await fs.lstat(path);
  expect(Math.abs(mtimeMs - OLD_TIME.getTime())).toBeLessThanOrEqual(2);
}

let tempRoot = '';

useFakeSplitLockKeys();
beforeEach(async () => {
  tempRoot = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'file-tree-mutate-golden-')),
  );
  handlers.clear();
  mockFaults = [];
  mockTrashItem.mockReset();
  mockTrashItem.mockResolvedValue(undefined);
  const actualRoots = jest.requireActual<typeof FileBrowserRootsModule>(
    '../../lib/file-browser-roots',
  );
  mockedGetFileBrowserRoots.mockReset();
  mockedGetFileBrowserRoots.mockImplementation(actualRoots.getFileBrowserRoots);
  mockedResolveWorktreeTargetIds.mockReset();
  mockedResolveWorktreeTargetIds.mockImplementation(
    (projectId, worktreeId) => ({ projectId, worktreeId }),
  );
  mockedIsMultiRepoWorkspace.mockReturnValue(false);
  registerHandlers();
});

afterEach(async () => {
  expect(mockFaults).toEqual([]);
  await runtime?.shutdown();
  runtime = undefined;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const scope = { projectId: 'project-1', worktreeId: 'wt-1' };
const ref = (
  relativePath: string,
  repoId = 'project-1',
): { repoId: string; relativePath: string } => ({ repoId, relativePath });

describe('single-repository worktree', () => {
  let repo = '';
  let attachments = '';

  beforeEach(async () => {
    repo = join(tempRoot, 'repo');
    attachments = join(tempRoot, 'attachments');
    await put(join(repo, 'src', 'index.ts'), 'export {};\n');
    await put(join(repo, 'docs', 'guide', 'intro.md'), '# Intro\n');
    await put(join(attachments, 'note.txt'), 'note\n');
    mockedResolveWorktreeCwd.mockReturnValue(repo);
    jest.mocked(getWorktreeAttachmentsDir).mockReturnValue(attachments);
  });

  describe.each([
    ['an app window', windowEvent],
    ['the remote-control bridge', bridgeEvent],
  ])('from %s', (_label, event) => {
    it('creates, renames, copies and deletes', async () => {
      await expect(
        mutate(
          { ...scope, operation: 'create-file', target: ref('a/b/new.txt') },
          event,
        ),
      ).resolves.toEqual({
        operation: 'create-file',
        target: ref('a/b/new.txt'),
      });
      await expect(
        mutate(
          { ...scope, operation: 'create-directory', target: ref('c/d') },
          event,
        ),
      ).resolves.toEqual({
        operation: 'create-directory',
        target: ref('c/d'),
      });
      await expect(
        mutate(
          {
            ...scope,
            operation: 'move',
            source: ref('a/b/new.txt'),
            target: ref('a/b/renamed.txt'),
          },
          event,
        ),
      ).resolves.toEqual({
        operation: 'move',
        source: ref('a/b/new.txt'),
        target: ref('a/b/renamed.txt'),
      });
      await expect(
        mutate(
          {
            ...scope,
            operation: 'copy',
            source: ref('docs'),
            target: ref('c/d/docs'),
            conflict: 'error',
          },
          event,
        ),
      ).resolves.toEqual({
        operation: 'copy',
        source: ref('docs'),
        target: ref('c/d/docs'),
      });
      await expect(
        mutate(
          {
            ...scope,
            operation: 'delete',
            target: ref('docs'),
            useTrash: true,
          },
          event,
        ),
      ).resolves.toEqual({ operation: 'delete', target: ref('docs') });
      await expect(
        mutate({ ...scope, operation: 'delete', target: ref('src') }, event),
      ).resolves.toEqual({ operation: 'delete', target: ref('src') });

      expect(mockTrashItem.mock.calls).toEqual([[join(repo, 'docs')]]);
      expect(await tree(repo)).toEqual({
        'a/': 'dir',
        'a/b/': 'dir',
        'a/b/renamed.txt': '',
        'c/': 'dir',
        'c/d/': 'dir',
        'c/d/docs/': 'dir',
        'c/d/docs/guide/': 'dir',
        'c/d/docs/guide/intro.md': '# Intro\n',
        'docs/': 'dir',
        'docs/guide/': 'dir',
        'docs/guide/intro.md': '# Intro\n',
      });
    });
  });

  describe('create', () => {
    it('refuses an existing entry with EEXIST', async () => {
      for (const operation of ['create-file', 'create-directory']) {
        await expect(
          failure({ ...scope, operation, target: ref('src/index.ts') }),
        ).resolves.toMatchObject({ code: 'EEXIST' });
      }
      await expect(
        failure({
          ...scope,
          operation: 'create-directory',
          target: ref('src'),
        }),
      ).resolves.toMatchObject({ code: 'EEXIST' });
      expect(await fs.readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
        'export {};\n',
      );
    });

    itPosix(
      'refuses a target behind a symlink that leaves the root',
      async () => {
        await fs.mkdir(join(tempRoot, 'outside'));
        await fs.symlink(join(tempRoot, 'outside'), join(repo, 'out'));
        await expect(
          failure({
            ...scope,
            operation: 'create-file',
            target: ref('out/x.txt'),
          }),
        ).resolves.toEqual({
          rendered:
            'RemoteControlServiceError: File is outside the selected worktree root.',
          code: 'invalid_target',
        });
        expect(await fs.readdir(join(tempRoot, 'outside'))).toEqual([]);
      },
    );

    it('creates missing parents and leaves an empty new file', async () => {
      await expect(
        mutate({
          ...scope,
          operation: 'create-directory',
          target: ref('x/y/z'),
        }),
      ).resolves.toEqual({
        operation: 'create-directory',
        target: ref('x/y/z'),
      });
      await expect(
        mutate({ ...scope, operation: 'create-file', target: ref('x/new.md') }),
      ).resolves.toEqual({ operation: 'create-file', target: ref('x/new.md') });
      await expect(
        mutate({
          ...scope,
          operation: 'create-file',
          target: ref('./src//other.ts'),
        }),
      ).resolves.toEqual({
        operation: 'create-file',
        target: ref('src/other.ts'),
      });
      expect(await tree(join(repo, 'x'))).toEqual({
        'new.md': '',
        'y/': 'dir',
        'y/z/': 'dir',
      });
      expect(await fs.readFile(join(repo, 'src', 'other.ts'), 'utf8')).toBe('');
    });

    // The containment walk's realpath fails first, before any mkdir.
    it('refuses an existing file used as a parent folder with ENOTDIR', async () => {
      for (const operation of ['create-file', 'create-directory']) {
        await expect(
          failure({
            ...scope,
            operation,
            target: ref('src/index.ts/inner'),
          }),
        ).resolves.toMatchObject({ code: 'ENOTDIR' });
        await expect(
          failure({
            ...scope,
            operation,
            target: ref('src/index.ts/deeper/inner'),
          }),
        ).resolves.toMatchObject({ code: 'ENOTDIR' });
      }
      expect(await fs.readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
        'export {};\n',
      );
    });

    // Added after the cutover (CAN-4100 review), from the deleted service's
    // `mkdir -p` then exclusive create: a folder made meanwhile is accepted,
    // a file made meanwhile fails with mkdir's EEXIST.
    it('creates distinct files under one new folder at the same time', async () => {
      const created = await Promise.all(
        ['a.txt', 'b.txt', 'c.txt'].map((name) =>
          mutate({
            ...scope,
            operation: 'create-file',
            target: ref(`fresh/${name}`),
          }),
        ),
      );
      expect(created.map((response) => response.target)).toEqual([
        ref('fresh/a.txt'),
        ref('fresh/b.txt'),
        ref('fresh/c.txt'),
      ]);
      expect(await tree(join(repo, 'fresh'))).toEqual({
        'a.txt': '',
        'b.txt': '',
        'c.txt': '',
      });
    });

    it('creates the file when its missing parent appears before the mkdir', async () => {
      injectFault('mkdir', join(repo, 'fresh'), () =>
        fs.mkdir(join(repo, 'fresh')).then(() => undefined),
      );
      await expect(
        mutate({
          ...scope,
          operation: 'create-file',
          target: ref('fresh/new.txt'),
        }),
      ).resolves.toEqual({
        operation: 'create-file',
        target: ref('fresh/new.txt'),
      });
      expect(await tree(join(repo, 'fresh'))).toEqual({ 'new.txt': '' });
    });

    it('refuses a missing parent that appears as a file with EEXIST', async () => {
      injectFault('mkdir', join(repo, 'fresh'), () =>
        fs.writeFile(join(repo, 'fresh'), 'file\n'),
      );
      await expect(
        failure({
          ...scope,
          operation: 'create-file',
          target: ref('fresh/new.txt'),
        }),
      ).resolves.toMatchObject({ code: 'EEXIST' });
      expect(await fs.readFile(join(repo, 'fresh'), 'utf8')).toBe('file\n');
    });

    itPosix(
      'creates the file when its missing parent appears as a link inside the root',
      async () => {
        await fs.mkdir(join(repo, 'real'));
        injectFault('mkdir', join(repo, 'fresh'), () =>
          fs.symlink(join(repo, 'real'), join(repo, 'fresh')),
        );
        await mutate({
          ...scope,
          operation: 'create-file',
          target: ref('fresh/new.txt'),
        });
        expect(await tree(join(repo, 'real'))).toEqual({ 'new.txt': '' });
      },
    );

    itPosix(
      'refuses a missing parent that appears as a link out of the root',
      async () => {
        await fs.mkdir(join(tempRoot, 'outside'));
        injectFault('mkdir', join(repo, 'fresh'), () =>
          fs.symlink(join(tempRoot, 'outside'), join(repo, 'fresh')),
        );
        await expect(
          failure({
            ...scope,
            operation: 'create-file',
            target: ref('fresh/new.txt'),
          }),
        ).resolves.toEqual({
          rendered:
            'RemoteControlServiceError: File is outside the selected worktree root.',
          code: 'invalid_target',
        });
        expect(await fs.readdir(join(tempRoot, 'outside'))).toEqual([]);
      },
    );

    // Deliberate difference (CAN-4100): a create without a target fails as
    // delete, copy and move do, instead of with a TypeError.
    it('refuses a request without a target as invalid_payload', async () => {
      for (const operation of ['create-file', 'create-directory']) {
        await expect(failure({ ...scope, operation })).resolves.toEqual({
          rendered: 'RemoteControlServiceError: Mutation target is missing.',
          code: 'invalid_payload',
        });
      }
      expect(await tree(repo)).toEqual({
        'docs/': 'dir',
        'docs/guide/': 'dir',
        'docs/guide/intro.md': '# Intro\n',
        'src/': 'dir',
        'src/index.ts': 'export {};\n',
      });
    });

    itPosix('refuses a dangling symlink at the target', async () => {
      await fs.symlink('missing-target', join(repo, 'dangling'));
      for (const operation of ['create-file', 'create-directory']) {
        await expect(
          failure({ ...scope, operation, target: ref('dangling') }),
        ).resolves.toMatchObject({ code: 'EEXIST' });
      }
      expect(await fs.readlink(join(repo, 'dangling'))).toBe('missing-target');
      expect(await fs.readdir(repo)).not.toContain('missing-target');
    });

    itPosix('creates through an in-root symlinked folder', async () => {
      await fs.symlink('docs', join(repo, 'docs-link'));
      await mutate({
        ...scope,
        operation: 'create-file',
        target: ref('docs-link/guide/new.md'),
      });
      await mutate({
        ...scope,
        operation: 'create-directory',
        target: ref('docs-link/fresh/sub'),
      });
      expect(await tree(join(repo, 'docs'))).toEqual({
        'fresh/': 'dir',
        'fresh/sub/': 'dir',
        'guide/': 'dir',
        'guide/intro.md': '# Intro\n',
        'guide/new.md': '',
      });
    });

    it('creates into the attachments root', async () => {
      await expect(
        mutate({
          ...scope,
          operation: 'create-file',
          target: ref('inbox/new.txt', 'attachments'),
        }),
      ).resolves.toEqual({
        operation: 'create-file',
        target: ref('inbox/new.txt', 'attachments'),
      });
      expect(await tree(attachments)).toEqual({
        'inbox/': 'dir',
        'inbox/new.txt': '',
        'note.txt': 'note\n',
      });
    });
  });

  describe('move and rename', () => {
    it('renames a file in place, keeping its identity and timestamp', async () => {
      const source = join(repo, 'src', 'index.ts');
      await fs.utimes(source, OLD_TIME, OLD_TIME);
      const { ino } = await fs.lstat(source);
      await mutate({
        ...scope,
        operation: 'move',
        source: ref('src/index.ts'),
        target: ref('src/main.ts'),
        conflict: 'error',
      });
      const moved = join(repo, 'src', 'main.ts');
      expect((await fs.lstat(moved)).ino).toBe(ino);
      await expectOldMtime(moved);
      expect(await fs.readdir(join(repo, 'src'))).toEqual(['main.ts']);
    });

    it('moves a directory with nested contents into a new parent', async () => {
      const source = join(repo, 'docs');
      await fs.utimes(source, OLD_TIME, OLD_TIME);
      const { ino } = await fs.lstat(source);
      await expect(
        mutate({
          ...scope,
          operation: 'move',
          source: ref('docs'),
          target: ref('archive/2020/docs'),
        }),
      ).resolves.toEqual({
        operation: 'move',
        source: ref('docs'),
        target: ref('archive/2020/docs'),
      });
      const moved = join(repo, 'archive', '2020', 'docs');
      expect((await fs.lstat(moved)).ino).toBe(ino);
      await expectOldMtime(moved);
      expect(await tree(repo)).toEqual({
        'archive/': 'dir',
        'archive/2020/': 'dir',
        'archive/2020/docs/': 'dir',
        'archive/2020/docs/guide/': 'dir',
        'archive/2020/docs/guide/intro.md': '# Intro\n',
        'src/': 'dir',
        'src/index.ts': 'export {};\n',
      });
    });

    it('renames a file and a directory by case alone', async () => {
      await put(join(repo, 'readme.md'), 'read me\n');
      await fs.mkdir(join(repo, 'lib'));
      for (const [from, to] of [
        ['readme.md', 'README.md'],
        ['lib', 'Lib'],
      ] as const) {
        await mutate({
          ...scope,
          operation: 'move',
          source: ref(from),
          target: ref(to),
          conflict: 'error',
        });
      }
      const names = await fs.readdir(repo);
      expect(names).toEqual(expect.arrayContaining(['README.md', 'Lib']));
      expect(names).not.toContain('readme.md');
      expect(names).not.toContain('lib');
      expect(await fs.readFile(join(repo, 'README.md'), 'utf8')).toBe(
        'read me\n',
      );
    });

    it('refuses an occupied target, including a dangling symlink', async () => {
      await put(join(repo, 'taken.txt'), 'taken\n');
      const targets = ['taken.txt', 'docs'];
      if (isPosixHost) {
        await fs.symlink('missing', join(repo, 'dangling'));
        targets.push('dangling');
      }
      const before = await tree(repo);
      for (const target of targets) {
        await expect(
          failure({
            ...scope,
            operation: 'move',
            source: ref('src/index.ts'),
            target: ref(target),
            conflict: 'error',
          }),
        ).resolves.toEqual({
          rendered: `RemoteControlServiceError: A file or folder already exists at ${target}.`,
          code: 'invalid_target',
        });
      }
      expect(await tree(repo)).toEqual(before);
    });

    it('refuses moving or copying a folder into itself', async () => {
      for (const operation of ['move', 'copy']) {
        await expect(
          failure({
            ...scope,
            operation,
            source: ref('docs'),
            target: ref('docs/guide/docs'),
            conflict: 'error',
          }),
        ).resolves.toEqual({
          rendered:
            'RemoteControlServiceError: A folder cannot be moved or copied into itself.',
          code: 'invalid_target',
        });
      }
      await expect(tree(join(repo, 'docs'))).resolves.toEqual({
        'guide/': 'dir',
        'guide/intro.md': '# Intro\n',
      });
    });

    it('leaves created parent folders behind after a failed move', async () => {
      const source = join(repo, 'src', 'index.ts');
      const target = join(repo, 'deep', 'new', 'index.ts');
      injectFault('link', source, failWith('EIO'));
      await expect(
        failure({
          ...scope,
          operation: 'move',
          source: ref('src/index.ts'),
          target: ref('deep/new/index.ts'),
          conflict: 'error',
        }),
      ).resolves.toMatchObject({ code: 'EIO' });
      expect(await tree(join(repo, 'deep'))).toEqual({ 'new/': 'dir' });
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(source, 'utf8')).toBe('export {};\n');
    });

    it('rolls a file move back when the source cannot be unlinked', async () => {
      const source = join(repo, 'src', 'index.ts');
      injectFault('unlink', source, failWith('EPERM'));
      await expect(
        failure({
          ...scope,
          operation: 'move',
          source: ref('src/index.ts'),
          target: ref('moved.ts'),
          conflict: 'error',
        }),
      ).resolves.toMatchObject({ code: 'EPERM' });
      expect(await fs.readFile(source, 'utf8')).toBe('export {};\n');
      await expect(fs.lstat(join(repo, 'moved.ts'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await fs.lstat(source)).nlink).toBe(1);
    });

    it('reports the unlink failure when the rollback also fails', async () => {
      const source = join(repo, 'src', 'index.ts');
      const target = join(repo, 'moved.ts');
      injectFault('unlink', source, failWith('EPERM'));
      injectFault('unlink', target, failWith('EIO'));
      await expect(
        failure({
          ...scope,
          operation: 'move',
          source: ref('src/index.ts'),
          target: ref('moved.ts'),
          conflict: 'error',
        }),
      ).resolves.toMatchObject({ code: 'EPERM' });
      expect(await fs.readFile(source, 'utf8')).toBe('export {};\n');
      expect(await fs.readFile(target, 'utf8')).toBe('export {};\n');
    });

    it('keeps the moved file and reports failure when the source vanishes before unlink', async () => {
      const source = join(repo, 'src', 'index.ts');
      const target = join(repo, 'moved.ts');
      injectFault('unlink', source, () => fs.rm(source));
      await expect(
        failure({
          ...scope,
          operation: 'move',
          source: ref('src/index.ts'),
          target: ref('moved.ts'),
          conflict: 'error',
        }),
      ).resolves.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(target, 'utf8')).toBe('export {};\n');
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('moves a file across devices, keeping both copies if the source stays', async () => {
      const source = join(repo, 'src', 'index.ts');
      const target = join(repo, 'moved.ts');
      await fs.utimes(source, OLD_TIME, OLD_TIME);
      const request = {
        ...scope,
        operation: 'move',
        source: ref('src/index.ts'),
        target: ref('moved.ts'),
        conflict: 'error',
      };
      injectFault('link', source, failWith('EXDEV'));
      injectFault('rm', source, failWith('EACCES'));
      await expect(failure(request)).resolves.toMatchObject({
        code: 'EACCES',
      });
      expect(await fs.readFile(source, 'utf8')).toBe('export {};\n');
      expect(await fs.readFile(target, 'utf8')).toBe('export {};\n');

      await fs.rm(target);
      injectFault('link', source, failWith('EXDEV'));
      await expect(mutate(request)).resolves.toEqual({
        operation: 'move',
        source: ref('src/index.ts'),
        target: ref('moved.ts'),
      });
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
      await expectOldMtime(target);
      await expect(stagingLeftovers(repo)).resolves.toEqual([]);
    });

    itPosix(
      'moves a directory across devices by copying, then removing the source',
      async () => {
        const source = join(repo, 'docs');
        injectFault('rename', source, failWith('EXDEV'));
        await mutate({
          ...scope,
          operation: 'move',
          source: ref('docs'),
          target: ref('moved-docs'),
          conflict: 'error',
        });
        await expect(fs.lstat(source)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await tree(join(repo, 'moved-docs'))).toEqual({
          'guide/': 'dir',
          'guide/intro.md': '# Intro\n',
        });
        await expect(stagingLeftovers(repo)).resolves.toEqual([]);
      },
    );

    itPosix(
      'keeps both copies when a cross-device source removal fails',
      async () => {
        const source = join(repo, 'docs');
        injectFault('rename', source, failWith('EXDEV'));
        injectFault('rm', source, failWith('EACCES'));
        await expect(
          failure({
            ...scope,
            operation: 'move',
            source: ref('docs'),
            target: ref('moved-docs'),
            conflict: 'error',
          }),
        ).resolves.toMatchObject({ code: 'EACCES' });
        const expected = { 'guide/': 'dir', 'guide/intro.md': '# Intro\n' };
        expect(await tree(source)).toEqual(expected);
        expect(await tree(join(repo, 'moved-docs'))).toEqual(expected);
      },
    );

    itPosix(
      'removes its empty reservation when a directory rename fails',
      async () => {
        injectFault('rename', join(repo, 'docs'), failWith('EIO'));
        await expect(
          failure({
            ...scope,
            operation: 'move',
            source: ref('docs'),
            target: ref('moved-docs'),
            conflict: 'error',
          }),
        ).resolves.toMatchObject({ code: 'EIO' });
        await expect(fs.lstat(join(repo, 'moved-docs'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(
          await fs.readFile(join(repo, 'docs/guide/intro.md'), 'utf8'),
        ).toBe('# Intro\n');
      },
    );
  });

  describe('copy', () => {
    it('copies a file as an independent entry with its timestamp', async () => {
      const source = join(repo, 'src', 'index.ts');
      await fs.utimes(source, OLD_TIME, OLD_TIME);
      await expect(
        mutate({
          ...scope,
          operation: 'copy',
          source: ref('src/index.ts'),
          target: ref('lib/index.ts'),
          conflict: 'error',
        }),
      ).resolves.toEqual({
        operation: 'copy',
        source: ref('src/index.ts'),
        target: ref('lib/index.ts'),
      });
      const copy = join(repo, 'lib', 'index.ts');
      await expectOldMtime(copy);
      await fs.writeFile(copy, 'changed\n');
      expect(await fs.readFile(source, 'utf8')).toBe('export {};\n');
      expect((await fs.lstat(source)).nlink).toBe(1);
    });

    it('names incremental copies of files, dotted folders and nested paths', async () => {
      await fs.mkdir(join(repo, 'config.v1'));
      const copies: Array<[string, string]> = [
        ['src/index.ts', 'src/index copy.ts'],
        ['src/index.ts', 'src/index copy 2.ts'],
        ['config.v1', 'config.v1 copy'],
        ['docs/guide/intro.md', 'docs/guide/intro copy.md'],
      ];
      for (const [source, expected] of copies) {
        const response = await mutate({
          ...scope,
          operation: 'copy',
          source: ref(source),
          target: ref(source),
          conflict: 'increment',
        });
        expect(response.target).toEqual(ref(expected));
      }
      const fresh = await mutate({
        ...scope,
        operation: 'copy',
        source: ref('src/index.ts'),
        target: ref('fresh.ts'),
        conflict: 'increment',
      });
      expect(fresh.target).toEqual(ref('fresh.ts'));
      expect(
        await fs.readFile(join(repo, 'src', 'index copy 2.ts'), 'utf8'),
      ).toBe('export {};\n');
    });

    it('refuses an occupied target without increment', async () => {
      await expect(
        failure({
          ...scope,
          operation: 'copy',
          source: ref('src/index.ts'),
          target: ref('docs/guide/intro.md'),
          conflict: 'error',
        }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: A file or folder already exists at docs/guide/intro.md.',
        code: 'invalid_target',
      });
      expect(await fs.readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
        '# Intro\n',
      );
    });

    it('cleans up staging when the staged copy fails', async () => {
      injectFault('cp', join(repo, 'docs'), failWith('EIO'));
      await expect(
        failure({
          ...scope,
          operation: 'copy',
          source: ref('docs'),
          target: ref('docs-copy'),
          conflict: 'error',
        }),
      ).resolves.toMatchObject({ code: 'EIO' });
      expect((await fs.readdir(repo)).sort()).toEqual(['docs', 'src']);
    });

    it('cleans up staging when publishing the copy fails', async () => {
      const target = join(repo, 'published.ts');
      injectTargetFault('link', target, failWith('EIO'));
      await expect(
        failure({
          ...scope,
          operation: 'copy',
          source: ref('src/index.ts'),
          target: ref('published.ts'),
          conflict: 'error',
        }),
      ).resolves.toMatchObject({ code: 'EIO' });
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stagingLeftovers(repo)).resolves.toEqual([]);
    });

    it('treats a hard-link EPERM while publishing as a fallback, not a conflict', async () => {
      const target = join(repo, 'published.ts');
      injectTargetFault('link', target, failWith('EPERM'));
      await mutate({
        ...scope,
        operation: 'copy',
        source: ref('src/index.ts'),
        target: ref('published.ts'),
        conflict: 'error',
      });
      expect(await fs.readFile(target, 'utf8')).toBe('export {};\n');
      await expect(stagingLeftovers(repo)).resolves.toEqual([]);
    });

    it('keeps a target created while the copy was staged', async () => {
      const target = join(repo, 'published.ts');
      injectTargetFault('link', target, () =>
        fs.writeFile(target, 'concurrent\n', { flag: 'wx' }),
      );
      await expect(
        failure({
          ...scope,
          operation: 'copy',
          source: ref('src/index.ts'),
          target: ref('published.ts'),
          conflict: 'error',
        }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: A file or folder already exists at published.ts.',
        code: 'invalid_target',
      });
      expect(await fs.readFile(target, 'utf8')).toBe('concurrent\n');
      await expect(stagingLeftovers(repo)).resolves.toEqual([]);
    });

    itPosix(
      'copies a symlink to a file as an independent regular file',
      async () => {
        await fs.symlink('index.ts', join(repo, 'src', 'alias.ts'));
        await mutate({
          ...scope,
          operation: 'copy',
          source: ref('src/alias.ts'),
          target: ref('copied.ts'),
          conflict: 'error',
        });
        const copy = await fs.lstat(join(repo, 'copied.ts'));
        expect(copy.isFile()).toBe(true);
        expect(copy.isSymbolicLink()).toBe(false);
        expect(await fs.readFile(join(repo, 'copied.ts'), 'utf8')).toBe(
          'export {};\n',
        );
        expect((await fs.lstat(join(repo, 'src', 'index.ts'))).nlink).toBe(1);
      },
    );

    itPosix(
      'fails to copy a symlink to a directory and leaves no target',
      async () => {
        await fs.symlink('docs', join(repo, 'docs-alias'));
        const result = await failure({
          ...scope,
          operation: 'copy',
          source: ref('docs-alias'),
          target: ref('docs-copy'),
          conflict: 'error',
        });
        // The staged folder is published as a file: link(2) refuses it, then
        // copyfile fails with the platform's code.
        expect(result.code).toBe(
          process.platform === 'darwin' ? 'ENOTSUP' : 'EISDIR',
        );
        await expect(fs.lstat(join(repo, 'docs-copy'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(stagingLeftovers(repo)).resolves.toEqual([]);
      },
    );

    itPosix(
      'keeps relative symlinks verbatim inside a copied folder',
      async () => {
        await fs.symlink('intro.md', join(repo, 'docs', 'guide', 'link.md'));
        await mutate({
          ...scope,
          operation: 'copy',
          source: ref('docs'),
          target: ref('docs-copy'),
          conflict: 'error',
        });
        expect(await tree(join(repo, 'docs-copy'))).toEqual({
          'guide/': 'dir',
          'guide/intro.md': '# Intro\n',
          'guide/link.md': '-> intro.md',
        });
      },
    );
  });

  describe('delete', () => {
    it('removes files and nested folders permanently without Trash', async () => {
      await mutate({
        ...scope,
        operation: 'delete',
        target: ref('src/index.ts'),
      });
      await mutate({
        ...scope,
        operation: 'delete',
        target: ref('docs'),
        useTrash: false,
      });
      expect(await tree(repo)).toEqual({ 'src/': 'dir' });
      expect(mockTrashItem).not.toHaveBeenCalled();
    });

    it('sends a Trash delete to the shell with the lexical path and removes nothing', async () => {
      await expect(
        mutate({
          ...scope,
          operation: 'delete',
          target: ref('docs/guide'),
          useTrash: true,
        }),
      ).resolves.toEqual({ operation: 'delete', target: ref('docs/guide') });
      expect(mockTrashItem.mock.calls).toEqual([[join(repo, 'docs', 'guide')]]);
      expect(await fs.readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
        '# Intro\n',
      );
    });

    it('propagates a Trash failure without removing the entry', async () => {
      mockTrashItem.mockRejectedValue(new Error('Trash is unavailable'));
      await expect(
        failure({
          ...scope,
          operation: 'delete',
          target: ref('src/index.ts'),
          useTrash: true,
        }),
      ).resolves.toEqual({
        rendered: 'Error: Trash is unavailable',
        code: undefined,
      });
      expect(await fs.readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
        'export {};\n',
      );
    });

    it('fails a missing target with ENOENT', async () => {
      await expect(
        failure({ ...scope, operation: 'delete', target: ref('gone.txt') }),
      ).resolves.toMatchObject({ code: 'ENOENT' });
    });

    itPosix('removes an in-root symlink, not its target', async () => {
      await fs.symlink('docs', join(repo, 'docs-alias'));
      await mutate({
        ...scope,
        operation: 'delete',
        target: ref('docs-alias'),
      });
      await expect(fs.lstat(join(repo, 'docs-alias'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await fs.readFile(join(repo, 'docs/guide/intro.md'), 'utf8')).toBe(
        '# Intro\n',
      );
    });

    itPosix(
      'refuses a symlink that points outside the root, even to Trash',
      async () => {
        await put(join(tempRoot, 'outside', 'secret.txt'), 'secret\n');
        await fs.symlink(join(tempRoot, 'outside'), join(repo, 'escape'));
        for (const useTrash of [true, false]) {
          await expect(
            failure({
              ...scope,
              operation: 'delete',
              target: ref('escape'),
              useTrash,
            }),
          ).resolves.toEqual({
            rendered:
              'RemoteControlServiceError: File is outside the selected worktree root.',
            code: 'invalid_target',
          });
        }
        expect(mockTrashItem).not.toHaveBeenCalled();
        expect((await fs.lstat(join(repo, 'escape'))).isSymbolicLink()).toBe(
          true,
        );
        expect(
          await fs.readFile(join(tempRoot, 'outside', 'secret.txt'), 'utf8'),
        ).toBe('secret\n');
      },
    );

    itPosix(
      'fails a dangling symlink as missing for delete and move',
      async () => {
        await fs.symlink('missing', join(repo, 'dangling'));
        await expect(
          failure({ ...scope, operation: 'delete', target: ref('dangling') }),
        ).resolves.toMatchObject({ code: 'ENOENT' });
        await expect(
          failure({
            ...scope,
            operation: 'move',
            source: ref('dangling'),
            target: ref('moved'),
            conflict: 'error',
          }),
        ).resolves.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readlink(join(repo, 'dangling'))).toBe('missing');
      },
    );
  });

  describe('symlink moves', () => {
    itPosix('moves file and directory symlinks as links', async () => {
      await fs.symlink('src/index.ts', join(repo, 'file-link'));
      await fs.symlink('docs', join(repo, 'dir-link'));
      await mutate({
        ...scope,
        operation: 'move',
        source: ref('file-link'),
        target: ref('src/file-link'),
        conflict: 'error',
      });
      await mutate({
        ...scope,
        operation: 'move',
        source: ref('dir-link'),
        target: ref('renamed-dir-link'),
        conflict: 'error',
      });
      const snapshot = await tree(repo);
      expect(snapshot).toMatchObject({
        'renamed-dir-link': '-> docs',
        'src/file-link': '-> src/index.ts',
      });
      expect(snapshot).not.toHaveProperty('file-link');
      expect(snapshot).not.toHaveProperty('dir-link');
      expect((await fs.lstat(join(repo, 'src', 'index.ts'))).nlink).toBe(1);
    });

    itPosix(
      'rolls a symlink move back when the source link cannot be removed',
      async () => {
        const source = join(repo, 'file-link');
        await fs.symlink('src/index.ts', source);
        injectFault('unlink', source, failWith('EPERM'));
        await expect(
          failure({
            ...scope,
            operation: 'move',
            source: ref('file-link'),
            target: ref('moved-link'),
            conflict: 'error',
          }),
        ).resolves.toMatchObject({ code: 'EPERM' });
        expect(await fs.readlink(source)).toBe('src/index.ts');
        await expect(fs.lstat(join(repo, 'moved-link'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );
  });

  describe('cross-root transfers', () => {
    it('moves and copies plain entries into the attachments root', async () => {
      await expect(
        mutate({
          ...scope,
          operation: 'move',
          source: ref('src/index.ts'),
          target: ref('index.ts', 'attachments'),
          conflict: 'error',
        }),
      ).resolves.toEqual({
        operation: 'move',
        source: ref('src/index.ts'),
        target: ref('index.ts', 'attachments'),
      });
      await mutate({
        ...scope,
        operation: 'copy',
        source: ref('docs'),
        target: ref('docs', 'attachments'),
        conflict: 'error',
      });
      expect(await tree(attachments)).toEqual({
        'docs/': 'dir',
        'docs/guide/': 'dir',
        'docs/guide/intro.md': '# Intro\n',
        'index.ts': 'export {};\n',
        'note.txt': 'note\n',
      });
      expect(await tree(join(repo, 'src'))).toEqual({});
    });

    itPosix('refuses a transfer of, or containing, a symlink', async () => {
      await fs.symlink('intro.md', join(repo, 'docs', 'guide', 'link.md'));
      for (const operation of ['move', 'copy']) {
        for (const source of ['docs', 'docs/guide/link.md']) {
          await expect(
            failure({
              ...scope,
              operation,
              source: ref(source),
              target: ref('incoming', 'attachments'),
              conflict: 'error',
            }),
          ).resolves.toEqual({
            rendered:
              'RemoteControlServiceError: Cross-root transfers cannot contain symlinks.',
            code: 'invalid_target',
          });
        }
      }
      expect(await tree(attachments)).toEqual({ 'note.txt': 'note\n' });
      expect(await fs.readlink(join(repo, 'docs', 'guide', 'link.md'))).toBe(
        'intro.md',
      );
    });
  });

  describe('scope and path refusals', () => {
    it('refuses every operation in the read-only shared-container viewer', async () => {
      for (const operation of ['create-file', 'copy', 'move', 'delete']) {
        await expect(
          failure({
            projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: 'wt-1',
            operation,
            source: ref('src/index.ts'),
            target: ref('x.ts'),
          }),
        ).resolves.toEqual({
          rendered:
            'Error: Shared-container recipient workspaces are read-only',
          code: undefined,
        });
      }
      expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    });

    it('refuses a read-only or split-locked create before its repoId', async () => {
      const target = { repoId: 'Bad Id', relativePath: 'new.txt' };
      for (const operation of ['create-file', 'create-directory']) {
        await expect(
          failure({
            projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: 'wt-1',
            operation,
            target,
          }),
        ).resolves.toEqual({
          rendered:
            'Error: Shared-container recipient workspaces are read-only',
          code: undefined,
        });
        await acquireSplitLock('project-1', 'wt-1');
        try {
          await expect(
            failure({ ...scope, operation, target }),
          ).resolves.toEqual({
            rendered:
              'SplitLockError: This worktree is locked while a Split PR is in progress; updating files is unavailable until it finishes.',
            code: undefined,
          });
        } finally {
          releaseSplitLock('project-1', 'wt-1');
        }
        await expect(failure({ ...scope, operation, target })).resolves.toEqual(
          {
            rendered:
              'IdentifierValidationError: Invalid fileRootLocalId: must be lowercase alphanumeric with hyphens',
            code: undefined,
          },
        );
      }
      expect(await fs.readdir(repo)).not.toContain('new.txt');
    });

    it('refuses a split-locked worktree before touching files', async () => {
      await acquireSplitLock('project-1', 'wt-1');
      try {
        await expect(
          failure({ ...scope, operation: 'delete', target: ref('src') }),
        ).resolves.toEqual({
          rendered:
            'SplitLockError: This worktree is locked while a Split PR is in progress; updating files is unavailable until it finishes.',
          code: undefined,
        });
      } finally {
        releaseSplitLock('project-1', 'wt-1');
      }
      expect(await fs.readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
        'export {};\n',
      );
    });

    it('refuses an unresolvable managed target, bad ids and unknown operations', async () => {
      mockedResolveWorktreeTargetIds.mockReturnValueOnce(null);
      await expect(
        failure({ ...scope, operation: 'delete', target: ref('src') }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: Managed file-tree target could not be resolved.',
        code: 'invalid_target',
      });
      await expect(
        failure({
          projectId: 'Bad Id',
          worktreeId: 'wt-1',
          operation: 'delete',
          target: ref('src'),
        }),
      ).resolves.toEqual({
        rendered:
          'IdentifierValidationError: Invalid projectId: must be lowercase alphanumeric with hyphens',
        code: undefined,
      });
      await expect(
        failure({
          ...scope,
          operation: 'archive',
          source: ref('src'),
          target: ref('x'),
        }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: Unsupported file-tree mutation operation.',
        code: 'invalid_payload',
      });
      await expect(
        failure({ ...scope, operation: 'move', target: ref('x') }),
      ).resolves.toEqual({
        rendered: 'RemoteControlServiceError: Mutation source is missing.',
        code: 'invalid_payload',
      });
      expect(await fs.readdir(join(repo, 'src'))).toEqual(['index.ts']);
    });

    it('refuses an ambiguous or unknown root', async () => {
      await expect(
        failure({
          ...scope,
          operation: 'delete',
          target: { relativePath: 'src' },
        }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: File root is ambiguous; provide fileRootLocalId or repoId.',
        code: 'invalid_target',
      });
      await expect(
        failure({ ...scope, operation: 'delete', target: ref('src', 'nope') }),
      ).resolves.toEqual({
        rendered: 'RemoteControlServiceError: Unknown file root: nope',
        code: 'not_found',
      });
    });

    it('refuses absolute, traversing and root paths', async () => {
      const cases: Array<[string, string]> = [
        ['/etc/hosts', 'Path must be relative.'],
        ['C:/Windows', 'Path must be relative.'],
        ['../outside.txt', 'Path cannot traverse outside the worktree.'],
        ['src/../../outside.txt', 'Path cannot traverse outside the worktree.'],
        ['', 'Delete target cannot be a file-tree root.'],
        ['.', 'Delete target cannot be a file-tree root.'],
      ];
      for (const [relativePath, message] of cases) {
        await expect(
          failure({ ...scope, operation: 'delete', target: ref(relativePath) }),
        ).resolves.toEqual({
          rendered: `RemoteControlServiceError: ${message}`,
          code: 'invalid_target',
        });
      }
      await expect(
        failure({
          ...scope,
          operation: 'move',
          source: ref(''),
          target: ref('x'),
        }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: Source cannot be a file-tree root.',
        code: 'invalid_target',
      });
      await expect(
        failure({
          ...scope,
          operation: 'copy',
          source: ref('src'),
          target: ref('../x'),
        }),
      ).resolves.toMatchObject({
        rendered:
          'RemoteControlServiceError: Path cannot traverse outside the worktree.',
      });
      expect(await tree(repo)).toEqual({
        'docs/': 'dir',
        'docs/guide/': 'dir',
        'docs/guide/intro.md': '# Intro\n',
        'src/': 'dir',
        'src/index.ts': 'export {};\n',
      });
    });

    itPosix(
      'refuses a backslash path instead of acting on the slash path',
      async () => {
        await put(join(repo, 'a\\b'), 'literal\n');
        await put(join(repo, 'a', 'b'), 'nested\n');
        const requests: Array<[Record<string, unknown>, string]> = [
          [
            { operation: 'delete', target: ref('a\\b'), useTrash: true },
            'Delete target',
          ],
          [
            { operation: 'create-file', target: ref('new\\x.txt') },
            'Create target',
          ],
          [
            { operation: 'move', source: ref('a\\b'), target: ref('moved') },
            'Source',
          ],
          [
            {
              operation: 'copy',
              source: ref('src/index.ts'),
              target: ref('a\\c'),
            },
            'Target',
          ],
        ];
        for (const [request, label] of requests) {
          await expect(failure({ ...scope, ...request })).resolves.toEqual({
            rendered: `RemoteControlServiceError: ${label} cannot contain a backslash.`,
            code: 'invalid_target',
          });
        }
        expect(mockTrashItem).not.toHaveBeenCalled();
        expect(await fs.readFile(join(repo, 'a\\b'), 'utf8')).toBe('literal\n');
        expect(await fs.readdir(join(repo, 'a'))).toEqual(['b']);
      },
    );

    // Added after the cutover (CAN-4100 review), from the deleted service's
    // `requireMutableRelativePath`: a create refuses a backslash anywhere and
    // a drive-like first segment, unlike the text save, and accepts a later one.
    itPosix(
      'refuses create names with a backslash or a drive-like first segment',
      async () => {
        const refused: Array<[string, string]> = [
          ['new\\x.txt', 'Create target cannot contain a backslash.'],
          ['C:notes.md', 'Path must be relative.'],
          ['c:folder/inner.ts', 'Path must be relative.'],
        ];
        for (const operation of ['create-file', 'create-directory'])
          for (const [relativePath, message] of refused)
            await expect(
              failure({ ...scope, operation, target: ref(relativePath) }),
            ).resolves.toEqual({
              rendered: `RemoteControlServiceError: ${message}`,
              code: 'invalid_target',
            });
        expect(await fs.readdir(repo)).toEqual(['docs', 'src']);
        await expect(
          mutate({
            ...scope,
            operation: 'create-file',
            target: ref('src/C:notes.md'),
          }),
        ).resolves.toEqual({
          operation: 'create-file',
          target: ref('src/C:notes.md'),
        });
        await expect(
          mutate({
            ...scope,
            operation: 'create-directory',
            target: ref('src/D:folder'),
          }),
        ).resolves.toEqual({
          operation: 'create-directory',
          target: ref('src/D:folder'),
        });
        expect(await tree(join(repo, 'src'))).toEqual({
          'C:notes.md': '',
          'D:folder/': 'dir',
          'index.ts': 'export {};\n',
        });
      },
    );
  });
});

describe('multi-repository worktree', () => {
  const multiScope = { projectId: 'workspace-1', worktreeId: 'wt-1' };
  let workspace = '';
  let child = '';

  beforeEach(async () => {
    workspace = join(tempRoot, 'workspace');
    const repos = join(workspace, 'repos');
    child = join(repos, 'app');
    const attachments = join(tempRoot, 'workspace-attachments');
    await put(join(workspace, 'workspace.txt'), 'workspace\n');
    await put(join(child, 'child.txt'), 'child\n');
    await put(join(attachments, 'note.txt'), 'note\n');
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/source/app' }],
    });
    jest.mocked(getWorkspaceWorktreeRootRepoDir).mockReturnValue(workspace);
    jest.mocked(getWorkspaceWorktreeReposDir).mockReturnValue(repos);
    jest.mocked(getWorkspaceWorktreeRepoDir).mockReturnValue(child);
    jest
      .mocked(getWorkspaceWorktreeAttachmentsDir)
      .mockReturnValue(attachments);
  });

  it('refuses reaching a child checkout through the workspace root', async () => {
    const parent = (relativePath: string): ReturnType<typeof ref> =>
      ref(relativePath, WORKSPACE_ROOT_REPO_ID);
    const refused = {
      rendered:
        'RemoteControlServiceError: Path belongs to another file-tree root; use that root instead.',
      code: 'invalid_target',
    };
    for (const relativePath of ['repos', 'repos/app', 'repos/app/child.txt']) {
      for (const useTrash of [true, false]) {
        await expect(
          failure({
            ...multiScope,
            operation: 'delete',
            target: parent(relativePath),
            useTrash,
          }),
        ).resolves.toEqual(refused);
      }
    }
    for (const operation of ['move', 'copy']) {
      await expect(
        failure({
          ...multiScope,
          operation,
          source: parent('repos/app/child.txt'),
          target: parent('out.txt'),
          conflict: 'error',
        }),
      ).resolves.toEqual(refused);
      await expect(
        failure({
          ...multiScope,
          operation,
          source: parent('workspace.txt'),
          target: parent('repos/app/in.txt'),
          conflict: 'error',
        }),
      ).resolves.toEqual(refused);
    }
    expect(mockTrashItem).not.toHaveBeenCalled();
    expect(await tree(workspace)).toEqual({
      'repos/': 'dir',
      'repos/app/': 'dir',
      'repos/app/child.txt': 'child\n',
      'workspace.txt': 'workspace\n',
    });
  });

  // Deliberate difference (CAN-4100, Q5): a create refuses another root
  // reached through the workspace root, as delete, copy and move do.
  it('refuses creating inside a child checkout through the workspace root', async () => {
    const parent = (relativePath: string): ReturnType<typeof ref> =>
      ref(relativePath, WORKSPACE_ROOT_REPO_ID);
    for (const [operation, relativePath] of [
      ['create-file', 'repos/app/new.txt'],
      ['create-directory', 'repos/app/new-dir'],
      ['create-directory', 'repos/other'],
      ['create-file', 'repos/fresh/new.txt'],
    ]) {
      await expect(
        failure({ ...multiScope, operation, target: parent(relativePath) }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: Path belongs to another file-tree root; use that root instead.',
        code: 'invalid_target',
      });
    }
    await mutate({
      ...multiScope,
      operation: 'create-file',
      target: ref('new.txt', 'app'),
    });
    expect(await tree(workspace)).toEqual({
      'repos/': 'dir',
      'repos/app/': 'dir',
      'repos/app/child.txt': 'child\n',
      'repos/app/new.txt': '',
      'workspace.txt': 'workspace\n',
    });
  });

  // Added after the cutover (CAN-4100 review): a parent made meanwhile still
  // passes the other-root check.
  itPosix(
    'refuses a missing parent that appears as a link into a child checkout',
    async () => {
      injectFault('mkdir', join(workspace, 'fresh'), () =>
        fs.symlink(child, join(workspace, 'fresh')),
      );
      await expect(
        failure({
          ...multiScope,
          operation: 'create-file',
          target: ref('fresh/new.txt', WORKSPACE_ROOT_REPO_ID),
        }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: Path belongs to another file-tree root; use that root instead.',
        code: 'invalid_target',
      });
      expect(await tree(child)).toEqual({ 'child.txt': 'child\n' });
    },
  );

  it('mutates a child checkout through its own root', async () => {
    await mutate({
      ...multiScope,
      operation: 'move',
      source: ref('workspace.txt', WORKSPACE_ROOT_REPO_ID),
      target: ref('moved.txt', 'app'),
      conflict: 'error',
    });
    await mutate({
      ...multiScope,
      operation: 'delete',
      target: ref('child.txt', 'app'),
      useTrash: true,
    });
    expect(mockTrashItem.mock.calls).toEqual([[join(child, 'child.txt')]]);
    expect(await tree(workspace)).toEqual({
      'repos/': 'dir',
      'repos/app/': 'dir',
      'repos/app/child.txt': 'child\n',
      'repos/app/moved.txt': 'workspace\n',
    });
  });
});

describe('Cowork project', () => {
  const coworkScope = { projectId: 'cowork-1', worktreeId: 'wt-1' };
  let home = '';
  let managed = '';

  beforeEach(async () => {
    home = join(tempRoot, 'cowork-home');
    managed = join(home, '.canopy');
    const catalog = buildCoworkRootCatalog({
      workspace: {
        id: COWORK_WORKSPACE_FILE_ROOT_ID,
        name: 'Cowork',
        absolutePath: home,
      },
      notesPath: join(managed, 'notes'),
      promptsPath: join(managed, 'prompts'),
      attachments: {
        absolutePath: join(managed, 'attachments'),
        visible: true,
      },
    });
    const roots = catalog.roots.map((root) => ({
      repoId: root.id,
      repoName: root.name,
      absolutePath: root.absolutePath,
      rootKind: root.kind,
      gitAware: root.gitAware,
      excludedDescendantRoots: root.excludedDescendantRoots,
    }));
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots,
      rootMap: new Map(roots.map((root) => [root.repoId, root])),
    });
    for (const managedDir of ['notes', 'prompts', 'attachments']) {
      await put(join(managed, managedDir, 'kept.md'), 'kept\n');
    }
    await put(join(home, 'draft.md'), 'draft\n');
  });

  it('refuses managed folders through the project folder root', async () => {
    const workspaceRef = (relativePath: string): ReturnType<typeof ref> =>
      ref(relativePath, COWORK_WORKSPACE_FILE_ROOT_ID);
    const belongs =
      'RemoteControlServiceError: Path belongs to another file-tree root; use that root instead.';
    for (const managedDir of ['notes', 'prompts', 'attachments']) {
      await expect(
        failure({
          ...coworkScope,
          operation: 'delete',
          target: workspaceRef(`.canopy/${managedDir}`),
          useTrash: true,
        }),
      ).resolves.toMatchObject({ rendered: belongs });
      await expect(
        failure({
          ...coworkScope,
          operation: 'move',
          source: workspaceRef(`.canopy/${managedDir}/kept.md`),
          target: workspaceRef(`${managedDir}.md`),
          conflict: 'error',
        }),
      ).resolves.toMatchObject({ rendered: belongs });
      await expect(
        failure({
          ...coworkScope,
          operation: 'copy',
          source: workspaceRef('draft.md'),
          target: workspaceRef(`.canopy/${managedDir}/draft.md`),
          conflict: 'error',
        }),
      ).resolves.toMatchObject({ rendered: belongs });
    }
    for (const operation of ['delete', 'move']) {
      await expect(
        failure({
          ...coworkScope,
          operation,
          source: workspaceRef('.canopy'),
          target: workspaceRef(operation === 'delete' ? '.canopy' : 'moved'),
          conflict: 'error',
          useTrash: true,
        }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: Path contains another file-tree root.',
        code: 'invalid_target',
      });
    }
    expect(mockTrashItem).not.toHaveBeenCalled();
    expect(await tree(home)).toEqual({
      '.canopy/': 'dir',
      '.canopy/attachments/': 'dir',
      '.canopy/attachments/kept.md': 'kept\n',
      '.canopy/notes/': 'dir',
      '.canopy/notes/kept.md': 'kept\n',
      '.canopy/prompts/': 'dir',
      '.canopy/prompts/kept.md': 'kept\n',
      'draft.md': 'draft\n',
    });
  });

  // Deliberate difference (CAN-4100, Q5): a create refuses a managed folder
  // reached through the project folder root, as delete, copy and move do.
  it('refuses creating inside managed folders through the project folder root', async () => {
    for (const [operation, relativePath] of [
      ['create-file', '.canopy/notes/new.md'],
      ['create-file', '.canopy/prompts/new.md'],
      ['create-file', '.canopy/attachments/new.md'],
      ['create-directory', '.canopy/notes/folder'],
    ]) {
      await expect(
        failure({
          ...coworkScope,
          operation,
          target: ref(relativePath, COWORK_WORKSPACE_FILE_ROOT_ID),
        }),
      ).resolves.toEqual({
        rendered:
          'RemoteControlServiceError: Path belongs to another file-tree root; use that root instead.',
        code: 'invalid_target',
      });
    }
    expect(await tree(managed)).toEqual({
      'attachments/': 'dir',
      'attachments/kept.md': 'kept\n',
      'notes/': 'dir',
      'notes/kept.md': 'kept\n',
      'prompts/': 'dir',
      'prompts/kept.md': 'kept\n',
    });
  });

  it("creates through each managed folder's own root", async () => {
    await mutate({
      ...coworkScope,
      operation: 'create-file',
      target: ref('fresh.md', 'notes'),
    });
    await mutate({
      ...coworkScope,
      operation: 'create-directory',
      target: ref('nested/deeper', 'prompts'),
    });
    expect(await fs.readFile(join(managed, 'notes', 'fresh.md'), 'utf8')).toBe(
      '',
    );
    expect(
      (
        await fs.stat(join(managed, 'prompts', 'nested', 'deeper'))
      ).isDirectory(),
    ).toBe(true);
  });

  it('mutates managed folders through their own roots', async () => {
    await mutate({
      ...coworkScope,
      operation: 'copy',
      source: ref('draft.md', COWORK_WORKSPACE_FILE_ROOT_ID),
      target: ref('draft.md', 'notes'),
      conflict: 'error',
    });
    await mutate({
      ...coworkScope,
      operation: 'delete',
      target: ref('kept.md', 'prompts'),
      useTrash: true,
    });
    await mutate({
      ...coworkScope,
      operation: 'delete',
      target: ref('kept.md', 'attachments'),
    });
    expect(mockTrashItem.mock.calls).toEqual([
      [join(managed, 'prompts', 'kept.md')],
    ]);
    expect(await tree(managed)).toEqual({
      'attachments/': 'dir',
      'notes/': 'dir',
      'notes/draft.md': 'draft\n',
      'notes/kept.md': 'kept\n',
      'prompts/': 'dir',
      'prompts/kept.md': 'kept\n',
    });
  });
});
