import {
  personalAiGatewayConfigSchema,
  personalAiGatewayUpdateSchema,
  aiGatewayConnectSchema,
} from '../model-gateway';
import { aiGatewayConnectionResultSchema } from '../model-gateway/discovery';
import { z } from 'zod';
import type { DigestPreferences } from '../digests/index';
import {
  MODEL_ROUTING_BACKTEST_MODES,
  MODEL_ROUTING_BACKTEST_STATUSES,
  type ModelRoutingBacktestCreateResponseV1,
  type ModelRoutingBacktestLookupResponseV1,
  type ModelRoutingBacktestV1,
} from '../model-routing/backtest';
import {
  PROFILE_SOCIAL_PLATFORMS,
  PUBLIC_PROFILE_BIO_MAX_LENGTH,
  PUBLIC_PROFILE_MAX_LINKS,
  type PublicProfileArtifactDetail,
} from '../profile/index';
import {
  ACCOUNT_API_ROUTES,
  ALLOWED_AVATAR_MIME_TYPES,
  isAuthSourcesResponse,
  MAX_AVATAR_UPLOAD_BYTES,
  PASSWORD_MAX_LENGTH,
  PERSONAL_PROJECT_CATALOG_API_PATH,
  SOCIAL_PROVIDER_IDS,
  type AuthSourcesResponse,
  type AvatarCommitResponse,
  type NotificationPreferences,
  type OkResponse,
  type PersonalCatalogRemovalResponse,
  type PersonalCatalogResponse,
  type PublicProfileSettingsResponse,
  type UpdateProfileResponse,
  type UserApiKeyCreateResponse,
  type UserApiKeyListItem,
  type UsernameAvailabilityResponse,
} from './account';
import type {
  AccountDigestDetail,
  DigestArchiveItem,
  DigestOnDemandRequestResult,
  DigestProfileFeatureResponse,
} from './account-digests';
import {
  isGitHubCloudConnectionDto,
  isGitHubCloudConnectResponse,
  GITHUB_CLOUD_CONNECT_INTENTS,
  type GitHubCloudConnectionDto,
  type GitHubCloudConnectResponse,
} from './account-github';
import {
  PROFILE_ARTIFACT_PATH_KINDS,
  type ListPublishableArtifactsResponse,
  type ListPublishedProfileArtifactsResponse,
  type SearchPublishableArtifactsResponse,
} from './account-publishing';
import {
  ACCOUNT_BILLING_READ_ROUTES,
  billingHistoryPath,
  billingInvoicesPath,
  isBillingSummary,
  isChargePage,
  isCreditsLedgerPage,
  isCreditsSummary,
  isInvoicePage,
  type BillingSummary,
  type ChargePage,
  type CreditsLedgerPage,
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
import { accountReviewApprovalOperations } from './github-review-approvals';
import {
  accountLabsResponseSchema,
  labsExperimentChoiceRequestSchema,
  type AccountLabsResponse,
} from '../experiments/index';
import {
  accountAppearanceSchema,
  type AccountAppearance,
} from '../chat-detail/index';

/**
 * Hosted settings table entries for the personal (account) scope. Each entry
 * mirrors one call the web account pages make today: same method, path, JSON
 * body and response DTO. Paths include the `/api` prefix the web client adds
 * through `fetchBackendUrl`.
 *
 * Deliberately absent (financial; web-only behind `inlineCheckout`): setup
 * intents, payment-method confirm and removal, credit top-up and charging,
 * automatic top-up mutation, subscription cancel/resume, and plan-change
 * quotes. Automatic top-up SETTINGS are read through `account.billing.credits`
 * (`CreditsSummary.autoTopUp`).
 *
 * `transport: 'auth'` entries are Better Auth endpoints under `/api/auth/*`
 * with the exact JSON body the web `authClient` sends. Spike A (see the
 * planning `spikes.md`) ran these from an isolated Electron session against a
 * live web app: Better Auth accepts header-only `Origin` provenance for a
 * minted bridge session and refuses the same request without it. The unused
 * fallback is thin `/api/v1/settings/security/*` routes with
 * `transport: 'backend'`.
 */

/** Backend paths are the web `fetchBackendUrl` paths plus this prefix. */
const API = '/api';

/** Better Auth's mount point (`authClient` default `basePath`). */
const AUTH_API = '/api/auth';

/**
 * One path segment from validated input; always URL-encoded on use. `.` and
 * `..` survive encoding and would navigate the path, so they are refused.
 */
const segmentIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value !== '.' && value !== '..');

/** Relative in-app path: one leading `/`, never `//`, no backslash. */
const relativeAppPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^\/(?![/\\])[^\\]*$/);

const pageQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).nullable().optional(),
});

const optionalPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/** `{ password }` only when supplied, matching the web panel's bodies. */
function withOptionalPassword(password: string | undefined): {
  password?: string;
} {
  return password === undefined ? {} : { password };
}

/**
 * The quarantine object path the avatar upload-url route returns as
 * `filePath`. `SettingsSignedUpload` names it `objectKey`; accept either so a
 * host may normalize the signed response without changing the commit body.
 */
function avatarCommitFilePath(signed: SettingsSignedUpload): string {
  const filePath: unknown = signed.filePath;
  if (typeof filePath === 'string') return filePath;
  return signed.objectKey ?? '';
}

function avatarSignRequest(input: {
  mimeType: string;
  size: number;
}): SettingsOperationRequest {
  return {
    method: 'POST',
    path: `${API}${ACCOUNT_API_ROUTES.avatarUploadUrl}`,
    body: { mimeType: input.mimeType, size: input.size },
  };
}

function profileArtifactPath(kind: string, sourceId: string): string {
  return `${API}${ACCOUNT_API_ROUTES.publicProfileArtifact(kind, sourceId)}`;
}

function digestPath(digestId: string): string {
  return `${API}/account/digests/${settingsPathSegment(digestId)}`;
}

const ROUTING_BACKTEST_PATH = `${API}/account/model-routing-backtests`;

const artifactKindSchema = z.enum(PROFILE_ARTIFACT_PATH_KINDS);

const socialLinkInputSchema = z.strictObject({
  platform: z.enum(PROFILE_SOCIAL_PLATFORMS),
  url: z.string().min(1).max(2048),
});

const routingBacktestSchema = z.looseObject({
  id: z.string(),
  status: z.enum(MODEL_ROUTING_BACKTEST_STATUSES),
  mode: z.enum(MODEL_ROUTING_BACKTEST_MODES),
  rangeStartIso: z.string(),
  rangeEndIso: z.string(),
  progress: z.looseObject({}),
  result: z.looseObject({}).nullable(),
});

const digestArchiveItemSchema = z.looseObject({
  externalId: z.string(),
  cadence: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  headline: z.string().nullable(),
  variant: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

const digestDetailSchema = z.looseObject({
  externalId: z.string(),
  subjectType: z.string(),
  cadence: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  headline: z.string().nullable(),
  executiveSummaryMarkdown: z.string().nullable(),
  bodyMarkdown: z.string().nullable(),
  variant: z.string(),
  sharingEnabled: z.boolean().optional(),
  sharePath: z.string().optional(),
});

const apiKeyListItemSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  createdIp: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

const publicProfileSettingsResponseSchema =
  settingsDtoSchema<PublicProfileSettingsResponse>(
    z.looseObject({
      settings: z
        .looseObject({
          username: z.string().nullable(),
          enabled: z.boolean(),
          bio: z.string().nullable(),
          links: z.array(
            z.looseObject({ platform: z.string(), url: z.string() }),
          ),
          showCost: z.boolean(),
          showHeatmap: z.boolean(),
        })
        .nullable(),
    }),
  );

const updateProfileResponseSchema = settingsDtoSchema<UpdateProfileResponse>(
  z.looseObject({ name: z.string(), image: z.string().nullable() }),
);

const okResponseSchema = settingsDtoSchema<OkResponse>(
  z.looseObject({ ok: z.literal(true) }),
);

const githubConnectionSchema = settingsDtoSchema<GitHubCloudConnectionDto>(
  z.custom(isGitHubCloudConnectionDto),
);

const artifactPublishableItemSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  published: z.boolean(),
});

export const ACCOUNT_SETTINGS_OPERATIONS = {
  'account.settings.ai-gateway.read': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: z.looseObject({
      gateway: personalAiGatewayConfigSchema.nullable(),
    }),
    request: () => ({ method: 'GET', path: '/api/v1/settings/ai-gateway' }),
  }),
  'account.settings.ai-gateway.update': defineSettingsWrite({
    maxInputBytes: 512 * 1024,
    transport: 'backend',
    input: personalAiGatewayUpdateSchema,
    result: z.looseObject({ gateway: personalAiGatewayConfigSchema }),
    request: (input) => ({
      method: 'PATCH',
      path: '/api/v1/settings/ai-gateway',
      body: input,
    }),
  }),
  'account.settings.ai-gateway.connect': defineSettingsWrite({
    transport: 'backend',
    input: aiGatewayConnectSchema.extend({ expectedOrganizationId: z.uuid() }),
    result: aiGatewayConnectionResultSchema,
    request: (input) => ({
      method: 'POST',
      path: '/api/v1/settings/ai-gateway/connect',
      body: input,
    }),
  }),
  /* ------------------------------------------------------------------------ */
  /* Account tab: identity and avatar                                         */
  /* ------------------------------------------------------------------------ */

  'account.details.update': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({ name: z.string().min(1).max(1024) }),
    result: updateProfileResponseSchema,
    request: (input) => ({
      method: 'PATCH',
      path: `${API}${ACCOUNT_API_ROUTES.profile}`,
      body: { name: input.name },
    }),
  }),
  'account.avatar.upload': defineSettingsWrite({
    transport: 'upload',
    input: z.strictObject({
      mimeType: z.enum(ALLOWED_AVATAR_MIME_TYPES),
      size: z.number().int().min(1).max(MAX_AVATAR_UPLOAD_BYTES),
      file: settingsUploadFileSchema.optional(),
    }),
    result: settingsDtoSchema<AvatarCommitResponse>(
      z.looseObject({ image: z.string().min(1) }),
    ),
    request: avatarSignRequest,
    upload: {
      maxBytes: MAX_AVATAR_UPLOAD_BYTES,
      contentTypes: ALLOWED_AVATAR_MIME_TYPES,
      sign: avatarSignRequest,
      commit: (_input, signed) => ({
        method: 'POST',
        path: `${API}${ACCOUNT_API_ROUTES.avatarCommit}`,
        body: { filePath: avatarCommitFilePath(signed) },
      }),
    },
  }),
  'account.avatar.remove': defineSettingsWrite({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: updateProfileResponseSchema,
    request: () => ({
      method: 'PATCH',
      path: `${API}${ACCOUNT_API_ROUTES.profile}`,
      body: { image: null },
    }),
  }),

  /* ------------------------------------------------------------------------ */
  /* Public profile tab                                                       */
  /* ------------------------------------------------------------------------ */

  'account.profile.read': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: publicProfileSettingsResponseSchema,
    request: () => ({
      method: 'GET',
      path: `${API}${ACCOUNT_API_ROUTES.publicProfile}`,
    }),
  }),
  'account.profile.update': defineSettingsWrite({
    transport: 'backend',
    maxInputBytes: 16 * 1024,
    input: z.strictObject({
      username: z.string().max(256).optional(),
      enabled: z.boolean().optional(),
      bio: z.string().max(PUBLIC_PROFILE_BIO_MAX_LENGTH).nullable().optional(),
      links: z
        .array(socialLinkInputSchema)
        .max(PUBLIC_PROFILE_MAX_LINKS)
        .optional(),
      showCost: z.boolean().optional(),
      showHeatmap: z.boolean().optional(),
    }),
    result: publicProfileSettingsResponseSchema,
    request: (input) => ({
      method: 'PATCH',
      path: `${API}${ACCOUNT_API_ROUTES.publicProfile}`,
      body: input,
    }),
  }),
  'account.profile.usernameAvailability': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({ username: z.string().max(256) }),
    result: settingsDtoSchema<UsernameAvailabilityResponse>(
      z.looseObject({
        available: z.boolean(),
        reason: z.enum(['invalid', 'reserved', 'taken']).optional(),
      }),
    ),
    request: (input) => ({
      method: 'GET',
      path: settingsPathWithQuery(
        `${API}${ACCOUNT_API_ROUTES.publicProfileUsernameAvailability}`,
        { username: input.username },
      ),
    }),
  }),
  'account.profile.artifacts.list': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<ListPublishableArtifactsResponse>(
      z.looseObject({
        skills: z.array(artifactPublishableItemSchema),
        runs: z.array(artifactPublishableItemSchema),
        plans: z.array(artifactPublishableItemSchema),
        pipelines: z.array(artifactPublishableItemSchema),
      }),
    ),
    request: () => ({
      method: 'GET',
      path: `${API}${ACCOUNT_API_ROUTES.publicProfileArtifacts}`,
    }),
  }),
  'account.profile.artifacts.published': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<ListPublishedProfileArtifactsResponse>(
      z.looseObject({
        items: z.array(
          z.looseObject({
            kind: artifactKindSchema,
            id: z.string(),
            title: z.string(),
            publishedAt: z.string(),
          }),
        ),
      }),
    ),
    request: () => ({
      method: 'GET',
      path: settingsPathWithQuery(
        `${API}${ACCOUNT_API_ROUTES.publicProfileArtifacts}`,
        { view: 'published' },
      ),
    }),
  }),
  'account.profile.artifacts.search': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      kind: artifactKindSchema,
      query: z.string().max(256),
    }),
    result: settingsDtoSchema<SearchPublishableArtifactsResponse>(
      z.looseObject({ items: z.array(artifactPublishableItemSchema) }),
    ),
    request: (input) => ({
      method: 'GET',
      path: settingsPathWithQuery(
        `${API}${ACCOUNT_API_ROUTES.publicProfileArtifacts}`,
        { kind: input.kind, q: input.query },
      ),
    }),
  }),
  'account.profile.artifacts.preview': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      kind: artifactKindSchema,
      sourceId: segmentIdSchema,
    }),
    result: settingsDtoSchema<{ preview: PublicProfileArtifactDetail }>(
      z.looseObject({
        preview: z.looseObject({ kind: z.string(), id: z.string() }),
      }),
    ),
    request: (input) => ({
      method: 'GET',
      path: profileArtifactPath(input.kind, input.sourceId),
    }),
  }),
  'account.profile.artifacts.publish': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      kind: artifactKindSchema,
      sourceId: segmentIdSchema,
    }),
    result: settingsDtoSchema<{ artifact: PublicProfileArtifactDetail | null }>(
      z.looseObject({ artifact: z.looseObject({}).nullable() }),
    ),
    request: (input) => ({
      method: 'POST',
      path: profileArtifactPath(input.kind, input.sourceId),
    }),
  }),
  'account.profile.artifacts.unpublish': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      kind: artifactKindSchema,
      sourceId: segmentIdSchema,
    }),
    result: settingsAcknowledgementSchema,
    request: (input) => ({
      method: 'DELETE',
      path: profileArtifactPath(input.kind, input.sourceId),
    }),
  }),
  'account.profile.artifacts.revokeSkillShare': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({ sourceId: segmentIdSchema }),
    result: settingsAcknowledgementSchema,
    request: (input) => ({
      method: 'DELETE',
      path: settingsPathWithQuery(
        profileArtifactPath('skills', input.sourceId),
        {
          share: 'revoke',
        },
      ),
    }),
  }),
  'account.profile.projects.read': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<PersonalCatalogResponse>(
      z.looseObject({
        projects: z.array(
          z.looseObject({
            id: z.string(),
            name: z.string(),
            kind: z.enum(['CODE', 'COWORK']),
            updatedAt: z.string(),
            online: z.boolean(),
          }),
        ),
      }),
    ),
    request: () => ({
      method: 'GET',
      path: `${API}${PERSONAL_PROJECT_CATALOG_API_PATH}`,
    }),
  }),
  'account.profile.projects.remove': defineSettingsWrite({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<PersonalCatalogRemovalResponse>(
      z.looseObject({ catalogGeneration: z.number() }),
    ),
    request: () => ({
      method: 'DELETE',
      path: `${API}${PERSONAL_PROJECT_CATALOG_API_PATH}`,
    }),
  }),
  'account.profile.routingBacktest.lookup': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({
      startIso: z.iso.datetime(),
      endIso: z.iso.datetime(),
    }),
    result: settingsDtoSchema<ModelRoutingBacktestLookupResponseV1>(
      z.looseObject({
        backtest: routingBacktestSchema.nullable(),
        estimate: z.looseObject({}).nullable(),
      }),
    ),
    request: (input) => ({
      method: 'GET',
      path: settingsPathWithQuery(ROUTING_BACKTEST_PATH, {
        start: input.startIso,
        end: input.endIso,
      }),
    }),
  }),
  'account.profile.routingBacktest.create': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      startIso: z.iso.datetime(),
      endIso: z.iso.datetime(),
      mode: z.enum(MODEL_ROUTING_BACKTEST_MODES),
    }),
    result: settingsDtoSchema<ModelRoutingBacktestCreateResponseV1>(
      z.looseObject({ backtest: routingBacktestSchema, cached: z.boolean() }),
    ),
    request: (input) => ({
      method: 'POST',
      path: ROUTING_BACKTEST_PATH,
      body: {
        startIso: input.startIso,
        endIso: input.endIso,
        mode: input.mode,
      },
    }),
  }),
  'account.profile.routingBacktest.read': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({ backtestId: segmentIdSchema }),
    result: settingsDtoSchema<{ backtest: ModelRoutingBacktestV1 }>(
      z.looseObject({ backtest: routingBacktestSchema }),
    ),
    request: (input) => ({
      method: 'GET',
      path: `${ROUTING_BACKTEST_PATH}/${settingsPathSegment(input.backtestId)}`,
    }),
  }),

  /* ------------------------------------------------------------------------ */
  /* Notifications tab                                                        */
  /* ------------------------------------------------------------------------ */

  'account.notifications.digestPreferences.read': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<DigestPreferences>(
      z.looseObject({
        daily: z.boolean(),
        weekly: z.boolean(),
        monthly: z.boolean(),
        weeklyAnchorDay: z.number().int(),
        monthlyAnchorDay: z.number().int(),
      }),
    ),
    request: () => ({
      method: 'GET',
      path: `${API}/account/digest-preferences`,
    }),
  }),
  'account.notifications.digestPreferences.update': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      daily: z.boolean(),
      weekly: z.boolean(),
      monthly: z.boolean(),
      weeklyAnchorDay: z.number().int().min(1).max(7).optional(),
      monthlyAnchorDay: z.number().int().min(1).max(31).optional(),
    }),
    result: settingsDtoSchema<DigestPreferences>(
      z.looseObject({
        daily: z.boolean(),
        weekly: z.boolean(),
        monthly: z.boolean(),
        weeklyAnchorDay: z.number().int(),
        monthlyAnchorDay: z.number().int(),
      }),
    ),
    request: (input) => ({
      method: 'PATCH',
      path: `${API}/account/digest-preferences`,
      body: input,
    }),
  }),
  'account.notifications.push.read': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<NotificationPreferences>(
      z.looseObject({ pushEnabled: z.boolean() }),
    ),
    request: () => ({
      method: 'GET',
      path: `${API}/account/notification-preferences`,
    }),
  }),
  'account.notifications.push.update': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({ pushEnabled: z.boolean() }),
    result: settingsDtoSchema<NotificationPreferences>(
      z.looseObject({ pushEnabled: z.boolean() }),
    ),
    request: (input) => ({
      method: 'PATCH',
      path: `${API}/account/notification-preferences`,
      body: { pushEnabled: input.pushEnabled },
    }),
  }),

  /* ------------------------------------------------------------------------ */
  /* Labs tab                                                                 */
  /* ------------------------------------------------------------------------ */

  'account.labs.read': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<AccountLabsResponse>(accountLabsResponseSchema),
    request: () => ({ method: 'GET', path: `${API}/account/labs` }),
  }),
  'account.labs.update': defineSettingsWrite({
    transport: 'backend',
    input: labsExperimentChoiceRequestSchema,
    result: settingsDtoSchema<AccountLabsResponse>(accountLabsResponseSchema),
    request: (input) => ({
      method: 'PUT',
      path: `${API}/account/labs`,
      body: input,
    }),
  }),

  /* ------------------------------------------------------------------------ */
  /* Appearance tab                                                           */
  /* ------------------------------------------------------------------------ */

  'account.appearance.read': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<AccountAppearance>(accountAppearanceSchema),
    request: () => ({ method: 'GET', path: `${API}/account/appearance` }),
  }),
  'account.appearance.update': defineSettingsWrite({
    transport: 'backend',
    input: accountAppearanceSchema,
    result: settingsDtoSchema<AccountAppearance>(accountAppearanceSchema),
    request: (input) => ({
      method: 'PUT',
      path: `${API}/account/appearance`,
      body: input,
    }),
  }),

  /* ------------------------------------------------------------------------ */
  /* Digests tab                                                              */
  /* ------------------------------------------------------------------------ */

  'account.digests.list': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<DigestArchiveItem[]>(
      z.array(digestArchiveItemSchema),
    ),
    request: () => ({ method: 'GET', path: `${API}/account/digests` }),
  }),
  'account.digests.read': defineSettingsRead({
    transport: 'backend',
    input: z.strictObject({ digestId: segmentIdSchema }),
    result: settingsDtoSchema<AccountDigestDetail>(digestDetailSchema),
    request: (input) => ({ method: 'GET', path: digestPath(input.digestId) }),
  }),
  'account.digests.request': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({ startDate: z.iso.date(), endDate: z.iso.date() }),
    result: settingsDtoSchema<DigestOnDemandRequestResult>(
      z.looseObject({
        status: z.enum(['already_exists', 'enqueued', 'publishing_disabled']),
        digestExternalId: z.string(),
      }),
    ),
    request: (input) => ({
      method: 'POST',
      path: `${API}/account/digests`,
      body: { startDate: input.startDate, endDate: input.endDate },
    }),
  }),
  'account.digests.share.update': defineSettingsWrite({
    transport: 'backend',
    input: z.discriminatedUnion('action', [
      z.strictObject({
        digestId: segmentIdSchema,
        action: z.literal('rotate'),
      }),
      z.strictObject({
        digestId: segmentIdSchema,
        action: z.literal('set-sharing'),
        sharingEnabled: z.boolean(),
      }),
    ]),
    result: settingsDtoSchema<AccountDigestDetail>(
      digestDetailSchema.extend({ sharingEnabled: z.boolean() }),
    ),
    request: (input) => ({
      method: 'PATCH',
      path: digestPath(input.digestId),
      body:
        input.action === 'rotate'
          ? { action: 'rotate' }
          : { action: 'set-sharing', sharingEnabled: input.sharingEnabled },
    }),
  }),
  'account.digests.profileFeature.set': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      digestId: segmentIdSchema,
      organizationId: segmentIdSchema,
      featured: z.boolean(),
    }),
    result: settingsDtoSchema<DigestProfileFeatureResponse>(
      z.looseObject({ organizationId: z.string(), featured: z.boolean() }),
    ),
    request: (input) => ({
      method: input.featured ? 'PUT' : 'DELETE',
      path: `${digestPath(input.digestId)}/profile-features/${settingsPathSegment(
        input.organizationId,
      )}`,
    }),
  }),

  /* ------------------------------------------------------------------------ */
  /* Integrations tab: GitHub for cloud work                                  */
  /* ------------------------------------------------------------------------ */

  /** Code review approval policy (shared with the other scope). */
  ...accountReviewApprovalOperations(),
  'account.github.connection.read': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: githubConnectionSchema,
    request: () => ({ method: 'GET', path: `${API}/cloud/github/connection` }),
  }),
  'account.github.connection.verify': defineSettingsWrite({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: githubConnectionSchema,
    request: () => ({
      method: 'POST',
      path: `${API}/cloud/github/connection/install-verify`,
    }),
  }),
  'account.github.connection.installLink': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      returnTo: relativeAppPathSchema,
      intent: z.enum(GITHUB_CLOUD_CONNECT_INTENTS).optional(),
      continuationGeneration: z.number().int().positive().optional(),
    }),
    result: settingsDtoSchema<GitHubCloudConnectResponse>(
      z.custom(isGitHubCloudConnectResponse),
    ),
    request: (input) => ({
      method: 'POST',
      path: `${API}/cloud/github/connection/connect`,
      body: {
        returnTo: input.returnTo,
        intent: input.intent,
        continuationGeneration: input.continuationGeneration,
      },
    }),
  }),
  'account.github.connection.disconnect': defineSettingsWrite({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: githubConnectionSchema,
    request: () => ({
      method: 'DELETE',
      path: `${API}/cloud/github/connection`,
    }),
  }),

  /* ------------------------------------------------------------------------ */
  /* Security tab: API keys                                                   */
  /* ------------------------------------------------------------------------ */

  'account.apiKeys.list': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<UserApiKeyListItem[]>(
      z.array(apiKeyListItemSchema),
    ),
    request: () => ({ method: 'GET', path: `${API}/account/api-keys` }),
  }),
  'account.apiKeys.create': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({ name: z.string().min(1).max(256) }),
    result: settingsDtoSchema<UserApiKeyCreateResponse>(
      z.looseObject({
        userApiKey: apiKeyListItemSchema,
        token: z.string().min(1),
      }),
    ),
    request: (input) => ({
      method: 'POST',
      path: `${API}/account/api-keys`,
      body: { name: input.name },
    }),
  }),
  'account.apiKeys.revoke': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({ apiKeyId: segmentIdSchema }),
    result: settingsAcknowledgementSchema,
    request: (input) => ({
      method: 'DELETE',
      path: `${API}/account/api-keys/${settingsPathSegment(input.apiKeyId)}`,
    }),
  }),

  /* ------------------------------------------------------------------------ */
  /* Security tab: sign-in methods, password, two-factor                      */
  /* ------------------------------------------------------------------------ */

  'account.security.authSources': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<AuthSourcesResponse>(
      z.custom(isAuthSourcesResponse),
    ),
    request: () => ({
      method: 'GET',
      path: `${API}${ACCOUNT_API_ROUTES.authSources}`,
    }),
  }),
  /** Canopy's own unlink route (last-method guard), not Better Auth's. */
  'account.security.unlinkAuthSource': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      providerId: segmentIdSchema,
      accountId: z.string().min(1).max(512),
    }),
    result: okResponseSchema,
    request: (input) => ({
      method: 'DELETE',
      path: `${API}${ACCOUNT_API_ROUTES.authSource(input.providerId)}`,
      body: { accountId: input.accountId },
    }),
  }),
  /** First password for an account without the credential provider. */
  'account.security.setPassword': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({
      newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    }),
    result: okResponseSchema,
    request: (input) => ({
      method: 'POST',
      path: `${API}${ACCOUNT_API_ROUTES.password}`,
      body: { newPassword: input.newPassword },
    }),
  }),
  /** `authClient.changePassword({ currentPassword, newPassword })`. */
  'account.security.changePassword': defineSettingsWrite({
    transport: 'auth',
    input: z.strictObject({
      currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
      newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    }),
    result: settingsDtoSchema<{
      token: string | null;
      user: Record<string, unknown>;
    }>(
      z.looseObject({
        token: z.string().nullable(),
        user: z.looseObject({}),
      }),
    ),
    request: (input) => ({
      method: 'POST',
      path: `${AUTH_API}/change-password`,
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      },
    }),
  }),
  /**
   * `authClient.linkSocial(...)`. The callbacks are relative in-app paths;
   * the provider redirect needs a browser that holds the web session, so a
   * host that cannot follow it in place opens the returned `url` externally.
   */
  'account.security.linkSocial': defineSettingsWrite({
    transport: 'auth',
    input: z.strictObject({
      provider: z.enum(SOCIAL_PROVIDER_IDS),
      callbackURL: relativeAppPathSchema,
      errorCallbackURL: relativeAppPathSchema,
      disableRedirect: z.boolean().optional(),
    }),
    result: settingsDtoSchema<{ url: string; redirect: boolean }>(
      z.looseObject({ url: z.string().url(), redirect: z.boolean() }),
    ),
    request: (input) => ({
      method: 'POST',
      path: `${AUTH_API}/link-social`,
      body: {
        provider: input.provider,
        callbackURL: input.callbackURL,
        errorCallbackURL: input.errorCallbackURL,
        ...(input.disableRedirect === undefined
          ? {}
          : { disableRedirect: input.disableRedirect }),
      },
    }),
  }),
  /** `authClient.twoFactor.enable({ password?, issuer })`. */
  'account.security.twoFactor.enable': defineSettingsWrite({
    transport: 'auth',
    input: z.strictObject({
      password: optionalPasswordSchema.optional(),
      issuer: z.string().min(1).max(256).optional(),
    }),
    result: settingsDtoSchema<{ totpURI: string; backupCodes: string[] }>(
      z.looseObject({
        totpURI: z.string().min(1),
        backupCodes: z.array(z.string()),
      }),
    ),
    request: (input) => ({
      method: 'POST',
      path: `${AUTH_API}/two-factor/enable`,
      body: {
        ...withOptionalPassword(input.password),
        ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
      },
    }),
  }),
  /**
   * First TOTP verification through Canopy's session route (NOT Better
   * Auth's `verifyTotp`), so the rotated session cookie and the two-factor
   * completion cookie are both set.
   */
  'account.security.twoFactor.verify': defineSettingsWrite({
    transport: 'backend',
    // The route answers a wrong or empty code with 401. It sends the same 401
    // for a missing session, so a session that really ended reads as a wrong
    // code here; the next read's 401 expires it as usual.
    rejectedCredentialOn401: true,
    input: z.strictObject({ code: z.string().min(1).max(64) }),
    result: okResponseSchema,
    request: (input) => ({
      method: 'POST',
      path: `${API}${ACCOUNT_API_ROUTES.twoFactorSession}`,
      body: { code: input.code.trim(), purpose: 'setup' },
    }),
  }),
  /** Clears the completion cookie after disabling two-factor. */
  'account.security.twoFactor.clearSession': defineSettingsWrite({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsAcknowledgementSchema,
    request: () => ({
      method: 'DELETE',
      path: `${API}${ACCOUNT_API_ROUTES.twoFactorSession}`,
    }),
  }),
  /** `authClient.twoFactor.disable({ password? })`. */
  'account.security.twoFactor.disable': defineSettingsWrite({
    transport: 'auth',
    input: z.strictObject({ password: optionalPasswordSchema.optional() }),
    result: settingsDtoSchema<{ status: boolean }>(
      z.looseObject({ status: z.boolean() }),
    ),
    request: (input) => ({
      method: 'POST',
      path: `${AUTH_API}/two-factor/disable`,
      body: withOptionalPassword(input.password),
    }),
  }),
  /** `authClient.twoFactor.generateBackupCodes({ password? })`. */
  'account.security.twoFactor.backupCodes': defineSettingsWrite({
    transport: 'auth',
    input: z.strictObject({ password: optionalPasswordSchema.optional() }),
    result: settingsDtoSchema<{ status: boolean; backupCodes: string[] }>(
      z.looseObject({
        status: z.boolean(),
        backupCodes: z.array(z.string()),
      }),
    ),
    request: (input) => ({
      method: 'POST',
      path: `${AUTH_API}/two-factor/generate-backup-codes`,
      body: withOptionalPassword(input.password),
    }),
  }),

  /* ------------------------------------------------------------------------ */
  /* Billing tab: non-payment reads and the daily free-credit preference      */
  /* ------------------------------------------------------------------------ */

  'account.billing.summary': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<BillingSummary>(z.custom(isBillingSummary)),
    request: () => ({
      method: 'GET',
      path: `${API}${ACCOUNT_BILLING_READ_ROUTES.summary}`,
    }),
  }),
  'account.billing.charges': defineSettingsRead({
    transport: 'backend',
    input: pageQuerySchema,
    result: settingsDtoSchema<ChargePage>(z.custom(isChargePage)),
    request: (input) => ({
      method: 'GET',
      path: `${API}${billingHistoryPath(input)}`,
    }),
  }),
  'account.billing.invoices': defineSettingsRead({
    transport: 'backend',
    input: pageQuerySchema,
    result: settingsDtoSchema<InvoicePage>(z.custom(isInvoicePage)),
    request: (input) => ({
      method: 'GET',
      path: `${API}${billingInvoicesPath(input)}`,
    }),
  }),
  /** Includes the automatic top-up SETTINGS. */
  'account.billing.credits': defineSettingsRead({
    transport: 'backend',
    input: settingsEmptyInputSchema,
    result: settingsDtoSchema<CreditsSummary>(z.custom(isCreditsSummary)),
    request: () => ({
      method: 'GET',
      path: `${API}${ACCOUNT_BILLING_READ_ROUTES.credits}`,
    }),
  }),
  'account.billing.creditsLedger': defineSettingsRead({
    transport: 'backend',
    input: pageQuerySchema,
    result: settingsDtoSchema<CreditsLedgerPage>(z.custom(isCreditsLedgerPage)),
    request: (input) => ({
      method: 'GET',
      path: settingsPathWithQuery(
        `${API}${ACCOUNT_BILLING_READ_ROUTES.creditsLedger}`,
        { limit: input.limit, cursor: input.cursor },
      ),
    }),
  }),
} as const satisfies Record<string, AnySettingsOperation>;

export type AccountSettingsOperationName =
  keyof typeof ACCOUNT_SETTINGS_OPERATIONS;
