import { type JSX, useCallback, useEffect, useState } from 'react';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Markdown,
  markdownOptions,
  PlanCommentComposer,
  type PlanReviewAuthor,
  PlanReviewComment,
  PlanReviewThread,
  Surface,
} from '@canopy/ui-shared/components';
import type {
  SharedRunComment,
  SharedRunCommentThread,
  SharedRunDetail,
} from '@canopy/protocol/runs';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DialogModal } from '@/components/shared/DialogModal';
import { brandText } from '@/lib/brand';
import { useChatStore } from '@/stores/chatStore';
import {
  useRunCommentsStore,
  type RunCommentsTarget,
} from '@/stores/runCommentsStore';

const TITLE = 'Run comments';
const SLOW_LOADING_NOTE = 'Still loading comments…';
const EMPTY_LABEL = 'No comments on this shared run yet.';
const UNAVAILABLE_LABEL = `Comments aren't available for this session. It may no longer be shared, or the connected ${brandText.appName} Cloud doesn't support run comments yet.`;
const GENERIC_ERROR = 'Unable to load comments.';
const SAVE_ERROR = 'Unable to save comment.';

const MARKDOWN_OPTIONS = markdownOptions({});
const PROSE_CLASS =
  'prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-code:fg-accent prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary prose-strong:fg-primary';

/**
 * Read + reply surface for comments left on a run this desktop user shared
 * (CAN-397).
 *
 * Comments are SERVER-AUTHORITATIVE. Every read and every mutation is a
 * pass-through to Canopy Cloud through `runs:comments:*` IPC, and each response
 * carries the full fresh `SharedRunDetail`, which replaces local state
 * wholesale. There is no desktop-local comment store, no optimistic write, and
 * no merge algorithm — the same rule the main process and the web viewer follow.
 */
export function RunCommentsModal({
  target,
  onClose,
}: {
  target: RunCommentsTarget;
  onClose: () => void;
}): JSX.Element {
  const { projectId, worktreeId, chatId } = target;
  const [detail, setDetail] = useState<SharedRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newComment, setNewComment] = useState('');
  const [pending, setPending] = useState(false);

  /**
   * Clear the unread badge locally to match the revision the user has now
   * seen. `markCommentsSeen` is the durable write (main persists last-seen
   * per run); this keeps the badge in the tab bar / share icon in step without
   * waiting for the next poll tick.
   */
  const markSeen = useCallback(
    (commentRevision: number): void => {
      const tabs =
        useChatStore.getState().worktreeChats[`${projectId}/${worktreeId}`]
          ?.tabs ?? [];
      const tab = tabs.find((candidate) => candidate.id === chatId);
      const sharedRun = tab?.kind === 'file' ? undefined : tab?.sharedRun;
      if (!sharedRun) {
        return;
      }
      const seenSharedRun = {
        ...sharedRun,
        commentRevision,
        unreadCommentCount: 0,
      };

      // Opening the authoritative detail means the user has seen this
      // revision. Clear the presentation immediately while the two durable
      // writes (the comment registry and canonical tab metadata) settle.
      void useChatStore
        .getState()
        .setSharedRun(projectId, worktreeId, chatId, seenSharedRun)
        .catch(() => undefined);
      void window.api.runs
        .markCommentsSeen({ projectId, worktreeId, chatId, commentRevision })
        .catch(() => {
          // Restore the previous badge when the durable seen marker fails.
          void useChatStore
            .getState()
            .setSharedRun(projectId, worktreeId, chatId, sharedRun)
            .catch(() => undefined);
        });
    },
    [chatId, projectId, worktreeId],
  );

  const load = useCallback((): void => {
    setLoading(true);
    void window.api.runs
      .listComments({ projectId, worktreeId, chatId })
      .then((response) => {
        setDetail(response.detail);
        setError(null);
        if (response.detail) {
          markSeen(response.detail.commentRevision);
        }
      })
      .catch(() => setError(GENERIC_ERROR))
      .finally(() => setLoading(false));
  }, [chatId, markSeen, projectId, worktreeId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Swap in the server's authoritative detail after a mutation. */
  const applyDetail = useCallback(
    (next: SharedRunDetail | null): boolean => {
      if (!next) {
        setError(SAVE_ERROR);
        return false;
      }
      setDetail(next);
      setError(null);
      markSeen(next.commentRevision);
      return true;
    },
    [markSeen],
  );

  const addComment = async (): Promise<void> => {
    const body = newComment.trim();
    if (body.length === 0 || pending) {
      return;
    }
    setPending(true);
    try {
      const result = await window.api.runs.createCommentThread({
        projectId,
        worktreeId,
        chatId,
        body,
      });
      if (applyDetail(result.detail)) {
        setNewComment('');
      }
    } catch {
      setError(SAVE_ERROR);
    } finally {
      setPending(false);
    }
  };

  const threads = detail?.commentThreads ?? [];

  return (
    <DialogModal
      inset="flush"
      title={TITLE}
      subtitle={target.title}
      onClose={onClose}
      maxWidth="2xl"
      dataTestId="run-comments-modal"
    >
      {loading && detail === null ? (
        <DelayedLoadingPlaceholder className="" slowNote={SLOW_LOADING_NOTE}>
          <div className="box-content flex min-h-full flex-1 py-12">
            <CenteredLoadingSpinner className="" />
          </div>
        </DelayedLoadingPlaceholder>
      ) : detail === null ? (
        <p className="text-s fg-secondary" data-testid="run-comments-empty">
          {error ?? UNAVAILABLE_LABEL}
        </p>
      ) : (
        // Blocked: comment bodies, reviewer names, and quoted transcript text.
        <div className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-col gap-3`}>
          {threads.length === 0 ? (
            <p className="text-s fg-secondary" data-testid="run-comments-empty">
              {EMPTY_LABEL}
            </p>
          ) : (
            threads.map((thread) => (
              <RunCommentThreadCard
                key={thread.id}
                target={target}
                thread={thread}
                detail={detail}
                onDetail={applyDetail}
              />
            ))
          )}

          <Surface variant="card" padding="compact">
            <PlanCommentComposer
              value={newComment}
              onChange={setNewComment}
              onSubmit={() => void addComment()}
              submitLabel="Comment"
              compact
              submitDisabled={pending || newComment.trim().length === 0}
              inputTestId="run-comments-new-input"
              submitTestId="run-comments-add"
              placeholder="Reply to reviewers… (Enter to send, Shift+Enter for a new line)"
            />
          </Surface>

          <ErrorBanner
            errorSource="run-comments-error"
            className=""
            error={error}
            testId="run-comments-error"
          />
        </div>
      )}
    </DialogModal>
  );
}

/**
 * Project a wire comment author into the shared `PlanReviewAuthor` shape. Run
 * comments are always authored by an authenticated principal, so `kind` is
 * always `'user'`; a deleted author row arrives with an empty `userId` and
 * renders as an unresolvable name rather than dropping the comment.
 */
function toReviewAuthor(
  comment: SharedRunComment,
  viewerUserId: string | null,
): PlanReviewAuthor {
  const name =
    comment.author.displayName && comment.author.displayName.length > 0
      ? comment.author.displayName
      : 'Unknown';
  return {
    name,
    kind: 'user',
    isYou:
      viewerUserId !== null &&
      comment.author.userId.length > 0 &&
      comment.author.userId === viewerUserId,
  };
}

/** Short, single-line preview of the message a thread is anchored to. */
function anchorReferenceText(
  thread: SharedRunCommentThread,
  detail: SharedRunDetail,
): string | null {
  if (thread.anchor.kind !== 'message') {
    return null;
  }
  if (thread.anchorState === 'orphaned') {
    // Expected, not exceptional: truncation, the `helper:` filter, or a
    // narrowed re-share can drop the anchored message. Say so rather than
    // hiding the thread.
    return 'Anchored message is no longer in this run';
  }
  const anchorMessageId = thread.anchor.messageId;
  const message = detail.messages.find((m) => m.messageId === anchorMessageId);
  const text = message?.text.replace(/\s+/g, ' ').trim() ?? '';
  if (text.length === 0) {
    return 'On a transcript message';
  }
  return text.length > 120 ? `“${text.slice(0, 120)}…”` : `“${text}”`;
}

function RunCommentThreadCard({
  target,
  thread,
  detail,
  onDetail,
}: {
  target: RunCommentsTarget;
  thread: SharedRunCommentThread;
  detail: SharedRunDetail;
  onDetail: (detail: SharedRunDetail | null) => boolean;
}): JSX.Element {
  const [reply, setReply] = useState('');
  const [pending, setPending] = useState(false);
  const [collapsed, setCollapsed] = useState(thread.status === 'resolved');

  const submitReply = async (): Promise<void> => {
    const body = reply.trim();
    if (body.length === 0 || pending) {
      return;
    }
    setPending(true);
    try {
      const result = await window.api.runs.replyToCommentThread({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
        threadId: thread.id,
        body,
      });
      if (onDetail(result.detail)) {
        setReply('');
      }
    } catch {
      onDetail(null);
    } finally {
      setPending(false);
    }
  };

  const toggleStatus = async (): Promise<void> => {
    if (pending) {
      return;
    }
    setPending(true);
    const next = thread.status === 'resolved' ? 'open' : 'resolved';
    try {
      const result = await window.api.runs.setCommentThreadStatus({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
        threadId: thread.id,
        status: next,
      });
      if (onDetail(result.detail)) {
        setCollapsed(next === 'resolved');
      }
    } catch {
      onDetail(null);
    } finally {
      setPending(false);
    }
  };

  const referenceText = anchorReferenceText(thread, detail);
  const firstComment = thread.comments[0];
  const reference = referenceText
    ? { text: referenceText, outdated: thread.anchorState === 'orphaned' }
    : collapsed && firstComment
      ? { text: firstComment.body }
      : undefined;

  return (
    <PlanReviewThread
      dataTestId="run-comment-thread"
      dataAttributes={{
        'data-thread-status': thread.status,
        'data-anchor-kind': thread.anchor.kind,
        'data-anchor-state': thread.anchorState,
      }}
      status={thread.status}
      commentCount={thread.comments.length}
      reference={reference}
      collapsed={collapsed}
      compact
      onToggleCollapsed={(): void => setCollapsed((value) => !value)}
      footer={
        <PlanCommentComposer
          value={reply}
          onChange={setReply}
          onSubmit={() => void submitReply()}
          submitLabel="Reply"
          compact
          submitDisabled={pending || reply.trim().length === 0}
          inputTestId="run-comment-reply-input"
          submitTestId="run-comment-reply-submit"
          secondaryAction={{
            label: thread.status === 'resolved' ? 'Reopen' : 'Resolve',
            onClick: () => void toggleStatus(),
            dataTestId: 'run-comment-resolve-toggle',
          }}
        />
      }
    >
      {thread.comments.map((comment) => (
        <PlanReviewComment
          key={comment.id}
          dataTestId="run-comment"
          author={toReviewAuthor(comment, detail.viewerUserId)}
          timestamp={comment.createdAt}
          compact
        >
          <div className={PROSE_CLASS}>
            <Markdown options={MARKDOWN_OPTIONS}>{comment.body}</Markdown>
          </div>
        </PlanReviewComment>
      ))}
    </PlanReviewThread>
  );
}

/**
 * Global host for the run-comments modal. Mounted once in `App.tsx` so the
 * panel can be opened from the turn footer, the chat tab-bar session menu, the
 * share-control manage popover, or an OS-notification click without each call
 * site owning modal state.
 */
export function RunCommentsModalHost(): JSX.Element | null {
  const target = useRunCommentsStore((state) => state.target);
  const close = useRunCommentsStore((state) => state.close);
  if (!target) {
    return null;
  }
  return <RunCommentsModal target={target} onClose={close} />;
}
