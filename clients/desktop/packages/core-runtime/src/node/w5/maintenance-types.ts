import type { W5Diagnosis } from './maintenance-diagnosis';
import type {
  W5MaintenanceDecision,
  W5MaintenanceDecisionResult,
  W5MaintenanceDecisionRefusal,
} from './maintenance-decisions';
export type W5MaintenanceRefusal =
  | 'invalid-request'
  | 'writer-active'
  | 'runtime-unavailable'
  | 'identity-unprovable'
  | 'claim-held'
  | 'claim-ambiguous'
  | 'endpoint-unavailable'
  | 'claim-lost'
  | 'release-uncertain'
  | 'writer-exit-unconfirmed'
  | 'recovery-required'
  /** A registered legacy W5 host (Electron main, CLI, create-worktree child) is live or unprovable. */
  | 'host-active'
  /** An earlier maintenance record or the host list is unprovable. */
  | 'cohort-ambiguous'
  /** Windows has no host registration yet (deferred until Windows maintenance qualification). */
  | 'platform-unsupported'
  | W5MaintenanceDecisionRefusal;

export class W5MaintenanceRefusedError extends Error {
  constructor(
    readonly reason: W5MaintenanceRefusal,
    readonly operationError?: unknown,
    /** Index of the refused resolve decision, when one decision is the cause. */
    readonly decision?: number,
  ) {
    super(`W5 maintenance refused (${reason}).`);
    this.name = 'W5MaintenanceRefusedError';
  }
}

/**
 * A resolve that failed once decisions could run. `results` took effect.
 * `failure` stopped `decisions[results.length]`, whose own outcome may be
 * unknown, or followed every decision (writer shutdown or post-diagnosis)
 * when all have results.
 */
export class W5MaintenanceDecisionError extends Error {
  constructor(
    readonly results: readonly W5MaintenanceDecisionResult[],
    readonly failure: unknown,
    /**
     * After a stopped decision: taken once the writer exited, still under the
     * claim and record. Absent when aborted or when it could not be taken.
     */
    readonly diagnosis?: W5Diagnosis,
  ) {
    super('W5 maintenance stopped while applying resolve decisions.');
    this.name = 'W5MaintenanceDecisionError';
  }
}

export type W5MaintenanceRequest = {
  readonly source: 'offline_maintenance';
} & (
  | { readonly mode: 'diagnose' }
  | { readonly mode: 'reopen' }
  | {
      readonly mode: 'restore';
      readonly backupPath: string;
      readonly unreadableOverride?: string;
    }
  | {
      readonly mode: 'resolve';
      readonly decisions: readonly W5MaintenanceDecision[];
    }
);
export type W5MaintenanceResult =
  | { readonly mode: 'diagnose'; readonly diagnosis: W5Diagnosis }
  | { readonly mode: 'reopen'; readonly diagnosis: W5Diagnosis }
  | { readonly mode: 'restore'; readonly commitId: number }
  | {
      readonly mode: 'resolve';
      readonly results: readonly W5MaintenanceDecisionResult[];
      /** Taken after the writer exited, still under the claim and record. */
      readonly diagnosis: W5Diagnosis;
    };

export type {
  W5MaintenanceDecision,
  W5MaintenanceDecisionResult,
} from './maintenance-decisions';
