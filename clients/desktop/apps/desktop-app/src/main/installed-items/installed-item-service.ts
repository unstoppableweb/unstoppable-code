import { classifyError } from '@canopy/protocol/app-errors/classification';
import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isMissingFileError } from '@canopy/desktop-shared/node/lib/fs-utils';
import {
  INSTALLED_ITEM_MARKETPLACE_OWNED_REASON,
  canonicalInstalledItemRef,
  installedItemKey,
  parseInstalledItemKey,
  type InstalledItemRef,
} from '@canopy/protocol/installed-items';
import {
  AccountMcpConnectionError,
  normalizeMcpServerFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { isBuiltInPluginMarketplaceId } from '@canopy/protocol/plugins';
import { claudeMarketplaceNames } from '../plugins/inherited-cursor-plugins';
import { resolvePluginInfoPath } from '../plugins/plugin-resolver';
import {
  createInstalledItemStatusService,
  type InstalledItemRecord,
  type ParkedCodexPlugin,
} from './installed-item-status-service';
import { pruneInstalledItemRefs } from './installed-item-ref-prune';
import { notifyInstalledItemsChanged } from './installed-item-events';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import {
  getMcpServersIndexFilePath,
  getMcpServerFilePath,
  getCollectionConfigFilePath,
} from '../lib/paths';
import {
  runSerializedPluginMutation,
  setPortalMcpConfigEnabled,
} from '../services/plugin-catalog-service';
import {
  loadMarketplacesCacheOnly,
  readClaudeInstalledItemState,
  setClaudeInstalledItemEnabled,
  uninstallClaudeInstalledItem,
  removeInstalledPluginCache,
  pruneSelectionRefsForInstalledItem,
  refreshInstalledPluginCatalog,
} from '../plugins/plugin-service';
import {
  installCodexPlugin,
  listCodexPlugins,
  readCodexMarketplaceInstallMetadata,
  uninstallCodexPlugin,
} from '../plugins/codex-marketplace-service';
import { loadSkills, removeSkillForContext } from '../skills/skill-service';
import { isBuiltinSourceId } from '../skills/paths';
import { filterStoredSkillContexts } from '../skills/skill-install-context';
import {
  readCollectionIndex,
  readCollectionConfig,
  saveCollectionConfig,
  deleteCollectionConfig,
} from '../collections/collection-store';
import { accountMcpConnectionsEnabled } from '../mcp/account-catalog';
import {
  listAccountMcpConnections,
  updateAccountMcpConnection,
  removeAccountMcpConnection,
  accountMcpConnectionsEditable,
} from '../canopy-cloud/mcp-connections';
import { CanopyCloudClientError } from '../canopy-cloud/client';
let canonicalMarketplaces: Awaited<ReturnType<typeof catalog>>['marketplaces'] =
  [];
let deviceServerIds: string[] = [];
function sourceDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function catalog(): Promise<
  NonNullable<Awaited<ReturnType<typeof loadMarketplacesCacheOnly>>['data']>
> {
  const result = await loadMarketplacesCacheOnly();
  if (!result.success || !result.data)
    throw new Error(result.error ?? 'Installed plugin catalog is unavailable.');
  return result.data;
}

async function readDeviceIndex(): Promise<{ servers: Array<{ id: string }> }> {
  try {
    return z
      .object({
        version: z.literal(1),
        servers: z.array(z.object({ id: z.string().regex(/^[a-f0-9-]+$/) })),
      })
      .parse(JSON.parse(await readFile(getMcpServersIndexFilePath(), 'utf8')));
  } catch (error) {
    if (isMissingFileError(error)) return { servers: [] };
    throw error;
  }
}

/**
 * Signed out, with no cloud configured, or on a server without account
 * connections, the account has none. Any other failure still fails the
 * snapshot, since the account's Disabled connections can't be known.
 */
async function accountConnections(): Promise<
  Awaited<ReturnType<typeof listAccountMcpConnections>>
> {
  try {
    return await listAccountMcpConnections();
  } catch (error) {
    if (
      error instanceof AccountMcpConnectionError &&
      error.code === 'account-changed'
    )
      throw classifyError(error, 'external.state_changed');
    if (
      error instanceof CanopyCloudClientError &&
      (error.code === 'missing-api-key' ||
        error.code === 'cloud-not-configured' ||
        error.code === 'unsupported-capability')
    )
      return [];
    throw error;
  }
}

async function records(): Promise<InstalledItemRecord[]> {
  const cache = await catalog();
  canonicalMarketplaces = cache.marketplaces;
  const preferences = await readPreferencesFile();
  const recoveries = preferences.parkedCodexPlugins ?? [];
  const hasCodex =
    recoveries.length > 0 ||
    cache.marketplaces.some((marketplace) =>
      marketplace.plugins.some((plugin) => plugin.facets.codex),
    );
  // A failed provider read fails the snapshot. It never becomes an empty catalog.
  const codex = hasCodex ? await listCodexPlugins() : null;
  if (codex?.marketplaceLoadErrors.length)
    throw new Error('Codex installed plugin state is unavailable.');
  const result = new Map<string, InstalledItemRecord>();
  for (const marketplace of cache.marketplaces) {
    const providerName =
      marketplace.providerStatus?.codex?.marketplaceName ?? marketplace.name;
    const providerPath = marketplace.providerStatus.codex.marketplacePath;
    const providerMatches =
      codex?.marketplaces.filter((entry) =>
        providerPath
          ? entry.path === providerPath
          : entry.name === providerName,
      ) ?? [];
    if (providerMatches.length > 1)
      throw new Error(
        'Codex marketplace identity is ambiguous. Refresh the installed catalog before changing it.',
      );
    const providerMarketplace = providerMatches[0];
    for (const plugin of marketplace.plugins) {
      const ref = {
        kind: 'plugin',
        marketplaceId: marketplace.id,
        pluginName: plugin.name.toLowerCase(),
      } as const;
      const key = installedItemKey(ref);
      const claude = readClaudeInstalledItemState(
        marketplace,
        plugin.name,
        cache.marketplaces,
      );
      const native = providerMarketplace?.plugins.find(
        (entry) =>
          entry.name.toLowerCase() === ref.pluginName && entry.installed,
      );
      const marketplaceSource =
        native && providerMarketplace
          ? await readCodexMarketplaceInstallMetadata(providerMarketplace.name)
          : null;
      const recovery = recoveries.find((entry) => entry.key === key);
      const ownedInstall = Boolean(
        claude.ids.length ||
        native ||
        plugin.cachePath ||
        plugin.facets.claude?.cachePath ||
        recovery,
      );
      // Inline marketplace sources can already be invoked without a provider
      // installation. Resolve without installing; absence stays Browse-only.
      if (
        !ownedInstall &&
        !(await resolvePluginInfoPath(plugin, marketplace, [], false))
      )
        continue;
      const removable =
        ownedInstall &&
        !plugin.builtIn &&
        !isBuiltInPluginMarketplaceId(marketplace.id);
      result.set(key, {
        ref,
        enabled: claude.enabled && (native?.enabled ?? true),
        removable,
        ...(!removable
          ? {
              reason:
                plugin.builtIn || isBuiltInPluginMarketplaceId(marketplace.id)
                  ? 'Bundled plugins cannot be uninstalled.'
                  : INSTALLED_ITEM_MARKETPLACE_OWNED_REASON,
            }
          : {}),
        claudeIds: claude.ids,
        claudeEnabled: claude.enabled,
        ...(native ? { codexEnabled: native.enabled } : {}),
        ...(native && providerMarketplace
          ? {
              codex: {
                pluginId: native.id,
                sourceDigest: sourceDigest(native.source),
                ...(marketplaceSource
                  ? { marketplaceSourceDigest: sourceDigest(marketplaceSource) }
                  : {}),
                pluginName: native.name,
                marketplacePath: providerMarketplace.path,
                remoteMarketplaceName: providerMarketplace.path
                  ? null
                  : providerMarketplace.name,
                ...((native.localVersion ?? native.version)
                  ? {
                      version:
                        native.localVersion ?? native.version ?? undefined,
                    }
                  : {}),
              },
            }
          : {}),
      });
    }
  }
  for (const recovery of recoveries) {
    const ref = parseInstalledItemKey(recovery.key);
    if (ref?.kind === 'plugin' && !result.has(recovery.key))
      result.set(recovery.key, {
        ref,
        enabled: false,
        removable: !isBuiltInPluginMarketplaceId(ref.marketplaceId),
      });
  }
  const skills = loadSkills();
  if (!skills.success || !skills.data)
    throw new Error(skills.error ?? 'Installed skills are unavailable.');
  for (const skill of await filterStoredSkillContexts(skills.data)) {
    const ref = {
      kind: 'skill',
      sourceId: skill.sourceId,
      skillName: skill.name,
    } as const;
    const removable = !skill.builtIn && !isBuiltinSourceId(skill.sourceId);
    result.set(installedItemKey(ref), {
      ref,
      enabled: true,
      removable,
      ...(!removable
        ? { reason: 'Built-in skills cannot be uninstalled.' }
        : {}),
    });
  }
  for (const collection of (await readCollectionIndex()).collections) {
    const ref = { kind: 'collection', collectionId: collection.id } as const;
    result.set(installedItemKey(ref), { ref, enabled: true, removable: true });
  }
  const deviceIndex = await readDeviceIndex();
  deviceServerIds = deviceIndex.servers.map((server) => server.id);
  for (const server of deviceIndex.servers) {
    const raw = await readFile(getMcpServerFilePath(server.id), 'utf8').catch(
      (error: unknown) => {
        if (isMissingFileError(error)) return null;
        throw error;
      },
    );
    if (raw === null) continue;
    const file = normalizeMcpServerFile(JSON.parse(raw));
    for (const config of file.server.configs) {
      const ref = {
        kind: 'mcp-config',
        serverId: server.id,
        configId: config.id,
      } as const;
      result.set(installedItemKey(ref), {
        ref,
        enabled: config.enabled,
        removable: true,
      });
    }
  }
  if (accountMcpConnectionsEnabled()) {
    const editable = await accountMcpConnectionsEditable();
    for (const connection of await accountConnections()) {
      const ref = { kind: 'account-mcp', connectionId: connection.id } as const;
      result.set(installedItemKey(ref), {
        ref,
        selectionRef: {
          serverId: connection.serverKey,
          configId: connection.configId,
        },
        enabled: connection.enabled !== false,
        removable: editable,
        ...(!editable
          ? { reason: 'This account does not support connection removal.' }
          : {}),
      });
    }
  }
  return Array.from(result.values());
}

async function restoreCodex(record: ParkedCodexPlugin): Promise<void> {
  // Re-read and compare the exact provider identity and version before installing.
  const listed = await listCodexPlugins();
  const marketplace = listed.marketplaces.find((entry) =>
    record.marketplacePath
      ? entry.path === record.marketplacePath
      : entry.name === record.remoteMarketplaceName,
  );
  const plugin = marketplace?.plugins.find(
    (entry) => entry.id === record.pluginId && entry.name === record.pluginName,
  );
  const marketplaceSource = marketplace
    ? await readCodexMarketplaceInstallMetadata(marketplace.name)
    : null;
  if (
    !plugin ||
    (record.sourceDigest &&
      sourceDigest(plugin.source) !== record.sourceDigest) ||
    (record.marketplaceSourceDigest &&
      (!marketplaceSource ||
        sourceDigest(marketplaceSource) !== record.marketplaceSourceDigest)) ||
    (record.version &&
      (plugin.localVersion ?? plugin.version) !== record.version)
  )
    throw new Error(
      'The saved Codex source or version is unavailable. The plugin remains Disabled.',
    );
  if (!plugin.installed)
    await installCodexPlugin({
      pluginName: record.pluginName,
      marketplacePath: record.marketplacePath,
      remoteMarketplaceName: record.remoteMarketplaceName,
    });
  const actual = await listCodexPlugins();
  if (
    !actual.marketplaces.some((entry) =>
      entry.plugins.some(
        (candidate) =>
          candidate.id === record.pluginId &&
          candidate.installed &&
          candidate.enabled,
      ),
    )
  )
    throw new Error('Codex has not restored the saved plugin.');
}

export const installedItemService = createInstalledItemStatusService({
  readPreferences: readPreferencesFile,
  updatePreferences: updatePreferencesFile,
  list: records,
  deviceServerIds: () => deviceServerIds,
  canonical: (ref) =>
    Promise.resolve(canonicalInstalledItemRef(ref, canonicalMarketplaces)),
  serialize: runSerializedPluginMutation,
  setClaudeEnabled: setClaudeInstalledItemEnabled,
  parkCodex: uninstallCodexPlugin,
  restoreCodex,
  async setMcpEnabled(ref, enabled) {
    if (ref.kind === 'mcp-config') {
      await setPortalMcpConfigEnabled(ref.serverId, ref.configId, enabled);
      return;
    }
    if (ref.kind !== 'account-mcp') throw new Error('Not an MCP target.');
    if (
      !accountMcpConnectionsEnabled() ||
      !(await accountMcpConnectionsEditable())
    )
      throw new Error('Account connection editing is unavailable.');
    const connection = await updateAccountMcpConnection(ref.connectionId, {
      enabled,
    });
    if ((connection.enabled !== false) !== enabled)
      throw new Error(
        'The account connection did not apply the enabled state.',
      );
  },
  async remove(record) {
    const ref = record.ref;
    switch (ref.kind) {
      case 'plugin': {
        // Attempt every owned facet. Retain cache and references until every provider succeeds.
        const outcomes = await Promise.allSettled([
          ...(record.claudeIds ?? []).map(uninstallClaudeInstalledItem),
          ...(record.codex
            ? [uninstallCodexPlugin(record.codex.pluginId)]
            : []),
        ]);
        const failures = outcomes.filter(
          (outcome) => outcome.status === 'rejected',
        );
        if (failures.length)
          throw new Error(
            'Some provider installations remain. Retry Uninstall to remove them.',
          );
        await removeInstalledPluginCache(ref.marketplaceId, ref.pluginName);
        return;
      }
      case 'skill': {
        const outcome = await removeSkillForContext(
          ref.sourceId,
          ref.skillName,
        );
        if (!outcome.success) throw new Error(outcome.error);
        return;
      }
      case 'collection':
        await deleteCollectionConfig(ref.collectionId);
        return;
      case 'account-mcp': {
        if (!(await accountMcpConnectionsEditable()))
          throw new Error('Account connection removal is unavailable.');
        const outcome = await removeAccountMcpConnection(ref.connectionId);
        if (!outcome.removed)
          throw new Error('The account connection could not be removed.');
        return;
      }
      case 'mcp-config':
        throw new Error(
          'Uninstall the device server explicitly to remove all configurations.',
        );
    }
  },
  async removeDeviceServer(serverId) {
    const { uninstallInstalledDeviceMcpServer } =
      await import('../ipc/mcp-servers');
    await uninstallInstalledDeviceMcpServer(serverId);
  },
  async assertAbsent(ref) {
    if (ref.kind === 'skill') {
      const installed = loadSkills();
      if (
        !installed.success ||
        !installed.data ||
        installed.data.some(
          (skill) =>
            skill.sourceId === ref.sourceId && skill.name === ref.skillName,
        )
      )
        throw new Error(
          'Installed item is unavailable in the current account context.',
        );
    }
    if (ref.kind === 'collection') {
      if (!/^[a-f0-9-]+$/.test(ref.collectionId))
        throw new Error('Invalid collection id.');
      const exists = await stat(getCollectionConfigFilePath(ref.collectionId))
        .then(() => true)
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return false;
          throw error;
        });
      if (exists)
        throw new Error(
          'Installed item is unavailable in the current account context.',
        );
    }
  },
  async prune(refs) {
    const expandedRefs = refs.flatMap<InstalledItemRef>((ref) => {
      if (ref.kind !== 'plugin') return [ref];
      const marketplace = canonicalMarketplaces.find(
        (entry) => entry.id === ref.marketplaceId,
      );
      if (!marketplace) return [ref];
      const aliases = [
        ...claudeMarketplaceNames(marketplace),
        marketplace.providerStatus.codex.marketplaceName,
      ].filter((alias): alias is string => Boolean(alias));
      return [
        ref,
        ...aliases.flatMap((marketplaceId) => {
          const candidate = { ...ref, marketplaceId };
          const canonical = canonicalInstalledItemRef(
            candidate,
            canonicalMarketplaces,
          );
          return canonical.kind === 'plugin' &&
            canonical.marketplaceId === ref.marketplaceId
            ? [candidate]
            : [];
        }),
      ];
    });
    for (const ref of expandedRefs) {
      await updatePreferencesFile((current) => {
        const next = structuredClone(current);
        pruneInstalledItemRefs(next, ref);
        // Keep curated seeding receipts: an explicit uninstall is not first-run setup.
        return next;
      });
      await pruneSelectionRefsForInstalledItem(ref);
      if (ref.kind !== 'collection')
        for (const row of (await readCollectionIndex()).collections) {
          const file = await readCollectionConfig(row.id);
          if (file && pruneInstalledItemRefs(file.collection, ref))
            await saveCollectionConfig(file.collection);
        }
    }
  },
  async publish(target) {
    try {
      if (target.kind === 'plugin')
        await refreshInstalledPluginCatalog(target.marketplaceId);
    } finally {
      notifyInstalledItemsChanged();
    }
  },
});
