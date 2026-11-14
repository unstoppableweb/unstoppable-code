import type { W5RecoveryRetryOutcome } from './commit-log/worker-contract';
import { isRecord } from './maintenance-guards';
import type { W5Diagnosis } from './maintenance-diagnosis';

/**
 * Operations whose key offline maintenance may release (RX2), by resolving a
 * recovery-required reservation or abandoning a commit holding its receipt:
 * the one-decision ("1D") boundaries built on `createW5SingleDecisionOperation`.
 * Their only effect is the decision that deletes the reservation, so a
 * reservation still present never took effect. Lifecycle and two-decision keys
 * stay terminal (A24-L(b)); an operation name alone is the proof, so a static
 * test keeps this list equal to the 1D call sites.
 */
export const W5_RESOLVABLE_RESERVATION_OPERATIONS: ReadonlySet<string> =
  new Set([
    'core.workspace.cowork.update',
    'core.workspace.hooks.update',
    'core.workspace.planDetection.update',
    'core.workspace.plugins.update',
    'core.workspace.privateMemory.update',
    'core.workspace.reorder',
    'core.workspace.repository.add',
    'core.workspace.repository.remove',
    'core.workspace.retention.update',
    'core.workspace.scripts.update',
    'core.workspace.update',
    'core.worktree.hooks.setPaused',
    'core.worktree.reorder',
    'core.worktree.update',
  ]);

/** One operator decision about a recovery-required reservation or commit. */
export type W5MaintenanceDecision =
  /** Free a 1D reservation's key; nothing is applied or compensated. */
  | { readonly kind: 'resolve-reservation'; readonly reservationId: string }
  /**
   * Files were restored: apply the commit again, once. Allowed for any
   * operation: it only rewrites the commit's W5 files and keeps its receipt,
   * so no key is released and no Git or host effect reruns.
   */
  | { readonly kind: 'retry-commit'; readonly commitId: number }
  /**
   * Keep the files: drop the commit and its receipt, keeping its revisions.
   * Unkeyed or 1D-keyed commits only; dropping another receipt would let its
   * key rerun a lifecycle's effects.
   */
  | { readonly kind: 'abandon-commit'; readonly commitId: number };

export type W5MaintenanceDecisionResult = {
  readonly decision: W5MaintenanceDecision;
  /** `recovery-required`: a retried commit still matches neither side. */
  readonly status: 'resolved' | 'abandoned' | 'applied' | 'recovery-required';
};

export type W5MaintenanceDecisionRefusal =
  | 'log-unavailable'
  | 'invalid-state'
  | 'operation-excluded'
  | 'launch-recovery-pending';

function readDecision(value: unknown): W5MaintenanceDecision | null {
  if (!isRecord(value)) return null;
  // Each field is read once, so a getter cannot change it after its check.
  const keys = Object.keys(value).sort().join();
  const { kind, reservationId, commitId } = value;
  if (kind === 'resolve-reservation')
    return keys === 'kind,reservationId' &&
      typeof reservationId === 'string' &&
      reservationId.length > 0
      ? Object.freeze({ kind, reservationId })
      : null;
  if (kind !== 'retry-commit' && kind !== 'abandon-commit') return null;
  return keys === 'commitId,kind' &&
    typeof commitId === 'number' &&
    Number.isSafeInteger(commitId) &&
    commitId > 0
    ? Object.freeze({ kind, commitId })
    : null;
}

function target(decision: W5MaintenanceDecision): string {
  return decision.kind === 'resolve-reservation'
    ? `reservation:${decision.reservationId}`
    : `commit:${decision.commitId}`;
}

/**
 * A frozen copy of a nonempty decision list naming each target once, or null
 * (also when reading it throws). Copied so the caller cannot change it after
 * validation.
 */
export function readW5MaintenanceDecisions(
  value: unknown,
): readonly W5MaintenanceDecision[] | null {
  try {
    if (!Array.isArray(value) || value.length === 0) return null;
    const decisions: W5MaintenanceDecision[] = [];
    const targets = new Set<string>();
    for (const item of value) {
      const decision = readDecision(item);
      if (!decision || targets.has(target(decision))) return null;
      targets.add(target(decision));
      decisions.push(decision);
    }
    return Object.freeze(decisions);
  } catch {
    return null;
  }
}

/**
 * The operations whose key a decision would release: a resolved reservation's,
 * or an abandoned commit's when it holds a receipt. Retrying releases none.
 */
function releasedOperations(
  decision: W5MaintenanceDecision,
  found: W5Diagnosis['reservations'][number] | W5Diagnosis['commits'][number],
): readonly string[] {
  if (!('receiptOperations' in found)) return [found.operation];
  if (
    decision.kind !== 'abandon-commit' ||
    found.receiptOperations.length === 0
  )
    return [];
  return [found.operation, ...found.receiptOperations];
}

/**
 * Checks every decision against the diagnosis taken under the held claim and
 * cohort record, before any writer starts. All or nothing: a refusal leaves
 * the log untouched. Any pending state refuses, because the cold host's
 * launch recovery would otherwise apply or block it on its first request.
 */
export function refuseW5MaintenanceDecisions(
  diagnosis: W5Diagnosis,
  decisions: readonly W5MaintenanceDecision[],
): {
  readonly reason: W5MaintenanceDecisionRefusal;
  readonly decision?: number;
} | null {
  if (diagnosis.logIssue) return { reason: 'log-unavailable' };
  const states: Array<{ readonly state: string }> = [];
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    if (!decision) return { reason: 'invalid-state', decision: index };
    const found =
      decision.kind === 'resolve-reservation'
        ? diagnosis.reservations.find(
            ({ reservationId }) => reservationId === decision.reservationId,
          )
        : diagnosis.commits.find(
            ({ commitId }) => commitId === decision.commitId,
          );
    if (!found) return { reason: 'invalid-state', decision: index };
    const released = releasedOperations(decision, found);
    if (
      released.some(
        (operation) => !W5_RESOLVABLE_RESERVATION_OPERATIONS.has(operation),
      )
    )
      return { reason: 'operation-excluded', decision: index };
    states.push(found);
  }
  if (
    diagnosis.reservations.some(({ state }) => state === 'reserved') ||
    diagnosis.commits.some(({ state }) => state === 'committed')
  )
    return { reason: 'launch-recovery-pending' };
  const index = states.findIndex(
    (found) => found.state !== 'recovery-required',
  );
  return index < 0 ? null : { reason: 'invalid-state', decision: index };
}

/** The cold `W5CommitLogHost`'s RX1 requests, without spelling their wire names. */
export interface W5MaintenanceDecisionHost {
  resolveRecovery(reservationId: string): Promise<void>;
  retryRecoveryRequiredCommit(
    commitId: number,
  ): Promise<W5RecoveryRetryOutcome>;
  abandonRecoveryRequiredCommit(commitId: number): Promise<void>;
}

/**
 * Runs checked decisions in order through the cold host's RX1 requests and
 * stops at the first failure, returning the results that took effect.
 * `beforeEach` re-proves exclusion before each request.
 */
export async function runW5MaintenanceDecisions(
  host: W5MaintenanceDecisionHost,
  decisions: readonly W5MaintenanceDecision[],
  beforeEach: () => Promise<void>,
): Promise<{
  readonly results: readonly W5MaintenanceDecisionResult[];
  readonly failure?: { readonly error: unknown };
}> {
  const results: W5MaintenanceDecisionResult[] = [];
  for (const decision of decisions) {
    try {
      await beforeEach();
      results.push({ decision, status: await run(host, decision) });
    } catch (error) {
      return { results, failure: { error } };
    }
  }
  return { results };
}

async function run(
  host: W5MaintenanceDecisionHost,
  decision: W5MaintenanceDecision,
): Promise<W5MaintenanceDecisionResult['status']> {
  switch (decision.kind) {
    case 'resolve-reservation':
      await host.resolveRecovery(decision.reservationId);
      return 'resolved';
    case 'abandon-commit':
      await host.abandonRecoveryRequiredCommit(decision.commitId);
      return 'abandoned';
    case 'retry-commit':
      return (await host.retryRecoveryRequiredCommit(decision.commitId)).status;
  }
}
