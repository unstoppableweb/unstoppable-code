import type { SharedImportPort } from './port';
import type {
  CollectionPluginRef,
  CollectionSkillRef,
  SharedCollectionDocument,
} from '../../types/collections';
import {
  importSharedSkill,
  type SharedSkillImportSource,
} from './shared-skill-import';
import { installSharedPluginRef } from './public-share-plugin-install';
import { importSharedMarketplacePlugin } from './shared-plugin-marketplace-import';

export interface SharedCollectionMemberFailure {
  label: string;
  required: boolean;
  message: string;
}

export interface SharedCollectionImportResolution {
  skills: CollectionSkillRef[];
  plugins: CollectionPluginRef[];
  failures: SharedCollectionMemberFailure[];
}

export interface SharedCollectionImportSource {
  collection: SharedCollectionDocument;
  customSkills: Array<SharedSkillImportSource & { id: string }>;
}

/** Resolve every member independently; one broken member never aborts import. */
export async function resolveSharedCollectionImport(
  port: SharedImportPort,
  detail: SharedCollectionImportSource,
  onProgress?: (label: string) => void,
): Promise<SharedCollectionImportResolution> {
  const skills: CollectionSkillRef[] = [];
  const plugins: CollectionPluginRef[] = [];
  const failures: SharedCollectionMemberFailure[] = [];

  for (const item of detail.collection.items) {
    const label =
      item.type === 'claude_plugin' || item.type === 'codex_plugin'
        ? item.plugin_name
        : item.skill_name;
    try {
      if (item.type === 'skill') {
        if (item.source.type === 'builtin') {
          skills.push({
            sourceId: `builtin:${item.source.id}`,
            skillName: item.skill_name,
          });
        } else {
          onProgress?.(`Installing ${item.skill_name}...`);
          const installResult = await port.skills.installSkills(
            item.source.repo,
            [item.skill_name],
          );
          if (!installResult.success) {
            throw new Error(
              installResult.error ??
                `Failed to install skill "${item.skill_name}".`,
            );
          }
          skills.push({
            sourceId: `github:${item.source.repo.replace(/\//g, ':')}`,
            skillName: item.skill_name,
          });
        }
      } else if (item.type === 'claude_plugin') {
        plugins.push(
          await importSharedMarketplacePlugin(
            port,
            item.marketplace,
            item.plugin_name,
            { onProgress },
          ),
        );
      } else if (item.type === 'codex_plugin') {
        const imported = await installSharedPluginRef(port, item);
        if (imported.entity !== 'plugin') {
          throw new Error(
            `Codex plugin "${item.plugin_name}" did not resolve to a plugin.`,
          );
        }
        plugins.push({
          marketplaceId: imported.marketplaceId,
          pluginName: imported.pluginName,
        });
      } else if (item.type === 'custom_skill') {
        const skillDetail = detail.customSkills.find(
          (candidate) => candidate.id === item.skillId,
        );
        if (!skillDetail) {
          throw new Error(
            `Shared Collection custom skill "${item.skill_name}" is missing its detail payload.`,
          );
        }
        const imported = await importSharedSkill(port, {
          ...skillDetail,
          inCollection: true,
        });
        skills.push({ sourceId: 'custom:app', skillName: imported.skillName });
        if (imported.packageInstallError) {
          failures.push({
            label,
            required: item.required === true,
            message: imported.packageInstallError,
          });
        }
      } else {
        throw new Error('Shared Collection contains an unknown item type.');
      }
    } catch (error) {
      failures.push({
        label,
        required: item.required === true,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { skills, plugins, failures };
}
