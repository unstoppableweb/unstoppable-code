/**
 * CAN-4100 golden: the text branch of `file:save-content` pinned at the IPC
 * boundary on real temporary filesystems. Captured on the handler that wrote
 * the caller's path directly, before text saves became a projection over
 * `worker.filesystem.file.write`. Only `registerHandlers` follows the
 * handler's registration; activity touches are observed through
 * `touchWorkspaceTarget`, and Auto Delete through the real exclusion leases.
 * Two cases are deliberate differences (CAN-4100, marked): an untracked
 * sender and a Split PR lock now refuse the save.
 */
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { buildCoworkRootCatalog } from '@canopy/core-runtime/node';
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_WORKSPACE_FILE_ROOT_ID,
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type SaveFileContentResponse,
} from '@canopy/desktop-shared/types';
import type * as FileBrowserRootsModule from '../../lib/file-browser-roots';
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

jest.mock('electron', () => ({
  nativeImage: { createThumbnailFromPath: jest.fn() },
  shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
}));

jest.mock('../../lib/workspace-activity', () => ({
  touchWorkspaceTarget: jest.fn(() => Promise.resolve()),
}));
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
  getWorkspaceIndexFilePath: jest.fn(),
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
  getWorkspaceType: jest.fn(() => null),
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
import { touchWorkspaceTarget } from '../../lib/workspace-activity';
import { readWorkspaceConfig } from '../../lib/workspace-persistence';
import {
  getWorkspaceType,
  isMultiRepoWorkspace,
} from '../../lib/workspace-registry';
import {
  withWorkspaceTargetArchiveDrain,
  withWorkspaceTargetAutoArchiveLease,
} from '../../lib/workspace-target-exclusion';
import {
  acquireSplitLock,
  releaseSplitLock,
} from '../../services/split-lock-service';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { deriveDesktopIpcCaller } from '../../canopy-runtime/desktop-ipc-caller';
import { registerFilePreviewHandlers } from '../file-preview';

const fs = jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedResolveWorktreeTargetIds = jest.mocked(resolveWorktreeTargetIds);
const mockedTouch = jest.mocked(touchWorkspaceTarget);

const isPosixHost = process.platform !== 'win32';
const itPosix = isPosixHost ? it : it.skip;
const APP_URL = 'file:///app/renderer/index.html';
const BRIDGE_SENDER_ID = 912;
const FIVE_MIB = 5 * 1024 * 1024;

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

const windowEvent = createEvent(911);
const bridgeEvent = createEvent(BRIDGE_SENDER_ID);
const appWindow: DesktopAppWindow = {
  isDestroyed: () => false,
  webContents: windowEvent.sender,
};

let runtime: DesktopCanopyDispatcher | undefined;

/** The only part of this file that follows the handler's registration. */
function registerHandlers(): void {
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  registerFilePreviewHandlers(
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

function isSaveResponse(value: unknown): value is SaveFileContentResponse {
  return typeof value === 'object' && value !== null && 'filename' in value;
}

async function save(
  request: Record<string, unknown>,
  event: DesktopIpcEvent = windowEvent,
): Promise<SaveFileContentResponse> {
  const handler = handlers.get(IPC_CHANNELS.fileSaveContent);
  if (!handler) throw new Error('file:save-content is not registered.');
  const response = await handler(event, request);
  if (!isSaveResponse(response)) {
    throw new Error('Expected a file save response.');
  }
  return response;
}

/** What the renderer sees: `${name}: ${message}`, plus a Node error code. */
async function failure(
  request: Record<string, unknown>,
  event: DesktopIpcEvent = windowEvent,
): Promise<{ rendered: string; code: unknown }> {
  try {
    await save(request, event);
  } catch (error) {
    return {
      rendered: String(error),
      code:
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined,
    };
  }
  throw new Error('Expected the save to fail.');
}

async function put(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
}

async function read(path: string): Promise<string> {
  return fs.readFile(path, 'utf8');
}

const OLD_TIME = new Date('2020-01-02T03:04:05.000Z');

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'file-save-content-golden-')),
  );
  handlers.clear();
  mockedTouch.mockClear();
  const actualRoots = jest.requireActual<typeof FileBrowserRootsModule>(
    '../../lib/file-browser-roots',
  );
  mockedGetFileBrowserRoots.mockReset();
  mockedGetFileBrowserRoots.mockImplementation(actualRoots.getFileBrowserRoots);
  mockedResolveWorktreeTargetIds.mockReset();
  mockedResolveWorktreeTargetIds.mockImplementation(
    (projectId, worktreeId) => ({ projectId, worktreeId }),
  );
  jest.mocked(getWorkspaceType).mockReturnValue(null);
  jest.mocked(isMultiRepoWorkspace).mockReturnValue(false);
  registerHandlers();
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const scope = { projectId: 'project-1', worktreeId: 'wt-1' };

describe('single-repository worktree', () => {
  let repo = '';
  let attachments = '';
  let file = '';

  beforeEach(async () => {
    repo = join(tempRoot, 'repo');
    attachments = join(tempRoot, 'attachments');
    file = join(repo, 'src', 'index.ts');
    await put(file, 'export {};\n');
    await fs.utimes(file, OLD_TIME, OLD_TIME);
    await put(join(attachments, 'note.txt'), 'note\n');
    mockedResolveWorktreeCwd.mockReturnValue(repo);
    jest.mocked(getWorktreeAttachmentsDir).mockReturnValue(attachments);
  });

  describe.each([
    ['an app window', windowEvent],
    ['the remote-control bridge', bridgeEvent],
  ])('from %s', (_label, event) => {
    it('saves in place and answers the saved stat', async () => {
      const response = await save(
        { ...scope, absolutePath: file, content: 'export const a = 1;\n' },
        event,
      );
      const saved = await fs.stat(file);
      expect(response).toEqual({
        filename: 'index.ts',
        sizeBytes: 20,
        modifiedAtMs: saved.mtimeMs,
      });
      expect(await read(file)).toBe('export const a = 1;\n');
      expect(mockedTouch.mock.calls).toEqual([['project-1', 'wt-1']]);
    });
  });

  itPosix('keeps the inode, hard links and permissions', async () => {
    const link = join(repo, 'src', 'hard-link.ts');
    await fs.link(file, link);
    await fs.chmod(file, 0o640);
    const before = await fs.stat(file);
    await save({ ...scope, absolutePath: file, content: 'changed\n' });
    const after = await fs.stat(file);
    expect({
      ino: after.ino,
      nlink: after.nlink,
      mode: after.mode & 0o777,
    }).toEqual({ ino: before.ino, nlink: 2, mode: 0o640 });
    expect(await read(link)).toBe('changed\n');
  });

  it('takes the text branch for explicit default options', async () => {
    await save({
      ...scope,
      absolutePath: file,
      content: 'explicit\n',
      encoding: 'utf8',
      createOnly: false,
    });
    expect(await read(file)).toBe('explicit\n');
  });

  it('saves empty content and shrinks a longer file', async () => {
    await save({ ...scope, absolutePath: file, content: '' });
    expect(await read(file)).toBe('');
    await fs.writeFile(file, 'a much longer original body\n');
    await save({ ...scope, absolutePath: file, content: 'short\n' });
    expect(await read(file)).toBe('short\n');
  });

  describe('expectedModifiedAtMs', () => {
    it('accepts a stamp within 1 ms of the current mtime', async () => {
      const { mtimeMs } = await fs.stat(file);
      for (const [delta, content] of [
        [0, 'zero\n'],
        [1, 'one\n'],
      ] as const) {
        const before = await fs.stat(file);
        await save({
          ...scope,
          absolutePath: file,
          content,
          expectedModifiedAtMs: before.mtimeMs - delta,
        });
        expect(await read(file)).toBe(content);
        await fs.utimes(file, OLD_TIME, OLD_TIME);
      }
      expect(mtimeMs).toBe(OLD_TIME.getTime());
    });

    it('refuses a stale stamp with FileSaveConflictError and writes nothing', async () => {
      for (const delta of [2, -2, 1_000]) {
        await expect(
          failure({
            ...scope,
            absolutePath: file,
            content: 'stale\n',
            expectedModifiedAtMs: OLD_TIME.getTime() + delta,
          }),
        ).resolves.toEqual({
          rendered:
            'FileSaveConflictError: The document changed after you started editing.',
          code: undefined,
        });
      }
      expect(await read(file)).toBe('export {};\n');
      expect(mockedTouch).not.toHaveBeenCalled();
    });

    it('saves unconditionally without a stamp or with NaN', async () => {
      // A preview without `modifiedAt` sends `Date.parse(undefined)`.
      for (const stamp of [undefined, Number.NaN]) {
        await save({
          ...scope,
          absolutePath: file,
          content: `stamp ${String(stamp)}\n`,
          ...(stamp === undefined ? {} : { expectedModifiedAtMs: stamp }),
        });
        expect(await read(file)).toBe(`stamp ${String(stamp)}\n`);
      }
    });
  });

  describe('refusals before any write, in order', () => {
    it('refuses a target owned by Auto Delete before anything else', async () => {
      await withWorkspaceTargetAutoArchiveLease('project-1', 'wt-1', () =>
        expect(
          failure({
            ...scope,
            absolutePath: 'relative.txt',
            content: '\0'.repeat(2),
          }),
        ).resolves.toEqual({
          rendered:
            'Error: This workspace target is being automatically deleted. Retry after deletion finishes.',
          code: undefined,
        }),
      );
      expect(await read(file)).toBe('export {};\n');
    });

    it('finishes a save already holding its reservation when archiving starts', async () => {
      // The save roots are read inside the reservation; archiving waits.
      let archived: Promise<string> | undefined;
      jest.mocked(getWorktreeAttachmentsDir).mockImplementationOnce(() => {
        archived = withWorkspaceTargetArchiveDrain('project-1', 'wt-1', () =>
          read(file),
        );
        return attachments;
      });
      await save({ ...scope, absolutePath: file, content: 'before archive\n' });
      expect(await read(file)).toBe('before archive\n');
      await expect(archived).resolves.toBe('before archive\n');
    });

    it('refuses bad ids, read-only scopes and relative paths', async () => {
      await expect(
        failure({
          projectId: 'Bad Id',
          worktreeId: 'wt-1',
          absolutePath: file,
          content: 'x',
        }),
      ).resolves.toEqual({
        rendered:
          'IdentifierValidationError: Invalid projectId: must be lowercase alphanumeric with hyphens',
        code: undefined,
      });
      await expect(
        failure({
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'wt-1',
          absolutePath: file,
          content: 'x',
        }),
      ).resolves.toEqual({
        rendered: 'Error: Shared-container recipient workspaces are read-only',
        code: undefined,
      });
      const relative = await failure({
        ...scope,
        absolutePath: 'src/index.ts',
        content: 'x',
      });
      expect(relative.rendered).toContain('absolutePath');
      expect(await read(file)).toBe('export {};\n');
    });

    it('refuses bad options, non-text files, oversize and NUL content', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [
          { absolutePath: file, content: 'x', encoding: 'latin1' },
          'FileSaveValidationError: Invalid file save options.',
        ],
        [
          { absolutePath: file, content: 'x', createOnly: false, encoding: 1 },
          'FileSaveValidationError: Invalid file save options.',
        ],
        [
          { absolutePath: join(repo, 'logo.png'), content: 'x' },
          'Error: Only text-based files can be edited',
        ],
        [
          { absolutePath: join(repo, 'bundle.zip'), content: 'x' },
          'Error: Only text-based files can be edited',
        ],
        [
          { absolutePath: file, content: 'x'.repeat(FIVE_MIB + 1) },
          'Error: File content exceeds the 5 MB save limit',
        ],
        [
          { absolutePath: file, content: 'a\0b' },
          'Error: File content cannot contain null bytes',
        ],
      ];
      for (const [request, rendered] of cases) {
        await expect(failure({ ...scope, ...request })).resolves.toMatchObject({
          rendered,
        });
      }
      // Exactly 5 MiB of text is within the limit.
      await save({
        ...scope,
        absolutePath: file,
        content: 'y'.repeat(FIVE_MIB),
      });
      expect((await fs.stat(file)).size).toBe(FIVE_MIB);
      expect(mockedTouch).toHaveBeenCalledTimes(1);
    });

    it('refuses a missing file and paths outside the save roots', async () => {
      const missing = join(repo, 'src', 'missing.ts');
      await expect(
        failure({ ...scope, absolutePath: missing, content: 'x' }),
      ).resolves.toEqual({
        rendered: `Error: Cannot save non-existent file: ${missing}`,
        code: undefined,
      });
      const outside = join(tempRoot, 'outside.ts');
      await put(outside, 'outside\n');
      await expect(
        failure({ ...scope, absolutePath: outside, content: 'x' }),
      ).resolves.toEqual({
        rendered: 'Error: Cannot save file outside allowed worktree roots',
        code: undefined,
      });
      expect(await fs.readdir(join(repo, 'src'))).toEqual(['index.ts']);
      expect(await read(outside)).toBe('outside\n');
      expect(mockedTouch).not.toHaveBeenCalled();
    });

    it('fails a folder with EISDIR', async () => {
      await expect(
        failure({ ...scope, absolutePath: join(repo, 'src'), content: 'x' }),
      ).resolves.toMatchObject({ code: 'EISDIR' });
      expect(await fs.readdir(join(repo, 'src'))).toEqual(['index.ts']);
    });
  });

  describe('symlinks', () => {
    itPosix('refuses a link that leaves every save root', async () => {
      const outside = join(tempRoot, 'outside.ts');
      await put(outside, 'outside\n');
      await fs.symlink(outside, join(repo, 'out.ts'));
      await expect(
        failure({ ...scope, absolutePath: join(repo, 'out.ts'), content: 'x' }),
      ).resolves.toEqual({
        rendered: 'Error: Cannot save file outside allowed worktree roots',
        code: undefined,
      });
      expect(await read(outside)).toBe('outside\n');
    });

    itPosix('writes through an in-root link to its target', async () => {
      await fs.symlink('index.ts', join(repo, 'src', 'alias.ts'));
      const response = await save({
        ...scope,
        absolutePath: join(repo, 'src', 'alias.ts'),
        content: 'via alias\n',
      });
      expect(response.filename).toBe('alias.ts');
      expect(await read(file)).toBe('via alias\n');
      expect(await fs.readlink(join(repo, 'src', 'alias.ts'))).toBe('index.ts');
    });

    itPosix(
      'writes through a link across roots into the attachments file',
      async () => {
        await fs.symlink(
          join(attachments, 'note.txt'),
          join(repo, 'note-link.txt'),
        );
        await save({
          ...scope,
          absolutePath: join(repo, 'note-link.txt'),
          content: 'linked\n',
        });
        expect(await read(join(attachments, 'note.txt'))).toBe('linked\n');
        expect(
          (await fs.lstat(join(repo, 'note-link.txt'))).isSymbolicLink(),
        ).toBe(true);
      },
    );
  });

  it('saves into the attachments folder', async () => {
    await save({
      ...scope,
      absolutePath: join(attachments, 'note.txt'),
      content: 'attached\n',
    });
    expect(await read(join(attachments, 'note.txt'))).toBe('attached\n');
  });

  it('saves while the attachments root path cannot be read', async () => {
    // A file in the path: realpath fails with ENOTDIR, not ENOENT.
    jest
      .mocked(getWorktreeAttachmentsDir)
      .mockReturnValue(join(file, 'attachments'));
    await save({ ...scope, absolutePath: file, content: 'skipped\n' });
    expect(await read(file)).toBe('skipped\n');
  });

  it('saves a managed chat target that resolves to no worktree', async () => {
    // Plan, review and standalone chats can name a target that is gone.
    mockedResolveWorktreeTargetIds.mockReturnValue(null);
    await save({ ...scope, absolutePath: file, content: 'managed\n' });
    expect(await read(file)).toBe('managed\n');
  });

  // Added after the cutover (CAN-4100 review), from the deleted handler's
  // unrestricted `writeFile`: POSIX names that file.write's path check refuses.
  itPosix('saves a file whose name contains a backslash', async () => {
    const named = join(repo, 'src', 'back\\slash.ts');
    await put(named, 'before\n');
    await save({ ...scope, absolutePath: named, content: 'after\n' });
    expect(await read(named)).toBe('after\n');
    expect(await fs.readdir(join(repo, 'src'))).toEqual([
      'back\\slash.ts',
      'index.ts',
    ]);
    expect(mockedTouch.mock.calls).toEqual([['project-1', 'wt-1']]);
  });

  itPosix(
    'saves a file whose first path segment starts like a drive',
    async () => {
      for (const path of [
        join(repo, 'C:notes.md'),
        join(repo, 'c:folder', 'inner.ts'),
      ]) {
        await put(path, 'before\n');
        await save({ ...scope, absolutePath: path, content: 'after\n' });
        expect(await read(path)).toBe('after\n');
      }
      expect(mockedTouch).toHaveBeenCalledTimes(2);
    },
  );

  // Deliberate difference (CAN-4100, Q7): the save derives its caller from
  // the sender, so a sender that is no tracked window is refused.
  it('refuses a sender that is no tracked window', async () => {
    await expect(
      failure(
        { ...scope, absolutePath: file, content: 'untracked\n' },
        createEvent(999),
      ),
    ).resolves.toEqual({
      rendered: 'Error: Untrusted desktop IPC sender.',
      code: undefined,
    });
    expect(await read(file)).toBe('export {};\n');
    expect(mockedTouch).not.toHaveBeenCalled();
  });

  // Deliberate difference (CAN-4100): `worker.filesystem.file.write` refuses
  // a worktree locked by a Split PR, as the explorer's create does.
  it('refuses a worktree held by a Split PR lock', async () => {
    acquireSplitLock('project-1', 'wt-1');
    try {
      await expect(
        failure({ ...scope, absolutePath: file, content: 'locked\n' }),
      ).resolves.toEqual({
        rendered:
          'SplitLockError: This worktree is locked while a Split PR is in progress; updating files is unavailable until it finishes.',
        code: undefined,
      });
    } finally {
      releaseSplitLock('project-1', 'wt-1');
    }
    expect(await read(file)).toBe('export {};\n');
    expect(mockedTouch).not.toHaveBeenCalled();
  });
});

describe('multi-repository worktree', () => {
  const multiScope = { projectId: 'workspace-1', worktreeId: 'wt-1' };
  let workspace = '';
  let repos = '';
  let child = '';
  let attachments = '';

  beforeEach(async () => {
    workspace = join(tempRoot, 'workspace');
    repos = join(workspace, 'repos');
    child = join(repos, 'app');
    attachments = join(tempRoot, 'workspace-attachments');
    await put(join(workspace, 'workspace.txt'), 'workspace\n');
    await put(join(child, 'child.txt'), 'child\n');
    await put(join(repos, 'stray', 'stray.txt'), 'stray\n');
    await put(join(attachments, 'note.txt'), 'note\n');
    jest.mocked(getWorkspaceType).mockReturnValue('multi-repo');
    jest.mocked(isMultiRepoWorkspace).mockReturnValue(true);
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'app', name: 'App', repoPath: '/source/app' }],
    });
    mockedResolveWorktreeCwd.mockReturnValue(workspace);
    jest.mocked(getWorkspaceWorktreeRootRepoDir).mockReturnValue(workspace);
    jest.mocked(getWorkspaceWorktreeReposDir).mockReturnValue(repos);
    jest.mocked(getWorkspaceWorktreeRepoDir).mockReturnValue(child);
    jest
      .mocked(getWorkspaceWorktreeAttachmentsDir)
      .mockReturnValue(attachments);
  });

  it('saves the workspace root, a child checkout and attachments', async () => {
    for (const path of [
      join(workspace, 'workspace.txt'),
      join(child, 'child.txt'),
      join(attachments, 'note.txt'),
    ]) {
      await save({ ...multiScope, absolutePath: path, content: 'saved\n' });
      expect(await read(path)).toBe('saved\n');
    }
  });

  it('saves a folder under repos/ that is no configured checkout', async () => {
    const stray = join(repos, 'stray', 'stray.txt');
    await save({ ...multiScope, absolutePath: stray, content: 'saved\n' });
    expect(await read(stray)).toBe('saved\n');
  });
});

describe('Cowork project', () => {
  const coworkScope = { projectId: 'cowork-1', worktreeId: 'wt-1' };
  let home = '';
  let managed = '';
  let worktreeAttachments = '';

  beforeEach(async () => {
    home = join(tempRoot, 'cowork-home');
    managed = join(home, '.canopy');
    worktreeAttachments = join(tempRoot, 'cowork-worktree-attachments');
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
    mockedResolveWorktreeCwd.mockReturnValue(home);
    jest.mocked(getWorktreeAttachmentsDir).mockReturnValue(worktreeAttachments);
    await put(join(home, 'draft.md'), 'draft\n');
    for (const managedDir of ['notes', 'prompts', 'attachments']) {
      await put(join(managed, managedDir, 'kept.md'), 'kept\n');
    }
    await put(join(worktreeAttachments, 'pasted.txt'), 'pasted\n');
  });

  it('saves the project folder, its managed folders and worktree attachments', async () => {
    for (const path of [
      join(home, 'draft.md'),
      join(managed, 'notes', 'kept.md'),
      join(managed, 'prompts', 'kept.md'),
      join(managed, 'attachments', 'kept.md'),
      join(worktreeAttachments, 'pasted.txt'),
    ]) {
      await save({ ...coworkScope, absolutePath: path, content: 'saved\n' });
      expect(await read(path)).toBe('saved\n');
    }
  });
});

describe('App Advisor', () => {
  const advisorScope = {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: 'wt-1',
  };
  let home = '';
  let attachments = '';

  beforeEach(async () => {
    home = join(tempRoot, 'advisor-home');
    attachments = join(tempRoot, 'advisor-attachments');
    await put(join(home, 'notes.md'), 'notes\n');
    await put(join(attachments, 'pasted.txt'), 'pasted\n');
    mockedResolveWorktreeCwd.mockReturnValue(home);
    jest.mocked(getWorktreeAttachmentsDir).mockReturnValue(attachments);
  });

  it('saves its home and its private attachment store', async () => {
    for (const path of [
      join(home, 'notes.md'),
      join(attachments, 'pasted.txt'),
    ]) {
      await save({ ...advisorScope, absolutePath: path, content: 'saved\n' });
      expect(await read(path)).toBe('saved\n');
    }
  });
});
