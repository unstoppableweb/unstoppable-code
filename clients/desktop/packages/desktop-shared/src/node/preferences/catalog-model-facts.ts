import { isGatewayRoutableModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import type { PreferencesModelFacts } from '@canopy/protocol/preferences';
import { isNativeModelPreferenceOption } from '../../lib/model-thinking-preference';
import {
  clampThinkingLevelForModel,
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForModel,
  isOllamaModel,
  resolveKnownModel,
  resolveModelAlias,
} from '../../types';

/** What a host decides itself; the rest is read from the process's live model catalog. */
export type PreferencesModelHostFacts = Pick<
  PreferencesModelFacts,
  'status' | 'ollamaEnabled' | 'shortcutPlatform'
>;

/** Model facts over this process's live model catalog. */
export function createCatalogPreferencesModelFacts(
  host: PreferencesModelHostFacts,
): PreferencesModelFacts {
  return {
    status: (model) => host.status(model),
    resolveModelAlias: (model) => resolveModelAlias(model),
    resolveKnownModel: (model) => resolveKnownModel(model),
    executionHarness: (model) => getExecutionHarnessForModel(model),
    modelSource: (model) => getModelSource(model),
    provider: (model) => getProviderForModel(model),
    isOllamaModel: (model) => isOllamaModel(model),
    clampThinkingLevel: (level, model) =>
      clampThinkingLevelForModel(level, model),
    isGatewayRoutable: (model) => isGatewayRoutableModel(model),
    isNativePreferenceOption: (model, includeOllama) =>
      isNativeModelPreferenceOption(model, includeOllama),
    ollamaEnabled: () => host.ollamaEnabled(),
    shortcutPlatform: () => host.shortcutPlatform(),
  };
}
