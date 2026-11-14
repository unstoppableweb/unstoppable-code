import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyRetryDirectiveSchema,
} from '../errors';
import { WORKER_GIT_GRANTS } from './git';

/**
 * One checkout of one worktree on the serving authority and target: the
 * worktree root, or the child repository `repoId` names. `__workspace_root__`
 * and an absent `repoId` both select the root.
 */
export const WorkerGitCheckoutScopeSchema = CanopyWorkspaceScopeSchema.pick({
  workspaceId: true,
  worktreeId: true,
  repoId: true,
  authorityId: true,
  targetId: true,
}).required({ workspaceId: true, worktreeId: true });

export type WorkerGitCheckoutScope = z.output<
  typeof WorkerGitCheckoutScopeSchema
>;

/**
 * Rename checks this branch before changing its name. Checkout and create
 * accept the legacy field but rely on Git’s switch safety checks instead.
 */
export const WorkerGitExpectedHeadSchema = z.strictObject({
  branch: z.string().min(1),
});

// Mutations are idempotency `none`: a failed or unknown outcome is retried
// only after the caller refreshes the checkout.
const WorkerGitWriteRetryDirectiveSchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[3],
]);

export const WORKER_GIT_CHECKOUT_ERROR_CODES = [
  'worker.git.checkout.invalidScope',
  'worker.git.checkout.scopeUnsupported',
  'worker.git.checkout.callerRefused',
  'worker.git.checkout.uncommittedChanges',
  'worker.git.checkout.branchOccupied',
  'worker.git.checkout.branchNotFound',
  'worker.git.checkout.headChanged',
] as const;

export type WorkerGitCheckoutErrorCode =
  (typeof WORKER_GIT_CHECKOUT_ERROR_CODES)[number];

export const WorkerGitCheckoutParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  /**
   * A local branch, or an `origin` branch to track under the same name.
   * Unvalidated, as the desktop switch was: a name no ref matches is
   * `branchNotFound`.
   */
  branch: z.string(),
  /** Explicit catalogue provenance. Omitted callers keep local-first lookup. */
  remote: z.boolean().optional(),
  expected: WorkerGitExpectedHeadSchema.optional(),
});

export type WorkerGitCheckoutParams = z.output<
  typeof WorkerGitCheckoutParamsSchema
>;

export const WorkerGitCheckoutResultSchema = z.strictObject({
  /** The branch now checked out. */
  branch: z.string(),
});

export type WorkerGitCheckoutResult = z.output<
  typeof WorkerGitCheckoutResultSchema
>;

export const WorkerGitCheckoutErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_CHECKOUT_ERROR_CODES).optional(),
  retry: WorkerGitWriteRetryDirectiveSchema,
});

/**
 * `worker.git.branch.create` shares the `worker.git.branch` scope codes with
 * `worker.git.branch.list`.
 */
export const WORKER_GIT_BRANCH_CREATE_ERROR_CODES = [
  'worker.git.branch.invalidScope',
  'worker.git.branch.scopeUnsupported',
  'worker.git.branch.callerRefused',
  'worker.git.branch.uncommittedChanges',
  'worker.git.branch.invalidName',
  'worker.git.branch.invalidStartPoint',
  'worker.git.branch.headChanged',
] as const;

export type WorkerGitBranchCreateErrorCode =
  (typeof WORKER_GIT_BRANCH_CREATE_ERROR_CODES)[number];

export const WorkerGitBranchStartPointSchema = z.strictObject({
  /** A Git start point, or a canonical branch name when source is catalog. */
  branch: z.string(),
  /** Start at `origin/<branch>` instead of the local branch. */
  remote: z.boolean(),
  /** An explicit catalogue selection must resolve only its local/origin ref. */
  source: z.literal('catalog').optional(),
});

export const WorkerGitBranchCreateParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  /** The typed name; a name already taken gets the first free `-<n>` suffix. */
  name: z.string(),
  startPoint: WorkerGitBranchStartPointSchema,
  expected: WorkerGitExpectedHeadSchema.optional(),
});

export type WorkerGitBranchCreateParams = z.output<
  typeof WorkerGitBranchCreateParamsSchema
>;

export const WorkerGitBranchCreateResultSchema = z.strictObject({
  /** The branch created and checked out, after any suffix. */
  branch: z.string(),
  /** Git returned an error after switching HEAD to the created branch. */
  warning: z
    .strictObject({
      code: z.literal('checkout-command-failed'),
      upstream: z.enum(['configured', 'partial', 'unset']),
    })
    .optional(),
});

export type WorkerGitBranchCreateResult = z.output<
  typeof WorkerGitBranchCreateResultSchema
>;

export const WorkerGitBranchCreateErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(WORKER_GIT_BRANCH_CREATE_ERROR_CODES).optional(),
    retry: WorkerGitWriteRetryDirectiveSchema,
  },
);

/**
 * `worker.git.branch.rename` shares the `worker.git.branch` scope codes with
 * `worker.git.branch.list` and `worker.git.branch.create`.
 */
export const WORKER_GIT_BRANCH_RENAME_ERROR_CODES = [
  'worker.git.branch.invalidScope',
  'worker.git.branch.scopeUnsupported',
  'worker.git.branch.callerRefused',
  'worker.git.branch.invalidName',
  'worker.git.branch.nameUnavailable',
  'worker.git.branch.headChanged',
] as const;

export type WorkerGitBranchRenameErrorCode =
  (typeof WORKER_GIT_BRANCH_RENAME_ERROR_CODES)[number];

export const WorkerGitBranchRenameParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  /** The checkout's current branch's new name, used as given (untrimmed). */
  name: z.string(),
  expected: WorkerGitExpectedHeadSchema.optional(),
});

export type WorkerGitBranchRenameParams = z.output<
  typeof WorkerGitBranchRenameParamsSchema
>;

export const WorkerGitBranchRenameResultSchema = z.strictObject({
  /** The checkout's branch, under its new name. */
  branch: z.string(),
});

export type WorkerGitBranchRenameResult = z.output<
  typeof WorkerGitBranchRenameResultSchema
>;

export const WorkerGitBranchRenameErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(WORKER_GIT_BRANCH_RENAME_ERROR_CODES).optional(),
    retry: WorkerGitWriteRetryDirectiveSchema,
  },
);

/**
 * One repository a workspace records, not a checkout: the workspace's own
 * repository (a single-repo repository or a multi-repo source repository)
 * for `__workspace_root__` or an absent `repoId`, else the multi-repo member
 * `repoId` names. Branches outlive the worktrees that checked them out.
 */
export const WorkerGitRecordedRepositoryScopeSchema =
  CanopyWorkspaceScopeSchema.pick({
    workspaceId: true,
    repoId: true,
    authorityId: true,
    targetId: true,
  }).required({ workspaceId: true });

export type WorkerGitRecordedRepositoryScope = z.output<
  typeof WorkerGitRecordedRepositoryScopeSchema
>;

export const WORKER_GIT_BRANCH_DELETE_ERROR_CODES = [
  'worker.git.branch.invalidScope',
  'worker.git.branch.scopeUnsupported',
  'worker.git.branch.callerRefused',
  'worker.git.branch.invalidName',
  'worker.git.branch.checkedOut',
] as const;

export type WorkerGitBranchDeleteErrorCode =
  (typeof WORKER_GIT_BRANCH_DELETE_ERROR_CODES)[number];

/** A full object ID: SHA-1 or SHA-256, lowercase hex. */
export const WorkerGitObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/**
 * How the branch is deleted: `merged` lets Git refuse a branch not merged
 * into its upstream or `HEAD` (`branch -d`), `force` does not (`branch -D`),
 * and `tip` deletes only while the branch still points at `tip` and no
 * worktree has it checked out (`update-ref -d`).
 */
export const WorkerGitBranchDeletionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('merged') }),
  z.strictObject({ kind: z.literal('force') }),
  z.strictObject({ kind: z.literal('tip'), tip: WorkerGitObjectIdSchema }),
]);

export type WorkerGitBranchDeletion = z.output<
  typeof WorkerGitBranchDeletionSchema
>;

export const WorkerGitBranchDeleteParamsSchema = z.strictObject({
  scope: WorkerGitRecordedRepositoryScopeSchema,
  /** A local branch name; never empty or option-like. */
  branch: z.string(),
  deletion: WorkerGitBranchDeletionSchema,
});

export type WorkerGitBranchDeleteParams = z.output<
  typeof WorkerGitBranchDeleteParamsSchema
>;

export const WorkerGitBranchDeleteResultSchema = z.strictObject({
  /** The branch deleted. */
  branch: z.string(),
});

export type WorkerGitBranchDeleteResult = z.output<
  typeof WorkerGitBranchDeleteResultSchema
>;

export const WorkerGitBranchDeleteErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(WORKER_GIT_BRANCH_DELETE_ERROR_CODES).optional(),
    retry: WorkerGitWriteRetryDirectiveSchema,
  },
);

/**
 * Branch checkout and creation in one checkout. Idempotency `none`, with no
 * `_meta` in params: a repeated call re-runs Git against the checkout as it
 * then is (CAN-4108 Q7).
 */
export const WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.git.checkout': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitCheckoutParamsSchema,
      result: WorkerGitCheckoutResultSchema,
      error: WorkerGitCheckoutErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
    'worker.git.branch.create': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitBranchCreateParamsSchema,
      result: WorkerGitBranchCreateResultSchema,
      error: WorkerGitBranchCreateErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
  });

/**
 * Branch rename in one checkout and branch delete in one recorded
 * repository, changing refs only. Idempotency `none`, with no `_meta` in
 * params (CAN-4108 Q7, CAN-5516).
 */
export const WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.git.branch.rename': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitBranchRenameParamsSchema,
      result: WorkerGitBranchRenameResultSchema,
      error: WorkerGitBranchRenameErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
    'worker.git.branch.delete': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitBranchDeleteParamsSchema,
      result: WorkerGitBranchDeleteResultSchema,
      error: WorkerGitBranchDeleteErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
  });
