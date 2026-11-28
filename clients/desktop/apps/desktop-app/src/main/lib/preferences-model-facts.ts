import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type {
  PreferencesModelFacts,
  PreferencesModelStatus,
} from '@canopy/protocol/preferences';
import { toShortcutPlatform } from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { createCatalogPreferencesModelFacts } from '@canopy/desktop-shared/node/preferences/catalog-model-facts';
import { resolveAvailableModel } from './model-availability';

/** The live catalog always answers, so the desktop never says `unknown`. */
function catalogStatus(
  model: string,
): Exclude<PreferencesModelStatus, 'unknown'> {
  return resolveAvailableModel(model) === null ? 'unavailable' : 'available';
}

/** The desktop's model facts, over the live model catalog. */
export const ELECTRON_PREFERENCES_MODEL_FACTS: PreferencesModelFacts =
  createCatalogPreferencesModelFacts({
    status: catalogStatus,
    ollamaEnabled: () => __CANOPY_OLLAMA_ENABLED__,
    shortcutPlatform: () =>
      toShortcutPlatform(hostOperatingSystem() ?? 'linux'),
  });
