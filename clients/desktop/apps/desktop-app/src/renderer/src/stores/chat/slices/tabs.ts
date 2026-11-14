import { inlineFailureText } from '@/lib/inline-app-error';
import { prepareOpenCodeVisibleFork } from '@canopy/desktop-shared/lib/opencode-fork-context';
import { chatStoreApi } from '../store-ref';
import { announceFilePanelOpen } from '@/lib/panels/file-panel-open-intent';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  agentArtifactCarryIdentity,
  isSameAgentArtifactCarryReceipt,
  normalizeAgentArtifactCarryByTurn,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { refreshCarriedGitHubWorkflowRun } from '@/components/chat/agent-artifact-projection';
import { useProjectsStore } from '../../projectsStore';
import {
  APP_ADVISOR_PROJECT_ID,
  type ArchivedChatSummary,
  type ApprovalMode,
  type ApprovalRequestEvent,
  type ChatActiveSessions,
  type ChatCommand,
  type ChatModel,
  type ChatQueueUpdatedEvent,
  getExecutionHarnessForModel,
  getProviderForModel,
  isTerminalBackedInterfaceMode,
  resolveProviderModelConfig,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { resolveClaudeForkResumePoint } from '@canopy/desktop-shared/lib/claude-fork-resume-point';
import { sanitizeSystemInstructionText } from '@canopy/desktop-shared/lib/pending-system-instructions';
import { canContinueOnOtherHarness } from '@/lib/chatProviderLock';
import { normalizeChatCustomTitle } from '@/lib/chatTabLabel';
import { getProviderLabel } from '@/lib/providerLabels';
import type { ForkedPanelTabBinding } from '@canopy/desktop-shared/panels/fork-layout';
import { withWorktreeRelocationInstruction } from '@canopy/desktop-shared/lib/pending-system-instructions';
import { isWebCoreScope } from '@/lib/chat-authority';
import { isCloudTaskDeleted } from '../web-core/task-deletions';
import { flushPendingChatDraftWrites } from '@/lib/chatDraftStorage';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useNavigationStore } from '../../navigationStore';
import { useStartupResumeStore } from '../../startupResumeStore';
import { getCurrentChatPanelVisible } from '@/lib/worktree-layout-prefs';
import {
  cancelDelayedUnreadChatNotificationsForWorktree,
  getVisibleWorktreeKey,
  tabNeedsVisibleAcknowledgement,
  tabsStillNeedAttention,
} from '../notifications';
import {
  blockedPersistenceKeys,
  scheduleStreamingVerification,
} from '../persistence';
import {
  canUnloadIdleWorktreeChat,
  CHAT_HYDRATION_CONCURRENCY,
  clearWorktreeHydrationState,
  getIdleWorktreeChatCandidates,
  hydratedKeys,
  hydrationLastTouchedAt,
  type IdleWorktreeChatCandidate,
  loadingKeys,
  mergeHydratedWorktreeChatState,
  pruneUnreadWorktreeKey,
  recordWorktreeChatTouch,
  removeWorktreeRuntimeState,
  revisionedSetupPendingKeys,
  speculativeHydrationKeys,
  scheduleIdleChatUnload,
  shouldKeepWorktreeChatHydrated,
  waitForWorktreeHydration,
  pendingEagerChatCreation,
} from '../hydration';
import {
  delay,
  mapWithConcurrency,
  splitWorktreeKey,
  worktreeKey,
} from '../utils';
import {
  resolveBillingSeed,
  resolveDefaultChatInterfaceMode,
  resolveDeferredToolsAllowedDefault,
  resolveTabDefaults,
} from '../defaults';
import {
  applyResolvedApprovalModeForNewTab,
  approvalDefaultCacheKey,
} from '../approval-defaults';
import {
  billingSeedFields,
  buildClosedTabsState,
  chatTabHasConversationContent,
  cloneChatTabTranscript,
  inheritedPluginDefaultsCarry,
  createBranchTabTitle,
  createContinuedTabTitle,
  createForkTabTitle,
  emptyWorktreeChat,
  getDefaultPlugins,
  getOnlyQueuedHookPlaceholderQueueId,
  isPristineChatTab,
  isTabAiCreditsRouted,
  resolveTabProviderType,
  selectMessagesForForkOrBranch,
} from '../tab-utils';
import { createSeededTabUsage } from '@/lib/chatUsageNormalization';
import { sanitizePersistedChatMessages } from '@/lib/chatMessageSanitization';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  codexSpeedFields,
  retainedCodexSpeedFields,
  tabRequestedCodexSpeed,
} from '../codex-speed';
import {
  getFreshEnoughPluginProviderSupportIndex,
  getPluginProviderSupportLoadGeneration,
  invalidatePluginProviderSupportIndexLoad,
  pluginProviderSupportKey,
  loadPluginProviderSupportIndex,
  sanitizePluginSelectionsForProvider,
  sanitizePluginSelectionsWithCachedSupport,
} from '../plugin-provider-support';
import type { PluginProviderSupportIndex } from '../plugin-provider-support';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  fromPersistedTabs,
  relabelFileTabs,
  toPersistedTab,
} from '../persisted-tabs';
import {
  attachHostQueueSummariesFromQueueSnapshots,
  attachHostQueueMirror,
  hostQueueViewsToQueuedMessages,
} from '../queue-mirror';
import {
  derivePendingQuestionUnreadState,
  hasPendingQuestionForChat,
  hydratePendingQuestionsFromFile,
  removePendingQuestionsForChats,
} from '../pending-questions';
import {
  hydratePendingApprovalsFromFile,
  closeTimersForRemovedApprovals,
  reconcileLivePendingApprovals,
  removePendingApprovalsForChats,
} from '../pending-approvals';
import { pendingApprovalModeTransitions } from './approvals';
import {
  NO_ATTENTION_LANDING,
  resolveAttentionLanding,
  type AttentionLanding,
} from '../attention-landing';
import {
  beginWorktreeEntry,
  cancelWorktreeEntry,
  getWorktreeEntry,
  isCurrentWorktreeEntry,
  hasPendingAttentionLanding,
  recordExplicitEntryTab,
  settleWorktreeEntry,
  preservesLandedAttention,
  type WorktreeEntryIntent,
} from '../attention-landing-intent';
import { restoreStreamingTabs } from '../session-restore';
import {
  getChatTabCloseBlocker,
  notifyCloseBlocked,
  type ChatCloseBlocker,
} from '../close-guard';
import { useActivityStore } from '../../activityStore';
import { useOllamaConnectionBannerStore } from '../../ollamaConnectionBannerStore';
import { markWorktreeDiffStatsActivity } from '../../projectsStore.diffStatsRuntime';
import {
  requestTabDiscovery,
  resolveDiscoveryProviderType,
  scheduleEmptyTabPluginSelectionSanitization,
  shouldRequestVisibleTabDiscovery,
} from '../discovery';
import { appendNewTab, applyFallbackWorktreeChatState } from '../tab-lifecycle';
import {
  pendingTabCreation,
  registerPendingTabCreation,
} from '../pending-tab-creation';
import {
  beginPendingWorktreeTabFork,
  isWorktreeTabForkPending,
} from '../pending-worktree-tab-forks';
import {
  isAppAdvisorChatTarget,
  isPipelineEditorChatTarget,
  isSentinelWriteAllowed,
  shouldArchiveChatTargetOnClose,
  withRequiredPipelineEditorSkill,
  withRequiredPluginSelectionsForTarget,
} from '../surface';
import {
  hasPendingTrackedPlanReview,
  triggerPlanDetectionScan,
} from '../plan-utils';
import {
  type ChatActionTarget,
  type ChatMessage,
  type ChatTab,
  type HydratedWorktreeTabsResult,
  type WorktreeChatState,
} from '../types';
import {
  clearChatScrollPosition,
  clearEditorScrollPosition,
  clearFileViewerScrollPosition,
} from '@/lib/tab-scroll-positions';
import {
  closeOpenTurnTimers,
  settleForkSnapshotMessages,
} from '../event-transforms';
import { nextMsgId, nextTabId } from '../ids';
import {
  buildBranchChatNamingText,
  buildHandoffSummaryInput,
} from '../messages';
import {
  HANDOFF_SUMMARY_TIMEOUT_MS,
  PLUGIN_SUPPORT_INDEX_TIMEOUT_MS,
} from '../constants';
import { prepareBranchFromWorktree } from '@/lib/prepareBranchFromWorktree';
import { desktopFileSessionController } from '@/lib/file-viewer/desktop-file-session-controller';
import {
  nextFileViewModeSequence,
  rememberClosedFileViewMode,
  rememberFileViewModeChoice,
  rememberFileViewModeBeforeDiff,
  resolveNewFileTabViewMode,
} from '@/lib/file-viewer/last-view-mode';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { useFileTabUiStore } from '../../fileTabUiStore';
import { useClaudeTerminalStore } from '@/stores/claudeTerminalStore';
import { useIngestionLagStore } from '@/stores/ingestionLagStore';
import { useFileListStore } from '../../fileListStore';
import type { StateCreator } from 'zustand';
import type {
  BranchTabResult,
  ChatState,
  ChatTabsSlice,
  ContinueTabOnProviderResult,
} from '../state';
import {
  beginOptimisticActiveTabSelection,
  beginOptimisticTabClose,
  confirmOptimisticActiveTabSelection,
  confirmOptimisticTabClose,
  isScopeRevisionedLive,
  revisionedChatStateSupported,
  rollbackOptimisticActiveTabSelection,
  rollbackOptimisticTabClose,
  refreshChatScopeRevisioned,
  waitForChatScopeLive,
} from './revisioned';
import type { ChatCommandDisposition } from '../revisioned-commands';
import {
  chatBackendFor,
  chatBackends,
  ignoreUnavailable,
  isCapabilityUnavailable,
  localChatBackend,
  type ChatBackendScope,
} from '../backend';
import { chatScopeKey } from '../revisioned-sync';
import { CHAT_STATE_COMMAND_FAILED_NOTICE } from '../revisioned-copy';

/**
 * A refused archive keeps its tab open, and the chat says the change wasn't
 * saved, as a refused close command does, not only the console (CAN-6511).
 */
function chatArchiveRefusedNotice(
  state: Pick<ChatState, 'chatStateNotices'>,
  projectId: string,
  worktreeId: string,
): Pick<ChatState, 'chatStateNotices'> {
  return {
    chatStateNotices: {
      ...state.chatStateNotices,
      [chatScopeKey(projectId, worktreeId)]: {
        kind: 'command_failed',
        message: CHAT_STATE_COMMAND_FAILED_NOTICE,
      },
    },
  };
}

/**
 * Display-side enrichment after a revisioned canonical snapshot installed a
 * scope's projection: rebuild the activity sidebar model, rescan the active
 * tab for detected plans, and kick tab discovery. These derive transient
 * display data only — no persistence, no runtime inference.
 */
async function runRevisionedPostHydration(
  get: () => ChatState,
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const key = worktreeKey({ projectId, worktreeId });
  let installed = get().worktreeChats[key];
  if (!installed) return;

  // A canonical empty scope is valid persisted state, but it is not a usable
  // composer target. Materialize the renderer's starter tab through the same
  // revisioned command stream before any picker/send interaction can target
  // it. Otherwise the locally-created fallback is rejected as `not_found` and
  // the ensuing canonical refresh silently resets the user's first choice.
  if (
    installed.tabs.length === 0 ||
    installed.tabs.some((tab) => tab.pendingInitialCreation)
  ) {
    await get().ensureWorktreeHasChatTab({ projectId, worktreeId });
    installed = get().worktreeChats[key];
    if (!installed) return;
  }

  useActivityStore
    .getState()
    .reconstructFromMessages(projectId, worktreeId, installed.tabs);

  const activeTab = installed.tabs.find(
    (tab) => tab.id === installed.activeTabId,
  );
  if (!activeTab) return;
  triggerPlanDetectionScan(activeTab, projectId, worktreeId);
  if (
    shouldRequestVisibleTabDiscovery({
      chatId: activeTab.id,
      tab: activeTab,
      tabDiscoveryLoading: get().tabDiscoveryLoading,
    })
  ) {
    requestTabDiscovery({
      projectId,
      worktreeId,
      chatId: activeTab.id,
      pluginSelections:
        activeTab.pluginSelections ??
        getDefaultPlugins(projectId, worktreeId, get().worktreeDefaultPlugins),
      providerType: resolveDiscoveryProviderType(activeTab),
    });
  }
}

function createResolvedReplacementTab(
  state: ChatState,
  projectId: string,
  worktreeId: string,
  tabId: string,
): ChatTab {
  const {
    model: defaultModel,
    thinkingLevel: defaultThinking,
    modelConfig: defaultModelConfig,
  } = resolveTabDefaults(projectId, state.modelDefaults);
  const replacement = emptyWorktreeChat({
    pluginSelections: withRequiredPluginSelectionsForTarget(
      projectId,
      worktreeId,
      getDefaultPlugins(projectId, worktreeId, state.worktreeDefaultPlugins),
    ),
    model: defaultModel,
    thinkingLevel: defaultThinking,
    defaultChatInterfaceMode: resolveDefaultChatInterfaceMode(
      projectId,
      state.modelDefaults,
    ),
    modelConfig: defaultModelConfig,
    deferredToolsAllowed: resolveDeferredToolsAllowedDefault(
      projectId,
      worktreeId,
      state.deferredToolsDefaults,
    ),
    billingSeed: resolveBillingSeed(state.modelDefaults, projectId),
    ...newChatPluginDefaultsStamp(projectId),
  }).tabs[0];
  if (!replacement) {
    throw new Error('Expected a resolved replacement chat tab');
  }
  return { ...replacement, id: tabId };
}

async function createPersistedReplacementTab(
  state: ChatState,
  projectId: string,
  worktreeId: string,
  tabId: string,
): Promise<ChatTab> {
  const approvalMode: ApprovalMode = await state.fetchApprovalDefault(
    projectId,
    worktreeId,
    { forceFresh: true },
  );
  return {
    ...createResolvedReplacementTab(state, projectId, worktreeId, tabId),
    approvalMode,
  };
}

/**
 * Remembers the last non-diff view mode of file tabs whose close succeeded.
 * Covers tabs that were initialized or restored without a toggle; `sequence`
 * is stamped when the close began so it never overwrites a newer choice.
 */
function rememberClosedFileTabViewModes(
  projectId: string,
  worktreeId: string,
  closedTabs: readonly ChatTab[],
  sequence: number,
): void {
  for (const closed of closedTabs) {
    if (closed.kind !== 'file') continue;
    rememberClosedFileViewMode(
      { projectId, worktreeId, absolutePath: closed.filePath },
      closed.fileViewMode,
      { sequence, tabId: closed.id },
    );
  }
}

/**
 * Commits a new file tab that the caller has already made the optimistic
 * active tab under `activationToken`. Creation is a newer selection too, so
 * older activation commits still crossing from main (such as the click on the
 * tab whose embedded tree opened this file) must not pull focus away before
 * the creation commits. The selection is released if the creation does not
 * commit.
 */
function dispatchFileTabCreation(
  get: () => ChatState,
  scope: { projectId: string; worktreeId: string },
  command: Extract<ChatCommand, { type: 'chat.create_file_tab' }>,
  activationToken: number,
): Promise<ChatCommandDisposition> {
  const { projectId, worktreeId } = scope;
  const release = (): void =>
    rollbackOptimisticActiveTabSelection(
      projectId,
      worktreeId,
      activationToken,
    );
  const creation = get().dispatchChatCommand(
    { projectId, worktreeId },
    command,
    {
      reconcile: (result): void =>
        confirmOptimisticActiveTabSelection(
          projectId,
          worktreeId,
          activationToken,
          result.revision,
        ),
      rollback: release,
    },
  );
  void creation.then((disposition) => {
    if (disposition !== 'accepted') release();
  });
  return creation;
}

function replacementTabCommand(
  tab: ChatTab,
): Extract<ChatCommand, { type: 'chat.create_tab' }> {
  return {
    type: 'chat.create_tab',
    tabId: tab.id,
    title: tab.title,
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(tab.model ? { model: tab.model } : {}),
    ...(tab.modelConfig ? { modelConfig: tab.modelConfig } : {}),
    ...(tab.planMode ? { planMode: true } : {}),
    ...(tab.proposalMode ? { proposalMode: tab.proposalMode } : {}),
    ...(tab.pluginSelections ? { pluginSelections: tab.pluginSelections } : {}),
    ...(typeof tab.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: tab.deferredToolsAllowed }
      : {}),
    ...(tab.interfaceMode ? { interfaceMode: tab.interfaceMode } : {}),
    ...(tab.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
    ...(tab.approvalMode ? { approvalMode: tab.approvalMode } : {}),
    ...(tab.aiCreditsRouting ? { aiCreditsRouting: tab.aiCreditsRouting } : {}),
    ...(typeof tab.subscriptionBillingOverride === 'boolean'
      ? { subscriptionBillingOverride: tab.subscriptionBillingOverride }
      : {}),
  };
}

/** One scope's live approval requests, or every backend's without a scope. */
const loadActiveApprovalRequests = async (
  scope?: ChatBackendScope,
): Promise<ApprovalRequestEvent[] | undefined> => {
  const backends =
    scope === undefined ? chatBackends() : [chatBackendFor(scope)];
  const lists = await Promise.all(
    backends.map(
      (backend) =>
        backend.approvals.pendingRequests?.().catch(() => undefined) ??
        Promise.resolve(undefined),
    ),
  );
  return lists.some((list) => list === undefined)
    ? undefined
    : lists.flatMap((list) => list ?? []);
};

function recoverRevisionedPendingApprovals(
  state: ChatState,
  activeApprovalRequests: readonly ApprovalRequestEvent[] | undefined,
  projectId: string,
  worktreeId: string,
): Partial<ChatState> {
  const key = `${projectId}/${worktreeId}`;
  const chatState = state.worktreeChats[key];
  if (!chatState || !activeApprovalRequests) return {};
  const live = reconcileLivePendingApprovals(
    {},
    activeApprovalRequests,
    projectId,
    worktreeId,
    chatState,
  ).pendingApprovals;
  return {
    // The approval event listener is installed by the app before hydration.
    // Recover the main-owned snapshot so requests surviving a reload return,
    // then retain any newer listener event received while it was in flight.
    pendingApprovals: { ...live, ...state.pendingApprovals },
  };
}

/**
 * The activation-only part of selecting a tab: the active id plus the
 * last-editable-chat and last-provider metadata. Read and attention state are
 * left alone, so an automatic landing never acknowledges anything itself.
 */
function activateTabInChatState(
  wc: WorktreeChatState,
  tabId: string,
): WorktreeChatState {
  const targetTab = wc.tabs.find((t) => t.id === tabId);
  const currentActiveTab = wc.tabs.find((t) => t.id === wc.activeTabId);
  const lastActiveEditableChatId =
    targetTab && targetTab.kind !== 'file' && !targetTab.readOnly
      ? targetTab.id
      : currentActiveTab &&
          currentActiveTab.kind !== 'file' &&
          !currentActiveTab.readOnly
        ? currentActiveTab.id
        : wc.lastActiveEditableChatId;
  const lastActiveChatProvider =
    resolveTabProviderType(targetTab) ??
    resolveTabProviderType(currentActiveTab) ??
    wc.lastActiveChatProvider;
  return {
    ...wc,
    activeTabId: tabId,
    ...(lastActiveEditableChatId ? { lastActiveEditableChatId } : {}),
    ...(lastActiveChatProvider ? { lastActiveChatProvider } : {}),
  };
}

/**
 * Submits a tab activation to main for a revisioned scope, behind the
 * optimistic-selection token, so a late result or rollback never overwrites a
 * newer selection.
 */
function dispatchRevisionedTabActivation(
  get: () => ChatState,
  sel: WorktreeSelection,
  tabId: string,
): Promise<void> {
  const activationToken = beginOptimisticActiveTabSelection(
    sel.projectId,
    sel.worktreeId,
    tabId,
  );
  return get()
    .dispatchChatCommand(
      sel,
      {
        type: 'chat.activate_tab',
        tabId,
      },
      {
        rollback: (): void =>
          rollbackOptimisticActiveTabSelection(
            sel.projectId,
            sel.worktreeId,
            activationToken,
          ),
        reconcile: (result): void =>
          confirmOptimisticActiveTabSelection(
            sel.projectId,
            sel.worktreeId,
            activationToken,
            result.revision,
          ),
      },
    )
    .then((disposition) => {
      if (disposition !== 'accepted') {
        rollbackOptimisticActiveTabSelection(
          sel.projectId,
          sel.worktreeId,
          activationToken,
        );
      }
    });
}

/** Where an implicit entry should land in `wc`; see {@link AttentionLanding}. */
function attentionLandingTarget(
  state: ChatState,
  projectId: string,
  worktreeId: string,
  wc: WorktreeChatState,
  pending: Pick<ChatState, 'pendingQuestions' | 'pendingApprovals'> = state,
): AttentionLanding {
  return resolveAttentionLanding({
    projectId,
    worktreeId,
    tabs: wc.tabs,
    activeTabId: wc.activeTabId,
    hiddenChatTabIds: state.hiddenChatTabIds,
    pendingQuestions: pending.pendingQuestions,
    pendingApprovals: pending.pendingApprovals,
    pendingPlanExits: state.pendingPlanExits,
  });
}

/**
 * Whether the pending landing belongs to `key` and still applies: the user
 * is on that worktree and has not chosen a tab since entering it.
 */
function takesPendingAttentionLanding(
  state: ChatState,
  key: string,
  intent: WorktreeEntryIntent | null,
): intent is WorktreeEntryIntent {
  return (
    isCurrentWorktreeEntry(intent) &&
    intent.key === key &&
    state.selectedWorktree !== null &&
    worktreeKey(state.selectedWorktree) === key
  );
}

/**
 * Applies a pending landing once a loader has the scope's tabs and pending
 * attention: activation only, then the existing visible acknowledgement,
 * which now targets the landed tab.
 */
function applyPendingAttentionLanding(
  get: () => ChatState,
  set: (update: (state: ChatState) => Partial<ChatState>) => void,
  projectId: string,
  worktreeId: string,
  intent: WorktreeEntryIntent | null,
): void {
  const key = worktreeKey({ projectId, worktreeId });
  if (!takesPendingAttentionLanding(get(), key, intent)) return;
  let landedTabId: string | null = null;
  set((state) => {
    const wc = state.worktreeChats[key];
    if (!wc) return {};
    const landing: AttentionLanding =
      intent.explicitTabId !== undefined
        ? {
            tabId: wc.tabs.some((tab) => tab.id === intent.explicitTabId)
              ? intent.explicitTabId
              : null,
            attended: false,
          }
        : intent.attentionLanding
          ? attentionLandingTarget(state, projectId, worktreeId, wc)
          : NO_ATTENTION_LANDING;
    landedTabId = landing.tabId;
    settleWorktreeEntry(intent, wc.activeTabId, landing);
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [key]:
          landedTabId === null ? wc : activateTabInChatState(wc, landedTabId),
      },
    };
  });
  if (
    landedTabId !== null &&
    isScopeRevisionedLive(get(), projectId, worktreeId)
  ) {
    void dispatchRevisionedTabActivation(
      get,
      { projectId, worktreeId },
      landedTabId,
    );
  }
  get().acknowledgeSelectedWorktreeAttention();
}

/** A loader's one-time setup after a revisioned install: display enrichment,
 * then the main-owned approvals that survived a reload. */
async function finishRevisionedHydration(
  get: () => ChatState,
  set: (update: (state: ChatState) => Partial<ChatState>) => void,
  projectId: string,
  worktreeId: string,
  approvals:
    | readonly ApprovalRequestEvent[]
    | undefined
    | Promise<ApprovalRequestEvent[] | undefined>,
): Promise<void> {
  const key = worktreeKey({ projectId, worktreeId });
  revisionedSetupPendingKeys.delete(key);
  // A real load: a prefetched scope gets its starter chat now.
  speculativeHydrationKeys.delete(key);
  await runRevisionedPostHydration(get, projectId, worktreeId);
  const activeApprovalRequests = await approvals;
  set((state) =>
    recoverRevisionedPendingApprovals(
      state,
      activeApprovalRequests,
      projectId,
      worktreeId,
    ),
  );
}

function resolveTabExecutionHarness(
  tab: ChatTab,
): 'claude' | 'codex' | 'cursor' | 'copilot' | 'antigravity' | 'opencode' {
  return (
    tab.executionHarness ??
    (tab.model ? getExecutionHarnessForModel(tab.model) : undefined) ??
    (resolveTabProviderType(tab) === 'codex' ? 'codex' : 'claude')
  );
}

/**
 * Bound an await that runs while the continue confirm dialog is busy.
 *
 * `ConfirmDialog` disables Cancel, Escape and backdrop dismissal while busy, and
 * neither the summary helper nor the marketplace bridge exposes an abort signal,
 * so an unbounded await is a dialog the user cannot escape without killing the
 * window. A timeout converts that hang into an ordinary failure the dialog can
 * render, and the store creates no tab on failure so there is nothing to roll
 * back.
 *
 * The orphaned work is ABANDONED, not cancelled — an important distinction. Its
 * result is discarded, so it cannot corrupt state, and the plugin-index step
 * additionally retires its request so a retry is not handed the same dead
 * promise. But the summary helper keeps running: it holds no abort signal, so a
 * timeout followed by a retry can leave more than one model job in flight, each
 * still consuming resources and billable usage until it finishes on its own.
 * Cancelling for real needs an abort seam threaded through
 * `generateHandoffSummary` -> `runWithTransientAgentRetry` ->
 * `getClaudeWorkerSessionService().runWorker()` and the `claudeQuery` path,
 * none of which have one; that is a main-process change to a shared service and
 * is tracked separately. Do not describe this as harmless.
 *
 * EVERY await reachable while the dialog is uncancellable must go through this
 * — bounding only the slowest one still leaves the others able to hang.
 */
async function withContinueStepTimeout<T>(
  promise: Promise<T>,
  timeoutMessage: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const createTabsSlice: StateCreator<ChatState, [], [], ChatTabsSlice> = (
  set,
  get,
) => ({
  selectedWorktree: null,

  selectedWorktreeBeforeStandaloneChat: null,

  worktreeChats: {},

  closingChatTabs: {},

  hiddenChatTabIds: new Set<string>(),

  setHiddenChatTabIds: (ids: ReadonlySet<string>): void => {
    set((state) => {
      const current = state.hiddenChatTabIds;
      if (
        current.size === ids.size &&
        Array.from(ids).every((id) => current.has(id))
      ) {
        return state;
      }
      return { hiddenChatTabIds: new Set(ids) };
    });
  },

  recordAgentArtifactCarry: (target, userMessageId, receipts): void => {
    if (receipts.length === 0) return;
    const key = `${target.projectId}/${target.worktreeId}`;
    let nextCarry: ChatTab['agentArtifactCarryByTurn'];
    set((state) => {
      const current = state.worktreeChats[key];
      if (!current) return state;
      let changed = false;
      const tabs = current.tabs.map((tab) => {
        if (tab.id !== target.chatId || tab.kind === 'file') return tab;
        const validOwner = tab.messages.some(
          (message) => message.role === 'user' && message.id === userMessageId,
        );
        if (!validOwner) return tab;
        const existing = tab.agentArtifactCarryByTurn?.[userMessageId] ?? [];
        const byIdentity = new Map(
          existing.map((receipt) => [
            agentArtifactCarryIdentity(receipt),
            receipt,
          ]),
        );
        for (const receipt of receipts) {
          const identity = agentArtifactCarryIdentity(receipt);
          const currentReceipt = byIdentity.get(identity);
          if (
            currentReceipt &&
            isSameAgentArtifactCarryReceipt(currentReceipt, receipt)
          ) {
            continue;
          }
          byIdentity.set(identity, receipt);
        }
        // Other turns carrying the same GitHub run follow it to the newest
        // snapshot, so each turn's persisted card reaches the final state.
        const mergedCarry = Object.fromEntries(
          Object.entries({
            ...(tab.agentArtifactCarryByTurn ?? {}),
            [userMessageId]: Array.from(byIdentity.values()),
          }).map(([turnId, turnReceipts]) => [
            turnId,
            turnId === userMessageId
              ? turnReceipts
              : turnReceipts.map((carried) =>
                  refreshCarriedGitHubWorkflowRun(carried, receipts),
                ),
          ]),
        );
        const owningUserMessageIds = new Set(
          tab.messages
            .filter((message) => message.role === 'user')
            .map((message) => message.id),
        );
        const compactedCarry = normalizeAgentArtifactCarryByTurn(
          mergedCarry,
          owningUserMessageIds,
        );
        if (
          !compactedCarry ||
          JSON.stringify(compactedCarry) ===
            JSON.stringify(tab.agentArtifactCarryByTurn)
        ) {
          return tab;
        }
        changed = true;
        nextCarry = compactedCarry;
        return {
          ...tab,
          agentArtifactCarryByTurn: nextCarry,
        };
      });
      if (!changed) return state;
      const updated = { ...current, tabs };
      return { worktreeChats: { ...state.worktreeChats, [key]: updated } };
    });
    if (!nextCarry) return;
    if (isScopeRevisionedLive(get(), target.projectId, target.worktreeId)) {
      void get().dispatchChatCommand(
        { projectId: target.projectId, worktreeId: target.worktreeId },
        {
          type: 'chat.patch_tab_settings',
          tabId: target.chatId,
          patch: { agentArtifactCarryByTurn: nextCarry },
        },
      );
    }
  },

  selectWorktree: (projectId, worktreeId, options): void => {
    flushPendingChatDraftWrites();
    if (
      !canNavigateToWorktreeFromSidebarItems(
        useProjectsStore.getState().projects,
        projectId,
        worktreeId,
        useProjectsStore.getState().hasHydratedProjects,
      )
    ) {
      return;
    }

    const key = `${projectId}/${worktreeId}`;
    markWorktreeDiffStatsActivity(projectId, worktreeId);

    // Navigating into any workspace/worktree/chat retires the startup Resume
    // offer — every such navigation (sidebar/kanban clicks, cowork chat
    // activation via switchChatProject, Home sends, notification deep links)
    // funnels through this action. Other-page navigation (Settings,
    // Pipelines, …) intentionally never clears it.
    useStartupResumeStore.getState().clearOffer();

    // Request a scroll-into-view only when the selection actually changes,
    // so re-selecting the current worktree (or chat-store internals re-
    // calling this) doesn't disturb manual scroll position. The pending-
    // scroll consumer uses `nearest`, so already-visible cards are no-ops.
    const previous = get().selectedWorktree;
    const isNewSelection =
      !previous ||
      previous.projectId !== projectId ||
      previous.worktreeId !== worktreeId;
    if (isNewSelection) {
      useProjectsStore
        .getState()
        .requestScrollToWorktree(projectId, worktreeId);
    }

    // Track the most recent non-cowork selection so StandaloneChatPage can
    // restore it on unmount even when its mount-time capture happens after
    // selectedWorktree has already been overwritten (e.g. the failed-pipeline
    // Debug button creates a standalone chat — and thus calls selectWorktree
    // with a cowork chat target — before navigating to the chat page).
    const nextBefore: WorktreeSelection | null = isCoworkChatTarget(projectId)
      ? previous && !isCoworkChatTarget(previous.projectId)
        ? previous
        : get().selectedWorktreeBeforeStandaloneChat
      : null;

    if (isNewSelection) {
      beginWorktreeEntry(
        key,
        options?.attentionLanding === true &&
          options.newlyCreated !== true &&
          !isAppAdvisorChatTarget(projectId, worktreeId) &&
          !isPipelineEditorChatTarget(projectId, worktreeId),
      );
    }
    const entryIntent = getWorktreeEntry(key);
    const landsNow =
      isCurrentWorktreeEntry(entryIntent) &&
      get().worktreeChats[key] !== undefined &&
      hydratedKeys.has(key) &&
      !loadingKeys.has(key) &&
      !revisionedSetupPendingKeys.has(key);

    let acknowledgedChatId: string | undefined;
    let landedTabId: string | null = null;
    set((state) => {
      const beforeUpdate =
        nextBefore !== state.selectedWorktreeBeforeStandaloneChat
          ? { selectedWorktreeBeforeStandaloneChat: nextBefore }
          : {};

      const selectedWc = state.worktreeChats[key];
      if (!selectedWc) {
        return {
          selectedWorktree: { projectId, worktreeId },
          ...beforeUpdate,
        };
      }
      const landing =
        landsNow && entryIntent?.attentionLanding === true
          ? attentionLandingTarget(state, projectId, worktreeId, selectedWc)
          : NO_ATTENTION_LANDING;
      landedTabId = landing.tabId;
      if (landsNow && entryIntent !== null) {
        settleWorktreeEntry(entryIntent, selectedWc.activeTabId, landing);
      }
      const wc =
        landedTabId === null
          ? selectedWc
          : activateTabInChatState(selectedWc, landedTabId);

      const canMarkRead =
        !hasPendingAttentionLanding(key) &&
        useNavigationStore.getState().activePage === 'main' &&
        getCurrentChatPanelVisible() &&
        !isCoworkChatTarget(projectId);

      // Clear unread and stamp attentionDismissedAt on the active tab when
      // the chat page is visible — viewing the chat counts as acknowledging
      // any overview unread signal (including lingering plan reviews and
      // stale-session banners that survive across restarts via persistence).
      const activeTab = wc.tabs.find((t) => t.id === wc.activeTabId);
      const activeTabVisible =
        activeTab !== undefined && !state.hiddenChatTabIds.has(activeTab.id);
      const needsTabClear =
        canMarkRead &&
        activeTabVisible &&
        tabNeedsVisibleAcknowledgement(activeTab);
      if (needsTabClear) acknowledgedChatId = activeTab.id;

      const dismissedAt = Date.now();
      const tabs = needsTabClear
        ? wc.tabs.map((t) =>
            t.id === wc.activeTabId
              ? {
                  ...t,
                  unread: false,
                  ...(preservesLandedAttention(key, t.id)
                    ? {}
                    : { attentionDismissedAt: dismissedAt }),
                }
              : t,
          )
        : wc.tabs;
      const updated = needsTabClear ? { ...wc, tabs } : wc;

      // Recompute worktree-level unread when selecting a visible worktree.
      // The key may have been added by handlePlanExitRequest or
      // loadAllWorktreeTabs (via pendingPlanExit) without any tab having
      // unread === true, so the old early-return skipped this cleanup.
      const stillNeedsAttention = tabsStillNeedAttention(updated.tabs);
      const nextUnread =
        canMarkRead && !stillNeedsAttention && state.unreadWorktreeKeys.has(key)
          ? new Set(
              Array.from(state.unreadWorktreeKeys).filter((k) => k !== key),
            )
          : state.unreadWorktreeKeys;

      if (
        !needsTabClear &&
        landedTabId === null &&
        nextUnread === state.unreadWorktreeKeys
      ) {
        return {
          selectedWorktree: { projectId, worktreeId },
          ...beforeUpdate,
        };
      }

      return {
        selectedWorktree: { projectId, worktreeId },
        ...(needsTabClear || landedTabId !== null
          ? { worktreeChats: { ...state.worktreeChats, [key]: updated } }
          : {}),
        unreadWorktreeKeys: nextUnread,
        ...beforeUpdate,
      };
    });

    // Landing only activates; it never dismisses attention. Read and
    // attention patches for the landed tab come from the visible
    // acknowledgement below, as for any restored tab.
    if (
      landedTabId !== null &&
      isScopeRevisionedLive(get(), projectId, worktreeId)
    ) {
      void dispatchRevisionedTabActivation(
        get,
        { projectId, worktreeId },
        landedTabId,
      );
    }

    if (
      acknowledgedChatId &&
      isScopeRevisionedLive(get(), projectId, worktreeId)
    ) {
      void Promise.all([
        get().dispatchChatCommand(
          { projectId, worktreeId },
          { type: 'chat.mark_read', chatId: acknowledgedChatId },
        ),
        ...(preservesLandedAttention(key, acknowledgedChatId)
          ? []
          : [
              get().dispatchChatCommand(
                { projectId, worktreeId },
                { type: 'chat.dismiss_attention', chatId: acknowledgedChatId },
              ),
            ]),
      ]);
    }

    recordWorktreeChatTouch(key);
    scheduleIdleChatUnload();

    // Warm the resolved approval-mode default cache for this project so
    // chats that predate this feature (whose tabs have no explicit
    // `approvalMode`) don't show the unresolved fallback until the user happens
    // to open a brand-new tab. Only fetch when nothing is cached yet, and
    // never overwrite a previously resolved value with a failure.
    const approvalCacheKey = approvalDefaultCacheKey(projectId, worktreeId);
    if (!(approvalCacheKey in get().approvalDefaultsCache)) {
      void get().fetchApprovalDefault(projectId, worktreeId);
    }

    // A reservation returned by creation is known new. Resolve the real defaults
    // alongside hydration and expose its editable starter without waiting for
    // the history snapshot. Existing worktrees never take this path.
    if (options?.newlyCreated) {
      void Promise.all([
        get().ensureModelDefaultsLoaded(),
        get().fetchApprovalDefault(projectId, worktreeId, { forceFresh: true }),
      ])
        .then(([, approvalMode]) =>
          get().ensureWorktreeHasChatTab(
            { projectId, worktreeId },
            { eager: true, approvalMode },
          ),
        )
        .catch(() => {
          // The normal hydration path owns recovery and its retry surface.
        });
    }

    // New-worktree Home sends hydrate with setup-aware options immediately
    // after selection; avoid racing that targeted load with the generic one.
    if (options?.deferTabLoad !== true) {
      void get().loadTabs();
    }
    if (isCoworkChatTarget(projectId)) {
      void window.api.github.setForegroundWorktree({
        projectId: null,
        worktreeId: null,
      });
    } else {
      void window.api.github.setForegroundWorktree({
        projectId,
        worktreeId,
      });
      void window.api.github.requestFastRefresh({
        projectId,
        worktreeId,
        skipIfFresh: false,
      });
    }
    // Persist last selected worktree so it can be restored on restart. Also
    // write the unified lastActiveContext MRU used for startup routing.
    // App Advisor selections are EXCLUDED: the popout window selects
    // `(app-advisor, <entryId>)` through this same path, and writing that
    // into the main-window MRU would corrupt startup routing (there is no
    // `app-advisor` sidebar workspace to resume into). Web core selections
    // are excluded too: startup restores before the cloud connects, and main
    // never holds a web core id (CAN-6175 D1).
    if (
      !isAppAdvisorChatTarget(projectId, worktreeId) &&
      !isWebCoreScope(projectId)
    ) {
      void window.api.savePreferences({
        lastSelectedWorktreeProjectId: projectId,
        lastSelectedWorktreeId: worktreeId,
        lastActiveContext: isCoworkChatTarget(projectId)
          ? { kind: 'cowork', workspaceId: projectId, workEntryId: worktreeId }
          : { kind: 'worktree', workspaceId: projectId, worktreeId },
      });
    }
  },

  deselectWorktree: (): void => {
    cancelWorktreeEntry();
    set({ selectedWorktree: null });
    scheduleIdleChatUnload();
    void window.api.github.setForegroundWorktree({
      projectId: null,
      worktreeId: null,
    });
  },

  loadTabs: async (): Promise<void> => {
    const sel = get().selectedWorktree;
    if (!sel) return;

    const key = worktreeKey(sel);
    const entryIntent = getWorktreeEntry(key);

    // A background canonical hydration may have installed an intentionally
    // empty scope before the user selected it. The normal hydrated-key fast
    // path must still materialize a durable starter tab for that foreground
    // composer; otherwise its first settings command targets only a local
    // fallback and is rejected as `not_found`.
    if (loadingKeys.has(key)) {
      // A caller awaiting this load may immediately create/send a chat. Join
      // the complete load, including starter creation, even when a large
      // migration takes longer than the best-effort background wait budget.
      await waitForWorktreeHydration(key, Number.POSITIVE_INFINITY);
      // A background load installed the scope, so an entry that arrived
      // while it ran lands here.
      applyPendingAttentionLanding(
        get,
        set,
        sel.projectId,
        sel.worktreeId,
        entryIntent,
      );
      return;
    }
    if (hydratedKeys.has(key)) {
      if (
        get().worktreeChats[key] &&
        isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)
      ) {
        loadingKeys.add(key);
        try {
          if (revisionedSetupPendingKeys.has(key)) {
            await finishRevisionedHydration(
              get,
              set,
              sel.projectId,
              sel.worktreeId,
              loadActiveApprovalRequests(sel),
            );
            applyPendingAttentionLanding(
              get,
              set,
              sel.projectId,
              sel.worktreeId,
              entryIntent,
            );
          } else {
            // `ensureWorktreeHasChatTab` is idempotent for an already-canonical
            // tab. Calling it also covers a local starter that another startup
            // surface inserted after the empty snapshot landed; the setup above
            // already ensures it.
            await get().ensureWorktreeHasChatTab(sel, {
              preserveActiveTab: true,
            });
          }
        } finally {
          loadingKeys.delete(key);
        }
      }
      return;
    }
    loadingKeys.add(key);

    try {
      const activeApprovalRequestsPromise = loadActiveApprovalRequests(sel);
      // Prefer the main-owned revisioned snapshot/delta stream. Only when the
      // main process does not expose the revisioned chat service does the
      // legacy load-merge-save hydration below run.
      if (revisionedChatStateSupported()) {
        const revisioned = await get().hydrateChatScopeRevisioned(
          sel.projectId,
          sel.worktreeId,
        );
        if (revisioned !== 'unavailable') {
          if (revisioned === 'installed') {
            await finishRevisionedHydration(
              get,
              set,
              sel.projectId,
              sel.worktreeId,
              activeApprovalRequestsPromise,
            );
            applyPendingAttentionLanding(
              get,
              set,
              sel.projectId,
              sel.worktreeId,
              entryIntent,
            );
          }
          // 'failed' keeps the load-error treatment visible; never fall back
          // to a blank starter chat for a scope main owns.
          return;
        }
      }

      const modelDefaults = await get().ensureModelDefaultsLoaded();

      const [file, active, queueSnapshots, activeApprovalRequests] =
        await Promise.all([
          chatBackendFor(sel).chat.loadTabs({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            ...(isSentinelWriteAllowed(sel.projectId, sel.worktreeId)
              ? { establishRendererMergeBase: true }
              : {}),
          }),
          chatBackendFor(sel).chat.activeSessions({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
          }),
          chatBackendFor(sel).chat.getChatQueueSnapshot
            ? chatBackendFor(sel).chat.getChatQueueSnapshot({
                projectId: sel.projectId,
                worktreeId: sel.worktreeId,
              })
            : Promise.resolve<ChatQueueUpdatedEvent[]>([]),
          activeApprovalRequestsPromise,
        ]);
      const queuedByChatId = new Map(
        queueSnapshots.map((snapshot) => [
          snapshot.chatId,
          hostQueueViewsToQueuedMessages(snapshot.queue),
        ]),
      );

      const {
        model: defaultModel,
        providerType: configuredDefaultProviderType,
        thinkingLevel: defaultThinking,
        modelConfig: defaultModelConfig,
      } = resolveTabDefaults(sel.projectId, modelDefaults);
      const rawDefaultPluginSelections = getDefaultPlugins(
        sel.projectId,
        sel.worktreeId,
        get().worktreeDefaultPlugins,
      );
      const defaultProviderType = defaultModel
        ? (getProviderForModel(defaultModel) ?? configuredDefaultProviderType)
        : configuredDefaultProviderType;
      // Sanitize default plugin selections with the cached support index only:
      // hydration must never await the marketplace-backed index load, which
      // goes through provider marketplaces and can stall for a long time when
      // a provider backend (e.g. the Codex app-server) is unhealthy. A fresh
      // default tab is re-sanitized below via
      // scheduleEmptyTabPluginSelectionSanitization once the index loads.
      const defaultPluginSelections = sanitizePluginSelectionsWithCachedSupport(
        rawDefaultPluginSelections,
        defaultProviderType,
      );
      const chatState = fromPersistedTabs(
        file,
        defaultPluginSelections,
        defaultModel,
        defaultThinking,
        resolveDefaultChatInterfaceMode(sel.projectId, modelDefaults),
        defaultModelConfig,
        resolveDeferredToolsAllowedDefault(
          sel.projectId,
          sel.worktreeId,
          get().deferredToolsDefaults,
        ),
        resolveBillingSeed(modelDefaults, sel.projectId),
        defaultProviderType,
        true,
        newChatPluginDefaultsStamp(sel.projectId),
      );

      // Restore streaming status for tabs with active main-process sessions.
      // When the tab is not in `activeChatIds` but a matching session still
      // shows recent nonterminal activity, preserve `streaming` for a short
      // grace window so a just-crashed tab is not stamped Completed before
      // the main-process session settles.
      const hydratedPendingQuestions = hydratePendingQuestionsFromFile(
        file,
        sel.projectId,
        sel.worktreeId,
        chatState,
      );
      const persistedPendingApprovals = hydratePendingApprovalsFromFile(
        file,
        sel.projectId,
        sel.worktreeId,
        chatState,
      );
      const liveApprovalState = activeApprovalRequests
        ? reconcileLivePendingApprovals(
            persistedPendingApprovals,
            activeApprovalRequests,
            sel.projectId,
            sel.worktreeId,
            chatState,
          )
        : {
            pendingApprovals: persistedPendingApprovals,
            removedStaleApprovals: false,
          };
      const hydratedPendingApprovals = liveApprovalState.pendingApprovals;
      const { removedStaleApprovals } = liveApprovalState;
      if (removedStaleApprovals) {
        chatState.tabs = closeTimersForRemovedApprovals(
          chatState.tabs,
          persistedPendingApprovals,
          hydratedPendingApprovals,
        );
      }
      const restored = restoreStreamingTabs(
        chatState.tabs,
        active,
        Date.now(),
        {
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          pendingQuestions: hydratedPendingQuestions,
          pendingApprovals: hydratedPendingApprovals,
        },
      );
      chatState.tabs = restored.tabs;
      const preservedAnyOnRestore = restored.preservedAnyOnRestore;

      const mergedChatState = mergeHydratedWorktreeChatState(
        chatState,
        get().worktreeChats[key],
        file.tabs.length === 0,
      );
      mergedChatState.chatState.tabs = attachHostQueueMirror(
        mergedChatState.chatState.tabs,
        queuedByChatId,
      );
      mergedChatState.chatState.tabs =
        attachHostQueueSummariesFromQueueSnapshots(
          mergedChatState.chatState.tabs,
          queueSnapshots,
        );
      hydratedKeys.add(key);
      recordWorktreeChatTouch(key);

      let landedTabId: string | null = null;
      let settledEntry = false;
      set((state) => {
        const nextPendingQuestions = {
          ...state.pendingQuestions,
          ...hydratedPendingQuestions,
        };
        const nextPendingApprovals = {
          ...state.pendingApprovals,
          ...hydratedPendingApprovals,
        };
        // Land before the visible tab is derived, so the landed tab is the
        // one treated as seen, never the stale persisted one.
        if (takesPendingAttentionLanding(state, key, entryIntent)) {
          settledEntry = true;
          const landing: AttentionLanding =
            entryIntent.explicitTabId !== undefined
              ? {
                  tabId: mergedChatState.chatState.tabs.some(
                    (tab) => tab.id === entryIntent.explicitTabId,
                  )
                    ? entryIntent.explicitTabId
                    : null,
                  attended: false,
                }
              : entryIntent.attentionLanding
                ? attentionLandingTarget(
                    state,
                    sel.projectId,
                    sel.worktreeId,
                    mergedChatState.chatState,
                    {
                      pendingQuestions: nextPendingQuestions,
                      pendingApprovals: nextPendingApprovals,
                    },
                  )
                : NO_ATTENTION_LANDING;
          landedTabId = landing.tabId;
          settleWorktreeEntry(
            entryIntent,
            mergedChatState.chatState.activeTabId,
            landing,
          );
        }
        const installedChatState =
          landedTabId === null
            ? mergedChatState.chatState
            : activateTabInChatState(mergedChatState.chatState, landedTabId);
        const visibleKey = getVisibleWorktreeKey(state.selectedWorktree);
        const {
          chatState: chatStateWithQuestionAttention,
          hasUnreadPendingQuestion,
        } = derivePendingQuestionUnreadState(
          installedChatState,
          nextPendingQuestions,
          sel.projectId,
          sel.worktreeId,
          key === visibleKey ? installedChatState.activeTabId : undefined,
        );
        const nextUnread =
          hasUnreadPendingQuestion && !state.unreadWorktreeKeys.has(key)
            ? new Set(Array.from(state.unreadWorktreeKeys).concat(key))
            : state.unreadWorktreeKeys;

        // Hydrated live state supersedes any startup-seeded persisted badge
        // summary for this worktree.
        let nextPersistedBadges = state.persistedWorktreeBadges;
        if (nextPersistedBadges[key] !== undefined) {
          nextPersistedBadges = { ...nextPersistedBadges };
          delete nextPersistedBadges[key];
        }

        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: chatStateWithQuestionAttention,
          },
          pendingQuestions: nextPendingQuestions,
          pendingApprovals: nextPendingApprovals,
          unreadWorktreeKeys: nextUnread,
          persistedWorktreeBadges: nextPersistedBadges,
        };
      });
      if (settledEntry) {
        get().acknowledgeSelectedWorktreeAttention();
      }
      if (
        file.tabs.length === 0 &&
        mergedChatState.chatState.tabs.length === 1
      ) {
        await applyResolvedApprovalModeForNewTab(
          sel,
          mergedChatState.chatState.tabs[0].id,
          set,
          get,
        );
      }
      useActivityStore
        .getState()
        .reconstructFromMessages(
          sel.projectId,
          sel.worktreeId,
          mergedChatState.chatState.tabs,
        );

      // When no persisted tabs existed we just created a fresh default tab —
      // trigger command discovery so slash-commands are available immediately.
      if (
        file.tabs.length === 0 &&
        mergedChatState.chatState.tabs.length === 1
      ) {
        const initialTab = mergedChatState.chatState.tabs[0];
        scheduleEmptyTabPluginSelectionSanitization({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId: initialTab.id,
          providerType: resolveDiscoveryProviderType(initialTab),
        });
        requestTabDiscovery({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId: initialTab.id,
          pluginSelections: initialTab.pluginSelections,
          providerType: resolveDiscoveryProviderType(initialTab),
        });
      } else {
        const activeTab = mergedChatState.chatState.tabs.find(
          (tab) => tab.id === mergedChatState.chatState.activeTabId,
        );
        if (
          activeTab &&
          shouldRequestVisibleTabDiscovery({
            chatId: activeTab.id,
            tab: activeTab,
            tabDiscoveryLoading: get().tabDiscoveryLoading,
          })
        ) {
          requestTabDiscovery({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            chatId: activeTab.id,
            pluginSelections:
              activeTab.pluginSelections ?? defaultPluginSelections,
            providerType: resolveDiscoveryProviderType(activeTab),
          });
        }
      }

      // Re-verify after a delay to catch race conditions where a result event
      // arrived before worktreeChats was populated, and to re-evaluate any
      // tabs kept streaming by the post-crash grace window so they eventually
      // settle if the session never becomes active again.
      if (
        preservedAnyOnRestore ||
        mergedChatState.chatState.tabs.some((t) => t.status === 'streaming')
      ) {
        scheduleStreamingVerification();
      }
    } catch (error) {
      // Never leave a selected worktree without a visible chat tab: fall back
      // to an in-memory default tab and keep the key un-hydrated so the next
      // selection retries against persistence.
      await applyFallbackWorktreeChatState(sel.projectId, sel.worktreeId);
      // eslint-disable-next-line no-console
      console.error(
        `[chatStore] Failed to hydrate chat tabs for ${key}; using fallback tab`,
        error,
      );
    } finally {
      loadingKeys.delete(key);
      scheduleIdleChatUnload();
    }
  },

  loadTabsForTarget: async (projectId, worktreeId, defaults): Promise<void> => {
    const sel = { projectId, worktreeId };
    const key = worktreeKey(sel);

    if (loadingKeys.has(key)) {
      // A caller awaiting this load may immediately create/send a chat. Join
      // the complete load, including starter creation, even when a large
      // migration takes longer than the best-effort background wait budget.
      await waitForWorktreeHydration(key, Number.POSITIVE_INFINITY);
      return;
    }
    if (hydratedKeys.has(key)) {
      if (
        get().worktreeChats[key] &&
        isScopeRevisionedLive(get(), projectId, worktreeId)
      ) {
        loadingKeys.add(key);
        try {
          if (revisionedSetupPendingKeys.has(key)) {
            await finishRevisionedHydration(
              get,
              set,
              projectId,
              worktreeId,
              loadActiveApprovalRequests({ projectId }),
            );
          } else {
            await get().ensureWorktreeHasChatTab(sel, {
              preserveActiveTab: true,
            });
          }
        } finally {
          loadingKeys.delete(key);
        }
      }
      return;
    }
    loadingKeys.add(key);

    try {
      const activeApprovalRequestsPromise = loadActiveApprovalRequests({
        projectId,
      });
      // Prefer the main-owned revisioned snapshot/delta stream (see loadTabs).
      if (revisionedChatStateSupported()) {
        const revisioned = await get().hydrateChatScopeRevisioned(
          projectId,
          worktreeId,
        );
        if (revisioned !== 'unavailable') {
          if (revisioned === 'installed') {
            await finishRevisionedHydration(
              get,
              set,
              projectId,
              worktreeId,
              activeApprovalRequestsPromise,
            );
          }
          return;
        }
      }

      const modelDefaults = await get().ensureModelDefaultsLoaded();

      const [file, active, queueSnapshots, activeApprovalRequests] =
        await Promise.all([
          chatBackendFor({ projectId }).chat.loadTabs({
            projectId,
            worktreeId,
            ...(isSentinelWriteAllowed(projectId, worktreeId)
              ? { establishRendererMergeBase: true }
              : {}),
          }),
          defaults?.skipActiveSessions === true
            ? Promise.resolve<ChatActiveSessions>({ activeChatIds: [] })
            : chatBackendFor({ projectId }).chat.activeSessions({
                projectId,
                worktreeId,
              }),
          // Race-free recovery of the host-owned message queue: fetch it as part
          // of hydration (no extra round-trip latency) so queued rows are built
          // into the hydrated tab atomically, rather than an async push/pull that
          // races streaming restoration after a renderer reload.
          chatBackendFor({ projectId }).chat.getChatQueueSnapshot
            ? chatBackendFor({ projectId }).chat.getChatQueueSnapshot({
                projectId,
                worktreeId,
              })
            : Promise.resolve<ChatQueueUpdatedEvent[]>([]),
          activeApprovalRequestsPromise,
        ]);
      const queuedByChatId = new Map(
        queueSnapshots.map((snapshot) => [
          snapshot.chatId,
          hostQueueViewsToQueuedMessages(snapshot.queue),
        ]),
      );

      const resolvedDefaults = resolveTabDefaults(projectId, modelDefaults);
      const defaultModel = defaults?.model ?? resolvedDefaults.model;
      const rawDefaultPluginSelections =
        defaults?.pluginSelections ??
        getDefaultPlugins(projectId, worktreeId, get().worktreeDefaultPlugins);
      const defaultProviderType = defaultModel
        ? (getProviderForModel(defaultModel) ??
          (defaults?.model === undefined
            ? resolvedDefaults.providerType
            : undefined))
        : resolvedDefaults.providerType;
      // Cached-support sanitize only — see loadTabs: hydration must not await
      // the marketplace-backed support index.
      const defaultPluginSelections = sanitizePluginSelectionsWithCachedSupport(
        rawDefaultPluginSelections,
        defaultProviderType,
      );
      const chatState = fromPersistedTabs(
        file,
        defaultPluginSelections,
        defaultModel,
        defaults?.thinkingLevel ?? resolvedDefaults.thinkingLevel,
        defaults?.defaultChatInterfaceMode ??
          resolveDefaultChatInterfaceMode(projectId, modelDefaults),
        defaults?.modelConfig ?? resolvedDefaults.modelConfig,
        defaults?.deferredToolsAllowed ??
          resolveDeferredToolsAllowedDefault(
            projectId,
            worktreeId,
            get().deferredToolsDefaults,
          ),
        resolveBillingSeed(modelDefaults, projectId),
        defaultProviderType,
        true,
        newChatPluginDefaultsStamp(projectId),
      );
      // The pipeline-editor assistant is canopy-only. Heal any persisted tab
      // that still carries a terminal-backed interface mode for this in-memory
      // view so it never launches a Claude Code terminal.
      // The bundled pipeline-writing skill is also required for every
      // pipeline-editor chat tab, including old persisted tabs and new tabs
      // created from user-editable defaults.
      if (isPipelineEditorChatTarget(projectId, worktreeId)) {
        chatState.tabs = chatState.tabs.map((tab) => {
          const healed = {
            ...tab,
            pluginSelections: withRequiredPipelineEditorSkill(
              tab.pluginSelections,
            ),
          };
          if (isTerminalBackedInterfaceMode(healed.interfaceMode)) {
            delete healed.interfaceMode;
          }
          return healed;
        });
      }
      const hydratedPendingQuestions = hydratePendingQuestionsFromFile(
        file,
        projectId,
        worktreeId,
        chatState,
      );
      const persistedPendingApprovals = hydratePendingApprovalsFromFile(
        file,
        projectId,
        worktreeId,
        chatState,
      );
      const liveApprovalState = activeApprovalRequests
        ? reconcileLivePendingApprovals(
            persistedPendingApprovals,
            activeApprovalRequests,
            projectId,
            worktreeId,
            chatState,
          )
        : {
            pendingApprovals: persistedPendingApprovals,
            removedStaleApprovals: false,
          };
      const hydratedPendingApprovals = liveApprovalState.pendingApprovals;
      const { removedStaleApprovals } = liveApprovalState;
      if (removedStaleApprovals) {
        chatState.tabs = closeTimersForRemovedApprovals(
          chatState.tabs,
          persistedPendingApprovals,
          hydratedPendingApprovals,
        );
      }
      const restored = restoreStreamingTabs(
        chatState.tabs,
        active,
        Date.now(),
        {
          projectId,
          worktreeId,
          pendingQuestions: hydratedPendingQuestions,
          pendingApprovals: hydratedPendingApprovals,
        },
      );
      chatState.tabs = restored.tabs;
      const mergedChatState = mergeHydratedWorktreeChatState(
        chatState,
        get().worktreeChats[key],
        file.tabs.length === 0,
      );
      mergedChatState.chatState.tabs = attachHostQueueMirror(
        mergedChatState.chatState.tabs,
        queuedByChatId,
      );
      mergedChatState.chatState.tabs =
        attachHostQueueSummariesFromQueueSnapshots(
          mergedChatState.chatState.tabs,
          queueSnapshots,
        );
      hydratedKeys.add(key);
      recordWorktreeChatTouch(key);

      set((state) => {
        const nextPendingQuestions = {
          ...state.pendingQuestions,
          ...hydratedPendingQuestions,
        };
        const nextPendingApprovals = {
          ...state.pendingApprovals,
          ...hydratedPendingApprovals,
        };
        const visibleKey = getVisibleWorktreeKey(state.selectedWorktree);
        const {
          chatState: chatStateWithQuestionAttention,
          hasUnreadPendingQuestion,
        } = derivePendingQuestionUnreadState(
          mergedChatState.chatState,
          nextPendingQuestions,
          projectId,
          worktreeId,
          key === visibleKey
            ? mergedChatState.chatState.activeTabId
            : undefined,
        );
        const nextUnread =
          hasUnreadPendingQuestion && !state.unreadWorktreeKeys.has(key)
            ? new Set(Array.from(state.unreadWorktreeKeys).concat(key))
            : state.unreadWorktreeKeys;

        // Hydrated live state supersedes any startup-seeded persisted badge
        // summary for this worktree.
        let nextPersistedBadges = state.persistedWorktreeBadges;
        if (nextPersistedBadges[key] !== undefined) {
          nextPersistedBadges = { ...nextPersistedBadges };
          delete nextPersistedBadges[key];
        }

        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: chatStateWithQuestionAttention,
          },
          pendingQuestions: nextPendingQuestions,
          pendingApprovals: nextPendingApprovals,
          unreadWorktreeKeys: nextUnread,
          persistedWorktreeBadges: nextPersistedBadges,
        };
      });

      if (
        file.tabs.length === 0 &&
        mergedChatState.chatState.tabs.length === 1
      ) {
        await applyResolvedApprovalModeForNewTab(
          { projectId, worktreeId },
          mergedChatState.chatState.tabs[0].id,
          set,
          get,
        );
      }

      useActivityStore
        .getState()
        .reconstructFromMessages(
          projectId,
          worktreeId,
          mergedChatState.chatState.tabs,
        );

      // Rescan the active tab's last turn on load so any plan-detection rules
      // introduced after the turn completed are applied without re-sending.
      // Dedup inside scanDetectedPlans makes this safe to call repeatedly.
      const loadedActiveTab = mergedChatState.chatState.tabs.find(
        (tab) => tab.id === mergedChatState.chatState.activeTabId,
      );
      if (loadedActiveTab) {
        triggerPlanDetectionScan(loadedActiveTab, projectId, worktreeId);
      }

      const activeTab = mergedChatState.chatState.tabs.find(
        (tab) => tab.id === mergedChatState.chatState.activeTabId,
      );
      if (
        activeTab &&
        file.tabs.length === 0 &&
        mergedChatState.chatState.tabs.length === 1
      ) {
        scheduleEmptyTabPluginSelectionSanitization({
          projectId,
          worktreeId,
          chatId: activeTab.id,
          providerType: resolveDiscoveryProviderType(activeTab),
        });
      }
      if (
        activeTab &&
        (file.tabs.length === 0 ||
          shouldRequestVisibleTabDiscovery({
            chatId: activeTab.id,
            tab: activeTab,
            tabDiscoveryLoading: get().tabDiscoveryLoading,
          }))
      ) {
        requestTabDiscovery({
          projectId,
          worktreeId,
          chatId: activeTab.id,
          pluginSelections:
            activeTab.pluginSelections ?? defaultPluginSelections,
          providerType: resolveDiscoveryProviderType(activeTab),
        });
      }

      if (
        restored.preservedAnyOnRestore ||
        mergedChatState.chatState.tabs.some((t) => t.status === 'streaming')
      ) {
        scheduleStreamingVerification();
      }
    } catch (error) {
      await applyFallbackWorktreeChatState(projectId, worktreeId);
      // eslint-disable-next-line no-console
      console.error(
        `[chatStore] Failed to hydrate chat tabs for ${key}; using fallback tab`,
        error,
      );
    } finally {
      loadingKeys.delete(key);
      scheduleIdleChatUnload();
    }
  },

  ensureSelectedWorktreeTabsLoaded: async (
    timeoutMs = 5000,
  ): Promise<boolean> => {
    const sel = get().selectedWorktree;
    if (!sel) {
      return false;
    }

    const key = worktreeKey(sel);
    const deadline = Date.now() + timeoutMs;

    while (!hydratedKeys.has(key)) {
      await get().loadTabs();
      if (hydratedKeys.has(key)) {
        return true;
      }
      if (!loadingKeys.has(key) || Date.now() >= deadline) {
        return false;
      }
      await delay(50);
    }

    return true;
  },

  loadAllWorktreeTabs: async (worktrees): Promise<void> => {
    const requestedKeys = worktrees.map(
      (wt) => `${wt.projectId}/${wt.worktreeId}`,
    );
    const toLoad = worktrees.filter((wt) => {
      const key = `${wt.projectId}/${wt.worktreeId}`;
      return !hydratedKeys.has(key) && !loadingKeys.has(key);
    });
    if (toLoad.length === 0) {
      // Every requested worktree is already hydrated or being hydrated by a
      // concurrent call (e.g. the WorktreeManager eager-hydration effect that
      // fires the instant a freshly created worktree appears). Await any
      // in-flight hydration on a best-effort basis so callers usually see
      // populated worktree state after awaiting this. The wait can time out, but
      // it still prevents the Create Task → Chat/Plan flow from immediately
      // reading empty tab state when the eager effect won the race.
      await Promise.all(
        requestedKeys.map((key) => waitForWorktreeHydration(key)),
      );
      return;
    }

    // Track the keys this call actually marked as loading so we only clear
    // those in the `finally` block. We intentionally do NOT pre-mark every
    // queued worktree: with CHAT_HYDRATION_CONCURRENCY capping parallelism,
    // pre-marking would cause the foreground `loadTabs()` (which short-circuits
    // on `loadingKeys.has(key)`) to no-op for queued worktrees that haven't
    // actually started hydrating yet, leaving the chat panel empty until the
    // background queue reaches them.
    const markedKeys: string[] = [];

    try {
      const modelDefaults = await get().ensureModelDefaultsLoaded();
      const activeApprovalRequests = await loadActiveApprovalRequests();

      const queuedByWorktreeKey = new Map<
        string,
        Map<string, ReturnType<typeof hostQueueViewsToQueuedMessages>>
      >();
      const waitingSnapshotsByWorktreeKey = new Map<
        string,
        ChatQueueUpdatedEvent[]
      >();
      const rawResults: Array<HydratedWorktreeTabsResult | null> =
        await mapWithConcurrency(
          toLoad,
          CHAT_HYDRATION_CONCURRENCY,
          async (wt) => {
            const key = `${wt.projectId}/${wt.worktreeId}`;
            // Skip if another code path (foreground `loadTabs()`, a prior hydration
            // pass, etc.) has already loaded or started loading this worktree.
            if (hydratedKeys.has(key) || loadingKeys.has(key)) {
              return null;
            }
            loadingKeys.add(key);
            markedKeys.push(key);
            // Prefer the main-owned revisioned snapshot/delta stream, exactly
            // like the foreground `loadTabs()` path. Eager badge hydration
            // must not strand a scope on the legacy projection — a scope
            // hydrated here first would otherwise never join the canonical
            // stream, so renderer commands for it would be silently skipped.
            if (revisionedChatStateSupported()) {
              const revisioned = await get().hydrateChatScopeRevisioned(
                wt.projectId,
                wt.worktreeId,
              );
              if (revisioned !== 'unavailable') {
                if (revisioned === 'installed') {
                  await finishRevisionedHydration(
                    get,
                    set,
                    wt.projectId,
                    wt.worktreeId,
                    activeApprovalRequests,
                  );
                }
                loadingKeys.delete(key);
                return null;
              }
            }
            try {
              const [file, active, queueSnapshots] = await Promise.all([
                chatBackendFor(wt).chat.loadTabs({
                  projectId: wt.projectId,
                  worktreeId: wt.worktreeId,
                  ...(isSentinelWriteAllowed(wt.projectId, wt.worktreeId)
                    ? { establishRendererMergeBase: true }
                    : {}),
                }),
                chatBackendFor(wt).chat.activeSessions({
                  projectId: wt.projectId,
                  worktreeId: wt.worktreeId,
                }),
                chatBackendFor(wt).chat.getChatQueueSnapshot
                  ? chatBackendFor(wt).chat.getChatQueueSnapshot({
                      projectId: wt.projectId,
                      worktreeId: wt.worktreeId,
                    })
                  : Promise.resolve<ChatQueueUpdatedEvent[]>([]),
              ]);
              const queuedByChatId = new Map(
                queueSnapshots.map((snapshot) => [
                  snapshot.chatId,
                  hostQueueViewsToQueuedMessages(snapshot.queue),
                ]),
              );
              queuedByWorktreeKey.set(key, queuedByChatId);
              waitingSnapshotsByWorktreeKey.set(key, queueSnapshots);
              const {
                model: wtDefaultModel,
                providerType: wtConfiguredDefaultProviderType,
                thinkingLevel: wtDefaultThinking,
                modelConfig: wtDefaultModelConfig,
              } = resolveTabDefaults(wt.projectId, modelDefaults);
              const wtRawDefaultPluginSelections = getDefaultPlugins(
                wt.projectId,
                wt.worktreeId,
                get().worktreeDefaultPlugins,
              );
              const wtDefaultProviderType = wtDefaultModel
                ? (getProviderForModel(wtDefaultModel) ??
                  wtConfiguredDefaultProviderType)
                : wtConfiguredDefaultProviderType;
              // Cached-support sanitize only — see loadTabs: hydration must
              // not await the marketplace-backed support index.
              const wtDefaultPluginSelections =
                sanitizePluginSelectionsWithCachedSupport(
                  wtRawDefaultPluginSelections,
                  wtDefaultProviderType,
                );
              const chatState = fromPersistedTabs(
                file,
                wtDefaultPluginSelections,
                wtDefaultModel,
                wtDefaultThinking,
                resolveDefaultChatInterfaceMode(wt.projectId, modelDefaults),
                wtDefaultModelConfig,
                resolveDeferredToolsAllowedDefault(
                  wt.projectId,
                  wt.worktreeId,
                  get().deferredToolsDefaults,
                ),
                resolveBillingSeed(modelDefaults, wt.projectId),
                wtDefaultProviderType,
                true,
                newChatPluginDefaultsStamp(wt.projectId),
              );
              const pendingQuestions = hydratePendingQuestionsFromFile(
                file,
                wt.projectId,
                wt.worktreeId,
                chatState,
              );
              const persistedPendingApprovals = hydratePendingApprovalsFromFile(
                file,
                wt.projectId,
                wt.worktreeId,
                chatState,
              );
              const liveApprovalState = activeApprovalRequests
                ? reconcileLivePendingApprovals(
                    persistedPendingApprovals,
                    activeApprovalRequests,
                    wt.projectId,
                    wt.worktreeId,
                    chatState,
                  )
                : {
                    pendingApprovals: persistedPendingApprovals,
                    removedStaleApprovals: false,
                  };
              const pendingApprovals = liveApprovalState.pendingApprovals;
              const { removedStaleApprovals } = liveApprovalState;
              if (removedStaleApprovals) {
                chatState.tabs = closeTimersForRemovedApprovals(
                  chatState.tabs,
                  persistedPendingApprovals,
                  pendingApprovals,
                );
              }
              const restored = restoreStreamingTabs(
                chatState.tabs,
                active,
                Date.now(),
                {
                  projectId: wt.projectId,
                  worktreeId: wt.worktreeId,
                  pendingQuestions,
                  pendingApprovals,
                },
              );
              chatState.tabs = restored.tabs;
              return {
                key,
                chatState,
                pendingQuestions,
                pendingApprovals,
                removedStaleApprovals,
                wasEmpty: file.tabs.length === 0,
                preservedAnyOnRestore: restored.preservedAnyOnRestore,
              };
            } catch (error) {
              // Per-worktree resilience: one failing hydration must not abort
              // the whole batch or strand this worktree's chat panel with no
              // visible tab. Fall back to an in-memory default tab and keep
              // the key un-hydrated so a later selection retries.
              await applyFallbackWorktreeChatState(wt.projectId, wt.worktreeId);
              // eslint-disable-next-line no-console
              console.error(
                `[chatStore] Failed to hydrate chat tabs for ${key}; using fallback tab`,
                error,
              );
              return null;
            }
          },
        );

      const results: HydratedWorktreeTabsResult[] = rawResults.filter(
        (result): result is HydratedWorktreeTabsResult => result !== null,
      );
      const mergedResults = results.map((result) => {
        const merged = mergeHydratedWorktreeChatState(
          result.chatState,
          get().worktreeChats[result.key],
          result.wasEmpty,
        );
        const queuedByChatId = queuedByWorktreeKey.get(result.key);
        if (queuedByChatId) {
          merged.chatState.tabs = attachHostQueueMirror(
            merged.chatState.tabs,
            queuedByChatId,
          );
        }
        const waitingSnapshots = waitingSnapshotsByWorktreeKey.get(result.key);
        if (waitingSnapshots) {
          merged.chatState.tabs = attachHostQueueSummariesFromQueueSnapshots(
            merged.chatState.tabs,
            waitingSnapshots,
          );
        }
        hydratedKeys.add(result.key);
        recordWorktreeChatTouch(result.key);
        return {
          ...result,
          chatState: merged.chatState,
          mergedCurrentState: merged.mergedCurrentState,
        };
      });

      set((state) => {
        const nextChats = { ...state.worktreeChats };
        const unread = new Set(state.unreadWorktreeKeys);
        const visibleKey = getVisibleWorktreeKey(state.selectedWorktree);

        const nextPendingQuestions = { ...state.pendingQuestions };
        const nextPendingApprovals = { ...state.pendingApprovals };
        for (const {
          key,
          chatState,
          pendingQuestions,
          pendingApprovals,
        } of mergedResults) {
          const parsedKey = splitWorktreeKey(key);
          const effectivePendingQuestions = {
            ...nextPendingQuestions,
            ...pendingQuestions,
          };
          const {
            chatState: chatStateWithQuestionAttention,
            hasUnreadPendingQuestion,
          } = derivePendingQuestionUnreadState(
            chatState,
            effectivePendingQuestions,
            parsedKey.projectId,
            parsedKey.worktreeId,
            key === visibleKey ? chatState.activeTabId : undefined,
          );
          nextChats[key] = chatStateWithQuestionAttention;
          Object.assign(nextPendingQuestions, pendingQuestions);
          Object.assign(nextPendingApprovals, pendingApprovals);
          // Derive unread from persisted pendingPlanExit or any tab with unread.
          // Skip the selected worktree — the user is already viewing it and can
          // see the plan approval bar, so adding a badge is unnecessary.
          // Use the effective state (which may have been kept from a concurrent
          // selectWorktree/handleChatEvent) rather than stale persistence data.
          const effective = nextChats[key];
          const activeTab = effective.tabs.find(
            (t) => t.id === effective.activeTabId,
          );
          const activeTabNeedsAttention =
            key !== visibleKey &&
            activeTab !== undefined &&
            activeTab.attentionDismissedAt === undefined &&
            (activeTab.pendingPlanExit !== undefined ||
              hasPendingTrackedPlanReview(activeTab));
          if (
            activeTabNeedsAttention ||
            hasUnreadPendingQuestion ||
            (key !== visibleKey &&
              effective.tabs.some((t) => t.unread === true))
          ) {
            unread.add(key);
          }
        }

        // Hydrated live state supersedes any startup-seeded persisted badge
        // summary for these worktrees.
        let nextPersistedBadges = state.persistedWorktreeBadges;
        for (const { key } of mergedResults) {
          if (nextPersistedBadges[key] !== undefined) {
            if (nextPersistedBadges === state.persistedWorktreeBadges) {
              nextPersistedBadges = { ...nextPersistedBadges };
            }
            delete nextPersistedBadges[key];
          }
        }

        return {
          worktreeChats: nextChats,
          pendingQuestions: nextPendingQuestions,
          pendingApprovals: nextPendingApprovals,
          unreadWorktreeKeys: unread,
          persistedWorktreeBadges: nextPersistedBadges,
        };
      });

      for (const { key, chatState, wasEmpty } of mergedResults) {
        const slashIdx = key.indexOf('/');
        const projectId = key.slice(0, slashIdx);
        const worktreeId = key.slice(slashIdx + 1);
        useActivityStore
          .getState()
          .reconstructFromMessages(projectId, worktreeId, chatState.tabs);

        // Eagerly load the worktree's archived-chats list so the archive icon
        // renders on startup. Best-effort and non-blocking — `loadArchivedChats`
        // swallows transport errors.
        void get().loadArchivedChats(projectId, worktreeId);

        // Fresh default tab created for a worktree with no persisted tabs —
        // trigger command discovery so slash-commands are available immediately.
        // Only fire if this chatState was actually written to the store (the
        // set() loop above skips worktrees that were already loaded).
        if (wasEmpty && chatState.tabs.length === 1) {
          const initialTab = chatState.tabs[0];
          const currentWc = get().worktreeChats[key];
          if (currentWc?.tabs.some((t) => t.id === initialTab.id)) {
            await applyResolvedApprovalModeForNewTab(
              { projectId, worktreeId },
              initialTab.id,
              set,
              get,
            );
            scheduleEmptyTabPluginSelectionSanitization({
              projectId,
              worktreeId,
              chatId: initialTab.id,
              providerType: resolveDiscoveryProviderType(initialTab),
            });
            requestTabDiscovery({
              projectId,
              worktreeId,
              chatId: initialTab.id,
              pluginSelections: initialTab.pluginSelections,
              providerType: resolveDiscoveryProviderType(initialTab),
            });
          }
        }
      }

      // Re-verify after a delay to catch race conditions where a result event
      // arrived before worktreeChats was populated, and to re-evaluate any
      // tabs kept streaming by the post-crash grace window so they eventually
      // settle if the session never becomes active again.
      const hasAnyStreaming = results.some(({ chatState }) =>
        chatState.tabs.some((t) => t.status === 'streaming'),
      );
      const hasAnyPreservedOnRestore = results.some(
        ({ preservedAnyOnRestore }) => preservedAnyOnRestore,
      );
      if (hasAnyStreaming || hasAnyPreservedOnRestore) {
        scheduleStreamingVerification();
      }
    } finally {
      for (const key of markedKeys) {
        loadingKeys.delete(key);
      }
      scheduleIdleChatUnload();
    }
    // Some requested worktrees may have been owned by a concurrent in-flight
    // call rather than this one; give those hydrations a best-effort chance to
    // finish before callers read their tabs. Keys this call just hydrated return
    // from waitForWorktreeHydration immediately.
    await Promise.all(
      requestedKeys.map((key) => waitForWorktreeHydration(key)),
    );
  },

  unloadIdleWorktreeChats: async (now = Date.now()): Promise<void> => {
    const candidates = getIdleWorktreeChatCandidates(get(), now);
    if (candidates.length === 0) {
      scheduleIdleChatUnload();
      return;
    }

    const checkedCandidates = await mapWithConcurrency(
      candidates,
      CHAT_HYDRATION_CONCURRENCY,
      async (candidate) => canUnloadIdleWorktreeChat(candidate, now),
    );
    const unloadable = checkedCandidates.filter(
      (candidate): candidate is IdleWorktreeChatCandidate => candidate !== null,
    );
    if (unloadable.length === 0) {
      scheduleIdleChatUnload();
      return;
    }

    const unloadedCandidates: IdleWorktreeChatCandidate[] = [];
    set((state) => {
      let changed = false;
      const nextChats = { ...state.worktreeChats };

      for (const candidate of unloadable) {
        const current = state.worktreeChats[candidate.key];
        if (
          current !== candidate.chatState ||
          loadingKeys.has(candidate.key) ||
          blockedPersistenceKeys.has(candidate.key) ||
          shouldKeepWorktreeChatHydrated(state, candidate.key, current)
        ) {
          continue;
        }

        delete nextChats[candidate.key];
        hydratedKeys.delete(candidate.key);
        hydrationLastTouchedAt.delete(candidate.key);
        unloadedCandidates.push(candidate);
        changed = true;
      }

      return changed ? { worktreeChats: nextChats } : state;
    });

    // Unloaded scopes stop tracking the revisioned canonical stream; a later
    // selection re-hydrates them from a fresh snapshot.
    for (const candidate of unloadedCandidates) {
      get().releaseChatScopeRevisioned(
        candidate.projectId,
        candidate.worktreeId,
      );
    }

    scheduleIdleChatUnload();
  },

  createTab: (target): void => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return;
    appendNewTab(sel, set, get);
  },

  createTabWithId: (id: string): void => {
    const sel = get().selectedWorktree;
    if (!sel) return;
    appendNewTab(sel, set, get, id);
  },

  ensureWorktreeHasChatTab: async (target, options): Promise<void> => {
    // A cloud task deleted on another device keeps the chat it had and is
    // never given a starter, which the web core would refuse (CAN-6614).
    if (isCloudTaskDeleted(target)) return;
    // The shared-container recipient scope is read-only: its chats are
    // projected from the published revision by main, and a share with no
    // chats must stay empty rather than gain a local starter chat.
    if (target.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
      return;
    }
    // Branch-from registers its destination before the eager hydration effect
    // can observe the new worktree. An empty canonical snapshot during that
    // handoff is transitional: creating a starter here would briefly expose a
    // second "New Chat" and then remove it when the fork commit arrives.
    if (isWorktreeTabForkPending(target.projectId, target.worktreeId)) {
      return;
    }
    const key = worktreeKey(target);
    const stateBeforeEnsure = get();
    const needsStarterTab = !stateBeforeEnsure.worktreeChats[key]?.tabs.some(
      (tab) => tab.kind !== 'file',
    );
    // A starter tab's model defaults are resolved before it is constructed.
    // Resolve its approval default at the same boundary so the composer never
    // renders a fallback mode and then changes underneath the user.
    const starterApprovalMode = needsStarterTab
      ? (options?.approvalMode ??
        (await stateBeforeEnsure.fetchApprovalDefault(
          target.projectId,
          target.worktreeId,
          { forceFresh: true },
        )))
      : undefined;
    // The user (or a concurrent ensure) may have created a chat while the
    // default lookup was in flight. That newer action owns activation and
    // canonical creation; do not expose or dispatch a second starter for it.
    if (
      needsStarterTab &&
      get().worktreeChats[key]?.tabs.some((tab) => tab.kind !== 'file')
    ) {
      return;
    }
    const createdTabRef: { current: ChatTab | null } = { current: null };
    const ensuredTabRef: { current: ChatTab | null } = { current: null };
    const preservedActiveTabIdRef: { current: string | null } = {
      current: null,
    };

    set((state) => {
      const current = state.worktreeChats[key];
      const activeTab = current?.tabs.find(
        (tab) => tab.id === current.activeTabId,
      );
      if (activeTab && activeTab.kind !== 'file') {
        ensuredTabRef.current = activeTab;
        return state;
      }

      const existingChatTab = current?.tabs.find((tab) => tab.kind !== 'file');
      if (current && existingChatTab) {
        ensuredTabRef.current = existingChatTab;
        if (options?.preserveActiveTab) {
          return state;
        }
        const updated: WorktreeChatState = {
          ...current,
          activeTabId: existingChatTab.id,
          lastActiveEditableChatId: existingChatTab.id,
          ...(resolveTabProviderType(existingChatTab)
            ? {
                lastActiveChatProvider: resolveTabProviderType(existingChatTab),
              }
            : {}),
        };
        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
        };
      }

      const {
        model: defaultModel,
        thinkingLevel: defaultThinking,
        modelConfig: defaultModelConfig,
      } = resolveTabDefaults(target.projectId, state.modelDefaults);
      const fallback = emptyWorktreeChat({
        pluginSelections: withRequiredPluginSelectionsForTarget(
          target.projectId,
          target.worktreeId,
          getDefaultPlugins(
            target.projectId,
            target.worktreeId,
            state.worktreeDefaultPlugins,
          ),
        ),
        model: defaultModel,
        thinkingLevel: defaultThinking,
        defaultChatInterfaceMode: resolveDefaultChatInterfaceMode(
          target.projectId,
          state.modelDefaults,
        ),
        modelConfig: defaultModelConfig,
        deferredToolsAllowed: resolveDeferredToolsAllowedDefault(
          target.projectId,
          target.worktreeId,
          state.deferredToolsDefaults,
        ),
        billingSeed: resolveBillingSeed(state.modelDefaults, target.projectId),
        ...newChatPluginDefaultsStamp(target.projectId),
      });
      const unresolvedFallbackTab = fallback.tabs[0] ?? null;
      const fallbackTab = unresolvedFallbackTab
        ? {
            ...unresolvedFallbackTab,
            ...(options?.eager &&
            !isScopeRevisionedLive(get(), target.projectId, target.worktreeId)
              ? { pendingInitialCreation: true }
              : {}),
            ...(starterApprovalMode
              ? { approvalMode: starterApprovalMode }
              : {}),
          }
        : null;
      if (fallbackTab) {
        fallback.tabs = [fallbackTab];
      }
      createdTabRef.current = fallbackTab;
      ensuredTabRef.current = fallbackTab;
      const updated: WorktreeChatState =
        current && current.tabs.length > 0
          ? {
              ...current,
              tabs: relabelFileTabs([...current.tabs, ...fallback.tabs]),
              activeTabId: options?.preserveActiveTab
                ? current.activeTabId
                : fallback.activeTabId,
              lastActiveEditableChatId: fallback.activeTabId,
              ...(fallback.lastActiveChatProvider
                ? {
                    lastActiveChatProvider: fallback.lastActiveChatProvider,
                  }
                : {}),
            }
          : fallback;
      if (options?.preserveActiveTab && current?.activeTabId) {
        preservedActiveTabIdRef.current = current.activeTabId;
      }
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });

    const createdTab = createdTabRef.current;
    if (createdTab) {
      scheduleEmptyTabPluginSelectionSanitization({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: createdTab.id,
        providerType: resolveDiscoveryProviderType(createdTab),
      });
    }

    const createdTabApprovalModePromise = createdTab
      ? applyResolvedApprovalModeForNewTab(target, createdTab.id, set, get)
      : Promise.resolve(undefined);

    const ensuredTab = ensuredTabRef.current;
    if (
      !ensuredTab ||
      !isScopeRevisionedLive(get(), target.projectId, target.worktreeId)
    ) {
      await createdTabApprovalModePromise;
      return;
    }

    if (!createdTab) {
      const pendingCreation = pendingTabCreation(
        target.projectId,
        target.worktreeId,
        ensuredTab.id,
      );
      if (pendingCreation) {
        await pendingCreation;
        return;
      }
    }

    let creationRevision: number | undefined;
    let existingChatId: string | undefined;
    // The starter exists only because this renderer saw the scope without a
    // chat. Another writer (an automation, a Portal send, or another window)
    // may commit a chat first, so main creates the starter only while the
    // scope still has none and otherwise reports the chat that won. Drop the
    // local starter then and select that chat instead of an empty "New Chat".
    const isStarter = (tab: ChatTab): boolean =>
      tab.kind !== 'file' &&
      tab.messages.length === 0 &&
      (createdTab?.id === tab.id || tab.pendingInitialCreation === true);
    const discardStarter = (replacementId: string): void => {
      set((state) => {
        const current = state.worktreeChats[key];
        if (!current?.tabs.some((tab) => tab.id === ensuredTab.id)) {
          return state;
        }
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: {
              ...current,
              tabs: relabelFileTabs(
                current.tabs.filter((tab) => tab.id !== ensuredTab.id),
              ),
              ...(current.activeTabId === ensuredTab.id
                ? { activeTabId: replacementId }
                : {}),
              ...(current.lastActiveEditableChatId === ensuredTab.id
                ? { lastActiveEditableChatId: replacementId }
                : {}),
            },
          },
        };
      });
    };
    const creation = (async (): Promise<ChatCommandDisposition> => {
      const createdTabApprovalMode = await createdTabApprovalModePromise;
      const latestTab = get().worktreeChats[key]?.tabs.find(
        (tab) => tab.id === ensuredTab.id,
      );
      if (!latestTab || latestTab.kind === 'file') {
        return 'transport_failed' as const;
      }
      const providerType = resolveTabProviderType(latestTab);
      const command = {
        type: 'chat.create_tab',
        tabId: latestTab.id,
        title: latestTab.title,
        ...(isStarter(latestTab) ? { starter: true } : {}),
        ...(providerType ? { providerType } : {}),
        ...(latestTab.model ? { model: latestTab.model } : {}),
        // Keep the renderer's untouched-default marker across canonical creation.
        ...(target.projectId === APP_ADVISOR_PROJECT_ID &&
        latestTab.defaultStampModel
          ? { defaultStampModel: latestTab.defaultStampModel }
          : {}),
        ...(latestTab.modelConfig
          ? { modelConfig: latestTab.modelConfig }
          : {}),
        ...(latestTab.planMode ? { planMode: true } : {}),
        ...(latestTab.proposalMode
          ? { proposalMode: latestTab.proposalMode }
          : {}),
        ...(latestTab.pluginSelections
          ? { pluginSelections: latestTab.pluginSelections }
          : {}),
        ...(typeof latestTab.deferredToolsAllowed === 'boolean'
          ? { deferredToolsAllowed: latestTab.deferredToolsAllowed }
          : {}),
        ...(latestTab.interfaceMode
          ? { interfaceMode: latestTab.interfaceMode }
          : {}),
        ...(latestTab.selectedRepoId
          ? { selectedRepoId: latestTab.selectedRepoId }
          : {}),
        ...(createdTab?.id === latestTab.id && createdTabApprovalMode
          ? { approvalMode: createdTabApprovalMode }
          : latestTab.approvalMode
            ? { approvalMode: latestTab.approvalMode }
            : {}),
        ...(latestTab.aiCreditsRouting
          ? { aiCreditsRouting: latestTab.aiCreditsRouting }
          : {}),
        ...(typeof latestTab.subscriptionBillingOverride === 'boolean'
          ? {
              subscriptionBillingOverride:
                latestTab.subscriptionBillingOverride,
            }
          : {}),
      } as const;
      let notFound = false;
      const dispatchCreation = (): Promise<ChatCommandDisposition> =>
        get().dispatchChatCommand(target, command, {
          onResult: (result): void => {
            notFound = result.outcome === 'not_found';
            creationRevision = result.revision;
            existingChatId =
              result.entityId !== undefined && result.entityId !== latestTab.id
                ? result.entityId
                : undefined;
          },
        });
      let disposition = await dispatchCreation();
      // What the web core no longer holds is never asked for again.
      if (
        (disposition === 'transport_failed' ||
          (disposition === 'conflict' && !notFound)) &&
        (await waitForChatScopeLive(target.projectId, target.worktreeId))
      ) {
        disposition = await dispatchCreation();
      }
      if (disposition === 'accepted' && existingChatId !== undefined) {
        discardStarter(existingChatId);
        return 'rejected' as const;
      }
      if (disposition === 'accepted') {
        set((state) => {
          const scope = state.worktreeChats[key];
          if (
            !scope?.tabs.some(
              (tab) => tab.id === ensuredTab.id && tab.pendingInitialCreation,
            )
          )
            return state;
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: {
                ...scope,
                tabs: scope.tabs.map((tab) =>
                  tab.id === ensuredTab.id
                    ? { ...tab, pendingInitialCreation: undefined }
                    : tab,
                ),
              },
            },
          };
        });
        get().dismissChatStateNotice(target.projectId, target.worktreeId);
        const preservedActiveTabId = preservedActiveTabIdRef.current;
        if (preservedActiveTabId) {
          await get().dispatchChatCommand(target, {
            type: 'chat.activate_tab',
            tabId: preservedActiveTabId,
          });
        }
      }
      return disposition;
    })();
    if (createdTab || ensuredTab.pendingInitialCreation) {
      registerPendingTabCreation(
        target.projectId,
        target.worktreeId,
        ensuredTab.id,
        creation,
        () => creationRevision,
      );
    }
    await creation;
  },

  forkTab: (
    sourceTabId: string,
    target?: ChatActionTarget,
    options?: {
      forkAfterUserMessageId?: string;
      includeActiveTurn?: boolean;
      sourceSdkSessionId?: string;
      syncWarning?: string;
    },
  ): void => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return;

    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    if (!wc) return;

    const sourceIndex = wc.tabs.findIndex((t) => t.id === sourceTabId);
    if (sourceIndex < 0) return;

    const source = wc.tabs[sourceIndex];
    if (source.kind === 'file') return;
    const explicitActiveSessionFork =
      options?.includeActiveTurn === true &&
      Boolean(options.sourceSdkSessionId ?? source.sdkSessionId);
    if (source.messages.length === 0 && !explicitActiveSessionFork) return;
    const sourceProviderType = resolveTabProviderType(source);
    const sourceExecutionHarness = resolveTabExecutionHarness(source);

    // Truncate to the requested fork point so a click on the previous turn's
    // button while the next turn is mid-stream or was cancelled discards the
    // in-progress / cancelled tail. The fork point is identified by the
    // turn's user message id; turn timers are inserted before assistant
    // content in raw `source.messages`, so slicing on the timer id would drop
    // the assistant output for that turn.
    const selection = selectMessagesForForkOrBranch(source, options);
    if (!selection) return;
    const { messagesToClone, truncated, activeSnapshot } = selection;
    const forkAnchorMessageId =
      messagesToClone.length > 0
        ? messagesToClone[messagesToClone.length - 1].id
        : undefined;

    const shouldSettleForkSnapshot =
      activeSnapshot || explicitActiveSessionFork;
    const clonedTranscript = cloneChatTabTranscript(source, messagesToClone);
    const clonedMessages: ChatMessage[] = shouldSettleForkSnapshot
      ? settleForkSnapshotMessages(clonedTranscript.messages)
      : clonedTranscript.messages;
    if (options?.syncWarning) {
      const timestamp = Date.now();
      clonedMessages.push({
        id: nextMsgId(),
        role: 'system',
        timestamp,
        blocks: [
          {
            type: 'claude_terminal_sync_warning',
            timestamp,
            message: options.syncWarning,
          },
        ],
      });
    }
    const {
      agentArtifactCarryByTurn: clonedArtifactCarry,
      discovery: clonedDiscovery,
      pluginSelections: clonedPluginSelections,
      usage: clonedUsage,
      agentUsage: clonedAgentUsage,
      turnDiffs: clonedTurnDiffs,
    } = clonedTranscript;

    const forkedTitle = createForkTabTitle(source);

    // Context preservation: only safe for Claude. Active terminal forks carry
    // the source SDK session id just long enough for Claude Code resume to load
    // the full provider context; the next init event backfills the forked tab
    // with a fresh on-disk session id, so both tabs diverge after that first
    // resumed turn. Codex threads append in-place on resume, so sharing a
    // thread id across tabs would collide.
    //
    // Every ordinary Claude fork is a snapshot. Even when the whole visible
    // history is copied, the source can advance before the fork's first send,
    // so carry its session only with the last kept chain entry as an anchor.
    // Legacy transcripts without one start fresh, and fresh provenance
    // propagates through later forks.
    const sourceSdkSessionId =
      options?.sourceSdkSessionId ?? source.sdkSessionId;
    const forkRequiresResumePoint =
      sourceExecutionHarness === 'claude' && sourceSdkSessionId !== undefined;
    const forkResumePoint = forkRequiresResumePoint
      ? resolveClaudeForkResumePoint(messagesToClone, forkAnchorMessageId)
      : undefined;
    const carriedSdkSessionId =
      sourceExecutionHarness === 'claude' &&
      (!forkRequiresResumePoint || forkResumePoint !== undefined)
        ? sourceSdkSessionId
        : undefined;
    const startsWithoutModelContext =
      (forkRequiresResumePoint && !carriedSdkSessionId) ||
      (sourceExecutionHarness === 'claude' &&
        sourceSdkSessionId === undefined &&
        (truncated || source.forkedFrom?.modelContext === 'fresh'));

    const forked: ChatTab = {
      id: nextTabId(),
      title: forkedTitle,
      messages: clonedMessages,
      status: 'idle',
      error: null,
      createdAt: new Date().toISOString(),
      newChatStartedWatcherPending: true,
      queuedMessages: [],
      forkedFrom: {
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId: sourceTabId,
        ...(forkAnchorMessageId ? { atMessageId: forkAnchorMessageId } : {}),
        ...(forkRequiresResumePoint && carriedSdkSessionId
          ? { resumePointRequired: true }
          : {}),
        ...(sourceExecutionHarness === 'opencode'
          ? { modelContext: 'visible-transcript' }
          : startsWithoutModelContext
            ? { modelContext: 'fresh' }
            : {}),
      },
      planMode: source.planMode,
      proposalMode: source.proposalMode,
      thinkingLevel: source.thinkingLevel,
      modelConfig: source.modelConfig,
      fastModeExplicit: source.fastModeExplicit,
      ...(sourceExecutionHarness === 'codex'
        ? { codexFastModeEnabled: Boolean(source.codexFastModeEnabled) }
        : {}),
      ...retainedCodexSpeedFields(source.retainedCodexSpeed),
      ...(source.model ? { model: source.model } : {}),
      ...(sourceProviderType ? { providerType: sourceProviderType } : {}),
      ...(source.executionHarness
        ? { executionHarness: source.executionHarness }
        : {}),
      ...(carriedSdkSessionId ? { sdkSessionId: carriedSdkSessionId } : {}),
      ...(carriedSdkSessionId && source.globalInstructionsSnapshot !== undefined
        ? { globalInstructionsSnapshot: source.globalInstructionsSnapshot }
        : {}),
      ...(carriedSdkSessionId ? { claudeForkSessionOnNextSend: true } : {}),
      ...(clonedPluginSelections
        ? { pluginSelections: clonedPluginSelections }
        : {}),
      ...inheritedPluginDefaultsCarry(source),
      // Undelivered one-shot context carries on a FULL-history fork, as it
      // already does in `branchTab`. These instructions are pending precisely
      // because no turn has consumed them, so such a fork inherits the same
      // obligation the source still has.
      //
      // Load-bearing for a continued chat forked before its first turn: the
      // handoff summary lives ONLY here until that turn sends, and the tab
      // deliberately carries no target-provider `sdkSessionId`. Dropping it
      // would leave the fork showing a full transcript to a model that received
      // neither the summary nor any session history — worse than the disclosure
      // gap, because the context itself is gone rather than just its label.
      //
      // NOT on a truncated (historical) fork, matching `branchTab`'s
      // `truncated ? undefined : ...` and the sibling `pendingPlanExit` rule.
      // These instructions describe the transcript as it stood at the SOURCE's
      // tip: a continued chat's handoff summarizes the whole conversation, so
      // carrying it into a fork taken at an earlier turn would feed the new
      // agent a summary of the very turns the fork exists to discard.
      ...(sourceExecutionHarness !== 'opencode' &&
      !truncated &&
      source.pendingSystemInstructions?.length
        ? {
            pendingSystemInstructions: structuredClone(
              source.pendingSystemInstructions,
            ),
          }
        : {}),
      ...(clonedDiscovery ? { discovery: clonedDiscovery } : {}),
      ...(clonedUsage ? { usage: clonedUsage } : {}),
      ...(clonedAgentUsage ? { agentUsage: clonedAgentUsage } : {}),
      ...(clonedTurnDiffs ? { turnDiffs: clonedTurnDiffs } : {}),
      ...(clonedArtifactCarry
        ? { agentArtifactCarryByTurn: clonedArtifactCarry }
        : {}),
      ...(source.selectedRepoId
        ? { selectedRepoId: source.selectedRepoId }
        : {}),
      ...(source.pinned === true ? { pinned: true } : {}),
      // Carry the tool-approval mode and any chat-lifetime ("session" scope)
      // approval rules onto the forked tab as an independent seed — cloned so
      // later mutations on either tab's rule list don't share references.
      ...(source.approvalMode ? { approvalMode: source.approvalMode } : {}),
      ...(source.sessionApprovalRules?.length
        ? { sessionApprovalRules: structuredClone(source.sessionApprovalRules) }
        : {}),
    };

    if (sourceExecutionHarness === 'opencode')
      prepareOpenCodeVisibleFork(forked);
    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;
      const insertAt =
        currentWc.tabs.findIndex((t) => t.id === sourceTabId) + 1;
      const nextTabs = [...currentWc.tabs];
      nextTabs.splice(insertAt > 0 ? insertAt : nextTabs.length, 0, forked);
      const updated: WorktreeChatState = {
        ...currentWc,
        tabs: nextTabs,
        activeTabId: forked.id,
        lastActiveEditableChatId: forked.id,
        ...(sourceProviderType
          ? { lastActiveChatProvider: sourceProviderType }
          : {}),
      };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });

    // Durable fork identity is main-owned: commit the fork through the
    // canonical command port (main clones its canonical source at the same
    // anchor), so the forked transcript survives reload and restart.
    const canonicalForkPromise = isScopeRevisionedLive(
      get(),
      sel.projectId,
      sel.worktreeId,
    )
      ? get().dispatchChatCommand(
          { projectId: sel.projectId, worktreeId: sel.worktreeId },
          {
            type: 'chat.fork_tab',
            sourceTabId,
            targetTabId: forked.id,
            ...(forkAnchorMessageId
              ? { atMessageId: forkAnchorMessageId }
              : {}),
            ...(carriedSdkSessionId
              ? { sourceSdkSessionId: carriedSdkSessionId }
              : {}),
            ...(options?.syncWarning
              ? { syncWarning: options.syncWarning }
              : {}),
          },
        )
      : null;

    if (clonedPluginSelections) {
      requestTabDiscovery({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId: forked.id,
        pluginSelections: clonedPluginSelections,
        providerType: resolveDiscoveryProviderType(forked),
      });
    }

    // Codex context preservation: thread/fork the source thread on the
    // app-server so the model resumes a brand-new thread that already
    // contains the prior conversation. Runs in the background; on success
    // the forked tab's sdkSessionId is patched with the new thread id. On
    // failure, the host restores the copied history before the next send.
    // Skip when we truncated the tail — thread/fork would clone the
    // source's current (post-fork-point) state, not the truncated state
    // we just persisted on the forked tab.
    const sourceThreadId = options?.sourceSdkSessionId ?? source.sdkSessionId;
    if (sourceExecutionHarness === 'codex' && sourceThreadId && !truncated) {
      const forkedTabId = forked.id;
      const forkBaselineUserMessageIds = new Set(
        clonedMessages
          .filter((message) => message.role === 'user')
          .map((message) => message.id),
      );
      const target = { projectId: sel.projectId, worktreeId: sel.worktreeId };
      const repoId = source.selectedRepoId;
      void (async (): Promise<void> => {
        try {
          const { forkedThreadId } = await chatBackendFor(
            target,
          ).chat.forkCodexThread({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            chatId: forkedTabId,
            ...(repoId ? { selectedRepoId: repoId } : {}),
            sourceThreadId,
            sourceProjectId: sel.projectId,
            sourceWorktreeId: sel.worktreeId,
            sourceChatId: sourceTabId,
            ...(clonedPluginSelections
              ? { pluginSelections: clonedPluginSelections }
              : {}),
            // The exact speed wins over the legacy boolean alias in main, so
            // an Ultra fast (or Ultra fast default) source forks at Ultra fast.
            modelConfig: codexSpeedFields(tabRequestedCodexSpeed(source)),
            codexFastModeEnabled: source.codexFastModeEnabled,
          });
          if (canonicalForkPromise) {
            const forkDisposition = await canonicalForkPromise;
            if (forkDisposition !== 'accepted') {
              throw new Error('Failed to persist the forked chat tab');
            }
          }
          let shouldPersistForkedThreadId = false;
          set((state) => {
            const currentWc = state.worktreeChats[worktreeKey(target)];
            if (!currentWc) return state;
            const currentForkedTab = currentWc.tabs.find(
              (tab) => tab.id === forkedTabId,
            );
            if (!currentForkedTab) return state;
            const shouldBackfillForkedThreadId =
              !currentForkedTab.sdkSessionId &&
              currentForkedTab.status === 'idle' &&
              currentForkedTab.queuedMessages.length === 0 &&
              !currentForkedTab.messages.some(
                (message) =>
                  message.role === 'user' &&
                  !forkBaselineUserMessageIds.has(message.id),
              );
            if (!shouldBackfillForkedThreadId) {
              return state;
            }
            shouldPersistForkedThreadId = true;
            const updatedTabs = currentWc.tabs.map((t) =>
              t.id === forkedTabId ? { ...t, sdkSessionId: forkedThreadId } : t,
            );
            const updated: WorktreeChatState = {
              ...currentWc,
              tabs: updatedTabs,
            };
            return {
              worktreeChats: {
                ...state.worktreeChats,
                [worktreeKey(target)]: updated,
              },
            };
          });
          if (
            shouldPersistForkedThreadId &&
            isScopeRevisionedLive(get(), target.projectId, target.worktreeId)
          ) {
            let disposition = await get().dispatchChatCommand(target, {
              type: 'chat.patch_tab_settings',
              tabId: forkedTabId,
              patch: { sdkSessionId: forkedThreadId },
            });
            if (
              (disposition === 'transport_failed' ||
                disposition === 'conflict') &&
              (await waitForChatScopeLive(target.projectId, target.worktreeId))
            ) {
              disposition = await get().dispatchChatCommand(target, {
                type: 'chat.patch_tab_settings',
                tabId: forkedTabId,
                patch: { sdkSessionId: forkedThreadId },
              });
            }
            if (disposition === 'accepted') {
              get().dismissChatStateNotice(target.projectId, target.worktreeId);
            }
            if (disposition !== 'accepted') {
              throw new Error('Failed to persist the forked Codex thread');
            }
          }
        } catch (error: unknown) {
          // eslint-disable-next-line no-console
          console.warn(
            '[chat-fork] Codex thread/fork failed; forked tab will restore copied history before continuing.',
            error,
          );
        }
      })();
    }
  },

  continueTabOnProvider: async (
    sourceTabId: string,
    targetModel: ChatModel,
    target?: ChatActionTarget,
    billingFramework?: 'subscription' | 'ai-credits',
    isStillWanted?: () => boolean,
  ): Promise<ContinueTabOnProviderResult> => {
    const stale = (): ContinueTabOnProviderResult => ({
      status: 'failed',
      message: 'This model choice is no longer current.',
    });
    if (isStillWanted?.() === false) return stale();
    const sel = target ?? get().selectedWorktree;
    if (!sel) {
      return { status: 'failed', message: 'No chat target is selected.' };
    }

    const key = worktreeKey(sel);

    // Load the plugin-provider-support index BEFORE any state is snapshotted.
    // The cached-index sanitizer is a documented no-op while the index is null,
    // and the only other loader is the empty-tab path, which cannot run for a
    // continued tab (it early-returns on a non-empty transcript). A session that
    // restored existing chats and never opened an empty tab would otherwise
    // carry a source-only plugin straight onto the target harness. Awaiting
    // here rather than after the snapshot keeps every read below on one
    // consistent post-await view of the store.
    //
    // Bounded like the summary call: the dialog is already uncancellable by the
    // time this runs, so a hung marketplace bridge would trap the user here —
    // before summary generation even begins.
    //
    // Only pay for this when the source actually carries plugin refs. There is
    // nothing to sanitize otherwise, and making a plugin-free chat wait on (or
    // fail from) the marketplace bridge would be a dependency it does not have.
    // This pre-read only decides WHETHER to load; every read the result depends
    // on is taken fresh after the await, and a chat that gains plugin refs
    // during the load still lands on the fail-closed guard below.
    //
    // `pluginRefs` and not the other selection kinds, deliberately:
    // `sanitizePluginSelectionsForProvider` only ever filters `pluginRefs`, so
    // `collectionIds`, `skillRefs` and `mcpServerRefs` would gain nothing from
    // the index. Collection-borne plugins are unsanitized on EVERY path in the
    // app (the empty-tab path calls the same helper), so this is not a
    // continue-specific hole; widening the gate here would buy a slower, more
    // failure-prone continue and no extra safety.
    const preSource = get().worktreeChats[key]?.tabs.find(
      (t) => t.id === sourceTabId,
    );
    const needsPluginSupport =
      preSource !== undefined &&
      preSource.kind !== 'file' &&
      (preSource.pluginSelections?.pluginRefs.length ?? 0) > 0;

    let pluginSupportIndex: PluginProviderSupportIndex | null = null;
    if (needsPluginSupport) {
      // Captured BEFORE the await so the timeout below retires the load this
      // call is actually waiting on. Invalidating unconditionally would let a
      // staggered concurrent continue retire a newer retry that was already
      // succeeding.
      const loadGeneration = getPluginProviderSupportLoadGeneration();
      try {
        pluginSupportIndex = await withContinueStepTimeout(
          loadPluginProviderSupportIndex(),
          'Checking plugin compatibility took too long. Try continuing this chat again.',
          PLUGIN_SUPPORT_INDEX_TIMEOUT_MS,
        );
      } catch (error: unknown) {
        // The loader memoizes its in-flight promise and clears it only when
        // that promise settles. Giving up on our own timeout without evicting
        // it would hand every later attempt the SAME hung promise, making the
        // "try again" this message promises impossible until a renderer reload.
        invalidatePluginProviderSupportIndexLoad(loadGeneration);
        return {
          status: 'failed',
          message: extractIpcErrorMessage(error),
        };
      }
      // A refresh failure resolves to null even when a slightly-stale index is
      // still in memory (the TTL is seconds). Prefer that over refusing: it is
      // real compatibility data, and the alternative is blocking the user on a
      // transient hiccup.
      //
      // BOUNDED, though. "Slightly stale" is the whole justification, and the
      // cache has no expiry of its own — it holds whatever the last successful
      // load produced, which on a long-lived window can be hours old and
      // describe plugins that have since been uninstalled or renamed. Past
      // this bound the honest answer is that compatibility is unknown, so fall
      // through to the refusal rather than deciding from a snapshot nobody
      // would defend.
      pluginSupportIndex =
        pluginSupportIndex ?? getFreshEnoughPluginProviderSupportIndex();
    }

    const wc = get().worktreeChats[key];
    if (!wc) {
      return {
        status: 'failed',
        message: 'The source chat state is unavailable.',
      };
    }

    const source = wc.tabs.find((t) => t.id === sourceTabId);
    if (!source || source.kind === 'file') {
      return { status: 'failed', message: 'The source chat no longer exists.' };
    }

    const sourceProviderType = resolveTabProviderType(source);
    const targetProviderType = getProviderForModel(targetModel);
    if (!targetProviderType) {
      return {
        status: 'failed',
        message: `Unknown model provider: ${targetModel}`,
      };
    }

    // Unanswered ask-user cards live outside the tab (the tab reads `'idle'`
    // while the provider waits on the user), so the predicate cannot see them
    // without being told. Recomputed after the await too, since a question can
    // arrive while the summary generates.
    //
    // Uses the shared `hasPendingQuestionForChat` rather than an inline scan:
    // its correctness rests on the documented invariant that answered records
    // are RETAINED with `answeredAt` rather than deleted, so a hand-rolled copy
    // would silently drift the day that changes.
    const sourceHasUnansweredQuestion = (): boolean =>
      hasPendingQuestionForChat(
        get().pendingQuestions,
        sel.projectId,
        sel.worktreeId,
        sourceTabId,
      );

    // One predicate gates the row-enable decision, the confirm dialog and this
    // action, so they can never disagree.
    const eligibility = canContinueOnOtherHarness(
      {
        ...source,
        hasUnansweredQuestion: sourceHasUnansweredQuestion(),
      },
      targetProviderType,
      sel.projectId,
    );
    if (!eligibility.ok) {
      return { status: 'failed', message: eligibility.reason };
    }
    // `canContinueOnOtherHarness` only passes once the source resolves to a
    // locked provider, which is the same derivation as `resolveTabProviderType`.
    // Narrow it here so the handoff prompt below cannot fall back to a default
    // that would mislabel a Codex source as Claude.
    if (!sourceProviderType) {
      return { status: 'failed', message: 'The source chat has no provider.' };
    }

    const selection = selectMessagesForForkOrBranch(source);
    if (!selection) {
      return { status: 'failed', message: 'This chat has nothing to carry.' };
    }
    const { messagesToClone } = selection;

    // Generate the handoff summary BEFORE creating anything. Claude
    // `thinking.signature` and Codex `reasoning.encrypted_content` are
    // provider-bound and can never cross, so the summary is the entire context
    // transfer: if it fails we must create no tab at all, rather than render a
    // full transcript above a model that has never seen any of it.
    const conversationText = buildHandoffSummaryInput(messagesToClone);
    if (!conversationText.trim()) {
      return {
        status: 'failed',
        message: 'This chat has no conversation text to summarize.',
      };
    }

    // Fingerprint the transcript BEFORE the await. Eligibility alone cannot see
    // a turn that starts and finishes inside the await window, because that
    // leaves the tab idle again and the recheck below passes — we would then
    // clone this stale snapshot and silently drop the completed turn.
    const sourceMessageCount = source.messages.length;
    const sourceLastMessageId =
      source.messages.length > 0
        ? source.messages[source.messages.length - 1].id
        : undefined;

    let summary = '';
    try {
      const response = await withContinueStepTimeout(
        chatBackendFor(sel).chat.generateHandoffSummary({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          conversationText,
          kind: 'continue-on-other-harness',
          chatId: sourceTabId,
        }),
        'Preparing the summary took too long. Try continuing this chat again.',
        HANDOFF_SUMMARY_TIMEOUT_MS,
      );
      summary = response.summary.trim();
    } catch (error: unknown) {
      // Strip the `Error invoking remote method '<channel>':` wrapper Electron
      // adds, so a policy refusal reads as itself in the confirm dialog. The
      // local timeout Error above passes through unchanged.
      return {
        status: 'failed',
        message: extractIpcErrorMessage(error),
      };
    }
    if (!summary) {
      return {
        status: 'failed',
        message: 'Summary generation returned no content.',
      };
    }

    // Re-read after the await: the source may have advanced or closed while the
    // summary generated, which would make the summary a lie.
    const currentWc = get().worktreeChats[key];
    const currentSource = currentWc?.tabs.find((t) => t.id === sourceTabId);
    if (!currentSource || currentSource.kind === 'file') {
      return { status: 'failed', message: 'The source chat no longer exists.' };
    }
    const recheck = canContinueOnOtherHarness(
      {
        ...currentSource,
        hasUnansweredQuestion: sourceHasUnansweredQuestion(),
      },
      targetProviderType,
      sel.projectId,
    );
    if (!recheck.ok) {
      return { status: 'failed', message: recheck.reason };
    }
    const currentLastMessageId =
      currentSource.messages.length > 0
        ? currentSource.messages[currentSource.messages.length - 1].id
        : undefined;
    // Structural check: catches appended/removed turns, including ones the text
    // projection below ignores (tool-only messages carry no handoff text).
    const structureChanged =
      currentSource.messages.length !== sourceMessageCount ||
      currentLastMessageId !== sourceLastMessageId;
    // Content check: message content can be REPLACED in place under the same id
    // (`mergePersistedPromptMessages`), which leaves count and last id
    // untouched. Rebuilding the summary input is the invariant that actually
    // matters — if it no longer matches what was summarized, the summary is a
    // lie regardless of how the transcript got there.
    const currentSelection = selectMessagesForForkOrBranch(currentSource);
    const contentChanged =
      currentSelection === null ||
      buildHandoffSummaryInput(currentSelection.messagesToClone) !==
        conversationText;
    if (structureChanged || contentChanged || currentSelection === null) {
      return {
        status: 'failed',
        message:
          'This chat changed while the summary was being prepared. Try continuing it again.',
      };
    }

    // Clone from `currentSource` / `currentSelection`, not the pre-await
    // snapshot: the guards above proved the transcripts are equivalent, so this
    // changes no messages, but it keeps the non-message carries
    // (pluginSelections / agentUsage / turnDiffs) on the same post-await view
    // that was actually validated.
    const clonedTranscript = cloneChatTabTranscript(
      currentSource,
      currentSelection.messagesToClone,
    );
    // Settle any still-open turn timer, INCLUDING a paused one. `cloneChatTabTranscript`
    // leaves paused timers alone (only the fork path passes `closePaused`), which is
    // right for a fork because the forked chat can resume the session that paused it.
    // A continued chat never can: it runs on the other harness with a new session, so
    // a carried paused timer would tick as unfinished forever. Not
    // `settleForkSnapshotMessages` — that also stamps open tool blocks with
    // "Interrupted by fork", and nothing here was interrupted by a fork.
    const clonedMessages = closeOpenTurnTimers(clonedTranscript.messages, {
      closePaused: true,
    });
    const anchorMessageId =
      clonedMessages.length > 0
        ? clonedMessages[clonedMessages.length - 1].id
        : undefined;
    const {
      agentArtifactCarryByTurn: clonedArtifactCarry,
      pluginSelections: clonedPluginSelections,
      agentUsage: clonedAgentUsage,
      turnDiffs: clonedTurnDiffs,
    } = clonedTranscript;

    // Plugin selections are provider-scoped, and unlike every other new-tab path
    // this one crosses a provider boundary. `scheduleEmptyTabPluginSelectionSanitization`
    // cannot cover it — it early-returns on a non-empty transcript, and the
    // continued tab always has one — so sanitize eagerly here. Without this a
    // Claude-only plugin survives onto a Codex tab and is then handed to
    // discovery under `providerType: 'codex'`.
    //
    // FAIL CLOSED when the index is unavailable. The loader collapses a bridge
    // error, an unsuccessful result and a missing bridge all into `null`, and
    // the sanitizer treats `null` as "keep everything" — which would carry a
    // source-only plugin across the boundary exactly as before, just triggered
    // by a transient failure instead of a cold cache. Refusing with a retryable
    // message is honest; silently dropping the user's plugins is not, and
    // silently keeping incompatible ones is the bug this guards.
    //
    // "Unavailable" here means more than a null index. `sanitizePluginSelectionsForProvider`
    // keeps a ref whose key is absent from the index (`!support` returns true),
    // which is the right default for the in-place paths — an unknown plugin is
    // usually one the catalog has not finished describing — but it is the wrong
    // one for a boundary crossing, where "not described" and "described as
    // incompatible" are indistinguishable and only one of them is safe. A
    // plugin that was uninstalled or renamed since the cached snapshot is
    // exactly the ref that goes missing, so accepting the miss would let it
    // cross unchecked. Refuse instead, on the same retryable message.
    const carriedPluginRefs = clonedPluginSelections?.pluginRefs ?? [];
    const pluginSupportUnverified =
      pluginSupportIndex === null ||
      carriedPluginRefs.some(
        (ref) =>
          !pluginSupportIndex.has(
            pluginProviderSupportKey(ref.marketplaceId, ref.pluginName),
          ),
      );
    if (pluginSupportUnverified && carriedPluginRefs.length > 0) {
      return {
        status: 'failed',
        message:
          'Could not check which plugins work on the other harness. Try continuing this chat again.',
      };
    }
    const targetPluginSelections = sanitizePluginSelectionsForProvider(
      clonedPluginSelections,
      targetProviderType,
      pluginSupportIndex,
    );

    // Config normalization, not a fork clone. `forkTab` copies thinking level,
    // model config and fast-mode verbatim, which is correct same-harness and
    // wrong across harnesses. Mirror `setModel`'s provider-change path instead:
    // provider-normalized model config, target-provider fast-mode default, and
    // no carried interface mode / terminal state / session id.
    //
    // Thinking level CARRIES from the source and is clamped to the target.
    //
    // `resolveProviderModelConfig` prefers `modelConfig.thinkingLevel` over its
    // `thinkingLevel` argument, and every tab that reaches this point has a
    // `modelConfig`: `createEmptyTab` sets one and `restoreTab` resolves one, so
    // although the field is optional on the type it is always present at
    // runtime. An earlier version also computed a per-provider default and
    // passed it alongside; it could never win, so it is gone rather than left
    // implying a behavior the code does not have.
    //
    // This matches `setModel`'s provider-change path exactly, which spreads
    // `...t.modelConfig` the same way (`slices/models.ts`). That is the point:
    // continuing onto Codex and switching a fresh chat to Codex should not
    // disagree about thinking level. `normalizeThinkingForProvider` inside the
    // resolver still clamps, so a Claude-only `ultrathink` cannot leak across.
    const state = get();
    // Codex speed follows the target provider's default record, read
    // speed-first (an Ultra fast default projects `fastMode: false`), never
    // the source's speed: the continued chat is a new chat on that harness.
    const targetDefaultSpeed =
      readCodexSpeedRecord(
        state.modelDefaults?.modelConfigDefaultsByProvider?.[
          targetProviderType
        ],
      ) ?? DEFAULT_CODEX_SPEED;
    const nextModelConfig = resolveProviderModelConfig(
      targetProviderType,
      {
        modelConfig: {
          ...currentSource.modelConfig,
          ...codexSpeedFields(targetDefaultSpeed),
        },
      },
      state.modelDefaults?.modelConfigDefaultsByProvider,
    );

    // Billing framework is SEEDED like any other fresh chat, not carried from
    // the source. Without either bit the tab falls through to the global
    // `aiCreditsRoutingMode` safety net instead of the choice the user
    // actually made, so a deliberate "use my subscription" pick could quietly
    // become AI Credits spend on the other harness.
    //
    // Seeded rather than copied because `aiCreditsRouting` is scoped to the
    // model that was routed: cloning the source chat's routing state onto a
    // different provider's model would assert a routing decision that was
    // never made for it. `resolveBillingSeed` is the user's last explicit
    // toggle, which is exactly what a new chat on the target harness would
    // start from.
    const seededBilling = billingSeedFields(
      billingFramework ??
        resolveBillingSeed(state.modelDefaults, sel.projectId),
    );
    // Tab-level `usage` is a running total for the chat's own session, and the
    // continued chat starts a new one on a different provider — so the
    // counters deliberately do NOT carry. The METER must, though: a tab with
    // no `usage` renders a dead 0% ring whose popover never opens until the
    // first turn lands on the new provider (CAN-2799). Seed zeroed counters
    // sized to the target model's context window, resolved against the same
    // billing state the tab starts with so the window matches what
    // `normalizePersistedUsage` would restore after a reload.
    const seededUsage = createSeededTabUsage(
      targetModel,
      isTabAiCreditsRouted({ model: targetModel, ...seededBilling }),
    );

    const handoffText = `[SESSION HANDOFF]

This chat was continued from a ${getProviderLabel(sourceProviderType)} session that cannot be resumed here. Below is a summary of that conversation. Use this context to continue seamlessly.

---
${summary}
---`;

    if (isStillWanted?.() === false) return stale();
    const continued: ChatTab = {
      id: nextTabId(),
      title: createContinuedTabTitle(
        currentSource,
        getProviderLabel(targetProviderType),
      ),
      messages: clonedMessages,
      status: 'idle',
      error: null,
      createdAt: new Date().toISOString(),
      newChatStartedWatcherPending: true,
      queuedMessages: [],
      forkedFrom: {
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId: sourceTabId,
        ...(anchorMessageId ? { atMessageId: anchorMessageId } : {}),
        continuedFromProvider: sourceProviderType,
      },
      // Plan mode is supported on both continuable harnesses, and a pending
      // plan approval is already refused by `canContinueOnOtherHarness`, so the
      // plain flag carries. `pendingPlanExit` deliberately does not.
      planMode: currentSource.planMode,
      proposalMode: currentSource.proposalMode,
      thinkingLevel: nextModelConfig.thinkingLevel,
      modelConfig: nextModelConfig,
      fastModeExplicit: false,
      model: targetModel,
      providerType: targetProviderType,
      // Main clones the SOURCE tab under this metadata, so a harness the user
      // chose there would otherwise ride along onto the other provider and
      // fail the next turn's routing check. The continued chat runs on the
      // harness it was continued onto.
      ...(targetProviderType === 'claude' || targetProviderType === 'codex'
        ? { executionHarness: targetProviderType }
        : {}),
      // Delivered as a system prefix on the user's next real turn rather than
      // an auto-sent message, so continuing costs no wasted turn.
      // Carried instructions FIRST, handoff last. `pendingSystemInstructions` is
      // not provider-session state: `queuePlanImportInstruction` stages
      // provider-neutral plan context here ("the user imported the plan at X,
      // reference it"), and it never appears in the transcript, so it is
      // invisible to the summarizer. Replacing the array would silently drop
      // context the user explicitly attached. Read off `currentSource` so an
      // instruction queued during the summary await carries too.
      // NOTE the sanitized text: `formatPendingSystemInstructionBlock` DROPS any
      // instruction containing the reserved closing delimiter, and the send path
      // then clears the pending list — so an unsanitized summary that happened to
      // contain it would silently deliver no handoff at all, while the continued
      // chat still shows the "summary only" divider promising one. The summary is
      // model output over conversation text, so a chat that merely discusses
      // prompt formatting can produce it.
      pendingSystemInstructions: [
        ...(currentSource.pendingSystemInstructions ?? []),
        { id: nextMsgId(), text: sanitizeSystemInstructionText(handoffText) },
      ],
      ...(targetProviderType === 'codex'
        ? { codexFastModeEnabled: nextModelConfig.fastMode }
        : {}),
      ...(targetPluginSelections
        ? { pluginSelections: targetPluginSelections }
        : {}),
      // Tombstones for inherited (project and global) default plugins the
      // user explicitly turned off. Carried for the same reason
      // `deferredToolsAllowed` is: inherited defaults overlay
      // `pluginSelections`, so dropping these silently re-enables plugins the
      // user rejected.
      ...inheritedPluginDefaultsCarry(currentSource),
      // `agentUsage` and `turnDiffs` are keyed to the turns being cloned, so
      // they carry with the transcript that renders them — dropping them would
      // blank out per-turn usage and diffs on messages that are still visible.
      // Tab-level `usage` deliberately does NOT carry (see `seededUsage`): the
      // continued chat starts fresh counters on the new provider, but keeps a
      // live meter sized to the target model.
      ...(seededUsage ? { usage: seededUsage } : {}),
      ...(clonedAgentUsage ? { agentUsage: clonedAgentUsage } : {}),
      ...(clonedTurnDiffs ? { turnDiffs: clonedTurnDiffs } : {}),
      ...(clonedArtifactCarry
        ? { agentArtifactCarryByTurn: clonedArtifactCarry }
        : {}),
      ...(currentSource.selectedRepoId
        ? { selectedRepoId: currentSource.selectedRepoId }
        : {}),
      // Deferred-tools permission carries when the source made an explicit
      // choice, and otherwise falls back to the same default any new chat in
      // this worktree would get. Omitting it entirely is not neutral: every
      // consumer reads `undefined` as `!== false`, i.e. ENABLED, so a user who
      // turned deferred tools off would find them quietly back on after
      // continuing.
      //
      // Carried rather than purely seeded (unlike billing below) because this
      // is a conversation-level permission with no provider scoping: "do not
      // let this chat pull in extra tools" means the same thing on either
      // harness, so the choice should follow the conversation.
      deferredToolsAllowed:
        currentSource.deferredToolsAllowed ??
        resolveDeferredToolsAllowedDefault(
          sel.projectId,
          sel.worktreeId,
          state.deferredToolsDefaults,
        ),
      // Billing framework is seeded, not carried — see `seededBilling` above.
      ...seededBilling,
    };

    const continuationMetadata = toPersistedTab(continued);
    continuationMetadata.messages = [];
    const canonicalCreation = await get().dispatchChatCommand(sel, {
      type: 'chat.fork_tab',
      sourceTabId,
      targetTabId: continued.id,
      ...(anchorMessageId ? { atMessageId: anchorMessageId } : {}),
      cloneMode: 'continuation',
      destinationTab: continuationMetadata,
    });
    if (canonicalCreation !== 'accepted') {
      return {
        status: 'failed',
        message: 'The continued transcript could not be saved.',
      };
    }

    set((latest) => {
      const latestWc = latest.worktreeChats[key];
      if (!latestWc) return latest;
      const insertAt = latestWc.tabs.findIndex((t) => t.id === sourceTabId) + 1;
      const nextTabs = [...latestWc.tabs];
      nextTabs.splice(insertAt > 0 ? insertAt : nextTabs.length, 0, continued);
      // Only pull focus if the user is still ON the chat they continued.
      //
      // The summary can legitimately take a couple of minutes, and the composer
      // deliberately lets an in-flight run finish after a chat switch rather
      // than cancelling it. Focusing unconditionally means a continue started
      // minutes ago can yank the user out of whatever they moved on to, which
      // is worse than the tab simply being there when they look for it. This is
      // reachable wherever the surface stays interactive during the wait (a
      // popped-out composer being the clear case).
      const sourceStillActive = latestWc.activeTabId === sourceTabId;
      const updated: WorktreeChatState = {
        ...latestWc,
        tabs: nextTabs,
        // `lastActiveChatProvider` moves with focus, not with creation. It
        // means "the active (or most recently active) chat's provider", and the
        // Usage panel falls back to it while a file tab is active — so setting
        // it for a chat the user never opened would report the wrong provider.
        ...(sourceStillActive
          ? {
              activeTabId: continued.id,
              lastActiveEditableChatId: continued.id,
              lastActiveChatProvider: targetProviderType,
            }
          : {}),
      };
      return {
        worktreeChats: { ...latest.worktreeChats, [key]: updated },
      };
    });

    // Discovery must run against the TARGET provider: the source tab's
    // discovery is provider-specific and is deliberately not carried over.
    requestTabDiscovery({
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      chatId: continued.id,
      ...(targetPluginSelections
        ? { pluginSelections: targetPluginSelections }
        : {}),
      providerType: resolveDiscoveryProviderType(continued),
    });

    return { status: 'created', chatId: continued.id };
  },

  branchTab: async (
    sourceTabId: string,
    target?: ChatActionTarget,
    options?: {
      forkAfterUserMessageId?: string;
      cancelled?: () => boolean;
      onCommitted?: () => void;
    },
  ): Promise<BranchTabResult> => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) {
      return {
        status: 'failed',
        message: 'No source worktree is selected.',
        retryable: false,
      };
    }
    if (isCoworkChatTarget(sel.projectId)) {
      return {
        status: 'failed',
        message: 'Standalone chats cannot be branched into worktrees.',
        retryable: false,
      };
    }

    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    if (!wc) {
      return {
        status: 'failed',
        message: 'The source worktree chat state is unavailable.',
        retryable: true,
      };
    }

    let source = wc.tabs.find((t) => t.id === sourceTabId);
    if (!source) {
      return {
        status: 'failed',
        message: 'The source chat no longer exists.',
        retryable: false,
      };
    }
    if (source.kind === 'file') {
      return {
        status: 'failed',
        message: 'File tabs cannot be branched into worktrees.',
        retryable: false,
      };
    }
    if (source.messages.length === 0) {
      return {
        status: 'failed',
        message: 'Empty chats cannot be branched into worktrees.',
        retryable: false,
      };
    }

    // Approval changes are persisted before the renderer publishes their
    // finalized state. Wait for an in-flight change (including its rollback)
    // and then re-read the source tab so the branch cannot inherit a stale
    // mode that no longer matches the source chat.
    const pendingApprovalTransition = pendingApprovalModeTransitions(
      sel.projectId,
      sel.worktreeId,
      sourceTabId,
    );
    if (pendingApprovalTransition) {
      try {
        await pendingApprovalTransition;
      } catch {
        // A rejected transition leaves the previous mode authoritative.
      }
    }
    source = get().worktreeChats[key]?.tabs.find((t) => t.id === sourceTabId);
    if (!source || source.kind === 'file' || source.messages.length === 0) {
      return {
        status: 'failed',
        message: 'The source chat changed before it could be branched.',
        retryable: true,
      };
    }

    const preparation = await prepareBranchFromWorktree(
      sel.projectId,
      sel.worktreeId,
    );
    if (preparation.status === 'cancelled') {
      return preparation;
    }
    if (preparation.status === 'failed') {
      return {
        status: 'failed',
        message: 'Fresh source worktree status could not be verified.',
        retryable: preparation.retryable,
      };
    }

    const selection = selectMessagesForForkOrBranch(source, options);
    if (!selection) {
      return {
        status: 'failed',
        message: 'The requested branch point is unavailable.',
        retryable: false,
      };
    }
    const { messagesToClone, truncated } = selection;

    // Snapshot source data before creating the worktree — createWorktree
    // auto-selects the new worktree, after which `selectedWorktree` no longer
    // points at the source.
    const sourceProjectId = sel.projectId;
    const sourceWorktreeId = sel.worktreeId;
    const sourceProviderType = resolveTabProviderType(source);
    const sourceExecutionHarness = resolveTabExecutionHarness(source);
    const sourceSdkSessionId = source.sdkSessionId;
    const sourceSelectedRepoId = source.selectedRepoId;
    const sourceProjectsState = useProjectsStore.getState();
    const sourceProject = sourceProjectsState.projects.find(
      (project) => project.id === sourceProjectId,
    );
    const sourceWorktree =
      sourceProject && sourceProject.type !== 'cowork'
        ? sourceProject.worktrees.find(
            (worktree) => worktree.id === sourceWorktreeId,
          )
        : undefined;
    const sourceBranch = sourceSelectedRepoId
      ? sourceProjectsState.repoBranches[key]?.find(
          (repo) => repo.repoId === sourceSelectedRepoId,
        )?.branch
      : sourceWorktree?.branchName;
    const sourceCodexFastModeEnabled = source.codexFastModeEnabled;
    const sourceCodexSpeed = tabRequestedCodexSpeed(source);
    const sourcePendingSystemInstructions = source.pendingSystemInstructions
      ? structuredClone(source.pendingSystemInstructions)
      : undefined;
    const clonedTranscript = cloneChatTabTranscript(source, messagesToClone);
    // Choose the fork-point anchor from the exact transcript that survives
    // canonical persistence. A first branch can still contain renderer-only
    // empty/local-command artifacts; anchoring to one of those makes the
    // divider disappear as soon as the canonical projection sanitizes it.
    const clonedMessages = sanitizePersistedChatMessages(
      clonedTranscript.messages,
    );
    const {
      agentArtifactCarryByTurn: clonedArtifactCarry,
      discovery: clonedDiscovery,
      pluginSelections: clonedPluginSelections,
      usage: clonedUsage,
      agentUsage: clonedAgentUsage,
      turnDiffs: clonedTurnDiffs,
    } = clonedTranscript;
    const clonedPendingPlanExit =
      !truncated && source.pendingPlanExit
        ? structuredClone(source.pendingPlanExit)
        : undefined;
    const sourcePlanMode = source.planMode;
    const sourceApprovalMode = source.approvalMode;
    const sourceProposalMode = source.proposalMode;
    const sourceThinkingLevel = source.thinkingLevel;
    const sourceModel = source.model;
    const sourceTrackedPlanId = truncated ? undefined : source.trackedPlanId;
    const sourceTrackedPlanSource = truncated
      ? undefined
      : source.trackedPlanSource;
    const sourceTrackedPlanReviewStatus = truncated
      ? undefined
      : source.trackedPlanReviewStatus;
    const sourceHasOutstandingProposal = truncated
      ? undefined
      : source.hasOutstandingProposal;
    // Branched tabs land in a fresh worktree, so they shouldn't carry the
    // "Fork:" prefix that disambiguates sibling tabs in the source worktree.
    const branchedTitle = createBranchTabTitle(source);

    if (options?.cancelled?.()) {
      return { status: 'cancelled' };
    }
    options?.onCommitted?.();

    let finishPendingBranchHandoff: (() => void) | undefined;
    const beginPendingBranchHandoff = (worktreeId: string): void => {
      finishPendingBranchHandoff ??= beginPendingWorktreeTabFork(
        sourceProjectId,
        worktreeId,
      );
    };
    const finishBranchHandoff = (): void => {
      finishPendingBranchHandoff?.();
      finishPendingBranchHandoff = undefined;
    };
    const created = await useProjectsStore
      .getState()
      .createWorktree(sourceProjectId, {
        baseWorktreeId: sel.worktreeId,
        select: false,
        suppressStartPage: true,
        // Worktree registration publishes the destination row before this
        // promise resolves. Mark that scope as a branch handoff immediately so
        // eager chat hydration cannot materialize a blank starter in the gap.
        onRegistered: (worktree) => {
          beginPendingBranchHandoff(worktree.id);
        },
      });
    if (!created) {
      finishBranchHandoff();
      return {
        status: 'failed',
        message:
          inlineFailureText(useProjectsStore.getState().worktreeError) ??
          'Failed to create the branched worktree.',
        retryable: true,
      };
    }

    const newWorktreeId = created.id;
    // Keep tests and alternate store adapters safe if they return a created
    // worktree without invoking the normal registration milestone.
    beginPendingBranchHandoff(newWorktreeId);
    const newKey = worktreeKey({
      projectId: sourceProjectId,
      worktreeId: newWorktreeId,
    });
    const [sourceCwd, destinationCwd] = await Promise.all([
      window.api.getWorktreePath({
        projectId: sourceProjectId,
        worktreeId: sourceWorktreeId,
        ...(sourceSelectedRepoId ? { repoId: sourceSelectedRepoId } : {}),
      }),
      window.api.getWorktreePath({
        projectId: sourceProjectId,
        worktreeId: newWorktreeId,
        ...(sourceSelectedRepoId ? { repoId: sourceSelectedRepoId } : {}),
      }),
    ]).catch((error: unknown) => {
      finishBranchHandoff();
      throw error;
    });

    // Same context-preservation rule as forkTab: only Claude can resume a
    // shared SDK session safely; Codex needs an explicit thread/fork below.
    // A branch is likewise a snapshot and resumes only at the kept range's
    // last chain entry. Missing anchors start fresh with durable disclosure.
    const branchResumePoint =
      sourceExecutionHarness === 'claude' && sourceSdkSessionId !== undefined
        ? resolveClaudeForkResumePoint(
            clonedMessages,
            clonedMessages[clonedMessages.length - 1]?.id,
          )
        : undefined;
    const branchRequiresResumePoint =
      sourceExecutionHarness === 'claude' && sourceSdkSessionId !== undefined;
    const carriedSdkSessionId =
      sourceExecutionHarness === 'claude' &&
      (!branchRequiresResumePoint || branchResumePoint !== undefined)
        ? sourceSdkSessionId
        : undefined;
    const branchStartsWithoutModelContext =
      (branchRequiresResumePoint && !carriedSdkSessionId) ||
      (sourceExecutionHarness === 'claude' &&
        sourceSdkSessionId === undefined &&
        (truncated || source.forkedFrom?.modelContext === 'fresh'));

    const branched: ChatTab = {
      id: nextTabId(),
      title: branchedTitle,
      messages: clonedMessages,
      status: 'idle',
      error: null,
      createdAt: new Date().toISOString(),
      newChatStartedWatcherPending: true,
      queuedMessages: [],
      forkedFrom: {
        projectId: sourceProjectId,
        worktreeId: sourceWorktreeId,
        chatId: sourceTabId,
        ...(clonedMessages.length > 0
          ? { atMessageId: clonedMessages[clonedMessages.length - 1].id }
          : {}),
        ...(branchRequiresResumePoint && carriedSdkSessionId
          ? { resumePointRequired: true }
          : {}),
        ...(sourceExecutionHarness === 'opencode'
          ? { modelContext: 'visible-transcript' as const }
          : branchStartsWithoutModelContext
            ? { modelContext: 'fresh' as const }
            : {}),
      },
      planMode: sourcePlanMode,
      proposalMode: sourceProposalMode,
      thinkingLevel: sourceThinkingLevel,
      modelConfig: source.modelConfig,
      fastModeExplicit: source.fastModeExplicit,
      ...(sourceExecutionHarness === 'codex'
        ? { codexFastModeEnabled: Boolean(sourceCodexFastModeEnabled) }
        : {}),
      ...retainedCodexSpeedFields(source.retainedCodexSpeed),
      ...(sourceModel ? { model: sourceModel } : {}),
      ...(sourceProviderType ? { providerType: sourceProviderType } : {}),
      ...(source.executionHarness
        ? { executionHarness: source.executionHarness }
        : {}),
      ...(carriedSdkSessionId ? { sdkSessionId: carriedSdkSessionId } : {}),
      ...(carriedSdkSessionId && source.globalInstructionsSnapshot !== undefined
        ? { globalInstructionsSnapshot: source.globalInstructionsSnapshot }
        : {}),
      ...(carriedSdkSessionId ? { claudeForkSessionOnNextSend: true } : {}),
      ...(clonedPluginSelections
        ? { pluginSelections: clonedPluginSelections }
        : {}),
      ...inheritedPluginDefaultsCarry(source),
      ...(clonedDiscovery ? { discovery: clonedDiscovery } : {}),
      ...(clonedUsage ? { usage: clonedUsage } : {}),
      ...(clonedAgentUsage ? { agentUsage: clonedAgentUsage } : {}),
      ...(clonedTurnDiffs ? { turnDiffs: clonedTurnDiffs } : {}),
      ...(clonedArtifactCarry
        ? { agentArtifactCarryByTurn: clonedArtifactCarry }
        : {}),
      // Carry plan-approval state for full-transcript branches only. If the
      // transcript was truncated, the pending proposal may belong to a dropped
      // tail turn, so the new worktree starts without stale approval UI.
      ...(clonedPendingPlanExit
        ? { pendingPlanExit: clonedPendingPlanExit }
        : {}),
      ...(sourceTrackedPlanId ? { trackedPlanId: sourceTrackedPlanId } : {}),
      ...(sourceTrackedPlanSource
        ? { trackedPlanSource: sourceTrackedPlanSource }
        : {}),
      ...(sourceTrackedPlanReviewStatus
        ? { trackedPlanReviewStatus: sourceTrackedPlanReviewStatus }
        : {}),
      ...(sourceHasOutstandingProposal !== undefined
        ? { hasOutstandingProposal: sourceHasOutstandingProposal }
        : {}),
      ...(sourceSelectedRepoId ? { selectedRepoId: sourceSelectedRepoId } : {}),
      // Show the source mode optimistically. Main restores the trusted source's
      // effective mode after sanitizing the renderer-supplied branch seed.
      // Session approval rules intentionally do not cross this branch boundary.
      ...(sourceApprovalMode ? { approvalMode: sourceApprovalMode } : {}),
      pendingSystemInstructions: withWorktreeRelocationInstruction(
        truncated || sourceExecutionHarness === 'opencode'
          ? undefined
          : sourcePendingSystemInstructions,
        sourceCwd,
        destinationCwd,
        { sourceBranch },
      ),
    };

    if (sourceExecutionHarness === 'opencode')
      prepareOpenCodeVisibleFork(branched);
    // Replace the new worktree's chat state before selecting it so the
    // composer never renders the fresh-worktree default tab/model first.
    set((state) => {
      const updated: WorktreeChatState = {
        tabs: [branched],
        activeTabId: branched.id,
      };
      return {
        worktreeChats: { ...state.worktreeChats, [newKey]: updated },
      };
    });
    hydratedKeys.add(newKey);

    // The new scope has no canonical tab yet, and the renderer holds only the
    // latest transcript page. Persist metadata alongside a main-owned, streamed
    // copy of the canonical source history so older pages and the referenced
    // tool-output artifact closure cannot be silently dropped. Keep the handoff
    // pending through this command because first-time scope activation can
    // publish an empty canonical snapshot while the write is in flight.
    const branchSeed = toPersistedTab(branched);
    branchSeed.messages = [];
    delete branchSeed.approvalMode;
    delete branchSeed.sessionApprovalRules;
    let canonicalBranchPersisted = false;
    let committedApprovalMode: ApprovalMode | undefined;
    let sourceApprovalChanged = false;
    try {
      const response = await chatBackendFor({
        projectId: sourceProjectId,
      }).chat.forkOpenWorktreeTabs({
        projectId: sourceProjectId,
        sourceWorktreeId,
        destinationWorktreeId: newWorktreeId,
        selectedTab: {
          sourceTabId,
          destinationTab: branchSeed,
          ...(branchSeed.forkedFrom?.atMessageId
            ? { throughMessageId: branchSeed.forkedFrom.atMessageId }
            : {}),
        },
      });
      if (response.failureCode === 'source_approval_changed') {
        sourceApprovalChanged = true;
      } else {
        committedApprovalMode = response.selectedTabApprovalMode;
        canonicalBranchPersisted = committedApprovalMode !== undefined;
      }
    } catch {
      // The IPC response can be lost after main durably commits the copy. Read
      // the destination authority before rolling back so an ambiguous transport
      // failure cannot delete a branch that was actually created.
      try {
        const canonical = await chatBackendFor({
          projectId: sourceProjectId,
        }).chat.getState({
          projectId: sourceProjectId,
          worktreeId: newWorktreeId,
        });
        const committedTab = canonical.tabsFile.tabs.find(
          (tab) => tab.id === branchSeed.id,
        );
        committedApprovalMode = committedTab?.approvalMode;
        canonicalBranchPersisted = committedApprovalMode !== undefined;
      } catch {
        // The canonical copy remains unconfirmed, so roll back below.
      }
    }
    if (!canonicalBranchPersisted) {
      try {
        await useProjectsStore
          .getState()
          .archiveWorktree(sourceProjectId, newWorktreeId, {
            deleteBranch: true,
          });
      } catch {
        return {
          status: 'failed',
          message:
            'The branched transcript could not be saved, and its worktree could not be removed.',
          retryable: false,
        };
      } finally {
        finishBranchHandoff();
      }
      return {
        status: 'failed',
        message: sourceApprovalChanged
          ? 'The source chat changed before it could be branched.'
          : 'The branched transcript could not be saved.',
        retryable: sourceApprovalChanged,
      };
    }

    set((state) => {
      const destination = state.worktreeChats[newKey];
      if (!destination || committedApprovalMode === undefined) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [newKey]: {
            ...destination,
            tabs: destination.tabs.map((tab) =>
              tab.id === branched.id
                ? { ...tab, approvalMode: committedApprovalMode }
                : tab,
            ),
          },
        },
      };
    });

    finishBranchHandoff();
    get().selectWorktree(sourceProjectId, newWorktreeId);

    const branchNamingText = buildBranchChatNamingText(branched);
    if (branchNamingText) {
      useProjectsStore
        .getState()
        .enqueuePendingTaskBranchNaming(
          sourceProjectId,
          newWorktreeId,
          branchNamingText,
          {
            chatId: branched.id,
            ...(sourceSelectedRepoId
              ? { selectedRepoId: sourceSelectedRepoId }
              : {}),
          },
        );
    }

    if (clonedPluginSelections) {
      requestTabDiscovery({
        projectId: sourceProjectId,
        worktreeId: newWorktreeId,
        chatId: branched.id,
        pluginSelections: clonedPluginSelections,
        providerType: resolveDiscoveryProviderType(branched),
      });
    }

    if (
      sourceExecutionHarness === 'codex' &&
      sourceSdkSessionId &&
      !truncated
    ) {
      const sourceThreadId = sourceSdkSessionId;
      const branchedTabId = branched.id;
      const branchBaselineMessageCount = clonedMessages.length;
      const target = {
        projectId: sourceProjectId,
        worktreeId: newWorktreeId,
      };
      const repoId = sourceSelectedRepoId;
      void (async (): Promise<void> => {
        let forkedThreadIdToRollback: string | null = null;
        try {
          const { forkedThreadId } = await chatBackendFor(
            target,
          ).chat.forkCodexThread({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            chatId: branchedTabId,
            ...(repoId ? { selectedRepoId: repoId } : {}),
            sourceThreadId,
            sourceProjectId,
            sourceWorktreeId,
            sourceChatId: sourceTabId,
            ...(clonedPluginSelections
              ? { pluginSelections: clonedPluginSelections }
              : {}),
            modelConfig: codexSpeedFields(sourceCodexSpeed),
            codexFastModeEnabled: sourceCodexFastModeEnabled,
          });
          let shouldPersistForkedThreadId = false;
          set((state) => {
            const currentWc = state.worktreeChats[worktreeKey(target)];
            if (!currentWc) return state;
            const currentBranchedTab = currentWc.tabs.find(
              (tab) => tab.id === branchedTabId,
            );
            if (!currentBranchedTab) return state;
            const shouldBackfillForkedThreadId =
              !currentBranchedTab.sdkSessionId &&
              currentBranchedTab.messages.length === branchBaselineMessageCount;
            if (!shouldBackfillForkedThreadId) {
              return state;
            }
            shouldPersistForkedThreadId = true;
            const updatedTabs = currentWc.tabs.map((t) =>
              t.id === branchedTabId
                ? { ...t, sdkSessionId: forkedThreadId }
                : t,
            );
            const updated: WorktreeChatState = {
              ...currentWc,
              tabs: updatedTabs,
            };
            return {
              worktreeChats: {
                ...state.worktreeChats,
                [worktreeKey(target)]: updated,
              },
            };
          });
          // Canonical tab creation above can succeed before the destination's
          // revision stream is registered locally. Persist the async backfill
          // through the command port even when that scope is not live yet.
          if (shouldPersistForkedThreadId) {
            forkedThreadIdToRollback = forkedThreadId;
            let disposition = await get().dispatchChatCommand(target, {
              type: 'chat.patch_tab_settings',
              tabId: branchedTabId,
              patch: { sdkSessionId: forkedThreadId },
            });
            if (
              (disposition === 'transport_failed' ||
                disposition === 'conflict') &&
              (await waitForChatScopeLive(target.projectId, target.worktreeId))
            ) {
              disposition = await get().dispatchChatCommand(target, {
                type: 'chat.patch_tab_settings',
                tabId: branchedTabId,
                patch: { sdkSessionId: forkedThreadId },
              });
            }
            if (disposition === 'transport_failed') {
              let canonicalPersistenceConfirmed: boolean | null = null;
              if (typeof chatBackendFor(target).chat.getState === 'function') {
                try {
                  const snapshot =
                    await chatBackendFor(target).chat.getState(target);
                  canonicalPersistenceConfirmed = snapshot.tabsFile.tabs.some(
                    (tab) =>
                      tab.id === branchedTabId &&
                      tab.sdkSessionId === forkedThreadId,
                  );
                } catch {
                  // The write remains ambiguous, so preserve the optimistic ID.
                }
              }
              if (canonicalPersistenceConfirmed) {
                disposition = 'accepted';
              } else if (canonicalPersistenceConfirmed === null) {
                forkedThreadIdToRollback = null;
                // eslint-disable-next-line no-console
                console.warn(
                  '[chat-branch] Codex thread persistence could not be confirmed; preserving the forked session until canonical state refreshes.',
                );
                return;
              }
            }
            if (disposition === 'accepted') {
              forkedThreadIdToRollback = null;
              get().dismissChatStateNotice(target.projectId, target.worktreeId);
            }
            if (disposition !== 'accepted') {
              throw new Error('Failed to persist the branched Codex thread');
            }
          }
        } catch (error: unknown) {
          if (forkedThreadIdToRollback) {
            const rejectedForkedThreadId = forkedThreadIdToRollback;
            set((state) => {
              const currentWc = state.worktreeChats[worktreeKey(target)];
              if (!currentWc) return state;
              const updatedTabs = currentWc.tabs.map((tab) =>
                tab.id === branchedTabId &&
                tab.sdkSessionId === rejectedForkedThreadId
                  ? { ...tab, sdkSessionId: undefined }
                  : tab,
              );
              return {
                worktreeChats: {
                  ...state.worktreeChats,
                  [worktreeKey(target)]: {
                    ...currentWc,
                    tabs: updatedTabs,
                  },
                },
              };
            });
          }
          // eslint-disable-next-line no-console
          console.warn(
            '[chat-branch] Codex thread/fork failed; branched tab will start a fresh session.',
            error,
          );
        }
      })();
    }
    return {
      status: 'created',
      projectId: sourceProjectId,
      worktreeId: newWorktreeId,
    };
  },

  openFileTab: (
    { absolutePath, filename, initialViewMode },
    target,
    options,
  ): string | null => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return null;

    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    const existing = wc?.tabs.find(
      (t) => t.kind === 'file' && t.filePath === absolutePath,
    );
    const previousChat = wc?.tabs.find(
      (candidate) =>
        candidate.id === wc.activeTabId && candidate.kind !== 'file',
    );
    if (existing) {
      // An explicit open must show current content. Start the check before
      // activation so the viewer's inactive-to-active read coalesces with it.
      desktopFileSessionController.refreshTab(existing.id);
      if (options?.activate !== false) {
        announceFilePanelOpen({
          worktreeKey: key,
          fileTabId: existing.id,
          previousChatTabId: previousChat?.id ?? null,
        });
        get().switchTab(existing.id, sel);
      }
      return existing.id;
    }
    // Nothing is selected to preserve, so a background open behaves normally.
    const preservedTabId =
      options?.activate === false && wc?.activeTabId ? wc.activeTabId : null;
    // Resolved once so local state and the canonical command start identical.
    const viewMode = resolveNewFileTabViewMode(
      { projectId: sel.projectId, worktreeId: sel.worktreeId, absolutePath },
      initialViewMode,
    );

    const tab: ChatTab = {
      id: nextTabId(),
      title: filename,
      kind: 'file',
      filePath: absolutePath,
      description: absolutePath,
      ...(viewMode ? { fileViewMode: viewMode } : {}),
      messages: [],
      status: 'idle',
      error: null,
      createdAt: new Date().toISOString(),
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      },
      fastModeExplicit: false,
    };

    if (preservedTabId === null) {
      announceFilePanelOpen({
        worktreeKey: key,
        fileTabId: tab.id,
        previousChatTabId: previousChat?.id ?? null,
      });
    }
    const revisionedLive = isScopeRevisionedLive(
      get(),
      sel.projectId,
      sel.worktreeId,
    );
    const activationToken =
      revisionedLive && preservedTabId === null
        ? beginOptimisticActiveTabSelection(
            sel.projectId,
            sel.worktreeId,
            tab.id,
          )
        : undefined;
    set((state) => {
      const currentWc = state.worktreeChats[key];
      const updated: WorktreeChatState = {
        ...currentWc,
        tabs: relabelFileTabs(currentWc ? [...currentWc.tabs, tab] : [tab]),
        activeTabId: preservedTabId ?? tab.id,
      };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
    // Durable tab identity is main-owned: commit the new file tab so a later
    // activation, reload, or restart sees it canonically.
    if (revisionedLive) {
      const command: Extract<ChatCommand, { type: 'chat.create_file_tab' }> = {
        type: 'chat.create_file_tab',
        tabId: tab.id,
        filePath: absolutePath,
        title: filename,
        ...(viewMode ? { viewMode } : {}),
        ...(options?.activate === false ? { activate: false } : {}),
      };
      const creation =
        options?.activate === false
          ? get().dispatchChatCommand(sel, command)
          : dispatchFileTabCreation(
              get,
              sel,
              command,
              activationToken ??
                beginOptimisticActiveTabSelection(
                  sel.projectId,
                  sel.worktreeId,
                  tab.id,
                ),
            );
      registerPendingTabCreation(
        sel.projectId,
        sel.worktreeId,
        tab.id,
        creation,
      );
    }
    return tab.id;
  },

  createEmptyFileTab: (target): string | null => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return null;

    const key = worktreeKey(sel);
    const tab: ChatTab = {
      id: nextTabId(),
      title: 'Open file',
      kind: 'file',
      filePath: '',
      description: '',
      messages: [],
      status: 'idle',
      error: null,
      createdAt: new Date().toISOString(),
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      },
      fastModeExplicit: false,
    };

    const activationToken = isScopeRevisionedLive(
      get(),
      sel.projectId,
      sel.worktreeId,
    )
      ? beginOptimisticActiveTabSelection(sel.projectId, sel.worktreeId, tab.id)
      : undefined;
    set((state) => {
      const currentWc = state.worktreeChats[key];
      const updated: WorktreeChatState = {
        ...currentWc,
        tabs: currentWc ? [...currentWc.tabs, tab] : [tab],
        activeTabId: tab.id,
      };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
    if (activationToken !== undefined) {
      const creation = dispatchFileTabCreation(
        get,
        sel,
        {
          type: 'chat.create_file_tab',
          tabId: tab.id,
          filePath: '',
          title: tab.title,
        },
        activationToken,
      );
      registerPendingTabCreation(
        sel.projectId,
        sel.worktreeId,
        tab.id,
        creation,
      );
    }
    return tab.id;
  },

  assignFileTab: (tabId, { absolutePath, filename }, target): string | null => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return null;

    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    const tab = wc?.tabs.find((t) => t.id === tabId && t.kind === 'file');
    if (!tab) return null;

    // Global "already open" rule: activate the existing tab for this file
    // instead of showing the same file twice.
    const existing = wc?.tabs.find(
      (t) => t.kind === 'file' && t.id !== tabId && t.filePath === absolutePath,
    );
    if (existing) {
      desktopFileSessionController.refreshTab(existing.id);
      get().switchTab(existing.id, sel);
      return existing.id;
    }

    // The newly assigned file never inherits the tab's previous view mode.
    const viewMode = resolveNewFileTabViewMode({
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      absolutePath,
    });
    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;
      const tabs = currentWc.tabs.map((candidate) => {
        if (candidate.id !== tabId || candidate.kind !== 'file') {
          return candidate;
        }
        const assigned: ChatTab = {
          ...candidate,
          title: filename,
          filePath: absolutePath,
          description: absolutePath,
        };
        if (viewMode) assigned.fileViewMode = viewMode;
        else delete assigned.fileViewMode;
        return assigned;
      });
      const updated: WorktreeChatState = {
        ...currentWc,
        tabs: relabelFileTabs(tabs),
        activeTabId: tabId,
      };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
    if (isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)) {
      void get().dispatchChatCommand(
        { projectId: sel.projectId, worktreeId: sel.worktreeId },
        {
          type: 'chat.patch_tab_settings',
          tabId,
          patch: {
            filePath: absolutePath,
            title: filename,
            fileViewMode: viewMode ?? null,
          },
        },
      );
    }
    return tabId;
  },

  setFileTabViewMode: (tabId, mode, target, diffContext): void => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return;
    // Stamped at the click so a slower close of this tab cannot overwrite it.
    const sequence = nextFileViewModeSequence();
    const tab = get().worktreeChats[worktreeKey(sel)]?.tabs.find(
      (candidate) => candidate.id === tabId && candidate.kind === 'file',
    );
    if (!tab) return;
    // The committed delta (including a subsequent close or reassignment) may
    // arrive before this command's reply. Keep the choice's original identity.
    const identity = {
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      absolutePath: tab.filePath,
    };
    const rememberAppliedMode = (): void => {
      if (mode === 'diff') {
        rememberFileViewModeBeforeDiff(identity, tab.fileViewMode, {
          sequence,
          tabId,
        });
        return;
      }
      rememberFileViewModeChoice(identity, mode, { sequence, tabId });
    };

    // Canonical scopes publish the accepted mode atomically with its comparison.
    // Showing an optimistic mode here lets an earlier command's delta overwrite
    // a later click (preview → diff → raw) before that later command commits.
    if (isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)) {
      void (async (): Promise<void> => {
        const command = {
          type: 'chat.patch_tab_settings' as const,
          tabId,
          patch: {
            fileViewMode: mode,
            ...(diffContext ? { fileDiffContext: diffContext } : {}),
          },
        };
        let disposition = await get().dispatchChatCommand(sel, command);
        if (
          (disposition === 'transport_failed' || disposition === 'conflict') &&
          (await waitForChatScopeLive(sel.projectId, sel.worktreeId))
        ) {
          disposition = await get().dispatchChatCommand(sel, command);
        }
        if (disposition === 'accepted') {
          rememberAppliedMode();
          get().dismissChatStateNotice(sel.projectId, sel.worktreeId);
        }
      })();
      return;
    }

    rememberAppliedMode();
    const key = worktreeKey(sel);
    let changed = false;
    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;

      const tabs = currentWc.tabs.map((tab) => {
        if (tab.id !== tabId || tab.kind !== 'file') {
          return tab;
        }
        if (tab.fileViewMode === mode && !diffContext) {
          return tab;
        }
        changed = true;
        return {
          ...tab,
          fileViewMode: mode,
          ...(diffContext ? { fileDiffContext: diffContext } : {}),
        };
      });

      if (!changed) {
        return state;
      }

      const updated: WorktreeChatState = { ...currentWc, tabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
  },

  closeTab: (tabId, options): void => {
    // Resolve the close target: either an explicit (projectId, worktreeId)
    // pair (used by async save-then-close paths so a worktree switch in
    // flight doesn't redirect the close) or the currently selected
    // worktree.
    let projectId: string;
    let worktreeId: string;
    if (options?.projectId && options?.worktreeId) {
      projectId = options.projectId;
      worktreeId = options.worktreeId;
    } else {
      const sel = get().selectedWorktree;
      if (!sel) return;
      projectId = sel.projectId;
      worktreeId = sel.worktreeId;
    }
    const key = `${projectId}/${worktreeId}`;

    // Find the tab inside the resolved worktree's tabs (NOT the selected
    // worktree's). This matters for the async save-then-close path that
    // keeps closing the originating tab even after the user switched
    // worktrees.
    const targetWc = get().worktreeChats[key];
    if (!targetWc) return;
    const tab = targetWc.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const eagerCreation = pendingEagerChatCreation({
      projectId,
      worktreeId,
      chatId: tabId,
    });
    if (eagerCreation) {
      void eagerCreation.then((ready) => {
        if (ready) get().closeTab(tabId, { ...options, projectId, worktreeId });
      });
      return;
    }
    if (get().closingChatTabs[key]?.has(tabId)) return;
    const createdFallbackTabRef: { current: ChatTab | null } = {
      current: null,
    };
    const closeSequence = nextFileViewModeSequence();

    // Dirty-file-tab guard. If the tab is a file tab with unsaved edits
    // and the caller did not pass `force: true`, route to either an auto
    // save-then-close (Auto Save on) or the unsaved-changes modal.
    if (tab.kind === 'file' && options?.force !== true) {
      if (desktopFileSessionController.isDirty(tabId)) {
        const fileKey = desktopFileSessionController.getFileKey(tabId);
        const closeTarget = { projectId, worktreeId, tabId };
        if (useFileTabUiStore.getState().autoSaveEnabled) {
          void desktopFileSessionController.saveTab(tabId).then((saved) => {
            if (!saved) return; // editor surfaces the shared error
            // Re-check dirty: edits made while the snapshot was being written
            // must NOT be discarded. saveFile() recomputes dirty against the
            // latest buffer vs. the snapshot it wrote, so a still-dirty session
            // means newer edits exist. Leave the tab open; the autosave debounce
            // will schedule the next save, and the user can close again.
            if (desktopFileSessionController.isDirty(tabId)) return;
            // The tab must still be registered to the SAME canonical key before
            // forcing the close (guards against a replacement file identity).
            if (
              fileKey &&
              !desktopFileSessionController.matches(tabId, fileKey)
            ) {
              return;
            }
            // Identity check: ensure the tab is still in its original worktree
            // before forcing the close.
            const wc = chatStoreApi().getState().worktreeChats[key];
            if (!wc || !wc.tabs.some((t) => t.id === tabId)) return;
            chatStoreApi().getState().closeTab(closeTarget.tabId, {
              force: true,
              projectId: closeTarget.projectId,
              worktreeId: closeTarget.worktreeId,
            });
          });
        } else if (fileKey) {
          useFileTabUiStore.getState().requestUnsavedClose({
            tabId,
            fileKey,
            projectId,
            worktreeId,
            title: tab.title,
            filePath: tab.filePath ?? '',
          });
        }
        // Dirty with no registered session key means there is no shared buffer
        // to save (pathological race) — fall through to the normal close below
        // instead of binding the modal to an empty identity.
        if (useFileTabUiStore.getState().autoSaveEnabled || fileKey) {
          return;
        }
      }
    }

    const queuedHookQueueId = getOnlyQueuedHookPlaceholderQueueId(tab);

    // Never drop a live/active chat from the persisted tabs file on close.
    // Mirror `closeTabs`: a streaming / queued / pending-plan-exit chat is left
    // open until the user explicitly stops it, so the close can neither race
    // the active-chat path nor archive a half-written transcript. A queued hook
    // placeholder with only the hook prompt is the one exception: closing it
    // cancels the main-process queue entry, then removes the transient tab.
    // A chat whose managed delegates or provider background agents and
    // workflows are still running also stays open (even with its own turn
    // finished); that refusal says why.
    const closeBlocker = getChatTabCloseBlocker(tab, projectId, worktreeId);
    if (closeBlocker !== null) {
      notifyCloseBlocked([closeBlocker]);
      return;
    }

    // Background transcripts may not be hydrated. Use the durable message
    // count when deciding whether closing a chat must preserve its history.
    const shouldArchive =
      shouldArchiveChatTargetOnClose(projectId, worktreeId) &&
      queuedHookQueueId === null &&
      tab.kind !== 'file' &&
      (tab.transcript?.messageCount ??
        tab.transcript?.committedMessageCount ??
        tab.messages.length) > 0;

    const markClosePending = (): void => {
      set((state) => {
        const current = state.closingChatTabs[key] ?? new Set<string>();
        if (current.has(tabId)) return state;
        const pending = new Set(current);
        pending.add(tabId);
        return {
          closingChatTabs: {
            ...state.closingChatTabs,
            [key]: pending,
          },
        };
      });
    };

    const clearClosePending = (): void => {
      set((state) => {
        const current = state.closingChatTabs[key];
        if (!current?.has(tabId)) return state;
        const remaining = new Set(current);
        remaining.delete(tabId);
        const closingChatTabs = { ...state.closingChatTabs };
        if (remaining.size === 0) {
          delete closingChatTabs[key];
        } else {
          closingChatTabs[key] = remaining;
        }
        return { closingChatTabs };
      });
    };

    const finalizeClose = (resolvedReplacementTab?: ChatTab): void => {
      const currentTab = get().worktreeChats[key]?.tabs.find(
        (t) => t.id === tabId,
      );
      const closedTab =
        currentTab !== undefined &&
        currentTab.kind === tab.kind &&
        currentTab.filePath === tab.filePath
          ? currentTab
          : tab;
      rememberClosedFileTabViewModes(
        projectId,
        worktreeId,
        [closedTab],
        closeSequence,
      );
      if (tab.kind !== 'file') {
        void useClaudeTerminalStore
          .getState()
          .cleanup(projectId, worktreeId, tabId, 'chat-closed')
          .catch(() => {});
      }

      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;

        const remaining = wc.tabs.filter((t) => t.id !== tabId);

        let updated: WorktreeChatState | null = null;
        if (remaining.length === 0) {
          if (!hydratedKeys.has(key)) {
            const nextChats = { ...state.worktreeChats };
            delete nextChats[key];
            const nextPendingQuestions = removePendingQuestionsForChats(
              state.pendingQuestions,
              projectId,
              worktreeId,
              [tabId],
            );
            const nextPendingApprovals = removePendingApprovalsForChats(
              state.pendingApprovals,
              projectId,
              worktreeId,
              [tabId],
            );

            let nextUnread = state.unreadWorktreeKeys;
            if (nextUnread.has(key)) {
              nextUnread = new Set(
                Array.from(nextUnread).filter((entry) => entry !== key),
              );
            }

            return {
              worktreeChats: nextChats,
              unreadWorktreeKeys: nextUnread,
              pendingQuestions: nextPendingQuestions,
              pendingApprovals: nextPendingApprovals,
            };
          }

          const replacement =
            resolvedReplacementTab ??
            createResolvedReplacementTab(
              state,
              projectId,
              worktreeId,
              nextTabId(),
            );
          updated = {
            tabs: [replacement],
            activeTabId: replacement.id,
            lastActiveEditableChatId: replacement.id,
            ...(resolveTabProviderType(replacement)
              ? { lastActiveChatProvider: resolveTabProviderType(replacement) }
              : {}),
          };
          createdFallbackTabRef.current = updated.tabs[0] ?? null;
        } else {
          // Pick new active tab if the closed one was active
          const newActiveId =
            wc.activeTabId === tabId
              ? remaining[remaining.length - 1].id
              : wc.activeTabId;
          // Clear unread and stamp attentionDismissedAt on the newly-active
          // tab (mirrors switchTab behaviour) so overview dismissal persists
          // across restarts.
          const dismissedAt = Date.now();
          const tabs = remaining.map((t) =>
            t.id === newActiveId && t.kind !== 'file'
              ? { ...t, unread: false, attentionDismissedAt: dismissedAt }
              : t,
          );
          updated = buildClosedTabsState(wc, tabs, newActiveId);
        }

        if (!updated) {
          return state;
        }
        const nextUnread = pruneUnreadWorktreeKey(
          state.unreadWorktreeKeys,
          key,
          updated.tabs,
        );

        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
          unreadWorktreeKeys: nextUnread,
          pendingQuestions: removePendingQuestionsForChats(
            state.pendingQuestions,
            projectId,
            worktreeId,
            [tabId],
          ),
          pendingApprovals: removePendingApprovalsForChats(
            state.pendingApprovals,
            projectId,
            worktreeId,
            [tabId],
          ),
        };
      });
      get().clearTabDraft(tabId);
      get().clearPendingEditorSelections(tabId);
      clearChatScrollPosition(tabId);
      useIngestionLagStore.getState().clearForChat({
        projectId,
        worktreeId,
        chatId: tabId,
      });
      // A closed chat can't send again to clear its app-level Ollama failure.
      useOllamaConnectionBannerStore
        .getState()
        .clearChat({ projectId, worktreeId, chatId: tabId });
      // Release the shared file session for the closed tab (no-op for chat
      // tabs). Releasing the last tab reference drops `files[key]` so a reopen
      // reads disk; scroll positions are UI-local and cleared here.
      if (tab.kind === 'file') {
        desktopFileSessionController.releaseTab(tabId);
        clearEditorScrollPosition(tabId);
        clearFileViewerScrollPosition(tabId);
      }
      const createdFallbackTab = createdFallbackTabRef.current;
      if (createdFallbackTab) {
        scheduleEmptyTabPluginSelectionSanitization({
          projectId,
          worktreeId,
          chatId: createdFallbackTab.id,
          providerType: resolveDiscoveryProviderType(createdFallbackTab),
        });
      }
    };

    if (
      isScopeRevisionedLive(get(), projectId, worktreeId) &&
      queuedHookQueueId === null
    ) {
      // The read-only shared-container scope never gains a starter chat.
      const replacementTabId =
        targetWc.tabs.length === 1 &&
        hydratedKeys.has(key) &&
        projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID
          ? nextTabId()
          : undefined;
      const mode = shouldArchive
        ? ('archive' as const)
        : tab.kind === 'file' || !chatTabHasConversationContent(tab)
          ? ('discard_empty' as const)
          : ('discard' as const);
      markClosePending();
      const closeToken = beginOptimisticTabClose(projectId, worktreeId, [
        tabId,
      ]);
      void (async (): Promise<{
        disposition: ChatCommandDisposition;
        resolvedReplacementTab: ChatTab | undefined;
      }> => {
        const resolvedReplacementTab = replacementTabId
          ? await createPersistedReplacementTab(
              get(),
              projectId,
              worktreeId,
              replacementTabId,
            )
          : undefined;
        const disposition = await get().dispatchChatCommand(
          { projectId, worktreeId },
          {
            type: 'chat.close_tab',
            tabId,
            mode,
            ...(replacementTabId ? { replacementTabId } : {}),
            ...(resolvedReplacementTab
              ? {
                  replacementTab: replacementTabCommand(resolvedReplacementTab),
                }
              : {}),
          },
          {
            rollback: (): void =>
              rollbackOptimisticTabClose(projectId, worktreeId, closeToken),
            reconcile: (result): void =>
              confirmOptimisticTabClose(
                projectId,
                worktreeId,
                closeToken,
                result.revision,
              ),
          },
        );
        if (disposition !== 'accepted') {
          rollbackOptimisticTabClose(projectId, worktreeId, closeToken);
        }
        return { disposition, resolvedReplacementTab };
      })()
        .then(({ disposition, resolvedReplacementTab }) => {
          if (disposition === 'accepted') {
            finalizeClose(resolvedReplacementTab);
          }
          clearClosePending();
        })
        .catch((error: unknown) => {
          rollbackOptimisticTabClose(projectId, worktreeId, closeToken);
          clearClosePending();
          reportRendererConsoleError('Failed to prepare chat tab close', {
            error,
          });
        });
      return;
    }

    if (shouldArchive) {
      // Make the archive authoritative: snapshot the tab, hand it to the
      // backend, and only remove it from the live tabs file once the archive
      // write is confirmed. On failure we never call `finalizeClose`, so a
      // rejected archive can never silently delete the transcript (the tab
      // simply stays open).
      const chatApi = chatBackendFor({ projectId }).chat;
      if (typeof chatApi?.archiveTab !== 'function') {
        return;
      }
      markClosePending();
      void chatApi
        .archiveTab({ projectId, worktreeId, tabId: tab.id })
        .then((summaries) => {
          set((state) => ({
            archivedChats: { ...state.archivedChats, [key]: summaries },
          }));
          finalizeClose();
          clearClosePending();
        })
        .catch((error: unknown) => {
          clearClosePending();
          // eslint-disable-next-line no-console
          console.error('Failed to archive chat tab on close', error);
          set((state) =>
            chatArchiveRefusedNotice(state, projectId, worktreeId),
          );
        });
      return;
    }

    if (queuedHookQueueId !== null) {
      markClosePending();
      void localChatBackend()
        .chat.cancelQueuedHookChat({ queueId: queuedHookQueueId })
        .then(({ cancelled }) => {
          if (!cancelled) {
            clearClosePending();
            return;
          }
          finalizeClose();
          clearClosePending();
        })
        .catch(() => {
          clearClosePending();
          // Leave the placeholder intact so the user can retry closing it.
        });
      return;
    }

    finalizeClose();
    // Durable removal is main-owned. File tabs and blank starters discard as
    // empty; a contentful chat only reaches this path in the synthetic
    // sentinel scopes that never archive, where close hard-deletes (`discard`
    // — the service rejects that mode everywhere else).
    if (isScopeRevisionedLive(get(), projectId, worktreeId)) {
      const mode =
        tab.kind === 'file' || !chatTabHasConversationContent(tab)
          ? ('discard_empty' as const)
          : ('discard' as const);
      void get().dispatchChatCommand(
        { projectId, worktreeId },
        { type: 'chat.close_tab', tabId, mode },
      );
    }
  },

  closeTabs: (targetIds, target): void => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return;
    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    if (!wc) return;

    const targetIdSet = new Set(targetIds);

    const skippedBlockers: ChatCloseBlocker[] = [];
    const idsToClose = wc.tabs
      .filter((t) => {
        if (!targetIdSet.has(t.id)) return false;
        if (t.kind === 'file') {
          // Batch close skips shared-dirty file tabs entirely.
          return !desktopFileSessionController.isDirty(t.id);
        }
        // Same guard as `closeTab`: busy chats (active turn, live delegates
        // or provider background work) are left open.
        const blocker = getChatTabCloseBlocker(
          t,
          sel.projectId,
          sel.worktreeId,
        );
        if (blocker !== null) skippedBlockers.push(blocker);
        return blocker === null;
      })
      .map((t) => t.id);

    // One notice for the whole gesture.
    notifyCloseBlocked(skippedBlockers);
    if (idsToClose.length === 0) return;

    const idsToCloseSet = new Set(idsToClose);
    const createdFallbackTabRef: { current: ChatTab | null } = {
      current: null,
    };
    const closeSequence = nextFileViewModeSequence();
    const fileTabIdsToClose = wc.tabs
      .filter((t) => idsToCloseSet.has(t.id) && t.kind === 'file')
      .map((t) => t.id);
    const chatTabIdsToClose = wc.tabs
      .filter((t) => idsToCloseSet.has(t.id) && t.kind !== 'file')
      .map((t) => t.id);
    // Archive (rather than hard-delete) chat tabs that have sent ≥1 message.
    // Streaming / queued / pending-plan-exit tabs were already filtered out of
    // `idsToClose` above, so every snapshot here is of an idle chat.
    const archiveTargets = wc.tabs
      .filter(
        (t) =>
          shouldArchiveChatTargetOnClose(sel.projectId, sel.worktreeId) &&
          idsToCloseSet.has(t.id) &&
          getOnlyQueuedHookPlaceholderQueueId(t) === null &&
          t.kind !== 'file' &&
          (t.transcript?.messageCount ??
            t.transcript?.committedMessageCount ??
            t.messages.length) > 0,
      )
      .map((t) => ({ tabId: t.id }));
    const archiveTargetIds = new Set(
      archiveTargets.map((target) => target.tabId),
    );
    const nonArchiveIdsToClose = idsToClose.filter(
      (id) => !archiveTargetIds.has(id),
    );
    // Durable removal is main-owned. File tabs and blank starters discard as
    // empty; contentful non-archive closes only occur in the synthetic
    // sentinel scopes that never archive (`discard`). Queued hook
    // placeholders never reach canonical state.
    const discardModeById = new Map<string, 'discard_empty' | 'discard'>(
      wc.tabs
        .filter(
          (t) =>
            idsToCloseSet.has(t.id) &&
            !archiveTargetIds.has(t.id) &&
            t.queuedHookPlaceholder !== true,
        )
        .map((t) => [
          t.id,
          t.kind === 'file' || !chatTabHasConversationContent(t)
            ? 'discard_empty'
            : 'discard',
        ]),
    );
    const closeQueuedHookPlaceholders = async (
      closeIds: string[],
    ): Promise<string[]> => {
      const closeIdSet = new Set(closeIds);
      const queuedHookTargets = wc.tabs
        .filter((tab) => closeIdSet.has(tab.id))
        .map((tab) => ({
          tabId: tab.id,
          queueId: getOnlyQueuedHookPlaceholderQueueId(tab),
        }))
        .filter(
          (target): target is { tabId: string; queueId: string } =>
            target.queueId !== null,
        );

      if (queuedHookTargets.length === 0) {
        return closeIds;
      }

      const nextCloseIds = new Set(closeIds);
      for (const target of queuedHookTargets) {
        try {
          const { cancelled } =
            await localChatBackend().chat.cancelQueuedHookChat({
              queueId: target.queueId,
            });
          if (!cancelled) {
            nextCloseIds.delete(target.tabId);
          }
        } catch {
          nextCloseIds.delete(target.tabId);
        }
      }

      return closeIds.filter((id) => nextCloseIds.has(id));
    };

    const finalizeClose = (
      closeIds: string[],
      summaries: ArchivedChatSummary[] | null,
      resolvedReplacementTab?: ChatTab,
    ): void => {
      const closeIdSet = new Set(closeIds);
      const currentTabs = get().worktreeChats[key]?.tabs ?? [];
      rememberClosedFileTabViewModes(
        sel.projectId,
        sel.worktreeId,
        closeIds.flatMap((id) => {
          const original = wc.tabs.find((t) => t.id === id);
          if (!original) return [];
          const current = currentTabs.find((t) => t.id === id);
          const closed =
            current !== undefined &&
            current.kind === original.kind &&
            current.filePath === original.filePath
              ? current
              : original;
          return [closed];
        }),
        closeSequence,
      );
      set((state) => {
        const current = state.worktreeChats[key];
        if (!current) return state;

        const remaining = current.tabs.filter((t) => !closeIdSet.has(t.id));

        let updated: WorktreeChatState | null = null;
        if (remaining.length === 0) {
          if (!hydratedKeys.has(key)) {
            const nextChats = { ...state.worktreeChats };
            delete nextChats[key];
            const nextPendingQuestions = removePendingQuestionsForChats(
              state.pendingQuestions,
              sel.projectId,
              sel.worktreeId,
              closeIdSet,
            );
            const nextPendingApprovals = removePendingApprovalsForChats(
              state.pendingApprovals,
              sel.projectId,
              sel.worktreeId,
              closeIdSet,
            );

            let nextUnread = state.unreadWorktreeKeys;
            if (nextUnread.has(key)) {
              nextUnread = new Set(
                Array.from(nextUnread).filter((entry) => entry !== key),
              );
            }

            return {
              worktreeChats: nextChats,
              unreadWorktreeKeys: nextUnread,
              pendingQuestions: nextPendingQuestions,
              pendingApprovals: nextPendingApprovals,
              ...(summaries
                ? {
                    archivedChats: { ...state.archivedChats, [key]: summaries },
                  }
                : {}),
            };
          }

          const replacement =
            resolvedReplacementTab ??
            createResolvedReplacementTab(
              state,
              sel.projectId,
              sel.worktreeId,
              nextTabId(),
            );
          updated = {
            tabs: [replacement],
            activeTabId: replacement.id,
            lastActiveEditableChatId: replacement.id,
            ...(resolveTabProviderType(replacement)
              ? { lastActiveChatProvider: resolveTabProviderType(replacement) }
              : {}),
          };
          createdFallbackTabRef.current = updated.tabs[0] ?? null;
        } else {
          let newActiveId = current.activeTabId;
          if (closeIdSet.has(current.activeTabId)) {
            const previousActiveIndex = current.tabs.findIndex(
              (t) => t.id === current.activeTabId,
            );
            const nextActive =
              remaining[Math.min(previousActiveIndex, remaining.length - 1)];
            if (!nextActive) {
              return state;
            }
            newActiveId = nextActive.id;
          }

          const dismissedAt = Date.now();
          const tabs = remaining.map((t) =>
            t.id === newActiveId && t.kind !== 'file'
              ? { ...t, unread: false, attentionDismissedAt: dismissedAt }
              : t,
          );
          updated = buildClosedTabsState(current, tabs, newActiveId);
        }
        const stillHasUnread = updated.tabs.some((t) => t.unread === true);
        let nextUnread = state.unreadWorktreeKeys;
        if (!stillHasUnread && nextUnread.has(key)) {
          nextUnread = new Set(Array.from(nextUnread).filter((k) => k !== key));
        }

        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
          unreadWorktreeKeys: nextUnread,
          pendingQuestions: removePendingQuestionsForChats(
            state.pendingQuestions,
            sel.projectId,
            sel.worktreeId,
            closeIdSet,
          ),
          pendingApprovals: removePendingApprovalsForChats(
            state.pendingApprovals,
            sel.projectId,
            sel.worktreeId,
            closeIdSet,
          ),
          ...(summaries
            ? { archivedChats: { ...state.archivedChats, [key]: summaries } }
            : {}),
        };
      });

      for (const id of closeIds) {
        get().clearTabDraft(id);
        get().clearPendingEditorSelections(id);
        clearChatScrollPosition(id);
        useIngestionLagStore.getState().clearForChat({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId: id,
        });
        useOllamaConnectionBannerStore.getState().clearChat({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId: id,
        });
      }
      for (const id of fileTabIdsToClose.filter((fileTabId) =>
        closeIdSet.has(fileTabId),
      )) {
        desktopFileSessionController.releaseTab(id);
        clearEditorScrollPosition(id);
        clearFileViewerScrollPosition(id);
      }
      const createdFallbackTab = createdFallbackTabRef.current;
      if (createdFallbackTab) {
        scheduleEmptyTabPluginSelectionSanitization({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId: createdFallbackTab.id,
          providerType: resolveDiscoveryProviderType(createdFallbackTab),
        });
      }
      for (const id of chatTabIdsToClose.filter((chatTabId) =>
        closeIdSet.has(chatTabId),
      )) {
        void useClaudeTerminalStore
          .getState()
          .cleanup(sel.projectId, sel.worktreeId, id, 'chat-closed')
          .catch(() => {});
      }
    };

    if (isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)) {
      let closeToken: number | undefined;
      void closeQueuedHookPlaceholders(idsToClose)
        .then(async (closeIds) => {
          if (closeIds.length === 0) return;
          // The read-only shared-container scope never gains a starter chat.
          const replacementTabId =
            closeIds.length === wc.tabs.length &&
            hydratedKeys.has(key) &&
            sel.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID
              ? nextTabId()
              : undefined;
          const resolvedReplacementTab = replacementTabId
            ? await createPersistedReplacementTab(
                get(),
                sel.projectId,
                sel.worktreeId,
                replacementTabId,
              )
            : undefined;
          const targets: Array<{
            tabId: string;
            mode: 'archive' | 'discard_empty' | 'discard';
          }> = [];
          for (const tabId of closeIds) {
            if (archiveTargetIds.has(tabId)) {
              targets.push({ tabId, mode: 'archive' });
              continue;
            }
            const mode = discardModeById.get(tabId);
            if (mode) targets.push({ tabId, mode });
          }

          if (targets.length === 0) {
            if (!resolvedReplacementTab) {
              finalizeClose(closeIds, null);
              return;
            }
            const disposition = await get().dispatchChatCommand(
              { projectId: sel.projectId, worktreeId: sel.worktreeId },
              replacementTabCommand(resolvedReplacementTab),
            );
            if (disposition === 'accepted') {
              finalizeClose(closeIds, null, resolvedReplacementTab);
            }
            return;
          }

          const activeCloseToken = beginOptimisticTabClose(
            sel.projectId,
            sel.worktreeId,
            targets.map((target) => target.tabId),
          );
          closeToken = activeCloseToken;
          const disposition = await get().dispatchChatCommand(
            { projectId: sel.projectId, worktreeId: sel.worktreeId },
            {
              type: 'chat.close_tabs',
              targets,
              ...(replacementTabId ? { replacementTabId } : {}),
              ...(resolvedReplacementTab
                ? {
                    replacementTab: replacementTabCommand(
                      resolvedReplacementTab,
                    ),
                  }
                : {}),
            },
            {
              rollback: (): void =>
                rollbackOptimisticTabClose(
                  sel.projectId,
                  sel.worktreeId,
                  activeCloseToken,
                ),
              reconcile: (result): void =>
                confirmOptimisticTabClose(
                  sel.projectId,
                  sel.worktreeId,
                  activeCloseToken,
                  result.revision,
                ),
            },
          );
          if (disposition !== 'accepted') {
            rollbackOptimisticTabClose(
              sel.projectId,
              sel.worktreeId,
              activeCloseToken,
            );
          }
          if (disposition === 'accepted') {
            finalizeClose(closeIds, null, resolvedReplacementTab);
          }
        })
        .catch((error: unknown) => {
          if (closeToken !== undefined) {
            rollbackOptimisticTabClose(
              sel.projectId,
              sel.worktreeId,
              closeToken,
            );
          }
          reportRendererConsoleError('Failed to prepare bulk chat tab close', {
            error,
          });
        });
      return;
    }

    if (archiveTargets.length === 0) {
      const hasQueuedHookPlaceholder = idsToClose.some((id) => {
        const target = wc.tabs.find((tab) => tab.id === id);
        return getOnlyQueuedHookPlaceholderQueueId(target) !== null;
      });
      if (!hasQueuedHookPlaceholder) {
        finalizeClose(idsToClose, null);
        return;
      }

      void closeQueuedHookPlaceholders(idsToClose).then((closeIds) => {
        if (closeIds.length > 0) {
          finalizeClose(closeIds, null);
        }
      });
      return;
    }

    const chatApi = chatBackendFor(sel).chat;
    if (typeof chatApi?.archiveTab !== 'function') {
      if (nonArchiveIdsToClose.length > 0) {
        void closeQueuedHookPlaceholders(nonArchiveIdsToClose).then(
          (closeIds) => {
            if (closeIds.length > 0) {
              finalizeClose(closeIds, null);
            }
          },
        );
      }
      return;
    }

    void (async (): Promise<void> => {
      let latest: ArchivedChatSummary[] | null = null;
      const archivedIdsToClose: string[] = [];
      for (const target of archiveTargets) {
        try {
          latest = await chatApi.archiveTab({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            tabId: target.tabId,
          });
          archivedIdsToClose.push(target.tabId);
        } catch (error: unknown) {
          // eslint-disable-next-line no-console
          console.error('Failed to archive chat tab on bulk close', error);
          set((state) =>
            chatArchiveRefusedNotice(state, sel.projectId, sel.worktreeId),
          );
          const closeIds = await closeQueuedHookPlaceholders([
            ...nonArchiveIdsToClose,
            ...archivedIdsToClose,
          ]);
          if (closeIds.length > 0) {
            finalizeClose(closeIds, latest);
          }
          return;
        }
      }
      const closeIds = await closeQueuedHookPlaceholders(idsToClose);
      if (closeIds.length > 0) {
        finalizeClose(closeIds, latest);
      }
    })();
  },

  switchTab: (tabId, target): void => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return;

    const key = worktreeKey(sel);
    const currentChatState = get().worktreeChats[key];
    const targetTab = currentChatState?.tabs.find((t) => t.id === tabId);
    // An explicit tab choice wins over a landing still waiting on the load.
    recordExplicitEntryTab(key, tabId);

    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      // Switching to a tab counts as viewing it — stamp attentionDismissedAt
      // so lingering plan reviews and stale-session banners survive a
      // restart as dismissed rather than resurfacing on the overview.
      const dismissedAt = Date.now();
      const tabs = wc.tabs.map((t) =>
        t.id === tabId
          ? { ...t, unread: false, attentionDismissedAt: dismissedAt }
          : t,
      );
      const updated = { ...activateTabInChatState(wc, tabId), tabs };
      const nextUnread = pruneUnreadWorktreeKey(
        state.unreadWorktreeKeys,
        key,
        updated.tabs,
      );

      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: updated,
        },
        unreadWorktreeKeys: nextUnread,
      };
    });

    // A queued hook placeholder is renderer-owned until its start event, so
    // main does not know the tab yet: selecting it stays local. Sending the
    // activation to main would be rejected and the refresh that follows
    // would hide the placeholder the user just opened. Once the chat starts,
    // `handleHookTabStarted` carries the selection over to main.
    if (
      targetTab?.queuedHookPlaceholder !== true &&
      isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)
    ) {
      // The optimistic state above keeps navigation immediate, while the
      // durable active/read/attention fields remain main-owned. Submit all
      // three immediately: they are independent idempotent patches, and the
      // main repository serializes their arrival for the scope.
      void Promise.all([
        dispatchRevisionedTabActivation(get, sel, tabId),
        get().dispatchChatCommand(sel, {
          type: 'chat.mark_read',
          chatId: tabId,
        }),
        get().dispatchChatCommand(sel, {
          type: 'chat.dismiss_attention',
          chatId: tabId,
        }),
      ]);
    }

    if (
      shouldRequestVisibleTabDiscovery({
        chatId: tabId,
        tab: targetTab,
        tabDiscoveryLoading: get().tabDiscoveryLoading,
      })
    ) {
      requestTabDiscovery({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId: tabId,
        pluginSelections:
          targetTab?.pluginSelections ??
          getDefaultPlugins(
            sel.projectId,
            sel.worktreeId,
            get().worktreeDefaultPlugins,
          ),
        providerType: resolveDiscoveryProviderType(targetTab),
      });
    }
  },

  reorderTabs: (fromTabId, beforeTabId, target): void => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return;
    if (beforeTabId === fromTabId) return;

    const key = worktreeKey(sel);
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;

      const fromIndex = wc.tabs.findIndex((t) => t.id === fromTabId);
      if (fromIndex === -1) return state;

      const next = wc.tabs.slice();
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return state;

      let insertIndex: number;
      if (beforeTabId === null) {
        insertIndex = next.length;
      } else {
        const idx = next.findIndex((t) => t.id === beforeTabId);
        if (idx === -1) return state;
        insertIndex = idx;
      }

      // Pinned tabs occupy positions [0, pinnedCount); unpinned tabs occupy
      // [pinnedCount, end). Clamp the insertion so a drag never crosses the
      // boundary in the array sense.
      const pinnedCount = next.filter((t) => t.pinned === true).length;
      if (moved.pinned === true) {
        insertIndex = Math.min(insertIndex, pinnedCount);
      } else {
        insertIndex = Math.max(insertIndex, pinnedCount);
      }

      if (insertIndex === fromIndex) return state;

      next.splice(insertIndex, 0, moved);
      const updated = { ...wc, tabs: next };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
    // Durable ordering is main-owned; commit the full resulting order.
    if (isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)) {
      const orderedIds =
        get().worktreeChats[key]?.tabs.map((tab) => tab.id) ?? [];
      if (orderedIds.length > 0) {
        void get().dispatchChatCommand(
          { projectId: sel.projectId, worktreeId: sel.worktreeId },
          { type: 'chat.reorder_tabs', tabIds: orderedIds },
        );
      }
    }
  },

  setTabPinned: (tabId, pinned, target): void => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return;
    const key = worktreeKey(sel);
    let changed = false;
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      const fromIndex = wc.tabs.findIndex((t) => t.id === tabId);
      if (fromIndex === -1) return state;
      const current = wc.tabs[fromIndex];
      const currentPinned = current.pinned === true;
      if (currentPinned === pinned) return state;
      changed = true;

      const remaining = wc.tabs.slice();
      remaining.splice(fromIndex, 1);
      const updatedTab: ChatTab = pinned
        ? { ...current, pinned: true }
        : ((): ChatTab => {
            const copy: ChatTab = { ...current };
            delete copy.pinned;
            return copy;
          })();

      // Boundary between pinned and unpinned tabs in the remaining list.
      // Pinning lands at the end of the pinned section; unpinning lands at
      // the start of the unpinned section. Both resolve to the same index.
      const insertIndex = remaining.filter((t) => t.pinned === true).length;
      const next = remaining.slice();
      next.splice(insertIndex, 0, updatedTab);

      const updated = { ...wc, tabs: next };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
    if (
      changed &&
      isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)
    ) {
      const orderedIds =
        get().worktreeChats[key]?.tabs.map((tab) => tab.id) ?? [];
      const scopeRevision = get().chatStateSync[key]?.revision;
      void (async (): Promise<void> => {
        let settingsRevision: number | undefined;
        const disposition = await get().dispatchChatCommand(
          sel,
          {
            type: 'chat.patch_tab_settings',
            tabId,
            patch: { pinned },
          },
          {
            ...(scopeRevision !== null && scopeRevision !== undefined
              ? { expectedRevision: scopeRevision }
              : {}),
            onResult: (result): void => {
              settingsRevision = result.revision;
            },
          },
        );
        if (
          disposition === 'accepted' &&
          settingsRevision !== undefined &&
          orderedIds.length > 0
        ) {
          await get().dispatchChatCommand(
            sel,
            {
              type: 'chat.reorder_tabs',
              tabIds: orderedIds,
            },
            { expectedRevision: settingsRevision },
          );
        }
      })();
    }
  },

  renameTab: async (tabId, customTitle, target): Promise<boolean> => {
    const sel = target ?? get().selectedWorktree;
    if (!sel) return false;
    const normalized = normalizeChatCustomTitle(customTitle);
    if (normalized === undefined) return false;
    const key = worktreeKey(sel);
    const phase = get().chatStateSync[key]?.phase;
    if (
      blockedPersistenceKeys.has(key) ||
      (phase !== undefined && phase !== 'live')
    )
      return false;
    const current = get().worktreeChats[key]?.tabs.find((t) => t.id === tabId);
    if (!current || current.kind === 'file') return false;
    const previous = current.customTitle;
    if ((previous ?? null) === normalized) return true;

    const applyCustomTitle = (
      expected: string | undefined,
      value: string | undefined,
    ): void => {
      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;
        const index = wc.tabs.findIndex((t) => t.id === tabId);
        if (index === -1 || wc.tabs[index].customTitle !== expected) {
          return state;
        }
        const updatedTab: ChatTab = { ...wc.tabs[index] };
        if (value === undefined) delete updatedTab.customTitle;
        else updatedTab.customTitle = value;
        const tabs = wc.tabs.slice();
        tabs[index] = updatedTab;
        return {
          worktreeChats: { ...state.worktreeChats, [key]: { ...wc, tabs } },
        };
      });
    };

    const optimistic = normalized ?? undefined;
    applyCustomTitle(previous, optimistic);
    const scopeRevision = get().chatStateSync[key]?.revision;
    const disposition = await get().dispatchChatCommand(
      sel,
      {
        type: 'chat.patch_tab_settings',
        tabId,
        patch: { customTitle: normalized },
      },
      {
        ...(scopeRevision !== null && scopeRevision !== undefined
          ? { expectedRevision: scopeRevision }
          : {}),
        // Undo only our own optimistic value, so a newer canonical name that
        // arrived meanwhile is never overwritten.
        rollback: (): void => applyCustomTitle(optimistic, previous),
      },
    );
    if (disposition !== 'accepted') {
      // Dispatch can refuse before registering the optimistic overlay. Also
      // reconcile ambiguous failures: main may have committed before IPC lost
      // the reply. Only a canonical refresh can resolve that outcome.
      applyCustomTitle(optimistic, previous);
      refreshChatScopeRevisioned(sel.projectId, sel.worktreeId);
    }
    return disposition === 'accepted';
  },

  suppressWorktreePersistence: (projectId, worktreeId): void => {
    const key = `${projectId}/${worktreeId}`;
    blockedPersistenceKeys.add(key);
    loadingKeys.delete(key);
    scheduleIdleChatUnload();
  },

  resumeWorktreePersistence: (projectId, worktreeId): void => {
    blockedPersistenceKeys.delete(`${projectId}/${worktreeId}`);
    scheduleIdleChatUnload();
  },

  flushWorktreeTabs: async (projectId, worktreeId): Promise<void> => {
    // Main owns canonical durability. Ask the repository to journal-flush and
    // checkpoint the scope so flows that consume the durable snapshot next
    // (workspace combine, container capture) read a current file.
    // An authority with no local journal has nothing to flush.
    await chatBackendFor({ projectId })
      .chat.flushScope({ projectId, worktreeId })
      .catch(ignoreUnavailable);
  },

  reloadWorktreeTabs: async (projectId, worktreeId): Promise<void> => {
    const key = `${projectId}/${worktreeId}`;
    clearWorktreeHydrationState(key);

    set((state) => {
      if (!state.worktreeChats[key]) return state;
      const nextChats = { ...state.worktreeChats };
      delete nextChats[key];
      return { worktreeChats: nextChats };
    });

    const selected = get().selectedWorktree;
    if (
      selected?.projectId === projectId &&
      selected.worktreeId === worktreeId
    ) {
      await get().loadTabs();
    }
    scheduleIdleChatUnload();
  },

  forkOpenTabsToWorktree: async ({
    projectId,
    sourceWorktreeId,
    destinationWorktreeId,
  }): Promise<ReadonlyMap<string, ForkedPanelTabBinding>> => {
    const destinationKey = `${projectId}/${destinationWorktreeId}`;
    const finishPendingFork = beginPendingWorktreeTabFork(
      projectId,
      destinationWorktreeId,
    );

    try {
      // Main owns the whole durable fork: it clones the canonical source scope
      // (settling a still-streaming transcript), forks Codex threads, carries
      // Claude session continuity, and commits the destination through the chat
      // state service. The renderer forks only its live panel layout (see
      // `forkOpenWorktreeState`) and refreshes its local projection.
      const { tabBindings } = await chatBackendFor({
        projectId,
      })
        .chat.forkOpenWorktreeTabs({
          projectId,
          sourceWorktreeId,
          destinationWorktreeId,
        })
        // An authority that serves no fork forks no tabs.
        .catch((error: unknown) => {
          if (isCapabilityUnavailable(error)) return { tabBindings: {} };
          throw error;
        });
      const bindings = new Map<string, ForkedPanelTabBinding>(
        Object.entries(tabBindings),
      );
      if (bindings.size === 0) return bindings;

      // Hydrate the destination now so selection never renders the generated
      // empty tab between creation and handoff.
      await get().loadAllWorktreeTabs([
        { projectId, worktreeId: destinationWorktreeId },
      ]);

      // `recheckAfterWorktreeSetup` is renderer presentation state: forked file
      // tabs re-verify their rewritten path once worktree setup completes.
      const forkedFileTabIds = new Set(
        Array.from(bindings.values())
          .filter((binding) => binding.destinationFilePath !== undefined)
          .map((binding) => binding.destinationTabId),
      );
      if (forkedFileTabIds.size > 0) {
        set((state) => {
          const wc = state.worktreeChats[destinationKey];
          if (!wc) return state;
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [destinationKey]: {
                ...wc,
                tabs: wc.tabs.map((tab) =>
                  forkedFileTabIds.has(tab.id)
                    ? { ...tab, recheckAfterWorktreeSetup: true }
                    : tab,
                ),
              },
            },
          };
        });
      }

      const destinationState = get().worktreeChats[destinationKey];
      for (const tab of destinationState?.tabs ?? []) {
        if (tab.kind === 'file' || !tab.pluginSelections) continue;
        requestTabDiscovery({
          projectId,
          worktreeId: destinationWorktreeId,
          chatId: tab.id,
          pluginSelections: tab.pluginSelections,
          providerType: resolveDiscoveryProviderType(tab),
        });
      }

      return bindings;
    } finally {
      finishPendingFork();
    }
  },

  migrateWorktreeTabsToAdhocWorkspace: async (response): Promise<void> => {
    const sourceKey = `${response.sourceWorkspaceId}/${response.sourceWorktreeId}`;
    const destKey = `${response.destinationWorkspaceId}/${response.destinationWorktreeId}`;

    // Snapshot the local source projection for presentation cleanup (drafts,
    // pending editor selections) before the scope is dropped below.
    const sourceChatState = get().worktreeChats[sourceKey];

    // Main owns the whole durable migration: cloning with
    // `adhocMigrationSource` identity (idempotent across combine retries),
    // repo remaps, file-path rewrites, Codex thread forks, and the merge into
    // any existing destination tabs without clobbering them.
    try {
      await localChatBackend().chat.adhocMigrateTabs({
        sourceWorkspaceId: response.sourceWorkspaceId,
        sourceWorktreeId: response.sourceWorktreeId,
        destinationWorkspaceId: response.destinationWorkspaceId,
        destinationWorktreeId: response.destinationWorktreeId,
        filePathRewrites: response.filePathRewrites,
        selectedRepoIdRewrites: response.selectedRepoIdRewrites,
        ...(response.sourceRootRepoIdRewrite
          ? { sourceRootRepoIdRewrite: response.sourceRootRepoIdRewrite }
          : {}),
      });
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        '[chat-adhoc-migrate] Failed to migrate tabs into the destination.',
        error,
      );
      throw error;
    }

    set((state) => {
      // Clear cached source state and any unread / hydration tracking. The
      // destination projection is not staged here — it is main-owned and
      // rehydrates from the canonical snapshot below.
      const nextChats = { ...state.worktreeChats };
      delete nextChats[sourceKey];

      const nextUnread = state.unreadWorktreeKeys.has(sourceKey)
        ? new Set(
            Array.from(state.unreadWorktreeKeys).filter(
              (entry) => entry !== sourceKey,
            ),
          )
        : state.unreadWorktreeKeys;

      const nextDrafts = { ...state.tabDrafts };
      const nextPendingSelections = { ...state.pendingEditorSelections };
      for (const tab of sourceChatState?.tabs ?? []) {
        delete nextDrafts[tab.id];
        delete nextPendingSelections[tab.id];
      }

      const nextDefaults = { ...state.worktreeDefaultPlugins };
      delete nextDefaults[sourceKey];

      const nextQuestions = { ...state.pendingQuestions };
      for (const [id, pending] of Object.entries(nextQuestions)) {
        if (
          pending.projectId === response.sourceWorkspaceId &&
          pending.worktreeId === response.sourceWorktreeId
        ) {
          delete nextQuestions[id];
        }
      }

      const nextPlanExits = { ...state.pendingPlanExits };
      for (const [id, pending] of Object.entries(nextPlanExits)) {
        if (
          pending.projectId === response.sourceWorkspaceId &&
          pending.worktreeId === response.sourceWorktreeId
        ) {
          delete nextPlanExits[id];
        }
      }

      const nextApprovals = { ...state.pendingApprovals };
      for (const [id, pending] of Object.entries(nextApprovals)) {
        if (
          pending.projectId === response.sourceWorkspaceId &&
          pending.worktreeId === response.sourceWorktreeId
        ) {
          delete nextApprovals[id];
        }
      }

      const previouslySelectedSource =
        state.selectedWorktree?.projectId === response.sourceWorkspaceId &&
        state.selectedWorktree?.worktreeId === response.sourceWorktreeId;
      const nextSelected = previouslySelectedSource
        ? {
            projectId: response.destinationWorkspaceId,
            worktreeId: response.destinationWorktreeId,
          }
        : state.selectedWorktree;

      return {
        worktreeChats: nextChats,
        unreadWorktreeKeys: nextUnread,
        tabDrafts: nextDrafts,
        pendingEditorSelections: nextPendingSelections,
        worktreeDefaultPlugins: nextDefaults,
        pendingQuestions: nextQuestions,
        pendingPlanExits: nextPlanExits,
        pendingApprovals: nextApprovals,
        selectedWorktree: nextSelected,
      };
    });

    // Source key bookkeeping: drop hydration and revisioned tracking so the
    // worktree (which the backend may have removed when
    // `removedSourceWorktree === true`) is never re-hydrated as live.
    get().releaseChatScopeRevisioned(
      response.sourceWorkspaceId,
      response.sourceWorktreeId,
    );
    loadingKeys.delete(sourceKey);
    hydratedKeys.delete(sourceKey);
    hydrationLastTouchedAt.delete(sourceKey);

    // If the destination is currently selected, reload its canonical tabs so
    // the chat panel reflects the migration immediately; an already-tracked
    // destination scope also converges through the revisioned delta stream.
    const selected = get().selectedWorktree;
    if (
      selected?.projectId === response.destinationWorkspaceId &&
      selected.worktreeId === response.destinationWorktreeId
    ) {
      await get().loadTabs();
    } else if (get().worktreeChats[destKey]) {
      await get().loadAllWorktreeTabs([
        {
          projectId: response.destinationWorkspaceId,
          worktreeId: response.destinationWorktreeId,
        },
      ]);
    }
  },

  cleanupWorktree: (projectId, worktreeId): void => {
    const key = `${projectId}/${worktreeId}`;
    useOllamaConnectionBannerStore
      .getState()
      .clearWorktree(projectId, worktreeId);
    useActivityStore.getState().cleanupWorktree(projectId, worktreeId);

    useFileListStore.getState().invalidate(projectId, worktreeId);

    cancelDelayedUnreadChatNotificationsForWorktree(projectId, worktreeId);

    set((state) => removeWorktreeRuntimeState(state, projectId, worktreeId));

    blockedPersistenceKeys.delete(key);
    clearWorktreeHydrationState(key);
    scheduleIdleChatUnload();
  },

  insertClonedStandaloneTab: async (
    workspaceId,
    entryId,
    tab,
    makeActive = true,
    replaceActiveEmpty = false,
  ): Promise<void> => {
    const key = `${workspaceId}/${entryId}`;

    // The selection/panel bridges may have kicked off a tab load for this key
    // that is still in flight. Wait so the insert is never clobbered by the
    // hydration result.
    await waitForWorktreeHydration(key);

    set((state) => {
      const wc = state.worktreeChats[key];
      // Canonical hydration may already have delivered this tab (main
      // installs it durably before the caller mirrors it); just activate.
      if (wc?.tabs.some((candidate) => candidate.id === tab.id)) {
        return makeActive && wc.activeTabId !== tab.id
          ? {
              worktreeChats: {
                ...state.worktreeChats,
                [key]: { ...wc, activeTabId: tab.id },
              },
            }
          : state;
      }
      const activeTab = wc?.tabs.find(
        (candidate) => candidate.id === wc.activeTabId,
      );
      const shouldReplaceActive =
        replaceActiveEmpty && isPristineChatTab(activeTab, state);
      const updated: WorktreeChatState = wc
        ? {
            tabs: shouldReplaceActive
              ? wc.tabs.map((candidate) =>
                  candidate.id === activeTab.id ? tab : candidate,
                )
              : [...wc.tabs, tab],
            activeTabId: makeActive ? tab.id : wc.activeTabId,
          }
        : { tabs: [tab], activeTabId: tab.id };
      if (!wc) {
        hydratedKeys.add(key);
      }
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
  },
});
