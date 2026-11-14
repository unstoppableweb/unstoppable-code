// This module exports both a registry-driven `getToolDisplayInfo` helper and a
// handful of small JSX helpers used by the per-tool renderers. None of the
// helpers are intended to be rendered as standalone React components, so the
// react-refresh fast-refresh constraint does not apply here.
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type { JSX, ReactNode } from 'react';
import {
  DocumentIcon,
  TerminalIcon,
  TerminalBorderedIcon,
  WrenchIcon,
  DocumentSearchIcon,
  MagnifyingGlassIcon,
  GlobeIcon,
  GraphIcon,
  QuestionMarkIcon,
  StopIcon,
  StopwatchIcon,
  ScheduleIcon,
  AgentIcon,
  AppAdvisorIcon,
  AppAdvisorWatcherIcon,
  ArchiveIcon,
  PipelineIcon,
  MonitorIcon,
  McpIcon,
  TrashIcon,
  SkillIcon,
  PlanModeIcon,
  CodeBracketsIcon,
  ClaudeLogo,
} from '../../icons';
import { TaskIcon as AppCatalogTaskIcon } from '../../icons/AppIcons';
import { DocumentPencilIcon, PickIcon } from '../../icons/AppIcons';
import { capitalizeFirstLetter } from '../../lib/text-format';
import { useStepBadges, useStepTense } from '../chat-look';
import { StepBadge } from './StepBadge';
import type { PortalChatToolFamily } from './tool-display-info';
import type { AnsweredQuestionDisplay } from './AskUserQuestionCard';
import { normalizeCommandReadToolBlock } from '@canopy/agent-transcript/lib/command-read-display';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolDisplayInfo {
  icon: JSX.Element;
  label: ReactNode;
}

/**
 * Optional chat-surface hint threaded down from the host so a shared tool
 * (same raw name in more than one chat surface) can pick a surface-flavored
 * icon. Currently only consumed by the plan/review comment-tool family: the
 * `RespondToComment` reply tool is identical in Plan Explore and Code Review
 * chats, so `GetReviewComments`'s distinct name alone can't tell
 * `RespondToComment` apart — the host passes `isCodeReview` instead. Hosts
 * that cannot thread chat scope (e.g. the Portal web renderer, which does not
 * share Code Review chats) simply omit this and get the neutral Plan icon.
 */
export interface ToolDisplayScope {
  /** True when the tool call happened inside a Code Review sidecar chat
   * rather than a Plan Explore chat. */
  isCodeReview?: boolean;
  /** MCP namespace injected by the current branded app runtime. */
  trustedMcpNamespace?: string;
}

type ParsedInput = Record<string, unknown>;

type ToolDisplayRenderer = (
  parsed: ParsedInput,
  input: string,
  toolName: string,
  scope?: ToolDisplayScope,
) => ToolDisplayInfo;

interface ToolDisplayMatcher {
  match: (toolName: string, scope?: ToolDisplayScope) => boolean;
  render: ToolDisplayRenderer;
}

const LEGACY_TOOL_NAMESPACE = ['cano', 'py'].join('');
const legacyMcpToolName = (name: string): string =>
  `mcp__${LEGACY_TOOL_NAMESPACE}__${name}`;
const legacyCodexToolName = (suffix: string): string =>
  `${LEGACY_TOOL_NAMESPACE}_${suffix}`;
/**
 * The pinned Cursor CLI's `"<server>: <tool>"` title for a call on the app's
 * MCP server under the default namespace. A branded namespace's titles fold
 * only through the host's trusted namespace.
 */
const legacyCursorToolTitle = (name: string): string =>
  `${LEGACY_TOOL_NAMESPACE}: ${name}`;

const COMPUTER_USE_TOOL_NAMES = new Set([
  'mcp__cua_repl__js',
  'mcp__cua_repl__js_reset',
]);

/** Exact recognizer for the two tools exposed by the Computer Use REPL MCP. */
export function isComputerUseToolName(toolName: string): boolean {
  return COMPUTER_USE_TOOL_NAMES.has(toolName);
}

// ---------------------------------------------------------------------------
// Pure helpers (shared with hosts via this barrel)
// ---------------------------------------------------------------------------

/**
 * Strip app-managed MCP server prefixes from a raw server segment.
 *
 * The app injects servers under three prefixes:
 *
 * - `appdyn-<friendly>--<digest>` — dynamic worktree-scoped MCP servers.
 * - `appproxy-<friendly>--<digest>` — proxied OAuth-backed MCP servers.
 * - `appplugin-<friendly>--<digest>` — plugin-declared MCP servers routed
 *   through the app in both app-managed and provider HTTP-auth modes.
 */
function normalizeCanopyMcpServerDisplayName(serverName: string): string {
  const prefixes = [
    'appdyn-',
    'appproxy-',
    'appplugin-',
    // Historical persisted transcript names.
    `${LEGACY_TOOL_NAMESPACE}dyn-`,
    `${LEGACY_TOOL_NAMESPACE}proxy-`,
    `${LEGACY_TOOL_NAMESPACE}plugin-`,
  ];
  for (const prefix of prefixes) {
    if (serverName.startsWith(prefix)) {
      const withoutPrefix = serverName.slice(prefix.length);
      const separatorIndex = withoutPrefix.indexOf('--');
      return separatorIndex > 0
        ? withoutPrefix.slice(0, separatorIndex)
        : withoutPrefix;
    }
  }
  return serverName;
}

/**
 * Parse an MCP tool name (`mcp__<server>__<tool>`) into its server + tool
 * components. Returns `null` for non-MCP names and for the in-process app MCP
 * server, which is rendered through dedicated predicate matchers instead.
 */
export function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) {
    return null;
  }
  if (toolName.startsWith(`mcp__${LEGACY_TOOL_NAMESPACE}__`)) {
    return null;
  }

  const parts = toolName.split('__');
  if (parts.length < 3) {
    return null;
  }

  const rawServer = parts[1];
  const tool = parts.slice(2).join('__');

  return { server: normalizeCanopyMcpServerDisplayName(rawServer), tool };
}

/**
 * Strip shell wrappers that some providers add around command invocations so
 * the tool-call label shows the inner command.
 */
export function unwrapShellWrappedCommand(command: string): string {
  const singleQuotedShellWrapMatch = command.match(
    /^\/bin\/\S+\s+-\S+\s+'((?:[^'\\]|\\.)*)'$/,
  );
  if (singleQuotedShellWrapMatch) {
    return singleQuotedShellWrapMatch[1];
  }

  const doubleQuotedShellWrapMatch = command.match(
    /^\/bin\/\S+\s+-\S+\s+"((?:[^"\\]|\\.)*)"$/,
  );
  if (doubleQuotedShellWrapMatch) {
    return doubleQuotedShellWrapMatch[1];
  }

  const windowsCommandPrefixMatch = command.match(
    /^["'][^"']*\\(?:pwsh|powershell)\.exe["']\s+-Command\b\s*/i,
  );
  if (windowsCommandPrefixMatch) {
    const payload = command.slice(windowsCommandPrefixMatch[0].length).trim();
    const unwrappedPayload = unwrapWholeQuotedPayload(payload);
    return unwrappedPayload ?? payload;
  }

  return command;
}

function unwrapWholeQuotedPayload(payload: string): string | null {
  const quote = payload[0];
  if (quote !== "'" && quote !== '"') {
    return payload.length > 0 ? payload : null;
  }

  let escaped = false;
  for (let index = 1; index < payload.length; index += 1) {
    const char = payload[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote && payload.slice(index + 1).trim().length === 0) {
      return payload.slice(1, index);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Canopy-injected ask-user / script-output alias detection
// ---------------------------------------------------------------------------

type AppInjectedCapability =
  | 'ask_user_question'
  | 'get_script_output'
  | 'spawn_delegate'
  | 'watch_delegates'
  | 'get_delegate_output'
  | 'wait_delegates'
  | 'inspect_delegate'
  | 'list_delegates'
  | 'stop_delegate'
  | 'manage_delegate'
  | 'manage_delegate_worktree'
  | 'message_delegate'
  | 'request_steering'
  | 'set_auto_archive'
  | CanopyActionCapability;

const ASK_USER_TOOL_ALIASES: ReadonlySet<string> = new Set([
  legacyMcpToolName('AskUserQuestion'),
  legacyCodexToolName('ask_user_question'),
  'AskUserQuestion',
  'request_user_input',
]);

const GET_SCRIPT_OUTPUT_TOOL_ALIASES: ReadonlySet<string> = new Set([
  legacyMcpToolName('GetScriptOutput'),
  legacyCodexToolName('get_script_output'),
  'GetScriptOutput',
]);

const SET_AUTO_ARCHIVE_TOOL_ALIASES: ReadonlySet<string> = new Set([
  'SetChatAutoArchive',
  legacyMcpToolName('SetAutoArchive'),
  legacyCodexToolName('set_auto_archive'),
  'SetAutoArchive',
  legacyMcpToolName('ArchiveChat'),
  legacyCodexToolName('archive_chat'),
  'ArchiveChat',
]);

const APP_ACTION_TOOL_ALIASES: ReadonlySet<string> = new Set([
  'ShowVisual',
  'PreviewVisual',
  'ShowCapabilities',
  'SetWorkEntryAutoDelete',
  legacyMcpToolName('ShowFiles'),
  legacyCodexToolName('show_files'),
  'ShowFiles',
  legacyMcpToolName('GetFileComments'),
  legacyCodexToolName('get_file_comments'),
  'GetFileComments',
  legacyMcpToolName('RespondToFileComment'),
  legacyCodexToolName('respond_to_file_comment'),
  'RespondToFileComment',
  legacyMcpToolName('SearchActions'),
  legacyCodexToolName('search_actions'),
  'SearchActions',
  legacyMcpToolName('DispatchAction'),
  legacyCodexToolName('dispatch_action'),
  'DispatchAction',
  legacyMcpToolName('GetGitPreferences'),
  legacyCodexToolName('get_git_preferences'),
  'GetGitPreferences',
  legacyMcpToolName('SaveMemory'),
  legacyCodexToolName('save_memory'),
  'SaveMemory',
  legacyMcpToolName('SearchMemory'),
  legacyCodexToolName('search_memory'),
  'SearchMemory',
  legacyMcpToolName('ReadMemory'),
  legacyCodexToolName('read_memory'),
  legacyMcpToolName('SearchChats'),
  legacyCodexToolName('search_chats'),
  legacyCursorToolTitle('SearchChats'),
  'SearchChats',
  legacyMcpToolName('ReadChatExcerpt'),
  legacyCodexToolName('read_chat_excerpt'),
  legacyCursorToolTitle('ReadChatExcerpt'),
  'ReadChatExcerpt',
  'ReadMemory',
  legacyMcpToolName('ReadPipelineYaml'),
  legacyCodexToolName('read_pipeline_yaml'),
  'ReadPipelineYaml',
  legacyMcpToolName('SearchWatchers'),
  legacyCodexToolName('search_watchers'),
  'SearchWatchers',
  legacyMcpToolName('SetupWatchers'),
  legacyCodexToolName('setup_watchers'),
  'SetupWatchers',
  legacyMcpToolName('WatchGitHubItems'),
  legacyCodexToolName('watch_github_items'),
  'WatchGitHubItems',
  legacyMcpToolName('GetGitHubPullRequestStatus'),
  legacyCodexToolName('get_github_pull_request_status'),
  'GetGitHubPullRequestStatus',
  legacyMcpToolName('DeleteWatchers'),
  legacyCodexToolName('delete_watchers'),
  'DeleteWatchers',
  legacyMcpToolName('SetBaseBranch'),
  legacyMcpToolName('StartForkedAgent'),
  legacyMcpToolName('StartBranchedAgent'),
  legacyCodexToolName('set_base_branch'),
  legacyCodexToolName('start_forked_agent'),
  legacyCodexToolName('start_branched_agent'),
  'SetBaseBranch',
  'StartForkedAgent',
  'StartBranchedAgent',
  legacyMcpToolName('SearchDeferredTools'),
  legacyCodexToolName('search_deferred_tools'),
  'SearchDeferredTools',
  legacyMcpToolName('LoadDeferredTools'),
  legacyCodexToolName('load_deferred_tools'),
  'LoadDeferredTools',
  legacyMcpToolName('GetCodeGraphContext'),
  legacyCodexToolName('get_code_graph_context'),
  'GetCodeGraphContext',
  legacyMcpToolName('BuildOrUpdateCodeGraph'),
  legacyCodexToolName('build_or_update_code_graph'),
  'BuildOrUpdateCodeGraph',
  legacyMcpToolName('QueryCodeGraph'),
  legacyCodexToolName('query_code_graph'),
  'QueryCodeGraph',
  legacyMcpToolName('SearchCodeGraph'),
  legacyCodexToolName('search_code_graph'),
  'SearchCodeGraph',
  legacyMcpToolName('ExplainCodeSymbol'),
  legacyCodexToolName('explain_code_symbol'),
  'ExplainCodeSymbol',
  legacyMcpToolName('GetImpactRadius'),
  legacyCodexToolName('get_impact_radius'),
  'GetImpactRadius',
  legacyMcpToolName('DetectChangedSymbols'),
  legacyCodexToolName('detect_changed_symbols'),
  'DetectChangedSymbols',
  legacyMcpToolName('CompareChangeImpact'),
  legacyCodexToolName('compare_change_impact'),
  'CompareChangeImpact',
  legacyMcpToolName('GetReviewContext'),
  legacyCodexToolName('get_review_context'),
  'GetReviewContext',
  legacyMcpToolName('AddFeedEntry'),
  legacyCodexToolName('add_feed_entry'),
  legacyCursorToolTitle('AddFeedEntry'),
  'AddFeedEntry',
  legacyMcpToolName('SearchFeedEntries'),
  legacyCodexToolName('search_feed_entries'),
  legacyCursorToolTitle('SearchFeedEntries'),
  'SearchFeedEntries',
  legacyMcpToolName('UpdateFeedEntry'),
  legacyCodexToolName('update_feed_entry'),
  legacyCursorToolTitle('UpdateFeedEntry'),
  'UpdateFeedEntry',
  // The Agent Ledger tools' names before they took the Feed's.
  legacyMcpToolName('AddLedgerEntry'),
  legacyCodexToolName('add_ledger_entry'),
  legacyCursorToolTitle('AddLedgerEntry'),
  'AddLedgerEntry',
  legacyMcpToolName('SearchLedgerEntries'),
  legacyCodexToolName('search_ledger_entries'),
  legacyCursorToolTitle('SearchLedgerEntries'),
  'SearchLedgerEntries',
  legacyMcpToolName('UpdateLedgerEntry'),
  legacyCodexToolName('update_ledger_entry'),
  legacyCursorToolTitle('UpdateLedgerEntry'),
  'UpdateLedgerEntry',
]);

const APP_MCP_DISPLAY_TO_CAPABILITY: ReadonlyMap<
  string,
  AppInjectedCapability
> = new Map([
  ['AskUserQuestion', 'ask_user_question'],
  ['GetScriptOutput', 'get_script_output'],
  ['ManageDelegate', 'manage_delegate'],
  ['ManageDelegateWorktree', 'manage_delegate_worktree'],
  ['MessageDelegate', 'message_delegate'],
  ['RequestSteering', 'request_steering'],
  ['DelegateTask', 'spawn_delegate'],
  ['WatchDelegates', 'watch_delegates'],
  ['GetDelegateOutput', 'get_delegate_output'],
  ['WaitDelegates', 'wait_delegates'],
  ['InspectDelegate', 'inspect_delegate'],
  ['ListDelegates', 'list_delegates'],
  ['StopDelegate', 'stop_delegate'],
  ['SetChatAutoArchive', 'set_auto_archive'],
  ['SetAutoArchive', 'set_auto_archive'],
  ['ArchiveChat', 'set_auto_archive'],
  ['SetWorkEntryAutoDelete', 'set_work_entry_auto_delete'],
  ['ShowFiles', 'show_files'],
  ['ShowCapabilities', 'show_capabilities'],
  ['ShowVisual', 'show_visual'],
  ['PreviewVisual', 'preview_visual'],
  ['GetFileComments', 'get_file_comments'],
  ['RespondToFileComment', 'respond_to_file_comment'],
  ['SearchActions', 'search_actions'],
  ['DispatchAction', 'dispatch_action'],
  ['GetGitPreferences', 'get_git_preferences'],
  ['SaveMemory', 'save_memory'],
  ['SearchMemory', 'search_memory'],
  ['SearchChats', 'search_chats'],
  ['ReadChatExcerpt', 'read_chat_excerpt'],
  ['ReadMemory', 'read_memory'],
  ['ReadPipelineYaml', 'read_pipeline_yaml'],
  ['SearchWatchers', 'search_watchers'],
  ['SetupWatchers', 'setup_watchers'],
  ['WatchGitHubItems', 'watch_github_items'],
  ['GetGitHubPullRequestStatus', 'get_github_pull_request_status'],
  ['WatchCommand', 'watch_command'],
  ['ScheduleWakeup', 'schedule_wakeup'],
  ['DeleteWatchers', 'delete_watchers'],
  ['SetBaseBranch', 'set_base_branch'],
  ['StartForkedAgent', 'start_forked_agent'],
  ['StartBranchedAgent', 'start_branched_agent'],
  ['SearchDeferredTools', 'search_deferred_tools'],
  ['LoadDeferredTools', 'load_deferred_tools'],
  ['GetCodeGraphContext', 'get_code_graph_context'],
  ['BuildOrUpdateCodeGraph', 'build_or_update_code_graph'],
  ['QueryCodeGraph', 'query_code_graph'],
  ['SearchCodeGraph', 'search_code_graph'],
  ['ExplainCodeSymbol', 'explain_code_symbol'],
  ['GetImpactRadius', 'get_impact_radius'],
  ['DetectChangedSymbols', 'detect_changed_symbols'],
  ['CompareChangeImpact', 'compare_change_impact'],
  ['GetReviewContext', 'get_review_context'],
  ['AddFeedEntry', 'add_ledger_entry'],
  ['SearchFeedEntries', 'search_ledger_entries'],
  ['UpdateFeedEntry', 'update_ledger_entry'],
  // The Agent Ledger tools' names before they took the Feed's.
  ['AddLedgerEntry', 'add_ledger_entry'],
  ['SearchLedgerEntries', 'search_ledger_entries'],
  ['UpdateLedgerEntry', 'update_ledger_entry'],
]);

const APP_CODEX_SUFFIX_TO_CAPABILITY: ReadonlyMap<
  string,
  AppInjectedCapability
> = new Map([
  ['ask_user_question', 'ask_user_question'],
  ['get_script_output', 'get_script_output'],
  ['manage_delegate', 'manage_delegate'],
  ['manage_delegate_worktree', 'manage_delegate_worktree'],
  ['message_delegate', 'message_delegate'],
  ['request_steering', 'request_steering'],
  ['spawn_delegate', 'spawn_delegate'],
  ['watch_delegates', 'watch_delegates'],
  ['get_delegate_output', 'get_delegate_output'],
  ['wait_delegates', 'wait_delegates'],
  ['inspect_delegate', 'inspect_delegate'],
  ['list_delegates', 'list_delegates'],
  ['stop_delegate', 'stop_delegate'],
  ['set_chat_auto_archive', 'set_auto_archive'],
  ['set_auto_archive', 'set_auto_archive'],
  ['archive_chat', 'set_auto_archive'],
  ['set_work_entry_auto_delete', 'set_work_entry_auto_delete'],
  ['show_files', 'show_files'],
  ['show_capabilities', 'show_capabilities'],
  ['show_visual', 'show_visual'],
  ['preview_visual', 'preview_visual'],
  ['get_file_comments', 'get_file_comments'],
  ['respond_to_file_comment', 'respond_to_file_comment'],
  ['search_actions', 'search_actions'],
  ['dispatch_action', 'dispatch_action'],
  ['get_git_preferences', 'get_git_preferences'],
  ['save_memory', 'save_memory'],
  ['search_memory', 'search_memory'],
  ['search_chats', 'search_chats'],
  ['read_chat_excerpt', 'read_chat_excerpt'],
  ['read_memory', 'read_memory'],
  ['read_pipeline_yaml', 'read_pipeline_yaml'],
  ['search_watchers', 'search_watchers'],
  ['setup_watchers', 'setup_watchers'],
  ['watch_github_items', 'watch_github_items'],
  ['get_github_pull_request_status', 'get_github_pull_request_status'],
  ['watch_command', 'watch_command'],
  ['schedule_wakeup', 'schedule_wakeup'],
  ['delete_watchers', 'delete_watchers'],
  ['set_base_branch', 'set_base_branch'],
  ['start_forked_agent', 'start_forked_agent'],
  ['start_branched_agent', 'start_branched_agent'],
  ['search_deferred_tools', 'search_deferred_tools'],
  ['load_deferred_tools', 'load_deferred_tools'],
  ['immediate_turn_restart', 'immediate_turn_restart'],
  ['get_code_graph_context', 'get_code_graph_context'],
  ['build_or_update_code_graph', 'build_or_update_code_graph'],
  ['query_code_graph', 'query_code_graph'],
  ['search_code_graph', 'search_code_graph'],
  ['explain_code_symbol', 'explain_code_symbol'],
  ['get_impact_radius', 'get_impact_radius'],
  ['detect_changed_symbols', 'detect_changed_symbols'],
  ['compare_change_impact', 'compare_change_impact'],
  ['get_review_context', 'get_review_context'],
  ['add_feed_entry', 'add_ledger_entry'],
  ['search_feed_entries', 'search_ledger_entries'],
  ['update_feed_entry', 'update_ledger_entry'],
  // The Agent Ledger tools' suffixes before they took the Feed's.
  ['add_ledger_entry', 'add_ledger_entry'],
  ['search_ledger_entries', 'search_ledger_entries'],
  ['update_ledger_entry', 'update_ledger_entry'],
]);

function isTrustedImmediateTurnRestartToolName(
  toolName: string,
  scope?: ToolDisplayScope,
): boolean {
  const namespace = scope?.trustedMcpNamespace;
  return (
    typeof namespace === 'string' &&
    toolName === `${namespace}_immediate_turn_restart`
  );
}

/**
 * The Agent Ledger tools. Every surface records into the same Ledger, so a
 * Ledger call renders the same wherever it ran: App Advisor's names for them
 * fold into this app-tool Ledger UX rather than the `app-advisor` family (as
 * the watcher tools keep their `watcher` family there), and so does the
 * pinned Cursor CLI's `"<namespace>: <DisplayName>"` title for them.
 */
const LEDGER_CAPABILITIES: ReadonlySet<AppInjectedCapability> = new Set([
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
]);

function asLedgerCapability(
  capability: AppInjectedCapability | undefined,
): AppInjectedCapability | null {
  return capability !== undefined && LEDGER_CAPABILITIES.has(capability)
    ? capability
    : null;
}

/**
 * A Cursor title for a Ledger tool on the host's own MCP server. The default
 * namespace's titles are exact aliases; a branded namespace folds only when it
 * is the one the host trusts, so another server's same-named tool does not.
 */
function getTrustedCursorTitleLedgerCapability(
  toolName: string,
  scope?: ToolDisplayScope,
): AppInjectedCapability | null {
  const namespace = scope?.trustedMcpNamespace;
  if (typeof namespace !== 'string' || namespace.length === 0) {
    return null;
  }
  const prefix = `${namespace}: `;
  return toolName.startsWith(prefix)
    ? asLedgerCapability(
        APP_MCP_DISPLAY_TO_CAPABILITY.get(toolName.slice(prefix.length)),
      )
    : null;
}

function getBrandedAppCapability(
  toolName: string,
  scope?: ToolDisplayScope,
): AppInjectedCapability | null {
  // Cursor persists the MCP title (`<server>: PreviewVisual`) rather than its
  // provider-native name. Treat ambiguous titles conservatively: hiding an
  // unrelated tool's HTML is safer than exposing a preview document in a row.
  if (/^[^:]+: PreviewVisual$/.test(toolName)) return 'preview_visual';
  const mcpMatch = toolName.match(/^mcp__(.+)__(.+)$/);
  if (mcpMatch) {
    const namespace = mcpMatch[1];
    const displayName = mcpMatch[2];
    if (!namespace.endsWith('_app_advisor')) {
      const capability = APP_MCP_DISPLAY_TO_CAPABILITY.get(displayName) ?? null;
      if (
        (capability === 'search_deferred_tools' ||
          capability === 'load_deferred_tools') &&
        namespace !== scope?.trustedMcpNamespace
      ) {
        return null;
      }
      return capability;
    }
    const ledgerCapability = asLedgerCapability(
      APP_MCP_DISPLAY_TO_CAPABILITY.get(displayName),
    );
    if (ledgerCapability) {
      return ledgerCapability;
    }
  }

  const codexMatch = toolName.match(
    /^(.+?)_(ask_user_question|get_script_output|spawn_delegate|watch_delegates|get_delegate_output|wait_delegates|inspect_delegate|list_delegates|stop_delegate|manage_delegate_worktree|message_delegate|request_steering|manage_delegate|set_chat_auto_archive|set_auto_archive|set_work_entry_auto_delete|set_base_branch|start_forked_agent|start_branched_agent|archive_chat|show_files|show_capabilities|show_visual|preview_visual|get_file_comments|respond_to_file_comment|search_actions|dispatch_action|get_git_preferences|save_memory|search_memory|search_chats|read_chat_excerpt|read_memory|read_pipeline_yaml|search_watchers|setup_watchers|watch_github_items|get_github_pull_request_status|watch_command|schedule_wakeup|delete_watchers|search_deferred_tools|load_deferred_tools|immediate_turn_restart|get_code_graph_context|build_or_update_code_graph|query_code_graph|search_code_graph|explain_code_symbol|get_impact_radius|detect_changed_symbols|compare_change_impact|get_review_context|add_feed_entry|search_feed_entries|update_feed_entry|add_ledger_entry|search_ledger_entries|update_ledger_entry)$/,
  );
  if (codexMatch) {
    const namespace = codexMatch[1];
    const suffix = codexMatch[2];
    if (!namespace.endsWith('_app_advisor')) {
      if (
        suffix === 'immediate_turn_restart' &&
        !isTrustedImmediateTurnRestartToolName(toolName, scope)
      ) {
        return null;
      }
      return APP_CODEX_SUFFIX_TO_CAPABILITY.get(suffix) ?? null;
    }
    const ledgerCapability = asLedgerCapability(
      APP_CODEX_SUFFIX_TO_CAPABILITY.get(suffix),
    );
    if (ledgerCapability) {
      return ledgerCapability;
    }
  }

  const namespace = scope?.trustedMcpNamespace;
  if (namespace && toolName.startsWith(`${namespace}: `)) {
    const capability = APP_MCP_DISPLAY_TO_CAPABILITY.get(
      toolName.slice(namespace.length + 2),
    );
    if (capability === 'search_chats' || capability === 'read_chat_excerpt')
      return capability;
  }
  return getTrustedCursorTitleLedgerCapability(toolName, scope);
}

export function isAskUserQuestionToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' &&
    (ASK_USER_TOOL_ALIASES.has(toolName) ||
      getBrandedAppCapability(toolName) === 'ask_user_question')
  );
}

export function isGetScriptOutputToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' &&
    (GET_SCRIPT_OUTPUT_TOOL_ALIASES.has(toolName) ||
      getBrandedAppCapability(toolName) === 'get_script_output')
  );
}

export function isSetAutoArchiveToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' &&
    (SET_AUTO_ARCHIVE_TOOL_ALIASES.has(toolName) ||
      getBrandedAppCapability(toolName) === 'set_auto_archive' ||
      getAppAdvisorCapability(toolName) === 'set_auto_archive')
  );
}

/**
 * Brand-agnostic recognizer for the plan-explore "Plan" tool family. Matches
 * the plan-comment tools (RespondToComment, GetPlanComments) and their
 * code-review counterpart (GetReviewComments, which reuses RespondToComment
 * for replies) across Claude MCP display names and Codex dynamic-tool names
 * by suffix so they all share the plan icon.
 */
export function isPlanToolName(name: string | null | undefined): boolean {
  return (
    typeof name === 'string' &&
    (/RespondToComment$/.test(name) ||
      /GetPlanComments$/.test(name) ||
      /GetReviewComments$/.test(name) ||
      /respond_to_comment$/.test(name) ||
      /get_plan_comments$/.test(name) ||
      /get_review_comments$/.test(name))
  );
}

export function isAppActionToolName(
  toolName: string | null | undefined,
  scope?: ToolDisplayScope,
): boolean {
  if (typeof toolName !== 'string') {
    return false;
  }
  if (APP_ACTION_TOOL_ALIASES.has(toolName)) {
    return true;
  }
  // Every app capability except the two with their own dedicated families.
  // A hand-kept list here once dropped ShowFiles and the file-comment tools,
  // so non-default brands rendered them as generic MCP calls.
  const capability = getBrandedAppCapability(toolName, scope);
  return (
    capability !== null &&
    capability !== 'ask_user_question' &&
    capability !== 'get_script_output'
  );
}

function isPreviewVisualToolName(
  toolName: string,
  scope?: ToolDisplayScope,
): boolean {
  return (
    toolName === 'PreviewVisual' ||
    getBrandedAppCapability(toolName, scope) === 'preview_visual'
  );
}

function isShowVisualToolName(
  toolName: string,
  scope?: ToolDisplayScope,
): boolean {
  return (
    toolName === 'ShowVisual' ||
    getBrandedAppCapability(toolName, scope) === 'show_visual'
  );
}

/**
 * The input a tool row may show. A visual's HTML can be hundreds of
 * kilobytes, so its row shows only the title, never the document.
 */
export function getToolRowInput(
  toolName: string,
  input: string,
  scope?: ToolDisplayScope,
): string {
  if (isPreviewVisualToolName(toolName, scope)) {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object') {
        const width =
          'width' in parsed && typeof parsed.width === 'number'
            ? parsed.width
            : 720;
        const appearance =
          'appearance' in parsed &&
          (parsed.appearance === 'light' || parsed.appearance === 'dark')
            ? `, ${parsed.appearance}`
            : '';
        return `${width}px${appearance}`;
      }
    } catch {
      // Never show the HTML even when input is malformed.
    }
    return '';
  }
  if (!isShowVisualToolName(toolName, scope)) return input;
  try {
    const parsed: unknown = JSON.parse(input);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'title' in parsed &&
      typeof parsed.title === 'string'
    )
      return parsed.title;
  } catch {
    // Malformed input never falls back to the raw document.
  }
  return '';
}

// ---------------------------------------------------------------------------
// App Advisor tool alias detection
//
// The App Advisor exposes capabilities through the local Canopy assistant
// runtime. Most providers' raw tool names are folded into a single
// 'app-advisor' family for icon dispatch and into per-capability renderers
// below; watcher tools are routed to the dedicated 'watcher' family, and the
// Agent Ledger tools to the app-tool Ledger UX (`LEDGER_CAPABILITIES`), so
// they never match here. Names are hardcoded here to keep `@canopy/ui-shared`
// dependency-free; the source of truth is
// `packages/desktop-shared/src/lib/app-advisor-tools.ts`.
// ---------------------------------------------------------------------------

type AppAdvisorCapability =
  | 'ask_user_question'
  | 'get_script_output'
  | 'show_files'
  | 'get_file_comments'
  | 'respond_to_file_comment'
  | 'search_actions'
  | 'get_current_ui_state'
  | 'dispatch_action'
  | 'read_pipeline_yaml'
  | 'get_pipeline_debug_context'
  | 'search_watchers'
  | 'setup_watchers'
  | 'watch_github_items'
  | 'get_github_pull_request_status'
  | 'watch_command'
  | 'schedule_wakeup'
  | 'set_auto_archive'
  | 'set_work_entry_auto_delete'
  | 'show_capabilities'
  | 'start_forked_agent'
  | 'search_deferred_tools'
  | 'load_deferred_tools';

type CanopyActionCapability =
  | 'show_files'
  | 'show_capabilities'
  | 'set_work_entry_auto_delete'
  | 'show_visual'
  | 'preview_visual'
  | 'get_file_comments'
  | 'respond_to_file_comment'
  | 'search_actions'
  | 'dispatch_action'
  | 'get_git_preferences'
  | 'save_memory'
  | 'search_memory'
  | 'search_chats'
  | 'read_chat_excerpt'
  | 'read_memory'
  | 'read_pipeline_yaml'
  | 'search_watchers'
  | 'setup_watchers'
  | 'watch_github_items'
  | 'get_github_pull_request_status'
  | 'watch_command'
  | 'schedule_wakeup'
  | 'delete_watchers'
  | 'set_base_branch'
  | 'start_forked_agent'
  | 'start_branched_agent'
  | 'search_deferred_tools'
  | 'load_deferred_tools'
  | 'immediate_turn_restart'
  | 'get_code_graph_context'
  | 'build_or_update_code_graph'
  | 'query_code_graph'
  | 'search_code_graph'
  | 'explain_code_symbol'
  | 'get_impact_radius'
  | 'detect_changed_symbols'
  | 'compare_change_impact'
  | 'get_review_context'
  | 'add_ledger_entry'
  | 'search_ledger_entries'
  | 'update_ledger_entry';

const APP_ADVISOR_EXACT_TOOL_NAME_TO_CAPABILITY: ReadonlyMap<
  string,
  AppAdvisorCapability
> = new Map([
  ['mcp__canopy_app_advisor__AskUserQuestion', 'ask_user_question'],
  ['app_advisor_ask_user_question', 'ask_user_question'],
  ['mcp__canopy_app_advisor__GetScriptOutput', 'get_script_output'],
  ['app_advisor_get_script_output', 'get_script_output'],
  ['mcp__canopy_app_advisor__ShowFiles', 'show_files'],
  ['app_advisor_show_files', 'show_files'],
  ['mcp__canopy_app_advisor__GetFileComments', 'get_file_comments'],
  ['app_advisor_get_file_comments', 'get_file_comments'],
  ['mcp__canopy_app_advisor__RespondToFileComment', 'respond_to_file_comment'],
  ['app_advisor_respond_to_file_comment', 'respond_to_file_comment'],
  ['mcp__canopy_app_advisor__SearchActions', 'search_actions'],
  ['app_advisor_search_actions', 'search_actions'],
  ['mcp__canopy_app_advisor__GetCurrentUiState', 'get_current_ui_state'],
  ['app_advisor_get_current_ui_state', 'get_current_ui_state'],
  ['mcp__canopy_app_advisor__DispatchAction', 'dispatch_action'],
  ['app_advisor_dispatch_action', 'dispatch_action'],
  ['mcp__canopy_app_advisor__ReadPipelineYaml', 'read_pipeline_yaml'],
  ['app_advisor_read_pipeline_yaml', 'read_pipeline_yaml'],
  [
    'mcp__canopy_app_advisor__GetPipelineDebugContext',
    'get_pipeline_debug_context',
  ],
  ['app_advisor_get_pipeline_debug_context', 'get_pipeline_debug_context'],
  ['mcp__canopy_app_advisor__SearchWatchers', 'search_watchers'],
  ['app_advisor_search_watchers', 'search_watchers'],
  ['mcp__canopy_app_advisor__SetupWatchers', 'setup_watchers'],
  ['app_advisor_setup_watchers', 'setup_watchers'],
  ['mcp__canopy_app_advisor__WatchGitHubItems', 'watch_github_items'],
  ['app_advisor_watch_github_items', 'watch_github_items'],
  [
    'mcp__canopy_app_advisor__GetGitHubPullRequestStatus',
    'get_github_pull_request_status',
  ],
  ['mcp__canopy_app_advisor__StartForkedAgent', 'start_forked_agent'],
  ['mcp__canopy_app_advisor__SearchDeferredTools', 'search_deferred_tools'],
  ['app_advisor_search_deferred_tools', 'search_deferred_tools'],
  ['mcp__canopy_app_advisor__LoadDeferredTools', 'load_deferred_tools'],
  ['app_advisor_load_deferred_tools', 'load_deferred_tools'],
]);

const APP_ADVISOR_MCP_DISPLAY_TO_CAPABILITY: ReadonlyMap<
  string,
  AppAdvisorCapability
> = new Map([
  ['AskUserQuestion', 'ask_user_question'],
  ['GetScriptOutput', 'get_script_output'],
  ['ShowFiles', 'show_files'],
  ['GetFileComments', 'get_file_comments'],
  ['RespondToFileComment', 'respond_to_file_comment'],
  ['SearchActions', 'search_actions'],
  ['GetCurrentUiState', 'get_current_ui_state'],
  ['DispatchAction', 'dispatch_action'],
  ['ReadPipelineYaml', 'read_pipeline_yaml'],
  ['GetPipelineDebugContext', 'get_pipeline_debug_context'],
  ['SearchWatchers', 'search_watchers'],
  ['SetupWatchers', 'setup_watchers'],
  ['WatchGitHubItems', 'watch_github_items'],
  ['GetGitHubPullRequestStatus', 'get_github_pull_request_status'],
  ['WatchCommand', 'watch_command'],
  ['ScheduleWakeup', 'schedule_wakeup'],
  ['SetChatAutoArchive', 'set_auto_archive'],
  ['SetAutoArchive', 'set_auto_archive'],
  ['SetWorkEntryAutoDelete', 'set_work_entry_auto_delete'],
  ['ShowCapabilities', 'show_capabilities'],
  ['StartForkedAgent', 'start_forked_agent'],
  ['SearchDeferredTools', 'search_deferred_tools'],
  ['LoadDeferredTools', 'load_deferred_tools'],
]);

const APP_ADVISOR_CODEX_SUFFIX_TO_CAPABILITY: ReadonlyMap<
  string,
  AppAdvisorCapability
> = new Map([
  ['ask_user_question', 'ask_user_question'],
  ['get_script_output', 'get_script_output'],
  ['show_files', 'show_files'],
  ['get_file_comments', 'get_file_comments'],
  ['respond_to_file_comment', 'respond_to_file_comment'],
  ['search_actions', 'search_actions'],
  ['get_current_ui_state', 'get_current_ui_state'],
  ['dispatch_action', 'dispatch_action'],
  ['read_pipeline_yaml', 'read_pipeline_yaml'],
  ['get_pipeline_debug_context', 'get_pipeline_debug_context'],
  ['search_watchers', 'search_watchers'],
  ['setup_watchers', 'setup_watchers'],
  ['watch_github_items', 'watch_github_items'],
  ['get_github_pull_request_status', 'get_github_pull_request_status'],
  ['watch_command', 'watch_command'],
  ['schedule_wakeup', 'schedule_wakeup'],
  ['set_chat_auto_archive', 'set_auto_archive'],
  ['set_auto_archive', 'set_auto_archive'],
  ['set_work_entry_auto_delete', 'set_work_entry_auto_delete'],
  ['show_capabilities', 'show_capabilities'],
  ['start_forked_agent', 'start_forked_agent'],
  ['search_deferred_tools', 'search_deferred_tools'],
  ['load_deferred_tools', 'load_deferred_tools'],
]);

function getAppAdvisorCapability(
  toolName: string,
): AppAdvisorCapability | null {
  const exact = APP_ADVISOR_EXACT_TOOL_NAME_TO_CAPABILITY.get(toolName);
  if (exact) {
    return exact;
  }

  const mcpMatch = toolName.match(/^mcp__(.+)_app_advisor__(.+)$/);
  if (mcpMatch) {
    return APP_ADVISOR_MCP_DISPLAY_TO_CAPABILITY.get(mcpMatch[2]) ?? null;
  }

  const codexMatch = toolName.match(
    /^(.+)_app_advisor_(ask_user_question|get_script_output|show_files|get_file_comments|respond_to_file_comment|search_actions|get_current_ui_state|dispatch_action|read_pipeline_yaml|get_pipeline_debug_context|search_watchers|setup_watchers|watch_github_items|get_github_pull_request_status|watch_command|schedule_wakeup|set_chat_auto_archive|set_auto_archive|set_work_entry_auto_delete|show_capabilities|start_forked_agent|search_deferred_tools|load_deferred_tools)$/,
  );
  if (codexMatch) {
    return APP_ADVISOR_CODEX_SUFFIX_TO_CAPABILITY.get(codexMatch[2]) ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pipeline Editor assistant tools (embedded pipeline-editor chat). Clean
// display names + the pipeline icon, mirroring the App Advisor treatment.
// `AskUserQuestion` is intentionally excluded so it folds into the shared
// ask-user family/card instead of a pipeline chip.
// ---------------------------------------------------------------------------

type PipelineEditorCapability =
  | 'list'
  | 'open'
  | 'create'
  | 'get_current'
  | 'set_yaml'
  | 'save'
  | 'get_action_definition'
  | 'navigate_to_list'
  | 'search_deferred_tools'
  | 'load_deferred_tools';

const PIPELINE_EDITOR_MCP_DISPLAY_TO_CAPABILITY: ReadonlyMap<
  string,
  PipelineEditorCapability
> = new Map([
  ['ListPipelines', 'list'],
  ['OpenPipeline', 'open'],
  ['CreatePipeline', 'create'],
  ['GetCurrentPipeline', 'get_current'],
  ['SetPipelineYaml', 'set_yaml'],
  ['SavePipeline', 'save'],
  ['GetBuiltinActionDefinition', 'get_action_definition'],
  ['NavigateToPipelineList', 'navigate_to_list'],
  ['SearchDeferredTools', 'search_deferred_tools'],
  ['LoadDeferredTools', 'load_deferred_tools'],
]);

const PIPELINE_EDITOR_CODEX_SUFFIX_TO_CAPABILITY: ReadonlyMap<
  string,
  PipelineEditorCapability
> = new Map([
  ['pipeline_list', 'list'],
  ['pipeline_open', 'open'],
  ['pipeline_create', 'create'],
  ['pipeline_get_current', 'get_current'],
  ['pipeline_set_yaml', 'set_yaml'],
  ['pipeline_save', 'save'],
  ['pipeline_get_action_definition', 'get_action_definition'],
  ['navigation_to_list', 'navigate_to_list'],
  ['search_deferred_tools', 'search_deferred_tools'],
  ['load_deferred_tools', 'load_deferred_tools'],
]);

function getPipelineEditorCapability(
  toolName: string,
): PipelineEditorCapability | null {
  const mcpMatch = toolName.match(/^mcp__(.+)_pipeline_editor__(.+)$/);
  if (mcpMatch) {
    return PIPELINE_EDITOR_MCP_DISPLAY_TO_CAPABILITY.get(mcpMatch[2]) ?? null;
  }

  const codexMatch = toolName.match(
    /^(.+)_pipeline_editor_(pipeline_list|pipeline_open|pipeline_create|pipeline_get_current|pipeline_set_yaml|pipeline_save|pipeline_get_action_definition|navigation_to_list|search_deferred_tools|load_deferred_tools)$/,
  );
  if (codexMatch) {
    return (
      PIPELINE_EDITOR_CODEX_SUFFIX_TO_CAPABILITY.get(codexMatch[2]) ?? null
    );
  }

  return null;
}

export function isPipelineEditorToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' &&
    getPipelineEditorCapability(toolName) !== null
  );
}

const APP_ACTION_TOOL_NAME_TO_CAPABILITY: ReadonlyMap<
  string,
  CanopyActionCapability
> = new Map([
  [legacyMcpToolName('ShowFiles'), 'show_files'],
  [legacyCodexToolName('show_files'), 'show_files'],
  ['ShowFiles', 'show_files'],
  ['ShowCapabilities', 'show_capabilities'],
  ['SetWorkEntryAutoDelete', 'set_work_entry_auto_delete'],
  ['ShowVisual', 'show_visual'],
  ['PreviewVisual', 'preview_visual'],
  [legacyMcpToolName('GetFileComments'), 'get_file_comments'],
  [legacyCodexToolName('get_file_comments'), 'get_file_comments'],
  ['GetFileComments', 'get_file_comments'],
  [legacyMcpToolName('RespondToFileComment'), 'respond_to_file_comment'],
  [legacyCodexToolName('respond_to_file_comment'), 'respond_to_file_comment'],
  ['RespondToFileComment', 'respond_to_file_comment'],
  [legacyMcpToolName('SearchActions'), 'search_actions'],
  [legacyCodexToolName('search_actions'), 'search_actions'],
  ['SearchActions', 'search_actions'],
  [legacyMcpToolName('DispatchAction'), 'dispatch_action'],
  [legacyCodexToolName('dispatch_action'), 'dispatch_action'],
  ['DispatchAction', 'dispatch_action'],
  [legacyMcpToolName('GetGitPreferences'), 'get_git_preferences'],
  [legacyCodexToolName('get_git_preferences'), 'get_git_preferences'],
  ['GetGitPreferences', 'get_git_preferences'],
  [legacyMcpToolName('SaveMemory'), 'save_memory'],
  [legacyCodexToolName('save_memory'), 'save_memory'],
  ['SaveMemory', 'save_memory'],
  [legacyMcpToolName('SearchMemory'), 'search_memory'],
  [legacyCodexToolName('search_memory'), 'search_memory'],
  ['SearchMemory', 'search_memory'],
  [legacyMcpToolName('ReadMemory'), 'read_memory'],
  [legacyCodexToolName('read_memory'), 'read_memory'],
  [legacyMcpToolName('SearchChats'), 'search_chats'],
  [legacyCodexToolName('search_chats'), 'search_chats'],
  [legacyCursorToolTitle('SearchChats'), 'search_chats'],
  ['SearchChats', 'search_chats'],
  [legacyMcpToolName('ReadChatExcerpt'), 'read_chat_excerpt'],
  [legacyCodexToolName('read_chat_excerpt'), 'read_chat_excerpt'],
  [legacyCursorToolTitle('ReadChatExcerpt'), 'read_chat_excerpt'],
  ['ReadChatExcerpt', 'read_chat_excerpt'],
  ['ReadMemory', 'read_memory'],
  [legacyMcpToolName('ReadPipelineYaml'), 'read_pipeline_yaml'],
  [legacyCodexToolName('read_pipeline_yaml'), 'read_pipeline_yaml'],
  ['ReadPipelineYaml', 'read_pipeline_yaml'],
  [legacyMcpToolName('SearchWatchers'), 'search_watchers'],
  [legacyCodexToolName('search_watchers'), 'search_watchers'],
  ['SearchWatchers', 'search_watchers'],
  [legacyMcpToolName('SetupWatchers'), 'setup_watchers'],
  [legacyCodexToolName('setup_watchers'), 'setup_watchers'],
  ['SetupWatchers', 'setup_watchers'],
  [legacyMcpToolName('WatchGitHubItems'), 'watch_github_items'],
  [legacyCodexToolName('watch_github_items'), 'watch_github_items'],
  ['WatchGitHubItems', 'watch_github_items'],
  ['GetGitHubPullRequestStatus', 'get_github_pull_request_status'],
  ['WatchCommand', 'watch_command'],
  [legacyMcpToolName('DeleteWatchers'), 'delete_watchers'],
  [legacyCodexToolName('delete_watchers'), 'delete_watchers'],
  ['DeleteWatchers', 'delete_watchers'],
  [legacyMcpToolName('SetBaseBranch'), 'set_base_branch'],
  [legacyMcpToolName('StartForkedAgent'), 'start_forked_agent'],
  [legacyMcpToolName('StartBranchedAgent'), 'start_branched_agent'],
  [legacyCodexToolName('set_base_branch'), 'set_base_branch'],
  [legacyCodexToolName('start_forked_agent'), 'start_forked_agent'],
  [legacyCodexToolName('start_branched_agent'), 'start_branched_agent'],
  ['SetBaseBranch', 'set_base_branch'],
  ['StartForkedAgent', 'start_forked_agent'],
  ['StartBranchedAgent', 'start_branched_agent'],
  [legacyMcpToolName('SearchDeferredTools'), 'search_deferred_tools'],
  [legacyCodexToolName('search_deferred_tools'), 'search_deferred_tools'],
  ['SearchDeferredTools', 'search_deferred_tools'],
  [legacyMcpToolName('LoadDeferredTools'), 'load_deferred_tools'],
  [legacyCodexToolName('load_deferred_tools'), 'load_deferred_tools'],
  ['LoadDeferredTools', 'load_deferred_tools'],
  [legacyMcpToolName('GetCodeGraphContext'), 'get_code_graph_context'],
  [legacyCodexToolName('get_code_graph_context'), 'get_code_graph_context'],
  ['GetCodeGraphContext', 'get_code_graph_context'],
  [legacyMcpToolName('BuildOrUpdateCodeGraph'), 'build_or_update_code_graph'],
  [
    legacyCodexToolName('build_or_update_code_graph'),
    'build_or_update_code_graph',
  ],
  ['BuildOrUpdateCodeGraph', 'build_or_update_code_graph'],
  [legacyMcpToolName('QueryCodeGraph'), 'query_code_graph'],
  [legacyCodexToolName('query_code_graph'), 'query_code_graph'],
  ['QueryCodeGraph', 'query_code_graph'],
  [legacyMcpToolName('SearchCodeGraph'), 'search_code_graph'],
  [legacyCodexToolName('search_code_graph'), 'search_code_graph'],
  ['SearchCodeGraph', 'search_code_graph'],
  [legacyMcpToolName('ExplainCodeSymbol'), 'explain_code_symbol'],
  [legacyCodexToolName('explain_code_symbol'), 'explain_code_symbol'],
  ['ExplainCodeSymbol', 'explain_code_symbol'],
  [legacyMcpToolName('GetImpactRadius'), 'get_impact_radius'],
  [legacyCodexToolName('get_impact_radius'), 'get_impact_radius'],
  ['GetImpactRadius', 'get_impact_radius'],
  [legacyMcpToolName('DetectChangedSymbols'), 'detect_changed_symbols'],
  [legacyCodexToolName('detect_changed_symbols'), 'detect_changed_symbols'],
  ['DetectChangedSymbols', 'detect_changed_symbols'],
  [legacyMcpToolName('CompareChangeImpact'), 'compare_change_impact'],
  [legacyCodexToolName('compare_change_impact'), 'compare_change_impact'],
  ['CompareChangeImpact', 'compare_change_impact'],
  [legacyMcpToolName('GetReviewContext'), 'get_review_context'],
  [legacyCodexToolName('get_review_context'), 'get_review_context'],
  ['GetReviewContext', 'get_review_context'],
  [legacyMcpToolName('AddFeedEntry'), 'add_ledger_entry'],
  [legacyCodexToolName('add_feed_entry'), 'add_ledger_entry'],
  [legacyCursorToolTitle('AddFeedEntry'), 'add_ledger_entry'],
  ['AddFeedEntry', 'add_ledger_entry'],
  [legacyMcpToolName('SearchFeedEntries'), 'search_ledger_entries'],
  [legacyCodexToolName('search_feed_entries'), 'search_ledger_entries'],
  [legacyCursorToolTitle('SearchFeedEntries'), 'search_ledger_entries'],
  ['SearchFeedEntries', 'search_ledger_entries'],
  [legacyMcpToolName('UpdateFeedEntry'), 'update_ledger_entry'],
  [legacyCodexToolName('update_feed_entry'), 'update_ledger_entry'],
  [legacyCursorToolTitle('UpdateFeedEntry'), 'update_ledger_entry'],
  ['UpdateFeedEntry', 'update_ledger_entry'],
  // The Agent Ledger tools' names before they took the Feed's.
  [legacyMcpToolName('AddLedgerEntry'), 'add_ledger_entry'],
  [legacyCodexToolName('add_ledger_entry'), 'add_ledger_entry'],
  [legacyCursorToolTitle('AddLedgerEntry'), 'add_ledger_entry'],
  ['AddLedgerEntry', 'add_ledger_entry'],
  [legacyMcpToolName('SearchLedgerEntries'), 'search_ledger_entries'],
  [legacyCodexToolName('search_ledger_entries'), 'search_ledger_entries'],
  [legacyCursorToolTitle('SearchLedgerEntries'), 'search_ledger_entries'],
  ['SearchLedgerEntries', 'search_ledger_entries'],
  [legacyMcpToolName('UpdateLedgerEntry'), 'update_ledger_entry'],
  [legacyCodexToolName('update_ledger_entry'), 'update_ledger_entry'],
  [legacyCursorToolTitle('UpdateLedgerEntry'), 'update_ledger_entry'],
  ['UpdateLedgerEntry', 'update_ledger_entry'],
]);

/**
 * Code-graph capabilities — the subset of app-action tools that read/build the
 * per-worktree code graph. They share the dedicated `graph` tool family so
 * every code-graph surface (tool block, collapsed-turn summary chip, worktree
 * build indicator) renders the same `GraphIcon`.
 */
const CODE_GRAPH_CAPABILITIES: ReadonlySet<AppInjectedCapability> = new Set([
  'get_code_graph_context',
  'build_or_update_code_graph',
  'query_code_graph',
  'search_code_graph',
  'explain_code_symbol',
  'get_impact_radius',
  'detect_changed_symbols',
  'compare_change_impact',
  'get_review_context',
]);

/**
 * True when the raw tool name is one of the code-graph capabilities across any
 * provider naming (Claude MCP display, Codex suffix, or bare display name).
 * Drives the dedicated `graph` tool family + `GraphIcon` dispatch.
 */
export function isCodeGraphToolName(
  toolName: string | null | undefined,
  scope?: ToolDisplayScope,
): boolean {
  if (typeof toolName !== 'string') {
    return false;
  }
  const capability =
    APP_ACTION_TOOL_NAME_TO_CAPABILITY.get(toolName) ??
    getBrandedAppCapability(toolName, scope);
  return capability != null && CODE_GRAPH_CAPABILITIES.has(capability);
}

export function isAppAdvisorToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' && getAppAdvisorCapability(toolName) !== null
  );
}

function isWatcherToolName(toolName: string): boolean {
  const appAdvisorCapability = getAppAdvisorCapability(toolName);
  if (
    appAdvisorCapability === 'search_watchers' ||
    appAdvisorCapability === 'setup_watchers' ||
    appAdvisorCapability === 'watch_github_items' ||
    appAdvisorCapability === 'watch_command' ||
    appAdvisorCapability === 'schedule_wakeup'
  ) {
    return true;
  }
  const appCapability =
    APP_ACTION_TOOL_NAME_TO_CAPABILITY.get(toolName) ??
    getBrandedAppCapability(toolName);
  return (
    appCapability === 'search_watchers' ||
    appCapability === 'setup_watchers' ||
    appCapability === 'watch_github_items' ||
    appCapability === 'watch_command' ||
    appCapability === 'schedule_wakeup' ||
    appCapability === 'delete_watchers'
  );
}

// ---------------------------------------------------------------------------
// Small JSX helpers shared across renderers
// ---------------------------------------------------------------------------

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Compact a code-graph symbol/file target for display. Graph targets use the
 * `path/to/file.ts::Parent.name` qualified form; keep the symbol suffix intact
 * but shorten the file portion to its basename so the label stays readable.
 * A bare file path collapses to its basename.
 */
function shortenGraphTarget(target: string): string {
  const trimmed = target.trim();
  const sepIndex = trimmed.indexOf('::');
  if (sepIndex >= 0) {
    const filePart = trimmed.slice(0, sepIndex);
    const symbolPart = trimmed.slice(sepIndex + 2);
    return `${baseName(filePart)}::${symbolPart}`;
  }
  return baseName(trimmed);
}

// The clean chat look draws every detail the same way: the row's own font
// and size, with no chip or code font. A file name or pattern is part of the
// sentence ("Read icons.ts"); only side notes take the tertiary ink.
const CLEAN_DETAIL_CLASS = 'fg-tertiary';

function CodeChunk({ children }: { children: ReactNode }): JSX.Element {
  // Chat detail `detailed`: the target in a code badge.
  const badges = useStepBadges();
  if (badges) return <StepBadge>{children}</StepBadge>;
  return <span>{children}</span>;
}

/** Stable action words; status belongs to the row, not its label. */
function ToolVerb({ clean }: { clean: string }): JSX.Element {
  return <>{clean}</>;
}

/**
 * Shell calls show the provider description followed by the same command
 * badge as undescribed calls. Expanded details retain the full command.
 */
function ShellLabel({
  command,
  description,
}: {
  command: string;

  description?: string;
}): JSX.Element {
  const tense = useStepTense();
  // What it did, then the command as the row's lighter detail: the
  // agent's own description when it gave one, else "Ran a command" in the
  // step's tense. A blocked or interrupted command, or one outside a step,
  // never claims it ran.
  const words =
    description ??
    (tense === 'running'
      ? 'Running a command'
      : tense === 'done' || tense === 'failed'
        ? 'Ran a command'
        : 'Run a command');
  if (!command) return <>{words}</>;
  return (
    <>
      {words}
      <span className={CLEAN_DETAIL_CLASS}>
        <span aria-hidden="true">{' · '}</span>
        {command}
      </span>
    </>
  );
}

function MutedSnippet({ children }: { children: ReactNode }): JSX.Element {
  // Chat detail `detailed`: shrinks in the badge line and ends in "…".
  const badges = useStepBadges();
  return (
    <span
      className={
        badges
          ? `ml-1 min-w-0 truncate ${CLEAN_DETAIL_CLASS}`
          : `ml-1 ${CLEAN_DETAIL_CLASS}`
      }
    >
      {children}
    </span>
  );
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumberLabel(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : '';
}

function isParsedInput(value: unknown): value is ParsedInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert a Canopy-style tool identifier to a human-friendly label. Splits on
 * `.` to separate the prefix from the tool name, replaces `_` and `-` with
 * spaces, and capitalizes each word. The prefix and tool name are joined with
 * ` - `. Examples:
 *
 *   `chat.send_message`     → `Chat - Send Message`
 *   `pipeline.open_editor`  → `Pipeline - Open Editor`
 *   `tool_without_prefix`   → `Tool Without Prefix`
 */
export function prettifyToolName(name: string): string {
  const capitalizeWords = (segment: string): string =>
    segment
      .replace(/[_-]+/g, ' ')
      .split(' ')
      .filter((word) => word.length > 0)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  const dotIndex = name.indexOf('.');
  if (dotIndex < 0) {
    return capitalizeWords(name);
  }
  const prefix = capitalizeWords(name.slice(0, dotIndex));
  const rest = capitalizeWords(name.slice(dotIndex + 1));
  if (!prefix) return rest;
  if (!rest) return prefix;
  return `${prefix} - ${rest}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// ---------------------------------------------------------------------------
// Predicate-based renderers (Canopy-injected ask-user / script-output, plus
// Codex built-in `request_user_input`). These run before exact-name matchers
// so the alias helpers stay the single source of truth.
// ---------------------------------------------------------------------------

/**
 * One answer summary per answered question, in question order, joined for the
 * collapsed ask-user row. Uses the display-safe answers only: secret freeform
 * text stays `[hidden]`, the same as in the answers block.
 */
export function askUserQuestionAnswerSummary(
  answers: readonly AnsweredQuestionDisplay[],
): string {
  return answers
    .map((entry) => {
      const answer = entry.answer.trim();
      if (answer) return answer;
      if (!entry.additional) return '';
      return entry.secret ? '[hidden]' : entry.additional.trim();
    })
    .filter((summary) => summary.length > 0)
    .join(', ');
}

/**
 * Collapsed-row label for every ask-user row on desktop and web:
 * `Asked you 1 question`, or `Asked you 1 question · <answers>` once answered.
 * Only the combined answer suffix is truncated; the answers block keeps the
 * full text.
 */
export function askUserQuestionRowLabel({
  count,
  answers,
}: {
  count: number;
  answers?: readonly AnsweredQuestionDisplay[];
}): JSX.Element {
  const summary = answers
    ? truncate(askUserQuestionAnswerSummary(answers), 60)
    : '';
  return (
    <>
      {`Asked you ${count} ${count === 1 ? 'question' : 'questions'}`}
      {summary && (
        <>
          {' '}
          <MutedSnippet>{`· ${summary}`}</MutedSnippet>
        </>
      )}
    </>
  );
}

/** Question count of a serialized ask-user input; 0 when malformed. */
export function askUserQuestionCount(input: string | undefined): number {
  if (!input) return 0;
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed &&
      typeof parsed === 'object' &&
      'questions' in parsed &&
      Array.isArray(parsed.questions)
      ? parsed.questions.length
      : 0;
  } catch {
    return 0;
  }
}

const renderAskUserQuestion: ToolDisplayRenderer = (parsed) => {
  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  return {
    icon: <QuestionMarkIcon />,
    label: askUserQuestionRowLabel({ count: questions.length }),
  };
};

const renderGetScriptOutput: ToolDisplayRenderer = (parsed) => {
  const scriptId = asString(parsed.scriptId);
  const repo = asString(parsed.repo);
  return {
    icon: <TerminalBorderedIcon />,
    label: (
      <>
        Script output
        {scriptId && <CodeChunk>{scriptId}</CodeChunk>}
        {repo && <MutedSnippet>repo: {repo}</MutedSnippet>}
      </>
    ),
  };
};

const renderSetAutoArchive: ToolDisplayRenderer = (parsed) => {
  const enabled = parsed.enabled;
  return {
    icon: <ArchiveIcon />,
    label:
      typeof enabled === 'boolean'
        ? `${enabled ? 'Enable' : 'Disable'} chat auto-archive`
        : 'Set chat auto-archive',
  };
};

const renderSetWorkEntryAutoDelete: ToolDisplayRenderer = (parsed) =>
  parsed.archive === true
    ? { icon: <ArchiveIcon />, label: 'Set work entry auto-archive' }
    : { icon: <TrashIcon />, label: 'Set work entry auto-delete' };

const renderShowCapabilities: ToolDisplayRenderer = (parsed) => {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return {
    icon: <WrenchIcon />,
    label:
      items.length > 0 ? (
        <>
          Show capabilities{' '}
          <MutedSnippet>
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </MutedSnippet>
        </>
      ) : (
        'Show capabilities'
      ),
  };
};

const renderStartSplitAgent: ToolDisplayRenderer = (parsed) => ({
  icon: <WrenchIcon />,
  label: (
    <MutedSnippet>
      {asString(parsed.followUpInstruction) || 'Start independent agent'}
    </MutedSnippet>
  ),
});

const renderSetBaseBranch: ToolDisplayRenderer = (parsed) => {
  const baseBranch = asString(parsed.baseBranch);
  const repoId = asString(parsed.repoId);
  return {
    icon: <WrenchIcon />,
    label: (
      <>
        Set base branch
        {baseBranch ? (
          <>
            {' '}
            <CodeChunk>{baseBranch}</CodeChunk>
          </>
        ) : null}
        {repoId ? (
          <>
            {' '}
            <MutedSnippet>repo {repoId}</MutedSnippet>
          </>
        ) : null}
      </>
    ),
  };
};

const renderClaudeModelChange: ToolDisplayRenderer = (parsed) => {
  const previousModel =
    asString(parsed.previous_model_display) || asString(parsed.previous_model);
  const detectedModel =
    asString(parsed.detected_model_display) || asString(parsed.detected_model);
  return {
    icon: <ClaudeLogo width={14} height={14} />,
    label:
      previousModel && detectedModel ? (
        <>
          Claude model changed from <strong>{previousModel}</strong> to{' '}
          <strong>{detectedModel}</strong>
        </>
      ) : (
        'Claude model changed'
      ),
  };
};

const renderPlanTool: ToolDisplayRenderer = (
  parsed,
  _input,
  toolName,
  scope,
) => {
  // The plan-explore "Plan" family covers the two comment tools. Surface what
  // the call actually does (reply vs read, target thread, resolve) instead of a
  // bare "Plan" label.
  const isRespond =
    /RespondToComment$/.test(toolName) || /respond_to_comment$/.test(toolName);
  // GetReviewComments is the code-review counterpart of GetPlanComments; render
  // review-flavored copy so the label reads "Read review comments" there. Its
  // name alone distinguishes it, but `RespondToComment` is the same tool name
  // in both surfaces, so the host-provided `scope.isCodeReview` hint (see
  // `ToolDisplayScope`) is what lets a reply call pick up the review icon.
  const isReview =
    /GetReviewComments$/.test(toolName) ||
    /get_review_comments$/.test(toolName) ||
    scope?.isCodeReview === true;
  // Code Review chats get the code-brackets glyph; Plan Explore chats (and
  // any host that can't thread chat scope, e.g. the Portal web renderer)
  // keep the neutral Plan icon.
  const icon = isReview ? <CodeBracketsIcon /> : <PlanModeIcon />;
  const threadId = asString(parsed.threadId);
  const shortThread = threadId.length > 8 ? threadId.slice(0, 8) : threadId;

  if (isRespond) {
    const resolve = parsed.resolve === true;
    return {
      icon,
      label: (
        <>
          {resolve ? 'Reply & resolve comment' : 'Reply to comment'}
          {shortThread && <CodeChunk>{shortThread}</CodeChunk>}
        </>
      ),
    };
  }

  return {
    icon,
    label: threadId ? (
      <>
        Read comment thread <CodeChunk>{shortThread}</CodeChunk>
      </>
    ) : (
      <>
        {isReview ? 'Read review comments' : 'Read plan comments'}{' '}
        <MutedSnippet>all open threads</MutedSnippet>
      </>
    ),
  };
};

// ---------------------------------------------------------------------------
// App Advisor renderers — one per capability. The label is rendered next to
// the AppAdvisorIcon (dispatched via `getToolFamilyFromName` → 'app-advisor'),
// so callers see "Ask user", "Dispatch chat.send_message", etc. instead of
// raw provider tool names like `mcp__canopy_app_advisor__DispatchAction`.
// ---------------------------------------------------------------------------

const renderAppAdvisorAskUser: ToolDisplayRenderer = (parsed) => {
  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  const count = questions.length;
  return {
    icon: <AppAdvisorIcon />,
    label:
      count > 0 ? (
        <>
          Ask user{' '}
          <MutedSnippet>
            {count} {count === 1 ? 'question' : 'questions'}
          </MutedSnippet>
        </>
      ) : (
        'Ask user'
      ),
  };
};

const renderAppAdvisorGetScriptOutput: ToolDisplayRenderer = (parsed) => {
  const scriptId = asString(parsed.scriptId);
  return {
    icon: <AppAdvisorIcon />,
    label: scriptId ? (
      <>
        Read script output <CodeChunk>{scriptId}</CodeChunk>
      </>
    ) : (
      'Read script output'
    ),
  };
};

const renderShowFiles: ToolDisplayRenderer = (parsed) => {
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  return {
    icon: <DocumentIcon />,
    label:
      files.length > 0 ? (
        <>
          Show files{' '}
          <MutedSnippet>
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </MutedSnippet>
        </>
      ) : (
        'Show files'
      ),
  };
};

const renderShowVisual: ToolDisplayRenderer = (parsed) => {
  const title = asString(parsed.title);
  return {
    icon: <DocumentIcon />,
    label: title ? (
      <>
        Show visual <CodeChunk>{title}</CodeChunk>
      </>
    ) : (
      'Show visual'
    ),
  };
};

const renderPreviewVisual: ToolDisplayRenderer = (parsed) => {
  const width = typeof parsed.width === 'number' ? parsed.width : 720;
  const appearance =
    parsed.appearance === 'light' || parsed.appearance === 'dark'
      ? `, ${parsed.appearance}`
      : '';
  return {
    icon: <DocumentIcon />,
    label: (
      <>
        Preview visual <CodeChunk>{`${width}px${appearance}`}</CodeChunk>
      </>
    ),
  };
};

const renderGetFileComments: ToolDisplayRenderer = (parsed) => {
  const threadId = asString(parsed.threadId);
  return {
    icon: <CodeBracketsIcon />,
    label: threadId ? (
      <>
        Read file comments <CodeChunk>{threadId}</CodeChunk>
      </>
    ) : (
      'Read file comments'
    ),
  };
};

const renderRespondToFileComment: ToolDisplayRenderer = (parsed) => {
  const threadId = asString(parsed.threadId);
  return {
    icon: <CodeBracketsIcon />,
    label: threadId ? (
      <>
        Reply to file comment <CodeChunk>{threadId}</CodeChunk>
      </>
    ) : (
      'Reply to file comment'
    ),
  };
};

const renderAppAdvisorSearchActions: ToolDisplayRenderer = (parsed) => {
  const query = asString(parsed.query);
  const actionType = asString(parsed.actionType);
  const category = asString(parsed.category);
  const detail = query || actionType || category;
  return {
    icon: <AppAdvisorIcon />,
    label: detail ? (
      <>
        Search actions <CodeChunk>{detail}</CodeChunk>
      </>
    ) : (
      'Search actions'
    ),
  };
};

const renderAppAdvisorGetCurrentUiState: ToolDisplayRenderer = () => ({
  icon: <AppAdvisorIcon />,
  label: 'Read UI state',
});

const renderGetGitPreferences: ToolDisplayRenderer = (parsed) => {
  const type = asString(parsed.type);
  return {
    icon: <AppAdvisorIcon />,
    label: type ? (
      <>
        Read Git preferences <CodeChunk>{type}</CodeChunk>
      </>
    ) : (
      'Read Git preferences'
    ),
  };
};

const renderSaveMemory: ToolDisplayRenderer = (parsed) => {
  const scope = asString(parsed.scope);
  return {
    icon: <WrenchIcon />,
    label: (
      <span data-testid="chat-tool-call-save-memory-label">
        {scope ? (
          <>
            Save <CodeChunk>{scope}</CodeChunk> memory
          </>
        ) : (
          'Save memory'
        )}
      </span>
    ),
  };
};

const renderSearchMemory: ToolDisplayRenderer = (parsed) => {
  const query = asString(parsed.query);
  return {
    icon: <WrenchIcon />,
    label: (
      <span data-testid="chat-tool-call-search-memory-label">
        {query ? (
          <>
            Search memory <CodeChunk>{query}</CodeChunk>
          </>
        ) : (
          'Search memory'
        )}
      </span>
    ),
  };
};

const renderReadMemory: ToolDisplayRenderer = (parsed) => {
  const scope = asString(parsed.scope);
  const file = asString(parsed.file);
  return {
    icon: <WrenchIcon />,
    label: (
      <span data-testid="chat-tool-call-read-memory-label">
        Read{scope ? ` ${scope}` : ''} memory
        {file ? (
          <>
            {' '}
            <CodeChunk>{file}</CodeChunk>
          </>
        ) : null}
      </span>
    ),
  };
};

const ENVIRONMENT_ACTION_LABELS: ReadonlyMap<string, string> = new Map([
  ['workspace.get', 'Read project'],
  ['worktree.list', 'List worktrees'],
  ['chat.list', 'List chats'],
  ['models.list', 'List models'],
]);

function renderEnvironmentActionLabel(
  actionType: string,
  action: ParsedInput,
): ReactNode | null {
  const fixed = ENVIRONMENT_ACTION_LABELS.get(actionType);
  if (fixed) return fixed;
  if (actionType === 'chat.create') {
    const title = asString(action.title);
    return (
      <>
        Start chat
        {title ? (
          <>
            {' '}
            <CodeChunk>{title}</CodeChunk>
          </>
        ) : null}
        {action.placement === 'new_worktree' ? (
          <>
            {' '}
            <MutedSnippet>in a new worktree</MutedSnippet>
          </>
        ) : null}
      </>
    );
  }
  if (actionType === 'chat.send_message' || actionType === 'chat.get') {
    const verb = actionType === 'chat.get' ? 'Check chat' : 'Message chat';
    const chatId = asString(action.chatId);
    return chatId ? (
      <>
        {verb} <CodeChunk>{chatId}</CodeChunk>
      </>
    ) : (
      verb
    );
  }
  return null;
}

function renderDispatchActionLabel(
  actionType: string,
  action: ParsedInput,
): ReactNode {
  if (actionType === 'settings.ai_gateway.connect') return 'Connect AI gateway';
  if (actionType === 'settings.ai_gateway.update') return 'Update AI gateway';
  if (actionType === 'settings.ai_gateway.get') return 'Read AI gateway';
  if (actionType === 'capability_package.analyze')
    return 'Check share dependencies';
  const environmentLabel = renderEnvironmentActionLabel(actionType, action);
  if (environmentLabel !== null) return environmentLabel;

  if (actionType === 'worktree.set_base_branch') {
    const baseBranch = asString(action.baseBranch);
    return baseBranch ? (
      <>
        Set base branch <CodeChunk>{baseBranch}</CodeChunk>
      </>
    ) : (
      'Set base branch'
    );
  }

  if (actionType === 'worktree.create') {
    const baseBranch = asString(action.baseBranch);
    const baseWorktreeId = asString(action.baseWorktreeId);
    return baseBranch ? (
      <>
        Create worktree from branch <CodeChunk>{baseBranch}</CodeChunk>
      </>
    ) : baseWorktreeId ? (
      <>
        Create worktree from worktree <CodeChunk>{baseWorktreeId}</CodeChunk>
      </>
    ) : (
      'Create worktree'
    );
  }

  if (actionType === 'worktree.create_from') {
    const reference = asString(action.reference);
    const baseBranch = asString(action.baseBranch);
    return (
      <>
        Create worktree
        {reference ? (
          <>
            {' '}
            from <CodeChunk>{reference}</CodeChunk>
          </>
        ) : null}
        {baseBranch ? (
          <>
            {' '}
            <MutedSnippet>base {baseBranch}</MutedSnippet>
          </>
        ) : null}
      </>
    );
  }

  if (actionType === 'hook.pause' || actionType === 'hook.resume') {
    const verb = actionType === 'hook.pause' ? 'Pause' : 'Resume';
    const hookKey = asString(action.hookKey);
    if (action.all === true) {
      return `${verb} all hooks`;
    }
    return hookKey ? (
      <>
        {`${verb} hook `}
        <CodeChunk>{hookKey}</CodeChunk>
      </>
    ) : (
      `${verb} hook`
    );
  }

  return (
    <>
      Dispatch action{' '}
      <MutedSnippet>{prettifyToolName(actionType)}</MutedSnippet>
    </>
  );
}

const renderAppAdvisorDispatchAction: ToolDisplayRenderer = (parsed) => {
  const action = isParsedInput(parsed.action) ? parsed.action : {};
  const actionType = asString(action.type);
  return {
    icon: <AppAdvisorIcon />,
    label: actionType
      ? renderDispatchActionLabel(actionType, action)
      : 'Dispatch action',
  };
};

const renderAppAdvisorReadPipelineYaml: ToolDisplayRenderer = (parsed) => {
  const pipelineId = asString(parsed.pipelineId);
  const repoId = asString(parsed.repoId);
  const pattern = asString(parsed.pattern);
  const startLine = asNumberLabel(parsed.startLine);
  const endLine = asNumberLabel(parsed.endLine);
  const ranges = Array.isArray(parsed.ranges) ? parsed.ranges : [];
  const rangeDetail =
    ranges.length > 0
      ? `${ranges.length} ${ranges.length === 1 ? 'range' : 'ranges'}`
      : startLine
        ? endLine
          ? `lines ${startLine}-${endLine}`
          : `line ${startLine}`
        : '';
  return {
    icon: <AppAdvisorIcon />,
    label: (
      <>
        Read workflow YAML
        {pipelineId && (
          <>
            {' '}
            <CodeChunk>{pipelineId}</CodeChunk>
          </>
        )}
        {repoId && <MutedSnippet>repo: {repoId}</MutedSnippet>}
        {rangeDetail && <MutedSnippet>{rangeDetail}</MutedSnippet>}
        {pattern && (
          <>
            {' '}
            <CodeChunk>{pattern}</CodeChunk>
          </>
        )}
      </>
    ),
  };
};

const renderAppAdvisorGetPipelineDebugContext: ToolDisplayRenderer = (
  parsed,
) => {
  const executionId = asString(parsed.executionId);
  return {
    icon: <AppAdvisorIcon />,
    label: executionId ? (
      <>
        Workflow debug context <CodeChunk>{executionId}</CodeChunk>
      </>
    ) : (
      'Workflow debug context'
    ),
  };
};

const renderAppSearchWatchers: ToolDisplayRenderer = (parsed) => {
  const query = asString(parsed.query);
  return {
    icon: <AppAdvisorWatcherIcon />,
    label: query ? (
      <>
        Search watchers <CodeChunk>{query}</CodeChunk>
      </>
    ) : (
      'Search watchers'
    ),
  };
};

const renderAppSetupWatchers: ToolDisplayRenderer = (parsed) => {
  const watchers = Array.isArray(parsed.watchers) ? parsed.watchers : [];
  const count = watchers.length;
  return {
    icon: <AppAdvisorWatcherIcon />,
    label:
      count > 0 ? (
        <>
          Setup watchers{' '}
          <MutedSnippet>
            {count} {count === 1 ? 'watcher' : 'watchers'}
          </MutedSnippet>
        </>
      ) : (
        'Setup watchers'
      ),
  };
};

/** Compact `owner/repository#number` label for a pull request watch item. */
function pullRequestItemLabel(
  item: unknown,
  defaultRepository: string,
): string | null {
  if (!isParsedInput(item) || item.kind !== 'pull_request') return null;
  const target = asString(item.target);
  const url = target.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (url) return `${url[1]}/${url[2]}#${url[3]}`;
  if (target) return target;
  const number = asString(item.number) || asNumberLabel(item.number);
  const repository = asString(item.repository) || defaultRepository;
  return repository ? `${repository}#${number}` : `#${number}`;
}

const renderWatchGitHubItems: ToolDisplayRenderer = (parsed) => {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const count = items.length;
  const defaultRepository = asString(parsed.repository);
  const pullRequests = items.map((item) =>
    pullRequestItemLabel(item, defaultRepository),
  );
  if (count > 0 && pullRequests.every((label) => label !== null)) {
    return {
      icon: <AppAdvisorWatcherIcon />,
      label: (
        <>
          Watch pull requests{' '}
          <MutedSnippet>
            {count === 1 ? pullRequests[0] : `${count} pull requests`}
          </MutedSnippet>
        </>
      ),
    };
  }
  return {
    icon: <AppAdvisorWatcherIcon />,
    label:
      count > 0 ? (
        <>
          Watch GitHub workflow runs{' '}
          <MutedSnippet>
            {count} {count === 1 ? 'run' : 'runs'}
          </MutedSnippet>
        </>
      ) : (
        'Watch GitHub workflow runs'
      ),
  };
};

const renderGetGitHubPullRequestStatus: ToolDisplayRenderer = (parsed) => {
  const reference = asString(parsed.pullRequest);
  const pullRequest = reference
    ? pullRequestItemLabel({ kind: 'pull_request', target: reference }, '')
    : null;
  return {
    icon: <AppAdvisorIcon />,
    label: pullRequest ? (
      <>
        Read pull request status <MutedSnippet>{pullRequest}</MutedSnippet>
      </>
    ) : (
      'Read pull request status'
    ),
  };
};

const renderDeleteWatchers: ToolDisplayRenderer = (parsed) => {
  const watcherIds = Array.isArray(parsed.watcherIds) ? parsed.watcherIds : [];
  const count = watcherIds.length;
  return {
    icon: <AppAdvisorWatcherIcon />,
    label:
      count > 0 ? (
        <>
          Delete watchers{' '}
          <MutedSnippet>
            {count} {count === 1 ? 'watcher' : 'watchers'}
          </MutedSnippet>
        </>
      ) : (
        'Delete watchers'
      ),
  };
};

const renderSearchDeferredToolsWithIcon =
  (icon: JSX.Element): ToolDisplayRenderer =>
  (parsed) => {
    const queries = Array.isArray(parsed.queries) ? parsed.queries : [];
    const count = queries.length;
    return {
      icon,
      label:
        count > 0 ? (
          <>
            Search deferred tools{' '}
            <MutedSnippet>
              {count} {count === 1 ? 'query' : 'queries'}
            </MutedSnippet>
          </>
        ) : (
          'Search deferred tools'
        ),
    };
  };

const renderLoadDeferredToolsWithIcon =
  (icon: JSX.Element): ToolDisplayRenderer =>
  (parsed) => {
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const count = items.length;
    return {
      icon,
      label:
        count > 0 ? (
          <>
            Load deferred tools{' '}
            <MutedSnippet>
              {count} {count === 1 ? 'item' : 'items'}
            </MutedSnippet>
          </>
        ) : (
          'Load deferred tools'
        ),
    };
  };

const renderSearchDeferredTools = renderSearchDeferredToolsWithIcon(
  <SkillIcon />,
);
const renderLoadDeferredTools = renderLoadDeferredToolsWithIcon(<SkillIcon />);
const renderImmediateTurnRestart: ToolDisplayRenderer = () => ({
  icon: <WrenchIcon />,
  label: 'Refresh and resume',
});
const renderAppAdvisorSearchDeferredTools = renderSearchDeferredToolsWithIcon(
  <AppAdvisorIcon />,
);
const renderAppAdvisorLoadDeferredTools = renderLoadDeferredToolsWithIcon(
  <AppAdvisorIcon />,
);
const renderPipelineEditorSearchDeferredTools =
  renderSearchDeferredToolsWithIcon(<PipelineIcon />);
const renderPipelineEditorLoadDeferredTools = renderLoadDeferredToolsWithIcon(
  <PipelineIcon />,
);

const APP_ADVISOR_CAPABILITY_RENDERERS: Record<
  AppAdvisorCapability,
  ToolDisplayRenderer
> = {
  ask_user_question: renderAppAdvisorAskUser,
  get_script_output: renderAppAdvisorGetScriptOutput,
  show_files: renderShowFiles,
  get_file_comments: renderGetFileComments,
  respond_to_file_comment: renderRespondToFileComment,
  search_actions: renderAppAdvisorSearchActions,
  get_current_ui_state: renderAppAdvisorGetCurrentUiState,
  dispatch_action: renderAppAdvisorDispatchAction,
  read_pipeline_yaml: renderAppAdvisorReadPipelineYaml,
  get_pipeline_debug_context: renderAppAdvisorGetPipelineDebugContext,
  search_watchers: renderAppSearchWatchers,
  setup_watchers: renderAppSetupWatchers,
  watch_github_items: renderWatchGitHubItems,
  get_github_pull_request_status: renderGetGitHubPullRequestStatus,
  watch_command: (parsed) => ({
    icon: <AppAdvisorWatcherIcon />,
    label: (
      <>
        Watch command <CodeChunk>{asString(parsed.command) ?? ''}</CodeChunk>
      </>
    ),
  }),
  schedule_wakeup: (parsed, input, toolName) =>
    renderScheduleWakeup(parsed, input, toolName),
  set_auto_archive: renderSetAutoArchive,
  set_work_entry_auto_delete: renderSetWorkEntryAutoDelete,
  show_capabilities: renderShowCapabilities,
  start_forked_agent: (parsed) => ({
    ...renderStartSplitAgent(parsed, '', ''),
    label: (
      <>
        Start forked agent{' '}
        <MutedSnippet>{asString(parsed.followUpInstruction)}</MutedSnippet>
      </>
    ),
  }),
  search_deferred_tools: renderAppAdvisorSearchDeferredTools,
  load_deferred_tools: renderAppAdvisorLoadDeferredTools,
};

const renderAppAdvisorTool: ToolDisplayRenderer = (parsed, input, toolName) => {
  const capability = getAppAdvisorCapability(toolName);
  if (capability) {
    return APP_ADVISOR_CAPABILITY_RENDERERS[capability](
      parsed,
      input,
      toolName,
    );
  }
  return { icon: <WrenchIcon />, label: ORCHESTRATOR_LABEL };
};

const renderPipelineEditorList: ToolDisplayRenderer = () => ({
  icon: <PipelineIcon />,
  label: 'List workflows',
});

const renderPipelineEditorOpen: ToolDisplayRenderer = (parsed) => {
  const id = asString(parsed.pipelineId) || asString(parsed.sharedRemoteId);
  return {
    icon: <PipelineIcon />,
    label: id ? (
      <>
        Open workflow <CodeChunk>{id}</CodeChunk>
      </>
    ) : (
      'Open workflow'
    ),
  };
};

const renderPipelineEditorCreate: ToolDisplayRenderer = () => ({
  icon: <PipelineIcon />,
  label: 'Create workflow',
});

const renderPipelineEditorGetCurrent: ToolDisplayRenderer = () => ({
  icon: <PipelineIcon />,
  label: 'Read current workflow',
});

const renderPipelineEditorSetYaml: ToolDisplayRenderer = () => ({
  icon: <PipelineIcon />,
  label: 'Edit workflow YAML',
});

const renderPipelineEditorSave: ToolDisplayRenderer = () => ({
  icon: <PipelineIcon />,
  label: 'Save workflow',
});

const renderPipelineEditorGetActionDefinition: ToolDisplayRenderer = (
  parsed,
) => {
  const name = asString(parsed.name);
  return {
    icon: <PipelineIcon />,
    label: name ? (
      <>
        Read action <CodeChunk>{name}</CodeChunk>
      </>
    ) : (
      'Read action definition'
    ),
  };
};

const renderPipelineEditorNavigate: ToolDisplayRenderer = () => ({
  icon: <PipelineIcon />,
  label: 'Go to workflow list',
});

const PIPELINE_EDITOR_CAPABILITY_RENDERERS: Record<
  PipelineEditorCapability,
  ToolDisplayRenderer
> = {
  list: renderPipelineEditorList,
  open: renderPipelineEditorOpen,
  create: renderPipelineEditorCreate,
  get_current: renderPipelineEditorGetCurrent,
  set_yaml: renderPipelineEditorSetYaml,
  save: renderPipelineEditorSave,
  get_action_definition: renderPipelineEditorGetActionDefinition,
  navigate_to_list: renderPipelineEditorNavigate,
  search_deferred_tools: renderPipelineEditorSearchDeferredTools,
  load_deferred_tools: renderPipelineEditorLoadDeferredTools,
};

const renderPipelineEditorTool: ToolDisplayRenderer = (
  parsed,
  input,
  toolName,
) => {
  const capability = getPipelineEditorCapability(toolName);
  if (capability) {
    return PIPELINE_EDITOR_CAPABILITY_RENDERERS[capability](
      parsed,
      input,
      toolName,
    );
  }
  return { icon: <PipelineIcon />, label: 'Workflow editor' };
};

const renderGetCodeGraphContext: ToolDisplayRenderer = () => ({
  icon: <GraphIcon />,
  label: 'Code Graph context',
});

const renderBuildOrUpdateCodeGraph: ToolDisplayRenderer = () => ({
  icon: <GraphIcon />,
  label: 'Build Code Graph',
});

const renderQueryCodeGraph: ToolDisplayRenderer = (parsed) => {
  const mode = asString(parsed.mode);
  const target = asString(parsed.target);
  return {
    icon: <GraphIcon />,
    label: (
      <>
        Query Code Graph
        {mode && <MutedSnippet>{mode}</MutedSnippet>}
        {target && (
          <>
            {' '}
            <CodeChunk>{shortenGraphTarget(target)}</CodeChunk>
          </>
        )}
      </>
    ),
  };
};

const renderSearchCodeGraph: ToolDisplayRenderer = (parsed) => {
  const query = asString(parsed.query);
  return {
    icon: <GraphIcon />,
    label: query ? (
      <>
        Search Code Graph <CodeChunk>{truncate(query, 60)}</CodeChunk>
      </>
    ) : (
      'Search Code Graph'
    ),
  };
};

const renderExplainCodeSymbol: ToolDisplayRenderer = (parsed) => {
  const qualifiedName = asString(parsed.qualifiedName);
  return {
    icon: <GraphIcon />,
    label: qualifiedName ? (
      <>
        Explain symbol{' '}
        <CodeChunk>{shortenGraphTarget(qualifiedName)}</CodeChunk>
      </>
    ) : (
      'Explain symbol'
    ),
  };
};

const renderGetImpactRadius: ToolDisplayRenderer = (parsed) => {
  const target = asString(parsed.target);
  const maxDepth = asNumberLabel(parsed.maxDepth);
  return {
    icon: <GraphIcon />,
    label: target ? (
      <>
        Impact radius <CodeChunk>{shortenGraphTarget(target)}</CodeChunk>
        {maxDepth && <MutedSnippet>{`depth ${maxDepth}`}</MutedSnippet>}
      </>
    ) : (
      'Impact radius'
    ),
  };
};

const renderDetectChangedSymbols: ToolDisplayRenderer = (parsed) => {
  const baseRef = asString(parsed.baseRef);
  return {
    icon: <GraphIcon />,
    label: (
      <>
        Detect changed symbols
        {baseRef && (
          <>
            {' '}
            vs <CodeChunk>{baseRef}</CodeChunk>
          </>
        )}
      </>
    ),
  };
};

const renderCompareChangeImpact: ToolDisplayRenderer = (parsed) => {
  const baseRef = asString(parsed.baseRef);
  const maxDepth = asNumberLabel(parsed.maxDepth);
  return {
    icon: <GraphIcon />,
    label: (
      <>
        Compare change impact
        {baseRef && (
          <>
            {' '}
            vs <CodeChunk>{baseRef}</CodeChunk>
          </>
        )}
        {maxDepth && <MutedSnippet>{`depth ${maxDepth}`}</MutedSnippet>}
      </>
    ),
  };
};

const renderGetReviewContext: ToolDisplayRenderer = (parsed) => {
  const baseRef = asString(parsed.baseRef);
  return {
    icon: <GraphIcon />,
    label: (
      <>
        Review context
        {baseRef && (
          <>
            {' '}
            vs <CodeChunk>{baseRef}</CodeChunk>
          </>
        )}
      </>
    ),
  };
};

// ---------------------------------------------------------------------------
// Ledger renderers — Add/Search/Update share the generic `WrenchIcon` and
// fold into the `canopy` family/turn-summary bucket, mirroring the local
// memory tools (SaveMemory/SearchMemory/ReadMemory) rather than the larger
// watcher/code-graph tool groups: three tools performing CRUD-style
// operations on structured records, not a distinct interaction surface.
// ---------------------------------------------------------------------------

const renderAddLedgerEntry: ToolDisplayRenderer = (parsed) => {
  const title = asString(parsed.title);
  return {
    icon: <WrenchIcon />,
    label: (
      <span data-testid="chat-tool-call-add-ledger-entry-label">
        {title ? (
          <>
            Add Feed entry <MutedSnippet>{truncate(title, 60)}</MutedSnippet>
          </>
        ) : (
          'Add Feed entry'
        )}
      </span>
    ),
  };
};

const renderSearchLedgerEntries: ToolDisplayRenderer = (parsed) => {
  const query = asString(parsed.query);
  const entryIds = Array.isArray(parsed.entryIds) ? parsed.entryIds : [];
  return {
    icon: <WrenchIcon />,
    label: (
      <span data-testid="chat-tool-call-search-ledger-entries-label">
        {query ? (
          <>
            Search Feed <CodeChunk>{truncate(query, 60)}</CodeChunk>
          </>
        ) : entryIds.length > 0 ? (
          <>
            Search Feed{' '}
            <MutedSnippet>
              {entryIds.length} {entryIds.length === 1 ? 'entry' : 'entries'}
            </MutedSnippet>
          </>
        ) : (
          'Search Feed'
        )}
      </span>
    ),
  };
};

const renderUpdateLedgerEntry: ToolDisplayRenderer = (parsed) => {
  const status = asString(parsed.status);
  const owner = parsed.owner;
  const ownerActorId =
    isParsedInput(owner) && typeof owner.actorId === 'string'
      ? owner.actorId
      : '';
  const shortOwnerActorId =
    ownerActorId.length > 8 ? ownerActorId.slice(0, 8) : ownerActorId;
  const ownerLabel = owner === 'self' ? 'self' : shortOwnerActorId;
  return {
    icon: <WrenchIcon />,
    label: (
      <span data-testid="chat-tool-call-update-ledger-entry-label">
        Update Feed entry
        {status && (
          <>
            {' '}
            <CodeChunk>{status}</CodeChunk>
          </>
        )}
        {ownerLabel && <MutedSnippet>{`owner ${ownerLabel}`}</MutedSnippet>}
      </span>
    ),
  };
};

const APP_ACTION_RENDERERS: Record<
  CanopyActionCapability,
  ToolDisplayRenderer
> = {
  show_files: renderShowFiles,
  show_capabilities: renderShowCapabilities,
  set_work_entry_auto_delete: renderSetWorkEntryAutoDelete,
  show_visual: renderShowVisual,
  preview_visual: renderPreviewVisual,
  get_file_comments: renderGetFileComments,
  respond_to_file_comment: renderRespondToFileComment,
  search_actions: renderAppAdvisorSearchActions,
  dispatch_action: renderAppAdvisorDispatchAction,
  get_git_preferences: renderGetGitPreferences,
  save_memory: renderSaveMemory,
  search_memory: renderSearchMemory,
  search_chats: (parsed) => ({
    icon: <WrenchIcon />,
    label: (
      <span>
        Search chats
        {asString(parsed.query) ? (
          <>
            {' '}
            <CodeChunk>{asString(parsed.query)}</CodeChunk>
          </>
        ) : null}
      </span>
    ),
  }),
  read_chat_excerpt: () => ({
    icon: <WrenchIcon />,
    label: 'Read chat excerpt',
  }),
  read_memory: renderReadMemory,
  read_pipeline_yaml: renderAppAdvisorReadPipelineYaml,
  search_watchers: renderAppSearchWatchers,
  setup_watchers: renderAppSetupWatchers,
  watch_github_items: renderWatchGitHubItems,
  get_github_pull_request_status: renderGetGitHubPullRequestStatus,
  watch_command: (parsed) => ({
    icon: <AppAdvisorWatcherIcon />,
    label: (
      <>
        Watch command <CodeChunk>{asString(parsed.command) ?? ''}</CodeChunk>
      </>
    ),
  }),
  schedule_wakeup: (parsed, input, toolName) =>
    renderScheduleWakeup(parsed, input, toolName),
  delete_watchers: renderDeleteWatchers,
  set_base_branch: renderSetBaseBranch,
  start_forked_agent: (parsed) => ({
    ...renderStartSplitAgent(parsed, '', ''),
    label: (
      <>
        Start forked agent{' '}
        <MutedSnippet>{asString(parsed.followUpInstruction)}</MutedSnippet>
      </>
    ),
  }),
  start_branched_agent: (parsed) => ({
    ...renderStartSplitAgent(parsed, '', ''),
    label: (
      <>
        Start branched agent{' '}
        <MutedSnippet>{asString(parsed.followUpInstruction)}</MutedSnippet>
      </>
    ),
  }),
  search_deferred_tools: renderSearchDeferredTools,
  load_deferred_tools: renderLoadDeferredTools,
  immediate_turn_restart: renderImmediateTurnRestart,
  get_code_graph_context: renderGetCodeGraphContext,
  build_or_update_code_graph: renderBuildOrUpdateCodeGraph,
  query_code_graph: renderQueryCodeGraph,
  search_code_graph: renderSearchCodeGraph,
  explain_code_symbol: renderExplainCodeSymbol,
  get_impact_radius: renderGetImpactRadius,
  detect_changed_symbols: renderDetectChangedSymbols,
  compare_change_impact: renderCompareChangeImpact,
  get_review_context: renderGetReviewContext,
  add_ledger_entry: renderAddLedgerEntry,
  search_ledger_entries: renderSearchLedgerEntries,
  update_ledger_entry: renderUpdateLedgerEntry,
};

const renderAppActionTool: ToolDisplayRenderer = (
  parsed,
  input,
  toolName,
  scope,
) => {
  const capability =
    APP_ACTION_TOOL_NAME_TO_CAPABILITY.get(toolName) ??
    getBrandedAppCapability(toolName, scope);
  if (capability) {
    if (capability === 'set_auto_archive') {
      return renderSetAutoArchive(parsed, input, toolName);
    }
    if (capability === 'set_work_entry_auto_delete') {
      return renderSetWorkEntryAutoDelete(parsed, input, toolName);
    }
    if (capability === 'spawn_delegate')
      return { icon: <AgentIcon />, label: 'Delegate task' };
    if (capability === 'watch_delegates')
      return { icon: <AgentIcon />, label: 'Watch delegates' };
    if (capability === 'get_delegate_output')
      return { icon: <AgentIcon />, label: 'Get delegate output' };
    if (capability === 'wait_delegates')
      return { icon: <AgentIcon />, label: 'Wait for delegations' };
    if (capability === 'inspect_delegate')
      return { icon: <AgentIcon />, label: 'Inspect delegation' };
    if (capability === 'list_delegates')
      return { icon: <AgentIcon />, label: 'List delegations' };
    if (capability === 'stop_delegate')
      return { icon: <AgentIcon />, label: 'Stop delegation' };
    if (capability === 'manage_delegate') {
      return { icon: <AgentIcon />, label: 'Manage delegate' };
    }
    if (capability === 'manage_delegate_worktree')
      return { icon: <AgentIcon />, label: 'Manage delegate worktree' };
    if (capability === 'message_delegate')
      return { icon: <AgentIcon />, label: 'Message delegate' };
    if (capability === 'request_steering')
      return { icon: <AgentIcon />, label: 'Request steering' };
    if (
      capability === 'ask_user_question' ||
      capability === 'get_script_output'
    ) {
      return { icon: <WrenchIcon />, label: 'App' };
    }
    const rendered = APP_ACTION_RENDERERS[capability](parsed, input, toolName);
    // Watchers keep their AppAdvisorWatcherIcon and code-graph tools keep their
    // GraphIcon; every other app-action tool folds into the neutral app icon.
    return capability === 'search_watchers' ||
      capability === 'setup_watchers' ||
      capability === 'watch_github_items' ||
      capability === 'watch_command' ||
      capability === 'schedule_wakeup' ||
      capability === 'delete_watchers' ||
      CODE_GRAPH_CAPABILITIES.has(capability)
      ? rendered
      : { ...rendered, icon: <WrenchIcon /> };
  }
  return { icon: <WrenchIcon />, label: 'App' };
};

const PREDICATE_MATCHERS: ToolDisplayMatcher[] = [
  {
    match: isComputerUseToolName,
    render: (_parsed, _input, toolName) => ({
      icon: <PickIcon />,
      label:
        toolName === 'mcp__cua_repl__js_reset' ? (
          <>
            Computer use <CodeChunk>Reset</CodeChunk>
          </>
        ) : (
          'Computer use'
        ),
    }),
  },
  { match: isAppAdvisorToolName, render: renderAppAdvisorTool },
  { match: isPipelineEditorToolName, render: renderPipelineEditorTool },
  { match: isAppActionToolName, render: renderAppActionTool },
  { match: isAskUserQuestionToolName, render: renderAskUserQuestion },
  { match: isGetScriptOutputToolName, render: renderGetScriptOutput },
  { match: isSetAutoArchiveToolName, render: renderSetAutoArchive },
  { match: isPlanToolName, render: renderPlanTool },
];

// ---------------------------------------------------------------------------
// Per-tool renderers (file ops, shell, search, web, task management, agents)
// ---------------------------------------------------------------------------

const renderRead: ToolDisplayRenderer = (parsed) => {
  const filePath = asString(parsed.file_path ?? parsed.filePath);
  return {
    icon: <DocumentIcon />,
    label: filePath ? (
      <>
        <ToolVerb clean="Read" /> <CodeChunk>{baseName(filePath)}</CodeChunk>
      </>
    ) : (
      'Read'
    ),
  };
};

const renderReadLines: ToolDisplayRenderer = (parsed) => {
  const filePath = asString(parsed.file_path ?? parsed.filePath);
  const start = asString(parsed.start);
  const end = asString(parsed.end);
  const last = asString(parsed.last);
  return {
    icon: <DocumentIcon />,
    label: filePath ? (
      <>
        Read lines <CodeChunk>{baseName(filePath)}</CodeChunk>
        {start && end && <MutedSnippet>{`${start} to ${end}`}</MutedSnippet>}
        {!start && !end && last && (
          <MutedSnippet>{`last ${last} lines`}</MutedSnippet>
        )}
      </>
    ) : (
      'Read lines'
    ),
  };
};

const renderSkill: ToolDisplayRenderer = (parsed) => {
  const skillName = asString(parsed.skill);
  return {
    icon: <SkillIcon />,
    label: skillName ? (
      <>
        Using skill <CodeChunk>{skillName}</CodeChunk>
      </>
    ) : (
      'Skill'
    ),
  };
};

const renderWrite: ToolDisplayRenderer = (parsed) => {
  const filePath = asString(parsed.file_path ?? parsed.filePath);
  return {
    icon: <DocumentPencilIcon />,
    label: filePath ? (
      <>
        <ToolVerb clean="Write" /> <CodeChunk>{baseName(filePath)}</CodeChunk>
      </>
    ) : (
      'Write'
    ),
  };
};

const renderEdit: ToolDisplayRenderer = (parsed) => {
  const filePath = asString(parsed.file_path ?? parsed.filePath);
  return {
    icon: <DocumentPencilIcon />,
    label: filePath ? (
      <>
        <ToolVerb clean="Edit" /> <CodeChunk>{baseName(filePath)}</CodeChunk>
      </>
    ) : (
      'Edit'
    ),
  };
};

// Shared by `Bash` (POSIX) and `PowerShell` (the Windows shell tool Claude
// exposes instead of Bash). Both take the same `{ command, description }`
// input, so only the no-description heading differs.
const renderBash: ToolDisplayRenderer = (parsed, input, toolName) => {
  const command = unwrapShellWrappedCommand(
    asString(parsed.command ?? parsed.cmd) || readShellCommandInput(input),
  );
  const description = capitalizeFirstLetter(
    asString(parsed.description).trim(),
  );
  return {
    icon: <TerminalIcon />,
    label:
      description || command ? (
        <ShellLabel command={command} description={description || undefined} />
      ) : toolName === 'PowerShell' ? (
        toolName
      ) : (
        'Bash'
      ),
  };
};

const renderCommand: ToolDisplayRenderer = (_parsed, input) => {
  const command = input.trim();
  const displayCommand = unwrapShellWrappedCommand(command);
  return {
    icon: <TerminalIcon />,
    label: displayCommand ? <ShellLabel command={displayCommand} /> : 'Command',
  };
};

const renderFileChange: ToolDisplayRenderer = (_parsed, input) => {
  const lines = input
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);
  if (lines.length === 1) {
    const match = lines[0].match(/^(\w+):\s*(.+)$/);
    if (match) {
      const kind = match[1].toLowerCase();
      const filePath = match[2];
      const icon = kind === 'delete' ? <TrashIcon /> : <DocumentPencilIcon />;
      const verb =
        kind === 'delete'
          ? 'Delete'
          : kind === 'add' || kind === 'create'
            ? 'Write'
            : 'Edit';
      return {
        icon,
        label: (
          <>
            <ToolVerb clean={verb} />{' '}
            <CodeChunk>{baseName(filePath)}</CodeChunk>
          </>
        ),
      };
    }
  }
  if (lines.length > 1) {
    return {
      icon: <DocumentPencilIcon />,
      label: `File changes (${String(lines.length)} files)`,
    };
  }
  return { icon: <DocumentPencilIcon />, label: 'File change' };
};

const renderGrep: ToolDisplayRenderer = (parsed) => {
  const pattern = asString(parsed.pattern);
  const filePath = asString(parsed.path ?? parsed.dir_path);
  return {
    icon: <DocumentSearchIcon />,
    label: pattern ? (
      <>
        <ToolVerb clean="Search for" /> <CodeChunk>{pattern}</CodeChunk>
        {filePath && (
          <>
            {' '}
            in <CodeChunk>{baseName(filePath)}</CodeChunk>
          </>
        )}
      </>
    ) : (
      'Grep'
    ),
  };
};

const renderGlob: ToolDisplayRenderer = (parsed) => {
  const pattern = asString(parsed.pattern);
  return {
    icon: <MagnifyingGlassIcon />,
    label: pattern ? (
      <>
        <ToolVerb clean="Find files matching" />{' '}
        <CodeChunk>{pattern}</CodeChunk>
      </>
    ) : (
      'Glob'
    ),
  };
};

const renderListDirectory: ToolDisplayRenderer = (parsed) => {
  const directory = asString(parsed.path);
  return {
    icon: <MagnifyingGlassIcon />,
    label: (
      <>
        List directory
        {directory && (
          <>
            {' '}
            <CodeChunk>{directory}</CodeChunk>
          </>
        )}
      </>
    ),
  };
};

const renderReadManyFiles: ToolDisplayRenderer = (parsed) => {
  const paths = Array.isArray(parsed.paths) ? parsed.paths : parsed.include;
  const detail = Array.isArray(paths)
    ? paths
        .filter((value): value is string => typeof value === 'string')
        .join(', ')
    : '';
  return {
    icon: <DocumentIcon />,
    label: (
      <>
        Read files
        {detail && (
          <>
            {' '}
            <CodeChunk>{truncate(detail, 80)}</CodeChunk>
          </>
        )}
      </>
    ),
  };
};

const renderToolSearch: ToolDisplayRenderer = (parsed) => {
  const query = asString(parsed.query);
  return {
    icon: <MagnifyingGlassIcon />,
    label: query ? (
      <>
        Tool search <CodeChunk>{query}</CodeChunk>
      </>
    ) : (
      'Tool search'
    ),
  };
};

const renderTaskOutput: ToolDisplayRenderer = (parsed) => {
  const taskId = asString(parsed.task_id);
  return {
    icon: <AgentIcon />,
    label: taskId ? (
      <>
        Agent output <CodeChunk>{taskId.slice(0, 12)}&hellip;</CodeChunk>
      </>
    ) : (
      'Agent output'
    ),
  };
};

const renderWebFetch: ToolDisplayRenderer = (parsed) => {
  const url = asString(parsed.url);
  return {
    icon: <GlobeIcon />,
    label: url ? (
      <>
        Web fetch <CodeChunk>{url}</CodeChunk>
      </>
    ) : (
      'Web fetch'
    ),
  };
};

const renderWebSearch: ToolDisplayRenderer = (parsed) => {
  const query = asString(parsed.query);
  return {
    icon: <GlobeIcon />,
    label: query ? (
      <>
        Web search <CodeChunk>{query}</CodeChunk>
      </>
    ) : (
      'Web search'
    ),
  };
};

const renderWebSearchRaw: ToolDisplayRenderer = (parsed, input) => {
  const query = asString(parsed.query) || input.trim();
  return {
    icon: <GlobeIcon />,
    label: query ? (
      <>
        Web search <CodeChunk>{query}</CodeChunk>
      </>
    ) : (
      'Web search'
    ),
  };
};

const renderTodoWrite: ToolDisplayRenderer = (parsed) => {
  const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
  return {
    icon: <AppCatalogTaskIcon size="sm" />,
    label: (
      <>
        Update todos{' '}
        <MutedSnippet>
          ({todos.length} {todos.length === 1 ? 'item' : 'items'})
        </MutedSnippet>
      </>
    ),
  };
};

const renderTaskCreate: ToolDisplayRenderer = (parsed) => {
  const subject = asString(parsed.subject);
  return {
    icon: <AppCatalogTaskIcon size="sm" />,
    label: subject ? (
      <>
        Create task <CodeChunk>{subject}</CodeChunk>
      </>
    ) : (
      'Create task'
    ),
  };
};

const renderTaskUpdate: ToolDisplayRenderer = (parsed) => {
  const taskId = asString(parsed.taskId);
  const status = asString(parsed.status);
  return {
    icon: <AppCatalogTaskIcon size="sm" />,
    label: (
      <>
        Update task
        {taskId && (
          <>
            {' '}
            <CodeChunk>#{taskId}</CodeChunk>
          </>
        )}
        {status && <MutedSnippet>&rarr; {status}</MutedSnippet>}
      </>
    ),
  };
};

const renderTaskList: ToolDisplayRenderer = () => ({
  icon: <AppCatalogTaskIcon size="sm" />,
  label: 'List tasks',
});

const renderTaskGet: ToolDisplayRenderer = (parsed) => {
  const taskId = asString(parsed.taskId);
  return {
    icon: <AppCatalogTaskIcon size="sm" />,
    label: taskId ? (
      <>
        Get task <CodeChunk>#{taskId}</CodeChunk>
      </>
    ) : (
      'Get task'
    ),
  };
};

const renderTaskStop: ToolDisplayRenderer = (parsed) => {
  const taskId = asString(parsed.task_id);
  return {
    icon: <StopIcon />,
    label: taskId ? (
      <>
        Stop task <CodeChunk>{taskId}</CodeChunk>
      </>
    ) : (
      'Stop task'
    ),
  };
};

const renderScheduleWakeup: ToolDisplayRenderer = (parsed) => {
  const reason = asString(parsed.reason);
  const delaySeconds =
    typeof parsed.delaySeconds === 'number' ? parsed.delaySeconds : null;
  return {
    icon: <StopwatchIcon />,
    label: (
      <>
        Schedule wakeup
        {reason && <MutedSnippet>{reason}</MutedSnippet>}
        {delaySeconds !== null && (
          <MutedSnippet>{delaySeconds} seconds</MutedSnippet>
        )}
      </>
    ),
  };
};

// Claude's own scheduler: a prompt the session runs on a cron schedule.
const renderCronCreate: ToolDisplayRenderer = (parsed) => {
  const cron = asString(parsed.cron);
  const prompt = asString(parsed.prompt);
  return {
    icon: <ScheduleIcon />,
    label: (
      <>
        Schedule prompt
        {cron && <CodeChunk>{cron}</CodeChunk>}
        {prompt && <MutedSnippet>{prompt}</MutedSnippet>}
      </>
    ),
  };
};

const renderCronDelete: ToolDisplayRenderer = (parsed) => {
  const id = asString(parsed.id);
  return {
    icon: <ScheduleIcon />,
    label: (
      <>
        Cancel scheduled prompt
        {id && <CodeChunk>{id}</CodeChunk>}
      </>
    ),
  };
};

const renderCronList: ToolDisplayRenderer = () => ({
  icon: <ScheduleIcon />,
  label: 'List scheduled prompts',
});

const renderMonitor: ToolDisplayRenderer = (parsed) => {
  const description = asString(parsed.description);
  return {
    icon: <MonitorIcon />,
    label: description ? (
      <>
        Monitor <MutedSnippet>{description}</MutedSnippet>
      </>
    ) : (
      'Monitor'
    ),
  };
};

const renderAgent: ToolDisplayRenderer = (parsed) => {
  const desc = asString(parsed.description);
  return {
    icon: <AgentIcon />,
    label: desc ? (
      <>
        Agent <MutedSnippet>{desc}</MutedSnippet>
      </>
    ) : (
      'Agent'
    ),
  };
};

const renderWorkflow: ToolDisplayRenderer = (parsed) => {
  const name = asString(parsed.name);
  return {
    icon: <AgentIcon />,
    label: name ? (
      <>
        Workflow <MutedSnippet>{name}</MutedSnippet>
      </>
    ) : (
      'Workflow'
    ),
  };
};

// Agent-to-agent message (Claude Agent SDK `SendMessage`). The raw input
// carries `{ to, summary, message }`, where `to` is the recipient agent id.
// Hosts that can resolve that id to a friendly agent name pass it through
// `resolvedRecipient`; otherwise the raw id is shown as a fallback.
function buildSendMessageInfo(
  parsed: ParsedInput,
  resolvedRecipient?: string,
): ToolDisplayInfo {
  const summary = asString(parsed.summary);
  const recipient = resolvedRecipient || asString(parsed.to);
  return {
    icon: <AgentIcon />,
    label: (
      <>
        Agent message
        {recipient && (
          <>
            {' '}
            <CodeChunk>{recipient}</CodeChunk>
          </>
        )}
        {summary && <MutedSnippet>{summary}</MutedSnippet>}
      </>
    ),
  };
}

const renderSendMessage: ToolDisplayRenderer = (parsed) =>
  buildSendMessageInfo(parsed);

/**
 * Resolve the `SendMessage` display `{ icon, label }` with an optional
 * host-resolved recipient name. Hosts that can map the raw `to` agent id to a
 * friendly agent/task name (e.g. the desktop transcript) pass it here; the
 * generic registry path (`getToolDisplayInfo`) falls back to the raw id.
 */
export function getSendMessageDisplayInfo(
  input: string,
  resolvedRecipient?: string,
): ToolDisplayInfo {
  let parsed: ParsedInput = {};
  try {
    const parsedInput: unknown = JSON.parse(input);
    if (isParsedInput(parsedInput)) {
      parsed = parsedInput;
    }
  } catch {
    // input may not be valid JSON
  }
  return buildSendMessageInfo(parsed, resolvedRecipient);
}

const renderListMcpResources: ToolDisplayRenderer = () => ({
  icon: <McpIcon />,
  label: 'List MCP servers',
});

// Exact-name lookup. Aliases that share a renderer are listed once per name
// so the registry stays the single source of truth for which names are
// recognised.
const NAME_RENDERERS: Record<string, ToolDisplayRenderer> = {
  ClaudeModelChange: renderClaudeModelChange,
  Read: renderRead,
  ReadLines: renderReadLines,
  ReadManyFiles: renderReadManyFiles,
  ListDirectory: renderListDirectory,
  Skill: renderSkill,
  Write: renderWrite,
  Edit: renderEdit,
  Bash: renderBash,
  PowerShell: renderBash,
  command: renderCommand,
  file_change: renderFileChange,
  apply_patch: renderFileChange,
  Grep: renderGrep,
  Glob: renderGlob,
  ToolSearch: renderToolSearch,
  TaskOutput: renderTaskOutput,
  WebFetch: renderWebFetch,
  WebSearch: renderWebSearch,
  web_search: renderWebSearchRaw,
  TodoWrite: renderTodoWrite,
  TaskCreate: renderTaskCreate,
  TaskUpdate: renderTaskUpdate,
  TaskList: renderTaskList,
  TaskGet: renderTaskGet,
  TaskStop: renderTaskStop,
  ScheduleWakeup: renderScheduleWakeup,
  CronCreate: renderCronCreate,
  CronDelete: renderCronDelete,
  CronList: renderCronList,
  Monitor: renderMonitor,
  [legacyMcpToolName('Monitor')]: renderMonitor,
  Task: renderAgent,
  Agent: renderAgent,
  SendMessage: renderSendMessage,
  Workflow: renderWorkflow,
  ListMcpResourcesTool: renderListMcpResources,
};

const CLOUD_TOOL_ALIASES: Readonly<Record<string, string>> = {
  read: 'Read',
  read_file: 'Read',
  write: 'Write',
  write_file: 'Write',
  edit: 'Edit',
  replace: 'Edit',
  grep: 'Grep',
  grep_search: 'Grep',
  glob: 'Glob',
  bash: 'Bash',
  exec_command: 'Bash',
  run_shell_command: 'Bash',
  webSearch: 'WebSearch',
  google_web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  write_todos: 'TodoWrite',
  list_directory: 'ListDirectory',
  read_many_files: 'ReadManyFiles',
};

function readShellCommandInput(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed === 'string') return parsed;
    return isParsedInput(parsed) ? asString(parsed.command ?? parsed.cmd) : '';
  } catch {
    return input;
  }
}

/** Shell tool names a Codex harness reports for its command executions. */
const CODEX_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'exec_command',
  'shell',
]);

/**
 * A Codex harness tool call in the shape desktop's Codex transcript records
 * it: a shell call becomes the `command` row whose input is the command, so
 * every host labels it "Command". Any other call is returned unchanged.
 */
export function codexToolCall(
  toolName: string,
  input: string,
): { readonly toolName: string; readonly input: string } {
  if (!CODEX_SHELL_TOOL_NAMES.has(toolName)) return { toolName, input };
  const command = readShellCommandInput(input).trim();
  return command.length > 0
    ? { toolName: 'command', input: command }
    : { toolName, input };
}

function normalizeCloudToolDisplay(
  toolName: string,
  input: string,
): { toolName: string; input: string } {
  const canonicalName = Object.prototype.hasOwnProperty.call(
    CLOUD_TOOL_ALIASES,
    toolName,
  )
    ? CLOUD_TOOL_ALIASES[toolName]
    : toolName;
  if (
    toolName === 'command' ||
    (canonicalName === 'Bash' && toolName !== canonicalName)
  ) {
    const command =
      toolName === 'command' ? input : readShellCommandInput(input);
    const normalized = normalizeCommandReadToolBlock(
      { toolName: 'command', input: command },
      { literalPathsOnly: true },
    );
    if (normalized.toolName !== 'command') return normalized;
  }
  return { toolName: canonicalName, input };
}

/**
 * A tool call's input as people read it, for the clean chat look's expanded
 * row: a shell call shows just its command, and other JSON input shows one
 * `name: value` line per field instead of raw JSON. Anything that isn't a
 * JSON object is shown as it is.
 */
export function readableToolInput(toolName: string, input: string): string {
  const { toolName: canonical, input: canonicalInput } =
    normalizeCloudToolDisplay(toolName, input);
  if (
    canonical === 'Bash' ||
    canonical === 'PowerShell' ||
    canonical === 'command'
  ) {
    const command =
      canonical === 'command'
        ? canonicalInput.trim()
        : readShellCommandInput(canonicalInput);
    if (command) return unwrapShellWrappedCommand(command);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return input;
  }
  if (!isParsedInput(parsed)) return input;
  return Object.entries(parsed)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Resolve a tool name + raw input string to a rich display `{ icon, label }`.
 * The label is a React fragment that may contain inline code chunks for the
 * filename/command/pattern parameters surfaced for that tool family.
 */
export function getToolDisplayInfo(
  rawToolName: string,
  rawInput: string,
  scope?: ToolDisplayScope,
): ToolDisplayInfo {
  const { toolName, input } = normalizeCloudToolDisplay(rawToolName, rawInput);
  const delegationLabel: Record<string, string> = {
    DelegateTask: 'Delegate task',
    WaitDelegates: 'Wait for delegations',
    WatchDelegates: 'Watch delegates',
    GetDelegateOutput: 'Get delegate output',
    ManageDelegateWorktree: 'Manage delegate worktree',
    MessageDelegate: 'Message delegate',
    RequestSteering: 'Request steering',
    InspectDelegate: 'Inspect delegation',
    ListDelegates: 'List delegations',
    StopDelegate: 'Stop delegation',
  };
  if (delegationLabel[toolName]) {
    return { icon: <AgentIcon />, label: delegationLabel[toolName] };
  }
  let parsed: ParsedInput = {};
  try {
    const parsedInput: unknown = JSON.parse(input);
    if (isParsedInput(parsedInput)) {
      parsed = parsedInput;
    }
  } catch {
    // input may not be valid JSON
  }

  for (const matcher of PREDICATE_MATCHERS) {
    if (matcher.match(toolName, scope)) {
      return matcher.render(parsed, input, toolName, scope);
    }
  }

  const exactRenderer = NAME_RENDERERS[toolName];
  if (exactRenderer) {
    return exactRenderer(parsed, input, toolName);
  }

  const mcpInfo = parseMcpToolName(toolName);
  if (mcpInfo) {
    return {
      icon: <McpIcon />,
      label: (
        <>
          <CodeChunk>{prettifyToolName(mcpInfo.server)}</CodeChunk>
          <span className="mx-1 fg-secondary">&rsaquo;</span>
          <CodeChunk>{prettifyToolName(mcpInfo.tool)}</CodeChunk>
        </>
      ),
    };
  }

  return { icon: <WrenchIcon />, label: prettifyToolName(toolName) };
}

// ---------------------------------------------------------------------------
// Tool family dispatch — used when feeding the shared `ToolCallCard` from the
// hosts (desktop wrapper + web message-renderer). Keeps the icon dispatch a
// closed-union lookup instead of a switch on free-form names.
// ---------------------------------------------------------------------------

const NAME_TO_FAMILY: Record<string, PortalChatToolFamily> = {
  Read: 'read',
  ReadLines: 'read',
  ReadManyFiles: 'read',
  ListDirectory: 'glob',
  Write: 'write',
  Edit: 'edit',
  Bash: 'bash',
  PowerShell: 'bash',
  command: 'bash',
  file_change: 'edit',
  apply_patch: 'edit',
  Grep: 'grep',
  Glob: 'glob',
  ToolSearch: 'glob',
  WebFetch: 'web',
  WebSearch: 'web',
  web_search: 'web',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  TaskList: 'todo',
  TaskGet: 'todo',
  TaskStop: 'todo',
  TaskOutput: 'agent',
  Task: 'agent',
  Agent: 'agent',
  SendMessage: 'agent',
  Workflow: 'agent',
  ScheduleWakeup: 'monitor',
  CronCreate: 'monitor',
  CronDelete: 'monitor',
  CronList: 'monitor',
  Monitor: 'monitor',
  [legacyMcpToolName('Monitor')]: 'monitor',
  // Plan-mode control tools. Canopy denies `ExitPlanMode` on purpose so the
  // plan routes into its own review UI; mapping both names to `plan` stops the
  // denial from rendering as a nondescript failed tool (CAN-3019).
  ExitPlanMode: 'plan',
  EnterPlanMode: 'plan',
  Skill: 'skill',
  ClaudeModelChange: 'claude',
  ListMcpResourcesTool: 'unknown',
};

/**
 * Derive a `PortalChatToolFamily` from a raw tool name. Used by the hosts
 * that feed the shared `ToolCallCard` so the icon dispatch can stay a
 * closed-union lookup instead of a switch on free-form names.
 */
export function getToolFamilyFromName(
  rawToolName: string,
  scope?: ToolDisplayScope,
  input = '',
): PortalChatToolFamily {
  const { toolName } = normalizeCloudToolDisplay(rawToolName, input);
  if (isComputerUseToolName(toolName)) return 'computer-use';
  // A delegation spawn is agent work; every other delegation tool lists,
  // reads, watches, messages or stops delegates, so it is app plumbing and
  // counts with the app tools (matching the Portal family and turn summary).
  const delegationCapability = getBrandedAppCapability(toolName, scope) ?? '';
  if (delegationCapability === 'spawn_delegate' || toolName === 'DelegateTask')
    return 'agent';
  if (
    [
      'watch_delegates',
      'get_delegate_output',
      'wait_delegates',
      'inspect_delegate',
      'list_delegates',
      'stop_delegate',
      'manage_delegate',
      'manage_delegate_worktree',
      'message_delegate',
      'request_steering',
    ].includes(delegationCapability) ||
    [
      'WaitDelegates',
      'WatchDelegates',
      'GetDelegateOutput',
      'ManageDelegateWorktree',
      'MessageDelegate',
      'RequestSteering',
      'InspectDelegate',
      'ListDelegates',
      'StopDelegate',
    ].includes(toolName)
  )
    return 'canopy';
  if (isPlanToolName(toolName)) return 'plan';
  if (isWatcherToolName(toolName)) return 'watcher';
  if (isAppAdvisorToolName(toolName)) return 'app-advisor';
  if (isPipelineEditorToolName(toolName)) return 'pipeline-editor';
  if (isAskUserQuestionToolName(toolName)) return 'ask-user';
  if (isGetScriptOutputToolName(toolName)) return 'script-output';
  if (isSetAutoArchiveToolName(toolName)) return 'canopy';
  if (isCodeGraphToolName(toolName, scope)) return 'graph';
  if (isAppActionToolName(toolName, scope)) return 'canopy';
  const direct = NAME_TO_FAMILY[toolName];
  if (direct) return direct;
  if (parseMcpToolName(toolName)) return 'unknown';
  return 'unknown';
}

export function getToolDisplayFamily(
  toolName: string,
  input: string,
  suppliedFamily?: PortalChatToolFamily,
  scope?: ToolDisplayScope,
): PortalChatToolFamily {
  if (suppliedFamily && suppliedFamily !== 'bash') return suppliedFamily;
  const derivedFamily = getToolFamilyFromName(toolName, scope, input);
  if (
    suppliedFamily === 'bash' &&
    (derivedFamily === 'read' || derivedFamily === 'skill')
  ) {
    return derivedFamily;
  }
  return suppliedFamily ?? derivedFamily;
}
