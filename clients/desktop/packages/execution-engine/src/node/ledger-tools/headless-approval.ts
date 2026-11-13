import type { PermissionPreset } from '../../builtin-actions/agent-prompt/logic';
import type { LedgerToolKey } from './runtime';

/*
 * The approval of a headless pipeline step's Feed tool calls (CAN-6422): a
 * cloud runner's pipeline host, which has no chat session to prompt and no
 * person's approval rules. It decides from the step's preset, as headless
 * Cursor steps do (docs/tool-approvals.md), and matches what a desktop
 * pipeline step's approval session decides with no deny rule: its session
 * rules allow exactly the three Feed tools under every preset the step
 * runner exposes the tools to. Anything else fails closed.
 */

const FEED_TOOLS: ReadonlySet<LedgerToolKey> = new Set<LedgerToolKey>([
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
]);

/** The presets a pipeline step runs under; the step runner rejects others. */
const PRESETS: ReadonlySet<string> = new Set<PermissionPreset>([
  'none',
  'read_only',
  'dangerous_all',
  'plan',
]);

/**
 * Whether a headless step under `preset` may call `tool`. Only the three
 * Feed tools, and only under a preset the step runner knows; an unknown
 * tool or preset is denied.
 */
export function headlessLedgerToolAllowed(
  preset: string,
  tool: LedgerToolKey | undefined,
): boolean {
  return tool !== undefined && FEED_TOOLS.has(tool) && PRESETS.has(preset);
}
