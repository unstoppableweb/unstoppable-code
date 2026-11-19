import {
  CodexSpeedUnsupportedError,
  type CodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  CODEX_SPEED_CATALOG_TTL_MS,
  CODEX_SPEED_DENIAL_TTL_MS,
  deriveCodexSpeedAvailability,
  describeCodexSpeedAvailability,
  isDefinitiveCodexSpeedRejection,
  parseCodexSpeedCatalogModel,
  readCodexWireContextWindow,
  type CodexSpeedAvailability,
  type CodexSpeedRejectionKind,
  type CodexSpeedRouteFacts,
  type CodexSpeedRouteProfile,
} from '@canopy/execution-engine/lib/codex-speed-availability';
import type {
  CodexSpeedCatalog,
  CodexSpeedCatalogModel,
  CodexSpeedCatalogRoute,
  CodexSpeedRouteCatalog,
} from '@canopy/execution-engine/types/codex-speed-capabilities';
import {
  getCodexRuntimeService,
  onCodexRuntimeServiceReplaced,
} from '../codex/runtime-service';
import {
  fetchMockControlPlaneRecord,
  getMockLlmOrigin,
} from '../lib/e2e-mock-control-plane';
import { logMainProcessInfo } from '../lib/main-process-logging';
import { isRecord } from '../lib/type-guards';
import { allowsAutomaticCall } from '../local-only/policy';

/**
 * Models the signed-in Codex account can run natively, and the service tiers
 * (speeds) each one advertises.
 *
 * The package catalog lists every Codex model Canopy supports, but a given
 * sign-in may only run some of them: a ChatGPT account rejects models an API
 * key can use (`gpt-5.3-codex-spark`, …). The app-server's
 * `model/list` is the account's own answer, so Auto uses it to keep the
 * provider-subscription lane to models that will actually run. Everything
 * else is reachable only through AI Credits.
 *
 * The same single fetch/cache also feeds the sanitized Codex speed catalog
 * (`window.api.codexSpeed`). It is scoped to the native canonical Codex
 * sign-in through the shared runtime's admin profile; account identity never
 * leaves this module. There is no global poller: while at least one speed
 * surface is active, one shared timer revalidates at cache expiry (positive
 * and negative results alike) so a same-account rollout is picked up without
 * an account event. That refresh may reacquire a suspended pooled worker; with
 * no active surfaces nothing refreshes in the background.
 *
 * The account proxy route has a second list: the proxy's own Codex catalog,
 * read through a registered {@link CodexSpeedRouteCatalogSource}. Codex still
 * filters every request's tier through the runtime catalog above (one models
 * manager per process, whatever the thread's provider), so a proxied turn
 * needs both. The proxy list is read only once something asks for that route,
 * then kept with the same TTL, backoff, and expiry refresh.
 */

const CACHE_TTL_MS = CODEX_SPEED_CATALOG_TTL_MS;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_PAGES = 10;
/** Bounded failure backoff for active surfaces, then the normal TTL cadence. */
const RETRY_DELAYS_MS = [10_000, 30_000, 90_000];
const CATALOG_FAILURE_MESSAGE =
  "Couldn't check Codex speed availability. Try again.";
const EMPTY_CATALOG_MESSAGE =
  "Codex didn't report any models for this sign-in.";
const ROUTE_FAILURE_MESSAGE =
  "Couldn't check Ultra fast on the account proxy. Try again.";
const ROUTE_EMPTY_MESSAGE = "The account proxy didn't report any Codex models.";

interface CatalogEntry {
  generation: number;
  fetchedAt: number;
  expiresAt: number;
  truncated: boolean;
  models: CodexSpeedCatalogModel[];
  /** `null` when the list was empty: that says nothing usable to Auto. */
  ids: ReadonlySet<string> | null;
  /**
   * The ids of NON-HIDDEN entries only, for default-model eligibility
   * (CAN-4716). `null` when no visible entry was listed, which callers treat
   * as unknown. Auto keeps {@link ids}, hidden models included.
   */
  eligibleIds: ReadonlySet<string> | null;
}

interface CatalogFailure {
  generation: number;
  attempts: number;
  retryAt: number;
}

interface FetchResult {
  models: CodexSpeedCatalogModel[];
  ids: Set<string>;
  eligibleIds: Set<string>;
  truncated: boolean;
}

let generation = 0;
let entry: CatalogEntry | null = null;
/** Last successful fetch in the current generation; keeps broadcasts ordered. */
let lastFetchedAt: number | null = null;
let failure: CatalogFailure | null = null;
let inFlight: { generation: number; promise: Promise<void> } | null = null;
/** Keyed by {@link denialKey}: denials are kept per route. */
const denials = new Map<
  string,
  { model: string; route?: 'account-proxy'; expiresAt: number }
>();
const consumers = new Set<string>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(catalog: CodexSpeedCatalog) => void>();
let lastBroadcastKey: string | null = null;
let unsubscribeAccountUpdates: (() => void) | null = null;
let unsubscribeRuntimeReplacement: (() => void) | null = null;

/** One read of a route's own Codex catalog. */
export interface CodexSpeedRouteCatalogFetch {
  models: CodexSpeedCatalogModel[];
  truncated: boolean;
}

/**
 * Where a route's own catalog comes from. `key` names whose list it would be
 * (connection, routing, and runtime state) without any I/O; a cached list
 * read under another key is never used. `fetch` resolves null when the route
 * would not take Codex work, and rejects when the list cannot be read.
 */
export interface CodexSpeedRouteCatalogSource {
  key: () => string;
  fetch: () => Promise<CodexSpeedRouteCatalogFetch | null>;
}

interface RouteCatalogState {
  source: CodexSpeedRouteCatalogSource | null;
  /** Set by the first read that names the route; only then is it kept fresh. */
  requested: boolean;
  /** Bumped when the source changes, so late answers are dropped. */
  epoch: number;
  /** Bumped by every change to the list; never reset (see the DTO). */
  revision: number;
  entry: {
    key: string;
    fetchedAt: number;
    expiresAt: number;
    truncated: boolean;
    models: CodexSpeedCatalogModel[];
  } | null;
  failure: { key: string; attempts: number; retryAt: number } | null;
  inFlight: Promise<void> | null;
}

const accountProxyCatalog: RouteCatalogState = {
  source: null,
  requested: false,
  epoch: 0,
  revision: 0,
  entry: null,
  failure: null,
  inFlight: null,
};

/** How long a catalog fetch waits for the window bounds before going on. */
const CONTEXT_WINDOW_WAIT_MS = 2_000;
/** The last bounds read, for a fetch whose own read is slow or failed. */
let lastContextWindows: ReadonlyMap<
  string,
  ReturnType<typeof readCodexWireContextWindow>
> = new Map();

function collectPage(payload: unknown, result: FetchResult): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('Codex model/list returned an invalid payload');
  }
  for (const item of payload.data) {
    if (!isRecord(item)) continue;
    const visible = item.hidden !== true;
    for (const id of [item.model, item.id]) {
      if (typeof id !== 'string') continue;
      result.ids.add(id);
      if (visible) result.eligibleIds.add(id);
    }
    const model = parseCodexSpeedCatalogModel(item);
    if (model) result.models.push(model);
  }
  return typeof payload.nextCursor === 'string' && payload.nextCursor
    ? payload.nextCursor
    : null;
}

function ensureRuntimeReplacementSubscription(): void {
  if (unsubscribeRuntimeReplacement) return;
  unsubscribeRuntimeReplacement = onCodexRuntimeServiceReplaced(() => {
    invalidateCodexSpeedCatalog('runtime-replaced');
  });
}

function releaseAccountSubscription(): void {
  const unsubscribe = unsubscribeAccountUpdates;
  unsubscribeAccountUpdates = null;
  unsubscribe?.();
}

async function listAccountModels(): Promise<FetchResult> {
  const result: FetchResult = {
    models: [],
    ids: new Set(),
    eligibleIds: new Set(),
    truncated: false,
  };
  if (__CANOPY_E2E__) {
    const mockOrigin = getMockLlmOrigin();
    if (!mockOrigin) throw new Error('E2E Codex model list has no mock origin');
    collectPage(
      await fetchMockControlPlaneRecord(mockOrigin, '/__mock/codex/models'),
      result,
    );
    return result;
  }
  // Bounded from the start of discovery, alongside `model/list`, so the
  // optional bounds never push the required list past the fetch timeout; a
  // later read still reaches the cache.
  const contextWindows = withTimeout(
    readAccountContextWindows(generation),
    CONTEXT_WINDOW_WAIT_MS,
  ).catch(() => undefined);
  const admin = getCodexRuntimeService().admin();
  // Rebind on every fetch: the admin profile anchor (and so its account
  // listener) can be evicted or replaced between fetches.
  releaseAccountSubscription();
  const startedGeneration = generation;
  // A sign-in change can change which models and speeds the account may run.
  unsubscribeAccountUpdates = admin.onAccountUpdated(() => {
    if (startedGeneration === generation) {
      invalidateCodexSpeedCatalog('account-updated');
    }
  });
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await admin.request('model/list', {
      includeHidden: true,
      ...(cursor ? { cursor } : {}),
    });
    cursor = collectPage(response, result);
    if (!cursor) break;
  }
  result.truncated = cursor !== null;
  const read = await contextWindows;
  // A sign-in change during the read makes both its answer and the cache
  // another account's; leave the bounds unknown instead.
  const windows =
    startedGeneration === generation
      ? (read ?? lastContextWindows)
      : new Map<string, ReturnType<typeof readCodexWireContextWindow>>();
  mergeContextWindows(result.models, windows);
  return result;
}

function mergeContextWindows(
  models: readonly CodexSpeedCatalogModel[],
  windows: NonNullable<typeof lastContextWindows>,
): void {
  for (const model of models) {
    const fields = windows.get(model.model) ?? windows.get(model.id);
    if (fields) Object.assign(model, fields);
  }
}

/**
 * `model/list` omits context window bounds; the catalog Codex uses for this
 * sign-in (`codex debug models`) has them. Never rejects: without it the
 * windows stay unknown and the context window setting is unavailable.
 */
async function readAccountContextWindows(
  startedGeneration: number,
): Promise<typeof lastContextWindows | undefined> {
  try {
    const catalog = await getCodexRuntimeService().getAccountModelCatalog();
    const entries =
      isRecord(catalog) && Array.isArray(catalog.models) ? catalog.models : [];
    const windows = new Map<
      string,
      ReturnType<typeof readCodexWireContextWindow>
    >();
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.slug === 'string') {
        windows.set(entry.slug, readCodexWireContextWindow(entry));
      }
    }
    // A read from before a sign-in change never refills the cleared cache.
    if (startedGeneration !== generation) return undefined;
    lastContextWindows = windows;
    // A read that outlasted the list's wait still reaches the cached
    // catalog, so a pending context window resolves on the next turn.
    const cached = currentEntry();
    if (cached) {
      mergeContextWindows(cached.models, windows);
      broadcast();
    }
    return windows;
  } catch (error) {
    logMainProcessInfo('codex-speed: context window bounds unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Codex model/list timed out'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function currentEntry(): CatalogEntry | null {
  return entry && entry.generation === generation ? entry : null;
}

function currentFailure(): CatalogFailure | null {
  return failure && failure.generation === generation ? failure : null;
}

function isFresh(candidate: CatalogEntry, now: number): boolean {
  return now - candidate.fetchedAt <= CACHE_TTL_MS;
}

function pruneDenials(now: number): boolean {
  let pruned = false;
  for (const [key, denial] of Array.from(denials)) {
    if (denial.expiresAt <= now) {
      denials.delete(key);
      pruned = true;
    }
  }
  return pruned;
}

function routeKey(state: RouteCatalogState): string | null {
  return state.source ? state.source.key() : null;
}

function currentRouteEntry(
  state: RouteCatalogState,
): RouteCatalogState['entry'] {
  const key = routeKey(state);
  return state.entry && state.entry.key === key ? state.entry : null;
}

function currentRouteFailure(
  state: RouteCatalogState,
): RouteCatalogState['failure'] {
  const key = routeKey(state);
  return state.failure && state.failure.key === key ? state.failure : null;
}

function buildRouteSnapshot(
  state: RouteCatalogState,
): CodexSpeedRouteCatalog | null {
  if (!state.requested) return null;
  const cached = currentRouteEntry(state);
  const failed = currentRouteFailure(state);
  const ready = cached !== null && cached.models.length > 0;
  const error = failed
    ? ROUTE_FAILURE_MESSAGE
    : cached && !ready
      ? ROUTE_EMPTY_MESSAGE
      : undefined;
  return {
    revision: state.revision,
    status: ready ? 'ready' : 'unknown',
    fetchedAt: cached?.fetchedAt ?? null,
    expiresAt:
      failed && (!cached || failed.retryAt < cached.expiresAt)
        ? failed.retryAt
        : (cached?.expiresAt ?? null),
    truncated: cached?.truncated ?? false,
    models: ready
      ? cached.models.map((model) => ({
          ...model,
          tiers: model.tiers ? [...model.tiers] : null,
        }))
      : [],
    ...(error ? { error } : {}),
  };
}

function buildSnapshot(): CodexSpeedCatalog {
  const now = Date.now();
  pruneDenials(now);
  const cached = currentEntry();
  const failed = currentFailure();
  const ready = cached !== null && cached.models.length > 0;
  const expiresAt =
    failed && (!cached || failed.retryAt < cached.expiresAt)
      ? failed.retryAt
      : (cached?.expiresAt ?? null);
  const error = failed
    ? CATALOG_FAILURE_MESSAGE
    : cached && !ready
      ? EMPTY_CATALOG_MESSAGE
      : undefined;
  const accountProxy = buildRouteSnapshot(accountProxyCatalog);
  return {
    generation,
    status: ready ? 'ready' : 'unknown',
    fetchedAt: lastFetchedAt,
    expiresAt,
    truncated: cached?.truncated ?? false,
    models: ready
      ? cached.models.map((model) => ({
          ...model,
          tiers: model.tiers ? [...model.tiers] : null,
        }))
      : [],
    denials: Array.from(denials.values(), (denial) => ({ ...denial })),
    ...(error ? { error } : {}),
    ...(accountProxy ? { routes: { 'account-proxy': accountProxy } } : {}),
  };
}

function broadcast(): void {
  if (listeners.size === 0) return;
  const snapshot = buildSnapshot();
  const key = JSON.stringify(snapshot);
  if (key === lastBroadcastKey) return;
  lastBroadcastKey = key;
  for (const listener of Array.from(listeners)) {
    try {
      listener(snapshot);
    } catch {
      // One failing subscriber must not starve the others.
    }
  }
}

function clearRefreshTimer(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

function nativeDueAt(now: number): number | null {
  if (inFlight && inFlight.generation === generation) return null;
  const cached = currentEntry();
  const failed = currentFailure();
  const due: number[] = Array.from(
    denials.values(),
    (denial) => denial.expiresAt,
  );
  // After a failure the backoff decides, even while the last list is kept.
  due.push(failed ? failed.retryAt : (cached?.expiresAt ?? now));
  return Math.min(...due);
}

/** When the requested route list needs revalidating, or null when it does not. */
function routeDueAt(state: RouteCatalogState, now: number): number | null {
  if (!state.requested || !state.source || state.inFlight) return null;
  const failed = currentRouteFailure(state);
  if (failed) return failed.retryAt;
  return currentRouteEntry(state)?.expiresAt ?? now;
}

/**
 * Arm the ONE shared refresh timer, only while a surface is active. Missing,
 * expired, or due data is fetched right away instead.
 */
function scheduleRefresh(): void {
  clearRefreshTimer();
  if (consumers.size === 0) return;
  const now = Date.now();
  pruneDenials(now);
  const due = [nativeDueAt(now), routeDueAt(accountProxyCatalog, now)].filter(
    (at): at is number => at !== null,
  );
  if (due.length === 0) return;
  const delay = Math.min(...due) - now;
  if (delay <= 0) {
    refreshDue(false);
    return;
  }
  // A local-only build fetches when a surface opens, never on a timer.
  if (!allowsAutomaticCall('models.codex-account-refresh')) return;
  refreshTimer = setTimeout(onRefreshTimer, delay);
}

/**
 * Revalidate whichever lists are due, and the runtime catalog as well when
 * `revalidateNative` is set. Each fetch reschedules when it settles.
 *
 * @returns whether any fetch started
 */
function refreshDue(revalidateNative: boolean): boolean {
  const now = Date.now();
  let started = false;
  const route = routeDueAt(accountProxyCatalog, now);
  if (route !== null && route <= now) {
    void startRouteFetch(accountProxyCatalog);
    started = true;
  }
  const native = nativeDueAt(now);
  if (native !== null && (revalidateNative || native <= now)) {
    void startFetch();
    started = true;
  }
  return started;
}

function onRefreshTimer(): void {
  refreshTimer = null;
  if (consumers.size === 0) return;
  // Expiry revalidates positive and negative results, failed lookups (after
  // backoff), and definitive denials that just lapsed.
  const lapsed = pruneDenials(Date.now());
  if (lapsed) broadcast();
  if (!refreshDue(lapsed)) scheduleRefresh();
}

function applySuccess(result: FetchResult): void {
  const now = Date.now();
  entry = {
    generation,
    fetchedAt: now,
    expiresAt: now + CACHE_TTL_MS,
    truncated: result.truncated,
    models: result.models,
    ids: result.ids.size > 0 ? result.ids : null,
    // A partial list can't show a model is missing: unknown for eligibility.
    eligibleIds:
      !result.truncated && result.eligibleIds.size > 0
        ? result.eligibleIds
        : null,
  };
  lastFetchedAt = now;
  failure = null;
}

function applyFailure(): void {
  const now = Date.now();
  const attempts = (currentFailure()?.attempts ?? 0) + 1;
  failure = {
    generation,
    attempts,
    retryAt: now + (RETRY_DELAYS_MS[attempts - 1] ?? CACHE_TTL_MS),
  };
  // A failed revalidation never keeps expired data looking current.
  const cached = currentEntry();
  if (cached && !isFresh(cached, now)) entry = null;
}

function startFetch(): Promise<void> {
  if (inFlight && inFlight.generation === generation) return inFlight.promise;
  clearRefreshTimer();
  const startedGeneration = generation;
  const promise = withTimeout(listAccountModels(), REQUEST_TIMEOUT_MS)
    .then(
      (result) => {
        if (startedGeneration === generation) applySuccess(result);
      },
      () => {
        if (startedGeneration === generation) applyFailure();
      },
    )
    .finally(() => {
      if (inFlight?.promise !== promise) return;
      inFlight = null;
      broadcast();
      scheduleRefresh();
    });
  inFlight = { generation: startedGeneration, promise };
  return promise;
}

function startRouteFetch(state: RouteCatalogState): Promise<void> {
  if (state.inFlight) return state.inFlight;
  const source = state.source;
  if (!source) return Promise.resolve();
  const startedEpoch = state.epoch;
  const key = source.key();
  const promise = withTimeout(source.fetch(), REQUEST_TIMEOUT_MS)
    .then(
      (result) => {
        if (startedEpoch !== state.epoch) return;
        const now = Date.now();
        state.entry = {
          key,
          fetchedAt: now,
          expiresAt: now + CACHE_TTL_MS,
          truncated: result?.truncated ?? false,
          models: result?.models ?? [],
        };
        state.failure = null;
        state.revision += 1;
      },
      () => {
        if (startedEpoch !== state.epoch) return;
        const now = Date.now();
        const previous = currentRouteFailure(state);
        const attempts = (previous?.attempts ?? 0) + 1;
        state.failure = {
          key,
          attempts,
          retryAt: now + (RETRY_DELAYS_MS[attempts - 1] ?? CACHE_TTL_MS),
        };
        // A failed revalidation never keeps expired data looking current.
        const cached = currentRouteEntry(state);
        if (cached && now >= cached.expiresAt) state.entry = null;
        state.revision += 1;
      },
    )
    .finally(() => {
      if (state.inFlight !== promise) return;
      state.inFlight = null;
      broadcast();
      scheduleRefresh();
    });
  state.inFlight = promise;
  return promise;
}

function needsRouteFetch(
  state: RouteCatalogState,
  force: boolean,
  now: number,
): boolean {
  if (!state.source) return false;
  if (force) return true;
  const cached = currentRouteEntry(state);
  if (cached && now - cached.fetchedAt <= CACHE_TTL_MS) return false;
  const failed = currentRouteFailure(state);
  return !failed || failed.retryAt <= now;
}

/**
 * Read a route's own catalog when it is missing or stale. Marks the route as
 * requested so later snapshots carry it and the expiry refresh keeps it.
 */
async function readRouteCatalog(
  state: RouteCatalogState,
  force: boolean,
): Promise<void> {
  const firstRequest = !state.requested;
  state.requested = true;
  if (state.inFlight) {
    await state.inFlight;
    return;
  }
  if (needsRouteFetch(state, force, Date.now())) {
    await startRouteFetch(state);
  } else if (firstRequest) {
    scheduleRefresh();
  }
}

/**
 * Register where the account proxy route's own Codex catalog comes from.
 * Without a source that route's list stays unknown, so Ultra fast on it is
 * never confirmed (Regular and Fast are unaffected).
 */
export function setCodexSpeedRouteCatalogSource(
  route: CodexSpeedCatalogRoute,
  source: CodexSpeedRouteCatalogSource | null,
): void {
  if (route !== 'account-proxy') return;
  const state = accountProxyCatalog;
  state.source = source;
  state.epoch += 1;
  state.entry = null;
  state.failure = null;
  state.inFlight = null;
  state.revision += 1;
  broadcast();
  scheduleRefresh();
}

function needsFetch(force: boolean, now: number): boolean {
  if (force) return true;
  const cached = currentEntry();
  if (cached && isFresh(cached, now)) return false;
  const failed = currentFailure();
  return !failed || failed.retryAt <= now;
}

/**
 * Model ids (`model/list` `model` and `id`) the signed-in Codex account can
 * run, or `null` when the account's list is unavailable. Callers treat `null`
 * as "unknown" and keep their previous behavior rather than dropping Codex.
 * A result from an account generation that was reset while the caller waited
 * is never returned.
 */
export async function readCodexAccountModelIds(): Promise<ReadonlySet<string> | null> {
  ensureRuntimeReplacementSubscription();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestedGeneration = generation;
    const cached = currentEntry();
    if (cached?.ids && isFresh(cached, Date.now())) return cached.ids;
    // Auto keeps its original behavior: a failed or empty lookup is asked
    // again on the next read rather than waiting out the speed backoff.
    await startFetch();
    if (requestedGeneration !== generation) continue;
    return currentEntry()?.ids ?? null;
  }
  return null;
}

/**
 * The fresh cached ids of the account's NON-HIDDEN models, or `null` when
 * nothing current is cached or every listed model is hidden. Never fetches or
 * spawns anything, so the send path may consult it before any lazy auth probe.
 * Feeds default-model eligibility (CAN-4716); hidden models never count
 * toward it.
 */
export function peekCodexAccountModelIds(): ReadonlySet<string> | null {
  const cached = currentEntry();
  return cached?.eligibleIds && isFresh(cached, Date.now())
    ? cached.eligibleIds
    : null;
}

/** Drop the cached list so the next read asks the account again. */
export function resetCodexAccountModelCache(): void {
  invalidateCodexSpeedCatalog('reset');
}

export type CodexSpeedCatalogInvalidationReason =
  | 'account-updated'
  | 'auth-transition'
  | 'runtime-replaced'
  | 'reset';

/**
 * Start a new account generation: cached models, tiers, failures, and denials
 * are dropped; in-flight lookups from the old generation can no longer reach
 * any caller; the old account subscription is released and rebound by the
 * next fetch. Active surfaces refetch immediately.
 */
export function invalidateCodexSpeedCatalog(
  reason: CodexSpeedCatalogInvalidationReason,
): void {
  logMainProcessInfo(`codex-speed: catalog invalidated (${reason})`);
  generation += 1;
  entry = null;
  failure = null;
  lastFetchedAt = null;
  inFlight = null;
  denials.clear();
  // Another sign-in can have other bounds; never lend it the last ones.
  lastContextWindows = new Map();
  releaseAccountSubscription();
  broadcast();
  scheduleRefresh();
}

export interface ReadCodexSpeedCatalogOptions {
  /** Revalidate even when the cache is fresh (still deduplicated). */
  force?: boolean;
  /** Also read this route's own list (see {@link CodexSpeedRouteCatalogSource}). */
  route?: CodexSpeedCatalogRoute;
}

/**
 * The sanitized Codex speed catalog for the native canonical sign-in, plus
 * the requested route's own list. Never rejects: an unavailable list resolves
 * as `unknown`. Stale data is revalidated (outside failure backoff); a fresh
 * cache is returned as is.
 */
export async function readCodexSpeedCatalog(
  options: ReadCodexSpeedCatalogOptions = {},
): Promise<CodexSpeedCatalog> {
  ensureRuntimeReplacementSubscription();
  const routeRead =
    options.route === 'account-proxy'
      ? readRouteCatalog(accountProxyCatalog, options.force === true)
      : null;
  const native = readNativeCatalog(options.force === true);
  if (!routeRead) return native;
  await Promise.all([native, routeRead]);
  return buildSnapshot();
}

async function readNativeCatalog(force: boolean): Promise<CodexSpeedCatalog> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestedGeneration = generation;
    const pending =
      inFlight && inFlight.generation === generation
        ? inFlight.promise
        : needsFetch(force && attempt === 0, Date.now())
          ? startFetch()
          : null;
    if (pending) await pending;
    if (requestedGeneration === generation) return buildSnapshot();
  }
  return buildSnapshot();
}

/** Current catalog projection without starting a lookup. */
export function getCodexSpeedCatalogSnapshot(): CodexSpeedCatalog {
  return buildSnapshot();
}

/**
 * Observe catalog changes. Notifications are ordered by generation, then by
 * `fetchedAt`, and identical consecutive projections are skipped.
 */
export function subscribeCodexSpeedCatalog(
  listener: (catalog: CodexSpeedCatalog) => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
    if (listeners.size === 0) lastBroadcastKey = null;
  };
}

/**
 * Mark one mounted, visible speed surface active or inactive. Keys must be
 * unique across windows. The first active consumer arms the single expiry
 * refresh (fetching immediately when nothing current is cached); the last
 * inactive consumer disarms it.
 */
export function setCodexSpeedConsumerActive(
  consumerKey: string,
  active: boolean,
): void {
  ensureRuntimeReplacementSubscription();
  if (active) {
    if (consumers.has(consumerKey)) return;
    consumers.add(consumerKey);
    if (consumers.size === 1) scheduleRefresh();
    return;
  }
  if (consumers.delete(consumerKey) && consumers.size === 0) {
    clearRefreshTimer();
  }
}

export interface CodexSpeedAdmissionRequest {
  /** Exact requested speed; never substituted. */
  speed: CodexSpeed;
  /** Actual resolved route/model facts of the turn about to run. */
  route: CodexSpeedRouteFacts;
}

export interface CodexSpeedAdmission {
  speed: CodexSpeed;
  availability: CodexSpeedAvailability;
  /** Catalog generation admitted against; pass to reportCodexSpeedRejection. */
  generation: number;
  /** Route admitted against; a rejection is denied for this route only. */
  routeProfile: CodexSpeedRouteProfile;
}

/** Ultra fast cannot run on the given route; carries the derived reason. */
export class CodexSpeedUnavailableError extends CodexSpeedUnsupportedError {
  readonly availability: CodexSpeedAvailability;

  constructor(availability: CodexSpeedAvailability) {
    super(
      availability.speed,
      describeCodexSpeedAvailability(availability) ??
        "Couldn't confirm Ultra fast for this model. Try again, or choose Regular or Fast.",
    );
    this.name = 'CodexSpeedUnavailableError';
    this.availability = availability;
  }
}

/**
 * Admission check for the exact requested speed, called from core/main
 * dispatch BEFORE any side effect. Regular and Fast resolve immediately with
 * no catalog read (existing behavior). Ultra fast requires the native Codex
 * route or the account proxy route with an explicit model; other routes and
 * Auto are rejected without touching the runtime. Otherwise stale catalogs are
 * revalidated and the resolved model must advertise `ultrafast`, on the proxy
 * route in the proxy's own catalog as well, with no active denial.
 *
 * @throws CodexSpeedUnavailableError (a CodexSpeedUnsupportedError)
 */
export async function assertCodexSpeedAvailable(
  request: CodexSpeedAdmissionRequest,
): Promise<CodexSpeedAdmission> {
  const { speed, route } = request;
  if (speed !== 'ultrafast') {
    return {
      speed,
      availability: deriveCodexSpeedAvailability({
        catalog: null,
        route,
        speed,
        now: Date.now(),
      }),
      generation,
      routeProfile: route.routeProfile,
    };
  }
  const routeOnly = deriveCodexSpeedAvailability({
    catalog: null,
    route,
    speed,
    now: Date.now(),
  });
  if (routeOnly.reason !== 'catalog-unknown') {
    throw new CodexSpeedUnavailableError(routeOnly);
  }
  const catalog = await readCodexSpeedCatalog(
    route.routeProfile === 'account-proxy' ? { route: 'account-proxy' } : {},
  );
  const availability = deriveCodexSpeedAvailability({
    catalog,
    route,
    speed,
    now: Date.now(),
  });
  if (availability.status !== 'available') {
    throw new CodexSpeedUnavailableError(availability);
  }
  return {
    speed,
    availability,
    generation: catalog.generation,
    routeProfile: route.routeProfile,
  };
}

export interface CodexSpeedRejectionReport {
  speed: CodexSpeed;
  /** Resolved runtime model the rejected request used. */
  runtimeModel: string;
  /** Conservative classification, e.g. from classifyCodexSpeedRejection. */
  kind: CodexSpeedRejectionKind;
  /** Generation from the admission; reports from an older account are ignored. */
  generation: number;
  /** Route of the admission; the denial applies to this route only. */
  routeProfile?: CodexSpeedRouteProfile;
}

function denialKey(model: string, route: 'account-proxy' | undefined): string {
  return route ? `${route}:${model}` : model;
}

/**
 * Record a server rejection of a speed request. Only a definitive
 * model/tier/access rejection of Ultra fast in the current generation creates
 * a short-lived denial (it expires and the catalog is revalidated);
 * authentication, network, rate-limit, capacity, unknown, Regular, and Fast
 * never do. Nothing is retried automatically at another speed.
 *
 * @returns whether a denial was recorded
 */
export function reportCodexSpeedRejection(
  report: CodexSpeedRejectionReport,
): boolean {
  if (report.speed !== 'ultrafast') return false;
  if (!isDefinitiveCodexSpeedRejection(report.kind)) return false;
  if (report.generation !== generation || !report.runtimeModel) return false;
  const route =
    report.routeProfile === 'account-proxy' ? 'account-proxy' : undefined;
  denials.set(denialKey(report.runtimeModel, route), {
    model: report.runtimeModel,
    ...(route ? { route } : {}),
    expiresAt: Date.now() + CODEX_SPEED_DENIAL_TTL_MS,
  });
  broadcast();
  if (!(inFlight && inFlight.generation === generation)) scheduleRefresh();
  return true;
}

/** Test-only: drop every cache, consumer, timer, and subscription. */
export function resetCodexSpeedCatalogForTests(): void {
  clearRefreshTimer();
  releaseAccountSubscription();
  unsubscribeRuntimeReplacement?.();
  unsubscribeRuntimeReplacement = null;
  generation = 0;
  entry = null;
  failure = null;
  lastFetchedAt = null;
  inFlight = null;
  denials.clear();
  consumers.clear();
  listeners.clear();
  lastBroadcastKey = null;
  Object.assign(accountProxyCatalog, {
    source: null,
    requested: false,
    epoch: accountProxyCatalog.epoch + 1,
    revision: accountProxyCatalog.revision + 1,
    entry: null,
    failure: null,
    inFlight: null,
  });
}
