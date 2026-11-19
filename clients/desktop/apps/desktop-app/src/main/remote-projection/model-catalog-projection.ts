import { agentCatalogHarnesses } from './agent-catalog-compatibility';
import { isSelectableAgentOverrideModel } from '@canopy/execution-engine/model-catalog';
import { isConcreteAgentModel } from '@canopy/protocol/models';
import { isAntigravityHarnessEnabled } from '../antigravity/feature-flag';
import { isOpenCodeHarnessEnabled } from '../opencode/feature-flag';
import { isCopilotHarnessEnabled } from '../copilot/feature-flag';
// ---------------------------------------------------------------------------
// Projects the desktop's runtime model registry into the browser-safe
// `ModelCatalog` wire contract (CAN-1218) so the portal model picker can show
// the SAME models the connected desktop actually has.
//
// The registry (`CLAUDE_MODELS` / `CODEX_MODELS` / `OLLAMA_MODELS` /
// `AGENT_MODELS`) is populated at runtime from this host's package.json pins,
// live Ollama discovery, LaunchDarkly-gated entries, and custom Agent overlays,
// so the catalog is derived here (in main) at projection time rather than being
// a static constant the web could import.
//
// Per-row field derivation lives in the shared
// `@canopy/desktop-shared/lib/model-catalog-projection` builder (CAN-2540) so
// this projection and the renderer picker cannot drift; this module only owns
// row enumeration, org-policy filtering, and ordering. Family metadata comes
// from the shared runtime lookup (`replaceModelFamilyMetadata`, populated by
// `loadModelsFromPackageJson` before any portal client exists) rather than a
// second package.json read.
// ---------------------------------------------------------------------------

import type {
  ModelCatalog,
  ModelCatalogHarnessChoice,
  ModelCatalogOption,
} from '@canopy/protocol/models';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  buildModelCatalogOption,
  getModelCatalogHarnessChoices,
} from '@canopy/desktop-shared/lib/model-catalog-projection';
import {
  ANTIGRAVITY_MODELS,
  AGENT_MODELS,
  APP_ADVISOR_PROJECT_ID,
  CLAUDE_MODELS,
  CODEX_ACCOUNT_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  COPILOT_MODELS,
  OPENCODE_MODELS,
  OLLAMA_MODELS,
  getEffectiveSupportedThinkingLevelsForModel,
  getGatewayModelEntries,
  pinInheritingAgentModel,
  resolveAgentModelDefinition,
  resolveModelAlias,
} from '@canopy/desktop-shared/types';
import { isCursorHarnessEnabled } from '../cursor/feature-flag';
import { isModelBlockedByCurrentPolicy } from '../lib/model-policy-state';
import { getLastProjectedDefaultModel } from '../lib/default-model-lane-resolver';
import { isModelExcludedByCurrentGatewayRequirement } from '../lib/model-gateway-state';

/** The retained App Advisor settings reader already supplies its resolved default. */
export function buildProjectedAppAdvisorModelCatalog(
  defaultModel: string | undefined,
  options: NonNullable<Parameters<typeof buildProjectedModelCatalog>[1]>,
): ModelCatalog {
  return buildProjectedModelCatalog(defaultModel, {
    ...options,
    projectId: APP_ADVISOR_PROJECT_ID,
  });
}

/**
 * Build a flat, serializable snapshot of every model + custom Agent the desktop
 * can currently offer, for projection on `PortalChatSummaryEntity.availableModels`.
 * Order matches the desktop picker: Claude, then Codex, then Ollama, then
 * Cursor, then Agents.
 *
 * Cursor rows are the models the desktop has discovered from its managed
 * runtime (`CURSOR_MODELS`: the persisted default plus whatever the last
 * discovery published), gated on the rollout flag and on the caller opting
 * in with `options.cursor`: worktree, App Advisor, and Cowork chats dispatch
 * Cursor, so their projections carry its rows.
 * Whether the runtime is currently connected is projected separately on
 * `providerAvailability.cursor`, so the rows themselves stay `available`.
 */
export function buildProjectedModelCatalog(
  defaultModel: string | undefined,
  options: {
    antigravity?: boolean;
    cursor?: boolean;
    copilot?: boolean;
    opencode?: boolean;
    owner?: WorkOwner;
    projectId?: string;
    /**
     * The model this catalog's destination pins an Agent on the default model
     * to (`resolveCatalogAgentDefaultModel`). Required, so no caller describes
     * those Agents by another destination's default.
     */
    agentDefaultModel: string | undefined;
  } = { agentDefaultModel: undefined },
): ModelCatalog {
  defaultModel ??= getLastProjectedDefaultModel();
  const catalog: ModelCatalogOption[] = [];
  const openCodeEnabled =
    options.opencode === true && isOpenCodeHarnessEnabled();
  const antigravityEnabled =
    options.antigravity === true && isAntigravityHarnessEnabled();
  const projectChoice = (option: ModelCatalogOption): void => {
    const preferredSurfaceSupported =
      (antigravityEnabled ||
        ![option.provider, option.harness, option.source].includes(
          'antigravity',
        )) &&
      (openCodeEnabled ||
        ![option.provider, option.harness, option.source].includes('opencode'));
    if (
      !preferredSurfaceSupported &&
      (option.kind !== 'agent' ||
        (option.agentSelection !== undefined &&
          !option.agentSelection.supportedModels.length))
    )
      return;
    // The bare Agent's preferred route can be unavailable while an explicit route works.
    const projected = preferredSurfaceSupported
      ? option
      : { ...option, available: false };
    if (openCodeEnabled && antigravityEnabled) {
      catalog.push(projected);
      return;
    }
    const { harnessChoices, ...legacy } = projected;
    const choices = harnessChoices?.filter(
      (choice) =>
        (openCodeEnabled || choice.harness !== 'opencode') &&
        (antigravityEnabled || choice.harness !== 'antigravity'),
    );
    catalog.push(
      choices?.length ? { ...legacy, harnessChoices: choices } : legacy,
    );
  };
  const push = (
    id: string,
    provider:
      | 'claude'
      | 'codex'
      | 'ollama'
      | 'cursor'
      | 'copilot'
      | 'antigravity'
      | 'opencode',
  ): void => {
    const option = buildModelCatalogOption(id, { provider, defaultModel });
    if (!option) return;
    // Remote pickers need every runtime choice, not only the desktop display subset.
    const choices = getModelCatalogHarnessChoices(id).map(
      (choice): ModelCatalogHarnessChoice => ({
        ...choice,
        provider: provider === 'ollama' ? provider : choice.provider,
        supportedThinkingLevels:
          choice.supportedThinkingLevels ??
          getEffectiveSupportedThinkingLevelsForModel(
            id,
            false,
            choice.harness,
            choice.harness,
          ),
      }),
    );
    projectChoice(
      choices.length ? { ...option, harnessChoices: choices } : option,
    );
  };
  const excluded = (id: string): boolean =>
    isModelExcludedByCurrentGatewayRequirement(id, options.owner) ||
    isModelBlockedByCurrentPolicy(id, options.owner);
  for (const id of CLAUDE_MODELS) {
    if (!excluded(id)) push(id, 'claude');
  }
  for (const id of CODEX_MODELS) {
    if (!excluded(id)) push(id, 'codex');
  }
  // The signed-in ChatGPT account's own Codex models the catalog does not
  // list (CAN-4716), so a Portal "Use <model>" switch can name one.
  for (const id of CODEX_ACCOUNT_MODELS) {
    if (!excluded(id)) push(id, 'codex');
  }
  for (const id of OLLAMA_MODELS) {
    if (!excluded(id)) push(id, 'ollama');
  }
  if (antigravityEnabled) {
    for (const id of ANTIGRAVITY_MODELS)
      if (!excluded(id)) push(id, 'antigravity');
  }
  if (options.cursor === true && isCursorHarnessEnabled()) {
    for (const id of CURSOR_MODELS) {
      if (!excluded(id)) push(id, 'cursor');
    }
  }
  if (options.copilot === true && isCopilotHarnessEnabled()) {
    for (const id of COPILOT_MODELS) if (!excluded(id)) push(id, 'copilot');
  }
  if (options.opencode === true && isOpenCodeHarnessEnabled())
    for (const id of OPENCODE_MODELS) if (!excluded(id)) push(id, 'opencode');
  const projectedIds = new Set(catalog.map((option) => option.id));
  for (const route of getGatewayModelEntries()) {
    if (
      !route.gatewayOnly ||
      projectedIds.has(route.modelId) ||
      excluded(route.modelId)
    ) {
      continue;
    }
    push(route.modelId, route.recommendedHarness);
    projectedIds.add(route.modelId);
  }
  const concreteModels = [...catalog].filter(
    (row) => row.kind === 'model' && isSelectableAgentOverrideModel(row.id),
  );
  for (const id of AGENT_MODELS) {
    const compatible = agentCatalogHarnesses(options.projectId, id);
    const supportedModels = concreteModels.flatMap((row) => {
      const harnesses = (
        row.harnessChoices?.map((choice) => choice.harness) ??
        (row.harness ? [row.harness] : [])
      ).filter((harness) => compatible?.has(harness));
      return harnesses.length ? [{ modelId: row.id, harnesses }] : [];
    });
    const routeId = pinInheritingAgentModel(id, options.agentDefaultModel);
    const baseModel = resolveAgentModelDefinition(routeId)?.baseModel;
    const preferredModel = baseModel ? resolveModelAlias(baseModel) : undefined;
    const preferredExcluded = excluded(routeId);
    if (preferredExcluded && compatible && !supportedModels.length) continue;
    const option = buildModelCatalogOption(id, {
      provider: 'claude',
      defaultModel,
      agentDefaultModel: options.agentDefaultModel,
    });
    if (option)
      projectChoice({
        ...option,
        available: option.available && !preferredExcluded,
        ...(compatible
          ? {
              agentSelection: {
                ...(isConcreteAgentModel(preferredModel)
                  ? { preferredModel }
                  : {}),
                supportedModels,
              },
            }
          : {}),
      });
  }
  return catalog;
}
