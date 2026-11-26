import type {
  MarketplaceInfo,
  PluginInfo,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import { createHash } from 'node:crypto';
import type { CollectionSkillRef } from '@canopy/protocol/collections';
import { validateSharedCollectionDocument } from '@canopy/protocol/collections';
import { getShareablePluginRefKey } from '@canopy/protocol/plugins';
import { computePluginShareableRef } from '@canopy/execution-engine/plugin-refs';
import {
  readLocalCollectionSnapshot,
  saveCollectionConfig,
} from './collection-store';
import {
  resourceContextSnapshot,
  assertResourceContextSnapshot,
} from '../lib/resource-context';
import { getPublicCollectionShareSnapshot } from '../canopy-cloud/public-share-client';
import {
  getSharedCollection,
  getCollectionPackage,
  getPublicCollectionPackage,
  getCollectionPackageBlob,
  getPublicCollectionPackageBlob,
} from './canopy-server-client';
import {
  installSubjectCapabilityPackage,
  MaterializationCheckTimeoutError,
} from '../skills/skill-package-install';
import { runSkillMutation } from '../skills/skill-mutations';
import {
  installSkills,
  loadSkills,
  writeRawSkillForContext,
} from '../skills/skill-service';
import { loadMarketplaces } from '../plugins/plugin-service';
import {
  addRemoteControlMarketplace,
  installRemoteControlBuiltInPlugin,
  installRemoteControlExternalPlugin,
} from '../services/plugin-catalog-service';
import { skillContextSnapshot } from '../skills/resource-lanes';
import {
  CollectionUpdateError,
  type CollectionMutationPorts,
  type CollectionUpdateSnapshot,
} from './collection-mutations';

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export const collectionMutationPorts: CollectionMutationPorts = {
  captureContext: resourceContextSnapshot,
  assertContext: assertResourceContextSnapshot,
  read: async (id) =>
    (await readLocalCollectionSnapshot(id))?.collection ?? null,
  save: (input, guard) => saveCollectionConfig(input, undefined, guard),
  live: async (source): Promise<CollectionUpdateSnapshot> => {
    const detail = source.fromPublicShare
      ? await getPublicCollectionShareSnapshot(source.remoteId)
      : await getSharedCollection(source.remoteId);
    // The scoped endpoint includes the exact hash-covered bytes. Prefer those
    // over any independently claimed parsed projection.
    const collection =
      'rawCollection' in detail
        ? validateSharedCollectionDocument(JSON.parse(detail.rawCollection))
        : validateSharedCollectionDocument(detail.collection);
    if (
      'rawCollection' in detail &&
      sha256(detail.rawCollection) !== detail.contentHash
    )
      throw new CollectionUpdateError(
        'conflict',
        'The Collection snapshot does not match its hash.',
      );
    for (const skill of detail.customSkills) {
      if (sha256(skill.rawSkill) !== skill.contentHash)
        throw new CollectionUpdateError(
          'conflict',
          'A custom skill snapshot does not match its hash.',
        );
    }
    return {
      contentHash: detail.contentHash,
      collection,
      customSkills: detail.customSkills,
      ...(detail.package
        ? {
            package: {
              version: detail.package.version,
              digest: detail.package.digest,
            },
          }
        : {}),
    };
  },
  resolve: async (item, snapshot, source, assertCurrent) => {
    if (item.type === 'custom_skill') {
      const skill = snapshot.customSkills.find(
        (candidate) =>
          candidate.id === item.skillId &&
          candidate.contentHash === item.contentHash,
      );
      if (!skill)
        throw new Error(
          'The custom skill is missing from the authorized Collection snapshot.',
        );
      await assertCurrent();
      const imported = await writeRawSkillForContext({
        skillName: skill.name,
        rawSkill: skill.rawSkill,
        inCollection: true,
        ...(source.fromPublicShare
          ? {
              publicShare: {
                externalId: skill.id,
                contentHash: skill.contentHash,
                collection: {
                  externalId: source.remoteId,
                  contentHash: snapshot.contentHash,
                },
              },
            }
          : { sourceRemoteId: skill.id }),
      });
      // Context-aware imports re-read the source. Refuse to advance this
      // Collection snapshot if the skill changed independently during import.
      const { readRawSkill } = await import('../skills/skill-service');
      if (sha256(await readRawSkill(imported.skillId)) !== item.contentHash)
        throw new CollectionUpdateError(
          'conflict',
          'The custom skill changed during import.',
        );
      return { sourceId: 'custom:app', skillName: imported.skillName };
    }
    if (item.type === 'skill') {
      const key = getShareablePluginRefKey(item);
      const find = (): NonNullable<ReturnType<typeof loadSkills>['data']> => {
        const inventory = loadSkills();
        if (!inventory.success || !inventory.data)
          throw new Error('Could not read the installed skills.');
        return inventory.data.filter(
          (skill) =>
            skill.shareableSource &&
            getShareablePluginRefKey({
              type: 'skill',
              source: skill.shareableSource,
              skill_name: skill.name,
            }) === key,
        );
      };
      let matches = find();
      // A collection update changes membership, not the content of an already
      // installed GitHub skill. Keep its canonical ref and local edits intact.
      if (matches.length === 0 && item.source.type === 'github') {
        await assertCurrent();
        const installed = await installSkills(item.source.repo, [
          item.skill_name,
        ]);
        if (!installed.success)
          throw new Error(installed.error ?? 'Skill installation failed.');
        matches = find();
      }
      if (matches.length !== 1)
        throw new Error('The exact skill reference could not be resolved.');
      const skill = matches[0];
      return { sourceId: skill.sourceId, skillName: skill.name };
    }
    const readCatalog = async (): Promise<PluginsCache> => {
      const result = await loadMarketplaces();
      if (!result.success || !result.data)
        throw new Error('Could not read the plugin catalog.');
      return result.data;
    };
    let catalog = await readCatalog();
    const key = getShareablePluginRefKey(item);
    const find = (): Array<{
      marketplace: MarketplaceInfo;
      plugin: PluginInfo;
    }> =>
      catalog.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.flatMap((plugin) => {
          const ref = computePluginShareableRef(plugin, marketplace);
          const equivalent =
            ref?.type === 'plugin'
              ? { ...ref, type: 'claude_plugin' as const }
              : ref;
          return equivalent && getShareablePluginRefKey(equivalent) === key
            ? [{ marketplace, plugin }]
            : [];
        }),
      );
    let matches = find();
    if (matches.length === 0 && item.marketplace.type === 'github') {
      await assertCurrent();
      await addRemoteControlMarketplace(item.marketplace.repo);
      catalog = await readCatalog();
      matches = find();
    }
    if (matches.length !== 1)
      throw new Error('The exact plugin reference could not be resolved.');
    const { marketplace, plugin } = matches[0];
    if (marketplace.builtIn || marketplace.sourceType === 'codex') {
      const providers =
        item.type === 'codex_plugin' ? ['codex' as const] : ['claude' as const];
      await assertCurrent();
      await installRemoteControlBuiltInPlugin(
        marketplace.id,
        plugin.name,
        providers,
      );
    } else if (plugin.externalSource || plugin.facets.claude?.externalSource) {
      await assertCurrent();
      await installRemoteControlExternalPlugin(marketplace.id, plugin.name);
    }
    return { marketplaceId: marketplace.id, pluginName: plugin.name };
  },
  installPackage: async (snapshot, initial, assertCurrent) => {
    const source = initial.sharedSource;
    const ref = snapshot.package;
    if (!source || !ref)
      throw new Error('A package and Collection source are required.');
    await assertCurrent();
    const download = source.fromPublicShare
      ? await getPublicCollectionPackage(source.remoteId, ref.digest)
      : await getCollectionPackage(source.remoteId, ref.digest);
    if (
      download.digest !== ref.digest ||
      download.manifest.pipelineContentHash !== snapshot.contentHash
    )
      throw new CollectionUpdateError(
        'conflict',
        'The Collection package does not match the authorized snapshot.',
      );
    const { resolveCollectionMcpRequirements } =
      await import('./collection-handlers');
    const { getMcpServerStatusByCatalogId } =
      await import('../mcp/connection-status');
    // Only exact server/catalog identities can drive membership replacement.
    // The name heuristic remains available for readiness warnings elsewhere.
    const mcp = await resolveCollectionMcpRequirements(
      download.manifest.environmentRequirements,
      {
        byCatalogId: getMcpServerStatusByCatalogId,
        byName: () => Promise.resolve(null),
      },
    );
    if (mcp.unmetRequirements.length)
      throw new Error('A Collection MCP requirement could not be resolved.');
    await assertCurrent();
    const packageContext = await skillContextSnapshot();
    await assertCurrent();
    const installed = await installSubjectCapabilityPackage({
      owner: { kind: 'collection', localId: initial.id },
      originExternalId: source.remoteId,
      packageRef: ref,
      download,
      skillContext: { snapshot: packageContext },
      fetchBlob: async (hash) => {
        await assertCurrent();
        return source.fromPublicShare
          ? getPublicCollectionPackageBlob(source.remoteId, ref.digest, hash)
          : getCollectionPackageBlob(source.remoteId, ref.digest, hash);
      },
      checkBeforeMaterialization: assertCurrent,
      serializeMaterialization: runSkillMutation,
    }).catch((error: unknown) => {
      if (error instanceof MaterializationCheckTimeoutError)
        throw new CollectionUpdateError('conflict', error.message);
      throw error;
    });
    const customSkills = new Map<string, CollectionSkillRef>();
    for (const item of snapshot.collection.items) {
      if (item.type !== 'custom_skill') continue;
      const resourceIds = new Set(
        download.manifest.resources
          .filter((resource) =>
            resource.trees.some((tree) =>
              tree.entries.some(
                (entry) =>
                  entry.path === 'SKILL.md' &&
                  entry.sha256 === item.contentHash,
              ),
            ),
          )
          .map((resource) => resource.id),
      );
      const matches = installed.installedSkills.filter((skill) =>
        resourceIds.has(skill.resourceId),
      );
      const localNames = Array.from(
        new Set(matches.map((skill) => skill.localName)),
      );
      if (localNames.length !== 1)
        throw new Error(
          'A custom skill has no unambiguous package resource mapping.',
        );
      customSkills.set(item.skillId, {
        sourceId: 'custom:app',
        skillName: localNames[0],
      });
    }
    return {
      customSkills,
      skills: installed.installedSkills.map((skill) => ({
        sourceId: 'custom:app',
        skillName: skill.localName,
      })),
      mcpServers: mcp.mcpServerRefs,
      uninstalledResourceLabels: installed.uninstalledResourceLabels,
      keptLocalFiles: installed.keptLocalFiles,
    };
  },
};
