import { isE2eBuild } from '../lib/e2e-gate';
import {
  isRealisticStartupPerformanceEnabled,
  recordRealisticStartupPerformanceEvent,
} from '../lib/realistic-startup-performance';
import type { CuratedPluginSyncResult } from '../plugins/curated-plugin-sync';

export const CURATED_MCP_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;

export interface CuratedMcpRefreshDependencies {
  refreshCatalog: () => Promise<unknown>;
  refreshTools: () => Promise<unknown>;
  /**
   * Resolves to `null` when the sync (or its post-sync reaction) failed and
   * was already logged by the plugin service; the scheduler treats that the
   * same as a non-committed sync. Publication/effect invalidation belongs to
   * the plugin service even for null/noop results, not this status.
   */
  syncCuratedPlugins: () => Promise<CuratedPluginSyncResult | null>;
  refreshInvocableInventory: () => Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: CuratedMcpRefreshDependencies = {
  // The scheduler is imported during main-process startup, but it does not run
  // until the renderer unlocks deferred background work. Keep both heavier MCP
  // modules off the pre-window module graph and load them only at that boundary.
  refreshCatalog: async () => {
    const { listCuratedMcpServers } = await import('./curated-catalog');
    return listCuratedMcpServers();
  },
  refreshTools: async () => {
    const { refreshStaleMcpTools } = await import('./tool-discovery');
    return refreshStaleMcpTools();
  },
  // Route the sync through the plugin service rather than calling the sync
  // engine directly, so a scheduler-committed sync gets the exact same
  // post-sync reaction a user-triggered marketplace refresh gets (curated
  // scan-memo invalidation + provider nudges) instead of only the inventory
  // refresh below. Scheduler-committed syncs are the common case at a 6h
  // cadence, and `updateMarketplace` refuses the curated marketplace, so
  // there is no manual heal for a stale curated scan memo. Dynamic import at
  // call time keeps the heavy plugin-service graph off the pre-window module
  // graph; plugin-service does not import this module, so there is no cycle.
  syncCuratedPlugins: async () => {
    const { syncCuratedPluginsForRefresh } =
      await import('../plugins/plugin-service');
    return syncCuratedPluginsForRefresh();
  },
  refreshInvocableInventory: async () => {
    const { refreshInvocableInventoryAfterMutation } =
      await import('../plugins/invocable-inventory-service');
    refreshInvocableInventoryAfterMutation('curated-plugin-sync');
  },
};

/**
 * Run the curated MCP catalog/tools refresh and the curated plugin sync
 * independently, each in its own try/catch, so a failure in one never gates
 * the others: cloud auth failures must never block the local tool refresh,
 * and a curated plugin sync failure must never block (or be blocked by) the
 * MCP catalog/tool phases.
 */
export async function runCuratedMcpRefresh(
  dependencies: CuratedMcpRefreshDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  try {
    await dependencies.refreshCatalog();
  } catch (error) {
    // Background refresh failures are intentionally non-fatal and have no UI.
    // eslint-disable-next-line no-console
    console.warn('[curated-mcp-refresh] catalog refresh failed:', error);
  }
  try {
    await dependencies.refreshTools();
  } catch (error) {
    // Background refresh failures are intentionally non-fatal and have no UI.
    // eslint-disable-next-line no-console
    console.warn('[curated-mcp-refresh] tool refresh failed:', error);
  }
  try {
    const result = await dependencies.syncCuratedPlugins();
    // Additive compatibility notification: the service also invalidates after
    // Codex-copy publication on noop, or partial/uncertain failure.
    if (result?.status === 'synced') {
      try {
        await dependencies.refreshInvocableInventory();
      } catch (error) {
        // Background refresh failures are intentionally non-fatal and have no UI.
        // eslint-disable-next-line no-console
        console.warn(
          '[curated-mcp-refresh] invocable inventory refresh failed:',
          error,
        );
      }
    }
  } catch (error) {
    // Background refresh failures are intentionally non-fatal and have no UI.
    // eslint-disable-next-line no-console
    console.warn('[curated-mcp-refresh] curated plugin sync failed:', error);
  }
}

interface RefreshTimer {
  unref?: () => void;
}

export interface CuratedMcpRefreshStartOptions {
  dependencies?: CuratedMcpRefreshDependencies;
  setIntervalFn?: (callback: () => void, intervalMs: number) => RefreshTimer;
  clearIntervalFn?: (timer: RefreshTimer) => void;
  e2e?: boolean;
}

let activeDisposer: (() => void) | null = null;

/** Start the idempotent, cross-platform curated catalog/tools refresh loop. */
export function startCuratedMcpRefresh(
  options: CuratedMcpRefreshStartOptions = {},
): () => void {
  if (
    (options.e2e ?? isE2eBuild()) &&
    !isRealisticStartupPerformanceEnabled()
  ) {
    return (): void => undefined;
  }
  if (activeDisposer) return activeDisposer;

  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const run = (): void => {
    recordRealisticStartupPerformanceEvent('startup:curated-mcp:started');
    void runCuratedMcpRefresh(dependencies).finally(() => {
      recordRealisticStartupPerformanceEvent('startup:curated-mcp:completed');
    });
  };
  run();

  let timer: RefreshTimer;
  let clearTimer: () => void;
  if (options.setIntervalFn) {
    timer = options.setIntervalFn(run, CURATED_MCP_REFRESH_INTERVAL_MS);
    clearTimer = options.clearIntervalFn
      ? (): void => options.clearIntervalFn?.(timer)
      : (): void => undefined;
  } else {
    const nativeTimer = setInterval(run, CURATED_MCP_REFRESH_INTERVAL_MS);
    timer = nativeTimer;
    clearTimer = (): void => clearInterval(nativeTimer);
  }
  timer.unref?.();

  const dispose = (): void => {
    if (activeDisposer !== dispose) return;
    clearTimer();
    activeDisposer = null;
  };
  activeDisposer = dispose;
  return dispose;
}
