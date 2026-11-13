import {
  isLedgerInjectedToolKey,
  type CanopyInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';

/**
 * Memory-tool exposure for a `claude-worker` MCP route. Workers always run
 * Claude with `bypassPermissions`, so a worker's non-mutating posture is
 * enforced entirely by restricting which tools exist; the Canopy memory tools
 * must honor the same posture or a report-only/read-only worker could still
 * persist durable memory writes through `SaveMemory`.
 */
export type ClaudeWorkerMemoryToolExposure =
  | 'read-write'
  | 'read-only'
  | 'none';

/**
 * The subset of a worker's launch permission that determines memory-tool
 * exposure. Structurally compatible with `ClaudeTerminalPermission`.
 */
export interface ClaudeWorkerMemoryToolPermissionInput {
  permissionMode?: 'plan' | 'acceptEdits' | 'bypassPermissions';
  tools?: string[];
}

/**
 * Derives a worker's memory-tool exposure from its launch permission, matching
 * how the worker permission presets are constructed (`mapWorkerPermission` for
 * pipeline `agent-prompt`/`agent-resume` steps, the structured-helper
 * read-only/report-only permissions, and the summary helpers):
 *
 * - `plan` mode is read-only by mode, so it may search/read but never save.
 * - An undefined `tools` list means the full built-in set exists
 *   (`dangerous_all` or the fully-permissive default), so all memory tools are
 *   exposed.
 * - A non-empty restricted `tools` list is how read-only-by-construction is
 *   enforced (`read_only`), so `SearchMemory` and `ReadMemory` are exposed.
 * - An empty `tools` list (`none` and the report-only helpers) exposes
 *   no memory tools.
 */
export function resolveClaudeWorkerMemoryToolExposure(
  permission?: ClaudeWorkerMemoryToolPermissionInput,
): ClaudeWorkerMemoryToolExposure {
  if (permission?.permissionMode === 'plan') {
    return 'read-only';
  }
  if (permission?.tools === undefined) {
    return 'read-write';
  }
  return permission.tools.length > 0 ? 'read-only' : 'none';
}

/**
 * Whether a Canopy-injected tool may be advertised and dispatched on a
 * `claude-worker` route with the given memory-tool exposure. The Agent Ledger
 * tools exist only on a pipeline agent's route, whose session passed the
 * Ledger exposure gate (`ledgerTools`); a background helper's never lists
 * them (E05). Other tools are unaffected.
 */
export function isClaudeWorkerToolExposed(
  key: CanopyInjectedToolKey,
  exposure: ClaudeWorkerMemoryToolExposure,
  ledgerTools = false,
): boolean {
  if (isLedgerInjectedToolKey(key)) {
    return ledgerTools;
  }
  if (key === 'save_memory') {
    return exposure === 'read-write';
  }
  if (key === 'search_memory' || key === 'read_memory') {
    return exposure !== 'none';
  }
  return true;
}
