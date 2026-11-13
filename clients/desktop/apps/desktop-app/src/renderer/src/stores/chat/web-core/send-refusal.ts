import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';

/** The kinds with which the web core turns a send away before posting it. */
const REFUSAL_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'invalid_argument',
  'unauthenticated',
  'permission_denied',
  'not_found',
  'already_exists',
  'conflict',
  'failed_precondition',
  'capability_unavailable',
  'resource_exhausted',
]);

/**
 * A cloud send the web core refused outright, with no retry: nothing was
 * posted, so the composer may take the message back (CAN-6364). A send whose
 * outcome is unknown, such as one that timed out and whose receipt could not
 * be read, is never one.
 */
export class WebCoreSendRefusedError extends CoreCoworkRequestError {}

/** The error a send the web core answered with `payload`, and no retry, throws. */
export function sendFailure(
  payload: CanopyErrorPayload,
): CoreCoworkRequestError {
  return REFUSAL_KINDS.has(payload.kind)
    ? new WebCoreSendRefusedError(payload)
    : new CoreCoworkRequestError(payload);
}
