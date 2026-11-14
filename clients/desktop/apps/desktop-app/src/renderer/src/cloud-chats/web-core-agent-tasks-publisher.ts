import { useActivityStore } from '@/stores/activityStore';
import { setWebCoreAgentTasksPublisher } from '@/stores/chat/web-core';

/**
 * Sends a cloud chat's agent tasks, as background processes, to the activity
 * tray (CAN-6175 R2b). The web core backend receives the publisher instead of
 * importing the activity store, whose imports reach the chat store that
 * imports the backend. Idempotent.
 */
export function installWebCoreAgentTasksPublisher(): void {
  setWebCoreAgentTasksPublisher({
    publish: (scope, chatId, processes) =>
      useActivityStore
        .getState()
        .setChatBackgroundProcesses(
          scope.projectId,
          scope.worktreeId,
          chatId,
          processes,
        ),
  });
}
