// Browser-safe gateway model availability helpers. Concrete routes are
// initialized from the unified package.json model configuration.

import type { GatewayModelEntry } from '@canopy/protocol';
import {
  AGENT_ROUTE_SEPARATOR,
  parseAgentRouteModelId,
} from '@canopy/protocol/agents';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type {
  AiGatewayHarness,
  AiGatewayToolSchemaProfile,
} from '@canopy/protocol/ai-gateway-models';
import {
  getGatewayModelEntries,
  getGatewayModelEntry,
  getRemovedGatewayOnlyModelHarness,
  isAgentModel,
  getModelSource,
  ORG_GATEWAY_MODEL_ID_PATTERN,
  resolveKnownModel,
  resolveRuntimeModel,
  stripOllamaModelPrefix,
} from '../model-catalog';
import { isCursorModel } from './cursor-models';
import { normalizeUuid } from './workspace-owner';

export type OrgGatewayModelAliases = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

let orgGatewayModelAliases: OrgGatewayModelAliases = {};
let personalGatewayOrganizationId: string | null = null;

export function initOrgGatewayModelAliases(
  aliases: OrgGatewayModelAliases,
  personalOrganizationId?: string,
): void {
  personalGatewayOrganizationId = normalizeUuid(personalOrganizationId);
  orgGatewayModelAliases = Object.fromEntries(
    Object.entries(aliases).map(([modelId, byOrganization]) => [
      modelId,
      { ...byOrganization },
    ]),
  );
}

/**
 * An organization gateway model's id: always `<id>@<organizationId>`, so it
 * never depends on which other gateways or hosted models are active.
 */
export function orgGatewayModelId(
  modelId: string,
  organizationId: string,
): string {
  return `${modelId}@${organizationId}`;
}

/** Split an organization gateway model id, even when its gateway is gone. */
export function parseOrgGatewayModelId(
  modelId: string | undefined,
): { modelId: string; organizationId: string } | undefined {
  const match = modelId ? ORG_GATEWAY_MODEL_ID_PATTERN.exec(modelId) : null;
  return match?.[1] && match[2]
    ? { modelId: match[1], organizationId: match[2] }
    : undefined;
}

export function resolveOwnerScopedModelId(
  modelId: string,
  owner?: WorkOwner,
): string {
  if (!owner) return modelId;
  const organizationId =
    owner.kind === 'personal'
      ? personalGatewayOrganizationId
      : normalizeUuid(owner.organizationId);
  return organizationId
    ? (orgGatewayModelAliases[modelId]?.[organizationId] ?? modelId)
    : modelId;
}

/**
 * The model a saved selection runs on for `owner`. A registered id (hosted,
 * package or a gateway's `<id>@<orgId>` row) is kept. A bare gateway id saved
 * before ids were namespaced resolves through the owner's own gateway first,
 * then the catalog's unambiguous alias, and otherwise stays unresolved so the
 * caller fails closed. An Agent route's base model resolves the same way.
 */
export function resolveOwnerGatewayModelId(
  modelId: string,
  owner: WorkOwner | undefined,
): string {
  const route = parseAgentRouteModelId(modelId);
  if (route) {
    const baseModel = resolveOwnerGatewayModelId(route.baseModel, owner);
    return baseModel === route.baseModel
      ? modelId
      : `${route.agentId}${AGENT_ROUTE_SEPARATOR}${baseModel}`;
  }
  const known = resolveKnownModel(modelId);
  // A hosted or package model, or a package alias of one, is never rewritten.
  if (known !== undefined && parseOrgGatewayModelId(known) === undefined)
    return modelId;
  const scoped = resolveOwnerScopedModelId(modelId, owner);
  if (
    parseOrgGatewayModelId(scoped) &&
    resolveGatewayModelEntry(scoped) !== undefined
  )
    return scoped;
  return known ?? modelId;
}

/**
 * Whether {@link resolveOwnerGatewayModelId} could change `modelId`, so a
 * caller can skip reading the owner for an ordinary registered id.
 */
export function needsOwnerGatewayModelId(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const route = parseAgentRouteModelId(modelId);
  const model = route ? route.baseModel : modelId;
  const known = resolveKnownModel(model);
  return (
    known !== model &&
    (known === undefined || parseOrgGatewayModelId(known) !== undefined) &&
    orgGatewayModelAliases[model] !== undefined
  );
}

/**
 * Resolve the gateway registry entry for a selected model id. Thin wrapper over
 * the package-configured registry so call sites do not hard-code
 * harness and exact gateway identifier selection.
 */
export function resolveGatewayModelEntry(
  modelId: string | undefined,
): GatewayModelEntry | undefined {
  if (!modelId) {
    return undefined;
  }
  // Agent models (`agent_model_*`) resolve at execution time to a real base
  // model; unwrap before checking gateway routability so an Agent inherits its
  // base model's routing instead of silently missing every lookup.
  const unwrappedId = isAgentModel(modelId)
    ? resolveRuntimeModel(modelId)
    : modelId;
  if (!unwrappedId) {
    return undefined;
  }
  return getGatewayModelEntry(unwrappedId);
}

/**
 * Resolve the registry model id whose gateway route carries `gatewayId`; the
 * reverse of {@link resolveGatewayModelEntry}.
 *
 * Several routes can share one gateway id (a package model and a Cursor alias
 * of it, say). A package Claude or Codex model wins, then any other non-Cursor
 * model, then a Cursor model; ties go to the first registered route, so the
 * answer is deterministic for a given catalog.
 */
export function resolveModelIdForGatewayId(
  gatewayId: string,
): string | undefined {
  let best: { modelId: string; rank: number } | undefined;
  for (const entry of getGatewayModelEntries()) {
    if (entry.gatewayId !== gatewayId) continue;
    const rank = gatewayRouteOwnerRank(entry.modelId);
    if (!best || rank < best.rank) best = { modelId: entry.modelId, rank };
  }
  return best?.modelId;
}

function gatewayRouteOwnerRank(modelId: string): number {
  const source = getModelSource(modelId);
  if (source === 'claude-managed' || source === 'codex-managed') return 0;
  if (source === 'cursor-managed' || isCursorModel(modelId)) return 2;
  return 1;
}

/**
 * True iff the given model id resolves to a gateway registry entry (directly or
 * via the runtime-id alias table) and can therefore be routed through AI
 * Credits.
 */
export function isGatewayRoutableModel(modelId: string | undefined): boolean {
  return resolveGatewayModelEntry(modelId) !== undefined;
}

/**
 * True iff the given model id exists only in the dynamic gateway catalog and
 * can therefore never be billed through a native provider login.
 */
export function isGatewayOnlyModel(modelId: string | undefined): boolean {
  return resolveGatewayModelEntry(modelId)?.gatewayOnly === true;
}

/**
 * Resolve the dynamic-tool schema shape for the route that will actually carry
 * the request. Gateway profiles describe the AI Gateway wire contract only;
 * native provider sessions must retain the standard Codex schema even when the
 * same package-owned model also has gateway enrichment.
 */
export function resolveGatewayToolSchemaProfile(
  modelId: string | undefined,
  aiCreditsRouted: boolean,
): AiGatewayToolSchemaProfile {
  if (!aiCreditsRouted) {
    return 'standard';
  }
  return resolveGatewayModelEntry(modelId)?.toolSchemaProfile ?? 'standard';
}

/**
 * Route family for reasoning produced by a native (non-gateway) Codex session.
 */
export const CODEX_NATIVE_REASONING_ROUTE_FAMILY = 'native';

/**
 * Route family prefix for reasoning produced by a locally hosted Ollama model.
 *
 * Ollama sessions run through the Codex provider without AI-Credits routing
 * and share the canonical Codex home, so their rollouts land in the same
 * sessions tree as native OpenAI threads. Without a distinct family, switching
 * an existing Ollama chat to a native model would compare `native` to `native`
 * and resume, replaying Ollama's provider-private reasoning into OpenAI.
 */
export const CODEX_OLLAMA_REASONING_ROUTE_FAMILY_PREFIX = 'ollama:';

/** Route family prefix for reasoning produced through the AI Credits gateway. */
export const CODEX_GATEWAY_REASONING_ROUTE_FAMILY_PREFIX = 'gateway:';

/** Execution backend that produced a Codex thread's reasoning items. */
export type CodexReasoningProviderType = 'codex' | 'ollama';

/**
 * Reasoning route family for a locally hosted Ollama model.
 *
 * Keyed **per model** for the same reason unknown gateway models are: each
 * locally hosted model has its own private reasoning encoding, so a single
 * collapsed `ollama` family would make a switch from `ollama-deepseek-r1` to
 * `ollama-qwen` read as "same family", skip sanitization, and replay the first
 * model's reasoning into the second.
 *
 * The `ollama-` UI prefix is stripped so the persisted UI id and the raw
 * runtime id a rebuild passes to the app-server resolve to the same family; a
 * capability transition materializes the replacement thread with the raw
 * runtime model, and the two must not read as a route change.
 */
export function resolveCodexOllamaReasoningRouteFamily(
  modelId: string | undefined,
): string {
  const rawModelId = modelId ? stripOllamaModelPrefix(modelId).trim() : '';
  return `${CODEX_OLLAMA_REASONING_ROUTE_FAMILY_PREFIX}${rawModelId || 'unspecified'}`;
}

/**
 * True when a recorded reasoning route family was produced by an AI
 * Credits-routed (gateway) session. Used to recover the routing decision for a
 * chat whose live session is gone, where the live routing signal is absent
 * rather than false.
 */
export function isGatewayReasoningRouteFamily(
  routeFamily: string | undefined,
): boolean {
  return (
    routeFamily?.startsWith(CODEX_GATEWAY_REASONING_ROUTE_FAMILY_PREFIX) ===
    true
  );
}

/**
 * Resolve the provider compatibility family for persisted Codex reasoning
 * items. Native Codex models share OpenAI's encoding, gateway models are
 * compatible only within the same upstream provider family, and each locally
 * hosted Ollama model is its own family.
 *
 * Unknown gateway models are keyed by model id rather than a shared
 * `gateway:unknown` bucket: collapsing them would make a switch between two
 * different uncatalogued models read as "same family" and skip sanitization.
 */
export function resolveCodexReasoningRouteFamily(
  modelId: string | undefined,
  aiCreditsRouted: boolean,
  providerType?: CodexReasoningProviderType,
): string {
  if (providerType === 'ollama') {
    return resolveCodexOllamaReasoningRouteFamily(modelId);
  }
  if (!aiCreditsRouted) {
    return CODEX_NATIVE_REASONING_ROUTE_FAMILY;
  }
  const gatewayId = resolveGatewayModelEntry(modelId)?.gatewayId;
  const upstreamSlug = gatewayId?.split('/')[0];
  return upstreamSlug
    ? `${CODEX_GATEWAY_REASONING_ROUTE_FAMILY_PREFIX}${upstreamSlug}`
    : `${CODEX_GATEWAY_REASONING_ROUTE_FAMILY_PREFIX}unknown:${modelId ?? 'unspecified'}`;
}

/**
 * True when a gateway-only selection lost its catalog route during this
 * process lifetime. Sessions use this tombstone to fail clearly instead of
 * accidentally attempting native provider authentication.
 */
export function isRemovedGatewayOnlyModel(
  modelId: string | undefined,
  _harness?: AiGatewayHarness,
): boolean {
  void _harness;
  if (!modelId) {
    return false;
  }
  const unwrappedId = isAgentModel(modelId)
    ? resolveRuntimeModel(modelId)
    : modelId;
  return (
    !!unwrappedId &&
    getRemovedGatewayOnlyModelHarness(unwrappedId) !== undefined
  );
}

/**
 * True when a persisted selection no longer exists in the current registry.
 *
 * Live catalog removals are identified by the process-local gateway tombstone.
 * After a restart that tombstone is necessarily gone, so an unresolved
 * persisted selection must also be treated as unavailable. Model selection is
 * registry-backed; allowing an unresolved id through would let a removed
 * API-only model be inferred as a native provider model.
 */
export function isUnavailableModelSelection(
  modelId: string | undefined,
  harness: AiGatewayHarness,
): boolean {
  if (!modelId) {
    return false;
  }
  const resolvedModel = isAgentModel(modelId)
    ? resolveRuntimeModel(modelId)
    : modelId;
  if (!resolvedModel || resolveKnownModel(resolvedModel) === undefined) {
    return true;
  }
  const source = getModelSource(resolvedModel);
  return (
    isRemovedGatewayOnlyModel(modelId, harness) === true ||
    (source === 'ai-gateway' &&
      resolveGatewayModelEntry(resolvedModel) === undefined)
  );
}

/**
 * True iff this model is served by the member's ORGANIZATION gateway, rather
 * than a Canopy-hosted AI Credits route.
 *
 * The origin lives on the merged catalog entry (`ai-gateway-model-catalog.ts`
 * stamps `origin: 'org-gateway'` on the rows an org authored), so every caller
 * asks the registry rather than re-deriving membership from the org's model
 * list.
 */
export function isOrgGatewayRoute(modelId: string | undefined): boolean {
  return resolveGatewayModelEntry(modelId)?.origin === 'org-gateway';
}

/**
 * The organization whose gateway serves this model, when one does.
 *
 * Shared so the composer surfaces that decide whether to show the
 * "add your gateway key" banner all read the same answer.
 */
export function resolveOrgGatewayOrganizationId(
  modelId: string | undefined,
): string | undefined {
  const entry = resolveGatewayModelEntry(modelId);
  return entry?.origin === 'org-gateway' ? entry.organizationId : undefined;
}

/**
 * The single rule for "this org has clamped every model to its own gateway".
 *
 * ONE implementation on purpose. Enforcement previously lived only in the model
 * picker's row gate, so the default-model resolvers (renderer seed, main
 * dispatch, and every non-interactive caller downstream of them — helpers,
 * hooks, automations, pipelines) never learned about it and seeded a native
 * model the picker itself showed as unusable.
 *
 * **Ollama is deliberately NOT carved out**, which is the opposite of
 * {@link isModelBlocked} (org model policy) and of the credits-lane hide in
 * `modelPickerRowGate`. Both of those exempt local models because they answer
 * "who pays" or "what may leave the machine". This one answers a narrower
 * question the admin asked literally: when `Make this the only route` is on,
 * the org's gateway is the ONLY route, local models included.
 */
