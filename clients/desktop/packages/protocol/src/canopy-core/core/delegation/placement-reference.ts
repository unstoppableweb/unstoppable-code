import type { DelegationPlacementRecords } from './placement-equality';

/*
 * The reference placement for the equality check (ADR 23; CAN-6214): the
 * records desktop's core leaves when it dispatches a pipeline run's
 * `worker.pipeline.execution.start` to its in-process worker and the worker
 * answers, with identifiers and times replaced by stable ones. The
 * core-runtime golden (`pipeline-start-placement.qualification.test.ts`)
 * keeps it equal to what the operation ledger records, so every other
 * placement of a run start, such as a cloud run's (CP-21) or the daemon's
 * split worker (CAN-5098), is checked against desktop itself.
 */
export const DESKTOP_PIPELINE_START_PLACEMENT: DelegationPlacementRecords = {
  target: {
    targetId: 'in_process_worker',
    catalogKind: 'builtin',
    profile: 'core+worker',
    leaseBinding: 'in-process',
    activationDelivery: 'inline-parameters',
    registeredAt: '2026-11-10T10:00:00.000Z',
  },
  delegation: {
    delegationId: 'delegation-1',
    parentOperationId: 'run-1',
    childOperationId: 'start-1',
    rootOperationId: 'run-1',
    targetId: 'in_process_worker',
    leaseId: 'lease-1',
    operation: {
      name: 'worker.pipeline.execution.start',
      version: 1,
      idempotency: 'keyed',
    },
    idempotencyKey: 'execution-1',
    executorKey: 'delegation-1',
    activation: {
      delivery: 'inline-parameters',
      digest: `sha256:${'0'.repeat(64)}`,
    },
    secrets: [],
    state: 'completed',
    resolution: 'reply',
    createdAt: '2026-11-10T10:00:02.000Z',
    dispatchedAt: '2026-11-10T10:00:03.000Z',
    settledAt: '2026-11-10T10:00:04.000Z',
    updatedAt: '2026-11-10T10:00:04.000Z',
  },
  lease: {
    leaseId: 'lease-1',
    targetId: 'in_process_worker',
    binding: 'in-process',
    signal: 'process_liveness',
    runEpoch: 'run-epoch-1',
    acquiredAt: '2026-11-10T10:00:01.000Z',
    renewAfterMs: null,
    ttlMs: null,
    expiresAt: null,
    releasedAt: null,
    releaseReason: null,
  },
  child: {
    operationId: 'start-1',
    kind: 'worker.pipeline.execution.start',
    status: 'completed',
    revision: 3,
    parentOperationId: 'run-1',
    rootOperationId: 'run-1',
    authorityId: null,
    executionTargetId: 'in_process_worker',
    runtimeDelegationId: 'delegation-1',
    scope: { executionId: 'execution-1', targetId: 'in_process_worker' },
    origin: { kind: 'delegation', sourceId: 'run-1' },
    owner: { kind: 'principal', id: 'principal-1' },
    receipt: {
      idempotencyKey: 'execution-1',
      acceptedAt: '2026-11-10T10:00:02.000Z',
      outcome: 'recorded',
    },
    createdAt: '2026-11-10T10:00:02.000Z',
    updatedAt: '2026-11-10T10:00:04.000Z',
    completedAt: '2026-11-10T10:00:04.000Z',
    progress: null,
    outcome: { execution: { executionId: 'execution-1' } },
    error: null,
    cancellation: null,
    restart: null,
  },
};
