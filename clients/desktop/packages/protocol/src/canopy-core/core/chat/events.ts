import { approvalSafetyDeniedInfoSchema } from '../../approval-safety';
import { z } from 'zod';
import {
  CardStateV2Schema,
  CORE_CHAT_EVENTS_SCHEMA_REVISION,
  CoreChatMessageMeterSchema,
} from './transcript';
import { mcpActivationRecordSchema } from '../../mcp-availability';
import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../shared';

const id = z.string().min(1).max(512);
const extension = z.unknown();
const portableBlock = z.discriminatedUnion('type', [
  approvalSafetyDeniedInfoSchema,
  z.strictObject({
    type: z.literal('mcp_activation'),
    record: mcpActivationRecordSchema,
  }),
  z
    .object({
      type: z.literal('image'),
      path: z.never().optional(),
    })
    .catchall(extension),
  z
    .object({
      type: z.literal('file_references'),
      references: z.array(
        z
          .object({
            absolutePath: z.never().optional(),
          })
          .catchall(extension),
      ),
    })
    .catchall(extension),
  z
    .object({
      type: z.literal('compaction_info'),
      transcriptPath: z.never().optional(),
    })
    .catchall(extension),
  z
    .object({
      type: z.literal('revert_info'),
      attachmentPath: z.never().optional(),
    })
    .catchall(extension),
  z
    .object({
      type: z.enum([
        'text',
        'thinking',
        'tool_use',
        'tool_result',
        'turn_timer',
        'hook_info',
        'automation_info',
        'claude_terminal_sync_warning',
        'account_proxy_switch',
        'claude_mods_skipped',
        'rebase_resolution_info',
        'builtin_gh_chat_info',
        'pending_setup_info',
        'approval_resolution_info',
        'codex_agent_call',
        'delegated_agent_call',
      ]),
    })
    .catchall(extension),
]);
const message = z
  .strictObject({
    id,
    role: z.enum(['user', 'assistant', 'system']),
    blocks: z.array(portableBlock),
    timestamp: z.number(),
    /** Revision 2: an assistant message's meter, when Core recorded one. */
    meter: CoreChatMessageMeterSchema.optional(),
  })
  .catchall(extension);
const tab = z
  .strictObject({
    id,
    title: z.string(),
    messages: z.array(message),
    createdAt: z.string(),
  })
  .catchall(extension);
const chatChange = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('delegation.card_state_updated'),
    chatId: id,
    delegationId: id,
    runGeneration: z.number().int().nonnegative().safe(),
    cardRevision: z.number().int().nonnegative().safe(),
    streamRevision: z.number().int().nonnegative().safe(),
    cardState: CardStateV2Schema,
  }),
  z
    .strictObject({
      type: z.literal('transcript.updated'),
      chatId: id,
      transcript: z.object({}).catchall(extension),
      reset: z.boolean(),
    })
    .catchall(extension),
  z.strictObject({ type: z.literal('tab.upserted'), tab }).catchall(extension),
  z
    .strictObject({ type: z.literal('tab.removed'), tabId: id })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('tab.metadata_patched'),
      tabId: id,
      patch: z.object({}).catchall(extension),
    })
    .catchall(extension),
  z
    .strictObject({ type: z.literal('tab.order_changed'), tabIds: z.array(id) })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('tab.active_changed'),
      activeTabId: z.string(),
    })
    .catchall(extension),
  z
    .strictObject({ type: z.literal('message.upserted'), chatId: id, message })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('message.removed'),
      chatId: id,
      messageId: id,
    })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('messages.replaced'),
      chatId: id,
      messages: z.array(message),
      removedMessageIds: z.array(id),
    })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('pending_question.upserted'),
      question: z
        .object({ requestId: id, chatId: id, questions: z.array(extension) })
        .catchall(extension),
    })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('pending_question.removed'),
      requestId: id,
      chatId: id,
    })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('runtime.patched'),
      chatId: id,
      runtime: z
        .object({ status: z.string(), queuedMessageIds: z.array(id) })
        .catchall(extension),
    })
    .catchall(extension),
  /**
   * The chat's agent tasks (subagents and background shells) as they stand,
   * replacing any earlier list; served by the web core only (CAN-5976).
   */
  z
    .strictObject({
      type: z.literal('agent_tasks.replaced'),
      chatId: id,
      tasks: z.array(extension).max(256),
    })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('archive.upserted'),
      archive: z
        .object({
          chatId: id,
          title: z.string(),
          turnCount: z.number(),
          archivedAt: z.string(),
          createdAt: z.string(),
          restorable: z.boolean(),
          unread: z.boolean(),
        })
        .catchall(extension),
    })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('archive.removed'),
      archiveEntryId: id,
      chatId: id,
    })
    .catchall(extension),
  z
    .strictObject({
      type: z.literal('archive.read_state_changed'),
      archiveEntryId: id,
      chatId: id,
      unread: z.boolean(),
    })
    .catchall(extension),
]);

export const CoreChatEventsParamsSchema = z.strictObject({
  scope: z.union([
    z.literal('all'),
    z.strictObject({ projectId: id, worktreeId: id }),
  ]),
  cursor: CanopyStreamCursorSchema.nullable().optional(),
  /** Revision 2 output, sent only when the runtime advertises it. */
  revision: z.literal(CORE_CHAT_EVENTS_SCHEMA_REVISION).optional(),
});

export const CoreChatEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

export const CoreChatEventsItemSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: id,
  occurredAt: z.iso.datetime({ offset: true }),
  projectId: id,
  worktreeId: id,
  baseRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  changes: z.array(chatChange).min(1),
});

export const CoreChatEventsErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.invalidState',
      'core.chat.revisionConflict',
      'core.chat.notFound',
      'core.chat.snapshotRequired',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreChatEventsEndSchema = CanopyStreamEndSchema.extend({
  error: CoreChatEventsErrorSchema.nullable(),
});
