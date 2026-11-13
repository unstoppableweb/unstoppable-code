import type { OperationRecord } from '../operation/schemas';
import type {
  DelegationLeaseRecord,
  DelegationRecord,
  ExecutionTargetRecord,
} from './records';

/*
 * The field-for-field equality check of delegation and placement records
 * (ADR 23; CAN-6214, plan CP-21). One unit of work placed on two execution
 * targets, such as a pipeline run on desktop's in-process worker and on a
 * cloud runner, or the daemon's bundled worker and its split worker
 * (CAN-5098), must be recorded identically except for what the placement
 * itself decides:
 *
 * - Identifiers and timestamps are compared by shape: every link between
 *   records the reference holds holds in the candidate too (the
 *   delegation's lease, target, parent, child and root, the executor key
 *   that is the delegation's id, the child's delegation and execution id),
 *   every identifier is present or absent alike, and every timestamp is
 *   present or absent alike and in the same order.
 * - The target's descriptors and the lease terms may differ, but must agree
 *   with each other: the lease's binding is the target's, the activation is
 *   delivered as the target delivers it, a lease with a TTL expires and one
 *   without never does, and only a lease that is granted again carries an
 *   epoch.
 * - Every other field, and the set of fields each record has, is equal.
 *
 * `delegationPlacementDifferences` lists every difference; none means the
 * records are equal. `samePlacement` also compares the placement fields, for
 * two records of one target, such as a golden against its reference.
 */

/** The records one dispatch leaves: its target, delegation, lease and child. */
export interface DelegationPlacementRecords {
  readonly target: ExecutionTargetRecord;
  readonly delegation: DelegationRecord;
  readonly lease: DelegationLeaseRecord;
  /** The child operation the delegation runs. */
  readonly child: OperationRecord;
}

export interface DelegationPlacementDifference {
  /** The field, as `record.path`, such as `delegation.operation.name`. */
  readonly path: string;
  readonly reference: unknown;
  readonly candidate: unknown;
}

type RecordName = 'target' | 'delegation' | 'lease' | 'child';

/** Fields the placement decides, by record. */
const PLACEMENT_FIELDS: Readonly<Record<RecordName, ReadonlySet<string>>> = {
  target: new Set([
    'targetId',
    'catalogKind',
    'profile',
    'leaseBinding',
    'activationDelivery',
  ]),
  lease: new Set([
    'targetId',
    'binding',
    'signal',
    'renewAfterMs',
    'ttlMs',
    // Follow the terms: expiry with a TTL; an epoch and its last renewal
    // only on a lease that is granted again (ADR 31).
    'expiresAt',
    'leaseEpoch',
    'lastRenewal',
  ]),
  delegation: new Set(['targetId', 'activation.delivery']),
  child: new Set(['executionTargetId', 'scope.targetId']),
};

/** Fields compared by the records they name, never by value. */
const IDENTITY_FIELDS: Readonly<Record<RecordName, ReadonlySet<string>>> = {
  target: new Set(),
  lease: new Set(['leaseId', 'runEpoch']),
  delegation: new Set([
    'delegationId',
    'parentOperationId',
    'childOperationId',
    'rootOperationId',
    'leaseId',
    'executorKey',
    'idempotencyKey',
    'activation.digest',
  ]),
  child: new Set([
    'operationId',
    'parentOperationId',
    'rootOperationId',
    'authorityId',
    'runtimeDelegationId',
    'origin.sourceId',
    'receipt.idempotencyKey',
    'scope.executionId',
    'owner.id',
  ]),
};

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The records of a dispatch, by name, in a fixed order. */
function parts(
  records: DelegationPlacementRecords,
): ReadonlyArray<readonly [RecordName, unknown]> {
  return [
    ['target', records.target],
    ['delegation', records.delegation],
    ['lease', records.lease],
    ['child', childPlacement(records.child)],
  ];
}

/**
 * The child operation as placement records it: where it runs, what placed
 * it, for whom and how far it got. Its revision count and outcome are its
 * domain's, not its placement's.
 */
function childPlacement(child: OperationRecord): Record<string, unknown> {
  return {
    operationId: child.operationId,
    kind: child.kind,
    status: child.status,
    parentOperationId: child.parentOperationId,
    rootOperationId: child.rootOperationId,
    authorityId: child.authorityId,
    executionTargetId: child.executionTargetId,
    runtimeDelegationId: child.runtimeDelegationId,
    scope: child.scope,
    origin: child.origin,
    owner: child.owner,
    receipt: child.receipt,
    createdAt: child.createdAt,
    completedAt: child.completedAt,
    hasOutcome: child.outcome !== null,
    error: child.error,
    cancellation: child.cancellation,
  };
}

/** Every leaf of a record by its dotted path; arrays are leaves. */
function leaves(
  value: unknown,
  prefix = '',
  into = new Map<string, unknown>(),
): Map<string, unknown> {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const [key, entry] of Object.entries(value))
      leaves(entry, prefix === '' ? key : `${prefix}.${key}`, into);
    return into;
  }
  into.set(prefix, value);
  return into;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Each identifier field's value, by `record.field`. */
function identifiers(
  records: DelegationPlacementRecords,
): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [record, value] of parts(records)) {
    const fields = leaves(value);
    for (const field of IDENTITY_FIELDS[record])
      values.set(`${record}.${field}`, fields.get(field) ?? null);
  }
  values.set('target.targetId', records.target.targetId);
  values.set('delegation.targetId', records.delegation.targetId);
  values.set('lease.targetId', records.lease.targetId);
  values.set('child.executionTargetId', records.child.executionTargetId);
  values.set('child.scope.targetId', records.child.scope.targetId ?? null);
  values.set('delegation.operation.name', records.delegation.operation.name);
  values.set('child.kind', records.child.kind);
  return values;
}

/**
 * The links between identifiers that the reference holds, and that the
 * candidate breaks: two fields naming the same record, such as the
 * delegation's lease and the lease, must name the same record in both, and
 * a field absent in one is absent in the other. Identifiers are opaque, so
 * two fields that happen to hold the same value in the candidate only, such
 * as a cloud run whose execution id is its operation id, are no difference.
 */
function brokenLinks(
  reference: DelegationPlacementRecords,
  candidate: DelegationPlacementRecords,
): DelegationPlacementDifference[] {
  const left = identifiers(reference);
  const right = identifiers(candidate);
  const broken: DelegationPlacementDifference[] = [];
  const fields = [...left.keys()];
  for (const field of fields)
    if ((left.get(field) === null) !== (right.get(field) === null))
      broken.push({
        path: `identity ${field}`,
        reference: left.get(field),
        candidate: right.get(field),
      });
  fields.forEach((field, index) => {
    for (const other of fields.slice(index + 1)) {
      const linked =
        left.get(field) !== null && left.get(field) === left.get(other);
      if (linked && right.get(field) !== right.get(other))
        broken.push({
          path: `identity ${field}=${other}`,
          reference: true,
          candidate: false,
        });
    }
  });
  return broken;
}

/** The placement fields' own consistency, which every placement must keep. */
function placementRules(
  records: DelegationPlacementRecords,
): Map<string, boolean> {
  const { target, lease, delegation } = records;
  return new Map([
    [
      'lease.binding is the target binding',
      lease.binding === target.leaseBinding,
    ],
    [
      'delegation.activation.delivery is the target delivery',
      delegation.activation.delivery === target.activationDelivery,
    ],
    [
      'a lease expires exactly when it has a TTL',
      (lease.ttlMs === null) === (lease.expiresAt === null),
    ],
    [
      'a lease renews exactly when it has a TTL',
      (lease.ttlMs === null) === (lease.renewAfterMs === null),
    ],
    [
      'only a lease with an epoch is renewed',
      lease.lastRenewal === undefined ||
        lease.lastRenewal === null ||
        lease.leaseEpoch !== undefined,
    ],
  ]);
}

/** Timestamps present, absent and ordered alike. */
function timeline(records: DelegationPlacementRecords): Map<string, string> {
  const { delegation, lease, child, target } = records;
  const at = (value: string | null): number | null =>
    value === null ? null : Date.parse(value);
  const order = (earlier: string | null, later: string | null): string => {
    const from = at(earlier);
    const to = at(later);
    return from === null || to === null ? 'n/a' : String(from <= to);
  };
  return new Map([
    [
      'target.registeredAt<=lease.acquiredAt',
      order(target.registeredAt, lease.acquiredAt),
    ],
    [
      'delegation.createdAt<=dispatchedAt',
      order(delegation.createdAt, delegation.dispatchedAt),
    ],
    [
      'delegation.dispatchedAt<=settledAt',
      order(delegation.dispatchedAt, delegation.settledAt),
    ],
    [
      'child.createdAt<=delegation.createdAt',
      order(child.createdAt, delegation.createdAt),
    ],
    ['child.createdAt<=completedAt', order(child.createdAt, child.completedAt)],
    ['lease.acquiredAt<=releasedAt', order(lease.acquiredAt, lease.releasedAt)],
    [
      'delegation.createdAt<=updatedAt',
      order(delegation.createdAt, delegation.updatedAt),
    ],
    [
      'delegation.settledAt<=updatedAt',
      order(delegation.settledAt, delegation.updatedAt),
    ],
    [
      'child.receipt.acceptedAt<=child.createdAt',
      order(child.receipt.acceptedAt, child.createdAt),
    ],
    [
      'child.receipt.acceptedAt<=delegation.createdAt',
      order(child.receipt.acceptedAt, delegation.createdAt),
    ],
    ['child.createdAt<=updatedAt', order(child.createdAt, child.updatedAt)],
    [
      'delegation.dispatchedAt<=child.completedAt',
      order(delegation.dispatchedAt, child.completedAt),
    ],
    ['child.completedAt<=updatedAt', order(child.completedAt, child.updatedAt)],
  ]);
}

/**
 * Every difference between two dispatches' records; none means they are
 * equal field for field. `reference` is the placement the candidate must
 * match, such as desktop's in-process worker.
 */
export function delegationPlacementDifferences(
  reference: DelegationPlacementRecords,
  candidate: DelegationPlacementRecords,
  options: { readonly samePlacement?: boolean } = {},
): DelegationPlacementDifference[] {
  const differences: DelegationPlacementDifference[] = [];
  const differ = (path: string, left: unknown, right: unknown): void => {
    differences.push({ path, reference: left, candidate: right });
  };
  const candidates = new Map(parts(candidate));
  for (const [record, value] of parts(reference)) {
    const left = leaves(value);
    const right = leaves(candidates.get(record));
    const identity = IDENTITY_FIELDS[record];
    const placed = (path: string): boolean =>
      options.samePlacement !== true &&
      [...PLACEMENT_FIELDS[record]].some(
        (field) => path === field || path.startsWith(`${field}.`),
      );
    for (const path of new Set([...left.keys(), ...right.keys()])) {
      if (placed(path)) continue;
      const at = `${record}.${path}`;
      if (!left.has(path) || !right.has(path)) {
        differ(at, left.get(path), right.get(path));
        continue;
      }
      const leftValue = left.get(path);
      const rightValue = right.get(path);
      if (identity.has(path)) continue;
      if (
        typeof leftValue === 'string' &&
        typeof rightValue === 'string' &&
        TIMESTAMP.test(leftValue) &&
        TIMESTAMP.test(rightValue)
      )
        continue;
      if (!sameValue(leftValue, rightValue)) differ(at, leftValue, rightValue);
    }
  }
  differences.push(...brokenLinks(reference, candidate));
  const leftTimes = timeline(reference);
  const rightTimes = timeline(candidate);
  for (const [order, value] of leftTimes)
    if (rightTimes.get(order) !== value)
      differ(`timeline ${order}`, value, rightTimes.get(order));
  for (const [rule, holds] of placementRules(candidate))
    if (!holds) differ(`rule ${rule}`, true, false);
  return differences;
}
