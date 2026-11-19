import { z } from 'zod';
import {
  WorkerPipelineOwnerRequestSchema,
  WorkerPipelineOwnerResultSchema,
} from './worker/pipeline-owner-requests';

const id = z.string().min(1).max(512);
export const WorkerPipelineSetupFactSchema = z.strictObject({
  id,
  root: z.enum([
    'data',
    'worktree',
    'claude-config',
    'codex-config',
    'home',
    'system',
  ]),
  relativePath: z
    .string()
    .min(1)
    .max(2048)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        value
          .split('/')
          .every((part) => part.length > 0 && part !== '.' && part !== '..'),
      'A fact must name a relative path inside its projected root.',
    ),
  projection: z.enum([
    'content',
    'preferences',
    'absence',
    'claude-connections',
    'local-plugin',
  ]),
  version: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Host-local snapshots; never copied to public run metadata or portable starts. */
export const WorkerPipelineStartSetupSchema = z.strictObject({
  version: z.literal(1),
  facts: z.array(WorkerPipelineSetupFactSchema).min(1).max(256),
  leases: z
    .array(
      z.strictObject({
        jobId: id,
        stepId: id,
        request: WorkerPipelineOwnerRequestSchema.refine(
          (value) =>
            value.action === 'owner.claude.modAdmission' ||
            value.action === 'owner.model.agentAlias' ||
            value.action === 'owner.codex.pluginRefs',
        ),
        result: WorkerPipelineOwnerResultSchema.refine(
          (value) =>
            value.kind === 'claude.modAdmission' ||
            value.kind === 'model.agentAlias' ||
            value.kind === 'codex.pluginRefs',
        ),
        factIds: z.array(id).min(1).max(256),
      }),
    )
    .max(256),
});

export type WorkerPipelineSetupFact = z.infer<
  typeof WorkerPipelineSetupFactSchema
>;
export type WorkerPipelineStartSetup = z.infer<
  typeof WorkerPipelineStartSetupSchema
>;
