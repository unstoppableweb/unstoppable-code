import type * as LegacyStorage from './fixtures/w5-legacy-storage';
import type * as NativeFs from 'node:fs';
import type * as PipelinesService from '../../services/pipelines-service';
import type * as HookRecovery from '../hook-recovery';
import type * as DaemonHealth from '../../canopy-runtime/electron-daemon-health';
import type { ElectronDaemonHealth } from '../../canopy-runtime/electron-daemon-health';
import type * as DesktopW5Recovery from '../../canopy-runtime/desktop-w5-recovery';
import type { W5RecoveryStatus } from '@canopy/protocol/remote-control/shell';
// CAN-7835 (CAN-7155 slice 4a, Seam B): Electron main's direct readers serve
// from the read cache whenever it can answer, over the real cache, record
// port, commit-log worker, W5e binding and handlers. Each moved reader, run
// through its real entry point, equals today's read and, warm, captures and
// reads nothing from the store. Every bypass the cache keeps (a commit scope,
// an open view, a writer lease, a test store, an unready or unregistered
// cache) runs today's read with no view. A served run that read a file its
// request left out, resolved or rejected, is dropped and read again as today.
// RR1 cleanup commits after the served view closes. After another origin's
// manifest commit the W5e handlers are served; after an index commit the
// registry refresh reads as today (`lagging`), and Seam A's step is unchanged.
// The real session snapshot and Seam A's observer listing and discovery list
// still serve their cached views. An indexed manifest that decides nothing
// keeps the cache revoked, and every reader reads as today.
// PR 4b: the shared Git-read admission check serves its list read. Its
// admissions equal today's and read nothing; a served refusal is confirmed by
// today's read, so a row the cache has not heard of yet is still admitted.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
  type PathLike,
  type WatchOptions,
  type WatchListener,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof NativeFs>('node:fs'),
  watch: jest.fn(),
}));
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<typeof LegacyStorage>('./fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../services/desktop-structure-signal', () => ({
  scheduleDesktopStructureChanged: jest.fn(),
}));
jest.mock('../worktree-watch-recovery', () => ({
  createWorktreeWatch: jest.fn(() => ({ close: jest.fn(), retire: jest.fn() })),
}));
jest.mock('../window-send', () => ({
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));
// CAN-7156: the handlers' outside-change cleanup; its detached poller and
// cleanup work stays out of these read measurements.
jest.mock('../worktree-registry-reconciliation', () => ({
  reconcileExternalWorktreeSnapshot: jest.fn(() => Promise.resolve()),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
// A session snapshot reaches daemon routes that cannot start under Jest and
// latch the shared health record; each case starts from a fresh one.
let mockDaemonHealth: ElectronDaemonHealth | undefined;
jest.mock('../../canopy-runtime/electron-daemon-health', () => {
  const actual = jest.requireActual<typeof DaemonHealth>(
    '../../canopy-runtime/electron-daemon-health',
  );
  return {
    ...actual,
    getElectronDaemonHealth: (): ElectronDaemonHealth =>
      (mockDaemonHealth ??= actual.createElectronDaemonHealth({
        warn: () => undefined,
        info: () => undefined,
      })),
  };
});
// A session snapshot's recovery projection starts a detached status read
// that leases the record port. Its daemon cannot start under Jest, and a read
// that outlives its case latches the next case's health, so that case's first
// W5e delivery is never acknowledged. The projection reads no cached file.
jest.mock('../../canopy-runtime/desktop-w5-recovery', () => ({
  ...jest.requireActual<typeof DesktopW5Recovery>(
    '../../canopy-runtime/desktop-w5-recovery',
  ),
  peekDesktopW5RecoveryForRemote: (): W5RecoveryStatus => ({
    state: 'hidden',
    canRecover: false,
    entries: [],
  }),
}));
// The poller's git-ready case starts polling only to install its hook.
jest.mock('../hook-recovery', () => ({
  ...jest.requireActual<typeof HookRecovery>('../hook-recovery'),
  startHookRecovery: jest.fn(),
}));
// Inventory's per-worktree discovery reads checkouts, not W5 files.
jest.mock('../../services/pipelines-service', () => ({
  ...jest.requireActual<typeof PipelinesService>(
    '../../services/pipelines-service',
  ),
  listPipelinesStrict: jest.fn(() =>
    Promise.resolve({ pipelines: [], truncated: false }),
  ),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  IPC_CHANNELS,
  type WorkspaceConfigFile,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type {
  CanopyEventsConnection,
  CanopyWorkspaceInvalidationPlan,
} from '@canopy/core-client';
import type { W5CaptureRequest } from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import {
  createDesktopW5ReadCache,
  type DesktopW5ReadCache,
  type W5ReadCacheSchedule,
} from '../../canopy-runtime/w5-read-cache';
import {
  defaultCoreWorkspaceReadServices,
  type CoreWorkspaceReadServices,
} from '../../canopy-runtime/core-workspace-adapter';
import type { DesktopCanopyDispatcher } from '../../canopy-runtime/desktop-runtime';
import {
  readThroughDesktopW5Cache,
  registerDesktopW5ReadCacheServer,
  runDesktopW5CachedReadView,
  W5_DISCOVER_REQUEST,
  W5_INDEX_REQUEST,
  w5WorkspaceFileRequest,
} from '../../canopy-runtime/w5-read-cache-server';
import {
  createWorkspaceCommitEventBinding,
  type WorkspaceCommitEventBinding,
  type WorkspaceCommitEventHandlers,
} from '../../canopy-runtime/workspace-commit-events';
import { createDesktopWorkspaceCommitEventHandlers } from '../../canopy-runtime/workspace-commit-event-handlers';
import {
  readProjectIndexSnapshot,
  readProjectWorktrees,
} from '../../project-discovery/sources';
import { buildDesktopSessionSnapshot } from '../../services/desktop-session-snapshot-service';
import { listWorktreePipelineInventoryDocuments } from '../../services/desktop-inventory-pipeline-documents';
import * as mainProcessLogging from '../main-process-logging';
import { listPipelinesStrict } from '../../services/pipelines-service';
import { listWorkspaceRemoteControlEntities } from '../../services/workspace-remote-control-service';
import {
  startW5HostedMetadataHarness,
  type W5HostedEventsClient,
  type W5HostedMetadataHarness,
} from './fixtures/w5-hosted-metadata-harness';
import {
  __setDesktopW5FileStoreForTests,
  installDesktopW5FileStore,
  withW5Commit,
} from '../w5-commit-log-file-store';
import type { W5RecordPortClient } from '../w5-daemon-record-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../w5-daemon-record-store';
import { nodeW5FileStore } from '../w5-file-store';
import { isInsideW5ReadView, runInW5UncapturedView } from '../w5-read-view';
import { withW5RepositoryLock } from '../w5-repository-locks';
import {
  markWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceConfig,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesUnlocked,
  removeWorkspaceWorktrees,
  updateWorkspaceWorktree,
  writeWorkspaceConfig,
  writeWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  getWorkspaceIndexRepository,
  readAllSidebarItemsSnapshot,
  refreshWorkspaceRegistries,
} from '../sidebar-items';
import {
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from '../workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from '../worktree-repo-entries';
import {
  isWorktreeObservationTarget,
  withGitReadPath,
  withWorktreeGitRead,
} from '../worktree-read-availability';
import {
  startWorktreeBranchEnrollment,
  startWorktreeBranchObserver,
  stopWorktreeBranchWatchers,
} from '../worktree-branch-watcher';
import { publishWorktreeGitReady } from '../worktree-git-ready-hooks';
import { reconcileExternalWorktreeSnapshot } from '../worktree-registry-reconciliation';
import { sendToAllWindows } from '../window-send';
import {
  getTrackedPrSnapshotLocations,
  isPrHookActiveForRepo,
  startPolling,
  stopPolling,
} from '../github-poller';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';

jest.setTimeout(120_000);

const WORKER = join(__dirname, 'fixtures/w5-commit-log-source-worker.ts');
// Injected clock: no bridge retry or cache timer fires within a case.
const NEVER_MS = 16_000_000;

class DirectoryWatch extends EventEmitter implements FSWatcher {
  closed = false;
  close(): void {
    this.closed = true;
    this.emit('close');
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

/** A timer the cache scheduled; it runs only when a case fires it. */
interface Timer {
  readonly ms: number;
  readonly run: () => Promise<void>;
  live: boolean;
}

let dir: string;
let workspaces: string;
let harness: W5HostedMetadataHarness;
let records: W5RecordPortClient;
let electron: W5CommitLogFileStore;
let foreignStore: W5CommitLogFileStore;
let readCache: DesktopW5ReadCache;
let binding: WorkspaceCommitEventBinding;
let restore: () => void;
let originalDataDir: string | undefined;
let timers: Timer[];
let directoryWatches: Map<string, DirectoryWatch>;
/** Plans the binding applied, in order. */
let applied: CanopyWorkspaceInvalidationPlan[];
let acks: number[];
/** Today's per-query captures and store reads, apart from the cache's own. */
let queries: W5CaptureRequest[];
let storeReads: string[];
/** Holds the binding's cache step, so handlers run once a case is ready. */
let stepGate: Promise<void> | undefined;
/** What each real W5e handler read, as the served counters saw it. */
let handled: { handler: string; w5: Record<string, number> }[];
/** Real handler failures; no case retries a delivery, so one would hang it. */
let handlerFailures: unknown[];
const waiters = new Set<() => void>();

const schedule: W5ReadCacheSchedule = (run, ms) => {
  const timer: Timer = { ms, run, live: true };
  timers.push(timer);
  return () => {
    timer.live = false;
  };
};

/**
 * Waits for `ready`. Where every delivery is acknowledged, a real handler
 * failure fails the wait at once: no case fires the bridge's retry.
 */
function until(ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      if (ready()) resolve();
      else if (deliveriesAcknowledged() && handlerFailures.length > 0)
        reject(
          new Error('A W5e handler failed; its delivery is never retried.', {
            cause: handlerFailures[0],
          }),
        );
      else return false;
      waiters.delete(check);
      return true;
    };
    if (!check()) waiters.add(check);
  });
}
const wake = (): void => {
  for (const waiter of Array.from(waiters)) waiter();
};

/** For work no case can await, such as the observer's detached sync. */
async function poll(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The polled condition never held.');
}

const SINGLE_CONFIG = (): WorkspaceConfigFile => ({
  version: 1,
  type: 'single-repo',
  repoPath: join(dir, 'repos', 'single'),
  repos: [],
});
const MULTI_CONFIG = (): WorkspaceConfigFile => ({
  version: 1,
  type: 'multi-repo',
  sourceRepoPath: join(dir, 'repos', 'source'),
  repos: [{ id: 'api', name: 'API', repoPath: join(dir, 'repos', 'api') }],
});
const TEMP_CONFIG: WorkspaceConfigFile = {
  version: 1,
  type: 'multi-repo',
  repos: [],
  temporary: true,
};
// RR1 tombstones outlive a case; each case's rows are distinct incarnations.
let incarnation = 0;
const createdAt = (): string =>
  `2026-11-01T00:${String(Math.floor(incarnation / 60)).padStart(2, '0')}:${String(incarnation % 60).padStart(2, '0')}.000Z`;
const ROW = (id: string, extra: Partial<WorktreeData> = {}): WorktreeData => ({
  id,
  branchName: `branch-${id}`,
  createdAt: createdAt(),
  ...extra,
});

/**
 * A workspace a describe adds to the seed: a cowork workspace, one whose
 * manifest or list does not parse, or an indexed id the capture cannot name.
 */
let extraFixture:
  | 'none'
  | 'cowork'
  | 'broken'
  | 'unsupported-id'
  | 'unreadable-list' = 'none';
const UNREADABLE_LIST_ID = 'badlist';
const UNSUPPORTED_ID = 'legacy.id';
/**
 * A manifest that decides nothing fails every W5e registry refresh, as it
 * does today, so no delivery is acknowledged and the bridge's broad
 * invalidation revokes the cache until a retry succeeds.
 */
const deliveriesAcknowledged = (): boolean =>
  extraFixture !== 'broken' && extraFixture !== 'unsupported-id';

/** Index, manifests and lists as another origin left them before launch. */
function seed(): void {
  const ids = ['single', 'multi', 'temp', 'nolist'];
  if (extraFixture === 'cowork' || extraFixture === 'broken')
    ids.push(extraFixture);
  if (extraFixture === 'unsupported-id') ids.push(UNSUPPORTED_ID);
  if (extraFixture === 'unreadable-list') ids.push(UNREADABLE_LIST_ID);
  for (const id of ids) mkdirSync(join(workspaces, id), { recursive: true });
  for (const id of ['single', 'source', 'api'])
    mkdirSync(join(dir, 'repos', id), { recursive: true });
  writeFileSync(
    join(workspaces, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: ids.map((id, order) => ({
        id,
        name: id.toUpperCase(),
        type:
          id === 'single'
            ? 'single-repo'
            : id === 'cowork'
              ? 'cowork'
              : 'multi-repo',
        color: '#7C3AED',
        collapsed: false,
        order,
      })),
    }),
  );
  const manifests: Record<string, WorkspaceConfigFile> = {
    single: SINGLE_CONFIG(),
    multi: MULTI_CONFIG(),
    temp: TEMP_CONFIG,
    nolist: { version: 1, type: 'multi-repo', repos: [] },
  };
  if (ids.includes('cowork'))
    manifests.cowork = { version: 1, type: 'cowork', repos: [] };
  for (const id of [UNSUPPORTED_ID, UNREADABLE_LIST_ID])
    if (ids.includes(id))
      manifests[id] = { version: 1, type: 'multi-repo', repos: [] };
  for (const [id, config] of Object.entries(manifests))
    writeFileSync(
      join(workspaces, id, 'workspace.json'),
      JSON.stringify(config),
    );
  if (ids.includes('broken'))
    writeFileSync(join(workspaces, 'broken', 'workspace.json'), '{"version":');
  const lists: Record<string, WorktreeData[]> = {
    single: [ROW('s1'), ROW('s2', { setupPhase: 'git-pending' })],
    multi: [ROW('m1', { includedRepoIds: ['api'] }), ROW('m2')],
    temp: [ROW('t1')],
  };
  for (const [id, worktrees] of Object.entries(lists))
    writeFileSync(
      join(workspaces, id, 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees }),
    );
  if (ids.includes(UNREADABLE_LIST_ID))
    writeFileSync(
      join(workspaces, UNREADABLE_LIST_ID, 'worktrees.json'),
      '{"version":',
    );
}

function connection(client: W5HostedEventsClient): CanopyEventsConnection {
  return {
    get identity() {
      return client.identity;
    },
    get manifest() {
      return client.manifest;
    },
    get signal() {
      return client.signal;
    },
    openStream: (name, params, options) =>
      client.openStream(name, params, options),
    instruction: async (name, params, options) => {
      const result = await client.instruction(name, params, options);
      acks.push(params.cursor.sequence);
      wake();
      return result;
    },
  };
}

/** Main's real handlers, each run's served counters recorded. */
function realHandlers(): WorkspaceCommitEventHandlers {
  const real = createDesktopWorkspaceCommitEventHandlers();
  const recorded =
    <A extends unknown[], R>(
      handler: string,
      run: (...args: A) => Promise<R>,
    ) =>
    async (...args: A): Promise<R> => {
      const before = { ...snapshotWorkCounters().w5 };
      try {
        return await run(...args);
      } catch (error) {
        handlerFailures.push(error);
        throw error;
      } finally {
        const after = snapshotWorkCounters().w5;
        const w5: Record<string, number> = {};
        for (const [key, value] of Object.entries(after))
          if (value !== (before[key] ?? 0))
            w5[key] = value - (before[key] ?? 0);
        handled.push({ handler, w5 });
        wake();
      }
    };
  return {
    ...real,
    refreshWorkspaceRegistries: recorded('refreshWorkspaceRegistries', () =>
      real.refreshWorkspaceRegistries(),
    ),
    reconcileManifestPluginDefaults: recorded(
      'reconcileManifestPluginDefaults',
      (workspaceId: string) =>
        real.reconcileManifestPluginDefaults(workspaceId),
    ),
    readWorktreeList: recorded('readWorktreeList', (workspaceId: string) =>
      real.readWorktreeList(workspaceId),
    ),
  };
}

beforeEach(async () => {
  incarnation += 1;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5-read-cache-seam-b-')));
  workspaces = join(dir, 'workspaces');
  seed();
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dir;
  timers = [];
  applied = [];
  acks = [];
  queries = [];
  storeReads = [];
  handled = [];
  handlerFailures = [];
  stepGate = undefined;
  directoryWatches = new Map();
  jest
    .mocked(watch)
    .mockImplementation(
      (
        path: PathLike,
        options?:
          | WatchOptions
          | string
          | null
          | WatchListener<string>
          | WatchListener<Buffer>,
        listener?: WatchListener<string> | WatchListener<Buffer>,
      ): FSWatcher => {
        const watcher = new DirectoryWatch();
        if (typeof options === 'function') watcher.on('change', options);
        else if (listener) watcher.on('change', listener);
        directoryWatches.set(String(path), watcher);
        return watcher;
      },
    );
  readCache = createDesktopW5ReadCache({
    usable: () => true,
    retryFirstMs: NEVER_MS,
    ownRefillMs: NEVER_MS + 1,
    refreshMs: NEVER_MS + 2,
    schedule,
    now: () => 0,
  });
  readCache.setStreamReady(true);
  harness = await startW5HostedMetadataHarness({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root: workspaces,
    workerEntry: WORKER,
    daemonOwned: ['workspace_index', 'workspace_manifest', 'worktree_list'],
  });
  records = await harness.connectRecords('electron-main');
  foreignStore = createW5DaemonRecordStore({
    root: harness.root,
    transport: w5RecordPortTransport(await harness.connectRecords('cli')),
  });
  electron = createW5DaemonRecordStore({
    root: harness.root,
    transport: w5RecordPortTransport(() => Promise.resolve(records)),
    projection: readCache,
  });
  restore = installW5DaemonRecordStoreForTests(electron);
  // Today's reads go through this production slot, so a case can count them.
  installDesktopW5FileStore({
    ...electron,
    capture: (request) => {
      queries.push(request);
      if (!electron.capture) throw new Error('The store captures');
      return electron.capture(request);
    },
    read: (path) => {
      storeReads.push(path);
      return electron.read(path);
    },
  });
  binding = createWorkspaceCommitEventBinding({
    isOwnOrigin: (id) => id === 'electron-main',
    retryDelayMs: NEVER_MS,
    onStreamChanged: (ready) => {
      readCache.setStreamReady(ready);
      wake();
    },
    onInvalidated: () => readCache.revoke(),
    readCache: async (plan) => {
      await stepGate;
      await readCache.apply(plan);
      applied.push(plan);
      wake();
    },
    handlers: realHandlers(),
  });
  await readCache.activate(electron);
  const attached = binding.attach(
    connection(await harness.connectEvents('electron-main')),
  );
  // A manifest that decides nothing leaves the first delivery unacknowledged
  // until the bridge retries, which no case fires; `close` settles it.
  // Elsewhere a handler failure fails setup at once instead of hanging it.
  void attached.catch(() => undefined);
  if (deliveriesAcknowledged()) {
    let attachedSettled = false;
    const settle = (): void => {
      attachedSettled = true;
      wake();
    };
    void attached.then(settle, settle);
    await until(() => attachedSettled);
    await attached;
  }
  await until(() => applied.some((plan) => plan.broad));
  if (!deliveriesAcknowledged()) {
    await until(() =>
      handled.some((entry) => entry.handler === 'refreshWorkspaceRegistries'),
    );
    await poll(() => !ready());
  }
  expect(ready()).toBe(deliveriesAcknowledged());
  registerDesktopW5ReadCacheServer(readCache);
});

afterEach(async () => {
  registerDesktopW5ReadCacheServer(undefined);
  await binding.close();
  readCache.dispose();
  await settleDetachedWork();
  restore();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await harness.close();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  // Each case has its own data dir, as a fresh process would. A degraded
  // refresh keeps the ids it cannot decide, and a broad delivery reconciles
  // every registered id, so a stale one would leave the next undecided.
  registerWorkspaceTypes(new Map());
  registerWorkspaceExternalPaths(new Map());
  mockDaemonHealth?.stop();
  mockDaemonHealth = undefined;
});

/** Fires the cache's one trailing own-decision refill. */
async function fireOwnRefill(): Promise<void> {
  const pending = timers.filter(
    (timer) => timer.live && timer.ms === NEVER_MS + 1,
  );
  expect(pending).toHaveLength(1);
  for (const timer of pending) {
    timer.live = false;
    await asProductionAsync(timer.run);
  }
}

/**
 * A session snapshot provisions the default project after its view closes;
 * provision it first, so each later build reads the same workspaces.
 */
async function provisionDefaultProject(): Promise<void> {
  await asProductionAsync(() => buildDesktopSessionSnapshot());
  for (const timer of timers.filter(
    (pending) => pending.live && pending.ms === NEVER_MS + 1,
  )) {
    timer.live = false;
    await asProductionAsync(timer.run);
  }
}

/** `ready()` as production asks it: the test store stands aside meanwhile. */
function ready(): boolean {
  return asProduction(() => readCache.ready());
}

/** Runs `work` as production does: no test store shadows the slot. */
function asProduction<T>(work: () => T): T {
  __setDesktopW5FileStoreForTests(undefined);
  try {
    return work();
  } finally {
    __setDesktopW5FileStoreForTests(electron);
  }
}

interface ReadRun<T> {
  readonly value: T;
  /** Today's captures and store reads the run made. */
  readonly captures: number;
  readonly reads: readonly string[];
  readonly w5: Readonly<Record<string, number>>;
}

async function run<T>(read: () => Promise<T>): Promise<ReadRun<T>> {
  const captures = queries.length;
  const reads = storeReads.length;
  resetWorkCounters();
  const value = await asProductionAsync(read);
  return {
    value,
    captures: queries.length - captures,
    reads: storeReads.slice(reads),
    w5: snapshotWorkCounters().w5,
  };
}

async function asProductionAsync<T>(work: () => Promise<T>): Promise<T> {
  __setDesktopW5FileStoreForTests(undefined);
  try {
    return await work();
  } finally {
    __setDesktopW5FileStoreForTests(electron);
  }
}

/** The read with the cache unregistered: today's path exactly. */
async function today<T>(read: () => Promise<T>): Promise<ReadRun<T>> {
  registerDesktopW5ReadCacheServer(undefined);
  try {
    return await run(read);
  } finally {
    registerDesktopW5ReadCacheServer(readCache);
  }
}

/** A served direct read: equal to today's, nothing captured or read. */
async function expectServed<T>(
  read: () => Promise<T>,
  servedReads = 1,
): Promise<T> {
  const expected = await today(read);
  expect(expected.captures + expected.reads.length).toBeGreaterThan(0);
  const served = await run(read);
  expect(served.value).toEqual(expected.value);
  expect(served.captures).toBe(0);
  expect(served.reads).toEqual([]);
  expect(served.w5['readView.cachedDirect']).toBe(servedReads);
  for (const key of [
    'readView.captured',
    'read.backend.capture',
    'port.capture',
  ])
    expect(served.w5[key]).toBeUndefined();
  return served.value;
}

/** Today's read path: no view, the store answers, the cache serves nothing. */
async function expectToday<T>(read: () => Promise<T>): Promise<void> {
  const expected = await today(read);
  const bypassed = await run(read);
  expect(bypassed.value).toEqual(expected.value);
  expect(bypassed.reads).toEqual(expected.reads);
  expect(bypassed.w5['readView.cachedDirect']).toBeUndefined();
}

/**
 * Another origin's commit (the CLI, say), delivered to the real handlers
 * only once reads run as production's do, with no test store installed.
 */
async function foreignCommit(write: () => Promise<unknown>): Promise<void> {
  const acked = acks.length;
  let open = (): void => undefined;
  stepGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  __setDesktopW5FileStoreForTests(foreignStore);
  try {
    await write();
  } finally {
    __setDesktopW5FileStoreForTests(undefined);
  }
  try {
    open();
    await until(() => acks.length > acked);
  } finally {
    stepGate = undefined;
    __setDesktopW5FileStoreForTests(electron);
  }
}

const admits =
  (projectId: string, worktreeId: string) => (): Promise<boolean> =>
    isWorktreeObservationTarget(projectId, worktreeId);

/** A served refusal reads again as today and refuses only if today does. */
async function expectRefusalConfirmed(
  read: () => Promise<boolean>,
): Promise<void> {
  const expected = await today(read);
  expect(expected.value).toBe(false);
  const served = await run(read);
  expect(served.value).toBe(false);
  expect(served.w5).toMatchObject({
    'readView.cachedDirect': 1,
    'readView.cacheMiss.unaccepted': 1,
  });
  expect(served.reads).toEqual(expected.reads);
}

const manifestReader = (id: string) => (): Promise<WorkspaceConfigFile> =>
  readThroughDesktopW5Cache(w5WorkspaceFileRequest('manifest', id), () =>
    readWorkspaceConfig(id),
  );
const listReader =
  (id: string) => (): ReturnType<typeof readWorkspaceWorktreesUnlocked> =>
    readThroughDesktopW5Cache(w5WorkspaceFileRequest('worktrees', id), () =>
      readWorkspaceWorktreesUnlocked(id),
    );

describe('Seam B direct readers served from the read cache (CAN-7835)', () => {
  test.each(['single', 'multi', 'temp', 'nolist'])(
    'scoped manifest and list reads of %s equal today and read nothing',
    async (id) => {
      await expectServed(manifestReader(id));
      await expectServed(() =>
        readThroughDesktopW5Cache(w5WorkspaceFileRequest('manifest', id), () =>
          readWorkspaceConfigDetailed(id),
        ),
      );
      // The absent list of `nolist` is served as absent.
      await expectServed(listReader(id));
    },
  );

  test("the observer's and poller's repo entries read the cached manifest", async () => {
    const worktree = join(workspaces, 'multi', 'worktrees', 'm1');
    mkdirSync(join(worktree, 'repos', 'api'), { recursive: true });
    const entries = await expectServed(() =>
      listWorkspaceWorktreeRepoEntries(
        'multi',
        worktree,
        undefined,
        manifestReader('multi'),
      ),
    );
    // The default reader is today's, whatever the cache holds.
    await expectToday(() =>
      listWorkspaceWorktreeRepoEntries('multi', worktree),
    );
    expect(
      await asProductionAsync(() =>
        listWorkspaceWorktreeRepoEntries('multi', worktree),
      ),
    ).toEqual(entries);
  });

  test('the branch observer reads a ready multi-repo manifest from the cache', async () => {
    const wasE2e: unknown = Reflect.get(globalThis, '__CANOPY_E2E__');
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      value: true,
      configurable: true,
      writable: true,
    });
    const runtime = createDesktopRuntime();
    startWorktreeBranchObserver({ dispatcher: runtime, getWindow: () => null });
    const ready = (worktreeId: string) => (): Promise<void> =>
      publishWorktreeGitReady({
        projectId: 'multi',
        worktreeId,
        workspaceKind: 'multi-repo',
        branchName: `branch-${worktreeId}`,
      });
    const manifest = join(workspaces, 'multi', 'workspace.json');
    try {
      const manifestReads = (reads: readonly string[]): number =>
        reads.filter((path) => path === manifest).length;
      const expected = await today(ready('m1'));
      const charged = snapshotWorkCounters().w5Caller;
      expect(charged).toMatchObject({
        'background:branch-observer-config.storeRead': 1,
      });
      const served = await run(ready('m2'));
      expect(served.captures).toBe(0);
      expect(served.w5['readView.cachedDirect']).toBe(1);
      // Only the observer's own config read moved; the other manifest
      // reads stay as they are.
      expect(manifestReads(served.reads)).toBe(
        manifestReads(expected.reads) - 1,
      );
      const { w5Caller } = snapshotWorkCounters();
      expect(
        Object.keys(w5Caller).filter((key) =>
          key.startsWith('background:branch-observer-config.'),
        ),
      ).toEqual([]);
    } finally {
      stopWorktreeBranchWatchers();
      await runtime.shutdown();
      Object.defineProperty(globalThis, '__CANOPY_E2E__', {
        value: wasE2e,
        configurable: true,
        writable: true,
      });
    }
  });

  test.each([
    ['single', 's1', undefined],
    ['multi', 'm1', 'api'],
  ] as const)(
    "the GitHub poller's target and hook reads of %s take the cached manifest",
    async (projectId, worktreeId, repoId) => {
      mkdirSync(join(workspaces, projectId, 'worktrees', worktreeId), {
        recursive: true,
      });
      const read = (): Promise<boolean> =>
        isPrHookActiveForRepo({
          projectId,
          worktreeId,
          ...(repoId ? { repoId } : {}),
          triggerName: 'pr_opened',
        });
      const manifest = join(workspaces, projectId, 'workspace.json');
      const list = join(workspaces, projectId, 'worktrees.json');
      const count = (reads: readonly string[], path: string): number =>
        reads.filter((read) => read === path).length;
      const expected = await today(read);
      expect(expected.reads).toContain(manifest);
      // Its Git-read admission's list reads (PR 4b).
      expect(expected.reads).toContain(list);
      const served = await run(read);
      expect(served.value).toBe(expected.value);
      expect(served.w5['readView.cachedDirect']).toBeGreaterThan(0);
      expect(count(served.reads, list)).toBe(0);
      // A multi-repo target's hook layers still read the manifest in
      // `hook-resolver.ts` (recorded debt); the poller's own reads do not.
      expect(count(served.reads, manifest)).toBe(
        count(expected.reads, manifest) +
          count(expected.reads, list) -
          served.w5['readView.cachedDirect'],
      );
    },
  );

  test("discovery's index read equals today and reads nothing", async () => {
    await expectServed(() => readProjectIndexSnapshot('multi'));
    await expectServed(() => readProjectIndexSnapshot('unknown'));
    const index = await expectServed(() =>
      readThroughDesktopW5Cache(W5_INDEX_REQUEST, () =>
        getWorkspaceIndexRepository().read(),
      ),
    );
    expect(index).toMatchObject({ authority: 'ok' });
  });

  test('inventory reads its snapshot and every manifest from the cache', async () => {
    const expected = await today(() =>
      listWorktreePipelineInventoryDocuments(),
    );
    const targets = jest.mocked(listPipelinesStrict).mock.calls.length;
    const served = await run(() => listWorktreePipelineInventoryDocuments());
    expect(served.value).toEqual(expected.value);
    expect(served.value.complete).toBe(true);
    expect(served.value.nonPersonalWorkspaceIds).toEqual(['temp']);
    // The same targets, from the same items.
    expect(jest.mocked(listPipelinesStrict).mock.calls.slice(targets)).toEqual(
      jest.mocked(listPipelinesStrict).mock.calls.slice(0, targets),
    );
    expect(served.captures).toBe(0);
    expect(served.reads).toEqual([]);
    // The snapshot, then each listed workspace's manifest.
    expect(served.w5['readView.cachedDirect']).toBe(1 + 4);
  });

  test('RR1: a served snapshot defers its cleanup until the view closes', async () => {
    markWorkspaceWorktreeRecentlyRemoved('multi', 'm2', createdAt());
    const listFile = join(workspaces, 'multi', 'worktrees.json');
    const served = await run(() =>
      readThroughDesktopW5Cache(W5_DISCOVER_REQUEST, () =>
        readAllSidebarItemsSnapshot(),
      ),
    );
    expect(served.w5['readView.cachedDirect']).toBe(1);
    const item = served.value.file.items.find((entry) => entry.id === 'multi');
    expect(
      item && 'worktrees' in item ? item.worktrees.map((row) => row.id) : [],
    ).toEqual(['m1']);
    // The cleanup re-read and committed once the view closed.
    expect(
      (
        JSON.parse(readFileSync(listFile, 'utf8')) as {
          worktrees: WorktreeData[];
        }
      ).worktrees.map((row) => row.id),
    ).toEqual(['m1']);
    // The cleanup is an own commit: served once its trailing refill settles.
    await fireOwnRefill();
    await expectServed(listReader('multi'));
  });

  test('Remote Control and the session snapshot discover through the cache', async () => {
    const read = (): ReturnType<typeof listWorkspaceRemoteControlEntities> =>
      listWorkspaceRemoteControlEntities(undefined, {
        includeDiffStats: false,
      });
    const expected = await today(read);
    const served = await run(read);
    expect(served.value).toEqual(expected.value);
    expect(expected.w5['readView.captured']).toBe(1);
    expect(served.w5['readView.cached']).toBe(1);
    expect(served.w5['readView.captured']).toBeUndefined();
    expect(served.captures).toBe(0);
  });

  test('the real session snapshot discovers through the cache', async () => {
    const read = (): ReturnType<typeof buildDesktopSessionSnapshot> =>
      buildDesktopSessionSnapshot();
    // The first build provisions the default project after its view closes:
    // an own commit, served once its trailing refill settles.
    await asProductionAsync(read);
    await fireOwnRefill();
    const expected = await today(read);
    expect(expected.value.workspaces.map((row) => row.localId)).toEqual([
      'single',
      'multi',
      'temp',
      'nolist',
      'cowork-default',
    ]);
    const served = await run(read);
    expect(served.value).toEqual(expected.value);
    expect(expected.w5['readView.captured']).toBe(1);
    expect(served.w5['readView.cached']).toBe(1);
    expect(served.w5['readView.captured']).toBeUndefined();
    expect(served.captures).toBe(0);
  });

  test("Seam A's observer listing and Seam B's manifests serve through the real listCheckouts", async () => {
    const info = jest.spyOn(mainProcessLogging, 'logMainProcessInfo');
    const wasE2e: unknown = Reflect.get(globalThis, '__CANOPY_E2E__');
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      value: true,
      configurable: true,
      writable: true,
    });
    const cachedRuntime = createDesktopRuntime({
      workspaceServices: {
        ...defaultCoreWorkspaceReadServices(),
        readView: runDesktopW5CachedReadView,
      },
    });
    const todayRuntime = createDesktopRuntime();
    // The listing's checkouts, by the keys of the starts each one tried.
    const enroll =
      (dispatcher: DesktopCanopyDispatcher) => async (): Promise<string[]> => {
        info.mockClear();
        startWorktreeBranchObserver({ dispatcher, getWindow: () => null });
        startWorktreeBranchEnrollment();
        await poll(() =>
          info.mock.calls.some(
            ([message]) => message === 'Worktree branch watchers synced',
          ),
        );
        stopWorktreeBranchWatchers();
        return info.mock.calls
          .filter(
            ([message]) =>
              message === 'Worktree branch watcher failed to start',
          )
          .map(([, context]) => JSON.stringify(context))
          .sort();
      };
    try {
      const expected = await today(enroll(todayRuntime));
      const configReads =
        snapshotWorkCounters().w5Caller[
          'background:branch-observer-config.storeRead'
        ];
      expect(configReads).toBeGreaterThan(0);
      const served = await run(enroll(cachedRuntime));
      expect(served.value).toEqual(expected.value);
      // single/s1, multi/m1 and multi/m2: s2 is git-pending, and the
      // temporary workspace is retired.
      expect(served.value).toHaveLength(3);
      expect(served.w5['readView.cached']).toBe(1);
      expect(served.w5['readView.captured']).toBeUndefined();
      // Each manifest read today's listing made is served instead.
      expect(served.w5['readView.cachedDirect']).toBe(configReads);
      const charged = Object.keys(snapshotWorkCounters().w5Caller).filter(
        (key) => key.startsWith('background:branch-observer'),
      );
      expect(charged).toEqual([]);
    } finally {
      stopWorktreeBranchWatchers();
      info.mockRestore();
      await Promise.all([cachedRuntime.shutdown(), todayRuntime.shutdown()]);
      Object.defineProperty(globalThis, '__CANOPY_E2E__', {
        value: wasE2e,
        configurable: true,
        writable: true,
      });
    }
  });

  test("Seam A's discovery list wrapper serves through the real readProjectWorktrees", async () => {
    // The last runtime created is the active one discovery reads through.
    const through =
      (services?: CoreWorkspaceReadServices) =>
      async (): Promise<WorktreeData[]> => {
        const runtime = createDesktopRuntime(
          services ? { workspaceServices: services } : {},
        );
        try {
          return await readProjectWorktrees('single');
        } finally {
          await runtime.shutdown();
        }
      };
    const expected = await today(through());
    expect(expected.value.map((row) => row.id)).toEqual(['s1', 's2']);
    const served = await run(
      through({
        ...defaultCoreWorkspaceReadServices(),
        readView: runDesktopW5CachedReadView,
      }),
    );
    expect(served.value).toEqual(expected.value);
    expect(served.w5['readView.cached']).toBe(1);
    expect(served.w5['readView.captured']).toBeUndefined();
    expect(served.captures).toBe(0);
    expect(served.reads).toEqual([]);
  });

  test('the real W5e handlers read the cache directly', async () => {
    const handlers = createDesktopWorkspaceCommitEventHandlers();
    await expectServed(() => handlers.refreshWorkspaceRegistries());
    await expectServed(() => handlers.readWorktreeList('multi'));
  });

  test('after a foreign manifest commit the W5e handlers are served', async () => {
    const before = handled.length;
    await foreignCommit(() =>
      writeWorkspaceConfig('multi', { ...MULTI_CONFIG(), alwaysShow: true }),
    );
    expect(applied.at(-1)).toMatchObject({
      broad: false,
      index: false,
      manifests: ['multi'],
    });
    const refreshes = handled
      .slice(before)
      .filter((entry) => entry.handler === 'refreshWorkspaceRegistries');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.w5).toMatchObject({ 'readView.cachedDirect': 1 });
    expect(refreshes[0]?.w5['readView.captured']).toBeUndefined();
    expect(refreshes[0]?.w5['port.capture']).toBeUndefined();
    expect(await asProductionAsync(manifestReader('multi'))).toMatchObject({
      alwaysShow: true,
    });
  });

  test('after a foreign index commit the registry refresh reads as today (lagging)', async () => {
    const before = handled.length;
    await foreignCommit(() =>
      getWorkspaceIndexRepository().update(({ entries }) => ({
        entries: entries.map((entry) =>
          entry.id === 'multi' ? { ...entry, name: 'Renamed' } : entry,
        ),
        result: undefined,
      })),
    );
    expect(applied.at(-1)).toMatchObject({ broad: false, index: true });
    const refreshes = handled
      .slice(before)
      .filter((entry) => entry.handler === 'refreshWorkspaceRegistries');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.w5['readView.cachedDirect']).toBeUndefined();
    expect(refreshes[0]?.w5['readView.cacheMiss.lagging']).toBe(1);
    // The scoped readers name no index, so they are still served.
    await expectServed(manifestReader('multi'));
    expect(
      await asProductionAsync(() => readProjectIndexSnapshot('multi')),
    ).toMatchObject({ entry: { name: 'Renamed' } });
  });

  test('a foreign list commit is served to the list handler', async () => {
    const before = handled.length;
    await foreignCommit(() =>
      writeWorkspaceWorktrees('temp', [ROW('t1'), ROW('t2')]),
    );
    expect(applied.at(-1)).toMatchObject({ worktreeLists: ['temp'] });
    const lists = handled
      .slice(before)
      .filter((entry) => entry.handler === 'readWorktreeList');
    expect(lists.length).toBeGreaterThan(0);
    for (const entry of lists)
      expect(entry.w5).toMatchObject({ 'readView.cachedDirect': 1 });
    expect(
      (await asProductionAsync(listReader('temp'))).worktrees.map(
        (row) => row.id,
      ),
    ).toEqual(['t1', 't2']);
  });

  test('an own write is read back at once, never from the stale image', async () => {
    await asProductionAsync(() =>
      writeWorkspaceConfig('single', { ...SINGLE_CONFIG(), alwaysShow: false }),
    );
    const read = await run(manifestReader('single'));
    expect(read.value).toMatchObject({ alwaysShow: false });
    expect(read.value).toEqual((await today(manifestReader('single'))).value);
  });

  test('a file the native watch dirtied misses and reads as today', async () => {
    readCache.markDirty([{ kind: 'manifest', workspaceId: 'multi' }]);
    const read = await run(manifestReader('multi'));
    expect(read.w5['readView.cachedDirect']).toBeUndefined();
    expect(read.reads).toEqual([join(workspaces, 'multi', 'workspace.json')]);
    // Other files stay served.
    await expectServed(manifestReader('single'));
  });

  describe('every bypass runs today’s read with no view', () => {
    test('unregistered, as where the cache is not selected', async () => {
      registerDesktopW5ReadCacheServer(undefined);
      const read = await run(manifestReader('multi'));
      expect(read.reads).toHaveLength(1);
      expect(read.w5['readView.cachedDirect']).toBeUndefined();
    });

    test('a test store', async () => {
      const read = await run(() => {
        __setDesktopW5FileStoreForTests(electron);
        return manifestReader('multi')();
      });
      expect(read.w5['readView.cachedDirect']).toBeUndefined();
    });

    test('not ready', async () => {
      readCache.revoke();
      expect(ready()).toBe(false);
      await expectToday(manifestReader('multi'));
    });

    test('a commit scope', async () => {
      await expectToday(() =>
        withW5Commit({ operation: 'seam-b.scoped-read' }, () =>
          manifestReader('multi')(),
        ),
      );
    });

    test('an outer view', async () => {
      let inside = false;
      await expectToday(() =>
        runInW5UncapturedView('direct-store', () => {
          inside = isInsideW5ReadView();
          return manifestReader('multi')();
        }),
      );
      expect(inside).toBe(true);
    });

    test('a writer lease in flight', async () => {
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding = (): void => undefined;
      const taken = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const lease = withW5RepositoryLock(
        { kind: 'list', path: join(workspaces, 'unlisted', 'worktrees.json') },
        () => {
          holding();
          return held;
        },
      );
      await taken;
      try {
        const read = await run(manifestReader('multi'));
        expect(read.w5['readView.cacheMiss.writing']).toBe(1);
        expect(read.w5['readView.cachedDirect']).toBeUndefined();
        expect(read.reads).toHaveLength(1);
      } finally {
        release();
        await lease;
      }
    });
  });

  describe('a served run that read outside its request reads again as today', () => {
    test('resolving', async () => {
      const insides: boolean[] = [];
      const read = (): Promise<WorkspaceConfigFile> =>
        readThroughDesktopW5Cache(
          w5WorkspaceFileRequest('manifest', 'single'),
          () => {
            insides.push(isInsideW5ReadView());
            return readWorkspaceConfig('multi');
          },
        );
      const expected = await today(() => readWorkspaceConfig('multi'));
      const again = await run(read);
      expect(again.value).toEqual(expected.value);
      expect(insides).toEqual([true, false]);
      expect(again.w5).toMatchObject({
        'readView.cachedDirect': 1,
        'readView.cacheMiss.uncaptured': 1,
      });
      expect(again.reads).toEqual(expected.reads);
    });

    test('rejecting', async () => {
      const insides: boolean[] = [];
      const failure = new Error('decided on the refused read');
      const read = (): Promise<never> =>
        readThroughDesktopW5Cache(
          w5WorkspaceFileRequest('manifest', 'single'),
          async () => {
            insides.push(isInsideW5ReadView());
            await refreshWorkspaceRegistries();
            throw failure;
          },
        );
      await expect(asProductionAsync(read)).rejects.toBe(failure);
      expect(insides).toEqual([true, false]);
    });

    test('a served rejection with every read captured passes through', async () => {
      const failure = new Error('the reader refused');
      let calls = 0;
      await expect(
        asProductionAsync(() =>
          readThroughDesktopW5Cache(
            w5WorkspaceFileRequest('manifest', 'single'),
            async () => {
              calls += 1;
              await readWorkspaceConfig('single');
              throw failure;
            },
          ),
        ),
      ).rejects.toBe(failure);
      expect(calls).toBe(1);
    });
  });

  describe('a cowork workspace', () => {
    beforeAll(() => {
      extraFixture = 'cowork';
    });
    afterAll(() => {
      extraFixture = 'none';
    });

    test('its scoped reads equal today and read nothing', async () => {
      await expectServed(manifestReader('cowork'));
      await expectServed(listReader('cowork'));
      await expectServed(() =>
        listWorkspaceWorktreeRepoEntries(
          'cowork',
          join(workspaces, 'cowork', 'worktrees', 'w1'),
          undefined,
          manifestReader('cowork'),
        ),
      );
      await expectServed(() => readProjectIndexSnapshot('cowork'));
    });

    test('Git-read admission excludes it without reading its list, as today', async () => {
      const expected = await today(admits('cowork', 'w1'));
      const served = await run(admits('cowork', 'w1'));
      expect(served.value).toBe(expected.value);
      expect(expected.reads).toEqual([]);
      expect(served.reads).toEqual([]);
      expect(served.w5['readView.cachedDirect']).toBeUndefined();
    });

    test('the discovery readers equal today and capture nothing', async () => {
      await provisionDefaultProject();
      const inventory = await expectServed(
        () => listWorktreePipelineInventoryDocuments(),
        // The snapshot and the manifest of each workspace with worktrees;
        // cowork rows have none.
        1 + 4,
      );
      expect(inventory.complete).toBe(true);
      const snapshot = await expectSettledAsToday(() =>
        buildDesktopSessionSnapshot(),
      );
      expect(snapshot.served.w5['readView.cached']).toBe(1);
      expect(snapshot.served.captures).toBe(0);
      const { value } = snapshot.served;
      expect(
        'workspaces' in value
          ? value.workspaces.map((row) => [row.localId, row.type])
          : [],
      ).toContainEqual(['cowork', 'cowork']);
      await expectServed(() =>
        createDesktopWorkspaceCommitEventHandlers().refreshWorkspaceRegistries(),
      );
    });
  });

  describe('a workspace whose list does not parse', () => {
    beforeAll(() => {
      extraFixture = 'unreadable-list';
    });
    afterAll(() => {
      extraFixture = 'none';
    });

    test('Git-read admission refuses it, as today, and admits the rest', async () => {
      const { served } = await expectSettledAsToday(
        admits(UNREADABLE_LIST_ID, 'w1'),
      );
      expect(served.value).toBe(false);
      expect(await expectServed(admits('single', 's1'))).toBe(true);
    });
  });

  describe.each(['broken', 'unsupported-id'] as const)(
    'an indexed workspace whose manifest decides nothing (%s)',
    (fixture) => {
      beforeAll(() => {
        extraFixture = fixture;
      });
      afterAll(() => {
        extraFixture = 'none';
      });

      test('the cache serves nothing, and every moved reader reads as today', async () => {
        const id = fixture === 'broken' ? 'broken' : UNSUPPORTED_ID;
        for (const read of [
          manifestReader(id),
          listReader(id),
          manifestReader('multi'),
          listReader('multi'),
          (): Promise<unknown> =>
            readThroughDesktopW5Cache(
              w5WorkspaceFileRequest('manifest', id),
              () => readWorkspaceConfigDetailed(id),
            ),
          (): Promise<unknown> => readProjectIndexSnapshot(id),
          (): Promise<unknown> =>
            listWorkspaceWorktreeRepoEntries(
              'multi',
              join(workspaces, 'multi', 'worktrees', 'm1'),
              undefined,
              manifestReader('multi'),
            ),
          (): Promise<unknown> => listWorktreePipelineInventoryDocuments(),
          (): Promise<unknown> =>
            createDesktopWorkspaceCommitEventHandlers().readWorktreeList(id),
          admits(id, 'w1'),
          admits('single', 's1'),
          (): Promise<unknown> =>
            listWorkspaceRemoteControlEntities(undefined, {
              includeDiffStats: false,
            }),
        ]) {
          const { served } = await expectSettledAsToday(read);
          expect(served.w5['readView.cachedDirect']).toBeUndefined();
          expect(served.w5['readView.cached']).toBeUndefined();
        }
        // Today's registry refresh rejects too, so the commit is retried.
        const registries = await expectSettledAsToday(() =>
          createDesktopWorkspaceCommitEventHandlers().refreshWorkspaceRegistries(),
        );
        expect(registries.served.value).toMatchObject({
          name: 'WorkspaceRegistriesDegradedError',
        });
        expect(registries.served.w5['readView.cachedDirect']).toBeUndefined();
      });
    },
  );

  describe('Git-read admission (PR 4b)', () => {
    test.each([
      ['single', 's1'],
      ['multi', 'm1'],
      ['multi', 'm2'],
      ['temp', 't1'],
    ])(
      'admitting %s/%s equals today and reads nothing',
      async (projectId, worktreeId) => {
        expect(await expectServed(admits(projectId, worktreeId))).toBe(true);
      },
    );

    test.each([
      ['a git-pending row', 'single', 's2'],
      ['a missing row', 'multi', 'gone'],
      ['an absent list', 'nolist', 'n1'],
    ])(
      'refusing %s is confirmed by today’s read',
      async (_label, projectId, worktreeId) => {
        await expectRefusalConfirmed(admits(projectId, worktreeId));
      },
    );

    test('a tombstoned row is decided as today, without a cleanup write', async () => {
      // Admission reads the unfiltered list today; RR1 is the list readers'.
      markWorkspaceWorktreeRecentlyRemoved('multi', 'm2', createdAt());
      const listFile = join(workspaces, 'multi', 'worktrees.json');
      const before = readFileSync(listFile, 'utf8');
      expect(await expectServed(admits('multi', 'm2'))).toBe(true);
      expect(readFileSync(listFile, 'utf8')).toBe(before);
    });

    test.each([
      ['an unindexed workspace', 'unknown'],
      ['an id the capture cannot name', UNSUPPORTED_ID],
    ])('%s is refused through today’s read', async (_label, projectId) => {
      await expectToday(admits(projectId, 'w1'));
      expect((await run(admits(projectId, 'w1'))).value).toBe(false);
    });

    test('the shared Git-read wrappers admit from the cache', async () => {
      const cwd = join(workspaces, 'single', 'worktrees', 's1');
      mkdirSync(cwd, { recursive: true });
      expect(
        await expectServed(() =>
          withWorktreeGitRead('single', 's1', 'unavailable', () =>
            Promise.resolve('read'),
          ),
        ),
      ).toBe('read');
      // The path form admits once on its own, then once through the id form.
      expect(
        await expectServed(
          () =>
            withGitReadPath(cwd, 'unavailable', () => Promise.resolve('read')),
          2,
        ),
      ).toBe('read');
      // A missing folder is still refused after a served admission.
      const missing = await run(() =>
        withWorktreeGitRead('multi', 'm1', 'unavailable', () =>
          Promise.resolve('read'),
        ),
      );
      expect(missing.value).toBe('unavailable');
      expect(missing.w5['readView.cachedDirect']).toBe(1);
      expect(missing.reads).toEqual([]);
    });

    test('an own create and an own removal are read back at once', async () => {
      await asProductionAsync(() =>
        writeWorkspaceWorktrees('single', [ROW('s3')]),
      );
      const created = await run(admits('single', 's3'));
      expect(created.value).toBe(true);
      // The cache's own answer, with no refusal to confirm.
      expect(created.w5['readView.cacheMiss.unaccepted']).toBeUndefined();
      expect((await today(admits('single', 's3'))).value).toBe(true);
      await asProductionAsync(() =>
        removeWorkspaceWorktrees('single', (row) => row.id === 's1'),
      );
      const removed = await run(admits('single', 's1'));
      expect(removed.value).toBe(false);
      expect((await today(admits('single', 's1'))).value).toBe(false);
    });

    test('a foreign removal is refused once its W5e plan lands', async () => {
      jest.mocked(reconcileExternalWorktreeSnapshot).mockClear();
      jest.mocked(sendToAllWindows).mockClear();
      await foreignCommit(() =>
        removeWorkspaceWorktrees('multi', (row) => row.id === 'm2'),
      );
      expect(applied.at(-1)).toMatchObject({ worktreeLists: ['multi'] });
      // CAN-7156: another origin's list commit gets the outside-change
      // cleanup from the committed rows and reloads the renderer's projects.
      expect(
        jest
          .mocked(reconcileExternalWorktreeSnapshot)
          .mock.calls.map(([id, rows]) => [id, rows.map((row) => row.id)]),
      ).toEqual([['multi', ['m1']]]);
      expect(jest.mocked(sendToAllWindows).mock.calls).toEqual([
        [IPC_CHANNELS.workspaceWorktreesUpdated, { workspaceId: 'multi' }],
      ]);
      await expectRefusalConfirmed(admits('multi', 'm2'));
      await expectServed(admits('multi', 'm1'));
    });

    test('a foreign removal is refused once the native watch dirties the list', async () => {
      writeFileSync(
        join(workspaces, 'multi', 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [ROW('m1', { includedRepoIds: ['api'] })],
        }),
      );
      readCache.markDirty([{ kind: 'worktrees', workspaceId: 'multi' }]);
      const refused = await run(admits('multi', 'm2'));
      expect(refused.value).toBe(false);
      expect(refused.w5['readView.cachedDirect']).toBeUndefined();
      expect((await today(admits('multi', 'm2'))).value).toBe(false);
    });

    test.each([
      [
        'a row another origin just created',
        'multi',
        'm3',
        (): Promise<unknown> =>
          writeWorkspaceWorktrees('multi', [
            ROW('m1', { includedRepoIds: ['api'] }),
            ROW('m2'),
            ROW('m3'),
          ]),
      ],
      [
        'a git-pending row another origin just settled',
        'single',
        's2',
        (): Promise<unknown> =>
          updateWorkspaceWorktree('single', 's2', (row) => ({
            ...row,
            setupPhase: 'git-ready',
          })),
      ],
    ])(
      '%s is admitted before the cache hears of it',
      async (_label, projectId, worktreeId, write) => {
        const acked = acks.length;
        let open = (): void => undefined;
        stepGate = new Promise<void>((resolve) => {
          open = resolve;
        });
        __setDesktopW5FileStoreForTests(foreignStore);
        try {
          await write();
        } finally {
          __setDesktopW5FileStoreForTests(electron);
        }
        try {
          // The served image still refuses the row.
          const stale = await run(listReader(projectId));
          expect(stale.w5['readView.cachedDirect']).toBe(1);
          const staleRow = stale.value.worktrees.find(
            (row) => row.id === worktreeId,
          );
          expect(!staleRow || staleRow.setupPhase === 'git-pending').toBe(true);
          const admitted = await run(admits(projectId, worktreeId));
          expect(admitted.value).toBe(true);
          expect(admitted.w5).toMatchObject({
            'readView.cachedDirect': 1,
            'readView.cacheMiss.unaccepted': 1,
          });
          expect(admitted.reads).toEqual([
            join(workspaces, projectId, 'worktrees.json'),
          ]);
        } finally {
          __setDesktopW5FileStoreForTests(undefined);
          try {
            open();
            await until(() => acks.length > acked);
          } finally {
            stepGate = undefined;
            __setDesktopW5FileStoreForTests(electron);
          }
        }
        // Once the plan lands, the cache admits the row itself.
        await expectServed(admits(projectId, worktreeId));
      },
    );

    describe('every bypass admits through today’s read with no view', () => {
      test('unregistered, as where the cache is not selected', async () => {
        registerDesktopW5ReadCacheServer(undefined);
        const read = await run(admits('single', 's1'));
        expect(read.value).toBe(true);
        expect(read.reads).toHaveLength(1);
        expect(read.w5['readView.cachedDirect']).toBeUndefined();
      });

      test('a test store', async () => {
        const read = await run(() => {
          __setDesktopW5FileStoreForTests(electron);
          return admits('single', 's1')();
        });
        expect(read.value).toBe(true);
        expect(read.w5['readView.cachedDirect']).toBeUndefined();
      });

      test('not ready', async () => {
        readCache.revoke();
        await expectToday(admits('single', 's1'));
      });

      test('retired', async () => {
        readCache.dispose();
        await expectToday(admits('single', 's1'));
      });

      test('a commit scope', async () => {
        await expectToday(() =>
          withW5Commit({ operation: 'seam-b.admission' }, () =>
            admits('single', 's1')(),
          ),
        );
      });

      test('an outer view', async () => {
        await expectToday(() =>
          runInW5UncapturedView('direct-store', () => admits('single', 's1')()),
        );
      });

      test('a writer lease in flight', async () => {
        let release = (): void => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let holding = (): void => undefined;
        const taken = new Promise<void>((resolve) => {
          holding = resolve;
        });
        const lease = withW5RepositoryLock(
          {
            kind: 'list',
            path: join(workspaces, 'unlisted', 'worktrees.json'),
          },
          () => {
            holding();
            return held;
          },
        );
        await taken;
        try {
          const read = await run(admits('single', 's1'));
          expect(read.value).toBe(true);
          expect(read.w5['readView.cacheMiss.writing']).toBe(1);
          expect(read.w5['readView.cachedDirect']).toBeUndefined();
          expect(read.reads).toHaveLength(1);
        } finally {
          release();
          await lease;
        }
      });
    });
  });

  // Last: the poller's git-ready hook stays installed for the rest of the file.
  test("the GitHub poller's git-ready list lookup reads the cached list", async () => {
    const wasE2e: unknown = Reflect.get(globalThis, '__CANOPY_E2E__');
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      value: true,
      configurable: true,
      writable: true,
    });
    startPolling(() => null);
    // No sweep or refresh timer runs; the hook still enrolls.
    stopPolling();
    const ready = (worktreeId: string) => (): Promise<void> =>
      publishWorktreeGitReady({
        projectId: 'single',
        worktreeId,
        workspaceKind: 'single-repo',
        branchName: `branch-${worktreeId}`,
      });
    const tracked = (worktreeId: string): boolean =>
      getTrackedPrSnapshotLocations().some(
        (location) =>
          location.projectId === 'single' && location.worktreeId === worktreeId,
      );
    const list = join(workspaces, 'single', 'worktrees.json');
    try {
      expect(tracked('s2')).toBe(false);
      const expected = await today(ready('s2'));
      expect(tracked('s2')).toBe(true);
      expect(expected.reads).toEqual([list]);
      expect(snapshotWorkCounters().w5Caller).toMatchObject({
        'background:github-poller.storeRead': 1,
      });
      expect(tracked('s1')).toBe(false);
      const served = await run(ready('s1'));
      expect(tracked('s1')).toBe(true);
      expect(served.captures).toBe(0);
      expect(served.reads).toEqual([]);
      expect(served.w5['readView.cachedDirect']).toBe(1);
      expect(
        Object.keys(snapshotWorkCounters().w5Caller).filter((key) =>
          key.startsWith('background:github-poller.'),
        ),
      ).toEqual([]);
      // A row the cached list does not hold enrolls nothing, as today.
      const missing = await run(ready('gone'));
      expect(missing.w5['readView.cachedDirect']).toBe(1);
      expect(tracked('gone')).toBe(false);
    } finally {
      Object.defineProperty(globalThis, '__CANOPY_E2E__', {
        value: wasE2e,
        configurable: true,
        writable: true,
      });
    }
  });
});

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly value: { name: string; message: string } };

async function settledRead<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return {
      ok: false,
      value:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'thrown', message: String(error) },
    };
  }
}

/** Resolves or rejects as today's read does, capturing nothing. */
async function expectSettledAsToday<T>(
  read: () => Promise<T>,
): Promise<{ readonly served: ReadRun<Settled<T>['value']> }> {
  const expected = await today(() => settledRead(read));
  const settled = await run(() => settledRead(read));
  expect(settled.value).toEqual(expected.value);
  return { served: { ...settled, value: settled.value.value } };
}
