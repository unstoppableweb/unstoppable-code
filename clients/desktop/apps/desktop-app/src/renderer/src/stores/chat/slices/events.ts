import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import { isPlanProposal } from '@canopy/desktop-shared/plan-review';
import { useDelegationTranscriptStore } from '../../delegationTranscriptStore';
import {
  reconcilePendingQueueMessages,
  restoreDispatchedQueueRow,
  withdrawQueuedSends,
} from '../optimistic-presentation';
import {
  canReceiveWorktreeChatActivity,
  isAppAdvisorChatTarget,
  isAppAdvisorWindowFocused,
  isReadOnlyAppAdvisorMirrorTarget,
  isSyntheticChatTarget,
} from '../surface';
import {
  ensureHydratedAndReplayPendingEvents,
  discardPendingHookPlaceholder,
  hydratedKeys,
  queuePendingHydrationEvent,
  recordWorktreeChatTouch,
  scheduleIdleChatUnload,
} from '../hydration';
import { isTurnDiffEventData, turnDiffsMatch } from '../turn-diffs';
import {
  chatRuntimeStatusToTabStatus,
  createSendingLease,
  latestChatActivityAt,
} from '../canonical-changes';
import {
  installRuntimeDivergenceDetector,
  tagStatusWrite,
} from '../runtime-divergence';
import {
  canonicalTurnStateFor,
  confirmCanonicalTurn,
  type CanonicalTurnState,
} from '../turn-confirmation';
import { scheduleSendingLeaseExpiry } from './messaging';
import { getEffectiveClaudeChatInterfaceMode } from '@/lib/claude-tui-chats';
import {
  applyTurnDiffEventToWorktree,
  dispatchActivityEvent,
  shouldReconcileBackgroundProcessesAfterTurn,
} from '../activity-dispatch';
import { scheduleStreamingVerification } from '../persistence';
import {
  isScopeRevisionedLive,
  persistUnreadWhenScopeLive,
} from './revisioned';
import {
  showCompletionNotice,
  takeCompletionNotice,
} from '../held-completion-notices';
import {
  selectChildToolLiveness,
  useLiveBackgroundTaskStore,
} from '../../liveBackgroundTaskStore';
import { useProjectsStore } from '../../projectsStore';
import { useAppAdvisorWatchersStore } from '../../appAdvisorWatchersStore';
import { usePipelineRunsStore } from '../../pipelineRunsStore';
import {
  projectAgentArtifacts,
  selectWatchedCarryReceipts,
} from '@/components/chat/agent-artifact-projection';
import { isRecord } from '../utils';
import { reconcileProvisionalTerminalFirstSend } from '../provisional-first-send';
import {
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
  type AgentProviderType,
  type ChatEvent,
  type ChatRuntimeState,
  getProviderForModel,
  isAiCreditsRoutingStatusEventData,
  isSetAutoArchiveRequestedEventData,
  isTerminalBackedInterfaceMode,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
  SET_AUTO_ARCHIVE_REQUESTED_EVENT_TYPE,
} from '@canopy/desktop-shared/types';
import {
  appendUniqueMessages,
  dropReplayedExistingPrefix,
  isClaudeTerminalTranscriptSyncEventData,
  normalizeFingerprintText,
  omitTurnTimerBlocks,
} from '../transcript-dedupe';
import { isInternalDeferredToolsReloadInterruption } from '../deferred-tool-reload';
import {
  getLastCompletedTurnDuration,
  hasAssistantMessageAfterLastUser,
  hasExplicitSessionExpirySignal,
  isForcedQueuedMessageCleanupTerminal,
  isNewResponseTurnEventData,
  isStaleTurnEvent,
  isTurnPreludeEvent,
  isUserCancellationTerminal,
  shouldIgnoreForcedQueuedMessageCleanupTerminal,
  shouldSuppressImplicitStaleSessionDetection,
} from '../turn-events';

import {
  clearRecordedUnreadChatAgentResponsePreview,
  getAppAdvisorMirrorProviderType,
  getRecordedUnreadChatAgentResponsePreview,
  getUnreadChatAgentResponsePreview,
  recordAppAdvisorMirrorProviderType,
  recordUnreadChatAgentResponsePreview,
  resolveResultNotificationProviderType,
} from '../unread-previews';
import {
  firstUserTextFromMessages,
  getRecoverableLastUserMessage,
} from '../messages';
import {
  chatTabHasConversationContent,
  clearUsageLimitBannerForDispatchedUserMessage,
  firstMessageTitlePatch,
  shouldGenerateTitleFromFirstMessage,
} from '../tab-utils';
import {
  type ChatTab,
  type StreamingTabVerificationResult,
  type WorktreeChatState,
} from '../types';
import { scheduleTaskBranchNamingFromInitialInput } from '../tab-lifecycle';
import {
  clearUnreadOnResumedTurn,
  getVisibleWorktreeKey,
  maybeFireChatActivityNotification,
  maybeShowUnreadChatToast,
  reinstateStaleSessionOnAgentResponse,
  tabHasReviewAttention,
  tabsStillNeedAttention,
  type UnreadChatToastOptions,
} from '../notifications';
import { useActivityStore } from '../../activityStore';
import { consumePendingSystemInstructionsFromTab } from '../plan-utils';
import {
  applyAppAdvisorMirrorNavEvent,
  applyTabEvent,
  clearForcedQueueFields,
  clearTerminalFields,
  closeOpenToolUseBlocks,
  closeOpenTurnTimers,
  createAppAdvisorMirrorTab,
} from '../event-transforms';
import {
  clearPendingPlanExitForChat,
  hasPendingTrackedPlanReview,
  retiresSupersededPlanExit,
  triggerPlanDetectionScan,
} from '../plan-utils';
import { isVisiblePlanExploreChat } from '../plan-explore-registry';
import { attachmentMetasFromPaths } from '../attachments';
import { isVisibleCodeReviewChat } from '../code-review-registry';
import { useGitHubStore } from '../../githubStore';
import { STALE_SESSION_DETECTION_THRESHOLD_MS } from '../constants';
import {
  applyQueuedHookPlaceholderTabSettings,
  fromPersistedTab,
  relabelFileTabs,
} from '../persisted-tabs';
import {
  hostQueueViewsToQueuedMessages,
  preserveHostQueueSummaryForTab,
  preserveHostQueueMirror,
  withHostQueueSummary,
} from '../queue-mirror';
import {
  requestTabDiscovery,
  resolveDiscoveryProviderType,
} from '../discovery';
import {
  hasPendingPromptForLiveTab,
  shouldPreserveRecentStreamingActivity,
  shouldPreserveStreamingOnRestore,
} from '../session-restore';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatEventsSlice } from '../state';
import { useOllamaConnectionBannerStore } from '../../ollamaConnectionBannerStore';
import { useNavigationStore } from '../../navigationStore';
import { chatStoreApi } from '../store-ref';
import { parseOrgMemoryUsedEvent } from '../memory';
import { isCoworkChatTarget } from '@/lib/cowork';
import { chatBackendFor } from '../backend';

const pendingCodexCompletionResults = new Set<string>();

/**
 * The divergence detector subscribes to the assembled store, which registers
 * itself after the slices are created; install it lazily from the entry
 * points chat activity flows through. Idempotent.
 */
function installRuntimeDivergenceDetectorSafely(): void {
  try {
    installRuntimeDivergenceDetector();
  } catch {
    // The store is not registered (an isolated slice in a test).
  }
}

/** Claude terminal-mode turns are projected from the terminal, not runtime. */
function isClaudeTerminalModeTab(tab: ChatTab): boolean {
  return (
    tab.claudeTerminal !== undefined ||
    isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(tab.interfaceMode),
    )
  );
}

interface CanonicalVerification {
  key: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** The cached runtime when the read started; a newer patch wins. */
  runtime: ChatRuntimeState | undefined;
  state: CanonicalTurnState;
}

/**
 * Main-owned sends (Portal, automations) persist their tab before broadcasting
 * `canopy_user_prompt`. A newly-created automation worktree can still be absent
 * from the renderer's project snapshot when that first event arrives, or its
 * temporary empty tab may already be marked hydrated. Keep the event burst
 * while we refresh the target and recover the durable tab instead of dropping
 * every event against an unknown chat id.
 */
const externallyPersistedTabRecoveries = new Map<string, ChatEvent[]>();

function externalChatRecoveryKey(event: ChatEvent): string {
  return `${event.projectId}/${event.worktreeId}/${event.chatId}`;
}

function recoverExternallyPersistedChatTab(event: ChatEvent): void {
  const recoveryKey = externalChatRecoveryKey(event);
  const pending = externallyPersistedTabRecoveries.get(recoveryKey);
  if (pending) {
    pending.push(event);
    return;
  }
  externallyPersistedTabRecoveries.set(recoveryKey, [event]);

  void (async (): Promise<void> => {
    if (!canReceiveWorktreeChatActivity(event.projectId, event.worktreeId)) {
      await useProjectsStore.getState().loadProjects({ silent: true });
    }
    if (!canReceiveWorktreeChatActivity(event.projectId, event.worktreeId)) {
      return;
    }

    const worktreeKey = `${event.projectId}/${event.worktreeId}`;
    if (
      !hydratedKeys.has(worktreeKey) ||
      !chatStoreApi().getState().worktreeChats[worktreeKey]
    ) {
      const queued = externallyPersistedTabRecoveries.get(recoveryKey) ?? [];
      externallyPersistedTabRecoveries.delete(recoveryKey);
      for (const queuedEvent of queued) {
        queuePendingHydrationEvent(worktreeKey, {
          kind: 'chat',
          event: queuedEvent,
        });
      }
      ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
      return;
    }

    const persisted = await chatBackendFor(event).chat.loadTabs({
      projectId: event.projectId,
      worktreeId: event.worktreeId,
    });
    const persistedTab = persisted.tabs.find(
      (candidate) => candidate.id === event.chatId,
    );
    if (!persistedTab) {
      return;
    }

    chatStoreApi().setState((state) => {
      const worktreeChat = state.worktreeChats[worktreeKey];
      if (!worktreeChat) return state;
      const existingIndex = worktreeChat.tabs.findIndex(
        (candidate) => candidate.id === event.chatId,
      );
      const recoveredTab = fromPersistedTab(persistedTab);
      const tabs =
        existingIndex >= 0
          ? worktreeChat.tabs.map((candidate, index) =>
              index === existingIndex ? recoveredTab : candidate,
            )
          : [...worktreeChat.tabs, recoveredTab];
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [worktreeKey]: {
            ...worktreeChat,
            tabs,
            activeTabId: event.chatId,
          },
        },
      };
    });

    const queued = externallyPersistedTabRecoveries.get(recoveryKey) ?? [];
    externallyPersistedTabRecoveries.delete(recoveryKey);
    for (const queuedEvent of queued) {
      chatStoreApi().getState().handleChatEvent(queuedEvent);
    }
  })()
    .catch(() => {
      // The persisted tab remains authoritative and will hydrate on the next
      // explicit selection even if this best-effort live recovery fails.
    })
    .finally(() => {
      externallyPersistedTabRecoveries.delete(recoveryKey);
    });
}

export const createEventsSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatEventsSlice
> = (set, get) => ({
  handleChatQueueUpdated: (event): void => {
    installRuntimeDivergenceDetectorSafely();
    const key = `${event.projectId}/${event.worktreeId}`;
    // A queue event can arrive before the worktree's tabs hydrate. Queue it
    // for replay-after-hydration like other pre-hydration chat events;
    // snapshots are also pulled during hydration by every tab-load path.
    if (!get().worktreeChats[key] && !hydratedKeys.has(key)) {
      queuePendingHydrationEvent(key, { kind: 'chat-queue', event });
      ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
      return;
    }
    set((state) => {
      const worktreeChat = state.worktreeChats[key];
      if (!worktreeChat) return state;
      const tabs = worktreeChat.tabs.map((tab) => {
        if (tab.id !== event.chatId) return tab;
        const editingEntryId =
          tab.editingQueuedMessageIndex === undefined
            ? undefined
            : tab.queuedMessages[tab.editingQueuedMessageIndex]
                ?.hostQueueEntryId;
        const localRows = tab.queuedMessages.filter(
          (message) => message.hostQueueEntryId === undefined,
        );
        const mirroredRows = hostQueueViewsToQueuedMessages(event.queue);
        // If the mirror wins the channel race, retain the old row until the
        // canonical runtime transaction tells us dispatch versus cancellation.
        const canonicalIds =
          state.runtimeByChatId[tab.id]?.queuedMessageIds ?? [];
        const awaitingCanonical = tab.queuedMessages.filter(
          (row) =>
            row.hostQueueEntryId &&
            canonicalIds.includes(row.hostQueueEntryId) &&
            !mirroredRows.some(
              (next) => next.hostQueueEntryId === row.hostQueueEntryId,
            ),
        );
        const queuedMessages = [
          ...localRows,
          ...mirroredRows,
          ...awaitingCanonical,
        ];
        tab = withdrawQueuedSends(
          restoreDispatchedQueueRow(tab, mirroredRows),
          mirroredRows,
        );
        const editingQueuedMessageIndex = editingEntryId
          ? queuedMessages.findIndex(
              (message) => message.hostQueueEntryId === editingEntryId,
            )
          : -1;
        const updatedTab = withHostQueueSummary(
          {
            ...tab,
            queuedMessages,
            pendingQueueMessages: reconcilePendingQueueMessages(
              tab.pendingQueueMessages,
              mirroredRows,
            ),
          },
          event,
        );
        if (editingQueuedMessageIndex >= 0) {
          return { ...updatedTab, editingQueuedMessageIndex };
        }
        delete updatedTab.editingQueuedMessageIndex;
        return updatedTab;
      });
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: { ...worktreeChat, tabs },
        },
      };
    });
  },

  handleChatEvent: (event): void => {
    installRuntimeDivergenceDetectorSafely();
    const key = `${event.projectId}/${event.worktreeId}`;
    const rawData = event.data;
    // A logged delegate's progress is live-only: it is never committed, so
    // its card reads it from here (`delegated-agent-transcript.ts`).
    if (
      isRecord(rawData) &&
      rawData.type === 'canopy_delegation' &&
      isAgentDelegationTranscript(rawData.delegation)
    )
      useDelegationTranscriptStore
        .getState()
        .applyLive(event, rawData.delegation);
    const revisionedLive = isScopeRevisionedLive(
      get(),
      event.projectId,
      event.worktreeId,
    );
    const revisionedScopeKnown = get().chatStateSync[key] !== undefined;
    const isPresentationBoundaryEvent =
      isRecord(rawData) &&
      (rawData.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE ||
        rawData.type === GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE ||
        rawData.type === 'claude_terminal_transcript_sync' ||
        rawData.type === SET_AUTO_ARCHIVE_REQUESTED_EVENT_TYPE ||
        rawData.type === 'result' ||
        rawData.type === 'error' ||
        (rawData.type === 'codex' &&
          isRecord(rawData.event) &&
          ['turn.completed', 'turn.failed', 'error'].includes(
            String(rawData.event.type),
          )));
    // Scopes owned by the revisioned canonical stream receive their durable
    // transcript/lifecycle state exclusively through committed
    // `chat:state-changed` deltas. Terminal and accepted boundaries still run
    // through the compatibility reducer after that commit for renderer-only
    // presentation effects (focus-aware unread toasts, notifications, and
    // immediate banner dismissal); persistence is blocked for revisioned
    // scopes, so they cannot overwrite canonical state.
    if (revisionedLive && !isPresentationBoundaryEvent) {
      if (!canReceiveWorktreeChatActivity(event.projectId, event.worktreeId)) {
        return;
      }
      if (isTurnDiffEventData(rawData)) {
        if (rawData.files.length > 0) {
          useProjectsStore
            .getState()
            .fastRefreshWorktreeDiffStats(event.projectId, event.worktreeId);
        }
        return;
      }
      if (isAiCreditsRoutingStatusEventData(rawData)) {
        // Main reports the route it applied but never commits it, so no
        // canonical delta carries it; the tab keeps it renderer-only.
        const accountProxyRouted = rawData.accountProxyRouted === true;
        set((state) => {
          const worktreeChat = state.worktreeChats[key];
          const index =
            worktreeChat?.tabs.findIndex((tab) => tab.id === event.chatId) ??
            -1;
          const tab = index >= 0 ? worktreeChat?.tabs[index] : undefined;
          if (!worktreeChat || !tab) return state;
          if (tab.accountProxyRouted === accountProxyRouted) return state;
          const tabs = [...worktreeChat.tabs];
          tabs[index] = { ...tab, accountProxyRouted };
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: { ...worktreeChat, tabs },
            },
          };
        });
        return;
      }
      if (isRecord(rawData)) {
        const tab = get().worktreeChats[key]?.tabs.find(
          (entry) => entry.id === event.chatId,
        );
        if (tab?.transcriptStale) {
          recordUnreadChatAgentResponsePreview(
            event.projectId,
            event.worktreeId,
            event.chatId,
            rawData,
            true,
          );
        }
        dispatchActivityEvent(
          event.projectId,
          event.worktreeId,
          event.chatId,
          rawData,
        );
      }
      return;
    }
    const chatId = event.chatId;
    const recoveryKey = externalChatRecoveryKey(event);
    const activeRecovery = externallyPersistedTabRecoveries.get(recoveryKey);
    if (activeRecovery) {
      activeRecovery.push(event);
      return;
    }
    if (!canReceiveWorktreeChatActivity(event.projectId, event.worktreeId)) {
      if (isRecord(rawData) && rawData.type === 'canopy_user_prompt') {
        recoverExternallyPersistedChatTab(event);
      }
      return;
    }

    recordWorktreeChatTouch(key);

    if (isTurnDiffEventData(rawData)) {
      if (!get().worktreeChats[key]) {
        queuePendingHydrationEvent(key, { kind: 'chat', event });
        ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
        return;
      }
      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;
        const updated = applyTurnDiffEventToWorktree(wc, chatId, rawData);
        if (!updated) return state;
        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
        };
      });
      // Checkpoint-based changes for this turn -> fast-track a scoped refresh.
      if (rawData.files.length > 0) {
        useProjectsStore
          .getState()
          .fastRefreshWorktreeDiffStats(event.projectId, event.worktreeId);
      }
      return;
    }

    const data = isRecord(rawData) ? rawData : {};
    const presentationTab = get().worktreeChats[key]?.tabs.find(
      (tab) => tab.id === chatId,
    );
    const presentationTargetKey = `${key}/${chatId}`;
    const isTerminalResult =
      data.type === 'result' && data.canopy_session_continues !== true;
    const isCancellationResult =
      isTerminalResult && isUserCancellationTerminal(data);
    const codexEvent =
      data.type === 'codex' && isRecord(data.event) ? data.event : null;
    const isRootCodexCompletion =
      codexEvent?.type === 'turn.completed' &&
      (codexEvent.thread_id === undefined ||
        codexEvent.thread_id === presentationTab?.sdkSessionId);
    const isSuccessfulRootCodexCompletion =
      isRootCodexCompletion && codexEvent.status === 'completed';
    if (
      data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE ||
      codexEvent?.type === 'turn.started'
    ) {
      pendingCodexCompletionResults.delete(presentationTargetKey);
    }
    if (isSuccessfulRootCodexCompletion) {
      pendingCodexCompletionResults.add(presentationTargetKey);
    }
    const suppressDuplicateCodexResult =
      isTerminalResult &&
      pendingCodexCompletionResults.delete(presentationTargetKey);
    const isCompletedPresentationBoundary =
      isSuccessfulRootCodexCompletion ||
      (isTerminalResult &&
        !isCancellationResult &&
        !suppressDuplicateCodexResult);
    const memoryUsed = parseOrgMemoryUsedEvent(data);
    if (memoryUsed) {
      if (!get().worktreeChats[key]) {
        queuePendingHydrationEvent(key, { kind: 'chat', event });
        ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
        return;
      }
      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;
        let changed = false;
        const tabs = wc.tabs.map((tab) => {
          if (tab.id !== chatId || memoryUsed.localChatId !== chatId) {
            return tab;
          }
          // Main-owned queued sends can report the injected context before
          // their user row reaches the renderer. Keep the bounded metadata in
          // memory; serialization retains it only after that user row exists.
          changed = true;
          return {
            ...tab,
            memoryByMessageId: {
              ...tab.memoryByMessageId,
              [memoryUsed.localMessageId]: {
                // The searched org scopes feedback (CAN-3457).
                ...(memoryUsed.organizationExternalId
                  ? {
                      organizationExternalId: memoryUsed.organizationExternalId,
                    }
                  : {}),
                ...(memoryUsed.searchId
                  ? { searchId: memoryUsed.searchId }
                  : {}),
                facts: memoryUsed.facts,
              },
            },
          };
        });
        if (!changed) return state;
        const updated = { ...wc, tabs };
        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
        };
      });
      return;
    }
    if (isSetAutoArchiveRequestedEventData(data)) {
      if (!get().worktreeChats[key]) {
        queuePendingHydrationEvent(key, { kind: 'chat', event });
        ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
        return;
      }
      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;
        let changed = false;
        const tabs = wc.tabs.map((tab) => {
          if (tab.id !== chatId || tab.kind === 'file') return tab;
          const nextAutoArchive = data.enabled ? true : undefined;
          if (
            tab.autoArchive === nextAutoArchive &&
            tab.autoArchiveToggleVisible === true
          ) {
            return tab;
          }
          changed = true;
          return {
            ...tab,
            autoArchive: nextAutoArchive,
            autoArchiveToggleVisible: true,
          };
        });
        if (!changed) return state;
        const updated = { ...wc, tabs };
        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
        };
      });
      return;
    }

    const currentTabForTurnEvent = get().worktreeChats[key]?.tabs.find(
      (tab) => tab.id === chatId,
    );
    if (
      !currentTabForTurnEvent &&
      hydratedKeys.has(key) &&
      data.type === 'canopy_user_prompt' &&
      !isSyntheticChatTarget(event.projectId, event.worktreeId)
    ) {
      recoverExternallyPersistedChatTab(event);
      return;
    }
    if (
      !currentTabForTurnEvent &&
      !hydratedKeys.has(key) &&
      !isSyntheticChatTarget(event.projectId, event.worktreeId)
    ) {
      queuePendingHydrationEvent(key, { kind: 'chat', event });
      ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
      return;
    }
    if (
      data.type === GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE &&
      typeof data.globalInstructionsSnapshot === 'string'
    ) {
      const globalInstructionsSnapshot = data.globalInstructionsSnapshot;
      set((state) => {
        const worktreeChat = state.worktreeChats[key];
        if (!worktreeChat) return state;
        let changed = false;
        const tabs = worktreeChat.tabs.map((tab) => {
          if (
            tab.id !== chatId ||
            tab.globalInstructionsSnapshot === globalInstructionsSnapshot
          ) {
            return tab;
          }
          changed = true;
          return {
            ...tab,
            globalInstructionsSnapshot,
          };
        });
        if (!changed) return state;
        const updated = { ...worktreeChat, tabs };
        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
        };
      });
      if (revisionedLive) {
        void get().dispatchChatCommand(
          { projectId: event.projectId, worktreeId: event.worktreeId },
          {
            type: 'chat.patch_tab_settings',
            tabId: chatId,
            patch: { globalInstructionsSnapshot },
          },
          { quietIfUnavailable: true },
        );
      }
      return;
    }
    const isTerminalTranscriptSyncEvent =
      isClaudeTerminalTranscriptSyncEventData(data);
    if (
      currentTabForTurnEvent &&
      !isTerminalTranscriptSyncEvent &&
      !isTurnPreludeEvent(data) &&
      isStaleTurnEvent(currentTabForTurnEvent, data)
    ) {
      return;
    }

    if (data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE) {
      // Main-owned sends (Portal, automations, App Advisor) announce the user
      // prompt before provider dispatch so the transcript opens immediately.
      // Retire a scheduled-resume banner only after main confirms that the
      // provider accepted the turn; rejected dispatches intentionally retain
      // both the visible and persisted recovery state.
      clearUsageLimitBannerForDispatchedUserMessage(
        event.projectId,
        event.worktreeId,
        chatId,
        set,
      );
      const consumedInstructionIds = Array.isArray(
        data.canopy_consumed_pending_system_instruction_ids,
      )
        ? data.canopy_consumed_pending_system_instruction_ids.filter(
            (instructionId): instructionId is string =>
              typeof instructionId === 'string',
          )
        : [];
      if (consumedInstructionIds.length > 0) {
        set((state) => {
          const worktreeChat = state.worktreeChats[key];
          if (!worktreeChat) return state;
          let changed = false;
          const tabs = worktreeChat.tabs.map((tab) => {
            if (tab.id !== chatId) return tab;
            const updatedTab = consumePendingSystemInstructionsFromTab(
              tab,
              consumedInstructionIds,
            );
            changed = changed || updatedTab !== tab;
            return updatedTab;
          });
          if (!changed) return state;
          const updated = { ...worktreeChat, tabs };
          return {
            worktreeChats: { ...state.worktreeChats, [key]: updated },
          };
        });
      }
      return;
    }

    // A late failure for a closed chat has no tab left to clear it.
    if (
      currentTabForTurnEvent &&
      data.type === 'error' &&
      data.error_code === OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE &&
      data.provider === 'ollama'
    ) {
      useOllamaConnectionBannerStore.getState().showUnavailable({
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId,
      });
    }

    // Un-archive on new response: if a content-bearing turn event arrives for a
    // chat that is currently archived (no live tab), bring it back so the
    // resumed turn streams into a live tab. Terminal/result events are excluded
    // so a trailing event from the just-archived turn does not immediately
    // un-archive. Once the tab is live, replay the triggering event so the
    // first transcript payload is preserved too.
    if (
      !currentTabForTurnEvent &&
      isNewResponseTurnEventData(data) &&
      get().archivedChats[key]?.some((summary) => summary.chatId === chatId)
    ) {
      void (async (): Promise<void> => {
        await get().unarchiveChatForNewResponse(
          event.projectId,
          event.worktreeId,
          chatId,
        );
        const restoredTab = get().worktreeChats[key]?.tabs.some(
          (tab) => tab.id === chatId,
        );
        if (restoredTab) {
          get().handleChatEvent(event);
        }
      })();
      return;
    }

    recordUnreadChatAgentResponsePreview(
      event.projectId,
      event.worktreeId,
      chatId,
      data,
      presentationTab?.transcriptStale === true,
    );

    if (isTerminalTranscriptSyncEvent) {
      if (!get().worktreeChats[key]) {
        queuePendingHydrationEvent(key, { kind: 'chat', event });
        ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
        return;
      }
      const terminalBranchNamingText = firstUserTextFromMessages(data.messages);
      const currentTabForBranchNaming = get().worktreeChats[key]?.tabs.find(
        (tab) => tab.id === chatId,
      );
      const terminalBranchNamingRequest =
        terminalBranchNamingText &&
        currentTabForBranchNaming?.interfaceMode === 'claude-code' &&
        (!chatTabHasConversationContent(currentTabForBranchNaming) ||
          (revisionedLive &&
            shouldGenerateTitleFromFirstMessage(
              currentTabForBranchNaming.title,
            )))
          ? {
              text: terminalBranchNamingText,
              ...(currentTabForBranchNaming.selectedRepoId
                ? { selectedRepoId: currentTabForBranchNaming.selectedRepoId }
                : {}),
            }
          : undefined;
      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;
        let changed = false;
        const settingsSync = data.settingsSync;
        const tabs = wc.tabs.map((tab) => {
          if (tab.id !== chatId) {
            return tab;
          }
          // Mirror TUI-initiated settings switches (`/model`,
          // permission-mode) into the tab so the Canopy pickers follow.
          const settingsPatch: Partial<
            Pick<ChatTab, 'model' | 'planMode' | 'providerType'>
          > = {
            ...(settingsSync?.model !== undefined &&
            settingsSync.model !== tab.model
              ? { model: settingsSync.model, providerType: 'claude' as const }
              : {}),
            ...(settingsSync?.planMode !== undefined &&
            settingsSync.planMode !== (tab.planMode ?? false)
              ? { planMode: settingsSync.planMode }
              : {}),
          };
          const hasSettingsPatch = Object.keys(settingsPatch).length > 0;
          const turnDiffPatch = data.turnDiffs;
          const hasTurnDiffPatch =
            turnDiffPatch !== undefined &&
            Object.entries(turnDiffPatch).some(
              ([userMessageId, turnDiff]) =>
                !turnDiffsMatch(tab.turnDiffs?.[userMessageId], turnDiff),
            );
          const rawIncomingMessages = tab.deferredToolsReload
            ? omitTurnTimerBlocks(data.messages)
            : data.messages;
          const pendingWatcherMessages = [
            ...(tab.pendingClaudeTerminalWatcherMessages ?? []),
          ];
          const existingMessageIds = new Set(
            tab.messages.map((message) => message.id),
          );
          const titlePatch =
            tab.messages.length === 0 || revisionedLive
              ? firstMessageTitlePatch(
                  tab,
                  firstUserTextFromMessages(data.messages) ?? '',
                )
              : null;
          const title = titlePatch?.title ?? tab.title;
          const retainedIncomingMessages =
            data.replayedFromStart === true
              ? dropReplayedExistingPrefix(tab.messages, rawIncomingMessages)
              : rawIncomingMessages.filter(
                  (message) => !existingMessageIds.has(message.id),
                );
          const matchedPendingWatcherIndexes = new Set<number>();
          const incomingMessages = retainedIncomingMessages.map((message) => {
            if (
              message.role !== 'user' ||
              pendingWatcherMessages.length === 0
            ) {
              return message;
            }
            const messageText = message.blocks.find(
              (block) => block.type === 'text',
            );
            if (!messageText || messageText.type !== 'text') return message;
            const normalizedText = normalizeFingerprintText(messageText.text);
            const pendingIndex = pendingWatcherMessages.findIndex(
              (pending, index) => {
                if (matchedPendingWatcherIndexes.has(index)) return false;
                const normalizedDisplayText = normalizeFingerprintText(
                  pending.text,
                );
                const normalizedSubmittedText = normalizeFingerprintText(
                  pending.submittedText ?? pending.text,
                );
                return (
                  normalizedText === normalizedSubmittedText ||
                  normalizedText === normalizedDisplayText ||
                  normalizedText.endsWith(` ${normalizedDisplayText}`)
                );
              },
            );
            if (pendingIndex < 0) return message;
            const pendingWatcher = pendingWatcherMessages[pendingIndex];
            if (!pendingWatcher) return message;
            matchedPendingWatcherIndexes.add(pendingIndex);
            return {
              ...message,
              watcherFired: pendingWatcher.watcherFired,
            };
          });
          const appended = appendUniqueMessages(tab.messages, incomingMessages);
          const reconciled = reconcileProvisionalTerminalFirstSend(
            appended === tab.messages ? tab : { ...tab, messages: appended },
            data.messages,
          );
          const messages = reconciled.messages;
          const newestIncomingUser =
            data.replayedFromStart === true
              ? undefined
              : [...incomingMessages]
                  .reverse()
                  .find(
                    (message) =>
                      message.role === 'user' &&
                      !tab.messages.some(
                        (current) => current.id === message.id,
                      ),
                  );
          const artifactCarry = newestIncomingUser
            ? selectWatchedCarryReceipts(
                projectAgentArtifacts(messages).chatInitiatedPipelineRuns,
                usePipelineRunsStore.getState().summaries,
                useAppAdvisorWatchersStore.getState().watchers,
                {
                  projectId: event.projectId,
                  worktreeId: event.worktreeId,
                  chatId,
                },
              )
            : [];
          if (
            reconciled === tab &&
            title === tab.title &&
            !hasSettingsPatch &&
            !hasTurnDiffPatch
          ) {
            return tab;
          }
          changed = true;
          // Terminal-mode prompts can be typed directly into the TUI, so
          // default-titled tabs adopt the first imported user message the
          // same way Canopy-native sends do.
          return {
            ...reconciled,
            ...titlePatch,
            messages,
            ...(matchedPendingWatcherIndexes.size > 0
              ? {
                  pendingClaudeTerminalWatcherMessages:
                    pendingWatcherMessages.filter(
                      (_pending, index) =>
                        !matchedPendingWatcherIndexes.has(index),
                    ),
                }
              : {}),
            ...(newestIncomingUser && artifactCarry.length > 0
              ? {
                  agentArtifactCarryByTurn: {
                    ...(tab.agentArtifactCarryByTurn ?? {}),
                    [newestIncomingUser.id]: artifactCarry,
                  },
                }
              : {}),
            ...settingsPatch,
            ...(turnDiffPatch
              ? {
                  turnDiffs: {
                    ...tab.turnDiffs,
                    ...turnDiffPatch,
                  },
                }
              : {}),
          };
        });
        if (!changed) {
          return state;
        }
        const updated = { ...wc, tabs };
        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
        };
      });
      if (terminalBranchNamingRequest) {
        scheduleTaskBranchNamingFromInitialInput(
          event.projectId,
          event.worktreeId,
          chatId,
          terminalBranchNamingRequest.text,
          terminalBranchNamingRequest.selectedRepoId,
        );
      }
      if (
        data.turnDiffs &&
        Object.values(data.turnDiffs).some((turnDiff) => turnDiff.files.length)
      ) {
        useProjectsStore
          .getState()
          .fastRefreshWorktreeDiffStats(event.projectId, event.worktreeId);
      }
      return;
    }

    const isTerminal =
      data.type === 'error' ||
      isTerminalResult ||
      isSuccessfulRootCodexCompletion;
    const isCancellationTerminal =
      isTerminal && isUserCancellationTerminal(data);

    // The internal interrupt used to rebuild a session during deferred tool
    // loading is not the turn's terminal result. A real terminal event clears
    // any stale reload marker before normal settlement continues.
    if (isTerminal) {
      const reloadTab = get().worktreeChats[key]?.tabs.find(
        (candidate) => candidate.id === chatId,
      );
      if (
        reloadTab &&
        isInternalDeferredToolsReloadInterruption(reloadTab, data)
      ) {
        return;
      }
      if (reloadTab?.deferredToolsReload) {
        set((state) => {
          const wc = state.worktreeChats[key];
          if (!wc) return state;
          let changed = false;
          const tabs = wc.tabs.map((candidate) => {
            if (candidate.id !== chatId || !candidate.deferredToolsReload) {
              return candidate;
            }
            changed = true;
            const next = { ...candidate };
            delete next.deferredToolsReload;
            return next;
          });
          return changed
            ? {
                worktreeChats: {
                  ...state.worktreeChats,
                  [key]: { ...wc, tabs },
                },
              }
            : state;
        });
      }
    }

    if (isTerminal && isForcedQueuedMessageCleanupTerminal(data)) {
      let ignoredDuplicateForcedCancellation = false;
      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;

        const tab = wc.tabs.find((candidate) => candidate.id === chatId);
        if (
          !tab ||
          !shouldIgnoreForcedQueuedMessageCleanupTerminal(tab, data)
        ) {
          return state;
        }

        ignoredDuplicateForcedCancellation = true;
        const tabs = wc.tabs.map((candidate) =>
          candidate.id === chatId
            ? {
                ...candidate,
                ignoreNextCancellationTerminal: undefined,
              }
            : candidate,
        );
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...wc, tabs },
          },
        };
      });
      if (ignoredDuplicateForcedCancellation) {
        return;
      }
    }

    let unreadToast: UnreadChatToastOptions | null = null;
    let resultCoveredByPlanReview = false;
    // OS-notification-only pings fired *unconditionally* on every result
    // event; the central helper performs focus/context suppression. This path
    // covers the background case (chat selected but window unfocused) that
    // the existing first-transition toast misses, and also serves as the
    // fallback when in-app chat banners are disabled.
    const osChatPings: UnreadChatToastOptions[] = [];
    const isReadOnlyAppAdvisorMirror = isReadOnlyAppAdvisorMirrorTarget(
      event.projectId,
      event.worktreeId,
    );
    if (!isReadOnlyAppAdvisorMirror && !get().worktreeChats[key]) {
      queuePendingHydrationEvent(key, { kind: 'chat', event });
      ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
      return;
    }

    dispatchActivityEvent(event.projectId, event.worktreeId, chatId, data);
    if (shouldReconcileBackgroundProcessesAfterTurn(data)) {
      // Full resolution pass at the turn boundary: the audit-trail read can
      // prove `completed`/`failed` with the provider's own summary, and the
      // liveness check against main's live-task set settles anything the
      // trail cannot account for, so a stale card never waits for the next
      // hydration to be cleared.
      void useActivityStore
        .getState()
        .resolveBackgroundProcesses(event.projectId, event.worktreeId, [
          chatId,
        ]);
    }

    if (isReadOnlyAppAdvisorMirror) {
      recordAppAdvisorMirrorProviderType(
        event.projectId,
        event.worktreeId,
        chatId,
        data,
      );

      set((state) => {
        const wc: WorktreeChatState = state.worktreeChats[key] ?? {
          activeTabId: '',
          tabs: [],
        };

        const isResult = isCompletedPresentationBoundary;

        const applyMirrorEvent = (tab: ChatTab): ChatTab => {
          let nextTab = applyAppAdvisorMirrorNavEvent(tab, data);
          nextTab = clearUnreadOnResumedTurn(nextTab, data);

          if (isResult) {
            const eventProviderType = resolveResultNotificationProviderType(
              tab,
              getAppAdvisorMirrorProviderType(
                event.projectId,
                event.worktreeId,
                chatId,
              ),
            );
            const appAdvisorWindowFocused = isAppAdvisorWindowFocused();
            const shouldMarkUnread = !appAdvisorWindowFocused;
            const alreadyUnread = tab.unread === true;
            const agentResponsePreview =
              getRecordedUnreadChatAgentResponsePreview(
                event.projectId,
                event.worktreeId,
                chatId,
              );
            if (!shouldMarkUnread || alreadyUnread) {
              osChatPings.push({
                projectId: event.projectId,
                worktreeId: event.worktreeId,
                chatId,
                chatTitle: tab.title,
                reason: 'activity',
                failed: data.is_error === true,
                agentResponsePreview,
                providerType: eventProviderType,
                requireUnreadBeforeDelivery: alreadyUnread,
              });
            }
            if (shouldMarkUnread) {
              if (!alreadyUnread) {
                unreadToast = {
                  projectId: event.projectId,
                  worktreeId: event.worktreeId,
                  chatId,
                  chatTitle: tab.title,
                  reason: 'activity',
                  failed: data.is_error === true,
                  agentResponsePreview,
                  providerType: eventProviderType,
                  requireUnreadBeforeDelivery: true,
                };
              }
              nextTab = {
                ...nextTab,
                unread: true,
                attentionDismissedAt: undefined,
              };
            }
          }

          return nextTab;
        };

        let matchedTab = false;
        const updatedExistingTabs = wc.tabs.map((tab) => {
          if (tab.id !== chatId) return tab;
          matchedTab = true;
          return applyMirrorEvent(tab);
        });
        const updatedTabs = matchedTab
          ? updatedExistingTabs
          : [
              ...updatedExistingTabs,
              applyMirrorEvent(createAppAdvisorMirrorTab(chatId)),
            ];

        const tabsChanged =
          updatedTabs.length !== wc.tabs.length ||
          updatedTabs.some((tab, index) => tab !== wc.tabs[index]);

        let nextUnread = state.unreadWorktreeKeys;
        if (isResult && !isAppAdvisorWindowFocused()) {
          if (!state.unreadWorktreeKeys.has(key)) {
            nextUnread = new Set(state.unreadWorktreeKeys);
            nextUnread.add(key);
          }
        } else if (
          !isResult &&
          isNewResponseTurnEventData(data) &&
          nextUnread.has(key) &&
          !tabsStillNeedAttention(updatedTabs)
        ) {
          nextUnread = new Set(nextUnread);
          nextUnread.delete(key);
        }

        if (!tabsChanged && nextUnread === state.unreadWorktreeKeys) {
          return state;
        }

        return {
          ...(tabsChanged
            ? {
                worktreeChats: {
                  ...state.worktreeChats,
                  [key]: { ...wc, tabs: updatedTabs },
                },
              }
            : {}),
          ...(nextUnread !== state.unreadWorktreeKeys
            ? { unreadWorktreeKeys: nextUnread }
            : {}),
        };
      });

      if (unreadToast) {
        maybeShowUnreadChatToast(unreadToast);
      }
      for (const ping of osChatPings) {
        maybeFireChatActivityNotification(ping);
      }
      if (data.type === 'result' && data.canopy_session_continues !== true) {
        clearRecordedUnreadChatAgentResponsePreview(
          event.projectId,
          event.worktreeId,
          chatId,
        );
      }

      if (isTerminal) {
        useProjectsStore
          .getState()
          .fastRefreshWorktreeDiffStats(event.projectId, event.worktreeId);
        scheduleIdleChatUnload();
      }

      return;
    }

    let shouldPersistUnread = false;
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;

      const isResult = isCompletedPresentationBoundary;

      const updatedTabs = wc.tabs.map((tab) => {
        if (tab.id !== chatId) return tab;
        // Main has already reduced durable transcript and runtime state before
        // emitting compatibility boundaries for revisioned scopes. Re-running
        // the provider reducer here can append the same terminal error under a
        // renderer-generated message id. Keep the compatibility pass limited
        // to the renderer-only presentation effects below.
        const canonicalLastActivityAt = revisionedLive
          ? state.runtimeByChatId[chatId]?.lastActivityAt
          : undefined;
        const nextCanonicalLastActivityAt = latestChatActivityAt(
          tab.lastEventAt,
          canonicalLastActivityAt,
        );
        const applied = revisionedLive
          ? tab.lastEventAt !== nextCanonicalLastActivityAt
            ? { ...tab, lastEventAt: nextCanonicalLastActivityAt }
            : tab
          : applyTabEvent(tab, data);
        const hasVisiblePlanReviewAttention =
          (tab.attentionDismissedAt === undefined &&
            tabHasReviewAttention(tab)) ||
          (applied.attentionDismissedAt === undefined &&
            tabHasReviewAttention(applied));
        const stickyReview = hasPendingTrackedPlanReview(applied);
        const cleared = clearTerminalFields(applied, {
          isTerminal,
          stickyReview,
          planProposal: isPlanProposal(applied.pendingPlanExit),
        });
        const forcedQueueStateCleared = reinstateStaleSessionOnAgentResponse(
          clearForcedQueueFields(cleared, {
            isTerminal,
            isCancellationTerminal,
          }),
          data,
          { canonicalStatus: revisionedScopeKnown },
        );
        const resumedTurnUnreadCleared = clearUnreadOnResumedTurn(
          forcedQueueStateCleared,
          data,
        );
        const shouldClearCurrentTurnAutoArchive =
          isTerminal &&
          !isCompletedPresentationBoundary &&
          resumedTurnUnreadCleared.autoArchiveToggleVisible === true;
        const turnAutoArchiveControlCleared = isTerminal
          ? {
              ...resumedTurnUnreadCleared,
              ...(shouldClearCurrentTurnAutoArchive
                ? { autoArchive: undefined }
                : {}),
              autoArchiveToggleVisible: undefined,
            }
          : resumedTurnUnreadCleared;
        // Mark tab unread if a turn completed while user is viewing elsewhere
        if (isResult) {
          const eventProviderType = resolveResultNotificationProviderType(tab);
          const visibleKey = getVisibleWorktreeKey(state.selectedWorktree);
          // App Advisor sentinel target uses BrowserWindow focus as the
          // unread predicate. A visible-but-blurred App Advisor window still
          // accrues unread until it comes into focus.
          const isAppAdvisorTarget = isAppAdvisorChatTarget(
            event.projectId,
            event.worktreeId,
          );
          // A collapsed chat panel is not on screen even when it is the
          // worktree's active tab, so it is not exempt from unread.
          const activeChatHidden = state.hiddenChatTabIds.has(chatId);
          const planExploreActiveChatVisible =
            !isAppAdvisorTarget &&
            isVisiblePlanExploreChat(event.projectId, event.worktreeId) &&
            wc.activeTabId === chatId &&
            !activeChatHidden;
          const codeReviewActiveChatVisible =
            !isAppAdvisorTarget &&
            isVisibleCodeReviewChat(event.projectId, event.worktreeId) &&
            wc.activeTabId === chatId &&
            !activeChatHidden;
          const shouldMarkUnread = isAppAdvisorTarget
            ? !isAppAdvisorWindowFocused()
            : !planExploreActiveChatVisible &&
              !codeReviewActiveChatVisible &&
              (wc.activeTabId !== chatId ||
                activeChatHidden ||
                key !== visibleKey);
          const alreadyUnread = tab.unread === true;
          const agentResponsePreview =
            getUnreadChatAgentResponsePreview(
              turnAutoArchiveControlCleared,
              event,
            ) ??
            getRecordedUnreadChatAgentResponsePreview(
              event.projectId,
              event.worktreeId,
              chatId,
            );
          if (!shouldMarkUnread || alreadyUnread) {
            osChatPings.push({
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              chatId,
              chatTitle: tab.title,
              reason: 'activity',
              failed: data.is_error === true,
              agentResponsePreview,
              providerType: eventProviderType,
              requireUnreadBeforeDelivery: alreadyUnread,
            });
          }
          if (shouldMarkUnread) {
            if (hasVisiblePlanReviewAttention) {
              resultCoveredByPlanReview = true;
              return turnAutoArchiveControlCleared;
            }
            if (!alreadyUnread) {
              shouldPersistUnread = true;
              unreadToast = {
                projectId: event.projectId,
                worktreeId: event.worktreeId,
                chatId,
                chatTitle: tab.title,
                reason: 'activity',
                failed: data.is_error === true,
                agentResponsePreview,
                providerType: eventProviderType,
                requireUnreadBeforeDelivery: true,
                // An auto-archive chat will be removed from the strip as soon as
                // this turn finishes, so route the toast to the archive viewer.
                ...(tab.autoArchive === true
                  ? { openArchivedTranscript: true }
                  : {}),
              };
            } else if (tab.unreadMarkedManually === true) {
              // A reply on a chat the user marked unread replaces the mark
              // with an automatic one, so its preview shows the reply. The
              // chat was already unread: no second toast or worktree key.
              shouldPersistUnread = true;
            }
            return {
              ...resumedTurnUnreadCleared,
              autoArchiveToggleVisible:
                turnAutoArchiveControlCleared.autoArchiveToggleVisible,
              unread: true,
              unreadMarkedManually: undefined,
              attentionDismissedAt: undefined,
            };
          }
        }
        return turnAutoArchiveControlCleared;
      });

      const tabsChanged =
        updatedTabs.length !== wc.tabs.length ||
        updatedTabs.some((tab, index) => tab !== wc.tabs[index]);
      const updated = tabsChanged ? { ...wc, tabs: updatedTabs } : wc;

      // Purge pending plan exits for this chat on terminal events
      let nextPending = state.pendingPlanExits;
      if (isTerminal) {
        const filtered = { ...nextPending };
        let changed = false;
        for (const [id, pe] of Object.entries(filtered)) {
          if (pe.chatId === chatId) {
            delete filtered[id];
            changed = true;
          }
        }
        if (changed) nextPending = filtered;
      }

      // Mark as unread if a turn completed while this worktree is not selected.
      // The App Advisor sentinel target uses BrowserWindow focus instead of
      // selected-worktree visibility — same predicate the per-tab branch
      // above uses.
      const visibleKey = getVisibleWorktreeKey(state.selectedWorktree);
      const isAppAdvisorTargetForKey = isAppAdvisorChatTarget(
        event.projectId,
        event.worktreeId,
      );
      const planExploreActiveChatVisibleForKey =
        !isAppAdvisorTargetForKey &&
        isVisiblePlanExploreChat(event.projectId, event.worktreeId) &&
        wc.activeTabId === chatId;
      const codeReviewActiveChatVisibleForKey =
        !isAppAdvisorTargetForKey &&
        isVisibleCodeReviewChat(event.projectId, event.worktreeId) &&
        wc.activeTabId === chatId;
      const targetNotVisible = isAppAdvisorTargetForKey
        ? !isAppAdvisorWindowFocused()
        : !planExploreActiveChatVisibleForKey &&
          !codeReviewActiveChatVisibleForKey &&
          key !== visibleKey;
      let nextUnread = state.unreadWorktreeKeys;
      if (isResult && targetNotVisible && !resultCoveredByPlanReview) {
        if (!state.unreadWorktreeKeys.has(key)) {
          nextUnread = new Set(state.unreadWorktreeKeys);
          nextUnread.add(key);
        }
      } else if (
        !isResult &&
        isNewResponseTurnEventData(data) &&
        nextUnread.has(key) &&
        !tabsStillNeedAttention(updated.tabs)
      ) {
        nextUnread = new Set(nextUnread);
        nextUnread.delete(key);
      }

      if (
        !tabsChanged &&
        nextPending === state.pendingPlanExits &&
        nextUnread === state.unreadWorktreeKeys
      ) {
        return state;
      }

      return {
        ...(tabsChanged
          ? { worktreeChats: { ...state.worktreeChats, [key]: updated } }
          : {}),
        ...(nextPending !== state.pendingPlanExits
          ? { pendingPlanExits: nextPending }
          : {}),
        ...(nextUnread !== state.unreadWorktreeKeys
          ? { unreadWorktreeKeys: nextUnread }
          : {}),
      };
    });

    if (revisionedLive && shouldPersistUnread) {
      void persistUnreadWhenScopeLive(
        event.projectId,
        event.worktreeId,
        chatId,
      );
    }

    // While background agents run, the chat reports once it is idle again.
    const completionNotice = takeCompletionNotice(
      { projectId: event.projectId, worktreeId: event.worktreeId, chatId },
      { toast: unreadToast, pings: osChatPings },
    );
    if (completionNotice) showCompletionNotice(completionNotice);
    if (
      data.type === 'result' &&
      data.canopy_session_continues !== true &&
      !get().worktreeChats[key]?.tabs.find((tab) => tab.id === chatId)
        ?.transcriptStale
    ) {
      clearRecordedUnreadChatAgentResponsePreview(
        event.projectId,
        event.worktreeId,
        chatId,
      );
    }

    // Refresh diff stats when an agent turn completes
    if (isTerminal) {
      useProjectsStore
        .getState()
        .fastRefreshWorktreeDiffStats(event.projectId, event.worktreeId);
      void useGitHubStore
        .getState()
        .requestKnownPrFastRefresh(event.projectId, event.worktreeId);
      scheduleIdleChatUnload();
    }

    let updatedWc = get().worktreeChats[key];
    let updatedTab = updatedWc?.tabs.find((t) => t.id === chatId);

    // Plan-detection scan: fire-and-forget after each completed turn so newly
    // referenced file paths can be matched against detection rules. Additive;
    // dedup inside scanDetectedPlans makes repeated calls safe.
    const isCompletedResult = isCompletedPresentationBoundary;
    if (isCompletedResult && updatedTab) {
      triggerPlanDetectionScan(updatedTab, event.projectId, event.worktreeId);
    }

    // Detect stale session resume: the SDK tried to resume an expired session
    // and completed almost instantly with zero assistant output. We exclude
    // explicit UI cancels and known cancel result strings, but still accept any
    // other result string because the SDK may emit its own terminal message
    // before the safety-net finally block runs.

    const updatedTabProvider: AgentProviderType | undefined =
      updatedTab?.providerType ??
      (updatedTab?.model ? getProviderForModel(updatedTab.model) : undefined);
    const staleSessionInfo = updatedTab
      ? getRecoverableLastUserMessage(updatedTab.messages)
      : null;
    const suppressImplicitStaleSessionDetection =
      staleSessionInfo?.droppedMessageText && updatedTab
        ? shouldSuppressImplicitStaleSessionDetection(
            staleSessionInfo.droppedMessageText,
            updatedTab.discovery,
            { allowDollarTrigger: updatedTabProvider === 'codex' },
          )
        : false;
    const hasExplicitExpirySignal = hasExplicitSessionExpirySignal(data);

    const shouldDetectStaleSession =
      isTerminal &&
      !isCancellationTerminal &&
      updatedTabProvider !== 'codex' &&
      // Cursor reopens a lost session itself (a failed load starts a fresh
      // one), so a fast, empty Cursor failure is a real error such as a
      // startup fault. Read-only here would block a retry that can succeed.
      updatedTabProvider !== 'cursor' &&
      updatedTab?.lastTurnWasResumeAttempt === true &&
      // Main's canonical empty-completion verdict owns this state. Replacing
      // it with the legacy stale-session transition would make the tab
      // read-only before its Resume / Try again / Report bug notice can render.
      updatedTab.emptyCompletionRecovery === undefined &&
      updatedTab.cancelRequestedByUser !== true &&
      hasAssistantMessageAfterLastUser(updatedTab.messages) === false &&
      (!suppressImplicitStaleSessionDetection || hasExplicitExpirySignal) &&
      (getLastCompletedTurnDuration(updatedTab.messages) ?? Infinity) <
        STALE_SESSION_DETECTION_THRESHOLD_MS;

    if (shouldDetectStaleSession && updatedTab) {
      if (staleSessionInfo) {
        set((state) => {
          const currentWc = state.worktreeChats[key];
          if (!currentWc) {
            return state;
          }

          const tabs = currentWc.tabs.map((tab) =>
            tab.id === chatId
              ? {
                  ...tab,
                  sdkSessionId: undefined,
                  claudeForkSessionOnNextSend: undefined,
                  staleSessionDetected: staleSessionInfo,
                  staleSessionResumeId: tab.sdkSessionId,
                  lastTurnWasResumeAttempt: undefined,
                  cancelRequestedByUser: undefined,
                  readOnly: true,
                }
              : tab,
          );
          const updated = { ...currentWc, tabs };
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: updated,
            },
          };
        });

        updatedWc = get().worktreeChats[key];
        updatedTab = updatedWc?.tabs.find((t) => t.id === chatId);
      }
    } else if (
      isTerminal &&
      (updatedTab?.lastTurnWasResumeAttempt !== undefined ||
        updatedTab?.cancelRequestedByUser === true)
    ) {
      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) {
          return state;
        }

        const tabs = currentWc.tabs.map((tab) =>
          tab.id === chatId
            ? {
                ...tab,
                lastTurnWasResumeAttempt: undefined,
                cancelRequestedByUser: undefined,
              }
            : tab,
        );
        const updated = { ...currentWc, tabs };
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: updated,
          },
        };
      });

      updatedWc = get().worktreeChats[key];
      updatedTab = updatedWc?.tabs.find((t) => t.id === chatId);
    }

    if (updatedTab?.staleSessionDetected) {
      return;
    }

    // Host-owned rows drain in the main process. When one is about to
    // continue the conversation: drop a pending plan-exit card — the queued
    // feedback supersedes it and main dispatches it as the next turn. In a
    // legacy scope also keep the tab visibly working across the terminal (the
    // legacy renderer drain re-sent synchronously, so the UI never flicked to
    // idle). A revisioned scope never does: main writes `starting` when it
    // dequeues the row, and a local `streaming` here would outlive a drain
    // that never happens. An edit-locked head will not drain, so idle stands.
    if (
      (updatedTab?.status === 'idle' || updatedTab?.status === 'error') &&
      updatedTab.queuedMessages[0]?.hostQueueEntryId !== undefined
    ) {
      const keepStreaming =
        !revisionedScopeKnown &&
        updatedTab.status === 'idle' &&
        updatedTab.queuedMessages[0]?.editLocked !== true;
      // Only the legacy optimistic start clears here. Revisioned scopes wait
      // for main's accepted-start delta; an edit-locked head has not started.
      const retirePlanRequest =
        keepStreaming && retiresSupersededPlanExit(updatedTab);
      const clearPlanCard = retirePlanRequest;
      if (keepStreaming) tagStatusWrite(chatId, 'keep-streaming');
      if (keepStreaming || clearPlanCard) {
        set((state) => {
          const currentWc = state.worktreeChats[key];
          if (!currentWc) return state;
          const tabs = currentWc.tabs.map((t) =>
            t.id === chatId
              ? {
                  ...t,
                  ...(clearPlanCard ? { pendingPlanExit: undefined } : {}),
                  ...(retirePlanRequest
                    ? { pendingPlanExitRequestId: undefined }
                    : {}),
                  ...(keepStreaming ? { status: 'streaming' as const } : {}),
                }
              : t,
          );
          return {
            ...(clearPlanCard
              ? {
                  pendingPlanExits: clearPendingPlanExitForChat(
                    state.pendingPlanExits,
                    event.projectId,
                    event.worktreeId,
                    chatId,
                  ),
                }
              : {}),
            worktreeChats: {
              ...state.worktreeChats,
              [key]: { ...currentWc, tabs },
            },
          };
        });
      }
    }

    // Renderer-local drain for rows the host queue does not own (cowork
    // chats stay renderer-queued in v1; host-owned rows carry
    // hostQueueEntryId and drain in the main process). Mirrors the original
    // terminal flush: short delay after error so the subprocess can clean up.
    if (
      (updatedTab?.status === 'idle' || updatedTab?.status === 'error') &&
      updatedTab.queuedMessages.length > 0 &&
      updatedTab.queuedMessages[0]?.hostQueueEntryId === undefined &&
      updatedTab.editingQueuedMessageIndex !== 0
    ) {
      const flushDelay = updatedTab.status === 'error' ? 500 : 0;
      const doFlush = (): void => {
        const currentWc = get().worktreeChats[key];
        const currentTab = currentWc?.tabs.find((t) => t.id === chatId);
        if (!currentTab || currentTab.queuedMessages.length === 0) return;
        if (currentTab.queuedMessages[0]?.hostQueueEntryId !== undefined) {
          return;
        }
        if (currentTab.editingQueuedMessageIndex === 0) return;

        const [nextMessage, ...remaining] = currentTab.queuedMessages;
        const isForceQueuedMessageFlush =
          currentTab.forceQueuedMessageCancelPending === true;
        const restoredAttachments = attachmentMetasFromPaths(
          nextMessage.attachmentPaths,
          nextMessage.attachmentPromptContexts,
        );
        set((state) => {
          const wc2 = state.worktreeChats[key];
          if (!wc2) return state;
          const tabs = wc2.tabs.map((t) => {
            if (t.id !== chatId) return t;
            const nextEditingIndex =
              t.editingQueuedMessageIndex !== undefined &&
              t.editingQueuedMessageIndex > 0
                ? t.editingQueuedMessageIndex - 1
                : t.editingQueuedMessageIndex;
            return {
              ...t,
              queuedMessages: remaining,
              pendingAttachments: restoredAttachments,
              forceQueuedMessageCancelPending: isForceQueuedMessageFlush
                ? undefined
                : t.forceQueuedMessageCancelPending,
              ignoreNextCancellationTerminal: isForceQueuedMessageFlush
                ? isCancellationTerminal
                  ? true
                  : undefined
                : t.ignoreNextCancellationTerminal,
              ...(nextEditingIndex !== undefined
                ? { editingQueuedMessageIndex: nextEditingIndex }
                : {}),
            };
          });
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: { ...wc2, tabs },
            },
          };
        });
        void get().sendMessage(
          nextMessage.text,
          nextMessage.fileReferences,
          {
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            chatId,
          },
          nextMessage.inputMode,
          nextMessage.dispatchOptions,
        );
      };

      if (flushDelay > 0) {
        setTimeout(doFlush, flushDelay);
      } else {
        doFlush();
      }
    }
  },

  handleHookTabStarted: (event): void => {
    const wtKey = `${event.projectId}/${event.worktreeId}`;
    if (!canReceiveWorktreeChatActivity(event.projectId, event.worktreeId)) {
      return;
    }

    recordWorktreeChatTouch(wtKey);
    installRuntimeDivergenceDetectorSafely();
    const queuedMessage = event.queuedMessage;
    const isQueuedPlaceholder = queuedMessage !== undefined;
    let insertedIntoLoadedWorktree = false;
    // A real start in a revisioned scope takes its status from canonical
    // runtime; until main reports the hook's turn it shows as starting
    // through a lease. Legacy scopes keep the optimistic `streaming`.
    const canonicalOwnsStatus = isScopeRevisionedLive(
      get(),
      event.projectId,
      event.worktreeId,
    );
    const hookRuntime = get().runtimeByChatId[event.chatId];
    const startedStatus: ChatTab['status'] = !canonicalOwnsStatus
      ? 'streaming'
      : hookRuntime
        ? chatRuntimeStatusToTabStatus(hookRuntime)
        : 'idle';
    const startedError =
      startedStatus === 'error' ? (hookRuntime?.error?.message ?? null) : null;
    const hookLease =
      !isQueuedPlaceholder &&
      canonicalOwnsStatus &&
      startedStatus !== 'streaming'
        ? createSendingLease(`hook:${event.chatId}`, 'hook', Date.now())
        : undefined;
    let hookLeaseIssued = false;
    if (!isQueuedPlaceholder) tagStatusWrite(event.chatId, 'hook-start');

    let selectedPlaceholderStarted = false;
    set((state) => {
      const wc = state.worktreeChats[wtKey];
      if (!wc) {
        return state;
      }
      insertedIntoLoadedWorktree = true;

      const existingIndex = wc.tabs.findIndex((tab) => tab.id === event.chatId);
      const existingTab =
        existingIndex >= 0 ? wc.tabs[existingIndex] : undefined;
      selectedPlaceholderStarted =
        !isQueuedPlaceholder &&
        existingTab?.queuedHookPlaceholder === true &&
        wc.activeTabId === event.chatId;
      // The canonical change stream may have already projected this tab's
      // prompt, live timer, or even its completed turn before the earlier
      // hook-started payload reaches the renderer. Keep the newer canonical
      // tab intact; this event can still select it. A queued hook placeholder
      // is renderer-owned and must be replaced when its real tab starts.
      if (
        existingTab &&
        state.chatStateSync[wtKey]?.phase === 'live' &&
        existingTab.queuedHookPlaceholder !== true
      ) {
        if (!event.activateTab || wc.activeTabId === event.chatId) {
          return state;
        }
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [wtKey]: { ...wc, activeTabId: event.chatId },
          },
        };
      }
      // Keep user follow-ups on repeated placeholder delivery and on start.
      // Replace the hook bubble on replay; consume it when the chat starts.
      const preservedLocalQueuedMessages =
        existingTab?.queuedHookPlaceholder === true
          ? existingTab.queuedMessages.filter(
              (message) =>
                message.queuedHookQueueId === undefined &&
                message.hostQueueEntryId === undefined,
            )
          : [];
      const nextLocalQueuedMessages = queuedMessage
        ? [
            {
              text: queuedMessage.text,
              reason: queuedMessage.reason,
              queuedHookQueueId: queuedMessage.queueId,
            },
            ...preservedLocalQueuedMessages,
          ]
        : preservedLocalQueuedMessages;
      const preservedQueuedMessages = preserveHostQueueMirror(
        existingTab?.queuedMessages,
        nextLocalQueuedMessages,
      );
      const baseNextTab: ChatTab = queuedMessage
        ? {
            ...fromPersistedTab(event.tab),
            status: 'idle',
            error: null,
            queuedMessages: preservedQueuedMessages,
            queuedHookPlaceholder: true,
            ...(queuedMessage.hookInfo
              ? { queuedHookInfo: queuedMessage.hookInfo }
              : {}),
            lastEventAt: Date.now(),
          }
        : {
            ...fromPersistedTab(event.tab),
            status: startedStatus,
            error: startedError,
            ...(hookLease ? { sendingLease: hookLease } : {}),
            queuedMessages: preservedQueuedMessages,
            lastEventAt: Date.now(),
          };
      hookLeaseIssued = hookLease !== undefined;
      const nextTabWithSettings = applyQueuedHookPlaceholderTabSettings(
        baseNextTab,
        !isQueuedPlaceholder ? existingTab : undefined,
      );
      const nextTab = preserveHostQueueSummaryForTab(
        existingTab,
        nextTabWithSettings,
      );
      const updatedTabs =
        existingIndex >= 0
          ? wc.tabs.map((tab) => (tab.id === event.chatId ? nextTab : tab))
          : [...wc.tabs, nextTab];

      return {
        worktreeChats: {
          ...state.worktreeChats,
          [wtKey]: {
            ...wc,
            tabs: updatedTabs,
            activeTabId: event.activateTab ? event.chatId : wc.activeTabId,
          },
        },
      };
    });

    if (hookLease && hookLeaseIssued) {
      scheduleSendingLeaseExpiry(wtKey, event.chatId, hookLease);
    }

    if (insertedIntoLoadedWorktree) {
      // For queued placeholders, skip the save and the discovery request:
      // the placeholder is transient until the matching start event arrives,
      // and `toPersistedTabs` keeps it out of disk regardless. Discovery is
      // deferred to the start event so an early reload does not fire a
      // discovery request against a placeholder that may be cancelled.
      if (!isQueuedPlaceholder) {
        const updated = get().worktreeChats[wtKey];
        // Opening the placeholder while it waited kept the selection local
        // (main did not know the tab yet). Now that the chat is canonical,
        // carry that selection over, or main's next refresh would snap the
        // view back to its own active tab.
        if (
          selectedPlaceholderStarted &&
          !event.activateTab &&
          updated?.activeTabId === event.chatId &&
          isScopeRevisionedLive(get(), event.projectId, event.worktreeId)
        ) {
          void get().dispatchChatCommand(
            { projectId: event.projectId, worktreeId: event.worktreeId },
            { type: 'chat.activate_tab', tabId: event.chatId },
          );
        }
        const insertedTab = updated?.tabs.find((t) => t.id === event.chatId);
        if (insertedTab && insertedTab.kind !== 'file') {
          requestTabDiscovery({
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            chatId: event.chatId,
            pluginSelections: insertedTab.pluginSelections,
            providerType: resolveDiscoveryProviderType(insertedTab),
          });
        }
      }
    } else {
      queuePendingHydrationEvent(wtKey, { kind: 'hook-started', event });
      ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
    }
  },

  handleHookQueueRemoved: (event): void => {
    const key = `${event.projectId}/${event.worktreeId}`;
    discardPendingHookPlaceholder(key, event.queueId);
    set((state) => {
      const wc = state.worktreeChats[key];
      const tab = wc?.tabs.find((candidate) => candidate.id === event.chatId);
      if (
        !wc ||
        tab?.queuedHookPlaceholder !== true ||
        !tab.queuedMessages.some(
          (message) => message.queuedHookQueueId === event.queueId,
        )
      )
        return state;
      const tabs = wc.tabs.filter((candidate) => candidate.id !== event.chatId);
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: {
            ...wc,
            tabs,
            activeTabId:
              wc.activeTabId === event.chatId
                ? (tabs[tabs.length - 1]?.id ?? '')
                : wc.activeTabId,
          },
        },
      };
    });
  },

  handleSessionImported: (event): void => {
    const wtKey = `${event.projectId}/${event.worktreeId}`;

    set((state) => {
      const wc = state.worktreeChats[wtKey];
      if (!wc || !hydratedKeys.has(wtKey)) {
        // Main persisted the imported tab before broadcasting this event. An
        // unopened worktree should hydrate from that durable copy instead of
        // manufacturing a parallel renderer-only state entry.
        return state;
      }

      const alreadyInserted = wc.tabs.some((tab) => tab.id === event.chatId);
      const tabs = alreadyInserted
        ? wc.tabs
        : relabelFileTabs([...wc.tabs, fromPersistedTab(event.tab)]);
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [wtKey]: {
            ...wc,
            tabs,
            activeTabId: event.activateTab ? event.chatId : wc.activeTabId,
          },
        },
      };
    });

    void (async (): Promise<void> => {
      const projectsStore = useProjectsStore.getState();
      const destinationExists = projectsStore.projects.some(
        (project) =>
          project.id === event.projectId &&
          project.type !== 'cowork' &&
          project.worktrees.some(
            (worktree) => worktree.id === event.worktreeId,
          ),
      );
      if (!destinationExists) {
        await projectsStore.loadProjects({ silent: true });
      }

      if (!event.activateTab) {
        // Honor the event contract: a non-activating import must not yank
        // the user away from whatever surface they are on.
        return;
      }
      if (isCoworkChatTarget(event.projectId)) {
        // Break the chatStore -> events -> standaloneChatStore -> chatStore
        // cycle while routing the imported Work Entry through Cowork's
        // canonical navigation path.
        const { useStandaloneChatStore } =
          await import('../../standaloneChatStore');
        const standaloneStore = useStandaloneChatStore.getState();
        useNavigationStore.getState().navigate('chat');
        await standaloneStore.refreshWorkEntries(event.projectId);
        await standaloneStore.openWorkEntryFromSidebar(
          event.projectId,
          event.worktreeId,
        );
        get().switchTab(event.chatId, {
          projectId: event.projectId,
          worktreeId: event.worktreeId,
        });
        return;
      }
      useNavigationStore.getState().navigate('main');
      get().selectWorktree(event.projectId, event.worktreeId);
      if (!hydratedKeys.has(wtKey)) {
        await get().loadTabsForTarget(event.projectId, event.worktreeId);
      }
      get().switchTab(event.chatId, {
        projectId: event.projectId,
        worktreeId: event.worktreeId,
      });
    })();
  },

  handleTabDescriptionUpdated: (
    projectId,
    worktreeId,
    chatId,
    description,
  ): void => {
    const key = `${projectId}/${worktreeId}`;
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;

      const updatedTabs = wc.tabs.map((tab) =>
        tab.id === chatId ? { ...tab, description } : tab,
      );
      const updated = { ...wc, tabs: updatedTabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
  },

  verifyStreamingTabs: async (): Promise<void> => {
    installRuntimeDivergenceDetectorSafely();
    const initial = get();
    const allChats = initial.worktreeChats;

    // In a revisioned-live scope canonical runtime decides, from an awaited
    // fresh read: a streaming tab, and an idle tab whose cached runtime says
    // a turn is running. Legacy scopes, Claude terminal-mode chats (main does
    // not project terminal turns) and chats main has no runtime for keep the
    // session probe below.
    const canonicalTargets: {
      key: string;
      projectId: string;
      worktreeId: string;
      chatId: string;
      runtime: ChatRuntimeState;
    }[] = [];
    const toVerify: { projectId: string; worktreeId: string; key: string }[] =
      [];
    for (const [key, wc] of Object.entries(allChats)) {
      // Key format is "projectId/worktreeId" — use indexOf to handle
      // any future key format safely
      const slashIdx = key.indexOf('/');
      const projectId = key.slice(0, slashIdx);
      const worktreeId = key.slice(slashIdx + 1);
      const canonicalScope = isScopeRevisionedLive(
        initial,
        projectId,
        worktreeId,
      );
      let legacyStreaming = false;
      for (const tab of wc.tabs) {
        const runtime = initial.runtimeByChatId[tab.id];
        if (canonicalScope && runtime && !isClaudeTerminalModeTab(tab)) {
          if (
            tab.status === 'streaming' ||
            canonicalTurnStateFor(runtime) === 'active'
          ) {
            canonicalTargets.push({
              key,
              projectId,
              worktreeId,
              chatId: tab.id,
              runtime,
            });
          }
        } else if (tab.status === 'streaming') {
          legacyStreaming = true;
        }
      }
      if (legacyStreaming) toVerify.push({ projectId, worktreeId, key });
    }

    if (toVerify.length === 0 && canonicalTargets.length === 0) return;
    const canonicalChatKeys = new Set(
      canonicalTargets.map(({ key, chatId }) => `${key}/${chatId}`),
    );

    const [results, canonicalResults] = await Promise.all([
      Promise.all(
        toVerify.map(
          async ({
            projectId,
            worktreeId,
            key,
          }): Promise<StreamingTabVerificationResult | null> => {
            try {
              const active = await chatBackendFor({
                projectId,
              }).chat.activeSessions({
                projectId,
                worktreeId,
              });
              return {
                key,
                projectId,
                worktreeId,
                activeSet: new Set(active.activeChatIds),
                sessionByChatId: new Map(
                  (active.sessions ?? []).map((s) => [s.chatId, s]),
                ),
              };
            } catch {
              return null;
            }
          },
        ),
      ),
      Promise.all(
        canonicalTargets.map(
          async ({
            key,
            projectId,
            worktreeId,
            chatId,
            runtime,
          }): Promise<CanonicalVerification> => {
            let state: CanonicalTurnState = 'unknown';
            try {
              state = (
                await confirmCanonicalTurn({ projectId, worktreeId, chatId })
              ).state;
            } catch {
              // A failed read is unknown, and unknown changes nothing.
            }
            return { key, projectId, worktreeId, chatId, runtime, state };
          },
        ),
      ),
    ]);

    let anyStillPreserved = false;
    // A dropped session or a terminal turn ends the root turn, not its
    // background children: the live-task mirror decides which stay open.
    const liveTasks = useLiveBackgroundTaskStore.getState();
    set((state) => {
      let changed = false;
      const nextChats = { ...state.worktreeChats };
      const now = Date.now();

      for (const result of canonicalResults) {
        if (result.state === 'unknown') {
          anyStillPreserved = true;
          continue;
        }
        // A runtime patch that landed during the read is newer than it, and
        // has already projected the tab.
        if (state.runtimeByChatId[result.chatId] !== result.runtime) continue;
        const wc = nextChats[result.key];
        if (!wc) continue;
        let tabsChanged = false;
        const updatedTabs = wc.tabs.map((tab) => {
          if (tab.id !== result.chatId) return tab;
          if (result.state === 'active') {
            if (tab.status === 'streaming') return tab;
            tagStatusWrite(tab.id, 'verify-streaming-tabs');
            tabsChanged = true;
            return { ...tab, status: 'streaming' as const, error: null };
          }
          if (tab.status !== 'streaming') return tab;
          tagStatusWrite(tab.id, 'verify-streaming-tabs');
          tabsChanged = true;
          const failed = result.runtime?.status === 'failed';
          return {
            ...tab,
            status: failed ? ('error' as const) : ('idle' as const),
            ...(failed
              ? { error: result.runtime?.error?.message ?? tab.error }
              : {}),
            messages: closeOpenToolUseBlocks(
              closeOpenTurnTimers(tab.messages),
              {
                liveness: selectChildToolLiveness(
                  liveTasks,
                  result.projectId,
                  result.worktreeId,
                  tab.id,
                ),
                codexRootThreadId: tab.sdkSessionId,
              },
            ),
            currentTodos: undefined,
            currentTaskTodos: undefined,
          };
        });
        if (tabsChanged) {
          changed = true;
          nextChats[result.key] = { ...wc, tabs: updatedTabs };
        }
      }

      for (const result of results) {
        if (!result) continue;
        const { key, projectId, worktreeId, activeSet, sessionByChatId } =
          result;
        const wc = nextChats[key];
        if (!wc) continue;

        let tabsChanged = false;
        const updatedTabs = wc.tabs.map((tab) => {
          if (tab.status !== 'streaming') return tab;
          if (canonicalChatKeys.has(`${key}/${tab.id}`)) return tab;
          if (activeSet.has(tab.id)) return tab;
          const runtime = state.runtimeByChatId[tab.id];
          // Canonical turn ownership outlives a worker's startup/interrupt gap.
          // Only main's terminal transition may settle an accepted live turn.
          if (
            runtime?.activeTurn &&
            ['starting', 'streaming', 'completing', 'awaiting_input'].includes(
              runtime.status,
            )
          ) {
            return tab;
          }
          // Legacy scopes only: with no canonical runtime, the reload marker
          // is the one record that the turn outlives its session gap.
          if (tab.deferredToolsReload) {
            anyStillPreserved = true;
            return tab;
          }
          if (shouldPreserveRecentStreamingActivity(tab, now)) {
            anyStillPreserved = true;
            return tab;
          }
          if (
            shouldPreserveStreamingOnRestore(
              tab,
              sessionByChatId.get(tab.id),
              now,
            )
          ) {
            anyStillPreserved = true;
            return tab;
          }
          // The session dropping out of `activeChatIds` is exactly what
          // happens the instant a tool-approval or ask-user prompt pauses
          // the turn. The backend prompt promise has no timeout (fail
          // closed by design — see docs/tool-approvals.md), so force-closing
          // here would stamp a synthetic 'Cancelled' result and permanently
          // hide the pending card. Skip the close and keep polling.
          if (
            hasPendingPromptForLiveTab(tab, {
              projectId,
              worktreeId,
              pendingQuestions: state.pendingQuestions,
              pendingApprovals: state.pendingApprovals,
            })
          ) {
            anyStillPreserved = true;
            return tab;
          }
          tabsChanged = true;
          return {
            ...tab,
            status: 'idle' as const,
            messages: closeOpenToolUseBlocks(
              closeOpenTurnTimers(tab.messages),
              {
                liveness: selectChildToolLiveness(
                  liveTasks,
                  projectId,
                  worktreeId,
                  tab.id,
                ),
                codexRootThreadId: tab.sdkSessionId,
              },
            ),
            currentTodos: undefined,
            currentTaskTodos: undefined,
          };
        });

        if (tabsChanged) {
          changed = true;
          const updated = { ...wc, tabs: updatedTabs };
          nextChats[key] = updated;
        }
      }

      return changed ? { worktreeChats: nextChats } : state;
    });

    // If any streaming tab is still being preserved by the grace window,
    // schedule another verification pass so it eventually settles once the
    // window expires or a terminal event arrives.
    if (anyStillPreserved) {
      scheduleStreamingVerification();
    }
    scheduleIdleChatUnload();
  },
});
