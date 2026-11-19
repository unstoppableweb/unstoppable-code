import { randomUUID } from 'node:crypto';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  REVIEW_ERROR_CODES,
  REVIEW_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  normalizeCodeReviewFile,
  type CodeReviewFile,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { activeAgentCoreOperations } from './active-agent-core-operations';

/*
 * The agent comment tools' client of `core.review.*` for code review
 * threads (CAN-4167 PR 2c). It keeps the tools' result shapes and messages
 * and calls the desktop dispatcher as a trusted in-process host caller. The
 * review adapter announces each committed reply to every window.
 */

type ReviewDispatcher = Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;

const REVIEW_THREAD_NOT_FOUND = 'Comment thread not found.';

const REVIEW_COMMENT_TOOLS_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-review-comment-tools',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [],
};

function reviewCaller(access: 'read' | 'write'): CanopyCallerDescriptor {
  return { ...REVIEW_COMMENT_TOOLS_CALLER, grants: [REVIEW_GRANTS[access]] };
}

/** Thread ids the operations accept; any other id names no thread. */
function isOperationThreadId(threadId: string): boolean {
  return threadId.length > 0 && threadId.length <= 512;
}

export type ReadReviewCommentThreadResult =
  | { ok: false; error: string }
  | { ok: true; mode: 'single'; thread: ReviewCommentThread }
  | { ok: true; mode: 'all'; threads: ReviewCommentThread[] };

/** One thread by id, or every open thread without one. */
export async function readReviewCommentThread(
  request: { projectId: string; worktreeId: string; threadId?: string },
  dispatcher: ReviewDispatcher = activeAgentCoreOperations('review'),
): Promise<ReadReviewCommentThreadResult> {
  const { review } = await dispatcher.query(
    'core.review.get',
    {
      scope: { projectId: request.projectId, worktreeId: request.worktreeId },
    },
    { caller: reviewCaller('read') },
  );
  const { commentThreads } = normalizeCodeReviewFile(review);
  if (request.threadId !== undefined) {
    const thread = commentThreads.find(
      (entry) => entry.id === request.threadId,
    );
    return thread
      ? { ok: true, mode: 'single', thread }
      : { ok: false, error: REVIEW_THREAD_NOT_FOUND };
  }
  return {
    ok: true,
    mode: 'all',
    threads: commentThreads.filter((entry) => entry.status === 'open'),
  };
}

export interface ReplyToReviewCommentResult {
  ok: boolean;
  review?: CodeReviewFile;
  error?: string;
}

/** Posts an agent reply, optionally resolving the thread. */
export async function replyToReviewCommentThread(
  request: {
    projectId: string;
    worktreeId: string;
    threadId: string;
    body: string;
    resolve?: boolean;
  },
  dispatcher: ReviewDispatcher = activeAgentCoreOperations('review'),
): Promise<ReplyToReviewCommentResult> {
  const notFound = { ok: false, error: REVIEW_THREAD_NOT_FOUND };
  if (!isOperationThreadId(request.threadId)) return notFound;
  try {
    const { review } = await dispatcher.instruction(
      'core.review.comment.reply',
      {
        scope: {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
        },
        threadId: request.threadId,
        body: request.body,
        resolve: request.resolve,
      },
      {
        caller: reviewCaller('write'),
        metadata: { idempotencyKey: randomUUID() },
      },
    );
    return { ok: true, review: normalizeCodeReviewFile(review) };
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.code === REVIEW_ERROR_CODES.THREAD_NOT_FOUND
    )
      return notFound;
    throw error;
  }
}
