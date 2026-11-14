import { useEffect, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  CHAT_DELETED_ELSEWHERE_ACTION,
  CHAT_DELETED_ELSEWHERE_TITLE,
  chatDeletedElsewhereNotice,
  chatFilesNotAttachedNotice,
} from '@canopy/ui-app/composer-recovery';
import {
  ConfirmDialog,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import { useCloudChatDeleted } from '@/stores/chat/web-core/task-deletions';
import { useChatStore } from '@/stores/chatStore';
import { cloudAttachmentSource } from './cloud-chat-attachments';
import {
  deletedChatHasDraft,
  deletedTaskContents,
  discardDeletedCloudTask,
  dismissDeletedTaskDiscard,
  dismissFilesNotAttached,
  showDeletedTaskRowIfUnsent,
  startNewChatFromDeletedTask,
  useDeletedTaskDiscardAsked,
  useFilesNotAttached,
} from './cloud-task-deletion';

/**
 * The composer of a cloud task deleted on another device (CAN-6614): it says
 * so, keeps the draft and attachments above, and offers Start new chat,
 * which carries them into a new task, and Discard, which asks first when
 * the draft has text. Every chat of the task shows it, for its own draft.
 */
export function CloudChatDeletedNotice({
  projectId,
  worktreeId,
  tabId,
  composerHasText,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly tabId: string | undefined;
  /**
   * Whether the composer showing `tabId` holds text now: typing reaches the
   * store's drafts only after a pause or a save.
   */
  readonly composerHasText: boolean;
}): JSX.Element | null {
  const scope = { projectId, worktreeId };
  const deleted = useCloudChatDeleted(projectId, worktreeId, tabId);
  const { hasDraft, attachments, attachAgain } = useChatStore(
    useShallow((state) => {
      const kept = deletedTaskContents(state, scope, tabId);
      return {
        hasDraft: kept.draft !== undefined || composerHasText,
        attachments: kept.attachments.length,
        attachAgain: kept.attachments
          .filter(
            (attachment) =>
              cloudAttachmentSource(attachment.absolutePath) === undefined,
          )
          .map((attachment) => attachment.filename)
          .join('\n'),
      };
    }),
  );
  const asked = useDeletedTaskDiscardAsked(scope);
  // Text typed into a task deleted while empty brings its Deleted row.
  useEffect(() => {
    if (deleted && composerHasText)
      showDeletedTaskRowIfUnsent({ projectId, worktreeId });
  }, [deleted, composerHasText, projectId, worktreeId]);
  const [confirming, setConfirming] = useState(false);
  if (!deleted || tabId === undefined) return null;
  return (
    <>
      <Notice
        intent="attention"
        title={CHAT_DELETED_ELSEWHERE_TITLE}
        data-testid="chat-input-chat-deleted"
        actions={
          <>
            <NoticeButton
              variant="secondary"
              data-testid="chat-input-chat-deleted-discard"
              onClick={(): void => {
                // As the composer holds it now, not as last mirrored.
                if (deletedChatHasDraft(scope, tabId)) setConfirming(true);
                else discardDeletedCloudTask(scope, tabId);
              }}
            >
              Discard
            </NoticeButton>
            <NoticeButton
              variant="primary"
              data-testid="chat-input-chat-deleted-start"
              onClick={(): void => startNewChatFromDeletedTask(scope, tabId)}
            >
              {CHAT_DELETED_ELSEWHERE_ACTION}
            </NoticeButton>
          </>
        }
      >
        {chatDeletedElsewhereNotice({
          draft: hasDraft,
          attachments,
          attachAgain: attachAgain === '' ? [] : attachAgain.split('\n'),
        })}
      </Notice>
      {confirming || asked ? (
        <ConfirmDialog
          destructive
          title="Discard draft?"
          message={
            attachments > 0
              ? "Your unsent text and attachments will be lost. This can't be undone."
              : "Your unsent text will be lost. This can't be undone."
          }
          confirmLabel="Discard draft"
          dataTestId="chat-deleted-discard-dialog"
          confirmTestId="chat-deleted-discard-confirm"
          cancelTestId="chat-deleted-discard-cancel"
          onConfirm={(): void => {
            setConfirming(false);
            // The row's Discard drops the whole task; this chat's, its own.
            discardDeletedCloudTask(scope, asked ? undefined : tabId);
          }}
          onCancel={(): void => {
            setConfirming(false);
            dismissDeletedTaskDiscard(scope);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * A new chat started from a deleted one names the files it couldn't take
 * (CAN-6614): a pasted file, or one that moved on disk since.
 */
export function CloudChatFilesNotAttachedNotice({
  tabId,
}: {
  readonly tabId: string | undefined;
}): JSX.Element | null {
  const names = useFilesNotAttached(tabId);
  if (tabId === undefined || names.length === 0) return null;
  return (
    <Notice
      intent="attention"
      data-testid="chat-input-files-not-attached"
      onDismiss={(): void => dismissFilesNotAttached(tabId)}
      dismissLabel="Dismiss"
    >
      {chatFilesNotAttachedNotice(names)}
    </Notice>
  );
}
