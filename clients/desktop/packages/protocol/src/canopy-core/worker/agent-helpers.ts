import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
} from '../errors';

/*
 * `worker.agent.helper.run` (CAN-4122): one helper model call (branch name,
 * commit message, summary, review, diagram, automation text, local memory,
 * pipeline advisor turn) on a worker, as the child dispatch of a
 * `core.helper.run` operation. Params carry ids only; the request itself is
 * staged by the owning core's host until CAN-4115 makes it portable.
 */
export const WORKER_AGENT_GRANTS = {
  execute: 'worker.agent.execute',
  auth: 'worker.agent.auth',
  read: 'worker.agent.read',
  usageRead: 'worker.agent.usage.read',
} as const;

export const WORKER_AGENT_HELPER_KINDS = [
  'automation_if_command_generation',
  'branch_naming',
  'chat_archive_summary',
  'chat_handoff_summary',
  'chat_summary',
  'code_review_annotations',
  'code_review_diagram',
  'commit_message_generation',
  'cron_generation',
  'local_memory_chat_profile',
  'local_memory_consolidation',
  'pipeline_advisor',
  'pr_generation',
  'pr_split_planning',
  'skill_suggestion_scan',
  'worktree_plan_diagram',
  'worktree_summary',
] as const;
export type WorkerAgentHelperKind = (typeof WORKER_AGENT_HELPER_KINDS)[number];

export const WORKER_AGENT_HELPER_ERROR_CODES = [
  'worker.agent.helperLaunchUnavailable',
  'worker.agent.idempotencyKeyReused',
] as const;
export const WORKER_AGENT_HELPER_FAILED_CODE = 'worker.agent.helperFailed';
export const WORKER_AGENT_HELPER_FAILED_MESSAGE =
  'The helper model call failed.';
export const WORKER_AGENT_HELPER_MODEL_MAX = 256;

const id = z.string().min(1).max(512);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const WorkerAgentHelperScopeSchema = z.strictObject({
  workspaceId: id.optional(),
  worktreeId: id.optional(),
  chatId: id.optional(),
  executionId: id.optional(),
  repoId: id.optional(),
  authorityId: id.optional(),
  targetId: id.optional(),
});
export type WorkerAgentHelperScope = z.output<
  typeof WorkerAgentHelperScopeSchema
>;

export const WorkerAgentHelperRunParamsSchema = z.strictObject({
  helperRunId: id,
  kind: z.enum(WORKER_AGENT_HELPER_KINDS),
  scope: WorkerAgentHelperScopeSchema,
  model: z.string().min(1).max(WORKER_AGENT_HELPER_MODEL_MAX),
});
export type WorkerAgentHelperRunParams = z.output<
  typeof WorkerAgentHelperRunParamsSchema
>;

export const WorkerAgentHelperUsageSchema = z.strictObject({
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  cacheReadInputTokens: count.optional(),
  cacheCreationInputTokens: count.optional(),
  reasoningOutputTokens: count.optional(),
  totalCostUsd: z.number().min(0).max(1_000_000).optional(),
  messageCount: count.optional(),
  assistantMessageCount: count.optional(),
});
export type WorkerAgentHelperUsage = z.output<
  typeof WorkerAgentHelperUsageSchema
>;

export const WorkerAgentHelperResultDigestSchema = z.strictObject({
  present: z.boolean(),
  sha256: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
  bytes: count.nullable(),
});

const base = {
  helperRunId: id,
  kind: z.enum(WORKER_AGENT_HELPER_KINDS),
  usage: WorkerAgentHelperUsageSchema,
};
export const WorkerAgentHelperRunResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...base,
    status: z.literal('succeeded'),
    result: WorkerAgentHelperResultDigestSchema,
  }),
  z.strictObject({
    ...base,
    status: z.literal('failed'),
    error: z.strictObject({
      code: z.literal(WORKER_AGENT_HELPER_FAILED_CODE),
      message: z.string().min(1).max(1_024),
    }),
  }),
  z.strictObject({ ...base, status: z.literal('cancelled') }),
]);
export type WorkerAgentHelperRunResult = z.output<
  typeof WorkerAgentHelperRunResultSchema
>;

export const WorkerAgentHelperRunErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_AGENT_HELPER_ERROR_CODES).optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.agent.helper.run': defineCanopyInstruction({
      plane: 'worker',
      domain: 'agent',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: [WORKER_AGENT_GRANTS.execute],
      params: WorkerAgentHelperRunParamsSchema,
      result: WorkerAgentHelperRunResultSchema,
      error: WorkerAgentHelperRunErrorSchema,
    }),
  });
