/** Prefetch likely switches into the cache without changing navigation or unread. */
import { useEffect } from 'react';
import type { ChatInterestChatRef } from '@canopy/desktop-shared/types';
import {
  flushChatInterest,
  getChatInterest,
  warmUpChat,
} from '@/lib/chat-interest';
import { chatInterestRefKey } from '@/lib/chat-interest/tracker';
import {
  readWorktreePanelLayoutAhead,
  type WorktreeLayoutReadAheadIntent,
} from '@/lib/panels/persistence-bridge';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';
import { resolveAttentionLanding } from './attention-landing';
import { chatScopeKey } from './revisioned-sync';
import { chatStoreApi } from './store-ref';
import type { ChatState } from './state';
import type { ChatTab } from './types';
import { catchUpStaleChat, isStaleChatCatchUpRunning } from './stale-catch-up';
import { readAheadWebCoreScope } from './web-core';

/**
 * What a click would show: a chat, a worktree's active/landing chat, or a
 * cloud task, which is read ahead through the web core alone (CAN-6774).
 */
export type ChatPrefetchTarget =
  | ({ kind: 'chat' } & ChatInterestChatRef)
  | {
      kind: 'worktree';
      projectId: string;
      worktreeId: string;
      /** Resolve the implicit entry destination instead of its active tab. */
      attentionLanding?: boolean;
    }
  | { kind: 'cloudTask'; projectId: string; worktreeId: string };

/** Pointer intents wait for a short dwell; keyboard focus acts at once. */
export type ChatPrefetchSource = 'pointer' | 'focus';

export interface ChatPrefetchHost {
  getState(): Pick<
    ChatState,
    | 'worktreeChats'
    | 'chatStateSync'
    | 'hiddenChatTabIds'
    | 'pendingQuestions'
    | 'pendingApprovals'
    | 'pendingPlanExits'
  >;
  subscribe(callback: () => void): () => void;
  focused(): readonly ChatInterestChatRef[];
  isCatchingUp(target: ChatInterestChatRef): boolean;
  hydrate: ChatState['hydrateChatScopeRevisioned'];
  warmUp(target: ChatInterestChatRef): Promise<void>;
  catchUp(
    target: ChatInterestChatRef,
    flush: () => Promise<void>,
  ): Promise<void>;
  flush: () => Promise<void>;
  scheduleIdle: (callback: () => void) => () => void;
  /**
   * Reads a cloud task ahead through the web core: chat reads only, so its
   * sandbox never wakes, with nothing installed, followed or sent to main
   * (CAN-6774). Null when the web core backend is not there.
   */
  readAheadCloudTask(
    projectId: string,
    worktreeId: string,
  ): { readonly settled: Promise<void>; readonly discard: () => void } | null;
  /**
   * Gets ready what the target's panel grid waits for on a first visit, so
   * the grid can mount in the click's own frame. Read-only for a target the
   * user points at or moves keyboard focus onto (`point`). On `press` (the
   * pointer went down on it, and the click follows) and `activate` (Enter or
   * Space on the focused row, which opens it at once), the visit's own state
   * reads may start now.
   */
  readLayoutAhead?(
    target: ChatPrefetchTarget,
    intent: WorktreeLayoutReadAheadIntent,
  ): void;
  /** The element keyboard focus is on now. */
  focusedElement?(): unknown;
  /**
   * Calls `listener` with the target of each Enter or Space keydown, before
   * the page's own handlers see it. Returns its removal.
   */
  onActivationKey?(listener: (target: unknown) => void): () => void;
}

interface Intent {
  target: ChatPrefetchTarget;
  timer?: ReturnType<typeof setTimeout>;
}

const DWELL_MS = 80;
const QUEUE_LIMIT = 8;
let running: {
  note(target: ChatPrefetchTarget, source: ChatPrefetchSource): void;
  end(target: ChatPrefetchTarget): void;
  dispose: () => void;
} | null = null;

function targetKey(target: ChatPrefetchTarget): string {
  return JSON.stringify([
    target.projectId,
    target.worktreeId,
    target.kind === 'chat' ? target.chatId : null,
    target.kind === 'worktree' && target.attentionLanding === true,
    target.kind === 'cloudTask',
  ]);
}

/** The pointer rests on, or focus moved onto, an element that shows `target`. */
export const noteChatIntent: (
  target: ChatPrefetchTarget,
  source: ChatPrefetchSource,
) => void = (target, source) => running?.note(target, source);

/** The pointer or focus left `target`: cancel its prefetch if not started. */
export const endChatIntent: (target: ChatPrefetchTarget) => void = (target) =>
  running?.end(target);

/** One scheduler per main renderer; all store/transport effects are host ports. */
export function startChatPrefetch(host: ChatPrefetchHost): () => void {
  running?.dispose();
  let disposed = false;
  let active = 0;
  let idleActive = false;
  let cancelIdle: (() => void) | undefined;
  const intents = new Map<string, Intent>();
  /**
   * The target under the pointer, if any. Focus moving onto it is the
   * pointer pressing it (the row takes focus on pointer down, well before
   * the click); focus arriving anywhere else came from the keyboard.
   */
  let pointedKey: string | null = null;
  /**
   * The target keyboard focus last moved onto, with the element it moved
   * onto. Enter or Space on that element opens the target in the same task:
   * the keydown is its press.
   */
  let focusedTarget: { target: ChatPrefetchTarget; element: unknown } | null =
    null;
  const inFlight = new Set<string>();
  /** Cloud tasks read ahead, by target: dropped when the pointer leaves. */
  const readAheads = new Map<string, () => void>();
  /** The cloud task read ahead now, if any: one at a time (CAN-6774). */
  let cloudInFlight: Promise<void> | null = null;
  const queue: Intent[] = [];
  // A failed idle read must not spin on the same cached tab. A new projection
  // can be tried again, and old projections do not remain retained here.
  const idleAttempted = new WeakSet<ChatTab>();

  const allowed = (): boolean => !disposed;
  const skip = (ref: ChatInterestChatRef): boolean =>
    host.isCatchingUp(ref) ||
    host
      .focused()
      .some(
        (focused) => chatInterestRefKey(focused) === chatInterestRefKey(ref),
      );

  const prefetch = async (target: ChatPrefetchTarget): Promise<void> => {
    const scope = chatScopeKey(target.projectId, target.worktreeId);
    const untracked = !host.getState().chatStateSync[scope];
    if (target.kind === 'cloudTask') {
      // One cloud task is read ahead at a time, so a pointer swept over the
      // sidebar never sends a read per row: a row rested on meanwhile waits,
      // and is read only if the pointer is still on it.
      const key = targetKey(target);
      while (cloudInFlight !== null) {
        await cloudInFlight;
        if (!allowed() || !intents.has(key)) return;
      }
      // A task the store holds opens warm; nothing to read ahead.
      if (host.getState().chatStateSync[scope]) return;
      const ahead = host.readAheadCloudTask(
        target.projectId,
        target.worktreeId,
      );
      if (ahead === null) return;
      readAheads.set(key, ahead.discard);
      const settled = ahead.settled;
      cloudInFlight = settled;
      try {
        await settled;
      } finally {
        if (cloudInFlight === settled) cloudInFlight = null;
      }
      return;
    }
    if (target.kind === 'chat' && skip(target)) return;
    if (untracked) {
      const result = await host.hydrate(target.projectId, target.worktreeId);
      if (result !== 'installed' || !allowed()) return;
    }
    const chatState = host.getState();
    const state = chatState.worktreeChats[scope];
    let chatId = target.kind === 'chat' ? target.chatId : state?.activeTabId;
    if (target.kind === 'worktree' && target.attentionLanding && state) {
      chatId =
        resolveAttentionLanding({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          tabs: state.tabs,
          activeTabId: state.activeTabId,
          hiddenChatTabIds: chatState.hiddenChatTabIds,
          pendingQuestions: chatState.pendingQuestions,
          pendingApprovals: chatState.pendingApprovals,
          pendingPlanExits: chatState.pendingPlanExits,
        }).tabId ?? state.activeTabId;
    }
    if (!chatId) return;
    const ref: ChatInterestChatRef = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId,
    };
    const tab = state?.tabs.find((entry) => entry.id === chatId);
    const key = chatInterestRefKey(ref);
    if (
      !tab ||
      tab.kind === 'file' ||
      // A tracked chat needs a read only when stale or never loaded.
      (!untracked && !tab.transcriptStale && tab.transcriptLoaded !== false) ||
      skip(ref) ||
      inFlight.has(key)
    )
      return;
    inFlight.add(key);
    try {
      await host.warmUp(ref);
      if (allowed() && !skip(ref)) await host.catchUp(ref, host.flush);
    } finally {
      inFlight.delete(key);
    }
  };

  const launch = (intent: Intent, idle = false): void => {
    active += 1;
    if (idle) idleActive = true;
    void prefetch(intent.target)
      .catch(() => undefined)
      .finally(() => {
        active -= 1;
        if (idle) idleActive = false;
        if (intents.get(targetKey(intent.target)) === intent)
          intents.delete(targetKey(intent.target));
        drain();
        scheduleIdle();
      });
  };

  const drain = (): void => {
    while (allowed() && active < 2 && queue.length) {
      const intent = queue.shift();
      if (intent && intents.get(targetKey(intent.target)) === intent)
        launch(intent);
    }
  };

  const scheduleIdle = (): void => {
    if (!allowed() || cancelIdle || idleActive || active >= 2) return;
    cancelIdle = host.scheduleIdle(() => {
      cancelIdle = undefined;
      if (!allowed() || idleActive || active >= 2) return;
      let newest:
        | { ref: ChatInterestChatRef; tab: ChatTab; at: number }
        | undefined;
      for (const [scope, state] of Object.entries(
        host.getState().worktreeChats,
      )) {
        const slash = scope.indexOf('/');
        if (slash < 0) continue;
        for (const tab of state.tabs) {
          const ref = {
            projectId: scope.slice(0, slash),
            worktreeId: scope.slice(slash + 1),
            chatId: tab.id,
          };
          if (
            !tab.unread ||
            !tab.transcriptStale ||
            tab.kind === 'file' ||
            idleAttempted.has(tab) ||
            inFlight.has(chatInterestRefKey(ref)) ||
            skip(ref)
          )
            continue;
          const at =
            tab.lastEventAt ??
            tab.messages[tab.messages.length - 1]?.timestamp ??
            (Date.parse(tab.createdAt) || 0);
          if (!newest || at > newest.at) newest = { ref, tab, at };
        }
      }
      if (newest) {
        idleAttempted.add(newest.tab);
        launch({ target: { kind: 'chat', ...newest.ref } }, true);
      }
    });
  };

  const clearPending = (): void => {
    for (const intent of Array.from(intents.values()))
      clearTimeout(intent.timer);
    intents.clear();
    for (const discard of Array.from(readAheads.values())) discard();
    readAheads.clear();
    queue.length = 0;
    cancelIdle?.();
    cancelIdle = undefined;
  };
  const unsubscribeStore = host.subscribe(scheduleIdle);
  // Not cleared when the target's intent ends: the pointer leaving a row that
  // keeps keyboard focus ends it too. The element check below is what makes
  // a key the row's own.
  const removeActivationKey = host.onActivationKey?.((keyTarget) => {
    if (
      allowed() &&
      focusedTarget !== null &&
      focusedTarget.element !== null &&
      keyTarget === focusedTarget.element
    ) {
      host.readLayoutAhead?.(focusedTarget.target, 'activate');
    }
  });
  const scheduler: NonNullable<typeof running> = {
    note: (target, source): void => {
      if (!allowed()) return;
      const key = targetKey(target);
      if (source === 'pointer') pointedKey = key;
      else {
        focusedTarget = { target, element: host.focusedElement?.() ?? null };
        if (pointedKey === key) host.readLayoutAhead?.(target, 'press');
      }
      const previous = intents.get(key);
      if (previous) {
        if (source !== 'focus' || previous.timer === undefined) return;
        clearTimeout(previous.timer);
        previous.timer = undefined;
        enqueue(previous);
      } else {
        const intent: Intent = { target };
        intents.set(key, intent);
        if (source === 'pointer') {
          intent.timer = setTimeout(() => {
            intent.timer = undefined;
            enqueue(intent);
          }, DWELL_MS);
          return;
        }
        enqueue(intent);
      }
    },
    end: (target): void => {
      const key = targetKey(target);
      if (pointedKey === key) pointedKey = null;
      clearTimeout(intents.get(key)?.timer);
      intents.delete(key);
      // A cloud task the pointer left is not opened: its reads are dropped.
      // One a click opened meanwhile already took them.
      readAheads.get(key)?.();
      readAheads.delete(key);
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      pointedKey = null;
      focusedTarget = null;
      clearPending();
      unsubscribeStore();
      removeActivationKey?.();
      if (running === scheduler) running = null;
    },
  };
  const enqueue = (intent: Intent): void => {
    // Not queued behind the transcript reads: two small reads, wanted by the
    // click whether or not the chat itself needs a prefetch.
    host.readLayoutAhead?.(intent.target, 'point');
    queue.unshift(intent);
    while (queue.length > QUEUE_LIMIT) {
      const dropped = queue.pop();
      if (dropped && intents.get(targetKey(dropped.target)) === dropped)
        intents.delete(targetKey(dropped.target));
    }
    drain();
  };
  running = scheduler;
  scheduleIdle();
  return scheduler.dispose;
}

function scheduleBrowserIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 1000 });
    return (): void => window.cancelIdleCallback(id);
  }
  const timer = setTimeout(callback, 1000);
  return (): void => clearTimeout(timer);
}

const browserHost: ChatPrefetchHost = {
  getState: () => chatStoreApi().getState(),
  subscribe: (callback) =>
    chatStoreApi().subscribe((state, previous) => {
      if (state.worktreeChats !== previous.worktreeChats) callback();
    }),
  focused: () => getChatInterest()?.focused ?? [],
  isCatchingUp: isStaleChatCatchUpRunning,
  hydrate: (projectId, worktreeId) =>
    chatStoreApi()
      .getState()
      .hydrateChatScopeRevisioned(projectId, worktreeId, {
        speculative: true,
      }),
  warmUp: warmUpChat,
  catchUp: catchUpStaleChat,
  flush: flushChatInterest,
  scheduleIdle: scheduleBrowserIdle,
  readAheadCloudTask: (projectId, worktreeId) =>
    readAheadWebCoreScope({ projectId, worktreeId }),
  readLayoutAhead: (target, intent) => {
    // A cloud task keeps its layout in this window's own storage.
    if (target.kind === 'cloudTask') return;
    readWorktreePanelLayoutAhead(
      makeWorktreePanelKey(target.projectId, target.worktreeId),
      { intent },
    );
  },
  focusedElement: () => document.activeElement,
  onActivationKey: (listener) => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        !event.repeat &&
        !event.isComposing
      ) {
        listener(event.target);
      }
    };
    // Capture on the window: ahead of the row's own handler, which opens it.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return (): void =>
      window.removeEventListener('keydown', onKeyDown, { capture: true });
  },
};

export function useChatPrefetch(): void {
  useEffect(() => startChatPrefetch(browserHost), []);
}
