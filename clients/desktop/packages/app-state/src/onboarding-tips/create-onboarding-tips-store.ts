import { create } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import type {
  OnboardingTipDismissals,
  OnboardingTipId,
  OnboardingTipsState,
} from '@canopy/protocol/onboarding-tips';
import type { RemoteControlChatSummaryEntity } from '@canopy/protocol/remote-control/shell';
import { createClientStore } from '../create-client-store';
import {
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../client-store-lifecycle';

/**
 * `unavailable`: the host keeps no dismissals (`onboardingTips` unset), or
 * they could not be read, so no tip shows rather than one the user may
 * already have set aside.
 */
export type OnboardingTipsStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/** The tip on screen, and the slot (one mounted tip host) showing it. */
export interface CurrentOnboardingTip {
  readonly tipId: OnboardingTipId;
  readonly slot: string;
}

/**
 * Whether the user has worked in a worktree chat before, on the current
 * dismissal source (CAN-5005). `used` sticks for the session; `fresh` only
 * means no chat had history at the last check, and each new worktree arrival
 * checks again. `unknown` (never checked, or the check failed) never shows the
 * worktree tip.
 */
export type OnboardingTipsWorktreeHistory =
  | 'unknown'
  | 'checking'
  | 'fresh'
  | 'used';

/**
 * The worktree chat a slot is on. `loading` while the chat or its transcript
 * has not arrived: not yet known to be empty. `used` once it holds a user or
 * assistant message.
 */
export interface OnboardingTipWorktreeChat {
  readonly chatId: string;
  readonly workspaceLocalId: string;
  readonly worktreeLocalId: string;
  readonly transcript: 'loading' | 'empty' | 'used';
  /** Confirmed by this interface's creation lifecycle, never inferred from emptiness. */
  readonly newlyCreated?: boolean;
}

/** Shared transcript policy; known conversation content wins over stale metadata. */
export function onboardingTipTranscript(
  messages: readonly { readonly role: string }[] | undefined,
  loaded: boolean,
): OnboardingTipWorktreeChat['transcript'] {
  if (
    messages?.some(
      (message) => message.role === 'user' || message.role === 'assistant',
    )
  )
    return 'used';
  return messages !== undefined && loaded ? 'empty' : 'loading';
}

type WorktreeChatTarget = Pick<
  OnboardingTipWorktreeChat,
  'workspaceLocalId' | 'worktreeLocalId' | 'chatId'
>;

function chatKey(chat: {
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly chatId: string;
}): string {
  return JSON.stringify([
    chat.workspaceLocalId,
    chat.worktreeLocalId,
    chat.chatId,
  ]);
}

/** What a slot arrived at. */
export interface OnboardingTipArrival {
  /**
   * The logical place (a chat, a page). A call with the same key is the same
   * visit, so a rerender or a transcript that finishes loading never brings
   * up a tip the visit did not already earn. Omitted, every call is a visit.
   */
  readonly key?: string;
  /** Required for the `worktree-chat` tip; without it that tip never shows. */
  readonly worktreeChat?: OnboardingTipWorktreeChat;
}

export interface OnboardingTipsStoreState {
  readonly status: OnboardingTipsStatus;
  readonly dismissed: OnboardingTipDismissals;
  readonly current: CurrentOnboardingTip | null;
  /**
   * A notice (an automatic What's new) used this session's notice budget: no
   * tip shows until the user sends a new turn, then only on a later visit.
   */
  readonly held: boolean;
  readonly worktreeHistory: OnboardingTipsWorktreeHistory;
  /**
   * Reads the dismissals once per client; later calls do nothing. After the
   * first read, the store reads again whenever the window regains focus, so a
   * change made on another surface (desktop or a Portal tab) arrives.
   */
  readonly load: () => void;
  /**
   * Takes dismissals the host pushed after a change made elsewhere (the
   * desktop's synced preferences after a Portal dismissal). Ignored until the
   * first read succeeds.
   */
  readonly sync: (dismissed: OnboardingTipDismissals) => void;
  /**
   * The user arrived on a slot's surface: show the first tip in `eligible`
   * (highest priority first) they have not dismissed, unless another slot
   * already shows one. A tip still eligible here keeps showing. The worktree
   * tip shows only to a first-time worktree user, once the chat's transcript
   * and the user's chat history are both known.
   */
  readonly arrive: (
    slot: string,
    eligible: readonly OnboardingTipId[],
    arrival?: OnboardingTipArrival,
  ) => void;
  /** The slot unmounted: its tip stops showing. */
  readonly leave: (slot: string) => void;
  /**
   * Got it, the close button, or acting on the tip. The next tip waits for
   * the user's next arrival; dismissing never shows one in its place.
   */
  readonly dismiss: (tipId: OnboardingTipId) => void;
  /**
   * "Show tips again": every tip shows again on its next arrival, under its
   * usual rules. It does not forget worktree history or lift a notice hold.
   */
  readonly reset: () => Promise<void>;
  /**
   * An automatic notice is on screen: clear the tip and hold the rest until
   * the user sends a turn. A repeat call for the same `noticeKey` does nothing.
   */
  readonly holdForNotice: (noticeKey?: string) => void;
  /**
   * The host accepted a new turn (not an answer or a queued-message edit).
   * Lifts a notice hold, without showing a tip in place; a worktree chat
   * turn also marks worktree history used.
   */
  readonly noteTurnSent: (turn: { readonly worktreeChat: boolean }) => void;
  /**
   * Records local creation provenance across pane remounts. When creation is
   * still pending, its outcome confirms experience or removes the unused id.
   */
  readonly noteWorktreeChatCreated: (
    chat: WorktreeChatTarget,
    confirmation?: Promise<boolean>,
  ) => void;
}

/** A slot's current visit. */
interface SlotArrival {
  readonly key: string | undefined;
  ready: boolean;
  /** Began before a notice: shows nothing until the next visit. */
  blocked: boolean;
  eligible: readonly OnboardingTipId[];
  worktreeChat: OnboardingTipWorktreeChat | undefined;
  /**
   * The history check for this visit: waiting on query `query`, or whether
   * its answer allows the worktree tip here. Null when the visit has none.
   */
  worktree: { pending: number } | { fresh: boolean } | null;
  /** Revalidate an early pending read once the transcript becomes empty. */
  retryWhenSettled: boolean;
}

/**
 * A worktree chat summary as history evidence: `messageCount` when present,
 * else the newest message's role or time. Neither: unknown, not empty.
 */
function summaryHistory(
  summary: RemoteControlChatSummaryEntity,
): 'used' | 'empty' | 'unknown' {
  if (typeof summary.messageCount === 'number') {
    return summary.messageCount > 0
      ? 'used'
      : summary.messageCount === 0
        ? 'empty'
        : 'unknown';
  }
  if (summary.lastMessageRole != null || summary.lastMessageAt != null) {
    return 'used';
  }
  return 'unknown';
}

/**
 * Onboarding tips for one client lifecycle (CAN-4904): one queue so at most
 * one tip shows at a time, and the host's dismissal store, so a dismissed tip
 * stays gone across restarts and on every surface that reads the same store.
 */
export function createOnboardingTipsStore(
  client: CanopyClient,
): ClientStore<OnboardingTipsStoreState> {
  // Advances on every read and write, so a late read never overwrites a
  // newer dismissal.
  let generation = 0;
  let disposed = false;
  // Tips dismissed here whose save the host has not confirmed yet. A read that
  // raced the save, or a save that failed, never brings one back. A confirmed
  // dismissal leaves this set, so the host's record is the only truth after
  // that (a Portal paired with another desktop sees that desktop's record).
  let sessionDismissed: Partial<Record<OnboardingTipId, string>> = {};
  let stopWatchingFocus: (() => void) | null = null;
  let stopWatchingSource: (() => void) | null = null;
  let sourceGeneration = 0;
  // Slots that arrived while another slot showed the tip, in arrival order.
  // When that slot goes away (unmounted or hidden), the first one with a tip
  // takes over; a dismissal clears them, so the next tip waits for a visit.
  const waiting = new Map<string, readonly OnboardingTipId[]>();
  // Advances on every Show tips again, so a dismissal reply that started
  // earlier can't undo the reset.
  let resets = 0;
  // Every slot's current visit, so a rerender is not mistaken for a new one.
  const arrivals = new Map<string, SlotArrival>();
  // Notices that already held tips, so a replayed effect holds nothing new.
  const heldNotices = new Set<string>();
  // The one history read in flight, shared by every visit that needs it.
  let historyQuery: number | null = null;
  let historyQueries = 0;
  // The worktree chats the last successful read found, by chat id.
  let worktreeChats = new Map<string, 'used' | 'empty' | 'unknown'>();
  const newlyCreatedChats = new Set<string>();
  const confirmedCreatedChats = new Set<string>();

  const store: ClientStore<OnboardingTipsStoreState> =
    create<OnboardingTipsStoreState>()((set, get) => {
      const read = (): void => {
        if (client.capabilities.onboardingTips !== true) {
          set({ status: 'unavailable', current: null });
          return;
        }
        generation += 1;
        const request = generation;
        if (get().status === 'idle') set({ status: 'loading' });
        client
          .query('onboardingTips.get', {})
          .then((state) => {
            if (disposed || request !== generation) return;
            accept(state.dismissed);
          })
          .catch(() => {
            if (disposed || request !== generation) return;
            // Keep what an earlier read found; a first read that fails shows
            // no tips at all.
            if (get().status !== 'ready') {
              set({ status: 'unavailable', current: null });
            }
          });
      };

      // A tip dismissed on another surface goes away here too.
      const accept = (stored: OnboardingTipDismissals): void => {
        const current = get().current;
        const dismissed = { ...stored, ...sessionDismissed };
        for (const arrival of Array.from(arrivals.values())) {
          if (
            arrival.ready &&
            arrival.eligible.some(
              (id) =>
                dismissed[id] !== undefined &&
                get().dismissed[id] === undefined,
            )
          ) {
            arrival.blocked = true;
            arrival.worktree = null;
          }
        }
        set({
          status: 'ready',
          dismissed,
          current:
            current !== null && dismissed[current.tipId] !== undefined
              ? null
              : current,
        });
      };

      // Once worktree history is known, every worktree tip goes, whether
      // shown, waiting or still checking.
      const markWorktreeUsed = (): void => {
        for (const arrival of Array.from(arrivals.values())) {
          if (arrival.worktree !== null) arrival.worktree = { fresh: false };
        }
        for (const [slot, eligible] of Array.from(waiting.entries())) {
          const rest = eligible.filter((id) => id !== 'worktree-chat');
          if (rest.length > 0) waiting.set(slot, rest);
          else waiting.delete(slot);
        }
        const current = get().current;
        set({
          worktreeHistory: 'used',
          current: current?.tipId === 'worktree-chat' ? null : current,
        });
      };

      const rememberCreated = (chat: WorktreeChatTarget): void => {
        const key = chatKey(chat);
        if (!confirmedCreatedChats.has(key) && confirmedCreatedChats.size > 0)
          markWorktreeUsed();
        confirmedCreatedChats.add(key);
        newlyCreatedChats.add(key);
      };

      // A first-time user: no worktree chat has history, and the only one is
      // the chat they are on. Any other, even an empty one, is a chat they
      // made before.
      const freshFor = (chatId: string): boolean =>
        get().worktreeHistory !== 'used' &&
        newlyCreatedChats.has(chatId) &&
        worktreeChats.size === 1 &&
        worktreeChats.get(chatId) === 'empty';

      // A failed read leaves history unknown; a used result sticks.
      const recordHistory = (chats: typeof worktreeChats | null): void => {
        const history = get().worktreeHistory;
        if (chats === null) {
          if (history === 'checking') set({ worktreeHistory: 'unknown' });
          return;
        }
        worktreeChats = chats;
        if (history === 'used') return;
        if (
          Array.from(chats.values()).includes('used') ||
          chats.size > 1 ||
          Array.from(chats.keys()).some((id) => !newlyCreatedChats.has(id))
        )
          markWorktreeUsed();
        else
          set({
            worktreeHistory:
              chats.size === 1 &&
              !Array.from(chats.values()).includes('unknown')
                ? 'fresh'
                : 'unknown',
          });
      };

      // Visits still waiting on read `request` get its answer; a first-time
      // user's visit shows the tip now.
      const finishVisits = (request: number, succeeded: boolean): void => {
        const retries: SlotArrival[] = [];
        for (const [slot, arrival] of Array.from(arrivals.entries())) {
          const worktree = arrival.worktree;
          if (worktree === null || !('pending' in worktree)) continue;
          if (worktree.pending !== request) continue;
          const chatId = arrival.worktreeChat
            ? chatKey(arrival.worktreeChat)
            : undefined;
          const fresh = succeeded && chatId !== undefined && freshFor(chatId);
          const retry = arrival.retryWhenSettled;
          arrival.retryWhenSettled = false;
          arrival.worktree = { fresh };
          if (fresh) show(slot, arrival);
          else if (
            retry &&
            !arrival.blocked &&
            arrival.eligible.includes('worktree-chat') &&
            arrival.worktreeChat?.transcript === 'empty' &&
            get().dismissed['worktree-chat'] === undefined &&
            get().worktreeHistory !== 'used'
          )
            retries.push(arrival);
        }
        for (const arrival of retries) {
          arrival.worktree = { pending: checkHistory() };
        }
      };

      const checkHistory = (): number => {
        if (historyQuery !== null) return historyQuery;
        historyQueries += 1;
        const request = historyQueries;
        const source = sourceGeneration;
        historyQuery = request;
        if (get().worktreeHistory !== 'used') {
          set({ worktreeHistory: 'checking' });
        }
        const settle = (chats: typeof worktreeChats | null): void => {
          if (
            disposed ||
            source !== sourceGeneration ||
            historyQuery !== request
          )
            return;
          historyQuery = null;
          recordHistory(chats);
          finishVisits(request, chats !== null);
        };
        client
          .query('session.snapshot', { includeChatSummaries: true })
          .then((snapshot) => {
            const chats = new Map<string, 'used' | 'empty' | 'unknown'>();
            let complete = true;
            let used = false;
            for (const summary of snapshot.chatSummaries) {
              if (summary.scope !== 'worktree') continue;
              const evidence = summaryHistory(summary);
              if (!summary.workspaceLocalId || !summary.worktreeLocalId)
                complete = false;
              if (evidence === 'used') used = true;
              chats.set(chatKey(summary), evidence);
            }
            settle(complete || used ? chats : null);
          })
          .catch(() => settle(null));
        return request;
      };

      // The tips this visit may show now. The worktree tip needs a loaded,
      // empty transcript and a history check, made once per visit, that found
      // a first-time user.
      const allowed = (arrival: SlotArrival): readonly OnboardingTipId[] =>
        arrival.eligible.filter((id) => {
          if (id !== 'worktree-chat') return true;
          const worktree = arrival.worktree;
          return (
            get().worktreeHistory !== 'used' &&
            arrival.worktreeChat?.transcript === 'empty' &&
            worktree !== null &&
            'fresh' in worktree &&
            worktree.fresh
          );
        });

      // Puts the visit's first allowed tip on screen, or queues the slot
      // behind the slot that shows one.
      const show = (slot: string, arrival: SlotArrival): void => {
        const { status, current, dismissed, held } = get();
        if (status !== 'ready') return;
        const eligible =
          held || arrival.blocked
            ? []
            : allowed(arrival).filter((id) => dismissed[id] === undefined);
        if (current !== null && current.slot !== slot) {
          if (eligible.length > 0) waiting.set(slot, eligible);
          else waiting.delete(slot);
          return;
        }
        waiting.delete(slot);
        if (current !== null && eligible.includes(current.tipId)) return;
        const tipId = eligible[0];
        set({ current: tipId === undefined ? null : { tipId, slot } });
      };

      return {
        status: 'idle',
        dismissed: {},
        current: null,
        held: false,
        worktreeHistory: 'unknown',
        load: (): void => {
          if (disposed) return;
          if (stopWatchingSource === null) {
            stopWatchingSource =
              client.subscribeOnboardingTipsSourceChange?.(() => {
                sourceGeneration += 1;
                generation += 1;
                resets += 1;
                sessionDismissed = {};
                waiting.clear();
                // A new source has its own history. A visit a notice held
                // stays held; the others visit again once the source loads.
                historyQuery = null;
                worktreeChats = new Map();
                newlyCreatedChats.clear();
                confirmedCreatedChats.clear();
                for (const [slot, arrival] of Array.from(arrivals.entries())) {
                  if (arrival.blocked) arrival.worktree = null;
                  else arrivals.delete(slot);
                }
                set({
                  status: 'idle',
                  dismissed: {},
                  current: null,
                  worktreeHistory: 'unknown',
                });
                read();
              }) ?? null;
          }
          // An unavailable store tries again: on the web a paired desktop can
          // attach after the first slot mounted, or return after a drop.
          const { status } = get();
          if (status !== 'idle' && status !== 'unavailable') return;
          read();
          if (stopWatchingFocus !== null || typeof window === 'undefined') {
            return;
          }
          const onFocus = (): void => {
            const { status } = get();
            if (status === 'ready' || status === 'unavailable') read();
          };
          const onVisibility = (): void => {
            if (document.visibilityState === 'visible') onFocus();
          };
          window.addEventListener('focus', onFocus);
          document.addEventListener('visibilitychange', onVisibility);
          stopWatchingFocus = (): void => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibility);
          };
        },
        sync: (dismissed): void => {
          if (get().status !== 'ready') return;
          generation += 1;
          accept(dismissed);
        },
        arrive: (slot, eligible, visit = {}): void => {
          if (disposed) return;
          const previous = arrivals.get(slot);
          const isNewVisit =
            previous === undefined ||
            visit.key === undefined ||
            previous.key !== visit.key ||
            (previous.worktreeChat &&
              visit.worktreeChat &&
              chatKey(previous.worktreeChat) !== chatKey(visit.worktreeChat));
          const arrival: SlotArrival = isNewVisit
            ? {
                key: visit.key,
                ready: false,
                blocked: get().held,
                eligible,
                worktreeChat: visit.worktreeChat,
                worktree: null,
                retryWhenSettled: false,
              }
            : previous;
          const transcriptBecameEmpty =
            arrival.worktreeChat?.transcript === 'loading' &&
            visit.worktreeChat?.transcript === 'empty';
          if (
            transcriptBecameEmpty &&
            arrival.worktree !== null &&
            'pending' in arrival.worktree
          )
            arrival.retryWhenSettled = true;
          const retryHistory =
            transcriptBecameEmpty &&
            arrival.worktree !== null &&
            'fresh' in arrival.worktree &&
            !arrival.worktree.fresh;
          if (
            !isNewVisit &&
            arrival.eligible.some((id) => !eligible.includes(id))
          ) {
            arrival.blocked = true;
            arrival.worktree = null;
          }
          arrival.eligible = eligible;
          // The same visit can move to another chat only through a new key,
          // so a changed chat id here is a new visit's facts.
          arrival.worktreeChat = visit.worktreeChat;
          if (
            eligible.includes('worktree-chat') &&
            visit.worktreeChat?.newlyCreated === true
          ) {
            rememberCreated(visit.worktreeChat);
          }
          arrivals.set(slot, arrival);
          if (get().status !== 'ready') return;
          const firstReady = !arrival.ready;
          arrival.ready = true;
          if (
            eligible.includes('worktree-chat') &&
            visit.worktreeChat?.transcript === 'used'
          ) {
            if (get().worktreeHistory !== 'used') markWorktreeUsed();
          } else if (
            // A read shared with an earlier/loading chat can fail or omit a
            // newly created chat. Revalidate once its transcript is known;
            // ordinary rerenders of the same empty transcript do not retry.
            (isNewVisit || firstReady || retryHistory) &&
            !arrival.blocked &&
            eligible.includes('worktree-chat') &&
            visit.worktreeChat !== undefined &&
            get().dismissed['worktree-chat'] === undefined &&
            get().worktreeHistory !== 'used'
          ) {
            arrival.worktree = { pending: checkHistory() };
          }
          show(slot, arrival);
        },
        leave: (slot): void => {
          waiting.delete(slot);
          arrivals.delete(slot);
          if (get().current?.slot !== slot) return;
          const { dismissed } = get();
          for (const [next] of Array.from(waiting.entries())) {
            const arrival = arrivals.get(next);
            const tipId =
              !get().held && arrival && !arrival.blocked
                ? allowed(arrival).find((id) => dismissed[id] === undefined)
                : undefined;
            waiting.delete(next);
            if (tipId !== undefined) {
              set({ current: { tipId, slot: next } });
              return;
            }
          }
          set({ current: null });
        },
        dismiss: (tipId): void => {
          const { dismissed, current } = get();
          const resetsAtStart = resets;
          sessionDismissed = {
            [tipId]: dismissed[tipId] ?? new Date().toISOString(),
            ...sessionDismissed,
          };
          waiting.clear();
          for (const arrival of Array.from(arrivals.values())) {
            arrival.blocked = true;
            arrival.worktree = null;
          }
          set({
            dismissed:
              dismissed[tipId] === undefined
                ? { ...dismissed, [tipId]: new Date().toISOString() }
                : dismissed,
            current: current?.tipId === tipId ? null : current,
          });
          client
            .command('onboardingTips.update', { action: 'dismiss', tipId })
            .then((state) => {
              if (disposed || resets !== resetsAtStart) return;
              if (state.dismissed[tipId] !== undefined) {
                const unconfirmed = { ...sessionDismissed };
                delete unconfirmed[tipId];
                sessionDismissed = unconfirmed;
              }
              // The saved record is the newest truth: a read that started
              // before the save landed must not replace it.
              generation += 1;
              accept(state.dismissed);
            })
            .catch(() => {
              // Best effort: the tip stays hidden for this session even when
              // the host could not save it.
            });
        },
        reset: async (): Promise<void> => {
          // Cleared before the write: the host's own synced broadcast can
          // arrive before the reply, and it must not add these back.
          const unconfirmed = sessionDismissed;
          const sourceAtStart = sourceGeneration;
          sessionDismissed = {};
          waiting.clear();
          for (const arrival of Array.from(arrivals.values())) {
            arrival.blocked = true;
            arrival.worktree = null;
          }
          resets += 1;
          generation += 1;
          const request = generation;
          let state: OnboardingTipsState;
          try {
            state = await client.command('onboardingTips.update', {
              action: 'reset',
            });
          } catch (error) {
            if (!disposed && sourceAtStart === sourceGeneration) {
              sessionDismissed = { ...unconfirmed, ...sessionDismissed };
            }
            throw error;
          }
          // A newer read or sync has already applied the reset record.
          if (disposed || request !== generation) return;
          set({ status: 'ready', dismissed: state.dismissed, current: null });
        },
        holdForNotice: (noticeKey): void => {
          if (noticeKey !== undefined) {
            if (heldNotices.has(noticeKey)) return;
            heldNotices.add(noticeKey);
          } else if (get().held) {
            return;
          }
          // Visits on screen now, and their history checks, end here: a turn
          // lifts the hold, but only a later visit can show a tip.
          for (const arrival of Array.from(arrivals.values())) {
            arrival.blocked = true;
            arrival.worktree = null;
          }
          waiting.clear();
          set({ held: true, current: null });
        },
        noteTurnSent: ({ worktreeChat }): void => {
          if (get().held) set({ held: false });
          if (worktreeChat && get().worktreeHistory !== 'used') {
            markWorktreeUsed();
          }
        },
        noteWorktreeChatCreated: (chat, confirmation): void => {
          if (disposed) return;
          if (confirmation === undefined) {
            rememberCreated(chat);
            return;
          }
          const source = sourceGeneration;
          const key = chatKey(chat);
          newlyCreatedChats.add(key);
          const settle = (created: boolean): void => {
            if (disposed || source !== sourceGeneration) return;
            if (created) rememberCreated(chat);
            else if (!confirmedCreatedChats.has(key))
              newlyCreatedChats.delete(key);
          };
          void confirmation.then(settle, () => settle(false));
        },
      };
    });

  store[CLIENT_STORE_DISPOSE] = (): void => {
    disposed = true;
    stopWatchingFocus?.();
    stopWatchingFocus = null;
    stopWatchingSource?.();
    stopWatchingSource = null;
  };
  return store;
}

export const useOnboardingTipsStore = createClientStore(
  createOnboardingTipsStore,
);
