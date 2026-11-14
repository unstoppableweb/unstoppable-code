import { BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  W5RecoveryStatusSchema,
  type W5RecoveryStatus,
} from '@canopy/protocol/portal';
import {
  w5RecoveryGuidance,
  W5_RECOVERY_QUIT_ALL_GUIDANCE,
} from '@canopy/ui-shared/lib/w5-recovery-copy';
import { writeFileAtomically } from './atomic-file';
import {
  type W5MaintenanceDecision,
  type W5MaintenanceDecisionResult,
} from '@canopy/core-runtime/node/w5/maintenance-types';
import type { W5Diagnosis } from './w5-maintenance-diagnosis';
import {
  isW5RecoveryAvailable,
  isW5ReservationReleaseQualified,
} from './w5-recovery-gates';
import {
  recoveryActions,
  runW5RecoveryLaunch,
  w5RecoveryFailureReason,
} from './w5-recovery-launch';
import { runElectronW5Maintenance } from '../canopy-runtime/electron-w5-recovery';
import {
  consumeW5RecoveryRequest,
  requirePrivateW5RecoveryRuntime,
  w5RecoveryResultPath,
} from './w5-recovery-request';
import { shouldShowUiAutomationWindow } from './ui-automation-window';
import { waitForW5RecoveryDaemonRelease } from './w5-recovery-wait';

async function progress<T>(
  parent: BrowserWindow,
  message: string,
  task: (signal: AbortSignal) => Promise<T>,
  onCancelled: () => void,
): Promise<T> {
  const owner = new AbortController();
  let finished = false;
  // macOS needs a parent: unparented dialogs block the event loop and ignore abort.
  const shown = dialog
    .showMessageBox(parent, {
      type: 'info',
      message,
      detail: `${W5_RECOVERY_QUIT_ALL_GUIDANCE} Recovery will not stop another process. You can cancel while waiting.`,
      buttons: ['Cancel recovery'],
      signal: owner.signal,
    })
    .then(
      () => {
        if (!finished) {
          onCancelled();
          owner.abort();
        }
      },
      () => {
        if (!finished) {
          onCancelled();
          owner.abort();
        }
      },
    );
  try {
    return await task(owner.signal);
  } finally {
    finished = true;
    owner.abort();
    await shown;
  }
}

async function choose(
  parent: BrowserWindow,
  diagnosis: W5Diagnosis,
): Promise<readonly W5MaintenanceDecision[] | null> {
  const allowed = recoveryActions(diagnosis, isW5ReservationReleaseQualified());
  const decisions: W5MaintenanceDecision[] = [];
  for (const reservation of diagnosis.reservations) {
    const action = allowed.find(
      (d) =>
        d.kind === 'resolve-reservation' &&
        d.reservationId === reservation.reservationId,
    );
    if (!action) continue;
    const answer = await dialog.showMessageBox(parent, {
      type: 'question',
      message: `Interrupted change: ${reservation.operation}`,
      detail:
        'Release this blocked change without rerunning it. This does not undo any external effects.',
      buttons: ['Cancel recovery', 'Keep blocked', 'Release change'],
      defaultId: 1,
      cancelId: 0,
    });
    if (answer.response === 0) return null;
    if (answer.response === 2) decisions.push(action);
  }
  for (const commit of diagnosis.commits) {
    const actions = allowed.filter(
      (d) => d.kind !== 'resolve-reservation' && d.commitId === commit.commitId,
    );
    if (!actions.length) continue;
    const abandon = actions.find((d) => d.kind === 'abandon-commit');
    const retry = actions.find((d) => d.kind === 'retry-commit');
    const buttons = [
      'Cancel recovery',
      'Keep blocked',
      'Try again',
      ...(abandon ? ['Abandon change'] : []),
    ];
    const answer = await dialog.showMessageBox(parent, {
      type: 'question',
      message: `Interrupted change: ${commit.operation}`,
      detail: `Commit ${commit.commitId}. Try again applies its saved decision if the files still match. Abandon keeps the current files without applying that decision.\n${(commit.diagnostics ?? '').slice(0, 2000)}`,
      buttons,
      defaultId: 0,
      cancelId: 0,
    });
    if (answer.response === 0) return null;
    if (answer.response === 2 && retry) decisions.push(retry);
    else if (answer.response === 3 && abandon) {
      const confirmed = await dialog.showMessageBox(parent, {
        type: 'warning',
        message: `Abandon commit ${commit.commitId}?`,
        detail:
          'This keeps the current files. The pending change will not be applied. It does not undo changes outside these records.',
        buttons: ['Keep blocked', 'Abandon change'],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirmed.response === 1) decisions.push(abandon);
    }
  }
  return decisions;
}

async function record(
  dataRoot: string,
  status: W5RecoveryStatus,
  diagnosis?: W5Diagnosis,
  results?: readonly W5MaintenanceDecisionResult[],
): Promise<void> {
  await requirePrivateW5RecoveryRuntime(dataRoot);
  const finishedAt = Date.now();
  await writeFileAtomically(
    join(dataRoot, 'runtime/w5-recovery-diagnosis.json'),
    `${JSON.stringify({ version: 1, finishedAt, status, diagnosis, results })}\n`,
    { durable: true, mode: 0o600 },
  );
  await writeFileAtomically(
    w5RecoveryResultPath(dataRoot),
    `${JSON.stringify({ version: 1, finishedAt, status: W5RecoveryStatusSchema.parse(status) })}\n`,
    { durable: true, mode: 0o600 },
  );
}

/** Before W11 admission, any default host, normal windows or background clients. */
export async function runDesktopW5RecoveryLaunch(
  dataRoot: string,
): Promise<boolean> {
  let parent: BrowserWindow | undefined;
  let status: W5RecoveryStatus;
  try {
    if (hostPlatformOperatingSystem() === 'win32')
      throw Object.assign(new Error(), { reason: 'platform-unsupported' });
    const intent = await consumeW5RecoveryRequest(dataRoot);
    if (!intent) return true;
    if (!isW5RecoveryAvailable())
      throw Object.assign(new Error(), { reason: 'exposure-gated' });
    // No preload or app renderer is loaded; this blank sandboxed parent makes no W5 calls.
    const window = new BrowserWindow({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
      title: 'Workspace recovery',
      width: 600,
      height: 240,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: shouldShowUiAutomationWindow(),
    });
    parent = window;
    window.on('close', (event) => event.preventDefault());
    let cancelled = false;
    const onCancelled = (): void => {
      cancelled = true;
    };
    status = await runW5RecoveryLaunch({
      allowReservationRelease: isW5ReservationReleaseQualified(),
      waitForRelease: async (): Promise<void> => {
        await progress(
          window,
          'Waiting for the background service to finish',
          (signal) => waitForW5RecoveryDaemonRelease(dataRoot, signal),
          onCancelled,
        );
        if (cancelled)
          throw new DOMException('Recovery cancelled.', 'AbortError');
      },
      maintenance: (request) =>
        progress(
          window,
          request.mode === 'reopen'
            ? 'Inspecting workspace records'
            : 'Recovering workspace records',
          (signal) => runElectronW5Maintenance(dataRoot, request, signal),
          onCancelled,
        ),
      choose: (diagnosis) =>
        cancelled ? Promise.resolve(null) : choose(window, diagnosis),
      record: (status, diagnosis, results) =>
        record(dataRoot, status, diagnosis, results),
    });
  } catch (error) {
    status = {
      state: 'refused',
      canRecover: false,
      reason: w5RecoveryFailureReason(error),
      entries: [],
    };
    await record(dataRoot, status).catch(() => undefined);
  }
  try {
    const options: Electron.MessageBoxOptions = {
      type: status.state === 'complete' ? 'info' : 'warning',
      message:
        status.state === 'complete'
          ? 'Workspace recovery finished'
          : 'Workspace recovery needs attention',
      detail: `${status.state === 'complete' ? 'The selected recovery decisions finished.' : w5RecoveryGuidance(status.reason)}\n${status.entries
        .map((e) => `${e.operation}: ${e.detail}`)
        .join('\n')
        .slice(0, 16_000)}\nRecovery result: runtime/w5-recovery-result.json`,
      buttons: ['Continue'],
    };
    if (parent) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
  } finally {
    parent?.destroy();
  }
  return (
    status.reason !== 'release-uncertain' &&
    status.reason !== 'writer-exit-unconfirmed'
  );
}
