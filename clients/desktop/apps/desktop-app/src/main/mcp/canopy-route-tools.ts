import {
  SHOW_CAPABILITIES_DESCRIPTION,
  showCapabilitiesJsonSchema,
} from '../canopy-tools/show-capabilities';
import {
  WATCH_COMMAND_DESCRIPTION,
  SCHEDULE_WAKEUP_DESCRIPTION,
  watchCommandJsonSchema,
  scheduleWakeupJsonSchema,
} from '../canopy-tools/local-watcher-definitions';
import { BRAND } from '@canopy/brand/current';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  getCanonicalCanopyToolKey,
  isCodeGraphInjectedToolKey,
  isLedgerInjectedToolKey,
  type CanopyInjectedToolKey,
  type CanopyInjectedToolSurface,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  APP_ADVISOR_TOOL_ENTRIES,
  getCanonicalAppAdvisorToolKey,
  isAppAdvisorLedgerToolKey,
  type AppAdvisorToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import {
  PIPELINE_EDITOR_TOOL_ENTRIES,
  type PipelineEditorToolKey,
} from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import { isClaudeWorkerToolExposed } from '../integration/claude-worker-tool-exposure';
import { isRecord } from './integration-http';
import { hasInterfaceTool } from '../agents/interface-tool-binding';
import { isPipelineEditorToolAdvertised } from '../pipeline-editor/tool-advertisement';
import type { CanopyInjectedToolTextResult } from '../canopy-tools/core';
import {
  SET_AUTO_ARCHIVE_DESCRIPTION,
  SET_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
  SET_BASE_BRANCH_DESCRIPTION,
  START_FORKED_AGENT_DESCRIPTION,
  START_BRANCHED_AGENT_DESCRIPTION,
  startSplitAgentJsonSchema,
  ASK_USER_QUESTION_DESCRIPTION,
  BUILD_OR_UPDATE_CODE_GRAPH_DESCRIPTION,
  COMPARE_CHANGE_IMPACT_DESCRIPTION,
  DETECT_CHANGED_SYMBOLS_DESCRIPTION,
  DELETE_WATCHERS_DESCRIPTION,
  DISPATCH_ACTION_DESCRIPTION,
  EXPLAIN_CODE_SYMBOL_DESCRIPTION,
  GET_CODE_GRAPH_CONTEXT_DESCRIPTION,
  GET_GIT_PREFERENCES_DESCRIPTION,
  GET_FILE_COMMENTS_DESCRIPTION,
  GET_REVIEW_COMMENTS_DESCRIPTION,
  GET_IMPACT_RADIUS_DESCRIPTION,
  GET_REVIEW_CONTEXT_DESCRIPTION,
  GET_SCRIPT_OUTPUT_DESCRIPTION,
  QUERY_CODE_GRAPH_DESCRIPTION,
  READ_PIPELINE_YAML_DESCRIPTION,
  SAVE_MEMORY_DESCRIPTION,
  SEARCH_MEMORY_DESCRIPTION,
  READ_MEMORY_DESCRIPTION,
  SEARCH_CHATS_DESCRIPTION,
  READ_CHAT_EXCERPT_DESCRIPTION,
  SHOW_FILES_DESCRIPTION,
  SHOW_VISUAL_DESCRIPTION,
  RESPOND_TO_FILE_COMMENT_DESCRIPTION,
  RESPOND_TO_REVIEW_COMMENT_DESCRIPTION,
  REPORT_STRUCTURED_RESULT_DESCRIPTION,
  SEARCH_ACTIONS_DESCRIPTION,
  SEARCH_CODE_GRAPH_DESCRIPTION,
  SEARCH_WATCHERS_DESCRIPTION,
  SETUP_WATCHERS_DESCRIPTION,
  WATCH_GITHUB_ITEMS_DESCRIPTION,
  GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
  setAutoArchiveJsonSchema,
  setWorkEntryAutoDeleteJsonSchema,
  setBaseBranchJsonSchema,
  askUserQuestionJsonSchema,
  deleteWatchersJsonSchema,
  buildOrUpdateCodeGraphJsonSchema,
  compareChangeImpactJsonSchema,
  coworkDispatchActionJsonSchema,
  detectChangedSymbolsJsonSchema,
  dispatchActionJsonSchema,
  explainCodeSymbolJsonSchema,
  getCodeGraphContextJsonSchema,
  getGitPreferencesJsonSchema,
  getFileCommentsJsonSchema,
  getImpactRadiusJsonSchema,
  getReviewContextJsonSchema,
  getReviewCommentsJsonSchema,
  getScriptOutputJsonSchema,
  queryCodeGraphJsonSchema,
  readPipelineYamlJsonSchema,
  saveMemoryJsonSchema,
  searchMemoryJsonSchema,
  readMemoryJsonSchema,
  searchChatsJsonSchema,
  readChatExcerptJsonSchema,
  showFilesJsonSchema,
  showVisualJsonSchema,
  previewVisualJsonSchema,
  PREVIEW_VISUAL_DESCRIPTION,
  respondToFileCommentJsonSchema,
  respondToCommentJsonSchema,
  searchActionsJsonSchema,
  searchCodeGraphJsonSchema,
  searchWatchersJsonSchema,
  setupWatchersJsonSchema,
  watchGitHubItemsJsonSchema,
  getGitHubPullRequestStatusJsonSchema,
  ADD_LEDGER_ENTRY_DESCRIPTION,
  SEARCH_LEDGER_ENTRIES_DESCRIPTION,
  UPDATE_LEDGER_ENTRY_DESCRIPTION,
  addLedgerEntryJsonSchema,
  searchLedgerEntriesJsonSchema,
  updateLedgerEntryJsonSchema,
} from '../canopy-tools/definitions';
import { chatVisualsEligible } from '../lib/chat-visuals-feature-flag';
import {
  LOAD_DEFERRED_TOOLS_DESCRIPTION,
  SEARCH_DEFERRED_TOOLS_DESCRIPTION,
  loadDeferredToolsJsonSchema,
  searchDeferredToolsJsonSchema,
} from '../deferred-tools/definitions';
import { APP_ADVISOR_START_FORKED_AGENT_DESCRIPTION } from '../app-advisor/tool-executor';
import {
  APP_ADVISOR_ADD_LEDGER_ENTRY_DESCRIPTION,
  APP_ADVISOR_GET_SCRIPT_OUTPUT_DESCRIPTION,
  APP_ADVISOR_GET_FILE_COMMENTS_DESCRIPTION,
  APP_ADVISOR_READ_PIPELINE_YAML_DESCRIPTION,
  APP_ADVISOR_RESPOND_TO_FILE_COMMENT_DESCRIPTION,
  APP_ADVISOR_SEARCH_LEDGER_ENTRIES_DESCRIPTION,
  APP_ADVISOR_SHOW_FILES_DESCRIPTION,
  APP_ADVISOR_UPDATE_LEDGER_ENTRY_DESCRIPTION,
  DISPATCH_ACTION_DESCRIPTION as APP_ADVISOR_DISPATCH_ACTION_DESCRIPTION,
  GET_CURRENT_UI_STATE_DESCRIPTION,
  GET_PIPELINE_DEBUG_CONTEXT_DESCRIPTION,
  SEARCH_ACTIONS_DESCRIPTION as APP_ADVISOR_SEARCH_ACTIONS_DESCRIPTION,
  SEARCH_WATCHERS_DESCRIPTION as APP_ADVISOR_SEARCH_WATCHERS_DESCRIPTION,
  SETUP_WATCHERS_DESCRIPTION as APP_ADVISOR_SETUP_WATCHERS_DESCRIPTION,
  WATCH_GITHUB_ITEMS_DESCRIPTION as APP_ADVISOR_WATCH_GITHUB_ITEMS_DESCRIPTION,
  GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION as APP_ADVISOR_GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
  appAdvisorGetScriptOutputJsonSchema,
  appAdvisorGetFileCommentsJsonSchema,
  appAdvisorReadPipelineYamlJsonSchema,
  appAdvisorShowFilesJsonSchema,
  appAdvisorRespondToFileCommentJsonSchema,
  askUserQuestionJsonSchema as appAdvisorAskUserQuestionJsonSchema,
  dispatchActionJsonSchema as appAdvisorDispatchActionJsonSchema,
  getCurrentUiStateJsonSchema,
  getPipelineDebugContextJsonSchema,
  searchActionsJsonSchema as appAdvisorSearchActionsJsonSchema,
  searchWatchersJsonSchema as appAdvisorSearchWatchersJsonSchema,
  setupWatchersJsonSchema as appAdvisorSetupWatchersJsonSchema,
  watchGitHubItemsJsonSchema as appAdvisorWatchGitHubItemsJsonSchema,
} from '../app-advisor/definitions';
import {
  NAVIGATION_TO_LIST_DESCRIPTION,
  PIPELINE_CREATE_DESCRIPTION,
  PIPELINE_GET_ACTION_DEFINITION_DESCRIPTION,
  PIPELINE_GET_CURRENT_DESCRIPTION,
  PIPELINE_LIST_DESCRIPTION,
  PIPELINE_OPEN_DESCRIPTION,
  PIPELINE_SAVE_DESCRIPTION,
  PIPELINE_SET_YAML_DESCRIPTION,
  askUserQuestionJsonSchema as pipelineEditorAskUserQuestionJsonSchema,
  emptyArgsJsonSchema as pipelineEditorEmptyArgsJsonSchema,
  pipelineGetActionDefinitionJsonSchema,
  pipelineOpenJsonSchema,
  pipelineSetYamlJsonSchema,
} from '../pipeline-editor/definitions';
import type { CanopyWorktreeSessionRoute } from './canopy-tool-router';

/**
 * Stable display name for the bespoke code-review reply tool (formerly shared
 * with the retired plan-chat takeover).
 */
export const RESPOND_TO_COMMENT_TOOL_NAME = 'RespondToComment';
/**
 * Stable display name for the bespoke code-review read tool. Code-review
 * sessions reuse `RespondToComment` (with a review-specific description) for
 * the reply side.
 */
export const GET_REVIEW_COMMENTS_TOOL_NAME = 'GetReviewComments';
export const REPORT_STRUCTURED_RESULT_TOOL_NAME = 'ReportStructuredResult';

export interface CanopyRouteTool {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export const CLAUDE_TERMINAL_TOOL_DEFINITIONS: Readonly<
  Partial<
    Record<
      CanopyInjectedToolKey,
      {
        description: string;
        inputSchema: JsonValue;
      }
    >
  >
> = {
  watch_command: {
    description: WATCH_COMMAND_DESCRIPTION,
    inputSchema: watchCommandJsonSchema,
  },
  schedule_wakeup: {
    description: SCHEDULE_WAKEUP_DESCRIPTION,
    inputSchema: scheduleWakeupJsonSchema,
  },
  ask_user_question: {
    description: ASK_USER_QUESTION_DESCRIPTION,
    inputSchema: askUserQuestionJsonSchema,
  },
  get_script_output: {
    description: GET_SCRIPT_OUTPUT_DESCRIPTION,
    inputSchema: getScriptOutputJsonSchema,
  },
  get_git_preferences: {
    description: GET_GIT_PREFERENCES_DESCRIPTION,
    inputSchema: getGitPreferencesJsonSchema,
  },
  save_memory: {
    description: SAVE_MEMORY_DESCRIPTION,
    inputSchema: saveMemoryJsonSchema,
  },
  search_memory: {
    description: SEARCH_MEMORY_DESCRIPTION,
    inputSchema: searchMemoryJsonSchema,
  },
  search_chats: {
    description: SEARCH_CHATS_DESCRIPTION,
    inputSchema: searchChatsJsonSchema,
  },
  read_chat_excerpt: {
    description: READ_CHAT_EXCERPT_DESCRIPTION,
    inputSchema: readChatExcerptJsonSchema,
  },
  read_memory: {
    description: READ_MEMORY_DESCRIPTION,
    inputSchema: readMemoryJsonSchema,
  },
  read_pipeline_yaml: {
    description: READ_PIPELINE_YAML_DESCRIPTION,
    inputSchema: readPipelineYamlJsonSchema,
  },
  show_capabilities: {
    description: SHOW_CAPABILITIES_DESCRIPTION,
    inputSchema: showCapabilitiesJsonSchema,
  },
  show_files: {
    description: SHOW_FILES_DESCRIPTION,
    inputSchema: showFilesJsonSchema,
  },
  show_visual: {
    description: SHOW_VISUAL_DESCRIPTION,
    inputSchema: showVisualJsonSchema,
  },
  preview_visual: {
    description: PREVIEW_VISUAL_DESCRIPTION,
    inputSchema: previewVisualJsonSchema,
  },
  get_file_comments: {
    description: GET_FILE_COMMENTS_DESCRIPTION,
    inputSchema: getFileCommentsJsonSchema,
  },
  respond_to_file_comment: {
    description: RESPOND_TO_FILE_COMMENT_DESCRIPTION,
    inputSchema: respondToFileCommentJsonSchema,
  },
  search_actions: {
    description: SEARCH_ACTIONS_DESCRIPTION,
    inputSchema: searchActionsJsonSchema,
  },
  dispatch_action: {
    description: DISPATCH_ACTION_DESCRIPTION,
    inputSchema: dispatchActionJsonSchema,
  },
  search_watchers: {
    description: SEARCH_WATCHERS_DESCRIPTION,
    inputSchema: searchWatchersJsonSchema,
  },
  setup_watchers: {
    description: SETUP_WATCHERS_DESCRIPTION,
    inputSchema: setupWatchersJsonSchema,
  },
  watch_github_items: {
    description: WATCH_GITHUB_ITEMS_DESCRIPTION,
    inputSchema: watchGitHubItemsJsonSchema,
  },
  get_github_pull_request_status: {
    description: GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
    inputSchema: getGitHubPullRequestStatusJsonSchema,
  },
  delete_watchers: {
    description: DELETE_WATCHERS_DESCRIPTION,
    inputSchema: deleteWatchersJsonSchema,
  },
  set_auto_archive: {
    description: SET_AUTO_ARCHIVE_DESCRIPTION,
    inputSchema: setAutoArchiveJsonSchema,
  },
  set_work_entry_auto_delete: {
    description: SET_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
    inputSchema: setWorkEntryAutoDeleteJsonSchema,
  },
  start_forked_agent: {
    description: START_FORKED_AGENT_DESCRIPTION,
    inputSchema: startSplitAgentJsonSchema,
  },
  start_branched_agent: {
    description: START_BRANCHED_AGENT_DESCRIPTION,
    inputSchema: startSplitAgentJsonSchema,
  },
  set_base_branch: {
    description: SET_BASE_BRANCH_DESCRIPTION,
    inputSchema: setBaseBranchJsonSchema,
  },
  get_code_graph_context: {
    description: GET_CODE_GRAPH_CONTEXT_DESCRIPTION,
    inputSchema: getCodeGraphContextJsonSchema,
  },
  build_or_update_code_graph: {
    description: BUILD_OR_UPDATE_CODE_GRAPH_DESCRIPTION,
    inputSchema: buildOrUpdateCodeGraphJsonSchema,
  },
  query_code_graph: {
    description: QUERY_CODE_GRAPH_DESCRIPTION,
    inputSchema: queryCodeGraphJsonSchema,
  },
  search_code_graph: {
    description: SEARCH_CODE_GRAPH_DESCRIPTION,
    inputSchema: searchCodeGraphJsonSchema,
  },
  explain_code_symbol: {
    description: EXPLAIN_CODE_SYMBOL_DESCRIPTION,
    inputSchema: explainCodeSymbolJsonSchema,
  },
  get_impact_radius: {
    description: GET_IMPACT_RADIUS_DESCRIPTION,
    inputSchema: getImpactRadiusJsonSchema,
  },
  detect_changed_symbols: {
    description: DETECT_CHANGED_SYMBOLS_DESCRIPTION,
    inputSchema: detectChangedSymbolsJsonSchema,
  },
  compare_change_impact: {
    description: COMPARE_CHANGE_IMPACT_DESCRIPTION,
    inputSchema: compareChangeImpactJsonSchema,
  },
  get_review_context: {
    description: GET_REVIEW_CONTEXT_DESCRIPTION,
    inputSchema: getReviewContextJsonSchema,
  },
  search_deferred_tools: {
    description: SEARCH_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: searchDeferredToolsJsonSchema,
  },
  load_deferred_tools: {
    description: LOAD_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: loadDeferredToolsJsonSchema,
  },
  add_ledger_entry: {
    description: ADD_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: addLedgerEntryJsonSchema,
  },
  search_ledger_entries: {
    description: SEARCH_LEDGER_ENTRIES_DESCRIPTION,
    inputSchema: searchLedgerEntriesJsonSchema,
  },
  update_ledger_entry: {
    description: UPDATE_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: updateLedgerEntryJsonSchema,
  },
};

export function buildClaudeCanopyMcpTools(
  surface: CanopyInjectedToolSurface,
): Array<{
  canonicalKey: CanopyInjectedToolKey;
  name: string;
  description: string;
  inputSchema: JsonValue;
}> {
  return CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].map((key) => {
    const definition = CLAUDE_TERMINAL_TOOL_DEFINITIONS[key];
    if (!definition) {
      throw new Error(
        `Missing Claude ${BRAND.displayName} MCP definition for ${key}`,
      );
    }
    return {
      canonicalKey: key,
      name: CANOPY_INJECTED_TOOL_REGISTRY[key].displayName,
      description: definition.description,
      // Cowork chats cannot start chats in new worktrees.
      inputSchema:
        key === 'dispatch_action' && COWORK_TOOL_SURFACES.has(surface)
          ? coworkDispatchActionJsonSchema
          : definition.inputSchema,
    };
  });
}

export const COWORK_TOOL_SURFACES: ReadonlySet<CanopyInjectedToolSurface> =
  new Set<CanopyInjectedToolSurface>([
    'native-sdk-standalone',
    'cursor-acp-standalone',
    'opencode-acp-standalone',
    'copilot-sdk-standalone',
  ]);

export const CLAUDE_TERMINAL_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'claude-code-terminal',
);
export const CLAUDE_NATIVE_MCP_TOOLS = buildClaudeCanopyMcpTools('native-sdk');
export const CLAUDE_NATIVE_STANDALONE_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'native-sdk-standalone',
);
export const CLAUDE_NATIVE_UI_MCP_TOOLS =
  buildClaudeCanopyMcpTools('native-sdk-ui');
export const CLAUDE_WORKER_MCP_TOOLS =
  buildClaudeCanopyMcpTools('claude-worker');
export const COPILOT_SDK_MCP_TOOLS = buildClaudeCanopyMcpTools('copilot-sdk');
export const OPENCODE_ACP_MCP_TOOLS = buildClaudeCanopyMcpTools('opencode-acp');
export const OPENCODE_ACP_STANDALONE_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'opencode-acp-standalone',
);
export const COPILOT_STANDALONE_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'copilot-sdk-standalone',
);
export const CURSOR_ACP_MCP_TOOLS = buildClaudeCanopyMcpTools('cursor-acp');
export const CURSOR_ACP_STANDALONE_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'cursor-acp-standalone',
);

export const APP_ADVISOR_TERMINAL_TOOL_DEFINITIONS: Readonly<
  Record<
    AppAdvisorToolKey,
    {
      description: string;
      inputSchema: JsonValue;
    }
  >
> = {
  watch_command: {
    description: WATCH_COMMAND_DESCRIPTION,
    inputSchema: watchCommandJsonSchema,
  },
  set_auto_archive: {
    description: SET_AUTO_ARCHIVE_DESCRIPTION,
    inputSchema: setAutoArchiveJsonSchema,
  },
  set_work_entry_auto_delete: {
    description: SET_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
    inputSchema: setWorkEntryAutoDeleteJsonSchema,
  },
  schedule_wakeup: {
    description: SCHEDULE_WAKEUP_DESCRIPTION,
    inputSchema: scheduleWakeupJsonSchema,
  },
  ask_user_question: {
    description: ASK_USER_QUESTION_DESCRIPTION,
    inputSchema: appAdvisorAskUserQuestionJsonSchema,
  },
  get_script_output: {
    description: APP_ADVISOR_GET_SCRIPT_OUTPUT_DESCRIPTION,
    inputSchema: appAdvisorGetScriptOutputJsonSchema,
  },
  show_capabilities: {
    description: SHOW_CAPABILITIES_DESCRIPTION,
    inputSchema: showCapabilitiesJsonSchema,
  },
  show_files: {
    description: APP_ADVISOR_SHOW_FILES_DESCRIPTION,
    inputSchema: appAdvisorShowFilesJsonSchema,
  },
  get_file_comments: {
    description: APP_ADVISOR_GET_FILE_COMMENTS_DESCRIPTION,
    inputSchema: appAdvisorGetFileCommentsJsonSchema,
  },
  respond_to_file_comment: {
    description: APP_ADVISOR_RESPOND_TO_FILE_COMMENT_DESCRIPTION,
    inputSchema: appAdvisorRespondToFileCommentJsonSchema,
  },
  read_pipeline_yaml: {
    description: APP_ADVISOR_READ_PIPELINE_YAML_DESCRIPTION,
    inputSchema: appAdvisorReadPipelineYamlJsonSchema,
  },
  search_actions: {
    description: APP_ADVISOR_SEARCH_ACTIONS_DESCRIPTION,
    inputSchema: appAdvisorSearchActionsJsonSchema,
  },
  get_current_ui_state: {
    description: GET_CURRENT_UI_STATE_DESCRIPTION,
    inputSchema: getCurrentUiStateJsonSchema,
  },
  dispatch_action: {
    description: APP_ADVISOR_DISPATCH_ACTION_DESCRIPTION,
    inputSchema: appAdvisorDispatchActionJsonSchema,
  },
  get_pipeline_debug_context: {
    description: GET_PIPELINE_DEBUG_CONTEXT_DESCRIPTION,
    inputSchema: getPipelineDebugContextJsonSchema,
  },
  search_watchers: {
    description: APP_ADVISOR_SEARCH_WATCHERS_DESCRIPTION,
    inputSchema: appAdvisorSearchWatchersJsonSchema,
  },
  setup_watchers: {
    description: APP_ADVISOR_SETUP_WATCHERS_DESCRIPTION,
    inputSchema: appAdvisorSetupWatchersJsonSchema,
  },
  watch_github_items: {
    description: APP_ADVISOR_WATCH_GITHUB_ITEMS_DESCRIPTION,
    inputSchema: appAdvisorWatchGitHubItemsJsonSchema,
  },
  get_github_pull_request_status: {
    description: APP_ADVISOR_GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
    inputSchema: getGitHubPullRequestStatusJsonSchema,
  },
  start_forked_agent: {
    description: APP_ADVISOR_START_FORKED_AGENT_DESCRIPTION,
    inputSchema: startSplitAgentJsonSchema,
  },
  search_deferred_tools: {
    description: SEARCH_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: searchDeferredToolsJsonSchema,
  },
  load_deferred_tools: {
    description: LOAD_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: loadDeferredToolsJsonSchema,
  },
  // Listed only on a route whose session has Ledger tools.
  add_ledger_entry: {
    description: APP_ADVISOR_ADD_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: addLedgerEntryJsonSchema,
  },
  search_ledger_entries: {
    description: APP_ADVISOR_SEARCH_LEDGER_ENTRIES_DESCRIPTION,
    inputSchema: searchLedgerEntriesJsonSchema,
  },
  update_ledger_entry: {
    description: APP_ADVISOR_UPDATE_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: updateLedgerEntryJsonSchema,
  },
};

export const APP_ADVISOR_TERMINAL_MCP_TOOLS = APP_ADVISOR_TOOL_ENTRIES.map(
  (entry) => {
    const definition =
      APP_ADVISOR_TERMINAL_TOOL_DEFINITIONS[entry.canonicalKey];
    return {
      canonicalKey: entry.canonicalKey,
      name: entry.displayName,
      description: definition.description,
      inputSchema: definition.inputSchema,
    };
  },
);
export const APP_ADVISOR_MAIN_MCP_TOOLS = APP_ADVISOR_TERMINAL_MCP_TOOLS.filter(
  (tool) => tool.canonicalKey !== 'ask_user_question',
);
export const APP_ADVISOR_UI_MCP_TOOLS = APP_ADVISOR_TERMINAL_MCP_TOOLS.filter(
  (tool) => tool.canonicalKey === 'ask_user_question',
);

export const PIPELINE_EDITOR_TERMINAL_TOOL_DEFINITIONS: Readonly<
  Record<
    PipelineEditorToolKey,
    {
      description: string;
      inputSchema: JsonValue;
    }
  >
> = {
  ask_user_question: {
    description: ASK_USER_QUESTION_DESCRIPTION,
    inputSchema: pipelineEditorAskUserQuestionJsonSchema,
  },
  pipeline_list: {
    description: PIPELINE_LIST_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  pipeline_open: {
    description: PIPELINE_OPEN_DESCRIPTION,
    inputSchema: pipelineOpenJsonSchema,
  },
  pipeline_create: {
    description: PIPELINE_CREATE_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  pipeline_get_current: {
    description: PIPELINE_GET_CURRENT_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  pipeline_set_yaml: {
    description: PIPELINE_SET_YAML_DESCRIPTION,
    inputSchema: pipelineSetYamlJsonSchema,
  },
  pipeline_save: {
    description: PIPELINE_SAVE_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  pipeline_get_action_definition: {
    description: PIPELINE_GET_ACTION_DEFINITION_DESCRIPTION,
    inputSchema: pipelineGetActionDefinitionJsonSchema,
  },
  navigation_to_list: {
    description: NAVIGATION_TO_LIST_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  search_deferred_tools: {
    description: SEARCH_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: searchDeferredToolsJsonSchema,
  },
  load_deferred_tools: {
    description: LOAD_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: loadDeferredToolsJsonSchema,
  },
};

export const PIPELINE_EDITOR_TERMINAL_MCP_TOOLS =
  PIPELINE_EDITOR_TOOL_ENTRIES.map((entry) => {
    const definition =
      PIPELINE_EDITOR_TERMINAL_TOOL_DEFINITIONS[entry.canonicalKey];
    return {
      canonicalKey: entry.canonicalKey,
      name: entry.displayName,
      description: definition.description,
      inputSchema: definition.inputSchema,
    };
  });
export const PIPELINE_EDITOR_MAIN_MCP_TOOLS =
  PIPELINE_EDITOR_TERMINAL_MCP_TOOLS.filter(
    (tool) => tool.canonicalKey !== 'ask_user_question',
  );
export const PIPELINE_EDITOR_UI_MCP_TOOLS =
  PIPELINE_EDITOR_TERMINAL_MCP_TOOLS.filter(
    (tool) => tool.canonicalKey === 'ask_user_question',
  );

/** The tool_use ID the bundled Claude CLI sends in a tools/call `_meta`. */
export function getClaudeToolUseId(meta: unknown): string | undefined {
  const toolUseId = isRecord(meta) ? meta['claudecode/toolUseId'] : undefined;
  return typeof toolUseId === 'string' && toolUseId.length > 0
    ? toolUseId
    : undefined;
}

export function toMcpToolResult(result: CanopyInjectedToolTextResult): {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
} {
  const imageMatch = result.imageDataUrl?.match(
    /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/,
  );
  const response = {
    content: [
      { type: 'text' as const, text: result.text },
      ...(imageMatch
        ? [
            {
              type: 'image' as const,
              mimeType: imageMatch[1],
              data: imageMatch[2],
            },
          ]
        : []),
    ],
  };
  return result.isError ? { ...response, isError: true } : response;
}

export function getClaudeCanopyToolSurface(
  route: CanopyWorktreeSessionRoute,
): CanopyInjectedToolSurface {
  return route.toolSurface ?? 'claude-code-terminal';
}

export function getClaudeCanopyToolsForSurface(
  surface: CanopyInjectedToolSurface,
): typeof CLAUDE_TERMINAL_MCP_TOOLS {
  switch (surface) {
    case 'native-sdk':
      return CLAUDE_NATIVE_MCP_TOOLS;
    case 'native-sdk-standalone':
      return CLAUDE_NATIVE_STANDALONE_MCP_TOOLS;
    case 'native-sdk-ui':
      return CLAUDE_NATIVE_UI_MCP_TOOLS;
    case 'copilot-sdk':
      return COPILOT_SDK_MCP_TOOLS;
    case 'opencode-acp':
      return OPENCODE_ACP_MCP_TOOLS;
    case 'opencode-acp-standalone':
      return OPENCODE_ACP_STANDALONE_MCP_TOOLS;
    case 'copilot-sdk-standalone':
      return COPILOT_STANDALONE_MCP_TOOLS;
    case 'cursor-acp':
      return CURSOR_ACP_MCP_TOOLS;
    case 'cursor-acp-standalone':
      return CURSOR_ACP_STANDALONE_MCP_TOOLS;
    default:
      return CLAUDE_TERMINAL_MCP_TOOLS;
  }
}

/** One projection for advertised MCP schemas and persisted capability snapshots. */
export function getCanopyRouteTools(
  route: CanopyWorktreeSessionRoute,
  uiServer: boolean,
): readonly { name: string; description: string; inputSchema: JsonValue }[] {
  const effectiveSurface = uiServer
    ? 'native-sdk-ui'
    : getClaudeCanopyToolSurface(route);
  // Cursor and Copilot omit deferred loaders when chat policy disables them.
  // Claude and Codex retain the schemas and return guidance for disallowed calls.
  const advertiseDeferredLoaders = !(
    (route.providerType === 'cursor' || route.providerType === 'copilot') &&
    route.deferredToolsAllowed === false
  );
  const baseTools =
    route.assistantMode === 'app-advisor'
      ? uiServer
        ? APP_ADVISOR_UI_MCP_TOOLS
        : APP_ADVISOR_MAIN_MCP_TOOLS.filter((tool) => {
            const key = getClaudeTerminalAppAdvisorToolKey(tool.name);
            if (
              key === 'get_current_ui_state' &&
              !hasInterfaceTool(route.interfaceTools, 'ui.get_current_ui_state')
            )
              return false;
            if (
              key === 'show_files' &&
              !hasInterfaceTool(route.interfaceTools, 'ui.show_files') &&
              !hasInterfaceTool(
                route.interfaceTools,
                'ui.app_advisor.show_files',
              )
            )
              return false;
            // The Ledger tools only for a session that passed the Ledger
            // exposure gate when it started.
            if (
              key !== null &&
              isAppAdvisorLedgerToolKey(key) &&
              route.ledgerTools === undefined
            ) {
              return false;
            }
            // Cursor cannot carry provider context into a fork, and a
            // managed terminal runtime is built without the fork.
            if (
              key === 'start_forked_agent' &&
              (route.providerType === 'cursor' ||
                !route.appAdvisorRuntime?.startForkedAgent)
            ) {
              return false;
            }
            if (advertiseDeferredLoaders) return true;
            return (
              key !== 'search_deferred_tools' && key !== 'load_deferred_tools'
            );
          })
      : route.assistantMode === 'pipeline-editor'
        ? uiServer
          ? PIPELINE_EDITOR_UI_MCP_TOOLS
          : PIPELINE_EDITOR_MAIN_MCP_TOOLS.filter((tool) =>
              isPipelineEditorToolAdvertised(
                tool.canonicalKey,
                route.interfaceTools,
              ),
            )
        : getClaudeCanopyToolsForSurface(effectiveSurface);
  const codeGraphToolsAdvertised = route.codeGraphToolsAdvertised !== false;
  const ledgerToolsAdvertised = route.ledgerTools !== undefined;
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: JsonValue;
  }> = baseTools
    .filter((tool) => {
      if (
        route.assistantMode !== 'app-advisor' &&
        route.assistantMode !== 'pipeline-editor' &&
        tool.name === CANOPY_INJECTED_TOOL_REGISTRY.show_files.displayName &&
        !hasInterfaceTool(route.interfaceTools, 'ui.show_files')
      )
        return false;
      if (
        (tool.name === CANOPY_INJECTED_TOOL_REGISTRY.show_visual.displayName ||
          tool.name ===
            CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.displayName) &&
        !chatVisualsEligible({
          providerType: route.providerType,
          surface: effectiveSurface,
          assistantMode: route.assistantMode,
          key:
            tool.name ===
            CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.displayName
              ? 'preview_visual'
              : 'show_visual',
        })
      )
        return false;
      const canonicalKey = getCanonicalCanopyToolKey(tool.name);
      if (
        route.providerType === 'opencode' &&
        route.deferredToolsAllowed === false &&
        (canonicalKey === 'search_deferred_tools' ||
          canonicalKey === 'load_deferred_tools')
      )
        return false;
      if (canonicalKey === null) {
        return true;
      }
      // A delegate never arms removal of the work entry its parent owns; the
      // managed-delegate listing otherwise falls back to the terminal set.
      if (
        canonicalKey === 'set_work_entry_auto_delete' &&
        effectiveSurface === 'managed-delegate'
      ) {
        return false;
      }
      if (
        !advertiseDeferredLoaders &&
        (canonicalKey === 'search_deferred_tools' ||
          canonicalKey === 'load_deferred_tools')
      ) {
        return false;
      }
      if (
        !codeGraphToolsAdvertised &&
        isCodeGraphInjectedToolKey(canonicalKey)
      ) {
        return false;
      }
      // The Ledger tools are allowlisted on the native chat surfaces but
      // advertised only to a session that passed the exposure gate.
      return ledgerToolsAdvertised || !isLedgerInjectedToolKey(canonicalKey);
    })
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  if (
    route.assistantMode !== 'app-advisor' &&
    !uiServer &&
    route.isCodeReview
  ) {
    if (route.respondToReviewComment) {
      tools.push({
        name: RESPOND_TO_COMMENT_TOOL_NAME,
        description: RESPOND_TO_REVIEW_COMMENT_DESCRIPTION,
        inputSchema: respondToCommentJsonSchema,
      });
    }
    if (route.getReviewCommentThread) {
      tools.push({
        name: GET_REVIEW_COMMENTS_TOOL_NAME,
        description: GET_REVIEW_COMMENTS_DESCRIPTION,
        inputSchema: getReviewCommentsJsonSchema,
      });
    }
  }
  if (!uiServer && route.managedDelegation)
    tools.push(...route.managedDelegation.tools);
  return route.managedDelegation?.exclusive
    ? uiServer
      ? []
      : route.managedDelegation.tools
    : tools;
}

export function getClaudeCanopyToolKey(
  toolName: unknown,
  surface: CanopyInjectedToolSurface,
): CanopyInjectedToolKey | null {
  const canonicalKey =
    typeof toolName === 'string'
      ? // MCP calls use the advertised short name. Resolve it within this
        // route, not as a global transcript alias: ScheduleWakeup is also a
        // distinct provider-native tool outside this authenticated surface.
        (CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].find(
          (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].displayName === toolName,
        ) ?? getCanonicalCanopyToolKey(toolName))
      : null;
  if (!canonicalKey) {
    return null;
  }
  return CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].includes(canonicalKey)
    ? canonicalKey
    : null;
}

export function getClaudeTerminalAppAdvisorToolKey(
  toolName: unknown,
): AppAdvisorToolKey | null {
  if (typeof toolName !== 'string') {
    return null;
  }
  const entry = APP_ADVISOR_TOOL_ENTRIES.find(
    (candidate) =>
      candidate.displayName === toolName ||
      candidate.claudeToolName === toolName ||
      candidate.codexToolName === toolName,
  );
  if (entry) return entry.canonicalKey;
  // Resumed sessions still call chat auto-archive by its pre-rename names.
  // Only that ungated tool falls back; other legacy names stay unresolved so
  // they cannot bypass the listing's gates.
  return getCanonicalAppAdvisorToolKey(toolName) === 'set_auto_archive'
    ? 'set_auto_archive'
    : null;
}

export function getClaudeTerminalPipelineEditorToolKey(
  toolName: unknown,
): PipelineEditorToolKey | null {
  if (typeof toolName !== 'string') {
    return null;
  }
  const entry = PIPELINE_EDITOR_TOOL_ENTRIES.find(
    (candidate) =>
      candidate.displayName === toolName ||
      candidate.claudeToolName === toolName ||
      candidate.codexToolName === toolName,
  );
  return entry?.canonicalKey ?? null;
}

/**
 * The tools a session's MCP server lists: the `tools/list` body of
 * handleCanopyMcpJsonRpc moved unchanged, including the `claude-worker` branch.
 */
export function listCanopyRouteTools(
  route: CanopyWorktreeSessionRoute,
  uiServer: boolean,
): readonly CanopyRouteTool[] {
  if (
    route.assistantMode !== 'app-advisor' &&
    getClaudeCanopyToolSurface(route) === 'claude-worker'
  ) {
    return [
      ...(route.reportStructuredResultSchema
        ? [
            {
              name: REPORT_STRUCTURED_RESULT_TOOL_NAME,
              description: REPORT_STRUCTURED_RESULT_DESCRIPTION,
              inputSchema: route.reportStructuredResultSchema as JsonValue,
            },
          ]
        : []),
      ...CLAUDE_WORKER_MCP_TOOLS.filter((tool) =>
        isClaudeWorkerToolExposed(
          tool.canonicalKey,
          route.workerMemoryToolExposure ?? 'none',
          route.ledgerTools !== undefined,
        ),
      ).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    ];
  }
  return getCanopyRouteTools(route, uiServer);
}
