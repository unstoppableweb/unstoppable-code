import { z } from 'zod';

import {
  MEMORY_FEEDBACK_COMMENT_MAX_CHARS,
  MEMORY_FEEDBACK_RATINGS,
} from '../../../memory';
import {
  MAX_TURN_FEEDBACK_CLIENT_ID_LENGTH,
  MAX_TURN_FEEDBACK_COMMENT_LENGTH,
  TURN_FEEDBACK_RATINGS,
  TURN_FEEDBACK_REASONS,
} from '../../../turn-feedback';

const ClientIdSchema = z
  .string()
  .min(1)
  .max(MAX_TURN_FEEDBACK_CLIENT_ID_LENGTH);
/** The hosted id of a recorded rating; absent while the rating is queued. */
const FeedbackIdSchema = z.string().min(1).max(128);
const ContextSchema = z.string().min(1).max(256);
const WorkIdSchema = z.string().min(1).max(512);

export const TurnFeedbackRatingSchema = z.enum(TURN_FEEDBACK_RATINGS);
export const TurnFeedbackReasonSchema = z.enum(TURN_FEEDBACK_REASONS);
const TurnFeedbackCommentSchema = z
  .string()
  .max(MAX_TURN_FEEDBACK_COMMENT_LENGTH);

export const CoreFeedbackTurnRateParamsSchema = z.strictObject({
  clientUserMessageId: ClientIdSchema,
  clientChatId: ClientIdSchema,
  rating: TurnFeedbackRatingSchema,
  provider: ContextSchema.optional(),
  model: ContextSchema.optional(),
  eventType: ContextSchema.optional(),
  chatMode: ContextSchema.optional(),
  // The host derives the work owner from these; params never carry it.
  projectId: WorkIdSchema.optional(),
  worktreeId: WorkIdSchema.optional(),
});
/** A queued rating has no hosted id yet; a delivered or dropped one may. */
export const CoreFeedbackTurnRateResultSchema = z.union([
  z.strictObject({ recorded: z.literal(false), queued: z.literal(true) }),
  z.strictObject({
    recorded: z.boolean(),
    queued: z.literal(false),
    feedbackId: FeedbackIdSchema.optional(),
  }),
]);

const TurnUpdateTarget = {
  clientUserMessageId: ClientIdSchema,
  feedbackId: FeedbackIdSchema.optional(),
};
/**
 * A reason, a comment or both: never neither. The branches don't overlap, so
 * the catalog's oneOf accepts both fields together.
 */
export const CoreFeedbackTurnUpdateParamsSchema = z.union([
  z.strictObject({
    ...TurnUpdateTarget,
    reason: TurnFeedbackReasonSchema,
    comment: TurnFeedbackCommentSchema.optional(),
  }),
  z.strictObject({ ...TurnUpdateTarget, comment: TurnFeedbackCommentSchema }),
]);
export const CoreFeedbackTurnUpdateResultSchema = z.strictObject({
  recorded: z.boolean(),
  queued: z.boolean(),
});

export const CoreFeedbackTurnDeleteParamsSchema =
  z.strictObject(TurnUpdateTarget);
export const CoreFeedbackTurnDeleteResultSchema = z.strictObject({
  cleared: z.boolean(),
});

export const CoreFeedbackTurnListParamsSchema = z.strictObject({
  clientChatId: ClientIdSchema,
});
/** A rating as the client renders it. Never carries the comment text. */
export const CoreFeedbackTurnSummarySchema = z.strictObject({
  feedbackId: FeedbackIdSchema.optional(),
  clientUserMessageId: ClientIdSchema,
  rating: TurnFeedbackRatingSchema,
  reason: TurnFeedbackReasonSchema.optional(),
  hasComment: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const CoreFeedbackTurnListResultSchema = z.strictObject({
  feedback: z.array(CoreFeedbackTurnSummarySchema).max(10_000),
});

const MemoryFactTarget = {
  kind: z.literal('memory_fact'),
  organizationExternalId: z.uuid(),
  searchId: z.uuid(),
  factId: z.uuid(),
};
const MemoryFeedbackRatingSchema = z.enum(MEMORY_FEEDBACK_RATINGS);
// The hosted endpoint refuses a blank comment.
const MemoryFeedbackCommentSchema = z
  .string()
  .max(MEMORY_FEEDBACK_COMMENT_MAX_CHARS)
  .regex(/\S/);
/**
 * Feedback on one organization memory fact: a rating, a comment or both.
 * `kind` lets the product report kinds join later as an addition (CAN-5747).
 */
export const CoreFeedbackSubmitParamsSchema = z.union([
  z.strictObject({
    ...MemoryFactTarget,
    rating: MemoryFeedbackRatingSchema,
    comment: MemoryFeedbackCommentSchema.optional(),
  }),
  z.strictObject({ ...MemoryFactTarget, comment: MemoryFeedbackCommentSchema }),
]);
export const CoreFeedbackSubmitResultSchema = z.strictObject({
  recorded: z.boolean(),
  /** The stored row; on a duplicate submission, the original one. */
  feedback: z
    .strictObject({
      rating: MemoryFeedbackRatingSchema.optional(),
      comment: z.string().max(MEMORY_FEEDBACK_COMMENT_MAX_CHARS).optional(),
      createdAt: z.iso.datetime(),
    })
    .optional(),
});

export type CoreFeedbackTurnRateParams = z.output<
  typeof CoreFeedbackTurnRateParamsSchema
>;
export type CoreFeedbackTurnRateResult = z.output<
  typeof CoreFeedbackTurnRateResultSchema
>;
export type CoreFeedbackTurnUpdateParams = z.output<
  typeof CoreFeedbackTurnUpdateParamsSchema
>;
export type CoreFeedbackTurnDeleteParams = z.output<
  typeof CoreFeedbackTurnDeleteParamsSchema
>;
export type CoreFeedbackTurnListResult = z.output<
  typeof CoreFeedbackTurnListResultSchema
>;
export type CoreFeedbackSubmitParams = z.output<
  typeof CoreFeedbackSubmitParamsSchema
>;
