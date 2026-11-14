import { installedItemKey } from '@canopy/protocol/installed-items';
import type { MarketplaceInfo } from '@canopy/protocol/plugins';
import type { UnifiedMarketplaceInput } from '@canopy/ui-app/capability';
import type { InstalledItemSnapshotState } from '@canopy/ui-shared/lib';
import { pluginNeedsInstall } from '@canopy/ui-shared/lib/plugin-install-status';
import { officialMarketplaceProvider } from '@canopy/ui-shared/lib/unified-plugin-entry';

export {
  pluginNeedsInstall,
  countPluginsNeedingInstall,
} from '@canopy/ui-shared/lib/plugin-install-status';

/** A checkout can provide content before the provider owns an installation. */
export function projectDesktopMarketplaceInventory(
  marketplaces: readonly MarketplaceInfo[],
  state: InstalledItemSnapshotState,
): UnifiedMarketplaceInput[] {
  const owned = new Set<string>();
  if (state.kind === 'ready') {
    for (const { target, status, removable, notices } of state.snapshot.items) {
      if (
        target.kind === 'plugin' &&
        status !== null &&
        (removable ||
          notices.some((notice) => notice.code === 'partial_removal'))
      )
        owned.add(installedItemKey(target));
    }
  }
  return marketplaces.map((marketplace) => ({
    ...marketplace,
    plugins: marketplace.plugins.map((plugin) => {
      const provider = officialMarketplaceProvider(marketplace.id);
      if (!provider)
        return { ...plugin, installed: !pluginNeedsInstall(plugin) };
      const harness = provider === 'Claude' ? 'claude' : 'codex';
      const otherHarness = harness === 'claude' ? 'codex' : 'claude';
      const cachePath =
        plugin.facets[harness]?.cachePath ??
        (plugin.facets[otherHarness] ? undefined : plugin.cachePath);
      const installed =
        plugin.globalInstallStatus?.[harness]?.installed === true ||
        Boolean(cachePath) ||
        owned.has(
          installedItemKey({
            kind: 'plugin',
            marketplaceId: marketplace.id,
            pluginName: plugin.name,
          }),
        );
      // The existing external install action stages a Claude facet only.
      // Package identity alone cannot authorize a Codex install through it.
      const browseInstallAvailable =
        provider === 'Claude' &&
        pluginNeedsInstall(plugin) &&
        Boolean(plugin.externalSource?.url?.trim());
      return { ...plugin, installed, browseInstallAvailable };
    }),
  }));
}
