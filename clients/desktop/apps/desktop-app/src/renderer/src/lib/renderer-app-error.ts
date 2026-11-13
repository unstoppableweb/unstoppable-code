import {
  readClientErrorTelemetry,
  reportClientAppError,
} from '@canopy/desktop-instrumentation/client';
import {
  presentAppError,
  toAppError,
  type AppError,
  type AppErrorDisplayPolicy,
  type AppErrorPresentation,
  type AppErrorSurface,
} from '@canopy/protocol/app-errors';
import type { FeedbackReportTelemetry } from '@canopy/protocol/feedback-report';
import {
  recordBoundaryError,
  recordToastError,
  type RendererErrorBoundaryId,
} from './surfaced-error-recording';

export interface CapturedRendererAppError {
  appError: AppError | null;
  telemetry: FeedbackReportTelemetry | null;
}

function normalize(
  error: unknown,
  surface: AppErrorSurface,
  boundary?: RendererErrorBoundaryId,
): AppError | null {
  const reported = boundary
    ? recordBoundaryError(boundary, surface, error)
    : reportClientAppError(error, { surface });
  if (reported) return reported.error;
  try {
    return toAppError(error) ?? null;
  } catch (failure) {
    reportClientAppError(failure, { surface });
    return null;
  }
}

/**
 * Called once per occurrence, from `componentDidCatch`, so the reference and
 * session links belong to this crash. With no app error the boundary keeps its
 * generic recovery view, without Details or Report this.
 */
export function captureRendererAppError(
  error: unknown,
  surface: AppErrorSurface,
  boundary?: RendererErrorBoundaryId,
): CapturedRendererAppError {
  const appError = normalize(error, surface, boundary);
  if (!appError) return { appError: null, telemetry: null };
  try {
    return { appError, telemetry: readClientErrorTelemetry() };
  } catch (failure) {
    reportClientAppError(failure, { surface });
    return { appError, telemetry: null };
  }
}

/** The renderer's raw-detail policy, shared by boundaries and banners. */
export const rendererAppErrorDisplayPolicy: AppErrorDisplayPolicy = {
  releaseFlavor: __CANOPY_RELEASE_FLAVOR__,
  isDevelopment: process.env.NODE_ENV === 'development',
};

export interface CapturedToastFailure {
  /** The recorder's error, whose reference a repeat within its window shares. */
  error: AppError;
  telemetry?: FeedbackReportTelemetry;
}

/**
 * Records a background failure once and reads what a report of it needs. The
 * person's own work is not a defect: it is neither recorded nor reportable.
 * With no recorder the failure keeps its own error, unrecorded.
 */
export function captureToastFailure(
  error: AppError,
  identifier: string,
  shown: boolean,
): CapturedToastFailure {
  if (error.kind === 'input') return { error };
  const recorded = recordToastError(identifier, shown, error)?.error ?? error;
  if (recorded.kind !== 'defect') return { error: recorded };
  try {
    return { error: recorded, telemetry: readClientErrorTelemetry() };
  } catch (failure) {
    reportClientAppError(failure, { surface: 'toast' });
    return { error: recorded };
  }
}

export function presentRendererAppError(error: AppError): AppErrorPresentation {
  return presentAppError(error, rendererAppErrorDisplayPolicy);
}
