import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CODE_GRAPH_INJECTED_TOOL_KEYS,
  LEDGER_INJECTED_TOOL_KEYS,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalMode } from '@canopy/desktop-shared/types';

// Only unattended worker Plan permission presets use this allowlist.
// Interactive planning tools follow the session's ordinary approval policy.
export const CLAUDE_PLAN_MODE_READ_ONLY_TOOLS = new Set([
  'Glob',
  'Grep',
  'NotebookRead',
  'Read',
  'WebFetch',
  'WebSearch',
  ...CODE_GRAPH_INJECTED_TOOL_KEYS.filter(
    (key) => key !== 'build_or_update_code_graph',
  ).map((key) => CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName),
]);

const CLAUDE_PLAN_MODE_BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(
  LEDGER_INJECTED_TOOL_KEYS.map(
    (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName,
  ),
);

/**
 * Plan mode's explicit bookkeeping exception: the Ledger tools stay usable
 * while planning, so an agent can record intended tasks and decisions. Plan
 * mode adds no denial for them; like every interactive tool they follow the
 * session's approval mode, and the native `plan` permission mode still keeps
 * source edits and execution out. Only these three tools qualify.
 */
export function isClaudePlanModeBookkeepingTool(toolName: string): boolean {
  return CLAUDE_PLAN_MODE_BOOKKEEPING_TOOLS.has(toolName);
}

/** Context a Plan mode bookkeeping call carries back to the model. */
export const CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT =
  'Plan mode: this Feed call is bookkeeping and is allowed while planning. It does not permit editing files or running commands, so keep planning.';

/**
 * Maps a Canopy approval mode (plus the orthogonal plan-mode toggle) to the
 * Claude Agent SDK's `PermissionMode`. Plan mode always wins regardless of
 * approval mode for the native planning workflow. Interactive tool decisions
 * remain governed by the session's approval mode through the approval hooks.
 */
export function claudePermissionModeFor(
  mode: ApprovalMode,
  planMode: boolean,
): PermissionMode {
  if (planMode) {
    return 'plan';
  }
  if (mode === 'full-access') {
    return 'bypassPermissions';
  }
  // Both Ask and Auto must route every governed tool through `canUseTool` so
  // Canopy's deny rules and Auto workspace containment remain authoritative.
  return 'default';
}

export {
  approvalFileDisplayPath,
  isContainedGlobPattern,
  guardMappedReadPath,
  approvalCheckForClaudeTool,
} from '@canopy/desktop-shared/node/approvals/tool-checks';
