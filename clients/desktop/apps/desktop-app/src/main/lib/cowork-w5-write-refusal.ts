import { classifyError } from '@canopy/protocol/app-errors/classification';
import { desktopW5WriteRefusal } from './w5-commit-log-file-store';
import { W5DaemonHandoffError } from './w5-handoff-store';
import { CoworkWorkspaceRecordRefusedError } from './worktree-record-decision-apply';

/**
 * Fixed copy: callers copy `message` into app-events, so it names no path or
 * id (CAN-7316).
 */
const COWORK_RECORDS_READ_ONLY =
  'Workspace records are read-only until the app restarts';

/**
 * Refuses a Cowork provision before any effect while the W5 startup handoff
 * is degraded, typed and classified as service unavailable instead of an
 * unclassified handoff error after the scaffold (CAN-7316). Call it only
 * after an index read has settled the handoff.
 */
export function refuseCoworkProvisionWhileW5Degraded(): void {
  const refusal = desktopW5WriteRefusal();
  if (refusal === undefined) return;
  throw classifyError(
    new CoworkWorkspaceRecordRefusedError(
      'index-unavailable',
      COWORK_RECORDS_READ_ONLY,
      refusal,
    ),
    'external.service_unavailable',
    { source: 'w5.handoff_degraded' },
  );
}

/** Whether `error` is the refusal {@link refuseCoworkProvisionWhileW5Degraded} throws. */
export function isCoworkW5WriteRefusal(error: unknown): boolean {
  return (
    error instanceof CoworkWorkspaceRecordRefusedError &&
    error.reason === 'index-unavailable' &&
    error.cause instanceof W5DaemonHandoffError
  );
}
