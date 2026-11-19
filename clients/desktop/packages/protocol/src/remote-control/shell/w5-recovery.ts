import { z } from 'zod';

export const W5RecoveryReasonSchema = z.enum([
  'invalid-request',
  'writer-active',
  'runtime-unavailable',
  'identity-unprovable',
  'claim-held',
  'claim-ambiguous',
  'endpoint-unavailable',
  'claim-lost',
  'release-uncertain',
  'writer-exit-unconfirmed',
  'recovery-required',
  'host-active',
  'cohort-ambiguous',
  'platform-unsupported',
  'log-unavailable',
  'operation-excluded',
  'launch-recovery-pending',
  'invalid-state',
  'cli-active',
  'peer_held',
  'replacement-daemon',
  'exposure-gated',
  'history-unproven',
  'request-unavailable',
  'result-unavailable',
  'source-unavailable',
  'unsaved-changes',
  'cancelled',
  'unexpected',
]);
export type W5RecoveryReason = z.infer<typeof W5RecoveryReasonSchema>;
export const W5RecoveryEntrySchema = z.strictObject({
  id: z.string().max(256),
  operation: z.string().max(256),
  detail: z.string().max(2000),
});
export type W5RecoveryEntry = z.infer<typeof W5RecoveryEntrySchema>;

/** Native recovery status; Portal projects it read-only, never as authority. */
export const W5RecoveryStatusSchema = z.strictObject({
  state: z.enum([
    'hidden',
    'blocked',
    'restart-required',
    'refused',
    'complete',
  ]),
  canRecover: z.boolean(),
  reason: W5RecoveryReasonSchema.optional(),
  entries: z.array(W5RecoveryEntrySchema).max(200),
});
export type W5RecoveryStatus = z.infer<typeof W5RecoveryStatusSchema>;
export interface W5RecoveryApi {
  getStatus(): Promise<W5RecoveryStatus>;
  /** Queues diagnosis for the next launch, not an authorization to release a key. */
  prepare(): Promise<W5RecoveryStatus>;
}

/**
 * Reservation diagnostics are same-host opaque text, never Portal content.
 * `canRecover` stays as guidance about the target's startup recovery; Portal
 * offers no action, and preparation is local-principal only.
 */
export function projectRemoteW5Recovery(
  status: W5RecoveryStatus,
): W5RecoveryStatus {
  return {
    ...status,
    entries: status.entries.map(({ id, operation }) => ({
      id,
      operation,
      detail:
        status.reason ??
        (status.state === 'blocked' ? 'recovery-required' : status.state),
    })),
  };
}
