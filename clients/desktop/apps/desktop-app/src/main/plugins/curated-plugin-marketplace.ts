/**
 * Curated plugin marketplace scan + merge (desktop main only).
 *
 * The curated sync engine (`curated-plugin-sync.ts`) materializes the curated
 * catalog into a harness-native marketplace under
 * `getCuratedPluginsMarketplaceDir()`, using the SAME relative manifest
 * locations as the bundled built-in marketplace. This module turns that tree
 * into a `MarketplaceInfo` row so the curated marketplace can sit next to the
 * built-in row in `PluginsCache`.
 *
 * ## Why the scan primitives are injected
 *
 * The facet readers, the provider-status builder, the facet merger, and the
 * managed-plugin install-status readers all live in `plugin-service.ts`, which
 * imports THIS module (for the merge/install wiring). Importing them back
 * would create a module cycle, and `plugin-service.ts` is deliberately a hub
 * that only imports leaves. So the primitives are passed in as
 * {@link CuratedMarketplaceScanDeps}: this module owns curated policy (paths,
 * manifests, identity, empty-state rules, memoization, merge position) and
 * borrows the shared scanning behavior instead of duplicating it.
 *
 * ## Empty-state contract (from the sync engine)
 *
 * A curated marketplace with no usable plugins produces NO row at all — not a
 * zero-plugin row. The first-ever sync of an empty catalog writes nothing to
 * disk, so "manifest absent" and "manifest present with zero plugins" must be
 * indistinguishable to the user.
 */
import * as path from 'path';
import { BRAND } from '@canopy/brand/current';
import {
  CURATED_PLUGIN_MARKETPLACE_ID,
  CURATED_PLUGIN_MARKETPLACE_SOURCE_URL,
  type MarketplaceInfo,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type MarketplaceProviderStatus,
  type PluginInfo,
  type PluginProvider,
  type PluginProviderFacet,
} from '@canopy/execution-engine/types/plugins';
import { safeReadJson } from '../lib/fs-utils';
import { withCuratedPluginDisplay } from './curated-plugin-display';
import {
  getCuratedPluginsMarketplaceDir,
  getCuratedPluginsSyncLockFilePath,
} from '../lib/paths';
import {
  getCuratedPluginMarketplaceName,
  recoverCuratedPluginPromotions,
} from './curated-plugin-sync';

/**
 * One entry of the generated `.agents/plugins/marketplace.json`. Structurally
 * identical to the Codex marketplace entry `plugin-service.ts` parses for the
 * bundled marketplace; the compiler enforces that through the
 * {@link CuratedMarketplaceScanDeps.readCodexFacets} adapter.
 */
export interface CuratedCodexMarketplacePluginEntry {
  tryNowPrompt?: string;
  name?: string;
  source?: { source?: string; path?: string } | string;
  category?: string;
}

/** Generated `.agents/plugins/marketplace.json`. */
interface CuratedCodexMarketplaceManifest {
  name?: string;
  interface?: { displayName?: string };
  plugins?: CuratedCodexMarketplacePluginEntry[];
}

/**
 * Scan primitives owned by `plugin-service.ts`. See the module doc for why
 * they are injected rather than imported.
 */
export interface CuratedMarketplaceScanDeps {
  /** Claude-native facets for the manifest's plugin entries, nulls dropped. */
  readClaudeFacets(input: {
    marketplaceId: string;
    marketplaceInstallDir: string;
    pluginEntries: MarketplacePluginEntry[];
  }): PluginProviderFacet[];
  /** Codex-native facets for local (path-sourced) entries, nulls dropped. */
  readCodexFacets(input: {
    marketplaceRoot: string;
    marketplacePath: string;
    pluginEntries: CuratedCodexMarketplacePluginEntry[];
  }): PluginProviderFacet[];
  /** Cross-provider facet merge (one row per plugin name). */
  mergeProviderPluginFacets(input: {
    marketplaceId: string;
    claudePlugins: PluginProviderFacet[];
    codexPlugins: PluginProviderFacet[];
  }): PluginInfo[];
  /** Normalized per-provider marketplace status. */
  providerStatus(
    provider: PluginProvider,
    input: Partial<MarketplaceProviderStatus>,
  ): MarketplaceProviderStatus;
  /**
   * Returns the same plugins with `globalInstallStatus` populated from the
   * providers, keyed on `<plugin>@<marketplaceName>`.
   */
  readInstallStatuses(input: {
    plugins: PluginInfo[];
    marketplaceName: string;
  }): Promise<PluginInfo[]>;
}

/**
 * Same memo policy as the built-in marketplace scan: the curated tree only
 * changes when the sync engine commits, but scanning it reads the manifests
 * plus every plugin facet from disk, and the scan sits on the same
 * marketplace-load path. Sync commits invalidate the memo explicitly through
 * {@link invalidateCuratedMarketplaceScanCache}, so the TTL only bounds
 * out-of-band edits.
 */
const CURATED_MARKETPLACE_SCAN_TTL_MS = 30_000;
let curatedMarketplaceScanCache: {
  scannedAt: number;
  marketplace: MarketplaceInfo | null;
} | null = null;

/**
 * Drops the memoized curated scan. Callers must use this after anything that
 * changes the materialized tree (a `'synced'` sync result) or the providers'
 * install state (a curated plugin install).
 */
export function invalidateCuratedMarketplaceScanCache(): void {
  curatedMarketplaceScanCache = null;
}

/** Display name of the curated marketplace row. */
function getCuratedMarketplaceDisplayName(): string {
  return `${BRAND.displayName} Curated Marketplace`;
}

function getCuratedClaudeManifestPath(root: string): string {
  return path.join(root, '.claude-plugin', 'marketplace.json');
}

function getCuratedCodexManifestPath(root: string): string {
  return path.join(root, '.agents', 'plugins', 'marketplace.json');
}

/** Minimal shape read from the sync lock file; see `curated-plugin-sync.ts`. */
interface CuratedPluginsSyncLockSummary {
  syncedAt?: unknown;
}

/**
 * The curated row's `lastUpdated` should reflect when the sync engine last
 * committed a change, not when this scan happened to run. Falls back to scan
 * time when the lock is absent or corrupt (e.g. before the first sync).
 */
function readCuratedSyncedAt(): string {
  const lock = safeReadJson<CuratedPluginsSyncLockSummary>(
    getCuratedPluginsSyncLockFilePath(),
  );
  if (lock && typeof lock.syncedAt === 'string' && lock.syncedAt.length > 0) {
    return lock.syncedAt;
  }
  return new Date().toISOString();
}

/**
 * Scans the materialized curated marketplace. Returns `null` when there is no
 * curated marketplace to show (see the module doc's empty-state contract).
 */
export async function scanCuratedMarketplace(
  deps: CuratedMarketplaceScanDeps,
): Promise<MarketplaceInfo | null> {
  await recoverCuratedPluginPromotions();
  if (
    curatedMarketplaceScanCache &&
    Date.now() - curatedMarketplaceScanCache.scannedAt <
      CURATED_MARKETPLACE_SCAN_TTL_MS
  ) {
    // Clone so downstream merge/overlay steps can never mutate the cache.
    return structuredClone(curatedMarketplaceScanCache.marketplace);
  }
  const marketplace = await scanCuratedMarketplaceUncached(deps);
  curatedMarketplaceScanCache = { scannedAt: Date.now(), marketplace };
  return structuredClone(marketplace);
}

async function scanCuratedMarketplaceUncached(
  deps: CuratedMarketplaceScanDeps,
): Promise<MarketplaceInfo | null> {
  const root = getCuratedPluginsMarketplaceDir();
  const claudeManifestPath = getCuratedClaudeManifestPath(root);
  const codexManifestPath = getCuratedCodexManifestPath(root);
  const claudeManifest = safeReadJson<MarketplaceManifest>(claudeManifestPath);
  const codexManifest =
    safeReadJson<CuratedCodexMarketplaceManifest>(codexManifestPath);
  const claudeEntries =
    claudeManifest && Array.isArray(claudeManifest.plugins)
      ? claudeManifest.plugins
      : [];
  const codexEntries =
    codexManifest && Array.isArray(codexManifest.plugins)
      ? codexManifest.plugins
      : [];
  if (claudeEntries.length === 0 && codexEntries.length === 0) {
    return null;
  }

  const claudeFacets = deps.readClaudeFacets({
    marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
    marketplaceInstallDir: root,
    pluginEntries: claudeEntries,
  });
  const codexFacets = deps.readCodexFacets({
    marketplaceRoot: root,
    marketplacePath: codexManifestPath,
    pluginEntries: codexEntries,
  });
  const merged = deps.mergeProviderPluginFacets({
    marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
    claudePlugins: claudeFacets,
    codexPlugins: codexFacets,
  });
  if (merged.length === 0) {
    // The manifests name plugins but nothing usable is materialized (a
    // half-written or externally damaged tree). The next sync re-materializes
    // it; surfacing an empty curated row in the meantime would contradict the
    // empty-state contract.
    return null;
  }

  const marketplaceName = getCuratedPluginMarketplaceName();
  const recommendedPluginNames = new Set(
    claudeEntries
      .filter(
        (entry) =>
          typeof entry?.name === 'string' && entry.recommended === true,
      )
      .map((entry) => entry.name.toLowerCase()),
  );
  const tryNowPrompts = new Map(
    [...codexEntries, ...claudeEntries].flatMap((entry) =>
      typeof entry?.name === 'string' && typeof entry.tryNowPrompt === 'string'
        ? [[entry.name.toLowerCase(), entry.tryNowPrompt] as const]
        : [],
    ),
  );
  const plugins: PluginInfo[] = (
    await deps.readInstallStatuses({ plugins: merged, marketplaceName })
  ).map((plugin) => ({
    ...plugin,
    curated: true,
    ...(tryNowPrompts.has(plugin.name.toLowerCase())
      ? { tryNowPrompt: tryNowPrompts.get(plugin.name.toLowerCase()) }
      : {}),
    recommended: recommendedPluginNames.has(plugin.name.toLowerCase()),
  }));

  const claudeStatus = deps.providerStatus('claude', {
    accepted: claudeManifest !== null,
    pluginCount: claudeFacets.length,
    marketplaceName:
      typeof claudeManifest?.name === 'string'
        ? claudeManifest.name
        : marketplaceName,
    marketplacePath: claudeManifestPath,
    installLocation: root,
    error:
      claudeManifest !== null && claudeFacets.length === 0
        ? 'No Claude plugins were detected.'
        : undefined,
  });
  const codexStatus = deps.providerStatus('codex', {
    accepted: codexManifest !== null,
    pluginCount: codexFacets.length,
    marketplaceName:
      typeof codexManifest?.name === 'string'
        ? codexManifest.name
        : marketplaceName,
    marketplacePath: codexManifestPath,
    installLocation: root,
    error:
      codexManifest !== null && codexFacets.length === 0
        ? 'No Codex plugins were detected.'
        : undefined,
  });
  const validProviders: PluginProvider[] = [
    ...(claudeStatus.state === 'valid' ? (['claude'] as const) : []),
    ...(codexStatus.state === 'valid' ? (['codex'] as const) : []),
  ];
  return {
    id: CURATED_PLUGIN_MARKETPLACE_ID,
    name: getCuratedMarketplaceDisplayName(),
    description: `Curated plugins synced from the ${BRAND.displayName} catalog.`,
    sourceType: 'curated',
    sourceUrl: CURATED_PLUGIN_MARKETPLACE_SOURCE_URL,
    installLocation: root,
    lastUpdated: readCuratedSyncedAt(),
    builtIn: false,
    curated: true,
    removable: false,
    pluginCount: plugins.length,
    plugins: await Promise.all(plugins.map(withCuratedPluginDisplay)),
    providerStatus: {
      claude: claudeStatus,
      codex: codexStatus,
    },
    validProviders,
  };
}

/**
 * Replaces (or drops) the curated row in a marketplace list. Sibling of
 * `mergeBuiltInMarketplace`, and applied AFTER it, so the managed rows always
 * land in a stable order at the end of the list: `[...external, built-in,
 * curated]`.
 */
export async function mergeCuratedMarketplace(
  marketplaces: MarketplaceInfo[],
  deps: CuratedMarketplaceScanDeps,
): Promise<MarketplaceInfo[]> {
  const scanned = await scanCuratedMarketplace(deps);
  const withoutCurated = marketplaces.filter(
    (marketplace) => marketplace.id !== CURATED_PLUGIN_MARKETPLACE_ID,
  );
  return scanned ? [...withoutCurated, scanned] : withoutCurated;
}
