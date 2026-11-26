import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import { CanopyErrorPayloadSchema } from '../errors';
import { WORKER_GIT_GRANTS } from './git';

// A single-use, host-staged binding, never a path, URL or workspace selector.
export const WorkerGitRepositoryCreationParamsSchema = z.strictObject({
  bindingId: z.string().uuid(),
});
export type WorkerGitRepositoryCreationParams = z.output<
  typeof WorkerGitRepositoryCreationParamsSchema
>;
export const WorkerGitRepositoryCreationResultSchema = z.strictObject({});

export const WorkerGitRepositoryCreationErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.git.repository.callerRefused',
        'worker.git.repository.bindingUnavailable',
      ])
      .optional(),
  });

/** Desktop in-process only (CAN-4096); not a daemon registration or route. */
export const WORKER_GIT_REPOSITORY_CREATION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.git.repository.initialize': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'worker-only',
      error: WorkerGitRepositoryCreationErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
      params: WorkerGitRepositoryCreationParamsSchema,
      result: WorkerGitRepositoryCreationResultSchema,
    }),
    'worker.git.repository.clone': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'worker-only',
      error: WorkerGitRepositoryCreationErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
      params: WorkerGitRepositoryCreationParamsSchema,
      result: WorkerGitRepositoryCreationResultSchema,
    }),
  });
