import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { CoreCoworkRequestError } from './invoker';
import { isUnknownKeyedWriteOutcome } from './keyed-write-outcome';

/** {@link isUnknownKeyedWriteOutcome} for a request the store made. */
export function isUnknownWriteError(error: unknown): boolean {
  return (
    error instanceof CoreCoworkRequestError &&
    isUnknownKeyedWriteOutcome(error.payload)
  );
}

/**
 * A write that may have landed and that a re-read couldn't settle; its
 * message says so, never that it failed (CAN-7196).
 */
export class CoreCoworkOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreCoworkOutcomeUnknownError';
  }
}

/**
 * Whether a queued entry's command was retried after Core forgot its first
 * attempt: the web core answers it as a revision conflict whose reason is
 * `retry_expired` (CAN-7196). The queue was read again; nothing was written.
 */
export function isQueueRetryExpired(payload: CanopyErrorPayload): boolean {
  const details: unknown = payload.details;
  return (
    payload.code === 'core.chat.revisionConflict' &&
    typeof details === 'object' &&
    details !== null &&
    Reflect.get(details, 'reason') === 'retry_expired'
  );
}
