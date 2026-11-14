import { z } from 'zod';
import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
} from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { WorktreeRecoveryDescriptionSchema } from '../../../portal/worktree-discard-schemas';
// The routes' DTOs carry retained setup output past 32 KiB, as the listing's do.
import { CoreCloudJsonValueSchema } from '../workspace/reads';

/*
 * A cloud worktree's recovery and a cloud worktree's or repository project's
 * provisioning retry (CAN-6110). The web core serves them over the
 * `/api/cloud` routes' services; like the other web-only registries they stay
 * out of the composed registries, so the desktop dispatcher answers
 * `capability_unavailable`.
 */

const id = z.string().min(1).max(512);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** The route's `Retry-After`, set exactly while the work is still pending. */
const retryAfterMs = z.number().int().positive().optional();
const target = {
  worktreeId: id,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
};
const keyed = CanopyRequestMetadataSchema.extend({ idempotencyKey: id });

/** The recover route's body, one action per call, plus the worktree. */
export const CoreWorktreeRecoverParamsSchema = z.union([
  z.strictObject({
    ...target,
    source: z.enum(['checkpoint', 'base']),
    expectedRevision: revision,
  }),
  z.strictObject({
    ...target,
    source: z.literal('pushed-branch'),
    expectedRevision: revision,
    branchName: z.string().optional(),
  }),
  z.strictObject({
    ...target,
    choice: z.enum(['retry', 'cancel']),
    expectedRevision: revision,
  }),
  z.strictObject({
    ...target,
    verify: z.literal(true),
    /** Consent to the billable resume of a stopped sandbox. */
    wake: z.boolean().optional(),
  }),
]);
export type CoreWorktreeRecoverParams = z.output<
  typeof CoreWorktreeRecoverParamsSchema
>;

export const CoreWorktreeRecoverResultSchema = z.strictObject({
  /** The route's worktree as it sends it; null once purged. */
  worktree: CoreCloudJsonValueSchema,
  pending: z.boolean(),
  verification: z
    .enum(['verified', 'deferred', 'unknown', 'lost', 'skipped'])
    .optional(),
  retryAfterMs,
});

export const CoreWorktreeRetryParamsSchema = z.strictObject({
  worktreeId: id,
  _meta: keyed,
});

export const CoreWorktreeRetryResultSchema = z.strictObject({
  pending: z.boolean(),
  /** The route's worktree as it sends it. */
  worktree: CoreCloudJsonValueSchema,
  /** The worktree's first chat; null while pending. */
  chat: CoreCloudJsonValueSchema,
  retryAfterMs,
});

export const CoreWorkspaceRepositoryRetryParamsSchema = z.strictObject({
  workspaceId: id,
  _meta: keyed,
});

export const CoreWorkspaceRepositoryRetryResultSchema = z.strictObject({
  /** The route's repository as it sends it. */
  repository: CoreCloudJsonValueSchema,
  retryAfterMs,
});

/** The route's refusal: its status as the kind, its code in `details`. */
export const CoreWorktreeRecoverErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.never().optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreCloudRetryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.never().optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const CORE_CLOUD_RECOVERY_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.worktree.recover': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeRecoverParamsSchema,
      result: CoreWorktreeRecoverResultSchema,
      error: CoreWorktreeRecoverErrorSchema,
    }),
    'core.worktree.retry': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeRetryParamsSchema,
      result: CoreWorktreeRetryResultSchema,
      error: CoreCloudRetryErrorSchema,
    }),
    'core.workspace.repository.retry': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceRepositoryRetryParamsSchema,
      result: CoreWorkspaceRepositoryRetryResultSchema,
      error: CoreCloudRetryErrorSchema,
    }),
  });

export const WorktreeRecoveryListParamsSchema = z.strictObject({
  workspaceId: z.string().min(1).max(512),
  operationId: z.string().uuid().optional(),
});
export const WorktreeRecoveryListResultSchema = z.object({
  entries: z.array(WorktreeRecoveryDescriptionSchema),
  resolutions: z
    .array(
      z.object({
        operationId: z.string().uuid(),
        worktreeId: id,
        createdAt: z.string(),
        action: z.enum(['keep-worktree', 'release']),
        revision: z.string(),
        stage: z.string(),
        retention: z.enum(['deleting', 'deleted']).optional(),
        retainedSnapshots: z.number().int().nonnegative(),
        retainedPayload: z.boolean(),
      }),
    )
    .optional(),
  check: z.enum(['ok', 'journal-evidence-unreadable']),
});
export type WorktreeRecoveryListParams = z.infer<
  typeof WorktreeRecoveryListParamsSchema
>;
export type WorktreeRecoveryListResult = z.infer<
  typeof WorktreeRecoveryListResultSchema
>;

/** Desktop in-process only until archive orchestration and evidence ports move with CAN-4098. */
export const CORE_WORKTREE_RECOVERY_QUERIES = {
  'core.worktree.recovery.list': defineCanopyQuery({
    plane: 'core',
    domain: 'worktree',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.worktree.read'],
    params: WorktreeRecoveryListParamsSchema,
    result: WorktreeRecoveryListResultSchema,
    error: CanopyErrorPayloadSchema.extend({
      retry: CanopyQueryRetryDirectiveSchema,
    }),
  }),
};

export const WorktreeRecoveryResolveParamsSchema = z.strictObject({
  workspaceId: id,
  operationId: z.string().uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(['keep-worktree', 'release', 'delete-hold']),
});
export const WorktreeRecoveryResolveResultSchema = z.discriminatedUnion(
  'status',
  [
    z.object({
      status: z.enum(['worktree-kept', 'attempt-withdrawn']),
      operationId: z.string().uuid(),
      holdId: z.string().uuid(),
      retainedSnapshots: z.number().int().nonnegative(),
      retainedPayload: z.boolean(),
    }),
    z.object({
      status: z.literal('hold-deleted'),
      operationId: z.string().uuid(),
    }),
    z.object({
      status: z.enum(['refused', 'interrupted']),
      operationId: z.string().uuid(),
      check: z.enum(['resolution-not-admitted', 'resume-exact-resolution']),
    }),
  ],
);
export type WorktreeRecoveryResolveParams = z.infer<
  typeof WorktreeRecoveryResolveParamsSchema
>;
export type WorktreeRecoveryResolveResult = z.infer<
  typeof WorktreeRecoveryResolveResultSchema
>;

/** Exact reviewed operation; no caller-supplied filesystem or Git targets. */
export const WorktreeRecoveryFinishParamsSchema = z.strictObject({
  workspaceId: id,
  operationId: z.string().uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const WorktreeRecoveryFinishResultSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.enum(['finished', 'cleanup-pending']),
      operationId: z.string().uuid(),
      cleanupRequired: z.boolean(),
      gitCleanupPending: z.boolean(),
    }),
    z.strictObject({ status: z.literal('refused'), check: z.string() }),
    z.strictObject({ status: z.literal('interrupted'), check: z.string() }),
  ],
);
export type WorktreeRecoveryFinishParams = z.infer<
  typeof WorktreeRecoveryFinishParamsSchema
>;
export type WorktreeRecoveryFinishResult = z.infer<
  typeof WorktreeRecoveryFinishResultSchema
>;

export const CORE_WORKTREE_RECOVERY_INSTRUCTIONS = {
  'core.worktree.recovery.resolve': defineCanopyInstruction({
    plane: 'core',
    domain: 'worktree',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.worktree.write'],
    params: WorktreeRecoveryResolveParamsSchema,
    result: WorktreeRecoveryResolveResultSchema,
    error: CanopyErrorPayloadSchema.extend({
      retry: CanopyQueryRetryDirectiveSchema,
    }),
  }),
  'core.worktree.recovery.finish': defineCanopyInstruction({
    plane: 'core',
    domain: 'worktree',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.worktree.write'],
    params: WorktreeRecoveryFinishParamsSchema,
    result: WorktreeRecoveryFinishResultSchema,
    error: CanopyErrorPayloadSchema.extend({
      retry: CanopyQueryRetryDirectiveSchema,
    }),
  }),
};
