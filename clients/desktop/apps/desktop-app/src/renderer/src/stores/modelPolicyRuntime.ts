import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  modelPolicyForOwner,
  type ModelPolicyIndex,
} from '@canopy/desktop-shared/lib/model-policy';
import {
  gatewayRequirementForOwner,
  isModelExcludedByGatewayRequirement,
  type ModelGatewayIndex,
  type ModelGatewayRequirement,
} from '@canopy/desktop-shared/lib/org-model-gateway';
import { resolveOrgGatewayOrganizationId } from '@canopy/execution-engine/lib/gateway-model-availability';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';

const NO_MODEL_POLICY: ReadonlySet<string> = new Set<string>();
const EMPTY_POLICY_INDEX: ModelPolicyIndex = {
  byOrganization: new Map(),
  union: NO_MODEL_POLICY,
};
const EMPTY_GATEWAY_INDEX: ModelGatewayIndex = {
  byOrganization: new Map(),
  accountUnavailable: false,
};
const UNRESTRICTED: ModelGatewayRequirement = { kind: 'unrestricted' };

let currentPolicyIndex: ModelPolicyIndex = EMPTY_POLICY_INDEX;
let currentGatewayIndex: ModelGatewayIndex = EMPTY_GATEWAY_INDEX;
/**
 * Owner of the work the renderer is currently choosing models for: the
 * navigation context. `undefined` while the org-projects flag is off or the
 * context has not hydrated, which applies the legacy union across every org,
 * the same answer main gives an unresolved owner.
 */
let currentActiveOwner: WorkOwner | undefined;
let currentModelPolicy: ReadonlySet<string> = NO_MODEL_POLICY;
let currentPolicyHydrated = false;
let currentPolicyReadAvailable = false;
let currentGatewayRequirement: ModelGatewayRequirement = UNRESTRICTED;
let modelFactsVersion = 0;
const modelFactsListeners = new Set<() => void>();

/**
 * Monotonic version of the module-level model facts that lane resolution reads
 * but React cannot see: the policy snapshot and its hydration flag, plus
 * `hasHydratedModelRegistry()` / `hasHydratedGatewayCatalog()` in the shared
 * registries.
 *
 * Components deriving from those facts (the composer's dead-end banner above
 * all) memoize on props like `providerAvailability`, none of which change when
 * a catalog or policy hydrates — so their derived value went stale exactly when
 * the snapshot that would have fixed it arrived. Subscribing to this version
 * gives them the same invalidation signal `applySnapshot` already uses to
 * trigger `syncActiveEmptyTabToDefaults()`.
 */
export function getRendererModelFactsVersion(): number {
  return modelFactsVersion;
}

export function subscribeRendererModelFacts(listener: () => void): () => void {
  modelFactsListeners.add(listener);
  return (): void => {
    modelFactsListeners.delete(listener);
  };
}

/**
 * Announce that the module-level model facts changed. Call AFTER the registries
 * and policy have been re-initialized, so a listener that re-derives on the
 * notification observes the new state rather than the half-applied one.
 */
export function bumpRendererModelFactsVersion(): void {
  modelFactsVersion += 1;
  modelFactsListeners.forEach((listener) => listener());
}

function sameOwner(
  left: WorkOwner | undefined,
  right: WorkOwner | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind === 'personal' || right.kind === 'personal') {
    return left.kind === right.kind;
  }
  return (
    normalizeUuid(left.organizationId) === normalizeUuid(right.organizationId)
  );
}

/**
 * Renderer affordance for the gateway requirement. A `blocked` requirement
 * (the org's settings could not be read) is left to main, which refuses the
 * turn with a real message; hiding every row here would only leave an empty
 * picker with no explanation.
 */
function affordanceRequirement(
  requirement: ModelGatewayRequirement,
  owner: WorkOwner | undefined,
): ModelGatewayRequirement {
  if (
    requirement.kind === 'blocked' &&
    owner?.kind === 'personal' &&
    currentGatewayIndex.personalOrganizationId
  ) {
    return {
      kind: 'enforced',
      organizationIds: [currentGatewayIndex.personalOrganizationId],
    };
  }
  return requirement.kind === 'blocked' ? UNRESTRICTED : requirement;
}

function recomputeOwnerFacts(): void {
  currentModelPolicy = modelPolicyForOwner(
    currentPolicyIndex,
    currentActiveOwner,
  );
  currentGatewayRequirement = affordanceRequirement(
    gatewayRequirementForOwner(currentGatewayIndex, currentActiveOwner),
    currentActiveOwner,
  );
}

/**
 * Keep policy-dependent default selection independent from the Zustand store
 * graph. `modelCatalogStore` imports `chatStore` while hydrating snapshots, so
 * importing it back from chat defaults would create a startup cycle.
 */
export function setRendererModelPolicyIndex(
  index: ModelPolicyIndex,
  // Whether this policy came from a real ACCOUNT read.
  //
  // REQUIRED, because the flag it drives means "an account read has produced a
  // policy at least once" and `isModelAllowedTriState` depends on that meaning
  // to answer UNKNOWN before the first read. The registry path re-applies
  // whatever the store currently holds — initially an empty index — so marking
  // hydrated unconditionally made an org member whose account read failed look
  // like a user with NO policy: a blocked model read as a definitive allow,
  // `provisional` was never set, and the model was stamped and persisted with
  // no dead-end banner. Main deliberately maps a degraded policy read to
  // `undefined` so exactly this cannot happen there.
  //
  // Once hydrated it stays hydrated — a later registry snapshot must not
  // un-hydrate a policy an account read already established.
  fromAccountRead: boolean,
): void {
  currentPolicyIndex = index;
  currentPolicyHydrated = currentPolicyHydrated || fromAccountRead;
  recomputeOwnerFacts();
  bumpRendererModelFactsVersion();
}

/**
 * Account-wide policy shorthand: installs `policy` as the union with no
 * per-organization entries. Personal work then sees no policy and an unknown
 * owner sees `policy`. Kept for tests and callers that hold only a resolved set.
 */
export function setRendererModelPolicy(
  policy: ReadonlySet<string>,
  fromAccountRead: boolean,
): void {
  setRendererModelPolicyIndex(
    { byOrganization: new Map(), union: policy },
    fromAccountRead,
  );
}

export function getRendererModelPolicyIndex(): ModelPolicyIndex {
  return currentPolicyIndex;
}

/** Policy for the active owner. Stable reference until the owner or index changes. */
export function getRendererModelPolicy(): ReadonlySet<string> {
  return currentModelPolicy;
}

export function getRendererModelPolicyForOwner(
  owner: WorkOwner | undefined,
): ReadonlySet<string> {
  return modelPolicyForOwner(currentPolicyIndex, owner);
}

/**
 * Whether an account read has produced a policy at least once.
 *
 * `getRendererModelPolicy()` returns an empty set both before the first read
 * and after a read that found no policy at all. Lane resolution has to tell
 * those apart: the first is UNKNOWN (hold the last resolved lane, stay
 * provisional), the second is a definitive "nothing is blocked".
 */
export function isRendererModelPolicyHydrated(): boolean {
  return currentPolicyHydrated;
}

export function isRendererModelPolicyReadAvailable(): boolean {
  return currentPolicyReadAvailable;
}

export function setRendererModelPolicyReadAvailable(available: boolean): void {
  if (currentPolicyReadAvailable === available) return;
  currentPolicyReadAvailable = available;
  bumpRendererModelFactsVersion();
}

/**
 * Per-organization gateway facts from the same account read as the policy.
 *
 * Lives beside the policy snapshot rather than in `modelCatalogStore` for the
 * same reason the policy does: the store imports `chatStore` while hydrating,
 * so reading it back from chat defaults would close a startup cycle.
 */
export function setRendererModelGatewayIndex(index: ModelGatewayIndex): void {
  currentGatewayIndex = index;
  const previous = currentGatewayRequirement;
  recomputeOwnerFacts();
  if (!sameRequirement(previous, currentGatewayRequirement)) {
    bumpRendererModelFactsVersion();
  }
}

export function getRendererModelGatewayIndex(): ModelGatewayIndex {
  return currentGatewayIndex;
}

function sameRequirement(
  left: ModelGatewayRequirement,
  right: ModelGatewayRequirement,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== 'enforced' || right.kind !== 'enforced') return true;
  return (
    left.organizationIds.length === right.organizationIds.length &&
    left.organizationIds.every(
      (id, index) => right.organizationIds[index] === id,
    )
  );
}

/** Gateway requirement for the active owner, as a renderer affordance. */
export function getRendererModelGatewayRequirement(): ModelGatewayRequirement {
  return currentGatewayRequirement;
}

/** Whether the active owner's organization clamps every model to its gateway. */
export function getRendererModelGatewayEnforced(): boolean {
  return currentGatewayRequirement.kind === 'enforced';
}

/**
 * Whether the active owner may not use `modelId`: another organization's
 * gateway row, or a non-gateway row while the owner's org enforces its own.
 */
export function isRendererModelExcludedByGateway(
  modelId: string | undefined,
): boolean {
  return isModelExcludedByGatewayRequirement(
    modelId,
    currentGatewayRequirement,
    currentActiveOwner,
    currentGatewayIndex.personalOrganizationId,
  );
}

/** The enforcing organizations' gateway models from `models`, in order. */
export function listRendererEnforcedGatewayModels(
  models: readonly string[],
): readonly string[] {
  const requirement = currentGatewayRequirement;
  if (requirement.kind !== 'enforced') return [];
  return models.filter((model) => {
    const organizationId = normalizeUuid(
      resolveOrgGatewayOrganizationId(model),
    );
    return (
      organizationId !== null &&
      requirement.organizationIds.includes(organizationId)
    );
  });
}

export function getRendererActiveWorkOwner(): WorkOwner | undefined {
  return currentActiveOwner;
}

/**
 * Point policy and gateway reads at a new owner. Returns whether it changed, so
 * the catalog store can re-project the snapshot only on a real switch.
 */
export function setRendererActiveWorkOwner(
  owner: WorkOwner | undefined,
): boolean {
  if (sameOwner(currentActiveOwner, owner)) return false;
  currentActiveOwner = owner;
  recomputeOwnerFacts();
  bumpRendererModelFactsVersion();
  return true;
}
