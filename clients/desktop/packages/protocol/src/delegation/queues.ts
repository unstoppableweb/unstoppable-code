/** Identifier of the only supported delegation queue in this release. */
export const DEFAULT_DELEGATION_QUEUE_ID = 'default';

/** Lifecycle phases reported for delegated work. */
export const AGENT_DELEGATION_PHASES = [
  'queued',
  'starting',
  'running',
  'idle',
] as const;

/** A managed delegation lifecycle phase. */
export type AgentDelegationPhase = (typeof AGENT_DELEGATION_PHASES)[number];

/** Admission behavior to apply when delegation capacity is busy. */
export const DELEGATION_IF_BUSY_VALUES = ['queue', 'reject'] as const;

/** Admission behavior to apply when delegation capacity is busy. */
export type DelegationIfBusy = (typeof DELEGATION_IF_BUSY_VALUES)[number];

/**
 * Live status for the default queue. Live values are tool responses only,
 * never persisted in transcripts.
 */
export interface AgentDelegationQueueState {
  /** Queue identifier; `default` is the only identifier in this release. */
  readonly id: string;
  /** Human-readable queue name, bounded to 64 characters. */
  readonly name: string;
  /** This work's 1-based position while queued. */
  readonly position?: number;
  /** Live tool-response value: what this work is waiting for. */
  readonly waitingFor?: 'queue' | 'app';
  /** Live tool-response value: number of currently running delegations. */
  readonly running?: number;
  /** Live tool-response value: number of delegations waiting. */
  readonly waiting?: number;
  /** Live tool-response value: maximum concurrent delegations. */
  readonly limit?: number;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Checks whether a value names one of the supported delegation phases. */
export function isAgentDelegationPhase(
  value: unknown,
): value is AgentDelegationPhase {
  return (
    typeof value === 'string' &&
    AGENT_DELEGATION_PHASES.some((phase) => phase === value)
  );
}

/** Validates a queue state and tolerates unknown future fields. */
export function isAgentDelegationQueueState(
  value: unknown,
): value is AgentDelegationQueueState {
  return (
    plainRecord(value) &&
    nonEmptyText(value.id, 256) &&
    nonEmptyText(value.name, 64) &&
    (value.position === undefined || isPositiveSafeInteger(value.position)) &&
    (value.waitingFor === undefined ||
      value.waitingFor === 'queue' ||
      value.waitingFor === 'app') &&
    (value.running === undefined || isNonNegativeSafeInteger(value.running)) &&
    (value.waiting === undefined || isNonNegativeSafeInteger(value.waiting)) &&
    (value.limit === undefined || isPositiveSafeInteger(value.limit))
  );
}
