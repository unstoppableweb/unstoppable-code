import { create } from 'zustand';
import type {
  AgentAuditEntry,
  AgentAuditHistoryRequest,
  AgentAuditTranscriptRequest,
  AgentAuditTranscriptResponse,
  AgentObservabilitySnapshot,
  AgentProviderType,
  AgentUsageOverview,
  UsageMetricsRequest,
  UsageMetricsResponse,
  UsageMetricsViewRequest,
  UsageMetricsViewResponse,
  UsageTabSummaryRequest,
  UsageTabSummaryResponse,
  UsageTimeseriesRequest,
  UsageTimeseriesResponse,
} from '@canopy/desktop-shared/types';

let initializePromise: Promise<void> | null = null;
let unsubscribeUpdates: (() => void) | null = null;
let historyRequestSequence = 0;
const refreshProviderUsageDetailsPromises = new Map<
  AgentProviderType,
  Promise<AgentUsageOverview>
>();
const RUNNING_TRANSCRIPT_CACHE_TTL_MS = 3_000;

interface CachedTranscript {
  response: AgentAuditTranscriptResponse;
  loadedAt: number;
}

interface CachedUsageTimeseries {
  request: UsageTimeseriesRequest;
  response: UsageTimeseriesResponse;
  loadedAt: number;
}

interface CachedUsageMetrics {
  request: UsageMetricsRequest;
  response: UsageMetricsResponse;
  loadedAt: number;
}

interface CachedUsageMetricsView {
  request: UsageMetricsViewRequest;
  response: UsageMetricsViewResponse;
  loadedAt: number;
}

interface CachedUsageTabSummary {
  request: UsageTabSummaryRequest;
  response: UsageTabSummaryResponse;
  loadedAt: number;
}

interface ObservabilityState {
  initialized: boolean;
  loadingHistory: boolean;
  refreshingProviders: Set<AgentProviderType>;
  recentEntries: AgentAuditEntry[];
  historyEntries: AgentAuditEntry[];
  transcriptCache: Record<string, CachedTranscript>;
  transcriptCacheVersion: number;
  nextCursor?: string;
  activeHistoryRequest: AgentAuditHistoryRequest | null;
  usage: AgentUsageOverview;
  retentionDays: number;
  usageTimeseriesCache: Record<string, CachedUsageTimeseries>;
  usageTimeseriesVersion: number;
  usageTimeseriesPendingRequests: number;
  loadingUsageTimeseries: boolean;
  usageMetricsCache: Record<string, CachedUsageMetrics>;
  usageMetricsVersion: number;
  loadingUsageMetrics: boolean;
  usageMetricsError: string | null;
  usageMetricsViewCache: Record<string, CachedUsageMetricsView>;
  usageMetricsViewVersion: number;
  usageTabSummaryCache: Record<string, CachedUsageTabSummary>;
  usageTabSummaryVersion: number;
  initialize: () => Promise<void>;
  refreshProviderUsage: (provider: AgentProviderType) => Promise<void>;
  refreshProviderUsageDetails: (
    provider: AgentProviderType,
  ) => Promise<AgentUsageOverview>;
  /**
   * Deterministic counterpart to {@link refreshProviderUsage}: refreshes the
   * provider's usage, then synchronously loads the snapshot, sets store `usage`
   * from it, and returns that overview. Avoids the race where the IPC refresh
   * resolves before the async `onUpdate` 'usage' broadcast reaches the store —
   * so callers (e.g. "Schedule Resume") never schedule from stale `usage`.
   */
  refreshProviderUsageSnapshot: (
    provider: AgentProviderType,
  ) => Promise<AgentUsageOverview>;
  refreshHistory: (request?: AgentAuditHistoryRequest) => Promise<void>;
  loadMoreHistory: (request?: AgentAuditHistoryRequest) => Promise<void>;
  loadTranscript: (
    entry: AgentAuditEntry,
  ) => Promise<AgentAuditTranscriptResponse>;
  loadUsageTimeseries: (
    request: UsageTimeseriesRequest,
  ) => Promise<UsageTimeseriesResponse>;
  loadUsageMetrics: (
    request: UsageMetricsRequest,
  ) => Promise<UsageMetricsResponse>;
  loadUsageMetricsView: (
    request: UsageMetricsViewRequest,
  ) => Promise<UsageMetricsViewResponse>;
  loadUsageTabSummary: (
    request: UsageTabSummaryRequest,
  ) => Promise<UsageTabSummaryResponse>;
  applySnapshot: (snapshot: AgentObservabilitySnapshot) => void;
  clearEntryCaches: () => void;
}

function usageTimeseriesCacheKey(request: UsageTimeseriesRequest): string {
  return JSON.stringify({
    startDate: request.startDate,
    endDate: request.endDate,
    bucket: request.bucket,
    dataset: request.dataset ?? { kind: 'tokens' },
  });
}

export function usageMetricsCacheKey(request: UsageMetricsRequest): string {
  return JSON.stringify({
    startDate: request.startDate,
    endDate: request.endDate,
    workspaceId: request.workspaceId,
    repoId: request.repoId,
    provider: request.provider,
    initiationSource: request.initiationSource,
  });
}

function usageMetricsViewCacheKey(request: UsageMetricsViewRequest): string {
  return JSON.stringify(request);
}

function usageTabSummaryCacheKey(request: UsageTabSummaryRequest): string {
  return request.tab;
}

function defaultUsage(): AgentUsageOverview {
  return {
    updatedAt: new Date(0).toISOString(),
    providers: [],
  };
}

function buildTranscriptRequest(
  entry: AgentAuditEntry,
): AgentAuditTranscriptRequest {
  return {
    id: entry.id,
    eventType: entry.eventType,
    startedAt: entry.startedAt,
  };
}

function entryMatchesFilter(
  entry: AgentAuditEntry,
  request: AgentAuditHistoryRequest,
): boolean {
  const startedAtTime = Date.parse(entry.startedAt);
  if (!Number.isFinite(startedAtTime)) {
    return false;
  }
  if (request.startDate) {
    const startTime = Date.parse(request.startDate);
    if (Number.isFinite(startTime) && startedAtTime < startTime) {
      return false;
    }
  }
  if (request.endDate) {
    const endTime = Date.parse(request.endDate);
    if (Number.isFinite(endTime) && startedAtTime >= endTime) {
      return false;
    }
  }
  if (request.provider && request.provider !== 'all') {
    if (entry.provider !== request.provider) {
      return false;
    }
  }
  if (request.status && request.status !== 'all') {
    if (entry.status !== request.status) {
      return false;
    }
  }
  if (request.eventType && request.eventType !== 'all') {
    if (entry.eventType !== request.eventType) {
      return false;
    }
  }
  if (request.projectId) {
    if (entry.projectId !== request.projectId) {
      return false;
    }
  }
  if (request.worktreeId) {
    if (entry.worktreeId !== request.worktreeId) {
      return false;
    }
  }
  if (request.pipelineExecutionId) {
    if (entry.pipelineExecutionId !== request.pipelineExecutionId) {
      return false;
    }
  }
  if (request.activeOnly) {
    if (entry.status !== 'running') {
      return false;
    }
  }
  if (request.search) {
    const term = request.search.toLowerCase();
    const haystack = [
      entry.label,
      entry.model,
      entry.agentId,
      entry.requestedModel,
      entry.projectId,
      entry.worktreeId,
      entry.chatId,
      entry.repoId,
      entry.repoLabel,
      entry.sdkSessionId,
      entry.pipelineExecutionId,
      entry.pipelineName,
      entry.jobId,
      entry.stepId,
      entry.error,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(term)) {
      return false;
    }
  }
  return true;
}

function mergeEntriesIntoHistory(
  existing: AgentAuditEntry[],
  incoming: AgentAuditEntry[],
  request: AgentAuditHistoryRequest | null,
): AgentAuditEntry[] {
  const next = [...existing];
  for (const entry of incoming) {
    const existingIdx = next.findIndex((e) => e.id === entry.id);
    const matches = !request || entryMatchesFilter(entry, request);

    if (existingIdx >= 0) {
      if (matches) {
        next[existingIdx] = entry;
      } else {
        next.splice(existingIdx, 1);
      }
    } else if (matches) {
      next.push(entry);
    }
  }
  next.sort(
    (left, right) =>
      new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
  );
  return next;
}

function invalidateTranscriptCache(
  cache: Record<string, CachedTranscript>,
  entries: AgentAuditEntry[],
): Record<string, CachedTranscript> {
  if (entries.length === 0) {
    return cache;
  }

  const nextCache = { ...cache };
  for (const entry of entries) {
    delete nextCache[entry.id];
  }
  return nextCache;
}

function invalidateUsageDetailCaches(
  state: ObservabilityState,
): Pick<
  ObservabilityState,
  | 'usageTimeseriesCache'
  | 'usageTimeseriesVersion'
  | 'usageMetricsCache'
  | 'usageMetricsVersion'
  | 'usageMetricsViewCache'
  | 'usageMetricsViewVersion'
  | 'usageTabSummaryCache'
  | 'usageTabSummaryVersion'
> {
  return {
    usageTimeseriesCache: {},
    usageTimeseriesVersion: state.usageTimeseriesVersion + 1,
    usageMetricsCache: {},
    usageMetricsVersion: state.usageMetricsVersion + 1,
    usageMetricsViewCache: {},
    usageMetricsViewVersion: state.usageMetricsViewVersion + 1,
    usageTabSummaryCache: {},
    usageTabSummaryVersion: state.usageTabSummaryVersion + 1,
  };
}

function snapshotState(
  state: ObservabilityState,
  snapshot: AgentObservabilitySnapshot,
): Partial<ObservabilityState> {
  return {
    recentEntries: snapshot.recentEntries,
    transcriptCache: invalidateTranscriptCache(
      state.transcriptCache,
      snapshot.recentEntries,
    ),
    transcriptCacheVersion: state.transcriptCacheVersion + 1,
    usage: snapshot.usage,
    retentionDays: snapshot.retentionDays,
    ...invalidateUsageDetailCaches(state),
  };
}

function clearEntryCaches(
  state: ObservabilityState,
): Pick<ObservabilityState, 'transcriptCache' | 'transcriptCacheVersion'> &
  ReturnType<typeof invalidateUsageDetailCaches> {
  return {
    transcriptCache: {},
    transcriptCacheVersion: state.transcriptCacheVersion + 1,
    ...invalidateUsageDetailCaches(state),
  };
}

export const useObservabilityStore = create<ObservabilityState>((set, get) => ({
  initialized: false,
  loadingHistory: false,
  refreshingProviders: new Set(),
  recentEntries: [],
  historyEntries: [],
  transcriptCache: {},
  transcriptCacheVersion: 0,
  nextCursor: undefined,
  activeHistoryRequest: null,
  usage: defaultUsage(),
  retentionDays: 7,
  usageTimeseriesCache: {},
  usageTimeseriesVersion: 0,
  usageTimeseriesPendingRequests: 0,
  loadingUsageTimeseries: false,
  usageMetricsCache: {},
  usageMetricsVersion: 0,
  loadingUsageMetrics: false,
  usageMetricsError: null,
  usageMetricsViewCache: {},
  usageMetricsViewVersion: 0,
  usageTabSummaryCache: {},
  usageTabSummaryVersion: 0,

  initialize: async (): Promise<void> => {
    if (initializePromise) {
      return initializePromise;
    }
    if (get().initialized) {
      return;
    }

    set({ initialized: true });
    initializePromise = (async (): Promise<void> => {
      try {
        const snapshot = await window.api.observability.loadSnapshot();
        set({
          recentEntries: snapshot.recentEntries,
          usage: snapshot.usage,
          retentionDays: snapshot.retentionDays,
        });

        if (!unsubscribeUpdates) {
          unsubscribeUpdates = window.api.observability.onUpdate((event) => {
            set((state) => {
              switch (event.type) {
                case 'snapshot':
                  return snapshotState(state, event.snapshot);
                case 'entries': {
                  const nextRecent = state.recentEntries.filter(
                    (entry) =>
                      !event.entries.some(
                        (updatedEntry) => updatedEntry.id === entry.id,
                      ),
                  );
                  nextRecent.unshift(...event.entries);
                  nextRecent.sort(
                    (left, right) =>
                      new Date(right.startedAt).getTime() -
                      new Date(left.startedAt).getTime(),
                  );

                  const nextHistory = mergeEntriesIntoHistory(
                    state.historyEntries,
                    event.entries,
                    state.activeHistoryRequest,
                  );

                  return {
                    recentEntries: nextRecent.slice(0, 200),
                    historyEntries: nextHistory,
                    transcriptCache: invalidateTranscriptCache(
                      state.transcriptCache,
                      event.entries,
                    ),
                    transcriptCacheVersion: state.transcriptCacheVersion + 1,
                    usageTimeseriesCache: {},
                    usageTimeseriesVersion: state.usageTimeseriesVersion + 1,
                    usageMetricsCache: {},
                    usageMetricsVersion: state.usageMetricsVersion + 1,
                    usageMetricsViewCache: {},
                    usageMetricsViewVersion: state.usageMetricsViewVersion + 1,
                    usageTabSummaryCache: {},
                    usageTabSummaryVersion: state.usageTabSummaryVersion + 1,
                  };
                }
                case 'usage':
                  return {
                    usage: event.usage,
                    usageMetricsCache: {},
                    usageMetricsVersion: state.usageMetricsVersion + 1,
                    usageMetricsViewCache: {},
                    usageMetricsViewVersion: state.usageMetricsViewVersion + 1,
                    usageTabSummaryCache: {},
                    usageTabSummaryVersion: state.usageTabSummaryVersion + 1,
                  };
                case 'retention':
                  return {
                    retentionDays: event.retentionDays,
                    usageTimeseriesCache: {},
                    usageTimeseriesVersion: state.usageTimeseriesVersion + 1,
                    usageMetricsCache: {},
                    usageMetricsVersion: state.usageMetricsVersion + 1,
                    usageMetricsViewCache: {},
                    usageMetricsViewVersion: state.usageMetricsViewVersion + 1,
                    usageTabSummaryCache: {},
                    usageTabSummaryVersion: state.usageTabSummaryVersion + 1,
                  };
              }
            });
          });
        }
      } catch (error) {
        set({ initialized: false });
        throw error;
      } finally {
        initializePromise = null;
      }
    })();

    return initializePromise;
  },

  refreshProviderUsage: async (provider: AgentProviderType): Promise<void> => {
    if (get().refreshingProviders.has(provider)) {
      return;
    }
    const adding = new Set(Array.from(get().refreshingProviders));
    adding.add(provider);
    set({ refreshingProviders: adding });
    try {
      await window.api.observability.refreshUsage(provider);
    } finally {
      const next = new Set(get().refreshingProviders);
      next.delete(provider);
      set({ refreshingProviders: next });
    }
  },

  applySnapshot: (snapshot): void => {
    set((state) => snapshotState(state, snapshot));
  },

  clearEntryCaches: (): void => {
    set((state) => clearEntryCaches(state));
  },

  refreshProviderUsageDetails: async (
    provider: AgentProviderType,
  ): Promise<AgentUsageOverview> => {
    const existing = refreshProviderUsageDetailsPromises.get(provider);
    if (existing) {
      return existing;
    }

    const adding = new Set(Array.from(get().refreshingProviders));
    adding.add(provider);
    set((state) => ({
      refreshingProviders: adding,
      ...invalidateUsageDetailCaches(state),
    }));

    const refreshPromise = (async (): Promise<AgentUsageOverview> => {
      await window.api.observability.refreshUsage(provider);
      const snapshot = await window.api.observability.loadSnapshot();
      set((state) => ({
        usage: snapshot.usage,
        ...invalidateUsageDetailCaches(state),
      }));
      return snapshot.usage;
    })();
    refreshProviderUsageDetailsPromises.set(provider, refreshPromise);

    try {
      return await refreshPromise;
    } finally {
      refreshProviderUsageDetailsPromises.delete(provider);
      const next = new Set(get().refreshingProviders);
      next.delete(provider);
      set({ refreshingProviders: next });
    }
  },

  refreshProviderUsageSnapshot: async (
    provider: AgentProviderType,
  ): Promise<AgentUsageOverview> => {
    await window.api.observability.refreshUsage(provider);
    const snapshot = await window.api.observability.loadSnapshot();
    set((state) => ({
      usage: snapshot.usage,
      ...invalidateUsageDetailCaches(state),
    }));
    return snapshot.usage;
  },

  refreshHistory: async (request?: AgentAuditHistoryRequest): Promise<void> => {
    const resolvedRequest = { limit: 50, ...(request ?? {}) };
    const requestSequence = ++historyRequestSequence;
    set({ loadingHistory: true, activeHistoryRequest: resolvedRequest });
    try {
      const response =
        await window.api.observability.loadHistory(resolvedRequest);
      if (requestSequence !== historyRequestSequence) return;
      set((state) => ({
        historyEntries: response.entries,
        nextCursor: response.nextCursor,
        transcriptCache: invalidateTranscriptCache(
          state.transcriptCache,
          response.entries,
        ),
        transcriptCacheVersion: state.transcriptCacheVersion + 1,
      }));
    } finally {
      if (requestSequence === historyRequestSequence) {
        set({ loadingHistory: false });
      }
    }
  },

  loadMoreHistory: async (
    request?: AgentAuditHistoryRequest,
  ): Promise<void> => {
    const cursor = get().nextCursor;
    if (get().loadingHistory || !cursor) {
      return;
    }
    const requestSequence = ++historyRequestSequence;
    set({ loadingHistory: true });
    try {
      const response = await window.api.observability.loadHistory({
        limit: 50,
        ...(request ?? {}),
        cursor,
      });
      if (requestSequence !== historyRequestSequence) return;
      set((state) => ({
        historyEntries: [...state.historyEntries, ...response.entries],
        nextCursor: response.nextCursor,
        transcriptCache: invalidateTranscriptCache(
          state.transcriptCache,
          response.entries,
        ),
        transcriptCacheVersion: state.transcriptCacheVersion + 1,
      }));
    } finally {
      if (requestSequence === historyRequestSequence) {
        set({ loadingHistory: false });
      }
    }
  },

  loadTranscript: async (
    entry: AgentAuditEntry,
  ): Promise<AgentAuditTranscriptResponse> => {
    if (!entry.hasTranscript) {
      return { type: 'not_available' };
    }
    const request = buildTranscriptRequest(entry);

    const cached = get().transcriptCache[entry.id];
    const now = Date.now();
    const cacheIsFresh =
      cached !== undefined &&
      (entry.status !== 'running' ||
        now - cached.loadedAt < RUNNING_TRANSCRIPT_CACHE_TTL_MS);

    if (cacheIsFresh) {
      return cached.response;
    }

    const transcriptCacheVersion = get().transcriptCacheVersion;
    const response = await window.api.observability.loadTranscript(request);
    set((state) => {
      if (state.transcriptCacheVersion !== transcriptCacheVersion) return {};
      return {
        transcriptCache: {
          ...state.transcriptCache,
          [entry.id]: {
            response,
            loadedAt: now,
          },
        },
      };
    });
    return response;
  },

  loadUsageMetrics: async (
    request: UsageMetricsRequest,
  ): Promise<UsageMetricsResponse> => {
    const cacheKey = usageMetricsCacheKey(request);
    const cached = get().usageMetricsCache[cacheKey];
    if (cached) {
      return cached.response;
    }

    const cacheVersion = get().usageMetricsVersion;
    set({ loadingUsageMetrics: true, usageMetricsError: null });
    try {
      const response = await window.api.observability.loadUsageMetrics(request);
      set((state) => {
        if (state.usageMetricsVersion !== cacheVersion) {
          return { loadingUsageMetrics: false };
        }
        return {
          loadingUsageMetrics: false,
          usageMetricsCache: {
            ...state.usageMetricsCache,
            [cacheKey]: {
              request,
              response,
              loadedAt: Date.now(),
            },
          },
        };
      });
      return response;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load usage metrics';
      set({
        loadingUsageMetrics: false,
        usageMetricsError: message,
      });
      throw error;
    }
  },

  loadUsageTimeseries: async (
    request: UsageTimeseriesRequest,
  ): Promise<UsageTimeseriesResponse> => {
    const cacheKey = usageTimeseriesCacheKey(request);
    const cached = get().usageTimeseriesCache[cacheKey];
    if (cached) {
      return cached.response;
    }

    const cacheVersion = get().usageTimeseriesVersion;
    set((state) => ({
      usageTimeseriesPendingRequests: state.usageTimeseriesPendingRequests + 1,
      loadingUsageTimeseries: true,
    }));
    try {
      const response =
        await window.api.observability.loadUsageTimeseries(request);
      set((state) => {
        if (state.usageTimeseriesVersion !== cacheVersion) {
          return {};
        }

        return {
          usageTimeseriesCache: {
            ...state.usageTimeseriesCache,
            [cacheKey]: {
              request,
              response,
              loadedAt: Date.now(),
            },
          },
        };
      });
      return response;
    } finally {
      set((state) => {
        const pendingRequests = Math.max(
          0,
          state.usageTimeseriesPendingRequests - 1,
        );
        return {
          usageTimeseriesPendingRequests: pendingRequests,
          loadingUsageTimeseries: pendingRequests > 0,
        };
      });
    }
  },

  loadUsageMetricsView: async (
    request: UsageMetricsViewRequest,
  ): Promise<UsageMetricsViewResponse> => {
    const cacheKey = usageMetricsViewCacheKey(request);
    const cached = get().usageMetricsViewCache[cacheKey];
    if (cached) return cached.response;
    const cacheVersion = get().usageMetricsViewVersion;
    const response =
      await window.api.observability.loadUsageMetricsView(request);
    set((state) => {
      if (state.usageMetricsViewVersion !== cacheVersion) return {};
      return {
        usageMetricsViewCache: {
          ...state.usageMetricsViewCache,
          [cacheKey]: { request, response, loadedAt: Date.now() },
        },
      };
    });
    return response;
  },

  loadUsageTabSummary: async (
    request: UsageTabSummaryRequest,
  ): Promise<UsageTabSummaryResponse> => {
    const cacheKey = usageTabSummaryCacheKey(request);
    const cached = get().usageTabSummaryCache[cacheKey];
    if (cached) return cached.response;
    const cacheVersion = get().usageTabSummaryVersion;
    const response =
      await window.api.observability.loadUsageTabSummary(request);
    set((state) => {
      if (state.usageTabSummaryVersion !== cacheVersion) return {};
      return {
        usageTabSummaryCache: {
          ...state.usageTabSummaryCache,
          [cacheKey]: { request, response, loadedAt: Date.now() },
        },
      };
    });
    return response;
  },
}));
