import { useStore } from 'zustand';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { webCoreLocalId } from '@/lib/chat-authority';
import { cloudCoworkStore } from './useCloudCoworkSidebar';

/**
 * CAN-5974: names the cloud task open on the cowork page in the current UI
 * state, ids and title only; null for a local task.
 */
export function useReportOpenCloudTask(
  projectId: string,
  workEntryId: string | null,
): void {
  const workspaceId = webCoreLocalId(projectId);
  const taskId = workEntryId === null ? null : webCoreLocalId(workEntryId);
  const title = useStore(cloudCoworkStore, (state) => {
    if (taskId === null) return null;
    for (const tasks of Object.values(state.tasksByProject)) {
      const task = tasks.find((each) => each.worktreeId === taskId);
      if (task) return task.title;
    }
    return null;
  });
  useCurrentUiStateReporter(
    'cloudChat.open',
    workspaceId === null || taskId === null
      ? null
      : { chatId: taskId, projectId: workspaceId, title: title ?? '' },
  );
}
