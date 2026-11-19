import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  CanopyCapabilities,
  CanopyClient,
  MarketplaceSource,
  MarketplaceSourcePlugin,
  MarketplaceSourceProgress,
  MarketplaceSourcesClient,
  MarketplaceSourcesSnapshot,
} from '@canopy/app-core/client';
import { useCanopyClient } from '@canopy/app-state';
import { linkRecordedError, recordedErrorOf } from '@canopy/ui-shared';

import { createMarketplaceSourceOperations } from '@canopy/app-core/client';
import type {
  MarketplaceSourceOperation,
  MarketplaceSourceOperations,
} from '@canopy/app-core/client';
export type { MarketplaceSourceOperation } from '@canopy/app-core/client';

const clientOperations = new WeakMap<
  MarketplaceSourcesClient,
  MarketplaceSourceOperations
>();
const noClientOperations = createMarketplaceSourceOperations();
function operationsFor(
  client: MarketplaceSourcesClient | null,
): MarketplaceSourceOperations {
  if (!client) return noClientOperations;
  if (client.operations) return client.operations;
  let operations = clientOperations.get(client);
  if (!operations) {
    operations = createMarketplaceSourceOperations();
    clientOperations.set(client, operations);
  }
  return operations;
}

export interface MarketplaceSourcesAccess {
  /** Null unless the capability and the client member are both present. */
  readonly client: MarketplaceSourcesClient | null;
  /** True only when the install capability and `installPlugin` are both present. */
  readonly canInstall: boolean;
}

/** Default-deny gate: a missing capability or member never renders controls. */
export function resolveMarketplaceSourcesAccess(
  client: Pick<CanopyClient, 'marketplaceSources'> & {
    readonly capabilities: Pick<
      CanopyCapabilities,
      'marketplaceSources' | 'marketplaceSourcePluginInstall'
    >;
  },
): MarketplaceSourcesAccess {
  const sources = client.marketplaceSources;
  if (client.capabilities.marketplaceSources !== true || !sources) {
    return { client: null, canInstall: false };
  }
  return {
    client: sources,
    canInstall:
      client.capabilities.marketplaceSourcePluginInstall === true &&
      typeof sources.installPlugin === 'function',
  };
}

export function useMarketplaceSourcesAccess(): MarketplaceSourcesAccess {
  const client = useCanopyClient();
  return resolveMarketplaceSourcesAccess(client);
}

export interface UseMarketplaceSourcesOptions {
  /** Only fetch while a source surface is visible. */
  readonly enabled: boolean;
}

export interface UseMarketplaceSourcesResult {
  readonly sources: readonly MarketplaceSource[] | null;
  readonly lastRefreshedAt: string | null;
  /** True while the first read is in flight and no rows exist yet. */
  readonly loading: boolean;
  readonly refreshing: boolean;
  /** Last list read/refresh failure. Existing rows are kept alongside it. */
  readonly listError: string | null;
  /** Latest unscoped refresh progress; never attributed to a row. */
  readonly listProgress: string | null;
  readonly operations: Readonly<Record<string, MarketplaceSourceOperation>>;
  readonly sourceErrors: Readonly<Record<string, string>>;
  readonly sourceWarnings: Readonly<Record<string, string>>;
  readonly sourceProgress: Readonly<Record<string, string>>;
  /** Source id → plugin key currently installing. */
  readonly installingPlugins: Readonly<Record<string, string>>;
  /** Keyed by {@link marketplaceSourcePluginErrorKey}. */
  readonly pluginErrors: Readonly<Record<string, string>>;
  /**
   * Source and plugin error messages the host already recorded, so the
   * banners showing them record nothing.
   */
  readonly recordedErrors: ReadonlySet<string>;
  readonly canInstall: boolean;
  readonly reload: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly update: (sourceId: string) => Promise<boolean>;
  readonly remove: (sourceId: string) => Promise<boolean>;
  readonly installPlugin: (
    sourceId: string,
    pluginKey: string,
  ) => Promise<boolean | null>;
  readonly dismissSourceMessage: (sourceId: string) => void;
}

export function marketplaceSourcePluginErrorKey(
  sourceId: string,
  pluginKey: string,
): string {
  return JSON.stringify([sourceId, pluginKey]);
}

export function marketplaceSourceErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'Something went wrong. Try again.';
}

function omitKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  if (!(key in record)) return { ...record };
  const next = { ...record };
  delete next[key];
  return next;
}

function replaceSource(
  sources: readonly MarketplaceSource[],
  source: MarketplaceSource,
): MarketplaceSource[] {
  let found = false;
  const next = sources.map((entry) => {
    if (entry.id !== source.id) return entry;
    found = true;
    return source;
  });
  return found ? next : [...next, source];
}

function replacePlugin(
  source: MarketplaceSource,
  plugin: MarketplaceSourcePlugin,
): MarketplaceSource {
  return {
    ...source,
    plugins: source.plugins.map((entry) =>
      entry.key === plugin.key ? plugin : entry,
    ),
  };
}

/**
 * List/detail state for marketplace sources. Responses that started before a
 * newer read, a mutation, or a client change are discarded, so a slow read
 * cannot resurrect a removed row or overwrite a freshly installed plugin.
 */
export function useMarketplaceSources(
  access: MarketplaceSourcesAccess,
  { enabled }: UseMarketplaceSourcesOptions,
): UseMarketplaceSourcesResult {
  const { client, canInstall } = access;
  const active = enabled && client !== null;
  const [snapshot, setSnapshot] = useState<MarketplaceSourcesSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(active);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listProgress, setListProgress] = useState<string | null>(null);
  const operationStore = operationsFor(client);
  const operationSnapshot = useSyncExternalStore(
    operationStore.subscribe,
    operationStore.getSnapshot,
    operationStore.getSnapshot,
  );
  const operations = operationSnapshot.operations;
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [sourceWarnings, setSourceWarnings] = useState<Record<string, string>>(
    {},
  );
  const [sourceProgress, setSourceProgress] = useState<Record<string, string>>(
    {},
  );
  // Rows showing list-refresh progress. The host reports completion only for
  // the whole refresh, so these rows are cleared when the refresh ends.
  const refreshProgressIdsRef = useRef(new Set<string>());
  const clearRefreshProgress = useCallback(() => {
    const ids = refreshProgressIdsRef.current;
    if (ids.size === 0) return;
    refreshProgressIdsRef.current = new Set();
    setSourceProgress((prev) => {
      let next = prev;
      for (const id of ids) next = omitKey(next, id);
      return next;
    });
  }, []);
  const [installingPlugins, setInstallingPlugins] = useState<
    Record<string, string>
  >({});
  const [pluginErrors, setPluginErrors] = useState<Record<string, string>>({});
  const [recordedErrors, setRecordedErrors] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const noteRecorded = useCallback((error: unknown): void => {
    if (recordedErrorOf(error) === undefined) return;
    const message = marketplaceSourceErrorMessage(error);
    setRecordedErrors((prev) => new Set(prev).add(message));
  }, []);

  // Every read start bumps `readSeqRef`; every applied mutation and client
  // change bumps `dataRevisionRef`. A read applies only if neither moved.
  const uncertainRef = useRef(new Set<string>());
  const deferredReadRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const lifecycleRef = useRef(0);
  const refreshRef = useRef(false);
  const readSeqRef = useRef(0);
  const dataRevisionRef = useRef(0);
  const clientRef = useRef(client);
  const activeRef = useRef(active);
  activeRef.current = active;
  const operationsRef = useRef(operations);
  operationsRef.current = operations;

  const isCurrent = useCallback(
    (target: MarketplaceSourcesClient): boolean =>
      activeRef.current && clientRef.current === target,
    [],
  );

  const read = useCallback(
    async (mode: 'list' | 'refresh', reconcile = false): Promise<void> => {
      const target = clientRef.current;
      if (!target || !activeRef.current) return;
      if (
        !reconcile &&
        (refreshRef.current || Object.keys(operationsRef.current).length > 0)
      )
        return;
      const lifecycle = lifecycleRef.current;
      readSeqRef.current += 1;
      const seq = readSeqRef.current;
      const revision = dataRevisionRef.current;
      const latest = (): boolean =>
        isCurrent(target) &&
        lifecycleRef.current === lifecycle &&
        readSeqRef.current === seq;
      const releaseRefresh =
        mode === 'refresh'
          ? operationsFor(target).acquire(null, 'update')
          : undefined;
      if (releaseRefresh === null) return;
      if (mode === 'refresh') {
        refreshRef.current = true;
        setRefreshing(true);
      }
      try {
        const next =
          mode === 'refresh'
            ? await target.refreshAll()
            : ((!reconcile ? target.cachedSnapshot?.() : null) ??
              (await target.list()));
        if (!latest() || dataRevisionRef.current !== revision) return;
        snapshotRef.current = next;
        uncertainRef.current.clear();
        setSnapshot(next);
        setListError(null);
      } catch (error) {
        if (!latest()) return;
        setListError(marketplaceSourceErrorMessage(error));
      } finally {
        releaseRefresh?.();
        if (latest()) {
          setLoading(false);
          refreshRef.current = false;
          setRefreshing(false);
          setListProgress(null);
          if (mode === 'refresh') clearRefreshProgress();
        }
      }
    },
    [clearRefreshProgress, isCurrent],
  );

  const reload = useCallback(() => read('list', true), [read]);
  const refresh = useCallback(() => read('refresh'), [read]);

  useEffect(() => {
    lifecycleRef.current += 1;
    activeRef.current = active;
    refreshRef.current = false;
    uncertainRef.current.clear();
    clientRef.current = client;
    readSeqRef.current += 1;
    dataRevisionRef.current += 1;
    setSnapshot(null);
    setListError(null);
    setListProgress(null);
    setRefreshing(false);
    setSourceErrors({});
    setSourceWarnings({});
    setSourceProgress({});
    refreshProgressIdsRef.current = new Set();
    setInstallingPlugins({});
    setPluginErrors({});
    setLoading(active);
    if (!active || !client) return;
    deferredReadRef.current =
      Object.keys(operationsFor(client).getSnapshot().operations).length > 0 ||
      operationsFor(client).getSnapshot().refreshing;
    void read('list');
    const lifecycle = lifecycleRef.current;
    const live = (): boolean =>
      isCurrent(client) && lifecycleRef.current === lifecycle;
    const unsubscribeSnapshot = client.subscribeSnapshot?.((next) => {
      if (!live()) return;
      dataRevisionRef.current += 1;
      setSnapshot(next);
    });
    const unsubscribe = client.subscribeProgress?.(
      (progress: MarketplaceSourceProgress) => {
        if (!live()) return;
        if (progress.sourceId === undefined) {
          if (progress.operation === 'refresh') {
            setListProgress(
              progress.status === 'running' ? progress.message : null,
            );
            if (progress.status !== 'running') clearRefreshProgress();
          }
          return;
        }
        const sourceId = progress.sourceId;
        if (progress.operation === 'refresh' && progress.status === 'running')
          refreshProgressIdsRef.current.add(sourceId);
        else refreshProgressIdsRef.current.delete(sourceId);
        setSourceProgress((prev) =>
          progress.status === 'running'
            ? { ...prev, [sourceId]: progress.message }
            : omitKey(prev, sourceId),
        );
      },
    );
    return (): void => {
      activeRef.current = false;
      lifecycleRef.current += 1;
      unsubscribeSnapshot?.();
      unsubscribe?.();
      readSeqRef.current += 1;
      dataRevisionRef.current += 1;
    };
  }, [active, client, clearRefreshProgress, isCurrent, read]);

  useEffect(() => {
    if (
      active &&
      deferredReadRef.current &&
      !operationSnapshot.refreshing &&
      Object.keys(operations).length === 0
    ) {
      deferredReadRef.current = false;
      void read('list', true);
    }
  }, [active, operationSnapshot.refreshing, operations, read]);

  const applySource = useCallback((source: MarketplaceSource) => {
    dataRevisionRef.current += 1;
    setSnapshot((prev) =>
      prev ? { ...prev, sources: replaceSource(prev.sources, source) } : prev,
    );
  }, []);

  const runSourceOperation = useCallback(
    async (
      sourceId: string,
      operation: MarketplaceSourceOperation,
      run: (
        target: MarketplaceSourcesClient,
        current: () => boolean,
      ) => Promise<void>,
    ): Promise<boolean> => {
      const target = clientRef.current;
      if (!target || !activeRef.current) return false;
      if (
        operationsRef.current[sourceId] !== undefined ||
        refreshRef.current ||
        uncertainRef.current.has(sourceId)
      )
        return false;
      const lifecycle = lifecycleRef.current;
      const current = (): boolean =>
        isCurrent(target) && lifecycleRef.current === lifecycle;
      const release = operationsFor(target).acquire(sourceId, operation);
      if (!release) return false;
      dataRevisionRef.current += 1;
      operationsRef.current = operationsFor(target).getSnapshot().operations;
      setSourceErrors((prev) => omitKey(prev, sourceId));
      setSourceWarnings((prev) => omitKey(prev, sourceId));
      try {
        await run(target, current);
        return true;
      } catch (error) {
        if (current()) {
          // A failure the host recorded is linked to this session, and its
          // banners record nothing.
          linkRecordedError(error, 'marketplace-source-operation');
          noteRecorded(error);
          setSourceErrors((prev) => ({
            ...prev,
            [sourceId]: marketplaceSourceErrorMessage(error),
          }));
          uncertainRef.current.add(sourceId);
          // The outcome may be uncertain; show authoritative state before retry.
          await read('list', true);
        }
        return false;
      } finally {
        release();
        if (clientRef.current === target)
          operationsRef.current =
            operationsFor(target).getSnapshot().operations;
        if (current()) {
          setSourceProgress((prev) => omitKey(prev, sourceId));
        }
      }
    },
    [isCurrent, read],
  );

  const update = useCallback(
    (sourceId: string) =>
      runSourceOperation(sourceId, 'update', async (target, current) => {
        const source = await target.update(sourceId);
        if (!current()) return;
        applySource(source);
        await read('list', true);
      }),
    [applySource, read, runSourceOperation],
  );

  const remove = useCallback(
    (sourceId: string) =>
      runSourceOperation(sourceId, 'remove', async (target, current) => {
        const result = await target.remove(sourceId);
        if (!current()) return;
        if (result.removed) {
          dataRevisionRef.current += 1;
          setSnapshot((prev) =>
            prev
              ? {
                  ...prev,
                  sources: prev.sources.filter(
                    (entry) => entry.id !== sourceId,
                  ),
                }
              : prev,
          );
        } else {
          applySource(result.source);
          setSourceWarnings((prev) => ({
            ...prev,
            [sourceId]: result.warning,
          }));
        }
        await read('list', true);
      }),
    [applySource, read, runSourceOperation],
  );

  const installPlugin = useCallback(
    async (sourceId: string, pluginKey: string): Promise<boolean | null> => {
      const target = clientRef.current;
      if (uncertainRef.current.has(sourceId)) return null;
      if (
        !canInstall ||
        !target?.installPlugin ||
        !activeRef.current ||
        refreshRef.current ||
        operationsRef.current[sourceId] !== undefined
      )
        return false;
      const lifecycle = lifecycleRef.current;
      const errorKey = marketplaceSourcePluginErrorKey(sourceId, pluginKey);
      setInstallingPlugins((prev) => ({ ...prev, [sourceId]: pluginKey }));
      setPluginErrors((prev) => omitKey(prev, errorKey));
      let installed = false;
      const ran = await runSourceOperation(
        sourceId,
        'install',
        async (t, current) => {
          if (!t.installPlugin) return;
          try {
            const result = await t.installPlugin(sourceId, pluginKey);
            if (!current()) return;
            dataRevisionRef.current += 1;
            setSnapshot((prev) =>
              prev
                ? {
                    ...prev,
                    sources: prev.sources.map((entry) =>
                      entry.id === result.sourceId
                        ? replacePlugin(entry, result.plugin)
                        : entry,
                    ),
                  }
                : prev,
            );
            const failures = Object.values(result.providerOutcomes).filter(
              (outcome) => outcome !== undefined && !outcome.installed,
            );
            installed =
              result.plugin.installState !== undefined &&
              (result.plugin.installState.hasContent ||
                !result.plugin.installState.externalSource);
            const message =
              failures.find((outcome) => outcome?.error)?.error ??
              (failures.length > 0
                ? 'Some providers could not install this plugin.'
                : undefined);
            if (!installed || message) {
              setPluginErrors((prev) => ({
                ...prev,
                [errorKey]:
                  message ?? 'Install finished without plugin content.',
              }));
            }
          } catch (error) {
            if (current()) {
              // Linked once, where the rethrow lands in `runSourceOperation`.
              noteRecorded(error);
              setPluginErrors((prev) => ({
                ...prev,
                [errorKey]: marketplaceSourceErrorMessage(error),
              }));
            }
            throw error;
          }
        },
      );
      if (isCurrent(target) && lifecycleRef.current === lifecycle) {
        setInstallingPlugins((prev) => omitKey(prev, sourceId));
        // Install failures stay on the plugin row, not the source row.
        if (!ran) setSourceErrors((prev) => omitKey(prev, sourceId));
      }
      const reconciled =
        !ran &&
        !uncertainRef.current.has(sourceId) &&
        snapshotRef.current?.sources
          .find((source) => source.id === sourceId)
          ?.plugins.find((plugin) => plugin.key === pluginKey)?.installState;
      if (reconciled) {
        installed = reconciled.hasContent || !reconciled.externalSource;
        if (
          installed &&
          isCurrent(target) &&
          lifecycleRef.current === lifecycle
        )
          setPluginErrors((prev) => omitKey(prev, errorKey));
      }
      if (!ran && uncertainRef.current.has(sourceId)) {
        if (isCurrent(target) && lifecycleRef.current === lifecycle) {
          setPluginErrors((prev) => ({
            ...prev,
            [errorKey]:
              'Install status could not be checked. Refresh status before trying again.',
          }));
        }
        return null;
      }
      return (ran || !!reconciled) && installed;
    },
    [canInstall, isCurrent, runSourceOperation],
  );

  const dismissSourceMessage = useCallback((sourceId: string) => {
    setSourceErrors((prev) => omitKey(prev, sourceId));
    setSourceWarnings((prev) => omitKey(prev, sourceId));
  }, []);

  const usable = active && clientRef.current === client;
  return {
    sources: usable ? (snapshot?.sources ?? null) : null,
    lastRefreshedAt: usable ? (snapshot?.lastRefreshedAt ?? null) : null,
    loading: active && (!usable || (loading && snapshot === null)),
    refreshing: usable && (refreshing || operationSnapshot.refreshing),
    listError: usable ? listError : null,
    listProgress: usable ? listProgress : null,
    operations: usable ? operations : {},
    sourceErrors: usable ? sourceErrors : {},
    sourceWarnings: usable ? sourceWarnings : {},
    sourceProgress: usable ? sourceProgress : {},
    installingPlugins: usable ? installingPlugins : {},
    pluginErrors: usable ? pluginErrors : {},
    recordedErrors,
    canInstall: usable && canInstall,
    reload,
    refresh,
    update,
    remove,
    installPlugin,
    dismissSourceMessage,
  };
}
