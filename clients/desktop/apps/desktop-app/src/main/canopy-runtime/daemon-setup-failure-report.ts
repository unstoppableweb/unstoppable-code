import type { BackgroundServiceUnreachableReason } from '@canopy/desktop-shared/lib/background-service-status';
import {
  canopyDaemonRefusal,
  canopyLaunchDetails,
} from '@canopy/core-client/node';
import { LocalAuthorityIdentityError } from '@canopy/core-platform';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import { createAppError } from '@canopy/protocol/app-errors';

/**
 * The allowlisted app-error source for a failed daemon setup:
 * `daemon.<reason>[.<refusal | claim cause | native stage | root cause>]
 * [.exit_<n>][.<SIGNAL>][.<ERRNO>]`. Every token is a closed value, so no
 * message, path or native diagnostic can reach telemetry.
 */
export function daemonSetupFailureSource(
  error: unknown,
  reason: BackgroundServiceUnreachableReason,
): string {
  const { errno, exitCode, signal, nativeStage, cause } =
    canopyLaunchDetails(error);
  const rootCause =
    error instanceof LocalAuthorityIdentityError ? error.rootCause : undefined;
  return [
    'daemon',
    reason,
    canopyDaemonRefusal(error) ?? cause ?? nativeStage ?? rootCause,
    exitCode === undefined ? undefined : `exit_${exitCode}`,
    signal,
    errno,
  ]
    .filter((token) => token !== undefined)
    .join('.');
}

/** Reports why the daemon could not be reached; only the closed source leaves. */
export function reportDaemonSetupFailure(
  error: unknown,
  reason: BackgroundServiceUnreachableReason,
): void {
  try {
    reportMainAppError(
      createAppError('external.service_unavailable', {
        source: daemonSetupFailureSource(error, reason),
      }),
    );
  } catch {
    // Reporting never changes the failure the caller handles.
  }
}
