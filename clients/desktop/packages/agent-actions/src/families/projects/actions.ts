import type {
  AgentExecutionHarness,
  ModelCatalogProvider,
} from '@canopy/protocol/models';
import { z } from 'zod';
import {
  projectsCreateTaskActionSchema,
  projectsCreateTaskChatActionSchema,
  projectsScheduleMessageActionSchema,
  projectsSendMessageActionSchema,
  projectsSteerQueuedMessageActionSchema,
} from './messages';

/** The discovery subset of {@link PROJECT_ACTION_TYPES}. */
export const PROJECT_DISCOVERY_TYPES = [
  'projects.list',
  'projects.list_tasks',
  'projects.list_task_chats',
] as const;
/** The read subset of {@link PROJECT_ACTION_TYPES}. */
export const PROJECT_READ_TYPES = [
  'projects.get_last_user_message',
  'projects.get_last_agent_response',
  'projects.read_history',
] as const;
/** The write subset of {@link PROJECT_ACTION_TYPES}. */
export const PROJECT_WRITE_TYPES = [
  'projects.send_message',
  'projects.steer_queued_message',
  'projects.schedule_message',
  'projects.create_task',
  'projects.create_task_chat',
] as const;
export const PROJECT_ACTION_TYPES = [
  'projects.list',
  'projects.list_tasks',
  'projects.list_task_chats',
  'projects.get_last_user_message',
  'projects.get_last_agent_response',
  'projects.read_history',
  'projects.send_message',
  'projects.steer_queued_message',
  'projects.schedule_message',
  'projects.create_task',
  'projects.create_task_chat',
] as const;

export type ProjectActionType = (typeof PROJECT_ACTION_TYPES)[number];

export const PROJECT_DISCOVERY_PAGE_SIZE_DEFAULT = 50;
export const PROJECT_DISCOVERY_PAGE_SIZE_MAX = 200;
export const PROJECT_DISCOVERY_TEXT_MAX = 500;
export const PROJECT_DISCOVERY_PREVIEW_MAX_CHARS = 1000;
export const PROJECT_DISCOVERY_ID_MAX = 512;
export const PROJECT_DISCOVERY_CURSOR_MAX = 2048;
export const PROJECT_READ_PAGE_SIZE_DEFAULT = 20;
export const PROJECT_READ_PAGE_SIZE_MAX = 100;
export const PROJECT_READ_MESSAGE_MAX_CHARS = 8000;

/** A chat's provider; the host's own provider union must equal it. */
export type ProjectChatProviderType = Exclude<ModelCatalogProvider, 'unknown'>;

// Compiler-enforced exhaustive projections of the protocol unions. Providers
// and execution harnesses are independent registries.
const PROJECT_CHAT_PROVIDER_TYPES: Record<ProjectChatProviderType, true> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  opencode: true,
  copilot: true,
  antigravity: true,
};
const PROJECT_CHAT_EXECUTION_HARNESSES: Record<AgentExecutionHarness, true> = {
  claude: true,
  codex: true,
  cursor: true,
  copilot: true,
  antigravity: true,
  opencode: true,
};

function isProjectChatProviderType(
  value: unknown,
): value is ProjectChatProviderType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROJECT_CHAT_PROVIDER_TYPES, value)
  );
}

function isProjectChatExecutionHarness(
  value: unknown,
): value is AgentExecutionHarness {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(
      PROJECT_CHAT_EXECUTION_HARNESSES,
      value,
    )
  );
}

export type ProjectOwnerFilter =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };

const idSchema = z.string().trim().min(1).max(PROJECT_DISCOVERY_ID_MAX);
const textSchema = z.string().trim().min(1).max(PROJECT_DISCOVERY_TEXT_MAX);
const pageAndSearchFields = {
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(PROJECT_DISCOVERY_PAGE_SIZE_MAX)
    .default(PROJECT_DISCOVERY_PAGE_SIZE_DEFAULT),
  // Cursors are opaque: reject blank strings without rewriting their bytes.
  cursor: z
    .string()
    .min(1)
    .max(PROJECT_DISCOVERY_CURSOR_MAX)
    .refine((value) => value.trim().length > 0, 'Cursor must not be blank')
    .optional(),
  query: textSchema.optional(),
  name: textSchema.optional(),
};

function uniqueFilter<T extends z.ZodType>(schema: T): z.ZodArray<T> {
  return z
    .array(schema)
    .min(1)
    .refine(
      (values) => new Set(values).size === values.length,
      'Filter values must be unique',
    );
}

const ownerSchema: z.ZodType<ProjectOwnerFilter> = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('personal') }),
    z.strictObject({
      kind: z.literal('organization'),
      organizationId: idSchema,
    }),
  ],
);
const retentionStatesSchema = uniqueFilter(
  z.enum(['retained', 'archived']),
).default(['retained']);
const taskSortSchema = z
  .enum(['title', 'created_at', 'last_activity'])
  .default('last_activity');
const orderSchema = z.enum(['asc', 'desc']);

export const projectsListActionSchema = z.strictObject({
  type: z.literal('projects.list'),
  ...pageAndSearchFields,
  types: uniqueFilter(z.enum(['code', 'cowork'])).optional(),
  purposes: uniqueFilter(z.enum(['project', 'chats'])).optional(),
  readiness: uniqueFilter(
    z.enum(['ready', 'pending', 'unavailable']),
  ).optional(),
  owner: ownerSchema.optional(),
  includeDefault: z.boolean().default(true),
  sort: z.enum(['name', 'created_at', 'last_activity']).default('name'),
  order: orderSchema.default('asc'),
});

export const projectsListTasksActionSchema = z.strictObject({
  type: z.literal('projects.list_tasks'),
  ...pageAndSearchFields,
  projectId: idSchema,
  statuses: uniqueFilter(z.enum(['active', 'done'])).optional(),
  retentionStates: retentionStatesSchema,
  hasRunningChats: z.boolean().optional(),
  pinned: z.boolean().optional(),
  branchName: textSchema.optional(),
  sort: taskSortSchema,
  order: orderSchema.default('desc'),
});

export const projectsListTaskChatsActionSchema = z.strictObject({
  type: z.literal('projects.list_task_chats'),
  ...pageAndSearchFields,
  projectId: idSchema,
  taskId: idSchema.optional(),
  runtimeStates: uniqueFilter(
    z.enum(['idle', 'running', 'queued', 'interrupted', 'error', 'unknown']),
  ).optional(),
  retentionStates: retentionStatesSchema,
  providerTypes: uniqueFilter(
    z.custom<ProjectChatProviderType>(
      isProjectChatProviderType,
      'Unsupported provider type',
    ),
  ).optional(),
  executionHarnesses: uniqueFilter(
    z.custom<AgentExecutionHarness>(
      isProjectChatExecutionHarness,
      'Unsupported execution harness',
    ),
  ).optional(),
  hasQueuedMessages: z.boolean().optional(),
  includeLastUserMessage: z.boolean().default(false),
  sort: taskSortSchema,
  order: orderSchema.default('desc'),
});

// Public opaque IDs share discovery validation, not the narrower core scope
// domain. Canonical resource resolution decides scope validity without aliases.
const addressFields = {
  projectId: idSchema,
  taskId: idSchema,
  chatId: idSchema,
};

export const projectsGetLastUserMessageActionSchema = z.strictObject({
  type: z.literal('projects.get_last_user_message'),
  ...addressFields,
});
export const projectsGetLastAgentResponseActionSchema = z.strictObject({
  type: z.literal('projects.get_last_agent_response'),
  ...addressFields,
});
export const projectsReadHistoryActionSchema = z.strictObject({
  type: z.literal('projects.read_history'),
  ...addressFields,
  query: textSchema.optional(),
  roles: uniqueFilter(z.enum(['user', 'assistant'])).optional(),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(PROJECT_READ_PAGE_SIZE_MAX)
    .default(PROJECT_READ_PAGE_SIZE_DEFAULT),
  cursor: pageAndSearchFields.cursor,
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const projectDiscoveryActionSchema = z.discriminatedUnion('type', [
  projectsListActionSchema,
  projectsListTasksActionSchema,
  projectsListTaskChatsActionSchema,
]);
export const projectReadActionSchema = z.discriminatedUnion('type', [
  projectsGetLastUserMessageActionSchema,
  projectsGetLastAgentResponseActionSchema,
  projectsReadHistoryActionSchema,
]);
export const projectWriteActionSchema = z.discriminatedUnion('type', [
  projectsSendMessageActionSchema,
  projectsSteerQueuedMessageActionSchema,
  projectsScheduleMessageActionSchema,
  projectsCreateTaskActionSchema,
  projectsCreateTaskChatActionSchema,
]);
export const projectActionSchema = z.discriminatedUnion('type', [
  ...projectDiscoveryActionSchema.options,
  ...projectReadActionSchema.options,
  ...projectWriteActionSchema.options,
]);

export type ProjectsListAction = z.output<typeof projectsListActionSchema>;
export type ProjectsListTasksAction = z.output<
  typeof projectsListTasksActionSchema
>;
export type ProjectsListTaskChatsAction = z.output<
  typeof projectsListTaskChatsActionSchema
>;
export type ProjectDiscoveryAction = z.output<
  typeof projectDiscoveryActionSchema
>;
export type ProjectsGetLastUserMessageAction = z.output<
  typeof projectsGetLastUserMessageActionSchema
>;
export type ProjectsGetLastAgentResponseAction = z.output<
  typeof projectsGetLastAgentResponseActionSchema
>;
export type ProjectsReadHistoryAction = z.output<
  typeof projectsReadHistoryActionSchema
>;
export type ProjectReadAction = z.output<typeof projectReadActionSchema>;
export type ProjectWriteAction = z.output<typeof projectWriteActionSchema>;
export type ProjectAction = z.output<typeof projectActionSchema>;

/** The first issue of a failed parse, as `path: message`. */
export function firstIssueMessage(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  const path = issue?.path.map(String).join('.') || 'action';
  return `${path}: ${issue?.message ?? fallback}`;
}
