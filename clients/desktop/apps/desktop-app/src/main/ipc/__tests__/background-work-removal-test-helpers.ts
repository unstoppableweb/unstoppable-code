import type { LiveBackgroundTaskOwner } from '../../agents/session-manager';

export function createLiveBackgroundTaskOwner(
  projectId: string,
  worktreeId: string,
  chatId: string,
  taskType: string,
): LiveBackgroundTaskOwner {
  return {
    sessionKey: `${projectId}/${worktreeId}/${chatId}`,
    projectId,
    worktreeId,
    chatId,
    liveTasks: [{ taskId: `${taskType}-task`, taskType }],
  };
}
