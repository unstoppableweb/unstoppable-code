import {
  APP_ADVISOR_TOOL_REGISTRY,
  getCanonicalAppAdvisorToolKey,
  isAppAdvisorLedgerToolKey,
  type AppAdvisorLedgerToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  getCanopyInjectedAliases,
  getCanonicalCanopyToolKey,
  type CanopyInjectedToolDisplayName,
  type CanopyInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import { PIPELINE_EDITOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/pipeline-editor-tools';

/**
 * Codex's built-in ask-user tool name. It's NOT Canopy-injected — the
 * provider owns it — but the renderer normalises it into the same
 * AskUserQuestionCard UX as the Canopy-injected ask-user tools. Transport
 * plan §9: recognised ask-user aliases include `request_user_input`, so the
 * renderer helper layers this literal on top of the shared registry while
 * still pulling the injected aliases from a single source of truth.
 */
export const CODEX_BUILTIN_ASK_USER_TOOL_NAME = 'request_user_input';

/** All ask-user aliases the renderer should treat as a single UX card. */
export const ASK_USER_TOOL_ALIASES: readonly string[] = [
  ...getCanopyInjectedAliases('ask_user_question'),
  PIPELINE_EDITOR_TOOL_REGISTRY.ask_user_question.claudeToolName,
  PIPELINE_EDITOR_TOOL_REGISTRY.ask_user_question.codexToolName,
  CODEX_BUILTIN_ASK_USER_TOOL_NAME,
];

/** All script-output aliases (Canopy-injected only; no provider built-in). */
export const GET_SCRIPT_OUTPUT_TOOL_ALIASES: readonly string[] =
  getCanopyInjectedAliases('get_script_output');

export const SAVE_MEMORY_TOOL_ALIASES: readonly string[] =
  getCanopyInjectedAliases('save_memory');

export const SEARCH_MEMORY_TOOL_ALIASES: readonly string[] =
  getCanopyInjectedAliases('search_memory');

export const READ_MEMORY_TOOL_ALIASES: readonly string[] =
  getCanopyInjectedAliases('read_memory');

export const SHOW_VISUAL_TOOL_ALIASES: readonly string[] =
  getCanopyInjectedAliases('show_visual');

export const PREVIEW_VISUAL_TOOL_ALIASES: readonly string[] =
  getCanopyInjectedAliases('preview_visual');

/**
 * Every alias of an Agent Ledger tool: the injected tool's names (including
 * the Cursor CLI title) plus App Advisor's, which advertises the same tools
 * under its own namespace. They act on the same Ledger, so they share a UX.
 */
function getLedgerToolAliases(key: AppAdvisorLedgerToolKey): readonly string[] {
  return [
    ...getCanopyInjectedAliases(key),
    APP_ADVISOR_TOOL_REGISTRY[key].claudeToolName,
    APP_ADVISOR_TOOL_REGISTRY[key].codexToolName,
  ];
}

export const ADD_LEDGER_ENTRY_TOOL_ALIASES: readonly string[] =
  getLedgerToolAliases('add_ledger_entry');

export const SEARCH_LEDGER_ENTRIES_TOOL_ALIASES: readonly string[] =
  getLedgerToolAliases('search_ledger_entries');

export const UPDATE_LEDGER_ENTRY_TOOL_ALIASES: readonly string[] =
  getLedgerToolAliases('update_ledger_entry');

const ASK_USER_ALIAS_SET = new Set(ASK_USER_TOOL_ALIASES);
const GET_SCRIPT_OUTPUT_ALIAS_SET = new Set(GET_SCRIPT_OUTPUT_TOOL_ALIASES);
const SAVE_MEMORY_ALIAS_SET = new Set(SAVE_MEMORY_TOOL_ALIASES);
const SEARCH_MEMORY_ALIAS_SET = new Set(SEARCH_MEMORY_TOOL_ALIASES);
const READ_MEMORY_ALIAS_SET = new Set(READ_MEMORY_TOOL_ALIASES);
const ADD_LEDGER_ENTRY_ALIAS_SET = new Set(ADD_LEDGER_ENTRY_TOOL_ALIASES);
const SEARCH_LEDGER_ENTRIES_ALIAS_SET = new Set(
  SEARCH_LEDGER_ENTRIES_TOOL_ALIASES,
);
const UPDATE_LEDGER_ENTRY_ALIAS_SET = new Set(UPDATE_LEDGER_ENTRY_TOOL_ALIASES);

/**
 * True when the raw tool name refers to any recognised ask-user alias —
 * Claude (`mcp__canopy__AskUserQuestion`, legacy `AskUserQuestion`),
 * Codex dynamic (`canopy_ask_user_question`), or the Codex built-in
 * (`request_user_input`).
 */
export function isAskUserQuestionToolName(
  toolName: string | null | undefined,
): boolean {
  return typeof toolName === 'string' && ASK_USER_ALIAS_SET.has(toolName);
}

/**
 * True when the raw tool name refers to any recognised script-output alias.
 * The Canopy-injected script-output tool has no provider built-in equivalent.
 */
export function isGetScriptOutputToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' && GET_SCRIPT_OUTPUT_ALIAS_SET.has(toolName)
  );
}

export function isSaveMemoryToolName(
  toolName: string | null | undefined,
): boolean {
  return typeof toolName === 'string' && SAVE_MEMORY_ALIAS_SET.has(toolName);
}

export function isSearchMemoryToolName(
  toolName: string | null | undefined,
): boolean {
  return typeof toolName === 'string' && SEARCH_MEMORY_ALIAS_SET.has(toolName);
}

export function isReadMemoryToolName(
  toolName: string | null | undefined,
): boolean {
  return typeof toolName === 'string' && READ_MEMORY_ALIAS_SET.has(toolName);
}

export function isAddLedgerEntryToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' && ADD_LEDGER_ENTRY_ALIAS_SET.has(toolName)
  );
}

export function isSearchLedgerEntriesToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' &&
    SEARCH_LEDGER_ENTRIES_ALIAS_SET.has(toolName)
  );
}

export function isUpdateLedgerEntryToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' && UPDATE_LEDGER_ENTRY_ALIAS_SET.has(toolName)
  );
}

/** The Ledger tool an App Advisor Ledger name calls, or `null`. */
function getAppAdvisorLedgerToolKey(
  toolName: string,
): AppAdvisorLedgerToolKey | null {
  const key = getCanonicalAppAdvisorToolKey(toolName);
  return key !== null && isAppAdvisorLedgerToolKey(key) ? key : null;
}

/**
 * Normalise any recognised Canopy-injected alias to its canonical display
 * name. Returns `null` for tool names the renderer does not fold into a
 * Canopy UX row. The Codex built-in `request_user_input` normalises to
 * `AskUserQuestion` for label/icon parity, and App Advisor's Ledger tool
 * names to the Ledger tools' display names.
 */
export function normalizeCanopyToolDisplayName(
  toolName: string | null | undefined,
): CanopyInjectedToolDisplayName | null {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return null;
  }
  if (toolName === CODEX_BUILTIN_ASK_USER_TOOL_NAME) {
    return CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.displayName;
  }
  if (ASK_USER_ALIAS_SET.has(toolName)) {
    return CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.displayName;
  }
  const key =
    getCanonicalCanopyToolKey(toolName) ?? getAppAdvisorLedgerToolKey(toolName);
  if (!key) {
    return null;
  }
  return CANOPY_INJECTED_TOOL_REGISTRY[key].displayName;
}

/**
 * Resolve any recognised ask-user/script-output alias to the canonical
 * Canopy-injected key, or `{ builtin: 'request_user_input' }` when the
 * name is the Codex built-in (since that's not a Canopy-injected
 * capability). App Advisor's Ledger tool names resolve to the Ledger tools'
 * keys. Returns `null` for unrelated tool names.
 */
export function resolveCanopyOrBuiltinKey(
  toolName: string | null | undefined,
): CanopyInjectedToolKey | { builtin: 'request_user_input' } | null {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return null;
  }
  if (toolName === CODEX_BUILTIN_ASK_USER_TOOL_NAME) {
    return { builtin: 'request_user_input' };
  }
  if (ASK_USER_ALIAS_SET.has(toolName)) {
    return 'ask_user_question';
  }
  return (
    getCanonicalCanopyToolKey(toolName) ?? getAppAdvisorLedgerToolKey(toolName)
  );
}

// Re-export for callers that only want the display-name map.
export { CANOPY_INJECTED_TOOL_REGISTRY };
