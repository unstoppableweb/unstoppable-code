import { assertCoworkChatRootPresent } from '../lib/cowork-folder-guard';
import { committedSelectionsStillStored } from './committed-plugin-selections';
import { chatVisualsPromptEligible } from '../lib/chat-visuals-feature-flag';
import { DELEGATION_NOTICE_KIND } from '@canopy/agent-actions';
import {
  resolveChatModelChangeHarness,
  supportsChatHarnessChoice,
} from '@canopy/desktop-shared/lib/chat-model-selection';
import { isOpenCodeRuntimeAvailable } from '../opencode/runtime-availability';
import { assertOpenCodeSelectionAvailable } from '../opencode/selection';
import { assertCopilotModelAvailable } from '../copilot/connection';
import { isCopilotRuntimeAvailable } from '../copilot/runtime-availability';
import { assertCopilotHarnessEnabled } from '../copilot/feature-flag';
import { TurnAuthPreflightBlockedError } from '../lib/auth-preflight-error';
import { assertCursorHarnessEnabled } from '../cursor/feature-flag';
import { buildTrustedUserPromptEvent } from '../lib/chat-trusted-user-prompt';
import { claudeContinuationSession } from '../lib/claude-fork-continuation';
import {
  getOrCreateRoutedSession,
  getTurnRootAcceptance,
  isOwnedDelegationEvent,
} from '../agents/session-event-router';
import {
  beginChatTurnRun,
  deferredReloadEventNamespace,
  type ChatTurnRunHandle,
} from '../agent-runs/turn-runs';
import { withEffectiveAiCreditsRouting } from '../agents/effective-ai-credits-routing';
import { requestAppAdvisorPresentation } from '../app-advisor/advisor-presentation';
import { randomUUID } from 'node:crypto';
import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { BRAND } from '@canopy/brand/current';
import { registerIpcHandler } from './register';
import { noteChatDriver } from '../remote-control/host/chat-drivers';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import type { WindowAccessors } from './index';
import {
  IPC_CHANNELS,
  DEFAULT_HANDOFF_SUMMARY_MODEL,
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  getExecutionHarnessForModel,
  getModelDisplayName,
  getModelSource,
  getChatHarnessOptions,
  getProviderForChatModel,
  getProviderForModel,
  inferLegacyExecutionHarness,
  isAgentModel,
  isBaseModelSelectableForAgent,
  isInheritingAgentModel,
  isTerminalBackedInterfaceMode,
  isThinkingLevel,
  normalizeAgentModelConfig,
  normalizeThinkingForProvider,
  resolveModelAlias,
  resolveProviderModelConfig,
  resolveKnownModel,
  requireProviderForModel,
  type AgentModelConfig,
  type ChatTabSettingsPatch,
  type AgentProviderType,
  type ApprovalDefaults,
  type ApprovalMode,
  type ChatActiveSessionInfo,
  type ChatActiveSessions,
  type ChatInterfaceMode,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import { codexServiceTierForModelConfig } from '@canopy/execution-engine/lib/codex-model-config';
import {
  applyAgentSessionCodexSpeed,
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  CodexSpeedUnsupportedError,
  isCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  appendUserOverallPreferencesBlock,
  buildUserOverallPreferencesBlock,
} from '@canopy/execution-engine/lib/global-instructions';
import type { CodexReasoningProviderType } from '@canopy/execution-engine/lib/gateway-model-availability';
import type { PersistedChatDispatchMetadata } from '../lib/chat-tabs-reader';
import type {
  CancelQueuedHookChatRequest,
  CancelQueuedHookChatResponse,
  ChatSendMessageRequest,
  ChatSendMessageResult,
  ChatCancelIpcRequest,
  ChatCancelRequest,
  ChatContextUsageBreakdown,
  ChatContextUsageRequest,
  ChatCancelResult,
  ChatResumeStoppedTurnRequest,
  ChatResumeStoppedTurnResult,
  ChatQueueEditRequest,
  ChatQueueEntryRequest,
  ChatQueueSetEditLockRequest,
  ChatQueueSnapshotRequest,
  ChatQueueUpdatedEvent,
  ChatResetToPointRequest,
  ChatResetToPointResponse,
  ForceQueuedHookChatRequest,
  ForceQueuedHookChatResponse,
  SetQueuedHookChatInterfaceModeRequest,
  SetQueuedHookChatInterfaceModeResponse,
  ChatLoadTabsRequest,
  ChatUpdatePluginsRequest,
  ChatUpdatePluginsResponse,
  CodexFastModeToggleRequest,
  ForkCodexThreadRequest,
  ForkCodexThreadResponse,
  GenerateHandoffSummaryRequest,
  GenerateHandoffSummaryResponse,
  HandoffSummaryKind,
  AgentAuditLinkTarget,
  McpAnswerUserRequest,
  McpAnswerUserResponse,
  McpDismissUserRequest,
  PersistedChatTab,
  PlanExitApproveRequest,
  PlanExitDenyRequest,
  PlanModeToggleRequest,
  PlanFileInstructionPurpose,
  PreparePlanFileSystemInstructionRequest,
  PreparePlanFileSystemInstructionResponse,
  ThinkingLevelToggleRequest,
  ModelChangeRequest,
  DeferredToolsReloadBeginRequest,
  DeferredToolsReloadFinishRequest,
  DeferredToolsReloadCancelRequest,
  DeferredToolsReloadAck,
} from '@canopy/desktop-shared/types';
import {
  chatSurfaceUsesGlobalPluginDefaults,
  normalizePluginSelectionTombstones,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../lib/resolve-worktree';
import { describeTurnAuthRefusal } from '../lib/auth-preflight';
import { clearUsageLimitedChat } from '../lib/usage-limited-chats-registry';
import { getWorkspaceType, isCoworkWorkspace } from '../lib/workspace-registry';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { isCursorRuntimeAvailable } from '../cursor/runtime-availability';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { stopExactChatTurn } from './chat-cancel-exact';
import {
  getSession,
  chatHasNativeBackgroundWork,
  getActiveChatIds,
  getActiveSessionInfos,
  getActiveSessionCapabilityProfile,
  isProviderChangeAllowed,
  buildSessionKey,
  destroySession,
  markSessionForNextTurnRecreation,
  sessionHasActiveTurnOrNativeWork,
  getSessionSelectedModel,
  getSessionProviderType,
  getSessionGlobalInstructionsSnapshot,
  shouldRecreateSessionOnNextTurn,
  updateSessionModel,
  updateSessionTurnSettingsModel,
  isSessionAccountProxyRouted,
  isSessionAiCreditsRouted,
  getSessionAiCreditsRoutedState,
  getContextUsageForSession,
  restrictSessionApprovalRules,
} from '../agents/session-manager';
import { generateHandoffSummary } from '../agents/utils';
import {
  captureSessionWorkOwner,
  resolveAiCreditsScopeOwner,
  resolveSessionWorkOwner,
} from '../agents/work-owner';
import { buildHandoffSummaryInputFromTranscript } from '@canopy/agent-transcript';
import { resolveAgentModelRuntime } from '../agents/agent-model-runtime';
import {
  formatInheritedAgentRoute,
  resolveAgentDestinationDefaultModel,
  resolveSendModelPin,
} from '../agents/agent-default-model';
import { forkCodexThreadByIdViaOneShot } from '../codex/fork-thread';
import {
  answerChatQuestionFromRenderer,
  respondToLiveChatQuestion,
  trackSettledChatQuestions,
} from '../chat-questions/respond';
import { getDesktopChatWaits } from '../chat-waits/desktop-chat-waits';
import { normalizeAccountMcpSelections } from '../mcp/account-catalog';
import { getChatStateService } from '../services/chat-state-service';
import {
  consumeDispatchAuthorization,
  type AuthorizedChatDispatch,
} from '../services/chat-dispatch-authorization';
import { reservePromptBindingSlot } from '../services/chat-turn-binding-slots';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
  setCoreChatSettingsHost,
} from '../canopy-runtime/core-chat-command-adapter';
import type {
  CoreChatModelChange,
  CoreChatSettingsTarget,
} from '../canopy-runtime/core-chat-command-adapter';
import {
  createCoreChatSettingsHost,
  isModelChangeSuperseded,
} from '../services/chat-settings-host';
import type { ChatSettingsLiveEffects } from '../services/chat-settings-host';
import {
  CoreChatLifecycleResultSchema,
  CoreChatUpdateParamsSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import type { DesktopCanopyRuntimeAccessors } from './index';
import type {
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';

import { approvePlanExit, denyPlanExit } from '../mcp/plan-pending-requests';
import { readPreferencesFile } from './preferences';
import { setApprovalModeSetter } from './approvals';
import {
  beginApprovalModeTransition,
  clampToLiveApprovalMode,
  clearLiveApprovalMode,
  endApprovalModeTransition,
  getLiveApprovalMode,
  getPendingApprovalMode,
  isApprovalModeDowngrade,
  isApprovalModeTransitionCurrent,
  setLiveApprovalMode,
  withApprovalModeOperation,
} from '../approvals/live-approval-modes';
import { reevaluatePendingApprovalsForChat } from '../approvals/approval-session-registry';
import { recordBackgroundProcessChatEvent } from '../portal/background-process-tracker';
import {
  getDiagnosticEventMetadata,
  getChatTurnAuditStatus,
  isRootTerminalChatEventData,
  isRecord,
  isTerminalChatEventData,
  readCodexRootThreadId,
} from '../lib/chat-turn-audit';
import { sendToWindow, sendToWindowDetailed } from '../lib/window-send';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import {
  buildExistingTabDispatchOptions,
  cancelWorktreeChatTurn,
  dispatchLocalWorktreeChatMessage,
  assertWatcherDeliveryIngress,
  resumeStoppedWorktreeChatTurn,
  setAutoModelRoutingDispatcher,
  setSendModelPreparer,
  setWorktreeChatWindowAccessor,
  setSpecialNativeChatDispatcher,
} from '../services/chat-service';
import {
  getChatQueueService,
  type ChatQueueRevivalLease,
} from '../services/chat-queue-service';
import { getStoppedTurnResumeService } from '../services/stopped-turn-resume-service';
import {
  assertNotSplitLocked,
  isSplitLocked,
} from '../services/split-lock-service';
import {
  installChatAutoArchiver,
  onCommittedArchiveUnblocks,
} from '../services/chat-auto-archive';
import { chatCloseBlockReason } from '../agents/background-work';
import { dispatchAppAdvisorChatMessage } from '../app-advisor/chat-service';

import { dispatchPipelineEditorChatMessage } from '../pipeline-editor/chat-service';
import {
  createPortalEvent,
  enqueuePortalEvent,
} from '../portal/portal-event-bus';
import { runtimeChatEventToPortalMessage } from '../services/chat-transcript-projector';
import { resetChatToPoint } from '../lib/chat-reset-to-point';
import { assertWritableScope } from '../lib/read-only-scope';
import { assertChatScopeAcceptsTurns } from '../lib/retired-chat-scope-guard';
import { buildSubmittedMessageText } from '../lib/chat-submitted-message';
import {
  beginChatAutoRouting,
  captureChatTurnStopWithTurn,
  stopChatTurn,
} from '../lib/chat-turn-stop';
import type { ChatTurnStopContext } from '../lib/chat-turn-cancel';
import {
  cancelTransientRetryForChat,
  getTransientRetryStateSnapshot,
} from '../lib/transient-error-retry-service';
import { readPersistedChatDispatchMetadata } from '../lib/chat-tabs-reader';
import { buildPlanFileSystemInstruction } from '../lib/plan-system-instructions';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { holdDispatchForDeferredReload } from '../services/deferred-reload-dispatch-hold';
import {
  cancelQueuedHookChat,
  forceQueuedHookChat,
  updateQueuedHookChatInterfaceMode,
  hasQueuedHookChat,
  updateQueuedHookChatApprovalMode,
  updateQueuedHookChatModel,
  updateQueuedHookChatCodexFastMode,
  updateQueuedHookChatPlanMode,
  updateQueuedHookChatPluginSelections,
  updateQueuedHookChatThinkingLevel,
} from '../lib/hook-chat';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { buildWorktreeInjectedToolPrompt } from '../canopy-tools/prompting';
import { buildCoworkDispatchSystemPromptAppend } from '../lib/cowork-chat-system-prompt';
import {
  composeSubmittedText,
  joinHiddenBlocks,
  raceWithTimeout,
  remainingMemoryBudgetMs,
} from '../memory/memory-context';
import { createOrgMemoryDeliveryTracker } from '../memory/delivery-tracker';
import { persistOrgMemoryUsedForChat } from '../lib/chat-tab-dispatch-utils';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import { MAX_TELEMETRY_CLIENT_ID_LENGTH } from '@canopy/protocol/telemetry';
import { clampId } from '@canopy/desktop-shared/lib/telemetry-mapping';
import {
  ORG_MEMORY_USED_EVENT_TYPE,
  type OrgMemoryUsedEventData,
} from '@canopy/desktop-shared/types';
import { prepareLocalMemoryContext } from '../memory/local/prepare';
import { resolveLocalMemoryPolicy } from '../memory/local/policy';
import { describeChatEventData } from '../lib/chat-event-description';
import { buildStandaloneChatLinkTarget } from '../lib/standalone-link-target';
import { CHAT_UNIT_LABEL } from '@canopy/protocol/ui-labels';
import { startObservedHelperTask } from '../lib/helper-observed-task';
import { getStructuredHelperQueryErrorUsage } from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  getResourceMonitorService,
  type ResourceGuardReservation,
} from '../resource-monitor';
import { getClaudeTerminalSessionService } from '../integration/claude-terminal-session-service';
import { assertUntrustedChatInput } from '../agent-messaging/untrusted-input';
import { getDesktopIntegrationServer } from '../integration/desktop-integration-server';
import {
  WatcherDeliveryHeldError,
  captureCanonicalChatProducerContext,
  notifyCanonicalChatStarted,
  notifyCanonicalChatTerminal,
} from '../services/active-chat-input';
import { isUsageInitiationSource } from '@canopy/desktop-shared/lib/turn-utils';
import { scheduleSummaryGeneration } from '../lib/worktree-summary-scheduler';
import {
  scheduleChatSummary,
  prepareOrgMemory,
} from '../lib/worktree-chat-turn';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { resolveChatTurnApprovalAuthority } from '../lib/chat-turn-approval-authority';
import { latchFirstTaskSubmitted } from '../notifications/campaigns/activation-signals';
import { routeDesktopAutoTurn } from '../model-routing/route-turn';
import {
  assertAutoRoutingCodexSpeed,
  resolveAutoRoutingCodexSpeed,
} from '../codex/speed-policy';
import {
  AutoModelRoutingApplyError,
  isAutoModelRoutingApplyError,
} from '../model-routing/apply-error';
import { materializeCodexCapabilityTransition } from '../codex/capability-transition';
import {
  beginApprovalDefaultIntent,
  beginPendingApprovalDefaultWrite,
  commitApprovalDefaultIntent,
  defaultsKeyForSurface,
  isEphemeralApprovalSurface,
  isApprovalDefaultIntentCurrent,
  resolveApprovalProjectId,
  resolvePersistedApprovalMode,
  surfaceForChat,
} from '../lib/approval-mode-resolution';
import {
  projectPreferencesForRuntime,
  peekPreferencesLoadError,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
import {
  getEffectiveClaudeChatModePreferences,
  getPersistedClaudeChatInterfaceMode,
} from '../lib/claude-tui-chats';
import {
  projectQueueCancel,
  projectQueueEdit,
  projectQueueEditLock,
  projectQueueForce,
} from './chat-queue-projections';

let chatCommandRuntime: DesktopCanopyRuntimeAccessors | undefined;

export function dispatchCanonicalChatCommand(
  request: ChatCommandRequest,
): Promise<ChatCommandResult> {
  if (!chatCommandRuntime) return getChatStateService().command(request);
  const port = getChatStateService();
  return dispatchTrustedChatCommand(
    request,
    createChatCommandDispatchOptions(port, chatCommandRuntime.dispatcher, {
      principalId: 'local-desktop-user',
      clientInstanceId: 'desktop-main-chat',
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: ['core.chat.write'],
    }),
  );
}
const codexCapabilityTransitionLocks = new Map<string, Promise<void>>();
const modelChangeLocks = new Map<string, Promise<void>>();

/**
 * Valid `purpose` values for `chatPreparePlanFileSystemInstruction`. A `Set`
 * rather than plain-object indexing for the same prototype-pollution reason
 * as {@link HANDOFF_SUMMARY_KINDS}: an IPC payload of `'constructor'` must not
 * resolve as a valid purpose.
 */
const PLAN_FILE_INSTRUCTION_PURPOSES: ReadonlySet<unknown> =
  new Set<PlanFileInstructionPurpose>(['authored-plan', 'active-plan']);
type NormalizedModelSettings = {
  thinkingLevel: NonNullable<ChatTabSettingsPatch['thinkingLevel']>;
  modelConfig: AgentModelConfig;
  codexFastModeEnabled: boolean;
  interfaceMode: ChatInterfaceMode | null;
};

/**
 * Every `HandoffSummaryKind`, mapped to itself. Declaring this as a
 * `Record<HandoffSummaryKind, HandoffSummaryKind>` makes a new union member a
 * compile error rather than a value that silently fails to parse. The values
 * (not the keys) are what the lookup returns, which narrows an arbitrary IPC
 * payload without a cast — the same pattern `parseAgentAuditEventType` uses.
 */
const HANDOFF_SUMMARY_KIND_VALUES: Record<
  HandoffSummaryKind,
  HandoffSummaryKind
> = {
  'continue-on-other-harness': 'continue-on-other-harness',
  'stale-session': 'stale-session',
  'archived-chat': 'archived-chat',
};

/**
 * A `Map` rather than plain-object indexing: object lookup would resolve
 * inherited `Object.prototype` keys, so an IPC payload of `'constructor'`
 * would parse as a valid kind instead of `undefined`.
 */
const HANDOFF_SUMMARY_KINDS: ReadonlyMap<unknown, HandoffSummaryKind> = new Map(
  Object.values(HANDOFF_SUMMARY_KIND_VALUES).map((kind) => [kind, kind]),
);

/**
 * Audit label suffix per handoff kind. Exhaustive for the same reason: adding
 * a kind without a suffix here is a compile error instead of a new flow that
 * silently shows the generic label in the Audit Trail.
 */
const HANDOFF_SUMMARY_KIND_SUFFIXES: Record<HandoffSummaryKind, string> = {
  'continue-on-other-harness': ' (Continue)',
  'stale-session': ' (Stale Session)',
  'archived-chat': ' (Archive)',
};

function readHandoffSummaryKind(
  value: unknown,
): HandoffSummaryKind | undefined {
  return HANDOFF_SUMMARY_KINDS.get(value);
}

function handoffSummaryAuditLabel(
  kind: HandoffSummaryKind | undefined,
): string {
  const suffix = kind ? HANDOFF_SUMMARY_KIND_SUFFIXES[kind] : '';
  return `${CHAT_UNIT_LABEL} Handoff Summary${suffix}`;
}

function buildHandoffSummaryLinkTarget(
  req: GenerateHandoffSummaryRequest,
): AgentAuditLinkTarget {
  if (req.projectId === APP_ADVISOR_PROJECT_ID) {
    return {
      page: 'main',
      kind: 'app-advisor',
      chatId: req.chatId,
    };
  }
  if (isCoworkWorkspace(req.projectId)) {
    // `isCoworkWorkspace` deliberately aliases the legacy standalone sentinel,
    // and in that shape the real cowork workspace id lives in `worktreeId`.
    // Persisting the sentinel itself would make Inspect call
    // `switchChatProject('standalone-chat')` — a dead link for exactly the
    // compatibility keying the repo preserves. Normalize the same way
    // `portalChatEventScope` in `services/chat-service.ts` does.
    const coworkWorkspaceId =
      req.projectId === STANDALONE_CHAT_PROJECT_ID
        ? req.worktreeId
        : req.projectId;
    // Pass `chatId` through unchanged — never fall back to `worktreeId`. In
    // cowork the `worktreeId` slot carries the Work Entry id, and
    // `AuditTrailPage.openEntry` feeds `chatId` straight to `selectChat`,
    // which resolves "which Work Entry owns this chat" and would never match
    // an entry id. A workspace-level target (no `chatId`) still navigates
    // correctly, so a missing id degrades better than a wrong one.
    return buildStandaloneChatLinkTarget(coworkWorkspaceId, req.chatId);
  }
  return {
    page: 'main',
    kind: 'worktree-chat',
    projectId: req.projectId,
    worktreeId: req.worktreeId,
    chatId: req.chatId,
  };
}

async function withCodexCapabilityTransitionLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = codexCapabilityTransitionLocks.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  codexCapabilityTransitionLocks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (codexCapabilityTransitionLocks.get(key) === tail) {
      codexCapabilityTransitionLocks.delete(key);
    }
  }
}

async function withModelChangeLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = modelChangeLocks.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  modelChangeLocks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (modelChangeLocks.get(key) === tail) modelChangeLocks.delete(key);
  }
}

function logUndeliveredChatEvent(
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: unknown,
): void {
  // eslint-disable-next-line no-console
  console.warn('[chat-ipc] Renderer unavailable for chat event', {
    projectId,
    worktreeId,
    chatId,
    eventType: describeChatEventData(data),
    terminal: isTerminalChatEventData(data),
    sessions: getActiveSessionInfos(projectId, worktreeId),
  });
}

function findMatchingSessionInfo(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ChatActiveSessionInfo | undefined {
  return getActiveSessionInfos(projectId, worktreeId).find(
    (session) => session.chatId === chatId,
  );
}

function recordUndeliveredChatEventDiagnostic(options: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  data: unknown;
  providerType?: AgentProviderType;
  model?: ChatModel;
  sendFailureReason:
    | 'no_window'
    | 'window_destroyed'
    | 'webcontents_destroyed'
    | 'webcontents_crashed'
    | 'frame_destroyed'
    | 'frame_detached'
    | 'render_frame_disposed';
}): void {
  const matchingSession = findMatchingSessionInfo(
    options.projectId,
    options.worktreeId,
    options.chatId,
  );
  const eventType = describeChatEventData(options.data, {
    includePhaseEvents: true,
  });
  const eventMetadata = getDiagnosticEventMetadata(options.data);
  const timestamp = new Date().toISOString();

  void readPersistedChatDispatchMetadata(
    options.projectId,
    options.worktreeId,
    options.chatId,
  )
    .catch(
      (): PersistedChatDispatchMetadata =>
        ({}) satisfies PersistedChatDispatchMetadata,
    )
    .then((persistedMetadata) => {
      getExecutionObservabilityIngest().recordSessionDiagnostic({
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
          matchingSession?.providerType ??
          eventMetadata.providerType ??
          options.providerType ??
          persistedMetadata.providerType ??
          'unknown',
        ...(matchingSession?.model ||
        eventMetadata.model ||
        options.model ||
        persistedMetadata.model
          ? {
              model:
                matchingSession?.model ??
                eventMetadata.model ??
                options.model ??
                persistedMetadata.model,
            }
          : {}),
        ...(typeof matchingSession?.turnActive === 'boolean'
          ? { turnActive: matchingSession.turnActive }
          : {}),
        ...(typeof matchingSession?.turnCount === 'number'
          ? { turnCount: matchingSession.turnCount }
          : {}),
        ...(typeof matchingSession?.pendingMessageCount === 'number'
          ? { pendingMessageCount: matchingSession.pendingMessageCount }
          : {}),
        ...(matchingSession?.lastEventType
          ? { lastEventType: matchingSession.lastEventType }
          : {}),
        ...(typeof matchingSession?.lastActivityAt === 'number'
          ? { lastActivityAt: matchingSession.lastActivityAt }
          : {}),
        eventType,
        terminal: isTerminalChatEventData(options.data),
        sendFailureReason: options.sendFailureReason,
      });
    });
}

function sendChatEvent(
  win: BrowserWindow | null,
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
  const delivery = sendToWindowDetailed(win, IPC_CHANNELS.chatEvent, {
    projectId,
    worktreeId,
    chatId,
    data,
  });

  if (!delivery.delivered) {
    logUndeliveredChatEvent(projectId, worktreeId, chatId, data);
    recordUndeliveredChatEventDiagnostic({
      projectId,
      worktreeId,
      chatId,
      data,
      providerType: context?.providerType,
      model: context?.model,
      sendFailureReason: delivery.reason,
    });
  }
}

/**
 * Command-boundary check for a requested Codex speed. A legacy boolean-only
 * config stays valid; an exact speed must be supported and its `fastMode`
 * projection, when sent, must agree with it.
 */
function assertCodexSpeedInput(modelConfig: unknown): void {
  if (!isRecord(modelConfig) || modelConfig.speed === undefined) return;
  if (!isCodexSpeed(modelConfig.speed)) {
    throw new Error('Codex speed is unsupported');
  }
  if (
    typeof modelConfig.fastMode === 'boolean' &&
    modelConfig.fastMode !== codexSpeedFastMode(modelConfig.speed)
  ) {
    throw new Error('Codex fast mode contradicts the requested speed');
  }
}

function buildModelConfigInput(
  modelConfig: unknown,
  legacy: {
    thinkingLevel?: unknown;
    codexFastModeEnabled?: unknown;
  },
): AgentModelConfig | undefined {
  assertCodexSpeedInput(modelConfig);
  const normalized = normalizeAgentModelConfig(modelConfig) ?? {};
  if (
    normalized.thinkingLevel === undefined &&
    typeof legacy.thinkingLevel === 'string' &&
    isThinkingLevel(legacy.thinkingLevel)
  ) {
    normalized.thinkingLevel = legacy.thinkingLevel;
  }
  if (
    normalized.fastMode === undefined &&
    typeof legacy.codexFastModeEnabled === 'boolean'
  ) {
    normalized.fastMode = legacy.codexFastModeEnabled;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Resolve the conceptual cowork/standalone chat-project id for meta/history
 * persistence, or `undefined` when the target isn't a cowork chat at all.
 * The legacy standalone-chat sentinel keying carries the conceptual id in
 * `worktreeId`; the rekeyed renderer sends the real cowork workspace id
 * directly in `projectId` (with `worktreeId` fixed to the cowork home
 * worktree slot), so for a real cowork id the conceptual id is `projectId`
 * itself.
 */
function resolveStandaloneChatProjectId(
  projectId: string,
  worktreeId: string,
): string | undefined {
  if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    return worktreeId;
  }
  return isCoworkWorkspace(projectId) ? projectId : undefined;
}

/**
 * Commit a renderer-adjustable settings change to the canonical tab. The
 * legacy settings channels remain the transport, but durable state is
 * main-owned: without this commit a desktop-side flip would live only in the
 * session/renderer memory, never reach a connected portal projection, and be
 * lost on restart. `not_found` is normally tolerated because queued hook
 * placeholders and already-closed tabs have no canonical record to patch;
 * callers that must acknowledge a durable update can require the tab to exist.
 */
async function commitCanonicalTabSettings(
  projectId: string,
  worktreeId: string,
  chatId: string,
  patch: ChatTabSettingsPatch,
  options: { requireExisting?: boolean } = {},
): Promise<void> {
  const result = await dispatchCanonicalChatCommand({
    schemaVersion: 1,
    commandId: `settings-${randomUUID()}`,
    projectId,
    worktreeId,
    command: { type: 'chat.patch_tab_settings', tabId: chatId, patch },
  });
  if (result.outcome === 'not_found' && options.requireExisting) {
    throw new Error('Chat tab was not found while updating tools');
  }
  if (
    result.outcome !== 'applied' &&
    result.outcome !== 'already_applied' &&
    result.outcome !== 'not_found'
  ) {
    throw new Error(
      `Canonical settings patch was ${result.outcome}: ${result.reason ?? 'unknown reason'}`,
    );
  }
}

/** Dispatches a client-style settings update through `core.chat.update` (CAN-4110 D3). */
async function updateChatSettingsThroughCore(
  target: CoreChatSettingsTarget,
  patch: ChatTabSettingsPatch,
): Promise<ChatCommandResult> {
  const { projectId, worktreeId, chatId } = target;
  const commandId = `settings-${randomUUID()}`;
  let result: ChatCommandResult;
  if (chatCommandRuntime) {
    try {
      result = CoreChatLifecycleResultSchema.parse(
        await chatCommandRuntime.dispatcher.instruction(
          'core.chat.update',
          CoreChatUpdateParamsSchema.parse({
            projectId,
            worktreeId,
            commandId,
            action: { type: 'chat.patch_tab_settings', tabId: chatId, patch },
            _meta: { idempotencyKey: commandId },
          }),
          {
            caller: {
              principalId: 'local-desktop-user',
              clientInstanceId: 'desktop-main-chat',
              authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
              interfaceKind: 'desktop',
              grants: ['core.chat.write'],
            },
            metadata: { idempotencyKey: commandId },
          },
        ),
      );
    } catch (error) {
      if (
        error instanceof CanopyOperationError &&
        error.runtimeCause instanceof Error
      )
        throw error.runtimeCause;
      throw error;
    }
  } else {
    result = await createInstalledChatSettingsHost().applySettings(
      {
        commandId,
        target,
        ...(patch.planMode === undefined || patch.planMode === null
          ? {}
          : { planMode: patch.planMode }),
        ...(patch.modelConfig?.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: patch.modelConfig.thinkingLevel }),
        ...(patch.modelConfig?.speed === undefined
          ? {}
          : { speed: patch.modelConfig.speed }),
      },
      getChatStateService(),
    );
  }
  if (
    result.outcome !== 'applied' &&
    result.outcome !== 'already_applied' &&
    result.outcome !== 'not_found'
  ) {
    throw new Error(
      `Canonical settings patch was ${result.outcome}: ${result.reason ?? 'unknown reason'}`,
    );
  }
  return result;
}

/** The post-commit effects of the plan, thinking and Codex speed setters. */
function chatSettingsLiveEffects(): ChatSettingsLiveEffects {
  return {
    planMode: async ({ projectId, worktreeId, chatId }, enabled) => {
      updateQueuedHookChatPlanMode({ projectId, worktreeId, chatId, enabled });
      await getClaudeTerminalSessionService().setPlanMode(
        projectId,
        worktreeId,
        chatId,
        enabled,
      );
      const session = getSession(projectId, worktreeId, chatId);
      if (session) {
        if (!sessionHasActiveTurnOrNativeWork(projectId, worktreeId, chatId)) {
          await session.setPlanMode(enabled);
        }
        if (!isCoworkWorkspace(projectId)) {
          markSessionForNextTurnRecreation(
            projectId,
            worktreeId,
            chatId,
            'plan',
          );
        }
      }
      getChatQueueService().refreshRestartHold({
        projectId,
        worktreeId,
        chatId,
      });
    },
    thinkingLevel: async ({ projectId, worktreeId, chatId }, level) => {
      updateQueuedHookChatThinkingLevel({
        projectId,
        worktreeId,
        chatId,
        level,
      });
      const session = getSession(projectId, worktreeId, chatId);
      if (
        session &&
        !sessionHasActiveTurnOrNativeWork(projectId, worktreeId, chatId)
      ) {
        await session.setThinkingLevel(level);
      }
    },
    speed: async ({ projectId, worktreeId, chatId }, speed) => {
      updateQueuedHookChatCodexFastMode({
        projectId,
        worktreeId,
        chatId,
        enabled: codexSpeedFastMode(speed),
        speed,
      });
      const session = getSession(projectId, worktreeId, chatId);
      if (session) {
        try {
          await applyAgentSessionCodexSpeed(session, speed);
        } catch (error) {
          // The durable choice is kept; the next send's admission reports
          // that this session cannot run the requested speed.
          if (!(error instanceof CodexSpeedUnsupportedError)) throw error;
        }
      }
    },
  };
}

let chatSettingsWindow: () => BrowserWindow | null = () => null;

function createInstalledChatSettingsHost(): ReturnType<
  typeof createCoreChatSettingsHost
> {
  return createCoreChatSettingsHost({
    withChatSettingsLock: (target, work) =>
      withModelChangeLock(
        buildSessionKey(target.projectId, target.worktreeId, target.chatId),
        work,
      ),
    readTab: (target) =>
      readCanonicalChatTab(target.projectId, target.worktreeId, target.chatId),
    effects: chatSettingsLiveEffects(),
    changeModel: (change, port) =>
      changeChatModelThroughCore(change, port, chatSettingsWindow),
  });
}

/**
 * Persist a chat's plugin selections and restart or recreate its provider
 * session so the next turn runs with them. Shared by the plugin picker IPC
 * and the deferred-tools reload host (CAN-4127).
 */
export async function applyChatPluginSelectionsUpdate(
  req: ChatUpdatePluginsRequest,
  // Main-only, never from the IPC DTO: the caller already committed these
  // selections through a checked core.chat.update (CAN-5999).
  options: { readonly committed?: true } = {},
): Promise<ChatUpdatePluginsResponse> {
  const { projectId, worktreeId, chatId } = req;
  assertWritableScope(projectId);
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  validateId(chatId, 'chatId');
  const normalizedTombstones =
    req.disabledGlobalPluginSelections !== undefined
      ? normalizePluginSelectionTombstones(req.disabledGlobalPluginSelections)
      : undefined;
  let committedSessionId: string | undefined;
  const deferredReloadActive = deferredToolsReloadCoordinator.hasActiveReload({
    projectId,
    worktreeId,
    chatId,
  });
  const activeInfoAtUpdateStart = getActiveSessionInfos(
    projectId,
    worktreeId,
  ).find((info) => info.chatId === chatId);
  let recreateAfterActiveCodexTurn =
    activeInfoAtUpdateStart?.executionHarness === 'codex' &&
    activeInfoAtUpdateStart.turnActive &&
    !deferredReloadActive;
  recreateAfterActiveCodexTurn =
    recreateAfterActiveCodexTurn ||
    chatHasNativeBackgroundWork(projectId, worktreeId, chatId);
  if (
    activeInfoAtUpdateStart?.executionHarness === 'codex' &&
    (activeInfoAtUpdateStart.pendingMessageCount ?? 0) > 0
  ) {
    throw new Error(
      'Wait for queued Codex messages to finish before updating tools',
    );
  }
  if (req.materializeCodexThread) {
    await withCodexCapabilityTransitionLock(
      `${projectId}/${worktreeId}/${chatId}`,
      async () => {
        const tabsFile = await readChatTabsFile(projectId, worktreeId);
        const tabIndex = tabsFile.tabs.findIndex((tab) => tab.id === chatId);
        const persistedTab = tabsFile.tabs[tabIndex];
        if (!persistedTab) {
          throw new Error('Chat tab was not found while updating tools');
        }
        const activeSession = getSession(projectId, worktreeId, chatId);
        // The owner session receives the provider thread id before the
        // renderer's debounced tab write necessarily reaches disk. Use that
        // owner-bound id as the fallback for both direct saves and deferred
        // reloads so a just-completed Codex turn cannot be mistaken for a
        // concurrent chat replacement.
        const activeProviderThreadId = activeSession?.getProviderSessionId
          ? activeSession.getProviderSessionId()
          : undefined;
        const sourceThreadId =
          persistedTab.sdkSessionId ?? activeProviderThreadId;
        const persistedHarness =
          persistedTab.executionHarness ??
          inferLegacyExecutionHarness({
            model: persistedTab.model,
            providerType: persistedTab.providerType,
            hasStarted:
              (persistedTab.transcript?.messageCount ??
                persistedTab.transcript?.committedMessageCount ??
                persistedTab.messages.length) > 0 || Boolean(sourceThreadId),
          });
        if (
          (req.expectedCurrentThreadId !== undefined &&
            sourceThreadId !== req.expectedCurrentThreadId) ||
          persistedHarness !== 'codex'
        ) {
          throw new Error('Chat changed while tools were being updated');
        }
        const activeInfo = getActiveSessionInfos(projectId, worktreeId).find(
          (info) => info.chatId === chatId,
        );
        const capabilityProfile = getActiveSessionCapabilityProfile(
          projectId,
          worktreeId,
          chatId,
        );
        if ((activeInfo?.pendingMessageCount ?? 0) > 0) {
          throw new Error(
            'Wait for queued Codex messages to finish before updating tools',
          );
        }
        const hasNativeBackgroundWork = chatHasNativeBackgroundWork(
          projectId,
          worktreeId,
          chatId,
        );
        recreateAfterActiveCodexTurn =
          recreateAfterActiveCodexTurn ||
          (Boolean(activeInfo?.turnActive) && !deferredReloadActive) ||
          hasNativeBackgroundWork;
        if (recreateAfterActiveCodexTurn) {
          // Keep the in-flight turn on its original immutable capability
          // snapshot. The renderer persists the new selections immediately;
          // the next send recreates the session and materializes the finished
          // thread history with those selections.
          return;
        }
        if (sourceThreadId) {
          // Mirror `resolveProviderType` in the session manager: the model
          // decides the execution backend whenever it resolves in the
          // catalog, and the persisted `providerType` is only the fallback
          // for a model the catalog does not know (an Ollama model whose
          // server has not been detected this launch). Trusting the persisted
          // field outright is a second source of truth: on drift the
          // transition would resolve the `native` family and skip the Ollama
          // loopback config while still handing a raw `ollama-*` model id to
          // a canonical Codex app-server.
          const persistedModelSource = persistedTab.model
            ? getModelSource(persistedTab.model)
            : undefined;
          const transitionProviderType: CodexReasoningProviderType | undefined =
            persistedModelSource === 'ollama' ||
            (persistedModelSource === undefined &&
              persistedTab.providerType === 'ollama')
              ? 'ollama'
              : undefined;
          const preferences = await readPreferencesFile().catch(() => null);
          const approvalMode = await resolvePersistedApprovalMode(
            projectId,
            worktreeId,
            persistedTab.approvalMode,
          );
          const routedState = getSessionAiCreditsRoutedState(
            projectId,
            worktreeId,
            chatId,
          );
          const transition = await materializeCodexCapabilityTransition({
            projectId,
            worktreeId,
            chatId,
            sourceThreadId,
            pluginSelections: req.pluginSelections,
            approvalMode,
            ...(req.disabledGlobalPluginSelections !== undefined
              ? {
                  disabledGlobalPluginSelections:
                    req.disabledGlobalPluginSelections,
                }
              : {}),
            ...(req.selectedRepoId
              ? { selectedRepoId: req.selectedRepoId }
              : persistedTab.selectedRepoId
                ? { selectedRepoId: persistedTab.selectedRepoId }
                : {}),
            ...(persistedTab.model ? { model: persistedTab.model } : {}),
            // Ollama threads are their own reasoning route family; without
            // this they would resolve to `native` and could resume under a
            // native OpenAI model, replaying provider-private reasoning.
            ...(transitionProviderType
              ? { providerType: transitionProviderType }
              : {}),
            // Tri-state: forward the routing decision only when a live
            // session actually reports one. Sending `false` for an idle chat
            // would tell the transition that a gateway-routed chat is
            // native, stripping its cached reasoning and mis-stamping the
            // replacement lease.
            ...(routedState !== undefined
              ? { aiCreditsRouted: routedState }
              : {}),
            maxConcurrentSubagents: preferences?.codexMaxConcurrentSubagents,
            multiAgentEnabled:
              preferences?.codexMultiAgentStandaloneChatsEnabled,
            localMemoryEnabled: preferences?.localMemoryEnabled === true,
            ...(capabilityProfile
              ? {
                  assistantMode: capabilityProfile.assistantMode,
                  codeGraphToolsAdvertised:
                    capabilityProfile.codeGraphToolsAdvertised,
                  interfaceTools: capabilityProfile.interfaceTools,
                }
              : {}),
          });
          try {
            const nextSessionId = transition.handle.threadId;
            const latestActiveInfoBeforeCommit = getActiveSessionInfos(
              projectId,
              worktreeId,
            ).find((info) => info.chatId === chatId);
            if ((latestActiveInfoBeforeCommit?.pendingMessageCount ?? 0) > 0) {
              throw new Error(
                'Wait for queued Codex messages to finish before updating tools',
              );
            }
            // Materialization awaits provider work while chat events can
            // advance the repository revision. Commit only the intended
            // fields against the latest tab; a stale full snapshot would
            // silently lose this metadata update during reconciliation.
            const { updated } =
              await getChatStateService().updateCompatibilityTab(
                { projectId, worktreeId },
                chatId,
                (currentTab) => {
                  if (
                    (currentTab.sdkSessionId !== persistedTab.sdkSessionId &&
                      currentTab.sdkSessionId !== sourceThreadId) ||
                    currentTab.model !== persistedTab.model ||
                    currentTab.providerType !== persistedTab.providerType
                  ) {
                    throw new Error(
                      'Chat changed while tools were being updated',
                    );
                  }
                  const nextTab: PersistedChatTab = {
                    ...currentTab,
                    sdkSessionId: nextSessionId,
                    pluginSelections: req.pluginSelections,
                    ...(typeof req.deferredToolsAllowed === 'boolean'
                      ? { deferredToolsAllowed: req.deferredToolsAllowed }
                      : {}),
                  };
                  if (req.disabledGlobalPluginSelections !== undefined) {
                    if (normalizedTombstones) {
                      nextTab.disabledGlobalPluginSelections =
                        normalizedTombstones;
                    } else {
                      delete nextTab.disabledGlobalPluginSelections;
                    }
                  }
                  return nextTab;
                },
                undefined,
                { metadataOnly: true },
              );
            if (!updated) {
              throw new Error(
                'Chat tab was removed while tools were being updated',
              );
            }
            committedSessionId = nextSessionId;
            await transition.handle.unsubscribe();
          } catch (error) {
            await transition.handle.delete().catch(() => {});
            throw error;
          } finally {
            await transition.releaseRoutes();
          }
        }
      },
    );
  }
  if (!committedSessionId) {
    const latestActiveInfoBeforeRuntimeUpdate = getActiveSessionInfos(
      projectId,
      worktreeId,
    ).find((info) => info.chatId === chatId);
    if (
      latestActiveInfoBeforeRuntimeUpdate?.executionHarness === 'codex' &&
      (latestActiveInfoBeforeRuntimeUpdate.pendingMessageCount ?? 0) > 0
    ) {
      throw new Error(
        'Wait for queued Codex messages to finish before updating tools',
      );
    }
  }
  if (committedSessionId === undefined) {
    await withCodexCapabilityTransitionLock(
      `${projectId}/${worktreeId}/${chatId}`,
      async () => {
        const canonicalTabs = await getChatStateService().getCompatibilityTabs({
          projectId,
          worktreeId,
        });
        const canonicalTab = canonicalTabs.tabs.find(
          (tab) => tab.id === chatId,
        );
        if (
          !canonicalTab &&
          !hasQueuedHookChat({ projectId, worktreeId, chatId })
        ) {
          throw new Error('Chat tab was not found while updating tools');
        }
        if (!canonicalTab) {
          return;
        }
        const activeSession = getSession(projectId, worktreeId, chatId);
        const currentThreadId =
          activeSession?.getProviderSessionId?.() ?? canonicalTab.sdkSessionId;
        if (
          req.expectedCurrentThreadId !== undefined &&
          currentThreadId !== req.expectedCurrentThreadId
        ) {
          throw new Error('Chat changed while tools were being updated');
        }
        // Deferred reload can arrive before the renderer observes the
        // provider's init event. Capture continuity before teardown clears
        // the old session, so the resume cannot silently start fresh.
        if (deferredReloadActive && currentThreadId) {
          committedSessionId = currentThreadId;
        }
        if (options.committed) {
          // Never write again: a selection edited since the commit stays,
          // and these older ones do not reach the live session.
          if (
            !committedSelectionsStillStored(
              canonicalTab.pluginSelections,
              req.pluginSelections,
            )
          )
            throw new Error(
              'Chat plugins changed while tools were being updated',
            );
          return;
        }
        await commitCanonicalTabSettings(
          projectId,
          worktreeId,
          chatId,
          {
            pluginSelections: req.pluginSelections,
            ...(typeof req.deferredToolsAllowed === 'boolean'
              ? { deferredToolsAllowed: req.deferredToolsAllowed }
              : {}),
            ...(req.disabledGlobalPluginSelections !== undefined
              ? {
                  disabledGlobalPluginSelections: normalizedTombstones ?? {},
                }
              : {}),
          },
          {
            requireExisting: true,
          },
        );
      },
    );
  }
  getChatQueueService().updateQueuedPluginSelections(
    { projectId, worktreeId, chatId },
    req.pluginSelections,
    req.deferredToolsAllowed,
  );
  updateQueuedHookChatPluginSelections({
    projectId,
    worktreeId,
    chatId,
    pluginSelections: req.pluginSelections,
    deferredToolsAllowed: req.deferredToolsAllowed,
  });
  getClaudeTerminalSessionService().updateDeferredToolsContext(
    projectId,
    worktreeId,
    chatId,
    {
      pluginSelections: req.pluginSelections,
      deferredToolsAllowed: req.deferredToolsAllowed,
    },
  );
  const terminalState = getClaudeTerminalSessionService().getState(
    projectId,
    worktreeId,
    chatId,
  );
  if (terminalState?.sessionKey) {
    getDesktopIntegrationServer().updateCanopyWorktreeSessionPluginSelections(
      terminalState.sessionKey,
      req.pluginSelections,
    );
  }
  if (typeof req.deferredToolsAllowed === 'boolean') {
    if (terminalState?.sessionKey) {
      getDesktopIntegrationServer().updateCanopyWorktreeSessionDeferredToolsAllowed(
        terminalState.sessionKey,
        req.deferredToolsAllowed,
      );
    }
  }
  const session = getSession(projectId, worktreeId, chatId);
  if (session) {
    const latestActiveInfo = getActiveSessionInfos(projectId, worktreeId).find(
      (info) => info.chatId === chatId,
    );
    const hasNativeBackgroundWork = chatHasNativeBackgroundWork(
      projectId,
      worktreeId,
      chatId,
    );
    recreateAfterActiveCodexTurn =
      recreateAfterActiveCodexTurn ||
      (latestActiveInfo?.executionHarness === 'codex' &&
        latestActiveInfo.turnActive &&
        !deferredReloadActive) ||
      hasNativeBackgroundWork;
    if (recreateAfterActiveCodexTurn) {
      markSessionForNextTurnRecreation(
        projectId,
        worktreeId,
        chatId,
        'plugins',
      );
    } else {
      // Destroy the idle session so the next sendMessage creates a new one
      // with the updated plugin selections. Claude resumes via sdkSessionId.
      // Direct Codex saves already committed a start/inject replacement;
      // deferred Codex reloads reconstruct on the next send.
      await destroySession(projectId, worktreeId, chatId, {
        suppressObservabilityInterrupt: deferredReloadActive,
        retainDelegations: true,
      });
    }
  }
  getChatQueueService().refreshRestartHold({ projectId, worktreeId, chatId });

  // The desired plugin snapshot was persisted above under the transition
  // lock; the renderer still mirrors the response into its local tab state.
  return {
    pluginSelections: req.pluginSelections,
    // Echo the normalized replacement (empty object = cleared) — the
    // renderer stores and later re-persists this value, so it must match
    // what was actually written, not the raw request payload.
    ...(req.disabledGlobalPluginSelections !== undefined
      ? {
          disabledGlobalPluginSelections: normalizedTombstones ?? {},
        }
      : {}),
    ...(typeof req.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: req.deferredToolsAllowed }
      : {}),
    ...(committedSessionId ? { sdkSessionId: committedSessionId } : {}),
  };
}

/**
 * Commit the durable half of an approval-mode transition. The approval-mode
 * setter orders it against the live runtimes; nothing else writes the mode.
 * `not_found` is tolerated for the same reasons as a settings patch.
 */
async function commitCanonicalApprovalMode(
  projectId: string,
  worktreeId: string,
  chatId: string,
  approvalMode: ApprovalMode,
): Promise<void> {
  const result = await dispatchCanonicalChatCommand({
    schemaVersion: 1,
    commandId: `approval-mode-${randomUUID()}`,
    projectId,
    worktreeId,
    command: { type: 'chat.set_approval_mode', tabId: chatId, approvalMode },
  });
  if (
    result.outcome !== 'applied' &&
    result.outcome !== 'already_applied' &&
    result.outcome !== 'not_found'
  ) {
    throw new Error(
      `Canonical approval mode change was ${result.outcome}: ${result.reason ?? 'unknown reason'}`,
    );
  }
}

interface CoreModelChangeCommit {
  commandId: string;
  commit: (request: ChatCommandRequest) => Promise<ChatCommandResult>;
  expectedRevision?: number;
  expectedTabRevision?: number;
  origin?: 'desktop' | 'portal';
  onCommitted: (result: ChatCommandResult) => void;
}

async function commitCanonicalModelChange(
  projectId: string,
  worktreeId: string,
  chatId: string,
  model: ChatModel,
  settings?: NormalizedModelSettings,
  notice?: ModelChangeRequest['notice'],
  executionHarness?: ModelChangeRequest['executionHarness'],
  providerType = requireProviderForModel(model),
  preserveModelSelectionMode = false,
  autoRoutedMessageId?: string,
  core?: CoreModelChangeCommit,
): Promise<ChatCommandResult> {
  const request: ChatCommandRequest = {
    schemaVersion: 1,
    commandId: core?.commandId ?? `model-${randomUUID()}`,
    projectId,
    worktreeId,
    ...(core?.expectedRevision === undefined
      ? {}
      : { expectedRevision: core.expectedRevision }),
    ...(core?.expectedTabRevision === undefined
      ? {}
      : { expectedTabRevision: core.expectedTabRevision }),
    ...(core?.origin === undefined ? {} : { origin: core.origin }),
    command: {
      type: 'chat.set_model',
      tabId: chatId,
      model,
      executionHarness,
      providerType,
      settings,
      notice,
      ...(preserveModelSelectionMode
        ? { preserveModelSelectionMode: true as const }
        : {}),
      ...(autoRoutedMessageId ? { autoRoutedMessageId } : {}),
    },
  };
  if (core) {
    const result = await core.commit(request);
    core.onCommitted(result);
    return result;
  }
  const result = await dispatchCanonicalChatCommand(request);
  if (
    result.outcome !== 'applied' &&
    result.outcome !== 'already_applied' &&
    result.outcome !== 'not_found'
  ) {
    throw new Error(
      `Canonical model change was ${result.outcome}: ${result.reason ?? 'unknown reason'}`,
    );
  }
  return result;
}

async function readCanonicalChatTab(
  projectId: string,
  worktreeId: string,
  chatId: string,
  includeTranscript = false,
): Promise<PersistedChatTab | undefined> {
  try {
    const tabs = await getChatStateService().getCompatibilityTabs(
      { projectId, worktreeId },
      includeTranscript
        ? { chatIds: [chatId], fullTranscript: true }
        : undefined,
    );
    return tabs.tabs.find((tab) => tab.id === chatId);
  } catch {
    return undefined;
  }
}

async function normalizeCanonicalModelSelection(
  req: ModelChangeRequest,
  previousTab: PersistedChatTab,
  model: ChatModel,
  options: { interfaceModeOverride?: ChatInterfaceMode | null } = {},
): Promise<NormalizedModelSettings> {
  const selectedHarness = resolveChatModelChangeHarness(
    previousTab,
    model,
    req.executionHarness,
  );
  const providerType =
    getProviderForChatModel(model, selectedHarness) ??
    requireProviderForModel(model);
  const previousProviderType =
    previousTab.providerType ??
    (previousTab.model ? getProviderForModel(previousTab.model) : undefined);
  const providerChanged = previousProviderType !== providerType;
  const executionHarness =
    resolveChatModelChangeHarness(previousTab, model, req.executionHarness) ??
    getExecutionHarnessForModel(model) ??
    providerType;
  const preferences = await readPreferencesFile().catch(() => null);
  const providerDefaults =
    req.projectId === APP_ADVISOR_PROJECT_ID || isCoworkWorkspace(req.projectId)
      ? preferences?.defaultChatModelByProvider[providerType]
      : preferences?.defaultWorktreeModelByProvider[providerType];
  const thinkingLevel = normalizeThinkingForProvider(
    (providerChanged ? providerDefaults?.thinkingLevel : undefined) ??
      previousTab.modelConfig?.thinkingLevel ??
      previousTab.thinkingLevel ??
      'high',
    providerType,
  );
  // A provider change drops the previous provider's config. The shared
  // resolver then reads the tab's retained Codex speed (kept while the chat
  // ran another provider) before the new provider's default record.
  const modelConfig = resolveProviderModelConfig(
    executionHarness,
    {
      thinkingLevel,
      modelConfig: {
        ...(providerChanged ? {} : previousTab.modelConfig),
        thinkingLevel,
        ...(providerChanged && isCodexSpeed(previousTab.retainedCodexSpeed)
          ? { speed: previousTab.retainedCodexSpeed }
          : {}),
      },
      codexFastModeEnabled: providerChanged
        ? undefined
        : previousTab.codexFastModeEnabled,
    },
    preferences?.providerModelConfigDefaults,
  );

  let interfaceMode =
    options.interfaceModeOverride !== undefined
      ? options.interfaceModeOverride
      : (previousTab.interfaceMode ?? null);
  if (options.interfaceModeOverride === undefined) {
    if (providerType !== 'claude' || executionHarness !== 'claude') {
      interfaceMode = null;
    } else if (
      providerChanged &&
      (previousTab.transcript?.messageCount ??
        previousTab.transcript?.committedMessageCount ??
        previousTab.messages.length) === 0 &&
      preferences
    ) {
      const effectivePreferences =
        getEffectiveClaudeChatModePreferences(preferences);
      const defaultInterfaceMode =
        req.projectId === APP_ADVISOR_PROJECT_ID
          ? effectivePreferences.defaultAppAdvisorInterfaceMode
          : isCoworkWorkspace(req.projectId)
            ? effectivePreferences.defaultStandaloneChatInterfaceMode
            : effectivePreferences.defaultChatInterfaceMode;
      interfaceMode =
        getPersistedClaudeChatInterfaceMode(defaultInterfaceMode) ?? null;
    }
  }

  return {
    thinkingLevel: modelConfig.thinkingLevel,
    modelConfig,
    codexFastModeEnabled: modelConfig.fastMode,
    interfaceMode,
  };
}

/**
 * Pin an Agent that inherits the default model to the destination's current
 * default, so the chat keeps that route after Settings change. Undefined when
 * the destination has no usable default, or for a route the chat cannot take.
 */
async function materializeInheritingAgentModel(
  model: string,
  projectId: string,
  currentModel: () => Promise<string | undefined> = () =>
    Promise.resolve(undefined),
): Promise<string | undefined> {
  const route = parseAgentRouteModelId(model);
  if (route) {
    // A pinned Agent keeps its own base; only a chat already on the route may
    // keep it after its Agent stops inheriting.
    return (isInheritingAgentModel(route.agentId) &&
      isBaseModelSelectableForAgent(route.baseModel)) ||
      (await currentModel()) === model
      ? model
      : undefined;
  }
  if (!isInheritingAgentModel(model)) return model;
  try {
    return formatInheritedAgentRoute(
      model,
      await resolveAgentDestinationDefaultModel(projectId),
    );
  } catch {
    return undefined;
  }
}

/**
 * Settle a desktop send's model before it is queued: the request's model, else
 * the chat's stored one. A bare Agent on the default model is pinned on the
 * chat under the model-change lock, so a concurrent model change cannot mix
 * its provider into this turn and later turns keep the route.
 */
async function prepareSendModel(
  req: ChatSendMessageRequest,
  getWindow: () => BrowserWindow | null,
): Promise<ChatSendMessageRequest> {
  if (req.modelSelectionMode === 'auto') return req;
  return withModelChangeLock(
    buildSessionKey(req.projectId, req.worktreeId, req.chatId),
    async () => {
      const tab = await readCanonicalChatTab(
        req.projectId,
        req.worktreeId,
        req.chatId,
      );
      const model = await resolveSendModelPin(
        req.projectId,
        tab?.model,
        req.model,
      );
      if (model === undefined) return req;
      // A chat with no tab yet (a browser-minted Portal chat) is created on
      // this route when its turn dispatches.
      if (!tab) {
        return {
          ...req,
          model,
          providerType: getProviderForModel(model) ?? req.providerType,
          executionHarness: getExecutionHarnessForModel(model),
        };
      }
      if (tab.model !== model) {
        assertWritableScope(req.projectId);
        const changed = await changeChatModelLocked(
          {
            projectId: req.projectId,
            worktreeId: req.worktreeId,
            chatId: req.chatId,
            model,
          },
          getWindow,
          {},
        );
        if (!changed) {
          throw new Error(
            `Couldn't start ${getModelDisplayName(model)}. Choose a model and send again.`,
          );
        }
      }
      const pinned = await readCanonicalChatTab(
        req.projectId,
        req.worktreeId,
        req.chatId,
      );
      return {
        ...req,
        model,
        providerType:
          pinned?.providerType ??
          getProviderForModel(model) ??
          req.providerType,
        executionHarness:
          pinned?.executionHarness ?? getExecutionHarnessForModel(model),
      };
    },
  );
}

/**
 * Apply the canonical model-change path used by both the desktop picker and
 * remote App Advisor. Keeping the policy, harness lock, active-session update,
 * and durable tab mutation behind one function prevents the portal from
 * acknowledging a selection the desktop would have refused.
 */
export async function changeChatModel(
  req: ModelChangeRequest,
  getWindow: () => BrowserWindow | null = () => null,
  options: {
    interfaceModeOverride?: ChatInterfaceMode | null;
    preserveModelSelectionMode?: boolean;
    /** Main-only: stamp this user message with the model Auto picked. */
    autoRoutedMessageId?: string;
    core?: CoreModelChangeCommit;
  } = {},
): Promise<boolean> {
  assertWritableScope(req.projectId);
  return withModelChangeLock(
    buildSessionKey(req.projectId, req.worktreeId, req.chatId),
    () => changeChatModelLocked(req, getWindow, options),
  );
}

/** `core.chat.update`'s model route (CAN-4110 D5): the picker's checks and effects under the caller's command id. */
export async function changeChatModelThroughCore(
  change: CoreChatModelChange,
  port: ChatStateCommandPort,
  getWindow: () => BrowserWindow | null,
): Promise<ChatCommandResult> {
  const { projectId, worktreeId, chatId } = change.target;
  let committed: ChatCommandResult | undefined;
  await changeChatModel(
    {
      projectId,
      worktreeId,
      chatId,
      model: change.model,
      ...(change.executionHarness === undefined
        ? {}
        : { executionHarness: change.executionHarness }),
      ...(change.notice === undefined ? {} : { notice: change.notice }),
    },
    getWindow,
    {
      core: {
        commandId: change.commandId,
        commit: (request) => port.command(request),
        ...(change.expectedRevision === undefined
          ? {}
          : { expectedRevision: change.expectedRevision }),
        ...(change.expectedTabRevision === undefined
          ? {}
          : { expectedTabRevision: change.expectedTabRevision }),
        ...(change.origin === undefined ? {} : { origin: change.origin }),
        onCommitted: (result) => {
          committed = result;
        },
      },
    },
  );
  if (committed) return committed;
  return {
    commandId: change.commandId,
    revision: (await port.getState({ projectId, worktreeId })).revision,
    outcome: 'rejected',
    reason: 'The model is not available for this chat.',
  };
}

function chatTabHasStarted(tab: PersistedChatTab): boolean {
  return (
    (tab.transcript?.messageCount ??
      tab.transcript?.committedMessageCount ??
      tab.messages.length) > 0
  );
}

async function changeChatModelLocked(
  req: ModelChangeRequest,
  getWindow: () => BrowserWindow | null,
  options: {
    interfaceModeOverride?: ChatInterfaceMode | null;
    preserveModelSelectionMode?: boolean;
    autoRoutedMessageId?: string;
    core?: CoreModelChangeCommit;
  },
): Promise<boolean> {
  const requestedModel = await materializeInheritingAgentModel(
    req.model,
    req.projectId,
    async () =>
      (await readCanonicalChatTab(req.projectId, req.worktreeId, req.chatId))
        ?.model,
  );
  const model = requestedModel ? resolveKnownModel(requestedModel) : undefined;
  if (!model) {
    return false;
  }
  const previousTab = await readCanonicalChatTab(
    req.projectId,
    req.worktreeId,
    req.chatId,
  );
  const selectedHarness = resolveChatModelChangeHarness(
    previousTab,
    model,
    req.executionHarness,
  );
  if (!selectedHarness || !supportsChatHarnessChoice(model, selectedHarness))
    return false;
  const lockedHarness =
    req.lockedHarness ??
    (options.core && previousTab && chatTabHasStarted(previousTab)
      ? (previousTab.executionHarness ??
        inferLegacyExecutionHarness({
          model: previousTab.model,
          providerType: previousTab.providerType,
          hasStarted: true,
        }))
      : undefined);
  if (
    ((selectedHarness === 'copilot' || selectedHarness === 'opencode') &&
      (req.projectId === PIPELINE_EDITOR_PROJECT_ID ||
        req.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
        req.projectId === CODE_REVIEW_CHAT_PROJECT_ID)) ||
    (selectedHarness === 'cursor' &&
      req.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID)
  )
    return false;
  if (selectedHarness === 'cursor' && !(await isCursorRuntimeAvailable())) {
    return false;
  }
  if (
    selectedHarness === 'cursor' &&
    (req.projectId === PIPELINE_EDITOR_PROJECT_ID ||
      req.projectId === CODE_REVIEW_CHAT_PROJECT_ID)
  ) {
    const { readCursorAccount } = await import('../cursor/connection');
    try {
      if (!(await readCursorAccount(AbortSignal.timeout(20_000)))) return false;
    } catch {
      return false;
    }
  }
  if (selectedHarness === 'copilot' && !(await isCopilotRuntimeAvailable()))
    return false;
  if (selectedHarness === 'opencode') {
    await assertOpenCodeSelectionAvailable({
      model,
      session: {
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        chatId: req.chatId,
      },
    });
  }
  const workOwner = await resolveAiCreditsScopeOwner({
    kind: 'work',
    projectId: req.projectId,
    worktreeId: req.worktreeId,
    chatId: req.chatId,
  });
  if (await isModelBlockedByStoredPolicy(model, workOwner)) {
    // `chatModelChange` resolves to a bare boolean, so a policy denial is
    // indistinguishable on the wire from "unknown model" or "provider
    // change not allowed" below. Record the same `model_policy_refused`
    // session diagnostic the session gate and the pipeline runtime emit.
    getExecutionObservabilityIngest().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'model_policy_refused',
      sessionKey: buildSessionKey(req.projectId, req.worktreeId, req.chatId),
      projectId: req.projectId,
      worktreeId: req.worktreeId,
      chatId: req.chatId,
      providerType: requireProviderForModel(model),
      model,
    });
    return false;
  }
  const gatewayCheck = await checkModelGatewayRoute(model, workOwner);
  if (!gatewayCheck.ok) {
    return false;
  }
  if (
    !isProviderChangeAllowed(
      req.projectId,
      req.worktreeId,
      req.chatId,
      model,
      lockedHarness,
      selectedHarness,
    )
  ) {
    return false;
  }
  const selectedProviderType =
    getProviderForChatModel(model, selectedHarness) ??
    requireProviderForModel(model);
  const settings = previousTab
    ? await normalizeCanonicalModelSelection(req, previousTab, model, options)
    : undefined;
  const committed = await commitCanonicalModelChange(
    req.projectId,
    req.worktreeId,
    req.chatId,
    model,
    settings,
    req.notice,
    req.executionHarness,
    selectedProviderType,
    options.preserveModelSelectionMode === true,
    options.autoRoutedMessageId,
    options.core,
  );
  if (options.core) {
    if (committed.outcome === 'conflict' || committed.outcome === 'rejected')
      return false;
    if (
      committed.outcome === 'already_applied' &&
      isModelChangeSuperseded(
        await readCanonicalChatTab(req.projectId, req.worktreeId, req.chatId),
        model,
      )
    )
      return true;
  }
  await updateQueuedHookChatModel({
    projectId: req.projectId,
    worktreeId: req.worktreeId,
    chatId: req.chatId,
    model,
  });
  const session = getSession(req.projectId, req.worktreeId, req.chatId);
  if (
    session &&
    !sessionHasActiveTurnOrNativeWork(req.projectId, req.worktreeId, req.chatId)
  ) {
    const currentSelectedModel = getSessionSelectedModel(
      req.projectId,
      req.worktreeId,
      req.chatId,
    );
    const activeProvider = getSessionProviderType(
      req.projectId,
      req.worktreeId,
      req.chatId,
    );
    if (
      isAgentModel(model) ||
      isAgentModel(currentSelectedModel) ||
      (activeProvider !== undefined && activeProvider !== selectedProviderType)
    ) {
      // A model or provider switch recycles the session, not the chat.
      await destroySession(req.projectId, req.worktreeId, req.chatId, {
        retainDelegations: true,
      });
    } else {
      await session.setModel(model);
      updateSessionModel(
        buildSessionKey(req.projectId, req.worktreeId, req.chatId),
        model,
      );
      updateSessionTurnSettingsModel(
        req.projectId,
        req.worktreeId,
        req.chatId,
        model,
      );
    }
  }
  getChatQueueService().refreshRestartHold({
    projectId: req.projectId,
    worktreeId: req.worktreeId,
    chatId: req.chatId,
  });

  const standaloneChatProjectId = resolveStandaloneChatProjectId(
    req.projectId,
    req.worktreeId,
  );
  if (standaloneChatProjectId) {
    sendToWindow(getWindow(), IPC_CHANNELS.standaloneChatMetaUpdated, {
      projectId: standaloneChatProjectId,
      chatId: req.chatId,
      providerType: selectedProviderType,
    });
  }
  return true;
}

type ChatSendMessageHandler = (
  event: IpcMainInvokeEvent | undefined,
  request: ChatSendMessageRequest,
  /** Host-only queue capability; IPC never supplies it. */
  authorization?: AuthorizedChatDispatch,
) => Promise<ChatSendMessageResult>;

const autoRoutingNotices = new Map<string, string>();

function autoRoutingKey(request: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return `${request.projectId}\u0000${request.worktreeId}\u0000${request.chatId}`;
}

function autoRoutingTurnKey(
  request: Pick<
    ChatSendMessageRequest,
    'projectId' | 'worktreeId' | 'chatId' | 'userMessageId'
  >,
): string {
  return `${autoRoutingKey(request)}\u0000${request.userMessageId}`;
}

function withChatScopeActivity(
  handler: ChatSendMessageHandler,
  options: { allowMainOwnedAgentInput?: boolean } = {},
): ChatSendMessageHandler {
  // `runWithScopeActivity` is generic and returns the operation's own value, so
  // the send handler's typed auth refusal (CAN-1814 PR 7) survives the scope
  // lease. Typing this `Promise<void>` would swallow it and the reconnect card
  // would never render.
  return async (
    event,
    request,
    authorization,
  ): Promise<ChatSendMessageResult> => {
    if (options.allowMainOwnedAgentInput !== true) {
      assertUntrustedChatInput(request);
    }
    assertWritableScope(request.projectId);
    // A legacy plan chat is refused before its scope is opened, so a crafted
    // send neither migrates nor touches its stored transcript.
    assertChatScopeAcceptsTurns(request.projectId);
    await assertCoworkChatRootPresent(request.projectId, request.worktreeId);
    return getChatStateService().runWithScopeActivity(
      {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
      },
      () => handler(event, request, authorization),
    );
  };
}

interface ApprovalDefaultIntent {
  generation: number;
  surfaceKey: keyof ApprovalDefaults;
}

function beginApprovalDefaultIntentForRequest(req: {
  projectId: string;
  worktreeId: string;
}): ApprovalDefaultIntent | undefined {
  if (isEphemeralApprovalSurface(req.projectId)) {
    // Code-review and plan-explore chats resolve to their owning worktree, so
    // a write-back here would repoint the default for every worktree chat from
    // inside a throwaway side chat. Read the default there; never write it.
    return undefined;
  }
  const resolvedProjectId = resolveApprovalProjectId(
    req.projectId,
    req.worktreeId,
  );
  if (!resolvedProjectId) {
    // Unresolvable sentinel: do not guess which surface to rewrite.
    return undefined;
  }
  const surfaceKey = defaultsKeyForSurface(surfaceForChat(resolvedProjectId));
  return {
    generation: beginApprovalDefaultIntent(surfaceKey),
    surfaceKey,
  };
}

/**
 * Remembers an in-chat approval-mode change as the default for that surface's
 * future chats (CAN-3055). Called only after the per-chat change has fully
 * committed, so a rolled-back escalation never updates the default.
 *
 * Symmetric by design: de-escalating one chat to Ask makes Ask the surface
 * default exactly as escalating to Full Access does.
 *
 * Best effort. A preference write failure is logged and swallowed; it must
 * never fail the per-chat mode change the user actually asked for.
 */
async function rememberApprovalDefaultForSurface(
  req: {
    projectId: string;
    worktreeId: string;
    mode: ApprovalMode;
  },
  intent: ApprovalDefaultIntent | undefined,
): Promise<void> {
  if (!intent) {
    return;
  }
  commitApprovalDefaultIntent(intent.surfaceKey, intent.generation);
  if (!isApprovalDefaultIntentCurrent(intent.surfaceKey, intent.generation)) {
    return;
  }
  const { surfaceKey } = intent;
  const endPendingWrite = beginPendingApprovalDefaultWrite(surfaceKey);
  let didChangeDefault = false;
  try {
    // Make every decision only from the state `updatePreferencesFile` re-reads
    // inside its serialized queue.
    //
    // A pre-queue equality check can drop a later in-chat choice when an older
    // same-surface Settings write is already queued. Likewise, a pre-queue
    // degraded-read check leaves a gap where the authoritative re-read can
    // fail. Returning null explicitly skips the write after inspecting that
    // queue-fresh state.
    const normalized = await updatePreferencesFile((current) => {
      if (
        !isApprovalDefaultIntentCurrent(surfaceKey, intent.generation) ||
        peekPreferencesLoadError() !== null ||
        current.approvalDefaults[surfaceKey] === req.mode
      ) {
        return null;
      }
      const nextDefaults = {
        ...current.approvalDefaults,
        [surfaceKey]: req.mode,
      };
      didChangeDefault = true;
      return { approvalDefaults: nextDefaults };
    });
    if (!didChangeDefault) {
      return;
    }
    broadcastPreferencesSynced(normalized, projectPreferencesForRuntime);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to persist the remembered approval default:', error);
  } finally {
    endPendingWrite();
  }
}

/** Runtime statuses whose active turn Stop can end. */
const ACTIVE_TURN_STATUSES: ReadonlySet<string> = new Set([
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);

/**
 * The user's Stop: settles the chat's turn and broadcasts the cancellation.
 * With `expectedUserMessageId`, stops only while that is the active turn and
 * answers null otherwise (`core.chat.turn.cancel`, CAN-5485).
 */
export async function stopChatForUser(
  req: ChatCancelRequest,
  getWindow: () => BrowserWindow | null,
  expectedUserMessageId?: string,
): Promise<ChatCancelResult | null> {
  assertWritableScope(req.projectId);
  const stateBeforeCancel = await getChatStateService()
    .getState({ projectId: req.projectId, worktreeId: req.worktreeId })
    .catch(() => null);
  const runtimeBeforeCancel = stateBeforeCancel?.runtimeByChatId[req.chatId];
  // The snapshot above is already stale: check the turn the Stop captures
  // now, and stop with that capture, so a newer turn is never stopped.
  let captured: ChatTurnStopContext | undefined;
  if (expectedUserMessageId !== undefined) {
    const stop = captureChatTurnStopWithTurn(req);
    if (stop.userMessageId !== expectedUserMessageId) return null;
    captured = stop.context;
  }
  const tabBeforeCancel = stateBeforeCancel?.tabsFile.tabs.find(
    (tab) => tab.id === req.chatId,
  );
  // Cowork and managed Claude terminal turns have separate event-routing
  // lifecycles and cannot use the native worktree resume coordinator.
  const resumableUserMessageId =
    runtimeBeforeCancel?.activeTurn?.userMessageId &&
    (expectedUserMessageId === undefined ||
      runtimeBeforeCancel.activeTurn.userMessageId === expectedUserMessageId) &&
    ACTIVE_TURN_STATUSES.has(runtimeBeforeCancel.status) &&
    runtimeBeforeCancel.queuedMessageIds.length === 0 &&
    Boolean(tabBeforeCancel?.sdkSessionId) &&
    !isCoworkWorkspace(req.projectId) &&
    !isTerminalBackedInterfaceMode(tabBeforeCancel?.interfaceMode) &&
    req.projectId !== APP_ADVISOR_PROJECT_ID &&
    req.projectId !== PIPELINE_EDITOR_PROJECT_ID
      ? runtimeBeforeCancel.activeTurn.userMessageId
      : undefined;
  const resumeService = getStoppedTurnResumeService();
  const pendingResumeOffer = resumableUserMessageId
    ? resumeService.beginOffer(req, resumableUserMessageId)
    : undefined;
  if (!pendingResumeOffer) resumeService.invalidate(req);
  const cancelledData = await stopChatTurn(req, captured);
  sendChatEvent(
    getWindow(),
    req.projectId,
    req.worktreeId,
    req.chatId,
    cancelledData,
  );
  if (
    resumableUserMessageId &&
    pendingResumeOffer &&
    resumeService.completeOffer(req, pendingResumeOffer)
  ) {
    return {
      resumableTurn: { userMessageId: resumableUserMessageId },
    };
  }
  return {};
}

/** Main's auto-archiver acts as its own principal with the chat write grant (CAN-6014). */
const AUTO_ARCHIVE_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-main-auto-archive',
  clientInstanceId: 'desktop-main-chat',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: ['core.chat.write'],
};

function installDesktopChatAutoArchiver(
  runtime: DesktopCanopyRuntimeAccessors | undefined,
): void {
  const chatState = getChatStateService();
  installChatAutoArchiver({
    onTurnStateCommitted: (listener) =>
      chatState.onTurnStateCommitted(listener),
    onUnblocked: (listener) =>
      onCommittedArchiveUnblocks(
        (changed) => chatState.subscribe(changed),
        listener,
      ),
    readSnapshot: (scope) => chatState.getCommittedWatcherSnapshot(scope),
    closeBlocked: (target) =>
      chatCloseBlockReason(
        target.projectId,
        target.worktreeId,
        target.chatId,
      ) !== null,
    locked: (target) => {
      const resolved = resolveWorktreeTargetIds(
        target.projectId,
        target.worktreeId,
      );
      return resolved
        ? isSplitLocked(resolved.projectId, resolved.worktreeId)
        : false;
    },
    dispatchInFlight: (target) => chatState.isDispatchInFlight(target),
    dispatch: (request) =>
      runtime
        ? dispatchTrustedChatCommand(
            request,
            createChatCommandDispatchOptions(
              chatState,
              runtime.dispatcher,
              AUTO_ARCHIVE_CALLER,
            ),
          )
        : chatState.command(request),
    warn: (message, details) => {
      logMainProcessWarn(`[auto-archive] ${message}`, details);
    },
  });
}

export function registerChatHandlers(
  accessors: WindowAccessors,
  runtime?: DesktopCanopyRuntimeAccessors,
): void {
  chatCommandRuntime = runtime;
  installDesktopChatAutoArchiver(runtime);
  const getWindow = accessors.getMainWindow;
  chatSettingsWindow = getWindow;
  setCoreChatSettingsHost(createInstalledChatSettingsHost());
  setWorktreeChatWindowAccessor(getWindow);
  deferredToolsReloadCoordinator.subscribe((event) => {
    holdDispatchForDeferredReload(getChatQueueService(), event);
    const isAppAdvisorTarget = event.scope.projectId === APP_ADVISOR_PROJECT_ID;
    if (isAppAdvisorTarget) {
      sendToWindow(
        accessors.getAppAdvisorWindow(),
        IPC_CHANNELS.chatDeferredToolsReloadEvent,
        event,
      );
    }
    sendToWindow(getWindow(), IPC_CHANNELS.chatDeferredToolsReloadEvent, event);
  });

  setSendModelPreparer((req) => prepareSendModel(req, getWindow));
  setAutoModelRoutingDispatcher(
    async (req, origin, fromQueue): Promise<ChatSendMessageRequest> => {
      await assertCoworkChatRootPresent(req.projectId, req.worktreeId);
      if (
        req.modelSelectionMode === 'auto' &&
        req.asyncQuestionId === undefined &&
        req.assistantMode !== 'app-advisor' &&
        req.projectId !== APP_ADVISOR_PROJECT_ID &&
        req.projectId !== PIPELINE_EDITOR_PROJECT_ID &&
        req.projectId !== PLAN_EXPLORE_CHAT_PROJECT_ID &&
        req.projectId !== CODE_REVIEW_CHAT_PROJECT_ID
      ) {
        validateId(req.projectId, 'projectId');
        validateId(req.worktreeId, 'worktreeId');
        validateId(req.chatId, 'chatId');
        validateId(req.userMessageId, 'userMessageId');
        const tab = await readCanonicalChatTab(
          req.projectId,
          req.worktreeId,
          req.chatId,
          true,
        );
        const preferences = await readPreferencesFile().catch(() => null);
        // A known Ultra fast request still rejects when preferences or tab
        // state cannot be read. Auto cannot honor it or commit its prompt.
        assertAutoRoutingCodexSpeed(
          resolveAutoRoutingCodexSpeed({
            requestModelConfig: req.modelConfig,
            requestCodexFastModeEnabled: req.codexFastModeEnabled,
            tab,
            defaults: preferences?.providerModelConfigDefaults,
          }),
        );
        if (tab && preferences) {
          const routing = beginChatAutoRouting(req);
          const controller = routing.controller;
          try {
            // Bind the session's work owner now, as the turn dispatch will
            // (idempotent: the first capture for a session wins, so a
            // background-created session keeps its run's context), and send
            // it with the resolve call so the server verifies it (CAN-3462).
            const workOwnerSession = {
              projectId: req.projectId,
              worktreeId: req.worktreeId,
              chatId: req.chatId,
              // The same context the turn dispatch binds, so the resolve
              // call and the proxy claim the same owner.
              ...(tab.executionContext === undefined
                ? {}
                : { executionContext: tab.executionContext }),
            };
            captureSessionWorkOwner(workOwnerSession);
            const workOwner = await resolveSessionWorkOwner(workOwnerSession);
            controller.signal.throwIfAborted();
            const resolution = await routeDesktopAutoTurn({
              // Stale session routing must not pick the AI Credits lane.
              request: withEffectiveAiCreditsRouting(req),
              tab,
              preferences,
              standalone:
                req.projectId === STANDALONE_CHAT_PROJECT_ID ||
                isCoworkWorkspace(req.projectId),
              workspace:
                getWorkspaceType(req.projectId) ??
                (isCoworkWorkspace(req.projectId) ? 'cowork' : 'single-repo'),
              signal: controller.signal,
              ...(workOwner ? { workOwner } : {}),
            });
            controller.signal.throwIfAborted();
            if (resolution) {
              const preserveModelSelectionMode = !resolution.durableLoss;
              try {
                const changed = await changeChatModel(
                  {
                    projectId: req.projectId,
                    worktreeId: req.worktreeId,
                    chatId: req.chatId,
                    model: resolution.modelId,
                    ...(!tab.executionHarness &&
                    getChatHarnessOptions(resolution.modelId).includes(
                      resolution.harness,
                    )
                      ? { executionHarness: resolution.harness }
                      : {}),
                  },
                  getWindow,
                  {
                    preserveModelSelectionMode,
                    autoRoutedMessageId: req.userMessageId,
                  },
                );
                controller.signal.throwIfAborted();
                if (!changed) throw new AutoModelRoutingApplyError();
              } catch (error) {
                controller.signal.throwIfAborted();
                if (isAutoModelRoutingApplyError(error)) throw error;
                throw new AutoModelRoutingApplyError(error);
              }
              if (resolution.attribution.outcome === 'fallback') {
                const modelLabel = getModelDisplayName(resolution.modelId);
                if (origin === 'desktop' && !fromQueue) {
                  autoRoutingNotices.set(
                    autoRoutingTurnKey(req),
                    resolution.durableLoss
                      ? `Model routing is unavailable for this account, so this chat is now using ${modelLabel}.`
                      : `Model routing couldn’t choose a model, so this message used ${modelLabel}.`,
                  );
                }
              }
              const canonical = await readCanonicalChatTab(
                req.projectId,
                req.worktreeId,
                req.chatId,
              );
              req = {
                ...req,
                model: resolution.modelId,
                providerType:
                  canonical?.providerType ??
                  requireProviderForModel(resolution.modelId),
                executionHarness:
                  canonical?.executionHarness ?? resolution.harness,
                ...(canonical?.modelConfig
                  ? { modelConfig: canonical.modelConfig }
                  : {}),
                ...(preserveModelSelectionMode
                  ? { modelSelectionMode: 'auto' as const }
                  : { modelSelectionMode: undefined }),
                modelRouting: resolution.attribution,
              };
            }
          } finally {
            routing.dispose();
          }
        }
      }
      return req;
    },
  );

  const dispatchChatMessageNowBody = async (
    _event: IpcMainInvokeEvent | undefined,
    req: ChatSendMessageRequest,
    authorization: AuthorizedChatDispatch | undefined,
    allowMainOwnedAgentInput: boolean,
  ): Promise<ChatSendMessageResult> => {
    if (!allowMainOwnedAgentInput) assertUntrustedChatInput(req);
    const {
      projectId,
      worktreeId,
      chatId,
      userMessageId,
      text,
      fileReferences,
      attachmentPaths,
      attachmentPromptContexts,
      inputMode,
      planMode,
      approvalMode: requestedApprovalMode,
      sessionApprovalRules,
      modelConfig,
      thinkingLevel,
      model,
      sdkSessionId,
      codexReconstructionSeedId,
      claudeForkSession,
      claudeForkResumeAt,
      claudeForkStartsFresh,
      pluginSelections,
      packageOverlay,
      deferredToolsAllowed,
      providerType,
      executionHarness,
      codexProposalMode,
      codexFastModeEnabled,
      selectedRepoId,
      assistantMode,
      hiddenContext,
      initiationSource,
      pendingSystemInstructions,
      aiCreditsRouting,
      subscriptionBillingOverride,
      // Stale session routing is ignored, not rewritten here (CAN-4200).
    } = withEffectiveAiCreditsRouting(req);
    // Set only by main for an admitted agent send; it can only narrow.
    const admittedApproval = allowMainOwnedAgentInput
      ? req.admittedApproval
      : undefined;
    const isAppAdvisorTarget = projectId === APP_ADVISOR_PROJECT_ID;
    const isPipelineEditorTarget =
      projectId === PIPELINE_EDITOR_PROJECT_ID &&
      worktreeId === PIPELINE_EDITOR_WORKTREE_ID;
    // Activation signal (CAN-2438): the user submitted a real task.
    // Deliberately excludes the app-managed assistant surfaces -- a single
    // App Advisor or Pipeline Editor question is not "started working", and
    // latching on it would permanently suppress the campaign whose whole
    // premise is that the user has not begun. Latching is idempotent and
    // never rejects, so it cannot affect the send path.
    if (!isAppAdvisorTarget && !isPipelineEditorTarget) {
      void latchFirstTaskSubmitted(new Date().toISOString());
      // Onboarding checklist "Start a chat" (CAN-2663) shares this signal
      // and its exclusions for the same reason: an App Advisor or Pipeline
      // Editor question is a Canopy-owned assistant turn, not the user
      // starting a chat of their own.
      //
      // This latches EARLY, before the validation below, matching
      // `latchFirstTaskSubmitted`'s long-standing placement. The other send
      // funnel (`services/chat-service.ts::sendWorktreeChatMessage`)
      // deliberately latches late, after its org-policy gate. The two are
      // knowingly asymmetric — do not "fix" one into matching the other
      // without moving both, since this one's placement is shared with the
      // CAN-2438 activation signal.
    }
    if (isAppAdvisorTarget) {
      const approvalMode = clampToLiveApprovalMode(
        projectId,
        worktreeId,
        chatId,
        requestedApprovalMode,
      );
      requestAppAdvisorPresentation(
        accessors,
        req.hiddenContext?.kind === 'canopy-watcher-event'
          ? 'watcher_turn'
          : 'user_send',
      );
      const disposition = await dispatchAppAdvisorChatMessage(
        { ...req, approvalMode },
        {
          getMainWindow: accessors.getMainWindow,
          getAppAdvisorWindow: accessors.getAppAdvisorWindow,
          toolSurfaces: {
            getMainWindow: accessors.getMainWindow,
            getAppAdvisorWindow: accessors.getAppAdvisorWindow,
            openAppAdvisorWindow: accessors.openAppAdvisorWindow,
            ensureAppAdvisorWindow: accessors.ensureAppAdvisorWindow,
          },
          ...(authorization ? { authorization } : {}),
        },
      );
      return { disposition };
    }
    const hasPartialPipelineEditorTarget =
      projectId === PIPELINE_EDITOR_PROJECT_ID ||
      worktreeId === PIPELINE_EDITOR_WORKTREE_ID;
    if (hasPartialPipelineEditorTarget) {
      if (!isPipelineEditorTarget) {
        throw new Error(
          'Invalid pipeline-editor chat target: projectId and worktreeId must both use the pipeline-editor sentinel IDs.',
        );
      }
      cancelTransientRetryForChat(
        { projectId, worktreeId, chatId },
        'manual-send',
      );
      const approvalMode = clampToLiveApprovalMode(
        projectId,
        worktreeId,
        chatId,
        requestedApprovalMode,
      );
      consumeDispatchAuthorization(authorization, {
        projectId,
        worktreeId,
        chatId,
        userMessageId,
      });
      await dispatchPipelineEditorChatMessage(
        { ...req, approvalMode },
        {
          getMainWindow: accessors.getMainWindow,
          toolSurfaces: {
            getMainWindow: accessors.getMainWindow,
          },
        },
      );
      return {};
    }
    const hasPartialAppAdvisorTarget = projectId === APP_ADVISOR_PROJECT_ID;
    if (assistantMode === 'app-advisor' || hasPartialAppAdvisorTarget) {
      throw new Error('Invalid App Advisor chat target.');
    }
    validateId(projectId, 'projectId');
    validateId(worktreeId, 'worktreeId');
    validateId(chatId, 'chatId');
    validateId(userMessageId, 'userMessageId');
    validateOptionalRepoId(selectedRepoId, 'selectedRepoId');
    cancelTransientRetryForChat(
      { projectId, worktreeId, chatId },
      'manual-send',
    );
    // Split PR lockdown: refuse chat sends that resolve to the locked
    // worktree. Advisor/pipeline-editor sentinel sends returned above and
    // are unaffected; a genuine worktree-targeted send whose worktree is
    // mid-split is refused with the typed lock error.
    assertNotSplitLocked(projectId, worktreeId, 'sending a chat message');
    await assertCoworkChatRootPresent(projectId, worktreeId);
    // Before memory preparation and the prompt commit: a Stop or newer
    // dispatch since admission makes this attempt stale. Only the inline
    // Cowork path dispatches here; a worktree send is admitted downstream
    // by the queue, whose final dispatcher consumes its capability.
    if (isCoworkWorkspace(projectId))
      consumeDispatchAuthorization(authorization, {
        projectId,
        worktreeId,
        chatId,
        userMessageId,
      });
    const cwd = resolveWorktreeCwd(projectId, worktreeId, selectedRepoId);
    const isStandalone = projectId === STANDALONE_CHAT_PROJECT_ID;
    const isCoworkChat = isCoworkWorkspace(projectId);
    // Conceptual chat-project id for cowork history/meta persistence. The
    // legacy sentinel keying carried it in `worktreeId`; the rekeyed
    // renderer sends the real cowork workspace id directly in `projectId`
    // (with `worktreeId` fixed to the cowork home worktree slot), so for a
    // real cowork id the conceptual id is `projectId` itself. Unused
    // outside the `isCoworkChat` branch below.
    const standaloneProjectId = isStandalone ? worktreeId : projectId;
    const requestedProviderType =
      providerType ?? (model ? requireProviderForModel(model) : 'claude');
    const effectiveModelSource = model ? getModelSource(model) : undefined;
    const persistedCoworkDispatch = isCoworkChat
      ? await readPersistedChatDispatchMetadata(
          projectId,
          worktreeId,
          chatId,
        ).catch(
          (): PersistedChatDispatchMetadata =>
            ({}) satisfies PersistedChatDispatchMetadata,
        )
      : ({} satisfies PersistedChatDispatchMetadata);
    const activeCoworkSession = isCoworkChat
      ? findMatchingSessionInfo(projectId, worktreeId, chatId)
      : undefined;
    const effectiveExecutionHarness =
      activeCoworkSession?.executionHarness ??
      persistedCoworkDispatch.executionHarness ??
      (persistedCoworkDispatch.model
        ? getExecutionHarnessForModel(persistedCoworkDispatch.model)
        : undefined) ??
      (model ? getExecutionHarnessForModel(model) : undefined) ??
      // Cursor is both the provider and the harness, so a tab persisted with
      // the Cursor provider and no model still routes to Cursor (and its
      // runtime preflight) rather than silently falling back to Claude.
      (persistedCoworkDispatch.providerType === 'opencode'
        ? 'opencode'
        : persistedCoworkDispatch.providerType === 'copilot'
          ? 'copilot'
          : persistedCoworkDispatch.providerType === 'cursor'
            ? 'cursor'
            : undefined) ??
      (requestedProviderType === 'ollama' ? 'claude' : requestedProviderType);
    // Cursor is both the provider and the harness: a turn routed to Cursor
    // records and runs the Cursor provider whatever label the request or the
    // persisted tab carried, so the session never sees a `claude` provider
    // paired with the Cursor harness.
    const effectiveProviderType: AgentProviderType =
      effectiveExecutionHarness === 'opencode'
        ? 'opencode'
        : effectiveExecutionHarness === 'copilot'
          ? 'copilot'
          : effectiveExecutionHarness === 'cursor'
            ? 'cursor'
            : requestedProviderType;
    // Reuse one live account-model snapshot for preflight, session options,
    // and audit records when the request omits its model.
    const liveAccountModel =
      (effectiveExecutionHarness === 'cursor' ||
        effectiveExecutionHarness === 'copilot' ||
        effectiveExecutionHarness === 'opencode') &&
      !model
        ? getSessionSelectedModel(projectId, worktreeId, chatId)
        : undefined;
    if (effectiveExecutionHarness === 'opencode') {
      if (!(await isOpenCodeRuntimeAvailable()))
        throw new Error('Connect OpenCode in Settings before sending.');
      await assertOpenCodeSelectionAvailable({
        model: model ?? liveAccountModel,
        session: { projectId, worktreeId, chatId },
      });
    }
    if (effectiveExecutionHarness === 'cursor') assertCursorHarnessEnabled();
    if (
      effectiveExecutionHarness === 'cursor' &&
      projectId === CODE_REVIEW_CHAT_PROJECT_ID
    ) {
      const { readCursorAccount } = await import('../cursor/connection');
      if (
        !(await isCursorRuntimeAvailable()) ||
        !(await readCursorAccount(AbortSignal.timeout(20_000)))
      )
        throw new Error(
          'Connect Cursor in Settings to send with Cursor, or choose another model.',
        );
    }

    if (effectiveExecutionHarness === 'copilot') {
      assertCopilotHarnessEnabled();
      if (!(await isCopilotRuntimeAvailable()))
        throw new Error('Connect Copilot in Settings to send with Copilot.');
      if (!model && !liveAccountModel)
        throw new Error('Choose a GitHub Copilot model before sending.');
      await assertCopilotModelAvailable(model ?? liveAccountModel);
    }
    if (
      isCoworkChat &&
      effectiveExecutionHarness === 'cursor' &&
      !(await isCursorRuntimeAvailable())
    ) {
      // Same preflight App Advisor applies: refuse before the prompt is
      // persisted so a disconnected runtime never leaves a dead message.
      throw new Error(
        'Connect Cursor in Settings to send with Cursor, or choose another model.',
      );
    }
    if (
      isCoworkChat &&
      effectiveExecutionHarness === 'cursor' &&
      !model &&
      !liveAccountModel
    ) {
      // A Cursor route with no model to run would only fail inside the
      // session, after the prompt was persisted; refuse it here so nothing is
      // written.
      throw new Error(
        'Choose a Cursor model to send with Cursor, or choose another model.',
      );
    }
    if (
      isCoworkChat &&
      executionHarness !== undefined &&
      executionHarness !== effectiveExecutionHarness
    ) {
      throw new Error(
        'Chat execution harness does not match host-owned routing',
      );
    }
    if (
      effectiveProviderType === 'claude' &&
      (effectiveModelSource === undefined ||
        effectiveModelSource === 'claude-managed') &&
      !isCoworkChat
    ) {
      const terminalService = getClaudeTerminalSessionService();
      const terminalState = terminalService.getState(
        projectId,
        worktreeId,
        chatId,
      );
      const terminalTurnState = terminalState?.turnState;
      if (
        terminalTurnState === 'starting' ||
        terminalTurnState === 'running' ||
        terminalTurnState === 'cleaning_up'
      ) {
        throw new Error(
          `Claude Code terminal mode is currently active. Wait for it to finish before sending from ${BRAND.displayName}.`,
        );
      }
      if (
        terminalTurnState === 'idle' ||
        terminalTurnState === 'exited' ||
        terminalTurnState === 'error'
      ) {
        await terminalService.cleanup({
          projectId,
          worktreeId,
          chatId,
          reason: 'switch-to-native-send',
        });
      }
    }

    // Cowork turns need preferences before the system prompt is built so
    // the local-memory nudge is preference-gated exactly like the worktree
    // dispatch funnel; non-cowork sends keep skipping the read here.
    const preferences = isCoworkChat
      ? await readPreferencesFile().catch(() => null)
      : null;
    const coworkMemoryPolicy = isCoworkChat
      ? await resolveLocalMemoryPolicy({ projectId, worktreeId })
      : null;
    const systemPromptAppend = isCoworkChat
      ? buildCoworkDispatchSystemPromptAppend(
          effectiveExecutionHarness,
          preferences?.localMemoryEnabled === true,
          coworkMemoryPolicy?.kind === 'scoped' &&
            coworkMemoryPolicy.privateMemory,
          chatVisualsPromptEligible(effectiveProviderType, 'cowork'),
        )
      : buildWorktreeInjectedToolPrompt(
          effectiveExecutionHarness,
          true,
          true,
          chatVisualsPromptEligible(effectiveProviderType, 'worktree'),
        );

    if (isCoworkChat) {
      // Start owner-scoped memory retrieval before the resource guard, as the
      // worktree dispatch path does, so the fetch overlaps turn setup.
      const memoryStartedAt = Date.now();
      const memoryPromise = prepareOrgMemory({
        userText: text,
        projectId: standaloneProjectId,
        worktreeId,
        chatId,
        userMessageId,
        ...(hiddenContext?.kind === undefined
          ? {}
          : { hiddenContextKind: hiddenContext.kind }),
        initiationSource: isUsageInitiationSource(initiationSource)
          ? initiationSource
          : 'user',
      });
      const memoryDeliveryTracker = createOrgMemoryDeliveryTracker({
        resultPromise: memoryPromise.then(
          (prepared) => prepared?.attempt.result ?? null,
        ),
        dispatchStartedAt: memoryStartedAt,
        clientChatId: clampId(chatId, MAX_TELEMETRY_CLIENT_ID_LENGTH),
      });
      let resourceGuard: ResourceGuardReservation | undefined;
      let coworkTurnRun: ChatTurnRunHandle | undefined;
      try {
        resourceGuard =
          await getResourceMonitorService().reserveChatTurnStart();
        const chatStateService = getChatStateService();
        await chatStateService.ensureChatForTrustedSend(req);
        const promptCommitted = await chatStateService.ingestProviderEvent({
          projectId,
          worktreeId,
          chatId,
          data: buildTrustedUserPromptEvent(req),
          mutationId: `${chatId}:${userMessageId}:user-prompt`,
          providerType: effectiveProviderType,
          turnUserMessageId: userMessageId,
        });
        if (!promptCommitted) {
          const accepted = await chatStateService.hasMutation(
            { projectId, worktreeId },
            `${chatId}:${userMessageId}:accepted`,
          );
          if (accepted) {
            await clearUsageLimitedChat({ projectId, worktreeId, chatId });
            return { disposition: 'already_accepted' };
          }
        }
        const messageText = buildSubmittedMessageText({
          text,
          fileReferences,
          attachmentPaths,
          attachmentPromptContexts,
          // `cwd` already resolves to the cowork home dir for both the
          // legacy sentinel keying and real cowork workspace ids.
          attachmentBaseDir: getCoworkManagedSubdir(cwd, 'attachments'),
          cwd,
          inputMode,
          pendingSystemInstructions,
        });
        // Same preference-gated local-memory preparation as the worktree
        // dispatch funnel. `standaloneProjectId` is the real cowork
        // workspace id for both keyings, so `resolveMemoryWorkspaceId`
        // passes it through unchanged and injection reads the same
        // directory SaveMemory/SearchMemory use. Organization memory uses
        // the shared preparation policy and the workspace's persisted owner.
        const localMemory = await prepareLocalMemoryContext({
          userText: text,
          projectId: standaloneProjectId,
          worktreeId,
        });
        const runtime = model
          ? await resolveAgentModelRuntime({
              projectId: standaloneProjectId,
              model,
              systemPromptAppend,
              pluginSelections,
              providerType: effectiveProviderType,
            })
          : undefined;
        const runtimeProviderType =
          runtime?.providerType ?? effectiveProviderType;
        // The live account session's model (a model-less Cowork send) is the
        // model the turn runs on, so it is what the audit trail, chat events,
        // and session options record.
        const runtimeModel = runtime?.runtimeModel ?? model ?? liveAccountModel;
        // Global Instructions (Instructions settings) — "User Overall
        // Preferences" block resolved for this cowork session context and
        // appended after the cowork/Agent system prompt. Reaches the
        // provider only when a session is (re)created.
        const chatGlobalInstructions = preferences?.globalInstructions?.chats;
        const currentGlobalInstructionsBlock = chatGlobalInstructions
          ? buildUserOverallPreferencesBlock(chatGlobalInstructions, {
              harness: runtimeProviderType,
              model: resolveModelAlias(runtimeModel ?? ''),
              workspaceType: 'cowork',
            })
          : '';
        const globalInstructionsBlock = sdkSessionId
          ? (req.globalInstructionsSnapshot ??
            getSessionGlobalInstructionsSnapshot(
              projectId,
              worktreeId,
              chatId,
            ) ??
            '')
          : currentGlobalInstructionsBlock;
        const composedSystemPromptAppend =
          appendUserOverallPreferencesBlock(
            runtime?.systemPromptAppend ?? systemPromptAppend,
            globalInstructionsBlock,
          ) ?? systemPromptAppend;
        const observedSystemPromptAppend = composedSystemPromptAppend;
        const effectiveModelConfig = resolveProviderModelConfig(
          effectiveExecutionHarness,
          {
            thinkingLevel,
            modelConfig: buildModelConfigInput(modelConfig, {
              thinkingLevel,
              codexFastModeEnabled,
            }),
          },
          preferences?.providerModelConfigDefaults,
        );
        const codexPreferences =
          effectiveExecutionHarness === 'codex' ? preferences : null;
        // Claude and Cursor both rewrite shell commands through the
        // bundled RTK hook; Codex has no rewrite seam.
        const rtkEnabled =
          effectiveExecutionHarness === 'claude' ||
          effectiveExecutionHarness === 'copilot' ||
          effectiveExecutionHarness === 'opencode' ||
          effectiveExecutionHarness === 'cursor'
            ? preferences?.rtkEnabled !== false
            : false;

        // Canonical eligibility controls initial title generation, including
        // retries after failed persistence. Work entry metadata derives from
        // canonical tab state.
        scheduleChatSummary({
          projectId,
          worktreeId,
          chatId,
          cwd,
          getWindow,
          standaloneChatProjectId: standaloneProjectId,
          linkTarget: buildStandaloneChatLinkTarget(
            standaloneProjectId,
            chatId,
          ),
        });

        await assertCoworkChatRootPresent(projectId, worktreeId);
        if (shouldRecreateSessionOnNextTurn(projectId, worktreeId, chatId)) {
          await destroySession(projectId, worktreeId, chatId, {
            retainDelegations: true,
          });
        }

        const sessionPluginSelections = await normalizeAccountMcpSelections(
          runtime?.pluginSelections ?? pluginSelections,
        );
        // The saved chat's authority as the session is created; the request
        // can only narrow it (CAN-4469).
        const turnApprovalTarget = {
          projectId,
          worktreeId,
          chatId,
          userMessageId,
          approvalMode: requestedApprovalMode,
          sessionApprovalRules,
          admittedApproval,
        };
        const {
          approvalMode,
          sessionApprovalRules: turnSessionApprovalRules,
          chatApprovalMode,
        } = await resolveChatTurnApprovalAuthority(turnApprovalTarget);
        const sessionOptions = {
          cwd,
          ...(selectedRepoId ? { selectedRepoId } : {}),
          projectId,
          worktreeId,
          chatId,
          planMode,
          approvalMode,
          sessionApprovalRules: turnSessionApprovalRules,
          codexProposalMode,
          thinkingLevel: effectiveModelConfig.thinkingLevel,
          modelConfig: effectiveModelConfig,
          model: runtimeModel,
          selectedModel: model ?? liveAccountModel,
          sdkSessionId,
          codexReconstructionSeedId,
          ...(claudeForkSession ? { claudeForkSession: true } : {}),
          ...(claudeForkSession && claudeForkResumeAt
            ? { claudeForkResumeAt }
            : {}),
          ...(claudeForkStartsFresh ? { claudeForkStartsFresh: true } : {}),
          pluginSelections: sessionPluginSelections,
          // An automation's installed package (CAN-5379), as the worktree
          // dispatch and the native standalone send apply it.
          ...(packageOverlay ? { packageOverlay } : {}),
          applyGlobalPluginDefaults:
            chatSurfaceUsesGlobalPluginDefaults(projectId),
          deferredToolsAllowed: deferredToolsAllowed !== false,
          systemPromptAppend: runtime?.systemPromptAppend ?? systemPromptAppend,
          globalInstructionsBlock,
          globalInstructionsSnapshot: sdkSessionId
            ? globalInstructionsBlock
            : undefined,
          providerType: runtimeProviderType,
          executionHarness: effectiveExecutionHarness,
          codexAppServerIdleTimeoutMinutes:
            codexPreferences?.codexAppServerIdleTimeoutMinutes,
          codexMaxConcurrentSubagents:
            codexPreferences?.codexMaxConcurrentSubagents,
          codexMultiAgentEnabled:
            codexPreferences?.codexMultiAgentStandaloneChatsEnabled,
          rtkEnabled,
          ...(aiCreditsRouting ? { aiCreditsRouting } : {}),
          ...(subscriptionBillingOverride
            ? { subscriptionBillingOverride: true }
            : {}),
        };
        // Without an admitted agent send's cap, which binds only this turn's
        // session, so the chat's later turns run at its own mode.
        setLiveApprovalMode(projectId, worktreeId, chatId, chatApprovalMode);
        const watcherAcceptedAt = new Date().toISOString();
        const watcherContext = captureCanonicalChatProducerContext({
          projectId,
          worktreeId,
          chatId,
        });
        let executionUserMessageId = userMessageId;
        const rejectedTurnRoots = new Map<
          string,
          ChatQueueRevivalLease | undefined
        >();
        let codexRootThreadId = sdkSessionId;
        const deliverSessionEvent = (
          data: unknown,
          occurredAt: string,
        ): void => {
          getExecutionObservabilityIngest().observeChatEvent(
            projectId,
            worktreeId,
            chatId,
            data,
          );
          sendChatEvent(getWindow(), projectId, worktreeId, chatId, data, {
            providerType:
              runtimeProviderType ??
              (runtimeModel ? getProviderForModel(runtimeModel) : undefined),
            model: runtimeModel,
          });
          const portalMessage = runtimeChatEventToPortalMessage({
            scope: 'standalone',
            chatId,
            data,
            fallbackMessageId: `${executionUserMessageId}:assistant`,
          });
          if (portalMessage) {
            enqueuePortalEvent(
              createPortalEvent('portal.chat.event', {
                scope: 'standalone',
                projectLocalId: standaloneProjectId,
                projectId: standaloneProjectId,
                workEntryId: worktreeId,
                chatId,
                message: portalMessage,
              }),
            );
          }

          const eventData = isRecord(data) ? data : null;
          if (
            eventData &&
            isRootTerminalChatEventData(eventData, codexRootThreadId)
          ) {
            if (
              deferredToolsReloadCoordinator.hasActiveReload({
                projectId,
                worktreeId,
                chatId,
              })
            ) {
              return;
            }
            const status = getChatTurnAuditStatus(eventData);
            getChatQueueService().onTurnTerminal(
              { projectId, worktreeId, chatId },
              status === 'success'
                ? 'complete'
                : status === 'failure'
                  ? 'error'
                  : 'cancelled',
              executionUserMessageId,
            );
            const error =
              eventData.type === 'error'
                ? typeof eventData.error === 'string'
                  ? eventData.error
                  : 'Unknown error'
                : eventData.is_error === true &&
                    typeof eventData.result === 'string'
                  ? eventData.result
                  : undefined;
            getExecutionObservabilityIngest().completeChatTurn(
              projectId,
              worktreeId,
              chatId,
              status,
              error,
            );
            void notifyCanonicalChatTerminal(
              { projectId, worktreeId, chatId },
              executionUserMessageId,
              eventData,
              status,
              occurredAt,
              watcherContext,
              executionUserMessageId === userMessageId
                ? watcherAcceptedAt
                : undefined,
            ).catch(() => undefined);
            scheduleSummaryGeneration(projectId, worktreeId, getWindow);
          }
        };
        let sessionEventCommitTail = Promise.resolve();
        let sessionEventSequence = 0;
        const handleSessionEvent = (
          data: unknown,
          markPersistenceSettled?: () => void,
        ): Promise<void> => {
          codexRootThreadId = readCodexRootThreadId(data) ?? codexRootThreadId;
          const occurredAt = new Date().toISOString();
          const dataRecord = isRecord(data) ? data : null;
          const pickupUserMessageId =
            dataRecord?.type === 'canopy_input_delivery' &&
            dataRecord.phase === 'picked-up' &&
            dataRecord.startsTurn === true &&
            typeof dataRecord.userMessageId === 'string'
              ? dataRecord.userMessageId
              : undefined;
          // The router keeps its lease metadata outside event data, so inspect
          // the original routed object before any continuation can clone it.
          const turnRootAcceptance = getTurnRootAcceptance(data);
          const sequence = sessionEventSequence;
          sessionEventSequence += 1;
          sessionEventCommitTail = sessionEventCommitTail
            .then(async () => {
              const taggedRootId =
                dataRecord &&
                typeof dataRecord.canopy_turn_user_message_id === 'string'
                  ? dataRecord.canopy_turn_user_message_id
                  : undefined;
              const isIdleStatusEvent =
                dataRecord?.type === 'system' &&
                dataRecord.subtype === 'status' &&
                dataRecord.status === 'idle';
              // A delegate's snapshot keeps the tag of the turn that started
              // it. Like the router and the worktree route, deliver it under
              // any root, including a rejected one.
              const ownedDelegation = isOwnedDelegationEvent(data);

              if (
                pickupUserMessageId === undefined &&
                !ownedDelegation &&
                taggedRootId !== undefined &&
                rejectedTurnRoots.has(taggedRootId)
              ) {
                if (isIdleStatusEvent) {
                  // Lifecycle activity already has its own session-manager
                  // listeners. Wake phase-13a reconciliation without
                  // feeding a rejected root back through canonical ingest.
                  getChatQueueService().reconcileSessionActivity();
                } else if (
                  dataRecord &&
                  isRootTerminalChatEventData(dataRecord, codexRootThreadId)
                ) {
                  const rejectedLease = rejectedTurnRoots.get(taggedRootId);
                  if (rejectedLease) {
                    getChatQueueService().rollbackTurnRevival(
                      { projectId, worktreeId, chatId },
                      rejectedLease,
                    );
                  }
                }
                markPersistenceSettled?.();
                return;
              }

              // Router-accepted output can arrive after canonical pickup
              // rejection. Drop a different tagged root before canonical
              // ingest so it cannot revive state under the current root.
              if (
                pickupUserMessageId === undefined &&
                !ownedDelegation &&
                dataRecord &&
                typeof dataRecord.canopy_turn_user_message_id === 'string' &&
                dataRecord.canopy_turn_user_message_id !==
                  executionUserMessageId
              ) {
                markPersistenceSettled?.();
                return;
              }

              const ingestResult =
                await chatStateService.ingestProviderEventWithResult({
                  projectId,
                  worktreeId,
                  chatId,
                  data,
                  mutationId: `${chatId}:${userMessageId}:provider:${sequence}`,
                  providerType: runtimeProviderType,
                  turnUserMessageId: executionUserMessageId,
                });
              markPersistenceSettled?.();
              if (pickupUserMessageId !== undefined && dataRecord) {
                const queue = getChatQueueService();
                const target = { projectId, worktreeId, chatId };

                // Router refusal is definitive: it must never surface a
                // pickup that the route itself declined to adopt.
                if (turnRootAcceptance?.accepted === false) return;

                if (ingestResult.pickup === 'rejected') {
                  // Stop may leave a same-root dispatch running while the
                  // canonical ledger rejects an ambiguous/unknown attempt.
                  // That verdict cannot release or switch the live root.
                  if (
                    pickupUserMessageId !== executionUserMessageId &&
                    turnRootAcceptance?.accepted === true
                  ) {
                    const lease = turnRootAcceptance.lease;
                    if (lease) queue.rollbackTurnRevival(target, lease);
                    if (!rejectedTurnRoots.has(pickupUserMessageId)) {
                      rejectedTurnRoots.set(pickupUserMessageId, lease);
                    }
                  }
                  return;
                }

                if (turnRootAcceptance?.accepted === true) {
                  const lease = turnRootAcceptance.lease;
                  const pickupAccepted =
                    ingestResult.pickup === 'accepted' ||
                    ingestResult.pickup === 'already-accepted';
                  if (!pickupAccepted) {
                    if (pickupUserMessageId !== executionUserMessageId) {
                      if (lease) queue.rollbackTurnRevival(target, lease);
                      if (!rejectedTurnRoots.has(pickupUserMessageId)) {
                        rejectedTurnRoots.set(pickupUserMessageId, lease);
                      }
                    }
                    return;
                  }
                  if (lease) {
                    if (!queue.confirmTurnRevival(target, lease)) {
                      queue.rollbackTurnRevival(target, lease);
                      if (pickupUserMessageId !== executionUserMessageId) {
                        if (!rejectedTurnRoots.has(pickupUserMessageId)) {
                          rejectedTurnRoots.set(pickupUserMessageId, lease);
                        }
                      }
                      return;
                    }
                    executionUserMessageId = pickupUserMessageId;
                    rejectedTurnRoots.delete(pickupUserMessageId);
                  }
                }
              }

              // Activity-only events carry no durable change but are live.
              if (ingestResult.outcome === 'not-applied') {
                // Codex emits turn.completed before its synthesized result.
                // The result can therefore be a canonical no-op even though
                // the renderer still needs that single cancellation-aware
                // presentation boundary for unread and auto-archive effects.
                if (
                  isRecord(data) &&
                  data.type === 'result' &&
                  data.canopy_session_continues !== true
                ) {
                  sendChatEvent(
                    getWindow(),
                    projectId,
                    worktreeId,
                    chatId,
                    data,
                    {
                      providerType:
                        runtimeProviderType ??
                        (runtimeModel
                          ? getProviderForModel(runtimeModel)
                          : undefined),
                      model: runtimeModel,
                    },
                  );
                }
                return;
              }
              deliverSessionEvent(data, occurredAt);
            })
            .catch((error: unknown) => {
              markPersistenceSettled?.();
              logMainProcessError(
                `Failed to durably commit cowork chat event for ${projectId}/${worktreeId}/${chatId}`,
                error,
              );
            });
          return sessionEventCommitTail;
        };
        const turnRun = await beginChatTurnRun({
          scope: { workspaceId: projectId, worktreeId, chatId },
          turnId: userMessageId,
          eventNamespace: 'initial',
          providerId: sessionOptions.providerType,
          model: sessionOptions.model ?? null,
          initiationSource: 'user',
          settleOn: 'root-terminal',
          codexRootThreadId,
        });
        coworkTurnRun = turnRun;
        const session = await turnRun.execute(() =>
          getOrCreateRoutedSession(
            sessionOptions,
            turnRun.observe(handleSessionEvent),
            getWindow,
            {
              turnUserMessageId: userMessageId,
              acceptTurnRoot: async (turnUserMessageId) => {
                await sessionEventCommitTail;
                return getChatQueueService().acceptTurnRevival(
                  { projectId, worktreeId, chatId },
                  turnUserMessageId,
                );
              },
              drainEventsBeforeRemoval: () => sessionEventCommitTail,
            },
          ),
        );
        const authoritativeGlobalInstructionsSnapshot =
          getSessionGlobalInstructionsSnapshot(projectId, worktreeId, chatId) ??
          globalInstructionsBlock;
        if (
          req.globalInstructionsSnapshot !==
          authoritativeGlobalInstructionsSnapshot
        ) {
          sendChatEvent(getWindow(), projectId, worktreeId, chatId, {
            type: GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
            globalInstructionsSnapshot: authoritativeGlobalInstructionsSnapshot,
          });
        }

        deferredToolsReloadCoordinator.registerResumeHandler(
          { projectId, worktreeId, chatId },
          async (request) => {
            request.signal.throwIfAborted();
            // The continuation is admitted through the hold the reload took
            // at its interruption, once its predecessor's end commits, as the
            // worktree and App Advisor continuations are.
            const admission =
              await getChatQueueService().admitDirectDispatchWhenAllowed(
                { projectId, worktreeId, chatId },
                request.userMessageId,
                request.signal,
                request.requestId,
              );
            if (!admission)
              throw new Error('The reload could not continue this chat.');
            let resumedTurnRun: ChatTurnRunHandle | undefined;
            try {
              request.signal.throwIfAborted();
              const resumedRuntime = model
                ? await resolveAgentModelRuntime({
                    projectId: standaloneProjectId,
                    model,
                    systemPromptAppend,
                    pluginSelections:
                      request.pluginSelections ?? pluginSelections,
                    providerType: request.providerType ?? effectiveProviderType,
                  })
                : undefined;
              const resumedProviderType =
                resumedRuntime?.providerType ??
                request.providerType ??
                runtimeProviderType;
              // The renderer normally captures the init event's session id,
              // but deferred loading can begin in the same turn that created
              // the Codex thread. Read the provider-owned id from the old
              // session as the authoritative fallback so destroying that
              // session never turns capability materialization into a fresh,
              // history-less start because of renderer event timing.
              const providerSessionId = session.getProviderSessionId?.();
              const resumedPluginSelections =
                await normalizeAccountMcpSelections(
                  resumedRuntime?.pluginSelections ??
                    request.pluginSelections ??
                    sessionPluginSelections,
                );
              const resumedAuthority = await resolveChatTurnApprovalAuthority(
                turnApprovalTarget,
                { checkAdmission: false },
              );
              setLiveApprovalMode(
                projectId,
                worktreeId,
                chatId,
                resumedAuthority.chatApprovalMode,
              );
              const continuationSession = claudeContinuationSession(
                sessionOptions,
                {
                  requestedSessionId: request.sdkSessionId,
                  providerSessionId,
                },
              );
              const turnRun = await beginChatTurnRun({
                scope: { workspaceId: projectId, worktreeId, chatId },
                turnId: request.userMessageId,
                eventNamespace: deferredReloadEventNamespace(request.requestId),
                providerId: resumedProviderType,
                model: resumedRuntime?.runtimeModel ?? runtimeModel ?? null,
                initiationSource: 'user',
                settleOn: 'root-terminal',
                codexRootThreadId: continuationSession.sdkSessionId,
              });
              resumedTurnRun = turnRun;
              const resumedSession = await turnRun.execute(() =>
                getOrCreateRoutedSession(
                  {
                    ...sessionOptions,
                    approvalMode: resumedAuthority.approvalMode,
                    sessionApprovalRules: resumedAuthority.sessionApprovalRules,
                    model: resumedRuntime?.runtimeModel ?? runtimeModel,
                    ...continuationSession,
                    pluginSelections: resumedPluginSelections,
                    systemPromptAppend:
                      resumedRuntime?.systemPromptAppend ??
                      runtime?.systemPromptAppend ??
                      systemPromptAppend,
                    providerType: resumedProviderType,
                    codexAppServerIdleTimeoutMinutes:
                      resumedProviderType === 'codex'
                        ? preferences?.codexAppServerIdleTimeoutMinutes
                        : undefined,
                    codexMaxConcurrentSubagents:
                      resumedProviderType === 'codex'
                        ? preferences?.codexMaxConcurrentSubagents
                        : undefined,
                    codexMultiAgentEnabled:
                      resumedProviderType === 'codex'
                        ? preferences?.codexMultiAgentStandaloneChatsEnabled
                        : undefined,
                  },
                  turnRun.observe(handleSessionEvent),
                  getWindow,
                  {
                    turnUserMessageId: userMessageId,
                    acceptTurnRoot: async (turnUserMessageId) => {
                      await sessionEventCommitTail;
                      return getChatQueueService().acceptTurnRevival(
                        { projectId, worktreeId, chatId },
                        turnUserMessageId,
                      );
                    },
                    drainEventsBeforeRemoval: () => sessionEventCommitTail,
                  },
                ),
              );
              getExecutionObservabilityIngest().recordInjectedPromptForOpenChatTurn(
                projectId,
                worktreeId,
                chatId,
                {
                  kind: 'system_prompt_append',
                  provider: resumedProviderType,
                  applicationCondition: 'deferred_tools_reload_continuation',
                  text: request.continuationText,
                  deferredToolsReload: {
                    enabledResources: request.enabledResources,
                  },
                },
              );
              if (typeof planMode === 'boolean') {
                await resumedSession.setPlanMode(planMode);
              }
              if (
                (resumedProviderType === 'claude' ||
                  resumedProviderType === 'cursor' ||
                  resumedProviderType === 'copilot' ||
                  resumedProviderType === 'opencode') &&
                resumedSession.setRtkEnabled
              ) {
                await resumedSession.setRtkEnabled(rtkEnabled);
              }
              if (codexProposalMode && resumedSession.setCodexProposalMode) {
                await resumedSession.setCodexProposalMode(codexProposalMode);
              }
              const resumedCodexIdleTimeoutMinutes =
                preferences?.codexAppServerIdleTimeoutMinutes;
              if (
                resumedProviderType === 'codex' &&
                typeof resumedCodexIdleTimeoutMinutes === 'number' &&
                resumedSession.setCodexAppServerIdleTimeoutMinutes
              ) {
                await resumedSession.setCodexAppServerIdleTimeoutMinutes(
                  resumedCodexIdleTimeoutMinutes,
                );
              }
              await applyAgentSessionCodexSpeed(
                resumedSession,
                effectiveModelConfig.speed,
              );
              const liveResumedAuthority =
                await resolveChatTurnApprovalAuthority(turnApprovalTarget, {
                  checkAdmission: false,
                });
              restrictSessionApprovalRules(
                projectId,
                worktreeId,
                chatId,
                liveResumedAuthority.sessionApprovalRules,
              );
              setLiveApprovalMode(
                projectId,
                worktreeId,
                chatId,
                liveResumedAuthority.chatApprovalMode,
              );
              await resumedSession.setApprovalMode(
                liveResumedAuthority.approvalMode,
              );
              turnRun.signal.throwIfAborted();
              consumeDispatchAuthorization(admission.authorization, {
                projectId,
                worktreeId,
                chatId,
                userMessageId: request.userMessageId,
              });
              reservePromptBindingSlot(
                { projectId, worktreeId, chatId },
                request.userMessageId,
              );
              turnRun.executeSync(() =>
                resumedSession.sendMessage(request.continuationText, {
                  userMessageId: request.userMessageId,
                }),
              );
              turnRun.accepted();
            } catch (error) {
              resumedTurnRun?.abandon(error);
              admission.release();
              throw error;
            }
            if (request.signal.aborted) {
              await destroySession(projectId, worktreeId, chatId, {
                retainDelegations: true,
              });
              request.signal.throwIfAborted();
            }
          },
        );

        const validatedInitiationSource = isUsageInitiationSource(
          initiationSource,
        )
          ? initiationSource
          : 'user';

        // Overlap owner-scoped retrieval with session setup, using the same
        // total preparation budget as other chat dispatch paths.
        const preparedMemory = await raceWithTimeout(
          memoryPromise,
          remainingMemoryBudgetMs(memoryStartedAt),
        );
        const memory = preparedMemory?.attempt.result ?? null;
        if (preparedMemory === null) memoryDeliveryTracker.noteRaceLoss();
        const submittedText = composeSubmittedText(
          messageText,
          hiddenContext?.text,
          joinHiddenBlocks(memory?.renderedBlock, localMemory?.renderedBlock),
        );
        getExecutionObservabilityIngest().startChatTurn({
          projectId,
          worktreeId,
          chatId,
          provider: runtimeProviderType,
          model: runtimeModel,
          modelSource: effectiveModelSource,
          executionHarness: effectiveExecutionHarness,
          serviceTier:
            effectiveExecutionHarness === 'codex'
              ? codexServiceTierForModelConfig(effectiveModelConfig)
              : undefined,
          aiCreditsRouted: isSessionAiCreditsRouted(
            projectId,
            worktreeId,
            chatId,
          ),
          accountProxyRouted: isSessionAccountProxyRouted(
            projectId,
            worktreeId,
            chatId,
          ),
          ...(req.modelRouting ? { modelRouting: req.modelRouting } : {}),
          sdkSessionId,
          originalUserText: text,
          submittedText,
          orgMemoryBlock: memory?.renderedBlock,
          fileReferences,
          planMode: planMode === true,
          systemPromptAppend: observedSystemPromptAppend,
          userMessageId,
          isStandalone: true,
          standaloneProjectId,
          initiationSource: validatedInitiationSource,
          // Matches the skill usage eligibility of this dispatch below.
          skillSuggestionEligible:
            (validatedInitiationSource === 'user' ||
              validatedInitiationSource === 'portal') &&
            !req.hiddenContext,
        });

        if (typeof planMode === 'boolean') {
          await session.setPlanMode(planMode);
        }
        // Authority narrowed while the session was created, or held by a
        // reused session, still applies.
        const liveApprovalAuthority = await resolveChatTurnApprovalAuthority(
          turnApprovalTarget,
          { checkAdmission: false },
        );
        restrictSessionApprovalRules(
          projectId,
          worktreeId,
          chatId,
          liveApprovalAuthority.sessionApprovalRules,
        );
        await session.setApprovalMode(liveApprovalAuthority.approvalMode);
        if (
          (effectiveExecutionHarness === 'claude' ||
            effectiveExecutionHarness === 'cursor' ||
            effectiveExecutionHarness === 'copilot' ||
            effectiveExecutionHarness === 'opencode') &&
          session.setRtkEnabled
        ) {
          await session.setRtkEnabled(rtkEnabled);
        }
        if (codexProposalMode && session.setCodexProposalMode) {
          await session.setCodexProposalMode(codexProposalMode);
        }
        if (codexPreferences && session.setCodexAppServerIdleTimeoutMinutes) {
          await session.setCodexAppServerIdleTimeoutMinutes(
            codexPreferences.codexAppServerIdleTimeoutMinutes,
          );
        }
        await applyAgentSessionCodexSpeed(session, effectiveModelConfig.speed);
        await session.setContextWindow?.(effectiveModelConfig.contextWindow);

        enqueuePortalEvent(
          createPortalEvent('portal.chat.event', {
            scope: 'standalone',
            projectLocalId: standaloneProjectId,
            projectId: standaloneProjectId,
            workEntryId: worktreeId,
            chatId,
            message: {
              messageId: userMessageId,
              chatId,
              role: 'user',
              status: 'complete',
              text,
              createdAtMs: Date.now(),
            },
          }),
        );
        if (req.startsNewTrackedChat) {
          await notifyCanonicalChatStarted(
            { projectId, worktreeId, chatId },
            userMessageId,
            watcherAcceptedAt,
            watcherContext,
          ).catch(() => undefined);
        }
        await assertCoworkChatRootPresent(projectId, worktreeId);
        const dispatchStartedAt = Date.now();
        try {
          turnRun.signal.throwIfAborted();
          reservePromptBindingSlot(
            { projectId, worktreeId, chatId },
            userMessageId,
          );
          turnRun.executeSync(() =>
            session.sendMessage(submittedText, {
              userMessageId,
              ...(effectiveExecutionHarness === 'opencode' &&
              !req.hiddenContext &&
              attachmentPaths &&
              attachmentPaths.length > 0
                ? {
                    attachments: {
                      baseDir: getCoworkManagedSubdir(cwd, 'attachments'),
                      paths: [...attachmentPaths],
                    },
                  }
                : {}),
              countsTowardSkillUsage:
                (validatedInitiationSource === 'user' ||
                  validatedInitiationSource === 'portal') &&
                !req.hiddenContext,
            }),
          );
          turnRun.accepted();
        } catch (error) {
          if (memory?.facts.length && memory.searchId) {
            memoryDeliveryTracker.ackDropped(
              memory.organizationExternalId,
              memory.searchId,
              'send_failed',
            );
          }
          throw error;
        }
        if (memory?.facts.length) {
          const disposed = session.isDisposed?.() === true;
          if (memory.searchId) {
            if (disposed)
              memoryDeliveryTracker.ackDropped(
                memory.organizationExternalId,
                memory.searchId,
                'turn_aborted',
              );
            else
              memoryDeliveryTracker.ackDelivered(
                memory.organizationExternalId,
                memory.searchId,
              );
          }
          if (!disposed) {
            const disclosure: Parameters<
              typeof persistOrgMemoryUsedForChat
            >[0] = {
              projectId,
              worktreeId,
              chatId,
              userMessageId,
              organizationExternalId: memory.organizationExternalId,
              ...(memory.searchId ? { searchId: memory.searchId } : {}),
              facts: memory.facts,
            };
            await persistOrgMemoryUsedForChat(disclosure).catch(
              (error: unknown) => {
                // Keep the turn alive if durable disclosure persistence
                // fails; the live renderer still receives the event below.
                logMainProcessError(
                  '[org-memory] Failed to persist memory-used metadata',
                  error,
                );
              },
            );
            const memoryUsedEvent: OrgMemoryUsedEventData = {
              type: ORG_MEMORY_USED_EVENT_TYPE,
              localChatId: chatId,
              localMessageId: userMessageId,
              organizationExternalId: memory.organizationExternalId,
              ...(memory.searchId ? { searchId: memory.searchId } : {}),
              facts: memory.facts,
            };
            sendChatEvent(
              getWindow(),
              projectId,
              worktreeId,
              chatId,
              memoryUsedEvent,
            );
          }
        }
        const acceptedData = {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: userMessageId,
          ...(pendingSystemInstructions?.length
            ? {
                canopy_consumed_pending_system_instruction_ids:
                  pendingSystemInstructions.map(
                    (instruction) => instruction.id,
                  ),
              }
            : {}),
        };
        await chatStateService.ingestProviderEvent({
          projectId,
          worktreeId,
          chatId,
          data: acceptedData,
          mutationId: `${chatId}:${userMessageId}:accepted`,
          providerType: runtimeProviderType,
          turnUserMessageId: userMessageId,
        });
        sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, {
          projectId,
          worktreeId,
          chatId,
          data: acceptedData,
        });
        await clearUsageLimitedChat(
          { projectId, worktreeId, chatId },
          { onlyIfDetectedBefore: dispatchStartedAt },
        );
      } catch (error) {
        coworkTurnRun?.abandon(error);
        throw error;
      } finally {
        memoryDeliveryTracker.noteDispatchExit();
        resourceGuard?.release();
      }
      const modelRoutingNotice = autoRoutingNotices.get(
        autoRoutingTurnKey(req),
      );
      autoRoutingNotices.delete(autoRoutingTurnKey(req));
      return modelRoutingNotice ? { modelRoutingNotice } : {};
    }
    const alreadyAccepted = await getChatStateService().hasMutation(
      { projectId, worktreeId },
      `${chatId}:${userMessageId}:accepted`,
    );
    if (alreadyAccepted) {
      await clearUsageLimitedChat({ projectId, worktreeId, chatId });
      return { disposition: 'already_accepted' };
    }
    // CAN-1814 PR 7. The send-time auth preflight (`lib/auth-preflight.ts`)
    // refuses a turn whose required dependency is already known-broken, and
    // it knows exactly WHICH dependencies and HOW each is reconnected. That
    // verdict reaches the renderer as a typed result rather than a rejection
    // because `ipcRenderer.invoke` rejects with a `message` string only:
    // thrown, the refusal arrives as prose the user cannot act on, and the
    // reconnect card that renders this exact shape never appears.
    //
    // Only a PROVEN auth dead end is translated -- `describeTurnAuthRefusal`
    // returns `null` for anything else, so validation errors, org-policy
    // blocks, and dispatch failures keep rejecting as before.
    //
    // KNOWN LIMIT: this covers the send the renderer is awaiting. A message
    // the host QUEUES behind a live turn is preflighted again when it drains
    // (`dispatchLocalWorktreeChatMessageNow`), and that refusal has no IPC
    // call to return through -- `ChatQueueService.drain` swallows it, as it
    // does every other drain-time dispatch failure, so no card renders for it.
    //
    // The row itself is NOT lost: `dispatchDequeued` restores a row refused
    // by the preflight and republishes the queue with it, so the user's typed
    // follow-up stays visible and drains once the dependency is reconnected.
    // An earlier revision of this comment claimed 'nothing durable is
    // written', which was wrong -- the row had been durably enqueued by
    // `enqueueDurably` and was then durably deleted (CAN-1814 review).
    // Captured before the dispatch so the clear below can tell the entry this
    // send is resuming apart from a NEW one the dispatched turn records by
    // re-hitting the usage limit (which it can do before this line runs).
    const dispatchStartedAt = Date.now();
    try {
      await dispatchLocalWorktreeChatMessage(req);
    } catch (error) {
      const refusedAuthDependencies = describeTurnAuthRefusal(error);
      if (!refusedAuthDependencies) throw error;
      return { refusedAuthDependencies };
    }
    // Deliberately AFTER the refusal check: a refused send never ran, so the
    // chat's usage-limit registry entry must survive it.
    await clearUsageLimitedChat(
      { projectId, worktreeId, chatId },
      { onlyIfDetectedBefore: dispatchStartedAt },
    );
    const modelRoutingNotice = autoRoutingNotices.get(autoRoutingTurnKey(req));
    autoRoutingNotices.delete(autoRoutingTurnKey(req));
    return {
      disposition: 'dispatched',
      ...(modelRoutingNotice ? { modelRoutingNotice } : {}),
    };
  };
  const dispatchChatMessageNow = withChatScopeActivity(
    (event, req, authorization) =>
      dispatchChatMessageNowBody(event, req, authorization, false),
  );
  // Only the main-owned special-native dispatcher reaches this entry. The
  // caller revalidates captured sender provenance before dispatch; renderer
  // and Portal paths use the guarded public wrapper above.
  const dispatchMainOwnedAgentChatMessageNow = withChatScopeActivity(
    (event, req, authorization) =>
      dispatchChatMessageNowBody(event, req, authorization, true),
    { allowMainOwnedAgentInput: true },
  );
  setSpecialNativeChatDispatcher(
    async (request, authorization): Promise<void> => {
      const result = await dispatchMainOwnedAgentChatMessageNow(
        undefined,
        request,
        authorization,
      );
      if (result.modelRoutingNotice) {
        autoRoutingNotices.set(
          autoRoutingTurnKey(request),
          result.modelRoutingNotice,
        );
      }
      if (result.refusedAuthDependencies)
        throw new TurnAuthPreflightBlockedError(
          result.refusedAuthDependencies.failures,
        );
    },
    {
      getMainWindow: accessors.getMainWindow,
      getAppAdvisorWindow: accessors.getAppAdvisorWindow,
      openAppAdvisorWindow: accessors.openAppAdvisorWindow,
      ensureAppAdvisorWindow: accessors.ensureAppAdvisorWindow,
    },
  );
  registerIpcHandler<[ChatSendMessageRequest], ChatSendMessageResult>(
    IPC_CHANNELS.chatSendMessage,
    withChatScopeActivity(async (event, req) => {
      assertUntrustedChatInput(req);
      if (
        req.watcherFired?.kind === DELEGATION_NOTICE_KIND &&
        req.watcherDeliveryId === undefined
      ) {
        throw new Error(
          'Delegation completion notices require a validated watcher delivery.',
        );
      }
      if (req.watcherDeliveryId !== undefined)
        validateId(req.watcherDeliveryId, 'watcherDeliveryId');
      // Dispatch rechecks authority at later awaits; every recheck can hold.
      try {
        if (req.watcherFired && req.watcherDeliveryId)
          await assertWatcherDeliveryIngress(req);
        // This handler receives composer sends. Internal services must opt in
        // explicitly so agent-authored messages cannot inherit user eligibility.
        // `agentSent` is main-owned provenance from a validated Portal origin
        // or an agent send, and `admittedApproval` what main admitted an
        // agent send against; a renderer can never supply either.
        const {
          resumesInterruptedTurn: _resumes,
          autoResume: _autoResume,
          agentSent: _agentSent,
          admittedApproval: _admitted,
          ...composerReq
        } = req;
        void _resumes;
        void _autoResume;
        void _agentSent;
        void _admitted;
        req = {
          ...composerReq,
          initiationSource: isUsageInitiationSource(req.initiationSource)
            ? req.initiationSource
            : 'user',
        };
        getStoppedTurnResumeService().invalidateForNewTurn(
          req,
          req.userMessageId,
        );
        // Renderer tools for this chat run where the user sent it from.
        validateId(req.chatId, 'chatId');
        noteChatDriver(
          req.chatId,
          event ? resolveRemoteBridgeSender(event.sender) : null,
        );
        if (
          isCoworkWorkspace(req.projectId) ||
          req.projectId === APP_ADVISOR_PROJECT_ID ||
          req.projectId === PIPELINE_EDITOR_PROJECT_ID
        ) {
          validateId(req.projectId, 'projectId');
          validateId(req.worktreeId, 'worktreeId');
          validateId(req.chatId, 'chatId');
          validateId(req.userMessageId, 'userMessageId');
          const alreadyAccepted = await getChatStateService().hasMutation(
            req,
            `${req.chatId}:${req.userMessageId}:accepted`,
          );
          if (alreadyAccepted) return { disposition: 'already_accepted' };
          await dispatchLocalWorktreeChatMessage({
            ...req,
            ...(req.projectId === PIPELINE_EDITOR_PROJECT_ID
              ? { assistantMode: 'pipeline-editor' as const }
              : {}),
          });
          const modelRoutingNotice = autoRoutingNotices.get(
            autoRoutingTurnKey(req),
          );
          autoRoutingNotices.delete(autoRoutingTurnKey(req));
          return {
            disposition: 'dispatched',
            ...(modelRoutingNotice ? { modelRoutingNotice } : {}),
          };
        }
        return await dispatchChatMessageNow(event, req);
      } catch (error) {
        if (error instanceof WatcherDeliveryHeldError)
          return {
            watcherDeliveryHeld: {
              outcome: error.outcome,
              reason: error.reason,
            },
          };
        throw error;
      }
    }),
  );

  // The composer's usage popover asks for the live session's context
  // breakdown as it opens; chats without a live Claude session answer null.
  registerIpcHandler<
    [ChatContextUsageRequest],
    ChatContextUsageBreakdown | null
  >(IPC_CHANNELS.chatGetContextUsage, async (_event, req) => {
    validateId(req.projectId, 'projectId');
    validateId(req.worktreeId, 'worktreeId');
    validateId(req.chatId, 'chatId');
    return getContextUsageForSession(req.projectId, req.worktreeId, req.chatId);
  });

  registerIpcHandler<[ChatCancelIpcRequest], ChatCancelResult>(
    IPC_CHANNELS.chatCancel,
    async (_event, req) => {
      if (req.expectedUserMessageId !== undefined) {
        // Only that turn, never a newer one (CAN-5985).
        return stopExactChatTurn(req, req.expectedUserMessageId, {
          validateId,
          isCoworkWorkspace,
          stopActiveTurn: (request, expected) =>
            stopChatForUser(request, getWindow, expected),
          cancelWorktreeTurn: cancelWorktreeChatTurn,
        });
      }
      const result = await stopChatForUser(req, getWindow);
      return result ?? {};
    },
  );

  registerIpcHandler<
    [ChatResumeStoppedTurnRequest],
    ChatResumeStoppedTurnResult
  >(IPC_CHANNELS.chatResumeStoppedTurn, async (_event, req) => {
    assertWritableScope(req.projectId);
    validateId(req.projectId, 'projectId');
    validateId(req.worktreeId, 'worktreeId');
    validateId(req.chatId, 'chatId');
    validateId(req.userMessageId, 'userMessageId');
    validateOptionalRepoId(req.selectedRepoId, 'selectedRepoId');
    const resumeService = getStoppedTurnResumeService();
    return getChatStateService().runWithScopeActivity(
      { projectId: req.projectId, worktreeId: req.worktreeId },
      () =>
        resumeService.resume(req, async (attemptId, isCurrent) => {
          // Resume from main-owned canonical metadata. The renderer may have
          // missed the provider session-init update that made this offer safe,
          // and its stale snapshot must not turn a resume into a fresh chat.
          const canonicalDispatch = await buildExistingTabDispatchOptions(
            req.projectId,
            req.worktreeId,
            req.chatId,
          );
          // Resume is an ordinary admission: its D precedes every prompt and
          // start effect. A blocked admission fails retryably below.
          const admission = await getChatQueueService().admitDirectDispatch(
            req,
            req.userMessageId,
          );
          if (!admission)
            throw new Error('Another turn owns this chat; Resume must wait.');
          // A newer turn may supersede this resume while canonical metadata is
          // loading. No await follows this check before the queue reservation.
          if (
            !isCurrent() ||
            !resumeService.markDispatchStarted(
              req,
              req.userMessageId,
              attemptId,
            )
          ) {
            admission.release();
            return false;
          }
          try {
            await resumeStoppedWorktreeChatTurn(
              {
                projectId: req.projectId,
                worktreeId: req.worktreeId,
                chatId: req.chatId,
                userMessageId: req.userMessageId,
                ...canonicalDispatch,
              },
              attemptId,
              {
                getWindow,
                ...(admission.authorization
                  ? {
                      queueDispatch: { authorization: admission.authorization },
                    }
                  : {}),
              },
            );
          } catch (error) {
            admission.release();
            throw error;
          }
          return true;
        }),
    );
  });

  registerIpcHandler<[ChatCancelRequest], void>(
    IPC_CHANNELS.chatDestroySession,
    async (_event, req) => {
      assertWritableScope(req.projectId);
      cancelTransientRetryForChat(req, 'destroy-session');
      deferredToolsReloadCoordinator.cancelActiveReload(
        req,
        'Deferred-tools reload was cancelled because the chat was closed.',
      );
      deferredToolsReloadCoordinator.unregisterResumeHandler(req);
      clearLiveApprovalMode(req.projectId, req.worktreeId, req.chatId);
      await destroySession(req.projectId, req.worktreeId, req.chatId);
      // A destroyed session emits no terminal event; release the host
      // queue's turn gate so queued rows drain into a fresh session.
      getChatQueueService().onTurnTerminal(req, 'cancelled');
    },
  );

  registerIpcHandler<[ChatQueueEditRequest], void>(
    IPC_CHANNELS.chatQueueEdit,
    async (_event, request) => {
      assertUntrustedChatInput(request);
      assertWritableScope(request.projectId);
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.chatId, 'chatId');
      validateId(request.entryId, 'entryId');
      await projectQueueEdit(request, dispatchCanonicalChatCommand);
    },
  );

  registerIpcHandler<[ChatQueueEntryRequest], void>(
    IPC_CHANNELS.chatQueueCancel,
    async (_event, request) => {
      assertWritableScope(request.projectId);
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.chatId, 'chatId');
      validateId(request.entryId, 'entryId');
      await projectQueueCancel(request, dispatchCanonicalChatCommand);
    },
  );

  registerIpcHandler<[ChatQueueEntryRequest], void>(
    IPC_CHANNELS.chatQueueForce,
    async (_event, request) => {
      assertWritableScope(request.projectId);
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.chatId, 'chatId');
      validateId(request.entryId, 'entryId');
      await projectQueueForce(request, dispatchCanonicalChatCommand);
    },
  );

  registerIpcHandler<[ChatQueueSetEditLockRequest], void>(
    IPC_CHANNELS.chatQueueSetEditLock,
    async (_event, request) => {
      assertWritableScope(request.projectId);
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.chatId, 'chatId');
      validateId(request.entryId, 'entryId');
      await projectQueueEditLock(request, dispatchCanonicalChatCommand);
    },
  );

  registerIpcHandler<[ChatQueueSnapshotRequest], ChatQueueUpdatedEvent[]>(
    IPC_CHANNELS.chatQueueGetSnapshot,
    (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return getChatQueueService().getWorktreeSnapshots(
        request.projectId,
        request.worktreeId,
      );
    },
  );

  registerIpcHandler<[ChatCancelRequest], void>(
    IPC_CHANNELS.chatTransientRetryCancel,
    (_event, req) => {
      validateId(req.projectId, 'projectId');
      validateId(req.worktreeId, 'worktreeId');
      validateId(req.chatId, 'chatId');
      cancelTransientRetryForChat(req, 'banner-dismiss');
    },
  );

  registerIpcHandler<[], ReturnType<typeof getTransientRetryStateSnapshot>>(
    IPC_CHANNELS.chatTransientRetryGetSnapshot,
    () => getTransientRetryStateSnapshot(),
  );

  registerIpcHandler<
    [PreparePlanFileSystemInstructionRequest],
    PreparePlanFileSystemInstructionResponse
  >(IPC_CHANNELS.chatPreparePlanFileSystemInstruction, async (_event, req) => {
    validateId(req.planId, 'planId');
    validateId(req.projectId, 'projectId');
    validateId(req.worktreeId, 'worktreeId');
    if (
      req.purpose !== undefined &&
      !PLAN_FILE_INSTRUCTION_PURPOSES.has(req.purpose)
    ) {
      throw new Error('Invalid purpose for plan file system instruction.');
    }
    if (
      req.viewedRevisionNumber !== undefined &&
      (!Number.isSafeInteger(req.viewedRevisionNumber) ||
        req.viewedRevisionNumber <= 0)
    ) {
      throw new Error('viewedRevisionNumber must be a positive safe integer.');
    }
    const instruction = await buildPlanFileSystemInstruction(req);
    return instruction ? { instruction } : {};
  });

  registerIpcHandler<[ChatResetToPointRequest], ChatResetToPointResponse>(
    IPC_CHANNELS.chatResetToPoint,
    async (_event, req) => {
      assertWritableScope(req.projectId);
      validateId(req.projectId, 'projectId');
      validateId(req.worktreeId, 'worktreeId');
      validateId(req.chatId, 'chatId');
      validateId(req.userMessageId, 'userMessageId');
      cancelTransientRetryForChat(
        {
          projectId: req.projectId,
          worktreeId: req.worktreeId,
          chatId: req.chatId,
        },
        'reset-to-point',
      );
      const tab = await resetChatToPoint({
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        chatId: req.chatId,
        userMessageId: req.userMessageId,
      });
      return { tab };
    },
  );

  registerIpcHandler<
    [CancelQueuedHookChatRequest],
    CancelQueuedHookChatResponse
  >(IPC_CHANNELS.chatCancelQueuedHookChat, (_event, req) => {
    validateId(req.queueId, 'queueId');
    return cancelQueuedHookChat(req.queueId);
  });

  registerIpcHandler<[ForceQueuedHookChatRequest], ForceQueuedHookChatResponse>(
    IPC_CHANNELS.chatForceQueuedHookChat,
    (_event, req) => {
      validateId(req.queueId, 'queueId');
      return forceQueuedHookChat(req.queueId);
    },
  );

  registerIpcHandler<
    [SetQueuedHookChatInterfaceModeRequest],
    SetQueuedHookChatInterfaceModeResponse
  >(IPC_CHANNELS.chatSetQueuedHookChatInterfaceMode, (_event, req) => {
    validateId(req.projectId, 'projectId');
    validateId(req.worktreeId, 'worktreeId');
    validateId(req.chatId, 'chatId');
    assertWritableScope(req.projectId);
    if (
      req.interfaceMode !== 'canopy' &&
      req.interfaceMode !== 'claude-code' &&
      req.interfaceMode !== 'auto'
    ) {
      throw new Error('Unsupported interface mode.');
    }
    return { updated: updateQueuedHookChatInterfaceMode(req) };
  });

  registerIpcHandler<[ChatLoadTabsRequest], ChatActiveSessions>(
    IPC_CHANNELS.chatActiveSessions,
    (_event, req) => {
      return {
        activeChatIds: getActiveChatIds(req.projectId, req.worktreeId),
        sessions: getActiveSessionInfos(req.projectId, req.worktreeId),
      };
    },
  );

  registerIpcHandler<
    [GenerateHandoffSummaryRequest],
    GenerateHandoffSummaryResponse
  >(IPC_CHANNELS.chatGenerateHandoffSummary, async (_event, req) => {
    validateId(req.projectId, 'projectId');
    validateId(req.worktreeId, 'worktreeId');
    if (req.chatId !== undefined) {
      validateId(req.chatId, 'chatId');
    }
    let workOwner: ReturnType<typeof resolveSessionWorkOwner> | undefined;
    if (req.chatId) {
      const sourceSession = {
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        chatId: req.chatId,
      };
      captureSessionWorkOwner(sourceSession);
      workOwner = resolveSessionWorkOwner(sourceSession);
    }
    const preferences = await readPreferencesFile();
    const model =
      preferences.handoffSummaryModel ?? DEFAULT_HANDOFF_SUMMARY_MODEL;
    if (!getModelSource(model)) {
      throw new Error(
        `Choose a supported conversation handoff model in Settings. "${model}" is unavailable for handoffs.`,
      );
    }
    const thinkingLevel = preferences.handoffSummaryThinkingLevel ?? 'off';
    // Gateway policy can route a Claude selection onto Codex. Capture its
    // defaults now; the resolved harness decides whether to use them.
    const modelConfig = resolveProviderModelConfig(
      'codex',
      { thinkingLevel },
      preferences.providerModelConfigDefaults,
    );
    const cwd = resolveWorktreeCwd(req.projectId, req.worktreeId);
    const kind = readHandoffSummaryKind(req.kind);
    let conversationText = req.conversationText;
    if (kind === 'continue-on-other-harness' && req.chatId) {
      conversationText = await getChatStateService().consumeTranscript(
        { projectId: req.projectId, worktreeId: req.worktreeId },
        req.chatId,
        false,
        buildHandoffSummaryInputFromTranscript,
      );
    }
    const taskKey = `helper:handoff-summary:${req.projectId}/${req.worktreeId}/${req.chatId ?? 'unspecified'}:${Date.now()}`;
    startObservedHelperTask({
      taskKey,
      eventType: 'chat_handoff_summary',
      label: handoffSummaryAuditLabel(kind),
      model,
      modelConfig,
      auditContext: {
        projectId: req.projectId,
        worktreeId: req.worktreeId,
      },
      chatId: req.chatId,
      linkTarget: buildHandoffSummaryLinkTarget(req),
    });
    try {
      const result = await generateHandoffSummary(conversationText, {
        model,
        thinkingLevel,
        modelConfig,
        cwd,
        workspaceId: req.projectId,
        ...(workOwner ? { workOwner: await workOwner } : {}),
        observabilityTaskKey: taskKey,
      });
      getExecutionObservabilityIngest().finalizeObservedTask(
        taskKey,
        'success',
        undefined,
        result.usage,
      );
      return { summary: result.text };
    } catch (error) {
      // A model-policy refusal is finalized inside the helper before throwing.
      // Finalization is idempotent, so this apparent second finalize is a no-op
      // for that path and remains necessary for all other failures.
      getExecutionObservabilityIngest().finalizeObservedTask(
        taskKey,
        'failure',
        error instanceof Error ? error.message : String(error),
        getStructuredHelperQueryErrorUsage(error),
      );
      throw error;
    }
  });

  registerIpcHandler<[ForkCodexThreadRequest], ForkCodexThreadResponse>(
    IPC_CHANNELS.chatForkCodexThread,
    async (_event, req) => {
      assertWritableScope(req.projectId);
      validateId(req.projectId, 'projectId');
      validateId(req.worktreeId, 'worktreeId');
      validateId(req.chatId, 'chatId');
      if (req.sourceProjectId) {
        validateId(req.sourceProjectId, 'sourceProjectId');
      }
      if (req.sourceWorktreeId) {
        validateId(req.sourceWorktreeId, 'sourceWorktreeId');
      }
      if (req.sourceChatId) {
        validateId(req.sourceChatId, 'sourceChatId');
      }
      validateOptionalRepoId(req.selectedRepoId, 'selectedRepoId');
      if (!req.sourceThreadId || typeof req.sourceThreadId !== 'string') {
        throw new Error('sourceThreadId is required');
      }
      const isAppAdvisor = req.projectId === APP_ADVISOR_PROJECT_ID;
      const cwd = isAppAdvisor
        ? resolveWorktreeCwd(req.projectId, req.worktreeId)
        : resolveWorktreeCwd(req.projectId, req.worktreeId, req.selectedRepoId);
      const preferences = await readPreferencesFile().catch(() => null);
      const isStandalone = isCoworkWorkspace(req.projectId);
      const codexMultiAgentEnabled = isAppAdvisor
        ? preferences?.codexMultiAgentAppAdvisorEnabled
        : preferences?.[
            isStandalone
              ? 'codexMultiAgentStandaloneChatsEnabled'
              : 'codexMultiAgentWorktreeChatsEnabled'
          ];
      const modelConfig = buildModelConfigInput(req.modelConfig, {
        codexFastModeEnabled: req.codexFastModeEnabled,
      });
      const forkedThreadId = await forkCodexThreadByIdViaOneShot({
        cwd,
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        chatId: req.chatId,
        sourceThreadId: req.sourceThreadId,
        ...(req.sourceProjectId
          ? { sourceProjectId: req.sourceProjectId }
          : {}),
        ...(req.sourceWorktreeId
          ? { sourceWorktreeId: req.sourceWorktreeId }
          : {}),
        ...(req.sourceChatId ? { sourceChatId: req.sourceChatId } : {}),
        ...(req.pluginSelections
          ? { pluginSelections: req.pluginSelections }
          : {}),
        codexMultiAgentEnabled,
        codexMaxConcurrentSubagents: preferences?.codexMaxConcurrentSubagents,
        modelConfig: resolveProviderModelConfig(
          'codex',
          { modelConfig },
          preferences?.providerModelConfigDefaults,
        ),
        onForked: async (threadId) => {
          await commitCanonicalTabSettings(
            req.projectId,
            req.worktreeId,
            req.chatId,
            { sdkSessionId: threadId },
            { requireExisting: true },
          );
        },
      });
      return { forkedThreadId };
    },
  );

  trackSettledChatQuestions();
  registerIpcHandler<[McpAnswerUserRequest], McpAnswerUserResponse>(
    IPC_CHANNELS.mcpAnswerUser,
    (_event, req) => answerChatQuestionFromRenderer(req.requestId, req.answers),
  );

  registerIpcHandler<[McpDismissUserRequest], void>(
    IPC_CHANNELS.mcpDismissUser,
    async (_event, req) => {
      const outcome = await respondToLiveChatQuestion(req.requestId, {
        kind: 'dismiss',
      });
      if (outcome.status !== 'applied' && outcome.status !== 'already_settled')
        getDesktopChatWaits().cancel(req.requestId, { reason: 'cancelled' });
    },
  );

  registerIpcHandler<[PlanExitApproveRequest], void>(
    IPC_CHANNELS.planExitApprove,
    (_event, req) => {
      approvePlanExit(req.requestId);
    },
  );

  registerIpcHandler<[PlanExitDenyRequest], void>(
    IPC_CHANNELS.planExitDeny,
    (_event, req) => {
      denyPlanExit(req.requestId);
    },
  );

  registerIpcHandler<[PlanModeToggleRequest], void>(
    IPC_CHANNELS.planModeToggle,
    async (_event, req) => {
      assertWritableScope(req.projectId);
      await updateChatSettingsThroughCore(req, { planMode: req.enabled });
    },
  );

  setApprovalModeSetter(async (req) => {
    const approvalDefaultIntent = beginApprovalDefaultIntentForRequest(req);
    const liveMode = getLiveApprovalMode(
      req.projectId,
      req.worktreeId,
      req.chatId,
    );
    const pendingMode = getPendingApprovalMode(
      req.projectId,
      req.worktreeId,
      req.chatId,
    );
    const currentAuthorityMode = liveMode ?? req.previousMode;
    const restrictsCurrentAuthority =
      currentAuthorityMode !== undefined &&
      isApprovalModeDowngrade(currentAuthorityMode, req.mode);
    const widensCurrentAuthority =
      currentAuthorityMode !== undefined &&
      isApprovalModeDowngrade(req.mode, currentAuthorityMode);
    const cancelsPendingEscalation =
      pendingMode !== undefined &&
      isApprovalModeDowngrade(pendingMode, req.mode);
    const isDowngrade =
      restrictsCurrentAuthority ||
      (cancelsPendingEscalation && !widensCurrentAuthority);
    const transitionGeneration = beginApprovalModeTransition(
      req.projectId,
      req.worktreeId,
      req.chatId,
      req.mode,
    );

    if (isDowngrade) {
      // Revocation must not wait behind transcript copying or another durable
      // approval operation. Restrict the live registry and active runtimes
      // first, then reserve the serialization slot while those updates settle
      // and the canonical write commits. Failed persistence remains fail-closed
      // in memory and in every runtime we could reach.
      setLiveApprovalMode(req.projectId, req.worktreeId, req.chatId, req.mode);
      const session = getSession(req.projectId, req.worktreeId, req.chatId);
      const revokesFullAccess =
        req.mode !== 'full-access' &&
        (liveMode === 'full-access' ||
          pendingMode === 'full-access' ||
          req.previousMode === 'full-access');
      const runtimeUpdates = Promise.allSettled([
        session
          ? revokesFullAccess
            ? // Delegates follow the live approval mode without this session.
              destroySession(req.projectId, req.worktreeId, req.chatId, {
                retainDelegations: true,
              })
            : session.setApprovalMode(req.mode)
          : Promise.resolve(),
        Promise.resolve().then(() =>
          updateQueuedHookChatApprovalMode({
            projectId: req.projectId,
            worktreeId: req.worktreeId,
            chatId: req.chatId,
            mode: req.mode,
          }),
        ),
        getClaudeTerminalSessionService().setApprovalMode(
          req.projectId,
          req.worktreeId,
          req.chatId,
          req.mode,
        ),
      ]);
      return withApprovalModeOperation(
        req.projectId,
        req.worktreeId,
        req.chatId,
        async () => {
          try {
            const settledRuntimeUpdates = await runtimeUpdates;
            // A failed commit rejects the handler with live and runtimes
            // already restricted; a restart restores the saved, wider mode.
            // Accepted (CAN-4469 O6): the user was told the change failed.
            await commitCanonicalApprovalMode(
              req.projectId,
              req.worktreeId,
              req.chatId,
              req.mode,
            );
            if (session && !isCoworkWorkspace(req.projectId)) {
              markSessionForNextTurnRecreation(
                req.projectId,
                req.worktreeId,
                req.chatId,
                'approval',
              );
            }
            const failedRuntimeUpdate = settledRuntimeUpdates.find(
              (result): result is PromiseRejectedResult =>
                result.status === 'rejected',
            );
            if (failedRuntimeUpdate) {
              if (failedRuntimeUpdate.reason instanceof Error) {
                throw failedRuntimeUpdate.reason;
              }
              const normalizedError = new Error(
                String(failedRuntimeUpdate.reason),
              );
              Object.defineProperty(normalizedError, 'cause', {
                value: failedRuntimeUpdate.reason,
                enumerable: false,
              });
              throw normalizedError;
            }
            if (
              isApprovalModeTransitionCurrent(
                req.projectId,
                req.worktreeId,
                req.chatId,
                transitionGeneration,
              )
            ) {
              // The restrictive transition is canonical and all reachable
              // runtimes accepted it. Only the latest transition may publish
              // the sticky surface default.
              await rememberApprovalDefaultForSurface(
                req,
                approvalDefaultIntent,
              );
            }
          } finally {
            endApprovalModeTransition(
              req.projectId,
              req.worktreeId,
              req.chatId,
              transitionGeneration,
            );
          }
        },
      );
    }

    return withApprovalModeOperation(
      req.projectId,
      req.worktreeId,
      req.chatId,
      async () => {
        if (
          !isApprovalModeTransitionCurrent(
            req.projectId,
            req.worktreeId,
            req.chatId,
            transitionGeneration,
          )
        ) {
          return;
        }
        const serializedPreviousMode =
          getLiveApprovalMode(req.projectId, req.worktreeId, req.chatId) ??
          req.previousMode;
        const isEscalation =
          serializedPreviousMode !== undefined &&
          isApprovalModeDowngrade(req.mode, serializedPreviousMode);

        // A more permissive mode must be durable before any live process can use
        // it. Restrictive transitions are handled above before entering the
        // durable-operation queue.
        await commitCanonicalApprovalMode(
          req.projectId,
          req.worktreeId,
          req.chatId,
          req.mode,
        );
        const session = getSession(req.projectId, req.worktreeId, req.chatId);
        let sessionModeUpdated = false;
        const reapplyCurrentRestriction = async (): Promise<void> => {
          if (!session) return;
          const currentRestriction = clampToLiveApprovalMode(
            req.projectId,
            req.worktreeId,
            req.chatId,
            getPendingApprovalMode(req.projectId, req.worktreeId, req.chatId),
          );
          if (currentRestriction === undefined) return;
          if (
            req.mode === 'full-access' &&
            currentRestriction !== 'full-access'
          ) {
            await destroySession(req.projectId, req.worktreeId, req.chatId, {
              retainDelegations: true,
            });
            return;
          }
          await session.setApprovalMode(currentRestriction);
        };
        try {
          if (session) {
            if (
              !isApprovalModeTransitionCurrent(
                req.projectId,
                req.worktreeId,
                req.chatId,
                transitionGeneration,
              )
            ) {
              return;
            }
            await session.setApprovalMode(req.mode);
            sessionModeUpdated = true;
          }
          if (
            !isApprovalModeTransitionCurrent(
              req.projectId,
              req.worktreeId,
              req.chatId,
              transitionGeneration,
            )
          ) {
            if (sessionModeUpdated) {
              await reapplyCurrentRestriction();
            }
            return;
          }
          updateQueuedHookChatApprovalMode({
            projectId: req.projectId,
            worktreeId: req.worktreeId,
            chatId: req.chatId,
            mode: req.mode,
          });
          setLiveApprovalMode(
            req.projectId,
            req.worktreeId,
            req.chatId,
            req.mode,
          );
          await getClaudeTerminalSessionService().setApprovalMode(
            req.projectId,
            req.worktreeId,
            req.chatId,
            req.mode,
          );
        } catch (error) {
          if (
            !isApprovalModeTransitionCurrent(
              req.projectId,
              req.worktreeId,
              req.chatId,
              transitionGeneration,
            )
          ) {
            await reapplyCurrentRestriction();
            throw error;
          }
          if (isEscalation && serializedPreviousMode !== undefined) {
            const rollbackMode =
              clampToLiveApprovalMode(
                req.projectId,
                req.worktreeId,
                req.chatId,
                serializedPreviousMode,
              ) ?? serializedPreviousMode;
            try {
              updateQueuedHookChatApprovalMode({
                projectId: req.projectId,
                worktreeId: req.worktreeId,
                chatId: req.chatId,
                mode: rollbackMode,
              });
            } catch {
              // Continue restoring the remaining approval-mode owners.
            }
            setLiveApprovalMode(
              req.projectId,
              req.worktreeId,
              req.chatId,
              rollbackMode,
            );
            // A failed rollback commit leaves the saved tab escalated, and a
            // restart restores that mode. Accepted (CAN-4469 O6): the handler
            // still rejects below, so the user is told the change failed.
            await Promise.allSettled([
              ...(session && sessionModeUpdated
                ? [session.setApprovalMode(rollbackMode)]
                : []),
              getClaudeTerminalSessionService().setApprovalMode(
                req.projectId,
                req.worktreeId,
                req.chatId,
                rollbackMode,
              ),
              commitCanonicalApprovalMode(
                req.projectId,
                req.worktreeId,
                req.chatId,
                rollbackMode,
              ),
            ]);
          }
          throw error;
        }
        if (
          !isApprovalModeTransitionCurrent(
            req.projectId,
            req.worktreeId,
            req.chatId,
            transitionGeneration,
          )
        ) {
          if (sessionModeUpdated) {
            await reapplyCurrentRestriction();
          }
          return;
        }
        // Canonical and runtime owners now agree, and this transition still
        // owns authority, and the try/catch holding the escalation rollback has
        // exited — no rollback path remains reachable. That is what makes this
        // the one safe place to let a widened mode act on a prompt already on
        // screen (CAN-3083): the setter itself must stay inert, because two of
        // its callers restore the previous mode when applying it fails, and an
        // auto-approval taken inside the setter would have granted authority
        // the system then concluded it could not grant — after the tool ran.
        //
        // Guarded so it can never throw out of `approvals.setMode`: a rejection
        // would make the renderer skip `applyRendererMode` and desync the UI
        // from a mode that *is* canonical. The fallback on failure is "the card
        // stays up", which is the safe state.
        if (isEscalation) {
          await reevaluatePendingApprovalsForChat(
            req.projectId,
            req.worktreeId,
            req.chatId,
            req.mode,
            // Every runtime owner above has already had `setMode(req.mode)`
            // applied, so the handles can no longer see what the chat was in
            // before. Carry it, or the `previousMode` on the event and on the
            // transcript block can never be populated.
            serializedPreviousMode,
          ).catch(() => undefined);
        }
        // Remember the default before releasing the per-chat operation
        // so a later transition's sticky write is ordered after this one.
        await rememberApprovalDefaultForSurface(req, approvalDefaultIntent);
        if (!session) {
          return;
        }
        if (!isCoworkWorkspace(req.projectId)) {
          markSessionForNextTurnRecreation(
            req.projectId,
            req.worktreeId,
            req.chatId,
            'approval',
          );
        }
        endApprovalModeTransition(
          req.projectId,
          req.worktreeId,
          req.chatId,
          transitionGeneration,
        );
      },
    ).finally(() => {
      endApprovalModeTransition(
        req.projectId,
        req.worktreeId,
        req.chatId,
        transitionGeneration,
      );
    });
  });

  registerIpcHandler<[CodexFastModeToggleRequest], void>(
    IPC_CHANNELS.chatCodexFastModeToggle,
    async (_event, req) => {
      assertWritableScope(req.projectId);
      validateId(req.projectId, 'projectId');
      validateId(req.worktreeId, 'worktreeId');
      validateId(req.chatId, 'chatId');
      if (typeof req.enabled !== 'boolean') {
        throw new Error('Codex fast mode enabled must be a boolean');
      }
      if (req.speed !== undefined && !isCodexSpeed(req.speed)) {
        throw new Error('Codex speed is unsupported');
      }
      const speed = req.speed ?? codexSpeedFromFastMode(req.enabled);
      if (req.enabled !== codexSpeedFastMode(speed)) {
        throw new Error('Codex fast mode enabled contradicts the speed');
      }
      await updateChatSettingsThroughCore(req, {
        modelConfig: { speed, fastMode: codexSpeedFastMode(speed) },
      });
    },
  );

  registerIpcHandler<[ThinkingLevelToggleRequest], void>(
    IPC_CHANNELS.thinkingLevelToggle,
    async (_event, req) => {
      assertWritableScope(req.projectId);
      await updateChatSettingsThroughCore(req, {
        modelConfig: { thinkingLevel: req.level },
      });
    },
  );

  registerIpcHandler<[ModelChangeRequest], boolean>(
    IPC_CHANNELS.chatModelChange,
    async (_event, req) => changeChatModel(req, getWindow),
  );

  registerIpcHandler<
    [ChatUpdatePluginsRequest],
    Promise<ChatUpdatePluginsResponse>
  >(IPC_CHANNELS.chatUpdatePlugins, (_event, req) =>
    applyChatPluginSelectionsUpdate(req),
  );

  registerIpcHandler<
    [DeferredToolsReloadBeginRequest],
    Promise<DeferredToolsReloadAck>
  >(IPC_CHANNELS.chatDeferredToolsReloadBegin, (_event, req) => {
    assertWritableScope(req.scope.projectId);
    validateId(req.scope.projectId, 'projectId');
    validateId(req.scope.worktreeId, 'worktreeId');
    validateId(req.scope.chatId, 'chatId');
    return deferredToolsReloadCoordinator.begin(req);
  });

  registerIpcHandler<
    [DeferredToolsReloadFinishRequest],
    DeferredToolsReloadAck
  >(IPC_CHANNELS.chatDeferredToolsReloadFinish, (_event, req) => {
    assertWritableScope(req.scope.projectId);
    validateId(req.scope.projectId, 'projectId');
    validateId(req.scope.worktreeId, 'worktreeId');
    validateId(req.scope.chatId, 'chatId');
    return deferredToolsReloadCoordinator.finish(req);
  });

  registerIpcHandler<
    [DeferredToolsReloadCancelRequest],
    DeferredToolsReloadAck
  >(IPC_CHANNELS.chatDeferredToolsReloadCancel, (_event, req) => {
    assertWritableScope(req.scope.projectId);
    validateId(req.scope.projectId, 'projectId');
    validateId(req.scope.worktreeId, 'worktreeId');
    validateId(req.scope.chatId, 'chatId');
    return deferredToolsReloadCoordinator.cancel(req);
  });
}
