import {
  CanopyErrorPayloadSchema,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';

import { CanopyClientError } from './errors';

export const CANOPY_OUTCOME_UNKNOWN_MESSAGE = 'The outcome is unknown.';

/**
 * A keyed write whose reply was lost after it was sent: it may have completed.
 * Callers never show it as failed and never resend it; they show that the
 * outcome couldn't be confirmed and offer a check or refresh. On the wire it is
 * `unavailable` with retry `never`, so no protocol change carries it.
 */
export class CanopyOutcomeUnknownError extends CanopyClientError {
  public readonly outcome = 'outcome_unknown' as const;

  public constructor() {
    super({
      kind: 'unavailable',
      message: CANOPY_OUTCOME_UNKNOWN_MESSAGE,
      retry: { kind: 'never' },
    });
    this.name = 'CanopyOutcomeUnknownError';
  }
}

function isOutcomeUnknownPayload(payload: CanopyErrorPayload): boolean {
  return payload.kind === 'unavailable' && payload.retry.kind === 'never';
}

/**
 * Whether `value` is an unknown outcome: a client error, or the wire payload a
 * relay or web invoker flattens it to, of kind `unavailable` with retry `never`.
 * Only a schema-exact payload matches. Whether the call was a keyed write is
 * the caller's check.
 */
export function isCanopyOutcomeUnknown(value: unknown): boolean {
  if (value instanceof CanopyClientError)
    return isOutcomeUnknownPayload(value.payload);
  const parsed = CanopyErrorPayloadSchema.safeParse(value);
  return parsed.success && isOutcomeUnknownPayload(parsed.data);
}
