import type * as LegacyStorage from './fixtures/w5-legacy-storage';
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
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import {
  planCanopyWorkspaceInvalidation,
  type CanopyEventsConnection,
  type CanopyWorkspaceInvalidationPlan,
} from '@canopy/core-client';
import {
  W5_CAPTURE_LIMITS,
  type W5CaptureFile,
  type W5CaptureRequest,
} from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import { classifyW5FileProvenance } from '@canopy/core-runtime/node/w5/commit-log/eligibility';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { W5_READ_CACHE_IDLE_RETRIES } from '@canopy/core-runtime/node/w5/committed-read-cache';
import { CORE_WORKSPACE_INVALIDATED_EVENT } from '@canopy/protocol/canopy-core';
import {
  createDesktopW5ReadCache,
  type DesktopW5ReadCache,
  type W5ReadCacheSchedule,
} from '../../canopy-runtime/w5-read-cache';
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
import { __setDesktopW5FileStoreForTests } from '../w5-commit-log-file-store';
import type { W5RecordPortClient } from '../w5-daemon-record-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../w5-daemon-record-store';
import { nodeW5FileStore } from '../w5-file-store';
import { writeWorkspaceConfig } from '../workspace-persistence';

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
/** Plans the binding applied, in order, and what each handler saw. */
let applied: CanopyWorkspaceInvalidationPlan[];
let seen: { handler: string; commitId: number | undefined }[];
let acks: number[];
let stepGate: Deferred | undefined;
let handlerGate: Deferred | undefined;
let beforeOpen: (() => Promise<void>) | undefined;
/** A slow consumer's subscribe window, so a test can make it lag. */
let maxInFlight: number | undefined;
/** The daemon health latch, as the cache reads it. */
let usable: boolean;
/** Holds the cache's next captures until opened. */
let captureGate: Deferred | undefined;
/** Captures report this many unresolved commits, as a log awaiting recovery. */
let unresolved: number | undefined;
/** Captures this matches reject, as a daemon that cannot answer them. */
let failing: ((request: W5CaptureRequest) => boolean) | undefined;
/** Captures report abandoned history, as a log that lost a commit. */
let abandoned: boolean;
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
      return client.openStream(
        name,
        maxInFlight === undefined ? params : { ...params, maxInFlight },
        options,
      );
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
  applied = [];
  seen = [];
  acks = [];
  stepGate = undefined;
  handlerGate = undefined;
  beforeOpen = undefined;
  maxInFlight = undefined;
  usable = true;
  captureGate = undefined;
  unresolved = undefined;
  failing = undefined;
  abandoned = false;
  timers = [];
  clock = 0;
  readCache = createDesktopW5ReadCache({
    usable: () => usable,
    retryFirstMs: RETRY_MS,
    ownRefillMs: OWN_MS,
    schedule,
    now: () => clock,
  });
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
  const store = createW5DaemonRecordStore({
    root: harness.root,
    transport: w5RecordPortTransport(() => Promise.resolve(records)),
    projection: readCache,
  });
  electron = store;
  restore = installW5DaemonRecordStoreForTests(store);
  const counted: W5CommitLogFileStore = {
    ...store,
    capture: async (request) => {
      captures.push(request);
      await captureGate?.promise;
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
    retryDelayMs: NEVER_MS,
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
  test('warm: one discovery capture fills every listed workspace', async () => {
    await compose();
    expect(readCache.ready()).toBe(false); // A test store is installed.
    expect(readCache.cache.warmed()).toBe(true);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.discoverWorkspaces).toBe(true);
    expect(cached()).toHaveLength(5);
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

  test('reconnect: commits made while detached replay from the cursor', async () => {
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
    expect(discoveries()).toBe(broad);
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
