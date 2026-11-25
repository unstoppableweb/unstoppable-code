import {
  canonicalInstalledItemRef,
  installedItemKey,
  parseInstalledItemKey,
  type InstalledItemRef,
} from '@canopy/protocol/installed-items';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../lib/preferences-store';
import { loadMarketplacesCacheOnly } from '../plugins/plugin-service';
import { readClaudeDisabledInstalledPlugins } from '../plugins/claude-enabled-plugins';
import { listCodexPlugins } from '../plugins/codex-marketplace-service';
import { withOptionalCodex } from '../codex/codex-executable-availability';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Fresh policy at loading/execution boundaries, including consumers of stale inventories. */
export async function readInstalledItemPolicy(
  preferences?: Pick<
    PreferencesData,
    | 'disabledInstalledItems'
    | 'parkedCodexPlugins'
    | 'pendingInstalledItemUninstalls'
  >,
): Promise<{
  isDisabled(ref: InstalledItemRef): boolean;
  canonical(ref: InstalledItemRef): InstalledItemRef;
  disabledPluginRefs: Array<{ marketplaceId: string; pluginName: string }>;
  hasDisabledKind(kind: 'plugin' | 'skill'): boolean;
}> {
  const current = preferences ?? (await readPreferencesFile());
  const keys = current.disabledInstalledItems ?? [];
  const parked = current.parkedCodexPlugins ?? [];
  const refs = [...keys, ...parked.map((entry) => entry.key)].flatMap((key) => {
    const ref = parseInstalledItemKey(key);
    return ref ? [ref] : [];
  });
  for (const pending of current.pendingInstalledItemUninstalls ?? []) {
    refs.push(
      ...pending.refs.filter(
        (ref) => ref.kind !== 'mcp-config' && ref.kind !== 'account-mcp',
      ),
    );
  }
  for (const id of readClaudeDisabledInstalledPlugins(
    process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'),
  )) {
    const separator = id.lastIndexOf('@');
    if (separator > 0 && separator < id.length - 1)
      refs.push({
        kind: 'plugin',
        marketplaceId: id.slice(separator + 1),
        pluginName: id.slice(0, separator).toLowerCase(),
      });
  }
  const catalog = await loadMarketplacesCacheOnly();
  let catalogAvailable = catalog.success && catalog.data !== undefined;
  const marketplaces = catalogAvailable
    ? (catalog.data?.marketplaces ?? [])
    : [];
  const codexMarketplaces = marketplaces.filter((marketplace) =>
    marketplace.plugins.some((plugin) => plugin.facets?.codex),
  );
  const codex =
    codexMarketplaces.length > 0
      ? await withOptionalCodex(listCodexPlugins)
      : null;
  if (codex) {
    if (codex.marketplaceLoadErrors.length)
      throw new Error('Codex installed plugin state is unavailable.');
    for (const marketplace of codexMarketplaces) {
      const provider = marketplace.providerStatus.codex;
      const matches = codex.marketplaces.filter((entry) =>
        provider.marketplacePath
          ? entry.path === provider.marketplacePath
          : entry.name === (provider.marketplaceName ?? marketplace.name),
      );
      if (matches.length > 1)
        throw new Error('Codex marketplace identity is ambiguous.');
      for (const plugin of marketplace.plugins) {
        if (
          matches[0]?.plugins.some(
            (native) =>
              native.installed &&
              !native.enabled &&
              native.name.toLowerCase() === plugin.name.toLowerCase(),
          )
        )
          refs.push({
            kind: 'plugin',
            marketplaceId: marketplace.id,
            pluginName: plugin.name.toLowerCase(),
          });
      }
    }
    const latest = await loadMarketplacesCacheOnly();
    catalogAvailable = latest.success && latest.data !== undefined;
  }
  const canonical = (ref: InstalledItemRef): InstalledItemRef =>
    canonicalInstalledItemRef(ref, marketplaces);
  const disabled = new Set(refs.map((ref) => installedItemKey(canonical(ref))));
  const disabledPluginRefs = refs.flatMap((ref) => {
    const item = canonical(ref);
    return item.kind === 'plugin'
      ? [{ marketplaceId: item.marketplaceId, pluginName: item.pluginName }]
      : [];
  });
  return {
    canonical,
    disabledPluginRefs,
    hasDisabledKind: (kind): boolean =>
      (kind === 'plugin' && !catalogAvailable) ||
      refs.some((ref) => ref.kind === kind),
    isDisabled: (ref): boolean =>
      (ref.kind === 'plugin' && !catalogAvailable) ||
      disabled.has(installedItemKey(canonical(ref))),
  };
}
