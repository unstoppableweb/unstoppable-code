import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import { createAppError } from '@canopy/protocol/app-errors';
import { canopyErrorDiagnostic } from '@canopy/protocol/canopy-core';

/**
 * Reports a failure a client library contained and handed to a host hook,
 * such as a daemon stream listener that threw (CAN-7116). Only the fixed
 * `source`, the allowlisted class and system code, and V8 `at` frames leave;
 * never the message, which may hold paths, tokens or user content. Never
 * throws.
 */
export function reportContainedFailure(source: string, error: unknown): void {
  try {
    // Read before anything formats the stack, or the frames are gone.
    const { name, code, frames } = canopyErrorDiagnostic(error);
    reportMainAppError(
      createAppError('app.unexpected', {
        source,
        detail: {
          name,
          message: source,
          ...(code === undefined ? {} : { errno: code }),
        },
      }),
      { frames },
    );
  } catch {
    // Reporting never changes how the contained failure settles.
  }
}
