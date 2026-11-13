import { describeReviewCommentContext } from '@canopy/desktop-shared/types/code-review';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatSendMessageRequest,
  FileAnnotationDocument,
  ReviewAnnotation,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';

export type FileCommentSubmitHiddenContext = Extract<
  NonNullable<ChatSendMessageRequest['hiddenContext']>,
  { kind: 'file-comment-instructions' }
>;

const FILE_COMMENT_SUBMIT_HIDDEN_CONTEXT_TEXT =
  '<system_instruction>For each file comment thread: inspect the referenced view, comparison, side, snapshot, and quoted lines before answering. Diff coordinates are not current-file coordinates; outdated anchors require verification. Comments may be questions; do not assume a change is requested when ambiguous. Use GetFileComments to read full thread history. After addressing a thread, use RespondToFileComment to reply and resolve it, or leave it open and ask for clarification. Apply clearly requested changes directly.</system_instruction>';

export interface UseFileComments {
  document: FileAnnotationDocument;
  /** Both origins for the shared drawer; editor markers still use document. */
  drawerThreads?: ReviewCommentThread[];
  stagedCount: number;
  otherViewCount: number;
  view: 'file' | 'diff';
  addComment: (anchor: ReviewCommentAnchor, body: string) => void;
  discussAnnotation: (annotation: ReviewAnnotation, body: string) => void;
  addReply: (threadId: string, body: string) => void;
  editStagedComment: (
    threadId: string,
    commentId: string,
    body: string,
  ) => void;
  deleteStagedComment: (threadId: string, commentId: string) => void;
  toggleResolved: (threadId: string) => void;
  dismissAnnotation: (annotationId: string) => void;
  submit: (
    send: (
      message: string,
      hiddenContext: FileCommentSubmitHiddenContext,
    ) => Promise<boolean>,
  ) => Promise<void>;
}

function emptyDocument(filePath: string): FileAnnotationDocument {
  return { filePath, annotations: [], commentThreads: [] };
}

function countStaged(threads: ReviewCommentThread[]): number {
  return threads.reduce(
    (count, thread) =>
      thread.status === 'open'
        ? count +
          thread.comments.filter((comment) => comment.staged === true).length
        : count,
    0,
  );
}

function formatLocation(anchor: ReviewCommentAnchor, filePath: string): string {
  if (anchor.unanchored) return filePath;
  const start = anchor.lineStart;
  const end = anchor.lineEnd ?? start;
  if (start === undefined) return filePath;
  return end !== undefined && end !== start
    ? `${filePath}:${start}-${end}`
    : `${filePath}:${start}`;
}

export interface FileCommentSubmitPayload {
  message: string;
  submittedComments: ReadonlyMap<string, string>;
}

export function prepareFileCommentSubmit(
  document: FileAnnotationDocument,
): FileCommentSubmitPayload {
  const entries = document.commentThreads.flatMap((thread) => {
    if (thread.status !== 'open') return [];
    const staged = thread.comments.filter((comment) => comment.staged === true);
    return staged.length ? [{ thread, staged }] : [];
  });
  const submittedComments = new Map<string, string>();
  for (const { staged } of entries) {
    for (const comment of staged) {
      submittedComments.set(comment.id, comment.body);
    }
  }
  if (entries.length === 0) {
    return { message: '', submittedComments };
  }

  const sections = entries.map(({ thread, staged }, index) => {
    const lines = [
      `${index + 1}. ${thread.anchor.view === 'diff' ? 'Diff' : 'File'} comment thread \`${thread.id}\`:`,
      `   - Location: ${formatLocation(thread.anchor, document.filePath)}`,
    ];
    lines.push(
      `   - Context: ${describeReviewCommentContext(thread.anchor)}; anchor ${thread.anchorState}`,
    );
    if (!thread.anchor.unanchored && thread.anchor.quote.trim()) {
      lines.push('   - Selected file text:');
      lines.push('     ```');
      for (const line of thread.anchor.quote.split('\n')) {
        lines.push(`     ${line}`);
      }
      lines.push('     ```');
    }
    for (const comment of staged) {
      lines.push(`   - Comment: ${comment.body}`);
    }
    return lines.join('\n');
  });

  return {
    message: [
      `I have ${entries.length} file comment thread${entries.length === 1 ? '' : 's'} to review.`,
      '',
      ...sections,
    ].join('\n'),
    submittedComments,
  };
}

export function composeFileCommentSubmitMessage(
  document: FileAnnotationDocument,
): string {
  return prepareFileCommentSubmit(document).message;
}

export function markFileCommentsSubmitted(
  document: FileAnnotationDocument,
  submittedComments: ReadonlyMap<string, string>,
): FileAnnotationDocument {
  return {
    ...document,
    commentThreads: document.commentThreads.map((thread) => ({
      ...thread,
      comments: thread.comments.map((comment) =>
        submittedComments.has(comment.id) &&
        submittedComments.get(comment.id) === comment.body
          ? { ...comment, staged: false }
          : comment,
      ),
    })),
  };
}

function hiddenContext(): FileCommentSubmitHiddenContext {
  return {
    kind: 'file-comment-instructions',
    text: FILE_COMMENT_SUBMIT_HIDDEN_CONTEXT_TEXT,
  };
}

function withEffectiveDiffState(
  document: FileAnnotationDocument,
  diff: ReviewCommentAnchor['diff'] | undefined,
): FileAnnotationDocument {
  return {
    ...document,
    commentThreads: document.commentThreads.map((thread) =>
      thread.anchor.view === 'diff' &&
      (!diff || thread.anchor.diff?.snapshotId !== diff.snapshotId)
        ? { ...thread, anchorState: 'outdated' as const }
        : thread,
    ),
  };
}

type DocumentUpdate = (
  current: FileAnnotationDocument,
) => FileAnnotationDocument;

/** Refreshes and retries before leaving a refused edit for the next one. */
const MAX_SAVE_REBASES = 3;

/**
 * One file's comment state against main: the last document main acknowledged
 * and the edits not yet saved on top of it. Saves run one at a time, each
 * against the acknowledged revision; a refused save is replayed on a fresh
 * document, so no acknowledged change from another window or agent is lost.
 * Edits are idempotent so replaying one over a document that has it is a no-op.
 */
interface CommentSession {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly filePath: string;
  acknowledged: FileAnnotationDocument;
  pending: DocumentUpdate[];
  flushing: Promise<void> | null;
}

function isOlderRevision(
  next: FileAnnotationDocument,
  current: FileAnnotationDocument,
): boolean {
  return (
    next.revision !== undefined &&
    current.revision !== undefined &&
    next.revision < current.revision
  );
}

export function useFileComments(
  projectId: string,
  worktreeId: string,
  filePath: string,
  view: 'file' | 'diff' = 'file',
  diff?: ReviewCommentAnchor['diff'],
  diffAnnotations?: ReviewAnnotation[],
): UseFileComments {
  const [document, setDocument] = useState<FileAnnotationDocument>(() =>
    emptyDocument(filePath),
  );
  const documentRef = useRef(document);
  const submitInFlightRef = useRef(false);
  const sessionRef = useRef<CommentSession | null>(null);
  const replaceDocument = useCallback((next: FileAnnotationDocument): void => {
    documentRef.current = next;
    setDocument(next);
  }, []);

  /**
   * Shows the acknowledged document with the session's unsaved edits on top.
   * A stale document is discarded, but the view is still rebuilt: the save
   * that returned it retired its edit, whose optimistic state must go too.
   */
  const acknowledge = useCallback(
    (
      session: CommentSession,
      next: FileAnnotationDocument,
      authoritative = false,
    ): void => {
      if (authoritative || !isOlderRevision(next, session.acknowledged))
        session.acknowledged = next;
      if (sessionRef.current !== session) return;
      replaceDocument(
        session.pending.reduce(
          (current, update) => update(current),
          session.acknowledged,
        ),
      );
    },
    [replaceDocument],
  );

  const flush = useCallback(
    (session: CommentSession): Promise<void> => {
      if (session.flushing) return session.flushing;
      // A run must reach its first save before it can end, or it would stay
      // registered after it finished.
      if (session.pending.length === 0) return Promise.resolve();
      const run = (async (): Promise<void> => {
        let rebases = 0;
        try {
          for (;;) {
            const update = session.pending[0];
            if (!update) return;
            const base = session.acknowledged;
            try {
              const saved = await window.api.fileAnnotations.save({
                projectId: session.projectId,
                worktreeId: session.worktreeId,
                document: update(base),
                baseCommentThreadIds: base.commentThreads.map(
                  (thread) => thread.id,
                ),
                ...(base.revision !== undefined
                  ? { expectedRevision: base.revision }
                  : {}),
              });
              session.pending.shift();
              rebases = 0;
              acknowledge(session, saved);
            } catch {
              // A refused save means another write landed first: replay the
              // edit on the latest document. Any other failure keeps the
              // edits pending, and the next edit retries them.
              let latest: FileAnnotationDocument;
              try {
                latest = await window.api.fileAnnotations.get({
                  projectId: session.projectId,
                  worktreeId: session.worktreeId,
                  filePath: session.filePath,
                });
              } catch {
                return;
              }
              const moved = latest.revision !== base.revision;
              acknowledge(session, latest, true);
              if (!moved || ++rebases > MAX_SAVE_REBASES) return;
            }
          }
        } finally {
          // Cleared in the same step the run ends, so an edit queued after it
          // starts a new run instead of joining this finished one.
          session.flushing = null;
        }
      })();
      session.flushing = run;
      return run;
    },
    [acknowledge],
  );

  useEffect(() => {
    const session: CommentSession = {
      projectId,
      worktreeId,
      filePath,
      acknowledged: emptyDocument(filePath),
      pending: [],
      flushing: null,
    };
    sessionRef.current = session;
    replaceDocument(emptyDocument(filePath));
    void window.api.fileAnnotations
      .get({ projectId, worktreeId, filePath })
      .then((next) => acknowledge(session, next, true))
      .catch(() => {
        // Keep the empty local document when persisted annotations cannot be
        // loaded. A later update event can still restore the shared state.
      });
    const unsubscribe = window.api.fileAnnotations.onUpdated((event) => {
      if (
        event.projectId === projectId &&
        event.worktreeId === worktreeId &&
        event.document.filePath === filePath
      ) {
        acknowledge(session, event.document);
      }
    });
    return (): void => {
      // Edits already queued still save; the view stops following them.
      if (sessionRef.current === session) sessionRef.current = null;
      unsubscribe();
    };
  }, [acknowledge, filePath, projectId, replaceDocument, worktreeId]);

  const persist = useCallback(
    (update: DocumentUpdate): Promise<void> => {
      const session = sessionRef.current;
      if (!session) return Promise.resolve();
      session.pending.push(update);
      replaceDocument(update(documentRef.current));
      return flush(session);
    },
    [flush, replaceDocument],
  );

  const addComment = useCallback(
    (anchor: ReviewCommentAnchor, body: string): void => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const now = new Date().toISOString();
      const { diff: anchorDiff, ...anchorWithoutDiff } = anchor;
      const identity = anchorDiff ?? diff;
      const thread: ReviewCommentThread = {
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now,
        anchor: {
          ...anchorWithoutDiff,
          ...(view === 'diff' && identity
            ? { view: 'diff' as const, diff: identity }
            : { view: 'file' as const }),
        },
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
      void persist((current) =>
        current.commentThreads.some((entry) => entry.id === thread.id)
          ? current
          : { ...current, commentThreads: [...current.commentThreads, thread] },
      );
    },
    [persist, view, diff],
  );

  const discussAnnotation = useCallback(
    (annotation: ReviewAnnotation, body: string): void => {
      addComment(
        {
          source: 'code',
          repoId: annotation.repoId,
          filePath,
          side: annotation.side,
          lineStart: annotation.lineStart,
          lineEnd: annotation.lineEnd,
          quote: '',
          annotationId: annotation.id,
        },
        body,
      );
    },
    [addComment, filePath],
  );

  const addReply = useCallback(
    (threadId: string, body: string): void => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const comment: ReviewComment = {
        id: crypto.randomUUID(),
        author: 'user',
        body: trimmed,
        createdAt: new Date().toISOString(),
        staged: true,
      };
      void persist((current) => ({
        ...current,
        commentThreads: current.commentThreads.map((thread) =>
          thread.id === threadId &&
          !thread.comments.some((entry) => entry.id === comment.id)
            ? { ...thread, comments: [...thread.comments, comment] }
            : thread,
        ),
      }));
    },
    [persist],
  );

  const editStagedComment = useCallback(
    (threadId: string, commentId: string, body: string): void => {
      const trimmed = body.trim();
      if (!trimmed) return;
      void persist((current) => ({
        ...current,
        commentThreads: current.commentThreads.map((thread) =>
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
        ),
      }));
    },
    [persist],
  );

  const deleteStagedComment = useCallback(
    (threadId: string, commentId: string): void => {
      void persist((current) => ({
        ...current,
        commentThreads: current.commentThreads.flatMap((thread) => {
          if (thread.id !== threadId) return [thread];
          const comments = thread.comments.filter(
            (comment) => comment.id !== commentId || comment.staged !== true,
          );
          return comments.length ? [{ ...thread, comments }] : [];
        }),
      }));
    },
    [persist],
  );

  const toggleResolved = useCallback(
    (threadId: string): void => {
      const target = documentRef.current.commentThreads.find(
        (thread) => thread.id === threadId,
      );
      if (!target) return;
      // The status is chosen now, so replaying the edit cannot flip it back.
      const status = target.status === 'open' ? 'resolved' : 'open';
      void persist((current) => ({
        ...current,
        commentThreads: current.commentThreads.map((thread) =>
          thread.id === threadId ? { ...thread, status } : thread,
        ),
      }));
    },
    [persist],
  );

  const dismissAnnotation = useCallback(
    (annotationId: string): void => {
      const session = sessionRef.current;
      if (!session) return;
      void window.api.fileAnnotations
        .dismiss({ projectId, worktreeId, filePath, annotationId })
        .then((next) => acknowledge(session, next))
        .catch(() => {
          // Leave the annotation visible when persistence rejects the
          // dismissal so the UI never implies it was successfully cleared.
        });
    },
    [acknowledge, filePath, projectId, worktreeId],
  );

  const submit = useCallback(
    async (
      send: (
        message: string,
        context: FileCommentSubmitHiddenContext,
      ) => Promise<boolean>,
    ): Promise<void> => {
      if (submitInFlightRef.current) return;
      const effective = withEffectiveDiffState(documentRef.current, diff);
      const { message, submittedComments } =
        prepareFileCommentSubmit(effective);
      if (!message) return;
      submitInFlightRef.current = true;
      try {
        let sent = false;
        try {
          sent = await send(message, hiddenContext());
        } catch {
          sent = false;
        }
        if (!sent) return;

        // Dispatch was accepted, so the comments stay submitted locally even
        // if persistence fails; the edit stays queued for the next save.
        await persist((current) =>
          markFileCommentsSubmitted(current, submittedComments),
        );
      } finally {
        submitInFlightRef.current = false;
      }
    },
    [diff, persist],
  );

  // The drawer and header must agree about which threads are active. A retained
  // comparison can become outdated without its stored open/resolved status changing.
  const effectiveDocument = useMemo(
    () => withEffectiveDiffState(document, diff),
    [document, diff],
  );
  const drawerThreads = effectiveDocument.commentThreads;
  const visibleDocument = useMemo(
    () => ({
      ...effectiveDocument,
      annotations:
        view === 'file'
          ? effectiveDocument.annotations
          : (diffAnnotations ?? []),
      commentThreads: drawerThreads.filter(
        (thread) => (thread.anchor.view ?? 'file') === view,
      ),
    }),
    [effectiveDocument, view, drawerThreads, diffAnnotations],
  );
  const otherViewCount = drawerThreads.filter(
    (thread) =>
      thread.status === 'open' &&
      thread.anchorState !== 'outdated' &&
      (thread.anchor.view ?? 'file') !== view,
  ).length;

  const stagedCount = useMemo(
    () => countStaged(effectiveDocument.commentThreads),
    [effectiveDocument.commentThreads],
  );

  return {
    document: visibleDocument,
    drawerThreads,
    view,
    otherViewCount,
    stagedCount,
    addComment,
    discussAnnotation,
    addReply,
    editStagedComment,
    deleteStagedComment,
    toggleResolved,
    dismissAnnotation,
    submit,
  };
}
