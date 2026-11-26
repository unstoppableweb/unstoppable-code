import type {
  BackgroundServiceStatus,
  W5RecoveryStatus,
} from '@canopy/protocol/remote-control/shell';

export interface BackgroundServiceNoticeCopy {
  readonly title: string;
  readonly message: string;
}

export const BACKGROUND_SERVICE_RESTART_LABEL = 'Restart app';
export const BACKGROUND_SERVICE_RESTARTING_LABEL = 'Restarting…';
export const BACKGROUND_SERVICE_COPY_DIAGNOSTICS_LABEL = 'Copy diagnostics';
export const STARTUP_BACKUP_NOTICE_TITLE = "Couldn't finish the startup backup";
// B2 keeps saves enabled, but does not repair damaged records or promise a backup.
export const STARTUP_BACKUP_NOTICE_MESSAGE =
  'The background service is available, and workspace saves remain enabled. Some damaged records may still fail to save; the app retries the backup next launch.';
export const STARTUP_BACKUP_NOTICE_DISMISS_LABEL =
  'Dismiss startup backup notice';

/** The CLI command that moves an earlier run's endpoint files aside (CAN-5957). */
export function backgroundServiceRepairCommand(cliName: string): string {
  return `${cliName} daemon repair-endpoint`;
}

/**
 * The copy for the card the host shows while the local background service
 * can't be reached (CAN-5541), by the state of the latest Try again: `failed`
 * once one ended without reaching it. Static copy only: no path, error
 * message or authority id, so replay and autocapture stay safe.
 *
 * `elsewhere`: this host can't run the next step (Remote Control); the copy
 * sends the person to the app on the computer that runs the service.
 *
 * `dataFolderShared`: another account can reach this computer's data folder
 * (CAN-7917). Only the computer that runs the service gets this copy, and
 * the host shows the folder beside it.
 */
export function backgroundServiceNoticeCopy(
  retry: 'idle' | 'running' | 'failed',
  recovery?: 'restart_app',
  restartUnavailable = false,
  repairCommand?: string,
  elsewhere = false,
  dataFolderShared = false,
): BackgroundServiceNoticeCopy {
  if (dataFolderShared && !elsewhere) {
    // Removing the access comes first: a restart or retry alone repeats the refusal.
    const nextStep =
      recovery === 'restart_app'
        ? restartUnavailable
          ? 'quit and reopen the app. Save any unsaved changes first.'
          : 'restart the app. Workspace records stay read-only until then.'
        : 'click Try again.';
    return {
      title:
        retry === 'failed'
          ? "Still couldn't start the background service"
          : "Couldn't start the background service",
      message: `The app's data folder is shared with another account. Remove the other account's access to it, then ${nextStep}`,
    };
  }
  if (repairCommand !== undefined) {
    if (!repairCommand.trim())
      throw new Error('A nonempty repair command is required.');
    const nextStep = elsewhere
      ? recovery === 'restart_app'
        ? 'restart the app there'
        : 'click Try again in the app there'
      : recovery === 'restart_app'
        ? restartUnavailable
          ? 'quit and reopen the app. Save any unsaved changes first'
          : 'restart the app'
        : 'click Try again';
    return {
      title:
        retry === 'failed'
          ? "Still couldn't reach the background service"
          : "Couldn't reach the background service",
      message: elsewhere
        ? `Files left by an earlier run are blocking it. On the paired computer, run ${repairCommand} in a terminal, then ${nextStep}.`
        : `Files left by an earlier run are blocking it. Run ${repairCommand} in a terminal, then ${nextStep}.`,
    };
  }
  // The W5 startup handoff is one-shot; only a new launch can recover it.
  if (recovery === 'restart_app')
    return {
      title: "Couldn't start the background service",
      message: elsewhere
        ? 'Restart the app on the paired computer. Workspace records stay read-only until then.'
        : restartUnavailable
          ? 'Quit and reopen the app to start the background service. Save any unsaved changes first.'
          : 'Restart the app to start the background service. Workspace records stay read-only until then.',
    };
  const where = elsewhere
    ? ' To retry, click Try again in the app on the paired computer.'
    : '';
  return retry === 'failed'
    ? {
        title: "Still couldn't reach the background service",
        message: elsewhere
          ? `Files and folders may not load.${where}`
          : 'Files and folders may not load. Try again in a moment.',
      }
    : {
        title: "Couldn't reach the background service",
        message: `Files and folders may not load.${where}`,
      };
}

const RECOVERY_TARGET_CATEGORIES = [
  'journals',
  'log',
  'file',
  'reservation',
  'commit',
] as const;

/**
 * Copy diagnostics (CAN-7061): a bounded summary built from status the host
 * already holds, so it works while the service is down. Codes and counts
 * only: no error message, log line, path, id or reservation diagnostic.
 */
export function backgroundServiceDiagnostics(input: {
  readonly status?: BackgroundServiceStatus;
  readonly recovery?: W5RecoveryStatus;
  /** Whether the person is on the computer that runs the service. */
  readonly place: 'this-computer' | 'remote-control';
}): string {
  const { status, recovery } = input;
  const lines = [
    'Background service diagnostics (format 1)',
    `Viewed from: ${input.place}`,
    `Service state: ${status?.state ?? 'unknown'}`,
  ];
  if (status) {
    lines.push(
      `Reason: ${status.reason ?? 'none'}`,
      `Try again: ${status.retry}`,
      `Restart required: ${status.recovery === 'restart_app' ? 'yes' : 'no'}`,
      ...(status.handoff ? [`Startup handoff failure: ${status.handoff}`] : []),
      ...(status.backupWarning
        ? [`Startup backup warning: ${status.backupWarning}`]
        : []),
      `Status sequence: ${status.sequence}`,
    );
  }
  if (recovery && recovery.state !== 'hidden') {
    const counts = new Map<string, number>();
    for (const entry of recovery.entries) {
      const prefix = entry.id.split(':', 1)[0] ?? '';
      const category = RECOVERY_TARGET_CATEGORIES.find(
        (known) => known === prefix,
      );
      const key = category ?? 'other';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    lines.push(
      `Workspace recovery: ${recovery.state}`,
      `Recovery targets: ${
        counts.size === 0
          ? 'none'
          : [...counts].map(([key, count]) => `${key} ${count}`).join(', ')
      }`,
    );
    // The startup's own result, not the current service cause (plan 7E).
    if (recovery.reason)
      lines.push(
        '',
        'Last startup recovery result',
        `Result: ${recovery.reason}`,
      );
  }
  return lines.join('\n');
}
