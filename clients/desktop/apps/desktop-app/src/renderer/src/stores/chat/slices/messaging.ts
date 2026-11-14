import { createChatCommandEnvelope } from '../revisioned-commands';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { pendingEagerChatCreation } from '../hydration';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { splitWorktreeKey, worktreeKey } from '../utils';
import {
  selectChildToolLiveness,
  useLiveBackgroundTaskStore,
} from '../../liveBackgroundTaskStore';
import { getChatToastAttribution } from '../notifications';
import { recordWorktreeChatTouch } from '../hydration';
import {
  getWorktreeChatContext,
  resolveSendMessageTargetTab,
  updateCapturedChatTab,
} from '../context';
import {
  type ChatMessage,
  type ChatTab,
  type SendingLease,
  type SendMessageDispatchOptions,
  type WorktreeChatState,
} from '../types';
import {
  createSendingLease,
  expireSendingLease,
  hasPendingSendingLease,
  withoutSendingLease,
} from '../canonical-changes';
import { tagStatusWrite } from '../runtime-divergence';
import {
  armCloudStopRetry,
  cloudStopPromptId,
  presentedCloudStop,
} from '../cloud-stop';
import { chatStoreApi } from '../store-ref';
import type {
  ChatActivePlanContext,
  ChatResumeStoppedTurnResult,
  ChatSendAuthRefusal,
  PendingSystemInstruction,
} from '@canopy/desktop-shared/types';
import {
  presentableStoppedTurnResume,
  STOPPED_TURN_RESUME_FAILED_MESSAGE,
  STOPPED_TURN_RESUME_STALE_MESSAGE,
} from '../stopped-turn-resume';
import {
  appendQueuedMessageToTab,
  chatTabHasConversationContent,
  clearUsageLimitBannerForDispatchedUserMessage,
  createEmptyTab,
  getDefaultPlugins,
  isClaudeTerminalBackedChatTab,
  resolveTabProviderType,
  firstMessageTitlePatch,
  toQueuedDispatchOptions,
  WATCHER_TERMINAL_ONLY_MESSAGE,
} from '../tab-utils';
import {
  resolveDefaultChatInterfaceMode,
  resolveDeferredToolsAllowedDefault,
  resolveTabDefaults,
  resolveLaneForTarget,
  resolveBillingSeed,
} from '../defaults';
import { sanitizePluginSelectionsWithCachedSupport } from '../plugin-provider-support';
import {
  getEffectiveClaudeChatInterfaceMode,
  getPersistedClaudeChatInterfaceMode,
} from '@/lib/claude-tui-chats';
import {
  APP_ADVISOR_PROJECT_ID,
  DEFAULT_APP_ADVISOR_MODEL,
  getExecutionHarnessForModel,
  getProviderForModel,
  isTerminalBackedInterfaceMode,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_NAME,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import {
  isChatScopeCommandBlocked,
  isScopeRevisionedLive,
  waitForChatScopeLive,
} from './revisioned';
import { resolveClaudeForkResumePoint } from '@canopy/desktop-shared/lib/claude-fork-resume-point';
import { getLockedHarness } from '@/lib/chatProviderLock';
import {
  requestTabDiscovery,
  resolveDiscoveryProviderType,
} from '../discovery';
import {
  attachmentPromptContextsForPaths,
  buildAttachmentPromptContexts,
  uniqueAttachmentPaths,
} from '../attachments';
import { useGitHubStore } from '../../githubStore';
import { useProjectsStore } from '../../projectsStore';
import { nextMsgId } from '../ids';
import {
  buildClaudeTerminalPromptText,
  canSendToClaudeTerminalState,
  writeClaudeTerminalClearSequence,
  writeClaudeTerminalPrompt,
} from '../claudeTerminalPrompt';
import { terminalPresentationPrompt } from '@canopy/desktop-shared/lib/terminal-presentation';
import {
  type ClaudeTerminalClientState,
  useClaudeTerminalStore,
} from '@/stores/claudeTerminalStore';
import {
  resolveNativeSendSdkSessionId,
  scheduleTaskBranchNamingFromInitialInput,
  shouldEmitNewChatStartedWatcher,
  shouldStartFreshNativeAppAdvisorSessionAfterTerminal,
} from '../tab-lifecycle';
import { extractIpcErrorMessage } from '@/lib/errors';
import { appendConsumedClaudeTerminalInitialPrompt } from '../terminal-runtime';
import {
  clearPendingPlanExitForChat,
  clearPendingSystemInstructionsFromTab,
  consumePendingSystemInstructionsFromTab,
  retiresSupersededPlanExit,
} from '../plan-utils';
import { brandText } from '@/lib/brand';
import { isCoworkChatTarget } from '@/lib/cowork';
import { closeOpenToolUseBlocks, completeTurnTimer } from '../event-transforms';
import { isCodexMissingRolloutResumeError } from '../turn-events';
import { getRecoverableLastUserMessage } from '../messages';
import { toPersistedTab } from '../persisted-tabs';
import { isRetiredPlanChatScope } from '../plan-explore-registry';
import { RETIRED_PLAN_CHAT_MESSAGE } from '@canopy/desktop-shared/lib/retired-chat-scopes';
import {
  applyResolvedApprovalModeForNewTab,
  approvalDefaultCacheKey,
} from '../approval-defaults';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatMessagingSlice } from '../state';
import type { ChatCommandDisposition } from '../revisioned-commands';
import type { ChatBannerTarget } from '../../aiCreditsBannerStore';
import { isRendererGuestPrincipalHydrated } from '../../billingLaneRuntime';
import { pendingApprovalModeTransitions } from './approvals';
import { useOllamaConnectionBannerStore } from '../../ollamaConnectionBannerStore';
import { useAppAdvisorWatchersStore } from '../../appAdvisorWatchersStore';
import { usePipelineRunsStore } from '../../pipelineRunsStore';
import {
  projectAgentArtifacts,
  selectPersistableCarryReceipts,
  selectWatchedCarryReceipts,
} from '@/components/chat/agent-artifact-projection';
import type { AgentArtifactCarryReceiptV1 } from '@canopy/desktop-shared/types/agent-artifacts';
import { MAX_PENDING_CLAUDE_TERMINAL_WATCHER_MESSAGES } from '../pendingClaudeTerminalWatchers';
import {
  adoptableProvisionalFirstSend,
  isProvisionalFirstSendAdmissionPending,
  handOffProvisionalFirstSendToQueue,
  cancelProvisionalFirstSendQueue,
  failProvisionalFirstSendOnTab,
  presentProvisionalFirstSendOnTab,
  retryFailedProvisionalFirstSendOnTab,
  withdrawProvisionalFirstSendFromTab,
  rejectUndispatchedProvisionalFirstSend,
} from '../provisional-first-send';
import {
  type ChatBackendCancelResult,
  chatBackendFor,
  ignoreUnavailable,
  isCapabilityUnavailable,
} from '../backend';
import { selectionSaveSettled } from '../web-core/selection-saves';
import { taskCreationSettled } from '../web-core/task-creations';
import { isWebCoreScope } from '@/lib/chat-authority';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import { WebCoreSendRefusedError } from '../web-core/send-refusal';
import { useWebCoreStartingTurnStore } from '../web-core/starting-turns';
import { liveReplyKey } from '../web-core/live-replies';

/**
 * Whether a cloud send failed because the web core refused it outright, or
 * the window refused it before asking: either way nothing was posted. A
 * send whose outcome is unknown is neither.
 */
function isWebCoreSendRefusal(error: unknown): boolean {
  return (
    error instanceof WebCoreSendRefusedError ||
    (!(error instanceof CoreCoworkRequestError) &&
      isCapabilityUnavailable(error))
  );
}

const ACCEPTED_AGENT_SENDER_UNREACHABLE_MESSAGE =
  'The agent that sent this message can no longer reach this chat.';

// Stop can arrive while the renderer is preparing a send, before main has a
// provider turn to cancel. Keep that intent with the individual preparation;
// a later send or canonical terminal may clear the tab's presentation flags.
// `dispatched` marks a send the host has taken: a cloud chat's backend owns
// its Stop from then on (CAN-6592).
interface NativeSendPreparation {
  cancelled: boolean;
  dispatched: boolean;
}
const pendingNativeSends = new Map<string, Set<NativeSendPreparation>>();
function nativeSendKey(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

/**
 * Mark a sending lease expired at its deadline when canonical runtime never
 * acknowledged it, so the composer stops showing it as starting and local
 * queue rows offer Retry for the uncertain delivery (CAN-5031).
 */
export function scheduleSendingLeaseExpiry(
  key: string,
  chatId: string,
  lease: SendingLease,
): void {
  setTimeout(
    () => {
      chatStoreApi().setState((state) => {
        const worktreeChats = expireSendingLease(
          state.worktreeChats,
          key,
          chatId,
          lease.userMessageId,
          Date.now(),
        );
        return worktreeChats === state.worktreeChats
          ? state
          : { worktreeChats };
      });
    },
    Math.max(0, lease.deadline - Date.now()),
  );
}

/** Drop a lease once its command reply settles it (accepted or refused). */
function releaseSendingLease(
  key: string,
  chatId: string,
  userMessageId: string,
): void {
  chatStoreApi().setState((state) => {
    const wc = state.worktreeChats[key];
    const tab = wc?.tabs.find((candidate) => candidate.id === chatId);
    if (!wc || tab?.sendingLease?.userMessageId !== userMessageId) {
      return state;
    }
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [key]: {
          ...wc,
          tabs: wc.tabs.map((candidate) =>
            candidate.id === chatId
              ? withoutSendingLease(candidate, userMessageId)
              : candidate,
          ),
        },
      },
    };
  });
}

function hasQueuedAcceptedInput(
  tab: ChatTab,
  acceptedInputId: string | undefined,
): boolean {
  return (
    acceptedInputId !== undefined &&
    tab.queuedMessages.some(
      (message) => message.dispatchOptions?.acceptedInputId === acceptedInputId,
    )
  );
}

function qualifyingArtifactCarry(
  tab: ChatTab,
  destination: { projectId: string; worktreeId: string; chatId: string },
): readonly AgentArtifactCarryReceiptV1[] {
  const { chatInitiatedPipelineRuns } = projectAgentArtifacts(tab.messages);
  // Same rule as the pinned section: runs this chat launched stay with their
  // launching turn and are never carried into the new one (CAN-4690).
  return selectPersistableCarryReceipts(
    selectWatchedCarryReceipts(
      chatInitiatedPipelineRuns,
      usePipelineRunsStore.getState().summaries,
      useAppAdvisorWatchersStore.getState().watchers,
      destination,
    ),
    chatInitiatedPipelineRuns,
  );
}

/**
 * The transcript's own account of a send the host refused on a broken auth
 * dependency (CAN-1814 PR 7).
 *
 * The blockers ride on the block as `authFailures`, which is the field
 * `ChatBlockRenderer` already routes to `AuthRecoveryCard` — the same card the
 * mid-turn failure path renders, with the same per-row reconnect actions.
 * `text` stays populated as the plain-language fallback for any reader that
 * does not understand the structured field (an exported archive, an older
 * transcript projection).
 *
 * ALWAYS the plural `authFailures`, never the singular `authFailure`: a
 * refusal can name several dependencies at once, the card renders a row per
 * dependency, and `readAuthDependencyFailures` reads both fields anyway.
 */
function authDependencyRefusalMessage(
  refusal: ChatSendAuthRefusal,
  refusedAt: number,
): ChatMessage {
  return {
    id: nextMsgId(),
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: refusal.message,
        authFailures: [...refusal.failures],
      },
    ],
    timestamp: refusedAt,
  };
}

interface AuthDependencyRefusalOptions {
  /**
   * Whether the refusal also ENDS the tab's turn.
   *
   * True on the immediate-dispatch path, where the refused message was the
   * turn. False on the host-queue path, where the renderer believed a turn was
   * already streaming: the follow-up never entered the queue, but a live turn
   * is not this send's to close, so the card is appended without touching
   * `status` or the running turn timer.
   */
  failTab: boolean;
  /** Only meaningful with `failTab`; re-arms the new-chat watcher. */
  startsNewTrackedChat?: boolean;
}

/**
 * Show the refusal in the transcript, with the recovery card attached.
 *
 * Nothing here is durable. Main refused BEFORE writing the tab, the user
 * message, or any queue row — that placement is the whole point of a send
 * preflight — and chat durability is main-owned, so this renderer-local state
 * is exactly as transient as the refusal it explains.
 */
function applyAuthDependencyRefusal(
  set: (updater: (state: ChatState) => Partial<ChatState> | ChatState) => void,
  key: string,
  chatId: string,
  refusal: ChatSendAuthRefusal,
  options: AuthDependencyRefusalOptions,
): void {
  const refusedAt = Date.now();
  set((state) => {
    const wc = state.worktreeChats[key];
    if (!wc) return state;
    const tabs = wc.tabs.map((tab) => {
      if (tab.id !== chatId) return tab;
      const refusalMessage = authDependencyRefusalMessage(refusal, refusedAt);
      if (!options.failTab) {
        return { ...tab, messages: [...tab.messages, refusalMessage] };
      }
      const { projectId, worktreeId } = splitWorktreeKey(key);
      // A refused send ends no background work from an earlier turn.
      const completedMessages = closeOpenToolUseBlocks(
        completeTurnTimer(tab.messages, refusedAt),
        {
          liveness: selectChildToolLiveness(
            useLiveBackgroundTaskStore.getState(),
            projectId,
            worktreeId,
            chatId,
          ),
          codexRootThreadId: tab.sdkSessionId,
        },
      );
      const refusedTab: ChatTab = {
        ...tab,
        status: 'error',
        error: refusal.message,
        messages: [...completedMessages, refusalMessage],
        lastTurnWasResumeAttempt: undefined,
      };
      if (options.startsNewTrackedChat === true) {
        delete refusedTab.newChatStartedWatcherFiredAt;
        refusedTab.newChatStartedWatcherPending = true;
      }
      return refusedTab;
    });
    const updated: WorktreeChatState = { ...wc, tabs };
    return { worktreeChats: { ...state.worktreeChats, [key]: updated } };
  });
}

/**
 * Refuse a send to a legacy plan chat before any work: no surface shows the
 * retired plan-chat scope, so a turn there would run where nobody can see
 * or stop it. Reports the rejection (and throws for callers that asked for
 * dispatch failures) and returns true when the send must stop.
 */
function refuseRetiredPlanChatSend(
  projectId: string,
  options: SendMessageDispatchOptions | undefined,
): boolean {
  if (!isRetiredPlanChatScope(projectId)) return false;
  options?.onPreDispatchRejected?.();
  if (options?.throwOnDispatchFailure === true) {
    throw new Error(RETIRED_PLAN_CHAT_MESSAGE);
  }
  return true;
}

function isOllamaUnavailableIpcError(error: unknown): boolean {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return raw.includes(`${OLLAMA_SERVER_UNAVAILABLE_ERROR_NAME}:`);
}

function waitForPendingApprovalModeTransitions(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<void> | undefined {
  return pendingApprovalModeTransitions(projectId, worktreeId, chatId);
}

/**
 * Resolve a send's active-plan context into its one-turn `active-plan`
 * instruction for a terminal-backed chat, whose prompt the renderer composes
 * (main resolves it for every other send). A failed or empty prepare sends
 * the message without it: plan context never blocks a turn.
 */
async function prepareTerminalActivePlanInstruction(
  scope: { projectId: string; worktreeId: string },
  activePlan: ChatActivePlanContext,
): Promise<PendingSystemInstruction | undefined> {
  try {
    const response = await chatBackendFor(
      scope,
    ).chat.preparePlanFileSystemInstruction({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      planId: activePlan.planId,
      purpose: 'active-plan',
      ...(activePlan.viewedRevisionNumber !== undefined
        ? { viewedRevisionNumber: activePlan.viewedRevisionNumber }
        : {}),
    });
    return response.instruction;
  } catch {
    return undefined;
  }
}

/**
 * The instructions a terminal-backed prompt carries: the tab's one-shot
 * instructions plus this send's active-plan instruction, unless the tab
 * already points the turn at the same plan's file (`plan-file-location:`),
 * matching main's rule for provider sends. The result is used for this
 * prompt only; the tab keeps just its own instructions.
 */
function terminalPromptSystemInstructions(
  tabInstructions: PendingSystemInstruction[] | undefined,
  activePlan: ChatActivePlanContext | undefined,
  activePlanInstruction: PendingSystemInstruction | undefined,
): PendingSystemInstruction[] | undefined {
  if (
    !activePlan ||
    !activePlanInstruction ||
    tabInstructions?.some(
      (instruction) =>
        instruction.id === `plan-file-location:${activePlan.planId}`,
    ) === true
  ) {
    return tabInstructions;
  }
  return [...(tabInstructions ?? []), activePlanInstruction];
}

function clearAcceptedQueuedComposerAttachments(
  tab: ChatTab,
  submittedAttachments: NonNullable<ChatTab['pendingAttachments']>,
  submittedRevertAttachmentPath: string | undefined,
): ChatTab {
  const submittedAttachmentInstances = new Set(submittedAttachments);
  const currentAttachments = tab.pendingAttachments ?? [];
  const remainingAttachments = currentAttachments.filter(
    (attachment) => !submittedAttachmentInstances.has(attachment),
  );
  const attachmentsChanged =
    remainingAttachments.length !== currentAttachments.length;
  const revertAttachmentChanged =
    submittedRevertAttachmentPath !== undefined &&
    tab.pendingRevertAttachmentPath === submittedRevertAttachmentPath;

  if (!attachmentsChanged && !revertAttachmentChanged) {
    return tab;
  }

  const next = { ...tab };
  if (attachmentsChanged) {
    next.pendingAttachments =
      remainingAttachments.length > 0 ? remainingAttachments : undefined;
  }
  if (revertAttachmentChanged) {
    delete next.pendingRevertAttachmentPath;
  }
  return next;
}

/** Applies `updater` to one chat tab; unchanged state when nothing moved. */
function updateChatTab(
  state: ChatState,
  key: string,
  chatId: string,
  updater: (tab: ChatTab) => ChatTab,
): Partial<ChatState> | ChatState {
  const scope = state.worktreeChats[key];
  if (!scope) return state;
  let changed = false;
  const tabs = scope.tabs.map((tab) => {
    if (tab.id !== chatId) return tab;
    const next = updater(tab);
    changed ||= next !== tab;
    return next;
  });
  if (!changed) return state;
  return {
    worktreeChats: { ...state.worktreeChats, [key]: { ...scope, tabs } },
  };
}

export const createMessagingSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatMessagingSlice
> = (set, get) => ({
  sendMessage: async (
    text,
    fileReferences,
    target,
    inputMode,
    options,
  ): Promise<void> => {
    // Accepted agent input is exactly the payload main retained; it must not
    // take or clear the user's staged composer attachments (first send or a
    // queued drain alike).
    if (options?.acceptedInputId && !options.composerAttachmentsReserved) {
      options = { ...options, composerAttachmentsReserved: true };
    }
    const sel = target
      ? { projectId: target.projectId, worktreeId: target.worktreeId }
      : get().selectedWorktree;
    if (!sel) {
      options?.onPreDispatchRejected?.();
      return;
    }
    if (refuseRetiredPlanChatSend(sel.projectId, options)) return;

    // While a revisioned scope recovers from a delta gap (refreshing) or
    // shows the refresh-error treatment, send is disabled: the composer keeps
    // its text/attachments and nothing is submitted.
    if (isChatScopeCommandBlocked(get(), sel.projectId, sel.worktreeId)) {
      const refreshed = await waitForChatScopeLive(
        sel.projectId,
        sel.worktreeId,
      );
      if (!refreshed) {
        options?.onPreDispatchRejected?.();
        return;
      }
    }

    const eagerKey = worktreeKey(sel);
    const eagerScope = get().worktreeChats[eagerKey];
    let eagerTab = eagerScope?.tabs.find(
      (entry) => entry.id === (target?.chatId ?? eagerScope.activeTabId),
    );
    const replacement = options?.replaceFailedFirstSend;
    if (replacement && eagerTab?.provisionalFirstSend?.phase === 'failed') {
      const replacementChatId = eagerTab.id;
      set((state) =>
        updateChatTab(state, eagerKey, replacementChatId, (tab) =>
          withdrawProvisionalFirstSendFromTab(
            tab,
            replacement.userMessageId,
            replacement.failureId,
          ),
        ),
      );
      eagerTab = get().worktreeChats[eagerKey]?.tabs.find(
        (entry) => entry.id === replacementChatId,
      );
    }
    // Keep distinct follow-ups in their composer until the first send is
    // acknowledged, even when its short presentation lease has expired.
    if (
      isProvisionalFirstSendAdmissionPending(eagerTab) &&
      eagerTab?.provisionalFirstSend?.userMessageId !== options?.userMessageId
    ) {
      options?.onPreDispatchRejected?.();
      return;
    }
    if (
      adoptableProvisionalFirstSend(eagerTab, options?.userMessageId)?.phase ===
      'dispatched'
    ) {
      return;
    }
    // CAN-3637: keep drafting available, but never dispatch an untouched
    // Advisor seed against provisional account/auth/catalog facts. Synchronize
    // the actual tab before capturing the turn, so picker and request agree.
    // Explicit settings/picker choices and populated chats retain their paths.
    if (
      sel.projectId === APP_ADVISOR_PROJECT_ID &&
      eagerTab &&
      eagerTab.status === 'idle' &&
      eagerTab.queuedMessages.length === 0 &&
      !chatTabHasConversationContent(eagerTab) &&
      eagerTab.modelExplicitlyChosen !== true &&
      eagerTab.billingExplicitlyChosen !== true &&
      eagerTab.interfaceMode !== 'claude-code' &&
      (eagerTab.model === undefined ||
        eagerTab.model === eagerTab.defaultStampModel)
    ) {
      const defaults = await get().ensureModelDefaultsLoaded();
      if (
        (defaults?.appAdvisorModel ?? DEFAULT_APP_ADVISOR_MODEL) ===
        DEFAULT_APP_ADVISOR_MODEL
      ) {
        const lane = resolveLaneForTarget(sel.projectId, defaults);
        if (
          lane?.outcome !== 'resolved' ||
          lane.provisional ||
          (lane.lane === 'ai-credits' && !isRendererGuestPrincipalHydrated())
        ) {
          options?.onPreDispatchRejected?.();
          return;
        }
        await get().syncActiveEmptyTabToDefaults();
        const currentTab = get().worktreeChats[eagerKey]?.tabs.find(
          (entry) => entry.id === eagerTab.id,
        );
        if (
          currentTab?.model === undefined ||
          currentTab.model !== resolveTabDefaults(sel.projectId, defaults).model
        ) {
          options?.onPreDispatchRejected?.();
          return;
        }
      }
    }

    if (eagerTab?.pendingInitialCreation) {
      const userMessageId = options?.userMessageId ?? nextMsgId();
      options = { ...options, userMessageId };
      // A Home first send already presents this message (CAN-4742); a second
      // eager echo would render it twice.
      const alreadyPresented =
        adoptableProvisionalFirstSend(eagerTab, userMessageId) !== undefined;
      const pendingMessage: ChatMessage = {
        id: userMessageId,
        role: 'user',
        timestamp: Date.now(),
        blocks: [
          ...(fileReferences?.length
            ? [{ type: 'file_references', references: fileReferences } as const]
            : []),
          { type: 'text', text },
        ],
        ...(options.attachmentPaths
          ? { attachmentPaths: options.attachmentPaths }
          : {}),
      };
      set((state) => {
        const scope = state.worktreeChats[eagerKey];
        if (!scope || alreadyPresented) return state;
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [eagerKey]: {
              ...scope,
              tabs: scope.tabs.map((entry) =>
                entry.id === eagerTab.id
                  ? {
                      ...entry,
                      messages: [...entry.messages, pendingMessage],
                      // A concurrent earlier eager send may already own the
                      // tab's turn bridge. Installing a second one would
                      // strand the first send's timer, so only bridge a turn
                      // when none is in flight.
                      pendingTurn: entry.pendingTurn ?? {
                        userMessageId,
                        timerMessage: {
                          id: nextMsgId(),
                          role: 'system',
                          timestamp: pendingMessage.timestamp,
                          blocks: [
                            {
                              type: 'turn_timer',
                              startedAt: pendingMessage.timestamp,
                              completedAt: null,
                            },
                          ],
                        },
                      },
                      pendingUserMessages: [
                        ...(entry.pendingUserMessages ?? []),
                        pendingMessage,
                      ],
                    }
                  : entry,
              ),
            },
          },
        };
      });
      // The host-queue acceptance fires from an un-awaited promise, so it can
      // land after the cleanup below has already read `dispatched`. Withdrawal
      // must target this provisional object, not its id: a native send replaces
      // it with a saved user message that deliberately reuses the same id.
      const withdrawProvisionalEcho = (): void => {
        set((state) => {
          const scope = state.worktreeChats[eagerKey];
          if (!scope) return state;
          let changed = false;
          const tabs = scope.tabs.map((entry) => {
            if (entry.id !== eagerTab.id) return entry;
            const messages = entry.messages.filter(
              (message) => message !== pendingMessage,
            );
            const ownsProvisionalTurn =
              entry.pendingUserMessages?.includes(pendingMessage) === true;
            const remainingPending = (entry.pendingUserMessages ?? []).filter(
              (message) => message !== pendingMessage,
            );
            const pendingTurn =
              ownsProvisionalTurn &&
              entry.pendingTurn?.userMessageId === userMessageId
                ? undefined
                : entry.pendingTurn;
            if (
              messages.length === entry.messages.length &&
              remainingPending.length ===
                (entry.pendingUserMessages ?? []).length &&
              pendingTurn === entry.pendingTurn
            ) {
              return entry;
            }
            changed = true;
            return {
              ...entry,
              messages,
              pendingTurn,
              pendingUserMessages: remainingPending.length
                ? remainingPending
                : undefined,
            };
          });
          if (!changed) return state;
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [eagerKey]: { ...scope, tabs },
            },
          };
        });
      };
      let dispatched = false;
      try {
        const ready = await pendingEagerChatCreation({
          ...sel,
          chatId: eagerTab.id,
        });
        if (!ready) {
          options?.onPreDispatchRejected?.();
          return;
        }
        dispatched = true;
        const originalOptions = options;
        await get().sendMessage(
          text,
          fileReferences,
          { ...sel, chatId: eagerTab.id },
          inputMode,
          {
            ...originalOptions,
            onPreDispatchRejected: () => {
              dispatched = false;
              originalOptions.onPreDispatchRejected?.();
            },
            // Parked in a queue (this renderer's or main's) rather than sent.
            // The queued row now represents the message, so the provisional
            // echo must go: keeping both renders the prompt twice, and the
            // queued copy carries no `userMessageId` for the later flush to
            // reconcile against.
            onQueuedWithoutDispatch: (queue) => {
              dispatched = false;
              withdrawProvisionalEcho();
              originalOptions.onQueuedWithoutDispatch?.(queue);
            },
            // A host-queue send that never reached main has no queued row and
            // no transcript entry, so the provisional echo would otherwise sit
            // there claiming a message the user never sent.
            onDispatchRejected: () => {
              dispatched = false;
              withdrawProvisionalEcho();
              originalOptions.onDispatchRejected?.();
            },
          },
        );
      } finally {
        set((state) => {
          const scope = state.worktreeChats[eagerKey];
          if (!scope) return state;
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [eagerKey]: {
                ...scope,
                tabs: scope.tabs.map((entry) =>
                  entry.id === eagerTab.id &&
                  entry.pendingUserMessages?.includes(pendingMessage)
                    ? {
                        ...entry,
                        messages: dispatched
                          ? entry.messages
                          : entry.messages.filter(
                              (message) => message !== pendingMessage,
                            ),
                        // Native send replaces the provisional echo and owns its
                        // timer. Other routes (including terminal handoff) do not.
                        // Only retire the bridge this send installed: a
                        // concurrent earlier eager send may already own the
                        // tab's live turn.
                        pendingTurn:
                          entry.pendingTurn?.userMessageId === userMessageId
                            ? undefined
                            : entry.pendingTurn,
                        pendingUserMessages: entry.pendingUserMessages.filter(
                          (message) => message !== pendingMessage,
                        ),
                      }
                    : entry,
                ),
              },
            },
          };
        });
      }
      return;
    }

    const presentedSubmission = adoptableProvisionalFirstSend(
      get().worktreeChats[eagerKey]?.tabs.find(
        (entry) => entry.id === eagerTab?.id,
      ),
      options?.userMessageId,
    );
    if (presentedSubmission?.dispatchClaimed) return;
    if (presentedSubmission?.phase === 'preparing' && eagerTab) {
      set((state) =>
        updateChatTab(state, eagerKey, eagerTab.id, (entry) =>
          entry.provisionalFirstSend &&
          entry.provisionalFirstSend.userMessageId === options?.userMessageId
            ? {
                ...entry,
                provisionalFirstSend: {
                  ...entry.provisionalFirstSend,
                  dispatchClaimed: true,
                },
              }
            : entry,
        ),
      );
    }

    // Every App Advisor entry send runs in App Advisor assistant mode,
    // regardless of which surface issued it (the popout's standard chat
    // panels call this without options). Derive it here so the generic send
    // path cannot silently drop the mode for entry-keyed targets.
    if (
      sel.projectId === APP_ADVISOR_PROJECT_ID &&
      options?.assistantMode === undefined
    ) {
      options = { ...(options ?? {}), assistantMode: 'app-advisor' };
    }

    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    if (!wc) {
      options?.onPreDispatchRejected?.();
      return;
    }
    recordWorktreeChatTouch(key);

    const resolution = resolveSendMessageTargetTab(
      wc,
      target ? { chatId: target.chatId } : undefined,
    );
    if (resolution.kind === 'abort') {
      options?.onPreDispatchRejected?.();
      return;
    }

    let chatId: string;
    let tab: ChatTab;
    if (resolution.kind === 'existing') {
      chatId = resolution.chatId;
      tab = resolution.tab;
      if (resolution.shouldSwitchTab) {
        get().switchTab(resolution.chatId, sel);
      }
    } else {
      const rawPluginDefaults = getDefaultPlugins(
        sel.projectId,
        sel.worktreeId,
        get().worktreeDefaultPlugins,
      );
      const {
        model: defaultModel,
        providerType: defaultProviderType,
        thinkingLevel: defaultThinking,
        modelConfig: defaultModelConfig,
      } = resolveTabDefaults(sel.projectId, get().modelDefaults);
      // Cached-support sanitize only: sending a message must never block on
      // the marketplace-backed support index load (it can stall when a
      // provider backend such as the Codex app-server is unhealthy).
      const pluginDefaults = sanitizePluginSelectionsWithCachedSupport(
        rawPluginDefaults,
        defaultModel ? getProviderForModel(defaultModel) : undefined,
      );
      const createdTab = createEmptyTab({
        pluginSelections: pluginDefaults,
        model: defaultModel,
        // A SEED path: this tab is being created with the resolved default now,
        // so it stays ours to re-stamp.
        defaultStampModel: defaultModel,
        thinkingLevel: defaultThinking,
        defaultChatInterfaceMode: resolveDefaultChatInterfaceMode(
          sel.projectId,
          get().modelDefaults,
        ),
        modelConfig: defaultModelConfig,
        providerTypeHint: defaultProviderType,
        fastModeExplicit: typeof defaultModelConfig?.fastMode === 'boolean',
        deferredToolsAllowed: resolveDeferredToolsAllowedDefault(
          sel.projectId,
          sel.worktreeId,
          get().deferredToolsDefaults,
        ),
        // Seed the remembered billing framework so a chat created via the
        // implicit send-with-no-writable-tab path matches every other
        // new-chat entry point (CAN-838), instead of silently re-defaulting
        // to the global aiCreditsRoutingMode safety net.
        billingSeed: resolveBillingSeed(get().modelDefaults, sel.projectId),
        ...newChatPluginDefaultsStamp(sel.projectId),
      });

      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;
        const updated: WorktreeChatState = {
          tabs: [...currentWc.tabs, createdTab],
          activeTabId: createdTab.id,
        };
        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
        };
      });
      requestTabDiscovery({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId: createdTab.id,
        pluginSelections: createdTab.pluginSelections,
        providerType: resolveDiscoveryProviderType(createdTab),
      });
      await applyResolvedApprovalModeForNewTab(sel, createdTab.id, set, get);

      chatId = createdTab.id;
      tab =
        get().worktreeChats[key]?.tabs.find(
          (candidate) => candidate.id === createdTab.id,
        ) ?? createdTab;
    }

    // A mode downgrade on a newly materializing tab may itself be queued
    // behind canonical creation. Do not let any send path observe the old,
    // more permissive mode while that transition is still in flight.
    const initialApprovalModeTransitions =
      waitForPendingApprovalModeTransitions(
        sel.projectId,
        sel.worktreeId,
        chatId,
      );
    try {
      // The helper follows superseding transitions too, so a second picker
      // change cannot overtake the transition this send first observed.
      if (initialApprovalModeTransitions) {
        await initialApprovalModeTransitions;
      }
    } catch {
      // The requested mode did not land. Keep the message with the caller
      // instead of dispatching it under the stale, potentially more
      // permissive mode that remains on the tab.
      options?.onPreDispatchRejected?.();
      return;
    }
    tab =
      get().worktreeChats[key]?.tabs.find(
        (candidate) => candidate.id === chatId,
      ) ?? tab;

    if (tab.readOnly) {
      options?.onPreDispatchRejected?.();
      return;
    }

    const isWatcherSend =
      options?.watcherDeliveryId !== undefined ||
      options?.watcherFired !== undefined;
    if (isWatcherSend && !isClaudeTerminalBackedChatTab(tab)) {
      // Main delivers watcher messages for every other chat.
      options?.onPreDispatchRejected?.();
      if (options?.throwOnDispatchFailure === true) {
        throw new Error(WATCHER_TERMINAL_ONLY_MESSAGE);
      }
      return;
    }

    // An early echo belongs to presentation, not conversation history used
    // for first-send routing, terminal handoff, or new-chat notifications.
    const pendingOwnId = options?.userMessageId;
    if (
      pendingOwnId &&
      tab.pendingUserMessages?.some((message) => message.id === pendingOwnId)
    ) {
      tab = {
        ...tab,
        messages: tab.messages.filter((message) => message.id !== pendingOwnId),
      };
    }

    const watcherDeliveryId = options?.watcherDeliveryId;
    const watcherUserMessageId = watcherDeliveryId
      ? `watcher-${watcherDeliveryId}`
      : undefined;
    // Admission is durable even before pickup creates a transcript message.
    // Replayed notifications must not revive cancelled/unknown inputs or add
    // an optimistic root message and timer after a renderer reload.
    if (
      watcherUserMessageId &&
      tab.inputDelivery?.rows.some((row) => row.id === watcherUserMessageId)
    ) {
      options?.onDispatchAccepted?.();
      return;
    }

    // Capture the execution harness at the first user-visible message or
    // accepted queue entry. A preallocated provider session alone remains
    // unpinned, while legacy chats with content keep their inferred harness.
    const executionHarnessForMessage =
      getLockedHarness(tab) ??
      (tab.executionHarnessExplicitlyChosen === true
        ? tab.executionHarness
        : undefined) ??
      (tab.model ? getExecutionHarnessForModel(tab.model) : undefined) ??
      (resolveTabProviderType(tab) === 'codex' ? 'codex' : 'claude');

    const ollamaBannerTarget: ChatBannerTarget = {
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      chatId,
    };
    // A retry should immediately remove the previous warning. If Ollama is
    // still unreachable, the typed failure from this attempt restores it.
    useOllamaConnectionBannerStore
      .getState()
      .clearUnavailable(ollamaBannerTarget);

    // Capture pending attachments before the queue/send split so they are
    // included in whichever path executes. Renderer-local paths clear the
    // pending list in the same set() call that commits the message or queued
    // entry; the host-queue path clears it once main accepts the IPC request.
    // The "Revert" action also stages a synthetic markdown attachment via
    // `pendingRevertAttachmentPath`; prepend it so the model sees the revert
    // summary alongside any user-attached files.
    const pendingAttachments = options?.composerAttachmentsReserved
      ? []
      : (tab?.pendingAttachments ?? []);
    const userAttachmentPaths =
      pendingAttachments.length > 0
        ? pendingAttachments.map((a) => a.absolutePath)
        : [];
    const revertAttachmentPath = options?.composerAttachmentsReserved
      ? options.reservedRevertAttachmentPath
      : tab?.pendingRevertAttachmentPath;
    const combinedAttachmentPaths = revertAttachmentPath
      ? [revertAttachmentPath, ...userAttachmentPaths]
      : userAttachmentPaths;
    const combinedAttachmentPromptContexts = [
      ...(buildAttachmentPromptContexts(pendingAttachments) ?? []),
    ];
    if (options?.attachmentPaths?.length) {
      combinedAttachmentPaths.push(...options.attachmentPaths);
    }
    if (options?.attachmentPromptContexts?.length) {
      combinedAttachmentPromptContexts.push(
        ...options.attachmentPromptContexts,
      );
    }
    const uniqueCombinedAttachmentPaths = uniqueAttachmentPaths(
      combinedAttachmentPaths,
    );
    const attachmentPaths =
      uniqueCombinedAttachmentPaths.length > 0
        ? uniqueCombinedAttachmentPaths
        : undefined;
    const attachmentPromptContexts = attachmentPromptContextsForPaths(
      combinedAttachmentPromptContexts,
      attachmentPaths,
    );
    const queuedDispatchOptions = toQueuedDispatchOptions(options);
    // Renderer-local queue entries own the serialized message as soon as the
    // reducer commits them. Invoke the acceptance callback at that boundary
    // and omit it from the queued copy so a later flush cannot invoke it a
    // second time.
    const acceptedQueuedDispatchOptions = presentedSubmission
      ? {
          ...toQueuedDispatchOptions(options, false),
          userMessageId: presentedSubmission.userMessageId,
          submittedAt: presentedSubmission.submittedAt,
        }
      : toQueuedDispatchOptions(options, false);

    // The hook tab is currently a queued placeholder waiting for the real
    // session to start. There is no chat session to send to yet, so locally
    // queue the user's input alongside the original hook bubble. When the
    // start event arrives, `handleHookTabStarted` preserves these entries and
    // the terminal-event flush in `handleChatEvent` dispatches them after the
    // first turn finishes. Skip IPC, transcript writes, title generation, and
    // the save schedule — `toPersistedTabs` already filters placeholder tabs.
    if (tab.queuedHookPlaceholder === true) {
      if (options?.terminalPlanImplementation) {
        options.onPreDispatchRejected?.();
        return;
      }
      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;
        const updatedTabs = currentWc.tabs.map((t) =>
          t.id === chatId &&
          !hasQueuedAcceptedInput(t, options?.acceptedInputId)
            ? appendQueuedMessageToTab(
                t,
                {
                  text,
                  fileReferences,
                  attachmentPaths,
                  ...(attachmentPromptContexts
                    ? { attachmentPromptContexts }
                    : {}),
                  ...(options?.agentSent
                    ? { agentSent: options.agentSent }
                    : {}),
                  ...(acceptedQueuedDispatchOptions
                    ? { dispatchOptions: acceptedQueuedDispatchOptions }
                    : {}),
                },
                executionHarnessForMessage,
                options?.composerAttachmentsReserved === true,
              )
            : t,
        );
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs: updatedTabs },
          },
        };
      });
      options?.onDispatchAccepted?.();
      options?.onQueuedWithoutDispatch?.('renderer');
      return;
    }

    const effectiveInterfaceMode = getEffectiveClaudeChatInterfaceMode(
      tab.interfaceMode,
    );
    if (isTerminalBackedInterfaceMode(effectiveInterfaceMode)) {
      // Keep Home's echo and title ownership while terminal preparation waits.
      // A queue row or the terminal transcript takes over atomically below.
      const terminalSubmittedAt =
        presentedSubmission?.submittedAt ?? options?.submittedAt ?? Date.now();
      const isAutoInterfaceMode = effectiveInterfaceMode === 'auto';
      const shouldScheduleAutoBranchNaming =
        isAutoInterfaceMode && !chatTabHasConversationContent(tab);
      // Only a send that captured an active plan waits here; every other
      // terminal send composes its prompt without yielding, as before.
      const activePlan = options?.activePlan;
      const activePlanInstruction = activePlan
        ? await prepareTerminalActivePlanInstruction(sel, activePlan)
        : undefined;
      const unmarkedTerminalPromptText = buildClaudeTerminalPromptText(
        text,
        fileReferences,
        attachmentPaths,
        attachmentPromptContexts,
        options?.hiddenContext,
        terminalPromptSystemInstructions(
          tab.pendingSystemInstructions,
          activePlan,
          activePlanInstruction,
        ),
      );
      const terminalPresentationSource =
        options?.initiationSource ??
        (options?.automationName !== undefined ||
        options?.watcherFired !== undefined
          ? 'automation'
          : undefined);
      const terminalPromptText =
        terminalPresentationSource === 'automation' ||
        terminalPresentationSource === 'hook'
          ? terminalPresentationPrompt(
              unmarkedTerminalPromptText,
              options?.userMessageId ?? nextMsgId(),
            )
          : unmarkedTerminalPromptText;
      const watcherTerminalMessageIds = watcherDeliveryId
        ? {
            userMessageId: `watcher-${watcherDeliveryId}`,
            turnTimerMessageId: `watcher-${watcherDeliveryId}-timer`,
          }
        : options?.userMessageId
          ? {
              userMessageId: options.userMessageId,
              turnTimerMessageId: `${options.userMessageId}:turn-timer`,
            }
          : undefined;
      const watcherTerminalWriteKey = watcherDeliveryId
        ? `watcher-${watcherDeliveryId}`
        : undefined;
      const terminalWriteIdempotencyKey =
        options?.acceptedInputId ??
        watcherTerminalWriteKey ??
        (terminalPresentationSource === 'automation'
          ? options?.userMessageId
          : undefined);
      const terminalWriteOptions =
        options?.acceptedInputId !== undefined
          ? { acceptedInputId: options.acceptedInputId }
          : terminalWriteIdempotencyKey
            ? { idempotencyKey: terminalWriteIdempotencyKey }
            : undefined;
      // Mirror the Canopy-native send path's first-message title/status so
      // terminal-backed chats show the same tab/worktree activity indicators
      // while Claude Code hooks catch up to the submitted prompt. Terminal
      // turns are not canonical, so the terminal projection, not a canonical
      // sending lease, owns this status.
      const applyTerminalSendUiState = (): void => {
        tagStatusWrite(chatId, 'terminal-send');
        set((state) => {
          const currentWc = state.worktreeChats[key];
          if (!currentWc) return state;
          let changed = false;
          const tabs = currentWc.tabs.map((entry) => {
            if (entry.id !== chatId) {
              return entry;
            }
            const nextEntry = { ...entry };
            if (
              entry.provisionalFirstSend?.userMessageId ===
                options?.userMessageId &&
              entry.provisionalFirstSend?.phase === 'preparing'
            ) {
              nextEntry.provisionalFirstSend = {
                ...entry.provisionalFirstSend,
                phase: 'dispatched',
              };
              changed = true;
            }
            if (entry.status !== 'streaming') {
              nextEntry.status = 'streaming';
              changed = true;
            }
            if (entry.executionHarness === undefined) {
              nextEntry.executionHarness = executionHarnessForMessage;
              changed = true;
            }
            const titlePatch =
              entry.messages.length === 0
                ? firstMessageTitlePatch(entry, text)
                : null;
            if (titlePatch) {
              Object.assign(nextEntry, titlePatch);
              changed = true;
            }
            return nextEntry;
          });
          if (!changed) return state;
          const updated: WorktreeChatState = { ...currentWc, tabs };
          return {
            worktreeChats: { ...state.worktreeChats, [key]: updated },
          };
        });
      };
      const markAutoSurfacePending = (): void => {
        if (!isAutoInterfaceMode) return;
        useClaudeTerminalStore
          .getState()
          .markAutoSendPending(sel.projectId, sel.worktreeId, chatId);
      };
      const scheduleAutoBranchNaming = (): void => {
        if (!shouldScheduleAutoBranchNaming) return;
        scheduleTaskBranchNamingFromInitialInput(
          sel.projectId,
          sel.worktreeId,
          chatId,
          text,
          tab.selectedRepoId,
        );
      };
      const storedClaudeTerminalState = useClaudeTerminalStore
        .getState()
        .getStateForChat(sel.projectId, sel.worktreeId, chatId);
      const persistedClaudeTerminalState = tab.claudeTerminal
        ? {
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            chatId,
            ...tab.claudeTerminal,
            launchStatus: 'ready' as const,
          }
        : undefined;
      const candidateClaudeTerminalState =
        storedClaudeTerminalState ?? persistedClaudeTerminalState;
      if (candidateClaudeTerminalState?.terminalId) {
        try {
          // The main process is authoritative: an undefined response means
          // the managed terminal process is gone (e.g. app restart or idle
          // reaping), no matter what the renderer or persisted snapshots
          // remember. `ptyManager.write` silently drops input for dead
          // terminals, so falling through to the launch path — where the
          // prompt rides along as the CLI's initial argument — is the only
          // way the text actually reaches Claude.
          const terminalState = await window.api.claudeTerminal.getState(
            sel.projectId,
            sel.worktreeId,
            chatId,
          );
          const terminalApprovalModeTransitions =
            waitForPendingApprovalModeTransitions(
              sel.projectId,
              sel.worktreeId,
              chatId,
            );
          if (terminalApprovalModeTransitions) {
            try {
              await terminalApprovalModeTransitions;
            } catch {
              options?.onPreDispatchRejected?.();
              return;
            }
          }
          if (
            canSendToClaudeTerminalState(terminalState) &&
            (options?.initiationSource === 'automation' ||
              options?.acceptedInputId !== undefined) &&
            terminalState.turnState === 'running'
          ) {
            if (options?.terminalPlanImplementation) {
              options.onPreDispatchRejected?.();
              return;
            }
            // Scheduled prompts never interrupt or ride along with a running
            // turn — queue Canopy-side; the turn-completion flush drains the
            // queue once the terminal returns to idle.
            set((state) => {
              const currentWc = state.worktreeChats[key];
              if (!currentWc) return state;
              const updatedTabs = currentWc.tabs.map((t) =>
                t.id === chatId &&
                !hasQueuedAcceptedInput(t, options?.acceptedInputId)
                  ? handOffProvisionalFirstSendToQueue(
                      appendQueuedMessageToTab(
                        t,
                        {
                          text,
                          fileReferences,
                          attachmentPaths,
                          ...(attachmentPromptContexts
                            ? { attachmentPromptContexts }
                            : {}),
                          ...(options?.agentSent
                            ? { agentSent: options.agentSent }
                            : {}),
                          ...(inputMode ? { inputMode } : {}),
                          ...(acceptedQueuedDispatchOptions
                            ? { dispatchOptions: acceptedQueuedDispatchOptions }
                            : {}),
                        },
                        executionHarnessForMessage,
                        options?.composerAttachmentsReserved === true,
                      ),
                      options?.userMessageId,
                    )
                  : t,
              );
              return {
                worktreeChats: {
                  ...state.worktreeChats,
                  [key]: { ...currentWc, tabs: updatedTabs },
                },
              };
            });
            options?.onDispatchAccepted?.();
            options?.onQueuedWithoutDispatch?.('renderer');
            return;
          }
          if (canSendToClaudeTerminalState(terminalState)) {
            // Clear any in-progress TUI composer/overlay state before
            // pasting so the prompt lands in an empty input box, then write
            // the paste and the submitting Enter as separate delayed chunks.
            const clearDispositions = await writeClaudeTerminalClearSequence(
              terminalState.terminalId,
              terminalWriteOptions,
            );
            const postClearApprovalModeTransitions =
              waitForPendingApprovalModeTransitions(
                sel.projectId,
                sel.worktreeId,
                chatId,
              );
            if (postClearApprovalModeTransitions) {
              try {
                await postClearApprovalModeTransitions;
              } catch {
                options?.onPreDispatchRejected?.();
                return;
              }
            }
            if (presentedSubmission) {
              set((state) =>
                updateChatTab(state, key, chatId, (entry) => {
                  if (
                    entry.provisionalFirstSend?.userMessageId !==
                    presentedSubmission.userMessageId
                  )
                    return entry;
                  const replaceEcho = (message: ChatMessage): ChatMessage =>
                    message.id === presentedSubmission.userMessageId
                      ? {
                          ...message,
                          blocks: [
                            ...(fileReferences?.length
                              ? [
                                  {
                                    type: 'file_references' as const,
                                    references: fileReferences,
                                  },
                                ]
                              : []),
                            { type: 'text', text },
                          ],
                          attachmentPaths,
                        }
                      : message;
                  return {
                    ...entry,
                    messages: entry.messages.map(replaceEcho),
                    pendingUserMessages:
                      entry.pendingUserMessages?.map(replaceEcho),
                    provisionalFirstSend: {
                      ...entry.provisionalFirstSend,
                      terminalPromptText,
                    },
                  };
                }),
              );
            }
            const promptDispositions = await writeClaudeTerminalPrompt(
              terminalState.terminalId,
              terminalPromptText,
              {
                hasAttachments: (attachmentPaths?.length ?? 0) > 0,
                ...terminalWriteOptions,
              },
            );
            const terminalPromptAlreadyWritten =
              terminalWriteIdempotencyKey &&
              [...clearDispositions, ...promptDispositions].every(
                (disposition) => disposition === 'already_written',
              );
            clearUsageLimitBannerForDispatchedUserMessage(
              sel.projectId,
              sel.worktreeId,
              chatId,
              set,
            );
            const watcherFired = options?.watcherFired;
            if (watcherFired) {
              set((state) => {
                const wc2 = state.worktreeChats[key];
                if (!wc2) return state;
                const tabs = wc2.tabs.map((entry) =>
                  entry.id === chatId
                    ? {
                        ...entry,
                        pendingClaudeTerminalWatcherMessages:
                          watcherDeliveryId &&
                          entry.pendingClaudeTerminalWatcherMessages?.some(
                            (pending) =>
                              pending.deliveryId === watcherDeliveryId,
                          )
                            ? entry.pendingClaudeTerminalWatcherMessages
                            : [
                                ...(
                                  entry.pendingClaudeTerminalWatcherMessages ??
                                  []
                                ).slice(
                                  -(
                                    MAX_PENDING_CLAUDE_TERMINAL_WATCHER_MESSAGES -
                                    1
                                  ),
                                ),
                                {
                                  text,
                                  submittedText: terminalPromptText,
                                  ...(watcherDeliveryId
                                    ? { deliveryId: watcherDeliveryId }
                                    : {}),
                                  watcherFired,
                                },
                              ],
                      }
                    : entry,
                );
                const updated: WorktreeChatState = { ...wc2, tabs };
                return {
                  worktreeChats: {
                    ...state.worktreeChats,
                    [key]: updated,
                  },
                };
              });
            }
            // The pasted prompt consumed staged attachments and pending
            // provider-only system instructions.
            set((state) => {
              const wc2 = state.worktreeChats[key];
              if (!wc2) return state;
              let cleared = false;
              const tabs = wc2.tabs.map((t) => {
                if (
                  t.id !== chatId ||
                  ((t.pendingAttachments?.length ?? 0) === 0 &&
                    t.pendingRevertAttachmentPath === undefined &&
                    (t.pendingSystemInstructions?.length ?? 0) === 0)
                ) {
                  return t;
                }
                cleared = true;
                const next = {
                  ...t,
                  pendingAttachments: options?.composerAttachmentsReserved
                    ? t.pendingAttachments
                    : undefined,
                  pendingRevertAttachmentPath:
                    options?.composerAttachmentsReserved
                      ? t.pendingRevertAttachmentPath
                      : undefined,
                };
                delete next.pendingSystemInstructions;
                return next;
              });
              if (!cleared) return state;
              const updated: WorktreeChatState = { ...wc2, tabs };
              return {
                worktreeChats: {
                  ...state.worktreeChats,
                  [key]: updated,
                },
              };
            });
            if (terminalPromptAlreadyWritten) {
              // A fresh terminal launch can consume the prompt before its
              // canonical commit succeeds. PTY idempotency then reports the
              // retry as already written, so finish the outstanding commit
              // while its queued copy still proves this was an initial
              // prompt rather than a normal live-terminal replay.
              const queuedMessage = get().worktreeChats[key]?.tabs.find(
                (entry) => entry.id === chatId,
              )?.queuedMessages[0];
              if (
                watcherTerminalMessageIds &&
                queuedMessage?.text === text &&
                isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)
              ) {
                const disposition = await get().dispatchChatCommand(
                  sel,
                  {
                    type: 'chat.commit_terminal_initial_prompt',
                    chatId,
                    ...watcherTerminalMessageIds,
                    text: queuedMessage.text,
                    ...(queuedMessage.inputMode
                      ? { inputMode: queuedMessage.inputMode }
                      : {}),
                    ...(queuedMessage.fileReferences
                      ? { fileReferences: queuedMessage.fileReferences }
                      : {}),
                    ...(queuedMessage.attachmentPaths
                      ? { attachmentPaths: queuedMessage.attachmentPaths }
                      : {}),
                    ...(queuedMessage.attachmentPromptContexts
                      ? {
                          attachmentPromptContexts:
                            queuedMessage.attachmentPromptContexts,
                        }
                      : {}),
                    ...(tab.pendingSystemInstructions?.length
                      ? {
                          pendingSystemInstructionIds:
                            tab.pendingSystemInstructions.map(
                              (instruction) => instruction.id,
                            ),
                        }
                      : {}),
                    ...(options?.watcherFired
                      ? { watcherFired: options.watcherFired }
                      : {}),
                  },
                  watcherDeliveryId
                    ? {
                        commandId: `watcher-${watcherDeliveryId}-terminal-prompt`,
                      }
                    : undefined,
                );
                if (disposition !== 'accepted') {
                  throw new Error(
                    'Failed to persist consumed terminal initial prompt',
                  );
                }
                const submittedAt = terminalSubmittedAt;
                set((state) => {
                  const wc2 = state.worktreeChats[key];
                  if (!wc2) return state;
                  let changed = false;
                  const tabs = wc2.tabs.map((entry) => {
                    if (entry.id !== chatId) return entry;
                    const pendingQueuedMessage = entry.queuedMessages[0];
                    if (
                      !pendingQueuedMessage ||
                      pendingQueuedMessage.text !== text
                    ) {
                      return entry;
                    }
                    changed = true;
                    const consumed = appendConsumedClaudeTerminalInitialPrompt(
                      entry,
                      pendingQueuedMessage,
                      submittedAt,
                      watcherTerminalMessageIds,
                    );
                    return {
                      ...consumed,
                      ...(entry.provisionalFirstSend
                        ? {
                            provisionalFirstSend: {
                              ...entry.provisionalFirstSend,
                              phase: 'dispatched' as const,
                            },
                          }
                        : {}),
                    };
                  });
                  if (!changed) return state;
                  const updated: WorktreeChatState = { ...wc2, tabs };
                  return {
                    worktreeChats: {
                      ...state.worktreeChats,
                      [key]: updated,
                    },
                  };
                });
              }
              options?.onDispatchAccepted?.();
              return;
            }
            markAutoSurfacePending();
            applyTerminalSendUiState();
            scheduleAutoBranchNaming();
            options?.onDispatchAccepted?.();
            return;
          }
        } catch (err) {
          const current = get().worktreeChats[key]?.tabs.find(
            (entry) => entry.id === chatId,
          );
          const terminalFirstSend = current?.provisionalFirstSend;
          if (
            presentedSubmission &&
            terminalFirstSend?.userMessageId ===
              presentedSubmission.userMessageId &&
            terminalFirstSend.terminalUserMessageId &&
            current?.messages.some(
              (message) =>
                message.id === terminalFirstSend.terminalUserMessageId,
            )
          ) {
            options?.onDispatchAccepted?.();
            return;
          }
          const errorMessage = extractIpcErrorMessage(err);
          const failedAt = Date.now();
          const acceptedInputId = options?.acceptedInputId;
          const rejectedAcceptedAgentInput =
            acceptedInputId !== undefined &&
            errorMessage === ACCEPTED_AGENT_SENDER_UNREACHABLE_MESSAGE;
          set((state) => {
            const wc2 = state.worktreeChats[key];
            if (!wc2) return state;
            const tabs = wc2.tabs.map((t) =>
              t.id === chatId
                ? {
                    ...t,
                    status: 'error' as const,
                    error: errorMessage,
                    ...(rejectedAcceptedAgentInput
                      ? {
                          queuedMessages: t.queuedMessages.filter(
                            (message) =>
                              message.dispatchOptions?.acceptedInputId !==
                              acceptedInputId,
                          ),
                        }
                      : {}),
                    messages: [
                      ...t.messages,
                      {
                        id: nextMsgId(),
                        role: 'system' as const,
                        blocks: [{ type: 'text' as const, text: errorMessage }],
                        timestamp: failedAt,
                      },
                    ],
                  }
                : t,
            );
            const updated: WorktreeChatState = { ...wc2, tabs };
            return {
              worktreeChats: { ...state.worktreeChats, [key]: updated },
            };
          });
          options?.onDispatchRejected?.();
          if (options?.throwOnDispatchFailure === true) {
            throw err;
          }
          return;
        }
      }

      // No live terminal: queue the message, then launch one. When this is
      // the only queued message, the prompt rides along as the Claude CLI's
      // initial positional argument instead of being replayed through the
      // TUI composer; otherwise the queue drains through the normal
      // force-queued path once the terminal is ready.
      const hadOtherQueuedMessages = tab.queuedMessages.length > 0;
      if (options?.terminalPlanImplementation && hadOtherQueuedMessages) {
        // An admitted implementation cannot join an unrelated local queue.
        options.onPreDispatchRejected?.();
        return;
      }
      const launchMessage = {
        text,
        fileReferences,
        attachmentPaths,
        ...(attachmentPromptContexts ? { attachmentPromptContexts } : {}),
        ...(options?.agentSent ? { agentSent: options.agentSent } : {}),
        ...(inputMode ? { inputMode } : {}),
        ...(presentedSubmission
          ? { dispatchOptions: acceptedQueuedDispatchOptions }
          : queuedDispatchOptions
            ? { dispatchOptions: queuedDispatchOptions }
            : {}),
      };
      // Main already admitted the plan attempt. Its initial launch consumes
      // this exact prompt; no cancellable local queue copy should outlive it.
      if (!options?.terminalPlanImplementation)
        set((state) => {
          const currentWc = state.worktreeChats[key];
          if (!currentWc) return state;
          const updatedTabs = currentWc.tabs.map((t) =>
            t.id === chatId &&
            !hasQueuedAcceptedInput(t, options?.acceptedInputId)
              ? handOffProvisionalFirstSendToQueue(
                  appendQueuedMessageToTab(
                    t,
                    launchMessage,
                    executionHarnessForMessage,
                    options?.composerAttachmentsReserved === true,
                  ),
                  options?.userMessageId,
                )
              : t,
          );
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: { ...currentWc, tabs: updatedTabs },
            },
          };
        });
      markAutoSurfacePending();
      applyTerminalSendUiState();
      scheduleAutoBranchNaming();
      let launchAccepted = false;
      const terminalLaunch = get()
        .ensureClaudeTerminal(
          chatId,
          sel,
          undefined,
          hadOtherQueuedMessages ? undefined : terminalPromptText,
          terminalWriteIdempotencyKey
            ? { initialPromptIdempotencyKey: terminalWriteIdempotencyKey }
            : undefined,
        )
        .then(async (launched) => {
          launchAccepted = true;
          if (
            options?.terminalPlanImplementation &&
            launched?.lastLaunchConsumedInitialPrompt !== true
          ) {
            options.onPreDispatchRejected?.();
            return;
          }
          const refreshedTab = get().worktreeChats[key]?.tabs.find(
            (entry) => entry.id === chatId,
          );
          if (
            !hadOtherQueuedMessages &&
            launched?.lastLaunchConsumedInitialPrompt === true
          ) {
            // The CLI already received the prompt as its initial argument —
            // commit it as a local user turn before dropping the queued copy.
            // Claude's JSONL transcript can omit the initial prompt for some
            // launches, and without this durable local row the only visible
            // user bubble disappears as soon as the queued copy is cleared.
            const queuedMessage = options?.terminalPlanImplementation
              ? launchMessage
              : refreshedTab?.queuedMessages[0];
            if (queuedMessage?.text === text) {
              const submittedAt = terminalSubmittedAt;
              const messageIds = watcherTerminalMessageIds ?? {
                userMessageId: nextMsgId(),
                turnTimerMessageId: nextMsgId(),
              };
              if (isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)) {
                const disposition = await get().dispatchChatCommand(
                  sel,
                  {
                    type: 'chat.commit_terminal_initial_prompt',
                    chatId,
                    ...messageIds,
                    text: queuedMessage.text,
                    ...(queuedMessage.inputMode
                      ? { inputMode: queuedMessage.inputMode }
                      : {}),
                    ...(queuedMessage.fileReferences
                      ? { fileReferences: queuedMessage.fileReferences }
                      : {}),
                    ...(queuedMessage.attachmentPaths
                      ? { attachmentPaths: queuedMessage.attachmentPaths }
                      : {}),
                    ...(queuedMessage.attachmentPromptContexts
                      ? {
                          attachmentPromptContexts:
                            queuedMessage.attachmentPromptContexts,
                        }
                      : {}),
                    ...(tab.pendingSystemInstructions?.length
                      ? {
                          pendingSystemInstructionIds:
                            tab.pendingSystemInstructions.map(
                              (instruction) => instruction.id,
                            ),
                        }
                      : {}),
                    ...(options?.watcherFired
                      ? { watcherFired: options.watcherFired }
                      : {}),
                  },
                  watcherDeliveryId
                    ? {
                        commandId: `watcher-${watcherDeliveryId}-terminal-prompt`,
                      }
                    : undefined,
                );
                // A watcher delivery keeps its queued copy and fails, so the
                // redelivery's idempotent PTY write finishes this commit from
                // that copy. Any other send has no such retry: Claude already
                // holds the prompt, and a copy left in the queue would be
                // typed into the terminal again once this turn ends. Keep the
                // local user turn below and count the send as delivered.
                if (
                  disposition !== 'accepted' &&
                  (watcherDeliveryId || options?.acceptedInputId !== undefined)
                ) {
                  throw new Error(
                    'Failed to persist consumed terminal initial prompt',
                  );
                }
              }
              if (!options?.terminalPlanImplementation)
                set((state) => {
                  const wc2 = state.worktreeChats[key];
                  if (!wc2) return state;
                  let changed = false;
                  const tabs = wc2.tabs.map((entry) => {
                    if (entry.id !== chatId) return entry;
                    const queuedMessage = entry.queuedMessages[0];
                    if (!queuedMessage || queuedMessage.text !== text) {
                      return entry;
                    }
                    changed = true;
                    const consumed = appendConsumedClaudeTerminalInitialPrompt(
                      entry,
                      queuedMessage,
                      submittedAt,
                      messageIds,
                    );
                    return {
                      ...consumed,
                      ...(entry.provisionalFirstSend
                        ? {
                            provisionalFirstSend: {
                              ...entry.provisionalFirstSend,
                              phase: 'dispatched' as const,
                            },
                          }
                        : {}),
                    };
                  });
                  if (!changed) return state;
                  const updated: WorktreeChatState = { ...wc2, tabs };
                  return {
                    worktreeChats: { ...state.worktreeChats, [key]: updated },
                  };
                });
            }
            const consumedInstructionIds = new Set(
              tab.pendingSystemInstructions?.map(
                (instruction) => instruction.id,
              ) ?? [],
            );
            set((state) => {
              const wc2 = state.worktreeChats[key];
              if (!wc2) return state;
              let changed = false;
              const tabs = wc2.tabs.map((entry) => {
                if (
                  entry.id !== chatId ||
                  (entry.pendingSystemInstructions?.length ?? 0) === 0
                ) {
                  return entry;
                }
                const pendingSystemInstructions =
                  entry.pendingSystemInstructions?.filter(
                    (instruction) =>
                      !consumedInstructionIds.has(instruction.id),
                  ) ?? [];
                if (
                  pendingSystemInstructions.length ===
                  (entry.pendingSystemInstructions?.length ?? 0)
                ) {
                  return entry;
                }
                changed = true;
                const next = { ...entry };
                if (pendingSystemInstructions.length > 0) {
                  next.pendingSystemInstructions = pendingSystemInstructions;
                } else {
                  delete next.pendingSystemInstructions;
                }
                return next;
              });
              if (!changed) return state;
              const updated: WorktreeChatState = { ...wc2, tabs };
              return {
                worktreeChats: { ...state.worktreeChats, [key]: updated },
              };
            });
            clearUsageLimitBannerForDispatchedUserMessage(
              sel.projectId,
              sel.worktreeId,
              chatId,
              set,
            );
            options?.onDispatchAccepted?.();
            return;
          }
          // Drain immediately only when the terminal is already accepting
          // input (a pre-existing live terminal). A freshly spawned CLI is
          // not ready yet — input written now is swallowed by startup — so
          // the queue waits for the readyForInput transition observed by
          // initializeClaudeTerminalChatSync.
          const runtimeAfterLaunch = useClaudeTerminalStore
            .getState()
            .getStateForChat(sel.projectId, sel.worktreeId, chatId);
          if (
            (refreshedTab?.queuedMessages.length ?? 0) > 0 &&
            canSendToClaudeTerminalState(runtimeAfterLaunch)
          ) {
            get().forceQueuedMessage(0, {
              projectId: sel.projectId,
              worktreeId: sel.worktreeId,
              chatId,
            });
          }
        });
      const rejectTerminalLaunch = (): void => {
        if (options?.terminalPlanImplementation) {
          options.onDispatchRejected?.();
          return;
        }
        if (launchAccepted || !watcherDeliveryId) {
          // A composer send keeps its full prompt and attachments in the queue
          // for retry; so does a watcher delivery whose consumed prompt failed
          // to commit, for the commit retry. Do not create a second copy in
          // the composer.
          options?.onQueuedWithoutDispatch?.('renderer');
          return;
        }
        // A rejected watcher delivery has a durable prompt outside this queue.
        // Remove only its queued copy so the watcher can retry it.
        set((state) => {
          const currentWc = state.worktreeChats[key];
          if (!currentWc) return state;
          let changed = false;
          const tabs = currentWc.tabs.map((entry) => {
            if (entry.id !== chatId) return entry;
            const queuedMessages = entry.queuedMessages.filter(
              (message) => message !== launchMessage,
            );
            if (queuedMessages.length === entry.queuedMessages.length) {
              return entry;
            }
            changed = true;
            return { ...entry, queuedMessages };
          });
          if (!changed) return state;
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: { ...currentWc, tabs },
            },
          };
        });
        options?.onDispatchRejected?.();
      };
      if (watcherDeliveryId || options?.terminalPlanImplementation) {
        try {
          await terminalLaunch;
        } catch (error: unknown) {
          rejectTerminalLaunch();
          if (options?.throwOnDispatchFailure === true) throw error;
        }
      } else {
        void terminalLaunch.catch(() => {
          rejectTerminalLaunch();
        });
      }
      return;
    }

    const hasPendingInputDelivery =
      tab?.inputDelivery?.rows.some((row) =>
        ['sending', 'pending', 'cancelling'].includes(row.state),
      ) === true;
    // Streaming sends and sends made while steering ownership is unresolved
    // also hand off to the host queue. Plan feedback with an empty queue keeps
    // the legacy immediate path below only when no delivery row owns the input
    // window; once older rows are queued, feedback joins the queue to preserve
    // FIFO order. A send still awaiting acknowledgement (sending lease) counts
    // as a running turn, as its optimistic `streaming` status once did. So
    // does a cloud turn that may still be starting, which no runtime names
    // running yet: a send behind it waits in the web core's queue (CAN-6733).
    const cloudTurnStarting =
      isWebCoreScope(sel.projectId) &&
      useWebCoreStartingTurnStore.getState().byChat[
        liveReplyKey({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
        })
      ] === true;
    if (
      hasPendingInputDelivery ||
      ((tab.status === 'streaming' ||
        hasPendingSendingLease(tab, Date.now()) ||
        cloudTurnStarting) &&
        (!tab.pendingPlanExit || tab.queuedMessages.length > 0))
    ) {
      const userMessageId = options?.userMessageId ?? nextMsgId();
      const clearPendingQueuePresentation = (): void => {
        set((state) => {
          const scope = state.worktreeChats[key];
          if (!scope) return state;
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: {
                ...scope,
                tabs: scope.tabs.map((entry) =>
                  entry.id !== chatId
                    ? entry
                    : {
                        ...(entry.pendingQueueMessages?.some(
                          (pending) => pending.userMessageId === userMessageId,
                        )
                          ? cancelProvisionalFirstSendQueue(
                              entry,
                              userMessageId,
                            )
                          : entry),
                        pendingQueueMessages:
                          entry.pendingQueueMessages?.filter(
                            (pending) =>
                              pending.userMessageId !== userMessageId,
                          ),
                      },
                ),
              },
            },
          };
        });
      };
      if (
        !isCoworkChatTarget(sel.projectId) &&
        options?.assistantMode === undefined
      )
        set((state) => {
          const scope = state.worktreeChats[key];
          if (!scope) return state;
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: {
                ...scope,
                tabs: scope.tabs.map((entry) =>
                  entry.id !== chatId
                    ? entry
                    : {
                        ...handOffProvisionalFirstSendToQueue(
                          entry,
                          userMessageId,
                        ),
                        pendingQueueMessages: [
                          ...(entry.pendingQueueMessages ?? []),
                          {
                            userMessageId,
                            previousHostIds: entry.queuedMessages.flatMap(
                              (row) =>
                                row.hostQueueEntryId
                                  ? [row.hostQueueEntryId]
                                  : [],
                            ),
                            message: {
                              text,
                              fileReferences,
                              attachmentPaths,
                              attachmentPromptContexts,
                              inputMode,
                              pendingSend: true,
                            },
                          },
                        ],
                      },
                ),
              },
            },
          };
        });
      const approvalCacheKey = approvalDefaultCacheKey(
        sel.projectId,
        sel.worktreeId,
      );
      let approvalModeForSend =
        tab.approvalMode ?? get().approvalDefaultsCache[approvalCacheKey];
      if (!approvalModeForSend) {
        const resolvedMode = await get().fetchApprovalDefault(
          sel.projectId,
          sel.worktreeId,
        );
        const latestTab = get().worktreeChats[key]?.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        approvalModeForSend = latestTab?.approvalMode ?? resolvedMode;
      }
      try {
        const streamingApprovalModeTransitions =
          waitForPendingApprovalModeTransitions(
            sel.projectId,
            sel.worktreeId,
            chatId,
          );
        if (streamingApprovalModeTransitions) {
          await streamingApprovalModeTransitions;
        }
      } catch {
        clearPendingQueuePresentation();
        options?.onPreDispatchRejected?.();
        return;
      }
      const latestTabForSend =
        get().worktreeChats[key]?.tabs.find(
          (candidate) => candidate.id === chatId,
        ) ?? tab;
      approvalModeForSend =
        latestTabForSend.approvalMode ?? approvalModeForSend;
      const pendingSystemInstructionsForSend =
        latestTabForSend.pendingSystemInstructions ?? [];
      const pendingSystemInstructionIdsForSend =
        pendingSystemInstructionsForSend.map((instruction) => instruction.id);
      const restoreReservedSystemInstructions = (): void => {
        if (pendingSystemInstructionsForSend.length === 0) return;
        set((state) => {
          const currentWc = state.worktreeChats[key];
          if (!currentWc) return state;
          let changed = false;
          const tabs = currentWc.tabs.map((entry) => {
            if (entry.id !== chatId) return entry;
            const existingIds = new Set(
              entry.pendingSystemInstructions?.map(
                (instruction) => instruction.id,
              ) ?? [],
            );
            const missing = pendingSystemInstructionsForSend.filter(
              (instruction) => !existingIds.has(instruction.id),
            );
            if (missing.length === 0) return entry;
            changed = true;
            return {
              ...entry,
              pendingSystemInstructions: [
                ...missing,
                ...(entry.pendingSystemInstructions ?? []),
              ],
            };
          });
          if (!changed) return state;
          const updated: WorktreeChatState = { ...currentWc, tabs };
          return {
            worktreeChats: { ...state.worktreeChats, [key]: updated },
          };
        });
      };
      // Reserve one-shot instructions before crossing the IPC boundary. The
      // composer stays interactive while main accepts the first send, so a
      // second rapid send must not snapshot the same directives. Rejections
      // restore only the reserved IDs and preserve instructions added later.
      if (pendingSystemInstructionIdsForSend.length > 0) {
        set((state) => {
          const currentWc = state.worktreeChats[key];
          if (!currentWc) return state;
          let changed = false;
          const tabs = currentWc.tabs.map((entry) => {
            if (entry.id !== chatId) return entry;
            const nextEntry = consumePendingSystemInstructionsFromTab(
              entry,
              pendingSystemInstructionIdsForSend,
            );
            changed ||= nextEntry !== entry;
            return nextEntry;
          });
          if (!changed) return state;
          const updated: WorktreeChatState = { ...currentWc, tabs };
          return {
            worktreeChats: { ...state.worktreeChats, [key]: updated },
          };
        });
      }
      const streamingProviderType = resolveTabProviderType(latestTabForSend);
      let authDependencyRefusalError: Error | undefined;
      const hostQueueDispatch = chatBackendFor(sel)
        .chat.sendMessage({
          ...(options?.assistantMode
            ? { assistantMode: options.assistantMode }
            : {}),
          ...(options?.appAdvisorContext
            ? { appAdvisorContext: options.appAdvisorContext }
            : {}),
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
          userMessageId,
          text,
          ...(fileReferences?.length ? { fileReferences } : {}),
          ...(attachmentPaths?.length ? { attachmentPaths } : {}),
          ...(attachmentPromptContexts?.length
            ? { attachmentPromptContexts }
            : {}),
          ...(inputMode ? { inputMode } : {}),
          planMode: latestTabForSend.planMode,
          approvalMode: approvalModeForSend,
          ...(latestTabForSend.sessionApprovalRules?.length
            ? { sessionApprovalRules: latestTabForSend.sessionApprovalRules }
            : {}),
          modelConfig: latestTabForSend.modelConfig,
          thinkingLevel: latestTabForSend.thinkingLevel,
          model: latestTabForSend.model,
          sdkSessionId: latestTabForSend.sdkSessionId,
          globalInstructionsSnapshot:
            latestTabForSend.globalInstructionsSnapshot,
          ...(pendingSystemInstructionsForSend.length
            ? {
                pendingSystemInstructions: pendingSystemInstructionsForSend,
              }
            : {}),
          pluginSelections: latestTabForSend.pluginSelections,
          deferredToolsAllowed: latestTabForSend.deferredToolsAllowed !== false,
          providerType: streamingProviderType,
          executionHarness: executionHarnessForMessage,
          interfaceMode: latestTabForSend.interfaceMode,
          codexProposalMode: latestTabForSend.proposalMode,
          ...(latestTabForSend.selectedRepoId
            ? { selectedRepoId: latestTabForSend.selectedRepoId }
            : {}),
          ...(options?.hiddenContext &&
          options.hiddenContext.kind !== 'agent-sender-context'
            ? { hiddenContext: options.hiddenContext }
            : {}),
          // Persisted with the host-queue entry, so the turn that eventually
          // dispatches it still carries the plan captured with the message.
          ...(options?.activePlan ? { activePlan: options.activePlan } : {}),
          ...(options?.initiationSource
            ? { initiationSource: options.initiationSource }
            : {}),
          ...(options?.automationName
            ? { automationName: options.automationName }
            : {}),
          ...(options?.packageOverlay
            ? { packageOverlay: options.packageOverlay }
            : {}),
          ...(tab.aiCreditsRouting?.active
            ? { aiCreditsRouting: tab.aiCreditsRouting }
            : {}),
          ...(tab.subscriptionBillingOverride
            ? { subscriptionBillingOverride: true }
            : {}),
          ...(tab.modelSelectionMode === 'auto'
            ? { modelSelectionMode: 'auto' as const }
            : {}),
        })
        .then((sendResult) => {
          // CAN-1814 PR 7. The host refused this follow-up outright rather
          // than queueing it — its required dependency is known-broken. It
          // never entered the queue, so the composer attachments that produced
          // it must NOT be consumed, and the transcript gets the same
          // `AuthRecoveryCard` the immediate-dispatch path renders. The card
          // is appended without failing the tab: the renderer took this branch
          // because it believed a turn was streaming, and ending someone
          // else's turn is not this send's to do.
          // Main held this watcher delivery at ingress and keeps its outbox;
          // drop only the local copy so a later resume can redeliver it.
          if (sendResult?.watcherDeliveryHeld) {
            clearPendingQueuePresentation();
            restoreReservedSystemInstructions();
            options?.onDispatchRejected?.();
            if (options?.throwOnDispatchFailure === true)
              authDependencyRefusalError = new Error(
                'Watcher delivery is held.',
              );
            return;
          }
          const refusedAuthDependencies = sendResult?.refusedAuthDependencies;
          if (refusedAuthDependencies) {
            clearPendingQueuePresentation();
            restoreReservedSystemInstructions();
            applyAuthDependencyRefusal(
              set,
              key,
              chatId,
              refusedAuthDependencies,
              { failTab: false },
            );
            options?.onDispatchRejected?.();
            if (options?.throwOnDispatchFailure === true)
              authDependencyRefusalError = new Error(
                refusedAuthDependencies.message,
              );
            return;
          }
          if (sendResult?.modelRoutingNotice) {
            useGitHubStore
              .getState()
              .addToast(sendResult.modelRoutingNotice, 'info');
          }
          // The host accepted this follow-up into its queue, so consume the
          // attachment state that produced it just like the renderer-local
          // queue paths do. Remove only the submitted instances: the composer
          // is still interactive while IPC is pending, and a newly added
          // attachment, including one re-added at the same path, must remain
          // available for the next message.
          set((state) => {
            const currentWc = state.worktreeChats[key];
            if (!currentWc) return state;
            let changed = false;
            const tabs = currentWc.tabs.map((entry) => {
              if (entry.id !== chatId) return entry;
              const nextEntry = clearAcceptedQueuedComposerAttachments(
                entry,
                pendingAttachments,
                revertAttachmentPath,
              );
              if (nextEntry.executionHarness === undefined) {
                changed = true;
                return {
                  ...nextEntry,
                  executionHarness: executionHarnessForMessage,
                };
              }
              changed ||= nextEntry !== entry;
              return nextEntry;
            });
            if (!changed) return state;
            const updated: WorktreeChatState = { ...currentWc, tabs };
            return {
              worktreeChats: { ...state.worktreeChats, [key]: updated },
            };
          });
          // The host now owns the message: retire any provider usage-limit
          // banner exactly like the immediate-dispatch path does — but only
          // once main has accepted the send, so a failed IPC leaves the
          // banner (and the user's context) intact.
          clearUsageLimitBannerForDispatchedUserMessage(
            sel.projectId,
            sel.worktreeId,
            chatId,
            set,
          );
          options?.onDispatchAccepted?.();
          // The host queue -- not this send -- now represents the message, so
          // an eager caller's provisional echo would otherwise render beside
          // the queued row.
          options?.onQueuedWithoutDispatch?.('host');
        })
        .catch((error: unknown) => {
          const current = get().worktreeChats[key]?.tabs.find(
            (entry) => entry.id === chatId,
          );
          // A canonical queue/message acknowledgement already consumed our
          // pending row. A later transport rejection cannot undo acceptance.
          if (
            !isCoworkChatTarget(sel.projectId) &&
            options?.assistantMode === undefined &&
            adoptableProvisionalFirstSend(current, userMessageId)?.phase ===
              'queued' &&
            !current?.pendingQueueMessages?.some(
              (pending) => pending.userMessageId === userMessageId,
            )
          ) {
            options?.onDispatchAccepted?.();
            options?.onQueuedWithoutDispatch?.('host');
            return;
          }
          clearPendingQueuePresentation();
          restoreReservedSystemInstructions();
          // A host-queue send that never reaches main would otherwise vanish
          // with no queued row on either side. Surface a user-visible signal
          // (non-disruptive toast — the active turn keeps streaming) instead of
          // only logging; full re-queue/rollback is tracked by CAN-1429.
          // eslint-disable-next-line no-console
          console.error(
            '[chatStore] host-queue send failed to reach main',
            error,
          );
          // The toast can appear while another chat is in view, so its header
          // names the chat's workspace and worktree and a click opens the chat.
          const { meta, onClick } = getChatToastAttribution({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            chatId,
          });
          useGitHubStore
            .getState()
            .addToast(
              "Couldn't send your message. Try again.",
              'error',
              onClick,
              meta,
            );
          options?.onDispatchRejected?.();
          if (options?.throwOnDispatchFailure === true) {
            throw error;
          }
        });
      if (options?.throwOnDispatchFailure === true) {
        await hostQueueDispatch;
        if (authDependencyRefusalError) throw authDependencyRefusalError;
      }
      return;
    }

    // Adopting a presented Home first send keeps its submission time, so the
    // turn's elapsed time does not restart at dispatch (CAN-4742).
    const adoptedFirstSend = adoptableProvisionalFirstSend(
      get().worktreeChats[key]?.tabs.find((entry) => entry.id === chatId),
      options?.userMessageId,
    );
    const now =
      options?.submittedAt ??
      (adoptedFirstSend?.phase === 'preparing'
        ? adoptedFirstSend.submittedAt
        : Date.now());
    const initialClaudeTerminalSnapshot = useClaudeTerminalStore
      .getState()
      .getStateForChat(sel.projectId, sel.worktreeId, chatId);
    const providerTypeForSend = resolveTabProviderType(tab);
    if (providerTypeForSend === 'ollama') {
      useOllamaConnectionBannerStore
        .getState()
        .recordSendTarget(ollamaBannerTarget);
    }
    const shouldStartFreshAppAdvisorNativeSession =
      shouldStartFreshNativeAppAdvisorSessionAfterTerminal(
        sel,
        tab,
        initialClaudeTerminalSnapshot,
      );
    const sdkSessionIdForSend = shouldStartFreshAppAdvisorNativeSession
      ? undefined
      : resolveNativeSendSdkSessionId(tab, initialClaudeTerminalSnapshot);
    const shouldClearFreshClaudeTerminalHandoff =
      shouldStartFreshAppAdvisorNativeSession ||
      (providerTypeForSend === 'claude' &&
        !chatTabHasConversationContent(tab) &&
        (tab.claudeTerminal !== undefined ||
          initialClaudeTerminalSnapshot?.sdkSessionId !== undefined));
    const shouldClearNonClaudeTerminalState =
      providerTypeForSend !== 'claude' && tab?.claudeTerminal !== undefined;
    const lastTurnWasResumeAttempt = Boolean(sdkSessionIdForSend);
    const nextCodexProposalMode =
      tab?.planMode &&
      tab.trackedPlanSource === 'codex' &&
      tab.hasOutstandingProposal
        ? 'required'
        : tab?.proposalMode;
    const startsNewTrackedChat = shouldEmitNewChatStartedWatcher(tab);
    const newChatStartedWatcherFiredAt = new Date(now).toISOString();

    const userMsg: ChatMessage = {
      id: options?.userMessageId ?? nextMsgId(),
      role: 'user',
      blocks: [
        ...(fileReferences && fileReferences.length > 0
          ? [{ type: 'file_references', references: fileReferences } as const]
          : []),
        { type: 'text', text },
      ],
      timestamp: now,
      ...(attachmentPaths ? { attachmentPaths } : {}),
      ...(attachmentPromptContexts ? { attachmentPromptContexts } : {}),
      ...(inputMode ? { inputMode } : {}),
    };
    const artifactCarry = qualifyingArtifactCarry(tab, {
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      chatId,
    });

    const automationInfoMsg: ChatMessage | null =
      options?.initiationSource === 'automation'
        ? {
            // Same turn-derived id main commits the banner under
            // (`automationInfoMessageId`), so the canonical copy replaces this
            // optimistic one instead of rendering beside it.
            id: `${userMsg.id}-automation-info`,
            role: 'system',
            blocks: [
              {
                type: 'automation_info',
                timestamp: now,
                ...(options.automationName
                  ? { activityName: options.automationName }
                  : {}),
              },
            ],
            timestamp: now,
          }
        : null;

    const timerMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: now, completedAt: null }],
      timestamp: now,
    };

    // Where canonical runtime owns status, the send shows as starting through
    // a lease until main acknowledges the turn; legacy scopes keep the
    // optimistic status write.
    const sendingLease = isScopeRevisionedLive(
      get(),
      sel.projectId,
      sel.worktreeId,
    )
      ? createSendingLease(userMsg.id, 'send', now)
      : undefined;
    if (!sendingLease) tagStatusWrite(chatId, 'send');
    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;

      const updatedTabs = currentWc.tabs.map((tab) => {
        if (tab.id !== chatId) return tab;

        // Generate title from the first user message only for default-titled
        // tabs. Explicit titles such as failed-pipeline debug tabs must
        // survive the initial prompt send.
        const isFirstMessage = tab.messages.every(
          (message) => message.id === userMsg.id,
        );
        const titlePatch = isFirstMessage
          ? firstMessageTitlePatch(tab, text)
          : null;

        const nextTab: ChatTab = {
          ...tab,
          ...titlePatch,
          ...(sendingLease ? { sendingLease } : { status: 'streaming' }),
          proposalMode: nextCodexProposalMode ?? tab.proposalMode,
          // Main retires the request with the accepted turn; drop it here too
          // so no fallback can still approve it (CAN-5431).
          ...(retiresSupersededPlanExit(tab)
            ? {
                pendingPlanExit: undefined,
                pendingPlanExitRequestId: undefined,
              }
            : {}),
          pendingAttachments: options?.composerAttachmentsReserved
            ? tab.pendingAttachments
            : undefined,
          pendingRevertAttachmentPath: options?.composerAttachmentsReserved
            ? tab.pendingRevertAttachmentPath
            : undefined,
          messages: [
            ...tab.messages.filter(
              (message) => watcherUserMessageId || message.id !== userMsg.id,
            ),
            ...(automationInfoMsg ? [automationInfoMsg] : []),
            ...(watcherUserMessageId &&
            tab.messages.some((message) => message.id === watcherUserMessageId)
              ? []
              : [userMsg]),
            timerMsg,
          ],
          ...(isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)
            ? {
                pendingTurn: {
                  userMessageId: userMsg.id,
                  timerMessage: timerMsg,
                },
                pendingUserMessages: [
                  ...(tab.pendingUserMessages ?? []).filter(
                    (message) => message.id !== userMsg.id,
                  ),
                  userMsg,
                ],
              }
            : adoptedFirstSend
              ? {
                  // The real timer is in the transcript now; retire only the
                  // adopted echo's renderer bridge.
                  pendingTurn:
                    tab.pendingTurn?.userMessageId === userMsg.id
                      ? undefined
                      : tab.pendingTurn,
                  pendingUserMessages: tab.pendingUserMessages?.some(
                    (message) => message.id !== userMsg.id,
                  )
                    ? tab.pendingUserMessages.filter(
                        (message) => message.id !== userMsg.id,
                      )
                    : undefined,
                }
              : {}),
          ...(tab.provisionalFirstSend?.userMessageId === userMsg.id
            ? {
                provisionalFirstSend: {
                  ...tab.provisionalFirstSend,
                  phase: 'dispatched' as const,
                },
              }
            : {}),
          lastTurnWasResumeAttempt,
          executionHarness: executionHarnessForMessage,
          sendRefusal: undefined,
          cancelRequestedByUser: undefined,
          cloudStop: undefined,
          // A new turn supersedes any stopped turn's Resume offer (CAN-3137).
          stoppedTurnResume: undefined,
          lastEventAt: now,
        };
        if (startsNewTrackedChat) {
          delete nextTab.newChatStartedWatcherPending;
          nextTab.newChatStartedWatcherFiredAt = newChatStartedWatcherFiredAt;
        }
        if (shouldClearNonClaudeTerminalState) {
          delete nextTab.claudeTerminal;
        }
        if (shouldClearFreshClaudeTerminalHandoff) {
          delete nextTab.sdkSessionId;
          delete nextTab.claudeForkSessionOnNextSend;
          delete nextTab.claudeTerminal;
        }
        return nextTab;
      });

      const updated = { ...currentWc, tabs: updatedTabs };
      return {
        pendingPlanExits: retiresSupersededPlanExit(tab)
          ? clearPendingPlanExitForChat(
              state.pendingPlanExits,
              sel.projectId,
              sel.worktreeId,
              chatId,
            )
          : state.pendingPlanExits,
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
    if (sendingLease) scheduleSendingLeaseExpiry(key, chatId, sendingLease);
    if (artifactCarry.length > 0) {
      get().recordAgentArtifactCarry(
        { projectId: sel.projectId, worktreeId: sel.worktreeId, chatId },
        userMsg.id,
        artifactCarry,
      );
    }

    /**
     * Set when the host REFUSED this send on a broken auth dependency
     * (CAN-1814 PR 7). Declared outside the try because the refusal renders its
     * own card and must not also be rendered as a generic error by the catch
     * below.
     */
    const reconcileRejectedPlanExit = async (): Promise<void> => {
      if (!retiresSupersededPlanExit(tab)) return;
      if (isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)) {
        // The revision-guarded snapshot path owns ordering and request maps.
        get().refreshChatScopeRevisioned(sel.projectId, sel.worktreeId);
        await waitForChatScopeLive(sel.projectId, sel.worktreeId);
        return;
      }
      const file = await chatBackendFor(sel)
        .chat.loadTabs(sel)
        .catch(() => undefined);
      const canonical = file?.tabs.find((entry) => entry.id === chatId);
      if (
        !canonical?.pendingPlanExit ||
        canonical.pendingPlanExitRequestId !== tab.pendingPlanExitRequestId ||
        canonical.trackedPlanId !== tab.trackedPlanId
      )
        return;
      set((state) => {
        const current = state.worktreeChats[key];
        const entry = current?.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        if (
          !current ||
          !entry ||
          entry.messages
            .slice()
            .reverse()
            .find((message) => message.role === 'user')?.id !== userMsg.id ||
          entry.pendingPlanExit ||
          entry.pendingPlanExitRequestId ||
          entry.trackedPlanId !== tab.trackedPlanId ||
          entry.trackedPlanReviewStatus !== tab.trackedPlanReviewStatus
        )
          return state;
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: {
              ...current,
              tabs: current.tabs.map((candidate) =>
                candidate.id === chatId
                  ? {
                      ...candidate,
                      pendingPlanExit: canonical.pendingPlanExit,
                      pendingPlanExitRequestId:
                        canonical.pendingPlanExitRequestId,
                    }
                  : candidate,
              ),
            },
          },
        };
      });
    };
    const clearPendingUserPresentation = (
      cancelledBeforeDispatch = false,
    ): void => {
      set((state) => {
        const scope = state.worktreeChats[key];
        if (!scope) return state;
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: {
              ...scope,
              tabs: scope.tabs.map((entry) =>
                entry.id !== chatId
                  ? entry
                  : {
                      ...withoutSendingLease(
                        cancelledBeforeDispatch
                          ? rejectUndispatchedProvisionalFirstSend(
                              entry,
                              userMsg.id,
                              timerMsg.id,
                            )
                          : entry,
                        userMsg.id,
                      ),
                      pendingTurn:
                        entry.pendingTurn?.userMessageId === userMsg.id
                          ? undefined
                          : entry.pendingTurn,
                      pendingUserMessages: entry.pendingUserMessages?.filter(
                        (message) => message.id !== userMsg.id,
                      ),
                    },
              ),
            },
          },
        };
      });
    };
    let refusedAuthDependencies: ChatSendAuthRefusal | undefined;
    let watcherDeliveryHeld = false;
    const preparationKey = nativeSendKey({ ...sel, chatId });
    const preparations =
      pendingNativeSends.get(preparationKey) ??
      new Set<NativeSendPreparation>();
    const preparation: NativeSendPreparation = {
      cancelled: false,
      dispatched: false,
    };
    preparations.add(preparation);
    pendingNativeSends.set(preparationKey, preparations);
    let routingStartedAt: number | undefined;
    let cancelledSendNotified = false;
    let hostDispatchStarted = false;
    const clearRoutingMarker = (): void => {
      if (routingStartedAt === undefined) return;
      set((state) => {
        const current = state.worktreeChats[key];
        if (!current) return state;
        const tabs = current.tabs.map((entry) => {
          if (
            entry.id !== chatId ||
            entry.modelRoutingStartedAt !== routingStartedAt
          )
            return entry;
          const next = { ...entry };
          delete next.modelRoutingStartedAt;
          return next;
        });
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...current, tabs },
          },
        };
      });
    };
    const rejectCancelledSend = async (): Promise<void> => {
      clearRoutingMarker();
      clearPendingUserPresentation(!hostDispatchStarted);
      await reconcileRejectedPlanExit();
      if (!cancelledSendNotified) {
        cancelledSendNotified = true;
        options?.onPreDispatchRejected?.();
        options?.onDispatchRejected?.();
      }
      if (options?.throwOnDispatchFailure === true) {
        throw new Error('Message stopped before it was sent.');
      }
    };
    try {
      if (
        isCoworkChatTarget(sel.projectId) &&
        !chatTabHasConversationContent(tab)
      ) {
        // Main validates the first cowork route from the persisted tab.
        await get().flushWorktreeTabs(sel.projectId, sel.worktreeId);
      }

      const postFlushApprovalModeTransitions =
        waitForPendingApprovalModeTransitions(
          sel.projectId,
          sel.worktreeId,
          chatId,
        );
      if (postFlushApprovalModeTransitions) {
        await postFlushApprovalModeTransitions;
      }

      // Pass planMode so the session is created with the correct permission mode
      let currentTab = get().worktreeChats[key]?.tabs.find(
        (t) => t.id === chatId,
      );
      const approvalCacheKey = approvalDefaultCacheKey(
        sel.projectId,
        sel.worktreeId,
      );
      let approvalModeForSend =
        currentTab?.approvalMode ??
        get().approvalDefaultsCache[approvalCacheKey];
      if (!approvalModeForSend) {
        const resolvedMode = await get().fetchApprovalDefault(
          sel.projectId,
          sel.worktreeId,
        );
        const latestTab = get().worktreeChats[key]?.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        approvalModeForSend = latestTab?.approvalMode ?? resolvedMode;
      }

      // Phase F5: if a managed Claude Code terminal is alive for this chat
      // we must hand the SDK session back to the Canopy-native runtime BEFORE
      // calling chat.sendMessage. Running both owners against the same
      // sdkSessionId would race; if cleanup fails we surface an error
      // instead of forging ahead.
      const claudeTerminalSnapshot = useClaudeTerminalStore
        .getState()
        .getStateForChat(sel.projectId, sel.worktreeId, chatId);
      const knownClaudeTerminalId =
        claudeTerminalSnapshot?.terminalId ?? tab?.claudeTerminal?.terminalId;
      if (providerTypeForSend === 'claude' && knownClaudeTerminalId) {
        const latestClaudeTerminalState =
          await window.api.claudeTerminal.getState(
            sel.projectId,
            sel.worktreeId,
            chatId,
          );
        if (latestClaudeTerminalState?.turnState === 'running') {
          throw new Error(
            `${brandText.appName} is available when the Claude Code turn is idle.`,
          );
        }
        await useClaudeTerminalStore
          .getState()
          .cleanup(
            sel.projectId,
            sel.worktreeId,
            chatId,
            'switch-to-native-send',
          );
      }

      if (isWebCoreScope(sel.projectId)) {
        // A cloud task this window opened before the web core created it
        // takes the send once it exists; one whose create failed hands the
        // draft back (CAN-6098).
        const created = await taskCreationSettled(sel).then(
          () => true,
          () => false,
        );
        if (!created) {
          await rejectCancelledSend();
          return;
        }
        // A cloud chat's turn runs with the selection the user just saved.
        // A Stop while that save lands withdraws the send below (CAN-6335).
        await selectionSaveSettled(chatId);
      }

      // A picker change can start during cowork persistence, default lookup,
      // or Claude terminal handoff. Wait for the latest transition after all
      // of those awaits, then derive the payload from fresh tab state with no
      // remaining async gap before chat.sendMessage.
      const preDispatchApprovalModeTransitions =
        waitForPendingApprovalModeTransitions(
          sel.projectId,
          sel.worktreeId,
          chatId,
        );
      if (preDispatchApprovalModeTransitions) {
        await preDispatchApprovalModeTransitions;
      }
      currentTab = get().worktreeChats[key]?.tabs.find(
        (candidate) => candidate.id === chatId,
      );
      if (preparation.cancelled) {
        await rejectCancelledSend();
        return;
      }
      approvalModeForSend =
        currentTab?.approvalMode ??
        get().approvalDefaultsCache[approvalCacheKey] ??
        approvalModeForSend;
      // Only the one-shot marker activates a snapshot anchor. Durable fork
      // provenance can survive archive/restore and must not truncate a later
      // resumed session back to the original fork point.
      const resumePointRequired =
        currentTab?.forkedFrom?.resumePointRequired === true &&
        currentTab.claudeForkSessionOnNextSend === true &&
        sdkSessionIdForSend !== undefined;
      const claudeForkResumeAt =
        currentTab?.claudeForkSessionOnNextSend &&
        sdkSessionIdForSend &&
        resumePointRequired
          ? resolveClaudeForkResumePoint(
              currentTab.messages,
              currentTab.forkedFrom?.atMessageId,
            )
          : undefined;
      const claudeForkStartsFresh =
        Boolean(sdkSessionIdForSend) &&
        currentTab?.claudeForkSessionOnNextSend === true &&
        resumePointRequired &&
        !claudeForkResumeAt;
      const safeSdkSessionIdForSend = claudeForkStartsFresh
        ? undefined
        : sdkSessionIdForSend;

      const autoRoutingStartedAt =
        currentTab?.modelSelectionMode === 'auto' ? Date.now() : undefined;
      const setAutoRoutingStartedAt = (value: number | undefined): void => {
        set((state) => {
          const current = state.worktreeChats[key];
          if (!current) return state;
          const tabs = current.tabs.map((entry) => {
            if (entry.id !== chatId) return entry;
            if (value === undefined) {
              if (entry.modelRoutingStartedAt === undefined) return entry;
              const next = { ...entry };
              delete next.modelRoutingStartedAt;
              return next;
            }
            return { ...entry, modelRoutingStartedAt: value };
          });
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: { ...current, tabs },
            },
          };
        });
      };
      if (autoRoutingStartedAt !== undefined) {
        routingStartedAt = autoRoutingStartedAt;
        setAutoRoutingStartedAt(autoRoutingStartedAt);
      }

      hostDispatchStarted = true;
      preparation.dispatched = true;
      const sendResult = await chatBackendFor(sel).chat.sendMessage({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        userMessageId: userMsg.id,
        text,
        ...(fileReferences && fileReferences.length > 0
          ? { fileReferences }
          : {}),
        ...(attachmentPaths ? { attachmentPaths } : {}),
        ...(attachmentPromptContexts ? { attachmentPromptContexts } : {}),
        ...(inputMode ? { inputMode } : {}),
        planMode:
          options?.planMode ??
          (isCoworkChatTarget(sel.projectId) ? false : currentTab?.planMode),
        approvalMode: approvalModeForSend,
        ...(currentTab?.sessionApprovalRules?.length
          ? { sessionApprovalRules: currentTab.sessionApprovalRules }
          : {}),
        modelConfig: currentTab?.modelConfig,
        thinkingLevel: currentTab?.thinkingLevel,
        model: currentTab?.model,
        sdkSessionId: safeSdkSessionIdForSend,
        globalInstructionsSnapshot: safeSdkSessionIdForSend
          ? currentTab?.globalInstructionsSnapshot
          : undefined,
        ...(currentTab?.codexReconstructionSeedId
          ? {
              codexReconstructionSeedId: currentTab.codexReconstructionSeedId,
            }
          : {}),
        // Only truncated forks require a point-in-time anchor. Whole-history
        // forks and import/restore continuations retain the ordinary plain
        // fork resume path when no resume-point marker is present.
        ...(currentTab?.claudeForkSessionOnNextSend && safeSdkSessionIdForSend
          ? {
              claudeForkSession: true,
              ...(claudeForkResumeAt ? { claudeForkResumeAt } : {}),
            }
          : {}),
        ...(claudeForkStartsFresh ? { claudeForkStartsFresh: true } : {}),
        pluginSelections: currentTab?.pluginSelections,
        deferredToolsAllowed: currentTab?.deferredToolsAllowed !== false,
        providerType: currentTab?.providerType,
        executionHarness: currentTab?.executionHarness,
        codexProposalMode: currentTab?.proposalMode,
        ...(currentTab?.selectedRepoId
          ? { selectedRepoId: currentTab.selectedRepoId }
          : {}),
        ...(options?.assistantMode
          ? { assistantMode: options.assistantMode }
          : {}),
        ...(options?.hiddenContext &&
        options.hiddenContext.kind !== 'agent-sender-context'
          ? { hiddenContext: options.hiddenContext }
          : {}),
        ...(options?.activePlan ? { activePlan: options.activePlan } : {}),
        ...(currentTab?.pendingSystemInstructions?.length
          ? { pendingSystemInstructions: currentTab.pendingSystemInstructions }
          : {}),
        ...(options?.appAdvisorContext
          ? { appAdvisorContext: options.appAdvisorContext }
          : {}),
        ...(options?.initiationSource
          ? { initiationSource: options.initiationSource }
          : {}),
        ...(options?.automationName
          ? { automationName: options.automationName }
          : {}),
        ...(options?.packageOverlay
          ? { packageOverlay: options.packageOverlay }
          : {}),
        ...(startsNewTrackedChat ? { startsNewTrackedChat: true } : {}),
        ...(currentTab?.aiCreditsRouting?.active
          ? { aiCreditsRouting: currentTab.aiCreditsRouting }
          : {}),
        ...(currentTab?.subscriptionBillingOverride
          ? { subscriptionBillingOverride: true }
          : {}),
        // Captured WITH the accepted message so a queued turn cannot be
        // reinterpreted at dequeue: main routes against this value, not against
        // whatever the composer shows by the time the queue drains.
        ...(currentTab?.modelSelectionMode === 'auto'
          ? { modelSelectionMode: 'auto' as const }
          : {}),
      });
      clearRoutingMarker();
      // CAN-1814 PR 7. The host refused this send before writing anything
      // durable, and told us exactly which dependencies are broken. Render the
      // refusal where the user is already looking -- in the transcript, under
      // the message that was refused -- as the same `AuthRecoveryCard` the
      // mid-turn path shows, rather than as a sentence they cannot act on.
      //
      // `authFailures` (not `authFailure`) is always used, even for a single
      // blocker: the plural field is the one that survives a multi-blocker
      // refusal, and `readAuthDependencyFailures` reads both.
      if (sendResult?.watcherDeliveryHeld) {
        watcherDeliveryHeld = true;
        clearPendingUserPresentation();
        await reconcileRejectedPlanExit();
        options?.onDispatchRejected?.();
        if (options?.throwOnDispatchFailure === true) {
          throw new Error('Watcher delivery is held.');
        }
        return;
      }
      refusedAuthDependencies = sendResult?.refusedAuthDependencies;
      if (refusedAuthDependencies) {
        clearPendingUserPresentation();
        await reconcileRejectedPlanExit();
        applyAuthDependencyRefusal(set, key, chatId, refusedAuthDependencies, {
          failTab: true,
          startsNewTrackedChat,
        });
        options?.onDispatchRejected?.();
        // A refusal IS a delivery failure for callers that asked to hear about
        // one (App Advisor watcher delivery acks the outcome upstream), so
        // honour `throwOnDispatchFailure`. The catch below rethrows it
        // untouched rather than stacking a second error message on the card.
        if (options?.throwOnDispatchFailure === true) {
          throw new Error(refusedAuthDependencies.message);
        }
        // Everything below is dispatch bookkeeping — retiring the usage-limit
        // banner, consuming pending system instructions, announcing
        // acceptance. A refused send dispatched nothing, so none of it applies.
        return;
      }
      if (sendResult?.modelRoutingNotice) {
        useGitHubStore
          .getState()
          .addToast(sendResult.modelRoutingNotice, 'info');
      }
      if (sendResult?.disposition === 'already_accepted') {
        clearPendingUserPresentation();
        // This replay starts no turn. Keep a review published since the original send.
        await reconcileRejectedPlanExit();
        set((state) => {
          const wc2 = state.worktreeChats[key];
          if (!wc2) return state;
          const tabs = wc2.tabs.map((entry) => {
            if (entry.id !== chatId) return entry;
            const messages = entry.messages.filter(
              (message) => message.id !== timerMsg.id,
            );
            if (messages.length === entry.messages.length) return entry;
            // Canonical runtime already projects status for a lease-backed
            // send; only the legacy optimistic write needs undoing.
            return {
              ...entry,
              ...(sendingLease ? {} : { status: tab.status, error: tab.error }),
              messages,
            };
          });
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: { ...wc2, tabs },
            },
          };
        });
        options?.onDispatchAccepted?.();
        return;
      }
      // Main accepted the send: from here canonical runtime alone decides.
      if (sendingLease)
        releaseSendingLease(key, chatId, sendingLease.userMessageId);
      clearUsageLimitBannerForDispatchedUserMessage(
        sel.projectId,
        sel.worktreeId,
        chatId,
        set,
      );
      if (currentTab?.pendingSystemInstructions?.length) {
        set((state) => {
          const wc2 = state.worktreeChats[key];
          if (!wc2) return state;
          let changed = false;
          const tabs = wc2.tabs.map((entry) => {
            if (
              entry.id !== chatId ||
              (entry.pendingSystemInstructions?.length ?? 0) === 0
            ) {
              return entry;
            }
            changed = true;
            return clearPendingSystemInstructionsFromTab(entry);
          });
          if (!changed) return state;
          const updated: WorktreeChatState = { ...wc2, tabs };
          return {
            worktreeChats: { ...state.worktreeChats, [key]: updated },
          };
        });
      }
      options?.onDispatchAccepted?.();
    } catch (err) {
      if (
        preparation.cancelled &&
        (!adoptedFirstSend || !hostDispatchStarted)
      ) {
        await rejectCancelledSend();
        return;
      }
      clearRoutingMarker();
      if (
        adoptedFirstSend &&
        !refusedAuthDependencies &&
        !watcherDeliveryHeld
      ) {
        const current = get().worktreeChats[key]?.tabs.find(
          (entry) => entry.id === chatId,
        );
        const currentUser = current?.messages
          .slice()
          .reverse()
          .find((message) => message.role === 'user');
        const acknowledged =
          current?.messages.some((message) => message.id === userMsg.id) &&
          ((isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId) &&
            !current.pendingUserMessages?.some(
              (message) => message.id === userMsg.id,
            )) ||
            current.messages
              .slice(
                current.messages.findIndex(
                  (message) => message.id === userMsg.id,
                ) + 1,
              )
              .some(
                (message) =>
                  message.role === 'assistant' ||
                  (message.id !== timerMsg.id &&
                    message.blocks.some(
                      (block) => block.type === 'turn_timer',
                    )),
              ));
        // A canonical acknowledgement or a newer turn owns this tab now.
        // A transport rejection cannot retract it or close its timer.
        if (acknowledged || (currentUser && currentUser.id !== userMsg.id)) {
          options?.onDispatchAccepted?.();
          return;
        }
      }
      // A cloud send the web core refused was never posted. Once the
      // composer has taken back the draft and its attachments, the message
      // leaves the transcript and the tab says why, as the cloud chat page
      // does (CAN-5972, CAN-6364). A composer that moved on can't take it
      // back, so then the message stays below, failed, rather than be lost;
      // and a send that may have landed always does, rather than invite a
      // second one.
      if (
        isWebCoreScope(sel.projectId) &&
        isWebCoreSendRefusal(err) &&
        !cancelledSendNotified
      ) {
        cancelledSendNotified = true;
        const restored = options?.onPreDispatchRejected?.() === true;
        options?.onDispatchRejected?.();
        if (restored) {
          clearPendingUserPresentation(true);
          await reconcileRejectedPlanExit();
          const reason = extractIpcErrorMessage(err).trim();
          set((state) =>
            updateChatTab(state, key, chatId, (entry) => ({
              ...entry,
              ...(sendingLease ? {} : { status: tab.status, error: tab.error }),
              messages: entry.messages.filter(
                (message) =>
                  message.id !== userMsg.id && message.id !== timerMsg.id,
              ),
              sendRefusal: reason,
            })),
          );
          if (options?.throwOnDispatchFailure === true) throw err;
          return;
        }
      }
      clearPendingUserPresentation();
      await reconcileRejectedPlanExit();
      // The refusal path above already rendered the recovery card and only
      // threw to satisfy `throwOnDispatchFailure`. Rethrow untouched: turning
      // it into a second `system` text message would bury the card under a
      // duplicate of its own sentence.
      if (refusedAuthDependencies || watcherDeliveryHeld) {
        throw err;
      }
      if (
        providerTypeForSend === 'ollama' &&
        isOllamaUnavailableIpcError(err)
      ) {
        useOllamaConnectionBannerStore
          .getState()
          .showUnavailable(ollamaBannerTarget);
      }
      const errorMessage = extractIpcErrorMessage(err);
      const failedAt = Date.now();
      tagStatusWrite(chatId, 'send');
      set((state) => {
        const wc2 = state.worktreeChats[key];
        if (!wc2) return state;
        const tabs = wc2.tabs.map((t) => {
          if (t.id !== chatId) return t;
          // A failed send ends no background work from an earlier turn.
          const completedMessages = closeOpenToolUseBlocks(
            completeTurnTimer(t.messages, failedAt),
            {
              liveness: selectChildToolLiveness(
                useLiveBackgroundTaskStore.getState(),
                sel.projectId,
                sel.worktreeId,
                chatId,
              ),
              codexRootThreadId: t.sdkSessionId,
            },
          );
          const visibleErrorMessage: ChatMessage = {
            id: nextMsgId(),
            role: 'system',
            blocks: [{ type: 'text', text: errorMessage }],
            timestamp: failedAt,
          };
          const staleSessionInfo =
            executionHarnessForMessage === 'codex' &&
            t.lastTurnWasResumeAttempt === true &&
            isCodexMissingRolloutResumeError(errorMessage)
              ? getRecoverableLastUserMessage(completedMessages)
              : null;
          if (staleSessionInfo) {
            const failedTab = {
              ...t,
              status: 'error' as const,
              error: errorMessage,
              messages: [...completedMessages, visibleErrorMessage],
              sdkSessionId: undefined,
              claudeForkSessionOnNextSend: undefined,
              staleSessionDetected: staleSessionInfo,
              staleSessionResumeId: t.sdkSessionId,
              lastTurnWasResumeAttempt: undefined,
              cancelRequestedByUser: undefined,
              readOnly: true,
            };
            if (startsNewTrackedChat) {
              delete failedTab.newChatStartedWatcherFiredAt;
              failedTab.newChatStartedWatcherPending = true;
            }
            return failedTab;
          }
          const failedTab = {
            ...t,
            status: 'error' as const,
            error: errorMessage,
            messages: [...completedMessages, visibleErrorMessage],
            lastTurnWasResumeAttempt: undefined,
          };
          if (startsNewTrackedChat) {
            delete failedTab.newChatStartedWatcherFiredAt;
            failedTab.newChatStartedWatcherPending = true;
          }
          return failedTab;
        });
        const updated: WorktreeChatState = { ...wc2, tabs };
        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
        };
      });
      // A refusal the composer could not take back has already told it.
      if (!cancelledSendNotified) options?.onDispatchRejected?.();
      if (options?.throwOnDispatchFailure === true) {
        throw err;
      }
    } finally {
      preparations.delete(preparation);
      if (
        preparations.size === 0 &&
        pendingNativeSends.get(preparationKey) === preparations
      ) {
        pendingNativeSends.delete(preparationKey);
      }
    }
  },

  presentProvisionalFirstSend: (target, input): boolean => {
    const key = worktreeKey(target);
    const tab = get().worktreeChats[key]?.tabs.find(
      (entry) => entry.id === target.chatId,
    );
    if (!tab) return false;
    const presented = presentProvisionalFirstSendOnTab(tab, input);
    if (!presented) return false;
    if (presented !== tab) {
      set((state) =>
        updateChatTab(state, key, target.chatId, (entry) =>
          entry === tab
            ? presented
            : (presentProvisionalFirstSendOnTab(entry, input) ?? entry),
        ),
      );
    }
    return (
      get().worktreeChats[key]?.tabs.find((entry) => entry.id === target.chatId)
        ?.provisionalFirstSend?.userMessageId === input.userMessageId
    );
  },

  dismissSendRefusal: (target): void => {
    set((state) =>
      updateChatTab(state, worktreeKey(target), target.chatId, (entry) => {
        if (entry.sendRefusal === undefined) return entry;
        const next = { ...entry };
        delete next.sendRefusal;
        return next;
      }),
    );
  },

  withdrawProvisionalFirstSend: (target, userMessageId): void => {
    set((state) =>
      updateChatTab(state, worktreeKey(target), target.chatId, (tab) =>
        withdrawProvisionalFirstSendFromTab(tab, userMessageId),
      ),
    );
  },

  failProvisionalFirstSend: (target, input): boolean => {
    set((state) =>
      updateChatTab(state, worktreeKey(target), target.chatId, (tab) =>
        failProvisionalFirstSendOnTab(
          tab,
          input.userMessageId,
          input.attemptId,
          input.failure,
          input.refusedBeforeDispatch === true,
        ),
      ),
    );
    const record = get().worktreeChats[worktreeKey(target)]?.tabs.find(
      (entry) => entry.id === target.chatId,
    )?.provisionalFirstSend;
    return (
      record?.userMessageId === input.userMessageId &&
      record.failure?.failureId === input.failure.failureId
    );
  },

  retryProvisionalFirstSend: (target, input): boolean => {
    set((state) =>
      updateChatTab(state, worktreeKey(target), target.chatId, (tab) =>
        retryFailedProvisionalFirstSendOnTab(
          tab,
          input.userMessageId,
          input.failureId,
          input.attemptId,
        ),
      ),
    );
    const record = get().worktreeChats[worktreeKey(target)]?.tabs.find(
      (entry) => entry.id === target.chatId,
    )?.provisionalFirstSend;
    return (
      record?.userMessageId === input.userMessageId &&
      record.phase === 'preparing' &&
      record.attemptId === input.attemptId
    );
  },

  handOffProvisionalFirstSend: (target, userMessageId): void => {
    set((state) =>
      updateChatTab(state, worktreeKey(target), target.chatId, (tab) =>
        handOffProvisionalFirstSendToQueue(tab, userMessageId),
      ),
    );
  },

  setChatInterfaceMode: async (
    tabId,
    mode,
    target,
  ): Promise<ChatCommandDisposition | undefined> => {
    const effectiveMode = getEffectiveClaudeChatInterfaceMode(mode);
    const sel = target
      ? { projectId: target.projectId, worktreeId: target.worktreeId }
      : get().selectedWorktree;
    if (!sel) return;
    const key = worktreeKey(sel);
    const previousTab = get().worktreeChats[key]?.tabs.find(
      (tab) => tab.id === tabId,
    );
    const previousMode = previousTab?.interfaceMode;
    const persistedMode = getPersistedClaudeChatInterfaceMode(effectiveMode);
    let changed = false;
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      const updatedTabs = wc.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        if (
          getEffectiveClaudeChatInterfaceMode(tab.interfaceMode) ===
          effectiveMode
        ) {
          return tab;
        }
        changed = true;
        const nextTab: ChatTab = { ...tab };
        if (persistedMode) {
          nextTab.interfaceMode = persistedMode;
        } else {
          delete nextTab.interfaceMode;
        }
        return nextTab;
      });
      if (!changed) return state;
      const updated: WorktreeChatState = { ...wc, tabs: updatedTabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
    if (changed) {
      // A manual mode switch is the user's escape hatch from a stuck
      // auto-send lock (e.g. a paste that never submitted): toggling away
      // and back to auto must land on the Canopy view, not re-pin the
      // terminal surface.
      useClaudeTerminalStore
        .getState()
        .clearAutoSendPending(sel.projectId, sel.worktreeId, tabId);
      const rollbackMode = (): void => {
        set((state) => {
          const wc = state.worktreeChats[key];
          if (!wc) return state;
          const tabs = wc.tabs.map((tab) => {
            if (tab.id !== tabId) return tab;
            const next = { ...tab };
            if (previousMode) next.interfaceMode = previousMode;
            else delete next.interfaceMode;
            return next;
          });
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: { ...wc, tabs },
            },
          };
        });
      };
      if (previousTab?.queuedHookPlaceholder === true) {
        // A queued hook placeholder has no canonical tab yet: a tab-settings
        // command would come back not_found and the conflict refresh would
        // drop the placeholder. The queued launch owns the mode instead, so
        // the hook starts on the chosen surface and its tab carries it.
        let updated: boolean;
        try {
          ({ updated } = await chatBackendFor(
            sel,
          ).chat.setQueuedHookChatInterfaceMode({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            chatId: tabId,
            interfaceMode: effectiveMode,
          }));
        } catch {
          rollbackMode();
          return 'transport_failed';
        }
        if (updated) return 'accepted';
        // The queued launch is gone. If the renderer still shows the
        // placeholder, the start is in flight: its launch surface is already
        // chosen and its tab is not canonical yet, so a patch would come back
        // not_found. Revert the toggle; the start event carries main's mode.
        const currentTab = get().worktreeChats[key]?.tabs.find(
          (tab) => tab.id === tabId,
        );
        if (currentTab?.queuedHookPlaceholder === true) {
          rollbackMode();
          return 'rejected';
        }
        // Otherwise the hook started meanwhile and its tab is canonical.
      }
      if (isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)) {
        const disposition = await get().dispatchChatCommand(
          sel,
          {
            type: 'chat.patch_tab_settings',
            tabId,
            patch: { interfaceMode: persistedMode ?? null },
          },
          { rollback: rollbackMode },
        );
        return disposition;
      }
    }
    return undefined;
  },

  ensureClaudeTerminal: async (
    tabId,
    target,
    dimensions,
    initialPrompt,
    options,
  ): Promise<ClaudeTerminalClientState | undefined> => {
    const sel = target
      ? { projectId: target.projectId, worktreeId: target.worktreeId }
      : get().selectedWorktree;
    if (!sel) return undefined;
    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    const tab = wc?.tabs.find((entry) => entry.id === tabId);
    if (!tab) return undefined;
    await get()
      .flushWorktreeTabs(sel.projectId, sel.worktreeId)
      .catch(() => undefined);
    // App Advisor entry chats always launch the managed terminal in App
    // Advisor assistant mode, mirroring the sendMessage derivation above.
    const derivedAssistantMode =
      options?.assistantMode ??
      (sel.projectId === APP_ADVISOR_PROJECT_ID
        ? ('app-advisor' as const)
        : undefined);
    const launchRequest = {
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      chatId: tabId,
      ...(derivedAssistantMode ? { assistantMode: derivedAssistantMode } : {}),
      // Default dimensions match TerminalPane's restore fallback. The
      // launching component can override these via `dimensions` to match the
      // currently-mounted pane.
      cols: dimensions?.cols ?? 80,
      rows: dimensions?.rows ?? 24,
      ...(tab.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
      ...(initialPrompt?.trim() ? { initialPrompt } : {}),
      ...(options?.initialPromptIdempotencyKey
        ? { initialPromptIdempotencyKey: options.initialPromptIdempotencyKey }
        : {}),
      ...(tab.interfaceMode ? { interfaceMode: tab.interfaceMode } : {}),
      tabSnapshot: toPersistedTab(tab),
    };
    const launched = await useClaudeTerminalStore
      .getState()
      .ensureLaunch(launchRequest);
    if (!launched.sdkSessionId) return launched;

    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;
      let changed = false;
      const tabs = currentWc.tabs.map((entry) => {
        if (
          entry.id !== tabId ||
          entry.sdkSessionId === launched.sdkSessionId
        ) {
          return entry;
        }
        changed = true;
        return { ...entry, sdkSessionId: launched.sdkSessionId };
      });
      if (!changed) return state;
      const updated: WorktreeChatState = { ...currentWc, tabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
    return launched;
  },

  cleanupClaudeTerminalForNativeSend: async (tabId, target): Promise<void> => {
    const sel = target
      ? { projectId: target.projectId, worktreeId: target.worktreeId }
      : get().selectedWorktree;
    if (!sel) return;
    const claudeTerminalState = useClaudeTerminalStore
      .getState()
      .getStateForChat(sel.projectId, sel.worktreeId, tabId);
    if (claudeTerminalState?.terminalId) {
      await useClaudeTerminalStore
        .getState()
        .cleanup(sel.projectId, sel.worktreeId, tabId, 'switch-to-native-send');
    }

    // Drop the persisted runtime snapshot so a reload doesn't try to hydrate
    // a terminal we just tore down. Note: we intentionally leave
    // `interfaceMode` alone — the user's mode preference is independent of
    // the live runtime.
    const key = worktreeKey(sel);
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      let changed = false;
      const updatedTabs = wc.tabs.map((tab) => {
        if (tab.id !== tabId || tab.claudeTerminal === undefined) return tab;
        changed = true;
        const nextTab: ChatTab = { ...tab };
        delete nextTab.claudeTerminal;
        return nextTab;
      });
      if (!changed) return state;
      const updated: WorktreeChatState = { ...wc, tabs: updatedTabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
  },

  cancelSession: async (target): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, chatId } = context;
    const cloud = isWebCoreScope(sel.projectId);
    // A cloud Stop already sent is sent again only once it has waited a
    // while for its turn to end (CAN-6592).
    if (cloud && presentedCloudStop(context.activeTab) === 'stopping') return;
    // Each press at the same turn is a new attempt: a retry sends its own
    // cancel.
    const previousStop = context.activeTab?.cloudStop;
    const pressedPromptId =
      context.activeTab === undefined
        ? undefined
        : cloudStopPromptId(context.activeTab);
    const stopAttempt =
      previousStop !== undefined &&
      previousStop.promptMessageId === pressedPromptId
        ? (previousStop.attempt ?? 1) + 1
        : 1;
    // A Stop's reply speaks only for its own press: a later attempt, or a
    // new turn, has replaced it (CAN-6592).
    const ownsStop = (tab: ChatTab): boolean =>
      tab.cloudStop?.attempt === stopAttempt &&
      tab.cloudStop.promptMessageId === pressedPromptId;
    pendingNativeSends
      .get(nativeSendKey({ ...sel, chatId }))
      ?.forEach((preparation) => {
        // A cloud send its backend has taken is the backend's to stop: it
        // cancels the turn by the send's receipt, so the send is never
        // also withdrawn here (CAN-6592). Before dispatch, the send is
        // withdrawn (CAN-6335).
        if (cloud && preparation.dispatched) return;
        preparation.cancelled = true;
      });

    set((state) =>
      updateCapturedChatTab(state, context, (tab) => ({
        ...tab,
        cancelRequestedByUser: true,
        // A cloud turn reads Stopping… until it ends (CAN-6592).
        ...(cloud
          ? {
              cloudStop: {
                phase: 'stopping' as const,
                promptMessageId: pressedPromptId,
                attempt: stopAttempt,
              },
            }
          : {}),
        ignoreNextCancellationTerminal:
          tab.forceQueuedMessageCancelPending === true
            ? tab.ignoreNextCancellationTerminal
            : undefined,
        // Cancelling/interrupting an in-progress turn for an auto-archive chat
        // stops it auto-archiving: drop the marker.
        ...(tab.autoArchive === true ? { autoArchive: undefined } : {}),
        autoArchiveToggleVisible: undefined,
      })),
    );
    if (cloud) armCloudStopRetry(context.key, chatId);

    const reloadMarker = context.activeTab?.deferredToolsReload;
    if (reloadMarker) {
      get().cancelDeferredToolsReload(
        { projectId: sel.projectId, worktreeId: sel.worktreeId, chatId },
        {
          requestId: reloadMarker.requestId,
          toolCallId: reloadMarker.toolCallId,
        },
      );
    }

    let cancelResult: ChatBackendCancelResult | undefined;
    try {
      cancelResult = await chatBackendFor(sel).chat.cancel({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        ...(cloud ? { attempt: stopAttempt } : {}),
      });
    } catch (error: unknown) {
      set((state) =>
        updateCapturedChatTab(state, context, (tab) => {
          const next: ChatTab = {
            ...tab,
            cancelRequestedByUser: undefined,
            forceQueuedMessageCancelPending: undefined,
            ignoreNextCancellationTerminal: undefined,
          };
          if (ownsStop(tab)) delete next.cloudStop;
          return next;
        }),
      );
      // An authority that serves no stop leaves the turn as it was.
      if (isCapabilityUnavailable(error)) return;
      throw error;
    }

    if (cloud && cancelResult?.outcome !== 'stop_requested') {
      const notStopped = cancelResult?.outcome === 'not_stopped';
      set((state) =>
        updateCapturedChatTab(state, context, (tab) => {
          if (!ownsStop(tab)) return tab;
          if (!notStopped) {
            // Nothing runs to stop: the turn ended, or its send was withdrawn.
            const next: ChatTab = { ...tab };
            delete next.cloudStop;
            return next;
          }
          // The turn may still run and nothing could name it: Stop stays,
          // and the composer says so.
          return {
            ...tab,
            cancelRequestedByUser: undefined,
            cloudStop: {
              phase: 'not_stopped',
              promptMessageId: pressedPromptId,
              attempt: stopAttempt,
            },
          };
        }),
      );
      if (notStopped) return;
    }

    // Main reports whether the stopped turn can be resumed (CAN-3137). Any
    // other outcome retires an older offer: this stop ended whatever it was.
    const resumableUserMessageId = cancelResult?.resumableTurn?.userMessageId;
    set((state) =>
      updateCapturedChatTab(state, context, (tab) => {
        if (resumableUserMessageId) {
          return {
            ...tab,
            stoppedTurnResume: {
              userMessageId: resumableUserMessageId,
              status: 'available',
            },
          };
        }
        if (!tab.stoppedTurnResume) return tab;
        return { ...tab, stoppedTurnResume: undefined };
      }),
    );
  },

  resumeStoppedTurn: async (target): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    const tab = context?.activeTab;
    if (!context || !tab) return;
    const offer = presentableStoppedTurnResume(tab);
    // `resuming` is written synchronously below, before any await, so a
    // second click in the same frame finds it here and does nothing.
    if (!offer || offer.status === 'resuming') return;
    const { selection: sel, chatId } = context;
    const requestToken = nextMsgId();
    const previousStatus = tab.status;
    const resumeKey = worktreeKey(sel);
    // Where canonical runtime owns status the resume is a lease until main
    // reports the turn; legacy scopes keep the optimistic status write.
    const sendingLease = isScopeRevisionedLive(
      get(),
      sel.projectId,
      sel.worktreeId,
    )
      ? createSendingLease(offer.userMessageId, 'resume', Date.now())
      : undefined;
    if (!sendingLease) tagStatusWrite(chatId, 'resume');

    set((state) =>
      updateCapturedChatTab(state, context, (current) => ({
        ...current,
        ...(sendingLease
          ? { sendingLease }
          : { status: 'streaming' as const, error: null }),
        cancelRequestedByUser: undefined,
        lastEventAt: Date.now(),
        stoppedTurnResume: {
          userMessageId: offer.userMessageId,
          status: 'resuming',
          requestToken,
        },
      })),
    );
    if (sendingLease) {
      scheduleSendingLeaseExpiry(resumeKey, chatId, sendingLease);
    }

    const approvalMode =
      tab.approvalMode ??
      get().approvalDefaultsCache[
        approvalDefaultCacheKey(sel.projectId, sel.worktreeId)
      ];
    let result: ChatResumeStoppedTurnResult;
    try {
      result = await chatBackendFor(sel).chat.resumeStoppedTurn({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        userMessageId: offer.userMessageId,
        planMode: isCoworkChatTarget(sel.projectId) ? false : tab.planMode,
        ...(approvalMode ? { approvalMode } : {}),
        ...(tab.sessionApprovalRules?.length
          ? { sessionApprovalRules: tab.sessionApprovalRules }
          : {}),
        modelConfig: tab.modelConfig,
        thinkingLevel: tab.thinkingLevel,
        model: tab.model,
        sdkSessionId: tab.sdkSessionId,
        globalInstructionsSnapshot: tab.sdkSessionId
          ? tab.globalInstructionsSnapshot
          : undefined,
        ...(tab.codexReconstructionSeedId
          ? { codexReconstructionSeedId: tab.codexReconstructionSeedId }
          : {}),
        pluginSelections: tab.pluginSelections,
        deferredToolsAllowed: tab.deferredToolsAllowed !== false,
        providerType: tab.providerType,
        executionHarness: tab.executionHarness,
        codexProposalMode: tab.proposalMode,
        ...(tab.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
        ...(tab.aiCreditsRouting?.active
          ? { aiCreditsRouting: tab.aiCreditsRouting }
          : {}),
        ...(tab.subscriptionBillingOverride
          ? { subscriptionBillingOverride: true }
          : {}),
      });
    } catch {
      // Main reports dispatch failures as a `failed` disposition with
      // display-safe text; a rejected IPC carries no such text, so use the
      // actionable fallback rather than a raw transport error.
      result = { disposition: 'failed', retryable: true };
    }

    // The reply settles the lease either way: an accepted dispatch hands the
    // turn to canonical runtime, a refusal leaves the chat stopped.
    if (sendingLease) {
      releaseSendingLease(resumeKey, chatId, sendingLease.userMessageId);
    } else {
      tagStatusWrite(chatId, 'resume');
    }
    set((state) =>
      updateCapturedChatTab(state, context, (current) => {
        // A later stop (or a new turn) replaced this request's offer; its
        // reply must not clear or overwrite that newer state.
        if (current.stoppedTurnResume?.requestToken !== requestToken) {
          return current;
        }
        if (
          result.disposition === 'dispatched' ||
          result.disposition === 'already_dispatched' ||
          result.disposition === 'in_progress'
        ) {
          return { ...current, stoppedTurnResume: undefined };
        }
        const restored: ChatTab = {
          ...current,
          ...(!sendingLease && current.status === 'streaming'
            ? { status: previousStatus }
            : {}),
        };
        if (result.disposition === 'stale' || result.retryable === false) {
          return { ...restored, stoppedTurnResume: undefined };
        }
        return {
          ...restored,
          stoppedTurnResume: {
            userMessageId: offer.userMessageId,
            status: 'available',
            error: result.error ?? STOPPED_TURN_RESUME_FAILED_MESSAGE,
          },
        };
      }),
    );
    if (result.disposition === 'stale') {
      useGitHubStore
        .getState()
        .addToast(STOPPED_TURN_RESUME_STALE_MESSAGE, 'info');
    }
  },

  resetToPoint: async (userMessageId, target): Promise<void> => {
    const { projectId, worktreeId, chatId } = target;
    const key = `${projectId}/${worktreeId}`;

    const response = await chatBackendFor({ projectId })
      .chat.resetToPoint({ projectId, worktreeId, chatId, userMessageId })
      .catch(ignoreUnavailable);
    if (response === undefined) return;

    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;

      // The new design appends a `revert_info` system message to the
      // transcript and stages a synthetic attachment for the next send.
      // The SDK session is NOT destroyed and existing messages are NOT
      // removed, so we only need to graft the new persisted state onto
      // the existing tab — preserving transient state (drafts, queued
      // messages, streaming status, plugin selections, etc.).
      const tabs = currentWc.tabs.map((tab) => {
        if (tab.id !== chatId) return tab;
        const hydratedMessages: ChatMessage[] = response.tab.messages.map(
          (msg) => ({
            id: msg.id,
            role: msg.role,
            ...(msg.hidden ? { hidden: true } : {}),
            blocks: msg.blocks,
            timestamp: msg.timestamp,
            ...(msg.parentToolUseId
              ? { parentToolUseId: msg.parentToolUseId }
              : {}),
            ...(msg.attachmentPaths?.length
              ? { attachmentPaths: msg.attachmentPaths }
              : {}),
            ...(msg.attachmentPromptContexts?.length
              ? { attachmentPromptContexts: msg.attachmentPromptContexts }
              : {}),
            ...(msg.inputMode ? { inputMode: msg.inputMode } : {}),
            ...(msg.watcherFired ? { watcherFired: msg.watcherFired } : {}),
            ...(msg.agentSent ? { agentSent: msg.agentSent } : {}),
          }),
        );
        return {
          ...tab,
          messages: hydratedMessages,
          pendingRevertAttachmentPath: response.tab.pendingRevertAttachmentPath,
        };
      });

      const updated = { ...currentWc, tabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
  },

  setSelectedRepoId: (selectedRepoId, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, chatId, activeTab } = context;
    if (!activeTab || activeTab.kind === 'file' || activeTab.readOnly) return;
    // Locked once the session has started — cwd is bound at session creation.
    const provisionalId =
      activeTab.provisionalFirstSend?.phase === 'preparing' &&
      activeTab.pendingUserMessages?.some(
        (message) =>
          message.id === activeTab.provisionalFirstSend?.userMessageId,
      )
        ? activeTab.provisionalFirstSend.userMessageId
        : undefined;
    if (activeTab.messages.some((message) => message.id !== provisionalId))
      return;
    const normalizedRepoId =
      selectedRepoId === WORKSPACE_ROOT_REPO_ID ? undefined : selectedRepoId;

    set((state) =>
      updateCapturedChatTab(state, context, (t) => {
        const next = { ...t };
        if (normalizedRepoId) {
          next.selectedRepoId = normalizedRepoId;
        } else {
          delete next.selectedRepoId;
        }
        return next;
      }),
    );
    if (isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)) {
      void get().dispatchChatCommand(
        { projectId: sel.projectId, worktreeId: sel.worktreeId },
        {
          type: 'chat.patch_tab_settings',
          tabId: chatId,
          patch: { selectedRepoId: normalizedRepoId ?? null },
        },
      );
    }

    // Project-scoped slash commands and skills are resolved from the chat's
    // working directory, so re-run discovery when the directory changes.
    requestTabDiscovery({
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      chatId,
      pluginSelections: activeTab.pluginSelections,
      providerType: resolveDiscoveryProviderType(activeTab),
      selectedRepoId: normalizedRepoId,
    });

    // When an empty chat is scoped to a child repo, inspect that repo's
    // own `canopy.json.plugins` for source-controlled recommendations. The
    // store-level dismissed-set keeps repeated re-scopes from re-prompting
    // in the same session.
    if (normalizedRepoId !== undefined) {
      void useProjectsStore
        .getState()
        .inspectRecommendedPlugins(sel.projectId, sel.worktreeId, {
          repoId: normalizedRepoId,
        });
    }
  },

  handleScheduledTerminalPrompt: (event): void => {
    const key = `${event.projectId}/${event.worktreeId}`;
    let rejectionReported = false;
    const reportRejection = (): void => {
      if (rejectionReported) return;
      rejectionReported = true;
      // Lifecycle replies must reach main even while the view is refreshing.
      void chatBackendFor(event)
        .chat.command(
          createChatCommandEnvelope(
            { projectId: event.projectId, worktreeId: event.worktreeId },
            {
              type: 'chat.reject_plan_implementation_delivery',
              chatId: event.chatId,
              userMessageId: event.userMessageId,
            },
          ),
        )
        .then((result) => {
          if (
            result.outcome !== 'applied' &&
            result.outcome !== 'already_applied'
          )
            throw new Error(
              result.reason ?? 'Terminal plan delivery refusal was rejected.',
            );
        })
        .catch((error: unknown) => {
          reportRendererConsoleError(
            'Failed to record terminal plan delivery refusal',
            { error },
          );
        });
    };
    void (async (): Promise<void> => {
      if (!get().worktreeChats[key]) {
        await get()
          .loadTabsForTarget(event.projectId, event.worktreeId)
          .catch(() => undefined);
      }
      if (!get().worktreeChats[key]) {
        reportRejection();
        return;
      }
      const fromAcceptedInput = event.acceptedInputId !== undefined;
      await get().sendMessage(
        event.text,
        event.fileReferences,
        {
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId: event.chatId,
        },
        event.inputMode ?? 'typed',
        {
          ...(!fromAcceptedInput ? { initiationSource: 'automation' } : {}),
          ...(!fromAcceptedInput && event.automationName
            ? { automationName: event.automationName }
            : {}),
          userMessageId: event.userMessageId,
          ...(event.terminalPlanImplementation
            ? { terminalPlanImplementation: true }
            : {}),
          onPreDispatchRejected: reportRejection,
          onDispatchRejected: reportRejection,
          ...(event.acceptedInputId !== undefined
            ? { acceptedInputId: event.acceptedInputId }
            : {}),
          ...(event.hiddenContext
            ? { hiddenContext: event.hiddenContext }
            : {}),
          ...(event.agentSent ? { agentSent: event.agentSent } : {}),
          ...(event.attachmentPaths?.length
            ? { attachmentPaths: event.attachmentPaths }
            : {}),
          ...(event.attachmentPromptContexts?.length
            ? { attachmentPromptContexts: event.attachmentPromptContexts }
            : {}),
        },
      );
    })().catch((error: unknown) => {
      reportRejection();
      reportRendererConsoleError('Scheduled terminal delivery failed', {
        error,
      });
    });
  },
});
