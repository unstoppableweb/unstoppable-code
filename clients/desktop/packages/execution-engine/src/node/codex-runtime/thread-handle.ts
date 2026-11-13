import type { CodexTransportErrorDetail } from '@canopy/execution-engine/agent-failures/codex-transport-failure';
import type { HelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import type { JsonValue } from './generated/serde_json/JsonValue';
import type { TurnStartParams } from './generated/v2/TurnStartParams';
import type { UserInput } from './generated/v2/UserInput';
import type { CodexErrorInfo } from './generated/v2/CodexErrorInfo';
import type { DynamicToolCallParams } from './generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from './generated/v2/DynamicToolCallResponse';
import { projectCodexThreadItem } from './thread-item-projection';
import type { ChatInputAdmission } from '@canopy/protocol/portal/input-delivery';

export interface CodexRuntimeEvent {
  method: string;
  params: Record<string, unknown>;
}

const CODEX_AGENT_ACTIVITY_ITEM_TYPES = new Set([
  'collabAgentToolCall',
  'collab_agent_tool_call',
  'commandExecution',
  'command_execution',
  'dynamicToolCall',
  'dynamic_tool_call',
  'fileChange',
  'file_change',
  'imageGeneration',
  'image_generation',
  'imageView',
  'image_view',
  'mcpToolCall',
  'mcp_tool_call',
  'subAgentActivity',
  'subagent_activity',
  'sub_agent_activity',
  'webSearch',
  'web_search',
]);

const FALLBACK_TRANSCRIPT_ITEM_TYPES: Record<string, string> = {
  contextCompaction: 'context_compaction',
  enteredReviewMode: 'entered_review_mode',
  exitedReviewMode: 'exited_review_mode',
  hookPrompt: 'hook_prompt',
  imageGeneration: 'image_generation',
  imageView: 'image_view',
  subAgentActivity: 'subagent_activity',
  userMessage: 'user_message',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectThreadItem(value: unknown): unknown {
  const projected = projectCodexThreadItem(value);
  if (projected || !isRecord(value) || typeof value.type !== 'string') {
    return projected ?? value;
  }
  return {
    ...value,
    type: FALLBACK_TRANSCRIPT_ITEM_TYPES[value.type] ?? value.type,
  };
}

/**
 * Project an app-server JSON-RPC notification into the provider-neutral Codex
 * JSONL shape consumed by pipeline transcripts and failure classification.
 */
export function projectCodexRuntimeEvent(
  event: CodexRuntimeEvent,
): Record<string, unknown> {
  if (event.method === 'item/completed') {
    return {
      ...event.params,
      type: 'item.completed',
      item: projectThreadItem(event.params.item),
    };
  }
  if (event.method === 'turn/completed') {
    const turn = isRecord(event.params.turn) ? event.params.turn : undefined;
    if (turn?.status === 'failed') {
      return {
        ...event.params,
        type: 'turn.failed',
        error: turn.error,
      };
    }
    return {
      ...event.params,
      type: 'turn.completed',
    };
  }
  if (event.method === 'thread/tokenUsage/updated') {
    // The raw camelCase `tokenUsage` payload is dropped: every consumer reads
    // the normalized `usage` record, and the interactive client emits the same
    // usage-only shape, so carrying both would duplicate the numbers on every
    // streamed transcript line.
    const { tokenUsage, ...params } = event.params;
    return {
      ...params,
      type: 'thread.token_usage.updated',
      usage: projectTokenUsage(tokenUsage),
    };
  }
  return {
    ...event.params,
    type: event.method.replace(/\//g, '.'),
  };
}

function readFiniteNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Project a raw app-server `tokenUsage` payload into the canonical
 * snake_case usage record interactive Codex transcripts persist
 * (`thread.token_usage.updated`), so pipeline transcript consumers — the
 * rich viewer's context meter and audit-trail token accounting — read the
 * same shape from both surfaces. `last` carries the latest upstream response
 * completion; `total` carries the cumulative thread snapshot used to derive
 * audit-entry deltas without double counting repeated notifications.
 */
function projectTokenUsage(tokenUsage: unknown): Record<string, unknown> {
  const usageRecord = isRecord(tokenUsage) ? tokenUsage : undefined;
  const last =
    usageRecord && isRecord(usageRecord.last) ? usageRecord.last : undefined;
  const total =
    usageRecord && isRecord(usageRecord.total) ? usageRecord.total : undefined;
  const usage: Record<string, unknown> = {};
  const contextTokens = readFiniteNumber(last, 'totalTokens');
  if (contextTokens !== undefined) usage.context_tokens = contextTokens;
  const contextWindow = readFiniteNumber(usageRecord, 'modelContextWindow');
  if (contextWindow !== undefined) usage.context_window = contextWindow;
  const inputTokens = readFiniteNumber(last, 'inputTokens');
  if (inputTokens !== undefined) usage.input_tokens = inputTokens;
  const cachedInputTokens = readFiniteNumber(last, 'cachedInputTokens');
  if (cachedInputTokens !== undefined) {
    usage.cached_input_tokens = cachedInputTokens;
  }
  const outputTokens = readFiniteNumber(last, 'outputTokens');
  if (outputTokens !== undefined) usage.output_tokens = outputTokens;
  const reasoningOutputTokens = readFiniteNumber(last, 'reasoningOutputTokens');
  if (reasoningOutputTokens !== undefined) {
    usage.reasoning_output_tokens = reasoningOutputTokens;
  }
  const cumulativeInputTokens = readFiniteNumber(total, 'inputTokens');
  if (cumulativeInputTokens !== undefined) {
    usage.cumulative_input_tokens = cumulativeInputTokens;
  }
  const cumulativeCachedInputTokens = readFiniteNumber(
    total,
    'cachedInputTokens',
  );
  if (cumulativeCachedInputTokens !== undefined) {
    usage.cumulative_cached_input_tokens = cumulativeCachedInputTokens;
  }
  const cumulativeOutputTokens = readFiniteNumber(total, 'outputTokens');
  if (cumulativeOutputTokens !== undefined) {
    usage.cumulative_output_tokens = cumulativeOutputTokens;
  }
  const cumulativeReasoningOutputTokens = readFiniteNumber(
    total,
    'reasoningOutputTokens',
  );
  if (cumulativeReasoningOutputTokens !== undefined) {
    usage.cumulative_reasoning_output_tokens = cumulativeReasoningOutputTokens;
  }
  return usage;
}

/**
 * Whether a `thread/tokenUsage/updated` notification belongs to a thread other
 * than `threadId`.
 *
 * A thread handle receives notifications for the subagent threads registered
 * against it and forwards them to `onEvent` before applying its own root-thread
 * guard. Callers that feed projected events into usage accounting must drop the
 * foreign ones themselves, or child-thread usage overwrites the root thread's
 * audit token counters and context meter. Mirrors the guard the interactive
 * app-server client applies before emitting `thread.token_usage.updated`.
 */
export function isForeignThreadTokenUsageEvent(
  event: CodexRuntimeEvent,
  threadId: string,
): boolean {
  return (
    event.method === 'thread/tokenUsage/updated' &&
    event.params.threadId !== threadId
  );
}

/**
 * Whether projected Codex transcript events contain semantic agent work.
 * Lifecycle notifications alone do not count; completed assistant output,
 * reasoning/plans, and tool/file activity do.
 */
export function codexTranscriptEventsHaveAgentActivity(
  events: readonly unknown[],
): boolean {
  return events.some((event) => {
    if (
      !isRecord(event) ||
      (event.type !== 'item.started' && event.type !== 'item.completed')
    ) {
      return false;
    }
    const item = isRecord(event.item) ? event.item : undefined;
    if (!item || typeof item.type !== 'string') {
      return false;
    }
    if (
      item.type === 'agent_message' ||
      item.type === 'agentMessage' ||
      item.type === 'reasoning' ||
      item.type === 'plan'
    ) {
      return typeof item.text === 'string' && item.text.trim().length > 0;
    }
    return CODEX_AGENT_ACTIVITY_ITEM_TYPES.has(item.type);
  });
}

export interface CodexMcpElicitationCall {
  serverName: string;
  toolName: string;
  arguments: JsonValue;
  normalizedArguments: string;
  approvalKind: string;
}

export interface CodexMcpToolCallContext {
  id: string;
  threadId: string;
  turnId?: string;
  serverName: string;
  toolName: string;
  arguments: JsonValue;
  normalizedArguments: string;
}

export interface CodexMcpElicitationEvaluation {
  approved: boolean;
  externalMutation: boolean;
}

export interface CodexMcpElicitationPolicy {
  allowExternalMutation: boolean;
  evaluate(
    call: CodexMcpElicitationCall,
    signal?: AbortSignal,
  ): CodexMcpElicitationEvaluation | Promise<CodexMcpElicitationEvaluation>;
}

export function createHeadlessMcpElicitationPolicy(options: {
  allowedServers: readonly string[];
  allowExternalMutation: boolean;
}): CodexMcpElicitationPolicy {
  const allowedServers = new Set(options.allowedServers);
  return {
    allowExternalMutation: options.allowExternalMutation,
    evaluate: (
      call: CodexMcpElicitationCall,
    ): CodexMcpElicitationEvaluation => ({
      approved:
        call.approvalKind === 'mcp_tool_call' &&
        allowedServers.has(call.serverName) &&
        call.toolName.length > 0 &&
        call.normalizedArguments.length > 0,
      // Headless callers cannot ask a user to classify an arbitrary selected
      // MCP operation. Conservatively treat every call as an external
      // mutation; only an explicitly mutation-capable permission preset may
      // accept it.
      externalMutation: true,
    }),
  };
}

export interface CodexRunTurnRequest extends Omit<
  TurnStartParams,
  'threadId' | 'input'
> {
  input: UserInput[];
  signal?: AbortSignal;
  startupTimeoutMs?: number;
  totalTimeoutMs?: number;
  onEvent?: (event: CodexRuntimeEvent) => void | Promise<void>;
  mcpElicitationPolicy?: CodexMcpElicitationPolicy;
  /** Host-only opt-in. Omission preserves the default dynamic-tool denial. */
  hostToolPolicy?: CodexHostToolPolicy;
  /** Host approval bridge; omitted policies retain fail-closed behavior. */
  nativeApprovalPolicy?: (
    method: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

/**
 * Whether `value` has the fields {@link DynamicToolCallParams} declares, so a
 * tool call that crossed a boundary can reach a {@link CodexHostToolPolicy}
 * (CAN-5095).
 */
export function isDynamicToolCallParams(
  value: unknown,
): value is DynamicToolCallParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const call: Record<string, unknown> = { ...value };
  return (
    typeof call.threadId === 'string' &&
    typeof call.turnId === 'string' &&
    typeof call.callId === 'string' &&
    (call.namespace === null || typeof call.namespace === 'string') &&
    typeof call.tool === 'string' &&
    'arguments' in call
  );
}

export interface CodexHostToolPolicy {
  readonly allowedTools: readonly {
    readonly namespace: string | null;
    readonly tool: string;
  }[];
  /** Hosts bridge this callback to their existing approval-policy service. */
  authorize(call: DynamicToolCallParams, signal: AbortSignal): Promise<boolean>;
  execute(
    call: DynamicToolCallParams,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResponse>;
  /** Optional deadline covering approval and execution. Omitted, a call runs
   * until it settles or the turn's owner ends it. */
  readonly timeoutMs?: number;
}

export interface CodexTurnOutcome<T = unknown> {
  status: 'completed' | 'interrupted' | 'failed';
  threadId: string;
  turnId?: string;
  finalText: string;
  structured?: T;
  usage: HelperUsage;
  proposedPlanText?: string;
  error?: string;
  /** The runtime's classification of `error`, when the turn reported one. */
  errorInfo?: CodexErrorInfo;
  /**
   * Set when the local app-server transport failed the turn (an unanswered
   * request, a shared restart for another turn, a thread still closing). The
   * `error` string alone cannot carry it.
   */
  transportFailure?: CodexTransportErrorDetail;
}

export interface CodexThreadHandle {
  readonly threadId: string;
  readonly capabilitySnapshotId: string;
  runTurn(request: CodexRunTurnRequest): Promise<CodexTurnOutcome>;
  submitSteeringInput(
    text: string,
    attemptId: string,
    expectedTurnId?: string,
  ): Promise<ChatInputAdmission>;
  injectItems(items: JsonValue[]): Promise<void>;
  interrupt(): Promise<void>;
  unsubscribe(): Promise<void>;
  delete(): Promise<void>;
}
