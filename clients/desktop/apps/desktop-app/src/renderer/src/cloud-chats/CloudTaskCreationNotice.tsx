import { useEffect, type JSX } from 'react';
import { useStore } from 'zustand';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { webCoreLocalId } from '@/lib/chat-authority';
import { cloudCoworkStore } from './cloud-cowork-store';
import { retryCloudTask } from './useCloudCoworkSidebar';
import { markCloudTaskShown } from './task-creation-timing';

/**
 * A cloud task this window opened, which the web core refused to create
 * (CAN-6098): the composer says why and offers Try again, under the same
 * task id. The draft stays in the composer. Nothing shows otherwise.
 */
export function CloudTaskCreationNotice({
  projectId,
  worktreeId,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
}): JSX.Element | null {
  const workspaceId = webCoreLocalId(projectId);
  const taskId = webCoreLocalId(worktreeId);
  const reason = useStore(cloudCoworkStore, (state) => {
    if (workspaceId === null || taskId === null) return undefined;
    const task = state.tasksByProject[`web-core:${workspaceId}`]?.find(
      (each) => each.worktreeId === taskId,
    );
    return task?.creation === 'failed'
      ? (task.creationError ?? 'This task was not created.')
      : undefined;
  });
  // The composer of a task just opened is usable from its first render.
  useEffect(() => {
    if (taskId !== null) markCloudTaskShown(taskId, 'composerUsable');
  }, [taskId]);
  if (reason === undefined) return null;
  return (
    <Notice
      intent="destructive"
      title="This task wasn't created"
      data-testid="chat-input-cloud-task-creation-failed"
      actions={
        <NoticeButton
          variant="secondary"
          onClick={(): void => {
            retryCloudTask(projectId, worktreeId);
          }}
          data-testid="chat-input-cloud-task-creation-retry"
        >
          Try again
        </NoticeButton>
      }
    >
      {reason}
    </Notice>
  );
}
