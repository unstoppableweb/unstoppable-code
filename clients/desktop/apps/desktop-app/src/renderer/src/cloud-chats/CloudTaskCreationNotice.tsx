import { useEffect, type JSX } from 'react';
import { useStore } from 'zustand';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { webCoreLocalId } from '@/lib/chat-authority';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cloudCoworkStore } from './cloud-cowork-store';
import { retryCloudTask } from './useCloudCoworkSidebar';
import { markCloudTaskShown } from './task-creation-timing';

/**
 * A cloud task this window opened, which the web core refused to create
 * (CAN-6098): the composer says why and offers Try again, under the same
 * task id. The draft stays in the composer, and Copy draft puts its text on
 * the clipboard, so a task that can never be created, such as one whose
 * project is gone, never strands it (CAN-6614). A task whose create's
 * answer never came may exist: it says so, never that it wasn't created, and
 * the listing settles it (CAN-7196). Nothing shows otherwise.
 * The composer supplies its text as it holds it, since typing reaches the
 * store's drafts only after a pause or a save.
 */
/** What a task whose create's answer never came says (CAN-7196). */
export const CLOUD_TASK_CREATION_UNKNOWN = "It'll show in the list if it was.";

export function CloudTaskCreationNotice({
  projectId,
  worktreeId,
  draftText,
  readDraftText,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
  /** The composer's text now, trimmed; empty hides Copy draft. */
  readonly draftText: string;
  /** Reads the composer's text at the moment Copy draft is clicked. */
  readonly readDraftText: () => string;
}): JSX.Element | null {
  const workspaceId = webCoreLocalId(projectId);
  const taskId = webCoreLocalId(worktreeId);
  const reason = useStore(cloudCoworkStore, (state) => {
    if (workspaceId === null || taskId === null) return undefined;
    const task = state.tasksByProject[`web-core:${workspaceId}`]?.find(
      (each) => each.worktreeId === taskId,
    );
    if (task?.creation === 'unknown') return CLOUD_TASK_CREATION_UNKNOWN;
    return task?.creation === 'failed'
      ? (task.creationError ?? 'This task was not created.')
      : undefined;
  });
  // The composer of a task just opened is usable from its first render.
  useEffect(() => {
    if (taskId !== null) markCloudTaskShown(taskId, 'composerUsable');
  }, [taskId]);
  if (reason === undefined) return null;
  const unknown = reason === CLOUD_TASK_CREATION_UNKNOWN;
  return (
    <Notice
      {...(unknown
        ? {
            intent: 'attention' as const,
            title: "Couldn't confirm this task was created",
            'data-testid': 'chat-input-cloud-task-creation-unknown',
          }
        : {
            errorSource: 'chat-input-cloud-task-creation-failed',
            intent: 'destructive' as const,
            title: "This task wasn't created",
            'data-testid': 'chat-input-cloud-task-creation-failed',
          })}
      actions={
        <>
          {draftText === '' ? null : (
            <NoticeButton
              variant="secondary"
              onClick={(): void => {
                void copyTextToClipboard(readDraftText()).catch(
                  reportClientAppError,
                );
              }}
              data-testid="chat-input-cloud-task-creation-copy-draft"
            >
              Copy draft
            </NoticeButton>
          )}
          <NoticeButton
            variant="secondary"
            onClick={(): void => {
              retryCloudTask(projectId, worktreeId);
            }}
            data-testid="chat-input-cloud-task-creation-retry"
          >
            Try again
          </NoticeButton>
        </>
      }
    >
      {reason}
    </Notice>
  );
}
