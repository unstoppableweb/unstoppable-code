import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
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
  if (!parsed.success) throw new CoreCoworkRequestError(INVALID_REPLY);
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
