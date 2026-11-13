/**
 * This renderer's chat interest: the chats it shows (focused), showed
 * recently (warm), expanded delegate runs, and observability entries declared
 * to main on `chat:set-interest`.
 *
 * Started once per renderer ({@link useChatInterestDeclaration} in `App.tsx`
 * and `AppAdvisorWindowApp.tsx`). Targeted store subscriptions mark the
 * interest stale; it is recomputed and, when changed, declared on the next
 * frame. The revisioned chat slice asks for a re-declare after each scope
 * declaration (`requestChatInterestRedeclare`), and tracking declares once on
 * start, so a reloaded page declares again.
 */
import { useEffect } from 'react';
import type {
  ChatInterestChatRef,
  ChatInterestDeclaration,
} from '@canopy/desktop-shared/types';
import { isWebCoreScope } from '@/lib/chat-authority';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { followWebCoreLiveChats } from '@/stores/chat/web-core';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import {
  PIPELINE_ASSISTANT_UI_STATE_KEY,
  PIPELINE_EDITOR_SCOPE_KEY,
  computeFocusedChats,
  readChatInterestSources,
  type ChatInterestSurface,
} from './focused-chats';
import { setChatInterestRedeclareHandler } from './redeclare';
import { observabilityEntriesInterestRegistry } from './observability-interest';
import { expandedRunRegistry } from './run-interest';
import {
  createChatInterestTracker,
  type ChatInterest,
  type ChatInterestListener,
  type ChatInterestTracker,
} from './tracker';

export {
  MAX_FOCUSED_CHATS,
  MAX_FOCUSED_RUNS,
  MAX_WARM_CHATS,
  WARM_CHAT_LIMIT,
  type ChatInterest,
  type ChatInterestListener,
} from './tracker';
export { registerExpandedRun, useExpandedRunInterest } from './run-interest';
export {
  observabilityEntriesInterestRegistry,
  useObservabilityEntriesInterest,
} from './observability-interest';
export type { ChatInterestSurface } from './focused-chats';
export { requestChatInterestRedeclare } from './redeclare';

/**
 * A hidden window may not run animation frames; declare after this long
 * instead, so a change made while hidden still reaches main.
 */
const HIDDEN_WINDOW_FRAME_FALLBACK_MS = 100;

let observabilityEntriesSupported = true;
let observabilityInterestGeneration = 0;
let observabilityCatchUpGeneration = 0;
let observabilityCatchUpTask: Promise<void> | null = null;

let running: {
  readonly surface: ChatInterestSurface;
  readonly tracker: ChatInterestTracker;
  readonly dispose: () => void;
} | null = null;
const listeners = new Set<ChatInterestListener>();

function scheduleFrame(callback: () => void): () => void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    callback();
  };
  const frame = requestAnimationFrame(run);
  const timer = setTimeout(run, HIDDEN_WINDOW_FRAME_FALLBACK_MS);
  return (): void => {
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

function withoutObservabilityEntries(
  declaration: ChatInterestDeclaration,
): ChatInterestDeclaration {
  const legacy = { ...declaration };
  delete legacy.observabilityEntries;
  return legacy;
}

/**
 * Splits a declaration by authority: web core chats follow their live reply
 * through the web core backend, and only local chats are declared to main,
 * which must never see a web core id (CAN-6175 D1).
 */
function localChatInterest(
  declaration: ChatInterestDeclaration,
): ChatInterestDeclaration {
  const isLocal = (ref: ChatInterestChatRef): boolean =>
    !isWebCoreScope(ref.projectId);
  followWebCoreLiveChats(declaration.focused.filter((ref) => !isLocal(ref)));
  return {
    ...declaration,
    focused: declaration.focused.filter(isLocal),
    warm: declaration.warm.filter(isLocal),
    ...(declaration.focusedRuns === undefined
      ? {}
      : { focusedRuns: declaration.focusedRuns.filter(isLocal) }),
  };
}

async function sendChatInterest(
  interest: ChatInterestDeclaration,
): Promise<void> {
  const declaration = localChatInterest(interest);
  // Older preloads have no `setInterest`; such a window never declares.
  const chatApi = window.api?.chat;
  if (typeof chatApi?.setInterest !== 'function') return;
  if (!observabilityEntriesSupported) {
    await chatApi.setInterest(withoutObservabilityEntries(declaration));
    return;
  }
  try {
    await chatApi.setInterest(declaration);
  } catch (error) {
    if (declaration.observabilityEntries === undefined) throw error;
    // An older host's exact-key check rejects the field: keep chat interest.
    await chatApi.setInterest(withoutObservabilityEntries(declaration));
    observabilityEntriesSupported = false;
  }
}

function requestObservabilitySnapshotCatchUp(): void {
  observabilityInterestGeneration += 1;
  if (!observabilityEntriesInterestRegistry.active()) return;
  if (observabilityCatchUpTask !== null) return;

  const catchUp = async (): Promise<void> => {
    while (observabilityEntriesInterestRegistry.active()) {
      const generation = observabilityInterestGeneration;
      try {
        await flushChatInterest();
      } catch {
        if (
          observabilityEntriesInterestRegistry.active() &&
          generation !== observabilityInterestGeneration
        ) {
          continue;
        }
        observabilityCatchUpGeneration = generation;
        return;
      }

      if (!observabilityEntriesInterestRegistry.active()) return;
      if (generation !== observabilityInterestGeneration) continue;

      try {
        const snapshot = await window.api.observability.loadSnapshot();
        if (
          observabilityEntriesInterestRegistry.active() &&
          generation === observabilityInterestGeneration
        ) {
          useObservabilityStore.getState().applySnapshot(snapshot);
          observabilityCatchUpGeneration = generation;
          return;
        }
      } catch {
        if (
          !observabilityEntriesInterestRegistry.active() ||
          generation === observabilityInterestGeneration
        ) {
          observabilityCatchUpGeneration = generation;
          return;
        }
      }
    }
  };

  const task = catchUp();
  observabilityCatchUpTask = task.finally(() => {
    observabilityCatchUpTask = null;
    if (
      observabilityEntriesInterestRegistry.active() &&
      observabilityInterestGeneration !== observabilityCatchUpGeneration
    ) {
      requestObservabilitySnapshotCatchUp();
    }
  });
}

function logSendFailure(error: unknown): void {
  // Main clears this window's interest when it rejects a declaration, so the
  // window receives everything until the next change declares again.
  // eslint-disable-next-line no-console
  console.warn('Failed to declare chat interest', error);
}

/** The chat-store scopes whose active tab {@link computeFocusedChats} reads. */
function activeTabScopeKeys(surface: ChatInterestSurface): string[] {
  if (surface === 'main') return [PIPELINE_EDITOR_SCOPE_KEY];
  const { activeChatProjectId, activeWorkEntryId } =
    useStandaloneChatStore.getState();
  return activeWorkEntryId === null
    ? []
    : [`${activeChatProjectId}/${activeWorkEntryId}`];
}

function subscribeSources(
  surface: ChatInterestSurface,
  invalidate: () => void,
): () => void {
  const unsubscribers = [
    useNavigationStore.subscribe((state, previous) => {
      if (
        state.activePage !== previous.activePage ||
        state.settingsOpen !== previous.settingsOpen
      ) {
        invalidate();
      }
    }),
    useChatStore.subscribe((state, previous) => {
      if (state.selectedWorktree !== previous.selectedWorktree) {
        invalidate();
        return;
      }
      if (state.worktreeChats === previous.worktreeChats) return;
      // Streamed content replaces `worktreeChats` often; only an active tab
      // change in a scope read by its active tab matters here.
      const changed = activeTabScopeKeys(surface).some(
        (key) =>
          state.worktreeChats[key]?.activeTabId !==
          previous.worktreeChats[key]?.activeTabId,
      );
      if (changed) invalidate();
    }),
    useStandaloneChatStore.subscribe((state, previous) => {
      if (
        state.activeChatProjectId !== previous.activeChatProjectId ||
        state.activeWorkEntryId !== previous.activeWorkEntryId
      ) {
        invalidate();
      }
    }),
    usePanelLayoutStore.subscribe((state, previous) => {
      if (state.layouts !== previous.layouts) invalidate();
    }),
    usePanelWindowsStore.subscribe((state, previous) => {
      if (state.auxWindows !== previous.auxWindows) invalidate();
    }),
  ];
  if (surface === 'main') {
    unsubscribers.push(
      useCurrentUiStateStore.subscribe((state, previous) => {
        if (
          state.slices[PIPELINE_ASSISTANT_UI_STATE_KEY] !==
          previous.slices[PIPELINE_ASSISTANT_UI_STATE_KEY]
        ) {
          invalidate();
        }
      }),
    );
  } else {
    unsubscribers.push(
      useAppAdvisorStore.subscribe((state, previous) => {
        if (state.layout !== previous.layout) invalidate();
      }),
    );
  }
  return (): void => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}

/**
 * Start tracking and declaring this renderer's chat interest. Idempotent per
 * surface; returns a disposer.
 */
export function startChatInterestTracking(
  surface: ChatInterestSurface,
): () => void {
  if (running !== null) {
    if (running.surface === surface) return running.dispose;
    running.dispose();
  }
  const tracker = createChatInterestTracker({
    readFocused: () => computeFocusedChats(readChatInterestSources(surface)),
    readExpandedRuns: () => expandedRunRegistry.list(),
    readObservabilityEntries: () =>
      observabilityEntriesInterestRegistry.active(),
    send: sendChatInterest,
    scheduleFrame,
    onSendFailed: logSendFailure,
  });
  const unsubscribeTracker = tracker.subscribe((interest) => {
    listeners.forEach((listener) => listener(interest));
  });
  const unsubscribeExpandedRuns = expandedRunRegistry.subscribe(
    tracker.invalidate,
  );
  const unsubscribeObservabilityEntries =
    observabilityEntriesInterestRegistry.subscribe((active) => {
      tracker.invalidate();
      if (active) {
        requestObservabilitySnapshotCatchUp();
        return;
      }
      observabilityInterestGeneration += 1;
      observabilityCatchUpGeneration = observabilityInterestGeneration;
      useObservabilityStore.getState().clearEntryCaches();
    });
  const unsubscribeSources = subscribeSources(surface, tracker.invalidate);
  const removeRedeclare = setChatInterestRedeclareHandler(tracker.redeclare);
  const dispose = (): void => {
    unsubscribeSources();
    unsubscribeExpandedRuns();
    unsubscribeObservabilityEntries();
    removeRedeclare();
    unsubscribeTracker();
    tracker.dispose();
    if (running?.dispose === dispose) running = null;
  };
  running = { surface, tracker, dispose };
  // Declare on page load, even before any source changes.
  tracker.invalidate();
  if (observabilityEntriesInterestRegistry.active()) {
    requestObservabilitySnapshotCatchUp();
  }
  return dispose;
}

/** Track and declare this renderer's chat interest while mounted. */
export function useChatInterestDeclaration(surface: ChatInterestSurface): void {
  useEffect(() => startChatInterestTracking(surface), [surface]);
}

/** This renderer's current interest, or `null` before tracking starts. */
export function getChatInterest(): ChatInterest | null {
  return running?.tracker.current() ?? null;
}

/** Called with the new interest whenever it changes. */
export function subscribeChatInterest(
  listener: ChatInterestListener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** Barrier for newest-page catch-up: main must acknowledge focus first. */
export async function flushChatInterest(): Promise<void> {
  if (!running) throw new Error('Chat interest tracking is not started.');
  await running.tracker.flushNow();
}

/** Warm a chat ahead of a likely switch; resolves once main acknowledges it. */
export async function warmUpChat(ref: ChatInterestChatRef): Promise<void> {
  if (!running) throw new Error('Chat interest tracking is not started.');
  await running.tracker.warmUp(ref);
}
