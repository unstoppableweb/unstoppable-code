import { isWatchDelegatesCompatibilityName } from '@canopy/desktop-shared/node/delegation/watch-delegates-tombstone';
import {
  APPROVAL_CANCELLED_MESSAGE,
  APPROVAL_CHECK_FAILED_MESSAGE,
  POLICY_DENIED_FALLBACK_MESSAGE,
} from '@canopy/protocol/approvals';
import {
  detectClaudeHostedNoBillingSource,
  hasClaudeProxyFailureEvidence,
} from '@canopy/desktop-shared/portal/provider-usage-limit';
import {
  CHILD_TOOL_LIVENESS_STAMP,
  isAiCreditsFailureEventShape,
  readChildToolLivenessStamp,
  type ChildToolLiveness,
  readClaudeApiErrorStatus,
} from '@canopy/agent-transcript';
import { withProxyFailureRestored } from './ai-credits-proxy-failure-restore';
import { chatInputRefusal } from '@canopy/protocol/portal/input-delivery';
import { withClaudeAiCreditsFallbackError } from './claude-ai-credits-fallback-error';
import { claudeManagedSettingsGuard } from './claude-managed-settings';
import { normalizeClaudeMaxTurns } from '@canopy/desktop-shared/constants/preferences';
import { SkillUsageTracker } from './skill-usage-tracker';
import type { UUID } from 'node:crypto';
import {
  query as claudeQuery,
  type CanUseTool,
  type HookInput,
  type HookJSONOutput,
  type PermissionResult,
  type Query,
  type Options as QueryOptions,
  type McpServerConfig,
  type SpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { BRAND } from '@canopy/brand/current';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  getAppAdvisorLedgerToolNames,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import { isClaudeChainUuid } from '@canopy/desktop-shared/lib/claude-fork-resume-point';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import type { BrowserWindow } from 'electron';
import { managedDelegationEnabled } from './delegation/gate';
import type { ManagedDelegationSession } from './delegation/service';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { logMainProcessError } from '../lib/main-process-logging';
import { recordChatEventDropped } from '../lib/chat-event-drop-diagnostics';
import { observeRoutedTurnBinding } from './session-event-router';
import {
  ClaudeInputDelivery,
  withDeliveryDeadline,
} from './claude-input-delivery';
import {
  ClaudeEventTaskTracker,
  ClaudeTurnBindingTracker,
  getClaudeTurnLifecycleProducer,
  isClaudeTaskEventResult,
  readClaudeStartedCommandUuid,
  readClaudeWakeCause,
  releaseClaudeTurnLifecycleProducer,
} from './claude-turn-lifecycle';
import type { SpawnedBy, TurnBinding } from '@canopy/protocol/canopy-core';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionOptions,
  AgentSessionSendOptions,
} from './types';
import {
  buildClaudeProxyEnv,
  buildBrokeredOrgGatewayClaudeEnv,
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
import { getCodexGatewayProxyService } from './codex-gateway-proxy-service';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { getMockLlmOrigin } from '../lib/e2e-mock-control-plane';
import { isUnavailableModelSelection } from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  isProviderNativelyAuthenticated,
  isProviderNativelyAuthenticatedForRouting,
} from '../auth/provider-auth-state';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { isCodeGraphAvailableForWorkspace } from '../lib/code-graph-availability';
import { buildCodeGraphAvailabilityPrompt } from '../lib/code-graph-availability-prompt';
import {
  CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
  buildClaudeCodeGraphPreToolUseContext,
  isClaudeCodeGraphBuildToolName,
  isClaudeCodeGraphPostToolUse,
  isClaudeCodeGraphToolName,
  loadConfiguredClaudeCodeGraphSourceExtensions,
} from '../lib/claude-code-graph-steering';
import {
  beginClaudeCodeGraphToolCall,
  isClaudeCodeGraphOrientationCurrent,
  readClaudeCodeGraphToolAnswer,
  recordClaudeCodeGraphOrientation,
} from '../lib/claude-code-graph-orientation';
import {
  detectClaudeQuotaReached,
  readClaudeQuotaResetsAt,
  detectAiCreditsNoBillingSource,
  markProviderQuotaReached,
} from './ai-credits-quota-state';
import { recordUsageLimitedChat } from '../lib/usage-limited-chats-registry';
import {
  buildUsageLimitedEntry,
  buildAccountProxyUsageLimitedEntry,
  classifyAccountChangeResume,
} from '../lib/usage-limited-chats-recording';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import { createClaudeContractGuard } from './provider-contract-guard';
import { buildProviderAuthFailureEvent } from './provider-auth-failure-event';
import { recordEventReceiptTime } from './event-receipt-time';
import type {
  CanopyAuthFailureEventData,
  ChatContextUsageBreakdown,
} from '@canopy/desktop-shared/types';
import { resolveWorkspaceRecordingSnapshot } from '../lib/resolve-workspace-display-name';
import {
  buildClaudeThinkingFlagSettings,
  buildClaudeThinkingOptions,
  clampThinkingLevelForModel,
  buildAiCreditsRequiredError,
  buildNoBillingSourceError,
  DEFAULT_CLAUDE_MODEL,
  NO_BILLING_SOURCE_ERROR_CODE,
  IPC_CHANNELS,
  hasAnySelections,
  type ApprovalMode,
  type TrackedPlanData,
  type ChatModel,
  CODE_REVIEW_CHAT_PROJECT_ID,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
  type ThinkingLevel,
  type PlanExitRequestEvent,
} from '@canopy/desktop-shared/types';
import {
  approvalCheckForClaudeTool,
  claudePermissionModeFor,
  CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT,
  isClaudePlanModeBookkeepingTool,
} from './claude-approval-adapter';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import {
  resolveClaudeModAdmissionContext,
  resolveClaudeModAdmissionLaunch,
} from './claude-mod-admission-launch';
import {
  clearClaudeModAdmissionSessionRecords,
  buildClaudeModsSkippedEvent,
  replaceClaudeModAdmissionSessionRecords,
} from './claude-mod-admission-session';
import { loadCachedInventory } from '../plugins/invocable-inventory-service';
import { normalizeInvocationToken } from '../plugins/invocation-prefix-normalizer';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { rejectAllForSession } from '../mcp/pending-requests';
import {
  ASK_USER_HTTP_TIMEOUT_MS,
  CANOPY_MCP_TOOL_TIMEOUT_MS,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import {
  mayExposeLedgerTools,
  openLedgerChatTools,
  type LedgerChatSettings,
  type LedgerChatTarget,
  type LedgerChatToolsSession,
} from '../canopy-tools/ledger-tools-runtime';
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
import { claudeNativeMemoryOptions } from '@canopy/execution-engine/node/lib/native-memory';
import { mergeClaudeModAdmissionSettings } from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import {
  readLatestPreferencesFile,
  readLocalMemoryEnabledPreference,
} from '../lib/preferences-store';
import {
  registerSession,
  unregisterSession,
  markSessionTeardownCause,
  getSessionKeyOwnership,
  getSessionInstanceId,
  buildSessionKey,
  getChildToolLiveness,
  recordClaudeSessionCronHookInput,
  createSessionPhaseTimer,
  isSessionAccountProxyRouted,
  recordSessionAccountProxyRoute,
  resetSessionLiveBackgroundTasks,
  SessionUnavailableForTaskStopError,
  type SessionKeyOwnership,
  type StopBackgroundTaskOutcome,
} from './session-manager';
import { notifySteeringEligibilityChanged } from './steering-eligibility-events';
import { createOwnedTurnState, type OwnedTurnState } from './owned-turn-state';
import {
  getBundledClaudeBinaryPath,
  getBundledRtkBinaryPath,
  getBundledRgBinaryPath,
  getEnhancedEnv,
  getRtkManagedEnv,
} from '../pipelines/config-paths';
import { createTrackedPlan, updateTrackedPlan } from '../lib/plan-persistence';
import { buildPlanFileSystemInstruction } from '../lib/plan-system-instructions';
import { sendToWindow } from '../lib/window-send';
import { noteChatSessionEvent } from '../lib/transient-error-retry-service';
import { getAttentionTracker } from '../services/attention-tracker';
import { commitPendingPlanExit } from '../services/chat-state-plan-exit';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { isRecord } from '../lib/type-guards';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import {
  captureClaudeContextSnapshot,
  claudeContextEndTokens,
} from '../observability/capture-fields';

import { logMainProcessWarn } from '../lib/main-process-logging';
import { buildRtkClaudeHooks } from '@canopy/execution-engine/node/rtk/claude-hooks';
import { resolveAnthropicMockEnvOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import {
  spawnClaudeCodeProcessOffMain,
  withholdClaudeProcessStdoutCreditUntil,
} from './claude-process-host-runner';
import { recordHostedClaudeProcessDiagnostic } from './claude-process-diagnostics';
import {
  CLAUDE_RECEIPT_READ_AHEAD_BYTES,
  CLAUDE_STDOUT_IN_FLIGHT_LIMIT_BYTES,
} from './claude-process-host-protocol';
import {
  getChatTurnAuditStatus,
  isPlanHandoffResult,
} from '../lib/chat-turn-audit';
import { requestShowFilesThroughLease } from '../canopy-tools/show-files-runtime';
import { hasInterfaceTool } from './interface-tool-binding';
import { createE2eClaudeQueryWithPrelude } from '../lib/e2e-claude-query-prelude';
import { assertAgentWorkerContext } from '../agent-runs/agent-worker-context';

/** Map of session keys to their active Query refs — used by stopTaskForClaudeSession. */
const queryRefs = new Map<string, Query>();
const sessionOwners = new Map<string, symbol>();
const CLAUDE_RECEIPT_QUEUE_LIMIT = 256;
export const CLAUDE_STOP_TIMEOUT_MS = 10_000;
const CLAUDE_PICKED_MESSAGE_LIMIT = 256;

/** How long a CLI may outlive its session's query loop before it is SIGKILLed. */
const CLAUDE_CLI_EXIT_GRACE_MS = 5_000;

/**
 * Nothing reads a CLI once its session's query loop has exited, however the
 * loop ended, and the SDK's own close() and kill escalation may never have
 * run. Close its input as close() would, then SIGKILL its process group
 * through the host unless it exits within the grace.
 */
function reapClaudeCliAfterLoopExit(cli: SpawnedProcess, key: string): void {
  if (cli.exitCode !== null || (cli.signalCode ?? null) !== null) return;
  try {
    if (!cli.stdin.writableEnded) cli.stdin.end();
  } catch {
    // The host already tore stdin down; the exit or the kill below settles it.
  }
  const timer = setTimeout(() => {
    logMainProcessWarn(
      `[claude-session] Claude CLI for ${key} outlived its query loop; killing it`,
    );
    cli.kill('SIGKILL');
  }, CLAUDE_CLI_EXIT_GRACE_MS);
  timer.unref?.();
  cli.once('exit', () => clearTimeout(timer));
}

/**
 * Key-scoped bookkeeping a session's query loop performs. A session acts on it
 * only while the key is its own: see `getSessionKeyOwnership`.
 */
interface OwnedSessionKey extends OwnedTurnState {
  release(): void;
}
const trackedPlansBySession = new Map<
  string,
  { planId: string; revisionNumber: number }
>();

export interface ClaudeStopFence {
  readonly processOwner: symbol;
  readonly turnId: string | undefined;
  readonly userMessageId: string | undefined;
  readonly turnEpoch: number;
}

export type ClaudeStopOutcome =
  | {
      readonly outcome: 'interrupted' | 'fallback-aborted';
      readonly fence: ClaudeStopFence;
    }
  | { readonly outcome: 'not-native-claude'; readonly fence?: never };

interface ClaudeStopController {
  capture(): ClaudeStopFence;
  isCurrent(fence: ClaudeStopFence): boolean;
  interrupt(fence: ClaudeStopFence): Promise<ClaudeStopOutcome>;
}

const nativeClaudeStopControllers = new WeakMap<
  AgentSession,
  ClaudeStopController
>();

export function captureClaudeStopFence(
  session: AgentSession | undefined,
): ClaudeStopFence | undefined {
  if (!session) return undefined;
  return nativeClaudeStopControllers.get(session)?.capture();
}

export function isClaudeStopFenceCurrent(
  session: AgentSession | undefined,
  fence: ClaudeStopFence,
): boolean {
  if (!session) return false;
  return nativeClaudeStopControllers.get(session)?.isCurrent(fence) ?? false;
}

export function interruptClaudeSessionForStop(
  session: AgentSession | undefined,
  fence?: ClaudeStopFence,
): Promise<ClaudeStopOutcome> {
  if (!session || !nativeClaudeStopControllers.has(session))
    return Promise.resolve({ outcome: 'not-native-claude' });
  const controller = nativeClaudeStopControllers.get(session);
  if (!controller) return Promise.resolve({ outcome: 'not-native-claude' });
  const capturedFence = fence ?? controller.capture();
  return controller.interrupt(capturedFence);
}

export interface ClaudeCompatibleInvocation {
  providerType: 'claude' | 'ollama';
  sdkModel?: string;
  envOverride?: Record<string, string>;
}

export interface ClaudeCodeProviderOptions {
  providerType?: 'claude' | 'ollama';
  prepareInvocation?: (
    model: ChatModel | undefined,
    reason: 'session-start' | 'model-change',
  ) => Promise<ClaudeCompatibleInvocation>;
}

interface QueuedClaudeMessage {
  text: string;
  userMessageId?: string;
  lifecycleExecutionId?: string;
  submissionId?: UUID;
  localSendEpoch?: number;
  steering?: boolean;
  countsTowardSkillUsage?: boolean;
}

interface PickedClaudeMessage {
  message: QueuedClaudeMessage;
  deliveryUuid: string | undefined;
  startSkillUsage: (turnId: string) => void;
}

interface RunningClaudeTurn {
  id: string;
  origin: 'user' | 'autonomous';
  userMessageId?: string;
  lifecycleExecutionId?: string;
  pickedMessage?: QueuedClaudeMessage;
}

type ClaudeCreditsTurnOwner = RunningClaudeTurn | QueuedClaudeMessage;

interface ClaudeEventReceipt {
  readonly receivedAtMonotonicMs: number;
  readonly eventTurn: QueuedClaudeMessage | undefined;
  readonly runningTurn: RunningClaudeTurn | undefined;
  readonly creditsOwner: ClaudeCreditsTurnOwner | undefined;
  readonly hasForegroundTurn: boolean;
  /**
   * A wake's turn id, set when this terminal seals it (turn-state phase 40f),
   * so admission stamps the turn the terminal ended, not the tracker's next.
   */
  wakeTurnId?: string;
}

interface ClaudeStopTerminalWaiter {
  readonly fence: ClaudeStopFence;
  resolve: () => void;
  superseded: boolean;
  terminalReceived: boolean;
}

function isClaudeRootInitEvent(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === 'system' &&
    value.subtype === 'init' &&
    value.parent_tool_use_id == null
  );
}

function isClaudeRootTerminalEvent(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === 'result' &&
    value.parent_tool_use_id == null &&
    !isClaudeTaskNotificationPreludeResult(value)
  );
}

function isClaudeRootErrorEvent(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === 'error' &&
    value.parent_tool_use_id == null
  );
}

function readClaudeLifecycleSessionState(
  value: Record<string, unknown>,
): 'running' | 'requires_action' | 'idle' | undefined {
  if (value.type !== 'system' || value.subtype !== 'session_state_changed')
    return undefined;
  const rawState = value.state;
  if (rawState === 'running' || rawState === 'busy' || rawState === 'working')
    return 'running';
  if (rawState === 'requires_action') return 'requires_action';
  if (rawState === 'idle') return 'idle';
  return undefined;
}

function readClaudeLifecycleOriginKind(
  value: Record<string, unknown>,
): string | undefined {
  if (!isRecord(value.origin) || typeof value.origin.kind !== 'string')
    return undefined;
  return value.origin.kind;
}

function readClaudeLifecycleResultIndex(
  value: Record<string, unknown>,
): number | undefined {
  return typeof value.result_index === 'number' &&
    Number.isInteger(value.result_index) &&
    value.result_index >= 0
    ? value.result_index
    : undefined;
}

/**
 * Resumed Claude sessions can flush a completed background-task notification
 * before they begin the foreground user turn. The SDK gives that side-channel
 * delivery its own zero-turn result, but the long-lived query remains active
 * and subsequently emits the foreground assistant response. Treating this as
 * terminal briefly marks the resumed session as expired in the renderer.
 */
function isClaudeTaskNotificationPreludeResult(
  event: Record<string, unknown>,
): boolean {
  if (
    event.type !== 'result' ||
    event.is_error === true ||
    event.num_turns !== 0 ||
    event.result !== ''
  ) {
    return false;
  }
  const origin = event.origin;
  if (typeof origin !== 'object' || origin === null) {
    return false;
  }
  const kind = 'kind' in origin ? origin.kind : undefined;
  return kind === 'task-notification' || kind === 'task_notification';
}

/**
 * Markers the Claude CLI uses to refuse a point-in-time fork resume.
 *
 * `resumeSessionAt` is validated against the source session's main chain, so
 * an anchor the CLI cannot find (a compacted or replaced session file, or a
 * sidechain uuid) is a hard failure rather than a silent full resume: the CLI
 * emits an `error_during_execution` result whose reason lands in `errors`,
 * and the SDK iterator then throws an `Error` carrying the same text.
 * `resumeDropsTurn` is not sent today; its refusal prefix is matched here so
 * adding it later cannot reintroduce an unrecoverable turn.
 */
const CLAUDE_FORK_RESUME_POINT_REJECTION_MARKERS = [
  'No message found with message.uuid of:',
  'Resume rejected by --resume-drops-turn:',
] as const;

function containsClaudeForkResumePointRejection(text: string): boolean {
  return CLAUDE_FORK_RESUME_POINT_REJECTION_MARKERS.some((marker) =>
    text.includes(marker),
  );
}

/**
 * True for the CLI's refusal of a point-in-time fork resume, in either shape:
 * the `error_during_execution` result event, or the error the SDK iterator
 * throws for it.
 */
function isClaudeForkResumePointRejection(value: unknown): boolean {
  if (value instanceof Error) {
    return containsClaudeForkResumePointRejection(value.message);
  }
  if (typeof value === 'string') {
    return containsClaudeForkResumePointRejection(value);
  }
  if (!isRecord(value) || value.type !== 'result' || value.is_error !== true) {
    return false;
  }
  const errors: unknown[] = Array.isArray(value.errors) ? value.errors : [];
  const candidates: unknown[] = [...errors, value.result];
  return candidates.some(
    (entry) =>
      typeof entry === 'string' &&
      containsClaudeForkResumePointRejection(entry),
  );
}

/**
 * Sentinel returned by the AI Credits routing resolvers when the defensive
 * backstop fires: the resolver has already emitted a clear error and the caller
 * must abort the session instead of falling back to native provider auth.
 */
const AI_CREDITS_BACKSTOP_ABORT = 'backstop-abort';

function getProviderErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function modelGatewayCredentialRejectionStatus(
  value: unknown,
): 401 | 403 | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['api_error_status', 'status', 'statusCode'] as const) {
    const status = record[key];
    if (status === 401 || status === 403) return status;
  }
  return undefined;
}

/** Only terminal/error-bearing Claude events can interrupt account recovery. */
function isClaudeAccountChangeFailureEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  if (!('type' in event)) return false;
  return (
    (event.type === 'assistant' &&
      'error' in event &&
      typeof event.error === 'string') ||
    (event.type === 'result' && 'is_error' in event && event.is_error === true)
  );
}

/**
 * Resolve AI Credits gateway routing for a Claude session, if active. Returns
 * the proxy env override and gateway model id to apply at session spawn,
 * `'backstop-abort'` when the backstop error was emitted and the caller must
 * not spawn the session, or `null` when routing is inactive / not a
 * Claude-harness model / no cloud context is available (in which case the
 * session uses native provider auth).
 */
async function resolveClaudeAiCreditsRouting(
  opts: AgentSessionOptions,
  emit: (data: unknown) => void | Promise<void>,
  routeSessionId: string,
): Promise<
  | {
      env: Record<string, string>;
      model: string;
      organizationId?: string;
      credentialVersion?: string;
      nativeAuthFallback?: boolean;
    }
  | typeof AI_CREDITS_BACKSTOP_ABORT
  | null
> {
  // Ollama sessions share the Claude-compatible SDK transport, but their
  // model registry and authentication are entirely local. Never apply Claude
  // AI Credits availability backstops to an Ollama model.
  if (opts.providerType === 'ollama') {
    return null;
  }
  const attempt = await resolveAiCreditsRoutingAttempt(
    opts.aiCreditsRouting,
    'claude',
    () =>
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    opts.subscriptionBillingOverride,
  );
  const gatewayCheck = await checkModelGatewayRoute(
    opts.model,
    await resolveSessionWorkOwner(opts),
  );
  if (!gatewayCheck.ok) throw new Error(gatewayCheck.message);
  const gatewayEnforced = gatewayCheck.orgRoute;
  // The confirmed-logout contract behind `no-native-auth` only covers what the
  // auth probe can see, and the probe deliberately runs without the Canopy
  // Environments injector that the spawn below uses. A user who supplies their
  // own `ANTHROPIC_API_KEY` (or a Bedrock/Vertex redirect) through Environments
  // therefore reads as signed out here while having a working provider at spawn
  // time — and routing them would SUPPRESS it, since the proxy env blanks
  // `ANTHROPIC_API_KEY` and is spread after the user environment. Fall through
  // to the native spawn, which is what `off` mode did before ECW-9091.
  if (
    attempt?.reason === 'no-native-auth' &&
    !gatewayEnforced &&
    hasUserSuppliedProviderCredential('claude', opts.projectId)
  ) {
    return null;
  }
  // `AgentSessionOptions.model` is optional. Before ECW-9091 a model-less spawn
  // in `off` mode resolved no attempt and went native; now the attempt is
  // non-null, so without a default the gateway lookup misses and the backstop
  // below aborts a session that should just work. Scope the default to the new
  // reason so `on` / `on-quota` behavior is untouched.
  const selectedModel =
    attempt?.modelId ??
    opts.model ??
    (attempt?.reason === 'no-native-auth' ? DEFAULT_CLAUDE_MODEL : undefined);
  if (isUnavailableModelSelection(selectedModel, 'claude')) {
    await emit({
      type: 'error',
      error:
        'This model is no longer available. Pick another model to continue.',
    });
    return AI_CREDITS_BACKSTOP_ABORT;
  }
  // A gateway-only model can never be billed via a native Claude login, so it
  // must always route through the gateway — even when the attempt resolver
  // returns null (e.g. a natively-authenticated user with routing mode off who
  // selected it anyway). The picker greys such rows without credits, but the
  // session must be robust to a forced/restored selection.
  const entry = resolveGatewayModelEntry(selectedModel);
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
    // they also have no native Claude login, surface a clear error instead of
    // falling through to a raw native provider auth failure (a 401). The picker
    // (Part B) prevents this, but the global routing modes ('on'/'on-quota')
    // resolve an attempt *before* native auth is ever consulted, so a
    // reason of 'mode'/'session-override' alone does not tell us whether the
    // user can fall back to a native spawn — re-check native auth here.
    // (`gatewayOnly` is false in this branch, so `attempt` is non-null.)
    const nativelyAuthenticated =
      attempt?.reason === 'no-native-auth'
        ? false
        : await isProviderNativelyAuthenticated('claude', 'ai-credits-routing');
    if (!nativelyAuthenticated) {
      await emit({
        type: 'error',
        error:
          "This model can't be used with AI Credits and Claude isn't connected. Connect Claude or pick a model covered by AI Credits.",
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
      return {
        env: await buildBrokeredOrgGatewayClaudeEnv(
          entry,
          routeSessionId,
          getMockLlmOrigin() ?? credential.baseUrl,
          attribution,
        ),
        model: entry.gatewayId,
        organizationId: entry.organizationId,
        credentialVersion: credential.credentialVersion,
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
      await emit({
        type: 'error',
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
        error: buildNoBillingSourceError('Claude', BRAND.displayName),
      });
      return AI_CREDITS_BACKSTOP_ABORT;
    }
    return null;
  }
  return {
    env: buildClaudeProxyEnv(
      entry,
      context.cskToken,
      context.cloudBaseUrl,
      attribution,
      { guestPrincipal: context.guestPrincipal },
    ),
    model: entry.gatewayId,
    nativeAuthFallback: attempt?.reason === 'no-native-auth' && !gatewayOnly,
  };
}

function withTurnMetadata(
  data: unknown,
  turn: QueuedClaudeMessage | undefined,
): unknown {
  if (!turn?.userMessageId || typeof data !== 'object' || data === null) {
    return data;
  }
  if (Array.isArray(data)) {
    return data;
  }
  return {
    ...data,
    canopy_turn_user_message_id: turn.userMessageId,
  };
}

function withChildToolLivenessStamp(
  data: unknown,
  opts: Pick<AgentSessionOptions, 'projectId' | 'worktreeId' | 'chatId'>,
  terminalLiveness?: ChildToolLiveness,
): unknown {
  if (!isRecord(data) || (data.type !== 'result' && data.type !== 'error')) {
    return data;
  }
  if (readChildToolLivenessStamp(data) !== undefined) return data;
  if (data.type === 'result' && data.canopy_session_continues === true)
    return data;
  return {
    ...data,
    [CHILD_TOOL_LIVENESS_STAMP]:
      terminalLiveness ??
      getChildToolLiveness(opts.projectId, opts.worktreeId, opts.chatId),
  };
}

function extractPlanText(input: Record<string, unknown>): string {
  return typeof input.plan === 'string'
    ? input.plan
    : JSON.stringify(input, null, 2);
}

async function upsertTrackedPlan(
  sessionKey: string,
  projectId: string,
  worktreeId: string,
  chatId: string,
  source: 'claude' | 'ollama',
  input: Record<string, unknown>,
): Promise<TrackedPlanData> {
  let existing = trackedPlansBySession.get(sessionKey);
  // A restored pending review still names the plan being revised. Read through
  // the canonical chat boundary; a new/approved/dismissed plan must not inherit
  // that identity or its revision count (CAN-5431).
  if (!existing) {
    const file = await readChatTabsFile(projectId, worktreeId, { chatIds: [] });
    const tab = file.tabs.find((entry) => entry.id === chatId);
    if (
      tab?.planMode === true &&
      tab.trackedPlanSource === source &&
      tab.trackedPlanReviewStatus === 'pending' &&
      tab.trackedPlanId
    ) {
      existing = {
        planId: tab.trackedPlanId,
        revisionNumber: tab.latestRevisionNumber ?? 1,
      };
    }
  }
  const planText = extractPlanText(input);

  if (existing) {
    const updated = await updateTrackedPlan({
      projectId,
      worktreeId,
      planId: existing.planId,
      content: planText,
      source,
      reviewStatus: 'pending',
      approvedAt: null,
      dismissedAt: null,
      chatId,
      initiationSource: 'user',
    });
    if (updated) {
      trackedPlansBySession.set(sessionKey, {
        planId: updated.id,
        revisionNumber: updated.latestRevisionNumber,
      });
      return updated;
    }
  }

  const created = await createTrackedPlan({
    projectId,
    worktreeId,
    source,
    content: planText,
    reviewStatus: 'pending',
    chatId,
    initiationSource: 'user',
  });
  trackedPlansBySession.set(sessionKey, {
    planId: created.id,
    revisionNumber: created.latestRevisionNumber,
  });
  return created;
}

/**
 * Stop a specific task within a Claude session. Called from session-manager.
 */
export async function stopTaskForClaudeSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  taskId: string,
): Promise<StopBackgroundTaskOutcome> {
  const key = buildSessionKey(projectId, worktreeId, chatId);
  const queryRef = queryRefs.get(key);
  if (!queryRef) {
    throw new SessionUnavailableForTaskStopError();
  }

  try {
    await queryRef.stopTask(taskId);
    return 'stopped';
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /status:\s*([a-z_]+)/i.exec(message)?.[1]?.toLowerCase();
    // The CLI already reaped the task. Stopping it is a success, but no
    // terminal notification will ever arrive, so the caller must reconcile the
    // activity card itself.
    if (
      status === 'killed' ||
      status === 'stopped' ||
      status === 'cancelled' ||
      status === 'canceled' ||
      status === 'failed' ||
      status === 'completed' ||
      /no active session|not running|unknown task|no such task/i.test(message)
    ) {
      return 'already-finished';
    }
    throw error;
  }
}

export type ClaudeNativeSubagentStopOutcome =
  | 'stopped'
  | 'unsupported'
  | 'not_running'
  | 'failed';

/**
 * Stop one Claude Task subagent owned by the named root query. The caller must
 * supply the provider task id resolved from that same chat's task_started
 * notification; the UI's tool_use id is used only to ask the SDK to background
 * that exact Task call if it is still foreground.
 */
export async function stopNativeSubagentForClaudeSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  toolUseId: string,
  taskId: string,
  wasBackgrounded: boolean,
): Promise<ClaudeNativeSubagentStopOutcome> {
  const queryRef = queryRefs.get(
    buildSessionKey(projectId, worktreeId, chatId),
  );
  if (!queryRef) return 'not_running';

  try {
    const backgroundedNow = await queryRef.backgroundTasks(toolUseId);
    if (!backgroundedNow && !wasBackgrounded) return 'unsupported';
    await queryRef.stopTask(taskId);
    return 'stopped';
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/is not running|unknown task|no such task/i.test(message)) {
      return 'not_running';
    }
    return 'failed';
  }
}

/**
 * What fills a Claude session's context window, by category, from the live
 * query (the data behind the CLI's /context). `summary` answers from the last
 * response's usage and local estimates, so opening the composer's usage
 * popover never makes extra token-counting API calls. Resolves `null` when
 * the chat has no live query (not started yet, or ended).
 */
export async function getContextUsageForClaudeSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<ChatContextUsageBreakdown | null> {
  const queryRef = queryRefs.get(
    buildSessionKey(projectId, worktreeId, chatId),
  );
  if (!queryRef) return null;
  const usage = await queryRef.getContextUsage({ detail: 'summary' });
  return {
    categories: usage.categories.map((category) => ({
      name: category.name,
      tokens: category.tokens,
      kind: category.kind,
    })),
    totalTokens: usage.totalTokens,
    maxTokens: usage.rawMaxTokens,
    percentage: usage.percentage,
  };
}

export class ClaudeCodeProvider implements AgentProvider {
  private readonly providerType: 'claude' | 'ollama';
  private readonly prepareInvocationImpl: (
    model: ChatModel | undefined,
    reason: 'session-start' | 'model-change',
  ) => Promise<ClaudeCompatibleInvocation>;

  constructor(options?: ClaudeCodeProviderOptions) {
    this.providerType = options?.providerType ?? 'claude';
    this.prepareInvocationImpl =
      options?.prepareInvocation ??
      ((model: ChatModel | undefined): Promise<ClaudeCompatibleInvocation> => {
        // Under the UI-automation/E2E build, redirect the Claude SDK to the mock
        // LLM server so live chat turns are deterministic. The gate and mock
        // literals live inside the shared helper, which production builds fold
        // to `return undefined` (Doc 11).
        const envOverride =
          this.providerType === 'claude'
            ? resolveAnthropicMockEnvOverride()
            : undefined;
        return Promise.resolve({
          providerType: this.providerType,
          ...(model ? { sdkModel: model } : {}),
          ...(envOverride ? { envOverride } : {}),
        });
      });
  }

  createSession(
    opts: AgentSessionOptions,
    onEvent: (data: unknown) => void | Promise<void>,
    getWindow: () => BrowserWindow | null,
  ): AgentSession {
    assertAgentWorkerContext('ClaudeCodeProvider.createSession');
    const prepareInvocation = this.prepareInvocationImpl;
    const key = buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId);
    const sessionOwner = Symbol();
    sessionOwners.set(key, sessionOwner);
    const ownsSession = (): boolean => sessionOwners.get(key) === sessionOwner;
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
      codeGraphToolsAdvertised,
      // One live list: the approval session adds grants to it, and managed
      // delegates evaluate their approvals against it.
      sessionApprovalRules: opts.sessionApprovalRules ?? [],
    };
    const abortController = new AbortController();
    const nativeClaudeSession = this.providerType === 'claude';
    const lifecycleScope = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
    };
    const lifecycleTracker = nativeClaudeSession
      ? new ClaudeTurnBindingTracker()
      : undefined;
    const eventTasks = nativeClaudeSession
      ? new ClaudeEventTaskTracker()
      : undefined;
    const lifecycleProducer = nativeClaudeSession
      ? getClaudeTurnLifecycleProducer(lifecycleScope)
      : undefined;
    // Ollama binds turns by queue order (no tracker), but canonical root turns
    // still need each one's start and end.
    const queueOrderLifecycleProducer = nativeClaudeSession
      ? undefined
      : getClaudeTurnLifecycleProducer(lifecycleScope);
    let lifecycleTurnStartedAtMs: number | undefined;
    let pendingWakeCause: SpawnedBy | undefined;
    let nativeSessionStateObserved = false;
    let lastResultFallbackStateTurnId: string | undefined;
    const contractGuard = createClaudeContractGuard(
      {
        sessionKey: key,
        projectId: opts.projectId,
        worktreeId: opts.worktreeId,
        chatId: opts.chatId,
      },
      (diagnostic) =>
        getExecutionObservabilityIngest().recordSessionDiagnostic(diagnostic),
      nativeClaudeSession,
    );
    let lifecycleProducerReleased = false;
    let activeProcessOwner = Symbol('native-claude-process');
    let turnEpoch = 0;
    let skillUsageDisposed = false;
    let managedDelegationDetached = false;
    const stopTerminalWaiters: ClaudeStopTerminalWaiter[] = [];
    const stopOperations: Array<{
      fence: ClaudeStopFence;
      promise: Promise<ClaudeStopOutcome>;
    }> = [];

    const disposeSkillUsage = (): void => {
      if (skillUsageDisposed) return;
      skillUsageDisposed = true;
      skillUsage.dispose();
    };
    const detachManagedDelegation = (): void => {
      if (managedDelegationDetached || !managedDelegation) return;
      managedDelegationDetached = true;
      managedDelegation.detach();
    };
    const releaseLifecycleProducer = (): void => {
      if (lifecycleProducerReleased || !ownsSession()) return;
      lifecycleProducerReleased = true;
      releaseClaudeTurnLifecycleProducer(lifecycleScope);
    };
    const advanceTurnEpoch = (supersedesStop: boolean): void => {
      turnEpoch += 1;
      if (supersedesStop) {
        for (const waiter of stopTerminalWaiters) waiter.superseded = true;
      }
    };
    const getForegroundFenceIdentity = (): {
      turnId: string | undefined;
      userMessageId: string | undefined;
    } => {
      if (runningTurn) {
        return {
          turnId: runningTurn.id,
          userMessageId:
            runningTurn.origin === 'autonomous'
              ? runningTurn.id
              : runningTurn.userMessageId,
        };
      }
      const pendingMessage =
        pendingTurn ??
        (runningTurnTerminalReceived ? undefined : activeTurn) ??
        messageQueue[0];
      return {
        turnId: undefined,
        userMessageId:
          pendingMessage?.userMessageId ?? pendingMessage?.submissionId,
      };
    };
    const captureFence = (): ClaudeStopFence => {
      const identity = getForegroundFenceIdentity();
      return {
        processOwner: activeProcessOwner,
        turnId: identity.turnId,
        userMessageId: identity.userMessageId,
        turnEpoch,
      };
    };
    const isFenceCurrent = (fence: ClaudeStopFence): boolean => {
      if (
        !nativeClaudeSession ||
        !ownsSession() ||
        destroyRequested ||
        queryLoopExited ||
        abortController.signal.aborted ||
        activeProcessOwner !== fence.processOwner ||
        turnEpoch !== fence.turnEpoch
      )
        return false;
      const current = getForegroundFenceIdentity();
      // A running turn keeps its id while uuid evidence rebinds its message.
      if (fence.turnId !== undefined) return current.turnId === fence.turnId;
      return (
        current.turnId === undefined &&
        current.userMessageId === fence.userMessageId
      );
    };
    const isCapturedDeadQueryFenceCurrent = (
      fence: ClaudeStopFence,
    ): boolean => {
      const currentSessionOwner = sessionOwners.get(key);
      return (
        nativeClaudeSession &&
        !destroyRequested &&
        activeProcessOwner === fence.processOwner &&
        turnEpoch === fence.turnEpoch &&
        (queryLoopExited || abortController.signal.aborted) &&
        (currentSessionOwner === sessionOwner ||
          (queryLoopExited && currentSessionOwner === undefined))
      );
    };
    const lifecycleBinding = (): TurnBinding | undefined =>
      lifecycleTracker?.current();
    const publishLifecycleTurnStarted = (
      binding: TurnBinding,
      phase: 'start' | 'binding-update',
    ): void => {
      if (!lifecycleProducer) return;
      lifecycleProducer.turnStarted({
        ...binding,
        phase,
        startedAtMs: lifecycleTurnStartedAtMs ?? Date.now(),
      });
      if (
        binding.binding === 'bound' &&
        binding.userMessageIds.length > 0 &&
        lifecycleRouteSession &&
        lifecycleBindingGeneration
      )
        observeRoutedTurnBinding(
          lifecycleScope,
          lifecycleRouteSession,
          binding.userMessageIds,
          lifecycleBindingGeneration,
          binding.turnId,
        );
    };
    const publishLifecycleBindingUpdate = (
      binding: TurnBinding | undefined,
    ): void => {
      if (!binding || !lifecycleTracker || !lifecycleProducer) return;
      lifecycleTurnStartedAtMs ??= Date.now();
      publishLifecycleTurnStarted(binding, 'binding-update');
    };
    const openLifecycleTurnForRunningTurn = (): void => {
      if (!runningTurn || !lifecycleTracker || !lifecycleProducer) return;
      const current = lifecycleBinding();
      if (current?.turnId === runningTurn.id) return;
      lifecycleTurnStartedAtMs = Date.now();
      const binding = lifecycleTracker.openTurn(
        runningTurn.id,
        pendingWakeCause,
      );
      pendingWakeCause = undefined;
      publishLifecycleTurnStarted(binding, 'start');
    };
    const publishResultFallbackState = (turnId: string | undefined): void => {
      if (
        !lifecycleProducer ||
        nativeSessionStateObserved ||
        (turnId !== undefined && lastResultFallbackStateTurnId === turnId)
      )
        return;
      if (turnId !== undefined) lastResultFallbackStateTurnId = turnId;
      lifecycleProducer.sessionState({
        state: 'idle',
        ...(turnId ? { observedDuringTurnId: turnId } : {}),
        source: 'result-fallback',
      });
    };
    /** Returns the sealed turn's id when it is a wake: autonomous, with a cause. */
    const publishLifecycleTerminal = (
      data: Record<string, unknown>,
      turn: RunningClaudeTurn | undefined,
      fallback = false,
    ): string | undefined => {
      if (!lifecycleProducer || !lifecycleTracker) return undefined;
      const causeBeforeSeal = lifecycleTracker.current()?.spawnedBy;
      const binding = lifecycleTracker.sealAtResult(
        fallback
          ? {}
          : {
              ...(readClaudeLifecycleOriginKind(data)
                ? { originKind: readClaudeLifecycleOriginKind(data) }
                : {}),
              ...(readClaudeLifecycleResultIndex(data) !== undefined
                ? { resultIndex: readClaudeLifecycleResultIndex(data) }
                : {}),
            },
        !fallback && isClaudeTaskEventResult(data)
          ? eventTasks?.eventCause()
          : undefined,
      );
      if (!binding) return undefined;
      publishResultFallbackState(turn?.id ?? binding.turnId);
      const reason =
        typeof data.terminal_reason === 'string'
          ? data.terminal_reason
          : typeof data.error === 'string'
            ? data.error
            : typeof data.result === 'string'
              ? data.result
              : undefined;
      // An interrupted result is an error result too; Stop decides first.
      const stopped =
        getChatTurnAuditStatus(data) === 'interrupted' ||
        (turn !== undefined &&
          stopTerminalWaiters.some((waiter) =>
            fenceTargetsTurn(waiter.fence, turn, undefined),
          ));
      // An event wake's cause, or one held while a send could still bind the
      // turn, arrives at its result, and the reducer takes a cause from a
      // binding update, not from the turn's end.
      if (binding.spawnedBy !== undefined && causeBeforeSeal === undefined)
        publishLifecycleTurnStarted(binding, 'binding-update');
      lifecycleProducer.turnEnded({
        ...binding,
        endedAtMs: Date.now(),
        ...(typeof data.duration_ms === 'number' &&
        Number.isFinite(data.duration_ms)
          ? { durationMs: data.duration_ms }
          : {}),
        outcome:
          fallback || abortController.signal.aborted || stopped
            ? 'cancelled'
            : (data.type === 'error' || data.is_error === true) &&
                !isPlanHandoffResult(data)
              ? 'failed'
              : 'completed',
        ...(reason ? { terminalReason: reason } : {}),
        source: fallback ? 'abort-fallback' : 'result',
      });
      return binding.origin === 'autonomous' && binding.spawnedBy !== undefined
        ? binding.turnId
        : undefined;
    };

    // Message queue for multi-turn communication (same pattern as Conductor)
    let accountProxyConnectionId: string | undefined;
    const messageQueue: QueuedClaudeMessage[] = [];
    const pickedOrdinaryMessages = new Map<string, PickedClaudeMessage>();
    const legacyPickedOrdinaryMessages: PickedClaudeMessage[] = [];
    const pendingOrdinaryMessages = new Set<QueuedClaudeMessage>();
    const stoppedOrdinaryMessages = new WeakSet<QueuedClaudeMessage>();
    const consumedExecutionOverrides = new WeakSet<QueuedClaudeMessage>();
    const skillUsage = new SkillUsageTracker(opts);
    let waitingForMessage:
      | ((msg: QueuedClaudeMessage | undefined) => void)
      | null = null;
    abortController.signal.addEventListener(
      'abort',
      () => {
        waitingForMessage?.(undefined);
        waitingForMessage = null;
      },
      { once: true },
    );
    let queryRef: Query | null = null;
    let approvalSessionRef: ApprovalSessionHandle | null = null;
    let rtkEnabled = opts.rtkEnabled !== false;
    let activeTurn: QueuedClaudeMessage | undefined;
    // Transcript ownership outlives receipt ownership while a terminal admits.
    const receivedTerminalTurns = new WeakSet<QueuedClaudeMessage>();
    let pendingTurn: QueuedClaudeMessage | undefined;
    let lastCreditsFailureTurn: QueuedClaudeMessage | undefined;
    let lastCreditsFailureOwner: ClaudeCreditsTurnOwner | undefined;
    let runningTurn: RunningClaudeTurn | undefined;
    // Provider completion fences steering before durable terminal delivery
    // settles the running turn's transcript and ownership.
    let runningTurnTerminalReceived = false;
    let latestDispatchedUserMessageId: string | undefined;
    let lastDispatchedMessage: QueuedClaudeMessage | undefined;
    let hasStartedRunningTurn = false;
    let warnedMissingAutonomousMessage = false;
    let runningTurnStartEffect: (() => void) | undefined;
    let destroyRequested = false;
    let queryLoopExited = false;
    let currentModel: ChatModel | undefined = opts.model;
    let currentSelectedModel: ChatModel | undefined =
      opts.selectedModel ?? opts.model;
    let currentPlanMode = opts.planMode ?? false;
    let currentThinkingLevel: ThinkingLevel = opts.thinkingLevel ?? 'high';
    let currentApprovalMode: ApprovalMode = opts.approvalMode ?? 'ask';
    let planModeEnabled = opts.planMode === true;
    let currentAiCreditsRouted = false;
    let currentHostedAiCreditsRouted = false;
    let currentNativeAuthFallback = false;
    // Weak identity keys bound deduplication to each foreground turn without
    // retaining completed turns. Routing is captured at query launch, never
    // re-read from account preferences while consuming delayed provider events.
    const creditsRecoveryTurns = new WeakSet<ClaudeCreditsTurnOwner>();
    const creditsDiagnosticTurns = new WeakSet<ClaudeCreditsTurnOwner>();
    let uncorrelatedCreditsRecovery = false;
    let uncorrelatedCreditsDiagnostic = false;
    // Reset time from this turn's latest rejected `rate_limit_event`. Claude
    // reports it separately from the 429 that ends the turn (CAN-4200).
    let lastClaudeRejectedResetsAt: number | undefined;
    let currentProviderSessionId = opts.sdkSessionId;
    const hostedProcesses = new Set<SpawnedProcess>();
    const providerType = this.providerType;
    const spawnHostedProcess = (
      options: SpawnOptions,
      onStarted?: () => void,
    ): SpawnedProcess => {
      const context = {
        sessionKey: key,
        sessionInstanceId: getSessionInstanceId(session),
        providerType,
      };
      const process = spawnClaudeCodeProcessOffMain(options, {
        ...context,
        isRegistered: () => keyOwnership() === 'registered',
        recordDiagnostic: (diagnostic): void => {
          recordHostedClaudeProcessDiagnostic(context, diagnostic);
          // The host reports a real PID once; a spawn that never starts doesn't.
          if (diagnostic.kind === 'claude_process_started') onStarted?.();
        },
      });
      hostedProcesses.add(process);
      process.on('exit', (code, signal) => {
        // The cause lands on the key's entry, so it must be this instance's:
        // the owner check kills CLIs whose instance has lost the key.
        if (
          ownsSession() &&
          keyOwnership() === 'registered' &&
          !destroyRequested &&
          !abortController.signal.aborted
        ) {
          const cause =
            signal !== null
              ? 'external_signal'
              : code !== null && code !== 0
                ? 'crash'
                : undefined;
          if (cause) {
            try {
              markSessionTeardownCause(key, cause);
            } catch {
              // Session-cause bookkeeping must never block provider cleanup.
            }
          }
        }
        hostedProcesses.delete(process);
      });
      return process;
    };
    const reapHostedProcesses = (): void => {
      for (const process of Array.from(hostedProcesses))
        reapClaudeCliAfterLoopExit(process, key);
      hostedProcesses.clear();
    };
    // Teardown runs late: an aborted loop ends only once its CLI exits, and a
    // replacement may have registered under the same key by then. This
    // instance's key-scoped state is its own while it is registered, or while
    // nothing is (a successor registers before it creates any such state).
    const keyOwnership = (): SessionKeyOwnership =>
      getSessionKeyOwnership(key, session);
    const ownedKey: OwnedSessionKey = {
      ...createOwnedTurnState(key, () => session),
      release(): void {
        if (queryRef && queryRefs.get(key) === queryRef) queryRefs.delete(key);
        const ownership = keyOwnership();
        if (ownership === 'replaced') {
          logMainProcessWarn(
            `[claude-session] A replacement registered under ${key} before this session's teardown; leaving its state`,
          );
          return;
        }
        // A newer Claude instance for the key, created but not yet
        // registered, may already hold the key's approvals and routes.
        if (ownsSession()) {
          rejectAllForSession(key);
          trackedPlansBySession.delete(key);
          getMcpHttpProxyService().unregisterRoutesForSession(key);
          getCodexGatewayProxyService().unregisterRoutesForSession(key);
          getMcpHttpProxyService().unregisterCanopyWorktreeSessionRoute(key);
        }
        if (ownership === 'registered') unregisterSession(key);
      },
    };
    const withholdCreditForAdmission = (
      admission: void | Promise<void>,
    ): void => {
      if (!admission || typeof admission.then !== 'function') return;
      // Chat storage group-commits, so the SDK keeps receiving events during
      // a pending admission, within a byte bound, so several of this chat's
      // commits can share one journal sync. Receipt-time signals must fit
      // beyond the host's forwarding window.
      const inFlightLimitBytes = Math.max(
        CLAUDE_STDOUT_IN_FLIGHT_LIMIT_BYTES,
        CLAUDE_RECEIPT_READ_AHEAD_BYTES,
      );
      for (const process of Array.from(hostedProcesses)) {
        withholdClaudeProcessStdoutCreditUntil(
          process,
          admission,
          inFlightLimitBytes,
        );
      }
    };
    let managedDelegation: ManagedDelegationSession | undefined;
    const terminalWaiters = new Set<() => void>();
    const pendingTerminalAdmissions = new Set<ClaudeEventReceipt>();
    const fenceTargetsTurn = (
      fence: ClaudeStopFence,
      turn: RunningClaudeTurn | undefined,
      eventTurn: QueuedClaudeMessage | undefined,
    ): boolean => {
      if (!turn) return false;
      if (fence.turnId !== undefined) return turn.id === fence.turnId;
      if (fence.userMessageId === undefined) return false;
      return (
        turn.id === fence.userMessageId ||
        turn.userMessageId === fence.userMessageId ||
        eventTurn?.userMessageId === fence.userMessageId ||
        eventTurn?.submissionId === fence.userMessageId
      );
    };
    const signalStopTerminalReceipt = (receipt: ClaudeEventReceipt): void => {
      for (const waiter of stopTerminalWaiters) {
        if (
          fenceTargetsTurn(waiter.fence, receipt.runningTurn, receipt.eventTurn)
        ) {
          waiter.terminalReceived = true;
          waiter.resolve();
        }
      }
    };
    const publishLifecycleReceipt = (
      data: unknown,
      receipt: ClaudeEventReceipt,
    ): void => {
      if (
        !nativeClaudeSession ||
        !lifecycleTracker ||
        !lifecycleProducer ||
        !isRecord(data) ||
        data.parent_tool_use_id != null
      )
        return;

      const sessionState = readClaudeLifecycleSessionState(data);
      if (sessionState) {
        nativeSessionStateObserved = true;
        lifecycleProducer.sessionState({
          state: sessionState,
          ...(receipt.runningTurn
            ? { observedDuringTurnId: receipt.runningTurn.id }
            : {}),
          source: 'provider',
        });
      }

      if (isClaudeRootTerminalEvent(data) || isClaudeRootErrorEvent(data)) {
        const wakeTurnId = publishLifecycleTerminal(data, receipt.runningTurn);
        if (wakeTurnId !== undefined) receipt.wakeTurnId = wakeTurnId;
      }
    };
    const settleTerminalWaiters = (): void => {
      if (
        !queryLoopExited &&
        (runningTurn || pendingTerminalAdmissions.size > 0)
      )
        return;
      if (queryLoopExited) pendingTerminalAdmissions.clear();
      terminalWaiters.forEach((settle) => settle());
      terminalWaiters.clear();
    };
    const queueOrderBinding = (turn: RunningClaudeTurn): TurnBinding => ({
      turnId: turn.id,
      origin: turn.origin,
      binding: turn.userMessageId === undefined ? 'unbound' : 'bound',
      submissionIds: [],
      userMessageIds:
        turn.userMessageId === undefined ? [] : [turn.userMessageId],
      providerUserMessageUuids: [],
    });
    const publishQueueOrderTurnEnded = (
      turn: RunningClaudeTurn,
      terminal: Record<string, unknown> | undefined,
    ): void => {
      if (!queueOrderLifecycleProducer) return;
      const reason =
        terminal === undefined
          ? undefined
          : typeof terminal.terminal_reason === 'string'
            ? terminal.terminal_reason
            : typeof terminal.error === 'string'
              ? terminal.error
              : typeof terminal.result === 'string'
                ? terminal.result
                : undefined;
      queueOrderLifecycleProducer.turnEnded({
        ...queueOrderBinding(turn),
        endedAtMs: Date.now(),
        outcome:
          terminal === undefined ||
          abortController.signal.aborted ||
          getChatTurnAuditStatus(terminal) === 'interrupted'
            ? 'cancelled'
            : (terminal.type === 'error' || terminal.is_error === true) &&
                !isPlanHandoffResult(terminal)
              ? 'failed'
              : 'completed',
        ...(reason ? { terminalReason: reason } : {}),
        // A turn cleared without its result ended with its query.
        source: terminal === undefined ? 'abort-fallback' : 'result',
      });
      queueOrderLifecycleProducer.sessionState({
        state: 'idle',
        observedDuringTurnId: turn.id,
        source: 'result-fallback',
      });
    };
    const startRunningTurn = (
      turn: RunningClaudeTurn,
      startSkillUsage?: (turnId: string) => void,
    ): boolean => {
      if (runningTurn) return false;
      runningTurn = turn;
      runningTurnTerminalReceived = false;
      notifySteeringEligibilityChanged(key);
      hasStartedRunningTurn = true;
      lastCreditsFailureOwner = undefined;
      runningTurnStartEffect?.();
      if (startSkillUsage) startSkillUsage(turn.id);
      else if (turn.origin === 'autonomous')
        skillUsage.startTurn(turn.id, false);
      queueOrderLifecycleProducer?.turnStarted({
        ...queueOrderBinding(turn),
        phase: 'start',
        startedAtMs: Date.now(),
      });
      return true;
    };
    const startRunningTurnForInit = (): boolean => {
      if (runningTurn) return false;
      const executionOverrideFor = (
        message: QueuedClaudeMessage | undefined,
      ): string | undefined => {
        if (
          !message?.lifecycleExecutionId ||
          consumedExecutionOverrides.has(message)
        )
          return undefined;
        consumedExecutionOverrides.add(message);
        return message.lifecycleExecutionId;
      };
      if (!nativeClaudeSession) {
        const picked = legacyPickedOrdinaryMessages.shift();
        if (picked) {
          const message = picked.message;
          const lifecycleExecutionId = executionOverrideFor(message);
          return startRunningTurn(
            {
              id: lifecycleExecutionId ?? message.userMessageId ?? randomUUID(),
              origin: 'user',
              ...(lifecycleExecutionId ? { lifecycleExecutionId } : {}),
              ...(message.userMessageId
                ? { userMessageId: message.userMessageId }
                : {}),
              pickedMessage: message,
            },
            picked.startSkillUsage,
          );
        }
      }
      const lifecycleExecutionId = executionOverrideFor(activeTurn);
      return startRunningTurn({
        id: lifecycleExecutionId ?? randomUUID(),
        origin: 'autonomous',
        ...(lifecycleExecutionId ? { lifecycleExecutionId } : {}),
      });
    };
    const retirePickedMessages = (data: unknown): void => {
      let retiredUuids: string[] = [];
      if (isClaudeRootTerminalEvent(data)) {
        const consumed: unknown = data.user_message_uuids;
        if (Array.isArray(consumed)) {
          const strings = consumed.filter(
            (uuid: unknown): uuid is string => typeof uuid === 'string',
          );
          if (strings.length === consumed.length) retiredUuids = strings;
        } else if (
          consumed === undefined &&
          typeof data.user_message_uuid === 'string'
        ) {
          retiredUuids = [data.user_message_uuid];
        }
      } else if (
        isRecord(data) &&
        data.parent_tool_use_id == null &&
        data.type === 'command_lifecycle' &&
        data.state === 'cancelled' &&
        typeof data.command_uuid === 'string'
      ) {
        retiredUuids = [data.command_uuid];
      }
      if (retiredUuids.length === 0) return;
      const retired: ReadonlySet<string> = new Set<string>(retiredUuids);
      pickedOrdinaryMessages.forEach(
        (picked: PickedClaudeMessage, submissionId: string) => {
          if (
            retired.has(submissionId) ||
            (picked.deliveryUuid !== undefined &&
              retired.has(picked.deliveryUuid))
          )
            pickedOrdinaryMessages.delete(submissionId);
        },
      );
      for (
        let index = legacyPickedOrdinaryMessages.length - 1;
        index >= 0;
        index -= 1
      ) {
        const picked = legacyPickedOrdinaryMessages[index];
        if (picked?.deliveryUuid && retired.has(picked.deliveryUuid))
          legacyPickedOrdinaryMessages.splice(index, 1);
      }
    };
    const ensureRunningTurnForToolCall = (): boolean => {
      if (
        runningTurn ||
        destroyRequested ||
        queryLoopExited ||
        abortController.signal.aborted
      )
        return false;
      const started = startRunningTurnForInit();
      if (started) openLifecycleTurnForRunningTurn();
      return started;
    };
    const startUserRunningTurnFromSteering = (userMessageId: string): void => {
      if (runningTurn) return;
      const lifecycleExecutionId =
        activeTurn?.lifecycleExecutionId &&
        !consumedExecutionOverrides.has(activeTurn)
          ? activeTurn.lifecycleExecutionId
          : undefined;
      if (lifecycleExecutionId && activeTurn)
        consumedExecutionOverrides.add(activeTurn);
      startRunningTurn(
        {
          id: lifecycleExecutionId ?? userMessageId,
          origin: 'user',
          userMessageId,
          ...(lifecycleExecutionId ? { lifecycleExecutionId } : {}),
          pickedMessage: activeTurn,
        },
        (turnId) => skillUsage.startTurn(turnId, false),
      );
    };
    const bindRunningTurnToLifecycleEvidence = (
      binding: TurnBinding | undefined,
    ): void => {
      if (
        !binding ||
        binding.binding !== 'bound' ||
        binding.origin !== 'user' ||
        !runningTurn ||
        binding.turnId !== runningTurn.id
      )
        return;

      let picked: PickedClaudeMessage | undefined;
      for (const submissionId of binding.submissionIds) {
        picked = pickedOrdinaryMessages.get(submissionId);
        if (picked) break;
      }
      const userMessageId =
        binding.userMessageIds[0] ?? picked?.message.userMessageId;
      const turn = runningTurn;
      runningTurn = {
        ...turn,
        origin: 'user',
        ...(userMessageId ? { userMessageId } : {}),
        ...(picked ? { pickedMessage: picked.message } : {}),
      };
      if (picked) {
        for (const submissionId of binding.submissionIds)
          pickedOrdinaryMessages.delete(submissionId);
        // Keep the phase-01 turn id stable while restoring the dispatched
        // prompt's original skill-accounting eligibility after UUID binding.
        skillUsage.endTurn();
        picked.startSkillUsage(turn.id);
      }
      notifySteeringEligibilityChanged(key);
    };
    const publishLifecycleBindingEvidence = (
      binding: TurnBinding | undefined,
    ): void => {
      publishLifecycleBindingUpdate(binding);
      bindRunningTurnToLifecycleEvidence(binding);
    };
    const observeLifecycleBindingEvidence = (data: unknown): void => {
      if (
        !nativeClaudeSession ||
        !lifecycleTracker ||
        !isRecord(data) ||
        data.parent_tool_use_id != null
      )
        return;

      const userMessageUuids: string[] = [];
      if (
        data.type === 'command_lifecycle' &&
        data.state === 'started' &&
        typeof data.command_uuid === 'string'
      )
        userMessageUuids.push(data.command_uuid);
      if (typeof data.user_message_uuid === 'string')
        userMessageUuids.push(data.user_message_uuid);
      if (Array.isArray(data.user_message_uuids)) {
        userMessageUuids.push(
          ...data.user_message_uuids.filter(
            (uuid): uuid is string => typeof uuid === 'string',
          ),
        );
      }
      if (userMessageUuids.length > 0)
        publishLifecycleBindingEvidence(
          lifecycleTracker.observeUserMessageUuids(userMessageUuids),
        );
      const bindingLimitDiagnostic =
        lifecycleTracker.consumeBindingLimitDiagnostic();
      if (bindingLimitDiagnostic) {
        const turn = lifecycleTracker.current();
        const evidence = JSON.stringify({
          rejectedInputCount: bindingLimitDiagnostic.rejectedInputCount,
          providerUserMessageUuids:
            bindingLimitDiagnostic.providerUserMessageUuids,
          userMessageIds: bindingLimitDiagnostic.userMessageIds,
          submissionIds: bindingLimitDiagnostic.submissionIds,
          truncated: bindingLimitDiagnostic.truncated,
        });
        try {
          getExecutionObservabilityIngest().recordSessionDiagnostic({
            version: 1,
            timestamp: new Date().toISOString(),
            kind: 'chat_event_dropped',
            sessionKey: key,
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            providerType: 'claude',
            chatEventDropGate: 'canonical_admission_rejected',
            chatEventDropReason: 'claude_binding_input_limit_exceeded',
            eventType: 'claude_binding_limit',
            error: evidence,
            ...(turn ? { providerTurnId: turn.turnId } : {}),
          });
        } catch {
          // Diagnostics are best effort and must not suppress provider events.
        }
      }
    };
    const clearRunningTurn = (terminal?: Record<string, unknown>): void => {
      const turn = runningTurn;
      runningTurn = undefined;
      if (turn && terminal === undefined)
        publishLifecycleTerminal(
          { type: 'result', result: 'Session ended' },
          turn,
          true,
        );
      if (turn) publishQueueOrderTurnEnded(turn, terminal);
      if (ownsSession()) notifySteeringEligibilityChanged(key);
      skillUsage.endTurn();
      settleTerminalWaiters();
    };
    const fenceSteeringForTerminal = (data: unknown): void => {
      if (
        !runningTurn ||
        runningTurnTerminalReceived ||
        !isRecord(data) ||
        data.parent_tool_use_id != null ||
        !(isClaudeRootErrorEvent(data) || isClaudeRootTerminalEvent(data))
      )
        return;
      runningTurnTerminalReceived = true;
      notifySteeringEligibilityChanged(key);
    };
    const getManagedCurrentMessage = (): string | undefined => {
      if (!runningTurn) return undefined;
      if (runningTurn.origin === 'user') return runningTurn.userMessageId;
      if (latestDispatchedUserMessageId !== undefined)
        return latestDispatchedUserMessageId;
      if (!warnedMissingAutonomousMessage) {
        warnedMissingAutonomousMessage = true;
        logMainProcessWarn(
          '[claude-session] Autonomous Claude turn has no dispatched user message',
        );
      }
      return runningTurn.id;
    };
    const inputDelivery = new ClaudeInputDelivery(
      randomUUID(),
      onEvent,
      (userMessageId) => {
        if (runningTurn) return false;
        activeTurn = { text: '', userMessageId };
        lastClaudeRejectedResetsAt = undefined;
        ownedKey.markTurnActive(userMessageId);
        startUserRunningTurnFromSteering(userMessageId);
        return true;
      },
      () => notifySteeringEligibilityChanged(key),
    );
    const lifecycleBindingGeneration = inputDelivery.generation;

    // Author details a Ledger binding records: this session's live settings.
    const readLedgerSettings = (): LedgerChatSettings => ({
      model: currentModel ?? null,
      thinkingEffort: clampThinkingLevelForModel(
        currentThinkingLevel,
        currentModel,
        'claude',
        currentAiCreditsRouted,
      ),
      planMode: planModeEnabled,
    });

    const applyCurrentThinkingFlagSettings = async (): Promise<void> => {
      if (!queryRef) return;
      await queryRef.applyFlagSettings(
        buildClaudeThinkingFlagSettings(
          clampThinkingLevelForModel(
            currentThinkingLevel,
            currentModel,
            'claude',
            currentAiCreditsRouted,
          ),
        ),
      );
    };

    const sendMessage = (
      text: string,
      sendOptions?: AgentSessionSendOptions,
    ): void => {
      advanceTurnEpoch(true);
      const queuedMessage: QueuedClaudeMessage = {
        text,
        submissionId: randomUUID(),
        localSendEpoch: turnEpoch,
        countsTowardSkillUsage: sendOptions?.countsTowardSkillUsage === true,
        ...(sendOptions?.lifecycleExecutionId
          ? { lifecycleExecutionId: sendOptions.lifecycleExecutionId }
          : {}),
        ...(sendOptions?.userMessageId
          ? { userMessageId: sendOptions.userMessageId }
          : {}),
      };
      messageQueue.push(queuedMessage);
      pendingOrdinaryMessages.add(queuedMessage);
      pendingTurn ??= queuedMessage;
      ownedKey.noteSessionMessageQueued(messageQueue.length);
      if (waitingForMessage) {
        const resolver = waitingForMessage;
        waitingForMessage = null;
        resolver(messageQueue.shift());
        ownedKey.noteSessionMessageQueued(messageQueue.length);
      }
    };

    const withdrawPendingOrdinaryMessagesForStop = (
      fence: ClaudeStopFence,
    ): void => {
      const queuedCountBeforeSweep = messageQueue.length;
      pendingOrdinaryMessages.forEach((message: QueuedClaudeMessage) => {
        if (
          message.localSendEpoch !== undefined &&
          message.localSendEpoch <= fence.turnEpoch
        ) {
          stoppedOrdinaryMessages.add(message);
          pendingOrdinaryMessages.delete(message);
        }
      });
      for (let index = messageQueue.length - 1; index >= 0; index--) {
        const message = messageQueue[index];
        if (message && stoppedOrdinaryMessages.has(message))
          messageQueue.splice(index, 1);
      }
      if (pendingTurn && stoppedOrdinaryMessages.has(pendingTurn))
        pendingTurn = messageQueue[0];
      if (messageQueue.length !== queuedCountBeforeSweep)
        ownedKey.noteSessionMessageQueued(messageQueue.length);
    };

    const receiveEvent = (data: unknown): ClaudeEventReceipt => {
      const receivedAtMonotonicMs = performance.now();
      fenceSteeringForTerminal(data);
      // The CLI starts a wake turn for a finished task; a prompt that binds
      // the turn makes it a user turn instead.
      pendingWakeCause = readClaudeWakeCause(data) ?? pendingWakeCause;
      // A cron job's fire starts its turn with a command no send queued.
      const startedCommand = readClaudeStartedCommandUuid(data);
      if (
        startedCommand !== undefined &&
        lifecycleTracker?.isOwnSend(startedCommand) === false
      )
        pendingWakeCause = eventTasks?.scheduledCause() ?? pendingWakeCause;
      eventTasks?.observe(data);
      if (isClaudeRootInitEvent(data)) {
        advanceTurnEpoch(true);
        startRunningTurnForInit();
        openLifecycleTurnForRunningTurn();
      }
      inputDelivery.receive(data);
      managedDelegation?.observe(data, runningTurn?.id);
      // Bind the session-local turn only from UUID evidence present at receipt;
      // a queued prompt's FIFO position is not evidence that a wake consumed it.
      observeLifecycleBindingEvidence(data);
      retirePickedMessages(data);
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'system' &&
        'subtype' in data &&
        data.subtype === 'init' &&
        'session_id' in data &&
        typeof data.session_id === 'string' &&
        (!('parent_tool_use_id' in data) || data.parent_tool_use_id == null)
      ) {
        currentProviderSessionId = data.session_id;
      }
      const hostedFailure = currentHostedAiCreditsRouted
        ? detectClaudeHostedNoBillingSource(data)
        : null;
      const normalizedData = hostedFailure
        ? withProxyFailureRestored(data, hostedFailure, 'claude')
        : data;
      const creditsFailure =
        currentAiCreditsRouted &&
        detectAiCreditsNoBillingSource(normalizedData);
      // The next prompt may already have replaced activeTurn before receipt.
      const runningMessage =
        runningTurn?.pickedMessage ??
        (runningTurn?.origin === 'user' &&
        runningTurn.userMessageId === activeTurn?.userMessageId
          ? activeTurn
          : undefined);
      const activeReceiptTurn =
        activeTurn && !receivedTerminalTurns.has(activeTurn)
          ? activeTurn
          : undefined;
      const eventTurn =
        nativeClaudeSession && runningTurn
          ? runningMessage
          : (runningMessage ??
            activeReceiptTurn ??
            (creditsFailure ? lastCreditsFailureTurn : undefined) ??
            pendingTurn);
      const creditsOwner =
        runningTurn ??
        lastCreditsFailureOwner ??
        (!hasStartedRunningTurn ? lastDispatchedMessage : undefined);
      if (creditsFailure && eventTurn) lastCreditsFailureTurn = eventTurn;
      if (creditsFailure && creditsOwner)
        lastCreditsFailureOwner = creditsOwner;
      if (
        isRecord(data) &&
        data.type === 'result' &&
        !isAiCreditsFailureEventShape(data, 'claude')
      )
        lastCreditsFailureTurn = undefined;
      const receipt: ClaudeEventReceipt = {
        receivedAtMonotonicMs,
        eventTurn,
        runningTurn,
        creditsOwner,
        hasForegroundTurn:
          activeReceiptTurn !== undefined || pendingTurn !== undefined,
      };
      if (isClaudeRootTerminalEvent(data) || isClaudeRootErrorEvent(data)) {
        advanceTurnEpoch(false);
        signalStopTerminalReceipt(receipt);
        publishLifecycleReceipt(data, receipt);
        pendingTerminalAdmissions.add(receipt);
        if (eventTurn) receivedTerminalTurns.add(eventTurn);
        if (receipt.runningTurn) clearRunningTurn(data);
      } else {
        publishLifecycleReceipt(data, receipt);
      }
      return Object.freeze(receipt);
    };

    const admitEvent = (
      data: unknown,
      terminalLiveness: ChildToolLiveness | undefined,
      receipt: ClaudeEventReceipt,
    ): void | Promise<void> => {
      inputDelivery.observe(data);
      const accountScope = currentAiCreditsRouted ? 'ai_credits' : 'native';
      const hostedFailure = currentHostedAiCreditsRouted
        ? detectClaudeHostedNoBillingSource(data)
        : null;
      const restoredData = hostedFailure
        ? withProxyFailureRestored(data, hostedFailure, 'claude')
        : data;
      const normalizedData = withClaudeAiCreditsFallbackError(
        restoredData,
        currentNativeAuthFallback,
      );
      const creditsFailure =
        accountScope === 'ai_credits' &&
        detectAiCreditsNoBillingSource(normalizedData);
      const { eventTurn } = receipt;
      const creditsOwner = receipt.runningTurn ?? receipt.creditsOwner;
      // A wake's root terminal carries its turn id, taken when it sealed the
      // turn, so the host files the wake's own turn diff under the wake's turn
      // (turn-state phase 40f).
      const { wakeTurnId } = receipt;
      const executionTurnId =
        isClaudeRootTerminalEvent(data) || isClaudeRootErrorEvent(data)
          ? (receipt.runningTurn?.id ?? wakeTurnId)
          : undefined;
      const stampedData = withChildToolLivenessStamp(
        withTurnMetadata(normalizedData, eventTurn),
        opts,
        terminalLiveness,
      );
      const eventData =
        (wakeTurnId !== undefined || executionTurnId !== undefined) &&
        isRecord(stampedData)
          ? {
              ...stampedData,
              ...(wakeTurnId !== undefined
                ? { canopy_wake_turn_id: wakeTurnId }
                : {}),
              ...(executionTurnId !== undefined
                ? { canopy_execution_turn_id: executionTurnId }
                : {}),
            }
          : stampedData;
      if (
        currentHostedAiCreditsRouted &&
        isAiCreditsFailureEventShape(data, 'claude') &&
        (hostedFailure !== null || readClaudeApiErrorStatus(data) === 402) &&
        !hasClaudeProxyFailureEvidence(data) &&
        !(creditsOwner
          ? creditsDiagnosticTurns.has(creditsOwner)
          : uncorrelatedCreditsDiagnostic)
      ) {
        if (creditsOwner) creditsDiagnosticTurns.add(creditsOwner);
        else uncorrelatedCreditsDiagnostic = true;
        const creditsOwnerId = creditsOwner
          ? 'id' in creditsOwner
            ? creditsOwner.id
            : creditsOwner.userMessageId
          : undefined;
        getExecutionObservabilityIngest().recordSessionDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'claude_ai_credits_402',
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          providerType: 'claude',
          claudeAiCredits402Outcome: hostedFailure
            ? 'inferred_no_billing_source'
            : 'unmatched',
          ...(creditsOwnerId ? { turnUserMessageId: creditsOwnerId } : {}),
        });
      }
      // Held until after `onEvent(eventData)` below. Ordering is load-bearing
      // for the shapes that DO produce an anchor, because the reducer writes
      // that notice while reducing THIS same event — emitting first would find
      // no anchor at all. Two shapes qualify (CAN-1814 review round 2):
      //   - a `result` whose text `isClaudeAuthenticationFailureMessage`
      //     recognizes, which `handleClaudeResultEvent` turns into a `system`
      //     message carrying that text;
      //   - a `{ type: 'error' }` event, which `handleClaudeErrorEvent` turns
      //     into a `system` `Error: <message>` notice.
      //
      // Ordering is NOT what keeps the failure off the wrong block. The shapes
      // `classifyAgentFailure` accepts that write NO block are
      // `{ type: 'assistant', error: 'authentication_failed' }` — the assistant
      // handler returns state untouched when the event carries no content
      // blocks — and a `result` whose body is unrecognized but whose turn
      // buffered an HTTP 401 elsewhere. For those,
      // `attachAuthFailureToMessages` deliberately attaches nothing rather than
      // falling back to the newest text block — which was the user's own prompt
      // bubble (CAN-1814 review).
      let providerAuthEvent: CanopyAuthFailureEventData | null = null;
      const sideAdmissions: Promise<void>[] = [];
      const trackSideAdmission = (admission: void | Promise<void>): void => {
        if (admission) {
          withholdCreditForAdmission(admission);
          sideAdmissions.push(Promise.resolve(admission));
        }
      };
      // Every notice derived from this event names the agent it came from, so
      // a sub-agent's failure is never read as the root turn's (CAN-4629).
      const emitDerivedNotice = scopeDerivedNotices(onEvent, eventData);
      const proxyInterruption =
        isRecord(data) &&
        data.type === 'result' &&
        data.is_error === true &&
        data.parent_tool_use_id == null
          ? buildAccountProxyUsageLimitedEntry(
              {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                provider: 'claude',
                detectedAt: Date.now(),
                accountProxyConnectionId,
                interruptedUserMessageId: activeTurn?.userMessageId,
              },
              data,
            )
          : null;
      if (proxyInterruption) {
        trackSideAdmission(recordUsageLimitedChat(proxyInterruption));
      }
      // A proxy account's sign-in or limit is not the user's own, so it never
      // starts native account recovery (CAN-4020).
      const resume =
        isClaudeAccountChangeFailureEvent(data) &&
        !isSessionAccountProxyRouted(
          opts.projectId,
          opts.worktreeId,
          opts.chatId,
        )
          ? classifyAccountChangeResume('claude', data, accountScope)
          : null;
      const resumeReason = resume?.reason ?? null;
      const rejectedResetsAt = readClaudeQuotaResetsAt(data);
      if (rejectedResetsAt !== undefined) {
        lastClaudeRejectedResetsAt = rejectedResetsAt;
      }
      if (
        creditsFailure &&
        !(creditsOwner
          ? creditsRecoveryTurns.has(creditsOwner)
          : uncorrelatedCreditsRecovery)
      ) {
        if (creditsOwner) creditsRecoveryTurns.add(creditsOwner);
        else uncorrelatedCreditsRecovery = true;
        trackSideAdmission(
          emitAiCreditsNoBillingSource(emitDerivedNotice, 'claude'),
        );
      }
      // Feed the common on-quota state so any surface's next session recreates
      // through AI Credits when Claude's native quota is reached (CAN-838), and
      // surface the shared usage-limit banner on every chat surface.
      if (resumeReason === 'usage_limit' && detectClaudeQuotaReached(data)) {
        const resetsAt = lastClaudeRejectedResetsAt ?? resume?.resetsAt;
        markProviderQuotaReached('claude', resetsAt);
        trackSideAdmission(
          emitAiCreditsUsageLimitReached(emitDerivedNotice, 'claude', resetsAt),
        );
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
              provider: 'claude',
              detectedAt: Date.now(),
              resetsAt,
              resumeReason,
              workspaceName: workspace.name,
              ...(workspace.type ? { workspaceType: workspace.type } : {}),
              chatTitle: '',
            }),
          );
        })();
      }
      // A turn's result is its last frame; its reset time never applies to a
      // later turn.
      if (isRecord(data) && data.type === 'result') {
        lastClaudeRejectedResetsAt = undefined;
      }
      if (resumeReason === 'authentication' && accountScope === 'native') {
        const classification = classifyAgentFailure({
          provider: 'claude',
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
              provider: 'claude',
              detectedAt: Date.now(),
              resumeReason,
              workspaceName: workspace.name,
              ...(workspace.type ? { workspaceType: workspace.type } : {}),
              chatTitle: '',
            }),
          );
        })();
      }
      const stampedProviderAuthEvent = providerAuthEvent
        ? withTurnMetadata(
            withFailureSourceScope(providerAuthEvent, data),
            eventTurn,
          )
        : null;
      if (ownsSession()) ownedKey.recordSessionEvent(eventData);
      const attentionFailure = noteChatSessionEvent(
        {
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
        },
        'claude',
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
      const deliverRecordedEvent = (): void | Promise<void> => {
        if (typeof eventData === 'object' && eventData !== null) {
          recordEventReceiptTime(eventData, receipt.receivedAtMonotonicMs);
        }
        const delivery = onEvent(eventData);
        withholdCreditForAdmission(delivery);
        // `recordSessionEvent` is session bookkeeping (lastActivityAt,
        // lastEventType, wake lock) and never reaches the renderer; `onEvent`
        // is the delivery path. Deliberately NOT also recorded: stamping
        // `lastEventType: 'canopy_auth_failure'` after a terminal `result` would
        // hide the terminal event from restore.
        if (stampedProviderAuthEvent) {
          // Stamped like every other emitted event. Only terminal events
          // consult turn ids today, but skipping the stamp is a latent trap.
          if (delivery && typeof delivery.then === 'function') {
            return Promise.resolve(delivery).then(() => {
              if (
                typeof stampedProviderAuthEvent === 'object' &&
                stampedProviderAuthEvent !== null
              ) {
                recordEventReceiptTime(
                  stampedProviderAuthEvent,
                  receipt.receivedAtMonotonicMs,
                );
              }
              const authDelivery = onEvent(stampedProviderAuthEvent);
              withholdCreditForAdmission(authDelivery);
              return authDelivery;
            });
          }
          if (
            typeof stampedProviderAuthEvent === 'object' &&
            stampedProviderAuthEvent !== null
          ) {
            recordEventReceiptTime(
              stampedProviderAuthEvent,
              receipt.receivedAtMonotonicMs,
            );
          }
          const authDelivery = onEvent(stampedProviderAuthEvent);
          withholdCreditForAdmission(authDelivery);
          return authDelivery;
        }
        return delivery;
      };
      if (sideAdmissions.length > 0) {
        return Promise.all(sideAdmissions).then(deliverRecordedEvent);
      }
      return deliverRecordedEvent();
    };

    const emitEvent = (
      data: unknown,
      terminalLiveness?: ChildToolLiveness,
      receipt: ClaudeEventReceipt = receiveEvent(data),
    ): void | Promise<void> => {
      const finish = (): void => {
        if (pendingTerminalAdmissions.delete(receipt)) settleTerminalWaiters();
      };
      try {
        const admission = admitEvent(data, terminalLiveness, receipt);
        if (admission) return Promise.resolve(admission).finally(finish);
        finish();
        return admission;
      } catch (error: unknown) {
        finish();
        throw error;
      }
    };

    const abortForStopFallback = (
      fence: ClaudeStopFence,
      capturedQuery: Query | null,
      waiter?: {
        superseded: boolean;
        terminalReceived: boolean;
      },
    ): ClaudeStopOutcome => {
      const currentSessionOwner = sessionOwners.get(key);
      const sessionOwnerMatches =
        currentSessionOwner === sessionOwner ||
        (queryLoopExited && currentSessionOwner === undefined);
      const targetStateMatches =
        (turnEpoch === fence.turnEpoch &&
          (isFenceCurrent(fence) ||
            queryLoopExited ||
            abortController.signal.aborted)) ||
        (waiter?.terminalReceived === true && !waiter.superseded);
      const processStillOwnsTarget =
        !waiter?.superseded &&
        nativeClaudeSession &&
        sessionOwnerMatches &&
        !destroyRequested &&
        activeProcessOwner === fence.processOwner &&
        queryRef === capturedQuery &&
        targetStateMatches;
      if (!processStillOwnsTarget) return { outcome: 'interrupted', fence };

      markSessionTeardownCause(key, 'stop');
      if (queryRefs.get(key) === capturedQuery && capturedQuery)
        queryRefs.delete(key);
      queryRef = null;
      inputDelivery.setQuery(undefined);
      inputDelivery.dispose();
      disposeSkillUsage();
      reapHostedProcesses();
      ownedKey.markTurnIdle();

      const fallbackTurnId = fence.turnId ?? fence.userMessageId;
      if (
        lifecycleTracker &&
        lifecycleProducer &&
        fallbackTurnId &&
        lifecycleTracker.current()?.turnId !== fallbackTurnId
      ) {
        lifecycleTurnStartedAtMs = Date.now();
        publishLifecycleTurnStarted(
          lifecycleTracker.openTurn(fallbackTurnId),
          'start',
        );
      }
      publishLifecycleTerminal(
        {
          type: 'result',
          is_error: false,
          result: 'Stop fallback aborted the native Claude query.',
        },
        runningTurn,
        true,
      );
      detachManagedDelegation();
      if (!abortController.signal.aborted) abortController.abort();
      return { outcome: 'fallback-aborted', fence };
    };

    const interruptForStop = (
      fence: ClaudeStopFence,
    ): Promise<ClaudeStopOutcome> => {
      const existing = stopOperations.find(
        (operation) =>
          operation.fence.processOwner === fence.processOwner &&
          operation.fence.turnId === fence.turnId &&
          operation.fence.userMessageId === fence.userMessageId &&
          operation.fence.turnEpoch === fence.turnEpoch,
      );
      if (existing) return existing.promise;

      const operation = (async (): Promise<ClaudeStopOutcome> => {
        const startedAtMs = Date.now();
        const deadlineAtMs = startedAtMs + CLAUDE_STOP_TIMEOUT_MS;
        const capturedQuery = queryRef;
        if (!isFenceCurrent(fence)) {
          if (isCapturedDeadQueryFenceCurrent(fence))
            return abortForStopFallback(fence, capturedQuery);
          return { outcome: 'interrupted', fence };
        }
        // An idle session has no foreground turn: Stop leaves it untouched.
        if (fence.turnId === undefined && fence.userMessageId === undefined)
          return { outcome: 'interrupted', fence };
        approvalSessionRef?.invalidatePending?.();

        // A query can be unavailable while the first invocation is still
        // preparing. Abort against the captured owner before withdrawing its
        // staged message, since withdrawal clears its pending projection.
        if (
          !capturedQuery ||
          capturedQuery !== queryRef ||
          activeProcessOwner !== fence.processOwner ||
          queryLoopExited ||
          destroyRequested ||
          abortController.signal.aborted ||
          !inputDelivery.getCapabilities().interrupt
        )
          return abortForStopFallback(fence, capturedQuery);

        withdrawPendingOrdinaryMessagesForStop(fence);

        const waiter = {
          fence,
          resolve: (): void => undefined,
          superseded: false,
          terminalReceived: false,
        };
        const rootTerminal = new Promise<void>((resolve) => {
          waiter.resolve = resolve;
        });
        stopTerminalWaiters.push(waiter);
        // Only a running root turn owes a terminal; the sweep withdraws a
        // send that has not started one.
        const stopsRunningTurn = fence.turnId !== undefined;

        try {
          const remainingMs = deadlineAtMs - Date.now();
          if (remainingMs <= 0)
            return abortForStopFallback(fence, capturedQuery, waiter);

          try {
            await withDeliveryDeadline(
              Promise.all([
                inputDelivery.sweep(remainingMs),
                stopsRunningTurn ? rootTerminal : undefined,
              ]).then((): void => undefined),
              remainingMs,
            );
          } catch {
            return abortForStopFallback(fence, capturedQuery, waiter);
          }

          if (
            waiter.superseded ||
            activeProcessOwner !== fence.processOwner ||
            capturedQuery !== queryRef ||
            !ownsSession()
          )
            return { outcome: 'interrupted', fence };

          if (!stopsRunningTurn) return { outcome: 'interrupted', fence };
          if (!waiter.terminalReceived)
            return abortForStopFallback(fence, capturedQuery);
          managedDelegation?.retireTurn();
          return { outcome: 'interrupted', fence };
        } finally {
          const waiterIndex = stopTerminalWaiters.indexOf(waiter);
          if (waiterIndex >= 0) stopTerminalWaiters.splice(waiterIndex, 1);
        }
      })();

      stopOperations.push({ fence, promise: operation });
      const removeOperation = (): void => {
        const index = stopOperations.findIndex(
          (item) => item.promise === operation,
        );
        if (index >= 0) stopOperations.splice(index, 1);
      };
      void operation.then(removeOperation, removeOperation);
      return operation;
    };

    const runPromise = Promise.resolve().then(async () => {
      if (managedDelegationEnabled(sessionOpts)) {
        // Defer the cycle-breaking delegation service load until this session
        // actually enables managed child agents.
        const { createManagedDelegationSession } =
          await import('./delegation/service');
        managedDelegation = await createManagedDelegationSession({
          harness: 'claude',
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
                '[claude-session] Delegation transcript delivery failed',
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
            approvalMode: currentApprovalMode,
            planMode: currentPlanMode,
          }),
          currentTurn: () => runningTurn?.id,
          currentMessage: getManagedCurrentMessage,
        });
      }
      await this._runQuery(
        sessionOpts,
        abortController,
        messageQueue,
        (resolver) => {
          waitingForMessage = resolver;
        },
        (message) => {
          if (!message.steering) {
            activeTurn = message;
            lastCreditsFailureTurn = undefined;
            lastClaudeRejectedResetsAt = undefined;
            // A new user turn resolves any prior plan-review or terminal-error
            // attention state for this chat before the next outcome is known.
            getAttentionTracker().clear(
              opts.projectId,
              opts.worktreeId,
              opts.chatId,
            );
          }
          if (pendingTurn === message) {
            pendingTurn = messageQueue[0];
          }
        },
        (message, startSkillUsage, deliveryUuid) => {
          lastDispatchedMessage = message;
          if (message.userMessageId !== undefined)
            latestDispatchedUserMessageId = message.userMessageId;
          if (lifecycleTracker) {
            const submissionId = message.submissionId ?? deliveryUuid;
            if (submissionId) {
              const kind: 'ordinary' | 'steer' = message.steering
                ? 'steer'
                : 'ordinary';
              const yielded = {
                submissionId,
                ...(message.userMessageId
                  ? { userMessageId: message.userMessageId }
                  : {}),
                kind,
              };
              if (deliveryUuid)
                lifecycleTracker.registerYielded(deliveryUuid, yielded);
              if (message.submissionId && message.submissionId !== deliveryUuid)
                lifecycleTracker.registerYielded(message.submissionId, yielded);
            }
          }
          if (!message.steering) {
            if (!hasStartedRunningTurn) lastCreditsFailureOwner = undefined;
            const picked = { message, startSkillUsage, deliveryUuid };
            pendingOrdinaryMessages.delete(message);
            if (lifecycleTracker) {
              const submissionId = message.submissionId ?? deliveryUuid;
              if (submissionId) {
                pickedOrdinaryMessages.delete(submissionId);
                pickedOrdinaryMessages.set(submissionId, picked);
                while (
                  pickedOrdinaryMessages.size > CLAUDE_PICKED_MESSAGE_LIMIT
                ) {
                  const oldest = pickedOrdinaryMessages.keys().next();
                  if (oldest.done) break;
                  pickedOrdinaryMessages.delete(oldest.value);
                }
              }
            } else legacyPickedOrdinaryMessages.push(picked);
          }
        },
        // The SDK reader is the only caller, so every frame here is a provider frame.
        (data) => {
          contractGuard.observe(data, isClaudeRootTerminalEvent(data));
          return receiveEvent(data);
        },
        ensureRunningTurnForToolCall,
        fenceSteeringForTerminal,
        (effect) => {
          runningTurnStartEffect = effect;
        },
        (message) => {
          if (stoppedOrdinaryMessages.has(message)) return false;
          if (!message.steering) {
            pendingOrdinaryMessages.delete(message);
            return true;
          }
          return (
            message.submissionId !== undefined &&
            inputDelivery.claimYield(message.submissionId)
          );
        },
        (receipt) => {
          if (
            receipt === undefined ||
            activeTurn === receipt.eventTurn ||
            (receipt.eventTurn === undefined &&
              receipt.runningTurn?.origin === 'autonomous')
          )
            activeTurn = undefined;
        },
        (receipt) => {
          if (
            ownsSession() &&
            (!runningTurn || runningTurn === receipt.runningTurn)
          )
            ownedKey.markTurnIdle();
        },
        () => activeTurn ?? pendingTurn,
        () =>
          !destroyRequested ||
          activeTurn !== undefined ||
          pendingTurn !== undefined,
        (q) => {
          if (queryRef !== q) {
            activeProcessOwner = Symbol('native-claude-process');
            nativeSessionStateObserved = false;
            lastResultFallbackStateTurnId = undefined;
            eventTasks?.resetLiveTasks();
            contractGuard.processRestarted();
          }
          queryRef = q;
          inputDelivery.setQuery(q);
          currentPlanMode = planModeEnabled;
          if (ownsSession()) queryRefs.set(key, q);
        },
        () => rtkEnabled,
        () => currentApprovalMode,
        () => planModeEnabled,
        (routed, hostedAiCreditsRouted, nativeAuthFallback) => {
          currentAiCreditsRouted = routed;
          currentHostedAiCreditsRouted = hostedAiCreditsRouted;
          currentNativeAuthFallback = nativeAuthFallback;
        },
        emitEvent,
        skillUsage,
        spawnHostedProcess,
        key,
        ownedKey,
        getWindow,
        (a) => {
          approvalSessionRef = a;
        },
        managedDelegation,
        detachManagedDelegation,
        ownsSession,
        readLedgerSettings,
        (connectionId) => {
          accountProxyConnectionId = connectionId;
        },
      );
    });
    // _runQuery settles (it catches its own startup/runtime errors) exactly
    // when the query loop has exited and its cleanup unregistered the
    // session — after that point queued messages can never be drained, even
    // though neither destroyRequested nor the abort signal was set.
    void runPromise.then(
      () => {
        queryLoopExited = true;
        settleTerminalWaiters();
        disposeSkillUsage();
        inputDelivery.dispose();
        reapHostedProcesses();
        clearRunningTurn();
        runningTurnStartEffect = undefined;
        releaseLifecycleProducer();
        if (ownsSession()) sessionOwners.delete(key);
      },
      (error: unknown) => {
        queryLoopExited = true;
        settleTerminalWaiters();
        disposeSkillUsage();
        inputDelivery.dispose();
        reapHostedProcesses();
        if (!ownsSession()) return;
        ownedKey.markTurnIdle();
        logMainProcessWarn('[claude-session] Managed session failed', error);
        void Promise.resolve(
          emitEvent(
            {
              type: 'error',
              error:
                'The managed session could not start or finish its owned cleanup.',
            },
            { kind: 'no-live-session' },
          ),
        )
          .catch((deliveryError: unknown) =>
            logMainProcessWarn(
              '[claude-session] Failed to report managed session failure',
              deliveryError,
            ),
          )
          .finally(() => {
            clearRunningTurn();
            runningTurnStartEffect = undefined;
            releaseLifecycleProducer();
            if (ownsSession()) sessionOwners.delete(key);
          });
        ownedKey.release();
        if (ownsSession()) sessionOwners.delete(key);
      },
    );

    const session: AgentSession = {
      sendMessage,
      getSteeringCapabilities: () => {
        const caps = inputDelivery.getCapabilities();
        return {
          ...caps,
          steer:
            caps.steer &&
            runningTurn !== undefined &&
            !runningTurnTerminalReceived,
        };
      },
      getSteeringWorkingDirectory: () => opts.cwd,
      getSteeringTarget() {
        if (currentProviderSessionId === undefined) return undefined;
        return { sessionId: currentProviderSessionId };
      },
      hasPendingSteeringInput: () => inputDelivery.hasPending(),
      submitSteeringInput(text, attemptId, userMessageId, target) {
        void target;
        if (abortController.signal.aborted)
          return Promise.resolve({
            kind: 'rejected',
            attemptId,
            reason: 'No active turn to steer',
            refusal: chatInputRefusal('no-active-turn'),
          });
        if (!runningTurn || runningTurnTerminalReceived)
          return Promise.resolve({
            kind: 'rejected',
            attemptId,
            reason: 'No active turn to steer',
            fallback: 'ordinary',
            refusal: chatInputRefusal('no-active-turn'),
          });
        return inputDelivery.submit(
          text,
          attemptId,
          userMessageId,
          () => {
            const message: QueuedClaudeMessage = {
              text,
              submissionId: attemptId as UUID,
              userMessageId,
              steering: true,
            };
            if (waitingForMessage) {
              const resolve = waitingForMessage;
              waitingForMessage = null;
              resolve(message);
            } else messageQueue.push(message);
          },
          { pendingOnDeadline: true },
        );
      },
      withdrawSteeringInput: (attemptId) => inputDelivery.withdraw(attemptId),
      async interruptWithPendingSweep() {
        approvalSessionRef?.invalidatePending?.();
        let settle = (): void => undefined;
        const terminal = new Promise<void>((resolve) => {
          settle = resolve;
        });
        if (
          !queryLoopExited &&
          (runningTurn || pendingTerminalAdmissions.size > 0)
        )
          terminalWaiters.add(settle);
        else settle();
        try {
          await inputDelivery.sweep();
          await withDeliveryDeadline(terminal);
        } finally {
          terminalWaiters.delete(settle);
        }
      },
      getProviderSessionId(): string | undefined {
        return currentProviderSessionId;
      },
      isDisposed(): boolean {
        // destroy() sets destroyRequested; cancel() aborts the controller,
        // which permanently ends the SDK query loop and unregisters the
        // session; and a query loop that exited on its own (caught startup
        // or runtime error) unregisters the session without setting either
        // flag. In all three cases a message queued after the fact can never
        // reach the provider.
        return (
          destroyRequested || abortController.signal.aborted || queryLoopExited
        );
      },
      async cancel() {
        approvalSessionRef?.invalidatePending?.();
        try {
          if (inputDelivery.hasPending()) await inputDelivery.sweep();
        } finally {
          disposeSkillUsage();
          inputDelivery.dispose();
          abortController.abort();
          // Stop ends this turn and its query, never the chat's delegations:
          // they keep running under the chat root until the user stops them.
          detachManagedDelegation();
        }
      },
      destroy() {
        if (destroyRequested) return runPromise;
        destroyRequested = true;
        if (ownsSession()) notifySteeringEligibilityChanged(key);
        abortController.abort();
        ownedKey.release();
        // Unblock any waiting message promise so the generator can exit
        if (waitingForMessage) {
          waitingForMessage(undefined);
          waitingForMessage = null;
        }
        // Recreate-on-next-turn waits on destroy(); do not let a replacement
        // session register under this key while the old query is still cleaning
        // up keyed session state.
        return runPromise;
      },
      setManagedDelegationMode(mode): void {
        if (mode !== undefined) managedDelegation?.updatePolicy(mode);
      },
      async setPlanMode(enabled: boolean) {
        planModeEnabled = enabled;
        if (!enabled) {
          trackedPlansBySession.delete(key);
        }
        if (enabled === currentPlanMode) return;
        if (!queryRef) return;
        if (
          !enabled &&
          currentApprovalMode === 'full-access' &&
          (opts.approvalMode ?? 'ask') !== 'full-access'
        ) {
          // This query was launched without the SDK's dangerous-skip
          // capability. The plan-mode toggle marks the session for next-turn
          // recreation, so keep the existing query in plan mode until then.
          return;
        }
        await queryRef.setPermissionMode(
          claudePermissionModeFor(currentApprovalMode, enabled),
        );
        currentPlanMode = enabled;
      },
      async setApprovalMode(mode: ApprovalMode) {
        // A newly created query already has this mode. Besides avoiding an
        // unnecessary control request, this lets fork recovery receive its
        // first prompt even if the original query rejects its resume point.
        if (mode === currentApprovalMode) return;
        const previousMode = currentApprovalMode;
        currentApprovalMode = mode;
        approvalSessionRef?.setMode(mode);
        if (!queryRef) return;
        if (
          mode === 'full-access' &&
          (opts.approvalMode ?? 'ask') !== 'full-access'
        ) {
          // This query was not launched with the SDK's dangerous-skip
          // capability. The caller marks it for next-turn recreation; avoid
          // asking the existing query to enter an unsupported bypass mode.
          return;
        }
        try {
          await queryRef.setPermissionMode(
            claudePermissionModeFor(mode, planModeEnabled),
          );
        } catch (error) {
          currentApprovalMode = previousMode;
          approvalSessionRef?.setMode(previousMode);
          throw error;
        }
      },
      setCodexProposalMode() {
        return Promise.resolve();
      },
      setRtkEnabled(enabled: boolean) {
        rtkEnabled = enabled;
        return Promise.resolve();
      },
      async setThinkingLevel(level: ThinkingLevel) {
        currentThinkingLevel = level;
        await applyCurrentThinkingFlagSettings();
      },
      async setModel(model: ChatModel) {
        currentModel = model;
        currentSelectedModel = model;
        if (!queryRef) return;
        const invocation = await prepareInvocation(model, 'model-change');
        await queryRef.setModel(invocation.sdkModel ?? model);
        await applyCurrentThinkingFlagSettings();
      },
    };

    const lifecycleRouteSession = session;

    // Ollama shares the SDK process plumbing, but retains its existing queue
    // and cancellation behavior. Native Claude delivery controls are opt-in.
    if (this.providerType !== 'claude') {
      delete session.getSteeringCapabilities;
      delete session.getSteeringWorkingDirectory;
      delete session.hasPendingSteeringInput;
      delete session.submitSteeringInput;
      delete session.withdrawSteeringInput;
      delete session.interruptWithPendingSweep;
    }

    if (nativeClaudeSession) {
      nativeClaudeStopControllers.set(session, {
        capture: captureFence,
        isCurrent: isFenceCurrent,
        interrupt: interruptForStop,
      });
    }

    registerSession(
      key,
      session,
      abortController,
      this.providerType,
      opts.model,
      opts.assistantMode ?? 'default',
      opts.toolProfileHash,
      codeGraphToolsAdvertised,
      opts.executionHarness,
    );

    return session;
  }

  private async _runQuery(
    opts: AgentSessionOptions,
    abortController: AbortController,
    messageQueue: QueuedClaudeMessage[],
    setWaiter: (
      resolver: ((msg: QueuedClaudeMessage | undefined) => void) | null,
    ) => void,
    setActiveTurn: (message: QueuedClaudeMessage) => void,
    onPromptDispatched: (
      message: QueuedClaudeMessage,
      startSkillUsage: (turnId: string) => void,
      deliveryUuid: string | undefined,
    ) => void,
    receiveEvent: (data: unknown) => ClaudeEventReceipt,
    ensureRunningTurnForToolCall: () => boolean,
    fenceSteeringForTerminal: (data: unknown) => void,
    setRunningTurnStartEffect: (effect: () => void) => void,
    canYieldMessage: (message: QueuedClaudeMessage) => boolean,
    clearActiveTurn: (receipt?: ClaudeEventReceipt) => void,
    markReceiptTurnIdle: (receipt: ClaudeEventReceipt) => void,
    getForegroundTurn: () => QueuedClaudeMessage | undefined,
    shouldEmitTerminalEvent: () => boolean,
    setQueryRef: (q: Query) => void,
    isRtkEnabled: () => boolean,
    getApprovalMode: () => ApprovalMode,
    isPlanModeEnabled: () => boolean,
    setAiCreditsRouted: (
      routed: boolean,
      hostedAiCreditsRouted: boolean,
      nativeAuthFallback: boolean,
    ) => void,
    emitEvent: (
      data: unknown,
      terminalLiveness?: ChildToolLiveness,
      receipt?: ClaudeEventReceipt,
    ) => void | Promise<void>,
    skillUsage: SkillUsageTracker,
    spawnHostedProcess: (
      options: SpawnOptions,
      onStarted?: () => void,
    ) => SpawnedProcess,
    key: string,
    ownedKey: OwnedSessionKey,
    getWindow: () => BrowserWindow | null,
    setApprovalSessionRef: (a: ApprovalSessionHandle) => void,
    managedDelegation: ManagedDelegationSession | undefined,
    detachManagedDelegation: () => void,
    ownsSession: () => boolean,
    readLedgerSettings?: () => LedgerChatSettings,
    setAccountProxyConnectionId?: (connectionId: string | undefined) => void,
  ): Promise<void> {
    let terminalEmitted = false;
    let accountProxyConnectionId: string | undefined;
    /** Ends the transcript's account switch lines for this query (CAN-4021). */
    let stopAccountProxySwitches: (() => void) | undefined;
    // Opened below with the default Canopy route or the App Advisor route
    // when the Ledger exposure gate passes; fixed for this query's lifetime.
    // A holder, because the prompt generator reads it after the assignment
    // below.
    const ledger: { tools: LedgerChatToolsSession | null } = { tools: null };
    let terminalTurn: QueuedClaudeMessage | undefined;
    /** The turn whose plan went to review, which its result then marks. */
    let planHandoff: { turn: QueuedClaudeMessage | undefined } | undefined;
    let lastRootAssistantContext:
      | {
          turn: QueuedClaudeMessage;
          endTokens: number;
        }
      | undefined;
    let codeGraphAvailableThisTurn = Boolean(
      buildCodeGraphAvailabilityPrompt(opts.projectId, opts.worktreeId, {
        liveAvailable: opts.codeGraphToolsAdvertised === true,
        toolsAdvertised: opts.codeGraphToolsAdvertised === true,
      }),
    );
    let codeGraphOrientationTurn: object = {};
    let codeGraphOrientationBlockedThisTurn = false;
    let codeGraphCustomSourceExtensionsThisTurn: readonly string[] | undefined;
    const resetCodeGraphTurnState = (): void => {
      codeGraphAvailableThisTurn = Boolean(
        buildCodeGraphAvailabilityPrompt(opts.projectId, opts.worktreeId, {
          liveAvailable: opts.codeGraphToolsAdvertised === true,
          toolsAdvertised: opts.codeGraphToolsAdvertised === true,
        }),
      );
      codeGraphOrientationTurn = {};
      codeGraphOrientationBlockedThisTurn = false;
      codeGraphCustomSourceExtensionsThisTurn = undefined;
    };
    setRunningTurnStartEffect(resetCodeGraphTurnState);
    const invocationProvider = this.providerType;
    let approvalSession: ApprovalSessionHandle | undefined;
    let orgGatewayOrganizationId: string | undefined;
    let orgGatewayCredentialVersion: string | undefined;
    try {
      ownedKey.recordSessionEvent({
        type: 'phase',
        phase: 'claude.prepare_invocation',
      });
      const stopPrepareTimer = createSessionPhaseTimer(
        key,
        'claude.prepare_invocation',
      );
      const invocation = await this.prepareInvocationImpl(
        opts.model,
        'session-start',
      ).finally(stopPrepareTimer);
      ownedKey.recordSessionEvent({
        type: 'phase',
        phase: 'claude.prepare_invocation.complete',
      });

      // Resolve plugin selections into SDK plugin configs
      let sdkPlugins: { type: 'local'; path: string }[] = [];
      let resolvedMcpServers: Record<string, McpServerConfig> = {};
      // One overlay pass: effective selections are computed here (with all
      // overlay IO) and passed straight into resolvePlugins.
      const pluginContext = await resolveEffectiveChatPluginContext(
        opts.pluginSelections,
        opts,
        opts.applyGlobalPluginDefaults,
      );
      const effectiveSelections = pluginContext.selections;
      const settingSources = ['user', 'project', 'local'] as const;
      // Inspect the config dir the child gets: its agent env plus overrides.
      const claudeModAdmissionEnvironment = {
        environment: { runtime: 'agent' as const, workspaceId: opts.projectId },
        ...(invocation.envOverride?.CLAUDE_CONFIG_DIR !== undefined
          ? { claudeConfigDir: invocation.envOverride.CLAUDE_CONFIG_DIR }
          : {}),
      };
      const claudeModAdmissionContext = await resolveClaudeModAdmissionContext({
        cwd: opts.cwd,
        settingSources,
        ...claudeModAdmissionEnvironment,
      });
      let claudeModAdmission: Awaited<
        ReturnType<typeof resolvePlugins>
      >['claudeModAdmission'];
      const claudeMaxTurns =
        invocation.providerType === 'claude'
          ? normalizeClaudeMaxTurns(
              (pluginContext.preferences ?? (await readLatestPreferencesFile()))
                .claudeMaxTurns,
            )
          : 200;

      if (
        hasAnySelections(effectiveSelections) ||
        opts.packageOverlay ||
        claudeModAdmissionContext !== undefined
      ) {
        try {
          ownedKey.recordSessionEvent({
            type: 'phase',
            phase: 'claude.resolve_plugins',
          });
          const stopPluginTimer = createSessionPhaseTimer(
            key,
            'claude.resolve_plugins',
          );
          const resolved = await resolvePlugins(
            effectiveSelections,
            opts.projectId,
            opts.worktreeId,
            opts.chatId,
            {
              purpose: 'claude-session',
              cwd: opts.cwd,
              settingSources,
              claudeModAdmissionContext,
              installExternalPlugins: true,
              enableHttpMcpProxy: true,
              mcpHttpProxyService: getMcpHttpProxyService(),
              sessionId: key,
              ...(opts.packageOverlay
                ? { packageOverlay: opts.packageOverlay }
                : {}),
              ...(pluginContext.preferences
                ? { preferences: pluginContext.preferences }
                : {}),
            },
          ).finally(stopPluginTimer);
          sdkPlugins = resolved.sdkPlugins;
          claudeModAdmission = resolved.claudeModAdmission;
          resolvedMcpServers = resolved.mcpServers as Record<
            string,
            McpServerConfig
          >;
          for (const w of resolved.warnings) {
            // eslint-disable-next-line no-console
            console.warn('[plugin-resolver]', w);
          }
          ownedKey.recordSessionEvent({
            type: 'phase',
            phase: 'claude.resolve_plugins.complete',
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[plugin-resolver] Failed to resolve plugins:', err);
          if (claudeModAdmissionContext) {
            // Without the resolver's decision, launch with no selected
            // plugins and still turn off unadmitted ambient Mods.
            sdkPlugins = [];
            const ambientOnly = await resolveClaudeModAdmissionLaunch({
              cwd: opts.cwd,
              settingSources,
              ...claudeModAdmissionEnvironment,
            });
            claudeModAdmission = ambientOnly
              ? {
                  ...(ambientOnly.settings
                    ? { settings: ambientOnly.settings }
                    : {}),
                  skippedMods: ambientOnly.skippedMods,
                }
              : undefined;
          }
        }
      }
      replaceClaudeModAdmissionSessionRecords(
        key,
        claudeModAdmission?.skippedMods ?? [],
      );

      // A point-in-time fork of a chat taken mid tool call resumes at an
      // assistant entry whose calls are still open; its first prompt must
      // answer them or the provider rejects the dangling tool_use.
      // Only a well-formed forked resume ends on those calls; a runtime
      // rejection strips these blocks from the replayed fresh prompt.
      let pendingForkToolResults =
        opts.sdkSessionId &&
        opts.claudeForkSession &&
        isClaudeChainUuid(opts.claudeForkResumeAt) &&
        opts.claudeForkToolResults?.length
          ? opts.claudeForkToolResults
          : undefined;
      type ClaudePromptContent =
        | string
        | Array<
            | { type: 'tool_result'; tool_use_id: string; content: string }
            | { type: 'text'; text: string }
          >;
      // Async generator for multi-turn prompts (same pattern as Conductor claudeHandler.ts:1164-1196)
      const promptInput = (async function* (): AsyncGenerator<{
        type: 'user';
        message: { role: 'user'; content: ClaudePromptContent };
        parent_tool_use_id: null;
        session_id: string;
        uuid?: UUID;
      }> {
        while (!abortController.signal.aborted) {
          let queuedMessage: QueuedClaudeMessage | undefined;

          if (messageQueue.length > 0) {
            queuedMessage = messageQueue.shift();
          } else {
            queuedMessage = await new Promise<QueuedClaudeMessage | undefined>(
              (resolve) => {
                setWaiter(resolve);
              },
            );
          }

          if (queuedMessage === undefined) {
            // Session destroyed
            return;
          }

          const inventory = await loadCachedInventory().catch(() => null);
          if (abortController.signal.aborted) return;
          const normalizedText = inventory
            ? normalizeInvocationToken(
                queuedMessage.text,
                inventory.entries.filter(
                  (entry) => entry.provider === invocationProvider,
                ),
              )
            : queuedMessage.text;

          if (!canYieldMessage(queuedMessage)) continue;
          setActiveTurn(queuedMessage);
          let skillUsageStarted = false;
          const startSkillUsage = (turnId: string): void => {
            if (queuedMessage.steering || skillUsageStarted) return;
            skillUsageStarted = true;
            const turn = skillUsage.startTurn(
              turnId,
              queuedMessage.countsTowardSkillUsage === true,
            );
            skillUsage.observeInvocation(
              turn,
              queuedMessage.text,
              inventory?.entries.filter(
                (entry) => entry.provider === invocationProvider,
              ) ?? [],
            );
          };
          // Claude reports a steer's lifecycle under the UUID it was sent
          // with, and input delivery knows it only by its attempt id, so a
          // delegate's steered message keeps that id, not its delivery id.
          const deliveryUuid = queuedMessage.steering
            ? queuedMessage.submissionId
            : (managedDelegation?.parent.nativeMessageUuid(
                queuedMessage.userMessageId,
              ) ?? queuedMessage.submissionId);
          // A normal turn starts with a bounded hint when entries assigned
          // to this chat changed since it last looked.
          const ledgerHint =
            ledger.tools !== null && !queuedMessage.steering
              ? await ledger.tools.assignmentHint()
              : undefined;
          const turnText = ledgerHint
            ? `${ledgerHint}\n\n${normalizedText}`
            : normalizedText;
          onPromptDispatched(queuedMessage, startSkillUsage, deliveryUuid);
          if (!queuedMessage.steering)
            ownedKey.markTurnActive(queuedMessage.userMessageId);
          const promptText =
            managedDelegation?.applyPolicyGuidance(turnText) ?? turnText;
          const forkToolResults = pendingForkToolResults;
          pendingForkToolResults = undefined;
          yield {
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: forkToolResults
                ? [
                    ...forkToolResults.map((result) => ({
                      type: 'tool_result' as const,
                      tool_use_id: result.toolUseId,
                      content: result.content,
                    })),
                    { type: 'text' as const, text: promptText },
                  ]
                : promptText,
            },
            parent_tool_use_id: null,
            session_id: key,
            ...(deliveryUuid ? { uuid: deliveryUuid } : {}),
          };
        }
      })();

      // A point-in-time fork resume can be refused by the CLI, and the only
      // safe recovery is a second fresh `query()` with no source-session
      // resume fields. `promptInput`
      // is a single live generator over the message queue, so the prompt it
      // already handed to the failed attempt would otherwise be lost: buffer
      // every yielded prompt and replay them into the retry in order. `next()` is
      // driven manually rather than with `for await` so tearing down an
      // attempt's wrapper never closes the shared generator underneath it.
      type ClaudePromptMessage =
        Awaited<
          ReturnType<(typeof promptInput)['next']>
        > extends IteratorResult<infer TValue>
          ? TValue
          : never;
      const bufferedPrompts: ClaudePromptMessage[] = [];
      let replayBufferedPrompts = false;
      let pendingPromptNext:
        | Promise<IteratorResult<ClaudePromptMessage>>
        | undefined;
      const nextSharedPrompt = (): Promise<
        IteratorResult<ClaudePromptMessage>
      > => {
        if (pendingPromptNext) return pendingPromptNext;
        const next = promptInput.next();
        const tracked = next.finally(() => {
          if (pendingPromptNext === tracked) pendingPromptNext = undefined;
        });
        pendingPromptNext = tracked;
        return tracked;
      };
      const nextPromptAttempt = (): AsyncGenerator<ClaudePromptMessage> =>
        (async function* (): AsyncGenerator<ClaudePromptMessage> {
          if (replayBufferedPrompts) {
            replayBufferedPrompts = false;
            const promptsToReplay = bufferedPrompts.splice(0);
            for (const prompt of promptsToReplay) {
              // The fresh retry has no source calls to answer.
              const content = prompt.message.content;
              yield typeof content === 'string'
                ? prompt
                : {
                    ...prompt,
                    message: {
                      ...prompt.message,
                      content: content
                        .flatMap((block) =>
                          block.type === 'text' ? [block.text] : [],
                        )
                        .join('\n\n'),
                    },
                  };
            }
          }
          for (;;) {
            // A failed SDK iterator can leave its prompt wrapper parked on an
            // eager pull. Reuse that exact pull in the retry so a later user
            // message cannot be consumed by the abandoned wrapper.
            const next = await nextSharedPrompt();
            if (next.done === true) return;
            if (
              forkResumePointRequested &&
              !forkResumePointAccepted &&
              !forkResumePointRejected
            ) {
              bufferedPrompts.push(next.value);
            }
            yield next.value;
          }
        })();
      const forkResumePointRequested = Boolean(
        opts.sdkSessionId &&
        opts.claudeForkSession &&
        isClaudeChainUuid(opts.claudeForkResumeAt),
      );
      // A supplied point-in-time anchor is part of the fork's context-safety
      // contract. If it is malformed, fail closed before the first query;
      // treating it like an absent anchor would resume the full source session
      // and expose turns the fork deliberately discarded.
      let forkResumePointRejected = Boolean(
        opts.sdkSessionId &&
        opts.claudeForkSession &&
        opts.claudeForkResumeAt !== undefined &&
        !isClaudeChainUuid(opts.claudeForkResumeAt),
      );
      let forkResumePointAccepted = false;

      const isCodeReview = opts.projectId === CODE_REVIEW_CHAT_PROJECT_ID;
      const canopyRuntime: CanopyInjectedToolRuntime = {
        authorizeInstalledItemUninstall: (request, context) =>
          authorizeInstalledItemUninstall(approvalSession, request, context),
        deferredToolsRuntime: {
          scope: {
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
          },
          providerType: opts.providerType ?? 'claude',
          interfaceMode: 'canopy',
          assistantMode: opts.assistantMode,
          pluginSelections: opts.pluginSelections,
          allowed: opts.deferredToolsAllowed !== false,
        },
        // Claude MCP path: omit `toolUseId` so the bridge generates a random
        // `requestId` and does NOT forward a `toolUseId` on the IPC event.
        // The renderer matches the pending card to the eventual
        // `mcp__canopy__AskUserQuestion` tool_use block by identical ordered
        // question text because the Claude Agent SDK does not expose `tool_use_id` in
        // the MCP `tool()` handler's `extra` argument.
        requestUserAnswers: (questions) =>
          requestAnswersFromRenderer({
            sessionKey: key,
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            questions,
            getWindow,
            providerType: 'claude',
            model: opts.model,
            onAwaitingUser: (): void => ownedKey.markTurnAwaitingUser(),
          }),
        loadScriptOutput: ({ scriptId, repo, maxLines }) =>
          loadWorktreeScriptOutput({
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            scriptId,
            repo,
            maxLines,
          }),
        loadGitPreferences,
        saveLocalMemory: (request) =>
          saveLocalMemory({
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            sessionId: opts.sdkSessionId,
            provider: 'claude',
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
        ...(!isCoworkWorkspace(opts.projectId) &&
        opts.assistantMode !== 'app-advisor' &&
        opts.assistantMode !== 'pipeline-editor'
          ? {
              worktreeActionRuntime: {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                cwd: opts.cwd,
                ...(opts.selectedRepoId ? { repoId: opts.selectedRepoId } : {}),
                getWindow,
              },
              worktreeWatcherRuntime: {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
              },
            }
          : {}),
        ...(opts.assistantMode !== 'app-advisor' &&
        opts.assistantMode !== 'pipeline-editor'
          ? {
              autoArchiveChat: {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
              },
            }
          : {}),
      };
      const useHttpCanopyMcp =
        opts.assistantMode === 'app-advisor'
          ? Boolean(opts.appAdvisorRuntime)
          : opts.assistantMode === 'pipeline-editor'
            ? Boolean(opts.pipelineEditorRuntime)
            : true;
      const canopyMcpServers: Record<string, McpServerConfig> = {};
      if (opts.assistantMode === 'app-advisor' && opts.appAdvisorRuntime) {
        // The Work Entry this session started in: the Ledger stays bound to
        // it, whatever entry the App Advisor window selects later. The gate
        // runs once per session, and each call re-checks the flag and the
        // "Agents add to the Feed" setting.
        const ledgerTarget: LedgerChatTarget = {
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          assistantMode: 'app-advisor',
        };
        ledger.tools =
          readLedgerSettings && mayExposeLedgerTools(ledgerTarget)
            ? await openLedgerChatTools({
                target: ledgerTarget,
                harness: 'claude',
                // App Advisor advertises the Ledger tools under its own names.
                toolNames: getAppAdvisorLedgerToolNames('claude'),
                readSettings: readLedgerSettings,
              })
            : null;
        managedDelegation?.setLedgerTools(ledger.tools ?? undefined);
        const authToken = randomBytes(32).toString('base64url');
        const proxyService = getMcpHttpProxyService();
        await proxyService.registerCanopyWorktreeSessionRoute({
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          interfaceTools: opts.interfaceTools ?? [],
          assistantMode: 'app-advisor',
          cwd: opts.cwd,
          ...(opts.selectedRepoId ? { repoId: opts.selectedRepoId } : {}),
          sdkSessionId: opts.sdkSessionId ?? key,
          providerType: opts.providerType ?? 'claude',
          pluginSelections: opts.pluginSelections,
          deferredToolsAllowed: opts.deferredToolsAllowed !== false,
          authToken,
          createdAt: Date.now(),
          hookHandler: () => undefined,
          appAdvisorRuntime: opts.appAdvisorRuntime,
          ...(ledger.tools ? { ledgerTools: ledger.tools } : {}),
        });
        const mainUrl = proxyService.getCanopyWorktreeMcpUrl(key);
        const uiUrl = proxyService.getCanopyWorktreeUiMcpUrl(key);
        const headers = { Authorization: `Bearer ${authToken}` };
        canopyMcpServers[`${BRAND.tools.namespace}_app_advisor`] = {
          type: 'http',
          url: mainUrl,
          headers,
          timeout: CANOPY_MCP_TOOL_TIMEOUT_MS,
          alwaysLoad: true,
        };
        canopyMcpServers[`${BRAND.tools.namespace}_ui`] = {
          type: 'http',
          url: uiUrl,
          headers,
          timeout: ASK_USER_HTTP_TIMEOUT_MS,
          alwaysLoad: true,
        };
      } else if (
        opts.assistantMode === 'pipeline-editor' &&
        opts.pipelineEditorRuntime
      ) {
        const authToken = randomBytes(32).toString('base64url');
        const proxyService = getMcpHttpProxyService();
        await proxyService.registerCanopyWorktreeSessionRoute({
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          interfaceTools: opts.interfaceTools ?? [],
          assistantMode: 'pipeline-editor',
          cwd: opts.cwd,
          ...(opts.selectedRepoId ? { repoId: opts.selectedRepoId } : {}),
          sdkSessionId: opts.sdkSessionId ?? key,
          providerType: opts.providerType ?? 'claude',
          pluginSelections: opts.pluginSelections,
          deferredToolsAllowed: opts.deferredToolsAllowed !== false,
          authToken,
          createdAt: Date.now(),
          hookHandler: () => undefined,
          pipelineEditorRuntime: opts.pipelineEditorRuntime,
        });
        const mainUrl = proxyService.getCanopyWorktreeMcpUrl(key);
        const uiUrl = proxyService.getCanopyWorktreeUiMcpUrl(key);
        const headers = { Authorization: `Bearer ${authToken}` };
        canopyMcpServers[`${BRAND.tools.namespace}_pipeline_editor`] = {
          type: 'http',
          url: mainUrl,
          headers,
          timeout: CANOPY_MCP_TOOL_TIMEOUT_MS,
          alwaysLoad: true,
        };
        canopyMcpServers[`${BRAND.tools.namespace}_ui`] = {
          type: 'http',
          url: uiUrl,
          headers,
          timeout: ASK_USER_HTTP_TIMEOUT_MS,
          alwaysLoad: true,
        };
      } else if (useHttpCanopyMcp) {
        const ledgerTarget: LedgerChatTarget = {
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          assistantMode: opts.assistantMode,
        };
        // The exposure gate runs once per session: a session keeps the
        // Ledger tools it started with, and each call re-checks the flag and
        // the "Agents add to the Feed" setting.
        ledger.tools =
          readLedgerSettings && mayExposeLedgerTools(ledgerTarget)
            ? await openLedgerChatTools({
                target: ledgerTarget,
                harness: 'claude',
                readSettings: readLedgerSettings,
                ...(opts.selectedRepoId
                  ? { selectedRepoId: opts.selectedRepoId }
                  : {}),
              })
            : null;
        managedDelegation?.setLedgerTools(ledger.tools ?? undefined);
        const authToken = randomBytes(32).toString('base64url');
        const proxyService = getMcpHttpProxyService();
        await proxyService.registerCanopyWorktreeSessionRoute({
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          interfaceTools: opts.interfaceTools ?? [],
          assistantMode: 'default',
          toolSurface: isCoworkWorkspace(opts.projectId)
            ? 'native-sdk-standalone'
            : 'native-sdk',
          cwd: opts.cwd,
          ...(opts.selectedRepoId ? { repoId: opts.selectedRepoId } : {}),
          sdkSessionId: opts.sdkSessionId ?? key,
          providerType: opts.providerType ?? 'claude',
          pluginSelections: opts.pluginSelections,
          deferredToolsAllowed: opts.deferredToolsAllowed !== false,
          authToken,
          createdAt: Date.now(),
          hookHandler: () => undefined,
          codeGraphToolsAdvertised:
            opts.codeGraphToolsAdvertised ??
            isCodeGraphAvailableForWorkspace(opts.projectId),
          ...(ledger.tools ? { ledgerTools: ledger.tools } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          onAwaitingUser: () => ownedKey.markTurnAwaitingUser(),
          ...(managedDelegation
            ? {
                managedDelegation: {
                  tools: managedDelegation.mcpTools,
                  invoke: async (
                    name: string,
                    input: unknown,
                  ): Promise<{ text: string; isError: boolean }> => {
                    const result = await managedDelegation.parent.invokeClaude(
                      name,
                      input,
                    );
                    return {
                      text: JSON.stringify(result),
                      isError: !result.ok,
                    };
                  },
                },
              }
            : {}),
          autoArchiveAvailable: true,
          ...(isCodeReview
            ? {
                isCodeReview: true,
                respondToReviewComment: canopyRuntime.respondToReviewComment,
                getReviewCommentThread: canopyRuntime.getReviewCommentThread,
              }
            : {}),
        });
        const mainUrl = proxyService.getCanopyWorktreeMcpUrl(key);
        const uiUrl = proxyService.getCanopyWorktreeUiMcpUrl(key);
        const headers = { Authorization: `Bearer ${authToken}` };
        canopyMcpServers[BRAND.tools.namespace] = {
          type: 'http',
          url: mainUrl,
          headers,
          timeout: CANOPY_MCP_TOOL_TIMEOUT_MS,
          alwaysLoad: true,
        };
        canopyMcpServers[`${BRAND.tools.namespace}_ui`] = {
          type: 'http',
          url: uiUrl,
          headers,
          timeout: ASK_USER_HTTP_TIMEOUT_MS,
          alwaysLoad: true,
        };
      }

      // Permission bypass: this desktop assistant runs in a user-selected
      // worktree where the user explicitly chose to start an agent. The agent
      // operates under the user's OS-level permissions (same as running a
      // terminal command). Restricting SDK permissions here would only add
      // friction without improving security, since Electron already runs with
      // full user privileges. Prompt-injection mitigations should be addressed
      // at the SDK/model layer, not by re-prompting the user for each tool call.
      const rtkBinaryPath = getBundledRtkBinaryPath();
      // Always call the async resolver; it returns `null` fast on the common
      // native path (one cached auth read after warm, no cloud I/O). It
      // consults per-session override, the global mode + per-provider quota
      // state, and finally native-auth presence, so routing applies to every
      // chat surface — not just ones that thread per-tab routing state.
      // The account proxy the user turned on for this device goes first. Only
      // AI Credits chosen for this chat or for every session, Ollama, an
      // organization gateway, or a model only AI Credits serves skip it
      // (CAN-4020, CAN-4090).
      if (
        opts.requiredAccountProxyConnectionId &&
        (opts.providerType === 'ollama' ||
          isAiCreditsChosenOverAccountProxy(
            opts.aiCreditsRouting,
            opts.subscriptionBillingOverride,
          ) ||
          opts.accountProxyRouting === 'off')
      )
        throw new Error(
          'The account proxy connection for this continuation is unavailable.',
        );
      const accountProxyRoute =
        opts.providerType === 'ollama' ||
        isAiCreditsChosenOverAccountProxy(
          opts.aiCreditsRouting,
          opts.subscriptionBillingOverride,
        ) ||
        opts.accountProxyRouting === 'off'
          ? null
          : await resolveAccountProxySessionRoute({
              harness: 'claude',
              requiredConnectionId: opts.requiredAccountProxyConnectionId,
              signal: abortController.signal,
              model: opts.model,
              sessionId: key,
              resolveWorkOwner: () => resolveSessionWorkOwner(opts),
            });
      accountProxyConnectionId = accountProxyRoute?.accountKey.slice(
        'account-proxy:'.length,
      );
      setAccountProxyConnectionId?.(accountProxyConnectionId);
      recordSessionAccountProxyRoute(key, accountProxyRoute !== null);
      if (accountProxyRoute) {
        stopAccountProxySwitches = watchAccountProxySwitches(key, emitEvent);
      }
      const aiCreditsRouting = accountProxyRoute
        ? null
        : await resolveClaudeAiCreditsRouting(opts, emitEvent, key);
      if (aiCreditsRouting === AI_CREDITS_BACKSTOP_ABORT) {
        // The resolver already emitted a clear error explaining why this model
        // can't run. Do not spawn the native session — it would emit a second
        // raw provider auth failure on top of the backstop message (CAN-838).
        const statusAdmission = emitAiCreditsRoutingStatus(
          emitEvent,
          'claude',
          false,
        );
        if (statusAdmission) await statusAdmission;
        return;
      }
      const aiCreditsRouted = aiCreditsRouting !== null;
      orgGatewayOrganizationId = aiCreditsRouting?.organizationId;
      orgGatewayCredentialVersion = aiCreditsRouting?.credentialVersion;
      setAiCreditsRouted(
        aiCreditsRouted,
        aiCreditsRouting !== null &&
          aiCreditsRouting.organizationId === undefined,
        aiCreditsRouting?.nativeAuthFallback === true,
      );
      // Clamp against the metadata for the route that will actually execute
      // this session. Live gateway levels can differ from the native model.
      const thinkingLevel = clampThinkingLevelForModel(
        opts.thinkingLevel ?? 'high',
        opts.model,
        'claude',
        aiCreditsRouted,
      );
      const thinkingOptions = buildClaudeThinkingOptions(thinkingLevel);
      // Local memory is opt-in; only an enabled preference suppresses
      // harness-native auto-memory on this launch (CAN-1969).
      const localMemoryEnabled = await readLocalMemoryEnabledPreference();
      // Authoritatively tell the renderer whether this session is routing, so
      // the shared status banner is correct on every surface (CAN-838).
      const statusAdmission = emitAiCreditsRoutingStatus(
        emitEvent,
        'claude',
        aiCreditsRouting !== null,
        accountProxyRoute !== null,
      );
      if (statusAdmission) await statusAdmission;
      const routedSdkModel = aiCreditsRouting?.model ?? invocation.sdkModel;
      const sdkEnv = {
        ...getEnhancedEnv({
          environment: { runtime: 'agent', workspaceId: opts.projectId },
        }),
        ...(invocation.envOverride ?? {}),
        // AI Credits gateway proxy env wins over native provider auth for this
        // session when fallback routing is active (CAN-838).
        ...(aiCreditsRouting?.env ?? {}),
        ...(accountProxyRoute?.env ?? {}),
        [brandEnvName('RTK_BINARY_PATH')]: rtkBinaryPath,
        ...getRtkManagedEnv(),
        ...(invocation.providerType === 'claude'
          ? { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }
          : {}),
      };

      const approvalMode = getApprovalMode();
      approvalSession = createApprovalSession({
        sessionKey: key,
        getTurnUserMessageId: () => getForegroundTurn()?.userMessageId,
        projectId: opts.projectId,
        worktreeId: opts.worktreeId,
        chatId: opts.chatId,
        provider: invocation.providerType,
        workspaceRoot: opts.cwd,
        mode: approvalMode,
        sessionRules: opts.sessionApprovalRules ?? [],
        getWindow,
        onAwaitingUser: () => ownedKey.markTurnAwaitingUser(),
      });
      setApprovalSessionRef(approvalSession);
      // `approvalSession` is declared with `let` outside the `try` block (so
      // the `finally` block below can dispose it), which means TypeScript
      // cannot narrow it to non-`undefined` inside the `canUseTool` closure
      // created further down. Capture it in a `const` here instead.
      const approvalSessionHandle = approvalSession;

      // Claude can enforce one invocation through both `canUseTool` and the
      // authoritative PreToolUse hook. Newer CLI builds call both seams for
      // the same tool-use id; treating them as separate checks makes an
      // "Allow once" decision prompt twice. Share the first result while
      // failing closed if the host ever reuses an id for different input.
      const approvalResultsByToolUseId = new Map<
        string,
        {
          toolName: string;
          input: Record<string, unknown>;
          result: Promise<PermissionResult>;
        }
      >();

      const authorizeClaudeTool = async (
        toolName: string,
        input: Record<string, unknown>,
        authorizationOptions: {
          title?: string;
          toolUseID?: string;
          agentID?: string;
          signal?: AbortSignal;
        },
      ): Promise<PermissionResult> => {
        // Native Plan mode may still call this fallback after the hook. Honor
        // Full Access before parsing policy requirements, as the hook does.
        if (
          getApprovalMode() === 'full-access' &&
          !authorizationOptions.signal?.aborted
        ) {
          return { behavior: 'allow' };
        }
        if (
          opts.assistantMode === 'app-advisor' &&
          opts.appAdvisorRuntime &&
          toolName === APP_ADVISOR_TOOL_REGISTRY.watch_command.claudeToolName
        ) {
          // The App Advisor runtime resolves the selected worktree and performs
          // the command approval there. A provider-level MCP approval here is
          // both less specific and would prompt a second time.
          return { behavior: 'allow' };
        }
        const approval = approvalCheckForClaudeTool(toolName, input, opts.cwd);
        if (approval.failClosedReason) {
          return {
            behavior: 'deny',
            message: approval.failClosedReason,
          };
        }
        const invalidateOnAbort = (): void => {
          approvalSessionHandle.invalidatePending?.();
        };
        const { signal } = authorizationOptions;
        if (signal?.aborted) {
          invalidateOnAbort();
          return {
            behavior: 'deny',
            message: APPROVAL_CANCELLED_MESSAGE,
          };
        }
        signal?.addEventListener('abort', invalidateOnAbort, { once: true });
        try {
          const requirements = [
            approval,
            ...(approval.additionalRequirements ?? []),
          ];
          for (const requirement of requirements) {
            const outcome = await approvalSessionHandle.check(
              requirement.check,
              {
                title: requirement.titleTool
                  ? `${invocation.providerType === 'claude' ? 'Claude' : 'Agent'} wants to use ${requirement.titleTool}`
                  : (authorizationOptions.title ??
                    `${invocation.providerType === 'claude' ? 'Claude' : 'Agent'} wants to use ${toolName}`),
                details: requirement.details,
                ...(requirement.check.kind === 'command' &&
                typeof input.maxAttempts === 'number' &&
                typeof input.intervalSeconds === 'number'
                  ? {
                      description: `Repeated command in ${opts.cwd}: up to ${input.maxAttempts} attempts, ${input.intervalSeconds} seconds between attempts, 60-second timeout each.`,
                    }
                  : {}),
                suggestedTarget: requirement.suggestedTarget,
                ...(authorizationOptions.toolUseID
                  ? { toolUseId: authorizationOptions.toolUseID }
                  : {}),
                ...(authorizationOptions.agentID
                  ? { subagentId: authorizationOptions.agentID }
                  : {}),
              },
            );
            if (signal?.aborted) {
              return {
                behavior: 'deny',
                message: APPROVAL_CANCELLED_MESSAGE,
              };
            }
            if (outcome.decision !== 'allow') {
              return {
                behavior: 'deny',
                message: outcome.message?.trim()
                  ? outcome.message
                  : POLICY_DENIED_FALLBACK_MESSAGE,
                ...(outcome.stopTurn ? { interrupt: true } : {}),
              };
            }
          }
          return { behavior: 'allow' };
        } catch {
          return {
            behavior: 'deny',
            message: APPROVAL_CHECK_FAILED_MESSAGE,
          };
        } finally {
          signal?.removeEventListener('abort', invalidateOnAbort);
        }
      };

      const authorizeClaudeToolOnce = (
        toolName: string,
        input: Record<string, unknown>,
        authorizationOptions: {
          title?: string;
          toolUseID?: string;
          agentID?: string;
          signal?: AbortSignal;
        },
      ): Promise<PermissionResult> => {
        const toolUseID = authorizationOptions.toolUseID;
        if (!toolUseID) {
          return authorizeClaudeTool(toolName, input, authorizationOptions);
        }
        const existing = approvalResultsByToolUseId.get(toolUseID);
        if (existing) {
          if (
            existing.toolName !== toolName ||
            !isDeepStrictEqual(existing.input, input)
          ) {
            return Promise.resolve({
              behavior: 'deny',
              message:
                'Conflicting tool input reused an approval identity; denied by default.',
            });
          }
          return existing.result;
        }
        const result = authorizeClaudeTool(
          toolName,
          input,
          authorizationOptions,
        );
        approvalResultsByToolUseId.set(toolUseID, {
          toolName,
          input,
          result,
        });
        return result;
      };

      const canUseTool: CanUseTool = async (
        toolName,
        input,
        canUseToolOptions,
      ): Promise<PermissionResult> => {
        if (toolName !== 'ExitPlanMode') {
          return authorizeClaudeToolOnce(toolName, input, {
            title: canUseToolOptions.title,
            toolUseID: canUseToolOptions.toolUseID,
            agentID: canUseToolOptions.agentID,
            signal: canUseToolOptions.signal,
          });
        }
        let trackedPlan: TrackedPlanData | null = null;
        if (!isCoworkWorkspace(opts.projectId)) {
          try {
            trackedPlan = await upsertTrackedPlan(
              key,
              opts.projectId,
              opts.worktreeId,
              opts.chatId,
              invocation.providerType,
              input,
            );
          } catch {
            // Non-fatal: still fire plan:exit-request without planId
          }
        }
        const win = getWindow();
        const pendingInstruction = trackedPlan
          ? await buildPlanFileSystemInstruction({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              planId: trackedPlan.id,
            }).catch(() => null)
          : null;
        const planExitEvent: PlanExitRequestEvent = {
          requestId: randomUUID(),
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          source: invocation.providerType,
          reviewMode: 'manual',
          toolInput: input,
          ...(trackedPlan
            ? {
                planId: trackedPlan.id,
                revisionNumber: trackedPlan.latestRevisionNumber,
              }
            : {}),
          ...(pendingInstruction
            ? { pendingSystemInstructions: [pendingInstruction] }
            : {}),
        };
        await commitPendingPlanExit(planExitEvent);
        if (win && !win.isDestroyed()) {
          void sendToWindow(win, IPC_CHANNELS.planExitRequest, planExitEvent);
        }
        // A plan awaiting review is blocked on a human exactly like an approval
        // prompt, and is one of the signals that previously never left the
        // desktop. Cleared when the chat's next turn starts (the user approved,
        // rejected, or kept iterating).
        getAttentionTracker().mark({
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          state: 'needs_input',
          reason: 'plan_review',
          sourceId: 'plan-review',
        });

        planHandoff = { turn: getForegroundTurn() };
        return {
          behavior: 'deny' as const,
          message:
            'Plan shared with the user for review. Stay in plan mode and await their next message.',
          interrupt: true,
        };
      };

      const approvalPreToolUseHook = async (
        input: HookInput,
        toolUseID: string | undefined,
        hookOptions: { signal: AbortSignal },
      ): Promise<HookJSONOutput> => {
        if (
          input.hook_event_name !== 'PreToolUse' ||
          input.tool_name === 'ExitPlanMode'
        ) {
          return { continue: true };
        }
        // A main-thread tool call proves a root turn is running even when the
        // query loop has not read its init yet. Start it before the per-turn
        // skill and Code Graph state below is read.
        if (input.agent_id === undefined) ensureRunningTurnForToolCall();
        if (input.tool_name === 'Skill') {
          const turn = skillUsage.claimToolCall(
            toolUseID ?? input.tool_use_id,
            Boolean(input.agent_id),
          );
          if (
            turn &&
            isRecord(input.tool_input) &&
            typeof input.tool_input.skill === 'string'
          ) {
            const inventory = await loadCachedInventory().catch(() => null);
            const token = input.tool_input.skill;
            skillUsage.observeInvocation(
              turn,
              /^[/$]/.test(token) ? token : `/${token}`,
              inventory?.entries.filter(
                (entry) => entry.provider === invocationProvider,
              ) ?? [],
            );
          }
        }
        if (!isRecord(input.tool_input)) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                'Malformed tool input; denied by default.',
            },
          };
        }
        if (
          (input.tool_name === 'Read' ||
            input.tool_name === 'Grep' ||
            input.tool_name === 'Glob' ||
            input.tool_name === 'Bash') &&
          codeGraphAvailableThisTurn &&
          codeGraphCustomSourceExtensionsThisTurn === undefined
        ) {
          codeGraphCustomSourceExtensionsThisTurn =
            await loadConfiguredClaudeCodeGraphSourceExtensions({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
            });
        }
        const graphScope = {
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          cwd: opts.cwd,
          turn: codeGraphOrientationTurn,
        };
        const graphCallId = toolUseID ?? input.tool_use_id;
        // Also before a first build, which must orient later turns.
        if (graphCallId && isClaudeCodeGraphToolName(input.tool_name)) {
          await beginClaudeCodeGraphToolCall(
            graphScope,
            graphCallId,
            input.tool_name,
          );
        }
        const steeringContext = buildClaudeCodeGraphPreToolUseContext({
          toolName: input.tool_name,
          toolInput: input.tool_input,
          cwd: opts.cwd,
          graphAvailable: codeGraphAvailableThisTurn,
          customSourceExtensions: codeGraphCustomSourceExtensionsThisTurn,
        });
        const additionalContext =
          steeringContext &&
          !(await isClaudeCodeGraphOrientationCurrent(graphScope))
            ? steeringContext
            : undefined;
        const advisoryContext =
          additionalContext && codeGraphOrientationBlockedThisTurn
            ? additionalContext
            : undefined;
        if (additionalContext && !advisoryContext) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: additionalContext,
              additionalContext,
            },
          };
        }
        // Plan mode's explicit bookkeeping exception: Ledger calls follow the
        // ordinary approval policy, never a Plan mode denial, and carry a
        // reminder that they grant no edits or execution.
        const bookkeepingContext =
          isPlanModeEnabled() &&
          isClaudePlanModeBookkeepingTool(input.tool_name)
            ? CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT
            : undefined;
        if (getApprovalMode() === 'full-access') {
          if (isPlanModeEnabled()) {
            // Keep the native planning workflow without letting its permission
            // classifier override the user's Full Access policy.
            const planContext = advisoryContext ?? bookkeepingContext;
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                ...(planContext ? { additionalContext: planContext } : {}),
              },
            };
          }
          if (advisoryContext) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext: advisoryContext,
              },
            };
          }
          return { continue: true };
        }
        const result = await authorizeClaudeToolOnce(
          input.tool_name,
          input.tool_input,
          {
            toolUseID: toolUseID ?? input.tool_use_id,
            agentID: input.agent_id,
            signal: hookOptions.signal,
          },
        );
        const permissionDecisionReason =
          result.behavior === 'deny'
            ? result.message
            : 'Approved by the application approval policy.';
        if (
          result.behavior === 'deny' &&
          isClaudeCodeGraphToolName(input.tool_name)
        ) {
          codeGraphOrientationBlockedThisTurn = true;
        }
        const modelContext =
          advisoryContext ??
          (result.behavior === 'allow' ? bookkeepingContext : undefined);
        const hookSpecificOutput = {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: result.behavior,
          permissionDecisionReason,
          ...(modelContext ? { additionalContext: modelContext } : {}),
        };
        if (result.behavior === 'deny' && result.interrupt === true) {
          return {
            continue: false,
            stopReason:
              permissionDecisionReason ?? 'Tool call denied and turn stopped.',
            hookSpecificOutput,
          };
        }
        return { hookSpecificOutput };
      };

      const codeGraphPostToolUseHook = async (
        input: HookInput,
        toolUseId: string | undefined,
      ): Promise<HookJSONOutput> => {
        const toolName = 'tool_name' in input ? input.tool_name : undefined;
        if (isClaudeCodeGraphPostToolUse(input.hook_event_name, toolName)) {
          const answer = readClaudeCodeGraphToolAnswer(
            'tool_response' in input ? input.tool_response : undefined,
          );
          if (!answer.failed) {
            codeGraphOrientationBlockedThisTurn = false;
            await recordClaudeCodeGraphOrientation(
              {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                cwd: opts.cwd,
                turn: codeGraphOrientationTurn,
              },
              {
                toolUseId:
                  toolUseId ??
                  ('tool_use_id' in input ? input.tool_use_id : undefined),
                rebuildsGraph:
                  toolName !== undefined &&
                  isClaudeCodeGraphBuildToolName(toolName),
                answeredBuildAt: answer.lastBuildAt,
              },
            );
          }
        }
        return { continue: true };
      };

      const codeGraphSubagentStartHook = (
        input: HookInput,
      ): Promise<HookJSONOutput> => {
        if (
          input.hook_event_name !== 'SubagentStart' ||
          !codeGraphAvailableThisTurn
        ) {
          return Promise.resolve({ continue: true });
        }
        return Promise.resolve({
          hookSpecificOutput: {
            hookEventName: 'SubagentStart',
            additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
          },
        });
      };

      // Session crons fire turns from inside the CLI process; the idle release
      // keeps a session that has any.
      const sessionCronHook = (input: HookInput): Promise<HookJSONOutput> => {
        recordClaudeSessionCronHookInput(key, input);
        return Promise.resolve({ continue: true });
      };

      const rtkHooks = buildRtkClaudeHooks({
        rtkBinaryPath,
        env: sdkEnv,
        isEnabled: isRtkEnabled,
      });

      // The Ledger block rides with this session's prompt only while its
      // Ledger tools are exposed.
      const systemPromptAppend = [
        opts.systemPromptAppend,
        managedDelegation?.systemPromptGuidance,
        ledger.tools?.systemPrompt(),
      ]
        .filter(Boolean)
        .join('\n\n');

      // Merge approval fallback and thinking settings (Ultra sets
      // `ultracode`) before applying native-memory suppression so none
      // of the independently owned settings overwrite another.
      const nativeMemoryOptions = claudeNativeMemoryOptions(
        localMemoryEnabled,
        {
          ...thinkingOptions.settings,
          // Claude applies settings-file env after its launch environment.
          // Pin the selected proxy at the flag tier so ambient provider
          // defaults cannot replace its broker URL or authentication.
          ...(accountProxyRoute ? { env: accountProxyRoute.env } : {}),
          ...(approvalMode !== 'full-access'
            ? { permissions: { ask: ['*'] } }
            : {}),
          // Claude Code 2.1.310+ gives Plan mode auto-mode semantics by
          // default, where its classifier decides and hooks cannot approve.
          // The session's approval mode stays authoritative while planning.
          useAutoModeDuringPlan: false,
        },
      );
      const admittedSdkSettings = claudeModAdmission?.settings
        ? mergeClaudeModAdmissionSettings(
            nativeMemoryOptions.settings ?? {},
            claudeModAdmission.settings,
          )
        : undefined;

      const buildSdkOptions = (): QueryOptions => ({
        ...(claudeMaxTurns === null ? {} : { maxTurns: claudeMaxTurns }),
        cwd: opts.cwd,
        abortController,
        pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
        spawnClaudeCodeProcess: (options): SpawnedProcess => {
          // Snapshot this launch's records now; record them once it starts.
          const skippedNotice = buildClaudeModsSkippedEvent(key);
          return spawnHostedProcess(
            options,
            skippedNotice
              ? (): void => {
                  try {
                    void Promise.resolve(emitEvent(skippedNotice)).catch(
                      (): void => {
                        logMainProcessWarn(
                          '[claude-session] Failed to emit skipped Claude Mods notice',
                        );
                      },
                    );
                  } catch {
                    logMainProcessWarn(
                      '[claude-session] Failed to emit skipped Claude Mods notice',
                    );
                  }
                }
              : undefined,
          );
        },
        env: sdkEnv,
        ...(invocation.providerType === 'claude'
          ? { perTaskStopAffordance: true }
          : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(systemPromptAppend ? { append: systemPromptAppend } : {}),
        },
        // The authoritative PreToolUse hook evaluates governed tools before
        // native permission classification, so project instructions can remain
        // available without letting repository allowlists bypass Canopy policy.
        settingSources: ['user', 'project', 'local'],
        // Keep the native permission callback as an independent enforcement
        // path if repository settings disable hooks. Policy-tier `ask` rules
        // outrank repository allowlists while still letting `canUseTool` return
        // the Canopy decision without showing a second prompt; full access uses
        // a non-matching managed deny to keep Claude's plugin guard ahead of
        // user-installed Mod approval.
        ...(approvalMode !== 'full-access'
          ? {
              managedSettings: {
                permissions: { ask: ['*'] },
              },
              // An administrator-managed tier may deliberately drop parent
              // managed settings. Keep the native guard in the highest-
              // priority user-controlled tier as a fallback against repository
              // allowlists; administrator policy remains authoritative.
            }
          : { managedSettings: claudeManagedSettingsGuard() }),
        ...thinkingOptions,
        ...nativeMemoryOptions,
        ...(claudeModAdmission && admittedSdkSettings
          ? { settings: admittedSdkSettings }
          : {}),
        ...(routedSdkModel ? { model: routedSdkModel } : {}),
        ...(opts.sdkSessionId && !forkResumePointRejected
          ? { resume: opts.sdkSessionId }
          : {}),
        ...(opts.sdkSessionId &&
        opts.claudeForkSession &&
        !forkResumePointRejected
          ? { forkSession: true }
          : {}),
        // Point-in-time fork: resume only the chain entries the forked
        // transcript kept. Meaningless without `resume` + `forkSession`, and
        // the CLI hard-errors on an id it cannot find on the main chain, so
        // it is only ever sent alongside both.
        ...(opts.sdkSessionId &&
        opts.claudeForkSession &&
        isClaudeChainUuid(opts.claudeForkResumeAt) &&
        !forkResumePointRejected
          ? { resumeSessionAt: opts.claudeForkResumeAt }
          : {}),
        ...(sdkPlugins.length > 0 ? { plugins: sdkPlugins } : {}),
        permissionMode: claudePermissionModeFor(
          approvalMode,
          isPlanModeEnabled(),
        ),
        ...(approvalMode === 'full-access'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        sandbox: {
          ripgrep: {
            command: getBundledRgBinaryPath(),
          },
        },
        hooks: {
          ...rtkHooks,
          PreToolUse: [
            ...(rtkHooks.PreToolUse ?? []),
            { matcher: '*', hooks: [approvalPreToolUseHook] },
            { matcher: 'CronCreate|ScheduleWakeup', hooks: [sessionCronHook] },
            ...(managedDelegation
              ? [
                  {
                    matcher: '*',
                    hooks: [
                      (
                        input: HookInput,
                        toolUseId: string | undefined,
                      ): Promise<HookJSONOutput> => {
                        if (input.hook_event_name !== 'PreToolUse')
                          return Promise.resolve({ continue: true });
                        if (
                          [
                            'Agent',
                            'Task',
                            'TaskOutput',
                            'TaskStop',
                            'SendMessage',
                            'TeamCreate',
                            'TeamDelete',
                          ].includes(input.tool_name)
                        )
                          return Promise.resolve({
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse',
                              permissionDecision: 'deny',
                              permissionDecisionReason:
                                'Native delegation is unavailable in this managed parent session.',
                            },
                          });
                        if (
                          !isWatchDelegatesCompatibilityName(
                            input.tool_name,
                            'claude',
                          ) &&
                          !managedDelegation.ownsTool(input.tool_name)
                        )
                          return Promise.resolve({ continue: true });
                        if (input.agent_id === undefined)
                          ensureRunningTurnForToolCall();
                        const bound = managedDelegation.parent.bindClaude(
                          managedDelegation.bareClaudeName(input.tool_name),
                          input.tool_input,
                          toolUseId ?? input.tool_use_id,
                          input.agent_id,
                        );
                        const approvalIdentity = toolUseId ?? input.tool_use_id;
                        const approved =
                          approvalResultsByToolUseId.get(approvalIdentity);
                        // Only this host-minted binding may extend already checked
                        // arguments. Do not strip arbitrary correlation fields in
                        // canUseTool: changed model arguments must still fail closed.
                        if (
                          bound.ok &&
                          approved &&
                          approved.toolName === input.tool_name &&
                          isDeepStrictEqual(approved.input, input.tool_input)
                        ) {
                          const clonedBoundValue: unknown = JSON.parse(
                            JSON.stringify(bound.value),
                          );
                          if (!isRecord(clonedBoundValue))
                            return Promise.resolve({
                              hookSpecificOutput: {
                                hookEventName: 'PreToolUse',
                                permissionDecision: 'deny',
                                permissionDecisionReason:
                                  'Managed tool input could not be retained safely.',
                              },
                            });
                          approvalResultsByToolUseId.set(approvalIdentity, {
                            ...approved,
                            input: clonedBoundValue,
                          });
                        }
                        return Promise.resolve(
                          bound.ok
                            ? {
                                hookSpecificOutput: {
                                  hookEventName: 'PreToolUse',
                                  updatedInput: bound.value,
                                },
                              }
                            : {
                                hookSpecificOutput: {
                                  hookEventName: 'PreToolUse',
                                  permissionDecision: 'deny',
                                  permissionDecisionReason: bound.error.message,
                                },
                              },
                        );
                      },
                    ],
                  },
                ]
              : []),
          ],
          PostToolUse: [
            {
              matcher: '*',
              hooks: [
                codeGraphPostToolUseHook,
                ...(managedDelegation
                  ? [
                      (
                        input: HookInput,
                        toolUseId: string | undefined,
                      ): Promise<HookJSONOutput> => {
                        if (
                          input.hook_event_name === 'PostToolUse' &&
                          !input.agent_id &&
                          managedDelegation.ownsTool(input.tool_name)
                        ) {
                          const callId = toolUseId ?? input.tool_use_id;
                          managedDelegation.parent.acknowledgeTool(
                            callId,
                            `claude:${input.session_id}:${callId}`,
                          );
                        }
                        return Promise.resolve({ continue: true });
                      },
                    ]
                  : []),
              ],
            },
            { matcher: 'CronCreate|CronDelete', hooks: [sessionCronHook] },
          ],
          SubagentStart: [
            { matcher: '*', hooks: [codeGraphSubagentStartHook] },
          ],
          Stop: [{ hooks: [sessionCronHook] }],
        },
        // Replace app-owned tools and disable native subagents for managed parents.
        disallowedTools: [
          'AskUserQuestion',
          'ScheduleWakeup',
          ...(managedDelegation
            ? [
                'Agent',
                'Task',
                'TaskOutput',
                'TaskStop',
                'SendMessage',
                'TeamCreate',
                'TeamDelete',
              ]
            : []),
        ],
        mcpServers: { ...resolvedMcpServers, ...canopyMcpServers },
        canUseTool,
      });

      // Bounded one-shot recovery for a point-in-time fork whose anchor the
      // CLI cannot find on the source chain (a compacted or replaced session
      // file). That refusal is a hard error — the CLI emits an
      // `error_during_execution` result carrying the reason in `errors` and
      // the SDK iterator then throws — so without this the whole turn fails.
      // We swallow that one result, retry once with genuinely fresh model
      // context, and record the fallback in session diagnostics. Never a
      // second retry: the refusal is deterministic.
      let forkResumeRetryPending = false;
      const canRetryWithoutForkResumePoint = (): boolean =>
        forkResumePointRequested &&
        !forkResumePointRejected &&
        !forkResumePointAccepted;
      const observabilityQueryId = `chat:${key}`;
      const createSdkQuery = (
        prompt: Parameters<typeof claudeQuery>[0]['prompt'],
      ): Query => {
        const queryOptions = buildSdkOptions();
        const resumeSessionId = queryOptions.resume;
        if (invocationProvider === 'claude') {
          getExecutionObservabilityIngest().beginClaudeQuery(
            observabilityQueryId,
            typeof resumeSessionId === 'string' && resumeSessionId.trim()
              ? {
                  sessionId: resumeSessionId,
                  fork: queryOptions.forkSession === true,
                }
              : undefined,
          );
        }
        try {
          return claudeQuery({ prompt, options: queryOptions });
        } catch (error) {
          if (invocationProvider === 'claude') {
            getExecutionObservabilityIngest().endClaudeQuery(
              observabilityQueryId,
            );
          }
          throw error;
        }
      };
      const startAttempt = (): Query => {
        const prompt = nextPromptAttempt();
        const attempt = __CANOPY_E2E__
          ? createE2eClaudeQueryWithPrelude({
              scope: {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
              },
              prompt,
              createQuery: createSdkQuery,
            })
          : createSdkQuery(prompt);
        setQueryRef(attempt);
        // Every attempt starts a fresh CLI process, which owns no background
        // tasks yet. The SDK emits no `background_tasks_changed` at startup,
        // and `system`/`init` arrives every turn, so this process boundary is
        // the authoritative point at which to clear the prior live set.
        if (ownsSession()) {
          if (ownedKey.ownsKeyResources()) resetSessionLiveBackgroundTasks(key);
          ownedKey.recordSessionEvent({
            type: 'phase',
            phase: 'claude.query_started',
          });
        }
        return attempt;
      };

      let queryResult = startAttempt();
      for (;;) {
        try {
          const attempt = queryResult;
          const iterator = attempt[Symbol.asyncIterator]();
          const queue: Array<{
            data: Record<string, unknown>;
            receipt: ClaudeEventReceipt;
            receivedAt: number;
          }> = [];
          const waiters = new Set<() => void>();
          const wake = (): void => {
            waiters.forEach((resolve) => resolve());
            waiters.clear();
          };
          const waitForChange = (): Promise<void> =>
            new Promise((resolve) => {
              waiters.add(resolve);
            });
          let readerStopped = false;
          let readerFinished = false;
          let iteratorCompleted = false;
          let readerFailure: { error: unknown } | undefined;
          let saturated = false;
          const stopReader = (): void => {
            readerStopped = true;
            wake();
          };
          const onAbort = (): void => {
            fenceSteeringForTerminal({ type: 'error' });
            stopReader();
          };
          abortController.signal.addEventListener('abort', onAbort, {
            once: true,
          });
          const reader = (async (): Promise<void> => {
            try {
              while (!readerStopped) {
                while (
                  queue.length >= CLAUDE_RECEIPT_QUEUE_LIMIT &&
                  !readerStopped
                ) {
                  if (!saturated) {
                    saturated = true;
                    getExecutionObservabilityIngest().recordSessionDiagnostic({
                      version: 1,
                      timestamp: new Date().toISOString(),
                      kind: 'claude_event_receipt_backlog',
                      sessionKey: key,
                      projectId: opts.projectId,
                      worktreeId: opts.worktreeId,
                      chatId: opts.chatId,
                      providerType: 'claude',
                      claudeReceiptQueueDepth: queue.length,
                      claudeReceiptOldestWaitMs: Math.max(
                        0,
                        Date.now() - queue[0].receivedAt,
                      ),
                    });
                  }
                  await waitForChange();
                }
                if (readerStopped) break;
                const next = await iterator.next();
                if (next.done) {
                  iteratorCompleted = true;
                  if (!forkResumeRetryPending)
                    fenceSteeringForTerminal({ type: 'error' });
                  break;
                }
                if (abortController.signal.aborted) stopReader();
                if (readerStopped) break;
                const data: unknown = structuredClone(next.value);
                if (!isRecord(data)) continue;
                if (
                  (opts.claudeForkStartsFresh || forkResumePointRejected) &&
                  data.type === 'system' &&
                  data.subtype === 'init'
                )
                  data.canopy_fork_model_context = 'fresh';
                if (
                  canRetryWithoutForkResumePoint() &&
                  isClaudeForkResumePointRejection(data)
                ) {
                  forkResumeRetryPending = true;
                  continue;
                }
                if (forkResumePointRequested && !forkResumePointRejected) {
                  forkResumePointAccepted = true;
                  bufferedPrompts.length = 0;
                }
                if (
                  isClaudeRootTerminalEvent(data) ||
                  isClaudeRootErrorEvent(data)
                ) {
                  // The SDK reports the interrupt that hands a plan to review
                  // as an aborted tool call; mark it before its receipt ends
                  // the turn, so the turn settles as done.
                  if (
                    data.type === 'result' &&
                    data.terminal_reason === 'aborted_tools' &&
                    planHandoff !== undefined &&
                    planHandoff.turn === getForegroundTurn()
                  ) {
                    data.canopy_plan_handoff = true;
                  }
                  planHandoff = undefined;
                }
                queue.push({
                  data,
                  receipt: receiveEvent(data),
                  receivedAt: Date.now(),
                });
                wake();
              }
            } catch (error: unknown) {
              readerFailure = { error };
              if (
                !(
                  canRetryWithoutForkResumePoint() &&
                  (forkResumeRetryPending ||
                    isClaudeForkResumePointRejection(error))
                )
              )
                fenceSteeringForTerminal({ type: 'error' });
            } finally {
              readerFinished = true;
              wake();
            }
          })().catch((error: unknown): void => {
            readerFailure = { error };
          });
          try {
            for (;;) {
              while (queue.length === 0 && !readerFinished)
                await waitForChange();
              const item = queue.shift();
              if (!item) break;
              if (queue.length === 0) saturated = false;
              wake();
              const { data, receipt } = item;
              const rejectionStatus =
                modelGatewayCredentialRejectionStatus(data);
              if (orgGatewayOrganizationId && rejectionStatus) {
                await markOrgGatewayCredentialRejected(
                  orgGatewayOrganizationId,
                  rejectionStatus,
                  orgGatewayCredentialVersion,
                );
              }
              if (isClaudeTaskNotificationPreludeResult(data)) {
                // Resumed task notifications are side channels, not root terminals.
                if (receipt.hasForegroundTurn) {
                  data.canopy_session_continues = true;
                  const admission = emitEvent(data, undefined, receipt);
                  if (admission) await admission;
                } else {
                  recordChatEventDropped({
                    projectId: opts.projectId,
                    worktreeId: opts.worktreeId,
                    chatId: opts.chatId,
                    providerType: 'claude',
                    gate: 'claude_prelude_without_turn',
                    reason: 'no_foreground_turn',
                    data,
                  });
                }
                continue;
              }
              const foregroundTurn = getForegroundTurn();
              if (
                invocationProvider === 'claude' &&
                data.type === 'assistant' &&
                (!('parent_tool_use_id' in data) ||
                  data.parent_tool_use_id == null) &&
                foregroundTurn &&
                isRecord(data.message) &&
                isRecord(data.message.usage)
              ) {
                const endTokens = claudeContextEndTokens(data.message.usage);
                if (endTokens !== undefined) {
                  lastRootAssistantContext = {
                    turn: foregroundTurn,
                    endTokens,
                  };
                }
              }
              if (
                invocationProvider === 'claude' &&
                data.type === 'result' &&
                foregroundTurn
              ) {
                const endTokens =
                  lastRootAssistantContext?.turn === foregroundTurn
                    ? lastRootAssistantContext.endTokens
                    : undefined;
                captureClaudeContextSnapshot({
                  summary: getContextUsageForClaudeSession(
                    opts.projectId,
                    opts.worktreeId,
                    opts.chatId,
                  ),
                  includeCategories: true,
                  ...(endTokens === undefined ? {} : { endTokens }),
                  ...(foregroundTurn.userMessageId
                    ? { userMessageId: foregroundTurn.userMessageId }
                    : {}),
                  onSnapshot: (snapshot): void => {
                    getExecutionObservabilityIngest().observeChatEvent(
                      opts.projectId,
                      opts.worktreeId,
                      opts.chatId,
                      snapshot,
                    );
                  },
                });
                lastRootAssistantContext = undefined;
              }
              const isTerminal =
                isClaudeRootTerminalEvent(data) || isClaudeRootErrorEvent(data);
              if (isTerminal) {
                terminalEmitted = true;
                terminalTurn = receipt.eventTurn;
                markReceiptTurnIdle(receipt);
              }
              const admission = emitEvent(data, undefined, receipt);
              if (admission) await admission;
              if (isTerminal) clearActiveTurn(receipt);
            }
            // SDK exit follows every event the reader already received.
            if (readerFailure) throw readerFailure.error;
            if (
              readerStopped &&
              abortController.signal.aborted &&
              !iteratorCompleted
            )
              throw new Error('Operation aborted');
          } finally {
            stopReader();
            abortController.signal.removeEventListener('abort', onAbort);
            try {
              if (!iteratorCompleted) attempt.close?.();
            } finally {
              await reader;
              if (!iteratorCompleted) await iterator.return?.();
            }
          }
        } catch (error: unknown) {
          if (
            !canRetryWithoutForkResumePoint() ||
            !(forkResumeRetryPending || isClaudeForkResumePointRejection(error))
          ) {
            throw error;
          }
          forkResumeRetryPending = true;
        } finally {
          if (invocationProvider === 'claude') {
            getExecutionObservabilityIngest().endClaudeQuery(
              observabilityQueryId,
            );
          }
        }
        // A cancelled turn is not recovered: the outer catch owns the abort
        // shape, and a retry would only race the teardown it is part of.
        if (
          !(canRetryWithoutForkResumePoint() && forkResumeRetryPending) ||
          abortController.signal.aborted
        ) {
          break;
        }
        forkResumePointRejected = true;
        forkResumeRetryPending = false;
        terminalEmitted = false;
        terminalTurn = undefined;
        ownedKey.recordSessionEvent({
          type: 'phase',
          phase: 'claude.fork_resume_point_rejected',
        });
        getExecutionObservabilityIngest().recordSessionDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'claude_fork_resume_point_rejected',
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          providerType: 'claude',
          recoveryStrategy: 'restarted',
        });
        replayBufferedPrompts = true;
        queryResult = startAttempt();
      }
    } catch (error: unknown) {
      if (!ownsSession()) return;
      terminalEmitted = true;
      terminalTurn = getForegroundTurn();
      fenceSteeringForTerminal({ type: 'error' });
      if (ownsSession()) ownedKey.markTurnIdle();
      // The SDK surfaces a user-initiated abort in more than one shape: a
      // DOMException-style AbortError, or a plain Error('Operation aborted')
      // thrown by the transport when a write lands after abort() (its abort
      // error class extends Error without overriding `name`, so a `name`
      // check alone misses it). Treat any error raised while our own abort
      // signal is set as a clean cancellation, emitting a result so the
      // renderer closes the turn timer, resets status, and flushes queued
      // messages instead of surfacing a spurious error.
      if (
        abortController.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        // Replacing or unloading an idle session must not emit an uncorrelated
        // terminal event into the chat. The renderer may already have opened
        // the replacement turn's optimistic timer, and an idle teardown has no
        // active user-message id with which to distinguish its result from that
        // newer turn. Active-turn destroys still emit the normal correlated
        // cancellation so their timer closes.
        if (shouldEmitTerminalEvent()) {
          const terminalAdmission = emitEvent(
            {
              type: 'result',
              is_error: false,
              result: 'Session aborted',
            },
            { kind: 'no-live-session' },
          );
          if (terminalAdmission) await terminalAdmission;
        }
        clearActiveTurn();
        return;
      }
      const errorCode = getProviderErrorCode(error);
      const rejectionStatus = modelGatewayCredentialRejectionStatus(error);
      if (orgGatewayOrganizationId && rejectionStatus) {
        await markOrgGatewayCredentialRejected(
          orgGatewayOrganizationId,
          rejectionStatus,
          orgGatewayCredentialVersion,
        );
      }
      // An iterator rejection is also a settled root failure. Preserve quota
      // recovery without admitting child errors or advance limit notices.
      if (terminalTurn) {
        const interruption = buildAccountProxyUsageLimitedEntry(
          {
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            provider: 'claude',
            detectedAt: Date.now(),
            accountProxyConnectionId,
          },
          error,
        );
        if (interruption) await recordUsageLimitedChat(interruption);
      }
      const errorAdmission = emitEvent(
        {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          ...(errorCode === OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE
            ? {
                error_code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
                provider: 'ollama',
              }
            : {}),
        },
        { kind: 'no-live-session' },
      );
      if (errorAdmission) await errorAdmission;
      clearActiveTurn();
    } finally {
      stopAccountProxySwitches?.();
      try {
        // The query loop is gone; the chat's delegations outlive it.
        detachManagedDelegation();
      } finally {
        // Current foreground ownership is the completion authority. A terminal
        // clears that ownership immediately; if a later queued turn is still
        // pending when this reused SDK query exits, it remains owned and needs
        // its own correlated safety-net terminal regardless of what an earlier
        // turn emitted.
        const unfinishedTurn = getForegroundTurn();
        if (
          ownsSession() &&
          shouldEmitTerminalEvent() &&
          (!terminalEmitted ||
            (unfinishedTurn !== undefined && unfinishedTurn !== terminalTurn))
        ) {
          ownedKey.markTurnIdle();
          try {
            const terminalAdmission = emitEvent(
              {
                type: 'result',
                is_error: false,
                result: 'Session ended',
              },
              { kind: 'no-live-session' },
            );
            if (terminalAdmission) await terminalAdmission;
          } catch (error) {
            logMainProcessError(
              `Failed to route Claude terminal event for ${opts.projectId}/${opts.worktreeId}/${opts.chatId}`,
              error,
            );
          }
        }
        clearActiveTurn();
        approvalSession?.dispose();
        clearClaudeModAdmissionSessionRecords(key);
        ledger.tools?.dispose();
        ownedKey.release();
      }
    }
  }
}
import { authorizeInstalledItemUninstall } from '../installed-items/installed-item-approval';
