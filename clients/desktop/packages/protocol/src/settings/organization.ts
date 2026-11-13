/**
 * Browser-safe contracts for the organization/team management surface, moved
 * from `apps/web/src/lib/teams/types.ts` (which re-exports them) so the shared
 * organization settings UI and both hosts read one definition.
 *
 * "Team" in the product sense maps to an Organization row. `OrganizationTeam`s
 * are optional sub-teams nested inside an org. These types describe the
 * request/response contracts for the `api/account/organizations/*` routes;
 * they intentionally use externalId UUID strings, never internal ids.
 */

import { z } from 'zod';
import type { BillingCapability } from '../billing';
import type {
  CanopyOrgEnforcedSettings,
  ModelGatewayModel,
} from '../canopy-server';
import { settingsDtoSchema } from './operation-definition';

/** Mirrors the Prisma `OrganizationRole` enum values. */
export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export const ORGANIZATION_ROLES: readonly OrganizationRole[] = [
  'OWNER',
  'ADMIN',
  'MEMBER',
];

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER';
}

export type OrgTeamsLapseReason =
  | 'trial_ended'
  | 'payment_failed'
  | 'subscription_ended';

/**
 * Body of the 403 returned when an organization loses its teams capability.
 * `code` is the reliable discriminator from permission 403s on the same route.
 */
export interface OrgTeamsLapsedError {
  error: string;
  code: 'org_teams_lapsed';
  lapseReason: OrgTeamsLapseReason | null;
  requiredPlanName: string | null;
  trialEndedAt: string | null;
}

/** Dashboard panel + org switcher summary row. */
export interface OrganizationSummary {
  id: string;
  name: string;
  role: OrganizationRole;
  memberCount: number;
  subTeamCount: number;
  /** Public URL of the org logo, or `null` when unset. */
  logoUrl: string | null;
  /**
   * Advisory share-destination access, present only when requested and
   * resolved. Absent means unknown; share mutations remain authoritative.
   */
  sharingAccess?: { teamsEntitled: boolean };
}

export interface OrganizationMember {
  /** User externalId UUID. */
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: OrganizationRole;
  /** externalIds of the sub-teams this member belongs to. */
  subTeamIds: string[];
}

export interface OrganizationSubTeam {
  /** OrganizationTeam externalId UUID. */
  id: string;
  name: string;
  memberCount: number;
}

/**
 * Per-scope telemetry data-sharing policy the org sets for its members.
 * Three-state, and every consumer must read it as such:
 *
 * - `true` — REQUIRED. Forced to Organization visibility on each member's
 *   desktop and locked on.
 * - `false` — PROHIBITED for work owned by this organization, at every share
 *   scope. Work owned by another organization or Personal is unaffected.
 * - `null` — unset. The member's own choice, which is also the effective state
 *   for every scope while `enforceMemberDataSharing` is false.
 *
 * Read with `=== true` / `=== false`, never `!== true`: treating unset as
 * prohibited darkens an org's dashboards, and treating it as required forces
 * sharing nobody asked for.
 */
export interface EnforcedSyncScopes {
  transcripts: boolean | null;
  plans: boolean | null;
  metadata: boolean | null;
  /** AI-generated worktree/session summaries, split out of `metadata`. */
  summaries: boolean | null;
}

/** Canonical scope keys, least invasive → most invasive. */
export const ENFORCED_SYNC_SCOPE_KEYS: readonly (keyof EnforcedSyncScopes)[] = [
  'metadata',
  'plans',
  'summaries',
  'transcripts',
];

/** One scope key of the org data-sharing configuration. */
export type EnforcedSyncScopeKey = keyof EnforcedSyncScopes;

/**
 * Billing capability that lets an org set a policy on each scope. Business
 * covers the "ZDR-lite" three; `metadata` — the prerequisite scope — is
 * Enterprise-only.
 *
 * Note what the absence of one does: an enforcing org without the capability
 * does not fall back to "each member chooses" for that scope, it gets the scope
 * force-enabled. The capability buys the ability to turn a scope OFF. See
 * `buildOrgEnforcedSettings` for the two boundaries on that (a stored
 * prohibition still wins, and the master switch still gates everything).
 *
 * Lives in this browser-safe module rather than beside the service so the admin
 * settings card can render an uncovered scope read-only from the same mapping
 * the server gates writes with. A second copy in the component would drift and
 * turn a plan change into a 403 the admin never saw coming.
 */
export const ENFORCE_SHARING_CAPABILITY_BY_SCOPE: Readonly<
  Record<EnforcedSyncScopeKey, BillingCapability>
> = {
  metadata: 'enforce_sharing_metadata',
  plans: 'enforce_sharing_plans',
  summaries: 'enforce_sharing_summaries',
  transcripts: 'enforce_sharing_transcripts',
};

export const MODEL_POLICY_CAPABILITY: BillingCapability =
  'enforce_model_policy';
export const MODEL_GATEWAY_CAPABILITY: BillingCapability =
  'custom_model_gateway';

/** Which scopes the org's plan lets it set a policy on. */
export type EnforcementScopeCoverage = Record<EnforcedSyncScopeKey, boolean>;

/**
 * Whether the org is inside the paid data-sharing-policy product at all, i.e.
 * whether its plan grants ANY per-scope enforcement capability.
 *
 * This is the gate on force-enablement, and it is load-bearing. The master
 * switch (`enforceMemberDataSharing`) is gated on ROLE only — `createOrganization`
 * is deliberately open ("no capability gate"), `free` grants no capabilities,
 * and a switch-only PATCH never trips `updateOrganizationConfig`'s per-scope
 * coverage check because no scope column changes. Without this gate, an owner
 * of a $0 org could flip one boolean and pin all four scopes — full chat
 * transcripts included — to `organization` visibility for every member, with
 * no member-side opt-out. That would invert the paywall this whole feature
 * exists to build: paying nothing would buy the strongest enforcement there is.
 *
 * So force-enablement is what a paying org's UNCOVERED scopes do, not what a
 * non-paying org's do. An org with no capabilities enforces exactly what it
 * enforced before force-enablement existed: nothing but its own stored columns.
 */
export function canForceEnableUncoveredScopes(
  coverage: EnforcementScopeCoverage,
): boolean {
  return ENFORCED_SYNC_SCOPE_KEYS.some((key) => coverage[key]);
}

/**
 * Whether one stored scope column resolves to a REQUIREMENT — the scope pinned
 * on at `organization` visibility for every member. Callers must have already
 * established that the master switch is on.
 *
 * Covered ⇒ strictly `=== true`. A `!== false` test here would silently require
 * every scope an entitled admin simply has not set.
 *
 * Uncovered, on a plan with some other enforcement capability ⇒ required unless
 * the column is `false`. What the capability buys is the ability to turn the
 * scope OFF, so a Business org does not get "each member chooses" for usage
 * metadata — it gets metadata on until it upgrades. The `false` carve-out is
 * the surviving prohibition: without it a downgrade would resume uploads the
 * org had blocked.
 *
 * Uncovered, on a plan with NO enforcement capability ⇒ never required. See
 * {@link canForceEnableUncoveredScopes}.
 *
 * Takes the whole coverage map rather than a single `covered` boolean on
 * purpose: the org-level gate and the per-scope answer then cannot be computed
 * apart, so no caller can reach the force-enable branch without it.
 *
 * Lives in this browser-safe module, beside
 * {@link ENFORCE_SHARING_CAPABILITY_BY_SCOPE} and for the same reason: the
 * server projects enforcement with it (`buildOrgEnforcedSettings`) and the
 * admin settings card renders each row's switch position with it. A second
 * copy in the component is how the card ends up telling an admin members
 * choose while the server pins the scope on.
 */
export function isScopeRequired(
  column: boolean | null,
  scope: EnforcedSyncScopeKey,
  coverage: EnforcementScopeCoverage,
): boolean {
  if (coverage[scope]) {
    return column === true;
  }
  return canForceEnableUncoveredScopes(coverage) && column !== false;
}

/** Coverage used when a caller has no plan context (no requirement filtering). */
export const FULL_ENFORCEMENT_COVERAGE: EnforcementScopeCoverage = {
  metadata: true,
  plans: true,
  summaries: true,
  transcripts: true,
};

/** Project a capability union onto the per-scope coverage map. */
export function enforcementCoverageFromCapabilities(
  capabilities: readonly BillingCapability[],
): EnforcementScopeCoverage {
  const granted = new Set<BillingCapability>(capabilities);
  return {
    metadata: granted.has(ENFORCE_SHARING_CAPABILITY_BY_SCOPE.metadata),
    plans: granted.has(ENFORCE_SHARING_CAPABILITY_BY_SCOPE.plans),
    summaries: granted.has(ENFORCE_SHARING_CAPABILITY_BY_SCOPE.summaries),
    transcripts: granted.has(ENFORCE_SHARING_CAPABILITY_BY_SCOPE.transcripts),
  };
}

export interface OrganizationDetail {
  isPersonal?: boolean;
  id: string;
  name: string;
  /** The requesting user's role in this org. */
  viewerRole: OrganizationRole;
  members: OrganizationMember[];
  subTeams: OrganizationSubTeam[];
  /** Minimum role required to view the usage & cost dashboard. */
  usageStatsMinRole: OrganizationRole;
  /** Whether the viewer's role currently clears `usageStatsMinRole`. */
  canViewUsageStats: boolean;
  /** Public URL of the org logo, or `null` when unset. */
  logoUrl: string | null;
  /** Org-level GitHub App connection status (CAN-405). */
  githubConnection: OrganizationGitHubConnectionDetail;
  /**
   * Telemetry sync scopes the org enforces on its members. Optional for
   * back-compat; the service always populates it.
   */
  enforcedSync?: EnforcedSyncScopes;
  /**
   * Master switch for data-sharing enforcement. A sibling of `enforcedSync`,
   * not a key inside it, so flipping the master never has to resend the scopes.
   * Optional here for the same back-compat reason as `enforcedSync`; the
   * service always populates it, and the settings surface reads the required
   * field on {@link OrganizationConfigDetail} instead.
   */
  enforceMemberDataSharing?: boolean;
  /**
   * Whether members may share worktrees and Cowork work with people outside
   * the organization by email. Off unless an owner or admin turns it on.
   * Optional for the same back-compat reason as `enforceMemberDataSharing`;
   * the service always populates it.
   */
  allowExternalContainerSharing?: boolean;
}

/**
 * Org appearance/branding payload. The extensible "appearance home" for the
 * org: only the moderated logo today, with forward-looking theming fields
 * (`themeName` / `colorMode` / `theme`) planned to land here.
 */
export interface OrganizationBrandingDetail {
  logoUrl: string | null;
}

/**
 * Declared content types the org logo upload accepts. The server validates
 * the logo with the account avatar rules (`ALLOWED_AVATAR_MIME_TYPES` in
 * `apps/web/src/lib/account-api-contracts.ts`); these must stay equal.
 */
export const ORGANIZATION_LOGO_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
] as const;

export type OrganizationLogoContentType =
  (typeof ORGANIZATION_LOGO_CONTENT_TYPES)[number];

/**
 * Largest org logo upload in bytes (5 MiB), equal to the account avatar
 * limit (`MAX_AVATAR_UPLOAD_BYTES`) the upload-url route enforces.
 */
export const ORGANIZATION_LOGO_MAX_BYTES = 5 * 1024 * 1024;

export function isOrganizationLogoContentType(
  value: unknown,
): value is OrganizationLogoContentType {
  return ORGANIZATION_LOGO_CONTENT_TYPES.some((type) => type === value);
}

/** Request body for `POST /api/account/organizations/[orgId]/logo/upload-url`. */
export interface OrgLogoUploadUrlRequest {
  mimeType: OrganizationLogoContentType;
  size: number;
}

/** `200` body for the org logo upload-url route. */
export interface OrgLogoUploadUrlResponse {
  /** Object path inside the quarantine bucket the client will PUT to. */
  filePath: string;
  /** Signed v4 write URL the client PUTs the file bytes to. */
  uploadUrl: string;
}

/** Request body for `POST /api/account/organizations/[orgId]/logo/commit`. */
export interface OrgLogoCommitRequest {
  /** Quarantine object path previously returned by the upload-url route. */
  filePath: string;
}

/** `400` error when an org logo upload URL cannot be issued. */
export const ORG_LOGO_UPLOAD_ERROR =
  'Unable to prepare organization logo upload.';

/** `400` error when an org logo cannot be committed/published. */
export const ORG_LOGO_COMMIT_ERROR = 'Unable to save organization logo.';

/** `422` error when an uploaded org logo fails image moderation. */
export const ORG_LOGO_MODERATION_ERROR = 'This image did not pass moderation.';

/** GitHub App connection status surfaced to the settings UI. */
export interface OrganizationGitHubConnectionDetail {
  connected: boolean;
  /** GitHub account login the app is installed on, when connected. */
  accountLogin: string | null;
}

/** What an owner lets members' outside (MCP) agents do in the organization. */
export type OrganizationExternalAgentAccessWire =
  | 'allowed'
  | 'read_only'
  | 'not_allowed';

/** Org configuration surfaced to the settings UI. */
export interface OrganizationConfigDetail {
  usageStatsMinRole: OrganizationRole;
  /** Owner-controlled outside-agent access, hidden by the route until rollout. */
  externalAgentAccess?: OrganizationExternalAgentAccessWire;
  /** Whether this organization-level control applies to the target. */
  applicable?: boolean;
  allowExternalContainerSharing: boolean;
  enforceMemberModelPolicy: boolean;
  blockedModelIds: string[];
  reviewedModelIds: string[];
  enforceMemberModelGateway: boolean;
  modelGatewayDisplayName?: string | null;
  modelGatewayRevision?: string;
  modelGatewayBaseUrl: string | null;
  modelGatewayModels: ModelGatewayModel[];
  modelGatewayEnforced: boolean;
  modelGatewayPromptCachePassthrough: boolean;
  /**
   * Master switch for data-sharing enforcement. Sibling of `enforcedSync` so
   * the two can be updated independently; the scope columns keep their stored
   * values while it is off, and re-enabling restores them.
   */
  enforceMemberDataSharing: boolean;
  /**
   * Member usage data: flows the organization turns off for members' desktop
   * app while they work in this organization. Narrowing only, no plan gate,
   * independent of `enforceMemberDataSharing`. Absent from older servers ⇒
   * `false`.
   */
  prohibitMemberProductAnalytics?: boolean;
  prohibitMemberErrorReports?: boolean;
  prohibitMemberSessionReplay?: boolean;
  prohibitMemberActiveUseSignal?: boolean;
  prohibitMemberFeatureFlagIdentity?: boolean;
  /**
   * The org's STORED per-scope configuration, unfiltered by the org's billing
   * plan, so the settings UI can render an uncovered scope read-only while
   * still showing its stored value. Plan coverage is applied at projection
   * time (see `buildOrgEnforcedSettings`), never to this read.
   */
  enforcedSync: EnforcedSyncScopes;
}

/**
 * PATCH body for the org config route. EVERY field is optional and independent:
 * the route parses each one separately and `updateOrganizationConfig` preserves
 * anything left `undefined`, so a caller flipping one control never has to
 * resend (and risk clobbering) the others. `usageStatsMinRole` is optional for
 * that reason too, which is what the scope-only and master-switch-only PATCHes
 * in `team-api.ts` actually send.
 */
export interface UpdateOrganizationConfigRequest {
  usageStatsMinRole?: OrganizationRole;
  externalAgentAccess?: OrganizationExternalAgentAccessWire;
  allowExternalContainerSharing?: boolean;
  enforceMemberDataSharing?: boolean;
  enforceMemberModelPolicy?: boolean;
  blockedModelIds?: string[];
  reviewedModelIds?: string[];
  enforceMemberModelGateway?: boolean;
  modelGatewayDisplayName?: string | null;
  expectedModelGatewayRevision?: string;
  modelGatewayBaseUrl?: string | null;
  modelGatewayModels?: ModelGatewayModel[];
  modelGatewayEnforced?: boolean;
  modelGatewayPromptCachePassthrough?: boolean;
  enforcedSync?: EnforcedSyncScopes;
  prohibitMemberProductAnalytics?: boolean;
  prohibitMemberErrorReports?: boolean;
  prohibitMemberSessionReplay?: boolean;
  prohibitMemberActiveUseSignal?: boolean;
  prohibitMemberFeatureFlagIdentity?: boolean;
}

export interface CreateOrganizationRequest {
  name: string;
}

export interface UpdateOrganizationRequest {
  name: string;
}

export interface AddMemberRequest {
  email: string;
  role?: OrganizationRole;
}

/**
 * A pending team invitation shown to the invitee on their dashboard. Sourced
 * from a team-scoped UserInvite bound to the viewer's verified email that
 * they have not yet accepted or declined. `id` is the invite externalId.
 */
export interface IncomingTeamInvitation {
  id: string;
  /** Organization externalId used by routes; absent on older servers. */
  organizationId?: string;
  organizationName: string;
  organizationTeamName: string | null;
  role: OrganizationRole;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
  /**
   * Settings the inviting org will enforce on members, for the OAuth-style
   * consent list. Empty/absent ⇒ nothing enforced.
   */
  enforcedSettings?: CanopyOrgEnforcedSettings[];
}

/** Invitee action on a pending team invitation. */
export type IncomingTeamInvitationAction = 'accept' | 'decline';

export interface ChangeMemberRoleRequest {
  role: OrganizationRole;
}

export interface CreateSubTeamRequest {
  name: string;
}

export interface RenameSubTeamRequest {
  name: string;
}

export interface SetSubTeamMembershipRequest {
  /** User externalIds; must all be members of the org. */
  memberUserIds: string[];
}

/* -------------------------------------------------------------------------- */
/* Additions for hosted settings (no web predecessor outside components)       */
/* -------------------------------------------------------------------------- */

/**
 * Lapse details the organization pages render in place of gated tabs
 * (CAN-2311). Mirrors `TeamLapsedInfo` in the web team page.
 */
export interface OrganizationLapsedInfo {
  /** When the org's trial ended, if known. */
  trialEndedAt: string | null;
  /** Why the org lost `teams`, so copy names the right remedy. */
  lapseReason: OrgTeamsLapseReason | null;
  /** Cheapest plan name that restores `teams`, for the CTA. */
  requiredPlanName: string | null;
}

/**
 * Whose identity a member-profile editor changes: the viewer's own global
 * identity, or (OWNER/ADMIN) a member's org-scoped override. Mirrors
 * `ProfileEditTarget` in the web profile editor.
 */
export type OrganizationMemberProfileEditTarget =
  | { mode: 'self' }
  | { mode: 'org-member'; orgId: string; userId: string };

/** One row of the org model-policy catalog (`GET /api/account/model-catalog`). */
export interface OrgModelCatalogEntry {
  id: string;
  label: string;
  description?: string;
  recommendedHarness?: string;
}

/** Status of an invitation created from the session invite route. */
export type OrganizationInviteState =
  | 'ACTIVE'
  | 'REDEEMED'
  | 'REVOKED'
  | 'DECLINED'
  | 'EXPIRED';

export type OrganizationInviteSeatPaymentState =
  | 'READY'
  | 'PROCESSING'
  | 'FAILED';

/** One invite from `GET /api/account/invites`. */
export interface OrganizationInvite {
  id: string;
  code: string;
  status: OrganizationInviteState;
  organizationId: string | null;
  organizationTeamName: string | null;
  role: OrganizationRole | null;
  invitedEmail: string | null;
  seatPaymentState: OrganizationInviteSeatPaymentState;
}

/** Safe outgoing invitation row; invite codes stay on the creation response. */
export type OrganizationOpenInvite = Omit<OrganizationInvite, 'id' | 'code'> & {
  externalId: string;
};

/** `GET /api/account/organizations/:orgId/invites` page. */
export interface OrganizationInviteListResponse {
  items: OrganizationOpenInvite[];
  nextCursor: string | null;
  enabled: boolean;
}

/** `201` body of `POST /api/account/invites`. */
export interface OrganizationCreatedInvite extends OrganizationInvite {
  emailQueued: boolean;
  emailSuppressed: boolean;
  emailDeferred: boolean;
  role: OrganizationRole;
  /** Additive delivery status from newer servers. */
  delivery?: 'sent' | 'resent' | 'deferred-for-payment' | 'email-suppressed';
}

/* -------------------------------------------------------------------------- */
/* Structural result schemas                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Structural checks mirroring the web runtime guards in `team-api.ts`: the
 * fields the UI depends on are validated and additive fields are tolerated.
 */
export const organizationRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

/** Optional `string | null`: absent on servers predating the field. */
const optionalNullableString = z.string().nullable().optional();

export const organizationSummaryShape = z.looseObject({
  id: z.string(),
  name: z.string(),
  role: organizationRoleSchema,
  memberCount: z.number(),
  subTeamCount: z.number(),
  logoUrl: optionalNullableString,
});

export const organizationSummarySchema = settingsDtoSchema<OrganizationSummary>(
  organizationSummaryShape,
);

export const organizationMemberShape = z.looseObject({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  role: organizationRoleSchema,
  subTeamIds: z.array(z.string()),
});

export const organizationSubTeamShape = z.looseObject({
  id: z.string(),
  name: z.string(),
  memberCount: z.number(),
});

export const organizationDetailShape = z.looseObject({
  id: z.string(),
  name: z.string(),
  viewerRole: organizationRoleSchema,
  members: z.array(organizationMemberShape),
  subTeams: z.array(organizationSubTeamShape),
  logoUrl: optionalNullableString,
});

export const organizationDetailSchema = settingsDtoSchema<OrganizationDetail>(
  organizationDetailShape,
);

const enforcedSyncScopeShape = z.boolean().nullable();

export const enforcedSyncScopesShape = z.looseObject({
  transcripts: enforcedSyncScopeShape,
  plans: enforcedSyncScopeShape,
  metadata: enforcedSyncScopeShape,
  summaries: enforcedSyncScopeShape,
});

export const modelGatewayModelShape = z.looseObject({
  id: z.string(),
  gatewayId: z.string(),
  label: z.string(),
  harness: z.enum(['claude', 'codex']),
  contextWindow: z.number(),
  supportedThinkingLevels: z.array(z.string()),
  toolSchemaProfile: z.enum(['standard', 'flat']),
});

export const organizationConfigDetailShape = z.looseObject({
  usageStatsMinRole: organizationRoleSchema,
  enforceMemberDataSharing: z.boolean(),
  enforceMemberModelPolicy: z.boolean(),
  blockedModelIds: z.array(z.string()),
  reviewedModelIds: z.array(z.string()),
  enforceMemberModelGateway: z.boolean(),
  modelGatewayDisplayName: z.string().nullable().optional(),
  modelGatewayRevision: z.string().optional(),
  modelGatewayBaseUrl: z.string().nullable(),
  modelGatewayModels: z.array(modelGatewayModelShape),
  modelGatewayEnforced: z.boolean(),
  modelGatewayPromptCachePassthrough: z.boolean(),
  enforcedSync: enforcedSyncScopesShape,
  prohibitMemberProductAnalytics: z.boolean().optional(),
  prohibitMemberErrorReports: z.boolean().optional(),
  prohibitMemberSessionReplay: z.boolean().optional(),
  prohibitMemberActiveUseSignal: z.boolean().optional(),
  prohibitMemberFeatureFlagIdentity: z.boolean().optional(),
});

export const organizationConfigDetailSchema =
  settingsDtoSchema<OrganizationConfigDetail>(organizationConfigDetailShape);

export const incomingTeamInvitationShape = z.looseObject({
  id: z.string(),
  organizationId: z.string().optional(),
  organizationName: z.string(),
  organizationTeamName: z.string().nullable(),
  role: organizationRoleSchema,
  invitedByName: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const organizationLapsedInfoSchema = z.looseObject({
  trialEndedAt: z.string().nullable(),
  lapseReason: z
    .enum(['trial_ended', 'payment_failed', 'subscription_ended'])
    .nullable(),
  requiredPlanName: z.string().nullable(),
});

export const orgModelCatalogEntryShape = z.looseObject({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommendedHarness: z.string().optional(),
});

const inviteSeatPaymentStateSchema = z.enum(['READY', 'PROCESSING', 'FAILED']);

export const organizationInviteListShape = z.looseObject({
  enabled: z.boolean(),
  nextCursor: z.string().nullable(),
  items: z.array(
    z.looseObject({
      externalId: z.string(),
      status: z.enum(['ACTIVE', 'REDEEMED', 'REVOKED', 'DECLINED', 'EXPIRED']),
      organizationId: z.string().nullable(),
      organizationTeamName: z.string().nullable(),
      role: organizationRoleSchema.nullable(),
      invitedEmail: z.string().nullable(),
      seatPaymentState: inviteSeatPaymentStateSchema,
    }),
  ),
});

export const organizationCreatedInviteShape = z.looseObject({
  id: z.string(),
  code: z.string(),
  emailQueued: z.boolean(),
  emailSuppressed: z.boolean(),
  emailDeferred: z.boolean(),
  seatPaymentState: inviteSeatPaymentStateSchema,
  role: z.enum(['ADMIN', 'MEMBER']),
});
