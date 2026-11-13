import { assertCoworkChatRootPresent } from './cowork-folder-guard';
import { detectAiCreditsNoBillingSource } from '../agents/ai-credits-quota-state';
import {
  recordPresentationTurn,
  capturePresentationTurn,
  clearPresentationTurn,
  presentationChatKey,
} from '../canopy-tools/presentation-state';
import { browserHandoffs } from '../browser/browser-handoffs';
import { chatVisualsPromptEligible } from './chat-visuals-feature-flag';
import { assertOpenCodeSelectionAvailable } from '../opencode/selection';
import { assertCopilotModelAvailable } from '../copilot/connection';
import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import { beginChatTurnPreparation } from './chat-turn-cancel';
import {
  activatePendingTurnRoute,
  getLiveRoutedSession,
  getOrCreateRoutedSession,
  parkBehindWake,
  getTurnRootAcceptance,
  sessionEventRouterTestExports,
} from '../agents/session-event-router';
import {
  classifyProviderRunEvent,
  copyProviderRunProvenance,
  getProviderRunDescriptor,
} from './provider-run-reconciliation';
import {
  claimDelegationDelivery,
  releaseDelegationDelivery,
  retireDelegationDelivery,
} from '../agents/delegation/lifecycle';
import { resolveManagedDelegationMode } from '../agents/delegation/gate';
import { logMainProcessError } from './main-process-logging';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { BrowserWindow } from 'electron';
import { CHAT_LABEL, type WorkOwner } from '@canopy/protocol';
import { MEMORY_SEARCH_CAPABILITY } from '@canopy/protocol/memory';
import { MAX_TELEMETRY_CLIENT_ID_LENGTH } from '@canopy/protocol/telemetry';
import { clampId } from '@canopy/desktop-shared/lib/telemetry-mapping';
import {
  APP_ADVISOR_PROJECT_ID,
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  CODE_REVIEW_CHAT_PROJECT_ID,
  GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
  IPC_CHANNELS,
  ORG_MEMORY_USED_EVENT_TYPE,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SINGLE_REPO_USAGE_REPO_ID,
  STANDALONE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForModel,
  isSetAutoArchiveRequestedEventData,
  requireProviderForModel,
  normalizeAgentModelConfig,
  resolveModelAlias,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type AiCreditsRoutingState,
  type AgentAuditLinkTarget,
  type AgentProviderType,
  type ApprovalMode,
  type ApprovalRule,
  type ChatActiveSessionInfo,
  type ChatModel,
  type ChatSendMessageRequest,
  type ChatTabPluginSelections,
  type FileReference,
  type OrgMemoryUsedEventData,
  type PendingSystemInstruction,
  type PreferencesData,
  type UsageInitiationSource,
  type ThinkingLevel,
  type DeferredResourceSummary,
} from '@canopy/desktop-shared/types';
import { codexServiceTierForModelConfig } from '@canopy/execution-engine/lib/codex-model-config';
import { applyAgentSessionCodexSpeed } from '@canopy/execution-engine/lib/codex-speed';
import { chatSurfaceUsesGlobalPluginDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { buildCodeReviewPrompt } from '@canopy/desktop-shared/lib/code-review-prompt';
import {
  appendUserOverallPreferencesBlock,
  buildUserOverallPreferencesBlock,
} from '@canopy/execution-engine/lib/global-instructions';
import type { DesktopExecutionObservabilityIngest } from '../observability/ingest';
import type { SessionDiagnosticRecord } from '../observability/service';
import type { PipelinePackageCapabilityOverlay } from '@canopy/execution-engine/types/pipeline';
import type {
  ChatQueueService,
  ChatQueueTerminalStatus,
} from '../services/chat-queue-service';
import {
  consumeDispatchAuthorization,
  wakeParkingOutcome,
  type AuthorizedChatDispatch,
} from '../services/chat-dispatch-authorization';
import { reservePromptBindingSlot } from '../services/chat-turn-binding-slots';
import type { ProviderEventIngestOutcome } from '../services/chat-state-service';
import type { PersistedChatDispatchMetadata } from './chat-tabs-reader';
import {
  beginSessionTurnPreparation,
  releaseSessionTurnPreparationOnActivation,
  buildSessionKey,
  getActiveSessionInfos,
  canReuseSession,
  canPreserveSessionCapabilitySnapshot,
  destroySession,
  shouldRecreateSessionOnNextTurn,
  isSessionAccountProxyRouted,
  isSessionAiCreditsRouted,
  getSessionCodeGraphToolsAdvertised,
  getSessionGlobalInstructionsSnapshot,
  getSessionRecreateReasons,
  chatHasNativeBackgroundWork,
  setSessionTurnSettings,
  getSessionProviderType,
  type SessionTurnSettings,
  restrictSessionApprovalRules,
} from '../agents/session-manager';
import {
  isRecreateDeferrable,
  liveSessionSettingsOverlay,
} from './turn-session-reuse';
import {
  captureSessionWorkOwner,
  resolveSessionWorkOwner,
} from '../agents/work-owner';
import { generateAndRenameBranch } from './branch-namer';
import { readHelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import { normalizeOrganizationExternalId } from '@canopy/desktop-shared/lib/org-memory';
import { isCoworkWorkspace } from './workspace-registry';
import { pairPendingAuthFailuresWithTool } from './auth-failure-event';
import { stopTurnForAuthFailure } from './auth-failure-turn-stop';
import {
  getDiagnosticEventMetadata,
  getChatTurnAuditStatus,
  isClaudeChildFrame,
  isCodexSubagentFollowupEvent,
  isRootAgentContinuationEvent,
  isRecord,
  isRootTerminalChatEventData,
  isTerminalChatEventData,
  readCodexRootThreadId,
} from './chat-turn-audit';
import {
  beginChatTurnRun,
  chatTurnOutcomeOf,
  type ChatTurnRunHandle,
} from '../agent-runs/turn-runs';
import { recordChatEventDropped } from './chat-event-drop-diagnostics';
import {
  SessionEventCommitPipeline,
  isOverlappableProviderEvent,
} from './session-event-commit-pipeline';
import {
  doesBranchMatchWorktreeId,
  isBranchPromptSent,
  readPersistedWorktreeBranch,
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from './resolve-worktree';
import { recordWorktreeDiscovery } from './worktree-repair';
import { composeWorktreeRepoRules } from '../repo-rules/host';
import { selectSessionInstructions } from '../repo-rules/session';
import { readPreferencesFile } from '../lib/preferences-store';
import { requireLaneAwareDefaultSelection } from '../lib/default-model-lane-resolver';
import { resolveLaneSubstitutedProviderType } from './lane-substituted-provider';
import { claudeContinuationSession } from './claude-fork-continuation';
import { sendToWindow, sendToWindowDetailed } from './window-send';
import { scheduleSummaryGeneration } from './worktree-summary-scheduler';
import {
  noteCodeReviewTurnEnd,
  noteCodeReviewTurnStart,
  noteWorktreeActivityForCodeReview,
} from './code-review-scheduler';
import {
  captureTurnEndAndDiffs,
  captureTurnStart,
  discardTurnStart,
} from './turn-diff-capture';
import { wakeTurnKey } from '@canopy/agent-transcript/turn';
import { scheduleCodeGraphBuild } from './code-graph-scheduler';
import {
  buildSubmittedMessageText,
  prependPendingSystemInstructions,
} from './chat-submitted-message';
import {
  resolveActivePlanSystemInstruction,
  withActivePlanInstruction,
} from './active-plan-instruction';
import {
  readPersistedChatDispatchMetadata,
  readPersistedChatExecutionContext,
} from './chat-tabs-reader';
import { resolveChatTurnApprovalAuthority } from './chat-turn-approval-authority';
import { recordBackgroundProcessChatEvent } from '../portal/background-process-tracker';
import { getWorktreeAttachmentsDir } from './paths';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { buildWorktreeInjectedToolPrompt } from '../canopy-tools/prompting';
import { isCodeGraphAvailableForWorkspace } from './code-graph-availability';
import { buildCodeGraphAvailabilityPrompt } from './code-graph-availability-prompt';
import {
  buildCoworkDispatchSystemPromptAppend,
  buildLocalMemoryPromptNudge,
} from './cowork-chat-system-prompt';
import { describeChatEventData } from './chat-event-description';
import { buildPlanModeWorkspaceScopePrompt } from './plan-mode-workspace-scope';
import {
  getPlanFileSyncService,
  planChatTurnKey,
  resolvePlanTurnScope,
  type PlanTurnLease,
} from './plan-file-sync';
import {
  getResourceMonitorService,
  type ResourceGuardReservation,
} from '../resource-monitor';
import { resolveAgentModelRuntime } from '../agents/agent-model-runtime';
import {
  captureCanonicalChatProducerContext,
  notifyCanonicalChatStarted,
  notifyCanonicalChatTerminal,
} from '../services/active-chat-input';
import { readWorkspaceConfig } from './workspace-persistence';
import { generateChatSummaryForProject } from '../ipc/standalone-chat';
import { armTurnLifecycleContinuation } from '../agents/provider-turn-lifecycle';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
} from './background-helper-queue';
import { getCanopyCloudCredentials } from './canopy-cloud-account-store';
import {
  fetchOrgMemoryAttempt,
  type OrgMemoryFetchAttempt,
  type OrgMemoryFetchResult,
} from '../memory/memory-client';
import { createOrgMemoryDeliveryTracker } from '../memory/delivery-tracker';
import { resolveOrgMemoryOwner } from '../memory/memory-owner';
import { isOrganizationTeamsLapsed } from './org-billing-state';
import { persistOrgMemoryUsedForChat } from './chat-tab-dispatch-utils';
import { assertChatScopeAcceptsTurns } from './retired-chat-scope-guard';
import { getChatStateService } from '../services/chat-state-service';
import {
  normalizeProviderEventIngestResult,
  type ProviderEventIngestResult,
} from '../services/provider-event-admission';
import { getStoppedTurnResumeService } from '../services/stopped-turn-resume-service';
import {
  MEMORY_QUERY_MAX_CHARS,
  buildMemoryQuery,
  composeSubmittedText,
  getMemoryQueryBranchName,
  isTrivialMemoryInput,
  joinHiddenBlocks,
  raceWithTimeout,
  remainingMemoryBudgetMs,
  shouldFetchMemory,
  type MemoryQueryContext,
} from '../memory/memory-context';
import { collectMemoryQueryContext } from '../memory/query-context';
import { prepareLocalMemoryContext } from '../memory/local/prepare';
import { resolveLocalMemoryPolicy } from '../memory/local/policy';
import {
  TurnDispatchTiming,
  type TurnDispatchSlowDiagnostic,
} from './turn-dispatch-timing';

const activeTurnUserMessageIds = new Map<string, string>();

function isCodexAsyncQuestionEvent(eventData: unknown): boolean {
  if (!isRecord(eventData) || eventData.type !== 'codex') return false;
  const event = eventData.event;
  if (!isRecord(event) || event.type !== 'item.completed') return false;
  const item = event.item;
  return (
    isRecord(item) && item.type === 'agent_message' && item.delivery === 'async'
  );
}

async function getChatQueueServiceForTurnLifecycle(): Promise<ChatQueueService> {
  // Keep this local import lazy to break the queue-service/worktree-chat-turn
  // cycle: queue cancellation imports this module to clear its active turn.
  // electron-vite bundles this relative module into the compiled main output;
  // build:e2e plus the Electron tab-ordering suite verify that bundled path.
  const { getChatQueueService } =
    await import('../services/chat-queue-service');
  return getChatQueueService();
}
/**
 * Forget the active-turn marker for a chat whose turn was just cancelled on
 * behalf of a force-send. The cancelled turn's terminal event may not have
 * arrived yet; without this, the immediate follow-up dispatch would trip the
 * second-active-turn guard below. The stale terminal event is still filtered
 * by the userMessageId mismatch check in the terminal handler.
 */
export function clearActiveTurnUserMessageId(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  const key = buildSessionKey(projectId, worktreeId, chatId);
  clearPresentationTurn(key, activeTurnUserMessageIds.get(key));
  activeTurnUserMessageIds.delete(key);
}
type ObservabilityIngestType = DesktopExecutionObservabilityIngest;

/** The canonical turn id a wake's root result carries (turn-state phase 40f). */
function getEventWakeTurnId(data: unknown): string | undefined {
  return typeof data === 'object' &&
    data !== null &&
    'canopy_wake_turn_id' in data &&
    typeof data.canopy_wake_turn_id === 'string'
    ? data.canopy_wake_turn_id
    : undefined;
}

function getEventTurnUserMessageId(
  data: Record<string, unknown>,
): string | null {
  return typeof data.canopy_turn_user_message_id === 'string'
    ? data.canopy_turn_user_message_id
    : null;
}

function getStartingPickupRootId(data: unknown): string | undefined {
  if (
    !isRecord(data) ||
    data.type !== 'canopy_input_delivery' ||
    data.phase !== 'picked-up' ||
    data.startsTurn !== true ||
    typeof data.userMessageId !== 'string'
  ) {
    return undefined;
  }
  return data.userMessageId;
}

function getProviderEventIngestOutcome(
  result: ProviderEventIngestResult | boolean | void,
): ProviderEventIngestOutcome {
  if (typeof result === 'object' && result !== null) return result.outcome;
  return result === false ? 'not-applied' : 'applied';
}

function resolveCodexPreferenceModelConfig(
  model: ChatModel | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  defaults: PreferencesData['providerModelConfigDefaults'] | undefined,
): AgentModelConfig | undefined {
  if (!model || getExecutionHarnessForModel(model) !== 'codex') {
    return undefined;
  }

  return resolveProviderModelConfig('codex', { thinkingLevel }, defaults);
}

function sendWorktreeChatEvent(
  getWindow: () => BrowserWindow | null,
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: unknown,
  context?: {
    providerType?: AgentProviderType;
    model?: ChatModel;
  },
): void {
  try {
    recordBackgroundProcessChatEvent(
      {
        workspaceLocalId: projectId,
        worktreeLocalId: worktreeId,
        chatId,
      },
      data,
    );
  } catch (error: unknown) {
    // The tracker is a side channel; it must never block chat delivery.
    logMainProcessError('Background-process tracking failed', error);
  }
  const delivery = sendToWindowDetailed(getWindow(), IPC_CHANNELS.chatEvent, {
    projectId,
    worktreeId,
    chatId,
    data,
  });

  if (!delivery.delivered) {
    const matchingSession = getActiveSessionInfos(projectId, worktreeId).find(
      (session): boolean => session.chatId === chatId,
    );
    const eventType = describeChatEventData(data, {
      includePhaseEvents: true,
    });
    // eslint-disable-next-line no-console
    console.warn('[chat-ipc] Renderer unavailable for worktree chat event', {
      projectId,
      worktreeId,
      chatId,
      eventType: describeChatEventData(data),
      terminal: isTerminalChatEventData(data),
      sessions: getActiveSessionInfos(projectId, worktreeId),
    });
    recordUndeliveredWorktreeEvent({
      projectId,
      worktreeId,
      chatId,
      matchingSession,
      data,
      providerType: context?.providerType,
      model: context?.model,
      eventType,
      sendFailureReason: delivery.reason,
    });
  }
}

function recordUndeliveredWorktreeEvent(options: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  matchingSession?: ChatActiveSessionInfo;
  data: unknown;
  providerType?: AgentProviderType;
  model?: ChatModel;
  eventType: string;
  sendFailureReason:
    | 'no_window'
    | 'window_destroyed'
    | 'webcontents_destroyed'
    | 'webcontents_crashed'
    | 'frame_destroyed'
    | 'frame_detached'
    | 'render_frame_disposed';
}): void {
  const eventMetadata = getDiagnosticEventMetadata(options.data);
  const timestamp = new Date().toISOString();
  void Promise.all([
    loadObservabilityIngest(),
    readPersistedChatDispatchMetadata(
      options.projectId,
      options.worktreeId,
      options.chatId,
    ).catch(
      (): PersistedChatDispatchMetadata =>
        ({}) satisfies PersistedChatDispatchMetadata,
    ),
  ])
    .then(([observabilityService, persistedMetadata]) => {
      observabilityService.recordSessionDiagnostic({
        version: 1,
        timestamp,
        kind: 'chat_event_undelivered',
        sessionKey: buildSessionKey(
          options.projectId,
          options.worktreeId,
          options.chatId,
        ),
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType:
          options.matchingSession?.providerType ??
          eventMetadata.providerType ??
          options.providerType ??
          persistedMetadata.providerType ??
          'unknown',
        ...(options.matchingSession?.model ||
        eventMetadata.model ||
        options.model ||
        persistedMetadata.model
          ? {
              model:
                options.matchingSession?.model ??
                eventMetadata.model ??
                options.model ??
                persistedMetadata.model,
            }
          : {}),
        ...(typeof options.matchingSession?.turnActive === 'boolean'
          ? { turnActive: options.matchingSession.turnActive }
          : {}),
        ...(typeof options.matchingSession?.turnCount === 'number'
          ? { turnCount: options.matchingSession.turnCount }
          : {}),
        ...(typeof options.matchingSession?.pendingMessageCount === 'number'
          ? { pendingMessageCount: options.matchingSession.pendingMessageCount }
          : {}),
        ...(options.matchingSession?.lastEventType
          ? { lastEventType: options.matchingSession.lastEventType }
          : {}),
        ...(typeof options.matchingSession?.lastActivityAt === 'number'
          ? { lastActivityAt: options.matchingSession.lastActivityAt }
          : {}),
        eventType: options.eventType,
        terminal: isTerminalChatEventData(options.data),
        sendFailureReason: options.sendFailureReason,
      });
    })
    .catch(() => {});
}

async function loadObservabilityIngest(): Promise<ObservabilityIngestType> {
  // Observability instruments this turn path, so eager loading would cycle.
  const { getExecutionObservabilityIngest } =
    await import('../observability/ingest');
  return getExecutionObservabilityIngest();
}

async function generateWorktreeChatSummary(
  userMessage: string,
  options: {
    model?: string;
    thinkingLevel?: ThinkingLevel;
    modelConfig?: AgentModelConfig;
    cwd: string;
    observabilityTaskKey: string;
    projectId?: string;
  },
): Promise<{
  text: string;
  fallback?: { reason: string; retryable?: boolean };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    totalCostUsd?: number;
    messageCount?: number;
    assistantMessageCount?: number;
  };
}> {
  return generateChatSummaryForProject(userMessage, options);
}

export interface ScheduleChatSummaryOptions {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
  getWindow: () => BrowserWindow | null;
  getAdditionalWindows?: () => Array<BrowserWindow | null>;
  linkTarget?: AgentAuditLinkTarget;
  /**
   * When set, the chat is a standalone chat under this chat-project id: the
   * generated description is also persisted to the chat's meta file and
   * broadcast over `standaloneChatMetaUpdated` so the history list updates.
   */
  standaloneChatProjectId?: string;
  /**
   * Optional main-side persistence hook for sends that have no renderer-owned
   * tab. It runs before broadcasts so derived sidebar metadata never depends
   * on the destination chat already being mounted.
   */
  persistDescription?: (description: string) => Promise<void>;
  /** Owner captured by the originating chat session before this task queues. */
  workOwner?: Promise<WorkOwner | undefined>;
}

const initialTitleRequests = new Set<string>();
/**
 * Thrown provider errors (offline, credentials, abort) leave naming pending so
 * a later turn retries; after this many in one process the fallback is saved,
 * bounding repeated helper spend.
 */
const MAX_RETRYABLE_INITIAL_TITLE_FAILURES = 3;
const retryableInitialTitleFailures = new Map<string, number>();
/**
 * Thrown canonical writes keep naming eligible; after this many in one process
 * the chat stops requesting titles until restart, so a persistently failing
 * store cannot trigger a model call on every turn.
 */
const MAX_FAILED_INITIAL_TITLE_COMMITS = 3;
const failedInitialTitleCommits = new Map<string, number>();

function settleInitialTitleAttempts(key: string): void {
  retryableInitialTitleFailures.delete(key);
  failedInitialTitleCommits.delete(key);
}

export function scheduleChatSummary(options: ScheduleChatSummaryOptions): void {
  const scope = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
  };
  const key = JSON.stringify([
    options.projectId,
    options.worktreeId,
    options.chatId,
  ]);
  if (initialTitleRequests.has(key)) return;
  if (
    (failedInitialTitleCommits.get(key) ?? 0) >=
    MAX_FAILED_INITIAL_TITLE_COMMITS
  )
    return;
  initialTitleRequests.add(key);
  void (async (): Promise<void> => {
    const service = getChatStateService();
    if (
      (await service.getInitialChatTitlePrompt(scope, options.chatId)) === null
    ) {
      settleInitialTitleAttempts(key);
      return;
    }
    await enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.chatMetadata,
      task: async (): Promise<void> => {
        const firstPrompt = await service.getInitialChatTitlePrompt(
          scope,
          options.chatId,
        );
        if (firstPrompt === null) {
          settleInitialTitleAttempts(key);
          return;
        }
        const prefs = await readPreferencesFile();
        const summaryModel = prefs.summaryModel;
        const taskKey = `helper:chat-summary:${options.projectId}/${options.worktreeId}/${options.chatId}:${Date.now()}`;
        const summaryModelConfig = resolveCodexPreferenceModelConfig(
          summaryModel,
          prefs.summaryThinkingLevel,
          prefs.providerModelConfigDefaults,
        );
        const observabilityService = await loadObservabilityIngest();
        const hasBoundWorkOwner = Object.prototype.hasOwnProperty.call(
          options,
          'workOwner',
        );
        const workOwner = hasBoundWorkOwner
          ? ((await options.workOwner) ?? null)
          : undefined;
        observabilityService.startObservedTask(taskKey, {
          id: taskKey,
          eventType: 'chat_summary',
          status: 'running',
          provider: requireProviderForModel(summaryModel),
          label: `${CHAT_LABEL} Summary`,
          startedAt: new Date().toISOString(),
          model: summaryModel,
          serviceTier: summaryModelConfig
            ? codexServiceTierForModelConfig(summaryModelConfig)
            : undefined,
          tokens: {
            input: 0,
            output: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          messageCount: 0,
          assistantMessageCount: 0,
          toolUseCount: 0,
          subAgentCount: 0,
          hasTranscript: false,
          toolCounts: {
            thinking: 0,
            bash: 0,
            read: 0,
            readLines: 0,
            writeEdit: 0,
            plan: 0,
            fileEdit: 0,
            fileAdd: 0,
            fileDelete: 0,
            search: 0,
            grep: 0,
            web: 0,
            agent: 0,
            workflow: 0,
            tasks: 0,
            taskStop: 0,
            skills: 0,
            monitor: 0,
            claude: 0,
            scheduleWakeup: 0,
            askUser: 0,
            scriptOutput: 0,
            watcher: 0,
            canopy: 0,
            graph: 0,
            appAdvisor: 0,
            pipelineEditor: 0,
            mcp: 0,
            other: 0,
          },
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          linkTarget: options.linkTarget ?? {
            page: 'main',
            kind: 'worktree-chat',
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
          },
        });
        await generateWorktreeChatSummary(firstPrompt, {
          model: summaryModel,
          thinkingLevel: prefs.summaryThinkingLevel,
          modelConfig: summaryModelConfig,
          cwd: options.cwd,
          observabilityTaskKey: taskKey,
          projectId: options.standaloneChatProjectId ?? options.projectId,
          ...(hasBoundWorkOwner ? { workOwner } : {}),
        })
          .then(async (result) => {
            if (result.fallback?.retryable === true) {
              const failures =
                (retryableInitialTitleFailures.get(key) ?? 0) + 1;
              if (failures < MAX_RETRYABLE_INITIAL_TITLE_FAILURES) {
                retryableInitialTitleFailures.set(key, failures);
                observabilityService.finalizeObservedTask(
                  taskKey,
                  'failure',
                  result.fallback.reason,
                  result.usage,
                );
                return;
              }
            }
            let settled = false;
            let committed = false;
            try {
              const applied = await service.commitInitialChatTitle(
                scope,
                options.chatId,
                result.text,
              );
              settled = true;
              settleInitialTitleAttempts(key);
              committed = applied;
              if (!applied) {
                observabilityService.finalizeObservedTask(
                  taskKey,
                  result.fallback ? 'failure' : 'cancelled',
                  result.fallback?.reason ??
                    'Initial chat title no longer eligible.',
                  result.usage,
                );
                return;
              }
              // Canonical state is already durable. Projection errors must never
              // reopen naming or hide the committed title; the observed
              // failure reports the inconsistency after the broadcasts.
              let projectionError: Error | undefined;
              try {
                await options.persistDescription?.(result.text);
              } catch (error) {
                projectionError =
                  error instanceof Error ? error : new Error(String(error));
              }
              const payload = {
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
                description: result.text,
              };
              sendToWindow(
                options.getWindow(),
                IPC_CHANNELS.chatTabDescriptionUpdated,
                payload,
              );
              for (const additionalWindow of options.getAdditionalWindows?.() ??
                []) {
                sendToWindow(
                  additionalWindow,
                  IPC_CHANNELS.chatTabDescriptionUpdated,
                  payload,
                );
              }
              if (options.standaloneChatProjectId) {
                // Entry-list metadata derives from canonical tabs; this event
                // nudges the cowork list to refresh after commitment.
                sendToWindow(
                  options.getWindow(),
                  IPC_CHANNELS.standaloneChatMetaUpdated,
                  {
                    projectId: options.standaloneChatProjectId,
                    chatId: options.chatId,
                    description: result.text,
                  },
                );
              }
              if (projectionError !== undefined) throw projectionError;
              observabilityService.finalizeObservedTask(
                taskKey,
                result.fallback ? 'failure' : 'success',
                result.fallback?.reason,
                result.usage,
              );
            } catch (error) {
              if (!settled) {
                failedInitialTitleCommits.set(
                  key,
                  (failedInitialTitleCommits.get(key) ?? 0) + 1,
                );
              }
              observabilityService.finalizeObservedTask(
                taskKey,
                'failure',
                error instanceof Error ? error.message : String(error),
                result.usage,
              );
              // eslint-disable-next-line no-console
              console.warn(
                committed
                  ? '[chat-summary] Initial title committed but projection failed'
                  : '[chat-summary] Initial title failed to commit',
                error,
              );
            }
          })
          .catch((error: unknown) => {
            observabilityService.finalizeObservedTask(
              taskKey,
              'failure',
              error instanceof Error ? error.message : String(error),
            );
          });
      },
    });
  })()
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[chat-summary] Initial naming failed', error);
    })
    .finally(() => {
      initialTitleRequests.delete(key);
    });
}

export interface ScheduleBranchNamingOptions {
  projectId: string;
  worktreeId: string;
  chatId?: string;
  text: string;
  cwd: string;
  /** Owner captured by the originating chat session before this task queues. */
  workOwner?: Promise<WorkOwner | undefined>;
  /** Window told about the recorded rename. */
  getWindow?: () => BrowserWindow | null;
}

export function scheduleBranchNaming(
  options: ScheduleBranchNamingOptions,
): void {
  const taskKeyScope = options.chatId ?? 'task-ready';
  const branchTaskKey = `helper:branch-naming:${options.projectId}/${options.worktreeId}/${taskKeyScope}:${Date.now()}`;
  const observabilityServicePromise = loadObservabilityIngest();
  void enqueueBackgroundHelperTask({
    priority: BACKGROUND_HELPER_PRIORITIES.branchNaming,
    task: async (): Promise<void> => {
      const prefs = await readPreferencesFile();
      const branchNamingModel = prefs.branchNamingModel;
      const branchNamingModelConfig = resolveCodexPreferenceModelConfig(
        branchNamingModel,
        prefs.branchNamingThinkingLevel,
        prefs.providerModelConfigDefaults,
      );
      const observabilityService = await observabilityServicePromise;
      const hasBoundWorkOwner = Object.prototype.hasOwnProperty.call(
        options,
        'workOwner',
      );
      const workOwner = hasBoundWorkOwner
        ? ((await options.workOwner) ?? null)
        : undefined;
      observabilityService.startObservedTask(branchTaskKey, {
        id: branchTaskKey,
        eventType: 'branch_naming',
        status: 'running',
        provider: requireProviderForModel(branchNamingModel),
        label: 'Branch Naming',
        startedAt: new Date().toISOString(),
        model: branchNamingModel,
        serviceTier: branchNamingModelConfig
          ? codexServiceTierForModelConfig(branchNamingModelConfig)
          : undefined,
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        messageCount: 0,
        assistantMessageCount: 0,
        toolUseCount: 0,
        subAgentCount: 0,
        hasTranscript: false,
        toolCounts: {
          thinking: 0,
          bash: 0,
          read: 0,
          readLines: 0,
          writeEdit: 0,
          plan: 0,
          fileEdit: 0,
          fileAdd: 0,
          fileDelete: 0,
          search: 0,
          grep: 0,
          web: 0,
          agent: 0,
          workflow: 0,
          tasks: 0,
          taskStop: 0,
          skills: 0,
          monitor: 0,
          claude: 0,
          scheduleWakeup: 0,
          askUser: 0,
          scriptOutput: 0,
          watcher: 0,
          canopy: 0,
          graph: 0,
          appAdvisor: 0,
          pipelineEditor: 0,
          mcp: 0,
          other: 0,
        },
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        linkTarget: {
          page: 'main',
          kind: 'worktree-chat',
          projectId: options.projectId,
          worktreeId: options.worktreeId,
        },
      });

      const branchResult = await doesBranchMatchWorktreeId(
        options.projectId,
        options.worktreeId,
        options.cwd,
      );
      if (!branchResult.matches) {
        observabilityService.finalizeObservedTask(branchTaskKey, 'success');
        return;
      }

      const alreadySent = await isBranchPromptSent(
        options.projectId,
        options.worktreeId,
      );
      if (!alreadySent) {
        await recordWorktreeDiscovery({
          kind: 'branch-prompt',
          workspaceId: options.projectId,
          worktreeId: options.worktreeId,
          sent: true,
        });
      }

      const branchUsage = await generateAndRenameBranch({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        cwd: options.cwd,
        userMessage: options.text,
        branchResult,
        observabilityTaskKey: branchTaskKey,
        modelConfig: branchNamingModelConfig,
        // ONE resolution, shared with the audit entry stamped above. Letting
        // the helper resolve its own could name a different model than the one
        // recorded, across a settling probe or credits read.
        resolvedModel: branchNamingModel,
        ...(hasBoundWorkOwner ? { workOwner } : {}),
        ...(options.getWindow ? { getWindow: options.getWindow } : {}),
      });
      observabilityService.finalizeObservedTask(
        branchTaskKey,
        'success',
        undefined,
        branchUsage,
      );
    },
  }).catch((error: unknown) => {
    void observabilityServicePromise.then((observabilityService) => {
      observabilityService.finalizeObservedTask(
        branchTaskKey,
        'failure',
        error instanceof Error ? error.message : String(error),
        readHelperUsage(error),
      );
    });
    void recordWorktreeDiscovery({
      kind: 'branch-prompt',
      workspaceId: options.projectId,
      worktreeId: options.worktreeId,
      sent: false,
    });
  });
}

export interface DispatchWorktreeChatTurnOptions<
  TBeforeResult extends boolean | void | ProviderEventIngestResult =
    | boolean
    | void
    | ProviderEventIngestResult,
> {
  /** Host-only queue admission capability, consumed before any start effect. */
  authorization?: AuthorizedChatDispatch;
  turnDispatchTiming?: TurnDispatchTiming;
  /** Run with the live session's settings (Run now, generated deliveries). */
  useLiveSessionSettings?: true;
  /** Trusted quota continuation: refuse any other billing connection. */
  requiredAccountProxyConnectionId?: string;
  countsTowardSkillUsage?: boolean;
  managedDelegationDeliveryId?: string;
  internalRow?: ChatSendMessageRequest['internalRow'];
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  text: string;
  planMode: boolean;
  approvalMode?: ApprovalMode;
  sessionApprovalRules?: ApprovalRule[];
  admittedApproval?: ChatSendMessageRequest['admittedApproval'];
  modelConfig?: AgentModelConfig;
  thinkingLevel?: ThinkingLevel;
  model?: ChatModel;
  modelSelectionMode?: ChatSendMessageRequest['modelSelectionMode'];
  providerType?: AgentProviderType;
  executionHarness?: ChatSendMessageRequest['executionHarness'];
  modelRouting?: ChatSendMessageRequest['modelRouting'];
  pluginSelections?: ChatTabPluginSelections;
  packageOverlay?: PipelinePackageCapabilityOverlay;
  deferredToolsAllowed?: boolean;
  sdkSessionId?: string;
  globalInstructionsSnapshot?: string;
  /** Retained native response items used to materialize an imported Codex thread. */
  codexReconstructionSeedId?: string;
  /** Fork the resumed Claude session instead of continuing it in place. */
  claudeForkSession?: boolean;
  /** Chain uuid the forked resume stops at (SDK `resumeSessionAt`). */
  claudeForkResumeAt?: string;
  /** Start fresh and persist the fork's lost-context disclosure on init. */
  claudeForkStartsFresh?: boolean;
  /** Answers for the calls a point-in-time fork anchor left open. */
  claudeForkToolResults?: ChatSendMessageRequest['claudeForkToolResults'];
  codexProposalMode?: 'optional' | 'required';
  /** @deprecated Use modelConfig.fastMode. */
  codexFastModeEnabled?: boolean;
  fileReferences?: FileReference[];
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatSendMessageRequest['attachmentPromptContexts'];
  inputMode?: 'typed' | 'voice';
  agentSent?: ChatSendMessageRequest['agentSent'];
  hiddenContext?: ChatSendMessageRequest['hiddenContext'];
  pendingSystemInstructions?: ChatSendMessageRequest['pendingSystemInstructions'];
  /**
   * The tracked plan the user had active when sending, validated by the
   * caller. Resolved into a one-turn plan-file instruction; never stored on
   * the tab and never used by hidden continuations.
   */
  activePlan?: ChatSendMessageRequest['activePlan'];
  /**
   * For multi-repo workspaces: the repo whose worktree checkout the agent
   * should run in. Resolves to a child repo path or the workspace root.
   */
  selectedRepoId?: string;
  initiationSource?: UsageInitiationSource;
  /**
   * Who started the turn for chat turn analytics, when that differs from
   * `initiationSource`, which also drives dispatch behavior.
   */
  turnTrigger?: UsageInitiationSource;
  /**
   * Trusted background-run binding or the tab's persisted context, never a
   * renderer request. Org memory uses it for linked Personal projects;
   * absent means the live sidebar context, read once.
   */
  executionContext?: string;
  startsNewTrackedChat?: boolean;
  /**
   * Per-session AI Credits fallback routing decision (CAN-838). Threaded from
   * `ChatSendMessageRequest` into `AgentSessionOptions` so the provider session
   * injects gateway proxy env at spawn. Absent when the tab is not routing.
   */
  aiCreditsRouting?: AiCreditsRoutingState;
  /**
   * Per-chat billing-framework override forcing native subscription billing
   * for this turn, threaded from `ChatSendMessageRequest` into
   * `AgentSessionOptions`. Absent when the tab has no explicit override.
   */
  subscriptionBillingOverride?: boolean;
  getWindow: () => BrowserWindow | null;
  onChatEvent?: (event: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    data: unknown;
    /** Root-aware terminal classification for downstream lifecycle consumers. */
    isTerminalEvent: boolean;
    /** The exact completion returned by this event's durable before-hook. */
    beforeChatEventResult?: TBeforeResult;
    /** Compatibility-normalized delivery decision for this completion. */
    ingestResult?: ProviderEventIngestResult;
  }) => void;
  /**
   * Persist a provider event before it becomes observable outside main.
   * Structured results carry canonical pickup acceptance independently from
   * whether the event itself was applied. Legacy booleans/void remain for
   * non-pickup callers; they never authorize a starting pickup root.
   */
  onBeforeChatEvent: (event: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    data: unknown;
    /** Distinguishes a resumed provider stream whose sequence restarts at 0. */
    sequenceNamespace: string;
    sequence: number;
    /** Undefined only for an untagged provider event that revives a settled turn. */
    turnUserMessageId?: string;
    /**
     * The provider whose session produced the event. Persistence prefers it
     * over the requested provider, so provider-scoped admission (such as
     * trusted visual promotion) sees the provider that actually ran.
     */
    providerType?: AgentProviderType;
    /**
     * Present for a streamed event whose commit may overlap the next one.
     * Call it once the commit holds its place in the scope's commit order
     * (the repository's `onQueued`); the next event's commit then starts
     * without waiting for this one to be durable. A hook that never calls it
     * keeps one commit at a time.
     */
    onCommitQueued?: () => void;
  }) => Promise<TBeforeResult>;
  /** Runs synchronously after the provider session accepts the user message. */
  onTurnAccepted?: () => void;
  /** Trusted host cancellation checked immediately before provider acceptance. */
  admissionSignal?: AbortSignal;
  skipBranchNaming?: boolean;
  hiddenDeferredContinuation?: boolean;
  /** Distinguishes hidden same-turn prompts for observability. */
  hiddenContinuationKind?: 'deferred_tools_reload' | 'stopped_turn_resume';
  deferredToolsReloadEnabledResources?: DeferredResourceSummary[];
  /** Internal durable-event namespace for a resumed provider stream. */
  providerEventSequenceNamespace?: string;
}

async function buildWorktreeSystemPromptAppend(options: {
  projectId: string;
  worktreeId: string;
  selectedRepoId?: string;
  providerPromptKind: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode';
  planMode: boolean;
  codeGraphToolsAdvertised: boolean;
  localMemoryEnabled: boolean;
  includeChatVisuals: boolean;
}): Promise<string> {
  // Compute the code-graph feature gate ONCE per turn and thread the boolean
  // into the prompt builders (avoids repeated flag-service reads on a hot
  // path). When off, no code-graph tool bullets and no availability nudge —
  // otherwise the prompt would reference tools the agent cannot call.
  const codeGraphEnabled =
    options.providerPromptKind !== 'cursor' &&
    options.providerPromptKind !== 'copilot' &&
    options.providerPromptKind !== 'opencode' &&
    options.codeGraphToolsAdvertised &&
    isCodeGraphAvailableForWorkspace(options.projectId);
  // The Cursor session appends its own injected-tool and local-memory
  // steering once it knows the app's MCP servers reached the CLI; emitting it
  // here would advertise tools that may not exist for that turn.
  const isCursor =
    options.providerPromptKind === 'cursor' ||
    options.providerPromptKind === 'copilot' ||
    options.providerPromptKind === 'opencode';
  const promptParts = isCursor
    ? []
    : [
        buildWorktreeInjectedToolPrompt(
          options.providerPromptKind,
          codeGraphEnabled,
          true,
          options.includeChatVisuals,
        ),
      ];
  const codeGraphAvailabilityPrompt = codeGraphEnabled
    ? buildCodeGraphAvailabilityPrompt(options.projectId, options.worktreeId, {
        liveAvailable: codeGraphEnabled,
        toolsAdvertised: options.codeGraphToolsAdvertised,
      })
    : undefined;
  if (codeGraphAvailabilityPrompt) {
    promptParts.push(codeGraphAvailabilityPrompt);
  }
  if (options.planMode) {
    const workspacePlanScopePrompt = await buildPlanModeWorkspaceScopePrompt(
      options.projectId,
      options.selectedRepoId,
    );
    if (workspacePlanScopePrompt) {
      promptParts.push(workspacePlanScopePrompt);
    }
  }
  const memoryPolicy = await resolveLocalMemoryPolicy(options);
  const localMemoryPrompt = buildLocalMemoryPromptNudge(
    !isCursor && options.localMemoryEnabled,
    memoryPolicy.kind === 'scoped' && memoryPolicy.privateMemory,
  );
  if (localMemoryPrompt) {
    promptParts.push(localMemoryPrompt);
  }
  return promptParts.join('\n\n');
}

async function resolveUsageChatScope(options: {
  projectId: string;
  isCoworkChat: boolean;
  selectedRepoId?: string;
}): Promise<{ repoId?: string; repoLabel?: string }> {
  if (options.isCoworkChat) {
    return {};
  }
  const config = await readWorkspaceConfig(options.projectId).catch(() => null);
  if (!config) {
    return {};
  }
  if (config.type === 'single-repo') {
    return {
      repoId: SINGLE_REPO_USAGE_REPO_ID,
      repoLabel: config.repoPath ? basename(config.repoPath) : 'Repository',
    };
  }
  const selectedRepoId = options.selectedRepoId ?? WORKSPACE_ROOT_REPO_ID;
  if (selectedRepoId === WORKSPACE_ROOT_REPO_ID) {
    return config.sourceRepoPath
      ? {
          repoId: WORKSPACE_ROOT_REPO_ID,
          repoLabel: WORKSPACE_ROOT_REPO_NAME,
        }
      : {};
  }
  const repo = config.repos.find((entry) => entry.id === selectedRepoId);
  return repo ? { repoId: repo.id, repoLabel: repo.name } : {};
}

interface PreparedOrgMemory {
  attempt: OrgMemoryFetchAttempt;
}

export async function prepareLocalMemory(options: {
  userText: string;
  projectId: string;
  worktreeId: string;
}): Promise<{ renderedBlock: string } | null> {
  return prepareLocalMemoryContext(options);
}

/**
 * Whether a person started the turn: a desktop or Portal send. Hooks,
 * automations, App Advisor dispatches, and unknown sources are background
 * turns. Matches dispatch's own default of `user` for an unset source, so a
 * background dispatcher must set its source explicitly. Hook and automation
 * turns already skip memory in shouldFetchMemory.
 *
 * A Portal send drives this desktop, so a tab with no captured context runs
 * in the desktop's selected context, as the rest of that turn does. The
 * linked-org match still applies, so it can never reach an unlinked org.
 */
function isUserInitiatedTurn(
  initiationSource: UsageInitiationSource | undefined,
): boolean {
  const source = initiationSource ?? 'user';
  return source === 'user' || source === 'portal';
}

export async function prepareOrgMemory(options: {
  userText: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  selectedRepoId?: string;
  executionContext?: string;
  hiddenContextKind?: string;
  initiationSource?: UsageInitiationSource;
  signal?: AbortSignal;
}): Promise<PreparedOrgMemory | null> {
  const preferences = await readPreferencesFile().catch(() => null);
  // Cheap pre-gate on preferences + input triviality avoids any I/O (credential
  // or workspace-config reads) for disabled or trivial turns.
  if (
    !preferences ||
    !preferences.orgMemoryInjectionEnabled ||
    isTrivialMemoryInput(options.userText)
  ) {
    return null;
  }

  // Resolve the real capability signal first, so accounts without memorySearch
  // or with no eligible organization bail out before the owner lookup's config,
  // chat-tab and workspace-context reads.
  const credentials = await getCanopyCloudCredentials().catch(() => null);
  if (
    !credentials?.capabilities.includes(MEMORY_SEARCH_CAPABILITY) ||
    credentials.memorySearchOrganizationExternalIds.length === 0
  ) {
    return null;
  }

  if (
    !shouldFetchMemory({
      userText: options.userText,
      memoryInjectionEnabled: preferences.orgMemoryInjectionEnabled,
      capabilityPresent: true,
      ...(options.hiddenContextKind !== undefined
        ? { hiddenContextKind: options.hiddenContextKind }
        : {}),
      ...(options.initiationSource !== undefined
        ? { initiationSource: options.initiationSource }
        : {}),
    })
  ) {
    return null;
  }

  // Org memory follows the owner of the work (CAN-3457), so Personal and App
  // Advisor turns make no request at all. A Cowork workspace follows its saved
  // owner (CAN-3477). Never a default or fallback org.
  const owner = await resolveOrgMemoryOwner({
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    ...(options.executionContext !== undefined
      ? { executionContext: options.executionContext }
      : {}),
    readPersistedExecutionContext: () =>
      readPersistedChatExecutionContext(
        options.projectId,
        options.worktreeId,
        options.chatId,
      ),
    // Dispatch treats an unset source as a user turn.
    userInitiated: isUserInitiatedTurn(options.initiationSource),
  });
  if (owner === null) return null;

  // The owning org must be one the account may search. When it is not, search
  // nothing: never try another eligible org. The lapse check repeats the
  // request gate's, but here it skips the query-context reads below.
  const eligibleOrganization = normalizeOrganizationExternalId(
    owner.organizationId,
  );
  if (
    eligibleOrganization === null ||
    !credentials.memorySearchOrganizationExternalIds.includes(
      eligibleOrganization,
    ) ||
    (await isOrganizationTeamsLapsed(eligibleOrganization))
  ) {
    return null;
  }
  // A Cowork entry id sits in the worktreeId slot, so the query-context read
  // works unchanged; Cowork has no repo label and no branch. Cowork-ness comes
  // from the same persisted read that chose the owner, not the sidebar
  // registry, which may not have observed a new workspace yet.
  const isCoworkChat = owner.isCowork;
  const [usageScope, queryContext, persistedBranch] = await Promise.all([
    resolveUsageChatScope({
      projectId: options.projectId,
      isCoworkChat,
      selectedRepoId: options.selectedRepoId,
    }).catch((): { repoId?: string; repoLabel?: string } => ({})),
    collectMemoryQueryContext({
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
      currentUserMessageId: options.userMessageId,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }).catch(
      (): MemoryQueryContext => ({
        recentUserMessages: [],
        summaryDescription: null,
      }),
    ),
    isCoworkChat
      ? Promise.resolve(null)
      : readPersistedWorktreeBranch(
          options.projectId,
          options.worktreeId,
        ).catch(() => null),
  ]);

  const queryText = buildMemoryQuery(
    options.userText,
    getMemoryQueryBranchName(
      persistedBranch?.worktreeId ?? options.worktreeId,
      persistedBranch?.branchName ?? null,
    ),
    usageScope.repoLabel,
    queryContext,
  );
  // The raw human-typed message rides alongside the enriched query so the
  // server's lexical lanes can score against a short string instead of the
  // multi-line enriched text.
  const lexicalQuery = options.userText.trim().slice(0, MEMORY_QUERY_MAX_CHARS);
  return {
    attempt: await fetchOrgMemoryAttempt(
      eligibleOrganization,
      queryText,
      false,
      lexicalQuery,
    ),
  };
}

export interface PreparedWorktreeTurnSessionConfiguration {
  codeGraphToolsAdvertised: boolean;
  systemPromptAppend: string;
  sessionSystemPromptAppend: string;
  globalInstructionsBlock: string;
  runtime: Awaited<ReturnType<typeof resolveAgentModelRuntime>> | undefined;
  runtimeProviderType: AgentProviderType;
  runtimeModel: ChatModel | undefined;
  effectiveModelConfig: ReturnType<typeof resolveProviderModelConfig>;
  managedDelegationMode: PreferencesData['managedDelegationMode'];
  managedDelegationMaxConcurrent: PreferencesData['managedDelegationMaxConcurrent'];
  managedDelegationMaxDepth: PreferencesData['managedDelegationMaxDepth'];
  managedDelegationLifetimeLimit: PreferencesData['managedDelegationLifetimeLimit'];
  codexPreferences: PreferencesData | null;
  rtkEnabled: boolean;
}

export interface PreparedWorktreeTurnSession {
  cwd: string;
  sessionKey: string;
  existingCodeGraphToolsAdvertised: boolean | undefined;
  currentCodeGraphToolsAvailable: boolean;
  persistedDispatchMetadata: PersistedChatDispatchMetadata;
  selectedModel: ChatModel | undefined;
  effectiveProviderType: AgentProviderType;
  effectiveExecutionHarness: NonNullable<
    ChatSendMessageRequest['executionHarness']
  >;
  deferredToolsAllowed: boolean;
  resolveSessionConfiguration(
    this: void,
    advertised: boolean,
  ): Promise<PreparedWorktreeTurnSessionConfiguration>;
  get sessionConfiguration(): PreparedWorktreeTurnSessionConfiguration;
  set sessionConfiguration(
    configuration: PreparedWorktreeTurnSessionConfiguration,
  );
  buildSessionOptions(
    this: void,
  ): Parameters<typeof getOrCreateRoutedSession>[0];
}

/**
 * Resolves provider-session inputs without running the dispatch-owned memory,
 * attachment, branch-naming, or chat-summary work.
 */
export async function prepareWorktreeTurnSession<
  TBeforeResult extends boolean | void | ProviderEventIngestResult =
    | boolean
    | void
    | ProviderEventIngestResult,
>(
  options: DispatchWorktreeChatTurnOptions<TBeforeResult>,
  timing?: TurnDispatchTiming,
  preparationOptions: {
    checkModelAvailability?: boolean;
    beforeSessionConfiguration?: () => Promise<void>;
  } = {},
): Promise<PreparedWorktreeTurnSession> {
  const turnDispatchTiming =
    timing ?? options.turnDispatchTiming ?? new TurnDispatchTiming();
  await assertCoworkChatRootPresent(options.projectId, options.worktreeId);
  const isCoworkChat = isCoworkWorkspace(options.projectId);
  const isLegacyStandalone = options.projectId === STANDALONE_CHAT_PROJECT_ID;
  const isPlanExplore = options.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID;
  const isCodeReview = options.projectId === CODE_REVIEW_CHAT_PROJECT_ID;
  const cwd = resolveWorktreeCwd(
    options.projectId,
    options.worktreeId,
    options.selectedRepoId,
  );
  const sessionKey = buildSessionKey(
    options.projectId,
    options.worktreeId,
    options.chatId,
  );
  const existingCodeGraphToolsAdvertised = getSessionCodeGraphToolsAdvertised(
    options.projectId,
    options.worktreeId,
    options.chatId,
  );
  const currentCodeGraphToolsAvailable =
    !isCoworkChat &&
    !isPlanExplore &&
    !isCodeReview &&
    isCodeGraphAvailableForWorkspace(options.projectId);
  const persistedDispatchMetadata = await turnDispatchTiming.measure(
    'dispatch_metadata',
    () =>
      readPersistedChatDispatchMetadata(
        options.projectId,
        options.worktreeId,
        options.chatId,
      ).catch(
        (): PersistedChatDispatchMetadata =>
          ({}) satisfies PersistedChatDispatchMetadata,
      ),
  );
  const preferences = await readPreferencesFile().catch(() => null);
  const laneDefault =
    options.model === undefined && preferences
      ? await requireLaneAwareDefaultSelection(
          preferences,
          isCoworkChat ? 'chat' : 'worktree',
          // Same workspace the session spawn resolves its environment for
          // (`claude-session.ts` / `codex-session.ts` pass `opts.projectId`),
          // so a Canopy Environments credential is judged against the SAME
          // effective environment the turn will actually run in.
          { workspaceId: options.projectId },
          options.providerType,
          // Forced to this turn's provider, so it answers "what should THIS
          // turn run?" rather than "what is the user's default model?" and
          // must not stamp the Portal catalog projection.
          false,
        )
      : undefined;
  const selectedModel = options.model ?? laneDefault?.model;
  // See `resolveLaneSubstitutedProviderType`: lane resolution can hand back a
  // native model from a DIFFERENT lane than the forced `providerType`, and
  // pinning that provider over it trips the harness guard below.
  const laneSubstitutedProviderType = resolveLaneSubstitutedProviderType({
    explicitModel: options.model,
    requestedProviderType: options.providerType,
    selectedModel,
  });
  // An explicitly supplied `providerType` is otherwise AUTHORITATIVE on both
  // branches. It carries the chat's persisted provider lock for a resumed
  // session, and deriving the provider from the lane-resolved model instead
  // let a caller that asked for `'codex'` silently land on `'claude'` when
  // the Codex lane was not the one that resolved.
  const effectiveProviderType =
    laneSubstitutedProviderType ??
    options.providerType ??
    (options.model !== undefined
      ? requireProviderForModel(options.model)
      : selectedModel
        ? requireProviderForModel(selectedModel)
        : 'claude');
  const deferredToolsAllowed =
    options.deferredToolsAllowed ??
    persistedDispatchMetadata.deferredToolsAllowed ??
    true;
  const effectiveExecutionHarness =
    // A cross-lane substitution invalidates the persisted harness lock: the
    // model that will actually run is the substituted one, so the harness
    // must follow it rather than the lane the chat used to be on.
    (laneSubstitutedProviderType && selectedModel
      ? getExecutionHarnessForModel(selectedModel)
      : undefined) ??
    persistedDispatchMetadata.executionHarness ??
    (persistedDispatchMetadata.model
      ? getExecutionHarnessForModel(persistedDispatchMetadata.model)
      : undefined) ??
    (selectedModel ? getExecutionHarnessForModel(selectedModel) : undefined) ??
    (effectiveProviderType === 'codex' ? 'codex' : 'claude');
  if (
    options.executionHarness !== undefined &&
    options.executionHarness !== effectiveExecutionHarness &&
    // A cross-lane substitution invalidates the CALLER's harness too, not
    // just the persisted one. The renderer forwards the tab's persisted
    // harness verbatim (`stores/chat/slices/messaging.ts`,
    // `executionHarness: currentTab?.executionHarness`), and that field is
    // only persisted once a tab has real conversation content
    // (`chatTabHasConversationContent`, `persisted-tabs.ts`) — which is what
    // keeps this substitution path narrow. So a Codex-locked chat whose Codex
    // lane is down arrives here with `executionHarness: 'codex'` while
    // routing has already moved it to Claude, and throwing there is exactly
    // the dead end the substitution exists to remove, relocated one line down.
    laneSubstitutedProviderType === undefined
  ) {
    throw new Error('Chat execution harness does not match host-owned routing');
  }
  if (
    preparationOptions.checkModelAvailability !== false &&
    effectiveExecutionHarness === 'opencode'
  ) {
    await assertOpenCodeSelectionAvailable({
      model: selectedModel ?? persistedDispatchMetadata.model,
      session: {
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        ...(options.executionContext === undefined
          ? {}
          : { executionContext: options.executionContext }),
      },
    });
  }
  if (
    preparationOptions.checkModelAvailability !== false &&
    effectiveExecutionHarness === 'copilot'
  ) {
    await assertCopilotModelAvailable(
      selectedModel ?? persistedDispatchMetadata.model,
    );
  }
  await preparationOptions.beforeSessionConfiguration?.();
  const normalizedModelConfig = normalizeAgentModelConfig(options.modelConfig);
  let repoRulesBlockPromise: Promise<string> | undefined;
  const resolveSessionConfiguration = async (
    advertised: boolean,
  ): Promise<PreparedWorktreeTurnSessionConfiguration> => {
    const providerPromptKind = effectiveExecutionHarness;
    const codeGraphToolsAdvertised =
      effectiveExecutionHarness !== 'cursor' && advertised;
    const coworkMemoryPolicy = isCoworkChat
      ? await resolveLocalMemoryPolicy(options)
      : null;
    const systemPromptAppend = isCoworkChat
      ? buildCoworkDispatchSystemPromptAppend(
          providerPromptKind,
          preferences?.localMemoryEnabled === true,
          coworkMemoryPolicy?.kind === 'scoped' &&
            coworkMemoryPolicy.privateMemory,
          chatVisualsPromptEligible(effectiveProviderType, 'cowork'),
        )
      : isCodeReview
        ? `${buildCodeReviewPrompt()}\n\n${buildWorktreeInjectedToolPrompt(
            providerPromptKind,
            false,
            true,
            chatVisualsPromptEligible(effectiveProviderType, 'worktree'),
          )}`
        : await buildWorktreeSystemPromptAppend({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            selectedRepoId: options.selectedRepoId,
            providerPromptKind,
            planMode: options.planMode,
            codeGraphToolsAdvertised,
            localMemoryEnabled: preferences?.localMemoryEnabled === true,
            includeChatVisuals: chatVisualsPromptEligible(
              effectiveProviderType,
              'worktree',
            ),
          });
    const runtime = selectedModel
      ? await resolveAgentModelRuntime({
          projectId: options.projectId,
          model: selectedModel,
          systemPromptAppend,
          pluginSelections: options.pluginSelections,
          providerType: effectiveProviderType,
        })
      : undefined;
    const runtimeProviderType = runtime?.providerType ?? effectiveProviderType;
    const runtimeModel = runtime?.runtimeModel ?? selectedModel;
    // Global Instructions (Instructions settings) resolve into a "User Overall
    // Preferences" block per session context. Composed here so it reaches
    // provider sessions only when a session is (re)created — live sessions
    // are unaffected until their next creation.
    const chatGlobalInstructions = preferences?.globalInstructions?.chats;
    const currentGlobalInstructionsBlock = chatGlobalInstructions
      ? buildUserOverallPreferencesBlock(chatGlobalInstructions, {
          harness: runtimeProviderType,
          model: resolveModelAlias(runtimeModel ?? ''),
          workspaceType: isCoworkChat ? 'cowork' : 'code',
        })
      : '';
    const resumingProviderSession =
      options.sdkSessionId !== undefined &&
      laneSubstitutedProviderType === undefined;
    const globalInstructionsBlock = await selectSessionInstructions({
      provider: runtimeProviderType,
      isInteractiveCode:
        !isCoworkChat &&
        !isLegacyStandalone &&
        !isPlanExplore &&
        !isCodeReview &&
        options.projectId !== APP_ADVISOR_PROJECT_ID &&
        !options.hiddenDeferredContinuation &&
        (options.initiationSource === undefined ||
          options.initiationSource === 'user'),
      resumed: resumingProviderSession,
      saved: options.globalInstructionsSnapshot,
      active:
        laneSubstitutedProviderType === undefined
          ? getSessionGlobalInstructionsSnapshot(
              options.projectId,
              options.worktreeId,
              options.chatId,
            )
          : undefined,
      activeProvider: getSessionProviderType(
        options.projectId,
        options.worktreeId,
        options.chatId,
      ),
      currentGlobal: currentGlobalInstructionsBlock,
      compose: () => {
        repoRulesBlockPromise ??= composeWorktreeRepoRules(
          options.projectId,
          options.worktreeId,
          cwd,
        );
        return repoRulesBlockPromise;
      },
    });
    const composedSystemPromptAppend =
      appendUserOverallPreferencesBlock(
        runtime?.systemPromptAppend ?? systemPromptAppend,
        globalInstructionsBlock,
      ) ?? systemPromptAppend;
    const effectiveModelConfig = resolveProviderModelConfig(
      effectiveExecutionHarness,
      {
        thinkingLevel: options.thinkingLevel ?? laneDefault?.thinkingLevel,
        modelConfig: {
          ...(normalizedModelConfig ?? {}),
          ...(normalizedModelConfig?.fastMode === undefined &&
          typeof options.codexFastModeEnabled === 'boolean'
            ? { fastMode: options.codexFastModeEnabled }
            : {}),
        },
      },
      preferences?.providerModelConfigDefaults,
    );
    return {
      codeGraphToolsAdvertised,
      systemPromptAppend: composedSystemPromptAppend,
      sessionSystemPromptAppend:
        runtime?.systemPromptAppend ?? systemPromptAppend,
      globalInstructionsBlock,
      runtime,
      runtimeProviderType,
      runtimeModel,
      effectiveModelConfig,
      managedDelegationMode: preferences?.managedDelegationMode,
      managedDelegationMaxConcurrent:
        preferences?.managedDelegationMaxConcurrent,
      managedDelegationMaxDepth: preferences?.managedDelegationMaxDepth,
      managedDelegationLifetimeLimit:
        preferences?.managedDelegationLifetimeLimit,
      codexPreferences:
        effectiveExecutionHarness === 'codex' ? preferences : null,
      // Claude and Cursor both rewrite shell commands through the bundled
      // RTK hook; Codex has no rewrite seam.
      rtkEnabled:
        effectiveExecutionHarness === 'claude' ||
        effectiveExecutionHarness === 'copilot' ||
        effectiveExecutionHarness === 'opencode' ||
        effectiveExecutionHarness === 'cursor'
          ? preferences?.rtkEnabled !== false
          : false,
    };
  };

  let sessionConfiguration = await turnDispatchTiming.measure(
    'session_config',
    () =>
      resolveSessionConfiguration(
        existingCodeGraphToolsAdvertised ?? currentCodeGraphToolsAvailable,
      ),
  );

  // Without approval authority, which is read just before the session is
  // created; reuse checks do not compare it.
  const buildSessionOptions = (): Parameters<
    typeof getOrCreateRoutedSession
  >[0] => ({
    cwd,
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
    ...(options.executionContext === undefined
      ? {}
      : { executionContext: options.executionContext }),
    planMode: options.planMode,
    codexProposalMode: options.codexProposalMode,
    thinkingLevel: sessionConfiguration.effectiveModelConfig.thinkingLevel,
    modelConfig: sessionConfiguration.effectiveModelConfig,
    requiredAccountProxyConnectionId: options.requiredAccountProxyConnectionId,
    model: sessionConfiguration.runtimeModel,
    selectedModel,
    // A cross-lane substitution changes WHICH PROVIDER runs, and a provider's
    // session id is meaningless to the other one. `getOrCreateSession` has no
    // provider-change guard, so forwarding it verbatim handed a persisted
    // Codex thread id straight to a Claude session. Dropping it starts a
    // fresh session on the substituted provider instead.
    // `codexReconstructionSeedId` is likewise a Codex-only resume identifier.
    //
    // KNOWN LIMITATION (CAN-1929): the new provider session starts with NO
    // replay of the persisted conversation — `AgentSessionOptions` carries no
    // cross-provider reconstruction path — so on the one reachable
    // established-chat case the UI keeps showing history the agent cannot see.
    // That case is narrow: substitution requires `explicitModel === undefined`
    // (see `resolveLaneSubstitutedProviderType`), and a tab only becomes
    // model-less-with-a-session-id when its persisted model stops resolving
    // against the registry (`resolveKnownModel` → `undefined` during
    // hydration), e.g. a model retired between releases.
    //
    // Deliberately NOT resolved by refusing substitution for established
    // conversations: that reinstates the hard dead end this exists to remove,
    // and round-3 coverage
    // ("reconciles a substitution against the CALLER persisted harness")
    // pins the drop-the-session-id behavior. Proper cross-provider
    // reconstruction (replay + an atomic tab metadata swap) is the real fix
    // and is larger than this change.
    ...(laneSubstitutedProviderType
      ? {}
      : {
          sdkSessionId: options.sdkSessionId,
          codexReconstructionSeedId: options.codexReconstructionSeedId,
        }),
    ...(options.claudeForkSession ? { claudeForkSession: true } : {}),
    ...(options.claudeForkSession && options.claudeForkResumeAt
      ? { claudeForkResumeAt: options.claudeForkResumeAt }
      : {}),
    ...(options.claudeForkSession &&
    options.claudeForkResumeAt &&
    options.claudeForkToolResults?.length
      ? { claudeForkToolResults: options.claudeForkToolResults }
      : {}),
    ...(options.claudeForkStartsFresh ? { claudeForkStartsFresh: true } : {}),
    pluginSelections:
      sessionConfiguration.runtime?.pluginSelections ??
      options.pluginSelections,
    ...(options.packageOverlay
      ? { packageOverlay: options.packageOverlay }
      : {}),
    applyGlobalPluginDefaults: chatSurfaceUsesGlobalPluginDefaults(
      options.projectId,
    ),
    deferredToolsAllowed,
    // Already composed in resolveSessionConfiguration: runtime (Agent)
    // append plus the Global Instructions block.
    systemPromptAppend: sessionConfiguration.sessionSystemPromptAppend,
    globalInstructionsBlock: sessionConfiguration.globalInstructionsBlock,
    globalInstructionsSnapshot:
      options.sdkSessionId !== undefined &&
      laneSubstitutedProviderType === undefined
        ? sessionConfiguration.globalInstructionsBlock
        : undefined,
    managedDelegationSurface:
      !isCoworkChat && !isPlanExplore && !isCodeReview
        ? 'worktree-chat'
        : undefined,
    managedDelegationMaxConcurrent:
      sessionConfiguration.managedDelegationMaxConcurrent,
    managedDelegationMaxDepth: sessionConfiguration.managedDelegationMaxDepth,
    managedDelegationLifetimeLimit:
      sessionConfiguration.managedDelegationLifetimeLimit,
    managedDelegationMode:
      !isCoworkChat && !isPlanExplore && !isCodeReview
        ? resolveManagedDelegationMode(
            sessionConfiguration.managedDelegationMode,
          )
        : undefined,
    providerType: sessionConfiguration.runtimeProviderType,
    executionHarness: effectiveExecutionHarness,
    codeGraphToolsAdvertised: sessionConfiguration.codeGraphToolsAdvertised,
    codexAppServerIdleTimeoutMinutes:
      sessionConfiguration.codexPreferences?.codexAppServerIdleTimeoutMinutes,
    codexMaxConcurrentSubagents:
      sessionConfiguration.codexPreferences?.codexMaxConcurrentSubagents,
    codexMultiAgentEnabled: isCoworkChat
      ? sessionConfiguration.codexPreferences
          ?.codexMultiAgentStandaloneChatsEnabled
      : sessionConfiguration.codexPreferences
          ?.codexMultiAgentWorktreeChatsEnabled,
    rtkEnabled: sessionConfiguration.rtkEnabled,
    ...(options.aiCreditsRouting
      ? { aiCreditsRouting: options.aiCreditsRouting }
      : {}),
    ...(options.subscriptionBillingOverride
      ? { subscriptionBillingOverride: true }
      : {}),
  });

  return {
    cwd,
    sessionKey,
    existingCodeGraphToolsAdvertised,
    currentCodeGraphToolsAvailable,
    persistedDispatchMetadata,
    selectedModel,
    effectiveProviderType,
    effectiveExecutionHarness,
    deferredToolsAllowed,
    resolveSessionConfiguration,
    get sessionConfiguration(): PreparedWorktreeTurnSessionConfiguration {
      return sessionConfiguration;
    },
    set sessionConfiguration(
      configuration: PreparedWorktreeTurnSessionConfiguration,
    ) {
      sessionConfiguration = configuration;
    },
    buildSessionOptions,
  };
}

export async function dispatchWorktreeChatTurn<
  TBeforeResult extends boolean | void | ProviderEventIngestResult =
    | boolean
    | void
    | ProviderEventIngestResult,
>(
  requestedOptions: DispatchWorktreeChatTurnOptions<TBeforeResult>,
): Promise<void> {
  await assertCoworkChatRootPresent(
    requestedOptions.projectId,
    requestedOptions.worktreeId,
  );
  // Until the provider session owns the turn, nothing else proves this process
  // is running it: a snapshot read meanwhile (a watcher reading the chat, a
  // renderer refresh) would settle the starting runtime as interrupted by an
  // app restart and drop the reply. Send commands hold this already; hook,
  // rebase and builtin chats dispatch here directly.
  const releaseRuntimeHost =
    getChatStateService().holdRuntimeHost(requestedOptions);
  try {
    await dispatchHeldWorktreeChatTurn(requestedOptions);
  } finally {
    releaseRuntimeHost();
  }
}

async function dispatchHeldWorktreeChatTurn<
  TBeforeResult extends boolean | void | ProviderEventIngestResult =
    | boolean
    | void
    | ProviderEventIngestResult,
>(
  requestedOptions: DispatchWorktreeChatTurnOptions<TBeforeResult>,
): Promise<void> {
  // A live-settings turn runs on what the session already uses; the saved
  // tab settings (the user's pending choice) wait for a later turn.
  const liveSettings = requestedOptions.useLiveSessionSettings
    ? liveSessionSettingsOverlay(requestedOptions)
    : undefined;
  const options: DispatchWorktreeChatTurnOptions<TBeforeResult> = liveSettings
    ? { ...requestedOptions, ...liveSettings }
    : requestedOptions;
  const turnDispatchTiming =
    options.turnDispatchTiming ?? new TurnDispatchTiming();
  if (!options.onBeforeChatEvent) {
    throw new Error(
      'A durable chat-event commit hook is required before dispatching a worktree chat turn.',
    );
  }
  // A legacy plan chat keeps its transcript but never starts a turn; refuse
  // it here, the funnel every dispatch path (including deferred-tools
  // continuations and direct callers) shares, before any turn state exists.
  assertChatScopeAcceptsTurns(options.projectId);
  // A Stop or newer dispatch since admission makes this attempt stale.
  consumeDispatchAuthorization(options.authorization, {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
    userMessageId: options.userMessageId,
  });
  const watcherAcceptedAt = new Date().toISOString();
  const watcherContext = captureCanonicalChatProducerContext(options);
  const presentationOrigin = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatTabId: options.chatId,
  };
  const handoffsAtSend = browserHandoffs.captureOrigin(presentationOrigin);
  const workOwnerSession = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
    ...(options.executionContext === undefined
      ? {}
      : { executionContext: options.executionContext }),
  };
  // Begin the session binding before turn preparation can yield. Provider
  // creation repeats this idempotently; queued descendants share this promise.
  captureSessionWorkOwner(workOwnerSession);
  const workOwner = resolveSessionWorkOwner(workOwnerSession);
  // Every dispatch path (IPC send, queue drain, watcher, portal) funnels here,
  // so a newer turn retires a stopped turn's Resume offer (CAN-3137). A hidden
  // continuation of the stopped turn keeps its own user-message anchor.
  const stoppedTurnResumeService = getStoppedTurnResumeService();
  stoppedTurnResumeService.invalidateForNewTurn(options, options.userMessageId);
  if (!options.hiddenDeferredContinuation) {
    // Capability-package overlays are trusted, main-owned turn context but are
    // intentionally not persisted on the chat tab. Recreating a stopped
    // provider session without one would not continue the same turn, so that
    // exact root is ineligible for Resume.
    stoppedTurnResumeService.recordTurnContext(
      options,
      options.userMessageId,
      options.packageOverlay !== undefined,
    );
  }
  const dispatchStartedAt = Date.now();
  const memoryAbortController = new AbortController();
  const memoryPromise: Promise<PreparedOrgMemory | null> =
    options.hiddenDeferredContinuation
      ? Promise.resolve(null)
      : prepareOrgMemory({
          userText: options.text,
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          userMessageId: options.userMessageId,
          selectedRepoId: options.selectedRepoId,
          ...(options.executionContext !== undefined
            ? { executionContext: options.executionContext }
            : {}),
          ...(options.hiddenContext?.kind !== undefined
            ? { hiddenContextKind: options.hiddenContext.kind }
            : {}),
          ...(options.initiationSource !== undefined
            ? { initiationSource: options.initiationSource }
            : {}),
          signal: memoryAbortController.signal,
        });
  // Created where the fetch starts so no dispatch exit — success, thrown
  // error, or early return — can leave a gate-passed search unattributed:
  // the finally below settles the tracker on every path.
  const memoryDeliveryTracker = createOrgMemoryDeliveryTracker({
    resultPromise: memoryPromise.then(
      (prepared): OrgMemoryFetchResult | null =>
        prepared?.attempt.result ?? null,
    ),
    dispatchStartedAt,
    clientChatId: clampId(options.chatId, MAX_TELEMETRY_CLIENT_ID_LENGTH),
  });
  let resourceGuard: ResourceGuardReservation | undefined;
  let releaseSessionTurnPreparation: (() => void) | undefined;
  let activeTurnRun: ChatTurnRunHandle | undefined;
  let activeTurnAccepted = false;
  let dispatchFailure: { error: unknown } | undefined;
  const preparation = beginChatTurnPreparation(options);
  // Resolve the active plan captured with this message beside memory
  // preparation; it is prepended only when the turn is composed. A hidden
  // continuation belongs to a turn that already carried it. Resolution never
  // blocks the send.
  const activePlanInstructionPromise: Promise<PendingSystemInstruction | null> =
    options.hiddenDeferredContinuation
      ? Promise.resolve(null)
      : resolveActivePlanSystemInstruction({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          activePlan: options.activePlan,
        }).catch((): null => null);

  try {
    resourceGuard = await turnDispatchTiming.measure('scope_lease', () =>
      getResourceMonitorService().reserveChatTurnStart(),
    );
    const observabilityServicePromise = turnDispatchTiming.measure(
      'observability',
      loadObservabilityIngest,
    );
    const isCoworkChat = isCoworkWorkspace(options.projectId);
    const isLegacyStandalone = options.projectId === STANDALONE_CHAT_PROJECT_ID;
    const standaloneProjectId = isLegacyStandalone
      ? options.worktreeId
      : isCoworkChat
        ? options.projectId
        : undefined;
    const isPlanExplore = options.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID;
    const isCodeReview = options.projectId === CODE_REVIEW_CHAT_PROJECT_ID;
    // Plan-file turn ownership (D-B): a running turn exposes every plan file
    // in its real worktree, so the sync service defers applying agent edits
    // there until the lease ends. The plan-explore sentinel resolves to its
    // registered worktree; Cowork, Code Review, and scopes without tracked
    // plans take no lease. The lease is keyed by this chat, so a later
    // dispatch of the same chat (reload continuation, resume) supersedes an
    // un-ended one.
    const planTurnScope =
      isCoworkChat || isCodeReview
        ? null
        : resolvePlanTurnScope(options.projectId, options.worktreeId);
    let executionUserMessageId = options.userMessageId;
    let planTurnLease: PlanTurnLease | null = null;
    const openPlanTurn = (): void => {
      const captured = capturePresentationTurn(presentationOrigin);
      recordPresentationTurn(
        presentationChatKey(presentationOrigin),
        executionUserMessageId,
        captured !== undefined && captured.turnId === executionUserMessageId
          ? captured.source
          : executionUserMessageId === options.userMessageId
            ? (options.initiationSource ?? 'user')
            : undefined,
      );
      if (planTurnScope === null || planTurnLease !== null) return;
      planTurnLease = getPlanFileSyncService().beginTurn(
        planChatTurnKey(options.projectId, options.worktreeId, options.chatId),
        planTurnScope,
      );
    };
    const closePlanTurn = (): void => {
      clearPresentationTurn(
        presentationChatKey(presentationOrigin),
        executionUserMessageId,
      );
      const lease = planTurnLease;
      planTurnLease = null;
      lease?.end();
    };
    const attachmentCwd = resolveWorktreeCwd(
      options.projectId,
      options.worktreeId,
      options.selectedRepoId,
    );
    const attachmentBaseDir = isCoworkChat
      ? getCoworkManagedSubdir(attachmentCwd, 'attachments')
      : getWorktreeAttachmentsDir(options.projectId, options.worktreeId);
    // Built early so attachment validation fails before any session work.
    // Pending system instructions are prepended at compose time, once the
    // active-plan instruction has resolved.
    const visibleSubmittedText = options.hiddenDeferredContinuation
      ? options.text
      : buildSubmittedMessageText({
          text: options.text,
          fileReferences: options.fileReferences,
          attachmentPaths: options.attachmentPaths,
          attachmentPromptContexts: options.attachmentPromptContexts,
          // `cwd` already resolves to the cowork home dir for both the legacy
          // sentinel keying and real cowork workspace ids (see
          // `resolveWorktreeCwd`), so it is the correct attachment base for
          // either keying.
          attachmentBaseDir,
          cwd: attachmentCwd,
          inputMode: options.inputMode,
          agentSent: options.agentSent,
        });
    // Context memory preparation is a dispatch side effect and remains outside
    // the reusable session-preparation API. The callback keeps it before
    // normalized model configuration/session_config, as in the original path.
    const localMemory: {
      value: Awaited<ReturnType<typeof prepareLocalMemory>>;
    } = { value: null };
    const preparedSession = await prepareWorktreeTurnSession(
      options,
      turnDispatchTiming,
      {
        beforeSessionConfiguration: async () => {
          if (options.hiddenDeferredContinuation) return;
          localMemory.value = await turnDispatchTiming.measure(
            'local_memory',
            () =>
              prepareLocalMemory({
                userText: options.text,
                projectId: standaloneProjectId ?? options.projectId,
                worktreeId: options.worktreeId,
              }),
          );
        },
      },
    );
    const {
      cwd,
      sessionKey,
      existingCodeGraphToolsAdvertised,
      currentCodeGraphToolsAvailable,
      resolveSessionConfiguration,
      buildSessionOptions,
      effectiveExecutionHarness,
    } = preparedSession;
    let sessionConfiguration = preparedSession.sessionConfiguration;

    if (
      !options.hiddenDeferredContinuation &&
      !isCoworkChat &&
      !isPlanExplore &&
      !isCodeReview
    ) {
      if (!options.sdkSessionId && !options.skipBranchNaming) {
        scheduleBranchNaming({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          text: options.text,
          cwd,
          workOwner,
          getWindow: options.getWindow,
        });
      }

      scheduleChatSummary({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        cwd,
        getWindow: options.getWindow,
        workOwner,
      });
    }

    await assertCoworkChatRootPresent(options.projectId, options.worktreeId);
    await turnDispatchTiming.measure('session_reuse', async () => {
      const recreate = shouldRecreateSessionOnNextTurn(
        options.projectId,
        options.worktreeId,
        options.chatId,
      );
      const recreateReasons = recreate
        ? getSessionRecreateReasons(
            options.projectId,
            options.worktreeId,
            options.chatId,
          )
        : [];
      const deferApprovalRecreation =
        recreate &&
        recreateReasons.length > 0 &&
        recreateReasons.every((reason) =>
          isRecreateDeferrable(reason, liveSettings !== undefined),
        ) &&
        chatHasNativeBackgroundWork(
          options.projectId,
          options.worktreeId,
          options.chatId,
        );
      if (deferApprovalRecreation) {
        // Record only field and recreation-reason names; request values stay
        // out of session diagnostics.
        void observabilityServicePromise
          .then((observabilityService) =>
            observabilityService.recordSessionDiagnostic({
              version: 1,
              timestamp: new Date().toISOString(),
              kind: 'session_recreate_deferred',
              sessionKey,
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
              providerType: sessionConfiguration.runtimeProviderType,
              recreateReasons: [...recreateReasons],
              ...(recreateReasons.every((reason) => reason === 'approval')
                ? { changedOptions: ['approvalMode', 'sessionApprovalRules'] }
                : {}),
            }),
          )
          .catch(() => undefined);
      }
      if (existingCodeGraphToolsAdvertised !== undefined) {
        const requestedSessionOptions = buildSessionOptions();
        const canReuseRequestedSession =
          (!recreate || deferApprovalRecreation) &&
          (await canReuseSession(requestedSessionOptions));
        if (
          !canReuseRequestedSession &&
          !(await canPreserveSessionCapabilitySnapshot(requestedSessionOptions))
        ) {
          sessionConfiguration = await turnDispatchTiming.measure(
            'session_config',
            () => resolveSessionConfiguration(currentCodeGraphToolsAvailable),
          );
          preparedSession.sessionConfiguration = sessionConfiguration;
        }
      }

      if (recreate && !deferApprovalRecreation) {
        // A recycle: the chat's managed delegations keep running.
        await destroySession(
          options.projectId,
          options.worktreeId,
          options.chatId,
          { retainDelegations: true },
        );
      }
      return recreate;
    });

    const {
      runtime,
      runtimeProviderType,
      runtimeModel,
      effectiveModelConfig,
      codexPreferences,
      rtkEnabled,
      systemPromptAppend,
    } = sessionConfiguration;
    const recordSlowDispatchDiagnostic = (
      diagnostic: TurnDispatchSlowDiagnostic,
    ): void => {
      const record: SessionDiagnosticRecord = {
        ...diagnostic,
        version: 1,
        timestamp: new Date().toISOString(),
        sessionKey,
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType: runtimeProviderType,
      };
      void observabilityServicePromise
        .then((observabilityService) =>
          observabilityService.recordSessionDiagnostic(record),
        )
        .catch(() => undefined);
    };
    const observedSystemPromptAppend = systemPromptAppend;
    const resumesStoppedTurn =
      options.hiddenContinuationKind === 'stopped_turn_resume';
    // A stopped-turn resume starts a new dispatch closure for an already
    // settled canonical turn. Treat its first provider output as an explicit
    // same-turn revival so canonical state and the host queue both reopen the
    // original turn instead of dropping tagged Claude/Cursor events as late.
    let turnSettled = resumesStoppedTurn;
    let resumedTransportSettled = false;
    const resumeOwnsTerminalSettlement = (): boolean =>
      !resumesStoppedTurn &&
      getStoppedTurnResumeService().ownsTerminalSettlement(
        {
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
        },
        executionUserMessageId,
      );
    // A steering pickup the host queue accepted as a turn root before this
    // closure owned it. When canonical state does not apply that pickup, the
    // closure never owns the provider turn and drops its events, terminal
    // included, so the queue gate it took is released from here instead.
    let unownedTurnRootUserMessageId: string | undefined;
    const releaseUnownedTurnRoot = (status: ChatQueueTerminalStatus): void => {
      const turnUserMessageId = unownedTurnRootUserMessageId;
      if (turnUserMessageId === undefined) return;
      unownedTurnRootUserMessageId = undefined;
      void getChatQueueServiceForTurnLifecycle().then((queue) => {
        queue.onTurnTerminal(
          {
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
          },
          status,
          turnUserMessageId,
        );
      });
    };
    let codexRootThreadId: string | undefined = options.sdkSessionId;
    let sessionEventCommitTail = Promise.resolve();
    let terminalQueueReleaseTail = Promise.resolve();
    // Deliveries of events whose commits overlapped (group commit only).
    const commitPipeline = new SessionEventCommitPipeline();
    let turnDiffCaptureTail = Promise.resolve();
    let turnDiffEventCommit = Promise.resolve();
    let derivedEventCommits = Promise.resolve();
    const recordWorktreeTurnDrop = (
      data: unknown,
      reason: string,
      turnUserMessageId: string | undefined,
      includeTurnUserMessageId = false,
    ): void => {
      const eventData = isRecord(data) ? data : null;
      const eventTurnUserMessageId = eventData
        ? getEventTurnUserMessageId(eventData)
        : null;
      const codexEvent =
        eventData?.type === 'codex' && isRecord(eventData.event)
          ? eventData.event
          : null;
      const providerThreadId =
        codexEvent && typeof codexEvent.thread_id === 'string'
          ? (codexRootThreadId ?? codexEvent.thread_id)
          : undefined;
      recordChatEventDropped({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType: runtimeProviderType,
        gate: 'worktree_turn_ineligible',
        reason,
        data,
        ...(turnUserMessageId !== undefined &&
        (includeTurnUserMessageId ||
          eventTurnUserMessageId !== turnUserMessageId)
          ? { turnUserMessageId }
          : {}),
        ...(providerThreadId ? { providerThreadId } : {}),
      });
    };
    const evaluateSessionEvent = (
      data: unknown,
    ): {
      eventData: Record<string, unknown> | null;
      isTerminalEvent: boolean;
      activeTurnUserMessageId: string | undefined;
      turnOwnerUserMessageId: string;
      eventTurnUserMessageId: string | null;
      revivesSettledTurn: boolean;
      ineligibleEvent: boolean;
      ineligibleReason:
        | 'internal_reload_terminal'
        | 'earlier_turn'
        | 'settled_turn_unrelated_event'
        | undefined;
    } => {
      codexRootThreadId = readCodexRootThreadId(data) ?? codexRootThreadId;
      const eventData = isRecord(data) ? data : null;
      const isTerminalEvent =
        eventData !== null &&
        isRootTerminalChatEventData(eventData, codexRootThreadId);
      const isInternalReloadTerminalEvent =
        isTerminalEvent &&
        deferredToolsReloadCoordinator.hasActiveReload({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
        });
      const activeTurnUserMessageId = activeTurnUserMessageIds.get(sessionKey);
      const expectedTurnUserMessageId =
        activeTurnUserMessageId ?? executionUserMessageId;
      const eventTurnUserMessageId = eventData
        ? getEventTurnUserMessageId(eventData)
        : null;
      const ownedDelegation =
        eventData?.type === 'canopy_delegation' &&
        isAgentDelegationTranscript(eventData.delegation);
      const belongsToEarlierTurn =
        !ownedDelegation &&
        eventTurnUserMessageId !== null &&
        eventTurnUserMessageId !== expectedTurnUserMessageId;
      // A provider may flush the final assistant/tool event just after its
      // root terminal event. Offer only an explicitly tagged event for the
      // same turn to canonical state: ChatStateService accepts it when that
      // turn is in `empty_completion` recovery and rejects it for every other
      // settled runtime. This keeps the canonical verdict authoritative while
      // allowing genuinely late output to repair an empty turn.
      const canReconcileSettledTurn =
        turnSettled &&
        eventTurnUserMessageId === expectedTurnUserMessageId &&
        eventData?.canopy_turn_revival !== true &&
        isRootAgentContinuationEvent(data);
      const canFollowSettledTurn =
        ownedDelegation ||
        isClaudeChildFrame(eventData) ||
        eventData?.type === 'canopy_input_delivery' ||
        eventData?.type === 'turn_diff' ||
        eventData?.type === 'claude_terminal_transcript_sync' ||
        eventData?.type === 'org_memory_used' ||
        eventData?.type === 'canopy_org_memory_used' ||
        isCodexAsyncQuestionEvent(eventData) ||
        isCodexSubagentFollowupEvent(eventData, codexRootThreadId) ||
        (eventData?.type === 'system' &&
          eventData.subtype === 'init' &&
          eventData.canopy_turn_revival === true) ||
        (eventData !== null && isSetAutoArchiveRequestedEventData(eventData)) ||
        canReconcileSettledTurn;
      // Codex clears its active message tag when a turn finishes. A late
      // background command result is therefore untagged, but is not a new
      // turn. Only a root turn start may revive without explicit retry
      // metadata; item events must not reopen the host queue's busy gate.
      const canReviveWithoutTurnTag =
        eventData?.type !== 'codex' ||
        (isRecord(eventData.event) &&
          eventData.event.type === 'turn.started' &&
          codexRootThreadId !== undefined &&
          eventData.event.thread_id === codexRootThreadId);
      const revivesSettledTurn =
        turnSettled &&
        !canFollowSettledTurn &&
        ((eventTurnUserMessageId === null && canReviveWithoutTurnTag) ||
          (eventTurnUserMessageId === expectedTurnUserMessageId &&
            eventData?.canopy_turn_revival === true)) &&
        (isRootAgentContinuationEvent(data) ||
          (resumesStoppedTurn &&
            eventData?.canopy_turn_revival === true &&
            isTerminalEvent));
      const ineligibleReason = isInternalReloadTerminalEvent
        ? 'internal_reload_terminal'
        : belongsToEarlierTurn
          ? 'earlier_turn'
          : turnSettled && !canFollowSettledTurn && !revivesSettledTurn
            ? 'settled_turn_unrelated_event'
            : undefined;
      return {
        eventData,
        isTerminalEvent,
        activeTurnUserMessageId,
        turnOwnerUserMessageId: expectedTurnUserMessageId,
        eventTurnUserMessageId,
        revivesSettledTurn,
        ineligibleEvent: ineligibleReason !== undefined,
        ineligibleReason,
      };
    };
    const deliverSessionEvent = (
      data: unknown,
      evaluation: ReturnType<typeof evaluateSessionEvent>,
      beforeChatEventResult: TBeforeResult,
      ingestResult: ProviderEventIngestResult,
      occurredAt: string,
    ): void => {
      void observabilityServicePromise.then((observabilityService) => {
        observabilityService.observeChatEvent(
          options.projectId,
          options.worktreeId,
          options.chatId,
          data,
        );
      });
      sendWorktreeChatEvent(
        options.getWindow,
        options.projectId,
        options.worktreeId,
        options.chatId,
        data,
        {
          providerType:
            runtimeProviderType ??
            (runtimeModel ? getProviderForModel(runtimeModel) : undefined),
          model: runtimeModel,
        },
      );
      const {
        eventData,
        isTerminalEvent,
        activeTurnUserMessageId,
        eventTurnUserMessageId,
      } = evaluation;
      options.onChatEvent?.({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        data,
        isTerminalEvent,
        beforeChatEventResult,
        ingestResult,
      });

      if (eventData && isTerminalEvent) {
        // Settle before scheduling terminal follow-up work so callbacks already
        // queued behind this event cannot append output to the completed turn.
        turnSettled = true;
        activeTurnRun?.settle(chatTurnOutcomeOf(eventData));
        // The root turn ended (success, error, or cancellation): the sync
        // service may now apply plan-file edits it made.
        closePlanTurn();
        if (resumesStoppedTurn) {
          resumedTransportSettled = true;
          getStoppedTurnResumeService().settleTerminalOwnership(
            {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
            },
            executionUserMessageId,
          );
        }
        const status = getChatTurnAuditStatus(eventData);
        const error =
          eventData.type === 'error'
            ? typeof eventData.error === 'string'
              ? eventData.error
              : 'Unknown error'
            : eventData.is_error === true &&
                typeof eventData.result === 'string'
              ? eventData.result
              : undefined;
        void observabilityServicePromise.then((observabilityService) => {
          observabilityService.completeChatTurn(
            options.projectId,
            options.worktreeId,
            options.chatId,
            status,
            error,
          );
          void notifyCanonicalChatTerminal(
            options,
            eventTurnUserMessageId ?? executionUserMessageId,
            eventData,
            status,
            occurredAt,
            watcherContext,
            executionUserMessageId === options.userMessageId
              ? watcherAcceptedAt
              : undefined,
          ).catch(() => undefined);
        });
        const queueStatus =
          status === 'success'
            ? 'complete'
            : status === 'failure'
              ? 'error'
              : 'cancelled';
        terminalQueueReleaseTail = terminalQueueReleaseTail
          .then(async () => {
            const queue = await getChatQueueServiceForTurnLifecycle();
            queue.onTurnTerminal(
              {
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
              },
              queueStatus,
              eventTurnUserMessageId ?? activeTurnUserMessageId,
              ...(detectAiCreditsNoBillingSource(eventData)
                ? ['insufficient_credits' as const]
                : []),
            );
          })
          .catch((error: unknown) => {
            logMainProcessError(
              `Failed to release the chat queue after a terminal event for ${options.projectId}/${options.worktreeId}/${options.chatId}`,
              error,
            );
          });
        if (isCoworkChat) {
          // Cowork workspaces get the same Summary card as Code worktrees;
          // the scheduler's cowork branch summarizes folder activity
          // instead of git diffs. Everything else worktree-flavored
          // (turn-diff capture, code-review activity) stays skipped.
          scheduleSummaryGeneration(
            options.projectId,
            options.worktreeId,
            options.getWindow,
          );
        } else {
          // The plan-explore and code-review scopes have no worktree summary
          // of their own (their summary/tracked-plan paths intentionally
          // throw), so skip summary generation while still capturing turn
          // diffs against the borrowed real worktree for "Reset to this
          // point". A plan-explore turn's plan-file lease already ended above.
          if (!isPlanExplore && !isCodeReview) {
            scheduleSummaryGeneration(
              options.projectId,
              options.worktreeId,
              options.getWindow,
            );
            noteWorktreeActivityForCodeReview(
              options.projectId,
              options.worktreeId,
              options.getWindow,
            );
          } else if (isCodeReview) {
            // Code-review turn completed: close the active-turn gate so any
            // review regeneration deferred while the sidecar chat was
            // editing files can now run. `options.worktreeId` is the
            // composite scope key for this sentinel scope; the hook resolves
            // the real ids via the code-review registry.
            noteCodeReviewTurnEnd(options.worktreeId, options.getWindow);
          }
          activeTurnUserMessageIds.delete(sessionKey);
          if (activeTurnUserMessageId) {
            let completeTurnDiffEventCommit = (): void => undefined;
            const thisTurnDiffEventCommit = new Promise<void>((resolve) => {
              completeTurnDiffEventCommit = resolve;
            });
            // Keep a stable aggregate so a drain can snapshot all derived
            // commits started by its event prefix before later terminals
            // append their own work.
            turnDiffEventCommit = Promise.all([
              turnDiffEventCommit,
              thisTurnDiffEventCommit,
            ]).then(() => undefined);
            const wakeTurnId = getEventWakeTurnId(eventData);
            turnDiffCaptureTail = captureTurnEndAndDiffs(sessionKey, {
              userMessageId: activeTurnUserMessageId,
              ...(wakeTurnId === undefined ? {} : { wakeTurnId }),
            })
              .then((diffs) => {
                const turnDiff = diffs?.turn;
                // Emit the event regardless of whether files changed: the
                // captured `treeRefs` are needed for "Reset to this point" even
                // on read-only turns. The renderer hides the diff summary when
                // `files` is empty, so this doesn't add visual noise.
                if (!turnDiff) {
                  completeTurnDiffEventCommit();
                  return;
                }
                if (turnDiff.files.length > 0) {
                  const target = resolveWorktreeTargetIds(
                    options.projectId,
                    options.worktreeId,
                  );
                  if (target) {
                    scheduleCodeGraphBuild({
                      ...target,
                      reason: 'refresh',
                      source: 'turn-diff',
                    });
                  }
                }

                // The capture barrier must not await this queued commit: a
                // late pickup can await capture from inside the same queue.
                // drainSessionEvents joins the derived commit separately.
                const eventCommit = handleSessionEvent({
                  type: 'turn_diff',
                  userMessageId: activeTurnUserMessageId,
                  ...turnDiff,
                }).catch(() => undefined);
                // A wake's own edits also land under its own turn; the prompt's
                // diff above stays cumulative for "Reset to this point".
                const wakeDiff =
                  wakeTurnId === undefined ? undefined : diffs?.sinceLastEnd;
                const wakeCommit =
                  wakeTurnId === undefined || wakeDiff === undefined
                    ? Promise.resolve(undefined)
                    : handleSessionEvent({
                        type: 'turn_diff',
                        userMessageId: wakeTurnKey(wakeTurnId),
                        ...wakeDiff,
                      }).catch(() => undefined);
                void Promise.all([eventCommit, wakeCommit]).then(
                  completeTurnDiffEventCommit,
                );
              })
              .catch(() => {
                completeTurnDiffEventCommit();
              });
          }
        }
      }
    };
    let sessionEventSequence = 0;
    // The active session is authoritative after lane selection, as on the
    // Cowork path; persistence prefers it over the requested provider.
    const eventProviderType = (): AgentProviderType | undefined =>
      getSessionProviderType(
        options.projectId,
        options.worktreeId,
        options.chatId,
      ) ?? runtimeProviderType;
    const sequenceNamespace =
      options.providerEventSequenceNamespace ?? 'initial';
    const handleSessionEvent = (
      data: unknown,
      markPersistenceSettled?: () => void,
    ): Promise<void> => {
      const receiptClassification = classifyProviderRunEvent(data, {
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
      });
      if (receiptClassification.kind === 'reject') {
        const descriptor = getProviderRunDescriptor(data);
        recordWorktreeTurnDrop(
          data,
          receiptClassification.reason,
          descriptor?.executionUserMessageId ?? executionUserMessageId,
          true,
        );
        markPersistenceSettled?.();
        return Promise.resolve();
      }
      const isTranscriptOnly = receiptClassification.kind === 'transcript_only';
      if (!isTranscriptOnly) {
        const firstEventDiagnostic =
          turnDispatchTiming.markFirstProviderEvent();
        if (firstEventDiagnostic)
          recordSlowDispatchDiagnostic(firstEventDiagnostic);
      }
      const attributedData =
        isRecord(data) &&
        ((resumesStoppedTurn && !isTranscriptOnly) ||
          (data.type === 'canopy_user_prompt' &&
            options.initiationSource === 'hook'))
          ? copyProviderRunProvenance(data, {
              ...data,
              ...(resumesStoppedTurn && !isTranscriptOnly
                ? { canopy_turn_revival: true }
                : {}),
              ...(data.type === 'canopy_user_prompt' &&
              options.initiationSource === 'hook'
                ? { canopy_user_message_source: 'hook' }
                : {}),
            })
          : data;
      const pickupRootUserMessageId = getStartingPickupRootId(attributedData);
      const routedPickupAcceptance = getTurnRootAcceptance(data);
      const occurredAt = new Date().toISOString();
      const sequence = sessionEventSequence;
      sessionEventSequence += 1;
      const beforeChatEvent = options.onBeforeChatEvent;
      // Set when this event's commit overlaps later ones: its delivery then
      // completes after this link of the tail does.
      let overlappedCompletion: Promise<void> | undefined;
      sessionEventCommitTail = sessionEventCommitTail
        .then(async () => {
          const providerRunClassification = classifyProviderRunEvent(
            attributedData,
            {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
            },
          );
          if (providerRunClassification.kind === 'reject') {
            const descriptor = getProviderRunDescriptor(attributedData);
            recordWorktreeTurnDrop(
              attributedData,
              providerRunClassification.reason,
              descriptor?.executionUserMessageId ?? executionUserMessageId,
              true,
            );
            markPersistenceSettled?.();
            return;
          }
          if (providerRunClassification.kind === 'transcript_only') {
            // Drain commits already in flight, then use only the originating
            // run's anchor. This branch deliberately bypasses resume ownership,
            // host eligibility, queue revival, terminal delivery and timers.
            if (commitPipeline.pending) await commitPipeline.drained();
            try {
              await beforeChatEvent({
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
                data: attributedData,
                sequenceNamespace,
                sequence,
                turnUserMessageId:
                  providerRunClassification.run.executionUserMessageId,
              });
            } finally {
              markPersistenceSettled?.();
            }
            return;
          }
          // A streamed event of the active turn may start its commit before
          // events ahead of it are durable (`session-event-commit-pipeline.ts`).
          // Any other event runs alone, after every overlapped event has
          // completed.
          const mayOverlap =
            !resumesStoppedTurn &&
            !turnSettled &&
            pickupRootUserMessageId === undefined &&
            isOverlappableProviderEvent(attributedData);
          if (!mayOverlap && commitPipeline.pending)
            await commitPipeline.drained();
          // Once an explicit resume owns this same turn anchor, the stopped
          // transport is no longer an event source for the logical turn.
          if (resumeOwnsTerminalSettlement()) {
            recordWorktreeTurnDrop(
              attributedData,
              'resume_owns_terminal_settlement',
              executionUserMessageId,
            );
            markPersistenceSettled?.();
            return;
          }
          const evaluation = evaluateSessionEvent(attributedData);
          if (evaluation.ineligibleEvent) {
            recordWorktreeTurnDrop(
              attributedData,
              evaluation.ineligibleReason ?? 'event_ineligible',
              evaluation.turnOwnerUserMessageId,
            );
            if (
              evaluation.eventData &&
              evaluation.isTerminalEvent &&
              evaluation.eventTurnUserMessageId !== null &&
              evaluation.eventTurnUserMessageId === unownedTurnRootUserMessageId
            ) {
              const status = getChatTurnAuditStatus(evaluation.eventData);
              releaseUnownedTurnRoot(
                status === 'success'
                  ? 'complete'
                  : status === 'failure'
                    ? 'error'
                    : 'cancelled',
              );
            }
            markPersistenceSettled?.();
            return;
          }
          const overlaps =
            mayOverlap &&
            !evaluation.isTerminalEvent &&
            !evaluation.revivesSettledTurn;
          if (!overlaps && commitPipeline.pending)
            await commitPipeline.drained();
          let queueRearmed = false;
          if (evaluation.revivesSettledTurn && !isCoworkChat) {
            const queue = await getChatQueueServiceForTurnLifecycle();
            queueRearmed = queue.onTurnRevived(
              {
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
              },
              executionUserMessageId,
            );
            if (!queueRearmed) {
              recordChatEventDropped({
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
                providerType: runtimeProviderType,
                gate: 'turn_revival_refused',
                reason: 'queue_turn_revival_not_accepted',
                data: attributedData,
                turnUserMessageId: executionUserMessageId,
              });
              markPersistenceSettled?.();
              return;
            }
            activeTurnUserMessageIds.set(sessionKey, executionUserMessageId);
            turnSettled = false;
            // The revived turn can edit plan files again.
            openPlanTurn();
          } else if (evaluation.revivesSettledTurn) {
            turnSettled = false;
            // Cowork has no plan lease or worktree queue, but its resumed
            // tools still need the original trusted presentation source.
            openPlanTurn();
          }
          const rollbackRevival = (): void => {
            if (!evaluation.revivesSettledTurn) return;
            turnSettled = true;
            closePlanTurn();
            if (!queueRearmed) return;
            activeTurnUserMessageIds.delete(sessionKey);
            void getChatQueueServiceForTurnLifecycle().then((queue) => {
              queue.onTurnTerminal(
                {
                  projectId: options.projectId,
                  worktreeId: options.worktreeId,
                  chatId: options.chatId,
                },
                'complete',
                executionUserMessageId,
              );
            });
          };
          const emitPairedAuthFailures = (): void => {
            // Guard against recursion: a `canopy_auth_failure` event we just
            // emitted below would never itself look like an errored tool
            // result, but skip it explicitly rather than relying on that.
            const isAuthFailureEvent =
              isRecord(data) && data.type === CANOPY_AUTH_FAILURE_EVENT_TYPE;
            if (!isAuthFailureEvent) {
              // One id for every pairing this provider event produced, so the
              // stop site merges them into ONE stopped-turn record and issues ONE
              // cancel instead of overwriting the first pairing's dependencies
              // and cancelling twice (CAN-1814 review).
              const authStopGroupId = randomUUID();
              for (const pairing of pairPendingAuthFailuresWithTool(
                data,
                sessionKey,
              )) {
                const authFailureEventCommit = handleSessionEvent(
                  pairing.event,
                ).catch(() => undefined);
                // Like turn-diff commits, paired auth-failure commits are
                // derived work that may be appended after a drain snapshots
                // the provider-event tail. Keep a stable aggregate so that
                // drain can join the prefix's derived commits without
                // re-reading the live event tail.
                derivedEventCommits = Promise.all([
                  derivedEventCommits,
                  authFailureEventCommit,
                ]).then(() => undefined);
                // Stop the turn only AFTER the card's own event is durably
                // committed and delivered. `handleSessionEvent` appends to
                // `sessionEventCommitTail` synchronously, so reading the tail
                // here captures that append; cancelling first would tear the
                // session down while the event explaining WHY was still in
                // flight, and the user would see a turn stop for no visible
                // reason.
                //
                // Gated inside `stopTurnForAuthFailure` on `recovery.kind`,
                // never on `failureClass` — a non-recoverable blocker leaves the
                // agent running to route around it (CAN-1814 PR 6).
                const committed = sessionEventCommitTail;
                void committed
                  .then(async () => {
                    const stop = await stopTurnForAuthFailure({
                      target: {
                        projectId: options.projectId,
                        worktreeId: options.worktreeId,
                        chatId: options.chatId,
                      },
                      event: pairing.event,
                      toolName: pairing.toolName,
                      batchHasUnresolvedToolCalls:
                        pairing.batchHasUnresolvedToolCalls,
                      stopGroupId: authStopGroupId,
                      ...(options.initiationSource !== undefined
                        ? { initiationSource: options.initiationSource }
                        : {}),
                      getWindow: options.getWindow,
                    });
                    if (!stop.stopped) return;
                    // Same pairing `chat-queue-service.defaultCancel` uses before
                    // it force-sends: the cancelled turn's terminal event can lag
                    // behind `cancel()` resolving, and a stale active-turn marker
                    // would make the resume dispatch trip the second-active-turn
                    // guard below.
                    clearActiveTurnUserMessageId(
                      options.projectId,
                      options.worktreeId,
                      options.chatId,
                    );
                  })
                  .catch((error: unknown) => {
                    logMainProcessError(
                      `Failed to stop the turn after an authentication failure for ${options.projectId}/${options.worktreeId}/${options.chatId}`,
                      error,
                    );
                  });
              }
            }
          };
          const commitEvent = (
            onCommitQueued?: () => void,
          ): Promise<TBeforeResult> => {
            const providerType = eventProviderType();
            return beforeChatEvent({
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
              data: attributedData,
              sequenceNamespace,
              sequence,
              ...(evaluation.revivesSettledTurn
                ? {}
                : { turnUserMessageId: executionUserMessageId }),
              ...(providerType ? { providerType } : {}),
              ...(onCommitQueued ? { onCommitQueued } : {}),
            });
          };
          const rollbackPickupLease = async (): Promise<void> => {
            const lease = routedPickupAcceptance?.lease;
            // The running root is already the queue's live owner, even when a
            // later duplicate pickup is rejected by canonical state (or the
            // initial dispatched root is presented as a pickup). Rolling its
            // lease back would release the foreground gate under live output.
            if (
              !lease ||
              pickupRootUserMessageId === undefined ||
              pickupRootUserMessageId === executionUserMessageId
            ) {
              return;
            }
            const queue = await getChatQueueServiceForTurnLifecycle();
            const released = queue.rollbackTurnRevival(
              {
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
              },
              lease,
            );
            // The gate is already free, so no backstop release is owed.
            if (released && unownedTurnRootUserMessageId === lease.rootId)
              unownedTurnRootUserMessageId = undefined;
          };
          if (overlaps) {
            // This link ends once the commit holds its place in the scope's
            // commit order, so the next event's commit can join its journal
            // sync. The event is delivered when its commit is durable, after
            // every event ahead of it.
            const { queued, completed } = commitPipeline.overlap(
              (markQueued) =>
                commitEvent(markQueued).finally(() =>
                  markPersistenceSettled?.(),
                ),
              (outcome): void => {
                if (outcome.status === 'rejected') throw outcome.reason;
                // Canonical admission records its own rejects.
                if (
                  getProviderEventIngestOutcome(outcome.value) === 'not-applied'
                )
                  return;
                if (resumeOwnsTerminalSettlement()) {
                  recordWorktreeTurnDrop(
                    attributedData,
                    'resume_owns_terminal_settlement_after_commit',
                    evaluation.turnOwnerUserMessageId,
                  );
                  return;
                }
                deliverSessionEvent(
                  attributedData,
                  evaluation,
                  outcome.value,
                  normalizeProviderEventIngestResult(outcome.value),
                  occurredAt,
                );
                emitPairedAuthFailures();
              },
            );
            overlappedCompletion = completed.catch((error: unknown) => {
              logMainProcessError(
                `Failed to durably commit chat event for ${options.projectId}/${options.worktreeId}/${options.chatId}`,
                error,
              );
            });
            await queued;
            return;
          }
          let committed: TBeforeResult;
          try {
            committed = await commitEvent();
          } catch (error) {
            await rollbackPickupLease();
            rollbackRevival();
            markPersistenceSettled?.();
            throw error;
          }
          // The canonical commit has settled. Keep the later presentation,
          // watcher, and recursively derived event work on its existing tail.
          markPersistenceSettled?.();
          // Ownership can change while canonical persistence is in flight.
          // Once Resume has claimed this same anchor, retain the durable old
          // event but do not let its transport deliver or settle the new run.
          if (resumeOwnsTerminalSettlement()) {
            recordWorktreeTurnDrop(
              attributedData,
              'resume_owns_terminal_settlement_after_commit',
              evaluation.turnOwnerUserMessageId,
            );
            await rollbackPickupLease();
            return;
          }
          let pickupAccepted = false;
          if (pickupRootUserMessageId !== undefined) {
            const queue = await getChatQueueServiceForTurnLifecycle();
            const target = {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
            };
            const pickupVerdict =
              typeof committed === 'object' && committed !== null
                ? committed.pickup
                : undefined;
            const canonicalAccepted =
              pickupVerdict === 'accepted' ||
              pickupVerdict === 'already-accepted';
            if (!canonicalAccepted) {
              await rollbackPickupLease();
            } else if (
              routedPickupAcceptance?.accepted === false ||
              (isRecord(attributedData) &&
                attributedData.turnRootAccepted === false)
            ) {
              // The router's explicit refusal carries no lease. Preserve its
              // existing behavior: do not re-arbitrate a refused root.
            } else if (routedPickupAcceptance?.lease) {
              pickupAccepted = queue.confirmTurnRevival(
                target,
                routedPickupAcceptance.lease,
              );
              if (!pickupAccepted) await rollbackPickupLease();
            } else if (routedPickupAcceptance === undefined) {
              // Direct/legacy pickup events have no router arbitration. Keep
              // their queue revival only after canonical pickup acceptance
              // has been explicitly reported, and retain the lease guard.
              const acceptance = queue.acceptTurnRevival(
                target,
                pickupRootUserMessageId,
              );
              pickupAccepted =
                acceptance.accepted &&
                queue.confirmTurnRevival(target, acceptance.lease);
              if (
                acceptance.accepted &&
                !pickupAccepted &&
                pickupRootUserMessageId !== executionUserMessageId
              ) {
                queue.rollbackTurnRevival(target, acceptance.lease);
              }
            }
            // The pickup event is still durable evidence when the queue has
            // already advanced, but it must not steal event attribution from
            // the newer active turn.
            if (pickupAccepted) {
              if (unownedTurnRootUserMessageId === pickupRootUserMessageId)
                unownedTurnRootUserMessageId = undefined;
              executionUserMessageId = pickupRootUserMessageId;
              turnSettled = false;
              // The picked-up input starts a turn this closure now owns.
              openPlanTurn();
              if (!isCoworkChat) {
                activeTurnUserMessageIds.set(
                  sessionKey,
                  executionUserMessageId,
                );
                await turnDiffCaptureTail;
                await captureTurnStart(
                  sessionKey,
                  options.projectId,
                  options.worktreeId,
                );
              }
            }
          }
          if (
            getProviderEventIngestOutcome(committed) === 'not-applied' &&
            !pickupAccepted
          ) {
            rollbackRevival();
            return;
          }
          deliverSessionEvent(
            attributedData,
            evaluation,
            committed,
            normalizeProviderEventIngestResult(committed),
            occurredAt,
          );
          emitPairedAuthFailures();
        })
        .catch((error: unknown) => {
          markPersistenceSettled?.();
          logMainProcessError(
            `Failed to durably commit chat event for ${options.projectId}/${options.worktreeId}/${options.chatId}`,
            error,
          );
        });
      // The caller releases the event's pressure charge when this settles:
      // for an overlapped event, that is after its commit and delivery.
      return sessionEventCommitTail.then(() => overlappedCompletion);
    };
    const drainSessionEvents = async (): Promise<void> => {
      const tail = sessionEventCommitTail;
      // First drain provider events so a terminal event has a chance to start
      // its asynchronous turn-diff capture. Then await that derived work and
      // the durable event commit it appends.
      // The snapshot is important: this await reaction is registered before
      // any later provider event can link another commit to the shared tail.
      await tail;
      const overlappedCommits = commitPipeline.pending
        ? commitPipeline.drained()
        : undefined;
      // Capture both barriers before awaiting the group-commit pipeline: a
      // later terminal must not replace either promise and extend this drain.
      const captureTail = turnDiffCaptureTail;
      const eventCommit = turnDiffEventCommit;
      if (overlappedCommits) await overlappedCommits;
      // The group-commit completion callback can emit paired auth failures.
      // Snapshot their aggregate only after it finishes so commits derived
      // from the drained prefix are included, but later provider events still
      // cannot extend this barrier.
      const derivedCommits = derivedEventCommits;
      await captureTail;
      // The capture appends its derived event to the same ordered commit tail.
      // Await its separate aggregate rather than re-reading the live tail:
      // later provider events must not extend this call-time drain. Each
      // derived commit still follows events already appended before its
      // capture completed, as required by the shared commit ordering.
      await eventCommit;
      await derivedCommits;
    };
    // One worker execution per dispatched turn (CAN-4115). Begun before the
    // last preparation check, so a Stop meanwhile abandons it unaccepted.
    activeTurnRun = await beginChatTurnRun({
      scope: {
        workspaceId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
      },
      turnId: executionUserMessageId,
      eventNamespace: options.hiddenDeferredContinuation
        ? `${sequenceNamespace}:${options.hiddenContinuationKind ?? 'deferred_tools_reload'}`
        : sequenceNamespace,
      providerId: preparedSession.effectiveProviderType,
      model: preparedSession.selectedModel ?? null,
      initiationSource: options.initiationSource,
    });
    const turnRun = activeTurnRun;
    // The last read before the session exists: what the chat holds now, not
    // what the send carried when it was committed or queued (CAN-4469).
    const turnApprovalAuthority =
      await resolveChatTurnApprovalAuthority(options);
    if (preparation.cancelled) return;
    // Until the provider accepts the prompt, the session reads as idle. Hold
    // it from before creation so a passive auth transition observed meanwhile
    // (startChatTurn warms the account cache) recycles it after this turn
    // instead of dropping the prompt.
    releaseSessionTurnPreparation = turnDispatchTiming.measureSync(
      'scope_lease',
      () => beginSessionTurnPreparation(sessionKey),
    );
    const pendingRouteOwner = options.authorization;
    const sessionBeforeDispatch = getLiveRoutedSession(options);
    const session = await turnDispatchTiming.measure('session_create', () =>
      turnRun.execute(() =>
        getOrCreateRoutedSession(
          {
            ...buildSessionOptions(),
            approvalMode: turnApprovalAuthority.approvalMode,
            sessionApprovalRules: turnApprovalAuthority.sessionApprovalRules,
          },
          turnRun.observe(handleSessionEvent),
          options.getWindow,
          {
            turnUserMessageId: executionUserMessageId,
            // An admitted dispatch is a pending destination, so a wake already
            // running keeps its output. Codex activates it on its own start;
            // other providers at the send.
            ...(pendingRouteOwner
              ? {
                  dispatchOwner: pendingRouteOwner.dispatchOwner,
                  operationEpoch: pendingRouteOwner.operationEpoch,
                }
              : {}),
            acceptTurnRoot: async (turnUserMessageId) => {
              // Arbitrate in provider-event order. A preceding terminal event may
              // still be waiting for its durable commit; deciding before it lands
              // would reject an ordinary pickup against the turn it just ended.
              await sessionEventCommitTail;
              if (commitPipeline.pending) await commitPipeline.drained();
              await terminalQueueReleaseTail;
              const acceptance = (
                await getChatQueueServiceForTurnLifecycle()
              ).acceptTurnRevival(
                {
                  projectId: options.projectId,
                  worktreeId: options.worktreeId,
                  chatId: options.chatId,
                },
                turnUserMessageId,
              );
              // The queue gate now waits on this root; the pickup's commit
              // decides whether this closure comes to own its turn.
              if (acceptance.accepted)
                unownedTurnRootUserMessageId = turnUserMessageId;
              return acceptance;
            },
            drainEventsBeforeRemoval: drainSessionEvents,
            onRemoved: (): void => {
              void drainSessionEvents().then(() => {
                // The session is gone, so an unowned root's terminal never arrives.
                releaseUnownedTurnRoot('cancelled');
                // Before acceptance the dispatch settles the run itself, at
                // disposal at send or on exit.
                if (isCoworkChat && !turnSettled && activeTurnAccepted)
                  activeTurnRun?.settle(
                    deferredToolsReloadCoordinator.hasActiveReload(options)
                      ? 'completed'
                      : 'cancelled',
                  );
                if (
                  (turnSettled &&
                    (!resumesStoppedTurn || resumedTransportSettled)) ||
                  isCoworkChat
                ) {
                  return;
                }
                if (deferredToolsReloadCoordinator.hasActiveReload(options)) {
                  // A tool reload keeps the logical turn alive, so its plan-file
                  // lease is held until the reload settles. After a hand-off the
                  // continuation's lease has already superseded this one and the
                  // release is a no-op; a reload that fails, is cancelled or
                  // rejected, or times out starts no continuation, and this
                  // release is the only thing that ends the lease.
                  deferredToolsReloadCoordinator.whenActiveReloadSettles(
                    options,
                    closePlanTurn,
                  );
                  if (activeTurnAccepted) activeTurnRun?.settle('completed'); // The reload continues this turn as a new run.
                  return;
                }
                // If no queued provider event settled this turn, release its queue
                // gate even when account teardown had no terminal event to deliver.
                turnSettled = true;
                if (activeTurnAccepted) activeTurnRun?.settle('cancelled');
                closePlanTurn();
                if (resumesStoppedTurn) {
                  getStoppedTurnResumeService().settleTerminalOwnership(
                    {
                      projectId: options.projectId,
                      worktreeId: options.worktreeId,
                      chatId: options.chatId,
                    },
                    executionUserMessageId,
                  );
                }
                if (
                  activeTurnUserMessageIds.get(sessionKey) ===
                  executionUserMessageId
                ) {
                  activeTurnUserMessageIds.delete(sessionKey);
                }
                void getChatQueueServiceForTurnLifecycle().then((queue) => {
                  // Session teardown can finish after the resumed dispatch has
                  // reserved this same user-message anchor. The resume coordinator
                  // distinguishes that ownership even though the queue id cannot.
                  if (resumeOwnsTerminalSettlement()) return;
                  queue.onTurnTerminal(
                    {
                      projectId: options.projectId,
                      worktreeId: options.worktreeId,
                      chatId: options.chatId,
                    },
                    'cancelled',
                    executionUserMessageId,
                  );
                });
              });
            },
          },
        ),
      ),
    );
    // A wake needs an earlier turn on this session. A Claude session this
    // dispatch created can open a turn at its startup init, before any input,
    // and parking behind that would wait on the prompt itself.
    const parkingOwner =
      runtimeProviderType === 'codex' || session === sessionBeforeDispatch
        ? pendingRouteOwner
        : undefined;
    if (!options.hiddenDeferredContinuation) {
      const sessionTurnSettings: SessionTurnSettings = {
        // Keep the selected Agent identity, not its expanded base model, so
        // overlaying a later request resolves the same Agent configuration.
        model: preparedSession.selectedModel,
        modelSelectionMode: options.modelSelectionMode,
        providerType: sessionConfiguration.runtimeProviderType,
        executionHarness: effectiveExecutionHarness,
        pluginSelections: options.pluginSelections,
        planMode: options.planMode,
        modelConfig: sessionConfiguration.effectiveModelConfig,
        thinkingLevel: sessionConfiguration.effectiveModelConfig.thinkingLevel,
        approvalMode:
          preparedSession.persistedDispatchMetadata.approvalMode ??
          options.approvalMode,
        sessionApprovalRules: options.sessionApprovalRules,
        codexProposalMode: options.codexProposalMode,
        codexFastModeEnabled: options.codexFastModeEnabled,
        deferredToolsAllowed: preparedSession.deferredToolsAllowed,
        selectedRepoId: options.selectedRepoId,
      };
      setSessionTurnSettings(
        options.projectId,
        options.worktreeId,
        options.chatId,
        sessionTurnSettings,
      );
    }
    if (preparation.cancelled) return;
    const authoritativeGlobalInstructionsSnapshot =
      getSessionGlobalInstructionsSnapshot(
        options.projectId,
        options.worktreeId,
        options.chatId,
      ) ?? sessionConfiguration.globalInstructionsBlock;
    if (
      options.globalInstructionsSnapshot !==
      authoritativeGlobalInstructionsSnapshot
    ) {
      sendWorktreeChatEvent(
        options.getWindow,
        options.projectId,
        options.worktreeId,
        options.chatId,
        {
          type: GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
          globalInstructionsSnapshot: authoritativeGlobalInstructionsSnapshot,
        },
      );
    }

    deferredToolsReloadCoordinator.registerResumeHandler(
      {
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
      },
      async (request) => {
        request.signal.throwIfAborted();
        // This turn consumed its capability. The continuation is admitted
        // through the hold the reload took at its interruption, once its
        // predecessor's end commits.
        const admission = await (
          await getChatQueueServiceForTurnLifecycle()
        ).admitDirectDispatchWhenAllowed(
          {
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
          },
          request.userMessageId,
          request.signal,
          request.requestId,
        );
        request.signal.throwIfAborted();
        if (!admission)
          throw new Error('The reload could not continue this chat.');
        const { authorization: _consumedAuthorization, ...continuation } =
          options;
        void _consumedAuthorization;
        try {
          await getChatStateService().runWithScopeActivity(
            {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
            },
            () =>
              dispatchWorktreeChatTurn({
                ...continuation,
                ...(admission.authorization
                  ? { authorization: admission.authorization }
                  : {}),
                userMessageId: request.userMessageId,
                text: request.continuationText,
                ...claudeContinuationSession(options, {
                  requestedSessionId: request.sdkSessionId,
                  providerSessionId: session.getProviderSessionId?.(),
                }),
                providerType: request.providerType ?? runtimeProviderType,
                pluginSelections:
                  request.pluginSelections ??
                  runtime?.pluginSelections ??
                  options.pluginSelections,
                hiddenContext: undefined,
                fileReferences: undefined,
                attachmentPaths: undefined,
                attachmentPromptContexts: undefined,
                pendingSystemInstructions: undefined,
                activePlan: undefined,
                startsNewTrackedChat: false,
                skipBranchNaming: true,
                hiddenDeferredContinuation: true,
                deferredToolsReloadEnabledResources: request.enabledResources,
                providerEventSequenceNamespace: request.requestId,
              }),
          );
        } catch (error) {
          admission.release();
          throw error;
        }
        if (request.signal.aborted) {
          await destroySession(
            options.projectId,
            options.worktreeId,
            options.chatId,
            { retainDelegations: true },
          );
          request.signal.throwIfAborted();
        }
      },
    );

    const observabilityService = await observabilityServicePromise;
    const usageScope = await resolveUsageChatScope({
      projectId: options.projectId,
      isCoworkChat,
      selectedRepoId: options.selectedRepoId,
    });
    // The memory block is only needed by the observability record below and by
    // `session.sendMessage`, so the race is settled here rather than right
    // after the visible text is built. Everything in between — dispatch
    // metadata and preference reads, model-runtime resolution, session
    // creation/resume — is work the turn does anyway, and the in-flight fetch
    // now overlaps it instead of blocking ahead of it. The budget stays
    // anchored at dispatch start, so that overlap is subtracted from the wait
    // rather than added to the turn: a fetch that finished during setup costs
    // nothing, and the total added delay can never exceed the budget.
    const preparedMemory = await turnDispatchTiming.measure('org_memory', () =>
      raceWithTimeout(
        memoryPromise,
        remainingMemoryBudgetMs(dispatchStartedAt),
      ),
    );
    const memory = preparedMemory?.attempt.result ?? null;
    if (preparedMemory === null) {
      // Race loss: `memoryPromise` is still pending (or resolved to nothing).
      // The tracker attaches a continuation so a late result that would have
      // been injected — a searchId with at least one fact — is attributed as
      // a race_timeout drop instead of leaving the search's delivery outcome
      // null forever. Attached before the dispatch-exit continuation, so a
      // race loss on a turn that later aborts stays a race_timeout.
      memoryDeliveryTracker.noteRaceLoss();
      memoryAbortController.abort();
    }
    const activePlanInstruction = await turnDispatchTiming.measure(
      'active_plan',
      () => activePlanInstructionPromise,
    );
    if (preparation.cancelled) return;
    // A hidden continuation never carries one-shot instructions; they belonged
    // to the turn it continues.
    const instructedSubmittedText = options.hiddenDeferredContinuation
      ? visibleSubmittedText
      : prependPendingSystemInstructions(
          visibleSubmittedText,
          withActivePlanInstruction(
            options.pendingSystemInstructions,
            activePlanInstruction,
          ),
        );
    const submittedText = composeSubmittedText(
      instructedSubmittedText,
      options.hiddenContext?.text,
      joinHiddenBlocks(memory?.renderedBlock, localMemory.value?.renderedBlock),
    );
    // The pre-send verdict under this dispatch's owner (contracts §3): a wake
    // that started while the prompt was prepared keeps the foreground, and the
    // prompt parks behind it in FIFO. Most wakes start during the preparation
    // above, so check before this attempt opens an audit turn or replaces the
    // turn-diff baseline.
    const parkedEarly = parkingOwner && wakeParkingOutcome(parkingOwner);
    if (parkedEarly) await parkBehindWake(options, parkedEarly);
    turnDispatchTiming.measureSync('observability', () => {
      if (
        options.hiddenDeferredContinuation &&
        options.hiddenContinuationKind !== 'stopped_turn_resume'
      ) {
        observabilityService.recordInjectedPromptForOpenChatTurn(
          options.projectId,
          options.worktreeId,
          options.chatId,
          {
            kind: 'system_prompt_append',
            provider: runtimeProviderType,
            applicationCondition: 'deferred_tools_reload_continuation',
            text: options.text,
            deferredToolsReload: {
              enabledResources:
                options.deferredToolsReloadEnabledResources ?? [],
            },
          },
        );
      } else {
        observabilityService.startChatTurn({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          provider: runtimeProviderType,
          model: runtimeModel,
          // The selection (possibly an Agent id) before runtime expansion.
          requestedModel: preparedSession.selectedModel ?? runtimeModel,
          modelSource: runtimeModel ? getModelSource(runtimeModel) : undefined,
          executionHarness: effectiveExecutionHarness,
          serviceTier:
            effectiveExecutionHarness === 'codex'
              ? codexServiceTierForModelConfig(effectiveModelConfig)
              : undefined,
          aiCreditsRouted: isSessionAiCreditsRouted(
            options.projectId,
            options.worktreeId,
            options.chatId,
          ),
          accountProxyRouted: isSessionAccountProxyRouted(
            options.projectId,
            options.worktreeId,
            options.chatId,
          ),
          ...(options.modelRouting
            ? { modelRouting: options.modelRouting }
            : {}),
          sdkSessionId: options.sdkSessionId,
          originalUserText: options.text,
          submittedText,
          fileReferences: options.fileReferences,
          planMode: options.planMode,
          systemPromptAppend: observedSystemPromptAppend,
          orgMemoryBlock: memory?.renderedBlock,
          userMessageId: options.userMessageId,
          ...(options.internalRow !== undefined
            ? { internalRow: options.internalRow }
            : {}),
          ...(options.managedDelegationDeliveryId !== undefined
            ? {
                managedDelegationDeliveryId:
                  options.managedDelegationDeliveryId,
              }
            : {}),
          isStandalone: isCoworkChat,
          standaloneProjectId,
          initiationSource: options.initiationSource ?? 'user',
          ...(options.turnTrigger ? { turnTrigger: options.turnTrigger } : {}),
          selectedRepoId: options.selectedRepoId,
          ...usageScope,
          // Same explicit-user eligibility as skill usage, minus hidden context.
          skillSuggestionEligible:
            options.countsTowardSkillUsage === true &&
            !options.hiddenDeferredContinuation &&
            !options.hiddenContext,
        });
      }
    });

    await turnDispatchTiming.measure('live_setters', async () => {
      await session.setPlanMode(options.planMode);
      if (effectiveModelConfig.thinkingLevel !== undefined) {
        await session.setThinkingLevel(effectiveModelConfig.thinkingLevel);
      }
    });
    // Authority narrowed while the session was created, or held by a reused
    // session, still applies.
    const liveApprovalAuthority = await turnDispatchTiming.measure(
      'dispatch_metadata',
      () =>
        resolveChatTurnApprovalAuthority(options, { checkAdmission: false }),
    );
    await turnDispatchTiming.measure('live_setters', async () => {
      restrictSessionApprovalRules(
        options.projectId,
        options.worktreeId,
        options.chatId,
        liveApprovalAuthority.sessionApprovalRules,
      );
      await session.setApprovalMode(liveApprovalAuthority.approvalMode);
      if (
        (runtimeProviderType === 'claude' ||
          runtimeProviderType === 'cursor' ||
          runtimeProviderType === 'copilot' ||
          runtimeProviderType === 'opencode') &&
        session.setRtkEnabled
      ) {
        await session.setRtkEnabled(rtkEnabled);
      }
      if (options.codexProposalMode && session.setCodexProposalMode) {
        await session.setCodexProposalMode(options.codexProposalMode);
      }
      if (codexPreferences && session.setCodexAppServerIdleTimeoutMinutes) {
        await session.setCodexAppServerIdleTimeoutMinutes(
          codexPreferences.codexAppServerIdleTimeoutMinutes,
        );
      }
      await applyAgentSessionCodexSpeed(session, effectiveModelConfig.speed);
      await session.setContextWindow?.(effectiveModelConfig.contextWindow);
    });

    if (!isCoworkChat && !options.hiddenDeferredContinuation) {
      await turnDispatchTiming.measure('turn_capture', () =>
        captureTurnStart(sessionKey, options.projectId, options.worktreeId),
      );
    }
    if (preparation.cancelled) {
      if (!options.hiddenDeferredContinuation) {
        observabilityService.completeChatTurn(
          options.projectId,
          options.worktreeId,
          options.chatId,
          'interrupted',
        );
      }
      return;
    }
    // The last pre-send verdict, with no await between it and the send below.
    const parked = parkingOwner && wakeParkingOutcome(parkingOwner);
    if (parked) {
      // The wake started after the early check: undo this attempt's audit
      // turn and diff baseline, as a cancelled preparation does.
      observabilityService.completeChatTurn(
        options.projectId,
        options.worktreeId,
        options.chatId,
        'interrupted',
      );
      discardTurnStart(sessionKey);
      await parkBehindWake(options, parked);
    }
    // A prompt's send disarms a reload continuation that never started, so
    // its cause can't head this turn.
    if (!options.hiddenDeferredContinuation)
      armTurnLifecycleContinuation(options, null);
    if (!isCoworkChat && !options.hiddenDeferredContinuation) {
      // Serialization is owned by the chat queue service (a second dispatch
      // cannot start while it holds turnActive). A leftover marker here means
      // the previous turn died without its terminal event (destroyed session,
      // test double); overwrite rather than wedge the chat — the stale turn's
      // late terminal is filtered by the userMessageId mismatch check above.
      activeTurnUserMessageIds.set(sessionKey, options.userMessageId);
    }
    if (
      options.startsNewTrackedChat &&
      !options.hiddenDeferredContinuation &&
      options.projectId !== APP_ADVISOR_PROJECT_ID
    ) {
      await notifyCanonicalChatStarted(
        options,
        options.userMessageId,
        watcherAcceptedAt,
        watcherContext,
      ).catch(() => undefined);
    }
    if (isCodeReview) {
      // Open the active-turn gate so a review regeneration triggered by real
      // worktree activity defers until this turn settles. `options.worktreeId`
      // is the composite scope key for this sentinel scope; the hook resolves
      // the real ids via the code-review registry. The matching
      // `noteCodeReviewTurnEnd` runs in the terminal chat-event handler above.
      noteCodeReviewTurnStart(options.worktreeId);
    }
    await assertCoworkChatRootPresent(options.projectId, options.worktreeId);
    // Take the plan-file turn lease with no await before the send, so a
    // cancelled preparation never takes one. Every exit below ends it: the
    // root terminal event, a rejected send, a session disposed at send, or
    // session removal without a terminal event.
    turnDispatchTiming.measureSync('scope_lease', openPlanTurn);
    let delegationDeliveryClaimed = false;
    try {
      // Recheck after every asynchronous preparation step. A closed generation
      // must never start a paid continuation from an already-claimed queue row.
      if (
        options.managedDelegationDeliveryId &&
        (options.managedDelegationDeliveryId !== options.userMessageId ||
          !claimDelegationDelivery(
            options,
            options.managedDelegationDeliveryId,
          ))
      )
        throw new Error('Delegation completion owner is no longer active');
      delegationDeliveryClaimed = Boolean(options.managedDelegationDeliveryId);
      // No await between this fence and queue acceptance. Parent Stop after
      // acceptance must not cancel an independent child's lifetime.
      options.admissionSignal?.throwIfAborted();
      turnRun.signal.throwIfAborted();
      // A Claude start carries no binding receipt (its prompt binds at its
      // result), so its destination activates here, after the last check.
      if (pendingRouteOwner && runtimeProviderType !== 'codex')
        activatePendingTurnRoute(
          options,
          pendingRouteOwner.dispatchOwner,
          pendingRouteOwner.operationEpoch,
        );
      reservePromptBindingSlot(options, options.userMessageId);
      turnDispatchTiming.measureSync('enqueue', () =>
        turnRun.executeSync(() =>
          session.sendMessage(submittedText, {
            userMessageId: options.userMessageId,
            ...(effectiveExecutionHarness === 'opencode' &&
            !options.hiddenDeferredContinuation &&
            options.attachmentPaths?.length
              ? {
                  attachments: {
                    baseDir: attachmentBaseDir,
                    paths: [...options.attachmentPaths],
                  },
                }
              : {}),
            ...(options.countsTowardSkillUsage === true &&
            !options.hiddenDeferredContinuation
              ? { countsTowardSkillUsage: true }
              : {}),
          }),
        ),
      );
      const enqueuedSlowDiagnostic = turnDispatchTiming.markEnqueued();
      if (enqueuedSlowDiagnostic)
        recordSlowDispatchDiagnostic(enqueuedSlowDiagnostic);
      // The provider took the request as its own turn, so its delivery id
      // leaves the root's admitted set: nothing can replay it, and the set
      // stays bounded.
      if (delegationDeliveryClaimed && options.managedDelegationDeliveryId)
        retireDelegationDelivery(options, options.managedDelegationDeliveryId);
      // A waiting provider loop dequeues the prompt at once but may still
      // await work before marking the turn active; hold until it does.
      releaseSessionTurnPreparationOnActivation(
        sessionKey,
        releaseSessionTurnPreparation,
      );
      releaseSessionTurnPreparation = undefined;
    } catch (error) {
      closePlanTurn();
      if (delegationDeliveryClaimed && options.managedDelegationDeliveryId)
        releaseDelegationDelivery(options, options.managedDelegationDeliveryId);
      if (memory && memory.facts.length > 0 && memory.searchId) {
        // The block was prepared and composed but the provider rejected the
        // turn, so this search's injection verifiably did not reach the
        // model. Attribute it before rethrowing; the ack never throws.
        memoryDeliveryTracker.ackDropped(
          memory.organizationExternalId,
          memory.searchId,
          'send_failed',
        );
      }
      throw error;
    }
    if (
      !options.hiddenDeferredContinuation &&
      session.isDisposed?.() !== true &&
      (options.initiationSource === undefined ||
        options.initiationSource === 'user' ||
        options.initiationSource === 'portal')
    ) {
      for (const id of handoffsAtSend) browserHandoffs.release(id);
    }
    turnRun.accepted();
    activeTurnAccepted = true;
    options.onTurnAccepted?.();
    // `sendMessage` enqueues without inspecting session state, so a session
    // destroyed between dispatch and send still accepts the composed turn into
    // a queue no provider will ever drain. No terminal event will end that
    // turn, and its removal may already have run.
    const sessionDisposedAtSend = session.isDisposed?.() === true;
    if (sessionDisposedAtSend) {
      closePlanTurn();
      turnRun.settle('cancelled');
    }
    if (memory && memory.facts.length > 0) {
      // A turn sent into a disposed session is a drop, not a delivery — and a
      // dropped block must not be persisted or broadcast as a used memory
      // either, or the UI would show (and accept feedback on) an injection
      // that never reached the model.
      if (memory.searchId) {
        if (sessionDisposedAtSend) {
          memoryDeliveryTracker.ackDropped(
            memory.organizationExternalId,
            memory.searchId,
            'turn_aborted',
          );
        } else {
          // Fire-and-forget delivery ack: `session.sendMessage` above means
          // the composed turn was accepted into a live session's in-memory
          // queue. That is queue acceptance — the strongest signal available
          // at this seam — not verified model receipt. The ack never throws
          // and must not gate the turn.
          memoryDeliveryTracker.ackDelivered(
            memory.organizationExternalId,
            memory.searchId,
          );
        }
      }
      if (sessionDisposedAtSend) {
        return;
      }
      await persistOrgMemoryUsedForChat({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        userMessageId: options.userMessageId,
        organizationExternalId: memory.organizationExternalId,
        ...(memory.searchId ? { searchId: memory.searchId } : {}),
        facts: memory.facts,
      }).catch((error: unknown) => {
        // Keep the turn alive if durable disclosure persistence fails. A live
        // renderer can still apply the event below, while renderer-less paths
        // get a diagnostic instead of silently dropping the write.
        // eslint-disable-next-line no-console
        console.error('[org-memory] Failed to persist memory-used metadata', {
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      const memoryUsedEvent: OrgMemoryUsedEventData = {
        type: ORG_MEMORY_USED_EVENT_TYPE,
        localChatId: options.chatId,
        localMessageId: options.userMessageId,
        organizationExternalId: memory.organizationExternalId,
        ...(memory.searchId ? { searchId: memory.searchId } : {}),
        facts: memory.facts,
      };
      sendWorktreeChatEvent(
        options.getWindow,
        options.projectId,
        options.worktreeId,
        options.chatId,
        memoryUsedEvent,
      );
    }
  } catch (error) {
    dispatchFailure = { error };
    throw error;
  } finally {
    activeTurnRun?.abandon(dispatchFailure?.error);
    releaseSessionTurnPreparation?.();
    preparation.finish();
    resourceGuard?.release();
    // Every exit path settles the delivery tracker: if this dispatch ended
    // without a delivered ack, an injectable memory result — resolved or
    // still in flight — is attributed as a turn_aborted drop. No-op when the
    // outcome was already acked above.
    memoryDeliveryTracker.noteDispatchExit();
  }
}

export const worktreeChatTurnTestExports = {
  currentSessionEventHandlerCount:
    sessionEventRouterTestExports.currentRouteCount,
  resetCurrentSessionEventHandlers: sessionEventRouterTestExports.reset,
  /**
   * Read the active-turn marker. Test-only: production code either sets it
   * during dispatch or clears it through
   * {@link clearActiveTurnUserMessageId}, and a public getter would invite
   * reads that race the turn it describes.
   */
  activeTurnUserMessageId: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string | undefined =>
    activeTurnUserMessageIds.get(
      buildSessionKey(projectId, worktreeId, chatId),
    ),
};
