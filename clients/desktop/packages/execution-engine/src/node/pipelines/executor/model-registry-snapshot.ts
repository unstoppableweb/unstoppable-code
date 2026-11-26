import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  OLLAMA_MODELS,
  getConfiguredSupportedThinkingLevelsMap,
  getConfiguredGatewayId,
  getGatewayModelEntries,
  getModelAliases,
} from '../../../model-catalog';
import { getModelHarnessAssignmentSnapshot } from '../../../model-harnesses';
import type { ModelRegistrySnapshot } from '../../../builtin-actions/_lib/model-registry';

/**
 * This process's model registry, as action subprocesses receive it in their
 * branded environment and a daemon launch carries it (CAN-5095). Parsed by
 * `hydrateModelRegistryFromEnv` and `applyModelRegistrySnapshot`.
 */
export function buildModelRegistrySnapshot(): ModelRegistrySnapshot & {
  readonly MODEL_CATALOG: string;
  readonly MODEL_HARNESS_ASSIGNMENTS: string;
} {
  const aliases = getModelAliases();
  const gatewayRoutes = getGatewayModelEntries();
  const supportedThinkingLevels = getConfiguredSupportedThinkingLevelsMap();
  return {
    ...(CLAUDE_MODELS.length > 0 && {
      CLAUDE_MODELS: JSON.stringify(CLAUDE_MODELS),
    }),
    ...(CODEX_MODELS.length > 0 && {
      CODEX_MODELS: JSON.stringify(CODEX_MODELS),
    }),
    ...(OLLAMA_MODELS.length > 0 && {
      OLLAMA_MODELS: JSON.stringify(OLLAMA_MODELS),
    }),
    ...(Object.keys(aliases).length > 0 && {
      MODEL_ALIASES: JSON.stringify(aliases),
    }),
    MODEL_CATALOG: JSON.stringify({
      version: 1,
      claudeModels: [...CLAUDE_MODELS],
      codexModels: [...CODEX_MODELS],
      // Policy identity must not depend on a live inference gateway route.
      policyModelIds: Object.fromEntries(
        [...CLAUDE_MODELS, ...CODEX_MODELS].map((model) => [
          model,
          getConfiguredGatewayId(model) ?? model,
        ]),
      ),
      ollamaModels: [...OLLAMA_MODELS],
      aiGatewayModels: gatewayRoutes
        .filter((route) => route.gatewayOnly)
        .map((route) => route.modelId),
      gatewayRoutes: gatewayRoutes.map((route) => ({
        modelId: route.modelId,
        gatewayId: route.gatewayId,
        family: route.family,
        recommendedHarness: route.recommendedHarness,
        gatewayOnly: route.gatewayOnly,
        contextWindow: route.contextWindow,
        supportsPromptCaching: route.supportsPromptCaching,
        supportedThinkingLevels: [...route.supportedThinkingLevels],
        toolSchemaProfile: route.toolSchemaProfile,
      })),
      modelAliases: aliases,
    }),
    MODEL_HARNESS_ASSIGNMENTS: JSON.stringify(
      getModelHarnessAssignmentSnapshot(),
    ),
    ...(Object.keys(supportedThinkingLevels).length > 0 && {
      MODEL_THINKING_LEVELS: JSON.stringify(supportedThinkingLevels),
    }),
  };
}
