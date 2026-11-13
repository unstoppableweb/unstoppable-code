// ADR 23 (CAN-6214, plan CP-21): the field-for-field equality check of
// delegation and placement records that a cloud run (CP-21) and the split
// worker (CAN-5098) are held to against desktop's in-process placement.
import {
  DESKTOP_PIPELINE_START_PLACEMENT,
  delegationPlacementDifferences,
  type DelegationPlacementRecords,
} from '../core/delegation';

const reference = DESKTOP_PIPELINE_START_PLACEMENT;

/** The reference placed on a remote target, with its own ids and times. */
function remote(): DelegationPlacementRecords {
  return {
    target: {
      targetId: 'cloud_sandbox_worker',
      catalogKind: 'cloud',
      profile: 'worker',
      leaseBinding: 'http',
      activationDelivery: 'bootstrap-injection',
      registeredAt: '2026-11-11T09:00:00.000Z',
    },
    delegation: {
      ...reference.delegation,
      delegationId: 'd-9',
      parentOperationId: 'r-9',
      childOperationId: 's-9',
      rootOperationId: 'r-9',
      targetId: 'cloud_sandbox_worker',
      leaseId: 'l-9',
      idempotencyKey: 'x-9',
      executorKey: 'd-9',
      activation: {
        delivery: 'bootstrap-injection',
        digest: `sha256:${'f'.repeat(64)}`,
      },
      createdAt: '2026-11-11T09:00:02.000Z',
      dispatchedAt: '2026-11-11T09:00:03.000Z',
      settledAt: '2026-11-11T09:00:05.000Z',
      updatedAt: '2026-11-11T09:00:05.000Z',
    },
    lease: {
      leaseId: 'l-9',
      targetId: 'cloud_sandbox_worker',
      binding: 'http',
      signal: 'renewal',
      runEpoch: 'pod-9',
      leaseEpoch: 1,
      lastRenewal: null,
      acquiredAt: '2026-11-11T09:00:02.000Z',
      renewAfterMs: 60_000,
      ttlMs: 300_000,
      expiresAt: '2026-11-11T09:05:02.000Z',
      releasedAt: null,
      releaseReason: null,
    },
    child: {
      ...reference.child,
      operationId: 's-9',
      parentOperationId: 'r-9',
      rootOperationId: 'r-9',
      executionTargetId: 'cloud_sandbox_worker',
      runtimeDelegationId: 'd-9',
      scope: { executionId: 'x-9', targetId: 'cloud_sandbox_worker' },
      origin: { kind: 'delegation', sourceId: 'r-9' },
      owner: { kind: 'principal', id: 'user:u-9' },
      receipt: {
        idempotencyKey: 'x-9',
        acceptedAt: '2026-11-11T09:00:01.000Z',
        outcome: 'recorded',
      },
      revision: 7,
      outcome: { execution: { executionId: 'x-9', status: 'running' } },
      createdAt: '2026-11-11T09:00:01.000Z',
      updatedAt: '2026-11-11T09:00:05.000Z',
      completedAt: '2026-11-11T09:00:05.000Z',
    },
  };
}

describe('delegation and placement record equality (ADR 23)', () => {
  it('is equal for the same work on another target, ids, times and placement aside', () => {
    expect(
      delegationPlacementDifferences(reference, reference, {
        samePlacement: true,
      }),
    ).toEqual([]);
    expect(delegationPlacementDifferences(reference, remote())).toEqual([]);
  });

  it('compares placement fields only for one target', () => {
    expect(
      delegationPlacementDifferences(reference, remote(), {
        samePlacement: true,
      }).map(({ path }) => path),
    ).toEqual(
      expect.arrayContaining([
        'target.catalogKind',
        'lease.binding',
        'delegation.activation.delivery',
      ]),
    );
  });

  it('reports a changed, missing or extra field', () => {
    const candidate = remote();
    const differences = delegationPlacementDifferences(reference, {
      ...candidate,
      delegation: {
        ...candidate.delegation,
        operation: {
          ...candidate.delegation.operation,
          idempotency: 'inherent',
        },
        resolution: 'executor-receipt',
      },
      lease: { ...candidate.lease, releaseReason: 'revoked' },
    });
    expect(differences.map(({ path }) => path)).toEqual([
      'delegation.operation.idempotency',
      'delegation.resolution',
      'lease.releaseReason',
    ]);
    expect(
      delegationPlacementDifferences(reference, {
        ...candidate,
        child: { ...candidate.child, status: 'running', completedAt: null },
      }).map(({ path }) => path),
    ).toEqual([
      'child.status',
      'child.completedAt',
      'timeline child.createdAt<=completedAt',
      'timeline delegation.dispatchedAt<=child.completedAt',
      'timeline child.completedAt<=updatedAt',
    ]);
  });

  it('reports records that name each other differently', () => {
    const candidate = remote();
    const paths = delegationPlacementDifferences(reference, {
      ...candidate,
      delegation: {
        ...candidate.delegation,
        // An executor key of its own, not the delegation's id.
        executorKey: 'other',
        // A root that is not the parent run.
        rootOperationId: 'elsewhere',
      },
      child: { ...candidate.child, runtimeDelegationId: 'd-other' },
    }).map(({ path }) => path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'identity delegation.delegationId=delegation.executorKey',
        'identity delegation.parentOperationId=delegation.rootOperationId',
        'identity delegation.delegationId=child.runtimeDelegationId',
      ]),
    );
    // Ids that merely coincide are no difference: a cloud run's execution
    // id may be its operation id.
    expect(
      delegationPlacementDifferences(reference, {
        ...candidate,
        delegation: { ...candidate.delegation, idempotencyKey: 'r-9' },
        child: {
          ...candidate.child,
          scope: { executionId: 'r-9', targetId: 'cloud_sandbox_worker' },
          receipt: { ...candidate.child.receipt, idempotencyKey: 'r-9' },
        },
      }),
    ).toEqual([]);
    // An identifier present in one and absent in the other is.
    expect(
      delegationPlacementDifferences(reference, {
        ...candidate,
        child: {
          ...candidate.child,
          receipt: { ...candidate.child.receipt, idempotencyKey: null },
        },
      }).map(({ path }) => path),
    ).toContain('identity child.receipt.idempotencyKey');
    // A child under an authority the reference's has none of.
    expect(
      delegationPlacementDifferences(
        reference,
        {
          ...candidate,
          child: { ...candidate.child, authorityId: 'web-core' },
        },
        { samePlacement: true },
      ).map(({ path }) => path),
    ).toContain('identity child.authorityId');
  });

  it('reports timestamps out of their order, whatever the clock', () => {
    const candidate = remote();
    expect(
      delegationPlacementDifferences(reference, {
        ...candidate,
        delegation: {
          ...candidate.delegation,
          updatedAt: '2026-11-11T08:00:00.000Z',
        },
      }).map(({ path }) => path),
    ).toEqual(
      expect.arrayContaining([
        'timeline delegation.createdAt<=updatedAt',
        'timeline delegation.settledAt<=updatedAt',
      ]),
    );
    expect(
      delegationPlacementDifferences(reference, {
        ...candidate,
        child: {
          ...candidate.child,
          receipt: {
            ...candidate.child.receipt,
            acceptedAt: '2026-11-11T10:00:00.000Z',
          },
        },
      }).map(({ path }) => path),
    ).toEqual(
      expect.arrayContaining([
        'timeline child.receipt.acceptedAt<=child.createdAt',
        'timeline child.receipt.acceptedAt<=delegation.createdAt',
      ]),
    );
  });

  it('reports a child that completed before its dispatch, or was updated before it completed', () => {
    const candidate = remote();
    expect(
      delegationPlacementDifferences(reference, {
        ...candidate,
        child: { ...candidate.child, completedAt: '2026-11-11T09:00:02.500Z' },
      }).map(({ path }) => path),
    ).toContain('timeline delegation.dispatchedAt<=child.completedAt');
    expect(
      delegationPlacementDifferences(reference, {
        ...candidate,
        child: { ...candidate.child, updatedAt: '2026-11-11T09:00:04.000Z' },
      }).map(({ path }) => path),
    ).toContain('timeline child.completedAt<=updatedAt');
  });

  it('holds every placement to its own target', () => {
    const candidate = remote();
    const paths = delegationPlacementDifferences(reference, {
      ...candidate,
      lease: { ...candidate.lease, binding: 'local', expiresAt: null },
      delegation: {
        ...candidate.delegation,
        activation: {
          ...candidate.delegation.activation,
          delivery: 'sealed-reference',
        },
      },
    }).map(({ path }) => path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'rule lease.binding is the target binding',
        'rule delegation.activation.delivery is the target delivery',
        'rule a lease expires exactly when it has a TTL',
      ]),
    );
  });
});
