import type { NoticeIntent } from '../components/Notice';

/** How long a success toast stays up: long enough to read, then it leaves. */
export const SUCCESS_TOAST_LIFETIME_MS = 6_000;

/** How long an ordinary update stays up on every host. */
export const INFO_TOAST_LIFETIME_MS = 8_000;

/**
 * How long a toast that opens what it reports (a chat waiting on the user)
 * stays up, so a waiting question gets the same time on screen everywhere.
 */
export const OPEN_TARGET_TOAST_LIFETIME_MS = 15_000;

/**
 * How long a toast the user may need to come back to stays up (a share's
 * Copy link): long enough to switch windows and return for it.
 */
export const HELD_TOAST_LIFETIME_MS = 60_000;

/**
 * A toast's lifetime in the shared `ToastStack`, by what it reports. A
 * failure or a warning stays until it is closed or its condition clears
 * (`0`), so its `Try again` is never lost to a timer; a success leaves after
 * 6 s. `holdMs` is a longer lifetime a host gives a toast the user may need
 * to come back to (a share's Copy link); it never shortens a failure's or a
 * warning's stay. Everything else keeps the host's `defaultMs`.
 */
export function toastStackLifetimeMs(
  intent: NoticeIntent,
  defaultMs: number,
  holdMs?: number,
): number {
  if (intent === 'destructive' || intent === 'attention') return 0;
  if (holdMs !== undefined) return holdMs;
  if (intent === 'positive') return SUCCESS_TOAST_LIFETIME_MS;
  return defaultMs;
}
