import type { UseFileComments } from './useFileComments';
import type { UseReviewComments } from '../code-review/useReviewComments';

/** Preserve legacy review storage while presenting its code threads in the diff view. */
export function mergeFileReviewComments(
  file: UseFileComments,
  review: UseReviewComments,
): UseFileComments {
  const legacyIds = new Set(review.threads.map((thread) => thread.id));
  const legacyThreads = review.threads.map((thread) => ({
    ...thread,
    anchor: { ...thread.anchor, view: 'diff' as const },
    // Retained legacy coordinates have no immutable comparison identity.
    anchorState: 'outdated' as const,
  }));
  return {
    ...file,
    isThreadReadOnly: (id) =>
      legacyIds.has(id)
        ? review.readOnly
        : (file.isThreadReadOnly?.(id) ?? false),
    // Legacy threads are retained in the archived drawer group until they have
    // a comparison identity; they must not inflate the active-view indicator.
    otherViewCount: file.otherViewCount,
    drawerThreads: [
      ...(file.drawerThreads ?? file.document.commentThreads),
      ...legacyThreads,
    ],
    document: {
      ...file.document,
      commentThreads:
        file.view === 'diff'
          ? [...file.document.commentThreads, ...legacyThreads]
          : file.document.commentThreads,
    },
    stagedCount: file.stagedCount + (review.readOnly ? 0 : review.stagedCount),
    addReply: (id, body) =>
      (legacyIds.has(id) ? review : file).addReply(id, body),
    editStagedComment: (id, commentId, body) =>
      (legacyIds.has(id) ? review : file).editStagedComment(
        id,
        commentId,
        body,
      ),
    deleteStagedComment: (id, commentId) =>
      (legacyIds.has(id) ? review : file).deleteStagedComment(id, commentId),
    toggleResolved: (id) =>
      (legacyIds.has(id) ? review : file).toggleResolved(id),
    submit: async (send): Promise<void> => {
      if (review.readOnly || !review.stagedCount) return file.submit(send);
      if (!file.stagedCount) return review.submit(send);
      // One ordinary-chat dispatch; both hooks retain their own captured draft
      // snapshots and only publish them after that same dispatch is accepted.
      await review.submit(async (reviewMessage, context) => {
        let accepted = false;
        await file.submit(async (fileMessage) => {
          accepted = await send(`${fileMessage}\n\n${reviewMessage}`, context);
          return accepted;
        });
        return accepted;
      });
    },
  };
}
