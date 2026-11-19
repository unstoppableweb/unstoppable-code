import { z } from 'zod';
import { CanopyErrorKindSchema } from '../canopy-core/errors';

/** Machine advice only: never carry operation diagnostics or refresh resources. */
export const RemoteOperationFailureSchema = z.object({
  status: CanopyErrorKindSchema,
  retry: z.object({
    kind: z.enum([
      'never',
      'same_request',
      'same_idempotency_key',
      'after_refresh',
    ]),
    delayMs: z.number().int().nonnegative().max(86_400_000).optional(),
  }),
});

export type RemoteOperationFailure = z.output<
  typeof RemoteOperationFailureSchema
>;

/** Untrusted thrown values may have accessors; invalid advice is omitted. */
export function readRemoteOperationFailure(
  error: unknown,
): RemoteOperationFailure | undefined {
  try {
    if (typeof error !== 'object' || error === null) return undefined;
    const parsed = RemoteOperationFailureSchema.safeParse(
      Reflect.get(error, 'operationFailure'),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
