/**
 * Single source of truth for the capabilities that Canopy injects into the
 * chat providers. Keep this file dependency-free apart from the brand
 * runtime import so both the main process and the renderer can import it.
 *
 * The canonical Canopy-injected capability set is:
 *   - AskUserQuestion
 *   - GetScriptOutput
 *   - GetGitPreferences
 *   - SaveMemory
 *   - SearchMemory
 *   - ReadMemory
 *   - ReadPipelineYaml
 *   - SearchActions
 *   - DispatchAction
 *   - SearchWatchers
 *   - SetupWatchers
 *   - WatchGitHubItems
 *   - GetGitHubPullRequestStatus
 *   - DeleteWatchers
 *   - SetChatAutoArchive
 *   - SetWorkEntryAutoDelete
 *   - SetBaseBranch
 *   - StartForkedAgent
 *   - StartBranchedAgent
 *   - GetCodeGraphContext
 *   - BuildOrUpdateCodeGraph
 *   - QueryCodeGraph
 *   - SearchCodeGraph
 *   - ExplainCodeSymbol
 *   - GetImpactRadius
 *   - DetectChangedSymbols
 *   - CompareChangeImpact
 *   - GetReviewContext
 *
 * Provider-accurate raw names:
 *   - Claude (MCP): all tool names are derived from `BRAND.tools.namespace`.
 *   - Codex (dynamic): all tool names are derived from `BRAND.tools.namespace`.
 *
 * For the Canopy default (`namespace === "canopy"`), live advertised names
 * stay exactly the historical Canopy names so existing Claude-Code MCP
 * configs continue to resolve.
 *
 * `legacyToolNames` records persisted/historical raw names used by
 * `getCanonicalCanopyToolKey` and `normalizeCanopyInjectedToolName` for
 * transcript-display purposes ONLY. They MUST NOT cause legacy names to
 * appear in any live advertised tool set.
 *
 * `SearchActions` and `DispatchAction` are envelopes over the shared typed
 * action catalog, not one provider tool per action. Worktree and cowork
 * runtimes inject trusted scope server-side and expose headless skill,
 * pipeline, automation, browser, watcher, and other scope-appropriate action
 * families. Successful resource actions may retain their existing result
 * fields while adding versioned `agentArtifacts` receipt metadata.
 */

import { buildInjectedToolNamesForBrand } from '@canopy/protocol/brand';
import { BRAND } from '@canopy/brand/current';

export type CanopyInjectedToolKey =
  | 'ask_user_question'
  | 'get_script_output'
  | 'get_git_preferences'
  | 'save_memory'
  | 'search_memory'
  | 'read_memory'
  | 'read_pipeline_yaml'
  | 'show_files'
  | 'show_capabilities'
  | 'show_visual'
  | 'preview_visual'
  | 'get_file_comments'
  | 'respond_to_file_comment'
  | 'search_actions'
  | 'dispatch_action'
  | 'search_watchers'
  | 'setup_watchers'
  | 'watch_github_items'
  | 'get_github_pull_request_status'
  | 'watch_command'
  | 'schedule_wakeup'
  | 'delete_watchers'
  | 'set_auto_archive'
  | 'set_work_entry_auto_delete'
  | 'set_base_branch'
  | 'start_forked_agent'
  | 'start_branched_agent'
  | 'get_code_graph_context'
  | 'build_or_update_code_graph'
  | 'query_code_graph'
  | 'search_code_graph'
  | 'explain_code_symbol'
  | 'get_impact_radius'
  | 'detect_changed_symbols'
  | 'compare_change_impact'
  | 'get_review_context'
  | 'search_deferred_tools'
  | 'load_deferred_tools'
  | 'add_ledger_entry'
  | 'search_ledger_entries'
  | 'update_ledger_entry'
  | 'delegate_task'
  | 'get_delegate_output'
  | 'inspect_delegate'
  | 'list_delegates'
  | 'stop_delegate'
  | 'manage_delegate_worktree'
  | 'message_delegate'
  | 'request_steering';

/**
 * The nine code-graph injected tool keys. This is the single shared source of
 * truth for "which injected tools belong to the code-graph feature", consumed
 * by the desktop feature-flag gates (advertisement, execution) so Claude's
 * `tools/list`, the Codex dynamic-tool specs, and the shared execution
 * dispatcher all reference one list. Pure data — no runtime coupling — so it
 * stays inside this env-neutral registry module.
 */
export const CODE_GRAPH_INJECTED_TOOL_KEYS: readonly CanopyInjectedToolKey[] = [
  'get_code_graph_context',
  'build_or_update_code_graph',
  'query_code_graph',
  'search_code_graph',
  'explain_code_symbol',
  'get_impact_radius',
  'detect_changed_symbols',
  'compare_change_impact',
  'get_review_context',
];

const CODE_GRAPH_INJECTED_TOOL_KEY_SET: ReadonlySet<CanopyInjectedToolKey> =
  new Set(CODE_GRAPH_INJECTED_TOOL_KEYS);

/**
 * Managed delegation tools that list, read, message or stop delegates
 * a spawn already started. They are app plumbing rather than agent work, so
 * turn summaries count them with the other app tools; the spawn itself
 * (`delegate_task`) counts as agent work, and every row shows the app logo.
 */
export const MANAGED_DELEGATION_APP_TOOL_KEYS: readonly CanopyInjectedToolKey[] =
  [
    'get_delegate_output',
    'inspect_delegate',
    'list_delegates',
    'stop_delegate',
    'manage_delegate_worktree',
    'message_delegate',
    'request_steering',
  ];

const MANAGED_DELEGATION_APP_TOOL_KEY_SET: ReadonlySet<CanopyInjectedToolKey> =
  new Set(MANAGED_DELEGATION_APP_TOOL_KEYS);

/** Whether `key` is a managed delegation tool other than the spawn. */
export function isManagedDelegationAppToolKey(
  key: CanopyInjectedToolKey | null,
): boolean {
  return key !== null && MANAGED_DELEGATION_APP_TOOL_KEY_SET.has(key);
}

/**
 * True when a canonical injected-tool key belongs to the code-graph feature.
 */
export function isCodeGraphInjectedToolKey(
  key: CanopyInjectedToolKey,
): boolean {
  return CODE_GRAPH_INJECTED_TOOL_KEY_SET.has(key);
}

/**
 * The three Agent Ledger injected tool keys: the shared source of truth for
 * "which injected tools belong to the Ledger", consumed by the exposure gate
 * (the `canopy-ledger-enabled` flag, the "Agents add to the Feed" setting and
 * a resolvable scope binding) at advertisement and execution.
 */
export const LEDGER_INJECTED_TOOL_KEYS: readonly CanopyInjectedToolKey[] = [
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
];

const LEDGER_INJECTED_TOOL_KEY_SET: ReadonlySet<CanopyInjectedToolKey> =
  new Set(LEDGER_INJECTED_TOOL_KEYS);

/** True when a canonical injected-tool key belongs to the Agent Ledger. */
export function isLedgerInjectedToolKey(key: CanopyInjectedToolKey): boolean {
  return LEDGER_INJECTED_TOOL_KEY_SET.has(key);
}

/**
 * True when the tool's core write derives its idempotency key from the
 * provider's invocation identity: the Ledger tools, SaveMemory (CAN-5993) and
 * LoadDeferredTools (CAN-5995).
 */
export function isInvocationKeyedInjectedToolKey(
  key: CanopyInjectedToolKey,
): boolean {
  return (
    isLedgerInjectedToolKey(key) ||
    key === 'save_memory' ||
    key === 'load_deferred_tools' ||
    key === 'set_auto_archive'
  );
}

export type CanopyInjectedToolDisplayName =
  | 'AskUserQuestion'
  | 'GetScriptOutput'
  | 'GetGitPreferences'
  | 'SaveMemory'
  | 'SearchMemory'
  | 'ReadMemory'
  | 'ReadPipelineYaml'
  | 'ShowFiles'
  | 'ShowCapabilities'
  | 'ShowVisual'
  | 'PreviewVisual'
  | 'GetFileComments'
  | 'RespondToFileComment'
  | 'SearchActions'
  | 'DispatchAction'
  | 'SearchWatchers'
  | 'SetupWatchers'
  | 'WatchGitHubItems'
  | 'GetGitHubPullRequestStatus'
  | 'WatchCommand'
  | 'ScheduleWakeup'
  | 'DeleteWatchers'
  | 'SetChatAutoArchive'
  | 'SetWorkEntryAutoDelete'
  | 'SetBaseBranch'
  | 'StartForkedAgent'
  | 'StartBranchedAgent'
  | 'GetCodeGraphContext'
  | 'BuildOrUpdateCodeGraph'
  | 'QueryCodeGraph'
  | 'SearchCodeGraph'
  | 'ExplainCodeSymbol'
  | 'GetImpactRadius'
  | 'DetectChangedSymbols'
  | 'CompareChangeImpact'
  | 'GetReviewContext'
  | 'SearchDeferredTools'
  | 'LoadDeferredTools'
  | 'AddFeedEntry'
  | 'SearchFeedEntries'
  | 'UpdateFeedEntry'
  | 'DelegateTask'
  | 'GetDelegateOutput'
  | 'InspectDelegate'
  | 'ListDelegates'
  | 'StopDelegate'
  | 'ManageDelegateWorktree'
  | 'MessageDelegate'
  | 'RequestSteering';

export type CanopyInjectedToolProvider =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'opencode';

export interface CanopyInjectedToolExposure {
  canonicalKey: CanopyInjectedToolKey;
  displayName: CanopyInjectedToolDisplayName;
  claudeToolName: string;
  codexToolName: string;
  /**
   * The title the pinned Cursor CLI gives an ACP `tool_call` (and permission
   * request) for this tool: `"<mcp server>: <advertised tool name>"`. Cursor
   * reaches these tools through the app's HTTP MCP servers, so the advertised
   * name is the display name and the server is the brand namespace (`_ui` for
   * AskUserQuestion, matching the Claude `_ui` server split).
   */
  cursorToolName: string;
  legacyToolNames: string[];
}

const BRANDED_TOOL_NAMES = buildInjectedToolNamesForBrand(BRAND);
const cursorMcpToolTitle = (
  displayName: CanopyInjectedToolDisplayName,
): string =>
  `${
    displayName === 'AskUserQuestion'
      ? `${BRAND.tools.namespace}_ui`
      : BRAND.tools.namespace
  }: ${displayName}`;
const LEGACY_CANOPY_TOOL_NAMESPACE = ['cano', 'py'].join('');
const legacyMcpToolName = (name: string): string =>
  `mcp__${LEGACY_CANOPY_TOOL_NAMESPACE}__${name}`;
const legacyCodexToolName = (suffix: string): string =>
  `${LEGACY_CANOPY_TOOL_NAMESPACE}_${suffix}`;

/**
 * Historical Canopy raw names that older transcripts persist. For the
 * default Canopy brand these are also the live names, so the only entry
 * recorded as "legacy" is the bare display name. For non-Canopy brands the
 * full historical set is recorded so existing user transcripts continue to
 * render correctly.
 */
const HISTORICAL_CANOPY_NAMES: Readonly<
  Record<CanopyInjectedToolKey, readonly string[]>
> = {
  ask_user_question: [
    legacyMcpToolName('AskUserQuestion'),
    legacyCodexToolName('ask_user_question'),
    'AskUserQuestion',
    `mcp__${BRAND.tools.namespace}__AskUserQuestion`,
    `mcp__${BRAND.tools.namespace}_app_advisor__AskUserQuestion`,
  ],
  get_script_output: [
    legacyMcpToolName('GetScriptOutput'),
    legacyCodexToolName('get_script_output'),
    'GetScriptOutput',
  ],
  get_git_preferences: [
    legacyMcpToolName('GetGitPreferences'),
    legacyCodexToolName('get_git_preferences'),
    'GetGitPreferences',
  ],
  save_memory: ['SaveMemory'],
  search_memory: ['SearchMemory'],
  read_memory: ['ReadMemory'],
  read_pipeline_yaml: [
    legacyMcpToolName('ReadPipelineYaml'),
    legacyCodexToolName('read_pipeline_yaml'),
    'ReadPipelineYaml',
  ],
  show_files: ['ShowFiles'],
  show_capabilities: [
    legacyMcpToolName('ShowCapabilities'),
    legacyCodexToolName('show_capabilities'),
    'ShowCapabilities',
  ],
  show_visual: [],
  preview_visual: [],
  get_file_comments: ['GetFileComments'],
  respond_to_file_comment: ['RespondToFileComment'],
  search_actions: [
    legacyMcpToolName('SearchActions'),
    legacyCodexToolName('search_actions'),
    'SearchActions',
  ],
  dispatch_action: [
    legacyMcpToolName('DispatchAction'),
    legacyCodexToolName('dispatch_action'),
    'DispatchAction',
  ],
  search_watchers: [
    legacyMcpToolName('SearchWatchers'),
    legacyCodexToolName('search_watchers'),
    'SearchWatchers',
  ],
  setup_watchers: [
    legacyMcpToolName('SetupWatchers'),
    legacyCodexToolName('setup_watchers'),
    'SetupWatchers',
  ],
  // New GitHub workflow-run watcher tool: no legacy names, since it never
  // advertised under any prior raw name.
  watch_github_items: ['WatchGitHubItems'],
  get_github_pull_request_status: [],
  watch_command: ['WatchCommand'],
  schedule_wakeup: [],
  delete_watchers: ['DeleteWatchers'],
  set_auto_archive: [
    legacyMcpToolName('ArchiveChat'),
    legacyCodexToolName('archive_chat'),
    'ArchiveChat',
    `mcp__${BRAND.tools.namespace}__ArchiveChat`,
    `${BRAND.tools.namespace}_archive_chat`,
    'SetAutoArchive',
    legacyMcpToolName('SetAutoArchive'),
    legacyCodexToolName('set_auto_archive'),
    `mcp__${BRAND.tools.namespace}__SetAutoArchive`,
    `${BRAND.tools.namespace}_set_auto_archive`,
    `${BRAND.tools.namespace}: SetAutoArchive`,
  ],
  set_work_entry_auto_delete: ['SetWorkEntryAutoDelete'],
  set_base_branch: ['SetBaseBranch'],
  start_forked_agent: ['StartForkedAgent'],
  start_branched_agent: ['StartBranchedAgent'],
  // New in Phase 2 of the code-graph feature: no legacy names, since these
  // tools never advertised under any prior raw name.
  get_code_graph_context: ['GetCodeGraphContext'],
  build_or_update_code_graph: ['BuildOrUpdateCodeGraph'],
  query_code_graph: ['QueryCodeGraph'],
  search_code_graph: ['SearchCodeGraph'],
  explain_code_symbol: ['ExplainCodeSymbol'],
  get_impact_radius: ['GetImpactRadius'],
  // New in Phase 4 of the code-graph feature: no legacy names, since these
  // tools never advertised under any prior raw name.
  detect_changed_symbols: ['DetectChangedSymbols'],
  compare_change_impact: ['CompareChangeImpact'],
  get_review_context: ['GetReviewContext'],
  // Deferred skills/plugins/MCP tools: no legacy names, since these tools
  // never advertised under any prior raw name.
  search_deferred_tools: ['SearchDeferredTools'],
  load_deferred_tools: ['LoadDeferredTools'],
  // The Agent Ledger tools advertised these names before they took the
  // Feed's: AddFeedEntry, SearchFeedEntries and UpdateFeedEntry.
  add_ledger_entry: [
    legacyMcpToolName('AddLedgerEntry'),
    legacyCodexToolName('add_ledger_entry'),
    `${LEGACY_CANOPY_TOOL_NAMESPACE}: AddLedgerEntry`,
    'AddLedgerEntry',
    `mcp__${BRAND.tools.namespace}__AddLedgerEntry`,
    `${BRAND.tools.namespace}_add_ledger_entry`,
    `${BRAND.tools.namespace}: AddLedgerEntry`,
  ],
  search_ledger_entries: [
    legacyMcpToolName('SearchLedgerEntries'),
    legacyCodexToolName('search_ledger_entries'),
    `${LEGACY_CANOPY_TOOL_NAMESPACE}: SearchLedgerEntries`,
    'SearchLedgerEntries',
    `mcp__${BRAND.tools.namespace}__SearchLedgerEntries`,
    `${BRAND.tools.namespace}_search_ledger_entries`,
    `${BRAND.tools.namespace}: SearchLedgerEntries`,
  ],
  update_ledger_entry: [
    legacyMcpToolName('UpdateLedgerEntry'),
    legacyCodexToolName('update_ledger_entry'),
    `${LEGACY_CANOPY_TOOL_NAMESPACE}: UpdateLedgerEntry`,
    'UpdateLedgerEntry',
    `mcp__${BRAND.tools.namespace}__UpdateLedgerEntry`,
    `${BRAND.tools.namespace}_update_ledger_entry`,
    `${BRAND.tools.namespace}: UpdateLedgerEntry`,
  ],
  delegate_task: ['DelegateTask'],
  get_delegate_output: [],
  inspect_delegate: ['InspectDelegate'],
  list_delegates: ['ListDelegates'],
  stop_delegate: ['StopDelegate'],
  manage_delegate_worktree: [
    legacyMcpToolName('ManageDelegate'),
    legacyCodexToolName('manage_delegate'),
    'ManageDelegate',
  ],
  message_delegate: [],
  request_steering: [],
};

function liveToolNamesFor(key: CanopyInjectedToolKey): readonly string[] {
  switch (key) {
    case 'ask_user_question':
      return [
        BRANDED_TOOL_NAMES.claude.askUserQuestion,
        BRANDED_TOOL_NAMES.codex.askUserQuestion,
      ];
    case 'get_script_output':
      return [
        BRANDED_TOOL_NAMES.claude.getScriptOutput,
        BRANDED_TOOL_NAMES.codex.getScriptOutput,
      ];
    case 'get_git_preferences':
      return [
        BRANDED_TOOL_NAMES.claude.getGitPreferences,
        BRANDED_TOOL_NAMES.codex.getGitPreferences,
      ];
    case 'save_memory':
      return [
        BRANDED_TOOL_NAMES.claude.saveMemory,
        BRANDED_TOOL_NAMES.codex.saveMemory,
      ];
    case 'search_memory':
      return [
        BRANDED_TOOL_NAMES.claude.searchMemory,
        BRANDED_TOOL_NAMES.codex.searchMemory,
      ];
    case 'read_memory':
      return [
        BRANDED_TOOL_NAMES.claude.readMemory,
        BRANDED_TOOL_NAMES.codex.readMemory,
      ];
    case 'read_pipeline_yaml':
      return [
        BRANDED_TOOL_NAMES.claude.readPipelineYaml,
        BRANDED_TOOL_NAMES.codex.readPipelineYaml,
      ];
    case 'show_files':
      return [
        BRANDED_TOOL_NAMES.claude.showFiles,
        BRANDED_TOOL_NAMES.codex.showFiles,
      ];
    case 'show_capabilities':
      return [
        BRANDED_TOOL_NAMES.claude.showCapabilities,
        BRANDED_TOOL_NAMES.codex.showCapabilities,
      ];
    case 'show_visual':
      return [
        BRANDED_TOOL_NAMES.claude.showVisual,
        BRANDED_TOOL_NAMES.codex.showVisual,
      ];
    case 'preview_visual':
      return [
        BRANDED_TOOL_NAMES.claude.previewVisual,
        BRANDED_TOOL_NAMES.codex.previewVisual,
      ];
    case 'get_file_comments':
      return [
        BRANDED_TOOL_NAMES.claude.getFileComments,
        BRANDED_TOOL_NAMES.codex.getFileComments,
      ];
    case 'respond_to_file_comment':
      return [
        BRANDED_TOOL_NAMES.claude.respondToFileComment,
        BRANDED_TOOL_NAMES.codex.respondToFileComment,
      ];
    case 'search_actions':
      return [
        BRANDED_TOOL_NAMES.claude.searchActions,
        BRANDED_TOOL_NAMES.codex.searchActions,
      ];
    case 'dispatch_action':
      return [
        BRANDED_TOOL_NAMES.claude.dispatchAction,
        BRANDED_TOOL_NAMES.codex.dispatchAction,
      ];
    case 'search_watchers':
      return [
        BRANDED_TOOL_NAMES.claude.searchWatchers,
        BRANDED_TOOL_NAMES.codex.searchWatchers,
      ];
    case 'setup_watchers':
      return [
        BRANDED_TOOL_NAMES.claude.setupWatchers,
        BRANDED_TOOL_NAMES.codex.setupWatchers,
      ];
    case 'watch_github_items':
      return [
        BRANDED_TOOL_NAMES.claude.watchGithubItems,
        BRANDED_TOOL_NAMES.codex.watchGithubItems,
      ];
    case 'get_github_pull_request_status':
      return [
        BRANDED_TOOL_NAMES.claude.getGithubPullRequestStatus,
        BRANDED_TOOL_NAMES.codex.getGithubPullRequestStatus,
      ];
    case 'watch_command':
      return [
        BRANDED_TOOL_NAMES.claude.watchCommand,
        BRANDED_TOOL_NAMES.codex.watchCommand,
      ];
    case 'schedule_wakeup':
      return [
        BRANDED_TOOL_NAMES.claude.scheduleWakeup,
        BRANDED_TOOL_NAMES.codex.scheduleWakeup,
      ];
    case 'delete_watchers':
      return [
        BRANDED_TOOL_NAMES.claude.deleteWatchers,
        BRANDED_TOOL_NAMES.codex.deleteWatchers,
      ];
    case 'set_auto_archive':
      return [
        BRANDED_TOOL_NAMES.claude.setAutoArchive,
        BRANDED_TOOL_NAMES.codex.setAutoArchive,
      ];
    case 'set_work_entry_auto_delete':
      return [
        BRANDED_TOOL_NAMES.claude.setWorkEntryAutoDelete,
        BRANDED_TOOL_NAMES.codex.setWorkEntryAutoDelete,
      ];
    case 'set_base_branch':
      return [
        BRANDED_TOOL_NAMES.claude.setBaseBranch,
        BRANDED_TOOL_NAMES.codex.setBaseBranch,
      ];
    case 'start_forked_agent':
      return [
        BRANDED_TOOL_NAMES.claude.startForkedAgent,
        BRANDED_TOOL_NAMES.codex.startForkedAgent,
      ];
    case 'start_branched_agent':
      return [
        BRANDED_TOOL_NAMES.claude.startBranchedAgent,
        BRANDED_TOOL_NAMES.codex.startBranchedAgent,
      ];
    case 'get_code_graph_context':
      return [
        BRANDED_TOOL_NAMES.claude.getCodeGraphContext,
        BRANDED_TOOL_NAMES.codex.getCodeGraphContext,
      ];
    case 'build_or_update_code_graph':
      return [
        BRANDED_TOOL_NAMES.claude.buildOrUpdateCodeGraph,
        BRANDED_TOOL_NAMES.codex.buildOrUpdateCodeGraph,
      ];
    case 'query_code_graph':
      return [
        BRANDED_TOOL_NAMES.claude.queryCodeGraph,
        BRANDED_TOOL_NAMES.codex.queryCodeGraph,
      ];
    case 'search_code_graph':
      return [
        BRANDED_TOOL_NAMES.claude.searchCodeGraph,
        BRANDED_TOOL_NAMES.codex.searchCodeGraph,
      ];
    case 'explain_code_symbol':
      return [
        BRANDED_TOOL_NAMES.claude.explainCodeSymbol,
        BRANDED_TOOL_NAMES.codex.explainCodeSymbol,
      ];
    case 'get_impact_radius':
      return [
        BRANDED_TOOL_NAMES.claude.getImpactRadius,
        BRANDED_TOOL_NAMES.codex.getImpactRadius,
      ];
    case 'detect_changed_symbols':
      return [
        BRANDED_TOOL_NAMES.claude.detectChangedSymbols,
        BRANDED_TOOL_NAMES.codex.detectChangedSymbols,
      ];
    case 'compare_change_impact':
      return [
        BRANDED_TOOL_NAMES.claude.compareChangeImpact,
        BRANDED_TOOL_NAMES.codex.compareChangeImpact,
      ];
    case 'get_review_context':
      return [
        BRANDED_TOOL_NAMES.claude.getReviewContext,
        BRANDED_TOOL_NAMES.codex.getReviewContext,
      ];
    case 'search_deferred_tools':
      return [
        BRANDED_TOOL_NAMES.claude.searchDeferredTools,
        BRANDED_TOOL_NAMES.codex.searchDeferredTools,
      ];
    case 'delegate_task':
      return [
        BRANDED_TOOL_NAMES.claude.delegateTask,
        BRANDED_TOOL_NAMES.codex.delegateTask,
      ];
    case 'get_delegate_output':
      return [
        BRANDED_TOOL_NAMES.claude.getDelegateOutput,
        BRANDED_TOOL_NAMES.codex.getDelegateOutput,
      ];
    case 'inspect_delegate':
      return [
        BRANDED_TOOL_NAMES.claude.inspectDelegate,
        BRANDED_TOOL_NAMES.codex.inspectDelegate,
      ];
    case 'list_delegates':
      return [
        BRANDED_TOOL_NAMES.claude.listDelegates,
        BRANDED_TOOL_NAMES.codex.listDelegates,
      ];
    case 'manage_delegate_worktree':
      return [
        BRANDED_TOOL_NAMES.claude.manageDelegateWorktree,
        BRANDED_TOOL_NAMES.codex.manageDelegateWorktree,
      ];
    case 'message_delegate':
      return [
        BRANDED_TOOL_NAMES.claude.messageDelegate,
        BRANDED_TOOL_NAMES.codex.messageDelegate,
      ];
    case 'request_steering':
      return [
        BRANDED_TOOL_NAMES.claude.requestSteering,
        BRANDED_TOOL_NAMES.codex.requestSteering,
      ];
    case 'stop_delegate':
      return [
        BRANDED_TOOL_NAMES.claude.stopDelegate,
        BRANDED_TOOL_NAMES.codex.stopDelegate,
      ];
    case 'load_deferred_tools':
      return [
        BRANDED_TOOL_NAMES.claude.loadDeferredTools,
        BRANDED_TOOL_NAMES.codex.loadDeferredTools,
      ];
    case 'add_ledger_entry':
      return [
        BRANDED_TOOL_NAMES.claude.addLedgerEntry,
        BRANDED_TOOL_NAMES.codex.addLedgerEntry,
      ];
    case 'search_ledger_entries':
      return [
        BRANDED_TOOL_NAMES.claude.searchLedgerEntries,
        BRANDED_TOOL_NAMES.codex.searchLedgerEntries,
      ];
    case 'update_ledger_entry':
      return [
        BRANDED_TOOL_NAMES.claude.updateLedgerEntry,
        BRANDED_TOOL_NAMES.codex.updateLedgerEntry,
      ];
  }
}

function legacyAliasesFor(key: CanopyInjectedToolKey): string[] {
  const live = new Set<string>(liveToolNamesFor(key));
  // ScheduleWakeup was a distinct provider-native tool, not our watcher tool.
  const displayLegacy = CANOPY_INJECTED_TOOL_DISPLAY_NAMES[key];
  const aliases = new Set<string>(
    key === 'schedule_wakeup' ||
      key === 'show_visual' ||
      key === 'preview_visual'
      ? []
      : [displayLegacy],
  );
  for (const historical of HISTORICAL_CANOPY_NAMES[key]) {
    if (!live.has(historical)) aliases.add(historical);
  }
  return Array.from(aliases);
}

const CANOPY_INJECTED_TOOL_DISPLAY_NAMES: Readonly<
  Record<CanopyInjectedToolKey, CanopyInjectedToolDisplayName>
> = {
  ask_user_question: 'AskUserQuestion',
  get_script_output: 'GetScriptOutput',
  get_git_preferences: 'GetGitPreferences',
  save_memory: 'SaveMemory',
  search_memory: 'SearchMemory',
  read_memory: 'ReadMemory',
  read_pipeline_yaml: 'ReadPipelineYaml',
  show_files: 'ShowFiles',
  show_capabilities: 'ShowCapabilities',
  show_visual: 'ShowVisual',
  preview_visual: 'PreviewVisual',
  get_file_comments: 'GetFileComments',
  respond_to_file_comment: 'RespondToFileComment',
  search_actions: 'SearchActions',
  dispatch_action: 'DispatchAction',
  search_watchers: 'SearchWatchers',
  setup_watchers: 'SetupWatchers',
  watch_github_items: 'WatchGitHubItems',
  get_github_pull_request_status: 'GetGitHubPullRequestStatus',
  watch_command: 'WatchCommand',
  schedule_wakeup: 'ScheduleWakeup',
  delete_watchers: 'DeleteWatchers',
  set_auto_archive: 'SetChatAutoArchive',
  set_work_entry_auto_delete: 'SetWorkEntryAutoDelete',
  set_base_branch: 'SetBaseBranch',
  start_forked_agent: 'StartForkedAgent',
  start_branched_agent: 'StartBranchedAgent',
  get_code_graph_context: 'GetCodeGraphContext',
  build_or_update_code_graph: 'BuildOrUpdateCodeGraph',
  query_code_graph: 'QueryCodeGraph',
  search_code_graph: 'SearchCodeGraph',
  explain_code_symbol: 'ExplainCodeSymbol',
  get_impact_radius: 'GetImpactRadius',
  detect_changed_symbols: 'DetectChangedSymbols',
  compare_change_impact: 'CompareChangeImpact',
  get_review_context: 'GetReviewContext',
  search_deferred_tools: 'SearchDeferredTools',
  load_deferred_tools: 'LoadDeferredTools',
  add_ledger_entry: 'AddFeedEntry',
  search_ledger_entries: 'SearchFeedEntries',
  update_ledger_entry: 'UpdateFeedEntry',
  delegate_task: 'DelegateTask',
  get_delegate_output: 'GetDelegateOutput',
  inspect_delegate: 'InspectDelegate',
  list_delegates: 'ListDelegates',
  stop_delegate: 'StopDelegate',
  manage_delegate_worktree: 'ManageDelegateWorktree',
  message_delegate: 'MessageDelegate',
  request_steering: 'RequestSteering',
};

export const CANOPY_INJECTED_TOOL_REGISTRY: Record<
  CanopyInjectedToolKey,
  CanopyInjectedToolExposure
> = {
  ask_user_question: {
    canonicalKey: 'ask_user_question',
    displayName: 'AskUserQuestion',
    cursorToolName: cursorMcpToolTitle('AskUserQuestion'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.askUserQuestion,
    codexToolName: BRANDED_TOOL_NAMES.codex.askUserQuestion,
    legacyToolNames: legacyAliasesFor('ask_user_question'),
  },
  get_script_output: {
    canonicalKey: 'get_script_output',
    displayName: 'GetScriptOutput',
    cursorToolName: cursorMcpToolTitle('GetScriptOutput'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.getScriptOutput,
    codexToolName: BRANDED_TOOL_NAMES.codex.getScriptOutput,
    legacyToolNames: legacyAliasesFor('get_script_output'),
  },
  get_git_preferences: {
    canonicalKey: 'get_git_preferences',
    displayName: 'GetGitPreferences',
    cursorToolName: cursorMcpToolTitle('GetGitPreferences'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.getGitPreferences,
    codexToolName: BRANDED_TOOL_NAMES.codex.getGitPreferences,
    legacyToolNames: legacyAliasesFor('get_git_preferences'),
  },
  save_memory: {
    canonicalKey: 'save_memory',
    displayName: 'SaveMemory',
    cursorToolName: cursorMcpToolTitle('SaveMemory'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.saveMemory,
    codexToolName: BRANDED_TOOL_NAMES.codex.saveMemory,
    legacyToolNames: legacyAliasesFor('save_memory'),
  },
  search_memory: {
    canonicalKey: 'search_memory',
    displayName: 'SearchMemory',
    cursorToolName: cursorMcpToolTitle('SearchMemory'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.searchMemory,
    codexToolName: BRANDED_TOOL_NAMES.codex.searchMemory,
    legacyToolNames: legacyAliasesFor('search_memory'),
  },
  read_memory: {
    canonicalKey: 'read_memory',
    displayName: 'ReadMemory',
    cursorToolName: cursorMcpToolTitle('ReadMemory'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.readMemory,
    codexToolName: BRANDED_TOOL_NAMES.codex.readMemory,
    legacyToolNames: legacyAliasesFor('read_memory'),
  },
  read_pipeline_yaml: {
    canonicalKey: 'read_pipeline_yaml',
    displayName: 'ReadPipelineYaml',
    cursorToolName: cursorMcpToolTitle('ReadPipelineYaml'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.readPipelineYaml,
    codexToolName: BRANDED_TOOL_NAMES.codex.readPipelineYaml,
    legacyToolNames: legacyAliasesFor('read_pipeline_yaml'),
  },
  show_files: {
    canonicalKey: 'show_files',
    displayName: 'ShowFiles',
    cursorToolName: cursorMcpToolTitle('ShowFiles'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.showFiles,
    codexToolName: BRANDED_TOOL_NAMES.codex.showFiles,
    legacyToolNames: legacyAliasesFor('show_files'),
  },
  show_capabilities: {
    canonicalKey: 'show_capabilities',
    displayName: 'ShowCapabilities',
    cursorToolName: cursorMcpToolTitle('ShowCapabilities'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.showCapabilities,
    codexToolName: BRANDED_TOOL_NAMES.codex.showCapabilities,
    legacyToolNames: legacyAliasesFor('show_capabilities'),
  },
  show_visual: {
    canonicalKey: 'show_visual',
    displayName: 'ShowVisual',
    cursorToolName: cursorMcpToolTitle('ShowVisual'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.showVisual,
    codexToolName: BRANDED_TOOL_NAMES.codex.showVisual,
    legacyToolNames: legacyAliasesFor('show_visual'),
  },
  preview_visual: {
    canonicalKey: 'preview_visual',
    displayName: 'PreviewVisual',
    cursorToolName: cursorMcpToolTitle('PreviewVisual'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.previewVisual,
    codexToolName: BRANDED_TOOL_NAMES.codex.previewVisual,
    legacyToolNames: legacyAliasesFor('preview_visual'),
  },
  get_file_comments: {
    canonicalKey: 'get_file_comments',
    displayName: 'GetFileComments',
    cursorToolName: cursorMcpToolTitle('GetFileComments'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.getFileComments,
    codexToolName: BRANDED_TOOL_NAMES.codex.getFileComments,
    legacyToolNames: legacyAliasesFor('get_file_comments'),
  },
  respond_to_file_comment: {
    canonicalKey: 'respond_to_file_comment',
    displayName: 'RespondToFileComment',
    cursorToolName: cursorMcpToolTitle('RespondToFileComment'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.respondToFileComment,
    codexToolName: BRANDED_TOOL_NAMES.codex.respondToFileComment,
    legacyToolNames: legacyAliasesFor('respond_to_file_comment'),
  },
  search_actions: {
    canonicalKey: 'search_actions',
    displayName: 'SearchActions',
    cursorToolName: cursorMcpToolTitle('SearchActions'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.searchActions,
    codexToolName: BRANDED_TOOL_NAMES.codex.searchActions,
    legacyToolNames: legacyAliasesFor('search_actions'),
  },
  dispatch_action: {
    canonicalKey: 'dispatch_action',
    displayName: 'DispatchAction',
    cursorToolName: cursorMcpToolTitle('DispatchAction'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.dispatchAction,
    codexToolName: BRANDED_TOOL_NAMES.codex.dispatchAction,
    legacyToolNames: legacyAliasesFor('dispatch_action'),
  },
  search_watchers: {
    canonicalKey: 'search_watchers',
    displayName: 'SearchWatchers',
    cursorToolName: cursorMcpToolTitle('SearchWatchers'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.searchWatchers,
    codexToolName: BRANDED_TOOL_NAMES.codex.searchWatchers,
    legacyToolNames: legacyAliasesFor('search_watchers'),
  },
  setup_watchers: {
    canonicalKey: 'setup_watchers',
    displayName: 'SetupWatchers',
    cursorToolName: cursorMcpToolTitle('SetupWatchers'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.setupWatchers,
    codexToolName: BRANDED_TOOL_NAMES.codex.setupWatchers,
    legacyToolNames: legacyAliasesFor('setup_watchers'),
  },
  watch_github_items: {
    canonicalKey: 'watch_github_items',
    displayName: 'WatchGitHubItems',
    cursorToolName: cursorMcpToolTitle('WatchGitHubItems'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.watchGithubItems,
    codexToolName: BRANDED_TOOL_NAMES.codex.watchGithubItems,
    legacyToolNames: legacyAliasesFor('watch_github_items'),
  },
  get_github_pull_request_status: {
    canonicalKey: 'get_github_pull_request_status',
    displayName: 'GetGitHubPullRequestStatus',
    cursorToolName: cursorMcpToolTitle('GetGitHubPullRequestStatus'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.getGithubPullRequestStatus,
    codexToolName: BRANDED_TOOL_NAMES.codex.getGithubPullRequestStatus,
    legacyToolNames: legacyAliasesFor('get_github_pull_request_status'),
  },
  watch_command: {
    canonicalKey: 'watch_command',
    displayName: 'WatchCommand',
    cursorToolName: cursorMcpToolTitle('WatchCommand'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.watchCommand,
    codexToolName: BRANDED_TOOL_NAMES.codex.watchCommand,
    legacyToolNames: legacyAliasesFor('watch_command'),
  },
  schedule_wakeup: {
    canonicalKey: 'schedule_wakeup',
    displayName: 'ScheduleWakeup',
    cursorToolName: cursorMcpToolTitle('ScheduleWakeup'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.scheduleWakeup,
    codexToolName: BRANDED_TOOL_NAMES.codex.scheduleWakeup,
    legacyToolNames: legacyAliasesFor('schedule_wakeup'),
  },
  delete_watchers: {
    canonicalKey: 'delete_watchers',
    displayName: 'DeleteWatchers',
    cursorToolName: cursorMcpToolTitle('DeleteWatchers'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.deleteWatchers,
    codexToolName: BRANDED_TOOL_NAMES.codex.deleteWatchers,
    legacyToolNames: legacyAliasesFor('delete_watchers'),
  },
  set_auto_archive: {
    canonicalKey: 'set_auto_archive',
    displayName: 'SetChatAutoArchive',
    cursorToolName: cursorMcpToolTitle('SetChatAutoArchive'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.setAutoArchive,
    codexToolName: BRANDED_TOOL_NAMES.codex.setAutoArchive,
    legacyToolNames: legacyAliasesFor('set_auto_archive'),
  },
  set_work_entry_auto_delete: {
    canonicalKey: 'set_work_entry_auto_delete',
    displayName: 'SetWorkEntryAutoDelete',
    cursorToolName: cursorMcpToolTitle('SetWorkEntryAutoDelete'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.setWorkEntryAutoDelete,
    codexToolName: BRANDED_TOOL_NAMES.codex.setWorkEntryAutoDelete,
    legacyToolNames: legacyAliasesFor('set_work_entry_auto_delete'),
  },
  set_base_branch: {
    canonicalKey: 'set_base_branch',
    displayName: 'SetBaseBranch',
    cursorToolName: cursorMcpToolTitle('SetBaseBranch'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.setBaseBranch,
    codexToolName: BRANDED_TOOL_NAMES.codex.setBaseBranch,
    legacyToolNames: legacyAliasesFor('set_base_branch'),
  },
  start_forked_agent: {
    canonicalKey: 'start_forked_agent',
    displayName: 'StartForkedAgent',
    cursorToolName: cursorMcpToolTitle('StartForkedAgent'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.startForkedAgent,
    codexToolName: BRANDED_TOOL_NAMES.codex.startForkedAgent,
    legacyToolNames: legacyAliasesFor('start_forked_agent'),
  },
  start_branched_agent: {
    canonicalKey: 'start_branched_agent',
    displayName: 'StartBranchedAgent',
    cursorToolName: cursorMcpToolTitle('StartBranchedAgent'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.startBranchedAgent,
    codexToolName: BRANDED_TOOL_NAMES.codex.startBranchedAgent,
    legacyToolNames: legacyAliasesFor('start_branched_agent'),
  },
  get_code_graph_context: {
    canonicalKey: 'get_code_graph_context',
    displayName: 'GetCodeGraphContext',
    cursorToolName: cursorMcpToolTitle('GetCodeGraphContext'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.getCodeGraphContext,
    codexToolName: BRANDED_TOOL_NAMES.codex.getCodeGraphContext,
    legacyToolNames: legacyAliasesFor('get_code_graph_context'),
  },
  build_or_update_code_graph: {
    canonicalKey: 'build_or_update_code_graph',
    displayName: 'BuildOrUpdateCodeGraph',
    cursorToolName: cursorMcpToolTitle('BuildOrUpdateCodeGraph'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.buildOrUpdateCodeGraph,
    codexToolName: BRANDED_TOOL_NAMES.codex.buildOrUpdateCodeGraph,
    legacyToolNames: legacyAliasesFor('build_or_update_code_graph'),
  },
  query_code_graph: {
    canonicalKey: 'query_code_graph',
    displayName: 'QueryCodeGraph',
    cursorToolName: cursorMcpToolTitle('QueryCodeGraph'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.queryCodeGraph,
    codexToolName: BRANDED_TOOL_NAMES.codex.queryCodeGraph,
    legacyToolNames: legacyAliasesFor('query_code_graph'),
  },
  search_code_graph: {
    canonicalKey: 'search_code_graph',
    displayName: 'SearchCodeGraph',
    cursorToolName: cursorMcpToolTitle('SearchCodeGraph'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.searchCodeGraph,
    codexToolName: BRANDED_TOOL_NAMES.codex.searchCodeGraph,
    legacyToolNames: legacyAliasesFor('search_code_graph'),
  },
  explain_code_symbol: {
    canonicalKey: 'explain_code_symbol',
    displayName: 'ExplainCodeSymbol',
    cursorToolName: cursorMcpToolTitle('ExplainCodeSymbol'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.explainCodeSymbol,
    codexToolName: BRANDED_TOOL_NAMES.codex.explainCodeSymbol,
    legacyToolNames: legacyAliasesFor('explain_code_symbol'),
  },
  get_impact_radius: {
    canonicalKey: 'get_impact_radius',
    displayName: 'GetImpactRadius',
    cursorToolName: cursorMcpToolTitle('GetImpactRadius'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.getImpactRadius,
    codexToolName: BRANDED_TOOL_NAMES.codex.getImpactRadius,
    legacyToolNames: legacyAliasesFor('get_impact_radius'),
  },
  detect_changed_symbols: {
    canonicalKey: 'detect_changed_symbols',
    displayName: 'DetectChangedSymbols',
    cursorToolName: cursorMcpToolTitle('DetectChangedSymbols'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.detectChangedSymbols,
    codexToolName: BRANDED_TOOL_NAMES.codex.detectChangedSymbols,
    legacyToolNames: legacyAliasesFor('detect_changed_symbols'),
  },
  compare_change_impact: {
    canonicalKey: 'compare_change_impact',
    displayName: 'CompareChangeImpact',
    cursorToolName: cursorMcpToolTitle('CompareChangeImpact'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.compareChangeImpact,
    codexToolName: BRANDED_TOOL_NAMES.codex.compareChangeImpact,
    legacyToolNames: legacyAliasesFor('compare_change_impact'),
  },
  get_review_context: {
    canonicalKey: 'get_review_context',
    displayName: 'GetReviewContext',
    cursorToolName: cursorMcpToolTitle('GetReviewContext'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.getReviewContext,
    codexToolName: BRANDED_TOOL_NAMES.codex.getReviewContext,
    legacyToolNames: legacyAliasesFor('get_review_context'),
  },
  search_deferred_tools: {
    canonicalKey: 'search_deferred_tools',
    displayName: 'SearchDeferredTools',
    cursorToolName: cursorMcpToolTitle('SearchDeferredTools'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.searchDeferredTools,
    codexToolName: BRANDED_TOOL_NAMES.codex.searchDeferredTools,
    legacyToolNames: legacyAliasesFor('search_deferred_tools'),
  },
  delegate_task: {
    canonicalKey: 'delegate_task',
    displayName: 'DelegateTask',
    cursorToolName: cursorMcpToolTitle('DelegateTask'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.delegateTask,
    codexToolName: BRANDED_TOOL_NAMES.codex.delegateTask,
    legacyToolNames: legacyAliasesFor('delegate_task'),
  },
  get_delegate_output: {
    canonicalKey: 'get_delegate_output',
    displayName: 'GetDelegateOutput',
    cursorToolName: cursorMcpToolTitle('GetDelegateOutput'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.getDelegateOutput,
    codexToolName: BRANDED_TOOL_NAMES.codex.getDelegateOutput,
    legacyToolNames: legacyAliasesFor('get_delegate_output'),
  },
  inspect_delegate: {
    canonicalKey: 'inspect_delegate',
    displayName: 'InspectDelegate',
    cursorToolName: cursorMcpToolTitle('InspectDelegate'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.inspectDelegate,
    codexToolName: BRANDED_TOOL_NAMES.codex.inspectDelegate,
    legacyToolNames: legacyAliasesFor('inspect_delegate'),
  },
  list_delegates: {
    canonicalKey: 'list_delegates',
    displayName: 'ListDelegates',
    cursorToolName: cursorMcpToolTitle('ListDelegates'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.listDelegates,
    codexToolName: BRANDED_TOOL_NAMES.codex.listDelegates,
    legacyToolNames: legacyAliasesFor('list_delegates'),
  },
  manage_delegate_worktree: {
    canonicalKey: 'manage_delegate_worktree',
    displayName: 'ManageDelegateWorktree',
    cursorToolName: cursorMcpToolTitle('ManageDelegateWorktree'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.manageDelegateWorktree,
    codexToolName: BRANDED_TOOL_NAMES.codex.manageDelegateWorktree,
    legacyToolNames: legacyAliasesFor('manage_delegate_worktree'),
  },
  message_delegate: {
    canonicalKey: 'message_delegate',
    displayName: 'MessageDelegate',
    cursorToolName: cursorMcpToolTitle('MessageDelegate'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.messageDelegate,
    codexToolName: BRANDED_TOOL_NAMES.codex.messageDelegate,
    legacyToolNames: legacyAliasesFor('message_delegate'),
  },
  request_steering: {
    canonicalKey: 'request_steering',
    displayName: 'RequestSteering',
    cursorToolName: cursorMcpToolTitle('RequestSteering'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.requestSteering,
    codexToolName: BRANDED_TOOL_NAMES.codex.requestSteering,
    legacyToolNames: legacyAliasesFor('request_steering'),
  },
  stop_delegate: {
    canonicalKey: 'stop_delegate',
    displayName: 'StopDelegate',
    cursorToolName: cursorMcpToolTitle('StopDelegate'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.stopDelegate,
    codexToolName: BRANDED_TOOL_NAMES.codex.stopDelegate,
    legacyToolNames: legacyAliasesFor('stop_delegate'),
  },
  load_deferred_tools: {
    canonicalKey: 'load_deferred_tools',
    displayName: 'LoadDeferredTools',
    cursorToolName: cursorMcpToolTitle('LoadDeferredTools'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.loadDeferredTools,
    codexToolName: BRANDED_TOOL_NAMES.codex.loadDeferredTools,
    legacyToolNames: legacyAliasesFor('load_deferred_tools'),
  },
  add_ledger_entry: {
    canonicalKey: 'add_ledger_entry',
    displayName: 'AddFeedEntry',
    cursorToolName: cursorMcpToolTitle('AddFeedEntry'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.addLedgerEntry,
    codexToolName: BRANDED_TOOL_NAMES.codex.addLedgerEntry,
    legacyToolNames: legacyAliasesFor('add_ledger_entry'),
  },
  search_ledger_entries: {
    canonicalKey: 'search_ledger_entries',
    displayName: 'SearchFeedEntries',
    cursorToolName: cursorMcpToolTitle('SearchFeedEntries'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.searchLedgerEntries,
    codexToolName: BRANDED_TOOL_NAMES.codex.searchLedgerEntries,
    legacyToolNames: legacyAliasesFor('search_ledger_entries'),
  },
  update_ledger_entry: {
    canonicalKey: 'update_ledger_entry',
    displayName: 'UpdateFeedEntry',
    cursorToolName: cursorMcpToolTitle('UpdateFeedEntry'),
    claudeToolName: BRANDED_TOOL_NAMES.claude.updateLedgerEntry,
    codexToolName: BRANDED_TOOL_NAMES.codex.updateLedgerEntry,
    legacyToolNames: legacyAliasesFor('update_ledger_entry'),
  },
};

/** Ordered list of entries, handy for exhaustive iteration. */
export const CANOPY_INJECTED_TOOL_ENTRIES: readonly CanopyInjectedToolExposure[] =
  [
    CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question,
    CANOPY_INJECTED_TOOL_REGISTRY.get_script_output,
    CANOPY_INJECTED_TOOL_REGISTRY.get_git_preferences,
    CANOPY_INJECTED_TOOL_REGISTRY.save_memory,
    CANOPY_INJECTED_TOOL_REGISTRY.search_memory,
    CANOPY_INJECTED_TOOL_REGISTRY.read_memory,
    CANOPY_INJECTED_TOOL_REGISTRY.read_pipeline_yaml,
    CANOPY_INJECTED_TOOL_REGISTRY.show_files,
    CANOPY_INJECTED_TOOL_REGISTRY.show_capabilities,
    CANOPY_INJECTED_TOOL_REGISTRY.show_visual,
    CANOPY_INJECTED_TOOL_REGISTRY.preview_visual,
    CANOPY_INJECTED_TOOL_REGISTRY.get_file_comments,
    CANOPY_INJECTED_TOOL_REGISTRY.respond_to_file_comment,
    CANOPY_INJECTED_TOOL_REGISTRY.search_actions,
    CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action,
    CANOPY_INJECTED_TOOL_REGISTRY.search_watchers,
    CANOPY_INJECTED_TOOL_REGISTRY.setup_watchers,
    CANOPY_INJECTED_TOOL_REGISTRY.watch_github_items,
    CANOPY_INJECTED_TOOL_REGISTRY.get_github_pull_request_status,
    CANOPY_INJECTED_TOOL_REGISTRY.watch_command,
    CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup,
    CANOPY_INJECTED_TOOL_REGISTRY.delete_watchers,
    CANOPY_INJECTED_TOOL_REGISTRY.set_auto_archive,
    CANOPY_INJECTED_TOOL_REGISTRY.set_work_entry_auto_delete,
    CANOPY_INJECTED_TOOL_REGISTRY.set_base_branch,
    CANOPY_INJECTED_TOOL_REGISTRY.start_forked_agent,
    CANOPY_INJECTED_TOOL_REGISTRY.start_branched_agent,
    CANOPY_INJECTED_TOOL_REGISTRY.get_code_graph_context,
    CANOPY_INJECTED_TOOL_REGISTRY.build_or_update_code_graph,
    CANOPY_INJECTED_TOOL_REGISTRY.query_code_graph,
    CANOPY_INJECTED_TOOL_REGISTRY.search_code_graph,
    CANOPY_INJECTED_TOOL_REGISTRY.explain_code_symbol,
    CANOPY_INJECTED_TOOL_REGISTRY.get_impact_radius,
    CANOPY_INJECTED_TOOL_REGISTRY.detect_changed_symbols,
    CANOPY_INJECTED_TOOL_REGISTRY.compare_change_impact,
    CANOPY_INJECTED_TOOL_REGISTRY.get_review_context,
    CANOPY_INJECTED_TOOL_REGISTRY.search_deferred_tools,
    CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools,
    CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry,
    CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries,
    CANOPY_INJECTED_TOOL_REGISTRY.update_ledger_entry,
    CANOPY_INJECTED_TOOL_REGISTRY.delegate_task,
    CANOPY_INJECTED_TOOL_REGISTRY.get_delegate_output,
    CANOPY_INJECTED_TOOL_REGISTRY.inspect_delegate,
    CANOPY_INJECTED_TOOL_REGISTRY.list_delegates,
    CANOPY_INJECTED_TOOL_REGISTRY.stop_delegate,
    CANOPY_INJECTED_TOOL_REGISTRY.manage_delegate_worktree,
    CANOPY_INJECTED_TOOL_REGISTRY.message_delegate,
    CANOPY_INJECTED_TOOL_REGISTRY.request_steering,
  ];

const BRANDED_MCP_DISPLAY_TO_KEY: ReadonlyMap<string, CanopyInjectedToolKey> =
  new Map(
    CANOPY_INJECTED_TOOL_ENTRIES.map((entry) => [
      entry.displayName,
      entry.canonicalKey,
    ]),
  );

const BRANDED_CODEX_SUFFIX_TO_KEY: ReadonlyMap<string, CanopyInjectedToolKey> =
  new Map([
    ['ask_user_question', 'ask_user_question'],
    ['get_script_output', 'get_script_output'],
    ['get_git_preferences', 'get_git_preferences'],
    ['save_memory', 'save_memory'],
    ['search_memory', 'search_memory'],
    ['read_memory', 'read_memory'],
    ['read_pipeline_yaml', 'read_pipeline_yaml'],
    ['show_files', 'show_files'],
    ['show_capabilities', 'show_capabilities'],
    ['show_visual', 'show_visual'],
    ['preview_visual', 'preview_visual'],
    ['get_file_comments', 'get_file_comments'],
    ['respond_to_file_comment', 'respond_to_file_comment'],
    ['search_actions', 'search_actions'],
    ['dispatch_action', 'dispatch_action'],
    ['search_watchers', 'search_watchers'],
    ['setup_watchers', 'setup_watchers'],
    ['watch_github_items', 'watch_github_items'],
    ['get_github_pull_request_status', 'get_github_pull_request_status'],
    ['watch_command', 'watch_command'],
    ['schedule_wakeup', 'schedule_wakeup'],
    ['delete_watchers', 'delete_watchers'],
    ['set_auto_archive', 'set_auto_archive'],
    ['set_chat_auto_archive', 'set_auto_archive'],
    ['set_work_entry_auto_delete', 'set_work_entry_auto_delete'],
    ['set_base_branch', 'set_base_branch'],
    ['start_forked_agent', 'start_forked_agent'],
    ['start_branched_agent', 'start_branched_agent'],
    // Historical suffix retained only for persisted transcript recognition.
    ['archive_chat', 'set_auto_archive'],
    ['get_code_graph_context', 'get_code_graph_context'],
    ['build_or_update_code_graph', 'build_or_update_code_graph'],
    ['query_code_graph', 'query_code_graph'],
    ['search_code_graph', 'search_code_graph'],
    ['explain_code_symbol', 'explain_code_symbol'],
    ['get_impact_radius', 'get_impact_radius'],
    ['detect_changed_symbols', 'detect_changed_symbols'],
    ['compare_change_impact', 'compare_change_impact'],
    ['get_review_context', 'get_review_context'],
    ['search_deferred_tools', 'search_deferred_tools'],
    ['load_deferred_tools', 'load_deferred_tools'],
    ['add_feed_entry', 'add_ledger_entry'],
    ['search_feed_entries', 'search_ledger_entries'],
    ['update_feed_entry', 'update_ledger_entry'],
    // Historical Agent Ledger suffixes, for persisted transcript recognition.
    ['add_ledger_entry', 'add_ledger_entry'],
    ['search_ledger_entries', 'search_ledger_entries'],
    ['update_ledger_entry', 'update_ledger_entry'],
    ['spawn_delegate', 'delegate_task'],
    ['get_delegate_output', 'get_delegate_output'],
    // Historical suffixes are display aliases only; live catalogs use the
    // explicit messaging names above.
    ['inspect_delegate', 'inspect_delegate'],
    ['list_delegates', 'list_delegates'],
    ['stop_delegate', 'stop_delegate'],
    ['manage_delegate_worktree', 'manage_delegate_worktree'],
    ['message_delegate', 'message_delegate'],
    ['request_steering', 'request_steering'],
    ['manage_delegate', 'manage_delegate_worktree'],
  ]);

function getBrandedAppToolKey(toolName: string): CanopyInjectedToolKey | null {
  const mcpMatch = toolName.match(/^mcp__(.+)__(.+)$/);
  if (mcpMatch) {
    const namespace = mcpMatch[1];
    if (!namespace.endsWith('_app_advisor')) {
      if (mcpMatch[2] === 'ArchiveChat' || mcpMatch[2] === 'SetAutoArchive')
        return 'set_auto_archive';
      if (mcpMatch[2] === 'ManageDelegate') return 'manage_delegate_worktree';
      if (mcpMatch[2] === 'AddLedgerEntry') return 'add_ledger_entry';
      if (mcpMatch[2] === 'SearchLedgerEntries') return 'search_ledger_entries';
      if (mcpMatch[2] === 'UpdateLedgerEntry') return 'update_ledger_entry';
      return BRANDED_MCP_DISPLAY_TO_KEY.get(mcpMatch[2]) ?? null;
    }
  }

  const codexMatch = toolName.match(
    /^(.+?)_(ask_user_question|get_script_output|get_git_preferences|save_memory|search_memory|read_memory|read_pipeline_yaml|show_files|show_capabilities|show_visual|preview_visual|get_file_comments|respond_to_file_comment|search_actions|dispatch_action|search_watchers|setup_watchers|watch_github_items|get_github_pull_request_status|watch_command|schedule_wakeup|delete_watchers|set_auto_archive|set_chat_auto_archive|set_work_entry_auto_delete|set_base_branch|start_forked_agent|start_branched_agent|archive_chat|get_code_graph_context|build_or_update_code_graph|query_code_graph|search_code_graph|explain_code_symbol|get_impact_radius|detect_changed_symbols|compare_change_impact|get_review_context|search_deferred_tools|load_deferred_tools|add_feed_entry|search_feed_entries|update_feed_entry|add_ledger_entry|search_ledger_entries|update_ledger_entry|spawn_delegate|get_delegate_output|inspect_delegate|list_delegates|stop_delegate|manage_delegate_worktree|message_delegate|request_steering|manage_delegate)$/,
  );
  if (codexMatch) {
    const namespace = codexMatch[1];
    if (!namespace.endsWith('_app_advisor')) {
      return BRANDED_CODEX_SUFFIX_TO_KEY.get(codexMatch[2]) ?? null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Surface allowlists
// ---------------------------------------------------------------------------
//
// Different transports expose different subsets of the canonical registry.
// Centralizing the allowlists here means the backend HTTP MCP surface, the
// Claude Agent SDK MCP server, and any renderer documentation read from the
// same source of truth.

/**
 * Tool surface identifiers for the Canopy-injected MCP exposures.
 *
 * - `native-sdk` — the main Claude Agent SDK / Codex dynamic tool surface used
 *   by the Canopy-native chat. Exposes the non-UI canonical capability set.
 * - `native-sdk-standalone` — the Cowork (formerly standalone-chat) main
 *   surface. Exposes the directory-safe action/watcher/archive set: pipeline
 *   and browser actions run against the cowork workspace folder
 *   (directory-scoped — the action runtime's `executionScope: 'directory'`
 *   filters worktree-only actions and hook watcher triggers), plus GitHub
 *   watchers, the cached GitHub pull request status read,
 *   `read_pipeline_yaml`, and `set_auto_archive`. Git, tracked-plan,
 *   and code-graph tools stay worktree-only.
 * - `native-sdk-ui` — the dedicated long-timeout UI tool surface. Exposes
 *   `AskUserQuestion` only.
 * - `claude-code-terminal` — the managed Claude Code terminal HTTP MCP route
 *   at `/canopy/mcp/worktree-session/<sessionKey>`. Exposes worktree-scoped
 *   action and watcher tools, but intentionally excludes `AskUserQuestion`
 *   because the terminal experience handles user prompts directly in the PTY.
 * - `cursor-acp` — the local Cursor chat's HTTP MCP route, supplied to the
 *   pinned Cursor CLI as an ACP `mcpServers` entry (plus the `_ui` server for
 *   `AskUserQuestion`). Exposes the worktree action, watcher, and memory set.
 *   Code-graph tools stay off until Cursor sessions advertise graph
 *   capabilities, split-agent tools until the fork runtime supports the
 *   Cursor harness, and deferred-tool loading until a Cursor turn can reload
 *   its process mid-turn (each turn currently owns one CLI process).
 * - `opencode-acp` — the OpenCode worktree HTTP MCP route. Adds Code Graph
 *   and deferred loading plus independent forks to the Cursor worktree surface;
 *   the session gates advertisement.
 * - `opencode-acp-standalone` — the OpenCode Cowork route adds deferred loading
 *   and same-workspace independent forks to the Cursor standalone set.
 * - `copilot-sdk` — the Copilot worktree HTTP MCP route. Adds Code Graph to
 *   the Cursor worktree set and allows deferred loading when the host permits
 *   it, plus host-managed independent forks. Copilot Cowork uses its own
 *   `copilot-sdk-standalone` surface with the same directory restrictions.
 * - `cursor-acp-standalone` — the local Cursor chat's HTTP MCP route for a
 *   Cowork workspace: the `native-sdk-standalone` set minus the deferred-tool
 *   loaders (a Cursor turn owns one CLI process and cannot reload mid-turn).
 *   Directory-scoped like the Claude Cowork surface; git, base-branch,
 *   tracked-plan, split-agent, and code-graph tools stay off it
 *   (`get_script_output` stays, for WatchCommand watcher output). Same server
 *   names as `cursor-acp`, so remembered approval rules are shared with Claude
 *   Cowork chats.
 * - `managed-delegate` — managed delegation children (Claude in-process MCP
 *   server, Codex dynamic tools). Exposes read-mostly worktree tools, local
 *   memory, the code graph, worktree script actions through a restricted
 *   `DispatchAction`, and the watcher and wakeup tools. A watcher a delegate
 *   creates notifies that delegate (a host message that steers its active run
 *   or starts a follow-up run), never the root chat. Tools that prompt the
 *   user, change the user's UI, or split the chat stay with the parent. Every
 *   call passes the parent's live approval policy. Search/Load Deferred Tools
 *   are included only when the child's live capability-discovery grant allows
 *   them; after Load enables at least one item, the run pauses briefly and
 *   continues automatically with those items available.
 * - `claude-worker` — the shared worker route. It carries pipeline agents and
 *   background helpers, and a pipeline agent action's own Ledger route. Only a
 *   pipeline agent's session carries Ledger tools; helper roles are excluded
 *   by purpose, not by transport label, so a helper's route never lists them.
 *
 * The Agent Ledger tools (`LEDGER_INJECTED_TOOL_KEYS`) are allowlisted on the
 * interactive chat surfaces (`native-sdk`, `native-sdk-standalone`,
 * `claude-code-terminal` and `cursor-acp`) and on `claude-worker`, but a
 * route advertises and runs them only when its session passed the Ledger
 * exposure gate at start. Cursor Cowork chats (`cursor-acp-standalone`) do
 * not list them.
 */
export type CanopyInjectedToolSurface =
  | 'native-sdk'
  | 'native-sdk-standalone'
  | 'native-sdk-ui'
  | 'claude-code-terminal'
  | 'claude-worker'
  | 'cursor-acp'
  | 'copilot-sdk'
  | 'opencode-acp'
  | 'opencode-acp-standalone'
  | 'copilot-sdk-standalone'
  | 'cursor-acp-standalone'
  | 'managed-delegate';

const ACP_STANDALONE_INJECTED_TOOL_KEYS: readonly CanopyInjectedToolKey[] = [
  'get_script_output',
  'watch_command',
  'schedule_wakeup',
  'delete_watchers',
  'save_memory',
  'search_memory',
  'read_memory',
  'read_pipeline_yaml',
  'show_files',
  'show_capabilities',
  'show_visual',
  'preview_visual',
  'get_file_comments',
  'respond_to_file_comment',
  'search_actions',
  'dispatch_action',
  'search_watchers',
  'setup_watchers',
  'watch_github_items',
  'get_github_pull_request_status',
  'set_auto_archive',
  'set_work_entry_auto_delete',
];

const ACP_WORKTREE_INJECTED_TOOL_KEYS: readonly CanopyInjectedToolKey[] = [
  'get_script_output',
  'get_git_preferences',
  'save_memory',
  'search_memory',
  'read_memory',
  'read_pipeline_yaml',
  'show_files',
  'show_capabilities',
  'show_visual',
  'preview_visual',
  'get_file_comments',
  'respond_to_file_comment',
  'search_actions',
  'dispatch_action',
  'search_watchers',
  'setup_watchers',
  'watch_github_items',
  'get_github_pull_request_status',
  'watch_command',
  'schedule_wakeup',
  'delete_watchers',
  'set_auto_archive',
  'set_work_entry_auto_delete',
  'set_base_branch',
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
];

/**
 * Canonical allowlist keyed by transport surface.
 *
 * Treat as frozen / read-only — the arrays drive both backend tool
 * registration and renderer documentation.
 */
const DIRECTORY_SCOPED_ACCOUNT_TOOLS = [
  'get_script_output',
  'watch_command',
  'schedule_wakeup',
  'delete_watchers',
  'save_memory',
  'search_memory',
  'read_memory',
  'read_pipeline_yaml',
  'show_files',
  'show_capabilities',
  'get_file_comments',
  'respond_to_file_comment',
  'search_actions',
  'dispatch_action',
  'search_watchers',
  'setup_watchers',
  'watch_github_items',
  'get_github_pull_request_status',
  'set_auto_archive',
  'set_work_entry_auto_delete',
] as const satisfies readonly CanopyInjectedToolKey[];

export const CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS: Readonly<
  Record<CanopyInjectedToolSurface, readonly CanopyInjectedToolKey[]>
> = {
  'native-sdk': [
    'get_script_output',
    'get_git_preferences',
    'save_memory',
    'search_memory',
    'read_memory',
    'read_pipeline_yaml',
    'show_files',
    'show_capabilities',
    'show_visual',
    'preview_visual',
    'get_file_comments',
    'respond_to_file_comment',
    'search_actions',
    'dispatch_action',
    'search_watchers',
    'setup_watchers',
    'watch_github_items',
    'get_github_pull_request_status',
    'watch_command',
    'schedule_wakeup',
    'delete_watchers',
    'set_auto_archive',
    'set_work_entry_auto_delete',
    'set_base_branch',
    'start_forked_agent',
    'start_branched_agent',
    'get_code_graph_context',
    'build_or_update_code_graph',
    'query_code_graph',
    'search_code_graph',
    'explain_code_symbol',
    'get_impact_radius',
    'detect_changed_symbols',
    'compare_change_impact',
    'get_review_context',
    'search_deferred_tools',
    'load_deferred_tools',
    'add_ledger_entry',
    'search_ledger_entries',
    'update_ledger_entry',
  ],
  'native-sdk-standalone': [
    'get_script_output',
    'start_forked_agent',
    'watch_command',
    'schedule_wakeup',
    'delete_watchers',
    'save_memory',
    'search_memory',
    'read_memory',
    'read_pipeline_yaml',
    'show_files',
    'show_capabilities',
    'show_visual',
    'preview_visual',
    'get_file_comments',
    'respond_to_file_comment',
    'search_actions',
    'dispatch_action',
    'search_watchers',
    'setup_watchers',
    'watch_github_items',
    'get_github_pull_request_status',
    'set_auto_archive',
    'set_work_entry_auto_delete',
    'search_deferred_tools',
    'load_deferred_tools',
    'add_ledger_entry',
    'search_ledger_entries',
    'update_ledger_entry',
  ],
  'native-sdk-ui': ['ask_user_question'],
  'claude-code-terminal': [
    'watch_command',
    'schedule_wakeup',
    'get_script_output',
    'get_git_preferences',
    'save_memory',
    'search_memory',
    'read_memory',
    'read_pipeline_yaml',
    'show_files',
    'show_capabilities',
    'get_file_comments',
    'respond_to_file_comment',
    'search_actions',
    'dispatch_action',
    'search_watchers',
    'setup_watchers',
    'watch_github_items',
    'get_github_pull_request_status',
    'delete_watchers',
    'set_auto_archive',
    'set_work_entry_auto_delete',
    'set_base_branch',
    'get_code_graph_context',
    'build_or_update_code_graph',
    'query_code_graph',
    'search_code_graph',
    'explain_code_symbol',
    'get_impact_radius',
    'detect_changed_symbols',
    'compare_change_impact',
    'get_review_context',
    'search_deferred_tools',
    'load_deferred_tools',
    'add_ledger_entry',
    'search_ledger_entries',
    'update_ledger_entry',
  ],
  'claude-worker': [
    'save_memory',
    'search_memory',
    'read_memory',
    'add_ledger_entry',
    'search_ledger_entries',
    'update_ledger_entry',
  ],
  'cursor-acp': ACP_WORKTREE_INJECTED_TOOL_KEYS,
  'opencode-acp': [
    ...ACP_WORKTREE_INJECTED_TOOL_KEYS,
    ...CODE_GRAPH_INJECTED_TOOL_KEYS,
    'start_forked_agent',
    'start_branched_agent',
    'search_deferred_tools',
    'load_deferred_tools',
  ],
  'copilot-sdk': [
    'start_forked_agent',
    'start_branched_agent',
    'search_deferred_tools',
    'load_deferred_tools',
    'get_script_output',
    'get_git_preferences',
    'save_memory',
    'search_memory',
    'read_memory',
    'read_pipeline_yaml',
    'show_files',
    'show_capabilities',
    'get_file_comments',
    'respond_to_file_comment',
    'search_actions',
    'dispatch_action',
    'search_watchers',
    'setup_watchers',
    'watch_github_items',
    'get_github_pull_request_status',
    'watch_command',
    'schedule_wakeup',
    'delete_watchers',
    'set_auto_archive',
    'set_work_entry_auto_delete',
    'set_base_branch',
    'get_code_graph_context',
    'build_or_update_code_graph',
    'query_code_graph',
    'search_code_graph',
    'explain_code_symbol',
    'get_impact_radius',
    'detect_changed_symbols',
    'compare_change_impact',
    'get_review_context',
  ],
  'cursor-acp-standalone': ACP_STANDALONE_INJECTED_TOOL_KEYS,
  'opencode-acp-standalone': [
    ...ACP_STANDALONE_INJECTED_TOOL_KEYS,
    'start_forked_agent',
    'search_deferred_tools',
    'load_deferred_tools',
  ],
  'copilot-sdk-standalone': [
    'start_forked_agent',
    ...DIRECTORY_SCOPED_ACCOUNT_TOOLS,
    'search_deferred_tools',
    'load_deferred_tools',
  ],
  'managed-delegate': [
    'get_script_output',
    'get_git_preferences',
    'save_memory',
    'search_memory',
    'read_memory',
    'read_pipeline_yaml',
    'get_file_comments',
    'search_actions',
    'dispatch_action',
    'search_watchers',
    'setup_watchers',
    'watch_github_items',
    'get_github_pull_request_status',
    'watch_command',
    'schedule_wakeup',
    'delete_watchers',
    'get_code_graph_context',
    'build_or_update_code_graph',
    'query_code_graph',
    'search_code_graph',
    'explain_code_symbol',
    'get_impact_radius',
    'detect_changed_symbols',
    'compare_change_impact',
    'get_review_context',
    'search_deferred_tools',
    'load_deferred_tools',
  ],
};

/**
 * Returns the ordered exposures permitted on a given transport surface. The
 * order matches {@link CANOPY_INJECTED_TOOL_ENTRIES} so callers can rely on a
 * stable advertise-order between surfaces.
 */
export function getCanopyInjectedToolsForSurface(
  surface: CanopyInjectedToolSurface,
): readonly CanopyInjectedToolExposure[] {
  const allowedKeys = CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface];
  return CANOPY_INJECTED_TOOL_ENTRIES.filter((entry) =>
    allowedKeys.includes(entry.canonicalKey),
  );
}

/**
 * Returns the provider-accurate raw tool names that a given surface should
 * advertise. Used by transport code that needs to emit the wire names without
 * touching the rest of the exposure metadata.
 */
export function getCanopyInjectedToolNamesForSurface(
  surface: CanopyInjectedToolSurface,
  provider: CanopyInjectedToolProvider,
): readonly string[] {
  return getCanopyInjectedToolsForSurface(surface).map((entry) =>
    getProviderToolName(entry.canonicalKey, provider),
  );
}

/**
 * Returns the provider-accurate raw tool name for a canonical capability key.
 * Used by transport and analytics code that needs to emit provider-specific
 * names in logs / persisted blocks / IPC events. For `'cursor'` this is the
 * `"<server>: <tool>"` title the CLI gives the call, not a callable name: the
 * agent calls the bare `displayName` on the named MCP server (see
 * `injectedToolName` in `canopy-tools/prompting.ts`).
 */
export function getProviderToolName(
  key: CanopyInjectedToolKey,
  provider: CanopyInjectedToolProvider,
): string {
  const exposure = CANOPY_INJECTED_TOOL_REGISTRY[key];
  switch (provider) {
    case 'claude':
      return exposure.claudeToolName;
    case 'codex':
      return exposure.codexToolName;
    case 'cursor':
      return exposure.cursorToolName;
    case 'copilot':
    case 'opencode':
      return exposure.displayName;
  }
}

/** True only for the current brand's trusted Codex restart control. */
export function isCanopyImmediateTurnRestartToolName(
  toolName: string | null | undefined,
): boolean {
  return toolName === `${BRAND.tools.namespace}_immediate_turn_restart`;
}

/**
 * Resolve a raw tool name (from any recognised provider + legacy form) to its
 * canonical canopy-injected capability key. Returns `null` for non-Canopy tools.
 */
export function getCanonicalCanopyToolKey(
  toolName: string | null | undefined,
): CanopyInjectedToolKey | null {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return null;
  }

  for (const exposure of CANOPY_INJECTED_TOOL_ENTRIES) {
    if (
      toolName === exposure.claudeToolName ||
      toolName === exposure.codexToolName ||
      toolName === exposure.cursorToolName ||
      exposure.legacyToolNames.includes(toolName)
    ) {
      return exposure.canonicalKey;
    }
  }

  return getBrandedAppToolKey(toolName);
}

/**
 * Normalise any recognised Canopy-injected tool alias to its canonical
 * DISPLAY name (e.g. `AskUserQuestion`). Returns the input unchanged when the
 * tool is not a recognised Canopy-injected alias.
 */
export function normalizeCanopyInjectedToolName(toolName: string): string {
  const key = getCanonicalCanopyToolKey(toolName);
  if (!key) {
    return toolName;
  }
  return CANOPY_INJECTED_TOOL_REGISTRY[key].displayName;
}

/**
 * Hard wall-clock timeout (ms) applied to the dedicated `<ns>_ui` Claude MCP
 * HTTP server that hosts AskUserQuestion. The question blocks on the user, so
 * this is intentionally long (1 hour).
 */
export const ASK_USER_HTTP_TIMEOUT_MS = 3_600_000;

/** Agent-facing wait limit for BuildOrUpdateCodeGraph. Generation continues. */
export const CODE_GRAPH_AGENT_BUILD_WAIT_TIMEOUT_MS = 600_000;

/**
 * Explicit per-server timeout (ms) for the non-UI Claude MCP HTTP servers.
 * Replaces the SDK's 60s default and leaves one minute of transport headroom
 * for BuildOrUpdateCodeGraph to return its graceful 10-minute timeout error.
 */
export const CANOPY_MCP_TOOL_TIMEOUT_MS =
  CODE_GRAPH_AGENT_BUILD_WAIT_TIMEOUT_MS + 60_000;

/**
 * Graceful in-tool timeout (ms) for AskUserQuestion. Fires just before the
 * 1-hour HTTP wall-clock so the agent receives a useful instruction instead of
 * a transport error.
 */
export const ASK_USER_TIMEOUT_MS = 3_540_000;

/** Error message thrown when {@link ASK_USER_TIMEOUT_MS} elapses. */
export const ASK_USER_TIMEOUT_ERROR = 'ask_user_timeout';

/** Agent-facing result text when an AskUserQuestion call times out. */
export const ASK_USER_TIMEOUT_MESSAGE =
  'This question timed out after 59 minutes with no response from the user. ' +
  'Do not call AskUserQuestion again for this question. Instead, ask your ' +
  'question(s) directly to the user as plain text in your reply and wait for ' +
  'their response.';

/** True when the raw tool name refers to the Canopy-injected ask-user tool. */
export function isCanopyAskUserToolName(
  toolName: string | null | undefined,
): boolean {
  return getCanonicalCanopyToolKey(toolName) === 'ask_user_question';
}

/** True when the raw tool name refers to the Canopy-injected script-output tool. */
export function isCanopyGetScriptOutputToolName(
  toolName: string | null | undefined,
): boolean {
  return getCanonicalCanopyToolKey(toolName) === 'get_script_output';
}

/**
 * All recognised Canopy-injected aliases for a given capability. Does NOT
 * include provider built-ins (like Codex's `request_user_input`); see
 * `canopy-tool-aliases.ts` in the renderer for the UI-level helper that layers
 * built-in names on top of this registry.
 */
export function getCanopyInjectedAliases(
  key: CanopyInjectedToolKey,
): readonly string[] {
  const exposure = CANOPY_INJECTED_TOOL_REGISTRY[key];
  return [
    exposure.claudeToolName,
    exposure.codexToolName,
    exposure.cursorToolName,
    ...exposure.legacyToolNames,
  ];
}

/** Retired names recognized only for historical transcript classification. */
export function isHistoricalDelegateWatchToolName(name: string): boolean {
  return /^(?:WatchDelegates|WaitDelegates|(?:mcp__.+__)(?:WatchDelegates|WaitDelegates)|.+_(?:watch_delegates|wait_delegates))$/.test(
    name,
  );
}
