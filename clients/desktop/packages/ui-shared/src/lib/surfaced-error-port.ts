import {
  AppErrorSchema,
  toAppError,
  type AppError,
  type AppErrorReport,
  type SurfacedErrorInput,
} from '@canopy/protocol/app-errors';
import { rememberUserVisibleError } from './recent-user-visible-error';

/**
 * The host's recorder for errors shown through shared UI. Shared components
 * call the port; the host decides whether anything is reported, so this
 * package stays free of instrumentation and host imports. The sink returns
 * the host's report so a banner can show the reference the host recorded.
 */
export type SurfacedErrorSink = (
  input: SurfacedErrorInput,
) => AppErrorReport | undefined;

let registration: { readonly sink: SurfacedErrorSink } | null = null;

/**
 * Installs the host's recorder. The returned uninstaller only removes its own
 * registration, so a stale one cannot remove a newer install, even of the same
 * callback.
 */
export function setSurfacedErrorRecorder(sink: SurfacedErrorSink): () => void {
  const own = { sink };
  registration = own;
  return (): void => {
    if (registration === own) registration = null;
  };
}

/**
 * The host's report, so shared UI can show the reference the host recorded;
 * `undefined` without a recorder or when it fails. A failing recorder never
 * reaches the UI.
 */
export function recordSurfacedError(
  input: SurfacedErrorInput,
): AppErrorReport | undefined {
  let report: AppErrorReport | undefined;
  try {
    report = registration?.sink(input);
  } catch {
    // Recording is best effort and must not report its own failure.
  }
  return report;
}

/** Called by the displaying surface, never by telemetry-only links. */
export function recordUserVisibleError(
  input: SurfacedErrorInput,
): AppErrorReport | undefined {
  const report = recordSurfacedError(input);
  try {
    if (
      input.surface !== undefined &&
      Object.prototype.hasOwnProperty.call(input, 'error')
    ) {
      const error = report?.error ?? toAppError(input.error);
      if (error) rememberUserVisibleError(error);
    }
  } catch {
    // Remembering a displayed failure is independent of telemetry delivery.
  }
  return report;
}

/**
 * The failure a host already recorded, carried as the `appError` of the error
 * thrown for it (`Object.assign(new Error(text), { appError: result.appError })`),
 * so callers link to that record instead of recording the failure again.
 * `undefined` for any other error, including a carried error the host did not
 * record.
 */
export function recordedErrorOf(error: unknown): AppError | undefined {
  if (!(error instanceof Error)) return undefined;
  const parsed = AppErrorSchema.safeParse(Reflect.get(error, 'appError'));
  return parsed.success && parsed.data.recordedBy !== undefined
    ? parsed.data
    : undefined;
}

/**
 * Links a failure the host already recorded to this session without recording
 * it again: the sink resolves the carried `AppError` (a recorded error is never
 * reported twice) and the host's resolver emits the session link. Only the
 * existing `AppError` leaves, never the display text. A no-op when the error
 * carries no host record.
 */
export function linkRecordedAppError(
  appError: AppError | undefined,
  identifier: string,
): void {
  if (appError?.recordedBy === undefined) return;
  recordSurfacedError({
    chokePoint: 'notice',
    surface: 'inline',
    identifier,
    error: appError,
  });
}

/** `linkRecordedAppError` for an error thrown with the host's `appError`. */
export function linkRecordedError(error: unknown, identifier: string): void {
  linkRecordedAppError(recordedErrorOf(error), identifier);
}
