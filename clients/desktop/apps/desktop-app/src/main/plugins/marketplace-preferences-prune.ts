import type { PreferencesData } from '@canopy/desktop-shared/types';
import { updatePreferencesFile } from '../lib/preferences-store';
import { pruneMarketplacePluginRefsFromValue } from './marketplace-plugin-ref-prune';
import { bumpGlobalPluginDefaultsRevision } from './plugin-defaults-revision';

/** Every top-level preference that saves plugin selections. */
const PLUGIN_SELECTION_KEYS = [
  'globalPluginSelections',
  'appAdvisorPluginSelections',
  'pipelineEditorPluginSelections',
  'branchNamingPluginSelections',
  'commitGenerationPluginSelections',
  'prGenerationPluginSelections',
  'worktreeSummaryPluginSelections',
] as const satisfies readonly (keyof PreferencesData)[];

/**
 * Remove a marketplace's saved plugin selections from preferences, inside
 * the preferences queue. Throws when the update is refused or fails; the
 * caller decides whether cleanup is best-effort.
 */
export async function pruneMarketplaceRefsFromPreferences(
  marketplaceId: string,
): Promise<void> {
  let globalDefaultsChanged = false;
  await updatePreferencesFile(
    (latest) => {
      globalDefaultsChanged = false;
      // Patch keys declare intent (a present `planModeHint` is a hint
      // update), so return only the selections this prune changed.
      const patch: Partial<PreferencesData> = {};
      let changed = false;
      for (const key of PLUGIN_SELECTION_KEYS) {
        const selections = structuredClone(latest[key]);
        if (pruneMarketplacePluginRefsFromValue(selections, marketplaceId)) {
          patch[key] = selections;
          changed = true;
        }
      }
      if (!changed) return null;
      globalDefaultsChanged = patch.globalPluginSelections !== undefined;
      return patch;
    },
    () => {
      // The committed value, not the discovery snapshot, owns invalidation.
      if (globalDefaultsChanged) bumpGlobalPluginDefaultsRevision();
    },
  );
}
