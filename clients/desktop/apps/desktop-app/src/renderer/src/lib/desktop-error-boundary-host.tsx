/* eslint-disable react-refresh/only-export-components */
import {
  rememberAppErrorNativeFrames,
  type AppErrorSurface,
} from '@canopy/protocol/app-errors';
import type { AppErrorBoundaryHost } from '@canopy/ui-app';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { DesktopReportThisAction } from '@/components/shared/DesktopReportThisAction';
import { brandText } from '@/lib/brand';
import {
  captureRendererAppError,
  presentRendererAppError,
} from '@/lib/renderer-app-error';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import type { RendererErrorBoundaryId } from '@/lib/surfaced-error-recording';

interface DesktopErrorBoundaryScope {
  readonly boundary: RendererErrorBoundaryId;
  readonly surface: AppErrorSurface;
  readonly consoleMessage: string;
}

/** Invoke synchronously, propagating a failed attempt as a rejected promise. */
function attemptReport(report: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(report());
  } catch (failure) {
    return Promise.reject(
      failure instanceof Error
        ? failure
        : new Error('An auxiliary error report failed'),
    );
  }
}

/** Auxiliary sinks must not cost the failure its one canonical record. */
function isolated(surface: AppErrorSurface, report: () => void): void {
  void Promise.allSettled([attemptReport(report)]).then(([result]) => {
    if (result?.status === 'rejected') {
      // A failed sink gets one reporting attempt, separately from the original
      // failure. Its settlement is consumed without recursively reporting it.
      void Promise.allSettled([
        attemptReport(() => reportClientAppError(result.reason, { surface })),
      ]);
    }
  });
}

function describeThrown(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return {};
  return {
    name: 'name' in error ? error.name : undefined,
    message: 'message' in error ? error.message : undefined,
    stack: 'stack' in error ? error.stack : undefined,
  };
}

function createDesktopErrorBoundaryHost(
  scope: DesktopErrorBoundaryScope,
): AppErrorBoundaryHost {
  return {
    capture(error, info, context, thrownType) {
      if (thrownType === undefined) rememberAppErrorNativeFrames(error);
      isolated(scope.surface, () =>
        reportRendererConsoleError(scope.consoleMessage, {
          ...describeThrown(error),
          componentStack: info.componentStack,
          ...context,
        }),
      );
      return captureRendererAppError(
        error,
        scope.surface,
        scope.boundary,
        thrownType,
      );
    },
    present: presentRendererAppError,
    renderReportAction: (appError, telemetry) => (
      <DesktopReportThisAction
        error={appError}
        appName={brandText.appName}
        {...(telemetry ? { telemetry } : {})}
      />
    ),
  };
}

export const rootErrorBoundaryHost = createDesktopErrorBoundaryHost({
  boundary: 'root',
  surface: 'window',
  consoleMessage: 'Top-level renderer error boundary caught an error',
});

export const panelErrorBoundaryHost = createDesktopErrorBoundaryHost({
  boundary: 'panel',
  surface: 'panel',
  consoleMessage: 'Panel error boundary caught an error',
});

export const chartErrorBoundaryHost = createDesktopErrorBoundaryHost({
  boundary: 'chart',
  surface: 'panel',
  consoleMessage: 'Chart error boundary caught an error',
});

export const lazyLoadErrorBoundaryHost = createDesktopErrorBoundaryHost({
  boundary: 'lazy-load',
  surface: 'panel',
  consoleMessage: 'Lazy component failed to load',
});
