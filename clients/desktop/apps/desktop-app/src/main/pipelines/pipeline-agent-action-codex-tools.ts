import type { DynamicToolCallResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import type { CodexHostToolPolicy } from '@canopy/execution-engine/node/codex-runtime/thread-handle';
import { defineCodexFunctionToolSpec } from '../codex/dynamic-tool-spec';
import type {
  PipelineAgentActionToolDefinition,
  PipelineAgentActionToolKey,
} from '../canopy-tools/pipeline-agent-actions';

/*
 * A Codex pipeline step's agent action tools (CAN-7742), merged with its
 * Ledger tools: Codex takes one host tool policy per turn. Kept apart from
 * the shared leaf module so that stays free of Codex imports.
 */

/** What the merge uses of the attempt's agent action seam. */
export interface PipelineAgentActionCodexSeam {
  readonly definitions: readonly PipelineAgentActionToolDefinition[];
  authorize(
    key: PipelineAgentActionToolKey,
    toolUseId: string,
  ): Promise<boolean>;
  execute(
    key: string,
    args: unknown,
    context: { readonly toolUseId: string; readonly signal?: AbortSignal },
  ): Promise<{ readonly text: string; readonly isError?: boolean }>;
}

/** The two restricted specs as Codex dynamic tools. */
export function pipelineAgentActionCodexSpecs(
  definitions: readonly PipelineAgentActionToolDefinition[],
): DynamicToolSpec[] {
  return definitions.map((definition) =>
    defineCodexFunctionToolSpec({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }),
  );
}

/**
 * The Ledger specs and policy plus the action tools. Calls route by tool
 * name: Ledger tools to the Ledger policy, the two action tools to the seam
 * after the same thread and namespace checks and the step's approval, and
 * any other name is refused. `isLive` reports whether the attempt is still
 * open; a call after it closes runs nothing.
 */
export function pipelineAgentActionCodexPolicy(
  ledger: {
    readonly specs: DynamicToolSpec[];
    readonly policy: (threadId: string) => CodexHostToolPolicy;
  },
  actions: PipelineAgentActionCodexSeam,
  isLive: () => boolean,
): {
  readonly specs: DynamicToolSpec[];
  readonly policy: (threadId: string) => CodexHostToolPolicy;
} {
  const actionSpecs = pipelineAgentActionCodexSpecs(actions.definitions);
  const keyOf = (name: string): PipelineAgentActionToolKey | undefined =>
    actions.definitions.find((definition) => definition.name === name)?.key;
  return {
    specs: [...ledger.specs, ...actionSpecs],
    policy: (threadId): CodexHostToolPolicy => {
      const ledgerPolicy = ledger.policy(threadId);
      const ownCall = (call: {
        readonly threadId: string;
        readonly namespace: string | null;
      }): boolean => call.threadId === threadId && call.namespace === null;
      return {
        allowedTools: [
          ...ledgerPolicy.allowedTools,
          ...actionSpecs.map(({ name }) => ({ namespace: null, tool: name })),
        ],
        authorize: async (call, signal): Promise<boolean> => {
          const key = keyOf(call.tool);
          if (key === undefined) return ledgerPolicy.authorize(call, signal);
          if (signal.aborted || !ownCall(call) || !isLive()) return false;
          return (
            (await actions.authorize(key, `codex-${call.callId}`)) &&
            !signal.aborted
          );
        },
        execute: async (call, signal): Promise<DynamicToolCallResponse> => {
          const key = keyOf(call.tool);
          if (key === undefined) return ledgerPolicy.execute(call, signal);
          if (signal.aborted || !ownCall(call) || !isLive())
            return { success: false, contentItems: [] };
          const result = await actions.execute(key, call.arguments, {
            toolUseId: `codex-${call.callId}`,
            signal,
          });
          return {
            success: result.isError !== true,
            contentItems: [{ type: 'inputText', text: result.text }],
          };
        },
        ...(ledgerPolicy.timeoutMs === undefined
          ? {}
          : { timeoutMs: ledgerPolicy.timeoutMs }),
      };
    },
  };
}
