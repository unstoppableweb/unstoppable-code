import { isPlanFileWrite } from '@canopy/protocol/plan-tool-input';
import { latchFirstTaskSubmitted } from '../notifications/campaigns/activation-signals';
import { requestAppAdvisorPresentation } from '../app-advisor/advisor-presentation';
import {
  readAutoResumeMetadata,
  type AutoResumeMetadata,
} from '@canopy/protocol/portal';
import { hasChatContinuationSession } from '@canopy/desktop-shared/lib/chat-model-selection';
import { collectTurnFiles } from '@canopy/desktop-shared/lib/turn-files';
import {
  mergeToolResults,
  reorderMessagesForDisplay,
} from '@canopy/desktop-shared/lib/message-transforms';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import {
  AgentSenderContextError,
  revalidateAgentSenderRequest,
  withAgentSenderAuthority,
} from '../agent-messaging/sender-context';
import {
  getApprovalSettingsRevision,
  getChatApprovalStateRevision,
} from '../approvals/rule-revisions';
import {
  hasPendingApprovalForChat,
  subscribePendingApprovalChanges,
} from '../approvals/pending-approvals';
import {
  stageTerminalPresentationTurn,
  resolvePresentationSource,
  cancelTerminalPresentationTurn,
  forgetPresentationChat,
  presentationChatKey,
} from '../canopy-tools/presentation-state';
import { browserHandoffs } from '../browser/browser-handoffs';
import type { ChatQueueDispatchOptions } from './chat-queue-service';
import { CHAT_CUSTOM_TITLE_MAX_LENGTH } from '@canopy/protocol';
import { closeRejectedSplitAgentStartup } from './split-agent-startup';
import { inputDeliveryViews } from '@canopy/desktop-shared/chat-input-delivery';
import { isInternalChatRequest } from '@canopy/desktop-shared/lib/internal-chat-row';
import { getSession as getInputSession } from '../agents/session-manager';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { BRAND } from '@canopy/brand/current';
import type {
  AgentModelConfig,
  AgentProviderType,
  ApprovalMode,
  ApprovalRule,
  ChatCancelRequest,
  ChatInterfaceMode,
  ChatModel,
  ChatQueueTarget,
  ChatResumeStoppedTurnRequest,
  ChatSendMessageRequest,
  ChatTabPluginSelections,
  ClaudeTerminalScheduledPromptEvent,
  CoworkWorkEntryMeta,
  PersistedChatMessage,
  PersistedPendingQuestion,
  PersistedChatTab,
  PortalAppAdvisorChatSummary,
  PortalAskUserQuestionState,
  PortalChatMessage,
  PortalChatMessageAttachment,
  HostPortalChatSendPayload,
  PortalChatSummaryEntity,
  PortalChatTodoProjection,
  PortalChatSummaryPluginSelections,
  PortalChatTabPluginSelections,
  PortalChatTurnGroup,
} from '@canopy/desktop-shared/types';
import {
  chatAgentSent,
  type AgentSentInfo,
} from '@canopy/protocol/portal/external-agent-sender';
import {
  portalPromptProvenance,
  projectTodoItems,
} from '@canopy/agent-transcript';
import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  APP_ADVISOR_WORKTREE_ID,
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  IPC_CHANNELS,
  STANDALONE_CHAT_PROJECT_ID,
  getExecutionHarnessForModel,
  getModelDisplayName,
  getModelSource,
  getProviderForModel,
  hasHydratedGatewayCatalog,
  hasHydratedModelRegistry,
  isChatAttachmentPromptKind,
  isInheritingAgentModel,
  isTerminalBackedInterfaceMode,
  normalizeAgentModelConfig,
  resolvePersistedChatExecutionHarness,
} from '@canopy/desktop-shared/types';
import {
  REMOTE_CONTROL_LABEL,
  worktreeScopedParentLocalId,
} from '@canopy/protocol';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  portalChatAssetId,
  type PortalChatScheduledMessages,
} from '@canopy/protocol/portal';
import { resolveClaudeForkResumePoint } from '@canopy/desktop-shared/lib/claude-fork-resume-point';
import { readCodexSpeedRecord } from '@canopy/execution-engine/lib/codex-speed';
import { getPortalChatToolFamily } from '@canopy/desktop-shared/lib/portal-tool-family';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { isUsageInitiationSource } from '@canopy/desktop-shared/lib/turn-utils';
import {
  backgroundTaskCount,
  summaryTurnActive,
} from '@canopy/desktop-shared/lib/background-work';
import {
  narrowApprovalMode,
  narrowSessionApprovalRules,
} from '@canopy/desktop-shared/lib/send-approval-narrowing';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import { previewAccountProxySessionRoute } from '../account-proxy/routing';
import { assertTurnAuthDependencies } from '../lib/auth-preflight';
import { resolveSendBillingRefusal } from '../lib/send-billing-refusal';
import { waitForWorktreeGitSetup } from '../lib/worktree-git-setup';
import { TurnDispatchTiming } from '../lib/turn-dispatch-timing';
import {
  captureChatTurnStop,
  type ChatTurnStopContext,
} from '../lib/chat-turn-cancel';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { parseChatActivePlanContext } from '../lib/active-plan-instruction';
import {
  readChatTabsFile,
  readChatTranscript,
  readChatLastMessageRole,
} from '../lib/chat-tabs-reader';
import { chatLastMessageRole } from '../lib/chat-last-message-role';
import { resolveTerminalDrivenChat } from '../lib/terminal-driven-chat';
import { enqueueChatTabMutation } from '../lib/chat-tab-mutation-queue';
import {
  claudeForkSessionIdFromInit,
  consumePersistedClaudeForkSessionMarker,
} from '../lib/claude-fork-session-marker';
import { clearUsageLimitedChat } from '../lib/usage-limited-chats-registry';
import {
  capturePersistedUsageLimitBannerSnapshot,
  clearPersistedUsageLimitBanner,
} from '../lib/chat-usage-limit-cleanup';
import { sendToWindow, sendToWindowDetailed } from '../lib/window-send';
import {
  capturePortalEmissionContext,
  createPortalEvent,
  enqueuePortalEvent,
  enqueuePortalEventIfCurrent,
  isPortalEmissionContextCurrent,
  type PortalEmissionContext,
  isCanopyPortalActive,
} from '../portal/portal-event-bus';
import { peekPortalProviderAvailability } from '../auth/provider-auth-state';
import { buildProjectedModelCatalog } from '../portal/model-catalog-projection';
import { isDesktopModelRoutingSupported } from '../portal/worktree-new-task-controls';
import { getLatestAppAdvisorWindowUiState } from '../app-advisor/window-ui-state';
import {
  limitPortalChatTranscriptForSeedWithMetadata,
  type PortalChatTranscriptSeed,
  PORTAL_CHAT_SEED_MESSAGE_LIMIT,
  PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT,
  portalChatMessageAttachmentsFromPaths,
  projectPersistedChatTranscript,
  createCursorAssistantPatchProjector,
  runtimeChatEventToPortalMessage,
} from './chat-transcript-projector';
import { buildAutomationInfoMessage } from './automation-info-message';
import { portalChatTabsCache } from './portal-chat-tabs-cache';
import {
  checkWatcherDeliveryIngress,
  WatcherDeliveryHeldError,
  notifyCanonicalChatStarted,
} from '../services/active-chat-input';
import {
  getEffectiveClaudeChatInterfaceMode,
  getPersistedClaudeChatInterfaceMode,
} from '../lib/claude-tui-chats';
import { cancelTransientRetryForChat } from '../lib/transient-error-retry-service';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { isGeneratedInputRequest } from './chat-input-request-kind';
import {
  listWorkEntryIds,
  listWorkEntries,
  resolveWorkEntryForChat,
} from '../lib/cowork-work-entries';
import { mapWithConcurrency } from '../lib/concurrency';
import {
  listAnsweredAppAdvisorAskUserQuestions,
  listPendingAppAdvisorAskUserQuestions,
} from '../ipc/app-advisor';
import { getChatQueueService } from './chat-queue-service';
import { projectPortalQuestionStates } from '../lib/portal-question-states';
import { projectPortalLastTurnEnd } from '../lib/portal-turn-end';
import { assertNotSplitLocked } from './split-lock-service';
import {
  applyLiveSessionSettings,
  decideTurnSessionReuse,
  holdsForBackgroundWork,
  TurnHeldForBackgroundWorkError,
} from '../lib/turn-session-reuse';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../lib/resolve-worktree';
import { resolvePersistedApprovalMode } from '../lib/approval-mode-resolution';
import { clampToLiveApprovalMode } from '../approvals/live-approval-modes';
import {
  chatHasNativeBackgroundWork,
  getActiveChatIds,
  getActiveSessionInfos,
  getSessionTurnSettings,
} from '../agents/session-manager';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getChatStateService } from './chat-state-service';
import {
  normalizeProviderEventIngestResult,
  type ProviderEventIngestResult,
} from './provider-event-admission';
import { createPortalPrimaryToolCorrelation } from '../lib/portal-primary-tool-correlation';
import type { DispatchWorktreeChatTurnOptions } from '../lib/worktree-chat-turn';
import type { AuthorizedChatDispatch } from './chat-dispatch-authorization';
import { delegationChildMessages } from '@canopy/agent-transcript';
import { DELEGATION_TRANSCRIPT_CHAT_LOG } from '@canopy/protocol/delegation';
import { getStoppedTurnResumeService } from './stopped-turn-resume-service';
import { assertChatScopeAcceptsTurns } from '../lib/retired-chat-scope-guard';
import { isDelegationDeliveryActive } from '../agents/delegation/lifecycle';
import {
  billedProviderFor,
  effectiveTabAiCreditsRouting,
} from '../agents/effective-ai-credits-routing';

type WorktreePortalEventCommit = ProviderEventIngestResult & {
  readonly portalEmissionContext?: PortalEmissionContext;
  readonly acceptedTurnUserMessageId?: string;
  readonly sequenceNamespace: string;
  readonly primaryToolEpoch: number;
};

/** Active dispatch owners, not an event/receipt cache. Settlement removes the entry. */
const worktreePortalPrimaryTurns = new Map<string, WorktreePortalPrimaryTurn>();

interface WorktreePortalPrimaryTurn {
  readonly tools: ReturnType<typeof createPortalPrimaryToolCorrelation>;
  capture(
    namespace: string,
    turn: string | undefined,
    context: PortalEmissionContext | undefined,
  ): number;
  isCurrent(epoch: number | undefined): boolean;
  settle(): void;
  retire(): void;
}

function worktreePortalPrimaryTurnKey(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

function retireWorktreePortalPrimaryTurn(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): void {
  worktreePortalPrimaryTurns
    .get(worktreePortalPrimaryTurnKey(target))
    ?.retire();
}

function createWorktreePortalPrimaryTurn(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): WorktreePortalPrimaryTurn {
  const key = worktreePortalPrimaryTurnKey(target);
  worktreePortalPrimaryTurns.get(key)?.retire();
  const tools = createPortalPrimaryToolCorrelation((reason) =>
    logMainProcessWarn('[chat-service] Primary tool correlation limit', {
      reason,
    }),
  );
  let epoch = 0;
  let stream: string | undefined;
  let retired = false;
  const clear = (): void => {
    epoch++;
    stream = undefined;
    tools.clear();
  };
  const release = (): void => {
    if (worktreePortalPrimaryTurns.get(key) === state)
      worktreePortalPrimaryTurns.delete(key);
  };
  const state: WorktreePortalPrimaryTurn = {
    tools,
    capture(namespace, turn, context): number {
      if (retired) return epoch;
      const owner = worktreePortalPrimaryTurns.get(key);
      if (owner && owner !== state) {
        state.retire();
        return epoch;
      }
      worktreePortalPrimaryTurns.set(key, state);
      const nextStream = JSON.stringify([namespace, turn, context?.generation]);
      if (stream !== nextStream) {
        clear();
        stream = nextStream;
      }
      return epoch;
    },
    isCurrent(candidate): boolean {
      return !retired && candidate === epoch;
    },
    settle(): void {
      clear();
      release();
    },
    retire(): void {
      retired = true;
      clear();
      release();
    },
  };
  worktreePortalPrimaryTurns.set(key, state);
  return state;
}

export interface ChatServiceOptions {
  /** Host-only funded Retry attempt; preserves prompt identity with fresh event receipts. */
  creditRetryAttemptId?: string;
  /** Trusted cancellation until provider acceptance; never a DTO or persisted. */
  admissionSignal?: AbortSignal;
  /** Trusted quota continuation: refuse any other billing connection. */
  requiredAccountProxyConnectionId?: string;
  /** Trusted host signal, before post-acceptance persistence; never a DTO. */
  onTurnAccepted?: () => void;
  /** Trusted background lineage; not accepted from frontend request payloads. */
  executionContext?: string;
  getWindow?: () => BrowserWindow | null;
  preserveTransientRetry?: boolean;
  /** A durable resume queue clears this after terminal delivery is confirmed. */
  preserveUsageLimitRegistry?: boolean;
  /** Required when dispatching directly into an existing App Advisor chat. */
  appAdvisorSurfaces?: AppAdvisorToolRuntimeSurfaces;
  /**
   * Keep the scope's current active chat instead of selecting the target,
   * for background sends that must not move the user's visible selection.
   */
  preserveActiveTab?: boolean;
  /**
   * Host-only: the queue already admitted this send, with its dispatch
   * capability when one was issued. Never part of a request or DTO.
   */
  queueDispatch?: { authorization?: AuthorizedChatDispatch };
}

interface LocalChatDispatchOptions extends ChatServiceOptions {
  emitUserPrompt?: boolean;
  hiddenContinuation?: {
    attemptId: string;
  };
}

function getNullWindow(): BrowserWindow | null {
  return null;
}

type PortalChatEventScope =
  | {
      scope: 'standalone';
      projectLocalId: string;
      projectId: string;
      workEntryId: string;
    }
  | {
      scope: 'worktree';
      workspaceLocalId: string;
      worktreeLocalId: string;
    };

function portalChatEventScope(
  projectId: string,
  worktreeId: string,
): PortalChatEventScope {
  if (isCoworkWorkspace(projectId)) {
    const coworkWorkspaceId =
      projectId === STANDALONE_CHAT_PROJECT_ID ? worktreeId : projectId;
    return {
      scope: 'standalone',
      projectLocalId: coworkWorkspaceId,
      projectId: coworkWorkspaceId,
      workEntryId: worktreeId,
    };
  }
  return {
    scope: 'worktree',
    workspaceLocalId: projectId,
    worktreeLocalId: worktreeId,
  };
}

/**
 * Projects a live send's `attachmentPaths` into the `attachments` field
 * spread onto a `portal.chat.event` user-message literal, mirroring what
 * `persistedMessageToPortalMessage` already emits for persisted rows.
 * Returns an empty object (no `attachments` key) when there is nothing to
 * project, so a request without attachments does not gain a spurious empty
 * array on the wire.
 */
function portalUserAttachments(
  userMessageId: string,
  attachmentPaths: readonly string[] | undefined,
): { attachments: PortalChatMessageAttachment[] } | Record<never, never> {
  if (!attachmentPaths || attachmentPaths.length === 0) return {};
  const attachments = portalChatMessageAttachmentsFromPaths(
    attachmentPaths,
  ).map((attachment, index) => ({
    ...attachment,
    assetId: portalChatAssetId(userMessageId, 'attachment', index),
  }));
  return attachments.length > 0 ? { attachments } : {};
}

let getWorktreeChatWindow: () => BrowserWindow | null = getNullWindow;
let specialNativeChatDispatcher:
  | ((
      request: ChatSendMessageRequest,
      authorization?: AuthorizedChatDispatch,
    ) => Promise<void>)
  | undefined;
let autoModelRoutingDispatcher:
  | ((
      request: ChatSendMessageRequest,
      origin: 'desktop' | 'portal',
      fromQueue: boolean,
    ) => Promise<ChatSendMessageRequest>)
  | undefined;
let sendModelPreparer:
  | ((request: ChatSendMessageRequest) => Promise<ChatSendMessageRequest>)
  | undefined;
let queuedAppAdvisorSurfaces: ChatServiceOptions['appAdvisorSurfaces'];

/** Reuse the native entry-point policy and tool context when a host row drains. */
export function setSpecialNativeChatDispatcher(
  dispatch: (
    request: ChatSendMessageRequest,
    authorization?: AuthorizedChatDispatch,
  ) => Promise<void>,
  appAdvisorSurfaces: NonNullable<ChatServiceOptions['appAdvisorSurfaces']>,
): void {
  specialNativeChatDispatcher = dispatch;
  queuedAppAdvisorSurfaces = appAdvisorSurfaces;
}

/** App Advisor surfaces registered at startup, for sends from non-Advisor callers. */
export function getRegisteredAppAdvisorSurfaces(): ChatServiceOptions['appAdvisorSurfaces'] {
  return queuedAppAdvisorSurfaces;
}

/**
 * Register the host-owned Auto resolver at the queue's dispatch boundary.
 * The callback lives in `ipc/chat.ts` so it can reuse the canonical model
 * change path without introducing a chat-service ↔ IPC import cycle.
 */
export function setAutoModelRoutingDispatcher(
  dispatch: (
    request: ChatSendMessageRequest,
    origin: 'desktop' | 'portal',
    fromQueue: boolean,
  ) => Promise<ChatSendMessageRequest>,
): void {
  autoModelRoutingDispatcher = dispatch;
}

/**
 * Register the host-owned step that settles a desktop send's model before its
 * queue row is written, pinning an Agent on the default model on the chat.
 * Lives in `ipc/chat.ts` for the same import-cycle reason as above.
 */
export function setSendModelPreparer(
  prepare: (request: ChatSendMessageRequest) => Promise<ChatSendMessageRequest>,
): void {
  sendModelPreparer = prepare;
}

/**
 * Register the canonical desktop window for worktree-chat event delivery.
 *
 * Host-owned queue dispatch happens outside the originating IPC handler, so it
 * cannot safely recover that window with `BrowserWindow.getAllWindows()[0]`:
 * Electron does not guarantee window ordering and the App Advisor window may
 * occupy that slot. Keep the live accessor supplied by the app shell instead.
 */
export function setWorktreeChatWindowAccessor(
  getWindow: () => BrowserWindow | null,
): void {
  getWorktreeChatWindow = getWindow;
}

/**
 * Settle the renderer's superseded turn before a forced host-queue dispatch
 * opens the replacement turn. The eventual provider cancellation remains
 * authoritative in main; this ordered UI event closes the old visible timer.
 */
export async function emitHostQueueForcedCancellation(
  target: ChatQueueTarget,
  turnUserMessageId?: string,
): Promise<void> {
  const data = {
    type: 'result',
    is_error: false,
    result: 'Cancelled',
    ...(turnUserMessageId
      ? { canopy_turn_user_message_id: turnUserMessageId }
      : {}),
  } as const;
  await getChatStateService().ingestProviderEvent({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    data,
    mutationId: turnUserMessageId
      ? `${turnUserMessageId}:forced-cancellation`
      : `forced-cancellation:${target.chatId}:${randomUUID()}`,
    ...(turnUserMessageId ? { turnUserMessageId } : {}),
  });
  sendToWindow(getWorktreeChatWindow(), IPC_CHANNELS.chatEvent, {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    data,
  });
}

function getRequestInitiationSource(
  request: unknown,
): ChatSendMessageRequest['initiationSource'] {
  if (!request || typeof request !== 'object') {
    return undefined;
  }
  const value = (request as Record<string, unknown>)['initiationSource'];
  if (isUsageInitiationSource(value)) return value;
  return Reflect.get(request, 'automationName') !== undefined ||
    Reflect.get(request, 'watcherFired') !== undefined
    ? 'automation'
    : undefined;
}

function acceptedUserPromptData(
  target: Pick<
    ChatSendMessageRequest,
    'projectId' | 'worktreeId' | 'chatId' | 'userMessageId'
  >,
  consumedPendingSystemInstructionIds?: readonly string[],
): {
  type: typeof CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE;
  canopy_turn_user_message_id: string;
  canopy_consumed_pending_system_instruction_ids?: string[];
} {
  return {
    type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
    canopy_turn_user_message_id: target.userMessageId,
    ...(consumedPendingSystemInstructionIds?.length
      ? {
          canopy_consumed_pending_system_instruction_ids: [
            ...consumedPendingSystemInstructionIds,
          ],
        }
      : {}),
  };
}

async function commitAcceptedUserPrompt(
  target: Pick<
    ChatSendMessageRequest,
    'projectId' | 'worktreeId' | 'chatId' | 'userMessageId'
  >,
  consumedPendingSystemInstructionIds?: readonly string[],
): Promise<ReturnType<typeof acceptedUserPromptData>> {
  const data = acceptedUserPromptData(
    target,
    consumedPendingSystemInstructionIds,
  );
  await getChatStateService().ingestProviderEvent({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    data,
    mutationId: `${target.chatId}:${target.userMessageId}:accepted`,
    turnUserMessageId: target.userMessageId,
  });
  return data;
}

function sendAcceptedUserPrompt(
  getWindow: () => BrowserWindow | null,
  target: Pick<
    ChatSendMessageRequest,
    'projectId' | 'worktreeId' | 'chatId' | 'userMessageId'
  >,
  data: ReturnType<typeof acceptedUserPromptData>,
): void {
  sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    data,
  });
}

async function emitAcceptedUserPrompt(
  getWindow: () => BrowserWindow | null,
  target: Pick<
    ChatSendMessageRequest,
    'projectId' | 'worktreeId' | 'chatId' | 'userMessageId'
  >,
  consumedPendingSystemInstructionIds?: readonly string[],
): Promise<void> {
  const data = await commitAcceptedUserPrompt(
    target,
    consumedPendingSystemInstructionIds,
  );
  sendAcceptedUserPrompt(getWindow, target, data);
}

export async function assertWatcherDeliveryIngress(request: {
  projectId: string;
  worktreeId: string;
  chatId?: string;
  watcherFired?: unknown;
  watcherDeliveryId?: string;
}): Promise<void> {
  if (!request.watcherFired || !request.watcherDeliveryId) return;
  if (!request.chatId)
    throw new WatcherDeliveryHeldError('runtime_unavailable');
  const check = await checkWatcherDeliveryIngress({
    ...request,
    chatId: request.chatId,
  });
  if (!check.allowed) throw new WatcherDeliveryHeldError(check.reason);
}

export async function dispatchLocalWorktreeChatMessage(
  request: ChatSendMessageRequest,
): Promise<void> {
  if (
    'watcherFired' in request &&
    request.watcherFired &&
    'watcherDeliveryId' in request &&
    request.watcherDeliveryId
  )
    await assertWatcherDeliveryIngress(request);
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.chatId, 'chatId');
  validateId(request.userMessageId, 'userMessageId');
  validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
  // Refuse a legacy plan chat before a durable queue row is written.
  assertChatScopeAcceptsTurns(request.projectId);
  // The active plan rides the request through the host queue unchanged and is
  // resolved against this request's own scope when the turn dispatches.
  parseChatActivePlanContext(request.activePlan);
  request =
    await getChatStateService().claimRetainedTerminalAgentInputForNative(
      request,
    );
  try {
    // Before the queue row is written, so a queued turn keeps the route it was
    // sent with even if Settings change while it waits.
    const prepared = sendModelPreparer
      ? await sendModelPreparer(request)
      : request;
    // A send held for setup commits its prompt now and dispatches after this
    // returns, so refuse a known-broken dependency first, as dispatch would,
    // while the reply can still offer to reconnect it. While a setup is
    // pending this judges every send to the worktree now, including one that
    // queues behind the held turn; dispatch checks again.
    if (waitForWorktreeGitSetup(prepared.projectId, prepared.worktreeId)) {
      await assertTurnAuthDependencies({
        target: {
          projectId: prepared.projectId,
          worktreeId: prepared.worktreeId,
          chatId: prepared.chatId,
        },
        ...(prepared.pluginSelections
          ? { pluginSelections: prepared.pluginSelections }
          : {}),
        ...(prepared.providerType
          ? { providerType: prepared.providerType }
          : {}),
      });
    }
    // A send into a worktree whose Git setup is still running waits in main:
    // the first becomes the held turn, shown as a sent prompt that is
    // starting, and later ones queue behind it.
    await getChatStateService().holdLocalSendForWorktreeSetup(
      prepared,
      (timestamp) =>
        buildPersistedUserMessage(prepared, prepared.userMessageId, timestamp),
      async () => {
        const { getChatQueueService } = await import('./chat-queue-service');
        await getChatQueueService().submit(prepared, 'desktop');
      },
      // A held send dispatches after this returns; its failure, or its setup
      // ending, undoes the claim there, as this catch does for one that
      // fails here.
      () =>
        getChatStateService().restoreRetainedTerminalAgentInputAfterFailedNativeAdmission(
          request,
        ),
    );
  } catch (error) {
    await getChatStateService().restoreRetainedTerminalAgentInputAfterFailedNativeAdmission(
      request,
    );
    throw error;
  }
}

const STOPPED_TURN_CONTINUATION_PROMPT =
  'Continue from where you left off. Do not repeat work that is already complete.';

export async function resumeStoppedWorktreeChatTurn(
  request: ChatResumeStoppedTurnRequest,
  attemptId: string,
  options: ChatServiceOptions = {},
): Promise<void> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.chatId, 'chatId');
  validateId(request.userMessageId, 'userMessageId');
  validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
  const target = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
  };
  retireWorktreePortalPrimaryTurn(request);
  const queue = getChatQueueService();
  queue.confirmTurnRevived(target, request.userMessageId);
  try {
    await dispatchLocalWorktreeChatMessageNow(
      {
        ...request,
        text: STOPPED_TURN_CONTINUATION_PROMPT,
      },
      {
        ...options,
        hiddenContinuation: {
          attemptId,
        },
      },
    );
  } catch (error) {
    queue.onTurnTerminal(target, 'error', request.userMessageId);
    throw error;
  }
}

async function dispatchLocalWorktreeChatMessageNow(
  request: ChatSendMessageRequest,
  options: LocalChatDispatchOptions = {},
): Promise<void> {
  const turnDispatchTiming = new TurnDispatchTiming();
  // Before the chat or its prompt become durable: covers stopped-turn resume
  // and drains of queue rows written before plan chats were retired.
  assertChatScopeAcceptsTurns(request.projectId);
  retireWorktreePortalPrimaryTurn(request);
  const getWindow = options.getWindow ?? getNullWindow;
  const hiddenContinuation = options.hiddenContinuation;
  const shouldEmitUserPrompt =
    options.emitUserPrompt === true ||
    request.hiddenContext?.kind === 'canopy-watcher-event';
  if (!hiddenContinuation) {
    // Register non-persisted root-turn context before any await can expose the
    // canonical active turn to Stop. The worktree dispatch records it again at
    // its shared funnel as a defense for direct callers.
    getStoppedTurnResumeService().recordTurnContext(
      request,
      request.userMessageId,
      request.packageOverlay !== undefined,
    );
  }
  // Refuse a turn whose required dependencies are already known-unauthenticated
  // (CAN-1814 PR 5), BEFORE `ensureChatForTrustedSend` and the user-prompt
  // ingest below make it durable. This is the desktop funnel's counterpart to
  // the guard in `sendWorktreeChatMessage`; both exist because the two funnels
  // do not share a pre-persistence chokepoint.
  //
  // Cached reads only — see `lib/auth-preflight.ts` for why (CAN-399/CAN-492).
  // It runs on every drain, not only on the immediate send, so a message queued
  // behind a long turn is judged against the auth state at the moment it
  // actually dispatches rather than when it was typed.
  await turnDispatchTiming.measure('auth_preflight', () =>
    assertTurnAuthDependencies({
      target: {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
      },
      ...(request.pluginSelections
        ? { pluginSelections: request.pluginSelections }
        : {}),
      ...(request.providerType ? { providerType: request.providerType } : {}),
    }),
  );
  if (request.watcherFired && request.watcherDeliveryId)
    await assertWatcherDeliveryIngress(request);
  await getChatStateService().ensureChatForTrustedSend(request);
  // A delegate's message reaches the Portal only once its provider accepts it.
  let enqueueAcceptedPromptForPortal: (() => void) | undefined;
  if (!hiddenContinuation) {
    const persistedUserMessage = buildPersistedUserMessage(
      request,
      request.userMessageId,
      Date.now(),
    );
    const userPromptEvent = {
      type: 'canopy_user_prompt',
      original_text: request.text,
      canopy_turn_user_message_id: request.userMessageId,
      ...(request.resumesInterruptedTurn
        ? { canopy_resumes_interrupted_turn: true }
        : {}),
      provider:
        request.providerType ??
        (request.model ? getProviderForModel(request.model) : undefined),
      // The durable queue already retains this identity. The prompt reducer
      // recovers structured answers from the retained answered question.
      ...(request.asyncQuestionId
        ? { canopy_async_question_id: request.asyncQuestionId }
        : {}),
      ...(request.autoResume?.resumesUserMessageId
        ? {
            canopy_resumes_user_message_id:
              request.autoResume.resumesUserMessageId,
          }
        : {}),
      canopy_persisted_messages: [persistedUserMessage],
    };
    const committed = await turnDispatchTiming.measure('prompt_commit', () =>
      getChatStateService().ingestProviderEvent({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        mutationId: `${request.chatId}:${request.userMessageId}:user-prompt`,
        data: userPromptEvent,
        ...(request.providerType ? { providerType: request.providerType } : {}),
        turnUserMessageId: request.userMessageId,
      }),
    );
    if (!committed) {
      const accepted = await getChatStateService().hasMutation(
        { projectId: request.projectId, worktreeId: request.worktreeId },
        `${request.chatId}:${request.userMessageId}:accepted`,
      );
      // A funded queue Retry deliberately reuses the refused prompt's identity.
      // Its prior acceptance records handoff, not successful provider execution.
      if (accepted && options.creditRetryAttemptId === undefined) {
        getChatQueueService().onTurnTerminal(
          request,
          'complete',
          request.userMessageId,
        );
        return;
      }
    }
    // Only queue-drained dispatches announce the user prompt: for immediate
    // sends the renderer already appended the message locally, and the Codex
    // transcript reducer appends canopy_user_prompt without dedupe.
    const announceUserPrompt = (): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        data: userPromptEvent,
      });
    };
    if (committed && shouldEmitUserPrompt) announceUserPrompt();
    const enqueueUserPromptForPortal = (): void =>
      enqueuePortalEvent(
        createPortalEvent('portal.chat.event', {
          scope: 'worktree',
          workspaceLocalId: request.projectId,
          worktreeLocalId: request.worktreeId,
          chatId: request.chatId,
          message: {
            messageId: request.userMessageId,
            chatId: request.chatId,
            role: 'user',
            ...(request.agentSent ? { agentSent: request.agentSent } : {}),
            status: 'complete',
            text: request.text,
            ...portalPromptProvenance(persistedUserMessage),
            ...portalUserAttachments(
              request.userMessageId,
              request.attachmentPaths,
            ),
            createdAtMs: Date.now(),
          },
        }),
      );
    if (isInternalChatRequest(request))
      enqueueAcceptedPromptForPortal = enqueueUserPromptForPortal;
    else enqueueUserPromptForPortal();
  }
  const { dispatchWorktreeChatTurn: dispatchTurn } =
    await import('../lib/worktree-chat-turn');
  const dispatchWorktreeChatTurn = (
    turn: DispatchWorktreeChatTurnOptions<WorktreePortalEventCommit>,
  ): Promise<void> =>
    request.agentSenderProvenance
      ? withAgentSenderAuthority(
          request,
          () => dispatchTurn(turn),
          revalidateAgentSenderRequest,
        )
      : dispatchTurn(turn);
  const acceptanceTasks: Promise<void>[] = [];
  const primaryTurn = createWorktreePortalPrimaryTurn(request);
  const primaryTools = primaryTurn.tools;
  // Cursor streams patches against one assistant message; fold them per turn
  // so the portal sees the growing text under the persisted message id.
  const cursorPatches = createCursorAssistantPatchProjector({
    scope: 'worktree',
    workspaceLocalId: request.projectId,
    worktreeLocalId: request.worktreeId,
    chatId: request.chatId,
  });
  try {
    await dispatchWorktreeChatTurn({
      ...request,
      ...(options.queueDispatch?.authorization
        ? { authorization: options.queueDispatch.authorization }
        : {}),
      requiredAccountProxyConnectionId:
        options.requiredAccountProxyConnectionId,
      countsTowardSkillUsage:
        !hiddenContinuation &&
        !request.hiddenContext &&
        (request.initiationSource === 'user' ||
          request.initiationSource === 'portal'),
      ...(options.executionContext === undefined
        ? {}
        : { executionContext: options.executionContext }),
      planMode: request.planMode ?? false,
      initiationSource: resolvePresentationSource(request, 'user'),
      getWindow,
      turnDispatchTiming,
      providerEventSequenceNamespace:
        hiddenContinuation?.attemptId ?? options.creditRetryAttemptId,
      ...(hiddenContinuation
        ? {
            hiddenDeferredContinuation: true,
            hiddenContinuationKind: 'stopped_turn_resume' as const,
          }
        : {
            onTurnAccepted: (): void => {
              options.onTurnAccepted?.();
              enqueueAcceptedPromptForPortal?.();
              const consumedInstructionIds =
                request.pendingSystemInstructions?.map(
                  (instruction) => instruction.id,
                );
              const constituentUserMessageIds = Array.from(
                new Set(request.consolidatedWatcherUserMessageIds ?? []),
              ).filter(
                (userMessageId) => userMessageId !== request.userMessageId,
              );
              const task = (async (): Promise<void> => {
                for (const userMessageId of constituentUserMessageIds) {
                  await commitAcceptedUserPrompt({ ...request, userMessageId });
                }
                if (shouldEmitUserPrompt) {
                  await emitAcceptedUserPrompt(
                    getWindow,
                    request,
                    consumedInstructionIds,
                  );
                } else {
                  await commitAcceptedUserPrompt(
                    request,
                    consumedInstructionIds,
                  );
                }
              })().catch((error: unknown) => {
                logMainProcessWarn(
                  '[chat-service] Failed to commit accepted local turn',
                  error,
                );
              });
              acceptanceTasks.push(task);
            },
          }),
      onBeforeChatEvent: async (event) => {
        const portalEmissionContext = capturePortalEmissionContext();
        const acceptedTurnUserMessageId = event.turnUserMessageId;
        const primaryToolEpoch = primaryTurn.capture(
          event.sequenceNamespace,
          acceptedTurnUserMessageId,
          portalEmissionContext,
        );
        // The provider that ran wins: lane selection may substitute one.
        const providerType = event.providerType ?? request.providerType;
        const outcome =
          await getChatStateService().ingestProviderEventWithResult({
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            chatId: event.chatId,
            data: event.data,
            mutationId: `${request.chatId}:${request.userMessageId}:provider:${event.sequenceNamespace}:${event.sequence}`,
            ...(providerType ? { providerType } : {}),
            ...(event.turnUserMessageId
              ? { turnUserMessageId: event.turnUserMessageId }
              : {}),
            ...(event.onCommitQueued
              ? { onCommitQueued: event.onCommitQueued }
              : {}),
          });
        return {
          ...normalizeProviderEventIngestResult(outcome),
          portalEmissionContext,
          acceptedTurnUserMessageId,
          sequenceNamespace: event.sequenceNamespace,
          primaryToolEpoch,
        };
      },
      onChatEvent: (event) => {
        const completion = event.beforeChatEventResult;
        const emissionContext = completion?.portalEmissionContext;
        const emissionCurrent =
          emissionContext !== undefined &&
          isPortalEmissionContextCurrent(emissionContext);
        const admissionCurrent =
          emissionCurrent &&
          primaryTurn.isCurrent(completion?.primaryToolEpoch);
        if (
          !emissionCurrent &&
          primaryTurn.isCurrent(completion?.primaryToolEpoch)
        )
          primaryTurn.settle();
        const cursorMessage = cursorPatches.apply(event.data);
        let message =
          cursorMessage ??
          runtimeChatEventToPortalMessage({
            scope: 'worktree',
            workspaceLocalId: event.projectId,
            worktreeLocalId: event.worktreeId,
            chatId: event.chatId,
            data: event.data,
            fallbackMessageId: `${request.userMessageId}:assistant`,
          });
        if (
          admissionCurrent &&
          !cursorMessage &&
          message &&
          isRecord(event.data) &&
          (event.data.type === 'codex' ||
            event.data.type === 'user' ||
            event.data.type === 'assistant')
        ) {
          if (completion?.outcome === 'applied' && completion.admission)
            primaryTools.retain(message.messageId, completion.admission);
          const admittedMessage = runtimeChatEventToPortalMessage({
            scope: 'worktree',
            workspaceLocalId: event.projectId,
            worktreeLocalId: event.worktreeId,
            chatId: event.chatId,
            data: event.data,
            fallbackMessageId: `${request.userMessageId}:assistant`,
            admission: primaryTools.forMessage(message.messageId),
          });
          if (admittedMessage)
            message = { ...message, parts: admittedMessage.parts };
        }
        if (message && emissionContext) {
          enqueuePortalEventIfCurrent(
            emissionContext,
            createPortalEvent('portal.chat.event', {
              scope: 'worktree',
              workspaceLocalId: event.projectId,
              worktreeLocalId: event.worktreeId,
              chatId: event.chatId,
              message,
            }),
          );
        }
        if (
          event.isTerminalEvent &&
          primaryTurn.isCurrent(completion?.primaryToolEpoch)
        )
          primaryTurn.settle();
      },
    });
  } catch (error) {
    primaryTurn.retire();
    if (request.managedDelegationDeliveryId) {
      await getChatStateService().removeUnacceptedUserPrompt({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        userMessageId: request.userMessageId,
      });
    }
    throw error;
  }
  await Promise.all(acceptanceTasks);
}

// Live caller surfaces belong to this request, not the serializable queue
// payload. Restored/edited rows use the application's registered surfaces.
// Billing constraints are persisted separately on the main-owned queue row.
const portalQueueOptions = new WeakMap<
  ChatSendMessageRequest,
  ChatServiceOptions
>();

export async function dispatchHostQueuedWorktreeChatMessage(
  request: ChatSendMessageRequest,
  origin: 'desktop' | 'portal',
  fromQueue: boolean,
  authorization?: AuthorizedChatDispatch,
  queueOptions: ChatQueueDispatchOptions = {},
): Promise<void> {
  let turnAccepted = false;
  const onTurnAccepted = (): void => {
    turnAccepted = true;
  };
  const state = getChatStateService();
  await state.runWithScopeActivity(
    { projectId: request.projectId, worktreeId: request.worktreeId },
    async () => {
      try {
        await dispatchHostQueuedWorktreeChatMessageNow(
          request,
          origin,
          fromQueue,
          onTurnAccepted,
          authorization,
          queueOptions,
        );
      } catch (error) {
        // A held send remains queue-owned user intent. In particular, do not
        // settle an independent-branch startup as rejected: no prompt was
        // committed and the queue will retry after native work ends.
        if (error instanceof TurnHeldForBackgroundWorkError) throw error;
        // Setup-queued split starts outlive the tool executor. Confirm the
        // one-shot marker with main-owned state, never a stale renderer copy.
        let pendingStartup = false;
        if (
          origin === 'desktop' &&
          !turnAccepted &&
          request.pendingSystemInstructions?.some(
            (instruction) => instruction.id === 'independent-agent-start',
          )
        ) {
          try {
            const tabs = await state.getCompatibilityTabs(request, {
              chatIds: [request.chatId],
            });
            const tab = tabs.tabs.find(
              (candidate) => candidate.id === request.chatId,
            );
            pendingStartup =
              Boolean(
                tab?.forkedFrom &&
                tab.forkedFrom.worktreeId !== request.worktreeId &&
                tab.pendingSystemInstructions?.some(
                  (instruction) => instruction.id === 'independent-agent-start',
                ),
              ) &&
              !(await state.hasMutation(
                request,
                `${request.chatId}:${request.userMessageId}:accepted`,
              ));
          } catch (readError) {
            logMainProcessWarn(
              '[split-agent] Failed to inspect rejected startup',
              readError,
            );
          }
        }
        if (pendingStartup)
          await closeRejectedSplitAgentStartup(request, error, state);
        throw error;
      }
    },
  );
}

/**
 * A root agent's queued message to a project chat, or an agent-originated
 * pipeline run's, runs with that chat's current approval settings, the ones
 * its dispatch-time admission checks, never the copy captured when it was
 * queued. They are also its admitted approval, so the turn never runs with
 * authority gained after this read.
 */
async function withCurrentTargetApprovalSettings(
  request: ChatSendMessageRequest,
): Promise<ChatSendMessageRequest> {
  const provenance = request.agentSenderProvenance;
  if (!provenance || request.projectId === APP_ADVISOR_PROJECT_ID)
    return request;
  // A pipeline run a user started keeps the approval override it was
  // admitted with (D2); one an agent started runs as that agent's (D11).
  const agentOriginated =
    provenance.sender.kind === 'project' ||
    ('agentOrigin' in provenance && provenance.agentOrigin !== undefined);
  if (!agentOriginated) return request;
  if (request.turnOverride?.approvalMode !== undefined)
    throw new AgentSenderContextError(
      'authorization_conflict',
      'An agent-originated message cannot change the target chat’s approvals.',
    );
  const { selectedRepoId: _carriedRepo, ...rest } = request;
  void _carriedRepo;
  const policy = await resolveWorktreeChatApprovalPolicy(request);
  return {
    ...rest,
    approvalMode: policy.mode,
    sessionApprovalRules: policy.sessionRules,
    admittedApproval: {
      approvalMode: policy.mode,
      sessionApprovalRules: policy.sessionRules,
    },
    ...(policy.selectedRepoId ? { selectedRepoId: policy.selectedRepoId } : {}),
  };
}

/**
 * Revalidates a queued send's sender and, for a project agent's send, reads
 * the target's current approval settings and admits them again. Those settings
 * become the turn's admitted limit only if nothing approval-related changed
 * between the read and the admission; otherwise both run again, up to three
 * times, then the send is refused.
 */
async function withReadmittedQueuedSendApproval(
  request: ChatSendMessageRequest,
): Promise<ChatSendMessageRequest> {
  const hasAgentMetadata =
    request.agentSent !== undefined ||
    request.agentSenderProvenance !== undefined ||
    request.hiddenContext?.kind === 'agent-sender-context';
  const target = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const chatRevision = getChatApprovalStateRevision(target);
    const settingsRevision = getApprovalSettingsRevision();
    const readmitted = await withCurrentTargetApprovalSettings(request);
    if (hasAgentMetadata) await revalidateAgentSenderRequest(readmitted);
    if (
      readmitted === request ||
      (getChatApprovalStateRevision(target) === chatRevision &&
        getApprovalSettingsRevision() === settingsRevision)
    )
      return readmitted;
  }
  throw new AgentSenderContextError(
    'authorization_conflict',
    "The target chat's tool approvals kept changing while this message was checked.",
  );
}

/**
 * An automation's own send (CAN-4549) records its bound context on the target
 * tab before the turn, as its native path did, from the admitted request so a
 * queued row restored after a restart keeps its lineage.
 */
async function applyAutomationExecutionContext(
  request: ChatSendMessageRequest,
): Promise<string | undefined> {
  const executionContext = request.automationDispatch?.executionContext;
  if (executionContext === undefined) return undefined;
  await getChatStateService().updateCompatibilityTab(
    { projectId: request.projectId, worktreeId: request.worktreeId },
    request.chatId,
    (tab) =>
      tab.executionContext === executionContext
        ? null
        : { ...tab, executionContext },
    undefined,
    { metadataOnly: true },
  );
  return executionContext;
}

async function dispatchHostQueuedWorktreeChatMessageNow(
  request: ChatSendMessageRequest,
  origin: 'desktop' | 'portal',
  fromQueue: boolean,
  onTurnAccepted: () => void,
  authorization: AuthorizedChatDispatch | undefined,
  queueOptions: ChatQueueDispatchOptions,
): Promise<void> {
  if (
    request.managedDelegationDeliveryId &&
    (request.managedDelegationDeliveryId !== request.userMessageId ||
      !isDelegationDeliveryActive(request, request.managedDelegationDeliveryId))
  ) {
    getChatQueueService().onTurnTerminal(
      request,
      'cancelled',
      request.userMessageId,
    );
    return;
  }
  const getWindow = getWorktreeChatWindow;
  const portalOptions = portalQueueOptions.get(request);
  if (fromQueue) {
    const cancelledAutomaticRetry = cancelTransientRetryForChat(
      request,
      'queued-manual-send',
    );
    if (cancelledAutomaticRetry) {
      getChatQueueService().onTurnTerminal(
        request,
        'cancelled',
        request.userMessageId,
      );
      return;
    }
  }
  request = await withReadmittedQueuedSendApproval(request);
  // Every send pins its Agent before it is queued. One that still names a bare
  // Agent on the default model was switched to it while queued; running it
  // would re-read Settings, so it is refused before the turn starts.
  if (
    request.modelSelectionMode !== 'auto' &&
    request.model !== undefined &&
    isInheritingAgentModel(request.model)
  ) {
    throw new Error(
      `${getModelDisplayName(request.model)} now uses the default model. Choose it again, then send.`,
    );
  }
  const automationExecutionContext =
    await applyAutomationExecutionContext(request);
  // Run now on a held row and generated deliveries run with the live
  // session's settings; dispatch applies them, so the request (and the tab
  // settings saved from it) keeps the user's choice for a later turn. They
  // skip Auto routing, which would pick a model the session does not run.
  const usesLiveSessionSettings =
    (request.useLiveSessionSettings === true ||
      isGeneratedInputRequest(request)) &&
    getSessionTurnSettings(
      request.projectId,
      request.worktreeId,
      request.chatId,
    ) !== undefined;
  let dispatchRequest: ChatSendMessageRequest = usesLiveSessionSettings
    ? { ...request, useLiveSessionSettings: true }
    : request.modelSelectionMode === 'auto' && autoModelRoutingDispatcher
      ? await autoModelRoutingDispatcher(request, origin, fromQueue)
      : request;
  const terminalPlanImplementation =
    (dispatchRequest.providerType ??
      (dispatchRequest.model
        ? getProviderForModel(dispatchRequest.model)
        : 'claude')) === 'claude' &&
    isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(dispatchRequest.interfaceMode),
    ) &&
    (
      await readChatTabsFile(
        dispatchRequest.projectId,
        dispatchRequest.worktreeId,
        { chatIds: [dispatchRequest.chatId] },
      )
    ).tabs.some(
      (tab) =>
        tab.id === dispatchRequest.chatId &&
        tab.trackedPlanImplementation?.userMessageId ===
          dispatchRequest.userMessageId &&
        !tab.trackedPlanImplementation.outcome,
    );
  if (
    (dispatchRequest.agentSent || terminalPlanImplementation) &&
    isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(dispatchRequest.interfaceMode),
    )
  ) {
    // The tab may have left terminal mode after this input was queued. Deliver
    // through the live mode, or the terminal send re-enqueues it forever.
    const liveMode = (
      await readChatTabsFile(
        dispatchRequest.projectId,
        dispatchRequest.worktreeId,
      )
    ).tabs.find((tab) => tab.id === dispatchRequest.chatId)?.interfaceMode;
    if (
      !isTerminalBackedInterfaceMode(
        getEffectiveClaudeChatInterfaceMode(liveMode),
      )
    )
      dispatchRequest = { ...dispatchRequest, interfaceMode: liveMode };
  }
  if (
    (dispatchRequest.agentSent || terminalPlanImplementation) &&
    isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(dispatchRequest.interfaceMode),
    )
  ) {
    await sendWorktreeChatMessage(dispatchRequest, {
      getWindow,
      preserveActiveTab: true,
      appAdvisorSurfaces: queuedAppAdvisorSurfaces,
    });
    // The terminal session gates its own turns and never reports them to the
    // host queue, so release this turn now or later sends never drain.
    getChatQueueService().onTurnTerminal(
      dispatchRequest,
      'complete',
      dispatchRequest.userMessageId,
    );
    return;
  }

  const specialNativeTarget =
    origin === 'desktop' &&
    (isCoworkWorkspace(dispatchRequest.projectId) ||
      dispatchRequest.projectId === APP_ADVISOR_PROJECT_ID ||
      dispatchRequest.projectId === PIPELINE_EDITOR_PROJECT_ID);
  if (
    !specialNativeTarget &&
    (usesLiveSessionSettings || !isGeneratedInputRequest(dispatchRequest))
  ) {
    const target = {
      projectId: dispatchRequest.projectId,
      worktreeId: dispatchRequest.worktreeId,
      chatId: dispatchRequest.chatId,
    };
    if (
      chatHasNativeBackgroundWork(
        target.projectId,
        target.worktreeId,
        target.chatId,
      )
    ) {
      let decision:
        | Awaited<ReturnType<typeof decideTurnSessionReuse>>
        | undefined;
      try {
        // A live-settings send can still need a restart (an account, owner
        // or routing change); recreate markers wait for a later turn.
        decision = usesLiveSessionSettings
          ? await decideTurnSessionReuse(
              applyLiveSessionSettings(dispatchRequest),
              { deferRecreateMarkers: true },
            )
          : await decideTurnSessionReuse(dispatchRequest);
      } catch (error) {
        logMainProcessWarn(
          '[chat] Session reuse decision failed before dispatch:',
          error,
        );
      }
      if (decision !== undefined && holdsForBackgroundWork(target, decision)) {
        throw new TurnHeldForBackgroundWorkError();
      }
    }
  }

  if (specialNativeTarget) {
    if (!specialNativeChatDispatcher)
      throw new Error('Native chat dispatch is unavailable');
    await withAgentSenderAuthority(
      dispatchRequest,
      () => specialNativeChatDispatcher?.(dispatchRequest, authorization),
      revalidateAgentSenderRequest,
    );
    return;
  }
  // A pipeline override's model holds over a change made while it was queued.
  await getChatStateService().commitTurnOverrideModelFor(dispatchRequest);
  // The queue admitted this send: its dispatchers must not submit it again.
  const queueDispatch = authorization ? { authorization } : {};
  if (origin === 'desktop') {
    await dispatchLocalWorktreeChatMessageNow(dispatchRequest, {
      getWindow,
      onTurnAccepted,
      queueDispatch,
      ...(automationExecutionContext !== undefined
        ? { executionContext: automationExecutionContext }
        : {}),
      creditRetryAttemptId: queueOptions.creditRetryAttemptId,
      requiredAccountProxyConnectionId:
        queueOptions.requiredAccountProxyConnectionId,
      // Watchers defer the root/steering decision to the host and therefore
      // have no optimistic renderer message, even when they arrive idle.
      emitUserPrompt:
        fromQueue ||
        dispatchRequest.initiationSource === 'automation' ||
        dispatchRequest.watcherFired !== undefined ||
        dispatchRequest.agentSent !== undefined,
    });
    return;
  }
  await sendWorktreeChatMessage(dispatchRequest, {
    getWindow,
    creditRetryAttemptId: queueOptions.creditRetryAttemptId,
    appAdvisorSurfaces: queuedAppAdvisorSurfaces,
    ...portalOptions,
    ...(automationExecutionContext !== undefined
      ? { executionContext: automationExecutionContext }
      : {}),
    queueDispatch,
    ...(queueOptions.requiredAccountProxyConnectionId !== undefined
      ? {
          requiredAccountProxyConnectionId:
            queueOptions.requiredAccountProxyConnectionId,
        }
      : {}),
  });
}

/**
 * Thrown by {@link buildExistingTabDispatchOptions} when the target tab does
 * not exist. Split out from the generic `Error` cases so callers for whom a
 * missing tab is an expected state — the portal send path, where a
 * browser-minted chat has no persisted tab yet — can treat it as "no
 * persisted options to apply" instead of a failure. The `readOnly` guard
 * still throws a plain `Error`: sending into a readonly tab is never valid.
 */
export class ExistingTabDispatchTargetNotFoundError extends Error {
  constructor() {
    super('Target chat for Worktree Session prompt could not be found.');
    this.name = 'ExistingTabDispatchTargetNotFoundError';
  }
}

/**
 * Resolves the dispatch options (provider/model/session/etc.) that an
 * existing chat tab's own settings imply, for callers that need to send a
 * message into that tab from outside the renderer (automations, resume
 * flows, portal sends). Throws `ExistingTabDispatchTargetNotFoundError` if
 * the tab is missing — a caller error for automations/resume flows, an
 * expected skip for portal sends into not-yet-persisted chats — and a plain
 * `Error` if the tab is `readOnly`.
 */
/**
 * Chain uuid a pending Claude fork resume must stop at. Transcript read
 * failures propagate so callers fail closed instead of silently resuming the
 * complete source session.
 */
async function resolveClaudeForkResumeAnchor(
  projectId: string,
  worktreeId: string,
  chatId: string,
  atMessageId: string | undefined,
): Promise<string | undefined> {
  return resolveClaudeForkResumePoint(
    await readChatTranscript(projectId, worktreeId, chatId),
    atMessageId,
  );
}

const TERMINAL_CHAT_SETTING_FIELDS = [
  'model',
  'modelConfig',
  'providerType',
  'executionHarness',
  'planMode',
  'approvalMode',
  'pluginSelections',
  'interfaceMode',
] as const;

export const TERMINAL_CHAT_SETTINGS_DIFFER_MESSAGE =
  'Scheduled terminal chat settings differ from the live chat. Apply the settings in the chat before scheduling this prompt.';

/** A Claude chat whose turns run in its managed terminal. */
function isTerminalBackedClaudeTab(tab: PersistedChatTab): boolean {
  const source = tab.model
    ? getModelSource(tab.model)
    : tab.providerType === 'claude' || tab.providerType === undefined
      ? 'claude-managed'
      : undefined;
  return (
    source === 'claude-managed' &&
    isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(tab.interfaceMode),
    )
  );
}

/** Whether a request names a setting the live terminal chat would not apply. */
function terminalChatSettingsDiffer(
  tab: Pick<PersistedChatTab, (typeof TERMINAL_CHAT_SETTING_FIELDS)[number]>,
  request: object,
): boolean {
  return TERMINAL_CHAT_SETTING_FIELDS.some((field) => {
    const requested: unknown = Reflect.get(request, field);
    if (requested === undefined) return false;
    if (field === 'planMode') return requested !== (tab.planMode ?? false);
    if (field === 'approvalMode') return requested !== tab.approvalMode;
    return JSON.stringify(requested) !== JSON.stringify(tab[field]);
  });
}

/**
 * The terminal settings check of a scheduled send, run before an
 * automation's own send is dispatched (CAN-4549): the shared port commits the
 * send before delivery, so the refusal must come first to keep its text.
 */
export async function assertTerminalChatAcceptsSettings(
  target: { projectId: string; worktreeId: string; chatId: string },
  settings: Partial<
    Pick<ChatSendMessageRequest, (typeof TERMINAL_CHAT_SETTING_FIELDS)[number]>
  >,
): Promise<void> {
  const tab = (
    await readChatTabsFile(target.projectId, target.worktreeId)
  ).tabs.find((candidate) => candidate.id === target.chatId);
  if (
    tab &&
    isTerminalBackedClaudeTab(tab) &&
    terminalChatSettingsDiffer(tab, settings)
  )
    throw new Error(TERMINAL_CHAT_SETTINGS_DIFFER_MESSAGE);
}

export async function buildExistingTabDispatchOptions(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<{
  providerType?: AgentProviderType;
  executionHarness?: PersistedChatTab['executionHarness'];
  model?: ChatModel;
  modelConfig?: AgentModelConfig;
  thinkingLevel?: PersistedChatTab['thinkingLevel'];
  codexFastModeEnabled?: PersistedChatTab['codexFastModeEnabled'];
  pluginSelections?: ChatTabPluginSelections;
  sessionApprovalRules?: PersistedChatTab['sessionApprovalRules'];
  deferredToolsAllowed?: boolean;
  planMode?: boolean;
  interfaceMode?: ChatInterfaceMode;
  sdkSessionId?: string;
  globalInstructionsSnapshot?: string;
  codexReconstructionSeedId?: string;
  claudeForkSession?: boolean;
  claudeForkResumeAt?: string;
  claudeForkStartsFresh?: boolean;
  selectedRepoId?: string;
  codexProposalMode?: 'optional' | 'required';
  aiCreditsRouting?: NonNullable<PersistedChatTab['aiCreditsRouting']>;
  subscriptionBillingOverride?: boolean;
}> {
  const tabsFile = await readChatTabsFile(projectId, worktreeId);
  const tab = tabsFile.tabs.find(
    (candidate) =>
      candidate.id === chatId && (candidate.kind ?? 'chat') === 'chat',
  );
  if (!tab) {
    throw new ExistingTabDispatchTargetNotFoundError();
  }
  if (tab.readOnly) {
    throw new Error('Target chat is readonly.');
  }
  const effectiveInterfaceMode = getEffectiveClaudeChatInterfaceMode(
    tab.interfaceMode,
  );
  const persistedInterfaceMode =
    tab.interfaceMode === 'canopy'
      ? 'canopy'
      : getPersistedClaudeChatInterfaceMode(tab.interfaceMode);
  const dropTerminalSessionId =
    isTerminalBackedInterfaceMode(tab.interfaceMode) &&
    effectiveInterfaceMode === 'canopy';
  const sdkSessionId =
    tab.sdkSessionId && !dropTerminalSessionId ? tab.sdkSessionId : undefined;
  // Stale session routing is ignored, not rewritten here (CAN-4200).
  const aiCreditsRouting = effectiveTabAiCreditsRouting(
    tab.aiCreditsRouting,
    billedProviderFor(tab.providerType, tab.executionHarness),
  );
  // Terminal-backed Claude chats are supported while the Claude TUI chats flag
  // is enabled: `sendWorktreeChatMessage` detects the interface mode and
  // forwards the prompt to the renderer's terminal send path instead of
  // running a Canopy-native SDK turn. When the flag is off, the persisted mode
  // and terminal-owned sdkSessionId are read-only ignored for this dispatch.

  // Resolve the point-in-time fork anchor only while its one-shot marker is
  // active. Durable `forkedFrom` provenance outlives that handoff and must not
  // turn a later archive-restore resume into a stale point-in-time fork.
  // `readChatTabsFile` hands back metadata-only tabs whose `messages`
  // getter throws unless the transcript was explicitly selected, so the
  // transcript is read through the canonical reader rather than off `tab`.
  // A missing or unreadable anchor is not safe to degrade to a plain resume:
  // the source session may have advanced beyond the fork's kept transcript.
  const resumePointRequired =
    tab.forkedFrom?.resumePointRequired === true &&
    sdkSessionId !== undefined &&
    tab.claudeForkSessionOnNextSend === true;
  const claudeForkResumeAt =
    sdkSessionId && tab.claudeForkSessionOnNextSend && resumePointRequired
      ? await resolveClaudeForkResumeAnchor(
          projectId,
          worktreeId,
          chatId,
          tab.forkedFrom?.atMessageId,
        )
      : undefined;
  const safeSdkSessionId =
    sdkSessionId &&
    tab.claudeForkSessionOnNextSend &&
    resumePointRequired &&
    !claudeForkResumeAt
      ? undefined
      : sdkSessionId;
  const claudeForkStartsFresh =
    Boolean(sdkSessionId) &&
    tab.claudeForkSessionOnNextSend === true &&
    resumePointRequired &&
    !claudeForkResumeAt;

  return {
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(tab.executionHarness ? { executionHarness: tab.executionHarness } : {}),
    ...(tab.model ? { model: tab.model } : {}),
    ...(tab.modelConfig ? { modelConfig: tab.modelConfig } : {}),
    ...(tab.thinkingLevel ? { thinkingLevel: tab.thinkingLevel } : {}),
    ...(typeof tab.codexFastModeEnabled === 'boolean'
      ? { codexFastModeEnabled: tab.codexFastModeEnabled }
      : {}),
    ...(tab.pluginSelections ? { pluginSelections: tab.pluginSelections } : {}),
    ...(tab.sessionApprovalRules
      ? { sessionApprovalRules: tab.sessionApprovalRules }
      : {}),
    deferredToolsAllowed: tab.deferredToolsAllowed !== false,
    ...(tab.planMode == null ? {} : { planMode: tab.planMode }),
    ...(persistedInterfaceMode
      ? { interfaceMode: persistedInterfaceMode }
      : {}),
    ...(safeSdkSessionId ? { sdkSessionId: safeSdkSessionId } : {}),
    ...(safeSdkSessionId && tab.globalInstructionsSnapshot !== undefined
      ? { globalInstructionsSnapshot: tab.globalInstructionsSnapshot }
      : {}),
    ...(tab.codexReconstructionSeedId
      ? { codexReconstructionSeedId: tab.codexReconstructionSeedId }
      : {}),
    // The source session can advance between fork creation and this first
    // send, so the resume must name the last chain entry the fork kept.
    ...(safeSdkSessionId && tab.claudeForkSessionOnNextSend
      ? {
          claudeForkSession: true,
          ...(claudeForkResumeAt ? { claudeForkResumeAt } : {}),
        }
      : {}),
    ...(claudeForkStartsFresh ? { claudeForkStartsFresh: true } : {}),
    ...(tab.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
    ...(tab.proposalMode ? { codexProposalMode: tab.proposalMode } : {}),
    ...(aiCreditsRouting ? { aiCreditsRouting } : {}),
    ...(tab.subscriptionBillingOverride === true
      ? { subscriptionBillingOverride: true }
      : {}),
    ...(tab.modelSelectionMode === 'auto'
      ? { modelSelectionMode: 'auto' as const }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstLineTitle(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ? first.slice(0, 60) : `${REMOTE_CONTROL_LABEL} Chat`;
}

/**
 * A desktop send that leaves the chat to this service. Omitting `chatId` lets
 * the send reuse the worktree's empty starter tab (see the reuse lookup in
 * `sendWorktreeChatMessageNow`) instead of minting a sibling beside it, which
 * is how a prompt automation starts the only chat in a worktree it just
 * created.
 */
export interface NewChatSendMessageRequest extends Omit<
  ChatSendMessageRequest,
  'chatId'
> {
  chatId?: undefined;
}

type WorktreeChatSendRequest =
  | ChatSendMessageRequest
  | HostPortalChatSendPayload
  | NewChatSendMessageRequest;

/** Main-owned provenance can only be attached after trusted command intake. */
type TrustedWorktreeChatSendRequest = WorktreeChatSendRequest & {
  agentSent?: AgentSentInfo;
  autoResume?: AutoResumeMetadata;
};

function normalizePortalChatModelConfig(
  request: WorktreeChatSendRequest,
): AgentModelConfig | undefined {
  const normalized = normalizeAgentModelConfig(request.modelConfig) ?? {};
  if (
    normalized.fastMode === undefined &&
    typeof request.codexFastModeEnabled === 'boolean'
  ) {
    normalized.fastMode = request.codexFastModeEnabled;
  }
  if (
    normalized.thinkingLevel === undefined &&
    request.thinkingLevel !== undefined
  ) {
    normalized.thinkingLevel = request.thinkingLevel;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isChatAttachmentPromptContext(
  value: unknown,
): value is NonNullable<
  ChatSendMessageRequest['attachmentPromptContexts']
>[number] {
  if (!isRecord(value)) return false;
  return (
    typeof value.attachmentPath === 'string' &&
    isChatAttachmentPromptKind(value.promptKind)
  );
}

function getAttachmentPromptContexts(
  request: WorktreeChatSendRequest,
): ChatSendMessageRequest['attachmentPromptContexts'] {
  const value = (request as unknown as Record<string, unknown>)
    .attachmentPromptContexts;
  if (!Array.isArray(value)) return undefined;
  const contexts = value.filter(isChatAttachmentPromptContext);
  return contexts.length > 0 ? contexts : undefined;
}

function buildPersistedUserMessage(
  request: TrustedWorktreeChatSendRequest,
  userMessageId: string,
  timestamp: number,
): PersistedChatMessage {
  const attachmentPromptContexts = getAttachmentPromptContexts(request);
  const autoResume = readAutoResumeMetadata(
    'autoResume' in request ? request.autoResume : undefined,
  );
  return {
    id: userMessageId,
    role: 'user',
    // A message an external MCP agent sent stays the person's own.
    ...(autoResume ? { autoResume } : {}),
    userMessageSource: autoResume
      ? 'auto_resume'
      : 'agentSent' in request && chatAgentSent(request.agentSent)
        ? 'agent'
        : 'watcherFired' in request && request.watcherFired
          ? 'watcher'
          : 'initiationSource' in request && request.initiationSource === 'hook'
            ? 'hook'
            : 'human',
    ...('agentSent' in request && request.agentSent
      ? { agentSent: request.agentSent }
      : {}),
    timestamp,
    blocks: [
      ...(request.fileReferences?.length
        ? [
            {
              type: 'file_references' as const,
              references: request.fileReferences,
            },
          ]
        : []),
      { type: 'text', text: request.text },
    ],
    attachmentPaths: request.attachmentPaths,
    ...(attachmentPromptContexts?.length ? { attachmentPromptContexts } : {}),
    ...(autoResume && !autoResume.resendsUserMessage
      ? {}
      : { inputMode: request.inputMode ?? 'typed' }),
    ...('watcherFired' in request && request.watcherFired
      ? { watcherFired: request.watcherFired }
      : {}),
  };
}

function upsertMessage(
  messages: PersistedChatMessage[],
  message: PersistedChatMessage,
): PersistedChatMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index === -1) return [...messages, message];
  return messages.map((candidate, candidateIndex) =>
    candidateIndex === index ? message : candidate,
  );
}

/**
 * Build the `PortalChatTurnGroup[]` skeleton from a chat tab's persisted
 * messages. One group per user-message turn; all assistant messages up to
 * the next user message belong to that turn. The last assistant message in
 * each turn is treated as `final`; preceding assistant messages are
 * `intermediate` (collapsed by default on the renderer). The renderer can
 * use this to draw the same turn-group treatment the desktop uses.
 *
 * Returns `undefined` when the tab has no messages so the optional field is
 * omitted from the wire payload entirely.
 */
function deriveChatTurnGroups(
  tab: PersistedChatTab,
): PortalChatTurnGroup[] | undefined {
  if (
    tab.transcript &&
    !Object.prototype.propertyIsEnumerable.call(tab, 'messages')
  )
    return undefined;
  if (tab.messages.length === 0) return undefined;
  // Only derive groups for the message window the portal transcript cache
  // actually holds (limitPortalChatTranscript keeps the last
  // PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT). Groups referencing older messages
  // are dead weight on the wire — real worktrees carry thousands of messages,
  // and unbounded turn groups pushed worktree snapshots past the 1MiB portal
  // event cap, dropping the whole snapshot.
  const windowedTab: PersistedChatTab =
    tab.messages.length <= PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT
      ? tab
      : {
          ...tab,
          messages: tab.messages.slice(-PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT),
        };
  return deriveChatTurnGroupsFromWindow(windowedTab);
}

function deriveChatTurnGroupsFromWindow(
  tab: PersistedChatTab,
): PortalChatTurnGroup[] | undefined {
  const groups: PortalChatTurnGroup[] = [];
  let pendingUserMessageId: string | null = null;
  let pendingAssistantIds: string[] = [];
  let pendingMessages: PersistedChatMessage[] = [];

  const counts: Required<
    Omit<
      NonNullable<PortalChatTurnGroup['summary']>,
      'thinkingCount' | 'messageCount'
    >
  > = {
    bashCount: 0,
    readCount: 0,
    editCount: 0,
    writeCount: 0,
    planCount: 0,
    grepCount: 0,
    globCount: 0,
    todoCount: 0,
    webCount: 0,
    agentCount: 0,
    askUserCount: 0,
    scriptOutputCount: 0,
    claudeCount: 0,
    watcherCount: 0,
    canopyCount: 0,
    graphCount: 0,
    computerUseCount: 0,
    otherCount: 0,
  };

  const resetCounts = (): void => {
    counts.bashCount = 0;
    counts.readCount = 0;
    counts.editCount = 0;
    counts.writeCount = 0;
    counts.planCount = 0;
    counts.grepCount = 0;
    counts.globCount = 0;
    counts.todoCount = 0;
    counts.webCount = 0;
    counts.agentCount = 0;
    counts.askUserCount = 0;
    counts.scriptOutputCount = 0;
    counts.claudeCount = 0;
    counts.watcherCount = 0;
    counts.canopyCount = 0;
    counts.graphCount = 0;
    counts.computerUseCount = 0;
    counts.otherCount = 0;
  };

  const flush = (): void => {
    if (!pendingUserMessageId) return;
    const finalMessageIds =
      pendingAssistantIds.length > 0 ? [pendingAssistantIds.slice(-1)[0]] : [];
    const intermediateMessageIds =
      pendingAssistantIds.length > 1 ? pendingAssistantIds.slice(0, -1) : [];
    const summary: PortalChatTurnGroup['summary'] = {};
    if (counts.bashCount > 0) summary.bashCount = counts.bashCount;
    if (counts.readCount > 0) summary.readCount = counts.readCount;
    if (counts.editCount > 0) summary.editCount = counts.editCount;
    if (counts.writeCount > 0) summary.writeCount = counts.writeCount;
    if (counts.planCount > 0) summary.planCount = counts.planCount;
    if (counts.grepCount > 0) summary.grepCount = counts.grepCount;
    if (counts.globCount > 0) summary.globCount = counts.globCount;
    if (counts.todoCount > 0) summary.todoCount = counts.todoCount;
    if (counts.webCount > 0) summary.webCount = counts.webCount;
    if (counts.agentCount > 0) summary.agentCount = counts.agentCount;
    if (counts.askUserCount > 0) summary.askUserCount = counts.askUserCount;
    if (counts.scriptOutputCount > 0) {
      summary.scriptOutputCount = counts.scriptOutputCount;
    }
    if (counts.claudeCount > 0) summary.claudeCount = counts.claudeCount;
    if (counts.watcherCount > 0) summary.watcherCount = counts.watcherCount;
    if (counts.canopyCount > 0) summary.canopyCount = counts.canopyCount;
    if (counts.graphCount > 0) summary.graphCount = counts.graphCount;
    if (counts.computerUseCount > 0) {
      summary.computerUseCount = counts.computerUseCount;
    }
    if (counts.otherCount > 0) summary.otherCount = counts.otherCount;
    groups.push({
      userMessageId: pendingUserMessageId,
      intermediateMessageIds,
      finalMessageIds,
      files: collectTurnFiles(
        mergeToolResults(reorderMessagesForDisplay(pendingMessages)),
      ),
      ...(Object.keys(summary).length > 0 ? { summary } : {}),
    });
    pendingUserMessageId = null;
    pendingAssistantIds = [];
    pendingMessages = [];
    resetCounts();
  };

  for (const message of tab.messages) {
    if (message.role === 'user') {
      flush();
      pendingUserMessageId = message.id;
      continue;
    }
    if (!pendingUserMessageId) continue;
    pendingMessages.push(message);
    pendingAssistantIds.push(message.id);
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      const family = getPortalChatToolFamily(block.toolName);
      switch (family) {
        case 'bash':
          counts.bashCount += 1;
          break;
        case 'read':
          counts.readCount += 1;
          break;
        case 'edit':
          counts.editCount += 1;
          break;
        case 'write':
          if (!isPlanFileWrite(block.toolName, block.input)) {
            counts.writeCount += 1;
          }
          break;
        case 'plan':
          counts.planCount += 1;
          break;
        case 'grep':
          counts.grepCount += 1;
          break;
        case 'glob':
          counts.globCount += 1;
          break;
        case 'todo':
          counts.todoCount += 1;
          break;
        case 'web':
          counts.webCount += 1;
          break;
        case 'agent':
          counts.agentCount += 1;
          break;
        case 'ask-user':
          counts.askUserCount += 1;
          break;
        case 'script-output':
          counts.scriptOutputCount += 1;
          break;
        case 'claude':
          counts.claudeCount += 1;
          break;
        case 'watcher':
          counts.watcherCount += 1;
          break;
        case 'canopy':
          counts.canopyCount += 1;
          break;
        case 'graph':
          counts.graphCount += 1;
          break;
        case 'computer-use':
          counts.computerUseCount += 1;
          break;
        default:
          counts.otherCount += 1;
      }
    }
  }
  flush();
  return groups.length > 0 ? groups : undefined;
}

function summarizePluginSelections(
  selections: ChatTabPluginSelections | undefined,
): PortalChatSummaryPluginSelections | undefined {
  if (!selections) {
    return undefined;
  }
  return {
    collectionIds: selections.collectionIds,
    skillCount: selections.skillRefs.length,
    pluginCount: selections.pluginRefs.length,
    mcpServerCount: selections.mcpServerRefs?.length ?? 0,
  };
}

/**
 * Project the full selection refs (CAN-1219) so the portal plugins selector can
 * seed its checkboxes exactly. Only the selection-key fields are surfaced; the
 * MCP HTTP auth preferences are desktop-only runtime state and intentionally not
 * projected. Returns undefined when the tab has no selections.
 */
function detailPluginSelections(
  selections: ChatTabPluginSelections | undefined,
): PortalChatTabPluginSelections | undefined {
  if (!selections) {
    return undefined;
  }
  return {
    collectionIds: selections.collectionIds,
    skillRefs: selections.skillRefs,
    pluginRefs: selections.pluginRefs,
    ...(selections.mcpServerRefs
      ? { mcpServerRefs: selections.mcpServerRefs }
      : {}),
  };
}

/**
 * 0-based position of a chat tab within the worktree's chat-kind tabs (the tabs
 * the portal renders). This is the authoritative portal tab-bar ordering key —
 * it mirrors the desktop's exact order including manual reorders and never moves
 * on chat activity. Returns -1 when the id is not a chat tab.
 */
function chatTabOrder(
  tabs: readonly PersistedChatTab[],
  chatId: string,
): number {
  return tabs
    .filter((tab) => (tab.kind ?? 'chat') === 'chat')
    .findIndex((tab) => tab.id === chatId);
}

type ScheduledMessageChatIdentity = {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
};

type ScheduledMessageSummaryContext = {
  scheduledMessagesIndex:
    | ReadonlyMap<string, PortalChatScheduledMessages>
    | undefined;
  scheduledMessageChatKey: (identity: ScheduledMessageChatIdentity) => string;
};

/**
 * Read the scheduled-send projection once per summary operation. Automations
 * imports chat-service for dispatch, so keep this edge deferred to avoid a
 * service initialization cycle. Explicit summary listings hydrate the facts
 * even without Portal; emission callers gate this read on Portal activity.
 */
async function getScheduledMessageSummaryContext(): Promise<ScheduledMessageSummaryContext> {
  const { getAutomationsService, scheduledMessageChatKey } =
    await import('../automations/service');
  return {
    scheduledMessagesIndex:
      await getAutomationsService().getScheduledMessagesIndex(),
    scheduledMessageChatKey,
  };
}

function chatSummaryEntity(input: {
  workspaceId: string;
  worktreeId: string;
  tab: PersistedChatTab;
  active: boolean;
  /** 0-based index among chat-kind tabs; omitted from the entity when < 0. */
  order: number;
  /** Omit for streaming-only updates; pass an array for file-backed state. */
  pendingQuestions?: readonly PersistedPendingQuestion[];
  /**
   * Worktree and App Advisor chats are the Portal surfaces this builder
   * projects Cursor for (Cowork summaries project it in their own builder).
   * Required (not defaulted) so a future caller cannot silently advertise
   * the managed Cursor runtime on another surface by omitting it.
   * `emitTargetChatSummary` routes App Advisor and Cowork workspace ids to
   * their own dedicated summary builders before ever reaching this
   * function, so it always passes `'worktree'` explicitly.
   * `listAppAdvisorChatSummaries` is the sole caller that passes
   * `'app-advisor'`.
   */
  surface: 'worktree' | 'app-advisor';
  owner: WorkOwner | undefined;
  /** See `resolveCatalogAgentDefaultModel`. */
  agentDefaultModel: string | undefined;
  scheduledMessagesIndex?: ReadonlyMap<string, PortalChatScheduledMessages>;
  scheduledMessageChatKey?: (identity: ScheduledMessageChatIdentity) => string;
}): PortalChatSummaryEntity {
  const surface = input.surface;
  const inputSession = getInputSession(
    input.workspaceId,
    input.worktreeId,
    input.tab.id,
  );
  const steeringCapabilities = inputSession?.getSteeringCapabilities?.();
  const queueSnapshot = getChatQueueService()
    .getWorktreeSnapshots(input.workspaceId, input.worktreeId)
    .find((snapshot) => snapshot.chatId === input.tab.id);
  const queuedMessages =
    queueSnapshot?.queue.map((message) => ({
      id: message.id,
      text: message.text,
      origin: message.origin,
      promptSource: message.promptSource,
      ...(message.autoResume ? { autoResume: message.autoResume } : {}),
      supersedesUserMessageId: message.supersedesUserMessageId,
      enqueuedAtMs: message.enqueuedAtMs,
      attachmentEditsPreservePayload: true,
      ...(message.turnPhase !== undefined
        ? { turnPhase: message.turnPhase }
        : {}),
      ...(message.retryable === true ? { retryable: true } : {}),
      ...(message.retryBlockedReason
        ? { retryBlockedReason: message.retryBlockedReason }
        : {}),
      ...(message.editLocked === true ? { editLocked: true } : {}),
      ...(message.forceLocked === true ? { forceLocked: true } : {}),
      ...(message.canSteer === true ? { canSteer: true } : {}),
      ...(message.agentSent ? { agentSent: message.agentSent } : {}),
      ...(message.steerBlockedByCapabilityChange === true
        ? { steerBlockedByCapabilityChange: true }
        : {}),
      ...(message.waitingReason !== undefined
        ? { waitingReason: message.waitingReason }
        : {}),
      ...(message.fileReferences?.length ||
      message.attachmentPaths?.length ||
      message.attachmentPromptContexts?.length
        ? { hasAttachments: true }
        : {}),
    })) ?? [];
  // Live turn state for this chat, read straight from the session manager
  // (a cheap in-memory map lookup; no probe). Projecting it is what lets a
  // portal that attaches MID-TURN show the working indicator at all -- the
  // live `turn_timer` frame only covers turns that start while the portal is
  // connected, and only portal-initiated ones (CAN-2525).
  const activeTurnSession = getActiveSessionInfos(
    input.workspaceId,
    input.worktreeId,
  ).find((session) => session.chatId === input.tab.id && session.turnActive);
  // The canonical turn decides (turn-state phase 41a): background work is
  // not a running turn, and a wake is one with no dispatched session turn.
  const chatState = getChatStateService();
  const canonicalTurn = chatState.getTurnState({
    projectId: input.workspaceId,
    worktreeId: input.worktreeId,
    chatId: input.tab.id,
  });
  const turnActive = summaryTurnActive(
    activeTurnSession !== undefined,
    canonicalTurn?.phase,
  );
  const turnStartedAt =
    activeTurnSession?.turnStartedAt ??
    (canonicalTurn?.phase === 'foreground'
      ? canonicalTurn.current?.startedAtMs
      : undefined);
  const turnElapsedMs = !turnActive
    ? undefined
    : (activeTurnSession?.turnElapsedMs ??
      (turnStartedAt !== undefined
        ? Math.max(0, Date.now() - turnStartedAt)
        : undefined));
  // Sent whenever canonical state exists, zero included, so a delta clears it.
  const backgroundTasks = canonicalTurn
    ? backgroundTaskCount(
        canonicalTurn.background.managed,
        canonicalTurn.background.native,
      )
    : undefined;
  const lastMessageAt = input.tab.transcript
    ? input.tab.transcript.lastMessageAt
    : input.tab.messages[input.tab.messages.length - 1]?.timestamp;
  // Mirror the desktop composer usage-limit banner (CAN-2601). Same
  // visibility predicate as the renderer (`useWorktreeChatSurfaceState`): the
  // persisted banner is live unless its exact dismiss key was dismissed. The
  // raw limit frames are never projected as transcript messages, so this
  // field is the portal's only signal.
  const usageLimitBanner = input.tab.llmProviderUsageLimitBanner;
  const usageLimit =
    usageLimitBanner !== undefined &&
    input.tab.dismissedLlmProviderUsageLimitBannerKey !==
      usageLimitBanner.dismissKey
      ? {
          provider: usageLimitBanner.provider,
          ...(usageLimitBanner.message
            ? { message: usageLimitBanner.message }
            : {}),
          ...(usageLimitBanner.resetsAt !== undefined
            ? { resetsAt: usageLimitBanner.resetsAt }
            : {}),
          dismissKey: usageLimitBanner.dismissKey,
        }
      : undefined;
  const chatTurnGroups = deriveChatTurnGroups(input.tab);
  const lastTurnEnd = projectPortalLastTurnEnd(input.tab);
  const normalizedPluginSelections = input.tab.pluginSelections
    ? normalizePluginSelections(input.tab.pluginSelections)
    : undefined;
  const pluginSelections = summarizePluginSelections(
    normalizedPluginSelections,
  );
  const pluginSelectionsDetail = detailPluginSelections(
    normalizedPluginSelections,
  );
  return {
    localId: input.tab.id,
    chatId: input.tab.id,
    scope: 'worktree',
    hasUnread: input.tab.unread === true,
    queuedMessages,
    ...(queueSnapshot?.waitingDelegationIds === undefined
      ? {}
      : { waitingDelegationIds: queueSnapshot.waitingDelegationIds }),
    steeringCapabilities,
    inputDelivery: inputDeliveryViews(
      input.tab.inputDelivery,
      steeringCapabilities,
    ),
    workspaceLocalId: input.workspaceId,
    worktreeLocalId: input.worktreeId,
    title: input.tab.title,
    ...(input.tab.customTitle !== undefined
      ? { customTitle: input.tab.customTitle }
      : {}),
    description: input.tab.description,
    turnActive,
    ...(turnElapsedMs !== undefined ? { turnElapsedMs } : {}),
    ...(canonicalTurn ? { turnPhase: canonicalTurn.phase } : {}),
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
    ...(canonicalTurn
      ? {
          awaitingApproval: hasPendingApprovalForChat({
            projectId: input.workspaceId,
            worktreeId: input.worktreeId,
            chatId: input.tab.id,
          }),
          // Omitted when the index is unknown, rather than reported as 0.
          ...(input.scheduledMessagesIndex && input.scheduledMessageChatKey
            ? {
                scheduledMessages: input.scheduledMessagesIndex.get(
                  input.scheduledMessageChatKey({
                    workspaceId: input.workspaceId,
                    worktreeId: input.worktreeId,
                    chatId: input.tab.id,
                  }),
                ) ?? { count: 0 },
              }
            : {}),
        }
      : {}),
    // The Portal tray's delegates row (turn-state phase 41e).
    ...(canonicalTurn
      ? {
          backgroundDelegations:
            canonicalTurn.background.managed.live +
            canonicalTurn.background.managed.queued,
        }
      : {}),
    ...(usageLimit ? { usageLimit } : {}),
    ...(input.tab.providerType === 'opencode' ||
    input.tab.model?.startsWith('opencode:')
      ? {
          usage: {
            model: input.tab.model,
            opencodeReportedUsage:
              input.tab.usage?.opencodeReportedUsage ?? null,
          },
        }
      : {}),
    // Authoritative tab-bar order = the tab's position among chat tabs (parity
    // with desktop, incl. manual reorders). `lastMessageAt` reflects recency and
    // must NOT drive tab order — chatting in a tab would otherwise slide it to
    // the end. `createdAt` is the secondary key for desktops that predate
    // `order`; a brand-new empty chat's `lastMessageAt` falls back to its
    // `createdAt`, so ordering by recency would wrongly float it around.
    ...(input.order >= 0 ? { order: input.order } : {}),
    createdAt: input.tab.createdAt,
    lastMessageRole: chatLastMessageRole(input.tab),
    lastMessageAt:
      lastMessageAt !== undefined
        ? new Date(lastMessageAt).toISOString()
        : input.tab.createdAt,
    messageCount:
      input.tab.transcript?.messageCount ??
      input.tab.transcript?.committedMessageCount ??
      input.tab.messages.length,
    modelLabel: input.tab.model
      ? getModelDisplayName(input.tab.model)
      : undefined,
    providerType: input.tab.providerType,
    executionHarness: input.tab.executionHarness,
    modelHarnessLocked:
      hasChatContinuationSession(input.tab) ||
      (input.tab.transcript?.messageCount ??
        input.tab.transcript?.committedMessageCount ??
        input.tab.messages.length) > 0 ||
      queuedMessages.length > 0 ||
      turnActive,

    selectedRepoId: input.tab.selectedRepoId,
    active: input.active,
    // Projected composer state (CAN-1217) so the portal chips seed from and
    // reconcile against desktop-side flips.
    planMode: input.tab.planMode,
    forkContext: input.tab.forkedFrom?.modelContext ?? null,
    planReview:
      surface === 'worktree' &&
      input.tab.planMode &&
      input.tab.trackedPlanSource === 'opencode' &&
      input.tab.trackedPlanReviewStatus === 'pending' &&
      input.tab.pendingPlanExit?.source === 'opencode' &&
      input.tab.pendingPlanExitRequestId &&
      input.tab.trackedPlanId &&
      input.tab.latestRevisionNumber !== undefined
        ? {
            source: 'opencode',
            requestId: input.tab.pendingPlanExitRequestId,
            planId: input.tab.trackedPlanId,
            revisionNumber: input.tab.latestRevisionNumber,
          }
        : null,

    // Modern canonical field first: settings patches update
    // `modelConfig.thinkingLevel`; the top-level field is legacy read-compat.
    thinkingLevel:
      input.tab.modelConfig?.thinkingLevel ?? input.tab.thinkingLevel,
    fastMode: input.tab.modelConfig?.fastMode,
    speed: readCodexSpeedRecord(input.tab.modelConfig),
    model: input.tab.model,
    ...(input.tab.modelSelectionMode === 'auto'
      ? { modelSelectionMode: 'auto' as const }
      : {}),
    ...(surface === 'worktree' && isDesktopModelRoutingSupported()
      ? { modelRoutingSupported: true as const }
      : {}),
    // Worktree and App Advisor chats both dispatch Cursor on the desktop's
    // managed runtime, so their projections carry the Cursor rows and the
    // runtime-connected key. Cowork stays native-auth-only (it refuses
    // Cursor), which is why that peek keeps the key out.
    providerAvailability: peekPortalProviderAvailability(),
    // Deriving the catalog walks the full model + custom-Agent registry, and
    // this entity is rebuilt on every streaming message upsert. Skip that work
    // entirely when no portal client is connected (the common desktop-only
    // case) — the emitted event no-ops on the sink anyway, so the catalog is
    // only ever consumed while a portal session is active.
    availableModels: isCanopyPortalActive()
      ? buildProjectedModelCatalog(undefined, {
          cursor: true,
          copilot: true,
          opencode: true,
          owner: input.owner,
          agentDefaultModel: input.agentDefaultModel,
        })
      : undefined,
    ...(pluginSelections ? { pluginSelections } : {}),
    ...(pluginSelectionsDetail ? { pluginSelectionsDetail } : {}),
    deferredToolsAllowed: input.tab.deferredToolsAllowed !== false,
    ...(chatTurnGroups ? { chatTurnGroups } : {}),
    ...(lastTurnEnd ? { lastTurnEnd } : {}),
    ...(input.pendingQuestions !== undefined
      ? {
          pendingQuestions: projectPortalQuestionStates(
            input.tab.id,
            input.pendingQuestions,
          ),
        }
      : {}),
  };
}

function emitChatSummary(summary: PortalChatSummaryEntity): void {
  if (!summary.workspaceLocalId || !summary.worktreeLocalId) {
    logMainProcessWarn(
      '[chat-service] emitChatSummary: skipping summary with missing workspace/worktree id',
      { chatId: summary.chatId },
    );
    return;
  }
  enqueuePortalEvent(
    createPortalEvent('portal.state.delta', {
      scope: 'chat',
      target: {
        workspaceLocalId: summary.workspaceLocalId,
        worktreeLocalId: summary.worktreeLocalId,
        chatLocalId: summary.chatId,
      },
      entities: [
        {
          entityType: 'chat_summary',
          localId: summary.chatId,
          parentLocalId: worktreeScopedParentLocalId(
            summary.workspaceLocalId,
            summary.worktreeLocalId,
          ),
          payload: summary,
        },
      ],
      generatedAt: new Date().toISOString(),
    }),
  );
}

const lastEmittedTodoFingerprints = new Map<string, string>();

function chatTodoProjection(input: {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
  messages: readonly PersistedChatMessage[];
}): PortalChatTodoProjection {
  return {
    localId: input.chatId,
    workspaceLocalId: input.workspaceId,
    worktreeLocalId: input.worktreeId,
    chatId: input.chatId,
    items: projectTodoItems([...input.messages]),
  };
}

function makeTodoKey(
  workspaceId: string,
  worktreeId: string,
  chatId: string,
): string {
  return [workspaceId, worktreeId, chatId].join('\u0000');
}

function emitChatTodo(projection: PortalChatTodoProjection): void {
  const key = makeTodoKey(
    projection.workspaceLocalId,
    projection.worktreeLocalId,
    projection.chatId,
  );
  const fingerprint = JSON.stringify(projection.items);
  if (lastEmittedTodoFingerprints.get(key) === fingerprint) {
    return;
  }
  enqueuePortalEvent(
    createPortalEvent('portal.state.delta', {
      scope: 'chat',
      target: {
        workspaceLocalId: projection.workspaceLocalId,
        worktreeLocalId: projection.worktreeLocalId,
        chatLocalId: projection.chatId,
      },
      entities: [
        {
          entityType: 'chat_todo',
          localId: projection.chatId,
          parentLocalId: worktreeScopedParentLocalId(
            projection.workspaceLocalId,
            projection.worktreeLocalId,
          ),
          payload: projection,
        },
      ],
      generatedAt: new Date().toISOString(),
    }),
  );
  // Recorded only once enqueued, so a retried failed emit is not deduped away.
  lastEmittedTodoFingerprints.set(key, fingerprint);
}

export async function listWorktreeTodoEntities(input: {
  workspaceId: string;
  worktreeId: string;
}): Promise<PortalChatTodoProjection[]> {
  validateId(input.workspaceId, 'workspaceId');
  validateId(input.worktreeId, 'worktreeId');
  const tabsFile = await portalChatTabsCache.read(
    input.workspaceId,
    input.worktreeId,
  );
  return tabsFile.tabs
    .filter((tab) => (tab.kind ?? 'chat') === 'chat')
    .map((tab) => ({
      ...chatTodoProjection({
        ...input,
        chatId: tab.id,
        messages: tab.transcript ? [] : tab.messages,
      }),
      ...(tab.transcript
        ? {
            items: [
              ...(tab.transcript.todos ?? []).map((item) => ({
                ...item,
                id: `todo:${item.id}`,
              })),
              ...(tab.transcript.taskTodos ?? []),
            ],
          }
        : {}),
    }));
}

export async function projectWorktreeChatTodos(input: {
  workspaceId: string;
  worktreeId: string;
}): Promise<void> {
  try {
    await projectWorktreeChatTodosStrict(input);
  } catch {
    // Projection is a best-effort mirror; the persisted tab write is durable.
  }
}

/**
 * {@link projectWorktreeChatTodos} that rejects on failure, for the
 * post-commit projection, which retries failed runs.
 */
export async function projectWorktreeChatTodosStrict(input: {
  workspaceId: string;
  worktreeId: string;
}): Promise<void> {
  if (!isCanopyPortalActive() || isCoworkWorkspace(input.workspaceId)) {
    return;
  }
  // The summary projection currently reaches this cache path without the
  // equivalent cowork guard. TODOs deliberately match the live projection
  // path and exclude cowork workspaces in both entry points.
  const projections = await listWorktreeTodoEntities(input);
  for (const projection of projections) {
    emitChatTodo(projection);
  }
}

export function projectChatTodoFromMessages(input: {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
  messages: readonly PersistedChatMessage[];
}): void {
  if (!isCanopyPortalActive() || isCoworkWorkspace(input.workspaceId)) {
    return;
  }
  emitChatTodo(chatTodoProjection(input));
}

export function projectWorktreeChatTodoRemovals(input: {
  workspaceId: string;
  worktreeId: string;
  removedChatIds: readonly string[];
}): void {
  if (!isCanopyPortalActive() || input.removedChatIds.length === 0) {
    return;
  }
  for (const chatId of input.removedChatIds) {
    lastEmittedTodoFingerprints.delete(
      makeTodoKey(input.workspaceId, input.worktreeId, chatId),
    );
    enqueuePortalEvent(
      createPortalEvent('portal.state.delta', {
        scope: 'chat',
        target: {
          workspaceLocalId: input.workspaceId,
          worktreeLocalId: input.worktreeId,
          chatLocalId: chatId,
        },
        removed: [
          {
            entityType: 'chat_todo',
            localId: chatId,
            parentLocalId: worktreeScopedParentLocalId(
              input.workspaceId,
              input.worktreeId,
            ),
          },
        ],
        generatedAt: new Date().toISOString(),
      }),
    );
  }
}

async function emitTargetChatSummary(input: {
  workspaceId: string;
  worktreeId: string;
  tab: PersistedChatTab;
  active: boolean;
  order: number;
  owner?: { value: WorkOwner | undefined };
}): Promise<void> {
  if (input.workspaceId === APP_ADVISOR_PROJECT_ID) {
    // App Advisor chats project as `app_advisor_chat` entities, never as
    // worktree-scoped `chat_summary` rows keyed on the sentinel ids
    // (CAN-2565). Re-read-and-project keeps one summary shape for the send
    // path and the tab-persist choke point.
    await projectAppAdvisorChatSummaries(input.worktreeId);
    return;
  }
  if (isCoworkWorkspace(input.workspaceId)) {
    // Keep this import deferred to avoid the chat-service/standalone-chat-service
    // cycle while loading the Electron main-process service graph.
    const { emitStandaloneChatSummaryForTab } =
      await import('./standalone-chat-service');
    await emitStandaloneChatSummaryForTab(
      input.workspaceId,
      input.worktreeId,
      input.tab,
      input.active,
      input.owner,
    );
    return;
  }
  const owner = input.owner
    ? input.owner.value
    : await resolveAiCreditsScopeOwner({
        kind: 'work',
        projectId: input.workspaceId,
        worktreeId: input.worktreeId,
        chatId: input.tab.id,
      });
  const active =
    getActiveChatIds(input.workspaceId, input.worktreeId).includes(
      input.tab.id,
    ) ||
    getChatQueueService().isTurnActive({
      projectId: input.workspaceId,
      worktreeId: input.worktreeId,
      chatId: input.tab.id,
    });
  const agentDefaultModel = await catalogAgentDefaultModel(input.workspaceId);
  const scheduledMessageContext = isCanopyPortalActive()
    ? await getScheduledMessageSummaryContext()
    : undefined;
  emitChatSummary(
    chatSummaryEntity({
      ...input,
      active,
      surface: 'worktree',
      owner,
      agentDefaultModel,
      ...(scheduledMessageContext ?? {}),
    }),
  );
}

export async function emitLatestTargetChatSummary(input: {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  const latestTabsFile = await readChatTabsFile(
    input.workspaceId,
    input.worktreeId,
  ).catch(() => null);
  if (!latestTabsFile) {
    return;
  }
  const latestTab = latestTabsFile.tabs.find((tab) => tab.id === input.chatId);
  if (!latestTab) {
    return;
  }
  await emitTargetChatSummary({
    workspaceId: input.workspaceId,
    worktreeId: input.worktreeId,
    tab: latestTab,
    active:
      getActiveChatIds(input.workspaceId, input.worktreeId).includes(
        input.chatId,
      ) ||
      getChatQueueService().isTurnActive({
        projectId: input.workspaceId,
        worktreeId: input.worktreeId,
        chatId: input.chatId,
      }),
    order: chatTabOrder(latestTabsFile.tabs, input.chatId),
  });
}

function refreshChangedChatSummary(
  identity: ScheduledMessageChatIdentity,
): Promise<void> {
  if (!isCanopyPortalActive()) {
    return Promise.resolve();
  }
  return emitLatestTargetChatSummary(identity).catch(() => undefined);
}

subscribePendingApprovalChanges((identity) => {
  void refreshChangedChatSummary({
    workspaceId: identity.projectId,
    worktreeId: identity.worktreeId,
    chatId: identity.chatId,
  });
});

// Automations imports chat-service for dispatch. Defer subscriber registration
// until both modules have initialized, regardless of which service is loaded
// first; this is an event subscription, not polling.
void import('../automations/service')
  .then(({ subscribeScheduledMessageChanges }) => {
    subscribeScheduledMessageChanges((identities) => {
      if (!isCanopyPortalActive()) {
        return;
      }
      for (const identity of identities) {
        void refreshChangedChatSummary(identity);
      }
    });
  })
  .catch(() => undefined);

/** A host queue update must use the target's actual Portal entity family. */
export async function projectChatQueueSummary(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  if (!isCanopyPortalActive()) return;
  try {
    await emitLatestTargetChatSummary({
      workspaceId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
    });
  } catch {
    // The canonical queue is durable; a disconnected mirror can hydrate later.
  }
}

async function consumeClaudeForkSessionMarkerWithOrder(input: {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
  sessionId: string;
}): Promise<{ tab: PersistedChatTab; order: number } | null> {
  const consumed = await consumePersistedClaudeForkSessionMarker(input);
  return consumed
    ? { tab: consumed.tab, order: chatTabOrder(consumed.tabs, input.chatId) }
    : null;
}

async function consumePersistedPendingSystemInstructions(input: {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
  instructionIds: readonly string[];
}): Promise<{ tab: PersistedChatTab; order: number } | null> {
  const consumedIds = new Set(input.instructionIds);
  return enqueueChatTabMutation(
    input.workspaceId,
    input.worktreeId,
    async () => {
      const result = await getChatStateService().updateCompatibilityTab(
        { projectId: input.workspaceId, worktreeId: input.worktreeId },
        input.chatId,
        (tab) => {
          if (!tab.pendingSystemInstructions?.length) return null;
          const remaining = tab.pendingSystemInstructions.filter(
            (instruction) => !consumedIds.has(instruction.id),
          );
          if (remaining.length === tab.pendingSystemInstructions.length) {
            return null;
          }
          const updatedTab: PersistedChatTab = { ...tab };
          if (remaining.length > 0) {
            updatedTab.pendingSystemInstructions = remaining;
          } else {
            delete updatedTab.pendingSystemInstructions;
          }
          return updatedTab;
        },
        `consume-system-instructions:${input.chatId}:${Array.from(consumedIds).sort().join(',')}`,
        { metadataOnly: true },
      );
      if (!result.updated) return null;
      const updatedTab = result.tabsFile.tabs.find(
        (candidate) => candidate.id === input.chatId,
      );
      if (!updatedTab) return null;
      return {
        tab: updatedTab,
        order: chatTabOrder(result.tabsFile.tabs, input.chatId),
      };
    },
  );
}

/** The catalog Agent default for a projected summary; skipped with no Portal. */
async function catalogAgentDefaultModel(
  projectId: string,
): Promise<string | undefined> {
  if (!isCanopyPortalActive()) return undefined;
  const { resolveCatalogAgentDefaultModel } =
    await import('../agents/agent-default-model');
  return resolveCatalogAgentDefaultModel(projectId);
}

export function assertWorktreeChatSendNotSplitLocked(
  projectId: string,
  worktreeId: string,
): NonNullable<ReturnType<typeof resolveWorktreeTargetIds>> {
  // Keep the split-lock guard at the service chokepoint so backend automation
  // and Portal sends cannot bypass the renderer IPC handler's equivalent check.
  // Managed chats persist under sentinel IDs but borrow a real worktree, so
  // enforce the lock against that resolved worktree rather than the sentinel.
  const splitLockTarget = resolveWorktreeTargetIds(projectId, worktreeId);
  if (!splitLockTarget) {
    throw new Error('Managed chat target could not be resolved.');
  }
  assertNotSplitLocked(
    splitLockTarget.projectId,
    splitLockTarget.worktreeId,
    'sending a chat message',
  );
  return splitLockTarget;
}

/** The existing send-without-chatId empty-tab policy, shared by creation. */
export function isReusableEmptyChatTab(tab: PersistedChatTab): boolean {
  return (
    (tab.kind ?? 'chat') === 'chat' &&
    (tab.transcript?.messageCount ??
      tab.transcript?.committedMessageCount ??
      tab.messages.length) === 0 &&
    !isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(tab.interfaceMode),
    )
  );
}

/**
 * Persist the tab a later `sendWorktreeChatMessage` with the same request
 * adopts, before that send, through the same chat state owner. A no-op for an
 * existing tab. A request that preserves the active tab creates it in the
 * background.
 */
export async function reserveWorktreeChatForSend(
  request: ChatSendMessageRequest,
): Promise<void> {
  await getChatStateService().ensureChatForTrustedSend(request);
}

/**
 * The approval policy a send to this existing chat runs its turn with: the
 * mode the send resolves (the tab's mode, clamped to its live turn's mode,
 * else the persisted defaults of its workspace and surface), the session
 * grants approved in the chat, which the tab holds before they take effect,
 * and its execution root.
 */
export async function resolveWorktreeChatApprovalPolicy(
  target: Pick<ChatSendMessageRequest, 'projectId' | 'worktreeId' | 'chatId'>,
): Promise<{
  mode: ApprovalMode;
  tabMode?: ApprovalMode;
  sessionRules: ApprovalRule[];
  root?: string;
  selectedRepoId?: string;
}> {
  const resolved = resolveWorktreeTargetIds(
    target.projectId,
    target.worktreeId,
  );
  const tabsFile = await readChatTabsFile(target.projectId, target.worktreeId, {
    chatIds: [target.chatId],
  });
  const tab = tabsFile.tabs.find((candidate) => candidate.id === target.chatId);
  const mode = await resolvePersistedApprovalMode(
    resolved?.projectId ?? target.projectId,
    resolved?.worktreeId ?? target.worktreeId,
    clampToLiveApprovalMode(
      target.projectId,
      target.worktreeId,
      target.chatId,
      tab?.approvalMode,
    ),
  );
  const root = resolveChatExecutionRoot(target, tab?.selectedRepoId);
  return {
    mode,
    ...(tab?.approvalMode ? { tabMode: tab.approvalMode } : {}),
    sessionRules: tab?.sessionApprovalRules ?? [],
    ...(root ? { root } : {}),
    ...(tab?.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
  };
}

/**
 * The directory a chat's turns run in, which its approval session uses as
 * the root Auto writes within and relative rules resolve against. Undefined
 * when the worktree record no longer resolves.
 */
export function resolveChatExecutionRoot(
  target: Pick<ChatSendMessageRequest, 'projectId' | 'worktreeId'>,
  selectedRepoId: string | undefined,
): string | undefined {
  try {
    return resolveWorktreeCwd(
      target.projectId,
      target.worktreeId,
      selectedRepoId,
    );
  } catch {
    return undefined;
  }
}

/**
 * The chats among `chatIds` in one worktree or Work Entry whose turns their
 * managed Claude Code terminal drives, which a revisioned send refuses
 * (`resolveTerminalDrivenChat`, the rule `authorizeSend` applies).
 */
export async function listTerminalDrivenChatIds(
  target: Pick<ChatSendMessageRequest, 'projectId' | 'worktreeId'>,
  chatIds: readonly string[],
): Promise<string[]> {
  if (chatIds.length === 0) return [];
  const tabsFile = await readChatTabsFile(target.projectId, target.worktreeId, {
    chatIds: [...chatIds],
  });
  const driven = await Promise.all(
    chatIds.map(async (chatId) =>
      (await resolveTerminalDrivenChat({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        tab: tabsFile.tabs.find((tab) => tab.id === chatId),
      }))
        ? chatId
        : null,
    ),
  );
  return driven.filter((chatId): chatId is string => chatId !== null);
}

/**
 * Whether a chat's canonical transcript holds this user message id, which
 * only a committed send of it puts there.
 */
export function isWorktreeChatMessageCommitted(
  target: Pick<
    ChatSendMessageRequest,
    'projectId' | 'worktreeId' | 'chatId' | 'userMessageId'
  >,
): Promise<boolean> {
  return getChatStateService().hasTranscriptMessage(
    { projectId: target.projectId, worktreeId: target.worktreeId },
    target.chatId,
    target.userMessageId,
  );
}

export async function sendWorktreeChatMessage(
  request: TrustedWorktreeChatSendRequest,
  options: ChatServiceOptions = {},
): Promise<{ ok: true; chatId: string }> {
  return getChatStateService().runWithScopeActivity(
    {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    },
    () => sendWorktreeChatMessageNow(request, options),
  );
}

async function sendWorktreeChatMessageNow(
  request: TrustedWorktreeChatSendRequest,
  options: ChatServiceOptions,
): Promise<{ ok: true; chatId: string }> {
  const turnDispatchTiming = new TurnDispatchTiming();
  if (
    'watcherFired' in request &&
    request.watcherFired &&
    'watcherDeliveryId' in request &&
    request.watcherDeliveryId
  )
    await assertWatcherDeliveryIngress(request);
  options.admissionSignal?.throwIfAborted();
  const resumeCleanupBefore = Date.now();
  if (request.chatId)
    retireWorktreePortalPrimaryTurn({ ...request, chatId: request.chatId });
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  if (request.chatId) validateId(request.chatId, 'chatId');
  if (request.userMessageId) validateId(request.userMessageId, 'userMessageId');
  validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
  // Before the tabs are read, so no tab is minted in a legacy plan chat scope.
  assertChatScopeAcceptsTurns(request.projectId);
  if ('activePlan' in request) parseChatActivePlanContext(request.activePlan);
  const splitLockTarget = assertWorktreeChatSendNotSplitLocked(
    request.projectId,
    request.worktreeId,
  );

  const authorizedPortalDispatch = options.queueDispatch !== undefined;
  if (
    !authorizedPortalDispatch &&
    !options.preserveTransientRetry &&
    request.chatId
  ) {
    cancelTransientRetryForChat(
      {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
      },
      'manual-send',
    );
  }

  if (request.projectId === APP_ADVISOR_PROJECT_ID) {
    if (request.worktreeId === APP_ADVISOR_WORKTREE_ID) {
      throw new Error('App Advisor legacy global chats are read-only.');
    }
    const entryIds = await listWorkEntryIds(APP_ADVISOR_PROJECT_ID);
    if (!entryIds.includes(request.worktreeId)) {
      throw new Error(`Unknown App Advisor Work Entry ${request.worktreeId}.`);
    }
  }

  const tabsFile = await readChatTabsFile(
    request.projectId,
    request.worktreeId,
    { chatIds: request.chatId ? [request.chatId] : [] },
  );
  // A send without a chatId (portal New Task delivery, automations) used to
  // always mint a fresh tab. Reuse an existing EMPTY chat tab instead: the
  // desktop renderer seeds a default empty tab when it hydrates a fresh
  // worktree (immediate since CAN-1304's create broadcast), and minting a
  // sibling left a phantom "New Chat" tab on both surfaces. Terminal-backed
  // tabs are excluded — a native SDK turn must not fight the managed terminal
  // that owns the tab's session.
  const reusedEmptyTab =
    request.chatId == null
      ? tabsFile.tabs.find(isReusableEmptyChatTab)
      : undefined;
  let existingTab =
    request.chatId != null
      ? tabsFile.tabs.find((tab) => tab.id === request.chatId)
      : reusedEmptyTab;
  if (reusedEmptyTab) {
    const selected = await readChatTabsFile(
      request.projectId,
      request.worktreeId,
      { chatIds: [reusedEmptyTab.id] },
    );
    existingTab = selected.tabs.find((tab) => tab.id === reusedEmptyTab.id);
  }
  const chatId = existingTab?.id ?? request.chatId ?? randomUUID();
  // Settle the model, including one stored on the chat, before the tab and the
  // prompt are written.
  const { resolveSendModelPin } = await import('../agents/agent-default-model');
  const sendModelPin = await resolveSendModelPin(
    request.projectId,
    existingTab?.model ?? undefined,
    request.model ?? undefined,
  );
  if (sendModelPin !== undefined) {
    request = {
      ...request,
      model: sendModelPin,
      providerType: getProviderForModel(sendModelPin) ?? request.providerType,
      executionHarness: getExecutionHarnessForModel(sendModelPin),
    };
  }
  // A chat-id-less send (portal/mobile New Task, automations) is policed by
  // its caller against the PROVIDER DEFAULT, because the reusable empty tab
  // above is invisible to that preflight — it has no chat id to look up. If
  // that tab was seeded with a model the policy has since blocked, spreading
  // `...existingTab` below would persist the blocked model onto a chat that
  // actually runs the permitted default: the chat succeeds while displaying a
  // blocked selection, and its NEXT send is refused because the preflight can
  // finally see the tab.
  //
  // Drop the stale model so the label matches what runs. This is not
  // "substitute over refuse" — the user picked nothing for this send, and the
  // turn was always going to run the default. Only the empty-tab reuse case is
  // affected; an explicit `chatId` or an explicit `request.model` is judged by
  // the caller and left alone.
  // Keyed on the tab being EMPTY rather than on `reusedEmptyTab`, because the
  // queued-dispatch path re-enters with the chat id already resolved — at
  // which point the reuse lookup is skipped but the tab is still the same
  // never-used one.
  //
  // Cleared whether or not the stale model is blocked, because dispatch
  // ignores it either way: `dispatchWorktreeChatTurn` resolves
  // `options.model ?? modelDefaults[provider]`, and a chat-id-less send
  // carries no tab options — so the provider DEFAULT runs regardless of what
  // this tab says. Keeping the stale value left the chat advertising a model
  // that never ran and silently switched the NEXT send onto it. Clearing does
  // not discard a selection the user was getting; it stops the UI claiming one
  // they were not.
  //
  // The blocked case is the same bug with policy consequences: the chat also
  // displayed a forbidden model and its next send was refused. Both are
  // covered by one rule.
  //
  // Note the Portal preflight cannot see this tab (no chat id to look up), and
  // automation sends reach `sendWorktreeChatMessage` with no preflight at all
  // — so aligning persisted state with the dispatched model has to happen
  // here, not at a caller.
  const clearStaleEmptyTabModel =
    existingTab?.model != null &&
    (existingTab.transcript?.messageCount ??
      existingTab.transcript?.committedMessageCount ??
      existingTab.messages.length) === 0 &&
    request.model == null &&
    !(
      existingTab.modelExplicitlyChosen === true &&
      getProviderForModel(existingTab.model) !== undefined
    );
  // An ESTABLISHED tab needs the same alignment when its persisted model no
  // longer resolves to a provider (removed or renamed after the tab last ran)
  // even when the tab also persisted provider evidence. The portal adapter discards that
  // model from its OWN dispatch options (`chat-adapter.ts`), but this service
  // reloads the tab from disk — so without a reset here the model-less send
  // runs a resolved default while the persisted model, harness, model
  // configuration, and session fields survive, advertising routing the turn
  // is not running and echoing back into every later send. A provider cannot
  // make an unknown model resumable, and retaining it would let the service
  // reload routing state that the adapter already rejected. Gated on BOTH
  // catalogs being hydrated so a cold registry or gateway catalog cannot
  // misjudge a legitimate model as stale and destroy real tab state.
  const clearStaleUnroutableTabModel =
    existingTab?.model != null &&
    request.model == null &&
    hasHydratedModelRegistry() &&
    hasHydratedGatewayCatalog() &&
    getProviderForModel(existingTab.model) === undefined;
  const clearStaleTabModel =
    clearStaleEmptyTabModel || clearStaleUnroutableTabModel;
  if (clearStaleUnroutableTabModel && existingTab) {
    // Callers that fold the tab's own persisted fields into the request
    // (the portal adapter via `buildExistingTabDispatchOptions`, renderer
    // sends via the tab store) echo the discarded state back on this very
    // send. Drop each field only when it IS that echo — a caller-supplied
    // value that differs from the tab's is an explicit choice and survives.
    const sanitized = { ...request };
    if (
      sanitized.sdkSessionId !== undefined &&
      sanitized.sdkSessionId === existingTab.sdkSessionId
    ) {
      delete sanitized.sdkSessionId;
      if ('claudeForkSession' in sanitized) {
        delete sanitized.claudeForkSession;
      }
      if ('claudeForkResumeAt' in sanitized) {
        delete sanitized.claudeForkResumeAt;
      }
      if ('claudeForkStartsFresh' in sanitized) {
        delete sanitized.claudeForkStartsFresh;
      }
      if ('claudeForkToolResults' in sanitized) {
        delete sanitized.claudeForkToolResults;
      }
    }
    if (
      'codexReconstructionSeedId' in sanitized &&
      sanitized.codexReconstructionSeedId !== undefined &&
      sanitized.codexReconstructionSeedId ===
        existingTab.codexReconstructionSeedId
    ) {
      delete sanitized.codexReconstructionSeedId;
    }
    if (
      'executionHarness' in sanitized &&
      sanitized.executionHarness !== undefined &&
      sanitized.executionHarness === existingTab.executionHarness
    ) {
      delete sanitized.executionHarness;
    }
    if (
      sanitized.modelConfig !== undefined &&
      JSON.stringify(sanitized.modelConfig) ===
        JSON.stringify(existingTab.modelConfig)
    ) {
      delete sanitized.modelConfig;
    }
    request = sanitized;
  }
  const startsNewTrackedChat =
    !existingTab ||
    existingTab.newChatStartedWatcherPending === true ||
    (existingTab.transcript?.messageCount ??
      existingTab.transcript?.committedMessageCount ??
      existingTab.messages.length) === 0;
  const isAppAdvisorTarget = request.projectId === APP_ADVISOR_PROJECT_ID;
  const appAdvisorSurfaces = isAppAdvisorTarget
    ? options.appAdvisorSurfaces
    : undefined;
  if (isAppAdvisorTarget && !appAdvisorSurfaces) {
    throw new Error(
      'Cannot dispatch an App Advisor scheduled message without App Advisor surfaces.',
    );
  }

  // Scheduled/automation prompts targeting a terminal-backed Claude chat
  // must not run a Canopy-native SDK turn — the managed terminal owns the
  // sdkSessionId. Forward to the renderer's terminal send path, which queues
  // the prompt until the terminal turn is idle and relaunches reaped
  // terminals with the prompt as the CLI's initial argument.
  const existingTabSource = existingTab?.model
    ? getModelSource(existingTab.model)
    : existingTab?.providerType === 'claude' ||
        existingTab?.providerType === undefined
      ? 'claude-managed'
      : undefined;
  const initiationSource =
    'initiationSource' in request ? request.initiationSource : undefined;
  // Portal (web) chat sends don't carry `approvalMode` yet — only desktop's
  // `ChatSendMessageRequest` does — so narrow the same way `initiationSource`
  // does above rather than accessing it on the union directly.
  const requestApprovalMode =
    'approvalMode' in request ? request.approvalMode : undefined;
  const explicitTitle =
    'title' in request
      ? request.title?.trim().slice(0, CHAT_CUSTOM_TITLE_MAX_LENGTH) ||
        undefined
      : undefined;
  const requestSessionApprovalRules =
    'sessionApprovalRules' in request
      ? request.sessionApprovalRules
      : undefined;

  // Refuse a blocked model here, before EITHER exit from this function: the
  // terminal-forwarding branch below returns without reaching
  // `getOrCreateSession`, and the ordinary path writes the user message before
  // it. Automations (`automations/service.ts`) call this service directly with
  // no adapter preflight, and a queued send is validated when the command
  // arrives but drains later — after an administrator may have blocked the
  // model. Both re-enter here with a concrete `request.model`.
  //
  // Only `request.model` is judged, because that is the only model this
  // service dispatches: it hands `dispatchWorktreeChatTurn` the request's
  // model, never the tab's (which is why a stale tab model is CLEARED below
  // rather than refused). Callers that mean to run a tab's model pass it as
  // `request.model` — the automation at `automations/service.ts` reads the tab
  // and does exactly that, and the Portal adapter folds the tab's model in via
  // `buildExistingTabDispatchOptions` before re-entry.
  //
  // The provider DEFAULT is deliberately not resolved here: that chain lives
  // in `dispatchWorktreeChatTurn` (and differs for cowork), so duplicating it
  // would create a second source of truth. The default case still reaches
  // `getOrCreateSession`, which fail-closes before any turn starts; what this
  // adds is that nothing is forwarded or persisted first.
  //
  // A live terminal session is not retroactively killed by a policy change —
  // `buildClaudeTerminalLaunchConfig` gates the model when the session LAUNCHES
  // so one can never start blocked. This stops a new automation prompt from
  // being fed to a session whose model has since been blocked.
  const policyOwner = await resolveAiCreditsScopeOwner({
    kind: 'work',
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    ...(request.chatId ? { chatId: request.chatId } : {}),
  });
  if (options.requiredAccountProxyConnectionId) {
    const provider = request.providerType ?? existingTab?.providerType;
    if (
      (provider !== 'claude' && provider !== 'codex') ||
      !(await previewAccountProxySessionRoute({
        harness: provider,
        model: request.model,
        requiredConnectionId: options.requiredAccountProxyConnectionId,
        resolveWorkOwner: () => Promise.resolve(policyOwner),
      }))
    ) {
      throw new Error(
        'The account proxy connection for this continuation is unavailable.',
      );
    }
    if (
      existingTab &&
      existingTabSource === 'claude-managed' &&
      isTerminalBackedInterfaceMode(
        getEffectiveClaudeChatInterfaceMode(existingTab.interfaceMode),
      )
    ) {
      throw new Error(
        'The chat interface changed while this continuation was paused.',
      );
    }
  }
  if (
    request.model &&
    (await isModelBlockedByStoredPolicy(request.model, policyOwner))
  ) {
    throw new Error('This model is blocked by your organization policy.');
  }

  // A concrete model whose every lane is confirmed dead is refused here, as
  // cowork and the Portal adapter already do (CAN-5233): past this point the
  // tab and the user message are written before dispatch aborts with
  // `no_billing_source`. Only `request.model` is judged, for the reason given
  // at the policy gate above: with none, dispatch runs the lane default, not
  // the tab's model. The implicit-default dead end is refused by the Portal
  // adapter and by dispatch's `NoDispatchableModelError`. After the policy
  // gate, so a model that is both blocked and billing-dead gets the policy
  // message. A Portal send (judged in the adapter) and a queued send (judged
  // at enqueue) are judged again on re-entry; the second pass reuses the
  // cached sign-in answer.
  const billingJudgedModel = request.model;
  if (billingJudgedModel) {
    const billingRefusal = await turnDispatchTiming.measure(
      'auth_preflight',
      () =>
        resolveSendBillingRefusal({
          concreteModel: billingJudgedModel,
          credentialScope: {
            workspaceId: request.projectId,
            workOwnerSession: {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId,
            },
          },
        }),
    );
    if (billingRefusal !== null) throw new Error(billingRefusal);
  }

  // Same placement rule as the model-policy gate directly above, for the same
  // reason: refuse before EITHER exit from this function — the terminal-
  // forwarding branch below returns without reaching `getOrCreateSession`, and
  // the ordinary path writes the tab and the user message before it.
  //
  // Only the selections this service actually dispatches are judged
  // (`request.pluginSelections`, which the Portal adapter and automations fold
  // the tab's own value into via `buildExistingTabDispatchOptions`), mirroring
  // how `request.model` is the only model judged above. The preflight is
  // cached-only and issues no network, subprocess, or browser call — see
  // `lib/auth-preflight.ts` (CAN-399/CAN-492) — so a dependency whose cached
  // state is merely unknown falls through and gets dispatch's own error.
  await turnDispatchTiming.measure('auth_preflight', () =>
    assertTurnAuthDependencies({
      target: {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId,
      },
      ...(request.pluginSelections
        ? { pluginSelections: request.pluginSelections }
        : {}),
      ...(request.providerType ? { providerType: request.providerType } : {}),
    }),
  );

  // Track real user work independently of the retired checklist. Refused sends
  // and Canopy-owned assistant surfaces do not count as activation.
  const isPipelineEditorTarget =
    request.projectId === PIPELINE_EDITOR_PROJECT_ID &&
    request.worktreeId === PIPELINE_EDITOR_WORKTREE_ID;
  if (!isAppAdvisorTarget && !isPipelineEditorTarget) {
    void latchFirstTaskSubmitted(new Date().toISOString());
  }

  const userMessageId = request.userMessageId ?? randomUUID();
  const trustedAgentRequest =
    'agentSenderProvenance' in request && request.agentSenderProvenance
      ? { ...request, chatId, userMessageId }
      : undefined;
  if (trustedAgentRequest)
    await revalidateAgentSenderRequest(trustedAgentRequest, {
      allowMissingTarget: !existingTab,
    });

  const planImplementation = existingTab?.trackedPlanImplementation;
  const implementsPlan =
    planImplementation?.userMessageId === userMessageId &&
    !planImplementation.outcome;
  if (
    existingTab &&
    existingTabSource === 'claude-managed' &&
    isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(existingTab.interfaceMode),
    ) &&
    (initiationSource === 'automation' ||
      trustedAgentRequest !== undefined ||
      implementsPlan)
  ) {
    // The terminal event carries prompt content only. Forwarding a request
    // whose settings differ from the live tab would acknowledge a successful
    // automation while the terminal executes with its old model, permissions,
    // or plugins. Refuse it before delivery; a trusted user can apply the
    // settings in the chat and then schedule the prompt again.
    if (terminalChatSettingsDiffer(existingTab, request))
      throw new Error(TERMINAL_CHAT_SETTINGS_DIFFER_MESSAGE);
    if (trustedAgentRequest) {
      await getChatStateService().retainTrustedTerminalInput(
        trustedAgentRequest,
      );
    }
    // A terminal chat's prompt is typed by the App Advisor window's terminal,
    // so that window is a precondition here, not just a presentation.
    await appAdvisorSurfaces?.ensureAppAdvisorWindow();
    if (implementsPlan) {
      const { MAX_TERMINAL_WRITE_BYTES, TerminalServiceError } =
        await import('./terminal-service');
      // Reject a known transport refusal before acknowledging the handoff,
      // while canonical admission can still restore previous plan evidence.
      if (Buffer.byteLength(request.text, 'utf8') > MAX_TERMINAL_WRITE_BYTES)
        throw new TerminalServiceError(
          'invalid_payload',
          'Terminal write exceeds maximum data size',
        );
      const { getClaudeTerminalSessionService } =
        await import('../integration/claude-terminal-session-service');
      getClaudeTerminalSessionService().retainPlanImplementationDelivery({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId,
        userMessageId,
      });
    }
    const scheduledPrompt: ClaudeTerminalScheduledPromptEvent = {
      ...(implementsPlan ? { terminalPlanImplementation: true as const } : {}),
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId,
      userMessageId,
      ...('autoResume' in request && request.autoResume
        ? { autoResume: request.autoResume }
        : {}),
      ...(trustedAgentRequest?.agentSenderProvenance &&
      trustedAgentRequest.hiddenContext?.kind === 'agent-sender-context'
        ? {
            acceptedInputId:
              trustedAgentRequest.agentSenderProvenance.acceptedInputId,
            hiddenContext: trustedAgentRequest.hiddenContext,
            agentSent: trustedAgentRequest.agentSent,
          }
        : {}),
      text: request.text,
      ...(request.fileReferences?.length
        ? { fileReferences: request.fileReferences }
        : {}),
      ...(request.attachmentPaths?.length
        ? { attachmentPaths: request.attachmentPaths }
        : {}),
      ...(getAttachmentPromptContexts(request)?.length
        ? { attachmentPromptContexts: getAttachmentPromptContexts(request) }
        : {}),
      ...(request.inputMode ? { inputMode: request.inputMode } : {}),
      ...('automationName' in request && request.automationName
        ? { automationName: request.automationName }
        : {}),
    };
    const getScheduledPromptWindow = isAppAdvisorTarget
      ? options.appAdvisorSurfaces?.getAppAdvisorWindow
      : options.getWindow;
    const presentationKey = presentationChatKey({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatTabId: chatId,
    });
    const deliver = (): ReturnType<typeof sendToWindowDetailed> => {
      // The renderer marks only non-agent prompts as automation turns; an
      // unmarked agent prompt is accepted as the user's turn, like other sends.
      if (scheduledPrompt.acceptedInputId === undefined)
        stageTerminalPresentationTurn(
          presentationKey,
          userMessageId,
          implementsPlan ? 'user' : 'automation',
        );
      return sendToWindowDetailed(
        (getScheduledPromptWindow ?? getNullWindow)(),
        IPC_CHANNELS.claudeTerminalScheduledPrompt,
        scheduledPrompt,
      );
    };
    const delivery = trustedAgentRequest
      ? await withAgentSenderAuthority(
          trustedAgentRequest,
          deliver,
          revalidateAgentSenderRequest,
        )
      : deliver();
    if (!delivery.delivered) {
      cancelTerminalPresentationTurn(presentationKey, userMessageId);
      throw new Error(
        `Cannot deliver a scheduled prompt to a Claude Code terminal chat without a ${BRAND.displayName} window.`,
      );
    }
    if ('autoResume' in request && request.autoResume) {
      // Keep attribution in the main-owned transcript even if terminal replay
      // later supplies only provider text. The marker describes the accepted
      // application prompt, not a successful provider reply.
      await getChatStateService().ingestProviderEvent({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId,
        data: {
          type: 'canopy_user_prompt',
          original_text: request.text,
          canopy_turn_user_message_id: userMessageId,
          canopy_resumes_interrupted_turn: true,
          canopy_resumes_user_message_id:
            request.autoResume.resumesUserMessageId,
          canopy_persisted_messages: [
            buildPersistedUserMessage(request, userMessageId, Date.now()),
          ],
        },
        turnUserMessageId: userMessageId,
      });
    }
    if (!options.preserveUsageLimitRegistry)
      await clearUsageLimitedChat(
        {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId,
        },
        { onlyIfDetectedBefore: resumeCleanupBefore },
      );
    return { ok: true, chatId };
  }

  // An existing chat's saved mode is the send's authority and the request
  // can only narrow it; a new chat starts at the mode it is created with.
  // The turn re-reads the saved tab when it starts (CAN-4469).
  const savedApprovalMode = await resolvePersistedApprovalMode(
    splitLockTarget.projectId,
    splitLockTarget.worktreeId,
    clampToLiveApprovalMode(
      request.projectId,
      request.worktreeId,
      chatId,
      existingTab ? existingTab.approvalMode : requestApprovalMode,
    ),
  );
  const approvalMode = narrowApprovalMode(
    savedApprovalMode,
    requestApprovalMode,
  );
  const sessionApprovalRules = narrowSessionApprovalRules(
    existingTab?.sessionApprovalRules ?? [],
    requestSessionApprovalRules,
  );
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const interfaceMode =
    'interfaceMode' in request
      ? getPersistedClaudeChatInterfaceMode(request.interfaceMode)
      : undefined;
  const echoedExecutionHarness =
    'executionHarness' in request ? request.executionHarness : undefined;
  const existingProviderType =
    existingTab?.providerType ??
    (existingTab?.model ? getProviderForModel(existingTab.model) : undefined);
  const requestedProviderType =
    request.providerType ??
    (request.model ? getProviderForModel(request.model) : undefined);
  const switchesProvider =
    existingProviderType !== undefined &&
    requestedProviderType !== undefined &&
    existingProviderType !== requestedProviderType;
  if (switchesProvider) {
    const sanitized = { ...request };
    if (
      sanitized.model &&
      getProviderForModel(sanitized.model) !== requestedProviderType
    ) {
      delete sanitized.model;
      delete sanitized.modelConfig;
    }
    delete sanitized.sdkSessionId;
    if ('globalInstructionsSnapshot' in sanitized) {
      delete sanitized.globalInstructionsSnapshot;
    }
    if ('claudeForkSession' in sanitized) {
      delete sanitized.claudeForkSession;
    }
    if ('claudeForkResumeAt' in sanitized) {
      delete sanitized.claudeForkResumeAt;
    }
    if ('claudeForkStartsFresh' in sanitized) {
      delete sanitized.claudeForkStartsFresh;
    }
    if ('claudeForkToolResults' in sanitized) {
      delete sanitized.claudeForkToolResults;
    }
    if ('codexReconstructionSeedId' in sanitized) {
      delete sanitized.codexReconstructionSeedId;
    }
    request = sanitized;
  }
  const modelConfig = normalizePortalChatModelConfig(request);
  const inheritedExecutionHarness =
    existingTab?.executionHarness ??
    (existingTab?.model
      ? getExecutionHarnessForModel(existingTab.model)
      : undefined);
  const existingExecutionHarness =
    clearStaleTabModel || switchesProvider
      ? undefined
      : inheritedExecutionHarness;
  const requestedExecutionHarness = request.model
    ? request.model === existingTab?.model && existingExecutionHarness
      ? existingExecutionHarness
      : getExecutionHarnessForModel(request.model)
    : undefined;
  const executionHarness =
    requestedExecutionHarness ??
    existingExecutionHarness ??
    (request.model ? getExecutionHarnessForModel(request.model) : undefined);
  if (
    echoedExecutionHarness !== undefined &&
    executionHarness !== undefined &&
    echoedExecutionHarness !== executionHarness
  ) {
    throw new Error(
      `Requested execution harness "${echoedExecutionHarness}" conflicts with the host-owned "${executionHarness}" harness.`,
    );
  }
  const switchesHarness =
    requestedExecutionHarness !== undefined &&
    existingExecutionHarness !== undefined &&
    requestedExecutionHarness !== existingExecutionHarness;
  const userMessage = buildPersistedUserMessage(request, userMessageId, now);
  const automationInfoMessage = buildAutomationInfoMessage(
    request,
    userMessageId,
    existingTab?.messages,
  );
  const selectedTab: PersistedChatTab = existingTab
    ? {
        ...existingTab,
        // Only an empty placeholder gets a first-prompt preview. Meaningful
        // creation names are saved names and must remain ineligible for naming.
        ...((existingTab.transcript?.messageCount ??
          existingTab.transcript?.committedMessageCount ??
          existingTab.messages.length) === 0 &&
        (explicitTitle !== undefined ||
          existingTab.title.trim() === '' ||
          existingTab.title.trim().toLowerCase() === 'new chat')
          ? {
              title: explicitTitle ?? firstLineTitle(request.text),
              ...(explicitTitle && existingTab.customTitle === undefined
                ? { customTitle: explicitTitle }
                : {}),
              // The first-line label is a preview; keep the chat eligible
              // for its one initial generated title unless an explicit
              // title saved a name or naming already closed.
              automaticTitleState:
                explicitTitle !== undefined ||
                existingTab.automaticTitleState === 'closed'
                  ? ('closed' as const)
                  : ('pending' as const),
            }
          : {}),
        messages: automationInfoMessage
          ? upsertMessage(
              upsertMessage(existingTab.messages, automationInfoMessage),
              userMessage,
            )
          : upsertMessage(existingTab.messages, userMessage),
        // Drop a stale selection off a reused empty tab (see above) so the tab
        // never advertises settings the turn is not running. `thinkingLevel`
        // and `modelConfig` go with the model because they are tied to it —
        // `fastMode` is Codex-only, and thinking is clamped per MODEL via
        // `clampThinkingLevelForModel` (the level vocabulary itself is
        // shared) — so leaving them would apply the cleared model's
        // configuration to the replacement default on the NEXT send. Written as `undefined` rather than deleted so they override
        // the `...existingTab` spread, and placed BEFORE every request spread
        // so an explicitly supplied value still wins.
        ...(clearStaleTabModel || switchesProvider
          ? {
              model: undefined,
              providerType: undefined,
              executionHarness: undefined,
              thinkingLevel: undefined,
              modelConfig: undefined,
            }
          : {}),
        // Interface mode and the managed-terminal handle are Claude-owned:
        // the set_model reducer clears both on provider switches, and this
        // send-path reset must match or the tab keeps advertising a
        // terminal-backed mode its new provider cannot run.
        ...(switchesProvider
          ? { interfaceMode: undefined, claudeTerminal: undefined }
          : {}),
        ...(request.planMode == null ? {} : { planMode: request.planMode }),
        ...(request.thinkingLevel == null
          ? {}
          : { thinkingLevel: request.thinkingLevel }),
        ...(modelConfig == null ? {} : { modelConfig }),
        // A model always persists with the provider that owns it. Writing
        // `model` alone left the tab's previous `providerType` in place, and
        // that pair is not harmless: this turn derives its provider from the
        // request model and runs correctly, but the NEXT send reloads both
        // fields through `buildExistingTabDispatchOptions`, where an explicit
        // `providerType` outranks the model's own — dispatching, say, a Claude
        // model through Codex. `setStandaloneChatModel` keeps the cowork tab's
        // pair in sync for the same reason; this is the worktree half.
        ...(request.model == null
          ? {}
          : {
              model: request.model,
              providerType:
                request.providerType ?? getProviderForModel(request.model),
            }),
        ...(request.providerType == null
          ? {}
          : { providerType: request.providerType }),
        ...(executionHarness ? { executionHarness } : {}),
        ...(request.pluginSelections == null
          ? {}
          : { pluginSelections: request.pluginSelections }),
        ...(interfaceMode == null ? {} : { interfaceMode }),
        ...(request.selectedRepoId == null
          ? {}
          : { selectedRepoId: request.selectedRepoId }),
      }
    : {
        id: chatId,
        title: explicitTitle ?? firstLineTitle(request.text),
        ...(explicitTitle ? { customTitle: explicitTitle } : {}),
        automaticTitleState: explicitTitle ? 'closed' : 'pending',
        createdAt,
        messages: [
          ...(automationInfoMessage ? [automationInfoMessage] : []),
          userMessage,
        ],
        kind: 'chat',
        ...newChatPluginDefaultsStamp(request.projectId),
        ...(request.planMode == null ? {} : { planMode: request.planMode }),
        approvalMode,
        ...(request.thinkingLevel == null
          ? {}
          : { thinkingLevel: request.thinkingLevel }),
        ...(modelConfig == null ? {} : { modelConfig }),
        // Same rule as the existing-tab branch: a model persists with the
        // provider that owns it. A fresh tab has no prior provider to
        // contradict, so this is uniformity rather than a fix — but stating
        // the invariant in only one branch invites the next reader to treat
        // the omission as deliberate.
        ...(request.model == null
          ? {}
          : {
              model: request.model,
              providerType:
                request.providerType ?? getProviderForModel(request.model),
            }),
        ...(request.providerType == null
          ? {}
          : { providerType: request.providerType }),
        ...(executionHarness ? { executionHarness } : {}),
        ...(request.pluginSelections == null
          ? {}
          : { pluginSelections: request.pluginSelections }),
        ...(interfaceMode == null ? {} : { interfaceMode }),
        ...(request.selectedRepoId == null
          ? {}
          : { selectedRepoId: request.selectedRepoId }),
      };
  if (options.executionContext !== undefined)
    selectedTab.executionContext = options.executionContext;
  if (clearStaleTabModel || switchesProvider) {
    if (request.model == null) delete selectedTab.model;
    if (modelConfig == null) delete selectedTab.modelConfig;
    if (request.thinkingLevel == null) delete selectedTab.thinkingLevel;
  }
  if (switchesProvider) {
    if (interfaceMode == null) delete selectedTab.interfaceMode;
    delete selectedTab.claudeTerminal;
  }
  // Harness and provider switches both invalidate captured session state. A
  // provider can change without changing harness (for example Codex to an
  // Ollama model served through the Codex harness), but its session id and
  // reconstruction metadata are still provider-owned.
  if (switchesHarness || switchesProvider || clearStaleUnroutableTabModel) {
    delete selectedTab.sdkSessionId;
    delete selectedTab.claudeForkSessionOnNextSend;
    delete selectedTab.codexReconstructionSeedId;
    delete selectedTab.globalInstructionsSnapshot;
  }
  if (startsNewTrackedChat) {
    delete selectedTab.newChatStartedWatcherPending;
    selectedTab.newChatStartedWatcherFiredAt = new Date(now).toISOString();
  }
  const usageLimitBannerBeforeDispatch =
    capturePersistedUsageLimitBannerSnapshot(selectedTab);
  // Shared by every immediate dispatch branch, including App Advisor, so its
  // post-dispatch cleanup cannot erase a record written by a turn that
  // immediately re-hits the usage limit.
  const dispatchStartedAt = Date.now();
  const nextTabs = existingTab
    ? tabsFile.tabs.map((tab) => (tab.id === chatId ? selectedTab : tab))
    : [...tabsFile.tabs, selectedTab];
  // Live callers pass the option; a queued send restored after a restart
  // carries it on the durable request instead.
  const preserveActiveTab =
    options.preserveActiveTab === true ||
    ('preserveActiveTab' in request && request.preserveActiveTab === true);
  // Holds no copy of the chat's approval settings: a queued send reads them
  // again when it dispatches.
  const queuedRequest: ChatSendMessageRequest = {
    ...request,
    ...(preserveActiveTab ? { preserveActiveTab: true } : {}),
    chatId,
    userMessageId,
    ...(executionHarness ? { executionHarness } : {}),
  };
  if (queuedRequest.agentSenderProvenance && !existingTab) {
    await getChatStateService().ensureChatForTrustedSend({
      ...queuedRequest,
      approvalMode,
    });
  }
  if (!authorizedPortalDispatch) {
    const { getChatQueueService } = await import('./chat-queue-service');
    portalQueueOptions.set(queuedRequest, options);
    const queue = getChatQueueService();
    if (options.requiredAccountProxyConnectionId !== undefined) {
      await queue.submit(queuedRequest, 'portal', undefined, {
        requiredAccountProxyConnectionId:
          options.requiredAccountProxyConnectionId,
      });
    } else {
      await queue.submit(queuedRequest, 'portal');
    }
    return { ok: true, chatId };
  }
  requestAppAdvisorPresentation(appAdvisorSurfaces, 'queued_send');
  // A portal send is the user's own, so the new chat comes forward unless
  // the caller asked to keep the current tab. Chats nobody asked for (hooks,
  // scheduled automations) go through ChatStateService.ensureChatForTrustedSend,
  // which keeps the active tab for them; keep the two rules in step.
  const activeTabId =
    preserveActiveTab &&
    tabsFile.activeTabId &&
    nextTabs.some((tab) => tab.id === tabsFile.activeTabId)
      ? tabsFile.activeTabId
      : chatId;
  await turnDispatchTiming.measure('prompt_commit', async () => {
    await getChatStateService().replaceCompatibilityTabs(
      { projectId: request.projectId, worktreeId: request.worktreeId },
      {
        ...tabsFile,
        tabs: nextTabs,
        activeTabId,
      },
    );

    await getChatStateService().ingestProviderEvent({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId,
      data: {
        type: 'canopy_user_prompt',
        original_text: request.text,
        canopy_turn_user_message_id: userMessageId,
        ...('resumesInterruptedTurn' in request &&
        request.resumesInterruptedTurn
          ? { canopy_resumes_interrupted_turn: true }
          : {}),
        provider:
          request.providerType ??
          (request.model ? getProviderForModel(request.model) : undefined),
        ...('autoResume' in request && request.autoResume?.resumesUserMessageId
          ? {
              canopy_resumes_user_message_id:
                request.autoResume.resumesUserMessageId,
            }
          : {}),
        canopy_persisted_messages: [userMessage],
      },
      ...(request.providerType ? { providerType: request.providerType } : {}),
      turnUserMessageId: userMessageId,
    });
  });

  await emitTargetChatSummary({
    workspaceId: request.projectId,
    worktreeId: request.worktreeId,
    tab: selectedTab,
    active: activeTabId === chatId,
    order: chatTabOrder(nextTabs, chatId),
    owner: { value: policyOwner },
  });

  if (appAdvisorSurfaces) {
    const promptEvent = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId,
      data: {
        type: 'canopy_user_prompt',
        original_text: request.text,
        canopy_turn_user_message_id: userMessageId,
        provider:
          request.providerType ??
          (request.model ? getProviderForModel(request.model) : undefined),
        canopy_persisted_messages: [
          ...(automationInfoMessage ? [automationInfoMessage] : []),
          userMessage,
        ],
      },
    };
    sendToWindow(
      appAdvisorSurfaces.getMainWindow(),
      IPC_CHANNELS.chatEvent,
      promptEvent,
    );
    sendToWindow(
      appAdvisorSurfaces.getAppAdvisorWindow(),
      IPC_CHANNELS.chatEvent,
      promptEvent,
    );
    // Defer the heavyweight App Advisor provider/tool runtime for ordinary
    // worktree sends; the static relative path is bundled into Electron main.
    const { dispatchAppAdvisorChatMessage: dispatchAdvisor } =
      await import('../app-advisor/chat-service');
    const dispatchAppAdvisorChatMessage = (
      ...args: Parameters<typeof dispatchAdvisor>
    ): ReturnType<typeof dispatchAdvisor> =>
      trustedAgentRequest
        ? withAgentSenderAuthority(
            trustedAgentRequest,
            () => dispatchAdvisor(...args),
            revalidateAgentSenderRequest,
          )
        : dispatchAdvisor(...args);
    // One-shot instructions (an independent fork's handoff) ride this turn
    // and are consumed once it is accepted, as on the worktree path.
    const advisorPendingSystemInstructions = queuedRequest
      .pendingSystemInstructions?.length
      ? queuedRequest.pendingSystemInstructions
      : existingTab?.pendingSystemInstructions;
    await dispatchAppAdvisorChatMessage(
      {
        ...queuedRequest,
        ...(advisorPendingSystemInstructions?.length
          ? { pendingSystemInstructions: advisorPendingSystemInstructions }
          : {}),
        chatId,
        userMessageId,
        assistantMode: 'app-advisor',
        approvalMode,
        sessionApprovalRules,
      },
      {
        getMainWindow: appAdvisorSurfaces.getMainWindow,
        getAppAdvisorWindow: appAdvisorSurfaces.getAppAdvisorWindow,
        toolSurfaces: appAdvisorSurfaces,
        admissionSignal: options.admissionSignal,
        onTurnAccepted: options.onTurnAccepted,
        ...(options.queueDispatch?.authorization
          ? { authorization: options.queueDispatch.authorization }
          : {}),
      },
    );
    const acceptedTarget = {
      ...queuedRequest,
      chatId,
      userMessageId,
    };
    const acceptedData = await commitAcceptedUserPrompt(acceptedTarget);
    sendAcceptedUserPrompt(
      appAdvisorSurfaces.getMainWindow,
      acceptedTarget,
      acceptedData,
    );
    sendAcceptedUserPrompt(
      appAdvisorSurfaces.getAppAdvisorWindow,
      acceptedTarget,
      acceptedData,
    );
    if (advisorPendingSystemInstructions?.length) {
      const consumed = await consumePersistedPendingSystemInstructions({
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
        chatId,
        instructionIds: advisorPendingSystemInstructions.map(
          (instruction) => instruction.id,
        ),
      });
      if (consumed) {
        await emitTargetChatSummary({
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
          tab: consumed.tab,
          active: true,
          order: consumed.order,
          owner: { value: policyOwner },
        });
      }
    }
    await clearUsageLimitedChat(
      {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId,
      },
      { onlyIfDetectedBefore: dispatchStartedAt },
    );
    return { ok: true, chatId };
  }

  const { dispatchWorktreeChatTurn: dispatchTurn } =
    await import('../lib/worktree-chat-turn');
  const dispatchWorktreeChatTurn = (
    turn: DispatchWorktreeChatTurnOptions<WorktreePortalEventCommit>,
  ): Promise<void> =>
    trustedAgentRequest
      ? withAgentSenderAuthority(
          trustedAgentRequest,
          () => dispatchTurn(turn),
          revalidateAgentSenderRequest,
        )
      : dispatchTurn(turn);
  const getWindow = options.getWindow ?? getNullWindow;
  if (!existingTab) {
    // A portal-minted chat exists only in the tabs file at this point. The
    // renderer persists each worktree's chat tabs as a whole file from its
    // in-memory store, so a store that never learns about this tab silently
    // erases it on its next debounced save. Reuse the hook-tab-started
    // insertion path (precedent: rebase-resolution and builtin-gh chats)
    // without activating the tab so the desktop UI doesn't jump mid-use.
    sendToWindow(getWindow(), IPC_CHANNELS.chatHookTabStarted, {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId,
      tab: selectedTab,
      activateTab: false,
    });
  }
  const portalScope = portalChatEventScope(
    request.projectId,
    request.worktreeId,
  );
  const emitMessage = (message: PortalChatMessage): void => {
    enqueuePortalEvent(
      createPortalEvent('portal.chat.event', {
        ...portalScope,
        chatId,
        message,
      }),
    );
  };
  emitMessage({
    messageId: userMessageId,
    chatId,
    role: 'user',
    ...('agentSent' in request && request.agentSent
      ? { agentSent: request.agentSent }
      : {}),
    status: 'complete',
    text: request.text,
    ...portalUserAttachments(userMessageId, request.attachmentPaths),
    ...portalPromptProvenance(userMessage),
    createdAtMs: now,
  });
  // Canonical turn state publishes committed timer rows to the portal.
  // Cursor streams patches against one assistant message; fold them per turn
  // so the browser sees the growing text under the persisted message id.
  const primaryTurn = createWorktreePortalPrimaryTurn({ ...request, chatId });
  const primaryTools = primaryTurn.tools;
  const cursorPatches = createCursorAssistantPatchProjector({
    ...portalScope,
    chatId,
  });
  sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId,
    data: {
      type: 'canopy_user_prompt',
      original_text: request.text,
      canopy_turn_user_message_id: userMessageId,
      provider:
        request.providerType ??
        (request.model ? getProviderForModel(request.model) : undefined),
      canopy_persisted_messages: [userMessage],
    },
  });
  if (startsNewTrackedChat) {
    await notifyCanonicalChatStarted(
      { projectId: request.projectId, worktreeId: request.worktreeId, chatId },
      userMessageId,
      selectedTab.newChatStartedWatcherFiredAt ?? createdAt,
    ).catch(() => undefined);
  }
  const pendingSystemInstructions =
    'pendingSystemInstructions' in request &&
    request.pendingSystemInstructions?.length
      ? request.pendingSystemInstructions
      : existingTab?.pendingSystemInstructions;
  const requestWithPendingSystemInstructions = {
    ...request,
    ...(pendingSystemInstructions?.length ? { pendingSystemInstructions } : {}),
  };
  let turnRequest = requestWithPendingSystemInstructions;
  if ('startsNewTrackedChat' in turnRequest) {
    const { startsNewTrackedChat, ...requestWithoutStartsNewTrackedChat } =
      turnRequest;
    void startsNewTrackedChat;
    turnRequest = requestWithoutStartsNewTrackedChat;
  }
  const forkSessionPersistenceTasks: Promise<void>[] = [];
  const terminalSummaryTasks: Promise<void>[] = [];
  const acceptanceCleanupTasks: Promise<void>[] = [];
  // Captured before the dispatch so the clear at the end of this function can
  // tell the entry this send is resuming apart from a NEW one the dispatched
  // turn records by immediately re-hitting the usage limit.
  try {
    await dispatchWorktreeChatTurn({
      ...turnRequest,
      ...(options.queueDispatch?.authorization
        ? { authorization: options.queueDispatch.authorization }
        : {}),
      admissionSignal: options.admissionSignal,
      requiredAccountProxyConnectionId:
        options.requiredAccountProxyConnectionId,
      countsTowardSkillUsage:
        !('hiddenContext' in request && request.hiddenContext) &&
        (getRequestInitiationSource(request) === 'user' ||
          getRequestInitiationSource(request) === 'portal'),
      // The tab as persisted for this turn: an automation may have just
      // re-captured its context above.
      ...(selectedTab.executionContext !== undefined
        ? { executionContext: selectedTab.executionContext }
        : {}),
      modelConfig,
      chatId,
      userMessageId,
      planMode: request.planMode ?? false,
      approvalMode,
      sessionApprovalRules,
      initiationSource: getRequestInitiationSource(request) ?? 'portal',
      getWindow,
      turnDispatchTiming,
      providerEventSequenceNamespace: options.creditRetryAttemptId,
      onBeforeChatEvent: async (event) => {
        const portalEmissionContext = capturePortalEmissionContext();
        const acceptedTurnUserMessageId = event.turnUserMessageId;
        const primaryToolEpoch = primaryTurn.capture(
          event.sequenceNamespace,
          acceptedTurnUserMessageId,
          portalEmissionContext,
        );
        // The provider that ran wins: lane selection may substitute one.
        const providerType = event.providerType ?? request.providerType;
        const outcome =
          await getChatStateService().ingestProviderEventWithResult({
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            chatId: event.chatId,
            data: event.data,
            mutationId: `${chatId}:${userMessageId}:provider:${event.sequenceNamespace}:${event.sequence}`,
            ...(providerType ? { providerType } : {}),
            ...(event.turnUserMessageId
              ? { turnUserMessageId: event.turnUserMessageId }
              : {}),
            ...(event.onCommitQueued
              ? { onCommitQueued: event.onCommitQueued }
              : {}),
          });
        return {
          ...normalizeProviderEventIngestResult(outcome),
          portalEmissionContext,
          acceptedTurnUserMessageId,
          sequenceNamespace: event.sequenceNamespace,
          primaryToolEpoch,
        };
      },
      onTurnAccepted: () => {
        options.onTurnAccepted?.();
        const acceptedPromptTask = emitAcceptedUserPrompt(
          getWindow,
          {
            ...queuedRequest,
            chatId,
            userMessageId,
          },
          pendingSystemInstructions?.map((instruction) => instruction.id),
        ).catch((error: unknown) => {
          logMainProcessWarn(
            '[chat-service] Failed to commit accepted turn state',
            error,
          );
        });
        acceptanceCleanupTasks.push(acceptedPromptTask);
        const cleanupTask = clearPersistedUsageLimitBanner({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId,
          expectedBannerState: usageLimitBannerBeforeDispatch,
        }).catch((error: unknown) => {
          logMainProcessWarn(
            '[chat-service] Failed to clear accepted turn recovery banner',
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId,
              error,
            },
          );
        });
        acceptanceCleanupTasks.push(cleanupTask);
        if (pendingSystemInstructions?.length) {
          const instructionCleanupTask =
            consumePersistedPendingSystemInstructions({
              workspaceId: request.projectId,
              worktreeId: request.worktreeId,
              chatId,
              instructionIds: pendingSystemInstructions.map(
                (instruction) => instruction.id,
              ),
            })
              .then((result) => {
                if (!result) return;
                return emitTargetChatSummary({
                  workspaceId: request.projectId,
                  worktreeId: request.worktreeId,
                  tab: result.tab,
                  active: true,
                  order: result.order,
                  owner: { value: policyOwner },
                });
              })
              .catch((error: unknown) => {
                logMainProcessWarn(
                  '[chat-service] Failed to clear accepted turn system instructions',
                  {
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    chatId,
                    error,
                  },
                );
              });
          acceptanceCleanupTasks.push(instructionCleanupTask);
        }
      },
      onChatEvent: (event) => {
        const completion = event.beforeChatEventResult;
        const emissionContext = completion?.portalEmissionContext;
        const emissionCurrent =
          emissionContext !== undefined &&
          isPortalEmissionContextCurrent(emissionContext);
        const admissionCurrent =
          emissionCurrent &&
          primaryTurn.isCurrent(completion?.primaryToolEpoch);
        if (
          !emissionCurrent &&
          primaryTurn.isCurrent(completion?.primaryToolEpoch)
        )
          primaryTurn.settle();
        const emitCurrentMessage = (message: PortalChatMessage): void => {
          if (!emissionContext) return;
          enqueuePortalEventIfCurrent(
            emissionContext,
            createPortalEvent('portal.chat.event', {
              ...portalScope,
              chatId,
              message,
            }),
          );
        };
        const terminal = event.isTerminalEvent;
        const forkSessionId = claudeForkSessionIdFromInit(event.data);
        if (forkSessionId) {
          const persistenceTask = consumeClaudeForkSessionMarkerWithOrder({
            workspaceId: request.projectId,
            worktreeId: request.worktreeId,
            chatId,
            sessionId: forkSessionId,
          }).then((result) => {
            if (!result) return;
            return emitTargetChatSummary({
              workspaceId: request.projectId,
              worktreeId: request.worktreeId,
              tab: result.tab,
              active: true,
              order: result.order,
              owner: { value: policyOwner },
            });
          });
          // Attach a rejection handler immediately; the task is awaited after
          // dispatch so persistence failures still reject the send operation.
          void persistenceTask.catch(() => undefined);
          forkSessionPersistenceTasks.push(persistenceTask);
        }
        const cursorMessage = cursorPatches.apply(event.data);
        let message =
          cursorMessage ??
          runtimeChatEventToPortalMessage({
            ...portalScope,
            chatId: event.chatId,
            data: event.data,
            fallbackMessageId: `${userMessageId}:assistant`,
          });
        if (
          admissionCurrent &&
          !cursorMessage &&
          message &&
          isRecord(event.data) &&
          (event.data.type === 'codex' ||
            event.data.type === 'user' ||
            event.data.type === 'assistant')
        ) {
          if (completion?.outcome === 'applied' && completion.admission)
            primaryTools.retain(message.messageId, completion.admission);
          const admittedMessage = runtimeChatEventToPortalMessage({
            scope: 'worktree',
            workspaceLocalId: event.projectId,
            worktreeLocalId: event.worktreeId,
            chatId: event.chatId,
            data: event.data,
            fallbackMessageId: `${userMessageId}:assistant`,
            admission: primaryTools.forMessage(message.messageId),
          });
          if (admittedMessage)
            message = { ...message, parts: admittedMessage.parts };
        }
        if (message) {
          // The canonical onBeforeChatEvent ingestion owns persistence and
          // summary/TODO projections. This display projection is lossy (tool
          // output is truncated) and must never overwrite the durable transcript
          // or race a completed timer with an older compatibility snapshot.
          emitCurrentMessage(message);
        }
        if (terminal && primaryTurn.isCurrent(completion?.primaryToolEpoch))
          primaryTurn.settle();
        if (terminal && isCoworkWorkspace(request.projectId)) {
          const pendingPersistenceTasks = [
            ...forkSessionPersistenceTasks,
            ...terminalSummaryTasks,
          ];
          const terminalSummaryTask = Promise.allSettled(
            pendingPersistenceTasks,
          ).then(() =>
            emitLatestTargetChatSummary({
              workspaceId: request.projectId,
              worktreeId: request.worktreeId,
              chatId,
            }),
          );
          void terminalSummaryTask.catch(() => undefined);
          terminalSummaryTasks.push(terminalSummaryTask);
        }
      },
    }).catch((error: unknown) => {
      primaryTurn.retire();
      throw error;
    });
    await Promise.all(acceptanceCleanupTasks);
    await Promise.all(forkSessionPersistenceTasks);
    await Promise.all(terminalSummaryTasks);
  } catch (error: unknown) {
    await Promise.allSettled(acceptanceCleanupTasks);
    if (isCoworkWorkspace(request.projectId)) {
      await Promise.allSettled([
        ...forkSessionPersistenceTasks,
        ...terminalSummaryTasks,
      ]);
      await emitLatestTargetChatSummary({
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
        chatId,
      }).catch(() => undefined);
    }
    throw error;
  }
  await clearUsageLimitedChat(
    {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId,
    },
    { onlyIfDetectedBefore: dispatchStartedAt },
  );
  return { ok: true, chatId };
}

export async function cancelWorktreeChat(
  request: ChatCancelRequest,
  captured?: ChatTurnStopContext,
): Promise<{ ok: true }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.chatId, 'chatId');
  retireWorktreePortalPrimaryTurn(request);
  const stopContext = captured ?? captureChatTurnStop(request);
  cancelTransientRetryForChat(request, 'stop');
  const { cancelChatTurn } = await import('../lib/chat-turn-cancel');
  const { preparationsCancelled } = await cancelChatTurn(
    request,
    'stop',
    stopContext,
  );
  // Without a native fence, a still-current Stop cancels the chat's preparing
  // sends. As the composer and standalone Stops do, release the queue's Stop
  // hold on them with an untagged terminal; a stale Stop leaves a newer send's
  // ownership alone. cancelChatTurn releases an idle native fence's own.
  if (stopContext.fence === undefined && preparationsCancelled) {
    const { getChatQueueService } = await import('./chat-queue-service');
    getChatQueueService().onTurnTerminal(request, 'cancelled');
  }
  return { ok: true };
}

/**
 * Cancel only the turn identified by its user-message id: the provider turn
 * canonical turn state names (D14), or a queued turn not yet started.
 */
export async function cancelWorktreeChatTurn(
  request: ChatCancelRequest & { turnId: string },
): Promise<{ ok: true; outcome: 'stop_requested' | 'turn_not_active' }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.chatId, 'chatId');
  validateId(request.turnId, 'turnId');
  if (isCoworkWorkspace(request.projectId)) {
    throw new Error('Standalone and Cowork chats are not worktree targets.');
  }
  const { buildSessionKey, cancelActiveChatTurn, requestChatTurnCancel } =
    await import('../agents/session-manager');
  const { getChatQueueService } = await import('./chat-queue-service');
  const key = buildSessionKey(
    request.projectId,
    request.worktreeId,
    request.chatId,
  );
  const target = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
  };
  const queue = getChatQueueService();
  // Synchronous until the withdrawal below, so no turn starts in between.
  if (cancelActiveChatTurn(key, request.turnId)) {
    return { ok: true, outcome: 'stop_requested' };
  }
  if (queue.runningTurnUserMessageId(target) === request.turnId) {
    // Claimed by the queue but not yet marked active by its provider: stop it
    // the moment it is, by its own identity, never another turn.
    requestChatTurnCancel(key, request.turnId);
    return { ok: true, outcome: 'stop_requested' };
  }
  if (!queue.holdsUserMessage(target, request.turnId)) {
    return { ok: true, outcome: 'turn_not_active' };
  }
  // A turn still waiting in the queue has not started; withdrawing it stops it
  // for good.
  const withdrawn = await queue.withdrawQueuedUserMessage(
    target,
    request.turnId,
  );
  if (withdrawn !== 'applied') {
    // The queue was busy, or it moved the message on meanwhile: stop the turn
    // as soon as it starts, so the stop is never reported without applying.
    requestChatTurnCancel(key, request.turnId);
  }
  return { ok: true, outcome: 'stop_requested' };
}

export async function listWorktreeChatTranscript(input?: {
  workspaceId?: string;
  worktreeId?: string;
  chatId?: string;
}): Promise<PortalChatMessage[]> {
  return (await getWorktreeChatTranscriptSeed(input)).messages;
}

/**
 * Adds the child rows of cards whose children are in the chat's delegate log
 * (`transcriptStore: 'chat-log-v1'`), so Portal projects them like the rows
 * of cards written before delegate logs.
 */
async function withLoggedDelegationChildren(
  scope: { projectId: string; worktreeId: string },
  chatId: string,
  messages: readonly PersistedChatMessage[],
): Promise<PersistedChatMessage[]> {
  const parents = new Set(
    messages.flatMap((message) =>
      message.parentBlockId ? [message.parentBlockId] : [],
    ),
  );
  const cards = messages.flatMap((message) =>
    message.blocks.filter(
      (block) =>
        block.type === 'delegated_agent_call' &&
        block.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_LOG &&
        !parents.has(block.agentBlockId),
    ),
  );
  if (cards.length === 0) return [...messages];
  const children: PersistedChatMessage[] = [];
  for (const card of cards) {
    if (card.type !== 'delegated_agent_call') continue;
    try {
      const items = await getChatStateService().readDelegationItems({
        ...scope,
        chatId,
        delegationId: card.delegationId,
        runGeneration: card.runGeneration,
      });
      children.push(...delegationChildMessages(card.agentBlockId, items));
    } catch (error) {
      // A card without its log still projects; its children are missing.
      logMainProcessWarn(
        '[chat-service] Unable to read a delegated task transcript',
        error,
      );
    }
  }
  return [...messages, ...children];
}

export async function getWorktreeChatTranscriptSeed(input?: {
  workspaceId?: string;
  worktreeId?: string;
  chatId?: string;
}): Promise<PortalChatTranscriptSeed> {
  if (!input?.workspaceId || !input.worktreeId) {
    return { messages: [], truncated: false };
  }
  validateId(input.workspaceId, 'workspaceId');
  validateId(input.worktreeId, 'worktreeId');
  const metadata = await portalChatTabsCache.read(
    input.workspaceId,
    input.worktreeId,
  );
  const tabs = metadata.tabs.filter(
    (tab) =>
      (tab.kind ?? 'chat') === 'chat' &&
      (!input.chatId || tab.id === input.chatId),
  );
  let result: PortalChatTranscriptSeed = { messages: [], truncated: false };
  for (const tab of tabs) {
    const selected = await portalChatTabsCache.read(
      input.workspaceId,
      input.worktreeId,
      { chatIds: [tab.id], pageOnly: true },
    );
    const loaded = selected.tabs.find((candidate) => candidate.id === tab.id);
    if (!loaded) continue;
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      workspaceLocalId: input.workspaceId,
      worktreeLocalId: input.worktreeId,
      chatId: tab.id,
      messages: await withLoggedDelegationChildren(
        { projectId: input.workspaceId, worktreeId: input.worktreeId },
        tab.id,
        loaded.messages,
      ),
      autoRoutedModels: loaded.autoRoutedModels,
      turnEnds: loaded.turnEnds,
      unacceptedTurnEnds: loaded.unacceptedTurnEnds,
      interruptedTurns: loaded.interruptedTurns,
    });
    const bounded = limitPortalChatTranscriptForSeedWithMetadata(
      [...result.messages, ...projected].sort(
        (left, right) => left.createdAtMs - right.createdAtMs,
      ),
    );
    result = {
      ...bounded,
      truncated:
        result.truncated ||
        bounded.truncated ||
        loaded.transcriptWindow?.before !== undefined,
    };
  }
  return result;
}

export async function listWorktreeChatSummaries(input: {
  workspaceId: string;
  worktreeId: string;
}): Promise<PortalChatSummaryEntity[]> {
  validateId(input.workspaceId, 'workspaceId');
  validateId(input.worktreeId, 'worktreeId');
  const tabsFile = await portalChatTabsCache.read(
    input.workspaceId,
    input.worktreeId,
  );
  const chatTabs = tabsFile.tabs.filter(
    (tab) => (tab.kind ?? 'chat') === 'chat',
  );
  const agentDefaultModel = await catalogAgentDefaultModel(input.workspaceId);
  const scheduledMessageContext = await getScheduledMessageSummaryContext();
  return mapWithConcurrency(chatTabs, 4, async (tab, index) => {
    const owner = await resolveAiCreditsScopeOwner({
      kind: 'work',
      projectId: input.workspaceId,
      worktreeId: input.worktreeId,
      chatId: tab.id,
    });
    const summary = chatSummaryEntity({
      workspaceId: input.workspaceId,
      worktreeId: input.worktreeId,
      tab,
      active: tab.id === tabsFile.activeTabId,
      // Already filtered to chat tabs, so the array index IS the chat-tab order.
      order: index,
      // File-backed snapshots and re-projections must carry an explicit []
      // when no questions remain so the portal can clear stale cards.
      pendingQuestions: tabsFile.pendingQuestions ?? [],
      surface: 'worktree',
      owner,
      agentDefaultModel,
      ...scheduledMessageContext,
    });
    return {
      ...summary,
      lastMessageRole: await readChatLastMessageRole(
        input.workspaceId,
        input.worktreeId,
        tab,
      ),
    };
  });
}

/**
 * Re-project and emit `chat_summary` deltas for every chat in a worktree
 * (CAN-1217). Called after a desktop-side tab write so composer flips
 * (plan/thinking/fast/model/plugins) reach the portal live instead of waiting
 * for the next full snapshot. No-op — and never touches disk — when no portal
 * session is connected, so desktop-only users pay nothing. Best-effort: a read
 * failure is swallowed so it can never break the originating tab save.
 */
export async function projectWorktreeChatSummaries(input: {
  workspaceId: string;
  worktreeId: string;
}): Promise<void> {
  try {
    await projectWorktreeChatSummariesStrict(input);
  } catch {
    // Projection is a best-effort mirror; the persisted tab write is durable.
  }
}

/**
 * {@link projectWorktreeChatSummaries} that rejects on failure, for the
 * post-commit projection, which retries failed runs.
 */
export async function projectWorktreeChatSummariesStrict(input: {
  workspaceId: string;
  worktreeId: string;
}): Promise<void> {
  if (!isCanopyPortalActive()) {
    return;
  }
  const summaries = await listWorktreeChatSummaries(input);
  for (const summary of summaries) {
    emitChatSummary(summary);
  }
}

/**
 * Emit `chat_summary` removal deltas so a connected portal evicts chat tabs that
 * were just closed on the desktop. The projection layer is upsert-only — a bare
 * re-projection ({@link projectWorktreeChatSummaries}) never tells the portal a
 * tab is GONE — so the tab-persist choke point diffs the previous and next tab
 * id sets and calls this with the removed ids. No-op when no portal session is
 * connected, so desktop-only users pay nothing.
 */
export function projectWorktreeChatSummaryRemovals(input: {
  workspaceId: string;
  worktreeId: string;
  removedChatIds: readonly string[];
}): void {
  for (const chatId of input.removedChatIds) {
    browserHandoffs.releaseOrigin({
      projectId: input.workspaceId,
      worktreeId: input.worktreeId,
      chatTabId: chatId,
    });
    forgetPresentationChat(
      presentationChatKey({
        projectId: input.workspaceId,
        worktreeId: input.worktreeId,
        chatTabId: chatId,
      }),
    );
  }
  if (!isCanopyPortalActive() || input.removedChatIds.length === 0) {
    return;
  }
  for (const chatId of input.removedChatIds) {
    enqueuePortalEvent(
      createPortalEvent('portal.state.delta', {
        scope: 'chat',
        target: {
          workspaceLocalId: input.workspaceId,
          worktreeLocalId: input.worktreeId,
          chatLocalId: chatId,
        },
        removed: [
          {
            entityType: 'chat_summary',
            localId: chatId,
            parentLocalId: worktreeScopedParentLocalId(
              input.workspaceId,
              input.worktreeId,
            ),
          },
        ],
        generatedAt: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Armed (status `active`) App Advisor watcher counts keyed by destination
 * chat id (CAN-2569). Best-effort: a watcher-store read failure yields an
 * empty map so summary projection can never break on the watcher file.
 */
async function countArmedAppAdvisorWatchersByChatId(): Promise<
  Map<string, number>
> {
  const counts = new Map<string, number>();
  try {
    const watchers = await getAppAdvisorWatcherService().list();
    for (const watcher of watchers) {
      if (
        watcher.status !== 'active' ||
        watcher.destination.projectId !== APP_ADVISOR_PROJECT_ID
      ) {
        continue;
      }
      const chatId = watcher.destination.chatId;
      counts.set(chatId, (counts.get(chatId) ?? 0) + 1);
    }
  } catch {
    // Watcher counts are decorative on the summary; the tab data still ships.
  }
  return counts;
}

/**
 * Bounded persisted-transcript seed for the untargeted `app_advisor`
 * snapshot (CAN-2562). Server-side `PortalChatMessage` rows are per portal
 * session, so a freshly paired browser has no history source for
 * pre-existing App Advisor tabs unless the snapshot carries it — the same
 * contract the worktree/standalone snapshot seeds already satisfy. Messages
 * project with the `app_advisor` wire scope and no workspace routing.
 */
export async function getAppAdvisorChatTranscriptSeed(input?: {
  chatId?: string;
  entryId?: string;
}): Promise<PortalChatTranscriptSeed> {
  // Failures REJECT rather than degrade: the app_advisor snapshot is an
  // authoritative replacement, and a partial read mislabeled as a complete
  // non-truncated seed would let the server prune rows the failed entry
  // still owns (another entry's messages supplying the prune cutoff).
  // A selected chat is the latency-critical portal path. Resolve its owning
  // Work Entry first so opening one transcript never projects every other
  // persisted App Advisor history. The returned seed is deliberately marked
  // truncated because an app_advisor snapshot is authoritative for the whole
  // sentinel scope; a targeted seed must never prune cached rows for siblings.
  const preferredChatId = input?.chatId;
  if (preferredChatId) validateId(preferredChatId, 'chatId');
  if (input?.entryId) validateId(input.entryId, 'entryId');
  const preferredEntryId = preferredChatId
    ? (input?.entryId ??
      (await resolveWorkEntryForChat(APP_ADVISOR_PROJECT_ID, preferredChatId))
        .entryId)
    : null;
  if (preferredChatId && !preferredEntryId) {
    return { messages: [], truncated: true };
  }

  // Bounded concurrency mirrors the snapshot builder's summary reads. Cap
  // each persisted tab BEFORE the comparatively expensive text/tool
  // projection: no tab can contribute more than the global 300-row wire cap,
  // so projecting an older prefix cannot affect the final seed. Include the
  // preceding user row when the cut lands mid-turn so persisted timer rows
  // retain the same canonical live-wire id.
  const entryIds = preferredEntryId
    ? [preferredEntryId]
    : await listWorkEntryIds(APP_ADVISOR_PROJECT_ID);
  const transcripts = await mapWithConcurrency(entryIds, 4, async (entryId) => {
    const tabsFile = await portalChatTabsCache.read(
      APP_ADVISOR_PROJECT_ID,
      entryId,
    );
    let truncated = false;
    let messages: PortalChatMessage[] = [];
    for (const tab of tabsFile.tabs.filter(
      (candidate) =>
        (candidate.kind ?? 'chat') === 'chat' &&
        (!preferredChatId || candidate.id === preferredChatId),
    )) {
      const selected = await portalChatTabsCache.read(
        APP_ADVISOR_PROJECT_ID,
        entryId,
        { chatIds: [tab.id], pageOnly: true },
      );
      const loaded = selected.tabs.find((candidate) => candidate.id === tab.id);
      if (!loaded) continue;
      const bounded = persistedMessagesForPortalSeed(loaded.messages);
      const projected = projectPersistedChatTranscript({
        scope: 'app_advisor',
        chatId: tab.id,
        messages: bounded.messages,
        turnEnds: loaded.turnEnds,
        unacceptedTurnEnds: loaded.unacceptedTurnEnds,
        interruptedTurns: loaded.interruptedTurns,
      });
      const limited = limitPortalChatTranscriptForSeedWithMetadata(
        [...messages, ...projected].sort(
          (left, right) => left.createdAtMs - right.createdAtMs,
        ),
      );
      messages = limited.messages;
      truncated ||=
        bounded.truncated ||
        limited.truncated ||
        loaded.transcriptWindow?.before !== undefined;
    }
    return { messages, truncated };
  });
  const sourceTruncated = transcripts.some(
    (transcript) => transcript.truncated,
  );
  const seed = limitPortalChatTranscriptForSeedWithMetadata(
    transcripts
      .flatMap((transcript) => transcript.messages)
      .sort((left, right) => left.createdAtMs - right.createdAtMs),
  );
  return {
    ...seed,
    truncated: preferredChatId ? true : seed.truncated || sourceTruncated,
  };
}

function persistedMessagesForPortalSeed(messages: PersistedChatMessage[]): {
  messages: PersistedChatMessage[];
  truncated: boolean;
} {
  if (messages.length <= PORTAL_CHAT_SEED_MESSAGE_LIMIT) {
    return { messages, truncated: false };
  }
  const start = messages.length - PORTAL_CHAT_SEED_MESSAGE_LIMIT;
  const retainedIndexes = new Set<number>();

  // A renderer may persist one SDK assistant event as `base`, `base:2`, …;
  // projection merges those rows only when the base is present. If the raw
  // cutoff lands inside such a group, retain the omitted base so hydration
  // neither loses its text nor exposes a duplicate suffixed wire row. The
  // group collapses again before the final 300-row seed limiter.
  const tailIds = new Set(messages.slice(start).map((message) => message.id));
  const requiredBases = new Map<string, PersistedChatMessage['role']>();
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const match = /^(.+):\d+$/.exec(message.id);
    if (match && !tailIds.has(match[1])) {
      requiredBases.set(match[1], message.role);
    }
  }
  if (requiredBases.size > 0) {
    for (let index = 0; index < start; index += 1) {
      const message = messages[index];
      if (!message) continue;
      const match = /^(.+):\d+$/.exec(message.id);
      const groupId = match?.[1] ?? message.id;
      if (requiredBases.get(groupId) === message.role) {
        retainedIndexes.add(index);
      }
    }
  }

  for (let index = start - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      retainedIndexes.add(index);
      break;
    }
  }
  return {
    messages: messages.filter(
      (_message, index) => index >= start || retainedIndexes.has(index),
    ),
    truncated: true,
  };
}

/**
 * Project one App Advisor Work Entry's chat tabs as `app_advisor_chat`
 * summaries (CAN-2565). Reuses the worktree summary internals with the App
 * Advisor sentinel routing, then strips the worktree-only `scope`/workspace
 * fields — the App Advisor wire shape is deliberately routing-free (`chatId`
 * alone identifies the tab). Pending ask-user questions come from the live
 * renderer-tool registry rather than the tabs file: App Advisor questions
 * never persist, so the in-memory pending map is the only source of truth.
 */
export interface AppAdvisorWorkEntryProjectionContext {
  entry: CoworkWorkEntryMeta;
  order: number;
}

async function findAppAdvisorWorkEntryProjectionContext(
  entryId: string,
  options?: { strictRead?: boolean },
): Promise<AppAdvisorWorkEntryProjectionContext | undefined> {
  const entries = await listWorkEntries(APP_ADVISOR_PROJECT_ID, options);
  const order = entries.findIndex((entry) => entry.id === entryId);
  const entry = entries[order];
  return entry ? { entry, order } : undefined;
}

async function resolveAppAdvisorWorkEntryProjectionContext(
  entryId: string,
): Promise<AppAdvisorWorkEntryProjectionContext> {
  const context = await findAppAdvisorWorkEntryProjectionContext(entryId);
  if (!context) {
    throw new Error(`Unknown App Advisor Work Entry ${entryId}`);
  }
  return context;
}

export async function listAppAdvisorChatSummaries(
  entryId: string,
  projectionContext?: AppAdvisorWorkEntryProjectionContext,
): Promise<PortalAppAdvisorChatSummary[]> {
  validateId(entryId, 'entryId');
  const { entry, order: workEntryOrder } =
    projectionContext ??
    (await resolveAppAdvisorWorkEntryProjectionContext(entryId));
  const tabsFile = await portalChatTabsCache.read(
    APP_ADVISOR_PROJECT_ID,
    entryId,
  );
  const pendingQuestions = listPendingAppAdvisorAskUserQuestions();
  const answeredQuestions = listAnsweredAppAdvisorAskUserQuestions();
  const armedWatcherCounts = await countArmedAppAdvisorWatchersByChatId();
  const windowUiState = getLatestAppAdvisorWindowUiState();
  const agentDefaultModel = await catalogAgentDefaultModel(
    APP_ADVISOR_PROJECT_ID,
  );
  const scheduledMessageContext = await getScheduledMessageSummaryContext();
  return tabsFile.tabs
    .filter((tab) => (tab.kind ?? 'chat') === 'chat')
    .map((tab, index) => {
      const { scope, workspaceLocalId, worktreeLocalId, ...summary } =
        chatSummaryEntity({
          workspaceId: APP_ADVISOR_PROJECT_ID,
          worktreeId: entryId,
          tab,
          active: tab.id === tabsFile.activeTabId,
          // Already filtered to chat tabs, so the index IS the chat-tab order.
          order: index,
          pendingQuestions: [],
          // App Advisor advertises Cursor only while the managed runtime is
          // connected (`providerAvailability` on the summary, not the tab).
          surface: 'app-advisor',
          owner: { kind: 'personal' },
          agentDefaultModel,
          ...scheduledMessageContext,
        });
      void scope;
      void workspaceLocalId;
      void worktreeLocalId;
      const armedWatcherCount = armedWatcherCounts.get(tab.id) ?? 0;
      const hasPersistedRouting =
        tab.executionHarness !== undefined ||
        tab.model !== undefined ||
        tab.providerType !== undefined ||
        tab.sdkSessionId !== undefined;
      return {
        ...summary,
        // Legacy started tabs may predate the persisted executionHarness
        // field. Project the same effective lock enforced by set_model so the
        // portal never advertises an incompatible model as selectable.
        executionHarness:
          hasPersistedRouting &&
          ((summary.messageCount ?? 0) > 0 ||
            (summary.queuedMessages?.length ?? 0) > 0)
            ? resolvePersistedChatExecutionHarness(tab)
            : summary.executionHarness,
        workEntryId: entry.id,
        workEntryTitle: entry.title,
        workEntryCreatedAt: entry.createdAt,
        ...(entry.lastMessageAt
          ? { workEntryLastMessageAt: entry.lastMessageAt }
          : {}),
        workEntryOrder,
        desktopCurrent:
          windowUiState.activeWorkEntryId === entryId &&
          windowUiState.activeChatId === tab.id,
        // Omitted at zero: the browser delta projector clears the cached
        // value on omission, so a count dropping to 0 still propagates.
        ...(armedWatcherCount > 0 ? { armedWatcherCount } : {}),
        // Explicit [] when no questions remain so the portal clears stale
        // cards, matching the worktree file-backed contract.
        pendingQuestions: [
          ...pendingQuestions
            .filter((entry) => entry.chatId === tab.id)
            .map(
              (entry): PortalAskUserQuestionState => ({
                requestId: entry.requestId,
                questions: [entry.question],
                answered: false,
              }),
            ),
          // Answered entries let the transcript's ask-user tool rows converge
          // to the read-only answered card instead of a perpetual pending
          // spinner — App Advisor questions have no persisted record, so this
          // capped in-memory projection is the only answered evidence the
          // portal gets (CAN-2608). Question text is projected verbatim: the
          // request has no toolUseId, so the browser matches by text.
          ...answeredQuestions
            .filter((entry) => entry.chatId === tab.id)
            .map(
              (entry): PortalAskUserQuestionState => ({
                requestId: entry.requestId,
                questions: [entry.question],
                answered: true,
                answers: [entry.answer],
              }),
            ),
        ],
      };
    });
}

/**
 * Re-project and emit `app_advisor_chat` deltas for every chat tab in an App
 * Advisor Work Entry (CAN-2565). Untargeted: `app_advisor` is a session-wide
 * scope, and the browser projector keys rows on `localId` alone. No-op — and
 * never touches disk — when no portal session is connected. Best-effort: a
 * read failure is swallowed so it can never break the originating write.
 */
export async function projectAppAdvisorChatSummaries(
  entryId: string,
): Promise<void> {
  try {
    await projectAppAdvisorChatSummariesStrict(entryId);
  } catch {
    // Projection is a best-effort mirror; the persisted tab write is durable.
  }
}

/**
 * {@link projectAppAdvisorChatSummaries} that rejects on failure, for the
 * post-commit projection, which retries failed runs.
 */
export async function projectAppAdvisorChatSummariesStrict(
  entryId: string,
): Promise<void> {
  if (!isCanopyPortalActive()) {
    return;
  }
  // An unreadable registry rejects so the projection retries; only a missing
  // registry or a deleted entry reads as nothing to project.
  const projectionContext = await findAppAdvisorWorkEntryProjectionContext(
    entryId,
    { strictRead: true },
  );
  // A deleted entry has nothing left to project, as for cowork entries; a
  // rejection would retry its scope's final commit forever.
  if (!projectionContext) return;
  const summaries = await listAppAdvisorChatSummaries(
    entryId,
    projectionContext,
  );
  for (const summary of summaries) {
    enqueuePortalEvent(
      createPortalEvent('portal.state.delta', {
        scope: 'app_advisor',
        entities: [
          {
            entityType: 'app_advisor_chat',
            localId: summary.chatId,
            payload: summary,
          },
        ],
        generatedAt: new Date().toISOString(),
      }),
    );
  }
}

/** Re-project every App Advisor Work Entry after registry-order changes. */
export async function projectAllAppAdvisorChatSummaries(
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCanopyPortalActive() || !isCurrent()) return;
  try {
    const entries = await listWorkEntries(APP_ADVISOR_PROJECT_ID);
    const groups = await mapWithConcurrency(
      entries.map((entry, order) => ({ entry, order })),
      4,
      ({ entry, order }) =>
        listAppAdvisorChatSummaries(entry.id, { entry, order }),
    );
    for (const summary of groups.flat()) {
      if (!isCanopyPortalActive() || !isCurrent()) return;
      enqueuePortalEvent(
        createPortalEvent('portal.state.delta', {
          scope: 'app_advisor',
          entities: [
            {
              entityType: 'app_advisor_chat',
              localId: summary.chatId,
              payload: summary,
            },
          ],
          generatedAt: new Date().toISOString(),
        }),
      );
    }
  } catch {
    // Projection is a best-effort mirror; the registry mutation is durable.
  }
}

/**
 * Emit `app_advisor_chat` removal deltas so a connected portal evicts App
 * Advisor tabs that disappeared from an entry's tabs file. Mirrors
 * {@link projectWorktreeChatSummaryRemovals}; the projection layer is
 * upsert-only, so re-projection alone never tells the portal a tab is GONE.
 */
export function projectAppAdvisorChatSummaryRemovals(input: {
  removedChatIds: readonly string[];
}): void {
  for (const chatId of input.removedChatIds)
    browserHandoffs.releaseChat(chatId);
  if (!isCanopyPortalActive() || input.removedChatIds.length === 0) {
    return;
  }
  for (const chatId of input.removedChatIds) {
    enqueuePortalEvent(
      createPortalEvent('portal.state.delta', {
        scope: 'app_advisor',
        removed: [
          {
            entityType: 'app_advisor_chat',
            localId: chatId,
          },
        ],
        generatedAt: new Date().toISOString(),
      }),
    );
  }
}
