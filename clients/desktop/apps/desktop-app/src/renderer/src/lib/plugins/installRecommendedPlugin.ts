import {
  isCuratedPluginMarketplaceId,
  type PluginInfo,
  type PluginProvider,
} from '@canopy/execution-engine/types/plugins';
import { curatedPluginKey } from '@/lib/onboarding/curatedOnboardingPlugins';
import { pluginNeedsInstall } from '@/lib/pluginInstallStatus';
import { applyPluginUpdateToMarketplaceCaches } from '@/hooks/useMarketplaceList';

/** Resolve the original identity from disk; aliases and case-folded UI keys are not install IDs. */
export async function installRecommendedPlugin(
  keys: readonly string[],
): Promise<PluginInfo> {
  const cache = await window.plugins.loadMarketplacesCacheOnly();
  const plugin = cache.data?.marketplaces
    .flatMap((marketplace) => marketplace.plugins)
    .find((candidate) =>
      keys.includes(curatedPluginKey(candidate.marketplaceId, candidate.name)),
    );
  if (!cache.success || !plugin)
    throw new Error(
      'This plugin is unavailable. Refresh the plugins marketplace and try again.',
    );
  let updated = plugin;
  if (isCuratedPluginMarketplaceId(plugin.marketplaceId)) {
    const providers: PluginProvider[] = [];
    if (
      plugin.providerSupport.claude === 'native' &&
      !plugin.globalInstallStatus?.claude?.installed
    )
      providers.push('claude');
    if (
      plugin.providerSupport.codex !== 'none' &&
      !plugin.globalInstallStatus?.codex?.installed
    )
      providers.push('codex');
    if (providers.length) {
      const result = await window.plugins.installBuiltInPlugin({
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.name,
        providers,
      });
      if (
        !result.success ||
        !result.data ||
        providers.some(
          (provider) => !result.data?.providerOutcomes[provider]?.installed,
        )
      ) {
        throw Object.assign(
          new Error(result.error ?? 'Could not install the plugin. Try again.'),
          { appError: result.appError },
        );
      }
      updated = result.data.plugin;
    }
  } else if (pluginNeedsInstall(plugin)) {
    const source = plugin.externalSource;
    const sourceUrl = typeof source === 'string' ? source : source?.url;
    if (!sourceUrl)
      throw new Error('This plugin has no available installation source.');
    const result = await window.plugins.installPlugin(
      plugin.marketplaceId,
      plugin.name,
      sourceUrl,
    );
    if (!result.success || !result.data || pluginNeedsInstall(result.data))
      throw Object.assign(
        new Error(result.error ?? 'Could not install the plugin. Try again.'),
        { appError: result.appError },
      );
    updated = result.data;
  }
  applyPluginUpdateToMarketplaceCaches(
    plugin.marketplaceId,
    plugin.name,
    updated,
  );
  return updated;
}
