import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import { keyedOperationErrorSchema } from '../shared';
import { CORE_PULL_REQUEST_GRANTS } from './operations';

// ---------------------------------------------------------------------------
// core.pullRequest.review.publish: a packaged code review posted to its pull
// request as the GitHub App, approving when the owner's approval policy says
// so. Served by the web core only. The `github-publish-review` host step
// sends it from desktop and daemon runs; cloud runs call the publisher
// directly. Every App write is behind the server-only
// `canopy-github-app-reviews` flag.
// ---------------------------------------------------------------------------

/** GitHub allows 65,536; this leaves room for the approval footer. */
export const REVIEW_PUBLISH_BODY_MAX_CHARS = 65_000;
/** Bound on one inline comment's or reply's body (GitHub's own limit). */
export const REVIEW_PUBLISH_COMMENT_BODY_MAX_CHARS = 65_536;
export const REVIEW_PUBLISH_MAX_COMMENTS = 200;
export const REVIEW_PUBLISH_MAX_REPLIES = 200;
/**
 * The most a review payload (body, comments and replies, as UTF-8 JSON) may
 * take when a host sends it: the pipeline step fits reviews within it, and
 * the agent action refuses larger ones.
 */
export const REVIEW_PUBLISH_PAYLOAD_MAX_BYTES = 512 * 1024;

const GitHubNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/)
  .describe('A GitHub owner or repository name.');

export const ReviewPublishPullRequestSchema = z.strictObject({
  owner: GitHubNameSchema,
  repo: GitHubNameSchema,
  number: z.number().int().positive().max(2_147_483_647),
});

/** Empty when the run recorded no head, or a full 40- or 64-character SHA. */
export const ReviewPublishReviewedHeadSchema = z
  .string()
  .regex(/^(?:|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/);

const ReviewSideSchema = z.enum(['LEFT', 'RIGHT']);
const LineNumberSchema = z.number().int().positive().max(10_000_000);

export const ReviewPublishInlineCommentSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  body: z.string().min(1).max(REVIEW_PUBLISH_COMMENT_BODY_MAX_CHARS),
  line: LineNumberSchema.optional(),
  start_line: LineNumberSchema.optional(),
  side: ReviewSideSchema.optional(),
  start_side: ReviewSideSchema.optional(),
  subject_type: z.enum(['line', 'file']).optional(),
});

export const ReviewPublishReplySchema = z.strictObject({
  body: z.string().min(1).max(REVIEW_PUBLISH_COMMENT_BODY_MAX_CHARS),
  comment_id: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  thread_id: z.string().min(1).max(256).optional(),
  resolve: z.boolean().optional(),
  action: z.string().max(64).optional(),
});

export const ReviewPublishPayloadSchema = z.strictObject({
  body: z.string().min(1).max(REVIEW_PUBLISH_BODY_MAX_CHARS),
  comments: z
    .array(ReviewPublishInlineCommentSchema)
    .max(REVIEW_PUBLISH_MAX_COMMENTS),
  replies: z.array(ReviewPublishReplySchema).max(REVIEW_PUBLISH_MAX_REPLIES),
});

/**
 * The facts the run reports about its own review. The server takes them from
 * the caller; it verifies the PR's state and head itself.
 */
export const ReviewPublishApprovalFactsSchema = z.strictObject({
  verdict: z.string().max(64),
  /** The review's score; anything but an integer 1-10 never approves. */
  score: z.number().nullable(),
  complete: z.boolean(),
});

/** `personal`, or `org:<uuid>` (the execution owner of the run). */
export const ReviewPublishOwnerSchema = z
  .string()
  .regex(
    /^(?:personal|org:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  );

export const ReviewPublishParamsSchema = z.strictObject({
  owner: ReviewPublishOwnerSchema,
  pr: ReviewPublishPullRequestSchema,
  reviewedHead: ReviewPublishReviewedHeadSchema,
  reviewedUncommitted: z.boolean(),
  payload: ReviewPublishPayloadSchema,
  approvalFacts: ReviewPublishApprovalFactsSchema,
  executionRef: z.string().min(1).max(512),
  /**
   * The approval reasons this caller can read. A result's reason outside the
   * list is answered as its fallback (`REVIEW_APPROVAL_REASON_FALLBACKS`), so
   * a reason added later never breaks a released host's result validation.
   * Absent means `BASELINE_REVIEW_APPROVAL_REASONS`. A server older than this
   * field refuses it as invalid before the handler runs, so a host that sent
   * it may resend once without it.
   */
  knownApprovalReasons: z.array(z.string().min(1).max(64)).max(64).optional(),
  /**
   * The publication's idempotency key. Required: a request without one is
   * refused as invalid before the handler runs.
   */
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
});

export type ReviewPublishParams = z.infer<typeof ReviewPublishParamsSchema>;
export type ReviewPublishPayload = z.infer<typeof ReviewPublishPayloadSchema>;
export type ReviewPublishApprovalFacts = z.infer<
  typeof ReviewPublishApprovalFactsSchema
>;

/**
 * The approval reasons released before `knownApprovalReasons` existed: what a
 * caller that sends no list can read. Frozen; never derive it from
 * `REVIEW_APPROVAL_REASONS`.
 */
export const BASELINE_REVIEW_APPROVAL_REASONS = [
  'approved',
  'policy_off',
  'personal_repo_not_owned',
  'repo_not_selected',
  'pr_not_open',
  'not_pass',
  'below_min_score',
  'incomplete',
  'uncommitted',
  'head_moved',
  'requester_not_writer',
  'github_refused',
] as const;

export type BaselineReviewApprovalReason =
  (typeof BASELINE_REVIEW_APPROVAL_REASONS)[number];

export const REVIEW_APPROVAL_REASONS = [
  'approved',
  'policy_off',
  'personal_repo_not_owned',
  'repo_not_selected',
  'pr_not_open',
  'not_pass',
  'below_min_score',
  'incomplete',
  'uncommitted',
  'head_moved',
  'requester_not_writer',
  'github_refused',
  /** The requester has no usable linked GitHub account (CAN-6989 CTA). */
  'requester_not_connected',
] as const;

export const ReviewApprovalReasonSchema = z.enum(REVIEW_APPROVAL_REASONS);
export type ReviewApprovalReason = z.infer<typeof ReviewApprovalReasonSchema>;

/**
 * The baseline reason each later reason is answered as for a caller that
 * can't read it. Every reason outside the baseline must have one, or this
 * fails to compile.
 */
export const REVIEW_APPROVAL_REASON_FALLBACKS: {
  readonly [R in Exclude<
    ReviewApprovalReason,
    BaselineReviewApprovalReason
  >]: BaselineReviewApprovalReason;
} = {
  requester_not_connected: 'requester_not_writer',
};

function isBaselineReason(
  reason: ReviewApprovalReason,
): reason is BaselineReviewApprovalReason {
  return (BASELINE_REVIEW_APPROVAL_REASONS as readonly string[]).includes(
    reason,
  );
}

/**
 * The reason a caller that reads `known` (absent: the baseline) is told. A
 * baseline reason is always readable; a later one outside the list becomes
 * its fallback.
 */
export function reviewApprovalReasonForCaller(
  reason: ReviewApprovalReason,
  known: readonly string[] | undefined,
): ReviewApprovalReason {
  if (isBaselineReason(reason)) return reason;
  if (known?.includes(reason) === true) return reason;
  return REVIEW_APPROVAL_REASON_FALLBACKS[reason];
}

/**
 * Why nothing was posted. `not_signed_in`, `no_host` are produced by hosts,
 * never by the server. `unavailable` always means nothing was posted, so the
 * `gh` fallback is safe.
 */
export const REVIEW_PUBLISH_UNAVAILABLE_REASONS = [
  'flag_off',
  'no_org_connection',
  'no_personal_connection',
  'repo_not_installed',
  'app_permissions_missing',
  'not_signed_in',
  'no_host',
] as const;

/**
 * Why a publication failed. `payload_too_large` is produced by hosts. A
 * `failed` result never falls back to `gh`: something may have been posted.
 */
export const REVIEW_PUBLISH_FAILURE_REASONS = [
  'github_error',
  'payload_too_large',
  'outcome_unknown',
] as const;

const CountSchema = z.number().int().nonnegative();

export const ReviewPublishResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('published'),
    reviewId: z.string().min(1).max(64),
    reviewUrl: z.string().max(2048),
    approval: z.strictObject({
      state: z.enum(['approved', 'not_approved']),
      reason: ReviewApprovalReasonSchema,
      minScore: z.number().int().min(1).max(10),
    }),
    counts: z.strictObject({
      inline: CountSchema,
      fileLevel: CountSchema,
      omitted: CountSchema,
      replies: CountSchema,
      resolved: CountSchema,
      dismissedApprovals: CountSchema,
    }),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(REVIEW_PUBLISH_UNAVAILABLE_REASONS),
  }),
  z.strictObject({
    status: z.literal('failed'),
    reason: z.enum(REVIEW_PUBLISH_FAILURE_REASONS),
  }),
]);

export type ReviewPublishResult = z.infer<typeof ReviewPublishResultSchema>;

/**
 * The result as a caller that reads `knownApprovalReasons` sees it. Changes
 * only the returned value, never what the server stores.
 */
export function projectReviewPublishResult(
  result: ReviewPublishResult,
  knownApprovalReasons: readonly string[] | undefined,
): ReviewPublishResult {
  if (result.status !== 'published') return result;
  const reason = reviewApprovalReasonForCaller(
    result.approval.reason,
    knownApprovalReasons,
  );
  if (reason === result.approval.reason) return result;
  return { ...result, approval: { ...result.approval, reason } };
}
export type ReviewPublishUnavailableReason =
  (typeof REVIEW_PUBLISH_UNAVAILABLE_REASONS)[number];
export type ReviewPublishFailureReason =
  (typeof REVIEW_PUBLISH_FAILURE_REASONS)[number];

export const CORE_PULL_REQUEST_REVIEW_PUBLISH_ERROR_CODES = [
  'core.pullRequest.review.idempotencyKeyMissing',
] as const;

/**
 * Served by the web core only, behind `canopy-github-app-reviews`, and not
 * composed into the core registry: the desktop dispatcher and the daemon
 * answer `capability_unavailable`. Keyed: the request's
 * `_meta.idempotencyKey` is the publication's key, and a request without one
 * is a validation error.
 */
export const CORE_PULL_REQUEST_REVIEW_PUBLISH_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.pullRequest.review.publish': defineCanopyInstruction({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: ReviewPublishParamsSchema,
      result: ReviewPublishResultSchema,
      error: keyedOperationErrorSchema(
        CORE_PULL_REQUEST_REVIEW_PUBLISH_ERROR_CODES,
      ),
      idempotency: 'keyed',
      requiredGrants: [CORE_PULL_REQUEST_GRANTS.write],
    }),
  });
