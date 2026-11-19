import {
  IPC_CHANNELS,
  type CodeReviewFile,
  type CodeReviewUpdatedEvent,
} from '@canopy/desktop-shared/types';
import type { ReviewScope } from '@canopy/protocol/canopy-core';
import {
  computeReviewFingerprint,
  listReviewRepos,
} from '../lib/code-review-diff';
import { skippedCommentThreadsField } from '../lib/code-review-persistence';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { sendToAllWindows } from '../lib/window-send';

/*
 * `code-review:updated` for a `core.review.*` write the dispatcher committed,
 * sent to every window with the worktree's current fingerprint. It is the
 * event the IPC channels and the agent comment tools sent before they
 * dispatched: the review persistence wrote, and persistence's skipped-thread
 * count. Every desktop review writer has always announced its writes this
 * way, so a write from any binding is announced the same.
 */

export interface DispatchedReviewChange {
  scope: ReviewScope;
  /** The review as persistence wrote it. */
  review: CodeReviewFile;
}

/** Never throws: the write it announces is already durable. */
export async function publishDispatchedReviewChange({
  scope,
  review,
}: DispatchedReviewChange): Promise<void> {
  try {
    const fingerprint = await computeReviewFingerprint(
      await listReviewRepos(scope.projectId, scope.worktreeId),
    );
    const event: CodeReviewUpdatedEvent = {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      fingerprint,
      review,
      ...skippedCommentThreadsField(scope.projectId, scope.worktreeId),
    };
    sendToAllWindows(IPC_CHANNELS.codeReviewUpdated, event);
  } catch (error) {
    logMainProcessWarn('[code-review] update was not published', error);
  }
}
