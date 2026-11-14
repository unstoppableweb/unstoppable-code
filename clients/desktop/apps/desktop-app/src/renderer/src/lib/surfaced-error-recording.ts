import {
  reportClientAppError,
  resolveClientAppError,
  setClientAppErrorResolver,
} from '@canopy/desktop-instrumentation/client';
import {
  createSurfacedErrorRecorder,
  showsRawErrorDetail,
  type AppError,
  type AppErrorReport,
  type AppErrorSurface,
  type AppErrorThrownType,
  type SurfacedErrorInput,
  type SurfacedErrorRecorder,
} from '@canopy/protocol/app-errors';
import { setSurfacedErrorRecorder } from '@canopy/ui-shared/lib';
import { resolveIpcAppError } from './ipc-app-error';

/** Fixed names only: never a boundary's label, which can name user content. */
export type RendererErrorBoundaryId = 'root' | 'panel' | 'chart' | 'lazy-load';

let activeRecorder: SurfacedErrorRecorder | null = null;

/**
 * Resolve IPC rejections before recording so the existing reference is linked
 * to this renderer. Only caught values go through the resolver.
 */
function recordCaughtValue(
  recorder: SurfacedErrorRecorder,
  input: SurfacedErrorInput,
): AppErrorReport | undefined {
  return recorder.record(
    Object.prototype.hasOwnProperty.call(input, 'error')
      ? { ...input, error: resolveClientAppError(input.error) }
      : input,
  );
}

/**
 * Connects the shared UI's error choke points to the renderer's app-error
 * handler for this renderer runtime. The returned disposer drops the
 * registrations and the recorder's dedupe cache, which can hold sensitive text.
 */
export function installSurfacedErrorRecording(): () => void {
  const uninstallResolver = setClientAppErrorResolver(resolveIpcAppError);
  const recorder = createSurfacedErrorRecorder({
    report: reportClientAppError,
    recordsMessageText: showsRawErrorDetail({
      releaseFlavor: __CANOPY_RELEASE_FLAVOR__,
      isDevelopment: process.env.NODE_ENV === 'development',
    }),
  });
  activeRecorder = recorder;
  const uninstallPort = setSurfacedErrorRecorder((input) =>
    recordCaughtValue(recorder, input),
  );
  return (): void => {
    uninstallPort();
    uninstallResolver();
    if (activeRecorder === recorder) activeRecorder = null;
    recorder.dispose();
  };
}

/**
 * One report per background failure. `identifier` keeps the `toast:<category>`
 * source; `shown` says a popup was actually raised, so hidden delivery claims
 * no surface. Undefined when no recorder is installed.
 */
export function recordToastError(
  identifier: string,
  shown: boolean,
  error: AppError,
): AppErrorReport | undefined {
  return activeRecorder?.record({
    chokePoint: 'toast',
    identifier,
    ...(shown ? { surface: 'toast' as const } : {}),
    error,
  });
}

/** One report per caught failure. Never throws into a boundary's recovery. */
export function recordBoundaryError(
  identifier: RendererErrorBoundaryId,
  surface: AppErrorSurface,
  error: unknown,
  thrownType?: AppErrorThrownType,
): AppErrorReport | undefined {
  if (!activeRecorder) return undefined;
  return recordCaughtValue(activeRecorder, {
    chokePoint: 'boundary',
    identifier,
    surface,
    error,
    thrownType,
  });
}
