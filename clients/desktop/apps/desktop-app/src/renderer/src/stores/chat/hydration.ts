// Worktree chat hydration lifecycle: load/replay tracking, idle unload,
// and hydration-preserving merges. Owns the hydration tracking registries.
import type {
  ChatEvent,
  ChatQueueUpdatedEvent,
  HookChatTabStartedEvent,
  McpAskUserEvent,
} from '@canopy/desktop-shared/types';
import type { ChatState } from './state';
import type { ChatTab, PendingQuestion, WorktreeChatState } from './types';
import { delay, parseWorktreeChatKey, worktreeKey } from './utils';
import { hasPendingTrackedPlanReview } from './plan-utils';
import { relabelFileTabs } from './persisted-tabs';
import { resolveTabProviderType } from './tab-utils';
import { blockedPersistenceKeys } from './persistence';
import { chatStoreApi } from './store-ref';
import { chatBackendFor } from './backend';

export function mergeHydratedWorktreeChatState(
  hydratedState: WorktreeChatState,
  currentState: WorktreeChatState | undefined,
  hydratedFromEmptyPersistence: boolean,
): {
  chatState: WorktreeChatState;
  mergedCurrentState: boolean;
} {
  if (!currentState) {
    return {
      chatState: {
        tabs: relabelFileTabs(hydratedState.tabs),
        activeTabId: hydratedState.activeTabId,
        ...(hydratedState.lastActiveEditableChatId
          ? {
              lastActiveEditableChatId: hydratedState.lastActiveEditableChatId,
            }
          : {}),
        ...(hydratedState.lastActiveChatProvider
          ? { lastActiveChatProvider: hydratedState.lastActiveChatProvider }
          : {}),
      },
      mergedCurrentState: false,
    };
  }

  const hasLocalChatTabs = currentState.tabs.some((tab) => tab.kind !== 'file');
  const mergedTabs =
    hydratedFromEmptyPersistence && hasLocalChatTabs
      ? hydratedState.tabs.filter((tab) => tab.kind === 'file')
      : [...hydratedState.tabs];
  let mergedCurrentState = false;

  for (const currentTab of currentState.tabs) {
    if (currentTab.kind === 'file' && currentTab.filePath) {
      const existingFileTabIndex = mergedTabs.findIndex(
        (tab) => tab.kind === 'file' && tab.filePath === currentTab.filePath,
      );
      if (existingFileTabIndex >= 0) {
        if (mergedTabs[existingFileTabIndex]?.id !== currentTab.id) {
          mergedCurrentState = true;
        }
        mergedTabs[existingFileTabIndex] = currentTab;
      } else {
        mergedTabs.push(currentTab);
        mergedCurrentState = true;
      }
      continue;
    }

    const existingChatTabIndex = mergedTabs.findIndex(
      (tab) => tab.id === currentTab.id,
    );
    if (existingChatTabIndex === -1) {
      mergedTabs.push(currentTab);
      mergedCurrentState = true;
      continue;
    }

    const hydratedTab = mergedTabs[existingChatTabIndex];
    if (
      hydratedTab &&
      hydratedTab.kind !== 'file' &&
      shouldPreserveCurrentChatTabDuringHydration(currentTab, hydratedTab)
    ) {
      mergedTabs[existingChatTabIndex] = currentTab;
      mergedCurrentState = true;
    }
  }

  const relabeledTabs = relabelFileTabs(mergedTabs);
  const relabeledHydratedTabs = relabelFileTabs(hydratedState.tabs);
  if (
    !mergedCurrentState &&
    (relabeledTabs.length !== relabeledHydratedTabs.length ||
      relabeledTabs.some((tab, index) => {
        const hydratedTab = relabeledHydratedTabs[index];
        return (
          hydratedTab === undefined ||
          hydratedTab.id !== tab.id ||
          hydratedTab.title !== tab.title ||
          hydratedTab.description !== tab.description
        );
      }))
  ) {
    mergedCurrentState = true;
  }

  const activeTabCandidates = [
    currentState.activeTabId,
    hydratedState.activeTabId,
    relabeledTabs[0]?.id,
  ];
  const activeTabId =
    activeTabCandidates.find(
      (candidateId) =>
        candidateId !== undefined &&
        relabeledTabs.some((tab) => tab.id === candidateId),
    ) ?? '';

  if (activeTabId !== hydratedState.activeTabId) {
    mergedCurrentState = true;
  }
  const activeChatProvider = resolveTabProviderType(
    relabeledTabs.find((tab) => tab.id === activeTabId),
  );
  const activeTab = relabeledTabs.find((tab) => tab.id === activeTabId);
  const editableTabs = relabeledTabs.filter(
    (tab) => tab.kind !== 'file' && !tab.readOnly,
  );
  const lastActiveEditableChatId =
    activeTab && activeTab.kind !== 'file' && !activeTab.readOnly
      ? activeTab.id
      : [
          currentState.lastActiveEditableChatId,
          hydratedState.lastActiveEditableChatId,
        ].find((candidateId) =>
          editableTabs.some((tab) => tab.id === candidateId),
        );
  const lastActiveChatProvider =
    activeChatProvider ??
    currentState.lastActiveChatProvider ??
    hydratedState.lastActiveChatProvider;

  return {
    chatState: {
      tabs: relabeledTabs,
      activeTabId,
      ...(lastActiveEditableChatId ? { lastActiveEditableChatId } : {}),
      ...(lastActiveChatProvider ? { lastActiveChatProvider } : {}),
    },
    mergedCurrentState,
  };
}

export function shouldPreserveCurrentChatTabDuringHydration(
  currentTab: ChatTab,
  hydratedTab: ChatTab,
): boolean {
  if (currentTab.status === 'streaming' && hydratedTab.status !== 'streaming') {
    return true;
  }
  if (currentTab.queuedMessages.length > 0) {
    return true;
  }
  if ((currentTab.pendingAttachments?.length ?? 0) > 0) {
    return true;
  }
  if (currentTab.pendingRevertAttachmentPath !== undefined) {
    return true;
  }
  if ((currentTab.messages.length ?? 0) > hydratedTab.messages.length) {
    return true;
  }
  return false;
}

// Tracks in-flight loadTabs calls to prevent duplicate concurrent loads
export const loadingKeys = new Set<string>();

export const hydratedKeys = new Set<string>();

/** Revisioned scopes installed without a loader's one-time setup (display
 * enrichment and approval recovery), as by a prefetch or refresh. The next
 * load of the scope runs it. */
export const revisionedSetupPendingKeys = new Set<string>();

/** Scopes hydrated for a prefetch: an empty scope's starter chat and the
 * snapshot's auto-archives wait for a load, so a hover never writes stored
 * state. */
export const speculativeHydrationKeys = new Set<string>();

export const CHAT_HYDRATION_CONCURRENCY = 4;

export const CHAT_IDLE_UNLOAD_MS = 10 * 60 * 1000;

export const hydrationLastTouchedAt = new Map<string, number>();

export type PendingHydrationEvent =
  | { kind: 'chat'; event: ChatEvent }
  | { kind: 'chat-queue'; event: ChatQueueUpdatedEvent }
  | { kind: 'ask-user'; event: McpAskUserEvent }
  | { kind: 'hook-started'; event: HookChatTabStartedEvent };

const pendingHydrationEvents = new Map<string, PendingHydrationEvent[]>();

const replayingHydrationKeys = new Set<string>();

let idleChatUnloadTimeout: ReturnType<typeof setTimeout> | null = null;

export interface UnrefableTimeout {
  unref: () => void;
}

export function queuePendingHydrationEvent(
  key: string,
  event: PendingHydrationEvent,
): void {
  const events = pendingHydrationEvents.get(key) ?? [];
  events.push(event);
  pendingHydrationEvents.set(key, events);
}

export function discardPendingHookPlaceholder(
  key: string,
  queueId: string,
): void {
  const events = pendingHydrationEvents.get(key);
  if (!events) return;
  const retained = events.filter(
    (item) =>
      item.kind !== 'hook-started' ||
      item.event.queuedMessage?.queueId !== queueId,
  );
  if (retained.length > 0) pendingHydrationEvents.set(key, retained);
  else pendingHydrationEvents.delete(key);
}

export async function waitForWorktreeHydration(
  key: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Revisioned hydration records the key as soon as its snapshot installs,
  // before post-hydration work (including canonical starter-tab creation)
  // completes. The loading key is the actual ownership/lifecycle boundary;
  // waiting only until `hydratedKeys` contains the scope lets first-click
  // commands race that unfinished canonicalization.
  while (loadingKeys.has(key)) {
    if (Date.now() >= deadline) {
      return;
    }
    await delay(25);
  }
}

/** An eager composer is usable before its canonical tab exists. Capture its
 * identity and hold host mutations until that same tab has been created. */
export function pendingEagerChatCreation(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<boolean> | undefined {
  const key = worktreeKey(target);
  const tab = chatStoreApi()
    .getState()
    .worktreeChats[key]?.tabs.find((entry) => entry.id === target.chatId);
  if (!tab?.pendingInitialCreation) return undefined;
  return waitForWorktreeHydration(key, Number.POSITIVE_INFINITY).then(
    async () => {
      let state = chatStoreApi().getState();
      let current = state.worktreeChats[key]?.tabs.find(
        (entry) => entry.id === target.chatId,
      );
      if (!current || state.chatStateSync[key]?.phase !== 'live') return false;

      if (current.pendingInitialCreation) {
        // A rejected or transport-failed hydration attempt deliberately keeps
        // this marker so canonical refreshes preserve the provisional tab.
        // Re-drive creation from the next action instead of leaving that action
        // permanently blocked. `ensureWorktreeHasChatTab` registers this retry,
        // so concurrent sends and settings changes coalesce on one command.
        await state.ensureWorktreeHasChatTab(target);
        state = chatStoreApi().getState();
        current = state.worktreeChats[key]?.tabs.find(
          (entry) => entry.id === target.chatId,
        );
      }

      return Boolean(
        current &&
        !current.pendingInitialCreation &&
        state.chatStateSync[key]?.phase === 'live',
      );
    },
  );
}

export function ensureHydratedAndReplayPendingEvents(
  projectId: string,
  worktreeId: string,
): void {
  const key = `${projectId}/${worktreeId}`;
  if (replayingHydrationKeys.has(key)) {
    return;
  }
  const pendingEventCountAtStart = pendingHydrationEvents.get(key)?.length ?? 0;
  replayingHydrationKeys.add(key);

  void (async (): Promise<void> => {
    if (!hydratedKeys.has(key)) {
      await chatStoreApi().getState().loadTabsForTarget(projectId, worktreeId);
      await waitForWorktreeHydration(key);
    }

    if (!hydratedKeys.has(key)) {
      return;
    }

    const queued = pendingHydrationEvents.get(key) ?? [];
    if (queued.length === 0 || !chatStoreApi().getState().worktreeChats[key]) {
      return;
    }

    pendingHydrationEvents.delete(key);
    try {
      for (const item of queued) {
        if (item.kind === 'hook-started') {
          chatStoreApi().getState().handleHookTabStarted(item.event);
        } else if (item.kind === 'ask-user') {
          chatStoreApi().getState().handleMcpAskUser(item.event);
        } else if (item.kind === 'chat-queue') {
          chatStoreApi().getState().handleChatQueueUpdated(item.event);
        } else {
          chatStoreApi().getState().handleChatEvent(item.event);
        }
      }
    } catch (error) {
      const current = pendingHydrationEvents.get(key) ?? [];
      pendingHydrationEvents.set(key, [...queued, ...current]);
      throw error;
    }
  })()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(
        '[chatStore] Failed to hydrate and replay pending chat events',
        error,
      );
    })
    .finally(() => {
      replayingHydrationKeys.delete(key);
      const pendingEventCount = pendingHydrationEvents.get(key)?.length ?? 0;
      if (
        pendingEventCount > 0 &&
        (hydratedKeys.has(key) || pendingEventCount > pendingEventCountAtStart)
      ) {
        ensureHydratedAndReplayPendingEvents(projectId, worktreeId);
      }
    });
}

export function clearWorktreeHydrationState(key: string): void {
  loadingKeys.delete(key);
  hydratedKeys.delete(key);
  revisionedSetupPendingKeys.delete(key);
  speculativeHydrationKeys.delete(key);
  hydrationLastTouchedAt.delete(key);
  pendingHydrationEvents.delete(key);
  replayingHydrationKeys.delete(key);
}

export interface IdleWorktreeChatCandidate {
  key: string;
  projectId: string;
  worktreeId: string;
  chatState: WorktreeChatState;
}

export function recordWorktreeChatTouch(
  key: string,
  touchedAt = Date.now(),
): void {
  hydrationLastTouchedAt.set(key, touchedAt);
}

export function pendingRecordsIncludeWorktree(
  records: Record<string, { projectId: string; worktreeId: string }>,
  key: string,
): boolean {
  for (const record of Object.values(records)) {
    if (`${record.projectId}/${record.worktreeId}` === key) {
      return true;
    }
  }

  return false;
}

/**
 * Whether the worktree named by `key` has any ACTIONABLE (unanswered) pending
 * question. Answered records are retained/hydrated for projection but must not
 * pin a worktree in memory — a worktree whose only remaining questions are
 * answered can still idle-unload. Distinct from the generic
 * {@link pendingRecordsIncludeWorktree} (used for `pendingPlanExits`), which
 * ignores `answeredAt`.
 */
export function actionablePendingQuestionsIncludeWorktree(
  pendingQuestions: Record<string, PendingQuestion>,
  key: string,
): boolean {
  for (const record of Object.values(pendingQuestions)) {
    if (
      record.answeredAt === undefined &&
      `${record.projectId}/${record.worktreeId}` === key
    ) {
      return true;
    }
  }

  return false;
}

export function tabKeepsWorktreeHydrated(tab: ChatTab): boolean {
  return (
    tab.status === 'streaming' ||
    tab.claudeTerminal?.turnState === 'running' ||
    tab.queuedMessages.length > 0 ||
    tab.queuedHookPlaceholder === true ||
    tab.pendingPlanExit !== undefined ||
    hasPendingTrackedPlanReview(tab) ||
    (tab.pendingAttachments?.length ?? 0) > 0 ||
    tab.cancelRequestedByUser === true ||
    tab.forceQueuedMessageCancelPending === true
  );
}

export function shouldKeepWorktreeChatHydrated(
  state: ChatState,
  key: string,
  chatState: WorktreeChatState,
): boolean {
  if (
    state.selectedWorktree !== null &&
    worktreeKey(state.selectedWorktree) === key
  ) {
    return true;
  }

  if (state.unreadWorktreeKeys.has(key)) {
    return true;
  }

  if (actionablePendingQuestionsIncludeWorktree(state.pendingQuestions, key)) {
    return true;
  }

  if (pendingRecordsIncludeWorktree(state.pendingPlanExits, key)) {
    return true;
  }

  if (pendingRecordsIncludeWorktree(state.pendingApprovals, key)) {
    return true;
  }

  return chatState.tabs.some(tabKeepsWorktreeHydrated);
}

export function getUnloadTrackedWorktreeKeys(state: ChatState): string[] {
  return Array.from(
    new Set([...Array.from(hydratedKeys), ...Object.keys(state.worktreeChats)]),
  );
}

export function getIdleWorktreeChatCandidates(
  state: ChatState,
  now: number,
): IdleWorktreeChatCandidate[] {
  const candidates: IdleWorktreeChatCandidate[] = [];

  for (const key of getUnloadTrackedWorktreeKeys(state)) {
    const chatState = state.worktreeChats[key];
    const parsed = parseWorktreeChatKey(key);
    if (!chatState || !parsed) {
      hydratedKeys.delete(key);
      hydrationLastTouchedAt.delete(key);
      continue;
    }

    if (
      loadingKeys.has(key) ||
      blockedPersistenceKeys.has(key) ||
      shouldKeepWorktreeChatHydrated(state, key, chatState)
    ) {
      continue;
    }

    const lastTouchedAt = hydrationLastTouchedAt.get(key) ?? now;
    hydrationLastTouchedAt.set(key, lastTouchedAt);
    if (now - lastTouchedAt < CHAT_IDLE_UNLOAD_MS) {
      continue;
    }

    candidates.push({
      key,
      projectId: parsed.projectId,
      worktreeId: parsed.worktreeId,
      chatState,
    });
  }

  return candidates;
}

export function getNextIdleUnloadDelayMs(
  state: ChatState,
  now: number,
): number | null {
  let nextDueAt: number | null = null;

  for (const key of getUnloadTrackedWorktreeKeys(state)) {
    const chatState = state.worktreeChats[key];
    if (!chatState) {
      hydratedKeys.delete(key);
      hydrationLastTouchedAt.delete(key);
      continue;
    }

    if (
      loadingKeys.has(key) ||
      blockedPersistenceKeys.has(key) ||
      shouldKeepWorktreeChatHydrated(state, key, chatState)
    ) {
      continue;
    }

    const lastTouchedAt = hydrationLastTouchedAt.get(key) ?? now;
    hydrationLastTouchedAt.set(key, lastTouchedAt);
    const dueAt = lastTouchedAt + CHAT_IDLE_UNLOAD_MS;
    nextDueAt = nextDueAt === null ? dueAt : Math.min(nextDueAt, dueAt);
  }

  return nextDueAt === null ? null : Math.max(0, nextDueAt - now);
}

export function clearIdleChatUnloadTimer(): void {
  if (idleChatUnloadTimeout === null) {
    return;
  }

  clearTimeout(idleChatUnloadTimeout);
  idleChatUnloadTimeout = null;
}

export function isUnrefableTimeout(
  timer: ReturnType<typeof setTimeout>,
): timer is ReturnType<typeof setTimeout> & UnrefableTimeout {
  return (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  );
}

export function scheduleIdleChatUnload(): void {
  clearIdleChatUnloadTimer();

  const delayMs = getNextIdleUnloadDelayMs(
    chatStoreApi().getState(),
    Date.now(),
  );
  if (delayMs === null) {
    return;
  }

  idleChatUnloadTimeout = setTimeout(() => {
    idleChatUnloadTimeout = null;
    void chatStoreApi().getState().unloadIdleWorktreeChats();
  }, delayMs);
  if (isUnrefableTimeout(idleChatUnloadTimeout)) {
    idleChatUnloadTimeout.unref();
  }
}

export function saveIdleWorktreeChatCandidate(
  candidate: IdleWorktreeChatCandidate,
): boolean {
  if (blockedPersistenceKeys.has(candidate.key)) {
    return false;
  }

  // The canonical state already lives in main, so unloading the read-only
  // projection never writes a renderer snapshot back — the scope is simply
  // released and rehydrates from the canonical snapshot on the next visit.
  return true;
}

export async function canUnloadIdleWorktreeChat(
  candidate: IdleWorktreeChatCandidate,
  now: number,
): Promise<IdleWorktreeChatCandidate | null> {
  try {
    const active = await chatBackendFor(candidate).chat.activeSessions({
      projectId: candidate.projectId,
      worktreeId: candidate.worktreeId,
    });
    if (active.activeChatIds.length > 0) {
      recordWorktreeChatTouch(candidate.key, now);
      return null;
    }
  } catch {
    recordWorktreeChatTouch(candidate.key, now);
    return null;
  }

  const saved = saveIdleWorktreeChatCandidate(candidate);
  if (!saved) {
    recordWorktreeChatTouch(candidate.key, now);
  }
  return saved ? candidate : null;
}

export function removeWorktreeRuntimeState(
  state: ChatState,
  projectId: string,
  worktreeId: string,
): Partial<ChatState> {
  const key = `${projectId}/${worktreeId}`;
  const deadTabs = state.worktreeChats[key]?.tabs ?? [];

  const nextChats = { ...state.worktreeChats };
  delete nextChats[key];

  const nextArchivedChats = { ...state.archivedChats };
  delete nextArchivedChats[key];

  const nextDrafts = { ...state.tabDrafts };
  const nextPendingEditorSelections = {
    ...state.pendingEditorSelections,
  };
  for (const tab of deadTabs) {
    delete nextDrafts[tab.id];
    delete nextPendingEditorSelections[tab.id];
  }
  for (const [tabId, selections] of Object.entries(
    nextPendingEditorSelections,
  )) {
    const retained = selections.filter(
      (selection) =>
        selection.projectId !== projectId ||
        selection.worktreeId !== worktreeId,
    );
    if (retained.length === selections.length) continue;
    if (retained.length === 0) {
      delete nextPendingEditorSelections[tabId];
    } else {
      nextPendingEditorSelections[tabId] = retained;
    }
  }

  const nextQuestions = { ...state.pendingQuestions };
  for (const [id, pending] of Object.entries(nextQuestions)) {
    if (pending.projectId === projectId && pending.worktreeId === worktreeId) {
      delete nextQuestions[id];
    }
  }

  const nextPlanExits = { ...state.pendingPlanExits };
  for (const [id, pending] of Object.entries(nextPlanExits)) {
    if (pending.projectId === projectId && pending.worktreeId === worktreeId) {
      delete nextPlanExits[id];
    }
  }

  const nextApprovals = { ...state.pendingApprovals };
  for (const [id, pending] of Object.entries(nextApprovals)) {
    if (pending.projectId === projectId && pending.worktreeId === worktreeId) {
      delete nextApprovals[id];
    }
  }

  const nextUnread = new Set(state.unreadWorktreeKeys);
  nextUnread.delete(key);

  const nextDefaults = { ...state.worktreeDefaultPlugins };
  delete nextDefaults[key];

  const nextSelected =
    state.selectedWorktree?.projectId === projectId &&
    state.selectedWorktree?.worktreeId === worktreeId
      ? null
      : state.selectedWorktree;

  return {
    selectedWorktree: nextSelected,
    worktreeChats: nextChats,
    archivedChats: nextArchivedChats,
    worktreeDefaultPlugins: nextDefaults,
    pendingQuestions: nextQuestions,
    pendingPlanExits: nextPlanExits,
    pendingApprovals: nextApprovals,
    unreadWorktreeKeys: nextUnread,
    tabDrafts: nextDrafts,
    pendingEditorSelections: nextPendingEditorSelections,
  };
}

export function pruneUnreadWorktreeKey(
  unreadKeys: Set<string>,
  key: string,
  tabs: ChatTab[],
): Set<string> {
  if (tabs.some((tab) => tab.unread === true) || !unreadKeys.has(key)) {
    return unreadKeys;
  }

  const nextUnread = new Set(unreadKeys);
  nextUnread.delete(key);
  return nextUnread;
}
