import { useCanopyCloudAccountState } from './useCanopyCloudAccountState';
import type {
  CanopyAccountResponse,
  CanopyOrgEnforcedSettings,
  ModelGatewayEnforcedPolicy,
} from '@canopy/protocol/canopy-server';
import { gatewayHostname } from '@canopy/protocol/model-gateway/discovery';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';

/**
 * One organization's model gateway, flattened for renderer surfaces (the
 * credential blocks in Settings, the picker's own section, the composer
 * banner).
 */
export interface OrgModelGateway {
  organizationId: string;
  organizationName: string;
  baseUrl: string;
  /** True when this gateway is the ONLY route for that org's work. */
  enforced: boolean;
  /** Selection ids of the models this org declared. */
  modelIds: string[];
}

/**
 * Every organization's gateway in an account's enforced settings, one per org
 * (its first declaration), in account order.
 *
 * Each gateway applies only to its own organization's work, so there is no
 * account-wide pick: callers choose by owner with {@link selectGatewayForOwner}.
 *
 * Exported for testing and for callers that already hold an account.
 */
export function resolveOrgModelGateways(
  enforcedSettings: CanopyOrgEnforcedSettings[] | null | undefined,
): OrgModelGateway[] {
  const gateways: OrgModelGateway[] = [];
  const seen = new Set<string>();
  for (const org of enforcedSettings ?? []) {
    const key = normalizeUuid(org.organizationId) ?? org.organizationId;
    if (seen.has(key)) continue;
    const policy = org.policies.find(
      (candidate): candidate is ModelGatewayEnforcedPolicy =>
        candidate.kind === 'model-gateway',
    );
    if (!policy) continue;
    seen.add(key);
    gateways.push(flatten(org, policy));
  }
  return gateways;
}

function flatten(
  org: CanopyOrgEnforcedSettings,
  policy: ModelGatewayEnforcedPolicy,
): OrgModelGateway {
  return {
    organizationId: org.organizationId,
    // A gateway's own name wins over its organization's.
    organizationName: policy.displayName || org.organizationName,
    baseUrl: policy.baseUrl,
    enforced: policy.enforced === true,
    modelIds: policy.models.map((model) => model.id),
  };
}

/**
 * The account's enabled Personal gateway, named by its display name or
 * hostname. Kept apart from the organization gateways: Personal only mode
 * applies to Personal work and never joins another organization's policy.
 */
export function resolvePersonalModelGateway(
  personal: CanopyAccountResponse['personalModelGateway'] | null | undefined,
): OrgModelGateway | null {
  if (!personal) return null;
  return {
    organizationId: personal.organizationId,
    organizationName: personal.displayName || gatewayHostname(personal.baseUrl),
    baseUrl: personal.baseUrl,
    enforced: personal.enforced === true,
    modelIds: personal.models.map((model) => model.id),
  };
}

function sameOrganization(left: string, right: string): boolean {
  return (
    (normalizeUuid(left) ?? left.toLowerCase()) ===
    (normalizeUuid(right) ?? right.toLowerCase())
  );
}

/** The gateway of `organizationId`, or `null` when that org declares none. */
export function findGatewayForOrganization(
  gateways: readonly OrgModelGateway[],
  organizationId: string,
): OrgModelGateway | null {
  return (
    gateways.find((gateway) =>
      sameOrganization(gateway.organizationId, organizationId),
    ) ?? null
  );
}

/**
 * The gateway that governs `owner`'s work.
 *
 * - Personal work: none. No org gateway applies to it.
 * - Organization work: that org's gateway, never another org's.
 * - Unknown owner (org projects off, context not hydrated): the first
 *   ENFORCING gateway, because under the legacy union every enforcing org
 *   applies. An additive gateway is not a requirement, so it is not picked.
 */
export function selectGatewayForOwner(
  gateways: readonly OrgModelGateway[],
  owner: WorkOwner | undefined,
): OrgModelGateway | null {
  if (owner?.kind === 'personal') return null;
  if (owner?.kind === 'organization') {
    return findGatewayForOrganization(gateways, owner.organizationId);
  }
  return gateways.find((gateway) => gateway.enforced) ?? null;
}

/**
 * Settings order: the selected context's organization first, then the rest
 * by name, so the gateway the member is working under is the one on top.
 */
export function orderGatewaysForContext(
  gateways: readonly OrgModelGateway[],
  selectedOrganizationId: string | undefined,
): OrgModelGateway[] {
  const isSelected = (gateway: OrgModelGateway): boolean =>
    selectedOrganizationId !== undefined &&
    sameOrganization(gateway.organizationId, selectedOrganizationId);
  return [...gateways].sort((left, right) => {
    const selectedDelta = Number(isSelected(right)) - Number(isSelected(left));
    if (selectedDelta !== 0) return selectedDelta;
    return left.organizationName.localeCompare(right.organizationName);
  });
}

/**
 * Read every org gateway the member has, re-reading whenever preferences
 * change — the same signal the model catalog store uses to notice a new
 * account snapshot.
 *
 * Returns `undefined` while the first read is in flight so callers can tell
 * "not loaded yet" from "no gateway", and `[]` once we know there is none. A
 * failed read is reported as `[]`: this hook drives affordances, never
 * enforcement, which lives in the main-process session guard.
 */
export function useOrgModelGateways(): OrgModelGateway[] | undefined {
  const { account } = useCanopyCloudAccountState();
  return account
    ? resolveOrgModelGateways(account.enforcedSettings)
    : undefined;
}

/** {@link resolvePersonalModelGateway} for the signed-in account, kept current. */
export function usePersonalModelGateway(): OrgModelGateway | null {
  const { account } = useCanopyCloudAccountState();
  return resolvePersonalModelGateway(account?.personalModelGateway);
}
