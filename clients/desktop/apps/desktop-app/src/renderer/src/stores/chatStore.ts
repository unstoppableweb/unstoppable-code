import {
  createStore,
  useStore,
  type StoreApi,
  type UseBoundStore,
} from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import {
  useChatSurfaceScope,
  type ChatSurfaceStore,
} from './chat/surface-store';

// Re-export so the renderer's transcript / display layers can import these
// from a single source of truth. The shared module owns the canonical shape;
// `chatStore` just forwards them so existing renderer imports keep working.
export type {
  CodexAgentState,
  CodexAgentCallBlock,
} from '@canopy/desktop-shared/types';
import {
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
  type AppliedOrgMemoryTurn,
  type ChatBlock,
  type ChatMessage,
  type ChatTab,
  type PendingPlanExit,
  type PendingQuestion,
  type QueuedChatMessage,
  type WorktreeChatOpenArchiveTranscriptDetail,
  type WorktreeChatState,
} from './chat/types';
// Re-export the public chat types from their new home so the existing
// `@/stores/chatStore` import sites keep working unchanged.
export {
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
  type AppliedOrgMemoryTurn,
  type ChatBlock,
  type ChatMessage,
  type ChatTab,
  type PendingPlanExit,
  type PendingQuestion,
  type QueuedChatMessage,
  type WorktreeChatOpenArchiveTranscriptDetail,
  type WorktreeChatState,
};
// Re-export helpers that moved to ./chat/* but are part of the public
// chatStore surface consumed elsewhere in the renderer.
export { getTextBlocks } from './chat/messages';
export {
  clearResumedChatUsageLimitBanner,
  getOnlyQueuedHookPlaceholderQueueId,
} from './chat/tab-utils';
export { mapWithConcurrency } from './chat/utils';
export { getChatTabAgentResponsePreview } from './chat/unread-previews';
export { findPlanExploreTarget } from './chat/plan-explore-registry';
export { getCodeReviewOrigin } from './chat/code-review-registry';
export {
  resolveDeferredToolsAllowedDefault,
  resolveFallbackDefaultModel,
  resolveLaneForTarget,
  resolveTabDefaults,
} from './chat/defaults';
export {
  navigateToWorktreeChat,
  type WorktreeChatNavigationTarget,
} from './chat/notifications';
import type { ChatState } from './chat/state';
import { registerChatStoreApi } from './chat/store-ref';
import { reconcileInterruptedTurnResumeSessions } from './chat/interrupted-turn-resume';
import {
  createFrameBatchedStoreView,
  type FrameBatchedStoreView,
} from './chat/frame-batched-store-view';
import {
  createChatRenderStores,
  type ChatRenderStores,
  type ChatTabRenderEntry,
  type ChatTabStripTab,
  type ReadonlyRenderStore,
} from './chat/render-stores';
import { createModelsSlice } from './chat/slices/models';
import { createTabsSlice } from './chat/slices/tabs';
import { createArchiveSlice } from './chat/slices/archive';
import { createMessagingSlice } from './chat/slices/messaging';
import { createQueueSlice } from './chat/slices/queue';
import { createEventsSlice } from './chat/slices/events';
import { createQuestionsSlice } from './chat/slices/questions';
import { createPlanSlice } from './chat/slices/plan';
import { createApprovalsSlice } from './chat/slices/approvals';
import { createStaleSessionSlice } from './chat/slices/stale-session';
import { createDiscoverySlice } from './chat/slices/discovery';
import { createUsageSlice } from './chat/slices/usage';
import { createAttentionSlice } from './chat/slices/attention';
import { createComposerSlice } from './chat/slices/composer';
import { createDeferredToolsSlice } from './chat/slices/deferred-tools';
import { createRevisionedSlice } from './chat/slices/revisioned';
import { createTurnFeedbackSlice } from './chat/slices/turn-feedback';
import { getVisibleWorktreeKey } from './chat/notifications';
import { syncClaudeTerminalRuntimeStateToChatTab } from './chat/terminal-runtime';
import {
  type ClaudeTerminalClientState,
  useClaudeTerminalStore,
} from '@/stores/claudeTerminalStore';
import { useNavigationStore } from './navigationStore';
import { subscribeChatPanelVisibility } from '@/lib/worktree-layout-prefs';
import { setVisibleContext } from '@/lib/osNotifications';
import { subscribeStandaloneChatArchiveOverlay } from './standaloneChatVisibility';
import { subscribeAppAdvisorDockCover } from './appAdvisorDockCover';

const chatStore = createStore<ChatState>()((...a) => ({
  ...createRevisionedSlice(...a),
  ...createDeferredToolsSlice(...a),
  ...createModelsSlice(...a),
  ...createTabsSlice(...a),
  ...createArchiveSlice(...a),
  ...createMessagingSlice(...a),
  ...createQueueSlice(...a),
  ...createEventsSlice(...a),
  ...createQuestionsSlice(...a),
  ...createPlanSlice(...a),
  ...createApprovalsSlice(...a),
  ...createStaleSessionSlice(...a),
  ...createDiscoverySlice(...a),
  ...createUsageSlice(...a),
  ...createAttentionSlice(...a),
  ...createComposerSlice(...a),
  ...createTurnFeedbackSlice(...a),
}));

/**
 * React's view of the chat store. Every store update reaches it at once,
 * except streamed content that `useChatEventSubscriptions` applies inside
 * `deferNotifications`, which reaches React once per animation frame. All
 * imperative access (`useChatStore.getState()`, `setState`, `subscribe`, and
 * store actions) reads and writes the store itself, so it is always current.
 */
export const chatStoreRenderView: FrameBatchedStoreView<ChatState> =
  createFrameBatchedStoreView(chatStore);

function selectChatState(state: ChatState): ChatState {
  return state;
}

function useChatStoreSelector(): ChatState;
function useChatStoreSelector<U>(selector: (state: ChatState) => U): U;
function useChatStoreSelector<U>(
  selector?: (state: ChatState) => U,
): ChatState | U {
  const select: (state: ChatState) => ChatState | U =
    selector ?? selectChatState;
  // Inside a chat surface (the question sandbox) hook reads come from its own
  // store; everywhere else from the frame-batched view of the live store.
  const surface = useChatSurfaceScope();
  return useStore(surface?.store ?? chatStoreRenderView, select);
}

export const useChatStore: UseBoundStore<StoreApi<ChatState>> = Object.assign(
  useChatStoreSelector,
  chatStore,
);

registerChatStoreApi(useChatStore);
useChatStore.subscribe((state, previous) => {
  if (state.worktreeChats !== previous.worktreeChats) {
    reconcileInterruptedTurnResumeSessions();
  }
});

export type { ChatTabRenderEntry, ChatTabStripTab };

/**
 * Keyed slices of {@link chatStoreRenderView} (phase 15): React reads one
 * chat, one worktree or one tab strip through these, and is notified only
 * when that slice changes. Imperative code keeps reading `useChatStore`.
 */
export const chatRenderStores: ChatRenderStores =
  createChatRenderStores(chatStoreRenderView);

/**
 * The render stores React reads: inside a chat surface (the question
 * sandbox), ones built over that surface's own store, cached per store;
 * everywhere else the live {@link chatRenderStores}.
 */
const surfaceRenderStores = new WeakMap<ChatSurfaceStore, ChatRenderStores>();
function useChatRenderStores(): ChatRenderStores {
  const surface = useChatSurfaceScope();
  if (!surface) return chatRenderStores;
  const cached = surfaceRenderStores.get(surface.store);
  if (cached) return cached;
  const stores = createChatRenderStores(surface.store);
  surfaceRenderStores.set(surface.store, stores);
  return stores;
}

/** A chat addressed by its worktree scope. */
export interface ChatRenderTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

const NO_CHAT_TAB_ENTRY: ChatTabRenderEntry = {
  tab: undefined,
  runtime: undefined,
};

function staticRenderStore<T>(value: T): ReadonlyRenderStore<T> {
  return {
    getState: (): T => value,
    getInitialState: (): T => value,
    subscribe: (): (() => void) => (): void => undefined,
  };
}

const NO_CHAT_TAB_STORE = staticRenderStore(NO_CHAT_TAB_ENTRY);
const NO_WORKTREE_CHAT_STORE = staticRenderStore<WorktreeChatState | undefined>(
  undefined,
);
const NO_TAB_STRIP: readonly ChatTabStripTab[] = [];
const NO_TAB_STRIP_STORE = staticRenderStore(NO_TAB_STRIP);

/**
 * Select from one chat's tab and canonical runtime state. The selector runs
 * only when that chat's tab object or runtime changes (or the selector or
 * target does), never for another chat's commit. `null` reads no chat.
 */
export function useChatTabRenderState<U>(
  target: ChatRenderTarget | null,
  selector: (entry: ChatTabRenderEntry) => U,
  equalityFn?: (left: U, right: U) => boolean,
): U {
  const renderStores = useChatRenderStores();
  const store = target
    ? renderStores.chatTab(
        `${target.projectId}/${target.worktreeId}`,
        target.chatId,
      )
    : NO_CHAT_TAB_STORE;
  return useStoreWithEqualityFn(store, selector, equalityFn);
}

/**
 * Select from one worktree's ACTIVE chat: `worktreeChats[key].tabs.find(tab
 * => tab.id === activeTabId)` and its runtime. The selector runs only when the
 * active tab id, or that chat's tab or runtime, changes. `null` reads no chat.
 */
export function useActiveChatTabRenderState<U>(
  worktreeKey: string | null,
  selector: (entry: ChatTabRenderEntry) => U,
  equalityFn?: (left: U, right: U) => boolean,
): U {
  const renderStores = useChatRenderStores();
  const activeTabId = useWorktreeChatRenderState(
    worktreeKey,
    (chatState) => chatState?.activeTabId,
  );
  const store =
    worktreeKey !== null && activeTabId !== undefined
      ? renderStores.chatTab(worktreeKey, activeTabId)
      : NO_CHAT_TAB_STORE;
  return useStoreWithEqualityFn(store, selector, equalityFn);
}

/**
 * Select from one worktree's chat state (`undefined` until it is loaded).
 * The selector runs only when that worktree's chat state changes. `null`
 * reads no worktree.
 */
export function useWorktreeChatRenderState<U>(
  worktreeKey: string | null,
  selector: (chatState: WorktreeChatState | undefined) => U,
  equalityFn?: (left: U, right: U) => boolean,
): U {
  const renderStores = useChatRenderStores();
  const store =
    worktreeKey === null
      ? NO_WORKTREE_CHAT_STORE
      : renderStores.worktreeChat(worktreeKey);
  return useStoreWithEqualityFn(store, selector, equalityFn);
}

/**
 * One worktree's tabs as the tab strip shows them. The array and each tab
 * keep their identity until a strip-visible field changes, so streamed
 * content does not re-render the strip.
 */
export function useChatTabStrip(
  worktreeKey: string | null,
): readonly ChatTabStripTab[] {
  const renderStores = useChatRenderStores();
  const store =
    worktreeKey === null
      ? NO_TAB_STRIP_STORE
      : renderStores.tabStrip(worktreeKey);
  return useStore(store);
}

/**
 * The strip projection of the tab with `tabId` in any loaded worktree (chat
 * ids are globally unique), for panel tab headers that know only the id.
 */
export function useChatTabStripTabById(
  tabId: string,
): ChatTabStripTab | undefined {
  const renderStores = useChatRenderStores();
  return useStore(renderStores.stripTabById(tabId));
}

// ---------------------------------------------------------------------------
// Claude Code terminal runtime mirror. The terminal store owns IPC state, but
// the sidebar and tab bar derive thinking/unread from chatStore fields.
// ---------------------------------------------------------------------------

function isClaudeTerminalTurnCompletion(
  previous: ClaudeTerminalClientState | undefined,
  current: ClaudeTerminalClientState,
): boolean {
  if (previous?.turnState !== 'running') {
    return false;
  }
  return (
    current.turnState === 'idle' ||
    current.turnState === 'error' ||
    current.turnState === 'exited'
  );
}

/**
 * True when a freshly launched Claude Code terminal has just become able to
 * accept TUI input (first hook callback observed while idle). Messages sent
 * while the CLI was still starting are queued; this transition drains them
 * through the same post-turn flush used for turn completions.
 */
function isClaudeTerminalInputReadyTransition(
  previous: ClaudeTerminalClientState | undefined,
  current: ClaudeTerminalClientState,
): boolean {
  return (
    previous !== undefined &&
    previous.readyForInput !== true &&
    current.readyForInput === true &&
    current.turnState === 'idle'
  );
}

function claudeTerminalChatHasQueuedMessages(
  snapshot: ClaudeTerminalClientState,
): boolean {
  const key = `${snapshot.projectId}/${snapshot.worktreeId}`;
  const tab = useChatStore
    .getState()
    .worktreeChats[key]?.tabs.find((entry) => entry.id === snapshot.chatId);
  return (tab?.queuedMessages.length ?? 0) > 0;
}

function emitClaudeTerminalTurnResult(
  snapshot: ClaudeTerminalClientState,
): void {
  useChatStore.getState().handleChatEvent({
    projectId: snapshot.projectId,
    worktreeId: snapshot.worktreeId,
    chatId: snapshot.chatId,
    data: {
      type: 'result',
      is_error: snapshot.turnState === 'error',
      result: snapshot.errorMessage ?? 'Claude Code turn completed',
    },
  });
}

let disposeClaudeTerminalChatSync: (() => void) | null = null;

export function initializeClaudeTerminalChatSync(): () => void {
  if (disposeClaudeTerminalChatSync) {
    return disposeClaudeTerminalChatSync;
  }

  for (const snapshot of Object.values(
    useClaudeTerminalStore.getState().byChat,
  )) {
    syncClaudeTerminalRuntimeStateToChatTab(snapshot);
  }

  const unsubscribe = useClaudeTerminalStore.subscribe((state, previous) => {
    for (const [key, snapshot] of Object.entries(state.byChat)) {
      const previousSnapshot = previous.byChat[key];
      if (
        previousSnapshot?.turnState !== snapshot.turnState ||
        previousSnapshot?.terminalId !== snapshot.terminalId ||
        previousSnapshot?.sessionKey !== snapshot.sessionKey ||
        previousSnapshot?.sdkSessionId !== snapshot.sdkSessionId ||
        previousSnapshot?.launchStatus !== snapshot.launchStatus ||
        previousSnapshot?.autoSendPending !== snapshot.autoSendPending ||
        previousSnapshot?.readyForInput !== snapshot.readyForInput ||
        previousSnapshot?.lastLaunchConsumedInitialPrompt !==
          snapshot.lastLaunchConsumedInitialPrompt ||
        previousSnapshot?.errorMessage !== snapshot.errorMessage
      ) {
        syncClaudeTerminalRuntimeStateToChatTab(snapshot);
      }
      if (isClaudeTerminalTurnCompletion(previousSnapshot, snapshot)) {
        emitClaudeTerminalTurnResult(snapshot);
      } else if (
        isClaudeTerminalInputReadyTransition(previousSnapshot, snapshot) &&
        claudeTerminalChatHasQueuedMessages(snapshot)
      ) {
        // Readiness transitions only exist to drain prompts that were queued
        // while the CLI was still booting; with nothing queued, skip the
        // synthetic turn result so a plain launch doesn't ring unread or
        // notification side effects.
        emitClaudeTerminalTurnResult(snapshot);
      }
    }
  });

  disposeClaudeTerminalChatSync = (): void => {
    unsubscribe();
    disposeClaudeTerminalChatSync = null;
  };

  return disposeClaudeTerminalChatSync;
}

// ---------------------------------------------------------------------------
// Visible-context producer for OS notifications. This is the only place that
// computes the `visibleContext` snapshot the helper uses to suppress
// already-in-view toasts. Subscribes to chatStore for changes to the selected
// worktree and its active tab, and pushes the value into the helper.
// ---------------------------------------------------------------------------

function computeVisibleContext(state: ChatState): {
  worktreeKey: string | null;
  chatId: string | null;
} {
  const worktreeKeyValue = getVisibleWorktreeKey(state.selectedWorktree);
  if (!worktreeKeyValue) {
    return { worktreeKey: null, chatId: null };
  }
  const activeTabId = state.worktreeChats[worktreeKeyValue]?.activeTabId ?? '';
  return {
    worktreeKey: worktreeKeyValue,
    chatId: activeTabId || null,
  };
}

let disposeVisibleContextSync: (() => void) | null = null;

export function initializeVisibleContextSync(): () => void {
  if (disposeVisibleContextSync) {
    return disposeVisibleContextSync;
  }

  // Push the initial value immediately so the helper has a reasonable snapshot
  // before the first subscriber fires.
  const initialVisibleContext = computeVisibleContext(useChatStore.getState());
  setVisibleContext(
    initialVisibleContext.worktreeKey,
    initialVisibleContext.chatId,
  );

  let lastVisibleWorktreeKey: string | null = initialVisibleContext.worktreeKey;
  let lastVisibleChatId: string | null = initialVisibleContext.chatId;

  const unsubscribeChatStore = useChatStore.subscribe((state) => {
    const next = computeVisibleContext(state);
    if (
      next.worktreeKey !== lastVisibleWorktreeKey ||
      next.chatId !== lastVisibleChatId
    ) {
      lastVisibleWorktreeKey = next.worktreeKey;
      lastVisibleChatId = next.chatId;
      setVisibleContext(next.worktreeKey, next.chatId);
    }
  });

  // Also respond to navigation changes: `getVisibleWorktreeKey` returns null
  // when the user is not on the 'main' page, so the visible context must
  // re-evaluate when the page changes.
  const unsubscribeNavigationStore = useNavigationStore.subscribe(
    (state, prev) => {
      if (state.activePage !== prev.activePage) {
        const next = computeVisibleContext(useChatStore.getState());
        lastVisibleWorktreeKey = next.worktreeKey;
        lastVisibleChatId = next.chatId;
        setVisibleContext(next.worktreeKey, next.chatId);
      }
    },
  );

  // Re-evaluate when the chat panel is shown/hidden in kanban mode.
  // `getVisibleWorktreeKey` returns null while the chat panel is hidden, so
  // the visible context must update to keep unread/notification gating
  // accurate when the user toggles the panel.
  const unsubscribeChatPanelVisibility = subscribeChatPanelVisibility(() => {
    const next = computeVisibleContext(useChatStore.getState());
    if (
      next.worktreeKey !== lastVisibleWorktreeKey ||
      next.chatId !== lastVisibleChatId
    ) {
      lastVisibleWorktreeKey = next.worktreeKey;
      lastVisibleChatId = next.chatId;
      setVisibleContext(next.worktreeKey, next.chatId);
    }
  });

  // The legacy archive overlay covers the cowork panel grid, so opening or
  // closing it changes whether the selected work entry is actually visible.
  const unsubscribeStandaloneChatArchiveOverlay =
    subscribeStandaloneChatArchiveOverlay(() => {
      const next = computeVisibleContext(useChatStore.getState());
      if (
        next.worktreeKey !== lastVisibleWorktreeKey ||
        next.chatId !== lastVisibleChatId
      ) {
        lastVisibleWorktreeKey = next.worktreeKey;
        lastVisibleChatId = next.chatId;
        setVisibleContext(next.worktreeKey, next.chatId);
      }
    });

  // The docked Orchestrator page covers the open page, and leaving it shows
  // that page again, so both change what is actually visible.
  const unsubscribeAppAdvisorDockCover = subscribeAppAdvisorDockCover(() => {
    const next = computeVisibleContext(useChatStore.getState());
    if (
      next.worktreeKey !== lastVisibleWorktreeKey ||
      next.chatId !== lastVisibleChatId
    ) {
      lastVisibleWorktreeKey = next.worktreeKey;
      lastVisibleChatId = next.chatId;
      setVisibleContext(next.worktreeKey, next.chatId);
    }
  });

  disposeVisibleContextSync = (): void => {
    unsubscribeChatStore();
    unsubscribeAppAdvisorDockCover();
    unsubscribeNavigationStore();
    unsubscribeChatPanelVisibility();
    unsubscribeStandaloneChatArchiveOverlay();
    disposeVisibleContextSync = null;
  };

  return disposeVisibleContextSync;
}
