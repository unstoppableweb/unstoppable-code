import type { W5RecoveryReason } from '@canopy/protocol/portal';

const SUPPORT =
  'Keep the data folder intact and contact support with the recovery diagnosis. Do not edit the workspace records or remove recovery files.';

export const W5_RECOVERY_QUIT_ALL_GUIDANCE =
  'Quit every other app and command-line process using this data folder, including older installations, even if you skipped updates. Then restart the app on the computer that holds these records for recovery.';

/** Shared by the running notice and native pre-admission recovery dialogs. */
export function w5RecoveryGuidance(reason?: W5RecoveryReason): string {
  switch (reason) {
    case 'platform-unsupported':
      return `Recovery is not available on Windows. ${SUPPORT}`;
    case 'cli-active':
      return 'A command-line process is still using these records. Quit that process before starting recovery.';
    case 'host-active':
      return 'Another app or command-line process is still using these records. Quit every process using this data folder. On Linux, a reused process number stays blocked until that process exits.';
    case 'peer_held':
      return 'The background service is still in use. Quit every app and command-line process using this data folder. If it remains active, restart the computer.';
    case 'replacement-daemon':
      return 'Another background service started while recovery was waiting. Quit every app and command-line process using this data folder, then try again.';
    case 'cohort-ambiguous':
    case 'runtime-unavailable':
      return `Recovery cannot safely use this data folder. Linked or non-private runtime folders and filesystems without hard links are not supported. ${SUPPORT}`;
    case 'launch-recovery-pending':
      return 'Automatic recovery has not finished. Quit and reopen the app, then start recovery again. If the change stays blocked, contact support.';
    case 'operation-excluded':
      return `This change may have effects outside the workspace records and cannot be released here. ${SUPPORT}`;
    case 'history-unproven':
      return `This change cannot be released until its earlier recovery history is qualified. ${SUPPORT}`;
    case 'release-uncertain':
    case 'writer-exit-unconfirmed':
      return `Recovery could not confirm that it released the records. The app must close. ${SUPPORT}`;
    case 'request-unavailable':
      return 'Could not save the recovery request. Writes remain paused. Quit and reopen the app before trying again.';
    case 'result-unavailable':
      return `Recovery could not save its result. Some changes may already have completed. ${SUPPORT}`;
    case 'source-unavailable':
      return `A workspace record is missing or unreadable. Recovery cannot safely create an empty replacement. ${SUPPORT}`;
    case 'unsaved-changes':
      return 'Save or discard your unsaved edits before starting recovery.';
    case 'exposure-gated':
      return `Recovery is not available for workspace records in this build. ${SUPPORT}`;
    case 'invalid-request':
      return 'The recovery request expired or could not be read. No recovery decisions ran. Start recovery again from the app.';
    case 'cancelled':
      return 'Recovery was cancelled. Any completed decisions remain in the diagnosis.';
    case undefined:
      return 'Some changes are blocked. Restart for recovery to inspect the records and choose what to do.';
    default:
      return `Recovery could not safely continue (${reason}). ${SUPPORT}`;
  }
}
