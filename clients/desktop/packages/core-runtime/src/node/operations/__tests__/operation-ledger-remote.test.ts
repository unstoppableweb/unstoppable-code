import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanopyErrorPayloadSchema,
  CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS,
  CORE_OPERATION_LEDGER_QUERY_DEFINITIONS,
  CORE_OPERATION_LEDGER_STREAM_DEFINITIONS,
  IN_PROCESS_LEASE_TERMS,
  IN_PROCESS_WORKER_TARGET,
  OPERATION_LEDGER_GRANTS,
  isUnknownKeyedWriteOutcome,
  type CanopyCallerDescriptor,
  type DelegationDispatchInput,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { createInProcessCanopyClient } from '../../../runtime/in-process-client';
import {
  OperationCancelRefusedError,
  OperationService,
  RemoteOperationService,
  createCoreOperationLedgerHandlers,
  type OperationDomain,
  type OperationLedgerTransport,
  type OperationRecovery,
  type OperationServicePort,
} from '..';
import {
  OperationLedger,
  OperationLedgerError,
  OperationLedgerRefusedError,
  type OperationAcceptRequest,
  type OperationLedgerEvent,
  type OperationLedgerOptions,
} from '../ledger';

/*
 * CAN-6986 L3: an owner whose domains run in another process than the
 * ledger calls it through `core.operationLedger.*`. The remote service must
 * write what the in-process service writes, in the same order, and keep the
 * domains' cancellation and recovery where the domains are.
 */

const HELPER = 'core.helper.run';
const RESUMABLE = 'core.script.run';
const DIGEST = `sha256:${'0'.repeat(64)}`;
const OWNER: CanopyCallerDescriptor = {
  principalId: 'electron-main',
  clientInstanceId: 'electron-main:pipeline-owner',
  authorityId: 'authority',
  interfaceKind: 'desktop',
  grants: [OPERATION_LEDGER_GRANTS.owner],
};
const DEFINITIONS = {
  queries: CORE_OPERATION_LEDGER_QUERY_DEFINITIONS,
  instructions: CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS,
  streams: CORE_OPERATION_LEDGER_STREAM_DEFINITIONS,
};

/** Every internal operation, each of which the parity run must reach. */
const LEDGER_OPERATIONS = [
  'core.operationLedger.get',
  'core.operationLedger.list',
  'core.operationLedger.lookupReceipt',
  'core.operationLedger.statusBeforeRestart',
  'core.operationLedger.sourceHead',
  'core.operationLedger.getDelegation',
  'core.operationLedger.listDelegations',
  'core.operationLedger.listUnfinished',
  'core.operationLedger.registerDomains',
  'core.operationLedger.admit',
  'core.operationLedger.admitInitiatedRuns',
  'core.operationLedger.admitFinished',
  'core.operationLedger.finishCancelled',
  'core.operationLedger.placeInProcessWorker',
  'core.operationLedger.acceptDispatch',
  'core.operationLedger.markDispatched',
  'core.operationLedger.markDelegation',
  'core.operationLedger.settleDispatch',
  'core.operationLedger.transition',
  'core.operationLedger.reportProgress',
  'core.operationLedger.finish',
  'core.operationLedger.finishOrRecord',
  'core.operationLedger.transitionOrRecord',
  'core.operationLedger.cancelIntent',
  'core.operationLedger.withdrawCancelIntent',
  'core.operationLedger.recordRecovery',
  'core.operationLedger.events',
];

let dir: string;
const ledgers: OperationLedger[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-ledger-remote-'));
});

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function ledgerAt(
  name: string,
  options: OperationLedgerOptions = {},
): OperationLedger {
  const ledger = OperationLedger.open(join(dir, `${name}.sqlite`), options);
  ledgers.push(ledger);
  return ledger;
}

/** The ledger's process: its service, served by the owner-only handlers. */
function holder(
  name: string,
  options: OperationLedgerOptions = {},
): {
  service: OperationService;
  connect: () => OperationLedgerTransport;
  calls: string[];
} {
  const ledger = ledgerAt(name, options);
  const service = new OperationService({
    openLedger: (): OperationLedger => ledger,
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: DEFINITIONS,
    handlers: createCoreOperationLedgerHandlers(service),
  });
  const calls: string[] = [];
  const connect = (): OperationLedgerTransport => {
    const client = createInProcessCanopyClient(dispatcher, OWNER);
    return {
      query: (operation, params) => {
        calls.push(operation);
        return client.query(operation, params);
      },
      instruction: (operation, params) => {
        calls.push(operation);
        return client.instruction(operation, params);
      },
      openStream: (operation, params) => {
        calls.push(operation);
        return client.openStream(operation, params);
      },
    };
  };
  return { service, connect, calls };
}

function request(
  overrides: Partial<OperationAcceptRequest> = {},
): OperationAcceptRequest {
  return {
    kind: HELPER,
    status: 'running',
    origin: { kind: 'client', sourceId: 'desktop-window-1' },
    owner: { kind: 'principal', id: 'local-user' },
    scope: { workspaceId: 'alpha', worktreeId: 'main' },
    ...overrides,
  };
}

function keyed(key: string, fingerprint = DIGEST): OperationAcceptRequest {
  return request({
    receipt: { caller: 'core.helper', idempotencyKey: key, fingerprint },
  });
}

function dispatched(
  parentOperationId: string,
  leaseId: string,
  n: number,
): {
  request: OperationAcceptRequest & {
    parentOperationId: string;
    runtimeDelegationId: string;
  };
  dispatch: DelegationDispatchInput;
} {
  const delegationId = `delegation-${String(n)}`;
  const key = `dispatch-${String(n)}`;
  return {
    request: {
      kind: 'worker.agent.helper.run',
      status: 'queued',
      receipt: {
        caller: `core.delegation:${parentOperationId}`,
        idempotencyKey: key,
        fingerprint: DIGEST,
      },
      origin: { kind: 'delegation', sourceId: parentOperationId },
      owner: { kind: 'principal', id: 'local-user' },
      scope: { workspaceId: 'alpha', worktreeId: 'main' },
      parentOperationId,
      runtimeDelegationId: delegationId,
    },
    dispatch: {
      delegationId,
      targetId: IN_PROCESS_WORKER_TARGET.targetId,
      leaseId,
      operation: {
        name: 'worker.agent.helper.run',
        version: 1,
        idempotency: 'keyed',
      },
      idempotencyKey: key,
      executorKey: delegationId,
      activation: { delivery: 'inline-parameters', digest: DIGEST },
      secrets: [],
    },
  };
}

/** Ids and times named by their first appearance, so twin runs compare. */
function normalize(value: unknown): unknown {
  const names = new Map<string, string>();
  const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const TIME =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (TIME.test(node)) return '<time>';
      if (!ID.test(node)) return node;
      let name = names.get(node);
      if (!name) {
        name = `<id ${String(names.size)}>`;
        names.set(node, name);
      }
      return name;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object')
      return Object.fromEntries(
        Object.entries(node).map(([key, entry]) => [key, walk(entry)]),
      );
    return node;
  };
  return walk(value);
}

async function outcome<T>(run: () => Promise<T>): Promise<unknown> {
  try {
    return { resolved: await run() };
  } catch (error) {
    // Only the operation and its revision cross the owner connection; no
    // caller reads other refusal details.
    if (error instanceof OperationLedgerRefusedError) {
      const { operationId, currentRevision } = error.details;
      return { refused: error.refusal, operationId, currentRevision };
    }
    throw error;
  }
}

/** Every domain call sequence, through either service. */
async function exercise(
  service: OperationServicePort,
  domain: { refuse: boolean },
): Promise<unknown[]> {
  const results: unknown[] = [];
  const record = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    const result = await outcome(run);
    results.push(result);
    return typeof result === 'object' && result && 'resolved' in result
      ? (result.resolved as T)
      : undefined;
  };
  // Admission: a keyed run, its replay, and its key with other parameters.
  const first = await record(() => service.admit(keyed('turn-1')));
  await record(() => service.admit(keyed('turn-1')));
  await record(() =>
    service.admit(keyed('turn-1', `sha256:${'1'.repeat(64)}`)),
  );
  await record(() =>
    service.lookupReceipt(HELPER, {
      caller: 'core.helper',
      idempotencyKey: 'turn-1',
      fingerprint: DIGEST,
    }),
  );
  // A source's batch with its head, a stopped run and a reused key.
  await record(() =>
    service.admitInitiatedRuns({
      head: { source: 'hooks', subject: 'alpha', value: 'head-1' },
      runs: [
        { request: keyed('hook-1') },
        {
          request: keyed('hook-2'),
          finishAs: { status: 'cancelled' },
        },
        { request: keyed('turn-1', `sha256:${'2'.repeat(64)}`) },
      ],
    }),
  );
  await record(() => service.sourceHead('hooks', 'alpha'));
  await record(() =>
    service.admitFinished(keyed('gate-1'), {
      status: 'failed',
      error: {
        kind: 'failed_precondition',
        code: 'core.helper.blocked',
        message: 'Blocked.',
        retry: { kind: 'never' },
      },
    }),
  );
  // A plain lifecycle.
  const plain = await record(() => service.admit(request()));
  if (plain?.status !== 'accepted') throw new Error('not accepted');
  const plainId = plain.operation.operationId;
  await record(() => service.transition(plainId, 'paused'));
  await record(() => service.transition(plainId, 'running'));
  await record(() => service.reportProgress(plainId, 0.5));
  await record(() =>
    service.finish(plainId, { status: 'completed', outcome: { ok: true } }),
  );
  await record(() =>
    service.finishOrRecord(plainId, { status: 'failed', error: undefined }),
  );
  await record(() => service.transitionOrRecord(plainId, 'running'));
  await record(() => service.transition(plainId, 'running'));
  await record(() => service.statusBeforeRestart(plainId));
  // Cancellation of live, refused, finished and missing work.
  if (first?.status !== 'accepted') throw new Error('not accepted');
  const firstId = first.operation.operationId;
  domain.refuse = true;
  await record(() =>
    service.cancel(firstId, { reason: 'Stop.', requestedBy: 'user' }),
  );
  domain.refuse = false;
  await record(() =>
    service.cancel(firstId, { reason: 'Stop.', requestedBy: 'user' }),
  );
  await record(() =>
    service.cancel(firstId, { reason: 'Again.', requestedBy: 'user' }),
  );
  await record(() =>
    service.cancel('missing', { reason: 'Stop.', requestedBy: 'user' }),
  );
  await record(() => service.finishCancelled(firstId));
  // Dispatch: accept, mark and settle.
  const lease = await record(() =>
    service.placeInProcessWorker(
      IN_PROCESS_WORKER_TARGET,
      IN_PROCESS_LEASE_TERMS,
    ),
  );
  if (!lease) throw new Error('not placed');
  const parent = await record(() => service.admit(request()));
  if (parent?.status !== 'accepted') throw new Error('not accepted');
  const parentId = parent.operation.operationId;
  const child = dispatched(parentId, lease.leaseId, 1);
  await record(() => service.acceptDispatch(child.request, child.dispatch));
  await record(() => service.acceptDispatch(child.request, child.dispatch));
  await record(() => service.markDispatched('delegation-1'));
  await record(() => service.markDelegation('delegation-1', 'reconciling'));
  await record(() =>
    service.settleDispatch('delegation-1', {
      status: 'completed',
      outcome: { done: true },
      resolution: 'executor-receipt',
    }),
  );
  await record(() => service.getDelegation('delegation-1'));
  await record(() => service.listDelegations(parentId));
  await record(() => service.get(parentId));
  await record(async () => {
    const page = await service.list({ parentOperationId: parentId, limit: 3 });
    return { items: page.items, next: page.next };
  });
  return results;
}

function helperDomain(state: { refuse: boolean }): OperationDomain {
  return {
    domain: 'helpers',
    kinds: [HELPER],
    restartClass: 'lost',
    cancel: () =>
      state.refuse
        ? Promise.reject(new OperationCancelRefusedError('Not now.'))
        : Promise.resolve('cancelled'),
  };
}

async function settled(
  events: OperationLedgerEvent[],
  count: number,
): Promise<void> {
  for (let tick = 0; tick < 1_000 && events.length < count; tick += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('the operation ledger over the owner connection (CAN-6986 L3)', () => {
  it('writes the records and events the in-process service writes, in order', async () => {
    const local = new OperationService({
      openLedger: (): OperationLedger => ledgerAt('local'),
    });
    const localState = { refuse: false };
    local.registerDomain(helperDomain(localState));
    const localEvents: OperationLedgerEvent[] = [];
    local.subscribe((event) => localEvents.push(event));

    const { connect, calls } = holder('daemon');
    const transport = connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    const remoteState = { refuse: false };
    remote.registerDomain(helperDomain(remoteState));
    const remoteEvents: OperationLedgerEvent[] = [];
    remote.subscribe((event) => remoteEvents.push(event));

    const expected = await exercise(local, localState);
    const actual = await exercise(remote, remoteState);
    await settled(remoteEvents, localEvents.length);
    expect(normalize(actual)).toEqual(normalize(expected));
    expect(normalize(remoteEvents)).toEqual(normalize(localEvents));
    remote.close();
    // Every internal operation except recovery, which the recovery case
    // below reaches, served the run.
    expect(LEDGER_OPERATIONS.filter((name) => !calls.includes(name))).toEqual([
      'core.operationLedger.recordRecovery',
    ]);
    expect(
      [
        ...Object.keys(CORE_OPERATION_LEDGER_QUERY_DEFINITIONS),
        ...Object.keys(CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS),
        ...Object.keys(CORE_OPERATION_LEDGER_STREAM_DEFINITIONS),
      ].sort(),
    ).toEqual([...LEDGER_OPERATIONS].sort());
  });

  it('answers a reused key from its receipt in one call', async () => {
    const { connect, calls } = holder('daemon');
    const transport = connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    await remote.ready();
    const first = await remote.admit(keyed('turn-1'));
    calls.splice(0);
    const replay = await remote.admit(keyed('turn-1'));
    expect(calls).toEqual(['core.operationLedger.admit']);
    expect(replay).toMatchObject({
      status: 'in-progress',
      operation: { operationId: first.operation.operationId },
    });
    // A chat turn is two owner calls: admit running, then finish.
    calls.splice(0);
    const turn = await remote.admit(keyed('turn-2'));
    await remote.finish(turn.operation.operationId, { status: 'completed' });
    expect(calls).toEqual([
      'core.operationLedger.admit',
      'core.operationLedger.finish',
    ]);
    remote.close();
  });

  it("keeps the owner process's run across a reconnect and the ledger process's restart, and starts a new run for a new owner process", async () => {
    let daemon = holder('daemon');
    let transport = daemon.connect();
    const owner = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
      ownerRun: 'owner-process-1',
    });
    owner.registerDomain(helperDomain({ refuse: false }));
    const lease = await owner.placeInProcessWorker(
      IN_PROCESS_WORKER_TARGET,
      IN_PROCESS_LEASE_TERMS,
    );
    const live = await owner.admit(request());
    const parent = await owner.admit(request());

    // A reconnect of the same owner process resumes its run.
    transport = daemon.connect();
    expect(await owner.get(live.operation.operationId)).toMatchObject({
      status: 'running',
    });
    expect(
      await owner.placeInProcessWorker(
        IN_PROCESS_WORKER_TARGET,
        IN_PROCESS_LEASE_TERMS,
      ),
    ).toEqual(lease);

    // So does a restart of the ledger's process while the owner runs on.
    daemon.service.close();
    daemon = holder('daemon');
    transport = daemon.connect();
    expect(await owner.get(live.operation.operationId)).toMatchObject({
      status: 'running',
    });
    expect(
      await owner.placeInProcessWorker(
        IN_PROCESS_WORKER_TARGET,
        IN_PROCESS_LEASE_TERMS,
      ),
    ).toEqual(lease);
    const kept = dispatched(parent.operation.operationId, lease.leaseId, 1);
    await expect(
      owner.acceptDispatch(kept.request, kept.dispatch),
    ).resolves.toMatchObject({ result: { status: 'accepted' } });
    await owner.finish(live.operation.operationId, { status: 'completed' });
    expect(await owner.get(live.operation.operationId)).toMatchObject({
      status: 'completed',
    });
    owner.close();

    // A new owner process starts a new run: the earlier one's work was
    // interrupted, and its placement released.
    transport = daemon.connect();
    const next = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
      ownerRun: 'owner-process-2',
    });
    next.registerDomain(helperDomain({ refuse: false }));
    const placed = await next.placeInProcessWorker(
      IN_PROCESS_WORKER_TARGET,
      IN_PROCESS_LEASE_TERMS,
    );
    expect(placed.leaseId).not.toBe(lease.leaseId);
    expect(placed.runEpoch).toBe('owner-process-2');
    expect(await next.get(parent.operation.operationId)).toMatchObject({
      status: 'failed',
      restart: { class: 'lost', disposition: 'lost' },
    });
    const ledger = await daemon.service.ready();
    expect(ledger.getLease(lease.leaseId)).toMatchObject({
      releaseReason: 'process-ended',
    });
    const stale = dispatched(parent.operation.operationId, lease.leaseId, 2);
    await expect(
      next.acceptDispatch(stale.request, stale.dispatch),
    ).rejects.toBeInstanceOf(OperationLedgerRefusedError);
    next.close();
  });

  it("recovers an earlier session's resumable work in the owner's process", async () => {
    const { connect, calls } = holder('daemon');
    let transport = connect();
    const recover = jest.fn(() =>
      Promise.resolve({ status: 'running' as const }),
    );
    const scripts: OperationDomain = {
      domain: 'scripts',
      kinds: [RESUMABLE],
      restartClass: 'resumable',
      cancel: () => Promise.resolve('cancelled'),
      recover,
    };
    const first = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    first.registerDomain(scripts);
    const running = await first.admit(request({ kind: RESUMABLE }));
    first.close();
    transport = connect();
    const second = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    second.registerDomain(scripts);
    await second.whenReconciled();
    expect(recover).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: running.operation.operationId,
        status: 'paused',
      }),
    );
    expect(await second.get(running.operation.operationId)).toMatchObject({
      status: 'running',
      restart: { class: 'resumable', disposition: 'resumed' },
    });
    expect(calls).toContain('core.operationLedger.recordRecovery');
    second.close();
  });

  it("refuses a public cancel at the ledger's process for the owner's work, and writes nothing", async () => {
    const { service, connect } = holder('daemon');
    const transport = connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    remote.registerDomain(helperDomain({ refuse: false }));
    const admitted = await remote.admit(request());
    const before = await service.get(admitted.operation.operationId);
    await expect(
      service.cancel(admitted.operation.operationId, {
        reason: 'Stop.',
        requestedBy: 'portal',
      }),
    ).rejects.toMatchObject({ refusal: 'invalid-state' });
    expect(await service.get(admitted.operation.operationId)).toEqual(before);
    remote.close();
  });
});

/** Lets queued deliveries run, so a test can tell a hang from a slow event. */
async function ticks(count: number): Promise<void> {
  for (let tick = 0; tick < count; tick += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** `link`, its registration answered only on `release`, though handled. */
function heldRegistration(link: OperationLedgerTransport): {
  transport: OperationLedgerTransport;
  sent: () => boolean;
  release: () => void;
} {
  let sent = false;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const instruction: OperationLedgerTransport['instruction'] = async (
    name,
    params,
  ) => {
    const reply = await link.instruction(name, params);
    sent ||= name === 'core.operationLedger.registerDomains';
    if (sent) await held;
    return reply;
  };
  return { transport: { ...link, instruction }, sent: () => sent, release };
}

/**
 * A transport whose event stream opens and then ends at once, with `end`,
 * after the opener has had a turn; every other call reaches the holder.
 */
function endingStreams(
  transport: OperationLedgerTransport,
  end: { outcome: 'completed' | 'error'; snapshotRequired: boolean },
): { transport: OperationLedgerTransport; opens: (string | null)[] } {
  const opens: (string | null)[] = [];
  return {
    opens,
    transport: {
      query: (name, params) => transport.query(name, params),
      instruction: (name, params) => transport.instruction(name, params),
      openStream: (_name, params) => {
        opens.push(params.cursor ? String(params.cursor.sequence) : null);
        return Promise.resolve({
          onFrame: (listener): (() => void) => {
            setImmediate(() => {
              listener({
                kind: 'end',
                cursor: { daemonEpoch: 'ledger', sequence: 0 },
                outcome: end.outcome,
                error: end.snapshotRequired
                  ? {
                      kind: 'failed_precondition',
                      code: 'core.operationLedger.snapshotRequired',
                      message: 'Read the operations again.',
                      retry: {
                        kind: 'after_refresh',
                        resource: 'core.operationLedger.list',
                      },
                    }
                  : null,
              });
            });
            return (): void => undefined;
          },
          close: (): void => undefined,
        });
      },
    },
  };
}

describe('the owner event stream across reconnects (CAN-6986 L3)', () => {
  it('delivers the events after a reconnect of the same owner process to a pending wait, and fails no live work', async () => {
    const { connect } = holder('daemon');
    let transport = connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    remote.registerDomain(helperDomain({ refuse: false }));
    const running = await remote.admit(request());
    const waited = remote.waitForTerminal(running.operation.operationId);
    let settled: unknown = 'pending';
    waited.then(
      (operation) => {
        settled = operation;
      },
      (error: unknown) => {
        settled = error;
      },
    );
    await ticks(10);
    expect(settled).toBe('pending');
    transport = connect();
    await remote.finish(running.operation.operationId, { status: 'completed' });
    await remote.ready();
    await ticks(50);
    expect(settled).toMatchObject({
      operationId: running.operation.operationId,
      status: 'completed',
    });
    remote.close();
  });

  it.each([
    ['refused as stale', { outcome: 'error', snapshotRequired: true }],
    ['ended without events', { outcome: 'completed', snapshotRequired: false }],
  ] as const)(
    'stops reopening a stream %s after a bounded number of opens, and answers a typed unavailable ledger',
    async (_case, end) => {
      const { connect } = holder('daemon');
      const ending = endingStreams(connect(), end);
      const errors: string[] = [];
      const remote = new RemoteOperationService({
        transport: (): Promise<OperationLedgerTransport> =>
          Promise.resolve(ending.transport),
        onError: (_error, context): void => {
          errors.push(context);
        },
      });
      remote.registerDomain(helperDomain({ refuse: false }));
      const admitted = await remote.admit(request());
      const waited = remote
        .waitForTerminal(admitted.operation.operationId)
        .then(
          () => 'resolved',
          (error: unknown) => error,
        );
      await ticks(100);
      // One open per session plus at most three reopens.
      expect(ending.opens.length).toBeLessThanOrEqual(4);
      expect(errors).toContain('events');
      // Never a silent stop: callers and pending waits see the ledger as
      // unavailable, and nothing falls back in process.
      await expect(waited).resolves.toBeInstanceOf(OperationLedgerError);
      await expect(
        remote.get(admitted.operation.operationId),
      ).rejects.toBeInstanceOf(OperationLedgerError);
      remote.close();
    },
  );
});

describe('the owner event stream after a refused cursor (CAN-6986 L3)', () => {
  it('resolves a pending wait once when its operation finishes while the replacement stream opens', async () => {
    const { service, connect } = holder('daemon');
    const real = connect();
    let opens = 0;
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = (): ReturnType<OperationLedgerTransport['openStream']> =>
      Promise.resolve({
        onFrame: (listener): (() => void) => {
          setImmediate(() => {
            listener({
              kind: 'end',
              cursor: { daemonEpoch: 'ledger', sequence: 0 },
              outcome: 'error',
              error: {
                kind: 'failed_precondition',
                code: 'core.operationLedger.snapshotRequired',
                message: 'Read the operations again.',
                retry: {
                  kind: 'after_refresh',
                  resource: 'core.operationLedger.list',
                },
              },
            });
          });
          return (): void => undefined;
        },
        close: (): void => undefined,
      });
    const transport: OperationLedgerTransport = {
      query: (name, params) => real.query(name, params),
      instruction: (name, params) => real.instruction(name, params),
      openStream: async (name, params) => {
        opens += 1;
        // The session's stream and its fallback are both refused; the
        // stream from the current position opens only when released.
        if (opens <= 2) return stale();
        await held;
        return real.openStream(name, params);
      },
    };
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    remote.registerDomain(helperDomain({ refuse: false }));
    const admitted = await remote.admit(request());
    const settled: unknown[] = [];
    void remote.waitForTerminal(admitted.operation.operationId).then(
      (operation) => settled.push(operation),
      (error: unknown) => settled.push(error),
    );
    await ticks(30);
    expect(opens).toBe(3);
    expect(settled).toEqual([]);
    // The operation finishes while the replacement stream is not open yet.
    await service.finish(admitted.operation.operationId, {
      status: 'completed',
    });
    if (!release) throw new Error('not held');
    (release as () => void)();
    await ticks(50);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      operationId: admitted.operation.operationId,
      status: 'completed',
    });
    remote.close();
  });
});

describe('the owner session across close and a ledger change (CAN-6986 L3)', () => {
  it('starts no owner session when closed while the owner connection is being acquired', async () => {
    const { service, connect, calls } = holder('daemon');
    const first = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(connect()),
    });
    first.registerDomain(helperDomain({ refuse: false }));
    const running = await first.admit(request());
    let release: ((transport: OperationLedgerTransport) => void) | null = null;
    const acquired = new Promise<OperationLedgerTransport>((resolve) => {
      release = resolve;
    });
    const second = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> => acquired,
    });
    second.registerDomain(helperDomain({ refuse: false }));
    calls.splice(0);
    const ready = second.ready().then(
      () => 'ready',
      (error: unknown) => error,
    );
    await ticks(5);
    second.close();
    if (!release) throw new Error('not held');
    (release as (transport: OperationLedgerTransport) => void)(connect());
    await expect(ready).resolves.toBeInstanceOf(OperationLedgerError);
    await ticks(20);
    expect(calls).not.toContain('core.operationLedger.registerDomains');
    expect(await service.get(running.operation.operationId)).toMatchObject({
      status: 'running',
    });
  });

  it('rejects a pending wait as not found when a new owner session reaches another ledger', async () => {
    const one = holder('daemon-one');
    const two = holder('daemon-two');
    let transport = one.connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    remote.registerDomain(helperDomain({ refuse: false }));
    const admitted = await remote.admit(request());
    const settled: unknown[] = [];
    void remote.waitForTerminal(admitted.operation.operationId).then(
      (operation) => settled.push(operation),
      (error: unknown) => settled.push(error),
    );
    await ticks(10);
    expect(settled).toEqual([]);
    transport = two.connect();
    await remote.ready();
    await ticks(30);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toBeInstanceOf(OperationLedgerRefusedError);
    expect(settled[0]).toMatchObject({ refusal: 'not-found' });
    remote.close();
  });
});

describe('owner calls above the protocol bounds (CAN-6986 L3)', () => {
  jest.setTimeout(60_000);

  it('recovers every awaiting operation of an earlier session, beyond one page', async () => {
    const { connect } = holder('daemon');
    let transport = connect();
    const recover = jest.fn(() =>
      Promise.resolve({ status: 'running' as const }),
    );
    const scripts: OperationDomain = {
      domain: 'scripts',
      kinds: [RESUMABLE],
      restartClass: 'resumable',
      cancel: () => Promise.resolve('cancelled'),
      recover,
    };
    const first = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    first.registerDomain(scripts);
    for (let n = 0; n < 1_025; n += 1)
      await first.admit(request({ kind: RESUMABLE }));
    first.close();
    transport = connect();
    const second = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    second.registerDomain(scripts);
    await second.whenReconciled();
    expect(recover).toHaveBeenCalledTimes(1_025);
    const page = await second.list({
      kinds: [RESUMABLE],
      statuses: ['paused'],
      limit: 10,
    });
    expect(page.items).toEqual([]);
    second.close();
  });

  it('lists every dispatch of a parent, beyond one page', async () => {
    const { connect } = holder('daemon');
    const transport = connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    const lease = await remote.placeInProcessWorker(
      IN_PROCESS_WORKER_TARGET,
      IN_PROCESS_LEASE_TERMS,
    );
    const parent = await remote.admit(request());
    for (let n = 1; n <= 1_025; n += 1) {
      const child = dispatched(parent.operation.operationId, lease.leaseId, n);
      await remote.acceptDispatch(child.request, child.dispatch);
    }
    const delegations = await remote.listDelegations(
      parent.operation.operationId,
    );
    expect(delegations).toHaveLength(1_025);
    expect(delegations.map(({ delegationId }) => delegationId)).toEqual(
      Array.from({ length: 1_025 }, (_, n) => `delegation-${String(n + 1)}`),
    );
    remote.close();
  });

  it("admits a source's batch beyond the admission bound in bounded calls, recording its head", async () => {
    const { connect, calls } = holder('daemon');
    const transport = connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    await remote.ready();
    calls.splice(0);
    const outcomes = await remote.admitInitiatedRuns({
      head: { source: 'hooks', subject: 'alpha', value: 'head-300' },
      runs: Array.from({ length: 300 }, (_, n) => ({
        request: keyed(`run-${String(n)}`),
      })),
    });
    expect(outcomes).toHaveLength(300);
    expect(outcomes.every(({ status }) => status === 'accepted')).toBe(true);
    expect(
      calls.filter(
        (name) => name === 'core.operationLedger.admitInitiatedRuns',
      ),
    ).toHaveLength(2);
    expect(await remote.sourceHead('hooks', 'alpha')).toBe('head-300');
    remote.close();
  });

  it('refuses a source head beyond its bound before sending anything', async () => {
    const { connect, calls } = holder('daemon');
    const transport = connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    await remote.ready();
    calls.splice(0);
    await expect(
      remote.admitInitiatedRuns({
        head: { source: 'hooks', subject: 'alpha', value: 'x'.repeat(4_097) },
        runs: [{ request: keyed('run-1') }],
      }),
    ).rejects.toBeInstanceOf(OperationLedgerRefusedError);
    expect(calls).toEqual([]);
    expect(await remote.sourceHead('hooks', 'alpha')).toBeNull();
    remote.close();
  });
});

const CHILD = 'core.subagent.run';

/** Accept resumable work at each clock reading, one admission each. */
async function acceptAt(
  service: OperationServicePort,
  clock: { now: number },
  times: readonly number[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const now of times) {
    clock.now = now;
    const { operation } = await service.admit(request({ kind: RESUMABLE }));
    ids.push(operation.operationId);
  }
  return ids;
}

/** Accept a source's batch of resumable runs in one millisecond. */
async function acceptBatch(
  service: OperationServicePort,
  clock: { now: number },
): Promise<string[]> {
  clock.now = 1_000;
  const batch = await service.admitInitiatedRuns({
    runs: Array.from({ length: 8 }, (_, n) => ({
      request: request({
        kind: RESUMABLE,
        status: 'queued',
        receipt: {
          caller: 'core.hooks',
          idempotencyKey: `batch-${String(n)}`,
          fingerprint: DIGEST,
        },
      }),
    })),
  });
  return batch.flatMap((outcome) =>
    outcome.status === 'accepted' ? [outcome.operation.operationId] : [],
  );
}

/**
 * The order the in-process service and the remote one recover work in,
 * each after a restart, for work `accept` accepted.
 */
async function recoveryOrders(
  accept: (
    service: OperationServicePort,
    clock: { now: number },
  ) => Promise<string[]>,
): Promise<{
  local: { ids: string[]; order: string[] };
  remote: { ids: string[]; order: string[] };
}> {
  const localClock = { now: 0 };
  const localPath = join(dir, 'local-order.sqlite');
  const localOptions = { clock: (): number => localClock.now };
  const localOrder: string[] = [];
  const before = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(localPath, localOptions),
  });
  before.registerDomain(recordingScripts([]));
  const localIds = await accept(before, localClock);
  before.close();
  const after = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(localPath, localOptions),
  });
  after.registerDomain(recordingScripts(localOrder));
  await after.ready();
  await after.whenReconciled();
  after.close();

  const remoteClock = { now: 0 };
  const { connect } = holder('daemon', {
    clock: (): number => remoteClock.now,
  });
  let transport = connect();
  const remoteOrder: string[] = [];
  const first = new RemoteOperationService({
    transport: (): Promise<OperationLedgerTransport> =>
      Promise.resolve(transport),
  });
  first.registerDomain(recordingScripts([]));
  const remoteIds = await accept(first, remoteClock);
  first.close();
  transport = connect();
  const second = new RemoteOperationService({
    transport: (): Promise<OperationLedgerTransport> =>
      Promise.resolve(transport),
  });
  second.registerDomain(recordingScripts(remoteOrder));
  await second.whenReconciled();
  second.close();
  return {
    local: { ids: localIds, order: localOrder },
    remote: { ids: remoteIds, order: remoteOrder },
  };
}

function recordingScripts(order: string[]): OperationDomain {
  return {
    domain: 'scripts',
    kinds: [RESUMABLE],
    restartClass: 'resumable',
    cancel: () => Promise.resolve('cancelled'),
    recover: (operation) => {
      order.push(operation.operationId);
      return Promise.resolve({ status: 'running' });
    },
  };
}

function recordingChildren(order: string[]): OperationDomain {
  return {
    domain: 'subagents',
    kinds: [CHILD],
    restartClass: 'lost',
    cancel: (operation) => {
      order.push(operation.operationId);
      return Promise.resolve('cancelled');
    },
  };
}

describe('the order the owner recovers and cancels in (CAN-6986 L3)', () => {
  it('recovers a batch accepted in one millisecond in the order it was accepted, as the in-process service does', async () => {
    const { local, remote } = await recoveryOrders(acceptBatch);
    expect(local.ids).toHaveLength(8);
    expect(local.order).toEqual(local.ids);
    expect(remote.ids).toHaveLength(8);
    expect(remote.order).toEqual(remote.ids);
  });

  it('recovers work accepted after the clock stepped back in the order it was accepted, as the in-process service does', async () => {
    const { local, remote } = await recoveryOrders((service, clock) =>
      acceptAt(service, clock, [1_000, 1_001, 900]),
    );
    expect(local.order).toEqual(local.ids);
    expect(remote.order).toEqual(remote.ids);
  });

  it("cancels a parent's children in the order they were accepted, as the in-process service does", async () => {
    async function cancelOrder(
      service: OperationServicePort,
      clock: { now: number },
      order: string[],
    ): Promise<string[]> {
      service.registerDomain(helperDomain({ refuse: false }));
      service.registerDomain(recordingChildren(order));
      clock.now = 1_000;
      const parent = await service.admit(request());
      const ids: string[] = [];
      for (let n = 0; n < 6; n += 1) {
        clock.now = 1_001 + n;
        const { operation } = await service.admit(
          request({
            kind: CHILD,
            parentOperationId: parent.operation.operationId,
          }),
        );
        ids.push(operation.operationId);
      }
      await service.cancel(parent.operation.operationId, {
        reason: 'Stop.',
        requestedBy: 'local-user',
      });
      return ids;
    }

    const localClock = { now: 0 };
    const local = new OperationService({
      openLedger: (): OperationLedger =>
        ledgerAt('local-cancel', { clock: (): number => localClock.now }),
    });
    const localOrder: string[] = [];
    const localIds = await cancelOrder(local, localClock, localOrder);
    local.close();

    const remoteClock = { now: 0 };
    const { connect } = holder('daemon-cancel', {
      clock: (): number => remoteClock.now,
    });
    const transport = connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    const remoteOrder: string[] = [];
    const remoteIds = await cancelOrder(remote, remoteClock, remoteOrder);
    remote.close();

    expect(localOrder).toEqual(localIds);
    expect(remoteOrder).toEqual(remoteIds);
  });
});

function resumableScripts(
  recover: OperationDomain['recover'],
): OperationDomain {
  return {
    domain: 'scripts',
    kinds: [RESUMABLE],
    restartClass: 'resumable',
    cancel: () => Promise.resolve('cancelled'),
    recover,
  };
}

describe('owner recovery across owner sessions (CAN-6986 L3)', () => {
  it('recovers awaiting work once across a reconnect of the same owner process, and records its answer', async () => {
    const { connect } = holder('daemon');
    let transport = connect();
    const earlier = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    earlier.registerDomain(
      resumableScripts(() => Promise.resolve({ status: 'running' })),
    );
    const { operation } = await earlier.admit(request({ kind: RESUMABLE }));
    earlier.close();

    let answer = (): void => undefined;
    const recover = jest.fn(
      () =>
        new Promise<OperationRecovery>((resolve) => {
          answer = (): void => resolve({ status: 'running' });
        }),
    );
    const first = heldRegistration(connect());
    transport = first.transport;
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    remote.registerDomain(resumableScripts(recover));
    const stale = remote.ready();
    for (let tick = 0; tick < 100 && !first.sent(); tick += 1) await ticks(1);
    transport = connect();
    await remote.ready();
    for (let tick = 0; tick < 100 && recover.mock.calls.length === 0; tick += 1)
      await ticks(1);
    expect(recover).toHaveBeenCalledTimes(1);
    first.release();
    await stale;
    // The owner connection is replaced while that recovery runs.
    transport = connect();
    await remote.get(operation.operationId);
    await ticks(50);
    expect(recover).toHaveBeenCalledTimes(1);
    answer();
    await remote.whenReconciled();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await remote.get(operation.operationId)).toMatchObject({
      status: 'running',
      restart: { class: 'resumable', disposition: 'resumed' },
    });
    remote.close();
  });

  it.each([
    ['the ledger was restored', 'restore'],
    ['another owner process claimed the ledger', 'flap'],
  ] as const)(
    "recovers work awaiting the owner's new run when %s, though a replaced connection began that run",
    async (_case, change) => {
      const before = holder('daemon');
      let transport = before.connect();
      const recover = jest.fn(() =>
        Promise.resolve<OperationRecovery>({ status: 'running' }),
      );
      const remote = new RemoteOperationService({
        transport: (): Promise<OperationLedgerTransport> =>
          Promise.resolve(transport),
      });
      remote.registerDomain(resumableScripts(recover));
      await remote.ready();
      const after = change === 'restore' ? holder('restored') : before;
      if (change === 'flap') await before.service.runAsOwner('another-owner');
      const { operation } = await after.service.admit(
        request({ kind: RESUMABLE }),
      );
      const first = heldRegistration(after.connect());
      transport = first.transport;
      const stale = remote.ready();
      for (let tick = 0; tick < 100 && !first.sent(); tick += 1) await ticks(1);
      transport = after.connect();
      await remote.ready();
      for (
        let tick = 0;
        tick < 100 && recover.mock.calls.length === 0;
        tick += 1
      )
        await ticks(1);
      expect(recover).toHaveBeenCalledTimes(1);
      first.release();
      await stale;
      await remote.whenReconciled();
      expect(await remote.get(operation.operationId)).toMatchObject({
        restart: { class: 'resumable', disposition: 'resumed' },
      });
      remote.close();
    },
  );

  it('records the answer of a domain that moved its work while recovering it, as the in-process service does', async () => {
    async function recovered(
      service: OperationServicePort,
      restart: () => Promise<OperationServicePort>,
    ): Promise<unknown> {
      service.registerDomain(
        resumableScripts(() => Promise.resolve({ status: 'running' })),
      );
      const { operation } = await service.admit(request({ kind: RESUMABLE }));
      const next = await restart();
      next.registerDomain(
        resumableScripts(async (record) => {
          // As the engine does: the work moves on before the domain answers.
          await next.transition(record.operationId, 'running');
          return { status: 'queued' };
        }),
      );
      await next.ready();
      await next.whenReconciled();
      const record = await next.get(operation.operationId);
      next.close();
      return { status: record?.status, restart: record?.restart?.disposition };
    }

    const localPath = join(dir, 'local-moved.sqlite');
    const local = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(localPath),
    });
    const expected = await recovered(local, () => {
      local.close();
      return Promise.resolve(
        new OperationService({
          openLedger: (): OperationLedger => OperationLedger.open(localPath),
        }),
      );
    });

    const { connect } = holder('daemon');
    let transport = connect();
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    const actual = await recovered(remote, () => {
      remote.close();
      transport = connect();
      return Promise.resolve(
        new RemoteOperationService({
          transport: (): Promise<OperationLedgerTransport> =>
            Promise.resolve(transport),
        }),
      );
    });

    expect(expected).toEqual({ status: 'queued', restart: 'resumed' });
    expect(actual).toEqual(expected);
  });
});

describe('owner subscribers after a refused cursor (CAN-6986 L3)', () => {
  it('lets a subscriber learn the state of unfinished work that changed while the events could not resume', async () => {
    const { service, connect } = holder('daemon');
    const real = connect();
    let opens = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refused = (): ReturnType<OperationLedgerTransport['openStream']> =>
      Promise.resolve({
        onFrame: (listener): (() => void) => {
          setImmediate(() => {
            listener({
              kind: 'end',
              cursor: { daemonEpoch: 'ledger', sequence: 0 },
              outcome: 'error',
              error: {
                kind: 'failed_precondition',
                code: 'core.operationLedger.snapshotRequired',
                message: 'Read the operations again.',
                retry: {
                  kind: 'after_refresh',
                  resource: 'core.operationLedger.list',
                },
              },
            });
          });
          return (): void => undefined;
        },
        close: (): void => undefined,
      });
    const transport: OperationLedgerTransport = {
      query: (name, params) => real.query(name, params),
      instruction: (name, params) => real.instruction(name, params),
      openStream: async (name, params) => {
        opens += 1;
        // The session's stream and its fallback are refused; the stream from
        // the current position opens only when released.
        if (opens <= 2) return refused();
        await held;
        return real.openStream(name, params);
      },
    };
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
    });
    remote.registerDomain(helperDomain({ refuse: false }));
    const admitted = await remote.admit(request());
    // As the hook queue and the engine release a run on its first event
    // that is not paused.
    const seen: string[] = [];
    remote.subscribe(({ operation }) => {
      if (operation.operationId === admitted.operation.operationId)
        seen.push(operation.status);
    });
    await ticks(30);
    expect(opens).toBe(3);
    // The work moves on while no stream can deliver it.
    await service.transition(admitted.operation.operationId, 'queued');
    release();
    await ticks(50);
    expect(seen).toContain('queued');
    remote.close();
  });
});

describe('a new owner process reconnecting before it recovers (CAN-6986 L3)', () => {
  it('recovers awaiting work once when the connection is replaced before recovery starts, and records its answer', async () => {
    const { connect } = holder('daemon');
    let transport = connect();
    const earlier = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
      ownerRun: 'owner-process-1',
    });
    const { operation } = await earlier.admit(request({ kind: RESUMABLE }));
    earlier.close();

    const recover = jest.fn(() =>
      Promise.resolve<OperationRecovery>({ status: 'running' }),
    );
    const first = connect();
    let replaced = false;
    const replacing: OperationLedgerTransport = {
      ...first,
      query: async (name, params) => {
        const page = await first.query(name, params);
        if (name === 'core.operationLedger.listUnfinished' && !replaced) {
          replaced = true;
          transport = connect();
          await remote.ready();
        }
        return page;
      },
    };
    transport = replacing;
    const remote = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
      ownerRun: 'owner-process-2',
    });
    remote.registerDomain(resumableScripts(recover));
    await remote.ready();
    await remote.whenReconciled();
    expect(replaced).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await remote.get(operation.operationId)).toMatchObject({
      status: 'running',
      restart: { class: 'resumable', disposition: 'resumed' },
    });
    remote.close();
  });

  it("delivers a new owner process's registration events once to a subscriber attached before it registers", async () => {
    const { connect } = holder('daemon');
    const transport = connect();
    const earlier = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
      ownerRun: 'owner-process-1',
    });
    const { operation } = await earlier.admit(request());
    earlier.close();
    const next = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.resolve(transport),
      ownerRun: 'owner-process-2',
    });
    next.registerDomain(helperDomain({ refuse: false }));
    const seen: string[] = [];
    next.subscribe((event) => {
      if (event.operation.operationId === operation.operationId)
        seen.push(event.operation.status);
    });
    await next.ready();
    await ticks(50);
    expect(seen.filter((status) => status === 'failed')).toEqual(['failed']);
    next.close();
  });
});

describe('owner recovery for domains claimed late (CAN-6986 L3)', () => {
  it.each([
    ['the connection is replaced during its recovery read', 'hold'],
    ['its recovery read failed', 'fail'],
  ] as const)(
    "recovers a late domain's work once when %s",
    async (_case, disrupt) => {
      const LATE = 'core.pipeline.run';
      const { service, connect } = holder('daemon');
      const { operation } = await service.admit(request({ kind: LATE }));
      const first = connect();
      let armed = false;
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let transport: OperationLedgerTransport = {
        ...first,
        query: async (name, params) => {
          if (!armed || name !== 'core.operationLedger.listUnfinished')
            return first.query(name, params);
          armed = false;
          if (disrupt === 'fail') throw new Error('The ledger is busy.');
          const page = await first.query(name, params);
          await held;
          return page;
        },
      };
      const remote = new RemoteOperationService({
        transport: (): Promise<OperationLedgerTransport> =>
          Promise.resolve(transport),
        ownerRun: 'owner-process-2',
      });
      const recover = jest.fn(() =>
        Promise.resolve<OperationRecovery>({ status: 'running' }),
      );
      remote.registerDomain(resumableScripts(recover));
      await remote.ready();
      armed = true;
      remote.registerDomain({
        domain: 'pipelines',
        kinds: [LATE],
        restartClass: 'resumable',
        cancel: () => Promise.resolve('cancelled'),
        recover,
      });
      for (let tick = 0; tick < 100 && armed; tick += 1) await ticks(1);
      if (disrupt === 'fail') await remote.whenReconciled();
      transport = connect();
      await remote.ready();
      release();
      await remote.whenReconciled();
      expect(recover).toHaveBeenCalledTimes(1);
      expect(await remote.get(operation.operationId)).toMatchObject({
        status: 'running',
        restart: { class: 'resumable', disposition: 'resumed' },
      });
      remote.close();
    },
  );
});

type Fault = () => Error;

const bareFault: Fault = () =>
  new Error('The connection closed before the reply.');

// A lost reply as core-client raises it: a disconnect, its own deadline
// after dispatch, or its shutdown at capacity with calls in flight. An
// inherent call (admission) keeps a same-request retry; the others (finish,
// transition) get never (core-client `forDefinition`).
const CLIENT_FAULT_MESSAGES = {
  unavailable: 'The connection to the core closed.',
  deadline_exceeded: 'The request deadline passed.',
  resource_exhausted: 'Too many cancelled requests are awaiting late replies.',
} as const;

function clientFault(
  kind: keyof typeof CLIENT_FAULT_MESSAGES,
  retry: 'same_request' | 'never' = 'same_request',
): Fault {
  const message = CLIENT_FAULT_MESSAGES[kind];
  return () =>
    Object.assign(new Error(message), {
      name: 'CanopyClientError',
      payload: { kind, message, retry: { kind: retry } },
    });
}

const FAULTS: readonly (readonly [string, Fault])[] = [
  ['a bare error', bareFault],
  ['a disconnect', clientFault('unavailable')],
  ['its deadline after dispatch', clientFault('deadline_exceeded')],
  ['a capacity shutdown', clientFault('resource_exhausted')],
];

// The same losses for a write that is not idempotent, as finish and
// transition are.
const WRITE_FAULTS: readonly (readonly [string, Fault])[] = [
  ['a disconnect', clientFault('unavailable', 'never')],
  ['its deadline after dispatch', clientFault('deadline_exceeded', 'never')],
  ['a capacity shutdown', clientFault('resource_exhausted', 'never')],
];

// Drops one operation's next reply, applied or not. Then the ledger
// restarts, or the connection stays down and every later call fails.
function lossy(
  name: string,
  fault: Fault = bareFault,
): {
  transport: () => Promise<OperationLedgerTransport>;
  drop: (
    operation: string,
    applied: boolean,
    after?: 'restart' | 'down',
  ) => void;
  daemon: () => ReturnType<typeof holder>;
} {
  let daemon = holder(name);
  let pending: {
    operation: string;
    applied: boolean;
    after: 'restart' | 'down';
  } | null = null;
  let down = false;
  const wrap = (inner: OperationLedgerTransport): OperationLedgerTransport => ({
    query: async (operation, params) => {
      if (down) throw fault();
      return inner.query(operation, params);
    },
    instruction: async (operation, params) => {
      if (down) throw fault();
      if (pending?.operation !== operation)
        return inner.instruction(operation, params);
      const { applied, after } = pending;
      pending = null;
      if (applied) await inner.instruction(operation, params);
      if (after === 'down') {
        down = true;
        throw fault();
      }
      daemon.service.close();
      daemon = holder(name);
      connection = wrap(daemon.connect());
      throw fault();
    },
    openStream: async (operation, params) => {
      if (down) throw fault();
      return inner.openStream(operation, params);
    },
  });
  let connection = wrap(daemon.connect());
  return {
    transport: (): Promise<OperationLedgerTransport> =>
      Promise.resolve(connection),
    drop: (operation, applied, after = 'restart'): void => {
      pending = { operation, applied, after };
    },
    daemon: () => daemon,
  };
}

async function operationsIn(
  daemon: ReturnType<typeof holder>,
): Promise<string[]> {
  const page = await daemon.service.list({ limit: 100 });
  return page.items.map((item) => item.operationId);
}

describe('owner writes in flight across a ledger restart (CAN-6986 L4)', () => {
  it.each([
    ['after', true],
    ['before', false],
  ])(
    'rejects a keyed admission whose reply was lost %s it was applied as an unknown outcome, and never sends it again',
    async (_when, applied) => {
      const link = lossy('daemon');
      const owner = new RemoteOperationService({ transport: link.transport });
      owner.registerDomain(helperDomain({ refuse: false }));
      await owner.ready();
      link.drop('core.operationLedger.admit', applied);
      await expect(owner.admit(keyed('turn-1'))).rejects.toMatchObject({
        name: 'OperationLedgerOutcomeUnknownError',
      });
      const daemon = link.daemon();
      expect(await operationsIn(daemon)).toHaveLength(applied ? 1 : 0);
      expect(daemon.calls).not.toContain('core.operationLedger.lookupReceipt');
      expect(daemon.calls).not.toContain('core.operationLedger.admit');
      owner.close();
    },
  );

  it('rejects an unkeyed admission whose reply was lost as an unknown outcome, and never sends it again', async () => {
    const link = lossy('daemon');
    const owner = new RemoteOperationService({ transport: link.transport });
    owner.registerDomain(helperDomain({ refuse: false }));
    await owner.ready();
    link.drop('core.operationLedger.admit', true);
    await expect(owner.admit(request())).rejects.toMatchObject({
      name: 'OperationLedgerOutcomeUnknownError',
    });
    const daemon = link.daemon();
    expect(await operationsIn(daemon)).toHaveLength(1);
    expect(daemon.calls).not.toContain('core.operationLedger.admit');
    owner.close();
  });

  it('rejects a transition whose reply was lost as an unknown outcome, and never sends it again', async () => {
    const link = lossy('daemon');
    const owner = new RemoteOperationService({ transport: link.transport });
    owner.registerDomain(helperDomain({ refuse: false }));
    const { operation } = await owner.admit(request({ status: 'queued' }));
    link.drop('core.operationLedger.transition', true);
    await expect(
      owner.transition(operation.operationId, 'running'),
    ).rejects.toMatchObject({ name: 'OperationLedgerOutcomeUnknownError' });
    const daemon = link.daemon();
    expect(await daemon.service.get(operation.operationId)).toMatchObject({
      status: 'running',
    });
    expect(daemon.calls).not.toContain('core.operationLedger.transition');
    owner.close();
  });

  it('still reports nothing recorded when the owner connection fails before anything is sent', async () => {
    const daemon = holder('daemon');
    const owner = new RemoteOperationService({
      transport: (): Promise<OperationLedgerTransport> =>
        Promise.reject(new Error('No owner connection.')),
    });
    await expect(owner.admit(keyed('turn-1'))).rejects.toMatchObject({
      name: 'OperationLedgerError',
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(daemon.calls).toEqual([]);
    expect(await operationsIn(daemon)).toEqual([]);
    owner.close();
  });
});

describe('a terminal write whose transport failed (CAN-6986 L4)', () => {
  it('answers a finish whose reply was lost after it was applied from the record, sending it once', async () => {
    const link = lossy('daemon');
    const owner = new RemoteOperationService({ transport: link.transport });
    owner.registerDomain(helperDomain({ refuse: false }));
    const { operation } = await owner.admit(request());
    link.drop('core.operationLedger.finish', true);
    await expect(
      owner.finish(operation.operationId, { status: 'completed' }),
    ).resolves.toMatchObject({
      operationId: operation.operationId,
      status: 'completed',
    });
    const daemon = link.daemon();
    expect(daemon.calls).toContain('core.operationLedger.get');
    expect(daemon.calls).not.toContain('core.operationLedger.finish');
    owner.close();
  });

  it('sends a finish whose reply was lost before it was applied once more, after reading the record', async () => {
    const link = lossy('daemon');
    const owner = new RemoteOperationService({ transport: link.transport });
    owner.registerDomain(helperDomain({ refuse: false }));
    const { operation } = await owner.admit(request());
    link.drop('core.operationLedger.finish', false);
    await expect(
      owner.finish(operation.operationId, { status: 'completed' }),
    ).resolves.toMatchObject({ status: 'completed' });
    const daemon = link.daemon();
    expect(
      daemon.calls.filter(
        (call) =>
          call === 'core.operationLedger.get' ||
          call === 'core.operationLedger.finish',
      ),
    ).toEqual(['core.operationLedger.get', 'core.operationLedger.finish']);
    expect(await daemon.service.get(operation.operationId)).toMatchObject({
      status: 'completed',
    });
    owner.close();
  });

  it.each([
    ['after', true],
    ['before', false],
  ])(
    'settles a finishOrRecord whose reply was lost %s it was applied, reporting nothing',
    async (_when, applied) => {
      const link = lossy('daemon');
      const onError = jest.fn();
      const owner = new RemoteOperationService({
        transport: link.transport,
        onError,
      });
      owner.registerDomain(helperDomain({ refuse: false }));
      const { operation } = await owner.admit(request());
      link.drop('core.operationLedger.finishOrRecord', applied);
      await expect(
        owner.finishOrRecord(operation.operationId, { status: 'completed' }),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(onError).not.toHaveBeenCalled();
      expect(
        await link.daemon().service.get(operation.operationId),
      ).toMatchObject({ status: 'completed' });
      owner.close();
    },
  );
});

describe('a lost reply as the owner connection raises it (CAN-6986 L4)', () => {
  const CLIENT_FAULTS = FAULTS.filter(([, fault]) => fault !== bareFault);

  it.each(CLIENT_FAULTS)(
    'is not an unknown outcome to the shared keyed check when %s loses it',
    (_name, fault) => {
      const error = fault();
      const payload = CanopyErrorPayloadSchema.parse(
        'payload' in error ? error.payload : undefined,
      );
      expect(payload.retry).toEqual({ kind: 'same_request' });
      expect(isUnknownKeyedWriteOutcome(payload)).toBe(false);
    },
  );

  it.each(
    CLIENT_FAULTS.flatMap(([name, fault]) => [
      [name, 'after', true, fault] as const,
      [name, 'before', false, fault] as const,
    ]),
  )(
    'rejects a keyed admission whose reply %s lost %s it was applied as an unknown outcome, and never sends it again',
    async (_name, _when, applied, fault) => {
      const link = lossy('daemon', fault);
      const owner = new RemoteOperationService({ transport: link.transport });
      owner.registerDomain(helperDomain({ refuse: false }));
      await owner.ready();
      link.drop('core.operationLedger.admit', applied);
      await expect(owner.admit(keyed('turn-1'))).rejects.toMatchObject({
        name: 'OperationLedgerOutcomeUnknownError',
      });
      const daemon = link.daemon();
      expect(await operationsIn(daemon)).toHaveLength(applied ? 1 : 0);
      expect(daemon.calls).not.toContain('core.operationLedger.lookupReceipt');
      expect(daemon.calls).not.toContain('core.operationLedger.admit');
      owner.close();
    },
  );

  it.each(WRITE_FAULTS)(
    'rejects a transition whose reply %s lost as an unknown outcome, and never sends it again',
    async (_name, fault) => {
      const link = lossy('daemon', fault);
      const owner = new RemoteOperationService({ transport: link.transport });
      owner.registerDomain(helperDomain({ refuse: false }));
      const { operation } = await owner.admit(request({ status: 'queued' }));
      link.drop('core.operationLedger.transition', true);
      await expect(
        owner.transition(operation.operationId, 'running'),
      ).rejects.toMatchObject({ name: 'OperationLedgerOutcomeUnknownError' });
      expect(link.daemon().calls).not.toContain(
        'core.operationLedger.transition',
      );
      owner.close();
    },
  );

  it.each(WRITE_FAULTS)(
    'answers a finish whose reply %s lost after it was applied from the record',
    async (_name, fault) => {
      const link = lossy('daemon', fault);
      const owner = new RemoteOperationService({ transport: link.transport });
      owner.registerDomain(helperDomain({ refuse: false }));
      const { operation } = await owner.admit(request());
      link.drop('core.operationLedger.finish', true);
      await expect(
        owner.finish(operation.operationId, { status: 'completed' }),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(link.daemon().calls).not.toContain('core.operationLedger.finish');
      owner.close();
    },
  );
});

describe('a lost reply whose recovery read fails too (CAN-6986 L4)', () => {
  it.each(FAULTS)(
    'keeps a keyed admission lost to %s unknown when the connection stays down',
    async (_name, fault) => {
      const link = lossy('daemon', fault);
      const owner = new RemoteOperationService({ transport: link.transport });
      owner.registerDomain(helperDomain({ refuse: false }));
      await owner.ready();
      link.drop('core.operationLedger.admit', true, 'down');
      await expect(owner.admit(keyed('turn-1'))).rejects.toMatchObject({
        name: 'OperationLedgerOutcomeUnknownError',
      });
      expect(await operationsIn(link.daemon())).toHaveLength(1);
      owner.close();
    },
  );

  it.each([FAULTS[0], ...WRITE_FAULTS])(
    'keeps a finish lost to %s unknown when the connection stays down',
    async (_name, fault) => {
      const link = lossy('daemon', fault);
      const owner = new RemoteOperationService({ transport: link.transport });
      owner.registerDomain(helperDomain({ refuse: false }));
      const { operation } = await owner.admit(request());
      link.drop('core.operationLedger.finish', true, 'down');
      await expect(
        owner.finish(operation.operationId, { status: 'completed' }),
      ).rejects.toMatchObject({ name: 'OperationLedgerOutcomeUnknownError' });
      expect(
        await link.daemon().service.get(operation.operationId),
      ).toMatchObject({ status: 'completed' });
      owner.close();
    },
  );

  it.each([FAULTS[0], ...WRITE_FAULTS])(
    'reports a finishOrRecord lost to %s as unknown when the connection stays down',
    async (_name, fault) => {
      const link = lossy('daemon', fault);
      const onError = jest.fn();
      const owner = new RemoteOperationService({
        transport: link.transport,
        onError,
      });
      owner.registerDomain(helperDomain({ refuse: false }));
      const { operation } = await owner.admit(request());
      link.drop('core.operationLedger.finishOrRecord', true, 'down');
      await expect(
        owner.finishOrRecord(operation.operationId, { status: 'completed' }),
      ).resolves.toBeNull();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'OperationLedgerOutcomeUnknownError' }),
        'finish',
      );
      owner.close();
    },
  );
});

describe('ledger failures across the owner connection (CAN-6986 L3b G10)', () => {
  it.each([
    'WRITER_UNAVAILABLE',
    'BACKUP_UNVERIFIED',
    'UNSUPPORTED_SCHEMA',
  ] as const)(
    'raises %s at the owner as the in-process ledger would',
    async (code) => {
      const service = new OperationService({
        openLedger: (): OperationLedger => {
          throw new OperationLedgerError(code, 'The ledger cannot be used.');
        },
      });
      const dispatcher = createCanopyDispatcher({
        profile: 'core',
        definitions: DEFINITIONS,
        handlers: createCoreOperationLedgerHandlers(service),
      });
      const client = createInProcessCanopyClient(dispatcher, OWNER);
      const transport: OperationLedgerTransport = {
        query: (operation, params) => client.query(operation, params),
        instruction: (operation, params) =>
          client.instruction(operation, params),
        openStream: (operation, params) => client.openStream(operation, params),
      };
      const owner = new RemoteOperationService({
        transport: (): Promise<OperationLedgerTransport> =>
          Promise.resolve(transport),
      });
      await expect(owner.get('operation-1')).rejects.toMatchObject({
        name: 'OperationLedgerError',
        code,
      });
      owner.close();
      service.close();
    },
  );

  it.each([
    ['WRITER_UNAVAILABLE', 'unavailable', 'same_request'],
    ['BACKUP_UNVERIFIED', 'failed_precondition', 'never'],
    ['UNSUPPORTED_SCHEMA', 'failed_precondition', 'never'],
  ] as const)(
    'refuses a keyed admission with %s at the owner, never as an unknown outcome',
    async (code, kind, retry) => {
      const service = new OperationService({
        openLedger: (): OperationLedger => {
          throw new OperationLedgerError(code, 'The ledger cannot be used.');
        },
      });
      const dispatcher = createCanopyDispatcher({
        profile: 'core',
        definitions: DEFINITIONS,
        handlers: createCoreOperationLedgerHandlers(service),
      });
      const client = createInProcessCanopyClient(dispatcher, OWNER);
      const healthy = holder(`admission-${code}`).connect();
      const sent: string[] = [];
      const answers = new Map<string, unknown>();
      const transport: OperationLedgerTransport = {
        query: (operation, params) => healthy.query(operation, params),
        instruction: async (operation, params) => {
          if (operation !== 'core.operationLedger.admit')
            return healthy.instruction(operation, params);
          sent.push(operation);
          try {
            return await client.instruction(operation, params);
          } catch (error) {
            answers.set(
              operation,
              typeof error === 'object' && error !== null && 'payload' in error
                ? error.payload
                : undefined,
            );
            throw error;
          }
        },
        openStream: (operation, params) =>
          healthy.openStream(operation, params),
      };
      const owner = new RemoteOperationService({
        transport: (): Promise<OperationLedgerTransport> =>
          Promise.resolve(transport),
      });
      const refused = await owner.admit(keyed('turn-1')).then(
        () => null,
        (error: unknown) => error,
      );
      expect(sent).toEqual(['core.operationLedger.admit']);
      expect(refused).toMatchObject({ name: 'OperationLedgerError', code });
      const answer = CanopyErrorPayloadSchema.parse(
        answers.get('core.operationLedger.admit'),
      );
      expect(answer).toMatchObject({ kind, retry: { kind: retry } });
      expect(isUnknownKeyedWriteOutcome(answer)).toBe(false);
      owner.close();
      service.close();
    },
  );
});
