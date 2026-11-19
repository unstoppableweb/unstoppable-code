import {
  FeedbackSessionIdSchema,
  validatedPostHogReplayUrl,
  type FeedbackReportTelemetry,
} from '@canopy/protocol/feedback-report';
import {
  AppErrorClassSchema,
  AppErrorErrnoSchema,
  AppErrorOperationFailureSchema,
  AppErrorSchema,
  normalizeAppErrorOperationFailure,
  AppErrorSurfaceSchema,
  type AppError,
  type AppErrorRecord,
} from '@canopy/protocol/app-errors';
import { sanitizeInstrumentationContext } from './privacy';
import type { DesktopInstrumentationContext } from './types';

export const APP_ERROR_POSTHOG_EVENT = 'app:operation_fail';
/**
 * A renderer saw a failure another process owns. Links that reference to this
 * session's replay; it is not a failure count, so never sum it with the above.
 */
export const APP_ERROR_VIEW_POSTHOG_EVENT = 'app:error_view';
/**
 * A main-process cap was first hit in its window. Carries only the cap name
 * and dropped counts, so it is never a failure count either.
 */
export const APP_ERROR_CAP_POSTHOG_EVENT = 'app:error_cap_reach';

/** Host adapters supply SDK accessors, never caller context or identity URLs. */
export interface AppErrorTelemetrySessions {
  datadog?: { getSessionId(): unknown };
  posthog?: {
    getSessionId(): unknown;
    isRecording(): unknown;
    getReplayUrl(): unknown;
  };
}

function read(getter: () => unknown): unknown {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

function sessionId(value: unknown): string | undefined {
  const parsed = FeedbackSessionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function metadata(record: AppErrorRecord): DesktopInstrumentationContext {
  const error = AppErrorSchema.parse(record.error);
  if (
    error.kind === 'input' ||
    record.disposition !== (error.kind === 'defect' ? 'recorded' : 'counted')
  )
    throw new TypeError('Only recorded or counted failures have telemetry');
  if (
    !Number.isSafeInteger(record.occurrenceCount) ||
    record.occurrenceCount < 1 ||
    typeof record.isRepeatSummary !== 'boolean' ||
    typeof record.retryFixed !== 'boolean'
  )
    throw new TypeError('Invalid error record counts or flags');
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(record.appVersion) ||
    record.appVersion !== record.appVersion.trim()
  )
    throw new TypeError('Invalid app version');
  const surface =
    record.surface === undefined
      ? undefined
      : AppErrorSurfaceSchema.parse(record.surface);
  const operationFailure = normalizeAppErrorOperationFailure(
    record.operationFailure,
  );
  // Revalidate each value; one that fails its allowlist is omitted, not cut.
  const errorClass = AppErrorClassSchema.safeParse(error.detail.name);
  const errno = AppErrorErrnoSchema.safeParse(error.detail.errno);
  const operationCode = AppErrorOperationFailureSchema.shape.code.safeParse(
    error.detail.operationCode,
  );
  return {
    ...(operationFailure
      ? {
          operation_status: operationFailure.status,
          ...(operationFailure.code === undefined
            ? {}
            : { operation_code: operationFailure.code }),
        }
      : {}),
    error_kind: error.kind,
    error_code: error.code,
    error_reference_id: error.referenceId,
    ...(errorClass.success ? { error_class: errorClass.data } : {}),
    ...(errno.success ? { error_errno: errno.data } : {}),
    ...(operationCode.success && operationCode.data !== undefined
      ? { error_operation_code: operationCode.data }
      : {}),
    ...(surface === undefined ? {} : { error_surface: surface }),
    ...(error.source === undefined ? {} : { error_source: error.source }),
    ...(error.recovery === undefined ? {} : { recovery_kind: error.recovery }),
    error_repeat_count: record.occurrenceCount,
    is_repeat_summary: record.isRepeatSummary,
    is_retry_fixed: record.retryFixed,
    app_version: record.appVersion,
  };
}

export function buildAppErrorPostHogProperties(
  record: AppErrorRecord,
): DesktopInstrumentationContext {
  return sanitizeInstrumentationContext(metadata(record)) ?? {};
}

export { appErrorException } from '@canopy/protocol/app-errors';

export function buildAppErrorViewPostHogProperties(
  value: AppError,
  appVersion: string,
): DesktopInstrumentationContext {
  const error = AppErrorSchema.parse(value);
  return (
    sanitizeInstrumentationContext({
      error_kind: error.kind,
      error_code: error.code,
      error_reference_id: error.referenceId,
      ...(error.source === undefined ? {} : { error_source: error.source }),
      ...(error.recovery === undefined
        ? {}
        : { recovery_kind: error.recovery }),
      app_version: appVersion,
    }) ?? {}
  );
}

/**
 * Validated session links for one error occurrence. Read when the error is
 * caught so a later session never claims it; a replay URL needs a recording.
 */
export function buildFeedbackReportTelemetry(
  sessions: AppErrorTelemetrySessions = {},
): FeedbackReportTelemetry {
  const datadogSessionId = sessionId(
    read(() => sessions.datadog?.getSessionId()),
  );
  const posthogSessionId = sessionId(
    read(() => sessions.posthog?.getSessionId()),
  );
  const posthogReplayUrl =
    posthogSessionId !== undefined &&
    read(() => sessions.posthog?.isRecording()) === true
      ? validatedPostHogReplayUrl(
          read(() => sessions.posthog?.getReplayUrl()),
          posthogSessionId,
        )
      : undefined;
  return {
    ...(datadogSessionId === undefined ? {} : { datadogSessionId }),
    ...(posthogSessionId === undefined ? {} : { posthogSessionId }),
    ...(posthogReplayUrl === undefined ? {} : { posthogReplayUrl }),
  };
}
