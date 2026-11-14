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
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  getCanonicalCanopyToolKey,
  isInvocationKeyedInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import { VISUAL_PREVIEW_BUDGETS } from '../browser/visual-preview-types';
import { BRAND } from '@canopy/brand/current';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolContext,
  type CanopyInjectedToolRuntime,
} from '../canopy-tools/core';
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
  GET_IMPACT_RADIUS_DESCRIPTION,
  GET_REVIEW_CONTEXT_DESCRIPTION,
  GET_SCRIPT_OUTPUT_DESCRIPTION,
  QUERY_CODE_GRAPH_DESCRIPTION,
  READ_PIPELINE_YAML_DESCRIPTION,
  READ_MEMORY_DESCRIPTION,
  SEARCH_CHATS_DESCRIPTION,
  READ_CHAT_EXCERPT_DESCRIPTION,
  SAVE_MEMORY_DESCRIPTION,
  SEARCH_MEMORY_DESCRIPTION,
  SHOW_FILES_DESCRIPTION,
  SHOW_VISUAL_DESCRIPTION,
  RESPOND_TO_FILE_COMMENT_DESCRIPTION,
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
  getReviewCommentsSchema,
  getScriptOutputJsonSchema,
  queryCodeGraphJsonSchema,
  readPipelineYamlJsonSchema,
  readMemoryJsonSchema,
  searchChatsJsonSchema,
  readChatExcerptJsonSchema,
  saveMemoryJsonSchema,
  searchMemoryJsonSchema,
  showFilesJsonSchema,
  showVisualJsonSchema,
  previewVisualJsonSchema,
  PREVIEW_VISUAL_DESCRIPTION,
  respondToFileCommentJsonSchema,
  respondToCommentSchema,
  searchActionsJsonSchema,
  searchCodeGraphJsonSchema,
  searchWatchersJsonSchema,
  setupWatchersJsonSchema,
  watchGitHubItemsJsonSchema,
  getGitHubPullRequestStatusJsonSchema,
} from '../canopy-tools/definitions';
import { buildLedgerCodexDynamicToolSpecs } from '@canopy/execution-engine/node/ledger-tools/definitions';
import {
  LOAD_DEFERRED_TOOLS_DESCRIPTION,
  SEARCH_DEFERRED_TOOLS_DESCRIPTION,
  loadDeferredToolsJsonSchema,
  searchDeferredToolsJsonSchema,
} from '../deferred-tools/definitions';
import { readLocalMemory } from '../canopy-tools/session-runtime';
import type { DynamicToolCallParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import { defineCodexFunctionToolSpec } from './dynamic-tool-spec';
import { applyToolSchemaProfile } from './tool-schema-profile';
import type { AiGatewayToolSchemaProfile } from '@canopy/protocol/ai-gateway-models';

/**
 * Codex dynamic tool name for the bespoke comment-reply tool, kept for the
 * code-review compatibility dispatch. It is intentionally NOT part of the
 * canonical injected-tool registry.
 */
export const respondToCommentCodexToolName = `${BRAND.tools.namespace}_respond_to_comment`;

/**
 * Codex dynamic tool name for the bespoke code-review comment-read tool. It is
 * intentionally NOT part of the canonical injected-tool registry. Code-review
 * sessions reuse `respondToCommentCodexToolName` (with a review-specific
 * description) for the reply side.
 */
export const getReviewCommentsCodexToolName = `${BRAND.tools.namespace}_get_review_comments`;

/**
 * Codex-only control tool used after an MCP OAuth refresh. It is deliberately
 * bespoke rather than part of the shared Claude/Codex injected-tool registry:
 * Claude can refresh its live MCP client without restarting the provider turn.
 */
export const immediateTurnRestartCodexToolName = `${BRAND.tools.namespace}_immediate_turn_restart`;

const IMMEDIATE_TURN_RESTART_DESCRIPTION =
  'End and immediately resume this Codex turn so MCP connections refreshed during the turn become available. Call only when a system steer says a specific MCP server just connected and the current request actually needs that server. The resumed turn preserves the logical user request and elapsed turn timer.';

const immediateTurnRestartJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export { buildLedgerCodexDynamicToolSpecs };

export function buildCanopyDynamicToolSpecs(options: {
  includeWorktreeActions?: boolean;
  /**
   * Tool-surface mode, mirroring the Claude allowlist split
   * (`native-sdk` vs `native-sdk-standalone` in
   * `@canopy/execution-engine/lib/canopy-injected-tools`):
   * - `'worktree'` — full worktree set (equivalent to
   *   `includeWorktreeActions: true`).
   * - `'cowork'` — the Cowork directory-scoped set: ask-user,
   *   read_pipeline_yaml, search/dispatch actions, watchers (including
   *   GitHub watchers), the GitHub pull request status read,
   *   get_script_output, and set_auto_archive; no git
   *   preferences or code-graph.
   * - `'minimal'` — base tools only (equivalent to
   *   `includeWorktreeActions: false`).
   * When omitted, derived from `includeWorktreeActions` for compatibility.
   */
  mode?: 'worktree' | 'cowork' | 'minimal';
  isCodeReview?: boolean;
  /**
   * Gates the nine code-graph dynamic tool specs. Set from the code-graph
   * feature flag at the call site (codex-session.ts). Only consulted in
   * `'worktree'` mode, since the code-graph specs live inside the
   * worktree-actions block. Defaults to true so existing callers keep
   * advertising them.
   */
  includeCodeGraph?: boolean;
  /**
   * Adds AddFeedEntry, SearchFeedEntries and UpdateFeedEntry in
   * `'worktree'` and `'cowork'` modes. Set only for a session that passed
   * the Ledger exposure gate (`canopy-ledger-enabled`, "Agents add to the
   * Feed" and a resolvable scope). Dynamic tools are fixed when a thread
   * starts, so a thread keeps the Ledger tools it started with and every
   * call re-checks the gate. Defaults to false.
   */
  includeLedger?: boolean;
  includeChatVisuals: boolean;
  /**
   * ShowFiles is advertised only while the main window's interface lease
   * serves it (CAN-4131). Defaults to true.
   */
  includeShowFiles?: boolean;
  /**
   * Projection profile for advertised tool JSON Schemas. Runtime Zod
   * validation is unaffected; the JSON schema is advisory to the model.
   */
  toolSchemaProfile?: AiGatewayToolSchemaProfile;
}): DynamicToolSpec[] {
  const mode =
    options.mode ??
    ((options.includeWorktreeActions ?? true) ? 'worktree' : 'minimal');
  const toolSchemaProfile = options.toolSchemaProfile ?? 'standard';
  const finalize = (specs: DynamicToolSpec[]): DynamicToolSpec[] =>
    toolSchemaProfile === 'standard'
      ? specs
      : specs.map((spec) =>
          spec.type === 'function'
            ? {
                ...spec,
                inputSchema: applyToolSchemaProfile(
                  spec.inputSchema,
                  toolSchemaProfile,
                ),
              }
            : spec,
        );
  const includeCodeGraph = options.includeCodeGraph ?? true;
  const ledgerTools: DynamicToolSpec[] = options.includeLedger
    ? buildLedgerCodexDynamicToolSpecs()
    : [];
  const tools: DynamicToolSpec[] = [
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.codexToolName,
      description: ASK_USER_QUESTION_DESCRIPTION,
      inputSchema: askUserQuestionJsonSchema,
    }),
    // Cowork chats never have worktree scripts; GetScriptOutput would only
    // hard-fail at execution (session-runtime), so it is not advertised.
    ...(mode !== 'cowork'
      ? [
          defineCodexFunctionToolSpec({
            name: CANOPY_INJECTED_TOOL_REGISTRY.get_script_output.codexToolName,
            description: GET_SCRIPT_OUTPUT_DESCRIPTION,
            inputSchema: getScriptOutputJsonSchema,
          }),
        ]
      : []),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.read_pipeline_yaml.codexToolName,
      description: READ_PIPELINE_YAML_DESCRIPTION,
      inputSchema: readPipelineYamlJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.search_deferred_tools.codexToolName,
      description: SEARCH_DEFERRED_TOOLS_DESCRIPTION,
      inputSchema: searchDeferredToolsJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.codexToolName,
      description: LOAD_DEFERRED_TOOLS_DESCRIPTION,
      inputSchema: loadDeferredToolsJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: immediateTurnRestartCodexToolName,
      description: IMMEDIATE_TURN_RESTART_DESCRIPTION,
      inputSchema: immediateTurnRestartJsonSchema,
    }),
  ];
  if (mode === 'minimal') {
    return finalize(tools);
  }
  const actionTools: DynamicToolSpec[] = [
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.save_memory.codexToolName,
      description: SAVE_MEMORY_DESCRIPTION,
      inputSchema: saveMemoryJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.search_memory.codexToolName,
      description: SEARCH_MEMORY_DESCRIPTION,
      inputSchema: searchMemoryJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.search_chats.codexToolName,
      description: SEARCH_CHATS_DESCRIPTION,
      inputSchema: searchChatsJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.read_chat_excerpt.codexToolName,
      description: READ_CHAT_EXCERPT_DESCRIPTION,
      inputSchema: readChatExcerptJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.read_memory.codexToolName,
      description: READ_MEMORY_DESCRIPTION,
      inputSchema: readMemoryJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.show_capabilities.codexToolName,
      description: SHOW_CAPABILITIES_DESCRIPTION,
      inputSchema: showCapabilitiesJsonSchema,
    }),
    ...(options.includeShowFiles !== false
      ? [
          defineCodexFunctionToolSpec({
            name: CANOPY_INJECTED_TOOL_REGISTRY.show_files.codexToolName,
            description: SHOW_FILES_DESCRIPTION,
            inputSchema: showFilesJsonSchema,
          }),
        ]
      : []),
    ...(options.includeChatVisuals
      ? [
          defineCodexFunctionToolSpec({
            name: CANOPY_INJECTED_TOOL_REGISTRY.show_visual.codexToolName,
            description: SHOW_VISUAL_DESCRIPTION,
            inputSchema: showVisualJsonSchema,
          }),
          defineCodexFunctionToolSpec({
            name: CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.codexToolName,
            description: PREVIEW_VISUAL_DESCRIPTION,
            inputSchema: previewVisualJsonSchema,
          }),
        ]
      : []),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.get_file_comments.codexToolName,
      description: GET_FILE_COMMENTS_DESCRIPTION,
      inputSchema: getFileCommentsJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.respond_to_file_comment.codexToolName,
      description: RESPOND_TO_FILE_COMMENT_DESCRIPTION,
      inputSchema: respondToFileCommentJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.search_actions.codexToolName,
      description: SEARCH_ACTIONS_DESCRIPTION,
      inputSchema: searchActionsJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.codexToolName,
      description: DISPATCH_ACTION_DESCRIPTION,
      inputSchema:
        mode === 'cowork'
          ? coworkDispatchActionJsonSchema
          : dispatchActionJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.search_watchers.codexToolName,
      description: SEARCH_WATCHERS_DESCRIPTION,
      inputSchema: searchWatchersJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.setup_watchers.codexToolName,
      description: SETUP_WATCHERS_DESCRIPTION,
      inputSchema: setupWatchersJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.watch_github_items.codexToolName,
      description: WATCH_GITHUB_ITEMS_DESCRIPTION,
      inputSchema: watchGitHubItemsJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.get_github_pull_request_status
        .codexToolName,
      description: GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
      inputSchema: getGitHubPullRequestStatusJsonSchema,
    }),
    ...(mode === 'worktree'
      ? [
          defineCodexFunctionToolSpec({
            name: CANOPY_INJECTED_TOOL_REGISTRY.delete_watchers.codexToolName,
            description: DELETE_WATCHERS_DESCRIPTION,
            inputSchema: deleteWatchersJsonSchema,
          }),
        ]
      : []),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.watch_command.codexToolName,
      description: WATCH_COMMAND_DESCRIPTION,
      inputSchema: watchCommandJsonSchema,
    }),
    ...(mode !== 'worktree'
      ? [
          defineCodexFunctionToolSpec({
            name: CANOPY_INJECTED_TOOL_REGISTRY.get_script_output.codexToolName,
            description: GET_SCRIPT_OUTPUT_DESCRIPTION,
            inputSchema: getScriptOutputJsonSchema,
          }),
          defineCodexFunctionToolSpec({
            name: CANOPY_INJECTED_TOOL_REGISTRY.delete_watchers.codexToolName,
            description: DELETE_WATCHERS_DESCRIPTION,
            inputSchema: deleteWatchersJsonSchema,
          }),
        ]
      : []),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup.codexToolName,
      description: SCHEDULE_WAKEUP_DESCRIPTION,
      inputSchema: scheduleWakeupJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.set_auto_archive.codexToolName,
      description: SET_AUTO_ARCHIVE_DESCRIPTION,
      inputSchema: setAutoArchiveJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.set_work_entry_auto_delete
        .codexToolName,
      description: SET_WORK_ENTRY_AUTO_DELETE_DESCRIPTION,
      inputSchema: setWorkEntryAutoDeleteJsonSchema,
    }),
  ];
  if (mode === 'cowork') {
    return finalize([
      ...tools,
      ...actionTools,
      defineCodexFunctionToolSpec({
        name: CANOPY_INJECTED_TOOL_REGISTRY.start_forked_agent.codexToolName,
        description: START_FORKED_AGENT_DESCRIPTION,
        inputSchema: startSplitAgentJsonSchema,
      }),
      ...ledgerTools,
    ]);
  }
  const worktreeActionTools: DynamicToolSpec[] = [
    ...tools,
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.get_git_preferences.codexToolName,
      description: GET_GIT_PREFERENCES_DESCRIPTION,
      inputSchema: getGitPreferencesJsonSchema,
    }),
    ...actionTools,
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.start_forked_agent.codexToolName,
      description: START_FORKED_AGENT_DESCRIPTION,
      inputSchema: startSplitAgentJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.start_branched_agent.codexToolName,
      description: START_BRANCHED_AGENT_DESCRIPTION,
      inputSchema: startSplitAgentJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.set_base_branch.codexToolName,
      description: SET_BASE_BRANCH_DESCRIPTION,
      inputSchema: setBaseBranchJsonSchema,
    }),
  ];
  if (!includeCodeGraph) {
    return finalize([...worktreeActionTools, ...ledgerTools]);
  }
  // Keep in sync with CODE_GRAPH_INJECTED_TOOL_KEYS in @canopy/desktop-shared
  // (canopy-injected-tools.ts) — a new code-graph tool must be added here too.
  return finalize([
    ...worktreeActionTools,
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.get_code_graph_context.codexToolName,
      description: GET_CODE_GRAPH_CONTEXT_DESCRIPTION,
      inputSchema: getCodeGraphContextJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.build_or_update_code_graph
        .codexToolName,
      description: BUILD_OR_UPDATE_CODE_GRAPH_DESCRIPTION,
      inputSchema: buildOrUpdateCodeGraphJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.query_code_graph.codexToolName,
      description: QUERY_CODE_GRAPH_DESCRIPTION,
      inputSchema: queryCodeGraphJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.search_code_graph.codexToolName,
      description: SEARCH_CODE_GRAPH_DESCRIPTION,
      inputSchema: searchCodeGraphJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.explain_code_symbol.codexToolName,
      description: EXPLAIN_CODE_SYMBOL_DESCRIPTION,
      inputSchema: explainCodeSymbolJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.get_impact_radius.codexToolName,
      description: GET_IMPACT_RADIUS_DESCRIPTION,
      inputSchema: getImpactRadiusJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.detect_changed_symbols.codexToolName,
      description: DETECT_CHANGED_SYMBOLS_DESCRIPTION,
      inputSchema: detectChangedSymbolsJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.compare_change_impact.codexToolName,
      description: COMPARE_CHANGE_IMPACT_DESCRIPTION,
      inputSchema: compareChangeImpactJsonSchema,
    }),
    defineCodexFunctionToolSpec({
      name: CANOPY_INJECTED_TOOL_REGISTRY.get_review_context.codexToolName,
      description: GET_REVIEW_CONTEXT_DESCRIPTION,
      inputSchema: getReviewContextJsonSchema,
    }),
    ...ledgerTools,
  ]);
}

export async function handleCanopyDynamicToolCall(
  params: DynamicToolCallParams,
  runtime: CanopyInjectedToolRuntime,
  context?: Pick<CanopyInjectedToolContext, 'signal'>,
): Promise<DynamicToolCallResponse> {
  if (params.tool === immediateTurnRestartCodexToolName) {
    return {
      contentItems: [
        {
          type: 'inputText',
          text: 'Restarting this turn with refreshed MCP connections.',
        },
      ],
      success: true,
    };
  }

  if (params.tool === respondToCommentCodexToolName) {
    const parsed = respondToCommentSchema.safeParse(params.arguments);
    // Only legacy code-review sessions provide a reply hook; the retired
    // plan-chat takeover's reply tool is no longer bound.
    const respondFn = runtime.respondToReviewComment;
    if (!parsed.success || !respondFn) {
      return {
        contentItems: [
          {
            type: 'inputText',
            text: 'Invalid or unavailable RespondToComment call.',
          },
        ],
        success: false,
      };
    }
    const result = await respondFn({
      threadId: parsed.data.threadId,
      body: parsed.data.body,
      resolve: parsed.data.resolve ?? false,
    });
    return {
      contentItems: [
        {
          type: 'inputText',
          text: result.ok
            ? `Reply posted to thread ${parsed.data.threadId}${result.resolved ? ' and resolved' : ''}.`
            : `Reply failed: ${result.error ?? 'unknown'}`,
        },
      ],
      success: result.ok,
    };
  }

  if (params.tool === getReviewCommentsCodexToolName) {
    const parsed = getReviewCommentsSchema.safeParse(params.arguments);
    if (!parsed.success || !runtime.getReviewCommentThread) {
      return {
        contentItems: [
          {
            type: 'inputText',
            text: 'Invalid or unavailable GetReviewComments call.',
          },
        ],
        success: false,
      };
    }
    const result = await runtime.getReviewCommentThread(
      parsed.data.threadId !== undefined
        ? { threadId: parsed.data.threadId }
        : {},
    );
    return {
      contentItems: [
        {
          type: 'inputText',
          text: result.ok
            ? result.text
            : `Failed to read comments: ${result.error ?? 'unknown'}`,
        },
      ],
      success: result.ok,
    };
  }

  const liveCodexTools = new Set([
    ...Object.values(CANOPY_INJECTED_TOOL_REGISTRY).map(
      (entry) => entry.codexToolName,
    ),
  ]);
  if (!liveCodexTools.has(params.tool)) {
    return {
      contentItems: [
        {
          type: 'inputText',
          text: `Unsupported dynamic tool: ${params.tool}`,
        },
      ],
      success: false,
    };
  }

  const canonicalKey = getCanonicalCanopyToolKey(params.tool);
  if (!canonicalKey) {
    return {
      contentItems: [
        {
          type: 'inputText',
          text: `Unsupported dynamic tool: ${params.tool}`,
        },
      ],
      success: false,
    };
  }

  const memoryScope = runtime.deferredToolsRuntime?.scope;
  const effectiveRuntime: CanopyInjectedToolRuntime =
    canonicalKey === 'read_memory' &&
    runtime.readLocalMemory === undefined &&
    memoryScope !== undefined
      ? {
          ...runtime,
          readLocalMemory: (request) =>
            readLocalMemory({
              projectId: memoryScope.projectId,
              worktreeId: memoryScope.worktreeId,
              ...request,
            }),
        }
      : runtime;
  const result = await executeCanopyInjectedTool(
    canonicalKey,
    params.arguments,
    effectiveRuntime,
    {
      toolUseId: `codex-${params.callId}`,
      codexCallId: params.callId,
      ...(canonicalKey === 'preview_visual'
        ? {
            imageBudgetBytes: Math.floor(
              ((VISUAL_PREVIEW_BUDGETS.codexResponseBytes -
                VISUAL_PREVIEW_BUDGETS.codexTextBytes -
                2048) *
                3) /
                4,
            ),
          }
        : {}),
      ...(context?.signal ? { signal: context.signal } : {}),
      // Codex resends the same thread, turn and call IDs for one call, so a
      // Ledger or SaveMemory key derived from them dedupes its retries and
      // replays.
      ...(isInvocationKeyedInjectedToolKey(canonicalKey)
        ? {
            invocationId: `codex:${params.threadId}:${params.turnId}:${params.callId}`,
          }
        : {}),
    },
  );

  const text =
    canonicalKey === 'preview_visual'
      ? fitPreviewTextForCodex(result.text)
      : result.text;
  const contentItems = [
    { type: 'inputText' as const, text },
    ...(result.imageDataUrl
      ? [{ type: 'inputImage' as const, imageUrl: result.imageDataUrl }]
      : []),
  ];
  const success = result.isError !== true;
  if (
    canonicalKey === 'preview_visual' &&
    Buffer.byteLength(JSON.stringify({ success, contentItems }), 'utf8') >
      VISUAL_PREVIEW_BUDGETS.codexResponseBytes
  ) {
    return {
      success,
      contentItems: [
        {
          type: 'inputText',
          text: `${text}\nScreenshot omitted to fit the response limit.`,
        },
      ],
    };
  }
  return { contentItems, success };
}

/**
 * Codex measures a dynamic tool response after JSON escaping, and page
 * output can escape to six times its raw size. Cut the text to its share of
 * the response as serialized, so the screenshot's share stays free and the
 * text alone always fits.
 */
function fitPreviewTextForCodex(text: string): string {
  const fits = (value: string): boolean =>
    Buffer.byteLength(JSON.stringify(value), 'utf8') <=
    VISUAL_PREVIEW_BUDGETS.codexTextBytes;
  if (fits(text)) return text;
  const notice = '\nMore diagnostics omitted to fit the response limit.';
  let length = 0;
  let high = text.length;
  while (length < high) {
    const middle = Math.ceil((length + high) / 2);
    if (fits(`${text.slice(0, middle)}${notice}`)) length = middle;
    else high = middle - 1;
  }
  // Never end on the first half of a surrogate pair.
  const last = text.charCodeAt(length - 1);
  if (last >= 0xd800 && last <= 0xdbff) length--;
  return `${text.slice(0, length)}${notice}`;
}
