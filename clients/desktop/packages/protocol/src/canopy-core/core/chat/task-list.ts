import { z } from 'zod';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../shared';

const id = z.string().min(1).max(512);
const revision = z.number().int().nonnegative();

export const CoreChatTaskStateSchema = z.enum([
  'idle',
  'queued',
  'running',
  'awaiting_user',
  'completed',
  'failed',
  'archived',
]);

/** A cowork workspace's tasks; a task is its root chat, the `worktreeId` chat scopes take. */
export const CoreChatTaskListParamsSchema = z.strictObject({
  scope: z.strictObject({ workspaceId: id }),
  pageSize: z.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const CoreChatTaskSchema = z.object({
  workspaceId: id,
  worktreeId: id,
  title: z.string(),
  state: CoreChatTaskStateSchema,
  updatedAt: z.iso.datetime({ offset: true }),
  /** The task's revision, as `core.chat.snapshot.get` and `core.chat.events` report it. */
  revision,
});
export type CoreChatTask = z.output<typeof CoreChatTaskSchema>;

export const CoreChatTaskListResultSchema = z.object({
  items: z.array(CoreChatTaskSchema),
  nextCursor: z.string().min(1).max(2048).nullable(),
});

export const CoreChatTaskListErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(['core.chat.invalidState', 'core.chat.notFound']).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreChatTaskEventsParamsSchema = z.strictObject({
  scope: z.union([z.literal('all'), z.strictObject({ workspaceId: id })]),
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});

export const CoreChatTaskEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

/**
 * An invalidation signal: something in the task changed, so re-read it with
 * `core.chat.task.list`. `resync` asks for a full re-read of the scope.
 */
export const CoreChatTaskEventsItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('task'),
    workspaceId: id,
    worktreeId: id,
    batchId: id,
  }),
  z.strictObject({ kind: z.literal('resync') }),
]);
export type CoreChatTaskEventsItem = z.output<
  typeof CoreChatTaskEventsItemSchema
>;

export const CoreChatTaskEventsErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(['core.chat.notFound', 'core.chat.snapshotRequired']).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreChatTaskEventsEndSchema = CanopyStreamEndSchema.extend({
  error: CoreChatTaskEventsErrorSchema.nullable(),
});

// Served by the web core only (CAN-4185): cowork tasks are cloud chats. Kept
// out of CORE_QUERY_DEFINITIONS and CORE_STREAM_DEFINITIONS because the
// desktop dispatcher requires a handler for every definition it is given, and
// desktop cowork chats list through its own chat state.
export const CORE_CHAT_TASK_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.chat.task.list': defineCanopyQuery({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.read'],
      params: CoreChatTaskListParamsSchema,
      result: CoreChatTaskListResultSchema,
      error: CoreChatTaskListErrorSchema,
    }),
  },
);

export const CORE_CHAT_TASK_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'core',
  {
    'core.chat.task.events': defineCanopyStream({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.read'],
      params: CoreChatTaskEventsParamsSchema,
      item: CoreChatTaskEventsItemSchema,
      end: CoreChatTaskEventsEndSchema,
      openResult: CoreChatTaskEventsOpenResultSchema,
      error: CoreChatTaskEventsErrorSchema,
    }),
  },
);
