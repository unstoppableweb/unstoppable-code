import { useEffect, useState } from 'react';

/**
 * The pairing countdown (CAN-5985 A2). A deliberate deviation from
 * numbers-and-time's absolute expiry time: the window lasts ten minutes and
 * the user acts inside it, so a ticking `m:ss` answers "how long do I have"
 * better than a clock time. "Expires in" keeps it from reading as a time of
 * day.
 */
export function expiresInLabel(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `Expires in ${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** The opening state's stand-in countdown: a full window, for the skeleton. */
export const SAMPLE_REMAINING_MS = 10 * 60_000;

/** Keeps a tick from landing just before the boundary it aims at. */
const TICK_MARGIN_MS = 5;

/** Milliseconds until the `m:ss` label next changes. */
function msUntilNextSecond(remainingMs: number): number {
  return (remainingMs % 1000 || 1000) + TICK_MARGIN_MS;
}

/**
 * Milliseconds left until `expiresAt`; null when there is none or it does not
 * parse. It re-renders just past each displayed-second boundary, so every
 * `m:ss` value shows for a full second, and stops scheduling at zero. Each
 * tick reads `Date.now()` again, so a throttled window, a wake from sleep or
 * a clock change corrects itself on the next tick.
 */
export function useRemainingMs(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return undefined;
    const end = Date.parse(expiresAt);
    if (Number.isNaN(end)) return undefined;
    let timer: number | undefined;
    const tick = (): void => {
      const current = Date.now();
      setNow(current);
      const remaining = end - current;
      if (remaining <= 0) return; // expired: stop scheduling
      timer = window.setTimeout(tick, msUntilNextSecond(remaining));
    };
    // Synchronous first tick: after a renew, `now` would otherwise be up to
    // a second stale against the new `expiresAt`.
    tick();
    return (): void => window.clearTimeout(timer);
  }, [expiresAt]);
  if (expiresAt === null) return null;
  const end = Date.parse(expiresAt);
  return Number.isNaN(end) ? null : end - now;
}
