import './fixtures/w5-boundary-daemon-cleanup';
import type * as LegacyStorage from './fixtures/w5-legacy-storage';
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<typeof LegacyStorage>('./fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
/**
 * Keyed plugin user changes (CAN-4409) against a workspace deletion, through
 * the real `deleteWorkspace` (non-Cowork and Cowork branches), the real keyed
 * `updateWorkspacePlugins` and the real commit-log worker. The deletion is
 * held after its final `fs.rmdir` of the workspace directory, before its own
 * plugin defaults refresh, which always advances the session revision.
 */
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import type * as FsPromises from 'node:fs/promises';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as CostLifecycle from '../../cost-index/lifecycle';
import type {
  ArchiveIoOperationRequest,
  ArchiveIoResultMap,
  ArchiveIoOperationType,
} from '../../archive/archive-io-protocol';
import type * as ArchiveEngine from '../../archive/archive-io-engine';

/** A hold on the deletion right after its directory removal. */
const mockRemoval: {
  target?: string;
  reached?: () => void;
  gate?: Promise<void>;
} = {};

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    rmdir: async (...args: Parameters<typeof actual.rmdir>): Promise<void> => {
      await actual.rmdir(...args);
      if (mockRemoval.target !== undefined && args[0] === mockRemoval.target) {
        mockRemoval.target = undefined;
        mockRemoval.reached?.();
        await mockRemoval.gate;
      }
    },
  };
});
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../auto-archive-teardown', () => ({
  runAutoArchiveTeardown: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() => Promise.resolve('retirement')),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
    cancelLocalWorkspace: jest.fn(() => Promise.resolve()),
    commitLocalWorkspaceCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalWorkspaceFence: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorkspaceDocs: jest.fn(() => Promise.resolve()),
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
    worktreeContainerArchived: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
}));
// Same archive and cost stand-ins as w5-destructive-recovery.test.ts.
jest.mock('../../archive/archive-io-runner', () => ({
  runArchiveIoRequest: (
    request: ArchiveIoOperationRequest,
  ): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> =>
    jest
      .requireActual<typeof ArchiveEngine>('../../archive/archive-io-engine')
      .executeArchiveIoRequest(request, new AbortController().signal, {
        progress: () => {},
        child: { started: () => {}, exited: () => {} },
      }),
}));
jest.mock('../../cost-index/lifecycle', () => ({
  ...jest.requireActual<typeof CostLifecycle>('../../cost-index/lifecycle'),
  prepareEntryCostArchive: jest.fn(() => Promise.resolve()),
  finishEntryCostArchive: jest.fn(() => Promise.resolve()),
}));
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
    interruptMatchingEntries: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  desktopW5FileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import * as workspacePersistence from '../workspace-persistence';
import {
  readProjectPluginDefaults,
  updateWorkspaceConfig,
} from '../workspace-persistence';
import * as pluginDefaultsCache from '../../plugins/project-plugin-defaults-cache';
import { getProjectPluginDefaultsRevision } from '../../plugins/plugin-defaults-revision';
import { getWorkspaceConfigPath, getWorkspaceDir } from '../paths';
import { deleteWorkspace } from '../workspace-deletion';
import type { WorkspaceDeletionSource } from '../workspace-deletion';
import {
  __pluginDefaultsHandOffsForTests,
  __setInlinePluginDefaultsReconcileBoundForTests,
  updateWorkspacePlugins,
  type WorkspacePluginsUpdateOutcome,
  type WorkspacePluginsUserChange,
} from '../workspace-plugin-defaults';

jest.setTimeout(60_000);

let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let workspaceId = 'a';
const originalWatcherFactory = jest
  .mocked(getAppAdvisorWatcherService)
  .getMockImplementation();

function selections(pluginName: string): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [{ marketplaceId: 'm', pluginName }],
  };
}
const OLD = selections('old');
const NEW = selections('new');
const SET_NEW: WorkspacePluginsUserChange = {
  kind: 'setDefaults',
  defaultPluginSelections: NEW,
};
const SELECT_RECOMMENDED: WorkspacePluginsUserChange = {
  kind: 'selectRecommended',
  selections: [{ kind: 'plugin', marketplaceId: 'm', pluginName: 'rec' }],
  optOutKeys: [],
  clearOptOutKeys: [],
};

/** Every barrier a test opened or not, opened after it so a failure cannot hang. */
let barriers: Array<() => void> = [];

function barrier(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  barriers.push(open);
  return { promise, open };
}

/** Holds the deletion after its final `fs.rmdir` of the workspace directory. */
function holdDirectoryRemoval(): {
  reached: Promise<void>;
  release: () => void;
} {
  const reached = barrier();
  const gate = barrier();
  mockRemoval.target = getWorkspaceDir(workspaceId);
  mockRemoval.reached = reached.open;
  mockRemoval.gate = gate.promise;
  return { reached: reached.promise, release: gate.open };
}

const revision = (): number => getProjectPluginDefaultsRevision(workspaceId);

/** What a session created now would carry: its revision and layer. */
let sessions: { label: string; revision: number; layer: string }[] = [];

function layerName(value: ChatTabPluginSelections | undefined): string {
  if (!value) return 'none';
  return JSON.stringify(normalizePluginSelections(value));
}

/** As in production, the revision is stamped before the layer is read. */
async function createSession(label: string): Promise<string> {
  const stamped = revision();
  const { defaultPluginSelections } =
    await readProjectPluginDefaults(workspaceId);
  const layer = layerName(defaultPluginSelections);
  sessions.push({ label, revision: stamped, layer });
  return layer;
}

/**
 * Sessions reused stale: a session created at one point is reused at any
 * later point with the same revision, where a new session gets another layer.
 */
function staleReuse(): string[] {
  return sessions.flatMap((created, index) =>
    sessions
      .slice(index + 1)
      .filter(
        (later) =>
          later.revision === created.revision && later.layer !== created.layer,
      )
      .map((later) => `${created.label} -> ${later.label}`),
  );
}

function update(
  change: WorkspacePluginsUserChange,
  idempotencyKey: string,
): Promise<WorkspacePluginsUpdateOutcome> {
  return updateWorkspacePlugins({
    workspaceId,
    change,
    source:
      change.kind === 'setDefaults'
        ? 'project_settings'
        : 'recommended_plugins',
    idempotencyKey,
  });
}

function startHost(
  workerEntry = join(__dirname, 'fixtures/w5-commit-log-source-worker.ts'),
): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'data', 'w5', 'commit-log.sqlite'),
    root,
    workerEntry,
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

function setup(kind: 'single-repo' | 'cowork'): void {
  resetChatStateServiceForTests();
  if (!originalWatcherFactory)
    throw new Error('Watcher fixture factory missing');
  jest
    .mocked(getAppAdvisorWatcherService)
    .mockImplementation(originalWatcherFactory);
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [{ id: 'one', branchName: 'old', createdAt }],
    ['b'],
  ));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  if (kind === 'cowork') {
    workspaceId = 'c';
    mkdirSync(join(root, 'c'));
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'a',
            name: 'Original',
            type: 'single-repo',
            color: '#7C3AED',
            collapsed: false,
            order: 0,
          },
          {
            id: 'c',
            name: 'Cowork',
            type: 'cowork',
            color: '#7C3AED',
            collapsed: false,
            order: 1,
          },
        ],
      }),
    );
    writeFileSync(
      join(root, 'c', 'workspace.json'),
      JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
    );
  } else {
    workspaceId = 'a';
    execFileSync('git', [
      '-C',
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      'old',
      join(root, 'a', 'worktrees', 'one'),
    ]);
  }
  startHost();
  jest.clearAllMocks();
  sessions = [];
}

afterEach(async () => {
  __setInlinePluginDefaultsReconcileBoundForTests(undefined);
  mockRemoval.target = undefined;
  for (const open of barriers) open();
  barriers = [];
  await Promise.all(deletions);
  deletions = [];
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

/** Deletions a test started, settled after it. */
let deletions: Promise<unknown>[] = [];

function startDeletion(source: WorkspaceDeletionSource): Promise<unknown> {
  const deletion = deleteWorkspace({ workspaceId, source });
  deletions.push(deletion.catch(() => undefined));
  return deletion;
}

async function seed(): Promise<void> {
  await updateWorkspaceConfig(workspaceId, (config): void => {
    config.defaultPluginSelections = OLD;
  });
}

/**
 * The next plugins decision lands and its response is lost, or the worker
 * fails before deciding it. Its attempt's reconcile read fails, finds the
 * manifest unreadable, or reads it as it is.
 */
function loseNextResponse(
  reconcileRead: 'fails' | 'is unreadable' | 'as it is',
  decision: 'lands' | 'never lands' = 'lands',
): void {
  const commit = host.commit.bind(host);
  let failed = false;
  const commits = jest.spyOn(host, 'commit');
  commits.mockImplementation(async (request) => {
    if (request.operation !== 'core.workspace.plugins.update')
      return commit(request);
    commits.mockImplementation(commit);
    if (decision === 'lands') await commit(request);
    failed = true;
    throw new Error(
      decision === 'lands' ? 'response lost' : 'worker died before decision',
    );
  });
  const readDetailed = workspacePersistence.readWorkspaceConfigDetailed;
  jest
    .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
    .mockImplementation((id) => {
      if (!failed || reconcileRead === 'as it is') return readDetailed(id);
      failed = false;
      if (reconcileRead === 'fails')
        return Promise.reject(new Error('read failed'));
      return readDetailed(id).then((read) => ({
        ...read,
        authority: 'unreadable' as const,
      }));
    });
}

/** A key no earlier test used: the owed-refresh marks live for the process. */
let keySequence = 0;
function freshKey(): string {
  keySequence += 1;
  return `owed-${String(keySequence)}`;
}

describe.each(['single-repo', 'cowork'] as const)('%s deletion', (kind) => {
  beforeEach(() => setup(kind));

  it('reconciles a real worker exit after deletion while an old session read is in flight', async () => {
    await seed();
    expect(await createSession('before deletion')).toBe(layerName(OLD));
    const before = revision();
    await host.shutdown();
    startHost(join(__dirname, 'fixtures/w5-delete-exit-worker.ts'));
    const loaded = barrier();
    const release = barrier();
    pluginDefaultsCache.projectPluginDefaultsWritten({
      configPath: getWorkspaceConfigPath(workspaceId),
      workspaceId,
      layerChanged: false,
    });
    const readThrough = pluginDefaultsCache.readThroughProjectPluginDefaults;
    jest
      .spyOn(pluginDefaultsCache, 'readThroughProjectPluginDefaults')
      .mockImplementationOnce((configPath, load) =>
        readThrough(configPath, async () => {
          const read = await load();
          loaded.open();
          await release.promise;
          return read;
        }),
      );
    const inFlight = createSession('old read in flight');
    await loaded.promise;

    await expect(startDeletion('shared_container_fork')).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    expect(existsSync(getWorkspaceConfigPath(workspaceId))).toBe(false);
    expect(revision()).toBe(before);
    expect(__pluginDefaultsHandOffsForTests(workspaceId)).toBe(1);
    release.open();
    expect(await inFlight).toBe(layerName(OLD));
    await settleDetachedWork();

    expect(host.recoveredWorker).toBeGreaterThan(1);
    expect(__pluginDefaultsHandOffsForTests(workspaceId)).toBe(0);
    expect(revision()).toBe(before + 1);
    expect(await createSession('after worker recovery')).toBe('none');
    await settleDetachedWork();
    expect(revision()).toBe(before + 1);
    expect(staleReuse()).toEqual([]);
  });

  it('keeps removal reconciliation owed through repeated unavailable reads and a concurrent replay', async () => {
    await seed();
    const key = freshKey();
    const saved = await update(SET_NEW, key);
    expect(await createSession('before deletion')).toBe(layerName(NEW));
    const before = revision();
    const configPath = getWorkspaceConfigPath(workspaceId);
    const commit = host.commit.bind(host);
    let responseLost = false;
    let available = false;
    const read = desktopW5FileStore.read.bind(desktopW5FileStore);
    jest.spyOn(desktopW5FileStore, 'read').mockImplementation((path) => {
      if (path === configPath && responseLost && !available)
        return Promise.resolve({ state: 'unreadable' });
      return read(path);
    });
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      const result = await commit(request);
      if (
        request.operation === 'core.workspace.delete' &&
        request.files.some((file) => file.path === configPath)
      ) {
        responseLost = true;
        throw new Error('deletion response lost');
      }
      return result;
    });
    await expect(startDeletion('shared_container_fork')).rejects.toThrow(
      'deletion response lost',
    );
    await settleDetachedWork();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await readProjectPluginDefaults(workspaceId)).toEqual({
        defaultPluginSelections: undefined,
        disabledGlobalPluginSelections: undefined,
      });
      await expect(update(SET_NEW, key)).resolves.toEqual(saved);
      await settleDetachedWork();
      expect(revision()).toBe(before);
      expect(__pluginDefaultsHandOffsForTests(workspaceId)).toBe(1);
    }

    available = true;
    await Promise.all([
      update(SET_NEW, key),
      readProjectPluginDefaults(workspaceId),
    ]);
    await settleDetachedWork();
    expect(__pluginDefaultsHandOffsForTests(workspaceId)).toBe(0);
    expect(revision()).toBe(before + 1);
    expect(await createSession('after authority recovery')).toBe('none');
    await update(SET_NEW, key);
    await settleDetachedWork();
    expect(revision()).toBe(before + 1);
    expect(staleReuse()).toEqual([]);
  });

  it.each(['readable', 'unreadable', 'failed', 'never applied'] as const)(
    'reconciles a lost deletion response with storage %s',
    async (storage) => {
      await seed();
      expect(await createSession('before deletion')).toBe(layerName(OLD));
      const before = revision();
      const configPath = getWorkspaceConfigPath(workspaceId);
      const commit = host.commit.bind(host);
      let responseLost = false;
      let storageAvailable =
        storage === 'readable' || storage === 'never applied';
      const read = desktopW5FileStore.read.bind(desktopW5FileStore);
      jest.spyOn(desktopW5FileStore, 'read').mockImplementation((path) => {
        if (path === configPath && responseLost && !storageAvailable) {
          if (storage === 'failed') return Promise.reject(new Error('offline'));
          return Promise.resolve({ state: 'unreadable' });
        }
        return read(path);
      });
      jest.spyOn(host, 'commit').mockImplementation(async (request) => {
        if (
          request.operation !== 'core.workspace.delete' ||
          !request.files.some((file) => file.path === configPath)
        )
          return commit(request);
        if (storage !== 'never applied') await commit(request);
        responseLost = true;
        throw new Error('deletion response lost');
      });

      await expect(startDeletion('shared_container_fork')).rejects.toThrow(
        'deletion response lost',
      );
      expect(responseLost).toBe(true);
      await settleDetachedWork();
      expect(existsSync(configPath)).toBe(storage === 'never applied');
      if (!storageAvailable) {
        // Neither an unreadable authority nor a thrown read proves removal.
        expect(revision()).toBe(before);
        storageAvailable = true;
        // Reads must bypass the old cached layer and retry the owed refresh.
        expect(await readProjectPluginDefaults(workspaceId)).toEqual({
          defaultPluginSelections: undefined,
          disabledGlobalPluginSelections: undefined,
        });
        await settleDetachedWork();
      }
      expect(revision()).toBe(before + (storage === 'never applied' ? 0 : 1));
      expect(await createSession('after reconciliation')).toBe(
        storage === 'never applied' ? layerName(OLD) : 'none',
      );
      await settleDetachedWork();
      expect(revision()).toBe(before + (storage === 'never applied' ? 0 : 1));
      expect(staleReuse()).toEqual([]);
    },
  );

  // Rollback sources tear down no non-Cowork session, so a session created
  // before the deletion survives it.
  it.each<[string, WorkspaceDeletionSource, WorkspacePluginsUserChange]>([
    ['setDefaults', 'multi_repo_workspace_delete', SET_NEW],
    ['setDefaults', 'shared_container_fork', SET_NEW],
    ['setDefaults', 'org-member-multi-repo-create', SET_NEW],
    ['selectRecommended', 'multi_repo_workspace_delete', SELECT_RECOMMENDED],
  ])(
    'a %s same-key replay between the removal and the deletion refresh (source %s) repeats nothing: the deletion advances the revision once',
    async (_name, source, change) => {
      await seed();
      await createSession('before the save');
      const saved = await update(change, 'key');
      expect(saved.written).toBe(true);
      const saveLayer = await createSession('after the save (survives)');
      const afterSave = revision();
      const gap = holdDirectoryRemoval();
      const deletion = startDeletion(source);
      await gap.reached;
      expect(existsSync(getWorkspaceConfigPath(workspaceId))).toBe(false);
      await createSession('in the gap, before the replay');
      const commits = jest.spyOn(host, 'commit');
      await expect(update(change, 'key')).resolves.toEqual(saved);
      expect(commits).not.toHaveBeenCalled();
      expect(existsSync(getWorkspaceDir(workspaceId))).toBe(false);
      expect(revision()).toBe(afterSave);
      // Like an unkeyed retry, which is refused: the deletion refresh drops it.
      expect(await createSession('in the gap, after the replay')).toBe(
        saveLayer,
      );
      gap.release();
      await deletion;
      expect(revision()).toBe(afterSave + 1);
      expect(await createSession('after the deletion')).toBe('none');
      await expect(update(change, 'key')).resolves.toEqual(saved);
      expect(revision()).toBe(afterSave + 1);
      await createSession('after a replay after the deletion');
      expect(commits).not.toHaveBeenCalled();
      expect(staleReuse()).toEqual([]);
      const survivor = sessions.find(
        (session) => session.label === 'after the save (survives)',
      );
      expect(survivor?.revision).toBeLessThan(revision());
    },
  );

  it('a same-key replay in the gap with no session since the save advances nothing; the deletion advances once', async () => {
    await seed();
    const saved = await update(SET_NEW, 'key');
    const afterSave = revision();
    const gap = holdDirectoryRemoval();
    const deletion = startDeletion('multi_repo_workspace_delete');
    await gap.reached;
    await expect(update(SET_NEW, 'key')).resolves.toEqual(saved);
    expect(revision()).toBe(afterSave);
    gap.release();
    await deletion;
    expect(revision()).toBe(afterSave + 1);
    expect(await createSession('after the deletion')).toBe('none');
  });

  // The attempt's own reconcile, unlike a replay, stands in for its dropped
  // refresh, so it still advances when it reads after the removal.
  it('an attempt whose response was lost reconciles after the removal: one advance replaces its dropped refresh', async () => {
    // The reconcile waits on the held read while the deletion runs to its
    // gap, which a real worker can take longer than the inline bound.
    __setInlinePluginDefaultsReconcileBoundForTests({
      passes: 4,
      deadlineMs: 60_000,
    });
    await seed();
    const gap = holdDirectoryRemoval();
    const decided = barrier();
    const respond = barrier();
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      if (request.operation !== 'core.workspace.plugins.update')
        return commit(request);
      await commit(request);
      decided.open();
      await respond.promise;
      throw new Error('response lost');
    });
    const reconcileReads: boolean[] = [];
    const readDetailed = workspacePersistence.readWorkspaceConfigDetailed;
    jest
      .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
      .mockImplementation((id) => {
        if (id === workspaceId)
          reconcileReads.push(existsSync(getWorkspaceConfigPath(workspaceId)));
        return readDetailed(id);
      });
    // A session read in flight, which the reconcile waits for.
    const loadReached = barrier();
    const loadGate = barrier();
    const readThrough = pluginDefaultsCache.readThroughProjectPluginDefaults;
    jest
      .spyOn(pluginDefaultsCache, 'readThroughProjectPluginDefaults')
      .mockImplementationOnce((configPath, load) =>
        readThrough(configPath, async () => {
          const read = await load();
          loadReached.open();
          await loadGate.promise;
          return read;
        }),
      );
    const attempt = update(SET_NEW, 'key');
    const rejected = expect(attempt).rejects.toThrow('response lost');
    await decided.promise;
    const afterDecision = revision();
    const inFlight = createSession('read in flight');
    await loadReached.promise;
    const deletion = startDeletion('multi_repo_workspace_delete');
    respond.open();
    await gap.reached;
    reconcileReads.length = 0;
    loadGate.open();
    await rejected;
    await inFlight;
    // The reconcile read the removed manifest.
    expect(reconcileReads).toEqual([false]);
    expect(revision()).toBe(afterDecision + 1);
    expect(await createSession('in the gap, after the attempt')).toBe('none');
    gap.release();
    await deletion;
    expect(revision()).toBe(afterDecision + 2);
    expect(await createSession('after the deletion')).toBe('none');
    expect(staleReuse()).toEqual([]);
  });

  // A replay in the gap still stands in for a refresh its own attempt may
  // have dropped: reads at the revision served a layer from before its save.
  it.each<[string, string, WorkspaceDeletionSource, 'fails' | 'is unreadable']>(
    [
      [
        'failed',
        'multi_repo_workspace_delete',
        'multi_repo_workspace_delete',
        'fails',
      ],
      ['failed', 'shared_container_fork', 'shared_container_fork', 'fails'],
      [
        'found it unreadable',
        'multi_repo_workspace_delete',
        'multi_repo_workspace_delete',
        'is unreadable',
      ],
    ],
  )(
    'after a lost response whose reconcile read %s, a same-key replay in the gap (source %s) advances once for it',
    async (_name, _source, source, reconcileRead) => {
      await seed();
      await createSession('before the save');
      const before = revision();
      const key = freshKey();
      loseNextResponse(reconcileRead);
      await expect(update(SET_NEW, key)).rejects.toThrow('response lost');
      expect(revision()).toBe(before);
      expect(await createSession('after the attempt')).toBe(layerName(NEW));
      const gap = holdDirectoryRemoval();
      const deletion = startDeletion(source);
      await gap.reached;
      await expect(update(SET_NEW, key)).resolves.toMatchObject({
        written: true,
      });
      expect(revision()).toBe(before + 1);
      expect(await createSession('in the gap, after the replay')).toBe('none');
      gap.release();
      await deletion;
      expect(revision()).toBe(before + 2);
      await update(SET_NEW, key);
      expect(revision()).toBe(before + 2);
      // Only the pair from before the replay, which no replay can undo.
      expect(staleReuse()).toEqual(['before the save -> after the attempt']);
    },
  );

  // Its reconcile read a later change, not its own selections: still decided,
  // since reads recover the commit log first, so nothing is owed.
  it('after a lost response whose reconcile read a later change, a same-key replay in the gap advances nothing', async () => {
    await seed();
    const key = freshKey();
    const LATER = selections('later');
    const commit = host.commit.bind(host);
    const thrown = barrier();
    // A read in flight, which the reconcile waits for, loading only once the
    // later change landed.
    const loadGate = barrier();
    let inFlight: Promise<string> | undefined;
    const readThrough = pluginDefaultsCache.readThroughProjectPluginDefaults;
    const commits = jest.spyOn(host, 'commit');
    commits.mockImplementation(async (request) => {
      if (request.operation !== 'core.workspace.plugins.update')
        return commit(request);
      commits.mockImplementation(commit);
      await commit(request);
      jest
        .spyOn(pluginDefaultsCache, 'readThroughProjectPluginDefaults')
        .mockImplementationOnce((configPath, load) =>
          readThrough(configPath, async () => {
            await loadGate.promise;
            return load();
          }),
        );
      inFlight = createSession('read in flight across the later change');
      thrown.open();
      throw new Error('response lost');
    });
    const reads: string[] = [];
    const readDetailed = workspacePersistence.readWorkspaceConfigDetailed;
    jest
      .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
      .mockImplementation(async (id) => {
        const read = await readDetailed(id);
        reads.push(layerName(read.config.defaultPluginSelections));
        return read;
      });
    const before = revision();
    const rejected = expect(update(SET_NEW, key)).rejects.toThrow(
      'response lost',
    );
    await thrown.promise;
    await expect(
      updateWorkspacePlugins({
        workspaceId,
        change: { kind: 'setDefaults', defaultPluginSelections: LATER },
        source: 'project_settings',
      }),
    ).resolves.toMatchObject({ written: true });
    loadGate.open();
    await rejected;
    expect(await inFlight).toBe(layerName(LATER));
    // The attempt's reconcile read the later change, which refreshed itself.
    expect(reads.at(-1)).toBe(layerName(LATER));
    const afterChanges = revision();
    expect(afterChanges).toBe(before + 1);
    expect(await createSession('after the later change')).toBe(
      layerName(LATER),
    );
    const gap = holdDirectoryRemoval();
    const deletion = startDeletion('multi_repo_workspace_delete');
    await gap.reached;
    await expect(update(SET_NEW, key)).resolves.toMatchObject({
      written: true,
    });
    expect(revision()).toBe(afterChanges);
    gap.release();
    await deletion;
    expect(revision()).toBe(afterChanges + 1);
    expect(staleReuse()).toEqual([]);
  });

  // Once a reconcile read the landed decision, nothing is owed: a layer
  // served after a later change is the deletion's to refresh.
  it.each<[string, boolean]>([
    ['its attempt reconciled', false],
    ['a replay reconciled before the deletion', true],
  ])(
    'after a lost response %s, a later change, then a same-key replay in the gap advances nothing',
    async (_name, replayFirst) => {
      await seed();
      const key = freshKey();
      loseNextResponse(replayFirst ? 'fails' : 'as it is');
      await expect(update(SET_NEW, key)).rejects.toThrow('response lost');
      if (replayFirst) await update(SET_NEW, key);
      await update(
        {
          kind: 'setDefaults',
          defaultPluginSelections: selections('later'),
        },
        freshKey(),
      );
      const afterChanges = revision();
      await createSession('after the later change');
      const gap = holdDirectoryRemoval();
      const deletion = startDeletion('multi_repo_workspace_delete');
      await gap.reached;
      await update(SET_NEW, key);
      expect(revision()).toBe(afterChanges);
      gap.release();
      await deletion;
      expect(revision()).toBe(afterChanges + 1);
      expect(staleReuse()).toEqual([]);
    },
  );

  // A later change follows the landing, so its advance settles what the
  // failed reconcile left owed.
  it.each<['fails' | 'is unreadable']>([['fails'], ['is unreadable']])(
    'after a lost response whose reconcile read %s, a later layer change, then a same-key replay in the gap advances nothing',
    async (reconcileRead) => {
      await seed();
      const key = freshKey();
      loseNextResponse(reconcileRead);
      await expect(update(SET_NEW, key)).rejects.toThrow('response lost');
      const afterAttempt = revision();
      await update(
        { kind: 'setDefaults', defaultPluginSelections: selections('later') },
        freshKey(),
      );
      const afterChanges = revision();
      expect(afterChanges).toBe(afterAttempt + 1);
      expect(await createSession('after the later change')).toBe(
        layerName(selections('later')),
      );
      const gap = holdDirectoryRemoval();
      const deletion = startDeletion('multi_repo_workspace_delete');
      await gap.reached;
      await expect(update(SET_NEW, key)).resolves.toMatchObject({
        written: true,
      });
      expect(revision()).toBe(afterChanges);
      gap.release();
      await deletion;
      expect(revision()).toBe(afterChanges + 1);
      expect(staleReuse()).toEqual([]);
    },
  );

  // A write that leaves the layer alone drops the cached layer without an
  // advance, so a gap read serves the empty layer beside the saved one: the
  // deletion's own pair, which its refresh ends, not a refresh owed here.
  it.each<[string, 'as it is' | 'fails', boolean]>([
    ['its attempt reconciled', 'as it is', false],
    ['a replay reconciled before the deletion', 'fails', true],
  ])(
    'after a lost response %s, a write leaving the layer alone, then a same-key replay in the gap after a gap read advances nothing',
    async (_name, reconcileRead, replayFirst) => {
      await seed();
      const key = freshKey();
      loseNextResponse(reconcileRead);
      await expect(update(SET_NEW, key)).rejects.toThrow('response lost');
      if (replayFirst) await update(SET_NEW, key);
      const afterSave = revision();
      expect(await createSession('after the save')).toBe(layerName(NEW));
      await updateWorkspaceConfig(workspaceId, (config): void => {
        config.itemSortMode = 'manual';
      });
      expect(revision()).toBe(afterSave);
      const gap = holdDirectoryRemoval();
      const deletion = startDeletion('multi_repo_workspace_delete');
      await gap.reached;
      expect(await createSession('in the gap')).toBe('none');
      await update(SET_NEW, key);
      expect(revision()).toBe(afterSave);
      gap.release();
      await deletion;
      expect(revision()).toBe(afterSave + 1);
      expect(staleReuse()).toEqual(['after the save -> in the gap']);
    },
  );

  // A key that runs again never landed before, so its run clears the mark.
  it('a key whose attempt died before its decision, resolved and applied, then replayed in the gap after a later change advances nothing', async () => {
    await seed();
    const key = freshKey();
    loseNextResponse('fails', 'never lands');
    await expect(update(SET_NEW, key)).rejects.toThrow(
      'worker died before decision',
    );
    jest.restoreAllMocks();
    await expect(update(SET_NEW, key)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    await host.shutdown();
    const cold = W5CommitLog.open(join(dir, 'data', 'w5', 'commit-log.sqlite'));
    try {
      for (const reservation of cold.listReservations())
        if (reservation.state === 'recovery-required')
          cold.resolveRecovery(reservation.reservationId);
    } finally {
      cold.close();
    }
    startHost();
    const beforeApply = revision();
    const commits = jest.spyOn(host, 'commit');
    await expect(update(SET_NEW, key)).resolves.toMatchObject({
      written: true,
    });
    expect(commits).toHaveBeenCalledTimes(1);
    expect(revision()).toBe(beforeApply + 1);
    await update(
      { kind: 'setDefaults', defaultPluginSelections: selections('later') },
      freshKey(),
    );
    const afterChanges = revision();
    await createSession('after the later change');
    const gap = holdDirectoryRemoval();
    const deletion = startDeletion('multi_repo_workspace_delete');
    await gap.reached;
    await update(SET_NEW, key);
    expect(revision()).toBe(afterChanges);
    gap.release();
    await deletion;
    expect(revision()).toBe(afterChanges + 1);
    expect(staleReuse()).toEqual([]);
  });

  // A run that leaves the layer alone advances nothing, so only the run
  // itself clears the mark.
  it('a key whose attempt to re-save its layer died before its decision, resolved and run again, then replayed in the gap after a gap read advances nothing', async () => {
    await updateWorkspaceConfig(workspaceId, (config): void => {
      config.defaultPluginSelections = NEW;
    });
    const key = freshKey();
    loseNextResponse('fails', 'never lands');
    await expect(update(SET_NEW, key)).rejects.toThrow(
      'worker died before decision',
    );
    jest.restoreAllMocks();
    await expect(update(SET_NEW, key)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    await host.shutdown();
    const cold = W5CommitLog.open(join(dir, 'data', 'w5', 'commit-log.sqlite'));
    try {
      for (const reservation of cold.listReservations())
        if (reservation.state === 'recovery-required')
          cold.resolveRecovery(reservation.reservationId);
    } finally {
      cold.close();
    }
    startHost();
    const beforeRun = revision();
    await expect(update(SET_NEW, key)).resolves.toMatchObject({
      written: true,
    });
    expect(revision()).toBe(beforeRun);
    expect(await createSession('after the run')).toBe(layerName(NEW));
    await updateWorkspaceConfig(workspaceId, (config): void => {
      config.itemSortMode = 'manual';
    });
    const gap = holdDirectoryRemoval();
    const deletion = startDeletion('multi_repo_workspace_delete');
    await gap.reached;
    expect(await createSession('in the gap')).toBe('none');
    await update(SET_NEW, key);
    expect(revision()).toBe(beforeRun);
    gap.release();
    await deletion;
    expect(revision()).toBe(beforeRun + 1);
    expect(staleReuse()).toEqual(['after the run -> in the gap']);
  });

  // A read in flight across a layer change belongs to a session stamped
  // before it, so its layer was not served at the owed revision.
  it.each<[string, WorkspacePluginsUserChange]>([
    ['setDefaults', SET_NEW],
    ['selectRecommended', SELECT_RECOMMENDED],
  ])(
    'B4 %s: a session read in flight across a layer change, then a lost response owed at the new revision, then a same-key replay in the gap advances nothing; the deletion advances once',
    async (_name, change) => {
      await seed();
      // Drop the cached layer without an advance, so the next read loads.
      pluginDefaultsCache.projectPluginDefaultsWritten({
        configPath: getWorkspaceConfigPath(workspaceId),
        workspaceId,
        layerChanged: false,
      });
      const seeded = revision();
      const loadReached = barrier();
      const loadGate = barrier();
      const readThrough = pluginDefaultsCache.readThroughProjectPluginDefaults;
      jest
        .spyOn(pluginDefaultsCache, 'readThroughProjectPluginDefaults')
        .mockImplementationOnce((configPath, load) =>
          readThrough(configPath, async () => {
            const read = await load();
            loadReached.open();
            await loadGate.promise;
            return read;
          }),
        );
      const inFlight = createSession('read in flight across the change');
      await loadReached.promise;
      await updateWorkspaceConfig(workspaceId, (config): void => {
        config.defaultPluginSelections = selections('mid');
      });
      expect(revision()).toBe(seeded + 1);
      loadGate.open();
      expect(await inFlight).toBe(layerName(OLD));
      const key = freshKey();
      loseNextResponse('is unreadable');
      await expect(update(change, key)).rejects.toThrow('response lost');
      const owedAt = revision();
      expect(owedAt).toBe(seeded + 1);
      const gap = holdDirectoryRemoval();
      const deletion = startDeletion('multi_repo_workspace_delete');
      await gap.reached;
      await expect(update(change, key)).resolves.toMatchObject({
        written: true,
      });
      expect(revision()).toBe(owedAt);
      gap.release();
      await deletion;
      expect(revision()).toBe(owedAt + 1);
      expect(await createSession('after the deletion')).toBe('none');
      expect(staleReuse()).toEqual([]);
    },
  );

  it('a replay in the gap of a key acknowledged before a later layer change advances nothing', async () => {
    await seed();
    await update(SET_NEW, 'key');
    await update(
      {
        kind: 'setDefaults',
        defaultPluginSelections: selections('later'),
      },
      'later',
    );
    const afterChanges = revision();
    await createSession('after the later change');
    const gap = holdDirectoryRemoval();
    const deletion = startDeletion('multi_repo_workspace_delete');
    await gap.reached;
    await update(SET_NEW, 'key');
    expect(revision()).toBe(afterChanges);
    gap.release();
    await deletion;
    expect(revision()).toBe(afterChanges + 1);
    expect(staleReuse()).toEqual([]);
  });
});
