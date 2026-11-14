import {
  CHILD_TOOLS_ENDED_EVENT_TYPE,
  indexCodexAgentCallBlocks,
  readChildToolLivenessStamp,
  shouldCloseToolUseMessage,
  type ChildToolCloseContext,
  type ChildToolLiveness,
} from './child-tool-liveness';
import { parseOpenCodeReportedUsage } from '@canopy/protocol/portal';
import { applyDelegationTranscriptEvent } from './delegation-transcript';
import {
  parseClaudeAssistantBlocks,
  parseClaudeToolResults,
} from './claude-content-normalizers';
import { isClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';
import { CANOPY_DELEGATION_EVENT_TYPE } from '@canopy/protocol/delegation';
import { claudeSessionWritesLostMessage } from './claude-session-writes-lost';
import { parseCursorReportedUsage } from './cursor-usage';
import { parseAntigravityTurnUsage } from './antigravity-usage';
import { LAYOUT_BLOCK_TYPES } from './transcript-fingerprint';
import { applyAssistantPatches } from './assistant-snapshot';
import { normalizeCodexNeutralItem } from './codex-neutral-item';
import { isUserTurnBoundary } from './turn-boundary';
import { normalizeEpochMs } from './epoch-ms';
import {
  CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE,
  CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE,
} from '../types';
import {
  isClaudeModsSkippedBlock,
  isClaudeModsSkippedEntry,
} from './claude-mods-skipped';
import {
  applyTaskUpdateItem,
  parseTaskCreateItem,
  parseTodoItems,
} from './todo-parser';
import type {
  AgentProviderType,
  AgentUsage,
  AiCreditsNoBillingSourceState,
  ChatInterfaceMode,
  ChatModel,
  ChatTabUsage,
  LlmProviderUsageLimitBannerState,
  CodexAgentCallBlock,
  CodexAgentReceiver,
  CodexAgentState,
  AccountProxySwitchBlock,
  ClaudeModsSkippedBlock,
  ClaudeModsSkippedEntry,
  CompactionInfoBlock,
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
  TodoItem,
} from '../types';
import {
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG,
  parseCanopyProxyError,
} from '@canopy/protocol/llm-gateway';
import {
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  CANOPY_MODEL_ACCESS_FAILURE_FIELD,
  isCanopyAuthFailureEventData,
  readCodexAccountModelAccessFailure,
  type CodexAccountModelAccessFailure,
} from '@canopy/protocol/auth-recovery';
import { attachAuthFailureToMessages } from './auth-failure-attach';
import {
  getModelContextWindow,
  getModelDisplayName,
  resolveKnownModel,
  resolveModelAlias,
  resolveRuntimeModel,
} from './model-resolver';
import {
  codexDynamicToolOutput,
  codexDynamicToolOutputChunks,
  codexDynamicToolOutputSource,
} from './codex-dynamic-tool-results';
import {
  withCodexImagePreviewNotices,
  withoutPreviewVisualImages,
} from './codex-tool-images';
import {
  codexMcpToolResult,
  codexMcpToolResultChunks,
  codexOutputChunks,
  codexOutputSequence,
  codexOutputText,
} from './codex-mcp-tool-results';
import {
  claudeResultErrorMessage,
  isClaudeAuthenticationFailureMessage,
} from './provider-errors';
import { stripMemoryCitationTags } from './memory-citation';
import { deriveRuntimeChatMessageId } from '../portal/persisted-chat-projection';

// `ChatBlock`/`ChatMessage` are exact aliases of the persisted transcript
// shapes (`apps/desktop-app/.../stores/chatStore.ts` declares them as such);
// the browser-safe package works directly on the persisted types.
type ChatBlock = PersistedChatBlock;
type ChatMessage = PersistedChatMessage;

export interface TranscriptReducerState {
  messages: ChatMessage[];
  status: 'idle' | 'streaming' | 'error';
  error: string | null;
  planMode: boolean;
  providerType?: AgentProviderType;
  sdkSessionId?: string;
  model?: ChatModel;
  usage?: ChatTabUsage;
  agentUsage?: Record<string, AgentUsage>;
  currentTodos?: TodoItem[];
  currentTaskTodos?: TodoItem[];
  lastEventAt?: number;
  /**
   * Sanitized metadata for the provider usage-limit banner, set when a
   * structured rate-limit transcript event is detected. Banner-only: it never
   * alters `messages`. The chat surface reconciles this against
   * `dismissedLlmProviderUsageLimitBannerKey` to decide visibility.
   */
  llmProviderUsageLimitBanner?: LlmProviderUsageLimitBannerState;
  /** Marked hosted 402 metadata, persisted separately from transcript copy. */
  aiCreditsNoBillingSource?: AiCreditsNoBillingSourceState;
  /**
   * Per-thread Codex metadata captured from `thread.started` events. Keyed by
   * Codex thread id. Lets the renderer surface subagent identity and configuration even
   * when the originating `collabAgentToolCall` item didn't carry them.
   */
  codexThreads?: Record<string, CodexAgentReceiver & { source?: string }>;
}

export interface TranscriptReducerOptions {
  /** Host's bounded capture budget, including one overflow sentinel. */
  toolBlockCaptureLimit?: number;
  /** Event-local source slot, after canonical row identity is resolved. */
  onToolBlock?: (
    sourceToken: string,
    row: PersistedChatMessage,
    blockOrdinal: number,
    previousMessages: readonly PersistedChatMessage[],
  ) => void;
  childToolLiveness: ChildToolLiveness;
  now: number;
  createMessageId: () => string;
  turnStartedAt?: number;
  turnCompletedAt?: number | null;
  useNowAsTurnTimestamp?: boolean;
  aiCreditsRouted?: boolean;
  /** Display-only reducers keep bounded Codex tool-result previews; stored chats keep full output. */
  codexToolResults?: 'canonical' | 'preview';
  /**
   * Storage format the reduced rows are written to. Absent, 2 and 3 keep the
   * legacy rows. Format 4 keeps `function_call_output` lossless, for storage
   * to move its body into an artifact.
   */
  transcriptStorageFormat?: 2 | 3 | 4;
  /**
   * Trusted host preparation of one final Codex item's output body. Used only
   * with format 4, for `item.completed` of the matching item ID. Provider
   * events can never supply it.
   */
  preparedCodexItem?: PreparedCodexItem;
  /**
   * `canonical-content-only`: canonical turn effects own root timers and root
   * status, so a live commit folds content only and leaves every timer row and
   * the root status as it found them. Absent or `historical` keeps the
   * result-based fallback for offline parsing.
   */
  rootTurnMode?: 'historical' | 'canonical-content-only';
}

/** The prepared output body of a final Codex item; see {@link codexItemOutputBody}. */
export type PreparedCodexItemOutput =
  /** `function_call_output`: the complete text block, header included. */
  | {
      field: 'text';
      text: string;
      textRef?: PersistedToolOutputReference;
      needsRead?: boolean;
    }
  /** `mcp_tool_call` and `dynamic_tool_call`: the tool result output. */
  | {
      field: 'output';
      output: string;
      fullOutputRef?: PersistedToolOutputReference;
      needsRead?: boolean;
    };

export interface PreparedCodexItem {
  /** The provider item ID (`item.id`), not the `codex-` message ID. */
  itemId: string;
  /** A preview plus its reference, or the whole body when it was small. */
  output: PreparedCodexItemOutput;
}

export interface TranscriptParseOptions {
  turnStartedAt?: number | null;
  turnCompletedAt?: number | null;
  closeOpenTurnAtEnd?: boolean;
  aiCreditsRouted?: boolean;
  /** See {@link TranscriptReducerOptions.transcriptStorageFormat}. */
  transcriptStorageFormat?: 2 | 3 | 4;
}

export interface ParsedTranscript {
  messages: ChatMessage[];
  usage?: ChatTabUsage;
  agentUsage?: Record<string, AgentUsage>;
  providerType?: AgentProviderType;
  skippedLineCount: number;
}

type CodexItemEventType = 'item.started' | 'item.updated' | 'item.completed';

function isCodexItemEventType(value: unknown): value is CodexItemEventType {
  return (
    value === 'item.started' ||
    value === 'item.updated' ||
    value === 'item.completed'
  );
}

interface ResultModelUsage {
  contextWindow?: number;
  maxOutputTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readEventEpochMs(
  data: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const timestamp = asEpochMs(data[key]);
    if (timestamp !== undefined) {
      return timestamp;
    }
  }
  return undefined;
}

function resolveTurnStartedAt(
  data: Record<string, unknown> | undefined,
  options: TranscriptReducerOptions,
): number | undefined {
  return data
    ? (readEventEpochMs(data, ['started_at', 'startedAt', 'timestamp']) ??
        options.turnStartedAt ??
        (options.useNowAsTurnTimestamp === false ? undefined : options.now))
    : (options.turnStartedAt ??
        (options.useNowAsTurnTimestamp === false ? undefined : options.now));
}

function resolveTurnCompletedAt(
  data: Record<string, unknown> | undefined,
  options: TranscriptReducerOptions,
): number | undefined {
  const completedAt =
    (data
      ? readEventEpochMs(data, ['completed_at', 'completedAt', 'timestamp'])
      : undefined) ?? options.turnCompletedAt;

  return (
    completedAt ??
    (options.useNowAsTurnTimestamp === false ? undefined : options.now)
  );
}

function detectErrorEventProvider(
  event: Record<string, unknown>,
): AgentProviderType | undefined {
  if (event.type !== 'error') {
    return undefined;
  }

  // Ollama errors include a provider hint
  if (event.provider === 'ollama') {
    return 'ollama';
  }

  if (typeof event.error === 'string') {
    return 'claude';
  }

  if (typeof event.message === 'string' || isRecord(event.error)) {
    return 'codex';
  }

  return undefined;
}

function defaultUsage(): ChatTabUsage {
  return {
    contextTokens: 0,
    contextWindow: 200_000,
    maxOutputTokens: 0,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    durationMs: 0,
    durationApiMs: 0,
    numTurns: 0,
    model: '',
  };
}

function parseModelUsageEntry(value: unknown): ResultModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const parsed: ResultModelUsage = {};
  if (typeof value.contextWindow === 'number') {
    parsed.contextWindow = value.contextWindow;
  }
  if (typeof value.maxOutputTokens === 'number') {
    parsed.maxOutputTokens = value.maxOutputTokens;
  }

  if (
    parsed.contextWindow === undefined &&
    parsed.maxOutputTokens === undefined
  ) {
    return undefined;
  }

  return parsed;
}

function parseResultModelUsage(
  value: unknown,
  preferredModel?: string,
): ResultModelUsage | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return undefined;
  }

  if (preferredModel) {
    const resolvedModel = resolveModelAlias(preferredModel);
    const preferredKeys: string[] =
      resolvedModel === preferredModel
        ? [preferredModel]
        : [preferredModel, resolvedModel];

    for (const key of Object.keys(value)) {
      if (
        !preferredKeys.includes(key) &&
        resolveModelAlias(key) === resolvedModel
      ) {
        preferredKeys.push(key);
      }
    }

    for (const key of preferredKeys) {
      const parsed = parseModelUsageEntry(value[key]);
      if (parsed) {
        return parsed;
      }
    }
  }

  for (const entry of Object.values(value)) {
    const parsed = parseModelUsageEntry(entry);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

const CLAUDE_MODEL_CHANGE_TOOL_NAME = 'ClaudeModelChange';

function resolveComparableModel(model: string): string {
  return resolveModelAlias(resolveRuntimeModel(model) ?? model);
}

function buildClaudeModelChangeToolUseId(args: {
  previousModel: string;
  detectedModel: string;
  rawDetectedModel?: string;
  turnNumber?: number;
  messageCount: number;
}): string {
  return [
    'claude-model-change',
    args.previousModel,
    args.detectedModel,
    args.rawDetectedModel ?? '',
    String(args.turnNumber ?? args.messageCount),
  ].join(':');
}

function appendClaudeModelChangeMessage(
  messages: ChatMessage[],
  args: {
    previousModel: string;
    detectedModel: string;
    rawDetectedModel?: string;
    turnNumber?: number;
  },
  options: TranscriptReducerOptions,
): ChatMessage[] {
  const expectedReportedModel =
    args.rawDetectedModel && args.rawDetectedModel !== args.detectedModel
      ? args.rawDetectedModel
      : undefined;
  const alreadyPresent = messages.some((message) =>
    message.blocks.some((block) => {
      if (
        block.type !== 'tool_use' ||
        block.toolName !== CLAUDE_MODEL_CHANGE_TOOL_NAME
      ) {
        return false;
      }
      try {
        const parsed = JSON.parse(block.input) as Record<string, unknown>;
        return (
          parsed.previous_model === args.previousModel &&
          parsed.detected_model === args.detectedModel &&
          parsed.reported_model === expectedReportedModel
        );
      } catch {
        return false;
      }
    }),
  );
  if (alreadyPresent) {
    return messages;
  }

  const toolUseId = buildClaudeModelChangeToolUseId({
    ...args,
    messageCount: messages.length,
  });

  const input = JSON.stringify({
    previous_model: args.previousModel,
    detected_model: args.detectedModel,
    previous_model_display: getModelDisplayName(args.previousModel),
    detected_model_display: getModelDisplayName(args.detectedModel),
    ...(expectedReportedModel ? { reported_model: expectedReportedModel } : {}),
  });
  const output =
    args.rawDetectedModel && args.rawDetectedModel !== args.detectedModel
      ? [
          `Previous model: ${args.previousModel}`,
          `Detected model: ${args.detectedModel}`,
          `Reported model: ${args.rawDetectedModel}`,
        ].join('\n')
      : [
          `Previous model: ${args.previousModel}`,
          `Detected model: ${args.detectedModel}`,
        ].join('\n');

  return [
    ...messages,
    {
      id: options.createMessageId(),
      role: 'system',
      blocks: [
        {
          type: 'tool_use',
          toolUseId,
          toolName: CLAUDE_MODEL_CHANGE_TOOL_NAME,
          input,
        },
        {
          type: 'tool_result',
          toolUseId,
          toolName: CLAUDE_MODEL_CHANGE_TOOL_NAME,
          output,
          isError: false,
        },
      ],
      timestamp: options.now,
    },
  ];
}

function resolveContextWindow(
  previousContextWindow: number,
  reportedContextWindow: number | undefined,
  selectedModel: string | undefined,
  aiCreditsRouted: boolean,
): number {
  const configuredContextWindow = selectedModel
    ? getModelContextWindow(selectedModel, aiCreditsRouted)
    : undefined;

  if (typeof configuredContextWindow === 'number') {
    if (
      !aiCreditsRouted &&
      typeof reportedContextWindow === 'number' &&
      reportedContextWindow > configuredContextWindow
    ) {
      return reportedContextWindow;
    }

    return configuredContextWindow;
  }

  return reportedContextWindow ?? previousContextWindow;
}

function defaultAgentUsage(
  state: TranscriptReducerState,
): Omit<AgentUsage, 'contextTokens'> & { contextTokens: number } {
  return {
    contextTokens: 0,
    contextWindow: state.usage?.contextWindow ?? 200_000,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    apiCalls: 0,
    toolUses: 0,
    durationMs: 0,
    model: '',
  };
}

export function createEmptyTranscriptReducerState(): TranscriptReducerState {
  return {
    messages: [],
    status: 'idle',
    error: null,
    planMode: false,
  };
}

function containsNoBillingSourceProxyFailure(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') {
    return parseCanopyProxyError(value)?.code === 'no_billing_source';
  }
  if (Array.isArray(value)) {
    return value.some((entry) =>
      containsNoBillingSourceProxyFailure(entry, depth + 1),
    );
  }
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) =>
    containsNoBillingSourceProxyFailure(entry, depth + 1),
  );
}

/**
 * THE no-billing-source detector (CAN-2413) — the single source of truth for
 * "was this failure event caused by the hosted 402?".
 *
 * Main's trusted stamp takes precedence over the scan for surviving marked
 * bodies. Both harnesses may strip response details: Codex can restore its
 * proxy-observed body, while Claude uses a narrow main-owned routing/status/
 * exact-message fallback. Parsing still supports live marked failures and
 * stored transcripts. Bare 402 text is never evidence at this shared boundary.
 *
 * Both the event-shape gate and the recursive payload scan live here because
 * they are one rule, and the renderer's persisted-tab flag and the main
 * process's live banner event must agree about the same turn. They previously
 * had their own copies (`ai-credits-quota-state.ts` in main mirrored this file
 * verbatim); if those drift, a chat shows the recovery banner live but loses it
 * on reload, or vice versa — exactly the class of bug this feature exists to
 * fix. Main imports this rather than re-deriving it.
 *
 * `eventShape` is which reducer shape ran, NOT necessarily the session's
 * provider: a Codex session reports its turn failure twice, once wire-shaped
 * and once as the Claude-shaped `result` that `codex-session.ts` synthesizes.
 *
 * Takes the INNER event. Callers holding the outer `{type:'codex', event}`
 * wrapper unwrap it first.
 */
/**
 * The failure-shape gate alone, without the payload scan.
 *
 * Exported because the main process must decide whether an event is even
 * ELIGIBLE to carry a no-billing-source verdict before it consults the
 * proxy-side latch — the latch is read-and-clear, so consuming it on an
 * unrelated event (a delta, a completed turn) would silently swallow the one
 * signal the failing turn needed. Keeping the gate here means main and the
 * renderer share the same definition of "failure event" instead of main
 * growing a second copy that can drift.
 */
export function isAiCreditsFailureEventShape(
  event: unknown,
  eventShape: 'claude' | 'codex',
): boolean {
  if (!isRecord(event)) return false;
  if (eventShape === 'codex') {
    return event.type === 'turn.failed' || event.type === 'error';
  }
  // `result` requires `is_error === true`. The payload scan this gate protects
  // walks the WHOLE event, including the final assistant text, and a successful
  // turn is also a `result` (`codex-session.ts` emits `is_error: false` for
  // completed and cancelled turns). Without this, a turn that merely *talks
  // about* the marker and the code — a chat about this very feature — would
  // persist the no-billing-source flag and raise the recovery banner on a turn
  // that succeeded (CAN-2413 review round 2).
  return (
    (event.type === 'result' && event.is_error === true) ||
    event.type === 'error' ||
    (event.type === 'assistant' && event.error !== undefined)
  );
}

/**
 * True when main has stamped its own out-of-band no-billing-source verdict on
 * this event (see {@link AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG}). Only an
 * exact `true` counts, so a provider echoing the key with some other value
 * cannot forge the verdict.
 */
function hasNoBillingSourceStamp(event: Record<string, unknown>): boolean {
  return event[AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG] === true;
}

export function isNoBillingSourceFailureEvent(
  event: unknown,
  eventShape: 'claude' | 'codex',
): boolean {
  if (!isRecord(event)) return false;
  if (!isAiCreditsFailureEventShape(event, eventShape)) return false;
  // The stamp is checked first and short-circuits: when the proxy already
  // established the cause from the marked hosted body, the provider's rendered
  // text is irrelevant (and, for Codex, no longer carries the marker at all).
  if (hasNoBillingSourceStamp(event)) return true;
  return containsNoBillingSourceProxyFailure(event);
}

function withNoBillingSourceState(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  /** Which reducer shape ran, NOT necessarily the session's provider. */
  eventShape: 'claude' | 'codex',
  detectedAt: number,
): TranscriptReducerState {
  if (!isNoBillingSourceFailureEvent(event, eventShape)) return state;
  // A Codex session reports its turn failure twice: once as the wire-shaped
  // `{type:'codex', event:{type:'turn.failed'}}` and again as the Claude-shaped
  // `{type:'result', is_error:true}` that `codex-session.ts` synthesizes from
  // the resolved turn. The second one lands here through the Claude reducer, so
  // labelling by event shape would persist `provider: 'claude'` for a Codex
  // chat and disagree with the `provider` the main process puts on the live
  // `canopy_ai_credits_no_billing_source` event. The tab's own `providerType`
  // is the authority; the shape is only the fallback when it is unset.
  const provider = state.providerType === 'codex' ? 'codex' : eventShape;
  return {
    ...state,
    aiCreditsNoBillingSource: { provider, detectedAt },
  };
}

function upsertTaskTodoItem(
  items: TodoItem[] | undefined,
  item: TodoItem,
): TodoItem[] {
  const existing = items ?? [];
  const index = existing.findIndex((current) => current.id === item.id);
  if (index < 0) {
    return [...existing, item];
  }
  const next = existing.slice();
  next[index] = item;
  return next;
}

function applyTaskToolUseBlocks(
  currentTaskTodos: TodoItem[] | undefined,
  blocks: ChatBlock[],
): TodoItem[] | undefined {
  let nextTaskTodos = currentTaskTodos;

  for (const block of blocks) {
    if (block.type !== 'tool_use') continue;
    if (block.toolName === 'TaskCreate') {
      const fallbackId = String((nextTaskTodos?.length ?? 0) + 1);
      const item = parseTaskCreateItem(block.input, fallbackId);
      if (item) {
        nextTaskTodos = upsertTaskTodoItem(nextTaskTodos, item);
      }
      continue;
    }
    if (block.toolName === 'TaskUpdate') {
      nextTaskTodos = applyTaskUpdateItem(nextTaskTodos, block.input);
    }
  }

  return nextTaskTodos;
}

export function deriveCurrentTodosFromMessages(
  messages: ChatMessage[],
): TodoItem[] | undefined {
  let currentTodos: TodoItem[] | undefined;

  for (const message of messages) {
    if (message.parentToolUseId) continue;
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.toolName === 'TodoWrite') {
        currentTodos = parseTodoItems(block.input);
      }
    }
  }

  return currentTodos;
}

/** Incremental equivalent of the transcript-wide TODO projection, used by
 * durable metadata indexes so paging cannot erase earlier task state. */
export function foldTranscriptTodoState(
  current: { todos?: TodoItem[]; taskTodos?: TodoItem[] },
  message: ChatMessage,
): { todos?: TodoItem[]; taskTodos?: TodoItem[] } {
  if (message.parentToolUseId) return current;
  let todos = current.todos;
  for (const block of message.blocks) {
    if (block.type === 'tool_use' && block.toolName === 'TodoWrite')
      todos = parseTodoItems(block.input);
  }
  const taskTodos = applyTaskToolUseBlocks(current.taskTodos, message.blocks);
  return { todos, taskTodos };
}

export function deriveCurrentTaskTodosFromMessages(
  messages: ChatMessage[],
): TodoItem[] | undefined {
  let currentTaskTodos: TodoItem[] | undefined;

  for (const message of messages) {
    if (message.parentToolUseId) continue;
    currentTaskTodos = applyTaskToolUseBlocks(currentTaskTodos, message.blocks);
  }

  return currentTaskTodos;
}

/**
 * Projects the combined desktop TODO-section list from one chat transcript.
 * TodoWrite ids are namespaced to avoid collisions with task-tool ids.
 */
export function projectTodoItems(messages: ChatMessage[]): TodoItem[] {
  const todos = deriveCurrentTodosFromMessages(messages) ?? [];
  const tasks = deriveCurrentTaskTodosFromMessages(messages) ?? [];

  return [
    // Load-bearing desktop TodoSection contract: TodoWrite items precede task items.
    ...todos.map((item): TodoItem => ({ ...item, id: `todo:${item.id}` })),
    ...tasks,
  ];
}

function completeTurnTimer(
  messages: ChatMessage[],
  now: number | undefined,
): ChatMessage[] {
  if (now === undefined) {
    return messages;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const hasOpenTurnTimer = message.blocks.some(
      (block) =>
        block.type === 'turn_timer' &&
        block.completedAt === null &&
        (block.pausedAt == null || block.resumedAt != null),
    );
    if (!hasOpenTurnTimer) {
      continue;
    }

    const updatedMessages = [...messages];
    updatedMessages[index] = {
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'turn_timer' && block.completedAt === null
          ? block.pausedAt == null || block.resumedAt != null
            ? { ...block, completedAt: now }
            : block
          : block,
      ),
    };
    return updatedMessages;
  }

  return messages;
}

function completeAllOpenTurnTimers(
  messages: ChatMessage[],
  now: number | undefined,
): ChatMessage[] {
  if (now === undefined) {
    return messages;
  }
  if (!hasOpenTurnTimer(messages)) {
    return messages;
  }

  let changed = false;
  const updatedMessages = messages.map((message) => {
    let messageChanged = false;
    const blocks = message.blocks.map((block) => {
      if (
        block.type === 'turn_timer' &&
        block.completedAt === null &&
        (block.pausedAt == null || block.resumedAt != null)
      ) {
        messageChanged = true;
        changed = true;
        return { ...block, completedAt: now };
      }
      return block;
    });
    return messageChanged ? { ...message, blocks } : message;
  });

  return changed ? updatedMessages : messages;
}

function hasOpenTurnTimer(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    message.blocks.some(
      (block) =>
        block.type === 'turn_timer' &&
        block.completedAt === null &&
        (block.pausedAt == null || block.resumedAt != null),
    ),
  );
}

/** Like `hasPausedTurnTimer`, but an earlier turn's abandoned pause does not count. */
function hasPausedTurnTimerInCurrentTurn(messages: ChatMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.blocks.some(
        (block) =>
          block.type === 'turn_timer' &&
          block.completedAt === null &&
          block.pausedAt != null &&
          block.resumedAt == null,
      )
    ) {
      return true;
    }
    if (isTurnTimerOwnershipBoundary(message)) return false;
  }
  return false;
}

function hasAnyTurnTimer(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    message.blocks.some((block) => block.type === 'turn_timer'),
  );
}

function hasPausedTurnTimer(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    message.blocks.some(
      (block) =>
        block.type === 'turn_timer' &&
        block.completedAt === null &&
        block.pausedAt != null &&
        block.resumedAt == null,
    ),
  );
}

function isUserPromptBoundaryMessage(message: ChatMessage): boolean {
  return (
    isUserTurnBoundary(message) &&
    message.blocks.some((block) => block.type === 'text')
  );
}

function reopenLastCompletedTurnTimer(messages: ChatMessage[]): ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isUserPromptBoundaryMessage(message)) {
      return messages;
    }

    const timerBlock = message.blocks.find(
      (block): block is ChatBlock & { type: 'turn_timer' } =>
        block.type === 'turn_timer',
    );
    if (!timerBlock || timerBlock.completedAt === null) {
      continue;
    }

    const updatedMessages = [...messages];
    updatedMessages[index] = {
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'turn_timer' && block.completedAt !== null
          ? { ...block, completedAt: null }
          : block,
      ),
    };
    return updatedMessages;
  }

  return messages;
}

function resumeLastPausedTurnTimer(
  messages: ChatMessage[],
  resumedAt: number,
): ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isUserPromptBoundaryMessage(message)) {
      return messages;
    }

    const hasPausedTimer = message.blocks.some(
      (block) =>
        block.type === 'turn_timer' &&
        block.completedAt === null &&
        block.pausedAt != null &&
        block.resumedAt == null,
    );
    if (!hasPausedTimer) {
      continue;
    }

    const updatedMessages = [...messages];
    updatedMessages[index] = {
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'turn_timer' &&
        block.completedAt === null &&
        block.pausedAt != null &&
        block.resumedAt == null
          ? resumeTurnTimerBlock(block, block.pausedAt, resumedAt)
          : block,
      ),
    };
    return updatedMessages;
  }

  return messages;
}

const UNOWNED_TURN_TIMER_PAUSE_OWNER_ID = '__canopy_unowned_turn_timer_pause__';

// Hidden deliveries continue the visible turn and reuse its timer. Keep this
// boundary local to timer ownership; other transcript grouping has its own rules.
function isTurnTimerOwnershipBoundary(message: PersistedChatMessage): boolean {
  return !message.hidden && isUserTurnBoundary(message);
}

export function pauseOpenTurnTimer(
  messages: PersistedChatMessage[],
  pausedAt: number = Date.now(),
  ownerId?: string,
): PersistedChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const timerBlock = message.blocks.find(
      (block): block is PersistedChatBlock & { type: 'turn_timer' } =>
        block.type === 'turn_timer',
    );
    // A canonical timer changes only through its committed turn effects.
    if (timerBlock?.turnId !== undefined) return messages;
    const isRunning =
      timerBlock &&
      timerBlock.completedAt === null &&
      (timerBlock.pausedAt == null || timerBlock.resumedAt != null);
    const isPaused =
      timerBlock &&
      timerBlock.completedAt === null &&
      timerBlock.pausedAt != null &&
      timerBlock.resumedAt == null;
    if (timerBlock && (isRunning || (ownerId !== undefined && isPaused))) {
      if (
        ownerId !== undefined &&
        timerBlock.pauseOwnerIds?.includes(ownerId)
      ) {
        return messages;
      }
      const updatedMessages = [...messages];
      updatedMessages[index] = {
        ...message,
        blocks: message.blocks.map((block) =>
          block.type === 'turn_timer' &&
          block.completedAt === null &&
          (block.pausedAt == null ||
            block.resumedAt != null ||
            (ownerId !== undefined &&
              block.pausedAt != null &&
              block.resumedAt == null))
            ? {
                ...(block.pausedAt == null || block.resumedAt != null
                  ? pauseTurnTimerBlock(block, pausedAt)
                  : block),
                ...(ownerId !== undefined
                  ? {
                      pauseOwnerIds: [
                        ...(block.pausedAt != null &&
                        block.resumedAt == null &&
                        (block.pauseOwnerIds?.length ?? 0) === 0
                          ? [UNOWNED_TURN_TIMER_PAUSE_OWNER_ID]
                          : []),
                        ...(block.pauseOwnerIds ?? []),
                        ownerId,
                      ],
                    }
                  : {}),
              }
            : block,
        ),
      };
      return updatedMessages;
    }
    if (isTurnTimerOwnershipBoundary(message)) {
      return messages;
    }
  }
  return messages;
}

export function pauseTurnTimerBlock(
  block: PersistedChatBlock & { type: 'turn_timer' },
  pausedAt: number,
): PersistedChatBlock & { type: 'turn_timer' } {
  const accumulatedPausedDurationMs =
    typeof block.accumulatedPausedDurationMs === 'number'
      ? Math.max(0, block.accumulatedPausedDurationMs)
      : block.pausedAt != null && block.resumedAt != null
        ? Math.max(0, block.resumedAt - block.pausedAt)
        : undefined;
  return {
    ...block,
    pausedAt,
    resumedAt: null,
    ...(accumulatedPausedDurationMs !== undefined
      ? { accumulatedPausedDurationMs }
      : {}),
  };
}

export function resumePausedTurnTimer(
  messages: PersistedChatMessage[],
  resumedAt: number = Date.now(),
  ownerId?: string,
): PersistedChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const timerBlock = message.blocks.find(
      (block): block is PersistedChatBlock & { type: 'turn_timer' } =>
        block.type === 'turn_timer',
    );
    // A canonical timer changes only through its committed turn effects.
    if (timerBlock?.turnId !== undefined) return messages;
    const ownerIds = timerBlock?.pauseOwnerIds ?? [];
    if (
      timerBlock &&
      timerBlock.completedAt === null &&
      timerBlock.pausedAt != null &&
      timerBlock.resumedAt == null &&
      (ownerId === undefined
        ? ownerIds.length === 0 ||
          ownerIds.includes(UNOWNED_TURN_TIMER_PAUSE_OWNER_ID)
        : ownerIds.includes(ownerId))
    ) {
      const updatedMessages = [...messages];
      updatedMessages[index] = {
        ...message,
        blocks: message.blocks.map((block) => {
          if (
            block.type !== 'turn_timer' ||
            block.completedAt !== null ||
            block.pausedAt == null ||
            block.resumedAt != null
          ) {
            return block;
          }
          const releasedOwnerId = ownerId ?? UNOWNED_TURN_TIMER_PAUSE_OWNER_ID;
          const remainingOwnerIds = (block.pauseOwnerIds ?? []).filter(
            (candidate) => candidate !== releasedOwnerId,
          );
          if (remainingOwnerIds.length > 0) {
            return { ...block, pauseOwnerIds: remainingOwnerIds };
          }
          const resumedBlock = resumeTurnTimerBlock(
            block,
            block.pausedAt,
            resumedAt,
          );
          const withoutOwners = { ...resumedBlock };
          delete withoutOwners.pauseOwnerIds;
          return withoutOwners;
        }),
      };
      return updatedMessages;
    }
    if (isTurnTimerOwnershipBoundary(message)) {
      return messages;
    }
  }
  return messages;
}

export function resumeTurnTimerBlock(
  block: ChatBlock & { type: 'turn_timer' },
  pausedAt: number,
  resumedAt: number,
): ChatBlock & { type: 'turn_timer' } {
  const accumulatedPausedDurationMs =
    Math.max(0, block.accumulatedPausedDurationMs ?? 0) +
    Math.max(0, resumedAt - pausedAt);
  return {
    ...block,
    resumedAt,
    ...(accumulatedPausedDurationMs > 0 ||
    typeof block.accumulatedPausedDurationMs === 'number'
      ? { accumulatedPausedDurationMs }
      : {}),
  };
}

function ensureOpenTurnTimerForContinuation(
  state: TranscriptReducerState,
  options: TranscriptReducerOptions,
  freshForegroundWork = false,
): ChatMessage[] {
  // A paused timer (e.g. awaiting an approval) still owns the current turn; its
  // pause owner resumes it, so foreground work must not start a second timer.
  if (
    (state.status === 'streaming' && !freshForegroundWork) ||
    hasOpenTurnTimer(state.messages) ||
    hasPausedTurnTimerInCurrentTurn(state.messages) ||
    !hasAnyTurnTimer(state.messages)
  ) {
    return state.messages;
  }

  const reopenedMessages = reopenLastCompletedTurnTimer(state.messages);
  if (reopenedMessages !== state.messages) {
    return reopenedMessages;
  }

  const startedAt = resolveTurnStartedAt(undefined, options);
  return [
    ...state.messages,
    {
      id: options.createMessageId(),
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          ...(startedAt !== undefined ? { startedAt } : {}),
          completedAt: null,
        },
      ],
      timestamp: options.now,
    },
  ];
}

function ensureOpenTurnTimerForPausedContinuation(
  state: TranscriptReducerState,
  options: TranscriptReducerOptions,
): ChatMessage[] {
  if (
    state.status === 'streaming' ||
    hasOpenTurnTimer(state.messages) ||
    !hasPausedTurnTimer(state.messages)
  ) {
    return state.messages;
  }

  const resumedMessages = resumeLastPausedTurnTimer(
    state.messages,
    options.now,
  );
  if (resumedMessages !== state.messages) {
    return resumedMessages;
  }

  const startedAt = resolveTurnStartedAt(undefined, options);
  return [
    ...state.messages,
    {
      id: options.createMessageId(),
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          ...(startedAt !== undefined ? { startedAt } : {}),
          completedAt: null,
        },
      ],
      timestamp: options.now,
    },
  ];
}

function closeOpenToolUseBlocks(
  messages: ChatMessage[],
  createMessageId: () => string,
  now: number,
  context: ChildToolCloseContext,
  endedParentToolUseIds?: ReadonlySet<string>,
): ChatMessage[] {
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') {
        toolResultIds.add(block.toolUseId);
      }
    }
  }

  const unmatchedByParent = new Map<
    string,
    {
      parentToolUseId?: string;
      parentBlockId?: string;
      codexThreadId?: string;
      blocks: ChatBlock[];
    }
  >();
  for (const message of messages) {
    const shouldClose = endedParentToolUseIds
      ? message.parentToolUseId !== undefined &&
        endedParentToolUseIds.has(message.parentToolUseId)
      : shouldCloseToolUseMessage(message, context);
    if (!shouldClose) continue;
    for (const block of message.blocks) {
      // `codex_agent_call` blocks are Codex-native and intentionally pass
      // through this cancel-out path unchanged — the renderer's reducer
      // owns marking subagents as cancelled (via `agentsStates`), so
      // fabricating a synthetic `tool_result` here would corrupt the
      // persisted block.
      if (block.type === 'codex_agent_call') {
        continue;
      }
      if (block.type !== 'tool_use' || toolResultIds.has(block.toolUseId)) {
        continue;
      }

      const parentKey =
        message.parentBlockId !== undefined
          ? `block:${message.parentBlockId}|tool:${message.parentToolUseId ?? ''}|thread:${message.codexThreadId ?? ''}`
          : `tool:${message.parentToolUseId ?? ''}|thread:${message.codexThreadId ?? ''}`;
      const unmatched = unmatchedByParent.get(parentKey) ?? {
        ...(message.parentToolUseId
          ? { parentToolUseId: message.parentToolUseId }
          : {}),
        ...(message.parentBlockId
          ? { parentBlockId: message.parentBlockId }
          : {}),
        ...(message.codexThreadId
          ? { codexThreadId: message.codexThreadId }
          : {}),
        blocks: [],
      };
      unmatched.blocks.push({
        type: 'tool_result',
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        output: 'Cancelled',
        isError: false,
      });
      unmatchedByParent.set(parentKey, unmatched);
    }
  }

  if (unmatchedByParent.size === 0) {
    return messages;
  }

  const updatedMessages = [...messages];
  unmatchedByParent.forEach((entry) => {
    updatedMessages.push({
      id: createMessageId(),
      role: 'system',
      blocks: entry.blocks,
      timestamp: now,
      ...(entry.parentToolUseId
        ? { parentToolUseId: entry.parentToolUseId }
        : {}),
      ...(entry.parentBlockId ? { parentBlockId: entry.parentBlockId } : {}),
      ...(entry.codexThreadId ? { codexThreadId: entry.codexThreadId } : {}),
    });
  });
  return updatedMessages;
}

function childToolCloseContext(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): ChildToolCloseContext {
  return {
    liveness: readChildToolLivenessStamp(data) ?? options.childToolLiveness,
    codexRootThreadId: state.sdkSessionId,
    agentCallBlocksById: indexCodexAgentCallBlocks(state.messages),
  };
}

function applyChildToolsEndedEvent(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  if (
    !Array.isArray(event.parent_tool_use_ids) ||
    !event.parent_tool_use_ids.every((id: unknown) => typeof id === 'string')
  )
    return state;
  const messages = closeOpenToolUseBlocks(
    state.messages,
    options.createMessageId,
    options.now,
    childToolCloseContext(state, event, options),
    new Set(event.parent_tool_use_ids),
  );
  return messages === state.messages
    ? state
    : { ...state, messages, lastEventAt: options.now };
}

// Real results supersede synthetic cancellations by tool id, including a
// grouped cancellation row containing results for several siblings.
function withoutPriorToolResults(
  messages: ChatMessage[],
  incoming: ChatBlock[],
  exceptMessageId?: string,
): ChatMessage[] {
  const ids = new Set(
    incoming.flatMap((block) =>
      block.type === 'tool_result' ? [block.toolUseId] : [],
    ),
  );
  if (ids.size === 0) return messages;
  let changed = false;
  const updated = messages.flatMap((message) => {
    if (message.id === exceptMessageId) return [message];
    const blocks = message.blocks.filter(
      (block) => block.type !== 'tool_result' || !ids.has(block.toolUseId),
    );
    if (blocks.length === message.blocks.length) return [message];
    changed = true;
    return blocks.length === 0 ? [] : [{ ...message, blocks }];
  });
  return changed ? updated : messages;
}

function buildSyntheticUserPromptMessage(
  messages: readonly ChatMessage[],
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): ChatMessage | null {
  const text = asString(data.original_text);
  if (text.length === 0) {
    return null;
  }

  return {
    id:
      typeof data.user_message_id === 'string'
        ? data.user_message_id
        : typeof data.canopy_turn_user_message_id === 'string'
          ? data.canopy_turn_user_message_id
          : createUnusedMessageId(messages, options),
    role: 'user',
    ...(data.canopy_hidden === true ? { hidden: true } : {}),
    ...(data.canopy_user_message_source === 'hook'
      ? { userMessageSource: 'hook' as const }
      : {}),
    blocks: [
      {
        type: 'text',
        text,
        ...(isRecord(data.steering) &&
        typeof data.steering.startsTurn === 'boolean'
          ? {
              steering: {
                startsTurn: data.steering.startsTurn,
                ...(typeof data.steering.rootUserMessageId === 'string'
                  ? { rootUserMessageId: data.steering.rootUserMessageId }
                  : {}),
              },
            }
          : {}),
      },
    ],
    timestamp: options.now,
  };
}

/** Hidden deliveries continue the visible turn without editing its settled timer. */
function resumeHiddenPromptTimer(
  state: TranscriptReducerState,
  prompt: ChatMessage,
  options: TranscriptReducerOptions,
): ChatMessage[] | undefined {
  if (!prompt.hidden) return undefined;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message.hidden) continue;
    const timer = message.blocks.find((block) => block.type === 'turn_timer');
    if (timer?.type === 'turn_timer') {
      const messages = state.messages.some(
        (candidate) => candidate.id === prompt.id,
      )
        ? state.messages
        : [...state.messages, prompt];
      // An open continuation (including one paused by an independent owner)
      // already owns this delivery. Never release its pauses or duplicate it.
      if (timer.completedAt === null) return messages;
      return [
        ...messages,
        {
          id: createUnusedMessageId(messages, options),
          role: 'system',
          timestamp: options.now,
          blocks: [
            {
              ...timer,
              completedAt: null,
              // Static replay's clock is a line number, not wall time. Keep
              // recorded accounting without inventing an idle gap from it.
              ...(options.useNowAsTurnTimestamp === false
                ? {}
                : {
                    pausedAt: timer.completedAt,
                    resumedAt: options.now,
                    accumulatedPausedDurationMs:
                      Math.max(0, timer.accumulatedPausedDurationMs ?? 0) +
                      Math.max(0, options.now - timer.completedAt),
                  }),
            },
          ],
        },
      ];
    }
    if (isUserPromptBoundaryMessage(message)) break;
  }
  return undefined;
}

/**
 * Hosts mint synthetic ids deterministically per event (main uses
 * `${chatId}:${mutationId}:${sequence}`), so a replayed event upserts the row
 * it created before. A prompt re-processed long after its first delivery
 * reuses that mutation id while its first turn's rows are still in history;
 * advance past ids that already exist instead of shadowing them.
 */
function createUnusedMessageId(
  messages: readonly ChatMessage[],
  options: TranscriptReducerOptions,
): string {
  const used = new Set(messages.map((message) => message.id));
  let id = options.createMessageId();
  // Distinct candidates cannot all be taken after `used.size + 1` draws.
  for (let attempt = 0; used.has(id) && attempt < used.size; attempt += 1)
    id = options.createMessageId();
  if (!used.has(id)) return id;
  let suffix = 1;
  while (used.has(`${id}:${String(suffix)}`)) suffix += 1;
  return `${id}:${String(suffix)}`;
}

/**
 * A prompt row that is already in the transcript is the same message being
 * re-dispatched: move it to the dispatch position (as main's prompt merge
 * does) rather than appending a second row with the same id.
 */
function movePromptToEnd(
  messages: ChatMessage[],
  promptId: string,
): ChatMessage[] | undefined {
  const index = messages.findIndex((message) => message.id === promptId);
  if (index < 0) return undefined;
  if (index === messages.length - 1) return messages;
  return [
    ...messages.slice(0, index),
    ...messages.slice(index + 1),
    messages[index],
  ];
}

function buildSyntheticTurnTimerMessage(
  messages: readonly ChatMessage[],
  options: TranscriptReducerOptions,
  data?: Record<string, unknown>,
): ChatMessage {
  const startedAt = resolveTurnStartedAt(data, options);
  return {
    id: createUnusedMessageId(messages, options),
    role: 'system',
    blocks: [
      {
        type: 'turn_timer',
        ...(startedAt !== undefined ? { startedAt } : {}),
        completedAt: null,
      },
    ],
    timestamp: options.now,
  };
}

function formatDiagnosticValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function buildCanopyHelperDiagnosticMessage(
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): ChatMessage {
  const helper = asString(data.helper);
  const title =
    helper === 'branch_naming'
      ? 'Branch naming diagnostic'
      : 'Helper diagnostic';
  const detailLines = Object.entries(data)
    .filter(
      ([key, value]) =>
        key !== 'type' &&
        key !== 'helper' &&
        key !== 'timestamp' &&
        value !== undefined,
    )
    .map(([key, value]) => `${key}: ${formatDiagnosticValue(value)}`);

  return {
    id: options.createMessageId(),
    role: 'system',
    blocks: [
      {
        type: 'text',
        text:
          detailLines.length > 0
            ? `${title}\n${detailLines.join('\n')}`
            : title,
      },
    ],
    timestamp: readEventEpochMs(data, ['timestamp']) ?? options.now,
  };
}

function messageHasTextBlock(message: ChatMessage, text: string): boolean {
  return message.blocks.some(
    (block) => block.type === 'text' && block.text.trim() === text.trim(),
  );
}

function isLayoutSystemMessage(message: ChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.every((block) => LAYOUT_BLOCK_TYPES.has(block.type))
  );
}

function findMatchingUserPromptIndex(
  messages: ChatMessage[],
  promptMessage: ChatMessage,
): number {
  const promptTextBlock = promptMessage.blocks.find(
    (block) => block.type === 'text',
  );
  if (!promptTextBlock || promptTextBlock.type !== 'text') {
    return -1;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isLayoutSystemMessage(message)) {
      continue;
    }
    return message.role === 'user' &&
      messageHasTextBlock(message, promptTextBlock.text)
      ? index
      : -1;
  }
  return -1;
}

/**
 * Repair historical running timers before starting an explicit user turn.
 * Old releases could persist a terminal error without settling its timer.
 * Use each old turn's last activity, excluding resume/hook layout banners,
 * so hours spent stopped are not charged to that turn. Static JSONL replay
 * uses line numbers as message timestamps and must not turn those into dates.
 */
function completeHistoricalTurnTimers(
  messages: ChatMessage[],
  promptIndex: number,
  options: TranscriptReducerOptions,
): ChatMessage[] {
  if (options.useNowAsTurnTimestamp === false) return messages;
  let updated = messages;
  let lastActivityAt: number | undefined;
  const pendingTimerIndices: number[] = [];
  for (let index = promptIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isLayoutSystemMessage(message)) {
      lastActivityAt = Math.max(
        lastActivityAt ?? message.timestamp,
        message.timestamp,
      );
    }
    if (hasOpenTurnTimer([message])) {
      pendingTimerIndices.push(index);
    }
    if (isUserTurnBoundary(message) || index === 0) {
      // Timers may be stored at the start OR end of a turn. Wait until the
      // whole group has been inspected before choosing its completion time.
      for (const timerIndex of pendingTimerIndices) {
        const timerMessage = messages[timerIndex];
        if (updated === messages) updated = [...messages];
        updated[timerIndex] = {
          ...timerMessage,
          blocks: timerMessage.blocks.map((block) =>
            block.type === 'turn_timer' &&
            block.completedAt === null &&
            (block.pausedAt == null || block.resumedAt != null)
              ? {
                  ...block,
                  completedAt: Math.max(
                    block.startedAt ?? timerMessage.timestamp,
                    lastActivityAt ?? timerMessage.timestamp,
                  ),
                }
              : block,
          ),
        };
      }
      pendingTimerIndices.length = 0;
      lastActivityAt = undefined;
    }
  }
  return updated;
}

/**
 * Structured authentication failure (CAN-1814). This belongs in the reducer,
 * not only in the renderer store: `authFailure` is declared on
 * `PersistedChatBlock`, main owns durable chat commits, and main reduces
 * provider events through this same function. Without it the event fell
 * through to `return state`, so no block was ever written with the field and
 * the attachment was lost on idle unload, chat switch, or restart — and
 * dropped entirely when the tab was not loaded.
 *
 * Shared by both provider reducers because `parseAgentTranscriptLines` (the
 * web Portal's JSONL replay path) dispatches `canopy_*` lines to whichever
 * reducer matches the transcript's detected provider.
 */
function applyCanopyAuthFailureEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  if (!isCanopyAuthFailureEventData(data)) {
    return state;
  }
  const messages = attachAuthFailureToMessages(state.messages, data);
  if (messages === state.messages) {
    return state;
  }
  return {
    ...state,
    messages,
    lastEventAt: options.now,
  };
}

/**
 * Cursor streams model text as incremental `canopy_assistant_patch` frames
 * instead of self-contained items, so the local-memory citation control tag
 * is stripped from the assembled assistant blocks here, mirroring what
 * `parseAssistantBlocks` and the Codex item reducer do for their assembled
 * text.
 *
 * Only the blocks a frame patched are scanned, and an `appendText` patch is
 * scanned only when it carries a `>`: the text before the append was already
 * stripped, and a tag can only close on its `>`, so other appends cannot
 * complete one. That keeps a long streamed reply from being re-scanned in
 * full on every delta.
 *
 * Stripping the folded block (rather than each delta) means a tag split
 * across deltas disappears once the delta that closes it is applied. The
 * partial `<memory_citation` prefix stays visible until then, and would
 * persist only if the turn died mid-tag. The strip never trims, because the
 * stripped text feeds the next append and trimming would glue that delta
 * onto the previous line. Blocks are never dropped, because later patches
 * address them by index. Host notices (`role: 'system'`) are app-authored
 * and pass through intact.
 */
function stripCursorAssistantMemoryCitations(
  message: PersistedChatMessage,
  patchedIndices: ReadonlySet<number>,
): PersistedChatMessage {
  if (message.role !== 'assistant' || patchedIndices.size === 0) return message;
  let changed = false;
  const blocks = message.blocks.map((block, index) => {
    if (!patchedIndices.has(index)) return block;
    if (block.type !== 'text' && block.type !== 'thinking') return block;
    const text = stripMemoryCitationTags(block.text, { trimEnd: false });
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...message, blocks } : message;
}

function patchedBlockIndices(patches: unknown): ReadonlySet<number> {
  const indices = new Set<number>();
  if (!Array.isArray(patches)) return indices;
  for (const patch of patches) {
    if (
      isRecord(patch) &&
      typeof patch.index === 'number' &&
      Number.isSafeInteger(patch.index) &&
      // A new tag can only close in an append that carries its `>`.
      (typeof patch.appendText !== 'string' || patch.appendText.includes('>'))
    ) {
      indices.add(patch.index);
    }
  }
  return indices;
}

function isTurnTimerRow(message: ChatMessage): boolean {
  return message.blocks.some((block) => block.type === 'turn_timer');
}

/** Keeps root timer rows and root status from `before`; content stays from `after`. */
function keepCanonicalRootTurn(
  before: TranscriptReducerState,
  after: TranscriptReducerState,
): TranscriptReducerState {
  if (after === before) return after;
  const priorTimerRows = new Map<string, ChatMessage>();
  for (const message of before.messages)
    if (isTurnTimerRow(message)) priorTimerRows.set(message.id, message);
  let changed = false;
  const messages: ChatMessage[] = [];
  for (const message of after.messages) {
    if (!isTurnTimerRow(message) && !priorTimerRows.has(message.id)) {
      messages.push(message);
      continue;
    }
    const prior = priorTimerRows.get(message.id);
    if (prior !== message) changed = true;
    // Rows the parser synthesized have no prior version and are dropped.
    if (prior) messages.push(prior);
  }
  if (
    !changed &&
    after.status === before.status &&
    after.error === before.error
  )
    return after;
  return {
    ...after,
    messages: changed ? messages : after.messages,
    status: before.status,
    error: before.error,
  };
}

export function applyClaudeTranscriptEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const provider = data.provider;
  if (
    state.usage?.reportedTurnUsage !== undefined &&
    (provider === 'claude' ||
      provider === 'codex' ||
      provider === 'cursor' ||
      provider === 'copilot' ||
      provider === 'opencode' ||
      provider === 'ollama')
  ) {
    state = {
      ...state,
      usage: { ...state.usage, reportedTurnUsage: undefined },
    };
  }
  const next = reduceClaudeTranscriptEvent(state, data, options);
  return options.rootTurnMode === 'canonical-content-only'
    ? keepCanonicalRootTurn(state, next)
    : next;
}

function reduceClaudeTranscriptEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  if (
    data.type === 'canopy_turn_usage' &&
    data.provider === 'antigravity' &&
    data.usage === null
  ) {
    return {
      ...state,
      providerType: 'antigravity',
      usage: {
        ...defaultUsage(),
        contextWindow: 0,
        model: state.usage?.model ?? state.model ?? '',
        reportedTurnUsage: null,
      },
    };
  }
  if (data.type === CHILD_TOOLS_ENDED_EVENT_TYPE)
    return applyChildToolsEndedEvent(state, data, options);
  if (data.type === CANOPY_DELEGATION_EVENT_TYPE)
    return applyDelegationTranscriptEvent(state, data);
  if (data.type === 'canopy_opencode_usage' && data.provider === 'opencode') {
    const reported = parseOpenCodeReportedUsage(data.usage);
    if (data.usage !== null && !reported) return state;
    return {
      ...state,
      providerType: 'opencode',
      usage: {
        ...(state.usage ?? defaultUsage()),
        opencodeReportedUsage: reported,
        contextTokens: reported?.context?.usedTokens ?? 0,
        contextWindow: reported?.context?.maxTokens ?? 0,
      },
    };
  }
  if (data.type === 'canopy_cursor_usage' && data.provider === 'cursor') {
    const reported = parseCursorReportedUsage(data.usage);
    if (data.usage !== null && !reported) return state;
    return {
      ...state,
      providerType: 'cursor',
      usage: {
        ...(state.usage ?? defaultUsage()),
        cursorReportedUsage: reported,
        contextTokens: 0,
        contextWindow: 0,
      },
    };
  }
  if (
    data.type === 'canopy_assistant_patch' &&
    (data.provider === 'cursor' ||
      data.provider === 'copilot' ||
      data.provider === 'antigravity' ||
      data.provider === 'opencode')
  ) {
    const previous = state.messages.find(
      (message) => message.id === data.messageId,
    );
    const folded = applyAssistantPatches(previous, data);
    if (!folded) return state;
    const message = stripCursorAssistantMemoryCitations(
      folded,
      patchedBlockIndices(data.patches),
    );
    const base = ensureOpenTurnTimerForContinuation(state, options);
    const index = base.findIndex((existing) => existing.id === message.id);
    const messages = [...base];
    if (index < 0) messages.push(message);
    else messages[index] = message;
    return {
      ...state,
      messages,
      providerType: data.provider,
      status: 'streaming',
      lastEventAt: options.now,
    };
  }
  if (data.type === 'canopy_user_prompt') {
    const promptMessage = buildSyntheticUserPromptMessage(
      state.messages,
      data,
      options,
    );
    if (!promptMessage) {
      return state;
    }

    const resumedMessages = resumeHiddenPromptTimer(
      state,
      promptMessage,
      options,
    );
    if (resumedMessages)
      return {
        ...state,
        messages: resumedMessages,
        status: 'streaming',
        lastEventAt: options.now,
      };

    if (isRecord(data.steering) && data.steering.startsTurn === false) {
      return {
        ...state,
        messages: state.messages.some(
          (message) => message.id === promptMessage.id,
        )
          ? state.messages
          : [...state.messages, promptMessage],
        lastEventAt: options.now,
      };
    }

    const provider = asString(data.provider);
    const lastPromptIndex = findMatchingUserPromptIndex(
      state.messages,
      promptMessage,
    );
    const movedPromptMessages =
      lastPromptIndex < 0
        ? movePromptToEnd(state.messages, promptMessage.id)
        : undefined;
    const baseMessages = movedPromptMessages ?? state.messages;
    const matchingPromptIndex = movedPromptMessages
      ? movedPromptMessages.length - 1
      : lastPromptIndex;
    const promptIndex =
      matchingPromptIndex < 0 ? baseMessages.length : matchingPromptIndex;
    const messages = completeHistoricalTurnTimers(
      matchingPromptIndex < 0 ? [...baseMessages, promptMessage] : baseMessages,
      promptIndex,
      options,
    );
    // An open timer from a different user turn cannot stand in for this one.
    const nextMessages = hasOpenTurnTimer(messages.slice(promptIndex + 1))
      ? messages
      : [...messages, buildSyntheticTurnTimerMessage(messages, options, data)];
    return {
      ...state,
      status: 'streaming',
      messages: nextMessages,
      providerType:
        provider === 'claude' ||
        provider === 'codex' ||
        provider === 'cursor' ||
        provider === 'copilot' ||
        provider === 'antigravity' ||
        provider === 'opencode'
          ? provider
          : state.providerType,
      lastEventAt: options.now,
    };
  }

  if (
    data.type === 'canopy_injected_prompt' ||
    data.type === 'canopy_transcript_truncated'
  ) {
    return {
      ...state,
      lastEventAt: options.now,
    };
  }

  if (data.type === CANOPY_AUTH_FAILURE_EVENT_TYPE) {
    return applyCanopyAuthFailureEvent(state, data, options);
  }

  if (data.type === 'canopy_helper_diagnostic') {
    return {
      ...state,
      messages: [
        ...state.messages,
        buildCanopyHelperDiagnosticMessage(data, options),
      ],
      lastEventAt: options.now,
    };
  }

  if (data.type === 'canopy_compaction') {
    return applyCanopyCompactionEvent(state, data, options, 'claude');
  }

  if (data.type === CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE) {
    return applyAccountProxySwitchEvent(state, data, options);
  }
  if (data.type === CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE) {
    return applyClaudeModsSkippedEvent(state, data, options);
  }

  const claudeHandler = CLAUDE_EVENT_HANDLERS[asString(data.type)];
  if (claudeHandler) {
    if (isRepeatedHistoricalClaudeProxyFailure(state, data)) return state;
    return withNoBillingSourceState(
      isCodexStartupResult(data)
        ? handleCodexStartupResult(state, data, options)
        : claudeHandler(state, data, options),
      data,
      'claude',
      options.now,
    );
  }
  return state;
}

/**
 * Append a `compaction_info` block as a single-block system message. Used by
 * both the native Claude SDK `compact_boundary` system-event branch and the
 * synthetic `canopy_compaction` envelope produced by the backend transcript
 * sync. The block is append-only: earlier transcript content is never
 * rewritten or removed by the renderer.
 */
function appendCompactionBlock(
  state: TranscriptReducerState,
  block: CompactionInfoBlock,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const sourceEventId = block.sourceEventId;
  if (sourceEventId !== undefined) {
    const alreadyPresent = state.messages.some((message) =>
      message.blocks.some(
        (existing) =>
          existing.type === 'compaction_info' &&
          existing.sourceEventId === sourceEventId,
      ),
    );
    if (alreadyPresent) {
      return { ...state, lastEventAt: options.now };
    }
  }

  const compactionMessage: ChatMessage = {
    id: options.createMessageId(),
    role: 'system',
    blocks: [block],
    timestamp: block.timestamp,
  };

  return {
    ...state,
    messages: [...state.messages, compactionMessage],
    lastEventAt: options.now,
  };
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim().slice(0, 200);
  return label.length > 0 ? label : undefined;
}

/**
 * Append an `account_proxy_switch` line (CAN-4021). A replayed event with the
 * same `sourceEventId` is shown once.
 */
function applyAccountProxySwitchEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const account = boundedLabel(data.account);
  if (account === undefined) return state;
  const sourceEventId =
    typeof data.sourceEventId === 'string' ? data.sourceEventId : undefined;
  if (
    sourceEventId !== undefined &&
    state.messages.some((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'account_proxy_switch' &&
          block.sourceEventId === sourceEventId,
      ),
    )
  ) {
    return { ...state, lastEventAt: options.now };
  }
  const previousAccount = boundedLabel(data.previousAccount);
  const provider = boundedLabel(data.provider);
  const timestamp =
    typeof data.timestamp === 'number' && Number.isFinite(data.timestamp)
      ? data.timestamp
      : options.now;
  const block: AccountProxySwitchBlock = {
    type: 'account_proxy_switch',
    timestamp,
    account,
    ...(previousAccount !== undefined ? { previousAccount } : {}),
    ...(previousAccount !== undefined && data.previousAtLimit === true
      ? { previousAtLimit: true }
      : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(sourceEventId !== undefined ? { sourceEventId } : {}),
  };
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        // Keyed by the event, so the live Portal row and the reloaded one match.
        id: sourceEventId ?? options.createMessageId(),
        role: 'system',
        blocks: [block],
        timestamp,
      },
    ],
    lastEventAt: options.now,
  };
}

/** Append a launch's bounded Claude Mods skip notice once across replay. */
function applyClaudeModsSkippedEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  if (
    typeof data.timestamp !== 'number' ||
    !Number.isFinite(data.timestamp) ||
    (data.sourceEventId !== undefined &&
      typeof data.sourceEventId !== 'string') ||
    !Array.isArray(data.mods)
  ) {
    return state;
  }

  const mods: ClaudeModsSkippedEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of data.mods.slice(0, 50)) {
    if (!isClaudeModsSkippedEntry(candidate)) continue;
    const key = `${candidate.pluginId}\u0000${candidate.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mods.push({ pluginId: candidate.pluginId, reason: candidate.reason });
  }
  if (mods.length === 0) return state;

  const sourceEventId =
    typeof data.sourceEventId === 'string' ? data.sourceEventId : undefined;
  if (
    sourceEventId !== undefined &&
    state.messages.some((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'claude_mods_skipped' &&
          block.sourceEventId === sourceEventId,
      ),
    )
  ) {
    return { ...state, lastEventAt: options.now };
  }

  const block: ClaudeModsSkippedBlock = {
    type: 'claude_mods_skipped',
    timestamp: data.timestamp,
    mods,
    ...(sourceEventId !== undefined ? { sourceEventId } : {}),
  };
  if (!isClaudeModsSkippedBlock(block)) return state;

  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: sourceEventId ?? options.createMessageId(),
        role: 'system',
        blocks: [block],
        timestamp: block.timestamp,
      },
    ],
    lastEventAt: options.now,
  };
}

function asInterfaceMode(
  value: unknown,
  fallback: ChatInterfaceMode = 'canopy',
): ChatInterfaceMode {
  return value === 'claude-code' || value === 'canopy' ? value : fallback;
}

function asAgentProvider(
  value: unknown,
  fallback: AgentProviderType,
): AgentProviderType {
  if (value === 'claude' || value === 'codex' || value === 'ollama') {
    return value;
  }
  return fallback;
}

/**
 * Build a `compaction_info` block from a `canopy_compaction` synthetic event
 * envelope. The shape mirrors the persisted block (see
 * {@link CompactionInfoBlock}) and is tolerant of missing optional fields.
 */
function applyCanopyCompactionEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
  defaultProvider: AgentProviderType,
): TranscriptReducerState {
  const provider = asAgentProvider(data.provider, defaultProvider);
  const interfaceMode = asInterfaceMode(data.interfaceMode);
  const timestamp =
    typeof data.timestamp === 'number' ? data.timestamp : options.now;
  const block: CompactionInfoBlock = {
    type: 'compaction_info',
    timestamp,
    provider,
    interfaceMode,
    ...(typeof data.sessionId === 'string'
      ? { sessionId: data.sessionId }
      : {}),
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
    ...(typeof data.transcriptPath === 'string'
      ? { transcriptPath: data.transcriptPath }
      : {}),
    ...(typeof data.sourceEventId === 'string'
      ? { sourceEventId: data.sourceEventId }
      : {}),
  };

  return appendCompactionBlock(state, block, options);
}

/**
 * Per-Claude-event handler. Returns the next reducer state. Pure: must not
 * read or write any module-level state besides what is provided through
 * `state` and `options`.
 */
type ClaudeEventHandler = (
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
) => TranscriptReducerState;

function handleClaudeSystemEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const turnUserMessageId =
    typeof data.canopy_turn_user_message_id === 'string'
      ? data.canopy_turn_user_message_id
      : undefined;
  const isCurrentTurnLivenessEvent =
    (data.subtype === 'init' || data.subtype === 'thinking_tokens') &&
    turnUserMessageId !== undefined &&
    turnUserMessageId === findTurnUserMessageId(state.messages);
  const liveMessages = isCurrentTurnLivenessEvent
    ? ensureOpenTurnTimerForContinuation(state, options)
    : state.messages;

  if (data.subtype === 'init' && typeof data.session_id === 'string') {
    return {
      ...state,
      ...(isCurrentTurnLivenessEvent
        ? { status: 'streaming' as const, messages: liveMessages }
        : {}),
      sdkSessionId: data.session_id,
      lastEventAt: options.now,
    };
  }

  // Claude Agent SDK emits a `system`/`compact_boundary` event when an
  // automatic or `/compact` compaction settles. The shape carries optional
  // metadata under `compact_metadata` plus a `session_id` for correlation.
  if (data.subtype === 'compact_boundary') {
    const compactMetadata = isRecord(data.compact_metadata)
      ? data.compact_metadata
      : undefined;
    const sessionId =
      typeof data.session_id === 'string' ? data.session_id : undefined;
    const reason =
      typeof compactMetadata?.trigger === 'string'
        ? compactMetadata.trigger
        : undefined;
    const summary =
      typeof compactMetadata?.summary === 'string'
        ? compactMetadata.summary
        : typeof data.summary === 'string'
          ? data.summary
          : undefined;
    const transcriptPath =
      typeof compactMetadata?.transcript_path === 'string'
        ? compactMetadata.transcript_path
        : typeof data.transcript_path === 'string'
          ? data.transcript_path
          : undefined;
    const sourceEventId =
      typeof data.uuid === 'string'
        ? data.uuid
        : typeof data.event_id === 'string'
          ? data.event_id
          : typeof compactMetadata?.event_id === 'string'
            ? compactMetadata.event_id
            : undefined;
    const block: CompactionInfoBlock = {
      type: 'compaction_info',
      timestamp: options.now,
      provider: 'claude',
      interfaceMode: 'canopy',
      ...(sessionId ? { sessionId } : {}),
      ...(reason ? { reason } : {}),
      ...(summary ? { summary } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(sourceEventId ? { sourceEventId } : {}),
    };
    return appendCompactionBlock(state, block, options);
  }

  // Sent as the CLI exits, after the last result: report it as its own row.
  if (data.subtype === 'session_writes_lost') {
    const text = `Error: ${claudeSessionWritesLostMessage(data)}`;
    const last = state.messages[state.messages.length - 1];
    if (last?.role === 'system' && messageHasTextBlock(last, text)) {
      return { ...state, lastEventAt: options.now };
    }
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: createUnusedMessageId(state.messages, options),
          role: 'system',
          blocks: [{ type: 'text', text }],
          timestamp: options.now,
        },
      ],
      lastEventAt: options.now,
    };
  }

  if (
    (data.subtype === 'task_progress' ||
      data.subtype === 'task_notification') &&
    typeof data.parent_tool_use_id === 'string' &&
    isRecord(data.usage)
  ) {
    const parentToolUseId = data.parent_tool_use_id;
    const previous =
      state.agentUsage?.[parentToolUseId] ?? defaultAgentUsage(state);
    return {
      ...state,
      agentUsage: {
        ...(state.agentUsage ?? {}),
        [parentToolUseId]: {
          ...previous,
          toolUses:
            typeof data.usage.tool_uses === 'number'
              ? data.usage.tool_uses
              : previous.toolUses,
          durationMs:
            typeof data.usage.duration_ms === 'number'
              ? data.usage.duration_ms
              : previous.durationMs,
        },
      },
      lastEventAt: options.now,
    };
  }

  return {
    ...state,
    ...(isCurrentTurnLivenessEvent
      ? { status: 'streaming' as const, messages: liveMessages }
      : {}),
    lastEventAt: options.now,
  };
}

const CLAUDE_USAGE_LIMIT_DEFAULT_MESSAGE = 'Claude usage limit reached.';
/**
 * Fixed copy for every Codex usage-limit state. The raw OpenAI text carries
 * upsell and purchase links and is projected to the Portal summary, so it never
 * reaches `state.error`, a subagent thread, or the banner (CAN-4564).
 */
const CODEX_USAGE_LIMIT_MESSAGE = 'Codex usage limit reached.';

/**
 * Tiny deterministic string hash (djb2-ish) used only to build a stable,
 * compact `dismissKey` when the SDK event carries no `request_id`. Not
 * security-sensitive — just dedupe identity.
 */
function hashUsageLimitString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Build the sanitized {@link LlmProviderUsageLimitBannerState} for a detected
 * usage-limit event. `dismissKey` prefers the assistant event's `request_id`.
 * Result events do not expose a renderer-visible request id, so their fallback
 * identity must be derived from stable transcript state rather than parse time;
 * `detectedAt` is display metadata only.
 */
function buildLlmProviderUsageLimitBannerState(args: {
  provider?: 'claude' | 'codex';
  message: string;
  detectedAt: number;
  requestId?: string;
  fallbackIdentity?: string;
  resetsAt?: number;
}): LlmProviderUsageLimitBannerState {
  const {
    provider = 'claude',
    message,
    detectedAt,
    requestId,
    fallbackIdentity,
    resetsAt,
  } = args;
  const dismissKey =
    typeof requestId === 'string' && requestId.length > 0
      ? requestId
      : `usage-limit:${hashUsageLimitString(fallbackIdentity ?? message)}`;
  return {
    provider,
    message,
    detectedAt,
    ...(typeof requestId === 'string' && requestId.length > 0
      ? { requestId }
      : {}),
    dismissKey,
    ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt)
      ? { resetsAt }
      : {}),
  };
}

function messageIdInUse(messages: ChatMessage[], candidate: string): boolean {
  return messages.some((message) => message.id === candidate);
}

/**
 * Deterministically de-duplicate a wire-derived id within one transcript.
 *
 * The Claude CLI stream-json path can emit multiple `assistant` events sharing
 * one SDK `message.id` (one event per content block). The wire projector
 * upserts them onto ONE portal row (last write wins), while the renderer keeps
 * each event as its own persisted message. Mapping decision: the FIRST parsed
 * message keeps the wire base id (so the persisted re-push upserts onto the
 * live wire row), and later same-id messages get `:2`, `:3`, … suffixes —
 * renderer-only extra rows that add the remaining content without colliding.
 */
function ensureUniqueMessageId(
  messages: ChatMessage[],
  baseId: string,
): string {
  if (!messageIdInUse(messages, baseId)) {
    return baseId;
  }
  let ordinal = 2;
  let candidate = `${baseId}:${String(ordinal)}`;
  while (messageIdInUse(messages, candidate)) {
    ordinal += 1;
    candidate = `${baseId}:${String(ordinal)}`;
  }
  return candidate;
}

/**
 * Id of the current turn's user prompt message (the last `user` message with a
 * text block). This equals the wire projector's `userMessageId`: the renderer
 * mints the id when sending (`sendMessage({ userMessageId: userMsg.id })`) and
 * the main process round-trips it as `canopy_turn_user_message_id`, which
 * `buildSyntheticUserPromptMessage` reuses on replayed prompts.
 */
function findTurnUserMessageId(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isUserPromptBoundaryMessage(message)) {
      return message.id;
    }
  }
  return undefined;
}

function resolveClaudeWireMessageId(
  messages: ChatMessage[],
  data: Record<string, unknown>,
  toolResultToolUseId?: string,
): string | undefined {
  const wireId = deriveRuntimeChatMessageId(data, toolResultToolUseId);
  if (wireId !== undefined) {
    return wireId;
  }
  const turnUserMessageId =
    typeof data.canopy_turn_user_message_id === 'string'
      ? data.canopy_turn_user_message_id
      : findTurnUserMessageId(messages);
  return turnUserMessageId !== undefined
    ? `${turnUserMessageId}:assistant`
    : undefined;
}

/**
 * Wire-converged id for a message parsed from a Claude SDK event.
 *
 * The persisted transcript is re-pushed to the portal keyed by these ids
 * (`projectPersistedChatTranscript` uses `message.id` verbatim), so they must
 * match what the live wire emitted for the same event:
 *
 *  1. the shared {@link deriveRuntimeChatMessageId} derivation
 *     (`tool:<toolUseId>` / `message.id` / `uuid` / `message_id` / `id`),
 *  2. the wire's per-turn fallback `` `${userMessageId}:assistant` `` when the
 *     event carries no id but the turn's user prompt is known,
 *  3. a locally minted id otherwise (no wire counterpart exists to converge
 *     with — the wire callers always pass a per-turn fallback, but a transcript
 *     replayed without any user prompt has nothing deterministic to key on).
 *
 * Collisions are suffixed via {@link ensureUniqueMessageId}.
 */
function resolveClaudeEventMessageId(
  messages: ChatMessage[],
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
  toolResultToolUseId?: string,
): string {
  const wireId = resolveClaudeWireMessageId(
    messages,
    data,
    toolResultToolUseId,
  );
  if (wireId !== undefined) {
    return ensureUniqueMessageId(messages, wireId);
  }
  return options.createMessageId();
}

/**
 * Chain uuid of a top-level Claude SDK event, for point-in-time fork/resume.
 *
 * Only main-chain frames qualify: a sidechain (subagent) frame carries
 * `parent_tool_use_id`, and its uuid is not a fork point on the parent
 * session's chain, so stamping it would hand `resumeSessionAt` an id the CLI
 * cannot resolve against the conversation the fork actually kept.
 */
function claudeChainUuid(data: Record<string, unknown>): string | undefined {
  if (typeof data.parent_tool_use_id === 'string') return undefined;
  return typeof data.uuid === 'string' && data.uuid.length > 0
    ? data.uuid
    : undefined;
}

/**
 * The restored marked body on a Claude failure frame that main stamped with its
 * own no-billing-source verdict (CAN-3732), or `null`.
 *
 * Main writes the restored body into the harness's synthetic assistant error
 * frame and the terminal result. Both are failures, not answers: left as
 * assistant prose, the marker JSON would render verbatim, because the desktop
 * notice and the Portal summary only replace system/failed rows. Gated on the
 * trusted stamp and the failure shape, so an answer that quotes the marker
 * keeps its normal rendering.
 */
function readStampedClaudeProxyFailureText(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  text: string | undefined,
): string | null {
  // Codex re-reports its failed turn as a Claude-shaped result; its own
  // reducer already rendered that failure, so this projection is Claude-only.
  if (
    state.providerType === 'codex' ||
    data.subtype === 'codex_error' ||
    !isAiCreditsFailureEventShape(data, 'claude') ||
    !hasNoBillingSourceStamp(data) ||
    text === undefined
  ) {
    return null;
  }
  const trimmed = text.trim();
  return trimmed && parseCanopyProxyError(trimmed) ? trimmed : null;
}

function isSingleTextMessage(
  message: ChatMessage | undefined,
  role: ChatMessage['role'],
  text: string,
): message is ChatMessage {
  const block = message?.blocks[0];
  return (
    message?.role === role &&
    message.blocks.length === 1 &&
    block?.type === 'text' &&
    block.text.trim().replace(/^Error:\s*/, '') === text
  );
}

/** A delayed repeat must not reopen recovery or append a notice on a later turn. */
function isRepeatedHistoricalClaudeProxyFailure(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
): boolean {
  if (
    !hasNoBillingSourceStamp(data) ||
    !isAiCreditsFailureEventShape(data, 'claude')
  )
    return false;
  const turnId = data.canopy_turn_user_message_id;
  if (
    typeof turnId !== 'string' ||
    turnId === findTurnUserMessageId(state.messages)
  )
    return false;
  const message = isRecord(data.message) ? data.message : undefined;
  const content: unknown[] = Array.isArray(message?.content)
    ? message.content
    : [];
  const text =
    data.type === 'result'
      ? asString(data.result)
      : typeof data.error === 'string' && data.type === 'error'
        ? data.error
        : content
            .filter(isRecord)
            .filter((block) => block.type === 'text')
            .map((block) => asString(block.text))
            .join('\n');
  const restored = readStampedClaudeProxyFailureText(state, data, text);
  if (restored === null) return false;
  const promptIndex = state.messages.findIndex(
    (candidate) => candidate.id === turnId && candidate.role === 'user',
  );
  if (promptIndex < 0) return false;
  for (let index = promptIndex + 1; index < state.messages.length; index += 1) {
    const candidate = state.messages[index];
    if (isUserPromptBoundaryMessage(candidate)) break;
    if (isSingleTextMessage(candidate, 'system', restored)) return true;
  }
  return false;
}

/**
 * Show a stamped Claude proxy failure exactly once, as the system row both
 * transcript surfaces render as the proxy notice. The assistant frame and the
 * terminal result carry the same body, so the result promotes or reuses the
 * row the frame produced instead of adding a second notice.
 */
function upsertClaudeProxyFailureRow(
  messages: ChatMessage[],
  data: Record<string, unknown>,
  text: string,
  options: TranscriptReducerOptions,
): ChatMessage[] {
  // Only the current turn: an identical refusal on an earlier turn is a
  // genuine repeat and must stay visible.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === 'user') break;
    if (isSingleTextMessage(candidate, 'system', text)) return messages;
    if (isSingleTextMessage(candidate, 'assistant', text)) {
      return messages.map((existing, existingIndex) =>
        existingIndex === index ? { ...existing, role: 'system' } : existing,
      );
    }
  }
  return [
    ...messages,
    {
      id: resolveClaudeEventMessageId(messages, data, options),
      role: 'system',
      blocks: [{ type: 'text', text }],
      timestamp: options.now,
    },
  ];
}

function handleClaudeAssistantEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const message = isRecord(data.message) ? data.message : undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const sourceSlots: Array<{ sourceIndex: number; blockOrdinal: number }> = [];
  const displayErrorCode = data.canopy_display_error_code;
  const blocks = parseClaudeAssistantBlocks(
    content,
    options.onToolBlock
      ? (sourceIndex, blockOrdinal): void => {
          if (sourceSlots.length < (options.toolBlockCaptureLimit ?? 65))
            sourceSlots.push({ sourceIndex, blockOrdinal });
        }
      : undefined,
  ).map((block): ChatMessage['blocks'][number] =>
    block.type === 'text' &&
    isClaudeAiCreditsFallbackErrorCode(displayErrorCode)
      ? { ...block, errorCode: displayErrorCode }
      : block,
  );

  const proxyFailureText = readStampedClaudeProxyFailureText(
    state,
    data,
    blocks.length > 0 && blocks.every((block) => block.type === 'text')
      ? blocks
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n')
      : undefined,
  );
  if (proxyFailureText !== null) {
    return {
      ...state,
      messages: upsertClaudeProxyFailureRow(
        state.messages,
        data,
        proxyFailureText,
        options,
      ),
      lastEventAt: options.now,
    };
  }

  // Structured Claude usage-limit detection: the assistant SDK event exposes a
  // top-level `error` union whose members include `'rate_limit'`. We never read
  // visible message text. This is independent from the result-event detection.
  const isClaudeUsageLimitAssistant =
    data.type === 'assistant' && data.error === 'rate_limit';
  const usageLimitBanner = isClaudeUsageLimitAssistant
    ? buildLlmProviderUsageLimitBannerState({
        message: CLAUDE_USAGE_LIMIT_DEFAULT_MESSAGE,
        detectedAt: options.now,
        requestId:
          typeof data.request_id === 'string' ? data.request_id : undefined,
        fallbackIdentity: [
          'assistant',
          String(state.messages.length),
          CLAUDE_USAGE_LIMIT_DEFAULT_MESSAGE,
        ].join('\0'),
      })
    : undefined;

  if (blocks.length === 0) {
    // A rate-limit assistant event can arrive with no renderable content; still
    // surface the banner metadata without mutating `messages`.
    return usageLimitBanner
      ? {
          ...state,
          llmProviderUsageLimitBanner: usageLimitBanner,
          lastEventAt: options.now,
        }
      : state;
  }

  const parentToolUseId =
    typeof data.parent_tool_use_id === 'string'
      ? data.parent_tool_use_id
      : undefined;
  const chainUuid = claudeChainUuid(data);
  const turnId =
    typeof data.canopy_turn_user_message_id === 'string'
      ? data.canopy_turn_user_message_id
      : undefined;
  const wireId = deriveRuntimeChatMessageId(data);
  // Runtime status can already be streaming before the first foreground
  // frame arrives. Repair its timer, but never let child/replay/error frames
  // reopen a settled turn. SDK continuations may omit the turn tag.
  const freshForegroundWork =
    parentToolUseId === undefined &&
    (data.error === undefined || data.error === null) &&
    (turnId === undefined ||
      turnId === findTurnUserMessageId(state.messages)) &&
    !state.messages.some(
      (existing) =>
        (chainUuid !== undefined && existing.claudeUuid === chainUuid) ||
        (wireId !== undefined && existing.id === wireId),
    );
  const baseMessages = freshForegroundWork
    ? ensureOpenTurnTimerForContinuation(state, options, true)
    : state.messages;
  const assistantMessage: ChatMessage = {
    // Wire-converged id (see resolveClaudeEventMessageId): the persisted
    // transcript re-push must upsert onto the live portal row for this event.
    id: resolveClaudeEventMessageId(baseMessages, data, options),
    role: 'assistant',
    blocks,
    timestamp: options.now,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    ...(chainUuid ? { claudeUuid: chainUuid } : {}),
  };
  const updatedMessages: ChatMessage[] = [...baseMessages, assistantMessage];
  for (const slot of sourceSlots) {
    options.onToolBlock?.(
      String(slot.sourceIndex),
      assistantMessage,
      slot.blockOrdinal,
      baseMessages,
    );
  }

  const entersPlanMode = blocks.some(
    (block) => block.type === 'tool_use' && block.toolName === 'EnterPlanMode',
  );
  const exitsPlanMode = blocks.some(
    (block) => block.type === 'tool_use' && block.toolName === 'ExitPlanMode',
  );

  const isTopLevel = parentToolUseId === undefined;
  const messageUsage =
    isTopLevel && isRecord(message?.usage) ? message.usage : undefined;
  const messageModel =
    isTopLevel && typeof message?.model === 'string' ? message.model : '';
  const detectedMessageModel = messageModel
    ? resolveKnownModel(messageModel)
    : undefined;
  const selectedModelChanged =
    typeof state.model === 'string' &&
    state.model.length > 0 &&
    detectedMessageModel !== undefined &&
    resolveComparableModel(state.model) !==
      resolveComparableModel(detectedMessageModel);
  const contextTokens =
    messageUsage && typeof messageUsage.input_tokens === 'number'
      ? messageUsage.input_tokens +
        (typeof messageUsage.cache_read_input_tokens === 'number'
          ? messageUsage.cache_read_input_tokens
          : 0) +
        (typeof messageUsage.cache_creation_input_tokens === 'number'
          ? messageUsage.cache_creation_input_tokens
          : 0)
      : undefined;
  let usage = state.usage;
  if (contextTokens !== undefined) {
    const previousUsage = state.usage ?? defaultUsage();
    usage = {
      ...previousUsage,
      contextTokens,
      contextWindow: resolveContextWindow(
        previousUsage.contextWindow,
        undefined,
        state.model,
        options.aiCreditsRouted === true,
      ),
      ...(messageModel ? { model: messageModel } : {}),
    };
  }

  let agentUsage = state.agentUsage;
  if (parentToolUseId && isRecord(message?.usage)) {
    const previous =
      state.agentUsage?.[parentToolUseId] ?? defaultAgentUsage(state);
    const latestContext =
      (typeof message.usage.input_tokens === 'number'
        ? message.usage.input_tokens
        : 0) +
      (typeof message.usage.cache_read_input_tokens === 'number'
        ? message.usage.cache_read_input_tokens
        : 0) +
      (typeof message.usage.cache_creation_input_tokens === 'number'
        ? message.usage.cache_creation_input_tokens
        : 0);
    agentUsage = {
      ...(state.agentUsage ?? {}),
      [parentToolUseId]: {
        contextTokens: latestContext,
        contextWindow: previous.contextWindow,
        outputTokens:
          previous.outputTokens +
          (typeof message.usage.output_tokens === 'number'
            ? message.usage.output_tokens
            : 0),
        cacheReadInputTokens:
          previous.cacheReadInputTokens +
          (typeof message.usage.cache_read_input_tokens === 'number'
            ? message.usage.cache_read_input_tokens
            : 0),
        cacheCreationInputTokens:
          previous.cacheCreationInputTokens +
          (typeof message.usage.cache_creation_input_tokens === 'number'
            ? message.usage.cache_creation_input_tokens
            : 0),
        apiCalls: previous.apiCalls + 1,
        toolUses: previous.toolUses,
        durationMs: previous.durationMs,
        model:
          typeof message.model === 'string' ? message.model : previous.model,
      },
    };
  }

  let currentTodos = state.currentTodos;
  let currentTaskTodos = state.currentTaskTodos;
  if (!parentToolUseId) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block.type === 'tool_use' && block.toolName === 'TodoWrite') {
        currentTodos = parseTodoItems(block.input);
        break;
      }
    }
    currentTaskTodos = applyTaskToolUseBlocks(currentTaskTodos, blocks);
  }

  const assistantMessages = exitsPlanMode
    ? completeTurnTimer(updatedMessages, resolveTurnCompletedAt(data, options))
    : updatedMessages;
  const messages =
    selectedModelChanged && state.model && detectedMessageModel
      ? appendClaudeModelChangeMessage(
          assistantMessages,
          {
            previousModel: state.model,
            detectedModel: detectedMessageModel,
            rawDetectedModel: messageModel,
          },
          options,
        )
      : assistantMessages;

  return {
    ...state,
    status: freshForegroundWork ? 'streaming' : state.status,
    messages,
    ...(entersPlanMode ? { planMode: true } : {}),
    ...(usage ? { usage } : {}),
    ...(agentUsage ? { agentUsage } : {}),
    ...(currentTodos !== state.currentTodos ? { currentTodos } : {}),
    ...(currentTaskTodos !== state.currentTaskTodos
      ? { currentTaskTodos }
      : {}),
    ...(usageLimitBanner
      ? { llmProviderUsageLimitBanner: usageLimitBanner }
      : {}),
    lastEventAt: options.now,
  };
}

function handleClaudeUserEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const message = isRecord(data.message) ? data.message : undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  // Replay guard for provider-native logs: live events are already stripped
  // before they reach the parser. The scan runs at most once per event, and
  // only for a tool result that carries an image.
  let previewToolIds: Set<string> | undefined;
  const lookupPreviewToolIds = (): ReadonlySet<string> => {
    if (previewToolIds) return previewToolIds;
    previewToolIds = new Set<string>();
    for (const prior of state.messages) {
      for (const block of prior.blocks) {
        if (
          block.type === 'tool_use' &&
          /^mcp__.+__PreviewVisual$/.test(block.toolName)
        )
          previewToolIds.add(block.toolUseId);
      }
    }
    return previewToolIds;
  };
  const replayContent = content.map((block: unknown): unknown => {
    if (
      isRecord(block) &&
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some(
        (entry: unknown): boolean => isRecord(entry) && entry.type === 'image',
      ) &&
      lookupPreviewToolIds().has(asString(block.tool_use_id))
    ) {
      return { ...block, content: withoutPreviewVisualImages(block.content) };
    }
    return block;
  });
  const sourceSlots: Array<{ sourceIndex: number; blockOrdinal: number }> = [];
  const blocks = parseClaudeToolResults(
    replayContent,
    options.onToolBlock
      ? (sourceIndex, blockOrdinal): void => {
          if (sourceSlots.length < (options.toolBlockCaptureLimit ?? 65))
            sourceSlots.push({ sourceIndex, blockOrdinal });
        }
      : undefined,
  );
  if (blocks.length === 0) {
    return state;
  }

  const parentToolUseId =
    typeof data.parent_tool_use_id === 'string'
      ? data.parent_tool_use_id
      : undefined;
  // A delayed tool result is not evidence that the foreground agent resumed.
  // The next assistant work frame owns reopening a completed timer.
  const baseMessages = withoutPriorToolResults(state.messages, blocks);
  // Mirror the wire projector: a tool_result user event keys by its FIRST
  // tool_result's tool_use_id (`tool:<id>`); an empty id falls through to the
  // event-level id derivation, exactly like `runtimeMessageId` on the wire.
  const firstToolResult = blocks.find(
    (block): block is ChatBlock & { type: 'tool_result' } =>
      block.type === 'tool_result',
  );
  const chainUuid = claudeChainUuid(data);
  const toolResultMessage: ChatMessage = {
    id: resolveClaudeEventMessageId(
      baseMessages,
      data,
      options,
      firstToolResult?.toolUseId,
    ),
    role: 'system',
    blocks,
    timestamp: options.now,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    ...(chainUuid ? { claudeUuid: chainUuid } : {}),
  };
  for (const slot of sourceSlots) {
    options.onToolBlock?.(
      String(slot.sourceIndex),
      toolResultMessage,
      slot.blockOrdinal,
      baseMessages,
    );
  }
  return {
    ...state,
    status: state.status,
    messages: [...baseMessages, toolResultMessage],
    lastEventAt: options.now,
  };
}

function handleClaudeResultEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const usage = isRecord(data.usage) ? data.usage : undefined;
  const previous = state.usage ?? defaultUsage();
  // Antigravity usage is a per-turn measurement, not a model-selection event.
  // Its retained model may predate the user's next-turn selection.
  const rawDetectedModel =
    data.provider !== 'antigravity' &&
    typeof previous.model === 'string' &&
    previous.model.length > 0
      ? previous.model
      : undefined;
  const detectedModel = rawDetectedModel
    ? resolveKnownModel(rawDetectedModel)
    : undefined;
  const selectedModel = detectedModel ?? state.model;
  const modelUsage = parseResultModelUsage(
    data.modelUsage,
    rawDetectedModel ?? selectedModel,
  );
  const sessionContinues = data.canopy_session_continues === true;
  const selectedModelChanged =
    !sessionContinues &&
    typeof state.model === 'string' &&
    state.model.length > 0 &&
    detectedModel !== undefined &&
    resolveComparableModel(state.model) !==
      resolveComparableModel(detectedModel);

  // Structured Claude usage-limit detection on the result event. `api_error_status`
  // exists only on the success-shaped result (`SDKResultSuccess`); a `429`
  // alongside `is_error === true` is normally the rate-limit signal. Claude can
  // also attach 429 to an expired OAuth failure, which must remain an auth issue
  // and must not create a usage warning. Independent from assistant detection.
  const isClaudeUsageLimitResult =
    data.type === 'result' &&
    data.is_error === true &&
    data.api_error_status === 429 &&
    !isClaudeAuthenticationFailureMessage(data.result);
  const usageLimitBanner = isClaudeUsageLimitResult
    ? buildLlmProviderUsageLimitBannerState({
        message:
          typeof data.result === 'string' && data.result.length > 0
            ? data.result
            : CLAUDE_USAGE_LIMIT_DEFAULT_MESSAGE,
        detectedAt: options.now,
        fallbackIdentity: [
          'result',
          String(state.messages.length),
          typeof data.result === 'string' && data.result.length > 0
            ? data.result
            : CLAUDE_USAGE_LIMIT_DEFAULT_MESSAGE,
        ].join('\0'),
      })
    : undefined;

  const closedMessages = sessionContinues
    ? ensureOpenTurnTimerForContinuation(state, options)
    : closeOpenToolUseBlocks(
        completeTurnTimer(
          state.messages,
          resolveTurnCompletedAt(data, options),
        ),
        options.createMessageId,
        options.now,
        childToolCloseContext(state, data, options),
      );
  const messages =
    selectedModelChanged && state.model && detectedModel
      ? appendClaudeModelChangeMessage(
          closedMessages,
          {
            previousModel: state.model,
            detectedModel,
            ...(rawDetectedModel ? { rawDetectedModel } : {}),
            ...(typeof data.num_turns === 'number'
              ? { turnNumber: data.num_turns }
              : {}),
          },
          options,
        )
      : closedMessages;
  const proxyFailureText = readStampedClaudeProxyFailureText(
    state,
    data,
    typeof data.result === 'string' ? data.result : undefined,
  );
  const authRecoveryMessage =
    data.is_error === true &&
    typeof data.result === 'string' &&
    isClaudeAuthenticationFailureMessage(data.result)
      ? data.result
      : null;
  let messagesWithAuthRecovery = messages;
  const displayErrorCode = data.canopy_display_error_code;
  if (
    data.is_error === true &&
    isClaudeAiCreditsFallbackErrorCode(displayErrorCode)
  ) {
    const rawError = claudeResultErrorMessage(data);
    let alreadyShown = false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message) continue;
      if (message.role === 'user') break;
      if (
        message.blocks.some(
          (block) =>
            block.type === 'text' &&
            block.errorCode === displayErrorCode &&
            block.text === rawError,
        )
      ) {
        alreadyShown = true;
        break;
      }
    }
    if (!alreadyShown) {
      messagesWithAuthRecovery = [
        ...messages,
        {
          id: resolveClaudeEventMessageId(messages, data, options),
          role: 'system',
          blocks: [
            { type: 'text', text: rawError, errorCode: displayErrorCode },
          ],
          timestamp: options.now,
        },
      ];
    }
  }
  if (authRecoveryMessage) {
    const trailingMessage = messages[messages.length - 1];
    const trailingTextBlock = trailingMessage?.blocks[0];
    const repeatsTrailingAssistantMessage =
      trailingMessage?.role === 'assistant' &&
      trailingMessage.blocks.length === 1 &&
      trailingTextBlock?.type === 'text' &&
      trailingTextBlock.text === authRecoveryMessage;

    if (repeatsTrailingAssistantMessage) {
      const promotedMessage: ChatMessage = {
        ...trailingMessage,
        role: 'system',
      };
      messagesWithAuthRecovery = [...messages.slice(0, -1), promotedMessage];
    } else {
      const recoveryMessageId =
        resolveClaudeWireMessageId(messages, data) ?? options.createMessageId();
      const recoveryMessage: ChatMessage = {
        id: recoveryMessageId,
        role: 'system',
        blocks: [{ type: 'text', text: authRecoveryMessage }],
        timestamp: options.now,
      };
      const existingMessageIndex = messages.findIndex(
        (message) => message.id === recoveryMessageId,
      );
      messagesWithAuthRecovery =
        existingMessageIndex === -1
          ? [...messages, recoveryMessage]
          : messages.map((message, index) =>
              index === existingMessageIndex ? recoveryMessage : message,
            );
    }
  }

  if (proxyFailureText !== null) {
    messagesWithAuthRecovery = upsertClaudeProxyFailureRow(
      messagesWithAuthRecovery,
      data,
      proxyFailureText,
      options,
    );
  }

  if (
    data.is_error === true &&
    typeof data.canopy_provider_error_details === 'string' &&
    data.canopy_provider_error_details.length > 0
  ) {
    messagesWithAuthRecovery = [
      ...messagesWithAuthRecovery,
      {
        id: resolveClaudeEventMessageId(
          messagesWithAuthRecovery,
          data,
          options,
        ),
        role: 'system',
        blocks: [
          {
            type: 'text',
            text: claudeResultErrorMessage(data),
            providerErrorDetails: data.canopy_provider_error_details,
          },
        ],
        timestamp: options.now,
      },
    ];
  }

  return {
    ...state,
    status:
      data.is_error === true
        ? 'error'
        : sessionContinues
          ? 'streaming'
          : 'idle',
    error: data.is_error === true ? claudeResultErrorMessage(data) : null,
    ...(!sessionContinues &&
    detectedModel &&
    (selectedModelChanged || !state.model)
      ? { model: detectedModel }
      : {}),
    messages: messagesWithAuthRecovery,
    usage: {
      ...previous,
      totalCostUsd:
        typeof data.total_cost_usd === 'number'
          ? data.total_cost_usd
          : previous.totalCostUsd,
      inputTokens:
        usage && typeof usage.input_tokens === 'number'
          ? usage.input_tokens
          : previous.inputTokens,
      outputTokens:
        usage && typeof usage.output_tokens === 'number'
          ? usage.output_tokens
          : previous.outputTokens,
      cacheReadInputTokens:
        usage && typeof usage.cache_read_input_tokens === 'number'
          ? usage.cache_read_input_tokens
          : previous.cacheReadInputTokens,
      cacheCreationInputTokens:
        usage && typeof usage.cache_creation_input_tokens === 'number'
          ? usage.cache_creation_input_tokens
          : previous.cacheCreationInputTokens,
      durationMs:
        typeof data.duration_ms === 'number'
          ? data.duration_ms
          : previous.durationMs,
      durationApiMs:
        typeof data.duration_api_ms === 'number'
          ? data.duration_api_ms
          : previous.durationApiMs,
      numTurns:
        typeof data.num_turns === 'number' ? data.num_turns : previous.numTurns,
      contextWindow:
        state.providerType === 'opencode'
          ? (previous.opencodeReportedUsage?.context?.maxTokens ?? 0)
          : state.providerType === 'cursor'
            ? 0
            : resolveContextWindow(
                previous.contextWindow,
                modelUsage?.contextWindow,
                selectedModel,
                options.aiCreditsRouted === true,
              ),
      maxOutputTokens:
        modelUsage && typeof modelUsage.maxOutputTokens === 'number'
          ? modelUsage.maxOutputTokens
          : previous.maxOutputTokens,
      // ACP reports are per prompt. Never inherit an earlier turn's counters
      // or use the cumulative fields to represent missing measurements.
      ...(data.provider === 'antigravity'
        ? {
            ...defaultUsage(),
            contextWindow: 0,
            model: previous.model,
            reportedTurnUsage: parseAntigravityTurnUsage(data.usage),
          }
        : {}),
    },
    ...(usageLimitBanner
      ? { llmProviderUsageLimitBanner: usageLimitBanner }
      : {}),
    lastEventAt: options.now,
  };
}

function handleClaudeErrorEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const error = typeof data.error === 'string' ? data.error : 'Unknown error';
  const trimmedError = error.trim();
  const isUserCancellation =
    /^(?:session aborted|turn cancelled|cancelled)$/i.test(trimmedError) ||
    /aborted by user/i.test(trimmedError);
  const message = isRecord(data.message) ? data.message : undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const detailedError = content.find(
    (block): block is Record<string, unknown> =>
      isRecord(block) &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0,
  );
  const displayError =
    detailedError && typeof detailedError.text === 'string'
      ? detailedError.text
      : error;
  const messages = closeOpenToolUseBlocks(
    completeTurnTimer(state.messages, resolveTurnCompletedAt(data, options)),
    options.createMessageId,
    options.now,
    childToolCloseContext(state, data, options),
  );
  return {
    ...state,
    status: 'error',
    error,
    messages: isUserCancellation
      ? messages
      : [
          ...messages,
          {
            id: options.createMessageId(),
            role: 'system',
            blocks: [
              typeof data.canopy_provider_error_details === 'string' &&
              data.canopy_provider_error_details.length > 0
                ? {
                    type: 'text',
                    text: error,
                    providerErrorDetails: data.canopy_provider_error_details,
                  }
                : { type: 'text', text: `Error: ${displayError}` },
            ],
            timestamp: options.now,
          },
        ],
    lastEventAt: options.now,
  };
}

const CLAUDE_EVENT_HANDLERS: Record<string, ClaudeEventHandler> = {
  system: handleClaudeSystemEvent,
  assistant: handleClaudeAssistantEvent,
  user: handleClaudeUserEvent,
  result: handleClaudeResultEvent,
  error: handleClaudeErrorEvent,
};

interface CodexItemContext {
  onToolBlock?: TranscriptReducerOptions['onToolBlock'];
  /** Codex `threadId` of the routable wire event that produced this item. */
  threadId?: string;
  /** Codex `turnId` of the routable wire event that produced this item. */
  turnId?: string;
  /**
   * Root Codex thread for this chat (typically `state.sdkSessionId`).
   * Passed in so `upsertCodexItem` can decide whether an event belongs to the
   * root or to a subagent without re-walking the full reducer state.
   */
  rootThreadId?: string;
  previewToolResults?: boolean;
  /** Format 4: `function_call_output` stays lossless for storage. */
  losslessFunctionOutput?: boolean;
  /** Trusted prepared body for this event's item; see {@link preparedOutputFor}. */
  preparedOutput?: PreparedCodexItemOutput;
}

/** Prepared output applies only to format 4 and `item.completed` of its item. */
function preparedOutputFor(
  options: TranscriptReducerOptions,
  eventType: unknown,
  item: Record<string, unknown> | undefined,
): PreparedCodexItemOutput | undefined {
  const prepared = options.preparedCodexItem;
  return options.transcriptStorageFormat === 4 &&
    prepared !== undefined &&
    eventType === 'item.completed' &&
    item !== undefined &&
    asString(item.id).length > 0 &&
    prepared.itemId === item.id
    ? prepared.output
    : undefined;
}

/** The final output body of a Codex item, as chunks; see {@link codexItemOutputBody}. */
export interface CodexItemOutputBody {
  itemId: string;
  field: PreparedCodexItemOutput['field'];
  /** Bounded chunks that join to {@link CodexItemOutputBody.whole}. */
  chunks: Iterable<string>;
  /**
   * The whole body from the synchronous normalizers. For tests and for the
   * fallback when iterating `chunks` throws on an unreadable value.
   */
  whole(): string;
}

function functionCallOutputName(item: Record<string, unknown>): string {
  return [asString(item.namespace), asString(item.name, 'unknown')]
    .filter(Boolean)
    .join('.');
}

function mcpToolResultOptions(item: Record<string, unknown>): {
  status: string;
  result: unknown;
  error: unknown;
} {
  return {
    status: asString(item.status),
    result: isRecord(item.result)
      ? {
          ...item.result,
          content: withCodexImagePreviewNotices(item.result.content),
        }
      : item.result,
    error: item.error,
  };
}

function dynamicToolOutputOptions(item: Record<string, unknown>): {
  contentItems: unknown;
  success: boolean | null;
} {
  const contentItems = /^.+_preview_visual$/.test(asString(item.tool))
    ? withoutPreviewVisualImages(item.content_items)
    : item.content_items;
  return {
    contentItems: withCodexImagePreviewNotices(contentItems),
    success: typeof item.success === 'boolean' ? item.success : null,
  };
}

/**
 * The canonical final body that a format 4 reducer stores for this Codex
 * event, for a trusted host to publish before reducing. Covers
 * `item.completed` of `function_call_output` (the whole text block, header
 * included), `mcp_tool_call` and `dynamic_tool_call` (the tool result
 * output). Returns undefined for every other event. Reads nothing until
 * `chunks` is iterated.
 */
export function codexItemOutputBody(
  event: Record<string, unknown>,
): CodexItemOutputBody | undefined {
  if (event.type !== 'item.completed' || !isRecord(event.item))
    return undefined;
  const item = event.item;
  const itemId = asString(item.id);
  if (itemId.length === 0) return undefined;
  switch (item.type) {
    case 'function_call_output': {
      const header = `Tool output (${functionCallOutputName(item)})\n\n`;
      const output = item.output;
      return {
        itemId,
        field: 'text',
        chunks: codexOutputChunks(() =>
          codexOutputSequence([
            header,
            typeof output === 'string'
              ? codexOutputText(output)
              : codexDynamicToolOutputSource({
                  contentItems: withCodexImagePreviewNotices(output),
                  success: null,
                }),
          ]),
        ),
        whole: () =>
          `${header}${
            typeof output === 'string'
              ? output
              : codexDynamicToolOutput({
                  contentItems: withCodexImagePreviewNotices(output),
                  success: null,
                })
          }`,
      };
    }
    case 'mcp_tool_call':
      return {
        itemId,
        field: 'output',
        chunks: {
          [Symbol.iterator]: () =>
            codexMcpToolResultChunks(mcpToolResultOptions(item)).chunks[
              Symbol.iterator
            ](),
        },
        whole: () => codexMcpToolResult(mcpToolResultOptions(item)).output,
      };
    case 'dynamic_tool_call':
      return {
        itemId,
        field: 'output',
        chunks: codexDynamicToolOutputChunks(dynamicToolOutputOptions(item)),
        whole: () => codexDynamicToolOutput(dynamicToolOutputOptions(item)),
      };
    default:
      return undefined;
  }
}

function codexAsyncQuestionRequestId(
  context: CodexItemContext,
  itemId: string,
): string {
  const identity = JSON.stringify([
    context.threadId ?? context.rootThreadId ?? '',
    context.turnId ?? '',
    itemId,
  ]);
  let hashA = 2_166_136_261;
  let hashB = 3_335_557_771;
  let hashC = 2_654_435_761;
  let hashD = 1_013_904_223;
  for (let index = 0; index < identity.length; index += 1) {
    const code = identity.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 16_777_619);
    hashB = Math.imul(hashB ^ code, 2_246_822_519);
    hashC = Math.imul(hashC ^ code, 3_266_489_917);
    hashD = Math.imul(hashD ^ code, 668_265_263);
  }
  const hex = [hashA, hashB, hashC, hashD]
    .map((hash) => (hash >>> 0).toString(16).padStart(8, '0'))
    .join('');
  return `codex-async-${hex}`;
}

/**
 * Walk the Codex agent call blocks in `messages` and build a map from receiver
 * thread id -> owning `agentBlockId`.
 */
function buildCodexAgentParentMap(
  messages: ChatMessage[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'codex_agent_call') {
        continue;
      }
      for (const receiverThreadId of block.receiverThreadIds) {
        // Last writer wins — the canonical agentBlockId is deterministic from
        // the call id, so any pathological reuse still resolves to a stable
        // parent for the receiver thread.
        map.set(receiverThreadId, block.agentBlockId);
      }
    }
  }
  return map;
}

/**
 * Resolve the parent `agentBlockId` for a Codex item that came in on
 * `threadId`. Returns undefined when the item belongs to the root thread or
 * when no matching `codex_agent_call` block has been seen yet.
 */
function resolveParentBlockIdForCodexItem(
  messages: ChatMessage[],
  threadId: string | undefined,
  rootThreadId: string | undefined,
): string | undefined {
  if (!threadId || threadId === rootThreadId) {
    return undefined;
  }
  const map = buildCodexAgentParentMap(messages);
  return map.get(threadId);
}

function extractSubagentThreadMetadata(sourceValue: unknown): {
  nickname?: string;
  role?: string;
  parentThreadId?: string;
  agentPath?: string;
} {
  if (!isRecord(sourceValue)) {
    return {};
  }

  const subAgentValue = isRecord(sourceValue.subAgent)
    ? sourceValue.subAgent
    : sourceValue.subagent;
  if (!isRecord(subAgentValue)) {
    return {};
  }

  const threadSpawnValue = isRecord(subAgentValue.thread_spawn)
    ? subAgentValue.thread_spawn
    : isRecord(subAgentValue.threadSpawn)
      ? subAgentValue.threadSpawn
      : undefined;
  if (!threadSpawnValue) {
    return {};
  }

  const metadata: ReturnType<typeof extractSubagentThreadMetadata> = {};
  const parentThreadId =
    asString(threadSpawnValue.parent_thread_id) ||
    asString(threadSpawnValue.parentThreadId);
  const agentPath =
    asString(threadSpawnValue.agent_path) ||
    asString(threadSpawnValue.agentPath);
  if (parentThreadId) metadata.parentThreadId = parentThreadId;
  if (agentPath) metadata.agentPath = agentPath;
  const nickname =
    asString(threadSpawnValue.agent_nickname) ||
    asString(threadSpawnValue.agentNickname);
  if (nickname.length > 0) {
    metadata.nickname = nickname;
  }

  const role =
    asString(threadSpawnValue.agent_role) ||
    asString(threadSpawnValue.agentRole);
  if (role.length > 0) {
    metadata.role = role;
  }

  return metadata;
}

function messageHasCodexItem(
  message: ChatMessage,
  codexToolId: string,
): boolean {
  return message.blocks.some(
    (block) =>
      (block.type === 'tool_use' && block.toolUseId === codexToolId) ||
      ((block.type === 'text' ||
        block.type === 'thinking' ||
        block.type === 'image') &&
        message.id === codexToolId),
  );
}

function messageIsCompatibleCodexItemUpdate(
  message: ChatMessage,
  codexToolId: string,
  context: CodexItemContext,
): boolean {
  if (!messageHasCodexItem(message, codexToolId)) {
    return false;
  }
  if (!context.threadId || !message.codexThreadId) {
    return true;
  }
  if (message.codexThreadId !== context.threadId) {
    return false;
  }
  if (context.turnId && message.codexTurnId) {
    return message.codexTurnId === context.turnId;
  }
  return true;
}

function messageIsExactCodexThreadItem(
  message: ChatMessage,
  codexToolId: string,
  threadId: string,
): boolean {
  return (
    message.codexThreadId === threadId &&
    messageHasCodexItem(message, codexToolId)
  );
}

function buildCodexSystemTextMessage(
  messages: ChatMessage[],
  event: Record<string, unknown>,
  text: string,
  options: TranscriptReducerOptions,
  rootThreadId: string | undefined,
): ChatMessage {
  const threadId =
    typeof event.thread_id === 'string' ? event.thread_id : undefined;
  const turnId = typeof event.turn_id === 'string' ? event.turn_id : undefined;
  const parentBlockId = resolveParentBlockIdForCodexItem(
    messages,
    threadId,
    rootThreadId,
  );
  return {
    id: options.createMessageId(),
    role: 'system',
    blocks: [{ type: 'text', text }],
    timestamp: options.now,
    ...(threadId ? { codexThreadId: threadId } : {}),
    ...(turnId ? { codexTurnId: turnId } : {}),
    ...(parentBlockId ? { parentBlockId } : {}),
  };
}

/**
 * After adding/updating a `codex_agent_call` block, re-attach earlier
 * subagent messages whose `parentBlockId` was unknown when they first arrived.
 * Localized scan — only walks messages and patches in place.
 */
function reparentCodexMessages(messages: ChatMessage[]): ChatMessage[] {
  const map = buildCodexAgentParentMap(messages);
  if (map.size === 0) {
    return messages;
  }
  let changed = false;
  const result = messages.map((message) => {
    const threadId = message.codexThreadId;
    if (!threadId) {
      return message;
    }
    const parentBlockId = map.get(threadId);
    if (!parentBlockId || message.parentBlockId === parentBlockId) {
      return message;
    }
    changed = true;
    return { ...message, parentBlockId };
  });
  return changed ? result : messages;
}

/**
 * Patch `receiverAgents` on every `codex_agent_call` block whose
 * `receiverThreadIds` contains `threadId`.
 */
function patchReceiverAgents(
  messages: ChatMessage[],
  threadId: string,
  info: (CodexAgentReceiver & { source?: string }) | undefined,
): ChatMessage[] {
  if (!info) {
    return messages;
  }
  const patch: CodexAgentReceiver = {};
  if (info.nickname !== undefined) {
    patch.nickname = info.nickname;
  }
  if (info.role !== undefined) {
    patch.role = info.role;
  }
  if (info.agentPath !== undefined) patch.agentPath = info.agentPath;
  if (info.model !== undefined) patch.model = info.model;
  if (info.reasoningEffort !== undefined)
    patch.reasoningEffort = info.reasoningEffort;
  if (Object.keys(patch).length === 0) return messages;

  let changed = false;
  const result = messages.map((message) => {
    let blocksChanged = false;
    const blocks = message.blocks.map((block) => {
      if (
        block.type !== 'codex_agent_call' ||
        !block.receiverThreadIds.includes(threadId)
      ) {
        return block;
      }
      const existing = block.receiverAgents?.[threadId];
      const merged = { ...(existing ?? {}), ...patch };
      if (
        existing &&
        existing.nickname === merged.nickname &&
        existing.role === merged.role &&
        existing.agentPath === merged.agentPath &&
        existing.model === merged.model &&
        existing.reasoningEffort === merged.reasoningEffort
      ) {
        return block;
      }
      blocksChanged = true;
      const nextReceivers = { ...(block.receiverAgents ?? {}) };
      nextReceivers[threadId] = merged;
      return { ...block, receiverAgents: nextReceivers };
    });
    if (!blocksChanged) {
      return message;
    }
    changed = true;
    return { ...message, blocks };
  });
  return changed ? result : messages;
}

function markCodexAgentThreadErrored(
  messages: ChatMessage[],
  threadId: string | undefined,
  message: string,
): ChatMessage[] {
  if (!threadId) {
    return messages;
  }
  let changed = false;
  const result = messages.map((chatMessage) => {
    let blocksChanged = false;
    const blocks = chatMessage.blocks.map((block) => {
      if (
        block.type !== 'codex_agent_call' ||
        !block.receiverThreadIds.includes(threadId)
      ) {
        return block;
      }
      const existing = block.agentsStates[threadId];
      if (existing?.status === 'errored' && existing.message === message) {
        return block;
      }
      blocksChanged = true;
      return {
        ...block,
        agentsStates: {
          ...block.agentsStates,
          [threadId]: { status: 'errored', message },
        },
      };
    });
    if (!blocksChanged) {
      return chatMessage;
    }
    changed = true;
    return { ...chatMessage, blocks };
  });
  return changed ? result : messages;
}

/**
 * Coerce a generated `agents_states` payload into the renderer's
 * `Record<string, CodexAgentState>` shape. Tolerates unknown statuses and
 * missing `message` fields so transport-layer normalization stays loose.
 */
function parseAgentsStates(
  raw: unknown,
): Record<string, CodexAgentState> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: Record<string, CodexAgentState> = {};
  for (const [threadId, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      continue;
    }
    const status = asString(value.status);
    if (status.length === 0) {
      continue;
    }
    const messageField = value.message;
    out[threadId] = {
      status,
      ...(typeof messageField === 'string'
        ? { message: messageField }
        : messageField === null
          ? { message: null }
          : {}),
    };
  }
  return out;
}

/**
 * Merge an updated `agents_states` snapshot into the existing block. Newer
 * entries always win; entries the update doesn't mention are preserved so
 * partial status snapshots don't drop already-known agents.
 */
function mergeAgentsStates(
  previous: Record<string, CodexAgentState>,
  next: Record<string, CodexAgentState> | undefined,
): Record<string, CodexAgentState> {
  if (!next || Object.keys(next).length === 0) {
    return previous;
  }
  return { ...previous, ...next };
}

function isTransientCodexSpawnStart(
  status: string,
  receiverThreadIds: string[],
  agentsStates: Record<string, CodexAgentState>,
): boolean {
  return (
    status === 'inProgress' &&
    receiverThreadIds.length === 0 &&
    Object.keys(agentsStates).length === 0
  );
}

/**
 * Find an existing `codex_agent_call` block by its `agentBlockId`. Returns
 * `[messageIndex, blockIndex]` or `null` when not found.
 */
function findCodexAgentCallBlock(
  messages: ChatMessage[],
  agentBlockId: string,
): { messageIndex: number; blockIndex: number } | null {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    for (let j = 0; j < message.blocks.length; j += 1) {
      const block = message.blocks[j];
      if (
        block.type === 'codex_agent_call' &&
        block.agentBlockId === agentBlockId
      ) {
        return { messageIndex: i, blockIndex: j };
      }
    }
  }
  return null;
}

/**
 * Apply a `collab_agent_tool_call` Codex item.
 *
 * - `tool === 'spawnAgent'`: create or refresh a `codex_agent_call` block on
 *   an assistant message keyed by `codex-agent-${item.id}`. After mutation,
 *   re-parent any orphan subagent messages whose `codexThreadId` matches the
 *   new receiver list.
 * - non-spawn collab calls (`wait`, `sendInput`, `resumeAgent`, `closeAgent`):
 *   merge the latest `status` and `agents_states` into any existing parent
 *   block whose `receiverThreadIds` intersect this call's `receiver_thread_ids`.
 *   When no parent exists, the call is dropped from the visible chat (the raw
 *   observability transcript still records it).
 */
function applyCodexCollabAgentItem(
  messages: ChatMessage[],
  item: Record<string, unknown>,
  context: CodexItemContext,
  now: number,
): ChatMessage[] {
  const callId = asString(item.id);
  if (callId.length === 0) {
    return messages;
  }
  const tool = asString(item.tool);
  const status = asString(item.status);
  const senderThreadId = asString(item.sender_thread_id);
  const receiverThreadIdsRaw = Array.isArray(item.receiver_thread_ids)
    ? (item.receiver_thread_ids as unknown[])
    : [];
  const receiverThreadIds = receiverThreadIdsRaw.filter(
    (value): value is string => typeof value === 'string',
  );
  const agentsStates = parseAgentsStates(item.agents_states) ?? {};

  if (tool === 'spawnAgent') {
    const receiverBlock =
      receiverThreadIds.length === 1
        ? findCodexAgentReceiverBlock(messages, receiverThreadIds[0])
        : undefined;
    const agentBlockId = receiverBlock?.agentBlockId ?? `codex-agent-${callId}`;
    const prompt = asString(item.prompt);
    const model =
      typeof item.model === 'string' && item.model.length > 0
        ? item.model
        : undefined;
    const reasoningEffort =
      typeof item.reasoning_effort === 'string' &&
      item.reasoning_effort.length > 0
        ? item.reasoning_effort
        : undefined;

    if (isTransientCodexSpawnStart(status, receiverThreadIds, agentsStates)) {
      return messages;
    }

    const existing = findCodexAgentCallBlock(messages, agentBlockId);
    if (existing) {
      const message = messages[existing.messageIndex];
      const block = message.blocks[existing.blockIndex];
      if (block.type !== 'codex_agent_call') {
        return messages;
      }
      const nextBlock: CodexAgentCallBlock = {
        ...block,
        tool,
        status: status.length > 0 ? status : block.status,
        senderThreadId:
          senderThreadId.length > 0 ? senderThreadId : block.senderThreadId,
        receiverThreadIds:
          receiverThreadIds.length > 0
            ? receiverThreadIds
            : block.receiverThreadIds,
        prompt: prompt.length > 0 ? prompt : block.prompt,
        ...(model ? { model } : block.model ? { model: block.model } : {}),
        ...(reasoningEffort
          ? { reasoningEffort }
          : block.reasoningEffort
            ? { reasoningEffort: block.reasoningEffort }
            : {}),
        agentsStates: mergeAgentsStates(block.agentsStates, agentsStates),
      };
      const updated = [...messages];
      updated[existing.messageIndex] = {
        ...message,
        blocks: message.blocks.map((b, i) =>
          i === existing.blockIndex ? nextBlock : b,
        ),
      };
      return reparentCodexMessages(updated);
    }

    const newBlock: CodexAgentCallBlock = {
      type: 'codex_agent_call',
      agentBlockId,
      callId,
      tool,
      status: status.length > 0 ? status : 'inProgress',
      senderThreadId,
      receiverThreadIds,
      prompt,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      agentsStates,
    };

    const newMessage: ChatMessage = {
      id: agentBlockId,
      role: 'assistant',
      blocks: [newBlock],
      timestamp: now,
      ...(context.threadId ? { codexThreadId: context.threadId } : {}),
      ...(context.turnId ? { codexTurnId: context.turnId } : {}),
    };

    return reparentCodexMessages([...messages, newMessage]);
  }

  // Non-spawn collab call. Merge status / agents_states into any existing
  // parent block whose receiver list intersects this call's receivers.
  if (receiverThreadIds.length === 0) {
    return messages;
  }
  let mutated = false;
  const updated = messages.map((message) => {
    let blocksMutated = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== 'codex_agent_call') {
        return block;
      }
      const intersects = block.receiverThreadIds.some((tid) =>
        receiverThreadIds.includes(tid),
      );
      if (!intersects) {
        return block;
      }
      const merged = mergeAgentsStates(block.agentsStates, agentsStates);
      const nextStatus = status.length > 0 ? status : block.status;
      if (merged === block.agentsStates && nextStatus === block.status) {
        return block;
      }
      blocksMutated = true;
      return { ...block, status: nextStatus, agentsStates: merged };
    });
    if (!blocksMutated) {
      return message;
    }
    mutated = true;
    return { ...message, blocks };
  });
  return mutated ? updated : messages;
}

/** A receiver keeps one group across activity and legacy collaboration events. */
function findCodexAgentReceiverBlock(
  messages: ChatMessage[],
  threadId: string,
): CodexAgentCallBlock | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const block of messages[index].blocks) {
      if (
        block.type === 'codex_agent_call' &&
        block.receiverThreadIds.includes(threadId)
      )
        return block;
    }
  }
  return undefined;
}

/** Normalize lifecycle-only providers into the existing Codex agent model. */
function applyCodexSubagentActivity(
  messages: ChatMessage[],
  item: Record<string, unknown>,
  context: CodexItemContext,
  now: number,
): ChatMessage[] {
  const kind = asString(item.kind);
  // Interaction targets include ancestors (including /root); they are not
  // spawned children and must never introduce groups or reopen settled work.
  if (kind !== 'started' && kind !== 'completed' && kind !== 'interrupted')
    return messages;
  const threadId =
    asString(item.agent_thread_id) || asString(item.agentThreadId);
  if (!threadId || threadId === context.rootThreadId) return messages;
  const existing = findCodexAgentReceiverBlock(messages, threadId);
  // item.started/item.completed can both describe the same spawn. Keep the
  // lifecycle status from the child, not the transport item's completion.
  const agentPath = asString(item.agent_path) || asString(item.agentPath);
  if (kind === 'started' && existing) {
    return agentPath
      ? patchReceiverAgents(messages, threadId, { agentPath })
      : messages;
  }
  if (!existing && (!context.threadId || context.threadId === threadId))
    return messages;
  const priorState = existing?.agentsStates[threadId];
  const agentState =
    kind === 'started'
      ? { status: 'running' }
      : priorState?.status === 'errored' || priorState?.status === 'cancelled'
        ? priorState
        : { status: kind === 'interrupted' ? 'cancelled' : 'completed' };
  const updated = applyCodexCollabAgentItem(
    messages,
    {
      id: existing?.callId ?? asString(item.id),
      tool: existing ? 'wait' : 'spawnAgent',
      status: kind === 'started' ? 'inProgress' : 'completed',
      sender_thread_id: context.threadId,
      receiver_thread_ids: [threadId],
      agents_states: { [threadId]: agentState },
    },
    context,
    now,
  );
  // Keep the task identity even after the provider supplies a nickname.
  return agentPath
    ? patchReceiverAgents(updated, threadId, { agentPath })
    : updated;
}

/** Follow-up turns do not emit another spawn; update the existing card. */
function updateCodexAgentTurn(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  status: 'running' | 'completed' | 'cancelled',
  options: TranscriptReducerOptions,
): ChatMessage[] {
  const threadId = asString(event.thread_id);
  if (!threadId || threadId === state.sdkSessionId) return state.messages;
  const block = findCodexAgentReceiverBlock(state.messages, threadId);
  if (!block) return state.messages;
  const previous = block.agentsStates[threadId];
  const agentState =
    status !== 'running' &&
    (previous?.status === 'errored' || previous?.status === 'cancelled')
      ? previous
      : { status };
  return recordCodexReceiverTime(
    applyCodexCollabAgentItem(
      state.messages,
      {
        id: block.callId,
        tool: 'wait',
        status: status === 'running' ? 'inProgress' : 'completed',
        receiver_thread_ids: [threadId],
        agents_states: { [threadId]: agentState },
      },
      { rootThreadId: state.sdkSessionId },
      options.now,
    ),
    threadId,
    status === 'running' ? 'start' : 'settle',
    codexReceiverTimeAt(
      event,
      status === 'running' ? 'start' : 'settle',
      options,
    ),
  );
}

function codexReceiverTimeAt(
  event: Record<string, unknown>,
  edge: 'start' | 'settle',
  options: TranscriptReducerOptions,
): number | undefined {
  return (
    readEventEpochMs(
      event,
      edge === 'start'
        ? ['started_at', 'startedAt', 'timestamp']
        : ['completed_at', 'completedAt', 'timestamp'],
    ) ?? (options.useNowAsTurnTimestamp === false ? undefined : options.now)
  );
}

/**
 * Record when a child thread's turn started or ended on every card that
 * names it. A start keeps the first start and clears the settle time; a
 * settle keeps the first end its turn reported.
 */
function recordCodexReceiverTime(
  messages: ChatMessage[],
  threadId: string | undefined,
  edge: 'start' | 'settle',
  at: number | undefined,
): ChatMessage[] {
  if (!threadId || at === undefined) return messages;
  let changed = false;
  const result = messages.map((message) => {
    let blocksChanged = false;
    const blocks = message.blocks.map((block) => {
      if (
        block.type !== 'codex_agent_call' ||
        !block.receiverThreadIds.includes(threadId)
      )
        return block;
      const previous = block.receiverTimes?.[threadId];
      const startedAt =
        previous?.startedAt ?? (edge === 'start' ? at : undefined);
      const settledAt =
        edge === 'start' ? undefined : (previous?.settledAt ?? at);
      if (
        previous?.startedAt === startedAt &&
        previous?.settledAt === settledAt
      )
        return block;
      blocksChanged = true;
      return {
        ...block,
        receiverTimes: {
          ...block.receiverTimes,
          [threadId]: {
            ...(startedAt === undefined ? {} : { startedAt }),
            ...(settledAt === undefined ? {} : { settledAt }),
          },
        },
      };
    });
    if (!blocksChanged) return message;
    changed = true;
    return { ...message, blocks };
  });
  return changed ? result : messages;
}

function textFromSimpleAssistantMessage(message: ChatMessage): string | null {
  if (message.role !== 'assistant' || message.blocks.length !== 1) {
    return null;
  }
  const block = message.blocks[0];
  return block?.type === 'text' && !block.asyncQuestion ? block.text : null;
}

function sameCodexTurn(
  previous: ChatMessage,
  next: ChatMessage,
  context: CodexItemContext,
): boolean {
  if (!context.turnId || previous.codexTurnId !== context.turnId) {
    return false;
  }
  if (previous.codexThreadId !== next.codexThreadId) {
    return false;
  }
  return previous.parentBlockId === next.parentBlockId;
}

function maybeCoalesceDuplicateCodexFinalAnswer(
  messages: ChatMessage[],
  message: ChatMessage,
  item: Record<string, unknown>,
  eventType: CodexItemEventType,
  context: CodexItemContext,
): ChatMessage[] | null {
  if (
    eventType !== 'item.completed' ||
    item.type !== 'agent_message' ||
    item.phase !== 'final_answer'
  ) {
    return null;
  }

  const text = textFromSimpleAssistantMessage(message)?.trim();
  if (!text) {
    return null;
  }

  const previous = messages[messages.length - 1];
  if (!previous || !sameCodexTurn(previous, message, context)) {
    return null;
  }

  const previousText = textFromSimpleAssistantMessage(previous)?.trim();
  if (previousText !== text) {
    return null;
  }

  // Codex can emit the same assistant text once as commentary and again as
  // the final answer. Keep raw observability faithful upstream, but collapse
  // the duplicate in the chat transcript so the user sees it once.
  return [...messages.slice(0, -1), message];
}

function upsertCodexItem(
  messages: ChatMessage[],
  item: Record<string, unknown>,
  eventType: CodexItemEventType,
  now: number,
  context: CodexItemContext,
): ChatMessage[] {
  const itemId = asString(item.id);
  const itemType = asString(item.type);
  if (itemId.length === 0 || itemType.length === 0) {
    return messages;
  }

  // Codex collab tool calls render as a dedicated `codex_agent_call` block —
  // never a synthetic Claude-style tool_use.
  if (itemType === 'collab_agent_tool_call') {
    return applyCodexCollabAgentItem(messages, item, context, now);
  }

  if (itemType === 'subagent_activity' || itemType === 'sub_agent_activity') {
    return applyCodexSubagentActivity(messages, item, context, now);
  }

  const codexToolId = `codex-${itemId}`;
  let searchStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].blocks.some((block) => block.type === 'turn_timer')) {
      searchStart = index + 1;
      break;
    }
  }

  let existingIndex = -1;
  for (let index = searchStart; index < messages.length; index += 1) {
    const message = messages[index];
    if (messageIsCompatibleCodexItemUpdate(message, codexToolId, context)) {
      existingIndex = index;
      break;
    }
  }
  if (existingIndex < 0) {
    for (let index = 0; index < searchStart; index += 1) {
      const message = messages[index];
      if (messageIsCompatibleCodexItemUpdate(message, codexToolId, context)) {
        existingIndex = index;
        break;
      }
    }
  }
  if (
    existingIndex < 0 &&
    context.threadId !== undefined &&
    context.threadId !== context.rootThreadId
  ) {
    for (let index = 0; index < searchStart; index += 1) {
      const message = messages[index];
      if (
        messageIsExactCodexThreadItem(message, codexToolId, context.threadId)
      ) {
        existingIndex = index;
        break;
      }
    }
  }

  // Provider-native replay may still carry PreviewVisual image bytes. Strip
  // those before the shared normalizer while retaining prepared field bodies.
  const replayItem =
    itemType === 'dynamic_tool_call' &&
    /^.+_preview_visual$/.test(asString(item.tool))
      ? {
          ...item,
          content_items: withoutPreviewVisualImages(item.content_items),
        }
      : item;
  const normalized = normalizeCodexNeutralItem(replayItem, eventType, {
    previewToolResults: context.previewToolResults,
    losslessFunctionOutput: context.losslessFunctionOutput,
    preparedOutput: context.preparedOutput,
    asyncQuestionRequestId: codexAsyncQuestionRequestId(context, itemId),
  });
  if (!normalized) return messages;
  const { blocks, role } = normalized;

  const existingMessage = messages[existingIndex];
  const reconciledMessages = withoutPriorToolResults(
    messages,
    blocks,
    codexToolId,
  );
  const nextMessages = [...reconciledMessages];
  // Resolve the parent codex_agent_call block once for new messages so a
  // subagent item arriving after its spawning collab call still groups under
  // the right block. Root-thread items skip the lookup so root assistant text
  // never accidentally nests itself under a sibling subagent.
  const parentBlockId = resolveParentBlockIdForCodexItem(
    messages,
    context.threadId,
    context.rootThreadId,
  );
  const message: ChatMessage = {
    id: codexToolId,
    role,
    blocks,
    timestamp: now,
    ...(context.threadId ? { codexThreadId: context.threadId } : {}),
    ...(context.turnId ? { codexTurnId: context.turnId } : {}),
    ...(parentBlockId ? { parentBlockId } : {}),
  };

  const resultIndex = existingMessage
    ? nextMessages.indexOf(existingMessage)
    : -1;
  if (resultIndex >= 0) {
    // Preserve previously-captured routing metadata so an `item.updated`
    // event that arrives without thread/turn context (e.g. a late delta on a
    // resumed turn) doesn't strip data we recorded on `item.started`.
    const existing = nextMessages[resultIndex];
    if (
      itemType === 'mcp_tool_call' &&
      existing.blocks.some(
        (block) =>
          block.type === 'tool_result' && block.toolUseId === codexToolId,
      ) &&
      !blocks.some(
        (block) =>
          block.type === 'tool_result' && block.toolUseId === codexToolId,
      )
    ) {
      return messages;
    }
    nextMessages[resultIndex] = {
      ...message,
      ...(message.codexThreadId
        ? { codexThreadId: message.codexThreadId }
        : existing.codexThreadId
          ? { codexThreadId: existing.codexThreadId }
          : {}),
      ...(message.codexTurnId
        ? { codexTurnId: message.codexTurnId }
        : existing.codexTurnId
          ? { codexTurnId: existing.codexTurnId }
          : {}),
      ...(message.parentBlockId
        ? { parentBlockId: message.parentBlockId }
        : existing.parentBlockId
          ? { parentBlockId: existing.parentBlockId }
          : {}),
    };
  } else {
    const coalesced = maybeCoalesceDuplicateCodexFinalAnswer(
      messages,
      message,
      item,
      eventType,
      context,
    );
    if (coalesced) {
      return coalesced;
    }
    nextMessages.push(message);
  }

  // An already-paged update has no authoritative logical source-slot map.
  // Never reinterpret the preview's positions as absolute ordinals.
  if (
    context.onToolBlock !== undefined &&
    !messages.some(
      (existing) =>
        existing.id === message.id && existing.blocksRef !== undefined,
    )
  ) {
    const canonical = existingIndex < 0 ? message : nextMessages[existingIndex];
    canonical.blocks.forEach((block, blockOrdinal): void => {
      if (block.type === 'tool_use' || block.type === 'tool_result') {
        context.onToolBlock?.(
          `${itemId}:${block.type === 'tool_use' ? 'call' : 'result'}`,
          canonical,
          blockOrdinal,
          messages,
        );
      }
    });
  }
  return nextMessages;
}

/**
 * Per-Codex-event handler. Returns the next reducer state. Pure: must not
 * read or write any module-level state besides what is provided through
 * `state` and `options`.
 */
type CodexEventHandler = (
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
) => TranscriptReducerState;

function handleCodexThreadStarted(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const threadId =
    typeof event.thread_id === 'string' ? event.thread_id : undefined;
  if (!threadId) {
    return { ...state, lastEventAt: options.now };
  }

  // Root-thread identity stickiness: only the FIRST `thread.started` for
  // this chat anchors `sdkSessionId`. Without this guard a subagent
  // `thread.started` would silently re-anchor the root id and corrupt
  // `parentBlockId` resolution (Risks section).
  const isRootThread = state.sdkSessionId === undefined;

  const incoming: CodexAgentReceiver & { source?: string } = {};
  const sourceMetadata = extractSubagentThreadMetadata(event.source);
  const parentThreadId =
    asString(event.parent_thread_id) || sourceMetadata.parentThreadId;
  if (sourceMetadata.agentPath) incoming.agentPath = sourceMetadata.agentPath;
  if (typeof event.model === 'string' && event.model)
    incoming.model = event.model;
  if (typeof event.reasoning_effort === 'string' && event.reasoning_effort) {
    incoming.reasoningEffort = event.reasoning_effort;
  }
  const nickname =
    typeof event.agent_nickname === 'string'
      ? event.agent_nickname
      : sourceMetadata.nickname;
  if (typeof nickname === 'string') {
    incoming.nickname = nickname;
  }
  const role =
    typeof event.agent_role === 'string'
      ? event.agent_role
      : sourceMetadata.role;
  if (typeof role === 'string') {
    incoming.role = role;
  }
  if (typeof event.source === 'string') {
    incoming.source = event.source;
  }

  // Persist the receiver relationship when metadata arrives before its spawn
  // item. Main intentionally discards reducer-only codexThreads between events.
  const messages =
    parentThreadId && !isRootThread
      ? applyCodexSubagentActivity(
          state.messages,
          {
            id: `subagent-${threadId}`,
            kind: 'started',
            agent_thread_id: threadId,
            agent_path: sourceMetadata.agentPath,
          },
          {
            threadId: parentThreadId,
            rootThreadId: state.sdkSessionId,
          },
          options.now,
        )
      : state.messages;
  const previousThreadInfo = state.codexThreads?.[threadId] ?? {};
  const mergedThreadInfo = { ...previousThreadInfo, ...incoming };
  const nextCodexThreads = {
    ...(state.codexThreads ?? {}),
    [threadId]: mergedThreadInfo,
  };

  return {
    ...state,
    sdkSessionId: isRootThread ? threadId : state.sdkSessionId,
    providerType: 'codex',
    codexThreads: nextCodexThreads,
    // Phase F2 step 8: patch any existing codex_agent_call.receiverAgents
    // entry whose receiver list includes this thread id. The helper bails
    // when the merged record has no display metadata to apply, so subagent
    // thread.started events without metadata stay zero-cost.
    messages: patchReceiverAgents(messages, threadId, mergedThreadInfo),
    lastEventAt: options.now,
  };
}

function isCodexChildEvent(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
): boolean {
  return (
    state.sdkSessionId !== undefined &&
    typeof event.thread_id === 'string' &&
    event.thread_id !== state.sdkSessionId
  );
}

function handleCodexTurnStarted(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  if (isCodexChildEvent(state, event)) {
    return {
      ...state,
      messages: updateCodexAgentTurn(state, event, 'running', options),
      lastEventAt: options.now,
    };
  }
  return {
    ...state,
    status: 'streaming',
    messages: ensureOpenTurnTimerForContinuation(
      {
        ...state,
        messages: updateCodexAgentTurn(state, event, 'running', options),
      },
      options,
    ),
    lastEventAt: options.now,
  };
}

function shouldReopenCompletedTurnForCodexItem(
  item: Record<string, unknown>,
): boolean {
  const itemType = asString(item.type);
  if (itemType === 'agent_message' && item.delivery === 'async') {
    return false;
  }
  return (
    itemType === 'agent_message' ||
    itemType === 'reasoning' ||
    itemType === 'plan'
  );
}

function handleCodexItem(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const eventType = event.type;
  const item = isRecord(event.item) ? event.item : undefined;
  const context: CodexItemContext = {
    onToolBlock: options.onToolBlock,
    threadId: typeof event.thread_id === 'string' ? event.thread_id : undefined,
    turnId: typeof event.turn_id === 'string' ? event.turn_id : undefined,
    rootThreadId: state.sdkSessionId,
    previewToolResults: options.codexToolResults === 'preview',
    ...(options.transcriptStorageFormat === 4
      ? { losslessFunctionOutput: true }
      : {}),
  };
  const preparedOutput = preparedOutputFor(options, eventType, item);
  if (preparedOutput) context.preparedOutput = preparedOutput;
  if (eventType === 'item.completed' && item?.type === 'context_compaction') {
    const itemId = asString(item.id);
    if (itemId.length === 0) {
      return { ...state, lastEventAt: options.now };
    }
    const sessionId = context.threadId ?? state.sdkSessionId;
    return applyCanopyCompactionEvent(
      { ...state, providerType: 'codex' },
      {
        type: 'canopy_compaction',
        provider: 'codex',
        interfaceMode: 'canopy',
        timestamp: options.now,
        ...(sessionId ? { sessionId } : {}),
        sourceEventId: `codex-context-compaction:${sessionId ?? 'unknown'}:${itemId}`,
      },
      options,
      'codex',
    );
  }
  // Child output can arrive after the root failure. Keep its transcript and
  // activity cards, but only root events may resume the root's timer/status.
  const isChild = isCodexChildEvent(state, event);
  const pausedContinuationMessages = isChild
    ? state.messages
    : ensureOpenTurnTimerForPausedContinuation(state, options);
  const shouldReopenCompletedTurn =
    !isChild &&
    item !== undefined &&
    shouldReopenCompletedTurnForCodexItem(item);
  const baseMessages =
    pausedContinuationMessages !== state.messages
      ? pausedContinuationMessages
      : shouldReopenCompletedTurn
        ? ensureOpenTurnTimerForContinuation(state, options)
        : state.messages;
  const resumedTurn = baseMessages !== state.messages;
  const hasRunningTurn = hasOpenTurnTimer(state.messages);
  return {
    ...state,
    status:
      !isChild && (resumedTurn || hasRunningTurn) ? 'streaming' : state.status,
    messages:
      item !== undefined && isCodexItemEventType(eventType)
        ? upsertCodexItem(baseMessages, item, eventType, options.now, context)
        : baseMessages,
    lastEventAt: options.now,
  };
}

function handleCodexItemPlanDelta(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  if (typeof event.item_id !== 'string') {
    return {
      ...state,
      lastEventAt: options.now,
    };
  }
  const context: CodexItemContext = {
    threadId: typeof event.thread_id === 'string' ? event.thread_id : undefined,
    turnId: typeof event.turn_id === 'string' ? event.turn_id : undefined,
    rootThreadId: state.sdkSessionId,
  };
  const isChild = isCodexChildEvent(state, event);
  const baseMessages = isChild
    ? state.messages
    : ensureOpenTurnTimerForPausedContinuation(state, options);
  const resumedPausedTurn = baseMessages !== state.messages;
  const hasRunningTurn = hasOpenTurnTimer(state.messages);
  return {
    ...state,
    status:
      !isChild && (resumedPausedTurn || hasRunningTurn)
        ? 'streaming'
        : state.status,
    messages: upsertCodexItem(
      baseMessages,
      {
        type: 'plan',
        id: event.item_id,
        text: asString(event.text),
      },
      'item.updated',
      options.now,
      context,
    ),
    lastEventAt: options.now,
  };
}

/**
 * Apply a Codex `usage` payload to the running totals. `turn.completed` and
 * `turn.failed` both share this aggregation — pull it out so the two case
 * handlers stay focused on the few fields that actually differ between them.
 */
function accumulateCodexTurnUsage(
  previous: ChatTabUsage,
  rawUsage: Record<string, unknown> | undefined,
): ChatTabUsage {
  if (!rawUsage) {
    return previous;
  }
  return {
    ...previous,
    inputTokens:
      previous.inputTokens +
      (typeof rawUsage.input_tokens === 'number' ? rawUsage.input_tokens : 0),
    cacheReadInputTokens:
      previous.cacheReadInputTokens +
      (typeof rawUsage.cached_input_tokens === 'number'
        ? rawUsage.cached_input_tokens
        : 0),
    outputTokens:
      previous.outputTokens +
      (typeof rawUsage.output_tokens === 'number' ? rawUsage.output_tokens : 0),
    numTurns: previous.numTurns + 1,
  };
}

function handleCodexTokenUsageUpdated(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const rawUsage = isRecord(event.usage) ? event.usage : undefined;
  const contextTokens = rawUsage?.context_tokens;
  const contextWindow = rawUsage?.context_window;
  if (
    typeof contextTokens !== 'number' ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0 ||
    typeof contextWindow !== 'number' ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return state;
  }

  return {
    ...state,
    providerType: state.providerType ?? 'codex',
    usage: {
      ...(state.usage ?? defaultUsage()),
      contextTokens,
      contextWindow,
    },
    lastEventAt: options.now,
  };
}

/**
 * Read a `resetsAt` value off a Codex event as epoch ms, when present. Codex
 * reports `RateLimitWindow.resetsAt` in epoch seconds, while the main-process
 * client attaches failure reset times in ms, so both are normalized here.
 * Non-finite and non-positive values count as missing.
 */
function readCodexResetsAt(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return normalizeEpochMs(value);
  }
  return undefined;
}

function isCodexUsageLimitErrorInfo(value: unknown): boolean {
  if (value === 'usageLimitExceeded') {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(value, 'usageLimitExceeded');
}

function lastUserMessageId(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message.id;
  }
  return undefined;
}

function buildCodexUsageLimitBannerState(args: {
  eventType: string;
  message: string;
  detectedAt: number;
  messages: ChatMessage[];
  threadId?: string;
  turnId?: string;
  resetsAt?: number;
}): LlmProviderUsageLimitBannerState {
  const {
    eventType,
    message,
    detectedAt,
    messages,
    threadId,
    turnId,
    resetsAt,
  } = args;
  return buildLlmProviderUsageLimitBannerState({
    provider: 'codex',
    message,
    detectedAt,
    // The message is constant, so the identity needs a per-occurrence part:
    // the turn id, else the user message that started the turn. Both are
    // stable on replay, unlike parse time.
    fallbackIdentity: [
      'codex',
      eventType,
      threadId ?? '',
      turnId ?? lastUserMessageId(messages) ?? '',
      typeof resetsAt === 'number' ? String(resetsAt) : '',
      message,
    ].join('\0'),
    ...(typeof resetsAt === 'number' ? { resetsAt } : {}),
  });
}

function handleCodexTurnCompleted(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const previous = state.usage ?? defaultUsage();
  const usage = isRecord(event.usage) ? event.usage : undefined;
  const eventThreadId =
    typeof event.thread_id === 'string' ? event.thread_id : undefined;
  const isSubagentCompletion =
    state.sdkSessionId !== undefined &&
    eventThreadId !== undefined &&
    eventThreadId !== state.sdkSessionId;
  return {
    ...state,
    ...(!isSubagentCompletion
      ? {
          status: 'idle' as const,
          error: null,
          // Main-owned state settles on this native terminal event and can
          // reject the provider's later synthetic result. Complete the root
          // timer here as part of settling the root turn.
          messages: completeTurnTimer(
            state.messages,
            resolveTurnCompletedAt(event, options),
          ),
        }
      : {
          messages: updateCodexAgentTurn(
            state,
            event,
            event.status === 'interrupted' ? 'cancelled' : 'completed',
            options,
          ),
        }),
    usage: accumulateCodexTurnUsage(previous, usage),
    lastEventAt: options.now,
  };
}

/**
 * Shared tail of the Codex `turn.failed` and `error` handlers. A usage-limit
 * failure is banner-only, like Claude's 429 path: no transcript row and the
 * fixed {@link CODEX_USAGE_LIMIT_MESSAGE} in place of OpenAI's upsell text.
 * Other failures keep their `Error: <message>` row, which auth-failure
 * attachment (CAN-1814) anchors on.
 */
function applyCodexFailure(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  failure: {
    errorMessage: string;
    usageLimitBanner: LlmProviderUsageLimitBannerState | undefined;
  },
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const { errorMessage, usageLimitBanner } = failure;
  const isUsageLimit = usageLimitBanner !== undefined;
  const displayError = isUsageLimit ? CODEX_USAGE_LIMIT_MESSAGE : errorMessage;
  // A native `error` and `turn.failed` can both report one failed turn. Once
  // the turn has settled with a Codex banner, keep that banner so a dismissal
  // of it still holds.
  const keepsExistingBanner =
    state.status === 'error' &&
    state.llmProviderUsageLimitBanner?.provider === 'codex';
  const failedState = settleCodexFailedTurn(
    state,
    event,
    displayError,
    options,
  );
  const failedThreadId =
    typeof event.thread_id === 'string' ? event.thread_id : undefined;
  const messagesWithFailureState = recordCodexReceiverTime(
    markCodexAgentThreadErrored(
      failedState.messages,
      failedThreadId,
      displayError,
    ),
    failedThreadId,
    'settle',
    codexReceiverTimeAt(event, 'settle', options),
  );
  const messages = isUsageLimit
    ? messagesWithFailureState
    : [
        ...messagesWithFailureState,
        buildCodexSystemTextMessage(
          messagesWithFailureState,
          event,
          `Error: ${errorMessage}`,
          options,
          state.sdkSessionId,
        ),
      ];
  return {
    ...failedState,
    messages,
    ...(usageLimitBanner && !keepsExistingBanner
      ? { llmProviderUsageLimitBanner: usageLimitBanner }
      : {}),
    lastEventAt: options.now,
  };
}

function handleCodexTurnFailed(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const previous = state.usage ?? defaultUsage();
  const usage = isRecord(event.usage) ? event.usage : undefined;
  const errorMessage = isRecord(event.error)
    ? asString(event.error.message, 'Turn failed')
    : 'Turn failed';
  const resetsAt = isRecord(event.error)
    ? readCodexResetsAt(event.error.resetsAt)
    : undefined;
  const usageLimitBanner =
    isRecord(event.error) &&
    isCodexUsageLimitErrorInfo(event.error.codexErrorInfo)
      ? buildCodexUsageLimitBannerState({
          eventType: 'turn.failed',
          message: CODEX_USAGE_LIMIT_MESSAGE,
          detectedAt: options.now,
          messages: state.messages,
          threadId:
            typeof event.thread_id === 'string' ? event.thread_id : undefined,
          turnId: typeof event.turn_id === 'string' ? event.turn_id : undefined,
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        })
      : undefined;
  return {
    ...applyCodexFailure(
      state,
      event,
      { errorMessage, usageLimitBanner },
      options,
    ),
    usage: accumulateCodexTurnUsage(previous, usage),
  };
}

function settleCodexFailedTurn(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  error: string,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  // The app-server adapter suppresses retry notifications before forwarding
  // them; keep replay equally safe if a raw notification reaches the reducer.
  if (
    event.willRetry === true ||
    (state.sdkSessionId !== undefined &&
      typeof event.thread_id === 'string' &&
      event.thread_id !== state.sdkSessionId)
  ) {
    return state;
  }
  // Main settles runtime on this event and may discard the trailing synthetic
  // result. Persist timer settlement now, even when no renderer has the chat.
  return {
    ...state,
    status: 'error',
    error,
    messages: completeTurnTimer(
      state.messages,
      resolveTurnCompletedAt(event, options),
    ),
  };
}

function handleCodexError(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const errorMessage =
    asString(event.message) || asString(event.error, 'Unknown error');
  const resetsAt = readCodexResetsAt(event.resetsAt);
  const usageLimitBanner = isCodexUsageLimitErrorInfo(event.codexErrorInfo)
    ? buildCodexUsageLimitBannerState({
        eventType: 'error',
        message: CODEX_USAGE_LIMIT_MESSAGE,
        detectedAt: options.now,
        messages: state.messages,
        threadId:
          typeof event.thread_id === 'string' ? event.thread_id : undefined,
        turnId: typeof event.turn_id === 'string' ? event.turn_id : undefined,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      })
    : undefined;
  return applyCodexFailure(
    state,
    event,
    { errorMessage, usageLimitBanner },
    options,
  );
}

/**
 * Proactive Codex usage-limit detection (CAN-838, B2). The main-process client
 * synthesizes `rate_limit.reached` from `account/rateLimits/updated` snapshots
 * when the account has reached a rate/usage limit, so the AI Credits fallback
 * banner can surface before a turn hard-fails. Banner-only, like the
 * usage-limit `turn.failed` / `error` paths (CAN-4564); it is raised before
 * the turn fails, so it does not settle turn state.
 */
function handleCodexRateLimitReached(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  const resetsAt = readCodexResetsAt(event.resetsAt);
  const usageLimitBanner = buildCodexUsageLimitBannerState({
    eventType: 'rate_limit.reached',
    message: CODEX_USAGE_LIMIT_MESSAGE,
    detectedAt: options.now,
    messages: state.messages,
    threadId: typeof event.thread_id === 'string' ? event.thread_id : undefined,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  });
  return {
    ...state,
    llmProviderUsageLimitBanner: usageLimitBanner,
    lastEventAt: options.now,
  };
}

function isCodexStartupResult(event: Record<string, unknown>): boolean {
  return (
    event.type === 'result' &&
    event.is_error === true &&
    event.subtype === 'codex_error'
  );
}

function handleCodexStartupResult(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  if (!isCodexStartupResult(event)) return state;
  const message = asString(event.result, 'Session failed to start');
  const lastMessage = state.messages[state.messages.length - 1];
  const closedMessages = closeOpenToolUseBlocks(
    state.messages,
    options.createMessageId,
    options.now,
    childToolCloseContext(state, event, options),
  );
  // A native turn.failed/error normally precedes the synthetic result and has
  // already settled the turn. For a usage limit it left no row to match, only
  // the Codex banner, so skip the result rather than write a second banner.
  // The synthetic result carries no usage the reducer records. A usage-limit
  // result with no preceding native event (a startup failure) falls through
  // to handleCodexError, which is banner-only for it.
  if (
    isCodexUsageLimitErrorInfo(event.codexErrorInfo) &&
    state.status === 'error' &&
    state.llmProviderUsageLimitBanner?.provider === 'codex'
  ) {
    return closedMessages === state.messages
      ? state
      : { ...state, messages: closedMessages };
  }
  const modelAccessFailure = readCodexAccountModelAccessFailure(
    event[CANOPY_MODEL_ACCESS_FAILURE_FIELD],
  );
  // Other failures keep their row; never print the same failure twice.
  if (
    state.status === 'error' &&
    lastMessage?.role === 'system' &&
    lastMessage.blocks.some(
      (block) => block.type === 'text' && block.text === `Error: ${message}`,
    )
  ) {
    const stamped = stampCodexModelAccessFailure(
      closedMessages,
      message,
      modelAccessFailure,
    );
    return stamped === state.messages ? state : { ...state, messages: stamped };
  }
  const next = handleCodexError(
    { ...state, messages: closedMessages },
    { ...event, message },
    options,
  );
  const stamped = stampCodexModelAccessFailure(
    next.messages,
    message,
    modelAccessFailure,
  );
  return stamped === next.messages ? next : { ...next, messages: stamped };
}

/**
 * Copy the trusted model-access carrier from a failed turn's terminal result
 * onto that turn's `Error:` row (CAN-4716), the way `canopy_display_error_code`
 * reaches its row. The native failure event usually wrote the row first, so
 * this finds it rather than adding one. Only the trailing system row is
 * considered, so an earlier turn's row never changes.
 */
function stampCodexModelAccessFailure(
  messages: ChatMessage[],
  errorMessage: string,
  failure: CodexAccountModelAccessFailure | undefined,
): ChatMessage[] {
  if (!failure) return messages;
  const index = messages.length - 1;
  const last = messages[index];
  if (last?.role !== 'system') return messages;
  const text = `Error: ${errorMessage}`;
  let changed = false;
  const blocks = last.blocks.map((block) => {
    if (block.type !== 'text' || block.text !== text) return block;
    changed = true;
    return { ...block, modelAccessFailure: failure };
  });
  if (!changed) return messages;
  return messages.map((message, position) =>
    position === index ? { ...last, blocks } : message,
  );
}

const CODEX_EVENT_HANDLERS: Record<string, CodexEventHandler> = {
  'thread.started': handleCodexThreadStarted,
  'thread.token_usage.updated': handleCodexTokenUsageUpdated,
  'turn.started': handleCodexTurnStarted,
  'item.started': handleCodexItem,
  'item.updated': handleCodexItem,
  'rate_limit.reached': handleCodexRateLimitReached,
  'item.completed': handleCodexItem,
  'item.plan.delta': handleCodexItemPlanDelta,
  'turn.completed': handleCodexTurnCompleted,
  'turn.failed': handleCodexTurnFailed,
  error: handleCodexError,
  result: handleCodexStartupResult,
};

export function applyCodexTranscriptEvent(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  if (state.usage?.reportedTurnUsage !== undefined) {
    state = {
      ...state,
      usage: { ...state.usage, reportedTurnUsage: undefined },
    };
  }
  const next = reduceCodexTranscriptEvent(state, event, options);
  return options.rootTurnMode === 'canonical-content-only'
    ? keepCanonicalRootTurn(state, next)
    : next;
}

function reduceCodexTranscriptEvent(
  state: TranscriptReducerState,
  event: Record<string, unknown>,
  options: TranscriptReducerOptions,
): TranscriptReducerState {
  if (event.type === CHILD_TOOLS_ENDED_EVENT_TYPE)
    return applyChildToolsEndedEvent(state, event, options);
  if (event.type === CANOPY_DELEGATION_EVENT_TYPE)
    return applyDelegationTranscriptEvent(state, event);
  if (event.type === 'canopy_user_prompt') {
    const promptMessage = buildSyntheticUserPromptMessage(
      state.messages,
      event,
      options,
    );
    if (!promptMessage) {
      return state;
    }

    const resumedMessages = resumeHiddenPromptTimer(
      state,
      promptMessage,
      options,
    );
    if (resumedMessages)
      return {
        ...state,
        messages: resumedMessages,
        status: 'streaming',
        lastEventAt: options.now,
      };

    if (isRecord(event.steering) && event.steering.startsTurn === false) {
      return {
        ...state,
        messages: state.messages.some(
          (message) => message.id === promptMessage.id,
        )
          ? state.messages
          : [...state.messages, promptMessage],
        lastEventAt: options.now,
      };
    }

    const provider = asString(event.provider);
    const existingPromptIndex = state.messages.findIndex(
      (message) => message.id === promptMessage.id,
    );
    const existingTurnMessages =
      existingPromptIndex < 0
        ? []
        : state.messages.slice(existingPromptIndex + 1);
    // Replaying the current open turn must preserve its prompt/timer order.
    // A timer after a later user boundary belongs to a different turn.
    const replaysOpenTurn =
      existingPromptIndex >= 0 &&
      !existingTurnMessages.some(isUserTurnBoundary) &&
      hasOpenTurnTimer(existingTurnMessages);
    const promptMessages = movePromptToEnd(
      state.messages,
      promptMessage.id,
    ) ?? [...state.messages, promptMessage];
    return {
      ...state,
      messages: replaysOpenTurn
        ? state.messages
        : [
            ...promptMessages,
            buildSyntheticTurnTimerMessage(promptMessages, options, event),
          ],
      providerType:
        provider === 'claude' ||
        provider === 'codex' ||
        provider === 'cursor' ||
        provider === 'copilot' ||
        provider === 'antigravity' ||
        provider === 'opencode'
          ? provider
          : state.providerType,
      lastEventAt: options.now,
    };
  }

  if (
    event.type === 'canopy_injected_prompt' ||
    event.type === 'canopy_transcript_truncated'
  ) {
    return {
      ...state,
      lastEventAt: options.now,
    };
  }

  if (event.type === CANOPY_AUTH_FAILURE_EVENT_TYPE) {
    return applyCanopyAuthFailureEvent(state, event, options);
  }

  if (event.type === 'canopy_helper_diagnostic') {
    return {
      ...state,
      messages: [
        ...state.messages,
        buildCanopyHelperDiagnosticMessage(event, options),
      ],
      lastEventAt: options.now,
    };
  }

  if (event.type === 'canopy_compaction') {
    return applyCanopyCompactionEvent(state, event, options, 'codex');
  }

  if (event.type === CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE) {
    return applyAccountProxySwitchEvent(state, event, options);
  }
  if (event.type === CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE) {
    return applyClaudeModsSkippedEvent(state, event, options);
  }

  const eventType = typeof event.type === 'string' ? event.type : '';
  const handler = CODEX_EVENT_HANDLERS[eventType];
  if (!handler) {
    return state;
  }
  return withNoBillingSourceState(
    handler(state, event, options),
    event,
    'codex',
    options.now,
  );
}

function buildAgentLoopIterationMessage(
  line: Record<string, unknown>,
  createMessageId: () => string,
  now: number,
): ChatMessage | null {
  const iteration =
    typeof line.iteration === 'number' ? line.iteration : undefined;
  const check = isRecord(line.check) ? line.check : undefined;
  if (iteration === undefined || !check) {
    return null;
  }

  const parts = [
    `Iteration ${String(iteration)} check ${check.passed === true ? 'passed' : 'failed'}`,
    typeof check.exitCode === 'number'
      ? `Exit code: ${String(check.exitCode)}`
      : undefined,
    typeof check.stdout === 'string' && check.stdout.trim().length > 0
      ? `stdout:\n${check.stdout.trim()}`
      : undefined,
    typeof check.stderr === 'string' && check.stderr.trim().length > 0
      ? `stderr:\n${check.stderr.trim()}`
      : undefined,
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join('\n\n');

  return {
    id: createMessageId(),
    role: 'system',
    blocks: [{ type: 'text', text: parts }],
    timestamp: now,
  };
}

function finalizeParsedTranscript(
  state: TranscriptReducerState,
  skippedLineCount: number,
): ParsedTranscript {
  return {
    messages: state.messages,
    usage: state.usage,
    agentUsage: state.agentUsage,
    providerType: state.providerType,
    skippedLineCount,
  };
}

export function parseAgentTranscriptLines(
  lines: string[],
  preferredProvider?: AgentProviderType,
  parseOptions: TranscriptParseOptions = {},
): ParsedTranscript {
  let state = createEmptyTranscriptReducerState();
  let skippedLineCount = 0;
  let detectedProvider = preferredProvider;
  let messageIndex = 0;

  const createMessageId = (): string => {
    messageIndex += 1;
    return `transcript-${String(messageIndex)}`;
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      skippedLineCount += 1;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skippedLineCount += 1;
      return;
    }

    if (!isRecord(parsed)) {
      skippedLineCount += 1;
      return;
    }

    const now = index + 1;
    const options: TranscriptReducerOptions = {
      now,
      createMessageId,
      childToolLiveness: { kind: 'unknown' },
      ...(parseOptions.turnStartedAt != null
        ? { turnStartedAt: parseOptions.turnStartedAt }
        : {}),
      ...(parseOptions.turnCompletedAt !== undefined
        ? { turnCompletedAt: parseOptions.turnCompletedAt }
        : {}),
      useNowAsTurnTimestamp: false,
      aiCreditsRouted: parseOptions.aiCreditsRouted,
      ...(parseOptions.transcriptStorageFormat !== undefined
        ? { transcriptStorageFormat: parseOptions.transcriptStorageFormat }
        : {}),
    };

    if (
      parsed.provider === 'cursor' ||
      parsed.provider === 'copilot' ||
      parsed.provider === 'antigravity' ||
      parsed.provider === 'opencode'
    ) {
      detectedProvider = parsed.provider;
      state = applyClaudeTranscriptEvent(
        { ...state, providerType: parsed.provider },
        parsed,
        options,
      );
      return;
    }
    if (parsed.type === 'agent_loop_event' && isRecord(parsed.event)) {
      detectedProvider = detectedProvider ?? 'claude';
      state = applyClaudeTranscriptEvent(state, parsed.event, options);
      return;
    }

    if (
      parsed.type === CHILD_TOOLS_ENDED_EVENT_TYPE ||
      parsed.type === CANOPY_DELEGATION_EVENT_TYPE ||
      parsed.type === 'canopy_user_prompt' ||
      parsed.type === 'canopy_injected_prompt' ||
      parsed.type === 'canopy_transcript_truncated' ||
      parsed.type === 'canopy_helper_diagnostic' ||
      parsed.type === 'canopy_compaction' ||
      parsed.type === CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE ||
      parsed.type === CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE ||
      // The consumer half of the Portal's structured-auth-failure replay —
      // without this entry the surface the wire model exists for silently
      // drops every one. The producer half is
      // `ObservabilityService.observeChatEvent`, which appends the event to the
      // turn's transcript sidecar (it matches no provider event shape, so it
      // needs its own branch there too). Both are required; neither alone is
      // sufficient.
      parsed.type === CANOPY_AUTH_FAILURE_EVENT_TYPE
    ) {
      if (parsed.type === 'canopy_user_prompt') {
        const provider = asString(parsed.provider);
        if (
          provider === 'claude' ||
          provider === 'codex' ||
          provider === 'cursor' ||
          provider === 'copilot' ||
          provider === 'antigravity' ||
          provider === 'opencode'
        ) {
          detectedProvider = detectedProvider ?? provider;
        }
      }
      if (parsed.type === 'canopy_compaction') {
        const provider = asString(parsed.provider);
        if (
          provider === 'claude' ||
          provider === 'codex' ||
          provider === 'cursor' ||
          provider === 'copilot' ||
          provider === 'antigravity' ||
          provider === 'opencode'
        ) {
          detectedProvider = detectedProvider ?? provider;
        }
      }

      state =
        detectedProvider === 'codex'
          ? applyCodexTranscriptEvent(state, parsed, options)
          : applyClaudeTranscriptEvent(state, parsed, options);
      return;
    }

    if (parsed.type === 'agent_loop_iteration') {
      const message = buildAgentLoopIterationMessage(
        parsed,
        createMessageId,
        now,
      );
      if (message) {
        state = {
          ...state,
          messages: [...state.messages, message],
          lastEventAt: now,
        };
      } else {
        skippedLineCount += 1;
      }
      return;
    }

    const type = asString(parsed.type);
    const isClaudeEvent =
      type === 'system' ||
      type === 'assistant' ||
      type === 'user' ||
      type === 'result' ||
      type === 'error';
    const isCodexEvent =
      isCodexStartupResult(parsed) ||
      type === 'thread.started' ||
      type === 'thread.token_usage.updated' ||
      type === 'turn.started' ||
      type === 'turn.completed' ||
      type === 'turn.failed' ||
      type === 'error' ||
      type === 'item.started' ||
      type === 'item.updated' ||
      type === 'item.completed' ||
      type === 'item.plan.delta';
    const errorEventProvider = detectErrorEventProvider(parsed);

    if (detectedProvider === undefined) {
      if (errorEventProvider) {
        detectedProvider = errorEventProvider;
      } else if (isCodexEvent) {
        detectedProvider = 'codex';
      } else if (isClaudeEvent) {
        detectedProvider = 'claude';
      }
    }

    if (detectedProvider === 'codex' && isCodexEvent) {
      state = applyCodexTranscriptEvent(state, parsed, options);
      return;
    }

    if (detectedProvider === 'claude' && isClaudeEvent) {
      state = applyClaudeTranscriptEvent(state, parsed, options);
      return;
    }

    if (preferredProvider === undefined) {
      if (errorEventProvider === 'codex') {
        state = applyCodexTranscriptEvent(state, parsed, options);
        detectedProvider = 'codex';
        return;
      }
      if (errorEventProvider === 'claude') {
        state = applyClaudeTranscriptEvent(state, parsed, options);
        detectedProvider = 'claude';
        return;
      }
      if (type === 'error') {
        skippedLineCount += 1;
        return;
      }
      if (isCodexEvent) {
        state = applyCodexTranscriptEvent(state, parsed, options);
        detectedProvider = 'codex';
        return;
      }
      if (isClaudeEvent) {
        state = applyClaudeTranscriptEvent(state, parsed, options);
        detectedProvider = 'claude';
        return;
      }
    }

    skippedLineCount += 1;
  });

  if (parseOptions.closeOpenTurnAtEnd === true) {
    const completedAt =
      parseOptions.turnCompletedAt ?? state.lastEventAt ?? lines.length;
    state = {
      ...state,
      messages: closeOpenToolUseBlocks(
        completeAllOpenTurnTimers(state.messages, completedAt),
        createMessageId,
        completedAt,
        {
          liveness: { kind: 'no-live-session' },
          codexRootThreadId: state.sdkSessionId,
          agentCallBlocksById: indexCodexAgentCallBlocks(state.messages),
        },
      ),
    };
  }

  return finalizeParsedTranscript(state, skippedLineCount);
}
