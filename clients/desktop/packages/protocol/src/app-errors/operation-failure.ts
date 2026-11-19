import { z } from 'zod';
import { CanopyErrorKindSchema } from '../canopy-core/errors';
import { CanopyOperationCodeSchema } from '../canopy-core/names';
import { APP_ERROR_OPERATION_CODES } from './operation-code-allowlist';

export const AppErrorOperationFailureSchema = z
  .object({
    status: CanopyErrorKindSchema,
    code: z
      .unknown()
      .refine((value) => typeof value === 'string' && value.length <= 128)
      .pipe(CanopyOperationCodeSchema)
      .refine((code) => APP_ERROR_OPERATION_CODES.has(code))
      .optional(),
  })
  .strict();

export type AppErrorOperationFailure = z.infer<
  typeof AppErrorOperationFailureSchema
>;

/** Project only telemetry fields from a larger operation failure. */
export function normalizeAppErrorOperationFailure(
  value: unknown,
): AppErrorOperationFailure | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const status = CanopyErrorKindSchema.safeParse(
      Reflect.get(value, 'status'),
    );
    if (!status.success) return undefined;
    try {
      const code = AppErrorOperationFailureSchema.shape.code.safeParse(
        Reflect.get(value, 'code'),
      );
      if (code.success && code.data !== undefined)
        return { status: status.data, code: code.data };
    } catch {
      // An unreadable code must not discard a valid status.
    }
    return { status: status.data };
  } catch {
    return undefined;
  }
}
