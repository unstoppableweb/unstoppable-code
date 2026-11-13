import type { SharedImportPort } from './port';
import {
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import type {
  MarketplaceInfo,
  PluginInfo,
  PluginProvider,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import type { InstalledSkillInfo } from '../../types/skills';
import { computePluginShareableRef } from '@canopy/execution-engine/plugin-refs';
import { entryIdForSelection } from '../capability-entry-id';
import { pluginNeedsInstall } from '@canopy/protocol/plugins';
import { importSharedMarketplacePlugin } from './shared-plugin-marketplace-import';

export type SharedPluginInstallTarget =
  | { entity: 'skill'; sourceId: string; skillName: string }
  | {
      entity: 'plugin';
      marketplaceId: string;
      pluginName: string;
      entryId: string;
    };

function pluginInstallTarget(
  marketplaceId: string,
  pluginName: string,
  marketplaces: readonly Pick<MarketplaceInfo, 'id' | 'curated'>[] = [],
): SharedPluginInstallTarget {
  return {
    entity: 'plugin',
    marketplaceId,
    pluginName,
    entryId: entryIdForSelection(
      { kind: 'plugin', marketplaceId, pluginName },
      marketplaces,
    ),
  };
}

function equivalentRefKeys(ref: ShareablePluginRef): Set<string> {
  const keys = new Set([getShareablePluginRefKey(ref)]);
  if (ref.type === 'plugin') {
    keys.add(
      getShareablePluginRefKey({
        type: 'claude_plugin',
        marketplace: ref.marketplace,
        plugin_name: ref.plugin_name,
      }),
    );
  } else if (ref.type === 'claude_plugin') {
    keys.add(
      getShareablePluginRefKey({
        type: 'plugin',
        marketplace: ref.marketplace,
        plugin_name: ref.plugin_name,
      }),
    );
  }
  return keys;
}

function installedSkillRef(
  skill: InstalledSkillInfo,
): ShareablePluginRef | null {
  if (!skill.shareableSource || skill.name.trim().length === 0) return null;
  return {
    type: 'skill',
    source: skill.shareableSource,
    skill_name: skill.name.trim(),
  };
}

async function findInstalledSkill(
  port: SharedImportPort,
  ref: Extract<ShareablePluginRef, { type: 'skill' }>,
): Promise<SharedPluginInstallTarget | null> {
  const result = await port.skills.loadSkills();
  if (!result.success || !result.data) return null;
  const targetKey = getShareablePluginRefKey(ref);
  const found = result.data.find((skill) => {
    const candidate = installedSkillRef(skill);
    return candidate
      ? getShareablePluginRefKey(candidate) === targetKey
      : false;
  });
  return found
    ? { entity: 'skill', sourceId: found.sourceId, skillName: found.name }
    : null;
}

interface CatalogPluginMatch {
  marketplace: MarketplaceInfo;
  plugin: PluginInfo;
}

function findPluginInCache(
  ref: Exclude<ShareablePluginRef, { type: 'skill' }>,
  cache: PluginsCache,
): CatalogPluginMatch | null {
  const targetKeys = equivalentRefKeys(ref);
  for (const marketplace of cache.marketplaces) {
    for (const plugin of marketplace.plugins) {
      const candidate = computePluginShareableRef(plugin, marketplace);
      if (candidate && targetKeys.has(getShareablePluginRefKey(candidate))) {
        return { marketplace, plugin };
      }
    }
  }
  return null;
}

function applicableBuiltInProviders(
  ref: Extract<ShareablePluginRef, { type: 'plugin' | 'claude_plugin' }>,
  plugin: PluginInfo,
): PluginProvider[] {
  const requested: PluginProvider[] =
    ref.type === 'claude_plugin' ? ['claude'] : ['claude', 'codex'];
  return requested.filter(
    (provider) => plugin.globalInstallStatus?.[provider]?.available === true,
  );
}

function findInstalledPluginInCache(
  ref: Exclude<ShareablePluginRef, { type: 'skill' }>,
  cache: PluginsCache,
): SharedPluginInstallTarget | null {
  const found = findPluginInCache(ref, cache);
  if (!found) return null;
  const builtInRef =
    ref.type !== 'codex_plugin' && ref.marketplace.type === 'builtin';
  const builtInProviders = builtInRef
    ? applicableBuiltInProviders(ref, found.plugin)
    : [];
  const installed = builtInRef
    ? builtInProviders.length > 0 &&
      builtInProviders.every(
        (provider) =>
          found.plugin.globalInstallStatus?.[provider]?.installed === true,
      )
    : !pluginNeedsInstall(found.plugin);
  return installed
    ? pluginInstallTarget(
        found.marketplace.id,
        found.plugin.name,
        cache.marketplaces,
      )
    : null;
}

async function loadPluginCache(
  port: SharedImportPort,
  cacheOnly = false,
): Promise<PluginsCache | null> {
  const result = cacheOnly
    ? await port.plugins.loadMarketplacesCacheOnly()
    : await port.plugins.loadMarketplaces();
  return result.success && result.data ? result.data : null;
}

export async function findInstalledSharedPluginTarget(
  port: SharedImportPort,
  ref: ShareablePluginRef,
): Promise<SharedPluginInstallTarget | null> {
  if (ref.type === 'skill') return findInstalledSkill(port, ref);
  const cache = await loadPluginCache(port, true);
  return cache ? findInstalledPluginInCache(ref, cache) : null;
}

function findCodexPlugin(
  ref: Extract<ShareablePluginRef, { type: 'codex_plugin' }>,
  marketplaces: MarketplaceInfo[],
): { marketplace: MarketplaceInfo; plugin: PluginInfo } | null {
  const marketplace = marketplaces.find(
    (entry) =>
      entry.id.trim().toLowerCase() === ref.marketplace.id.trim().toLowerCase(),
  );
  const plugin = marketplace?.plugins.find(
    (entry) =>
      entry.name.trim().toLowerCase() === ref.plugin_name.trim().toLowerCase(),
  );
  return marketplace && plugin ? { marketplace, plugin } : null;
}

/** Whether installing a shared ref ran an install or found it in place. */
export type SharedPluginInstallOutcome = 'installed' | 'already-available';

/**
 * Install a pinned portable plugin ref without accepting source URLs from the
 * share. GitHub refs register only their normalized owner/repo marketplace;
 * provider commands resolve the actual source from the local catalog.
 */
export async function installSharedPluginRef(
  port: SharedImportPort,
  ref: ShareablePluginRef,
): Promise<SharedPluginInstallTarget> {
  return (await installSharedPluginRefWithOutcome(port, ref)).target;
}

/**
 * {@link installSharedPluginRef}, also saying whether anything was installed
 * so the install review can say when nothing ran (CAN-5017).
 */
export async function installSharedPluginRefWithOutcome(
  port: SharedImportPort,
  ref: ShareablePluginRef,
): Promise<{
  target: SharedPluginInstallTarget;
  outcome: SharedPluginInstallOutcome;
}> {
  const existing = await findInstalledSharedPluginTarget(port, ref);
  if (existing) return { target: existing, outcome: 'already-available' };

  if (ref.type === 'skill') {
    if (ref.source.type !== 'github') {
      throw new Error('This built-in skill is not available in this version.');
    }
    const result = await port.skills.installSkills(ref.source.repo, [
      ref.skill_name,
    ]);
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to install the shared skill.');
    }
    const installed = await findInstalledSkill(port, ref);
    if (!installed) {
      throw new Error('The shared skill was not found after installation.');
    }
    return { target: installed, outcome: 'installed' };
  }

  if (ref.type === 'codex_plugin') {
    const cache = await loadPluginCache(port);
    const found = cache ? findCodexPlugin(ref, cache.marketplaces) : null;
    if (!found) {
      throw new Error('This Codex plugin is not available in this version.');
    }
    // Read before installing: afterwards the plugin no longer needs it.
    const needsInstall = pluginNeedsInstall(found.plugin);
    if (needsInstall) {
      const source = found.plugin.externalSource;
      const sourceUrl =
        typeof source === 'string' ? source : (source?.url ?? '');
      if (!sourceUrl) {
        throw new Error('This Codex plugin cannot be installed automatically.');
      }
      const installed = await port.plugins.installPlugin(
        found.marketplace.id,
        found.plugin.name,
        sourceUrl,
      );
      if (
        !installed.success ||
        !installed.data ||
        pluginNeedsInstall(installed.data)
      ) {
        throw new Error(
          installed.error ?? 'The shared Codex plugin was not installed.',
        );
      }
    }
    return {
      target: pluginInstallTarget(
        found.marketplace.id,
        found.plugin.name,
        cache?.marketplaces,
      ),
      outcome: needsInstall ? 'installed' : 'already-available',
    };
  }

  if (ref.marketplace.type === 'builtin') {
    const cache = await loadPluginCache(port);
    const found = cache ? findPluginInCache(ref, cache) : null;
    if (!cache || !found) {
      throw new Error('This built-in plugin is not available in this version.');
    }
    const applicable = applicableBuiltInProviders(ref, found.plugin);
    if (applicable.length === 0) {
      throw new Error(
        'This built-in plugin has no available provider install.',
      );
    }
    const missing = applicable.filter(
      (provider) =>
        found.plugin.globalInstallStatus?.[provider]?.installed !== true,
    );
    if (missing.length > 0) {
      const installed = await port.plugins.installBuiltInPlugin({
        marketplaceId: found.marketplace.id,
        pluginName: found.plugin.name,
        providers: missing,
      });
      if (
        !installed.success ||
        !installed.data ||
        missing.some(
          (provider) =>
            installed.data?.plugin.globalInstallStatus?.[provider]
              ?.installed !== true,
        )
      ) {
        throw new Error(
          installed.error ?? 'The shared built-in plugin was not installed.',
        );
      }
    }
    return {
      target: pluginInstallTarget(
        found.marketplace.id,
        found.plugin.name,
        cache.marketplaces,
      ),
      outcome: missing.length > 0 ? 'installed' : 'already-available',
    };
  }

  const imported = await importSharedMarketplacePlugin(
    port,
    ref.marketplace,
    ref.plugin_name,
  );
  const cache =
    (await loadPluginCache(port, true)) ?? (await loadPluginCache(port, false));
  return {
    target: pluginInstallTarget(
      imported.marketplaceId,
      imported.pluginName,
      cache?.marketplaces,
    ),
    outcome: imported.installed ? 'installed' : 'already-available',
  };
}
