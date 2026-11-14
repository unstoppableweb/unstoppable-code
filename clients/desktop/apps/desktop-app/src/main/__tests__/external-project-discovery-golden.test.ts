import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import {
  IPC_CHANNELS,
  type ExternalProjectDiscoverResponse,
} from '@canopy/desktop-shared/types';
import { isRecord } from '../lib/type-guards';
import type * as ClaudeDiscoveryModule from '../external-projects/claude-discovery';
import type { ChatHistoryProfileSource } from '../memory/local/chat-history-profile-refresh';
import type * as StoreReadRunnerModule from '../external-projects/store-read-runner';
import {
  buildOpenCodeFixture,
  buildStoreReadWorker,
  buildT3Fixture,
  type OpenCodeFixtureMessage,
} from './helpers/external-store-fixtures';
type MockHandler = (event: unknown, request: unknown) => Promise<unknown>;
const mockHandlers = new Map<string, MockHandler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: MockHandler): void => {
    mockHandlers.set(channel, handler);
  },
}));
// The Claude store stays out of every scan; the helpers other adapters
// share with the Claude adapter stay real.
jest.mock('../external-projects/claude-discovery', () => ({
  ...jest.requireActual<typeof ClaudeDiscoveryModule>(
    '../external-projects/claude-discovery',
  ),
  discoverClaudeProjects: (): Promise<{
    roots: never[];
    diagnostics: never[];
    detected: boolean;
  }> =>
    Promise.resolve({
      roots: [],
      diagnostics: [],
      detected: false,
    }),
}));
// Jest has no built worker bundle, so the real runner starts its Worker from
// one bundled here; `live` counts runners the scan left open.
const mockStoreWorker = { entry: '', live: 0 };
jest.mock('../external-projects/store-read-runner', () => {
  const actual = jest.requireActual<typeof StoreReadRunnerModule>(
    '../external-projects/store-read-runner',
  );
  class GoldenStoreReadRunner extends actual.StoreReadRunner {
    constructor() {
      super(mockStoreWorker.entry);
      mockStoreWorker.live += 1;
    }
    override async close(): Promise<void> {
      await super.close();
      mockStoreWorker.live -= 1;
    }
  }
  return { ...actual, StoreReadRunner: GoldenStoreReadRunner };
});
const mockProfileRefresh = jest.fn<void, [ChatHistoryProfileSource]>();
jest.mock('../memory/local/chat-history-profile-refresh', () => ({
  requestChatHistoryProfileRefresh: (input: ChatHistoryProfileSource): void => {
    mockProfileRefresh(input);
  },
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<{ items: never[] }> =>
    Promise.resolve({ items: [] }),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (): Promise<null> => Promise.resolve(null),
}));
import { registerExternalProjectHandlers } from '../ipc/external-projects';
import {
  getCachedExternalProjectScan,
  resetExternalProjectScanCacheForTests,
} from '../external-projects/discovery';
import { externalProjectCandidateId } from '../external-projects/normalize';
import {
  recordExternalProjectImport,
  recordExternalProjectSessionImports,
  resetExternalProjectImportLedgerForTests,
} from '../external-projects/ledger';
import { getDataDir, getExternalProjectImportsFilePath } from '../lib/paths';
import {
  planChatImports,
  prepareChatImports,
  type ChatImportOutcome,
} from '../external-projects/import';
import { StoreReadRunner } from '../external-projects/store-read-runner';
import type { DiscoveredSession } from '../external-projects/types';

let workerDir = '';
beforeAll(() => {
  workerDir = mkdtempSync(join(tmpdir(), 'external-store-worker-'));
  mockStoreWorker.entry = buildStoreReadWorker(workerDir);
});
afterAll(() => {
  rmSync(workerDir, { recursive: true, force: true });
});
beforeEach(() => {
  mockProfileRefresh.mockClear();
});

// Chosen folders live outside excluded OS-temp/app-data roots; every file is
// inside this exclusively created directory and is removed in finally.
test('external-projects:discover keeps Git and folder candidates selectable and refreshes source state', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-import-golden-')),
  );
  try {
    const repo = join(fixture, 'repo');
    const folder = join(fixture, 'folder');
    mkdirSync(folder);
    mkdirSync(repo);
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'untracked project\n');
    const discover = discoverHandler();
    const request = { providers: ['claude'], customRoots: [repo, folder] };
    const first = await discover({}, request);
    const candidate = first.candidates.find((entry) => entry.rootPath === repo);
    expect(candidate).toMatchObject({
      kind: 'git',
      status: 'available',
      headUnborn: true,
    });
    expect(
      first.candidates.find((entry) => entry.rootPath === folder),
    ).toMatchObject({ kind: 'folder', status: 'available' });
    expect(
      first.candidates.find((entry) => entry.rootPath === folder),
    ).not.toHaveProperty('headUnborn');
    expect(getCachedExternalProjectScan(first.scanId)?.candidates).toEqual(
      first.candidates,
    );
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    );
    const refreshed = await discover({}, request);
    expect(
      refreshed.candidates.find((entry) => entry.id === candidate?.id),
    ).toMatchObject({ kind: 'git', status: 'available' });
    expect(
      refreshed.candidates.find((entry) => entry.id === candidate?.id),
    ).not.toHaveProperty('headUnborn');
  } finally {
    resetExternalProjectScanCacheForTests();
    rmSync(fixture, { recursive: true, force: true });
  }
});

type DiscoverHandler = (
  event: unknown,
  request: unknown,
) => Promise<ExternalProjectDiscoverResponse>;

function isDiscoverResponse(
  value: unknown,
): value is ExternalProjectDiscoverResponse {
  return (
    isRecord(value) &&
    typeof value.scanId === 'string' &&
    Array.isArray(value.candidates)
  );
}

function discoverHandler(): DiscoverHandler {
  registerExternalProjectHandlers();
  const discover = mockHandlers.get(IPC_CHANNELS.externalProjectsDiscover);
  if (!discover) throw new Error('discovery IPC was not registered');
  return async (event, request) => {
    const response = await discover(event, request);
    if (!isDiscoverResponse(response)) {
      throw new Error('discovery IPC returned an unexpected response');
    }
    return response;
  };
}

function registeredHandler(channel: string): MockHandler {
  registerExternalProjectHandlers();
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  return handler;
}

function gitIn(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      ...args,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'commit', '--allow-empty', '-qm', 'initial');
}

const PROVIDER_ENV = [
  'T3CODE_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_DATA_HOME',
  'OPENCODE_DB',
] as const;

/**
 * Points every provider store at the fixture, so a scan never reads this
 * machine's own `~/.t3`, `~/.codex`, or OpenCode data.
 */
async function withProviderStores<T>(
  fixture: string,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = PROVIDER_ENV.map((name) => [name, process.env[name]] as const);
  process.env.T3CODE_HOME = join(fixture, 't3');
  process.env.CODEX_HOME = join(fixture, 'codex');
  process.env.CLAUDE_CONFIG_DIR = join(fixture, 'claude');
  process.env.XDG_DATA_HOME = join(fixture, 'xdg');
  delete process.env.OPENCODE_DB;
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const CODEX_ID = '01a16b49-4d4b-7460-aee8-869cae2029a5';

function writeCodexRollout(fixture: string, cwd: string): void {
  const file = join(
    fixture,
    'codex',
    'sessions',
    '2026',
    '11',
    '03',
    `rollout-2026-11-03T10-00-00-${CODEX_ID}.jsonl`,
  );
  mkdirSync(dirname(file), { recursive: true });
  const records = [
    {
      timestamp: '2026-11-03T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: CODEX_ID,
        timestamp: '2026-11-03T10:00:00.000Z',
        cwd,
        originator: 'codex_cli_rs',
      },
    },
    {
      timestamp: '2026-11-03T10:00:05.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'What Codex calls it' },
    },
  ];
  writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
}

function t3Database(fixture: string): string {
  return join(fixture, 't3', 'userdata', 'statev2.sqlite');
}

test('external-projects:discover lists T3 Code projects with native and history tiers', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-import-golden-')),
  );
  try {
    const repo = join(fixture, 'canopy');
    initRepo(repo);
    writeCodexRollout(fixture, repo);
    buildT3Fixture(t3Database(fixture), {
      projects: [
        { projectId: 'p-canopy', title: 'Canopy', workspaceRoot: repo },
        {
          projectId: 'p-scratch',
          title: 'No project',
          workspaceRoot: join(fixture, 't3', 'scratch'),
        },
      ],
      threads: [
        {
          threadId: 'thread-codex',
          projectId: 'p-canopy',
          title: 'Review the pull request',
          activeProviderThreadId: 'pt-1',
          providerThreads: [
            { providerThreadId: 'pt-1', driver: 'codex', nativeId: CODEX_ID },
          ],
          updatedAt: '2026-11-03T10:00:00.000Z',
        },
        {
          threadId: 'thread-cursor',
          projectId: 'p-canopy',
          title: 'Sketch the layout',
          activeProviderThreadId: 'pt-2',
          providerThreads: [
            { providerThreadId: 'pt-2', driver: 'cursor', nativeId: 'cur-1' },
          ],
          updatedAt: '2026-11-04T10:00:00.000Z',
          archivedAt: '2026-11-05T10:00:00.000Z',
        },
        // Opened and never used: nothing to import, so it is not listed.
        {
          threadId: 'thread-blank',
          projectId: 'p-canopy',
          title: 'Never used',
          messageRows: [],
        },
        { threadId: 'scratch-1', projectId: 'p-scratch', title: 'One' },
        { threadId: 'scratch-2', projectId: 'p-scratch', title: 'Two' },
      ],
    });
    const response = await withProviderStores(fixture, () =>
      discoverHandler()({}, { providers: ['t3code'] }),
    );
    expect(response.providersDetected).toEqual({
      claude: false,
      codex: false,
      t3code: true,
      opencode: false,
    });
    expect(response.diagnostics).toContainEqual({
      source: 't3code',
      message: '2 "No project" chats were skipped.',
    });
    expect(response.candidates).toHaveLength(1);
    const [candidate] = response.candidates;
    expect(candidate).toMatchObject({
      rootPath: repo,
      displayName: 'Canopy',
      providers: ['t3code'],
      surfaces: ['t3-code'],
      status: 'available',
      sessionCount: 2,
    });
    expect(candidate?.sessions).toEqual([
      expect.objectContaining({
        id: 'thread-cursor',
        provider: 't3code',
        title: 'Sketch the layout',
        tier: 'history',
        archived: true,
        continuable: false,
      }),
      expect.objectContaining({
        id: CODEX_ID,
        provider: 't3code',
        title: 'Review the pull request',
        tier: 'native',
        backingProvider: 'codex',
        archived: false,
        continuable: true,
      }),
    ]);
    expect(candidate?.sessions[0]).not.toHaveProperty('backingProvider');
    expect(mockStoreWorker.live).toBe(0);
  } finally {
    resetExternalProjectScanCacheForTests();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('external-projects:discover attributes a shared Codex rollout to T3 once', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-import-golden-')),
  );
  try {
    // Under `work/`, so the Codex root (in the T3 worktree) sorts before
    // the T3 root and the normalizer meets the Codex session first.
    const repo = join(fixture, 'work', 'canopy');
    initRepo(repo);
    const worktree = join(fixture, 't3', 'worktrees', 'canopy', 'feature');
    gitIn(repo, 'worktree', 'add', '-q', '-b', 't3/feature', worktree);
    writeCodexRollout(fixture, worktree);
    buildT3Fixture(t3Database(fixture), {
      projects: [
        { projectId: 'p-canopy', title: 'Canopy', workspaceRoot: repo },
      ],
      threads: [
        {
          threadId: 'thread-codex',
          projectId: 'p-canopy',
          title: 'Review the pull request',
          worktreePath: worktree,
          activeProviderThreadId: 'pt-1',
          providerThreads: [
            { providerThreadId: 'pt-1', driver: 'codex', nativeId: CODEX_ID },
          ],
        },
      ],
    });
    const response = await withProviderStores(fixture, () =>
      discoverHandler()({}, { providers: ['codex', 't3code'] }),
    );
    expect(response.providersDetected).toMatchObject({
      codex: true,
      t3code: true,
    });
    expect(response.candidates).toHaveLength(1);
    const [candidate] = response.candidates;
    expect(candidate).toMatchObject({
      rootPath: repo,
      kind: 'git',
      displayName: 'Canopy',
      providers: ['codex', 't3code'],
      linkedWorktreePaths: [worktree],
      sessionCount: 1,
    });
    expect(candidate?.sessions).toEqual([
      expect.objectContaining({
        id: CODEX_ID,
        provider: 't3code',
        title: 'Review the pull request',
        tier: 'native',
        backingProvider: 'codex',
        continuable: true,
      }),
    ]);
    // The import reads the session the row shows: T3's, backed by the rollout.
    const cached = getCachedExternalProjectScan(response.scanId);
    const importable = cached?.sessionsByCandidate.get(candidate?.id ?? '');
    expect(importable).toEqual([
      expect.objectContaining({
        id: CODEX_ID,
        kind: 't3-thread',
        storeId: 'thread-codex',
      }),
    ]);
    expect(importable?.[0]?.backing).toMatchObject({
      provider: 'codex',
      id: CODEX_ID,
    });
    // Two of four providers is not the whole history.
    expect(mockProfileRefresh).not.toHaveBeenCalled();
    expect(mockStoreWorker.live).toBe(0);

    // A scan of every provider rebuilds the memory profile, which names the
    // conversation once, by T3's title, in T3's project.
    const profile = await withProviderStores(fixture, async () => {
      await discoverHandler()({}, {});
      expect(mockProfileRefresh).toHaveBeenCalledTimes(1);
      const source = mockProfileRefresh.mock.calls[0]?.[0];
      return typeof source === 'function' ? await source() : source;
    });
    expect(profile?.projects).toEqual([{ name: 'Canopy', chatCount: 1 }]);
    expect(profile?.chats.map((chat) => [chat.title, chat.project])).toEqual([
      ['Review the pull request', 'Canopy'],
    ]);
  } finally {
    resetExternalProjectScanCacheForTests();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('external-projects:discover keeps a chat imported through Codex imported after its rollout is gone', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-import-golden-')),
  );
  try {
    const repo = join(fixture, 'canopy');
    initRepo(repo);
    // An earlier import brought the conversation in through Codex's own
    // record, so the ledger knows it only by the native id.
    const candidateId = externalProjectCandidateId(repo);
    await recordExternalProjectImport({
      candidateId,
      workspaceId: 'ws-imported',
      rootPath: repo,
      providers: ['codex'],
    });
    await recordExternalProjectSessionImports({
      candidateId,
      sessions: [
        { sessionId: CODEX_ID, chatId: 'chat-from-codex', worktreeId: 'wt-1' },
      ],
    });
    // Codex has since compressed or deleted the rollout; T3 still lists the
    // thread, which now resolves no native record.
    buildT3Fixture(t3Database(fixture), {
      projects: [
        { projectId: 'p-canopy', title: 'Canopy', workspaceRoot: repo },
      ],
      threads: [
        {
          threadId: 'thread-codex',
          projectId: 'p-canopy',
          title: 'Review the pull request',
          activeProviderThreadId: 'pt-1',
          providerThreads: [
            { providerThreadId: 'pt-1', driver: 'codex', nativeId: CODEX_ID },
          ],
        },
      ],
    });
    const response = await withProviderStores(fixture, () =>
      discoverHandler()({}, { providers: ['codex', 't3code'] }),
    );
    const [candidate] = response.candidates;
    expect(candidate?.id).toBe(candidateId);
    expect(candidate?.sessions).toEqual([
      expect.objectContaining({
        id: 'thread-codex',
        provider: 't3code',
        tier: 'history',
        importedChatId: 'chat-from-codex',
      }),
    ]);
    expect(candidate?.importableSessionCount).toBe(0);
  } finally {
    resetExternalProjectScanCacheForTests();
    rmSync(getExternalProjectImportsFilePath(), { force: true });
    resetExternalProjectImportLedgerForTests();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('external-projects:discover lists OpenCode sessions and hides Canopy-owned ones', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-import-golden-')),
  );
  // Canopy's own chat records its OpenCode session id in a binding file.
  const ownWorkspace = join(getDataDir(), 'workspaces', 'ws-opencode-golden');
  try {
    const repo = join(fixture, 'notes-app');
    initRepo(repo);
    const binding = join(
      ownWorkspace,
      'worktree-data',
      'wt-1',
      'opencode-sessions',
      'profile-1',
      'host-session.json',
    );
    mkdirSync(dirname(binding), { recursive: true });
    writeFileSync(
      binding,
      JSON.stringify({ version: 1, sessionId: 'ses_owned', cwd: repo }),
    );
    buildOpenCodeFixture(join(fixture, 'xdg', 'opencode', 'opencode.db'), {
      projects: [{ id: 'proj-notes', worktree: repo }],
      sessions: [
        {
          id: 'ses_plan',
          projectId: 'proj-notes',
          directory: repo,
          title: 'Plan the migration',
          timeUpdated: 1794426247750,
          timeArchived: 1794426247999,
        },
        {
          id: 'ses_fix',
          projectId: 'proj-notes',
          directory: repo,
          title: 'Fix the flaky test',
          timeUpdated: 1794500000000,
        },
        {
          id: 'ses_owned',
          projectId: 'proj-notes',
          directory: repo,
          title: 'A chat Canopy ran',
        },
        {
          id: 'ses_in_canopy_worktree',
          projectId: 'proj-notes',
          directory: join(ownWorkspace, 'worktrees', 'wt-1'),
          title: 'A chat in a Canopy worktree',
        },
        // Opened and never used: nothing to import, so it is not listed.
        {
          id: 'ses_blank',
          projectId: 'proj-notes',
          directory: repo,
          title: 'Never used',
          messageRows: [],
        },
      ],
    });
    const response = await withProviderStores(fixture, () =>
      discoverHandler()({}, {}),
    );
    expect(response.providersDetected).toEqual({
      claude: false,
      codex: false,
      t3code: false,
      opencode: true,
    });
    expect(response.candidates).toHaveLength(1);
    const [candidate] = response.candidates;
    expect(candidate).toMatchObject({
      rootPath: repo,
      displayName: 'notes-app',
      providers: ['opencode'],
      surfaces: ['opencode'],
      sessionCount: 2,
    });
    expect(candidate?.sessions).toEqual([
      expect.objectContaining({
        id: 'ses_fix',
        provider: 'opencode',
        title: 'Fix the flaky test',
        archived: false,
        continuable: false,
      }),
      expect.objectContaining({
        id: 'ses_plan',
        provider: 'opencode',
        title: 'Plan the migration',
        archived: true,
        continuable: false,
      }),
    ]);
    expect(candidate?.sessions[0]).not.toHaveProperty('tier');
    // Every provider was asked for, so the whole history was read.
    expect(mockProfileRefresh).toHaveBeenCalledTimes(1);
    expect(mockStoreWorker.live).toBe(0);
  } finally {
    resetExternalProjectScanCacheForTests();
    rmSync(fixture, { recursive: true, force: true });
    rmSync(ownWorkspace, { recursive: true, force: true });
  }
});

test('external-projects:discover lists sessions of the OpenCode global project by folder', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-import-golden-')),
  );
  try {
    // OpenCode files every session started outside a repository under one
    // global project rooted at the filesystem root.
    const repo = join(fixture, 'scripts-repo');
    initRepo(repo);
    const folder = join(fixture, 'notes');
    mkdirSync(folder);
    const filesystemRoot = parse(fixture).root;
    buildOpenCodeFixture(join(fixture, 'xdg', 'opencode', 'opencode.db'), {
      projects: [{ id: 'global', worktree: filesystemRoot, vcs: null }],
      sessions: [
        {
          id: 'ses_repo',
          projectId: 'global',
          directory: repo,
          title: 'Write the release script',
        },
        {
          id: 'ses_notes',
          projectId: 'global',
          directory: folder,
          title: 'Outline the talk',
        },
        {
          id: 'ses_root',
          projectId: 'global',
          directory: filesystemRoot,
          title: 'Started at the root',
        },
      ],
    });
    const response = await withProviderStores(fixture, () =>
      discoverHandler()({}, { providers: ['opencode'] }),
    );
    const byRoot = new Map(
      response.candidates.map((candidate) => [candidate.rootPath, candidate]),
    );
    expect(byRoot.get(repo)).toMatchObject({
      kind: 'git',
      providers: ['opencode'],
      sessions: [expect.objectContaining({ id: 'ses_repo' })],
    });
    expect(byRoot.get(folder)).toMatchObject({
      kind: 'folder',
      providers: ['opencode'],
      sessions: [expect.objectContaining({ id: 'ses_notes' })],
    });
    expect(byRoot.has(filesystemRoot)).toBe(false);
    expect(response.diagnostics).toContainEqual(
      expect.objectContaining({
        message: '1 OpenCode chat started outside any folder was skipped.',
      }),
    );
  } finally {
    resetExternalProjectScanCacheForTests();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('external-projects:import skips an empty OpenCode session for good and gives its budget to an older chat', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-import-golden-')),
  );
  const runner = new StoreReadRunner();
  try {
    const dbPath = join(fixture, 'xdg', 'opencode', 'opencode.db');
    const chat = (id: string): OpenCodeFixtureMessage[] => [
      {
        id: `${id}_u`,
        type: 'user',
        seq: 0,
        data: { text: 'Plan the release' },
      },
      {
        id: `${id}_a`,
        type: 'assistant',
        seq: 1,
        data: { content: [{ type: 'text', text: 'Here is the plan.' }] },
      },
    ];
    buildOpenCodeFixture(dbPath, {
      projects: [{ id: 'proj', worktree: fixture }],
      sessions: [
        // Started and never used: OpenCode recorded no message to show.
        {
          id: 'ses_empty',
          projectId: 'proj',
          directory: fixture,
          messageRows: [{ id: 'idle', type: 'idle', seq: 0, data: {} }],
        },
        {
          id: 'ses_mid',
          projectId: 'proj',
          directory: fixture,
          messageRows: chat('ses_mid'),
        },
        {
          id: 'ses_old',
          projectId: 'proj',
          directory: fixture,
          messageRows: chat('ses_old'),
        },
      ],
    });
    // Sizes as discovery would carry them: together over the 128 MiB scope
    // budget, so the oldest chat starts out over budget.
    const MiB = 1024 * 1024;
    const session = (id: string, day: number): DiscoveredSession => ({
      id,
      storeId: id,
      provider: 'opencode',
      surface: 'opencode',
      kind: 'opencode-session',
      cwd: fixture,
      sourcePath: dbPath,
      title: id,
      startedAt: null,
      lastActivityAt: `2026-11-0${day}T10:00:00.000Z`,
      sizeBytes: 45 * MiB,
      native: true,
    });
    const plan = planChatImports(
      [session('ses_old', 1), session('ses_mid', 2), session('ses_empty', 3)],
      {},
    );
    expect(plan.entries.map((entry) => entry.status)).toEqual([
      'admitted',
      'admitted',
      'over-budget',
    ]);
    const outcome: ChatImportOutcome = {
      chatsImported: 0,
      chatsReadOnly: 0,
      chatsSkipped: 0,
      retryableSkips: 0,
      messages: [],
      imported: [],
    };
    const prepared = await prepareChatImports({
      plan,
      runner,
      cwd: join(fixture, 'dest'),
      attachmentsDir: join(fixture, 'attachments'),
      outcome,
      onProgress: () => undefined,
    });
    expect(prepared.map((entry) => entry.session.id)).toEqual([
      'ses_mid',
      'ses_old',
    ]);
    expect(prepared.map((entry) => entry.tab.importedFrom)).toEqual([
      'opencode',
      'opencode',
    ]);
    // Reported, but not offered for retry: a second run would find it empty too.
    expect(outcome).toMatchObject({ chatsSkipped: 1, retryableSkips: 0 });
    expect(outcome.messages).toEqual([
      'Skipped "ses_empty": no messages to import.',
    ]);
  } finally {
    await runner.close();
    rmSync(fixture, { recursive: true, force: true });
  }
  expect(mockStoreWorker.live).toBe(0);
});

test('external-projects:provider-presence names the tools whose stores hold chats', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-import-golden-')),
  );
  try {
    const repo = join(fixture, 'canopy');
    initRepo(repo);
    buildT3Fixture(t3Database(fixture), {
      projects: [
        { projectId: 'p-canopy', title: 'Canopy', workspaceRoot: repo },
      ],
      threads: [
        {
          threadId: 'thread-grok',
          projectId: 'p-canopy',
          title: 'Sketch the layout',
        },
      ],
    });
    const presence = await withProviderStores(fixture, () =>
      registeredHandler(IPC_CHANNELS.externalProjectsProviderPresence)({}, {}),
    );
    expect(presence).toEqual({
      providerStoresPresent: true,
      providers: { claude: false, codex: false, t3code: true, opencode: false },
    });
    // The probe opened T3 Code's live store and left nothing beside it.
    expect(readdirSync(dirname(t3Database(fixture)))).toEqual([
      'statev2.sqlite',
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('external-projects:import refuses a scan that is no longer cached', async () => {
  resetExternalProjectScanCacheForTests();
  await expect(
    registeredHandler(IPC_CHANNELS.externalProjectsImport)(
      {},
      {
        scanId: 'scan-gone',
        selections: [{ candidateId: 'ext-gone', importChats: true }],
      },
    ),
  ).rejects.toThrow('This scan is no longer available');
  // Nothing was opened for a refused request.
  expect(mockStoreWorker.live).toBe(0);
});
