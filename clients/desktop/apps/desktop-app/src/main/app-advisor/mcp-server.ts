import {
  SHOW_CAPABILITIES_DESCRIPTION,
  showCapabilitiesSchema,
} from '../canopy-tools/show-capabilities';
import {
  SCHEDULE_WAKEUP_DESCRIPTION,
  WATCH_COMMAND_DESCRIPTION,
  scheduleWakeupSchema,
  watchCommandSchema,
} from '../canopy-tools/local-watcher-definitions';
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { BRAND } from '@canopy/brand/current';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  type AppAdvisorToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import { type z } from 'zod/v4';
import {
  APP_ADVISOR_START_FORKED_AGENT_DESCRIPTION,
  executeAppAdvisorTool,
} from './tool-executor';
import {
  APP_ADVISOR_GET_SCRIPT_OUTPUT_DESCRIPTION,
  APP_ADVISOR_SET_PROJECT_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
  APP_ADVISOR_READ_PIPELINE_YAML_DESCRIPTION,
  APP_ADVISOR_SHOW_FILES_DESCRIPTION,
  APP_ADVISOR_GET_FILE_COMMENTS_DESCRIPTION,
  APP_ADVISOR_RESPOND_TO_FILE_COMMENT_DESCRIPTION,
  DISPATCH_ACTION_DESCRIPTION,
  GET_CURRENT_UI_STATE_DESCRIPTION,
  GET_PIPELINE_DEBUG_CONTEXT_DESCRIPTION,
  SEARCH_ACTIONS_DESCRIPTION,
  SEARCH_WATCHERS_DESCRIPTION,
  SETUP_WATCHERS_DESCRIPTION,
  WATCH_GITHUB_ITEMS_DESCRIPTION,
  GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
  appAdvisorGetScriptOutputSchema,
  appAdvisorSetProjectWorkEntryAutoDeleteSchema,
  appAdvisorReadPipelineYamlBaseSchema,
  appAdvisorShowFilesSchema,
  appAdvisorGetFileCommentsSchema,
  appAdvisorRespondToFileCommentSchema,
  askUserQuestionSchema,
  dispatchActionToolSchema,
  getCurrentUiStateSchema,
  getPipelineDebugContextSchema,
  searchActionsToolShape,
  searchWatchersToolShape,
  setupWatchersToolShape,
  watchGitHubItemsSchema,
  getGitHubPullRequestStatusSchema,
} from './definitions';
import {
  SET_AUTO_ARCHIVE_DESCRIPTION,
  SET_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
  setAutoArchiveSchema,
  setWorkEntryAutoDeleteSchema,
  ASK_USER_QUESTION_DESCRIPTION,
  startSplitAgentSchema,
} from '../canopy-tools/definitions';
// Image-capable: only slack_thread.open_file sets an image on an
// Orchestrator result (CAN-7749); every other action stays text only.
import { toMcpToolResult } from '../mcp/canopy-route-tools';
import type { AppAdvisorToolRuntime } from './runtime';

function appAdvisorTool<Schema extends z.ZodRawShape>(
  key: AppAdvisorToolKey,
  description: string,
  schemaShape: Schema,
  runtime: AppAdvisorToolRuntime,
): SdkMcpToolDefinition<Schema> {
  return tool(
    APP_ADVISOR_TOOL_REGISTRY[key].displayName,
    description,
    schemaShape,
    async (args: unknown) =>
      toMcpToolResult(await executeAppAdvisorTool(key, args, runtime)),
  );
}

export function createAppAdvisorMcpServer(
  runtime: AppAdvisorToolRuntime,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: `${BRAND.tools.namespace}_app_advisor`,
    version: '1.0.0',
    tools: [
      appAdvisorTool(
        'set_auto_archive',
        SET_AUTO_ARCHIVE_DESCRIPTION,
        setAutoArchiveSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'set_work_entry_auto_delete',
        SET_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
        setWorkEntryAutoDeleteSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'set_project_work_entry_auto_delete',
        APP_ADVISOR_SET_PROJECT_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
        appAdvisorSetProjectWorkEntryAutoDeleteSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'start_forked_agent',
        APP_ADVISOR_START_FORKED_AGENT_DESCRIPTION,
        startSplitAgentSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'ask_user_question',
        ASK_USER_QUESTION_DESCRIPTION,
        askUserQuestionSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'get_script_output',
        APP_ADVISOR_GET_SCRIPT_OUTPUT_DESCRIPTION,
        appAdvisorGetScriptOutputSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'read_pipeline_yaml',
        APP_ADVISOR_READ_PIPELINE_YAML_DESCRIPTION,
        appAdvisorReadPipelineYamlBaseSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'show_capabilities',
        SHOW_CAPABILITIES_DESCRIPTION,
        showCapabilitiesSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'show_files',
        APP_ADVISOR_SHOW_FILES_DESCRIPTION,
        appAdvisorShowFilesSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'get_file_comments',
        APP_ADVISOR_GET_FILE_COMMENTS_DESCRIPTION,
        appAdvisorGetFileCommentsSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'respond_to_file_comment',
        APP_ADVISOR_RESPOND_TO_FILE_COMMENT_DESCRIPTION,
        appAdvisorRespondToFileCommentSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'search_actions',
        SEARCH_ACTIONS_DESCRIPTION,
        searchActionsToolShape,
        runtime,
      ),
      appAdvisorTool(
        'get_current_ui_state',
        GET_CURRENT_UI_STATE_DESCRIPTION,
        getCurrentUiStateSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'dispatch_action',
        DISPATCH_ACTION_DESCRIPTION,
        dispatchActionToolSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'get_pipeline_debug_context',
        GET_PIPELINE_DEBUG_CONTEXT_DESCRIPTION,
        getPipelineDebugContextSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'search_watchers',
        SEARCH_WATCHERS_DESCRIPTION,
        searchWatchersToolShape,
        runtime,
      ),
      appAdvisorTool(
        'setup_watchers',
        SETUP_WATCHERS_DESCRIPTION,
        setupWatchersToolShape,
        runtime,
      ),
      appAdvisorTool(
        'watch_github_items',
        WATCH_GITHUB_ITEMS_DESCRIPTION,
        watchGitHubItemsSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'get_github_pull_request_status',
        GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
        getGitHubPullRequestStatusSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'watch_command',
        WATCH_COMMAND_DESCRIPTION,
        watchCommandSchema.shape,
        runtime,
      ),
      appAdvisorTool(
        'schedule_wakeup',
        SCHEDULE_WAKEUP_DESCRIPTION,
        scheduleWakeupSchema.shape,
        runtime,
      ),
    ],
  });
}
