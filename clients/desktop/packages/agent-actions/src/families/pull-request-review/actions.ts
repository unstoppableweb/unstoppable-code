import { z } from 'zod';
import {
  REVIEW_PUBLISH_BODY_MAX_CHARS,
  REVIEW_PUBLISH_MAX_COMMENTS,
  REVIEW_PUBLISH_MAX_REPLIES,
  REVIEW_PUBLISH_PAYLOAD_MAX_BYTES,
  ReviewPublishInlineCommentSchema,
  ReviewPublishPullRequestSchema,
  ReviewPublishReplySchema,
  ReviewPublishReviewedHeadSchema,
  type ReviewPublishApprovalFacts,
  type ReviewPublishPayload,
} from '@canopy/protocol/canopy-core';

export const PULL_REQUEST_REVIEW_ACTION_TYPES = [
  'pull_request.review.publish',
] as const;

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const PULL_REQUEST_REF = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/;

/** A pull request URL or `owner/repository#number`, as its parts. */
export const pullRequestReferenceSchema = z
  .string()
  .min(1)
  .max(2048)
  .transform((value, context) => {
    const match =
      PULL_REQUEST_URL.exec(value.trim()) ??
      PULL_REQUEST_REF.exec(value.trim());
    const parsed = ReviewPublishPullRequestSchema.safeParse(
      match === null
        ? null
        : { owner: match[1], repo: match[2], number: Number(match[3]) },
    );
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        message:
          'pullRequest must be a GitHub pull request URL or owner/repository#number.',
      });
      return z.NEVER;
    }
    return parsed.data;
  });

/**
 * One review posted to its pull request as the GitHub App. The approval facts
 * are the agent's own report about its review; the server checks the pull
 * request's state, head and the requester's access itself.
 */
export const pullRequestReviewActionSchema = z
  .strictObject({
    type: z.literal('pull_request.review.publish'),
    pullRequest: pullRequestReferenceSchema,
    body: z.string().min(1).max(REVIEW_PUBLISH_BODY_MAX_CHARS),
    comments: z
      .array(ReviewPublishInlineCommentSchema)
      .max(REVIEW_PUBLISH_MAX_COMMENTS)
      .default([]),
    replies: z
      .array(ReviewPublishReplySchema)
      .max(REVIEW_PUBLISH_MAX_REPLIES)
      .default([]),
    reviewedHead: ReviewPublishReviewedHeadSchema,
    // Required, never defaulted: false is the value that allows approval.
    reviewedUncommitted: z.boolean(),
    // The same bounds as the operation's approval facts: the server never
    // refuses a value this accepts; anything but an integer 1-10 never approves.
    verdict: z.string().max(64),
    score: z.number().nullable(),
    complete: z.boolean(),
  })
  // Refused before the port, so nothing is sent: the request would exceed
  // what the hosts send (the pipeline step fits reviews within the same).
  // The bound covers the review itself; the owner, pull request, facts and
  // `_meta` add a little, with the same headroom below the hosts' request
  // limits as the pipeline step.
  .refine(
    (action) =>
      new TextEncoder().encode(
        JSON.stringify({
          body: action.body,
          comments: action.comments,
          replies: action.replies,
        }),
      ).byteLength <= REVIEW_PUBLISH_PAYLOAD_MAX_BYTES,
    {
      message:
        'The review is too large to post: its body, comments and replies must fit in 512 KiB as JSON. Shorten it or drop comments.',
    },
  );

export type PullRequestReviewAction = z.output<
  typeof pullRequestReviewActionSchema
>;

/** The publication the port sends; the host adds the owner and the key. */
export interface AgentReviewPublishRequest {
  pr: { owner: string; repo: string; number: number };
  reviewedHead: string;
  reviewedUncommitted: boolean;
  payload: ReviewPublishPayload;
  approvalFacts: ReviewPublishApprovalFacts;
}

export function reviewPublishRequestOf(
  action: PullRequestReviewAction,
): AgentReviewPublishRequest {
  return {
    pr: action.pullRequest,
    reviewedHead: action.reviewedHead,
    reviewedUncommitted: action.reviewedUncommitted,
    payload: {
      body: action.body,
      comments: action.comments,
      replies: action.replies,
    },
    approvalFacts: {
      verdict: action.verdict,
      score: action.score,
      complete: action.complete,
    },
  };
}
