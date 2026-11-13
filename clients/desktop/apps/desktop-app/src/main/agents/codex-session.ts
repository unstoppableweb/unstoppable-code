import { isWatchDelegatesCompatibilityName } from '@canopy/desktop-shared/node/delegation/watch-delegates-tombstone';
import { observeRoutedCodexTurnStart } from './session-event-router';
import { chatVisualsEligible } from '../lib/chat-visuals-feature-flag';
import { createShowVisualHost } from '../canopy-tools/show-visual-host';
import { withProxyFailureRestored } from './ai-credits-proxy-failure-restore';
import { SkillUsageTracker } from './skill-usage-tracker';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  type CodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  admitCodexSpeed,
  buildCodexSpeedRouteFacts,
  codexSpeedGatewayForOrigin,
  reportCodexSpeedTurnFailure,
} from '../codex/speed-policy';
import { resolveCodexContextWindowConfig } from '../codex/context-window';
import type { CodexContextWindowSetting } from '@canopy/execution-engine/lib/codex-context-window';
import type { CodexSpeedRouteFacts } from '@canopy/execution-engine/lib/codex-speed-availability';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  getAppAdvisorLedgerToolNames,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import { watchCommandSchema } from '../canopy-tools/local-watcher-definitions';
import type { BrowserWindow } from 'electron';
import { managedDelegationEnabled } from './delegation/gate';
import type { ManagedDelegationSession } from './delegation/service';
import { randomUUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import { AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG } from '@canopy/protocol';
import { isAiCreditsFailureEventShape } from '@canopy/agent-transcript';
import { ASK_USER_TIMEOUT_MS } from '@canopy/execution-engine/lib/canopy-injected-tools';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionOptions,
  AgentSessionSendOptions,
} from './types';
import {
  buildCodexProxyConfigObject,
  buildOrgGatewayCodexBaseUrl,
  buildProxyBaseUrl,
  resolveSessionAiCreditsAttribution,
  emitAiCreditsRoutingStatus,
  emitAiCreditsUsageLimitReached,
  emitAiCreditsNoBillingSource,
  getAiCreditsRoutingContext,
  hasUserSuppliedProviderCredential,
  isAiCreditsChosenOverAccountProxy,
  resolveAiCreditsRoutingAttempt,
  resolveGatewayModelEntry,
  resolveOrgGatewayCredential,
  markOrgGatewayCredentialRejected,
} from './ai-credits-routing';
import {
  scopeDerivedNotices,
  withFailureSourceScope,
} from './failure-source-scope';
import { captureSessionWorkOwner, resolveSessionWorkOwner } from './work-owner';
import { resolveAccountProxySessionRoute } from '../account-proxy/routing';
import { watchAccountProxySwitches } from '../account-proxy/switch-events';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { getMockLlmOrigin } from '../lib/e2e-mock-control-plane';
import {
  isGatewayOnlyModel,
  isUnavailableModelSelection,
  resolveCodexReasoningRouteFamily,
  resolveGatewayToolSchemaProfile,
  resolveModelIdForGatewayId,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { getCodexGatewayProxyService } from './codex-gateway-proxy-service';
import { ensureGatewayCompatibleCodexCatalog } from '../codex/gateway-model-catalog';
import {
  isProviderNativelyAuthenticated,
  isProviderNativelyAuthenticatedForRouting,
} from '../auth/provider-auth-state';
import { isCodeGraphAvailableForWorkspace } from '../lib/code-graph-availability';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  clearSessionProxyFailure,
  consumeSessionProxyFailure,
  detectCodexQuotaReached,
  detectAiCreditsNoBillingSource,
  markProviderQuotaReached,
} from './ai-credits-quota-state';
import { recordUsageLimitedChat } from '../lib/usage-limited-chats-registry';
import { recordChatEventDropped } from '../lib/chat-event-drop-diagnostics';
import { recordEventReceiptTime } from './event-receipt-time';
import {
  classifyProviderRunEvent,
  copyProviderRunProvenance,
  getProviderRunDescriptor,
} from '../lib/provider-run-reconciliation';
import {
  buildUsageLimitedEntry,
  buildAccountProxyUsageLimitedEntry,
  classifyAccountChangeResumeReason,
} from '../lib/usage-limited-chats-recording';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import {
  CANOPY_MODEL_ACCESS_FAILURE_FIELD,
  type CodexAccountModelAccessFailure,
} from '@canopy/protocol/auth-recovery';
import { resolveCodexAccountModelAccessFailure } from '../model-routing/codex-account-model-fallback';
import { buildProviderAuthFailureEvent } from './provider-auth-failure-event';
import { createCodexContractGuard } from './provider-contract-guard';
import { resolveWorkspaceRecordingSnapshot } from '../lib/resolve-workspace-display-name';
import {
  hasAnySelections,
  IPC_CHANNELS,
  CODE_REVIEW_CHAT_PROJECT_ID,
  DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES,
  buildAiCreditsRequiredError,
  buildNoBillingSourceError,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CREDITS_CODEX_MODEL,
  resolveModelAlias,
  NO_BILLING_SOURCE_ERROR_CODE,
  resolveProviderModelConfig,
  INGESTION_LAG_EVENT_TYPE,
  type ChatIngestionLag,
  type ChatIngestionLagEventData,
  type ApprovalMode,
  type CanopyAuthFailureEventData,
  type ResolvedAgentModelConfig,
  type ChatTabPluginSelections,
  type ChatModel,
  type ThinkingLevel,
  type PlanExitRequestEvent,
} from '@canopy/desktop-shared/types';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  registerSession,
  unregisterSession,
  buildSessionKey,
  markSessionForNextTurnRecreation,
  createSessionPhaseTimer,
  isSessionAccountProxyRouted,
  isSessionAiCreditsRouted,
  registerCodexBackgroundOwner,
  replaceCodexLiveBackgroundTasks,
  retireCodexLiveBackgroundTasks,
  type CodexBackgroundOwnerToken,
  type CodexLiveBackgroundTaskInput,
  recordSessionAccountProxyRoute,
} from './session-manager';
import { notifySteeringEligibilityChanged } from './steering-eligibility-events';
import {
  beginCodexSessionTurn,
  finishCodexSessionTurn,
  recordCodexTurnEnd,
  type CodexTurnTerminalEvidence,
} from './provider-turn-evidence';
import {
  CodexTurnLifecycleTracker,
  type CodexTurnTrackerObservation,
} from './codex-turn-lifecycle';
import {
  getTurnLifecycleProducer,
  hasTurnLifecycleEnded,
  releaseTurnLifecycleProducer,
} from './provider-turn-lifecycle';
import { createOwnedTurnState, type OwnedTurnState } from './owned-turn-state';
import { CodexAppServerClient } from '../codex/app-server-client';
import { getDesktopCodexCapabilityStore } from '../codex/capability-store';
import { getCodexRuntimeService } from '../codex/runtime-service';
import {
  loadCodexForkContinuation,
  loadPersistedCodexFallbackSeedItems,
} from '../codex/transcript-seed';
import { waitForPendingCodexFork } from '../codex/fork-thread';
import { handleCanopyDynamicToolCall } from '../codex/canopy-dynamic-tools';
import {
  mayExposeLedgerTools,
  openLedgerChatTools,
  type LedgerChatTarget,
  type LedgerChatToolsSession,
} from '../canopy-tools/ledger-tools-runtime';
import { buildLedgerPlanModeInstruction } from '../canopy-tools/prompting';
import { handleAppAdvisorDynamicToolCall } from '../app-advisor/codex-dynamic-tools';
import { handlePipelineEditorDynamicToolCall } from '../pipeline-editor/codex-dynamic-tools';
import { buildCodexSessionDynamicToolSpecs } from '../codex/session-dynamic-tools';
import { sendToWindow } from '../lib/window-send';
import { noteChatSessionEvent } from '../lib/transient-error-retry-service';
import { getAttentionTracker } from '../services/attention-tracker';
import { commitPendingPlanExit } from '../services/chat-state-plan-exit';
import {
  isCodexSubagentTerminalEvent,
  isRootTerminalChatEventData,
  readCodexRootThreadId,
} from '../lib/chat-turn-audit';
import {
  codexAggregateSkillInvocationNamesForRefs,
  resolveEffectivePluginSelectionRefs,
  resolvePlugins,
  type ResolvedPlugins,
} from '../plugins/plugin-resolver';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { loadCachedInventory } from '../plugins/invocable-inventory-service';
import {
  matchInvocationEntry,
  normalizeInvocationToken,
  type InvocationTokenInventoryEntry,
} from '../plugins/invocation-prefix-normalizer';
import { BUILTIN_APP_PLUGIN_NAME } from '../plugins/codex-plugin-compat';
import { resolveCodexMockAppServerOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import {
  getFileCommentsInSession,
  loadGitPreferences,
  loadWorktreePipelineYaml,
  loadWorktreeScriptOutput,
  saveLocalMemory,
  searchLocalMemory,
  requestAnswersFromRenderer,
  respondToFileCommentInSession,
} from '../canopy-tools/session-runtime';
import { codexNativeMemoryThreadConfig } from '@canopy/execution-engine/node/lib/native-memory';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import { requestShowFilesThroughLease } from '../canopy-tools/show-files-runtime';
import { hasInterfaceTool } from './interface-tool-binding';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import type { ThreadStartParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/ThreadStartParams';
import type { CodexIngestionLagChange } from '@canopy/execution-engine/node/codex-runtime/runtime-service';
import type {
  CodexBackgroundSnapshot,
  CodexNativeBackgroundWork,
} from '@canopy/execution-engine/node/codex-runtime';
import { CODEX_PROJECT_DOC_THREAD_CONFIG } from '@canopy/execution-engine/node/codex-runtime/thread-config';
import { classifyCodexTransportError } from '@canopy/execution-engine/node/codex-runtime/transport-errors';
import type { CodexConfig } from '@canopy/execution-engine/lib/codex-model-config';
import {
  resolveCodexRuntimeEnvironmentProfile,
  type CodexRuntimeEnvironmentProfile,
} from '../lib/user-environment-runtime';

function isUnknownDynamicToolError(message: string | undefined): boolean {
  if (!message) return false;
  return /unknown\s+dynamic\s+tool|dynamic\s+tool\s+(?:unknown|not\s+found)/i.test(
    message,
  );
}

function toCodexLiveBackgroundTaskInput(
  work: CodexNativeBackgroundWork,
): CodexLiveBackgroundTaskInput {
  if (work.kind === 'child') {
    return {
      taskId: work.id,
      taskType: 'local_agent',
      description: 'Background agent',
      ...(work.toolUseId ? { toolUseId: work.toolUseId } : {}),
    };
  }
  return {
    taskId: work.id,
    taskType: 'local_bash',
    description: 'Background terminal',
    toolUseId: work.itemId,
  };
}

async function resolveCodexStandaloneInvocationEntries(
  selections: ChatTabPluginSelections,
): Promise<InvocationTokenInventoryEntry[]> {
  try {
    const warnings: string[] = [];
    const effectiveRefs = await resolveEffectivePluginSelectionRefs(
      selections,
      warnings,
    );
    const generatedNames = codexAggregateSkillInvocationNamesForRefs(
      effectiveRefs.skillRefs,
      warnings,
    );
    return Array.from(generatedNames.values(), (generatedName) => ({
      invocationKey: `$${BUILTIN_APP_PLUGIN_NAME}:${generatedName}`,
      kind: 'skill',
      name: generatedName,
    }));
  } catch {
    return [];
  }
}

/**
 * An ITEM-level field of a persisted history entry: `input[7].content`,
 * `input.7.encrypted_content`, `input[2].type`.
 *
 * Anchoring on the item-level field is what separates "the provider rejected a
 * history item it cannot decode" from an ordinary parameter error about the
 * request's reasoning *settings* (`invalid_value for 'input[0].reasoning.effort'`).
 * A nested path such as `input[N].reasoning.<anything>` deliberately does not
 * match: the recovery this gates is destructive (the live thread is abandoned,
 * a new sdkSessionId is persisted, and the whole history is re-injected with
 * reasoning stripped).
 */
const INCOMPATIBLE_REASONING_HISTORY_ITEM_FIELD =
  /input(?:\[\d+\]|\.\d+)\.(?:encrypted_content|content|type|internal_chat_message_metadata_passthrough)\b/i;

function isStaleProxyRouteError(message: string | undefined): boolean {
  return (
    message !== undefined && /proxy route is no longer available/i.test(message)
  );
}

const MAX_STALE_PROXY_ROUTE_RECOVERIES = 3;

function isIncompatibleReasoningHistoryError(
  message: string | undefined,
): boolean {
  if (!message) return false;
  if (!INCOMPATIBLE_REASONING_HISTORY_ITEM_FIELD.test(message)) return false;
  // Also require a shape/recognition failure. A bare `invalid` is deliberately
  // excluded so an unrelated validation error on the same item cannot reach
  // the destructive rebuild.
  return /(?:array_above_max_length|unknown|unrecognized|unsupported|extra_forbidden|invalid_type|invalid_value|not\s+(?:permitted|allowed|supported))/i.test(
    message,
  );
}

/**
 * Session-wide ceiling on incompatible-reasoning rebuilds. The budget itself is
 * per thread, but each rebuild produces a *new* thread id, so a route that
 * rejects every rebuilt thread would otherwise rebuild forever on one queued
 * message. This bounds that pathological case while leaving room for genuinely
 * independent poisoned threads in a long-lived session.
 *
 * **Known trade-off: the ceiling counts session-wide and the recorded set is
 * never pruned on success.** Three *successful* self-heals in one long-lived
 * session therefore exhaust the budget for a genuinely new poisoned thread,
 * which partially defeats the per-thread motivation. Pruning an entry once its
 * rebuild succeeds is deliberately not implemented: the entry recorded is the
 * *failed* thread id, the rebuild replaces it with a new id, and "success" here
 * is only "this turn completed" — a route that alternates completed and
 * rejected turns could then re-enter the rebuild loop indefinitely on the same
 * conversation. Bounding the pathological case is worth the rare false
 * exhaustion; revisit only with a durable per-thread attempt record.
 */
const MAX_INCOMPATIBLE_REASONING_HISTORY_REBUILDS = 3;

const CODEX_PLUGIN_RESOLUTION_RETRY_DELAYS_MS = [150, 750, 2_000, 5_000];
const SESSION_DESTROYED_ERROR_MESSAGE = 'session_destroyed';

/**
 * The context window setting and model each client's thread was loaded
 * with. Codex reads `model_context_window` only when a thread loads, so a
 * change replaces the client and the next turn resumes the thread with it.
 */
const appliedCodexContextWindows = new WeakMap<
  CodexAppServerClient,
  {
    setting: CodexContextWindowSetting | undefined;
    model: ChatModel | undefined;
    /**
     * The bounds weren't known when the client was built, so the setting
     * wasn't sent; a later turn rebuilds once they are.
     */
    pending?: CodexSpeedRouteFacts;
  }
>();

interface QueuedCodexMessage {
  text: string;
  submissionId: string;
  userMessageId?: string;
  revivesSettledTurn?: boolean;
  staleProxyRouteRetried?: boolean;
  staleProxyRouteRecoverySignal?: AbortSignal;
  countsTowardSkillUsage?: boolean;
  skillUsageTurnId?: string;
}

interface CodexIngestionLagOwner {
  client: CodexAppServerClient | null;
  hasPositiveSample: boolean;
  retired: boolean;
}

interface CodexBackgroundSessionOwner {
  client: CodexAppServerClient;
  token: CodexBackgroundOwnerToken | undefined;
  epoch: string;
  revision: number;
  unsubscribe: (() => void) | undefined;
  detached: boolean;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSessionDestroyedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === SESSION_DESTROYED_ERROR_MESSAGE
  );
}

function withTurnMetadata(
  data: unknown,
  turn: QueuedCodexMessage | undefined,
): unknown {
  if (!isRecord(data)) {
    return data;
  }
  const descriptor = getProviderRunDescriptor(data);
  const runClassification = classifyProviderRunEvent(data);
  const trustedRun =
    runClassification.kind === 'ordinary' ? runClassification.run : undefined;
  const trustedLate = runClassification.kind === 'transcript_only';
  const explicitMessageId =
    typeof data.canopy_turn_user_message_id === 'string'
      ? data.canopy_turn_user_message_id
      : undefined;
  const messageId =
    descriptor?.executionUserMessageId ??
    explicitMessageId ??
    turn?.userMessageId;
  const stamped = { ...data };
  if (trustedLate || trustedRun?.origin === 'provider_owned') {
    delete stamped.canopy_turn_revival;
  }
  if (messageId) stamped.canopy_turn_user_message_id = messageId;

  const event = isRecord(data.event) ? data.event : undefined;
  const isProviderOwnedStart =
    trustedRun?.origin === 'provider_owned' &&
    event?.type === 'turn.started' &&
    event.thread_id === trustedRun.threadId &&
    event.turn_id === trustedRun.turnId;
  if (isProviderOwnedStart) {
    stamped.canopy_turn_revival = true;
  } else if (
    !trustedLate &&
    trustedRun?.origin !== 'provider_owned' &&
    turn?.revivesSettledTurn
  ) {
    stamped.canopy_turn_revival = true;
  }
  return copyProviderRunProvenance(data, stamped);
}

/**
 * Whether this event is the failure the proxy's pending verdict describes.
 * Mirrors the wrapper unwrap `detectAiCreditsNoBillingSource` performs, and
 * defers the shape rule itself to `@canopy/agent-transcript` so main does not
 * grow a second copy that can drift from the renderer's.
 */
function isAiCreditsFailureEvent(data: unknown): boolean {
  if (!isRecord(data)) return false;
  if (data.type === 'codex') {
    return isAiCreditsFailureEventShape(data.event, 'codex');
  }
  return isAiCreditsFailureEventShape(data, 'claude');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCodexTurnTerminalOutcome(
  data: unknown,
): CodexTurnTerminalEvidence['outcome'] | undefined {
  if (!isRecord(data)) return undefined;

  if (data.type === 'codex' && isRecord(data.event)) {
    if (data.event.type === 'turn.completed') {
      return data.event.status === 'interrupted' ? 'interrupted' : 'completed';
    }
    if (data.event.type === 'turn.failed') {
      return 'failed';
    }
    return undefined;
  }

  if (data.type === 'error') return 'failed';
  if (data.type !== 'result') return undefined;

  const resultText =
    typeof data.result === 'string' ? data.result.trim().toLowerCase() : '';
  const terminalReason =
    typeof data.terminal_reason === 'string'
      ? data.terminal_reason.toLowerCase()
      : '';
  if (
    resultText === 'turn cancelled' ||
    resultText === 'session aborted' ||
    resultText === 'session ended' ||
    terminalReason === 'aborted_streaming' ||
    terminalReason === 'aborted_tools'
  ) {
    return 'interrupted';
  }
  return data.is_error === true ? 'failed' : 'completed';
}

function codexTurnOutcomeForError(
  error: unknown,
): CodexTurnTerminalEvidence['outcome'] {
  if (
    error instanceof Error &&
    (error.message === 'turn_cancelled' ||
      error.message === SESSION_DESTROYED_ERROR_MESSAGE ||
      error.message === AI_CREDITS_BACKSTOP_ABORT_ERROR)
  ) {
    return 'interrupted';
  }
  return 'failed';
}

/**
 * Whether a Codex thread has a capability record. Every thread started,
 * rebuilt or forked since capability records exist has one. A resumed thread
 * without one predates them and keeps the dynamic tools it started with, so
 * it can never have the Ledger tools. An unreadable record counts as absent.
 */
async function hasCodexCapabilityRecord(threadId: string): Promise<boolean> {
  try {
    return (
      (await getDesktopCodexCapabilityStore().readLease(threadId)) !== null
    );
  } catch {
    return false;
  }
}

function appendPluginMcpDiscoveryInstructions(
  developerInstructions: string | undefined,
  mcpServersConfig: ResolvedPlugins['codexMcpServers'] | undefined,
): string | undefined {
  const serverIds = Object.keys(mcpServersConfig ?? {}).sort();
  if (serverIds.length === 0) {
    return developerInstructions;
  }

  const discoveryInstructions = [
    'Selected plugin MCP servers configured for this chat:',
    ...serverIds.map((serverId) => `- ${serverId}`),
    '',
    'MCP resource and resource-template listings are not complete server inventories: tool-only plugin MCP servers do not appear in them. When asked which MCP servers or plugin capabilities are available, or when a selected plugin could help, use Codex tool search to inspect ALL_TOOLS for matching MCP tools before concluding that a server is unavailable.',
  ].join('\n');

  const baseInstructions = developerInstructions?.trim();
  return baseInstructions
    ? `${baseInstructions}\n\n${discoveryInstructions}`
    : discoveryInstructions;
}

function recordPluginResolutionRetry(
  turnState: OwnedTurnState,
  reason: 'resolution_error',
  attempt: number,
  retryDelayMs: number,
  details: unknown,
): void {
  turnState.recordSessionEvent({
    type: 'phase',
    phase: 'codex.resolve_plugins.retry',
    reason,
    attempt,
    retryDelayMs,
    details,
  });
}

/**
 * Sentinel returned by `resolveCodexAiCreditsRouting` when the defensive
 * backstop fires: the resolver has already emitted a clear error and the caller
 * must abort the session instead of falling back to native provider auth.
 */
const AI_CREDITS_BACKSTOP_ABORT = 'backstop-abort';

/**
 * Message on the internal error thrown to unwind `ensureClient` after the AI
 * Credits backstop fired. The catch handlers recognize it and end the session
 * cleanly without re-emitting a second error over the already-emitted backstop
 * message.
 */
const AI_CREDITS_BACKSTOP_ABORT_ERROR = 'ai_credits_backstop_abort';

export interface CodexCompatibleInvocation {
  runtimeModel?: string;
  envOverride?: Record<string, string>;
  codexConfig?: CodexConfig;
}

interface CodexProviderOptions {
  providerType?: 'codex' | 'ollama';
  emitIngestionLag?: (
    target: { projectId: string; worktreeId: string; chatId: string },
    data: ChatIngestionLagEventData,
  ) => void | Promise<void>;
  prepareInvocation?: (
    model: ChatModel | undefined,
    reason: 'session-start' | 'model-change',
  ) => Promise<CodexCompatibleInvocation>;
}

function mergeCodexConfig(
  base: CodexConfig | undefined,
  overlay: CodexConfig | undefined,
): CodexConfig | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  const baseProviders =
    typeof base.model_providers === 'object' &&
    base.model_providers !== null &&
    !Array.isArray(base.model_providers)
      ? base.model_providers
      : {};
  const overlayProviders =
    typeof overlay.model_providers === 'object' &&
    overlay.model_providers !== null &&
    !Array.isArray(overlay.model_providers)
      ? overlay.model_providers
      : {};
  return {
    ...base,
    ...overlay,
    ...(base.model_providers || overlay.model_providers
      ? {
          model_providers: {
            ...baseProviders,
            ...overlayProviders,
          },
        }
      : {}),
  };
}

/**
 * Resolve AI Credits gateway routing for a Codex session, if active. Returns
 * the proxy token env plus the `-c` app-server config overrides that register
 * the gateway model provider, `'backstop-abort'` when the backstop error was
 * emitted and the caller must not spawn the session, or `null` when routing is
 * inactive / not a Codex-harness model / no cloud context is available.
 */
async function resolveCodexAiCreditsRouting(
  opts: AgentSessionOptions,
  emit: (data: unknown) => void | Promise<void>,
): Promise<
  | {
      config: NonNullable<ThreadStartParams['config']>;
      selectedModel: string;
      gatewayModel: string;
      supportedThinkingLevels: readonly ThinkingLevel[];
      modelCatalogPath?: string;
    }
  | typeof AI_CREDITS_BACKSTOP_ABORT
  | null
> {
  if (opts.providerType === 'ollama') return null;
  let nativeAuthPromise: Promise<boolean> | undefined;
  const checkNativeAuth = (): Promise<boolean> =>
    (nativeAuthPromise ??= isProviderNativelyAuthenticatedForRouting(
      'codex',
      'ai-credits-routing',
    ));
  const attempt = await resolveAiCreditsRoutingAttempt(
    opts.aiCreditsRouting,
    'codex',
    checkNativeAuth,
    opts.subscriptionBillingOverride,
  );
  const gatewayCheck = await checkModelGatewayRoute(
    opts.model,
    await resolveSessionWorkOwner(opts),
  );
  if (!gatewayCheck.ok) throw new Error(gatewayCheck.message);
  const gatewayEnforced = gatewayCheck.orgRoute;
  // See the matching guard in `claude-session.ts`: the auth probe runs without
  // the Canopy Environments injector the spawn uses, so a user who supplies
  // `OPENAI_API_KEY` through Environments reads as signed out here while having
  // a working provider at spawn time. Fall through to native rather than
  // routing (and billing) around their own credential.
  if (
    attempt?.reason === 'no-native-auth' &&
    !gatewayEnforced &&
    hasUserSuppliedProviderCredential('codex', opts.projectId)
  ) {
    return null;
  }
  // An omitted model needs a gateway default whenever credits routing is
  // requested, regardless of the activation reason.
  const selectedModel =
    attempt?.modelId ??
    opts.model ??
    (attempt ? DEFAULT_CREDITS_CODEX_MODEL : undefined);
  if (isUnavailableModelSelection(selectedModel, 'codex')) {
    await emit({
      type: 'error',
      error:
        'This model is no longer available. Pick another model to continue.',
    });
    return AI_CREDITS_BACKSTOP_ABORT;
  }
  // A gateway-only model can never be billed via a native Codex login, so it
  // must always route through the gateway — even when the attempt resolver
  // returns null (e.g. a natively-authenticated user with routing mode off who
  // selected it anyway). The picker greys such rows without credits, but the
  // session must be robust to a forced/restored selection.
  // Helpers pass the native default explicitly, including saved retired
  // aliases. Without native auth, use its credits counterpart while retaining
  // the selected model as the session's route-cache key.
  const entry =
    resolveGatewayModelEntry(selectedModel) ??
    (attempt &&
    !gatewayEnforced &&
    selectedModel !== undefined &&
    resolveModelAlias(selectedModel) === DEFAULT_CODEX_MODEL &&
    !(await checkNativeAuth())
      ? resolveGatewayModelEntry(DEFAULT_CREDITS_CODEX_MODEL)
      : undefined);
  if (gatewayEnforced && entry?.origin !== 'org-gateway') {
    await emit({
      type: 'error',
      error:
        'Your organization requires model traffic to use its configured gateway.',
    });
    return AI_CREDITS_BACKSTOP_ABORT;
  }
  const gatewayOnly = entry?.gatewayOnly === true;
  const enforcedOrgRoute = gatewayEnforced && entry?.origin === 'org-gateway';
  if (!attempt && !gatewayOnly && !enforcedOrgRoute) {
    return null;
  }
  if (!entry) {
    // Defensive backstop: the user picked a model AI Credits can't cover. If
    // they also have no native Codex login, surface a clear error instead of
    // falling through to a raw native provider auth failure (a 401). The picker
    // (Part B) prevents this, but the global routing modes ('on'/'on-quota')
    // resolve an attempt *before* native auth is ever consulted, so a
    // reason of 'mode'/'session-override' alone does not tell us whether the
    // user can fall back to a native spawn — re-check native auth here.
    // (`gatewayOnly` is false in this branch, so `attempt` is non-null.)
    const nativelyAuthenticated =
      attempt?.reason === 'no-native-auth'
        ? false
        : await isProviderNativelyAuthenticated('codex', 'ai-credits-routing');
    if (!nativelyAuthenticated) {
      await emit({
        type: 'error',
        error:
          "This model can't be used with AI Credits and Codex isn't connected. Connect Codex or pick a model covered by AI Credits.",
      });
      // Abort rather than fall through to a native spawn — that would surface a
      // second raw provider auth failure on top of this clear message.
      return AI_CREDITS_BACKSTOP_ABORT;
    }
    return null;
  }
  if (entry.origin === 'org-gateway') {
    try {
      const attribution = await resolveSessionAiCreditsAttribution(opts);
      const credential = await resolveOrgGatewayCredential(
        entry,
        attribution.workOwner,
      );
      const modelCatalogPath = await ensureGatewayCompatibleCodexCatalog();
      const mockLlmOrigin = getMockLlmOrigin();
      const requestBaseUrl = mockLlmOrigin ?? credential.baseUrl;
      const route = await getCodexGatewayProxyService().registerRoute({
        sessionId: buildSessionKey(
          opts.projectId,
          opts.worktreeId,
          opts.chatId,
        ),
        upstreamUrl: buildOrgGatewayCodexBaseUrl(requestBaseUrl),
        allowedPaths: ['/responses'],
        resolveToken: async () => {
          const refreshed = await resolveOrgGatewayCredential(
            entry,
            attribution.workOwner,
          );
          return {
            token: refreshed.apiKey,
            credentialVersion: refreshed.credentialVersion,
          };
        },
        stripCacheControl: entry.promptCachePassthrough === false,
        onCredentialRejected: (status, credentialVersion) =>
          markOrgGatewayCredentialRejected(
            entry.organizationId ?? '',
            status,
            credentialVersion,
          ),
      });
      return {
        config: buildCodexProxyConfigObject(entry, route.baseUrl, attribution),
        selectedModel: selectedModel ?? entry.modelId,
        gatewayModel: entry.gatewayId,
        supportedThinkingLevels: [...entry.supportedThinkingLevels],
        ...(modelCatalogPath ? { modelCatalogPath } : {}),
      };
    } catch (error) {
      await emit({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      return AI_CREDITS_BACKSTOP_ABORT;
    }
  }
  const attribution = await resolveSessionAiCreditsAttribution(opts);
  const context = await getAiCreditsRoutingContext({
    owner: attribution.workOwner,
  });
  // Skip routing when the account has no usable AI-credit balance — otherwise
  // the session is pointed at the gateway only to fail with a 402 instead of
  // falling back to native provider auth.
  if (!context || !context.creditsEligible) {
    // A gateway-only model has no native path to fall back to, so a missing
    // balance must surface a clear message and abort rather than spawn a
    // session that can't be billed (which would 401/402 natively).
    if (gatewayOnly) {
      // This abort is the STEADY-STATE out-of-credits experience, not an edge
      // case: once the balance reads zero the turn never reaches the gateway at
      // all, so the mid-turn 402 (and every signal derived from it) never
      // happens again. It therefore has to raise the recovery surface itself.
      //
      // It cannot rely on the banner's derived pre-flight condition the sibling
      // `no-native-auth` branch below leans on. `derived` requires
      // `!availability.nativeAuth`, and this branch is reachable precisely
      // BECAUSE a gateway-only model was picked — which a natively signed-in
      // user can do. For them `derived` is false forever, which is the same
      // blind spot CAN-2413 added the runtime signal to bypass. Without this
      // emit, the abort renders nothing anywhere: the reducer turns a bare
      // `error` event into `state.error` with ZERO transcript messages, so the
      // user gets no response, no error, and no banner.
      await emitAiCreditsNoBillingSource(emit, 'codex');
      await emit({
        type: 'error',
        // Stamped so the reducer persists `aiCreditsNoBillingSource` on the tab
        // and the banner survives a reload, exactly like a failed routed turn.
        [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
        error_code: NO_BILLING_SOURCE_ERROR_CODE,
        error: buildAiCreditsRequiredError(BRAND.displayName),
      });
      return AI_CREDITS_BACKSTOP_ABORT;
    }
    // No native login (that is exactly what `no-native-auth` confirms) and no
    // spendable credits: nothing can pay for this turn. Falling through would
    // spawn natively and surface a raw `Please run /login`, which names the one
    // remedy the user may not have. Abort with a message that offers both
    // (ECW-9091). A `mode` / `session-override` attempt tells us nothing about
    // native auth, so those keep falling through to a native spawn.
    //
    // `error_code` makes the abort machine-identifiable (same precedent as
    // `OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE`). The visible remedy is
    // `NoBillingSourceBanner`, which renders from the same availability state
    // and is already on screen when this fires — the desktop transcript has no
    // error-string surface of its own.
    if (attempt?.reason === 'no-native-auth') {
      await emit({
        type: 'error',
        error_code: NO_BILLING_SOURCE_ERROR_CODE,
        error: buildNoBillingSourceError('Codex', BRAND.displayName),
      });
      return AI_CREDITS_BACKSTOP_ABORT;
    }
    return null;
  }
  const modelCatalogPath = await ensureGatewayCompatibleCodexCatalog();
  const route = await getCodexGatewayProxyService().registerRoute({
    sessionId: buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId),
    upstreamUrl: buildProxyBaseUrl(context.cloudBaseUrl, 'codex'),
    allowedPaths: ['/responses'],
    resolveToken: async () => {
      const refreshed = await getAiCreditsRoutingContext({
        owner: attribution.workOwner,
        forceRefresh: true,
      });
      return refreshed?.accountIdentity === context.accountIdentity
        ? refreshed.cskToken
        : null;
    },
  });
  return {
    config: buildCodexProxyConfigObject(entry, route.baseUrl, attribution),
    selectedModel: selectedModel ?? entry.modelId,
    gatewayModel: entry.gatewayId,
    supportedThinkingLevels: [...entry.supportedThinkingLevels],
    ...(modelCatalogPath ? { modelCatalogPath } : {}),
  };
}

export class CodexProvider implements AgentProvider {
  private readonly providerType: 'codex' | 'ollama';
  private readonly emitIngestionLag?: CodexProviderOptions['emitIngestionLag'];
  private readonly prepareInvocation?: CodexProviderOptions['prepareInvocation'];

  constructor(options?: CodexProviderOptions) {
    this.providerType = options?.providerType ?? 'codex';
    this.emitIngestionLag = options?.emitIngestionLag;
    this.prepareInvocation = options?.prepareInvocation;
  }

  createSession(
    opts: AgentSessionOptions,
    onEvent: (data: unknown) => void | Promise<void>,
    getWindow: () => BrowserWindow | null,
  ): AgentSession {
    const key = buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId);
    const lifecycleScope = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
    };
    const turnLifecycleTracker = new CodexTurnLifecycleTracker(
      getTurnLifecycleProducer('codex', lifecycleScope),
      (turnId) => hasTurnLifecycleEnded(lifecycleScope, turnId),
    );
    const onTurnLifecycleObservation = (
      observation: CodexTurnTrackerObservation,
    ): void => {
      const publishedBinding =
        turnLifecycleTracker.observeWithPublishedBinding(observation);
      if (
        publishedBinding &&
        (observation.type === 'turn-started' ||
          observation.type === 'input-bound')
      ) {
        observeRoutedCodexTurnStart(
          lifecycleScope,
          session,
          observation.threadId,
          observation.turnId,
          publishedBinding.userMessageIds,
        );
      }
    };
    const turnState = createOwnedTurnState(key, () => session);
    const pluginRouteOwnerId = `codex-session:${key}:${randomUUID()}`;
    /** Ends the transcript's account switch lines (CAN-4021). */
    let stopAccountProxySwitches: (() => void) | undefined;
    // Bind the owner of this chat's work to the context current as it starts
    // (CAN-3456); a later sidebar switch must not move it.
    captureSessionWorkOwner(opts);
    const codeGraphToolsAdvertised =
      opts.codeGraphToolsAdvertised ??
      ((opts.assistantMode ?? 'default') === 'default' &&
        !isCoworkWorkspace(opts.projectId) &&
        isCodeGraphAvailableForWorkspace(opts.projectId));
    const sessionOpts: AgentSessionOptions = {
      ...opts,
      providerType: this.providerType,
      executionHarness: 'codex',
      codeGraphToolsAdvertised,
      // One live list: the approval session adds grants to it, and managed
      // delegates evaluate their approvals against it.
      sessionApprovalRules: opts.sessionApprovalRules ?? [],
    };
    const sessionAbort = new AbortController();

    let accountProxyConnectionId: string | undefined;
    const messageQueue: QueuedCodexMessage[] = [];
    const skillUsage = new SkillUsageTracker(opts);
    let waitingForMessage:
      | ((msg: QueuedCodexMessage | undefined) => void)
      | null = null;
    let currentModelConfig: ResolvedAgentModelConfig =
      resolveProviderModelConfig(
        'codex',
        {
          thinkingLevel: opts.thinkingLevel,
          modelConfig: opts.modelConfig,
          codexFastModeEnabled: opts.codexFastModeEnabled,
        },
        undefined,
      );
    function setRequestedCodexSpeed(speed: CodexSpeed): void {
      currentModelConfig = {
        ...currentModelConfig,
        speed,
        fastMode: codexSpeedFastMode(speed),
      };
    }
    let currentThinkingLevel: ThinkingLevel = currentModelConfig.thinkingLevel;
    let currentModel: ChatModel | undefined = opts.model;
    let currentSelectedModel: ChatModel | undefined =
      opts.selectedModel ?? opts.model;
    const preparedInvocationState: {
      runtimeModel?: string;
      extraEnv: Record<string, string> | null;
      threadConfig?: NonNullable<ThreadStartParams['config']>;
    } = {
      extraEnv: null,
      // The client re-sends this on every start, resume, fork and recovery.
      threadConfig: { ...CODEX_PROJECT_DOC_THREAD_CONFIG },
    };
    const prepareInvocation = this.prepareInvocation;
    let currentPlanMode = opts.planMode ?? false;
    let currentProposalMode: 'optional' | 'required' =
      opts.codexProposalMode ?? 'optional';
    let currentIdleTimeoutMinutes =
      opts.codexAppServerIdleTimeoutMinutes ??
      DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let turnInProgress = false;
    let turnCancelling = false;
    let turnPreparationController = new AbortController();
    let forceClientReleaseAfterTurn = false;
    let forceClientReleaseAfterDelegation = false;
    let forceClientReleaseAfterBackgroundWork = false;
    let releaseClientAfterDelegation = false;
    let destroyed = false;
    let client: CodexAppServerClient | null = null;
    const ingestionLagTarget = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
    };
    const ingestionLagOwners = new WeakMap<
      CodexAppServerClient,
      CodexIngestionLagOwner
    >();
    const codexBackgroundOwners = new WeakMap<
      CodexAppServerClient,
      CodexBackgroundSessionOwner
    >();
    const codexBackgroundSnapshots = new WeakMap<
      CodexAppServerClient,
      CodexBackgroundSnapshot
    >();
    let activeIngestionLagOwner: CodexIngestionLagOwner | null = null;
    const emitIngestionLag = this.emitIngestionLag;
    const emitIngestionLagObservation = (
      lag: ChatIngestionLag | null,
    ): void => {
      if (!emitIngestionLag) return;
      const data: ChatIngestionLagEventData = {
        type: INGESTION_LAG_EVENT_TYPE,
        lag,
      };
      try {
        const delivery = emitIngestionLag(ingestionLagTarget, data);
        if (delivery) void delivery.catch(() => undefined);
      } catch {
        // Observational delivery must not affect provider event admission.
      }
    };
    const retireIngestionLagOwner = (
      retiredClient: CodexAppServerClient | null,
    ): void => {
      if (!retiredClient) return;
      const owner = ingestionLagOwners.get(retiredClient);
      if (!owner || owner.retired) return;
      owner.retired = true;
      if (activeIngestionLagOwner === owner) {
        activeIngestionLagOwner = null;
      }
      if (owner.hasPositiveSample) {
        owner.hasPositiveSample = false;
        emitIngestionLagObservation(null);
      }
    };
    const emitIngestionLagSample = (
      owner: CodexIngestionLagOwner,
      sample: ChatIngestionLag,
    ): void => {
      if (
        destroyed ||
        owner.retired ||
        owner.client === null ||
        client !== owner.client ||
        activeIngestionLagOwner !== owner
      ) {
        return;
      }
      if (sample.catchingUp) {
        owner.hasPositiveSample = true;
        emitIngestionLagObservation(sample);
      } else if (owner.hasPositiveSample) {
        owner.hasPositiveSample = false;
        emitIngestionLagObservation(null);
      }
    };
    let activeTurn: QueuedCodexMessage | undefined;
    let lastExecutionUserMessageId: string | undefined;
    let activeProviderOwnedEvidence:
      | {
          generation: NonNullable<
            ReturnType<typeof getProviderRunDescriptor>
          >['generation'];
          threadId: string;
          turnId: string;
          executionUserMessageId: string;
        }
      | undefined;
    let managedDelegation: ManagedDelegationSession | undefined;
    let managedInitialization: Promise<void> | undefined;
    let currentApprovalMode: ApprovalMode = opts.approvalMode ?? 'ask';
    const rawApprovalSession: ApprovalSessionHandle = createApprovalSession({
      sessionKey: key,
      getTurnUserMessageId: () => activeTurn?.userMessageId,
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      provider: 'codex',
      workspaceRoot: opts.cwd,
      mode: currentApprovalMode,
      // The live rule list children's approvals are evaluated against.
      sessionRules: sessionOpts.sessionApprovalRules ?? [],
      getWindow,
      onAwaitingUser: () => turnState.markTurnAwaitingUser(),
    });
    const approvalSession: ApprovalSessionHandle = {
      check: (approvalCheck, display) =>
        turnCancelling
          ? Promise.resolve({
              decision: 'deny',
              message: 'The owning turn was cancelled.',
            })
          : rawApprovalSession.check(approvalCheck, display),
      setMode: (mode) => rawApprovalSession.setMode(mode),
      // Delegated for interface completeness. The chat-wide broadcast reaches
      // `rawApprovalSession` directly through the approval-session registry,
      // which enrolled it at construction, so this wrapper is not on that path.
      reevaluatePendingApprovals: (mode, previousMode) =>
        rawApprovalSession.reevaluatePendingApprovals(mode, previousMode),
      invalidatePending: () => rawApprovalSession.invalidatePending?.(),
      dispose: () => rawApprovalSession.dispose(),
    };
    const beginTurnCancellation = (): void => {
      turnCancelling = true;
      turnPreparationController.abort(new Error('turn_cancelled'));
      approvalSession.invalidatePending?.();
    };
    // Pipeline-editor sessions intentionally start a fresh thread, but once
    // that thread exists it can still be released and resumed after idling.
    let rootThreadId =
      opts.assistantMode === 'pipeline-editor' ? undefined : opts.sdkSessionId;
    const sourceProviderType = this.providerType;

    const clearIdleTimer = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const hasLiveCodexBackgroundWork = (
      candidateClient: CodexAppServerClient,
    ): boolean => {
      const snapshot = codexBackgroundSnapshots.get(candidateClient);
      return (
        candidateClient.hasLiveBackgroundWork() ||
        (snapshot !== undefined &&
          (snapshot.work.length > 0 || snapshot.reconciling))
      );
    };

    const retireCodexBackgroundManagerToken = (
      owner: CodexBackgroundSessionOwner,
    ): void => {
      const token = owner.token;
      owner.token = undefined;
      if (token) retireCodexLiveBackgroundTasks(token);
    };

    const detachCodexBackgroundOwner = (
      retiredClient: CodexAppServerClient | null,
    ): void => {
      if (!retiredClient) return;
      const owner = codexBackgroundOwners.get(retiredClient);
      if (!owner) return;

      owner.detached = true;
      owner.unsubscribe?.();
      owner.unsubscribe = undefined;
      codexBackgroundOwners.delete(retiredClient);
      retireCodexBackgroundManagerToken(owner);
    };

    const retireClientSessionOwners = (
      retiredClient: CodexAppServerClient | null,
    ): void => {
      retireIngestionLagOwner(retiredClient);
      detachCodexBackgroundOwner(retiredClient);
    };

    const publishCodexBackgroundSnapshot = (
      owner: CodexBackgroundSessionOwner,
      snapshot: CodexBackgroundSnapshot,
      registerIfNeeded: boolean,
    ): void => {
      if (!owner.token && registerIfNeeded && snapshot.work.length > 0) {
        owner.token = registerCodexBackgroundOwner(lifecycleScope);
      }
      if (owner.token) {
        replaceCodexLiveBackgroundTasks(owner.token, {
          revision: snapshot.revision,
          // A command its turn still waits on shows in the transcript, not
          // as background work.
          tasks: snapshot.work
            .filter((work) => work.kind !== 'terminal' || !work.foreground)
            .map(toCodexLiveBackgroundTaskInput),
        });
      }
    };

    const releaseIdleClient = (): void => {
      const idleClient = client;
      if (
        destroyed ||
        turnInProgress ||
        !idleClient ||
        idleClient.hasActiveTurn() ||
        hasLiveCodexBackgroundWork(idleClient)
      ) {
        return;
      }
      if (managedDelegation?.activeCount) {
        releaseClientAfterDelegation = true;
        return;
      }
      releaseClientAfterDelegation = false;

      // Preserve the durable thread identity before disposing the owner. The
      // client disposal path sends thread/unsubscribe while a shared profile
      // worker remains alive, allowing Codex to tear down thread-scoped tool
      // subprocesses without waiting for the entire pooled app-server to go
      // idle. The next message recreates a client and resumes this thread.
      disposeClient(idleClient);
    };

    const disposeClient = (disposedClient: CodexAppServerClient): void => {
      if (client !== disposedClient) return;
      clearIdleTimer();
      forceClientReleaseAfterTurn = false;
      forceClientReleaseAfterDelegation = false;
      forceClientReleaseAfterBackgroundWork = false;
      releaseClientAfterDelegation = false;
      rootThreadId = disposedClient.getThreadId() ?? rootThreadId;
      retireClientSessionOwners(disposedClient);
      disposedClient.dispose();
      if (client === disposedClient) {
        client = null;
        notifySteeringEligibilityChanged(key);
      }
    };

    // Rebuilds the client for a changed thread config once nothing still runs
    // on it: a turn, a managed delegation, or native background work such as
    // a terminal, which releasing the last owner would kill.
    const releaseClientForReload = (): void => {
      const live = client;
      if (!live) return;
      if (turnInProgress) {
        forceClientReleaseAfterTurn = true;
      } else if (managedDelegation?.activeCount) {
        forceClientReleaseAfterDelegation = true;
      } else if (hasLiveCodexBackgroundWork(live)) {
        forceClientReleaseAfterBackgroundWork = true;
      } else {
        disposeClient(live);
      }
    };

    const scheduleIdleClientRelease = (): void => {
      clearIdleTimer();
      if (
        destroyed ||
        turnInProgress ||
        !client ||
        client.hasActiveTurn() ||
        hasLiveCodexBackgroundWork(client)
      ) {
        return;
      }

      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (
          destroyed ||
          turnInProgress ||
          !client ||
          client.hasActiveTurn() ||
          hasLiveCodexBackgroundWork(client)
        ) {
          return;
        }
        releaseIdleClient();
      }, currentIdleTimeoutMinutes * 60_000);
      idleTimer.unref?.();
    };

    const handleCodexBackgroundSnapshot = (
      owner: CodexBackgroundSessionOwner,
      snapshot: CodexBackgroundSnapshot,
    ): void => {
      if (owner.detached || destroyed || owner.client !== client) {
        return;
      }

      if (snapshot.epoch !== owner.epoch) {
        owner.epoch = snapshot.epoch;
        owner.revision = snapshot.revision;
        codexBackgroundSnapshots.set(owner.client, snapshot);
        // A new epoch means the prior process's registry is no longer an
        // authority for this client. Retire its Manager token, but keep the
        // client subscription so recovered work from the new epoch can acquire
        // a fresh token. This callback is state delivery only, never session
        // teardown.
        retireCodexBackgroundManagerToken(owner);
        publishCodexBackgroundSnapshot(owner, snapshot, true);
      } else {
        if (snapshot.revision <= owner.revision) return;
        owner.revision = snapshot.revision;
        codexBackgroundSnapshots.set(owner.client, snapshot);
        publishCodexBackgroundSnapshot(owner, snapshot, true);
      }

      if (hasLiveCodexBackgroundWork(owner.client)) {
        clearIdleTimer();
      } else if (!turnInProgress) {
        // A completion snapshot can be observed while the raw item event is
        // still being projected by the client. Defer a pending idle release
        // until after that event has had a chance to reach the session. A
        // reload waiting on this work runs at the next send or turn end, or
        // with that idle release.
        scheduleIdleClientRelease();
      }
    };

    const registerCodexBackgroundClient = (
      nextClient: CodexAppServerClient,
    ): void => {
      if (codexBackgroundOwners.has(nextClient)) return;

      // Subscribe only after taking the initial complete state. The provider
      // registry publishes complete, revisioned snapshots, not event deltas.
      const initialSnapshot = nextClient.getBackgroundSnapshot();
      const token = registerCodexBackgroundOwner(lifecycleScope);
      const owner: CodexBackgroundSessionOwner = {
        client: nextClient,
        token,
        epoch: initialSnapshot.epoch,
        revision: initialSnapshot.revision,
        unsubscribe: undefined,
        detached: false,
      };
      codexBackgroundOwners.set(nextClient, owner);
      codexBackgroundSnapshots.set(nextClient, initialSnapshot);
      publishCodexBackgroundSnapshot(owner, initialSnapshot, false);

      const unsubscribe = nextClient.subscribeBackgroundWork((snapshot) => {
        handleCodexBackgroundSnapshot(owner, snapshot);
      });
      owner.unsubscribe = unsubscribe;
      if (owner.detached) unsubscribe();
    };

    const markCodexTurnStarting = (): void => {
      clearIdleTimer();
      turnPreparationController = new AbortController();
      turnCancelling = false;
      turnInProgress = true;
    };

    const markCodexTurnFinished = (): void => {
      turnInProgress = false;
      turnCancelling = false;
      if (forceClientReleaseAfterTurn) {
        forceClientReleaseAfterTurn = false;
        releaseClientForReload();
      } else if (
        (forceClientReleaseAfterDelegation &&
          !managedDelegation?.activeCount) ||
        forceClientReleaseAfterBackgroundWork
      ) {
        // The delegation or background work may have drained during this
        // turn, so its drain callback could not rebuild the client; do it now
        // that the turn is over.
        forceClientReleaseAfterDelegation = false;
        releaseClientForReload();
      } else if (releaseClientAfterDelegation) {
        releaseIdleClient();
      } else if (!destroyed) {
        scheduleIdleClientRelease();
      }
    };

    const clearCodexTurnInProgress = (): void => {
      turnInProgress = false;
      turnCancelling = false;
    };

    const disposeSession = (): void => {
      if (destroyed) return;
      destroyed = true;
      stopAccountProxySwitches?.();
      stopAccountProxySwitches = undefined;
      clearIdleTimer();
      retireClientSessionOwners(client);
      client?.dispose();
      notifySteeringEligibilityChanged(key);
      approvalSession.dispose();
      skillUsage.dispose();
      getMcpHttpProxyService().unregisterRoutesForSession(pluginRouteOwnerId);
      // A registration that displaced this session tears it down while its
      // successor already owns the key's routes and proxy verdicts.
      if (turnState.ownsKeyResources()) {
        // Codex registers its proxy routes under `pluginRouteOwnerId`, but
        // `worktree-chat-turn.ts` pairs MCP auth failures under the CHAT SESSION
        // KEY for every provider. Without this second call the process-global
        // `pendingByOwner` / `toolNamesByRouteOwner` maps keep `key`-keyed
        // entries with no eviction path (CAN-1814). Harmless when no route is
        // registered under `key`: teardown clears both registries first and then
        // finds no routes to unregister.
        getMcpHttpProxyService().unregisterRoutesForSession(key);
        getCodexGatewayProxyService().unregisterRoutesForSession(key);
        // A verdict recorded but never consumed (the session was torn down before
        // the failure event surfaced) must not outlive the session and arm an
        // unrelated later turn under the same key.
        clearSessionProxyFailure(key);
      }
      void getCodexRuntimeService().revokeStdioMcpRoutes(pluginRouteOwnerId);
      // A torn-down transport never reports turn/completed for its open turns.
      turnLifecycleTracker.closeOpenTurns();
      releaseTurnLifecycleProducer('codex', lifecycleScope);
      unregisterSession(key, session);
      if (waitingForMessage) {
        waitingForMessage(undefined);
        waitingForMessage = null;
      }
    };

    sessionAbort.signal.addEventListener('abort', () => {
      disposeSession();
    });

    const shutdownController = new AbortController();
    let destroyRequested = false;
    let runPromise: Promise<void> = Promise.resolve();
    let destroyPromise: Promise<void> | undefined;
    const session: AgentSession = {
      sendMessage(text: string, sendOptions?: AgentSessionSendOptions): void {
        clearIdleTimer();
        messageQueue.push({
          text,
          submissionId: randomUUID(),
          countsTowardSkillUsage: sendOptions?.countsTowardSkillUsage === true,
          skillUsageTurnId: randomUUID(),
          ...(sendOptions?.userMessageId
            ? { userMessageId: sendOptions.userMessageId }
            : {}),
        });
        turnState.noteSessionMessageQueued(messageQueue.length);
        if (waitingForMessage) {
          const resolver = waitingForMessage;
          waitingForMessage = null;
          resolver(messageQueue.shift());
          turnState.noteSessionMessageQueued(messageQueue.length);
        }
      },
      getProviderSessionId(): string | undefined {
        return client?.getThreadId() ?? rootThreadId;
      },
      usesMcpServerConfig(
        serverId: string,
        configId: string,
      ): { displayName: string } | undefined {
        return getMcpHttpProxyService().getSessionMcpRoute(
          pluginRouteOwnerId,
          serverId,
          configId,
        );
      },
      async reloadMcpServers(): Promise<void> {
        await client?.reloadMcpServers();
      },
      async steerActiveTurn(
        text: string,
        clientUserMessageId?: string,
      ): Promise<boolean> {
        return (
          (await client?.steerActiveTurn(text, clientUserMessageId)) ?? false
        );
      },
      getSteeringCapabilities: () =>
        client?.getSteeringCapabilities() ?? {
          provider: 'codex',
          generation: '',
          steer: false,
          withdraw: false,
          interrupt: false,
        },
      getSteeringTarget: () => client?.getSteeringTarget(),
      getSteeringWorkingDirectory: () => opts.cwd,
      submitSteeringInput: (text, attemptId, userMessageId, target) =>
        client?.submitSteeringInput(text, attemptId, target, userMessageId) ??
        Promise.resolve({
          kind: 'rejected',
          attemptId,
          reason: 'The provider session is not ready',
        }),
      isDisposed(): boolean {
        // cancel() only interrupts the active turn — the message loop keeps
        // draining the queue — so only a destroyed session is dead here.
        return destroyed || destroyRequested;
      },
      async cancel(): Promise<void> {
        beginTurnCancellation();
        // Managed delegation initializes before the Codex message loop. Stop
        // can therefore arrive while the first message is still queued and no
        // client or active turn exists to interrupt. Remove only those pending
        // messages; a later send remains free to reuse this live session.
        if (!activeTurn && messageQueue.length > 0) {
          messageQueue.splice(0);
          turnState.noteSessionMessageQueued(0);
        }
        // Stop ends only the parent turn. Retire that turn's delegation tool
        // bindings; the chat's delegations keep running.
        managedDelegation?.retireTurn();
        await client?.interruptTurn({
          approvalSessionAlreadyInvalidated: true,
        });
      },
      destroy(): Promise<void> {
        if (destroyPromise) return destroyPromise;
        destroyRequested = true;
        shutdownController.abort();
        beginTurnCancellation();
        if (waitingForMessage) {
          waitingForMessage(undefined);
          waitingForMessage = null;
        }
        destroyPromise = (async (): Promise<void> => {
          try {
            await client?.interruptTurn({
              approvalSessionAlreadyInvalidated: true,
            });
            // An interrupt acknowledgement does not guarantee a terminal event.
            // Retire the client after a bounded drain so teardown (including
            // account switching) cannot wait forever for turn/completed. Keep
            // the session registered until the run loop drains its final events.
            const drainTimeout = setTimeout(() => {
              const drainClient = client;
              retireClientSessionOwners(drainClient);
              drainClient?.dispose();
            }, 5_000);
            drainTimeout.unref?.();
            try {
              await runPromise;
            } finally {
              clearTimeout(drainTimeout);
            }
          } finally {
            sessionAbort.abort();
            disposeSession();
          }
        })();
        return destroyPromise;
      },
      setPlanMode(enabled: boolean): Promise<void> {
        currentPlanMode = enabled;
        return Promise.resolve();
      },
      setManagedDelegationMode(mode): void {
        if (mode !== undefined) managedDelegation?.updatePolicy(mode);
      },
      async setApprovalMode(mode: ApprovalMode): Promise<void> {
        currentApprovalMode = mode;
        approvalSession.setMode(mode);
        await client?.setApprovalMode(mode);
      },
      setSpeed(speed: CodexSpeed): Promise<void> {
        setRequestedCodexSpeed(speed);
        return Promise.resolve();
      },
      setFastMode(enabled: boolean): Promise<void> {
        setRequestedCodexSpeed(codexSpeedFromFastMode(enabled));
        return Promise.resolve();
      },
      setCodexFastMode(enabled: boolean): Promise<void> {
        setRequestedCodexSpeed(codexSpeedFromFastMode(enabled));
        return Promise.resolve();
      },
      async setContextWindow(setting): Promise<void> {
        const next: ResolvedAgentModelConfig = { ...currentModelConfig };
        delete next.contextWindow;
        if (setting !== undefined) next.contextWindow = setting;
        currentModelConfig = next;
        const live = client;
        if (!live) return;
        const applied = appliedCodexContextWindows.get(live);
        const usesModelDefault =
          setting === undefined || setting === 'model-default';
        let unchanged = applied
          ? (applied.setting ?? 'model-default') ===
              (setting ?? 'model-default') &&
            (usesModelDefault || applied.model === currentModel)
          : usesModelDefault;
        // The setting wasn't sent for want of bounds; rebuild only once they
        // resolve, so an unreadable catalog doesn't reload every turn.
        if (unchanged && applied?.pending) {
          unchanged = !(
            await resolveCodexContextWindowConfig(setting, applied.pending)
          ).resolved;
        }
        if (unchanged || client !== live) return;
        // The bounds belong to the model, so a model change with a
        // non-default window reloads the thread too.
        releaseClientForReload();
      },
      setCodexProposalMode(mode: 'optional' | 'required'): Promise<void> {
        currentProposalMode = mode;
        return Promise.resolve();
      },
      setCodexAppServerIdleTimeoutMinutes(minutes: number): Promise<void> {
        currentIdleTimeoutMinutes = minutes;
        if (!turnInProgress) {
          scheduleIdleClientRelease();
        }
        return Promise.resolve();
      },
      setThinkingLevel(level: ThinkingLevel): Promise<void> {
        currentThinkingLevel = level;
        currentModelConfig = { ...currentModelConfig, thinkingLevel: level };
        return Promise.resolve();
      },
      async setModel(model: ChatModel): Promise<void> {
        currentModel = model;
        currentSelectedModel = model;
        if (!prepareInvocation) return;
        const prepared = await prepareInvocation(model, 'model-change');
        preparedInvocationState.runtimeModel = prepared.runtimeModel;
        // A not-yet-started client will prepare the latest currentModel during
        // normal initialization. Once initialized, refresh every invocation
        // surface and rebuild the client so Ollama provider config cannot lag
        // behind the newly selected runtime model.
        if (preparedInvocationState.extraEnv !== null) {
          preparedInvocationState.extraEnv = {
            ...preparedInvocationState.extraEnv,
            ...(prepared.envOverride ?? {}),
          };
          preparedInvocationState.threadConfig = mergeCodexConfig(
            preparedInvocationState.threadConfig,
            prepared.codexConfig,
          );
          releaseClientForReload();
        }
      },
    };

    registerSession(
      key,
      session,
      sessionAbort,
      sourceProviderType,
      opts.model,
      opts.assistantMode ?? 'default',
      opts.toolProfileHash,
      codeGraphToolsAdvertised,
      opts.executionHarness,
    );

    // A root terminal carries its execution's lifecycle id, as Claude's do:
    // a stopped turn and its resumed turn share the input ID. A native
    // completion maps its own turn; a session result maps the newest
    // execution bound to its input. Child turns are never tracked.
    const withExecutionTurnId = (data: unknown): unknown => {
      if (
        !isRecord(data) ||
        data.canopy_execution_turn_id !== undefined ||
        !isRootTerminalChatEventData(data, rootThreadId)
      )
        return data;
      const event =
        data.type === 'codex' && isRecord(data.event) ? data.event : undefined;
      const executionTurnId = event
        ? typeof event.thread_id === 'string' &&
          typeof event.turn_id === 'string'
          ? turnLifecycleTracker.executionTurnId(event.thread_id, event.turn_id)
          : undefined
        : typeof data.canopy_turn_user_message_id === 'string'
          ? turnLifecycleTracker.latestExecutionTurnIdFor(
              data.canopy_turn_user_message_id,
            )
          : undefined;
      return executionTurnId === undefined
        ? data
        : { ...data, canopy_execution_turn_id: executionTurnId };
    };

    const emitEvent = (data: unknown): void | Promise<void> => {
      // This callback receives the app-server client's mapped event after its
      // shared admission lane. The stamp intentionally starts here, not at the
      // raw app-server notification entry.
      const receivedAtMonotonicMs = performance.now();
      const providerRunClassification = classifyProviderRunEvent(data, {
        projectId: opts.projectId,
        worktreeId: opts.worktreeId,
        chatId: opts.chatId,
      });
      if (providerRunClassification.kind === 'reject') {
        const event = isRecord(data) && isRecord(data.event) ? data.event : {};
        const eventType =
          typeof event.type === 'string' ? event.type : 'unknown';
        recordChatEventDropped({
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          providerType: 'codex',
          gate: eventType.startsWith('item.')
            ? 'codex_root_output_stale'
            : 'codex_root_completion_stale',
          reason: providerRunClassification.reason,
          data: {
            eventType,
            ...(typeof event.thread_id === 'string'
              ? { threadId: event.thread_id }
              : {}),
            ...(typeof event.turn_id === 'string'
              ? { turnId: event.turn_id }
              : {}),
          },
        });
        return;
      }
      if (providerRunClassification.kind === 'transcript_only') {
        const eventData = withTurnMetadata(data, undefined);
        if (isRecord(eventData)) {
          recordEventReceiptTime(eventData, receivedAtMonotonicMs);
        }
        return onEvent(eventData);
      }
      const runDescriptor = getProviderRunDescriptor(data);
      const trustedRun =
        providerRunClassification.kind === 'ordinary'
          ? providerRunClassification.run
          : undefined;
      const rawEvent = isRecord(data) && isRecord(data.event) ? data.event : {};
      if (
        trustedRun?.origin === 'provider_owned' &&
        rawEvent.type === 'turn.started' &&
        rawEvent.thread_id === trustedRun.threadId &&
        rawEvent.turn_id === trustedRun.turnId
      ) {
        activeProviderOwnedEvidence = {
          generation: trustedRun.generation,
          threadId: trustedRun.threadId,
          turnId: trustedRun.turnId,
          executionUserMessageId: trustedRun.executionUserMessageId,
        };
        beginCodexSessionTurn(key, trustedRun.executionUserMessageId);
      }
      if (trustedRun) {
        lastExecutionUserMessageId = trustedRun.executionUserMessageId;
      }
      managedDelegation?.observe(
        data,
        trustedRun?.executionUserMessageId ?? activeTurn?.userMessageId,
        client?.getThreadId(),
      );
      rootThreadId = readCodexRootThreadId(data) ?? rootThreadId;
      // Held until after `onEvent(eventData)` below. Ordering is load-bearing
      // for any terminal event the transcript reducer turns into a `system`
      // notice: that notice is written while reducing THIS same event, so
      // emitting first would find no anchor at all.
      //
      // Ordering is NOT what keeps the failure off the wrong block — but the
      // earlier claim that a Codex `unauthorized` turn failure writes no block
      // was simply wrong (CAN-1814 review round 2). Codex reports it on
      // `turn.failed` or `error`, and BOTH reducer handlers
      // (`handleCodexTurnFailed`, `handleCodexError`) call
      // `buildCodexSystemTextMessage`, writing `{ role: 'system', blocks: [{
      // type: 'text', text: 'Error: Unauthorized' }] }` — the failure does
      // attach there.
      //
      // What writes NO block is a 401 that `classifyAgentFailure` reads off
      // buffered strings/statuses on an event the reducer never turns into a
      // notice. For those, `attachAuthFailureToMessages` deliberately attaches
      // nothing rather than falling back to the newest text block — which was
      // the user's own prompt bubble (CAN-1814 review).
      let providerAuthEvent: CanopyAuthFailureEventData | null = null;
      const accountScope = isSessionAiCreditsRouted(
        opts.projectId,
        opts.worktreeId,
        opts.chatId,
      )
        ? 'ai_credits'
        : 'native';
      // Apply the local proxy's out-of-band verdict for this turn, if it left
      // one. Codex strips the marked hosted body from the error it reports, so
      // for that provider this is the ONLY signal; the string scan below still
      // covers bodies that do survive. The latch is read-and-clear, hence the
      // failure-shape gate first — consuming it on a delta or a completed turn
      // would discard the verdict the failing turn needs.
      const proxyFailure =
        accountScope === 'ai_credits' && isAiCreditsFailureEvent(data)
          ? consumeSessionProxyFailure(key)
          : undefined;
      const restoredData = proxyFailure
        ? withProxyFailureRestored(data, proxyFailure)
        : data;
      const stampedData =
        proxyFailure && isRecord(restoredData)
          ? copyProviderRunProvenance(data, restoredData)
          : restoredData;
      const eventData = withExecutionTurnId(
        withTurnMetadata(stampedData, activeTurn),
      );
      const rawTerminalOutcome = readCodexTurnTerminalOutcome(eventData);
      const providerOwnedTerminal =
        trustedRun?.origin === 'provider_owned' &&
        rawTerminalOutcome !== undefined &&
        activeProviderOwnedEvidence?.generation === trustedRun.generation &&
        activeProviderOwnedEvidence.threadId === trustedRun.threadId &&
        activeProviderOwnedEvidence.turnId === trustedRun.turnId;
      if (providerOwnedTerminal && trustedRun) {
        recordCodexTurnEnd(key, {
          turnUserMessageId: trustedRun.executionUserMessageId,
          outcome: rawTerminalOutcome,
          endedAtMs: Date.now(),
        });
      }
      if (
        isRecord(eventData) &&
        eventData.type === 'codex' &&
        activeTurn &&
        rawTerminalOutcome !== undefined &&
        !isCodexSubagentTerminalEvent(eventData, rootThreadId)
      ) {
        recordCodexTurnEnd(key, {
          ...(activeTurn.userMessageId !== undefined
            ? { turnUserMessageId: activeTurn.userMessageId }
            : {}),
          outcome: rawTerminalOutcome,
          endedAtMs: Date.now(),
        });
      }
      // A proxy account's sign-in or limit is not the user's own, so it never
      // starts native account recovery (CAN-4020).
      const resumeReason = isSessionAccountProxyRouted(
        opts.projectId,
        opts.worktreeId,
        opts.chatId,
      )
        ? null
        : classifyAccountChangeResumeReason('codex', data, accountScope);
      // Reads the STAMPED event so the live banner and the persisted per-tab
      // flag are decided by one value, whichever signal established it.
      const sideAdmissions: Promise<void>[] = [];
      // Every notice derived from this event names the thread it came from, so
      // a sub-agent's failure is never read as the root turn's (CAN-4629).
      const emitDerivedNotice = scopeDerivedNotices(onEvent, eventData);
      // Account-limit notices can precede a successful turn. Only the
      // settled root result can create an automatic quota continuation.
      const proxyInterruption =
        isRecord(data) &&
        data.type === 'result' &&
        data.is_error === true &&
        isSessionAccountProxyRouted(
          opts.projectId,
          opts.worktreeId,
          opts.chatId,
        )
          ? buildAccountProxyUsageLimitedEntry(
              {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                provider: 'codex',
                detectedAt: Date.now(),
                accountProxyConnectionId,
                interruptedUserMessageId: activeTurn?.userMessageId,
              },
              data,
            )
          : null;
      if (
        proxyInterruption &&
        !isCodexSubagentTerminalEvent(data, rootThreadId)
      ) {
        sideAdmissions.push(recordUsageLimitedChat(proxyInterruption));
      }

      if (
        accountScope === 'ai_credits' &&
        detectAiCreditsNoBillingSource(eventData)
      ) {
        const admission = emitAiCreditsNoBillingSource(
          emitDerivedNotice,
          'codex',
        );
        if (admission && typeof admission.then === 'function') {
          sideAdmissions.push(admission);
        }
      }
      // Feed the common on-quota state so any surface's next session recreates
      // through AI Credits when Codex's native quota is reached (CAN-838), and
      // surface the shared usage-limit banner on every chat surface.
      const quota = detectCodexQuotaReached(data);
      if (resumeReason === 'usage_limit' && quota.reached) {
        markProviderQuotaReached('codex', quota.resetsAt);
        const admission = emitAiCreditsUsageLimitReached(
          emitDerivedNotice,
          'codex',
          quota.resetsAt,
        );
        if (admission && typeof admission.then === 'function') {
          sideAdmissions.push(admission);
        }
        void (async (): Promise<void> => {
          const interruptedUserMessageId = activeTurn?.userMessageId;
          const workspace = await resolveWorkspaceRecordingSnapshot(
            opts.projectId,
          );
          await recordUsageLimitedChat(
            buildUsageLimitedEntry({
              interruptedUserMessageId,
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              provider: 'codex',
              detectedAt: Date.now(),
              resumeReason,
              ...(typeof quota.resetsAt === 'number'
                ? { resetsAt: quota.resetsAt }
                : {}),
              workspaceName: workspace.name,
              ...(workspace.type ? { workspaceType: workspace.type } : {}),
              chatTitle: '',
            }),
          );
        })();
      }
      if (resumeReason === 'authentication' && accountScope === 'native') {
        const classification = classifyAgentFailure({
          provider: 'codex',
          accountScope,
          events: [data],
          error: data,
        });
        if (classification) {
          providerAuthEvent = buildProviderAuthFailureEvent(classification);
        }
        void (async (): Promise<void> => {
          const interruptedUserMessageId = activeTurn?.userMessageId;
          const workspace = await resolveWorkspaceRecordingSnapshot(
            opts.projectId,
          );
          await recordUsageLimitedChat(
            buildUsageLimitedEntry({
              interruptedUserMessageId,
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              provider: 'codex',
              detectedAt: Date.now(),
              resumeReason,
              workspaceName: workspace.name,
              ...(workspace.type ? { workspaceType: workspace.type } : {}),
              chatTitle: '',
            }),
          );
        })();
      }
      turnState.recordSessionEvent(eventData);
      if (!isCodexSubagentTerminalEvent(eventData, rootThreadId)) {
        const attentionFailure = noteChatSessionEvent(
          {
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
          },
          'codex',
          eventData,
        );
        if (attentionFailure?.kind === 'non_retryable_failure') {
          getAttentionTracker().mark({
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            state: 'blocked',
            reason: 'error',
            sourceId: 'terminal-error',
            ...(attentionFailure.detail
              ? { detail: attentionFailure.detail }
              : {}),
          });
        }
      }
      // `recordSessionEvent` is session bookkeeping (lastActivityAt,
      // lastEventType, wake lock) and never reaches the renderer; `onEvent` is
      // the delivery path. Deliberately NOT also recorded: stamping
      // `lastEventType: 'canopy_auth_failure'` after a terminal turn event
      // would hide the terminal event from restore.
      const sourcedAuthEvent = providerAuthEvent
        ? withFailureSourceScope(providerAuthEvent, data)
        : null;
      const authEvent = sourcedAuthEvent
        ? withTurnMetadata(
            runDescriptor
              ? copyProviderRunProvenance(data, sourcedAuthEvent)
              : sourcedAuthEvent,
            activeTurn,
          )
        : null;
      const deliverRecordedEvent = (): void | Promise<void> => {
        if (typeof eventData === 'object' && eventData !== null) {
          recordEventReceiptTime(eventData, receivedAtMonotonicMs);
        }
        const eventAdmission = onEvent(eventData);
        const eventReceipt =
          eventAdmission && typeof eventAdmission.then === 'function'
            ? eventAdmission
            : undefined;
        const finishProviderOwnedEvidence = (): void => {
          if (!providerOwnedTerminal || !trustedRun) return;
          const identity = activeProviderOwnedEvidence;
          if (
            identity?.generation !== trustedRun.generation ||
            identity.threadId !== trustedRun.threadId ||
            identity.turnId !== trustedRun.turnId
          ) {
            return;
          }
          finishCodexSessionTurn(key, trustedRun.executionUserMessageId);
          activeProviderOwnedEvidence = undefined;
        };
        if (!authEvent) {
          if (!eventReceipt) {
            finishProviderOwnedEvidence();
            return;
          }
          return eventReceipt.finally(finishProviderOwnedEvidence);
        }
        // Stamped like every other emitted event. Only terminal events consult
        // `canopy_turn_user_message_id` today, but an event that skipped
        // `withTurnMetadata` is a latent trap for anything that later groups by
        // turn.
        const deliverAuthEvent = (): void | Promise<void> => {
          if (typeof authEvent === 'object' && authEvent !== null) {
            recordEventReceiptTime(authEvent, receivedAtMonotonicMs);
          }
          return onEvent(authEvent);
        };
        const completeAdmission = eventReceipt
          ? eventReceipt.then(deliverAuthEvent)
          : deliverAuthEvent();
        if (
          !completeAdmission ||
          typeof completeAdmission.then !== 'function'
        ) {
          finishProviderOwnedEvidence();
          return completeAdmission;
        }
        return completeAdmission.finally(finishProviderOwnedEvidence);
      };
      // A side notice and its source event share one transport receipt. Delay
      // the latter until earlier notices have entered the canonical route.
      return sideAdmissions.length > 0
        ? Promise.all(sideAdmissions).then(deliverRecordedEvent)
        : deliverRecordedEvent();
    };

    const runSession = (): Promise<void> =>
      this._runSession(
        sessionOpts,
        messageQueue,
        (resolver) => {
          waitingForMessage = resolver;
        },
        () => currentThinkingLevel,
        () => currentModel,
        () => currentPlanMode,
        () => currentModelConfig,
        () => currentProposalMode,
        () => destroyed || destroyRequested,
        (message) => {
          activeTurn = message;
          if (message === undefined) return;
          beginCodexSessionTurn(key, message.userMessageId);
          // Clears a prior plan-review or terminal-error attention edge when the
          // human starts the next turn.
          getAttentionTracker().clear(
            opts.projectId,
            opts.worktreeId,
            opts.chatId,
          );
        },
        () => {
          activeTurn = undefined;
        },
        markCodexTurnStarting,
        markCodexTurnFinished,
        clearCodexTurnInProgress,
        beginTurnCancellation,
        emitEvent,
        onTurnLifecycleObservation,
        skillUsage,
        key,
        pluginRouteOwnerId,
        getWindow,
        () => rootThreadId,
        () => lastExecutionUserMessageId,
        (userMessageId) => {
          lastExecutionUserMessageId = userMessageId;
        },
        (changedClient) => {
          notifySteeringEligibilityChanged(key);
          if (!changedClient || client !== changedClient) return;
          if (changedClient.hasActiveTurn()) {
            clearIdleTimer();
          } else if (!turnInProgress) {
            scheduleIdleClientRelease();
          }
        },
        () => client,
        (next) => {
          const previousClient = client;
          if (previousClient !== next) {
            retireClientSessionOwners(previousClient);
          }
          client = next;
          if (next && previousClient !== next) {
            registerCodexBackgroundClient(next);
          }
          activeIngestionLagOwner = next
            ? (ingestionLagOwners.get(next) ?? null)
            : null;
          notifySteeringEligibilityChanged(key);
        },
        approvalSession,
        () => currentApprovalMode,
        preparedInvocationState,
        managedDelegation,
        shutdownController.signal,
        () => turnPreparationController.signal,
        emitIngestionLagSample,
        (createdClient, owner): void => {
          ingestionLagOwners.set(createdClient, owner);
        },
        retireClientSessionOwners,
        (connectionId) => {
          accountProxyConnectionId = connectionId;
          // The transcript's account switch lines, once per session while
          // the proxy serves it (CAN-4021).
          if (connectionId !== undefined) {
            stopAccountProxySwitches ??= watchAccountProxySwitches(
              key,
              emitEvent,
            );
          }
        },
        () => unregisterSession(key, session),
        turnState,
      );

    if (managedDelegationEnabled(sessionOpts)) {
      managedInitialization = (async (): Promise<void> => {
        const initializationDelayMs = Number.parseInt(
          process.env.CANOPY_E2E_MANAGED_DELEGATION_INITIALIZATION_DELAY_MS ??
            '',
          10,
        );
        if (
          Number.isInteger(initializationDelayMs) &&
          initializationDelayMs > 0 &&
          initializationDelayMs <= 10_000
        )
          await new Promise<void>((resolve) =>
            setTimeout(resolve, initializationDelayMs),
          );
        // Defer the cycle-breaking delegation service load until this session
        // actually enables managed child agents.
        const { createManagedDelegationSession } =
          await import('./delegation/service');
        managedDelegation = await createManagedDelegationSession({
          harness: 'codex',
          onTranscript: (delegation, options): void => {
            void Promise.resolve(
              onEvent({
                type: 'canopy_delegation',
                delegation,
                canopy_turn_user_message_id: delegation.parentTurnId,
                ...(options?.replay ? { canopy_replay: true } : {}),
              }),
            ).catch((error: unknown) =>
              logMainProcessWarn(
                '[codex-session] Delegation transcript delivery failed',
                error,
              ),
            );
          },
          sessionKey: key,
          getWindow,
          currentOptions: () => ({
            ...sessionOpts,
            model: currentModel,
            selectedModel: currentSelectedModel,
            thinkingLevel: currentThinkingLevel,
            modelConfig: currentModelConfig,
            approvalMode: currentApprovalMode,
            planMode: currentPlanMode,
          }),
          currentTurn: () => activeTurn?.userMessageId,
          onActivityChange: (count): void => {
            if (count !== 0) return;
            if (forceClientReleaseAfterDelegation && !turnInProgress) {
              forceClientReleaseAfterDelegation = false;
              releaseClientForReload();
            } else if (releaseClientAfterDelegation) {
              releaseIdleClient();
            }
          },
        });
        if (destroyed || destroyRequested) {
          managedDelegation.detach();
          return;
        }
      })();
    }
    runPromise = managedInitialization
      ? managedInitialization.then(() =>
          destroyed || destroyRequested ? undefined : runSession(),
        )
      : runSession();
    void runPromise.catch((error: unknown) => {
      turnState.markTurnIdle();
      logMainProcessWarn('[codex-session] Managed session failed', error);
      void Promise.resolve(
        emitEvent({
          type: 'error',
          error:
            'The managed session could not start or finish its owned cleanup.',
        }),
      ).catch((deliveryError: unknown) =>
        logMainProcessWarn(
          '[codex-session] Failed to report managed session failure',
          deliveryError,
        ),
      );
      disposeSession();
    });
    return session;
  }

  private async _runSession(
    opts: AgentSessionOptions,
    messageQueue: QueuedCodexMessage[],
    setWaiter: (
      resolver: ((msg: QueuedCodexMessage | undefined) => void) | null,
    ) => void,
    getThinkingLevel: () => ThinkingLevel,
    getModel: () => ChatModel | undefined,
    getPlanMode: () => boolean,
    getModelConfig: () => ResolvedAgentModelConfig,
    getProposalMode: () => 'optional' | 'required',
    isDestroyed: () => boolean,
    setActiveTurn: (message: QueuedCodexMessage | undefined) => void,
    clearActiveTurn: () => void,
    markCodexTurnStarting: () => void,
    markCodexTurnFinished: () => void,
    clearCodexTurnInProgress: () => void,
    beginTurnCancellation: () => void,
    onEvent: (data: unknown) => void | Promise<void>,
    onTurnLifecycleObservation: (
      observation: CodexTurnTrackerObservation,
    ) => void,
    skillUsage: SkillUsageTracker,
    key: string,
    pluginRouteOwnerId: string,
    getWindow: () => BrowserWindow | null,
    getResumeThreadId: () => string | undefined,
    getLastExecutionUserMessageId: () => string | undefined,
    setLastExecutionUserMessageId: (userMessageId: string) => void,
    onClientSteeringEligibilityChanged: (
      changedClient: CodexAppServerClient | null,
    ) => void,
    getClient: () => CodexAppServerClient | null,
    setClient: (client: CodexAppServerClient | null) => void,
    approvalSession: ApprovalSessionHandle,
    getApprovalMode: () => ApprovalMode,
    preparedInvocationState: {
      runtimeModel?: string;
      extraEnv: Record<string, string> | null;
      threadConfig?: NonNullable<ThreadStartParams['config']>;
    },
    managedDelegation: ManagedDelegationSession | undefined,
    shutdownSignal: AbortSignal,
    getTurnPreparationSignal: () => AbortSignal,
    handleIngestionLagSample: (
      owner: CodexIngestionLagOwner,
      sample: ChatIngestionLag,
    ) => void,
    registerIngestionLagOwner: (
      client: CodexAppServerClient,
      owner: CodexIngestionLagOwner,
    ) => void,
    retireClientSessionOwners: (client: CodexAppServerClient | null) => void,
    setAccountProxyConnectionId: (connectionId: string | undefined) => void,
    unregisterOwnSession: () => void,
    turnState: OwnedTurnState,
  ): Promise<void> {
    const codeGraphToolsAdvertised =
      opts.codeGraphToolsAdvertised ??
      isCodeGraphAvailableForWorkspace(opts.projectId);
    let resultEmitted = false;
    let terminalAdmissionFailed = false;
    let currentMessage: QueuedCodexMessage | undefined;
    let currentExecutionUserMessageId: string | undefined;
    const emitTerminal = async (data: unknown): Promise<void> => {
      if (getClient()?.hasProviderOwnedTurn()) return;
      const terminalOutcome = readCodexTurnTerminalOutcome(data);
      const executionUserMessageId = currentMessage
        ? currentExecutionUserMessageId
        : undefined;
      if (currentMessage && terminalOutcome !== undefined) {
        recordCodexTurnEnd(key, {
          ...(executionUserMessageId !== undefined
            ? { turnUserMessageId: executionUserMessageId }
            : {}),
          outcome: terminalOutcome,
          endedAtMs: Date.now(),
        });
        // Ends the execution's lifecycle turn if its native turn/completed
        // never arrived; a completed one is already closed.
        if (executionUserMessageId !== undefined)
          onTurnLifecycleObservation({
            type: 'execution-ended',
            userMessageId: executionUserMessageId,
            status: terminalOutcome,
          });
      }
      try {
        const anchoredData =
          executionUserMessageId && isRecord(data)
            ? {
                ...data,
                canopy_turn_user_message_id: executionUserMessageId,
              }
            : data;
        await onEvent(anchoredData);
      } catch (error) {
        terminalAdmissionFailed = true;
        throw error;
      } finally {
        if (currentMessage && terminalOutcome !== undefined) {
          finishCodexSessionTurn(key, executionUserMessageId);
        }
      }
    };
    let hasRetriedUnknownDynamicTool = false;
    const ledgerTarget: LedgerChatTarget = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      assistantMode: opts.assistantMode,
    };
    // App Advisor advertises the Ledger tools under its own names, so its
    // prompt, hint and Plan mode note name those.
    const ledgerToolNames =
      opts.assistantMode === 'app-advisor'
        ? getAppAdvisorLedgerToolNames('codex')
        : undefined;
    // Decided once, with the session's first client. Dynamic tools are fixed
    // when a thread starts, so a later client never adds or drops the Ledger
    // tools; each call re-checks the flag and setting instead. A holder,
    // because the client factory assigns it and the turn loop reads it.
    const ledger: { decided: boolean; tools: LedgerChatToolsSession | null } = {
      decided: false,
      tools: null,
    };
    let codexStandaloneInvocationEntries: InvocationTokenInventoryEntry[] = [];
    // Per thread, not per session. A session outlives its threads (rebuilds,
    // capability transitions), and a session-wide latch would surface the raw
    // Responses API error for a later, independently poisoned thread with no
    // recovery short of destroying the session. Membership still bounds each
    // thread to one rebuild.
    const incompatibleReasoningRetriedThreadIds = new Set<string>();
    const staleProxyRouteRetriedThreadIds = new Set<string>();
    const recordCodexProcessDiagnostic = (diagnostic: {
      kind:
        | 'codex_process_started'
        | 'codex_process_exit'
        | 'codex_process_error'
        | 'codex_process_recovery';
      pid?: number;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderrTail?: string;
      stderrTruncated?: boolean;
      uptimeMs?: number | null;
      codexClientCount?: number;
      codexActiveTurnCount?: number;
      recoveryScheduled?: boolean;
      recoveryStatus?: 'succeeded' | 'failed';
      recoveryStrategy?:
        | 'restarted'
        | 'reconciled'
        | 'reattached'
        | 'replayed'
        | 'continued';
      error?: string;
    }): void => {
      getExecutionObservabilityIngest().recordSessionDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: diagnostic.kind,
        sessionKey: key,
        projectId: opts.projectId,
        worktreeId: opts.worktreeId,
        chatId: opts.chatId,
        providerType: 'codex',
        ...(getModel() ? { model: getModel() } : {}),
        ...(typeof diagnostic.pid === 'number' ? { pid: diagnostic.pid } : {}),
        ...(typeof diagnostic.exitCode !== 'undefined'
          ? { exitCode: diagnostic.exitCode }
          : {}),
        ...(typeof diagnostic.signal !== 'undefined'
          ? { signal: diagnostic.signal }
          : {}),
        ...(diagnostic.stderrTail ? { stderrTail: diagnostic.stderrTail } : {}),
        ...(typeof diagnostic.stderrTruncated === 'boolean'
          ? { stderrTruncated: diagnostic.stderrTruncated }
          : {}),
        ...(typeof diagnostic.uptimeMs !== 'undefined'
          ? { uptimeMs: diagnostic.uptimeMs }
          : {}),
        ...(typeof diagnostic.codexClientCount === 'number'
          ? { codexClientCount: diagnostic.codexClientCount }
          : {}),
        ...(typeof diagnostic.codexActiveTurnCount === 'number'
          ? { codexActiveTurnCount: diagnostic.codexActiveTurnCount }
          : {}),
        ...(typeof diagnostic.recoveryScheduled === 'boolean'
          ? { recoveryScheduled: diagnostic.recoveryScheduled }
          : {}),
        ...(diagnostic.recoveryStatus
          ? { recoveryStatus: diagnostic.recoveryStatus }
          : {}),
        ...(diagnostic.recoveryStrategy
          ? { recoveryStrategy: diagnostic.recoveryStrategy }
          : {}),
        ...(diagnostic.error ? { error: diagnostic.error } : {}),
      });
    };

    try {
      let workspaceEnvironmentProfile: CodexRuntimeEnvironmentProfile | null =
        null;
      let resolvedMcpServersConfig:
        | ResolvedPlugins['codexMcpServers']
        | undefined;
      let selectedCapabilityRoots: ResolvedPlugins['selectedCapabilityRoots'] =
        [];
      let codexConfigArgs: string[] | undefined;
      let aiCreditsRoutingApplied = false;
      let initialGatewaySelection: string | undefined;
      let accountProxyRoutingApplied = false;
      setAccountProxyConnectionId(undefined);
      const gatewayTurnModels = new Map<
        string,
        {
          gatewayModel: string;
          supportedThinkingLevels: readonly ThinkingLevel[];
        }
      >();
      let initialThreadId =
        opts.assistantMode === 'pipeline-editor'
          ? undefined
          : (getResumeThreadId() ?? opts.sdkSessionId);
      let forceMaterializeOnResume = false;

      /**
       * Resolve AI Credits routing for the model the next turn will actually
       * use, and fold the result into the prepared invocation state.
       *
       * Resolved against the *current* model rather than `opts.model`: the
       * session captures `opts` at creation, but `setModel` can move the
       * selection before the first turn and again between turns, and routing
       * that describes a model the turn will not send is worse than no routing
       * at all.
       *
       * Throws the backstop abort when the resolver has already told the user
       * why the model cannot run, mirroring the original inline behavior.
       */
      const applyAiCreditsRouting = async (): Promise<void> => {
        if (
          opts.requiredAccountProxyConnectionId &&
          (this.providerType === 'ollama' ||
            isAiCreditsChosenOverAccountProxy(
              opts.aiCreditsRouting,
              opts.subscriptionBillingOverride,
            ) ||
            opts.accountProxyRouting === 'off' ||
            isGatewayOnlyModel(getModel() ?? opts.model))
        )
          throw new Error(
            'The account proxy connection for this continuation is unavailable.',
          );
        // The account proxy the user turned on for this device goes first,
        // unless AI Credits were chosen for this chat or for every session
        // (CAN-4020, CAN-4090). It
        // keeps the native model and reasoning, so it is not an AI Credits
        // route for anything below.
        if (
          !accountProxyRoutingApplied &&
          this.providerType !== 'ollama' &&
          !isAiCreditsChosenOverAccountProxy(
            opts.aiCreditsRouting,
            opts.subscriptionBillingOverride,
          ) &&
          opts.accountProxyRouting !== 'off'
        ) {
          const accountProxyRoute = await resolveAccountProxySessionRoute({
            harness: 'codex',
            requiredConnectionId: opts.requiredAccountProxyConnectionId,
            signal: AbortSignal.any([
              shutdownSignal,
              getTurnPreparationSignal(),
            ]),
            model: getModel() ?? opts.model,
            sessionId: key,
            resolveWorkOwner: () => resolveSessionWorkOwner(opts),
          });
          if (accountProxyRoute?.codexConfig) {
            preparedInvocationState.threadConfig = mergeCodexConfig(
              preparedInvocationState.threadConfig,
              accountProxyRoute.codexConfig,
            );
            setAccountProxyConnectionId(
              accountProxyRoute.accountKey.slice('account-proxy:'.length),
            );
            accountProxyRoutingApplied = true;
          }
        }
        // A model only AI Credits serves still goes there; its provider block
        // replaces the proxy's below.
        const accountProxyServes =
          accountProxyRoutingApplied &&
          !isGatewayOnlyModel(getModel() ?? opts.model);
        recordSessionAccountProxyRoute(key, accountProxyServes);
        if (accountProxyServes) {
          await emitAiCreditsRoutingStatus(
            onEvent,
            this.providerType,
            false,
            true,
          );
          return;
        }
        // Always call the async resolver; it returns `null` fast on the
        // common native path (one cached auth read after warm, no cloud I/O).
        // It consults per-session override, the global mode + per-provider
        // quota state, and finally native-auth presence, so routing applies
        // to every chat surface.
        const aiCreditsRouting = await resolveCodexAiCreditsRouting(
          { ...opts, model: getModel() ?? opts.model },
          onEvent,
        );
        if (aiCreditsRouting === AI_CREDITS_BACKSTOP_ABORT) {
          // The resolver already emitted a clear error explaining why this
          // model can't run. Abort instead of spawning the native app-server,
          // which would emit a second raw auth failure over it (CAN-838).
          await emitAiCreditsRoutingStatus(onEvent, 'codex', false);
          throw new Error(AI_CREDITS_BACKSTOP_ABORT_ERROR);
        }
        if (aiCreditsRouting) {
          preparedInvocationState.threadConfig = mergeCodexConfig(
            preparedInvocationState.threadConfig,
            aiCreditsRouting.config,
          );
          aiCreditsRoutingApplied = true;
          initialGatewaySelection = aiCreditsRouting.selectedModel;
          if (aiCreditsRouting.modelCatalogPath) {
            codexConfigArgs = [
              ...(codexConfigArgs ?? []),
              '-c',
              `model_catalog_json=${JSON.stringify(
                aiCreditsRouting.modelCatalogPath,
              )}`,
            ];
          }
          gatewayTurnModels.set(aiCreditsRouting.selectedModel, {
            gatewayModel: aiCreditsRouting.gatewayModel,
            supportedThinkingLevels: aiCreditsRouting.supportedThinkingLevels,
          });
        }
        // Authoritatively tell the renderer whether this session is routing,
        // so the shared status banner is correct on every surface (CAN-838).
        await emitAiCreditsRoutingStatus(
          onEvent,
          this.providerType,
          aiCreditsRoutingApplied,
        );
      };

      const ensureClient = async (
        currentUserMessageId?: string,
      ): Promise<CodexAppServerClient> => {
        // Routing is resolved once, behind the preparation gate below, and a
        // mid-chat model switch does not re-open it. A gateway-only model has
        // no native provider that could bill it, so a client prepared for the
        // native login cannot serve one: the turn goes out as a raw model id
        // and the app-server answers "The '<model>' model is not supported when
        // using Codex with a ChatGPT account".
        //
        // `getOrCreateSession` normally replaces the whole session before this
        // is reachable (its routing signature is gateway-only aware), so this
        // is the backstop for callers that send on a live session object, and
        // for a catalog refresh that turns an already-selected model
        // gateway-only mid-chat.
        //
        // Re-resolving is purely additive and needs no unwinding: the native
        // path contributed no provider config, no catalog override, and no env
        // of its own, so the gateway config merges cleanly onto the prepared
        // state. Only the app-server client is stale, and the replacement
        // carries the new reasoning route family — which is what makes the
        // client rebuild the thread rather than replay OpenAI-private reasoning
        // through the gateway.
        if (
          preparedInvocationState.extraEnv !== null &&
          !aiCreditsRoutingApplied &&
          isGatewayOnlyModel(getModel() ?? opts.model)
        ) {
          await applyAiCreditsRouting();
          // Guarded rather than assumed: a resolver that declined to route
          // would otherwise dispose and rebuild an identical native client on
          // every turn for as long as the model stayed selected.
          if (aiCreditsRoutingApplied) {
            const staleClient = getClient();
            if (staleClient) {
              initialThreadId = staleClient.getThreadId() ?? initialThreadId;
              retireClientSessionOwners(staleClient);
              staleClient.dispose();
              setClient(null);
            }
          }
        }

        const existingClient = getClient();
        if (existingClient) {
          return existingClient;
        }

        let forkSeedItems: JsonValue[] | undefined;
        if (
          !initialThreadId &&
          !getResumeThreadId() &&
          opts.assistantMode !== 'pipeline-editor'
        ) {
          let nativeForkError: Error | undefined;
          try {
            initialThreadId = await waitForPendingCodexFork(
              opts,
              getTurnPreparationSignal(),
            );
          } catch (error) {
            getTurnPreparationSignal().throwIfAborted();
            if (shutdownSignal.aborted || isDestroyed()) throw error;
            nativeForkError =
              error instanceof Error ? error : new Error(String(error));
            // A failed native fork can still use the canonical copied history.
            // The projection below fails closed if that history is unavailable.
          }
          if (!initialThreadId) {
            const continuation = await loadCodexForkContinuation({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              excludeMessageId: currentUserMessageId,
            });
            if (!continuation && nativeForkError) throw nativeForkError;
            if (continuation && 'threadId' in continuation)
              initialThreadId = continuation.threadId;
            else if (continuation) forkSeedItems = continuation.seedItems;
          }
          getTurnPreparationSignal().throwIfAborted();
          if (isDestroyed()) throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
        }

        if (preparedInvocationState.extraEnv === null) {
          workspaceEnvironmentProfile = resolveCodexRuntimeEnvironmentProfile({
            runtime: 'agent',
            workspaceId: opts.projectId,
          });
          let nextExtraEnv = { ...workspaceEnvironmentProfile.environment };

          // One overlay pass: effective selections are computed here (with
          // all overlay IO) and passed straight into resolvePlugins.
          const pluginContext = await resolveEffectiveChatPluginContext(
            opts.pluginSelections,
            opts,
            opts.applyGlobalPluginDefaults,
          );
          const effectiveSelections = pluginContext.selections;
          if (this.providerType === 'codex') {
            codexStandaloneInvocationEntries =
              await resolveCodexStandaloneInvocationEntries(
                effectiveSelections,
              );
          }
          const hasPluginSelections =
            hasAnySelections(effectiveSelections) ||
            opts.packageOverlay !== undefined;
          const codexMockProvider = resolveCodexMockAppServerOverride();
          if (codexMockProvider) {
            nextExtraEnv = { ...nextExtraEnv, ...codexMockProvider.env };
            codexConfigArgs = codexMockProvider.configArgs;
          }
          if (!codexMockProvider && this.prepareInvocation) {
            const prepared = await this.prepareInvocation(
              getModel() ?? opts.model,
              'session-start',
            );
            preparedInvocationState.runtimeModel = prepared.runtimeModel;
            nextExtraEnv = {
              ...nextExtraEnv,
              ...(prepared.envOverride ?? {}),
            };
            preparedInvocationState.threadConfig = mergeCodexConfig(
              preparedInvocationState.threadConfig,
              prepared.codexConfig,
            );
          }
          if (hasPluginSelections) {
            let stopPluginTimer: (() => void) | null = null;
            try {
              turnState.recordSessionEvent({
                type: 'phase',
                phase: 'codex.resolve_plugins',
              });
              stopPluginTimer = createSessionPhaseTimer(
                key,
                'codex.resolve_plugins',
              );
              let lastError: unknown;
              let resolved: ResolvedPlugins | null = null;
              const mcpHttpProxyService = getMcpHttpProxyService();
              for (
                let attempt = 0;
                attempt <= CODEX_PLUGIN_RESOLUTION_RETRY_DELAYS_MS.length;
                attempt += 1
              ) {
                try {
                  const candidate = await resolvePlugins(
                    effectiveSelections,
                    opts.projectId,
                    opts.worktreeId,
                    opts.chatId,
                    {
                      purpose: 'codex-session',
                      // Chat startup must never perform an unbounded network
                      // clone. External plugins are installed explicitly from
                      // the catalog and stale selections degrade to warnings.
                      installExternalPlugins: false,
                      enableHttpMcpProxy: true,
                      mcpHttpProxyService,
                      mcpStdioBroker: getCodexRuntimeService(),
                      sessionId: pluginRouteOwnerId,
                      ...(opts.packageOverlay
                        ? { packageOverlay: opts.packageOverlay }
                        : {}),
                      ...(pluginContext.preferences
                        ? { preferences: pluginContext.preferences }
                        : {}),
                    },
                  );
                  resolved = candidate;
                  break;
                } catch (error: unknown) {
                  if (isSessionDestroyedError(error)) {
                    throw error;
                  }
                  lastError = error;
                  mcpHttpProxyService.unregisterRoutesForSession(
                    pluginRouteOwnerId,
                  );
                  const retryDelay =
                    CODEX_PLUGIN_RESOLUTION_RETRY_DELAYS_MS[attempt];
                  if (retryDelay === undefined) {
                    break;
                  }
                  recordPluginResolutionRetry(
                    turnState,
                    'resolution_error',
                    attempt + 1,
                    retryDelay,
                    error,
                  );
                  await delay(retryDelay, shutdownSignal);
                  if (isDestroyed()) {
                    throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
                  }
                }
              }
              if (isDestroyed()) {
                throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
              }
              if (!resolved) {
                const message = `Failed to resolve Codex plugins before session start: ${formatUnknownError(lastError)}`;
                throw new Error(message);
              }
              selectedCapabilityRoots = resolved.selectedCapabilityRoots;
              resolvedMcpServersConfig =
                Object.keys(resolved.codexMcpServers).length > 0
                  ? resolved.codexMcpServers
                  : undefined;
              for (const warning of resolved.warnings) {
                // eslint-disable-next-line no-console
                console.warn('[codex-plugin-resolver]', warning);
              }
              turnState.recordSessionEvent({
                type: 'phase',
                phase: 'codex.resolve_plugins.complete',
                timings: resolved.timings,
              });
            } catch (error: unknown) {
              if (!isSessionDestroyedError(error)) {
                // eslint-disable-next-line no-console
                console.error(
                  '[codex-plugin-resolver] Failed to resolve plugins:',
                  error,
                );
              }
              throw error;
            } finally {
              stopPluginTimer?.();
            }
          }
          await applyAiCreditsRouting();

          // Local memory is opt-in; only an enabled preference suppresses
          // Codex-native memories on this thread launch (CAN-1969).
          const nativeMemoryConfig = codexNativeMemoryThreadConfig(
            await readLocalMemoryEnabledPreference(),
          );
          if (Object.keys(nativeMemoryConfig).length > 0) {
            preparedInvocationState.threadConfig = {
              ...(preparedInvocationState.threadConfig ?? {}),
              ...nativeMemoryConfig,
            };
          }

          preparedInvocationState.extraEnv = nextExtraEnv;
        }

        if (!ledger.decided) {
          // A resumed thread without a capability record predates the Ledger
          // tools and never has them, so its session is not exposed: no
          // tools, prompt, Plan mode exception or hint. A thread with a record
          // is rebuilt whenever its tools differ, so it gets what it is told.
          const resumeThreadId = getResumeThreadId() ?? initialThreadId;
          ledger.tools =
            mayExposeLedgerTools(ledgerTarget) &&
            (resumeThreadId === undefined ||
              (await hasCodexCapabilityRecord(resumeThreadId)))
              ? await openLedgerChatTools({
                  target: ledgerTarget,
                  harness: 'codex',
                  ...(ledgerToolNames ? { toolNames: ledgerToolNames } : {}),
                  readSettings: () => ({
                    model: getModel() ?? opts.model ?? null,
                    thinkingEffort: getThinkingLevel(),
                    planMode: getPlanMode(),
                  }),
                  ...(opts.selectedRepoId
                    ? { selectedRepoId: opts.selectedRepoId }
                    : {}),
                })
              : null;
          managedDelegation?.setLedgerTools(ledger.tools ?? undefined);
          ledger.decided = true;
          if (isDestroyed()) throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
        }
        const isCodeReview = opts.projectId === CODE_REVIEW_CHAT_PROJECT_ID;
        const includeChatVisuals = chatVisualsEligible({
          providerType: this.providerType,
          surface: isCoworkWorkspace(opts.projectId)
            ? 'codex-cowork'
            : 'codex-worktree',
          assistantMode: opts.assistantMode,
        });
        const canopyRuntime: CanopyInjectedToolRuntime = {
          authorizeInstalledItemUninstall: (request, context) =>
            authorizeInstalledItemUninstall(approvalSession, request, context),
          ...(includeChatVisuals
            ? {
                showVisual: createShowVisualHost({
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  chatId: opts.chatId,
                  cwd: opts.cwd,
                }),
              }
            : {}),
          deferredToolsRuntime: {
            scope: {
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
            },
            providerType: 'codex',
            interfaceMode: 'canopy',
            assistantMode: opts.assistantMode,
            pluginSelections: opts.pluginSelections,
            allowed: opts.deferredToolsAllowed !== false,
          },
          requestUserAnswers: (questions, requestOptions) =>
            requestAnswersFromRenderer({
              sessionKey: key,
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              questions,
              getWindow,
              toolUseId: requestOptions?.toolUseId,
              providerType: 'codex',
              model: getModel() ?? opts.model,
              onAwaitingUser: (): void => turnState.markTurnAwaitingUser(),
              askUserTimeoutMs: ASK_USER_TIMEOUT_MS,
              signal: requestOptions?.signal,
            }),
          loadScriptOutput: ({ scriptId, repo, maxLines }) =>
            loadWorktreeScriptOutput({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              scriptId,
              repo,
              maxLines,
            }),
          // Git preferences are meaningless without a git worktree; omitting
          // the loader makes core.ts return its presence-gated error if a
          // resumed cowork thread still tries the tool.
          ...(!isCoworkWorkspace(opts.projectId) ? { loadGitPreferences } : {}),
          saveLocalMemory: (request) =>
            saveLocalMemory({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              sessionId: getResumeThreadId() ?? initialThreadId,
              provider: 'codex',
              ...request,
            }),
          searchLocalMemory: (request) =>
            searchLocalMemory({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              ...request,
            }),
          loadPipelineYaml: (request) =>
            loadWorktreePipelineYaml({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              ...request,
            }),
          ...(opts.assistantMode !== 'app-advisor' &&
          opts.assistantMode !== 'pipeline-editor'
            ? {
                ...(hasInterfaceTool(opts.interfaceTools, 'ui.show_files')
                  ? {
                      showFiles: (files) =>
                        requestShowFilesThroughLease({
                          files,
                          target: {
                            projectId: opts.projectId,
                            worktreeId: opts.worktreeId,
                          },
                          origin: {
                            projectId: opts.projectId,
                            worktreeId: opts.worktreeId,
                            chatTabId: opts.chatId,
                          },
                          cwd: opts.cwd,
                        }),
                    }
                  : {}),
                getFileComments: ({ threadId }) =>
                  getFileCommentsInSession({
                    projectId: opts.projectId,
                    worktreeId: opts.worktreeId,
                    ...(threadId !== undefined ? { threadId } : {}),
                  }),
                respondToFileComment: ({ threadId, body, resolve }) =>
                  respondToFileCommentInSession({
                    projectId: opts.projectId,
                    worktreeId: opts.worktreeId,
                    threadId,
                    body,
                    resolve,
                    getWindow,
                  }),
              }
            : {}),
          ...(opts.assistantMode !== 'app-advisor' &&
          opts.assistantMode !== 'pipeline-editor'
            ? {
                worktreeActionRuntime: {
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  chatId: opts.chatId,
                  cwd: opts.cwd,
                  ...(opts.selectedRepoId
                    ? { repoId: opts.selectedRepoId }
                    : {}),
                  // Cowork chats dispatch directory-scoped pipeline runs at
                  // the workspace folder; worktree-only actions are
                  // filtered/rejected by the action layer.
                  ...(isCoworkWorkspace(opts.projectId)
                    ? { executionScope: 'directory' as const }
                    : {}),
                  getWindow,
                },
                worktreeWatcherRuntime: {
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  chatId: opts.chatId,
                },
                // Code graph stays worktree-only (no git repo in cowork).
                ...(!isCoworkWorkspace(opts.projectId)
                  ? {
                      codeGraphRuntime: {
                        projectId: opts.projectId,
                        worktreeId: opts.worktreeId,
                      },
                    }
                  : {}),
                autoArchiveChat: {
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  chatId: opts.chatId,
                },
              }
            : {}),
          ...(ledger.tools ? { ledgerRuntime: ledger.tools } : {}),
        };
        const toolSchemaProfile = resolveGatewayToolSchemaProfile(
          getModel() ?? opts.model,
          aiCreditsRoutingApplied,
        );
        const reasoningRouteFamily = resolveCodexReasoningRouteFamily(
          getModel() ?? opts.model,
          aiCreditsRoutingApplied,
          this.providerType,
        );
        const dynamicTools = buildCodexSessionDynamicToolSpecs({
          assistantMode: opts.assistantMode,
          workspaceMode: isCoworkWorkspace(opts.projectId)
            ? 'cowork'
            : 'worktree',
          includeCodeGraph: codeGraphToolsAdvertised,
          includeChatVisuals,
          includeLedger: ledger.tools !== null,
          interfaceTools: opts.interfaceTools ?? [],
          isCodeReview,
          toolSchemaProfile,
        });
        if (managedDelegation)
          dynamicTools.push(...managedDelegation.codexTools);

        getTurnPreparationSignal().throwIfAborted();
        const createdApprovalMode = getApprovalMode();
        const ingestionLagOwner: CodexIngestionLagOwner = {
          client: null,
          hasPositiveSample: false,
          retired: false,
        };
        const retainedExecutionUserMessageId = getLastExecutionUserMessageId();
        const contextWindowModel = getModel() ?? opts.model;
        const contextWindowSetting = getModelConfig().contextWindow;
        const contextWindowRoute = buildCodexSpeedRouteFacts({
          selectedModel: contextWindowModel ?? null,
          runtimeModel:
            preparedInvocationState.runtimeModel ?? contextWindowModel ?? null,
          harness: 'codex',
          providerType: this.providerType,
          gateway: aiCreditsRoutingApplied
            ? codexSpeedGatewayForOrigin(
                resolveGatewayModelEntry(contextWindowModel)?.origin,
              )
            : null,
          codexConfig: preparedInvocationState.threadConfig ?? null,
          environment: preparedInvocationState.extraEnv,
          mockProvider: Boolean(resolveCodexMockAppServerOverride()),
        });
        const contextWindow = await resolveCodexContextWindowConfig(
          contextWindowSetting,
          contextWindowRoute,
        );
        getTurnPreparationSignal().throwIfAborted();
        let constructingClient: CodexAppServerClient | null = null;
        const nextClient = new CodexAppServerClient({
          cwd: opts.cwd,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          sessionKey: key,
          initialThreadId: getResumeThreadId() ?? initialThreadId,
          ...(retainedExecutionUserMessageId
            ? {
                initialExecutionUserMessageId: retainedExecutionUserMessageId,
              }
            : {}),
          onEvent,
          onTurnLifecycleObservation,
          onProviderEventDropped: (drop): void => {
            recordChatEventDropped({
              ...drop,
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              providerType: 'codex',
            });
          },
          providerContractGuard: createCodexContractGuard(
            {
              sessionKey: key,
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
            },
            (diagnostic) => {
              getExecutionObservabilityIngest().recordSessionDiagnostic(
                diagnostic,
              );
            },
          ),
          onSteeringEligibilityChanged: (): void => {
            onClientSteeringEligibilityChanged(constructingClient);
          },
          onIngestionLagChange: (change: CodexIngestionLagChange): void => {
            getExecutionObservabilityIngest().recordSessionDiagnostic({
              version: 1,
              timestamp: new Date().toISOString(),
              kind: 'ingestion_lag',
              sessionKey: key,
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              providerType: 'codex',
              outcome: change.outcome,
              lagMs: change.lagMs,
              peakLagMs: change.peakLagMs,
              episodeMs: change.episodeMs,
              thresholdMs: change.thresholdMs,
              source: change.source,
            });
          },
          onIngestionLagSample: (sample: ChatIngestionLag): void => {
            handleIngestionLagSample(ingestionLagOwner, sample);
          },
          getWindow,
          extraEnv:
            preparedInvocationState.extraEnv &&
            Object.keys(preparedInvocationState.extraEnv).length > 0
              ? preparedInvocationState.extraEnv
              : undefined,
          spawnProfile: {
            ...(preparedInvocationState.extraEnv
              ? { environment: preparedInvocationState.extraEnv }
              : {}),
            ...(codexConfigArgs ? { configArgs: codexConfigArgs } : {}),
            logicalWorkspaceEnvironmentId:
              workspaceEnvironmentProfile?.logicalWorkspaceEnvironmentId ??
              `agent:${opts.projectId}`,
            ...(workspaceEnvironmentProfile?.secretVersionFingerprint
              ? {
                  secretVersionFingerprint:
                    workspaceEnvironmentProfile.secretVersionFingerprint,
                }
              : {}),
            ...(resolveCodexMockAppServerOverride()
              ? { mockProviderId: 'canopy-e2e' }
              : {}),
          },
          mcpServersConfig: resolvedMcpServersConfig,
          mcpAuthorityIds:
            getMcpHttpProxyService().getCodexCapabilityAuthorityIds(
              resolvedMcpServersConfig ?? {},
            ),
          threadConfig: {
            ...preparedInvocationState.threadConfig,
            ...contextWindow.config,
            'features.goals': false,
            ...(managedDelegation
              ? {
                  'features.multi_agent': false,
                  'features.multi_agent_v2': false,
                }
              : {}),
          },
          selectedCapabilityRoots,
          capabilityStore: getDesktopCodexCapabilityStore(),
          fallbackSeedItems: forkSeedItems,
          fallbackSeedItemsLoader: (): Promise<JsonValue[]> =>
            loadPersistedCodexFallbackSeedItems({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              ...(currentUserMessageId
                ? { excludeMessageId: currentUserMessageId }
                : {}),
            }).catch(() => []),
          seedNewThreadFromFallback:
            Boolean(opts.codexReconstructionSeedId) ||
            forkSeedItems !== undefined,
          forceMaterializeOnResume,
          ...(codexConfigArgs && codexConfigArgs.length > 0
            ? { configArgs: codexConfigArgs }
            : {}),
          multiAgentEnabled: managedDelegation
            ? false
            : opts.codexMultiAgentEnabled,
          maxConcurrentSubagents: opts.codexMaxConcurrentSubagents,
          developerInstructions: appendPluginMcpDiscoveryInstructions(
            [
              opts.systemPromptAppend,
              managedDelegation?.systemPromptGuidance,
              ledger.tools?.systemPrompt(),
            ]
              .filter((part): part is string => Boolean(part))
              .join('\n\n') || undefined,
            resolvedMcpServersConfig,
          ),
          ...(ledger.tools
            ? {
                planModeDeveloperInstructionsAddendum:
                  buildLedgerPlanModeInstruction('codex', ledgerToolNames),
              }
            : {}),
          dynamicTools,
          toolSchemaProfile,
          reasoningRouteFamily,
          modelConfig: getModelConfig,
          approvalSession,
          approvalMode: createdApprovalMode,
          onAwaitingUser: (): void => turnState.markTurnAwaitingUser(),
          ...(managedDelegation
            ? {
                onDynamicToolResultAccepted: (call: {
                  callId: string;
                  threadId: string;
                  turnId: string;
                }): void => {
                  managedDelegation.parent.acknowledgeTool(
                    call.callId,
                    `codex:${call.threadId}:${call.turnId}:${call.callId}`,
                    call.turnId,
                  );
                },
              }
            : {}),
          dynamicToolCallHandler: async (
            params,
            requestOptions,
          ): Promise<
            Awaited<ReturnType<typeof handleCanopyDynamicToolCall>>
          > => {
            const toolName = params.tool;
            if (
              opts.assistantMode === 'app-advisor' &&
              opts.appAdvisorRuntime &&
              toolName === APP_ADVISOR_TOOL_REGISTRY.watch_command.codexToolName
            ) {
              // The App Advisor runtime owns the selected-worktree command
              // approval. Dispatch directly so the generic provider tool gate
              // does not add a second, less specific prompt.
              return handleAppAdvisorDynamicToolCall(
                params,
                opts.appAdvisorRuntime,
                requestOptions,
              );
            }
            const watchedCommand =
              toolName ===
              CANOPY_INJECTED_TOOL_REGISTRY.watch_command.codexToolName
                ? watchCommandSchema.safeParse(params.arguments)
                : undefined;
            const commandInput = watchedCommand?.success
              ? watchedCommand.data
              : undefined;
            const outcome = await approvalSession.check(
              commandInput
                ? {
                    kind: 'command',
                    command: commandInput.command,
                    cwd: opts.cwd,
                  }
                : { kind: 'tool', toolName },
              {
                title: `Use ${toolName}?`,
                ...(commandInput
                  ? {
                      description: `Repeated command in ${opts.cwd}. Limits: ${JSON.stringify(params.arguments)}; 60-second timeout per attempt.`,
                    }
                  : {}),
                details: commandInput
                  ? {
                      kind: 'command',
                      command: commandInput.command,
                    }
                  : {
                      kind: 'tool',
                      toolName,
                      inputSummary: JSON.stringify(params.arguments),
                    },
                ...(!commandInput
                  ? { suggestedTarget: { kind: 'tool' as const, toolName } }
                  : {}),
                toolUseId: `codex-${params.callId}`,
              },
            );
            if (requestOptions?.signal?.aborted) {
              return {
                contentItems: [
                  {
                    type: 'inputText',
                    text: 'The dynamic tool call was cancelled before dispatch.',
                  },
                ],
                success: false,
              };
            }
            if (outcome.decision === 'deny') {
              const response = {
                contentItems: [
                  {
                    type: 'inputText' as const,
                    text:
                      outcome.message ??
                      `Dynamic tool ${toolName} was denied by the approval policy.`,
                  },
                ],
                success: false,
              };
              if (outcome.stopTurn) {
                beginTurnCancellation();
                // Let the app-server consume the denied tool result before
                // interrupting the turn, matching the response-then-interrupt
                // ordering used by the built-in Codex approval handlers.
                setImmediate(() => {
                  void nextClient.interruptTurn().catch(() => undefined);
                });
              }
              return response;
            }
            if (
              managedDelegation &&
              (isWatchDelegatesCompatibilityName(toolName, 'codex') ||
                managedDelegation.ownsTool(toolName))
            ) {
              const target = nextClient.getActiveTurnInterruptTarget();
              const result = await managedDelegation.parent.invokeCodex(
                toolName,
                params.arguments,
                {
                  callId: params.callId,
                  turnId: params.turnId,
                  threadId: params.threadId,
                  ...(requestOptions?.signal !== undefined
                    ? { signal: requestOptions.signal }
                    : {}),
                },
                target?.threadId,
                target?.turnId ?? undefined,
              );
              return {
                contentItems: [
                  { type: 'inputText', text: JSON.stringify(result) },
                ],
                success: result.ok,
              };
            }
            return opts.assistantMode === 'app-advisor' &&
              opts.appAdvisorRuntime
              ? handleAppAdvisorDynamicToolCall(
                  params,
                  opts.appAdvisorRuntime,
                  // Ledger calls run on this session's own Ledger tools,
                  // bound to the Work Entry it started in.
                  {
                    ...requestOptions,
                    ...(ledger.tools ? { ledgerRuntime: ledger.tools } : {}),
                    interfaceTools: opts.interfaceTools ?? [],
                  },
                )
              : opts.assistantMode === 'pipeline-editor' &&
                  opts.pipelineEditorRuntime
                ? handlePipelineEditorDynamicToolCall(
                    params,
                    opts.pipelineEditorRuntime,
                    requestOptions,
                  )
                : handleCanopyDynamicToolCall(
                    params,
                    canopyRuntime,
                    requestOptions,
                  );
          },
          onProcessStarted: (pid): void => {
            recordCodexProcessDiagnostic({
              kind: 'codex_process_started',
              pid,
            });
          },
          onProcessExit: (details): void => {
            recordCodexProcessDiagnostic({
              kind: 'codex_process_exit',
              ...(details.pid !== null ? { pid: details.pid } : {}),
              exitCode: details.code,
              signal: details.signal,
              stderrTail: details.stderrTail,
              stderrTruncated: details.stderrTruncated,
              uptimeMs: details.uptimeMs,
              codexClientCount: details.clientCount,
              codexActiveTurnCount: details.activeTurnCount,
              recoveryScheduled: details.recoveryScheduled,
            });
          },
          onProcessError: (details): void => {
            recordCodexProcessDiagnostic({
              kind: 'codex_process_error',
              error: details.error,
              stderrTail: details.stderrTail,
            });
          },
          onProcessRecovery: (details): void => {
            recordCodexProcessDiagnostic({
              kind: 'codex_process_recovery',
              recoveryStatus: details.status,
              ...(details.strategy
                ? { recoveryStrategy: details.strategy }
                : {}),
              ...(details.error ? { error: details.error } : {}),
            });
          },
        });
        constructingClient = nextClient;
        appliedCodexContextWindows.set(nextClient, {
          setting: contextWindowSetting,
          model: contextWindowModel,
          ...(contextWindow.resolved ? {} : { pending: contextWindowRoute }),
        });
        ingestionLagOwner.client = nextClient;
        registerIngestionLagOwner(nextClient, ingestionLagOwner);
        turnState.recordSessionEvent({
          type: 'phase',
          phase: 'codex.client_created',
        });
        let appliedApprovalMode = createdApprovalMode;
        while (appliedApprovalMode !== getApprovalMode()) {
          const latestApprovalMode = getApprovalMode();
          await nextClient.setApprovalMode(latestApprovalMode);
          appliedApprovalMode = latestApprovalMode;
        }
        if (isDestroyed()) {
          retireClientSessionOwners(nextClient);
          nextClient.dispose();
          throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
        }
        // Consume the force-rebuild request: it applies to the client we just
        // constructed and must not survive into later clients. The idle timer
        // disposes the client between turns (`releaseIdleClient`), so leaving
        // this latched would make every subsequent recreation materialize a
        // brand-new thread — new sdkSessionId, full history re-injection, and
        // reasoning stripped again — instead of the cheap thread/resume that
        // release path is designed around. Resetting only after a successful
        // construction keeps a failed attempt forcing the rebuild it asked for.
        forceMaterializeOnResume = false;
        setClient(nextClient);
        return nextClient;
      };

      while (!isDestroyed()) {
        let message: QueuedCodexMessage | undefined;

        if (messageQueue.length > 0) {
          message = messageQueue.shift();
        } else {
          message = await new Promise<QueuedCodexMessage | undefined>(
            (resolve) => {
              setWaiter(resolve);
            },
          );
        }

        if (message === undefined || isDestroyed()) {
          break;
        }

        currentMessage = message;
        currentExecutionUserMessageId = message.userMessageId;
        // `input` is computed below from send-time invocation normalization.
        const turnPlanMode = getPlanMode();
        setActiveTurn(message);
        const usageTurn = skillUsage.startTurn(
          message.skillUsageTurnId ?? randomUUID(),
          message.countsTowardSkillUsage === true,
        );

        try {
          message.staleProxyRouteRecoverySignal?.throwIfAborted();
          markCodexTurnStarting();
          turnState.markTurnActive(message.userMessageId);
          const activeClient = await ensureClient(message.userMessageId);
          turnState.recordSessionEvent({
            type: 'phase',
            phase: 'codex.turn_start',
          });
          const selectedModel = getModel() ?? opts.model;
          let turnModel = preparedInvocationState.runtimeModel ?? selectedModel;
          let turnGatewayRoute:
            | {
                gatewayModel: string;
                supportedThinkingLevels: readonly ThinkingLevel[];
              }
            | undefined;
          const routingModel = selectedModel ?? initialGatewaySelection;
          if (aiCreditsRoutingApplied && routingModel) {
            const cachedGatewayRoute = gatewayTurnModels.get(routingModel);
            const gatewayEntry = cachedGatewayRoute
              ? undefined
              : resolveGatewayModelEntry(routingModel);
            const resolvedGatewayRoute =
              cachedGatewayRoute ??
              (gatewayEntry
                ? {
                    gatewayModel: gatewayEntry.gatewayId,
                    supportedThinkingLevels: [
                      ...gatewayEntry.supportedThinkingLevels,
                    ],
                  }
                : undefined);
            if (resolvedGatewayRoute) {
              gatewayTurnModels.set(routingModel, resolvedGatewayRoute);
              turnGatewayRoute = resolvedGatewayRoute;
              turnModel = resolvedGatewayRoute.gatewayModel;
            }
          }
          if (aiCreditsRoutingApplied && turnGatewayRoute) {
            // A native default without native auth is served by its credits
            // counterpart, which dispatch could not predict. Record the
            // served model's registry id, not its gateway id: Codex cost is
            // priced by registry id, and the turn's requested model keeps the
            // pick (CAN-5233). A pick routed to its own gateway model served
            // the turn itself; the reverse lookup could name a sibling id.
            const pickedModel =
              preparedInvocationState.runtimeModel ?? selectedModel;
            const servedModel =
              resolveGatewayModelEntry(pickedModel)?.gatewayId ===
              turnGatewayRoute.gatewayModel
                ? undefined
                : resolveModelIdForGatewayId(turnGatewayRoute.gatewayModel);
            if (servedModel !== undefined && servedModel !== pickedModel) {
              getExecutionObservabilityIngest().setChatTurnServedModel(
                buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId),
                servedModel,
              );
            }
          }
          const inventory = await loadCachedInventory().catch(() => null);
          const providerInventoryEntries =
            inventory?.entries.filter(
              (entry) => entry.provider === this.providerType,
            ) ?? [];
          const normalizationEntries =
            this.providerType === 'codex'
              ? [
                  ...providerInventoryEntries.filter(
                    (entry) => entry.kind !== 'skill',
                  ),
                  ...codexStandaloneInvocationEntries,
                ]
              : providerInventoryEntries;
          if (this.providerType === 'codex') {
            const matched = matchInvocationEntry(
              message.text,
              normalizationEntries,
            );
            const canonical =
              matched &&
              providerInventoryEntries.find(
                (entry) => entry.invocationKey === matched.invocationKey,
              );
            if (canonical) skillUsage.observeEntry(usageTurn, canonical);
          }
          const input = normalizeInvocationToken(
            message.text,
            normalizationEntries,
          );
          // A normal turn starts with a bounded hint when entries assigned to
          // this chat changed since it last looked.
          const ledgerHint = ledger.tools
            ? await ledger.tools.assignmentHint()
            : undefined;
          const turnInput = ledgerHint ? `${ledgerHint}\n\n${input}` : input;
          getTurnPreparationSignal().throwIfAborted();
          const turnModelConfig = getModelConfig();
          // Admit the exact requested speed against the route THIS turn
          // actually uses (resolved model, AI Credits/organization gateway,
          // provider config, environment) before any thread or turn request.
          // Regular and Fast resolve immediately. A refused Ultra fast turn
          // ends visibly below; it is never downgraded or replayed.
          const speedAdmission = await admitCodexSpeed(turnModelConfig.speed, {
            selectedModel: selectedModel ?? null,
            runtimeModel: turnModel ?? null,
            harness: 'codex',
            providerType: this.providerType,
            gateway: aiCreditsRoutingApplied
              ? codexSpeedGatewayForOrigin(
                  resolveGatewayModelEntry(selectedModel)?.origin,
                )
              : null,
            codexConfig: preparedInvocationState.threadConfig ?? null,
            environment: preparedInvocationState.extraEnv,
            mockProvider: Boolean(resolveCodexMockAppServerOverride()),
          });
          getTurnPreparationSignal().throwIfAborted();
          const turnResult = await activeClient.startTurn({
            text:
              managedDelegation?.applyPolicyGuidance(turnInput) ?? turnInput,
            cwd: opts.cwd,
            submissionId: message.submissionId,
            clientUserMessageId: message.userMessageId ?? message.submissionId,
            executionUserMessageId: message.userMessageId,
            // The routed process catalog maps gateway IDs to portable standard
            // Responses metadata. Vercel does not preserve Lite's custom
            // grammar tool-call semantics, so routed turns use that gateway ID;
            // native turns retain the bundled alias and native Lite profile.
            model: turnModel,
            capabilityModel: selectedModel,
            aiCreditsRouted: aiCreditsRoutingApplied,
            ...(turnGatewayRoute
              ? {
                  supportedThinkingLevels:
                    turnGatewayRoute.supportedThinkingLevels,
                }
              : {}),
            thinkingLevel: getThinkingLevel(),
            planMode: turnPlanMode,
            modelConfig: turnModelConfig,
            ultrafastAdmitted: speedAdmission.speed === 'ultrafast',
            proposalMode: getProposalMode(),
          });
          // The client getter is the trusted native execution anchor, which
          // may differ from the currently dispatched input after a merge. Read
          // it only after startTurn resolves: a failed admission must retain
          // this submission's own anchor, not a previous turn's client state.
          currentExecutionUserMessageId =
            activeClient.getExecutionUserMessageId?.() ?? message.userMessageId;
          if (currentExecutionUserMessageId) {
            setLastExecutionUserMessageId(currentExecutionUserMessageId);
          }

          if (activeClient.hasProviderOwnedTurn()) {
            // The dispatched root settled, then a provider-owned root adopted
            // the same chat before this send loop resumed. Its native terminal
            // is now the sole owner of live session activity.
            resultEmitted = true;
            markCodexTurnFinished();
            clearActiveTurn();
            continue;
          }

          const terminalOutcome: CodexTurnTerminalEvidence['outcome'] =
            turnResult.status === 'failed'
              ? 'failed'
              : turnResult.status === 'interrupted'
                ? 'interrupted'
                : 'completed';
          recordCodexTurnEnd(key, {
            ...(currentExecutionUserMessageId !== undefined
              ? { turnUserMessageId: currentExecutionUserMessageId }
              : {}),
            outcome: terminalOutcome,
            endedAtMs: Date.now(),
          });
          const recoverySignal = getTurnPreparationSignal();
          resultEmitted = true;
          turnState.markTurnIdle();
          markCodexTurnFinished();
          if (turnResult.status === 'failed') {
            // One report per failed real request; only a definitive tier,
            // model, or access rejection of an admitted Ultra fast turn
            // records a temporary denial. Nothing is retried at another speed.
            reportCodexSpeedTurnFailure(speedAdmission, turnModel, {
              codexErrorInfo: turnResult.codexErrorInfo,
              message: turnResult.error,
            });
            // No shared sentinel key. A failure before any thread id is known
            // cannot be attributed to a thread, and bucketing every such
            // failure under one placeholder would let the first one consume
            // the budget for every later unrelated thread. There is also
            // nothing to rebuild *from* without a source thread id, so skip
            // the retry entirely rather than record a fake key.
            const failedThreadKey =
              activeClient.getThreadId() ?? initialThreadId;
            const staleProxyRouteFailure = isStaleProxyRouteError(
              turnResult.error,
            );
            const stopAutomaticRecovery =
              message.staleProxyRouteRetried === true || staleProxyRouteFailure;
            if (stopAutomaticRecovery) {
              const markForRecreation = (): void =>
                markSessionForNextTurnRecreation(
                  opts.projectId,
                  opts.worktreeId,
                  opts.chatId,
                );
              if (isDestroyed() || recoverySignal.aborted) {
                throw new Error(
                  isDestroyed()
                    ? SESSION_DESTROYED_ERROR_MESSAGE
                    : 'turn_cancelled',
                );
              }
              if (
                !message.staleProxyRouteRetried &&
                staleProxyRouteFailure &&
                failedThreadKey !== undefined &&
                !staleProxyRouteRetriedThreadIds.has(failedThreadKey) &&
                staleProxyRouteRetriedThreadIds.size <
                  MAX_STALE_PROXY_ROUTE_RECOVERIES
              ) {
                staleProxyRouteRetriedThreadIds.add(failedThreadKey);
                // Reuse the prepared route: session teardown would remove it.
                initialThreadId = failedThreadKey;
                forceMaterializeOnResume = true;
                message.staleProxyRouteRetried = true;
                try {
                  activeClient.dispose();
                } finally {
                  setClient(null);
                }
                if (isDestroyed() || recoverySignal.aborted) {
                  throw new Error(
                    isDestroyed()
                      ? SESSION_DESTROYED_ERROR_MESSAGE
                      : 'turn_cancelled',
                  );
                }
                messageQueue.unshift({
                  ...message,
                  staleProxyRouteRecoverySignal: recoverySignal,
                  revivesSettledTurn: true,
                });
                clearActiveTurn();
                turnState.noteSessionMessageQueued(messageQueue.length);
                continue;
              }
              markForRecreation();
            }
            if (
              !stopAutomaticRecovery &&
              failedThreadKey !== undefined &&
              isIncompatibleReasoningHistoryError(turnResult.error) &&
              !incompatibleReasoningRetriedThreadIds.has(failedThreadKey) &&
              incompatibleReasoningRetriedThreadIds.size <
                MAX_INCOMPATIBLE_REASONING_HISTORY_REBUILDS
            ) {
              incompatibleReasoningRetriedThreadIds.add(failedThreadKey);
              initialThreadId = activeClient.getThreadId() ?? initialThreadId;
              forceMaterializeOnResume = true;
              retireClientSessionOwners(activeClient);
              activeClient.dispose();
              setClient(null);
              messageQueue.unshift({ ...message, revivesSettledTurn: true });
              clearActiveTurn();
              turnState.noteSessionMessageQueued(messageQueue.length);
              continue;
            }
            if (
              !stopAutomaticRecovery &&
              opts.assistantMode === 'app-advisor' &&
              isUnknownDynamicToolError(turnResult.error) &&
              !hasRetriedUnknownDynamicTool
            ) {
              hasRetriedUnknownDynamicTool = true;
              getExecutionObservabilityIngest().recordSessionDiagnostic({
                version: 1,
                timestamp: new Date().toISOString(),
                kind: 'phase_slow',
                sessionKey: key,
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                providerType: 'codex',
                phase: 'app_advisor_dynamic_tool_recreate',
                elapsedMs: 0,
              });
              initialThreadId = activeClient.getThreadId() ?? initialThreadId;
              forceMaterializeOnResume = true;
              retireClientSessionOwners(activeClient);
              activeClient.dispose();
              setClient(null);
              messageQueue.unshift({ ...message, revivesSettledTurn: true });
              clearActiveTurn();
              turnState.noteSessionMessageQueued(messageQueue.length);
              continue;
            }
            // A ChatGPT account refused this model: carry a structured
            // recovery notice on the terminal event (CAN-4716). Never retried
            // automatically; the only resend is the user's click. A failed
            // lookup drops only the notice, never the terminal event.
            let modelAccessFailure: CodexAccountModelAccessFailure | null =
              null;
            try {
              modelAccessFailure = await resolveCodexAccountModelAccessFailure({
                error: turnResult.error,
                codexErrorInfo: turnResult.codexErrorInfo,
                owner: await resolveSessionWorkOwner(opts),
                ...(turnModel ? { turnModel } : {}),
              });
            } catch (error) {
              // eslint-disable-next-line no-console
              console.warn(
                '[codex-session] model access failure lookup failed',
                error,
              );
            }
            await emitTerminal({
              type: 'result',
              is_error: true,
              result: turnResult.error ?? 'Codex turn failed',
              subtype: 'codex_error',
              ...(turnResult.codexErrorInfo
                ? { codexErrorInfo: turnResult.codexErrorInfo }
                : {}),
              errors: [turnResult.error ?? 'Codex turn failed'],
              ...(modelAccessFailure
                ? { [CANOPY_MODEL_ACCESS_FAILURE_FIELD]: modelAccessFailure }
                : {}),
            });
            clearActiveTurn();
            continue;
          }

          if (turnResult.proposedPlanText) {
            const win = getWindow();
            const planExitEvent: PlanExitRequestEvent = {
              requestId: randomUUID(),
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              source: 'codex',
              reviewMode: 'proposal',
              toolInput: {
                plan: turnResult.proposedPlanText,
                source: 'codex',
              },
            };
            await commitPendingPlanExit(planExitEvent);
            sendToWindow(win, IPC_CHANNELS.planExitRequest, planExitEvent);
            // Mirrors the Claude plan-exit path: a plan awaiting review blocks
            // on a human and is worth a push (CAN-3195).
            getAttentionTracker().mark({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              state: 'needs_input',
              reason: 'plan_review',
              sourceId: 'plan-review',
            });
          }

          await emitTerminal({
            type: 'result',
            is_error: false,
            result:
              turnResult.status === 'interrupted'
                ? 'Turn cancelled'
                : 'Turn completed',
          });
          clearActiveTurn();
        } catch (error: unknown) {
          // A displaced session's retry fails here once destroyed; the flag
          // would recreate its successor.
          if (message.staleProxyRouteRetried && turnState.ownsKeyResources()) {
            markSessionForNextTurnRecreation(
              opts.projectId,
              opts.worktreeId,
              opts.chatId,
            );
          }
          if (getClient()?.hasProviderOwnedTurn()) {
            resultEmitted = true;
            markCodexTurnFinished();
            clearActiveTurn();
            continue;
          }
          recordCodexTurnEnd(key, {
            ...(currentExecutionUserMessageId !== undefined
              ? {
                  turnUserMessageId: currentExecutionUserMessageId,
                }
              : {}),
            outcome: codexTurnOutcomeForError(error),
            endedAtMs: Date.now(),
          });
          turnState.markTurnIdle();
          markCodexTurnFinished();
          if (terminalAdmissionFailed) {
            throw error;
          }
          if (isDestroyed()) {
            finishCodexSessionTurn(key, currentExecutionUserMessageId);
            break;
          }

          if (
            error instanceof Error &&
            error.message === AI_CREDITS_BACKSTOP_ABORT_ERROR
          ) {
            // The AI Credits backstop already emitted a descriptive error.
            // End the session without a second error (CAN-838).
            resultEmitted = true;
            await emitTerminal({
              type: 'result',
              is_error: false,
              result: 'Session ended',
            });
            clearActiveTurn();
            break;
          }

          if (
            error instanceof Error &&
            (error.message === 'turn_cancelled' ||
              error.message === SESSION_DESTROYED_ERROR_MESSAGE)
          ) {
            resultEmitted = true;
            await emitTerminal({
              type: 'result',
              is_error: false,
              result: 'Turn cancelled',
            });
            clearActiveTurn();
            continue;
          }

          resultEmitted = true;
          await emitTerminal({
            type: 'result',
            is_error: true,
            result: error instanceof Error ? error.message : String(error),
            subtype: 'codex_error',
            errors: [error instanceof Error ? error.message : String(error)],
            // A structured marker for app-server transport failures, so the
            // chat retry service never has to match the message text.
            ...(classifyCodexTransportError(error) ?? {}),
          });
          clearActiveTurn();
        }
      }
    } catch (error: unknown) {
      if (getClient()?.hasProviderOwnedTurn()) {
        clearCodexTurnInProgress();
        clearActiveTurn();
        return;
      }
      resultEmitted = true;
      if (currentMessage) {
        recordCodexTurnEnd(key, {
          ...(currentExecutionUserMessageId !== undefined
            ? { turnUserMessageId: currentExecutionUserMessageId }
            : {}),
          outcome: codexTurnOutcomeForError(error),
          endedAtMs: Date.now(),
        });
      }
      turnState.markTurnIdle();
      clearCodexTurnInProgress();
      if (terminalAdmissionFailed) {
        throw error;
      }
      if (
        error instanceof Error &&
        (error.message === 'turn_cancelled' ||
          error.message === SESSION_DESTROYED_ERROR_MESSAGE)
      ) {
        await emitTerminal({
          type: 'result',
          is_error: false,
          result: 'Session aborted',
        });
        clearActiveTurn();
        return;
      }
      await emitTerminal({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      clearActiveTurn();
    } finally {
      try {
        if (!resultEmitted) {
          if (currentMessage) {
            recordCodexTurnEnd(key, {
              ...(currentExecutionUserMessageId !== undefined
                ? { turnUserMessageId: currentExecutionUserMessageId }
                : {}),
              outcome: 'interrupted',
              endedAtMs: Date.now(),
            });
          }
          turnState.markTurnIdle();
          clearCodexTurnInProgress();
          await emitTerminal({
            type: 'result',
            is_error: false,
            result: 'Session ended',
          });
        }
      } finally {
        clearActiveTurn();
        ledger.tools?.dispose();
        try {
          // The session is gone; the chat's delegations outlive it.
          managedDelegation?.detach();
        } finally {
          unregisterOwnSession();
        }
      }
    }
  }
}
import { authorizeInstalledItemUninstall } from '../installed-items/installed-item-approval';
