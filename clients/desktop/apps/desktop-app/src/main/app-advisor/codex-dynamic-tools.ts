import {
  SHOW_CAPABILITIES_DESCRIPTION,
  showCapabilitiesJsonSchema,
} from '../canopy-tools/show-capabilities';
import {
  SCHEDULE_WAKEUP_DESCRIPTION,
  WATCH_COMMAND_DESCRIPTION,
  scheduleWakeupJsonSchema,
  watchCommandJsonSchema,
} from '../canopy-tools/local-watcher-definitions';
import {
  APP_ADVISOR_TOOL_ENTRIES,
  getCanonicalAppAdvisorToolKey,
  isAppAdvisorLedgerToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import type { DynamicToolCallParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import { defineCodexFunctionToolSpec } from '../codex/dynamic-tool-spec';
import {
  APP_ADVISOR_ADD_LEDGER_ENTRY_DESCRIPTION,
  APP_ADVISOR_GET_SCRIPT_OUTPUT_DESCRIPTION,
  APP_ADVISOR_READ_PIPELINE_YAML_DESCRIPTION,
  APP_ADVISOR_SEARCH_LEDGER_ENTRIES_DESCRIPTION,
  APP_ADVISOR_SHOW_FILES_DESCRIPTION,
  APP_ADVISOR_GET_FILE_COMMENTS_DESCRIPTION,
  APP_ADVISOR_RESPOND_TO_FILE_COMMENT_DESCRIPTION,
  APP_ADVISOR_UPDATE_LEDGER_ENTRY_DESCRIPTION,
  DISPATCH_ACTION_DESCRIPTION,
  GET_CURRENT_UI_STATE_DESCRIPTION,
  GET_PIPELINE_DEBUG_CONTEXT_DESCRIPTION,
  SEARCH_ACTIONS_DESCRIPTION,
  SEARCH_WATCHERS_DESCRIPTION,
  SETUP_WATCHERS_DESCRIPTION,
  WATCH_GITHUB_ITEMS_DESCRIPTION,
  GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
  appAdvisorGetScriptOutputJsonSchema,
  appAdvisorReadPipelineYamlJsonSchema,
  appAdvisorShowFilesJsonSchema,
  appAdvisorGetFileCommentsJsonSchema,
  appAdvisorRespondToFileCommentJsonSchema,
  askUserQuestionJsonSchema,
  dispatchActionJsonSchema,
  getCurrentUiStateJsonSchema,
  getPipelineDebugContextJsonSchema,
  searchActionsJsonSchema,
  searchWatchersJsonSchema,
  setupWatchersJsonSchema,
  watchGitHubItemsJsonSchema,
  getGitHubPullRequestStatusJsonSchema,
} from './definitions';
import {
  SET_AUTO_ARCHIVE_DESCRIPTION,
  SET_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
  setAutoArchiveJsonSchema,
  setWorkEntryAutoDeleteJsonSchema,
  ASK_USER_QUESTION_DESCRIPTION,
  addLedgerEntryJsonSchema,
  searchLedgerEntriesJsonSchema,
  startSplitAgentJsonSchema,
  updateLedgerEntryJsonSchema,
} from '../canopy-tools/definitions';
import {
  LOAD_DEFERRED_TOOLS_DESCRIPTION,
  SEARCH_DEFERRED_TOOLS_DESCRIPTION,
  loadDeferredToolsJsonSchema,
  searchDeferredToolsJsonSchema,
} from '../deferred-tools/definitions';
import type { AppAdvisorToolRuntime } from './runtime';
import {
  APP_ADVISOR_START_FORKED_AGENT_DESCRIPTION,
  executeAppAdvisorTool,
  type AppAdvisorToolContext,
} from './tool-executor';

const descriptions = {
  ask_user_question: ASK_USER_QUESTION_DESCRIPTION,
  get_script_output: APP_ADVISOR_GET_SCRIPT_OUTPUT_DESCRIPTION,
  read_pipeline_yaml: APP_ADVISOR_READ_PIPELINE_YAML_DESCRIPTION,
  show_files: APP_ADVISOR_SHOW_FILES_DESCRIPTION,
  show_capabilities: SHOW_CAPABILITIES_DESCRIPTION,
  get_file_comments: APP_ADVISOR_GET_FILE_COMMENTS_DESCRIPTION,
  respond_to_file_comment: APP_ADVISOR_RESPOND_TO_FILE_COMMENT_DESCRIPTION,
  search_actions: SEARCH_ACTIONS_DESCRIPTION,
  get_current_ui_state: GET_CURRENT_UI_STATE_DESCRIPTION,
  dispatch_action: DISPATCH_ACTION_DESCRIPTION,
  get_pipeline_debug_context: GET_PIPELINE_DEBUG_CONTEXT_DESCRIPTION,
  search_watchers: SEARCH_WATCHERS_DESCRIPTION,
  setup_watchers: SETUP_WATCHERS_DESCRIPTION,
  watch_github_items: WATCH_GITHUB_ITEMS_DESCRIPTION,
  get_github_pull_request_status: GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
  watch_command: WATCH_COMMAND_DESCRIPTION,
  schedule_wakeup: SCHEDULE_WAKEUP_DESCRIPTION,
  set_auto_archive: SET_AUTO_ARCHIVE_DESCRIPTION,
  set_work_entry_auto_delete: SET_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
  start_forked_agent: APP_ADVISOR_START_FORKED_AGENT_DESCRIPTION,
  search_deferred_tools: SEARCH_DEFERRED_TOOLS_DESCRIPTION,
  load_deferred_tools: LOAD_DEFERRED_TOOLS_DESCRIPTION,
  add_ledger_entry: APP_ADVISOR_ADD_LEDGER_ENTRY_DESCRIPTION,
  search_ledger_entries: APP_ADVISOR_SEARCH_LEDGER_ENTRIES_DESCRIPTION,
  update_ledger_entry: APP_ADVISOR_UPDATE_LEDGER_ENTRY_DESCRIPTION,
} as const;

const schemas = {
  ask_user_question: askUserQuestionJsonSchema,
  get_script_output: appAdvisorGetScriptOutputJsonSchema,
  read_pipeline_yaml: appAdvisorReadPipelineYamlJsonSchema,
  show_files: appAdvisorShowFilesJsonSchema,
  show_capabilities: showCapabilitiesJsonSchema,
  get_file_comments: appAdvisorGetFileCommentsJsonSchema,
  respond_to_file_comment: appAdvisorRespondToFileCommentJsonSchema,
  search_actions: searchActionsJsonSchema,
  get_current_ui_state: getCurrentUiStateJsonSchema,
  dispatch_action: dispatchActionJsonSchema,
  get_pipeline_debug_context: getPipelineDebugContextJsonSchema,
  search_watchers: searchWatchersJsonSchema,
  setup_watchers: setupWatchersJsonSchema,
  watch_github_items: watchGitHubItemsJsonSchema,
  get_github_pull_request_status: getGitHubPullRequestStatusJsonSchema,
  watch_command: watchCommandJsonSchema,
  schedule_wakeup: scheduleWakeupJsonSchema,
  set_auto_archive: setAutoArchiveJsonSchema,
  set_work_entry_auto_delete: setWorkEntryAutoDeleteJsonSchema,
  start_forked_agent: startSplitAgentJsonSchema,
  search_deferred_tools: searchDeferredToolsJsonSchema,
  load_deferred_tools: loadDeferredToolsJsonSchema,
  add_ledger_entry: addLedgerEntryJsonSchema,
  search_ledger_entries: searchLedgerEntriesJsonSchema,
  update_ledger_entry: updateLedgerEntryJsonSchema,
} as const;

export function buildAppAdvisorDynamicToolSpecs(
  options: {
    /**
     * Adds AddLedgerEntry, SearchLedgerEntries and UpdateLedgerEntry under
     * their App Advisor names. Set only for a session that passed the Ledger
     * exposure gate; dynamic tools are fixed when a thread starts, so every
     * call re-checks the gate. Defaults to false.
     */
    includeLedger?: boolean;
    /**
     * GetCurrentUiState is advertised only while the main window's interface
     * lease serves it (CAN-4131). Defaults to true.
     */
    includeUiState?: boolean;
    /**
     * ShowFiles is advertised only while an interface lease serves it
     * (CAN-4133). Defaults to true.
     */
    includeShowFiles?: boolean;
  } = {},
): DynamicToolSpec[] {
  return APP_ADVISOR_TOOL_ENTRIES.filter(
    (entry) =>
      (options.includeLedger === true ||
        !isAppAdvisorLedgerToolKey(entry.canonicalKey)) &&
      (options.includeUiState !== false ||
        entry.canonicalKey !== 'get_current_ui_state') &&
      (options.includeShowFiles !== false ||
        entry.canonicalKey !== 'show_files'),
  ).map((entry) =>
    defineCodexFunctionToolSpec({
      name: entry.codexToolName,
      description: descriptions[entry.canonicalKey],
      inputSchema: schemas[entry.canonicalKey],
    }),
  );
}

export async function handleAppAdvisorDynamicToolCall(
  params: DynamicToolCallParams,
  runtime: AppAdvisorToolRuntime,
  context?: Pick<
    AppAdvisorToolContext,
    'signal' | 'ledgerRuntime' | 'interfaceTools'
  >,
): Promise<DynamicToolCallResponse> {
  const canonicalKey = getCanonicalAppAdvisorToolKey(params.tool);
  if (!canonicalKey) {
    return {
      contentItems: [
        {
          type: 'inputText',
          text: `Unsupported Orchestrator dynamic tool: ${params.tool}`,
        },
      ],
      success: false,
    };
  }

  const result = await executeAppAdvisorTool(
    canonicalKey,
    params.arguments,
    runtime,
    {
      toolUseId: `codex-${params.callId}`,
      ...(context?.signal ? { signal: context.signal } : {}),
      ...(context?.interfaceTools
        ? { interfaceTools: context.interfaceTools }
        : {}),
      // Codex resends the same thread, turn and call IDs for one call, so a
      // Ledger key derived from them dedupes its retries and replays.
      ...(isAppAdvisorLedgerToolKey(canonicalKey)
        ? {
            invocationId: `codex:${params.threadId}:${params.turnId}:${params.callId}`,
            ...(context?.ledgerRuntime
              ? { ledgerRuntime: context.ledgerRuntime }
              : {}),
          }
        : canonicalKey === 'set_auto_archive'
          ? {
              invocationId: `codex:${params.threadId}:${params.turnId}:${params.callId}`,
            }
          : {}),
    },
  );

  return {
    contentItems: [{ type: 'inputText', text: result.text }],
    success: result.isError !== true,
  };
}
