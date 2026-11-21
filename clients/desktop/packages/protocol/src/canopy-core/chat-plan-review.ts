import { z } from 'zod';

const PlanReviewIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

/** Identity of the exact app-owned proposal the user chose to implement. */
export const ChatPlanReviewApprovalSchema = z.strictObject({
  requestId: PlanReviewIdSchema,
  planId: PlanReviewIdSchema,
  revisionNumber: z.number().int().positive(),
});

export type ChatPlanReviewApproval = z.infer<
  typeof ChatPlanReviewApprovalSchema
>;

/** Writable attempt identity. Outcomes are written only by the chat authority. */
export const TrackedPlanImplementationInputSchema = z.strictObject({
  planId: PlanReviewIdSchema,
  revisionNumber: z.number().int().positive(),
  userMessageId: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\s/\\\0]+$/),
  startedAt: z.iso.datetime({ offset: true }),
});

/** Persisted links have either no terminal facts or a complete terminal pair. */
export const TrackedPlanImplementationSchema = z.union([
  TrackedPlanImplementationInputSchema,
  TrackedPlanImplementationInputSchema.extend({
    outcome: z.enum(['completed', 'failed', 'cancelled']),
    endedAt: z.iso.datetime({ offset: true }),
  }),
]);
export type TrackedPlanImplementationInput = z.infer<
  typeof TrackedPlanImplementationInputSchema
>;
export type TrackedPlanImplementation = TrackedPlanImplementationInput &
  (
    | { outcome?: never; endedAt?: never }
    | { outcome: 'completed' | 'failed' | 'cancelled'; endedAt: string }
  );

/** Explicit review mode wins over the legacy Codex and OpenCode source fallbacks. */
export function isPlanProposal(
  value:
    | {
        reviewMode?: unknown;
        source?: unknown;
      }
    | null
    | undefined,
): boolean {
  return value?.reviewMode !== undefined
    ? value.reviewMode === 'proposal'
    : value?.source === 'codex' || value?.source === 'opencode';
}

/**
 * The message an approved plan proposal starts its implementation turn with.
 * Desktop and Remote Control send the same text.
 */
export const PLAN_PROPOSAL_APPROVAL_MESSAGE = 'Approved. Implement the plan.';

/** The message an approved plain plan exit starts its implementation turn with. */
export const PLAN_EXIT_APPROVAL_MESSAGE = 'Approved';
