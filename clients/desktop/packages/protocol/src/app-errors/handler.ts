import { z } from 'zod';
import {
  AppErrorOperationFailureSchema,
  normalizeAppErrorOperationFailure,
  type AppErrorOperationFailure,
} from './operation-failure';
import {
  appErrorNativeFrames,
  hasNativeErrorBrand,
  rememberAppErrorNativeFrames,
  rememberedAppErrorNativeFrames,
} from './native-frames';
import { toAppError, type ToAppErrorOptions } from './create';
import {
  AppErrorIdentifierSchema,
  AppErrorSurfaceSchema,
  AppErrorTimestampSchema,
  type AppErrorSurface,
} from './primitives';
import type { ErrorRandomBytes } from './reference-id';
import { AppErrorSchema, type AppError } from './types';

export interface AppErrorRecord {
  operationFailure?: AppErrorOperationFailure;
  error: AppError;
  disposition: 'recorded' | 'counted';
  occurrenceCount: number;
  isRepeatSummary: boolean;
  retryFixed: boolean;
  surface?: AppErrorSurface;
  appVersion: string;
}

export interface AppErrorReport {
  error: AppError;
  disposition: 'none' | AppErrorRecord['disposition'];
}

export type AppErrorSink = (record: AppErrorRecord) => void;
export interface AppErrorScheduler {
  /** Returns a cancellation function. Callbacks must run asynchronously. */
  schedule(callback: () => void, delayMs: number): () => void;
}

export type AppErrorThrownType =
  | 'undefined'
  | 'null'
  | 'boolean'
  | 'number'
  | 'bigint'
  | 'string'
  | 'symbol'
  | 'function'
  | 'object';

/** Classify the original throw before an adapter supplies a safe error value. */
export function getAppErrorThrownType(
  value: unknown,
): AppErrorThrownType | undefined {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return hasNativeErrorBrand(value) ? undefined : 'object';
}

function getDirectReportThrownType(
  value: unknown,
): AppErrorThrownType | undefined {
  const type = getAppErrorThrownType(value);
  if (type !== 'object') return type;
  try {
    // A preclassified report without an original throw has no thrown type.
    if (AppErrorSchema.safeParse(value).success) return undefined;
  } catch {
    // A malformed object still has no verified frames.
  }
  return type;
}

export interface AppErrorHandlerOptions {
  sinks: readonly AppErrorSink[];
  /** Trusted adapter only. First occurrences may include original native
   * frames. Sanitize them before any outbound use. */
  diagnosticSink?: (
    record: AppErrorRecord,
    frames: readonly string[],
    thrownType?: AppErrorThrownType,
  ) => void;
  host: string;
  appVersion: string;
  clock?: () => number;
  randomBytes?: ErrorRandomBytes;
  scheduler?: AppErrorScheduler;
  windowMs?: number;
  maxBuckets?: number;
}

export type AppErrorReportOptions = Pick<ToAppErrorOptions, 'signal'> & {
  /** Trusted local cause when the caller already built an AppError. The
   * diagnostic sink may use its stack without changing the public record. */
  nativeError?: Error;
  /** A trusted normalizer classified a non-Error throw before wrapping it. */
  thrownType?: AppErrorThrownType | undefined;
  /** Trusted static source used when classification supplied none. */
  source?: string;
  surface?: AppErrorSurface;
  retryFixed?: boolean;
  operationFailure?: AppErrorOperationFailure;
  /** V8 `at` frames a daemon sent for the failure it wrapped; they replace the
   * local wrap-site frames in the diagnostic sink. The caller validates them. */
  frames?: readonly string[];
};

export interface AppErrorHandler {
  report(
    value: unknown,
    options?: AppErrorReportOptions,
  ): AppErrorReport | undefined;
  flush(): void;
  dispose(): void;
}

interface Bucket {
  key: string;
  expiresAt: number;
  record: AppErrorRecord;
  cancel?: () => void;
}

const ConfigSchema = z
  .object({
    host: AppErrorIdentifierSchema,
    appVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/)
      .refine((value) => value === value.trim()),
    windowMs: z.number().int().positive().max(2147483647),
    maxBuckets: z.number().int().positive().max(10000),
  })
  .strict();

const ReportOptionsSchema = z
  .object({
    source: AppErrorIdentifierSchema.optional(),
    surface: AppErrorSurfaceSchema.optional(),
    retryFixed: z.boolean().optional(),
    operationFailure: AppErrorOperationFailureSchema.optional(),
  })
  .strict();

function errorKey(error: AppError): string {
  if (error.kind !== 'defect')
    return JSON.stringify([error.kind, error.code, error.source ?? '']);
  const stack = error.detail.stack ?? '';
  const header = `${error.detail.name ?? 'Error'}: ${error.detail.message}`;
  const frames = stack.startsWith(header) ? stack.slice(header.length) : stack;
  const frame =
    frames.split('\n').find((line) => /^\s*at\s|@/.test(line)) ?? '';
  return JSON.stringify([
    error.kind,
    error.code,
    error.detail.name ?? '',
    error.detail.message,
    frame,
    error.source ?? '',
  ]);
}

function cloneRecord(record: AppErrorRecord): AppErrorRecord {
  return {
    ...record,
    error: AppErrorSchema.parse(record.error),
    ...(record.operationFailure === undefined
      ? {}
      : { operationFailure: { ...record.operationFailure } }),
  };
}

export { appErrorNativeFrames, rememberAppErrorNativeFrames };

const defaultScheduler: AppErrorScheduler = {
  schedule(callback, delayMs): () => void {
    const timer = setTimeout(callback, delayMs);
    return (): void => clearTimeout(timer);
  },
};

/** Bounded fixed windows limit repeats per active key, not distinct failures. */
export function createAppErrorHandler(
  options: AppErrorHandlerOptions,
): AppErrorHandler {
  const config = ConfigSchema.parse({
    host: options.host,
    appVersion: options.appVersion,
    windowMs: options.windowMs ?? 60000,
    maxBuckets: options.maxBuckets ?? 128,
  });
  const candidateSinks: unknown = options.sinks;
  if (
    !Array.isArray(candidateSinks) ||
    !candidateSinks.every((sink: unknown) => typeof sink === 'function')
  )
    throw new TypeError('Invalid error sinks');
  if (options.clock !== undefined && typeof options.clock !== 'function')
    throw new TypeError('Invalid error clock');
  if (
    options.randomBytes !== undefined &&
    typeof options.randomBytes !== 'function'
  )
    throw new TypeError('Invalid error randomness');
  if (
    options.scheduler !== undefined &&
    typeof options.scheduler.schedule !== 'function'
  )
    throw new TypeError('Invalid error scheduler');
  const sinks: readonly AppErrorSink[] = [...options.sinks];
  const diagnosticSink = options.diagnosticSink;
  const clock = options.clock ?? Date.now;
  const scheduler = options.scheduler ?? defaultScheduler;
  const buckets = new Map<string, Bucket>();
  let disposed = false;
  let dispatching = false;

  function emit(
    record: AppErrorRecord,
    frames: readonly string[] = [],
    thrownType?: AppErrorThrownType,
  ): void {
    const previous = dispatching;
    dispatching = true;
    try {
      for (const sink of sinks) {
        try {
          // Isolate mutation as well as exceptions between sinks.
          sink(cloneRecord(record));
        } catch {
          // Routing is best effort; recording markers never acknowledge delivery.
        }
      }
      try {
        diagnosticSink?.(cloneRecord(record), frames, thrownType);
      } catch {
        // The diagnostic adapter cannot prevent the report from being returned.
      }
    } finally {
      dispatching = previous;
    }
  }

  function close(bucket: Bucket): void {
    if (buckets.get(bucket.key) !== bucket) return;
    buckets.delete(bucket.key);
    bucket.cancel?.();
    bucket.cancel = undefined;
    if (bucket.record.occurrenceCount > 1)
      emit({ ...bucket.record, isRepeatSummary: true });
  }

  function flush(): void {
    for (const bucket of [...buckets.values()]) close(bucket);
  }

  function report(
    value: unknown,
    reportOptions: AppErrorReportOptions = {},
  ): AppErrorReport | undefined {
    const { signal, nativeError, thrownType } = reportOptions;
    // Normalize only the optional operation field; preserve strict validation
    // of all other keys. A hostile metadata accessor cannot break recording.
    let operationFailure: AppErrorOperationFailure | undefined;
    try {
      operationFailure = normalizeAppErrorOperationFailure(
        reportOptions.operationFailure,
      );
    } catch {
      // Treat unreadable optional metadata as absent.
    }
    const metadata = {
      ...Object.fromEntries(
        Object.keys(reportOptions)
          .filter(
            (key) =>
              ![
                'signal',
                'nativeError',
                'thrownType',
                'operationFailure',
                'frames',
              ].includes(key),
          )
          .map((key) => [key, Reflect.get(reportOptions, key)]),
      ),
      operationFailure,
    };
    const original =
      thrownType === undefined ? (nativeError ?? value) : undefined;
    if (diagnosticSink && !disposed && !dispatching)
      rememberAppErrorNativeFrames(original);
    const now = AppErrorTimestampSchema.parse(clock());
    const classified = toAppError(value, {
      clock: () => now,
      randomBytes: options.randomBytes,
      signal,
    });
    if (!classified) return undefined;
    const presentation = ReportOptionsSchema.parse(metadata);
    const error =
      classified.source === undefined && presentation.source !== undefined
        ? { ...classified, source: presentation.source }
        : classified;
    if (
      disposed ||
      dispatching ||
      error.kind === 'input' ||
      error.recordedBy !== undefined
    )
      return { error, disposition: 'none' };
    for (const bucket of [...buckets.values()]) {
      if (now >= bucket.expiresAt) close(bucket);
    }
    // A sink may dispose the handler while an expired summary is dispatched.
    if (disposed) return { error, disposition: 'none' };
    // Supplied frames come from the failure the caller's error only wraps.
    const suppliedFrame = reportOptions.frames?.[0];
    const key = JSON.stringify([
      errorKey(error),
      presentation.operationFailure?.status ?? null,
      presentation.operationFailure?.code ?? null,
      ...(typeof suppliedFrame === 'string' ? [suppliedFrame] : []),
    ]);
    const existing = buckets.get(key);
    const disposition = error.kind === 'defect' ? 'recorded' : 'counted';
    if (existing) {
      existing.record.occurrenceCount++;
      existing.record.retryFixed ||= presentation.retryFixed ?? false;
      return {
        error: {
          ...error,
          referenceId: existing.record.error.referenceId,
          recordedBy: config.host,
        },
        disposition,
      };
    }
    if (buckets.size >= config.maxBuckets) {
      const oldest = buckets.values().next().value;
      if (oldest) close(oldest);
    }
    if (disposed) return { error, disposition: 'none' };
    const frames =
      reportOptions.frames ??
      (diagnosticSink && original !== null && typeof original === 'object'
        ? (rememberedAppErrorNativeFrames(original) ?? [])
        : []);
    const marked = { ...error, recordedBy: config.host };
    const bucket: Bucket = {
      key,
      expiresAt: now + config.windowMs,
      record: {
        error:
          error.kind === 'external'
            ? { ...marked, detail: { message: error.code } }
            : marked,
        disposition,
        occurrenceCount: 1,
        isRepeatSummary: false,
        retryFixed: presentation.retryFixed ?? false,
        ...(presentation.surface === undefined
          ? {}
          : { surface: presentation.surface }),
        ...(presentation.operationFailure === undefined
          ? {}
          : { operationFailure: { ...presentation.operationFailure } }),
        appVersion: config.appVersion,
      },
    };
    buckets.set(key, bucket);
    const nonErrorType = diagnosticSink
      ? (thrownType ??
        (nativeError === undefined
          ? getDirectReportThrownType(value)
          : getAppErrorThrownType(nativeError)))
      : undefined;
    emit(bucket.record, frames, nonErrorType);
    if (buckets.get(key) === bucket) {
      bucket.cancel = scheduler.schedule(() => close(bucket), config.windowMs);
    }
    return { error: marked, disposition };
  }

  return {
    report,
    flush,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      flush();
    },
  };
}
