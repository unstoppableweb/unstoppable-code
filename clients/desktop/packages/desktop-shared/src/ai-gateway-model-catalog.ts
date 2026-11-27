import type { AiGatewayModelCatalogResponse } from '@canopy/protocol/ai-gateway-models';
import type { ModelGatewayModel } from '@canopy/protocol/canopy-server';
import type { ClientFeatureFlagValues } from '@canopy/protocol/feature-flags';
import type { GatewayModelConfig } from '@canopy/protocol/llm-gateway';
import type { NormalizedModelPackageConfig } from './model-config';
import type {
  AiGatewayModelEntry,
  ClaudeModelEntry,
  CodexModelEntry,
  GatewayRouteEntry,
  ThinkingLevel,
} from './types';
import {
  orgGatewayModelId,
  type OrgGatewayModelAliases,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { orgGatewayVendor } from '@canopy/protocol/model-gateway/vendor';

export interface OrgGatewayCatalogInput {
  personal?: boolean;
  organizationId: string;
  organizationName: string;
  baseUrl: string;
  models: readonly ModelGatewayModel[];
  promptCachePassthrough: boolean;
}

export interface MergedAiGatewayModelCatalog {
  claudeModels: ClaudeModelEntry[];
  codexModels: CodexModelEntry[];
  aiGatewayModels: AiGatewayModelEntry[];
  gatewayRoutes: GatewayRouteEntry[];
  modelAliases: Record<string, string>;
  orgGatewayModelAliases: OrgGatewayModelAliases;
}

function packageModelEnabled(
  entry: ClaudeModelEntry | CodexModelEntry,
  featureFlags: Partial<ClientFeatureFlagValues>,
): boolean {
  return !entry.featureFlag || featureFlags[entry.featureFlag] === true;
}

/**
 * Materialize the wire catalog's implicit `off` when projecting gateway rows
 * into desktop registry entries. Catalog wire versions that predate the `off`
 * enum value keep it implicit ("`off` is implicit and not stored"), but the
 * desktop projection is the host declaring the level set, so a
 * thinking-capable route must carry `off` explicitly — otherwise clamping
 * `off` on an AI-Credits route falls to the lowest thinking tier. Rows that
 * already declare `off` pass through unchanged, and an empty set still means
 * "thinking unsupported" and stays empty.
 */
function materializeGatewayThinkingLevels(
  levels: readonly ThinkingLevel[],
  exact: boolean,
): ThinkingLevel[] {
  if (exact || levels.length === 0 || levels.includes('off')) {
    return [...levels];
  }
  return ['off', ...levels];
}

function gatewayConfig(
  model: AiGatewayModelCatalogResponse['models'][number],
  gatewayOnly: boolean,
  route?: Pick<
    GatewayRouteEntry,
    'origin' | 'baseUrl' | 'organizationId' | 'promptCachePassthrough'
  >,
): GatewayModelConfig {
  return {
    gatewayId: model.gatewayId,
    family: model.family,
    recommendedHarness: model.recommendedHarness,
    gatewayOnly,
    contextWindow: model.contextWindow,
    supportsPromptCaching: model.supportsPromptCaching,
    supportsImages: model.supportsImages === true,
    supportedThinkingLevels: materializeGatewayThinkingLevels(
      model.supportedThinkingLevels,
      model.thinkingLevelsExact === true,
    ),
    toolSchemaProfile: model.toolSchemaProfile,
    ...route,
  };
}

/**
 * Merge package-owned native harness models with the validated operational AI
 * Gateway catalog. Matching is deliberately exact and only by `gatewayId`.
 */
export function mergeAiGatewayModelCatalog(input: {
  packageConfig: NormalizedModelPackageConfig;
  catalog?: AiGatewayModelCatalogResponse;
  featureFlags?: Partial<ClientFeatureFlagValues>;
  orgGateways?: readonly OrgGatewayCatalogInput[];
}): MergedAiGatewayModelCatalog {
  const featureFlags = input.featureFlags ?? {};
  const allPackageModels = [
    ...input.packageConfig.claudeModels,
    ...input.packageConfig.codexModels,
  ];
  const reservedIds = new Set([
    ...allPackageModels.map((entry) => entry.id),
    ...Object.keys(input.packageConfig.modelAliases),
  ]);
  const disabledGatewayIds = new Set(
    allPackageModels
      .filter((entry) => !packageModelEnabled(entry, featureFlags))
      .flatMap((entry) => (entry.gatewayId ? [entry.gatewayId] : [])),
  );
  const enabledClaude = input.packageConfig.claudeModels.filter((entry) =>
    packageModelEnabled(entry, featureFlags),
  );
  const enabledCodex = input.packageConfig.codexModels.filter((entry) =>
    packageModelEnabled(entry, featureFlags),
  );
  const enabledPackageGatewayIds = new Set(
    [...enabledClaude, ...enabledCodex].flatMap((entry) =>
      entry.gatewayId ? [entry.gatewayId] : [],
    ),
  );
  const hostedSources: Array<{
    model: AiGatewayModelCatalogResponse['models'][number];
  }> = (input.catalog?.models ?? []).map((model) => ({ model }));
  const apiByGatewayId = new Map(
    hostedSources.map((source) => [source.model.gatewayId, source]),
  );
  const matchedGatewayIds = new Set<string>();

  const mergePackageEntry = <T extends ClaudeModelEntry | CodexModelEntry>(
    entry: T,
    packageHarness: 'claude' | 'codex',
  ): T => {
    const source = entry.gatewayId
      ? apiByGatewayId.get(entry.gatewayId)
      : undefined;
    if (!source) {
      return { ...entry };
    }
    const { model } = source;
    matchedGatewayIds.add(model.gatewayId);
    if (model.recommendedHarness !== packageHarness) {
      return { ...entry };
    }
    return {
      // Package-owned identity and picker grouping stay authoritative. The
      // catalog's vendor family belongs to gateway routing metadata below and
      // must not replace the package's Claude/Codex family.
      ...entry,
      ...(model.cursorModelId ? { cursorModelId: model.cursorModelId } : {}),
      // Catalog copy wins; the package description remains the offline
      // fallback. Deliberately a fallback and not an override: clearing a
      // description on a package-pinned model reverts its subtitle to the
      // shipped package copy rather than blanking it, so these models read the
      // same online, offline, and before the first refresh. Only gateway-only
      // models (no package entry) can have no subtitle at all.
      ...(model.description ? { description: model.description } : {}),
      showMoreOnly: entry.showMoreOnly ?? model.showMoreOnly,
      gateway: gatewayConfig(model, false),
    };
  };

  const claudeModels = enabledClaude.map((entry) =>
    mergePackageEntry(entry, 'claude'),
  );
  const codexModels = enabledCodex.map((entry) =>
    mergePackageEntry(entry, 'codex'),
  );
  const aiGatewayModels: AiGatewayModelEntry[] = [];

  const packageSortOrderCeiling = Math.max(
    0,
    ...allPackageModels.map((entry) => entry.sortOrder ?? 0),
  );
  for (
    let sourceIndex = 0;
    sourceIndex < hostedSources.length;
    sourceIndex += 1
  ) {
    const source = hostedSources[sourceIndex];
    if (!source) continue;
    const { model } = source;
    if (
      matchedGatewayIds.has(model.gatewayId) ||
      enabledPackageGatewayIds.has(model.gatewayId) ||
      disabledGatewayIds.has(model.gatewayId) ||
      model.requiresLocalHarnessSupport ||
      reservedIds.has(model.id) ||
      model.id.startsWith('ollama-')
    ) {
      continue;
    }
    reservedIds.add(model.id);
    aiGatewayModels.push({
      id: model.id,
      ...(model.cursorModelId ? { cursorModelId: model.cursorModelId } : {}),
      label: model.label,
      family: model.family,
      familyLabel: model.familyLabel,
      vendor: model.family,
      sortOrder: packageSortOrderCeiling + sourceIndex + 1,
      ...(model.description ? { description: model.description } : {}),
      showMoreOnly: model.showMoreOnly,
      recommendedHarness: model.recommendedHarness,
      contextWindow: model.contextWindow,
      supportsPromptCaching: model.supportsPromptCaching,
      supportsImages: model.supportsImages === true,
      supportedThinkingLevels: materializeGatewayThinkingLevels(
        model.supportedThinkingLevels,
        model.thinkingLevelsExact === true,
      ),
      toolSchemaProfile: model.toolSchemaProfile,
    });
  }

  const sortedOrgGateways = [...(input.orgGateways ?? [])].sort((left, right) =>
    left.organizationId.localeCompare(right.organizationId),
  );
  const orgIdCounts = new Map<string, number>();
  for (const gateway of sortedOrgGateways) {
    for (const model of gateway.models) {
      orgIdCounts.set(model.id, (orgIdCounts.get(model.id) ?? 0) + 1);
    }
  }
  const orgGatewayModelAliases: Record<string, Record<string, string>> = {};
  // Gateway rows are always `<id>@<orgId>`. A bare id saved before that rule
  // keeps resolving while exactly one gateway lists it and no hosted or
  // package model owns it; otherwise it is ambiguous and resolves to nothing.
  const bareGatewayAliases: Record<string, string> = {};
  const orgSources: Array<{
    model: AiGatewayModelCatalogResponse['models'][number];
    route: Pick<
      GatewayRouteEntry,
      'origin' | 'baseUrl' | 'organizationId' | 'promptCachePassthrough'
    >;
  }> = [];
  for (const gateway of sortedOrgGateways) {
    for (const orgModel of gateway.models) {
      if (orgModel.id.startsWith('ollama-')) continue;
      const modelId = orgGatewayModelId(orgModel.id, gateway.organizationId);
      if (orgIdCounts.get(orgModel.id) === 1 && !reservedIds.has(orgModel.id)) {
        bareGatewayAliases[orgModel.id] = modelId;
      }
      reservedIds.add(modelId);
      const aliasesForModel = orgGatewayModelAliases[orgModel.id] ?? {};
      aliasesForModel[gateway.organizationId] = modelId;
      orgGatewayModelAliases[orgModel.id] = aliasesForModel;
      const model: AiGatewayModelCatalogResponse['models'][number] = {
        id: modelId,
        gatewayId: orgModel.gatewayId,
        label: orgModel.label,
        family: 'custom',
        familyLabel: gateway.organizationName,
        recommendedHarness: orgModel.harness,
        contextWindow: orgModel.contextWindow,
        supportsPromptCaching: gateway.promptCachePassthrough,
        supportsImages: false,
        requiresLocalHarnessSupport: false,
        showMoreOnly: false,
        supportedThinkingLevels: orgModel.supportedThinkingLevels,
        toolSchemaProfile: orgModel.toolSchemaProfile,
      };
      const route = {
        origin: 'org-gateway' as const,
        baseUrl: gateway.baseUrl,
        organizationId: gateway.organizationId,
        promptCachePassthrough: gateway.promptCachePassthrough,
      };
      orgSources.push({ model, route });
      aiGatewayModels.push({
        id: model.id,
        label: model.label,
        family: 'custom',
        familyLabel: gateway.organizationName,
        vendor: orgGatewayVendor(gateway.organizationId),
        sortOrder:
          packageSortOrderCeiling + hostedSources.length + orgSources.length,
        showMoreOnly: false,
        recommendedHarness: model.recommendedHarness,
        contextWindow: model.contextWindow,
        supportsPromptCaching: model.supportsPromptCaching,
        supportsImages: model.supportsImages === true,
        supportedThinkingLevels: materializeGatewayThinkingLevels(
          model.supportedThinkingLevels,
          model.thinkingLevelsExact === true,
        ),
        toolSchemaProfile: model.toolSchemaProfile,
      });
    }
  }

  const enabledIds = new Set([
    ...claudeModels.map((entry) => entry.id),
    ...codexModels.map((entry) => entry.id),
  ]);
  const modelAliases = {
    ...Object.fromEntries(
      Object.entries(input.packageConfig.modelAliases).filter(([, canonical]) =>
        enabledIds.has(canonical),
      ),
    ),
    ...bareGatewayAliases,
  };

  const gatewayRoutes: GatewayRouteEntry[] = [
    ...claudeModels,
    ...codexModels,
  ].flatMap((entry) =>
    entry.gateway
      ? [
          {
            modelId: entry.id,
            gatewayId: entry.gateway.gatewayId,
            family: entry.gateway.family,
            recommendedHarness: entry.gateway.recommendedHarness,
            gatewayOnly: entry.gateway.gatewayOnly,
            contextWindow: entry.gateway.contextWindow,
            supportsPromptCaching: entry.gateway.supportsPromptCaching,
            supportsImages: entry.gateway.supportsImages === true,
            supportedThinkingLevels: [...entry.gateway.supportedThinkingLevels],
            toolSchemaProfile: entry.gateway.toolSchemaProfile,
            origin: entry.gateway.origin,
            baseUrl: entry.gateway.baseUrl,
            organizationId: entry.gateway.organizationId,
            promptCachePassthrough: entry.gateway.promptCachePassthrough,
          },
        ]
      : [],
  );
  gatewayRoutes.push(
    ...aiGatewayModels.flatMap((entry) => {
      const orgSource = orgSources.find(
        (candidate) => candidate.model.id === entry.id,
      );
      const source =
        orgSource ??
        hostedSources.find((candidate) => candidate.model.id === entry.id);
      return source
        ? [
            {
              modelId: entry.id,
              gatewayId: source.model.gatewayId,
              family: source.model.family,
              recommendedHarness: entry.recommendedHarness,
              gatewayOnly: true,
              contextWindow: entry.contextWindow,
              supportsPromptCaching: entry.supportsPromptCaching,
              supportsImages: source.model.supportsImages === true,
              // The entry's levels were already materialized above.
              supportedThinkingLevels: [...entry.supportedThinkingLevels],
              toolSchemaProfile: entry.toolSchemaProfile,
              origin: orgSource?.route.origin,
              baseUrl: orgSource?.route.baseUrl,
              organizationId: orgSource?.route.organizationId,
              promptCachePassthrough: orgSource?.route.promptCachePassthrough,
            },
          ]
        : [];
    }),
  );

  return {
    claudeModels,
    codexModels,
    aiGatewayModels,
    gatewayRoutes,
    modelAliases,
    orgGatewayModelAliases,
  };
}
