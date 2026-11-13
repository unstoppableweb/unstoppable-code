import { THINKING_LEVELS } from '@canopy/protocol/thinking';
import { z } from 'zod';

export const ENVIRONMENT_ACTION_TYPES = [
  'workspace.get',
  'worktree.list',
  'chat.list',
  'chat.get',
  'chat.create',
  'chat.send_message',
  'models.list',
] as const;

export type EnvironmentActionType = (typeof ENVIRONMENT_ACTION_TYPES)[number];

export const ENVIRONMENT_CHAT_CREATE_PLACEMENTS = [
  'current',
  'new_worktree',
] as const;

export const ENVIRONMENT_MAX_PAGE_SIZE = 100;
export const ENVIRONMENT_MAX_INLINE_WATCHERS = 5;
export const ENVIRONMENT_MAX_ID_LENGTH = 512;
export const ENVIRONMENT_MAX_MESSAGE_LENGTH = 100000;
export const ENVIRONMENT_MAX_CURSOR_LENGTH = 2048;
export const ENVIRONMENT_MAX_LABEL_LENGTH = 200;

const idSchema = z.string().trim().min(1).max(ENVIRONMENT_MAX_ID_LENGTH);
const messageSchema = z
  .string()
  .trim()
  .min(1)
  .max(ENVIRONMENT_MAX_MESSAGE_LENGTH);
const labelSchema = z.string().trim().min(1).max(ENVIRONMENT_MAX_LABEL_LENGTH);
const limitSchema = z.number().int().min(1).max(ENVIRONMENT_MAX_PAGE_SIZE);
const cursorSchema = z.string().min(1).max(ENVIRONMENT_MAX_CURSOR_LENGTH);

const inlineWatcherSchema = z.strictObject({
  label: labelSchema.optional(),
  followUpInstruction: messageSchema.optional(),
});

const inlineWatchersSchema = z
  .array(inlineWatcherSchema)
  .min(1)
  .max(ENVIRONMENT_MAX_INLINE_WATCHERS);

export type EnvironmentInlineWatcher = z.output<typeof inlineWatcherSchema>;

const workspaceGetActionSchema = z.strictObject({
  type: z.literal('workspace.get'),
});

const worktreeListActionSchema = z.strictObject({
  type: z.literal('worktree.list'),
  limit: limitSchema.optional(),
  cursor: cursorSchema.optional(),
});

/**
 * `inWorktreeId` names the worktree to list: the dispatch envelope strips a
 * caller-supplied `worktreeId` because it is the trusted scope field.
 */
const chatListActionSchema = z.strictObject({
  type: z.literal('chat.list'),
  inWorktreeId: idSchema.optional(),
  includeArchived: z.boolean().optional(),
  limit: limitSchema.optional(),
  cursor: cursorSchema.optional(),
});

const chatGetActionSchema = z.strictObject({
  type: z.literal('chat.get'),
  chatId: idSchema,
});

const chatCreateActionSchema = z.strictObject({
  type: z.literal('chat.create'),
  message: messageSchema,
  placement: z.enum(ENVIRONMENT_CHAT_CREATE_PLACEMENTS).default('current'),
  model: idSchema.optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  title: labelSchema.optional(),
  watchers: inlineWatchersSchema.optional(),
});

const chatSendMessageActionSchema = z.strictObject({
  type: z.literal('chat.send_message'),
  chatId: idSchema,
  message: messageSchema,
  watchers: inlineWatchersSchema.optional(),
});

const modelsListActionSchema = z.strictObject({
  type: z.literal('models.list'),
});

export const environmentActionSchema = z.discriminatedUnion('type', [
  workspaceGetActionSchema,
  worktreeListActionSchema,
  chatListActionSchema,
  chatGetActionSchema,
  chatCreateActionSchema,
  chatSendMessageActionSchema,
  modelsListActionSchema,
]);

export type EnvironmentAction = z.output<typeof environmentActionSchema>;

export type EnvironmentActionOf<T extends EnvironmentActionType> = Extract<
  EnvironmentAction,
  { type: T }
>;
