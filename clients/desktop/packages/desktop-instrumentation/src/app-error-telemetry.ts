import {
  FeedbackSessionIdSchema,
  validatedPostHogReplayUrl,
  type FeedbackReportTelemetry,
} from '@canopy/protocol/feedback-report';
import {
  AppErrorSchema,
  AppErrorSurfaceSchema,
  getAppErrorDefinition,
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
  return {
    error_kind: error.kind,
    error_code: error.code,
    error_reference_id: error.referenceId,
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

/** Keep the catalog description and V8 stack frames. Raw detail can name private
 * work entries or contain caller prose that pattern redaction cannot identify. */
export function appErrorException(
  record: AppErrorRecord,
  frames: readonly string[],
): Error {
  const { code } = record.error;
  const error = new Error(getAppErrorDefinition(code).summary);
  error.name = code;
  // A non-empty catalog header keeps the SDK from substituting a launch stack.
  error.stack = [error.toString(), ...frames].join('\n');
  return error;
}

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
