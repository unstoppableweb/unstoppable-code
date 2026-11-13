import { z } from 'zod';
import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
} from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
  canopyJsonValueSchemaWithin,
} from '../../errors';

/*
 * A cloud chat's agent tasks, background work and wake turns (CAN-6107). The
 * web core serves them over the `/api/cloud` routes' services; like the other
 * web-only registries they stay out of the composed chat registry, so the
 * desktop dispatcher needs no handler and answers `capability_unavailable`.
 */

const id = z.string().min(1).max(512);
/** Core's task id: hex UUID shaped, any version. */
const agentTaskId = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  );
const count = z.number().int().nonnegative();

export const CoreChatAgentTaskListParamsSchema = z.strictObject({
  chatId: id,
  kind: z.enum(['subagent', 'background_shell']).optional(),
  status: z.enum(['live', 'all']).optional(),
  taskIds: z.array(agentTaskId).max(100).optional(),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,1024}$/)
    .optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type CoreChatAgentTaskListParams = z.output<
  typeof CoreChatAgentTaskListParamsSchema
>;

export const CoreChatAgentTaskListResultSchema = z.strictObject({
  /** Agent task rows, the shape `core.chat.snapshot.get` carries in `tasks`. */
  tasks: z.array(CanopyJsonValueSchema),
  nextCursor: z.string().min(1).nullable(),
  snapshotId: z.string().min(1),
});

export const CoreChatAgentTaskTranscriptPageParamsSchema = z.strictObject({
  chatId: id,
  taskId: id,
  /** The opaque `before` a previous page returned. */
  before: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type CoreChatAgentTaskTranscriptPageParams = z.output<
  typeof CoreChatAgentTaskTranscriptPageParamsSchema
>;

/**
 * The most a transcript page carries as UTF-8 JSON: half a web core message,
 * since a tool result alone can be large. A larger page comes back shorter.
 */
export const CORE_CHAT_AGENT_TASK_TRANSCRIPT_PAGE_MAX_BYTES = 8 * 1024 * 1024;
const transcriptRow = canopyJsonValueSchemaWithin(
  CORE_CHAT_AGENT_TASK_TRANSCRIPT_PAGE_MAX_BYTES,
);

export const CoreChatAgentTaskTranscriptPageResultSchema = z.strictObject({
  task: CanopyJsonValueSchema,
  messages: z.array(transcriptRow),
  events: z.array(transcriptRow),
  /** The cursor for the next older page; null at the start of the task. */
  before: z.string().min(1).nullable(),
});

export const CoreChatBackgroundWorkSchema = z.strictObject({
  liveTaskCount: count,
  /** When Agentic Core stops the parked work; null while a turn holds it. */
  capExpiresAt: z.string().min(1).nullable(),
  /** When to start warning; null with `capExpiresAt`. */
  warnAt: z.string().min(1).nullable(),
  /** Whether `core.chat.backgroundWork.extend` would move `capExpiresAt`. */
  extendable: z.boolean(),
});
export type CoreChatBackgroundWork = z.output<
  typeof CoreChatBackgroundWorkSchema
>;

export const CoreChatWakeParkedSchema = z.strictObject({
  reason: z.string(),
  since: z.string(),
});

export const CoreChatAgentWorkGetParamsSchema = z.strictObject({
  chatId: id,
});

export const CoreChatAgentWorkGetResultSchema = z.strictObject({
  /** Which of `core.chat.agentTask.stop`'s forms this caller may use. */
  controls: z.strictObject({ stop: z.boolean(), stopAll: z.boolean() }),
  backgroundWork: CoreChatBackgroundWorkSchema.nullable(),
  wakeParked: CoreChatWakeParkedSchema.nullable(),
});

export const CoreChatAgentTaskStopParamsSchema = z.strictObject({
  chatId: id,
  /** One task; omitted, every live background task of the chat. */
  taskId: id.regex(/\S/).optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export type CoreChatAgentTaskStopParams = z.output<
  typeof CoreChatAgentTaskStopParamsSchema
>;

export const CoreChatAgentTaskStopResultSchema = z.union([
  z.strictObject({
    outcome: z.enum(['stopped', 'already-finished', 'session-ended']),
  }),
  z.strictObject({
    stopped: z.array(id),
    alreadyFinished: z.array(id),
    sessionEnded: z.boolean(),
  }),
]);

export const CoreChatBackgroundWorkExtendParamsSchema = z.strictObject({
  chatId: id,
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: id }),
});
export type CoreChatBackgroundWorkExtendParams = z.output<
  typeof CoreChatBackgroundWorkExtendParamsSchema
>;

export const CoreChatWakeResumeParamsSchema = z.strictObject({
  chatId: id,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const CoreChatWakeResumeResultSchema = z.strictObject({
  wakeParked: z.null(),
});

export const CoreChatAgentTaskRootsListParamsSchema = z.strictObject({
  /** A repository worktree's id, or a Cowork task's root chat id. */
  worktreeId: id,
});

export const CoreChatAgentTaskRootSchema = z.strictObject({
  chatId: id,
  title: z.string().nullable(),
  /** The chat's tab is closed; it is listed only while its work is live. */
  closed: z.boolean(),
  subagentTotal: count,
  subagentLive: count,
  backgroundLive: count,
  lastActivityAt: z.string().min(1).nullable(),
});

export const CoreChatAgentTaskRootsListResultSchema = z.strictObject({
  roots: z.array(CoreChatAgentTaskRootSchema),
});

export const CoreChatAgentTaskErrorSchema = CanopyErrorPayloadSchema.extend({
  /** These refusals carry no operation code. */
  code: z.never().optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreChatAgentTaskStopErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(['core.chat.agentTask.notStoppable']).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  },
);

export const CoreChatBackgroundWorkExtendErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(['core.chat.backgroundWork.notExtendable']).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const CORE_CHAT_AGENT_TASK_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.chat.agentTask.list': defineCanopyQuery({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.read'],
      params: CoreChatAgentTaskListParamsSchema,
      result: CoreChatAgentTaskListResultSchema,
      error: CoreChatAgentTaskErrorSchema,
    }),
    'core.chat.agentTask.transcript.page': defineCanopyQuery({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.read'],
      params: CoreChatAgentTaskTranscriptPageParamsSchema,
      result: CoreChatAgentTaskTranscriptPageResultSchema,
      error: CoreChatAgentTaskErrorSchema,
    }),
    'core.chat.agentWork.get': defineCanopyQuery({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.read'],
      params: CoreChatAgentWorkGetParamsSchema,
      result: CoreChatAgentWorkGetResultSchema,
      error: CoreChatAgentTaskErrorSchema,
    }),
    'core.chat.agentTask.roots.list': defineCanopyQuery({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.read'],
      params: CoreChatAgentTaskRootsListParamsSchema,
      result: CoreChatAgentTaskRootsListResultSchema,
      error: CoreChatAgentTaskErrorSchema,
    }),
  },
);

export const CORE_CHAT_AGENT_TASK_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.chat.agentTask.stop': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.write'],
      params: CoreChatAgentTaskStopParamsSchema,
      result: CoreChatAgentTaskStopResultSchema,
      error: CoreChatAgentTaskStopErrorSchema,
    }),
    'core.chat.backgroundWork.extend': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatBackgroundWorkExtendParamsSchema,
      result: CoreChatBackgroundWorkSchema,
      error: CoreChatBackgroundWorkExtendErrorSchema,
    }),
    'core.chat.wake.resume': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.write'],
      params: CoreChatWakeResumeParamsSchema,
      result: CoreChatWakeResumeResultSchema,
      error: CoreChatAgentTaskErrorSchema,
    }),
  });
