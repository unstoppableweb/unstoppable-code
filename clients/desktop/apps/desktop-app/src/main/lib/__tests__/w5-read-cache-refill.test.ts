import type * as LegacyStorage from './fixtures/w5-legacy-storage';
import type * as NativeFs from 'node:fs';
import type * as AsyncFs from 'node:fs/promises';
// CAN-7155 (W5 readers S-9, PR 2): the read cache's W5e step, broad refill
// and warm, driven by main's real binding over the real bridge, `core.events`
// module, W5e event source, record port and commit-log worker. Another
// origin's commit lands in the cache before any handler runs and before its
// delivery is acknowledged; a refill that won the race skips its capture;
// replay, eviction, lag, a snapshot racing the open, an invalidation and a
// new log all refill broadly. A broad refill rebuilds the projection, so a
// new log at an equal commit id is replaced too; fewer abandoned commits show
// one to any capture. A19 (CAN-3798 D3) is pinned: the stale window closes on
// delivery, with no timer, and the issuing desktop reads its own write at
// once. The bridge's retry delay is injected far out of reach and
// the cache's timers only fire when a case fires them, so no timer can help.
// Own decisions share one trailing refill, pushed back for at most 8 delays,
// and none runs during the warm; a file over the capture limits, a log with
// unresolved commits and an entry no capture admits stop idle retries until
// something names them again. A failed broad refill, whole or partway through
// its split, leaves nothing served and the cache not ready until a broad retry
// completes; a failed targeted capture stops serving only its files.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  watch,
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
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof AsyncFs>('node:fs/promises'),
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
jest.mock('../window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import {
  IPC_CHANNELS,
  type WorktreeData,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  CanopyClientError,
  planCanopyWorkspaceInvalidation,
  type CanopyEventsConnection,
  type CanopyWorkspaceInvalidationPlan,
} from '@canopy/core-client';
import {
  W5_CAPTURE_LIMITS,
  type W5CaptureFile,
  type W5CaptureRequest,
} from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import {
  classifyW5FileProvenance,
  classifyW5RevisionEligibility,
} from '@canopy/core-runtime/node/w5/commit-log/eligibility';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { W5_READ_CACHE_IDLE_RETRIES } from '@canopy/core-runtime/node/w5/committed-read-cache';
import {
  CORE_WORKSPACE_INVALIDATED_EVENT,
  CORE_WORKSPACE_RECORDS_LIMITS,
} from '@canopy/protocol/canopy-core';
import {
  createDesktopW5ReadCache,
  W5_READ_CACHE_REFRESH_MS,
  type DesktopW5ReadCache,
  type W5ReadCacheSchedule,
} from '../../canopy-runtime/w5-read-cache';
import {
  registerDesktopW5ReadCacheServer,
  runDesktopW5CachedReadView,
} from '../../canopy-runtime/w5-cached-workspace-services';
import { defaultCoreWorkspaceReadServices } from '../../canopy-runtime/core-workspace-adapter';
import { createElectronDaemonHealth } from '../../canopy-runtime/electron-daemon-health';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import {
  createWorkspaceCommitEventBinding,
  type WorkspaceCommitEventBinding,
} from '../../canopy-runtime/workspace-commit-events';
import {
  startW5HostedMetadataHarness,
  type W5HostedEventsClient,
  type W5HostedMetadataHarness,
  type W5HostedMetadataHarnessOptions,
} from './fixtures/w5-hosted-metadata-harness';
import {
  __setDesktopW5FileStoreForTests,
  installDesktopW5FileStore,
  runW5ReadView,
} from '../w5-commit-log-file-store';
import type { W5RecordPortClient } from '../w5-daemon-record-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../w5-daemon-record-store';
import {
  resetWorkCounters,
  runWithW5Caller,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { nodeW5FileStore } from '../w5-file-store';
import {
  WORKSPACE_MANIFEST_STORAGE,
  withStorageAdmission,
} from '../w5-storage';
import { withW5RepositoryLock } from '../w5-repository-locks';
import {
  writeWorkspaceConfig,
  writeWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
} from '../workspace-persistence';
import { getWorkspaceIndexRepository } from '../sidebar-items';
import { createWorktreeWatch } from '../worktree-watch-recovery';
import { sendToWindow } from '../window-send';
import {
  stopWorktreesFileWatchers,
  syncWorktreesFileWatchers,
} from '../worktrees-file-watcher';

jest.setTimeout(120_000);

const WORKER = join(__dirname, 'fixtures/w5-commit-log-source-worker.ts');
const MANIFEST = { kind: 'manifest', workspaceId: 'a' } as const;
const CONFIG: WorkspaceConfigFile = {
  version: 1,
  type: 'multi-repo',
  repos: [],
};
// Injected clock: no bridge retry fires within a test. The bridge's recovery
// ceiling (128x) must stay under Node's 2^31 ms timer limit.
const NEVER_MS = 16_000_000;
// The cache's delays, as its injected scheduler receives them. The retry
// backoff (1,001 ms doubling to 60 s) never equals the own-refill delay; the
// push-back ceiling (8x that delay) reads the injected clock.
const RETRY_MS = 1_001;
const OWN_MS = 120_000;

/** A timer the cache scheduled; it runs only when a case fires it. */
interface Timer {
  readonly ms: number;
  readonly run: () => Promise<void>;
  live: boolean;
}
let timers: Timer[];
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
let directoryWatches: Map<string, DirectoryWatch>;
let failedWatches: Set<string>;
let nativeMissingWatches: Set<string>;
function directoryWatch(id?: string): DirectoryWatch {
  const directory = id ? join(dir, 'workspaces', id) : join(dir, 'workspaces');
  const watcher = directoryWatches.get(directory);
  expect(watcher?.closed).toBe(false);
  if (!watcher) throw new Error(`No cache invalidation watch for ${directory}`);
  return watcher;
}
/** The cache's clock; only a case moves it. */
let clock: number;
const schedule: W5ReadCacheSchedule = (run, ms) => {
  const timer: Timer = { ms, run, live: true };
  timers.push(timer);
  return () => {
    timer.live = false;
  };
};
const own = (timer: Timer): boolean => timer.ms === OWN_MS;
const retry = (timer: Timer): boolean => !own(timer);
const live = (kind: (timer: Timer) => boolean): Timer[] =>
  timers.filter((timer) => timer.live && kind(timer));
/** Fires the one live timer of `kind` and waits for its refill. */
async function fire(kind: (timer: Timer) => boolean): Promise<void> {
  const pending = live(kind);
  expect(pending).toHaveLength(1);
  const [timer] = pending;
  if (!timer) return;
  timer.live = false;
  await timer.run();
}

interface Deferred {
  readonly promise: Promise<void>;
  open(): void;
}
function deferred(): Deferred {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let dir: string;
let harness: W5HostedMetadataHarness;
let records: W5RecordPortClient;
let electron: W5CommitLogFileStore;
let foreignStore: W5CommitLogFileStore;
let readCache: DesktopW5ReadCache;
let binding: WorkspaceCommitEventBinding;
let restore: () => void;
let originalDataDir: string | undefined;
let captures: W5CaptureRequest[];
let coverageAtCapture: string[][];
/** Plans the binding applied, in order, and what each handler saw. */
let applied: CanopyWorkspaceInvalidationPlan[];
let seen: { handler: string; commitId: number | undefined }[];
let acks: number[];
let stepGate: Deferred | undefined;
let handlerGate: Deferred | undefined;
let handlerFailure: boolean;
let bridgeRetryMs: number;
let beforeOpen: (() => Promise<void>) | undefined;
let afterOpen: (() => Promise<void>) | undefined;
/** A slow consumer's subscribe window, so a test can make it lag. */
let maxInFlight: number | undefined;
/** The daemon health latch, as the cache reads it. */
let usable: boolean;
let healthFailure: (() => void) | undefined;
let healthRecovery: (() => void) | undefined;
/** Holds the cache's next captures until opened. */
let captureGate: Deferred | undefined;
/** Holds discovery (broad) captures until opened; targeted captures pass. */
let discoveryGate: Deferred | undefined;
/** Captures report this many unresolved commits, as a log awaiting recovery. */
let unresolved: number | undefined;
/** Captures this matches reject, as a daemon that cannot answer them. */
let failing: ((request: W5CaptureRequest) => boolean) | undefined;
/** Captures report abandoned history, as a log that lost a commit. */
let abandoned: boolean;
/** A typed authority refusal, below every host capture consumer. */
let captureRefusal: string | undefined;
let endStream: (() => void) | undefined;
const waiters = new Set<() => void>();

/** Resolves once `ready` holds; rechecked after every plan and ack. */
function until(ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = (): void => {
      if (!ready()) return;
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
  });
}
const wake = (): void => {
  for (const waiter of Array.from(waiters)) waiter();
};

async function start(
  options: Partial<W5HostedMetadataHarnessOptions> = {},
): Promise<void> {
  harness = await startW5HostedMetadataHarness({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root: join(dir, 'workspaces'),
    workerEntry: WORKER,
    daemonOwned: ['workspace_index', 'workspace_manifest', 'worktree_list'],
    ...options,
  });
  records = await harness.connectRecords('electron-main');
  foreignStore = createW5DaemonRecordStore({
    root: harness.root,
    transport: w5RecordPortTransport(await harness.connectRecords('cli')),
  });
}

/** A wrapped events connection that records acks and can act before opening. */
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
    openStream: async (name, params, options) => {
      const hook = beforeOpen;
      beforeOpen = undefined;
      await hook?.();
      endStream = (): void =>
        options?.onFrame?.({
          kind: 'end',
          cursor: { daemonEpoch: client.identity.daemonEpoch, sequence: 0 },
          outcome: 'completed',
          error: null,
        });
      const handle = await client.openStream(
        name,
        maxInFlight === undefined ? params : { ...params, maxInFlight },
        options,
      );
      const opened = afterOpen;
      afterOpen = undefined;
      await opened?.();
      return handle;
    },
    instruction: async (name, params, options) => {
      const result = await client.instruction(name, params, options);
      acks.push(params.cursor.sequence);
      wake();
      return result;
    },
  };
}

async function attach(): Promise<W5HostedEventsClient> {
  const client = await harness.connectEvents('electron-main');
  await binding.attach(connection(client));
  return client;
}

/** Writes manifest `a`; resolves the commit id the daemon's host decided. */
async function write(config: Partial<WorkspaceConfigFile>): Promise<number> {
  let commitId: number | undefined;
  harness.hooks.commit.after = (_request, outcome): Promise<void> => {
    if (outcome.status === 'applied') commitId = outcome.commitId;
    return Promise.resolve();
  };
  try {
    await writeWorkspaceConfig('a', { ...CONFIG, ...config });
  } finally {
    harness.hooks.commit.after = undefined;
  }
  if (commitId === undefined) throw new Error('Nothing was applied');
  return commitId;
}

/** A commit another origin makes through the daemon (the CLI, say). */
async function foreignWrite(
  config: Partial<WorkspaceConfigFile>,
): Promise<number> {
  __setDesktopW5FileStoreForTests(foreignStore);
  try {
    return await write(config);
  } finally {
    __setDesktopW5FileStoreForTests(electron);
  }
}

const BROAD = {
  broad: true,
  index: false,
  workspaces: [],
  manifests: [],
  worktreeLists: [],
} as const;

/** `ready()` as production asks it: the test store stands aside meanwhile. */
function ready(): boolean {
  __setDesktopW5FileStoreForTests(undefined);
  try {
    return readCache.ready();
  } finally {
    __setDesktopW5FileStoreForTests(electron);
  }
}

const cached = (): W5CaptureFile[] => readCache.cache.projection().files();
const discoveries = (): number =>
  captures.filter((request) => request.discoverWorkspaces).length;

/** Every cached file answers as a fresh capture of it does. */
async function expectFresh(files = cached()): Promise<void> {
  if (!electron.capture) throw new Error('The daemon-backed store captures');
  const { capture: fresh } = await electron.capture({
    files,
    discoverWorkspaces: false,
  });
  const projection = readCache.cache.projection();
  for (const file of files) {
    expect(projection.state(file)).toBe('current');
    expect(projection.image(file)).toEqual(
      fresh.files.find(
        (image) =>
          image.kind === file.kind &&
          ('workspaceId' in image ? image.workspaceId : null) ===
            ('workspaceId' in file ? file.workspaceId : null),
      ),
    );
    expect(projection.provenance(file)).toEqual(
      classifyW5FileProvenance(fresh, file),
    );
  }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5-read-cache-refill-')));
  for (const id of ['a', 'b'])
    mkdirSync(join(dir, 'workspaces', id), { recursive: true });
  writeFileSync(
    join(dir, 'workspaces', 'index.json'),
    JSON.stringify({ version: 1, workspaces: [{ id: 'a' }, { id: 'b' }] }),
  );
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dir;
  captures = [];
  coverageAtCapture = [];
  applied = [];
  seen = [];
  acks = [];
  stepGate = undefined;
  handlerGate = undefined;
  handlerFailure = false;
  bridgeRetryMs = NEVER_MS;
  beforeOpen = undefined;
  afterOpen = undefined;
  maxInFlight = undefined;
  usable = true;
  healthFailure = undefined;
  healthRecovery = undefined;
  captureGate = undefined;
  discoveryGate = undefined;
  unresolved = undefined;
  failing = undefined;
  abandoned = false;
  captureRefusal = undefined;
  endStream = undefined;
  timers = [];
  directoryWatches = new Map();
  failedWatches = new Set();
  nativeMissingWatches = new Set();
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
        const directory = String(path);
        if (failedWatches.has(directory))
          throw new Error('Watch creation failed');
        // Missing-directory probes exercise the native ENOENT enrollment path.
        if (nativeMissingWatches.has(directory) && !existsSync(directory))
          return jest
            .requireActual<typeof NativeFs>('node:fs')
            .watch(directory);
        const watcher = new DirectoryWatch();
        if (typeof options === 'function') watcher.on('change', options);
        else if (listener) watcher.on('change', listener);
        directoryWatches.set(directory, watcher);
        return watcher;
      },
    );
  clock = 0;
  readCache = createDesktopW5ReadCache({
    usable: () => usable,
    onUnavailable: (revoke, recover) => {
      healthFailure = revoke;
      healthRecovery = recover;
      return (): void => {
        healthFailure = undefined;
        healthRecovery = undefined;
      };
    },
    retryFirstMs: RETRY_MS,
    ownRefillMs: OWN_MS,
    schedule,
    now: () => clock,
  });
  readCache.setStreamReady(true);
});

/** The harness, Electron's store and the binding; the cache warms on activate. */
async function compose(
  options: Partial<W5HostedMetadataHarnessOptions> = {},
): Promise<void> {
  await readCache.activate(await prepare(options));
}

/** As `compose`, but resolves the counted store without activating the cache. */
async function prepare(
  options: Partial<W5HostedMetadataHarnessOptions> = {},
): Promise<W5CommitLogFileStore> {
  await start(options);
  const transport = w5RecordPortTransport(() => Promise.resolve(records));
  const store = createW5DaemonRecordStore({
    root: harness.root,
    transport: {
      ...transport,
      capture: (request) => {
        if (captureRefusal)
          return Promise.reject(
            new CanopyClientError({
              kind: 'failed_precondition',
              code: 'core.workspaceRecords.captureRefused',
              message: 'The W5 records cannot be read.',
              retry: { kind: 'never' },
              details: { capture: captureRefusal },
            }),
          );
        return transport.capture(request);
      },
    },
    projection: readCache,
  });
  electron = store;
  restore = installW5DaemonRecordStoreForTests(store);
  const counted: W5CommitLogFileStore = {
    ...store,
    capture: async (request) => {
      captures.push(request);
      coverageAtCapture.push(
        Array.from(directoryWatches.entries()).flatMap(([path, watch]) =>
          watch.closed ? [] : [path],
        ),
      );
      wake();
      await captureGate?.promise;
      if (request.discoverWorkspaces) await discoveryGate?.promise;
      if (failing?.(request)) throw new Error('The capture failed');
      if (!store.capture) throw new Error('The daemon-backed store captures');
      const result = await store.capture(request);
      if (unresolved === undefined && !abandoned) return result;
      const { log } = result.capture;
      return {
        ...result,
        capture: {
          ...result.capture,
          log: {
            ...log,
            ...(unresolved !== undefined && { unresolvedCommits: unresolved }),
            ...(abandoned && { retainedCommits: log.commitId - 1 }),
          },
        },
      };
    },
  };
  const note = (handler: string) => (): void => {
    seen.push({
      handler,
      commitId: readCache.cache.projection().commitId(MANIFEST),
    });
    wake();
  };
  binding = createWorkspaceCommitEventBinding({
    isOwnOrigin: (id) => id === 'electron-main',
    retryDelayMs: bridgeRetryMs,
    onStreamChanged: (ready) => {
      readCache.setStreamReady(ready);
      wake();
    },
    onInvalidated: () => readCache.revoke(),
    readCache: async (plan) => {
      await stepGate?.promise;
      await readCache.apply(plan);
      applied.push(plan);
      wake();
    },
    handlers: {
      scheduleDesktopStructureChanged: note('scheduleDesktopStructureChanged'),
      refreshWorkspaceRegistries: async () => {
        note('refreshWorkspaceRegistries')();
        await handlerGate?.promise;
        if (handlerFailure) throw new Error('Registry refresh failed');
      },
      reconcileManifestPluginDefaults: () => Promise.resolve(),
      listWorkspaceIds: () => ['a', 'b'],
      readWorktreeList: () =>
        Promise.resolve({ authority: 'absent', worktrees: [] }),
      publishWorktreeListWrite: () => undefined,
      publishWorktreeMembershipChange: note('publishWorktreeMembershipChange'),
    },
  });
  return counted;
}

afterEach(async () => {
  // A failed case may leave a plan waiting on its gate.
  stepGate?.open();
  handlerGate?.open();
  captureGate?.open();
  discoveryGate?.open();
  await binding.close();
  readCache.dispose();
  await settleDetachedWork();
  restore();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await harness.close();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('the read cache over W5e (CAN-7155)', () => {
  describe('cache-owned native invalidation coverage', () => {
    const caller = {
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test' as const,
      grants: ['core.workspace.read' as const, 'core.worktree.read' as const],
    };
    const row = {
      id: 'manual',
      branchName: 'manual',
      createdAt: '2026-11-01T00:00:00Z',
    };
    const index = (ids: readonly string[]): void =>
      writeFileSync(
        join(dir, 'workspaces', 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: ids.map((id, order) => ({
            id,
            name: id,
            type: id === 'b' ? 'cowork' : 'multi-repo',
            color: '#7C3AED',
            collapsed: false,
            order,
          })),
        }),
      );
    const seed = (): void => {
      index(['a', 'b']);
      writeFileSync(
        join(dir, 'workspaces', 'a', 'workspace.json'),
        JSON.stringify({ ...CONFIG, temporary: true }),
      );
      writeFileSync(
        join(dir, 'workspaces', 'b', 'workspace.json'),
        JSON.stringify({ version: 1, type: 'cowork' }),
      );
      for (const id of ['a', 'b'])
        writeFileSync(
          join(dir, 'workspaces', id, 'worktrees.json'),
          JSON.stringify({ version: 1, worktrees: [] }),
        );
    };
    const serve = async (
      files: readonly W5CaptureFile[],
      discoverWorkspaces = false,
    ): Promise<boolean> => {
      __setDesktopW5FileStoreForTests(undefined);
      try {
        return (
          (await readCache.serve({ files, discoverWorkspaces })) !== undefined
        );
      } finally {
        __setDesktopW5FileStoreForTests(electron);
      }
    };
    async function withReaders(
      run: (
        cached: DesktopCanopyDispatcher,
        today: DesktopCanopyDispatcher,
      ) => Promise<void>,
    ): Promise<void> {
      installDesktopW5FileStore(electron);
      registerDesktopW5ReadCacheServer(readCache);
      const cached = createDesktopRuntime({
        workspaceServices: {
          ...defaultCoreWorkspaceReadServices(),
          readView: runDesktopW5CachedReadView,
        },
      });
      const today = createDesktopRuntime();
      __setDesktopW5FileStoreForTests(undefined);
      try {
        await run(cached, today);
      } finally {
        __setDesktopW5FileStoreForTests(electron);
        registerDesktopW5ReadCacheServer(undefined);
        await Promise.all([cached.shutdown(), today.shutdown()]);
      }
    }
    test('health recovery on the same quiet stream coalesces a broad refill before the next cached read', async () => {
      await compose();
      await attach();
      const health = createElectronDaemonHealth({
        warn: jest.fn(),
        info: jest.fn(),
      });
      health.setConsumerEnabled('workspace_records', true);
      health.observe({ kind: 'reached' });
      health.onStatusChanged((status) => {
        usable = status.state === 'ok' && !health.isLatched();
        if (usable) healthRecovery?.();
        else healthFailure?.();
      });
      await withReaders(async (cached, today) => {
        const expected = await today.queryWorkspaceListForLegacyIpc(
          {},
          { caller },
        );
        expect(readCache.ready()).toBe(true);
        expect(live(own)).toHaveLength(0);
        health.observe({ kind: 'unreachable', reason: 'host_unavailable' });
        expect(readCache.ready()).toBe(false);
        const before = captures.length;
        const plans = applied.length;
        const acknowledged = acks.length;
        const broad = discoveries();
        // Try again can confirm an already-active lease without reopening events.
        await health.retry(() => Promise.resolve(true));
        healthRecovery?.();
        expect(readCache.ready()).toBe(false);
        expect(captures).toHaveLength(before);
        expect(live(own)).toHaveLength(1);
        await fire(own);
        expect(discoveries()).toBe(broad + 1);
        expect(readCache.ready()).toBe(true);
        expect(applied).toHaveLength(plans);
        expect(acks).toHaveLength(acknowledged);
        const refilled = captures.length;
        const served = jest.spyOn(readCache, 'serve');
        expect(
          await cached.queryWorkspaceListForLegacyIpc({}, { caller }),
        ).toEqual(expected);
        expect(served).toHaveBeenCalledTimes(1);
        await expect(served.mock.results[0]?.value).resolves.toBeDefined();
        served.mockRestore();
        expect(captures).toHaveLength(refilled);
        expect(live(own)).toHaveLength(0);
      });
    });

    test('healthy retry status changes do not schedule health recovery while already serving', async () => {
      await compose();
      await attach();
      const health = createElectronDaemonHealth({
        warn: jest.fn(),
        info: jest.fn(),
      });
      health.setConsumerEnabled('workspace_records', true);
      health.observe({ kind: 'reached' });
      const retries: string[] = [];
      health.onStatusChanged((status) => {
        retries.push(status.retry);
        usable = status.state === 'ok' && !health.isLatched();
        if (usable) healthRecovery?.();
        else healthFailure?.();
      });
      expect(ready()).toBe(true);
      const before = captures.length;
      const scheduled = timers.length;
      await health.retry(() => Promise.resolve(true));
      health.observe({ kind: 'reached' });
      expect(retries).toEqual(['running', 'idle']);
      expect(ready()).toBe(true);
      expect(captures).toHaveLength(before);
      expect(timers).toHaveLength(scheduled);
      expect(live(own)).toHaveLength(0);
    });

    test.each(['hidden-list', 'cowork-list', 'manifest'] as const)(
      '%s: notification invalidates before the next dispatcher read',
      async (change) => {
        seed();
        await compose();
        const id = change === 'cowork-list' ? 'b' : 'a';
        const kind = change === 'manifest' ? 'manifest' : 'worktrees';
        const filename =
          kind === 'manifest' ? 'workspace.json' : 'worktrees.json';
        const file: W5CaptureFile = { kind, workspaceId: id };
        // Neither hidden temporary nor Cowork workspaces is enrolled by the sidebar watcher.
        const watcher = directoryWatch(id);
        expect(await serve([file])).toBe(true);
        if (change === 'hidden-list')
          await withReaders(async (cached) => {
            const before = await cached.queryWorkspaceListForLegacyIpc(
              {},
              { caller },
            );
            const hidden = before.legacyResult.items.find(
              (item) => item.id === 'a',
            );
            if (!hidden) throw new Error('The temporary workspace is indexed');
            expect(isRetiredTemporaryWorkspace(hidden)).toBe(true);
          });
        writeFileSync(
          join(dir, 'workspaces', id, filename),
          JSON.stringify(
            kind === 'manifest'
              ? { ...CONFIG, temporary: true, alwaysShow: true }
              : { version: 1, worktrees: [row] },
          ),
        );
        watcher.emit('change', 'change', filename);
        expect(readCache.cache.projection().state(file)).toBe('dirty');
        expect(await serve([file])).toBe(false);
        await withReaders(async (cached, today) => {
          const read = (runtime: DesktopCanopyDispatcher): Promise<unknown> =>
            kind === 'manifest'
              ? runtime.queryWorkspaceGetForLegacyIpc(
                  { workspaceId: id },
                  { caller },
                )
              : runtime.readWorktreeListForLegacy(id, { caller });
          const expected = await read(today);
          expect(await read(cached)).toEqual(expected);
          if (kind === 'manifest')
            expect(expected).toMatchObject({
              legacyResult: { alwaysShow: true },
            });
          else
            expect(expected).toMatchObject({
              legacyResult: [expect.objectContaining({ id: row.id })],
            });
          if (change === 'hidden-list') {
            const reloaded = await cached.queryWorkspaceListForLegacyIpc(
              {},
              { caller },
            );
            const visible = reloaded.legacyResult.items.find(
              (item) => item.id === 'a',
            );
            if (!visible) throw new Error('The temporary workspace is indexed');
            expect(isRetiredTemporaryWorkspace(visible)).toBe(false);
            expect(reloaded).toEqual(
              await today.queryWorkspaceListForLegacyIpc({}, { caller }),
            );
          }
        });
        await fire(own);
        expect(await serve([file])).toBe(true);
        await expectFresh([file]);
      },
    );

    test('index notification refreshes discovery and enrolls a workspace added out of band', async () => {
      seed();
      await compose();
      mkdirSync(join(dir, 'workspaces', 'c'));
      writeFileSync(
        join(dir, 'workspaces', 'c', 'workspace.json'),
        JSON.stringify(CONFIG),
      );
      writeFileSync(
        join(dir, 'workspaces', 'c', 'worktrees.json'),
        JSON.stringify({ version: 1, worktrees: [row] }),
      );
      index(['a', 'b', 'c']);
      directoryWatch().emit('change', 'change', 'index.json');
      expect(await serve([], true)).toBe(false);
      await withReaders(async (cached, today) => {
        const expected = await today.queryWorkspaceListForLegacyIpc(
          {},
          { caller },
        );
        expect(expected.legacyResult.items.map((item) => item.id)).toContain(
          'c',
        );
        expect(
          await cached.queryWorkspaceListForLegacyIpc({}, { caller }),
        ).toEqual(expected);
      });
      await fire(own);
      // Discovery's new files may need the existing coalesced miss refresh.
      if (live(retry).length) await fire(retry);
      if (live(own).length) await fire(own);
      directoryWatch('c');
      await readCache.apply(BROAD);
      expect(await serve([], true)).toBe(true);
      await expectFresh();
    });

    test.each(['creation', 'error', 'close'] as const)(
      '%s failure falls back and re-enrollment fences old captures',
      async (failure) => {
        seed();
        const path = join(dir, 'workspaces', 'a');
        if (failure === 'creation') failedWatches.add(path);
        await compose();
        if (failure !== 'creation') {
          const watcher = directoryWatch('a');
          if (failure === 'error')
            watcher.emit('error', new Error('Watch lost'));
          else watcher.close();
          failedWatches.add(path);
        }
        const file: W5CaptureFile = { kind: 'worktrees', workspaceId: 'a' };
        expect(await serve([file])).toBe(false);
        expect(await serve([], true)).toBe(false);
        // Coverage loss revokes the whole serving token.
        expect(await serve([{ kind: 'manifest', workspaceId: 'b' }])).toBe(
          false,
        );
        writeFileSync(
          join(path, 'worktrees.json'),
          JSON.stringify({ version: 1, worktrees: [row] }),
        );
        await withReaders(async (cached, today) => {
          expect(
            await cached.readWorktreeListForLegacy('a', { caller }),
          ).toEqual(await today.readWorktreeListForLegacy('a', { caller }));
        });
        // Enrollment starts a broad refill at once. Hold it, so its token
        // cannot race the targeted refill's check.
        expect(readCache.cache.rebuilding()).toBe(false);
        discoveryGate = deferred();
        const broad = discoveries();
        failedWatches.delete(path);
        // Enrolling on a read must not bless bytes captured without the watch.
        expect(await serve([file])).toBe(false);
        expect(readCache.cache.rebuilding()).toBe(true);
        directoryWatch('a');
        expect(readCache.cache.projection().state(file)).toBe('dirty');
        await readCache.cache.refillMarked();
        await until(() => discoveries() > broad);
        // A targeted refill cannot re-arm a revoked serving token.
        expect(await serve([file])).toBe(false);
        // Enrollment's broad refill issues a token newer than the coverage
        // loss; the own refill joins it.
        discoveryGate.open();
        await fire(own);
        expect(await serve([file])).toBe(true);
        await expectFresh([file]);
      },
    );

    test.each(['missing', 'handles'] as const)(
      'unavailable coverage (%s) bounds broad completions and keeps reads fresh',
      async (failure) => {
        seed();
        const path = join(dir, 'workspaces', 'a');
        if (failure === 'missing') {
          rmSync(path, { recursive: true });
          nativeMissingWatches.add(path);
        } else failedWatches.add(path);
        await compose();
        const count = discoveries();
        for (let run = 0; run < W5_READ_CACHE_IDLE_RETRIES; run += 1)
          await fire(retry);
        expect(discoveries()).toBe(count + W5_READ_CACHE_IDLE_RETRIES);
        expect(live(retry)).toHaveLength(0);
        expect(readCache.cache.owed()).toBe(false);
        expect(ready()).toBe(false);
        const stopped = captures.length;
        await withReaders(async (cached, today) => {
          for (let read = 0; read < 2; read += 1) {
            expect(
              await cached.queryWorkspaceListForLegacyIpc({}, { caller }),
            ).toEqual(
              await today.queryWorkspaceListForLegacyIpc({}, { caller }),
            );
            expect(
              await cached.readWorktreeListForLegacy('a', { caller }),
            ).toEqual(await today.readWorktreeListForLegacy('a', { caller }));
          }
        });
        expect(captures).toHaveLength(stopped);
        expect(readCache.cache.owed()).toBe(false);
        expect(live(retry)).toHaveLength(0);

        // Revocation owes a new attempt but is not a capture or timer driver.
        readCache.revoke();
        expect(readCache.cache.owed()).toBe(true);
        expect(captures).toHaveLength(stopped);
        expect(live(retry)).toHaveLength(0);
        // An existing W5e plan supplies that attempt, promoted to broad.
        await readCache.apply({ ...BROAD, broad: false, manifests: ['b'] });
        for (let run = 1; run < W5_READ_CACHE_IDLE_RETRIES; run += 1)
          await fire(retry);
        expect(discoveries()).toBe(count + W5_READ_CACHE_IDLE_RETRIES * 2);
        expect(readCache.cache.owed()).toBe(false);
        expect(live(retry)).toHaveLength(0);
      },
    );

    test('enrollment after the idle bound starts exactly one broad refill without firing a timer', async () => {
      seed();
      const path = join(dir, 'workspaces', 'a');
      rmSync(path, { recursive: true });
      nativeMissingWatches.add(path);
      await compose();
      for (let run = 0; run < W5_READ_CACHE_IDLE_RETRIES; run += 1)
        await fire(retry);
      expect(readCache.cache.owed()).toBe(false);
      const before = discoveries();
      mkdirSync(path);
      writeFileSync(join(path, 'workspace.json'), JSON.stringify(CONFIG));
      writeFileSync(
        join(path, 'worktrees.json'),
        JSON.stringify({ version: 1, worktrees: [row] }),
      );
      const file: W5CaptureFile = { kind: 'worktrees', workspaceId: 'a' };
      expect(await serve([file])).toBe(false);
      // Repeat reads during enrollment's re-arm cannot start another build.
      expect(await serve([file])).toBe(false);
      await settleDetachedWork();
      expect(discoveries()).toBe(before + 1);
      expect(await serve([file])).toBe(true);
      expect(readCache.cache.owed()).toBe(false);
      expect(live(retry)).toHaveLength(0);
      await expectFresh();
      // The pre-existing own-refill debounce must not discover again.
      await fire(own);
      expect(discoveries()).toBe(before + 1);
      expect(live(retry)).toHaveLength(0);
    });

    test('armed repeat serves check one root stat each without resolving or capturing again', async () => {
      seed();
      await compose();
      const fs = jest.requireMock<typeof AsyncFs>('node:fs/promises');
      const stat = jest.spyOn(fs, 'stat');
      const resolve = jest.spyOn(fs, 'realpath');
      const before = captures.length;
      try {
        for (let read = 0; read < 3; read += 1)
          expect(await serve([{ kind: 'index' }])).toBe(true);
        expect(stat.mock.calls).toEqual(
          Array.from({ length: 3 }, () => [harness.root, { bigint: true }]),
        );
        expect(resolve).not.toHaveBeenCalled();
        expect(captures).toHaveLength(before);
      } finally {
        stat.mockRestore();
        resolve.mockRestore();
      }
    });

    test.each(['revoke', 'broad-refill', 'dispose'] as const)(
      'a pending async root stat cannot serve across %s',
      async (loss) => {
        seed();
        await compose();
        const entered = deferred();
        const release = deferred();
        const fs = jest.requireMock<typeof AsyncFs>('node:fs/promises');
        const native = jest.requireActual<typeof AsyncFs>('node:fs/promises');
        const stat = jest.spyOn(fs, 'stat').mockImplementationOnce(async () => {
          const identity = await native.stat(harness.root, { bigint: true });
          entered.open();
          await release.promise;
          return identity;
        });
        const pending = serve([{ kind: 'index' }]);
        let rebuilding: Promise<void> | undefined;
        try {
          await entered.promise;
          if (loss === 'dispose') readCache.dispose();
          else if (loss === 'revoke') readCache.revoke();
          else {
            captureGate = deferred();
            rebuilding = readCache.apply(BROAD);
          }
          expect(readCache.cache.serving()).toBe(false);
          release.open();
          expect(await pending).toBe(false);
        } finally {
          release.open();
          await pending;
          captureGate?.open();
          await rebuilding;
          stat.mockRestore();
        }
      },
    );

    test('root replacement after the last warm capture cannot arm the first token', async () => {
      seed();
      const store = await prepare();
      const saved = `${harness.root}-saved`;
      let replaced = false;
      try {
        await readCache.activate({
          ...store,
          capture: async (request) => {
            if (!store.capture) throw new Error('Capture required');
            const captured = await store.capture(request);
            // Enrollment fences discovery; its trailing capture is the last warm read.
            if (!request.discoverWorkspaces && !replaced) {
              renameSync(harness.root, saved);
              mkdirSync(harness.root);
              writeFileSync(
                join(harness.root, 'index.json'),
                JSON.stringify({ version: 1, workspaces: [] }),
              );
              replaced = true;
            }
            return captured;
          },
        });
        expect(replaced).toBe(true);
        expect(captures.at(-1)?.discoverWorkspaces).toBe(false);
        // Watches still follow the old inodes: no notification can hide the race.
        directoryWatch();
        directoryWatch('a');
        directoryWatch('b');
        expect(readCache.cache.serving()).toBe(false);
        expect(ready()).toBe(false);
        expect(await serve([{ kind: 'index' }])).toBe(false);
        if (!electron.capture) throw new Error('Capture required');
        const request = {
          files: [{ kind: 'index' }],
          discoverWorkspaces: false,
        } as const;
        const fresh = await electron.capture(request);
        expect(
          readCache.cache.projection().image({ kind: 'index' }),
        ).not.toEqual(fresh.capture.files[0]);
        await withReaders(async (cached, today) => {
          expect(
            await cached.queryWorkspaceListForLegacyIpc({}, { caller }),
          ).toEqual(await today.queryWorkspaceListForLegacyIpc({}, { caller }));
        });
        rmSync(harness.root, { recursive: true });
        renameSync(saved, harness.root);
        await readCache.apply(BROAD);
        expect(await serve([{ kind: 'index' }])).toBe(false);
        expect(readCache.cache.serving()).toBe(false);
      } finally {
        if (existsSync(saved)) {
          rmSync(harness.root, { recursive: true, force: true });
          renameSync(saved, harness.root);
        }
      }
    });

    test('a revocation during async root certification fences the broad ticket', async () => {
      seed();
      await compose();
      const entered = deferred();
      const release = deferred();
      const fs = jest.requireMock<typeof AsyncFs>('node:fs/promises');
      const native = jest.requireActual<typeof AsyncFs>('node:fs/promises');
      const stat = jest
        .spyOn(fs, 'stat')
        .mockImplementationOnce(() =>
          native.stat(harness.root, { bigint: true }),
        )
        .mockImplementationOnce(async () => {
          const identity = await native.stat(harness.root, { bigint: true });
          entered.open();
          await release.promise;
          return identity;
        });
      const pending = readCache.apply(BROAD);
      try {
        await entered.promise;
        readCache.revoke();
        release.open();
        await pending;
        expect(readCache.cache.serving()).toBe(false);
        expect(await serve([{ kind: 'index' }])).toBe(false);
      } finally {
        release.open();
        await pending;
        stat.mockRestore();
      }
      await readCache.apply(BROAD);
      expect(await serve([{ kind: 'index' }])).toBe(true);
    });

    test.each(['ancestor-missing', 'root-replaced'] as const)(
      'root identity loss (%s) terminally revokes without a native notification',
      async (failure) => {
        seed();
        await compose();
        const request = {
          files: [{ kind: 'index' }],
          discoverWorkspaces: false,
        } as const;
        expect(await serve(request.files)).toBe(true);
        const original = failure === 'ancestor-missing' ? dir : harness.root;
        const saved = `${original}-saved`;
        renameSync(original, saved);
        if (failure === 'root-replaced') mkdirSync(original);
        const before = captures.length;
        try {
          // Mock watches remain live on the old inodes, as on Linux.
          directoryWatch();
          directoryWatch('a');
          expect(await serve(request.files)).toBe(false);
          expect(readCache.cache.serving()).toBe(false);
          expect(captures).toHaveLength(before);
          if (!electron.capture) throw new Error('Capture required');
          if (failure === 'ancestor-missing') {
            const refusal = {
              reason: 'invalid-state',
              details: { capture: 'root-unavailable' },
            };
            await expect(electron.capture(request)).rejects.toMatchObject(
              refusal,
            );
            await withReaders(async () => {
              const fresh = await runW5ReadView(request, (view) =>
                Promise.resolve(view),
              );
              expect(fresh).toMatchObject({
                status: 'uncaptured',
                reason: 'root-unavailable',
                error: refusal,
              });
              expect(
                await runDesktopW5CachedReadView(request, (view) =>
                  Promise.resolve(view),
                ),
              ).toEqual(fresh);
            });
          } else {
            expect(
              (await electron.capture(request)).capture.files[0],
            ).toMatchObject({
              state: 'absent',
            });
            await withReaders(async (cached, today) => {
              expect(
                await cached.queryWorkspaceListForLegacyIpc({}, { caller }),
              ).toEqual(
                await today.queryWorkspaceListForLegacyIpc({}, { caller }),
              );
            });
          }
        } finally {
          if (failure === 'root-replaced')
            rmSync(original, { recursive: true });
          renameSync(saved, original);
        }
        // Restoring the original path and a successful refill cannot unlatch it.
        await readCache.apply(BROAD);
        expect(readCache.cache.projection().serve(request).status).toBe(
          'served',
        );
        expect(await serve(request.files)).toBe(false);
      },
    );

    test('a native notification fences a refill already holding older bytes', async () => {
      seed();
      const counted = await prepare();
      const release = deferred();
      const captured = deferred();
      let holding = false;
      await readCache.activate({
        ...counted,
        capture: async (request) => {
          if (!counted.capture) throw new Error('Capture required');
          const result = await counted.capture(request);
          if (holding) {
            captured.open();
            await release.promise;
          }
          return result;
        },
      });
      holding = true;
      const pending = readCache.apply(BROAD);
      await captured.promise;
      const file: W5CaptureFile = { kind: 'worktrees', workspaceId: 'a' };
      writeFileSync(
        join(dir, 'workspaces', 'a', 'worktrees.json'),
        JSON.stringify({ version: 1, worktrees: [row] }),
      );
      directoryWatch('a').emit('change', 'change', 'worktrees.json');
      release.open();
      await pending;
      await expectFresh([file]);
      expect(await serve([file])).toBe(true);
    });

    test('re-enrollment fences a delayed targeted capture and retired watch events stay inert', async () => {
      seed();
      const counted = await prepare();
      const release = deferred();
      const captured = deferred();
      let holding = false;
      await readCache.activate({
        ...counted,
        capture: async (request) => {
          if (!counted.capture) throw new Error('Capture required');
          const result = await counted.capture(request);
          if (holding) {
            captured.open();
            await release.promise;
          }
          return result;
        },
      });
      holding = true;
      const file: W5CaptureFile = { kind: 'manifest', workspaceId: 'a' };
      const pending = readCache.apply({
        broad: false,
        index: false,
        workspaces: [],
        manifests: ['a'],
        worktreeLists: [],
      });
      await captured.promise;
      const retired = directoryWatch('a');
      retired.emit('error', new Error('Lost during capture'));
      writeFileSync(
        join(dir, 'workspaces', 'a', 'workspace.json'),
        JSON.stringify({ ...CONFIG, alwaysShow: true }),
      );
      expect(await serve([file])).toBe(false);
      const replacement = directoryWatch('a');
      expect(replacement).not.toBe(retired);
      release.open();
      await pending;
      expect(readCache.cache.projection().state(file)).toBe('dirty');
      expect(await serve([file])).toBe(false);
      await fire(own);
      await expectFresh([file]);
      const count = captures.length;
      retired.emit('change', 'rename', 'a');
      retired.emit('error', new Error('Late error'));
      retired.emit('close');
      expect(replacement.closed).toBe(false);
      expect(await serve([file])).toBe(true);
      expect(captures).toHaveLength(count);
      expect(live(own)).toHaveLength(0);
    });

    test('index removal during a broad rebuild prunes only the accepted membership', async () => {
      seed();
      const counted = await prepare();
      const release = deferred();
      const captured = deferred();
      let holding = false;
      await readCache.activate({
        ...counted,
        capture: async (request) => {
          if (!counted.capture) throw new Error('Capture required');
          const result = await counted.capture(request);
          if (holding) {
            captured.open();
            await release.promise;
          }
          return result;
        },
      });
      holding = true;
      const removed = directoryWatch('b');
      const pending = readCache.apply(BROAD);
      await captured.promise;
      index(['a']);
      directoryWatch().emit('change', 'change', 'index.json');
      expect(removed.closed).toBe(false);
      release.open();
      await pending;
      expect(removed.closed).toBe(true);
      expect(await serve([], true)).toBe(true);
      expect(await serve([{ kind: 'worktrees', workspaceId: 'b' }])).toBe(
        false,
      );
      await withReaders(async (cached, today) => {
        const result = await cached.queryWorkspaceListForLegacyIpc(
          {},
          { caller },
        );
        expect(result.legacyResult.items.map((item) => item.id)).toEqual(['a']);
        expect(result).toEqual(
          await today.queryWorkspaceListForLegacyIpc({}, { caller }),
        );
      });
    });

    test('ambiguous workspace events dirty the whole directory', async () => {
      seed();
      await compose();
      directoryWatch('b').emit('change', 'change', null);
      expect(await serve([{ kind: 'manifest', workspaceId: 'b' }])).toBe(false);
      expect(await serve([{ kind: 'worktrees', workspaceId: 'b' }])).toBe(
        false,
      );
      await fire(own);
      expect(await serve([{ kind: 'manifest', workspaceId: 'b' }])).toBe(true);
      expect(await serve([{ kind: 'worktrees', workspaceId: 'b' }])).toBe(true);
    });

    test.each([
      ['rename', 'workspaces'],
      ['rename', Buffer.from('workspaces')],
      ['rename', null],
      ['change', null],
      ['change', 'workspaces'],
      ['unknown', 'index.json'],
    ])(
      'root replacement (%s, %s) revokes every watch',
      async (event, filename) => {
        seed();
        await compose();
        const rootWatch = directoryWatch();
        const oldA = directoryWatch('a');
        const oldB = directoryWatch('b');
        renameSync(join(dir, 'workspaces'), join(dir, 'old-workspaces'));
        mkdirSync(join(dir, 'workspaces'));
        rootWatch.emit('change', event, filename);
        expect(rootWatch.closed).toBe(true);
        expect(oldA.closed).toBe(true);
        expect(oldB.closed).toBe(true);
        expect(await serve([{ kind: 'index' }])).toBe(false);
        expect(await serve([{ kind: 'worktrees', workspaceId: 'a' }])).toBe(
          false,
        );
      },
    );
  });

  test('warm: discovery enrolls every directory before accepting its files', async () => {
    await compose();
    expect(readCache.ready()).toBe(false); // A test store is installed.
    expect(readCache.cache.warmed()).toBe(true);
    // The store exposes the canonical root and captured index only in its
    // result. Discovery enrolls watches; only the subsequent capture can be
    // accepted under those watches. No separate Electron index read is used.
    expect(captures).toHaveLength(2);
    expect(captures[0]?.discoverWorkspaces).toBe(true);
    expect(coverageAtCapture[0]).toEqual([]);
    expect(coverageAtCapture[1]).toEqual(
      ['', 'a', 'b'].map((id) => join(dir, 'workspaces', id)),
    );
    expect(captures[1]).toEqual({ files: cached(), discoverWorkspaces: false });
    expect(cached()).toHaveLength(5);
    await expectFresh();
  });

  test.each(['missing', 'changed'] as const)(
    'a warm cache stops serving every file after a %s root refuses a targeted refill, even after recovery',
    async (failure) => {
      const counted = await prepare();
      await readCache.activate(counted);
      const request = {
        files: [{ kind: 'index' }],
        discoverWorkspaces: false,
      } as const;
      let moved = false;
      __setDesktopW5FileStoreForTests(undefined);
      try {
        expect(await readCache.serve(request)).toBeDefined();
        if (failure === 'missing') {
          renameSync(harness.root, `${harness.root}-saved`);
          moved = true;
        } else {
          // The typed refusal returned by the record port after a root swap.
          captureRefusal = 'root-changed';
        }
        // A targeted failure must also stop serving unrelated warm files.
        // Broad failures already un-warm the whole cache.
        await expect(
          readCache.apply({
            broad: false,
            index: false,
            workspaces: [],
            manifests: ['a'],
            worktreeLists: [],
          }),
        ).rejects.toMatchObject({
          reason: 'invalid-state',
          details: {
            capture:
              failure === 'missing' ? 'root-unavailable' : 'root-changed',
          },
        });
        expect(await readCache.serve(request)).toBeUndefined();
        if (moved) {
          renameSync(`${harness.root}-saved`, harness.root);
          moved = false;
        }
        captureRefusal = undefined;
        await readCache.apply(BROAD);
        expect(readCache.cache.projection().serve(request).status).toBe(
          'served',
        );
        expect(await readCache.serve(request)).toBeUndefined();
      } finally {
        if (moved) renameSync(`${harness.root}-saved`, harness.root);
        __setDesktopW5FileStoreForTests(electron);
      }
    },
  );

  test.each([
    'fallback',
    'batching',
    'preparation',
    'commit-read',
    'revision',
  ] as const)(
    '%s captures latch typed root refusals before a subsequent warm list',
    async (path) => {
      const caller = {
        principalId: 'test-user',
        clientInstanceId: 'test-client',
        authorityId: 'local-desktop',
        interfaceKind: 'test' as const,
        grants: ['core.workspace.read' as const, 'core.worktree.read' as const],
      };
      writeFileSync(
        join(dir, 'workspaces', 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: ['a', 'b'].map((id, order) => ({
            id,
            name: id,
            type: 'multi-repo',
            color: '#7C3AED',
            collapsed: false,
            order,
          })),
        }),
      );
      for (const id of ['a', 'b'])
        writeFileSync(
          join(dir, 'workspaces', id, 'workspace.json'),
          JSON.stringify(CONFIG),
        );
      await compose();
      installDesktopW5FileStore(electron);
      registerDesktopW5ReadCacheServer(readCache);
      const runtime = createDesktopRuntime({
        workspaceServices: {
          ...defaultCoreWorkspaceReadServices(),
          readView: runDesktopW5CachedReadView,
        },
      });
      __setDesktopW5FileStoreForTests(undefined);
      try {
        expect(
          (await runtime.queryWorkspaceListForLegacyIpc({}, { caller }))
            .legacyResult.items,
        ).toHaveLength(2);
        captureRefusal =
          path === 'preparation' ? 'root-changed' : 'root-unavailable';
        const refusal = {
          reason: 'invalid-state',
          details: { capture: captureRefusal },
        };
        const request = { files: [MANIFEST], discoverWorkspaces: false };
        if (path === 'fallback') {
          await expect(
            runtime.queryWorkspaceGetForLegacyIpc(
              { workspaceId: 'unlisted' },
              { caller },
            ),
          ).rejects.toThrow();
        } else if (path === 'preparation') {
          await expect(
            electron.captureForPreparation?.(request),
          ).rejects.toMatchObject(refusal);
        } else if (path === 'revision') {
          await expect(
            electron.readRevisions([{ kind: 'workspace', workspaceId: 'a' }]),
          ).rejects.toMatchObject(refusal);
        } else {
          const readFile = (): ReturnType<typeof electron.read> =>
            electron.read(join(harness.root, 'a', 'workspace.json'));
          const read =
            path === 'commit-read'
              ? await electron.withCommit(
                  { operation: 'golden.root-refusal' },
                  readFile,
                )
              : await readFile();
          expect(read).toMatchObject({ state: 'unreadable', error: refusal });
        }
        // A warm list must capture and fail closed, not return old rows.
        await expect(
          runtime.queryWorkspaceListForLegacyIpc({}, { caller }),
        ).rejects.toThrow();
        captureRefusal = undefined;
        await electron.capture?.(request);
        await readCache.apply(BROAD);
        expect(readCache.cache.projection().serve(request).status).toBe(
          'served',
        );
        expect(await readCache.serve(request)).toBeUndefined();
      } finally {
        registerDesktopW5ReadCacheServer(undefined);
        __setDesktopW5FileStoreForTests(electron);
        await runtime.shutdown();
      }
    },
  );

  test.each([
    'limit-exceeded',
    'unsupported-platform',
    'confinement-unavailable',
  ])(
    '%s capture refusals do not latch unrelated warm files',
    async (reason) => {
      await compose();
      captureRefusal = reason;
      await expect(
        electron.captureForPreparation?.({
          files: [MANIFEST],
          discoverWorkspaces: false,
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-state',
        details: { capture: reason },
      });
      __setDesktopW5FileStoreForTests(undefined);
      try {
        expect(
          await readCache.serve({
            files: [{ kind: 'index' }],
            discoverWorkspaces: false,
          }),
        ).toBeDefined();
      } finally {
        __setDesktopW5FileStoreForTests(electron);
      }
    },
  );

  test('a foreign plan stops serving named files synchronously while its capture is pending', async () => {
    await compose();
    const commitId = await foreignWrite({ alwaysShow: true });
    captureGate = deferred();
    const applying = readCache.apply({
      broad: false,
      index: false,
      workspaces: [],
      manifests: ['a'],
      worktreeLists: [],
      commitId,
    });
    __setDesktopW5FileStoreForTests(undefined);
    try {
      expect(
        await readCache.serve({ files: [MANIFEST], discoverWorkspaces: false }),
      ).toBeUndefined();
      expect(
        await readCache.serve({
          files: [{ kind: 'manifest', workspaceId: 'b' }],
          discoverWorkspaces: false,
        }),
      ).toBeDefined();
    } finally {
      __setDesktopW5FileStoreForTests(electron);
      captureGate.open();
      await applying;
      captureGate = undefined;
    }
    expect(readCache.cache.projection().holds(MANIFEST, commitId)).toBe(true);
    await expectFresh();
  });

  test('an unreadable file image does not latch unrelated warm files', async () => {
    mkdirSync(join(dir, 'workspaces', 'a', 'workspace.json'));
    await compose();
    expect(readCache.cache.projection().image(MANIFEST)).toMatchObject({
      state: 'unreadable',
    });
    __setDesktopW5FileStoreForTests(undefined);
    try {
      expect(
        await readCache.serve({
          files: [{ kind: 'index' }],
          discoverWorkspaces: false,
        }),
      ).toBeDefined();
    } finally {
      __setDesktopW5FileStoreForTests(electron);
    }
  });

  test('a capture-refusal observer throwing preserves the typed refusal', async () => {
    await compose();
    const observing = jest
      .spyOn(readCache, 'noteCaptureRefused')
      .mockImplementation(() => {
        throw new Error('The observer failed');
      });
    captureRefusal = 'root-changed';
    try {
      await expect(
        electron.captureForPreparation?.({
          files: [MANIFEST],
          discoverWorkspaces: false,
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-state',
        details: { capture: 'root-changed' },
      });
      expect(observing).toHaveBeenCalledTimes(1);
    } finally {
      observing.mockRestore();
    }
  });

  test.each(['connection', 'stream'] as const)(
    '%s loss stops serving until the replacement stream broad refill completes',
    async (loss) => {
      await compose();
      const client = await attach();
      await until(() => applied.some((plan) => plan.broad));
      const request = { files: [MANIFEST], discoverWorkspaces: false };
      __setDesktopW5FileStoreForTests(undefined);
      expect(await readCache.serve(request)).toBeDefined();
      __setDesktopW5FileStoreForTests(electron);
      captureGate = deferred();
      const before = captures.length;
      if (loss === 'connection') await client.close();
      else endStream?.();
      // No reconnect latch, timer or completed reattachment is needed.
      expect(usable).toBe(true);
      expect(ready()).toBe(false);
      __setDesktopW5FileStoreForTests(undefined);
      try {
        expect(await readCache.serve(request)).toBeUndefined();
      } finally {
        __setDesktopW5FileStoreForTests(electron);
      }
      const attaching = loss === 'connection' ? attach() : Promise.resolve();
      try {
        await until(() => captures.length > before);
        expect(captures.at(-1)?.discoverWorkspaces).toBe(true);
        expect(ready()).toBe(false);
      } finally {
        captureGate.open();
        await attaching;
        captureGate = undefined;
      }
      await until(() => applied.filter((plan) => plan.broad).length >= 2);
      await until(ready);
      expect(ready()).toBe(true);
      await expectFresh();
    },
  );

  test('a superseded stream open cannot consume its replacement reconciliation', async () => {
    await compose();
    const initial = await attach();
    await foreignWrite({ alwaysShow: true });
    await until(() => acks.length > 0);
    const cursor = {
      daemonEpoch: initial.identity.daemonEpoch,
      sequence: acks.at(-1),
    };
    await initial.close();
    const opened = deferred();
    const release = deferred();
    afterOpen = async (): Promise<void> => {
      opened.open();
      await release.promise;
    };
    const first = await harness.connectEvents('electron-main');
    const attachingFirst = binding.attach(connection(first));
    await opened.promise;
    await first.close();
    const replacement = await harness.connectEvents('electron-main');
    const replay = jest.spyOn(replacement, 'openStream');
    const attachingReplacement = binding.attach(connection(replacement));
    try {
      expect(ready()).toBe(false);
    } finally {
      release.open();
    }
    await attachingFirst;
    await attachingReplacement;
    expect(replay).toHaveBeenCalledWith(
      'core.events.subscribe',
      expect.objectContaining({ cursor }),
      expect.anything(),
    );
    expect(applied.filter((plan) => plan.broad)).toHaveLength(2);
    expect(ready()).toBe(true);
    await expectFresh();
  });

  test.each(['recovery-required', 'conflict'] as const)(
    'a foreign %s decision withholds unrelated cached revisions until reconciliation',
    async (failure) => {
      rmSync(join(dir, 'workspaces', 'index.json'));
      await compose();
      await getWorkspaceIndexRepository().update(() => ({
        entries: ['a', 'b'].map((id, order) => ({
          id,
          name: id,
          type: 'multi-repo' as const,
          color: '#7C3AED',
          collapsed: false,
          order,
        })),
        result: undefined,
      }));
      await write({});
      await writeWorkspaceConfig('b', CONFIG);
      await readCache.apply(BROAD);
      await attach();
      const request = {
        files: [
          { kind: 'index' } as const,
          { kind: 'manifest', workspaceId: 'b' } as const,
        ],
        discoverWorkspaces: false,
      };
      const resource = { kind: 'workspace', workspaceId: 'b' } as const;
      const dispatcherRead = async (eligible: boolean): Promise<void> => {
        installDesktopW5FileStore(electron);
        registerDesktopW5ReadCacheServer(readCache);
        const cached = createDesktopRuntime({
          workspaceServices: {
            ...defaultCoreWorkspaceReadServices(),
            readView: runDesktopW5CachedReadView,
          },
        });
        const today = createDesktopRuntime();
        const caller = {
          principalId: 'test-user',
          clientInstanceId: 'test-client',
          authorityId: 'local-desktop',
          interfaceKind: 'test' as const,
          grants: ['core.workspace.read' as const],
        };
        __setDesktopW5FileStoreForTests(undefined);
        try {
          const result = await cached.queryWorkspaceListForLegacyIpc(
            {},
            { caller },
          );
          const fresh = await today.queryWorkspaceListForLegacyIpc(
            {},
            { caller },
          );
          expect(result.canonicalResult).toEqual(fresh.canonicalResult);
          const row = result.canonicalResult?.items.find(
            (item) => item.workspaceId === 'b',
          );
          expect(row).toBeDefined();
          if (eligible) expect(row).toHaveProperty('revision');
          else expect(row).not.toHaveProperty('revision');
        } finally {
          __setDesktopW5FileStoreForTests(electron);
          registerDesktopW5ReadCacheServer(undefined);
          await Promise.all([cached.shutdown(), today.shutdown()]);
        }
      };
      const serve = async (): ReturnType<typeof readCache.serve> => {
        __setDesktopW5FileStoreForTests(undefined);
        try {
          return await readCache.serve(request);
        } finally {
          __setDesktopW5FileStoreForTests(electron);
        }
      };
      const before = await serve();
      if (!before || !electron.capture)
        throw new Error('Expected warm capture');
      expect(
        classifyW5RevisionEligibility(before.capture, resource, 'complete'),
      ).toMatchObject({ status: 'eligible' });
      await dispatcherRead(true);
      const events = harness.events().length;
      stepGate = deferred();
      const manifest = join(harness.root, 'a', 'workspace.json');
      const savedManifest = join(harness.root, 'a', 'workspace.json.saved');
      let replacedManifest = false;
      harness.hooks.commit.before = (): Promise<void> => {
        harness.hooks.commit.before = undefined;
        if (failure === 'recovery-required') {
          // Fail apply after the preimage read, independent of OS permissions.
          renameSync(manifest, savedManifest);
          replacedManifest = true;
          mkdirSync(manifest);
        } else {
          writeFileSync(
            manifest,
            JSON.stringify({ ...CONFIG, alwaysShow: false }),
          );
        }
        return Promise.resolve();
      };
      try {
        await expect(foreignWrite({ alwaysShow: true })).rejects.toMatchObject(
          failure === 'recovery-required'
            ? { reason: 'recovery-required' }
            : { name: 'W5FileWriteRefusedError' },
        );
      } finally {
        if (replacedManifest) {
          rmSync(manifest, { recursive: true, force: true });
          renameSync(savedManifest, manifest);
        }
      }
      const { capture: fresh } = await electron.capture(request);
      const eligibility = classifyW5RevisionEligibility(
        fresh,
        resource,
        'complete',
      );
      expect(eligibility).toEqual({
        status: 'unverified',
        reason:
          failure === 'recovery-required' ? 'pending' : 'abandoned-history',
      });
      const invalidations = harness.events().slice(events);
      // Hold the reconciliation open: no stale revision may escape meanwhile.
      captureGate = deferred();
      const capturesBefore = captures.length;
      stepGate.open();
      // With no event, probe immediately rather than hiding the stale read
      // behind a timeout waiting for a reconciliation that will never start.
      if (invalidations.length)
        await until(() => captures.length > capturesBefore);
      await dispatcherRead(false);
      expect(await serve()).toBeUndefined();
      expect(invalidations).toEqual([
        expect.objectContaining({ name: CORE_WORKSPACE_INVALIDATED_EVENT }),
      ]);
      const plansBefore = applied.length;
      captureGate.open();
      await until(() => applied.length > plansBefore);
      const after = await serve();
      if (!after) throw new Error('Expected reconciled capture');
      expect(
        classifyW5RevisionEligibility(after.capture, resource, 'complete'),
      ).toEqual(eligibility);
      await dispatcherRead(false);
    },
  );

  test('repeated connection losses reject stale reconciliations and ordinary retries', async () => {
    await compose();
    const first = await attach();
    const before = captures.length;
    captureGate = deferred();
    await first.close();
    const second = await harness.connectEvents('electron-main');
    const attachingSecond = binding.attach(connection(second));
    await until(() => captures.length > before);
    expect(ready()).toBe(false);
    await second.close();
    // The cache's retry can update images, but cannot restore continuity.
    readCache.markDirty([MANIFEST]);
    const retrying = fire(own);
    const replacementOpen = deferred();
    beforeOpen = (): Promise<void> => replacementOpen.promise;
    const third = attach();
    captureGate.open();
    try {
      await attachingSecond;
      await retrying;
      expect(ready()).toBe(false);
    } finally {
      replacementOpen.open();
    }
    await third;
    expect(ready()).toBe(true);
    await expectFresh();
    captureGate = undefined;
  });

  test('revocations fence pending broad tickets and disconnected refills cannot re-arm', async () => {
    await compose();
    expect(ready()).toBe(true);
    captureGate = deferred();
    const before = captures.length;
    const pending = readCache.apply(BROAD);
    await until(() => captures.length > before);
    readCache.revoke();
    readCache.revoke();
    captureGate.open();
    await pending;
    captureGate = undefined;
    expect(ready()).toBe(false);
    await readCache.cache.refillMarked();
    expect(ready()).toBe(false);
    readCache.setStreamReady(false);
    await readCache.apply(BROAD);
    expect(ready()).toBe(false);
    readCache.setStreamReady(true);
    expect(ready()).toBe(false);
    await readCache.apply(BROAD);
    expect(ready()).toBe(true);
    await expectFresh();
  });

  test('health failure revokes before any reader and only a healthy broad refill re-arms', async () => {
    await compose();
    expect(ready()).toBe(true);
    usable = false;
    healthFailure?.();
    expect(ready()).toBe(false);
    await readCache.cache.refillBroad();
    expect(ready()).toBe(false);
    usable = true;
    await readCache.cache.refillMarked();
    expect(ready()).toBe(false);
    await readCache.apply(BROAD);
    expect(ready()).toBe(true);
  });

  test('health recovery during a broad refill cannot overtake a second health failure', async () => {
    await compose();
    expect(ready()).toBe(true);
    usable = false;
    healthFailure?.();
    usable = true;
    healthRecovery?.();
    expect(live(own)).toHaveLength(1);
    captureGate = deferred();
    const before = captures.length;
    const pending = fire(own);
    await until(() => captures.length > before);
    healthRecovery?.();
    expect(live(own)).toHaveLength(1);
    await fire(own);
    expect(ready()).toBe(false);
    usable = false;
    healthFailure?.();
    captureGate.open();
    await pending;
    captureGate = undefined;
    expect(ready()).toBe(false);
    usable = true;
    healthRecovery?.();
    expect(ready()).toBe(false);
    expect(live(own)).toHaveLength(1);
    const broad = discoveries();
    await fire(own);
    expect(discoveries()).toBe(broad + 1);
    expect(ready()).toBe(true);
    await expectFresh();
  });

  test.each([
    'inactive',
    'disconnected',
    'unhealthy',
    'terminal',
    'disposed',
  ] as const)(
    'health recovery schedules nothing while the cache is %s',
    async (state) => {
      if (state === 'inactive') await prepare();
      else await compose();
      usable = false;
      healthFailure?.();
      const recover = healthRecovery;
      if (state === 'disconnected') readCache.setStreamReady(false);
      if (state === 'terminal') readCache.cache.revoke(true);
      if (state === 'disposed') readCache.dispose();
      usable = state !== 'unhealthy';
      const before = captures.length;
      const scheduled = timers.length;
      recover?.();
      expect(timers).toHaveLength(scheduled);
      expect(captures).toHaveLength(before);
      expect(ready()).toBe(false);
    },
  );

  test('a targeted plan after stream loss settles its files without starting discovery', async () => {
    await compose();
    readCache.setStreamReady(false);
    const commitId = await foreignWrite({ alwaysShow: true });
    const before = captures.length;
    await readCache.apply({
      ...BROAD,
      broad: false,
      manifests: ['a'],
      commitId,
    });
    expect(captures.slice(before)).toEqual([
      { files: [MANIFEST], discoverWorkspaces: false },
    ]);
    expect(ready()).toBe(false);
    await expectFresh([MANIFEST]);
    readCache.setStreamReady(true);
    expect(ready()).toBe(false);
    await readCache.apply(BROAD);
    expect(ready()).toBe(true);
    await expectFresh();
  });

  test('a foreign commit: cached before its handlers, acknowledged after both (A19 a, b)', async () => {
    await compose();
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    const before = readCache.cache.projection().image(MANIFEST);
    stepGate = deferred();
    handlerGate = deferred();
    const commitId = await foreignWrite({ alwaysShow: true });
    // (a) Between the commit and its delivery, the cache is the old one.
    expect(readCache.cache.projection().image(MANIFEST)).toEqual(before);
    const acked = acks.length;
    const handled = seen.length;
    stepGate.open();
    await until(() =>
      seen
        .slice(handled)
        .some((entry) => entry.handler === 'refreshWorkspaceRegistries'),
    );
    const plan = applied.at(-1);
    expect(plan).toMatchObject({ broad: false, manifests: ['a'], commitId });
    const published = harness.committedEvents().at(-1);
    expect(published).toMatchObject({ publishedBy: 'cli' });
    expect(plan?.revisions).toMatchObject({
      'workspace:a': await harness.revision({
        kind: 'workspace',
        workspaceId: 'a',
      }),
    });
    // The handlers read the commit from the cache; nothing is acked yet.
    expect(seen.slice(handled)).toEqual([
      { handler: 'scheduleDesktopStructureChanged', commitId },
      { handler: 'refreshWorkspaceRegistries', commitId },
    ]);
    expect(acks).toHaveLength(acked);
    // (b) Delivery and its acknowledgement need no timer.
    handlerGate.open();
    await until(() => acks.length > acked);
    expect(readCache.cache.projection().holds(MANIFEST, commitId)).toBe(true);
    await expectFresh();
  });

  test('read-your-writes: an own write is cached at once and never re-read from its event', async () => {
    await compose();
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    const plans = applied.length;
    const commitId = await write({ alwaysShow: true });
    const projection = readCache.cache.projection();
    expect(projection.commitId(MANIFEST)).toBe(commitId);
    expect(projection.image(MANIFEST)).toMatchObject({ state: 'present' });
    await readCache.cache.refillMarked();
    // A later foreign commit is delivered; the own one never planned.
    const foreignId = await foreignWrite({ alwaysShow: false });
    await until(() => applied.length > plans);
    expect(applied.slice(plans).map((plan) => plan.commitId)).toEqual([
      foreignId,
    ]);
    await expectFresh();
  });

  test('a refill that won the race skips the capture', async () => {
    await compose();
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    stepGate = deferred();
    const commitId = await foreignWrite({ alwaysShow: true });
    await readCache.cache.refillBroad();
    const count = captures.length;
    stepGate.open();
    await until(() => applied.some((plan) => plan.commitId === commitId));
    expect(captures).toHaveLength(count);
    await expectFresh();
  });

  test('reconnect: cursor replay is preceded by a broad refill on the replacement stream', async () => {
    await compose();
    const client = await attach();
    await until(() => applied.some((plan) => plan.broad));
    // A delivered, acknowledged commit gives the subscription its cursor.
    const acked = acks.length;
    await foreignWrite({ alwaysShow: false });
    await until(() => acks.length > acked);
    const broad = discoveries();
    await client.close();
    const commitId = await foreignWrite({ alwaysShow: true });
    await attach();
    await until(() => applied.some((plan) => plan.commitId === commitId));
    expect(discoveries()).toBe(broad + 1);
    await expectFresh();
  });

  test('an evicted cursor takes a snapshot and a broad refill (A19 d)', async () => {
    await compose({ journalMaxEntries: 2 });
    const client = await attach();
    await until(() => applied.some((plan) => plan.broad));
    const acked = acks.length;
    await foreignWrite({ alwaysShow: false });
    await until(() => acks.length > acked);
    const broad = discoveries();
    await client.close();
    for (const alwaysShow of [true, false, true])
      await foreignWrite({ alwaysShow });
    await attach();
    await until(() => discoveries() > broad);
    await until(() => applied.at(-1)?.broad === true);
    await expectFresh();
  });

  test('a lagging subscriber is ended, re-attached and refilled broadly (A19 c)', async () => {
    await compose({ eventsMaxPending: 2 });
    maxInFlight = 1;
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    const broad = discoveries();
    stepGate = deferred();
    for (const alwaysShow of [true, false, true, false])
      await foreignWrite({ alwaysShow });
    stepGate.open();
    await until(() => discoveries() > broad);
    await until(() => applied.at(-1)?.broad === true);
    await expectFresh();
  });

  test('a commit between the snapshot and the open is covered after the open (A19 e)', async () => {
    await compose();
    let commitId = 0;
    beforeOpen = async (): Promise<void> => {
      commitId = await foreignWrite({ alwaysShow: true });
    };
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    expect(readCache.cache.projection().holds(MANIFEST, commitId)).toBe(true);
    await expectFresh();
  });

  test('an invalidation refills broadly, taking out-of-band bytes at the same commit id', async () => {
    await compose();
    await foreignWrite({ alwaysShow: true });
    writeFileSync(join(harness.root, 'b', 'workspace.json'), '{"edited":true}');
    const plan = planCanopyWorkspaceInvalidation(
      {
        cursor: { daemonEpoch: 'runtime:w5d1-test', sequence: 1 },
        eventId: 'runtime:w5d1-test#1',
        name: CORE_WORKSPACE_INVALIDATED_EVENT,
        scope: {},
        occurredAt: new Date(0).toISOString(),
        payload: { reason: 'uncertain' },
      },
      () => false,
    );
    if (!plan) throw new Error('An invalidation always plans');
    await binding.apply(plan);
    expect(seen.map((entry) => entry.handler)).toEqual([
      'refreshWorkspaceRegistries',
      'scheduleDesktopStructureChanged',
      'publishWorktreeMembershipChange',
    ]);
    const b = { kind: 'manifest', workspaceId: 'b' } as const;
    expect(readCache.cache.projection().image(b)).toMatchObject({
      base64: Buffer.from('{"edited":true}').toString('base64'),
    });
    await expectFresh();
  });

  test('a new daemon epoch over a new log replaces the projection (A19 f)', async () => {
    await compose();
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    await foreignWrite({ alwaysShow: true });
    const last = await foreignWrite({ alwaysShow: false });
    await until(() => applied.some((plan) => plan.commitId === last));
    // Every held file now stands at the old log's position.
    await readCache.cache.refillBroad();
    const first = readCache.cache.projection();
    const plans = applied.length;
    await harness.close();
    await start({
      dbPath: join(dir, 'w5', 'second.sqlite'),
      epoch: 'runtime:second',
    });
    // An own write on the new log before any plan lands below the old log's
    // position: a capture verifies it, finds the new log and starts over.
    expect(await write({ alwaysShow: true })).toBeLessThan(last);
    await readCache.cache.refillMarked();
    expect(readCache.cache.projection()).not.toBe(first);
    await attach();
    await until(() => applied.slice(plans).some((plan) => plan.broad));
    expect(readCache.cache.projection()).not.toBe(first);
    expect(readCache.cache.warmed()).toBe(true);
    await expectFresh();
  });

  test('a new log at an equal commit id is rebuilt by its broad refill, own decisions kept', async () => {
    await compose();
    // The old log lost a commit: abandonment is log-wide and permanent in it.
    const old = await foreignWrite({ alwaysShow: true });
    abandoned = true;
    await readCache.apply(BROAD);
    const first = readCache.cache.projection();
    const stale = first.image(MANIFEST);
    expect(first.state(MANIFEST)).toBe('current');
    abandoned = false;
    await harness.close();
    await start({
      dbPath: join(dir, 'w5', 'second.sqlite'),
      epoch: 'runtime:second',
    });
    // The new log reaches the old position with other bytes and no
    // abandonment; its commit ids never fall below what the cache saw.
    expect(await foreignWrite({ alwaysShow: false })).toBe(old);
    await readCache.apply(BROAD);
    const next = readCache.cache.projection();
    expect(next.image(MANIFEST)).not.toEqual(stale);
    await expectFresh();
    expect(readCache.cache.warmed()).toBe(true);
    expect(readCache.cache.owed()).toBe(false);
    expect(next).not.toBe(first);
    // An own decision made while a rebuild's capture is held is not lost.
    captureGate = deferred();
    const rebuilding = readCache.apply(BROAD);
    const commitId = await write({ alwaysShow: true });
    expect(readCache.cache.projection().commitId(MANIFEST)).toBe(commitId);
    captureGate.open();
    await rebuilding;
    expect(readCache.cache.projection()).not.toBe(next);
    expect(readCache.cache.projection().holds(MANIFEST, commitId)).toBe(true);
    await expectFresh();
  });

  test('a new log no capture can tell apart is replaced by its broad refill', async () => {
    await compose();
    const old = await foreignWrite({ alwaysShow: true });
    await readCache.apply(BROAD);
    const stale = readCache.cache.projection().image(MANIFEST);
    await harness.close();
    await start({
      dbPath: join(dir, 'w5', 'second.sqlite'),
      epoch: 'runtime:second',
    });
    // The old position and abandonment, other bytes and an unresolved commit:
    // no capture of the old projection admits them at that position.
    expect(await foreignWrite({ alwaysShow: false })).toBe(old);
    unresolved = 1;
    await readCache.apply(BROAD);
    expect(readCache.cache.projection().image(MANIFEST)).not.toEqual(stale);
    expect(readCache.cache.warmed()).toBe(true);
    await expectFresh();
  });

  test('fewer abandoned commits show a new log to a targeted capture', async () => {
    await compose();
    const old = await foreignWrite({ alwaysShow: true });
    abandoned = true;
    await readCache.apply(BROAD);
    const stale = readCache.cache.projection().image(MANIFEST);
    abandoned = false;
    await harness.close();
    await start({
      dbPath: join(dir, 'w5', 'second.sqlite'),
      epoch: 'runtime:second',
    });
    expect(await foreignWrite({ alwaysShow: false })).toBe(old);
    // Before any broad plan: the cache stops being ready at once.
    await readCache.apply({ ...BROAD, broad: false, manifests: ['a'] });
    expect(readCache.cache.projection().image(MANIFEST)).not.toEqual(stale);
    expect(ready()).toBe(false);
    await fire(retry);
    expect(ready()).toBe(true);
    await expectFresh();
  });

  test('a plan skipped while the daemon cannot serve forces a broad refill', async () => {
    await compose();
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    usable = false;
    const skipped = await foreignWrite({ alwaysShow: true });
    await until(() => applied.some((plan) => plan.commitId === skipped));
    expect(readCache.cache.projection().holds(MANIFEST, skipped)).toBe(false);
    usable = true;
    const broad = discoveries();
    const next = await foreignWrite({ alwaysShow: false });
    await until(() => applied.some((plan) => plan.commitId === next));
    expect(discoveries()).toBe(broad + 1);
    await expectFresh();
  });

  test('a discovery over the capture limit splits by halving', async () => {
    const ids = Array.from({ length: 130 }, (_, index) => `w${index}`);
    writeFileSync(
      join(dir, 'workspaces', 'index.json'),
      JSON.stringify({ version: 1, workspaces: ids.map((id) => ({ id })) }),
    );
    await compose();
    expect(readCache.cache.warmed()).toBe(true);
    expect(cached()).toHaveLength(1 + 2 * ids.length);
    expect(captures.length).toBeGreaterThan(2);
    await expectFresh(cached().slice(0, 200));
    // Past the warm, every later broad refill holds more files than one
    // request carries; each still splits, and none is sent over the limit.
    const warmed = captures.length;
    await readCache.cache.refillBroad();
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    expect(captures.length).toBeGreaterThan(warmed + 2);
    for (const request of captures)
      expect(
        new Set([
          ...(request.discoverWorkspaces ? ['index'] : []),
          ...request.files.map((file) =>
            'workspaceId' in file
              ? `${file.kind}:${file.workspaceId}`
              : file.kind,
          ),
        ]).size,
      ).toBeLessThanOrEqual(W5_CAPTURE_LIMITS.files);
    expect(readCache.cache.warmed()).toBe(true);
    expect(readCache.cache.owed()).toBe(false);
    expect(cached()).toHaveLength(1 + 2 * ids.length);
    await expectFresh(cached().slice(0, 200));
  });

  test('split refills cannot serve an assembled capture over the record-port encoded limit', async () => {
    writeFileSync(
      join(dir, 'workspaces', 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: ['a', 'b'].map((id, order) => ({
          id,
          name: id.toUpperCase(),
          type: 'multi-repo',
          color: '#7C3AED',
          collapsed: false,
          order,
        })),
      }),
    );
    for (const id of ['a', 'b'])
      writeFileSync(
        join(dir, 'workspaces', id, 'workspace.json'),
        JSON.stringify({ ...CONFIG, padding: 'x'.repeat(3 * 1024 * 1024) }),
      );
    const counted = await prepare();
    await writeWorkspaceWorktrees('a', [
      { id: 'wt-1', branchName: 'feature', createdAt: '2026-11-01T00:00:00Z' },
    ]);
    await readCache.activate(counted);
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    expect(ready()).toBe(true);
    expect(
      captures.filter((request) => !request.discoverWorkspaces).length,
    ).toBeGreaterThan(1);
    const projection = readCache.cache.projection();
    const resource = {
      kind: 'worktree',
      workspaceId: 'a',
      worktreeId: 'wt-1',
    } as const;
    const narrow = projection.serve({
      files: [MANIFEST, { kind: 'worktrees', workspaceId: 'a' }],
      discoverWorkspaces: false,
    });
    expect(narrow.status).toBe('served');
    if (narrow.status !== 'served')
      throw new Error('The smaller capture must be served');
    expect(
      classifyW5RevisionEligibility(narrow.capture, resource, 'complete')
        .status,
    ).toBe('eligible');
    const images = cached().map((file) => projection.image(file));
    const decodedBytes = images.reduce(
      (sum, image) =>
        sum +
        (image?.state === 'present'
          ? Buffer.byteLength(image.base64, 'base64')
          : 0),
      0,
    );
    expect(decodedBytes).toBeLessThan(W5_CAPTURE_LIMITS.bytes);
    expect(Buffer.byteLength(JSON.stringify(images))).toBeGreaterThan(
      CORE_WORKSPACE_RECORDS_LIMITS.resultBytes,
    );
    if (!electron.capture) throw new Error('The daemon-backed store captures');
    for (const discoverWorkspaces of [false, true]) {
      const request = { files: cached(), discoverWorkspaces };
      await expect(electron.capture(request)).rejects.toMatchObject({
        reason: 'invalid-state',
        details: { capture: 'limit-exceeded' },
      });
      for (let repeat = 0; repeat < 2; repeat += 1)
        expect(projection.serve(request)).toEqual({
          status: 'unserved',
          reason: 'limit-exceeded',
          refresh: [],
        });
    }
    // q-28: the dispatcher must use today's live fallback, not publish the
    // eligible row revision available in the narrower cached capture.
    installDesktopW5FileStore(electron);
    registerDesktopW5ReadCacheServer(readCache);
    const served = createDesktopRuntime({
      workspaceServices: {
        ...defaultCoreWorkspaceReadServices(),
        readView: runDesktopW5CachedReadView,
      },
    });
    const today = createDesktopRuntime();
    const caller = {
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test' as const,
      grants: ['core.workspace.read' as const, 'core.worktree.read' as const],
    };
    __setDesktopW5FileStoreForTests(undefined);
    try {
      const expected = await today.queryWorktreeListForLegacyIpc(
        {},
        { caller },
      );
      const result = await served.queryWorktreeListForLegacyIpc({}, { caller });
      expect(result).toEqual(expected);
      const row = result.canonicalResult?.items.find(
        (item) => item.worktreeId === 'wt-1',
      );
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('revision');
      expect(
        projection.serve({
          files: [{ kind: 'worktrees', workspaceId: 'a' }],
          discoverWorkspaces: false,
        }).status,
      ).toBe('served');
    } finally {
      __setDesktopW5FileStoreForTests(electron);
      registerDesktopW5ReadCacheServer(undefined);
      await Promise.all([served.shutdown(), today.shutdown()]);
    }
  });

  test('own decisions share one trailing refill, and none runs during the warm', async () => {
    const counted = await prepare();
    captureGate = deferred();
    const warming = readCache.activate(counted);
    // Electron writes while the warm's discovery capture is held.
    await write({ alwaysShow: true });
    const during = await write({ alwaysShow: false });
    expect(timers).toHaveLength(0);
    captureGate.open();
    await warming;
    // The warm's trailing plan verified both decisions.
    expect(captures.map((request) => request.discoverWorkspaces)).toEqual([
      true,
      false,
    ]);
    expect(readCache.cache.projection().holds(MANIFEST, during)).toBe(true);
    expect(timers).toHaveLength(0);
    // After the warm, each decision pushes one trailing refill back.
    const count = captures.length;
    await write({ alwaysShow: true });
    await write({ alwaysShow: false });
    expect(captures).toHaveLength(count);
    expect(timers.filter(own)).toHaveLength(2);
    expect(live(own)).toHaveLength(1);
    // Past the push-back ceiling, a later decision keeps the pending refill.
    clock += OWN_MS * 8;
    const last = await write({ alwaysShow: true });
    expect(timers.filter(own)).toHaveLength(2);
    expect(captures).toHaveLength(count);
    await fire(own);
    expect(captures).toHaveLength(count + 1);
    expect(captures.at(-1)?.discoverWorkspaces).toBe(false);
    expect(readCache.cache.projection().holds(MANIFEST, last)).toBe(true);
    expect(timers.filter((timer) => timer.live)).toHaveLength(0);
    await expectFresh();
  });

  test('a file over the capture limits is retried only when named again', async () => {
    const b = { kind: 'manifest', workspaceId: 'b' } as const;
    const path = join(dir, 'workspaces', 'b', 'workspace.json');
    const named = {
      broad: false,
      index: false,
      workspaces: [],
      manifests: ['b'],
      worktreeLists: [],
    };
    writeFileSync(path, JSON.stringify(CONFIG));
    await compose();
    expect(readCache.cache.projection().state(b)).toBe('current');
    // The cached file grows past the limits; a plan naming it marks it dirty.
    writeFileSync(path, 'x'.repeat(W5_CAPTURE_LIMITS.bytes + 1));
    await readCache.apply(named);
    expect(readCache.cache.projection().state(b)).toBe('dirty');
    expect(readCache.cache.owed()).toBe(false);
    expect(timers).toHaveLength(0);
    const count = captures.length;
    await readCache.cache.refillMarked();
    expect(captures).toHaveLength(count);
    // A plan naming it again tries once more; it stays dirty, with no retry.
    await readCache.apply(named);
    expect(captures).toHaveLength(count + 1);
    expect(readCache.cache.projection().state(b)).toBe('dirty');
    expect(timers).toHaveLength(0);
    // Back under the limits, a broad refill settles it.
    writeFileSync(path, JSON.stringify(CONFIG));
    await readCache.apply({
      broad: true,
      index: false,
      workspaces: [],
      manifests: [],
      worktreeLists: [],
    });
    expect(readCache.cache.projection().state(b)).toBe('current');
    await expectFresh();
  });

  test('unresolved commits stop idle retries after a bounded number, until named again', async () => {
    await compose();
    // The log moves on and every capture reports a commit awaiting recovery.
    await foreignWrite({ alwaysShow: true });
    unresolved = 1;
    await readCache.apply({
      broad: true,
      index: false,
      workspaces: [],
      manifests: [],
      worktreeLists: [],
    });
    const count = captures.length;
    for (let run = 0; run < W5_READ_CACHE_IDLE_RETRIES; run += 1)
      await fire(retry);
    expect(captures).toHaveLength(count + W5_READ_CACHE_IDLE_RETRIES);
    expect(live(retry)).toHaveLength(0);
    expect(readCache.cache.owed()).toBe(false);
    // Nothing reports as settled meanwhile.
    expect(readCache.cache.projection().holds(MANIFEST, 0)).toBe(false);
    // An own decision restarts them.
    const commitId = await write({ alwaysShow: false });
    await fire(own);
    expect(live(retry)).toHaveLength(1);
    // Once the log resolves, the next retry settles everything and stops.
    unresolved = undefined;
    await fire(retry);
    expect(live(retry)).toHaveLength(0);
    expect(readCache.cache.owed()).toBe(false);
    expect(readCache.cache.projection().holds(MANIFEST, commitId)).toBe(true);
    await expectFresh();
  });

  test('an entry no capture admits stops idle retries until named again', async () => {
    await compose();
    // An own write at commit N; then the log reports a commit awaiting
    // recovery and the file is edited out of band at N, so no capture can
    // settle it (Q7 takes other bytes at one position only when resolved).
    const commitId = await write({ alwaysShow: true });
    unresolved = 1;
    const path = join(dir, 'workspaces', 'a', 'workspace.json');
    writeFileSync(path, '{"edited":true}');
    await fire(own);
    expect(readCache.cache.projection().state(MANIFEST)).toBe('verifying');
    const count = captures.length;
    for (let run = 0; run < W5_READ_CACHE_IDLE_RETRIES; run += 1)
      await fire(retry);
    expect(captures).toHaveLength(count + W5_READ_CACHE_IDLE_RETRIES);
    expect(live(retry)).toHaveLength(0);
    expect(readCache.cache.owed()).toBe(false);
    // Still not served as settled.
    expect(readCache.cache.projection().state(MANIFEST)).toBe('verifying');
    expect(readCache.cache.projection().holds(MANIFEST, commitId)).toBe(false);
    // A plan naming it restarts the retries; once resolved, it settles.
    unresolved = undefined;
    await readCache.apply({
      broad: false,
      index: false,
      workspaces: [],
      manifests: ['a'],
      worktreeLists: [],
    });
    expect(readCache.cache.projection().state(MANIFEST)).toBe('current');
    await fire(retry);
    expect(live(retry)).toHaveLength(0);
    expect(readCache.cache.owed()).toBe(false);
    await expectFresh();
  });

  test('a failed broad refill owes a broad refill until one completes', async () => {
    await compose();
    expect(ready()).toBe(true);
    // The log moves on while no discovery capture can be answered.
    await foreignWrite({ alwaysShow: true });
    failing = (request): boolean => request.discoverWorkspaces;
    await expect(readCache.apply(BROAD)).rejects.toThrow('The capture failed');
    // The plan may have missed any commit: nothing held is served.
    expect(readCache.cache.warmed()).toBe(false);
    expect(readCache.cache.owed()).toBe(true);
    expect(ready()).toBe(false);
    for (const file of cached())
      expect(readCache.cache.projection().image(file)).toBeUndefined();
    // Each retry is broad, backs off and never counts as an idle run.
    const delays: number[] = [];
    for (let run = 0; run <= W5_READ_CACHE_IDLE_RETRIES; run += 1) {
      const count = captures.length;
      delays.push(live(retry)[0]?.ms ?? 0);
      await fire(retry);
      expect(
        captures.slice(count).map((request) => request.discoverWorkspaces),
      ).toEqual([true]);
      expect(ready()).toBe(false);
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 32].map((n) => n * RETRY_MS));
    expect(live(retry)).toHaveLength(1);
    // Once a broad refill completes, the cache is ready and owes nothing.
    failing = undefined;
    await fire(retry);
    expect(readCache.cache.warmed()).toBe(true);
    expect(readCache.cache.owed()).toBe(false);
    expect(ready()).toBe(true);
    expect(live(retry)).toHaveLength(0);
    await expectFresh();
  });

  test('a split broad refill failing partway owes a broad refill, as does a failed index capture', async () => {
    const ids = Array.from({ length: 130 }, (_, index) => `w${index}`);
    writeFileSync(
      join(dir, 'workspaces', 'index.json'),
      JSON.stringify({ version: 1, workspaces: ids.map((id) => ({ id })) }),
    );
    await compose();
    expect(ready()).toBe(true);
    // The first halves land; the one carrying w129's files fails.
    failing = (request): boolean =>
      request.files.some(
        (file) => 'workspaceId' in file && file.workspaceId === 'w129',
      );
    const count = captures.length;
    await expect(readCache.apply(BROAD)).rejects.toThrow('The capture failed');
    const landed = captures
      .slice(count)
      .filter((request) => !failing?.(request));
    expect(landed.length).toBeGreaterThan(1);
    expect(readCache.cache.warmed()).toBe(false);
    expect(readCache.cache.owed()).toBe(true);
    expect(ready()).toBe(false);
    for (const file of cached())
      expect(readCache.cache.projection().state(file)).toBe('dirty');
    // The retry is broad: its index capture fails first this time.
    failing = (request): boolean =>
      !request.discoverWorkspaces &&
      request.files.length === 1 &&
      request.files[0]?.kind === 'index';
    const before = captures.length;
    await fire(retry);
    expect(captures.slice(before)).toEqual([
      { files: [{ kind: 'index' }], discoverWorkspaces: false },
    ]);
    expect(readCache.cache.owed()).toBe(true);
    expect(ready()).toBe(false);
    failing = undefined;
    await fire(retry);
    expect(readCache.cache.warmed()).toBe(true);
    expect(readCache.cache.owed()).toBe(false);
    expect(ready()).toBe(true);
    expect(live(retry)).toHaveLength(0);
    expect(cached()).toHaveLength(1 + 2 * ids.length);
    await expectFresh(cached().slice(0, 200));
  });

  test('a failed targeted capture stops serving its files and retries them until one lands', async () => {
    await compose();
    const commitId = await foreignWrite({ alwaysShow: true });
    failing = (request): boolean => !request.discoverWorkspaces;
    await expect(
      readCache.apply({
        broad: false,
        index: false,
        workspaces: [],
        manifests: ['a'],
        worktreeLists: [],
        commitId,
      }),
    ).rejects.toThrow('The capture failed');
    // Only the named file stops being served, as a file over the limits does;
    // the plan named every file the commit touched, so the rest still holds.
    expect(readCache.cache.projection().state(MANIFEST)).toBe('dirty');
    expect(readCache.cache.projection().image(MANIFEST)).toBeUndefined();
    expect(readCache.cache.warmed()).toBe(true);
    expect(readCache.cache.owed()).toBe(true);
    expect(ready()).toBe(true);
    // Each retry captures the marked file and never counts as an idle run.
    for (let run = 0; run <= W5_READ_CACHE_IDLE_RETRIES; run += 1) {
      const count = captures.length;
      await fire(retry);
      expect(captures.slice(count)).toEqual([
        { files: [MANIFEST], discoverWorkspaces: false },
      ]);
      expect(readCache.cache.owed()).toBe(true);
    }
    failing = undefined;
    await fire(retry);
    expect(readCache.cache.projection().holds(MANIFEST, commitId)).toBe(true);
    expect(readCache.cache.owed()).toBe(false);
    expect(live(retry)).toHaveLength(0);
    await expectFresh();
  });
});

/*
 * CAN-7155 PR 3 (Seam A): the composition root's read view over the warm
 * cache. The dispatcher's wrapper reads, which the branch observer, the
 * sidebar, `readProjectWorktrees` and the poller's row lookup make, read
 * exactly as today's captured reads do, without capturing; another origin's
 * commit is read once its plan applied; the issuing desktop's own write is
 * read through a capture until its trailing refill settles it.
 */
describe('dispatcher reads served from the read cache (CAN-7155 Seam A)', () => {
  const caller = {
    principalId: 'test-user',
    clientInstanceId: 'test-client',
    authorityId: 'local-desktop',
    interfaceKind: 'test' as const,
    grants: ['core.workspace.read' as const, 'core.worktree.read' as const],
  };

  test('a second broad invalidation in recovery backoff revokes a newer serving token', async () => {
    rmSync(join(dir, 'workspaces', 'index.json'));
    bridgeRetryMs = 10;
    await compose();
    await getWorkspaceIndexRepository().update(() => ({
      entries: ['a', 'b'].map((id, order) => ({
        id,
        name: id,
        type: 'multi-repo' as const,
        color: '#7C3AED',
        collapsed: false,
        order,
      })),
      result: undefined,
    }));
    await write({});
    await writeWorkspaceConfig('b', CONFIG);
    await attach();
    const latest = harness.events().at(-1)?.cursor.sequence;
    if (latest === undefined) throw new Error('Expected a retained seed event');
    await until(() => acks.includes(latest));
    const initial = applied.length;
    const initialAcks = acks.length;
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'performance'],
    });
    try {
      handlerFailure = true;
      await foreignWrite({ alwaysShow: true });
      // A targeted handler fails, then all three broad reconciliations fail.
      await until(() => applied.length >= initial + 2);
      await jest.advanceTimersByTimeAsync(bridgeRetryMs);
      await until(() => applied.length >= initial + 3);
      await jest.advanceTimersByTimeAsync(bridgeRetryMs * 2);
      await until(
        () => applied.length >= initial + 4 && acks.length > initialAcks,
      );
      handlerFailure = false;
      // The cache's independent live broad refill can finish during bridge backoff.
      await readCache.apply(BROAD);
      expect(ready()).toBe(true);
      const before = captures.length;
      const acknowledged = acks.length;
      const manifest = join(harness.root, 'a', 'workspace.json');
      harness.hooks.commit.before = (): Promise<void> => {
        harness.hooks.commit.before = undefined;
        writeFileSync(
          manifest,
          JSON.stringify({ ...CONFIG, alwaysShow: false }),
        );
        return Promise.resolve();
      };
      await expect(foreignWrite({ alwaysShow: false })).rejects.toMatchObject({
        name: 'W5FileWriteRefusedError',
      });
      await until(() => acks.length > acknowledged);
      expect(captures).toHaveLength(before);
      expect(harness.events().at(-1)).toMatchObject({
        name: CORE_WORKSPACE_INVALIDATED_EVENT,
      });

      installDesktopW5FileStore(electron);
      registerDesktopW5ReadCacheServer(readCache);
      const cached = createDesktopRuntime({
        workspaceServices: {
          ...defaultCoreWorkspaceReadServices(),
          readView: runDesktopW5CachedReadView,
        },
      });
      const today = createDesktopRuntime();
      __setDesktopW5FileStoreForTests(undefined);
      try {
        const params = { workspaceId: 'b' };
        const fresh = await today.queryWorkspaceGetForLegacyIpc(params, {
          caller,
        });
        expect(fresh.canonicalResult).not.toHaveProperty('revision');
        expect(
          await cached.queryWorkspaceGetForLegacyIpc(params, { caller }),
        ).toEqual(fresh);
        expect(readCache.ready()).toBe(false);
        await readCache.cache.refillMarked();
        expect(readCache.ready()).toBe(false);
        await jest.advanceTimersByTimeAsync(bridgeRetryMs * 8);
        await until(() => readCache.ready());
        expect(
          await cached.queryWorkspaceGetForLegacyIpc(params, { caller }),
        ).toEqual(fresh);
      } finally {
        __setDesktopW5FileStoreForTests(electron);
        registerDesktopW5ReadCacheServer(undefined);
        await Promise.all([cached.shutdown(), today.shutdown()]);
      }
    } finally {
      handlerFailure = false;
      harness.hooks.commit.before = undefined;
      jest.useRealTimers();
    }
  });

  test.each([
    'replace',
    'empty',
    'malformed',
    'missing',
    'poll-missing',
    'replace-during-broad',
  ] as const)(
    'an external worktree list change (%s) invalidates before the watcher reload and refills only that list',
    async (change) => {
      const file = { kind: 'worktrees', workspaceId: 'a' } as const;
      const path = join(dir, 'workspaces', 'a', 'worktrees.json');
      writeFileSync(
        join(dir, 'workspaces', 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: ['a', 'b'].map((id, order) => ({
            id,
            name: id.toUpperCase(),
            type: 'multi-repo',
            color: '#7C3AED',
            collapsed: false,
            order,
          })),
        }),
      );
      const oldRows: WorktreeData[] = [
        {
          id: 'old',
          branchName: 'old',
          createdAt: '2026-11-01T00:00:00Z',
        },
      ];
      const newRows: WorktreeData[] = change.startsWith('replace')
        ? [
            {
              id: 'new',
              branchName: 'new',
              createdAt: '2026-11-02T00:00:00Z',
            },
          ]
        : [];
      for (const id of ['a', 'b'])
        writeFileSync(
          join(dir, 'workspaces', id, 'workspace.json'),
          JSON.stringify(CONFIG),
        );
      writeFileSync(path, JSON.stringify({ version: 1, worktrees: oldRows }));
      const counted = await prepare();
      await readCache.activate(counted);
      const releaseBroad = deferred();
      let rebuilding: Promise<void> | undefined;
      // A cache miss must use the production slot's real capture, not the
      // test slot (which makes the cache stand aside) or an uninstalled host.
      installDesktopW5FileStore(electron);
      registerDesktopW5ReadCacheServer(readCache);
      const runtime = createDesktopRuntime({
        workspaceServices: {
          ...defaultCoreWorkspaceReadServices(),
          readView: runDesktopW5CachedReadView,
        },
      });
      const today = createDesktopRuntime();
      __setDesktopW5FileStoreForTests(undefined);
      try {
        const identities = (
          rows: readonly WorktreeData[],
        ): { id: string; branchName: string }[] =>
          rows.map(({ id, branchName }) => ({ id, branchName }));
        expect(
          identities(
            (await runtime.readWorktreeListForLegacy('a', { caller }))
              .legacyResult,
          ),
        ).toEqual(identities(oldRows));
        syncWorktreesFileWatchers(
          [
            {
              id: 'a',
              type: 'multi-repo',
              name: 'A',
              color: '#7C3AED',
              collapsed: false,
              order: 0,
              repos: [],
              worktrees: oldRows,
            },
          ],
          () => null,
          new Set(),
          undefined,
          true,
        );
        const watch = jest.mocked(createWorktreeWatch).mock.calls.at(-1)?.[0];
        if (!watch) throw new Error('The list watcher must be installed');
        await watch.poll();
        if (change === 'replace-during-broad') {
          const capture = counted.capture?.bind(counted);
          if (!capture) throw new Error('The daemon-backed store captures');
          const captured = deferred();
          jest
            .spyOn(counted, 'capture')
            .mockImplementationOnce(async (request) => {
              const result = await capture(request);
              captured.open();
              await releaseBroad.promise;
              return result;
            });
          rebuilding = readCache.apply(BROAD);
          await captured.promise;
        }
        if (change === 'missing' || change === 'poll-missing') rmSync(path);
        else
          writeFileSync(
            path,
            change === 'malformed'
              ? '{'
              : JSON.stringify({ version: 1, worktrees: newRows }),
          );
        // Start the reload in the dispatch itself: invalidation cannot wait
        // for reconciliation, a timer or the refill's capture to finish.
        const nextReload = (): Promise<
          Awaited<ReturnType<typeof runtime.readWorktreeListForLegacy>>
        > =>
          new Promise((resolve, reject) => {
            jest.mocked(sendToWindow).mockImplementation((_window, channel) => {
              if (channel === IPC_CHANNELS.worktreesFileChanged)
                void runtime
                  .readWorktreeListForLegacy('a', { caller })
                  .then(resolve, reject);
              return true;
            });
          });
        const reload = nextReload();
        const before = captures.length;
        if (change === 'poll-missing') {
          const scheduled = jest.spyOn(globalThis, 'setTimeout');
          try {
            await watch.poll();
            // Fail before waiting for a notification the broken poll drops.
            expect(scheduled.mock.calls.some(([, ms]) => ms === 500)).toBe(
              true,
            );
          } finally {
            scheduled.mockRestore();
          }
        } else watch.onChange('change', 'worktrees.json');
        const loaded = await reload;
        expect(identities(loaded.legacyResult)).toEqual(identities(newRows));
        // Full provenance, not only membership, must equal today's capture
        // before the targeted refill and again once the cache serves it.
        expect(loaded).toEqual(
          await today.readWorktreeListForLegacy('a', { caller }),
        );
        expect(readCache.cache.projection().state(file)).toBe('dirty');
        expect(captures).toHaveLength(before);
        // Invalidation is local; a broad rebuild still gates serving globally.
        const unaffected = {
          files: [{ kind: 'worktrees', workspaceId: 'b' }],
          discoverWorkspaces: false,
        } as const;
        expect(readCache.cache.projection().serve(unaffected).status).toBe(
          'served',
        );
        if (!rebuilding)
          expect(await readCache.serve(unaffected)).toBeDefined();
        await fire(own);
        expect(captures.slice(before)).toEqual([
          { files: [file], discoverWorkspaces: false },
        ]);
        expect(readCache.cache.projection().state(file)).toBe('current');
        if (rebuilding) {
          expect(readCache.cache.rebuilding()).toBe(true);
          expect(readCache.ready()).toBe(false);
          expect(await readCache.serve(unaffected)).toBeUndefined();
        }
        // The delayed broad capture has the same log position but old bytes.
        // It cannot undo the targeted refill, even after the mark is settled.
        releaseBroad.open();
        await rebuilding;
        await expectFresh();
        expect(
          await readCache.serve({ files: [file], discoverWorkspaces: false }),
        ).toBeDefined();
        expect(
          await runtime.readWorktreeListForLegacy('a', { caller }),
        ).toEqual(loaded);
        if (change === 'missing' || change === 'poll-missing') {
          if (change === 'poll-missing') {
            const unchanged = jest.spyOn(globalThis, 'setTimeout');
            try {
              await watch.poll();
              await watch.poll();
              expect(unchanged.mock.calls.some(([, ms]) => ms === 500)).toBe(
                false,
              );
            } finally {
              unchanged.mockRestore();
            }
          }
          // A native deletion can be followed by polling after watch recovery.
          // Recreating the original bytes is a change from the observed absence.
          writeFileSync(
            path,
            JSON.stringify({ version: 1, worktrees: oldRows }),
          );
          const recreated = nextReload();
          const scheduled = jest.spyOn(globalThis, 'setTimeout');
          try {
            await watch.poll();
            expect(scheduled.mock.calls.some(([, ms]) => ms === 500)).toBe(
              true,
            );
          } finally {
            scheduled.mockRestore();
          }
          const restored = await recreated;
          expect(identities(restored.legacyResult)).toEqual(
            identities(oldRows),
          );
          expect(restored).toEqual(
            await today.readWorktreeListForLegacy('a', { caller }),
          );
          expect(readCache.cache.projection().state(file)).toBe('dirty');
          const beforeRestore = captures.length;
          await fire(own);
          expect(captures.slice(beforeRestore)).toEqual([
            { files: [file], discoverWorkspaces: false },
          ]);
          expect(
            await runtime.readWorktreeListForLegacy('a', { caller }),
          ).toEqual(restored);
          const unchanged = jest.spyOn(globalThis, 'setTimeout');
          try {
            await watch.poll();
            expect(unchanged.mock.calls.some(([, ms]) => ms === 500)).toBe(
              false,
            );
          } finally {
            unchanged.mockRestore();
          }
          // Deletion/recreation must not disable content-based self-write
          // suppression: the app's own commit already updates its cache.
          const selfRows = oldRows.map((row) => ({
            ...row,
            branchName: 'own',
          }));
          await writeWorkspaceWorktrees('a', selfRows);
          const selfWrite = jest.spyOn(globalThis, 'setTimeout');
          try {
            await watch.poll();
            expect(selfWrite.mock.calls.some(([, ms]) => ms === 500)).toBe(
              false,
            );
          } finally {
            selfWrite.mockRestore();
          }
          await fire(own);
          expect(
            identities(
              (await runtime.readWorktreeListForLegacy('a', { caller }))
                .legacyResult,
            ),
          ).toEqual(identities(selfRows));
        }
      } finally {
        releaseBroad.open();
        await rebuilding;
        stopWorktreesFileWatchers();
        jest.mocked(sendToWindow).mockReset();
        __setDesktopW5FileStoreForTests(electron);
        registerDesktopW5ReadCacheServer(undefined);
        await Promise.all([runtime.shutdown(), today.shutdown()]);
      }
    },
  );

  test.each(['unrelated', 'selected'] as const)(
    'scoped reads match fresh revisions after a pending commit resolves (%s)',
    async (affected) => {
      writeFileSync(
        join(dir, 'workspaces', 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: ['a', 'b'].map((id, order) => ({
            id,
            name: id.toUpperCase(),
            type: 'multi-repo',
            color: '#7C3AED',
            collapsed: false,
            order,
          })),
        }),
      );
      const counted = await prepare();
      const organizationId = '11111111-1111-4111-8111-111111111111';
      const config: WorkspaceConfigFile = {
        ...CONFIG,
        alwaysShow: false,
        owner: {
          type: 'organization',
          organizationId,
          projectId: '22222222-2222-4222-8222-222222222222',
          instanceId: '33333333-3333-4333-8333-333333333333',
          bindingGeneration: 1,
        },
      };
      await writeWorkspaceConfig('a', config, { ownership: 'replace' });
      const oldRows: WorktreeData[] = [
        {
          id: 'wt-1',
          branchName: 'before',
          createdAt: '2026-11-01T00:00:00Z',
        },
      ];
      await writeWorkspaceWorktrees('a', oldRows);
      await readCache.activate(counted);
      const file = { kind: 'worktrees', workspaceId: 'a' } as const;
      const request = {
        files: [...(affected === 'selected' ? [MANIFEST] : []), file],
        discoverWorkspaces: false,
      };
      const path = join(harness.root, 'a', 'workspace.json');
      const saved = `${path}.saved`;
      const previous = await foreignStore.read(path);
      if (previous.state !== 'present')
        throw new Error('Expected the pending commit preimage');
      let pendingId: number | undefined;
      let replaced = false;
      harness.hooks.commit.before = (request): Promise<void> => {
        if (!request.files.some((file) => file.path === path))
          throw new Error('Expected only the selected fixture write');
        harness.hooks.commit.before = undefined;
        renameSync(path, saved);
        replaced = true;
        mkdirSync(path);
        return Promise.resolve();
      };
      harness.hooks.commit.after = (_request, outcome): Promise<void> => {
        if (outcome.status === 'recovery-required')
          pendingId = outcome.commitId;
        return Promise.resolve();
      };
      try {
        // List-bearing commits recheck preimages before deciding. Fail a
        // manifest apply instead; organization-scoped reads select it too.
        await expect(
          withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
            foreignStore.replace(
              path,
              JSON.stringify({ ...config, alwaysShow: true }, null, 2),
              WORKSPACE_MANIFEST_STORAGE,
              {
                operation: 'w5.workspace_manifest.write',
                advance: [{ kind: 'workspace', workspaceId: 'a' }],
                previousRaw: previous.raw,
              },
            ),
          ),
        ).rejects.toMatchObject({ reason: 'recovery-required' });
      } finally {
        harness.hooks.commit.before = undefined;
        harness.hooks.commit.after = undefined;
        if (replaced) {
          rmSync(path, { recursive: true, force: true });
          renameSync(saved, path);
        }
      }
      if (pendingId === undefined) throw new Error('Expected a pending commit');
      await readCache.apply({
        broad: false,
        index: false,
        workspaces: [],
        manifests: affected === 'selected' ? ['a'] : [],
        worktreeLists: ['a'],
      });
      const pending = readCache.cache.projection().serve(request);
      if (pending.status !== 'served')
        throw new Error('Pending images are served');
      expect(pending.capture.log.unresolvedCommits).toBe(1);
      if (affected === 'selected')
        expect(
          pending.capture.files.find((image) => image.kind === 'manifest'),
        ).toMatchObject({
          base64: Buffer.from(previous.raw).toString('base64'),
        });
      const resource = {
        kind: 'worktree',
        workspaceId: 'a',
        worktreeId: 'wt-1',
      } as const;
      expect(
        classifyW5RevisionEligibility(pending.capture, resource, 'complete'),
      ).toEqual({ status: 'unverified', reason: 'pending' });
      // Recovery can change selected bytes at the same commit id. Clearing
      // the global counter on another file cannot certify those old bytes.
      expect(
        await harness.host().retryRecoveryRequiredCommit(pendingId),
      ).toMatchObject({
        status: 'applied',
        commitId: pendingId,
      });
      if (affected === 'selected') {
        __setDesktopW5FileStoreForTests(foreignStore);
        try {
          await writeWorkspaceConfig('b', CONFIG);
        } finally {
          __setDesktopW5FileStoreForTests(electron);
        }
      }
      // A different selector sees resolution at the same or a later position;
      // the selected list keeps its earlier, pending evidence.
      await readCache.apply({
        broad: false,
        index: false,
        workspaces: [],
        manifests: ['b'],
        worktreeLists: [],
      });
      expect(readCache.cache.projection().commitId(file)).toBe(pendingId);
      const queries: W5CaptureRequest[] = [];
      installDesktopW5FileStore({
        ...electron,
        capture: (captureRequest) => {
          queries.push(captureRequest);
          if (!electron.capture) throw new Error('The store captures');
          return electron.capture(captureRequest);
        },
      });
      registerDesktopW5ReadCacheServer(readCache);
      const cached = createDesktopRuntime({
        workspaceServices: {
          ...defaultCoreWorkspaceReadServices(),
          readView: runDesktopW5CachedReadView,
        },
      });
      const today = createDesktopRuntime();
      const params = {
        worktreeId: 'wt-1',
        scope: {
          workspaceId: 'a',
          ...(affected === 'selected' ? { organizationId } : {}),
        },
      };
      __setDesktopW5FileStoreForTests(undefined);
      try {
        const expected = await today.queryWorktreeGetForLegacyIpc(params, {
          caller,
        });
        expect(expected.canonicalResult).toHaveProperty('revision');
        expect(expected.canonicalResult).toMatchObject({ branch: 'before' });
        const before = queries.length;
        for (let i = 0; i < 2; i += 1)
          expect(
            await cached.queryWorktreeGetForLegacyIpc(params, { caller }),
          ).toEqual(expected);
        expect(queries).toHaveLength(before + 2);
        const refresh = (timer: Timer): boolean =>
          timer.ms === W5_READ_CACHE_REFRESH_MS;
        expect(live(refresh)).toHaveLength(1);
        const beforeRefill = captures.length;
        await fire(refresh);
        expect(captures.slice(beforeRefill)).toEqual([request]);
        const afterRefill = queries.length;
        expect(
          await cached.queryWorktreeGetForLegacyIpc(params, { caller }),
        ).toEqual(expected);
        expect(queries).toHaveLength(afterRefill);
        expect(live(refresh)).toHaveLength(0);
        if (!electron.capture) throw new Error('The store captures');
        const fresh = await electron.capture(request);
        const settled = readCache.cache.projection().serve(request);
        if (settled.status !== 'served')
          throw new Error('The refreshed images must be served');
        expect(settled.capture).toEqual(fresh.capture);
        if (affected === 'selected')
          expect(
            settled.capture.files.find((image) => image.kind === 'manifest'),
          ).not.toEqual(
            pending.capture.files.find((image) => image.kind === 'manifest'),
          );
      } finally {
        __setDesktopW5FileStoreForTests(electron);
        registerDesktopW5ReadCacheServer(undefined);
        await Promise.all([cached.shutdown(), today.shutdown()]);
      }
    },
  );

  test('repeat reads capture nothing and equal the captured read', async () => {
    const workspaces = join(dir, 'workspaces');
    writeFileSync(
      join(workspaces, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: ['a', 'b'].map((id, order) => ({
          id,
          name: id.toUpperCase(),
          type: 'multi-repo',
          color: '#7C3AED',
          collapsed: false,
          order,
        })),
      }),
    );
    for (const id of ['a', 'b'])
      writeFileSync(
        join(workspaces, id, 'workspace.json'),
        JSON.stringify(CONFIG),
      );
    writeFileSync(
      join(workspaces, 'a', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'wt-1',
            branchName: 'feature',
            createdAt: '2026-11-01T00:00:00Z',
            includedRepoIds: ['repo-a'],
          },
        ],
      }),
    );
    await compose();
    await attach();
    await until(() => applied.some((plan) => plan.broad));
    directoryWatch();
    directoryWatch('a');
    directoryWatch('b');
    // Today's per-query captures, apart from the cache's own (`captures`).
    const queries: W5CaptureRequest[] = [];
    const queryStore: W5CommitLogFileStore = {
      ...electron,
      capture: (request) => {
        queries.push(request);
        if (!electron.capture) throw new Error('The store captures');
        return electron.capture(request);
      },
    };
    installDesktopW5FileStore(queryStore);
    registerDesktopW5ReadCacheServer(readCache);
    const served = createDesktopRuntime({
      workspaceServices: {
        ...defaultCoreWorkspaceReadServices(),
        readView: runDesktopW5CachedReadView,
      },
    });
    const today = createDesktopRuntime();
    const read = async (
      runtime: DesktopCanopyDispatcher,
    ): Promise<unknown[]> => {
      // Reads run as production's do: no test store shadows the slot.
      __setDesktopW5FileStoreForTests(undefined);
      try {
        return [
          await runtime.queryWorkspaceListForLegacyIpc({}, { caller }),
          await runtime.queryWorktreeListForLegacyIpc({}, { caller }),
          await runtime.readWorktreeListForLegacy('a', { caller }),
          await runtime.queryWorkspaceGetForLegacyIpc(
            { workspaceId: 'a' },
            { caller },
          ),
          await runtime.queryWorktreeGetForLegacyIpc(
            { worktreeId: 'wt-1', scope: { workspaceId: 'a' } },
            { caller },
          ),
          await runtime.queryWorktreeGetForLegacyIpc(
            { worktreeId: 'wt-1' },
            { caller },
          ),
        ];
      } finally {
        __setDesktopW5FileStoreForTests(electron);
      }
    };
    /**
     * Reads through the cache as the moved background readers do; returns
     * today's captures they made. A served read records no capture work,
     * charges its caller none, and decodes only images it had not served.
     */
    const readServed = async (
      options: { decodes?: false; parses?: false } = {},
    ): Promise<number> => {
      // Fresh captures (also the unselected-host and miss path) must not
      // pay the parsed memo's deep-copy cost for disposable images.
      const copies = jest.spyOn(globalThis, 'structuredClone');
      let expected: unknown[];
      try {
        expected = await read(today);
        expect(
          copies.mock.calls.filter(
            ([value]) =>
              value !== null &&
              typeof value === 'object' &&
              (('detail' in value && 'manifest' in value) ||
                ('authority' in value &&
                  ('storedFields' in value || 'document' in value))),
          ),
        ).toEqual([]);
      } finally {
        copies.mockRestore();
      }
      const before = queries.length;
      const cacheCaptures = captures.length;
      resetWorkCounters();
      const parse = jest.spyOn(JSON, 'parse');
      let parsedFiles: unknown[][];
      try {
        expect(
          await runWithW5Caller('background:branch-observer', () =>
            read(served),
          ),
        ).toEqual(expected);
        parsedFiles = parse.mock.calls.filter(([raw]) =>
          /"(?:workspaces|worktrees|repos)":/.test(String(raw)),
        );
      } finally {
        parse.mockRestore();
      }
      if (options.parses === false) expect(parsedFiles).toEqual([]);
      expect(captures).toHaveLength(cacheCaptures);
      const made = queries.length - before;
      const { w5, w5Caller } = snapshotWorkCounters();
      if (made === 0) {
        expect(w5).toMatchObject({ 'readView.cached': 6 });
        for (const key of [
          'readView.captured',
          'read.backend.capture',
          'port.capture',
        ])
          expect(w5[key]).toBeUndefined();
        expect(w5Caller).toEqual({});
        if (options.decodes === false)
          expect(w5['decoded.view.bytes']).toBeUndefined();
      }
      return made;
    };
    const wasE2e: unknown = Reflect.get(globalThis, '__CANOPY_E2E__');
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      value: true,
      configurable: true,
      writable: true,
    });
    try {
      expect(await readServed()).toBe(0);
      expect(await readServed({ decodes: false, parses: false })).toBe(0);
      // An existing captured view, like GB4, keeps today's nested read path.
      __setDesktopW5FileStoreForTests(undefined);
      try {
        await runDesktopW5CachedReadView(
          { files: [{ kind: 'index' }], discoverWorkspaces: false },
          async () => {
            expect(await readServed()).toBe(6);
          },
        );
      } finally {
        __setDesktopW5FileStoreForTests(electron);
      }
      __setDesktopW5FileStoreForTests(undefined);
      try {
        const config = await served.queryWorkspaceGetForLegacyIpc(
          { workspaceId: 'a' },
          { caller },
        );
        config.legacyResult.repos.push({
          id: 'poison',
          name: 'Poison',
          repoPath: '/poison',
        });
        const row = await served.queryWorktreeGetForLegacyIpc(
          { worktreeId: 'wt-1' },
          { caller },
        );
        if (!row.legacyResult) throw new Error('Expected the seeded row');
        row.legacyResult.branchName = 'poison';
        row.legacyResult.includedRepoIds?.push('poison');
      } finally {
        __setDesktopW5FileStoreForTests(electron);
      }
      expect(await readServed({ parses: false })).toBe(0);
      // A lock held, on a list no read names (today's locked reads would
      // wait on it), by `holder` until the returned release runs.
      const holdLock = async (
        holder: (work: () => Promise<void>) => Promise<void>,
      ): Promise<() => Promise<void>> => {
        const release = deferred();
        const held = deferred();
        const holding = holder(() =>
          withW5RepositoryLock(
            {
              kind: 'list',
              path: join(workspaces, 'unlisted', 'worktrees.json'),
            },
            () => {
              held.open();
              return release.promise;
            },
          ),
        );
        await held.promise;
        return async () => {
          release.open();
          await holding;
        };
      };
      // Another reader's lock, taken inside its read view, which refuses
      // writes: reads are still served.
      __setDesktopW5FileStoreForTests(undefined);
      const releaseReader = await holdLock((work) =>
        runDesktopW5CachedReadView(
          { files: [{ kind: 'index' }], discoverWorkspaces: false },
          work,
        ),
      ).finally(() => __setDesktopW5FileStoreForTests(electron));
      try {
        expect(await readServed()).toBe(0);
      } finally {
        await releaseReader();
      }
      // A real locked list read outside a view, with repair disabled.
      const held = deferred();
      const release = deferred();
      installDesktopW5FileStore({
        ...queryStore,
        read: async (path) => {
          const result = await electron.read(path);
          if (path === join(workspaces, 'unlisted', 'worktrees.json')) {
            held.open();
            await release.promise;
          }
          return result;
        },
      });
      __setDesktopW5FileStoreForTests(undefined);
      const plainRead = readWorkspaceWorktreesDetailed('unlisted', {
        persistRemovalCleanup: false,
      });
      await held.promise;
      try {
        expect(await readServed()).toBe(0);
      } finally {
        release.open();
        await plainRead;
        installDesktopW5FileStore(queryStore);
      }
      // A writer-capable lock makes the cache take today's capture path.
      // This pins fallback equality, not read-after-writer ordering: today's
      // path captures before taking the list lock and can capture old bytes.
      const releaseWriter = await holdLock((work) => work());
      try {
        expect(await readServed()).toBe(6);
        expect(snapshotWorkCounters().w5).toMatchObject({
          'readView.cacheMiss.writing': 6,
        });
      } finally {
        await releaseWriter();
      }
      expect(await readServed()).toBe(0);
      // Another origin's commit: read once its plan applied, not captured.
      const foreignId = await foreignWrite({ alwaysShow: true });
      await until(() => applied.some((plan) => plan.commitId === foreignId));
      expect(await readServed()).toBe(0);
      const [, , , get] = await read(served);
      expect(get).toMatchObject({ legacyResult: { alwaysShow: true } });
      // An own write is read through a capture until its refill settles it,
      // and leaves the other workspace's manifest servable.
      await write({ alwaysShow: false });
      // Every read names the index, which the write's advance left verifying.
      expect(await readServed()).toBe(6);
      await fire(own);
      expect(await readServed()).toBe(0);
      const [, , , after] = await read(served);
      expect(after).toMatchObject({ legacyResult: { alwaysShow: false } });
      // Index and manifest are both required for scoped organization reads.
      const organizationId = '11111111-1111-4111-8111-111111111111';
      await writeWorkspaceConfig(
        'a',
        {
          ...CONFIG,
          owner: {
            type: 'organization',
            organizationId,
            projectId: '22222222-2222-4222-8222-222222222222',
            instanceId: '33333333-3333-4333-8333-333333333333',
            bindingGeneration: 1,
          },
        },
        { ownership: 'replace' },
      );
      await fire(own);
      const unchangedManifest = { kind: 'manifest', workspaceId: 'b' } as const;
      const unchangedCommit = readCache.cache
        .projection()
        .commitId(unchangedManifest);
      await getWorkspaceIndexRepository().update(({ entries }) => ({
        entries: entries.map((entry) =>
          entry.id === 'a' ? { ...entry, name: 'Renamed' } : entry,
        ),
        result: undefined,
      }));
      await fire(own);
      expect(readCache.cache.projection().commitId(unchangedManifest)).toBe(
        unchangedCommit,
      );
      __setDesktopW5FileStoreForTests(undefined);
      try {
        const params = { workspaceId: 'a', scope: { organizationId } };
        const expected = await today.queryWorkspaceGetForLegacyIpc(params, {
          caller,
        });
        // The own refill covers both the index and a's advanced revision.
        // Even the first scoped read must serve without another capture.
        const before = queries.length;
        const scoped = await served.queryWorkspaceGetForLegacyIpc(params, {
          caller,
        });
        expect(scoped).toEqual(expected);
        expect(scoped.canonicalResult).toMatchObject({ name: 'Renamed' });
        expect(queries).toHaveLength(before);
        const refresh = (timer: Timer): boolean =>
          timer.ms === W5_READ_CACHE_REFRESH_MS;
        expect(live(refresh)).toHaveLength(0);

        // b was not advanced: discovery needs its older manifest's evidence
        // at the new index position. Misses coalesce into one refresh.
        const list = await today.queryWorkspaceListForLegacyIpc({}, { caller });
        const beforeMiss = queries.length;
        resetWorkCounters();
        for (let i = 0; i < 2; i += 1)
          expect(
            await served.queryWorkspaceListForLegacyIpc({}, { caller }),
          ).toEqual(list);
        expect(queries).toHaveLength(beforeMiss + 2);
        expect(snapshotWorkCounters().w5['readView.cacheMiss.lagging']).toBe(2);
        // A slow refresh must also coalesce misses while its capture runs.
        captureGate = deferred();
        const beforeRefresh = captures.length;
        const refreshing = fire(refresh);
        try {
          // Root identity I/O precedes the counted capture.
          await until(() => captures.length > beforeRefresh);
          expect(captures).toHaveLength(beforeRefresh + 1);
          const beforeInFlightMiss = queries.length;
          expect(
            await served.queryWorkspaceListForLegacyIpc({}, { caller }),
          ).toEqual(list);
          expect(queries).toHaveLength(beforeInFlightMiss + 1);
          expect(captures).toHaveLength(beforeRefresh + 1);
          expect(live(refresh)).toHaveLength(0);
        } finally {
          captureGate.open();
          await refreshing;
          captureGate = undefined;
        }
        expect(captures.slice(beforeRefresh)).toEqual([
          {
            files: [unchangedManifest],
            discoverWorkspaces: false,
          },
        ]);
        const afterRefresh = queries.length;
        expect(
          await served.queryWorkspaceListForLegacyIpc({}, { caller }),
        ).toEqual(list);
        expect(queries).toHaveLength(afterRefresh);
        expect(live(refresh)).toHaveLength(0);
      } finally {
        __setDesktopW5FileStoreForTests(electron);
      }
    } finally {
      Object.defineProperty(globalThis, '__CANOPY_E2E__', {
        value: wasE2e,
        configurable: true,
        writable: true,
      });
      registerDesktopW5ReadCacheServer(undefined);
      await Promise.all([served.shutdown(), today.shutdown()]);
    }
  });
});
