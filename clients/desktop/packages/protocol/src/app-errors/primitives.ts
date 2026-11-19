import { z } from 'zod';

export const AppErrorKindSchema = z.enum(['input', 'external', 'defect']);
export const AppErrorRecoverySchema = z.enum([
  'try_again',
  'start_over',
  'fix_first',
  'wait',
]);
export const AppErrorSurfaceSchema = z.enum([
  'inline',
  'toast',
  'banner',
  'panel',
  'window',
]);
export const AppErrorTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const AppErrorIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .refine((value) => value === value.trim());
export const AppErrorCopySchema = z
  .object({
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(1024).optional(),
  })
  .strict();
/** System error code (`EACCES`, `ERR_*`). Telemetry never coerces or truncates. */
export const AppErrorErrnoSchema = z
  .string()
  .max(64)
  .regex(/^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/);
const BUILT_IN_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'RangeError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
]);
/** Built-in names or a conventionally named product class; nothing else. */
export const AppErrorClassSchema = z
  .string()
  .refine(
    (value) =>
      BUILT_IN_ERROR_CLASSES.has(value) ||
      /^[A-Z][A-Za-z0-9]{1,62}(?:Error|Refusal)$/.test(value),
  );
export const AppErrorDetailSchema = z
  .object({
    name: z.string().max(128).optional(),
    message: z.string().max(4096),
    stack: z.string().max(32768).optional(),
    status: z
      .union([z.string().min(1).max(128), z.number().finite()])
      .optional(),
    operationCode: AppErrorIdentifierSchema.optional(),
    errno: AppErrorErrnoSchema.optional(),
  })
  .strict();
export type AppErrorKind = z.infer<typeof AppErrorKindSchema>;
export type AppErrorRecovery = z.infer<typeof AppErrorRecoverySchema>;
export type AppErrorSurface = z.infer<typeof AppErrorSurfaceSchema>;
export type AppErrorCopy = z.infer<typeof AppErrorCopySchema>;
export type AppErrorDetail = z.infer<typeof AppErrorDetailSchema>;
