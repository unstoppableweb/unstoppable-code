import { z } from 'zod';

// Opaque public IDs, validated without normalization.
const idSchema = z.string().min(1).max(512).regex(/\S/);
// Trimmed like chat.create.model.
const modelIdSchema = z.string().trim().min(1).max(512);
// Outgoing text is nonblank, untrimmed and deliberately unbounded.
const textSchema = z.string().min(1).regex(/\S/);

/** The only caller-supplied fields of an inline completion watcher. */
export const newInlineWatcherSchema = z.strictObject({
  label: z.string().max(160).optional(),
  followUpInstruction: z.string().max(8000).optional(),
  allowDuplicate: z.boolean().optional(),
});

export type NewInlineWatcher = z.output<typeof newInlineWatcherSchema>;

export const MAX_SEND_INLINE_WATCHERS = 10;

const watchersSchema = z
  .array(newInlineWatcherSchema)
  .max(MAX_SEND_INLINE_WATCHERS)
  .optional();

export const projectsSendMessageActionSchema = z.strictObject({
  type: z.literal('projects.send_message'),
  projectId: idSchema,
  taskId: idSchema,
  chatId: idSchema,
  text: textSchema,
  /** Code targets only: hold the input until the task finishes setup. */
  queueForSetup: z.boolean().optional(),
  watchers: watchersSchema,
});
export const botsSendMessageActionSchema = z.strictObject({
  type: z.literal('bots.send_message'),
  botId: idSchema,
  taskId: idSchema,
  chatId: idSchema,
  text: textSchema,
  watchers: watchersSchema,
});

export const projectsSteerQueuedMessageActionSchema = z.strictObject({
  type: z.literal('projects.steer_queued_message'),
  projectId: idSchema,
  taskId: idSchema,
  chatId: idSchema,
  /** The host queue row ID, as returned in a queued send receipt. */
  queuedMessageId: idSchema,
});

/**
 * Attachment prompt kinds a scheduled message may carry. Hosts keep their
 * own list identical; desktop asserts it.
 */
export const SCHEDULED_ATTACHMENT_PROMPT_KINDS = [
  'in-app-browser-resource',
  'linear-ticket',
] as const;

/** Typed attachment references for a scheduled message; no untyped arrays. */
export const scheduledMessageAttachmentsSchema = z.strictObject({
  fileReferences: z
    .array(
      z.strictObject({
        displayPath: z.string().min(1),
        absolutePath: z.string().min(1),
        repoName: z.string().min(1).optional(),
      }),
    )
    .max(50)
    .optional(),
  /** Paths inside the target chat's attachment folder; checked at delivery. */
  attachmentPaths: z.array(z.string().min(1)).max(20).optional(),
  attachmentPromptContexts: z
    .array(
      z.strictObject({
        attachmentPath: z.string().min(1),
        promptKind: z.enum(SCHEDULED_ATTACHMENT_PROMPT_KINDS),
      }),
    )
    .max(20)
    .optional(),
});

export const projectsScheduleMessageActionSchema = z.strictObject({
  type: z.literal('projects.schedule_message'),
  projectId: idSchema,
  taskId: idSchema,
  chatId: idSchema,
  text: textSchema,
  /** An ISO instant with an explicit offset; no new local-time convention. */
  runAt: z.iso.datetime({ offset: true }),
  timezone: z.literal('local').optional(),
  name: z.string().regex(/\S/).max(200).optional(),
  attachments: scheduledMessageAttachmentsSchema.optional(),
  inputMode: z.enum(['typed', 'voice']).optional(),
});

const titleSchema = z.string().max(200);

export const projectsCreateTaskActionSchema = z.strictObject({
  type: z.literal('projects.create_task'),
  /** Cowork projects only; code projects use the worktree-creation workflow. */
  projectId: idSchema,
  title: titleSchema.optional(),
  initialMessage: textSchema.optional(),
  /** Model id from models.list, including an installed custom Agent. */
  model: modelIdSchema.optional(),
});
export const projectsCreateTaskChatActionSchema = z.strictObject({
  type: z.literal('projects.create_task_chat'),
  projectId: idSchema,
  taskId: idSchema,
  initialMessage: textSchema.optional(),
  /** Model id from models.list, including an installed custom Agent. */
  model: modelIdSchema.optional(),
});
export const botsCreateTaskActionSchema = z.strictObject({
  type: z.literal('bots.create_task'),
  botId: idSchema,
  title: titleSchema.optional(),
  /** Optional (D6): without it the task and its founding chat are created empty. */
  initialMessage: textSchema.optional(),
});
export const botsCreateTaskChatActionSchema = z.strictObject({
  type: z.literal('bots.create_task_chat'),
  botId: idSchema,
  taskId: idSchema,
  initialMessage: textSchema,
});

export type ProjectsSendMessageAction = z.output<
  typeof projectsSendMessageActionSchema
>;
export type BotsSendMessageAction = z.output<
  typeof botsSendMessageActionSchema
>;
export type ProjectsSteerQueuedMessageAction = z.output<
  typeof projectsSteerQueuedMessageActionSchema
>;
export type ProjectsScheduleMessageAction = z.output<
  typeof projectsScheduleMessageActionSchema
>;
export type ProjectsCreateTaskAction = z.output<
  typeof projectsCreateTaskActionSchema
>;
export type ProjectsCreateTaskChatAction = z.output<
  typeof projectsCreateTaskChatActionSchema
>;
export type BotsCreateTaskAction = z.output<typeof botsCreateTaskActionSchema>;
export type BotsCreateTaskChatAction = z.output<
  typeof botsCreateTaskChatActionSchema
>;
