import { z } from 'zod';
import {
  botsCreateTaskActionSchema,
  botsCreateTaskChatActionSchema,
  botsSendMessageActionSchema,
  projectsCreateTaskActionSchema,
  projectsCreateTaskChatActionSchema,
  projectsScheduleMessageActionSchema,
  projectsSendMessageActionSchema,
  projectsSteerQueuedMessageActionSchema,
  type NewInlineWatcher,
} from '@canopy/agent-actions/families/projects/messages';

// The schemas moved to the shared projects and bots action families.
export {
  botsCreateTaskActionSchema,
  botsCreateTaskChatActionSchema,
  botsSendMessageActionSchema,
  newInlineWatcherSchema,
  projectsCreateTaskActionSchema,
  projectsCreateTaskChatActionSchema,
  projectsScheduleMessageActionSchema,
  projectsSendMessageActionSchema,
  projectsSteerQueuedMessageActionSchema,
  scheduledMessageAttachmentsSchema,
  SCHEDULED_ATTACHMENT_PROMPT_KINDS,
  type BotsCreateTaskAction,
  type NewInlineWatcher,
  type BotsCreateTaskChatAction,
  type BotsSendMessageAction,
  type ProjectsCreateTaskAction,
  type ProjectsCreateTaskChatAction,
  type ProjectsScheduleMessageAction,
  type ProjectsSendMessageAction,
  type ProjectsSteerQueuedMessageAction,
} from '@canopy/agent-actions/families/projects/messages';
// The receipts moved to the shared projects family, for the web host too.
export type {
  AcceptedInputReceipt,
  CreatedTaskChatReceipt,
  SteeredInputReceipt,
  WatcherReceipt,
} from '@canopy/agent-actions/families/projects/receipts';
import type { WatcherReceipt } from '@canopy/agent-actions/families/projects/receipts';
import type {
  CanonicalChatAddress,
  TrustedChatWatcherRecipient,
} from './chat-watcher-contracts';
import type { ProjectChatAddress } from './project-discovery';

export const CHAT_SEND_ACTION_TYPES = [
  'projects.send_message',
  'bots.send_message',
] as const;
export type ChatSendActionType = (typeof CHAT_SEND_ACTION_TYPES)[number];

export function isChatSendActionType(
  value: unknown,
): value is ChatSendActionType {
  return value === 'projects.send_message' || value === 'bots.send_message';
}

export const chatSendActionSchema = z.discriminatedUnion('type', [
  projectsSendMessageActionSchema,
  botsSendMessageActionSchema,
]);
export type ChatSendAction = z.output<typeof chatSendActionSchema>;

export function parseChatSendAction(
  value: unknown,
): { ok: true; action: ChatSendAction } | { ok: false; message: string } {
  const parsed = chatSendActionSchema.safeParse(value);
  return parsed.success
    ? { ok: true, action: parsed.data }
    : {
        ok: false,
        message: issuesMessage(parsed.error.issues),
      };
}

function issuesMessage(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) =>
      issue.path.length
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message,
    )
    .join('; ');
}

const { $schema: _projectSchema, ...projectsSendMessageJsonSchema } =
  z.toJSONSchema(projectsSendMessageActionSchema, { target: 'draft-7' });
const { $schema: _botSchema, ...botsSendMessageJsonSchema } = z.toJSONSchema(
  botsSendMessageActionSchema,
  { target: 'draft-7' },
);
void _projectSchema;
void _botSchema;
export { botsSendMessageJsonSchema, projectsSendMessageJsonSchema };

export const PROJECT_MESSAGE_CONTROL_ACTION_TYPES = [
  'projects.steer_queued_message',
  'projects.schedule_message',
] as const;
export type ProjectMessageControlActionType =
  (typeof PROJECT_MESSAGE_CONTROL_ACTION_TYPES)[number];

export function isProjectMessageControlActionType(
  value: unknown,
): value is ProjectMessageControlActionType {
  return (
    value === 'projects.steer_queued_message' ||
    value === 'projects.schedule_message'
  );
}

export const projectMessageControlActionSchema = z.discriminatedUnion('type', [
  projectsSteerQueuedMessageActionSchema,
  projectsScheduleMessageActionSchema,
]);
export type ProjectMessageControlAction = z.output<
  typeof projectMessageControlActionSchema
>;

export function parseProjectMessageControlAction(
  value: unknown,
):
  | { ok: true; action: ProjectMessageControlAction }
  | { ok: false; message: string } {
  const parsed = projectMessageControlActionSchema.safeParse(value);
  return parsed.success
    ? { ok: true, action: parsed.data }
    : { ok: false, message: issuesMessage(parsed.error.issues) };
}

const { $schema: _steerSchema, ...projectsSteerQueuedMessageJsonSchema } =
  z.toJSONSchema(projectsSteerQueuedMessageActionSchema, { target: 'draft-7' });
const { $schema: _scheduleSchema, ...projectsScheduleMessageJsonSchema } =
  z.toJSONSchema(projectsScheduleMessageActionSchema, { target: 'draft-7' });
void _steerSchema;
void _scheduleSchema;
export {
  projectsScheduleMessageJsonSchema,
  projectsSteerQueuedMessageJsonSchema,
};

/** A saved one-time schedule; `runAt` is the resolved instant. */
export type ScheduledMessageReceipt = {
  address: ProjectChatAddress;
  automationId: string;
  name: string;
  runAt: string;
  timezone: 'local';
  createdAt: string;
};

export const CHAT_CREATION_ACTION_TYPES = [
  'projects.create_task',
  'projects.create_task_chat',
  'bots.create_task',
  'bots.create_task_chat',
] as const;
export type ChatCreationActionType =
  (typeof CHAT_CREATION_ACTION_TYPES)[number];

export function isChatCreationActionType(
  value: unknown,
): value is ChatCreationActionType {
  return CHAT_CREATION_ACTION_TYPES.some((type) => type === value);
}

export const chatCreationActionSchema = z.discriminatedUnion('type', [
  projectsCreateTaskActionSchema,
  projectsCreateTaskChatActionSchema,
  botsCreateTaskActionSchema,
  botsCreateTaskChatActionSchema,
]);
export type ChatCreationAction = z.output<typeof chatCreationActionSchema>;

export function parseChatCreationAction(
  value: unknown,
): { ok: true; action: ChatCreationAction } | { ok: false; message: string } {
  const parsed = chatCreationActionSchema.safeParse(value);
  return parsed.success
    ? { ok: true, action: parsed.data }
    : { ok: false, message: issuesMessage(parsed.error.issues) };
}

const { $schema: _createTaskSchema, ...projectsCreateTaskJsonSchema } =
  z.toJSONSchema(projectsCreateTaskActionSchema, { target: 'draft-7' });
const { $schema: _createTaskChatSchema, ...projectsCreateTaskChatJsonSchema } =
  z.toJSONSchema(projectsCreateTaskChatActionSchema, { target: 'draft-7' });
const { $schema: _botTaskSchema, ...botsCreateTaskJsonSchema } = z.toJSONSchema(
  botsCreateTaskActionSchema,
  { target: 'draft-7' },
);
const { $schema: _botTaskChatSchema, ...botsCreateTaskChatJsonSchema } =
  z.toJSONSchema(botsCreateTaskChatActionSchema, { target: 'draft-7' });
void _createTaskSchema;
void _createTaskChatSchema;
void _botTaskSchema;
void _botTaskChatSchema;
export {
  botsCreateTaskChatJsonSchema,
  botsCreateTaskJsonSchema,
  projectsCreateTaskChatJsonSchema,
  projectsCreateTaskJsonSchema,
};

// Receipt IDs share the actions' opaque public ID validation.
const idSchema = z.string().min(1).max(512).regex(/\S/);

const projectAddressSchema = z.strictObject({
  projectId: idSchema,
  taskId: idSchema,
  chatId: idSchema,
});
const botAddressSchema = z.strictObject({
  botId: idSchema,
  taskId: idSchema,
  chatId: idSchema,
});
const receiptBase = {
  address: z.union([projectAddressSchema, botAddressSchema]),
  acceptedAt: z.iso.datetime(),
  turnId: idSchema.optional(),
  watcherReceipts: z
    .array(
      z.strictObject({
        watcherId: idSchema,
        disposition: z.enum(['created', 'deduplicated']),
      }),
    )
    .max(10),
};
export const acceptedInputReceiptSchema = z.union([
  z.strictObject({
    ...receiptBase,
    disposition: z.literal('started'),
    messageId: idSchema,
    queuedMessageId: idSchema.optional(),
  }),
  z.strictObject({
    ...receiptBase,
    disposition: z.literal('queued'),
    queuedMessageId: idSchema,
    messageId: idSchema.optional(),
  }),
]);

/** Typed refusals for agent sends at acceptance or delayed delivery. */
export type AgentSendRefusalCode =
  | 'not_found'
  | 'unknown_bot'
  | 'owner_boundary'
  | 'advisor_access_disabled'
  | 'owner_context_unavailable'
  | 'validation_failed'
  | 'cowork_folder_missing'
  | 'target_not_ready'
  | 'unsupported_action'
  /** The queued input cannot be steered now; it stays queued. */
  | 'missing_capability'
  /** A root agent's message to a chat with broader tool approvals. */
  | 'authorization_conflict'
  /** The approvals changed while the send was checked; retry it. */
  | 'stale_ui_state'
  /** An inline watcher's background authorization refused it; nothing was sent. */
  | 'policy_blocked';

/**
 * Main-only: inline completion watchers reserved before a send dispatches,
 * pre-bound to the input ID the send will use. Never a public schema.
 */
export type InlineChatWatcherReservationInput = TrustedChatWatcherRecipient & {
  createdByToolUseId?: string;
  /** The resolved send target; entries become completion watches on it. */
  target: CanonicalChatAddress;
  entries: NewInlineWatcher[];
  /** The send's pre-minted input ID; the reservation binds to it. */
  acceptedInputId: string;
  commandId: string;
};

export type InlineChatWatcherReservation = {
  reservationId: string;
  receipts: WatcherReceipt[];
};

/** The host queue's acceptance decision for one agent send. */
export type AgentSendAcceptanceFacts = {
  acceptedInputId: string;
  disposition: 'started' | 'queued';
  queuedMessageId?: string;
  acceptedAt: string;
};

/** Main-only watcher service port used by the send orchestration. */
export interface InlineChatWatcherReservationPort {
  reserveInlineChatWatchers(
    input: InlineChatWatcherReservationInput,
  ): Promise<
    | { ok: true; reservation: InlineChatWatcherReservation }
    | { ok: false; code: AgentSendRefusalCode; error: string }
  >;
  /** Binds to the accepted input and releases any deferred matching terminal once. */
  confirmInlineChatWatchers(
    reservationId: string,
    acceptance: AgentSendAcceptanceFacts,
  ): Promise<WatcherReceipt[]>;
  /** Cancels only rows this reservation created; inert if already confirmed. */
  cancelInlineChatWatchers(reservationId: string): Promise<void>;
}
