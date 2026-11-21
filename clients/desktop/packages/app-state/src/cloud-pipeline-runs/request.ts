import {
  isUnknownKeyedWriteOutcome,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import {
  CoreCoworkRequestError,
  type CoreCoworkInvoker,
} from '../core-cowork/invoker';

export interface ReplySchema<Result> {
  safeParse(
    value: unknown,
  ): { success: true; data: Result } | { success: false };
}

const INVALID_REPLY: CanopyErrorPayload = {
  kind: 'internal',
  message: 'The cloud sent a reply this app cannot read.',
  retry: { kind: 'never' },
};

/**
 * A reply the web core sent after the call was dispatched but this app can't
 * read: the call may have been applied.
 */
export class CloudReplyUnreadableError extends CoreCoworkRequestError {
  constructor() {
    super(INVALID_REPLY);
  }
}

/** One web core call; a refusal or an unreadable reply rejects with its payload. */
export async function requestCloud<Result>(
  invoker: CoreCoworkInvoker,
  method: string,
  params: Record<string, unknown>,
  schema: ReplySchema<Result>,
): Promise<Result> {
  const reply = await invoker.request(method, params);
  if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
  const parsed = schema.safeParse(reply.value);
  if (!parsed.success) throw new CloudReplyUnreadableError();
  return parsed.data;
}

/** A failure as the payload the web core sent, or a generic one. */
export function cloudErrorOf(error: unknown): CanopyErrorPayload {
  if (error instanceof CoreCoworkRequestError) return error.payload;
  return {
    kind: 'unavailable',
    message: error instanceof Error ? error.message : String(error),
    retry: { kind: 'same_request' },
  };
}

/**
 * Whether a keyed call that failed may have been applied (CAN-7196): no reply
 * came, the reply couldn't be read, or the web core's answer says so.
 */
export function isOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof CoreCoworkRequestError)) return true;
  if (error instanceof CloudReplyUnreadableError) return true;
  return isUnknownKeyedWriteOutcome(error.payload);
}
