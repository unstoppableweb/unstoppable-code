import type { SharedImportPort } from './port';
import type {
  MarketplaceInfo,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import { isBuiltInPluginMarketplaceId } from '@canopy/execution-engine/types/plugins';
import {
  normalizeGitHubRepoRef,
  type ShareablePluginSource,
} from '@canopy/execution-engine/plugin-refs';
import { parseGitHubRepo } from '../github-repo';

export interface ImportedSharedPluginRef {
  marketplaceId: string;
  pluginName: string;
  /**
   * Whether this import made the plugin available: it added the marketplace
   * or ran the plugin's install. False when both were already in place.
   */
  installed: boolean;
}

function isAlreadyAddedError(message: string | undefined): boolean {
  return (message ?? '').toLowerCase().includes('already');
}

export function findMarketplaceByRepo(
  cache: PluginsCache | null | undefined,
  repo: string,
): MarketplaceInfo | null {
  if (!cache) return null;
  let target: string;
  try {
    target = normalizeGitHubRepoRef(repo);
  } catch {
    return null;
  }
  for (const marketplace of cache.marketplaces) {
    const parsedRepo = parseGitHubRepo(marketplace.sourceUrl);
    if (!parsedRepo) continue;
    try {
      if (normalizeGitHubRepoRef(parsedRepo) === target) {
        return marketplace;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Locate the built-in (bundled) marketplace inside a plugins cache. The
 * built-in marketplace always exists locally, so importers match it directly
 * instead of registering a new GitHub marketplace.
 */
export function findBuiltInMarketplace(
  cache: PluginsCache | null | undefined,
): MarketplaceInfo | null {
  if (!cache) return null;
  return (
    cache.marketplaces.find(
      (marketplace) =>
        marketplace.builtIn === true ||
        isBuiltInPluginMarketplaceId(marketplace.id),
    ) ?? null
  );
}

function findPlugin(
  marketplace: MarketplaceInfo,
  pluginName: string,
): MarketplaceInfo['plugins'][number] | null {
  const normalizedName = pluginName.trim().toLowerCase();
  return (
    marketplace.plugins.find(
      (plugin) => plugin.name.trim().toLowerCase() === normalizedName,
    ) ?? null
  );
}

/**
 * Resolve a shared marketplace-plugin ref into a locally importable reference.
 *
 * Built-in marketplace refs resolve against the bundled catalog directly — the
 * built-in marketplace can never be added or removed, so `addMarketplace` is
 * never called for them. GitHub-backed refs register and refresh the
 * marketplace as needed before resolving.
 */
export async function importSharedMarketplacePlugin(
  port: SharedImportPort,
  marketplace: ShareablePluginSource,
  pluginName: string,
  options: { onProgress?: (label: string) => void } = {},
): Promise<ImportedSharedPluginRef> {
  if (marketplace.type === 'builtin') {
    return importBuiltInMarketplacePlugin(port, pluginName, options);
  }
  return importGitHubMarketplacePlugin(
    port,
    marketplace.repo,
    pluginName,
    options,
  );
}

/**
 * Match a built-in plugin against the local catalog. Never adds a marketplace;
 * the built-in marketplace is bundled and always present. A refresh is
 * attempted once if the plugin is not visible in the initial cache.
 */
async function importBuiltInMarketplacePlugin(
  port: SharedImportPort,
  pluginName: string,
  options: { onProgress?: (label: string) => void },
): Promise<ImportedSharedPluginRef> {
  options.onProgress?.('Locating built-in plugin…');
  const initial = await port.plugins.loadMarketplaces();
  if (!initial.success || !initial.data) {
    throw new Error(initial.error ?? 'Failed to load marketplaces.');
  }

  let cache: PluginsCache = initial.data;
  let marketplace = findBuiltInMarketplace(cache);
  let plugin = marketplace ? findPlugin(marketplace, pluginName) : null;

  if (!marketplace || !plugin) {
    // Recovery refresh: the built-in marketplace or the plugin is absent from
    // the cache and the next step throws if it still is, so force the provider
    // update past the 24h TTL rather than failing on a stale checkout.
    const refreshed = await port.plugins.refreshMarketplaces('always');
    if (!refreshed.success || !refreshed.data) {
      throw new Error(
        refreshed.error ?? 'Failed to refresh the built-in marketplace.',
      );
    }
    cache = refreshed.data;
    marketplace = findBuiltInMarketplace(cache);
    plugin = marketplace ? findPlugin(marketplace, pluginName) : null;
  }

  if (!marketplace || !plugin) {
    throw new Error(
      `Built-in plugin "${pluginName}" was not found in the local catalog.`,
    );
  }

  return {
    marketplaceId: marketplace.id,
    pluginName: plugin.name,
    // The built-in marketplace is bundled; matching it installs nothing.
    installed: false,
  };
}

async function importGitHubMarketplacePlugin(
  port: SharedImportPort,
  repo: string,
  pluginName: string,
  options: { onProgress?: (label: string) => void },
): Promise<ImportedSharedPluginRef> {
  const initial = await port.plugins.loadMarketplaces();
  if (!initial.success || !initial.data) {
    throw new Error(initial.error ?? 'Failed to load marketplaces.');
  }

  let marketplace = findMarketplaceByRepo(initial.data, repo);
  let cache = initial.data;
  let installed = false;
  if (!marketplace) {
    options.onProgress?.('Adding marketplace…');
    const addResult = await port.plugins.addMarketplace(repo);
    // A plugin hosted in the marketplace itself is available once it is added.
    // Adding counts even if the plugin was installed under another marketplace.
    installed = addResult.success;
    if (!addResult.success && !isAlreadyAddedError(addResult.error)) {
      throw new Error(
        addResult.error ?? `Failed to add marketplace "${repo}".`,
      );
    }
    const refreshed = await port.plugins.refreshMarketplaces();
    if (!refreshed.success || !refreshed.data) {
      throw new Error(
        refreshed.error ??
          `Failed to refresh marketplaces after adding "${repo}".`,
      );
    }
    cache = refreshed.data;
    marketplace = findMarketplaceByRepo(cache, repo);
  }

  if (!marketplace) {
    throw new Error(`Marketplace "${repo}" did not appear after registration.`);
  }

  let plugin = findPlugin(marketplace, pluginName);
  if (!plugin) {
    // Same recovery contract as above: force the provider update so an
    // upstream manifest change is visible instead of hard-failing.
    const refreshed = await port.plugins.refreshMarketplaces('always');
    if (!refreshed.success || !refreshed.data) {
      throw new Error(
        refreshed.error ?? `Failed to refresh marketplace "${repo}".`,
      );
    }
    cache = refreshed.data;
    marketplace = findMarketplaceByRepo(cache, repo);
    plugin = marketplace ? findPlugin(marketplace, pluginName) : null;
  }

  if (!marketplace || !plugin) {
    throw new Error(`Plugin "${pluginName}" was not found in "${repo}".`);
  }

  if (plugin.externalSource?.url) {
    options.onProgress?.('Installing plugins…');
    const installResult = await port.plugins.installPlugin(
      marketplace.id,
      plugin.name,
      plugin.externalSource.url,
    );
    if (!installResult.success) {
      throw new Error(
        installResult.error ?? `Failed to install plugin "${plugin.name}".`,
      );
    }
    installed = true;
  }

  return {
    marketplaceId: marketplace.id,
    pluginName: plugin.name,
    installed,
  };
}
