import { CANOPY_INJECTED_TOOL_REGISTRY } from '../../lib/canopy-injected-tools';
import type { DynamicToolCallParams } from '../codex-runtime/generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '../codex-runtime/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from '../codex-runtime/generated/v2/DynamicToolSpec';
import type { CodexHostToolPolicy } from '../codex-runtime/thread-handle';
import { buildLedgerCodexDynamicToolSpecs } from './definitions';
import type { LedgerToolKey, LedgerToolsRuntime } from './runtime';

/*
 * A pipeline step's Feed tools as Codex dynamic tools, for every host that
 * runs them: Electron main for desktop runs, and the pipeline runner for
 * cloud runs (CAN-6422). The host supplies its approval of each call.
 */

const LEDGER_TOOL_KEYS: readonly LedgerToolKey[] = [
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
];

/**
 * The attempt's Ledger tools as Codex dynamic tools: the specs a new thread
 * starts with and, per turn, the host policy that runs them. Only calls on
 * the step's own thread reach the attempt's binding, and each passes the
 * host's approval first, as a native chat's injected tools do.
 */
export function ledgerCodexToolPolicy(
  tools: LedgerToolsRuntime,
  approve: (
    call: DynamicToolCallParams,
    tool: LedgerToolKey,
  ) => Promise<boolean>,
): {
  readonly specs: DynamicToolSpec[];
  readonly policy: (threadId: string) => CodexHostToolPolicy;
} {
  const specs = buildLedgerCodexDynamicToolSpecs();
  const keyOf = (name: string): LedgerToolKey | undefined =>
    LEDGER_TOOL_KEYS.find(
      (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].codexToolName === name,
    );
  return {
    specs,
    policy: (threadId): CodexHostToolPolicy => ({
      allowedTools: specs.map(({ name }) => ({ namespace: null, tool: name })),
      authorize: async (call, signal): Promise<boolean> => {
        const key = keyOf(call.tool);
        if (
          signal.aborted ||
          call.threadId !== threadId ||
          call.namespace !== null ||
          key === undefined
        ) {
          return false;
        }
        return (await approve(call, key)) && !signal.aborted;
      },
      execute: async (call, signal): Promise<DynamicToolCallResponse> => {
        const key = keyOf(call.tool);
        if (
          signal.aborted ||
          call.namespace !== null ||
          call.threadId !== threadId ||
          key === undefined
        ) {
          return { success: false, contentItems: [] };
        }
        // Codex repeats the thread, turn and call IDs for one call, so a
        // Ledger key derived from them dedupes its retries.
        const result = await tools.execute(key, call.arguments, {
          invocationId: `codex:${call.threadId}:${call.turnId}:${call.callId}`,
          signal,
        });
        return {
          success: result.isError !== true,
          contentItems: [{ type: 'inputText', text: result.text }],
        };
      },
    }),
  };
}
