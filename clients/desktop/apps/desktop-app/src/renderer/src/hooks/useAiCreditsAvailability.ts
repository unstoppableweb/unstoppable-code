import { useEffect, useState } from 'react';
import type {
  AiCreditsScopeRequest,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  aiCreditsScopeKey,
  readNavigationScopeKey,
  useStableAiCreditsScope,
} from '@/lib/aiCreditsScope';

/**
 * Whether the connected cloud account can pay for gateway-routed sessions right
 * now, via the native Canopy billing signal (CAN-1235).
 */
export interface AiCreditsAvailability {
  workOwner?: WorkOwner;
  /**
   * The last answer has expired or been invalidated and a new read is pending.
   * Existing optimistic selection may keep using it; readiness cues may not.
   */
  stale?: boolean;
  /**
   * True when the account can keep working through the gateway right now: a
   * spendable personal balance (source-agnostic — native Canopy wallet OR an
   * already-linked UD account with credits) OR an org with spendable headroom.
   */
  eligible: boolean;
  /** True until the first `loadNativeAiCreditsAvailability()` read resolves. */
  loading: boolean;
  /**
   * The settled read could not be completed, so `eligible: false` is a DEFAULT
   * rather than an observation (`NativeAiCreditsAvailability.inconclusive`).
   *
   * Consumers that make an assertion from a negative — the lane resolver's
   * `creditsEligible` tri-state above all — must map this to UNKNOWN, not to a
   * confirmed "cannot pay". Without it a single transient cloud error pinned
   * the credits lane unavailable for the rest of the session. Consumers that
   * only offer a CTA can keep ignoring it.
   */
  inconclusive: boolean;
}

interface CachedAvailability {
  workOwner?: WorkOwner;
  eligible: boolean;
  inconclusive: boolean;
}

/**
 * Per-scope cache entry. The owner of the work decides which organization pool
 * can pay (CAN-3463), so a chat owned by one org and a Personal chat are
 * different questions with different answers and never share a cached value.
 */
interface ScopeEntry {
  cache: CachedAvailability | null;
  cacheTimestamp: number;
  pending: Promise<CachedAvailability> | null;
  /** How many consecutive reads for this scope came back inconclusive. */
  consecutiveInconclusiveReads: number;
}

/**
 * Module-level cache + in-flight dedupe, keyed by owner scope and mirroring the
 * auth-status hooks (`useClaudeAuthStatus` / `useCodexAuthStatus`). A single
 * credits read per scope is shared across every component that calls the hook,
 * so mounting the model picker on multiple surfaces does not fan out redundant
 * IPC calls.
 */
const entries = new Map<string, ScopeEntry>();
let requestVersion = 0;
/** The in-flight read started by {@link readAiCreditsAvailabilityFresh}. */
let freshPending: Promise<CachedAvailability> | null = null;

function entryFor(key: string): ScopeEntry {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      cache: null,
      cacheTimestamp: 0,
      pending: null,
      consecutiveInconclusiveReads: 0,
    };
    entries.set(key, entry);
  }
  return entry;
}

/**
 * Mounted hook consumers that want to re-read when the cache is invalidated.
 * Without this, invalidation would only take effect on the next mount, so a
 * continuously-mounted consumer (e.g. a persistent status indicator) would show
 * stale eligibility until the TTL lapses.
 */
const subscribers = new Set<() => void>();

/**
 * Time-to-live for the cached eligibility. Explicit invalidation
 * (`invalidateAiCreditsAvailabilityCache`) covers the known credit-changing
 * flows; this TTL is defense-in-depth so a stale value can never outlive the
 * session if some future flow forgets to invalidate.
 */
const CACHE_TTL_MS = 60_000;

/**
 * Retry window for an INCONCLUSIVE read (a rejected IPC call, or a payload the
 * loader marked `inconclusive`).
 *
 * A failed read is not a fact, so it must not be held for the full TTL: doing
 * that let one transient cloud error keep the credits lane UNKNOWN — and every
 * consumer of that lane in a holding pattern — for a whole minute at a time.
 * Mounted consumers re-read on this shorter cadence until the read settles.
 */
const INCONCLUSIVE_RETRY_MS = 10_000;

/**
 * Backoff multipliers applied to consecutive inconclusive reads: 10s, 30s, then
 * 60s (= {@link CACHE_TTL_MS}) forever.
 *
 * A fixed 10s retry never backed off and never capped, so an offline but
 * signed-in user generated a permanent poll for the whole session — one balance
 * call plus one organization probe, every ten seconds. Backing off keeps the
 * fast recovery for a genuinely transient blip while a sustained outage settles
 * onto the same cadence as an ordinary cache expiry.
 */
const INCONCLUSIVE_RETRY_BACKOFF_MS = [
  INCONCLUSIVE_RETRY_MS,
  30_000,
  CACHE_TTL_MS,
] as const;

function inconclusiveRetryDelayMs(entry: ScopeEntry): number {
  const index = Math.min(
    Math.max(entry.consecutiveInconclusiveReads - 1, 0),
    INCONCLUSIVE_RETRY_BACKOFF_MS.length - 1,
  );
  return INCONCLUSIVE_RETRY_BACKOFF_MS[index] ?? CACHE_TTL_MS;
}

function recordReadOutcome(entry: ScopeEntry, inconclusive: boolean): void {
  entry.consecutiveInconclusiveReads = inconclusive
    ? entry.consecutiveInconclusiveReads + 1
    : 0;
}

/** True when the scope's cache holds a fresh value that can be reused. */
function isCacheFresh(entry: ScopeEntry | undefined): boolean {
  if (!entry || entry.cache === null) return false;
  const ttl = entry.cache.inconclusive
    ? inconclusiveRetryDelayMs(entry)
    : CACHE_TTL_MS;
  return Date.now() - entry.cacheTimestamp < ttl;
}

/**
 * Drop the cached eligibility and re-read AI Credits. Call after a flow that can
 * change credit balance or cloud connection state (e.g. connecting or
 * disconnecting a cloud account or spending credits). Mounted hook consumers
 * re-fetch immediately; unmounted ones re-read on their next mount.
 */
export function invalidateAiCreditsAvailabilityCache(): void {
  requestVersion += 1;
  // An explicit invalidation is a credit-changing event, not a retry: dropping
  // every entry gives the next read the full fast cadence again rather than an
  // inherited backoff. Every scope is dropped because a top-up or an account
  // change can move any owner's answer.
  entries.clear();
  subscribers.forEach((notify) => notify());
}

// Drop the cache whenever the cloud account connection changes (connect,
// disconnect, or API-key change all dispatch this event). Registered once at
// module load so eligibility re-reads no matter which surface mounts the hook,
// and so future connection flows are covered without touching each handler.
// Credit exhaustion mid-session is invalidated separately from the usage-limit
// chat event in `useChatEventSubscriptions`.
if (typeof window !== 'undefined') {
  window.addEventListener(
    CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
    invalidateAiCreditsAvailabilityCache,
  );
}

/**
 * Compute gateway eligibility using the same native formula as
 * `AiCreditsUsageLimitBanner`: a spendable personal balance (native OR
 * already-linked UD) OR an org with spendable headroom. Never surfaces UD
 * linking.
 */
function computeEligible(availability: NativeAiCreditsAvailability): boolean {
  return availability.personalEligible || availability.orgSpendable;
}

function ensurePendingRead(
  key: string,
  scope?: AiCreditsScopeRequest,
): Promise<CachedAvailability> {
  const entry = entryFor(key);
  if (!entry.pending) {
    const activeRequestVersion = requestVersion;
    const settle = (result: CachedAvailability): CachedAvailability => {
      // An invalidation replaced the whole map; this answer describes a
      // superseded state and must not repopulate it.
      if (
        activeRequestVersion === requestVersion &&
        entries.get(key) === entry
      ) {
        entry.cache = result;
        entry.cacheTimestamp = Date.now();
        recordReadOutcome(entry, result.inconclusive);
      }
      return result;
    };
    const promise = window.api
      .loadNativeAiCreditsAvailability(scope)
      .then(
        (native): CachedAvailability =>
          settle({
            eligible: computeEligible(native),
            inconclusive: native.inconclusive === true,
            ...(native.workOwner ? { workOwner: native.workOwner } : {}),
          }),
      )
      // A rejected read is the same class of non-answer the loader reports
      // with `inconclusive`, so it is recorded as one rather than as a
      // confirmed "no credits".
      .catch(
        (): CachedAvailability =>
          settle({ eligible: false, inconclusive: true }),
      )
      .finally(() => {
        if (entry.pending === promise) {
          entry.pending = null;
        }
      });
    entry.pending = promise;
  }
  return entry.pending;
}
function toAvailability(
  value: CachedAvailability | null,
): AiCreditsAvailability {
  return {
    eligible: value?.eligible ?? false,
    loading: value === null,
    inconclusive: value?.inconclusive ?? false,
    ...(value?.workOwner ? { workOwner: value.workOwner } : {}),
  };
}
export function readAiCreditsAvailabilityFresh(): Promise<AiCreditsAvailability> {
  const key = aiCreditsScopeKey(undefined, readNavigationScopeKey());
  if (freshPending !== null && entryFor(key).pending === freshPending)
    return freshPending.then(toAvailability);
  invalidateAiCreditsAvailabilityCache();
  const promise = ensurePendingRead(key);
  freshPending = promise;
  return promise.then(toAvailability);
}

/**
 * The held answer when it is already this one, so re-reading a cached value on
 * mount does not render the consumer again.
 */
function keepSameAvailability(
  previous: { key: string; value: CachedAvailability } | null,
  key: string,
  value: CachedAvailability,
): { key: string; value: CachedAvailability } {
  return previous?.key === key && previous.value === value
    ? previous
    : { key, value };
}

export function useAiCreditsAvailability(
  scope?: AiCreditsScopeRequest,
): AiCreditsAvailability {
  const { scope: stableScope, key } = useStableAiCreditsScope(scope);
  const [availability, setAvailability] = useState<{
    key: string;
    value: CachedAvailability;
  } | null>(() => {
    const entry = entries.get(key);
    return entry?.cache && isCacheFresh(entry)
      ? { key, value: entry.cache }
      : null;
  });
  // Bumped by `invalidateAiCreditsAvailabilityCache` so the fetch effect below
  // re-runs while this consumer is mounted, not just on the next mount.
  const [refreshSignal, setRefreshSignal] = useState(0);

  useEffect(() => {
    const notify = (): void => setRefreshSignal((n) => n + 1);
    subscribers.add(notify);
    return (): void => {
      subscribers.delete(notify);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const entry = entryFor(key);
    if (entry.cache && isCacheFresh(entry)) {
      const fresh = entry.cache;
      setAvailability((previous) => keepSameAvailability(previous, key, fresh));
      return (): void => {
        cancelled = true;
      };
    }
    // Stale (past TTL) or never populated — force a fresh read.
    entry.cache = null;
    void ensurePendingRead(key, stableScope).then((value) => {
      if (!cancelled) {
        setAvailability((previous) =>
          keepSameAvailability(previous, key, value),
        );
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, [key, stableScope, refreshSignal]);

  // Only a value read for the CURRENT scope is shown; a key change reads as
  // loading until its own answer lands.
  const current = availability?.key === key ? availability.value : null;
  const entry = entries.get(key);
  const stale =
    current !== null && (entry?.cache !== current || !isCacheFresh(entry));

  // A continuously open picker must not assert readiness from an expired
  // balance forever. Share the ordinary scoped read and its existing dedupe;
  // leave the previous selection signal intact while that read is pending.
  useEffect(() => {
    if (current === null || current.inconclusive) return undefined;
    const cached = entries.get(key);
    if (!cached) return undefined;
    const timer = setTimeout(
      () => setRefreshSignal((n) => n + 1),
      Math.max(0, cached.cacheTimestamp + CACHE_TTL_MS - Date.now()),
    );
    return (): void => clearTimeout(timer);
  }, [current, key, stale]);

  // Recovery read for an inconclusive result. Without it the value only
  // refreshes on the next mount or explicit invalidation, so a consumer that
  // stays mounted (the composer, the lane runtime sync) would hold UNKNOWN for
  // the rest of the session after one transient failure.
  useEffect(() => {
    if (current?.inconclusive !== true) return undefined;
    const entry = entryFor(key);
    const timer = setTimeout(() => {
      // Drop the inconclusive entry explicitly. Relying on the TTL alone races
      // the timer: a cache that still reads fresh by a millisecond re-sets the
      // SAME object, React bails out of the render, and the retry effect never
      // re-arms — leaving the value stuck for the session.
      if (entry.cache?.inconclusive === true) {
        entry.cache = null;
        entry.cacheTimestamp = 0;
      }
      setRefreshSignal((n) => n + 1);
    }, inconclusiveRetryDelayMs(entry));
    return (): void => clearTimeout(timer);
  }, [current, key]);

  return { ...toAvailability(current), stale };
}
