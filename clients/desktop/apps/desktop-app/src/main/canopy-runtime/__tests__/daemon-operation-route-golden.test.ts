import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCanopyClient } from '@canopy/core-client/node';
import { operationLedgerPath } from '@canopy/core-runtime/node/operations/daemon';
import {
  OperationLedger,
  type OperationAcceptRequest,
} from '@canopy/core-runtime/node/operations/ledger';
import {
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
} from '@canopy/core-runtime/storage';
import type {
  CanopyCallerDescriptor,
  CanopyStreamCursor,
  CoreOperationEventsParams,
} from '@canopy/protocol/canopy-core';
import {
  startCanopyDaemon,
  type RunningCanopyDaemon,
} from '../../../../../core-daemon/src/daemon';
import { getOperationLedgerPath } from '../../lib/paths';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { createDaemonOperationRoute } from '../daemon-operation-route';
import {
  ELECTRON_DAEMON_DEFINITIONS,
  type ElectronDaemonClient,
} from '../electron-daemon-host';

/*
 * CAN-5092 S1a: the unselected Electron route to the daemon's operation
 * records. Against a production daemon it refuses locally and falls back to
 * nothing; against a daemon switched on by the trusted ownership seam it
 * answers as Electron main's own `core.operation.*` adapter does over the
 * same ledger.
 */

const posix = process.platform === 'win32' ? describe.skip : describe;
const DAEMON_OWNED: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP.map(
  (row): StorageOwnershipRow =>
    row.id === 'operation_ledger'
      ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
      : row,
);
const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-user',
  clientInstanceId: 'operation-route',
  authorityId: 'local',
  interfaceKind: 'desktop',
  grants: ['core.operation.read', 'core.operation.cancel'],
};

let dataRoot: string;
let daemon: RunningCanopyDaemon | undefined;
let client: ElectronDaemonClient | undefined;
const priorDataDir = process.env.CANOPY_DATA_DIR;
beforeEach(async () => {
  dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'opr-')));
  process.env.CANOPY_DATA_DIR = dataRoot;
});
afterEach(async () => {
  if (priorDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = priorDataDir;
  await client?.close();
  client = undefined;
  await daemon?.stop('test');
  daemon = undefined;
  await rm(dataRoot, { recursive: true, force: true });
});

async function startDaemon(switchedOn: boolean): Promise<ElectronDaemonClient> {
  daemon = await startCanopyDaemon({
    dataRoot,
    runtimeMode: 'dev',
    buildVersion: 'test',
    brandId: 'canopy',
    secureDataRoot: join(dataRoot, 'secure'),
    coworkManagedDirName: '.canopy',
    environment: {},
    ...(switchedOn && { operationLedger: { ownership: DAEMON_OWNED } }),
  });
  const { descriptor } = daemon;
  client = await connectCanopyClient({
    endpoint: {
      kind: 'socket',
      path: descriptor.endpoint.path,
      auth: {
        secret: await readFile(descriptor.tokenRef, 'utf8'),
        dataRootHash: createHash('sha256').update(dataRoot).digest('hex'),
      },
    },
    clientName: 'operation-route',
    clientVersion: '0',
    definitions: ELECTRON_DAEMON_DEFINITIONS,
  });
  await client.instruction('core.client.lease.acquire', {
    clientInstanceId: 'operation-route',
    interfaceKind: 'desktop',
    label: 'Operation route',
    interactive: false,
    foreground: false,
    renewalIntervalMs: 1000,
    _meta: { idempotencyKey: 'operation-route-lease' },
  });
  return client;
}

function request(sourceId: string): OperationAcceptRequest {
  return {
    kind: 'core.pipeline.run',
    origin: { kind: 'client', sourceId },
    owner: { kind: 'principal', id: 'local-user' },
    scope: { workspaceId: 'alpha', worktreeId: 'main' },
  };
}

/** Records in each state, written and closed by a former writer. */
function seedLedger(): {
  ledgerId: string;
  resumableFrom: number;
  ids: Record<'completed' | 'failed' | 'cancelled' | 'queued', string>;
} {
  const ledger = OperationLedger.open(operationLedgerPath(dataRoot));
  try {
    const accept = (sourceId: string): string =>
      ledger.accept(request(sourceId)).operation.operationId;
    const completed = accept('completed');
    ledger.transition(completed, 'running');
    ledger.finish(completed, { status: 'completed', outcome: { ok: true } });
    const failed = accept('failed');
    ledger.finish(failed, {
      status: 'failed',
      error: {
        kind: 'internal',
        message: 'The run failed.',
        retry: { kind: 'never' },
      },
    });
    const cancelled = accept('cancelled');
    ledger.finish(cancelled, { status: 'cancelled' });
    const queued = accept('queued');
    return {
      ledgerId: ledger.ledgerId,
      resumableFrom: ledger.eventsResumableFrom(),
      ids: { completed, failed, cancelled, queued },
    };
  } finally {
    ledger.close();
  }
}

type Settled = { value: unknown } | { error: unknown };

async function settle(run: () => Promise<unknown>): Promise<Settled> {
  try {
    return { value: await run() };
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'payload' in error &&
      error.payload !== null &&
      typeof error.payload === 'object'
    ) {
      const { kind, code, details, retry } = error.payload as Record<
        string,
        unknown
      >;
      return { error: { kind, code, details, retry } };
    }
    return { error };
  }
}

interface Calls {
  get(operationId: string): Promise<unknown>;
  list(params: Record<string, unknown>): Promise<unknown>;
  cancel(params: {
    operationId: string;
    reason: string;
    expectedRevision?: number;
  }): Promise<unknown>;
  events(params: CoreOperationEventsParams, count: number): Promise<unknown>;
}

async function observe(
  calls: Calls,
  seed: ReturnType<typeof seedLedger>,
  expectedEvents: number,
): Promise<Record<string, Settled>> {
  const { ids, ledgerId, resumableFrom } = seed;
  const results: Record<string, Settled> = {};
  for (const [name, id] of Object.entries(ids))
    results[`get ${name}`] = await settle(() => calls.get(id));
  results['get absent'] = await settle(() => calls.get('absent'));
  results['list all'] = await settle(() => calls.list({}));
  const first = await settle(() => calls.list({ pageSize: 2 }));
  results['list first page'] = first;
  const cursor =
    'value' in first &&
    first.value !== null &&
    typeof first.value === 'object' &&
    'nextCursor' in first.value &&
    typeof first.value.nextCursor === 'string'
      ? first.value.nextCursor
      : 'missing';
  results['list next page'] = await settle(() =>
    calls.list({ pageSize: 2, cursor }),
  );
  results['list completed'] = await settle(() =>
    calls.list({ statuses: ['completed'] }),
  );
  results['list bad cursor'] = await settle(() =>
    calls.list({ cursor: 'not-a-cursor' }),
  );
  results['cancel terminal'] = await settle(() =>
    calls.cancel({ operationId: ids.completed, reason: 'test' }),
  );
  results['cancel queued'] = await settle(() =>
    calls.cancel({ operationId: ids.queued, reason: 'test' }),
  );
  results['cancel stale revision'] = await settle(() =>
    calls.cancel({
      operationId: ids.queued,
      reason: 'test',
      expectedRevision: 99,
    }),
  );
  results['cancel absent'] = await settle(() =>
    calls.cancel({ operationId: 'absent', reason: 'test' }),
  );
  results['events resumed'] = await settle(() =>
    calls.events(
      { cursor: { daemonEpoch: ledgerId, sequence: resumableFrom } },
      expectedEvents,
    ),
  );
  results['events foreign epoch'] = await settle(() =>
    calls.events({ cursor: { daemonEpoch: 'foreign', sequence: 1 } }, 0),
  );
  return results;
}

/** Electron main's adapter over the same ledger, called as its dispatcher does. */
async function electronResults(
  seed: ReturnType<typeof seedLedger>,
): Promise<{ results: Record<string, Settled>; events: number }> {
  // Electron main's own path helper, under the same data root.
  const adapter = createCoreOperationAdapter();
  const context = {
    requestId: 'electron',
    caller: CALLER,
    metadata: {},
    signal: new AbortController().signal,
  };
  let events = 0;
  try {
    const calls: Calls = {
      get: (operationId) =>
        Promise.resolve(
          adapter.queries['core.operation.get']({ operationId }, context),
        ),
      list: (params) =>
        Promise.resolve(
          adapter.queries['core.operation.list'](
            params as Parameters<
              (typeof adapter.queries)['core.operation.list']
            >[0],
            context,
          ),
        ),
      cancel: (params) =>
        Promise.resolve(
          adapter.instructions['core.operation.cancel'](params, context),
        ),
      events: async (params) => {
        const items: { cursor: CanopyStreamCursor; item: unknown }[] = [];
        let ended: { outcome: string; error: unknown } | null = null;
        const stop = await adapter.streams['core.operation.events'](
          params,
          context,
          {
            emit: () => null,
            emitAt: (cursor, item) => {
              items.push({ cursor, item });
              return cursor;
            },
            end: (outcome, error) => {
              ended = { outcome, error: error ?? null };
            },
            endAt: () => undefined,
          },
        );
        if (typeof stop === 'function') stop();
        events = Math.max(events, items.length);
        return { items, ended };
      },
    };
    const results = await observe(calls, seed, 0);
    return { results, events };
  } finally {
    adapter.close();
  }
}

function routeCalls(
  route: ReturnType<typeof createDaemonOperationRoute>,
): Calls {
  return {
    get: (operationId) => route.get({ operationId }),
    list: (params) => route.list(params),
    cancel: (params) => route.cancel(params),
    events: async (params, count) => {
      const items: { cursor: CanopyStreamCursor; item: unknown }[] = [];
      let ended: { outcome: string; error: unknown } | null = null;
      const handle = await route.events(params, {
        onFrame: (frame) => {
          if (frame.kind === 'item')
            items.push({ cursor: frame.cursor, item: frame.item });
          else ended = { outcome: frame.outcome, error: frame.error };
        },
      });
      for (let waited = 0; items.length < count && ended === null; waited++) {
        if (waited > 200) throw new Error('Events did not arrive.');
        await delay(10);
      }
      if (count === 0)
        for (let waited = 0; ended === null && waited < 200; waited++)
          await delay(10);
      const observed = { items: [...items], ended };
      handle.close();
      return observed;
    },
  };
}

posix('Electron route to daemon operation records (CAN-5092 S1a)', () => {
  it('opens nothing when constructed and refuses without a session', async () => {
    const session = jest.fn((): null => null);
    const route = createDaemonOperationRoute({ client: session });
    expect(session).not.toHaveBeenCalled();
    await expect(route.list({})).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    expect(existsSync(join(dataRoot, 'operations'))).toBe(false);
  });

  it('refuses locally against a production daemon, with no fallback', async () => {
    const connected = await startDaemon(false);
    const route = createDaemonOperationRoute({ client: () => connected });
    const local: unknown = expect.stringMatching(
      /is not available on this connection/,
    );
    for (const call of [
      (): Promise<unknown> => route.get({ operationId: 'any' }),
      (): Promise<unknown> => route.list({}),
      (): Promise<unknown> =>
        route.cancel({ operationId: 'any', reason: 'test' }),
      (): Promise<unknown> => route.events({ cursor: null }),
    ])
      await expect(call()).rejects.toMatchObject({
        name: 'CanopyClientError',
        payload: {
          kind: 'capability_unavailable',
          message: local,
        },
      });
    expect(existsSync(join(dataRoot, 'operations'))).toBe(false);
  });

  it("answers as Electron main's adapter over the same ledger", async () => {
    expect(getOperationLedgerPath()).toBe(operationLedgerPath(dataRoot));
    const seed = seedLedger();
    const electron = await electronResults(seed);
    const connected = await startDaemon(true);
    const route = createDaemonOperationRoute({ client: () => connected });
    const daemonResults = await observe(
      routeCalls(route),
      seed,
      electron.events,
    );
    expect(electron.events).toBeGreaterThan(0);
    const anyItems: unknown = expect.any(Array);
    expect(electron.results).toMatchObject({
      'get completed': { value: { operation: { status: 'completed' } } },
      'get absent': { error: { code: 'core.operation.notFound' } },
      'list all': { value: { items: anyItems } },
      'list next page': { value: { nextCursor: null } },
      'list bad cursor': { error: { kind: 'invalid_argument' } },
      'cancel terminal': { value: { outcome: 'already-terminal' } },
      'cancel queued': { error: { code: 'core.operation.invalidState' } },
      'cancel stale revision': {
        error: { code: 'core.operation.revisionConflict' },
      },
      'cancel absent': { error: { code: 'core.operation.notFound' } },
      'events foreign epoch': {
        value: {
          items: [],
          ended: {
            outcome: 'error',
            error: { code: 'core.operation.snapshotRequired' },
          },
        },
      },
    });
    expect(daemonResults).toEqual(electron.results);
  });
});
