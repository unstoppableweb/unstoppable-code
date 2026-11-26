import { useState, type JSX } from 'react';
import { useStore } from 'zustand';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
import { isWebCoreScope, webCoreLocalId } from '@/lib/chat-authority';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import {
  sendAgainMayDuplicateTo,
  useHomeComposerStore,
  type HomeCloudDestination,
  type HomeKeptDraft,
  type HomeOutboxCard,
} from '@/stores/homeComposerStore';
import {
  canMoveIntoNewTask,
  dropKeptDraft,
  moveHomeOutboxEntryIntoNewTask,
  moveKeptDraftIntoNewTask,
  outboxCardShowsIn,
} from './homeDraftPersistence';
import { discardHomeOutboxEntry, sendHomeOutboxEntryAgain } from './homeSend';
import { useHomeScope } from './homeScope';

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** A cloud task's title as the sidebar lists it, or null when it isn't. */
function useTaskTitle(destination: HomeCloudDestination): string | null {
  return useStore(cloudCoworkStore, (state) => {
    if (!isWebCoreScope(destination.projectId)) return null;
    const worktreeId = webCoreLocalId(destination.worktreeId);
    const title =
      worktreeId === null
        ? undefined
        : state.tasksByProject[destination.projectId]?.find(
            (task) => task.worktreeId === worktreeId,
          )?.title;
    return title === undefined || title.trim() === '' ? null : title;
  });
}

function CopyButton({ text }: { readonly text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <NoticeButton
      data-testid="home-outbox-copy"
      onClick={(): void => {
        void copyTextToClipboard(text).then(setCopied);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </NoticeButton>
  );
}

/** One message an earlier run sent, as New task shows it (CAN-6798). */
function OutboxCardNotice({
  card,
}: {
  readonly card: HomeOutboxCard;
}): JSX.Element | null {
  const { entry, state } = card;
  // Closing the checking notice hides it until the check settles.
  const [checkingHidden, setCheckingHidden] = useState(false);
  if (state !== 'checking' && checkingHidden) setCheckingHidden(false);
  const title = useTaskTitle(entry.destination);
  const movable = useHomeComposerStore(
    () => state === 'returned' && canMoveIntoNewTask(entry.workspaceId),
  );
  const sending = useHomeComposerStore((store) => store.isSending);
  const mayDuplicate = useHomeComposerStore((store) =>
    sendAgainMayDuplicateTo(store, entry.destination),
  );
  const dismiss = (): void =>
    useHomeComposerStore.getState().removeOutboxCard(entry.id);
  const letGo = (): void => {
    void discardHomeOutboxEntry(entry.id);
  };
  const taskName =
    title === null ? (
      'its task'
    ) : (
      // A task's title is user-authored: replay masks it.
      <span className={POSTHOG_REPLAY_MASK_CLASS}>{title}</span>
    );
  // The message itself is the person's own: replay never records it.
  const quoted = (
    <span
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} line-clamp-2 block`}
      data-testid="home-outbox-text"
    >
      {entry.text}
    </span>
  );
  const fileNames = entry.cloudFileNames;
  const testId = `home-outbox-${state}`;

  switch (state) {
    case 'sending':
      // Read-only: the message has left New task, whose editor is free for a
      // new draft.
      return (
        <Notice
          data-testid={testId}
          intent="neutral"
          className="pointer-events-auto"
          title="Sending your message"
        >
          {quoted}
          It's on its way to {taskName}.
        </Notice>
      );
    case 'sent':
      return (
        <Notice
          data-testid={testId}
          intent="positive"
          className="pointer-events-auto"
          title="Your earlier message was sent"
          onDismiss={dismiss}
          dismissLabel="Dismiss"
          actions={
            <NoticeButton
              variant="primary"
              data-testid="home-outbox-open"
              onClick={(): void =>
                openCoworkWorkEntryFromSidebar(
                  entry.destination.projectId,
                  entry.destination.worktreeId,
                )
              }
            >
              Open it
            </NoticeButton>
          }
        >
          It reached {taskName} before the app closed.
        </Notice>
      );
    case 'restored':
      return (
        <Notice
          data-testid={testId}
          intent="attention"
          className="pointer-events-auto"
          title="Your earlier message wasn't sent"
          onDismiss={dismiss}
          dismissLabel="Dismiss"
        >
          It's back here to edit and send.
        </Notice>
      );
    case 'returned':
      return (
        <Notice
          data-testid={testId}
          intent="attention"
          className="pointer-events-auto"
          title="Your earlier message wasn't sent"
          onDismiss={letGo}
          dismissLabel="Discard it"
          actions={
            <>
              <CopyButton text={entry.text} />
              <NoticeButton
                variant="primary"
                data-testid="home-outbox-move"
                disabled={!movable}
                onClick={(): void => {
                  moveHomeOutboxEntryIntoNewTask(entry.id);
                }}
              >
                Move to New task
              </NoticeButton>
            </>
          }
        >
          {quoted}
          {movable
            ? null
            : 'Send or clear the draft in New task to move it back here.'}
        </Notice>
      );
    case 'checking':
      if (checkingHidden) return null;
      return (
        <Notice
          data-testid={testId}
          intent="neutral"
          className="pointer-events-auto"
          title="Checking your earlier message"
          onDismiss={(): void => setCheckingHidden(true)}
          dismissTestId="home-outbox-checking-dismiss"
          actions={<CopyButton text={entry.text} />}
        >
          {quoted}
          It was on its way to {taskName} when the app closed. New task checks
          again once the cloud answers.
        </Notice>
      );
    case 'missing': {
      // Its files' bytes weren't kept: sent again, it would go without them.
      const filesLost = fileNames.length > 0;
      return (
        <Notice
          data-testid={testId}
          intent="attention"
          className="pointer-events-auto"
          title={
            card.taskGone === true
              ? "Your earlier message's task is gone"
              : 'Your earlier message may still arrive'
          }
          onDismiss={letGo}
          dismissLabel="Discard it"
          dismissDisabled={sending}
          actions={
            <>
              <CopyButton text={entry.text} />
              <NoticeButton
                variant="primary"
                data-testid="home-outbox-send-again"
                disabled={filesLost || sending}
                onClick={(): void => {
                  void sendHomeOutboxEntryAgain(entry.id);
                }}
              >
                Send again
              </NoticeButton>
            </>
          }
        >
          {quoted}
          {card.taskGone === true ? (
            'Sending it again starts a new task.'
          ) : (
            <>
              It was on its way to {taskName} when the app closed and hasn't
              arrived yet.{' '}
              {/* Where the cloud can't stop the earlier send, it says so before
                  the person sends it again (CAN-6856). */}
              {mayDuplicate
                ? 'Sending it again could deliver it twice.'
                : 'Sending it again stops the earlier one first, so it arrives once.'}
            </>
          )}
          {filesLost ? (
            <>
              {' '}
              Its files,{' '}
              {/* File names are the person's own: replay masks them. */}
              <span className={POSTHOG_REPLAY_MASK_CLASS}>
                {listOf(fileNames)}
              </span>
              , weren't kept: copy it and attach them again in a new message.
            </>
          ) : null}
        </Notice>
      );
    }
  }
}

/**
 * What New task says about what a reload or quit left (CAN-6798): files a
 * restored draft held, to attach again, and each message an earlier run
 * sent.
 */
/** A draft an earlier run left for another project, kept apart (CAN-6798). */
function KeptDraftNotice({
  draft,
}: {
  readonly draft: HomeKeptDraft;
}): JSX.Element {
  const scope = useHomeScope();
  const inContext =
    draft.workspaceId === null || !scope.isOutOfScope(draft.workspaceId);
  const movable = useHomeComposerStore(() =>
    canMoveIntoNewTask(draft.workspaceId),
  );
  return (
    <Notice
      data-testid="home-kept-draft"
      intent="attention"
      className="pointer-events-auto"
      title="Your earlier draft is kept"
      onDismiss={(): void => dropKeptDraft(draft.id)}
      dismissLabel="Discard it"
      actions={
        <>
          <CopyButton text={draft.text} />
          <NoticeButton
            variant="primary"
            data-testid="home-kept-draft-move"
            disabled={!movable}
            onClick={(): void => {
              moveKeptDraftIntoNewTask(draft.id);
            }}
          >
            Move to New task
          </NoticeButton>
        </>
      }
    >
      {/* The draft itself is the person's own: replay never records it. */}
      <span
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} line-clamp-2 block`}
        data-testid="home-kept-draft-text"
      >
        {draft.text}
      </span>
      {movable
        ? null
        : inContext
          ? "It's for another project. Send or clear the draft in New task to move it back here."
          : "It's for a project in another organization. Switch to its organization to move it back."}
    </Notice>
  );
}

export function HomeRestoreNotices(): JSX.Element | null {
  const notice = useHomeComposerStore((state) => state.restoreNotice);
  const cards = useHomeComposerStore((state) => state.outboxCards);
  const kept = useHomeComposerStore((state) => state.keptDrafts);
  const workspaceId = useHomeComposerStore((state) => state.workspaceId);
  const shown = cards.filter((card) => outboxCardShowsIn(card, workspaceId));
  if (notice === null && shown.length === 0 && kept.length === 0) return null;
  return (
    <>
      {notice === null ? null : (
        <Notice
          key="home-draft-restored"
          data-testid="home-draft-restored"
          intent="attention"
          className="pointer-events-auto"
          title="Your draft is back"
          onDismiss={(): void =>
            useHomeComposerStore.getState().setRestoreNotice(null)
          }
          dismissLabel="Dismiss"
        >
          Attach {/* File names are the person's own: replay masks them. */}
          <span className={POSTHOG_REPLAY_MASK_CLASS}>
            {listOf(notice.fileNames)}
          </span>{' '}
          again before you send.
        </Notice>
      )}
      {kept.map((draft) => (
        <KeptDraftNotice key={draft.id} draft={draft} />
      ))}
      {shown.map((card) => (
        <OutboxCardNotice key={card.entry.id} card={card} />
      ))}
    </>
  );
}
