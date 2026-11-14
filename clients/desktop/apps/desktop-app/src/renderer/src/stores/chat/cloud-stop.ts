import { tryChatStoreApi } from './store-ref';
import type { ChatState } from './state';
import type { ChatTab, CloudStopState } from './types';

/**
 * How long a cloud Stop the web core accepted waits for its turn to end
 * before Stop can be sent again for the same turn (CAN-6592). A cancel is
 * idempotent, so sending it again is safe.
 */
export const CLOUD_STOP_RETRY_AFTER_MS = 10_000;

/** A cloud chat's Stop as the composer shows it. */
export type PresentedCloudStop = 'stopping' | 'retryable' | 'not_stopped';

/**
 * The prompt of the turn a Stop is pressed for: the pending turn's, else the
 * newest user message's. A turn that starts later (a queued message, another
 * window's send) has another prompt, so an earlier Stop's state never
 * reaches it.
 */
export function cloudStopPromptId(tab: ChatTab): string | undefined {
  if (tab.pendingTurn) return tab.pendingTurn.userMessageId;
  for (let index = tab.messages.length - 1; index >= 0; index -= 1) {
    const message = tab.messages[index];
    if (message?.role === 'user') return message.id;
  }
  return undefined;
}

/**
 * A cloud chat's Stop as the composer shows it, for the turn it names:
 * `stopping` can't be sent again yet, `retryable` still reads Stopping… but
 * can.
 */
export function presentedCloudStop(
  tab: ChatTab | undefined,
): PresentedCloudStop | undefined {
  const stop = tab?.cloudStop;
  if (tab === undefined || stop === undefined) return undefined;
  if (stop.promptMessageId !== cloudStopPromptId(tab)) return undefined;
  if (stop.phase === 'not_stopped') return 'not_stopped';
  return stop.retryable ? 'retryable' : 'stopping';
}

/** One Stop attempt's re-enable timer (CAN-6592). */
interface PendingRetry {
  readonly worktreeKey: string;
  readonly chatId: string;
  /** The attempt the timer re-enables; a newer state replaces it. */
  readonly stop: CloudStopState;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Each attempt's timer, by chat, the turn's prompt and the attempt. */
const retries = new Map<string, PendingRetry>();
let unsubscribe: (() => void) | null = null;

const retryKey = (
  worktreeKey: string,
  chatId: string,
  stop: CloudStopState,
): string =>
  `${worktreeKey}\u0000${chatId}\u0000${stop.promptMessageId ?? ''}\u0000${stop.attempt ?? 1}`;

function tabOf(
  state: ChatState,
  worktreeKey: string,
  chatId: string,
): ChatTab | undefined {
  return state.worktreeChats[worktreeKey]?.tabs.find(
    (tab) => tab.id === chatId,
  );
}

/**
 * Whether the turn the Stop was pressed for has settled: its end is on the
 * tab, from its timer row (CAN-6560). Only that retires a retry. A starting
 * turn can read running in a snapshot and not running in a report or mid
 * handoff, which says nothing about its end (CAN-6592).
 */
function turnSettled(tab: ChatTab, stop: CloudStopState): boolean {
  return (
    stop.promptMessageId !== undefined &&
    tab.turnEnds?.[stop.promptMessageId] !== undefined
  );
}

function dropRetry(key: string): void {
  const retry = retries.get(key);
  if (retry === undefined) return;
  clearTimeout(retry.timer);
  retries.delete(key);
  if (retries.size === 0) {
    unsubscribe?.();
    unsubscribe = null;
  }
}

/**
 * Drops each re-enable whose turn settled, whose tab is gone, or whose Stop
 * a newer state replaced (a new send, a failed or settled stop). A retry
 * that fires on a turn that ended unseen marks a Stop the composer no longer
 * shows.
 */
function sweep(state: ChatState): void {
  for (const [key, retry] of [...retries]) {
    const tab = tabOf(state, retry.worktreeKey, retry.chatId);
    if (
      tab === undefined ||
      tab.cloudStop !== retry.stop ||
      turnSettled(tab, retry.stop)
    )
      dropRetry(key);
  }
}

/**
 * Re-enables a cloud Stop after {@link CLOUD_STOP_RETRY_AFTER_MS} while its
 * turn still hasn't ended. Owned by the store, not the button, so it holds
 * however the composer mounts.
 */
export function armCloudStopRetry(worktreeKey: string, chatId: string): void {
  const api = tryChatStoreApi();
  if (api === undefined) return;
  const tab = tabOf(api.getState(), worktreeKey, chatId);
  const stop = tab?.cloudStop;
  if (tab === undefined || stop === undefined || stop.phase !== 'stopping')
    return;
  const key = retryKey(worktreeKey, chatId, stop);
  dropRetry(key);
  const timer = setTimeout(() => {
    dropRetry(key);
    api.setState((state) => {
      const wc = state.worktreeChats[worktreeKey];
      if (wc === undefined) return state;
      let changed = false;
      const tabs = wc.tabs.map((entry) => {
        if (entry.id !== chatId || entry.cloudStop !== stop) return entry;
        changed = true;
        return { ...entry, cloudStop: { ...stop, retryable: true } };
      });
      if (!changed) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [worktreeKey]: { ...wc, tabs },
        },
      };
    });
  }, CLOUD_STOP_RETRY_AFTER_MS);
  retries.set(key, { worktreeKey, chatId, stop, timer });
  unsubscribe ??= api.subscribe(sweep);
}
