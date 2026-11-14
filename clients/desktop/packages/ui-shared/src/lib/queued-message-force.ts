import type {
  ChatTurnPhase,
  QueuedMessageRetryBlockedReason,
  QueuedMessageWaitingReason,
} from '@canopy/protocol/portal';

/** The desktop queue marks every row behind its credit hold as retryable. */
export function isCreditHeldQueuedMessage(row: {
  readonly retryable?: boolean;
  readonly retryBlockedReason?: QueuedMessageRetryBlockedReason;
}): boolean {
  return (
    row.retryable === true || row.retryBlockedReason === 'insufficient_credits'
  );
}

/** What a queued row's force action means; each maps to one strip callback. */
export type QueuedMessageForceKind = 'interrupt' | 'retry' | 'run-now';

/**
 * What a queued row's force action means, so every host maps it to the same
 * action-strip callback. An explicitly blocked row resolves to retry before
 * considering turn or background work state. Callers must enforce its block.
 * A row the host holds for background work runs now:
 * forcing it sends it with the chat's current settings and leaves the work
 * running, so it is neither a retry nor an interrupt. A failed or uncertain
 * delivery retries. So does any row still queued while no foreground turn
 * runs: nothing is left to interrupt, so forcing it sends it. Otherwise the
 * force action interrupts the running turn, including for an older host that
 * reports no phase.
 */
export function queuedMessageForceKind(row: {
  readonly turnPhase?: ChatTurnPhase;
  readonly retryable?: boolean;
  readonly retryBlockedReason?: QueuedMessageRetryBlockedReason;
  readonly waitingReason?: QueuedMessageWaitingReason;
}): QueuedMessageForceKind {
  if (row.retryBlockedReason !== undefined) return 'retry';
  if (row.waitingReason === 'background_work') return 'run-now';
  if (row.retryable === true) return 'retry';
  return row.turnPhase === 'idle' || row.turnPhase === 'background'
    ? 'retry'
    : 'interrupt';
}
