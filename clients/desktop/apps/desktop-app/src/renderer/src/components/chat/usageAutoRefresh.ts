import { useEffect, useRef } from 'react';
import type {
  AgentAuditEntry,
  AgentProviderType,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useObservabilityStore } from '@/stores/observabilityStore';

/**
 * Keeps the plan usage behind the composer's usage ring current without the
 * popover: a provider's usage is re-read shortly after a chat turn on it
 * finishes, when the window regains focus, and every few minutes while the
 * window is focused. Only providers a mounted ring shows are watched.
 *
 * A turn's end comes from the ring's own composer (its chat stops running),
 * and from audit entries when this window receives them: main delivers
 * entries only to a window with an audit or usage page open
 * (`useObservabilityEntriesInterest`), so the composer is the signal every
 * window has.
 *
 * Every read goes through the same `refreshUsage` call the popover makes, so
 * main still shares one provider request across every chat and window (its
 * Claude gate answers from a read under 30 seconds old). This window adds
 * its own floor on top: at most one request per provider per
 * {@link AUTO_REFRESH_MIN_INTERVAL_MS}, shared with the popover's
 * refresh-on-open.
 */

/** The fewest milliseconds between two reads of one provider from this window. */
export const AUTO_REFRESH_MIN_INTERVAL_MS = 30_000;
/** While the window is focused and visible, a read this often. */
const AUTO_REFRESH_TICK_MS = 5 * 60_000;
/**
 * How long after a turn finishes before reading, so turns that end close
 * together (a queue, several chats) share one read.
 */
const TURN_END_DELAY_MS = 4_000;

/** The chat turns whose end can move a plan's limits. */
const CHAT_EVENT_TYPES: ReadonlySet<AgentAuditEntry['eventType']> = new Set([
  'worktree_chat',
  'standalone_chat',
  'app_advisor',
]);

const lastRequestedAt = new Map<AgentProviderType, number>();
const lastCompletedAt = new Map<AgentProviderType, number>();
const watched = new Map<AgentProviderType, number>();
const turnTimers = new Map<AgentProviderType, number>();
const pendingTurns = new Map<AgentProviderType, number>();
let stopListening: (() => void) | null = null;

/**
 * Asks main for a provider's current usage unless this window asked within
 * {@link AUTO_REFRESH_MIN_INTERVAL_MS}. Returns whether it asked.
 */
export function requestProviderUsageRefresh(
  provider: AgentProviderType,
): boolean {
  const now = Date.now();
  const last = lastRefreshAt(provider);
  if (last !== undefined && now - last < AUTO_REFRESH_MIN_INTERVAL_MS) {
    return false;
  }
  lastRequestedAt.set(provider, now);
  // The popover shows a failed read through the provider's error state;
  // the failure is still recorded.
  void useObservabilityStore
    .getState()
    .refreshProviderUsageDetails(provider)
    .then((usage): void => {
      // Main measures freshness from successful completion, not request start.
      // Using receipt time also covers reads joined through the store.
      lastCompletedAt.set(provider, Date.now());
      const turnEndedAt = pendingTurns.get(provider);
      if (turnEndedAt === undefined) return;
      const summary = usage.providers.find(
        (entry) => entry.provider === provider,
      );
      const updatedAt = Date.parse(summary?.lastUpdatedAt ?? '');
      const cachedBeforeTurn =
        summary?.authState === 'authenticated' &&
        summary.error === undefined &&
        summary.errorInfo === undefined &&
        Number.isFinite(updatedAt) &&
        updatedAt <= turnEndedAt;
      if (!cachedBeforeTurn) {
        pendingTurns.delete(provider);
        const timer = turnTimers.get(provider);
        if (timer !== undefined) window.clearTimeout(timer);
        turnTimers.delete(provider);
      } else if (watched.has(provider)) {
        // A cached pre-turn result (including another window's in-flight
        // read) has not satisfied this turn. Keep its refresh pending.
        scheduleAfterTurn(provider, turnEndedAt);
      }
    })
    .catch(reportClientAppError);
  return true;
}

function refreshWatched(): void {
  for (const provider of watched.keys()) {
    requestProviderUsageRefresh(provider);
  }
}

function windowIsActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function lastRefreshAt(provider: AgentProviderType): number | undefined {
  const requested = lastRequestedAt.get(provider);
  const completed = lastCompletedAt.get(provider);
  if (requested === undefined) return completed;
  return Math.max(requested, completed ?? requested);
}

function scheduleAfterTurn(
  provider: AgentProviderType,
  turnEndedAt = Date.now(),
): void {
  pendingTurns.set(provider, turnEndedAt);
  const pending = turnTimers.get(provider);
  if (pending !== undefined) window.clearTimeout(pending);
  // A turn's end is a real change: a read the floor would refuse waits for
  // it instead of being dropped (a focus read just before would otherwise
  // hide the turn until the next tick).
  const last = lastRefreshAt(provider);
  const floorLeft =
    last === undefined ? 0 : last + AUTO_REFRESH_MIN_INTERVAL_MS - Date.now();
  turnTimers.set(
    provider,
    window.setTimeout(
      () => {
        turnTimers.delete(provider);
        if (!watched.has(provider)) return;
        if (!requestProviderUsageRefresh(provider)) {
          scheduleAfterTurn(provider, turnEndedAt);
        }
      },
      Math.max(TURN_END_DELAY_MS, floorLeft),
    ),
  );
}

function startListening(): () => void {
  // Turns that finish from now on: entries already finished are history.
  const finished = new Set(
    useObservabilityStore
      .getState()
      .recentEntries.filter((entry) => entry.completedAt !== undefined)
      .map((entry) => entry.id),
  );
  const unsubscribeEntries = useObservabilityStore.subscribe(
    (state, previous) => {
      if (state.recentEntries === previous.recentEntries) return;
      for (const entry of state.recentEntries) {
        if (entry.completedAt === undefined || finished.has(entry.id)) {
          continue;
        }
        finished.add(entry.id);
        if (
          CHAT_EVENT_TYPES.has(entry.eventType) &&
          watched.has(entry.provider)
        ) {
          scheduleAfterTurn(entry.provider);
        }
      }
    },
  );

  const onFocus = (): void => refreshWatched();
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') refreshWatched();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  const tick = window.setInterval(() => {
    if (windowIsActive()) refreshWatched();
  }, AUTO_REFRESH_TICK_MS);

  return (): void => {
    unsubscribeEntries();
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearInterval(tick);
    for (const timer of turnTimers.values()) window.clearTimeout(timer);
    turnTimers.clear();
    pendingTurns.clear();
  };
}

/**
 * Watches `provider`'s plan usage while the calling ring is mounted (see the
 * module comment); `undefined` watches nothing. `turnActive` is the ring's
 * own chat running a turn: when it stops, the provider is read shortly after.
 */
export function useProviderUsageAutoRefresh(
  provider: AgentProviderType | undefined,
  turnActive = false,
): void {
  const wasActive = useRef(turnActive);
  useEffect(() => {
    const ended = wasActive.current && !turnActive;
    wasActive.current = turnActive;
    if (ended && provider !== undefined) scheduleAfterTurn(provider);
  }, [provider, turnActive]);
  useEffect(() => {
    if (provider === undefined) return undefined;
    watched.set(provider, (watched.get(provider) ?? 0) + 1);
    stopListening ??= startListening();
    return (): void => {
      const count = (watched.get(provider) ?? 1) - 1;
      if (count > 0) watched.set(provider, count);
      else {
        watched.delete(provider);
        pendingTurns.delete(provider);
        const timer = turnTimers.get(provider);
        if (timer !== undefined) window.clearTimeout(timer);
        turnTimers.delete(provider);
      }
      if (watched.size === 0) {
        stopListening?.();
        stopListening = null;
      }
    };
  }, [provider]);
}

/** Forgets every provider's last request (tests start from a clean slate). */
export function resetUsageAutoRefresh(): void {
  lastRequestedAt.clear();
  lastCompletedAt.clear();
}
