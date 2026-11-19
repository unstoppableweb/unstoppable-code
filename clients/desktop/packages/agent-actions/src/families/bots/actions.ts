import { z } from 'zod';
import {
  projectsGetLastAgentResponseActionSchema,
  projectsGetLastUserMessageActionSchema,
  projectsListActionSchema,
  projectsListTaskChatsActionSchema,
  projectsListTasksActionSchema,
  projectsReadHistoryActionSchema,
} from '../projects/actions';
import {
  botsCreateTaskActionSchema,
  botsCreateTaskChatActionSchema,
  botsSendMessageActionSchema,
} from '../projects/messages';

/** The discovery and read subset of {@link BOT_ACTION_TYPES}. */
export const BOT_READ_TYPES = [
  'bots.list',
  'bots.list_tasks',
  'bots.list_task_chats',
  'bots.get_last_user_message',
  'bots.get_last_agent_response',
  'bots.read_history',
] as const;
/** The write subset of {@link BOT_ACTION_TYPES}. */
export const BOT_WRITE_TYPES = [
  'bots.send_message',
  'bots.create_task',
  'bots.create_task_chat',
] as const;
export const BOT_ACTION_TYPES = [
  'bots.list',
  'bots.list_tasks',
  'bots.list_task_chats',
  'bots.get_last_user_message',
  'bots.get_last_agent_response',
  'bots.read_history',
  'bots.send_message',
  'bots.create_task',
  'bots.create_task_chat',
] as const;

export type BotActionType = (typeof BOT_ACTION_TYPES)[number];

/** Public bot ID. The internal `app-advisor` workspace ID is not a bot ID. */
export { APP_ADVISOR_BOT_ID } from '@canopy/protocol/chat-targets';

// Bot IDs share the public opaque-ID validation of project discovery.
const botIdSchema = projectsListTaskChatsActionSchema.shape.projectId;
const uniqueValues = <T>(values: T[]): boolean =>
  new Set(values).size === values.length;

export const botsListActionSchema = z.strictObject({
  type: z.literal('bots.list'),
  pageSize: projectsListActionSchema.shape.pageSize,
  cursor: projectsListActionSchema.shape.cursor,
  query: projectsListActionSchema.shape.query,
  name: projectsListActionSchema.shape.name,
  botIds: z
    .array(botIdSchema)
    .min(1)
    .refine(uniqueValues, 'Filter values must be unique')
    .optional(),
  availability: z
    .array(z.enum(['available', 'unavailable']))
    .min(1)
    .refine(uniqueValues, 'Filter values must be unique')
    .optional(),
  pinnedToProjectId:
    projectsListTaskChatsActionSchema.shape.projectId.optional(),
  sort: z.enum(['name']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

// Bot tasks are App Advisor Work Entries: no code branch filter.
export const botsListTasksActionSchema = projectsListTasksActionSchema
  .omit({ type: true, projectId: true, branchName: true })
  .extend({ type: z.literal('bots.list_tasks'), botId: botIdSchema });

export const botsListTaskChatsActionSchema = projectsListTaskChatsActionSchema
  .omit({ type: true, projectId: true })
  .extend({ type: z.literal('bots.list_task_chats'), botId: botIdSchema });

export const botsGetLastUserMessageActionSchema =
  projectsGetLastUserMessageActionSchema
    .omit({ type: true, projectId: true })
    .extend({
      type: z.literal('bots.get_last_user_message'),
      botId: botIdSchema,
    });

export const botsGetLastAgentResponseActionSchema =
  projectsGetLastAgentResponseActionSchema
    .omit({ type: true, projectId: true })
    .extend({
      type: z.literal('bots.get_last_agent_response'),
      botId: botIdSchema,
    });

export const botsReadHistoryActionSchema = projectsReadHistoryActionSchema
  .omit({ type: true, projectId: true })
  .extend({ type: z.literal('bots.read_history'), botId: botIdSchema });

/** The discovery and read actions: the bot service's own vocabulary. */
export const botReadActionSchema = z.discriminatedUnion('type', [
  botsListActionSchema,
  botsListTasksActionSchema,
  botsListTaskChatsActionSchema,
  botsGetLastUserMessageActionSchema,
  botsGetLastAgentResponseActionSchema,
  botsReadHistoryActionSchema,
]);
export const botWriteActionSchema = z.discriminatedUnion('type', [
  botsSendMessageActionSchema,
  botsCreateTaskActionSchema,
  botsCreateTaskChatActionSchema,
]);
export const botActionSchema = z.discriminatedUnion('type', [
  ...botReadActionSchema.options,
  ...botWriteActionSchema.options,
]);

export type BotsListAction = z.output<typeof botsListActionSchema>;
export type BotsListTasksAction = z.output<typeof botsListTasksActionSchema>;
export type BotsListTaskChatsAction = z.output<
  typeof botsListTaskChatsActionSchema
>;
export type BotsGetLastUserMessageAction = z.output<
  typeof botsGetLastUserMessageActionSchema
>;
export type BotsGetLastAgentResponseAction = z.output<
  typeof botsGetLastAgentResponseActionSchema
>;
export type BotsReadHistoryAction = z.output<
  typeof botsReadHistoryActionSchema
>;
export type BotReadAction = z.output<typeof botReadActionSchema>;
export type BotWriteAction = z.output<typeof botWriteActionSchema>;
export type BotAction = z.output<typeof botActionSchema>;
