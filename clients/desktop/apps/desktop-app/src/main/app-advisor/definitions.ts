import {
  CHAT_HISTORY_ACTION_TYPES,
  chatHistoryActionSchema,
  type ChatHistoryAction,
} from '@canopy/agent-actions/families/chat-history';
import {
  scriptPreferencesActionSchema,
  scriptPreferencesDispatchJsonSchema,
} from '@canopy/agent-actions/families/settings/script-preferences';
import {
  MAX_ACTIVE_WATCHER_PAGE_SIZE,
  MAX_ACTIVE_WATCHER_QUERY_LENGTH,
} from '@canopy/desktop-shared/lib/app-advisor-watchers';
import {
  chatWatcherSetupSchema,
  extendChatWatcherSetupJsonSchema,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  projectsGetLastUserMessageActionSchema,
  projectsGetLastAgentResponseActionSchema,
  projectsReadHistoryActionSchema,
} from '@canopy/desktop-shared/lib/project-reads';
import {
  projectsListActionSchema,
  projectsListTasksActionSchema,
  projectsListTaskChatsActionSchema,
} from '@canopy/desktop-shared/lib/project-discovery';
import { botActionSchema } from '@canopy/desktop-shared/lib/bot-discovery';
import { CHAT_PLUGIN_LIST_MAX_LIMIT } from '@canopy/desktop-shared/lib/app-advisor-chat-reads';
import {
  projectsCreateTaskActionSchema,
  projectsCreateTaskChatActionSchema,
  botsCreateTaskActionSchema,
  botsCreateTaskChatActionSchema,
  projectsSteerQueuedMessageActionSchema,
  projectsScheduleMessageActionSchema,
  botsSendMessageActionSchema,
  projectsSendMessageActionSchema,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import {
  projectBrowserControlAction,
  projectBrowserPointerViewportAction,
} from '@canopy/agent-actions/families/browser/command';
import { editorSetupActionSchema } from '@canopy/agent-actions/families/editor-setup/actions';
import { cloudChatActionSchema } from '@canopy/agent-actions/families/cloud-chats/actions';
import {
  appAdvisorPipelineRunActionSchema,
  type AppAdvisorPipelineRunAction,
  installedItemActionSchema,
  installedItemDispatchJsonSchema,
  INSTALLED_ITEM_ACTION_TYPES,
  type InstalledItemAction,
  experimentActionSchema,
  PIPELINES_ACTION_TYPES,
  pipelinesDispatchJsonSchema,
  experimentDispatchJsonSchema,
  type ExperimentAction,
  EXPERIMENT_ACTION_TYPES,
  settingsActionSchema,
  aiGatewayActionSchema,
  type AiGatewayAction,
  settingsDispatchJsonSchema,
  type SettingsAction,
  SETTINGS_ACTION_TYPES,
  TRANSCRIPT_READ_ACTION_TYPES,
  transcriptReadActionSchema,
  transcriptReadDispatchJsonSchema,
  type TranscriptReadAction,
} from '@canopy/agent-actions';
import { isAbsolute } from 'node:path';
import { SIDEBAR_ITEM_GROUP_COLORS } from '@canopy/protocol/sidebar';
import {
  sidebarGroupAssignmentFields,
  hasOneSidebarGroupDestination,
} from '../canopy-tools/sidebar-item-group-schema';
import { sharingOpenDialogSchema } from '@canopy/desktop-shared/lib/sharing-action-schema';
import {
  addAdvisorBrowserActionIssues,
  browserFrameJsonSchemaRules,
  browserPointerViewportJsonSchemaRules,
  browserTransferJsonSchemaRules,
  browserWaitForJsonSchemaRules,
  browserDownloadWaitJsonSchema,
  createAdvisorBrowserActionSchemas,
} from '@canopy/agent-actions/families/browser/schemas';
import { z } from 'zod/v4';
import { extractCreateFromReferences } from '@canopy/desktop-shared/lib/create-from-reference';
import { BRAND } from '@canopy/brand/current';
import {
  AUTOMATIONS_PANEL_VARIANTS,
  REMOTE_CONTROL_LABEL,
  USAGE_PANEL_VARIANTS,
} from '@canopy/protocol';
import { THINKING_LEVELS } from '@canopy/protocol/thinking';
import { CODEX_SPEEDS } from '@canopy/protocol/automations';
import { DATA_SHARING_OPT_IN_FEATURES } from '@canopy/protocol/canopy-server';
import {
  ORG_PROJECT_LIMITS,
  ORG_REPOSITORY_OWNER_URL_MAX_LENGTH,
} from '@canopy/protocol/org-projects';
import { MAX_MANAGED_DELEGATION_DEPTH } from '@canopy/protocol/delegation/discovery';
import {
  isCuratedCatalogKey,
  PROFILE_ROLES,
} from '@canopy/protocol/plugin-catalog';
import { NAVIGATION_MODES } from '@canopy/desktop-shared/lib/navigation-mode';
import {
  CLAUDE_MAX_TURNS_MIN,
  CLAUDE_MAX_TURNS_MAX,
} from '@canopy/desktop-shared/constants/preferences';
import { APP_ADVISOR_ACTION_CATALOG } from '@canopy/desktop-shared/lib/app-advisor-actions';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import {
  APP_ADVISOR_PROJECT_ID,
  PLUGINS_MANAGEMENT_SECTIONS,
  NAVIGATION_PAGE_MAP,
  WORKFLOW_EDIT_SECTIONS,
} from '@canopy/desktop-shared/types';
import type {
  AppAdvisorAction,
  AutomationCreateRequest,
  AutomationUpdateRequest,
} from '@canopy/desktop-shared/types';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  ADD_LEDGER_ENTRY_DESCRIPTION,
  SEARCH_LEDGER_ENTRIES_DESCRIPTION,
  UPDATE_LEDGER_ENTRY_DESCRIPTION,
  getCodeGraphContextSchema,
  buildOrUpdateCodeGraphSchema,
  queryCodeGraphSchema,
  searchCodeGraphSchema,
  explainCodeSymbolSchema,
  getImpactRadiusSchema,
  detectChangedSymbolsSchema,
  compareChangeImpactSchema,
  getReviewContextSchema,
  askUserQuestionJsonSchema,
  askUserQuestionSchema,
  getScriptOutputJsonSchema,
  getScriptOutputSchema,
  getFileCommentsJsonSchema,
  getFileCommentsSchema,
  MAX_SCRIPT_WAIT_SECONDS,
  readPipelineYamlBaseSchema,
  readPipelineYamlJsonSchema,
  pipelineRuntimeIdentifierSchema,
  showFilesJsonSchema,
  showFilesSchema,
  respondToFileCommentJsonSchema,
  respondToFileCommentSchema,
  watchGitHubItemsJsonSchema as sharedWatchGitHubItemsJsonSchema,
  watchGitHubItemsSchema as sharedWatchGitHubItemsSchema,
  buildGetGitHubPullRequestStatusDescription,
  getGitHubPullRequestStatusJsonSchema as sharedGetGitHubPullRequestStatusJsonSchema,
  getGitHubPullRequestStatusSchema as sharedGetGitHubPullRequestStatusSchema,
} from '../canopy-tools/definitions';
import { SUPPORTED_HOOK_TRIGGERS } from '@canopy/desktop-shared/hooks';

const appName = BRAND.displayName;

const optionalBaseBranchSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.startsWith('-') && value !== 'HEAD', {
    message: 'baseBranch must be a valid branch name and cannot be HEAD.',
  })
  .optional();

export const GET_CURRENT_UI_STATE_DESCRIPTION = `Read the current sanitized ${appName} UI state. The response excludes secrets, file contents, transcripts, command logs, and ${REMOTE_CONTROL_LABEL.toLowerCase()} pairing codes.`;

export const DISPATCH_ACTION_DESCRIPTION = `Dispatch a typed ${appName} UI action. Use expectedUiRevision when acting on a state snapshot so stale actions can be rejected.`;

export const SEARCH_ACTIONS_DESCRIPTION = `Search the typed ${appName} app actions, including read-only explicit-target project discovery and visible chat history reads that Orchestrator can dispatch. Use this before dispatch_action when you are unsure which action type or payload fields are supported.`;

export const GET_PIPELINE_DEBUG_CONTEXT_DESCRIPTION = `Build a redacted debugging prompt for a failed ${appName} pipeline execution, including failure metadata, reports, and bounded log tails.`;

export const APP_ADVISOR_GET_SCRIPT_OUTPUT_DESCRIPTION = `Read output from a ${appName} worktree script run. Optional projectId and worktreeId override the current ${appName} UI selection; when omitted, the currently selected worktree from the sanitized UI snapshot is used. If no worktree is selected, the tool fails with surface_unavailable.`;

export const APP_ADVISOR_READ_PIPELINE_YAML_DESCRIPTION = `Read the raw YAML definition for a ${appName} pipeline. Optional projectId and worktreeId override the current ${appName} UI selection; when omitted, the currently selected worktree from the sanitized UI snapshot is used. Supports full reads, line number ranges, and grep-like filtering options.`;

export const APP_ADVISOR_SHOW_FILES_DESCRIPTION = `Open one or more files beside the Orchestrator chat or in an explicitly targeted project. Always use this tool when the user asks to see a file or section of a file. Omit workspace to open in Orchestrator's own Work Entry UX; provide workspace.projectId and workspace.worktreeId together to open in that project's main-window panel grid. Present requested deliverables and files the user should review; never automatically present internal workflow state, scheduling JSON, logs, caches, checkpoints, or temporary bookkeeping. Explicit requests to view internal files are supported. Automation-origin requests are deferred without opening panels; other agent requests during a browser handoff open in the background. Report the actual opened, activated, and deferred outcomes. Supports up to 10 files in requested tab order with the first valid file active for foreground requests, optional annotations (whose optional comments start threads), raw-file line scrolling, and rich/raw view selection. HTML pages open rendered in the in-app browser; pass view: "raw", a line, or annotations to show the page source instead.`;

export const APP_ADVISOR_GET_FILE_COMMENTS_DESCRIPTION =
  "Read file annotation comment threads from Orchestrator's own Work Entry or an explicitly targeted project, and — for an explicitly targeted project's worktree — its tracked-plan comment threads. Omit workspace for Orchestrator's files; provide workspace.projectId and workspace.worktreeId for a target project. Provide threadId for full submitted history, or omit it to summarize open threads. Staged drafts are redacted.";

export const APP_ADVISOR_RESPOND_TO_FILE_COMMENT_DESCRIPTION =
  "Reply to and optionally resolve a file annotation comment thread in Orchestrator's own Work Entry or an explicitly targeted project, or — for an explicitly targeted project's worktree — a tracked-plan comment thread. Keep the workspace target identical to the ShowFiles/GetFileComments call that found the thread. Set resolve only after the comment is addressed.";

const SAFE_WORKSPACE_ID_PATTERN = '^[a-z0-9][a-z0-9-]*$';
const safeWorkspaceIdSchema = z
  .string()
  .regex(
    new RegExp(SAFE_WORKSPACE_ID_PATTERN),
    'Project ids must be lowercase alphanumeric with hyphens',
  );
const explicitWorkspaceProjectIdSchema = safeWorkspaceIdSchema.refine(
  (projectId) => projectId !== APP_ADVISOR_PROJECT_ID,
  'The Orchestrator project id cannot be used as an explicit project target',
);

const appAdvisorFileWorkspaceSchema = z.object({
  projectId: explicitWorkspaceProjectIdSchema,
  worktreeId: safeWorkspaceIdSchema,
});

type JsonObject = { [key: string]: JsonValue | undefined };

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonObjectProperties(value: JsonValue): JsonObject {
  if (!isJsonObject(value)) return {};
  const { properties } = value;
  return properties !== undefined && isJsonObject(properties) ? properties : {};
}

export const appAdvisorShowFilesSchema = showFilesSchema.extend({
  workspace: appAdvisorFileWorkspaceSchema.optional(),
});

export const appAdvisorGetFileCommentsSchema = getFileCommentsSchema.extend({
  workspace: appAdvisorFileWorkspaceSchema.optional(),
});

export const appAdvisorRespondToFileCommentSchema =
  respondToFileCommentSchema.extend({
    workspace: appAdvisorFileWorkspaceSchema.optional(),
  });

const showFilesJsonSchemaObject = isJsonObject(showFilesJsonSchema)
  ? showFilesJsonSchema
  : {};
const showFilesJsonSchemaProperties = jsonObjectProperties(
  showFilesJsonSchemaObject,
);

export const appAdvisorShowFilesJsonSchema: JsonValue = {
  ...showFilesJsonSchemaObject,
  properties: {
    ...showFilesJsonSchemaProperties,
    workspace: {
      type: 'object',
      description:
        "Explicit target project. Omit to open in Orchestrator's own Work Entry UX.",
      properties: {
        projectId: {
          type: 'string',
          pattern: SAFE_WORKSPACE_ID_PATTERN,
        },
        worktreeId: {
          type: 'string',
          pattern: SAFE_WORKSPACE_ID_PATTERN,
        },
      },
      required: ['projectId', 'worktreeId'],
      additionalProperties: false,
    },
  },
};

function withOptionalFileWorkspace(schema: JsonValue): JsonValue {
  const schemaObject = isJsonObject(schema) ? schema : {};
  const schemaProperties = jsonObjectProperties(schemaObject);
  return {
    ...schemaObject,
    properties: {
      ...schemaProperties,
      workspace: {
        type: 'object',
        description:
          "Explicit target project. Omit for Orchestrator's own Work Entry.",
        properties: {
          projectId: {
            type: 'string',
            pattern: SAFE_WORKSPACE_ID_PATTERN,
          },
          worktreeId: {
            type: 'string',
            pattern: SAFE_WORKSPACE_ID_PATTERN,
          },
        },
        required: ['projectId', 'worktreeId'],
        additionalProperties: false,
      },
    },
  };
}

export const appAdvisorGetFileCommentsJsonSchema = withOptionalFileWorkspace(
  getFileCommentsJsonSchema,
);
export const appAdvisorRespondToFileCommentJsonSchema =
  withOptionalFileWorkspace(respondToFileCommentJsonSchema);

export const SEARCH_WATCHERS_DESCRIPTION =
  "Search the Orchestrator watcher catalog and optionally list this chat's own active watchers with authorized canonical target IDs at both detail levels. Catalog query/limit (1–100) are separate from instance activeQuery (up to 500 characters), activePageSize (1–200, default 50), activeCursor, and targetProjectId/targetBotId/targetTaskId/targetChatId filters. Do not combine project and bot filters. Results retain catalog/activeWatchers and add activeReturned, activeTotalMatches, and optional activeNextCursor. Use this before setup_watchers to discover supported trigger types, target fields, and watcher-entry fields. Completion watchers observe future transitions only: by default an idle chat is rejected, but armForNextCompletion:true beside target arms its next completed turn. New-chat-started watchers observe future newly tracked chats in canonical project/bot scopes, optionally restricted to a task. Hook watchers observe future automatic worktree hook triggers, including paused or unconfigured hooks. Automation-run watchers observe a scheduled activity: failed/skipped runs notify immediately, successful runs notify when a dispatched chat turn ends or a dispatched pipeline completes. The destination Orchestrator chat is captured server-side; never supply destination/session/chat ids to setup_watchers.";

export const SETUP_WATCHERS_DESCRIPTION =
  'Create one or more Orchestrator watchers for future chat completions, new-chat-started events, pipeline pause/completion events, automatic worktree hook triggers, or automation run outcomes. Use { watchers: [...] }. For project_task_chat_completion supply target {projectId,taskId,chatId}; for bot_task_chat_completion supply {botId,taskId,chatId}. For project_new_chat_started supply {projectId,taskId?}; for bot_new_chat_started supply {botId,taskId?}. Canonical chat targets must not include kind or destination fields. For worktree_pipeline_completion use {kind: "worktree_pipeline",projectId,worktreeId,executionId?,pipelineId?,terminalStatuses?}; for worktree_hook_triggered use {kind: "worktree_hook",projectId,worktreeId,triggerName,hookKey?,scope?,repoId?}; for automation_run use {kind: "automation",automationId}. Pipeline pause notifications leave the watcher active; matching terminal notifications consume it. Hook watchers fire for automatic triggers only and include hook variables in hidden context. Failed/skipped automation runs notify immediately; successful runs notify after the dispatched chat turn or pipeline completes. Copy canonical IDs from discovery results. Never provide targetKind, display metadata, destinationChatId, chatId outside target, sessionKey, requestId, or transport identifiers. Idle completion targets require armForNextCompletion:true beside target. Terminal executions and unknown automation IDs are rejected. Use SearchWatchers first.';

export const WATCH_GITHUB_ITEMS_DESCRIPTION =
  'Create one durable watcher for 1–20 GitHub items of one kind, either GitHub Actions workflow runs or pull requests. Workflow runs: for every completed job use {"notifyOn":{"jobs":{"conclusions":"any"}}}; for whole-run changes use notifyOn.run.statuses and/or notifyOn.run.conclusions. The watcher captures the current run and job state as its baseline, ends this turn, and later notifies the subscribing chat only for selected future changes. A job URL only identifies its parent run and does not select job notifications. Pull requests: pass {"kind":"pull_request","target":"<PR URL or owner/repository#number>"}. The watcher always wakes when a PR merges, closes without merging, or is removed from the merge queue (with GitHub\'s reason when verifiable), and keeps watching after a removal. To also wake on queue entry or phase moves, add notifyOn.queue, for example {"notifyOn":{"queue":{"entered":true}}} or {"notifyOn":{"queue":{"phases":["unmergeable"]}}}; position-only changes never wake. notifyOn.run and notifyOn.jobs are for workflow runs only. A pull request that is already merged or closed is reported per item in the result and is not watched. Do not mix runs and pull requests in one call. Use this instead of gh run watch, gh pr view, repeated status checks, shell polling loops, or keeping a turn open. The destination is captured server-side; never supply destination, runtime, display, retry, or delivery state.';

export const GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION =
  buildGetGitHubPullRequestStatusDescription('WatchGitHubItems');

/**
 * The shared Agent Ledger tool description, naming App Advisor's own
 * SearchLedgerEntries instead of the Code and Cowork chat one. App Advisor
 * advertises the Ledger tools with the shared input schemas.
 */
function appAdvisorLedgerToolDescription(description: string): string {
  return description
    .split(CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.codexToolName)
    .join(APP_ADVISOR_TOOL_REGISTRY.search_ledger_entries.codexToolName);
}

export const APP_ADVISOR_ADD_LEDGER_ENTRY_DESCRIPTION =
  appAdvisorLedgerToolDescription(ADD_LEDGER_ENTRY_DESCRIPTION);

export const APP_ADVISOR_SEARCH_LEDGER_ENTRIES_DESCRIPTION =
  appAdvisorLedgerToolDescription(SEARCH_LEDGER_ENTRIES_DESCRIPTION);

export const APP_ADVISOR_UPDATE_LEDGER_ENTRY_DESCRIPTION =
  appAdvisorLedgerToolDescription(UPDATE_LEDGER_ENTRY_DESCRIPTION);

export const getCurrentUiStateSchema = z.object({});

export type AppAdvisorDispatchAction =
  | AppAdvisorAction
  | TranscriptReadAction
  | ChatHistoryAction;

const appAdvisorActionTypes = [
  ...APP_ADVISOR_ACTION_CATALOG.map((entry) => entry.type),
  ...TRANSCRIPT_READ_ACTION_TYPES,
  ...CHAT_HISTORY_ACTION_TYPES,
];
const appAdvisorActionTypeSchema = z.enum(appAdvisorActionTypes);
const visibleAppAdvisorActionTypes = APP_ADVISOR_ACTION_CATALOG.filter(
  (entry) => !entry.hidden,
).map((entry) => entry.type);
const providerActionTypeDescription =
  'Action type discovered with SearchActions, such as projects.list, projects.send_message, bots.create_task, or navigation.go_to_page. Use the discovered canonical address and required fields.';

export const searchActionsSchema = z.object({
  query: z.string().optional(),
  category: z.string().optional(),
  // Accept every type the JSON schema advertises, including the shared-engine
  // families App Advisor dispatches in main.
  actionType: z
    .union([
      appAdvisorActionTypeSchema,
      z.enum(INSTALLED_ITEM_ACTION_TYPES),
      z.enum(EXPERIMENT_ACTION_TYPES),
      z.enum(SETTINGS_ACTION_TYPES),
      z.enum(PIPELINES_ACTION_TYPES),
    ])
    .optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// Discovery is narrower than runtime acceptance of recorded compatibility inputs.
export const searchActionsToolShape = {
  ...searchActionsSchema.shape,
  actionType: z
    .union([
      z.enum(visibleAppAdvisorActionTypes),
      z.enum(TRANSCRIPT_READ_ACTION_TYPES),
      z.enum(CHAT_HISTORY_ACTION_TYPES),
      z.enum(INSTALLED_ITEM_ACTION_TYPES),
      z.enum(EXPERIMENT_ACTION_TYPES),
      z.enum(SETTINGS_ACTION_TYPES),
    ])
    .optional(),
};

const navigationPageSchema = z.enum(NAVIGATION_PAGE_MAP);

/**
 * `workflows` is the Runs page (CAN-3981). Before that it was an alias for
 * `automations`, and callers paired it with a legacy `tab`. The action
 * transform keeps that pairing working by resolving it to `automations`,
 * the only page the dispatcher accepts a `tab` on.
 */
const GO_TO_PAGE_LEGACY_TAB_ALIAS = 'workflows';
const goToPageSchema = navigationPageSchema;

const settingsSectionSchema = z.enum([
  'canopy',
  'performance',
  'shortcuts',
  'display',
  'notifications',
  'account',
  'remote-access',
  'privacy',
  'chat',
  'approvals',
  'instructions',
  'harnesses',
  'app-advisor',
  'terminal',
  'browser',
  'files',
  'plan-detection',
  'dictation',
  'codex',
  'claude',
  'ollama',
  'account-proxy',
  'git',
  'applications',
  'mcp',
  'plugins',
  'environment',
  'code-graph',
  'experiments',
  'memory',
  'feedback',
  'legal',
]);

const scriptOverridesSchema = z.record(z.string(), z.any());
const hookOverridesSchema = z.record(z.string(), z.any());
const pluginSelectionsSchema = z.object({
  collectionIds: z.array(z.string()),
  // Accept legacy `bundleIds` for backwards-compatible inbound migration.
  // Persisted output uses `collectionIds`; `bundleIds` is dropped on write.
  bundleIds: z.array(z.string()).optional(),
  skillRefs: z.array(
    z.object({
      sourceId: z.string(),
      skillName: z.string(),
    }),
  ),
  pluginRefs: z.array(
    z.object({
      marketplaceId: z.string(),
      pluginName: z.string(),
    }),
  ),
  mcpServerRefs: z
    .array(
      z.object({
        serverId: z.string(),
        configId: z.string(),
      }),
    )
    .optional(),
  mcpHttpAuthPreferences: z.array(z.any()).optional(),
});
const pluginKindSchema = z.preprocess(
  (value) => (value === 'bundle' ? 'collection' : value),
  z.enum(['collection', 'skill', 'plugin', 'mcp']),
);
const thinkingLevelSchema = z.enum(THINKING_LEVELS);
const catalogSkillRefSchema = z.strictObject({
  sourceId: z.string().min(1),
  skillName: z.string().min(1),
});
const catalogPluginRefSchema = z.strictObject({
  marketplaceId: z.string().min(1),
  pluginName: z.string().min(1),
});
const catalogMcpServerRefSchema = z.strictObject({
  serverId: z.string().min(1),
  configId: z.string().min(1),
});
const advisorChatTextSchema = z.string().regex(/\S/, 'text must not be blank');
const worktreeChatActionSchema = z.enum(['hand_off', 'fork', 'branch']);
const trackedPlanReviewStatusSchema = z.enum([
  'pending',
  'approved',
  'dismissed',
]);
const planCommentThreadStatusSchema = z.enum(['open', 'resolved']);
const planCommentAnchorStateSchema = z.enum(['matched', 'outdated']);
const adhocMultiRepoModeSchema = z.enum([
  'temporary',
  'update-source-workspace',
]);
const pipelineRunModeSchema = z.enum(['dispatch', 'plan_ready', 'task_ready']);
const worktreeGitActionSchema = z.enum([
  'create-pr',
  'commit',
  'merge',
  'merge-pr',
  'commit-and-push',
  'pull-commit-and-push',
  'push',
  'pull',
]);
const pipelineExecutionStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'success',
  'failure',
  'cancelled',
]);
const pipelineExecutionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const browserScopeShape = {
  expectedRuntimeGeneration: z.number().int().positive().optional(),
  projectId: explicitWorkspaceProjectIdSchema.optional(),
  worktreeId: safeWorkspaceIdSchema.optional(),
} as const;
const watcherPipelineTerminalStatusSchema = z.enum([
  'success',
  'failure',
  'cancelled',
]);
const inlineWatcherSetupSchema = z.object({
  label: z.string().optional(),
  followUpInstruction: z.string().optional(),
  allowDuplicate: z.boolean().optional(),
  terminalStatuses: z.array(watcherPipelineTerminalStatusSchema).optional(),
});
const automationInlineWatcherSetupSchema = inlineWatcherSetupSchema
  .omit({ terminalStatuses: true })
  .strict();
const pipelineShareScopeSchema = z.enum(['team', 'organization']);
const repoScriptChangeSchema = z.object({
  repoId: z.string(),
  scripts: scriptOverridesSchema,
});
const repoHookChangeSchema = z.object({
  repoId: z.string(),
  hooks: hookOverridesSchema,
});
const sourceRepoAddSchema = z.object({
  repoId: z.string().optional(),
  repoName: z.string(),
  remoteUrl: z.string(),
  repoPath: z.string().optional(),
  scripts: scriptOverridesSchema.optional(),
  hooks: hookOverridesSchema.optional(),
});
const skillExtraMetadataSchema = z.record(z.string(), z.string());

const panelAddTabActionSchema = z.discriminatedUnion('kind', [
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.enum([
      'terminal',
      'activity-section',
      'browser',
      'file-explorer',
      'subagents',
      'ledger',
      'cost',
    ]),
  }),
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.literal('session-breakdown'),
    chatId: z.string().min(1),
  }),
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.literal('chat'),
    chatTabId: z.string(),
  }),
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.literal('file-diff'),
    fileTabId: z.string().optional(),
    filePath: z.string().optional(),
  }),
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.literal('activity-card'),
    sectionId: z.string(),
  }),
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.literal('usage'),
    variant: z.enum(USAGE_PANEL_VARIANTS),
  }),
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.literal('automations'),
    variant: z.enum(AUTOMATIONS_PANEL_VARIANTS),
  }),
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.literal('chat-visuals'),
    chatTabId: z.string().min(1),
  }),
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.literal('plan'),
    planId: z.string().min(1),
  }),
  z.object({
    type: z.literal('panel.add_tab'),
    groupId: z.string().optional(),
    kind: z.literal('plan-diagram'),
    planId: z.string().min(1),
  }),
]);

const fileTreeItemReferenceSchema = z.object({
  repoId: z.string().min(1),
  relativePath: z.string(),
});

const sidebarItemIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const sidebarGroupIdSchema = z.string().regex(/^grp-[a-z0-9][a-z0-9-]*$/);
const sidebarGroupScopeSchema = z.union([
  z.object({ appAdvisor: z.literal(true) }).strict(),
  z.object({ workspaceLocalId: sidebarItemIdSchema }).strict(),
]);
const sidebarGroupAnchors = {
  before: sidebarItemIdSchema.optional(),
  after: sidebarItemIdSchema.optional(),
};
const oneSidebarGroupAnchor = (value: {
  before?: string;
  after?: string;
}): boolean => !(value.before && value.after);

/**
 * The same bounds as the Add project dialog's `org-projects:find-repository-owner`
 * IPC (`ipc/org-projects.ts`): the shared URL bound, and the path bound the IPC
 * keeps private.
 */
const MAX_REPOSITORY_OWNER_PATH_LENGTH = 4096;

const hasOneRepositoryOwnerKey = (value: {
  path?: string;
  remoteUrl?: string;
}): boolean => (value.path !== undefined) !== (value.remoteUrl !== undefined);

const nonPanelAppAdvisorActionSchema = z.discriminatedUnion('type', [
  projectsGetLastUserMessageActionSchema,
  projectsGetLastAgentResponseActionSchema,
  projectsReadHistoryActionSchema,
  projectsListActionSchema,
  projectsListTasksActionSchema,
  projectsListTaskChatsActionSchema,
  ...botActionSchema.options,
  projectsSendMessageActionSchema,
  projectsCreateTaskActionSchema,
  projectsCreateTaskChatActionSchema,
  botsCreateTaskActionSchema,
  botsCreateTaskChatActionSchema,
  projectsSteerQueuedMessageActionSchema,
  projectsScheduleMessageActionSchema,
  botsSendMessageActionSchema,
  getCodeGraphContextSchema.extend({
    type: z.literal('code-graph.get_context'),
    projectId: explicitWorkspaceProjectIdSchema,
    worktreeId: safeWorkspaceIdSchema,
  }),
  buildOrUpdateCodeGraphSchema.extend({
    type: z.literal('code-graph.build'),
    projectId: explicitWorkspaceProjectIdSchema,
    worktreeId: safeWorkspaceIdSchema,
  }),
  queryCodeGraphSchema.extend({
    type: z.literal('code-graph.query'),
    projectId: explicitWorkspaceProjectIdSchema,
    worktreeId: safeWorkspaceIdSchema,
  }),
  searchCodeGraphSchema.extend({
    type: z.literal('code-graph.search'),
    projectId: explicitWorkspaceProjectIdSchema,
    worktreeId: safeWorkspaceIdSchema,
  }),
  explainCodeSymbolSchema.extend({
    type: z.literal('code-graph.explain'),
    projectId: explicitWorkspaceProjectIdSchema,
    worktreeId: safeWorkspaceIdSchema,
  }),
  getImpactRadiusSchema.extend({
    type: z.literal('code-graph.impact'),
    projectId: explicitWorkspaceProjectIdSchema,
    worktreeId: safeWorkspaceIdSchema,
  }),
  detectChangedSymbolsSchema.extend({
    type: z.literal('code-graph.detect_changes'),
    projectId: explicitWorkspaceProjectIdSchema,
    worktreeId: safeWorkspaceIdSchema,
  }),
  compareChangeImpactSchema.extend({
    type: z.literal('code-graph.compare_changes'),
    projectId: explicitWorkspaceProjectIdSchema,
    worktreeId: safeWorkspaceIdSchema,
  }),
  getReviewContextSchema.extend({
    type: z.literal('code-graph.review'),
    projectId: explicitWorkspaceProjectIdSchema,
    worktreeId: safeWorkspaceIdSchema,
  }),

  z
    .object({
      type: z.literal('sidebar.item_groups.list_items'),
      scope: sidebarGroupScopeSchema,
      groupId: sidebarGroupIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('sidebar.item_groups.set_item'),
      scope: sidebarGroupScopeSchema,
      itemId: sidebarItemIdSchema,
      ...sidebarGroupAssignmentFields,
    })
    .strict()
    .refine(
      hasOneSidebarGroupDestination,
      'Supply exactly one of groupId or newGroup.',
    ),
  z
    .object({
      type: z.literal('sidebar.item_groups.list'),
      scope: sidebarGroupScopeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('sidebar.item_groups.create'),
      scope: sidebarGroupScopeSchema,
      itemId: sidebarItemIdSchema,
      name: z.string().optional(),
      color: z.enum(SIDEBAR_ITEM_GROUP_COLORS).optional(),
      labelHidden: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sidebar.item_groups.update'),
      scope: sidebarGroupScopeSchema,
      groupId: sidebarGroupIdSchema,
      name: z.string().optional(),
      color: z.enum(SIDEBAR_ITEM_GROUP_COLORS).optional(),
      collapsed: z.boolean().optional(),
      labelHidden: z.boolean().optional(),
      keepWhenEmpty: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sidebar.item_groups.move_item'),
      scope: sidebarGroupScopeSchema,
      itemId: sidebarItemIdSchema,
      groupId: sidebarGroupIdSchema.nullable(),
      ...sidebarGroupAnchors,
    })
    .strict()
    .refine(oneSidebarGroupAnchor, 'Conflicting anchors'),
  z
    .object({
      type: z.literal('sidebar.item_groups.move_group'),
      scope: sidebarGroupScopeSchema,
      groupId: sidebarGroupIdSchema,
      ...sidebarGroupAnchors,
    })
    .strict()
    .refine(oneSidebarGroupAnchor, 'Conflicting anchors'),
  z
    .object({
      type: z.literal('sidebar.item_groups.ungroup'),
      scope: sidebarGroupScopeSchema,
      groupId: sidebarGroupIdSchema,
    })
    .strict(),

  z.object({ type: z.literal('agents.open_manager') }),
  z.object({
    type: z.literal('agents.list'),
    query: z.string().optional(),
    limit: z.number().optional(),
  }),
  z.object({ type: z.literal('agents.get'), id: z.string().min(1) }),
  z.object({
    type: z.literal('agents.create'),
    name: z.string().min(1),
    baseModel: z.string().min(1),
    instructions: z.string().min(1),
    modelIdSlug: z.string().optional(),
    pluginSelections: pluginSelectionsSchema.optional(),
  }),
  z
    .object({
      type: z.literal('agents.update'),
      id: z.string().min(1),
      name: z.string().optional(),
      baseModel: z.string().optional(),
      instructions: z.string().optional(),
      pluginSelections: pluginSelectionsSchema.optional(),
    })
    .refine(
      (action) =>
        action.name !== undefined ||
        action.baseModel !== undefined ||
        action.instructions !== undefined ||
        action.pluginSelections !== undefined,
      'agents.update requires name, baseModel, instructions, or pluginSelections.',
    ),
  z.object({ type: z.literal('agents.delete'), id: z.string().min(1) }),
  // CAN-6002: reachable from App Advisor for the first time; strict, so an
  // unknown field is refused rather than dropped.
  z.strictObject({
    type: z.literal('preferences.get_global_plugin_selections'),
  }),
  z.strictObject({
    type: z.literal('preferences.set_global_plugin_selections'),
    selections: pluginSelectionsSchema,
    expectedRevision: z.number().int().min(0),
  }),
  z.strictObject({
    type: z.literal('collections.list'),
    query: z.string().optional(),
    limit: z.number().int().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('collections.create'),
    name: z.string().min(1),
    description: z.string().optional(),
    skills: z.array(catalogSkillRefSchema).optional(),
    plugins: z.array(catalogPluginRefSchema).optional(),
    mcpServers: z.array(catalogMcpServerRefSchema).optional(),
  }),
  z.strictObject({
    type: z.literal('collections.update'),
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    skills: z.array(catalogSkillRefSchema).optional(),
    plugins: z.array(catalogPluginRefSchema).optional(),
    mcpServers: z.array(catalogMcpServerRefSchema).optional(),
  }),
  z.strictObject({
    type: z.literal('collections.delete'),
    id: z.string().min(1),
  }),
  // CAN-6003 part B: reachable for the first time, strictly (S6).
  z.strictObject({
    type: z.literal('collections.share'),
    id: z.string().min(1),
    shareScope: z.enum(['team', 'organization']),
    teamId: z.string().min(1).optional(),
    organizationId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Organization id for organization scope; omit to use the organization selected in the sidebar context switcher.',
      ),
  }),
  z.strictObject({
    type: z.literal('collections.list_shared'),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    createdBy: z.enum(['me', 'anyone']).optional(),
  }),
  z.strictObject({
    type: z.literal('collections.import_shared'),
    collectionId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('collections.update_shared'),
    collectionId: z.string().min(1),
    id: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('collections.delete_shared'),
    collectionId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('plugins.list_marketplaces'),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(CHAT_PLUGIN_LIST_MAX_LIMIT).optional(),
  }),
  z.strictObject({
    type: z.literal('plugins.refresh_marketplace'),
    marketplaceId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('plugins.remove_marketplace'),
    marketplaceId: z.string().min(1),
    providers: z
      .array(z.enum(['claude', 'codex']))
      .min(1)
      .optional(),
  }),
  z.object({
    type: z.literal('agents.list_shared'),
    query: z.string().optional(),
    limit: z.number().optional(),
    cursor: z.string().optional(),
    createdBy: z.enum(['me', 'anyone']).optional(),
  }),
  z.object({
    type: z.literal('agents.import_shared'),
    agentId: z.string().min(1),
  }),
  z.object({
    type: z.literal('agents.delete_shared'),
    agentId: z.string().min(1),
  }),
  z.object({
    type: z.literal('agents.publish_public_share'),
    agentId: z.string().min(1),
  }),
  z.object({
    type: z.literal('agents.revoke_public_share'),
    agentId: z.string().min(1),
  }),
  z.object({
    type: z.literal('navigation.go_to_page'),
    page: goToPageSchema,
    tab: z.enum(['scheduled', 'watchers', 'shared']).optional(),
  }),
  z.object({
    type: z.literal('navigation.open_chat_turn'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1).optional(),
    chatId: z.string().min(1),
    userMessageId: z.string().min(1),
  }),
  z.object({
    type: z.literal('navigation.open_settings'),
    section: settingsSectionSchema.optional(),
  }),
  z.object({
    type: z.literal('navigation.open_workspace_settings'),
    workspaceId: z.string().min(1),
    tab: z
      .enum([
        'details',
        'repositories',
        'scripts',
        'hooks',
        'environment',
        'code-graph',
      ])
      .optional(),
  }),
  z.object({
    type: z.literal('navigation.open_code_graph'),
    workspaceId: z.string().min(1),
  }),
  z.object({ type: z.literal('navigation.go_back') }),
  z.object({ type: z.literal('navigation.go_forward') }),
  z.object({ type: z.literal('navigation.open_customize_sidebar') }),
  z.object({ type: z.literal('navigation.close_settings') }),
  z.object({
    type: z.literal('chat.set_harness'),
    pickerId: z.string().min(1),
    harness: z.enum(['claude', 'codex', 'cursor']),
  }),
  z.object({ type: z.literal('ollama.install') }),
  z.object({
    type: z.literal('opencode.connection'),
    operation: z.enum(['status', 'models', 'connect', 'cancel', 'disconnect']),
  }),
  z.object({
    type: z.literal('account_proxy.status'),
    refresh: z.boolean().optional(),
  }),
  z
    .object({
      type: z.literal('account_proxy.set_routing'),
      claude: z.boolean().optional(),
      codex: z.boolean().optional(),
      keepChatOnOneAccount: z.boolean().optional(),
    })
    .strict()
    .refine(
      (action) =>
        action.claude !== undefined ||
        action.codex !== undefined ||
        action.keepChatOnOneAccount !== undefined,
      { message: 'Pass at least one setting to change.' },
    ),
  z.object({
    type: z.literal('cursor.connection'),
    operation: z.enum([
      'connect',
      'disconnect',
      'cancel',
      'change-account',
      'sign-in',
    ]),
  }),
  z.object({
    type: z.literal('cursor.approval_check'),
    operation: z.enum(['run', 'stop']),
  }),
  z.object({
    type: z.literal('settings.personalCatalog.set'),
    enabled: z.boolean(),
  }),
  z.object({ type: z.literal('remote_control.get_state') }),
  z.object({
    type: z.literal('remote_control.open_computer'),
    deviceId: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal('remote_control.set_allow_incoming'),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('settings.review_privacy_opt_in'),
    feature: z.enum(DATA_SHARING_OPT_IN_FEATURES),
    organizationId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('settings.set_local_memory_enabled'),
    enabled: z.boolean(),
  }),
  z.object({ type: z.literal('settings.get_local_memory_model') }),
  z.object({
    type: z.literal('settings.set_local_memory_model'),
    // Model availability and thinking support are checked against the live
    // catalog by the renderer dispatcher, the same rules as the Memory model
    // settings row.
    model: z.string().min(1),
    thinkingLevel: thinkingLevelSchema.optional(),
  }),
  z.object({ type: z.literal('settings.get_claude_max_turns') }),
  z.object({ type: z.literal('settings.get_handoff_model') }),
  z.object({
    type: z.literal('settings.set_handoff_model'),
    model: z.string().min(1),
    thinkingLevel: thinkingLevelSchema.optional(),
  }),
  z.object({
    type: z.literal('settings.set_claude_max_turns'),
    maxTurns: z
      .number()
      .int()
      .min(CLAUDE_MAX_TURNS_MIN)
      .max(CLAUDE_MAX_TURNS_MAX)
      .nullable(),
  }),
  z.object({
    type: z.literal('settings.set_ledger_agent_recording_enabled'),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('settings.set_skill_suggestions_enabled'),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('settings.set_launch_at_login'),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('settings.set_managed_delegation_mode'),
    mode: z.enum(['off', 'explicit-only', 'proactive']),
  }),
  z.object({
    type: z.literal('settings.set_managed_delegation_max_depth'),
    maxDepth: z.number().int().min(1).max(MAX_MANAGED_DELEGATION_DEPTH),
  }),
  z.object({
    type: z.literal('workspace_context.switch'),
    context: z.union([
      z.object({ kind: z.literal('personal') }),
      z.object({
        kind: z.literal('organization'),
        organizationId: z.string().uuid(),
      }),
    ]),
  }),
  z.object({
    type: z.literal('settings.set_profile_role'),
    role: z.enum(PROFILE_ROLES),
    roleDetail: z.string().optional(),
  }),
  z.object({
    type: z.literal('settings.set_navigation_mode'),
    mode: z.enum(NAVIGATION_MODES),
  }),
  z.object({ type: z.literal('settings.open_memory_folder') }),
  // The project whose memory joins the user's; never the selected one.
  z.object({
    type: z.literal('memory.import_external'),
    workspaceId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('memory.consolidate_now'),
    workspaceId: z.string().min(1).optional(),
  }),
  // The renderer validator requires workspaceId exactly when scope is
  // workspace; the discriminated union allows one member per type.
  z.object({
    type: z.literal('memory.rebuild'),
    scope: z.enum(['user', 'workspace']),
    workspaceId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('memory.list_snapshots'),
    scope: z.enum(['user', 'workspace']),
    workspaceId: z.string().min(1).optional(),
  }),
  // The snapshot id format is checked in main by the restore IPC.
  z.object({
    type: z.literal('memory.restore_snapshot'),
    scope: z.enum(['user', 'workspace']),
    workspaceId: z.string().min(1).optional(),
    snapshotId: z.string().min(1),
  }),
  z.object({ type: z.literal('navigation.open_import_projects') }),
  editorSetupActionSchema,
  ...cloudChatActionSchema.options,
  ...scriptPreferencesActionSchema.options,
  z.object({
    type: z.literal('navigation.open_command_palette'),
    query: z.string().optional(),
  }),
  z.object({
    type: z.literal('navigation.open_file_search'),
    query: z.string().optional(),
  }),
  z.object({
    type: z.literal('file-tree.set_search'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    query: z.string(),
  }),
  z.object({
    type: z.literal('file-tree.create_file'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    target: fileTreeItemReferenceSchema,
  }),
  z.object({
    type: z.literal('file-tree.create_directory'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    target: fileTreeItemReferenceSchema,
  }),
  z.object({
    type: z.literal('file-tree.copy'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    source: fileTreeItemReferenceSchema,
    target: fileTreeItemReferenceSchema,
    conflict: z.enum(['error', 'increment']).optional(),
  }),
  z.object({
    type: z.literal('file-tree.move'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    source: fileTreeItemReferenceSchema,
    target: fileTreeItemReferenceSchema,
  }),
  z.object({
    type: z.literal('file-tree.delete'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    target: fileTreeItemReferenceSchema,
  }),
  z.object({ type: z.literal('navigation.open_pr_picker') }),
  z.object({
    type: z.literal('usage.open_resume_modal'),
    provider: z.enum(['claude', 'codex']).optional(),
  }),
  z.object({ type: z.literal('usage.open_resume_queue') }),
  z.object({
    type: z.literal('usage.control_resume_queue'),
    action: z.enum(['pause', 'resume', 'stop', 'dismiss']),
  }),
  z.object({ type: z.literal('skills.open_manager') }),
  z.object({ type: z.literal('skill_suggestions.list') }),
  z.object({ type: z.literal('skill_suggestions.open') }),
  z.object({
    type: z.literal('skills.open_viewer'),
    sourceId: z.string(),
    skillName: z.string(),
    filePath: z.string().optional(),
  }),
  z.object({
    type: z.literal('skills.open_shared_viewer'),
    skillId: z.string().min(1),
  }),
  sharingOpenDialogSchema,
  z.object({
    type: z.literal('skills.list'),
    query: z.string().optional(),
    customOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('skills.list_marketplace'),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('skills.read'),
    sourceId: z.string(),
    skillName: z.string(),
  }),
  z.object({
    type: z.literal('skills.read_file'),
    sourceId: z.string(),
    skillName: z.string(),
    filePath: z.string(),
  }),
  z.object({
    type: z.literal('skills.create_custom'),
    name: z.string(),
    description: z.string(),
    body: z.string(),
    extraMetadata: skillExtraMetadataSchema.optional(),
  }),
  z
    .object({
      type: z.literal('skills.update_custom'),
      originalName: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      body: z.string().optional(),
      extraMetadata: skillExtraMetadataSchema.optional(),
    })
    .refine(
      (action) =>
        action.name !== undefined ||
        action.description !== undefined ||
        action.body !== undefined ||
        action.extraMetadata !== undefined,
      {
        message: 'skills.update_custom requires at least one update field.',
      },
    ),
  z.object({
    type: z.literal('skills.delete_custom'),
    name: z.string(),
  }),
  z.object({
    type: z.literal('skills.list_shared'),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
    createdBy: z.enum(['me', 'anyone']).optional(),
  }),
  z.object({
    type: z.literal('skills.read_shared'),
    skillId: z.string().min(1),
  }),
  z.object({
    type: z.literal('skills.share_custom'),
    name: z.string().min(1),
    shareScope: z.enum(['team', 'organization']),
    teamId: z.string().optional(),
    organizationId: z
      .string()
      .optional()
      .describe(
        'Organization id for organization scope; omit to use the organization selected in the sidebar context switcher.',
      ),
  }),
  z.object({
    type: z.literal('skills.import_shared'),
    skillId: z.string().min(1),
  }),
  z.object({
    type: z.literal('skills.update_shared'),
    skillId: z.string().min(1),
    name: z.string().min(1),
  }),
  z.object({
    type: z.literal('skills.delete_shared'),
    skillId: z.string().min(1),
  }),
  z.object({ type: z.literal('plugins.open_mcp_browse') }),
  z.object({
    type: z.literal('plugins.open_management'),
    section: z.enum(PLUGINS_MANAGEMENT_SECTIONS).optional(),
  }),
  z.object({
    type: z.literal('plugins.open_entry_detail'),
    entryId: z.string().min(1),
  }),
  z.object({ type: z.literal('org_project.list') }),
  z.object({
    type: z.literal('org_project.setup_start'),
    projectId: z.string().min(1),
  }),
  z.object({
    type: z.literal('org_project.setup_cancel'),
    projectId: z.string().min(1),
  }),
  z.object({
    type: z.literal('org_project.open_move_to_organization'),
    workspaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal('org_project.create_cowork'),
    name: z.string().trim().min(1).max(ORG_PROJECT_LIMITS.nameLength),
  }),
  z.object({
    type: z.literal('org_project.create_code'),
    name: z.string().trim().min(1).max(ORG_PROJECT_LIMITS.nameLength),
    folderPath: z.string().trim().min(1).optional(),
  }),
  z.object({ type: z.literal('workspace.list') }),
  z.object({
    type: z.literal('workspace.create_multi_repo'),
    name: z.string().trim().min(1).max(ORG_PROJECT_LIMITS.nameLength),
  }),
  z.object({
    type: z.literal('workspace.add_repo'),
    workspaceId: z
      .string()
      .refine(
        (value): boolean => value.trim().length > 0,
        'workspaceId must not be blank.',
      ),
    // Preserve spaces in local paths; filesystem validation remains main-owned.
    repoPath: z
      .string()
      .refine(
        (value): boolean => isAbsolute(value),
        'repoPath must be an absolute local path.',
      ),
  }),
  z.object({
    type: z.literal('workspace.remove_repo'),
    workspaceId: z
      .string()
      .refine(
        (value): boolean => value.trim().length > 0,
        'workspaceId must not be blank.',
      ),
    repoId: z
      .string()
      .refine(
        (value): boolean => value.trim().length > 0,
        'repoId must not be blank.',
      ),
  }),
  z
    .object({
      type: z.literal('workspace.find_repository_owner'),
      path: z
        .string()
        .max(MAX_REPOSITORY_OWNER_PATH_LENGTH)
        .refine(
          (value): boolean => isAbsolute(value),
          'path must be an absolute folder path.',
        )
        .optional(),
      remoteUrl: z
        .string()
        .max(ORG_REPOSITORY_OWNER_URL_MAX_LENGTH)
        .refine(
          (value): boolean => value.trim().length > 0,
          'remoteUrl must not be blank.',
        )
        .optional(),
    })
    .strict()
    .refine(
      hasOneRepositoryOwnerKey,
      'Supply exactly one of path or remoteUrl.',
    ),
  z.object({ type: z.literal('workspace.open_add_dialog') }),
  z.object({ type: z.literal('workspace.open_clone_progress') }),
  z.object({
    type: z.literal('workspace.add_org_project'),
    projectId: z.string().min(1),
  }),
  z.object({
    type: z.literal('workspace.list_worktrees'),
    workspaceId: z.string(),
  }),
  z.object({
    type: z.literal('workspace.list_join_options'),
    sourceWorkspaceId: z.string(),
    sourceWorktreeId: z.string(),
  }),
  z.object({
    type: z.literal('workspace.list_existing_worktree_join_options'),
    sourceWorkspaceId: z.string(),
    sourceWorktreeId: z.string(),
  }),
  z.object({
    type: z.literal('worktree.select'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('worktree.archive'),
    projectId: z.string(),
    worktreeId: z.string(),
    deleteBranch: z.boolean(),
    mode: z.enum(['delete', 'archive']).optional(),
  }),
  z
    .object({
      type: z.literal('worktree.create'),
      workspaceId: z.string(),
      baseWorktreeId: z.string().trim().min(1).optional(),
      baseBranch: optionalBaseBranchSchema,
      select: z.boolean().optional(),
    })
    .refine(
      (action) =>
        action.baseWorktreeId === undefined || action.baseBranch === undefined,
      {
        message: 'baseWorktreeId and baseBranch are mutually exclusive.',
        path: ['baseBranch'],
      },
    ),
  z.object({
    type: z.literal('worktree.resolve_branch_from_confirmation'),
    confirmationId: z.string(),
    projectId: z.string(),
    worktreeId: z.string(),
    choice: z.enum(['commit-first', 'do-not-commit', 'cancel']),
  }),
  z.object({
    type: z.literal('worktree.create_from_link'),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine((url) => {
        if (!/^https?:\/\//i.test(url)) return false;
        const parsed = extractCreateFromReferences(url);
        return parsed.complete && parsed.references.length === 1;
      }, 'Use a supported GitHub or Linear link.'),
    prompt: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree.create_from'),
    workspaceId: z.string(),
    source: z.enum(['branch', 'pr', 'linear']),
    reference: z.string(),
    baseBranch: optionalBaseBranchSchema,
    select: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('worktree.set_notification_level'),
    projectId: z.string(),
    worktreeId: z.string(),
    level: z.enum(['all', 'attention', 'mute']),
  }),
  z
    .object({
      type: z.literal('worktree.set_base_branch'),
      projectId: z.string(),
      worktreeId: z.string(),
      repoId: z.string().optional(),
      baseBranch: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('worktree.add_workspace'),
      sourceWorkspaceId: z.string(),
      sourceWorktreeId: z.string(),
      joinWorkspaceId: z.string().optional(),
      joinWorkspaceIds: z.array(z.string()).optional(),
      mode: adhocMultiRepoModeSchema.optional(),
      select: z.boolean().optional(),
    })
    .refine(
      (action) =>
        action.joinWorkspaceId !== undefined ||
        (action.joinWorkspaceIds?.length ?? 0) > 0,
      {
        message: 'Provide joinWorkspaceId or joinWorkspaceIds.',
        path: ['joinWorkspaceId'],
      },
    ),
  z.object({
    type: z.literal('worktree.add_existing_worktree'),
    sourceWorkspaceId: z.string(),
    sourceWorktreeId: z.string(),
    joinWorkspaceId: z.string(),
    joinWorktreeId: z.string(),
    mode: adhocMultiRepoModeSchema.optional(),
    select: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('worktree.split_temporary_workspace'),
    workspaceId: z.string(),
    worktreeId: z.string(),
    selections: z.record(z.string(), z.enum(['split', 'remove'])).optional(),
    rootAction: z.enum(['archive', 'delete']),
  }),
  z.object({
    type: z.literal('worktree.get_settings'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('worktree.list_scripts'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('worktree.run_script'),
    projectId: z.string(),
    worktreeId: z.string(),
    scriptId: z.string().min(1),
    repo: z.string().min(1).optional(),
    waitSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_SCRIPT_WAIT_SECONDS)
      .optional(),
  }),
  z.object({
    type: z.literal('worktree.update_settings'),
    projectId: z.string(),
    worktreeId: z.string(),
    hidden: z.boolean().optional(),
    pausedHookKeys: z.array(z.string()).optional(),
    branchGroupingOverride: z.enum(['group', 'ungroup']).nullable().optional(),
  }),
  z.object({
    type: z.literal('hook.pause'),
    projectId: z.string(),
    worktreeId: z.string(),
    hookKey: z.string().optional(),
    all: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('hook.resume'),
    projectId: z.string(),
    worktreeId: z.string(),
    hookKey: z.string().optional(),
    all: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('worktree.list_git_actions'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('worktree.run_git_action'),
    projectId: z.string(),
    worktreeId: z.string(),
    action: worktreeGitActionSchema,
    repoIds: z.array(z.string()).optional(),
    ignoreUnresolvedCommentsWarning: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('worktree.cancel_git_action'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('worktree.start_merge_conflict_resolution'),
    projectId: z.string(),
    worktreeId: z.string(),
    repoId: z.string().optional(),
    repoName: z.string().optional(),
    branchName: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree.start_pr_comment_triage'),
    projectId: z.string(),
    worktreeId: z.string(),
    repoId: z.string().optional(),
    repoName: z.string().optional(),
    branchName: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree.start_ci_check_fix'),
    projectId: z.string(),
    worktreeId: z.string(),
    repoId: z.string().optional(),
    repoName: z.string().optional(),
    branchName: z.string().optional(),
  }),
  z.object({
    type: z.literal('github.resolve_base_branch_alignment'),
    confirmationId: z.string(),
    projectId: z.string(),
    worktreeId: z.string(),
    choice: z.enum(['confirm', 'cancel']),
  }),
  z.object({
    type: z.literal('github.split_pr'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('code_review.open'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('runs.open_comments'),
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string(),
  }),
  z.object({
    type: z.literal('workspace.get_settings'),
    workspaceId: z.string(),
    worktreeId: z.string().optional(),
    includeClaudeMd: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('workspace.get_start_page'),
    workspaceId: z.string(),
    worktreeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('workspace.set_start_page'),
    workspaceId: z.string(),
    startPage: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('file'),
          repoId: z.string().optional(),
          path: z.string(),
        }),
        z.object({ kind: z.literal('url'), url: z.string() }),
      ])
      .nullable(),
  }),
  z.object({
    type: z.literal('workspace.read_readiness'),
    workspaceId: z.string(),
    worktreeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('workspace.start_readiness_fix'),
    workspaceId: z.string(),
    worktreeId: z.string().optional(),
    issueCode: z.enum([
      'configure-scripts',
      'configure-hooks',
      'configure-agent-instructions',
    ]),
    repoId: z.string().optional(),
  }),
  z.object({
    type: z.literal('workspace.update_local_settings'),
    workspaceId: z.string(),
    archiveRetentionDays: z
      .number()
      .int()
      .min(0)
      .max(MAX_ARCHIVE_RETENTION_DAYS)
      .nullable()
      .optional(),
    autoArchiveDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_ARCHIVE_RETENTION_DAYS)
      .nullable()
      .optional(),
    autoArchiveDeleteBranch: z.boolean().optional(),
    defaultPluginSelections: pluginSelectionsSchema.optional(),
    alwaysShow: z.boolean().optional(),
    scripts: scriptOverridesSchema.optional(),
    hooks: hookOverridesSchema.optional(),
    repoScripts: z.array(repoScriptChangeSchema).optional(),
    repoHooks: z.array(repoHookChangeSchema).optional(),
  }),
  z.object({
    type: z.literal('workspace.apply_source_edits'),
    workspaceId: z.string(),
    worktreeId: z.string().optional(),
    createWorktree: z.boolean().optional(),
    claudeMd: z.string().optional(),
    scripts: scriptOverridesSchema.optional(),
    hooks: hookOverridesSchema.optional(),
    plugins: z.array(z.any()).optional(),
    repoScriptChanges: z.array(repoScriptChangeSchema).optional(),
    repoHookChanges: z.array(repoHookChangeSchema).optional(),
    repoAdds: z.array(sourceRepoAddSchema).optional(),
    repoRemovals: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('workspace.promote_temporary'),
    workspaceId: z.string(),
    name: z.string(),
  }),
  z.object({
    type: z.literal('chat.open_import_session_modal'),
    workspaceId: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.open_tab'),
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string().optional(),
    initialMessage: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.list_tabs'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.list_background_processes'),
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.stop_background_process'),
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string(),
    taskId: z.string(),
  }),
  z.object({
    type: z.literal('delegation.tree'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    type: z.literal('delegation.roots'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
  }),
  z.object({
    type: z.literal('delegation.transcript'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    chatId: z.string().min(1),
    delegationId: z.string().min(1),
    beforeSequence: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
    runGeneration: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  }),
  z.object({
    type: z.literal('delegation.worktree_summary'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    delegationId: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  }),
  z.object({
    type: z.literal('delegation.stop'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    chatId: z.string().min(1),
    delegationId: z.string().min(1),
  }),
  z.object({
    type: z.literal('delegation.stop_all'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    type: z.literal('delegation.read_changes'),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    delegationId: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  }),
  z.object({
    type: z.literal('worktree-chat.retry_state_refresh'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('worktree-chat.dismiss_state_notice'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('worktree-chat.open_archives'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.switch_tab'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    tabId: z.string(),
  }),
  z.object({
    type: z.literal('worktree-chat.run_chat_action'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    action: worktreeChatActionSchema,
  }),
  z.object({
    type: z.literal('worktree-chat.send_message'),
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string(),
    text: z.string(),
    queueForSetup: z.boolean().optional(),
    watchers: z.array(inlineWatcherSetupSchema).max(10).optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.steer_queued_message'),
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string(),
    queuedMessageId: z.string(),
  }),
  z.object({
    type: z.literal('worktree-chat.schedule_message'),
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string(),
    text: z.string(),
    runAt: z.string(),
    timezone: z.literal('local').optional(),
    name: z.string().optional(),
    fileReferences: z.array(z.any()).optional(),
    attachmentPaths: z.array(z.string()).optional(),
    attachmentPromptContexts: z.array(z.any()).optional(),
    inputMode: z.enum(['typed', 'voice']).optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.get_last_user_message'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.get_last_agent_response'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.read_history'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.set_plan_mode'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('worktree-chat.set_fast_mode'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('worktree-chat.set_speed'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    speed: z.enum(CODEX_SPEEDS),
  }),
  z.object({
    type: z.literal('home.set_execution_harness'),
    executionHarness: z.enum(['claude', 'codex']),
  }),
  z.object({
    type: z.literal('worktree-chat.set_model'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    model: z.string(),
    executionHarness: z.enum(['claude', 'codex']).optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.set_thinking_level'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    level: thinkingLevelSchema,
  }),
  z.object({
    type: z.literal('worktree-chat.list_plugins'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    query: z.string().optional(),
    kind: pluginKindSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('worktree-chat.update_plugin_selection'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    kind: pluginKindSchema,
    key: z.string(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('worktree-chat.set_plugin_selections'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    chatId: z.string().optional(),
    selections: pluginSelectionsSchema,
  }),
  z.object({
    type: z.literal('tracked-plan.list'),
    projectId: z.string(),
    worktreeId: z.string(),
    query: z.string().optional(),
    reviewStatus: trackedPlanReviewStatusSchema.optional(),
    includeHidden: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('tracked-plan.import'),
    projectId: z.string(),
    worktreeId: z.string(),
    filePath: z.string(),
    repoId: z.string(),
  }),
  z.object({
    type: z.literal('tracked-plan.get'),
    projectId: z.string(),
    worktreeId: z.string(),
    planId: z.string(),
    includeContent: z.boolean().optional(),
    maxContentChars: z.number().int().min(1).max(100_000).optional(),
  }),
  z.object({
    type: z.literal('tracked-plan.open_explore'),
    projectId: z.string(),
    worktreeId: z.string(),
    planId: z.string(),
  }),
  z.object({
    type: z.literal('tracked-plan.list_comment_threads'),
    projectId: z.string(),
    worktreeId: z.string(),
    planId: z.string(),
    status: planCommentThreadStatusSchema.optional(),
    anchorState: planCommentAnchorStateSchema.optional(),
    staged: z.boolean().optional(),
    query: z.string().optional(),
    includeComments: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('tracked-plan.get_comment_thread'),
    projectId: z.string(),
    worktreeId: z.string(),
    planId: z.string(),
    threadId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.list_tabs'),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.create_tab'),
    initialMessage: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.switch_tab'),
    tabId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.get_last_user_message'),
    chatId: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.get_last_agent_response'),
    chatId: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.read_history'),
    chatId: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.send_message'),
    chatId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.set_model'),
    chatId: z.string().optional(),
    model: z.string(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.set_thinking_level'),
    chatId: z.string().optional(),
    level: thinkingLevelSchema,
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.list_plugins'),
    chatId: z.string().optional(),
    query: z.string().optional(),
    kind: pluginKindSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.update_plugin_selection'),
    chatId: z.string().optional(),
    kind: pluginKindSchema,
    key: z.string(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('pipeline-assistant-chat.set_plugin_selections'),
    chatId: z.string().optional(),
    selections: pluginSelectionsSchema,
  }),
  z.object({
    type: z.literal('standalone-chat.list_projects'),
    query: z.string().optional(),
    includeDefault: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('standalone-chat.list_chats'),
    projectId: z.string().optional(),
    query: z.string().optional(),
    includeArchived: z.boolean().optional(),
    providerType: z.enum(['claude', 'codex', 'ollama']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('standalone-chat.switch_project'),
    projectId: z.string(),
  }),
  z.object({
    type: z.literal('standalone-chat.switch_chat'),
    projectId: z.string().optional(),
    chatId: z.string(),
  }),
  z.object({
    type: z.literal('standalone-chat.create_chat'),
    projectId: z.string(),
  }),
  z.object({
    type: z.literal('advisor-chat.create_entry'),
    title: z.string().max(200).optional(),
    text: advisorChatTextSchema,
  }),
  z.object({
    type: z.literal('advisor-chat.create_chat'),
    workEntryId: z.string().min(1),
    text: advisorChatTextSchema,
  }),
  z.object({
    type: z.literal('advisor-chat.send_message'),
    workEntryId: z.string().min(1).optional(),
    chatId: z.string().min(1),
    text: advisorChatTextSchema,
  }),
  z.object({
    type: z.literal('standalone-chat.rename_work_entry'),
    projectId: z.string(),
    workEntryId: z.string(),
    title: z.string().nullable(),
  }),
  z.object({
    type: z.literal('standalone-chat.delete_work_entry'),
    projectId: z.string(),
    workEntryId: z.string(),
  }),
  z.object({
    type: z.literal('standalone-chat.send_message'),
    projectId: z.string(),
    chatId: z.string(),
    text: z.string(),
    watchers: z.array(inlineWatcherSetupSchema).max(10).optional(),
  }),
  z.object({
    type: z.literal('standalone-chat.get_last_user_message'),
    projectId: z.string(),
    chatId: z.string(),
  }),
  z.object({
    type: z.literal('standalone-chat.get_last_agent_response'),
    projectId: z.string(),
    chatId: z.string(),
  }),
  z.object({
    type: z.literal('standalone-chat.read_history'),
    projectId: z.string(),
    chatId: z.string(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    type: z.literal('standalone-chat.set_model'),
    projectId: z.string(),
    chatId: z.string(),
    model: z.string(),
  }),
  z.object({
    type: z.literal('standalone-chat.set_thinking_level'),
    projectId: z.string(),
    chatId: z.string(),
    level: thinkingLevelSchema,
  }),
  z.object({
    type: z.literal('standalone-chat.list_plugins'),
    projectId: z.string().optional(),
    chatId: z.string().optional(),
    query: z.string().optional(),
    kind: pluginKindSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('standalone-chat.update_plugin_selection'),
    projectId: z.string(),
    chatId: z.string(),
    kind: pluginKindSchema,
    key: z.string(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('standalone-chat.set_plugin_selections'),
    projectId: z.string(),
    chatId: z.string(),
    selections: pluginSelectionsSchema,
  }),
  z.object({
    type: z.literal('standalone-chat.list_prompts'),
    projectId: z.string(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('standalone-chat.get_prompt'),
    projectId: z.string(),
    promptId: z.string(),
  }),
  z.object({
    type: z.literal('standalone-chat.list_notes'),
    projectId: z.string(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('standalone-chat.get_note'),
    projectId: z.string(),
    noteId: z.string(),
  }),
  z.object({
    type: z.literal('standalone-chat.list_attachments'),
    projectId: z.string(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('standalone-chat.get_attachment'),
    projectId: z.string(),
    attachmentId: z.string(),
    includeContent: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('standalone-chat.get_settings'),
    projectId: z.string(),
    includeClaudeMd: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('archived.list'),
    workspaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal('archived.open_overview'),
    workspaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal('archived.open_empty_trash'),
    workspaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal('archived.open'),
    workspaceId: z.string().min(1),
    containerId: z.string().min(1),
    tab: z
      .enum(['changes', 'chats', 'pipelines', 'attachments', 'plans'])
      .optional(),
    chatId: z.string().min(1).optional(),
    planId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('archived.read_chat'),
    workspaceId: z.string().min(1),
    containerId: z.string().min(1),
    chatId: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    type: z.literal('archived.restore'),
    workspaceId: z.string().min(1),
    containerId: z.string().min(1),
  }),
  z.object({
    type: z.literal('archived.set_locked'),
    workspaceId: z.string().min(1),
    containerId: z.string().min(1),
    locked: z.boolean(),
  }),
  z.object({
    type: z.literal('standalone-chat.update_settings'),
    projectId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    color: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultPresetId: z.string().optional(),
    defaultPluginSelections: pluginSelectionsSchema.optional(),
    presets: z.array(z.any()).optional(),
    archiveRetentionDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_ARCHIVE_RETENTION_DAYS)
      .optional(),
    autoArchiveDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_ARCHIVE_RETENTION_DAYS)
      .nullable()
      .optional(),
    alwaysShow: z.boolean().optional(),
    claudeMd: z.string().optional(),
  }),
  z.object({
    type: z.literal('environment.update_workspace_assignment'),
    workspaceId: z.string(),
    runtimes: z.strictObject({
      canopy: z.string().nullable().optional(),
      agent: z.string().nullable().optional(),
      pipeline: z.string().nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal('pipeline.open_editor'),
    pipelineId: z.string().optional(),
    cwd: z.string().optional(),
    filePath: z.string().optional(),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    repoId: z.string().optional(),
    sharedRemoteId: z.string().optional(),
    section: z.enum(WORKFLOW_EDIT_SECTIONS).optional(),
  }),
  z.object({
    type: z.literal('pipeline.open_curated_preview'),
    key: z.string().min(1).max(64).refine(isCuratedCatalogKey),
  }),
  z.object({
    type: z.literal('pipeline.create'),
    rawYaml: z.string().optional(),
    yamlFilePath: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
  }),
  z.object({ type: z.literal('pipeline.save') }),
  z.object({
    type: z.literal('pipeline.update'),
    pipelineId: z.string(),
    rawYaml: z.string().optional(),
    yamlFilePath: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.delete'),
    pipelineId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.duplicate'),
    pipelineId: z.string(),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.share'),
    pipelineId: z.string(),
    shareScope: pipelineShareScopeSchema,
    teamId: z.string().optional(),
    organizationId: z
      .string()
      .optional()
      .describe(
        'Organization id for organization scope; omit to use the organization selected in the sidebar context switcher.',
      ),
    deleteLocal: z
      .boolean()
      .optional()
      .describe(
        'Deprecated and ignored. Sharing keeps the local pipeline; use pipeline.delete.',
      ),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('plan.share'),
    projectId: z.string(),
    worktreeId: z.string(),
    planId: z.string(),
    shareScope: pipelineShareScopeSchema,
    teamId: z.string().optional(),
    organizationId: z
      .string()
      .optional()
      .describe(
        'Organization id for organization scope; omit to use the organization selected in the sidebar context switcher.',
      ),
  }),
  z.object({
    type: z.literal('plan.unshare'),
    projectId: z.string(),
    worktreeId: z.string(),
    planId: z.string(),
  }),
  z.object({
    type: z.literal('runs.share'),
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string(),
    shareScope: z.enum(['team', 'organization']),
    teamId: z.string().optional(),
    organizationId: z
      .string()
      .optional()
      .describe(
        'Organization id for organization scope; omit to use the organization selected in the sidebar context switcher.',
      ),
  }),
  z.object({
    type: z.literal('runs.unshare'),
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string(),
  }),
  z.object({
    type: z.literal('shared-containers.open_invite'),
    projectId: z.string(),
    worktreeId: z.string(),
    containerType: z.enum(['CODE_WORKTREE', 'COWORK_WORK_ENTRY']),
    audience: z.enum(['team', 'organization', 'public']).optional(),
  }),
  z.object({
    type: z.literal('shared-containers.revoke_recipient'),
    containerId: z.string(),
    recipientId: z.string(),
    organizationId: z.string().optional(),
  }),
  z.object({
    type: z.literal('shared-containers.open_received'),
    containerId: z.string(),
    organizationId: z.string().optional(),
  }),
  z.object({
    type: z.literal('shared-containers.retry_received'),
    containerId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.update_shared'),
    pipelineId: z.string().optional(),
    remoteId: z.string().optional(),
    rawYaml: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.delete_shared'),
    pipelineId: z.string().optional(),
    remoteId: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.list'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    query: z.string().optional(),
    runModes: z.array(pipelineRunModeSchema).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.get'),
    pipelineId: z.string(),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    includeYaml: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('pipeline.open_run'),
    executionId: z.string(),
    jobId: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.debug_run'),
    executionId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_list_for_worktree'),
    projectId: z.string(),
    worktreeId: z.string(),
    query: z.string().optional(),
    pipelineId: z.string().optional(),
    status: pipelineExecutionStatusSchema.optional(),
    limit: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_list'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    query: z.string().optional(),
    pipelineId: z.string().optional(),
    status: pipelineExecutionStatusSchema.optional(),
    limit: z.number().int().min(1).optional(),
    runOn: z.enum(['local', 'cloud']).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_get'),
    executionId: z.string(),
    includeReport: z.boolean().optional(),
    includePlan: z.boolean().optional(),
    maxChars: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_cancel'),
    executionId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_retry_matrix_job'),
    executionId: pipelineExecutionIdSchema,
    jobId: z.string().min(1),
    mode: z.enum(['all', 'failed', 'variants', 'expansion']),
    variantJobIds: z.array(z.string().min(1)).min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_cancel_matrix_variant'),
    executionId: pipelineExecutionIdSchema,
    jobId: z.string().min(1),
    variantJobId: z.string().min(1),
  }),
  z.object({
    type: z.literal('pipeline.execution_resume'),
    executionId: pipelineExecutionIdSchema,
    statusReasonIds: z.array(z.string().uuid()).min(1).optional(),
    pauseResponses: z
      .array(
        z.object({
          checkpointId: z.string().min(1),
          jobId: pipelineRuntimeIdentifierSchema,
          stepId: pipelineRuntimeIdentifierSchema,
          answers: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional(),
        }),
      )
      .min(1)
      .optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_retry'),
    executionId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_start_over'),
    executionId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_read_report'),
    executionId: z.string(),
    kind: z.enum(['text', 'json']).optional(),
    maxChars: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_read_plan'),
    executionId: z.string(),
    maxChars: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_send_report_to_chat'),
    executionId: z.string(),
    chatId: z.string().optional(),
    prompt: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_send_plan_to_chat'),
    executionId: z.string(),
    chatId: z.string().optional(),
    prompt: z.string().optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_chain'),
    executionId: z.string(),
    pipelineId: z.string(),
    inputs: z.record(z.string(), z.string()).optional(),
    repoId: z.string().optional(),
  }),
  ...createAdvisorBrowserActionSchemas(browserScopeShape),
  z.object({
    type: z.literal('file.open'),
    projectId: z.string(),
    worktreeId: z.string(),
    path: z.string(),
    repoId: z.string().optional(),
  }),
  z.object({ type: z.literal('file.send_selection_to_chat') }),
  z.object({ type: z.literal('file.save_active') }),
  z.object({
    type: z.enum([
      'mcp.account_connect',
      'mcp.account_reconnect',
      'mcp.account_disconnect',
      'mcp.account_promote',
      'mcp.account_edit',
    ]),
    serverId: z.string().min(1).max(256),
  }),
  z.object({ type: z.literal('file.preview_search_open') }),
  z.object({ type: z.literal('file.preview_search_close') }),
  z.object({
    type: z.literal('terminal.open'),
    projectId: z.string(),
    worktreeId: z.string(),
  }),
  z.object({
    type: z.literal('terminal.close'),
    sessionId: z.string().optional(),
  }),
  z.object({
    type: z.literal('panel.split'),
    groupId: z.string().optional(),
    direction: z.enum(['up', 'down', 'left', 'right']),
  }),
  z.object({
    type: z.literal('panel.set_layout_mode'),
    mode: z.enum(['minimal', 'advanced']),
  }),
  z.object({
    type: z.literal('panel.focus'),
    groupId: z.string(),
  }),
  z.object({
    type: z.literal('panel.close'),
    groupId: z.string().optional(),
  }),
  z.object({
    type: z.literal('panel.maximize'),
    groupId: z.string().optional(),
    maximized: z.boolean(),
  }),
  z.object({
    type: z.literal('panel.reset_layout'),
  }),
  z.object({
    type: z.literal('ledger.open'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    entryId: z.string().optional(),
  }),
  z.object({
    type: z.literal('ledger.search'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    query: z.string().optional(),
    types: z
      .array(z.enum(['TASK', 'ACTION', 'DECISION', 'OBSERVATION', 'SUMMARY']))
      .optional(),
    statuses: z
      .array(
        z.enum([
          'TODO',
          'IN_PROGRESS',
          'COMPLETED',
          'FAILED',
          'BLOCKED',
          'NEEDS_REVIEW',
          'INFO',
        ]),
      )
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    type: z.literal('ledger.add_entry'),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    entryType: z.enum(['TASK', 'ACTION', 'DECISION', 'OBSERVATION']),
    title: z.string().min(1),
    content: z.string().min(1),
    highlights: z.array(z.string()).max(5).optional(),
    status: z
      .enum([
        'TODO',
        'IN_PROGRESS',
        'COMPLETED',
        'FAILED',
        'BLOCKED',
        'NEEDS_REVIEW',
        'INFO',
      ])
      .optional(),
    supersedesEntryId: z.string().optional(),
  }),
  z.object({
    type: z.literal('panel.move'),
    panelId: z.string(),
    targetGroupId: z.string(),
    edge: z.enum(['top', 'bottom', 'left', 'right', 'center']),
  }),
  z.object({
    type: z.literal('panel.arrange'),
    arrangement: z.literal('even'),
  }),
  z.object({
    type: z.literal('panel.save_default_layout'),
  }),
  z.object({ type: z.literal('canopy_cloud.load_account') }),
  z.object({
    type: z.literal('canopy_cloud.validate_api_key'),
    apiKey: z.string().optional(),
  }),
  z.object({
    type: z.literal('canopy_cloud.save_api_key'),
    apiKey: z.string(),
  }),
  z.object({ type: z.literal('canopy_cloud.clear_api_key') }),
  z.object({ type: z.literal('canopy_cloud.start_oauth_login') }),
  z.object({ type: z.literal('canopy_cloud.cancel_oauth_login') }),
  z.object({ type: z.literal('canopy_cloud.disconnect') }),
  z.object({ type: z.literal('canopy_portal.open') }),
  z.object({ type: z.literal('canopy_portal.close') }),
  z.object({ type: z.literal('canopy_portal.start') }),
  z.object({ type: z.literal('canopy_portal.stop') }),
  z.object({ type: z.literal('canopy_portal.open_account_settings') }),
  z.object({ type: z.literal('app_advisor.open') }),
  z.object({ type: z.literal('app_advisor.close') }),
  z.object({ type: z.literal('app_advisor.toggle') }),
  z.object({
    type: z.literal('app_advisor.update_settings'),
    archiveRetentionDays: z
      .number()
      .int()
      .min(0)
      .max(MAX_ARCHIVE_RETENTION_DAYS)
      .nullable()
      .optional(),
    autoArchiveDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_ARCHIVE_RETENTION_DAYS)
      .nullable()
      .optional(),
  }),
  z.object({ type: z.literal('watcher.list') }),
  z.object({ type: z.literal('watcher.get'), id: z.string() }),
  z.object({
    type: z.literal('watcher.delete'),
    id: z.string(),
    notifySubscriber: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('automation.open_editor'),
    id: z.string().min(1),
    section: z.enum(WORKFLOW_EDIT_SECTIONS).optional(),
    runId: z.string().min(1).max(512).optional(),
  }),
  z.object({
    type: z.literal('automation.open_shared_pipeline_review'),
    id: z.string().min(1),
  }),
  z.object({
    type: z.literal('automation.list'),
    includeRuns: z.boolean().optional(),
  }),
  z.object({ type: z.literal('automation.get'), id: z.string() }),
  z.object({
    type: z.literal('automation.create'),
    input: z.custom<AutomationCreateRequest>(
      (value) => typeof value === 'object' && value !== null,
    ),
    watchers: z.array(automationInlineWatcherSetupSchema).max(10).optional(),
  }),
  z.object({
    type: z.literal('automation.update'),
    id: z.string(),
    patch: z.custom<Omit<AutomationUpdateRequest, 'id'>>(
      (value) => typeof value === 'object' && value !== null,
    ),
  }),
  z.object({ type: z.literal('automation.disable'), id: z.string() }),
  z.object({ type: z.literal('automation.delete'), id: z.string() }),
  z.object({
    type: z.literal('automation.run_now'),
    id: z.string(),
    watchers: z.array(automationInlineWatcherSetupSchema).max(10).optional(),
  }),
  z.object({
    type: z.literal('automation.share'),
    id: z.string().min(1),
    // A first share requires an explicit audience in the renderer after the
    // activity is loaded. Re-shares may omit it to preserve current ownership.
    shareScope: z.enum(['team', 'organization']).optional(),
    teamId: z.string().optional(),
    organizationId: z
      .string()
      .optional()
      .describe(
        'Organization id for organization scope; omit to use the organization selected in the sidebar context switcher.',
      ),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('automation.list_shared'),
    query: z.string().optional(),
    // Mirrors the server contract (1..MAX_LIMIT=100); out-of-range values
    // would otherwise reach the service as guaranteed 400s.
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    createdBy: z.enum(['me', 'anyone']).optional(),
  }),
  z.object({
    type: z.literal('automation.read_shared'),
    automationId: z.string().min(1),
  }),
  z.object({
    type: z.literal('automation.unshare'),
    automationId: z.string().min(1),
  }),
]);

export const appAdvisorActionSchema = z
  .union([nonPanelAppAdvisorActionSchema, panelAddTabActionSchema])
  .superRefine((action, context) => {
    addAdvisorBrowserActionIssues(action, context);
    if (
      action.type === 'pipeline.execution_resume' &&
      action.statusReasonIds === undefined &&
      action.pauseResponses === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'pipeline.execution_resume requires statusReasonIds or pauseResponses from the observed pause.',
      });
    }
  })
  .transform((action): AppAdvisorAction => {
    if (
      action.type === 'browser.hover' ||
      action.type === 'browser.scroll' ||
      action.type === 'browser.drag'
    )
      return projectBrowserPointerViewportAction(action);
    if (
      action.type === 'browser.set_checked' ||
      action.type === 'browser.select_option' ||
      action.type === 'browser.type' ||
      action.type === 'browser.upload_files' ||
      action.type === 'browser.request_files' ||
      action.type === 'browser.drop_files'
    )
      return projectBrowserControlAction(action);
    if (action.type === 'navigation.go_to_page') {
      const { page, ...rest } = action;
      return {
        ...rest,
        page:
          page === GO_TO_PAGE_LEGACY_TAB_ALIAS && rest.tab !== undefined
            ? 'automations'
            : page,
      };
    }
    if (action.type === 'sidebar.item_groups.set_item') {
      const target = {
        type: action.type,
        scope: action.scope,
        itemId: action.itemId,
      };
      if (action.newGroup !== undefined)
        return { ...target, newGroup: action.newGroup };
      if (action.groupId !== undefined)
        return { ...target, groupId: action.groupId };
      throw new Error('Group assignment destination is missing.');
    }
    // Runtime validation rejects conflicting anchors; project the resulting
    // position into the portable mutually exclusive position contract.
    if (action.type === 'sidebar.item_groups.move_item')
      return {
        type: action.type,
        scope: action.scope,
        itemId: action.itemId,
        groupId: action.groupId,
        ...(action.before
          ? { before: action.before }
          : action.after
            ? { after: action.after }
            : {}),
      };
    if (action.type === 'sidebar.item_groups.move_group')
      return {
        type: action.type,
        scope: action.scope,
        groupId: action.groupId,
        ...(action.before
          ? { before: action.before }
          : action.after
            ? { after: action.after }
            : {}),
      };
    // Runtime validation leaves exactly one key; project it alone into the
    // portable request. The URL is forwarded verbatim, as the IPC does.
    if (action.type === 'workspace.find_repository_owner') {
      if (action.path !== undefined)
        return { type: action.type, path: action.path };
      if (action.remoteUrl !== undefined)
        return { type: action.type, remoteUrl: action.remoteUrl };
      throw new Error('Repository owner request is missing its key.');
    }
    return action;
  }) satisfies z.ZodType<AppAdvisorAction>;

const appAdvisorDispatchPayloadSchema: z.ZodType<
  | AppAdvisorDispatchAction
  | InstalledItemAction
  | ExperimentAction
  | SettingsAction
  | AiGatewayAction
  | AppAdvisorPipelineRunAction
> = z.union([
  appAdvisorActionSchema,
  transcriptReadActionSchema,
  chatHistoryActionSchema,
  installedItemActionSchema,
  experimentActionSchema,
  settingsActionSchema,
  aiGatewayActionSchema,
  appAdvisorPipelineRunActionSchema,
]);

export const dispatchActionSchema = z.object({
  requestId: z.string().optional(),
  expectedUiRevision: z.number().int().nonnegative().optional(),
  action: appAdvisorDispatchPayloadSchema,
});

// Preserve every payload field for the authoritative runtime union in the executor.
export const dispatchActionToolSchema = z.object({
  expectedUiRevision: dispatchActionSchema.shape.expectedUiRevision,
  action: z
    .object({ type: z.string().describe(providerActionTypeDescription) })
    .passthrough(),
});

export const getPipelineDebugContextSchema = z.object({
  executionId: z.string(),
});

export const appAdvisorGetScriptOutputSchema = getScriptOutputSchema.extend({
  projectId: z.string().optional(),
  worktreeId: z.string().optional(),
});

export const appAdvisorReadPipelineYamlBaseSchema =
  readPipelineYamlBaseSchema.extend({
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
  });

export const appAdvisorReadPipelineYamlSchema =
  appAdvisorReadPipelineYamlBaseSchema.refine(
    (input) =>
      input.endLine === undefined ||
      input.startLine === undefined ||
      input.startLine <= input.endLine,
    { message: 'startLine must be less than or equal to endLine.' },
  );

export type AppAdvisorGetScriptOutputArgs = z.infer<
  typeof appAdvisorGetScriptOutputSchema
>;
export type AppAdvisorReadPipelineYamlArgs = z.infer<
  typeof appAdvisorReadPipelineYamlSchema
>;

export const getCurrentUiStateJsonSchema: JsonValue = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export const searchActionsJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Search terms such as "pipeline debug", "settings", "file save", or "terminal". Omit to list the first actions.',
    },
    category: {
      type: 'string',
      description:
        'Optional action category filter such as projects, bots, navigation, skills, sharing, workspace, worktree, worktree-chat, tracked-plan, pipeline-assistant-chat, standalone-chat, pipeline, file, terminal, panel, portal, app-advisor, watchers, or automations. Common singular aliases such as automation and watcher are accepted.',
    },
    actionType: {
      type: 'string',
      enum: [
        ...visibleAppAdvisorActionTypes,
        ...TRANSCRIPT_READ_ACTION_TYPES,
        ...CHAT_HISTORY_ACTION_TYPES,
        ...INSTALLED_ITEM_ACTION_TYPES,
        ...EXPERIMENT_ACTION_TYPES,
        ...SETTINGS_ACTION_TYPES,
        ...PIPELINES_ACTION_TYPES,
      ],
      description:
        'Optional exact action type to inspect, such as pipeline.debug_run.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum number of matching actions to return.',
    },
  },
  additionalProperties: false,
};

// The installed-item target applies to its own types only: transcript reads
// and file-tree actions carry other target shapes.
const {
  target: installedItemTargetJsonSchema,
  ...installedItemFieldJsonSchemas
} = installedItemDispatchJsonSchema.properties;
// Other App Advisor actions declare their own `scope` (memory, sidebar
// groups), so the pipelines family's global-only `scope` applies to
// pipeline.run alone instead of every action.
const { scope: pipelineRunScopeJsonSchema, ...pipelinesDispatchProperties } =
  pipelinesDispatchJsonSchema.properties;

export const dispatchActionJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    expectedUiRevision: {
      type: 'integer',
      minimum: 0,
      description:
        'Optional UI revision guard for action types that depend on current UI state. Omit for navigation, listing, and other revision-agnostic actions.',
    },
    action: {
      type: 'object',
      description:
        'One action payload. Use search_actions to discover the exact type and required fields.',
      required: ['type'],
      properties: {
        download: {
          ...browserDownloadWaitJsonSchema,
          description:
            'For browser.wait_for, wait for this download id, or the next download when omitted. Cannot be combined with another wait condition, state, or frame.',
        },
        ...installedItemFieldJsonSchemas,
        ...experimentDispatchJsonSchema.properties,
        ...settingsDispatchJsonSchema.properties,
        ...pipelinesDispatchProperties,
        ...scriptPreferencesDispatchJsonSchema.properties,
        type: {
          type: 'string',
          description: providerActionTypeDescription,
        },
      },
      // Shared fields stay inside their discriminator conditionals so they do
      // not constrain unrelated Advisor payloads that also use target/limit.
      allOf: [
        ...(transcriptReadDispatchJsonSchema.allOf ?? []),
        {
          if: {
            properties: { type: { enum: [...INSTALLED_ITEM_ACTION_TYPES] } },
            required: ['type'],
          },
          then: { properties: { target: installedItemTargetJsonSchema } },
        },
        ...browserWaitForJsonSchemaRules(),
        ...browserFrameJsonSchemaRules(),
        ...browserPointerViewportJsonSchemaRules('advisor'),
        ...browserTransferJsonSchemaRules(),
        ...(pipelineRunScopeJsonSchema === undefined
          ? []
          : [
              {
                if: {
                  properties: { type: { const: 'pipeline.run' } },
                  required: ['type'],
                },
                then: { properties: { scope: pipelineRunScopeJsonSchema } },
              },
            ]),
      ],
      additionalProperties: true,
    },
  },
  required: ['action'],
  additionalProperties: false,
};

export const getPipelineDebugContextJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    executionId: { type: 'string' },
  },
  required: ['executionId'],
  additionalProperties: false,
};

export const appAdvisorGetScriptOutputJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    ...jsonObjectProperties(getScriptOutputJsonSchema),
    projectId: {
      type: 'string',
      description: `Optional explicit ${appName} project/workspace id. Must be supplied together with worktreeId.`,
    },
    worktreeId: {
      type: 'string',
      description: `Optional explicit ${appName} worktree id. Must be supplied together with projectId.`,
    },
  },
  required: ['scriptId'],
  additionalProperties: false,
};

export const appAdvisorReadPipelineYamlJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    ...jsonObjectProperties(readPipelineYamlJsonSchema),
    projectId: {
      type: 'string',
      description: `Optional explicit ${appName} project/workspace id. Must be supplied together with worktreeId.`,
    },
    worktreeId: {
      type: 'string',
      description: `Optional explicit ${appName} worktree id. Must be supplied together with projectId.`,
    },
  },
  required: ['pipelineId'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// App Advisor watcher tool schemas (transport contracts only).
//
// The runtime-side wiring for `search_watchers` / `setup_watchers` lives in
// the App Advisor watcher service (see the watchers backend plan). The
// schemas below describe the model-facing inputs and exist alongside the
// rest of the App Advisor tool contracts so the registry compiles and the
// MCP / Codex tool definitions stay in lockstep.
//
// `setup_watchers` deliberately omits any `destinationChatId`,
// `chatId` (outside of `target.chatId`), `sessionKey`, or `requestId`
// surface: the destination is captured server-side by the App Advisor
// runtime so a model cannot smuggle a foreign session/chat id through this
// tool. Adding such a field here is a cannot-ship contract violation.
// ---------------------------------------------------------------------------

const watcherTriggerEnumSchema = z.enum([
  'worktree_chat_completion',
  'standalone_chat_completion',
  'worktree_new_chat_started',
  'standalone_new_chat_started',
  'worktree_pipeline_completion',
  'worktree_hook_triggered',
  'automation_run',
]);

const watcherSearchTriggerEnumSchema = z.enum([
  'project_task_chat_completion',
  'project_new_chat_started',
  'bot_task_chat_completion',
  'bot_new_chat_started',
  'worktree_chat_completion',
  'standalone_chat_completion',
  'worktree_new_chat_started',
  'standalone_new_chat_started',
  'worktree_pipeline_completion',
  'worktree_hook_triggered',
  'automation_run',
  'github_workflow_runs_changed',
  'github_pull_requests_changed',
  'scheduled_wakeup',
  'command_watch_resolved',
]);

const watcherWorktreeChatTargetSchema = z.object({
  kind: z.literal('worktree_chat'),
  projectId: z
    .string()
    .describe('Workspace/project id from the worktree chat.'),
  worktreeId: z.string().describe('Worktree id that owns the chat tab.'),
  chatId: z
    .string()
    .describe('Worktree chat tab id, not a title or session key.'),
});

const watcherStandaloneChatTargetSchema = z.object({
  kind: z.literal('standalone_chat'),
  projectId: z
    .string()
    .describe('Cowork project id, not the runtime standalone sentinel.'),
  chatId: z.string().describe('Cowork chat id, not a title or session key.'),
});

const watcherWorktreeChatScopeTargetSchema = z.object({
  kind: z.literal('worktree_chat_scope'),
  projectId: z
    .string()
    .describe('Workspace/project id for the watched worktree.'),
  worktreeId: z.string().describe('Worktree id whose new chats are watched.'),
});

const watcherStandaloneChatProjectTargetSchema = z.object({
  kind: z.literal('standalone_chat_project'),
  projectId: z
    .string()
    .describe(
      'Cowork project id whose new chats are watched, not the runtime standalone sentinel.',
    ),
});

const watcherWorktreePipelineTargetSchema = z.object({
  kind: z.literal('worktree_pipeline'),
  projectId: z.string().describe('Workspace/project id for the pipeline run.'),
  worktreeId: z.string().describe('Worktree id for the pipeline run.'),
  executionId: z
    .string()
    .optional()
    .describe('Optional non-terminal execution id for a one-shot watcher.'),
  pipelineId: z
    .string()
    .optional()
    .describe('Optional pipeline definition id.'),
  terminalStatuses: z
    .array(watcherPipelineTerminalStatusSchema)
    .optional()
    .describe(
      'Optional terminal statuses to consume on: success, failure, cancelled. Paused executions also notify without consuming the watcher.',
    ),
});

const hookScopeSchema = z.enum(['project', 'workspace-root', 'workspace-repo']);
const hookTriggerNameSchema = z.enum(SUPPORTED_HOOK_TRIGGERS);
const watcherWorktreeHookTargetSchema = z.object({
  kind: z.literal('worktree_hook'),
  projectId: z.string().describe('Workspace/project id for the worktree.'),
  worktreeId: z.string().describe('Worktree id whose hook trigger is watched.'),
  triggerName: hookTriggerNameSchema.describe('Supported hook trigger name.'),
  hookKey: z
    .string()
    .optional()
    .describe('Optional configured hook key to watch one hook entry.'),
  scope: hookScopeSchema
    .optional()
    .describe('Optional hook scope when hookKey is omitted.'),
  repoId: z
    .string()
    .optional()
    .describe('Repo id for workspace-repo hook targets.'),
});

const watcherAutomationTargetSchema = z.object({
  kind: z.literal('automation'),
  automationId: z
    .string()
    .describe(
      'Automation (scheduled activity) id from automation.list / automation.get.',
    ),
});

const watcherTargetSchema = z.discriminatedUnion('kind', [
  watcherWorktreeChatTargetSchema,
  watcherStandaloneChatTargetSchema,
  watcherWorktreeChatScopeTargetSchema,
  watcherStandaloneChatProjectTargetSchema,
  watcherWorktreePipelineTargetSchema,
  watcherWorktreeHookTargetSchema,
  watcherAutomationTargetSchema,
]);

export const searchWatchersSchema = z
  .object({
    query: z.string().optional(),
    trigger: watcherSearchTriggerEnumSchema.optional(),
    includeActive: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    detailLevel: z.enum(['minimal', 'standard']).optional(),
    activePageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_ACTIVE_WATCHER_PAGE_SIZE)
      .optional(),
    activeCursor: z.string().min(1).max(1024).optional(),
    activeQuery: z.string().max(MAX_ACTIVE_WATCHER_QUERY_LENGTH).optional(),
    targetProjectId: z.string().min(1).optional(),
    targetBotId: z.string().min(1).optional(),
    targetTaskId: z.string().min(1).optional(),
    targetChatId: z.string().min(1).optional(),
  })
  .refine(
    (input) =>
      input.targetProjectId === undefined || input.targetBotId === undefined,
    {
      message: 'targetProjectId and targetBotId cannot be combined.',
    },
  );

export const watchGitHubItemsSchema = sharedWatchGitHubItemsSchema;
export const watchGitHubItemsJsonSchema = sharedWatchGitHubItemsJsonSchema;
export const getGitHubPullRequestStatusSchema =
  sharedGetGitHubPullRequestStatusSchema;
export const getGitHubPullRequestStatusJsonSchema =
  sharedGetGitHubPullRequestStatusJsonSchema;

export const legacySetupWatcherEntrySchema = z.object({
  trigger: watcherTriggerEnumSchema,
  label: z.string().optional(),
  target: watcherTargetSchema,
  followUpInstruction: z.string().optional(),
  allowDuplicate: z.boolean().optional(),
  armForNextCompletion: z.boolean().optional(),
});

export const legacySetupWatchersSchema = z.object({
  watchers: z.array(legacySetupWatcherEntrySchema).min(1),
});
export const setupWatchersSchema = chatWatcherSetupSchema(
  legacySetupWatcherEntrySchema,
);
// SDK registration requires a raw object shape. Entries must reach the executor
// unchanged: typed/stripping entry schemas here would defeat raw strictness.
export const setupWatchersToolShape = {
  watchers: z.array(z.unknown()).min(1),
};

const watcherSearchTriggerDescription =
  'Optional exact trigger filter: project_task_chat_completion, project_new_chat_started, bot_task_chat_completion, bot_new_chat_started, worktree_pipeline_completion, worktree_hook_triggered, automation_run, github_workflow_runs_changed, github_pull_requests_changed, scheduled_wakeup, or command_watch_resolved.';
export const searchWatchersToolShape = {
  ...searchWatchersSchema.shape,
  trigger: z.string().describe(watcherSearchTriggerDescription).optional(),
};

export const searchWatchersJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Optional search terms scored against the catalog title, usage guidance, trigger key, and keywords.',
    },
    trigger: {
      type: 'string',
      description: watcherSearchTriggerDescription,
    },
    includeActive: {
      type: 'boolean',
      description:
        'When false, only the catalog is returned. Defaults to true so callers see currently active watchers.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Maximum number of catalog rows to return.',
    },
    activePageSize: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ACTIVE_WATCHER_PAGE_SIZE,
      description:
        'Instance page size (default 50), independent of catalog limit.',
    },
    activeCursor: {
      type: 'string',
      minLength: 1,
      maxLength: 1024,
      description:
        'Opaque activeNextCursor from a previous instance page with the same filters.',
    },
    activeQuery: {
      type: 'string',
      maxLength: MAX_ACTIVE_WATCHER_QUERY_LENGTH,
      description:
        'Search visible instance labels and target IDs, independently of catalog query.',
    },
    targetProjectId: {
      type: 'string',
      minLength: 1,
      description:
        'Filter instances by canonical project ID; cannot be combined with targetBotId.',
    },
    targetBotId: {
      type: 'string',
      minLength: 1,
      description:
        'Filter instances by canonical bot ID; cannot be combined with targetProjectId.',
    },
    targetTaskId: {
      type: 'string',
      minLength: 1,
      description: 'Filter instances by canonical task ID.',
    },
    targetChatId: {
      type: 'string',
      minLength: 1,
      description: 'Filter instances by canonical chat ID.',
    },
    detailLevel: {
      type: 'string',
      enum: ['minimal', 'standard'],
      description:
        'minimal (default) returns bounded rows; standard adds usage guidance and hook-trigger details.',
    },
  },
  not: { required: ['targetProjectId', 'targetBotId'] },
  additionalProperties: false,
};

const watcherTargetJsonSchema: JsonValue = {
  oneOf: [
    {
      type: 'object',
      description:
        'Compatibility completion target using workspace, worktree, and chat IDs.',
      required: ['kind', 'projectId', 'worktreeId', 'chatId'],
      properties: {
        kind: { type: 'string', enum: ['worktree_chat'] },
        projectId: {
          type: 'string',
          description: 'Compatibility workspace/project ID.',
        },
        worktreeId: {
          type: 'string',
          description: 'Compatibility worktree ID.',
        },
        chatId: {
          type: 'string',
          description: 'Compatibility chat ID, not a title or session key.',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'Compatibility completion target using cowork project and chat IDs.',
      required: ['kind', 'projectId', 'chatId'],
      properties: {
        kind: { type: 'string', enum: ['standalone_chat'] },
        projectId: {
          type: 'string',
          description:
            'Compatibility cowork project ID, not a runtime sentinel.',
        },
        chatId: {
          type: 'string',
          description:
            'Compatibility cowork chat ID, not a title or session key.',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'Compatibility new-chat scope using workspace and worktree IDs.',
      required: ['kind', 'projectId', 'worktreeId'],
      properties: {
        kind: { type: 'string', enum: ['worktree_chat_scope'] },
        projectId: {
          type: 'string',
          description: 'Workspace/project id for the watched worktree.',
        },
        worktreeId: {
          type: 'string',
          description:
            'Worktree id whose future newly tracked chats are watched.',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description: 'Compatibility new-chat scope using a cowork project ID.',
      required: ['kind', 'projectId'],
      properties: {
        kind: { type: 'string', enum: ['standalone_chat_project'] },
        projectId: {
          type: 'string',
          description:
            'Cowork project id whose future newly tracked chats are watched, not the runtime standalone sentinel.',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'Worktree pipeline completion target. Pin a non-terminal executionId for pause/completion notifications, or omit executionId to watch future matching runs.',
      required: ['kind', 'projectId', 'worktreeId'],
      properties: {
        kind: { type: 'string', enum: ['worktree_pipeline'] },
        projectId: {
          type: 'string',
          description: 'Workspace/project id for the pipeline execution.',
        },
        worktreeId: {
          type: 'string',
          description: 'Worktree id for the pipeline execution.',
        },
        executionId: {
          type: 'string',
          description:
            'Optional non-terminal execution id. Already-terminal executions are rejected.',
        },
        pipelineId: {
          type: 'string',
          description:
            'Optional pipeline definition id to narrow matching runs.',
        },
        terminalStatuses: {
          type: 'array',
          description:
            'Optional terminal statuses to consume on. Defaults to success, failure, and cancelled. Paused executions also notify without consuming the watcher.',
          items: {
            type: 'string',
            enum: ['success', 'failure', 'cancelled'],
          },
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'Worktree hook trigger target. Watches future automatic hook triggers, including paused or unconfigured hooks. Manual hook runs do not fire this watcher.',
      required: ['kind', 'projectId', 'worktreeId', 'triggerName'],
      properties: {
        kind: { type: 'string', enum: ['worktree_hook'] },
        projectId: {
          type: 'string',
          description: 'Workspace/project id for the worktree.',
        },
        worktreeId: {
          type: 'string',
          description: 'Worktree id whose hook trigger is watched.',
        },
        triggerName: {
          type: 'string',
          description:
            'Supported hook trigger name, such as pr:checks:fail or worktree:precommit:failure.',
        },
        hookKey: {
          type: 'string',
          description:
            'Optional configured hook key to watch one hook entry. Omit to watch any scope for triggerName.',
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
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'Automation run target. Use exactly this shape for automation_run; failed and skipped runs fire immediately, successful runs fire when a dispatched chat turn ends or a dispatched pipeline completes.',
      required: ['kind', 'automationId'],
      properties: {
        kind: { type: 'string', enum: ['automation'] },
        automationId: {
          type: 'string',
          description:
            'Automation (scheduled activity) id from automation.list / automation.get. Unknown ids are rejected.',
        },
      },
      additionalProperties: false,
    },
  ],
};

const legacySetupWatchersJsonSchema: JsonValue = {
  type: 'object',
  required: ['watchers'],
  properties: {
    watchers: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['trigger', 'target'],
        properties: {
          trigger: {
            type: 'string',
            not: {
              enum: [
                'project_task_chat_completion',
                'project_new_chat_started',
                'bot_task_chat_completion',
                'bot_new_chat_started',
              ],
            },
            description:
              'Watcher trigger from SearchWatchers: project_task_chat_completion, project_new_chat_started, bot_task_chat_completion, bot_new_chat_started, worktree_pipeline_completion, worktree_hook_triggered, or automation_run. Use the matching target shape.',
          },
          label: { type: 'string' },
          target: watcherTargetJsonSchema,
          followUpInstruction: {
            type: 'string',
            description:
              'Optional instruction included in the generated message when the watcher fires.',
          },
          allowDuplicate: {
            type: 'boolean',
            description:
              'Usually omit. When false or omitted, identical active watchers for this Orchestrator chat are deduped.',
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

export const setupWatchersJsonSchema: JsonValue =
  extendChatWatcherSetupJsonSchema(legacySetupWatchersJsonSchema);

export { askUserQuestionJsonSchema, askUserQuestionSchema };
