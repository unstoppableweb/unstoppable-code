import { z } from 'zod';

import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  ReviewArmParamsSchema,
  ReviewCommentReplyParamsSchema,
  ReviewCommentResolveParamsSchema,
  ReviewCommentUpsertParamsSchema,
  ReviewCreateParamsSchema,
  ReviewEventSchema,
  ReviewEventsParamsSchema,
  ReviewGenerationResultSchema,
  ReviewGetParamsSchema,
  ReviewGetResultSchema,
  ReviewWriteResultSchema,
} from './schemas';

export const REVIEW_GRANTS = {
  read: 'core.review.read',
  write: 'core.review.write',
} as const;

export const REVIEW_ERROR_REASONS = [
  'THREAD_NOT_FOUND',
  'THREAD_NOT_SUBMITTED',
  'STOPPED',
  'MODEL_UNAVAILABLE',
  'DAMAGED_STATE',
] as const;
export type ReviewErrorReason = (typeof REVIEW_ERROR_REASONS)[number];

export const REVIEW_ERROR_CODES = {
  THREAD_NOT_FOUND: 'core.review.threadNotFound',
  /** Every comment in the thread is still a draft the person has not submitted. */
  THREAD_NOT_SUBMITTED: 'core.review.threadNotSubmitted',
  /** The worktree's review state is being removed with the worktree. */
  STOPPED: 'core.review.stopped',
  /** No execution harness serves the configured review model. */
  MODEL_UNAVAILABLE: 'core.review.modelUnavailable',
  /**
   * The worktree's stored review cannot be read, so a write is refused
   * rather than replacing it (the CAN-5833 rule). Reads answer the empty
   * review instead.
   */
  DAMAGED_STATE: 'core.review.damagedState',
} as const satisfies Record<ReviewErrorReason, string>;

export const ReviewOperationErrorDetailsSchema = z.strictObject({
  reason: z.enum(REVIEW_ERROR_REASONS),
});
export type ReviewOperationErrorDetails = z.output<
  typeof ReviewOperationErrorDetailsSchema
>;

const reviewErrorCode = z.enum([
  REVIEW_ERROR_CODES.THREAD_NOT_FOUND,
  REVIEW_ERROR_CODES.THREAD_NOT_SUBMITTED,
  REVIEW_ERROR_CODES.STOPPED,
  REVIEW_ERROR_CODES.MODEL_UNAVAILABLE,
  REVIEW_ERROR_CODES.DAMAGED_STATE,
]);

export const ReviewQueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: reviewErrorCode.exclude([REVIEW_ERROR_CODES.DAMAGED_STATE]).optional(),
  details: z
    .strictObject({
      reason: z.enum(REVIEW_ERROR_REASONS).exclude(['DAMAGED_STATE']),
    })
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const ReviewInstructionErrorSchema = CanopyErrorPayloadSchema.extend({
  code: reviewErrorCode.optional(),
  details: ReviewOperationErrorDetailsSchema.optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const ReviewEventsOpenResultSchema = z.strictObject({
  subscriptionId: z.string().min(1).max(512),
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

export const ReviewEventsEndSchema = CanopyStreamEndSchema.extend({
  error: ReviewQueryErrorSchema.nullable(),
});

const review = {
  plane: 'core',
  domain: 'review',
  version: 1,
  placement: 'core-only',
} as const;

// Spec-first (CAN-4167 PR 2b): no registry composes these yet. A later
// CAN-4167 PR composes them with the in-process handler; until then every
// binding answers `capability_unavailable`.
export const CORE_REVIEW_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.review.get': defineCanopyQuery({
    ...review,
    params: ReviewGetParamsSchema,
    result: ReviewGetResultSchema,
    error: ReviewQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [REVIEW_GRANTS.read],
  }),
});

export const CORE_REVIEW_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.review.arm': defineCanopyInstruction({
      ...review,
      params: ReviewArmParamsSchema,
      result: ReviewGenerationResultSchema,
      error: ReviewInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [REVIEW_GRANTS.write],
    }),
    'core.review.create': defineCanopyInstruction({
      ...review,
      params: ReviewCreateParamsSchema,
      result: ReviewGenerationResultSchema,
      error: ReviewInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [REVIEW_GRANTS.write],
    }),
    'core.review.comment.upsert': defineCanopyInstruction({
      ...review,
      params: ReviewCommentUpsertParamsSchema,
      result: ReviewWriteResultSchema,
      error: ReviewInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [REVIEW_GRANTS.write],
    }),
    'core.review.comment.reply': defineCanopyInstruction({
      ...review,
      params: ReviewCommentReplyParamsSchema,
      result: ReviewWriteResultSchema,
      error: ReviewInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [REVIEW_GRANTS.write],
    }),
    'core.review.comment.resolve': defineCanopyInstruction({
      ...review,
      params: ReviewCommentResolveParamsSchema,
      result: ReviewWriteResultSchema,
      error: ReviewInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [REVIEW_GRANTS.write],
    }),
  });

export const CORE_REVIEW_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'core',
  {
    'core.review.events': defineCanopyStream({
      ...review,
      idempotency: 'inherent',
      requiredGrants: [REVIEW_GRANTS.read],
      params: ReviewEventsParamsSchema,
      openResult: ReviewEventsOpenResultSchema,
      item: ReviewEventSchema,
      end: ReviewEventsEndSchema,
      error: ReviewQueryErrorSchema,
    }),
  },
);
