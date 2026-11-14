// GB4 (CAN-5542) PR 1: Electron main's daemon-backed W5 store when its
// record-port connection drops, on a real commit-log worker and real files.
// The record port runs through the unreachable guard, as the production
// lease's does; the daemon side is the core-runtime authority served through
// the daemon control-stream code.
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as WorkerThreads from 'node:worker_threads';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
const mockWorkers: WorkerThreads.Worker[] = [];
jest.mock('node:worker_threads', () => {
  const threads = jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads();
  class KillableWorker extends threads.Worker {
    constructor(...args: ConstructorParameters<typeof threads.Worker>) {
      super(...args);
      mockWorkers.push(this);
    }
  }
  return { ...threads, Worker: KillableWorker };
});
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  // Same array every checked writer reads, the authority's included.
  const rows: CoreStorage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (namespaceIds: readonly string[]): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] = namespaceIds.includes(row.id)
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row;
      });
    },
  };
});
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (namespaceIds: readonly string[]) => void;
}>('@canopy/core-runtime/storage');
const mockRecordAppDiagnostic = jest.fn();
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: mockRecordAppDiagnostic,
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { W5RecordPortTransport } from '@canopy/core-runtime/node/w5/record-port';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { startW5DaemonRecordHarness } from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { guardW5RecordPortCalls } from '../../canopy-runtime/w5-record-port-guard';
import { __setDesktopW5FileStoreForTests } from '../w5-commit-log-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransportOver,
  type W5RecordPortClient,
} from '../w5-daemon-record-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  readWorkspaceWorktrees,
  setWorktreeRegistryReconciler,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';

jest.setTimeout(60_000);

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const WORKER = join(__dirname, 'fixtures/w5-commit-log-source-worker.ts');

let dir: string;
let root: string;
let host: W5CommitLogHost;
let harness: Awaited<ReturnType<typeof startW5DaemonRecordHarness>>;
let restore: () => void;
let originalDataDir: string | undefined;
let owner: AbortController;
/** Electron's current connection: each call resolves it, as the lease does. */
let connection: W5RecordPortClient;
/** Every record-port call Electron sent, by transport method. */
let sent: (keyof W5RecordPortTransport)[];

const listPath = (): string => join(root, 'a', 'worktrees.json');

/** `transport`, recording each call as it starts. */
function recording(transport: W5RecordPortTransport): W5RecordPortTransport {
  const record = <R>(
    method: keyof W5RecordPortTransport,
    call: () => Promise<R>,
  ): Promise<R> => {
    sent.push(method);
    return call();
  };
  return {
    capture: (request) => record('capture', () => transport.capture(request)),
    recovery: () => record('recovery', () => transport.recovery()),
    commit: (request) => record('commit', () => transport.commit(request)),
    lookupReceipt: (receipt) =>
      record('lookupReceipt', () => transport.lookupReceipt(receipt)),
    listReservations: () =>
      record('listReservations', () => transport.listReservations()),
    reserve: (params) => record('reserve', () => transport.reserve(params)),
    updateReservationDiagnostics: (params) =>
      record('updateReservationDiagnostics', () =>
        transport.updateReservationDiagnostics(params),
      ),
    releaseReservation: (reservationId) =>
      record('releaseReservation', () =>
        transport.releaseReservation(reservationId),
      ),
    markReservationRecoveryRequired: (params) =>
      record('markReservationRecoveryRequired', () =>
        transport.markReservationRecoveryRequired(params),
      ),
  };
}

/** Installs Electron's store over the guarded record port. */
async function installGuardedStore(): Promise<void> {
  connection = await harness.connect();
  const store = createW5DaemonRecordStore({
    root,
    transport: recording(
      w5RecordPortTransportOver(
        guardW5RecordPortCalls({
          connect: () => Promise.resolve(connection),
          owner: owner.signal,
        }),
      ),
    ),
  });
  restore = installW5DaemonRecordStoreForTests(store);
}

beforeEach(async () => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'first', createdAt },
    { id: 'two', branchName: 'second', createdAt },
  ]));
  dir = realpathSync(dir);
  root = join(dir, 'data', 'workspaces');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: WORKER,
  });
  harness = await startW5DaemonRecordHarness({ host });
  owner = new AbortController();
  sent = [];
  restore = (): void => undefined;
  mockRecordAppDiagnostic.mockClear();
  setDaemonOwnedForTest(W5_NAMESPACES);
});
afterEach(async () => {
  owner.abort();
  restore();
  setDaemonOwnedForTest([]);
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await harness.close();
  await host.shutdown();
  mockWorkers.length = 0;
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const rename = (branchName: string): Promise<unknown> =>
  updateWorkspaceWorktrees('a', (rows) =>
    rows.map((row) => ({ ...row, branchName })),
  );

it('keeps acknowledged A, refuses B, leaves C outcome-unknown and admits independent D after same-log restarts', async () => {
  await installGuardedStore();
  const resource = {
    kind: 'worktree',
    workspaceId: 'a',
    worktreeId: 'one',
  } as const;
  await rename('acknowledged-A');
  const revisionA = await host.revision(resource);
  expect(revisionA).toBeGreaterThan(0);
  const bytesA = readFileSync(listPath(), 'utf8');

  const kill = async (): Promise<void> => {
    await connection.close();
    const worker = mockWorkers.at(-1);
    if (!worker) throw new Error('No running W5 worker');
    await worker.terminate();
  };
  const restart = async (): Promise<void> => {
    await harness.close();
    await host.shutdown();
    host = new W5CommitLogHost({
      dbPath: join(dir, 'w5', 'commit-log.sqlite'),
      root,
      workerEntry: WORKER,
    });
    harness = await startW5DaemonRecordHarness({ host });
    connection = await harness.connect();
  };

  await kill();
  sent.length = 0;
  await expect(rename('refused-B')).rejects.toMatchObject({
    name: 'WorktreeRegistryUnreadableError',
    cause: {
      name: 'W5AuthorityUnreachableError',
      certainty: 'refused',
      reason: 'lost',
    },
  });
  expect(sent).not.toContain('commit');
  expect(readFileSync(listPath(), 'utf8')).toBe(bytesA);
  await restart();
  expect(await host.revision(resource)).toBe(revisionA);
  await expect(
    readWorkspaceWorktrees('a', { persistRemovalCleanup: false }),
  ).resolves.toEqual([
    expect.objectContaining({ branchName: 'acknowledged-A' }),
    expect.objectContaining({ branchName: 'acknowledged-A' }),
  ]);

  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
    const outcome = await commit(request);
    await kill();
    return outcome;
  });
  await expect(rename('unconfirmed-C')).rejects.toMatchObject({
    name: 'W5AuthorityUnreachableError',
    certainty: 'outcome-unknown',
  });
  await restart();
  const revisionC = await host.revision(resource);
  expect(revisionC).toBeGreaterThan(revisionA);
  sent.length = 0;
  await expect(rename('independent-D')).resolves.toEqual([
    expect.objectContaining({ branchName: 'independent-D' }),
    expect.objectContaining({ branchName: 'independent-D' }),
  ]);
  expect(sent[0]).toBe('recovery');
  expect(await host.revision(resource)).toBeGreaterThan(revisionC);
});
