import { createAppError } from '@canopy/protocol/app-errors';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';

/**
 * Carries a background failure's fixed source as its own message, so the
 * report's frames and text are never the original error's (which may hold
 * paths, tokens or user content).
 */
class BackgroundFailure extends Error {
  constructor(source: string) {
    super(source);
    this.name = 'BackgroundFailure';
  }
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const reportedThisSession = new Set<string>();

/** A caught error's class name as a code, or `unknown` when it is not a plain identifier. */
export function backgroundFailureCode(error: unknown): string {
  return error instanceof Error && CODE_PATTERN.test(error.name)
    ? error.name
    : 'unknown';
}

/**
 * Reports a background failure that has no user surface (sync, publish,
 * subscriptions). Only the fixed `source` and a closed `code` leave. Each
 * source/code pair reports once per session, because these loops can fail on
 * every pass. Never throws.
 */
export function reportBackgroundFailure(source: string, code: string): void {
  const safeCode = CODE_PATTERN.test(code) ? code : 'unknown';
  const key = `${source}:${safeCode}`;
  if (reportedThisSession.has(key)) return;
  reportedThisSession.add(key);
  try {
    const nativeError = new BackgroundFailure(key);
    reportMainAppError(
      createAppError('app.unexpected', {
        source: key,
        detail: {
          name: nativeError.name,
          message: nativeError.message,
          status: safeCode,
        },
      }),
      { nativeError },
    );
  } catch {
    // Reporting never changes how the background work settles.
  }
}
