import type {
  CodeReviewFile,
  CodeReviewGenerationResult,
  CodeReviewGetResponse,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type { ReviewScope } from '@canopy/protocol/canopy-core';
import {
  computeReviewFingerprint,
  listReviewRepos,
} from '../lib/code-review-diff';
import { isCodeReviewScopeStopped } from '../lib/code-review-deletion-fence';
import {
  appendReviewCommentReply,
  readCodeReviewStateProjection,
  saveCodeReviewComments,
} from '../lib/code-review-persistence';

/*
 * What `core.review.*` runs on the desktop (CAN-4167 PR 2c): desktop's
 * code-review persistence, unchanged. It owns the review file, its lock and
 * atomic replacement, the CAN-6848 admission and the CAN-6667 carry-through,
 * and refuses writes through the worktree deletion fence. Generation stays
 * with the Electron scheduler until PR 2d moves it into core; arming runs
 * the scheduler's arm, as `code-review:arm` always did.
 *
 * Each write calls persistence in the turn it is called, so a deletion fence
 * check the caller makes just before still holds when persistence checks it.
 */

/** A read that never refuses; `mutationFailure` says why a write would. */
export type DesktopReviewRead = Pick<
  CodeReviewGetResponse,
  'review' | 'mutationFailure' | 'skippedCommentThreads'
>;

export interface ReviewCommentsUpsert {
  scope: ReviewScope;
  commentThreads: ReviewCommentThread[];
  baseCommentThreadIds?: string[];
  baseCommentThreads?: ReviewCommentThread[];
}

export interface ReviewCommentReply {
  scope: ReviewScope;
  threadId: string;
  body: string;
  resolve?: boolean;
}

export interface DesktopReviewOperations {
  read(scope: ReviewScope): Promise<DesktopReviewRead>;
  /** The worktree's current branch diff fingerprint. */
  fingerprint(scope: ReviewScope): Promise<string>;
  /** True while the worktree's review state is being removed. */
  stopped(scope: ReviewScope): boolean;
  /**
   * Arms the review, announces it to every window and runs its generation,
   * answering the generation's status.
   */
  arm(scope: ReviewScope): Promise<CodeReviewGenerationResult>;
  upsertComments(input: ReviewCommentsUpsert): Promise<CodeReviewFile>;
  /** Null when the review has no such thread. */
  reply(input: ReviewCommentReply): Promise<CodeReviewFile | null>;
}

function saved(file: CodeReviewFile | null): CodeReviewFile {
  // Persistence answers null only for a write it did not run.
  if (!file) throw new Error('The code review comments were not saved.');
  return file;
}

export const desktopReviewOperations: DesktopReviewOperations = {
  read: (scope) =>
    readCodeReviewStateProjection(scope.projectId, scope.worktreeId),
  fingerprint: async (scope) =>
    computeReviewFingerprint(
      await listReviewRepos(scope.projectId, scope.worktreeId),
    ),
  stopped: (scope) =>
    isCodeReviewScopeStopped(scope.projectId, scope.worktreeId),
  arm: async (scope) => {
    // Loaded on first use: the scheduler reaches the helper runs, which
    // reach this runtime. Every update it sends goes to all windows, so it
    // needs no window.
    const { armCodeReview } = await import('../lib/code-review-scheduler');
    return armCodeReview(scope, () => null);
  },
  upsertComments: async ({ scope, ...threads }) =>
    saved(await saveCodeReviewComments({ ...scope, ...threads })),
  reply: async ({ scope, threadId, body, resolve }) => {
    const result = await appendReviewCommentReply({
      ...scope,
      threadId,
      body,
      ...(resolve === undefined ? {} : { resolve }),
    });
    return result.ok && result.review ? result.review : null;
  },
};
