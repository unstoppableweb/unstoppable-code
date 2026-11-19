import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import { CanopyErrorPayloadSchema } from '../errors';
import { WORKER_GIT_GRANTS } from './git';
import {
  WorkerGitCheckoutScopeSchema,
  WorkerGitRecordedRepositoryScopeSchema,
} from './git-branch-writes';

/** A target may be reserved but not yet listed by its owning W5 command. */
export const WorkerGitWorktreeAddParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  branch: z.string(),
  backgroundPriority: z.boolean().optional(),
});
export const WorkerGitWorktreeRemoveParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
});
export const WorkerGitWorktreePruneParamsSchema = z.strictObject({
  scope: WorkerGitRecordedRepositoryScopeSchema,
});
export type WorkerGitWorktreeAddParams = z.output<
  typeof WorkerGitWorktreeAddParamsSchema
>;
export type WorkerGitWorktreeRemoveParams = z.output<
  typeof WorkerGitWorktreeRemoveParamsSchema
>;
export type WorkerGitWorktreePruneParams = z.output<
  typeof WorkerGitWorktreePruneParamsSchema
>;
export const WorkerGitWorktreeWriteErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.git.worktree.invalidScope',
        'worker.git.worktree.scopeUnsupported',
        'worker.git.worktree.callerRefused',
      ])
      .optional(),
  });
export const WORKER_GIT_WORKTREE_WRITE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.git.worktree.add': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'worker-only',
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.worktreeWrite],
      params: WorkerGitWorktreeAddParamsSchema,
      result: z.strictObject({ branch: z.string() }),
      error: WorkerGitWorktreeWriteErrorSchema,
    }),
    'worker.git.worktree.remove': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'worker-only',
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.worktreeWrite],
      params: WorkerGitWorktreeRemoveParamsSchema,
      result: z.strictObject({}),
      error: WorkerGitWorktreeWriteErrorSchema,
    }),
    'worker.git.worktree.prune': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'worker-only',
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.worktreeWrite],
      params: WorkerGitWorktreePruneParamsSchema,
      result: z.strictObject({}),
      error: WorkerGitWorktreeWriteErrorSchema,
    }),
  });
