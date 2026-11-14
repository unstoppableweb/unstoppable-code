import { randomUUID } from 'node:crypto';
import { getRawOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import { clearPresentationTurn } from '../canopy-tools/presentation-state';
import type { BrowserWindow } from 'electron';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { ChildToolLiveness } from '@canopy/agent-transcript';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  isStricterApprovalMode,
  limitAllowRules,
  sendDenyRulesBeyond,
  sessionApprovalRulesWithin,
} from '@canopy/desktop-shared/lib/send-approval-narrowing';
import { mcpHttpAuthTargetKey } from '@canopy/execution-engine/lib/mcp-http-auth';
import type { AgentProvider, AgentSession, AgentSessionOptions } from './types';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import {
  interfaceToolsSignature,
  resolveSessionInterfaceTools,
} from './interface-tool-binding';
import {
  buildChatSessionKey,
  parseChatSessionKey as parseSessionKey,
} from './session-key';
import {
  getInheritedPluginDefaultsRevision,
  subscribePluginDefaultsRevision,
} from '../plugins/plugin-defaults-revision';
import { workerProviderRuntimeFor } from '../agent-runs/worker-provider-runtimes';
import {
  APP_ADVISOR_PROJECT_ID,
  DEFAULT_CLAUDE_SESSION_IDLE_TIMEOUT_MINUTES,
  resolveKnownModel,
  getExecutionHarnessForModel,
  getModelSource,
  type ActivityLiveBgTasksChatState,
  type AgentProviderType,
  type ApprovalMode,
  type ApprovalRule,
  type AssistantMode,
  type ChatActiveSessionInfo,
  type ChatContextUsageBreakdown,
  type ChatSendMessageRequest,
  type ChatModel,
  type ChatTabPluginSelections,
  type UsageLimitedChatEntry,
} from '@canopy/desktop-shared/types';
import type { ActivityLiveBgTask } from '@canopy/desktop-shared/types/activity-panel';
import {
  isGatewayOnlyModel,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  cleanupChatSkillPluginDir,
  cleanupWorktreeChatPluginDirs,
} from '../plugins/plugin-cleanup';
import {
  hasPendingRequestsForSession,
  rejectAllForSession,
} from '../mcp/pending-requests';
import { hasPendingApprovalsForSession } from '../approvals/pending-approvals';
import {
  flushAndStopOutputPollingForSession,
  stopAllOutputPolling,
} from '../lib/bg-output-poller';
import { emitSessionEndedBackgroundTaskNotification } from '../lib/session-ended-background-tasks';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { describeChatEventData } from '../lib/chat-event-description';
import { wakeLockHolder, wakeLockHolderKey } from '@canopy/core-runtime';
import { getWakeLockService } from '../power/wake-lock-service';
import {
  getChatTurnOwnership,
  shouldHoldChatWake,
  type ChatTurnOwnershipSnapshot,
} from '../services/chat-turn-ownership';
import {
  activeDelegationCount,
  hasLiveDelegations,
} from './delegation/activity';
import {
  closeDelegationScope,
  hasDelegationLifecycle,
  revokeDelegationLifecycle,
} from './delegation/lifecycle';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import {
  isAiCreditsChosenOverAccountProxy,
  resolveAiCreditsRoutingActivation,
} from './ai-credits-routing';
import {
  billedProviderFor,
  effectiveTabAiCreditsRouting,
} from './effective-ai-credits-routing';
// NOTE: `../auth/provider-auth-state` statically imports this module, so this is
// a cycle — but the same cycle already exists via `./ai-credits-routing`, and
// only function declarations are read across it (never at module-eval time).
import { peekProviderNativeAuthAvailability } from '../auth/provider-auth-state';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { accountProxySettingsSignature } from '../account-proxy/service';
import { previewAccountProxySessionRoute } from '../account-proxy/routing';
import {
  captureSessionWorkOwner,
  peekSessionWorkOwner,
  resolveBackgroundWorkOwner,
  resolveEnforcementOwner,
  resolveSessionWorkOwner,
} from './work-owner';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { appendUserOverallPreferencesBlock } from '@canopy/execution-engine/lib/global-instructions';
import {
  assertWorkspaceTargetRuntimeStartAllowed,
  withWorkspaceTargetRuntimeStartReservation,
} from '../lib/workspace-target-exclusion';
import { isAgentContinuationEvent } from '../lib/chat-turn-audit';
import {
  classifyProviderRunEvent,
  type ProviderRunDescriptor,
} from '../lib/provider-run-reconciliation';
import { isE2eBuild } from '../lib/e2e-gate';
import { notifySteeringEligibilityChanged } from './steering-eligibility-events';
import { setAppliedApprovalReader } from '../approvals/live-approval-modes';
import { shouldReloadForClaudeModChange } from './claude-mod-admission-session';
import { assertAgentWorkerContext } from '../agent-runs/agent-worker-context';

export { isAgentContinuationEvent } from '../lib/chat-turn-audit';

function sessionKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return buildChatSessionKey(projectId, worktreeId, chatId);
}

export {
  bumpGlobalPluginDefaultsRevision,
  getGlobalPluginDefaultsRevision,
  subscribePluginDefaultsRevision as subscribeGlobalPluginDefaultsRevision,
} from '../plugins/plugin-defaults-revision';

function pluginSelectionsSignature(
  opts: Pick<
    AgentSessionOptions,
    | 'pluginSelections'
    | 'applyGlobalPluginDefaults'
    | 'projectId'
    | 'worktreeId'
  >,
): string {
  const revisionSuffix = opts.applyGlobalPluginDefaults
    ? `@defaults:${String(getInheritedPluginDefaultsRevision(opts))}`
    : '';
  const selections = opts.pluginSelections;
  if (!selections) {
    return `null${revisionSuffix}`;
  }
  const normalized = normalizePluginSelections(selections);
  return JSON.stringify({
    collectionIds: [...normalized.collectionIds].sort(),
    skillRefs: [...normalized.skillRefs]
      .map((ref) => ({ sourceId: ref.sourceId, skillName: ref.skillName }))
      .sort(
        (a, b) =>
          a.sourceId.localeCompare(b.sourceId) ||
          a.skillName.localeCompare(b.skillName),
      ),
    pluginRefs: [...normalized.pluginRefs]
      .map((ref) => ({
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
      }))
      .sort(
        (a, b) =>
          a.marketplaceId.localeCompare(b.marketplaceId) ||
          a.pluginName.localeCompare(b.pluginName),
      ),
    mcpServerRefs: [...(normalized.mcpServerRefs ?? [])]
      .map((ref) => ({ serverId: ref.serverId, configId: ref.configId }))
      .sort(
        (a, b) =>
          a.serverId.localeCompare(b.serverId) ||
          a.configId.localeCompare(b.configId),
      ),
    mcpHttpAuthPreferences: [...(normalized.mcpHttpAuthPreferences ?? [])]
      .map((entry) => ({
        key: mcpHttpAuthTargetKey(entry.target),
        entry,
      }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ entry }) => entry),
  }).concat(revisionSuffix);
}

interface LiveBackgroundTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** Metadata Canopy retains for one live provider background task. */
interface LiveBackgroundTask {
  toolUseId?: string;
  description?: string;
  taskType?: string;
  workflowName?: string;
  spawnDepth?: number;
  isBackgrounded?: boolean;
  status?: 'pending' | 'running' | 'paused';
  phase?: string;
  summary?: string;
  usage?: LiveBackgroundTaskUsage;
  stoppable?: false;
}

export interface CodexLiveBackgroundTaskInput {
  taskId: string;
  taskType: 'local_agent' | 'local_bash'; // a Codex child is an agent, a terminal is a shell
  description?: string;
  toolUseId?: string;
}

export interface CodexBackgroundOwnerToken {
  readonly scope: { projectId: string; worktreeId: string; chatId: string };
}

export interface ClaudeNativeSubagentTask {
  taskId: string;
  backgrounded: boolean;
}

/**
 * Session crons (CronCreate, /loop, ScheduleWakeup) that the Claude CLI keeps
 * inside its process and fires as new turns. The Stop hook's `session_crons`
 * list is authoritative; cron tool uses since the last list count as pending.
 */
interface ClaudeSessionCrons {
  /** Cron tool uses that no Stop-hook list has accounted for yet. */
  unconfirmedToolUseIds: Set<string>;
  /** Tool uses a list already accounted for; a late stream copy is ignored. */
  confirmedToolUseIds: Set<string>;
  /** Entries in the last Stop-hook list. */
  scheduledCount: number;
  /** A Stop hook arrived without a readable list. */
  listUnreadable: boolean;
}

/**
 * Everything the live background-task reducer touches. Narrower than
 * {@link ActiveSession} on purpose: the deterministic E2E chat-event ingress
 * has no provider session to attach state to, and this lets it reduce the
 * identical event stream into its own holder instead of forking the rules.
 */
interface LiveBackgroundTaskStateOwner {
  liveBackgroundTasks: Map<string, LiveBackgroundTask>;
  foregroundTaskMetadata: Map<string, LiveBackgroundTask>;
  activeBackgroundTaskIds?: Set<string>;
  unknownTaskTypesLogged: Set<string>;
}

/** Current session or E2E ingress owner and its renderer-safe live tasks. */
export interface LiveBackgroundTaskOwner {
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  liveTasks: ActivityLiveBgTask[];
}

/** Why a session's live background tasks stopped, for the stop record. */
export type SessionStopCause =
  | 'stop'
  | 'recycle'
  | 'archive'
  | 'crash'
  | 'external_signal'
  | 'session_ended';

/**
 * Why a session must be recreated at its next turn. `stop`: the provider query
 * was aborted and cannot take another turn. `approval`: the live approval
 * registry already applies the change, so only launch flags lag. Every other
 * reason (and `unspecified`) changes what the session runs with.
 */
export type SessionRecreateReason =
  | 'stop'
  | 'approval'
  | 'plan'
  | 'plugins'
  | 'managed_delegation'
  | 'codex_preferences'
  | 'claude_mods'
  | 'account'
  | 'organization'
  | 'unspecified';

export type SessionTurnSettings = Pick<
  ChatSendMessageRequest,
  | 'model'
  | 'modelSelectionMode'
  | 'providerType'
  | 'executionHarness'
  | 'pluginSelections'
  | 'planMode'
  | 'modelConfig'
  | 'thinkingLevel'
  | 'approvalMode'
  | 'sessionApprovalRules'
  | 'codexProposalMode'
  | 'codexFastModeEnabled'
  | 'deferredToolsAllowed'
  | 'selectedRepoId'
>;

function cloneSessionTurnSettings(
  settings: SessionTurnSettings,
): SessionTurnSettings {
  return {
    model: settings.model,
    modelSelectionMode: settings.modelSelectionMode,
    providerType: settings.providerType,
    executionHarness: settings.executionHarness,
    pluginSelections: settings.pluginSelections
      ? structuredClone(settings.pluginSelections)
      : undefined,
    planMode: settings.planMode,
    modelConfig: settings.modelConfig ? { ...settings.modelConfig } : undefined,
    thinkingLevel: settings.thinkingLevel,
    approvalMode: settings.approvalMode,
    sessionApprovalRules: settings.sessionApprovalRules?.map((rule) => ({
      ...rule,
      target: { ...rule.target },
    })),
    codexProposalMode: settings.codexProposalMode,
    codexFastModeEnabled: settings.codexFastModeEnabled,
    deferredToolsAllowed: settings.deferredToolsAllowed,
    selectedRepoId: settings.selectedRepoId,
  };
}

interface ActiveSession {
  session: AgentSession;
  abortController: AbortController;
  onRemoved?: () => void;
  drainEventsBeforeRemoval?: () => Promise<void>;
  providerType: AgentProviderType;
  executionHarness?: AgentSessionOptions['executionHarness'];
  executionContext?: string;
  /** Immutable owner scope resolved when this provider session was created. */
  workOwnerKey: string;
  authGeneration: number;
  model?: ChatModel;
  selectedModel?: ChatModel;
  /** Provider-reported model used for display when the caller omitted one. */
  reportedModel?: ChatModel;
  systemPromptAppend?: string;
  globalInstructionsSnapshot?: string;
  pluginSelectionsSignature: string;
  deferredToolsAllowed: boolean;
  pluginSelections?: ChatTabPluginSelections;
  /** Inherited plugin-defaults revision the session was created under. */
  inheritedPluginDefaultsRevision?: number;
  /**
   * AI Credits routing signature the session was created under (CAN-838).
   * `'native'` or `routed:<model>`. When the effective routing decision changes
   * (e.g. on-quota trips, the quota window resets, or the selected model moves
   * between a natively-billable and a gateway-only one), the signature no longer
   * matches and `getOrCreateSession` recreates the session so the new decision
   * takes effect. Applies uniformly to every chat surface.
   */
  aiCreditsRoutingSignature: string;
  /**
   * The account proxy serves this session (CAN-4020). Set from the decision
   * made at creation, then replaced by the route the session actually applied.
   */
  accountProxyRouted?: boolean;
  recreateOnNextTurn: boolean;
  /** Why `recreateOnNextTurn` is set; empty or absent reads as `unspecified`. */
  recreateReasons?: ReadonlySet<SessionRecreateReason>;
  managedDelegationSurface?: AgentSessionOptions['managedDelegationSurface'];
  managedDelegationMode?: AgentSessionOptions['managedDelegationMode'];
  /** Turn options captured at activation for dispatch orchestration overlays. */
  turnSettings?: SessionTurnSettings;
  /** True while the session is actively processing a turn (between message dequeue and result/error event). */
  turnActive: boolean;
  /**
   * User message the provider dequeued for its current turn, when supplied.
   * Exact-turn Stop reads canonical turn state first; this record covers only
   * a chat canonical state has no turn for (see `providerTurnUserMessageId`).
   */
  activeUserMessageId: string | undefined;
  /** The user message whose stop was already requested, to avoid duplicates. */
  cancelRequestedUserMessageId: string | undefined;
  /**
   * The root Codex turn that is currently allowed to resume after pausing for
   * user input. Binding the permission to both IDs prevents stale prior-turn or
   * subagent events from consuming it.
   */
  codexContinuationRevivalTurn?: CodexTurnIdentity;
  codexRootThreadId?: string;
  codexRootTurnId?: string;
  /** Task tool_use ids correlated to native subagent tasks on this query. */
  claudeNativeSubagentTasks: Map<string, ClaudeNativeSubagentTask>;
  claudeSessionCrons: ClaudeSessionCrons;
  /** Receiver ids correlated to this root's Codex multi-agent items. */
  codexNativeSubagentThreadIds: Set<string>;
  /** Active child turns correlated to the receiver ids above. */
  codexNativeSubagentTurns: Map<string, string>;
  /**
   * Child thread turns running on this session's Codex client, keyed by
   * thread id. Unlike the interrupt correlation above, an entry outlives the
   * root turn that spawned the child: it ends only at the child's own
   * terminal event, or when the client re-establishes its thread.
   */
  codexLiveNativeSubagentTurns: Map<string, string>;
  createdAt: number;
  lastActivityAt: number;
  turnStartedAt?: number;
  turnElapsedBeforeCurrentSegmentMs: number;
  turnCount: number;
  pendingMessageCount: number;
  activeBackgroundTaskIds: Set<string>;
  continuationToolUseIds: Set<string>;
  /** Shell tools excluded by the finite-background heuristic (notably servers). */
  nonBusyBackgroundToolUseIds: Set<string>;
  /**
   * Every background task the provider has reported as live for this session's
   * current CLI process, keyed by task id.
   *
   * Deliberately separate from `activeBackgroundTaskIds`, which holds only the
   * Workflow and finite background shell continuations. Busy guards also
   * inspect non-ambient live tasks below. This set is the complete picture the
   * activity panel needs, so it
   * also holds persistent services and tasks Canopy never correlated to a tool
   * use. Reset whenever the session's CLI process (re)starts, because
   * `background_tasks_changed` emits nothing at startup.
   */
  liveBackgroundTasks: Map<string, LiveBackgroundTask>;
  /** Current Codex snapshot producer; identity gates delayed updates. */
  codexBackgroundOwnerToken?: CodexBackgroundOwnerToken;
  /** Last snapshot revision accepted from the current Codex owner. */
  codexBackgroundOwnerRevision?: number;
  /** Task ids in the shared live-task map owned by the current Codex producer. */
  codexBackgroundTaskIds: Set<string>;
  /** Bounded correlation retained until a foreground task is promoted. */
  foregroundTaskMetadata: Map<string, LiveBackgroundTask>;
  /** Task types are untrusted provider data; warn once per type and session. */
  unknownTaskTypesLogged: Set<string>;
  /** Why this session's provider process is ending; the first cause recorded wins. */
  teardownCause?: SessionStopCause;
  lastEventType?: string;
  assistantMode: AssistantMode;
  toolProfileHash: string;
  codeGraphToolsAdvertised: boolean;
  /** Interface tools bound when the session was created (CAN-4131). */
  interfaceTools?: readonly InterfaceToolName[];
  /**
   * The session rule list the session was created with. Providers check
   * approvals against this array and add the session's grants to it.
   */
  sessionApprovalRules?: ApprovalRule[];
}

interface CodexTurnIdentity {
  threadId: string;
  turnId: string;
}

export type ChatSessionActivityListener = () => void;
export type LiveBackgroundTasksListener = (sessionKey: string) => void;

export interface ChatTurnConcurrencySnapshot {
  activeTurns: number;
  pendingMessages: number;
}

const sessions = new Map<string, ActiveSession>();
const codexBackgroundOwnerEntries = new WeakMap<
  CodexBackgroundOwnerToken,
  string
>();
setAppliedApprovalReader((projectId, worktreeId, chatId) => {
  const session = sessions.get(
    sessionKey(projectId, worktreeId, chatId),
  )?.session;
  return session
    ? {
        mode: session.getAppliedApprovalMode?.(),
        rules: session.getAppliedApprovalRules?.(),
      }
    : undefined;
});
const providerAuthGenerations = new Map<AgentProviderType, number>();
// Session recreation can follow a passive observation without withdrawing
// the authority captured by delegates that are already doing work.
const providerSessionAuthGenerations = new Map<AgentProviderType, number>();
const chatSessionActivityListeners = new Set<ChatSessionActivityListener>();
const liveBackgroundTasksListeners = new Set<LiveBackgroundTasksListener>();
const SLOW_SESSION_PHASE_MS = 10_000;

// Announce manager-owned identity, recreation, auth, and plugin revisions.
// Routing-signature inputs have no change event, so those are not announced.
subscribePluginDefaultsRevision(() => {
  for (const key of Array.from(sessions.keys())) {
    notifySteeringEligibilityChanged(key);
  }
});

function notifyChatSessionActivityListeners(): void {
  evaluateIdleSessionReleases();
  for (const listener of Array.from(chatSessionActivityListeners)) {
    try {
      listener();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '[session-manager] Chat session activity listener failed:',
        error,
      );
    }
  }
}

function notifyLiveBackgroundTasksListeners(key: string): void {
  // Codex task snapshots change live tasks outside `recordSessionEvent`.
  evaluateIdleSessionRelease(key);
  for (const listener of Array.from(liveBackgroundTasksListeners)) {
    try {
      listener(key);
    } catch {
      // Background-task observers are read-only side channels. A renderer or
      // test listener must never interrupt provider event reduction.
    }
  }
}

function resolveProviderType(
  opts: AgentSessionOptions,
  existing?: ActiveSession,
): AgentProviderType {
  if (opts.providerType === 'opencode' || opts.executionHarness === 'opencode')
    return 'opencode';
  if (opts.model) {
    const source = getModelSource(opts.model);
    if (source === 'ollama') return 'ollama';
    if (source === 'claude-managed') return 'claude';
    if (source === 'codex-managed') return 'codex';
    if (source === 'cursor-managed') return 'cursor';
    if (source === 'antigravity-managed') return 'antigravity';
    if (source === 'copilot-managed') return 'copilot';
    if (source === 'opencode-managed') return 'opencode';
    if (source === 'ai-gateway') {
      return (
        opts.executionHarness ??
        getExecutionHarnessForModel(opts.model) ??
        'claude'
      );
    }
  }
  if (existing) return existing.providerType;
  if (opts.providerType) return opts.providerType;
  return 'claude';
}

function resolveExecutionHarness(
  opts: AgentSessionOptions,
  existing?: ActiveSession,
): NonNullable<AgentSessionOptions['executionHarness']> {
  const googleModel =
    opts.model && getModelSource(opts.model) === 'antigravity-managed';
  if (
    googleModel ||
    opts.providerType === 'antigravity' ||
    opts.executionHarness === 'antigravity'
  ) {
    if (
      !googleModel ||
      (opts.executionHarness && opts.executionHarness !== 'antigravity')
    )
      throw new Error(
        'Google requires a Google subscription model and its native runtime.',
      );
    return 'antigravity';
  }
  const wantsOpenCode =
    opts.providerType === 'opencode' || opts.executionHarness === 'opencode';
  if (wantsOpenCode) {
    if (
      !opts.model ||
      (getModelSource(opts.model) !== 'opencode-managed' &&
        !resolveGatewayModelEntry(opts.model))
    )
      throw new Error(
        'OpenCode requires a model from its connected providers.',
      );
    // The runtime admits the captured funding route and checks its protocol.
    // Keep the explicit harness even when this model also has a native route.
    return 'opencode';
  }
  if (opts.model && getModelSource(opts.model) === 'opencode-managed')
    return 'opencode';
  const wantsCopilot =
    opts.providerType === 'copilot' || opts.executionHarness === 'copilot';
  if (
    wantsCopilot &&
    (!opts.model || getModelSource(opts.model) !== 'copilot-managed')
  )
    throw new Error(
      'Copilot requires a model from the connected Copilot account.',
    );
  if (opts.model && getModelSource(opts.model) === 'copilot-managed')
    return 'copilot';
  const wantsCursor =
    opts.providerType === 'cursor' || opts.executionHarness === 'cursor';
  if (opts.model) {
    const source = getModelSource(opts.model);
    if (wantsCursor && source !== 'cursor-managed') {
      // A Cursor tab carrying a Claude or Codex model must not quietly run on
      // that model's harness; the provider the user chose would be ignored.
      throw new Error(
        'Cursor requires its managed model. Select Cursor default and try again.',
      );
    }
    if (source === 'claude-managed') return 'claude';
    if (source === 'codex-managed') return 'codex';
    if (source === 'cursor-managed') return 'cursor';
  }
  if (!opts.model && wantsCursor) {
    // Cursor has exactly one managed model. A provider-only request must not
    // fall through to the Claude default below and silently switch providers.
    throw new Error(
      'Cursor requires its managed model. Select Cursor default and try again.',
    );
  }
  return (
    opts.executionHarness ??
    (opts.model ? getExecutionHarnessForModel(opts.model) : undefined) ??
    existing?.executionHarness ??
    (opts.providerType === 'codex' ? 'codex' : 'claude')
  );
}

export function getProviderAuthGeneration(
  providerType: AgentProviderType,
): number {
  return providerAuthGenerations.get(providerType) ?? 0;
}

function getProviderSessionAuthGeneration(
  providerType: AgentProviderType,
): number {
  return providerSessionAuthGenerations.get(providerType) ?? 0;
}

export function resetProviderAuthGenerationsForTests(): void {
  providerAuthGenerations.clear();
  providerSessionAuthGenerations.clear();
  for (const key of Array.from(sessions.keys())) {
    notifySteeringEligibilityChanged(key);
  }
}

async function createProvider(
  harness: NonNullable<AgentSessionOptions['executionHarness']>,
  providerType: AgentProviderType,
  getWindow: () => BrowserWindow | null,
): Promise<AgentProvider> {
  // Harnesses with a worker-owned runtime construct their providers there
  // (CAN-4116 Claude; CAN-4117 Codex).
  const workerRuntime = await workerProviderRuntimeFor(harness);
  if (workerRuntime) return workerRuntime.providerFor(providerType, getWindow);
  throw new Error(`No provider runtime serves the ${harness} harness.`);
}

async function ensureProviderAuthBaselineForSession(
  providerType: AgentProviderType,
): Promise<void> {
  if (providerType !== 'claude' && providerType !== 'codex') {
    return;
  }

  const authState = await import('../auth/provider-auth-state');
  await authState.ensureProviderAuthBaselineForSession(
    providerType,
    'session-create',
  );
}

// A loggable name for the session-instance identity that registration and
// teardown compare (the AgentSession object), so a diagnostic line, such as a
// hosted CLI's PID, maps back to one instance without a join.
const sessionInstanceIds = new WeakMap<AgentSession, string>();

export function getSessionInstanceId(session: AgentSession): string {
  let id = sessionInstanceIds.get(session);
  if (id === undefined) {
    id = randomUUID();
    sessionInstanceIds.set(session, id);
  }
  return id;
}

function recordSessionDiagnostic(
  key: string,
  entry: ActiveSession,
  diagnostic: {
    kind:
      | 'session_registered'
      | 'session_unregistered'
      | 'session_replaced'
      | 'message_queued'
      | 'turn_active'
      | 'turn_idle'
      | 'phase_slow';
    phase?: string;
    elapsedMs?: number;
    changedOptions?: string[];
  },
): void {
  const identifiers = parseSessionKey(key);
  getExecutionObservabilityIngest().recordSessionDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: diagnostic.kind,
    sessionKey: key,
    projectId: identifiers.projectId,
    worktreeId: identifiers.worktreeId,
    chatId: identifiers.chatId,
    providerType: entry.providerType,
    sessionInstanceId: getSessionInstanceId(entry.session),
    ...(diagnostic.kind !== 'session_replaced' && entry.executionHarness
      ? { executionHarness: entry.executionHarness }
      : {}),
    ...(diagnostic.kind !== 'session_replaced' && entry.model
      ? { model: entry.model }
      : {}),
    turnActive: entry.turnActive,
    turnCount: entry.turnCount,
    pendingMessageCount: entry.pendingMessageCount,
    ...(entry.activeBackgroundTaskIds.size > 0
      ? { activeBackgroundTaskCount: entry.activeBackgroundTaskIds.size }
      : {}),
    ...(entry.lastEventType ? { lastEventType: entry.lastEventType } : {}),
    lastActivityAt: entry.lastActivityAt,
    ...(diagnostic.phase ? { phase: diagnostic.phase } : {}),
    ...(diagnostic.changedOptions
      ? { changedOptions: diagnostic.changedOptions }
      : {}),
    ...(typeof diagnostic.elapsedMs === 'number'
      ? { elapsedMs: diagnostic.elapsedMs }
      : {}),
  });
}

function hasBusyBackgroundWork(entry: ActiveSession): boolean {
  if (entry.activeBackgroundTaskIds.size > 0) return true;
  for (const task of Array.from(entry.liveBackgroundTasks.values())) {
    if (task.toolUseId && entry.nonBusyBackgroundToolUseIds.has(task.toolUseId))
      continue;
    // Snapshots can omit tool-use correlation; retain the known-server
    // description heuristic rather than letting a dev server block forever.
    if (
      !task.toolUseId &&
      isPersistentBackgroundService('', task.description ?? '')
    )
      continue;
    return true;
  }
  return false;
}

function hasActiveSessionWork(entry: ActiveSession): boolean {
  return (
    entry.turnActive ||
    entry.pendingMessageCount > 0 ||
    hasBusyBackgroundWork(entry)
  );
}

function hasActiveTurnOrNativeBackgroundWork(entry: ActiveSession): boolean {
  return hasActiveSessionWork(entry) || entry.liveBackgroundTasks.size > 0;
}

/** Chats whose canonical ownership (D, S, T, removal, background) needs wake. */
const canonicalWakeKeys = new Set<string>();
/**
 * Chats whose session reported work at its own last sync. A canonical change
 * never recomputes this at another moment, so it can only add a hold.
 */
const sessionWakeKeys = new Set<string>();
/** Chat-level, not per session: a removed session cannot drop a needed hold. */
const heldChatWakeKeys = new Set<string>();
/** Chats whose receipt-time canonical state has a current turn. */
const canonicalForegroundKeys = new Set<string>();
/**
 * Chats holding an accepted dispatch (D) that has not reached its start
 * receipt. Tracked by scope, so a chat without a session yet still counts.
 */
const canonicalDispatchKeys = new Set<string>();

/**
 * Hold a chat's wake lock while its canonical ownership needs it, including
 * before a session exists and while a removed one settles, or while its
 * session last reported work.
 */
export function syncWakeLockForChat(
  scope: { projectId: string; worktreeId: string; chatId: string },
  snapshot: ChatTurnOwnershipSnapshot,
): void {
  const key = sessionKey(scope.projectId, scope.worktreeId, scope.chatId);
  if (shouldHoldChatWake(snapshot)) canonicalWakeKeys.add(key);
  else canonicalWakeKeys.delete(key);
  applyChatWake(key);
}

/** Recompute the session's share of the hold at one of its own sync points. */
function syncChatWake(key: string): void {
  const entry = sessions.get(key);
  if (entry !== undefined && hasActiveSessionWork(entry))
    sessionWakeKeys.add(key);
  else sessionWakeKeys.delete(key);
  applyChatWake(key);
}

function applyChatWake(key: string): void {
  const hold = canonicalWakeKeys.has(key) || sessionWakeKeys.has(key);
  if (hold === heldChatWakeKeys.has(key)) return;
  if (hold) {
    getWakeLockService().acquire(...wakeLockHolder('chat', key));
    heldChatWakeKeys.add(key);
  } else {
    getWakeLockService().release(wakeLockHolderKey('chat', key));
    heldChatWakeKeys.delete(key);
  }
}

/**
 * Session turn activity: receipt-time canonical `current` once canonical turn
 * state owns root turns, else the session's own bookkeeping.
 */
function sessionTurnActive(key: string, entry: ActiveSession): boolean {
  // Bound ownership means canonical turn state decides; unbound, the session.
  return getChatTurnOwnership().isBound()
    ? canonicalForegroundKeys.has(key)
    : entry.turnActive;
}

/**
 * Track receipt-time canonical foreground, which session turn activity
 * projects once canonical turn state owns root turns (contracts §3).
 */
export function syncSessionTurnForChat(
  scope: { projectId: string; worktreeId: string; chatId: string },
  snapshot: ChatTurnOwnershipSnapshot,
): void {
  const key = sessionKey(scope.projectId, scope.worktreeId, scope.chatId);
  const dispatching = snapshot.dispatchOwners.length > 0;
  // Hooks queued behind a dispatch wake when it starts, retires or releases.
  const dispatchChanged = dispatching !== canonicalDispatchKeys.has(key);
  if (dispatching) canonicalDispatchKeys.add(key);
  else canonicalDispatchKeys.delete(key);
  const current = snapshot.receipt?.state.current;
  if (current?.userMessageId !== undefined)
    applyPendingTurnCancel(key, current.userMessageId);
  const foreground = current !== undefined;
  const foregroundChanged = foreground !== canonicalForegroundKeys.has(key);
  if (foreground) canonicalForegroundKeys.add(key);
  else canonicalForegroundKeys.delete(key);
  if (
    getChatTurnOwnership().isBound() &&
    (dispatchChanged || (foregroundChanged && sessions.has(key)))
  )
    notifyChatSessionActivityListeners();
}

getChatTurnOwnership().subscribe((snapshot) => {
  syncWakeLockForChat(snapshot.scope, snapshot);
  syncSessionTurnForChat(snapshot.scope, snapshot);
});

/** With `expected`, removes the key's entry only while it is still that one. */
function removeSessionEntry(
  key: string,
  expected?: ActiveSession,
): ActiveSession | undefined {
  const entry = sessions.get(key);
  if (!entry || (expected !== undefined && entry !== expected)) {
    return undefined;
  }

  sessions.delete(key);
  // Canonical removal-awaiting-settle and surviving owners keep the hold.
  syncChatWake(key);
  notifyLiveBackgroundTasksListeners(key);
  notifySteeringEligibilityChanged(key);
  releaseHandedOffTurnPreparations(key, 'all');
  try {
    entry.onRemoved?.();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[session-manager] Session removal callback failed for ${key}:`,
      error,
    );
  }
  recordSessionDiagnostic(key, entry, {
    kind: 'session_unregistered',
  });
  notifyChatSessionActivityListeners();

  // Drain any pending telemetry for this worktree immediately (bypassing the
  // debounce) when a chat tab closes / a session is killed (CAN-402). No-ops
  // when telemetry sync is off or for non-worktree (standalone) sessions.
  try {
    const { projectId, worktreeId } = parseSessionKey(key);
    void getTelemetrySyncService()
      .flushWorktreeNow(projectId, worktreeId)
      .catch(() => undefined);
  } catch {
    // Non-standard key shape — nothing to flush.
  }

  return entry;
}

export function subscribeChatSessionActivity(
  listener: ChatSessionActivityListener,
): () => void {
  chatSessionActivityListeners.add(listener);
  return (): void => {
    chatSessionActivityListeners.delete(listener);
  };
}

/** Subscribe to live background-task changes; listeners should re-read state. */
export function subscribeLiveBackgroundTasks(
  listener: LiveBackgroundTasksListener,
): () => void {
  liveBackgroundTasksListeners.add(listener);
  return (): void => {
    liveBackgroundTasksListeners.delete(listener);
  };
}

export function hasActiveChatTurns(): boolean {
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (sessionTurnActive(key, entry) || entry.pendingMessageCount > 0) {
      return true;
    }
  }

  return false;
}

export function hasActiveChatWork(): boolean {
  // Queued delegated work holds no slot, but an install would cancel it.
  if (hasLiveDelegations()) return true;
  for (const entry of Array.from(sessions.values())) {
    if (hasActiveSessionWork(entry)) {
      return true;
    }
  }

  return false;
}

/** Safety guard for destructive worktree operations, not the foreground queue gate. */
export function hasActiveChatWorkForWorktree(
  projectId: string,
  worktreeId: string,
): boolean {
  const prefix = `${projectId}/${worktreeId}/`;
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (key.startsWith(prefix) && hasActiveSessionWork(entry)) return true;
  }
  return false;
}

export function getChatSessionLiveness(
  projectId: string,
  worktreeId: string,
  chatId: string,
): { foreground: boolean; background: boolean } {
  const key = sessionKey(projectId, worktreeId, chatId);
  const entry = sessions.get(key);
  if (!entry || entry.session.isDisposed?.() === true) {
    return { foreground: false, background: false };
  }

  return {
    foreground:
      sessionTurnActive(key, entry) ||
      entry.pendingMessageCount > 0 ||
      entry.session.hasPendingSteeringInput?.() === true,
    background: hasBusyBackgroundWork(entry),
  };
}

export function getChatTurnConcurrencySnapshot(): ChatTurnConcurrencySnapshot {
  let activeTurns = activeDelegationCount();
  let pendingMessages = 0;
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (sessionTurnActive(key, entry)) {
      activeTurns += 1;
    }
    pendingMessages += entry.pendingMessageCount;
  }
  return { activeTurns, pendingMessages };
}

export function hasActiveChatTurnsForProject(projectId: string): boolean {
  const prefix = `${projectId}/`;
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    if (entry.turnActive || entry.pendingMessageCount > 0) {
      return true;
    }
  }

  return false;
}

export function hasActiveChatTurnsForWorktree(
  projectId: string,
  worktreeId: string,
): boolean {
  const prefix = `${projectId}/${worktreeId}/`;
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    if (sessionTurnActive(key, entry) || entry.pendingMessageCount > 0) {
      return true;
    }
  }
  // An accepted dispatch owns the chat before its start receipt (§6), so a
  // hook fired in that window queues behind it.
  return (
    getChatTurnOwnership().isBound() &&
    Array.from(canonicalDispatchKeys).some((key) => key.startsWith(prefix))
  );
}

let sessionShutdownStarted = false;
let codexAuthenticationGate: Promise<void> | null = null;
let codexAuthenticationEpoch = 0;
let authenticationRecovery: {
  attemptId: string;
  targets: Set<string>;
  suppressed: Set<string>;
} | null = null;
let pendingShutdownEntries: UsageLimitedChatEntry[] = [];

const pendingSessionCreations = new Map<symbol, AgentSessionOptions>();

// Not every caller holds a turn preparation, so an idle release also yields to
// one that may already have read the session it would end.
function hasPendingSessionCreation(key: string): boolean {
  for (const opts of Array.from(pendingSessionCreations.values())) {
    if (sessionKey(opts.projectId, opts.worktreeId, opts.chatId) === key)
      return true;
  }
  return false;
}

async function getOrCreateSessionWithoutStartReservation(
  opts: AgentSessionOptions,
  onEvent: (data: unknown) => void | Promise<void>,
  getWindow: () => BrowserWindow | null,
  lifecycle?: {
    onRemoved?: () => void;
    drainEventsBeforeRemoval?: () => Promise<void>;
  },
): Promise<AgentSession> {
  if (sessionShutdownStarted)
    throw new Error('Application is stopping. Resume this chat after restart.');
  if (resolveExecutionHarness(opts) === 'codex' && codexAuthenticationGate)
    await codexAuthenticationGate;
  const epoch = codexAuthenticationEpoch;
  const pending = Symbol();
  pendingSessionCreations.set(pending, opts);
  try {
    const session = await getOrCreateSessionImpl(
      opts,
      onEvent,
      getWindow,
      lifecycle,
      epoch,
    );
    if (sessionShutdownStarted)
      throw new Error(
        'Application is stopping. Resume this chat after restart.',
      );
    return session;
  } finally {
    pendingSessionCreations.delete(pending);
  }
}

async function getOrCreateSessionImpl(
  opts: AgentSessionOptions,
  onEvent: (data: unknown) => void | Promise<void>,
  getWindow: () => BrowserWindow | null,
  lifecycle?: {
    onRemoved?: () => void;
    drainEventsBeforeRemoval?: () => Promise<void>;
  },
  authenticationEpoch = codexAuthenticationEpoch,
): Promise<AgentSession> {
  if (sessionShutdownStarted)
    throw new Error('Application is stopping. Resume this chat after restart.');
  const key = sessionKey(opts.projectId, opts.worktreeId, opts.chatId);
  const requestedSelectedModel = opts.selectedModel ?? opts.model;
  const requestedPluginSelectionsSignature = pluginSelectionsSignature(opts);
  await waitForIdleReleaseTeardown(key);
  const existing = sessions.get(key);
  const executionHarness = resolveExecutionHarness(opts, existing);
  const providerType = resolveProviderType(
    {
      ...opts,
      executionHarness,
    },
    existing,
  );
  const sessionIdentityOpts: AgentSessionOptions = {
    ...opts,
    executionHarness,
    providerType,
  };
  const globalInstructionsSnapshot = opts.sdkSessionId
    ? (opts.globalInstructionsSnapshot ??
      existing?.globalInstructionsSnapshot ??
      '')
    : (opts.globalInstructionsBlock ?? '');
  const effectiveOpts: AgentSessionOptions = {
    ...sessionIdentityOpts,
    systemPromptAppend:
      appendUserOverallPreferencesBlock(
        opts.systemPromptAppend,
        globalInstructionsSnapshot,
      ) ?? opts.systemPromptAppend,
  };
  // Stale session routing reaches neither the account proxy choice nor the
  // spawned session (CAN-4200).
  if (
    !effectiveTabAiCreditsRouting(
      effectiveOpts.aiCreditsRouting,
      billedProviderFor(providerType, executionHarness),
    )
  ) {
    delete effectiveOpts.aiCreditsRouting;
  }
  await ensureProviderAuthBaselineForSession(providerType);
  const selectedModel = requestedSelectedModel;
  captureSessionWorkOwner(opts);
  const workOwner = await resolveSessionWorkOwner(opts);
  const matchContext = createSessionMatchContext(
    opts,
    effectiveOpts,
    providerType,
    workOwner,
  );
  effectiveOpts.interfaceTools = matchContext.requestedInterfaceTools;
  if (
    effectiveOpts.requiredAccountProxyConnectionId &&
    ((providerType !== 'claude' && providerType !== 'codex') ||
      isAiCreditsChosenOverAccountProxy(
        effectiveOpts.aiCreditsRouting,
        effectiveOpts.subscriptionBillingOverride,
      ) ||
      !(await previewAccountProxySessionRoute({
        harness: providerType,
        model: effectiveOpts.model,
        requiredConnectionId: effectiveOpts.requiredAccountProxyConnectionId,
        resolveWorkOwner: () => Promise.resolve(workOwner),
      })))
  )
    throw new Error(
      'The account proxy connection for this continuation is unavailable.',
    );
  // The policy gate runs before the session-reuse branch on purpose. A chat
  // opened while a model was still allowed keeps a live, option-matching entry
  // in `sessions` forever; checking only on the create/teardown path would let
  // that chat run on a now-blocked model indefinitely, because the background
  // policy re-probe only refreshes in-memory policy state and never inspects
  // the sessions map. Refusing here also tears the stale entry down so the next
  // turn cannot resurrect it.
  if (await isModelBlockedByStoredPolicy(selectedModel, workOwner)) {
    // Only the session this request read: one registered during the check
    // runs on a model the verdict never covered.
    const blocked = sessions.get(key);
    if (existing && blocked?.session === existing.session) {
      await destroySessionEntry(key, blocked, 'getOrCreateSession');
    }
    await onEvent({
      type: 'error',
      error: 'This model is blocked by your organization policy.',
      error_code: 'model_policy_blocked',
    });
    getExecutionObservabilityIngest().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'model_policy_refused',
      sessionKey: key,
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      providerType,
      ...(selectedModel ? { model: selectedModel } : {}),
    });
    throw new Error('This model is blocked by your organization policy.');
  }
  if (providerType !== 'claude' && providerType !== 'codex') {
    const gatewayCheck = await checkModelGatewayRoute(selectedModel, workOwner);
    if (!gatewayCheck.ok) throw new Error(gatewayCheck.message);
  }

  // Decide against the key's entry as it is now: during the awaits above
  // another teardown may have detached the one read at entry, and a successor
  // may have registered in its place.
  const current = sessions.get(key);
  if (current) {
    if (sessionMatchesOptions(current, sessionIdentityOpts, matchContext)) {
      current.onRemoved = lifecycle?.onRemoved;
      current.drainEventsBeforeRemoval ??= lifecycle?.drainEventsBeforeRemoval;
      current.session.setManagedDelegationMode?.(
        effectiveOpts.managedDelegationMode,
      );
      current.managedDelegationSurface = effectiveOpts.managedDelegationSurface;
      current.managedDelegationMode = effectiveOpts.managedDelegationMode;
      return current.session;
    }
    // Persist field names only. Prompts, environment values, credentials and
    // routing signatures must not appear in this replacement diagnostic.
    recordSessionDiagnostic(key, current, {
      kind: 'session_replaced',
      changedOptions: getSessionChangedOptionNames(
        current,
        sessionIdentityOpts,
        matchContext,
      ),
    });
    markSessionTeardownCause(key, 'recycle');
    await destroySessionEntry(key, current, 'getOrCreateSession');
  }

  // Decided once here, with the session's own owner, and handed to the
  // session, so its billing label and its route cannot disagree.
  const accountProxyRouting: 'proxy' | 'off' =
    (providerType === 'claude' || providerType === 'codex') &&
    !isAiCreditsChosenOverAccountProxy(
      effectiveOpts.aiCreditsRouting,
      effectiveOpts.subscriptionBillingOverride,
    ) &&
    (await previewAccountProxySessionRoute({
      harness: providerType,
      model: effectiveOpts.model,
      requiredConnectionId: effectiveOpts.requiredAccountProxyConnectionId,
      resolveWorkOwner: () => Promise.resolve(workOwner),
    }))
      ? 'proxy'
      : 'off';
  if (
    effectiveOpts.requiredAccountProxyConnectionId &&
    accountProxyRouting !== 'proxy'
  )
    throw new Error(
      'The account proxy connection for this continuation is unavailable.',
    );
  const provider = await createProvider(
    executionHarness,
    providerType,
    getWindow,
  );
  // Checked after the last await, so a stop or a Codex sign-in that began
  // while either await was pending still keeps this session from starting.
  if (sessionShutdownStarted)
    throw new Error('Application is stopping. Resume this chat after restart.');
  if (
    executionHarness === 'codex' &&
    authenticationEpoch !== codexAuthenticationEpoch
  )
    throw new Error('Chat paused for Codex sign-in.');
  const session = provider.createSession(
    { ...effectiveOpts, accountProxyRouting },
    onEvent,
    getWindow,
  );
  // The provider registers the session synchronously inside createSession;
  // stamp the routing signature it was created under so the next turn can detect
  // an effective routing change (on-quota trip / reset, mode flip) and recreate.
  const created = sessions.get(key);
  if (created) {
    created.onRemoved = lifecycle?.onRemoved;
    created.drainEventsBeforeRemoval = lifecycle?.drainEventsBeforeRemoval;
    created.aiCreditsRoutingSignature = matchContext.routingSignature;
    created.interfaceTools = matchContext.requestedInterfaceTools;
    created.accountProxyRouted = accountProxyRouting === 'proxy';
    created.model = effectiveOpts.model;
    created.selectedModel = requestedSelectedModel;
    created.systemPromptAppend = sessionIdentityOpts.systemPromptAppend;
    created.globalInstructionsSnapshot = globalInstructionsSnapshot;
    created.pluginSelectionsSignature = requestedPluginSelectionsSignature;
    created.deferredToolsAllowed = effectiveOpts.deferredToolsAllowed !== false;
    created.pluginSelections = normalizePluginSelections(
      effectiveOpts.pluginSelections,
    );
    created.inheritedPluginDefaultsRevision =
      effectiveOpts.applyGlobalPluginDefaults
        ? getInheritedPluginDefaultsRevision(effectiveOpts)
        : undefined;
    created.executionHarness = executionHarness;
    syncClaudeIdleStateToStampedHarness(key);
    created.executionContext = effectiveOpts.executionContext;
    created.workOwnerKey = matchContext.requestedWorkOwnerKey;
    created.managedDelegationSurface = effectiveOpts.managedDelegationSurface;
    created.managedDelegationMode = effectiveOpts.managedDelegationMode;
    created.sessionApprovalRules = effectiveOpts.sessionApprovalRules;
    trackAppliedApproval(
      session,
      effectiveOpts.approvalMode,
      effectiveOpts.sessionApprovalRules,
    );
    const readSteeringCapabilities =
      session.getSteeringCapabilities?.bind(session);
    if (readSteeringCapabilities) {
      session.getSteeringCapabilities = (): ReturnType<
        typeof readSteeringCapabilities
      > => {
        const capabilities = readSteeringCapabilities();
        const current = sessions.get(key);
        // A settings/auth/routing change may require a new process on the next
        // ordinary turn. Never bypass that boundary by steering the old one.
        // Withdrawal and Interrupt remain available for its already-owned input.
        const compatible =
          current?.session === session &&
          !current.recreateOnNextTurn &&
          current.authGeneration ===
            getProviderSessionAuthGeneration(current.providerType) &&
          current.pluginSelectionsSignature ===
            pluginSelectionsSignature(effectiveOpts) &&
          current.aiCreditsRoutingSignature ===
            resolveSessionRoutingSignature(
              { ...effectiveOpts, model: current.model },
              current.providerType,
            );
        return { ...capabilities, steer: capabilities.steer && compatible };
      };
    }
    notifySteeringEligibilityChanged(key);
  }
  return session;
}

const sessionCreationLanes = new Map<string, Promise<void>>();

/**
 * Runs one chat's session creations one at a time, in arrival order
 * (CAN-4833). The slot is taken synchronously, so the order matches the order
 * in which `getOrCreateRoutedSession` installed its event routes and the
 * latest request's session ends up registered. Teardowns never take a lane: a
 * creation awaits teardowns, and its auth baseline check can invalidate
 * sessions from inside the lane.
 */
async function withSessionCreationLane<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sessionCreationLanes.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionCreationLanes.set(key, slot);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionCreationLanes.get(key) === slot)
      sessionCreationLanes.delete(key);
  }
}

export function getOrCreateSession(
  opts: AgentSessionOptions,
  onEvent: (data: unknown) => void | Promise<void>,
  getWindow: () => BrowserWindow | null,
  lifecycle?: {
    onRemoved?: () => void;
    drainEventsBeforeRemoval?: () => Promise<void>;
  },
): Promise<AgentSession> {
  assertAgentWorkerContext('getOrCreateSession');
  return withWorkspaceTargetRuntimeStartReservation(
    opts.projectId,
    opts.worktreeId,
    () =>
      withSessionCreationLane(
        sessionKey(opts.projectId, opts.worktreeId, opts.chatId),
        () =>
          getOrCreateSessionWithoutStartReservation(
            opts,
            onEvent,
            getWindow,
            lifecycle,
          ),
      ),
  );
}

interface SessionMatchContext {
  providerType: AgentProviderType;
  requestedMode: AssistantMode;
  requestedToolProfileHash: string;
  requestedSelectedModel: ChatModel | undefined;
  requestedPluginSelectionsSignature: string;
  currentAuthGeneration: number;
  routingSignature: string;
  requestedWorkOwnerKey: string;
  requestedInterfaceTools: readonly InterfaceToolName[];
  requestedInterfaceToolsSignature: string;
}

interface ReadOnlySessionComparison {
  existing: ActiveSession;
  options: AgentSessionOptions;
  context: SessionMatchContext;
}

function workOwnerIdentityKey(owner: WorkOwner | undefined): string {
  return owner?.kind === 'organization'
    ? `organization:${owner.organizationId.toLowerCase()}`
    : (owner?.kind ?? 'unknown');
}

function createSessionMatchContext(
  opts: AgentSessionOptions,
  effectiveOpts: AgentSessionOptions,
  providerType: AgentProviderType,
  workOwner: WorkOwner | undefined,
): SessionMatchContext {
  const requestedInterfaceTools = resolveSessionInterfaceTools(opts);
  return {
    providerType,
    requestedMode: opts.assistantMode ?? 'default',
    requestedToolProfileHash: opts.toolProfileHash ?? 'default',
    requestedSelectedModel: opts.selectedModel ?? opts.model,
    requestedPluginSelectionsSignature: pluginSelectionsSignature(opts),
    currentAuthGeneration: getProviderSessionAuthGeneration(providerType),
    routingSignature: resolveSessionRoutingSignature(
      effectiveOpts,
      providerType,
    ),
    requestedWorkOwnerKey: workOwnerIdentityKey(workOwner),
    requestedInterfaceTools,
    requestedInterfaceToolsSignature: interfaceToolsSignature(
      requestedInterfaceTools,
    ),
  };
}

/**
 * Resolve the owner a read-only comparison would use without binding it into
 * the session-capture map. Background sends have a persisted execution context
 * that may supersede a previously captured owner; interactive sends retain the
 * existing capture and only peek at it.
 */
async function resolveReadOnlySessionWorkOwner(
  opts: AgentSessionOptions,
  existing: ActiveSession,
): Promise<WorkOwner | undefined> {
  if (
    opts.executionContext !== undefined &&
    opts.executionContext !== existing.executionContext
  ) {
    return resolveBackgroundWorkOwner(
      { projectId: opts.projectId, worktreeId: opts.worktreeId },
      opts.executionContext,
    );
  }
  return peekSessionWorkOwner(opts);
}

async function getReadOnlySessionComparison(
  opts: AgentSessionOptions,
): Promise<ReadOnlySessionComparison | undefined> {
  const existing = sessions.get(
    sessionKey(opts.projectId, opts.worktreeId, opts.chatId),
  );
  if (!existing) return undefined;

  const executionHarness = resolveExecutionHarness(opts, existing);
  const providerType = resolveProviderType(
    { ...opts, executionHarness },
    existing,
  );
  const effectiveOpts: AgentSessionOptions = {
    ...opts,
    executionHarness,
    providerType,
  };
  const workOwner = await resolveReadOnlySessionWorkOwner(opts, existing);
  return {
    existing,
    options: effectiveOpts,
    context: createSessionMatchContext(
      opts,
      effectiveOpts,
      providerType,
      workOwner,
    ),
  };
}

function getSessionChangedOptionNames(
  existing: ActiveSession,
  opts: AgentSessionOptions,
  context: SessionMatchContext,
  includeCapabilitySnapshot = true,
): string[] {
  const comparisons: [string, unknown, unknown][] = [
    ['providerType', existing.providerType, context.providerType],
    ['executionHarness', existing.executionHarness, opts.executionHarness],
    ['executionContext', existing.executionContext, opts.executionContext],
    ['workOwner', existing.workOwnerKey, context.requestedWorkOwnerKey],
    ['model', existing.model, opts.model],
    ['selectedModel', existing.selectedModel, context.requestedSelectedModel],
    [
      'pluginSelections',
      existing.pluginSelectionsSignature,
      context.requestedPluginSelectionsSignature,
    ],
    [
      'deferredToolsAllowed',
      existing.deferredToolsAllowed,
      opts.deferredToolsAllowed !== false,
    ],
  ];
  if (
    !managedDelegationModesShareProviderSession(
      existing.managedDelegationMode,
      opts.managedDelegationMode,
    )
  ) {
    comparisons.push([
      'managedDelegationMode',
      existing.managedDelegationMode,
      opts.managedDelegationMode,
    ]);
  }
  comparisons.push(
    ['assistantMode', existing.assistantMode, context.requestedMode],
    ['toolProfile', existing.toolProfileHash, context.requestedToolProfileHash],
    [
      'interfaceTools',
      interfaceToolsSignature(existing.interfaceTools),
      context.requestedInterfaceToolsSignature,
    ],
    ['authGeneration', existing.authGeneration, context.currentAuthGeneration],
    ['routing', existing.aiCreditsRoutingSignature, context.routingSignature],
  );
  if (includeCapabilitySnapshot) {
    comparisons.push(
      [
        'systemPromptAppend',
        existing.systemPromptAppend,
        opts.systemPromptAppend,
      ],
      [
        'codeGraphToolsAdvertised',
        existing.codeGraphToolsAdvertised,
        opts.codeGraphToolsAdvertised ?? false,
      ],
      [
        'sessionApprovalRules',
        true,
        sessionApprovalRulesReusable(existing, opts),
      ],
    );
  }
  return comparisons
    .filter(([, before, after]) => before !== after)
    .map(([name]) => name);
}

function sessionMatchesOptions(
  existing: ActiveSession,
  opts: AgentSessionOptions,
  context: SessionMatchContext,
): boolean {
  return getSessionChangedOptionNames(existing, opts, context).length === 0;
}

/**
 * Whether the session's live rules have the same effect as the requested
 * rules. A revoked grant or a new deny rule replaces the session, and so does
 * one narrowed for an earlier turn, so a later turn gets the chat's grants
 * back. Options that name no rules leave them unchecked.
 */
function sessionApprovalRulesReusable(
  existing: ActiveSession,
  opts: AgentSessionOptions,
): boolean {
  const requested = opts.sessionApprovalRules;
  const live = existing.sessionApprovalRules;
  if (requested === undefined) return true;
  return (
    live !== undefined &&
    sessionApprovalRulesWithin(live, requested) &&
    sessionApprovalRulesWithin(requested, live)
  );
}

/**
 * Narrows a live session's rules, in place, to `rules`: removes the allow
 * rules `rules` does not hold and adds its deny rules. Grants `rules` holds
 * that the session lacks are not added.
 */
export function restrictSessionApprovalRules(
  projectId: string,
  worktreeId: string,
  chatId: string,
  rules: readonly ApprovalRule[],
): void {
  const live = sessions.get(
    sessionKey(projectId, worktreeId, chatId),
  )?.sessionApprovalRules;
  if (!live) return;
  const kept = limitAllowRules(live, rules);
  if (kept.length !== live.length) live.splice(0, live.length, ...kept);
  live.push(...sendDenyRulesBeyond(live, rules));
}

/** The looser of two modes; an unknown mode (undefined) is the loosest. */
function looserApprovalMode(
  a: ApprovalMode | undefined,
  b: ApprovalMode | undefined,
): ApprovalMode | undefined {
  if (a === undefined || b === undefined) return undefined;
  return isStricterApprovalMode(a, b) ? b : a;
}

/**
 * Records the approval authority the session has applied, read to decide
 * what may steer into it and what its agent may do (CAN-4821).
 * `getAppliedApprovalRules` returns `rules`, the live list the provider's
 * approvals read and `restrictSessionApprovalRules` narrows in place. Every
 * `setApprovalMode` call goes through `getAppliedApprovalMode`'s record.
 * Providers can apply a switch before it settles, or keep part of a failed
 * one, so while calls are pending, and after a window of overlapping calls in
 * which one failed, it reports the loosest mode in play. Once every call in a
 * window succeeds it reports the loosest mode they set, since the order the
 * provider applied them is unknown.
 */
function trackAppliedApproval(
  session: AgentSession,
  createdWith: ApprovalMode | undefined,
  rules: readonly ApprovalRule[] | undefined,
): void {
  session.getAppliedApprovalRules = (): readonly ApprovalRule[] | undefined =>
    rules;
  const apply = session.setApprovalMode.bind(session);
  let settled = createdWith;
  type CallWindow = { modes: ApprovalMode[]; failed: boolean; pending: number };
  const openWindow = (): CallWindow => ({
    modes: [],
    failed: false,
    pending: 0,
  });
  let calls = openWindow();
  const loosestOf = (
    modes: readonly ApprovalMode[],
    from: ApprovalMode | undefined,
  ): ApprovalMode | undefined =>
    modes.reduce<ApprovalMode | undefined>(looserApprovalMode, from);
  session.getAppliedApprovalMode = (): ApprovalMode | undefined =>
    calls.pending > 0 ? loosestOf(calls.modes, settled) : settled;
  session.setApprovalMode = async (mode: ApprovalMode): Promise<void> => {
    const current = calls;
    current.modes.push(mode);
    current.pending += 1;
    try {
      await apply(mode);
    } catch (error) {
      current.failed = true;
      throw error;
    } finally {
      current.pending -= 1;
      if (current.pending === 0) {
        const [first, ...rest] = current.modes;
        settled = current.failed
          ? loosestOf(current.modes, settled)
          : loosestOf(rest, first);
        calls = openWindow();
      }
    }
  };
}

function sessionIdentityMatchesOptions(
  existing: ActiveSession,
  opts: AgentSessionOptions,
  context: SessionMatchContext,
): boolean {
  return (
    getSessionChangedOptionNames(existing, opts, context, false).length === 0
  );
}

function managedDelegationModesShareProviderSession(
  current: AgentSessionOptions['managedDelegationMode'],
  requested: AgentSessionOptions['managedDelegationMode'],
): boolean {
  if (current === requested) return true;
  return (
    (current === 'explicit-only' || current === 'proactive') &&
    (requested === 'explicit-only' || requested === 'proactive')
  );
}

/**
 * Returns whether {@link getOrCreateSession} would reuse the current logical
 * session for these exact options. Callers that snapshot immutable session
 * capabilities can use this before carrying a prior snapshot into a turn that
 * may instead replace the provider session.
 */
export async function canReuseSession(
  opts: AgentSessionOptions,
): Promise<boolean> {
  const comparison = await getReadOnlySessionComparison(opts);
  return (
    comparison !== undefined &&
    sessionMatchesOptions(
      comparison.existing,
      comparison.options,
      comparison.context,
    )
  );
}

/**
 * Compare the live session with dispatch options without changing its owner
 * capture or probing provider authentication. The latter can call the raw
 * provider status endpoint and publish auth invalidation; normal dispatch
 * performs that baseline check before making its reuse decision.
 */
export async function getSessionChangedOptions(
  opts: AgentSessionOptions,
): Promise<string[]> {
  const comparison = await getReadOnlySessionComparison(opts);
  return comparison
    ? getSessionChangedOptionNames(
        comparison.existing,
        comparison.options,
        comparison.context,
      )
    : [];
}

/**
 * Returns whether the current session still has the same logical identity when
 * only its injected prompt or immutable Code Graph capability snapshot differs.
 * This lets callers recreate a provider session for live prompt changes without
 * accidentally replacing the logical session's captured capability.
 */
export async function canPreserveSessionCapabilitySnapshot(
  opts: AgentSessionOptions,
): Promise<boolean> {
  const comparison = await getReadOnlySessionComparison(opts);
  return (
    comparison !== undefined &&
    sessionIdentityMatchesOptions(
      comparison.existing,
      comparison.options,
      comparison.context,
    )
  );
}

/**
 * Compute the AI Credits routing signature a session should be created under, so
 * a changed effective decision (on-quota trip/reset, mode flip, per-session
 * override) forces recreation. Only Claude/Codex participate; other providers
 * are always `'native'`. Cheap: reads cached mode + in-memory quota state.
 */
export function resolveSessionRoutingSignature(
  opts: AgentSessionOptions,
  providerType: AgentProviderType,
): string {
  const base = resolveAiCreditsRoutingSignature(opts, providerType);
  if (providerType !== 'claude' && providerType !== 'codex') return base;
  // The account proxy settings join the signature, so turning the proxy or
  // keep-on-one-account on or off recreates the session (CAN-4020). Whether
  // the proxy took the session is recorded on its registry entry instead.
  const proxy = accountProxySettingsSignature(providerType);
  const signature = proxy ? `${base}|${proxy}` : base;
  return opts.requiredAccountProxyConnectionId
    ? `${signature}|required-account-proxy:${opts.requiredAccountProxyConnectionId}`
    : signature;
}

function resolveAiCreditsRoutingSignature(
  opts: AgentSessionOptions,
  providerType: AgentProviderType,
): string {
  if (providerType === 'opencode') {
    if (!opts.model || getRawOpenCodeModelId(opts.model)) return 'native';
    const route = resolveGatewayModelEntry(opts.model);
    if (!route) return 'native';
    return route.origin === 'org-gateway'
      ? `routed:org:${route.organizationId ?? ''}:${route.baseUrl ?? ''}:${opts.model ?? ''}`
      : `routed:${opts.model ?? ''}`;
  }
  if (providerType !== 'claude' && providerType !== 'codex') {
    return 'native';
  }
  // Stale session routing leaves the routed bucket, so the session recreates
  // on the subscription lane (CAN-4200).
  const aiCreditsRouting = effectiveTabAiCreditsRouting(
    opts.aiCreditsRouting,
    billedProviderFor(providerType),
  );
  // A gateway-only model has no native provider that could bill it, so the
  // session running it is routed by definition — `resolveCodexAiCreditsRouting`
  // forces the gateway for exactly this case regardless of mode or native auth,
  // and the renderer's `resolveChatBillingFramework` locks the picker to AI
  // Credits for the same reason. Without this branch the signature is
  // model-independent (`'native'` for a signed-in user with routing off), so
  // switching a live chat from a natively-billable model to a gateway-only one
  // matched the stale signature, reused the session, and never re-ran its
  // one-time routing preparation. The turn then reached the native app-server
  // as a raw model id and came back as "The '<model>' model is not supported
  // when using Codex with a ChatGPT account."
  //
  // Placed above the subscription override on purpose: an override cannot be
  // honored for a model no subscription can pay for, so `'native-forced'` would
  // report native while the spawn routes through the gateway anyway.
  if (isGatewayOnlyModel(opts.model)) {
    const route = resolveGatewayModelEntry(opts.model);
    return route?.origin === 'org-gateway'
      ? `routed:org:${route.organizationId ?? ''}:${route.baseUrl ?? ''}:${opts.model ?? ''}`
      : `routed:${opts.model ?? ''}`;
  }
  // An explicit per-chat subscription override forces native billing and beats
  // the global mode. Use a distinct bucket so flipping the toggle recreates the
  // live session instead of reusing a stale routed/native session; the
  // authoritative async resolution still runs at spawn.
  //
  if (opts.subscriptionBillingOverride) return 'native-forced';
  // Explicit subscription selection takes precedence over stale session routing.
  if (aiCreditsRouting?.active) {
    const model = aiCreditsRouting.modelId ?? opts.model;
    const route = resolveGatewayModelEntry(model);
    return route?.origin === 'org-gateway'
      ? `routed:org:${route.organizationId ?? ''}:${route.baseUrl ?? ''}:${model ?? ''}`
      : `routed:${model ?? ''}`;
  }
  const activation = resolveAiCreditsRoutingActivation(
    aiCreditsRouting,
    providerType,
  );
  if (!activation) {
    // No mode-driven activation, but a confirmed missing native login still
    // routes through AI Credits (ECW-9091), so the signature must say so —
    // otherwise a credits-routed session reports `'native'` and mis-attributes
    // its account scope and `aiCreditsRouted` turn metadata.
    //
    // `peekProviderNativeAuthAvailability` is the right read here: it is
    // cache-only and synchronous, honoring this function's cheapness contract,
    // and it omits the provider key when cold or probe-failed — degrading to
    // today's `'native'` rather than guessing.
    if (peekProviderNativeAuthAvailability()[providerType] === false) {
      return `routed:${opts.model ?? ''}`;
    }
    return 'native';
  }
  return `routed:${activation.modelId ?? opts.model ?? ''}`;
}

export function getSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
): AgentSession | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))?.session;
}

/** The selections materialized into the current provider session. */
export function getSessionPluginSelections(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ChatTabPluginSelections | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.pluginSelections;
}

/**
 * Inherited plugin-defaults revision (global plus the chat's workspace, see
 * `getInheritedPluginDefaultsRevision`) the current session was created
 * under, or `undefined` for surfaces that do not inherit defaults.
 */
export function getSessionGlobalPluginDefaultsRevision(
  projectId: string,
  worktreeId: string,
  chatId: string,
): number | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.inheritedPluginDefaultsRevision;
}

/** Drain the existing event owner without disposing a reusable provider query. */
export async function drainChatSessionEvents(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<void> {
  await sessions
    .get(sessionKey(projectId, worktreeId, chatId))
    ?.drainEventsBeforeRemoval?.();
}

export function getSessionProviderType(
  projectId: string,
  worktreeId: string,
  chatId: string,
): AgentProviderType | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))?.providerType;
}

export function getSessionExecutionHarness(
  projectId: string,
  worktreeId: string,
  chatId: string,
): AgentSessionOptions['executionHarness'] {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.executionHarness;
}

/**
 * True iff the live session for a chat is routing its LLM traffic through the
 * AI Credits gateway proxy rather than the native provider subscription. Read
 * from the session's routing signature (`routed:<model>`); `'native'` and
 * `'native-forced'` (explicit subscription override) both return `false`.
 * Returns `false` when there is no live session.
 */
export function isSessionAiCreditsRouted(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return getSessionAiCreditsRoutedState(projectId, worktreeId, chatId) === true;
}

/**
 * Tri-state form of {@link isSessionAiCreditsRouted}: `true`/`false` when a
 * live session reports its routing decision, `undefined` when no session is
 * registered.
 *
 * The distinction matters wherever "not routed" is acted on rather than merely
 * recorded. A chat is routinely idle with no session — restart the app, then
 * edit plugin or tool selections before sending anything — and collapsing that
 * absence into `false` makes an AI Credits chat look native, which downgrades
 * its persisted Codex reasoning route family and strips cached reasoning from
 * the rebuilt thread.
 */
export function getSessionAiCreditsRoutedState(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean | undefined {
  const active = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (!active) return undefined;
  // A session the account proxy took is billed to a proxy account.
  if (active.accountProxyRouted) return false;
  return active.aiCreditsRoutingSignature.startsWith('routed:');
}

/**
 * Record the route a session actually applied. Accounts can stop being ready
 * between creation and spawn, and a model only AI Credits serves skips the
 * proxy, so the creation-time decision is only a starting point.
 */
export function recordSessionAccountProxyRoute(
  key: string,
  routed: boolean,
): void {
  const entry = sessions.get(key);
  if (entry) entry.accountProxyRouted = routed;
  // The open turn's audit entry was started from the creation-time decision.
  getExecutionObservabilityIngest().setChatTurnAccountProxyRouted(key, routed);
}

/**
 * True when the account proxy serves this chat's live session. Its failures
 * belong to a proxy account, so they must never be treated as the user's own
 * provider sign-in or quota running out.
 */
export function isSessionAccountProxyRouted(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return (
    sessions.get(sessionKey(projectId, worktreeId, chatId))
      ?.accountProxyRouted === true
  );
}

/**
 * Return chat IDs for sessions that are actively processing a foreground turn.
 * Sessions that are registered but idle between turns are excluded so
 * that a renderer reload does not incorrectly restore 'streaming' status.
 * A queued-but-not-yet-dequeued message is included because the renderer
 * has already accepted the user's message and should keep the turn visible
 * while provider startup work completes.
 * Background-only work is intentionally excluded here: `hasActiveChatWork()`
 * and `activeBackgroundTaskCount` still protect unloads and diagnostics, but a
 * terminal foreground result should not restore a chat tab as streaming.
 */
export function getActiveChatIds(
  projectId: string,
  worktreeId: string,
): string[] {
  const prefix = `${projectId}/${worktreeId}/`;
  const chatIds: string[] = [];
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (
      key.startsWith(prefix) &&
      (sessionTurnActive(key, entry) || entry.pendingMessageCount > 0)
    ) {
      chatIds.push(key.slice(prefix.length));
    }
  }
  return chatIds;
}

/**
 * True while a Codex root turn is paused for user input and may resume when
 * the provider emits its continuation event.
 */
export function hasPendingCodexContinuation(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return (
    sessions.get(sessionKey(projectId, worktreeId, chatId))
      ?.codexContinuationRevivalTurn !== undefined
  );
}

/**
 * Return a `ChatActiveSessionInfo` entry for every live session registered
 * with the session manager under the given project/worktree, regardless of
 * whether the session is actively processing a turn. Idle (between-turn)
 * sessions are included with `turnActive: false` so the renderer can
 * distinguish "no live session" from "live but idle session" during
 * post-crash restore.
 *
 * Each entry's `projectId`, `worktreeId`, and `chatId` are parsed from the
 * session key via `parseSessionKey(...)` — not stored separately on
 * `ActiveSession`. `providerType` always reflects the true provider for the
 * session (never a hardcoded default).
 */
function toChatActiveSessionInfo(
  key: string,
  entry: ActiveSession,
): ChatActiveSessionInfo {
  const parsed = parseSessionKey(key);

  return {
    chatId: parsed.chatId,
    projectId: parsed.projectId,
    worktreeId: parsed.worktreeId,
    providerType: entry.providerType,
    ...(entry.executionHarness
      ? { executionHarness: entry.executionHarness }
      : {}),
    turnActive: sessionTurnActive(key, entry),
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    turnCount: entry.turnCount,
    pendingMessageCount: entry.pendingMessageCount,
    ...(entry.activeBackgroundTaskIds.size > 0
      ? { activeBackgroundTaskCount: entry.activeBackgroundTaskIds.size }
      : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.turnStartedAt !== undefined
      ? {
          turnStartedAt: entry.turnStartedAt,
          turnElapsedMs:
            entry.turnElapsedBeforeCurrentSegmentMs +
            Math.max(0, Date.now() - entry.turnStartedAt),
        }
      : {}),
    ...(entry.lastEventType ? { lastEventType: entry.lastEventType } : {}),
    ...(entry.session.settingApplication
      ? { settingApplication: { ...entry.session.settingApplication } }
      : {}),
    ...turnSettingsInfo(key, entry),
  };
}

/** The applied settings of a running turn, for a pending-change comparison. */
function turnSettingsInfo(
  key: string,
  entry: ActiveSession,
): Pick<ChatActiveSessionInfo, 'turnSettings'> {
  if (!sessionTurnActive(key, entry)) return {};
  const applied = entry.session.getAppliedTurnSettings?.();
  return applied ? { turnSettings: { ...applied } } : {};
}

export function getActiveSessionInfos(
  projectId: string,
  worktreeId: string,
): ChatActiveSessionInfo[] {
  const prefix = `${projectId}/${worktreeId}/`;
  const infos: ChatActiveSessionInfo[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    infos.push(toChatActiveSessionInfo(key, entry));
  }

  return infos;
}

export function getActiveSessionCapabilityProfile(
  projectId: string,
  worktreeId: string,
  chatId: string,
):
  | Pick<
      ActiveSession,
      'assistantMode' | 'codeGraphToolsAdvertised' | 'interfaceTools'
    >
  | undefined {
  const session = sessions.get(buildSessionKey(projectId, worktreeId, chatId));
  if (!session) return undefined;
  return {
    assistantMode: session.assistantMode,
    codeGraphToolsAdvertised: session.codeGraphToolsAdvertised,
    interfaceTools: session.interfaceTools ?? [],
  };
}

/**
 * Return a `ChatActiveSessionInfo` entry for every live session registered
 * with the session manager, across all projects/worktrees. Unlike
 * `getActiveSessionInfos`, this is not scoped to a single project/worktree —
 * it is used by cross-workspace surfaces (e.g. the usage-limited-chats list
 * IPC backing the account-change resume modal) that need to know about live
 * sessions anywhere in the app, not just within one worktree.
 */
export function getAllActiveSessionInfos(): ChatActiveSessionInfo[] {
  const infos: ChatActiveSessionInfo[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    infos.push(toChatActiveSessionInfo(key, entry));
  }

  return infos;
}

/**
 * Queue an MCP reload on every live Codex session that owns the just-authorized
 * proxy route. Active turns are then steered so the agent can opt into the
 * Codex-only immediate restart when the current request needs that server.
 */
export async function refreshCodexSessionsAfterMcpOAuth(input: {
  serverId: string;
  configId: string;
}): Promise<void> {
  const matching: ActiveSession[] = [];
  for (const entry of Array.from(sessions.values())) {
    if (entry.executionHarness !== 'codex' || !entry.session.reloadMcpServers) {
      continue;
    }
    const route = entry.session.usesMcpServerConfig?.(
      input.serverId,
      input.configId,
    );
    if (route) matching.push(entry);
  }

  await Promise.all(
    matching.map(async (entry) => {
      try {
        await entry.session.reloadMcpServers?.();
        if (!entry.turnActive || !entry.session.steerActiveTurn) return;
        await entry.session.steerActiveTurn(
          '<system_instruction>An MCP server is now connected and its refresh is queued for the next Codex turn. If the current request actually needs the newly connected MCP, end this turn by calling ImmediateTurnRestart. Otherwise continue normally and do not call the restart tool.</system_instruction>',
        );
      } catch (error) {
        // A session can finish or its worker can exit between OAuth callback
        // and refresh. Other matching sessions must still be refreshed.
        logMainProcessWarn(
          `[session-manager] Failed to refresh MCP ${input.serverId}/${input.configId} for a Codex session`,
          error,
        );
      }
    }),
  );
}

export async function destroySession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  options?: {
    suppressObservabilityInterrupt?: boolean;
    /**
     * A recycle (model, provider, approval-mode or plugin change, or a
     * recreate-on-next-turn) replaces only the provider session. The chat's
     * managed delegations belong to the chat, so the old session detaches from
     * them and the next session attaches. Without it, destroying the session
     * also closes the chat's delegation scope, as closing a chat does.
     */
    retainDelegations?: boolean;
  },
): Promise<void> {
  if (options?.retainDelegations !== true && hasDelegationLifecycle())
    await closeDelegationScope({ projectId, worktreeId, chatId });
  suppressCodexAuthenticationRecovery({ projectId, worktreeId, chatId });
  const key = sessionKey(projectId, worktreeId, chatId);
  const entry = sessions.get(key);
  if (!entry) return Promise.resolve();
  const finishRemoval = detachSessionForTeardown(key, entry);
  rejectAllForSession(key);
  // The provider can take seconds to exit, and a successor may register under
  // the key meanwhile; the key-scoped steps below are then the successor's.
  return (
    entry.session
      .destroy()
      // After the provider exits, so the tail its tasks wrote on the way out
      // still reaches the renderer before the pollers are discarded.
      .finally(() =>
        isSessionKeyReplaced(key, entry)
          ? undefined
          : flushAndStopOutputPollingForSession(key),
      )
      .finally(() => notifySessionEndedBackgroundTasks(key, entry))
      .finally(() => {
        if (
          options?.suppressObservabilityInterrupt !== true &&
          !isSessionKeyReplaced(key, entry)
        ) {
          getExecutionObservabilityIngest().interruptMatchingEntries(
            `chat:${key}`,
          );
        }
      })
      .finally(finishRemoval)
      .finally(() => {
        if (!isSessionKeyReplaced(key, entry))
          cleanupChatSkillPluginDir(projectId, worktreeId, chatId);
      })
  );
}

/** Destroy all sessions for a given worktree (called before worktree deletion). */
export async function destroyWorktreeSessions(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  if (hasDelegationLifecycle())
    await closeDelegationScope({ projectId, worktreeId });
  const prefix = `${projectId}/${worktreeId}/`;
  const toDestroy: { key: string; entry: ActiveSession }[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    if (key.startsWith(prefix)) {
      toDestroy.push({ key, entry });
    }
  }

  for (const { key, entry } of toDestroy) {
    const onRemoved = entry.onRemoved;
    const drainEventsBeforeRemoval = entry.drainEventsBeforeRemoval;
    // Remove the session from the active map immediately, but keep its event
    // router installed while provider teardown emits and durably commits any
    // terminal events.
    entry.onRemoved = undefined;
    removeSessionEntry(key);
    rejectAllForSession(key);
    try {
      await entry.session.destroy();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[destroyWorktreeSessions] Failed to destroy session ${key}:`,
        err,
      );
    }
    await flushAndStopOutputPollingForSession(key);
    notifySessionEndedBackgroundTasks(key, entry);
    getExecutionObservabilityIngest().interruptMatchingEntries(`chat:${key}`);
    try {
      await drainEventsBeforeRemoval?.();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[destroyWorktreeSessions] Failed to drain session events for ${key}:`,
        err,
      );
    } finally {
      try {
        onRemoved?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[session-manager] Session removal callback failed for ${key}:`,
          err,
        );
      }
    }
  }

  // Clean up synthesized skill-plugin directories for this worktree
  cleanupWorktreeChatPluginDirs(projectId, worktreeId);
}

/** Stop providers, drain their terminal events, then record interrupted work. */
export async function destroyAllSessions(
  options: { recordInterrupted?: boolean } = {},
): Promise<void> {
  if (options.recordInterrupted) sessionShutdownStarted = true;
  const entries = Array.from(sessions.entries());
  if (options.recordInterrupted) {
    await Promise.all(
      entries.map(async ([key, entry]) => {
        const drainEventsBeforeRemoval = entry.drainEventsBeforeRemoval;
        entry.drainEventsBeforeRemoval = undefined;
        try {
          await drainEventsBeforeRemoval?.();
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(
            `[SessionManager] Failed to drain provider events before shutdown for ${key}:`,
            error,
          );
        }
      }),
    );
  }
  const interrupted = entries
    .filter(
      ([, entry]) =>
        entry.turnActive ||
        entry.pendingMessageCount > 0 ||
        entry.activeBackgroundTaskIds.size > 0 ||
        Boolean(entry.codexContinuationRevivalTurn),
    )
    .map(([key, entry]) => ({
      entry,
      interruptedChat: {
        ...parseSessionKey(key),
        provider: entry.providerType,
        detectedAt: Date.now(),
        resumeReason: 'app_shutdown' as const,
        workspaceName: '',
        chatTitle: '',
      },
    }));
  const pendingCreations = Array.from(pendingSessionCreations.values()).map(
    (opts) => ({
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      provider: resolveProviderType(opts),
      detectedAt: Date.now(),
      resumeReason: 'app_shutdown' as const,
      workspaceName: '',
      chatTitle: '',
    }),
  );
  const stopped = await Promise.allSettled(
    entries.map(async ([key, entry]) => {
      const finishRemoval = detachSessionForTeardown(key, entry, {
        deferRemoval: options.recordInterrupted,
      });
      rejectAllForSession(key);
      try {
        await entry.session.destroy();
      } finally {
        entry.abortController.abort();
        await flushAndStopOutputPollingForSession(key);
        notifySessionEndedBackgroundTasks(key, entry);
        getExecutionObservabilityIngest().interruptMatchingEntries(
          `chat:${key}`,
        );
        await finishRemoval();
      }
    }),
  );
  // Catch pollers whose sessions were already removed before shutdown began.
  stopAllOutputPolling();
  claudeDurableCronIds.clear();
  if (options.recordInterrupted)
    pendingShutdownEntries.push(
      ...interrupted.map(({ interruptedChat }) => interruptedChat),
      ...pendingCreations,
    );
  if (options.recordInterrupted && pendingShutdownEntries.length > 0) {
    // Keep these imports deferred to avoid pulling registry and target
    // resolution modules into the session-manager initialization cycle.
    const { recordInterruptedChats } =
      await import('../lib/usage-limited-chats-registry');
    const { isRealWorkspaceTarget } = await import('../lib/chat-targets');
    await recordInterruptedChats(
      pendingShutdownEntries.filter(isRealWorkspaceTarget),
    );
    pendingShutdownEntries = [];
  }
  const failures = stopped.filter((result) => result.status === 'rejected');
  if (failures.length) {
    // Provider transports may already be gone during app shutdown. Interrupted
    // work has been recorded above, so disposal remains best-effort.
    // eslint-disable-next-line no-console
    console.error(
      'Failed to stop one or more chat sessions:',
      failures.map((result) => String(result.reason)),
    );
  }
}

/** A manual Stop wins over an in-flight sign-in checkpoint write. */
export function suppressCodexAuthenticationRecovery(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): void {
  const recovery = authenticationRecovery;
  const key = sessionKey(target.projectId, target.worktreeId, target.chatId);
  let activeAttemptId: string | undefined;
  if (recovery?.targets.has(key)) {
    recovery.suppressed.add(key);
    activeAttemptId = recovery.attemptId;
  }
  // Keep both imports lazy to avoid extending the session-manager ↔ registry ↔
  // queue-service initialization cycle; packaged Electron main exercises this
  // same deferred resolution path.
  void Promise.all([
    import('../lib/usage-limited-chats-registry'),
    import('../services/chat-queue-service'),
  ])
    .then(
      async ([
        { clearAuthenticationInterruptedChat },
        { getChatQueueService },
      ]) => {
        const queue = getChatQueueService();
        const attemptId =
          activeAttemptId ?? queue.releaseAuthenticationPauseForStop(target);
        if (!attemptId) return;
        if (activeAttemptId)
          queue.releaseAuthenticationPause(target, activeAttemptId);
        await clearAuthenticationInterruptedChat(target, attemptId);
      },
    )
    .catch((error: unknown) =>
      logMainProcessWarn('Could not clear sign-in recovery after Stop.', error),
    );
}

export function getCodexAuthenticationActiveWorkCount(): number {
  return (
    Array.from(sessions.values()).filter(
      (entry) =>
        entry.executionHarness === 'codex' &&
        (entry.turnActive ||
          entry.pendingMessageCount > 0 ||
          entry.activeBackgroundTaskIds.size > 0 ||
          entry.codexContinuationRevivalTurn),
    ).length +
    Array.from(pendingSessionCreations.values()).filter(
      (opts) => resolveExecutionHarness(opts) === 'codex',
    ).length
  );
}

/** Close session admission synchronously; retain interrupted work before login. */
export function pauseCodexSessionsForAuthentication(attemptId: string): {
  paused: Promise<number>;
  release: () => void;
} {
  if (codexAuthenticationGate)
    throw new Error('Codex sign-in is already active.');
  let release = (): void => {};
  codexAuthenticationGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  codexAuthenticationEpoch += 1;
  const entries = Array.from(sessions.entries()).filter(
    ([, entry]) => entry.executionHarness === 'codex',
  );
  const pending = Array.from(pendingSessionCreations.values()).filter(
    (opts) => resolveExecutionHarness(opts) === 'codex',
  );
  const recovery = {
    attemptId,
    targets: new Set([
      ...entries
        .filter(
          ([, entry]) =>
            entry.turnActive ||
            entry.pendingMessageCount > 0 ||
            entry.activeBackgroundTaskIds.size > 0 ||
            entry.codexContinuationRevivalTurn,
        )
        .map(([key]) => key),
      ...pending.map((opts) =>
        sessionKey(opts.projectId, opts.worktreeId, opts.chatId),
      ),
    ]),
    suppressed: new Set<string>(),
  };
  authenticationRecovery = recovery;
  const paused = (async (): Promise<number> => {
    // Keep these imports lazy to avoid extending the session-manager ↔ registry
    // and queue-service initialization cycles; packaged Electron main exercises
    // this same deferred resolution path.
    const { recordInterruptedChats, clearAuthenticationInterruptedChat } =
      await import('../lib/usage-limited-chats-registry');
    const { isRealWorkspaceTarget } = await import('../lib/chat-targets');
    const { getChatQueueService } =
      await import('../services/chat-queue-service');
    const interrupted: UsageLimitedChatEntry[] = pending.map((opts) => ({
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      provider: resolveProviderType(opts),
      detectedAt: Date.now(),
      resumeReason: 'provider_sign_in',
      authenticationAttemptId: attemptId,
      workspaceName: '',
      chatTitle: '',
    }));
    for (const [key, entry] of entries) {
      // Let already delivered terminal events settle before selecting work.
      await entry.drainEventsBeforeRemoval?.();
      if (sessions.get(key) !== entry) continue;
      if (
        entry.turnActive ||
        entry.pendingMessageCount > 0 ||
        entry.activeBackgroundTaskIds.size > 0 ||
        entry.codexContinuationRevivalTurn
      ) {
        const target = parseSessionKey(key);
        interrupted.push({
          ...target,
          provider: entry.providerType,
          detectedAt: Date.now(),
          resumeReason: 'provider_sign_in',
          authenticationAttemptId: attemptId,
          workspaceName: '',
          chatTitle: '',
        });
      }
    }
    await Promise.all(
      interrupted.map((target) =>
        getChatQueueService().pauseForAuthentication(target, attemptId),
      ),
    );
    const recorded = interrupted.filter(
      (target) =>
        isRealWorkspaceTarget(target) &&
        !recovery.suppressed.has(
          sessionKey(target.projectId, target.worktreeId, target.chatId),
        ),
    );
    const recordedKeys = new Set(
      recorded.map((target) =>
        sessionKey(target.projectId, target.worktreeId, target.chatId),
      ),
    );
    // Record before stopping: a crash during teardown still leaves recovery.
    try {
      await recordInterruptedChats(recorded);
    } catch (error) {
      for (const target of interrupted)
        getChatQueueService().releaseAuthenticationPause(target, attemptId);
      throw error;
    }
    for (const target of interrupted) {
      const key = sessionKey(
        target.projectId,
        target.worktreeId,
        target.chatId,
      );
      if (!recordedKeys.has(key))
        getChatQueueService().releaseAuthenticationPause(target, attemptId);
    }
    const results = await Promise.allSettled(
      entries.map(async ([key, entry]) => {
        if (sessions.get(key) !== entry) return;
        // A terminal callback may have completed while the durable record was
        // being written. Retire the idle worker without offering a new turn.
        if (
          !entry.turnActive &&
          entry.pendingMessageCount === 0 &&
          entry.activeBackgroundTaskIds.size === 0 &&
          !entry.codexContinuationRevivalTurn
        ) {
          const target = parseSessionKey(key);
          await clearAuthenticationInterruptedChat(target, attemptId);
          getChatQueueService().releaseAuthenticationPause(target, attemptId);
        }
        rejectAllForSession(key);
        await entry.session.destroy();
        entry.abortController.abort();
        await flushAndStopOutputPollingForSession(key);
        notifySessionEndedBackgroundTasks(key, entry);
        getExecutionObservabilityIngest().interruptMatchingEntries(
          `chat:${key}`,
        );
        await entry.drainEventsBeforeRemoval?.();
        await detachSessionForTeardown(key, entry)();
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected')
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error(String(failure.reason));
    return recorded.length;
  })();
  return {
    paused,
    release: (): void => {
      codexAuthenticationGate = null;
      if (authenticationRecovery === recovery) authenticationRecovery = null;
      release();
    },
  };
}

export async function destroySessionsByProvider(
  providerType: AgentProviderType,
): Promise<void> {
  return destroyMatchingSessions(
    (entry) => entry.providerType === providerType,
  );
}

export async function destroySessionsByModel(model: ChatModel): Promise<void> {
  return destroyMatchingSessions((entry) => entry.model === model);
}

async function destroyMatchingSessions(
  predicate: (entry: ActiveSession) => boolean,
): Promise<void> {
  const toDestroy: { key: string; entry: ActiveSession }[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    if (predicate(entry)) {
      toDestroy.push({ key, entry });
    }
  }

  for (const { key } of toDestroy) {
    markSessionTeardownCause(key, 'recycle');
  }

  for (const { key, entry } of toDestroy) {
    await destroySessionEntry(key, entry, 'destroySessionsByProvider');
  }
}

/**
 * Another instance registered under `key` after `entry` was detached. Its
 * key-scoped state (pollers, audit entries, plugin files) is the successor's.
 */
function isSessionKeyReplaced(key: string, entry: ActiveSession): boolean {
  const current = sessions.get(key);
  return current !== undefined && current !== entry;
}

/**
 * Detach from lookup immediately, but retain delivery until teardown writes
 * drain. Removal compares the entry, so a teardown that started from a stale
 * read never drops a successor registered under the same key.
 */
function detachSessionForTeardown(
  key: string,
  entry: ActiveSession,
  options: { deferRemoval?: boolean } = {},
): () => Promise<void> {
  if (sessions.get(key) === entry) clearPresentationTurn(key);
  const { onRemoved, drainEventsBeforeRemoval } = entry;
  entry.onRemoved = undefined;
  if (!options.deferRemoval) removeSessionEntry(key, entry);
  return async (): Promise<void> => {
    try {
      await drainEventsBeforeRemoval?.();
    } catch (error) {
      logMainProcessWarn(
        `[session-manager] Failed to drain session events for ${key}`,
        error,
      );
    } finally {
      if (options.deferRemoval) removeSessionEntry(key, entry);
      try {
        onRemoved?.();
      } catch (error) {
        logMainProcessWarn(
          `[session-manager] Session removal callback failed for ${key}`,
          error,
        );
      }
    }
  };
}

async function destroySessionEntry(
  key: string,
  entry: ActiveSession,
  logPrefix: string,
): Promise<void> {
  // Pending requests are keyed by chat; once a successor holds the key, the
  // remaining ones are its own.
  const registered = sessions.get(key);
  const ownsKeyRequests = registered === undefined || registered === entry;
  const finishRemoval = detachSessionForTeardown(key, entry);
  if (ownsKeyRequests) rejectAllForSession(key);
  try {
    await entry.session.destroy();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${logPrefix}] Failed to destroy session ${key}:`, err);
  } finally {
    const replaced = isSessionKeyReplaced(key, entry);
    if (!replaced) await flushAndStopOutputPollingForSession(key);
    notifySessionEndedBackgroundTasks(key, entry);
    if (!replaced)
      getExecutionObservabilityIngest().interruptMatchingEntries(`chat:${key}`);
    await finishRemoval();
  }
}

/**
 * Turns between session acquisition and the provider accepting their prompt.
 * The session is neither turn-active nor queued yet, but its prompt is
 * committed to it; an invalidation that destroyed it would silently drop the
 * turn. Only invalidations that opt in preserve these sessions.
 */
const preparingTurnCounts = new Map<string, number>();

/** Hold the session through turn preparation; the release is idempotent. */
export function beginSessionTurnPreparation(key: string): () => void {
  preparingTurnCounts.set(key, (preparingTurnCounts.get(key) ?? 0) + 1);
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const remaining = (preparingTurnCounts.get(key) ?? 1) - 1;
    if (remaining > 0) preparingTurnCounts.set(key, remaining);
    else preparingTurnCounts.delete(key);
  };
}

/**
 * Preparations whose prompt was handed to the provider but whose turn is not
 * active yet. A provider may still await work (Claude reads its inventory)
 * between dequeuing the prompt and marking the turn active.
 */
const handedOffTurnPreparations = new Map<string, Array<() => void>>();

/** Keep a preparation hold until the session's next turn activation. */
export function releaseSessionTurnPreparationOnActivation(
  key: string,
  release: () => void,
): void {
  if (!sessions.has(key)) {
    release();
    return;
  }
  const pending = handedOffTurnPreparations.get(key) ?? [];
  pending.push(release);
  handedOffTurnPreparations.set(key, pending);
}

function releaseHandedOffTurnPreparations(
  key: string,
  scope: 'next' | 'all',
): void {
  const pending = handedOffTurnPreparations.get(key);
  if (!pending) return;
  const released = scope === 'all' ? pending.splice(0) : pending.splice(0, 1);
  if (pending.length === 0) handedOffTurnPreparations.delete(key);
  for (const release of released) release();
}

/**
 * True while the session can produce a turn with no new user input, or holds
 * work that destroying it would drop or surface in the chat: a running,
 * queued or preparing turn (by the session's or canonical turn state's
 * account), undelivered steering input, a session being acquired, a turn
 * paused for user input, live background tasks, running native subagents,
 * live delegations, scheduled prompts the provider process will fire, or an
 * unanswered approval or question.
 */
function sessionCanStartTurnOnItsOwn(
  key: string,
  entry: ActiveSession,
): boolean {
  return (
    entry.turnActive ||
    sessionTurnActive(key, entry) ||
    claudeSessionHasScheduledPrompts(key, entry) ||
    entry.pendingMessageCount > 0 ||
    entry.session.hasPendingSteeringInput?.() === true ||
    preparingTurnCounts.has(key) ||
    hasPendingSessionCreation(key) ||
    entry.codexContinuationRevivalTurn !== undefined ||
    entry.activeBackgroundTaskIds.size > 0 ||
    entry.liveBackgroundTasks.size > 0 ||
    entry.claudeNativeSubagentTasks.size > 0 ||
    entry.codexLiveNativeSubagentTurns.size > 0 ||
    hasLiveDelegations(key) ||
    hasPendingApprovalsForSession(key) ||
    hasPendingRequestsForSession(key)
  );
}

/**
 * Durable crons (CronCreate `durable: true`) by chat. The CLI persists them to
 * `.claude/scheduled_tasks.json` but fires them only from a live process, so
 * they keep the session. Kept across Claude session replacement, since a
 * replacement process resuming the same conversation takes them over; a
 * session on another harness drops them.
 *
 * Only crons created by this app process are known. Durable crons a resumed
 * CLI reloads from disk after an app restart do not block release: a released
 * chat is left as a restarted one always was, with no CLI until its next
 * message (CAN-4834 known gap). Revisit if released chats must fire them on
 * time.
 */
const claudeDurableCronIds = new Map<string, Set<string>>();

function claudeSessionHasScheduledPrompts(
  key: string,
  entry: ActiveSession,
): boolean {
  if (entry.executionHarness !== 'claude') return false;
  const crons = entry.claudeSessionCrons;
  return (
    crons.scheduledCount > 0 ||
    crons.listUnreadable ||
    crons.unconfirmedToolUseIds.size > 0 ||
    (claudeDurableCronIds.get(key)?.size ?? 0) > 0
  );
}

const CLAUDE_CRON_SCHEDULING_TOOLS = new Set(['CronCreate', 'ScheduleWakeup']);
const MAX_CONFIRMED_CLAUDE_CRON_TOOL_USES = 256;

function noteClaudeCronToolUse(
  crons: ClaudeSessionCrons,
  toolUseId: string,
): void {
  if (crons.confirmedToolUseIds.has(toolUseId)) return;
  crons.unconfirmedToolUseIds.add(toolUseId);
}

/**
 * Stream form of the cron tool-use signal. It still counts when repository
 * settings disable hooks, which also silences the Stop hook that would clear
 * it, so such a session is kept.
 */
function updateClaudeSessionCronToolUses(
  entry: ActiveSession,
  data: unknown,
): void {
  if (
    entry.executionHarness !== 'claude' ||
    !isPlainRecord(data) ||
    data.type !== 'assistant' ||
    !isPlainRecord(data.message) ||
    !Array.isArray(data.message.content)
  ) {
    return;
  }
  for (const block of data.message.content) {
    if (!isPlainRecord(block) || block.type !== 'tool_use') continue;
    const name = readRecordString(block, 'name');
    const toolUseId = readRecordString(block, 'id');
    if (name && toolUseId && CLAUDE_CRON_SCHEDULING_TOOLS.has(name)) {
      noteClaudeCronToolUse(entry.claudeSessionCrons, toolUseId);
    }
  }
}

/**
 * Feed a Claude hook input into the session's scheduled-prompt state:
 * PreToolUse marks a cron tool use pending, PostToolUse records durable crons
 * and their deletion, and the main thread's Stop hook replaces the pending
 * state with its `session_crons` list. A Stop hook without a readable list
 * keeps the session.
 */
export function recordClaudeSessionCronHookInput(
  key: string,
  input: unknown,
): void {
  const entry = sessions.get(key);
  if (!entry || entry.executionHarness !== 'claude' || !isPlainRecord(input))
    return;
  const crons = entry.claudeSessionCrons;
  const event = readRecordString(input, 'hook_event_name');
  const toolName = readRecordString(input, 'tool_name');
  const toolUseId = readRecordString(input, 'tool_use_id');
  if (event === 'PreToolUse') {
    if (toolName && toolUseId && CLAUDE_CRON_SCHEDULING_TOOLS.has(toolName)) {
      noteClaudeCronToolUse(crons, toolUseId);
    }
    return;
  }
  if (event === 'PostToolUse') {
    recordClaudeDurableCronChange(key, toolName, toolUseId, input);
    evaluateIdleSessionRelease(key);
    return;
  }
  if (event !== 'Stop' || typeof input.agent_id === 'string') return;
  const listed = input.session_crons;
  if (!Array.isArray(listed)) {
    crons.listUnreadable = true;
    return;
  }
  crons.listUnreadable = false;
  crons.scheduledCount = listed.length;
  for (const id of Array.from(crons.unconfirmedToolUseIds)) {
    crons.confirmedToolUseIds.add(id);
  }
  crons.unconfirmedToolUseIds.clear();
  while (crons.confirmedToolUseIds.size > MAX_CONFIRMED_CLAUDE_CRON_TOOL_USES) {
    const oldest = crons.confirmedToolUseIds.values().next().value;
    if (typeof oldest !== 'string') break;
    crons.confirmedToolUseIds.delete(oldest);
  }
  evaluateIdleSessionRelease(key);
}

function recordClaudeDurableCronChange(
  key: string,
  toolName: string | undefined,
  toolUseId: string | undefined,
  input: Record<string, unknown>,
): void {
  const toolInput = isPlainRecord(input.tool_input)
    ? input.tool_input
    : undefined;
  const response = isPlainRecord(input.tool_response)
    ? input.tool_response
    : undefined;
  const responseId = response ? readRecordString(response, 'id') : undefined;
  if (toolName === 'CronCreate') {
    // An unreadable answer to a durable request counts as durable.
    const durable =
      response?.durable === true ||
      (toolInput?.durable === true && response?.durable !== false);
    const id = responseId ?? toolUseId;
    if (!durable || !id) return;
    const ids = claudeDurableCronIds.get(key) ?? new Set<string>();
    ids.add(id);
    claudeDurableCronIds.set(key, ids);
    return;
  }
  if (toolName !== 'CronDelete') return;
  const id =
    responseId ?? (toolInput ? readRecordString(toolInput, 'id') : undefined);
  const ids = claudeDurableCronIds.get(key);
  if (!id || !ids) return;
  ids.delete(id);
  if (ids.size === 0) claudeDurableCronIds.delete(key);
}

/**
 * Provider-neutral form of {@link sessionCanStartTurnOnItsOwn}. A chat with no
 * live session cannot start a turn by itself.
 */
export function chatSessionCanStartTurnOnItsOwn(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  const key = sessionKey(projectId, worktreeId, chatId);
  const entry = sessions.get(key);
  return entry !== undefined && sessionCanStartTurnOnItsOwn(key, entry);
}

/**
 * What the chat's owner says about a release once its session has gone quiet:
 * release it now, keep waiting for chat-level work to settle, or keep the
 * session and stop watching (the chat is no longer eligible).
 */
export type IdleChatSessionReleaseDecision = 'release' | 'wait' | 'retain';

interface IdleSessionRelease {
  target: { projectId: string; worktreeId: string; chatId: string };
  // The provider session, not its entry: re-registering the same session
  // replaces the entry with a new one around it.
  session: AgentSession;
  confirm: () => Promise<IdleChatSessionReleaseDecision>;
  timer?: ReturnType<typeof setTimeout>;
  phase: 'settling' | 'blocked' | 'confirming';
  settleMs: number;
  providerOutputs: number;
}

// Quiet period before release when nothing has happened since the request.
const IDLE_SESSION_RELEASE_SETTLE_MS = 5_000;
// Quiet period once the session was blocked or produced output: a provider
// continuation (for example Claude answering a finished background Bash) can
// take a full model round trip to show its first output, and must keep the
// session.
const IDLE_SESSION_RELEASE_ACTIVE_SETTLE_MS = 30_000;
// Re-check for blockers that settle without an activity signal: approvals,
// questions, delegations, turn preparations and chat-level waits.
const IDLE_SESSION_RELEASE_RECHECK_MS = 30_000;

const idleSessionReleases = new Map<string, IdleSessionRelease>();

/**
 * Destroy the chat's provider session once it cannot start a turn by itself
 * and `confirm` agrees. The release keeps the chat's delegations and records
 * no interruption, so it emits nothing into the chat; the next send resumes
 * the provider session through `getOrCreateSession`. Provider activity before
 * the release keeps the session. Replaces any earlier request for the chat,
 * and ends without releasing if the session is removed or replaced first.
 */
export function releaseChatSessionWhenIdle(
  target: { projectId: string; worktreeId: string; chatId: string },
  confirm: () => Promise<IdleChatSessionReleaseDecision>,
): void {
  const key = sessionKey(target.projectId, target.worktreeId, target.chatId);
  cancelIdleSessionRelease(key);
  const entry = sessions.get(key);
  if (!entry) return;
  idleSessionReleases.set(key, {
    target: { ...target },
    session: entry.session,
    confirm,
    phase: 'blocked',
    settleMs: IDLE_SESSION_RELEASE_SETTLE_MS,
    providerOutputs: 0,
  });
  evaluateIdleSessionRelease(key);
}

function cancelIdleSessionRelease(key: string): void {
  const release = idleSessionReleases.get(key);
  if (!release) return;
  if (release.timer !== undefined) clearTimeout(release.timer);
  idleSessionReleases.delete(key);
}

function armIdleSessionReleaseTimer(
  key: string,
  release: IdleSessionRelease,
  phase: 'settling' | 'blocked',
): void {
  if (release.timer !== undefined) clearTimeout(release.timer);
  release.phase = phase;
  release.timer = setTimeout(
    () => {
      release.timer = undefined;
      if (idleSessionReleases.get(key) !== release) return;
      if (phase === 'settling') void attemptIdleSessionRelease(key, release);
      else evaluateIdleSessionRelease(key);
    },
    phase === 'settling' ? release.settleMs : IDLE_SESSION_RELEASE_RECHECK_MS,
  );
  release.timer.unref?.();
}

/** The chat's live entry while it still holds the session the release watches. */
function releaseSessionEntry(
  key: string,
  release: IdleSessionRelease,
): ActiveSession | undefined {
  const entry = sessions.get(key);
  return entry?.session === release.session ? entry : undefined;
}

function evaluateIdleSessionReleases(): void {
  if (idleSessionReleases.size === 0) return;
  for (const key of Array.from(idleSessionReleases.keys())) {
    evaluateIdleSessionRelease(key);
  }
}

function evaluateIdleSessionRelease(
  key: string,
  options: { providerActivity?: boolean } = {},
): void {
  const release = idleSessionReleases.get(key);
  if (!release) return;
  if (options.providerActivity === true) release.providerOutputs += 1;
  if (release.phase === 'confirming') return;
  const entry = releaseSessionEntry(key, release);
  if (!entry) {
    cancelIdleSessionRelease(key);
    return;
  }
  if (sessionCanStartTurnOnItsOwn(key, entry)) {
    release.settleMs = IDLE_SESSION_RELEASE_ACTIVE_SETTLE_MS;
    if (release.phase !== 'blocked' || release.timer === undefined) {
      armIdleSessionReleaseTimer(key, release, 'blocked');
    }
    return;
  }
  // Provider output restarts the quiet period; other notifications do not.
  if (options.providerActivity === true) {
    release.settleMs = IDLE_SESSION_RELEASE_ACTIVE_SETTLE_MS;
  }
  if (release.phase !== 'settling' || options.providerActivity === true) {
    armIdleSessionReleaseTimer(key, release, 'settling');
  }
}

async function attemptIdleSessionRelease(
  key: string,
  release: IdleSessionRelease,
): Promise<void> {
  const entry = releaseSessionEntry(key, release);
  if (!entry) {
    cancelIdleSessionRelease(key);
    return;
  }
  if (sessionCanStartTurnOnItsOwn(key, entry)) {
    release.settleMs = IDLE_SESSION_RELEASE_ACTIVE_SETTLE_MS;
    armIdleSessionReleaseTimer(key, release, 'blocked');
    return;
  }
  release.phase = 'confirming';
  const outputsBeforeConfirm = release.providerOutputs;
  let decision: IdleChatSessionReleaseDecision;
  try {
    decision = await release.confirm();
  } catch (error) {
    // Keeping the session is today's behaviour, so an unanswerable check
    // fails safe.
    logMainProcessWarn(
      `[session-manager] Idle session release check failed for ${key}`,
      error,
    );
    decision = 'retain';
  }
  if (idleSessionReleases.get(key) !== release) return;
  const confirmedEntry = releaseSessionEntry(key, release);
  if (decision === 'retain' || !confirmedEntry) {
    cancelIdleSessionRelease(key);
    return;
  }
  if (sessionCanStartTurnOnItsOwn(key, confirmedEntry)) {
    release.settleMs = IDLE_SESSION_RELEASE_ACTIVE_SETTLE_MS;
    armIdleSessionReleaseTimer(key, release, 'blocked');
    return;
  }
  if (decision === 'wait') {
    armIdleSessionReleaseTimer(key, release, 'blocked');
    return;
  }
  // Output during the check restarts the quiet period instead.
  if (release.providerOutputs !== outputsBeforeConfirm) {
    release.settleMs = IDLE_SESSION_RELEASE_ACTIVE_SETTLE_MS;
    armIdleSessionReleaseTimer(key, release, 'settling');
    return;
  }
  cancelIdleSessionRelease(key);
  const { projectId, worktreeId, chatId } = release.target;
  const teardown: Promise<void> = destroySession(
    projectId,
    worktreeId,
    chatId,
    { retainDelegations: true, suppressObservabilityInterrupt: true },
  )
    .catch((error: unknown) => {
      logMainProcessWarn(
        `[session-manager] Failed to release idle provider session for ${key}`,
        error,
      );
    })
    .finally(() => {
      if (idleReleaseTeardowns.get(key) === teardown)
        idleReleaseTeardowns.delete(key);
    });
  idleReleaseTeardowns.set(key, teardown);
  await teardown;
}

/**
 * Released sessions whose provider cleanup is still running. That cleanup
 * clears per-chat state by chat key (Claude's query loop unregisters the
 * session and its MCP routes), so a restored chat's replacement session must
 * not register until it ends. CAN-4833 makes that cleanup instance-guarded for
 * every teardown.
 */
const idleReleaseTeardowns = new Map<string, Promise<void>>();

async function waitForIdleReleaseTeardown(key: string): Promise<void> {
  // Each teardown removes itself before settling; a later release of the
  // same chat installs a new one.
  for (
    let teardown = idleReleaseTeardowns.get(key);
    teardown !== undefined;
    teardown = idleReleaseTeardowns.get(key)
  ) {
    await teardown;
  }
}

let claudeSessionIdleTimeoutMs =
  DEFAULT_CLAUDE_SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
const claudeSessionIdleTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
/**
 * When each Claude session was last seen busy. Blockers such as delegations,
 * approvals and steering clear without touching `lastActivityAt`, so the idle
 * period also starts from here.
 */
const claudeSessionBusySeenAt = new Map<string, number>();

/**
 * The session runs a `claude` CLI, whatever its provider: Claude chats and
 * Ollama chats on the Claude harness. The Claude idle release keys on this.
 */
function sessionRunsClaudeCli(
  entry: ActiveSession | undefined,
): entry is ActiveSession {
  return entry?.executionHarness === 'claude';
}

function startClaudeSessionIdleWatch(key: string): void {
  claudeSessionBusySeenAt.delete(key);
  armClaudeSessionIdleTimer(key, claudeSessionIdleTimeoutMs);
}

/** A session on another harness has no Claude watch or durable crons. */
function clearClaudeSessionIdleState(key: string): void {
  clearTimeout(claudeSessionIdleTimers.get(key));
  claudeSessionIdleTimers.delete(key);
  claudeSessionBusySeenAt.delete(key);
  claudeDurableCronIds.delete(key);
}

/**
 * Re-applies the Claude idle state once getOrCreateSession stamps the harness,
 * which can differ from the one the session registered with. A Claude session
 * keeps the watch registerSession started.
 */
function syncClaudeIdleStateToStampedHarness(key: string): void {
  if (!sessionRunsClaudeCli(sessions.get(key))) {
    clearClaudeSessionIdleState(key);
  } else if (!claudeSessionIdleTimers.has(key)) {
    startClaudeSessionIdleWatch(key);
  }
}

/**
 * Release an open chat's `claude` process (see {@link sessionRunsClaudeCli})
 * once the session has had no activity for the idle timeout and is idle (see
 * {@link claudeSessionIdleReleaseBlocked}). The timer is re-armed from the
 * session's last activity, so streaming never touches it.
 */
function armClaudeSessionIdleTimer(key: string, delayMs: number): void {
  const previous = claudeSessionIdleTimers.get(key);
  if (previous !== undefined) clearTimeout(previous);
  const claudeIdleTimer = setTimeout(
    () => {
      if (claudeSessionIdleTimers.get(key) !== claudeIdleTimer) return;
      claudeSessionIdleTimers.delete(key);
      checkClaudeSessionIdleTimeoutSafely(key);
    },
    Math.max(0, delayMs),
  );
  claudeIdleTimer.unref?.();
  claudeSessionIdleTimers.set(key, claudeIdleTimer);
}

function claudeSessionBusyRecheckMs(): number {
  // Often enough that the idle period after a blocker clears is at least nine
  // tenths of the timeout.
  return Math.min(60_000, claudeSessionIdleTimeoutMs / 10);
}

// Retry spacing after a failed idle check; bounds its warnings per chat.
const CLAUDE_SESSION_FAILED_IDLE_CHECK_RETRY_MS = 60_000;

/** A check that throws counts as busy, so the watch continues. */
function checkClaudeSessionIdleTimeoutSafely(key: string): void {
  try {
    checkClaudeSessionIdleTimeout(key);
  } catch (error) {
    logMainProcessWarn(
      `[session-manager] Idle check failed for Claude session ${key}`,
      error,
    );
    if (!sessionRunsClaudeCli(sessions.get(key))) return;
    claudeSessionBusySeenAt.set(key, Date.now());
    armClaudeSessionIdleTimer(key, CLAUDE_SESSION_FAILED_IDLE_CHECK_RETRY_MS);
  }
}

function checkClaudeSessionIdleTimeout(key: string): void {
  const entry = sessions.get(key);
  // Re-read on every check: the harness can be stamped after registration.
  if (!sessionRunsClaudeCli(entry)) {
    claudeSessionBusySeenAt.delete(key);
    return;
  }
  const now = Date.now();
  if (claudeSessionIdleReleaseBlocked(key, entry)) {
    claudeSessionBusySeenAt.set(key, now);
    armClaudeSessionIdleTimer(key, claudeSessionBusyRecheckMs());
    return;
  }
  const remainingMs =
    claudeSessionIdleSince(key, entry) + claudeSessionIdleTimeoutMs - now;
  if (remainingMs > 0) {
    armClaudeSessionIdleTimer(key, remainingMs);
    return;
  }
  requestIdleClaudeSessionRelease(key, entry, 'timeout');
  // A release that activity or the chat call off waits for another idle
  // period.
  armClaudeSessionIdleTimer(key, claudeSessionIdleTimeoutMs);
}

function claudeSessionIdleSince(key: string, entry: ActiveSession): number {
  return Math.max(entry.lastActivityAt, claudeSessionBusySeenAt.get(key) ?? 0);
}

/**
 * The session can start a turn on its own (which covers steering input in
 * flight), or already has a pending release (an archived chat's, which stays
 * in charge).
 */
function claudeSessionIdleReleaseBlocked(
  key: string,
  entry: ActiveSession,
): boolean {
  return (
    idleSessionReleases.has(key) || sessionCanStartTurnOnItsOwn(key, entry)
  );
}

/**
 * Confirm callbacks of the pending releases the idle timeout requested, which
 * a timeout change withdraws and measures again. Memory pressure and
 * archived-chat releases are not in it.
 */
const claudeIdleTimeoutReleaseConfirms = new WeakSet<
  () => Promise<IdleChatSessionReleaseDecision>
>();

/**
 * Hand an idle Claude session to {@link releaseChatSessionWhenIdle} unless
 * {@link claudeSessionIdleReleaseBlocked}. Memory pressure instead takes over
 * a pending timeout release of an idle session, so a timeout change no longer
 * withdraws it. True when a release was requested or taken over.
 */
function requestIdleClaudeSessionRelease(
  key: string,
  entry: ActiveSession,
  trigger: 'timeout' | 'memory_pressure',
): boolean {
  const pending = idleSessionReleases.get(key);
  if (
    trigger === 'memory_pressure' &&
    pending !== undefined &&
    claudeIdleTimeoutReleaseConfirms.has(pending.confirm) &&
    !sessionCanStartTurnOnItsOwn(key, entry)
  ) {
    claudeIdleTimeoutReleaseConfirms.delete(pending.confirm);
    return true;
  }
  if (claudeSessionIdleReleaseBlocked(key, entry)) return false;
  let target: ReturnType<typeof parseSessionKey>;
  try {
    target = parseSessionKey(key);
  } catch {
    return false;
  }
  const activityAt = entry.lastActivityAt;
  const confirm = (): Promise<IdleChatSessionReleaseDecision> =>
    confirmIdleClaudeSessionRelease(target, activityAt);
  if (trigger === 'timeout') claudeIdleTimeoutReleaseConfirms.add(confirm);
  releaseChatSessionWhenIdle(target, confirm);
  return idleSessionReleases.has(key);
}

function cancelPendingClaudeIdleTimeoutRelease(key: string): void {
  const pending = idleSessionReleases.get(key);
  if (pending && claudeIdleTimeoutReleaseConfirms.has(pending.confirm)) {
    cancelIdleSessionRelease(key);
  }
}

async function confirmIdleClaudeSessionRelease(
  target: ReturnType<typeof parseSessionKey>,
  activityAt: number,
): Promise<IdleChatSessionReleaseDecision> {
  // Lazy by design: the reload coordinator's catalog reaches the skill and
  // plugin services. Loaded first so the checks below run with no await
  // before the release.
  const { deferredToolsReloadCoordinator } =
    await import('../deferred-tools/reload-coordinator');
  const entry = sessions.get(
    sessionKey(target.projectId, target.worktreeId, target.chatId),
  );
  // Activity since the request starts a new idle period.
  if (entry?.lastActivityAt !== activityAt) return 'retain';
  if (entry.session.hasPendingSteeringInput?.() === true) return 'retain';
  if (deferredToolsReloadCoordinator.hasActiveReload(target)) return 'retain';
  return 'release';
}

/**
 * Applies to existing Claude-harness sessions, measured from their last
 * activity. A release the old timeout queued is measured again, so it is
 * requested anew only if the new timeout has also passed.
 */
export function updateClaudeSessionIdleTimeoutMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const timeoutMs = Math.round(minutes * 60_000);
  if (timeoutMs === claudeSessionIdleTimeoutMs) return;
  claudeSessionIdleTimeoutMs = timeoutMs;
  for (const key of Array.from(sessions.keys())) {
    cancelPendingClaudeIdleTimeoutRelease(key);
    checkClaudeSessionIdleTimeoutSafely(key);
  }
}

/**
 * Critical memory pressure: release idle sessions that run a `claude` CLI
 * ({@link sessionRunsClaudeCli}) now instead of at their idle timeout. Busy
 * sessions, and sessions active within the last
 * {@link IDLE_SESSION_RELEASE_ACTIVE_SETTLE_MS} (a provider continuation may
 * still be on its way), are untouched; the next sweep reconsiders them.
 * Returns how many releases were requested; each completes after the
 * release's quiet period unless activity resumes first.
 */
export function releaseIdleClaudeSessionsForMemoryPressure(): number {
  const quietSince = Date.now() - IDLE_SESSION_RELEASE_ACTIVE_SETTLE_MS;
  let requested = 0;
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (
      !sessionRunsClaudeCli(entry) ||
      claudeSessionIdleSince(key, entry) > quietSince
    ) {
      continue;
    }
    try {
      if (requestIdleClaudeSessionRelease(key, entry, 'memory_pressure')) {
        requested += 1;
      }
    } catch (error) {
      // Keep this session; the rest of the sweep still runs.
      logMainProcessWarn(
        `[session-manager] Memory pressure release check failed for ${key}`,
        error,
      );
    }
  }
  return requested;
}

export async function invalidateProviderAuthSessions(
  providerType: Extract<AgentProviderType, 'claude' | 'codex'>,
  reason: string,
  options: {
    /**
     * Passive status probes preserve in-flight/queued work and mark those
     * sessions for recreation at the next turn boundary. Explicit user auth
     * actions may interrupt immediately.
     */
    activeTurnPolicy?: 'interrupt' | 'preserve';
    /**
     * Also preserve sessions whose turn is still being prepared. Only for a
     * passive account-identity confirmation: a routing or policy change must
     * not let a not-yet-sent prompt leave on the retired route.
     */
    preservePreparingTurns?: boolean;
  } = {},
): Promise<void> {
  providerSessionAuthGenerations.set(
    providerType,
    getProviderSessionAuthGeneration(providerType) + 1,
  );
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (entry.providerType === providerType) {
      notifySteeringEligibilityChanged(key);
    }
  }
  if (options.activeTurnPolicy !== 'preserve')
    providerAuthGenerations.set(
      providerType,
      getProviderAuthGeneration(providerType) + 1,
    );
  if (options.activeTurnPolicy !== 'preserve' && hasDelegationLifecycle()) {
    try {
      await revokeDelegationLifecycle(providerType);
    } catch (error) {
      logMainProcessWarn(
        `[invalidateProviderAuthSessions:${providerType}:${reason}] Delegation revocation failed; continuing provider session invalidation`,
        error,
      );
    }
  }

  const toDestroy: { key: string; entry: ActiveSession }[] = [];
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (entry.providerType !== providerType) {
      continue;
    }
    const hasActiveWork =
      hasActiveTurnOrNativeBackgroundWork(entry) ||
      (options.preservePreparingTurns === true && preparingTurnCounts.has(key));
    if (options.activeTurnPolicy === 'preserve' && hasActiveWork) {
      markSessionEntryForNextTurnRecreation(key, entry, 'account');
      continue;
    }
    toDestroy.push({ key, entry });
  }

  for (const { key, entry } of toDestroy) {
    await destroySessionEntry(
      key,
      entry,
      `invalidateProviderAuthSessions:${providerType}:${reason}`,
    );
  }
}

export async function invalidateSessionsForOrganizations(
  organizationIds: readonly string[] | 'all-org-owned',
  reason: string,
  options: {
    activeTurnPolicy?: 'interrupt' | 'preserve';
    personalOrganizationIds?: readonly string[];
  } = {},
): Promise<void> {
  const normalizedOrganizationIds =
    organizationIds === 'all-org-owned'
      ? organizationIds
      : new Set(organizationIds.map((id) => id.toLowerCase()));
  const toDestroy: { key: string; entry: ActiveSession }[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    const [projectId, worktreeId, chatId] = key.split('/');
    // Map through the enforcement owner, as the gates do: with org projects
    // off every session reads as Personal but is governed by the union, so
    // it must be retired like an unknown owner.
    const owner = resolveEnforcementOwner(
      projectId && worktreeId && chatId
        ? await peekSessionWorkOwner({ projectId, worktreeId, chatId })
        : undefined,
    );
    const personalAffected =
      owner?.kind === 'personal' &&
      (options.personalOrganizationIds?.some(
        (id) =>
          normalizedOrganizationIds === 'all-org-owned' ||
          normalizedOrganizationIds.has(id.toLowerCase()),
      ) ??
        false);
    const affected =
      personalAffected ||
      owner === undefined ||
      (owner.kind === 'organization' &&
        (normalizedOrganizationIds === 'all-org-owned' ||
          normalizedOrganizationIds.has(owner.organizationId.toLowerCase())));
    if (!affected) continue;

    const hasActiveWork = hasActiveTurnOrNativeBackgroundWork(entry);
    if (options.activeTurnPolicy === 'preserve' && hasActiveWork) {
      markSessionEntryForNextTurnRecreation(key, entry, 'organization');
      continue;
    }
    toDestroy.push({ key, entry });
  }

  for (const { key, entry } of toDestroy) {
    await destroySessionEntry(
      key,
      entry,
      `invalidateSessionsForOrganizations:${reason}`,
    );
  }
}

/**
 * Raised when a stop request names a chat whose provider session (or whose
 * provider query) is already gone. Callers treat this as "the task is already
 * dead" and reconcile the activity card rather than surfacing a failure.
 */
export class SessionUnavailableForTaskStopError extends Error {
  constructor(message = 'No active session is available to stop that task') {
    super(message);
    this.name = 'SessionUnavailableForTaskStopError';
  }
}

export function isSessionUnavailableForTaskStopError(error: unknown): boolean {
  return (
    error instanceof SessionUnavailableForTaskStopError ||
    (error instanceof Error &&
      error.name === 'SessionUnavailableForTaskStopError')
  );
}

/**
 * `'already-finished'` means the provider accepted the request but reported the
 * task was not running, so no terminal notification will ever arrive for it.
 */
export type StopBackgroundTaskOutcome = 'stopped' | 'already-finished';

interface E2eStopTaskRequest {
  projectId: string;
  worktreeId: string;
  chatId: string;
  taskId: string;
}

function isE2eStopTaskRequestList(
  value: unknown,
): value is E2eStopTaskRequest[] {
  return (
    Array.isArray(value) &&
    value.every(
      (request: unknown) =>
        isPlainRecord(request) &&
        typeof request.projectId === 'string' &&
        typeof request.worktreeId === 'string' &&
        typeof request.chatId === 'string' &&
        typeof request.taskId === 'string',
    )
  );
}

function recordE2eStopTaskRequest(request: E2eStopTaskRequest): void {
  const globalKey = '__CANOPY_E2E_STOP_TASK_REQUESTS__';
  const existing: unknown = Reflect.get(globalThis, globalKey);
  if (isE2eStopTaskRequestList(existing)) {
    existing.push(request);
    return;
  }
  Reflect.set(globalThis, globalKey, [request]);
}

/**
 * The context-window breakdown for a live chat. Only Claude sessions report
 * categories; other harnesses and chats without a live session resolve
 * `null`, and the composer falls back to the plain meter.
 */
export async function getContextUsageForSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<ChatContextUsageBreakdown | null> {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (
    !entry ||
    entry.executionHarness === 'codex' ||
    entry.executionHarness === 'cursor'
  ) {
    return null;
  }
  const { getContextUsageForClaudeSession } = await import('./claude-session');
  return getContextUsageForClaudeSession(projectId, worktreeId, chatId);
}

export async function stopTaskForSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  taskId: string,
): Promise<StopBackgroundTaskOutcome> {
  const key = sessionKey(projectId, worktreeId, chatId);
  const entry = sessions.get(key);
  if (!entry) {
    if (isE2eBuild()) {
      const e2eOwner = e2eIngestedLiveBackgroundTasks.get(key);
      if (e2eOwner?.liveBackgroundTasks.has(taskId)) {
        recordE2eStopTaskRequest({ projectId, worktreeId, chatId, taskId });
        return 'stopped';
      }
    }
    throw new SessionUnavailableForTaskStopError();
  }

  if (entry.executionHarness === 'codex') {
    throw new Error(
      'Stopping individual tasks is not supported for Codex sessions',
    );
  }

  const { stopTaskForClaudeSession } = await import('./claude-session');
  const outcome = await stopTaskForClaudeSession(
    projectId,
    worktreeId,
    chatId,
    taskId,
  );
  if (outcome === 'already-finished') {
    const wasBackgroundBusy = hasBusyBackgroundWork(entry);
    const liveTaskRemoved = entry.liveBackgroundTasks.delete(taskId);
    entry.activeBackgroundTaskIds.delete(taskId);
    if (liveTaskRemoved) {
      notifyLiveBackgroundTasksListeners(
        sessionKey(projectId, worktreeId, chatId),
      );
    }
    syncChatWake(sessionKey(projectId, worktreeId, chatId));
    if (wasBackgroundBusy !== hasBusyBackgroundWork(entry)) {
      notifyChatSessionActivityListeners();
    }
  }
  return outcome;
}

/**
 * A registration found another live instance under its key, which would
 * otherwise keep running, and keep its CLI, with nothing tracking it. Detach
 * and destroy it before the new entry exists, so the synchronous part of its
 * teardown still owns the key. Key-scoped output pollers and observability
 * entries pass to the successor and are left alone.
 */
function tearDownDisplacedSession(key: string, displaced: ActiveSession): void {
  logMainProcessWarn(
    `[session-manager] Registration displaced a live session for ${key}; destroying it`,
  );
  const finishRemoval = detachSessionForTeardown(key, displaced);
  // Now, not once destroy() settles: that waits for the old query loop to
  // exit, and nothing updates a detached entry's tasks meanwhile.
  notifySessionEndedBackgroundTasks(key, displaced);
  rejectAllForSession(key);
  let destroyed: Promise<void>;
  try {
    destroyed = displaced.session.destroy();
  } catch (error: unknown) {
    destroyed = Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  void destroyed
    .catch((error: unknown) => {
      logMainProcessWarn(
        `[session-manager] Failed to destroy displaced session ${key}`,
        error,
      );
    })
    .finally(finishRemoval);
}

/**
 * Register an active session. Called by providers when creating a session.
 * A live entry under the same key is torn down, never silently overwritten.
 */
export function registerSession(
  key: string,
  session: AgentSession,
  abortController: AbortController,
  providerType: AgentProviderType,
  model?: ChatModel,
  assistantMode: AssistantMode = 'default',
  toolProfileHash = 'default',
  codeGraphToolsAdvertised = false,
  executionHarness?: AgentSessionOptions['executionHarness'],
): void {
  const previous = sessions.get(key);
  if (previous) markSessionTeardownCause(key, 'recycle');
  if (previous && previous.session !== session) {
    tearDownDisplacedSession(key, previous);
  } else if (previous) {
    notifySessionEndedBackgroundTasks(key, previous);
  }
  const now = Date.now();
  sessions.set(key, {
    session,
    abortController,
    providerType,
    executionHarness:
      executionHarness ??
      (model ? getExecutionHarnessForModel(model) : undefined) ??
      (providerType === 'codex' ? 'codex' : 'claude'),
    workOwnerKey: 'unknown',
    authGeneration: getProviderSessionAuthGeneration(providerType),
    ...(model ? { model } : {}),
    selectedModel: model,
    pluginSelectionsSignature: 'null',
    deferredToolsAllowed: true,
    // Defaults to native; getOrCreateSession stamps the resolved signature
    // right after the provider registers the session.
    aiCreditsRoutingSignature: 'native',
    recreateOnNextTurn: false,
    turnActive: false,
    activeUserMessageId: undefined,
    cancelRequestedUserMessageId: undefined,
    createdAt: now,
    lastActivityAt: now,
    turnElapsedBeforeCurrentSegmentMs: 0,
    turnCount: 0,
    pendingMessageCount: 0,
    activeBackgroundTaskIds: new Set<string>(),
    continuationToolUseIds: new Set<string>(),
    nonBusyBackgroundToolUseIds: new Set<string>(),
    liveBackgroundTasks: new Map<string, LiveBackgroundTask>(),
    codexBackgroundTaskIds: new Set<string>(),
    foregroundTaskMetadata: new Map<string, LiveBackgroundTask>(),
    unknownTaskTypesLogged: new Set<string>(),
    claudeNativeSubagentTasks: new Map<string, ClaudeNativeSubagentTask>(),
    claudeSessionCrons: {
      unconfirmedToolUseIds: new Set<string>(),
      confirmedToolUseIds: new Set<string>(),
      scheduledCount: 0,
      listUnreadable: false,
    },
    codexNativeSubagentThreadIds: new Set<string>(),
    codexNativeSubagentTurns: new Map<string, string>(),
    codexLiveNativeSubagentTurns: new Map<string, string>(),
    assistantMode,
    toolProfileHash,
    codeGraphToolsAdvertised,
  });
  // A replaced session's work no longer counts; canonical owners still do.
  syncChatWake(key);
  if (previous || e2eIngestedLiveBackgroundTasks.has(key)) {
    notifyLiveBackgroundTasksListeners(key);
  }
  notifySteeringEligibilityChanged(key);
  const entry = sessions.get(key);
  if (entry) {
    recordSessionDiagnostic(key, entry, {
      kind: 'session_registered',
    });
  }
  if (sessionRunsClaudeCli(entry)) startClaudeSessionIdleWatch(key);
  else clearClaudeSessionIdleState(key);
  notifyChatSessionActivityListeners();
}

export function getSessionCodeGraphToolsAdvertised(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.codeGraphToolsAdvertised;
}

export function getSessionGlobalInstructionsSnapshot(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.globalInstructionsSnapshot;
}

// Entry mutators below update in place: the entry object is the registration
// identity that teardowns and successor checks compare (CAN-4833).

/** Capture the settings overlay for an active provider session. */
export function setSessionTurnSettings(
  projectId: string,
  worktreeId: string,
  chatId: string,
  settings: SessionTurnSettings,
): void {
  const key = sessionKey(projectId, worktreeId, chatId);
  const entry = sessions.get(key);
  if (!entry) return;
  entry.turnSettings = cloneSessionTurnSettings(settings);
}

/** Read a defensive copy of the active session's captured turn settings. */
export function getSessionTurnSettings(
  projectId: string,
  worktreeId: string,
  chatId: string,
): SessionTurnSettings | undefined {
  const settings = sessions.get(
    sessionKey(projectId, worktreeId, chatId),
  )?.turnSettings;
  return settings ? cloneSessionTurnSettings(settings) : undefined;
}

function updateSessionTurnSettingsModelByKey(
  key: string,
  model: ChatModel,
): void {
  const entry = sessions.get(key);
  if (!entry?.turnSettings) return;
  entry.turnSettings = cloneSessionTurnSettings({
    ...entry.turnSettings,
    model,
  });
}

/** Update the model in an active session's captured settings overlay. */
export function updateSessionTurnSettingsModel(
  projectId: string,
  worktreeId: string,
  chatId: string,
  model: ChatModel,
): void {
  updateSessionTurnSettingsModelByKey(
    sessionKey(projectId, worktreeId, chatId),
    model,
  );
}

export function updateSessionModel(key: string, model: ChatModel): void {
  if (!sessions.has(key)) return;

  updateSessionTurnSettingsModelByKey(key, model);
  const entry = sessions.get(key);
  if (!entry) return;

  entry.model = model;
  entry.selectedModel = model;
  notifySteeringEligibilityChanged(key);
}

export function getSessionSelectedModel(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ChatModel | undefined {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  return entry?.selectedModel ?? entry?.reportedModel;
}

export function markSessionForNextTurnRecreation(
  projectId: string,
  worktreeId: string,
  chatId: string,
  reason: SessionRecreateReason = 'unspecified',
): void {
  const key = sessionKey(projectId, worktreeId, chatId);
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }

  markSessionEntryForNextTurnRecreation(key, entry, reason);
}

function markSessionEntryForNextTurnRecreation(
  key: string,
  entry: ActiveSession,
  reason: SessionRecreateReason,
): void {
  const recreateReasons = new Set(entry.recreateReasons ?? []);
  recreateReasons.add(reason);
  entry.recreateOnNextTurn = true;
  entry.recreateReasons = recreateReasons;
  notifySteeringEligibilityChanged(key);
}

/** Refresh both parent harnesses at the next turn boundary, without interrupting root work. */
export function markManagedDelegationSessionsForNextTurnRecreation(
  nextMode: AgentSessionOptions['managedDelegationMode'],
): void {
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (
      entry.managedDelegationSurface === 'worktree-chat' &&
      !managedDelegationModesShareProviderSession(
        entry.managedDelegationMode,
        nextMode,
      )
    ) {
      markSessionEntryForNextTurnRecreation(key, entry, 'managed_delegation');
    }
  }
}

export type CodexChatScope = 'worktree' | 'standalone' | 'app-advisor' | 'all';

export function markCodexSessionsForNextTurnRecreation(
  scope: CodexChatScope,
): void {
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (entry.executionHarness !== 'codex') {
      continue;
    }

    const { projectId } = parseSessionKey(key);
    const sessionScope =
      projectId === APP_ADVISOR_PROJECT_ID
        ? 'app-advisor'
        : isCoworkWorkspace(projectId)
          ? 'standalone'
          : 'worktree';
    if (scope !== 'all' && scope !== sessionScope) continue;

    markSessionEntryForNextTurnRecreation(key, entry, 'codex_preferences');
  }
}

/**
 * Reload Claude sessions at their next turn after a Mod admission change, so
 * the relaunch decides admission again. `skipped` reaches only sessions whose
 * launch skipped a Mod; a change that can turn a Mod off reaches every one.
 */
export function markClaudeSessionsForModAdmissionChange(
  scope: 'skipped' | 'all',
): void {
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (entry.executionHarness !== 'claude') continue;
    if (!shouldReloadForClaudeModChange(key, scope)) continue;
    markSessionEntryForNextTurnRecreation(key, entry, 'claude_mods');
  }
}

export function shouldRecreateSessionOnNextTurn(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return Boolean(
    sessions.get(sessionKey(projectId, worktreeId, chatId))?.recreateOnNextTurn,
  );
}

/** Why the live session is marked for recreation; empty when it is not. */
export function getSessionRecreateReasons(
  projectId: string,
  worktreeId: string,
  chatId: string,
): readonly SessionRecreateReason[] {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (!entry?.recreateOnNextTurn) return [];
  const reasons = Array.from(entry.recreateReasons ?? []);
  return reasons.length > 0 ? reasons : ['unspecified'];
}

/**
 * Whether the chat's provider process owns live native background work that a
 * session restart would stop: any live provider task (ambient tasks are never
 * recorded) or busy background tool use. Managed delegations never count;
 * they survive a recycle.
 */
export function chatHasNativeBackgroundWork(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  return (
    entry !== undefined &&
    (entry.liveBackgroundTasks.size > 0 || hasBusyBackgroundWork(entry))
  );
}

/** A settings setter must not patch or replace this session right now. */
export function sessionHasActiveTurnOrNativeWork(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  return entry !== undefined && hasActiveTurnOrNativeBackgroundWork(entry);
}

function warnCodexIdleTimeoutPropagationFailure(
  detail: string,
  error: unknown,
): void {
  const warning = error instanceof Error ? error : String(error);
  process.emitWarning(warning, {
    type: 'CanopyWarning',
    code: 'CANOPY_CODEX_IDLE_TIMEOUT_PROPAGATION_FAILED',
    detail,
  });
}

export function updateCodexSessionIdleTimeoutMinutes(minutes: number): void {
  for (const entry of Array.from(sessions.values())) {
    if (entry.executionHarness !== 'codex') {
      continue;
    }

    try {
      const updatePromise =
        entry.session.setCodexAppServerIdleTimeoutMinutes?.(minutes);
      if (updatePromise) {
        void updatePromise.catch((error: unknown) => {
          warnCodexIdleTimeoutPropagationFailure(
            'Codex idle-timeout propagation rejected asynchronously.',
            error,
          );
        });
      }
    } catch (error: unknown) {
      // Keep updating remaining Codex sessions if one session rejects
      // synchronously.
      warnCodexIdleTimeoutPropagationFailure(
        'Codex idle-timeout propagation threw synchronously.',
        error,
      );
    }
  }
}

/** Mark a session as actively processing a turn (called when a message is dequeued). */
export function markTurnActive(key: string, userMessageId?: string): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }
  const [projectId, worktreeId] = key.split('/', 2);
  if (projectId && worktreeId) {
    assertWorkspaceTargetRuntimeStartAllowed(projectId, worktreeId);
  }

  const now = Date.now();
  const wasTurnActive = entry.turnActive;
  if (!entry.turnActive) {
    entry.turnElapsedBeforeCurrentSegmentMs = 0;
    entry.turnStartedAt = now;
    entry.turnCount += 1;
  }
  entry.turnActive = true;
  entry.activeUserMessageId = userMessageId;
  if (userMessageId !== undefined) applyPendingTurnCancel(key, userMessageId);
  entry.codexContinuationRevivalTurn = undefined;
  entry.lastActivityAt = now;
  entry.pendingMessageCount = Math.max(0, entry.pendingMessageCount - 1);
  releaseHandedOffTurnPreparations(key, 'next');
  if (!wasTurnActive) {
    recordSessionDiagnostic(key, entry, {
      kind: 'turn_active',
    });
    notifyChatSessionActivityListeners();
  }
  syncChatWake(key);
}

function markTurnIdleState(
  key: string,
  continuationRevivalAllowed: boolean,
): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }

  const wasTurnActive = entry.turnActive;
  const hadPendingMessages = entry.pendingMessageCount > 0;
  entry.turnActive = false;
  // Awaiting user input is a temporary idle segment of the same message, so
  // preserve its identity until a provider continuation or terminal idle.
  if (!continuationRevivalAllowed) {
    entry.activeUserMessageId = undefined;
    entry.cancelRequestedUserMessageId = undefined;
  }
  entry.codexContinuationRevivalTurn =
    continuationRevivalAllowed &&
    entry.executionHarness === 'codex' &&
    entry.codexRootThreadId &&
    entry.codexRootTurnId
      ? {
          threadId: entry.codexRootThreadId,
          turnId: entry.codexRootTurnId,
        }
      : undefined;
  const now = Date.now();
  if (wasTurnActive && entry.turnStartedAt !== undefined) {
    entry.turnElapsedBeforeCurrentSegmentMs += Math.max(
      0,
      now - entry.turnStartedAt,
    );
  }
  entry.lastActivityAt = now;
  entry.turnStartedAt = undefined;
  entry.pendingMessageCount = 0;
  if (wasTurnActive) {
    recordSessionDiagnostic(key, entry, {
      kind: 'turn_idle',
    });
  }
  if (wasTurnActive || hadPendingMessages) {
    notifyChatSessionActivityListeners();
  }
  syncChatWake(key);
}

function markProviderOwnedRunActive(
  key: string,
  entry: ActiveSession,
): boolean {
  if (entry.turnActive) return false;
  const now = Date.now();
  entry.turnActive = true;
  entry.codexContinuationRevivalTurn = undefined;
  entry.turnStartedAt = now;
  entry.turnCount += 1;
  entry.lastActivityAt = now;
  recordSessionDiagnostic(key, entry, { kind: 'turn_active' });
  syncChatWake(key);
  return true;
}

function markProviderOwnedRunIdle(key: string, entry: ActiveSession): boolean {
  const wasTurnActive = entry.turnActive;
  if (!wasTurnActive) return false;
  const now = Date.now();
  entry.turnActive = false;
  entry.codexContinuationRevivalTurn = undefined;
  if (entry.turnStartedAt !== undefined) {
    entry.turnElapsedBeforeCurrentSegmentMs += Math.max(
      0,
      now - entry.turnStartedAt,
    );
  }
  entry.lastActivityAt = now;
  entry.turnStartedAt = undefined;
  // A provider-owned run does not consume or clear messages queued for the
  // ordinary send loop.
  recordSessionDiagnostic(key, entry, { kind: 'turn_idle' });
  syncChatWake(key);
  return true;
}

function isProviderOwnedStartEvent(
  data: unknown,
  descriptor: ProviderRunDescriptor,
): boolean {
  if (!isPlainRecord(data) || data.type !== 'codex') return false;
  const event = isPlainRecord(data.event) ? data.event : undefined;
  return (
    event?.type === 'turn.started' &&
    readRecordString(event, 'thread_id') === descriptor.threadId &&
    readRecordString(event, 'turn_id') === descriptor.turnId
  );
}

function isProviderOwnedTerminalEvent(
  data: unknown,
  descriptor: ProviderRunDescriptor,
): boolean {
  if (!isPlainRecord(data) || data.type !== 'codex') return false;
  const event = isPlainRecord(data.event) ? data.event : undefined;
  return (
    (event?.type === 'turn.completed' ||
      event?.type === 'turn.failed' ||
      event?.type === 'error') &&
    readRecordString(event, 'thread_id') === descriptor.threadId &&
    readRecordString(event, 'turn_id') === descriptor.turnId
  );
}

/**
 * The user message that owns the chat's provider turn (D14). Canonical turn
 * state decides once it owns root turns: its receipt-time `current` stays
 * current while the turn pauses for user input, and a turn it ended is never
 * stopped. The session's dequeue record answers only when canonical state has
 * no turn for the chat, or has not yet bound its turn to a prompt: OpenCode
 * publishes no lifecycle, a provider can mark a dequeued turn active before
 * its TurnStarted (Codex's turn.started), and a native Claude turn binds only
 * when the provider echoes its prompt.
 */
function providerTurnUserMessageId(
  key: string,
  entry: ActiveSession,
): string | undefined {
  const ownership = getChatTurnOwnership();
  const [projectId, worktreeId, ...chatIdParts] = key.split('/');
  const canonical =
    ownership.isBound() && projectId && worktreeId
      ? ownership.getSnapshot({
          projectId,
          worktreeId,
          chatId: chatIdParts.join('/'),
        }).receipt?.state
      : undefined;
  if (canonical?.current?.userMessageId !== undefined)
    return canonical.current.userMessageId;
  return canonical?.lastEnded?.userMessageId === entry.activeUserMessageId
    ? undefined
    : entry.activeUserMessageId;
}

/**
 * Request cancellation only when the requested user message owns the
 * provider turn, including while that turn is paused for user input. The
 * provider is notified synchronously; completion remains owned by its normal
 * terminal-event path.
 */
export function cancelActiveChatTurn(
  key: string,
  userMessageId: string,
): boolean {
  const entry = sessions.get(key);
  if (!entry || providerTurnUserMessageId(key, entry) !== userMessageId) {
    return false;
  }
  pendingTurnCancels.get(key)?.delete(userMessageId);
  if (entry.cancelRequestedUserMessageId === userMessageId) {
    return true;
  }

  entry.cancelRequestedUserMessageId = userMessageId;
  // Claude-compatible providers stop by aborting the session-wide query, as
  // the chat Stop does; the next turn must start a fresh session.
  if (entry.providerType === 'claude' || entry.providerType === 'ollama') {
    entry.recreateOnNextTurn = true;
  }
  try {
    const cancellation = entry.session.cancel();
    void cancellation.catch(() => {
      if (
        sessions.get(key) === entry &&
        entry.cancelRequestedUserMessageId === userMessageId
      ) {
        entry.cancelRequestedUserMessageId = undefined;
      }
    });
  } catch (error: unknown) {
    entry.cancelRequestedUserMessageId = undefined;
    throw error;
  }
  return true;
}

/**
 * Exact-turn stops requested before the provider marked their turn active,
 * by session key. Each applies only to its own user message.
 */
const pendingTurnCancels = new Map<string, Set<string>>();

/**
 * Stop the named turn now if it owns the provider turn, or as soon as the
 * provider marks it active. It never stops any other turn.
 */
export function requestChatTurnCancel(
  key: string,
  userMessageId: string,
): void {
  if (cancelActiveChatTurn(key, userMessageId)) return;
  const pending = pendingTurnCancels.get(key) ?? new Set<string>();
  pending.add(userMessageId);
  pendingTurnCancels.set(key, pending);
}

/**
 * Apply a pending exact-turn stop when its turn starts: at the provider's
 * dequeue or its canonical TurnStarted, whichever makes it the owner first.
 * It stays pending until it applies, and it runs after the caller returns.
 */
function applyPendingTurnCancel(key: string, userMessageId: string): void {
  if (!pendingTurnCancels.get(key)?.has(userMessageId)) return;
  void Promise.resolve()
    .then(() => cancelActiveChatTurn(key, userMessageId))
    .catch(() => undefined);
}

/** Mark a session as idle between turns (called when a result/error event is emitted). */
export function markTurnIdle(key: string): void {
  markTurnIdleState(key, false);
}

/**
 * Mark a turn as temporarily idle while it awaits user input. A subsequent
 * provider continuation event may revive this same turn.
 */
export function markTurnAwaitingUser(key: string): void {
  markTurnIdleState(key, true);
}

export function markChatSessionIdle(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  markTurnIdle(sessionKey(projectId, worktreeId, chatId));
}

export function noteSessionMessageQueued(
  key: string,
  pendingMessageCount: number,
): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }

  const previousPendingMessageCount = entry.pendingMessageCount;
  if (pendingMessageCount > previousPendingMessageCount) {
    const [projectId, worktreeId] = key.split('/', 2);
    if (projectId && worktreeId) {
      assertWorkspaceTargetRuntimeStartAllowed(projectId, worktreeId);
    }
  }
  entry.pendingMessageCount = pendingMessageCount;
  entry.lastActivityAt = Date.now();
  if (pendingMessageCount > previousPendingMessageCount) {
    recordSessionDiagnostic(key, entry, {
      kind: 'message_queued',
    });
    notifyChatSessionActivityListeners();
  }
  syncChatWake(key);
}

export function recordSessionEvent(key: string, data: unknown): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }

  const [projectId, worktreeId, ...chatIdParts] = key.split('/');
  const chatId = chatIdParts.join('/');
  const classification = classifyProviderRunEvent(data, {
    projectId: projectId ?? '',
    worktreeId: worktreeId ?? '',
    chatId,
  });
  if (
    classification.kind === 'reject' ||
    classification.kind === 'transcript_only'
  ) {
    return;
  }
  const descriptor =
    classification.kind === 'ordinary' ? classification.run : undefined;
  const providerOwnedTerminal =
    descriptor?.origin === 'provider_owned' &&
    isProviderOwnedTerminalEvent(data, descriptor);
  if (
    providerOwnedTerminal &&
    (entry.codexRootThreadId !== descriptor.threadId ||
      entry.codexRootTurnId !== descriptor.turnId)
  ) {
    // An authenticated terminal can still be stale relative to this session's
    // current owner. Do not let it replace identity or idle a newer run.
    return;
  }

  entry.lastActivityAt = Date.now();
  entry.lastEventType = describeChatEventData(data, {
    includePhaseEvents: true,
  });
  if (
    entry.providerType === 'claude' &&
    entry.model === undefined &&
    entry.reportedModel === undefined
  ) {
    const event = isPlainRecord(data) ? data : undefined;
    const message =
      event && isPlainRecord(event.message) ? event.message : undefined;
    const reportedModel = message
      ? resolveKnownModel(readRecordString(message, 'model') ?? '')
      : undefined;
    if (reportedModel) {
      entry.reportedModel = reportedModel;
    }
  }
  updateCodexRootTurnIdentity(entry, data);
  const wasBackgroundBusy = hasBusyBackgroundWork(entry);
  updateNativeSubagentCorrelation(entry, data);
  updateClaudeSessionCronToolUses(entry, data);
  const backgroundTaskActivityChanged = updateBackgroundTaskState(entry, data);
  const liveBackgroundTasksChanged = updateLiveBackgroundTaskState(entry, data);
  if (liveBackgroundTasksChanged) notifyLiveBackgroundTasksListeners(key);
  const providerBackgroundBusyChanged =
    wasBackgroundBusy !== hasBusyBackgroundWork(entry);
  const providerOwnedStart =
    descriptor?.origin === 'provider_owned' &&
    isProviderOwnedStartEvent(data, descriptor);
  const turnRevived = providerOwnedStart
    ? markProviderOwnedRunActive(key, entry)
    : providerOwnedTerminal
      ? markProviderOwnedRunIdle(key, entry)
      : reviveTurnForAgentContinuation(key, entry, data);
  if (
    turnRevived ||
    backgroundTaskActivityChanged ||
    providerBackgroundBusyChanged
  ) {
    notifyChatSessionActivityListeners();
  }
  syncChatWake(key);
  // Live-task and native-subagent sets change without an activity signal.
  // Phase markers are main's own bookkeeping, not provider output.
  evaluateIdleSessionRelease(key, {
    providerActivity: !(isPlainRecord(data) && data.type === 'phase'),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecordString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isTerminalTaskStatus(status: string | undefined): boolean {
  return (
    status === undefined ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'killed' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}

function reviveTurnForAgentContinuation(
  key: string,
  entry: ActiveSession,
  data: unknown,
): boolean {
  if (entry.turnActive || !isAgentContinuationEvent(data)) {
    return false;
  }
  // A backgrounded Claude subagent keeps streaming child frames after the
  // root result. The transcript never reopens a settled turn for them, so the
  // session must not report it live either (Portal `turnActive`).
  if (isPlainRecord(data) && typeof data.parent_tool_use_id === 'string') {
    return false;
  }
  if (entry.executionHarness === 'codex' && !canReviveCodexTurn(entry, data)) {
    return false;
  }

  // Keep the same message identity while a provider resumes a turn that was
  // temporarily idle for user input; only its terminal idle clears the ID.
  entry.turnActive = true;
  entry.codexContinuationRevivalTurn = undefined;
  entry.turnStartedAt = Date.now();
  entry.lastActivityAt = entry.turnStartedAt;
  recordSessionDiagnostic(key, entry, {
    kind: 'turn_active',
  });
  return true;
}

function readCodexEventIdentity(data: unknown): CodexTurnIdentity | undefined {
  if (!isPlainRecord(data) || data.type !== 'codex') {
    return undefined;
  }
  const event = isPlainRecord(data.event) ? data.event : undefined;
  if (!event) {
    return undefined;
  }
  const threadId = readRecordString(event, 'thread_id');
  const turnId = readRecordString(event, 'turn_id');
  return threadId && turnId ? { threadId, turnId } : undefined;
}

function updateCodexRootTurnIdentity(
  entry: ActiveSession,
  data: unknown,
): void {
  if (entry.executionHarness !== 'codex' || !isPlainRecord(data)) {
    return;
  }

  if (
    data.type === 'system' &&
    data.subtype === 'init' &&
    typeof data.session_id === 'string'
  ) {
    if (entry.codexRootThreadId !== data.session_id) {
      entry.codexNativeSubagentThreadIds.clear();
      entry.codexNativeSubagentTurns.clear();
    }
    // The client emits `init` only when it (re)establishes its thread: after
    // a new client or an app-server restart. Children of the earlier client
    // can no longer report a terminal event here.
    entry.codexLiveNativeSubagentTurns.clear();
    entry.codexRootThreadId = data.session_id;
    entry.codexRootTurnId = undefined;
    entry.codexContinuationRevivalTurn = undefined;
    return;
  }

  if (!isPlainRecord(data.event) || data.event.type !== 'turn.started') {
    return;
  }
  const identity = readCodexEventIdentity(data);
  if (identity && identity.threadId === entry.codexRootThreadId) {
    if (
      entry.codexRootTurnId !== undefined &&
      entry.codexRootTurnId !== identity.turnId
    ) {
      // Receiver ids belong to the root turn that announced them. Retire them
      // before accepting events from a later turn so stale UI ids cannot be
      // mistaken for a current child.
      entry.codexNativeSubagentThreadIds.clear();
      entry.codexNativeSubagentTurns.clear();
    }
    entry.codexRootTurnId = identity.turnId;
  }
}

function updateNativeSubagentCorrelation(
  entry: ActiveSession,
  data: unknown,
): void {
  if (entry.executionHarness === 'claude') {
    updateClaudeNativeSubagentTasks(entry, data);
    return;
  }
  if (entry.executionHarness === 'codex') {
    updateCodexNativeSubagentTurns(entry, data);
    updateCodexLiveNativeSubagentTurns(entry, data);
  }
}

const MAX_CLAUDE_NATIVE_SUBAGENT_TASKS = 256;

function updateClaudeNativeSubagentTasks(
  entry: ActiveSession,
  data: unknown,
): void {
  if (!isPlainRecord(data) || data.type !== 'system') return;
  const subtype = readRecordString(data, 'subtype');
  const taskId = readRecordString(data, 'task_id');
  if (!subtype || !taskId) return;

  if (subtype === 'task_started') {
    const toolUseId = readRecordString(data, 'tool_use_id');
    const taskType = readRecordString(data, 'task_type');
    const subagentType = readRecordString(data, 'subagent_type');
    // `task_type` is the provider's stable discriminant. Older SDKs may omit
    // it while still publishing `subagent_type`, which is specific to Task
    // tool subagents. Do not index Bash or other background tasks.
    if (
      !toolUseId ||
      (taskType !== 'local_agent' && subagentType === undefined)
    ) {
      return;
    }
    entry.claudeNativeSubagentTasks.delete(toolUseId);
    entry.claudeNativeSubagentTasks.set(toolUseId, {
      taskId,
      backgrounded: data.is_backgrounded === true,
    });
    while (
      entry.claudeNativeSubagentTasks.size > MAX_CLAUDE_NATIVE_SUBAGENT_TASKS
    ) {
      const oldestToolUseId = entry.claudeNativeSubagentTasks
        .keys()
        .next().value;
      if (typeof oldestToolUseId !== 'string') break;
      entry.claudeNativeSubagentTasks.delete(oldestToolUseId);
    }
    return;
  }

  if (subtype === 'task_notification') {
    if (isTerminalTaskStatus(readRecordString(data, 'status'))) {
      deleteClaudeNativeSubagentTaskByTaskId(entry, taskId);
    }
    return;
  }

  if (subtype !== 'task_updated' || !isPlainRecord(data.patch)) return;
  if (isTerminalTaskUpdatePatchStatus(readRecordString(data.patch, 'status'))) {
    deleteClaudeNativeSubagentTaskByTaskId(entry, taskId);
    return;
  }
  if (data.patch.is_backgrounded !== true) return;
  for (const task of Array.from(entry.claudeNativeSubagentTasks.values())) {
    if (task.taskId === taskId) task.backgrounded = true;
  }
}

function deleteClaudeNativeSubagentTaskByTaskId(
  entry: ActiveSession,
  taskId: string,
): void {
  for (const [toolUseId, task] of Array.from(entry.claudeNativeSubagentTasks)) {
    if (task.taskId === taskId) {
      entry.claudeNativeSubagentTasks.delete(toolUseId);
    }
  }
}

const MAX_CODEX_NATIVE_SUBAGENT_THREADS = 256;

function updateCodexNativeSubagentTurns(
  entry: ActiveSession,
  data: unknown,
): void {
  if (
    !isPlainRecord(data) ||
    data.type !== 'codex' ||
    !isPlainRecord(data.event)
  ) {
    return;
  }
  const event = data.event;
  const eventType = readRecordString(event, 'type');
  const threadId = readRecordString(event, 'thread_id');
  if (!eventType || !threadId) return;

  if (
    eventType === 'item.started' ||
    eventType === 'item.updated' ||
    eventType === 'item.completed'
  ) {
    if (
      threadId !== entry.codexRootThreadId ||
      readRecordString(event, 'turn_id') !== entry.codexRootTurnId ||
      !isPlainRecord(event.item)
    ) {
      return;
    }
    const item = event.item;
    const itemType = readRecordString(item, 'type');
    if (
      itemType === 'collab_agent_tool_call' ||
      itemType === 'collabAgentToolCall'
    ) {
      const receiverIds = readRecordStringArray(
        item.receiver_thread_ids ?? item.receiverThreadIds,
      );
      for (const receiverId of receiverIds) {
        if (eventType === 'item.completed') {
          retireCodexNativeSubagentThread(entry, receiverId);
        } else {
          rememberCodexNativeSubagentThread(entry, receiverId);
        }
      }
    } else if (
      itemType === 'sub_agent_activity' ||
      itemType === 'subAgentActivity'
    ) {
      const childId =
        readRecordString(item, 'agent_thread_id') ??
        readRecordString(item, 'agentThreadId');
      if (childId) {
        if (eventType === 'item.completed') {
          retireCodexNativeSubagentThread(entry, childId);
        } else {
          rememberCodexNativeSubagentThread(entry, childId);
        }
      }
    }
    return;
  }

  if (eventType === 'turn.started') {
    const turnId = readRecordString(event, 'turn_id');
    if (
      turnId &&
      threadId !== entry.codexRootThreadId &&
      entry.codexNativeSubagentThreadIds.has(threadId)
    ) {
      entry.codexNativeSubagentTurns.set(threadId, turnId);
    }
    return;
  }

  if (
    eventType === 'turn.completed' ||
    eventType === 'turn.failed' ||
    eventType === 'error'
  ) {
    const activeTurnId = entry.codexNativeSubagentTurns.get(threadId);
    const reportedTurnId = readRecordString(event, 'turn_id');
    if (
      entry.codexNativeSubagentThreadIds.has(threadId) &&
      (activeTurnId === undefined ||
        reportedTurnId === undefined ||
        reportedTurnId === activeTurnId)
    ) {
      retireCodexNativeSubagentThread(entry, threadId);
    }
    if (
      threadId === entry.codexRootThreadId &&
      (!reportedTurnId || reportedTurnId === entry.codexRootTurnId)
    ) {
      entry.codexNativeSubagentThreadIds.clear();
      entry.codexNativeSubagentTurns.clear();
    }
  }
}

/**
 * Track child turns for release liveness. The connection routes a child
 * thread's notifications only to the client that owns its root, so every
 * non-root turn on this session belongs to one of its children, whether or not
 * a receiver item correlated it.
 */
function updateCodexLiveNativeSubagentTurns(
  entry: ActiveSession,
  data: unknown,
): void {
  const rootThreadId = entry.codexRootThreadId;
  if (
    rootThreadId === undefined ||
    !isPlainRecord(data) ||
    data.type !== 'codex' ||
    !isPlainRecord(data.event)
  ) {
    return;
  }
  const event = data.event;
  const eventType = readRecordString(event, 'type');
  const threadId = readRecordString(event, 'thread_id');
  if (!eventType || !threadId || threadId === rootThreadId) return;
  const turnId = readRecordString(event, 'turn_id');

  if (eventType === 'turn.started') {
    // '' stands for a turn the provider did not name; any terminal event of
    // the thread ends it.
    entry.codexLiveNativeSubagentTurns.delete(threadId);
    entry.codexLiveNativeSubagentTurns.set(threadId, turnId ?? '');
    while (
      entry.codexLiveNativeSubagentTurns.size >
      MAX_CODEX_NATIVE_SUBAGENT_THREADS
    ) {
      const oldestThreadId = entry.codexLiveNativeSubagentTurns
        .keys()
        .next().value;
      if (typeof oldestThreadId !== 'string') break;
      entry.codexLiveNativeSubagentTurns.delete(oldestThreadId);
    }
    return;
  }

  // A non-retrying `error` can be a turn's only terminal signal (quota).
  if (
    eventType !== 'turn.completed' &&
    eventType !== 'turn.failed' &&
    eventType !== 'error'
  ) {
    return;
  }
  const liveTurnId = entry.codexLiveNativeSubagentTurns.get(threadId);
  if (turnId === undefined || liveTurnId === '' || turnId === liveTurnId) {
    entry.codexLiveNativeSubagentTurns.delete(threadId);
  }
}

function readRecordStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0,
  );
}

function rememberCodexNativeSubagentThread(
  entry: ActiveSession,
  threadId: string,
): void {
  if (!threadId || threadId === entry.codexRootThreadId) return;
  entry.codexNativeSubagentThreadIds.delete(threadId);
  entry.codexNativeSubagentThreadIds.add(threadId);
  while (
    entry.codexNativeSubagentThreadIds.size > MAX_CODEX_NATIVE_SUBAGENT_THREADS
  ) {
    const oldestThreadId = entry.codexNativeSubagentThreadIds
      .values()
      .next().value;
    if (typeof oldestThreadId !== 'string') break;
    entry.codexNativeSubagentThreadIds.delete(oldestThreadId);
    entry.codexNativeSubagentTurns.delete(oldestThreadId);
  }
}

function retireCodexNativeSubagentThread(
  entry: ActiveSession,
  threadId: string,
): void {
  entry.codexNativeSubagentThreadIds.delete(threadId);
  entry.codexNativeSubagentTurns.delete(threadId);
}

export type CodexNativeSubagentInterruptState =
  | 'not_found'
  | 'not_running'
  | 'running';

/** Resolve a Codex receiver only from its owning root's correlated events. */
export function getCodexNativeSubagentInterruptState(
  projectId: string,
  worktreeId: string,
  chatId: string,
  subagentThreadId: string,
): CodexNativeSubagentInterruptState {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (
    !entry ||
    entry.executionHarness !== 'codex' ||
    subagentThreadId === entry.codexRootThreadId ||
    !entry.codexNativeSubagentThreadIds.has(subagentThreadId)
  ) {
    return 'not_found';
  }
  return entry.codexNativeSubagentTurns.has(subagentThreadId)
    ? 'running'
    : 'not_running';
}

export function getClaudeNativeSubagentTaskForSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  toolUseId: string,
): ClaudeNativeSubagentTask | undefined {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (!entry || entry.executionHarness !== 'claude') return undefined;
  const task = entry.claudeNativeSubagentTasks.get(toolUseId);
  return task ? { ...task } : undefined;
}

function canReviveCodexTurn(entry: ActiveSession, data: unknown): boolean {
  const identity = readCodexEventIdentity(data);
  if (!identity || identity.threadId !== entry.codexRootThreadId) {
    return false;
  }

  const event = isPlainRecord(data) ? data.event : undefined;
  if (isPlainRecord(event) && event.type === 'turn.started') {
    return identity.turnId === entry.codexRootTurnId;
  }

  return (
    identity.threadId === entry.codexContinuationRevivalTurn?.threadId &&
    identity.turnId === entry.codexContinuationRevivalTurn.turnId
  );
}

/** A `task_updated` patch only reports a terminal state when it names one. */
function isTerminalTaskUpdatePatchStatus(status: string | undefined): boolean {
  return status !== undefined && isTerminalTaskStatus(status);
}

/**
 * Maintain the session's complete live background-task set.
 *
 * The SDK describes background tasks with a level signal
 * (`background_tasks_changed`, REPLACE semantics over the full live set) plus
 * an edge stream (`task_started`, `task_updated`, `task_notification`). Neither
 * is sufficient alone: nothing is emitted at CLI startup, so a resumed process
 * must start empty and repopulate, while a task that is backgrounded mid-turn
 * only shows up as an edge until the next level signal.
 *
 * `ambient` tasks are excluded: they are provider housekeeping and must never
 * appear as agent activity.
 */
function updateLiveBackgroundTaskState(
  entry: LiveBackgroundTaskStateOwner,
  data: unknown,
): boolean {
  if (!isPlainRecord(data) || data.type !== 'system') {
    return false;
  }

  const subtype = readRecordString(data, 'subtype');

  // `system`/`init` is NOT a process boundary: the CLI emits a top-level init at
  // the start of every turn inside one long-lived process. Process lifecycle is
  // signalled by `resetSessionLiveBackgroundTasks` at query start and by
  // teardown, both of which main owns directly.
  if (data.ambient === true) {
    return false;
  }

  const previousTasks = new Map(entry.liveBackgroundTasks);
  const changed = (): boolean =>
    !liveBackgroundTaskMapsEqual(previousTasks, entry.liveBackgroundTasks);

  if (subtype === 'background_tasks_changed') {
    if (!Array.isArray(data.tasks)) {
      return false;
    }
    const replacement = new Map<string, LiveBackgroundTask>();
    for (const task of data.tasks) {
      if (!isPlainRecord(task) || task.ambient === true) continue;
      const taskId = readRecordString(task, 'task_id');
      if (!taskId) continue;
      const previous = entry.liveBackgroundTasks.get(taskId);
      const metadata = readLiveBackgroundTaskMetadata(task);
      if (metadata.taskType !== undefined) {
        warnForUnknownBackgroundTaskType(entry, metadata.taskType);
      }
      // The level signal owns membership, not metadata: old CLIs send only ids,
      // so retain every known field for an id that survives replacement.
      replacement.set(
        taskId,
        mergeLiveBackgroundTaskMetadata(previous, metadata),
      );
    }
    entry.liveBackgroundTasks = replacement;
    return changed();
  }

  const taskId = readRecordString(data, 'task_id');
  if (!taskId) {
    return false;
  }

  if (subtype === 'task_started') {
    const metadata = readLiveBackgroundTaskMetadata(data);
    const taskType = metadata.taskType;
    if (taskType !== undefined) {
      warnForUnknownBackgroundTaskType(entry, taskType);
    }

    const isBackgrounded = data.is_backgrounded;
    const hasBackgroundCorrelation =
      isBackgrounded === undefined &&
      entry.activeBackgroundTaskIds?.has(taskId) === true;
    const isKnownAlwaysBackground =
      taskType === 'local_workflow' ||
      taskType === 'remote_agent' ||
      taskType === 'in_process_teammate';
    const isBackgroundEligibleType =
      taskType === 'local_agent' ||
      taskType === 'local_bash' ||
      taskType === 'mcp_task';
    const isUnknownTaskType =
      taskType !== undefined &&
      !isKnownAlwaysBackground &&
      !isBackgroundEligibleType;
    const shouldInclude =
      isKnownAlwaysBackground ||
      isUnknownTaskType ||
      ((isBackgroundEligibleType || taskType === undefined) &&
        (isBackgrounded === true || hasBackgroundCorrelation));

    if (!shouldInclude) {
      rememberForegroundTaskMetadata(entry, taskId, metadata);
      return changed();
    }

    entry.foregroundTaskMetadata.delete(taskId);
    rememberLiveBackgroundTask(entry, taskId, metadata);
    return changed();
  }

  if (subtype === 'task_updated') {
    const patch = isPlainRecord(data.patch) ? data.patch : undefined;
    if (!patch) return false;
    if (isTerminalTaskUpdatePatchStatus(readRecordString(patch, 'status'))) {
      entry.liveBackgroundTasks.delete(taskId);
      entry.foregroundTaskMetadata.delete(taskId);
      return changed();
    }

    const patchMetadata = readLiveBackgroundTaskMetadata(patch);
    const current = entry.liveBackgroundTasks.get(taskId);
    if (current) {
      // A snapshot can list the task before its promotion; keep the foreground
      // correlation (its tool_use_id) that the snapshot does not carry.
      const foreground = entry.foregroundTaskMetadata.get(taskId);
      entry.foregroundTaskMetadata.delete(taskId);
      rememberLiveBackgroundTask(entry, taskId, {
        ...foreground,
        ...patchMetadata,
      });
      return changed();
    }

    // A foreground task that outran its timeout is moved to the background.
    if (patch.is_backgrounded === true) {
      const foreground = entry.foregroundTaskMetadata.get(taskId);
      entry.foregroundTaskMetadata.delete(taskId);
      rememberLiveBackgroundTask(entry, taskId, {
        ...foreground,
        ...readLiveBackgroundTaskMetadata(data),
        ...patchMetadata,
      });
      return changed();
    }

    if (entry.foregroundTaskMetadata.has(taskId)) {
      rememberForegroundTaskMetadata(entry, taskId, patchMetadata);
    }
    return changed();
  }

  if (subtype === 'task_progress') {
    if (!entry.liveBackgroundTasks.has(taskId)) return false;
    rememberLiveBackgroundTask(
      entry,
      taskId,
      readLiveBackgroundTaskProgress(data),
    );
    return changed();
  }

  if (
    subtype === 'task_notification' &&
    isTerminalTaskStatus(readRecordString(data, 'status'))
  ) {
    entry.liveBackgroundTasks.delete(taskId);
    entry.foregroundTaskMetadata.delete(taskId);
    return changed();
  }

  return false;
}

const MAX_FOREGROUND_TASK_METADATA = 256;
const MAX_LIVE_BACKGROUND_TASK_STRING_LENGTH = 500;
const KNOWN_BACKGROUND_TASK_TYPES = new Set([
  'local_workflow',
  'remote_agent',
  'in_process_teammate',
  'local_agent',
  'local_bash',
  'mcp_task',
]);

function readBoundedRecordString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = readRecordString(record, key);
  return value === undefined
    ? undefined
    : value.slice(0, MAX_LIVE_BACKGROUND_TASK_STRING_LENGTH);
}

function readRecordNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readLiveBackgroundTaskMetadata(
  record: Record<string, unknown>,
): LiveBackgroundTask {
  const metadata: LiveBackgroundTask = {};
  const toolUseId = readBoundedRecordString(record, 'tool_use_id');
  const description = readBoundedRecordString(record, 'description');
  const taskType = readBoundedRecordString(record, 'task_type');
  const workflowName = readBoundedRecordString(record, 'workflow_name');
  const spawnDepth = readRecordNumber(record, 'spawn_depth');
  const isBackgrounded = record.is_backgrounded;
  const status = readRecordString(record, 'status');
  if (toolUseId !== undefined) metadata.toolUseId = toolUseId;
  if (description !== undefined) metadata.description = description;
  if (taskType !== undefined) metadata.taskType = taskType;
  if (workflowName !== undefined) metadata.workflowName = workflowName;
  if (spawnDepth !== undefined) metadata.spawnDepth = spawnDepth;
  if (typeof isBackgrounded === 'boolean') {
    metadata.isBackgrounded = isBackgrounded;
  }
  if (status === 'pending' || status === 'running' || status === 'paused') {
    metadata.status = status;
  }
  const summary = readBoundedRecordString(record, 'summary');
  if (summary !== undefined) metadata.summary = summary;
  const usage = readBackgroundTaskUsage(record.usage);
  if (usage) metadata.usage = usage;
  return metadata;
}

function readLiveBackgroundTaskProgress(
  record: Record<string, unknown>,
): LiveBackgroundTask {
  const progress: LiveBackgroundTask = {};
  const phase = readBoundedRecordString(record, 'description');
  const summary = readBoundedRecordString(record, 'summary');
  if (phase !== undefined) progress.phase = phase;
  if (summary !== undefined) progress.summary = summary;
  const usage = readBackgroundTaskUsage(record.usage);
  if (usage) progress.usage = usage;
  return progress;
}

function readBackgroundTaskUsage(
  value: unknown,
): LiveBackgroundTaskUsage | undefined {
  if (!isPlainRecord(value)) return undefined;
  const totalTokens = readRecordNumber(value, 'total_tokens');
  const toolUses = readRecordNumber(value, 'tool_uses');
  const durationMs = readRecordNumber(value, 'duration_ms');
  if (
    totalTokens === undefined &&
    toolUses === undefined &&
    durationMs === undefined
  ) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function mergeLiveBackgroundTaskMetadata(
  ...sources: (LiveBackgroundTask | undefined)[]
): LiveBackgroundTask {
  const merged: LiveBackgroundTask = {};
  for (const source of sources) {
    if (!source) continue;
    const usage = source.usage;
    const flatMetadata = { ...source };
    delete flatMetadata.usage;
    Object.assign(merged, flatMetadata);
    if (usage) merged.usage = { ...merged.usage, ...usage };
  }
  return merged;
}

function liveBackgroundTaskMapsEqual(
  first: Map<string, LiveBackgroundTask>,
  second: Map<string, LiveBackgroundTask>,
): boolean {
  if (first.size !== second.size) return false;
  const firstTasks = Array.from(first.entries());
  const secondTasks = Array.from(second.entries());
  for (let index = 0; index < firstTasks.length; index += 1) {
    const [firstId, firstTask] = firstTasks[index];
    const [secondId, secondTask] = secondTasks[index];
    if (firstId !== secondId) return false;
    const fields: (keyof LiveBackgroundTask)[] = [
      'toolUseId',
      'description',
      'taskType',
      'workflowName',
      'spawnDepth',
      'isBackgrounded',
      'status',
      'phase',
      'summary',
    ];
    if (fields.some((field) => firstTask[field] !== secondTask[field])) {
      return false;
    }
    const firstUsage = firstTask.usage;
    const secondUsage = secondTask.usage;
    if (
      firstUsage?.totalTokens !== secondUsage?.totalTokens ||
      firstUsage?.toolUses !== secondUsage?.toolUses ||
      firstUsage?.durationMs !== secondUsage?.durationMs
    ) {
      return false;
    }
  }
  return true;
}

function warnForUnknownBackgroundTaskType(
  entry: LiveBackgroundTaskStateOwner,
  taskType: string,
): void {
  if (
    KNOWN_BACKGROUND_TASK_TYPES.has(taskType) ||
    entry.unknownTaskTypesLogged.has(taskType)
  ) {
    return;
  }
  entry.unknownTaskTypesLogged.add(taskType);
  logMainProcessWarn(
    '[session-manager] Unknown background task type; treating it as background work',
  );
}

function rememberForegroundTaskMetadata(
  entry: LiveBackgroundTaskStateOwner,
  taskId: string,
  task: LiveBackgroundTask,
): void {
  const previous = entry.foregroundTaskMetadata.get(taskId);
  entry.foregroundTaskMetadata.delete(taskId);
  entry.foregroundTaskMetadata.set(
    taskId,
    mergeLiveBackgroundTaskMetadata(previous, task),
  );
  while (entry.foregroundTaskMetadata.size > MAX_FOREGROUND_TASK_METADATA) {
    const oldestTaskId = entry.foregroundTaskMetadata.keys().next().value;
    if (typeof oldestTaskId !== 'string') break;
    entry.foregroundTaskMetadata.delete(oldestTaskId);
  }
}

function rememberLiveBackgroundTask(
  entry: LiveBackgroundTaskStateOwner,
  taskId: string,
  task: LiveBackgroundTask,
): void {
  const previous = entry.liveBackgroundTasks.get(taskId);
  entry.liveBackgroundTasks.set(
    taskId,
    mergeLiveBackgroundTaskMetadata(previous, task),
  );
}

/**
 * Tell every still-live background task's consumers that the provider session
 * that owned them is gone. The CLI process dies with the session and
 * takes its background tasks with it, but the SDK emits no terminal bookend for
 * them, so without this the renderer, the transcript sidecar, and the portal
 * tracker keep showing them as running forever.
 */
function notifySessionEndedBackgroundTasks(
  key: string,
  entry: ActiveSession,
  options: { notifyListeners?: boolean } = {},
): void {
  const stopCause = entry.teardownCause ?? 'session_ended';
  // The cause belongs to this provider process only. Consume it even if the
  // process had no remaining tasks or the session key is malformed.
  entry.teardownCause = undefined;
  const tasks = Array.from(entry.liveBackgroundTasks.entries());
  // Cleared before delivery so a second teardown pass over the same entry
  // cannot emit a duplicate notification.
  entry.liveBackgroundTasks = new Map<string, LiveBackgroundTask>();
  if (options.notifyListeners !== false) {
    notifyLiveBackgroundTasksListeners(key);
  }
  if (tasks.length === 0) return;

  let target: { projectId: string; worktreeId: string; chatId: string };
  try {
    target = parseSessionKey(key);
  } catch {
    return;
  }

  for (const [taskId, task] of tasks) {
    emitSessionEndedBackgroundTaskNotification(target, {
      taskId,
      ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
      ...(task.description ? { description: task.description } : {}),
      stopCause,
    });
  }
}

/**
 * Record why the current session for `key` is about to end, before the
 * cancellation or destruction that ends it. The first cause recorded wins, so
 * an intentional Stop, archive or recycle outranks the abort or exit it
 * triggers. Stored on the session entry: a replacement session under the same
 * key is unaffected. The stop record consumes it.
 */
export function markSessionTeardownCause(
  key: string,
  cause: SessionStopCause,
): void {
  const entry = sessions.get(key);
  if (entry && entry.teardownCause === undefined) entry.teardownCause = cause;
}

/**
 * A fresh provider CLI process is starting for this session. Any task
 * the previous process reported is gone with it, so flush whatever is left —
 * nothing is left once teardown has already notified — and start empty.
 *
 * Called by the provider at query start because that, not any event, is the real
 * process boundary: the Claude CLI emits a top-level `system`/`init` at the
 * start of every turn within one long-lived process.
 */
export function resetSessionLiveBackgroundTasks(key: string): void {
  const entry = sessions.get(key);
  const e2eOwner = e2eIngestedLiveBackgroundTasks.get(key);
  if (!entry) {
    if (!e2eOwner) return;
    e2eOwner.liveBackgroundTasks = new Map<string, LiveBackgroundTask>();
    e2eOwner.foregroundTaskMetadata.clear();
    notifyLiveBackgroundTasksListeners(key);
    return;
  }
  const wasBackgroundBusy = hasBusyBackgroundWork(entry);
  notifySessionEndedBackgroundTasks(key, entry, { notifyListeners: false });
  entry.foregroundTaskMetadata.clear();
  entry.claudeNativeSubagentTasks.clear();
  entry.activeBackgroundTaskIds.clear();
  entry.continuationToolUseIds.clear();
  entry.nonBusyBackgroundToolUseIds.clear();
  entry.teardownCause = undefined;
  if (e2eOwner) {
    e2eOwner.liveBackgroundTasks = new Map<string, LiveBackgroundTask>();
    e2eOwner.foregroundTaskMetadata.clear();
  }
  syncChatWake(key);
  notifyLiveBackgroundTasksListeners(key);
  if (wasBackgroundBusy !== hasBusyBackgroundWork(entry)) {
    notifyChatSessionActivityListeners();
  }
}

/**
 * Task ids the provider currently reports as live background work for one chat.
 * `undefined` means the chat has no live provider session at all, which the
 * renderer must distinguish from a live session with no background tasks.
 */
export function getSessionLiveBackgroundTaskIds(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string[] | undefined {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (!entry) return undefined;
  return Array.from(entry.liveBackgroundTasks.keys());
}

function toActivityLiveBackgroundTasks(
  owner: Pick<LiveBackgroundTaskStateOwner, 'liveBackgroundTasks'>,
): ActivityLiveBgTask[] {
  return Array.from(owner.liveBackgroundTasks, ([taskId, task]) => ({
    taskId,
    ...task,
  }));
}

/**
 * Live background-task state for every chat with a provider session under the
 * given project/worktree. Chats without a session are absent from the result.
 */
export function getLiveBackgroundTaskSnapshot(
  projectId: string,
  worktreeId: string,
): Record<string, ActivityLiveBgTasksChatState> {
  const prefix = `${projectId}/${worktreeId}/`;
  const chats: Record<string, ActivityLiveBgTasksChatState> = {};

  for (const [key, entry] of Array.from(sessions.entries())) {
    if (!key.startsWith(prefix)) continue;
    const chatId = key.slice(prefix.length);
    // A session key is exactly three segments, so anything else is not a chat
    // under this worktree and must not answer for one.
    if (!chatId || chatId.includes('/')) continue;
    chats[chatId] = {
      sessionActive: true,
      liveTasks: toActivityLiveBackgroundTasks(entry),
    };
  }

  if (isE2eBuild()) {
    for (const [key, entry] of Array.from(
      e2eIngestedLiveBackgroundTasks.entries(),
    )) {
      if (!key.startsWith(prefix)) continue;
      const chatId = key.slice(prefix.length);
      if (!chatId || chatId.includes('/')) continue;
      // A real session always wins: it is the authority whenever one exists.
      if (chats[chatId]) continue;
      chats[chatId] = {
        sessionActive: true,
        liveTasks: toActivityLiveBackgroundTasks(entry),
      };
    }
  }

  return chats;
}

/**
 * Live background-task state for chats driven by the deterministic E2E
 * chat-event ingress rather than a real provider CLI process.
 *
 * UI automation has no provider session, so `sessions` is empty and every chat
 * it injects events into would read as "no live session" — which the renderer
 * correctly treats as proof that a rebuilt `running` card is stale. That makes
 * the *positive* branch of the liveness pass (a background process the session
 * still reports live must survive its turn completing) unreachable from a
 * spec. Injected `system` events are reduced here through the very same
 * {@link updateLiveBackgroundTaskState} rules main applies to provider events,
 * so a spec proves the real reducer rather than a test double.
 */
const e2eIngestedLiveBackgroundTasks = new Map<
  string,
  LiveBackgroundTaskStateOwner
>();

/** Live provider or E2E task owners, with real sessions authoritative by key. */
export function listLiveBackgroundTaskOwners(): LiveBackgroundTaskOwner[] {
  const owners: LiveBackgroundTaskOwner[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    const target = parseSessionKey(key);
    owners.push({
      sessionKey: key,
      ...target,
      liveTasks: toActivityLiveBackgroundTasks(entry),
    });
  }

  if (isE2eBuild()) {
    for (const [key, entry] of Array.from(
      e2eIngestedLiveBackgroundTasks.entries(),
    )) {
      if (sessions.has(key)) continue;
      const target = parseSessionKey(key);
      owners.push({
        sessionKey: key,
        ...target,
        liveTasks: toActivityLiveBackgroundTasks(entry),
      });
    }
  }

  return owners;
}

/** Live provider or E2E tasks for one chat; absent owners return undefined. */
export function getLiveBackgroundTasksForChat(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ActivityLiveBgTask[] | undefined {
  const key = sessionKey(projectId, worktreeId, chatId);
  const owner =
    sessions.get(key) ??
    (isE2eBuild() ? e2eIngestedLiveBackgroundTasks.get(key) : undefined);
  return owner ? toActivityLiveBackgroundTasks(owner) : undefined;
}

export function registerCodexBackgroundOwner(scope: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): CodexBackgroundOwnerToken | undefined {
  const key = sessionKey(scope.projectId, scope.worktreeId, scope.chatId);
  const entry = sessions.get(key);
  if (!entry || entry.executionHarness !== 'codex') return undefined;

  const token: CodexBackgroundOwnerToken = {
    scope: { ...scope },
  };
  Object.freeze(token.scope);
  Object.freeze(token);
  entry.codexBackgroundOwnerToken = token;
  entry.codexBackgroundOwnerRevision = undefined;
  codexBackgroundOwnerEntries.set(token, key);
  return token;
}

function getCurrentCodexBackgroundOwner(
  token: CodexBackgroundOwnerToken,
): { key: string; entry: ActiveSession } | undefined {
  const key = codexBackgroundOwnerEntries.get(token);
  if (!key) return undefined;
  const entry = sessions.get(key);
  if (
    !entry ||
    entry.executionHarness !== 'codex' ||
    entry.codexBackgroundOwnerToken !== token
  ) {
    return undefined;
  }
  return { key, entry };
}

export function replaceCodexLiveBackgroundTasks(
  token: CodexBackgroundOwnerToken,
  snapshot: {
    revision: number;
    tasks: readonly CodexLiveBackgroundTaskInput[];
  },
): boolean {
  const owner = getCurrentCodexBackgroundOwner(token);
  if (!owner) return false;

  const { key, entry } = owner;
  const previousRevision = entry.codexBackgroundOwnerRevision;
  if (
    !Number.isFinite(snapshot.revision) ||
    (previousRevision !== undefined && snapshot.revision <= previousRevision)
  ) {
    return false;
  }

  const snapshotTasks = new Map<string, LiveBackgroundTask>();
  for (const task of snapshot.tasks) {
    if (
      !entry.codexBackgroundTaskIds.has(task.taskId) &&
      entry.liveBackgroundTasks.has(task.taskId)
    ) {
      // A task id already owned by another provider event stays untouched; the
      // single shared map cannot represent two owners for the same id.
      continue;
    }
    snapshotTasks.set(task.taskId, {
      taskType: task.taskType,
      status: 'running',
      // Codex task stop is refused (turn-state D10), so no Stop control.
      stoppable: false,
      ...(task.description === undefined
        ? {}
        : { description: task.description }),
      ...(task.toolUseId === undefined ? {} : { toolUseId: task.toolUseId }),
    });
  }

  const replacement = new Map<string, LiveBackgroundTask>();
  for (const [taskId, task] of Array.from(
    entry.liveBackgroundTasks.entries(),
  )) {
    if (entry.codexBackgroundTaskIds.has(taskId)) {
      const updatedTask = snapshotTasks.get(taskId);
      if (updatedTask) replacement.set(taskId, updatedTask);
    } else {
      replacement.set(taskId, task);
    }
  }
  for (const [taskId, task] of Array.from(snapshotTasks.entries())) {
    if (!replacement.has(taskId)) replacement.set(taskId, task);
  }

  const previousTasks = new Map(entry.liveBackgroundTasks);
  const wasBackgroundBusy = hasBusyBackgroundWork(entry);
  const changed = !liveBackgroundTaskMapsEqual(previousTasks, replacement);
  entry.codexBackgroundTaskIds = new Set(snapshotTasks.keys());
  entry.codexBackgroundOwnerRevision = snapshot.revision;
  if (!changed) return true;

  entry.liveBackgroundTasks = replacement;
  notifyLiveBackgroundTasksListeners(key);
  syncChatWake(key);
  if (wasBackgroundBusy !== hasBusyBackgroundWork(entry)) {
    notifyChatSessionActivityListeners();
  }
  return true;
}

export function retireCodexLiveBackgroundTasks(
  token: CodexBackgroundOwnerToken,
): boolean {
  const owner = getCurrentCodexBackgroundOwner(token);
  if (!owner) return false;

  const { key, entry } = owner;
  const previousTasks = new Map(entry.liveBackgroundTasks);
  const wasBackgroundBusy = hasBusyBackgroundWork(entry);
  const replacement = new Map(
    Array.from(entry.liveBackgroundTasks.entries()).filter(
      ([taskId]) => !entry.codexBackgroundTaskIds.has(taskId),
    ),
  );
  const changed = !liveBackgroundTaskMapsEqual(previousTasks, replacement);

  entry.codexBackgroundOwnerToken = undefined;
  entry.codexBackgroundOwnerRevision = undefined;
  entry.codexBackgroundTaskIds.clear();
  if (!changed) return true;

  entry.liveBackgroundTasks = replacement;
  notifyLiveBackgroundTasksListeners(key);
  syncChatWake(key);
  if (wasBackgroundBusy !== hasBusyBackgroundWork(entry)) {
    notifyChatSessionActivityListeners();
  }
  return true;
}

/** Snapshot child tool correlation at the moment a parent terminal is received. */
export function getChildToolLiveness(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ChildToolLiveness {
  const liveTasks = getLiveBackgroundTasksForChat(
    projectId,
    worktreeId,
    chatId,
  );
  if (liveTasks === undefined) return { kind: 'no-live-session' };

  return {
    kind: 'known',
    liveParentToolUseIds: liveTasks.flatMap((task) =>
      task.toolUseId === undefined ? [] : [task.toolUseId],
    ),
    hasUncorrelatedLiveTask: liveTasks.some(
      (task) => task.toolUseId === undefined,
    ),
  };
}

/**
 * Record one injected provider event against the E2E live background-task
 * replica. Build-time gated, so production builds drop it entirely.
 */
export function applyE2eIngestedLiveBackgroundTaskEvent(
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: unknown,
): void {
  if (!isE2eBuild()) return;
  if (!isPlainRecord(data) || data.type !== 'system') return;

  const key = sessionKey(projectId, worktreeId, chatId);
  let owner = e2eIngestedLiveBackgroundTasks.get(key);
  if (!owner) {
    owner = {
      liveBackgroundTasks: new Map<string, LiveBackgroundTask>(),
      foregroundTaskMetadata: new Map<string, LiveBackgroundTask>(),
      unknownTaskTypesLogged: new Set<string>(),
    };
    e2eIngestedLiveBackgroundTasks.set(key, owner);
  }
  if (updateLiveBackgroundTaskState(owner, data)) {
    notifyLiveBackgroundTasksListeners(key);
  }
}

function updateBackgroundTaskState(
  entry: ActiveSession,
  data: unknown,
): boolean {
  if (!isPlainRecord(data)) {
    return false;
  }

  if (data.type === 'assistant') {
    rememberToolUseNames(entry, data);
    return false;
  }

  if (data.type !== 'system' || data.ambient === true) {
    return false;
  }

  const subtype = readRecordString(data, 'subtype');
  if (subtype === 'background_tasks_changed') {
    if (!Array.isArray(data.tasks)) {
      return false;
    }
    const liveTaskIds = new Set<string>();
    for (const task of data.tasks) {
      if (!isPlainRecord(task)) return false;
      if (task.ambient === true) continue;
      const liveTaskId = readRecordString(task, 'task_id');
      if (!liveTaskId) return false;
      liveTaskIds.add(liveTaskId);
    }

    // This session state intentionally tracks only finite background Bash
    // continuations selected by task_started/tool_use correlation. The level
    // signal includes persistent services too, so use it to remove missing
    // tracked tasks without adding unrelated task ids.
    let changed = false;
    for (const activeTaskId of Array.from(entry.activeBackgroundTaskIds)) {
      if (liveTaskIds.has(activeTaskId)) continue;
      entry.activeBackgroundTaskIds.delete(activeTaskId);
      changed = true;
    }
    return changed;
  }

  const taskId = readRecordString(data, 'task_id');
  if (!taskId) {
    return false;
  }

  if (subtype === 'task_started') {
    const toolUseId = readRecordString(data, 'tool_use_id');
    if (toolUseId && entry.continuationToolUseIds.has(toolUseId)) {
      const previousSize = entry.activeBackgroundTaskIds.size;
      entry.activeBackgroundTaskIds.add(taskId);
      return entry.activeBackgroundTaskIds.size !== previousSize;
    }
    return false;
  }

  if (
    subtype === 'task_notification' &&
    isTerminalTaskStatus(readRecordString(data, 'status'))
  ) {
    return entry.activeBackgroundTaskIds.delete(taskId);
  }

  return false;
}

function rememberToolUseNames(
  entry: ActiveSession,
  data: Record<string, unknown>,
): void {
  const message = isPlainRecord(data.message) ? data.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content) {
    if (!isPlainRecord(block) || block.type !== 'tool_use') {
      continue;
    }

    const id = readRecordString(block, 'id');
    const name = readRecordString(block, 'name');
    if (id && name) {
      const input = isPlainRecord(block.input) ? block.input : undefined;
      if (isContinuationToolUse(name, input)) {
        entry.continuationToolUseIds.add(id);
      } else if (
        (name === 'Bash' || name === 'PowerShell') &&
        input !== undefined &&
        isPersistentBackgroundService(
          readRecordString(input, 'command') ?? '',
          readRecordString(input, 'description') ?? '',
        )
      ) {
        // Only known servers stay out of busy accounting. A finite command
        // started in the foreground can be promoted to the background when it
        // outruns its timeout, and it is still work in flight.
        entry.nonBusyBackgroundToolUseIds.add(id);
      }
    }
  }
}

function isContinuationToolUse(
  name: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (name === 'Workflow') {
    return true;
  }
  // Windows Claude sessions expose `PowerShell` in place of `Bash`.
  return (
    (name === 'Bash' || name === 'PowerShell') && isFiniteBackgroundBash(input)
  );
}

function isFiniteBackgroundBash(
  input: Record<string, unknown> | undefined,
): boolean {
  if (!input || input.run_in_background !== true) {
    return false;
  }

  const command = readRecordString(input, 'command') ?? '';
  if (!command.trim()) {
    return false;
  }

  const description = readRecordString(input, 'description') ?? '';
  return !isPersistentBackgroundService(command, description);
}

function isPersistentBackgroundService(
  command: string,
  description: string,
): boolean {
  const lowerCommand = command.toLowerCase();
  const lowerDescription = description.toLowerCase();

  return (
    /\bdev server\b/.test(lowerDescription) ||
    /\bstart(?:ing)?\b[\s\S]{0,80}\b(server|service|gateway|app)\b/.test(
      lowerDescription,
    ) ||
    /\bnpm\s+(?:(?:run\s+)?start(?::dev)?|run\s+(?:dev|serve))\b/.test(
      lowerCommand,
    ) ||
    /\b(?:pnpm|yarn)\s+(?:run\s+)?(dev|serve|start)\b/.test(lowerCommand) ||
    /\b(?:next|vite|webpack-dev-server|electron-vite)\s+dev\b/.test(
      lowerCommand,
    )
  );
}

export function createSessionPhaseTimer(
  key: string,
  phase: string,
): () => void {
  const phaseStartedAt = Date.now();
  const timeoutId = setTimeout(() => {
    const entry = sessions.get(key);
    if (!entry) {
      return;
    }

    // eslint-disable-next-line no-console
    console.warn('[agent-session] Session startup phase still pending', {
      sessionKey: key,
      phase,
      providerType: entry.providerType,
      model: entry.model,
      turnActive: entry.turnActive,
      pendingMessageCount: entry.pendingMessageCount,
      lastEventType: entry.lastEventType,
      elapsedMs: Date.now() - phaseStartedAt,
    });
    recordSessionDiagnostic(key, entry, {
      kind: 'phase_slow',
      phase,
      elapsedMs: Date.now() - phaseStartedAt,
    });
  }, SLOW_SESSION_PHASE_MS);

  return (): void => {
    clearTimeout(timeoutId);
  };
}

/**
 * How a provider session instance relates to its key: `registered` while it is
 * the key's entry, `released` once nothing is registered there (it was
 * detached for teardown or unregistered), and `replaced` once another instance
 * has registered. Key-scoped teardown by a `replaced` instance would destroy
 * live state of its successor.
 */
export type SessionKeyOwnership = 'registered' | 'released' | 'replaced';

export function getSessionKeyOwnership(
  key: string,
  session: AgentSession,
): SessionKeyOwnership {
  const entry = sessions.get(key);
  if (!entry) return 'released';
  return entry.session === session ? 'registered' : 'replaced';
}

/**
 * Remove a session from the active map. Called by providers when a session ends.
 * With `session`, only while the key's entry is still that instance: a late
 * teardown must not drop a successor registered under the same key.
 */
export function unregisterSession(key: string, session?: AgentSession): void {
  if (session !== undefined && sessions.get(key)?.session !== session) return;
  clearPresentationTurn(key);
  const entry = removeSessionEntry(key);
  if (!entry) return;
  void flushAndStopOutputPollingForSession(key).finally(() => {
    notifySessionEndedBackgroundTasks(key, entry);
  });
}

/**
 * Build a session key from components (exposed for providers).
 */
export function buildSessionKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return sessionKey(projectId, worktreeId, chatId);
}

/**
 * Check if a model change crosses provider boundaries.
 */
export function isProviderChangeAllowed(
  projectId: string,
  worktreeId: string,
  chatId: string,
  newModel: ChatModel,
  lockedHarness?: AgentSessionOptions['executionHarness'],
  requestedHarness?: AgentSessionOptions['executionHarness'],
  options: { recyclesActiveSession?: boolean } = {},
): boolean {
  const newHarness = requestedHarness ?? getExecutionHarnessForModel(newModel);
  if (!newHarness) return false;

  // Reject if explicitly locked to a different execution harness.
  if (lockedHarness && lockedHarness !== newHarness) return false;
  // An in-place provider switch (CAN-6445) recycles the live session after
  // parking it, so the active harness does not block it.
  if (options.recyclesActiveSession === true) return true;

  // Active sessions can be recreated when the model source changes, but an
  // execution-harness change would invalidate provider conversation state.
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  const activeHarness = entry?.executionHarness;
  if (activeHarness && activeHarness !== newHarness) return false;

  return true;
}
