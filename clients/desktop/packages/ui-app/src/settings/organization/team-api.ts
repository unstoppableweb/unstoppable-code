import type { AiGatewayConnectionResult } from '@canopy/protocol/model-gateway/discovery';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type {
  CreateOrgProjectsRequest,
  CreateOrgProjectsResponse,
  OrgProjectDetail,
  OrgProjectGrant,
  OrgProjectLifecycleRequest,
  OrgProjectLifecycleResult,
  OrgProjectPage,
  OrgProjectPreference,
  OrgProjectSummary,
  ReplaceOrgProjectGrantsRequest,
  UpdateOrgProjectRequest,
} from '@canopy/protocol/org-projects';
import type {
  FeedItemPermalinkResponse,
  FeedItemType,
  FeedPageResponse,
  ModelGatewayModel,
  WorktreeSummaryHistoryResponse,
} from '@canopy/protocol';
import type {
  MemoryParticipationMember,
  ViewerDataSharingStatus,
} from '@canopy/protocol';
import type {
  EnforcedSyncScopes,
  IncomingTeamInvitation,
  IncomingTeamInvitationAction,
  OrganizationConfigDetail,
  OrganizationDetail,
  OrganizationExternalShareListResponse,
  OrganizationLogoContentType,
  OrganizationRole,
  OrganizationSummary,
  OrgModelCatalogEntry,
} from '@canopy/protocol/settings/organization';
import type {
  SubscriptionPricingResponse,
  TeamUsageResponse,
} from '@canopy/protocol/telemetry';
import type {
  BillingSummary,
  ChargePage,
  CreditsLedgerPage,
  CreditsSummary,
  InvoicePage,
} from '@canopy/protocol/settings/billing';
import type {
  GitHubRepositoryPickerPage,
  OrganizationRepositoriesRefreshResult,
  OrganizationRepositoryPage,
  SetOrganizationRepositoryHiddenRequest,
  SetOrganizationRepositoryHiddenResult,
} from '@canopy/protocol/settings/organization-repositories';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';

/**
 * Organization settings data helpers. Each helper names a fixed
 * `SETTINGS_OPERATIONS` entry and runs it through the host's settings client
 * (`client.read` / `client.write`), which validates input before sending and
 * the response before resolving. Failures are rethrown as a
 * {@link TeamApiError} carrying the HTTP status and structured `code`; the
 * route's `{ error }` text rides along as `serverDetail` for logs only.
 * Callers pick their copy from `settings/errors` (status and code), never
 * from the server's text.
 *
 * Every mutation route returns the full {@link OrganizationDetail}, so callers
 * replace their local detail state from the resolved value rather than patching
 * it field-by-field.
 *
 * Financial calls (seat and plan-change quotes, subscription mutation, setup
 * intents, card mutation, credit top-ups, automatic top-up changes) are not
 * table operations; they live in the web-only
 * `apps/web/src/components/billing/team-billing-api.ts`.
 */
/**
 * The message every {@link TeamApiError} carries. Generic on purpose: the
 * route's own text is never user copy, so `String(err)`, `${err}` and a stray
 * `err.message` render this instead of server text. Callers choose real copy
 * with `settingsActionErrorCopy` / `settingsLoadErrorCopy` from
 * `settings/errors`.
 */
export const TEAM_API_ERROR_COPY = 'Something went wrong. Try again.';

export class TeamApiError extends Error {
  /**
   * Structured code from the response's top-level `code`, when the route
   * publishes one. Routes that share an HTTP status across states (the GitHub
   * repository picker answers 409 for both a missing and a suspended
   * connection) rely on it; most routes leave it undefined.
   */
  public readonly code: string | undefined;

  public readonly status: number;

  /**
   * The route's `{ error }` text, or a local diagnostic such as
   * `Invalid server response`. For logs only: never render it.
   */
  public readonly serverDetail: string | undefined;

  constructor(status: number, serverDetail?: string, code?: string) {
    super(TEAM_API_ERROR_COPY);
    this.name = 'TeamApiError';
    this.status = status;
    this.serverDetail = serverDetail;
    this.code = code;
  }
}

export type { MemoryParticipationMember, OrgModelCatalogEntry };

const INVALID_RESPONSE = 'Invalid server response';

/**
 * The legacy {@link TeamApiError} for a failed settings call: its status and
 * the route's `code`, with the route's `{ error }` text (or `Invalid server
 * response` for a body that failed validation) as the log-only
 * `serverDetail`. A failure
 * without a response (offline, a write whose outcome is unknown, a host-side
 * input refusal) is rethrown unchanged: it is not a `TeamApiError`, so
 * callers keep showing their generic copy, as they did for a failed `fetch`.
 */
export function toTeamApiError(error: unknown): unknown {
  if (!(error instanceof SettingsOperationError)) return error;
  if (error.code === 'invalid_response')
    return new TeamApiError(
      error.status ?? 200,
      INVALID_RESPONSE,
      error.serverCode,
    );
  if (error.status === undefined) return error;
  // The payload carries the route's text only when it sent one; it becomes
  // the log-only `serverDetail`.
  return new TeamApiError(
    error.status,
    error.toPayload().message,
    error.serverCode,
  );
}

/** Run one settings call, rethrowing failures through {@link toTeamApiError}. */
async function settle<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error: unknown) {
    throw toTeamApiError(error);
  }
}

/** `value` unless it is empty, so an empty filter is omitted like before. */
function nonEmpty(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : value;
}

export async function listOrganizations(
  client: AccountOrganizationSettingsClient,
): Promise<OrganizationSummary[]> {
  const data = await settle(() => client.read('organization.list', {}));
  return data.organizations;
}

export async function createOrganization(
  client: AccountOrganizationSettingsClient,
  name: string,
): Promise<OrganizationDetail> {
  return settle(() => client.write('organization.create', { name }));
}

export async function getOrganizationDetail(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<OrganizationDetail> {
  return settle(() =>
    client.read('organization.detail', { organizationId: orgId }),
  );
}

export async function renameOrganization(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  name: string,
): Promise<OrganizationDetail> {
  return settle(() =>
    client.write('organization.rename', { organizationId: orgId, name }),
  );
}

/**
 * Upload a new org logo: the host signs a GCS write URL, PUTs the bytes to it
 * without account credentials, then moderates and publishes the object,
 * resolving to the refreshed organization detail with the new `logoUrl`. A
 * moderation refusal is a 422 {@link TeamApiError} with the route's message;
 * a failed storage PUT rejects with the host's (non-`TeamApiError`) error.
 */
export async function uploadOrgLogo(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  file: Blob,
  mimeType: OrganizationLogoContentType,
): Promise<OrganizationDetail> {
  try {
    return await client.write('organization.logo.upload', {
      organizationId: orgId,
      mimeType,
      size: file.size,
      file,
    });
  } catch (error: unknown) {
    // The storage PUT answered, but it is not the route's refusal: keep the
    // generic upload copy, as the direct PUT did.
    if (
      error instanceof SettingsOperationError &&
      error.serverCode === 'upload_failed'
    )
      throw error;
    throw toTeamApiError(error);
  }
}

/**
 * Clear the org logo back to the initials placeholder via the org PATCH route
 * (`logoUrl: null`), returning the refreshed organization detail.
 */
export async function clearOrgLogo(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<OrganizationDetail> {
  return settle(() =>
    client.write('organization.logo.clear', { organizationId: orgId }),
  );
}

export async function deleteOrganization(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<void> {
  await settle(() =>
    client.write('organization.delete', { organizationId: orgId }),
  );
}

export async function changeMemberRole(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  memberId: string,
  role: OrganizationRole,
): Promise<OrganizationDetail> {
  return settle(() =>
    client.write('organization.members.updateRole', {
      organizationId: orgId,
      userId: memberId,
      role,
    }),
  );
}

export async function removeMember(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  memberId: string,
): Promise<OrganizationDetail> {
  return settle(() =>
    client.write('organization.members.remove', {
      organizationId: orgId,
      userId: memberId,
    }),
  );
}

export async function leaveOrganization(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<void> {
  await settle(() =>
    client.write('organization.leave', { organizationId: orgId }),
  );
}

export async function createSubTeam(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  name: string,
): Promise<OrganizationDetail> {
  return settle(() =>
    client.write('organization.teams.create', { organizationId: orgId, name }),
  );
}

export async function renameSubTeam(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  teamId: string,
  name: string,
): Promise<OrganizationDetail> {
  return settle(() =>
    client.write('organization.teams.rename', {
      organizationId: orgId,
      teamId,
      name,
    }),
  );
}

export async function deleteSubTeam(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  teamId: string,
): Promise<OrganizationDetail> {
  return settle(() =>
    client.write('organization.teams.delete', {
      organizationId: orgId,
      teamId,
    }),
  );
}

export async function setSubTeamMembership(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  teamId: string,
  memberUserIds: string[],
): Promise<OrganizationDetail> {
  return settle(() =>
    client.write('organization.teams.setMembers', {
      organizationId: orgId,
      teamId,
      memberUserIds,
    }),
  );
}

/** Client-side query params for the team usage dashboard fetch. */
export interface FetchTeamUsageParams {
  scope: 'organization' | 'team';
  /** Required when `scope === 'team'`; the sub-team externalId. */
  teamId?: string;
  granularity: 'hour' | 'day' | 'week';
  /** Inclusive ISO start of the reporting window. */
  startIso: string;
  /** Exclusive ISO end of the reporting window. */
  endIso: string;
  /** Optional attribution-user filter (member externalId). */
  userId?: string;
}

/** Fetch the rolled-up team usage & cost dashboard payload for a scope/range. */
export async function fetchTeamUsage(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  params: FetchTeamUsageParams,
): Promise<TeamUsageResponse> {
  const teamId = nonEmpty(params.teamId);
  const userId = nonEmpty(params.userId);
  return settle(() =>
    client.read('organization.statistics.usage', {
      organizationId: orgId,
      scope: params.scope,
      granularity: params.granularity,
      startIso: params.startIso,
      endIso: params.endIso,
      ...(teamId === undefined ? {} : { teamId }),
      ...(userId === undefined ? {} : { userId }),
    }),
  );
}

/** Read the org's usage-stats configuration (min viewer role). */
export async function getOrganizationConfig(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<OrganizationConfigDetail> {
  return settle(() =>
    client.read('organization.settings.config', { organizationId: orgId }),
  );
}

/** Read per-member organization-memory participation for an org. */
export async function fetchMemoryParticipation(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<{ members: MemoryParticipationMember[] }> {
  const data = await settle(() =>
    client.read('organization.settings.memoryParticipation', {
      organizationId: orgId,
    }),
  );
  return { members: data.members };
}

/**
 * Read the viewer's own data-sharing evidence for an org (CAN-3383). The
 * response describes only the signed-in viewer; a malformed body is rejected
 * rather than trusted, so a hint never renders from a partial status.
 */
export async function fetchViewerDataSharing(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<ViewerDataSharingStatus> {
  return settle(() =>
    client.read('organization.dataSharing.viewer', { organizationId: orgId }),
  );
}

/** Enable or disable one member's participation in organization memory. */
export async function updateMemberMemoryParticipation(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  memberId: string,
  enabled: boolean,
): Promise<{ memoryEnabled: boolean }> {
  const data = await settle(() =>
    client.write('organization.members.memory.update', {
      organizationId: orgId,
      userId: memberId,
      enabled,
    }),
  );
  return { memoryEnabled: data.memoryEnabled };
}

/** Update the minimum role required to view the usage dashboard. */
export async function updateUsageStatsMinRole(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  usageStatsMinRole: OrganizationRole,
): Promise<OrganizationConfigDetail> {
  return settle(() =>
    client.write('organization.settings.usage.update', {
      organizationId: orgId,
      usageStatsMinRole,
    }),
  );
}

/**
 * Read the org's observed subscription plan types joined with catalog defaults
 * and per-org price overrides. Member-visible; `canEdit` reflects whether the
 * caller may change overrides.
 */
export async function getSubscriptionPlanPricing(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<SubscriptionPricingResponse> {
  return settle(() =>
    client.read('organization.settings.subscriptionPricing', {
      organizationId: orgId,
    }),
  );
}

/**
 * Set (or, when `monthlyPriceUsd` is null, clear) a per-org monthly price
 * override for a plan key. Returns the refreshed pricing table. Admins/owners
 * only (server-enforced). These prices only feed cost estimates; nothing is
 * charged.
 */
export async function setSubscriptionPlanPriceOverride(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  planKey: string,
  monthlyPriceUsd: number | null,
): Promise<SubscriptionPricingResponse> {
  return settle(() =>
    client.write('organization.settings.subscriptionPricing.update', {
      organizationId: orgId,
      planKey,
      monthlyPriceUsd,
    }),
  );
}

/**
 * Begin the org-level GitHub App connection (CAN-405). POSTs to start the flow;
 * the server sets a signed-nonce cookie and returns the GitHub install URL the
 * caller should navigate the browser to. Admins/owners only (server-enforced).
 */
export async function startGitHubConnect(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<{ installUrl: string }> {
  const data = await settle(() =>
    client.write('organization.github.connect', { organizationId: orgId }),
  );
  return { installUrl: data.installUrl };
}

/**
 * Page through the repositories the org's GitHub App installation can see
 * (CAN-2945). Admins/owners only (server-enforced); `query` filters the
 * returned page by full name.
 */
export async function listOrganizationGitHubRepositories(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  options: { cursor?: string; query?: string } = {},
): Promise<GitHubRepositoryPickerPage> {
  const cursor = nonEmpty(options.cursor);
  const query = nonEmpty(options.query);
  return settle(() =>
    client.read('organization.github.repositories', {
      organizationId: orgId,
      ...(cursor === undefined ? {} : { cursor }),
      ...(query === undefined ? {} : { query }),
    }),
  );
}

/** Remove the org's GitHub App connection. Admins/owners only. */
export async function disconnectGitHub(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<void> {
  await settle(() =>
    client.write('organization.github.disconnect', { organizationId: orgId }),
  );
}

/**
 * Flip the master data-sharing enforcement switch.
 *
 * Sends ONLY `enforceMemberDataSharing`, never the scopes: the columns are
 * siblings on the same row, so omitting them preserves the admin's per-scope
 * configuration. Clearing them on the way off would silently discard the policy
 * and hand back an empty card when enforcement is turned on again.
 */
export async function updateEnforceMemberDataSharing(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  enforceMemberDataSharing: boolean,
): Promise<OrganizationConfigDetail> {
  return settle(() =>
    client.write('organization.settings.policies.update', {
      organizationId: orgId,
      enforceMemberDataSharing,
    }),
  );
}

/** One member usage-data prohibition the org admin can set. */
export type MemberUsageDataPolicyField =
  | 'prohibitMemberProductAnalytics'
  | 'prohibitMemberErrorReports'
  | 'prohibitMemberSessionReplay'
  | 'prohibitMemberActiveUseSignal'
  | 'prohibitMemberFeatureFlagIdentity';

/**
 * Turn one usage-data flow off (or back to the member's choice) for members'
 * desktop app while they work in this organization. Sends ONLY the changed
 * field, so the rest of the policies row, including the other prohibitions,
 * is left untouched. Narrowing only and not plan-gated.
 */
export async function updateMemberUsageDataPolicy(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  field: MemberUsageDataPolicyField,
  prohibited: boolean,
): Promise<OrganizationConfigDetail> {
  return settle(() =>
    client.write('organization.settings.policies.update', {
      organizationId: orgId,
      [field]: prohibited,
    }),
  );
}

/**
 * Allow or stop members sharing worktrees and Cowork work with people outside
 * the organization. Sends ONLY `allowExternalContainerSharing`, so the
 * data-sharing policy on the same config row is left untouched.
 */
export async function updateAllowExternalContainerSharing(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  allowExternalContainerSharing: boolean,
): Promise<OrganizationConfigDetail> {
  return settle(() =>
    client.write('organization.settings.policies.update', {
      organizationId: orgId,
      allowExternalContainerSharing,
    }),
  );
}

/**
 * One page of the organization's external shares (CAN-3420). Owners and
 * Admins only; the server refuses Members.
 */
export async function listOrganizationExternalShares(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  cursor?: string,
): Promise<OrganizationExternalShareListResponse> {
  return settle(() =>
    client.read('organization.externalShares.list', {
      organizationId: orgId,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
}

/** Remove one external share right away (CAN-3420). */
export async function removeOrganizationExternalShare(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  shareId: string,
): Promise<void> {
  await settle(() =>
    client.write('organization.externalShares.remove', {
      organizationId: orgId,
      shareId,
    }),
  );
}

/**
 * Read the model catalog the org's policy is expressed against.
 *
 * Deliberately NOT the brand-scoped `ai-gateway/models` route: that one is
 * unauthenticated and CDN-cached with a content ETag, so it cannot vary per
 * org. This one is authed and unions the gateway catalog with the generated
 * native-only models, which is what makes a native-only model toggleable at
 * all.
 */
export async function fetchOrgModelCatalog(
  client: AccountOrganizationSettingsClient,
): Promise<OrgModelCatalogEntry[]> {
  const data = await settle(() =>
    client.read('organization.settings.modelCatalog', {}),
  );
  return data.models;
}

/**
 * Flip the master model-policy enforcement switch.
 *
 * The displayed catalog accompanies every policy save as the reviewed
 * snapshot. The blocked list remains omitted so an off/on cycle preserves the
 * admin's curated denials.
 */
export async function updateEnforceMemberModelPolicy(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  enforceMemberModelPolicy: boolean,
  reviewedModelIds: readonly string[],
): Promise<OrganizationConfigDetail> {
  return settle(() =>
    client.write('organization.settings.policies.update', {
      organizationId: orgId,
      enforceMemberModelPolicy,
      reviewedModelIds: [...reviewedModelIds],
    }),
  );
}

/**
 * Persist the org's blocked-model list.
 *
 * `reviewedModelIds` is sent with EVERY save, and that is the whole mechanism
 * behind "new models are blocked until an admin reviews them": it records the
 * catalog this card actually displayed. A model absent from it is blocked at
 * runtime, so saving is what marks the catalog as reviewed. Omitting it here
 * would leave the snapshot frozen at whatever an older client last wrote and
 * silently keep newly-shipped models blocked forever.
 */
export async function updateBlockedModelIds(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  blockedModelIds: readonly string[],
  reviewedModelIds: readonly string[],
): Promise<OrganizationConfigDetail> {
  return settle(() =>
    client.write('organization.settings.policies.update', {
      organizationId: orgId,
      blockedModelIds: [...blockedModelIds],
      reviewedModelIds: [...reviewedModelIds],
    }),
  );
}

/**
 * The gateway model fields the config route accepts. Rows read back from the
 * server may carry additive fields; the input schema is strict, so only the
 * contract fields are sent.
 */
function modelGatewayModelInput(model: ModelGatewayModel): ModelGatewayModel {
  return {
    id: model.id,
    gatewayId: model.gatewayId,
    label: model.label,
    harness: model.harness,
    contextWindow: model.contextWindow,
    supportedThinkingLevels: [...model.supportedThinkingLevels],
    toolSchemaProfile: model.toolSchemaProfile,
  };
}

/**
 * Persist the org's own model-gateway configuration in one PATCH.
 *
 * Every field is sent together on purpose. The server decides whether a write
 * TIGHTENS the policy by comparing the whole next state against the stored one
 * (`modelGatewayTightens` in `lib/teams/team-service.ts`), so a partial body
 * would have it diff against fields the card never intended to change — e.g.
 * dropping a model row would read as a tightening merely because the array
 * arrived short.
 */
export async function updateModelGatewayConfig(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  input: {
    enforceMemberModelGateway: boolean;
    modelGatewayBaseUrl: string | null;
    modelGatewayModels: readonly ModelGatewayModel[];
    modelGatewayEnforced: boolean;
    modelGatewayPromptCachePassthrough: boolean;
  },
): Promise<OrganizationConfigDetail> {
  return settle(() =>
    client.write('organization.settings.policies.update', {
      organizationId: orgId,
      enforceMemberModelGateway: input.enforceMemberModelGateway,
      modelGatewayBaseUrl: input.modelGatewayBaseUrl,
      modelGatewayModels: input.modelGatewayModels.map(modelGatewayModelInput),
      modelGatewayEnforced: input.modelGatewayEnforced,
      modelGatewayPromptCachePassthrough:
        input.modelGatewayPromptCachePassthrough,
    }),
  );
}

/**
 * Patch the organization's AI gateway. Only the fields present change; the
 * revision rejects a model list edited somewhere else since it was read.
 */
export async function updateAiGatewayConfig(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  input: {
    expectedModelGatewayRevision?: string;
    modelGatewayDisplayName?: string | null;
    modelGatewayBaseUrl?: string | null;
    modelGatewayModels?: readonly ModelGatewayModel[];
    enforceMemberModelGateway?: boolean;
    modelGatewayEnforced?: boolean;
  },
): Promise<OrganizationConfigDetail> {
  const { modelGatewayModels, ...fields } = input;
  return settle(() =>
    client.write('organization.settings.policies.update', {
      organizationId: orgId,
      ...fields,
      ...(modelGatewayModels === undefined
        ? {}
        : {
            modelGatewayModels: modelGatewayModels.map(modelGatewayModelInput),
          }),
    }),
  );
}

/** Probe the organization's AI gateway and list the models it serves. */
export async function connectOrganizationAiGateway(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  input: { baseUrl: string; apiKey?: string },
): Promise<AiGatewayConnectionResult> {
  return settle(() =>
    client.write('organization.settings.ai-gateway.connect', {
      ...input,
      organizationId: orgId,
    }),
  );
}

/**
 * Update the org-enforced telemetry-sync scopes. The PATCH route treats
 * `usageStatsMinRole` and `enforcedSync` independently, so this sends only the
 * enforced scopes and leaves the role untouched — no need to thread a
 * possibly-stale `usageStatsMinRole` through.
 *
 * `enforceMemberDataSharing` IS sent, and deliberately: it is the route's marker
 * that this body came from a client that understands `false` as a prohibition
 * rather than as "not required". Without it the route downgrades every `false`
 * to `null` to protect against stale bundles mid-deploy. It carries the value
 * the card is already rendering, so it re-asserts rather than changes state.
 */
export async function updateEnforcedSync(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  enforcedSync: EnforcedSyncScopes,
  enforceMemberDataSharing: boolean,
): Promise<OrganizationConfigDetail> {
  return settle(() =>
    client.write('organization.settings.policies.update', {
      organizationId: orgId,
      enforceMemberDataSharing,
      enforcedSync: {
        transcripts: enforcedSync.transcripts,
        plans: enforcedSync.plans,
        metadata: enforcedSync.metadata,
        summaries: enforcedSync.summaries,
      },
    }),
  );
}

/**
 * Server-side feed filters serialized onto the feed fetch. All dimensions are
 * optional and combine with AND on the server:
 * - `q`: free-text query (ILIKE against each branch's primary text column)
 * - `types`: restrict to these activity types (empty = all types)
 * - `actorId`: member externalId (UUID) to filter by actor
 */
export interface TeamFeedFilters {
  q?: string;
  types?: FeedItemType[];
  actorId?: string;
}

/**
 * Fetch one page of the team activity feed. Pass the previous page's
 * `nextCursor` to page toward older items; omit it for the newest page. The
 * current `filters` must be re-sent on every page fetch (same lifecycle as the
 * cursor) so server-side narrowing stays consistent across pages.
 */
export async function getTeamFeed(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  cursor?: string,
  filters?: TeamFeedFilters,
): Promise<FeedPageResponse> {
  const pageCursor = nonEmpty(cursor);
  const q = nonEmpty(filters?.q);
  const types =
    filters?.types !== undefined && filters.types.length > 0
      ? [...filters.types]
      : undefined;
  const actorId = nonEmpty(filters?.actorId);
  return settle(() =>
    client.read('organization.feed.page', {
      organizationId: orgId,
      ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
      ...(q === undefined ? {} : { q }),
      ...(types === undefined ? {} : { types }),
      ...(actorId === undefined ? {} : { actorId }),
    }),
  );
}

/**
 * Resolve a single feed item by its stable id, with a window of surrounding
 * items for permalink/deep-link rendering.
 */
export async function getTeamFeedItem(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  itemId: string,
): Promise<FeedItemPermalinkResponse> {
  return settle(() =>
    client.read('organization.feed.item', { organizationId: orgId, itemId }),
  );
}

/**
 * Page a `worktree_updated` card's summary-snapshot timeline (newest-first).
 * The route resolves the worktree from the feed item id, enforcing owner scope,
 * so a 404 (surfaced as {@link TeamApiError}) means out-of-scope or unknown.
 */
export async function getWorktreeSummaryHistory(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  itemId: string,
  options?: { cursor?: string; limit?: number },
): Promise<WorktreeSummaryHistoryResponse> {
  const cursor = nonEmpty(options?.cursor);
  const limit = options?.limit;
  return settle(() =>
    client.read('organization.feed.summaryHistory', {
      organizationId: orgId,
      itemId,
      ...(cursor === undefined ? {} : { cursor }),
      ...(typeof limit === 'number' ? { limit } : {}),
    }),
  );
}

/**
 * Read the org's billing summary (plan, trial, seat math, next-billing info,
 * cached payment method, coverage notes). Member-viewable server-side, though
 * the Billing tab that consumes this is OWNER/ADMIN only.
 */
export async function getOrgBillingSummary(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<BillingSummary> {
  return settle(() =>
    client.read('organization.billing.summary', { organizationId: orgId }),
  );
}

/** `limit` / `cursor` paging options for a billing list. */
export interface BillingPageOpts {
  limit?: number;
  cursor?: string | null;
}

/** Paging fields for an organization billing list, omitting empty values. */
function orgPageInput(opts: BillingPageOpts): {
  limit?: number;
  cursor?: string;
} {
  const cursor = nonEmpty(opts.cursor);
  return {
    ...(typeof opts.limit === 'number' ? { limit: opts.limit } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/**
 * Page the org's billing history (newest-first). Pass the previous page's
 * `nextCursor` to page toward older charges. OWNER/ADMIN only (server-enforced).
 */
export async function getOrgChargeHistory(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  opts: BillingPageOpts = {},
): Promise<ChargePage> {
  return settle(() =>
    client.read('organization.billing.history', {
      organizationId: orgId,
      ...orgPageInput(opts),
    }),
  );
}

/**
 * One page of the org's derived billing-period invoices. OWNER/ADMIN only — the
 * route returns 403 for a MEMBER and 404 for a non-member, both surfaced as a
 * {@link TeamApiError}.
 */
export async function getOrgInvoices(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  opts: BillingPageOpts = {},
): Promise<InvoicePage> {
  return settle(() =>
    client.read('organization.billing.invoices', {
      organizationId: orgId,
      ...orgPageInput(opts),
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* AI credits (CAN-1040 / T17)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read the AI-credits wallet (personal, `orgId` omitted) or credit-pool (org)
 * summary.
 */
export async function getCreditsBalance(
  client: AccountOrganizationSettingsClient,
  orgId?: string,
): Promise<CreditsSummary> {
  const organizationId = nonEmpty(orgId);
  return settle(() =>
    organizationId === undefined
      ? client.read('account.billing.credits', {})
      : client.read('organization.billing.credits', { organizationId }),
  );
}

/**
 * Page the AI-credit ledger history (newest-first). Pass the previous page's
 * `nextCursor` to page toward older entries. For orgs, the route restricts the
 * ledger to OWNER/ADMIN (server-enforced).
 */
export async function getCreditsLedger(
  client: AccountOrganizationSettingsClient,
  orgId?: string,
  opts: BillingPageOpts = {},
): Promise<CreditsLedgerPage> {
  const organizationId = nonEmpty(orgId);
  const page = orgPageInput(opts);
  return settle(() =>
    organizationId === undefined
      ? client.read('account.billing.creditsLedger', page)
      : client.read('organization.billing.credits.ledger', {
          organizationId,
          ...page,
        }),
  );
}

/** Pending team invitations bound to the viewer's verified email. */
export async function listIncomingInvitations(
  client: AccountOrganizationSettingsClient,
): Promise<IncomingTeamInvitation[]> {
  const data = await settle(() =>
    client.read('organization.invitations.incoming', {}),
  );
  return data.invitations;
}

/**
 * Accept or decline a pending team invitation by its externalId. The route
 * replies 204 with no body, so the caller refreshes the panel afterwards.
 */
export async function respondToInvitation(
  client: AccountOrganizationSettingsClient,
  inviteId: string,
  action: IncomingTeamInvitationAction,
): Promise<void> {
  await settle(() =>
    client.write('organization.invitations.respond', { inviteId, action }),
  );
}

// ---------------------------------------------------------------------------
// Organization projects (CAN-2943)
// ---------------------------------------------------------------------------

/**
 * A grant in the strict shape the project routes accept. Grants read back
 * from the server may carry additive fields; only the contract fields go out.
 */
function grantInput(grant: OrgProjectGrant): OrgProjectGrant {
  const principal = grant.principal;
  switch (principal.type) {
    case 'user':
      return {
        principal: { type: 'user', userId: principal.userId },
        defaultListed: grant.defaultListed,
      };
    case 'team':
      return {
        principal: { type: 'team', teamId: principal.teamId },
        defaultListed: grant.defaultListed,
      };
    case 'organization':
      return {
        principal: { type: 'organization' },
        defaultListed: grant.defaultListed,
      };
  }
}

/**
 * The table checks each create outcome's required field; a `created` or
 * `exists` row that also carries an `error`, or an `error` row that also
 * carries a `project`, is still rejected, as the hand-written guard did.
 */
function hasExclusiveOutcomeFields(
  response: CreateOrgProjectsResponse,
): boolean {
  return response.results.every((result) =>
    result.outcome === 'error'
      ? result.project === undefined
      : result.error === undefined,
  );
}

export async function listOrganizationProjects(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  view: 'management',
  query?: { cursor?: string; limit?: number },
): Promise<OrgProjectPage<OrgProjectDetail>>;
export async function listOrganizationProjects(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  view: 'member',
  query?: { cursor?: string; limit?: number },
): Promise<OrgProjectPage<OrgProjectSummary>>;
export async function listOrganizationProjects(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  view: 'management' | 'member',
  query: { cursor?: string; limit?: number } = {},
): Promise<
  OrgProjectPage<OrgProjectDetail> | OrgProjectPage<OrgProjectSummary>
> {
  const input = { organizationId: orgId, ...orgPageInput(query) };
  return view === 'management'
    ? settle(() => client.read('organization.projects.list', input))
    : settle(() => client.read('organization.projects.memberList', input));
}

export async function createOrganizationProjects(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  request: CreateOrgProjectsRequest,
): Promise<CreateOrgProjectsResponse> {
  const response = await settle(() =>
    client.write('organization.projects.create', {
      organizationId: orgId,
      ...(request.privateMemory === undefined
        ? {}
        : { privateMemory: request.privateMemory }),
      repositories: request.repositories.map((repository) => ({
        providerRepoId: repository.providerRepoId,
        owner: repository.owner,
        name: repository.name,
        ...(repository.defaultBranch === undefined
          ? {}
          : { defaultBranch: repository.defaultBranch }),
        ...(repository.displayName === undefined
          ? {}
          : { displayName: repository.displayName }),
      })),
      grants: request.grants.map(grantInput),
    }),
  );
  if (!hasExclusiveOutcomeFields(response)) {
    throw new TeamApiError(200, INVALID_RESPONSE);
  }
  return response;
}

export async function getOrganizationProject(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  projectId: string,
): Promise<OrgProjectDetail> {
  return settle(() =>
    client.read('organization.projects.get', {
      organizationId: orgId,
      projectId,
    }),
  );
}

export async function updateOrganizationProject(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  projectId: string,
  request: UpdateOrgProjectRequest,
): Promise<OrgProjectDetail> {
  return settle(() =>
    client.write('organization.projects.update', {
      organizationId: orgId,
      projectId,
      revision: request.revision,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.description === undefined
        ? {}
        : { description: request.description }),
      ...(request.privateMemory === undefined
        ? {}
        : { privateMemory: request.privateMemory }),
    }),
  );
}

export async function replaceOrganizationProjectGrants(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  projectId: string,
  request: ReplaceOrgProjectGrantsRequest,
): Promise<OrgProjectDetail> {
  return settle(() =>
    client.write('organization.projects.grants.replace', {
      organizationId: orgId,
      projectId,
      authorizationVersion: request.authorizationVersion,
      grants: request.grants.map(grantInput),
      ...(request.confirmShare === undefined
        ? {}
        : { confirmShare: request.confirmShare }),
    }),
  );
}

export async function setOrganizationProjectPreference(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  projectId: string,
  preference: OrgProjectPreference,
): Promise<OrgProjectSummary> {
  return settle(() =>
    client.write('organization.projects.preference.set', {
      organizationId: orgId,
      projectId,
      preference,
    }),
  );
}

export async function applyOrganizationProjectLifecycle(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  projectId: string,
  request: OrgProjectLifecycleRequest,
): Promise<OrgProjectLifecycleResult> {
  return settle(() =>
    client.write('organization.projects.lifecycle', {
      organizationId: orgId,
      projectId,
      revision: request.revision,
      action: request.action,
    }),
  );
}

// ---------------------------------------------------------------------------
// Admin Repositories on the Projects tab (CAN-3414)
// ---------------------------------------------------------------------------

/**
 * One page of the GitHub App's repositories with their hidden state and
 * existing project. Owners and admins only (server-enforced).
 */
export async function listOrganizationRepositories(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  options: { cursor?: string; fresh?: boolean } = {},
): Promise<OrganizationRepositoryPage> {
  const cursor = nonEmpty(options.cursor);
  return settle(() =>
    client.read('organization.repositories.list', {
      organizationId: orgId,
      ...(cursor === undefined ? {} : { cursor }),
      ...(options.fresh === true ? { fresh: true } : {}),
    }),
  );
}

/** Run seeding for the organization now ("Refresh from GitHub"). */
export async function refreshOrganizationProjectsFromGitHub(
  client: AccountOrganizationSettingsClient,
  orgId: string,
): Promise<OrganizationRepositoriesRefreshResult> {
  return settle(() =>
    client.write('organization.repositories.refresh', {
      organizationId: orgId,
    }),
  );
}

/** Hide a repository from seeding (archiving its seeded project) or unhide it. */
export async function setOrganizationRepositoryHidden(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  repositoryId: string,
  request: SetOrganizationRepositoryHiddenRequest,
): Promise<SetOrganizationRepositoryHiddenResult> {
  return settle(() =>
    client.write('organization.repositories.setHidden', {
      organizationId: orgId,
      repositoryId,
      hidden: request.hidden,
      ...(request.owner === undefined ? {} : { owner: request.owner }),
      ...(request.name === undefined ? {} : { name: request.name }),
    }),
  );
}
