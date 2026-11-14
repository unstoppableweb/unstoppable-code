import { z } from 'zod';

import { CanopyStreamCursorSchema } from '../../definitions';
import { isSafePortableRelativePath } from '../../../safe-relative-path';

/*
 * Tracked and detected plans (CAN-4165). The plan record mirrors the desktop
 * store's v1 entries: stored plans keep fields this version does not know
 * (`looseObject`), as the store always has; operation params and results are
 * otherwise closed. Diagrams (CAN-4167) and comment threads and sharing
 * (CAN-4166) join the record additively when those tickets move them.
 *
 * No host path crosses this contract. A plan's source file is a path relative
 * to its worktree (or one of its repositories), and an import names a file
 * the same way.
 */

const id = z.string().min(1).max(512);
const timestamp = z.string().min(1).max(64);

/**
 * Scope IDs name the host's storage directories, so they are slugs, as in
 * `core.annotation`: no separator, dot or percent-encoding reaches a path.
 */
const scopeId = id.regex(/^[a-z0-9][a-z0-9-]*$/);

export const PlanScopeSchema = z.strictObject({
  projectId: scopeId,
  worktreeId: scopeId,
});
export type PlanScope = z.output<typeof PlanScopeSchema>;

/**
 * A POSIX path inside the worktree or one of its repositories. Backslashes,
 * drive prefixes and `.` or `..` segments are refused, so no spelling of the
 * path can leave the worktree on any host.
 */
export const PlanRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isSafePortableRelativePath, 'Expected a worktree-relative path.');

/** What wrote a plan. A write with any other source is refused. */
export const PLAN_SOURCES = [
  'copilot',
  'opencode',
  'cursor',
  'claude',
  'codex',
  'ollama',
  'pipeline',
  'imported',
  'detected',
] as const;
export const PlanSourceSchema = z.enum(PLAN_SOURCES);
export type PlanSource = z.output<typeof PlanSourceSchema>;

export const PLAN_REVIEW_STATUSES = [
  'pending',
  'approved',
  'dismissed',
] as const;
export const PlanReviewStatusSchema = z.enum(PLAN_REVIEW_STATUSES);

/** Which non-user writer made a plan's latest edit. */
export const PlanEditSourceSchema = z.enum(['agent', 'pipeline']);

export const PlanRevisionSchema = z.looseObject({
  revisionNumber: z.number().int().min(1),
  content: z.string(),
  source: PlanSourceSchema,
  reviewStatus: PlanReviewStatusSchema,
  createdAt: timestamp,
  approvedAt: timestamp.optional(),
  dismissedAt: timestamp.optional(),
  /** The proposal request that wrote this revision; a replay returns it. */
  proposalRequestId: id.optional(),
});

export const PlanRecordSchema = z.looseObject({
  id,
  projectId: scopeId,
  worktreeId: scopeId,
  source: PlanSourceSchema,
  title: z.string(),
  content: z.string(),
  reviewStatus: PlanReviewStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  /** The latest revision's number; revisions are numbered from 1. */
  latestRevisionNumber: z.number().int().min(1),
  revisions: z.array(PlanRevisionSchema),
  linkedExecutionIds: z.array(id),
  approvedAt: timestamp.optional(),
  dismissedAt: timestamp.optional(),
  hidden: z.boolean().optional(),
  /** The chat whose proposal created the plan (Cursor proposals). */
  proposalChatId: id.optional(),
  lastEditSource: PlanEditSourceSchema.optional(),
  sourceFilePath: PlanRelativePathSchema.optional(),
  sourceRepoId: id.optional(),
});
export type PlanRecord = z.output<typeof PlanRecordSchema>;

// --- Tracked plans -----------------------------------------------------------

export const PlanListParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
});
export const PlanListResultSchema = z.strictObject({
  /** Most recently updated first. A cowork scope has none. */
  plans: z.array(PlanRecordSchema),
});

export const PlanGetParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
  planId: id,
});
export const PlanGetResultSchema = z.strictObject({
  plan: PlanRecordSchema.nullable(),
});

export const PlanCreateParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
  source: PlanSourceSchema,
  content: z.string(),
  title: z.string().min(1).max(512).optional(),
  /** With an ID that is already stored, the stored plan is returned unchanged. */
  planId: id.optional(),
  /** A proposal replayed with the same request returns its plan. */
  proposalRequestId: id.optional(),
  reviewStatus: PlanReviewStatusSchema.optional(),
  linkedExecutionId: id.optional(),
  chatId: id.optional(),
  sourceFilePath: PlanRelativePathSchema.optional(),
  sourceRepoId: id.optional(),
});

export const PlanUpdateParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
  planId: id,
  /** With it, a write against another revision is refused; without it, the last write wins. */
  expectedRevision: z.number().int().min(1).optional(),
  proposalRequestId: id.optional(),
  content: z.string().optional(),
  title: z.string().min(1).max(512).optional(),
  source: PlanSourceSchema.optional(),
  reviewStatus: PlanReviewStatusSchema.optional(),
  linkedExecutionId: id.optional(),
  approvedAt: timestamp.nullable().optional(),
  dismissedAt: timestamp.nullable().optional(),
  hidden: z.boolean().optional(),
  chatId: id.optional(),
  lastEditSource: PlanEditSourceSchema.optional(),
});

export const PlanWriteResultSchema = z.strictObject({
  /** Null when an update names a plan the scope does not have. */
  plan: PlanRecordSchema.nullable(),
});

export const PlanDeleteParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
  planId: id,
});
export const PlanDeleteResultSchema = z.strictObject({
  deleted: z.boolean(),
});

export const PlanImportParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
  /** The repository the path is inside; the worktree root for a single-repo workspace. */
  repoId: id,
  path: PlanRelativePathSchema,
});
export const PlanImportResultSchema = z.strictObject({
  plan: PlanRecordSchema,
});

// --- Detected plans (decision P1: their own operations) ---------------------

export const DETECTED_PLAN_STATUSES = [
  'detected',
  'dismissed',
  'imported',
] as const;

export const DetectedPlanSchema = z.looseObject({
  id,
  sourceRepoId: id,
  sourceFilePath: PlanRelativePathSchema,
  status: z.enum(DETECTED_PLAN_STATUSES),
  bannerSeen: z.boolean(),
  detectedInChatId: id,
  detectedAt: timestamp,
  importedPlanId: id.optional(),
});
export type DetectedPlan = z.output<typeof DetectedPlanSchema>;

export const DetectedPlanListParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
});
export const DetectedPlanListResultSchema = z.strictObject({
  /** A cowork scope has none. */
  detected: z.array(DetectedPlanSchema),
});

export const DetectedPlanScanParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
  chatId: id,
  /** Paths a turn touched, relative to the worktree; others are ignored. */
  candidatePaths: z.array(z.string().min(1).max(4_096)).max(10_000),
});
export const DetectedPlanScanResultSchema = z.strictObject({
  detected: z.array(DetectedPlanSchema),
  /** The entries this scan added; empty when it found nothing new. */
  newlyDetected: z.array(DetectedPlanSchema),
});

export const DetectedPlanUpdateParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
  entryId: id,
  status: z.enum(DETECTED_PLAN_STATUSES).optional(),
  bannerSeen: z.boolean().optional(),
  importedPlanId: id.optional(),
});
export const DetectedPlanUpdateResultSchema = z.strictObject({
  detected: z.array(DetectedPlanSchema),
});

// --- Events ------------------------------------------------------------------

export const PlanEventsParamsSchema = z.strictObject({
  scope: PlanScopeSchema,
  /** Resume after this cursor; omitted or null starts from now. */
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});

/** One committed change, published after the write is durable. */
export const PlanEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('plan.upserted'),
    scope: PlanScopeSchema,
    plan: PlanRecordSchema,
  }),
  z.strictObject({
    type: z.literal('plan.removed'),
    scope: PlanScopeSchema,
    planId: id,
  }),
  z.strictObject({
    type: z.literal('detected.changed'),
    scope: PlanScopeSchema,
    detected: z.array(DetectedPlanSchema),
  }),
]);
export type PlanEvent = z.output<typeof PlanEventSchema>;
