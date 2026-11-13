import {
  ASK_USER_HTTP_TIMEOUT_MS,
  CANOPY_MCP_TOOL_TIMEOUT_MS,
  isCanopyAskUserToolName,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import { getCanonicalAppAdvisorToolKey } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { applyCodexMultiAgentConfig } from '@canopy/execution-engine/lib/codex-multi-agent';
import { clampCodexCommandOutput } from './command-output-clamp';
import { normalizeEpochMs } from '@canopy/desktop-shared/ai-credits-routing-state';
import { randomUUID } from 'node:crypto';
import type {
  ChatInputAdmission,
  ChatSteeringCapabilities,
} from '@canopy/protocol/portal';
import type { ChatInputSubmitResult, SteeringTarget } from '../agents/types';
import type { CodexTurnLifecycleObservation } from '../agents/codex-turn-lifecycle';
import type { CodexContractGuard } from '../agents/provider-contract-guard';
import {
  chatInputDeliveryFailure,
  chatInputRefusal,
  type ChatInputDeliveryFailure,
  type ChatInputRefusal,
} from '@canopy/protocol/portal/input-delivery';
import type { AiGatewayToolSchemaProfile } from '@canopy/protocol/ai-gateway-models';
import {
  type AgentModelConfig,
  type ApprovalCheck,
  type ApprovalMode,
  type ChatModel,
  DEFAULT_CODEX_MODEL,
  type McpQuestion,
  type McpQuestionAnswer,
  type SlashCommandData,
  type ThinkingLevel,
  clampThinkingLevelForModel,
} from '@canopy/desktop-shared/types';
import { suggestedCommandPattern } from '@canopy/desktop-shared/lib/approval-engine';
import { codexServiceTierForModelConfig } from '@canopy/execution-engine/lib/codex-model-config';
import {
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  assertCodexTurnSpeedAdmitted,
  codexLifecycleServiceTier,
} from './speed-policy';
import { CODEX_NATIVE_REASONING_ROUTE_FAMILY } from '@canopy/execution-engine/lib/gateway-model-availability';
import { formatAskUserAnswers } from '../canopy-tools/core';
import { requestAnswersFromRenderer } from '../canopy-tools/session-runtime';
import { rejectAllForSession } from '../mcp/pending-requests';
import type {
  ApprovalCheckDisplay,
  ApprovalOutcome,
  ApprovalSessionHandle,
} from '../approvals/approval-service';
import { APPROVAL_REQUEST_RESOLVED } from '../approvals/approval-service';
import type { SendableBrowserWindow } from '../lib/window-send';
import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import {
  codexApprovalPolicyFor,
  codexSandboxModeFor,
  codexSandboxPolicyFor,
} from './approval-policy';
import {
  buildCodexPlanModeDeveloperInstructions,
  DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  extractProposedPlan,
} from './plan-mode-instructions';
import type { AuthMode } from '@canopy/execution-engine/node/codex-runtime/generated/AuthMode';
import type { PlanType } from '@canopy/execution-engine/node/codex-runtime/generated/PlanType';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import type { AccountUpdatedNotification } from '@canopy/execution-engine/node/codex-runtime/generated/v2/AccountUpdatedNotification';
import type { AccountRateLimitsUpdatedNotification } from '@canopy/execution-engine/node/codex-runtime/generated/v2/AccountRateLimitsUpdatedNotification';
import type { Account } from '@canopy/execution-engine/node/codex-runtime/generated/v2/Account';
import type { GetAccountRateLimitsResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/GetAccountRateLimitsResponse';
import type { GetAccountResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/GetAccountResponse';
import type { RateLimitResetCredit } from '@canopy/execution-engine/node/codex-runtime/generated/v2/RateLimitResetCredit';
import type { RateLimitResetCreditStatus } from '@canopy/execution-engine/node/codex-runtime/generated/v2/RateLimitResetCreditStatus';
import type { RateLimitResetCreditsSummary } from '@canopy/execution-engine/node/codex-runtime/generated/v2/RateLimitResetCreditsSummary';
import type { RateLimitResetType } from '@canopy/execution-engine/node/codex-runtime/generated/v2/RateLimitResetType';
import type { RateLimitSnapshot } from '@canopy/execution-engine/node/codex-runtime/generated/v2/RateLimitSnapshot';
import type { RateLimitReachedType } from '@canopy/execution-engine/node/codex-runtime/generated/v2/RateLimitReachedType';
import type { SpendControlLimitSnapshot } from '@canopy/execution-engine/node/codex-runtime/generated/v2/SpendControlLimitSnapshot';
import type { ToolRequestUserInputResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/ToolRequestUserInputResponse';
import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import type { SelectedCapabilityRoot } from '@canopy/execution-engine/node/codex-runtime/generated/v2/SelectedCapabilityRoot';
import type { DynamicToolCallParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallResponse';
import type { McpServerElicitationRequestResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/McpServerElicitationRequestResponse';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { immediateTurnRestartCodexToolName } from './canopy-dynamic-tools';
import type { CodexErrorInfo } from '@canopy/execution-engine/node/codex-runtime/generated/v2/CodexErrorInfo';
import type { CollaborationMode } from '@canopy/execution-engine/node/codex-runtime/generated/CollaborationMode';
import type { ThreadStartParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/ThreadStartParams';
import type {
  CodexIngestionLagChange,
  CodexIngestionLagSample,
  CodexIngestionLagSnapshot,
} from '@canopy/execution-engine/node/codex-runtime/runtime-service';
import {
  type CodexCapabilityLeaseStore,
  type CodexCapabilityLeaseFile,
  type AppServerRequestMethod,
  type AppServerRequestParams,
  type AppServerRequestResponse,
  type CodexInteractiveOwner,
  type CodexInteractiveTransport,
  type CodexMcpToolCallContext,
  type CodexProcessRecoveryResult,
  type CodexRecoverableProcessExitError,
  type CodexSpawnProfileRequest,
  type CodexThreadSeedLoad,
  classifyCodexSteerError,
  CodexUnsafeRecoveryError,
  createCodexCapabilitySnapshotId,
  extractApprovalThreadId,
  dropTrailingUserInput,
  enabledCodexMcpServerNames,
  flattenCodexThreadConfig,
  getObservedCanonicalCodexHome,
  isCodexAppServerRequestTimeoutError,
  isCodexRecoverableProcessExitError,
  isCodexThreadWriterConflictError,
  loadCodexThreadSeedItemsWithLoadCount,
  projectCodexThreadItem,
  sanitizeSeedItemsForRouteChange,
  waitForCodexMcpServers,
  createCodexBackgroundWorkRegistry,
  readAllCodexBackgroundTerminalPages,
  type CodexBackgroundSnapshot,
  type CodexBackgroundReconciliationToken,
  type CodexBackgroundWorkRegistry,
  type CodexNativeBackgroundWork,
  readCodexMcpToolEvidence,
  type CodexMcpToolEvidence,
} from '@canopy/execution-engine/node/codex-runtime';
import { codexRuntimeForWorkerRun } from './runtime-service';
import type { ChatEventDrop } from '../lib/chat-event-drop-diagnostics';
import {
  attachProviderRunEvent,
  classifyProviderRunEvent,
  createProviderRunGeneration,
  observeProviderRunItem,
  pinProviderRun,
  registerProviderRun,
  retireProviderRunGeneration,
  settleProviderRun,
  unpinProviderRun,
  type ProviderRunGeneration,
  type ProviderRunHandle,
} from '../lib/provider-run-reconciliation';

export type DynamicToolCallHandler = (
  params: DynamicToolCallParams,
  options?: { signal?: AbortSignal },
) => Promise<DynamicToolCallResponse>;

type ProviderEventDrop = Omit<
  ChatEventDrop,
  'projectId' | 'worktreeId' | 'chatId'
>;

type CodexLateSteerResponse =
  | { kind: 'success'; value: unknown }
  | { kind: 'error'; error: Error };

interface SteeringInputCorrelation {
  threadId: string;
  turnId: string;
  pickedUp: boolean;
  submissionId?: string;
  userMessageId?: string;
  softTimedOut?: boolean;
  onLateResponse?: (outcome: CodexLateSteerResponse) => void;
}

type JsonRpcId = number | string;

const MAX_RETAINED_ROOT_EXECUTION_ANCHORS = 512;
const retainedRootExecutionAnchors = new Map<string, string>();

function retainedRootExecutionAnchorKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
  threadId: string,
  turnId: string,
): string {
  return JSON.stringify([projectId, worktreeId, chatId, threadId, turnId]);
}

function rememberRootExecutionAnchor(
  key: string,
  executionUserMessageId: string,
): void {
  retainedRootExecutionAnchors.delete(key);
  retainedRootExecutionAnchors.set(key, executionUserMessageId);
  while (
    retainedRootExecutionAnchors.size > MAX_RETAINED_ROOT_EXECUTION_ANCHORS
  ) {
    const oldestKey = retainedRootExecutionAnchors.keys().next().value;
    if (oldestKey === undefined) break;
    retainedRootExecutionAnchors.delete(oldestKey);
  }
}

function getRetainedRootExecutionAnchor(key: string): string | undefined {
  const executionUserMessageId = retainedRootExecutionAnchors.get(key);
  if (!executionUserMessageId) return undefined;
  // Reads refresh the bounded map's insertion-ordered eviction policy.
  retainedRootExecutionAnchors.delete(key);
  retainedRootExecutionAnchors.set(key, executionUserMessageId);
  return executionUserMessageId;
}

function forgetRetainedRootExecutionAnchor(key: string): void {
  retainedRootExecutionAnchors.delete(key);
}

function nativeTurnExecutionUserMessageId(
  turn: Record<string, unknown>,
): string | undefined {
  const firstUserMessage = readArray(turn, 'items')
    .filter(isRecord)
    .find((item) => readString(item, 'type') === 'userMessage');
  const clientId = firstUserMessage
    ? readString(firstUserMessage, 'clientId')
    : undefined;
  // Continuation messages are synthetic recovery instructions, not local
  // transcript messages. Their client ids must never become execution anchors.
  return clientId?.startsWith('codex-recovery:') ? undefined : clientId;
}

interface CodexTurnUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexTurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  usage?: CodexTurnUsage;
  error?: string;
  codexErrorInfo?: CodexErrorInfo;
  proposedPlanText?: string;
}

function waitForBestEffortPromiseOrAbort(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    void promise.then(finish, finish);
  });
}

interface StartTurnOptions {
  beforeAdmission?: () => Promise<void>;
  onAdmission?: () => void;
  text: string;
  cwd: string;
  /** Admitted Canopy message that owns this native execution. */
  executionUserMessageId?: string;
  submissionId?: string;
  /** Local transcript message id, distinct from the wire id used for retry. */
  userMessageId?: string;
  clientUserMessageId?: string;
  model?: ChatModel;
  /** Local catalog ID used for capability checks when `model` is a gateway ID. */
  capabilityModel?: ChatModel;
  aiCreditsRouted?: boolean;
  /** Route-scoped capability snapshot retained across live catalog refreshes. */
  supportedThinkingLevels?: readonly ThinkingLevel[];
  thinkingLevel: ThinkingLevel;
  modelConfig?: AgentModelConfig;
  planMode: boolean;
  proposalMode?: 'optional' | 'required';
  /** @deprecated Use modelConfig.speed. */
  codexFastModeEnabled?: boolean;
  /**
   * Set only by a caller that admitted Ultra fast for this exact turn
   * (`admitCodexSpeed`). An Ultra fast turn without it is refused before any
   * app-server request; Regular and Fast ignore it.
   */
  ultrafastAdmitted?: boolean;
}

/** The turn's requested speed record, reading the deprecated alias last. */
function startTurnModelConfig(
  opts: Pick<StartTurnOptions, 'modelConfig' | 'codexFastModeEnabled'>,
): AgentModelConfig | undefined {
  const speed = readCodexSpeedRecord(
    opts.modelConfig,
    opts.codexFastModeEnabled,
  );
  return speed === undefined
    ? opts.modelConfig
    : withCodexSpeed(opts.modelConfig, speed);
}

/**
 * Origin routing for a single thread item (`thread_id` / `turn_id` from the
 * notification that first introduced or updated the item). Captured per-item
 * so deferred completions and synthetic events can be attributed to the
 * subagent thread that produced them, even when the flushing turn belongs to
 * a different thread.
 */
interface CodexItemRouting {
  thread_id: string;
  turn_id?: string;
}

interface CodexTurnState {
  hostOwnsAdmission?: boolean;
  rootThreadId: string;
  turnId: string;
  executionUserMessageId?: string;
  submissionId?: string;
  userMessageId?: string;
  clientUserMessageId?: string;
  lifecycleOrigin?: 'user' | 'autonomous' | 'restart';
  allowResumeMerge?: boolean;
  lifecycleStartedTurnIds?: Set<string>;
  lifecycleBindingKeys?: Set<string>;
  unresolvedMergeTurnIds?: Set<string>;
  mergedResumeAnchor?: string;
  fatalRootError?: {
    threadId: string;
    turnId: string;
    message: string;
    codexErrorInfo?: CodexErrorInfo;
  };
  pendingRootTerminals?: Array<{
    method: string;
    notification: Record<string, unknown>;
    transcriptDrain?: Promise<void>;
  }>;
  providerRun?: ProviderRunHandle;
  providerOwned?: boolean;
  /** Native turn whose root start was emitted; recovery reuses this state for a new native turn. */
  rootStartEmittedTurnId?: string;
  dispatchResponseObserved?: boolean;
  providerOwnedCompletion?: Promise<void>;
  providerOwnedCompletionResolve?: () => void;
  /** Read-time lifecycle, separate from transcript finalization/admission. */
  controlPhase?: 'completed' | 'failed';
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
  items: Map<string, Record<string, unknown>>;
  /**
   * Origin routing per item id. Populated whenever a Codex notification
   * introduces or updates an item (item/started, item/*Delta, item/completed)
   * so we can replay the correct `thread_id` / `turn_id` on synthetic
   * (deferred / cancelled) emissions.
   */
  itemRoutings: Map<string, CodexItemRouting>;
  completedItemIds: Set<string>;
  commandOutputEmissions: Map<
    string,
    {
      emittedAtMs: number;
      outputLength: number;
      outputFingerprint: string;
    }
  >;
  usage?: CodexTurnUsage;
  latestCumulativeUsage?: CodexTurnUsage;
  latestAgentMessage?: string;
  latestPlanText?: string;
  previousTurnId?: string;
  userInterruptAcknowledged?: boolean;
  startParams?: AppServerRequestParams<'turn/start'>;
  recoveryPromise?: Promise<CodexProcessRecoveryResult>;
}

type CodexTurnItemBuffer = Pick<
  CodexTurnState,
  | 'items'
  | 'itemRoutings'
  | 'completedItemIds'
  | 'commandOutputEmissions'
  | 'latestAgentMessage'
  | 'latestPlanText'
>;

function retainCodexTurnItems(turn: CodexTurnState): CodexTurnItemBuffer {
  return {
    items: turn.items,
    itemRoutings: turn.itemRoutings,
    completedItemIds: turn.completedItemIds,
    commandOutputEmissions: turn.commandOutputEmissions,
    latestAgentMessage: turn.latestAgentMessage,
    latestPlanText: turn.latestPlanText,
  };
}

interface ImmediateTurnRestartRequest {
  turn: CodexTurnState;
  threadId: string;
  turnId: string;
}

interface ProviderRunState {
  readonly run: ProviderRunHandle;
  settled: boolean;
  startEmitted: boolean;
  lifecycleStartEmitted?: boolean;
  mergedBindingEmitted?: boolean;
}

function readCodexTurnUsage(
  usage: Record<string, unknown> | null,
): CodexTurnUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const result: CodexTurnUsage = {
    input_tokens: readNumber(usage, 'inputTokens'),
    cached_input_tokens: readNumber(usage, 'cachedInputTokens'),
    output_tokens: readNumber(usage, 'outputTokens'),
    reasoning_output_tokens: readNumber(usage, 'reasoningOutputTokens'),
  };
  return Object.values(result).some((value) => value !== undefined)
    ? result
    : undefined;
}

function projectCodexSubagentUsageBreakdown(
  usage: Record<string, unknown>,
): Record<string, number> {
  const projected: Record<string, number> = {};
  const fields: Array<[string, string]> = [
    ['inputTokens', 'input_tokens'],
    ['cachedInputTokens', 'cached_input_tokens'],
    ['cacheWriteInputTokens', 'cache_write_input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['reasoningOutputTokens', 'reasoning_output_tokens'],
  ];
  for (const [sourceKey, targetKey] of fields) {
    const value = readNumber(usage, sourceKey);
    if (value !== undefined && Number.isFinite(value)) {
      projected[targetKey] = value;
    }
  }
  return projected;
}

function addCodexTurnUsage(
  total: CodexTurnUsage | undefined,
  increment: CodexTurnUsage,
): CodexTurnUsage {
  return {
    input_tokens: (total?.input_tokens ?? 0) + (increment.input_tokens ?? 0),
    cached_input_tokens:
      (total?.cached_input_tokens ?? 0) + (increment.cached_input_tokens ?? 0),
    output_tokens: (total?.output_tokens ?? 0) + (increment.output_tokens ?? 0),
    reasoning_output_tokens:
      (total?.reasoning_output_tokens ?? 0) +
      (increment.reasoning_output_tokens ?? 0),
  };
}

function codexCumulativeUsageDelta(
  current: CodexTurnUsage,
  previous: CodexTurnUsage,
): CodexTurnUsage | null {
  const fields: Array<keyof CodexTurnUsage> = [
    'input_tokens',
    'cached_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
  ];
  if (
    fields.some(
      (field) =>
        current[field] !== undefined &&
        previous[field] !== undefined &&
        current[field] < previous[field],
    )
  ) {
    return null;
  }
  return {
    input_tokens: Math.max(
      0,
      (current.input_tokens ?? previous.input_tokens ?? 0) -
        (previous.input_tokens ?? 0),
    ),
    cached_input_tokens: Math.max(
      0,
      (current.cached_input_tokens ?? previous.cached_input_tokens ?? 0) -
        (previous.cached_input_tokens ?? 0),
    ),
    output_tokens: Math.max(
      0,
      (current.output_tokens ?? previous.output_tokens ?? 0) -
        (previous.output_tokens ?? 0),
    ),
    reasoning_output_tokens: Math.max(
      0,
      (current.reasoning_output_tokens ??
        previous.reasoning_output_tokens ??
        0) - (previous.reasoning_output_tokens ?? 0),
    ),
  };
}

type ChatEventEmitter = (data: unknown) => void | Promise<void>;

// Codex 0.146+ can execute injected tools inside the code-mode `exec` tool.
// Its dynamic-tool item completes just before the enclosing JavaScript cell
// records its custom-tool output. A small bounded drain after that completion
// prevents turn/interrupt from cancelling the cell between those two events.
const DEFERRED_TOOLS_CODE_MODE_DRAIN_MS = 250;
const CODEX_COMMAND_OUTPUT_UPDATE_MIN_INTERVAL_MS = 100;
const CODEX_COMMAND_OUTPUT_UPDATE_MIN_CHARS = 16 * 1024;
const CODEX_PROCESS_RECOVERY_MAX_ATTEMPTS = 3;
/**
 * The `thread/sample` prompt for a next prompt suggestion: the person's own
 * likely next message, short, in their words, or nothing.
 */
const CODEX_PROMPT_SUGGESTION_PROMPT =
  'Predict the next message the user will send in this conversation. Reply with only that message, written as the user would type it, in under 20 words. Do not use tools. If there is no clear next step, reply with nothing.';
const CODEX_PROCESS_RECOVERY_RETRY_DELAYS_MS: readonly number[] = [0, 250, 750];

function recoveryDelay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
interface ParsedUserInputOption {
  label: string;
  description: string;
}

interface ParsedUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ParsedUserInputOption[] | null;
}

interface ThreadConfigOptions {
  threadConfig?: { [key in string]?: JsonValue };
  mcpServersConfig?: { [key in string]?: JsonValue };
  multiAgentEnabled?: boolean;
  maxConcurrentSubagents?: number | null;
}

function buildThreadConfig(
  options: ThreadConfigOptions,
  projection: {
    includeSelectedMcpServers?: boolean;
    resetMcpServers?: boolean;
  } = {},
): { [key in string]?: JsonValue } | undefined {
  const config: { [key in string]?: JsonValue } = {
    ...(options.threadConfig ?? {}),
  };

  if (
    projection.includeSelectedMcpServers &&
    options.mcpServersConfig &&
    Object.keys(options.mcpServersConfig).length > 0
  ) {
    const existingMcpServers =
      config.mcp_servers &&
      typeof config.mcp_servers === 'object' &&
      !Array.isArray(config.mcp_servers)
        ? config.mcp_servers
        : {};
    config.mcp_servers = {
      ...existingMcpServers,
      ...options.mcpServersConfig,
    };
  }

  return flattenCodexThreadConfig(
    applyCodexMultiAgentConfig(config, {
      enabled: options.multiAgentEnabled,
      maxConcurrentSubagents: options.maxConcurrentSubagents,
    }),
    {
      resetMcpServers: projection.resetMcpServers,
    },
  );
}

/** In-memory identity of the selected provider route, never diagnostic data. */
export function codexThreadProviderRouteIdentity(
  config: { [key: string]: JsonValue | undefined } | undefined,
): string {
  const provider = config?.model_provider;
  if (typeof provider !== 'string') return JSON.stringify(['native-default']);
  const table = config?.[`model_providers.${provider}`];
  const baseUrl =
    config?.[`model_providers.${provider}.base_url`] ??
    (table && typeof table === 'object' && !Array.isArray(table)
      ? table.base_url
      : undefined);
  return JSON.stringify([
    'provider',
    provider,
    typeof baseUrl === 'string' ? ['url', baseUrl] : ['no-url'],
  ]);
}

function combineDeveloperInstructions(
  baseInstructions: string | undefined,
  planMode: boolean,
  proposalMode: 'optional' | 'required' = 'optional',
  planModeAddendum?: string,
): string | null {
  const parts = [
    baseInstructions?.trim() ?? '',
    planMode ? buildCodexPlanModeDeveloperInstructions(proposalMode) : '',
    // Session-specific exceptions to the Plan mode restrictions above, such
    // as Ledger bookkeeping, follow them so they read as explicit carve-outs.
    planMode ? (planModeAddendum?.trim() ?? '') : '',
  ].filter((part) => part.length > 0);

  if (parts.length === 0) {
    return null;
  }

  return parts.join('\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExpectedPromptCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === APPROVAL_REQUEST_RESOLVED ||
      error.message === 'ask_user_cancelled')
  );
}

function isCodexAppServerRequestTimeout(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'CodexAppServerRequestTimeoutError'
  );
}

/**
 * The app-server never answered a thread start or resume. Both precede
 * `turn/start`, so the user's input has not been sent.
 */
function isUnansweredThreadSetupRequest(error: unknown): boolean {
  return (
    isCodexAppServerRequestTimeoutError(error) &&
    (error.method === 'thread/start' || error.method === 'thread/resume')
  );
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  return readArray(record, key).filter(
    (value): value is string => typeof value === 'string',
  );
}

function parseJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    const parsedArray: JsonValue[] = [];
    for (const item of value) {
      const parsedItem = parseJsonValue(item);
      if (typeof parsedItem === 'undefined') {
        return undefined;
      }
      parsedArray.push(parsedItem);
    }
    return parsedArray;
  }

  if (isRecord(value)) {
    const parsedRecord: { [key in string]?: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const parsedItem = parseJsonValue(item);
      if (typeof parsedItem === 'undefined') {
        return undefined;
      }
      parsedRecord[key] = parsedItem;
    }
    return parsedRecord;
  }

  return undefined;
}

function parseUserInputOptions(
  value: unknown,
): ParsedUserInputOption[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const options: ParsedUserInputOption[] = [];
  for (const option of value) {
    if (!isRecord(option)) {
      return undefined;
    }

    const label = readString(option, 'label');
    const description = readString(option, 'description');
    if (typeof label !== 'string' || typeof description !== 'string') {
      return undefined;
    }

    options.push({ label, description });
  }

  return options;
}

function parseDynamicToolCallParams(
  params: Record<string, unknown>,
): DynamicToolCallParams | null {
  const threadId = readString(params, 'threadId');
  const turnId = readString(params, 'turnId');
  const callId = readString(params, 'callId');
  const tool = readString(params, 'tool');
  const rawNamespace = params.namespace;
  let namespace: string | null = null;
  if (
    typeof threadId !== 'string' ||
    typeof turnId !== 'string' ||
    typeof callId !== 'string' ||
    typeof tool !== 'string'
  ) {
    return null;
  }
  if (
    typeof rawNamespace !== 'undefined' &&
    rawNamespace !== null &&
    typeof rawNamespace !== 'string'
  ) {
    return null;
  }
  if (typeof rawNamespace === 'string') {
    namespace = rawNamespace;
  }
  const args = Object.prototype.hasOwnProperty.call(params, 'arguments')
    ? parseJsonValue(params.arguments ?? null)
    : null;
  if (typeof args === 'undefined') {
    return null;
  }
  return {
    threadId,
    turnId,
    callId,
    namespace,
    tool,
    arguments: args,
  };
}

function parseUserInputQuestions(
  params: Record<string, unknown>,
): ParsedUserInputQuestion[] | null {
  const rawQuestions = readArray(params, 'questions');
  const questions: ParsedUserInputQuestion[] = [];

  for (const rawQuestion of rawQuestions) {
    if (!isRecord(rawQuestion)) {
      return null;
    }

    const id = readString(rawQuestion, 'id');
    const header = readString(rawQuestion, 'header');
    const question = readString(rawQuestion, 'question');
    const isOther = readBoolean(rawQuestion, 'isOther');
    const isSecret = readBoolean(rawQuestion, 'isSecret');
    const options = parseUserInputOptions(rawQuestion.options);

    if (
      typeof id !== 'string' ||
      typeof header !== 'string' ||
      typeof question !== 'string' ||
      typeof isOther !== 'boolean' ||
      typeof isSecret !== 'boolean' ||
      typeof options === 'undefined'
    ) {
      return null;
    }

    questions.push({
      id,
      header,
      question,
      isOther,
      isSecret,
      options,
    });
  }

  return questions;
}

function extractThreadId(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }
  const thread = readRecord(result, 'thread');
  return thread ? (readString(thread, 'id') ?? null) : null;
}

function extractTurnId(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }
  const turn = readRecord(result, 'turn');
  return turn ? (readString(turn, 'id') ?? null) : null;
}

function extractNativeTurn(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) {
    return null;
  }
  return readRecord(result, 'turn');
}

function readNativeTurnStartedAtMs(
  turn: Record<string, unknown>,
): number | undefined {
  const startedAtSeconds = readNumber(turn, 'startedAt');
  return startedAtSeconds === undefined ? undefined : startedAtSeconds * 1000;
}

function readNativeTurnCompletionTiming(turn: Record<string, unknown>): {
  completedAtMs?: number;
  durationMs?: number;
} {
  const completedAtSeconds = readNumber(turn, 'completedAt');
  const durationMs = readNumber(turn, 'durationMs');
  return {
    ...(completedAtSeconds === undefined
      ? {}
      : { completedAtMs: completedAtSeconds * 1000 }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function extractThreadTurns(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result)) {
    return [];
  }
  const thread = readRecord(result, 'thread');
  if (!thread) {
    return [];
  }
  return readArray(thread, 'turns').filter(isRecord);
}

function latestThreadTurnId(result: unknown): string | undefined {
  const turns = extractThreadTurns(result);
  const latest = turns[turns.length - 1];
  return latest ? readString(latest, 'id') : undefined;
}

function findRecoveredThreadTurn(
  turns: Record<string, unknown>[],
  turnId: string,
  previousTurnId: string | undefined,
): Record<string, unknown> | undefined {
  if (turnId) {
    return turns.find((turn) => readString(turn, 'id') === turnId);
  }
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }
    if (previousTurnId && readString(turn, 'id') === previousTurnId) {
      return undefined;
    }
    return turn;
  }
  return undefined;
}

function parsePlanSteps(
  value: unknown,
): Array<{ step: string; status: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const steps: Array<{ step: string; status: string }> = [];
  for (const stepValue of value) {
    if (!isRecord(stepValue)) {
      continue;
    }

    const step = readString(stepValue, 'step');
    const status = readString(stepValue, 'status');
    if (typeof step === 'string' && typeof status === 'string') {
      steps.push({ step, status });
    }
  }

  return steps;
}

function hasSubagentThreadMarker(
  sourceValue: unknown,
  agentNickname: string | null,
  agentRole: string | null,
): boolean {
  return (
    agentNickname !== null ||
    agentRole !== null ||
    (isRecord(sourceValue) &&
      (Object.prototype.hasOwnProperty.call(sourceValue, 'subAgent') ||
        Object.prototype.hasOwnProperty.call(sourceValue, 'subagent')))
  );
}

function extractSubagentThreadMetadata(sourceValue: unknown): {
  nickname?: string;
  role?: string;
} {
  if (!isRecord(sourceValue)) {
    return {};
  }

  const subAgent =
    readRecord(sourceValue, 'subAgent') ?? readRecord(sourceValue, 'subagent');
  if (!subAgent) {
    return {};
  }

  const threadSpawn =
    readRecord(subAgent, 'thread_spawn') ?? readRecord(subAgent, 'threadSpawn');
  if (!threadSpawn) {
    return {};
  }

  const metadata: { nickname?: string; role?: string } = {};
  const nickname =
    readString(threadSpawn, 'agent_nickname') ??
    readString(threadSpawn, 'agentNickname');
  if (nickname !== undefined) {
    metadata.nickname = nickname;
  }

  const role =
    readString(threadSpawn, 'agent_role') ??
    readString(threadSpawn, 'agentRole');
  if (role !== undefined) {
    metadata.role = role;
  }

  return metadata;
}

function hasThreadDisplayMetadata(thread: Record<string, unknown>): boolean {
  const sourceMetadata = extractSubagentThreadMetadata(thread.source);
  return (
    readString(thread, 'agentNickname') !== undefined ||
    readString(thread, 'agent_nickname') !== undefined ||
    readString(thread, 'agentRole') !== undefined ||
    readString(thread, 'agent_role') !== undefined ||
    sourceMetadata.nickname !== undefined ||
    sourceMetadata.role !== undefined ||
    readString(thread, 'model') !== undefined ||
    readString(thread, 'reasoningEffort') !== undefined ||
    readString(thread, 'parentThreadId') !== undefined
  );
}

function mapThinkingToEffort(
  level: ThinkingLevel,
  model: string | undefined,
  aiCreditsRouted: boolean,
  supportedThinkingLevels?: readonly ThinkingLevel[],
): 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' {
  // Clamp to the model's supported tiers first so `ultra` only reaches the
  // app-server for models that declare it and `max` only reaches the
  // app-server for models that declare it. Unsupported upper tiers fall back
  // to the nearest supported lower tier.
  const clamped = clampThinkingLevelForModel(
    level,
    model,
    'codex',
    aiCreditsRouted,
    supportedThinkingLevels,
  );
  switch (clamped) {
    case 'off':
      return 'none';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'ultra':
      // Documented app-server reasoning effort for proactive multi-agent
      // behavior (see generated TurnStartParams: `effort: "ultra"`).
      return 'ultra';
    case 'max':
      return 'max';
    case 'xhigh':
      return 'xhigh';
    default:
      return 'high';
  }
}

function extractCompletedProposedPlan(
  turn: CodexTurnState,
): string | undefined {
  // Check completed agent_message items for explicit <proposed_plan> tags.
  for (const itemId of Array.from(turn.completedItemIds)) {
    const routing = turn.itemRoutings.get(itemId);
    if (routing && routing.thread_id !== turn.rootThreadId) {
      continue;
    }
    const item = turn.items.get(itemId);
    if (!item || readString(item, 'type') !== 'agent_message') {
      continue;
    }

    const plan = extractProposedPlan(readString(item, 'text'));
    if (plan) {
      return plan;
    }
  }

  // Fall back to native plan text from item/plan/delta events. Codex may
  // deliver the plan through its built-in plan mechanism rather than wrapping
  // it in <proposed_plan> tags inside an agent message.
  return turn.latestPlanText || undefined;
}

/**
 * Derives an "always allow" rule pattern candidate for a shell command, e.g.
 * `npm test` -> `npm test *`. Mirrors
 * `claude-approval-adapter.ts`'s `commandSuggestedTarget`.
 */
function commandSuggestedPattern(command: string): string {
  return suggestedCommandPattern(command);
}

function quoteLegacyCommandArgument(argument: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)) {
    return argument;
  }
  return `'${argument.split("'").join(`'"'"'`)}'`;
}

function formatLegacyCommand(command: readonly string[]): string {
  return command.map(quoteLegacyCommandArgument).join(' ');
}

function codexToolUseId(itemId: string | undefined): string | undefined {
  return itemId ? `codex-${itemId}` : undefined;
}

interface CodexApprovalRequirement {
  check: ApprovalCheck;
  display: ApprovalCheckDisplay;
}

function filesystemPermissionRequirement(
  access: 'read' | 'write',
  path: string,
  reason: string | undefined,
  toolUseId: string | undefined,
): CodexApprovalRequirement {
  if (access === 'write') {
    return {
      check: { kind: 'file-write', path, isGrant: true },
      display: {
        title: 'Codex wants additional file access',
        details: {
          kind: 'file-write',
          path,
          ...(reason ? { reason } : {}),
        },
        suggestedTarget: { kind: 'file-write', path },
        toolUseId,
      },
    };
  }
  const toolName = `codex:filesystem-read:${path}`;
  return {
    check: { kind: 'tool', toolName },
    display: {
      title: 'Codex wants additional file access',
      details: {
        kind: 'tool',
        toolName: 'Codex filesystem read',
        inputSummary: path,
        ...(reason ? { reason } : {}),
      },
      suggestedTarget: { kind: 'tool', toolName },
      toolUseId,
    },
  };
}

function permissionPathDisplay(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  const type = readString(value, 'type');
  if (type === 'path') {
    return readString(value, 'path') ?? null;
  }
  if (type === 'glob_pattern') {
    return readString(value, 'pattern') ?? null;
  }
  // Special roots do not provide enough path information to compare the
  // effective authority with narrower deny rules, so fail closed.
  return null;
}

interface ParsedPermissionRequirements {
  requirements: CodexApprovalRequirement[];
  normalizedPermissions: Record<string, unknown>;
}

function permissionRequirements(
  permissions: Record<string, unknown>,
  reason: string | undefined,
  toolUseId?: string,
): ParsedPermissionRequirements | null {
  const requirements: CodexApprovalRequirement[] = [];
  const normalizedPermissions: Record<string, unknown> = {};
  const network = readRecord(permissions, 'network');
  if (network) {
    const enabled = network.enabled;
    if (
      enabled !== null &&
      enabled !== undefined &&
      typeof enabled !== 'boolean'
    ) {
      return null;
    }
    normalizedPermissions.network = { enabled: enabled ?? null };
    if (enabled === true) {
      requirements.push({
        check: { kind: 'network', host: '*', isGrant: true },
        display: {
          title: 'Codex wants unrestricted network access',
          details: {
            kind: 'network',
            host: '*',
            ...(reason ? { reason } : {}),
          },
          suggestedTarget: { kind: 'network', host: '*' },
          toolUseId,
        },
      });
    }
  } else if (
    permissions.network !== null &&
    permissions.network !== undefined
  ) {
    return null;
  }

  const fileSystem = readRecord(permissions, 'fileSystem');
  if (fileSystem) {
    const read = fileSystem.read;
    const write = fileSystem.write;
    const entries = fileSystem.entries;
    const globScanMaxDepth = fileSystem.globScanMaxDepth;
    if (
      (read !== null && read !== undefined && !Array.isArray(read)) ||
      (write !== null && write !== undefined && !Array.isArray(write)) ||
      (entries !== null && entries !== undefined && !Array.isArray(entries)) ||
      (globScanMaxDepth !== undefined &&
        (typeof globScanMaxDepth !== 'number' ||
          !Number.isInteger(globScanMaxDepth) ||
          globScanMaxDepth < 0))
    ) {
      return null;
    }
    const normalizedFileSystem: Record<string, unknown> = {
      ...(read !== undefined ? { read } : {}),
      ...(write !== undefined ? { write } : {}),
      ...(entries !== undefined ? { entries: [] } : {}),
      ...(globScanMaxDepth !== undefined ? { globScanMaxDepth } : {}),
    };
    for (const path of read ?? []) {
      if (typeof path !== 'string') return null;
      requirements.push(
        filesystemPermissionRequirement('read', path, reason, toolUseId),
      );
    }
    for (const path of write ?? []) {
      if (typeof path !== 'string') return null;
      requirements.push(
        filesystemPermissionRequirement('write', path, reason, toolUseId),
      );
    }
    const normalizedEntries: Array<Record<string, unknown>> = [];
    for (const entry of entries ?? []) {
      if (!isRecord(entry)) return null;
      const access = readString(entry, 'access');
      if (access !== 'deny' && access !== 'read' && access !== 'write') {
        return null;
      }
      const path = permissionPathDisplay(entry.path);
      if (!path) return null;
      let persistedPath: unknown;
      if (typeof entry.path === 'string') {
        persistedPath = entry.path;
      } else if (
        isRecord(entry.path) &&
        readString(entry.path, 'type') === 'path'
      ) {
        persistedPath = { type: 'path', path };
      } else {
        persistedPath = { type: 'glob_pattern', pattern: path };
      }
      normalizedEntries.push({ access, path: persistedPath });
      if (access === 'deny') continue;
      requirements.push(
        filesystemPermissionRequirement(access, path, reason, toolUseId),
      );
    }
    if (entries !== undefined) {
      normalizedFileSystem.entries = normalizedEntries;
    }
    normalizedPermissions.fileSystem = normalizedFileSystem;
  } else if (
    permissions.fileSystem !== null &&
    permissions.fileSystem !== undefined
  ) {
    return null;
  }
  return { requirements, normalizedPermissions };
}

function toMcpQuestions(questions: ParsedUserInputQuestion[]): McpQuestion[] {
  return questions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    options: (question.options ?? []).map((option) => option.label),
    optionDescriptions: (question.options ?? []).map(
      (option) => option.description,
    ),
    allowOther: question.isOther,
    secret: question.isSecret,
  }));
}

interface McpElicitationFormField {
  key: string;
  question: McpQuestion;
  decode: (answer: McpQuestionAnswer | undefined) => JsonValue | undefined;
}

interface McpElicitationForm {
  questions: McpQuestion[];
  contentFromAnswers: (answers: McpQuestionAnswer[]) => {
    [key in string]?: JsonValue;
  };
}

function schemaQuestionText(
  message: string,
  key: string,
  schema: Record<string, unknown>,
): string {
  const fieldPrompt =
    readString(schema, 'description') ?? readString(schema, 'title') ?? key;
  return `${message}\n\n${fieldPrompt}`;
}

function selectedAnswer(
  answer: McpQuestionAnswer | undefined,
): string | undefined {
  return answer?.selectedOptions[0] ?? answer?.freeformText;
}

function validateStringFormat(value: string, format?: string): boolean {
  if (!format) return true;
  if (format === 'email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
  if (format === 'uri') {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  if (format === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }
  if (format === 'date-time') {
    return !Number.isNaN(Date.parse(value));
  }
  return false;
}

function buildMcpElicitationForm(
  message: string,
  requestedSchema: unknown,
): McpElicitationForm | null {
  if (!isRecord(requestedSchema) || requestedSchema.type !== 'object') {
    return null;
  }
  const properties = readRecord(requestedSchema, 'properties');
  if (!properties || Object.keys(properties).length === 0) {
    return null;
  }
  const rawRequired = requestedSchema.required;
  if (
    rawRequired !== undefined &&
    (!Array.isArray(rawRequired) ||
      rawRequired.some((value) => typeof value !== 'string'))
  ) {
    return null;
  }
  const required = new Set(
    Array.isArray(rawRequired)
      ? rawRequired.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  );
  if (Array.from(required).some((key) => !(key in properties))) {
    return null;
  }

  const fields: McpElicitationFormField[] = [];
  for (const [key, rawProperty] of Object.entries(properties)) {
    if (!isRecord(rawProperty)) {
      return null;
    }
    const type = readString(rawProperty, 'type');
    const title = readString(rawProperty, 'title') ?? key;
    const question = schemaQuestionText(message, key, rawProperty);
    const isRequired = required.has(key);

    if (type === 'boolean') {
      fields.push({
        key,
        question: {
          id: key,
          header: title,
          question,
          options: ['Yes', 'No'],
          // Its answer is the option alone; keep typed text in the composer.
          keepTextOnPick: true,
        },
        decode: (answer) => {
          const value = selectedAnswer(answer);
          if (value === undefined && !isRequired) return undefined;
          if (value === 'Yes') return true;
          if (value === 'No') return false;
          throw new Error(`Invalid boolean elicitation answer for ${key}`);
        },
      });
      continue;
    }

    if (type === 'number' || type === 'integer') {
      const minimum = readNumber(rawProperty, 'minimum');
      const maximum = readNumber(rawProperty, 'maximum');
      fields.push({
        key,
        question: {
          id: key,
          header: title,
          question,
          options: [],
          allowOther: true,
        },
        decode: (answer) => {
          const raw = answer?.freeformText?.trim();
          if (!raw && !isRequired) return undefined;
          if (!raw) {
            throw new Error(`Missing numeric elicitation answer for ${key}`);
          }
          const value = Number(raw);
          if (
            !Number.isFinite(value) ||
            (type === 'integer' && !Number.isInteger(value)) ||
            (minimum !== undefined && value < minimum) ||
            (maximum !== undefined && value > maximum)
          ) {
            throw new Error(`Invalid numeric elicitation answer for ${key}`);
          }
          return value;
        },
      });
      continue;
    }

    if (type === 'array') {
      const items = readRecord(rawProperty, 'items');
      if (!items) return null;
      const titledOptions = readArray(items, 'anyOf');
      const untitledOptions = readStringArray(items, 'enum');
      let options: string[];
      let optionDescriptions: string[] | undefined;
      if (titledOptions.length > 0) {
        const parsed = titledOptions.map((option) =>
          isRecord(option)
            ? {
                value: readString(option, 'const'),
                title: readString(option, 'title'),
              }
            : {},
        );
        if (
          parsed.some(
            (option) =>
              option.value === undefined || option.title === undefined,
          )
        ) {
          return null;
        }
        const validOptions = parsed.filter(
          (option): option is { value: string; title: string } =>
            option.value !== undefined && option.title !== undefined,
        );
        options = validOptions.map((option) => option.value);
        optionDescriptions = validOptions.map((option) => option.title);
      } else {
        options = untitledOptions;
      }
      if (options.length === 0 || new Set(options).size !== options.length) {
        return null;
      }
      const minItems = readNumber(rawProperty, 'minItems');
      const maxItems = readNumber(rawProperty, 'maxItems');
      fields.push({
        key,
        question: {
          id: key,
          header: title,
          question,
          options,
          ...(optionDescriptions ? { optionDescriptions } : {}),
          multiSelect: true,
        },
        decode: (answer) => {
          const values = answer?.selectedOptions ?? [];
          if (values.length === 0 && !isRequired) return undefined;
          if (
            values.some((value) => !options.includes(value)) ||
            (minItems !== undefined && values.length < minItems) ||
            (maxItems !== undefined && values.length > maxItems)
          ) {
            throw new Error(`Invalid array elicitation answer for ${key}`);
          }
          return values;
        },
      });
      continue;
    }

    if (type !== 'string') {
      return null;
    }

    const enumValues = readStringArray(rawProperty, 'enum');
    const enumNames = readStringArray(rawProperty, 'enumNames');
    const oneOf = readArray(rawProperty, 'oneOf');
    if (
      (Object.prototype.hasOwnProperty.call(rawProperty, 'enum') &&
        enumValues.length === 0) ||
      (Object.prototype.hasOwnProperty.call(rawProperty, 'oneOf') &&
        oneOf.length === 0)
    ) {
      return null;
    }
    let options: string[] = enumValues;
    let optionDescriptions: string[] | undefined;
    if (oneOf.length > 0) {
      const parsed: Array<{ value: string; title: string }> = [];
      for (const option of oneOf) {
        if (!isRecord(option)) return null;
        const value = readString(option, 'const');
        const title = readString(option, 'title');
        if (value === undefined || title === undefined) return null;
        parsed.push({ value, title });
      }
      options = parsed.map((option) => option.value);
      optionDescriptions = parsed.map((option) => option.title);
    } else if (enumNames.length > 0) {
      if (enumNames.length !== enumValues.length) return null;
      optionDescriptions = enumNames;
    }
    if (new Set(options).size !== options.length) {
      return null;
    }
    const minLength = readNumber(rawProperty, 'minLength');
    const maxLength = readNumber(rawProperty, 'maxLength');
    const format = readString(rawProperty, 'format');
    fields.push({
      key,
      question: {
        id: key,
        header: title,
        question,
        options,
        ...(optionDescriptions ? { optionDescriptions } : {}),
        ...(options.length === 0
          ? { allowOther: true }
          : { keepTextOnPick: true }),
      },
      decode: (answer) => {
        const value =
          options.length > 0 ? selectedAnswer(answer) : answer?.freeformText;
        if (value === undefined && !isRequired) return undefined;
        if (
          value === undefined ||
          (options.length > 0 && !options.includes(value)) ||
          (minLength !== undefined && value.length < minLength) ||
          (maxLength !== undefined && value.length > maxLength) ||
          !validateStringFormat(value, format)
        ) {
          throw new Error(`Invalid string elicitation answer for ${key}`);
        }
        return value;
      },
    });
  }

  return {
    questions: fields.map((field) => field.question),
    contentFromAnswers: (answers): { [key in string]?: JsonValue } => {
      const content: { [key in string]?: JsonValue } = {};
      for (const field of fields) {
        const answer = answers.find(
          (candidate) =>
            candidate.questionId === field.key ||
            candidate.question === field.question.question,
        );
        const value = field.decode(answer);
        if (value !== undefined) {
          content[field.key] = value;
        }
      }
      return content;
    },
  };
}

function answersToToolResponse(
  answers: Array<{
    questionId?: string;
    question: string;
    selectedOptions: string[];
    freeformText?: string;
  }>,
  originalQuestions: Array<{ id: string; question: string }>,
): ToolRequestUserInputResponse {
  const mapped: Record<string, { answers: string[] }> = {};
  for (const answer of answers) {
    const matched = originalQuestions.find(
      (question) =>
        question.id === answer.questionId ||
        question.question === answer.question,
    );
    if (!matched) continue;
    const mergedAnswers = [...answer.selectedOptions];
    if (answer.freeformText?.trim()) {
      mergedAnswers.push(answer.freeformText.trim());
    }
    mapped[matched.id] = { answers: mergedAnswers };
  }
  return { answers: mapped };
}

function formatRequestUserInputSyntheticAnswers(
  answers: Array<{
    questionId?: string;
    question: string;
    selectedOptions: string[];
    freeformText?: string;
  }>,
  originalQuestions: ParsedUserInputQuestion[],
): string {
  const displayAnswers = answers.map((answer, index) => {
    const matchedQuestion =
      originalQuestions.find(
        (question) =>
          question.id === answer.questionId ||
          question.question === answer.question,
      ) ?? originalQuestions[index];

    if (matchedQuestion?.isSecret !== true || !answer.freeformText) {
      return answer;
    }

    return {
      ...answer,
      freeformText: '[hidden]',
    };
  });

  return formatAskUserAnswers(displayAnswers);
}

function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const primaryValue = readRecord(value, 'primary');
  const secondaryValue = readRecord(value, 'secondary');
  const creditsValue = readRecord(value, 'credits');
  const individualLimitValue = readRecord(value, 'individualLimit');

  return {
    limitId: readString(value, 'limitId') ?? null,
    limitName: readString(value, 'limitName') ?? null,
    normalModelSlug: readString(value, 'normalModelSlug') ?? null,
    primary: primaryValue
      ? {
          usedPercent: readNumber(primaryValue, 'usedPercent') ?? 0,
          windowDurationMins:
            readNumber(primaryValue, 'windowDurationMins') ?? null,
          resetsAt: readNumber(primaryValue, 'resetsAt') ?? null,
        }
      : null,
    secondary: secondaryValue
      ? {
          usedPercent: readNumber(secondaryValue, 'usedPercent') ?? 0,
          windowDurationMins:
            readNumber(secondaryValue, 'windowDurationMins') ?? null,
          resetsAt: readNumber(secondaryValue, 'resetsAt') ?? null,
        }
      : null,
    credits: creditsValue
      ? {
          hasCredits: readBoolean(creditsValue, 'hasCredits') === true,
          unlimited: readBoolean(creditsValue, 'unlimited') === true,
          balance: readString(creditsValue, 'balance') ?? null,
        }
      : null,
    individualLimit: individualLimitValue
      ? parseSpendControlLimitSnapshot(individualLimitValue)
      : null,
    spendControlReached: readBoolean(value, 'spendControlReached') ?? null,
    planType: parsePlanType(readString(value, 'planType')),
    rateLimitReachedType: parseRateLimitReachedType(
      readString(value, 'rateLimitReachedType'),
    ),
  };
}

/**
 * Reduce a rate-limit snapshot to the fallback-routing decision (CAN-838, B2).
 * Returns `null` unless the account has actually reached a limit
 * (`rateLimitReachedType` is set). When reached, `resetsAt` is the soonest
 * reset time across the primary/secondary windows (ms since epoch), or `null`
 * when the app-server did not report one.
 */
function deriveRateLimitReached(
  snapshot: RateLimitSnapshot,
): { reachedType: RateLimitReachedType; resetsAt: number | null } | null {
  const reachedType = snapshot.rateLimitReachedType;
  if (!reachedType) {
    return null;
  }
  const resets = [
    snapshot.primary?.resetsAt ?? null,
    snapshot.secondary?.resetsAt ?? null,
  ].filter((value): value is number => typeof value === 'number');
  return {
    reachedType,
    resetsAt: resets.length > 0 ? Math.min(...resets) : null,
  };
}

function parseRateLimitResetType(value: unknown): RateLimitResetType {
  return value === 'codexRateLimits' ? value : 'unknown';
}

function parseRateLimitResetCreditStatus(
  value: unknown,
): RateLimitResetCreditStatus {
  return value === 'available' || value === 'redeeming' || value === 'redeemed'
    ? value
    : 'unknown';
}

function parseRateLimitResetCredits(
  value: unknown,
): RateLimitResetCredit[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const credits: RateLimitResetCredit[] = [];
  for (const creditValue of value) {
    if (!isRecord(creditValue)) {
      continue;
    }
    const id = readString(creditValue, 'id');
    const grantedAt = creditValue.grantedAt;
    if (typeof id !== 'string' || typeof grantedAt !== 'number') {
      continue;
    }
    credits.push({
      id,
      resetType: parseRateLimitResetType(creditValue.resetType),
      status: parseRateLimitResetCreditStatus(creditValue.status),
      grantedAt,
      expiresAt:
        typeof creditValue.expiresAt === 'number'
          ? creditValue.expiresAt
          : null,
      title: readString(creditValue, 'title') ?? null,
      description: readString(creditValue, 'description') ?? null,
    });
  }
  return credits;
}

function parseRateLimitResetCreditsSummary(
  value: unknown,
): RateLimitResetCreditsSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const credits = parseRateLimitResetCredits(value.credits);
  const availableCount = value.availableCount;
  if (typeof availableCount === 'bigint') {
    return { availableCount, credits };
  }
  if (typeof availableCount === 'number' && Number.isInteger(availableCount)) {
    return { availableCount: BigInt(availableCount), credits };
  }
  if (typeof availableCount === 'string' && /^\d+$/.test(availableCount)) {
    return { availableCount: BigInt(availableCount), credits };
  }

  return null;
}

function parseSpendControlLimitSnapshot(
  value: Record<string, unknown>,
): SpendControlLimitSnapshot {
  return {
    limit: readString(value, 'limit') ?? '',
    used: readString(value, 'used') ?? '',
    remainingPercent: readNumber(value, 'remainingPercent') ?? 0,
    resetsAt: readNumber(value, 'resetsAt') ?? 0,
  };
}

function parseRateLimitReachedType(
  value: string | undefined,
): RateLimitReachedType | null {
  switch (value) {
    case 'rate_limit_reached':
    case 'workspace_owner_credits_depleted':
    case 'workspace_member_credits_depleted':
    case 'workspace_owner_usage_limit_reached':
    case 'workspace_member_usage_limit_reached':
      return value;
    default:
      return null;
  }
}

function parsePlanType(value: string | undefined): PlanType | null {
  switch (value) {
    case 'free':
    case 'go':
    case 'plus':
    case 'pro':
    case 'team':
    case 'business':
    case 'enterprise':
    case 'edu':
    case 'unknown':
      return value;
    default:
      return null;
  }
}

function parseAuthMode(value: string | undefined): AuthMode | null {
  switch (value) {
    case 'apikey':
    case 'chatgpt':
    case 'chatgptAuthTokens':
      return value;
    default:
      return null;
  }
}

function buildTurnErrorMessage(error: Record<string, unknown>): string {
  const message = readString(error, 'message') ?? 'Codex turn failed';
  const additionalDetails = readString(error, 'additionalDetails');
  if (!additionalDetails?.trim()) {
    return message;
  }

  return `${message}\n${additionalDetails.trim()}`;
}

function isUnavailablePersistedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // The app-server reports absent native history with this word order.
    // It must use the same persisted-transcript recovery as "rollout not found".
    /\bno rollout found for thread id\b/i.test(message) ||
    /thread[^\n]*(?:not found|missing|does not exist|unavailable)/i.test(
      message,
    ) ||
    /(?:rollout|session)[^\n]*(?:not found|missing|does not exist|unavailable)/i.test(
      message,
    )
  );
}

function parseCodexErrorInfo(value: unknown): CodexErrorInfo | undefined {
  if (value === null || typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value === 'string') {
    switch (value) {
      case 'contextWindowExceeded':
      case 'usageLimitExceeded':
      case 'serverOverloaded':
      case 'cyberPolicy':
      case 'internalServerError':
      case 'unauthorized':
      case 'badRequest':
      case 'threadRollbackFailed':
      case 'sandboxError':
      case 'other':
        return value;
      default:
        return undefined;
    }
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const parseHttpStatusVariant = (
    key:
      | 'httpConnectionFailed'
      | 'responseStreamConnectionFailed'
      | 'responseStreamDisconnected'
      | 'responseTooManyFailedAttempts',
  ): { httpStatusCode: number | null } | undefined => {
    const payload = readRecord(value, key);
    if (!payload) {
      return undefined;
    }
    const httpStatusCode = payload.httpStatusCode;
    if (typeof httpStatusCode !== 'number' && httpStatusCode !== null) {
      return undefined;
    }
    return { httpStatusCode };
  };

  const httpConnectionFailed = parseHttpStatusVariant('httpConnectionFailed');
  if (httpConnectionFailed) {
    return { httpConnectionFailed };
  }
  const responseStreamConnectionFailed = parseHttpStatusVariant(
    'responseStreamConnectionFailed',
  );
  if (responseStreamConnectionFailed) {
    return { responseStreamConnectionFailed };
  }
  const responseStreamDisconnected = parseHttpStatusVariant(
    'responseStreamDisconnected',
  );
  if (responseStreamDisconnected) {
    return { responseStreamDisconnected };
  }
  const responseTooManyFailedAttempts = parseHttpStatusVariant(
    'responseTooManyFailedAttempts',
  );
  if (responseTooManyFailedAttempts) {
    return { responseTooManyFailedAttempts };
  }

  const activeTurnNotSteerable = readRecord(value, 'activeTurnNotSteerable');
  const turnKind = activeTurnNotSteerable
    ? readString(activeTurnNotSteerable, 'turnKind')
    : undefined;
  if (turnKind === 'review' || turnKind === 'compact') {
    return { activeTurnNotSteerable: { turnKind } };
  }

  return undefined;
}

function appendCodexCommandOutput(
  currentOutput: string,
  delta: string,
): string {
  return clampCodexCommandOutput(`${currentOutput}${delta}`);
}

function commandOutputFingerprint(output: string): string {
  return `${output.length}:${output.slice(0, 64)}:${output.slice(-64)}`;
}

function markCodexCommandOutputEmitted(
  turn: CodexTurnItemBuffer,
  itemId: string,
  output: string,
  emittedAtMs: number,
): void {
  turn.commandOutputEmissions.set(itemId, {
    emittedAtMs,
    outputLength: output.length,
    outputFingerprint: commandOutputFingerprint(output),
  });
}

function shouldEmitCodexCommandOutputUpdate(
  turn: CodexTurnItemBuffer,
  itemId: string,
  output: string,
  now: number,
): boolean {
  const previous = turn.commandOutputEmissions.get(itemId);
  if (!previous) {
    return true;
  }

  if (
    output.length - previous.outputLength >=
    CODEX_COMMAND_OUTPUT_UPDATE_MIN_CHARS
  ) {
    return true;
  }

  return (
    now - previous.emittedAtMs >= CODEX_COMMAND_OUTPUT_UPDATE_MIN_INTERVAL_MS
  );
}

function hasUnemittedCodexCommandOutput(
  turn: CodexTurnItemBuffer,
  itemId: string,
  output: string,
): boolean {
  const previous = turn.commandOutputEmissions.get(itemId);
  return previous?.outputFingerprint !== commandOutputFingerprint(output);
}

function appendTurnItemText(params: {
  turn: CodexTurnState;
  itemId: string;
  delta: string;
  textKey: 'text' | 'summary_text';
  defaultItem: Record<string, unknown>;
}): { updated: Record<string, unknown>; text: string } {
  const existing = params.turn.items.get(params.itemId) ?? params.defaultItem;
  const text = `${readString(existing, params.textKey) ?? ''}${params.delta}`;
  const updated = { ...existing, [params.textKey]: text };
  params.turn.items.set(params.itemId, updated);

  return { updated, text };
}

export function parseGetAccountResponsePayload(
  value: unknown,
): GetAccountResponse | null {
  if (!isRecord(value)) {
    return null;
  }

  const accountValue = readRecord(value, 'account');
  const accountType = accountValue ? readString(accountValue, 'type') : null;
  const chatGptAccount: Extract<Account, { type: 'chatgpt' }> | null =
    accountValue && accountType === 'chatgpt'
      ? {
          type: 'chatgpt',
          email: readString(accountValue, 'email') ?? null,
          planType:
            parsePlanType(readString(accountValue, 'planType')) ?? 'unknown',
          workspaceName: readString(accountValue, 'workspaceName') ?? null,
        }
      : null;

  return {
    account:
      chatGptAccount ?? (accountType === 'apiKey' ? { type: 'apiKey' } : null),
    requiresOpenaiAuth: readBoolean(value, 'requiresOpenaiAuth') === true,
    // Canopy does not consume backend routing; avoid retaining its account id.
    workspaceRouting: null,
  };
}

export function parseGetAccountRateLimitsPayload(
  value: unknown,
): GetAccountRateLimitsResponse | null {
  if (!isRecord(value)) {
    return null;
  }

  const rateLimits = parseRateLimitSnapshot(value.rateLimits);
  if (!rateLimits) {
    return null;
  }

  const mapped: { [key in string]?: RateLimitSnapshot } = {};
  const byIdRecord = readRecord(value, 'rateLimitsByLimitId');
  if (byIdRecord) {
    for (const [key, nestedValue] of Object.entries(byIdRecord)) {
      const parsed = parseRateLimitSnapshot(nestedValue);
      if (parsed) {
        mapped[key] = parsed;
      }
    }
  }

  return {
    ordinaryUsageAllowed: readBoolean(value, 'ordinaryUsageAllowed') ?? null,
    rateLimits,
    rateLimitsByLimitId: byIdRecord ? mapped : null,
    rateLimitResetCredits: parseRateLimitResetCreditsSummary(
      value.rateLimitResetCredits,
    ),
    accountId: readString(value, 'accountId') ?? null,
    rateLimitUpsell: parseJsonValue(value.rateLimitUpsell) ?? null,
  };
}

export function parseSkillsListPayload(
  value: unknown,
): SlashCommandData[] | null {
  if (!isRecord(value)) {
    return null;
  }

  const entries = readArray(value, 'data');
  const skills = new Map<string, SlashCommandData>();

  for (const rawEntry of entries) {
    if (!isRecord(rawEntry)) {
      return null;
    }

    for (const rawSkill of readArray(rawEntry, 'skills')) {
      if (!isRecord(rawSkill)) {
        return null;
      }

      const name = readString(rawSkill, 'name');
      const description = readString(rawSkill, 'description');
      const shortDescription = readString(rawSkill, 'shortDescription');
      const enabled = readBoolean(rawSkill, 'enabled');
      if (
        typeof name !== 'string' ||
        typeof description !== 'string' ||
        typeof enabled !== 'boolean'
      ) {
        return null;
      }
      if (!enabled || skills.has(name)) {
        continue;
      }

      const interfaceRecord = readRecord(rawSkill, 'interface');
      const interfaceShortDescription = interfaceRecord
        ? readString(interfaceRecord, 'shortDescription')
        : undefined;

      skills.set(name, {
        name,
        description:
          interfaceShortDescription ?? shortDescription ?? description,
        displayName: `$${name}`,
        insertText: `$${name} `,
      });
    }
  }

  return Array.from(skills.values());
}

function mapThreadItem(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  return projectCodexThreadItem(item, {
    transformCommandOutput: clampCodexCommandOutput,
  });
}

function isDeferredChatItem(item: Record<string, unknown>): boolean {
  const itemType = readString(item, 'type');
  return itemType === 'agent_message' || itemType === 'reasoning';
}

/**
 * Build an event payload that carries forwarded routing fields.
 * - `routing` MAY be omitted (e.g. when the producer can't determine origin
 *   routing); in that case the event is emitted without the fields rather
 *   than with empty strings.
 */
function withRouting<T extends Record<string, unknown>>(
  payload: T,
  routing: CodexItemRouting | undefined,
): Record<string, unknown> {
  if (!routing) {
    return payload;
  }
  const enriched: Record<string, unknown> = { ...payload };
  if (routing.thread_id) {
    enriched.thread_id = routing.thread_id;
  }
  if (routing.turn_id) {
    enriched.turn_id = routing.turn_id;
  }
  return enriched;
}

/**
 * Capture or refresh per-item origin routing. The routing for a given item id
 * is set once and never overwritten so deferred completions still carry the
 * thread/turn that originally produced the item, even if a later notification
 * (e.g. the flushing turn/completed) had different routing.
 */
function captureItemRouting(
  turn: CodexTurnItemBuffer | null,
  itemId: string | undefined,
  threadId: string | undefined,
  turnId: string | undefined,
): void {
  if (!turn || !itemId || typeof threadId !== 'string') {
    return;
  }
  if (turn.itemRoutings.has(itemId)) {
    return;
  }
  turn.itemRoutings.set(itemId, {
    thread_id: threadId,
    ...(typeof turnId === 'string' && turnId ? { turn_id: turnId } : {}),
  });
}

function emitCodexItemCompleted(
  emit: ChatEventEmitter,
  turn: CodexTurnItemBuffer,
  item: Record<string, unknown>,
  routing?: CodexItemRouting,
): void {
  const itemId = readString(item, 'id');
  if (!itemId || turn.completedItemIds.has(itemId)) {
    return;
  }

  turn.completedItemIds.add(itemId);
  if (readString(item, 'type') === 'command_execution') {
    markCodexCommandOutputEmitted(
      turn,
      itemId,
      readString(item, 'aggregated_output') ?? '',
      Date.now(),
    );
  }
  // Prefer the explicit routing the caller passed in (latest notification);
  // fall back to whatever was captured for this item id during streaming.
  const effectiveRouting = routing ?? turn.itemRoutings.get(itemId);
  void emit({
    type: 'codex',
    event: withRouting({ type: 'item.completed', item }, effectiveRouting),
  });
}

function emitCodexCommandOutputUpdate(
  emit: ChatEventEmitter,
  turn: CodexTurnItemBuffer,
  item: Record<string, unknown>,
  routing: CodexItemRouting | undefined,
  emittedAtMs: number,
): void {
  const itemId = readString(item, 'id');
  if (!itemId) {
    return;
  }
  const output = readString(item, 'aggregated_output') ?? '';
  markCodexCommandOutputEmitted(turn, itemId, output, emittedAtMs);
  void emit({
    type: 'codex',
    event: withRouting({ type: 'item.updated', item }, routing),
  });
}

function emitPendingCodexCommandOutputUpdates(
  emit: ChatEventEmitter,
  turn: CodexTurnItemBuffer,
): void {
  const now = Date.now();
  for (const [itemId, item] of Array.from(turn.items.entries())) {
    if (readString(item, 'type') !== 'command_execution') {
      continue;
    }
    const output = readString(item, 'aggregated_output') ?? '';
    if (!hasUnemittedCodexCommandOutput(turn, itemId, output)) {
      continue;
    }
    emitCodexCommandOutputUpdate(
      emit,
      turn,
      item,
      turn.itemRoutings.get(itemId),
      now,
    );
  }
}

function normalizedDeferredCompletionItem(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  let normalizedItem = item;
  if (
    readString(item, 'type') === 'reasoning' &&
    (readString(item, 'text') ?? '').trim().length === 0
  ) {
    const summaryText = readString(item, 'summary_text') ?? '';
    if (summaryText.trim().length > 0) {
      normalizedItem = { ...item, text: summaryText };
      delete normalizedItem.summary_text;
    }
  }

  const text = readString(normalizedItem, 'text') ?? '';
  if (text.trim().length === 0) {
    return null;
  }

  return normalizedItem;
}

function mergeCompletedDeferredItem(
  existingItem: Record<string, unknown> | undefined,
  completedItem: Record<string, unknown>,
): Record<string, unknown> {
  if (!existingItem || !isDeferredChatItem(completedItem)) {
    return completedItem;
  }

  if (readString(existingItem, 'type') !== readString(completedItem, 'type')) {
    return completedItem;
  }

  const completedText = readString(completedItem, 'text') ?? '';
  const completedSummaryText = readString(completedItem, 'summary_text') ?? '';
  if (
    completedText.trim().length > 0 ||
    completedSummaryText.trim().length > 0
  ) {
    return completedItem;
  }

  const existingText = readString(existingItem, 'text') ?? '';
  const existingSummaryText = readString(existingItem, 'summary_text') ?? '';
  if (
    existingText.trim().length === 0 &&
    existingSummaryText.trim().length === 0
  ) {
    return completedItem;
  }

  const merged: Record<string, unknown> = { ...completedItem };
  if (existingText.trim().length > 0) {
    merged.text = existingText;
  }
  if (
    readString(completedItem, 'type') === 'reasoning' &&
    existingSummaryText.trim().length > 0
  ) {
    merged.summary_text = existingSummaryText;
  }

  return merged;
}

function emitPendingDeferredCompletions(
  emit: ChatEventEmitter,
  turn: CodexTurnState,
): void {
  turn.items.forEach((item: Record<string, unknown>, itemId: string): void => {
    if (!isDeferredChatItem(item)) {
      return;
    }

    const normalizedItem = normalizedDeferredCompletionItem(item);
    if (!normalizedItem) {
      return;
    }

    // Subagent text emitted asynchronously must remain attributable to its
    // subagent thread for grouping. Use the routing we captured when the
    // item was first seen, NOT the routing of the flushing turn.
    emitCodexItemCompleted(
      emit,
      turn,
      normalizedItem,
      turn.itemRoutings.get(itemId),
    );
  });
}

export class CodexAppServerClient implements CodexInteractiveOwner {
  private readonly inputGeneration = randomUUID();
  private readonly steeringInputs = new Map<string, SteeringInputCorrelation>();
  private readonly cwd: string;
  private readonly onEvent: ChatEventEmitter;
  private notificationAdmissions: Promise<void>[] | null = null;
  private readonly getWindow: () => SendableBrowserWindow | null;
  private readonly projectId: string;
  private readonly worktreeId: string;
  private readonly chatId: string;
  private readonly sessionKey: string;
  private readonly initialThreadId?: string;
  private readonly mcpServersConfig?: { [key in string]?: JsonValue };
  private readonly onMcpToolEvidence?: (
    evidence: readonly CodexMcpToolEvidence[],
  ) => void;
  private readonly threadConfig?: { [key in string]?: JsonValue };
  private readonly multiAgentEnabled?: boolean;
  private readonly maxConcurrentSubagents?: number | null;
  private readonly getModelConfig?: () => AgentModelConfig;
  private readonly developerInstructions?: string;
  private readonly planModeDeveloperInstructionsAddendum?: string;
  private readonly dynamicTools?: DynamicToolSpec[];
  private readonly selectedCapabilityRoots?: SelectedCapabilityRoot[];
  private readonly capabilityStore?: CodexCapabilityLeaseStore;
  private readonly capabilitySnapshotId: string;
  private readonly reasoningRouteFamily: string;
  private readonly fallbackSeedItems: readonly JsonValue[];
  private readonly fallbackSeedItemsLoader?: () => Promise<
    readonly JsonValue[]
  >;
  private fallbackSeedItemsPromise?: Promise<readonly JsonValue[]>;
  private readonly seedNewThreadFromFallback: boolean;
  /**
   * Rebuild the thread on the next `ensureThread` even when the capability
   * snapshot matches. Mutable and consumed after the rebuild it requested:
   * `ensureThread` re-runs on this same client after a shared-process suspend
   * or restart, and a latched flag would force a needless second rebuild.
   */
  private forceMaterializeOnResume: boolean;
  /**
   * Route-family backfill for a legacy lease, held until a turn on the resumed
   * thread actually completes. A successful `thread/resume` does not prove the
   * persisted history came from the current route — the upstream provider only
   * rejects foreign reasoning when the turn replays it — so stamping at resume
   * time would record unverified provenance and let a later reconstruction
   * skip sanitization entirely.
   */
  private pendingReasoningRouteFamilyBackfill: CodexCapabilityLeaseFile | null =
    null;
  private readonly dynamicToolCallHandler?: DynamicToolCallHandler;
  private readonly onDynamicToolResultAccepted?: (call: {
    callId: string;
    threadId: string;
    turnId: string;
  }) => void;
  private readonly pendingNativeDynamicResults = new Map<
    string,
    { threadId: string; turnId: string }
  >();
  private readonly approvalSession?: ApprovalSessionHandle;
  private approvalMode: ApprovalMode;
  private readonly onAwaitingUser?: () => void;
  private readonly onSteeringEligibilityChanged?: () => void;
  private readonly onTurnLifecycleObservation?: (
    observation: CodexTurnLifecycleObservation,
  ) => void;
  private readonly onIngestionLagChange?: (
    change: CodexIngestionLagChange,
  ) => void | Promise<void>;
  private readonly onIngestionLagSample?: (
    sample: CodexIngestionLagSample,
  ) => void | Promise<void>;
  private readonly onProviderEventDropped?: (drop: ProviderEventDrop) => void;
  private readonly providerContractGuard?: CodexContractGuard;
  private readonly onProcessStarted?: (pid: number) => void;
  private readonly onProcessExit?: (details: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderrTail: string;
    stderrTruncated: boolean;
    pid: number | null;
    uptimeMs: number | null;
    clientCount: number;
    activeTurnCount: number;
    recoveryScheduled: boolean;
  }) => void;
  private readonly onProcessError?: (details: {
    error: string;
    stderrTail: string;
  }) => void;
  private readonly onProcessRecovery?: (details: {
    status: 'succeeded' | 'failed';
    strategy?: CodexProcessRecoveryResult['strategy'];
    error?: string;
  }) => void;
  private readonly connection: CodexInteractiveTransport;
  private providerRunGeneration: ProviderRunGeneration | null;
  private readonly providerRuns = new Map<string, ProviderRunState>();
  private readonly settledProviderRunKeys: string[] = [];
  private readonly backgroundWorkRegistry: CodexBackgroundWorkRegistry;
  private readonly backgroundWorkUnsubscribe: () => void;
  private backgroundSnapshot: CodexBackgroundSnapshot;
  private readonly backgroundPinnedProviderRuns = new Map<
    string,
    ProviderRunHandle
  >();
  private readonly backgroundReconciliationThreads = new Map<
    string,
    CodexBackgroundReconciliationToken
  >();
  private readonly backgroundWorkOwners = new Map<string, ProviderRunHandle>();
  private readonly observedBackgroundFrames = new WeakSet<
    Record<string, unknown>
  >();
  private backgroundNotificationDepth = 0;
  private readonly resumedLiveRootAnchors = new Map<
    string,
    string | undefined
  >();
  private readonly completedResumeTurnKeys = new Set<string>();
  private lastExecutionUserMessageId?: string;
  private readonly mcpStartupStates = new Map<
    string,
    Map<
      string,
      {
        status: 'starting' | 'ready' | 'failed' | 'cancelled';
        error?: string;
        failureReason?: string;
      }
    >
  >();
  private threadId?: string;
  private threadReady = false;
  private threadSetupGeneration = 0;
  private lastKnownTurnId?: string;
  private hasActivatedPlanCollaborationMode = false;
  private hasUnknownPlanCollaborationMode = false;
  private activeTurn: CodexTurnState | null = null;
  private readonly pendingTerminalSettlements = new Set<{
    owner: CodexAppServerClient | null;
    turn: CodexTurnState | null;
    result: CodexTurnResult | null;
  }>();
  private readonly outsideNotificationAdmissions = new Set<{
    owner: CodexAppServerClient | null;
    turn: CodexTurnState | null;
    rejectTurn: ((error: Error) => void) | null;
    generation: number;
  }>();
  /**
   * Item state from the most recently settled root turn. Codex can finish a
   * child after resolving its parent and carry the child's only transcript
   * items on that late completion. Keep one bounded buffer for projection and
   * de-duplication, then replace it when the next root turn starts.
   */
  private settledTurnItems: CodexTurnItemBuffer | null = null;
  private turnStartGeneration = 0;
  private pendingTurnStartGeneration: number | null = null;
  private dispatchedTurnStartGeneration: number | null = null;
  private turnStartCancellation: {
    generation: number;
    error: Error;
  } | null = null;
  private pendingTurnStartAbort: {
    generation: number;
    controller: AbortController;
  } | null = null;
  private closing = false;
  private readonly accountUpdatedListeners = new Set<
    (notification: AccountUpdatedNotification) => void
  >();
  private readonly rateLimitsUpdatedListeners = new Set<
    (notification: AccountRateLimitsUpdatedNotification) => void
  >();
  /**
   * De-dupe key for the last proactively-emitted `rate_limit.reached` event
   * (CAN-838, B2). Rate-limit snapshots arrive repeatedly; we only surface the
   * synthetic banner event once per distinct reached-window (`reachedType` +
   * `resetsAt`) and reset to `null` once the account is no longer reached so a
   * later re-exhaustion re-emits.
   */
  private lastEmittedRateLimitReachedKey: string | null = null;
  /**
   * Reset time (epoch ms) of the exhausted window in the latest reached
   * rate-limit snapshot, or `null` once a snapshot shows no exhausted window.
   * The Codex equivalent of Claude's `lastClaudeRejectedResetsAt`: attached to
   * usage-limit turn failures so the banner can offer "Resume at <time>" and
   * on-quota routing expires at reset (CAN-4564).
   */
  private lastReachedRateLimitResetsAtMs: number | null = null;
  private readonly listenerUnsubscribes = new Set<() => void>();
  private readonly hydratedSubagentThreadIds = new Set<string>();
  private readonly registeredSubagentThreadIds = new Set<string>();
  private readonly pendingRecoveryAbortControllers = new Set<AbortController>();
  private readonly dynamicToolCalls = new Map<
    JsonRpcId,
    { params: DynamicToolCallParams; controller: AbortController }
  >();
  // Only terminal turns lacking a native completion need an open-row fallback.
  private readonly stoppedDynamicToolCalls = new Map<
    string,
    { params: DynamicToolCallParams; text: string; synthetic: boolean }
  >();

  private dynamicToolKey(
    threadId: string,
    turnId: string,
    callId: string,
  ): string {
    return JSON.stringify([threadId, turnId, callId]);
  }

  private rememberStoppedDynamicToolCall(
    params: DynamicToolCallParams,
    text: string,
  ): void {
    this.stoppedDynamicToolCalls.set(
      this.dynamicToolKey(params.threadId, params.turnId, params.callId),
      { params, text, synthetic: false },
    );
  }

  private abortDynamicToolCalls(threadId?: string, turnId?: string): void {
    for (const call of Array.from(this.dynamicToolCalls.values())) {
      if (threadId !== undefined && call.params.threadId !== threadId) continue;
      if (turnId !== undefined && call.params.turnId !== turnId) continue;
      call.controller.abort();
    }
  }

  private closeStoppedDynamicToolRows(
    threadId?: string,
    turnId?: string,
  ): void {
    for (const stopped of Array.from(this.stoppedDynamicToolCalls.values())) {
      const { params } = stopped;
      if (
        stopped.synthetic ||
        (threadId !== undefined && params.threadId !== threadId) ||
        (turnId !== undefined && params.turnId !== turnId)
      )
        continue;
      const item = this.activeTurn?.items.get(params.callId);
      // Never rewrite a completed row. Earlier item frames have drained before
      // this terminal fallback, so a provider completion always wins normally.
      if (
        !item ||
        readString(item, 'type') !== 'dynamic_tool_call' ||
        readString(item, 'status') === 'completed' ||
        readString(item, 'status') === 'failed'
      )
        continue;
      stopped.synthetic = true;
      this.emitSyntheticCompleted(
        params.callId,
        {
          ...item,
          status: 'failed',
          success: false,
          content_items: [{ type: 'inputText', text: stopped.text }],
        },
        { thread_id: params.threadId, turn_id: params.turnId },
      );
    }
  }

  private hasSyntheticDynamicToolFailure(
    params: Record<string, unknown>,
    item: Record<string, unknown>,
  ): boolean {
    const threadId = readString(params, 'threadId');
    const turnId = readString(params, 'turnId');
    const callId = readString(item, 'id');
    return Boolean(
      threadId &&
      turnId &&
      callId &&
      readString(item, 'type') === 'dynamicToolCall' &&
      this.stoppedDynamicToolCalls.get(
        this.dynamicToolKey(threadId, turnId, callId),
      )?.synthetic,
    );
  }

  private readonly pendingDeferredToolResultIds = new Set<string>();
  private readonly pendingImmediateTurnRestartResultIds = new Set<string>();
  private immediateTurnRestartArmedTurnId?: string;
  private immediateTurnRestartRequest: ImmediateTurnRestartRequest | null =
    null;
  private pendingImmediateTurnRestartAbort: {
    request: ImmediateTurnRestartRequest;
    controller: AbortController;
  } | null = null;
  private pendingMcpReloadReadiness: Promise<void> | null = null;
  private rendererQuestionCancellationGeneration = 0;
  private approvalChecksCancelled = false;
  private disposed = false;

  constructor(opts: {
    cwd: string;
    projectId: string;
    worktreeId: string;
    chatId: string;
    sessionKey: string;
    initialThreadId?: string;
    initialExecutionUserMessageId?: string;
    onEvent: ChatEventEmitter;
    getWindow: () => SendableBrowserWindow | null;
    extraEnv?: Record<string, string>;
    /** Extra `-c key=value` app-server config overrides (e.g. gateway provider). */
    configArgs?: string[];
    spawnProfile?: CodexSpawnProfileRequest;
    mcpServersConfig?: { [key in string]?: JsonValue };
    onMcpToolEvidence?: (evidence: readonly CodexMcpToolEvidence[]) => void;
    mcpAuthorityIds?: readonly string[];
    /** Thread-scoped provider and feature configuration. */
    threadConfig?: { [key in string]?: JsonValue };
    multiAgentEnabled?: boolean;
    maxConcurrentSubagents?: number | null;
    modelConfig?: AgentModelConfig | (() => AgentModelConfig);
    /** @deprecated Use modelConfig. */
    codexFastModeEnabled?: () => boolean;
    developerInstructions?: string;
    /**
     * Appended after the Plan mode developer instructions on Plan mode turns
     * only: a session's explicit exceptions to those restrictions, such as
     * Ledger bookkeeping when the thread has the Ledger tools.
     */
    planModeDeveloperInstructionsAddendum?: string;
    /** Canopy-injected dynamic tools sent on `thread/start`. */
    dynamicTools?: DynamicToolSpec[];
    /** Projection used to produce the advertised dynamic tool schemas. */
    toolSchemaProfile?: AiGatewayToolSchemaProfile;
    /**
     * Provider compatibility family for persisted reasoning. Callers must
     * supply this explicitly: it is derived from the *routed* model and the
     * AI-Credits routing decision, which only the session layer knows. There
     * is deliberately no model-derived fallback here — an omitted family used
     * to resolve to `'native'`, the one value that suppresses sanitization
     * against a native lease, so a gateway-routed caller that forgot to pass
     * it would silently replay foreign reasoning.
     */
    reasoningRouteFamily?: string;
    /** Immutable plugin/skill/MCP roots supplied only when starting a thread. */
    selectedCapabilityRoots?: SelectedCapabilityRoot[];
    capabilityStore?: CodexCapabilityLeaseStore;
    capabilitySnapshotId?: string;
    /** Visible transcript fallback used only when the native rollout is gone. */
    fallbackSeedItems?: readonly JsonValue[];
    fallbackSeedItemsLoader?: () => Promise<readonly JsonValue[]>;
    seedNewThreadFromFallback?: boolean;
    /** Rebuild even when the persisted snapshot id matches (stale tool state). */
    forceMaterializeOnResume?: boolean;
    /**
     * Dispatcher for `item/tool/call` requests targeting injected dynamic
     * tools. If omitted, calls resolve to a failed `DynamicToolCallResponse`
     * (NOT a JSON-RPC error) per Section 5.3.
     */
    dynamicToolCallHandler?: DynamicToolCallHandler;
    onDynamicToolResultAccepted?: (call: {
      callId: string;
      threadId: string;
      turnId: string;
    }) => void;
    /**
     * Per-chat-session approval handle (Task 5/6). Optional because a few
     * one-shot helper clients (thread fork, discovery, account/skills reads)
     * never drive a turn and so never receive approval requests; when
     * omitted, `handleApprovalRequest` fails closed.
     */
    approvalSession?: ApprovalSessionHandle;
    approvalMode?: ApprovalMode;
    onAwaitingUser?: () => void;
    /** Reports changes to steering inputs; the owner schedules any reaction. */
    onSteeringEligibilityChanged?: () => void;
    onTurnLifecycleObservation?: (
      observation: CodexTurnLifecycleObservation,
    ) => void;
    onIngestionLagChange?: (
      change: CodexIngestionLagChange,
    ) => void | Promise<void>;
    onIngestionLagSample?: (
      sample: CodexIngestionLagSample,
    ) => void | Promise<void>;
    onProviderEventDropped?: (drop: ProviderEventDrop) => void;
    /** Turn-state phase 43b: reports notifications the lifecycle table lacks. */
    providerContractGuard?: CodexContractGuard;
    onProcessStarted?: (pid: number) => void;
    onProcessExit?: (details: {
      code: number | null;
      signal: NodeJS.Signals | null;
      stderrTail: string;
      stderrTruncated: boolean;
      pid: number | null;
      uptimeMs: number | null;
      clientCount: number;
      activeTurnCount: number;
      recoveryScheduled: boolean;
    }) => void;
    onProcessError?: (details: { error: string; stderrTail: string }) => void;
    onProcessRecovery?: (details: {
      status: 'succeeded' | 'failed';
      strategy?: CodexProcessRecoveryResult['strategy'];
      error?: string;
    }) => void;
  }) {
    this.cwd = opts.cwd;
    this.projectId = opts.projectId;
    this.worktreeId = opts.worktreeId;
    this.chatId = opts.chatId;
    this.sessionKey = opts.sessionKey;
    this.initialThreadId = opts.initialThreadId;
    this.threadId = opts.initialThreadId;
    this.backgroundWorkRegistry = createCodexBackgroundWorkRegistry({
      rootThreadId: () => this.threadId,
    });
    this.backgroundSnapshot = this.backgroundWorkRegistry.snapshot();
    this.backgroundWorkUnsubscribe = this.backgroundWorkRegistry.subscribe(
      (snapshot) => this.observeBackgroundSnapshot(snapshot),
    );
    this.lastExecutionUserMessageId = opts.initialExecutionUserMessageId;
    this.providerRunGeneration = createProviderRunGeneration({
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
    });
    this.hasUnknownPlanCollaborationMode = Boolean(opts.initialThreadId);
    this.onEvent = (data): void | Promise<void> => {
      const turnAtEmission = this.activeTurn;
      const generationAtEmission = this.turnStartGeneration;
      const providerEvent = this.attachProviderRunProvenance(data);
      if (!providerEvent) return;
      const admission = opts.onEvent(providerEvent);
      if (
        admission !== null &&
        typeof admission === 'object' &&
        typeof admission.then === 'function'
      ) {
        if (this.notificationAdmissions) {
          this.notificationAdmissions.push(admission);
        } else {
          // Setup and tool-request emissions have no incoming notification
          // frame to hold. They are finite, but an unobserved failed write
          // must still fail the attempt that emitted it, never a later turn.
          const token: {
            owner: CodexAppServerClient | null;
            turn: CodexTurnState | null;
            rejectTurn: ((error: Error) => void) | null;
            generation: number;
          } = {
            owner: this,
            turn: turnAtEmission,
            rejectTurn: turnAtEmission?.reject ?? null,
            generation: generationAtEmission,
          };
          this.outsideNotificationAdmissions.add(token);
          void admission.then(
            () => {
              if (token.owner) {
                token.owner.settleOutsideNotificationAdmission(token, false);
              } else {
                token.rejectTurn = null;
              }
            },
            (error: unknown) => {
              if (token.owner) {
                token.owner.settleOutsideNotificationAdmission(
                  token,
                  true,
                  error,
                );
              } else {
                const rejectTurn = token.rejectTurn;
                token.rejectTurn = null;
                rejectTurn?.(
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
            },
          );
        }
        return admission;
      }
      return;
    };
    this.getWindow = opts.getWindow;
    this.mcpServersConfig = opts.mcpServersConfig;
    this.onMcpToolEvidence = opts.onMcpToolEvidence;
    this.threadConfig = opts.threadConfig;
    this.multiAgentEnabled = opts.multiAgentEnabled;
    this.maxConcurrentSubagents = opts.maxConcurrentSubagents;
    if (typeof opts.modelConfig === 'function') {
      this.getModelConfig = opts.modelConfig;
    } else if (opts.modelConfig) {
      const staticModelConfig: AgentModelConfig = opts.modelConfig;
      this.getModelConfig = (): AgentModelConfig => staticModelConfig;
    } else if (opts.codexFastModeEnabled) {
      const legacyFastModeGetter = opts.codexFastModeEnabled;
      this.getModelConfig = (): AgentModelConfig => ({
        fastMode: legacyFastModeGetter() === true,
      });
    } else {
      this.getModelConfig = undefined;
    }
    this.developerInstructions = opts.developerInstructions;
    this.planModeDeveloperInstructionsAddendum =
      opts.planModeDeveloperInstructionsAddendum;
    this.dynamicTools = opts.dynamicTools;
    this.selectedCapabilityRoots = opts.selectedCapabilityRoots;
    this.capabilityStore = opts.capabilityStore;
    this.fallbackSeedItems = opts.fallbackSeedItems ?? [];
    this.fallbackSeedItemsLoader = opts.fallbackSeedItemsLoader;
    this.seedNewThreadFromFallback = opts.seedNewThreadFromFallback === true;
    this.forceMaterializeOnResume = opts.forceMaterializeOnResume === true;
    this.reasoningRouteFamily =
      opts.reasoningRouteFamily ?? CODEX_NATIVE_REASONING_ROUTE_FAMILY;
    this.capabilitySnapshotId =
      opts.capabilitySnapshotId ??
      createCodexCapabilitySnapshotId({
        roots: opts.selectedCapabilityRoots,
        mcpServers: opts.mcpServersConfig,
        mcpAuthorityIds: opts.mcpAuthorityIds,
        dynamicTools: opts.dynamicTools,
        toolSchemaProfile: opts.toolSchemaProfile,
      });
    this.dynamicToolCallHandler = opts.dynamicToolCallHandler;
    this.onDynamicToolResultAccepted = opts.onDynamicToolResultAccepted;
    this.approvalSession = opts.approvalSession;
    this.approvalMode = opts.approvalMode ?? 'ask';
    this.onAwaitingUser = opts.onAwaitingUser;
    this.onSteeringEligibilityChanged = opts.onSteeringEligibilityChanged;
    this.onTurnLifecycleObservation = opts.onTurnLifecycleObservation;
    this.onIngestionLagChange = opts.onIngestionLagChange;
    this.onIngestionLagSample = opts.onIngestionLagSample;
    this.onProviderEventDropped = opts.onProviderEventDropped;
    this.providerContractGuard = opts.providerContractGuard;
    this.onProcessStarted = opts.onProcessStarted;
    this.onProcessExit = opts.onProcessExit;
    this.onProcessError = opts.onProcessError;
    this.onProcessRecovery = opts.onProcessRecovery;
    this.connection = codexRuntimeForWorkerRun(
      'attachInteractiveClient',
    ).attachInteractiveClient({
      threadConfig: opts.threadConfig,
      profile: opts.spawnProfile ?? {
        ...(opts.extraEnv ? { environment: opts.extraEnv } : {}),
        ...(opts.configArgs ? { configArgs: opts.configArgs } : {}),
      },
      owner: this,
      processCallbacks: {
        onProcessStarted: this.onProcessStarted,
        onProcessExit: this.onProcessExit,
        onProcessError: this.onProcessError,
        onProcessRecovery: this.onProcessRecovery,
      },
    });
  }

  private recordProviderEventDropped(drop: ProviderEventDrop): void {
    try {
      this.onProviderEventDropped?.(drop);
    } catch {
      // Diagnostics must never change app-server event delivery decisions.
    }
  }

  private providerRunKey(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
  }

  private retainedRootExecutionAnchorKey(
    threadId: string,
    turnId: string,
  ): string {
    return retainedRootExecutionAnchorKey(
      this.projectId,
      this.worktreeId,
      this.chatId,
      threadId,
      turnId,
    );
  }

  private ensureProviderRunGeneration(): ProviderRunGeneration {
    if (!this.providerRunGeneration) {
      this.providerRunGeneration = createProviderRunGeneration({
        projectId: this.projectId,
        worktreeId: this.worktreeId,
        chatId: this.chatId,
      });
    }
    return this.providerRunGeneration;
  }

  private retireProviderRunGeneration(
    replace: boolean,
    clearExecutionAnchor = false,
  ): void {
    for (const run of Array.from(this.backgroundPinnedProviderRuns.values())) {
      unpinProviderRun(run);
    }
    this.backgroundPinnedProviderRuns.clear();
    this.backgroundWorkOwners.clear();
    if (this.providerRunGeneration) {
      retireProviderRunGeneration(this.providerRunGeneration);
    }
    this.providerRunGeneration = replace
      ? createProviderRunGeneration({
          projectId: this.projectId,
          worktreeId: this.worktreeId,
          chatId: this.chatId,
        })
      : null;
    this.providerRuns.clear();
    this.settledProviderRunKeys.length = 0;
    this.resumedLiveRootAnchors.clear();
    this.completedResumeTurnKeys.clear();
    if (this.activeTurn) this.activeTurn.providerRun = undefined;
    if (clearExecutionAnchor) this.lastExecutionUserMessageId = undefined;
  }

  private emitTurnLifecycleObservation(
    observation: CodexTurnLifecycleObservation,
  ): void {
    try {
      this.onTurnLifecycleObservation?.(observation);
    } catch {
      // Shadow tracking is observational only and must never gate provider work.
    }
  }

  private bindStartIdentity(turn: CodexTurnState, turnId: string): void {
    turn.turnId = turnId;
    const key = this.providerRunKey(turn.rootThreadId, turnId);
    if (turn.allowResumeMerge === false) return;
    if (this.completedResumeTurnKeys.has(key)) return;
    if (!this.resumedLiveRootAnchors.has(key)) return;
    const anchor = this.resumedLiveRootAnchors.get(key);
    if (!anchor) {
      turn.unresolvedMergeTurnIds ??= new Set();
      if (!turn.unresolvedMergeTurnIds.has(turnId)) {
        turn.unresolvedMergeTurnIds.add(turnId);
        logMainProcessWarn('Codex resumed start merge unresolved', {
          code: 'codex_start_merge_unresolved',
          threadId: turn.rootThreadId,
          turnId,
        });
      }
      return;
    }
    // A known-live resumed native turn can accept another prompt even when it
    // happens to share the submitted message's existing execution anchor.
    // The marker still matters: the tracker can dedupe an already-known
    // binding while recognizing that this start joined provider-owned work.
    // The merge is recorded for the shadow binding only. Events keep the
    // dispatched anchor that the host's turn owns; re-anchoring canonical
    // turn membership to the joined turn is the reducer's job (phase 35).
    turn.mergedResumeAnchor = anchor;
  }

  private acceptStartResponse(
    turn: CodexTurnState,
    turnId: string,
    nativeTurn?: Record<string, unknown>,
  ): void {
    this.bindStartIdentity(turn, turnId);
    const runState = this.registerProviderRunForTurn(
      turn,
      turnId,
      turn.providerOwned ? 'provider_owned' : 'dispatched',
    );
    this.observeTurnStarted(turn, turnId, runState, nativeTurn);
    this.processPendingRootTerminals(turn);
  }

  private observeTurnStarted(
    turn: CodexTurnState,
    turnId: string,
    runState: ProviderRunState | undefined,
    nativeTurn?: Record<string, unknown>,
  ): void {
    const merged =
      turn.mergedResumeAnchor !== undefined &&
      turn.allowResumeMerge !== false &&
      turn.lifecycleOrigin !== 'restart' &&
      Boolean(turn.submissionId || turn.clientUserMessageId);
    turn.lifecycleStartedTurnIds ??= new Set();
    turn.lifecycleBindingKeys ??= new Set();
    const bindingKey = `${turnId}:${turn.submissionId ?? ''}:${turn.clientUserMessageId ?? ''}`;
    const startedAtMs = nativeTurn
      ? readNativeTurnStartedAtMs(nativeTurn)
      : undefined;
    const nativeTiming = startedAtMs === undefined ? {} : { startedAtMs };
    if (turn.lifecycleStartedTurnIds.has(turnId)) {
      if (merged && !turn.lifecycleBindingKeys.has(bindingKey)) {
        turn.lifecycleBindingKeys.add(bindingKey);
        if (runState) runState.mergedBindingEmitted = true;
        this.emitTurnLifecycleObservation({
          type: 'turn-started',
          threadId: turn.rootThreadId,
          turnId,
          origin: 'user',
          ...(turn.submissionId ? { submissionId: turn.submissionId } : {}),
          ...(turn.userMessageId ? { userMessageId: turn.userMessageId } : {}),
          ...nativeTiming,
          merged: true,
        });
      }
      return;
    }
    turn.lifecycleStartedTurnIds.add(turnId);
    if (runState) runState.lifecycleStartEmitted = true;
    const origin = merged
      ? 'user'
      : (turn.lifecycleOrigin ?? (turn.providerOwned ? 'autonomous' : 'user'));
    this.emitTurnLifecycleObservation({
      type: 'turn-started',
      threadId: turn.rootThreadId,
      turnId,
      origin,
      ...(origin === 'user' && turn.submissionId
        ? { submissionId: turn.submissionId }
        : {}),
      ...(origin === 'user' && turn.userMessageId
        ? { userMessageId: turn.userMessageId }
        : {}),
      ...nativeTiming,
      ...(merged ? { merged: true } : {}),
    });
    if (merged) {
      turn.lifecycleBindingKeys.add(bindingKey);
      if (runState) runState.mergedBindingEmitted = true;
    }
  }

  private processPendingRootTerminals(turn: CodexTurnState): void {
    const pending = turn.pendingRootTerminals;
    if (!pending || !turn.turnId) return;
    turn.pendingRootTerminals = [];
    for (const entry of pending) {
      const params = readRecord(entry.notification, 'params');
      const completed = params ? readRecord(params, 'turn') : undefined;
      const eventTurnId = completed
        ? readString(completed, 'id')
        : params
          ? readString(params, 'turnId')
          : undefined;
      const threadId = params ? readString(params, 'threadId') : undefined;
      if (
        (threadId === undefined || threadId === turn.rootThreadId) &&
        eventTurnId === turn.turnId
      ) {
        const apply = async (): Promise<void> => {
          if (this.activeTurn === turn) {
            await this.handleConnectionNotification(
              entry.method,
              entry.notification,
            );
          }
        };
        const rejectDrain = (error: unknown): void => {
          if (this.activeTurn === turn) {
            this.rejectActiveTurn(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        };
        if (entry.transcriptDrain) {
          void entry.transcriptDrain.then(apply).catch(rejectDrain);
        } else {
          void apply().catch(rejectDrain);
        }
      } else {
        this.recordRootRunDrop(
          entry.method,
          'turn_id_mismatch',
          threadId,
          eventTurnId,
        );
      }
    }
  }

  private registerProviderRunForTurn(
    turn: CodexTurnState,
    turnId: string,
    origin: ProviderRunHandle['origin'],
  ): ProviderRunState | undefined {
    if (!turn.rootThreadId || !turnId) return undefined;
    const key = this.providerRunKey(turn.rootThreadId, turnId);
    const existing = this.providerRuns.get(key);
    if (existing) {
      if (!existing.settled && turn.providerRun === existing.run) {
        return existing;
      }
      return undefined;
    }
    const executionUserMessageId = turn.executionUserMessageId;
    if (!executionUserMessageId) return undefined;
    const run = registerProviderRun(this.ensureProviderRunGeneration(), {
      threadId: turn.rootThreadId,
      turnId,
      executionUserMessageId,
      origin,
    });
    const state: ProviderRunState = {
      run,
      settled: false,
      startEmitted: turn.rootStartEmittedTurnId === turnId,
    };
    turn.turnId = turnId;
    turn.providerRun = run;
    this.providerRuns.set(key, state);
    this.observeBackgroundSnapshot(this.backgroundWorkRegistry.snapshot());
    // Items can precede the asynchronous start-response continuation. Bind
    // their observed identities too, without retaining any extra output.
    for (const item of Array.from(turn.items.values())) {
      const itemId = readString(item, 'id');
      const itemType = readString(item, 'type');
      if (itemId && itemType) observeProviderRunItem(run, itemId, itemType);
    }
    this.lastExecutionUserMessageId = executionUserMessageId;
    if (!turn.unresolvedMergeTurnIds?.has(turnId)) {
      rememberRootExecutionAnchor(
        this.retainedRootExecutionAnchorKey(turn.rootThreadId, turnId),
        executionUserMessageId,
      );
    }
    return state;
  }

  private settleProviderRunForTurn(turn: CodexTurnState): void {
    turn.providerOwnedCompletionResolve?.();
    turn.providerOwnedCompletionResolve = undefined;
    const run = turn.providerRun;
    if (!run) return;
    const key = this.providerRunKey(run.threadId, run.turnId);
    const state = this.providerRuns.get(key);
    if (!state || state.run !== run || state.settled) return;
    state.settled = true;
    settleProviderRun(run);
    this.settledProviderRunKeys.push(key);
    this.pruneSettledProviderRunCache();
  }

  private pruneSettledProviderRunCache(): void {
    const countUnpinned = (): number =>
      this.settledProviderRunKeys.filter(
        (key) => !this.backgroundPinnedProviderRuns.has(key),
      ).length;
    while (countUnpinned() > 64) {
      const evictIndex = this.settledProviderRunKeys.findIndex(
        (key) => !this.backgroundPinnedProviderRuns.has(key),
      );
      if (evictIndex < 0) return;
      const [evictedKey] = this.settledProviderRunKeys.splice(evictIndex, 1);
      if (evictedKey) this.providerRuns.delete(evictedKey);
    }
  }

  private backgroundOwnerRun(
    work: CodexNativeBackgroundWork,
    snapshot: CodexBackgroundSnapshot,
  ): ProviderRunHandle | undefined {
    let threadId = work.kind === 'child' ? work.parentThreadId : work.threadId;
    let turnId = work.spawnedByTurnId;
    const visited = new Set<string>();
    const children = new Map(
      snapshot.work
        .filter(
          (
            entry,
          ): entry is Extract<CodexNativeBackgroundWork, { kind: 'child' }> =>
            entry.kind === 'child',
        )
        .map((entry) => [entry.threadId, entry]),
    );

    while (threadId !== snapshot.rootThreadId) {
      if (visited.has(threadId)) return undefined;
      visited.add(threadId);
      const parent = children.get(threadId);
      if (!parent) return undefined;
      turnId = parent.spawnedByTurnId;
      threadId = parent.parentThreadId;
    }
    if (!turnId) return undefined;
    return this.providerRuns.get(
      this.providerRunKey(snapshot.rootThreadId, turnId),
    )?.run;
  }

  private observeBackgroundSnapshot(snapshot: CodexBackgroundSnapshot): void {
    this.backgroundSnapshot = snapshot;
    const desired = new Map<string, ProviderRunHandle>();
    const liveWorkIds = new Set<string>();
    for (const work of snapshot.work) {
      liveWorkIds.add(work.id);
      const resolvedRun = this.backgroundOwnerRun(work, snapshot);
      if (resolvedRun) this.backgroundWorkOwners.set(work.id, resolvedRun);
      const run = resolvedRun ?? this.backgroundWorkOwners.get(work.id);
      if (!run || run.generation !== this.providerRunGeneration) continue;
      const key = this.providerRunKey(run.threadId, run.turnId);
      desired.set(key, run);
    }
    for (const workId of Array.from(this.backgroundWorkOwners.keys())) {
      if (!liveWorkIds.has(workId)) this.backgroundWorkOwners.delete(workId);
    }

    for (const [key, run] of Array.from(desired)) {
      if (this.backgroundPinnedProviderRuns.has(key)) continue;
      pinProviderRun(run);
      this.backgroundPinnedProviderRuns.set(key, run);
    }

    if (snapshot.reconciling || this.backgroundNotificationDepth > 0) return;
    this.releaseUnneededBackgroundRunPins(desired);
  }

  private releaseUnneededBackgroundRunPins(
    desired: ReadonlyMap<string, ProviderRunHandle>,
  ): void {
    for (const [key, run] of Array.from(this.backgroundPinnedProviderRuns)) {
      if (desired.has(key)) continue;
      unpinProviderRun(run);
      this.backgroundPinnedProviderRuns.delete(key);
    }
    this.pruneSettledProviderRunCache();
  }

  private flushBackgroundRunPins(): void {
    const snapshot = this.backgroundSnapshot;
    if (snapshot.reconciling) return;
    const desired = new Map<string, ProviderRunHandle>();
    const liveWorkIds = new Set<string>();
    for (const work of snapshot.work) {
      liveWorkIds.add(work.id);
      const resolvedRun = this.backgroundOwnerRun(work, snapshot);
      if (resolvedRun) this.backgroundWorkOwners.set(work.id, resolvedRun);
      const run = resolvedRun ?? this.backgroundWorkOwners.get(work.id);
      if (!run || run.generation !== this.providerRunGeneration) continue;
      desired.set(this.providerRunKey(run.threadId, run.turnId), run);
    }
    for (const workId of Array.from(this.backgroundWorkOwners.keys())) {
      if (!liveWorkIds.has(workId)) this.backgroundWorkOwners.delete(workId);
    }
    this.releaseUnneededBackgroundRunPins(desired);
  }

  private beginBackgroundNotificationFrame(): void {
    this.backgroundNotificationDepth += 1;
  }

  private finishBackgroundNotificationFrame(
    notification: Record<string, unknown>,
  ): void {
    this.observedBackgroundFrames.delete(notification);
    this.backgroundNotificationDepth = Math.max(
      0,
      this.backgroundNotificationDepth - 1,
    );
    if (this.backgroundNotificationDepth === 0) this.flushBackgroundRunPins();
  }

  private retireBackgroundWorkEpoch(): void {
    const snapshot = this.backgroundWorkRegistry.snapshot();
    if (snapshot.work.length > 0 || snapshot.reconciling) {
      logMainProcessWarn('Codex background work abandoned', {
        code: 'codex_background_work_abandoned',
        childCount: snapshot.work.filter((work) => work.kind === 'child')
          .length,
        terminalCount: snapshot.work.filter((work) => work.kind === 'terminal')
          .length,
        reconciliationPending: snapshot.reconciling,
      });
    }
    for (const run of Array.from(this.backgroundPinnedProviderRuns.values())) {
      unpinProviderRun(run);
    }
    this.backgroundPinnedProviderRuns.clear();
    this.backgroundWorkOwners.clear();
    this.backgroundReconciliationThreads.clear();
    this.backgroundWorkRegistry.retireEpoch();
  }

  private async reconcileBackgroundThread(threadId: string): Promise<void> {
    if (this.disposed || this.backgroundReconciliationThreads.has(threadId))
      return;
    const token = this.backgroundWorkRegistry.beginReconciliation(threadId);
    this.backgroundReconciliationThreads.set(threadId, token);
    try {
      const records = await readAllCodexBackgroundTerminalPages(
        (params) => this.request('thread/backgroundTerminals/list', params),
        threadId,
      );
      this.backgroundWorkRegistry.commitTerminalPages(token, records);
    } catch {
      this.backgroundWorkRegistry.failReconciliation(token);
      logMainProcessWarn('Codex background terminal reconciliation failed', {
        code: 'codex_background_terminal_reconciliation_failed',
        threadId,
      });
    } finally {
      if (this.backgroundReconciliationThreads.get(threadId) === token) {
        this.backgroundReconciliationThreads.delete(threadId);
      }
    }
  }

  private reconcileTerminalEvidence(snapshot: CodexBackgroundSnapshot): void {
    const liveChildThreadIds = new Set(
      snapshot.work
        .filter(
          (
            work,
          ): work is Extract<CodexNativeBackgroundWork, { kind: 'child' }> =>
            work.kind === 'child',
        )
        .map((work) => work.threadId),
    );
    const evidenceThreadIds = new Set<string>();
    for (const work of snapshot.work) {
      if (
        work.kind !== 'terminal' ||
        !work.processId ||
        (work.threadId !== snapshot.rootThreadId &&
          !liveChildThreadIds.has(work.threadId))
      ) {
        continue;
      }
      evidenceThreadIds.add(work.threadId);
    }
    for (const threadId of Array.from(evidenceThreadIds)) {
      void this.reconcileBackgroundThread(threadId);
    }
  }

  private observeResumedBackgroundTerminalItems(
    threadId: string,
    response: unknown,
  ): void {
    const finishedStatuses = new Set([
      'completed',
      'failed',
      'declined',
      'interrupted',
      'canceled',
      'cancelled',
      'stopped',
      'killed',
    ]);
    for (const turn of extractThreadTurns(response)) {
      const turnId = readString(turn, 'id');
      if (!turnId) continue;
      if (readString(turn, 'status') !== 'inProgress') {
        // A command still running from a closed turn already outlived that
        // turn, so the registry must not replay it as foreground.
        this.backgroundWorkRegistry.observe('turn/completed', {
          threadId,
          turn: { id: turnId },
        });
      }
      for (const item of readArray(turn, 'items').filter(isRecord)) {
        const itemType = readString(item, 'type')
          ?.replace(/[_-]/g, '')
          .toLowerCase();
        const processId =
          readString(item, 'processId') ?? readString(item, 'process_id');
        const status = readString(item, 'status')
          ?.replace(/[_-]/g, '')
          .toLowerCase();
        if (
          itemType !== 'commandexecution' ||
          !processId ||
          (status !== undefined && finishedStatuses.has(status))
        ) {
          continue;
        }
        this.backgroundWorkRegistry.observe('item/started', {
          threadId,
          turnId,
          item,
        });
      }
    }
  }

  private reconcileResumedBackgroundWork(threadId: string): void {
    const snapshot = this.backgroundWorkRegistry.snapshot();
    const children = snapshot.work.filter(
      (work): work is Extract<CodexNativeBackgroundWork, { kind: 'child' }> =>
        work.kind === 'child',
    );
    const relevantThreadIds = new Set([threadId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const child of children) {
        if (
          relevantThreadIds.has(child.parentThreadId) &&
          !relevantThreadIds.has(child.threadId)
        ) {
          relevantThreadIds.add(child.threadId);
          expanded = true;
        }
      }
    }

    for (const work of snapshot.work) {
      if (
        work.kind === 'terminal' &&
        this.backgroundWorkOwners.get(work.id)?.threadId === threadId
      ) {
        relevantThreadIds.add(work.threadId);
      }
    }
    const hasRelevantWork = snapshot.work.some((work) =>
      relevantThreadIds.has(work.threadId),
    );
    if (!hasRelevantWork) return;

    for (const candidateThreadId of Array.from(relevantThreadIds)) {
      void this.reconcileBackgroundThread(candidateThreadId);
    }
  }

  private isRootTerminalFrame(
    method: string,
    notification: Record<string, unknown>,
  ): boolean {
    if (method !== 'turn/completed') return false;
    const params = readRecord(notification, 'params');
    if (!params) return false;
    const threadId = readString(params, 'threadId') ?? this.threadId;
    if (!threadId || threadId !== this.threadId) return false;
    return Boolean(readRecord(params, 'turn'));
  }

  private handleRawBackgroundNotification(
    method: string,
    notification: Record<string, unknown>,
  ): boolean {
    if (this.observedBackgroundFrames.has(notification)) return false;
    this.observedBackgroundFrames.add(notification);
    this.beginBackgroundNotificationFrame();
    const params = readRecord(notification, 'params');
    this.backgroundWorkRegistry.observe(method, params);
    if (this.isRootTerminalFrame(method, notification)) {
      this.reconcileTerminalEvidence(this.backgroundWorkRegistry.snapshot());
    }
    return true;
  }

  private recordRootRunDrop(
    method: string,
    reason: string,
    threadId: string | undefined,
    turnId: string | undefined,
    itemId?: string,
  ): void {
    const isOutput = method.startsWith('item/') || method.startsWith('item.');
    const params = {
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
    };
    this.recordProviderEventDropped({
      providerType: 'codex',
      gate: isOutput
        ? 'codex_root_output_stale'
        : 'codex_root_completion_stale',
      reason,
      data: { method, params },
      ...(threadId ? { providerThreadId: threadId } : {}),
      ...(turnId ? { providerTurnId: turnId } : {}),
    });
  }

  private attachProviderRunProvenance(data: unknown): unknown {
    if (!isRecord(data) || data.type !== 'codex' || !isRecord(data.event)) {
      return data;
    }
    const event = data.event;
    const threadId = readString(event, 'thread_id');
    const turnId = readString(event, 'turn_id');
    if (!threadId || !turnId) return data;
    const key = this.providerRunKey(threadId, turnId);
    const state = this.providerRuns.get(key);
    if (!state) {
      // Runs without a currently registered tuple retain the legacy ordinary
      // provider path. Only a known settled tuple receives bounded late-event
      // authority; unknown work has no trusted provenance to filter here.
      return data;
    }
    if (state.run.generation !== this.providerRunGeneration) {
      if (!state.settled) {
        attachProviderRunEvent(data, state.run, 'running');
        return data;
      }
      this.recordRootRunDrop(
        typeof event.type === 'string' ? event.type : 'turn/completed',
        'retired_generation',
        threadId,
        turnId,
        isRecord(event.item) ? readString(event.item, 'id') : undefined,
      );
      return null;
    }

    if (state.settled) {
      if (event.type !== 'item.completed' || !isRecord(event.item)) {
        this.recordRootRunDrop(
          typeof event.type === 'string' ? event.type : 'turn/completed',
          'run_already_settled',
          threadId,
          turnId,
          isRecord(event.item) ? readString(event.item, 'id') : undefined,
        );
        return null;
      }
      attachProviderRunEvent(data, state.run, 'late');
      const classification = classifyProviderRunEvent(data, {
        projectId: this.projectId,
        worktreeId: this.worktreeId,
        chatId: this.chatId,
      });
      if (classification.kind !== 'transcript_only') {
        this.recordRootRunDrop(
          'item/completed',
          classification.kind === 'reject'
            ? classification.reason
            : 'unsupported_late_event',
          threadId,
          turnId,
          readString(event.item, 'id'),
        );
        return null;
      }
      return data;
    }

    if (
      (event.type === 'item.started' ||
        event.type === 'item.updated' ||
        event.type === 'item.completed') &&
      isRecord(event.item)
    ) {
      const itemId = readString(event.item, 'id');
      const itemType = readString(event.item, 'type');
      if (itemId && itemType) {
        observeProviderRunItem(state.run, itemId, itemType);
      }
    }
    attachProviderRunEvent(data, state.run, 'running');
    return data;
  }

  async startTurn(
    opts: StartTurnOptions,
    processRecoveryAttempt = 0,
  ): Promise<CodexTurnResult> {
    this.assertNotDisposed();
    assertCodexTurnSpeedAdmitted(
      startTurnModelConfig(opts),
      opts.ultrafastAdmitted === true,
    );
    this.approvalChecksCancelled = false;
    const turnStartGeneration = ++this.turnStartGeneration;
    this.detachOutsideNotificationAdmissions(turnStartGeneration);
    const turnStartAbortController = new AbortController();
    this.pendingTurnStartGeneration = turnStartGeneration;
    this.pendingTurnStartAbort = {
      generation: turnStartGeneration,
      controller: turnStartAbortController,
    };
    try {
      const pendingMcpReloadReadiness = this.pendingMcpReloadReadiness;
      if (pendingMcpReloadReadiness) {
        await waitForBestEffortPromiseOrAbort(
          pendingMcpReloadReadiness,
          turnStartAbortController.signal,
        );
      }
      this.assertTurnStartNotCancelled(turnStartGeneration);
      await this.waitForTurnSlot(
        turnStartGeneration,
        turnStartAbortController.signal,
      );
      await this.ensureThread(
        opts,
        turnStartGeneration,
        turnStartAbortController.signal,
      );
      this.assertTurnStartNotCancelled(turnStartGeneration);
      await this.waitForTurnSlot(
        turnStartGeneration,
        turnStartAbortController.signal,
      );
    } catch (error) {
      if (this.turnStartCancellation?.generation === turnStartGeneration) {
        throw this.turnStartCancellation.error;
      }
      if (
        isCodexRecoverableProcessExitError(error) &&
        processRecoveryAttempt + 1 < CODEX_PROCESS_RECOVERY_MAX_ATTEMPTS &&
        !this.disposed
      ) {
        await recoveryDelay(
          CODEX_PROCESS_RECOVERY_RETRY_DELAYS_MS[processRecoveryAttempt + 1] ??
            0,
        );
        this.assertTurnStartNotCancelled(turnStartGeneration);
        return this.startTurn(opts, processRecoveryAttempt + 1);
      }
      if (
        processRecoveryAttempt === 0 &&
        !this.disposed &&
        isUnansweredThreadSetupRequest(error) &&
        // Only a worker with no other live work is replaced. Stopping it also
        // ends the request that timed out, so a thread it was still creating
        // cannot appear later; the retry then starts on a fresh worker.
        this.connection.recycleUnresponsiveProcess()
      ) {
        this.assertTurnStartNotCancelled(turnStartGeneration);
        return this.startTurn(opts, processRecoveryAttempt + 1);
      }
      throw error;
    } finally {
      if (this.pendingTurnStartGeneration === turnStartGeneration) {
        this.pendingTurnStartGeneration = null;
      }
      if (this.dispatchedTurnStartGeneration === turnStartGeneration) {
        this.dispatchedTurnStartGeneration = null;
      }
      if (this.turnStartCancellation?.generation === turnStartGeneration) {
        this.turnStartCancellation = null;
      }
      if (this.pendingTurnStartAbort?.generation === turnStartGeneration) {
        this.pendingTurnStartAbort = null;
      }
    }
    this.assertNotDisposed();
    const threadId = this.threadId;
    if (!threadId) {
      throw new Error('Codex app-server did not initialize a thread');
    }

    let active: CodexTurnState | undefined;
    const result = new Promise<CodexTurnResult>((resolve, reject) => {
      active = {
        hostOwnsAdmission: opts.beforeAdmission !== undefined,
        rootThreadId: threadId,
        turnId: '',
        ...(opts.executionUserMessageId
          ? { executionUserMessageId: opts.executionUserMessageId }
          : {}),
        ...(opts.submissionId ? { submissionId: opts.submissionId } : {}),
        ...(opts.userMessageId
          ? { userMessageId: opts.userMessageId }
          : opts.clientUserMessageId &&
              opts.clientUserMessageId !== opts.submissionId
            ? { userMessageId: opts.clientUserMessageId }
            : {}),
        ...(opts.clientUserMessageId
          ? { clientUserMessageId: opts.clientUserMessageId }
          : {}),
        lifecycleOrigin: 'user',
        allowResumeMerge: true,
        resolve,
        reject,
        items: new Map(),
        itemRoutings: new Map(),
        completedItemIds: new Set(),
        commandOutputEmissions: new Map(),
        previousTurnId: this.lastKnownTurnId,
      };
    });
    if (!active) {
      throw new Error('Codex turn state was not initialized');
    }
    this.settledTurnItems = null;
    this.activeTurn = active;
    this.onSteeringEligibilityChanged?.();
    void result.catch(() => {}); // prevent floating rejection on async process failure

    const reasoningModel =
      opts.capabilityModel ?? opts.model ?? DEFAULT_CODEX_MODEL;
    const approvalMode = this.approvalMode;
    const shouldClearPlanCollaborationMode =
      !opts.planMode &&
      (this.hasActivatedPlanCollaborationMode ||
        this.hasUnknownPlanCollaborationMode);
    const collaborationMode: CollaborationMode | null | undefined =
      opts.planMode
        ? {
            mode: 'plan',
            settings: {
              model: opts.model ?? DEFAULT_CODEX_MODEL,
              reasoning_effort: mapThinkingToEffort(
                opts.thinkingLevel,
                reasoningModel,
                opts.aiCreditsRouted === true,
                opts.supportedThinkingLevels,
              ),
              developer_instructions: combineDeveloperInstructions(
                this.developerInstructions,
                opts.planMode,
                opts.proposalMode,
                this.planModeDeveloperInstructionsAddendum,
              ),
            },
          }
        : shouldClearPlanCollaborationMode
          ? {
              mode: 'default',
              settings: {
                model: opts.model ?? DEFAULT_CODEX_MODEL,
                reasoning_effort: mapThinkingToEffort(
                  opts.thinkingLevel,
                  reasoningModel,
                  opts.aiCreditsRouted === true,
                  opts.supportedThinkingLevels,
                ),
                // A null developer instruction can leave the previous
                // Plan-mode instruction visible after a thread is resumed by
                // a fresh client. Send an explicit Default-mode instruction
                // so the higher-priority plan restrictions are revoked even
                // across idle release, restart, and process recovery.
                developer_instructions: DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
              },
            }
          : undefined;

    try {
      const startParams: AppServerRequestParams<'turn/start'> = {
        threadId,
        input: [{ type: 'text', text: opts.text, text_elements: [] }],
        ...(opts.clientUserMessageId
          ? { clientUserMessageId: opts.clientUserMessageId }
          : {}),
        cwd: opts.cwd,
        approvalPolicy: codexApprovalPolicyFor(approvalMode),
        sandboxPolicy: codexSandboxPolicyFor(approvalMode, opts.cwd),
        // The exact (admitted) tier for this turn.
        serviceTier: codexServiceTierForModelConfig(startTurnModelConfig(opts)),
        ...(opts.model ? { model: opts.model } : {}),
        effort: mapThinkingToEffort(
          opts.thinkingLevel,
          reasoningModel,
          opts.aiCreditsRouted === true,
          opts.supportedThinkingLevels,
        ),
        ...(collaborationMode !== undefined ? { collaborationMode } : {}),
      };
      active.startParams = startParams;
      await opts.beforeAdmission?.();
      this.assertNotDisposed();
      const response = await this.request('turn/start', startParams);
      this.recordAppliedCollaborationMode(startParams);
      const nativeTurn = extractNativeTurn(response);
      const turnId = extractTurnId(response);
      if (this.disposed) {
        throw new Error('session_destroyed');
      }
      if (!turnId) {
        throw new Error('Codex app-server returned a turn without an id');
      }
      opts.onAdmission?.();
      if (this.activeTurn === active) {
        active.dispatchResponseObserved = true;
        this.acceptStartResponse(active, turnId, nativeTurn ?? undefined);
        this.onSteeringEligibilityChanged?.();
      }
      let restartRequest: ImmediateTurnRestartRequest | null = null;
      let turnResult: CodexTurnResult;
      try {
        turnResult = await result;
        restartRequest =
          this.immediateTurnRestartRequest?.turn === active
            ? this.immediateTurnRestartRequest
            : null;
      } finally {
        if (this.immediateTurnRestartRequest?.turn === active) {
          this.immediateTurnRestartRequest = null;
        }
      }
      if (
        turnResult.status === 'interrupted' &&
        restartRequest &&
        !active.userInterruptAcknowledged &&
        !this.disposed
      ) {
        const controller = new AbortController();
        this.pendingImmediateTurnRestartAbort = {
          request: restartRequest,
          controller,
        };
        try {
          await this.waitForSelectedMcpServersReady(
            threadId,
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) {
            return turnResult;
          }
          throw error;
        } finally {
          this.mcpStartupStates.delete(threadId);
          if (
            this.pendingImmediateTurnRestartAbort?.controller === controller
          ) {
            this.pendingImmediateTurnRestartAbort = null;
          }
        }
        this.assertNotDisposed();
        if (active.userInterruptAcknowledged) {
          return turnResult;
        }
        return this.startTurn(
          {
            ...opts,
            text: '<system_instruction>The requested MCP connection is refreshed. Continue the interrupted request without repeating completed work.</system_instruction>',
          },
          processRecoveryAttempt,
        );
      }
      if (turnResult.status === 'completed') {
        // Only a COMPLETED turn proves the upstream provider accepted the
        // replayed history. `interrupted` must not count: a user pressing Stop
        // right after send — or `reconcileUserInterruptDuringRecovery` forcing
        // that status after an app-server crash — can win before the provider
        // ever validated the reasoning items, and stamping the family then is
        // exactly the unverified-provenance write this staging prevents.
        await this.flushPendingReasoningRouteFamilyBackfill();
      }
      return turnResult;
    } catch (error) {
      if (
        isCodexRecoverableProcessExitError(error) &&
        !opts.beforeAdmission &&
        this.activeTurn === active &&
        !this.disposed
      ) {
        const recovery = this.recoverAfterUnexpectedProcessExit(error);
        void recovery.catch(() => {});
        return await result;
      }
      if (isCodexAppServerRequestTimeout(error) && !this.activeTurn?.turnId) {
        this.connection.triggerSharedRestart(new Error('turn_start_timeout'), {
          threadId,
          turnId: null,
        });
      }
      if (this.activeTurn === active) {
        this.activeTurn = null;
        this.onSteeringEligibilityChanged?.();
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Updates the approval mode applied to future `turn/start` params. A
   * Full Access turn has already captured `never` + danger-full-access, so a
   * de-escalation interrupts it before the safer mode is reported as applied.
   */
  async setApprovalMode(mode: ApprovalMode): Promise<void> {
    if (
      this.approvalMode === 'full-access' &&
      mode !== 'full-access' &&
      (this.activeTurn !== null || this.pendingTurnStartGeneration !== null)
    ) {
      await this.interruptTurn();
    }
    this.approvalMode = mode;
  }

  getThreadId(): string | undefined {
    return this.threadId;
  }

  /**
   * Codex's prediction of the person's next message after a completed turn
   * (the `prompt-suggestions` Labs experiment), from one `thread/sample` on
   * the turn's cached context at low effort. Null when Codex has none. Rejects
   * when Codex refuses the sample, as it does once a newer turn has started.
   */
  async samplePromptSuggestion(input: {
    threadId: string;
    turnId: string;
  }): Promise<string | null> {
    const response = await this.connection.request('thread/sample', {
      threadId: input.threadId,
      expectedTurnId: input.turnId,
      prompt: CODEX_PROMPT_SUGGESTION_PROMPT,
      effort: 'low',
    });
    // ThreadSampleResponse: `text` is null when Codex attempted a tool call
    // or replied with nothing.
    const text =
      (isRecord(response) ? readString(response, 'text') : undefined)?.trim() ??
      '';
    return text.length > 0 ? text : null;
  }

  getIngestionLag(): CodexIngestionLagSnapshot | undefined {
    return this.connection.ingestionLag();
  }

  handleIngestionLagChange(change: CodexIngestionLagChange): void {
    try {
      const report = this.onIngestionLagChange?.(change);
      if (report) void report.catch(() => undefined);
    } catch {
      // Diagnostics must never affect app-server notification admission.
    }
  }

  handleIngestionLagSample(sample: CodexIngestionLagSample): void {
    try {
      const report = this.onIngestionLagSample?.(sample);
      if (report) void report.catch(() => undefined);
    } catch {
      // Observational samples must never affect app-server notification admission.
    }
  }

  async reloadMcpServers(): Promise<void> {
    this.assertNotDisposed();
    const readiness = (async (): Promise<void> => {
      const threadIdBeforeReload = this.threadId;
      if (threadIdBeforeReload) {
        this.mcpStartupStates.delete(threadIdBeforeReload);
      }
      await this.request('config/mcpServer/reload', undefined);
      const threadId = this.threadId;
      if (threadId) {
        if (threadId !== threadIdBeforeReload) {
          this.mcpStartupStates.delete(threadId);
        }
        await this.waitForSelectedMcpServersReady(threadId);
      }
    })();
    this.pendingMcpReloadReadiness = readiness;
    try {
      await readiness;
    } finally {
      if (this.pendingMcpReloadReadiness === readiness) {
        this.pendingMcpReloadReadiness = null;
      }
    }
  }

  async steerActiveTurn(
    text: string,
    clientUserMessageId?: string,
  ): Promise<boolean> {
    const outcome = await this.steerActiveTurnOutcome(
      text,
      clientUserMessageId,
    );
    if (outcome.kind === 'failed') throw outcome.error;
    return outcome.kind === 'steered';
  }

  private async steerActiveTurnOutcome(
    text: string,
    clientUserMessageId?: string,
    softTimeout?: { onLateResponse: (outcome: CodexLateSteerResponse) => void },
    target?: SteeringTarget,
    shadowBinding?: { submissionId?: string; userMessageId?: string },
  ): Promise<
    | { kind: 'steered' }
    | { kind: 'refused'; refusal: ChatInputRefusal }
    | { kind: 'pending' }
    | { kind: 'failed'; error: unknown; failure: ChatInputDeliveryFailure }
  > {
    const threadId = this.threadId;
    const turnId = this.activeTurn?.controlPhase
      ? undefined
      : this.activeTurn?.turnId;
    if (
      target &&
      (this.disposed ||
        !threadId ||
        !turnId ||
        target.sessionId !== threadId ||
        target.turnId !== turnId)
    )
      return {
        kind: 'refused',
        refusal: chatInputRefusal('no-active-turn'),
      };
    this.assertNotDisposed();
    if (!threadId || !turnId)
      return { kind: 'refused', refusal: chatInputRefusal('not-steerable') };
    if (clientUserMessageId && this.steeringInputs.size >= 1024) {
      for (const [id, input] of Array.from(this.steeringInputs)) {
        if (input.pickedUp) {
          this.steeringInputs.delete(id);
          if (this.steeringInputs.size < 1024) break;
        }
      }
      // Retain unresolved correlations. A rejected admission can stay in the
      // host queue without risking a second delivery of an uncertain input.
      if (this.steeringInputs.size >= 1024)
        return {
          kind: 'refused',
          refusal: chatInputRefusal('delivery-backlog'),
        };
    }
    if (clientUserMessageId)
      this.steeringInputs.set(clientUserMessageId, {
        threadId,
        turnId,
        pickedUp: false,
        ...(shadowBinding?.submissionId
          ? { submissionId: shadowBinding.submissionId }
          : {}),
        ...(shadowBinding?.userMessageId
          ? { userMessageId: shadowBinding.userMessageId }
          : {}),
        ...(softTimeout ? { onLateResponse: softTimeout.onLateResponse } : {}),
      });
    let expectedTurnId = turnId;
    if (__CANOPY_E2E__) {
      const staleTurnId = process.env.CANOPY_E2E_CODEX_STALE_STEER_TURN_ID;
      if (staleTurnId) expectedTurnId = staleTurnId;
    }
    try {
      await this.request(
        'turn/steer',
        {
          threadId,
          expectedTurnId,
          ...(clientUserMessageId ? { clientUserMessageId } : {}),
          input: [{ type: 'text', text, text_elements: [] }],
        },
        softTimeout && clientUserMessageId ? { softTimeout } : undefined,
      );
    } catch (error) {
      // Internal (uncorrelated) steers keep propagating every error.
      if (!clientUserMessageId) throw error;
      if (
        softTimeout &&
        error instanceof Error &&
        error.name === 'CodexAppServerRequestTimeoutError'
      ) {
        const attempt = this.steeringInputs.get(clientUserMessageId);
        if (attempt) {
          attempt.softTimedOut = true;
          if (attempt.pickedUp) {
            delete attempt.onLateResponse;
            softTimeout.onLateResponse({ kind: 'success', value: undefined });
          }
        }
        return { kind: 'pending' };
      }
      // A proven refusal means no input was submitted, so the ordinary send
      // queue can safely retry after the turn settles. Anything else may have
      // been accepted and keeps its correlation for a late pickup.
      const classified = classifyCodexSteerError(error);
      const attempt = this.steeringInputs.get(clientUserMessageId);
      if (attempt) delete attempt.onLateResponse;
      if (classified.kind === 'failure')
        return { kind: 'failed', error, failure: classified.failure };
      this.steeringInputs.delete(clientUserMessageId);
      return { kind: 'refused', refusal: classified.refusal };
    }
    // An acknowledged user message was accepted even if completion raced its
    // response. Refusing here would deliver it again via turn/start.
    // User input must not arm the internal MCP-refresh restart capability.
    if (clientUserMessageId) {
      const attempt = this.steeringInputs.get(clientUserMessageId);
      if (attempt) delete attempt.onLateResponse;
      return { kind: 'steered' };
    }
    if (this.activeTurn?.turnId !== turnId)
      return { kind: 'refused', refusal: chatInputRefusal('not-steerable') };
    this.immediateTurnRestartArmedTurnId = turnId;
    return { kind: 'steered' };
  }

  getSteeringCapabilities(): ChatSteeringCapabilities {
    return {
      provider: 'codex',
      generation: this.inputGeneration,
      steer:
        !this.disposed &&
        !this.activeTurn?.controlPhase &&
        Boolean(this.activeTurn?.turnId),
      withdraw: false,
      interrupt: !this.disposed,
    };
  }

  getSteeringTarget(): SteeringTarget | undefined {
    const threadId = this.threadId;
    const turnId = this.activeTurn?.controlPhase
      ? undefined
      : this.activeTurn?.turnId;
    if (this.disposed || !threadId || !turnId) return undefined;
    return { sessionId: threadId, turnId };
  }

  async submitSteeringInput(
    text: string,
    attemptId: string,
    target?: SteeringTarget,
    userMessageId?: string,
  ): Promise<ChatInputSubmitResult> {
    // No event: the identity belongs to an attempt that is still in flight.
    if (this.steeringInputs.has(attemptId))
      return {
        kind: 'unknown',
        attemptId,
        reason: 'This submission identity was already used',
        failure: chatInputDeliveryFailure('duplicate-attempt'),
      };
    const providerTurnId = this.activeTurn?.turnId;
    let settleSettlement: (admission: ChatInputAdmission) => void = () => {};
    let settlementIsResolved = false;
    const settlement = new Promise<ChatInputAdmission>((resolve) => {
      settleSettlement = resolve;
    });
    const settleOnce = (admission: ChatInputAdmission): void => {
      if (settlementIsResolved) return;
      settlementIsResolved = true;
      settleSettlement(admission);
    };
    const acceptedAdmission = (): ChatInputAdmission => {
      void this.onEvent({
        type: 'canopy_input_delivery',
        provider: 'codex',
        generation: this.inputGeneration,
        attemptId,
        phase: 'accepted',
        providerTurnId,
      });
      return { kind: 'accepted', attemptId, providerTurnId };
    };
    const unknownAdmission = (
      failure: ChatInputDeliveryFailure,
    ): ChatInputAdmission => {
      void this.onEvent({
        type: 'canopy_input_delivery',
        provider: 'codex',
        generation: this.inputGeneration,
        attemptId,
        phase: 'unknown',
        providerTurnId,
        failure,
      });
      return {
        kind: 'unknown',
        attemptId,
        reason:
          'Delivery was not confirmed. This message will not be resent automatically.',
        failure,
      };
    };
    const onLateResponse = (response: CodexLateSteerResponse): void => {
      if (settlementIsResolved) return;
      const attempt = this.steeringInputs.get(attemptId);
      if (attempt) delete attempt.onLateResponse;
      if (response.kind === 'success') {
        settleOnce(acceptedAdmission());
        return;
      }
      const classified = classifyCodexSteerError(response.error);
      if (classified.kind === 'refusal') {
        this.steeringInputs.delete(attemptId);
        settleOnce({
          kind: 'rejected',
          attemptId,
          reason: 'The active turn no longer accepts steering',
          fallback: 'ordinary',
          refusal: classified.refusal,
        });
        return;
      }
      settleOnce(unknownAdmission(classified.failure));
    };
    try {
      const outcome = await this.steerActiveTurnOutcome(
        text,
        attemptId,
        { onLateResponse },
        target,
        {
          submissionId: attemptId,
          ...(userMessageId ? { userMessageId } : {}),
        },
      );
      if (outcome.kind === 'refused')
        return {
          kind: 'rejected',
          attemptId,
          reason: 'The active turn no longer accepts steering',
          fallback: 'ordinary',
          refusal: outcome.refusal,
        };
      if (outcome.kind === 'pending')
        return { kind: 'pending', attemptId, settlement };
      if (outcome.kind === 'steered') {
        return acceptedAdmission();
      }
      return unknownAdmission(outcome.failure);
    } catch {
      return unknownAdmission(chatInputDeliveryFailure('transport-error'));
    }
  }

  async interruptTurn(
    options: {
      approvalSessionAlreadyInvalidated?: boolean;
      userInitiated?: boolean;
    } = {},
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.abortDynamicToolCalls();
    const pendingRestart = this.pendingImmediateTurnRestartAbort;
    if (options.userInitiated !== false && pendingRestart) {
      pendingRestart.request.turn.userInterruptAcknowledged = true;
      pendingRestart.controller.abort(new Error('turn_cancelled'));
      return;
    }
    // Close both approval entry points before interrupting the provider. The
    // local gate rejects requests routed after cancellation starts, while the
    // session invalidation rejects prompts/checks already queued behind the
    // decision that requested "Deny and stop".
    this.approvalChecksCancelled = true;
    if (!options.approvalSessionAlreadyInvalidated) {
      this.approvalSession?.invalidatePending?.();
    }
    this.rendererQuestionCancellationGeneration++;
    rejectAllForSession(this.sessionKey);
    if (!this.activeTurn && this.pendingTurnStartGeneration === null) {
      return;
    }
    const active = this.activeTurn;
    if (
      options.userInitiated !== false &&
      active &&
      this.activeTurn === active
    ) {
      // Record cancellation intent before awaiting the transport response. If
      // the response is lost with the worker, recovery must not continue a
      // persisted interrupted turn after the user has already pressed Stop.
      active.userInterruptAcknowledged = true;
    }
    const target = this.getActiveTurnInterruptTarget();
    if (!target || !target.turnId) {
      this.connection.triggerSharedRestart(new Error('turn_cancelled'));
      return;
    }
    await this.connection.interruptTurn({
      threadId: target.threadId,
      turnId: target.turnId,
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.retireBackgroundWorkEpoch();
    this.backgroundWorkUnsubscribe();
    this.retireProviderRunGeneration(false, true);
    this.onSteeringEligibilityChanged?.();
    const isLastClient = this.connection.isOnlyOwner();
    // Preserve the existing best-effort disposal failure before cancelling
    // execution; a provider-resolved call is already absent from this set.
    this.connection.flushPendingServerRequests(!isLastClient);
    this.abortDynamicToolCalls();
    this.closeStoppedDynamicToolRows();
    this.closing = true;
    this.pendingNativeDynamicResults.clear();
    this.pendingDeferredToolResultIds.clear();
    this.pendingImmediateTurnRestartResultIds.clear();
    this.immediateTurnRestartArmedTurnId = undefined;
    this.immediateTurnRestartRequest = null;
    this.pendingImmediateTurnRestartAbort?.controller.abort(
      new Error('session_destroyed'),
    );
    this.pendingImmediateTurnRestartAbort = null;
    const target = this.getActiveTurnInterruptTarget();
    if (
      this.connection.isInitialized() &&
      this.threadReady &&
      this.threadId &&
      !target
    ) {
      this.connection.rememberIdleThread(this.threadId);
    }
    if (
      !isLastClient &&
      this.connection.isInitialized() &&
      this.threadReady &&
      this.threadId &&
      !target
    ) {
      this.connection.unsubscribeThreadBestEffort(this.threadId);
    }
    if (!isLastClient && this.connection.isInitialized() && target) {
      if (target.turnId) {
        this.connection.disposeOwnerActiveTurn({
          threadId: target.threadId,
          turnId: target.turnId,
        });
      } else {
        this.connection.triggerSharedRestart(new Error('session_destroyed'));
      }
    }

    const turn = this.activeTurn;
    if (turn) this.settleProviderRunForTurn(turn);
    this.activeTurn = null;
    this.onSteeringEligibilityChanged?.();
    this.settledTurnItems = null;
    this.rejectPendingTerminalSettlements(new Error('session_destroyed'));
    this.detachOutsideNotificationAdmissions();
    if (turn) {
      turn.reject(new Error('session_destroyed'));
    }
    this.connection.rejectPendingRequests(new Error('session_destroyed'));
    if (isLastClient) {
      this.connection.rejectAllPendingRequests(new Error('session_destroyed'));
    }
    for (const unsubscribe of Array.from(this.listenerUnsubscribes)) {
      unsubscribe();
    }
    this.listenerUnsubscribes.clear();
    this.connection.release();
  }

  suspendIdleProcess(): boolean {
    if (this.closing) {
      return false;
    }
    return this.connection.suspendIdleProcessIfIdle();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('session_destroyed');
    }
  }

  private assertTurnStartNotCancelled(generation: number): void {
    if (this.turnStartCancellation?.generation === generation) {
      throw this.turnStartCancellation.error;
    }
  }

  private async waitForTurnSlot(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (this.activeTurn?.providerOwned) {
      const adoptedTurn = this.activeTurn;
      const completion = adoptedTurn.providerOwnedCompletion;
      if (!completion) {
        throw new Error('Codex provider-owned turn cannot be safely replaced');
      }
      await waitForBestEffortPromiseOrAbort(completion, signal);
      this.assertNotDisposed();
      this.assertTurnStartNotCancelled(generation);
    }
    if (this.activeTurn) {
      throw new Error('Codex app-server already owns an active turn');
    }
  }

  private recordAppliedCollaborationMode(
    startParams: AppServerRequestParams<'turn/start'>,
  ): void {
    if (startParams.collaborationMode?.mode === 'plan') {
      this.hasActivatedPlanCollaborationMode = true;
      this.hasUnknownPlanCollaborationMode = false;
    } else if (startParams.collaborationMode?.mode === 'default') {
      this.hasActivatedPlanCollaborationMode = false;
      this.hasUnknownPlanCollaborationMode = false;
    }
  }

  onAccountUpdated(
    listener: (notification: AccountUpdatedNotification) => void,
  ): () => void {
    this.accountUpdatedListeners.add(listener);
    const unsubscribeConnection = this.connection.onAccountUpdated(listener);
    this.listenerUnsubscribes.add(unsubscribeConnection);
    return (): void => {
      this.accountUpdatedListeners.delete(listener);
      unsubscribeConnection();
      this.listenerUnsubscribes.delete(unsubscribeConnection);
    };
  }

  onRateLimitsUpdated(
    listener: (notification: AccountRateLimitsUpdatedNotification) => void,
  ): () => void {
    this.rateLimitsUpdatedListeners.add(listener);
    const unsubscribeConnection = this.connection.onRateLimitsUpdated(listener);
    this.listenerUnsubscribes.add(unsubscribeConnection);
    return (): void => {
      this.rateLimitsUpdatedListeners.delete(listener);
      unsubscribeConnection();
      this.listenerUnsubscribes.delete(unsubscribeConnection);
    };
  }

  async readAccount(refreshToken: boolean): Promise<GetAccountResponse> {
    const response = await this.request('account/read', { refreshToken });
    const parsed = parseGetAccountResponsePayload(response);
    if (!parsed) {
      throw new Error('Codex app-server returned an invalid account payload');
    }
    return parsed;
  }

  async readRateLimits(): Promise<GetAccountRateLimitsResponse> {
    const response = await this.request('account/rateLimits/read', undefined);
    const parsed = parseGetAccountRateLimitsPayload(response);
    if (!parsed) {
      throw new Error(
        'Codex app-server returned an invalid rate limits payload',
      );
    }
    return parsed;
  }

  async listSkills(cwd: string): Promise<SlashCommandData[]> {
    await this.connection.ensureInitialized();

    const response = await this.request('skills/list', {
      cwds: [cwd],
      forceReload: true,
    });
    const parsed = parseSkillsListPayload(response);
    if (!parsed) {
      throw new Error('Codex app-server returned an invalid skills payload');
    }
    return parsed;
  }

  /**
   * Fork an existing Codex thread on disk into a brand-new thread with the
   * same prior context. Returns the new thread id. The source thread is
   * loaded by id by the app-server, so this client does not need to be the
   * one currently driving the source thread — any initialized client can
   * fork by id.
   */
  async forkThread(sourceThreadId: string): Promise<string> {
    await this.connection.ensureInitialized();
    const threadConfig = buildThreadConfig({
      threadConfig: this.threadConfig,
      multiAgentEnabled: this.multiAgentEnabled,
      maxConcurrentSubagents: this.maxConcurrentSubagents,
    });
    const response = await this.request('thread/fork', {
      threadId: sourceThreadId,
      cwd: this.cwd,
      approvalPolicy: codexApprovalPolicyFor(this.approvalMode),
      sandbox: codexSandboxModeFor(this.approvalMode),
      // Metadata-only lifecycle request: never persists unadmitted Ultra fast.
      serviceTier: codexLifecycleServiceTier(this.getModelConfig?.()),
      ...(threadConfig ? { config: threadConfig } : {}),
      ...(this.developerInstructions
        ? { developerInstructions: this.developerInstructions }
        : {}),
    });
    const newThreadId = extractThreadId(response);
    if (!newThreadId) {
      throw new Error(
        'Codex app-server returned a forked thread without an id',
      );
    }
    return newThreadId;
  }

  private async ensureThread(
    opts: StartTurnOptions,
    turnStartGeneration: number,
    turnStartSignal: AbortSignal,
  ): Promise<void> {
    await this.connection.ensureInitialized({ signal: turnStartSignal });
    this.assertNotDisposed();
    this.assertTurnStartNotCancelled(turnStartGeneration);
    if (this.threadReady) return;
    const setupGeneration = this.threadSetupGeneration;

    const startThreadConfig = buildThreadConfig(
      {
        threadConfig: this.threadConfig,
        mcpServersConfig: this.mcpServersConfig,
        multiAgentEnabled: this.multiAgentEnabled,
        maxConcurrentSubagents: this.maxConcurrentSubagents,
      },
      {
        includeSelectedMcpServers: true,
        resetMcpServers: true,
      },
    );
    const resumeThreadConfig = buildThreadConfig(
      {
        threadConfig: this.threadConfig,
        mcpServersConfig: this.mcpServersConfig,
        multiAgentEnabled: this.multiAgentEnabled,
        maxConcurrentSubagents: this.maxConcurrentSubagents,
      },
      { includeSelectedMcpServers: true },
    );
    const providerRouteIdentity =
      codexThreadProviderRouteIdentity(startThreadConfig);
    const resumeThreadId = this.threadId ?? this.initialThreadId;
    let establishedProviderRoute = false;
    const dynamicToolsField =
      this.dynamicTools && this.dynamicTools.length > 0
        ? { dynamicTools: this.dynamicTools }
        : {};
    const selectedCapabilityRootsField =
      this.selectedCapabilityRoots && this.selectedCapabilityRoots.length > 0
        ? { selectedCapabilityRoots: this.selectedCapabilityRoots }
        : {};
    const approvalMode = this.approvalMode;
    const startParams: ThreadStartParams = {
      cwd: opts.cwd,
      approvalPolicy: codexApprovalPolicyFor(approvalMode),
      sandbox: codexSandboxModeFor(approvalMode),
      // Thread start/resume/materialization is lifecycle metadata: Regular and
      // Fast keep their exact tier, Ultra fast sends an explicit `default`
      // (clearing any inherited tier) and each admitted `turn/start` carries
      // the exact tier.
      serviceTier: codexLifecycleServiceTier(startTurnModelConfig(opts)),
      ...(opts.model ? { model: opts.model } : {}),
      ...(startThreadConfig ? { config: startThreadConfig } : {}),
      ...(this.developerInstructions
        ? { developerInstructions: this.developerInstructions }
        : {}),
      ...dynamicToolsField,
      ...selectedCapabilityRootsField,
      experimentalRawEvents: false,
    };
    // NOTE (Backend plan B3.2): experimental regeneration confirmed
    // `ThreadStartParams.dynamicTools` exists, but `ThreadResumeParams` still
    // does not declare `dynamicTools`. Do not forward dynamic tools on resume
    // until the generated type adds the field or a live resume verification
    // confirms the bundled app-server accepts it and emits `item/tool/call`
    // requests for the injected Canopy tool names.
    let response: unknown;
    let resumedResponse = false;
    // Hoisted out of the resume branch so the latch can be consumed at the
    // commit site below, once `this.threadId` actually points at the rebuilt
    // thread.
    let consumedForcedRebuild = false;
    if (resumeThreadId) {
      const existingCapabilityLease = this.capabilityStore
        ? await this.capabilityStore.readLease(resumeThreadId)
        : null;
      const hasThreadScopedCapabilities =
        (this.selectedCapabilityRoots?.length ?? 0) > 0 ||
        Object.keys(this.mcpServersConfig ?? {}).length > 0;
      // Another spawn profile's worker released this idle thread recently and
      // may still hold its writer. A plain resume comes first: the pool stops
      // that worker when it is idle, which keeps the same thread. Only if the
      // writer stays held is the thread rebuilt from history below.
      const releasedByAnotherProfile =
        this.connection.requiresThreadMaterialization(resumeThreadId);
      const loadedProviderRoute =
        this.connection.loadedThreadProviderRoute(resumeThreadId);
      const providerRouteChanged =
        loadedProviderRoute !== undefined &&
        loadedProviderRoute !== providerRouteIdentity;
      const capabilityChanged =
        providerRouteChanged ||
        this.forceMaterializeOnResume ||
        (!existingCapabilityLease && hasThreadScopedCapabilities) ||
        (existingCapabilityLease?.reasoningRouteFamily !== undefined &&
          existingCapabilityLease.reasoningRouteFamily !==
            this.reasoningRouteFamily) ||
        Boolean(
          existingCapabilityLease &&
          existingCapabilityLease.snapshotId !== this.capabilitySnapshotId,
        );
      this.assertNotDisposed();
      this.connection.registerRootThread(resumeThreadId);
      try {
        if (capabilityChanged) {
          const forcedRebuild = this.forceMaterializeOnResume;
          response = await this.materializeThreadFromHistory(
            resumeThreadId,
            startParams,
            turnStartGeneration,
            forcedRebuild
              ? undefined
              : existingCapabilityLease?.reasoningRouteFamily,
            // Only trim the pending input on the retry rebuild. That path runs
            // *after* a turn already failed, so the rollout genuinely contains
            // that input and re-sending it would duplicate the prompt. Every
            // other reconstruction here is proactive — it happens before
            // `turn/start`, nothing has been persisted yet, and trimming would
            // delete a real trailing message the user still has.
            forcedRebuild ? opts.text : undefined,
          );
          establishedProviderRoute = true;
          consumedForcedRebuild = forcedRebuild;
        } else {
          try {
            response = await this.request('thread/resume', {
              threadId: resumeThreadId,
              cwd: opts.cwd,
              approvalPolicy: codexApprovalPolicyFor(approvalMode),
              sandbox: codexSandboxModeFor(approvalMode),
              serviceTier: startParams.serviceTier,
              ...(opts.model ? { model: opts.model } : {}),
              ...(resumeThreadConfig ? { config: resumeThreadConfig } : {}),
              ...(this.developerInstructions
                ? { developerInstructions: this.developerInstructions }
                : {}),
            });
            resumedResponse = true;
          } catch (error) {
            if (
              !isUnavailablePersistedThreadError(error) &&
              !(
                releasedByAnotherProfile &&
                isCodexThreadWriterConflictError(error)
              )
            ) {
              throw error;
            }
            // A canonical rollout may be stale, imported, or no longer
            // resumable even though its model-visible response items remain
            // available. Reconstruct a new canonical thread instead of
            // dropping the conversation or recreating a synthetic home.
            // Unavailable-persisted-thread fallback: this also runs before
            // `turn/start`, so no pending input has been persisted and there
            // is nothing to trim. The same rebuild covers a writer that
            // another profile's busy worker still holds.
            response = await this.materializeThreadFromHistory(
              resumeThreadId,
              startParams,
              turnStartGeneration,
              existingCapabilityLease?.reasoningRouteFamily,
            );
            establishedProviderRoute = true;
          }
        }
        this.assertNotDisposed();
        this.assertTurnStartNotCancelled(turnStartGeneration);
        if (
          this.capabilityStore &&
          (!existingCapabilityLease ||
            existingCapabilityLease.reasoningRouteFamily === undefined) &&
          extractThreadId(response) === resumeThreadId
        ) {
          const rootContentIds = this.selectedCapabilityRootContentIds();
          const now = new Date().toISOString();
          // Stage, do not write. Resume succeeding says nothing about which
          // provider produced the persisted reasoning; only a turn that
          // replays that history without being rejected does. Flushed by
          // `flushPendingReasoningRouteFamilyBackfill` after the turn
          // completes, so an unverified family can never downgrade the
          // conservative "unknown provenance ⇒ sanitize" default.
          this.pendingReasoningRouteFamilyBackfill = {
            ...(existingCapabilityLease ?? {
              version: 1,
              threadId: resumeThreadId,
              snapshotId: this.capabilitySnapshotId,
              rootContentIds,
              kind: 'persisted-chat',
              createdAt: now,
            }),
            reasoningRouteFamily: this.reasoningRouteFamily,
            updatedAt: now,
          };
        }
      } catch (error) {
        const failedThreadId = extractThreadId(response);
        if (failedThreadId) {
          this.connection.unregisterThread(failedThreadId);
        }
        this.connection.unregisterThread(resumeThreadId);
        throw error instanceof Error ? error : new Error(String(error));
      }
    } else {
      try {
        response = await this.startThreadWithCapabilityLease(
          startParams,
          turnStartGeneration,
        );
        establishedProviderRoute = true;
        if (this.seedNewThreadFromFallback) {
          // Retained reconstruction seeds come from imported Codex/Ollama
          // rollouts and carry no source-route provenance, so they can hold
          // provider-private reasoning from a different family. Sanitize with
          // an unknown source family (the conservative "drop" default) before
          // injecting; otherwise opening an imported chat under another route
          // sends foreign reasoning upstream on the very first turn, where the
          // only recovery left is the error-message heuristic.
          const fallbackItems = sanitizeSeedItemsForRouteChange(
            await this.loadFallbackSeedItems(),
            { targetRouteFamily: this.reasoningRouteFamily },
          );
          if (fallbackItems.length > 0) {
            await this.injectStartedThreadHistory(response, fallbackItems);
          }
        }
        this.assertNotDisposed();
        this.assertTurnStartNotCancelled(turnStartGeneration);
      } catch (error) {
        const failedThreadId = extractThreadId(response);
        if (failedThreadId) {
          this.connection.unregisterThread(failedThreadId);
        }
        throw error;
      }
    }

    const threadId = extractThreadId(response);
    if (!threadId) {
      throw new Error('Codex app-server returned a thread without an id');
    }
    this.lastKnownTurnId = latestThreadTurnId(response);
    this.connection.registerRootThread(threadId);

    try {
      await this.waitForSelectedMcpServersReady(threadId, turnStartSignal);
      this.assertNotDisposed();
      this.assertTurnStartNotCancelled(turnStartGeneration);
      if (setupGeneration !== this.threadSetupGeneration) {
        throw new Error('Codex thread closed or worker changed during setup');
      }
      // A definitive close can arrive while lease/MCP readiness is pending,
      // including before the returned thread has an owner. The connection
      // observes that close even when it cannot route a client notification.
      if (establishedProviderRoute) {
        this.connection.recordLoadedThreadProviderRoute(
          threadId,
          providerRouteIdentity,
        );
        if (
          this.connection.loadedThreadProviderRoute(threadId) !==
          providerRouteIdentity
        ) {
          throw new Error('Codex thread closed during setup');
        }
      }
    } catch (error) {
      this.connection.unregisterThread(threadId);
      throw error;
    } finally {
      this.mcpStartupStates.delete(threadId);
    }
    if (this.threadId && this.threadId !== threadId) {
      this.retireProviderRunGeneration(true);
    }
    if (resumedResponse && threadId === resumeThreadId) {
      this.resumedLiveRootAnchors.clear();
      this.completedResumeTurnKeys.clear();
      for (const resumedTurn of extractThreadTurns(response)) {
        const turnId = readString(resumedTurn, 'id');
        const status = readString(resumedTurn, 'status');
        if (!turnId) continue;
        const key = this.providerRunKey(threadId, turnId);
        if (status === 'inProgress') {
          const nativeExecutionUserMessageId =
            nativeTurnExecutionUserMessageId(resumedTurn);
          const retainedExecutionUserMessageId = getRetainedRootExecutionAnchor(
            this.retainedRootExecutionAnchorKey(threadId, turnId),
          );
          this.resumedLiveRootAnchors.set(
            key,
            nativeExecutionUserMessageId ?? retainedExecutionUserMessageId,
          );
        } else if (
          status === 'completed' ||
          status === 'failed' ||
          status === 'interrupted'
        ) {
          forgetRetainedRootExecutionAnchor(
            this.retainedRootExecutionAnchorKey(threadId, turnId),
          );
          this.completedResumeTurnKeys.add(key);
        }
      }
    }
    this.threadId = threadId;
    this.threadReady = true;
    this.connection.markThreadReady(threadId);
    if (resumedResponse && threadId === resumeThreadId) {
      this.observeResumedBackgroundTerminalItems(threadId, response);
      this.reconcileResumedBackgroundWork(threadId);
    }
    // Consume the latch only once the rebuilt thread is committed. `ensureThread`
    // re-runs on this same client whenever the shared process is suspended or
    // restarted (`markProcessSuspended`/`markProcessFailed` clear
    // `threadReady`), and a committed rebuild already wrote a lease with the
    // matching family that resumes cleanly, so leaving it latched would force a
    // second needless rebuild — and would pass the *new* turn's text as pending
    // input on a path where nothing was persisted. But every earlier exit from
    // this method (cancellation or disposal while MCP startup is pending) leaves
    // `this.threadId` on the original poisoned thread, whose lease family still
    // matches the session's. Clearing the latch anywhere above this line left
    // that thread with no self-heal at all: the next send would plain-resume it,
    // hit the same rejection, and find the session-level retry already spent.
    if (consumedForcedRebuild) {
      this.forceMaterializeOnResume = false;
    }
    void this.onEvent({
      type: 'system',
      subtype: 'init',
      session_id: threadId,
    });
  }

  private async waitForSelectedMcpServersReady(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await waitForCodexMcpServers({
      threadId,
      serverNames: enabledCodexMcpServerNames({
        mcp_servers: this.mcpServersConfig ?? {},
      }),
      request: (params) => this.request('mcpServerStatus/list', params),
      getStartupState: (serverName) =>
        this.mcpStartupStates.get(threadId)?.get(serverName),
      signal,
    });
    if (this.onMcpToolEvidence) {
      const evidence = await readCodexMcpToolEvidence({
        threadId,
        serverNames: result.readyServerNames,
        request: (params) => this.request('mcpServerStatus/list', params),
        signal,
      });
      this.assertNotDisposed();
      this.onMcpToolEvidence([
        ...evidence,
        ...result.unavailableServers.map((server): CodexMcpToolEvidence => {
          const startup = this.mcpStartupStates.get(threadId)?.get(server.name);
          if (
            server.reason === 'failed' &&
            startup?.failureReason === 'reauthenticationRequired'
          )
            return { name: server.name, kind: 'auth_required' };
          return {
            name: server.name,
            kind: 'unavailable',
            reason: server.reason === 'timeout' ? 'timeout' : 'startup_failed',
          };
        }),
      ]);
    }
  }

  private async materializeThreadFromHistory(
    sourceThreadId: string,
    params: ThreadStartParams,
    turnStartGeneration: number,
    sourceRouteFamily?: string,
    pendingUserInputText?: string,
  ): Promise<unknown> {
    const codexHome = getObservedCanonicalCodexHome();
    const fallbackItems = await this.loadFallbackSeedItems();
    const {
      items: loadedItems,
      loadedItemCount,
      source: seedSource,
    }: CodexThreadSeedLoad = codexHome
      ? await loadCodexThreadSeedItemsWithLoadCount({
          codexHome,
          threadId: sourceThreadId,
          fallbackItems,
          targetRouteFamily: this.reasoningRouteFamily,
          sourceRouteFamily,
        })
      : {
          items: sanitizeSeedItemsForRouteChange(fallbackItems, {
            targetRouteFamily: this.reasoningRouteFamily,
            sourceRouteFamily,
          }),
          source: 'fallback',
          loadedItemCount: fallbackItems.length,
        };
    // The canonical rollout retains every response item, including the user
    // input of the turn that just failed. The caller re-sends that same input
    // after this rebuild, so trim the persisted copy to keep the model from
    // seeing the prompt twice.
    //
    // Rollout-sourced items ONLY. The renderer fallback is loaded with
    // `excludeMessageId`, so the pending message is already absent from it and
    // its trailing item is a genuine earlier message — trimming there deletes
    // real history whenever the user repeated themselves, which the usage-limit
    // resume prompt (`Continue`) makes routine.
    const seedItems =
      seedSource === 'rollout'
        ? dropTrailingUserInput(loadedItems, pendingUserInputText)
        : loadedItems;
    // Only "nothing was ever loaded" is fatal, and that is measured on the
    // count *before* route sanitization. Narrowing a previously non-empty
    // history down to nothing is not fatal: it happens when the whole usable
    // tail was provider-private reasoning, or (on the self-heal retry) the
    // failed turn's own input, which the caller is about to re-send. Throwing
    // there hard-fails the user's turn with an internal message on the one
    // path whose retry latch is already spent, so start the replacement thread
    // with no injection instead — the live turn still carries the prompt.
    if (loadedItemCount === 0) {
      throw new Error(
        `Cannot reconstruct Codex thread ${sourceThreadId}: no persisted history was found`,
      );
    }

    const response = await this.startThreadWithCapabilityLease(
      params,
      turnStartGeneration,
    );
    if (seedItems.length > 0) {
      await this.injectStartedThreadHistory(response, seedItems);
    }
    this.connection.unregisterThread(sourceThreadId);
    return response;
  }

  /**
   * Persist a staged route-family backfill once a turn has proven the resumed
   * history is compatible with the current route. A write failure is not fatal:
   * the lease simply keeps its unknown provenance, which fails closed by
   * sanitizing again on the next reconstruction.
   */
  private async flushPendingReasoningRouteFamilyBackfill(): Promise<void> {
    const pending = this.pendingReasoningRouteFamilyBackfill;
    if (!pending || !this.capabilityStore) return;
    this.pendingReasoningRouteFamilyBackfill = null;
    try {
      await this.capabilityStore.writeLease(pending);
    } catch {
      // Intentionally ignored — see doc comment.
    }
  }

  private async loadFallbackSeedItems(): Promise<readonly JsonValue[]> {
    if (this.fallbackSeedItems.length > 0) return this.fallbackSeedItems;
    if (!this.fallbackSeedItemsLoader) return [];
    this.fallbackSeedItemsPromise ??= this.fallbackSeedItemsLoader();
    return this.fallbackSeedItemsPromise;
  }

  private async injectStartedThreadHistory(
    response: unknown,
    seedItems: readonly JsonValue[],
  ): Promise<void> {
    const provisionalThreadId = extractThreadId(response);
    if (!provisionalThreadId) {
      throw new Error('Codex app-server returned a thread without an id');
    }
    this.connection.registerRootThread(provisionalThreadId);
    try {
      await this.request('thread/inject_items', {
        threadId: provisionalThreadId,
        items: [...seedItems],
      });
    } catch (error) {
      this.connection.unregisterThread(provisionalThreadId);
      await this.connection
        .request(
          'thread/delete',
          { threadId: provisionalThreadId },
          { timeoutMs: 10_000 },
        )
        .catch(() => {});
      await this.capabilityStore
        ?.releaseLease(provisionalThreadId)
        .catch(() => {});
      throw error;
    }
  }

  private async startThreadWithCapabilityLease(
    params: ThreadStartParams,
    turnStartGeneration: number,
  ): Promise<unknown> {
    if (!this.capabilityStore) {
      return this.request('thread/start', params);
    }
    const rootContentIds = this.selectedCapabilityRootContentIds(
      params.selectedCapabilityRoots,
    );
    const pin =
      rootContentIds.length > 0
        ? await this.capabilityStore.acquireOperationPin(rootContentIds)
        : null;
    const refreshTimer = pin
      ? setInterval(() => {
          void this.capabilityStore
            ?.refreshOperationPin(pin.pinId)
            .catch(() => {});
        }, 20_000)
      : null;
    refreshTimer?.unref?.();
    let provisionalThreadId: string | undefined;
    let leasePersisted = false;
    try {
      const response = await this.request('thread/start', params);
      provisionalThreadId = extractThreadId(response) ?? undefined;
      if (!provisionalThreadId) {
        throw new Error('Codex app-server returned a thread without an id');
      }
      const now = new Date().toISOString();
      const lease: CodexCapabilityLeaseFile = {
        version: 1,
        threadId: provisionalThreadId,
        snapshotId: this.capabilitySnapshotId,
        rootContentIds,
        kind: 'persisted-chat',
        reasoningRouteFamily: this.reasoningRouteFamily,
        createdAt: now,
        updatedAt: now,
      };
      if (pin) {
        await this.capabilityStore.promotePinToLease(pin.pinId, lease);
      } else {
        await this.capabilityStore.writeLease(lease);
      }
      leasePersisted = true;
      this.assertNotDisposed();
      this.assertTurnStartNotCancelled(turnStartGeneration);
      return response;
    } catch (error) {
      if (provisionalThreadId) {
        this.connection.unregisterThread(provisionalThreadId);
        await this.connection
          .request(
            'thread/delete',
            { threadId: provisionalThreadId },
            { timeoutMs: 10_000 },
          )
          .catch(() => {});
        if (leasePersisted) {
          await this.capabilityStore
            .releaseLease(provisionalThreadId)
            .catch(() => {});
        }
      }
      if (pin) {
        await this.capabilityStore
          .releaseOperationPin(pin.pinId)
          .catch(() => {});
      }
      throw error;
    } finally {
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
    }
  }

  private selectedCapabilityRootContentIds(
    roots: readonly SelectedCapabilityRoot[] | null | undefined = this
      .selectedCapabilityRoots,
  ): string[] {
    return (roots ?? []).map((root) => {
      if (!/^[a-f0-9]{64}$/.test(root.id)) {
        throw new Error(
          `Codex capability root is not content-addressed: ${root.id}`,
        );
      }
      return root.id;
    });
  }

  /**
   * Built-in `request_user_input` handler. Routes through the shared
   * `requestAnswersFromRenderer` bridge AND emits synthetic
   * `dynamic_tool_call` items (Section 7) so the renderer renders this like
   * any other ask-user card. The synthetic items are dispatched DIRECTLY to
   * the event sink (not re-passed through `mapThreadItem`) because they are
   * already normalized.
   */
  async handleRequestUserInput(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    requestSignal?: AbortSignal,
  ): Promise<void> {
    if (requestSignal?.aborted) {
      return;
    }
    const params = readRecord(request, 'params');
    const parsedQuestions = params ? parseUserInputQuestions(params) : null;
    if (!params || !parsedQuestions) {
      if (!this.connection.completePendingServerRequest(requestId)) {
        return;
      }
      this.connection.send({
        id: requestId,
        error: {
          code: -32602,
          message: 'Invalid request_user_input payload',
        },
      });
      return;
    }

    const itemId = readString(params, 'itemId') ?? '';
    const toolUseId = codexToolUseId(itemId);
    const questions = toMcpQuestions(parsedQuestions);
    // `ToolRequestUserInputParams` already exposes thread/turn/item ids;
    // forward them on BOTH the synthetic `item.started` and `item.completed`
    // events so ask-user cards spawned inside a subagent group under the
    // subagent's `codex_agent` block.
    const eventThreadId = readString(params, 'threadId');
    const eventTurnId = readString(params, 'turnId');
    const syntheticRouting: CodexItemRouting | undefined =
      typeof eventThreadId === 'string'
        ? {
            thread_id: eventThreadId,
            ...(typeof eventTurnId === 'string' && eventTurnId
              ? { turn_id: eventTurnId }
              : {}),
          }
        : undefined;

    // Synthetic started item (Section 7).
    if (itemId) {
      const startedItem: Record<string, unknown> = {
        type: 'dynamic_tool_call',
        id: itemId,
        namespace: null,
        tool: 'request_user_input',
        arguments: { questions: parsedQuestions },
        status: 'in_progress',
        content_items: null,
        success: null,
      };
      this.activeTurn?.items.set(itemId, startedItem);
      captureItemRouting(this.activeTurn, itemId, eventThreadId, eventTurnId);
      void this.onEvent({
        type: 'codex',
        event: withRouting(
          { type: 'item.started', item: startedItem },
          syntheticRouting,
        ),
      });
    }

    const recoveryAbortController = new AbortController();
    const signal = AbortSignal.any(
      requestSignal
        ? [requestSignal, recoveryAbortController.signal]
        : [recoveryAbortController.signal],
    );
    this.pendingRecoveryAbortControllers.add(recoveryAbortController);
    try {
      const cancellationGeneration =
        this.rendererQuestionCancellationGeneration;
      const answers = await requestAnswersFromRenderer({
        sessionKey: this.sessionKey,
        projectId: this.projectId,
        worktreeId: this.worktreeId,
        chatId: this.chatId,
        questions,
        getWindow: this.getWindow,
        toolUseId,
        providerType: 'codex',
        onAwaitingUser: this.onAwaitingUser,
        signal,
      });
      if (signal.aborted) {
        throw new Error('ask_user_cancelled');
      }
      if (this.disposed) {
        return;
      }
      if (
        cancellationGeneration !== this.rendererQuestionCancellationGeneration
      ) {
        throw new Error('turn_cancelled');
      }
      if (!this.connection.completePendingServerRequest(requestId)) {
        return;
      }
      this.connection.send({
        id: requestId,
        result: answersToToolResponse(
          answers,
          parsedQuestions.map((question) => ({
            id: question.id,
            question: question.question,
          })),
        ),
      });

      if (itemId) {
        const answerText = formatRequestUserInputSyntheticAnswers(
          answers,
          parsedQuestions,
        );
        const completedItem: Record<string, unknown> = {
          type: 'dynamic_tool_call',
          id: itemId,
          namespace: null,
          tool: 'request_user_input',
          arguments: { questions: parsedQuestions },
          status: 'completed',
          content_items: [{ type: 'inputText', text: answerText }],
          success: true,
        };
        this.emitSyntheticCompleted(itemId, completedItem, syntheticRouting);
      }
    } catch (error) {
      if (this.disposed || requestSignal?.aborted) {
        return;
      }
      const message =
        error instanceof Error ? error.message : 'request_user_input rejected';
      if (this.connection.completePendingServerRequest(requestId)) {
        this.connection.send({
          id: requestId,
          error: { code: -32000, message },
        });
      }

      if (itemId) {
        const failedItem: Record<string, unknown> = {
          type: 'dynamic_tool_call',
          id: itemId,
          namespace: null,
          tool: 'request_user_input',
          arguments: { questions: parsedQuestions },
          status: 'failed',
          content_items: [{ type: 'inputText', text: message }],
          success: false,
        };
        this.emitSyntheticCompleted(itemId, failedItem, syntheticRouting);
      }
    } finally {
      this.pendingRecoveryAbortControllers.delete(recoveryAbortController);
    }
  }

  /**
   * Replies to a pending approval-family server request, guarded by the
   * shared `completePendingServerRequest` check (mirrors the pattern used by
   * `handleRequestUserInput` / `handleDynamicToolCall`).
   */
  private completeApprovalRequest(
    requestId: JsonRpcId,
    result: Record<string, unknown>,
  ): void {
    if (!this.connection.completePendingServerRequest(requestId)) {
      return;
    }
    this.connection.send({ id: requestId, result });
  }

  /**
   * Runs a policy-engine check with an always-resolves guarantee. Approval
   * handlers fail closed when the session is unavailable or a check fails,
   * including rule-file and grant-persistence errors. A provider-resolved
   * prompt returns undefined so callers leave its already-completed request
   * alone rather than sending a second reply.
   */
  private async checkApproval(
    approvalCheck: ApprovalCheck,
    display: ApprovalCheckDisplay,
    subagentId?: string,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome | undefined> {
    if (signal?.aborted) {
      return undefined;
    }
    if (this.approvalChecksCancelled || !this.approvalSession) {
      return { decision: 'deny' };
    }
    try {
      const outcome = await this.approvalSession.check(approvalCheck, {
        ...display,
        ...(signal !== undefined ? { signal } : {}),
        ...(subagentId !== undefined ? { subagentId } : {}),
      });
      return signal?.aborted ? undefined : outcome;
    } catch (error) {
      if (signal?.aborted || isExpectedPromptCancellation(error)) {
        return undefined;
      }
      return { decision: 'deny' };
    }
  }

  private async checkApprovalRequirements(
    requirements: readonly CodexApprovalRequirement[],
    subagentId?: string,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome | undefined> {
    for (const requirement of requirements) {
      const outcome = await this.checkApproval(
        requirement.check,
        requirement.display,
        subagentId,
        signal,
      );
      if (!outcome) {
        return undefined;
      }
      if (outcome.decision !== 'allow') {
        return outcome;
      }
    }
    return { decision: 'allow' };
  }

  /**
   * A Codex approval request belongs to this owner's root thread when its
   * `threadId` matches `this.threadId` (see the "root-thread identity
   * stickiness" comment on `emitThreadStartedFromThread`). Any other
   * thread id sharing this owner was registered via
   * the shared Codex connection's subagent registration — surface it on the
   * approval display so the renderer can attribute the request to a
   * subagent. If this owner's root thread isn't known yet, or the request
   * carries no thread id at all (some legacy request shapes), leave it
   * unattributed rather than guessing.
   */
  private resolveSubagentId(threadId: string | undefined): string | undefined {
    if (!threadId || !this.threadId) {
      return undefined;
    }
    return threadId !== this.threadId ? threadId : undefined;
  }

  /**
   * Dispatcher for the approval-family server requests routed here by
   * the shared Codex connection's approval router: the v2
   * command-execution / file-change / permissions approvals, the legacy
   * `execCommandApproval` / `applyPatchApproval` pair, and *genuine* MCP
   * elicitations (`mcpServer/elicitation/request` without a Canopy
   * `mcp_tool_call` approval meta). Canopy-synthesized tool-call elicitations
   * never reach this dispatcher — the connection's `routeMcpElicitation`
   * calls `handleMcpElicitation` directly for those. Most branches here are
   * routed through the shared policy engine via `this.approvalSession` — when
   * no handle is configured (a one-shot helper client that never drives a
   * turn), those branches fail closed. The genuine-elicitation branch is the
   * exception: `form` mode bridges to the ask-user UI instead of the policy
   * engine, and fails closed (declines) when no renderer is available to
   * answer it; `url` / `openai/form` modes are always declined.
   */
  async handleApprovalRequest(
    requestId: JsonRpcId,
    method: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    // Every approval-shaped request carries its originating thread under
    // `threadId` (v2 methods, `item/tool/requestUserInput`) or the legacy
    // `conversationId` (`execCommandApproval` / `applyPatchApproval`) —
    // `extractApprovalThreadId` is shared with the connection's routing.
    // Resolve
    // subagent attribution once, up front, so every per-method handler below
    // can thread it straight into its display(s).
    const requestParams = readRecord(request, 'params');
    const requestThreadId = extractApprovalThreadId(requestParams);
    const subagentId = this.resolveSubagentId(requestThreadId);
    switch (method) {
      case 'item/commandExecution/requestApproval':
        await this.handleCommandExecutionApproval(
          requestId,
          request,
          subagentId,
          signal,
        );
        return;
      case 'item/fileChange/requestApproval':
        await this.handleFileChangeApproval(
          requestId,
          request,
          subagentId,
          signal,
        );
        return;
      case 'item/permissions/requestApproval':
        await this.handlePermissionsApproval(
          requestId,
          request,
          subagentId,
          signal,
        );
        return;
      case 'execCommandApproval':
        await this.handleLegacyExecApproval(
          requestId,
          request,
          subagentId,
          signal,
        );
        return;
      case 'applyPatchApproval':
        await this.handleLegacyApplyPatchApproval(
          requestId,
          request,
          subagentId,
          signal,
        );
        return;
      case 'mcpServer/elicitation/request':
        await this.handleMcpElicitationRequest(
          requestId,
          request,
          subagentId,
          signal,
        );
        return;
      case 'item/tool/requestUserInput':
        await this.handleFallbackMcpApproval(
          requestId,
          request,
          subagentId,
          signal,
        );
        return;
      default:
        this.completeApprovalRequest(requestId, { decision: 'decline' });
    }
  }

  private async handleCommandExecutionApproval(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    subagentId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const params = readRecord(request, 'params') ?? {};
    const approvalKind = readString(params, 'kind') ?? 'command';
    if (approvalKind === 'writeStdin') {
      const approvalId = readString(params, 'approvalId')?.trim();
      if (!approvalId) {
        this.completeApprovalRequest(requestId, { decision: 'decline' });
        return;
      }
      const reason = readString(params, 'reason');
      const outcome = await this.checkApproval(
        {
          kind: 'tool',
          toolName: `codex:write-stdin:${approvalId}`,
        },
        {
          title: 'Terminal input approval',
          details: {
            kind: 'tool',
            toolName: 'Terminal input',
            ...(reason ? { inputSummary: reason } : {}),
          },
          toolUseId: codexToolUseId(approvalId),
        },
        subagentId,
        signal,
      );
      if (!outcome) return;
      if (this.disposed) {
        return;
      }
      if (outcome.decision === 'allow') {
        this.completeApprovalRequest(requestId, { decision: 'accept' });
        return;
      }
      this.completeApprovalRequest(requestId, { decision: 'decline' });
      if (outcome.stopTurn) {
        await this.interruptTurn();
      }
      return;
    }
    if (approvalKind !== 'command') {
      this.completeApprovalRequest(requestId, { decision: 'decline' });
      return;
    }
    const itemId = readString(params, 'itemId');
    const command = readString(params, 'command');
    const cwd = readString(params, 'cwd');
    const reason = readString(params, 'reason');
    const networkContext = readRecord(params, 'networkApprovalContext');
    const additionalPermissions = readRecord(params, 'additionalPermissions');
    if (
      (params.networkApprovalContext !== null &&
        params.networkApprovalContext !== undefined &&
        !networkContext) ||
      (params.additionalPermissions !== null &&
        params.additionalPermissions !== undefined &&
        !additionalPermissions)
    ) {
      this.completeApprovalRequest(requestId, { decision: 'decline' });
      return;
    }
    const parsedOverlay = additionalPermissions
      ? permissionRequirements(
          additionalPermissions,
          reason,
          codexToolUseId(itemId),
        )
      : { requirements: [], normalizedPermissions: {} };
    if (parsedOverlay === null) {
      this.completeApprovalRequest(requestId, { decision: 'decline' });
      return;
    }
    const requirements: CodexApprovalRequirement[] = [];
    if (command?.trim()) {
      requirements.push({
        check: { kind: 'command', command, ...(cwd ? { cwd } : {}) },
        display: {
          title: 'Codex wants to run a command',
          details: {
            kind: 'command',
            command,
            ...(cwd ? { cwd } : {}),
            ...(reason ? { reason } : {}),
          },
          suggestedTarget: {
            kind: 'command',
            pattern: commandSuggestedPattern(command),
          },
          toolUseId: codexToolUseId(itemId),
        },
      });
    }
    const networkHost = networkContext
      ? readString(networkContext, 'host')
      : undefined;
    if (networkContext && !networkHost) {
      this.completeApprovalRequest(requestId, { decision: 'decline' });
      return;
    }
    if (networkHost) {
      requirements.push({
        check: { kind: 'network', host: networkHost },
        display: {
          title: 'Codex wants network access',
          details: {
            kind: 'network',
            host: networkHost,
            ...(reason ? { reason } : {}),
          },
          suggestedTarget: { kind: 'network', host: networkHost },
          toolUseId: codexToolUseId(itemId),
        },
      });
    }
    requirements.push(...parsedOverlay.requirements);
    if (requirements.length === 0) {
      this.completeApprovalRequest(requestId, { decision: 'decline' });
      return;
    }

    const outcome = await this.checkApprovalRequirements(
      requirements,
      subagentId,
      signal,
    );
    if (!outcome) return;
    if (this.disposed) {
      return;
    }

    if (outcome.decision === 'allow') {
      this.completeApprovalRequest(requestId, { decision: 'accept' });
      return;
    }
    this.completeApprovalRequest(requestId, { decision: 'decline' });
    if (outcome.stopTurn) {
      await this.interruptTurn();
    }
  }

  private async handleFileChangeApproval(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    subagentId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const params = readRecord(request, 'params') ?? {};
    const itemId = readString(params, 'itemId');
    const grantRoot = readString(params, 'grantRoot');
    const reason = readString(params, 'reason');
    const item = itemId ? this.activeTurn?.items.get(itemId) : undefined;
    const changes =
      item && readString(item, 'type') === 'file_change'
        ? readArray(item, 'changes')
        : [];
    const paths = Array.from(
      new Set(
        changes.flatMap((change) => {
          if (!isRecord(change)) return [];
          const path = readString(change, 'path');
          const movePath = readString(change, 'movePath');
          return [path, movePath].filter(
            (candidate): candidate is string => typeof candidate === 'string',
          );
        }),
      ),
    );
    if (grantRoot && !paths.includes(grantRoot)) {
      paths.push(grantRoot);
    }
    if (paths.length === 0) {
      this.completeApprovalRequest(requestId, { decision: 'decline' });
      return;
    }
    const requirements = paths.map(
      (path): CodexApprovalRequirement => ({
        check: {
          kind: 'file-write',
          path,
          ...(path === grantRoot ? { isGrant: true } : {}),
        },
        display: {
          title: 'Codex wants to modify files',
          details: {
            kind: 'file-write',
            path,
            ...(itemId ? { itemId } : {}),
            ...(reason ? { reason } : {}),
          },
          suggestedTarget: { kind: 'file-write', path },
          toolUseId: codexToolUseId(itemId),
        },
      }),
    );

    const outcome = await this.checkApprovalRequirements(
      requirements,
      subagentId,
      signal,
    );
    if (!outcome) return;
    if (this.disposed) {
      return;
    }

    if (outcome.decision === 'allow') {
      this.completeApprovalRequest(requestId, { decision: 'accept' });
      return;
    }
    this.completeApprovalRequest(requestId, { decision: 'decline' });
    if (outcome.stopTurn) {
      await this.interruptTurn();
    }
  }

  private async handlePermissionsApproval(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    subagentId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const params = readRecord(request, 'params') ?? {};
    const itemId = readString(params, 'itemId');
    const permissions = readRecord(params, 'permissions');
    if (!permissions) {
      this.completeApprovalRequest(requestId, {
        permissions: {},
        scope: 'turn',
      });
      return;
    }
    const reason = readString(params, 'reason');
    const parsedPermissions = permissionRequirements(
      permissions,
      reason,
      codexToolUseId(itemId),
    );
    const outcome: ApprovalOutcome | undefined = parsedPermissions
      ? await this.checkApprovalRequirements(
          parsedPermissions.requirements,
          subagentId,
          signal,
        )
      : { decision: 'deny' };
    if (!outcome) return;
    if (this.disposed) {
      return;
    }

    if (outcome.decision === 'allow') {
      // Grant exactly what was asked, turn-scoped — Canopy's rule store
      // stays the single source of truth for anything longer-lived.
      this.completeApprovalRequest(requestId, {
        permissions: parsedPermissions?.normalizedPermissions ?? {},
        scope: 'turn',
      });
      return;
    }
    this.completeApprovalRequest(requestId, { permissions: {}, scope: 'turn' });
    if (outcome.stopTurn) {
      await this.interruptTurn();
    }
  }

  private async handleLegacyExecApproval(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    subagentId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const params = readRecord(request, 'params') ?? {};
    const commandArgs = readStringArray(params, 'command');
    const cwd = readString(params, 'cwd');
    const reason = readString(params, 'reason');
    if (!commandArgs.some((argument) => argument.trim().length > 0)) {
      this.completeApprovalRequest(requestId, { decision: 'denied' });
      return;
    }
    const command = formatLegacyCommand(commandArgs);

    const outcome = await this.checkApproval(
      { kind: 'command', command, ...(cwd ? { cwd } : {}) },
      {
        title: 'Codex wants to run a command',
        details: {
          kind: 'command',
          command,
          ...(cwd ? { cwd } : {}),
          ...(reason ? { reason } : {}),
        },
        suggestedTarget: {
          kind: 'command',
          // Legacy requests carry argv rather than an already-rendered shell
          // command. Keep the remembered target exact so argument boundaries
          // cannot collapse into a broader grant.
          pattern: command,
        },
      },
      subagentId,
      signal,
    );
    if (!outcome) return;
    if (this.disposed) {
      return;
    }

    if (outcome.decision === 'allow') {
      this.completeApprovalRequest(requestId, { decision: 'approved' });
      return;
    }
    this.completeApprovalRequest(requestId, {
      decision: outcome.stopTurn ? 'abort' : 'denied',
    });
  }

  private async handleLegacyApplyPatchApproval(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    subagentId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const params = readRecord(request, 'params') ?? {};
    const callId = readString(params, 'callId');
    const grantRoot = readString(params, 'grantRoot');
    const reason = readString(params, 'reason');
    const fileChanges = readRecord(params, 'fileChanges');
    const paths = fileChanges
      ? Array.from(
          new Set(
            Object.entries(fileChanges).flatMap(([path, change]) => {
              const movePath = isRecord(change)
                ? (readString(change, 'move_path') ??
                  readString(change, 'movePath'))
                : undefined;
              return movePath ? [path, movePath] : [path];
            }),
          ),
        )
      : [];
    if (grantRoot && !paths.includes(grantRoot)) {
      paths.push(grantRoot);
    }
    if (paths.length === 0) {
      this.completeApprovalRequest(requestId, { decision: 'denied' });
      return;
    }
    const requirements = paths.map(
      (path): CodexApprovalRequirement => ({
        check: {
          kind: 'file-write',
          path,
          ...(path === grantRoot ? { isGrant: true } : {}),
        },
        display: {
          title: 'Codex wants to modify files',
          details: {
            kind: 'file-write',
            path,
            ...(reason ? { reason } : {}),
          },
          suggestedTarget: { kind: 'file-write', path },
          toolUseId: callId,
        },
      }),
    );

    const outcome = await this.checkApprovalRequirements(
      requirements,
      subagentId,
      signal,
    );
    if (!outcome) return;
    if (this.disposed) {
      return;
    }

    if (outcome.decision === 'allow') {
      this.completeApprovalRequest(requestId, { decision: 'approved' });
      return;
    }
    this.completeApprovalRequest(requestId, {
      decision: outcome.stopTurn ? 'abort' : 'denied',
    });
  }

  /**
   * Older Codex builds surface MCP tool approval as a specially-prefixed
   * request_user_input question. Treat that compatibility transport as an
   * approval request, not a generic question, so remembered MCP rules and
   * explicit denies remain authoritative.
   */
  private async handleFallbackMcpApproval(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    subagentId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const params = readRecord(request, 'params');
    const questions = params ? parseUserInputQuestions(params) : null;
    const approvalQuestionIds =
      questions
        ?.filter((question) =>
          question.id.startsWith('mcp_tool_call_approval_'),
        )
        .map((question) => question.id) ?? [];
    const itemId = params ? readString(params, 'itemId') : undefined;
    const item = itemId ? this.activeTurn?.items.get(itemId) : undefined;
    const server =
      item && readString(item, 'type') === 'mcp_tool_call'
        ? readString(item, 'server')
        : undefined;
    const tool =
      item && readString(item, 'type') === 'mcp_tool_call'
        ? readString(item, 'tool')
        : undefined;

    let outcome: ApprovalOutcome | undefined = { decision: 'deny' };
    if (approvalQuestionIds.length > 0 && server && tool) {
      outcome = await this.checkApproval(
        { kind: 'mcp', server, tool },
        {
          title: `Codex wants to use ${tool}`,
          details: {
            kind: 'mcp',
            server,
            tool,
          },
          suggestedTarget: { kind: 'mcp', server, tool },
          toolUseId: codexToolUseId(itemId),
        },
        subagentId,
        signal,
      );
    }
    if (!outcome) return;
    if (this.disposed) {
      return;
    }

    const answer =
      outcome.decision === 'allow' ? 'Allow' : '__codex_mcp_decline__';
    this.completeApprovalRequest(requestId, {
      answers: Object.fromEntries(
        approvalQuestionIds.map((questionId) => [
          questionId,
          { answers: [answer] },
        ]),
      ),
    });
    if (outcome.decision === 'deny' && outcome.stopTurn) {
      await this.interruptTurn();
    }
  }

  /**
   * `mcpServer/elicitation/request` covers two unrelated things Codex
   * multiplexes onto the same method: a synthesized tool-call approval
   * prompt (`_meta.codex_approval_kind === 'mcp_tool_call'`, routed through
   * the policy engine like any other approval) and a genuine MCP elicitation
   * from the tool itself (no approval meta — bridged to the ask-user UI for
   * `form` mode, declined outright for `url` / `openai/form` modes, which
   * Canopy has no UI surface for).
   */
  private async handleMcpElicitationRequest(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    subagentId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    const params = readRecord(request, 'params') ?? {};
    const serverName = readString(params, 'serverName') ?? '';
    const mode = readString(params, 'mode');
    const message = readString(params, 'message') ?? '';
    const meta = readRecord(params, '_meta');

    if (meta && readString(meta, 'codex_approval_kind') === 'mcp_tool_call') {
      const tool = readString(meta, 'tool_name');
      if (!tool) {
        this.completeApprovalRequest(requestId, {
          action: 'decline',
          content: null,
          _meta: null,
        });
        return;
      }
      const toolTitle = readString(meta, 'tool_title') ?? tool;
      const paramsDisplay = readString(meta, 'tool_params_display');

      const outcome = await this.checkApproval(
        { kind: 'mcp', server: serverName, tool },
        {
          title: `Codex wants to use ${toolTitle}`,
          details: {
            kind: 'mcp',
            server: serverName,
            tool,
            ...(paramsDisplay ? { paramsDisplay } : {}),
          },
          suggestedTarget: { kind: 'mcp', server: serverName, tool },
        },
        subagentId,
        signal,
      );
      if (!outcome) return;
      if (this.disposed) {
        return;
      }

      if (outcome.decision === 'allow') {
        this.completeApprovalRequest(requestId, {
          action: 'accept',
          content: null,
          _meta: null,
        });
        return;
      }
      this.completeApprovalRequest(requestId, {
        action: 'decline',
        content: null,
        _meta: null,
      });
      if (outcome.stopTurn) {
        await this.interruptTurn();
      }
      return;
    }

    // Genuine elicitation, not a Canopy-synthesized approval. `url` and
    // `openai/form` modes have no Canopy UI surface today. Form schemas are
    // bridged only when every property can be represented by the ask-user UI.
    if (mode !== 'form') {
      this.completeApprovalRequest(requestId, {
        action: 'decline',
        content: null,
        _meta: null,
      });
      return;
    }
    if (this.approvalChecksCancelled) {
      this.completeApprovalRequest(requestId, {
        action: 'decline',
        content: null,
        _meta: null,
      });
      return;
    }
    const form = buildMcpElicitationForm(message, params.requestedSchema);
    if (!form) {
      this.completeApprovalRequest(requestId, {
        action: 'decline',
        content: null,
        _meta: null,
      });
      return;
    }

    const recoveryAbortController = new AbortController();
    const questionSignal = AbortSignal.any(
      signal
        ? [signal, recoveryAbortController.signal]
        : [recoveryAbortController.signal],
    );
    this.pendingRecoveryAbortControllers.add(recoveryAbortController);
    try {
      const cancellationGeneration =
        this.rendererQuestionCancellationGeneration;
      const answers = await requestAnswersFromRenderer({
        sessionKey: this.sessionKey,
        projectId: this.projectId,
        worktreeId: this.worktreeId,
        chatId: this.chatId,
        questions: form.questions,
        getWindow: this.getWindow,
        providerType: 'codex',
        onAwaitingUser: this.onAwaitingUser,
        signal: questionSignal,
      });
      if (questionSignal.aborted) {
        throw new Error('ask_user_cancelled');
      }
      if (this.disposed) {
        return;
      }
      if (
        this.approvalChecksCancelled ||
        cancellationGeneration !== this.rendererQuestionCancellationGeneration
      ) {
        throw new Error('turn_cancelled');
      }
      this.completeApprovalRequest(requestId, {
        action: 'accept',
        content: form.contentFromAnswers(answers),
        _meta: null,
      });
    } catch {
      if (this.disposed || signal?.aborted) {
        return;
      }
      this.completeApprovalRequest(requestId, {
        action: 'decline',
        content: null,
        _meta: null,
      });
    } finally {
      this.pendingRecoveryAbortControllers.delete(recoveryAbortController);
    }
  }

  /**
   * Dispatcher for `item/tool/call` — the Codex app-server's request for the
   * client to execute an injected dynamic tool and return a
   * `DynamicToolCallResponse`.
   *
   * Per Section 5.3:
   *  - Malformed payload → JSON-RPC `-32602` `Invalid dynamic tool call payload`
   *  - No handler configured → failed `DynamicToolCallResponse` (NOT an
   *    error)
   *  - Unknown dynamic tool name → handler returns
   *    `{ contentItems: [..Unsupported..], success: false }`
   *  - Success → handler returns a valid `DynamicToolCallResponse`
   */
  async handleDynamicToolCall(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
  ): Promise<void> {
    const params = readRecord(request, 'params');
    const parsed = params ? parseDynamicToolCallParams(params) : null;
    if (!parsed) {
      if (!this.connection.completePendingServerRequest(requestId)) {
        return;
      }
      this.connection.send({
        id: requestId,
        error: {
          code: -32602,
          message: 'Invalid dynamic tool call payload',
        },
      });
      return;
    }

    if (!this.dynamicToolCallHandler) {
      const response: DynamicToolCallResponse = {
        contentItems: [
          {
            type: 'inputText',
            text: `No dynamic tool handler configured for ${parsed.tool}`,
          },
        ],
        success: false,
      };
      if (!this.connection.completePendingServerRequest(requestId)) {
        return;
      }
      this.connection.send({ id: requestId, result: response });
      return;
    }

    if (
      parsed.tool === immediateTurnRestartCodexToolName &&
      (this.activeTurn?.hostOwnsAdmission ||
        this.immediateTurnRestartArmedTurnId !== parsed.turnId)
    ) {
      if (!this.connection.completePendingServerRequest(requestId)) return;
      this.connection.send({
        id: requestId,
        result: {
          contentItems: [
            {
              type: 'inputText',
              text: 'ImmediateTurnRestart is only available after a refreshed MCP connection is steered into this active turn.',
            },
          ],
          success: false,
        } satisfies DynamicToolCallResponse,
      });
      return;
    }

    const controller = new AbortController();
    const recoveryAbortController = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      recoveryAbortController.signal,
    ]);
    this.pendingRecoveryAbortControllers.add(recoveryAbortController);
    this.dynamicToolCalls.set(requestId, { params: parsed, controller });
    const timeoutText =
      'The dynamic tool call was stopped at its time limit; its effects may be incomplete.';
    let deadlineReached = false;
    const onAbort = (): void => {
      clearTimeout(deadline);
      if (deadlineReached) return;
      this.connection.completePendingServerRequest(requestId);
      this.rememberStoppedDynamicToolCall(
        parsed,
        'The dynamic tool call was cancelled; its effects may be incomplete.',
      );
    };
    const deadline = setTimeout(
      () => {
        deadlineReached = true;
        this.rememberStoppedDynamicToolCall(parsed, timeoutText);
        controller.abort();
        if (
          this.disposed ||
          !this.connection.completePendingServerRequest(requestId)
        )
          return;
        this.connection.send({
          id: requestId,
          result: {
            contentItems: [{ type: 'inputText', text: timeoutText }],
            success: false,
          } satisfies DynamicToolCallResponse,
        });
      },
      isCanopyAskUserToolName(parsed.tool) ||
        getCanonicalAppAdvisorToolKey(parsed.tool) === 'ask_user_question'
        ? ASK_USER_HTTP_TIMEOUT_MS
        : CANOPY_MCP_TOOL_TIMEOUT_MS,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.dynamicToolCallHandler(parsed, {
        signal,
      });
      if (this.disposed || signal.aborted) {
        return;
      }
      if (!this.connection.completePendingServerRequest(requestId)) {
        return;
      }
      this.connection.send({ id: requestId, result: response });
      if (
        this.onDynamicToolResultAccepted &&
        parsed.threadId === this.threadId
      ) {
        this.pendingNativeDynamicResults.set(parsed.callId, {
          threadId: parsed.threadId,
          turnId: parsed.turnId,
        });
        if (this.pendingNativeDynamicResults.size > 256) {
          const oldest = this.pendingNativeDynamicResults.keys().next().value;
          if (oldest) this.pendingNativeDynamicResults.delete(oldest);
        }
      }
      if (
        parsed.tool === immediateTurnRestartCodexToolName &&
        response.success
      ) {
        this.immediateTurnRestartArmedTurnId = undefined;
        this.pendingImmediateTurnRestartResultIds.add(parsed.callId);
      }
      // The JSON-RPC write only hands the result to app-server. Track responses
      // while this scope has a deferred reload instead of matching one advertised
      // tool-family name. The intent lookup filters unrelated concurrent calls
      // after the matching item/completed acknowledgement.
      if (
        deferredToolsReloadCoordinator.hasActiveReload({
          projectId: this.projectId,
          worktreeId: this.worktreeId,
          chatId: this.chatId,
        })
      ) {
        this.pendingDeferredToolResultIds.add(parsed.callId);
      }
    } catch (error) {
      if (this.disposed || signal.aborted) {
        return;
      }
      // Error text can carry paths and workspace ids, so it goes to the log, never to the model.
      logMainProcessError('Codex dynamic tool call failed', error);
      const response: DynamicToolCallResponse = {
        contentItems: [{ type: 'inputText', text: 'Dynamic tool call failed' }],
        success: false,
      };
      if (!this.connection.completePendingServerRequest(requestId)) {
        return;
      }
      this.connection.send({ id: requestId, result: response });
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', onAbort);
      this.dynamicToolCalls.delete(requestId);
      this.pendingRecoveryAbortControllers.delete(recoveryAbortController);
    }
  }

  async handleMcpElicitation(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    toolCall: CodexMcpToolCallContext,
    approvalKind: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    if (approvalKind !== 'mcp_tool_call') {
      this.completeApprovalRequest(requestId, {
        action: 'decline',
        content: null,
        _meta: null,
      });
      return;
    }
    const params = readRecord(request, 'params');
    const metadata = params ? readRecord(params, '_meta') : null;
    const toolTitle =
      (metadata ? readString(metadata, 'tool_title') : undefined) ??
      toolCall.toolName;
    const outcome = await this.checkApproval(
      {
        kind: 'mcp',
        server: toolCall.serverName,
        tool: toolCall.toolName,
      },
      {
        title: `Codex wants to use ${toolTitle}`,
        details: {
          kind: 'mcp',
          server: toolCall.serverName,
          tool: toolCall.toolName,
          paramsDisplay: toolCall.normalizedArguments,
        },
        suggestedTarget: {
          kind: 'mcp',
          server: toolCall.serverName,
          tool: toolCall.toolName,
        },
      },
      this.resolveSubagentId(extractApprovalThreadId(params)),
      signal,
    );
    if (!outcome) return;
    if (this.disposed) {
      return;
    }
    if (!this.connection.completePendingServerRequest(requestId)) {
      return;
    }
    const result: McpServerElicitationRequestResponse = {
      action: outcome.decision === 'allow' ? 'accept' : 'decline',
      content: null,
      _meta: null,
    };
    this.connection.send({ id: requestId, result });
    if (outcome.decision === 'deny' && outcome.stopTurn) {
      await this.interruptTurn();
    }
  }

  /**
   * Route a pre-normalized `dynamic_tool_call` item straight to the chat
   * event sink. Used by `handleRequestUserInput` (Section 7) which already
   * emits the normalized shape and MUST NOT go through `mapThreadItem()`.
   *
   * `routing` carries the originating `thread_id` / `turn_id` so synthetic
   * completions group under the same subagent block as their `item.started`
   * counterpart even when no `activeTurn` is available.
   */
  private emitSyntheticCompleted(
    itemId: string,
    item: Record<string, unknown>,
    routing?: CodexItemRouting,
  ): void {
    const turn = this.activeTurn;
    if (turn) {
      turn.items.set(itemId, item);
      emitCodexItemCompleted(this.onEvent, turn, item, routing);
      return;
    }
    void this.onEvent({
      type: 'codex',
      event: withRouting({ type: 'item.completed', item }, routing),
    });
  }

  private emitThreadStartedFromThread(
    thread: Record<string, unknown>,
    warnOnUnmarkedSubagent: boolean,
  ): void {
    const threadId = readString(thread, 'id');
    if (!threadId) {
      return;
    }

    // `Thread.source` is `SessionSource = string | { custom: string } |
    // { subAgent: SubAgentSource }`. Forward as-is so the renderer can detect
    // subagents either by string-match or by inspecting the union.
    const sourceValue = thread.source;
    const sourceMetadata = extractSubagentThreadMetadata(sourceValue);
    const agentNickname =
      readString(thread, 'agentNickname') ??
      readString(thread, 'agent_nickname') ??
      sourceMetadata.nickname ??
      null;
    const agentRole =
      readString(thread, 'agentRole') ??
      readString(thread, 'agent_role') ??
      sourceMetadata.role ??
      null;
    const source = parseJsonValue(sourceValue);

    // Root-thread identity stickiness: only a client that has never been
    // assigned a thread may adopt a thread.started id. `threadReady` is false
    // both before first initialization and after an idle process suspension;
    // using it as the identity guard lets a late notification for another
    // pooled client replace the suspended client's known root thread.
    const isRootThread = !this.threadId;
    if (isRootThread) {
      this.threadId = threadId;
      this.threadReady = true;
      this.connection.registerRootThread(threadId);
    } else if (threadId !== this.threadId) {
      if (
        warnOnUnmarkedSubagent &&
        this.threadId &&
        !hasSubagentThreadMarker(sourceValue, agentNickname, agentRole)
      ) {
        process.emitWarning(
          `Codex app-server emitted a non-root thread.started without a subagent marker: ${threadId}`,
          { type: 'CanopyCodexProtocolWarning' },
        );
      }
      this.registerSubagentThread(threadId);
    }

    void this.onEvent({
      type: 'codex',
      event: {
        type: 'thread.started',
        thread_id: threadId,
        ...(agentNickname !== null ? { agent_nickname: agentNickname } : {}),
        ...(agentRole !== null ? { agent_role: agentRole } : {}),
        ...(readString(thread, 'parentThreadId')
          ? { parent_thread_id: readString(thread, 'parentThreadId') }
          : {}),
        ...(readString(thread, 'model')
          ? { model: readString(thread, 'model') }
          : {}),
        ...(readString(thread, 'reasoningEffort')
          ? { reasoning_effort: readString(thread, 'reasoningEffort') }
          : {}),
        ...(typeof source !== 'undefined' ? { source } : {}),
      },
    });
  }

  private maybeHydrateCollabAgentThreads(item: Record<string, unknown>): void {
    const itemType = readString(item, 'type');
    const threadIds =
      itemType === 'sub_agent_activity' &&
      readString(item, 'kind') === 'started'
        ? [readString(item, 'agent_thread_id') ?? '']
        : itemType === 'collab_agent_tool_call' &&
            readString(item, 'tool') === 'spawnAgent'
          ? readStringArray(item, 'receiver_thread_ids')
          : [];
    for (const threadId of threadIds) {
      if (!threadId) continue;
      this.registerSubagentThread(threadId);
      this.hydrateSubagentThreadMetadata(threadId);
    }
  }

  private registerSubagentThread(threadId: string): void {
    this.registeredSubagentThreadIds.add(threadId);
    this.connection.registerSubagentThread(threadId);
  }

  private hydrateSubagentThreadMetadata(threadId: string): void {
    if (
      threadId.length === 0 ||
      threadId === this.threadId ||
      this.hydratedSubagentThreadIds.has(threadId)
    ) {
      return;
    }

    this.hydratedSubagentThreadIds.add(threadId);
    const request = this.request('thread/read', {
      threadId,
      includeTurns: false,
    });
    void request
      .then((response: unknown): void => {
        if (this.disposed) {
          return;
        }
        if (!isRecord(response)) {
          return;
        }
        const thread = readRecord(response, 'thread');
        if (!thread) {
          this.hydratedSubagentThreadIds.delete(threadId);
          return;
        }
        if (!hasThreadDisplayMetadata(thread)) {
          this.hydratedSubagentThreadIds.delete(threadId);
          return;
        }
        this.emitThreadStartedFromThread(thread, false);
      })
      .catch((): void => {
        if (this.disposed) {
          return;
        }
        this.hydratedSubagentThreadIds.delete(threadId);
      });
  }

  private observeSteeringInputPickup(
    item: Record<string, unknown>,
    threadId: string | undefined,
    turnId: string | undefined,
  ): void {
    const clientId = readString(item, 'clientId');
    const itemId = readString(item, 'id');
    const attempt = clientId ? this.steeringInputs.get(clientId) : undefined;
    if (
      item.type !== 'userMessage' ||
      !clientId ||
      !attempt ||
      attempt.pickedUp ||
      threadId !== attempt.threadId ||
      turnId !== attempt.turnId
    )
      return;
    attempt.pickedUp = true;
    if (threadId === this.threadId && turnId === this.activeTurn?.turnId) {
      this.emitTurnLifecycleObservation({
        type: 'input-bound',
        threadId: attempt.threadId,
        turnId: attempt.turnId,
        ...(attempt.submissionId ? { submissionId: attempt.submissionId } : {}),
        ...(attempt.userMessageId
          ? { userMessageId: attempt.userMessageId }
          : {}),
      });
    }
    void this.onEvent({
      type: 'canopy_input_delivery',
      provider: 'codex',
      generation: this.inputGeneration,
      attemptId: clientId,
      phase: 'picked-up',
      providerTurnId: attempt.turnId,
      ...(itemId ? { itemId } : {}),
    });
    if (attempt.softTimedOut && attempt.onLateResponse) {
      const onLateResponse = attempt.onLateResponse;
      delete attempt.onLateResponse;
      onLateResponse({ kind: 'success', value: undefined });
    }
  }

  private handleNotification(
    method: string,
    notification: Record<string, unknown>,
  ): void {
    const params = readRecord(notification, 'params');
    if (!params) {
      return;
    }
    // Observe host input before projectCodexThreadItem drops its display item.
    // Child threads and unrelated/old root ids cannot acknowledge this input.
    if (method === 'item/started' || method === 'item/completed') {
      const item = readRecord(params, 'item');
      if (item)
        this.observeSteeringInputPickup(
          item,
          readString(params, 'threadId'),
          readString(params, 'turnId'),
        );
    }

    switch (method) {
      case 'thread/started': {
        this.handleThreadStartedNotification(params);
        return;
      }
      case 'thread/status/changed': {
        this.handleThreadStatusChangedNotification(params);
        return;
      }
      case 'turn/started': {
        this.handleTurnStartedNotification(params);
        return;
      }
      case 'item/started': {
        this.handleItemStartedNotification(params);
        return;
      }
      case 'item/agentMessage/delta': {
        this.handleAgentMessageDeltaNotification(params);
        return;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        this.handleReasoningDeltaNotification(
          params,
          method === 'item/reasoning/textDelta' ? 'text' : 'summary_text',
        );
        return;
      }
      case 'item/plan/delta': {
        this.handlePlanDeltaNotification(params);
        return;
      }
      case 'item/completed': {
        this.handleItemCompletedNotification(params);
        return;
      }
      case 'item/commandExecution/outputDelta': {
        this.handleCommandExecutionOutputDeltaNotification(params);
        return;
      }
      case 'item/mcpToolCall/progress': {
        this.handleMcpToolCallProgressNotification(params);
        return;
      }
      case 'thread/tokenUsage/updated': {
        this.handleTokenUsageUpdatedNotification(params);
        return;
      }
      case 'turn/plan/updated': {
        this.handleTurnPlanUpdatedNotification(params);
        return;
      }
      case 'turn/completed': {
        this.handleTurnCompletedNotification(params);
        return;
      }
      case 'error': {
        this.handleErrorNotification(params);
        return;
      }
      case 'account/updated': {
        this.handleAccountUpdatedNotification(params);
        return;
      }
      case 'account/rateLimits/updated': {
        this.handleAccountRateLimitsUpdatedNotification(params);
        return;
      }
      default:
        return;
    }
  }

  private handleThreadStartedNotification(
    params: Record<string, unknown>,
  ): void {
    const thread = readRecord(params, 'thread');
    if (thread) {
      this.emitThreadStartedFromThread(thread, true);
    }
  }

  private handleThreadStatusChangedNotification(
    params: Record<string, unknown>,
  ): void {
    const threadId = readString(params, 'threadId');
    const status = readRecord(params, 'status');
    if (!threadId || threadId !== this.threadId || !status) return;
    const statusType = readString(status, 'type');
    let state: 'running' | 'requires_action' | 'idle' | undefined;
    if (statusType === 'active') {
      const activeFlags = Array.isArray(status.activeFlags)
        ? status.activeFlags
        : [];
      state = activeFlags.some(
        (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
      )
        ? 'requires_action'
        : 'running';
    } else if (statusType === 'idle') {
      state = 'idle';
    }
    if (state) {
      this.emitTurnLifecycleObservation({
        type: 'session-state',
        threadId,
        ...(this.activeTurn?.rootThreadId === threadId && this.activeTurn.turnId
          ? { turnId: this.activeTurn.turnId }
          : {}),
        state,
      });
    }
  }

  private handleTurnStartedNotification(params: Record<string, unknown>): void {
    const turnRecord = readRecord(params, 'turn');
    const turnId = turnRecord ? readString(turnRecord, 'id') : undefined;
    const eventThreadId = readString(params, 'threadId');
    if (
      turnId &&
      typeof eventThreadId === 'string' &&
      eventThreadId === this.threadId
    ) {
      let turn = this.activeTurn;
      let runState: ProviderRunState | undefined;
      if (turn) {
        if (turn.turnId && turn.turnId !== turnId) {
          this.recordRootRunDrop(
            'turn/started',
            'root_run_overlap',
            eventThreadId,
            turnId,
          );
          return;
        }
        this.bindStartIdentity(turn, turnId);
        runState = this.registerProviderRunForTurn(
          turn,
          turnId,
          turn.providerOwned ? 'provider_owned' : 'dispatched',
        );
        this.observeTurnStarted(
          turn,
          turnId,
          runState,
          turnRecord ?? undefined,
        );
        this.processPendingRootTerminals(turn);
      } else {
        const key = this.providerRunKey(eventThreadId, turnId);
        const existing = this.providerRuns.get(key);
        if (existing) {
          this.recordRootRunDrop(
            'turn/started',
            existing.settled
              ? 'duplicate_settled_root_start'
              : 'duplicate_root_start',
            eventThreadId,
            turnId,
          );
          return;
        }
        // A provider-started run binds to its own evidence first, else to
        // the last execution anchor actually bound (never a queued prompt).
        const executionUserMessageId =
          (turnRecord
            ? nativeTurnExecutionUserMessageId(turnRecord)
            : undefined) ??
          getRetainedRootExecutionAnchor(
            this.retainedRootExecutionAnchorKey(eventThreadId, turnId),
          ) ??
          this.lastExecutionUserMessageId;
        if (!executionUserMessageId || !this.providerRunGeneration) {
          this.recordRootRunDrop(
            'turn/started',
            'no_execution_anchor',
            eventThreadId,
            turnId,
          );
        } else {
          let resolveProviderOwnedCompletion: (() => void) | undefined;
          const providerOwnedCompletion = new Promise<void>((resolve) => {
            resolveProviderOwnedCompletion = (): void => resolve();
          });
          const adoptedTurn: CodexTurnState = {
            rootThreadId: eventThreadId,
            turnId,
            executionUserMessageId,
            providerOwned: true,
            lifecycleOrigin: 'autonomous',
            providerOwnedCompletion,
            providerOwnedCompletionResolve: () =>
              resolveProviderOwnedCompletion?.(),
            resolve: (): void => undefined,
            reject: (): void => undefined,
            items: new Map(),
            itemRoutings: new Map(),
            completedItemIds: new Set(),
            commandOutputEmissions: new Map(),
            previousTurnId: this.lastKnownTurnId,
          };
          const adoptedRunState = this.registerProviderRunForTurn(
            adoptedTurn,
            turnId,
            'provider_owned',
          );
          if (!adoptedRunState) {
            this.recordRootRunDrop(
              'turn/started',
              'no_execution_anchor',
              eventThreadId,
              turnId,
            );
          } else {
            this.settledTurnItems = null;
            this.activeTurn = adoptedTurn;
            turn = adoptedTurn;
            runState = adoptedRunState;
            this.observeTurnStarted(
              adoptedTurn,
              turnId,
              adoptedRunState,
              turnRecord ?? undefined,
            );
            this.processPendingRootTerminals(adoptedTurn);
          }
        }
      }
      const legacyDispatchedRun =
        turn !== null && !turn.providerOwned && !turn.executionUserMessageId;
      if (turn && !runState && !legacyDispatchedRun) {
        this.recordRootRunDrop(
          'turn/started',
          'no_execution_anchor',
          eventThreadId,
          turnId,
        );
      }
      if (
        turn &&
        (turn.rootStartEmittedTurnId === turnId || runState?.startEmitted)
      )
        return;
      if (turn) turn.rootStartEmittedTurnId = turnId;
      if (runState) runState.startEmitted = true;
      if (turn) this.onSteeringEligibilityChanged?.();
    }
    void this.onEvent({
      type: 'codex',
      event: {
        type: 'turn.started',
        ...(typeof eventThreadId === 'string'
          ? { thread_id: eventThreadId }
          : {}),
        ...(typeof turnId === 'string' ? { turn_id: turnId } : {}),
      },
    });
    if (
      typeof eventThreadId === 'string' &&
      this.threadId &&
      eventThreadId !== this.threadId
    ) {
      this.hydrateSubagentThreadMetadata(eventThreadId);
    }
  }

  private handleItemStartedNotification(params: Record<string, unknown>): void {
    const item = readRecord(params, 'item');
    if (!item) {
      return;
    }

    if (this.hasSyntheticDynamicToolFailure(params, item)) return;

    const mapped = mapThreadItem(item);
    if (!mapped) {
      return;
    }
    const itemId = readString(item, 'id');
    const eventThreadId = readString(params, 'threadId');
    const eventTurnId = readString(params, 'turnId');
    if (itemId) {
      this.activeTurn?.items.set(itemId, mapped);
      captureItemRouting(this.activeTurn, itemId, eventThreadId, eventTurnId);
    }
    if (isDeferredChatItem(mapped)) {
      return;
    }
    void this.onEvent({
      type: 'codex',
      event: withRouting(
        { type: 'item.started', item: mapped },
        typeof eventThreadId === 'string'
          ? { thread_id: eventThreadId, turn_id: eventTurnId }
          : undefined,
      ),
    });
    this.maybeHydrateCollabAgentThreads(mapped);
  }

  private handleAgentMessageDeltaNotification(
    params: Record<string, unknown>,
  ): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    const itemId = readString(params, 'itemId');
    const delta = readString(params, 'delta');
    if (!itemId || typeof delta !== 'string') {
      return;
    }

    const eventThreadId = readString(params, 'threadId');
    const eventTurnId = readString(params, 'turnId');
    captureItemRouting(turn, itemId, eventThreadId, eventTurnId);

    const { text } = appendTurnItemText({
      turn,
      itemId,
      delta,
      textKey: 'text',
      defaultItem: {
        id: itemId,
        type: 'agent_message',
        text: '',
      },
    });
    if (eventThreadId === this.threadId || !eventThreadId) {
      turn.latestAgentMessage = text;
    }
  }

  private handleReasoningDeltaNotification(
    params: Record<string, unknown>,
    textKey: 'text' | 'summary_text',
  ): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    const itemId = readString(params, 'itemId');
    const delta = readString(params, 'delta');
    if (!itemId || typeof delta !== 'string') {
      return;
    }

    const eventThreadId = readString(params, 'threadId');
    const eventTurnId = readString(params, 'turnId');
    captureItemRouting(turn, itemId, eventThreadId, eventTurnId);

    appendTurnItemText({
      turn,
      itemId,
      delta,
      textKey,
      defaultItem: {
        id: itemId,
        type: 'reasoning',
        text: '',
        summary_text: '',
      },
    });
  }

  private handlePlanDeltaNotification(params: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    const itemId = readString(params, 'itemId');
    const delta = readString(params, 'delta');
    if (!itemId || typeof delta !== 'string') {
      return;
    }

    const eventThreadId = readString(params, 'threadId');
    const eventTurnId = readString(params, 'turnId');
    captureItemRouting(turn, itemId, eventThreadId, eventTurnId);

    const { text } = appendTurnItemText({
      turn,
      itemId,
      delta,
      textKey: 'text',
      defaultItem: {
        type: 'plan',
        id: itemId,
        text: '',
      },
    });
    if (eventThreadId === this.threadId || !eventThreadId) {
      turn.latestPlanText = text;
    }
    void this.onEvent({
      type: 'codex',
      event: withRouting(
        {
          type: 'item.plan.delta',
          item_id: itemId,
          delta,
          text,
        },
        typeof eventThreadId === 'string'
          ? { thread_id: eventThreadId, turn_id: eventTurnId }
          : undefined,
      ),
    });
  }

  private buildRouting(
    eventThreadId: string | undefined,
    eventTurnId: string | undefined,
  ): CodexItemRouting | undefined {
    if (typeof eventThreadId !== 'string') {
      return undefined;
    }
    return {
      thread_id: eventThreadId,
      ...(typeof eventTurnId === 'string' && eventTurnId
        ? { turn_id: eventTurnId }
        : {}),
    };
  }

  private handleItemCompletedNotification(
    params: Record<string, unknown>,
  ): void {
    const item = readRecord(params, 'item');
    if (!item) {
      return;
    }

    const completedThreadId = readString(params, 'threadId');
    const completedTurnId = readString(params, 'turnId');
    const isRootCompletion =
      completedThreadId === this.threadId || !completedThreadId;
    const oldRun =
      isRootCompletion && completedThreadId && completedTurnId
        ? this.providerRuns.get(
            this.providerRunKey(completedThreadId, completedTurnId),
          )
        : undefined;
    if (oldRun?.settled) {
      // Known settled roots reconcile without touching a newer active buffer.
      // Unregistered tuples retain the descriptorless baseline path below.
      const mappedLateItem = mapThreadItem(item);
      if (mappedLateItem) {
        void this.onEvent({
          type: 'codex',
          event: withRouting(
            { type: 'item.completed', item: mappedLateItem },
            this.buildRouting(completedThreadId, completedTurnId),
          ),
        });
      }
      return;
    }

    if (this.hasSyntheticDynamicToolFailure(params, item)) return;
    const completedCallId = readString(item, 'id');
    if (
      completedThreadId &&
      completedTurnId &&
      completedCallId &&
      readString(item, 'type') === 'dynamicToolCall'
    ) {
      this.stoppedDynamicToolCalls.delete(
        this.dynamicToolKey(
          completedThreadId,
          completedTurnId,
          completedCallId,
        ),
      );
    }

    const mappedItem = mapThreadItem(item);
    const nativeCallId = readString(item, 'id');
    const pendingReceipt = nativeCallId
      ? this.pendingNativeDynamicResults.get(nativeCallId)
      : undefined;
    if (
      pendingReceipt &&
      (readString(params, 'threadId') !== pendingReceipt.threadId ||
        readString(params, 'turnId') !== pendingReceipt.turnId)
    )
      return;
    if (
      nativeCallId &&
      pendingReceipt &&
      readString(item, 'type') === 'dynamicToolCall' &&
      readString(params, 'threadId') === pendingReceipt.threadId &&
      readString(params, 'turnId') === pendingReceipt.turnId
    ) {
      this.pendingNativeDynamicResults.delete(nativeCallId);
      this.onDynamicToolResultAccepted?.({
        callId: nativeCallId,
        ...pendingReceipt,
      });
    }
    if (!mappedItem) {
      this.completeDeferredToolsResultDelivery(item);
      return;
    }
    const turn = this.activeTurn;
    const itemId = readString(item, 'id');
    const eventThreadId = readString(params, 'threadId');
    const eventTurnId = readString(params, 'turnId');
    const mapped =
      turn && itemId
        ? mergeCompletedDeferredItem(turn.items.get(itemId), mappedItem)
        : mappedItem;
    if (turn && itemId) {
      turn.items.set(itemId, mapped);
      captureItemRouting(turn, itemId, eventThreadId, eventTurnId);
    }
    const itemForEmission = isDeferredChatItem(mapped)
      ? normalizedDeferredCompletionItem(mapped)
      : mapped;
    if (
      turn &&
      isRootCompletion &&
      mapped.type === 'agent_message' &&
      itemForEmission
    ) {
      turn.latestAgentMessage = readString(itemForEmission, 'text') ?? '';
    }
    if (turn && isRootCompletion && mapped.type === 'plan') {
      turn.latestPlanText = readString(mapped, 'text') ?? '';
    }
    const routing = this.buildRouting(eventThreadId, eventTurnId);
    if (turn) {
      if (itemForEmission) {
        emitCodexItemCompleted(this.onEvent, turn, itemForEmission, routing);
      }
      this.maybeHydrateCollabAgentThreads(mapped);
      this.completeDeferredToolsResultDelivery(item);
      return;
    }
    if (itemForEmission) {
      void this.onEvent({
        type: 'codex',
        event: withRouting(
          { type: 'item.completed', item: itemForEmission },
          routing,
        ),
      });
    }
    this.maybeHydrateCollabAgentThreads(mapped);
    this.completeDeferredToolsResultDelivery(item);
  }

  private completeDeferredToolsResultDelivery(
    item: Record<string, unknown>,
  ): void {
    if (readString(item, 'type') !== 'dynamicToolCall') {
      return;
    }
    const itemId = readString(item, 'id');
    if (itemId && this.pendingImmediateTurnRestartResultIds.delete(itemId)) {
      const originatingTurn = this.activeTurn;
      const originatingThreadId = originatingTurn?.rootThreadId;
      const originatingTurnId = originatingTurn?.turnId;
      void new Promise<void>((resolve) => {
        setTimeout(resolve, DEFERRED_TOOLS_CODE_MODE_DRAIN_MS);
      })
        .then(async () => {
          if (
            this.disposed ||
            !originatingTurn ||
            !originatingThreadId ||
            !originatingTurnId ||
            this.activeTurn !== originatingTurn ||
            originatingTurn.rootThreadId !== originatingThreadId ||
            originatingTurn.turnId !== originatingTurnId ||
            originatingTurn.userInterruptAcknowledged
          ) {
            return;
          }
          const request: ImmediateTurnRestartRequest = {
            turn: originatingTurn,
            threadId: originatingThreadId,
            turnId: originatingTurnId,
          };
          this.immediateTurnRestartRequest = request;
          await this.interruptTurn({ userInitiated: false });
        })
        .catch(() => {
          if (this.immediateTurnRestartRequest?.turn === originatingTurn) {
            this.immediateTurnRestartRequest = null;
          }
        });
    }
    if (!itemId || !this.pendingDeferredToolResultIds.delete(itemId)) {
      return;
    }
    void new Promise<void>((resolve) => {
      setTimeout(resolve, DEFERRED_TOOLS_CODE_MODE_DRAIN_MS);
    })
      .then(() => {
        if (this.disposed) {
          return;
        }
        const shouldInterrupt =
          deferredToolsReloadCoordinator.markToolResultDelivered(
            {
              projectId: this.projectId,
              worktreeId: this.worktreeId,
              chatId: this.chatId,
            },
            `codex-${itemId}`,
          );
        if (!shouldInterrupt) {
          return;
        }
        return this.interruptTurn({ userInitiated: false });
      })
      .catch(() => undefined);
  }

  private handleCommandExecutionOutputDeltaNotification(
    params: Record<string, unknown>,
  ): void {
    const turn = this.activeTurn;
    const eventThreadId = readString(params, 'threadId');
    const turnId = readString(params, 'turnId');
    const itemId = readString(params, 'itemId');
    const delta = readString(params, 'delta');
    if (!itemId || typeof delta !== 'string') {
      return;
    }

    const isRootEvent = !eventThreadId || eventThreadId === this.threadId;
    if (!turn) {
      if (isRootEvent) {
        this.recordRootRunDrop(
          'item/commandExecution/outputDelta',
          'no_active_turn',
          eventThreadId ?? this.threadId,
          turnId,
          itemId,
        );
      }
      return;
    }
    if (isRootEvent && turn.turnId && turnId !== turn.turnId) {
      this.recordRootRunDrop(
        'item/commandExecution/outputDelta',
        'turn_id_mismatch',
        eventThreadId ?? this.threadId,
        turnId,
        itemId,
      );
      return;
    }

    captureItemRouting(turn, itemId, eventThreadId, turnId);

    const existing = turn.items.get(itemId) ?? {
      type: 'command_execution',
      id: itemId,
      command: '',
      aggregated_output: '',
      status: 'in_progress',
      exit_code: null,
    };
    if (readString(existing, 'type') !== 'command_execution') {
      return;
    }

    const output = readString(existing, 'aggregated_output') ?? '';
    const updated = {
      ...existing,
      aggregated_output: appendCodexCommandOutput(output, delta),
    };
    turn.items.set(itemId, updated);
    const now = Date.now();
    if (
      !shouldEmitCodexCommandOutputUpdate(
        turn,
        itemId,
        updated.aggregated_output,
        now,
      )
    ) {
      return;
    }
    emitCodexCommandOutputUpdate(
      this.onEvent,
      turn,
      updated,
      typeof eventThreadId === 'string'
        ? { thread_id: eventThreadId, turn_id: turnId }
        : undefined,
      now,
    );
  }

  private handleMcpToolCallProgressNotification(
    params: Record<string, unknown>,
  ): void {
    const turn = this.activeTurn;
    const itemId = readString(params, 'itemId');
    const message = readString(params, 'message');
    if (!turn || !itemId || message === undefined) {
      return;
    }

    const existing = turn.items.get(itemId);
    if (!existing || readString(existing, 'type') !== 'mcp_tool_call') {
      return;
    }

    const eventThreadId = readString(params, 'threadId');
    const eventTurnId = readString(params, 'turnId');
    const updated = { ...existing, progress: message };
    turn.items.set(itemId, updated);
    captureItemRouting(turn, itemId, eventThreadId, eventTurnId);
    void this.onEvent({
      type: 'codex',
      event: withRouting(
        { type: 'item.updated', item: updated },
        this.buildRouting(eventThreadId, eventTurnId),
      ),
    });
  }

  private handleTokenUsageUpdatedNotification(
    params: Record<string, unknown>,
  ): void {
    const turn = this.activeTurn;
    const eventThreadId = readString(params, 'threadId');
    const eventTurnId = readString(params, 'turnId');
    if (!eventThreadId) {
      return;
    }
    const tokenUsage = readRecord(params, 'tokenUsage');
    const lastUsage = tokenUsage ? readRecord(tokenUsage, 'last') : null;
    if (!lastUsage) {
      return;
    }
    const totalUsage = tokenUsage ? readRecord(tokenUsage, 'total') : null;

    if (eventThreadId !== this.threadId) {
      // App-server notifications are normally owner-routed by the connection,
      // but keep direct routing fail-closed too: only child threads this owner
      // explicitly registered may produce a subagent usage event.
      if (
        !this.registeredSubagentThreadIds.has(eventThreadId) ||
        !eventTurnId ||
        !totalUsage
      ) {
        return;
      }
      void this.onEvent({
        type: 'codex',
        event: {
          type: 'thread.subagent_token_usage.updated',
          thread_id: eventThreadId,
          turn_id: eventTurnId,
          total: projectCodexSubagentUsageBreakdown(totalUsage),
          last: projectCodexSubagentUsageBreakdown(lastUsage),
        },
      });
      return;
    }

    const latestUsage = readCodexTurnUsage(lastUsage);
    const cumulativeUsage = readCodexTurnUsage(totalUsage);
    const belongsToActiveTurn =
      !!turn && !!turn.turnId && !!eventTurnId && eventTurnId === turn.turnId;

    // Keep the whole provider-turn breakdown for turn.completed/turn.failed
    // accounting. Codex `last` is one upstream response completion, not the
    // whole turn, so advance from the cumulative thread snapshot when possible.
    // A restored thread can emit this notification before a turn is active,
    // so context-window propagation must not depend on this branch.
    if (turn && belongsToActiveTurn && latestUsage) {
      if (cumulativeUsage && turn.latestCumulativeUsage) {
        const delta = codexCumulativeUsageDelta(
          cumulativeUsage,
          turn.latestCumulativeUsage,
        );
        turn.usage = addCodexTurnUsage(turn.usage, delta ?? latestUsage);
      } else if (cumulativeUsage) {
        turn.usage = addCodexTurnUsage(turn.usage, latestUsage);
      } else {
        turn.usage = latestUsage;
      }
      turn.latestCumulativeUsage = cumulativeUsage;
    }

    const contextTokens = readNumber(lastUsage, 'totalTokens');
    const contextWindow = tokenUsage
      ? readNumber(tokenUsage, 'modelContextWindow')
      : undefined;
    const hasValidContext =
      contextTokens !== undefined &&
      Number.isFinite(contextTokens) &&
      contextTokens > 0 &&
      contextWindow !== undefined &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0;
    if (!latestUsage && !cumulativeUsage && !hasValidContext) {
      return;
    }

    void this.onEvent({
      type: 'codex',
      event: withRouting(
        {
          type: 'thread.token_usage.updated',
          usage: {
            ...(hasValidContext
              ? {
                  context_tokens: contextTokens,
                  context_window: contextWindow,
                }
              : {}),
            ...(belongsToActiveTurn ? (latestUsage ?? {}) : {}),
            ...(belongsToActiveTurn && cumulativeUsage
              ? {
                  cumulative_input_tokens: cumulativeUsage.input_tokens,
                  cumulative_cached_input_tokens:
                    cumulativeUsage.cached_input_tokens,
                  cumulative_output_tokens: cumulativeUsage.output_tokens,
                  cumulative_reasoning_output_tokens:
                    cumulativeUsage.reasoning_output_tokens,
                }
              : {}),
          },
        },
        this.buildRouting(eventThreadId, eventTurnId),
      ),
    });
  }

  private handleTurnPlanUpdatedNotification(
    params: Record<string, unknown>,
  ): void {
    void this.onEvent({
      type: 'codex',
      event: {
        type: 'turn.plan.updated',
        explanation: readString(params, 'explanation'),
        plan: parsePlanSteps(params.plan),
      },
    });
  }

  private ingestCompletedTurnItems(
    turn: CodexTurnItemBuffer,
    completedTurn: Record<string, unknown>,
    routing: CodexItemRouting | undefined,
    isRootCompletion: boolean,
    shouldEmitCompletedItems: boolean,
  ): void {
    if (!Array.isArray(completedTurn.items)) {
      return;
    }

    for (const itemValue of completedTurn.items) {
      if (!isRecord(itemValue)) {
        continue;
      }

      this.observeSteeringInputPickup(
        itemValue,
        routing?.thread_id,
        routing?.turn_id,
      );

      const mappedItem = mapThreadItem(itemValue);
      if (!mappedItem) {
        continue;
      }

      const itemId = readString(mappedItem, 'id');
      if (!itemId) {
        continue;
      }

      const mapped = mergeCompletedDeferredItem(
        turn.items.get(itemId),
        mappedItem,
      );
      turn.items.set(itemId, mapped);
      captureItemRouting(turn, itemId, routing?.thread_id, routing?.turn_id);

      const itemForEmission = isDeferredChatItem(mapped)
        ? normalizedDeferredCompletionItem(mapped)
        : mapped;

      if (
        isRootCompletion &&
        mapped.type === 'agent_message' &&
        itemForEmission
      ) {
        turn.latestAgentMessage = readString(itemForEmission, 'text') ?? '';
      }
      if (isRootCompletion && mapped.type === 'plan') {
        turn.latestPlanText = readString(mapped, 'text') ?? '';
      }

      this.maybeHydrateCollabAgentThreads(mapped);
      if (!shouldEmitCompletedItems) {
        continue;
      }

      const itemRouting = turn.itemRoutings.get(itemId) ?? routing;
      if (isDeferredChatItem(mapped)) {
        if (itemForEmission) {
          emitCodexItemCompleted(
            this.onEvent,
            turn,
            itemForEmission,
            itemRouting,
          );
        }
        continue;
      }

      emitCodexItemCompleted(this.onEvent, turn, mapped, itemRouting);
    }
  }

  private handleSubagentTurnCompletedNotification(
    eventThreadId: string,
    completedTurnId: string | undefined,
    status: string,
    errorMessage: string | undefined,
    codexErrorInfo: CodexErrorInfo | undefined,
  ): void {
    if (status === 'failed') {
      void this.onEvent({
        type: 'codex',
        event: withRouting(
          {
            type: 'turn.failed',
            error: this.withUsageLimitResetsAt({
              message: errorMessage ?? 'Codex turn failed',
              ...(codexErrorInfo ? { codexErrorInfo } : {}),
            }),
          },
          {
            thread_id: eventThreadId,
            ...(completedTurnId ? { turn_id: completedTurnId } : {}),
          },
        ),
      });
      return;
    }

    void this.onEvent({
      type: 'codex',
      event: withRouting(
        {
          type: 'turn.completed',
          status: status === 'interrupted' ? 'interrupted' : 'completed',
        },
        {
          thread_id: eventThreadId,
          ...(completedTurnId ? { turn_id: completedTurnId } : {}),
        },
      ),
    });
  }

  private handleRootTurnCompletedNotification(
    turn: CodexTurnState,
    completedTurn: Record<string, unknown>,
    eventThreadId: string | undefined,
    completedTurnId: string | undefined,
    status: string,
    errorMessage: string | undefined,
    codexErrorInfo: CodexErrorInfo | undefined,
  ): void {
    if (completedTurnId) {
      this.lastKnownTurnId = completedTurnId;
      const completedKey = this.providerRunKey(
        turn.rootThreadId,
        completedTurnId,
      );
      this.resumedLiveRootAnchors.delete(completedKey);
      this.completedResumeTurnKeys.add(completedKey);
      forgetRetainedRootExecutionAnchor(
        this.retainedRootExecutionAnchorKey(turn.rootThreadId, completedTurnId),
      );
    }
    if (
      completedTurnId &&
      (eventThreadId === undefined || eventThreadId === turn.rootThreadId)
    ) {
      const lifecycleStatus =
        status === 'failed'
          ? 'failed'
          : status === 'interrupted'
            ? 'interrupted'
            : 'completed';
      this.emitTurnLifecycleObservation({
        type: 'turn-completed',
        threadId: turn.rootThreadId,
        turnId: completedTurnId,
        status: lifecycleStatus,
        ...readNativeTurnCompletionTiming(completedTurn),
        ...(lifecycleStatus === 'failed' && errorMessage
          ? { error: errorMessage }
          : {}),
      });
    }
    if (status === 'completed') {
      emitPendingDeferredCompletions(this.onEvent, turn);
    }

    this.settledTurnItems = retainCodexTurnItems(turn);
    this.activeTurn = null;
    this.onSteeringEligibilityChanged?.();
    const rootRouting = this.buildRouting(eventThreadId, completedTurnId);

    if (status === 'failed') {
      void this.onEvent({
        type: 'codex',
        event: withRouting(
          {
            type: 'turn.failed',
            error: this.withUsageLimitResetsAt({
              message: errorMessage ?? 'Codex turn failed',
              ...(codexErrorInfo ? { codexErrorInfo } : {}),
            }),
            ...(turn.usage ? { usage: turn.usage } : {}),
          },
          rootRouting,
        ),
      });
      this.resolveTurnAfterNotificationAdmissions(turn, {
        status: 'failed',
        usage: turn.usage,
        error: errorMessage ?? 'Codex turn failed',
        ...(codexErrorInfo ? { codexErrorInfo } : {}),
      });
      return;
    }

    const isInterrupted = status === 'interrupted';
    const restartRequest = this.immediateTurnRestartRequest;
    const suppressCompletion =
      isInterrupted &&
      restartRequest?.turn === turn &&
      restartRequest.threadId === turn.rootThreadId &&
      restartRequest.turnId === turn.turnId &&
      !turn.userInterruptAcknowledged;
    if (!suppressCompletion) {
      void this.onEvent({
        type: 'codex',
        event: withRouting(
          {
            type: 'turn.completed',
            status: isInterrupted ? 'interrupted' : 'completed',
            ...(turn.usage ? { usage: turn.usage } : {}),
          },
          rootRouting,
        ),
      });
    }
    this.resolveTurnAfterNotificationAdmissions(turn, {
      status: isInterrupted ? 'interrupted' : 'completed',
      usage: turn.usage,
      proposedPlanText: isInterrupted
        ? undefined
        : extractCompletedProposedPlan(turn),
    });
  }

  private resolveTurnAfterNotificationAdmissions(
    turn: CodexTurnState,
    result: CodexTurnResult,
  ): void {
    const admissions = this.notificationAdmissions?.slice() ?? [];
    if (admissions.length === 0) {
      turn.resolve(result);
      return;
    }
    const token: {
      owner: CodexAppServerClient | null;
      turn: CodexTurnState | null;
      result: CodexTurnResult | null;
    } = { owner: this, turn, result };
    this.pendingTerminalSettlements.add(token);
    // The notification callback acknowledges routing admission, not durable
    // commit. Turn lifecycle still drains accepted events separately.
    void Promise.all(admissions).then(
      () => token.owner?.settlePendingTerminal(token, false),
      (error: unknown) =>
        token.owner?.settlePendingTerminal(token, true, error),
    );
  }

  private settlePendingTerminal(
    token: {
      owner: CodexAppServerClient | null;
      turn: CodexTurnState | null;
      result: CodexTurnResult | null;
    },
    failed: boolean,
    error?: unknown,
  ): void {
    if (!this.pendingTerminalSettlements.delete(token)) return;
    const { turn, result } = token;
    token.owner = null;
    token.turn = null;
    token.result = null;
    if (!turn || !result) return;
    if (failed) {
      turn.reject(error instanceof Error ? error : new Error(String(error)));
    } else {
      turn.resolve(result);
    }
  }

  private rejectPendingTerminalSettlements(error: Error): void {
    for (const token of Array.from(this.pendingTerminalSettlements)) {
      const turn = token.turn;
      token.owner = null;
      token.turn = null;
      token.result = null;
      turn?.reject(error);
    }
    this.pendingTerminalSettlements.clear();
  }

  private settleOutsideNotificationAdmission(
    token: {
      owner: CodexAppServerClient | null;
      turn: CodexTurnState | null;
      rejectTurn: ((error: Error) => void) | null;
      generation: number;
    },
    failed: boolean,
    error?: unknown,
  ): void {
    if (!this.outsideNotificationAdmissions.delete(token)) return;
    const { turn, generation } = token;
    token.owner = null;
    token.turn = null;
    const rejectTurn = token.rejectTurn;
    token.rejectTurn = null;
    if (!failed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    if (turn && this.activeTurn !== turn) {
      rejectTurn?.(failure);
      return;
    }
    if (this.turnStartGeneration !== generation) {
      rejectTurn?.(failure);
      return;
    }
    if (this.pendingTurnStartGeneration === generation) {
      this.cancelPendingTurnStart(failure);
    } else if (this.activeTurn) {
      this.rejectActiveTurn(failure);
    }
  }

  private detachOutsideNotificationAdmissions(
    currentGeneration?: number,
  ): void {
    for (const token of Array.from(this.outsideNotificationAdmissions)) {
      if (
        currentGeneration !== undefined &&
        token.generation === currentGeneration
      ) {
        continue;
      }
      token.owner = null;
      token.turn = null;
      this.outsideNotificationAdmissions.delete(token);
    }
  }

  private handleTurnCompletedNotification(
    params: Record<string, unknown>,
  ): void {
    const completedTurn = readRecord(params, 'turn');
    if (!completedTurn) {
      return;
    }

    const completedTurnId = readString(completedTurn, 'id');
    const eventThreadId = readString(params, 'threadId');
    const status = readString(completedTurn, 'status') ?? 'completed';
    const error = readRecord(completedTurn, 'error');
    let errorMessage = error ? readString(error, 'message') : undefined;
    let codexErrorInfo = error
      ? parseCodexErrorInfo(error.codexErrorInfo)
      : undefined;
    const turn = this.activeTurn;

    if (eventThreadId && eventThreadId !== this.threadId) {
      const subagentRouting: CodexItemRouting = {
        thread_id: eventThreadId,
        ...(completedTurnId ? { turn_id: completedTurnId } : {}),
      };
      const itemBuffer = turn ?? this.settledTurnItems;
      if (itemBuffer) {
        this.ingestCompletedTurnItems(
          itemBuffer,
          completedTurn,
          subagentRouting,
          false,
          status === 'completed',
        );
        emitPendingCodexCommandOutputUpdates(this.onEvent, itemBuffer);
      }
      this.handleSubagentTurnCompletedNotification(
        eventThreadId,
        completedTurnId,
        status,
        errorMessage,
        codexErrorInfo,
      );
      return;
    }

    if (!turn) {
      this.recordRootRunDrop(
        'turn/completed',
        'no_active_turn',
        eventThreadId ?? this.threadId,
        completedTurnId,
      );
      return;
    }

    if (
      !completedTurnId &&
      !(status === 'interrupted' && turn.userInterruptAcknowledged)
    ) {
      this.recordRootRunDrop(
        'turn/completed',
        'unobserved_root_terminal',
        eventThreadId ?? this.threadId,
        completedTurnId,
      );
      return;
    }

    const completedRun = completedTurnId
      ? this.providerRuns.get(
          this.providerRunKey(
            eventThreadId ?? turn.rootThreadId,
            completedTurnId,
          ),
        )
      : undefined;
    if (completedRun?.settled) {
      this.recordRootRunDrop(
        'turn/completed',
        'run_already_settled',
        eventThreadId ?? turn.rootThreadId,
        completedTurnId,
      );
      return;
    }
    // A dispatched request already owns this slot. Its start response and
    // terminal can arrive in one read before the response continuation runs;
    // preserve baseline acceptance and bind that terminal's native ID. A
    // provider-owned run, unlike a dispatch, requires its observed start.
    if (
      (turn.turnId && completedTurnId !== turn.turnId) ||
      (turn.providerOwned &&
        (!turn.turnId ||
          !completedTurnId ||
          eventThreadId !== turn.rootThreadId))
    ) {
      this.recordRootRunDrop(
        'turn/completed',
        !turn.turnId || !completedTurnId
          ? 'unobserved_root_terminal'
          : 'turn_id_mismatch',
        eventThreadId ?? this.threadId,
        completedTurnId,
      );
      return;
    }
    if (!turn.providerOwned && !turn.turnId && completedTurnId) {
      this.bindStartIdentity(turn, completedTurnId);
      this.registerProviderRunForTurn(turn, completedTurnId, 'dispatched');
    }
    if (
      status === 'failed' &&
      turn.fatalRootError?.threadId === turn.rootThreadId &&
      turn.fatalRootError.turnId === completedTurnId
    ) {
      errorMessage = turn.fatalRootError.message;
      codexErrorInfo = turn.fatalRootError.codexErrorInfo ?? codexErrorInfo;
    }
    const runState = this.providerRuns.get(
      this.providerRunKey(turn.rootThreadId, turn.turnId),
    );
    if (runState?.settled) {
      this.recordRootRunDrop(
        'turn/completed',
        'run_already_settled',
        eventThreadId,
        completedTurnId,
      );
      return;
    }

    const rootRouting = this.buildRouting(eventThreadId, completedTurnId);
    this.ingestCompletedTurnItems(
      turn,
      completedTurn,
      rootRouting,
      true,
      status === 'completed',
    );
    emitPendingCodexCommandOutputUpdates(this.onEvent, turn);

    this.handleRootTurnCompletedNotification(
      turn,
      completedTurn,
      eventThreadId,
      completedTurnId,
      status,
      errorMessage,
      codexErrorInfo,
    );
    this.settleProviderRunForTurn(turn);
  }

  private handleErrorNotification(params: Record<string, unknown>): void {
    const willRetry = readBoolean(params, 'willRetry') === true;
    if (willRetry) {
      return;
    }

    const error = readRecord(params, 'error');
    const message = error ? buildTurnErrorMessage(error) : undefined;
    const codexErrorInfo = error
      ? parseCodexErrorInfo(error.codexErrorInfo)
      : undefined;
    if (!message) {
      return;
    }
    const eventTurnId = readString(params, 'turnId');
    const eventThreadId = readString(params, 'threadId');
    const isRootError = !eventThreadId || eventThreadId === this.threadId;
    if (isRootError) {
      // Root errors are provisional control evidence. The connection-frame
      // handler captures matching details and waits for turn/completed.
      return;
    }

    void this.onEvent({
      type: 'codex',
      event: withRouting(
        // The reducer reads `resetsAt` off the `error` event itself.
        this.withUsageLimitResetsAt({
          type: 'error',
          message,
          ...(codexErrorInfo ? { codexErrorInfo } : {}),
        }),
        typeof eventThreadId === 'string'
          ? { thread_id: eventThreadId, turn_id: eventTurnId }
          : undefined,
      ),
    });
  }

  private handleAccountUpdatedNotification(
    params: Record<string, unknown>,
  ): void {
    const notification: AccountUpdatedNotification = {
      authMode: parseAuthMode(readString(params, 'authMode')),
      planType: parsePlanType(readString(params, 'planType')),
    };
    for (const listener of Array.from(this.accountUpdatedListeners)) {
      listener(notification);
    }
  }

  private handleAccountRateLimitsUpdatedNotification(
    params: Record<string, unknown>,
  ): void {
    const rateLimits = parseRateLimitSnapshot(params.rateLimits);
    if (!rateLimits) {
      return;
    }
    const notification: AccountRateLimitsUpdatedNotification = {
      rateLimits,
    };
    for (const listener of Array.from(this.rateLimitsUpdatedListeners)) {
      listener(notification);
    }
    this.maybeEmitRateLimitReached(rateLimits);
  }

  /**
   * Proactively surface a usage-limit fallback signal (CAN-838, B2) when the
   * Codex app-server reports that the account has reached a rate/usage limit,
   * before a turn hard-fails. Emits a synthetic `rate_limit.reached` codex
   * event (carrying the reset time) that the renderer turns into the AI Credits
   * fallback banner without appending a transcript message. De-duped so the
   * same reached-window is only surfaced once; cleared when no longer reached.
   */
  private maybeEmitRateLimitReached(snapshot: RateLimitSnapshot): void {
    const reached = deriveRateLimitReached(snapshot);
    // Updated before the de-dupe return so a repeat snapshot still refreshes
    // the reset time attached to a later usage-limit failure.
    this.updateReachedRateLimitResetsAt(snapshot, reached);
    if (!reached) {
      this.lastEmittedRateLimitReachedKey = null;
      return;
    }
    const key = `${reached.reachedType}:${reached.resetsAt ?? ''}`;
    if (key === this.lastEmittedRateLimitReachedKey) {
      return;
    }
    this.lastEmittedRateLimitReachedKey = key;
    void this.onEvent({
      type: 'codex',
      event: withRouting(
        {
          type: 'rate_limit.reached',
          reachedType: reached.reachedType,
          ...(reached.resetsAt !== null ? { resetsAt: reached.resetsAt } : {}),
        },
        this.threadId ? { thread_id: this.threadId } : undefined,
      ),
    });
  }

  /**
   * Cache the reset time a usage-limit failure should carry. Quota returns
   * once every exhausted window resets, so this prefers the latest reset among
   * windows at 100%, not the earliest window. Rolling updates are sparse and a
   * missing reached type does not clear a previously observed value, so the
   * cache clears only when the snapshot shows no exhausted window.
   */
  private updateReachedRateLimitResetsAt(
    snapshot: RateLimitSnapshot,
    reached: { resetsAt: number | null } | null,
  ): void {
    const windows = [snapshot.primary, snapshot.secondary].filter(
      (window) => window !== null,
    );
    const exhaustedResets = windows
      .filter((window) => window.usedPercent >= 100)
      .map((window) => window.resetsAt)
      .filter((value): value is number => typeof value === 'number');
    if (!reached) {
      if (windows.length > 0 && exhaustedResets.length === 0) {
        this.lastReachedRateLimitResetsAtMs = null;
      }
      return;
    }
    const resetsAt =
      exhaustedResets.length > 0
        ? Math.max(...exhaustedResets)
        : reached.resetsAt;
    this.lastReachedRateLimitResetsAtMs =
      resetsAt === null ? null : (normalizeEpochMs(resetsAt) ?? null);
  }

  /**
   * Attach the cached reached reset time (epoch ms) to a usage-limit failure,
   * while it is still in the future. Other failures pass through unchanged.
   */
  private withUsageLimitResetsAt<
    T extends { message: string; codexErrorInfo?: CodexErrorInfo },
  >(error: T): T | (T & { resetsAt: number }) {
    const resetsAt = this.lastReachedRateLimitResetsAtMs;
    if (
      error.codexErrorInfo !== 'usageLimitExceeded' ||
      resetsAt === null ||
      resetsAt <= Date.now()
    ) {
      return error;
    }
    return { ...error, resetsAt };
  }

  // A turn whose terminal frame was read (`controlPhase`) stays active here
  // until its transcript is finalized. The connection reads these to decide
  // when it may suspend, evict or restart the shared worker, which would drop
  // the transcript frames still waiting for admission. Only steering closes
  // at the terminal read.
  hasActiveTurn(): boolean {
    return this.activeTurn !== null || this.pendingTurnStartGeneration !== null;
  }

  hasLiveBackgroundWork(): boolean {
    return this.backgroundWorkRegistry.hasLiveWork();
  }

  getBackgroundSnapshot(): CodexBackgroundSnapshot {
    return this.backgroundWorkRegistry.snapshot();
  }

  subscribeBackgroundWork(
    listener: (snapshot: CodexBackgroundSnapshot) => void,
  ): () => void {
    return this.backgroundWorkRegistry.subscribe(listener);
  }

  getExecutionUserMessageId(): string | undefined {
    return (
      this.activeTurn?.executionUserMessageId ?? this.lastExecutionUserMessageId
    );
  }

  hasProviderOwnedTurn(): boolean {
    return this.activeTurn?.providerOwned === true;
  }

  hasDispatchedTurn(): boolean {
    return (
      this.activeTurn !== null ||
      (this.pendingTurnStartGeneration !== null &&
        this.dispatchedTurnStartGeneration === this.pendingTurnStartGeneration)
    );
  }

  getActiveTurnInterruptTarget(): {
    threadId: string;
    turnId: string | null;
  } | null {
    const turn = this.activeTurn;
    if (!turn || !this.threadId) {
      return null;
    }
    return {
      threadId: this.threadId,
      turnId: turn.turnId || null,
    };
  }

  rejectActiveTurn(
    error: Error,
    expectedRecovery?: Promise<CodexProcessRecoveryResult>,
  ): void {
    const turn = this.activeTurn;
    if (expectedRecovery && turn?.recoveryPromise !== expectedRecovery) {
      return;
    }
    this.abortDynamicToolCalls();
    this.closeStoppedDynamicToolRows();
    if (turn) this.settleProviderRunForTurn(turn);
    if (!expectedRecovery) this.rejectPendingTerminalSettlements(error);
    this.activeTurn = null;
    this.onSteeringEligibilityChanged?.();
    if (turn) {
      turn.reject(error);
    }
  }

  cancelPendingTurnStart(error: Error): void {
    const generation = this.pendingTurnStartGeneration;
    if (generation === null) {
      return;
    }
    this.turnStartCancellation = { generation, error };
    this.pendingTurnStartGeneration = null;
    if (this.pendingTurnStartAbort?.generation === generation) {
      this.pendingTurnStartAbort.controller.abort(error);
    }
  }

  markProcessSuspended(): void {
    this.markProcessUnavailable();
  }

  private markProcessUnavailable(): void {
    this.threadSetupGeneration += 1;
    this.threadReady = false;
    this.mcpStartupStates.clear();
    this.retireProviderRunGeneration(true);
  }

  markProcessFailed(): void {
    this.abortDynamicToolCalls();
    this.closeStoppedDynamicToolRows();
    this.retireBackgroundWorkEpoch();
    this.rejectPendingTerminalSettlements(
      new Error('Codex app-server exited before terminal event admission'),
    );
    this.detachOutsideNotificationAdmissions();
    this.markProcessUnavailable();
    this.hydratedSubagentThreadIds.clear();
  }

  cancelPendingServerRequestsForRecovery(): void {
    for (const controller of Array.from(this.pendingRecoveryAbortControllers)) {
      controller.abort();
    }
  }

  recoverAfterUnexpectedProcessExit(
    processError: CodexRecoverableProcessExitError,
  ): Promise<CodexProcessRecoveryResult> {
    const active = this.activeTurn;
    if (!active) {
      return this.connection
        .ensureInitialized()
        .then((): CodexProcessRecoveryResult => ({ strategy: 'restarted' }));
    }
    if (active.hostOwnsAdmission) {
      this.rejectActiveTurn(processError);
      return Promise.reject(processError);
    }
    if (active.recoveryPromise) {
      return active.recoveryPromise;
    }
    const recovery = this.recoverActiveTurn(active, processError);
    active.recoveryPromise = recovery;
    const clearRecovery = (): void => {
      if (active.recoveryPromise === recovery)
        active.recoveryPromise = undefined;
    };
    void recovery.then(clearRecovery, () => {});
    return recovery;
  }

  private async recoverActiveTurn(
    active: CodexTurnState,
    processError: CodexRecoverableProcessExitError,
  ): Promise<CodexProcessRecoveryResult> {
    let lastError: unknown = processError;
    let transportFailures = 0;
    let emptyResumeConfirmations = 0;
    let recoveryCheck = 0;
    while (transportFailures < CODEX_PROCESS_RECOVERY_MAX_ATTEMPTS) {
      const delayIndex = Math.min(
        recoveryCheck,
        CODEX_PROCESS_RECOVERY_RETRY_DELAYS_MS.length - 1,
      );
      recoveryCheck += 1;
      await recoveryDelay(
        CODEX_PROCESS_RECOVERY_RETRY_DELAYS_MS[delayIndex] ?? 0,
      );
      this.assertNotDisposed();
      if (this.activeTurn !== active) {
        throw new Error('Codex turn ended while process recovery was pending');
      }

      try {
        await this.connection.ensureInitialized();
        if (this.activeTurn === active && active.turnId) {
          this.registerProviderRunForTurn(
            active,
            active.turnId,
            active.providerOwned ? 'provider_owned' : 'dispatched',
          );
        }
        const setupGeneration = this.threadSetupGeneration;
        this.connection.registerRootThread(active.rootThreadId);
        const resumeConfig = buildThreadConfig(
          {
            threadConfig: this.threadConfig,
            mcpServersConfig: this.mcpServersConfig,
            multiAgentEnabled: this.multiAgentEnabled,
            maxConcurrentSubagents: this.maxConcurrentSubagents,
          },
          { includeSelectedMcpServers: true },
        );
        const response = await this.request('thread/resume', {
          threadId: active.rootThreadId,
          cwd: active.startParams?.cwd ?? this.cwd,
          approvalPolicy: codexApprovalPolicyFor(this.approvalMode),
          sandbox: codexSandboxModeFor(this.approvalMode),
          ...(active.startParams?.serviceTier
            ? {
                // Recovery resume is lifecycle metadata; the continuation
                // `turn/start` below replays the exact admitted tier.
                serviceTier:
                  active.startParams.serviceTier === 'ultrafast'
                    ? 'default'
                    : active.startParams.serviceTier,
              }
            : {}),
          ...(active.startParams?.model
            ? { model: active.startParams.model }
            : {}),
          ...(resumeConfig ? { config: resumeConfig } : {}),
          ...(this.developerInstructions
            ? { developerInstructions: this.developerInstructions }
            : {}),
        });
        this.assertTurnStillRecovering(active);
        if (setupGeneration !== this.threadSetupGeneration) {
          throw new Error(
            'Codex thread closed or worker changed during recovery',
          );
        }
        const turns = extractThreadTurns(response);
        const recoveredTurn = findRecoveredThreadTurn(
          turns,
          active.turnId,
          active.previousTurnId,
        );
        const recoveredTurnId = recoveredTurn
          ? readString(recoveredTurn, 'id')
          : undefined;
        const recoveredTurnStatus = recoveredTurn
          ? readString(recoveredTurn, 'status')
          : undefined;
        const recoveryMcpServerNames = enabledCodexMcpServerNames({
          mcp_servers: this.mcpServersConfig ?? {},
        });
        if (recoveredTurnId) {
          active.turnId = recoveredTurnId;
          this.onSteeringEligibilityChanged?.();
          this.lastKnownTurnId = recoveredTurnId;
        }
        if (recoveredTurn && recoveredTurnStatus === 'completed') {
          this.mcpStartupStates.delete(active.rootThreadId);
          this.threadReady = recoveryMcpServerNames.length === 0;
          if (active.startParams) {
            this.recordAppliedCollaborationMode(active.startParams);
          }
          this.handleTurnCompletedNotification({
            threadId: active.rootThreadId,
            turn: recoveredTurn,
          });
          return { strategy: 'reconciled' };
        }
        if (this.reconcileUserInterruptDuringRecovery(active, recoveredTurn)) {
          this.mcpStartupStates.delete(active.rootThreadId);
          this.threadReady = recoveryMcpServerNames.length === 0;
          return { strategy: 'reconciled' };
        }
        try {
          await waitForCodexMcpServers({
            threadId: active.rootThreadId,
            serverNames: recoveryMcpServerNames,
            request: (params) => this.request('mcpServerStatus/list', params),
            getStartupState: (serverName) =>
              this.mcpStartupStates.get(active.rootThreadId)?.get(serverName),
          });
        } finally {
          this.mcpStartupStates.delete(active.rootThreadId);
        }
        this.assertTurnStillRecovering(active);
        if (setupGeneration !== this.threadSetupGeneration) {
          throw new Error(
            'Codex thread closed or worker changed during recovery',
          );
        }
        this.threadReady = true;
        if (this.reconcileUserInterruptDuringRecovery(active, recoveredTurn)) {
          return { strategy: 'reconciled' };
        }

        if (recoveredTurn) {
          if (
            recoveredTurnStatus === 'inProgress' ||
            recoveredTurnStatus === 'failed' ||
            recoveredTurnStatus === 'interrupted'
          ) {
            emptyResumeConfirmations = 0;
            const recoveredRouting = this.buildRouting(
              active.rootThreadId,
              recoveredTurnId ?? active.turnId,
            );
            this.ingestCompletedTurnItems(
              active,
              recoveredTurn,
              recoveredRouting,
              true,
              true,
            );
            emitPendingCodexCommandOutputUpdates(this.onEvent, active);
            if (
              this.reconcileUserInterruptDuringRecovery(active, recoveredTurn)
            ) {
              return { strategy: 'reconciled' };
            }
            return await this.continueRecoveredTurn(active);
          }
        }

        emptyResumeConfirmations += 1;
        lastError = new Error(
          active.turnId
            ? `Persisted turn ${active.turnId} is not available yet`
            : 'The interrupted turn is not present in persisted history yet',
        );
        if (emptyResumeConfirmations < CODEX_PROCESS_RECOVERY_MAX_ATTEMPTS) {
          continue;
        }

        if (active.turnId) {
          throw new CodexUnsafeRecoveryError(
            `Cannot safely replay Codex turn ${active.turnId} because its persisted outcome is unavailable`,
          );
        }
        if (!active.startParams) {
          throw new Error(
            'Cannot safely replay a turn without its start request',
          );
        }
        this.assertTurnStillRecovering(active);
        if (this.reconcileUserInterruptDuringRecovery(active, recoveredTurn)) {
          return { strategy: 'reconciled' };
        }
        emptyResumeConfirmations = 0;
        active.previousTurnId = active.turnId;
        active.turnId = '';
        active.lifecycleOrigin = 'restart';
        active.allowResumeMerge = false;
        active.submissionId = undefined;
        active.clientUserMessageId = undefined;
        const replayResponse = await this.request(
          'turn/start',
          active.startParams,
        );
        const replayedTurn = extractNativeTurn(replayResponse);
        const replayedTurnId = extractTurnId(replayResponse);
        if (!replayedTurnId) {
          throw new Error('Codex replay returned a turn without an id');
        }
        if (this.recoveredTurnStartAlreadySettled(active, replayedTurnId)) {
          return { strategy: 'replayed' };
        }
        active.controlPhase = undefined;
        this.acceptStartResponse(
          active,
          replayedTurnId,
          replayedTurn ?? undefined,
        );
        this.onSteeringEligibilityChanged?.();
        this.lastKnownTurnId = replayedTurnId;
        this.recordAppliedCollaborationMode(active.startParams);
        return { strategy: 'replayed' };
      } catch (error) {
        if (error instanceof CodexUnsafeRecoveryError) {
          throw error;
        }
        lastError = error;
        this.threadReady = false;
        transportFailures += 1;
      }
    }

    const recoveryError = new Error(
      `Could not restore the persisted Codex turn after bounded resume checks: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    Object.defineProperty(recoveryError, 'cause', {
      value: lastError,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    throw recoveryError;
  }

  private assertTurnStillRecovering(active: CodexTurnState): void {
    if (this.activeTurn !== active) {
      throw new Error('Codex turn ended while process recovery was pending');
    }
  }

  private reconcileUserInterruptDuringRecovery(
    active: CodexTurnState,
    recoveredTurn: Record<string, unknown> | undefined,
  ): boolean {
    if (!active.userInterruptAcknowledged) {
      return false;
    }
    if (active.startParams) {
      this.recordAppliedCollaborationMode(active.startParams);
    }
    this.handleTurnCompletedNotification({
      threadId: active.rootThreadId,
      turn: recoveredTurn
        ? { ...recoveredTurn, status: 'interrupted' }
        : {
            id: active.turnId,
            items: [],
            status: 'interrupted',
            error: null,
          },
    });
    return true;
  }

  private recoveredTurnStartAlreadySettled(
    active: CodexTurnState,
    recoveredTurnId: string,
  ): boolean {
    if (this.activeTurn === active) {
      return false;
    }
    if (!this.activeTurn && this.lastKnownTurnId === recoveredTurnId) {
      return true;
    }
    throw new Error('Codex turn ended while process recovery was pending');
  }

  private async continueRecoveredTurn(
    active: CodexTurnState,
  ): Promise<CodexProcessRecoveryResult> {
    if (!active.startParams) {
      throw new Error('Cannot continue a recovered turn without its settings');
    }
    active.previousTurnId = active.turnId;
    active.turnId = '';
    active.lifecycleOrigin = 'restart';
    active.allowResumeMerge = false;
    active.submissionId = undefined;
    active.clientUserMessageId = undefined;
    active.userMessageId = undefined;
    // The continuation is a new running turn: a terminal frame read for the
    // lost turn must not keep its steering closed.
    active.controlPhase = undefined;
    this.onSteeringEligibilityChanged?.();
    const continuationParams: AppServerRequestParams<'turn/start'> = {
      ...active.startParams,
      clientUserMessageId: `codex-recovery:${randomUUID()}`,
      input: [
        {
          type: 'text',
          text: 'The previous turn was interrupted by an app-server transport restart. Continue from the persisted state. Inspect the current project and external state before acting, and do not repeat any operation that already completed.',
          text_elements: [],
        },
      ],
    };
    active.startParams = continuationParams;
    const continuationResponse = await this.request(
      'turn/start',
      continuationParams,
    );
    const continuedTurn = extractNativeTurn(continuationResponse);
    const continuedTurnId = extractTurnId(continuationResponse);
    if (!continuedTurnId) {
      throw new Error('Codex continuation returned a turn without an id');
    }
    if (this.recoveredTurnStartAlreadySettled(active, continuedTurnId)) {
      return { strategy: 'continued' };
    }
    this.acceptStartResponse(
      active,
      continuedTurnId,
      continuedTurn ?? undefined,
    );
    this.onSteeringEligibilityChanged?.();
    this.lastKnownTurnId = continuedTurnId;
    this.recordAppliedCollaborationMode(continuationParams);
    return { strategy: 'continued' };
  }

  handleConnectionNotification(
    method: string,
    notification: Record<string, unknown>,
    transcriptDrain?: Promise<void>,
  ): void | Promise<void> {
    if (this.disposed) return;
    this.providerContractGuard?.observe(
      method,
      this.connection.harnessUserAgent(),
    );
    const observedRawFrame = this.handleRawBackgroundNotification(
      method,
      notification,
    );
    let result: void | Promise<void>;
    try {
      result = this.handleConnectionNotificationAfterBackground(
        method,
        notification,
        transcriptDrain,
      );
    } catch (error) {
      if (observedRawFrame) {
        this.finishBackgroundNotificationFrame(notification);
      }
      throw error;
    }
    if (!observedRawFrame) return result;
    if (result !== undefined) {
      return result.finally(() => {
        this.finishBackgroundNotificationFrame(notification);
      });
    }
    this.finishBackgroundNotificationFrame(notification);
  }

  handleUnroutedUnknownNotification(method: string): void {
    if (this.disposed) return;
    this.providerContractGuard?.observe(
      method,
      this.connection.harnessUserAgent(),
    );
  }

  private handleConnectionNotificationAfterBackground(
    method: string,
    notification: Record<string, unknown>,
    transcriptDrain?: Promise<void>,
  ): void | Promise<void> {
    if (this.disposed) {
      return;
    }
    if (method === 'serverRequest/resolved') {
      const params = readRecord(notification, 'params');
      const requestId = params?.requestId;
      if (typeof requestId === 'number' || typeof requestId === 'string') {
        const call = this.dynamicToolCalls.get(requestId);
        if (
          call &&
          params &&
          call.params.threadId === readString(params, 'threadId')
        )
          call.controller.abort();
      }
      return;
    }
    let stoppedDynamicToolScope: {
      threadId: string | undefined;
      turnId: string | undefined;
    } | null = null;
    if (method === 'turn/completed' || method === 'error') {
      const params = readRecord(notification, 'params');
      const completedTurn = params ? readRecord(params, 'turn') : undefined;
      const turnId = completedTurn
        ? readString(completedTurn, 'id')
        : params
          ? readString(params, 'turnId')
          : undefined;
      const threadId = params ? readString(params, 'threadId') : undefined;
      const rootFrame = !threadId || threadId === this.threadId;
      const turn = this.activeTurn;
      const retrying =
        method === 'error' && readBoolean(params ?? {}, 'willRetry') === true;
      const terminal =
        method === 'turn/completed'
          ? Boolean(completedTurn)
          : Boolean(params && readRecord(params, 'error') && !retrying);
      const exactRootTurn = Boolean(
        turn &&
        rootFrame &&
        turn.rootThreadId === (threadId ?? this.threadId) &&
        turn.turnId &&
        turn.turnId === turnId,
      );
      if (method === 'error' && terminal && rootFrame && turnId) {
        // Tool ownership is scoped by the native tuple, so a fatal frame can
        // abort that tool immediately even while turn identity is still
        // awaiting the matching start response/notification.
        this.abortDynamicToolCalls(threadId ?? this.threadId, turnId);
      }
      if (terminal && rootFrame && turn && !turn.turnId && turnId) {
        turn.pendingRootTerminals ??= [];
        if (turn.pendingRootTerminals.length < 8) {
          turn.pendingRootTerminals.push({
            method,
            notification,
            ...(transcriptDrain ? { transcriptDrain } : {}),
          });
        }
        return;
      }
      if (method === 'error' && rootFrame) {
        if (retrying) {
          if (exactRootTurn && turn) {
            this.emitTurnLifecycleObservation({
              type: 'session-state',
              threadId: turn.rootThreadId,
              turnId: turn.turnId,
              state: 'reconnecting',
            });
          }
          return;
        }
        if (!terminal || !turn || !exactRootTurn || !turnId) {
          if (turn && turn.turnId && turnId && turn.turnId !== turnId) {
            this.recordRootRunDrop(
              method,
              'turn_id_mismatch',
              threadId,
              turnId,
            );
          } else if (!turn) {
            this.recordRootRunDrop(method, 'no_active_turn', threadId, turnId);
          }
          return;
        }
        const error = readRecord(params ?? {}, 'error');
        const message = error ? buildTurnErrorMessage(error) : undefined;
        if (!message) return;
        const codexErrorInfo = error
          ? parseCodexErrorInfo(error.codexErrorInfo)
          : undefined;
        // Held evidence belongs to one native turn: a recovery continuation
        // reuses this state, and the lost turn's error must not mask its own.
        if (
          turn.fatalRootError?.threadId !== turn.rootThreadId ||
          turn.fatalRootError.turnId !== turn.turnId
        ) {
          turn.fatalRootError = {
            threadId: turn.rootThreadId,
            turnId: turn.turnId,
            message,
            ...(codexErrorInfo ? { codexErrorInfo } : {}),
          };
          emitPendingCodexCommandOutputUpdates(this.onEvent, turn);
          this.abortDynamicToolCalls(turn.rootThreadId, turn.turnId);
          this.closeStoppedDynamicToolRows(turn.rootThreadId, turn.turnId);
          turn.controlPhase = 'failed';
          this.onSteeringEligibilityChanged?.();
        }
        // The error is provisional control evidence only. The matching
        // turn/completed frame is the sole owner of terminal settlement and
        // the public turn.failed event.
        return;
      }
      if (retrying) {
        if (exactRootTurn && turn) {
          this.emitTurnLifecycleObservation({
            type: 'session-state',
            threadId: turn.rootThreadId,
            turnId: turn.turnId,
            state: 'reconnecting',
          });
        }
      } else if (!rootFrame || exactRootTurn) {
        if (terminal) {
          const terminalThreadId = threadId ?? this.threadId;
          const terminalTurnId = turnId;
          stoppedDynamicToolScope = {
            threadId: terminalThreadId,
            turnId: terminalTurnId,
          };
          this.abortDynamicToolCalls(terminalThreadId, terminalTurnId);
        }
      }
      const knownSettledRoot =
        exactRootTurn && turnId && (threadId ?? this.threadId)
          ? this.providerRuns.get(
              this.providerRunKey(threadId ?? this.threadId ?? '', turnId),
            )?.settled === true
          : false;
      if (terminal && exactRootTurn && turn && !knownSettledRoot) {
        // Control state and steering close now, even though accepted transcript
        // deltas may not yet have reached this reducer. Keep the item buffer
        // alive until that drain, then finalize content/terminal receipts in
        // order. The control frame is never retained in an admission lane.
        const terminalStatus = completedTurn
          ? readString(completedTurn, 'status')
          : undefined;
        turn.controlPhase =
          method === 'error' || terminalStatus === 'failed'
            ? 'failed'
            : 'completed';
        this.onSteeringEligibilityChanged?.();
      }
      if (
        (method === 'turn/completed' || method === 'error') &&
        rootFrame &&
        turn &&
        turn.turnId &&
        turnId &&
        turn.turnId !== turnId
      ) {
        this.recordRootRunDrop(method, 'turn_id_mismatch', threadId, turnId);
        return;
      }
      if (transcriptDrain) {
        // Only a root frame belongs to the turn active when it was read. A
        // subagent's completion is still delivered after the drain when the
        // root turn has been finalized meanwhile, as it was in the lane.
        const rootTurn = rootFrame ? turn : null;
        return transcriptDrain.then(() => {
          if (this.disposed || (rootTurn && this.activeTurn !== rootTurn))
            return;
          return this.handleConnectionNotification(method, notification);
        });
      }
    }
    if (method === 'thread/closed') {
      const params = readRecord(notification, 'params');
      const threadId = params ? readString(params, 'threadId') : undefined;
      if (threadId) {
        if (threadId === this.threadId) this.threadReady = false;
      }
    }
    if (method === 'mcpServer/startupStatus/updated') {
      const params = readRecord(notification, 'params');
      const threadId = params ? readString(params, 'threadId') : undefined;
      const name = params ? readString(params, 'name') : undefined;
      const status = params ? readString(params, 'status') : undefined;
      if (
        threadId &&
        name &&
        (status === 'starting' ||
          status === 'ready' ||
          status === 'failed' ||
          status === 'cancelled')
      ) {
        const states =
          this.mcpStartupStates.get(threadId) ??
          new Map<
            string,
            {
              status: 'starting' | 'ready' | 'failed' | 'cancelled';
              error?: string;
              failureReason?: string;
            }
          >();
        const error = params ? readString(params, 'error') : undefined;
        const failureReason = params
          ? readString(params, 'failureReason')
          : undefined;
        states.set(name, {
          status,
          ...(error ? { error } : {}),
          ...(failureReason ? { failureReason } : {}),
        });
        this.mcpStartupStates.set(threadId, states);
      }
      return;
    }
    const previousAdmissions = this.notificationAdmissions;
    const admissions: Promise<void>[] = [];
    this.notificationAdmissions = admissions;
    try {
      if (stoppedDynamicToolScope) {
        this.closeStoppedDynamicToolRows(
          stoppedDynamicToolScope.threadId,
          stoppedDynamicToolScope.turnId,
        );
      }
      this.handleNotification(method, notification);
    } catch (error) {
      // Preserve the synchronous reducer failure while observing admissions
      // emitted earlier in the same notification.
      void Promise.allSettled(admissions);
      throw error;
    } finally {
      this.notificationAdmissions = previousAdmissions;
    }
    if (previousAdmissions) {
      previousAdmissions.push(...admissions);
      return;
    }
    if (admissions.length > 0) {
      return Promise.all(admissions).then(() => undefined);
    }
  }

  private request<TMethod extends AppServerRequestMethod>(
    method: TMethod,
    params: AppServerRequestParams<TMethod>,
    options?: {
      softTimeout?: {
        onLateResponse: (outcome: CodexLateSteerResponse) => void;
      };
    },
  ): Promise<AppServerRequestResponse<TMethod>> {
    if (this.pendingTurnStartGeneration !== null) {
      this.dispatchedTurnStartGeneration = this.pendingTurnStartGeneration;
    }
    const requestOptions = {
      ...options,
      ...(this.pendingTurnStartAbort
        ? { signal: this.pendingTurnStartAbort.controller.signal }
        : {}),
    };
    return this.connection.request(method, params, requestOptions);
  }
}
