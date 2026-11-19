import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { logMainProcessError } from './main-process-logging';
import { sendToAllWindows } from './window-send';
import type { SessionStopCause } from '../agents/session-manager';

/**
 * Canopy-owned `reason` on a synthetic terminal task notification. The Claude
 * SDK only ever sends `worker_restart`, so this value plus `canopy_synthetic`
 * identify a notification Canopy minted itself rather than one the provider
 * reported.
 */
export const SESSION_ENDED_TASK_NOTIFICATION_REASON = 'session_ended';

/** User-visible summary on the stopped background-process card. */
export const SESSION_ENDED_TASK_NOTIFICATION_SUMMARY =
  'Stopped when the chat session ended';

export interface SyntheticTerminalNotificationCopy {
  reason: string;
  summary: string;
}

export interface SessionEndedBackgroundTaskTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface SessionEndedBackgroundTask {
  taskId: string;
  toolUseId?: string;
  description?: string;
  stopCause?: SessionStopCause;
}

function summaryForStopCause(cause: SessionStopCause): string {
  switch (cause) {
    case 'stop':
      return 'Stopped when the chat was stopped';
    case 'recycle':
      return 'Stopped when the provider session was recycled';
    case 'archive':
      return 'Stopped when the chat was archived';
    case 'crash':
      return 'Stopped when the provider process crashed';
    case 'external_signal':
      return 'Stopped when the provider process exited';
    case 'session_ended':
      return SESSION_ENDED_TASK_NOTIFICATION_SUMMARY;
  }
}

/**
 * Build the `system`/`task_notification` event Canopy emits for a background
 * task whose owning provider session went away without a terminal bookend.
 * The shape is deliberately the one the renderer and the observability
 * transcript sidecar already reduce for real SDK notifications; only `reason`
 * and `canopy_synthetic` are additions.
 */
export function buildSessionEndedTaskNotification(
  task: SessionEndedBackgroundTask,
  copy?: SyntheticTerminalNotificationCopy,
): Record<string, unknown> {
  const stopCause = task.stopCause ?? 'session_ended';
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: task.taskId,
    ...(task.toolUseId ? { tool_use_id: task.toolUseId } : {}),
    ...(task.description ? { description: task.description } : {}),
    status: 'stopped',
    reason: copy?.reason ?? SESSION_ENDED_TASK_NOTIFICATION_REASON,
    summary:
      copy?.summary ??
      (task.stopCause
        ? summaryForStopCause(task.stopCause)
        : SESSION_ENDED_TASK_NOTIFICATION_SUMMARY),
    canopy_stop_cause: stopCause,
    canopy_synthetic: true,
  };
}

/**
 * Deliver a synthetic terminal notification to the consumers a live provider
 * event reaches: the observability transcript sidecar and every renderer
 * window.
 *
 * It deliberately does not go through the per-turn session event route. That
 * route drops any `system` event arriving after its turn settled — which is
 * exactly when a background task outlives its turn — and would also offer the
 * event to canonical chat state, which rejects appends to a settled turn. Each
 * consumer is best effort: none of them may block the others or fail teardown.
 */
export function emitSessionEndedBackgroundTaskNotification(
  target: SessionEndedBackgroundTaskTarget,
  task: SessionEndedBackgroundTask,
  copy?: SyntheticTerminalNotificationCopy,
): void {
  const data = buildSessionEndedTaskNotification(task, copy);

  try {
    void getExecutionObservabilityIngest()
      .appendFinalizedChatTranscriptRecord(
        target.projectId,
        target.worktreeId,
        target.chatId,
        data,
      )
      .catch((error: unknown) => {
        logMainProcessError(
          'Session-ended background task observability record failed',
          error,
        );
      });
  } catch (error: unknown) {
    logMainProcessError(
      'Session-ended background task observability record failed',
      error,
    );
  }

  try {
    sendToAllWindows(IPC_CHANNELS.chatEvent, {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      data,
    });
  } catch (error: unknown) {
    logMainProcessError('Session-ended background task delivery failed', error);
  }
}
