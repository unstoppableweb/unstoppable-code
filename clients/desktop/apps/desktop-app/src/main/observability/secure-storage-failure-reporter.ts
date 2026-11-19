import { createAppError } from '@canopy/protocol/app-errors';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';

/** Electron's selected Linux backends; any other value leaves as `other`. */
const KNOWN_BACKENDS: ReadonlySet<string> = new Set([
  'basic_text',
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
  'unknown',
]);

function backendToken(backend: string | null): string {
  if (backend === null) return 'none';
  return KNOWN_BACKENDS.has(backend) ? backend : 'other';
}

/** The app-error identifier grammar has no underscore: `SECURE_STORAGE_X` -> `secure-storage-x`. */
function sourceToken(token: string): string {
  return token.toLowerCase().replace(/_/g, '-');
}

/**
 * Report a secure-storage failure that came back as a result. Only the store
 * and the closed record (code, operation, state, backend, retryable) leave, as
 * a static source of allowlisted tokens; native diagnostics, paths and secret
 * values never do. Never throws: a telemetry failure must not change the
 * caller's result.
 */
export function reportSecureStorageFailure(
  store: 'github-pat' | 'linear-token',
  failure: SecureStorageFailure,
): void {
  try {
    reportMainAppError(
      createAppError('external.service_unavailable', {
        source: [
          'secure-storage',
          store,
          failure.operation,
          failure.code,
          failure.state,
          backendToken(failure.backend),
          failure.retryable ? 'retryable' : 'final',
        ]
          .map(sourceToken)
          .join('.'),
      }),
    );
  } catch {
    // Telemetry is best-effort.
  }
}
