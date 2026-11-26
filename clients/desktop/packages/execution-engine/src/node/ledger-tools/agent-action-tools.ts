import {
  WORKER_PIPELINE_OWNER_AGENT_ACTION_NOT_SENT_TEXT,
  WORKER_PIPELINE_OWNER_AGENT_ACTION_OUTCOME_UNKNOWN_TEXT,
  type WorkerPipelineOwnerAgentActionToolKey,
} from '@canopy/protocol/canopy-core';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '../../lib/canopy-injected-tools';
import type { JsonValue } from '../codex-runtime/generated/serde_json/JsonValue';
import type { DynamicToolCallResponse } from '../codex-runtime/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from '../codex-runtime/generated/v2/DynamicToolSpec';
import type { CodexHostToolPolicy } from '../codex-runtime/thread-handle';
import type { LedgerToolsMcpExtraTools } from './mcp-route';

/*
 * A daemon-hosted pipeline step's agent action tools (CAN-7742): the
 * SearchActions and DispatchAction definitions Electron main answered
 * `owner.agentActions.open` with, served beside the step's Feed tools. Every
 * call runs in Electron main over `owner.agentActions.call`; the daemon never
 * publishes itself. Main restricts them to posting a code review as the
 * GitHub App and runs each with the attempt's own scope.
 */

/** One forwarded call's answer, as a tool result. */
export interface PipelineAgentActionResult {
  readonly text: string;
  readonly isError?: boolean;
}

/** An attempt's agent action tools as the owner answered them. */
export interface PipelineAgentActionToolsHandle {
  readonly definitions: readonly {
    readonly key: WorkerPipelineOwnerAgentActionToolKey;
    readonly description: string;
    readonly inputSchema: JsonValue;
  }[];
  /**
   * Forwards one call to the owner. Settles with the owner's answer, or
   * with the not-sent or outcome-unknown answer; never throws.
   */
  call(
    key: WorkerPipelineOwnerAgentActionToolKey,
    args: unknown,
    invocationId: string,
    signal: AbortSignal,
  ): Promise<PipelineAgentActionResult>;
}

/** A call that never reached the owner: nothing was posted. */
export const AGENT_ACTION_NOT_SENT: PipelineAgentActionResult = {
  text: WORKER_PIPELINE_OWNER_AGENT_ACTION_NOT_SENT_TEXT,
  isError: true,
};

/** A call whose answer was lost after it was sent: it may have posted. */
export const AGENT_ACTION_OUTCOME_UNKNOWN: PipelineAgentActionResult = {
  text: WORKER_PIPELINE_OWNER_AGENT_ACTION_OUTCOME_UNKNOWN_TEXT,
  isError: true,
};

/**
 * How a forwarded call that was sent but never answered reads: a dispatch may
 * have posted, so it must not be posted again another way; a search posts
 * nothing, so it reads as unavailable.
 */
export function agentActionLostAnswer(
  key: WorkerPipelineOwnerAgentActionToolKey,
): PipelineAgentActionResult {
  return key === 'dispatch_action'
    ? AGENT_ACTION_OUTCOME_UNKNOWN
    : AGENT_ACTION_NOT_SENT;
}

/** The two tools on a Claude subprocess's loopback Feed route. */
export function agentActionMcpTools(
  handle: PipelineAgentActionToolsHandle,
): LedgerToolsMcpExtraTools {
  const tools = handle.definitions.map((definition) => ({
    key: definition.key,
    name: CANOPY_INJECTED_TOOL_REGISTRY[definition.key].displayName,
    claudeToolName:
      CANOPY_INJECTED_TOOL_REGISTRY[definition.key].claudeToolName,
    description: definition.description,
    inputSchema: definition.inputSchema,
  }));
  return {
    tools,
    call: (name, args, context) => {
      const tool = tools.find((candidate) => candidate.name === name);
      return tool === undefined
        ? Promise.resolve(AGENT_ACTION_NOT_SENT)
        : handle.call(tool.key, args, context.invocationId, context.signal);
    },
  };
}

/**
 * The step's Feed tools merged with the two action tools, for a Codex step:
 * Codex takes one policy per turn. Action calls pass the same thread and
 * namespace checks as Feed calls; main applies the step's approval. Any
 * other name goes to the Feed policy, which refuses it.
 */
export function mergeAgentActionCodexTools(
  ledger: {
    readonly specs: DynamicToolSpec[];
    readonly policy: (threadId: string) => CodexHostToolPolicy;
  },
  handle: PipelineAgentActionToolsHandle,
  isLive: () => boolean,
): {
  readonly specs: DynamicToolSpec[];
  readonly policy: (threadId: string) => CodexHostToolPolicy;
} {
  const actionSpecs: DynamicToolSpec[] = handle.definitions.map(
    (definition) => ({
      type: 'function',
      name: CANOPY_INJECTED_TOOL_REGISTRY[definition.key].codexToolName,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }),
  );
  const keyOf = (
    name: string,
  ): WorkerPipelineOwnerAgentActionToolKey | undefined =>
    handle.definitions.find(
      (definition) =>
        CANOPY_INJECTED_TOOL_REGISTRY[definition.key].codexToolName === name,
    )?.key;
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
          return !signal.aborted && ownCall(call) && isLive();
        },
        execute: async (call, signal): Promise<DynamicToolCallResponse> => {
          const key = keyOf(call.tool);
          if (key === undefined) return ledgerPolicy.execute(call, signal);
          const result =
            signal.aborted || !ownCall(call) || !isLive()
              ? AGENT_ACTION_NOT_SENT
              : await handle.call(
                  key,
                  call.arguments,
                  `codex-${call.callId}`,
                  signal,
                );
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
