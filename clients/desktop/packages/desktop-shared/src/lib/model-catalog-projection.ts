// ---------------------------------------------------------------------------
// Shared per-row projection of the desktop model registry onto the
// browser-safe `ModelCatalogOption` wire contract (CAN-1218 / CAN-2540).
//
// Two independent projections used to exist — the renderer picker's
// `rowToCatalogOption` and the main-process portal projection — and they had
// drifted: the renderer omitted `isDefault`/`harness`/`source`/
// `supportedThinkingLevels`/`thinkingLevels`/`contextWindow`, the portal
// omitted the gateway-only extra-charge marker and the Agent rows' declared
// thinking set. This module is the single field-level source of truth; both
// surfaces call it per row and only differ in which rows they enumerate and
// which policy/ordering they apply.
//
// Browser-safe on purpose: only registry helpers from `../types`,
// `../model-config`, and the pure gateway-availability helper — no Node,
// Electron, React, or app imports — so the renderer may import it directly.
// ---------------------------------------------------------------------------

import type {
  ModelCatalogOption,
  ModelCatalogHarnessChoice,
  ModelCatalogProvider,
  ModelCatalogThinkingLevel,
} from '@canopy/protocol/models';
import type { BuildModelCatalogOptionInput } from '../types/model-catalog';
import { getModelFamilyMetadata } from '../model-config';
import { matchAiGatewayPreset } from '@canopy/protocol/model-gateway/presets';
import { getManagedModelVendor } from './managed-model-vendor';
import {
  getCanonicalPickerModel,
  getAiGatewayModelEntry,
  getChatHarnessOptions,
  getEffectiveSupportedThinkingLevelsForModel,
  getModelBillingMetadata,
  getListedModelContextWindow,
  getModelDescription,
  getModelShowMoreOnly,
  getModelDisplayName,
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForModel,
  getThinkingUiOptionsForProvider,
  pinInheritingAgentModel,
  resolveAgentModelDefinition,
} from '../types';
import {
  isGatewayOnlyModel,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { isOpenCodeGatewayRouteSupported } from './opencode-gateway-models';

// Stale Agents still need a stable catalog section for display. This explicit
// grouping default is not used to select a provider for runtime dispatch.
const STALE_AGENT_DISPLAY_PROVIDER: Exclude<ModelCatalogProvider, 'unknown'> =
  'claude';

/**
 * Per-model thinking efforts for composer cycles, in ascending order.
 *
 * Reuses the exact helper the desktop picker uses, so a model offers the same
 * tiers on both surfaces. `ThinkingUiLevel` and `ModelCatalogThinkingLevel` are
 * the same closed set of strings declared in two dependency-isolated modules.
 */
function projectedThinkingLevels(
  id: string,
  provider: Exclude<ModelCatalogProvider, 'unknown'>,
): ModelCatalogThinkingLevel[] {
  return getThinkingUiOptionsForProvider(provider, id).map(
    (option) => option.value,
  );
}

function normalizedModelSource(
  id: string,
): ModelCatalogOption['source'] | undefined {
  const modelSource = getModelSource(id);
  if (modelSource === 'antigravity-managed') return 'antigravity';
  if (modelSource === 'copilot-managed') return 'copilot';
  if (modelSource === 'opencode-managed') return 'opencode';
  return modelSource === 'claude-managed'
    ? 'claude'
    : modelSource === 'cursor-managed'
      ? 'cursor'
      : modelSource === 'codex-managed'
        ? 'codex'
        : modelSource;
}

function harnessChoiceFields(
  id: string,
): Pick<ModelCatalogOption, 'harnessChoices'> {
  const choices = getChatHarnessOptions(id).flatMap(
    (harness): ModelCatalogHarnessChoice[] => {
      // Cursor admission requires its opaque managed ID. Those models have
      // their own catalog rows; this choice retains the current row's ID.
      if (harness === 'cursor' && getModelSource(id) !== 'cursor-managed')
        return [];
      if (harness !== 'opencode') return [{ harness, provider: harness }];
      const route = resolveGatewayModelEntry(id);
      if (!route || !isOpenCodeGatewayRouteSupported(route)) return [];
      return [
        {
          harness,
          provider: harness,
          supportedThinkingLevels: [],
          contextWindow: route.contextWindow,
          supportsImages: route.supportsImages === true,
          supportsFastMode: false,
          funding:
            route.origin === 'org-gateway' ? 'org-gateway' : 'ai-credits',
        },
      ];
    },
  );
  return choices.some((choice) => choice.harness === 'opencode')
    ? { harnessChoices: choices }
    : {};
}

/**
 * A row served by a user's or organization's own gateway says so, so no
 * surface bills or labels it as hosted AI Credits. Hosted rows stay unset;
 * their source already says where they run.
 */
function gatewayFundingField(
  id: string,
): Pick<ModelCatalogOption, 'funding' | 'gatewayPresetId'> {
  const entry = resolveGatewayModelEntry(id);
  if (entry?.origin !== 'org-gateway') return {};
  // CAN-6444: which preset gateway serves it, for the picker's gateway tab.
  const presetId = matchAiGatewayPreset(entry.baseUrl)?.id;
  return {
    funding: 'org-gateway',
    ...(presetId ? { gatewayPresetId: presetId } : {}),
  };
}

function providerModelOption(
  id: string,
  input: BuildModelCatalogOptionInput,
): ModelCatalogOption {
  const canonicalModelId = getCanonicalPickerModel(id);
  const billing = getModelBillingMetadata(id);
  const contextWindow = getListedModelContextWindow(id);
  const gatewayCatalogEntry = getAiGatewayModelEntry(canonicalModelId);
  const family =
    getModelFamilyMetadata(canonicalModelId) ??
    (gatewayCatalogEntry?.family &&
    gatewayCatalogEntry.familyLabel &&
    gatewayCatalogEntry.vendor
      ? {
          family: gatewayCatalogEntry.family,
          familyLabel: gatewayCatalogEntry.familyLabel,
          vendor: gatewayCatalogEntry.vendor,
          ...(gatewayCatalogEntry.sortOrder === undefined
            ? {}
            : { sortOrder: gatewayCatalogEntry.sortOrder }),
        }
      : undefined);
  const vendor = family?.vendor ?? getManagedModelVendor(id);
  const description = getModelDescription(id);
  const showMoreOnly = getModelShowMoreOnly(id);
  const effectiveHarness = getExecutionHarnessForModel(id);
  const source = normalizedModelSource(id);
  const resolvedProvider: Exclude<ModelCatalogProvider, 'unknown'> =
    getModelSource(id) === 'ollama'
      ? 'ollama'
      : (effectiveHarness ?? input.provider);
  const extraChargeOnly =
    billing?.extraChargeOnly === true || isGatewayOnlyModel(id);
  return {
    id,
    ...(canonicalModelId !== id ? { canonicalModelId } : {}),
    label: getModelDisplayName(id),
    ...(description ? { description } : {}),
    ...(showMoreOnly ? { showMoreOnly: true } : {}),
    provider: resolvedProvider,
    source: source ?? input.provider,
    ...(effectiveHarness ? { harness: effectiveHarness } : {}),
    ...harnessChoiceFields(id),
    ...gatewayFundingField(id),
    kind: 'model',
    available: true,
    ...(id === input.defaultModel ? { isDefault: true } : {}),
    supportedThinkingLevels: getEffectiveSupportedThinkingLevelsForModel(
      id,
      false,
      resolvedProvider,
    ),
    thinkingLevels: projectedThinkingLevels(id, resolvedProvider),
    ...(effectiveHarness === 'antigravity'
      ? { vendor: 'google', supportsImages: false, supportsFastMode: false }
      : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(vendor ? { vendor } : {}),
    ...(family ?? {}),
    ...(extraChargeOnly ? { extraChargeOnly: true } : {}),
    ...(billing?.extraChargeMessage
      ? { extraChargeMessage: billing.extraChargeMessage }
      : {}),
  };
}

function agentModelOption(
  id: string,
  input: BuildModelCatalogOptionInput,
): ModelCatalogOption | undefined {
  const named = resolveAgentModelDefinition(id);
  if (!named) return undefined;
  // An Agent that inherits the default is described by the route it would
  // run on here; the row keeps the bare id so selecting it sends the Agent.
  const routeId = pinInheritingAgentModel(id, input.agentDefaultModel);
  const entry = resolveAgentModelDefinition(routeId) ?? named;
  // `getProviderForModel` resolves an available Agent to its base-model
  // provider and falls back to `claude` for a stale base; either way the row
  // groups under a real provider section and gates on `available`.
  const provider =
    getProviderForModel(entry.baseModel) ?? STALE_AGENT_DISPLAY_PROVIDER;
  const executionHarness = getExecutionHarnessForModel(routeId);
  const source = normalizedModelSource(routeId);
  const billing = getModelBillingMetadata(routeId);
  const description = getModelDescription(routeId);
  const showMoreOnly = getModelShowMoreOnly(id);
  const contextWindow = getListedModelContextWindow(routeId);
  return {
    id,
    label: named.name,
    ...(description ? { description } : {}),
    ...(showMoreOnly ? { showMoreOnly: true } : {}),
    provider,
    ...(source ? { source } : {}),
    ...(executionHarness ? { harness: executionHarness } : {}),
    ...harnessChoiceFields(routeId),
    ...gatewayFundingField(routeId),
    kind: 'agent',
    available: entry.available,
    ...(id === input.defaultModel ? { isDefault: true } : {}),
    // The base model's effective declared set (CAN-2540 §1): an available
    // Agent inherits its base model's real capability data so clients resolve
    // the same tiers desktop does. A STALE Agent has no base set — the field
    // stays absent so clients fall back to their provider cycle instead of
    // reading the fallback as a declaration.
    ...(entry.available
      ? {
          supportedThinkingLevels: getEffectiveSupportedThinkingLevelsForModel(
            routeId,
            false,
            provider,
          ),
        }
      : {}),
    thinkingLevels: projectedThinkingLevels(routeId, provider),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(entry.available ? {} : { unavailableReason: 'base_model_unavailable' }),
    ...(billing?.extraChargeOnly ? { extraChargeOnly: true } : {}),
    ...(billing?.extraChargeMessage
      ? { extraChargeMessage: billing.extraChargeMessage }
      : {}),
  };
}

/**
 * Project one registry model (or custom Agent) onto its catalog row. Returns
 * `undefined` only for an Agent-prefixed id with no registry entry.
 */
export function buildModelCatalogOption(
  id: string,
  input: BuildModelCatalogOptionInput,
): ModelCatalogOption | undefined {
  return resolveAgentModelDefinition(id)
    ? agentModelOption(id, input)
    : providerModelOption(id, input);
}
