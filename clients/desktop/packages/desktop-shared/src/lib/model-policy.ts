import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { CanopyCloudAccountPublicState } from '../types';
import { resolveOrgGatewayOrganizationId } from '@canopy/execution-engine/lib/gateway-model-availability';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import {
  getGatewayModelEntry,
  getCursorModelPolicyIdentity,
  getConfiguredGatewayId,
  getModelSource,
  isAgentModel,
  isInheritingAgentModel,
  isOllamaModel,
  resolveModelAlias,
  resolveRuntimeModel,
} from '../types';

const POLICY_PREFIX = '\u0000model-policy:';
const ORG_PREFIX = `${POLICY_PREFIX}org:`;
const OWNER_PREFIX = `${POLICY_PREFIX}owner:`;
const BLOCKED_PREFIX = `${POLICY_PREFIX}blocked:`;
const REVIEWED_PREFIX = `${POLICY_PREFIX}reviewed:`;
const EMPTY_MODEL_POLICY: ReadonlySet<string> = new Set<string>();

export interface ModelPolicyIndex {
  byOrganization: ReadonlyMap<string, ReadonlySet<string>>;
  union: ReadonlySet<string>;
}

/**
 * The id a model is governed (and routed) by: the Cursor policy identity,
 * then its alias, then an Agent's base model, then its gateway id. `undefined`
 * for Ollama and for an Agent that inherits the default.
 */
export function normalizeGovernedModelId(modelId: string): string | undefined {
  const aliased = resolveModelAlias(getCursorModelPolicyIdentity(modelId));
  // An Agent that inherits the default has no model until a chat pins it;
  // the pinned route is judged then.
  if (isInheritingAgentModel(aliased)) return undefined;
  const unwrapped = isAgentModel(aliased)
    ? resolveRuntimeModel(aliased)
    : aliased;
  if (!unwrapped || isOllamaModel(unwrapped)) {
    return undefined;
  }
  return (
    getGatewayModelEntry(unwrapped)?.gatewayId ??
    getConfiguredGatewayId(unwrapped) ??
    unwrapped
  );
}

/**
 * Resolve all active organization model policies into an opaque set consumed
 * by {@link isModelBlocked}. The encoding preserves per-organization reviewed
 * snapshots so one organization's approval cannot override another's denial.
 */
export function resolveModelPolicy(
  account: Pick<CanopyCloudAccountPublicState, 'enforcedSettings'> | null,
): ReadonlySet<string> {
  const resolved = new Set<string>();
  let policyIndex = 0;
  for (const setting of account?.enforcedSettings ?? []) {
    for (const policy of setting.policies) {
      if (policy.kind !== 'model-policy') {
        continue;
      }
      const key = String(policyIndex);
      policyIndex += 1;
      resolved.add(`${ORG_PREFIX}${key}`);
      const organizationId = normalizeUuid(setting.organizationId);
      if (organizationId) {
        resolved.add(`${OWNER_PREFIX}${key}:${organizationId}`);
      }
      for (const id of policy.blockedModelIds) {
        resolved.add(`${BLOCKED_PREFIX}${key}:${id}`);
      }
      for (const id of policy.reviewedModelIds) {
        resolved.add(`${REVIEWED_PREFIX}${key}:${id}`);
      }
    }
  }
  return resolved;
}

/** Resolve model policy independently for each organization and as a union. */
export function resolveModelPolicyIndex(
  account: Pick<CanopyCloudAccountPublicState, 'enforcedSettings'> | null,
): ModelPolicyIndex {
  const byOrganization = new Map<string, ReadonlySet<string>>();
  for (const setting of account?.enforcedSettings ?? []) {
    const organizationId = normalizeUuid(setting.organizationId);
    if (!organizationId) continue;
    const existing = byOrganization.get(organizationId);
    const scopedAccount = { enforcedSettings: [setting] };
    const resolved = resolveModelPolicy(scopedAccount);
    if (!existing) {
      byOrganization.set(organizationId, resolved);
      continue;
    }
    const combined = new Set<string>();
    existing.forEach((entry) => combined.add(entry));
    resolved.forEach((entry) => combined.add(entry));
    byOrganization.set(organizationId, combined);
  }
  return { byOrganization, union: resolveModelPolicy(account) };
}

/** Return the stable policy set that applies to one work owner. */
export function modelPolicyForOwner(
  index: ModelPolicyIndex,
  owner?: WorkOwner,
): ReadonlySet<string> {
  if (!owner) return index.union;
  if (owner.kind === 'personal') return EMPTY_MODEL_POLICY;
  const organizationId = normalizeUuid(owner.organizationId);
  return organizationId
    ? (index.byOrganization.get(organizationId) ?? EMPTY_MODEL_POLICY)
    : EMPTY_MODEL_POLICY;
}

/**
 * A model the organization serves from its OWN gateway is outside model
 * policy, the same way a local Ollama id is.
 *
 * Not a convenience: without it the two features brick each other. An org that
 * enforces both a model policy and a gateway has no way to review its gateway
 * models, because `/api/account/model-catalog` (which populates the policy
 * card) lists Canopy's hosted catalog plus native-only ids and nothing any org
 * authored. The rows therefore stay permanently unreviewed, and "unreviewed
 * under an active policy" means blocked — so the renderer strips those models
 * and their routes, and an enforcing org is left with nothing dispatchable.
 *
 * Publishing a model to the org's own gateway is the admin's review: it is the
 * same admin, on the same settings page, and removing the row is how they
 * withdraw it. Nothing is being substituted or silently permitted here.
 *
 */
function isOutsideModelPolicyForKey(
  modelId: string,
  policy: ReadonlySet<string>,
  key: string,
): boolean {
  const gatewayOrganizationId = normalizeUuid(
    resolveOrgGatewayOrganizationId(modelId),
  );
  return (
    gatewayOrganizationId !== null &&
    policy.has(`${OWNER_PREFIX}${key}:${gatewayOrganizationId}`)
  );
}

/** True when any enforcing organization denies or has not reviewed the model. */
export function isModelBlocked(
  modelId: string | undefined,
  policy: ReadonlySet<string>,
): boolean {
  if (!modelId) {
    return false;
  }
  const governedId = normalizeGovernedModelId(modelId);
  if (!governedId) {
    return false;
  }
  // Walk the Set without copying it. This runs per row in the model picker and
  // per entry in the catalog store, and `policy` can hold an entire reviewed
  // snapshot, so an Array.from() copy here was a per-call allocation on a
  // renderer hot path. `forEach` (rather than for..of) keeps this compiling
  // without downlevelIteration at the workspace's compile target.
  let blocked = false;
  let hasKeyedPolicy = false;
  policy.forEach((entry) => {
    if (blocked || !entry.startsWith(ORG_PREFIX)) {
      return;
    }
    hasKeyedPolicy = true;
    const key = entry.slice(ORG_PREFIX.length);
    if (isOutsideModelPolicyForKey(modelId, policy, key)) return;
    if (
      policy.has(`${BLOCKED_PREFIX}${key}:${governedId}`) ||
      !policy.has(`${REVIEWED_PREFIX}${key}:${governedId}`)
    ) {
      blocked = true;
    }
  });
  // Keep supporting raw policy sets from legacy/small direct callers that do
  // not carry keyed organization metadata.
  return blocked || (!hasKeyedPolicy && policy.has(governedId));
}

/**
 * Policy predicate for lane selection, where a gateway-only id cannot be
 * judged until the route catalog can translate its display id to the governed
 * gateway id. The established boolean predicate remains unchanged for its
 * renderer hot path and enforcement callers.
 */
export function isModelBlockedTriState(
  modelId: string | undefined,
  policy: ReadonlySet<string>,
  gatewayRoutesHydrated: boolean,
): boolean | undefined {
  if (!modelId) return false;
  const governedId = normalizeGovernedModelId(modelId);
  if (!governedId) return false;
  let hasPolicy = false;
  let reviewedEverywhere = true;
  policy.forEach((entry) => {
    if (!entry.startsWith(ORG_PREFIX)) return;
    const key = entry.slice(ORG_PREFIX.length);
    if (isOutsideModelPolicyForKey(modelId, policy, key)) return;
    hasPolicy = true;
    if (
      policy.has(`${BLOCKED_PREFIX}${key}:${governedId}`) ||
      !policy.has(`${REVIEWED_PREFIX}${key}:${governedId}`)
    ) {
      reviewedEverywhere = false;
    }
  });
  if (!hasPolicy && policy.has(governedId)) return true;
  if (!hasPolicy || reviewedEverywhere) return false;

  const unresolvedCatalogId =
    governedId === modelId &&
    getGatewayModelEntry(modelId) === undefined &&
    getConfiguredGatewayId(modelId) === undefined &&
    // A model the registries already place on a NATIVE harness can never be
    // re-governed by a gateway route: hydrating the route catalog cannot change
    // its governed id, so there is nothing to wait for. Without this the guard
    // matched every canonical native id with no alias (e.g.
    // `claude-haiku-4-5-20251001`), and an unreviewed native model answered
    // UNKNOWN for as long as the gateway catalog stayed cold — which
    // `resolveDefaultModelLane` treats as ALLOWED, so an enforcing-org member
    // could be seeded onto an org-blocked native model while main
    // (`isModelBlockedByStoredPolicy`, a plain boolean) said the opposite.
    !isNativelySourcedModel(modelId);
  if (!gatewayRoutesHydrated && unresolvedCatalogId) {
    return undefined;
  }
  return true;
}

/**
 * Whether the model registries place this id on a non-gateway harness, so a
 * cold route catalog cannot change its governed id. Copilot, OpenCode and
 * Antigravity ids are recognized by their own id format and no gateway route
 * is keyed on them. Cursor is left out: `getCursorModelPolicyIdentity` maps a
 * Cursor id onto a hosted gateway entry once the catalog hydrates, so its
 * governed id can still change.
 */
function isNativelySourcedModel(modelId: string): boolean {
  const source = getModelSource(modelId);
  return (
    source === 'claude-managed' ||
    source === 'codex-managed' ||
    source === 'ollama' ||
    source === 'copilot-managed' ||
    source === 'opencode-managed' ||
    source === 'antigravity-managed'
  );
}
