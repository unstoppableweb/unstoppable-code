import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { SharedImportPort } from '@canopy/desktop-shared/lib/shared-import/port';
import { installSkillsThroughCore } from '../canopy-runtime/skill-catalog-dispatch';
import { getFeatureFlagService } from '../feature-flags';
import {
  addMarketplaceForCaller,
  installBuiltInPluginForCaller,
  installPluginForCaller,
  refreshMarketplacesForCaller,
} from '../plugins/plugin-handlers';
import * as pluginService from '../plugins/plugin-service';
import {
  getSharedSkillForCaller,
  installSkillPackageForCaller,
  loadSkillsForCaller,
  recordSkillShareOriginForCaller,
  writeRawSkillForCaller,
} from '../skills/skill-handlers';
import { readRawSkill } from '../skills/skill-service';

/**
 * A shared import in Electron main (CAN-6003): the owners the window's skill
 * and plugin handlers call, with no progress events. `remote` is whether a
 * controlling computer drives the chat: its window ran this import before,
 * so a plugin install keeps the remote principal's source checks (CAN-5764).
 */
export function mainSharedImportPort(options: {
  remote: boolean;
}): SharedImportPort {
  return {
    skills: {
      loadSkills: () => loadSkillsForCaller(),
      readRawSkill: (skillId) => readRawSkill(skillId),
      writeRawSkill: (input) => writeRawSkillForCaller(input),
      installSkills: (source, skillNames) =>
        installSkillsThroughCore(source, skillNames),
      getShared: (skillId) => getSharedSkillForCaller(skillId),
      installCapabilityPackage: (request) =>
        installSkillPackageForCaller(request),
      recordShareOrigin: (request) => recordSkillShareOriginForCaller(request),
    },
    plugins: {
      loadMarketplaces: () => pluginService.loadMarketplacesForPresentation(),
      loadMarketplacesCacheOnly: () =>
        pluginService.loadMarketplacesForPresentation(undefined, true),
      refreshMarketplaces: (providerUpdates) =>
        refreshMarketplacesForCaller(providerUpdates),
      addMarketplace: (repo) => addMarketplaceForCaller(repo),
      installPlugin: (marketplaceId, pluginName, sourceUrl) =>
        installPluginForCaller({
          marketplaceId,
          pluginName,
          sourceUrl,
          remote: options.remote,
        }),
      installBuiltInPlugin: (request) => installBuiltInPluginForCaller(request),
    },
    receiptsEnforced: () =>
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      ),
  };
}
