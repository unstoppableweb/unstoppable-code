/**
 * Single source of truth for the capabilities the App Advisor (the local,
 * embedded Canopy assistant) exposes through its tool runtime. Keep this
 * file dependency-free so both the main process and the renderer can
 * import it.
 *
 * Provider-accurate raw names live alongside the canonical capability key
 * so transport, analytics, and tool-routing code never has to derive them
 * from string heuristics.
 *
 * The App Advisor's tool registry is intentionally narrower than the
 * top-level Canopy injected tools (`canopy-injected-tools.ts`): App Advisor
 * tools target the *local Canopy app* itself (UI state, dispatch, debug
 * context), not the user's worktree. They are not exposed via the Canopy
 * Portal wire protocol — see the transport plan and the regression test in
 * `packages/protocol/src/portal/__tests__/portal-contract.test.ts`.
 *
 * The three Agent Ledger tools are the exception that shares its canonical
 * keys with the injected tools: App Advisor advertises them under its own
 * names, and only to a session whose Ledger exposure gate passed when it
 * started (see {@link isAppAdvisorLedgerToolKey}).
 */
import { BRAND } from '@canopy/brand/current';
import { buildInjectedToolNamesForBrand } from '@canopy/protocol/brand';

/**
 * Canonical key set for the App Advisor's tool registry. New tools must be
 * appended to this union, the registry below, and the provider-name table.
 *
 * Two of these tools (`get_current_ui_state` and `dispatch_action`) are
 * forwarded to the renderer over
 * `IPC_CHANNELS.appAdvisorToolRequest` / `appAdvisorToolResponse`.
 * a separate IPC channel. `get_script_output`, `read_pipeline_yaml`,
 * `search_actions`, and `get_pipeline_debug_context` are backend-only and
 * never cross the renderer-tool envelope.
 */
export type AppAdvisorToolKey =
  | 'ask_user_question'
  | 'get_script_output'
  | 'read_pipeline_yaml'
  | 'show_files'
  | 'show_capabilities'
  | 'get_file_comments'
  | 'respond_to_file_comment'
  | 'search_actions'
  | 'get_current_ui_state'
  | 'dispatch_action'
  | 'get_pipeline_debug_context'
  | 'search_watchers'
  | 'setup_watchers'
  | 'watch_github_items'
  | 'get_github_pull_request_status'
  | 'watch_command'
  | 'schedule_wakeup'
  | 'set_auto_archive'
  | 'set_work_entry_auto_delete'
  | 'set_project_work_entry_auto_delete'
  | 'start_forked_agent'
  | 'search_deferred_tools'
  | 'load_deferred_tools'
  | 'add_ledger_entry'
  | 'search_ledger_entries'
  | 'update_ledger_entry';

/**
 * The Agent Ledger tools in the App Advisor registry. Unlike App Advisor's
 * own tools, a session advertises them only when its Ledger exposure gate
 * passed when it started, and their calls run on that session's Ledger
 * runtime, bound to the Work Entry the session started in.
 */
export type AppAdvisorLedgerToolKey = Extract<
  AppAdvisorToolKey,
  'add_ledger_entry' | 'search_ledger_entries' | 'update_ledger_entry'
>;

export type AppAdvisorToolProvider = 'claude' | 'codex';

/**
 * Provider-accurate raw tool name pair for a single App Advisor capability.
 * Claude consumes the MCP-prefixed name; Codex consumes the snake_case
 * canonical name from its dynamic tool registry.
 */
export interface AppAdvisorToolExposure {
  canonicalKey: AppAdvisorToolKey;
  /**
   * Human-friendly camelCase display name. Used in observability and
   * persisted transcript labels — never as the wire identifier.
   */
  displayName: string;
  /** Raw tool name as seen by the Claude Agent SDK / MCP path. */
  claudeToolName: string;
  /** Raw tool name as seen by the Codex dynamic-tool registry. */
  codexToolName: string;
}

const APP_ADVISOR_NAMES = buildInjectedToolNamesForBrand(BRAND).appAdvisor;

function claudeAppAdvisorTool(displayName: string): string {
  return `${APP_ADVISOR_NAMES.claudeNamespacePrefix}${displayName}`;
}

function codexAppAdvisorTool(suffix: string): string {
  return `${APP_ADVISOR_NAMES.codexNamespacePrefix}${suffix}`;
}

/**
 * Canonical registry. Keyed by {@link AppAdvisorToolKey} so consumers can
 * look up a tool's provider-specific names without a switch statement.
 */
export const APP_ADVISOR_TOOL_REGISTRY: Record<
  AppAdvisorToolKey,
  AppAdvisorToolExposure
> = {
  ask_user_question: {
    canonicalKey: 'ask_user_question',
    displayName: 'AskUserQuestion',
    claudeToolName: claudeAppAdvisorTool('AskUserQuestion'),
    codexToolName: codexAppAdvisorTool('ask_user_question'),
  },
  get_script_output: {
    canonicalKey: 'get_script_output',
    displayName: 'GetScriptOutput',
    claudeToolName: claudeAppAdvisorTool('GetScriptOutput'),
    codexToolName: codexAppAdvisorTool('get_script_output'),
  },
  read_pipeline_yaml: {
    canonicalKey: 'read_pipeline_yaml',
    displayName: 'ReadPipelineYaml',
    claudeToolName: claudeAppAdvisorTool('ReadPipelineYaml'),
    codexToolName: codexAppAdvisorTool('read_pipeline_yaml'),
  },
  show_files: {
    canonicalKey: 'show_files',
    displayName: 'ShowFiles',
    claudeToolName: claudeAppAdvisorTool('ShowFiles'),
    codexToolName: codexAppAdvisorTool('show_files'),
  },
  show_capabilities: {
    canonicalKey: 'show_capabilities',
    displayName: 'ShowCapabilities',
    claudeToolName: claudeAppAdvisorTool('ShowCapabilities'),
    codexToolName: codexAppAdvisorTool('show_capabilities'),
  },
  get_file_comments: {
    canonicalKey: 'get_file_comments',
    displayName: 'GetFileComments',
    claudeToolName: claudeAppAdvisorTool('GetFileComments'),
    codexToolName: codexAppAdvisorTool('get_file_comments'),
  },
  respond_to_file_comment: {
    canonicalKey: 'respond_to_file_comment',
    displayName: 'RespondToFileComment',
    claudeToolName: claudeAppAdvisorTool('RespondToFileComment'),
    codexToolName: codexAppAdvisorTool('respond_to_file_comment'),
  },
  search_actions: {
    canonicalKey: 'search_actions',
    displayName: 'SearchActions',
    claudeToolName: claudeAppAdvisorTool('SearchActions'),
    codexToolName: codexAppAdvisorTool('search_actions'),
  },
  get_current_ui_state: {
    canonicalKey: 'get_current_ui_state',
    displayName: 'GetCurrentUiState',
    claudeToolName: claudeAppAdvisorTool('GetCurrentUiState'),
    codexToolName: codexAppAdvisorTool('get_current_ui_state'),
  },
  dispatch_action: {
    canonicalKey: 'dispatch_action',
    displayName: 'DispatchAction',
    claudeToolName: claudeAppAdvisorTool('DispatchAction'),
    codexToolName: codexAppAdvisorTool('dispatch_action'),
  },
  get_pipeline_debug_context: {
    canonicalKey: 'get_pipeline_debug_context',
    displayName: 'GetPipelineDebugContext',
    claudeToolName: claudeAppAdvisorTool('GetPipelineDebugContext'),
    codexToolName: codexAppAdvisorTool('get_pipeline_debug_context'),
  },
  search_watchers: {
    canonicalKey: 'search_watchers',
    displayName: 'SearchWatchers',
    claudeToolName: claudeAppAdvisorTool('SearchWatchers'),
    codexToolName: codexAppAdvisorTool('search_watchers'),
  },
  setup_watchers: {
    canonicalKey: 'setup_watchers',
    displayName: 'SetupWatchers',
    claudeToolName: claudeAppAdvisorTool('SetupWatchers'),
    codexToolName: codexAppAdvisorTool('setup_watchers'),
  },
  watch_github_items: {
    canonicalKey: 'watch_github_items',
    displayName: 'WatchGitHubItems',
    claudeToolName: claudeAppAdvisorTool('WatchGitHubItems'),
    codexToolName: codexAppAdvisorTool('watch_github_items'),
  },
  get_github_pull_request_status: {
    canonicalKey: 'get_github_pull_request_status',
    displayName: 'GetGitHubPullRequestStatus',
    claudeToolName: claudeAppAdvisorTool('GetGitHubPullRequestStatus'),
    codexToolName: codexAppAdvisorTool('get_github_pull_request_status'),
  },
  watch_command: {
    canonicalKey: 'watch_command',
    displayName: 'WatchCommand',
    claudeToolName: claudeAppAdvisorTool('WatchCommand'),
    codexToolName: codexAppAdvisorTool('watch_command'),
  },
  schedule_wakeup: {
    canonicalKey: 'schedule_wakeup',
    displayName: 'ScheduleWakeup',
    claudeToolName: claudeAppAdvisorTool('ScheduleWakeup'),
    codexToolName: codexAppAdvisorTool('schedule_wakeup'),
  },
  set_auto_archive: {
    canonicalKey: 'set_auto_archive',
    displayName: 'SetChatAutoArchive',
    claudeToolName: claudeAppAdvisorTool('SetChatAutoArchive'),
    codexToolName: codexAppAdvisorTool('set_chat_auto_archive'),
  },
  set_work_entry_auto_delete: {
    canonicalKey: 'set_work_entry_auto_delete',
    displayName: 'SetWorkEntryAutoDelete',
    claudeToolName: claudeAppAdvisorTool('SetWorkEntryAutoDelete'),
    codexToolName: codexAppAdvisorTool('set_work_entry_auto_delete'),
  },
  set_project_work_entry_auto_delete: {
    canonicalKey: 'set_project_work_entry_auto_delete',
    displayName: 'SetProjectWorkEntryAutoDelete',
    claudeToolName: claudeAppAdvisorTool('SetProjectWorkEntryAutoDelete'),
    codexToolName: codexAppAdvisorTool('set_project_work_entry_auto_delete'),
  },
  start_forked_agent: {
    canonicalKey: 'start_forked_agent',
    displayName: 'StartForkedAgent',
    claudeToolName: claudeAppAdvisorTool('StartForkedAgent'),
    codexToolName: codexAppAdvisorTool('start_forked_agent'),
  },
  search_deferred_tools: {
    canonicalKey: 'search_deferred_tools',
    displayName: 'SearchDeferredTools',
    claudeToolName: claudeAppAdvisorTool('SearchDeferredTools'),
    codexToolName: codexAppAdvisorTool('search_deferred_tools'),
  },
  load_deferred_tools: {
    canonicalKey: 'load_deferred_tools',
    displayName: 'LoadDeferredTools',
    claudeToolName: claudeAppAdvisorTool('LoadDeferredTools'),
    codexToolName: codexAppAdvisorTool('load_deferred_tools'),
  },
  add_ledger_entry: {
    canonicalKey: 'add_ledger_entry',
    displayName: 'AddFeedEntry',
    claudeToolName: claudeAppAdvisorTool('AddFeedEntry'),
    codexToolName: codexAppAdvisorTool('add_feed_entry'),
  },
  search_ledger_entries: {
    canonicalKey: 'search_ledger_entries',
    displayName: 'SearchFeedEntries',
    claudeToolName: claudeAppAdvisorTool('SearchFeedEntries'),
    codexToolName: codexAppAdvisorTool('search_feed_entries'),
  },
  update_ledger_entry: {
    canonicalKey: 'update_ledger_entry',
    displayName: 'UpdateFeedEntry',
    claudeToolName: claudeAppAdvisorTool('UpdateFeedEntry'),
    codexToolName: codexAppAdvisorTool('update_feed_entry'),
  },
};

/** Ordered list of registry entries — handy for exhaustive iteration. */
export const APP_ADVISOR_TOOL_ENTRIES: readonly AppAdvisorToolExposure[] = [
  APP_ADVISOR_TOOL_REGISTRY.ask_user_question,
  APP_ADVISOR_TOOL_REGISTRY.get_script_output,
  APP_ADVISOR_TOOL_REGISTRY.read_pipeline_yaml,
  APP_ADVISOR_TOOL_REGISTRY.show_files,
  APP_ADVISOR_TOOL_REGISTRY.show_capabilities,
  APP_ADVISOR_TOOL_REGISTRY.get_file_comments,
  APP_ADVISOR_TOOL_REGISTRY.respond_to_file_comment,
  APP_ADVISOR_TOOL_REGISTRY.search_actions,
  APP_ADVISOR_TOOL_REGISTRY.get_current_ui_state,
  APP_ADVISOR_TOOL_REGISTRY.dispatch_action,
  APP_ADVISOR_TOOL_REGISTRY.get_pipeline_debug_context,
  APP_ADVISOR_TOOL_REGISTRY.search_watchers,
  APP_ADVISOR_TOOL_REGISTRY.setup_watchers,
  APP_ADVISOR_TOOL_REGISTRY.watch_github_items,
  APP_ADVISOR_TOOL_REGISTRY.get_github_pull_request_status,
  APP_ADVISOR_TOOL_REGISTRY.watch_command,
  APP_ADVISOR_TOOL_REGISTRY.schedule_wakeup,
  APP_ADVISOR_TOOL_REGISTRY.set_auto_archive,
  APP_ADVISOR_TOOL_REGISTRY.set_work_entry_auto_delete,
  APP_ADVISOR_TOOL_REGISTRY.set_project_work_entry_auto_delete,
  APP_ADVISOR_TOOL_REGISTRY.start_forked_agent,
  APP_ADVISOR_TOOL_REGISTRY.search_deferred_tools,
  APP_ADVISOR_TOOL_REGISTRY.load_deferred_tools,
  APP_ADVISOR_TOOL_REGISTRY.add_ledger_entry,
  APP_ADVISOR_TOOL_REGISTRY.search_ledger_entries,
  APP_ADVISOR_TOOL_REGISTRY.update_ledger_entry,
];

/** Closed list of the App Advisor's canonical tool keys. */
export const APP_ADVISOR_TOOL_KEYS: readonly AppAdvisorToolKey[] = [
  'ask_user_question',
  'get_script_output',
  'read_pipeline_yaml',
  'show_files',
  'show_capabilities',
  'get_file_comments',
  'respond_to_file_comment',
  'search_actions',
  'get_current_ui_state',
  'dispatch_action',
  'get_pipeline_debug_context',
  'search_watchers',
  'setup_watchers',
  'watch_github_items',
  'get_github_pull_request_status',
  'watch_command',
  'schedule_wakeup',
  'set_auto_archive',
  'set_work_entry_auto_delete',
  'set_project_work_entry_auto_delete',
  'start_forked_agent',
  'search_deferred_tools',
  'load_deferred_tools',
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
] as const;

const LEGACY_APP_ADVISOR_CODEX_TOOL_NAMES: Readonly<
  Partial<Record<AppAdvisorToolKey, readonly string[]>>
> = {
  ask_user_question: ['app_advisor_ask_user_question'],
  get_script_output: ['app_advisor_get_script_output'],
  read_pipeline_yaml: ['app_advisor_read_pipeline_yaml'],
  show_files: ['app_advisor_show_files'],
  show_capabilities: ['app_advisor_show_capabilities'],
  get_file_comments: ['app_advisor_get_file_comments'],
  respond_to_file_comment: ['app_advisor_respond_to_file_comment'],
  search_actions: ['app_advisor_search_actions'],
  get_current_ui_state: ['app_advisor_get_current_ui_state'],
  dispatch_action: ['app_advisor_dispatch_action'],
  get_pipeline_debug_context: ['app_advisor_get_pipeline_debug_context'],
  search_watchers: ['app_advisor_search_watchers'],
  setup_watchers: ['app_advisor_setup_watchers'],
  watch_github_items: ['app_advisor_watch_github_items'],
  get_github_pull_request_status: [],
  watch_command: [],
  schedule_wakeup: [],
  set_auto_archive: [
    'app_advisor_set_auto_archive',
    'app_advisor_archive_chat',
    'SetAutoArchive',
    'ArchiveChat',
    claudeAppAdvisorTool('SetAutoArchive'),
    claudeAppAdvisorTool('ArchiveChat'),
    codexAppAdvisorTool('archive_chat'),
    codexAppAdvisorTool('set_auto_archive'),
  ],
  set_work_entry_auto_delete: [],
  set_project_work_entry_auto_delete: [],
  start_forked_agent: [],
  search_deferred_tools: ['app_advisor_search_deferred_tools'],
  load_deferred_tools: ['app_advisor_load_deferred_tools'],
  add_ledger_entry: [],
  search_ledger_entries: [],
  update_ledger_entry: [],
};

const APP_ADVISOR_MCP_DISPLAY_TO_KEY: ReadonlyMap<string, AppAdvisorToolKey> =
  new Map<string, AppAdvisorToolKey>([
    ...APP_ADVISOR_TOOL_ENTRIES.map((entry): [string, AppAdvisorToolKey] => [
      entry.displayName,
      entry.canonicalKey,
    ]),
    // The Agent Ledger tools' names before they took the Feed's, for
    // persisted transcript recognition.
    ['SetAutoArchive', 'set_auto_archive'],
    ['ArchiveChat', 'set_auto_archive'],
    ['AddLedgerEntry', 'add_ledger_entry'],
    ['SearchLedgerEntries', 'search_ledger_entries'],
    ['UpdateLedgerEntry', 'update_ledger_entry'],
  ]);

const APP_ADVISOR_CODEX_SUFFIX_TO_KEY: ReadonlyMap<string, AppAdvisorToolKey> =
  new Map([
    ['ask_user_question', 'ask_user_question'],
    ['get_script_output', 'get_script_output'],
    ['read_pipeline_yaml', 'read_pipeline_yaml'],
    ['show_files', 'show_files'],
    ['show_capabilities', 'show_capabilities'],
    ['get_file_comments', 'get_file_comments'],
    ['respond_to_file_comment', 'respond_to_file_comment'],
    ['search_actions', 'search_actions'],
    ['get_current_ui_state', 'get_current_ui_state'],
    ['dispatch_action', 'dispatch_action'],
    ['get_pipeline_debug_context', 'get_pipeline_debug_context'],
    ['search_watchers', 'search_watchers'],
    ['setup_watchers', 'setup_watchers'],
    ['watch_github_items', 'watch_github_items'],
    ['get_github_pull_request_status', 'get_github_pull_request_status'],
    ['watch_command', 'watch_command'],
    ['schedule_wakeup', 'schedule_wakeup'],
    ['set_auto_archive', 'set_auto_archive'],
    ['set_chat_auto_archive', 'set_auto_archive'],
    ['archive_chat', 'set_auto_archive'],
    ['set_work_entry_auto_delete', 'set_work_entry_auto_delete'],
    [
      'set_project_work_entry_auto_delete',
      'set_project_work_entry_auto_delete',
    ],
    ['start_forked_agent', 'start_forked_agent'],
    ['search_deferred_tools', 'search_deferred_tools'],
    ['load_deferred_tools', 'load_deferred_tools'],
    ['add_feed_entry', 'add_ledger_entry'],
    ['search_feed_entries', 'search_ledger_entries'],
    ['update_feed_entry', 'update_ledger_entry'],
    // Historical Agent Ledger suffixes, for persisted transcript recognition.
    ['add_ledger_entry', 'add_ledger_entry'],
    ['search_ledger_entries', 'search_ledger_entries'],
    ['update_ledger_entry', 'update_ledger_entry'],
  ]);

function getBrandedAppAdvisorToolKey(
  toolName: string,
): AppAdvisorToolKey | null {
  const mcpMatch = toolName.match(/^mcp__(.+)_app_advisor__(.+)$/);
  if (mcpMatch) {
    return APP_ADVISOR_MCP_DISPLAY_TO_KEY.get(mcpMatch[2]) ?? null;
  }

  const codexMatch = toolName.match(
    /^(.+)_app_advisor_(ask_user_question|get_script_output|read_pipeline_yaml|show_files|show_capabilities|get_file_comments|respond_to_file_comment|search_actions|get_current_ui_state|dispatch_action|get_pipeline_debug_context|search_watchers|setup_watchers|watch_github_items|get_github_pull_request_status|watch_command|schedule_wakeup|set_auto_archive|set_chat_auto_archive|archive_chat|set_work_entry_auto_delete|set_project_work_entry_auto_delete|start_forked_agent|search_deferred_tools|load_deferred_tools|add_feed_entry|search_feed_entries|update_feed_entry|add_ledger_entry|search_ledger_entries|update_ledger_entry)$/,
  );
  if (codexMatch) {
    return APP_ADVISOR_CODEX_SUFFIX_TO_KEY.get(codexMatch[2]) ?? null;
  }

  return null;
}

/**
 * Returns the provider-accurate raw tool name for a canonical App Advisor
 * capability key. Used by transport code that registers tools with the
 * Claude MCP server / Codex dynamic-tool registry.
 */
export function getAppAdvisorProviderToolName(
  key: AppAdvisorToolKey,
  provider: AppAdvisorToolProvider,
): string {
  const exposure = APP_ADVISOR_TOOL_REGISTRY[key];
  return provider === 'claude'
    ? exposure.claudeToolName
    : exposure.codexToolName;
}

const APP_ADVISOR_LEDGER_TOOL_KEYS: ReadonlySet<AppAdvisorToolKey> =
  new Set<AppAdvisorToolKey>([
    'add_ledger_entry',
    'search_ledger_entries',
    'update_ledger_entry',
  ]);

/**
 * True for the Agent Ledger tools, which a session advertises and runs only
 * when its Ledger exposure gate passed when it started.
 */
export function isAppAdvisorLedgerToolKey(
  key: AppAdvisorToolKey,
): key is AppAdvisorLedgerToolKey {
  return APP_ADVISOR_LEDGER_TOOL_KEYS.has(key);
}

/**
 * The names an App Advisor session's agent calls the Ledger tools by, for the
 * Ledger prompt and turn-start hint.
 */
export function getAppAdvisorLedgerToolNames(
  provider: AppAdvisorToolProvider,
): {
  readonly add: string;
  readonly search: string;
  readonly update: string;
} {
  return {
    add: getAppAdvisorProviderToolName('add_ledger_entry', provider),
    search: getAppAdvisorProviderToolName('search_ledger_entries', provider),
    update: getAppAdvisorProviderToolName('update_ledger_entry', provider),
  };
}

/**
 * Resolve a raw tool name (from either provider) to its canonical App
 * Advisor capability key. Returns `null` for tool names that are not part
 * of the App Advisor registry. Use this in renderer/main routing code so
 * the App Advisor's tool set stays distinct from the worktree-scoped
 * Canopy injected tools.
 */
export function getCanonicalAppAdvisorToolKey(
  toolName: string | null | undefined,
): AppAdvisorToolKey | null {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return null;
  }
  for (const exposure of APP_ADVISOR_TOOL_ENTRIES) {
    if (
      toolName === exposure.claudeToolName ||
      toolName === exposure.codexToolName ||
      LEGACY_APP_ADVISOR_CODEX_TOOL_NAMES[exposure.canonicalKey]?.includes(
        toolName,
      ) === true
    ) {
      return exposure.canonicalKey;
    }
  }
  return getBrandedAppAdvisorToolKey(toolName);
}

/** True when `toolName` resolves to one of the App Advisor's tools. */
export function isAppAdvisorToolName(
  toolName: string | null | undefined,
): boolean {
  return getCanonicalAppAdvisorToolKey(toolName) !== null;
}
