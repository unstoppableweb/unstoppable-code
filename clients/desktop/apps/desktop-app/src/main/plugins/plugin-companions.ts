import {
  PLUGIN_HARNESSES,
  pluginInfoHarnessRows,
} from '@canopy/plugin-interop/harness-support';
import {
  ITEM_HARNESS_COMPANIONS_MAX,
  type HarnessCompatibilityHarness,
  type HarnessInstallItemRef,
  type ItemHarnessCompanion,
  type MarketplaceInfo,
} from '@canopy/protocol/plugins';
import { marketplaceBrowseNameKey } from '@canopy/ui-shared/lib/marketplace-browse-curation';
import { officialMarketplaceProvider as officialPluginMarketplaceProvider } from '@canopy/ui-shared/lib/unified-plugin-entry';

/**
 * The native copies one Add brings along (Sergii's QA): for every harness
 * this plugin can't serve, another listing of the same integration that can
 * (Slack's Claude plugin beside its Codex one). Resolved here, in main, so
 * every Add — a plugin page, a Browse row, the Portal — installs the same
 * copies. All five harnesses count, read through the plugin page's own
 * harness rule (`pluginInfoHarnessRows`).
 *
 * A copy is the same integration when its name matches and the copy itself
 * is listed in a provider's official marketplace, or both listings name the
 * same author. An official item alone vouches for nothing, so an unrelated
 * plugin that shares a name in some third-party catalog never comes along.
 * Official copies are chosen before same-author ones.
 */
export function pluginCompanionsFromCatalog(
  marketplaces: readonly MarketplaceInfo[],
  item: Extract<HarnessInstallItemRef, { kind: 'plugin' }>,
  /** The record's harnesses: a native copy serves only those. */
  harnesses: readonly HarnessCompatibilityHarness[],
): ItemHarnessCompanion[] {
  const owner = marketplaces.find((entry) => entry.id === item.marketplaceId);
  const plugin = owner?.plugins.find(
    (entry) => entry.name.toLowerCase() === item.pluginName.toLowerCase(),
  );
  if (owner === undefined || plugin === undefined) return [];
  const ownRows = pluginInfoHarnessRows(plugin, PLUGIN_HARNESSES, false);
  const unserved = harnesses.filter(
    (harness) =>
      ownRows.find((row) => row.id === harness)?.installation ===
      'Not supported',
  );
  if (unserved.length === 0) return [];
  const key = marketplaceBrowseNameKey(plugin.displayName ?? plugin.name);
  const author = plugin.author?.trim().toLowerCase();
  const copies = marketplaces.flatMap((marketplace) =>
    marketplace.id === owner.id
      ? []
      : marketplace.plugins
          .filter(
            (candidate) =>
              marketplaceBrowseNameKey(
                candidate.displayName ?? candidate.name,
              ) === key &&
              (officialPluginMarketplaceProvider(marketplace.id) !==
                undefined ||
                (author !== undefined &&
                  author !== '' &&
                  candidate.author?.trim().toLowerCase() === author)),
          )
          .map((candidate) => ({
            marketplace,
            candidate,
            official:
              officialPluginMarketplaceProvider(marketplace.id) !== undefined,
            rows: pluginInfoHarnessRows(candidate, PLUGIN_HARNESSES, false),
          })),
  );
  copies.sort((a, b) => Number(b.official) - Number(a.official));
  const companions: ItemHarnessCompanion[] = [];
  for (const harness of unserved) {
    const serving = copies.filter(
      ({ rows }) =>
        rows.find((row) => row.id === harness)?.installation !==
          'Not supported' && rows.some((row) => row.id === harness),
    );
    // An installed copy first, so a second Add doesn't fetch another one.
    const chosen =
      serving.find(
        ({ rows }) =>
          rows.find((row) => row.id === harness)?.installation === 'Installed',
      ) ?? serving[0];
    if (chosen === undefined) continue;
    const ref = {
      kind: 'plugin' as const,
      marketplaceId: chosen.marketplace.id,
      pluginName: chosen.candidate.name,
    };
    const existing = companions.find(
      (companion) =>
        companion.item.kind === 'plugin' &&
        companion.item.marketplaceId === ref.marketplaceId &&
        companion.item.pluginName.toLowerCase() ===
          ref.pluginName.toLowerCase(),
    );
    if (existing !== undefined) {
      const index = companions.indexOf(existing);
      companions[index] = {
        item: existing.item,
        harnesses: [...existing.harnesses, harness],
      };
    } else if (companions.length < ITEM_HARNESS_COMPANIONS_MAX)
      companions.push({ item: ref, harnesses: [harness] });
  }
  return companions;
}
