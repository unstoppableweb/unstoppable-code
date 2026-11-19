import {
  cleanupLogRecord,
  LocalDelegationCleanupError,
} from '@canopy/desktop-shared/node/delegation/cleanup-diagnostics';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import { logMainProcessWarn } from '../../lib/main-process-logging';

// The runner reports a cleanup failure when it happens; the broker re-reports
// the same error after close(), which must not log it twice.
const reportedCleanups = new WeakSet<LocalDelegationCleanupError>();

/** Delegation failures for the main log. Cleanup failures keep checked metadata only. */
export function reportDelegationError(error: unknown): void {
  if (!(error instanceof LocalDelegationCleanupError)) {
    logMainProcessWarn('[delegation] Owned operation failed', error);
    // Delegation messages can quote prompts and paths: only the app-error path
    // (sanitized by the handler) carries the failure to telemetry.
    reportMainAppError(error, { source: 'delegation' });
    return;
  }
  if (reportedCleanups.has(error)) return;
  reportedCleanups.add(error);
  const record = cleanupLogRecord(error.diagnostic);
  logMainProcessWarn('[delegation] Local cleanup failed', record);
}
