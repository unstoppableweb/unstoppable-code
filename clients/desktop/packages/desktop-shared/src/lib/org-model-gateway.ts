import { gatewayHostname } from '@canopy/protocol/model-gateway/discovery';
import { orderGatewayModelsForDefault } from '@canopy/protocol/model-gateway/presets';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { ModelGatewayModel } from '@canopy/protocol/canopy-server';
import type { PersonalAiGatewayConfig } from '@canopy/protocol/model-gateway';
import {
  getExecutionHarnessForModel,
  type CanopyCloudAccountPublicState,
} from '../types';
import {
  resolveGatewayModelEntry,
  resolveOrgGatewayOrganizationId,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { findEquivalentModel, modelIdentityKey } from './model-identity';

export interface OrganizationModelGateway {
  organizationName: string;
  displayName?: string;
  baseUrl: string;
  enforced: boolean;
  promptCachePassthrough: boolean;
  models: readonly ModelGatewayModel[];
  unavailable: boolean;
}

export interface ModelGatewayIndex {
  byOrganization: ReadonlyMap<string, OrganizationModelGateway>;
  accountUnavailable: boolean;
  accountId?: string;
  personalOrganizationId?: string;
  personalUnavailable?: boolean;
}

export type ModelGatewayRequirement =
  | { kind: 'unrestricted' }
  | { kind: 'enforced'; organizationIds: readonly string[] }
  | {
      kind: 'blocked';
      reason: 'account-unavailable' | 'organization-unavailable';
    };

const UNRESTRICTED: ModelGatewayRequirement = { kind: 'unrestricted' };

export function soleEnforcingOrganizationId(
  requirement: ModelGatewayRequirement,
): string | undefined {
  if (
    requirement.kind !== 'enforced' ||
    requirement.organizationIds.length !== 1
  ) {
    return undefined;
  }
  for (const organizationId of requirement.organizationIds) {
    return organizationId;
  }
  return undefined;
}

/** The routable Personal gateway shape, shared by the account and the device. */
export type PersonalModelGatewayProjection = NonNullable<
  CanopyCloudAccountPublicState['personalModelGateway']
>;

/**
 * The device AI gateway applies while the account names no Personal
 * organization: signed out, a guest, or before the Personal id arrives.
 */
export function accountUsesDeviceModelGateway(
  account: { personalOrganizationId?: string | null } | null | undefined,
): boolean {
  return normalizeUuid(account?.personalOrganizationId) === null;
}

/** Project a device gateway config like the hosted account response does. */
export function localModelGatewayProjection(
  config: PersonalAiGatewayConfig | null | undefined,
): PersonalModelGatewayProjection | null {
  const organizationId = normalizeUuid(config?.organizationId);
  if (!config?.enabled || !config.baseUrl || !organizationId) return null;
  return {
    kind: 'model-gateway',
    organizationId,
    baseUrl: config.baseUrl,
    models: config.models,
    enforced: config.onlyThisGateway,
    promptCachePassthrough: config.promptCachePassthrough,
    ...(config.displayName ? { displayName: config.displayName } : {}),
  };
}

/**
 * Personal organizations whose account gateway this computer doesn't use
 * (CAN-7657), saved on each desktop. "Use only my AI gateway" applies
 * everywhere, so an enforced gateway ignores it.
 */
export type ModelGatewayDeviceOptOuts = ReadonlySet<string>;

/**
 * The Personal gateway that routes for this account: the account's own, or
 * the device gateway while the account names no Personal organization. The
 * account's own is left out while this computer opts out of it.
 */
export function effectivePersonalModelGateway(
  account: Pick<
    CanopyCloudAccountPublicState,
    'personalOrganizationId' | 'personalModelGateway'
  > | null,
  localGateway?: PersonalModelGatewayProjection | null,
  deviceOptOuts?: ModelGatewayDeviceOptOuts,
): {
  personalOrganizationId?: string;
  personalModelGateway?: PersonalModelGatewayProjection;
} {
  if (accountUsesDeviceModelGateway(account)) {
    return localGateway
      ? {
          personalOrganizationId: localGateway.organizationId,
          personalModelGateway: localGateway,
        }
      : {};
  }
  const gateway = account?.personalModelGateway;
  const optedOut =
    gateway !== undefined &&
    !gateway.enforced &&
    deviceOptOuts?.has(normalizeUuid(gateway.organizationId) ?? '') === true;
  return {
    personalOrganizationId:
      normalizeUuid(account?.personalOrganizationId) ?? undefined,
    ...(gateway && !optedOut ? { personalModelGateway: gateway } : {}),
  };
}

export function resolveModelGatewayIndex(
  account: Pick<
    CanopyCloudAccountPublicState,
    | 'account'
    | 'enforcedSettings'
    | 'modelGatewayEnforcementUnavailable'
    | 'personalOrganizationId'
    | 'personalModelGateway'
    | 'personalModelGatewayEnforcementUnavailable'
  > | null,
  localGateway?: PersonalModelGatewayProjection | null,
  deviceOptOuts?: ModelGatewayDeviceOptOuts,
): ModelGatewayIndex {
  const byOrganization = new Map<string, OrganizationModelGateway>();
  for (const setting of account?.enforcedSettings ?? []) {
    const organizationId = normalizeUuid(setting.organizationId);
    if (!organizationId) continue;
    const gateway = setting.policies.find(
      (policy) => policy.kind === 'model-gateway',
    );
    const previous = byOrganization.get(organizationId);
    byOrganization.set(organizationId, {
      organizationName: gateway?.displayName ?? setting.organizationName,
      displayName: gateway?.displayName,
      baseUrl: gateway?.baseUrl ?? previous?.baseUrl ?? '',
      enforced: gateway?.enforced ?? previous?.enforced ?? false,
      promptCachePassthrough:
        gateway?.promptCachePassthrough ??
        previous?.promptCachePassthrough ??
        true,
      models: gateway?.models ?? previous?.models ?? [],
      unavailable:
        setting.modelGatewayEnforcementUnavailable === true ||
        previous?.unavailable === true,
    });
  }
  const personal = effectivePersonalModelGateway(
    account,
    localGateway,
    deviceOptOuts,
  );
  const personalOrganizationId = personal.personalOrganizationId;
  const personalGateway = personal.personalModelGateway;
  if (
    personalGateway &&
    personalOrganizationId &&
    personalGateway.organizationId === personalOrganizationId
  ) {
    byOrganization.set(personalOrganizationId, {
      organizationName:
        personalGateway.displayName ?? gatewayHostname(personalGateway.baseUrl),
      displayName: personalGateway.displayName,
      baseUrl: personalGateway.baseUrl,
      models: personalGateway.models,
      enforced: personalGateway.enforced,
      promptCachePassthrough: personalGateway.promptCachePassthrough,
      unavailable: account?.personalModelGatewayEnforcementUnavailable === true,
    });
  }
  return {
    accountId: account?.account?.id,
    personalOrganizationId,
    personalUnavailable:
      account?.personalModelGatewayEnforcementUnavailable === true,
    byOrganization,
    accountUnavailable: account?.modelGatewayEnforcementUnavailable === true,
  };
}

export function gatewayRequirementForOwner(
  index: ModelGatewayIndex,
  owner?: WorkOwner,
): ModelGatewayRequirement {
  if (owner?.kind === 'personal') {
    if (index.personalUnavailable)
      return { kind: 'blocked', reason: 'organization-unavailable' };
    const gateway = index.personalOrganizationId
      ? index.byOrganization.get(index.personalOrganizationId)
      : undefined;
    return gateway?.enforced && index.personalOrganizationId
      ? { kind: 'enforced', organizationIds: [index.personalOrganizationId] }
      : UNRESTRICTED;
  }
  if (index.accountUnavailable) {
    return { kind: 'blocked', reason: 'account-unavailable' };
  }
  if (owner?.kind === 'organization') {
    const organizationId = normalizeUuid(owner.organizationId);
    const gateway = organizationId
      ? index.byOrganization.get(organizationId)
      : undefined;
    if (gateway?.unavailable) {
      return { kind: 'blocked', reason: 'organization-unavailable' };
    }
    return gateway?.enforced && organizationId
      ? { kind: 'enforced', organizationIds: [organizationId] }
      : UNRESTRICTED;
  }
  let unavailable = false;
  const enforcingOrganizationIds: string[] = [];
  index.byOrganization.forEach((gateway, organizationId) => {
    if (organizationId === index.personalOrganizationId) return;
    if (gateway.unavailable) unavailable = true;
    if (gateway.enforced) enforcingOrganizationIds.push(organizationId);
  });
  if (unavailable) {
    return { kind: 'blocked', reason: 'organization-unavailable' };
  }
  return enforcingOrganizationIds.length > 0
    ? { kind: 'enforced', organizationIds: enforcingOrganizationIds }
    : UNRESTRICTED;
}

export function isOrgGatewayRouteUsableByOwner(
  modelId: string | undefined,
  owner?: WorkOwner,
  personalOrganizationId?: string,
): boolean {
  const routeOrganizationId = normalizeUuid(
    resolveOrgGatewayOrganizationId(modelId),
  );
  if (!routeOrganizationId) return true;
  if (!owner) return true;
  return owner.kind === 'personal'
    ? normalizeUuid(personalOrganizationId) === routeOrganizationId
    : normalizeUuid(owner.organizationId) === routeOrganizationId;
}

export function isModelExcludedByGatewayRequirement(
  modelId: string | undefined,
  requirement: ModelGatewayRequirement,
  owner?: WorkOwner,
  personalOrganizationId?: string,
): boolean {
  if (!modelId || requirement.kind === 'blocked') return !!modelId;
  if (!isOrgGatewayRouteUsableByOwner(modelId, owner, personalOrganizationId))
    return true;
  if (requirement.kind === 'unrestricted') return false;
  const routeOrganizationId = normalizeUuid(
    resolveOrgGatewayOrganizationId(modelId),
  );
  return (
    routeOrganizationId === null ||
    !requirement.organizationIds.includes(routeOrganizationId)
  );
}

/**
 * The Personal gateway's models a new chat may default to, in default order
 * (CAN-6444). Empty unless the Personal gateway is saved, readable, and not
 * enforced (an enforced one already reaches the resolver as `orgGateway`).
 *
 * `catalogModels` is the credits-lane registry. Main adds a Personal model to
 * it only when this computer holds the gateway key, so filtering through it is
 * what limits this to models this device can actually run. Order comes from the
 * saved gateway config via `orderGatewayModelsForDefault`, matched on gateway
 * id because a registry id can carry an `@<organization>` suffix.
 *
 * The renderer seed and the main dispatch resolver both call this, so they
 * hand the shared resolver the same candidates.
 */
export function listPersonalGatewayDefaultModels(
  index: ModelGatewayIndex,
  catalogModels: readonly string[],
): readonly string[] {
  const organizationId = index.personalOrganizationId;
  if (!organizationId || index.personalUnavailable) return [];
  const gateway = index.byOrganization.get(organizationId);
  if (!gateway || gateway.unavailable || gateway.enforced) return [];
  const routable = listOrgGatewayModelsForOrganization(
    catalogModels,
    organizationId,
  );
  const ordered: string[] = [];
  for (const saved of orderGatewayModelsForDefault(
    gateway.baseUrl,
    gateway.models,
  )) {
    const model = routable.find(
      (candidate) =>
        resolveGatewayModelEntry(candidate)?.gatewayId === saved.gatewayId &&
        !ordered.includes(candidate),
    );
    if (model) ordered.push(model);
  }
  return ordered;
}

export function listOrgGatewayModelsForOrganization(
  models: readonly string[],
  organizationId: string,
): readonly string[] {
  const normalizedOrganizationId = normalizeUuid(organizationId);
  if (!normalizedOrganizationId) return [];
  return models.filter(
    (model) =>
      normalizeUuid(resolveOrgGatewayOrganizationId(model)) ===
      normalizedOrganizationId,
  );
}

/**
 * A model's tier without its version: `anthropic/claude-haiku-4.5` and
 * `anthropic/claude-haiku-5.5` share `anthropic/claude-haiku`, and
 * `openai/gpt-6.1-sol` becomes `openai/gpt-sol`. Every numeric segment goes,
 * so ids that differ only by a number share a tier (`o1` and `o3`). That is
 * fine for a helper's fallback pick, which only wants a model of similar
 * size, and is never used to match a chat's model.
 */
function modelTierKey(model: string): string | undefined {
  const key = modelIdentityKey(model, { stripVariant: true });
  return key?.replace(/[-.]?\d+(?:\.\d+)*/g, '');
}

/**
 * The Personal gateway model a background helper runs on when its configured
 * model has no way to pay (signed out, no AI Credits). `candidates` are the
 * gateway's models in default order (see `listPersonalGatewayDefaultModels`).
 *
 * Unlike a chat default this picks a different model when it must: a helper's
 * job matters more than its exact model. Only models on the requested
 * model's harness qualify. Closest first: the same model under the gateway's
 * id, then the same tier at another version (a Haiku title model stays a
 * Haiku), then the first on that harness in default order.
 */
export function pickPersonalGatewayHelperModel(
  model: string,
  gatewayModels: readonly string[],
): string | undefined {
  // Callers choose the Claude or Codex generator from the requested model, so
  // the pick stays on that harness; with none there, the helper is refused
  // (and its pre-check skips it) rather than handed to the wrong generator.
  const harness = helperHarness(model);
  const candidates = gatewayModels.filter((candidate) => {
    const candidateHarness = helperHarness(candidate);
    return harness === 'claude' || harness === 'codex'
      ? candidateHarness === harness
      : candidateHarness === 'claude' || candidateHarness === 'codex';
  });
  if (candidates.length === 0) return undefined;
  if (candidates.includes(model)) return model;
  const same = findEquivalentModel(
    model,
    candidates.map((id) => ({ id })),
  )?.id;
  if (same) return same;
  // The newest version of the tier, as the Claude side models choose it.
  const tier = modelTierKey(model);
  const sameTier = tier
    ? candidates
        .filter((candidate) => modelTierKey(candidate) === tier)
        .sort((left, right) =>
          right.localeCompare(left, undefined, { numeric: true }),
        )
    : [];
  return sameTier[0] ?? candidates[0];
}

/** The registry's harness, else the gateway route's own. */
function helperHarness(model: string): string | undefined {
  return (
    getExecutionHarnessForModel(model) ??
    resolveGatewayModelEntry(model)?.recommendedHarness
  );
}
