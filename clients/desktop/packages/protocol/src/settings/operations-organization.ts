import {
  gatewayDisplayNameSchema,
  gatewayModelSchema,
  aiGatewayConnectSchema,
} from '../model-gateway';
import { aiGatewayConnectionResultSchema } from '../model-gateway/discovery';
import { z } from 'zod';
import {
  MODEL_GATEWAY_MAX_BASE_URL_LENGTH,
  isMemoryParticipationMember,
  isViewerDataSharingStatus,
  type MemoryParticipationMember,
  type ViewerDataSharingStatus,
} from '../canopy-server';
import {
  parseDigestPreferencesPatch,
  type DigestPreferencesPatch,
} from '../digests';
import {
  FEED_ITEM_TYPES,
  type FeedItemPermalinkResponse,
  type FeedPageResponse,
  type WorktreeSummaryHistoryResponse,
} from '../feed';
import type { AiCreditsLedgerPage } from '../llm-gateway';
import {
  MODEL_ROUTING_BACKTEST_MODES,
  MODEL_ROUTING_BACKTEST_STATUSES,
  type ModelRoutingBacktestCreateResponseV1,
  type ModelRoutingBacktestLookupResponseV1,
  type ModelRoutingBacktestV1,
} from '../model-routing';
import {
  ORG_PROJECT_LIMITS,
  ORG_PROJECT_PREFERENCES,
  type CreateOrgProjectsResponse,
  type OrgProjectDetail,
  type OrgProjectPage,
  type OrgProjectSummary,
} from '../org-projects';
import {
  OrganizationInviteStatusSchema,
  SendOrganizationInviteRequestSchema,
  UpgradePersonalOrganizationRequestSchema,
  UpgradePersonalOrganizationResultSchema,
} from '../organizations';
import type { PipelineApiItem } from '../pipelines';
import type { ApprovedPlanSummary, SharedPlanSummary } from '../plans';
import type { SharedRunSummary } from '../runs';
import type {
  SubscriptionPricingResponse,
  TeamUsageResponse,
} from '../telemetry';
import {
  isDigestArchiveItemList,
  organizationDigestDetailShape,
} from './organization-digests';
import type {
  AccountDigestDetail,
  DigestArchiveItem,
  DigestOnDemandRequestResult,
  MemberProfileDigestListResponse,
} from './account-digests';
import {
  isBillingSummary,
  isChargePage,
  isCreditsLedgerPage,
  isCreditsSummary,
  isInvoicePage,
  type BillingSummary,
  type ChargePage,
  type CreditsSummary,
  type InvoicePage,
} from './billing';
import {
  defineSettingsRead,
  defineSettingsWrite,
  settingsAcknowledgementSchema,
  settingsDtoSchema,
  settingsEmptyInputSchema,
  settingsPathSegment,
  settingsPathWithQuery,
  settingsUploadFileSchema,
  type AnySettingsOperation,
  type SettingsOperationRequest,
  type SettingsSignedUpload,
} from './operation-definition';
import {
  ORGANIZATION_LOGO_CONTENT_TYPES,
  ORGANIZATION_LOGO_MAX_BYTES,
  incomingTeamInvitationShape,
  organizationConfigDetailSchema,
  organizationCreatedInviteShape,
  organizationDetailSchema,
  organizationInviteListShape,
  organizationRoleSchema,
  organizationSummaryShape,
  orgModelCatalogEntryShape,
  type IncomingTeamInvitation,
  type OrganizationCreatedInvite,
  type OrganizationInviteListResponse,
  type OrganizationSummary,
  type OrgModelCatalogEntry,
} from './organization';
import {
  EXPLORER_EVIDENCE_TYPES,
  EXPLORER_INGEST_JOB_STATUSES,
  EXPLORER_LIVENESS_FILTERS,
  explorerEntityGraphSchema,
  explorerFactDetailBatchSchema,
  explorerFactDetailSchema,
  explorerFactPageSchema,
  explorerIngestJobPageSchema,
  explorerMemoryConfigSnapshotSchema,
  explorerRetrievalPreviewSchema,
  explorerSearchLogPageSchema,
  explorerSourceTranscriptSchema,
} from './organization-memory';
import { MAX_PREVIEW_QUERY_LENGTH } from './memory-preview-query';
import {
  GITHUB_REPOSITORY_QUERY_MAX_LENGTH,
  gitHubRepositoryPickerPageSchema,
  organizationGitHubConnectResponseSchema,
  organizationRepositoriesRefreshResultSchema,
  organizationRepositoryPageSchema,
  type SetOrganizationRepositoryHiddenResult,
} from './organization-repositories';
import { settingsRouteIdSchema } from './routes';

/**
 * The organization half of the hosted settings operation table: one entry per
 * non-financial call the organization pages make today (`team-api.ts`, the
 * member-profile, routing-backtest, memory-explorer and digest clients, the
 * invite routes, and the Personal-to-team promotion route).
 *
 * Paths are relative to the backend origin and include `/api`; web executes
 * an entry through `fetchBackendUrl(path without '/api')`, desktop main
 * through the isolated settings session.
 *
 * Deliberately absent (financial; web-only behind `inlineCheckout`):
 * `billing/seat-quote`, `billing/setup-intent`, `billing/payment-method`
 * (confirm and delete), `billing/subscription/{cancel,resume,change}`
 * (including the plan-change quote GET), `billing/credits/top-up` and the
 * `billing/credits/auto-top-up` mutation. The automatic top-up SETTINGS are
 * read through `organization.billing.credits` (`CreditsSummary.autoTopUp`).
 *
 * Not table entries: the feed SSE stream (a `settings.subscribe` scope, see
 * `events.ts`), the organization invoice detail (no API route exists; it is
 * served only by `settings.pageData`), and Personal project conversion (a
 * desktop-local orchestration over the existing upgrade IPC).
 */

const ORGANIZATIONS_PATH = '/api/account/organizations';
const INVITES_PATH = '/api/account/invites';
const INCOMING_INVITATIONS_PATH = '/api/account/organizations/invitations';
const MODEL_CATALOG_PATH = '/api/account/model-catalog';

function organizationPath(organizationId: string, suffix = ''): string {
  return `${ORGANIZATIONS_PATH}/${settingsPathSegment(organizationId)}${suffix}`;
}

function memberPath(
  organizationId: string,
  memberId: string,
  suffix = '',
): string {
  return organizationPath(
    organizationId,
    `/members/${settingsPathSegment(memberId)}${suffix}`,
  );
}

function teamPath(organizationId: string, teamId: string, suffix = ''): string {
  return organizationPath(
    organizationId,
    `/teams/${settingsPathSegment(teamId)}${suffix}`,
  );
}

function projectPath(
  organizationId: string,
  projectId: string,
  suffix = '',
): string {
  return organizationPath(
    organizationId,
    `/projects/${settingsPathSegment(projectId)}${suffix}`,
  );
}

function gitHubPath(organizationId: string, suffix: string): string {
  return `/api/account/teams/${settingsPathSegment(organizationId)}/github${suffix}`;
}

function memoryExplorerPath(organizationId: string, suffix: string): string {
  return organizationPath(organizationId, `/memory-explorer${suffix}`);
}

function cloudGatewayKeyPath(organizationId: string): string {
  return `/api/v1/settings/ai-gateway/organization/${settingsPathSegment(organizationId)}/cloud-key`;
}

function get(path: string): SettingsOperationRequest {
  return { method: 'GET', path };
}

/**
 * The quarantine object path the upload-url route returned. The routes
 * answer `{ filePath, uploadUrl }`; `objectKey` is accepted for symmetry with
 * the generic signed-upload shape.
 */
function signedUploadFilePath(signed: SettingsSignedUpload): string {
  const filePath: unknown = signed['filePath'];
  if (typeof filePath === 'string' && filePath.length > 0) return filePath;
  if (signed.objectKey !== undefined) return signed.objectKey;
  throw new Error('The signed upload response has no object path.');
}

/* -------------------------------------------------------------------------- */
/* Shared input pieces                                                         */
/* -------------------------------------------------------------------------- */

const organizationIdField = { organizationId: settingsRouteIdSchema };
const organizationInputSchema = z.strictObject(organizationIdField);
const cloudGatewayKeyStatusSchema = z.looseObject({
  status: z.enum(['none', 'saved', 'rejected', 'stale_url']),
});
const cursorSchema = z.string().min(1).max(2048);
const pageLimitSchema = z.number().int().positive().max(500);
const organizationNameSchema = z.string().trim().min(1).max(256);
const isoInstantSchema = z.string().min(1).max(64);
const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const statisticsScopeSchema = z.enum(['organization', 'team']);

const pagedInputSchema = z.strictObject({
  ...organizationIdField,
  limit: pageLimitSchema.optional(),
  cursor: cursorSchema.optional(),
});

function pagedPath(
  path: string,
  input: { limit?: number | undefined; cursor?: string | undefined },
): string {
  return settingsPathWithQuery(path, {
    limit: input.limit,
    cursor: input.cursor,
  });
}

const memberInputSchema = z.strictObject({
  ...organizationIdField,
  userId: settingsRouteIdSchema,
});

const memberPageInputSchema = z.strictObject({
  ...organizationIdField,
  userId: settingsRouteIdSchema,
  cursor: cursorSchema.optional(),
});

const teamInputSchema = z.strictObject({
  ...organizationIdField,
  teamId: settingsRouteIdSchema,
});

const projectInputSchema = z.strictObject({
  ...organizationIdField,
  projectId: settingsRouteIdSchema,
});

const orgProjectGrantInputSchema = z.strictObject({
  principal: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('user'), userId: settingsRouteIdSchema }),
    z.strictObject({ type: z.literal('team'), teamId: settingsRouteIdSchema }),
    z.strictObject({ type: z.literal('organization') }),
  ]),
  defaultListed: z.boolean(),
});

const orgProjectGrantsInputSchema = z
  .array(orgProjectGrantInputSchema)
  .max(ORG_PROJECT_LIMITS.grantsPerProject);

const modelGatewayModelInputSchema = gatewayModelSchema;

const enforcedSyncScopesInputSchema = z.strictObject({
  transcripts: z.boolean().nullable(),
  plans: z.boolean().nullable(),
  metadata: z.boolean().nullable(),
  summaries: z.boolean().nullable(),
});

const modelIdListSchema = z.array(z.string().min(1).max(256)).max(2000);

/**
 * Policies-subtab PATCH fields. Every field is optional and independent, as
 * the config route requires: callers send only what they change. Saves that
 * the server diffs as a whole (the model gateway) or that mark a reviewed
 * catalog (blocked models) send their companion fields exactly as
 * `team-api.ts` does today.
 */
const policiesUpdateFields = {
  allowExternalContainerSharing: z.boolean().optional(),
  enforceMemberDataSharing: z.boolean().optional(),
  enforcedSync: enforcedSyncScopesInputSchema.optional(),
  enforceMemberModelPolicy: z.boolean().optional(),
  blockedModelIds: modelIdListSchema.optional(),
  reviewedModelIds: modelIdListSchema.optional(),
  enforceMemberModelGateway: z.boolean().optional(),
  modelGatewayDisplayName: gatewayDisplayNameSchema.optional(),
  expectedModelGatewayRevision: z.string().max(128).optional(),
  modelGatewayBaseUrl: z.string().max(2048).nullable().optional(),
  modelGatewayModels: z.array(modelGatewayModelInputSchema).max(100).optional(),
  modelGatewayEnforced: z.boolean().optional(),
  modelGatewayPromptCachePassthrough: z.boolean().optional(),
  prohibitMemberProductAnalytics: z.boolean().optional(),
  prohibitMemberErrorReports: z.boolean().optional(),
  prohibitMemberSessionReplay: z.boolean().optional(),
  prohibitMemberActiveUseSignal: z.boolean().optional(),
  prohibitMemberFeatureFlagIdentity: z.boolean().optional(),
};

const POLICY_FIELD_NAMES = Object.keys(policiesUpdateFields);

/* -------------------------------------------------------------------------- */
/* Result shapes                                                               */
/* -------------------------------------------------------------------------- */

const nullableString = z.string().nullable();

const organizationListSchema = settingsDtoSchema<{
  organizations: OrganizationSummary[];
}>(z.looseObject({ organizations: z.array(organizationSummaryShape) }));

const incomingInvitationsSchema = settingsDtoSchema<{
  invitations: IncomingTeamInvitation[];
}>(z.looseObject({ invitations: z.array(incomingTeamInvitationShape) }));

const memoryParticipationSchema = settingsDtoSchema<{
  members: MemoryParticipationMember[];
}>(
  z.looseObject({
    members: z.array(
      z.custom<MemoryParticipationMember>(isMemoryParticipationMember),
    ),
  }),
);

const memoryParticipationUpdateSchema = settingsDtoSchema<{
  memoryEnabled: boolean;
}>(z.looseObject({ memoryEnabled: z.boolean() }));

const viewerDataSharingSchema = z.custom<ViewerDataSharingStatus>(
  isViewerDataSharingStatus,
);

const teamUsageSchema = settingsDtoSchema<TeamUsageResponse>(
  z.looseObject({
    scope: statisticsScopeSchema,
    range: z.looseObject({ startIso: z.string(), endIso: z.string() }),
    headline: z.array(z.unknown()),
    tokensByProvider: z.array(z.unknown()),
    tokensByModel: z.array(z.unknown()),
    costByProvider: z.array(z.unknown()),
    costByModel: z.array(z.unknown()),
    toolCategoryTotals: z.array(z.unknown()),
    eventTypeStatusCounts: z.array(z.unknown()),
    byUser: z.array(z.unknown()),
    impactByUser: z.array(z.unknown()),
    pipelines: z.array(z.unknown()),
    mostExpensiveRuns: z.array(z.unknown()),
  }),
);

const nullableUsd = z.number().nullable();

const subscriptionPricingSchema =
  settingsDtoSchema<SubscriptionPricingResponse>(
    z.looseObject({
      canEdit: z.boolean(),
      plans: z.array(
        z.looseObject({
          planKey: z.string(),
          provider: z.string(),
          label: z.string(),
          rawPlanTypes: z.array(z.string()),
          accountCount: z.number(),
          defaultMonthlyUsd: nullableUsd,
          overrideMonthlyUsd: nullableUsd,
          effectiveMonthlyUsd: nullableUsd,
        }),
      ),
    }),
  );

const modelCatalogSchema = settingsDtoSchema<{
  models: OrgModelCatalogEntry[];
}>(z.looseObject({ models: z.array(orgModelCatalogEntryShape) }));

const routingBacktestShape = z.looseObject({
  id: z.string(),
  status: z.enum(MODEL_ROUTING_BACKTEST_STATUSES),
  mode: z.enum(MODEL_ROUTING_BACKTEST_MODES),
  rangeStartIso: z.string(),
  rangeEndIso: z.string(),
  progress: z.looseObject({}),
  result: z.looseObject({}).nullable(),
});

const routingBacktestLookupSchema =
  settingsDtoSchema<ModelRoutingBacktestLookupResponseV1>(
    z.looseObject({
      backtest: routingBacktestShape.nullable(),
      estimate: z.looseObject({}).nullable(),
      unavailableReason: nullableString,
    }),
  );

const routingBacktestCreateSchema =
  settingsDtoSchema<ModelRoutingBacktestCreateResponseV1>(
    z.looseObject({ backtest: routingBacktestShape, cached: z.boolean() }),
  );

const routingBacktestGetSchema = settingsDtoSchema<{
  backtest: ModelRoutingBacktestV1;
}>(z.looseObject({ backtest: routingBacktestShape }));

/** Lenient feed-item frame check, mirroring `isFeedItem` in `team-api.ts`. */
const feedItemShape = z.looseObject({
  id: z.string(),
  type: z.enum(FEED_ITEM_TYPES),
  occurredAt: z.string(),
  actor: z.looseObject({ userId: z.string(), displayName: nullableString }),
  worktreeId: nullableString,
});

const feedPageSchema = settingsDtoSchema<FeedPageResponse>(
  z.looseObject({ items: z.array(feedItemShape), nextCursor: nullableString }),
);

const feedItemPermalinkSchema = settingsDtoSchema<FeedItemPermalinkResponse>(
  z.looseObject({
    anchor: feedItemShape,
    newer: z.array(feedItemShape),
    older: z.array(feedItemShape),
    forwardCursor: nullableString,
    backwardCursor: nullableString,
  }),
);

const worktreeSummaryHistorySchema =
  settingsDtoSchema<WorktreeSummaryHistoryResponse>(
    z.looseObject({
      entries: z.array(
        z.looseObject({
          id: z.string(),
          summary: z.string(),
          generatedAt: z.string(),
        }),
      ),
      nextCursor: nullableString,
    }),
  );

/** One page of a member-profile list (`{ data, nextCursor }`). */
export interface OrganizationMemberListPage<T> {
  data: T[];
  nextCursor: string | null;
}

const memberListShape = z.looseObject({
  data: z.array(z.unknown()),
  nextCursor: nullableString,
});

const memberDigestsSchema = settingsDtoSchema<MemberProfileDigestListResponse>(
  z.looseObject({ items: z.array(z.unknown()) }),
);

const memberProfileUpdateSchema = settingsDtoSchema<{
  name: string;
  image: string | null;
}>(z.looseObject({ name: z.string(), image: nullableString }));

const memberAvatarCommitSchema = settingsDtoSchema<{ image: string }>(
  z.looseObject({ image: z.string() }),
);

const orgProjectSummaryShape = z.looseObject({
  id: z.string(),
  organizationId: nullableString,
  name: z.string(),
  description: nullableString,
  kind: z.enum(['CODE', 'COWORK']),
  location: z.enum(['LOCAL', 'CLOUD']),
  repository: z
    .looseObject({
      provider: z.literal('github'),
      host: z.string(),
      owner: z.string(),
      name: z.string(),
      providerRepoId: nullableString,
      defaultBranch: nullableString,
      verification: z.enum(['VERIFIED', 'STALE', 'UNVERIFIED']),
    })
    .nullable(),
  // DELETED is a legal lifecycle outcome even though catalogs omit it.
  state: z.enum(['ACTIVE', 'ARCHIVED', 'DELETED']),
  revision: z.number().int(),
  authorizationVersion: z.number().int(),
  defaultListed: z.boolean(),
  preference: z.enum(ORG_PROJECT_PREFERENCES),
  listed: z.boolean(),
  capabilities: z.looseObject({
    administer: z.boolean(),
    manageCloud: z.boolean(),
    use: z.boolean(),
  }),
  instance: z
    .looseObject({
      id: z.string(),
      state: z.enum(['CLAIMED', 'READY', 'DETACHED', 'ACCESS_REVOKED']),
    })
    .nullable(),
});

const orgProjectDetailShape = orgProjectSummaryShape.extend({
  grants: z.array(
    z.looseObject({
      defaultListed: z.boolean(),
      principal: z.union([
        z.looseObject({ type: z.literal('user'), userId: z.string() }),
        z.looseObject({ type: z.literal('team'), teamId: z.string() }),
        z.looseObject({ type: z.literal('organization') }),
      ]),
    }),
  ),
  createdBy: z.looseObject({ id: z.string(), name: nullableString }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function orgProjectPageShape(item: z.ZodType): z.ZodType {
  return z.looseObject({
    data: z.array(item),
    revision: z.string(),
    nextCursor: nullableString,
  });
}

const orgProjectSummarySchema = settingsDtoSchema<OrgProjectSummary>(
  orgProjectSummaryShape,
);

const orgProjectDetailSchema = settingsDtoSchema<OrgProjectDetail>(
  orgProjectDetailShape,
);

const createOrgProjectsSchema = settingsDtoSchema<CreateOrgProjectsResponse>(
  z.looseObject({
    results: z.array(
      z.union([
        z.looseObject({
          providerRepoId: z.string(),
          outcome: z.enum(['created', 'exists']),
          project: orgProjectDetailShape,
        }),
        z.looseObject({
          providerRepoId: z.string(),
          outcome: z.literal('error'),
          error: z.string(),
        }),
      ]),
    ),
  }),
);

const setRepositoryHiddenSchema =
  settingsDtoSchema<SetOrganizationRepositoryHiddenResult>(
    z.looseObject({
      providerRepoId: z.string(),
      hidden: z.boolean(),
      changed: z.boolean(),
      project: orgProjectDetailShape.nullable(),
    }),
  );

const digestPreferencesSchema = z.custom<DigestPreferencesPatch>(
  (value) => parseDigestPreferencesPatch(value) !== null,
);

const digestArchiveSchema = z.custom<DigestArchiveItem[]>(
  isDigestArchiveItemList,
);

const digestDetailSchema = settingsDtoSchema<AccountDigestDetail>(
  organizationDigestDetailShape,
);

const digestRequestResultSchema =
  settingsDtoSchema<DigestOnDemandRequestResult>(
    z.looseObject({
      status: z.enum(['already_exists', 'enqueued', 'publishing_disabled']),
      digestExternalId: z.string(),
    }),
  );

const digestSharingResultSchema = settingsDtoSchema<{
  sharingEnabled: boolean;
  sharePath?: string;
}>(
  z.looseObject({
    sharingEnabled: z.boolean(),
    sharePath: z.string().optional(),
  }),
);

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

export const ORGANIZATION_SETTINGS_OPERATIONS = {
  'organization.settings.ai-gateway.connect': defineSettingsWrite({
    transport: 'backend',
    input: aiGatewayConnectSchema.extend({ organizationId: z.uuid() }),
    result: aiGatewayConnectionResultSchema,
    request: (input) => ({
      method: 'POST',
      path: '/api/v1/settings/ai-gateway/organization/connect',
      body: input,
    }),
  }),
  // The member's own key for cloud chats (CAN-5809). Personal uses these too,
  // with the Personal organization's id, so a key is never saved into a
  // Personal promoted since the page loaded. Responses carry status only.
  'organization.settings.ai-gateway.cloud-key.read': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: cloudGatewayKeyStatusSchema,
    request: (input) => get(cloudGatewayKeyPath(input.organizationId)),
  }),
  'organization.settings.ai-gateway.cloud-key.save': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      apiKey: z.string().min(1).max(4096),
      /** The gateway the key was entered for; a different stored one refuses before the probe. */
      expectedBaseUrl: z
        .string()
        .max(MODEL_GATEWAY_MAX_BASE_URL_LENGTH)
        .optional(),
    }),
    result: cloudGatewayKeyStatusSchema,
    request: (input) => ({
      method: 'PUT',
      path: cloudGatewayKeyPath(input.organizationId),
      body: {
        apiKey: input.apiKey,
        ...(input.expectedBaseUrl === undefined
          ? {}
          : { expectedBaseUrl: input.expectedBaseUrl }),
      },
    }),
  }),
  'organization.settings.ai-gateway.cloud-key.remove': defineSettingsWrite({
    transport: 'backend',
    input: organizationInputSchema,
    result: cloudGatewayKeyStatusSchema,
    request: (input) => ({
      method: 'DELETE',
      path: cloudGatewayKeyPath(input.organizationId),
    }),
  }),
  /* Organizations list, lifecycle, and branding --------------------------- */

  'organization.list': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: organizationListSchema,
    request: () => get(ORGANIZATIONS_PATH),
  }),
  'organization.create': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({ name: organizationNameSchema }),
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'POST',
      path: ORGANIZATIONS_PATH,
      body: { name: input.name },
    }),
  }),
  'organization.detail': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: organizationDetailSchema,
    request: (input) => get(organizationPath(input.organizationId)),
  }),
  'organization.rename': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      name: organizationNameSchema,
    }),
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'PATCH',
      path: organizationPath(input.organizationId),
      body: { name: input.name },
    }),
  }),
  'organization.delete': defineSettingsWrite({
    transport: 'backend',
    input: organizationInputSchema,
    result: settingsAcknowledgementSchema,
    request: (input) => ({
      method: 'DELETE',
      path: organizationPath(input.organizationId),
    }),
  }),
  'organization.leave': defineSettingsWrite({
    transport: 'backend',
    input: organizationInputSchema,
    result: settingsAcknowledgementSchema,
    request: (input) => ({
      method: 'POST',
      path: organizationPath(input.organizationId, '/leave'),
    }),
  }),
  /**
   * Upload a new organization logo: sign (`logo/upload-url`), PUT the bytes
   * to the signed URL with `Content-Type` equal to `mimeType` and no account
   * credentials, then commit (`logo/commit`), which moderates (422 on
   * failure) and returns the refreshed detail.
   */
  'organization.logo.upload': defineSettingsWrite({
    transport: 'upload',
    input: z.strictObject({
      ...organizationIdField,
      mimeType: z.enum(ORGANIZATION_LOGO_CONTENT_TYPES),
      size: z.number().int().positive().max(ORGANIZATION_LOGO_MAX_BYTES),
      file: settingsUploadFileSchema.optional(),
    }),
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'POST',
      path: organizationPath(input.organizationId, '/logo/upload-url'),
      body: { mimeType: input.mimeType, size: input.size },
    }),
    upload: {
      maxBytes: ORGANIZATION_LOGO_MAX_BYTES,
      contentTypes: ORGANIZATION_LOGO_CONTENT_TYPES,
      sign: (input) => ({
        method: 'POST',
        path: organizationPath(input.organizationId, '/logo/upload-url'),
        body: { mimeType: input.mimeType, size: input.size },
      }),
      commit: (input, signed) => ({
        method: 'POST',
        path: organizationPath(input.organizationId, '/logo/commit'),
        body: { filePath: signedUploadFilePath(signed) },
      }),
    },
  }),
  'organization.logo.clear': defineSettingsWrite({
    transport: 'backend',
    input: organizationInputSchema,
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'PATCH',
      path: organizationPath(input.organizationId),
      body: { logoUrl: null },
    }),
  }),

  /* Personal-to-team promotion and invitations ---------------------------- */

  /**
   * Promote the viewer's Personal organization to a team. Desktop main
   * dispatches this through the existing promotion orchestration in
   * `services/personal-organization-upgrade.ts`.
   */
  'organization.promote': defineSettingsWrite({
    transport: 'backend',
    input: UpgradePersonalOrganizationRequestSchema,
    result: UpgradePersonalOrganizationResultSchema,
    request: (input) => ({
      method: 'POST',
      path: organizationPath(input.organizationId, '/upgrade'),
      body: input,
    }),
  }),
  /**
   * Invite a member. For an ACTIVE per-seat paid organization the server
   * charges the prorated seat before the invitation stands; the seat quote
   * that confirms that charge is financial and web-only.
   */
  'organization.members.invite': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...SendOrganizationInviteRequestSchema.shape,
      ...organizationIdField,
    }),
    result: settingsDtoSchema<OrganizationCreatedInvite>(
      organizationCreatedInviteShape,
    ),
    request: (input) => ({
      method: 'POST',
      path: INVITES_PATH,
      body: {
        organizationId: input.organizationId,
        email: input.email,
        role: input.role ?? 'MEMBER',
        ...(input.organizationTeamId === undefined
          ? {}
          : { organizationTeamId: input.organizationTeamId }),
      },
    }),
  }),
  /** Read-only reconciliation after a lost invite response; never sends email. */
  'organization.invitations.status': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      email: z.email().max(256),
    }),
    result: OrganizationInviteStatusSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(INVITES_PATH, {
          organizationId: input.organizationId,
          email: input.email,
        }),
      ),
  }),
  /** Outgoing invites in the selected organization, authorized by the server. */
  'organization.invitations.list': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      cursor: settingsRouteIdSchema.optional(),
    }),
    result: settingsDtoSchema<OrganizationInviteListResponse>(
      organizationInviteListShape,
    ),
    request: (input) =>
      get(
        settingsPathWithQuery(
          `${organizationPath(input.organizationId)}/invites`,
          { cursor: input.cursor },
        ),
      ),
  }),
  'organization.invitations.revoke': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      inviteId: settingsRouteIdSchema,
    }),
    result: settingsAcknowledgementSchema,
    request: (input) => ({
      method: 'DELETE',
      path: `${organizationPath(input.organizationId)}/invites/${settingsPathSegment(input.inviteId)}`,
    }),
  }),
  /** Invitations addressed to the viewer (Organizations list). */
  'organization.invitations.incoming': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: incomingInvitationsSchema,
    request: () => get(INCOMING_INVITATIONS_PATH),
  }),
  'organization.invitations.respond': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      inviteId: settingsRouteIdSchema,
      action: z.enum(['accept', 'decline']),
    }),
    result: settingsAcknowledgementSchema,
    request: (input) => ({
      method: 'PATCH',
      path: `${INCOMING_INVITATIONS_PATH}/${settingsPathSegment(input.inviteId)}`,
      body: { action: input.action },
    }),
  }),

  /* Members ---------------------------------------------------------------- */

  'organization.members.updateRole': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      userId: settingsRouteIdSchema,
      role: organizationRoleSchema,
    }),
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'PATCH',
      path: memberPath(input.organizationId, input.userId),
      body: { role: input.role },
    }),
  }),
  'organization.members.remove': defineSettingsWrite({
    transport: 'backend',
    input: memberInputSchema,
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'DELETE',
      path: memberPath(input.organizationId, input.userId),
    }),
  }),
  'organization.members.memory.update': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      userId: settingsRouteIdSchema,
      enabled: z.boolean(),
    }),
    result: memoryParticipationUpdateSchema,
    request: (input) => ({
      method: 'PATCH',
      path: memberPath(input.organizationId, input.userId, '/memory'),
      body: { enabled: input.enabled },
    }),
  }),
  /** Set a member's org-scoped display name, or clear the avatar override. */
  'organization.members.profile.update': defineSettingsWrite({
    transport: 'backend',
    input: z
      .strictObject({
        ...organizationIdField,
        userId: settingsRouteIdSchema,
        name: z.string().trim().min(1).max(256).optional(),
        image: z.null().optional(),
      })
      .refine(
        (input) => input.name !== undefined || input.image !== undefined,
        'Nothing to update',
      ),
    result: memberProfileUpdateSchema,
    request: (input) => ({
      method: 'PATCH',
      path: memberPath(input.organizationId, input.userId, '/profile'),
      body: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.image === undefined ? {} : { image: input.image }),
      },
    }),
  }),
  /** Same signed flow and limits as the organization logo. */
  'organization.members.profile.avatar.upload': defineSettingsWrite({
    transport: 'upload',
    input: z.strictObject({
      ...organizationIdField,
      userId: settingsRouteIdSchema,
      mimeType: z.enum(ORGANIZATION_LOGO_CONTENT_TYPES),
      size: z.number().int().positive().max(ORGANIZATION_LOGO_MAX_BYTES),
      file: settingsUploadFileSchema.optional(),
    }),
    result: memberAvatarCommitSchema,
    request: (input) => ({
      method: 'POST',
      path: memberPath(
        input.organizationId,
        input.userId,
        '/profile/avatar/upload-url',
      ),
      body: { mimeType: input.mimeType, size: input.size },
    }),
    upload: {
      maxBytes: ORGANIZATION_LOGO_MAX_BYTES,
      contentTypes: ORGANIZATION_LOGO_CONTENT_TYPES,
      sign: (input) => ({
        method: 'POST',
        path: memberPath(
          input.organizationId,
          input.userId,
          '/profile/avatar/upload-url',
        ),
        body: { mimeType: input.mimeType, size: input.size },
      }),
      commit: (input, signed) => ({
        method: 'POST',
        path: memberPath(
          input.organizationId,
          input.userId,
          '/profile/avatar/commit',
        ),
        body: { filePath: signedUploadFilePath(signed) },
      }),
    },
  }),
  'organization.members.plans': defineSettingsRead({
    transport: 'backend',
    input: memberPageInputSchema,
    result:
      settingsDtoSchema<OrganizationMemberListPage<SharedPlanSummary>>(
        memberListShape,
      ),
    request: (input) =>
      get(
        settingsPathWithQuery(
          memberPath(input.organizationId, input.userId, '/plans'),
          {
            cursor: input.cursor,
          },
        ),
      ),
  }),
  'organization.members.approvedPlans': defineSettingsRead({
    transport: 'backend',
    input: memberPageInputSchema,
    result:
      settingsDtoSchema<OrganizationMemberListPage<ApprovedPlanSummary>>(
        memberListShape,
      ),
    request: (input) =>
      get(
        settingsPathWithQuery(
          memberPath(input.organizationId, input.userId, '/approved-plans'),
          { cursor: input.cursor },
        ),
      ),
  }),
  'organization.members.runs': defineSettingsRead({
    transport: 'backend',
    input: memberPageInputSchema,
    result:
      settingsDtoSchema<OrganizationMemberListPage<SharedRunSummary>>(
        memberListShape,
      ),
    request: (input) =>
      get(
        settingsPathWithQuery(
          memberPath(input.organizationId, input.userId, '/runs'),
          {
            cursor: input.cursor,
          },
        ),
      ),
  }),
  'organization.members.pipelines': defineSettingsRead({
    transport: 'backend',
    input: memberPageInputSchema,
    result:
      settingsDtoSchema<OrganizationMemberListPage<PipelineApiItem>>(
        memberListShape,
      ),
    request: (input) =>
      get(
        settingsPathWithQuery(
          memberPath(input.organizationId, input.userId, '/pipelines'),
          { cursor: input.cursor },
        ),
      ),
  }),
  /** Digests the viewer may see on a member's profile (`{ items }`). */
  'organization.members.digests': defineSettingsRead({
    transport: 'backend',
    input: memberInputSchema,
    result: memberDigestsSchema,
    request: (input) =>
      get(memberPath(input.organizationId, input.userId, '/digests')),
  }),

  /* Teams (sub-teams) ------------------------------------------------------- */

  'organization.teams.create': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      name: organizationNameSchema,
    }),
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'POST',
      path: organizationPath(input.organizationId, '/teams'),
      body: { name: input.name },
    }),
  }),
  'organization.teams.rename': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      teamId: settingsRouteIdSchema,
      name: organizationNameSchema,
    }),
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'PATCH',
      path: teamPath(input.organizationId, input.teamId),
      body: { name: input.name },
    }),
  }),
  'organization.teams.delete': defineSettingsWrite({
    transport: 'backend',
    input: teamInputSchema,
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'DELETE',
      path: teamPath(input.organizationId, input.teamId),
    }),
  }),
  'organization.teams.setMembers': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      teamId: settingsRouteIdSchema,
      memberUserIds: z.array(settingsRouteIdSchema).max(10_000),
    }),
    result: organizationDetailSchema,
    request: (input) => ({
      method: 'PUT',
      path: teamPath(input.organizationId, input.teamId, '/members'),
      body: { memberUserIds: input.memberUserIds },
    }),
  }),

  /* Feed --------------------------------------------------------------------- */

  /**
   * One page of the activity feed. Filters are re-sent with every cursor so
   * server-side narrowing stays consistent across pages.
   */
  'organization.feed.page': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      cursor: cursorSchema.optional(),
      q: z.string().max(1024).optional(),
      types: z
        .array(z.enum(FEED_ITEM_TYPES))
        .max(FEED_ITEM_TYPES.length)
        .optional(),
      actorId: settingsRouteIdSchema.optional(),
    }),
    result: feedPageSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(organizationPath(input.organizationId, '/feed'), {
          cursor: input.cursor,
          q: input.q === '' ? undefined : input.q,
          types:
            input.types === undefined || input.types.length === 0
              ? undefined
              : input.types.join(','),
          actorId: input.actorId,
        }),
      ),
  }),
  /** One feed item with its surrounding window, for permalinks. */
  'organization.feed.item': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      itemId: settingsRouteIdSchema,
    }),
    result: feedItemPermalinkSchema,
    request: (input) =>
      get(
        organizationPath(
          input.organizationId,
          `/feed/item/${settingsPathSegment(input.itemId)}`,
        ),
      ),
  }),
  'organization.feed.summaryHistory': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      itemId: settingsRouteIdSchema,
      cursor: cursorSchema.optional(),
      limit: pageLimitSchema.optional(),
    }),
    result: worktreeSummaryHistorySchema,
    request: (input) =>
      get(
        pagedPath(
          organizationPath(
            input.organizationId,
            `/feed/item/${settingsPathSegment(input.itemId)}/summary-history`,
          ),
          input,
        ),
      ),
  }),

  /* Statistics ---------------------------------------------------------------- */

  'organization.statistics.usage': defineSettingsRead({
    transport: 'backend',
    input: z
      .strictObject({
        ...organizationIdField,
        scope: statisticsScopeSchema,
        teamId: settingsRouteIdSchema.optional(),
        granularity: z.enum(['hour', 'day', 'week']),
        startIso: isoInstantSchema,
        endIso: isoInstantSchema,
        userId: settingsRouteIdSchema.optional(),
      })
      .refine(
        (input) => input.scope !== 'team' || input.teamId !== undefined,
        'A team scope needs a teamId',
      ),
    result: teamUsageSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(
          organizationPath(input.organizationId, '/usage'),
          {
            scope: input.scope,
            granularity: input.granularity,
            start: input.startIso,
            end: input.endIso,
            teamId: input.teamId,
            userId: input.userId,
          },
        ),
      ),
  }),
  /** Cached automatic model routing estimate for a range and filter. */
  'organization.statistics.routingBacktest.lookup': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      scope: statisticsScopeSchema,
      teamId: settingsRouteIdSchema.optional(),
      userId: settingsRouteIdSchema.optional(),
      startIso: isoInstantSchema,
      endIso: isoInstantSchema,
    }),
    result: routingBacktestLookupSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(
          organizationPath(input.organizationId, '/model-routing-backtests'),
          {
            start: input.startIso,
            end: input.endIso,
            scope: input.scope,
            teamId: input.teamId,
            userId: input.userId,
          },
        ),
      ),
  }),
  'organization.statistics.routingBacktest.create': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      scope: statisticsScopeSchema,
      teamId: settingsRouteIdSchema.optional(),
      userId: settingsRouteIdSchema.optional(),
      startIso: isoInstantSchema,
      endIso: isoInstantSchema,
      mode: z.enum(MODEL_ROUTING_BACKTEST_MODES),
    }),
    result: routingBacktestCreateSchema,
    request: (input) => ({
      method: 'POST',
      path: organizationPath(input.organizationId, '/model-routing-backtests'),
      body: {
        startIso: input.startIso,
        endIso: input.endIso,
        mode: input.mode,
        scope: input.scope,
        ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
        ...(input.userId === undefined ? {} : { userId: input.userId }),
      },
    }),
  }),
  'organization.statistics.routingBacktest.get': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      backtestId: settingsRouteIdSchema,
    }),
    result: routingBacktestGetSchema,
    request: (input) =>
      get(
        organizationPath(
          input.organizationId,
          `/model-routing-backtests/${settingsPathSegment(input.backtestId)}`,
        ),
      ),
  }),
  /** The viewer's own data-sharing evidence for the organization (CAN-3383). */
  'organization.dataSharing.viewer': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: viewerDataSharingSchema,
    request: (input) =>
      get(organizationPath(input.organizationId, '/data-sharing')),
  }),

  /* Settings: configuration, policies, usage ----------------------------------- */

  'organization.settings.config': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: organizationConfigDetailSchema,
    request: (input) => get(organizationPath(input.organizationId, '/config')),
  }),
  /** Usage subtab: minimum role that may view Statistics. */
  'organization.settings.usage.update': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      usageStatsMinRole: organizationRoleSchema,
    }),
    result: organizationConfigDetailSchema,
    request: (input) => ({
      method: 'PATCH',
      path: organizationPath(input.organizationId, '/config'),
      body: { usageStatsMinRole: input.usageStatsMinRole },
    }),
  }),
  /** Policies subtab: sharing enforcement, model access, model gateway. */
  'organization.settings.policies.update': defineSettingsWrite({
    maxInputBytes: 512 * 1024,
    transport: 'backend',
    input: z
      .strictObject({ ...organizationIdField, ...policiesUpdateFields })
      .refine(
        (input) =>
          POLICY_FIELD_NAMES.some(
            (name) =>
              Object.prototype.hasOwnProperty.call(input, name) &&
              Reflect.get(input, name) !== undefined,
          ),
        'Nothing to update',
      ),
    result: organizationConfigDetailSchema,
    request: ({ organizationId, ...body }) => ({
      method: 'PATCH',
      path: organizationPath(organizationId, '/config'),
      body,
    }),
  }),
  /** The catalog the model policy is expressed against (authenticated). */
  'organization.settings.modelCatalog': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: modelCatalogSchema,
    request: () => get(MODEL_CATALOG_PATH),
  }),
  /** Usage subtab: provider subscription pricing used for cost estimates. */
  'organization.settings.subscriptionPricing': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: subscriptionPricingSchema,
    request: (input) =>
      get(organizationPath(input.organizationId, '/subscription-pricing')),
  }),
  'organization.settings.subscriptionPricing.update': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      planKey: z.string().min(1).max(256),
      monthlyPriceUsd: z.number().nonnegative().max(1_000_000).nullable(),
    }),
    result: subscriptionPricingSchema,
    request: (input) => ({
      method: 'PUT',
      path: organizationPath(input.organizationId, '/subscription-pricing'),
      body: { planKey: input.planKey, monthlyPriceUsd: input.monthlyPriceUsd },
    }),
  }),
  /** Policies subtab: per-member organization-memory participation. */
  'organization.settings.memoryParticipation': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: memoryParticipationSchema,
    request: (input) =>
      get(organizationPath(input.organizationId, '/memory/participation')),
  }),

  /* GitHub connection and repositories ---------------------------------------- */

  /**
   * Start the org GitHub App install. The route sets a signed-nonce cookie on
   * the CALLING session and returns the install URL; the install callback
   * must arrive with that cookie.
   */
  'organization.github.connect': defineSettingsWrite({
    transport: 'backend',
    input: organizationInputSchema,
    result: organizationGitHubConnectResponseSchema,
    request: (input) => ({
      method: 'POST',
      path: gitHubPath(input.organizationId, '/connect'),
    }),
  }),
  'organization.github.disconnect': defineSettingsWrite({
    transport: 'backend',
    input: organizationInputSchema,
    result: settingsAcknowledgementSchema,
    request: (input) => ({
      method: 'DELETE',
      path: gitHubPath(input.organizationId, '/connect'),
    }),
  }),
  /** Repository picker over the org GitHub App installation (CAN-2945). */
  'organization.github.repositories': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      cursor: cursorSchema.optional(),
      query: z.string().max(GITHUB_REPOSITORY_QUERY_MAX_LENGTH).optional(),
    }),
    result: gitHubRepositoryPickerPageSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(
          gitHubPath(input.organizationId, '/repositories'),
          {
            cursor: input.cursor,
            q: input.query === '' ? undefined : input.query,
          },
        ),
      ),
  }),
  /** Projects tab admin Repositories list (CAN-3414). */
  'organization.repositories.list': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      cursor: cursorSchema.optional(),
      fresh: z.boolean().optional(),
    }),
    result: organizationRepositoryPageSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(
          organizationPath(input.organizationId, '/projects/repositories'),
          {
            cursor: input.cursor,
            fresh: input.fresh === true ? '1' : undefined,
          },
        ),
      ),
  }),
  /** "Refresh from GitHub": run seeding now. */
  'organization.repositories.refresh': defineSettingsWrite({
    transport: 'backend',
    input: organizationInputSchema,
    result: organizationRepositoriesRefreshResultSchema,
    request: (input) => ({
      method: 'POST',
      path: organizationPath(
        input.organizationId,
        '/projects/repositories/refresh',
      ),
    }),
  }),
  'organization.repositories.setHidden': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      repositoryId: settingsRouteIdSchema,
      hidden: z.boolean(),
      owner: z.string().min(1).max(256).optional(),
      name: z.string().min(1).max(256).optional(),
    }),
    result: setRepositoryHiddenSchema,
    request: ({ organizationId, repositoryId, ...body }) => ({
      method: 'PUT',
      path: organizationPath(
        organizationId,
        `/projects/repositories/${settingsPathSegment(repositoryId)}`,
      ),
      body,
    }),
  }),

  /* Projects ---------------------------------------------------------------------- */

  /** Management view: full definitions with grants. */
  'organization.projects.list': defineSettingsRead({
    transport: 'backend',
    input: pagedInputSchema,
    result: settingsDtoSchema<OrgProjectPage<OrgProjectDetail>>(
      orgProjectPageShape(orgProjectDetailShape),
    ),
    request: (input) =>
      get(
        settingsPathWithQuery(
          organizationPath(input.organizationId, '/projects'),
          {
            view: 'management',
            cursor: input.cursor,
            limit: input.limit,
          },
        ),
      ),
  }),
  /** Member view: the catalog rows the viewer can use. */
  'organization.projects.memberList': defineSettingsRead({
    transport: 'backend',
    input: pagedInputSchema,
    result: settingsDtoSchema<OrgProjectPage<OrgProjectSummary>>(
      orgProjectPageShape(orgProjectSummaryShape),
    ),
    request: (input) =>
      get(
        settingsPathWithQuery(
          organizationPath(input.organizationId, '/projects'),
          {
            view: 'member',
            cursor: input.cursor,
            limit: input.limit,
          },
        ),
      ),
  }),
  'organization.projects.create': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      privateMemory: z.boolean().optional(),
      repositories: z
        .array(
          z.strictObject({
            providerRepoId: z.string().min(1).max(256),
            owner: z.string().min(1).max(256),
            name: z.string().min(1).max(256),
            defaultBranch: z.string().max(256).nullable().optional(),
            displayName: z
              .string()
              .max(ORG_PROJECT_LIMITS.nameLength)
              .optional(),
          }),
        )
        .min(1)
        .max(ORG_PROJECT_LIMITS.repositoriesPerCreate),
      grants: orgProjectGrantsInputSchema,
    }),
    result: createOrgProjectsSchema,
    request: ({ organizationId, ...body }) => ({
      method: 'POST',
      path: organizationPath(organizationId, '/projects'),
      body,
    }),
  }),
  'organization.projects.get': defineSettingsRead({
    transport: 'backend',
    input: projectInputSchema,
    result: orgProjectDetailSchema,
    request: (input) => get(projectPath(input.organizationId, input.projectId)),
  }),
  'organization.projects.update': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      projectId: settingsRouteIdSchema,
      revision: z.number().int().nonnegative(),
      name: z
        .string()
        .trim()
        .min(1)
        .max(ORG_PROJECT_LIMITS.nameLength)
        .optional(),
      description: z
        .string()
        .max(ORG_PROJECT_LIMITS.descriptionLength)
        .nullable()
        .optional(),
      privateMemory: z.boolean().optional(),
    }),
    result: orgProjectDetailSchema,
    request: ({ organizationId, projectId, ...body }) => ({
      method: 'PATCH',
      path: projectPath(organizationId, projectId),
      body,
    }),
  }),
  'organization.projects.grants.replace': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      projectId: settingsRouteIdSchema,
      authorizationVersion: z.number().int().nonnegative(),
      grants: orgProjectGrantsInputSchema,
      confirmShare: z.boolean().optional(),
    }),
    result: orgProjectDetailSchema,
    request: ({ organizationId, projectId, ...body }) => ({
      method: 'PUT',
      path: projectPath(organizationId, projectId, '/grants'),
      body,
    }),
  }),
  'organization.projects.preference.set': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      projectId: settingsRouteIdSchema,
      preference: z.enum(ORG_PROJECT_PREFERENCES),
    }),
    result: orgProjectSummarySchema,
    request: (input) => ({
      method: 'PUT',
      path: projectPath(input.organizationId, input.projectId, '/preference'),
      body: { preference: input.preference },
    }),
  }),
  'organization.projects.lifecycle': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      projectId: settingsRouteIdSchema,
      revision: z.number().int().nonnegative(),
      action: z.enum(['archive', 'restore', 'delete']),
    }),
    result: orgProjectDetailSchema,
    request: (input) => ({
      method: 'POST',
      path: projectPath(input.organizationId, input.projectId, '/lifecycle'),
      body: { revision: input.revision, action: input.action },
    }),
  }),

  /* Memory explorer -------------------------------------------------------------- */

  /**
   * One page of facts. A non-empty `q` switches the route to ranked search,
   * which is metered (429/503 with `Retry-After`) and returns no cursor.
   */
  'organization.memory.facts': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      q: z.string().max(1024).optional(),
      evidenceType: z.enum(EXPLORER_EVIDENCE_TYPES).optional(),
      liveness: z.enum(EXPLORER_LIVENESS_FILTERS).optional(),
      from: isoInstantSchema.optional(),
      to: isoInstantSchema.optional(),
      cursor: cursorSchema.optional(),
      limit: pageLimitSchema.optional(),
    }),
    result: explorerFactPageSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(
          memoryExplorerPath(input.organizationId, '/facts'),
          {
            q: input.q === '' ? undefined : input.q,
            evidenceType: input.evidenceType,
            liveness: input.liveness,
            from: input.from,
            to: input.to,
            cursor: input.cursor,
            limit: input.limit,
          },
        ),
      ),
  }),
  'organization.memory.fact': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      factId: settingsRouteIdSchema,
    }),
    result: explorerFactDetailSchema,
    request: (input) =>
      get(
        memoryExplorerPath(
          input.organizationId,
          `/facts/${settingsPathSegment(input.factId)}`,
        ),
      ),
  }),
  /** Fact details for a graph selection (`?ids=a,b`). */
  'organization.memory.factsBatch': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      factIds: z.array(settingsRouteIdSchema).min(1).max(200),
    }),
    result: explorerFactDetailBatchSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(
          memoryExplorerPath(input.organizationId, '/facts/batch'),
          {
            ids: input.factIds.join(','),
          },
        ),
      ),
  }),
  /** The transcript behind one fact source (fact detail page). */
  'organization.memory.factSource': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      factId: settingsRouteIdSchema,
      sourceId: settingsRouteIdSchema,
    }),
    result: explorerSourceTranscriptSchema,
    request: (input) =>
      get(
        memoryExplorerPath(
          input.organizationId,
          `/facts/${settingsPathSegment(input.factId)}/sources/${settingsPathSegment(input.sourceId)}`,
        ),
      ),
  }),
  'organization.memory.graph': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      q: z.string().max(1024).optional(),
      liveness: z.enum(EXPLORER_LIVENESS_FILTERS).optional(),
      from: isoInstantSchema.optional(),
      to: isoInstantSchema.optional(),
      limit: pageLimitSchema.optional(),
    }),
    result: explorerEntityGraphSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(
          memoryExplorerPath(input.organizationId, '/graph'),
          {
            q: input.q === '' ? undefined : input.q,
            liveness: input.liveness,
            from: input.from,
            to: input.to,
            limit: input.limit,
          },
        ),
      ),
  }),
  'organization.memory.jobs': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      status: z.enum(EXPLORER_INGEST_JOB_STATUSES).optional(),
      cursor: cursorSchema.optional(),
      limit: pageLimitSchema.optional(),
    }),
    result: explorerIngestJobPageSchema,
    request: (input) =>
      get(
        settingsPathWithQuery(
          memoryExplorerPath(input.organizationId, '/jobs'),
          {
            status: input.status,
            cursor: input.cursor,
            limit: input.limit,
          },
        ),
      ),
  }),
  'organization.memory.searchLog': defineSettingsRead({
    transport: 'backend',
    input: pagedInputSchema,
    result: explorerSearchLogPageSchema,
    request: (input) =>
      get(
        pagedPath(
          memoryExplorerPath(input.organizationId, '/search-log'),
          input,
        ),
      ),
  }),
  'organization.memory.config': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: explorerMemoryConfigSnapshotSchema,
    request: (input) =>
      get(memoryExplorerPath(input.organizationId, '/config')),
  }),
  /**
   * "What would the agent see" for a query. A POST that reads nothing it
   * writes: idempotent and safe to retry, but metered (429).
   */
  'organization.memory.previewSearch': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      // The preview route accepts the same length the preview UI truncates to.
      query: z.string().trim().min(1).max(MAX_PREVIEW_QUERY_LENGTH),
    }),
    result: explorerRetrievalPreviewSchema,
    request: (input) => ({
      method: 'POST',
      path: memoryExplorerPath(input.organizationId, '/preview-search'),
      body: { query: input.query },
    }),
  }),

  /* Digests ------------------------------------------------------------------------ */

  'organization.digests.list': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: digestArchiveSchema,
    request: (input) => get(organizationPath(input.organizationId, '/digests')),
  }),
  'organization.digests.get': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      digestId: settingsRouteIdSchema,
    }),
    result: digestDetailSchema,
    request: (input) =>
      get(
        organizationPath(
          input.organizationId,
          `/digests/${settingsPathSegment(input.digestId)}`,
        ),
      ),
  }),
  /**
   * Request an on-demand organization digest (editors). Spends AI credits; a
   * 402 `insufficient_credits` is a refusal, never a payment prompt.
   */
  'organization.digests.request': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      startDate: calendarDateSchema,
      endDate: calendarDateSchema,
    }),
    result: digestRequestResultSchema,
    request: (input) => ({
      method: 'POST',
      path: organizationPath(input.organizationId, '/digests'),
      body: { startDate: input.startDate, endDate: input.endDate },
    }),
  }),
  'organization.digests.sharing.update': defineSettingsWrite({
    transport: 'backend',
    input: z.union([
      z.strictObject({
        ...organizationIdField,
        digestId: settingsRouteIdSchema,
        action: z.literal('set-sharing'),
        sharingEnabled: z.boolean(),
      }),
      z.strictObject({
        ...organizationIdField,
        digestId: settingsRouteIdSchema,
        action: z.literal('rotate'),
      }),
    ]),
    result: digestSharingResultSchema,
    request: (input) => ({
      method: 'PATCH',
      path: organizationPath(
        input.organizationId,
        `/digests/${settingsPathSegment(input.digestId)}`,
      ),
      body:
        input.action === 'rotate'
          ? { action: 'rotate' }
          : { action: 'set-sharing', sharingEnabled: input.sharingEnabled },
    }),
  }),
  'organization.digests.preferences': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: digestPreferencesSchema,
    request: (input) =>
      get(organizationPath(input.organizationId, '/digest-preferences')),
  }),
  'organization.digests.preferences.update': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      ...organizationIdField,
      daily: z.boolean(),
      weekly: z.boolean(),
      monthly: z.boolean(),
      weeklyAnchorDay: z.number().int().min(1).max(7).optional(),
      monthlyAnchorDay: z.number().int().min(1).max(31).optional(),
    }),
    result: digestPreferencesSchema,
    request: ({ organizationId, ...body }) => ({
      method: 'PATCH',
      path: organizationPath(organizationId, '/digest-preferences'),
      body,
    }),
  }),

  /* Billing: non-payment reads -------------------------------------------------- */

  /**
   * Plan, trial, seats, next billing, cached card display and coverage.
   * Member-viewable server-side; the Billing subtab is OWNER/ADMIN.
   */
  'organization.billing.summary': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: z.custom<BillingSummary>(isBillingSummary),
    request: (input) => get(organizationPath(input.organizationId, '/billing')),
  }),
  /** Charge history, newest first. OWNER/ADMIN. */
  'organization.billing.history': defineSettingsRead({
    transport: 'backend',
    input: pagedInputSchema,
    result: z.custom<ChargePage>(isChargePage),
    request: (input) =>
      get(
        pagedPath(
          organizationPath(input.organizationId, '/billing/history'),
          input,
        ),
      ),
  }),
  /** Derived billing-period invoices. OWNER/ADMIN; detail is page data only. */
  'organization.billing.invoices': defineSettingsRead({
    transport: 'backend',
    input: pagedInputSchema,
    result: z.custom<InvoicePage>(isInvoicePage),
    request: (input) =>
      get(
        pagedPath(
          organizationPath(input.organizationId, '/billing/invoices'),
          input,
        ),
      ),
  }),
  /**
   * The AI-credit pool summary for OWNER/ADMIN, including automatic top-up SETTINGS
   * (read only; changing them is financial and web-only).
   */
  'organization.billing.credits': defineSettingsRead({
    transport: 'backend',
    input: organizationInputSchema,
    result: z.custom<CreditsSummary>(isCreditsSummary),
    request: (input) =>
      get(organizationPath(input.organizationId, '/billing/credits')),
  }),
  /** AI-credit activity, newest first. OWNER/ADMIN. */
  'organization.billing.credits.ledger': defineSettingsRead({
    transport: 'backend',
    input: pagedInputSchema,
    result: z.custom<AiCreditsLedgerPage>(isCreditsLedgerPage),
    request: (input) =>
      get(
        pagedPath(
          organizationPath(input.organizationId, '/billing/credits/ledger'),
          input,
        ),
      ),
  }),
} as const satisfies Record<string, AnySettingsOperation>;

export type OrganizationSettingsOperationName =
  keyof typeof ORGANIZATION_SETTINGS_OPERATIONS;

/** Names that reuse the promotion and invitation orchestration on desktop. */
export const ORGANIZATION_PROMOTION_OPERATION_NAMES = [
  'organization.promote',
  'organization.members.invite',
  'organization.invitations.status',
] as const satisfies readonly OrganizationSettingsOperationName[];
