import { TrackedPlanImplementationSchema } from '../../chat-plan-review';
import { z } from 'zod';

import {
  CanopyStreamCursorSchema,
  CanopyWorkspaceScopeSchema,
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyJsonValueSchema,
} from '../shared';

const id = z.string().min(1).max(512);
const revision = z.number().int().nonnegative();
const scopedWorktree = CanopyWorkspaceScopeSchema.extend({
  workspaceId: id,
  worktreeId: id,
});

export const CoreChatSnapshotGetParamsSchema = z.strictObject({
  scope: scopedWorktree,
  chatId: id.optional(),
});

/** One TODO item of a chat's current turn (CAN-4110). */
export const CoreChatTodoItemSchema = z.strictObject({
  id,
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export type CoreChatTodoItem = z.output<typeof CoreChatTodoItemSchema>;

/** A chat's committed model, thinking, plan, speed, approval and interface settings (CAN-4110). */
export const CoreChatTabSettingsSchema = z.object({
  model: z.string().nullable(),
  providerId: z.string().nullable(),
  executionHarness: z.string().nullable(),
  modelSelectionMode: z.enum(['auto', 'manual']),
  thinkingLevel: z.string().nullable(),
  speed: z.string().nullable(),
  planMode: z.boolean(),
  approvalMode: z.enum(['ask', 'auto', 'full-access']).nullable(),
  interfaceMode: z.enum(['canopy', 'claude-code', 'auto']).nullable(),
  customTitle: z.string().nullable(),
});
export type CoreChatTabSettings = z.output<typeof CoreChatTabSettingsSchema>;

const usageCount = z.number().int().min(0);

/** A chat's committed context and token usage as the chat shows it (CAN-4114). */
export const CoreChatTabUsageSchema = z.object({
  contextTokens: usageCount,
  contextWindow: usageCount,
  maxOutputTokens: usageCount,
  inputTokens: usageCount,
  outputTokens: usageCount,
  cacheReadInputTokens: usageCount,
  cacheCreationInputTokens: usageCount,
  totalCostUsd: z.number().min(0),
  numTurns: usageCount,
  model: z.string().max(256),
});
export type CoreChatTabUsage = z.output<typeof CoreChatTabUsageSchema>;

/** The provider usage limit a chat last hit, without provider text (CAN-4114). */
export const CoreChatUsageLimitSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  detectedAt: usageCount,
  resetsAt: usageCount.optional(),
  dismissed: z.boolean(),
});
export type CoreChatUsageLimit = z.output<typeof CoreChatUsageLimitSchema>;

/** A hosted AI Credits request that found no billing source (CAN-4114). */
export const CoreChatNoBillingSourceSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  detectedAt: usageCount,
});
export type CoreChatNoBillingSource = z.output<
  typeof CoreChatNoBillingSourceSchema
>;

export const CoreChatTabSummarySchema = z.object({
  trackedPlanImplementation:
    TrackedPlanImplementationSchema.nullable().optional(),
  chatId: id,
  title: z.string(),
  kind: z.enum(['chat', 'file']),
  createdAt: z.string(),
  unread: z.boolean().optional(),
  providerId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  settings: CoreChatTabSettingsSchema.optional(),
  todos: z.array(CoreChatTodoItemSchema).optional(),
  taskTodos: z.array(CoreChatTodoItemSchema).optional(),
  usage: CoreChatTabUsageSchema.optional(),
  usageLimit: CoreChatUsageLimitSchema.optional(),
  noBillingSource: CoreChatNoBillingSourceSchema.optional(),
  /** The chat's committed transcript revision; reread transcript pages whose revision differs (CAN-4111). */
  transcriptRevision: z.number().int().nonnegative().optional(),
});

export const CoreChatArchiveSummarySchema = z.object({
  chatId: id,
  title: z.string(),
  archivedAt: z.string(),
  createdAt: z.string(),
  turnCount: z.number().int().nonnegative(),
  unread: z.boolean(),
  restorable: z.boolean(),
});

export const CoreChatRuntimeSummarySchema = z.object({
  status: z.enum([
    'idle',
    'queued',
    'starting',
    'streaming',
    'awaiting_input',
    'completing',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  queuedMessageIds: z.array(id),
  lastActivityAt: z.number().optional(),
  /** The running turn's id, as `core.chat.turn.cancel` takes it; absent when none runs or the core does not report it (CAN-4185). */
  activeTurnId: id.optional(),
});

export const CoreChatQueueSummarySchema = z.object({
  chatId: id,
  entries: z.array(
    z.object({
      id,
      origin: z.enum(['desktop', 'portal']),
      enqueuedAtMs: z.number(),
      revision: z.number().int().min(1).optional(),
    }),
  ),
});

export const CoreChatSnapshotGetResultSchema = z.object({
  workspaceId: id,
  worktreeId: id,
  revision,
  /** Resumes `core.chat.events` for this scope right after `revision` (CAN-4111). */
  eventsCursor: CanopyStreamCursorSchema.optional(),
  tabs: z.object({
    activeTabId: z.string(),
    items: z.array(CoreChatTabSummarySchema),
  }),
  archives: z.array(CoreChatArchiveSummarySchema),
  runtimeByChatId: z.record(id, CoreChatRuntimeSummarySchema),
  queue: z.array(CoreChatQueueSummarySchema),
  pendingApprovals: z.array(CanopyJsonValueSchema).optional(),
  /**
   * Unanswered questions, in the shape `pending_question.upserted` carries
   * (CAN-4185): every live chat's in a task-scope read (no `chatId`), the
   * opened chat's in a chat-scope read (CAN-6319).
   */
  pendingQuestions: z
    .array(
      z
        .object({
          requestId: id,
          chatId: id,
          questions: z.array(CanopyJsonValueSchema),
          toolUseId: id.optional(),
        })
        .catchall(CanopyJsonValueSchema),
    )
    .optional(),
  /**
   * Chats whose unanswered questions could not be read, so `pendingQuestions`
   * leaves theirs out. A client keeps the questions it shows for them
   * (CAN-6319).
   */
  unreadQuestionChatIds: z.array(id).optional(),
  todos: z.array(CanopyJsonValueSchema).optional(),
  tasks: z.array(CanopyJsonValueSchema).optional(),
});

export const CoreChatSnapshotGetErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.snapshot.invalidState',
      'core.chat.snapshot.revisionConflict',
      'core.chat.snapshot.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreChatListParamsSchema = z.strictObject({
  scope: scopedWorktree,
  pageSize: z.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const CoreChatListResultSchema = z.object({
  items: z.array(
    z.object({
      chatId: id,
      workspaceId: id,
      worktreeId: id.nullable(),
      title: z.string(),
      state: z.enum([
        'idle',
        'queued',
        'running',
        'awaiting_user',
        'completed',
        'failed',
        'archived',
      ]),
      revision,
      providerId: z.string().nullable().optional(),
      modelId: z.string().nullable().optional(),
      providerSessionId: z.string().nullable().optional(),
      targetId: z.string().nullable().optional(),
      createdAt: z.string(),
      updatedAt: z.iso.datetime({ offset: true }).optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const CoreChatListErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.invalidState',
      'core.chat.revisionConflict',
      'core.chat.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
