// ---------------------------------------------------------------------------
// Daily anonymous "Usage analytics is off" ping (CAN-6069, part B).
//
// An install that turned Usage analytics off sends nothing to PostHog, so it
// sends this one ping instead: `{ reason, channel }` and nothing else, at most
// once per UTC date. The web stores only an aggregate count (part A, see
// `@canopy/protocol/usage-analytics-optout`).
//
// Every dependency is injected so the schedule can be tested with a fake
// clock and fake fetch. The host wiring (`./host`) supplies the real ones.
//
// Fail closed: a state we can't read is `unknown`, never "on" or "off". Unknown
// sends nothing and writes no marker; it is never guessed.
// ---------------------------------------------------------------------------

import {
  UsageAnalyticsOptOutPingSchema,
  type UsageAnalyticsOptOutPing,
} from '@canopy/protocol/usage-analytics-optout';
import type { UsageDataPolicy } from '../lib/usage-data-policy';

export type OptOutReason = UsageAnalyticsOptOutPing['reason'];
export type OptOutChannel = UsageAnalyticsOptOutPing['channel'];

/** Why the state can't be read. Each is its own cause; none maps to a ping. */
export type OptOutUnknownCause =
  | 'preferences-unreadable'
  | 'context-unknown'
  | 'org-policy-unreadable'
  | 'denial-journal-unreadable'
  | 'preferences-unconfirmed'
  | 'attribution-unknown';

/**
 * Why the ping stays silent although analytics is off. Unlike `unknown` this
 * is a known answer: nothing is re-checked until the next UTC day or a policy
 * change (consent recorded, or the flag cleared by turning analytics on).
 */
export type OptOutSuppressedCause =
  | 'consent-pending'
  | 'declined-at-onboarding';

export type OptOutState =
  | { kind: 'on' }
  | { kind: 'off'; reason: OptOutReason }
  | { kind: 'suppressed'; cause: OptOutSuppressedCause }
  | { kind: 'unknown'; cause: OptOutUnknownCause };

/**
 * The last UTC date a ping got a 2xx. `unreadable` is not `missing`: its
 * `lastWrittenUtcDate` is the UTC date the file was last replaced (its
 * modification time), or null when even that can't be read. The marker is
 * only ever replaced after a 2xx, so a file last replaced before today proves
 * that no ping was recorded today, whatever its bytes say.
 */
export type MarkerRead =
  | { kind: 'missing' }
  | { kind: 'present'; utcDate: string }
  | { kind: 'unreadable'; lastWrittenUtcDate: string | null };

export interface OptOutMarkerStore {
  read(): Promise<MarkerRead>;
  write(utcDate: string): Promise<void>;
}

export type OptOutFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: { 'Content-Type': 'application/json' };
    body: string;
    credentials: 'omit';
    redirect: 'error';
    signal: AbortSignal;
  },
) => Promise<{ status: number }>;

export interface UsageAnalyticsOptOutPingOptions {
  /** Release flavor of this build; null for a development build. */
  channel: OptOutChannel | null;
  /** Electron `app.isPackaged`: a development run never pings. */
  isPackaged: boolean;
  /** `allowsAutomaticCall(...)`: false in a local-only build. */
  allowsAutomaticCall: boolean;
  policy: Pick<
    UsageDataPolicy,
    | 'getUsageDataPolicySnapshot'
    | 'hasWorkspaceContext'
    | 'isOrganizationPolicyUnreadable'
    | 'isConsentPending'
    | 'wasAnalyticsDeclinedAtOnboarding'
    | 'subscribe'
    | 'whenSettled'
  >;
  /**
   * The member's stored Usage analytics choice as read from disk right now,
   * journal denials included, from one read that also reports the journal's
   * state: `denied` or `allowed`; `denial-journal-unreadable` while the
   * write-ahead revocation journal can't be read (every key then reads as
   * denied, which is not a choice); `unconfirmed` when no saved choice can be
   * proven (a failed or latched preferences recovery, an unreadable file, a
   * saved value that isn't a boolean). The live policy can lag or lead this,
   * so a ping needs both to agree.
   */
  readStoredProductAnalytics: () => Promise<
    'allowed' | 'denied' | 'unconfirmed' | 'denial-journal-unreadable'
  >;
  /**
   * True once the app is quitting. Read before every step and right before a
   * request: from then on nothing new starts, and a sender not yet started
   * never starts.
   */
  isQuitting?: () => boolean;
  markerStore: OptOutMarkerStore;
  /** The full endpoint URL; throws while the cloud base URL isn't usable. */
  resolveEndpointUrl: () => string;
  fetch: OptOutFetch;
  now?: () => number;
  random?: () => number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Every send waits at least this long after launch or a day change. */
export const OPT_OUT_PING_MIN_DELAY_MS = 30_000;
/** Jitter added to every wait, so launch times don't line up. */
export const OPT_OUT_PING_JITTER_MS = 5 * 60_000;
/** How soon an unknown state is read again. */
export const OPT_OUT_PING_UNKNOWN_RECHECK_MS = 10 * 60_000;
/** Waits before each retry of a failed send; never more than these per day. */
export const OPT_OUT_PING_RETRY_DELAYS_MS = [
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
] as const;
export const OPT_OUT_PING_REQUEST_TIMEOUT_MS = 30_000;
/** Times a send re-runs its checks because the UTC date changed under them. */
const SEND_DATE_CHECK_PASSES = 3;

export function utcDateOf(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in `YYYY-MM-DD` form, otherwise false. */
export function isUtcDate(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_DATE_PATTERN.test(value)) return false;
  // `2026-13-45` parses to NaN, which `toISOString` would throw on.
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && utcDateOf(parsed) === value;
}

function startOfUtcDay(timestampMs: number): number {
  return Date.parse(`${utcDateOf(timestampMs)}T00:00:00.000Z`);
}

type PolicyReader = UsageAnalyticsOptOutPingOptions['policy'];

/**
 * The policy part of the state, read synchronously so the answer can't change
 * while it is being used. The denial journal is checked separately.
 */
export function readPolicyOptOutState(policy: PolicyReader): OptOutState {
  const snapshot = policy.getUsageDataPolicySnapshot();
  const prohibition = snapshot.prohibitedBy.productAnalytics;
  if (prohibition?.preferencesUnreadable === true) {
    return { kind: 'unknown', cause: 'preferences-unreadable' };
  }
  // Nothing sends before the first-run legal consent, this ping included.
  if (policy.isConsentPending()) {
    return { kind: 'suppressed', cause: 'consent-pending' };
  }
  // Declining Usage analytics on the Welcome gate is never counted as an
  // opt-out, whatever else is true (an organization prohibition included).
  if (policy.wasAnalyticsDeclinedAtOnboarding()) {
    return { kind: 'suppressed', cause: 'declined-at-onboarding' };
  }
  // Before the selected context is known the org part is a conservative guess.
  if (!policy.hasWorkspaceContext()) {
    return { kind: 'unknown', cause: 'context-unknown' };
  }
  // Off for an organization that can't be told apart from a real prohibition.
  if (policy.isOrganizationPolicyUnreadable()) {
    return { kind: 'unknown', cause: 'org-policy-unreadable' };
  }
  if (snapshot.effective.productAnalytics) return { kind: 'on' };
  if (!snapshot.preferences.productAnalytics) {
    return { kind: 'off', reason: 'personal' };
  }
  if (prohibition !== undefined) return { kind: 'off', reason: 'org' };
  // Off, yet neither a stored choice nor an organization explains it.
  return { kind: 'unknown', cause: 'attribution-unknown' };
}

/**
 * The full state. `off` is only ever returned once the live policy and the
 * stored choice agree: the policy snapshot alone can be stale (a recovery that
 * latched after startup never reaches it) or fail-closed (an unreadable denial
 * journal denies every flow, which looks like a personal opt-out). Order: the
 * live policy first (synchronous), then one disk read that reports the stored
 * choice and the journal state together, then the live policy once more. A
 * save in flight can make the policy differ from disk for a moment; that
 * reads as unknown and is retried.
 */
async function readOptOutState(
  options: UsageAnalyticsOptOutPingOptions,
): Promise<OptOutState> {
  const first = readPolicyOptOutState(options.policy);
  if (first.kind !== 'off') return first;
  // A failed read can't prove a choice.
  const stored = await Promise.resolve()
    .then(() => options.readStoredProductAnalytics())
    .catch((): 'unconfirmed' => 'unconfirmed');
  // An unreadable journal overlays a denial on every key: not a choice.
  if (stored === 'denial-journal-unreadable') {
    return { kind: 'unknown', cause: 'denial-journal-unreadable' };
  }
  // The policy may have changed while the disk was read.
  const second = readPolicyOptOutState(options.policy);
  if (second.kind !== 'off') return second;
  // `personal` needs a stored denial, `org` a stored allow plus a prohibition;
  // `unconfirmed` matches neither.
  const expected = second.reason === 'personal' ? 'denied' : 'allowed';
  if (stored !== expected) {
    return { kind: 'unknown', cause: 'preferences-unconfirmed' };
  }
  return second;
}

export interface UsageAnalyticsOptOutPingHandle {
  /**
   * Stop scheduling. The returned promise settles once any step already in
   * flight has finished, including the marker write after a 2xx, so a quit can
   * wait for it. It never rejects. Scheduling has already stopped by then if
   * `isQuitting` turned true first.
   */
  stop(): Promise<void>;
}

/**
 * Start the daily ping. Returns a handle that stops every timer and the
 * policy subscription; a no-op handle when this build must never ping.
 */
export function startUsageAnalyticsOptOutPing(
  options: UsageAnalyticsOptOutPingOptions,
): UsageAnalyticsOptOutPingHandle {
  const { channel } = options;
  // Dev builds and local-only builds send nothing; neither does a build
  // without a release channel or one that is already quitting.
  if (
    channel === null ||
    !options.isPackaged ||
    !options.allowsAutomaticCall ||
    options.isQuitting?.() === true
  ) {
    return { stop: (): Promise<void> => Promise.resolve() };
  }
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // `idle` waits for a day change or a policy change, `pending-send` holds a
  // scheduled send, `busy` is a send or evaluation in flight.
  let mode: 'idle' | 'pending-send' | 'busy' = 'busy';
  let failedSends = 0;
  let failedUtcDate: string | null = null;
  // A policy change that arrived while a cycle was reading the state.
  let changedWhileBusy = false;
  // Guards a repeat in this process when the marker write failed after a 2xx.
  let sentUtcDate: string | null = null;
  // Bumped on every reschedule so a stale async continuation does nothing.
  let generation = 0;
  // Steps running now, so `stop()` can wait for a request and its marker write.
  const inFlight = new Set<Promise<void>>();

  const jitter = (): number =>
    OPT_OUT_PING_MIN_DELAY_MS + random() * OPT_OUT_PING_JITTER_MS;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  /**
   * Checked before every step and right before a request goes out. A quit
   * halts the sender the moment it begins (the host sets its flag before any
   * quit await), so no timer, policy change or step in flight starts a new
   * request after that; `stop()` only waits for one already sent.
   */
  const halted = (): boolean => {
    if (stopped) return true;
    if (options.isQuitting?.() !== true) return false;
    halt();
    return true;
  };

  /**
   * Run one step. A step never rejects by design; if one does anyway, the
   * schedule restarts after the unknown-state wait instead of sticking in
   * `busy` with an unhandled rejection.
   */
  const run = (step: () => Promise<void>): void => {
    const tracked: Promise<void> = step()
      .catch((): void => {
        if (halted()) return;
        wait(OPT_OUT_PING_UNKNOWN_RECHECK_MS + jitter(), 'cycle', ++generation);
      })
      .finally((): void => {
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  };

  const wait = (
    delayMs: number,
    next: 'cycle' | 'send',
    expected: number,
  ): void => {
    clearTimer();
    mode = next === 'send' ? 'pending-send' : 'idle';
    timer = setTimeout((): void => {
      timer = null;
      if (halted() || generation !== expected) return;
      run(next === 'send' ? (): Promise<void> => send(expected) : cycle);
    }, delayMs);
    timer.unref?.();
  };

  const waitForNextUtcDay = (expected: number): void => {
    const nextMidnight = startOfUtcDay(now()) + DAY_MS;
    wait(Math.max(nextMidnight - now(), 0) + jitter(), 'cycle', expected);
  };

  /** A marker store that fails outright is an unreadable marker. */
  const readMarker = (): Promise<MarkerRead> =>
    Promise.resolve()
      .then(() => options.markerStore.read())
      .catch(
        (): MarkerRead => ({ kind: 'unreadable', lastWrittenUtcDate: null }),
      );

  /** After a 2xx: write the marker, retried once for a transient failure. */
  const writeMarker = async (utcDate: string): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await options.markerStore.write(utcDate);
        return;
      } catch {
        // Tried again once. When both fail, the in-memory date stops a
        // repeat in this process; a relaunch the same UTC day may count it
        // twice (a documented limit).
      }
    }
  };

  const alreadySent = (marker: MarkerRead, today: string): boolean | null => {
    if (sentUtcDate === today) return true;
    switch (marker.kind) {
      case 'missing':
        return false;
      case 'unreadable':
        // Replaced before today: no ping was recorded today, so today's ping
        // may go and its marker replaces the damaged file. Replaced today,
        // or no date at all: unknown for today.
        return marker.lastWrittenUtcDate !== null &&
          marker.lastWrittenUtcDate < today
          ? false
          : null;
      case 'present':
        // A date after today (clock set back) doesn't suppress today's ping.
        return marker.utcDate === today;
    }
  };

  /** Decide what the next step is from the marker and the opt-out state. */
  async function cycle(): Promise<void> {
    if (halted()) return;
    const expected = ++generation;
    mode = 'busy';
    changedWhileBusy = false;
    clearTimer();
    // The marker read can finish after midnight: its answer is for the date
    // it started under, so the date it is used for is read again afterwards.
    let today = '';
    let sent: boolean | null = null;
    for (let pass = 0; ; pass++) {
      if (pass >= SEND_DATE_CHECK_PASSES) {
        // Midnight kept moving under the reads: look again shortly.
        wait(OPT_OUT_PING_UNKNOWN_RECHECK_MS + jitter(), 'cycle', expected);
        return;
      }
      today = utcDateOf(now());
      if (failedUtcDate !== today) failedSends = 0;
      sent = alreadySent(await readMarker(), today);
      if (halted() || generation !== expected) return;
      if (utcDateOf(now()) === today) break;
    }
    // Unknown marker: send nothing today, try again after the day changes.
    // So does a day whose sends all failed.
    if (sent !== false || failedSends > OPT_OUT_PING_RETRY_DELAYS_MS.length) {
      waitForNextUtcDay(expected);
      return;
    }
    const state = await readOptOutState(options);
    if (halted() || generation !== expected) return;
    if (state.kind !== 'off' && changedWhileBusy) {
      run(cycle);
      return;
    }
    if (state.kind === 'unknown') {
      wait(OPT_OUT_PING_UNKNOWN_RECHECK_MS + jitter(), 'cycle', expected);
      return;
    }
    // On or suppressed: send nothing and write no marker. A policy change
    // wakes this, otherwise the next day does.
    if (state.kind === 'on' || state.kind === 'suppressed') {
      waitForNextUtcDay(expected);
      return;
    }
    // A random time of the UTC day; later in the day, a short wait.
    const target = startOfUtcDay(now()) + random() * DAY_MS;
    wait(Math.max(target - now(), 0) + jitter(), 'send', expected);
  }

  /**
   * The scheduled send: every check runs again at send time. The date the
   * checks ran for must still be the date at dispatch, so the request and its
   * marker carry the same UTC date; if midnight passed meanwhile, the checks
   * run again for the new date (marker, policy, journal, retry budget).
   */
  async function send(expected: number): Promise<void> {
    mode = 'busy';
    let today = '';
    let state: OptOutState = { kind: 'unknown', cause: 'attribution-unknown' };
    for (let pass = 0; ; pass++) {
      if (pass >= SEND_DATE_CHECK_PASSES) {
        // Midnight kept moving under the checks: start over from the cycle.
        run(cycle);
        return;
      }
      today = utcDateOf(now());
      if (failedUtcDate !== today) failedSends = 0;
      const sent = alreadySent(await readMarker(), today);
      if (halted() || generation !== expected) return;
      if (sent !== false) {
        run(cycle);
        return;
      }
      state = await readOptOutState(options);
      if (halted() || generation !== expected) return;
      if (state.kind !== 'off') {
        run(cycle);
        return;
      }
      if (utcDateOf(now()) === today) break;
    }

    let ok = false;
    try {
      const body = UsageAnalyticsOptOutPingSchema.parse({
        reason: state.reason,
        channel,
      });
      const response = await options.fetch(options.resolveEndpointUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        // A redirect rejects instead of being followed: fetch would turn a
        // 301/302 POST into a body-less GET and report only the final 2xx.
        redirect: 'error',
        // Bounded, so a hung request can't hold the retry schedule.
        signal: AbortSignal.timeout(OPT_OUT_PING_REQUEST_TIMEOUT_MS),
      });
      ok = response.status >= 200 && response.status < 300;
    } catch {
      // A failed request is retried; nothing identifying is logged.
      ok = false;
    }
    if (ok) {
      // The web counted this day: record it even when the app is quitting,
      // so a relaunch the same UTC day doesn't count it again.
      sentUtcDate = today;
      await writeMarker(today);
      if (halted() || generation !== expected) return;
      run(cycle);
      return;
    }
    if (halted() || generation !== expected) return;
    const delay = OPT_OUT_PING_RETRY_DELAYS_MS[failedSends];
    failedSends += 1;
    failedUtcDate = today;
    // The request ran into a new UTC day: that day is not used up by this
    // failure, so it starts a fresh cycle (marker, eligibility, retry budget).
    if (utcDateOf(now()) !== today) {
      run(cycle);
      return;
    }
    if (delay === undefined) {
      waitForNextUtcDay(expected);
    } else {
      wait(delay + jitter(), 'send', expected);
    }
  }

  const unsubscribe = options.policy.subscribe((): void => {
    if (halted()) return;
    if (mode === 'busy') {
      changedWhileBusy = true;
      return;
    }
    if (mode === 'idle') {
      run(cycle);
      return;
    }
    // A pending send stays scheduled only while analytics is still off.
    if (readPolicyOptOutState(options.policy).kind !== 'off') run(cycle);
  });

  function halt(): void {
    stopped = true;
    generation += 1;
    clearTimer();
    unsubscribe();
  }

  // The selected context decides personal versus org: wait for it first. A
  // settle that fails still starts the schedule; the state check itself
  // reports an unknown context. A quit that began during the wait halts it.
  const start = (): void => {
    if (!halted()) run(cycle);
  };
  Promise.resolve()
    .then(() => options.policy.whenSettled())
    .then(start, start);

  return {
    stop(): Promise<void> {
      halt();
      return Promise.allSettled([...inFlight]).then((): void => undefined);
    },
  };
}
