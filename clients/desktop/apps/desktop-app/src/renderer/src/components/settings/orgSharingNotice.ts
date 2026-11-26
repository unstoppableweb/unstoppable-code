import {
  resolveEffectiveTelemetrySharing,
  resolveTelemetryEnforcementByOrganization,
} from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  TELEMETRY_SHARING_SCOPES,
  type CanopyCloudAccountPublicState,
  type PreferencesData,
  type TelemetryScopeKey,
  type TelemetrySharingPreferences,
} from '@canopy/desktop-shared/types';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';

/** The preferences the organization requirement notice reads. */
export type OrgSharingNoticePreferences = Pick<
  PreferencesData,
  'telemetrySharing' | 'orgSharingNoticesSeen' | 'dataChoicesConfirmedAt'
>;

/** One organization's sharing requirement beyond the member's own choice. */
export interface OrgSharingRequirement {
  readonly organizationId: string;
  readonly organizationName: string;
  /** Every scope the organization pins to Organization, in canonical order. */
  readonly requiredScopes: readonly TelemetryScopeKey[];
  /** Order-independent key of {@link requiredScopes}, stored once seen. */
  readonly signature: string;
}

export type OrgSharingNoticeDecision =
  /** Not enough is known yet: no conclusive account, or no policy snapshot. */
  | { readonly kind: 'wait' }
  /** Nothing to show or record. */
  | { readonly kind: 'none' }
  /** Record the existing user's current requirements without showing them. */
  | { readonly kind: 'seed'; readonly seen: Record<string, string> }
  /** Show this requirement next; `remaining` more wait behind it. */
  | {
      readonly kind: 'show';
      readonly requirement: OrgSharingRequirement;
      readonly remaining: number;
    };

/** The stored key for a required-scope set, independent of its order. */
export function orgSharingRequirementSignature(
  scopes: readonly TelemetryScopeKey[],
): string {
  return [...new Set(scopes)].sort().join(',');
}

/**
 * Whether the account belongs to a signed-in member whose organizations can
 * hold policy. A guest has no memberships, and a guest-to-member sign-in must
 * still seed rather than show requirements that predate it.
 */
export function isSignedInMemberAccount(
  account: CanopyCloudAccountPublicState | null,
): boolean {
  return account !== null && account.hasApiKey && !isGuestAccount(account);
}

function withAllScopesOff(
  sharing: TelemetrySharingPreferences,
): TelemetrySharingPreferences {
  const next: TelemetrySharingPreferences = { ...sharing };
  for (const scope of TELEMETRY_SHARING_SCOPES) next[scope] = 'off';
  return next;
}

/**
 * Each organization the member belongs to whose policy raises some scope
 * above the member's own choice for that organization's work. Organizations
 * come from the account's memberships, matched by ID to the policy map, and
 * are returned sorted by organization ID so the order never depends on how
 * the server listed them. The personal organization is skipped: Personal work
 * follows the member's own choices.
 */
export function resolveOrgSharingRequirements(
  account: CanopyCloudAccountPublicState,
  sharing: TelemetrySharingPreferences,
): OrgSharingRequirement[] {
  const byOrganization = resolveTelemetryEnforcementByOrganization(account);
  const personalId = normalizeUuid(account.personalOrganizationId);
  const requirements = new Map<string, OrgSharingRequirement>();
  const baseline = withAllScopesOff(sharing);

  for (const membership of account.organizations ?? []) {
    const organizationId = normalizeUuid(membership.id);
    if (!organizationId || organizationId === personalId) continue;
    if (requirements.has(organizationId)) continue;
    const policy = byOrganization.get(organizationId);
    if (!policy) continue;

    // Against an all-off baseline the effective value isolates what the
    // policy itself pins, including metadata raised for transcripts or
    // summaries.
    const pinned = resolveEffectiveTelemetrySharing(
      baseline,
      policy.enforcement,
    );
    const requiredScopes = TELEMETRY_SHARING_SCOPES.filter(
      (scope) => pinned[scope] === 'organization',
    );
    if (requiredScopes.length === 0) continue;

    const effective = resolveEffectiveTelemetrySharing(
      sharing,
      policy.enforcement,
    );
    const exceedsOwnChoice = requiredScopes.some(
      (scope) =>
        effective[scope] === 'organization' &&
        sharing[scope] !== 'organization',
    );
    if (!exceedsOwnChoice) continue;

    requirements.set(organizationId, {
      organizationId,
      organizationName:
        membership.name.trim().length > 0
          ? membership.name
          : policy.organizationName,
      requiredScopes,
      signature: orgSharingRequirementSignature(requiredScopes),
    });
  }

  return [...requirements.values()].sort((a, b) =>
    a.organizationId < b.organizationId
      ? -1
      : a.organizationId > b.organizationId
        ? 1
        : 0,
  );
}

/**
 * What the notice host does with the current account and preferences.
 *
 * - An existing user (no `dataChoicesConfirmedAt` and no seen map) is seeded
 *   once, silently, with the requirements that exist at their first
 *   conclusive signed-in read. The seed always writes the map, even empty,
 *   so it happens only once. Signed out, seeding waits for sign-in.
 *   A profile that re-accepts the Welcome gate after a preferences recovery
 *   that lost the seen map counts as a new member: it gets
 *   `dataChoicesConfirmedAt` without the map, so its current requirements
 *   show as notices rather than being seeded silently.
 * - Otherwise the first requirement whose signature differs from the one
 *   last seen for its organization is shown. A requirement the member
 *   already meets is never returned, so it shows and records nothing.
 *
 * `account` must come from a conclusive read; pass `null` until one exists.
 */
export function decideOrgSharingNotice(
  account: CanopyCloudAccountPublicState | null,
  preferences: OrgSharingNoticePreferences | null,
): OrgSharingNoticeDecision {
  if (account === null || preferences === null) return { kind: 'wait' };
  const signedIn = isSignedInMemberAccount(account);
  // Without a policy snapshot the requirements are unknown, not empty.
  if (signedIn && account.telemetryEnforcementUnavailable === true) {
    return { kind: 'wait' };
  }

  const needsSeed =
    preferences.dataChoicesConfirmedAt === undefined &&
    preferences.orgSharingNoticesSeen === undefined;
  if (!signedIn) return needsSeed ? { kind: 'wait' } : { kind: 'none' };

  const requirements = resolveOrgSharingRequirements(
    account,
    preferences.telemetrySharing,
  );
  if (needsSeed) {
    const seen: Record<string, string> = {};
    for (const requirement of requirements) {
      seen[requirement.organizationId] = requirement.signature;
    }
    return { kind: 'seed', seen };
  }

  const seen = preferences.orgSharingNoticesSeen ?? {};
  const pending = requirements.filter(
    (requirement) => seen[requirement.organizationId] !== requirement.signature,
  );
  const [next, ...rest] = pending;
  return next
    ? { kind: 'show', requirement: next, remaining: rest.length }
    : { kind: 'none' };
}
