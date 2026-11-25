import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IN_PROCESS_LEASE_TERMS,
  IN_PROCESS_WORKER_TARGET,
  isTerminalOperationStatus,
  type DelegationDispatchInput,
  type DelegationLeaseRecord,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import { OperationService } from '..';
import {
  InitiatedWorkEngine,
  InitiatedWorkInvariantError,
  type InitiatedWorkAcceptance,
  type InitiatedWorkAdmission,
} from '../../initiated-work/engine';
import {
  OperationLedger,
  OperationLedgerRefusedError,
  type OperationAcceptRequest,
  type OperationLedgerEvent,
} from '../ledger';
import type {
  OperationAdmissionBatch,
  OperationAdmissionOutcome,
} from '../service';

/*
 * CAN-6986 L2: the write closures domains ran on the operation ledger
 * through `OperationService.write()` become typed writes on the service,
 * so a later remote service can take them without running a closure on the
 * handle. Two ledgers start from the same state: one runs the closure body
 * the domain ran before L2, the other the typed write. Each must leave the
 * same records and publish the same events in the same order, and a throw
 * must publish nothing and leave the ledger as it was.
 */

const KIND = 'core.helper.run';
const DIGEST = `sha256:${'0'.repeat(64)}`;
const STOPPED = { status: 'completed' as const, outcome: { gate: 'skipped' } };

let dir: string;

interface World {
  readonly ledger: OperationLedger;
  readonly service: OperationService;
  readonly published: OperationLedgerEvent[];
}

function world(name: string): World {
  const ledger = OperationLedger.open(join(dir, name, 'operations.sqlite'));
  const service = new OperationService({
    openLedger: (): OperationLedger => ledger,
  });
  const published: OperationLedgerEvent[] = [];
  service.subscribe((event) => {
    published.push(event);
  });
  return { ledger, service, published };
}

function request(
  overrides: Partial<OperationAcceptRequest> = {},
): OperationAcceptRequest {
  return {
    kind: KIND,
    status: 'queued',
    origin: { kind: 'client', sourceId: 'desktop-window-1' },
    owner: { kind: 'principal', id: 'local-user' },
    scope: { workspaceId: 'alpha', worktreeId: 'main' },
    ...overrides,
  };
}

function keyed(key: string, fingerprint = 'params'): OperationAcceptRequest {
  return request({
    receipt: { caller: 'local-user', idempotencyKey: key, fingerprint },
  });
}

/** An event without the identity and time a fresh ledger assigns. */
function shape(event: OperationLedgerEvent | null): unknown {
  if (!event) return null;
  return {
    event: event.event,
    previousStatus: event.previousStatus,
    record: record(event.operation),
  };
}

function record(operation: OperationRecord | null): unknown {
  if (!operation) return null;
  return {
    kind: operation.kind,
    status: operation.status,
    origin: operation.origin.kind,
    cancellation: operation.cancellation
      ? {
          requestedBy: operation.cancellation.requestedBy,
          reason: operation.cancellation.reason,
        }
      : null,
    outcome: operation.outcome ?? null,
  };
}

function outcomeShape(outcome: OperationAdmissionOutcome): unknown {
  return outcome.status === 'keyReused'
    ? { status: 'keyReused' }
    : { status: outcome.status, record: record(outcome.operation) };
}

/** The admission closure `InitiatedWorkEngine.acceptOccurrence` ran before L2. */
function admitWithClosure(
  ledger: OperationLedger,
  batch: OperationAdmissionBatch,
): { value: OperationAdmissionOutcome[]; events: unknown[] } {
  return ledger.atomically(() => {
    const events: (OperationLedgerEvent | null)[] = [];
    if (batch.head)
      ledger.recordSourceHead(
        batch.head.source,
        batch.head.subject,
        batch.head.value,
      );
    const value = batch.runs.map((run): OperationAdmissionOutcome => {
      let accepted: ReturnType<OperationLedger['accept']>;
      try {
        accepted = ledger.accept(run.request);
      } catch (error) {
        if (
          error instanceof OperationLedgerRefusedError &&
          error.refusal === 'key-reused'
        )
          return { status: 'keyReused' };
        throw error;
      }
      if (accepted.status !== 'accepted')
        return { status: 'duplicate', operation: accepted.operation };
      events.push(accepted.event);
      if (!run.finishAs)
        return { status: 'accepted', operation: accepted.operation };
      const finished = ledger.finish(
        accepted.operation.operationId,
        run.finishAs,
      );
      events.push(finished.event);
      return { status: 'stopped', operation: finished.operation };
    });
    return { value, events: events.map(shape) };
  });
}

/** The cancellation closure `InitiatedWorkEngine.finishCancelled` ran before L2. */
function cancelWithClosure(
  ledger: OperationLedger,
  operationId: string,
  intent?: { requestedAt: string; requestedBy: string; reason: string },
): unknown[] {
  const current = ledger.get(operationId);
  if (!current || isTerminalOperationStatus(current.status)) return [];
  const events: (OperationLedgerEvent | null)[] = [];
  if (intent && !current.cancellation)
    events.push(ledger.requestCancel(operationId, intent).event);
  events.push(ledger.finish(operationId, { status: 'cancelled' }).event);
  return events.map(shape);
}

function dispatchFor(
  parentOperationId: string,
  lease: DelegationLeaseRecord,
): {
  request: OperationAcceptRequest & {
    parentOperationId: string;
    runtimeDelegationId: string;
  };
  dispatch: DelegationDispatchInput;
} {
  const delegationId = randomUUID();
  const key = randomUUID();
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
      targetId: lease.targetId,
      leaseId: lease.leaseId,
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-ledger-writes-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('operation ledger typed writes (CAN-6986 L2)', () => {
  it('admits a batch exactly as the admission closure did, with every outcome', async () => {
    const before = world('closure');
    const after = world('typed');
    for (const { ledger } of [before, after]) ledger.accept(keyed('seen'));
    const batch = (): OperationAdmissionBatch => ({
      head: { source: 'github_pr_state', subject: 'pr:1', value: 'head-2' },
      runs: [
        { request: keyed('new') },
        { request: keyed('stopped'), finishAs: STOPPED },
        { request: keyed('seen') },
        { request: keyed('seen', 'other params') },
      ],
    });

    const expected = admitWithClosure(before.ledger, batch());
    const outcomes = await after.service.admitInitiatedRuns(batch());

    expect(outcomes.map(outcomeShape)).toEqual(
      expected.value.map(outcomeShape),
    );
    expect(outcomes.map(({ status }) => status)).toEqual([
      'accepted',
      'stopped',
      'duplicate',
      'keyReused',
    ]);
    expect(after.published.map(shape)).toEqual(expected.events);
    expect(after.ledger.sourceHead('github_pr_state', 'pr:1')).toBe('head-2');
    expect(before.ledger.sourceHead('github_pr_state', 'pr:1')).toBe('head-2');
    for (const { ledger } of [before, after]) ledger.close();
  });

  it('rolls a failing batch back and publishes nothing', async () => {
    const { ledger, service, published } = world('typed');
    await expect(
      service.admitInitiatedRuns({
        head: { source: 'github_pr_state', subject: 'pr:1', value: 'head-3' },
        runs: [
          { request: keyed('first') },
          { request: request({ parentOperationId: 'missing' }) },
        ],
      }),
    ).rejects.toMatchObject({ refusal: 'unknown-parent' });
    expect(published).toEqual([]);
    expect(ledger.sourceHead('github_pr_state', 'pr:1')).toBeNull();
    const firstReceipt = keyed('first').receipt;
    if (!firstReceipt) throw new Error('Expected a keyed request');
    expect(ledger.lookupReceipt(KIND, firstReceipt)).toEqual({
      status: 'none',
    });
    ledger.close();
  });

  it('keeps what a source sees for a reused occurrence key', async () => {
    const { ledger, service } = world('engine');
    const engine = new InitiatedWorkEngine({ operations: service });
    const run = (targetKey: string): InitiatedWorkAdmission => ({
      origin: {
        kind: 'hook',
        sourceId: 'hook-1',
        occurrenceKey: 'occurrence-1',
      },
      owner: { kind: 'principal', id: 'local' },
      scope: { workspaceId: 'p', worktreeId: 'a' },
      targetKey,
    });
    const [first] = await engine.acceptOccurrence({ runs: [run('target-a')] });
    expect(first?.status).toBe('accepted');
    // The same occurrence with other parameters: develop answered keyReused
    // from inside the closure, and the batch answers it the same way.
    await expect(
      engine.acceptOccurrence({ runs: [run('target-b')] }),
    ).resolves.toEqual([{ status: 'keyReused' }]);
    const [repeat] = await engine.acceptOccurrence({ runs: [run('target-a')] });
    expect(repeat).toMatchObject({ status: 'duplicate' });
    ledger.close();
  });

  it.each([
    ['fewer', 0],
    ['more', 2],
  ])(
    'fails closed when the batch admission answers %s outcomes than runs',
    async (_label, count) => {
      const { ledger, service } = world('engine');
      const engine = new InitiatedWorkEngine({ operations: service });
      const admit = service.admitInitiatedRuns.bind(service);
      const spy = jest
        .spyOn(service, 'admitInitiatedRuns')
        .mockImplementation(async (batch) => {
          const outcomes = await admit(batch);
          const first = outcomes[0];
          if (!first) throw new Error('one outcome expected');
          return count === 0 ? [] : [first, first];
        });
      await expect(
        engine.acceptOccurrence({
          runs: [
            {
              origin: {
                kind: 'hook',
                sourceId: 'hook-1',
                occurrenceKey: 'occurrence-1',
              },
              owner: { kind: 'principal', id: 'local' },
              scope: { workspaceId: 'p', worktreeId: 'a' },
              targetKey: 'target-a',
              stopped: {
                gate: 'pause',
                verdict: {
                  decision: 'skipped',
                  message: 'Pause state unknown.',
                  code: 'core.initiatedWork.gate.pauseUnknown',
                },
              },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(InitiatedWorkInvariantError);
      spy.mockRestore();
      ledger.close();
    },
  );

  it("keeps a skipped run's code in its stopped result, and leaves it off otherwise", async () => {
    const { ledger, service } = world('engine');
    const engine = new InitiatedWorkEngine({ operations: service });
    const run = (
      occurrenceKey: string,
      stopped: InitiatedWorkAdmission['stopped'],
    ): InitiatedWorkAdmission => ({
      origin: { kind: 'hook', sourceId: 'hook-1', occurrenceKey },
      owner: { kind: 'principal', id: 'local' },
      scope: { workspaceId: 'p', worktreeId: 'a' },
      targetKey: 'target-a',
      ...(stopped && { stopped }),
    });
    const [coded, uncoded, refused] = await engine.acceptOccurrence({
      runs: [
        run('occurrence-coded', {
          gate: 'pause',
          verdict: {
            decision: 'skipped',
            message: 'Pause state unknown.',
            code: 'core.initiatedWork.gate.pauseUnknown',
          },
        }),
        run('occurrence-uncoded', {
          gate: 'pause',
          verdict: { decision: 'skipped', message: 'Paused.' },
        }),
        run('occurrence-refused', {
          gate: 'pause',
          verdict: {
            decision: 'refused',
            failure: {
              kind: 'permission_denied',
              message: 'Not allowed.',
              retry: { kind: 'never' },
            },
          },
        }),
      ],
    });
    const stoppedId = (
      acceptance: InitiatedWorkAcceptance | undefined,
    ): string =>
      acceptance?.status === 'stopped' ? acceptance.operationId : '';
    for (const acceptance of [coded, uncoded, refused])
      expect(stoppedId(acceptance)).not.toBe('');
    expect(coded).toEqual({
      status: 'stopped',
      operationId: stoppedId(coded),
      code: 'core.initiatedWork.gate.pauseUnknown',
    });
    expect(uncoded).toEqual({
      status: 'stopped',
      operationId: stoppedId(uncoded),
    });
    expect(refused).toEqual({
      status: 'stopped',
      operationId: stoppedId(refused),
    });
    ledger.close();
  });

  it('accepts and finishes a stopped run as recordStopped did, and still throws on key reuse', async () => {
    const { ledger, service, published } = world('typed');
    const first = await service.admitFinished(keyed('gate'), STOPPED);
    expect(first.status).toBe('accepted');
    expect(
      published.map((event) => ({
        event: event.event,
        previousStatus: event.previousStatus,
        status: event.operation.status,
      })),
    ).toEqual([
      { event: 'queued', previousStatus: null, status: 'queued' },
      { event: 'completed', previousStatus: 'queued', status: 'completed' },
    ]);
    const again = await service.admitFinished(keyed('gate'), STOPPED);
    expect(again).toMatchObject({ status: 'duplicate' });
    expect(published).toHaveLength(2);
    await expect(
      service.admitFinished(keyed('gate', 'other params'), STOPPED),
    ).rejects.toMatchObject({ refusal: 'key-reused' });
    expect(published).toHaveLength(2);
    ledger.close();
  });

  it('finishes cancelled work as the cancellation closure did', async () => {
    const before = world('closure');
    const after = world('typed');
    const intent = {
      requestedAt: '2026-11-17T12:00:00.000Z',
      requestedBy: 'host',
      reason: 'desktop_quit',
    };
    const seed = (
      ledger: OperationLedger,
    ): { live: string; plain: string; done: string } => {
      const live = ledger.accept(request()).operation.operationId;
      const plain = ledger.accept(request()).operation.operationId;
      const done = ledger.accept(request()).operation.operationId;
      ledger.finish(done, { status: 'completed' });
      return { live, plain, done };
    };
    const b = seed(before.ledger);
    const a = seed(after.ledger);
    const expected = [
      ...cancelWithClosure(before.ledger, b.live, intent),
      ...cancelWithClosure(before.ledger, b.plain),
      ...cancelWithClosure(before.ledger, b.done, intent),
      ...cancelWithClosure(before.ledger, 'missing', intent),
    ];
    await after.service.finishCancelled(a.live, intent);
    await after.service.finishCancelled(a.plain);
    await after.service.finishCancelled(a.done, intent);
    await after.service.finishCancelled('missing', intent);

    expect(after.published.map(shape)).toEqual(expected);
    expect(after.published.map(({ event }) => event)).toEqual([
      'cancelRequested',
      'cancelled',
      'cancelled',
    ]);
    for (const key of ['live', 'plain', 'done'] as const)
      expect(record(after.ledger.get(a[key]))).toEqual(
        record(before.ledger.get(b[key])),
      );
    for (const { ledger } of [before, after]) ledger.close();
  });

  it('records a dispatch, its marks and its settlement as the dispatch closures did', async () => {
    const before = world('closure');
    const after = world('typed');
    const closureParent = before.ledger.accept(
      request({ status: 'running' }),
    ).operation;
    const typedParent = after.ledger.accept(
      request({ status: 'running' }),
    ).operation;

    before.ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
    const closureLease = before.ledger.acquireLease(
      IN_PROCESS_WORKER_TARGET.targetId,
      IN_PROCESS_LEASE_TERMS,
    );
    const typedLease = await after.service.placeInProcessWorker(
      IN_PROCESS_WORKER_TARGET,
      IN_PROCESS_LEASE_TERMS,
    );

    const closureEvents: unknown[] = [];
    const reference = dispatchFor(closureParent.operationId, closureLease);
    const accepted = before.ledger.acceptDispatch(
      reference.request,
      reference.dispatch,
    );
    if (accepted.result.status === 'accepted')
      closureEvents.push(shape(accepted.result.event));
    closureEvents.push(
      shape(
        before.ledger.markDispatched(reference.dispatch.delegationId).change
          .event,
      ),
    );
    before.ledger.markDelegation(
      reference.dispatch.delegationId,
      'reconciling',
    );
    const settledBefore = before.ledger.settleDispatch(
      reference.dispatch.delegationId,
      {
        status: 'completed',
        outcome: { ok: true },
        resolution: 'executor-receipt',
      },
    );
    closureEvents.push(shape(settledBefore.change.event));

    const typed = dispatchFor(typedParent.operationId, typedLease);
    await after.service.acceptDispatch(typed.request, typed.dispatch);
    await after.service.markDispatched(typed.dispatch.delegationId);
    await after.service.markDelegation(
      typed.dispatch.delegationId,
      'reconciling',
    );
    const settledAfter = await after.service.settleDispatch(
      typed.dispatch.delegationId,
      {
        status: 'completed',
        outcome: { ok: true },
        resolution: 'executor-receipt',
      },
    );

    // The parent's own acceptance came before the service subscribed.
    expect(after.published.map(shape)).toEqual(closureEvents);
    expect(record(settledAfter.change.operation)).toEqual(
      record(settledBefore.change.operation),
    );
    expect({
      state: settledAfter.delegation.state,
      resolution: settledAfter.delegation.resolution,
    }).toEqual({
      state: settledBefore.delegation.state,
      resolution: settledBefore.delegation.resolution,
    });
    for (const { ledger } of [before, after]) ledger.close();
  });

  it('places the in-process worker once per open ledger, and again after a reopen', async () => {
    const path = join(dir, 'placement', 'operations.sqlite');
    let ledger = OperationLedger.open(path);
    let service = new OperationService({
      openLedger: (): OperationLedger => ledger,
    });
    const first = await service.placeInProcessWorker(
      IN_PROCESS_WORKER_TARGET,
      IN_PROCESS_LEASE_TERMS,
    );
    const again = await service.placeInProcessWorker(
      IN_PROCESS_WORKER_TARGET,
      IN_PROCESS_LEASE_TERMS,
    );
    expect(again).toEqual(first);
    const parent = ledger.accept(request({ status: 'running' })).operation;
    const inFlight = dispatchFor(parent.operationId, first);
    await service.acceptDispatch(inFlight.request, inFlight.dispatch);
    await service.markDispatched(inFlight.dispatch.delegationId);
    ledger.close();

    ledger = OperationLedger.open(path);
    service = new OperationService({
      openLedger: (): OperationLedger => ledger,
    });
    const reopened = await service.placeInProcessWorker(
      IN_PROCESS_WORKER_TARGET,
      IN_PROCESS_LEASE_TERMS,
    );
    expect(reopened.leaseId).not.toBe(first.leaseId);
    expect(reopened.targetId).toBe(first.targetId);
    // Placing again after the reopen settles what the earlier run left.
    expect(
      await service.getDelegation(inFlight.dispatch.delegationId),
    ).toMatchObject({ state: 'unreachable', resolution: 'restart' });
    expect(
      await service.placeInProcessWorker(
        IN_PROCESS_WORKER_TARGET,
        IN_PROCESS_LEASE_TERMS,
      ),
    ).toEqual(reopened);
    ledger.close();
  });
});
