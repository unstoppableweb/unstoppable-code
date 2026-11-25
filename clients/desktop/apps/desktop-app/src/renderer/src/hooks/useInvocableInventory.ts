import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  InvocableInventoryEntry,
  InvocableInventoryProvider,
  ListInvocableInventoryResponse,
} from '@canopy/desktop-shared/types';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

export interface UseInvocableInventoryResult {
  /** Cached invocable-inventory rows for the effective provider. */
  entries: InvocableInventoryEntry[];
  /** True while a list/refresh round-trip is in flight. */
  loading: boolean;
  /** True when the served cache is stale (a rebuild is in progress). */
  stale: boolean;
  /** Force a rebuild and adopt the rebuilt cache. */
  refresh: () => Promise<void>;
  /**
   * List the cache again without forcing a rebuild. The composer menu calls
   * this on open: the backend answers from its cache and re-checks the
   * inherited Cursor folders (home skills, the Cursor app's plugin cache),
   * which no Canopy mutation marks stale, pushing a change if they moved.
   */
  reload: () => Promise<void>;
}

type InventoryProviderKey = InvocableInventoryProvider | null;
type CacheSubscriber = () => void;

interface InventorySnapshot {
  entries: InvocableInventoryEntry[];
  loading: boolean;
  stale: boolean;
}

interface WorkspaceGeneration {
  enabled: boolean;
  generation: number;
}

interface InventoryCacheEntry extends InventorySnapshot {
  provider: InventoryProviderKey;
  snapshot: InventorySnapshot;
  subscribers: Set<CacheSubscriber>;
  inFlightList: Promise<void> | null;
  reloadAfterInFlight: boolean;
  pendingContext: WorkspaceGeneration | null;
  pendingListLoading: boolean;
  loadingRequests: number;
  contextInitialized: boolean;
  context: WorkspaceGeneration;
  hasLoaded: boolean;
}

const EMPTY_ENTRIES: InvocableInventoryEntry[] = [];
const EMPTY_SNAPSHOT: InventorySnapshot = {
  entries: EMPTY_ENTRIES,
  loading: false,
  stale: false,
};
const NOOP = (): void => undefined;

const inventoryCaches = new Map<InventoryProviderKey, InventoryCacheEntry>();
let activeSubscriberCount = 0;
let unsubscribeInventoryChanged: (() => void) | null = null;

function makeCacheEntry(provider: InventoryProviderKey): InventoryCacheEntry {
  return {
    provider,
    entries: EMPTY_ENTRIES,
    loading: false,
    stale: false,
    snapshot: EMPTY_SNAPSHOT,
    subscribers: new Set(),
    inFlightList: null,
    reloadAfterInFlight: false,
    pendingContext: null,
    pendingListLoading: false,
    loadingRequests: 0,
    contextInitialized: false,
    context: { enabled: false, generation: 0 },
    hasLoaded: false,
  };
}

function getOrCreateCache(provider: InventoryProviderKey): InventoryCacheEntry {
  const existing = inventoryCaches.get(provider);
  if (existing) return existing;
  const created = makeCacheEntry(provider);
  inventoryCaches.set(provider, created);
  return created;
}

function publishCache(
  cache: InventoryCacheEntry,
  patch: Partial<InventorySnapshot>,
): void {
  const entries = patch.entries ?? cache.entries;
  const loading = patch.loading ?? cache.loading;
  const stale = patch.stale ?? cache.stale;
  if (
    entries === cache.entries &&
    loading === cache.loading &&
    stale === cache.stale
  )
    return;

  cache.entries = entries;
  cache.loading = loading;
  cache.stale = stale;
  cache.snapshot = { entries, loading, stale };
  for (const subscriber of Array.from(cache.subscribers)) subscriber();
}

function beginLoading(cache: InventoryCacheEntry): void {
  cache.loadingRequests += 1;
  publishCache(cache, { loading: true });
}

function endLoading(cache: InventoryCacheEntry): void {
  cache.loadingRequests = Math.max(0, cache.loadingRequests - 1);
  publishCache(cache, { loading: cache.loadingRequests > 0 });
}

function getWorkspaceGeneration(): WorkspaceGeneration {
  const enabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key);
  return {
    enabled,
    generation: enabled
      ? useWorkspaceContextStore.getState().appliedGeneration
      : 0,
  };
}

function updateWorkspaceGeneration(
  cache: InventoryCacheEntry,
  context: WorkspaceGeneration,
): boolean {
  const changed =
    !cache.contextInitialized ||
    cache.context.enabled !== context.enabled ||
    cache.context.generation !== context.generation;
  // Another workspace context lists other rows; do not show the old ones
  // while the new list loads.
  if (changed && cache.contextInitialized)
    publishCache(cache, { entries: EMPTY_ENTRIES, stale: false });
  cache.contextInitialized = true;
  cache.context = context;
  return changed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function haveSameJsonContent(left: unknown, right: unknown): boolean {
  if (left === right) return true;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) =>
      haveSameJsonContent(value, right[index]),
    );
  }

  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      haveSameJsonContent(left[key], right[key]),
  );
}

function entriesHaveSameContent(
  left: InvocableInventoryEntry[],
  right: InvocableInventoryEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => haveSameJsonContent(entry, right[index]));
}

function applyResponse(
  cache: InventoryCacheEntry,
  context: WorkspaceGeneration,
  response: ListInvocableInventoryResponse,
): void {
  if (
    context.enabled &&
    useWorkspaceContextStore.getState().appliedGeneration !== context.generation
  ) {
    const currentContext = getWorkspaceGeneration();
    updateWorkspaceGeneration(cache, currentContext);
    if (cache.subscribers.size > 0)
      void requestList(cache, currentContext, true, true);
    return;
  }

  // A list that lands after the last reader left stays unloaded: nobody
  // heard change events since, so the next reader lists again.
  if (cache.subscribers.size > 0) cache.hasLoaded = true;
  // Keep the previously shown entries when the backend serves an empty
  // placeholder during a rebuild; adopt entries in every other case.
  if (
    !context.enabled &&
    response.rebuilding &&
    response.entries.length === 0
  ) {
    publishCache(cache, { stale: response.stale });
    return;
  }

  const filteredEntries = cache.provider
    ? response.entries.filter((entry) => entry.provider === cache.provider)
    : response.entries;
  const entries = entriesHaveSameContent(cache.entries, filteredEntries)
    ? cache.entries
    : filteredEntries;
  publishCache(cache, { entries, stale: response.stale });
}

async function listOnce(
  cache: InventoryCacheEntry,
  context: WorkspaceGeneration,
): Promise<void> {
  const inventory = window.invocableInventory;
  if (!inventory) return;
  try {
    const result = await inventory.list({ providerType: cache.provider });
    if (result.success && result.data)
      applyResponse(cache, context, result.data);
  } catch {
    // Keep the previously loaded entries on a transient IPC failure.
  }
}

function requestList(
  cache: InventoryCacheEntry,
  context: WorkspaceGeneration,
  showLoading: boolean,
  queueIfInFlight: boolean,
): Promise<void> {
  if (cache.inFlightList) {
    if (queueIfInFlight) {
      cache.reloadAfterInFlight = true;
      cache.pendingContext = context;
      cache.pendingListLoading ||= showLoading;
    }
    return cache.inFlightList;
  }

  const tracked = (async (): Promise<void> => {
    let activeContext = context;
    let activeLoading = showLoading;
    if (activeLoading) beginLoading(cache);
    try {
      while (true) {
        await listOnce(cache, activeContext);
        const hasPendingReload =
          cache.reloadAfterInFlight && cache.subscribers.size > 0;
        const nextContext = cache.pendingContext ?? cache.context;
        const nextLoading = cache.pendingListLoading;
        cache.reloadAfterInFlight = false;
        cache.pendingContext = null;
        cache.pendingListLoading = false;
        if (!hasPendingReload) break;

        if (nextLoading && !activeLoading) beginLoading(cache);
        else if (!nextLoading && activeLoading) endLoading(cache);
        activeLoading = nextLoading;
        activeContext = nextContext;
      }
    } finally {
      if (activeLoading) endLoading(cache);
      cache.inFlightList = null;
    }
  })();
  cache.inFlightList = tracked;
  return tracked;
}

function handleInventoryChanged(): void {
  inventoryCaches.forEach((cache) => {
    if (cache.subscribers.size === 0) return;
    const context = getWorkspaceGeneration();
    updateWorkspaceGeneration(cache, context);
    void requestList(cache, context, true, true);
  });
}

function subscribeInventoryChanged(): void {
  if (unsubscribeInventoryChanged || !window.invocableInventory) return;
  unsubscribeInventoryChanged = window.invocableInventory.onChanged(
    handleInventoryChanged,
  );
}

function subscribeToCache(
  provider: InvocableInventoryProvider | null | undefined,
  subscriber: CacheSubscriber,
): () => void {
  if (provider === undefined) return NOOP;
  const cache = getOrCreateCache(provider);
  if (!cache.subscribers.has(subscriber)) {
    // The first reader after a gap: a list still on the wire was asked before
    // the gap and may predate a change nobody heard, so one more follows it.
    if (cache.subscribers.size === 0 && cache.inFlightList) {
      cache.reloadAfterInFlight = true;
    }
    cache.subscribers.add(subscriber);
    activeSubscriberCount += 1;
  }
  subscribeInventoryChanged();

  return (): void => {
    if (!cache.subscribers.delete(subscriber)) return;
    activeSubscriberCount = Math.max(0, activeSubscriberCount - 1);
    // The rows stay for the next reader: switching chats unmounts every reader
    // and mounts new ones in the same commit, and dropping the rows there
    // re-rendered the new transcript and composer twice (empty, then listed).
    // Nobody hears change events while unsubscribed, so that reader lists again.
    if (cache.subscribers.size === 0) cache.hasLoaded = false;
    if (activeSubscriberCount === 0) {
      unsubscribeInventoryChanged?.();
      unsubscribeInventoryChanged = null;
    }
  };
}

function getSnapshot(
  provider: InvocableInventoryProvider | null | undefined,
): InventorySnapshot {
  if (provider === undefined) return EMPTY_SNAPSHOT;
  return inventoryCaches.get(provider)?.snapshot ?? EMPTY_SNAPSHOT;
}

async function refreshCache(provider: InventoryProviderKey): Promise<void> {
  const inventory = window.invocableInventory;
  const cache = inventoryCaches.get(provider);
  if (!inventory || !cache || cache.subscribers.size === 0) return;
  const context = getWorkspaceGeneration();
  beginLoading(cache);
  try {
    const result = await inventory.refresh();
    if (result.success && result.data)
      applyResponse(cache, context, result.data);
  } catch {
    // Keep the previously loaded entries on a transient IPC failure.
  } finally {
    endLoading(cache);
  }
}

function reloadCache(provider: InventoryProviderKey): Promise<void> {
  const cache = inventoryCaches.get(provider);
  if (!cache || cache.subscribers.size === 0) return Promise.resolve();
  return requestList(cache, getWorkspaceGeneration(), false, true);
}

/** Renderer hook over the prebuilt inventory exposed by the preload bridge. */
export function useInvocableInventory(
  providerType: InvocableInventoryProvider | null | undefined,
): UseInvocableInventoryResult {
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const contextGeneration = useWorkspaceContextStore((state) =>
    contextEnabled ? state.appliedGeneration : 0,
  );
  const subscribe = useCallback(
    (subscriber: CacheSubscriber): (() => void) =>
      subscribeToCache(providerType, subscriber),
    [providerType],
  );
  const readSnapshot = useCallback(
    (): InventorySnapshot => getSnapshot(providerType),
    [providerType],
  );
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

  useEffect(() => {
    if (providerType === undefined) return;
    const cache = getOrCreateCache(providerType);
    const context = { enabled: contextEnabled, generation: contextGeneration };
    const contextChanged = updateWorkspaceGeneration(cache, context);
    // Rows kept from an earlier reader are shown while this list checks them,
    // so only an empty cache reports loading.
    if (contextChanged || (!cache.hasLoaded && !cache.inFlightList))
      void requestList(cache, context, cache.entries.length === 0, true);
  }, [contextEnabled, contextGeneration, providerType]);

  const refresh = useCallback(
    (): Promise<void> =>
      providerType === undefined
        ? Promise.resolve()
        : refreshCache(providerType),
    [providerType],
  );
  const reload = useCallback(
    (): Promise<void> =>
      providerType === undefined
        ? Promise.resolve()
        : reloadCache(providerType),
    [providerType],
  );

  return { ...snapshot, refresh, reload };
}
