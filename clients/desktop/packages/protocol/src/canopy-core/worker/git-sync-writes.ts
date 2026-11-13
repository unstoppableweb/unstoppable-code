import { z } from 'zod';

import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyRetryDirectiveSchema,
} from '../errors';
import {
  OperationKindSchema,
  OperationStatusSchema,
} from '../core/operation/schemas';
import { WORKER_GIT_GRANTS } from './git';
import {
  WorkerGitCheckoutScopeSchema,
  WorkerGitExpectedHeadSchema,
} from './git-branch-writes';

// Mutations are idempotency `none`: a failed or unknown outcome is retried
// only after the caller refreshes the checkout.
const WorkerGitSyncRetryDirectiveSchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[3],
]);

export const WORKER_GIT_FETCH_ERROR_CODES = [
  'worker.git.fetch.invalidScope',
  'worker.git.fetch.scopeUnsupported',
  'worker.git.fetch.callerRefused',
] as const;

export type WorkerGitFetchErrorCode =
  (typeof WORKER_GIT_FETCH_ERROR_CODES)[number];

export const WorkerGitFetchParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  /** Also delete `origin/*` refs whose branch `origin` no longer has. */
  prune: z.boolean(),
});

export type WorkerGitFetchParams = z.output<typeof WorkerGitFetchParamsSchema>;

export const WorkerGitFetchResultSchema = z.strictObject({
  /** The remote fetched; always `origin` in version 1. */
  remote: z.literal('origin'),
  pruned: z.boolean(),
});

export type WorkerGitFetchResult = z.output<typeof WorkerGitFetchResultSchema>;

export const WorkerGitFetchErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_FETCH_ERROR_CODES).optional(),
  retry: WorkerGitSyncRetryDirectiveSchema,
});

export const WORKER_GIT_PULL_ERROR_CODES = [
  'worker.git.pull.invalidScope',
  'worker.git.pull.scopeUnsupported',
  'worker.git.pull.callerRefused',
  'worker.git.pull.headChanged',
] as const;

export type WorkerGitPullErrorCode =
  (typeof WORKER_GIT_PULL_ERROR_CODES)[number];

/**
 * `fast-forward` runs `pull --ff-only`; `rebase` runs `pull --rebase
 * --autostash`, setting uncommitted changes aside and re-applying them.
 */
export const WORKER_GIT_PULL_STRATEGIES = ['fast-forward', 'rebase'] as const;

export type WorkerGitPullStrategy = (typeof WORKER_GIT_PULL_STRATEGIES)[number];

export const WorkerGitPullParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  /**
   * The `origin` branch to integrate. Unvalidated, as the desktop pull was:
   * a branch `origin` lacks fails as Git fails.
   */
  branch: z.string(),
  strategy: z.enum(WORKER_GIT_PULL_STRATEGIES),
  expected: WorkerGitExpectedHeadSchema.optional(),
});

export type WorkerGitPullParams = z.output<typeof WorkerGitPullParamsSchema>;

/**
 * Where a failed rebase pull left the checkout: `rebase` mid-rebase with
 * conflicts, or `autostash` rebased with the set-aside changes unmerged and
 * the autostash entry kept.
 */
export const WORKER_GIT_PULL_CONFLICTS = ['rebase', 'autostash'] as const;

export type WorkerGitPullConflict = (typeof WORKER_GIT_PULL_CONFLICTS)[number];

export const WorkerGitPullResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('pulled') }),
  z.strictObject({
    outcome: z.literal('conflict'),
    conflict: z.enum(WORKER_GIT_PULL_CONFLICTS),
  }),
]);

export type WorkerGitPullResult = z.output<typeof WorkerGitPullResultSchema>;

export const WorkerGitPullErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_PULL_ERROR_CODES).optional(),
  retry: WorkerGitSyncRetryDirectiveSchema,
});

/**
 * Fetching `origin` and pulling one branch into one checkout. Idempotency
 * `none`, with no `_meta` in params: a repeated call re-runs Git against the
 * checkout and `origin` as they then are (CAN-4108 Q7).
 */
export const WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.git.fetch': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitFetchParamsSchema,
      result: WorkerGitFetchResultSchema,
      error: WorkerGitFetchErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
    'worker.git.pull': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitPullParamsSchema,
      result: WorkerGitPullResultSchema,
      error: WorkerGitPullErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
  });

export const WORKER_GIT_COMMIT_ERROR_CODES = [
  'worker.git.commit.invalidScope',
  'worker.git.commit.scopeUnsupported',
  'worker.git.commit.callerRefused',
  'worker.git.commit.headChanged',
  'worker.git.commit.nothingToCommit',
] as const;

export type WorkerGitCommitErrorCode =
  (typeof WORKER_GIT_COMMIT_ERROR_CODES)[number];

export const WorkerGitCommitParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  /** Absent or blank, a core that can write one does; otherwise refused. */
  message: z.string().max(100_000).optional(),
  /** The paths to commit; absent stages and commits every change (`add -A`). */
  paths: z.array(z.string()).optional(),
  /** The commit `HEAD` must be at right before the commit. */
  expectedHeadSha: z.string(),
  amend: z.boolean().optional(),
  sign: z.boolean().optional(),
});

export type WorkerGitCommitParams = z.output<
  typeof WorkerGitCommitParamsSchema
>;

/** The operation a keyed commit or push started; `core.operation.get` follows it. */
export const WorkerGitOperationHandleSchema = z.strictObject({
  operationId: z.string().min(1).max(512),
  kind: OperationKindSchema,
  status: OperationStatusSchema,
});

export type WorkerGitOperationHandle = z.output<
  typeof WorkerGitOperationHandleSchema
>;

export const WorkerGitCommitErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_COMMIT_ERROR_CODES).optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const WORKER_GIT_PUSH_ERROR_CODES = [
  'worker.git.push.invalidScope',
  'worker.git.push.scopeUnsupported',
  'worker.git.push.callerRefused',
  'worker.git.push.headChanged',
  'worker.git.push.remoteChanged',
  'worker.git.push.rejected',
] as const;

export type WorkerGitPushErrorCode =
  (typeof WORKER_GIT_PUSH_ERROR_CODES)[number];

export const WorkerGitPushParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  remote: z.string(),
  branch: z.string(),
  /** The commit the local branch must be at right before the push. */
  expectedLocalHeadSha: z.string(),
  /**
   * The commit the remote branch must be at; null when it must not exist.
   * Absent, the remote branch is not checked.
   */
  expectedRemoteHeadSha: z.string().nullable().optional(),
  setUpstream: z.boolean().optional(),
});

export type WorkerGitPushParams = z.output<typeof WorkerGitPushParamsSchema>;

export const WorkerGitPushErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_PUSH_ERROR_CODES).optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

/**
 * Committing and pushing one checkout, keyed. Served by the web core
 * (CAN-5714), desktop dispatcher and daemon worker (CAN-5882).
 */
export const WORKER_GIT_COMMIT_PUSH_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.git.commit': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitCommitParamsSchema,
      result: WorkerGitOperationHandleSchema,
      error: WorkerGitCommitErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
    'worker.git.push': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitPushParamsSchema,
      result: WorkerGitOperationHandleSchema,
      error: WorkerGitPushErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
  });
