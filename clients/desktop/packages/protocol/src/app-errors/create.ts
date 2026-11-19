import { z } from 'zod';
import {
  getAppErrorDefinition,
  isAppErrorCode,
  type AppErrorCode,
} from './catalog';
import {
  readErrorClassification,
  type ErrorClassification,
} from './classification';
import { isAppCancellation } from './cancellation';
import { IPC_RESTORED_APP_ERROR, safeErrorProperty } from './ipc-rejection';
import {
  AppErrorCopySchema,
  AppErrorDetailSchema,
  AppErrorErrnoSchema,
  AppErrorIdentifierSchema,
  AppErrorTimestampSchema,
} from './primitives';
import { createErrorReferenceId, type ErrorRandomBytes } from './reference-id';
import { AppErrorSchema, type AppError } from './types';

const OptionsSchema = z
  .object({
    copy: AppErrorCopySchema.optional(),
    detail: AppErrorDetailSchema.partial().strict().optional(),
    source: AppErrorIdentifierSchema.optional(),
    retryAt: AppErrorTimestampSchema.optional(),
  })
  .strict();

export type CreateAppErrorOptions = z.infer<typeof OptionsSchema> & {
  clock?: () => number;
  randomBytes?: ErrorRandomBytes;
};
export type ToAppErrorOptions = Pick<
  CreateAppErrorOptions,
  'clock' | 'randomBytes'
> & { signal?: AbortSignal };

export function createAppError(
  code: AppErrorCode,
  options: CreateAppErrorOptions = {},
): AppError {
  const { clock = Date.now, randomBytes, ...input } = options;
  const parsed = OptionsSchema.parse(input);
  const definition = getAppErrorDefinition(code);
  if (parsed.copy && definition.kind !== 'input')
    throw new TypeError('Only input errors accept copy overrides');
  return AppErrorSchema.parse({
    code,
    kind: definition.kind,
    ...(definition.recovery === undefined
      ? {}
      : { recovery: definition.recovery }),
    referenceId: createErrorReferenceId(randomBytes),
    occurredAt: clock(),
    copy: parsed.copy ?? definition.copy,
    detail: {
      message: definition.summary,
      ...(definition.status === undefined ? {} : { status: definition.status }),
      ...parsed.detail,
    },
    ...(parsed.source === undefined ? {} : { source: parsed.source }),
    ...(parsed.retryAt === undefined ? {} : { retryAt: parsed.retryAt }),
  });
}

function classify(
  value: unknown,
  options: ToAppErrorOptions,
): AppError | undefined {
  if (isAppCancellation(value)) return undefined;
  if (options.signal?.aborted && options.signal.reason === value)
    return undefined;
  const restored = restoredIpcAppError(value);
  if (restored) return restored;
  const appErrorLike =
    typeof value === 'object' &&
    value !== null &&
    ['kind', 'referenceId', 'recordedBy', 'occurredAt', 'copy', 'detail'].some(
      (key) => key in value,
    );
  let parsed: ReturnType<typeof AppErrorSchema.safeParse>;
  try {
    parsed = AppErrorSchema.safeParse(value);
  } catch {
    return createAppError('app.unexpected', {
      ...optionsForCreation(options),
      detail: appErrorLike
        ? { name: 'AppErrorValidation', message: 'Invalid app error payload' }
        : { message: 'Unrecognized error value' },
    });
  }
  if (parsed.success) return parsed.data;
  if (appErrorLike) {
    return createAppError('app.unexpected', {
      ...optionsForCreation(options),
      detail: {
        name: 'AppErrorValidation',
        message: 'Invalid app error payload',
      },
    });
  }
  if (value instanceof Error) {
    const classification = readErrorClassification(
      value,
      isUsableClassification,
    );
    return createAppError(classification?.code ?? 'app.unexpected', {
      ...optionsForCreation(options),
      ...(classification
        ? {
            source: classification.source,
            copy: classification.copy,
            retryAt:
              classification.retryAt === undefined
                ? undefined
                : Math.round(classification.retryAt),
          }
        : {}),
      detail: {
        ...errnoDetail(value),
        name:
          typeof value.name === 'string' ? value.name.slice(0, 128) : 'Error',
        message:
          typeof value.message === 'string'
            ? value.message.slice(0, 4096)
            : 'Unrecognized error value',
        ...(typeof value.stack === 'string'
          ? { stack: value.stack.slice(0, 32768) }
          : {}),
      },
    });
  }
  return createAppError('app.unexpected', {
    ...optionsForCreation(options),
    detail: { message: 'Unrecognized error value' },
  });
}

/** The shape main recorded for a restored IPC rejection, under its reference.
 * An invalid or unreadable value falls back to ordinary classification. */
function restoredIpcAppError(value: unknown): AppError | undefined {
  const carried = safeErrorProperty(value, IPC_RESTORED_APP_ERROR);
  if (carried === undefined) return undefined;
  try {
    const parsed = AppErrorSchema.safeParse(carried);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A system code only when it matches the allowlist; the getter may throw. */
function errnoDetail(value: Error): { errno?: string } {
  try {
    const errno = AppErrorErrnoSchema.safeParse(Reflect.get(value, 'code'));
    return errno.success ? { errno: errno.data } : {};
  } catch {
    return {};
  }
}

function optionsForCreation(
  options: ToAppErrorOptions,
): Pick<CreateAppErrorOptions, 'clock' | 'randomBytes'> {
  return { clock: options.clock, randomBytes: options.randomBytes };
}

export function toAppError(
  value: unknown,
  options: ToAppErrorOptions = {},
): AppError | undefined {
  // Only inspection is untrusted. Invalid configuration/clock/crypto may throw.
  try {
    return classify(value, options);
  } catch {
    return createAppError('app.unexpected', {
      ...optionsForCreation(options),
      detail: { message: 'Unrecognized error value' },
    });
  }
}

function isUsableClassification(value: unknown): value is ErrorClassification {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('code' in value) ||
    !isAppErrorCode(value.code)
  )
    return false;
  const { code, ...options } = value;
  const parsed = OptionsSchema.safeParse({
    ...options,
    ...('retryAt' in options && typeof options.retryAt === 'number'
      ? { retryAt: Math.round(options.retryAt) }
      : {}),
  });
  return (
    parsed.success &&
    (parsed.data.copy === undefined || code === 'input.not_accepted') &&
    (parsed.data.retryAt === undefined ||
      (code === 'external.rate_limited' && parsed.data.retryAt > 0))
  );
}
