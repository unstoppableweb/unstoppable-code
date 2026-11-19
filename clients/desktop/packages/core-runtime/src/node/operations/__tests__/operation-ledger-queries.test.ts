import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IN_PROCESS_LEASE_TERMS,
  IN_PROCESS_WORKER_TARGET,
} from '@canopy/protocol/canopy-core';
import { OperationService } from '..';
import { OperationLedger, type OperationAcceptRequest } from '../ledger';

/*
 * CAN-6986 L1: the read-only closures domains ran on the operation ledger
 * through `ready()` and `write()` become typed queries on OperationService,
 * so a later remote service can answer them without running a closure on
 * the handle. Each query must answer exactly what the closure it replaces
 * answered, over one ledger reopened after a restart.
 */

const DIGEST = `sha256:${'0'.repeat(64)}`;
const KIND = 'core.helper.run';

let dir: string;
let ledger: OperationLedger;

const file = (): string => join(dir, 'operations', 'operation-ledger.sqlite');

function request(
  overrides: Partial<OperationAcceptRequest> = {},
): OperationAcceptRequest {
  return {
    kind: KIND,
    status: 'running',
    origin: { kind: 'client', sourceId: 'desktop-window-1' },
    owner: { kind: 'principal', id: 'local-user' },
    scope: { workspaceId: 'alpha', worktreeId: 'main' },
    ...overrides,
  };
}

function accepted(overrides: Partial<OperationAcceptRequest> = {}): string {
  const result = ledger.accept(request(overrides));
  if (result.status !== 'accepted') throw new Error('Expected a new operation');
  return result.operation.operationId;
}

/** A parent with one dispatched helper run, as local-worker records it. */
function dispatch(parent: string): string {
  ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
  const lease = ledger.acquireLease(
    IN_PROCESS_WORKER_TARGET.targetId,
    IN_PROCESS_LEASE_TERMS,
  );
  const delegationId = randomUUID();
  const helperRunId = randomUUID();
  ledger.acceptDispatch(
    {
      kind: 'worker.agent.helper.run',
      status: 'queued',
      receipt: {
        caller: `core.delegation:${parent}`,
        idempotencyKey: helperRunId,
        fingerprint: DIGEST,
      },
      origin: { kind: 'delegation', sourceId: parent },
      owner: { kind: 'principal', id: 'local-user' },
      scope: { workspaceId: 'alpha', worktreeId: 'main' },
      parentOperationId: parent,
      runtimeDelegationId: delegationId,
    },
    {
      delegationId,
      targetId: lease.targetId,
      leaseId: lease.leaseId,
      operation: {
        name: 'worker.agent.helper.run',
        version: 1,
        idempotency: 'keyed',
      },
      idempotencyKey: helperRunId,
      executorKey: delegationId,
      activation: { delivery: 'inline-parameters', digest: DIGEST },
      secrets: [],
    },
  );
  ledger.markDispatched(delegationId);
  return delegationId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-ledger-queries-'));
  ledger = OperationLedger.open(file());
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('operation ledger typed queries (CAN-6986 L1)', () => {
  it('answer what the read-only closures they replace answered, across a restart', async () => {
    const receipt = {
      caller: 'local-user',
      idempotencyKey: randomUUID(),
      fingerprint: 'params',
    };
    const keyed = accepted({ receipt });
    const interrupted = accepted({ status: 'queued' });
    const running = accepted();
    const parent = accepted();
    const delegationId = dispatch(parent);
    ledger.recordSourceHead('github_pr_state', 'pr:1', 'head-1');
    ledger.close();

    ledger = OperationLedger.open(file());
    const service = new OperationService({
      openLedger: (): OperationLedger => ledger,
    });
    await service.ready();

    const closure = <T>(read: (handle: OperationLedger) => T): Promise<T> =>
      service.write((handle) => ({ value: read(handle), events: [] }));

    const lookups = [
      receipt,
      { ...receipt, fingerprint: 'other params' },
      { ...receipt, idempotencyKey: randomUUID() },
    ];
    const answers = await Promise.all(
      lookups.map(async (input) => ({
        query: await service.lookupReceipt(KIND, input),
        closure: await closure((handle) => handle.lookupReceipt(KIND, input)),
        ready: (await service.ready()).lookupReceipt(KIND, input),
      })),
    );
    expect(answers.map(({ query }) => query.status)).toEqual([
      'in-progress',
      'key-reused',
      'none',
    ]);
    for (const answer of answers) {
      expect(answer.query).toEqual(answer.closure);
      expect(answer.query).toEqual(answer.ready);
    }
    expect(answers[0]?.query).toMatchObject({
      operation: { operationId: keyed },
    });

    for (const operationId of [keyed, interrupted, running, 'missing']) {
      expect(await service.statusBeforeRestart(operationId)).toEqual(
        await closure((handle) => handle.statusBeforeRestart(operationId)),
      );
      expect(await service.get(operationId)).toEqual(
        await closure((handle) => handle.get(operationId)),
      );
    }
    expect(await service.statusBeforeRestart(interrupted)).toBe('queued');
    expect(await service.statusBeforeRestart(running)).toBe('running');

    for (const [source, subject] of [
      ['github_pr_state', 'pr:1'],
      ['github_pr_state', 'pr:2'],
    ] as const) {
      expect(await service.sourceHead(source, subject)).toEqual(
        await closure((handle) => handle.sourceHead(source, subject)),
      );
    }
    expect(await service.sourceHead('github_pr_state', 'pr:1')).toBe('head-1');

    expect(await service.getDelegation(delegationId)).toEqual(
      (await service.ready()).getDelegation(delegationId),
    );
    expect(await service.getDelegation('missing')).toBeNull();
    const listed = await service.listDelegations(parent);
    expect(listed).toEqual((await service.ready()).listDelegations(parent));
    expect(listed.map((delegation) => delegation.delegationId)).toEqual([
      delegationId,
    ]);
    expect(await service.listDelegations(keyed)).toEqual([]);
  });

  it('publish no events', async () => {
    const service = new OperationService({
      openLedger: (): OperationLedger => ledger,
    });
    const events: unknown[] = [];
    service.subscribe((event) => {
      events.push(event);
    });
    const operationId = accepted({
      receipt: {
        caller: 'local-user',
        idempotencyKey: randomUUID(),
        fingerprint: 'params',
      },
    });
    const head = ledger.eventsHead();

    await service.lookupReceipt(KIND, {
      caller: 'local-user',
      idempotencyKey: randomUUID(),
      fingerprint: 'params',
    });
    await service.statusBeforeRestart(operationId);
    await service.sourceHead('github_pr_state', 'pr:1');
    await service.getDelegation('missing');
    await service.listDelegations(operationId);

    expect(events).toEqual([]);
    expect(ledger.eventsHead()).toBe(head);
  });
});
