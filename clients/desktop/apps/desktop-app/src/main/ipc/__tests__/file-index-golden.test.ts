/**
 * CAN-5037 golden: `file-index:get` pinned at the IPC boundary on real
 * temporary filesystems and a real `git init`. Captured on the walk that
 * `services/files-service.ts` composed directly, before the channel became a
 * projection over `worker.filesystem.search`. The retained direct
 * `buildFileIndexes` (Home, Portal mentions, Portal rebind) is pinned beside
 * it, because both share one burst coalescer.
 */
import { execFileSync } from 'node:child_process';
import { filesystemScopeError } from '@canopy/core-runtime/node/filesystem/scope-reader';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  promises as fsPromises,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type FileIndexEntry,
  type FileIndexingPreferences,
  type FileIndexRequest,
  type FileIndexResponse,
  type RepoFileIndex,
  type ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import {
  getChangedFileSources,
  matchChangedFileForPath,
} from '../../../renderer/src/components/chat/useOpenFileDiffTarget';
import {
  buildFilePathMentionIndex,
  splitTextByFilePathMentions,
} from '../../../renderer/src/lib/filePathMentionIndex';
import { rewriteFileReferencesForTargetCwd } from '../../../renderer/src/lib/file-reference-paths';
import { buildFileTabTitle } from '../../../renderer/src/stores/chat/persisted-tabs';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import type * as SharedContainerReaderModule from '../../shared-containers/read/reader';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

jest.mock('electron', () => ({
  shell: { trashItem: jest.fn(), openExternal: jest.fn() },
}));

jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
  getFileBrowserSupplementalWatchPaths: jest.fn(() => []),
}));

jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  ),
  readPreferencesFile: jest.fn(),
}));

/** The replica store the sealed-viewer case installs; read lazily. */
const mockViewerReader: { store: unknown } = { store: null };
jest.mock('../../shared-containers/read/reader', () => ({
  ...jest.requireActual<typeof SharedContainerReaderModule>(
    '../../shared-containers/read/reader',
  ),
  getSharedContainerReader: (): { store: unknown } => mockViewerReader,
}));

import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../../lib/preferences-store';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { buildFileIndexes } from '../../services/files-service';
import { registerFileTreeHandlers } from '../file-tree';

const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);

const target = { projectId: 'project-1', worktreeId: 'wt-1' };
// The index ignores the event before CAN-5037; afterwards it derives the
// trusted caller from this sender.
const invokeEvent = { sender: { id: 41 } };

let runtime: DesktopCanopyDispatcher | undefined;

/** The only part of this file that follows the handler's registration. */
function registerHandlers(): void {
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  registerFileTreeHandlers(runtime, (event) => ({
    principalId: 'local',
    clientInstanceId: `electron-web-contents:${event.sender.id}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  }));
}

function getIndex(request: FileIndexRequest): Promise<FileIndexResponse> {
  const handler = handlers.get(IPC_CHANNELS.fileIndexGet);
  if (!handler) throw new Error('file-index:get is not registered.');
  return Promise.resolve(handler(invokeEvent, request)).then(
    (value) => value as FileIndexResponse,
  );
}

function root(
  repoId: string,
  absolutePath: string,
  rootKind: FileBrowserRoot['rootKind'],
  options: { gitAware?: boolean; excluded?: string[] } = {},
): FileBrowserRoot {
  return {
    repoId,
    repoName: `${repoId} name`,
    absolutePath,
    rootKind,
    gitAware: options.gitAware ?? rootKind === 'git-repo',
    excludedDescendantRoots: options.excluded ?? [],
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

function setIndexing(fileIndexing: FileIndexingPreferences): void {
  mockedReadPreferencesFile.mockResolvedValue({
    ...DEFAULT_PREFERENCES,
    fileIndexing,
  });
}

async function put(path: string, content = ''): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

function gitInit(directory: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
}

function file(
  rootPath: string,
  relativePath: string,
  isIgnored = false,
): FileIndexEntry {
  const segments = relativePath.split('/');
  return {
    relativePath,
    filename: segments[segments.length - 1] ?? relativePath,
    absolutePath: join(rootPath, ...segments),
    isIgnored,
  };
}

function repo(
  entry: FileBrowserRoot,
  files: FileIndexEntry[],
  truncated = false,
): RepoFileIndex {
  return {
    repoId: entry.repoId,
    repoName: entry.repoName,
    absolutePath: entry.absolutePath,
    rootKind: entry.rootKind,
    files,
    truncated,
  };
}

function paths(index: RepoFileIndex | undefined): string[] {
  return (index?.files ?? []).map((entry) => entry.relativePath);
}

// Fixture writes and removals cost up to ~9 ms per entry under host I/O
// load, so hooks get explicit budgets instead of Jest's 5 s default.
const HOOK_TIMEOUT_MS = 60_000;
// Retries ENOTEMPTY from writes a timed-out test left running.
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5 };

let tempRoot = '';

beforeEach(async () => {
  // Not realpath'd: on macOS the display spelling must survive the walk.
  tempRoot = await mkdtemp(join(tmpdir(), 'file-index-golden-'));
  handlers.clear();
  mockedGetFileBrowserRoots.mockReset();
  mockedReadPreferencesFile.mockReset();
  mockViewerReader.store = null;
  setIndexing({ disabledBuiltinGlobIds: [], customGlobs: [] });
  registerHandlers();
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await rm(tempRoot, REMOVE_OPTIONS);
}, HOOK_TIMEOUT_MS);

// Probe the actual fixture volume; platform names do not establish case rules.
const caseProbe = mkdtempSync(join(tmpdir(), 'file-index-case-'));
let caseSensitive: boolean;
try {
  writeFileSync(join(caseProbe, 'A.ts'), 'upper');
  caseSensitive = !existsSync(join(caseProbe, 'a.ts'));
} finally {
  rmSync(caseProbe, { recursive: true, force: true });
}

(caseSensitive ? it : it.skip)(
  'retains case-neighbor identities in the real mentions index',
  async () => {
    const home = join(tempRoot, 'case-neighbors');
    await put(join(home, 'A.ts'), 'upper');
    await put(join(home, 'a.ts'), 'lower');
    setRoots([root('project-1', home, 'standalone')]);
    const result = await getIndex(target);
    expect(paths(result.repos[0]).sort()).toEqual(['A.ts', 'a.ts']);
    const mentions = buildFilePathMentionIndex(result.repos, home);
    expect(mentions?.aliases.size).toBe(2);
    for (const name of ['A.ts', 'a.ts']) {
      expect(mentions?.aliases.get(name)?.absolutePath).toBe(join(home, name));
    }
  },
);

(process.platform === 'win32' ? it.skip : it)(
  'round-trips indexed POSIX identities through mentions, diff targets and re-rooting',
  async () => {
    const home = join(tempRoot, 'identity');
    const targetHome = join(tempRoot, 'target');
    const names = [
      '日本語 🌲.ts',
      "space and apostrophe's.ts",
      'literal\\name.ts',
      'literal/name.ts',
      'report:12.ts',
    ];
    for (const name of names) {
      await put(join(home, name), name);
      await put(join(targetHome, name), name);
    }
    setRoots([root('project-1', home, 'standalone')]);
    const result = await getIndex(target);
    expect(paths(result.repos[0]).sort()).toEqual([...names].sort());
    const changedFiles: ChangedFileInfo[] = paths(result.repos[0]).map(
      (path) => ({ path, status: 'added', insertions: 1, deletions: 0 }),
    );
    const roots = new Map([[undefined, home]]);
    const mentions = buildFilePathMentionIndex(result.repos, home);
    expect(mentions?.aliases.size).toBe(names.length);
    const tokens = ['literal\\name.ts', 'literal/name.ts', 'report:12.ts'];
    const pieces = splitTextByFilePathMentions(tokens.join(' '), mentions);
    expect(
      pieces
        .filter((piece) => piece.type === 'file')
        .map((piece) => piece.target.absolutePath),
    ).toEqual(tokens.map((name) => join(home, name)));
    for (const name of names) {
      const diffTarget = matchChangedFileForPath(
        { uncommitted: changedFiles, committed: [] },
        roots,
        join(home, name),
      );
      expect(diffTarget?.file.path).toBe(name);
      expect(
        buildFileTabTitle(
          join(home, name),
          names.map((path) => join(home, path)),
        ),
      ).toBe(name.split('/').pop());
      expect(
        await readFile(join(home, diffTarget?.file.path ?? ''), 'utf8'),
      ).toBe(name);
      const references = [
        { absolutePath: join(home, name), displayPath: name },
      ];
      const rewritten = rewriteFileReferencesForTargetCwd(
        references,
        targetHome,
      );
      expect(rewritten[0]?.absolutePath).toBe(join(targetHome, name));
      expect(await readFile(rewritten[0]?.absolutePath ?? '', 'utf8')).toBe(
        name,
      );
    }
    const literal = changedFiles.find(
      (file) => file.path === 'literal\\name.ts',
    );
    const directory = changedFiles.find(
      (file) => file.path === 'literal/name.ts',
    );
    if (!literal || !directory)
      throw new Error('Missing real diff identity fixtures');
    expect(
      getChangedFileSources(
        { uncommitted: [directory], committed: [literal] },
        literal,
      ),
    ).toEqual(['committed']);
  },
);

describe('single-repository worktree', () => {
  let repoPath = '';
  let attachmentsPath = '';
  let roots: FileBrowserRoot[] = [];

  beforeEach(async () => {
    repoPath = join(tempRoot, 'single', 'repo');
    attachmentsPath = join(tempRoot, 'single', 'attachments');
    await mkdir(repoPath, { recursive: true });
    gitInit(repoPath);
    await put(join(repoPath, '.gitignore'), '*.log\nbuild/\n');
    await put(join(repoPath, 'a.ts'));
    await put(join(repoPath, 'B.md'));
    await put(join(repoPath, 'debug.log'));
    await put(join(repoPath, 'build', 'out.js'));
    await put(join(repoPath, 'docs', 'guide.md'));
    await put(join(repoPath, 'docs', 'zeta', 'deep.txt'));
    await put(join(repoPath, 'src', 'index.ts'));
    await put(join(repoPath, 'node_modules', 'pkg', 'index.js'));
    await put(join(repoPath, 'target', 'out.bin'));
    await put(join(tempRoot, 'single', 'outside.txt'));
    await symlink(join(repoPath, 'docs'), join(repoPath, 'link-to-docs'));
    await symlink(join(repoPath, 'a.ts'), join(repoPath, 'link-to-a.ts'));
    await symlink(
      join(tempRoot, 'single', 'outside.txt'),
      join(repoPath, 'outside-link'),
    );
    await put(join(attachmentsPath, 'note.txt'));
    roots = [
      root('project-1', repoPath, 'git-repo'),
      root('attachments', attachmentsPath, 'attachments'),
    ];
    setRoots(roots);
  }, HOOK_TIMEOUT_MS);

  it('pins the mentions index byte for byte, with Git ignore marks', async () => {
    const [repoRoot, attachmentsRoot] = roots;
    if (!repoRoot || !attachmentsRoot) throw new Error('missing roots');
    const expected: FileIndexResponse = {
      repos: [
        // The ignored `build/` directory is walked after everything else.
        repo(repoRoot, [
          file(repoPath, 'docs/zeta/deep.txt'),
          file(repoPath, 'docs/guide.md'),
          file(repoPath, 'src/index.ts'),
          file(repoPath, '.gitignore'),
          file(repoPath, 'a.ts'),
          file(repoPath, 'B.md'),
          file(repoPath, 'debug.log', true),
          file(repoPath, 'link-to-a.ts'),
          file(repoPath, 'build/out.js', true),
        ]),
        repo(attachmentsRoot, [file(attachmentsPath, 'note.txt')]),
      ],
    };
    const result = await getIndex(target);
    expect(result).toEqual(expected);
    // Key order and the explicit `truncated: false` are part of the payload.
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
    expect(getFileBrowserRoots).toHaveBeenCalledWith('project-1', 'wt-1');
  });

  it('defers ignored and dependency trees to the end of the explorer walk', async () => {
    const result = await getIndex({ ...target, purpose: 'file-explorer' });
    expect(paths(result.repos[0])).toEqual([
      'docs/zeta/deep.txt',
      'docs/guide.md',
      'src/index.ts',
      '.gitignore',
      'a.ts',
      'B.md',
      'debug.log',
      'link-to-a.ts',
      'build/out.js',
      'node_modules/pkg/index.js',
      'target/out.bin',
    ]);
    expect(
      result.repos[0]?.files
        .filter((entry) => entry.isIgnored)
        .map((entry) => entry.relativePath),
    ).toEqual(['debug.log', 'build/out.js']);
    expect(result.repos.map((entry) => entry.truncated)).toEqual([
      false,
      false,
    ]);
  });

  it('applies indexing preferences to mentions only', async () => {
    setIndexing({
      disabledBuiltinGlobIds: ['node-modules'],
      customGlobs: [
        { id: 'custom-docs', pattern: 'docs/**', enabled: true },
        { id: 'custom-off', pattern: 'src/**', enabled: false },
      ],
    });
    const mentions = await getIndex({ ...target, purpose: 'mentions' });
    expect(paths(mentions.repos[0])).toEqual([
      'node_modules/pkg/index.js',
      'src/index.ts',
      '.gitignore',
      'a.ts',
      'B.md',
      'debug.log',
      'link-to-a.ts',
      'build/out.js',
    ]);
    const explorer = await getIndex({ ...target, purpose: 'file-explorer' });
    expect(paths(explorer.repos[0])).toContain('docs/guide.md');
  });

  it('walks at most twice for a burst of identical requests', async () => {
    const readdirSpy = jest.spyOn(fsPromises, 'readdir');
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => getIndex(target)),
      );
      expect(
        new Set(results.map((result) => JSON.stringify(result))).size,
      ).toBe(1);
      expect(
        readdirSpy.mock.calls.filter(([directory]) => directory === repoPath),
      ).toHaveLength(2);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('shares one coalescer with the retained direct index', async () => {
    const readdirSpy = jest.spyOn(fsPromises, 'readdir');
    try {
      const results = await Promise.all([
        getIndex(target),
        buildFileIndexes(target),
        getIndex(target),
        buildFileIndexes(target),
      ]);
      expect(
        new Set(results.map((result) => JSON.stringify(result))).size,
      ).toBe(1);
      expect(
        readdirSpy.mock.calls.filter(([directory]) => directory === repoPath),
      ).toHaveLength(2);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('keeps each purpose in its own coalescing slot', async () => {
    const readdirSpy = jest.spyOn(fsPromises, 'readdir');
    try {
      const [mentions, explorer] = await Promise.all([
        getIndex(target),
        getIndex({ ...target, purpose: 'file-explorer' }),
      ]);
      expect(paths(mentions.repos[0])).not.toContain(
        'node_modules/pkg/index.js',
      );
      expect(paths(explorer.repos[0])).toContain('node_modules/pkg/index.js');
      expect(
        readdirSpy.mock.calls.filter(([directory]) => directory === repoPath),
      ).toHaveLength(2);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('answers a request made during a walk with a walk that starts after it', async () => {
    const first = getIndex(target);
    await put(join(repoPath, 'src', 'added.ts'));
    const second = await getIndex(target);
    await first;
    expect(paths(second.repos[0])).toContain('src/added.ts');
  });

  it('scopes the retained direct index to one repoId', async () => {
    const scoped = await buildFileIndexes(target, { repoId: 'attachments' });
    expect(scoped.repos.map((entry) => entry.repoId)).toEqual(['attachments']);
    expect(paths(scoped.repos[0])).toEqual(['note.txt']);
    await expect(
      buildFileIndexes(target, { repoId: 'missing-repo' }),
    ).resolves.toEqual({ repos: [] });
  });

  it('rejects an invalid id before reading roots', async () => {
    await expect(
      getIndex({ projectId: '../escape', worktreeId: 'wt-1' }),
    ).rejects.toThrow(
      'Invalid projectId: must be lowercase alphanumeric with hyphens',
    );
    await expect(
      getIndex({ projectId: 'project-1', worktreeId: 'WT' }),
    ).rejects.toThrow(
      'Invalid worktreeId: must be lowercase alphanumeric with hyphens',
    );
    expect(getFileBrowserRoots).not.toHaveBeenCalled();
  });

  it('distinguishes a vanished filesystem scope from a failed index', async () => {
    mockedGetFileBrowserRoots.mockRejectedValueOnce(
      filesystemScopeError('roots', 'notFound'),
    );
    await expect(
      getIndex(target).catch((error: unknown) => toAppError(error)),
    ).resolves.toMatchObject({
      code: 'external.state_changed',
    });
    mockedGetFileBrowserRoots.mockRejectedValueOnce(
      new Error('Index invariant failed'),
    );
    await expect(
      getIndex(target).catch((error: unknown) => toAppError(error)),
    ).resolves.toMatchObject({
      code: 'app.unexpected',
    });
  });

  const unprivileged = process.getuid?.() !== 0;
  (unprivileged ? it : it.skip)(
    'rejects with the walk error when a directory cannot be read',
    async () => {
      const locked = join(repoPath, 'docs', 'zeta');
      await chmod(locked, 0o000);
      try {
        // Jest's realm turns the fs error into `Error: EACCES: …`; Electron
        // keeps the original. Both carry this text.
        await expect(getIndex(target)).rejects.toThrow(
          `EACCES: permission denied, scandir '${locked}'`,
        );
        // A direct caller that joins a burst's queued walk gets the same
        // walk error, whichever path started that walk.
        const burst = await Promise.allSettled([
          getIndex(target),
          getIndex(target),
          buildFileIndexes(target),
        ]);
        const messages = burst.map((outcome) =>
          outcome.status === 'rejected' && outcome.reason instanceof Error
            ? outcome.reason.message
            : outcome.status,
        );
        expect(messages).toHaveLength(3);
        for (const message of messages)
          expect(message).toContain(
            `EACCES: permission denied, scandir '${locked}'`,
          );
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );
});

describe('multi-repository worktree', () => {
  it('excludes child checkouts from the workspace root and marks each repo', async () => {
    const workspace = join(tempRoot, 'multi', 'wt');
    const reposDir = join(workspace, 'repos');
    const api = join(reposDir, 'api');
    const web = join(reposDir, 'web');
    const attachments = join(tempRoot, 'multi', 'attachments');
    await put(join(workspace, 'README.md'));
    await put(join(workspace, 'notes', 'todo.md'));
    await put(join(reposDir, 'stray.txt'));
    await mkdir(api, { recursive: true });
    gitInit(api);
    await put(join(api, '.gitignore'), 'dist/\n');
    await put(join(api, 'dist', 'bundle.js'));
    await put(join(api, 'server.ts'));
    // A Git-aware root that is not a repository: the listing fails and marks
    // nothing.
    await put(join(web, 'dist', 'bundle.js'));
    await put(join(web, 'app.tsx'));
    await put(join(attachments, 'shot.png'));
    const roots = [
      root('workspace-root', workspace, 'workspace-root', {
        gitAware: false,
        excluded: [reposDir, api, web],
      }),
      root('api', api, 'git-repo'),
      root('web', web, 'git-repo'),
      root('attachments', attachments, 'attachments'),
    ];
    setRoots(roots);
    const [workspaceRoot, apiRoot, webRoot, attachmentsRoot] = roots;
    if (!workspaceRoot || !apiRoot || !webRoot || !attachmentsRoot)
      throw new Error('missing roots');

    const expected: FileIndexResponse = {
      repos: [
        repo(workspaceRoot, [
          file(workspace, 'notes/todo.md'),
          file(workspace, 'README.md'),
        ]),
        repo(apiRoot, [
          file(api, '.gitignore'),
          file(api, 'server.ts'),
          file(api, 'dist/bundle.js', true),
        ]),
        repo(webRoot, [file(web, 'dist/bundle.js'), file(web, 'app.tsx')]),
        repo(attachmentsRoot, [file(attachments, 'shot.png')]),
      ],
    };
    const result = await getIndex(target);
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
    const explorer = await getIndex({ ...target, purpose: 'file-explorer' });
    expect(explorer.repos.map(paths)).toEqual(expected.repos.map(paths));
  });
});

describe('Cowork project', () => {
  it('surfaces managed folders as their own roots', async () => {
    const project = join(tempRoot, 'cowork', 'project');
    const managed = join(project, '.canopy');
    const notes = join(managed, 'notes');
    const prompts = join(managed, 'prompts');
    const attachments = join(managed, 'attachments');
    await put(join(project, 'plan.md'));
    await put(join(project, 'drafts', 'one.md'));
    await put(join(managed, 'settings.json'));
    await put(join(notes, 'n.md'));
    await put(join(prompts, 'p.md'));
    await put(join(attachments, 'x.png'));
    const roots = [
      root('cowork-workspace', project, 'standalone', {
        excluded: [notes, prompts, attachments],
      }),
      root('notes', notes, 'standalone'),
      root('prompts', prompts, 'standalone'),
      root('attachments', attachments, 'attachments'),
    ];
    setRoots(roots);
    const [projectRoot, notesRoot, promptsRoot, attachmentsRoot] = roots;
    if (!projectRoot || !notesRoot || !promptsRoot || !attachmentsRoot)
      throw new Error('missing roots');

    const expected: FileIndexResponse = {
      repos: [
        repo(projectRoot, [
          file(project, '.canopy/settings.json'),
          file(project, 'drafts/one.md'),
          file(project, 'plan.md'),
        ]),
        repo(notesRoot, [file(notes, 'n.md')]),
        repo(promptsRoot, [file(prompts, 'p.md')]),
        repo(attachmentsRoot, [file(attachments, 'x.png')]),
      ],
    };
    await expect(
      getIndex({ projectId: 'cowork', worktreeId: 'home' }).then((result) =>
        JSON.stringify(result),
      ),
    ).resolves.toBe(JSON.stringify(expected));
  });
});

describe('explorer entry cap', () => {
  // Building and removing ~26,000 entries is the cost here (92 s and 81 s
  // at load 20 on macOS; both walks take ~1 s), so the fixtures are built
  // once, read-only, with their own budget outside the per-test temp root.
  const FIXTURE_TIMEOUT_MS = 600_000;
  const WALK_TIMEOUT_MS = 60_000;
  const BULK_NAMES = Array.from(
    { length: 25_003 },
    (_, index) => `n${String(index).padStart(5, '0')}.txt`,
  );
  let fixtureRoot = '';
  let capRoots: FileBrowserRoot[] = [];
  let bulkRoots: FileBrowserRoot[] = [];
  // afterAll stops a build a timed-out beforeAll left running before it
  // removes the tree, so no write lands during the removal.
  let cancelled = false;
  let building: Promise<void> = Promise.resolve();

  async function emptyFiles(directory: string, names: string[]): Promise<void> {
    await mkdir(directory, { recursive: true });
    for (let start = 0; start < names.length && !cancelled; start += 1_000)
      await Promise.all(
        names
          .slice(start, start + 1_000)
          .map((name) => writeFile(join(directory, name), '')),
      );
  }

  function many(directory: string, count: number): Promise<void> {
    return emptyFiles(
      directory,
      Array.from(
        { length: count },
        (_, index) => `f${String(index).padStart(3, '0')}.txt`,
      ),
    );
  }

  // 100 roots: floor(25,000 / 100) = 250 entries each.
  async function buildCapRoots(base: string): Promise<FileBrowserRoot[]> {
    const deps = join(base, 'deps');
    await many(join(deps, 'node_modules', 'pkg'), 200);
    await many(join(deps, 'src'), 60);
    const exact = join(base, 'exact');
    await many(exact, 250);
    const over = join(base, 'over');
    await many(over, 251);
    const pending = join(base, 'pending');
    await many(pending, 250);
    await mkdir(join(pending, 'node_modules'));
    const roots = [
      root('deps', deps, 'standalone'),
      root('exact', exact, 'standalone'),
      root('over', over, 'standalone'),
      root('pending', pending, 'standalone'),
    ];
    for (let index = roots.length; index < 100; index += 1) {
      const empty = join(base, `empty-${index}`);
      await mkdir(empty);
      roots.push(root(`empty-${index}`, empty, 'standalone'));
    }
    return roots;
  }

  async function buildBulkRoots(bulk: string): Promise<FileBrowserRoot[]> {
    await emptyFiles(join(bulk, 'data'), BULK_NAMES);
    await put(join(bulk, 'top.md'));
    return [root('bulk', bulk, 'standalone')];
  }

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'file-index-golden-cap-'));
    building = (async (): Promise<void> => {
      capRoots = await buildCapRoots(join(fixtureRoot, 'cap'));
      bulkRoots = await buildBulkRoots(join(fixtureRoot, 'bulk'));
    })();
    await building;
  }, FIXTURE_TIMEOUT_MS);

  afterAll(async () => {
    cancelled = true;
    await building.catch(() => undefined);
    if (fixtureRoot) await rm(fixtureRoot, REMOVE_OPTIONS);
  }, FIXTURE_TIMEOUT_MS);

  it(
    'splits 25,000 entries across roots, keeping source before dependencies',
    async () => {
      expect(capRoots).toHaveLength(100);
      setRoots(capRoots);

      const explorer = await getIndex({ ...target, purpose: 'file-explorer' });
      expect(explorer.repos).toHaveLength(100);
      const [depsIndex, exactIndex, overIndex, pendingIndex] = explorer.repos;
      expect(paths(depsIndex)).toEqual([
        ...Array.from(
          { length: 60 },
          (_, index) => `src/f${String(index).padStart(3, '0')}.txt`,
        ),
        ...Array.from(
          { length: 190 },
          (_, index) =>
            `node_modules/pkg/f${String(index).padStart(3, '0')}.txt`,
        ),
      ]);
      expect(depsIndex?.truncated).toBe(true);
      expect(exactIndex?.files).toHaveLength(250);
      expect(exactIndex?.truncated).toBe(false);
      expect(paths(overIndex)).toEqual(
        Array.from(
          { length: 250 },
          (_, index) => `f${String(index).padStart(3, '0')}.txt`,
        ),
      );
      expect(overIndex?.truncated).toBe(true);
      // An unvisited deferred directory, even an empty one, is a remainder.
      expect(pendingIndex?.files).toHaveLength(250);
      expect(pendingIndex?.truncated).toBe(true);
      for (const empty of explorer.repos.slice(4)) {
        expect(empty.files).toEqual([]);
        expect(empty.truncated).toBe(false);
      }

      // Mentions stay under their own cap, and keep the user's dependency
      // exclusions.
      const mentions = await getIndex(target);
      expect(mentions.repos[2]?.files).toHaveLength(251);
      expect(paths(mentions.repos[0])).toHaveLength(60);
      expect(mentions.repos.every((entry) => entry.truncated === false)).toBe(
        true,
      );
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'caps a single root at 25,000 while mentions, under their cap, return every file',
    async () => {
      expect(bulkRoots).toHaveLength(1);
      setRoots(bulkRoots);

      const explorer = await getIndex({ ...target, purpose: 'file-explorer' });
      expect(explorer.repos[0]?.files).toHaveLength(25_000);
      expect(explorer.repos[0]?.files[24_999]?.relativePath).toBe(
        'data/n24999.txt',
      );
      expect(explorer.repos[0]?.truncated).toBe(true);

      const mentions = await getIndex(target);
      expect(paths(mentions.repos[0])).toEqual([
        ...BULK_NAMES.map((name) => `data/${name}`),
        'top.md',
      ]);
      expect(mentions.repos[0]?.truncated).toBe(false);
    },
    WALK_TIMEOUT_MS,
  );
});

describe('sealed shared-container viewer', () => {
  it('walks replica roots through the no-follow read boundary', async () => {
    const replica = join(tempRoot, 'replica', 'revision');
    const files = join(replica, 'files');
    await put(join(files, 'doc.md'));
    await put(join(files, 'nested', 'deep.md'));
    await put(join(tempRoot, 'replica', 'secret.txt'));
    await symlink(join(files, 'doc.md'), join(files, 'inner-link.md'));
    await symlink(
      join(tempRoot, 'replica', 'secret.txt'),
      join(files, 'outer-link.md'),
    );
    const calls: string[] = [];
    const store = {
      assertRealDirectoryForRead: jest.fn(
        async (revisionRoot: string, targetPath: string) => {
          calls.push(`assert:${revisionRoot}:${targetPath}`);
          const info = await lstat(targetPath);
          if (info.isSymbolicLink() || !info.isDirectory())
            throw new Error('not a real directory');
        },
      ),
      readDirectoryForRead: jest.fn(
        (revisionRoot: string, targetPath: string): Promise<Dirent[]> => {
          calls.push(`read:${revisionRoot}:${targetPath}`);
          return readdir(targetPath, { withFileTypes: true });
        },
      ),
      lstatEntryForRead: jest.fn((_revisionRoot: string, targetPath: string) =>
        lstat(targetPath),
      ),
    };
    // The index reads only the replica store's no-follow primitives.
    mockViewerReader.store = store;
    const viewerRoot: FileBrowserRoot = {
      ...root('container-files', files, 'standalone'),
      readBoundaryRoot: replica,
    };
    setRoots([viewerRoot]);

    const result = await getIndex({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'revision-1',
    });
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        repos: [
          repo(viewerRoot, [
            file(files, 'nested/deep.md'),
            file(files, 'doc.md'),
          ]),
        ],
      }),
    );
    expect(calls).toEqual([
      `assert:${replica}:${files}`,
      `read:${replica}:${files}`,
      `assert:${replica}:${join(files, 'nested')}`,
      `read:${replica}:${join(files, 'nested')}`,
    ]);
  });
});
