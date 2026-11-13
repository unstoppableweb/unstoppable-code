import { z } from 'zod';
import type { AgentActionBrand } from '../brand';
import type { AgentWatcherTriggerType } from '../watchers/catalog';
import {
  chatWatcherSetupSchema,
  containsCanonicalChatWatcher,
  extendChatWatcherSetupJsonSchema,
  isCanonicalChatWatcherTrigger,
  isLegacyChatWatcherTrigger,
  offersCanonicalChatWatchers,
  type CanonicalChatWatcherEntry,
  type CanonicalChatWatcherTrigger,
} from '../watchers/chat-watchers';
import type { AgentJsonSchema } from './definition';
import {
  listInProse,
  workspaceChatWatchersOnly,
  workspacePipelineWatchers,
  type AgentActionDescriptionCapabilities,
} from './descriptions';

/** Triggers SearchWatchers can filter on, in advertised order. */
export const SEARCHABLE_WATCHER_TRIGGERS = [
  'worktree_pipeline_completion',
  'worktree_hook_triggered',
  'project_task_chat_completion',
  'project_new_chat_started',
  'bot_task_chat_completion',
  'bot_new_chat_started',
  'worktree_chat_completion',
  'standalone_chat_completion',
  'worktree_new_chat_started',
  'standalone_new_chat_started',
  'automation_run',
  'github_workflow_runs_changed',
  'github_pull_requests_changed',
  'scheduled_wakeup',
  'command_watch_resolved',
] as const satisfies readonly AgentWatcherTriggerType[];

/** Triggers SetupWatchers creates, in advertised order. */
export const SETUP_WATCHER_TRIGGERS = [
  'worktree_pipeline_completion',
  'worktree_hook_triggered',
  'project_task_chat_completion',
  'project_new_chat_started',
  'bot_task_chat_completion',
  'bot_new_chat_started',
  'worktree_chat_completion',
  'standalone_chat_completion',
  'worktree_new_chat_started',
  'standalone_new_chat_started',
  'automation_run',
] as const satisfies readonly AgentWatcherTriggerType[];

export type SetupWatcherTrigger = (typeof SETUP_WATCHER_TRIGGERS)[number];

/** Setup triggers whose entries carry a target filter, not a canonical address. */
export type TargetSetupWatcherTrigger = Exclude<
  SetupWatcherTrigger,
  CanonicalChatWatcherTrigger
>;

export const MAX_ACTIVE_WATCHER_PAGE_SIZE = 200;
export const MAX_ACTIVE_WATCHER_QUERY_LENGTH = 500;

const watcherPipelineTerminalStatusSchema = z.enum([
  'success',
  'failure',
  'cancelled',
]);

export interface SearchWatchersInput {
  query?: string;
  trigger?: AgentWatcherTriggerType;
  includeActive?: boolean;
  limit?: number;
  detailLevel?: 'minimal' | 'standard';
  /** Active watcher paging, separate from the catalog query and limit. */
  activePageSize?: number;
  activeCursor?: string;
  activeQuery?: string;
  targetProjectId?: string;
  targetBotId?: string;
  targetTaskId?: string;
  targetChatId?: string;
}

export function createSearchWatchersInputSchema(
  triggers: readonly AgentWatcherTriggerType[],
): z.ZodType<SearchWatchersInput> {
  return z
    .object({
      query: z.string().optional(),
      trigger: z.enum(triggers).optional(),
      includeActive: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      detailLevel: z.enum(['minimal', 'standard']).optional(),
      activePageSize: z
        .number()
        .int()
        .min(1)
        .max(MAX_ACTIVE_WATCHER_PAGE_SIZE)
        .optional(),
      activeCursor: z.string().min(1).max(200).optional(),
      activeQuery: z.string().max(MAX_ACTIVE_WATCHER_QUERY_LENGTH).optional(),
      targetProjectId: z.string().min(1).optional(),
      targetBotId: z.string().min(1).optional(),
      targetTaskId: z.string().min(1).optional(),
      targetChatId: z.string().min(1).optional(),
    })
    .refine(
      (input) =>
        input.targetProjectId === undefined || input.targetBotId === undefined,
      { message: 'targetProjectId and targetBotId cannot be combined.' },
    );
}

export type SetupWatcherTargetInput<THook extends string = string> =
  | {
      triggerName: THook;
      hookKey?: string;
      scope?: 'project' | 'workspace-root' | 'workspace-repo';
      repoId?: string;
    }
  | {
      executionId?: string;
      pipelineId?: string;
      terminalStatuses?: ('success' | 'failure' | 'cancelled')[];
    }
  | { automationId: string }
  | { projectId: string; worktreeId?: string; chatId?: string };

/** A SetupWatchers entry with a target filter. */
export interface TargetSetupWatcherEntry<THook extends string = string> {
  trigger?: TargetSetupWatcherTrigger;
  label?: string;
  target: SetupWatcherTargetInput<THook>;
  followUpInstruction?: string;
  allowDuplicate?: boolean;
  armForNextCompletion?: boolean;
}

export interface SetupWatchersInput<THook extends string = string> {
  watchers: (TargetSetupWatcherEntry<THook> | CanonicalChatWatcherEntry)[];
}

/** Whether a SetupWatchers entry watches a canonical project or bot chat. */
export function isCanonicalSetupWatcherEntry<THook extends string>(
  entry: SetupWatchersInput<THook>['watchers'][number],
): entry is CanonicalChatWatcherEntry {
  return isCanonicalChatWatcherTrigger(entry.trigger);
}

/**
 * The trigger a SetupWatchers entry arms: its explicit trigger, or the one
 * its target implies (a hook trigger name, an automation id, otherwise a
 * pipeline watcher).
 */
export function resolveSetupWatcherTrigger<THook extends string>(entry: {
  trigger?: TargetSetupWatcherTrigger;
  target: SetupWatcherTargetInput<THook>;
}): TargetSetupWatcherTrigger {
  if (entry.trigger) return entry.trigger;
  if ('triggerName' in entry.target) return 'worktree_hook_triggered';
  if ('automationId' in entry.target) return 'automation_run';
  return 'worktree_pipeline_completion';
}

export function createSetupWatchersInputSchema<THook extends string>(options: {
  triggers: readonly SetupWatcherTrigger[];
  hookTriggerNames: readonly THook[];
}): z.ZodType<SetupWatchersInput<THook>> {
  const setupPipelineWatcherTargetSchema = z
    .object({
      executionId: z.string().optional(),
      pipelineId: z.string().optional(),
      terminalStatuses: z.array(watcherPipelineTerminalStatusSchema).optional(),
    })
    .strict()
    .refine(
      (target) =>
        Boolean(target.executionId) ||
        Boolean(target.pipelineId) ||
        Boolean(target.terminalStatuses?.length),
      {
        message:
          'SetupWatchers requires target.executionId, target.pipelineId, or target.terminalStatuses.',
      },
    );
  const setupHookWatcherTargetSchema = z
    .object({
      triggerName: z.enum(options.hookTriggerNames),
      hookKey: z.string().optional(),
      scope: z.enum(['project', 'workspace-root', 'workspace-repo']).optional(),
      repoId: z.string().optional(),
    })
    .strict();
  // Chat targets carry the full caller-supplied ids: any chat may watch any
  // other chat, in any workspace. Which ids are required depends on the
  // trigger and is enforced by the watcher port.
  const setupChatWatcherTargetSchema = z
    .object({
      projectId: z.string().min(1),
      worktreeId: z.string().min(1).optional(),
      chatId: z.string().min(1).optional(),
    })
    .strict();
  const setupAutomationWatcherTargetSchema = z
    .object({
      automationId: z.string().min(1),
    })
    .strict();
  const targetTriggers = options.triggers.filter(
    (trigger): trigger is TargetSetupWatcherTrigger =>
      !isCanonicalChatWatcherTrigger(trigger),
  );
  const unavailable = (trigger: SetupWatcherTrigger): string =>
    `This target implies the ${trigger} trigger, which is not available here. Set trigger to one of: ${options.triggers.join(', ')}.`;
  const entry = z.object({
    trigger: z.enum(targetTriggers).optional(),
    label: z.string().max(200).optional(),
    target: z.union([
      setupHookWatcherTargetSchema,
      setupPipelineWatcherTargetSchema,
      setupAutomationWatcherTargetSchema,
      setupChatWatcherTargetSchema,
    ]),
    followUpInstruction: z.string().optional(),
    allowDuplicate: z.boolean().optional(),
    armForNextCompletion: z.boolean().optional(),
  });
  const targetOnly = z.object({
    watchers: z
      .array(entry)
      .min(1)
      .superRefine((entries, context) => {
        entries.forEach((entry, index) => {
          const trigger = resolveSetupWatcherTrigger(entry);
          if (options.triggers.includes(trigger)) return;
          context.addIssue({
            code: 'custom',
            path: [index, 'trigger'],
            message: unavailable(trigger),
          });
        });
      }),
  });
  if (!options.triggers.some(isCanonicalChatWatcherTrigger)) return targetOnly;
  // A batch with a canonical entry parses strictly as a mixed batch; any
  // other batch keeps the target-filter schema and its errors.
  const mixed = chatWatcherSetupSchema(entry).superRefine((input, context) => {
    input.watchers.forEach((watcher, index) => {
      const trigger = isCanonicalSetupWatcherEntry(watcher)
        ? watcher.trigger
        : resolveSetupWatcherTrigger(watcher);
      if (options.triggers.includes(trigger)) return;
      context.addIssue({
        code: 'custom',
        path: ['watchers', index, 'trigger'],
        message: unavailable(trigger),
      });
    });
  });
  return z.unknown().transform((value, context) => {
    const parsed = (
      containsCanonicalChatWatcher(value) ? mixed : targetOnly
    ).safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) context.addIssue({ ...issue });
    return z.NEVER;
  });
}

export const deleteWatchersInputSchema = z
  .object({
    watcherIds: z.array(z.string().trim().min(1).max(256)).min(1).max(20),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.watcherIds).size !== input.watcherIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['watcherIds'],
        message: 'watcherIds must not contain duplicates.',
      });
    }
  });

export type DeleteWatchersInput = z.infer<typeof deleteWatchersInputSchema>;

/** SearchWatchers' active watcher paging and canonical target filters. */
const ACTIVE_WATCHER_PAGING_JSON_PROPERTIES: AgentJsonSchema = {
  activePageSize: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_ACTIVE_WATCHER_PAGE_SIZE,
    default: 50,
    description:
      'Maximum instance rows per page (default 50), independent of catalog limit.',
  },
  activeCursor: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description:
      'Opaque activeNextCursor from the previous page with the same activeQuery and target filters.',
  },
  activeQuery: {
    type: 'string',
    maxLength: MAX_ACTIVE_WATCHER_QUERY_LENGTH,
    description:
      'Search visible instances by watcher ID, label, and canonical project/bot/task/chat IDs; separate from catalog query.',
  },
  targetProjectId: {
    type: 'string',
    minLength: 1,
    description:
      'Match instance target.projectId exactly. Cannot be combined with targetBotId.',
  },
  targetBotId: {
    type: 'string',
    minLength: 1,
    description:
      'Match instance target.botId exactly. Cannot be combined with targetProjectId.',
  },
  targetTaskId: {
    type: 'string',
    minLength: 1,
    description:
      'Match instance target.taskId exactly; project-wide or bot-wide scopes without a task do not match.',
  },
  targetChatId: {
    type: 'string',
    minLength: 1,
    description:
      'Match instance target.chatId exactly. Unavailable targets never match target filters.',
  },
};

export function buildSearchWatchersJsonSchema(
  triggers: readonly AgentWatcherTriggerType[],
  capabilities?: AgentActionDescriptionCapabilities,
): AgentJsonSchema {
  const chatOnly = workspaceChatWatchersOnly(capabilities);
  const pipelines = workspacePipelineWatchers(capabilities);
  const canonical = offersCanonicalChatWatchers(triggers);
  return {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: canonical
          ? 'Catalog search terms such as "pipeline finished", "watch execution", or "notify on failure"; separate from activeQuery.'
          : 'Search terms such as "pipeline finished", "watch execution", or "notify on failure".',
      },
      // Canonical hosts accept the legacy chat triggers without listing them.
      trigger: canonical
        ? {
            type: 'string',
            description: `Optional exact trigger filter: ${listInProse(
              triggers.filter(
                (trigger) => !isLegacyChatWatcherTrigger(trigger),
              ),
              'or',
            )}.`,
          }
        : {
            type: 'string',
            enum: [...triggers],
            description: pipelines
              ? 'Optional trigger filter. Chat-completion watchers on chats in the current project, and pipeline-completion watchers on workflow runs this chat started, are available here.'
              : chatOnly
                ? 'Optional trigger filter. Only chat-completion watchers on chats in the current project are available here.'
                : 'Optional trigger filter. Chats support pipeline/hook watchers scoped to their own worktree plus chat-completion, new-chat-started, and automation-run watchers targeting any project by id.',
          },
      includeActive: {
        type: 'boolean',
        description:
          'When false, only the catalog is returned. Defaults to true so active watchers for this chat are included.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum number of catalog entries to return.',
      },
      ...(canonical ? ACTIVE_WATCHER_PAGING_JSON_PROPERTIES : {}),
      detailLevel: {
        type: 'string',
        enum: ['minimal', 'standard'],
        description: chatOnly
          ? 'minimal (default) returns bounded catalog rows; standard also returns usage guidance.'
          : canonical
            ? 'minimal (default) returns bounded catalog rows; standard also returns usage guidance and hook-trigger details. Both include authorized canonical instance target IDs.'
            : 'minimal (default) returns bounded catalog rows; standard also returns usage guidance and hook-trigger details.',
      },
    },
    additionalProperties: false,
  };
}

/** A workflow run this chat started, as a project-scoped host watches it. */
const RUN_WATCHER_TARGET_JSON_SCHEMA: AgentJsonSchema = {
  type: 'object',
  required: ['executionId'],
  description:
    'The watched workflow run: the executionId pipeline.run returned. Do not include kind, destination chatId, or display names.',
  properties: {
    executionId: {
      type: 'string',
      description: 'Execution id of a run this chat started.',
    },
    terminalStatuses: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: ['success', 'failure', 'cancelled'] },
      description:
        'Optional terminal statuses that fire the watcher. Defaults to success, failure, and cancelled.',
    },
  },
  additionalProperties: false,
};

const CHAT_WATCHER_TARGET_JSON_SCHEMA: AgentJsonSchema = {
  type: 'object',
  required: ['projectId', 'worktreeId', 'chatId'],
  description:
    'The watched chat: the current project id as projectId, plus its worktreeId and chatId. A chat cannot watch itself. Do not include kind, destination chatId, or display names.',
  properties: {
    projectId: {
      type: 'string',
      description: 'The current project id.',
    },
    worktreeId: {
      type: 'string',
      description: 'Worktree id of the watched chat.',
    },
    chatId: {
      type: 'string',
      description: 'Chat id of the watched chat. Not a title or session key.',
    },
  },
  additionalProperties: false,
};

export function buildSetupWatchersJsonSchema(
  brand: AgentActionBrand,
  triggers: readonly AgentWatcherTriggerType[],
  capabilities?: AgentActionDescriptionCapabilities,
): AgentJsonSchema {
  const targetTriggers = triggers.filter(
    (trigger) => !isCanonicalChatWatcherTrigger(trigger),
  );
  const canonicalTriggers = triggers.filter(isCanonicalChatWatcherTrigger);
  if (canonicalTriggers.length === 0)
    return targetWatcherSetupJsonSchema(brand, triggers, capabilities);
  // Canonical entries join as a strict second branch. The target-filter
  // branch accepts the legacy chat triggers without listing them.
  const advertised = listInProse(
    triggers.filter((trigger) => !isLegacyChatWatcherTrigger(trigger)),
    'or',
  );
  return extendChatWatcherSetupJsonSchema(
    targetWatcherSetupJsonSchema(brand, targetTriggers, capabilities, {
      // A lookahead, not `not`: schema converters such as Zod's reject `not`.
      trigger: {
        type: 'string',
        pattern: `^(?!(?:${canonicalTriggers.join('|')})$)`,
        description: `Watcher trigger from SearchWatchers: ${advertised}. Chat triggers require an explicit value. When omitted, defaults to worktree_hook_triggered when target.triggerName is supplied, automation_run when target.automationId is supplied, otherwise worktree_pipeline_completion.`,
      },
      projectId: {
        type: 'string',
        description:
          'Compatibility workspace/project or cowork project ID, never a runtime sentinel.',
      },
      worktreeId: {
        type: 'string',
        description: 'Compatibility worktree ID for chat targets.',
      },
      chatId: {
        type: 'string',
        description: 'Compatibility chat ID, not a title or session key.',
      },
    }),
  );
}

/** Field schemas a canonical host words for the target-filter branch. */
interface CompatibilityFieldSchemas {
  trigger: AgentJsonSchema;
  projectId: AgentJsonSchema;
  worktreeId: AgentJsonSchema;
  chatId: AgentJsonSchema;
}

function targetWatcherSetupJsonSchema(
  brand: AgentActionBrand,
  triggers: readonly AgentWatcherTriggerType[],
  capabilities?: AgentActionDescriptionCapabilities,
  compatibility?: CompatibilityFieldSchemas,
): AgentJsonSchema {
  const chatOnly = workspaceChatWatchersOnly(capabilities);
  const pipelines = workspacePipelineWatchers(capabilities);
  return {
    type: 'object',
    required: ['watchers'],
    properties: {
      watchers: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['target'],
          properties: {
            trigger: compatibility?.trigger ?? {
              type: 'string',
              enum: [...triggers],
              description: pipelines
                ? 'Watcher trigger: worktree_chat_completion for a chat, worktree_pipeline_completion for a workflow run. Chat-completion watchers require it explicitly.'
                : chatOnly
                  ? 'Watcher trigger. Chat-completion watchers require an explicit worktree_chat_completion.'
                  : 'Watcher trigger. Chat triggers require an explicit value. When omitted, defaults to worktree_hook_triggered when target.triggerName is supplied, automation_run when target.automationId is supplied, otherwise worktree_pipeline_completion.',
            },
            label: {
              type: 'string',
              maxLength: 200,
              description: `Optional human-readable label. Usually omit so ${brand.displayName} captures display metadata.`,
            },
            target: pipelines
              ? {
                  anyOf: [
                    CHAT_WATCHER_TARGET_JSON_SCHEMA,
                    RUN_WATCHER_TARGET_JSON_SCHEMA,
                  ],
                  description:
                    'A chat in the current project (projectId, worktreeId, chatId) or a workflow run this chat started (executionId).',
                }
              : chatOnly
                ? CHAT_WATCHER_TARGET_JSON_SCHEMA
                : {
                    type: 'object',
                    anyOf: [
                      { required: ['executionId'] },
                      { required: ['pipelineId'] },
                      { required: ['terminalStatuses'] },
                      { required: ['triggerName'] },
                      { required: ['automationId'] },
                      { required: ['projectId'] },
                    ],
                    description:
                      'Watcher target filter. Pipeline watchers (same worktree, ids injected server-side) include executionId, pipelineId, or terminalStatuses. Hook watchers use triggerName and optional hookKey or scope/repoId. Chat triggers supply the full caller-known ids: projectId plus worktreeId/chatId as the trigger requires — a chat cannot watch itself. automation_run supplies automationId. Do not include kind, destination chatId, or display names.',
                    properties: {
                      executionId: {
                        type: 'string',
                        description:
                          'Optional non-terminal execution id for a one-shot watcher.',
                      },
                      pipelineId: {
                        type: 'string',
                        description:
                          'Optional pipeline id. Omit executionId and set pipelineId to watch future matching runs in this worktree.',
                      },
                      terminalStatuses: {
                        type: 'array',
                        minItems: 1,
                        items: {
                          type: 'string',
                          enum: ['success', 'failure', 'cancelled'],
                        },
                        description:
                          'Optional terminal statuses that should consume the watcher. Defaults to success, failure, and cancelled. Paused executions also notify the watcher without consuming it.',
                      },
                      triggerName: {
                        type: 'string',
                        description:
                          'Supported hook trigger name for worktree_hook_triggered watchers.',
                      },
                      hookKey: {
                        type: 'string',
                        description:
                          'Optional configured hook key to watch one hook entry.',
                      },
                      scope: {
                        type: 'string',
                        enum: ['project', 'workspace-root', 'workspace-repo'],
                        description:
                          'Optional hook scope when hookKey is omitted. Use with repoId for workspace-repo hooks.',
                      },
                      repoId: {
                        type: 'string',
                        description: 'Repo id for workspace-repo hook targets.',
                      },
                      projectId: compatibility?.projectId ?? {
                        type: 'string',
                        description:
                          'Project id for chat triggers: the workspace/project of the watched chat or worktree, or the cowork project id for standalone triggers (never the standalone sentinel).',
                      },
                      worktreeId: compatibility?.worktreeId ?? {
                        type: 'string',
                        description:
                          'Worktree id for worktree_chat_completion and worktree_new_chat_started targets.',
                      },
                      chatId: compatibility?.chatId ?? {
                        type: 'string',
                        description:
                          'Chat id for worktree_chat_completion and standalone_chat_completion targets. Not a title or session key.',
                      },
                      automationId: {
                        type: 'string',
                        description:
                          'Automation (scheduled activity) id for automation_run watchers. Discover ids with the automation.list dispatch action.',
                      },
                    },
                    additionalProperties: false,
                  },
            followUpInstruction: {
              type: 'string',
              description: !chatOnly
                ? 'Optional instruction included in the generated message when the watcher fires.'
                : capabilities?.hiddenInstructions === false
                  ? 'Optional instruction included in the visible message posted when the watcher fires.'
                  : 'Optional instruction included in the hidden event details of the notification posted when the watcher fires.',
            },
            allowDuplicate: {
              type: 'boolean',
              description:
                'Usually omit. When false or omitted, identical active watchers for this chat are deduped.',
            },
            armForNextCompletion: {
              type: 'boolean',
              description:
                'Chat-completion watchers only. Set true to arm an idle chat for its next completed turn; omit to require a running or pending turn.',
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
}

function deleteWatchersJsonSchemaWith(description: string): AgentJsonSchema {
  return {
    type: 'object',
    required: ['watcherIds'],
    properties: {
      watcherIds: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
        description,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
      },
    },
    additionalProperties: false,
  };
}

export const DELETE_WATCHERS_JSON_SCHEMA: AgentJsonSchema =
  deleteWatchersJsonSchemaWith(
    'Watcher ids returned for this chat by SearchWatchers, SetupWatchers, or WatchGitHubItems.',
  );

export function buildDeleteWatchersJsonSchema(
  capabilities?: AgentActionDescriptionCapabilities,
): AgentJsonSchema {
  return workspaceChatWatchersOnly(capabilities)
    ? deleteWatchersJsonSchemaWith(
        'Watcher ids returned for this chat by SearchWatchers or SetupWatchers.',
      )
    : DELETE_WATCHERS_JSON_SCHEMA;
}
