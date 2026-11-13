import { isHistoricalDelegateWatchToolName } from '@canopy/execution-engine/lib/canopy-injected-tools';
/**
 * Pure helper for mapping a tool-name string to one of the canonical
 * `PortalChatToolFamily` buckets used by the portal protocol. Keep this
 * file dependency-free so both the desktop main process and the renderer
 * can import it; the protocol package consumes the union directly via the
 * @canopy/protocol/portal export.
 *
 * The mapping must be deterministic — the same tool name always returns
 * the same family — so the chat-transcript projector can stamp the field
 * on `tool_use` parts without round-tripping through the renderer.
 */

import {
  getCanonicalAppAdvisorToolKey,
  isAppAdvisorLedgerToolKey,
  isAppAdvisorToolName,
} from './app-advisor-tools';
import {
  getCanonicalCanopyToolKey,
  isCanopyAskUserToolName,
  isCanopyGetScriptOutputToolName,
  isCanopyImmediateTurnRestartToolName,
  isManagedDelegationAppToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import { getCanonicalPipelineEditorToolKey } from './pipeline-editor-tools';

const LEGACY_TOOL_NAMESPACE = ['cano', 'py'].join('');
const legacyMcpToolName = (name: string): string =>
  `mcp__${LEGACY_TOOL_NAMESPACE}__${name}`;

/**
 * Closed enumeration of tool families surfaced on `tool_use` chat parts.
 * Mirrors the protocol's `PortalChatToolFamily` union element-for-element.
 * Kept as a stand-alone literal-string type so this module remains
 * environment-neutral and free of protocol imports.
 */
export type PortalChatToolFamily =
  | 'read'
  | 'edit'
  | 'write'
  | 'plan'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'todo'
  | 'web'
  | 'agent'
  | 'ask-user'
  | 'script-output'
  | 'skill'
  | 'monitor'
  | 'claude'
  | 'watcher'
  | 'canopy'
  | 'graph'
  | 'app-advisor'
  | 'pipeline-editor'
  | 'computer-use'
  | 'unknown';

const COMPUTER_USE_TOOL_NAMES = new Set([
  'mcp__cua_repl__js',
  'mcp__cua_repl__js_reset',
]);

/**
 * Brand-agnostic recognizer for the plan-explore "Plan" tool family. Matches
 * the plan-comment tools (RespondToComment, GetPlanComments) and their
 * code-review counterpart (GetReviewComments, which reuses RespondToComment
 * for replies) across the Claude MCP names (`mcp__<ns>__RespondToComment` or
 * bare `RespondToComment`) and the Codex dynamic-tool names
 * (`<ns>_respond_to_comment`) by suffix so they stay correct across brand
 * namespaces and all map to the `plan` family.
 */
function isPlanToolName(name: string): boolean {
  return (
    /RespondToComment$/.test(name) ||
    /GetPlanComments$/.test(name) ||
    /GetReviewComments$/.test(name) ||
    /respond_to_comment$/.test(name) ||
    /get_plan_comments$/.test(name) ||
    /get_review_comments$/.test(name)
  );
}

const EXACT_FAMILY_MAP: Record<string, PortalChatToolFamily> = {
  Read: 'read',
  ReadLines: 'read',
  Write: 'write',
  Edit: 'edit',
  file_change: 'edit',
  apply_patch: 'edit',
  Bash: 'bash',
  // Windows Claude sessions expose `PowerShell` instead of `Bash`; same
  // `{ command, description }` input, same shell family.
  PowerShell: 'bash',
  command: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  ToolSearch: 'glob',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  TaskList: 'todo',
  TaskGet: 'todo',
  TaskStop: 'todo',
  WebFetch: 'web',
  WebSearch: 'web',
  web_search: 'web',
  Task: 'agent',
  Agent: 'agent',
  SendMessage: 'agent',
  Workflow: 'agent',
  TaskOutput: 'agent',
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
 * Resolve the canonical tool family for a raw tool name. Returns
 * `'unknown'` when the tool is not recognised. The function is
 * deterministic — same input always produces the same family — so the
 * portal protocol can stamp the family value on the wire without
 * re-checking on the consumer side.
 */
export function getPortalChatToolFamily(
  toolName: string | null | undefined,
): PortalChatToolFamily {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return 'unknown';
  }
  if (isHistoricalDelegateWatchToolName(toolName)) return 'canopy';
  if (COMPUTER_USE_TOOL_NAMES.has(toolName)) {
    return 'computer-use';
  }
  if (isPlanToolName(toolName)) {
    return 'plan';
  }
  if (isCanopyImmediateTurnRestartToolName(toolName)) {
    return 'canopy';
  }
  const appAdvisorKey = getCanonicalAppAdvisorToolKey(toolName);
  if (
    appAdvisorKey === 'search_watchers' ||
    appAdvisorKey === 'watch_command' ||
    appAdvisorKey === 'schedule_wakeup' ||
    appAdvisorKey === 'setup_watchers' ||
    appAdvisorKey === 'watch_github_items'
  ) {
    return 'watcher';
  }
  // App Advisor's names for the Agent Ledger tools: every surface records
  // into the same Ledger, so they share the Ledger family below.
  if (appAdvisorKey !== null && isAppAdvisorLedgerToolKey(appAdvisorKey)) {
    return 'canopy';
  }
  if (isAppAdvisorToolName(toolName)) return 'app-advisor';
  // Pipeline-editor assistant tools, except AskUserQuestion which folds into
  // the shared ask-user family below (mirrors the renderer tool-display).
  const pipelineEditorKey = getCanonicalPipelineEditorToolKey(toolName);
  if (pipelineEditorKey !== null && pipelineEditorKey !== 'ask_user_question') {
    return 'pipeline-editor';
  }
  if (isCanopyAskUserToolName(toolName)) return 'ask-user';
  if (isCanopyGetScriptOutputToolName(toolName)) return 'script-output';
  const canopyKey = getCanonicalCanopyToolKey(toolName);
  // A spawn is agent work. Every other delegation tool is app plumbing and
  // counts with the app tools below.
  if (canopyKey === 'delegate_task') {
    return 'agent';
  }
  if (
    canopyKey === 'show_files' ||
    canopyKey === 'show_capabilities' ||
    canopyKey === 'show_visual' ||
    canopyKey === 'preview_visual' ||
    canopyKey === 'get_file_comments' ||
    canopyKey === 'respond_to_file_comment' ||
    canopyKey === 'search_actions' ||
    canopyKey === 'dispatch_action' ||
    canopyKey === 'get_git_preferences' ||
    canopyKey === 'get_github_pull_request_status' ||
    canopyKey === 'save_memory' ||
    canopyKey === 'search_memory' ||
    canopyKey === 'read_memory' ||
    canopyKey === 'set_auto_archive' ||
    canopyKey === 'set_work_entry_auto_delete' ||
    canopyKey === 'start_forked_agent' ||
    canopyKey === 'start_branched_agent' ||
    canopyKey === 'set_base_branch' ||
    isManagedDelegationAppToolKey(canopyKey)
  ) {
    return 'canopy';
  }
  if (canopyKey === 'read_pipeline_yaml') {
    return 'canopy';
  }
  if (
    canopyKey === 'search_watchers' ||
    canopyKey === 'watch_command' ||
    canopyKey === 'schedule_wakeup' ||
    canopyKey === 'setup_watchers' ||
    canopyKey === 'watch_github_items' ||
    canopyKey === 'delete_watchers'
  ) {
    return 'watcher';
  }
  if (
    canopyKey === 'get_code_graph_context' ||
    canopyKey === 'build_or_update_code_graph' ||
    canopyKey === 'query_code_graph' ||
    canopyKey === 'search_code_graph' ||
    canopyKey === 'explain_code_symbol' ||
    canopyKey === 'get_impact_radius' ||
    canopyKey === 'detect_changed_symbols' ||
    canopyKey === 'compare_change_impact' ||
    canopyKey === 'get_review_context'
  ) {
    return 'graph';
  }
  if (
    canopyKey === 'search_deferred_tools' ||
    canopyKey === 'load_deferred_tools'
  ) {
    return 'canopy';
  }
  // Ledger tools (three tools performing CRUD-style operations on structured
  // records) fold into the generic `canopy` bucket, mirroring the local
  // memory tools above rather than the larger watcher/code-graph groups.
  if (
    canopyKey === 'add_ledger_entry' ||
    canopyKey === 'search_ledger_entries' ||
    canopyKey === 'update_ledger_entry'
  ) {
    return 'canopy';
  }
  const exact = EXACT_FAMILY_MAP[toolName];
  if (exact) return exact;
  // Generic third-party MCP tools intentionally stay 'unknown' — they are
  // not Skill invocations, and the desktop renderer
  // (`getToolFamilyFromName` in @canopy/ui-shared tool-display.tsx) renders
  // them with the generic tool chrome.
  return 'unknown';
}
