import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

export const CORE_PULL_REQUEST_GRANTS = {
  read: 'core.pullRequest.read',
  write: 'core.pullRequest.write',
} as const;

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .describe('Stable opaque identifier.');
const GitObjectIdSchema = z.string().regex(/^[a-fA-F0-9]{7,64}$/);
const TimestampSchema = z.iso
  .datetime({ offset: true })
  .describe('RFC 3339 timestamp with an offset.');

export const CORE_PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const;
export type CorePullRequestState = (typeof CORE_PULL_REQUEST_STATES)[number];

export const CorePullRequestCheckSchema = z.strictObject({
  checkId: OpaqueIdSchema,
  name: z.string().max(512),
  status: z.enum(['queued', 'in_progress', 'completed']),
  conclusion: z
    .enum([
      'success',
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'neutral',
      'skipped',
    ])
    .nullable(),
  url: z.string().max(8192).nullable(),
  completedAt: TimestampSchema.nullable(),
});

export type CorePullRequestCheck = z.output<typeof CorePullRequestCheckSchema>;

/** The full pull-request projection returned by get/list and PR writes. */
export const CorePullRequestSchema = z.strictObject({
  pullRequestId: OpaqueIdSchema,
  integrationId: OpaqueIdSchema,
  repositoryId: OpaqueIdSchema,
  number: z.number().int().min(1),
  title: z.string().max(1024),
  body: z.string().max(200_000),
  url: z.string().max(8192),
  state: z.enum(CORE_PULL_REQUEST_STATES),
  draft: z.boolean(),
  baseBranch: z.string().max(512),
  baseSha: GitObjectIdSchema.nullable(),
  headBranch: z.string().max(512),
  headSha: GitObjectIdSchema,
  mergeable: z.enum(['unknown', 'mergeable', 'conflicting']),
  reviewDecision: z.enum([
    'none',
    'review_required',
    'approved',
    'changes_requested',
  ]),
  checks: z.array(CorePullRequestCheckSchema),
  reviewThreadCount: z.number().int().min(0),
  unresolvedReviewThreadCount: z.number().int().min(0),
  commentCount: z.number().int().min(0),
  updatedAt: TimestampSchema,
  revision: z.number().int().min(0),
});

export type CorePullRequest = z.output<typeof CorePullRequestSchema>;

export const CorePullRequestGetParamsSchema = z.strictObject({
  pullRequestId: OpaqueIdSchema,
  refresh: z.boolean(),
});

export type CorePullRequestGetParams = z.output<
  typeof CorePullRequestGetParamsSchema
>;

export const CorePullRequestListParamsSchema = z.strictObject({
  integrationId: OpaqueIdSchema.nullable(),
  repositoryId: OpaqueIdSchema.nullable(),
  states: z.array(z.enum(CORE_PULL_REQUEST_STATES)),
  cursor: OpaqueIdSchema.nullable(),
  query: z.string().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(200),
});

export type CorePullRequestListParams = z.output<
  typeof CorePullRequestListParamsSchema
>;

export const CorePullRequestListResultSchema = z.strictObject({
  pullRequests: z.array(CorePullRequestSchema),
  nextCursor: OpaqueIdSchema.nullable(),
});

export type CorePullRequestListResult = z.output<
  typeof CorePullRequestListResultSchema
>;

export const CorePullRequestCreateParamsSchema = z.strictObject({
  integrationId: OpaqueIdSchema,
  repositoryId: OpaqueIdSchema,
  /** Absent, a core that can write one generates the title and body. */
  title: z.string().min(1).max(1024).optional(),
  /** Absent with a title, the body is empty. */
  body: z.string().max(200_000).optional(),
  baseBranch: z.string().max(512),
  headBranch: z.string().max(512),
  expectedHeadSha: GitObjectIdSchema,
  draft: z.boolean(),
});

export type CorePullRequestCreateParams = z.output<
  typeof CorePullRequestCreateParamsSchema
>;

export const CorePullRequestPatchSchema = z.strictObject({
  title: z.string().min(1).max(1024).nullable(),
  body: z.string().max(200_000).nullable(),
  baseBranch: z.string().max(512).nullable(),
  draft: z.boolean().nullable(),
});

export type CorePullRequestPatch = z.output<typeof CorePullRequestPatchSchema>;

export const CorePullRequestUpdateParamsSchema = z.strictObject({
  pullRequestId: OpaqueIdSchema,
  expectedRevision: z.number().int().min(0),
  patch: CorePullRequestPatchSchema,
});

export type CorePullRequestUpdateParams = z.output<
  typeof CorePullRequestUpdateParamsSchema
>;

export const CORE_PULL_REQUEST_MERGE_STRATEGIES = [
  'merge',
  'squash',
  'rebase',
] as const;

export const CorePullRequestMergeParamsSchema = z.strictObject({
  pullRequestId: OpaqueIdSchema,
  /** The projection's `revision` the caller read; any other refuses the merge. */
  expectedRevision: z.number().int().min(0),
  expectedHeadSha: GitObjectIdSchema,
  /** Absent, the repository's preferred method. */
  strategy: z.enum(CORE_PULL_REQUEST_MERGE_STRATEGIES).optional(),
});

export type CorePullRequestMergeParams = z.output<
  typeof CorePullRequestMergeParamsSchema
>;

export const CorePullRequestRefreshParamsSchema = z.strictObject({
  /** The caller's worktree. */
  scope: CanopyWorkspaceScopeSchema.pick({
    workspaceId: true,
    worktreeId: true,
    authorityId: true,
    targetId: true,
  }).required({ workspaceId: true, worktreeId: true }),
  /**
   * One repository, as a Git checkout scope names it. Absent, every
   * repository of the worktree.
   */
  repoId: OpaqueIdSchema.optional(),
});

export type CorePullRequestRefreshParams = z.output<
  typeof CorePullRequestRefreshParamsSchema
>;

/**
 * The pull request a refresh found, as the refresh read it: the summary the
 * pull request actions show, not the full `core.pullRequest.get` projection.
 */
export const CorePullRequestRefreshSummarySchema = z.strictObject({
  number: z.number().int().min(1),
  url: z.string().max(8192),
  state: z.enum(CORE_PULL_REQUEST_STATES),
  /** An open draft. */
  draft: z.boolean(),
  title: z.string().max(1024),
  /** Every check of the head together; `none` without checks. */
  checkStatus: z.enum(['passing', 'failing', 'pending', 'neutral', 'none']),
  checks: z.array(
    z.strictObject({
      name: z.string().max(512),
      status: z.enum(['success', 'failure', 'pending', 'neutral']),
      url: z.string().max(8192).nullable(),
    }),
  ),
  reviewDecision: CorePullRequestSchema.shape.reviewDecision,
  hasConflicts: z.boolean(),
  /** GitHub's checks, reviews and mergeability all allow a merge. */
  mergeReady: z.boolean(),
  /** Null when the review threads could not be read. */
  unresolvedReviewThreadCount: z.number().int().min(0).nullable(),
  /** As `core.pullRequest.get` projects it; merge sends it back. */
  revision: CorePullRequestSchema.shape.revision,
});

/** One repository's pull request and action eligibility, the root first. */
export const CorePullRequestRefreshRepositorySchema = z.strictObject({
  repositoryId: OpaqueIdSchema,
  /** The name the repository shows in a multi-repository worktree. */
  repoName: z.string().max(512),
  /** False when this repository could not be read; the others still answer. */
  available: z.boolean(),
  /**
   * The pull request found for the branch (the open one, else the newest)
   * and recorded; `core.pullRequest.get` reads it in full. Null with none.
   */
  pullRequestId: OpaqueIdSchema.nullable(),
  /** Null exactly when `pullRequestId` is. */
  pullRequest: CorePullRequestRefreshSummarySchema.nullable(),
  /** The tracked base a new pull request targets; null when unresolved. */
  baseBranch: z.string().max(512).nullable(),
  headBranch: z.string().max(512),
  /**
   * The head eligibility was decided from (with the sandbox asleep, the open
   * pull request's); null when unreadable. Create sends it back.
   */
  headSha: GitObjectIdSchema.nullable(),
  /** The open pull request's head on GitHub, which merge sends back. */
  prHeadSha: GitObjectIdSchema.nullable(),
  /** Uncommitted changes; false when the checkout could not be read. */
  dirty: z.boolean(),
  /** Commits not on the upstream; null without an upstream or a read. */
  ahead: z.number().int().min(0).nullable(),
  /** Upstream commits not in the head; null without an upstream or a read. */
  behind: z.number().int().min(0).nullable(),
  /** The branch has an upstream. */
  published: z.boolean(),
  /** The branch has commits its base does not; null when unknown. */
  commitsAheadOfBase: z.boolean().nullable(),
  canCreate: z.boolean(),
  /** Set exactly when `canCreate` is false. */
  createBlockedReason: z
    .enum([
      'pr_open',
      'pr_status_unavailable',
      'no_remote',
      'detached_head',
      'base_branch',
      'no_changes',
      'needs_pull',
      'worktree_asleep',
    ])
    .optional(),
  canMerge: z.boolean(),
  /** Set exactly when `canMerge` is false. */
  mergeBlockedReason: z
    .enum([
      'no_pr',
      'draft',
      'conflicts',
      'checks_failing',
      'checks_pending',
      'review_pending',
      'local_changes',
      'other_repo_changes',
      'not_ready',
    ])
    .optional(),
  /** Merge is offered with a warning: unresolved or unknown review threads. */
  mergeWarning: z.boolean(),
});

export const CorePullRequestRefreshResultSchema = z.strictObject({
  repositories: z.array(CorePullRequestRefreshRepositorySchema).min(1),
  refreshedAt: TimestampSchema,
});

export type CorePullRequestRefreshResult = z.output<
  typeof CorePullRequestRefreshResultSchema
>;

const CORE_PULL_REQUEST_READ_CODES = [
  'core.pullRequest.invalidId',
  'core.pullRequest.integrationUnavailable',
  'core.pullRequest.repositoryUnavailable',
  'core.pullRequest.notAuthenticated',
] as const;

export const CORE_PULL_REQUEST_GET_ERROR_CODES = [
  ...CORE_PULL_REQUEST_READ_CODES,
  'core.pullRequest.notFound',
] as const;

export const CORE_PULL_REQUEST_LIST_ERROR_CODES = [
  ...CORE_PULL_REQUEST_READ_CODES,
  'core.pullRequest.list.invalidFilter',
  'core.pullRequest.list.scopeUnsupported',
] as const;

export const CORE_PULL_REQUEST_CREATE_ERROR_CODES = [
  ...CORE_PULL_REQUEST_READ_CODES,
  'core.pullRequest.create.invalidBranch',
  'core.pullRequest.create.headMissing',
  'core.pullRequest.create.headMismatch',
  'core.pullRequest.create.baseRejected',
  'core.pullRequest.projectionUnavailable',
  'core.pullRequest.idempotencyKeyReused',
] as const;

export const CORE_PULL_REQUEST_UPDATE_ERROR_CODES = [
  ...CORE_PULL_REQUEST_READ_CODES,
  'core.pullRequest.notFound',
  'core.pullRequest.update.invalidPatch',
  'core.pullRequest.update.draftUnsupported',
  'core.pullRequest.update.revisionConflict',
  'core.pullRequest.update.baseRejected',
  'core.pullRequest.projectionUnavailable',
  'core.pullRequest.idempotencyKeyReused',
] as const;

export const CORE_PULL_REQUEST_MERGE_ERROR_CODES = [
  ...CORE_PULL_REQUEST_READ_CODES,
  'core.pullRequest.notFound',
  'core.pullRequest.merge.headMismatch',
  'core.pullRequest.merge.revisionConflict',
  'core.pullRequest.merge.notMergeable',
  'core.pullRequest.merge.mergeQueueRequired',
  'core.pullRequest.projectionUnavailable',
  'core.pullRequest.idempotencyKeyReused',
] as const;

export const CORE_PULL_REQUEST_REFRESH_ERROR_CODES = [
  'core.pullRequest.repositoryUnavailable',
  'core.pullRequest.notAuthenticated',
] as const;

/** Pull request reads, served by the desktop dispatcher (CAN-4109). */
export const CORE_PULL_REQUEST_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.pullRequest.get': defineCanopyQuery({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestGetParamsSchema,
      result: CorePullRequestSchema,
      error: inherentOperationErrorSchema(CORE_PULL_REQUEST_GET_ERROR_CODES),
      idempotency: 'inherent',
      requiredGrants: ['core.pullRequest.read'],
    }),
    'core.pullRequest.list': defineCanopyQuery({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestListParamsSchema,
      result: CorePullRequestListResultSchema,
      error: inherentOperationErrorSchema(CORE_PULL_REQUEST_LIST_ERROR_CODES),
      idempotency: 'inherent',
      requiredGrants: ['core.pullRequest.read'],
    }),
  },
);

/** Pull request create and update, served by the desktop dispatcher (CAN-4109). */
export const CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.pullRequest.create': defineCanopyInstruction({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestCreateParamsSchema,
      result: CorePullRequestSchema,
      error: keyedOperationErrorSchema(CORE_PULL_REQUEST_CREATE_ERROR_CODES),
      idempotency: 'keyed',
      requiredGrants: ['core.pullRequest.write'],
    }),
    'core.pullRequest.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestUpdateParamsSchema,
      result: CorePullRequestSchema,
      error: keyedOperationErrorSchema(CORE_PULL_REQUEST_UPDATE_ERROR_CODES),
      idempotency: 'keyed',
      requiredGrants: ['core.pullRequest.write'],
    }),
  });

/**
 * Composed for the web core (CAN-5714) and desktop dispatcher (CAN-4728).
 * The packaged daemon does not register merge before GitHub enablement.
 */
export const CORE_PULL_REQUEST_MERGE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.pullRequest.merge': defineCanopyInstruction({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestMergeParamsSchema,
      result: CorePullRequestSchema,
      error: keyedOperationErrorSchema(CORE_PULL_REQUEST_MERGE_ERROR_CODES),
      idempotency: 'keyed',
      requiredGrants: ['core.pullRequest.write'],
    }),
  });

/**
 * Served by the web core only (CAN-6115): the cloud Git panel's refresh. The
 * desktop dispatcher does not compose it, so it answers
 * `capability_unavailable`. Inherent: each call records what it then reads.
 */
export const CORE_PULL_REQUEST_REFRESH_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.pullRequest.refresh': defineCanopyInstruction({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestRefreshParamsSchema,
      result: CorePullRequestRefreshResultSchema,
      error: inherentOperationErrorSchema(
        CORE_PULL_REQUEST_REFRESH_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: ['core.pullRequest.write'],
    }),
  });
