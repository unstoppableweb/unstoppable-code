import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import type { useActivityStore } from '@/stores/activityStore';

type HandleSdkSystemEvent = ReturnType<
  typeof useActivityStore.getState
>['handleSdkSystemEvent'];

/**
 * Every failure shape that means "this task is already gone", mapped to the
 * terminal status the card should adopt. Main resolves a stop for a dead task
 * successfully now, but the request can still fail this way — the chat's
 * provider session can disappear between the click and the IPC, and the
 * message arrives wrapped in Electron's `Error invoking remote method …`
 * prefix. Leaving it unrecognized left a `running` card that the Stop button
 * could never clear. A refusal that says nothing about the task's state (a
 * Codex session, for instance) stays unresolved.
 */
export function extractTerminalStatusFromStopError(
  error: unknown,
): string | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  if (!message) return null;

  const match = /status:\s*([a-z_]+)/i.exec(message);
  const status = match?.[1]?.toLowerCase();
  if (
    status === 'killed' ||
    status === 'stopped' ||
    status === 'cancelled' ||
    status === 'canceled' ||
    status === 'failed' ||
    status === 'completed'
  ) {
    return status;
  }

  return /no active session|not running|unknown task|no such task/i.test(
    message,
  )
    ? 'stopped'
    : null;
}

/**
 * Stops a background process and settles its card: on success, or when the
 * failure says the task is already gone. Other failures are logged and leave
 * the card as it is. Never rejects. Shared by every surface with a Stop: the
 * Activity card, the chat's Agent activity section and the top bar's
 * "N running" card.
 */
export async function stopBackgroundProcess(
  projectId: string,
  worktreeId: string,
  process: BackgroundProcess,
  /** The activity store's event reducer, which settles the card. */
  handleSdkSystemEvent: HandleSdkSystemEvent,
): Promise<void> {
  const taskId = process.taskId;
  if (!taskId) return;
  try {
    const stopOutcome = await window.api.activity.stopBgProcess({
      projectId,
      worktreeId,
      chatId: process.chatId,
      taskId,
    });

    if (stopOutcome === 'stopped') {
      handleSdkSystemEvent(projectId, worktreeId, process.chatId, {
        type: 'system',
        subtype: 'task_notification',
        task_id: taskId,
        status: 'stopped',
        summary: 'Background process stopped.',
      });
    }
  } catch (error) {
    const terminalStatus = extractTerminalStatusFromStopError(error);
    if (terminalStatus) {
      handleSdkSystemEvent(projectId, worktreeId, process.chatId, {
        type: 'system',
        subtype: 'task_notification',
        task_id: taskId,
        status: terminalStatus,
        summary: 'Background process is no longer running.',
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('Failed to stop background process', {
      taskId,
      error,
    });
  }
}
