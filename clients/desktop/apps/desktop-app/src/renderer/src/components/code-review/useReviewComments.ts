import { describeReviewCommentContext } from '@canopy/desktop-shared/types/code-review';
import { toAppError } from '@canopy/protocol/app-errors';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import type {
  ChatSendMessageRequest,
  CodeReviewFile,
  CodeReviewStateMutationFailure,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type { AddNodeCommentInput } from '@/components/plan-explore/usePlanComments';
import type { CodeReviewTarget } from '@/stores/codeReviewStore';
import { extractIpcErrorMessage } from '@/lib/errors';

/**
 * Single source of truth for a code review's comment threads. Owns the
 * `threads` state, persistence (`window.api.codeReview.saveComments`), and
 * every mutation (code-line comments, diagram-node comments, replies,
 * deletes, resolve toggles, submit-to-chat). Modeled directly on
 * `usePlanComments.ts` — read that file side-by-side when changing this one.
 */

export type ReviewCommentSubmitHiddenContext = Extract<
  NonNullable<ChatSendMessageRequest['hiddenContext']>,
  { kind: 'file-comment-instructions' }
>;

export const REVIEW_COMMENT_SUBMIT_HIDDEN_CONTEXT_TEXT =
  '<system_instruction>For each comment thread: inspect the referenced code before answering, using git and file reads in this worktree. Comments may simply be questions; do not assume changes are requested if a comment is ambiguous. After addressing a thread, use RespondToFileComment with its thread id to post a short reply and resolve it (or leave it open and ask for clarification). Use GetFileComments with a thread id to read the full conversation if a thread already has earlier replies. When a fix is clearly requested, apply it directly and describe the change in your reply.</system_instruction>';

export interface UseReviewComments {
  threads: ReviewCommentThread[];
  stagedCount: number;
  readOnly: boolean;
  error: string | null;
  hasUnsavedChanges: boolean;
  addCodeComment: (anchor: ReviewCommentAnchor, body: string) => void;
  addDiagramComment: (input: AddNodeCommentInput) => void;
  /** A general note not attached to any code line or diagram node. */
  addGeneralComment: (body: string) => void;
  addReply: (threadId: string, body: string) => void;
  editStagedComment: (
    threadId: string,
    commentId: string,
    body: string,
  ) => void;
  deleteStagedComment: (threadId: string, commentId: string) => void;
  toggleResolved: (threadId: string) => void;
  submit: (
    send: (
      message: string,
      hiddenContext: ReviewCommentSubmitHiddenContext,
    ) => Promise<boolean>,
  ) => Promise<void>;
}

/**
 * A comment is pending submission to the chat agent when it is still an
 * un-submitted draft. Unlike plan comments, review comments have no
 * `'remote'` author/`submittedToChat` handoff concept — only the owner's own
 * staged drafts are ever pending.
 */
export function isPendingSubmission(comment: ReviewComment): boolean {
  return comment.staged === true;
}

function countPendingComments(threads: ReviewCommentThread[]): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.status !== 'open') {
      continue;
    }
    for (const comment of thread.comments) {
      if (isPendingSubmission(comment)) {
        count += 1;
      }
    }
  }
  return count;
}

export function formatCodeLocation(anchor: ReviewCommentAnchor): string {
  const repoPrefix = anchor.repoId ? `${anchor.repoId}/` : '';
  const path = anchor.filePath ?? '';
  const lineRef =
    anchor.lineStart == null
      ? ''
      : anchor.lineEnd != null && anchor.lineEnd !== anchor.lineStart
        ? `:${anchor.lineStart}-${anchor.lineEnd}`
        : `:${anchor.lineStart}`;
  const sideLabel = anchor.side === 'old' ? 'old' : 'new';
  return `${repoPrefix}${path}${lineRef} (${sideLabel} side)`;
}

export function diagramLocationLabel(anchor: ReviewCommentAnchor): string {
  const kindLabel =
    anchor.diagramKind === 'dataModelDiff' ? 'data model' : 'logic';
  return `${kindLabel} diagram node "${anchor.quote}"`;
}

export function composeReviewCommentSubmitHiddenContext(): ReviewCommentSubmitHiddenContext {
  return {
    kind: 'file-comment-instructions',
    text: REVIEW_COMMENT_SUBMIT_HIDDEN_CONTEXT_TEXT,
  };
}

/**
 * Compose the chat-handoff message for all open threads with staged drafts.
 * Each section carries a stable thread id (so the agent can use
 * RespondToFileComment / GetFileComments) plus enough anchor context — the
 * repo/file/line locator and, for code anchors, the exact quoted source lines
 * in a fenced block — for the agent to locate the passage. Returns an empty
 * string when nothing is pending.
 */
export function composeReviewCommentSubmitMessage(
  threads: ReviewCommentThread[],
): string {
  const entries: { thread: ReviewCommentThread; pending: ReviewComment[] }[] =
    [];
  for (const thread of threads) {
    if (thread.status !== 'open') {
      continue;
    }
    const pending = thread.comments.filter(isPendingSubmission);
    if (pending.length > 0) {
      entries.push({ thread, pending });
    }
  }

  if (entries.length === 0) {
    return '';
  }

  const sections = entries.map((entry, i) => {
    const number = i + 1;
    const { thread } = entry;
    const { anchor } = thread;

    const lines: string[] = [
      `${number}. Comment thread \`${thread.id}\`:`,
      `   - Context: ${describeReviewCommentContext(anchor.source === 'code' ? { ...anchor, view: 'diff' } : anchor)}`,
    ];

    if (anchor.source === 'diagram') {
      lines.push(`   - Location: ${diagramLocationLabel(anchor)}`);
    } else if (anchor.unanchored) {
      lines.push('   - Location: general note');
    } else {
      lines.push(`   - Location: ${formatCodeLocation(anchor)}`);
      lines.push('   - Quoted code:');
      lines.push('     ```code');
      for (const sourceLine of anchor.quote.split('\n')) {
        lines.push(`     ${sourceLine}`);
      }
      lines.push('     ```');
    }

    for (const comment of entry.pending) {
      lines.push(`   - Comment: ${comment.body}`);
    }
    return lines.join('\n');
  });

  const threadWord =
    entries.length === 1 ? 'comment thread' : 'comment threads';

  return [
    `I have ${entries.length} ${threadWord} on this branch's changes.`,
    '',
    ...sections,
  ].join('\n');
}

export function useReviewComments(
  target: CodeReviewTarget,
  review: CodeReviewFile | null,
  diagramOnly: boolean | ((thread: ReviewCommentThread) => boolean) = false,
  mutationFailure?: CodeReviewStateMutationFailure,
): UseReviewComments {
  const [threads, setThreads] = useState<ReviewCommentThread[]>(
    review?.commentThreads ?? [],
  );

  const submitInFlight = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const session = useMemo<{
    scope: CodeReviewTarget;
    threads: ReviewCommentThread[];
    pending: Set<Promise<void>>;
    projection: ReviewCommentThread[] | null;
    projectionRevision: number;
    failure: string | null;
    refused: boolean;
    hasReadableProjection: boolean;
    active: boolean;
  }>(
    () => ({
      scope: { projectId: target.projectId, worktreeId: target.worktreeId },
      threads: [],
      pending: new Set<Promise<void>>(),
      projection: null,
      projectionRevision: 0,
      failure: null,
      refused: false,
      hasReadableProjection: false,
      active: true,
    }),
    [target.projectId, target.worktreeId],
  );

  useEffect(() => {
    session.active = true;
    setSaveError(null);
    setRefreshError(null);
    return (): void => {
      session.active = false;
    };
  }, [session]);

  // Re-derive threads from the persisted review whenever its comment threads
  // change (live reload from the codeReviewUpdated event).
  useEffect(() => {
    session.projectionRevision += 1;
    session.refused = mutationFailure !== undefined;
    setRefreshError(null);
    if (session.failure) return;
    // A refused empty projection is not evidence of deletion, including
    // lossy state with missing/malformed commentThreads.
    if (
      mutationFailure &&
      (mutationFailure.reason !== 'lossy_state' ||
        (review?.commentThreads.length ?? 0) === 0) &&
      session.hasReadableProjection
    ) {
      return;
    }
    session.hasReadableProjection =
      review?.commentThreads !== undefined &&
      (!mutationFailure || mutationFailure.reason === 'lossy_state');
    // Buffer live projections without replacing input that may still fail.
    if (session.pending.size > 0) {
      session.projection = review?.commentThreads ?? [];
      return;
    }
    session.threads = review?.commentThreads ?? [];
    setThreads(session.threads);
  }, [review?.commentThreads, session, mutationFailure]);

  const updateThreads = useCallback(
    (
      update: (current: ReviewCommentThread[]) => ReviewCommentThread[],
    ): void => {
      if (!session.active || session.refused || session.failure) return;
      const current = session.threads;
      const nextThreads = update(current);
      session.threads = nextThreads;
      setThreads(nextThreads);
      // Persist outside React's updater: replay must not issue another write.
      const save = (async (): Promise<void> => {
        try {
          const saved = await window.api.codeReview.saveComments({
            ...session.scope,
            commentThreads: nextThreads,
            baseCommentThreadIds: current.map((thread) => thread.id),
            baseCommentThreads: current,
          });
          if (saved === null) throw new Error("Couldn't save comments.");
          if (
            session.active &&
            !session.failure &&
            session.threads === nextThreads
          ) {
            session.hasReadableProjection = true;
            session.threads = saved.commentThreads;
            setThreads(saved.commentThreads);
          }
        } catch (error) {
          const classified = toAppError(error);
          if (!session.active) return;
          const message = extractIpcErrorMessage(
            classified?.detail.message ?? error,
          ).trim();
          session.failure =
            (message !== 'Unknown error' && message) ||
            "Couldn't save comments.";
          setSaveError(session.failure);
        }
      })();
      session.pending.add(save);
      void save.then(async () => {
        session.pending.delete(save);
        if (
          !session.active ||
          session.failure ||
          session.pending.size > 0 ||
          session.projection === null
        ) {
          return;
        }
        session.projection = null;
        const acknowledged = session.threads;
        const projectionRevision = session.projectionRevision;
        // The save handler broadcasts its captured snapshot after fingerprint
        // awaits, possibly after a newer agent event. Its broadcast precedes
        // its IPC reply: read current state only after the batch settles.
        try {
          const latest = await window.api.codeReview.get(session.scope);
          if (
            session.active &&
            !session.failure &&
            session.pending.size === 0 &&
            // Refused live updates retain thread identity but supersede reads.
            session.projectionRevision === projectionRevision &&
            session.threads === acknowledged
          ) {
            if (latest.mutationFailure) {
              session.refused = true;
              setRefreshError(latest.mutationFailure.message);
              if (
                latest.mutationFailure.reason !== 'lossy_state' ||
                latest.review.commentThreads.length === 0
              )
                return;
            }
            session.threads = latest.review?.commentThreads ?? [];
            setThreads(session.threads);
          }
        } catch (error) {
          reportClientAppError(error);
          // A refresh failure cannot undo an acknowledged save. Retain its
          // threads until the next live update.
        }
      });
    },
    [session],
  );

  const addCodeComment = useCallback(
    (anchor: ReviewCommentAnchor, body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const now = new Date().toISOString();
      const thread: ReviewCommentThread = {
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now,
        anchor: { ...anchor, source: 'code' },
        anchorState: 'matched',
        comments: [
          {
            id: crypto.randomUUID(),
            author: 'user',
            body: trimmed,
            createdAt: now,
            staged: true,
          },
        ],
      };
      updateThreads((current) => {
        const next = [...current, thread];
        return next;
      });
    },
    [updateThreads],
  );

  const addDiagramComment = useCallback(
    (input: AddNodeCommentInput): void => {
      const trimmed = input.body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const now = new Date().toISOString();
      const anchor: ReviewCommentAnchor = {
        source: 'diagram',
        diagramKind:
          input.diagramKind === 'dataModelDiff' ? 'dataModelDiff' : 'logicDiff',
        nodeId: input.nodeId,
        quote: input.title,
        unanchored: false,
        diagramFingerprint:
          review?.diagrams[
            input.diagramKind === 'dataModelDiff'
              ? 'dataModelDiff'
              : 'logicDiff'
          ]?.derivedFromFingerprint,
      };
      const thread: ReviewCommentThread = {
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now,
        anchor,
        anchorState: 'matched',
        comments: [
          {
            id: crypto.randomUUID(),
            author: 'user',
            body: trimmed,
            createdAt: now,
            staged: true,
          },
        ],
      };
      updateThreads((current) => {
        const next = [...current, thread];
        return next;
      });
    },
    [updateThreads, review?.diagrams],
  );

  const addGeneralComment = useCallback(
    (body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const now = new Date().toISOString();
      const thread: ReviewCommentThread = {
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now,
        anchor: { source: 'code', quote: '', unanchored: true },
        anchorState: 'matched',
        comments: [
          {
            id: crypto.randomUUID(),
            author: 'user',
            body: trimmed,
            createdAt: now,
            staged: true,
          },
        ],
      };
      updateThreads((current) => {
        const next = [...current, thread];
        return next;
      });
    },
    [updateThreads],
  );

  const addReply = useCallback(
    (threadId: string, body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const comment: ReviewComment = {
        id: crypto.randomUUID(),
        author: 'user',
        body: trimmed,
        createdAt: new Date().toISOString(),
        staged: true,
      };
      updateThreads((current) => {
        const next = current.map((thread) =>
          thread.id === threadId
            ? { ...thread, comments: [...thread.comments, comment] }
            : thread,
        );
        return next;
      });
    },
    [updateThreads],
  );

  const editStagedComment = useCallback(
    (threadId: string, commentId: string, body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      updateThreads((current) => {
        const next = current.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                comments: thread.comments.map((comment) =>
                  comment.id === commentId && comment.staged === true
                    ? { ...comment, body: trimmed }
                    : comment,
                ),
              }
            : thread,
        );
        return next;
      });
    },
    [updateThreads],
  );

  // Fully remove a staged (not-yet-submitted) comment. When it was the
  // thread's only comment, the thread — and its anchor marker — is removed
  // too.
  const deleteStagedComment = useCallback(
    (threadId: string, commentId: string): void => {
      updateThreads((current) => {
        const next: ReviewCommentThread[] = [];
        for (const thread of current) {
          if (thread.id !== threadId) {
            next.push(thread);
            continue;
          }
          const comments = thread.comments.filter(
            (comment) => comment.id !== commentId || comment.staged !== true,
          );
          if (comments.length > 0) {
            next.push({ ...thread, comments });
          }
          // else: drop the now-empty thread entirely.
        }
        return next;
      });
    },
    [updateThreads],
  );

  const toggleResolved = useCallback(
    (threadId: string): void => {
      updateThreads((current) => {
        const next: ReviewCommentThread[] = current.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                status: thread.status === 'open' ? 'resolved' : 'open',
              }
            : thread,
        );
        return next;
      });
    },
    [updateThreads],
  );

  const submit = useCallback(
    async (
      send: (
        message: string,
        hiddenContext: ReviewCommentSubmitHiddenContext,
      ) => Promise<boolean>,
    ): Promise<void> => {
      if (submitInFlight.current || session.refused || session.failure) return;
      await Promise.all(session.pending);
      if (
        !session.active ||
        submitInFlight.current ||
        session.refused ||
        session.failure ||
        session.pending.size > 0
      ) {
        return;
      }
      const submitting = session.threads.filter((thread) =>
        typeof diagramOnly === 'function'
          ? diagramOnly(thread)
          : !diagramOnly || thread.anchor.source === 'diagram',
      );
      const message = composeReviewCommentSubmitMessage(submitting);
      if (!message) {
        return;
      }
      // Snapshot exactly which comments this submission carried so the
      // post-send flip only touches those. Comments added while `send` is in
      // flight keep `staged: true`; the update reads the latest session.
      const submittedCommentIds = new Map<string, string>();
      for (const thread of submitting) {
        if (thread.status !== 'open') {
          continue;
        }
        for (const comment of thread.comments) {
          if (isPendingSubmission(comment)) {
            submittedCommentIds.set(comment.id, comment.body);
          }
        }
      }
      submitInFlight.current = true;
      let sent = false;
      try {
        sent = await send(message, composeReviewCommentSubmitHiddenContext());
      } finally {
        submitInFlight.current = false;
      }
      if (!sent) {
        return;
      }
      updateThreads((current) => {
        const next = current.map((thread) => ({
          ...thread,
          comments: thread.comments.map((comment) =>
            comment.staged === true &&
            submittedCommentIds.get(comment.id) === comment.body
              ? { ...comment, staged: false }
              : comment,
          ),
        }));
        return next;
      });
    },
    [updateThreads, diagramOnly, session],
  );

  const visibleThreads = useMemo(
    () =>
      threads.filter((thread) =>
        typeof diagramOnly === 'function'
          ? diagramOnly(thread)
          : !diagramOnly || thread.anchor.source === 'diagram',
      ),
    [threads, diagramOnly],
  );
  const stagedCount = useMemo(
    () => countPendingComments(visibleThreads),
    [visibleThreads],
  );

  return {
    threads: visibleThreads,
    stagedCount,
    readOnly:
      mutationFailure !== undefined ||
      saveError !== null ||
      refreshError !== null,
    error: saveError ?? refreshError ?? mutationFailure?.message ?? null,
    hasUnsavedChanges: saveError !== null,
    addCodeComment,
    addDiagramComment,
    addGeneralComment,
    addReply,
    editStagedComment,
    deleteStagedComment,
    toggleResolved,
    submit,
  };
}
