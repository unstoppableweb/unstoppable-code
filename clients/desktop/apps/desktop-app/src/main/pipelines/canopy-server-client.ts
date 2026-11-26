import {
  assertPipelineContext,
  assertPipelineContextSnapshot,
  listPipelineLanes,
  pipelineContextSnapshot,
  pipelineResourceContextEnabled,
} from './resource-lanes';
import type {
  CanopyOrganizationSummary,
  CanopyTeamSummary,
  ListSharedOrganizationsRequest,
  ListSharedPipelinesRequest,
  ListSharedTeamsRequest,
  PipelineShareScope,
  PipelineShareSource,
  PipelineDistributionMode,
  PipelinePackageManifestV1,
  PipelinePackageSummary,
  SharedPipelineDetail,
  SharedPipelinePublicShareInfo,
  SharedPipelineSummary,
} from '@canopy/execution-engine/types/pipeline';
import {
  PIPELINE_PACKAGE_CLIENT_VERSION,
  PIPELINE_PACKAGE_VERSION_HEADER,
} from '@canopy/protocol/pipelines';
import type { PublicShareVersion } from '@canopy/protocol/sharing';
import { BRAND } from '@canopy/brand/current';
import {
  CanopyCloudClientError,
  requestCanopyCloudBinary as requestBinary,
  requestCanopyCloudJson as requestJson,
  requestCanopyCloudJsonConditional,
  requestCanopyCloudNoContent as requestNoContent,
  requestCanopyCloudPublicBinary as requestPublicBinary,
  requestCanopyCloudPublicJson as requestPublicJson,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { assertShareScopeTarget } from '../lib/share-scope-target';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';

export { CanopyCloudClientError };

interface SharedPipelineListPayload {
  data: SharedPipelineSummary[];
  nextCursor: string | null;
}

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;

/**
 * Request shape passed to `createSharedPipeline`. This replaces the older
 * raw-pipeline-only signature so callers can opt the new pipeline into a
 * `team`/`organization` ownership scope.
 */
export interface CreateSharedPipelineRequest {
  sourcePipeline?: PipelineShareSource;
  sourcePipelineId?: string;
  rawPipeline: string;
  shareScope?: PipelineShareScope;
  teamId?: string;
  organizationId?: string;
  distributionMode?: PipelineDistributionMode;
  committedPackageUploadId?: string;
}

const PACKAGE_API_PREFIX = '/api/v1';

/**
 * Per-request timeout for package upload requests. Larger than the global
 * Cloud default because blob PUTs carry file bytes; callers may lower it to
 * fit an overall package deadline.
 */
export const PACKAGE_REQUEST_TIMEOUT_MS = 30_000;

/** Per-attempt options for package upload requests. */
export interface PackageUploadRequestOptions {
  timeoutMs?: number;
  /** Credential context resolved once for the whole package attempt. */
  credentialContext?: CanopyCloudCredentialContext;
}

function packageUploadInit(options: PackageUploadRequestOptions | undefined): {
  timeoutMs: number;
  credentialContext?: CanopyCloudCredentialContext;
} {
  return {
    timeoutMs: options?.timeoutMs ?? PACKAGE_REQUEST_TIMEOUT_MS,
    ...(options?.credentialContext
      ? { credentialContext: options.credentialContext }
      : {}),
  };
}
const packageHeaders = (version: number): Record<string, string> => ({
  [PIPELINE_PACKAGE_VERSION_HEADER]: String(version),
});
const PACKAGE_HEADERS = packageHeaders(PIPELINE_PACKAGE_CLIENT_VERSION);

/**
 * The older version a server is asking us to speak, or `null` when the error
 * is not a downgrade request.
 *
 * A server older than this client reports its OWN maximum, which is not
 * necessarily 1. Matching only `=== 1` meant every client-version bump
 * hard-failed all existing package downloads until web deployed; retrying at
 * whatever the server reports degrades instead.
 */
function legacyPackageVersionRequired(error: unknown): number | null {
  if (
    !(error instanceof CanopyCloudClientError) ||
    error.code !== 'http-error' ||
    error.status !== 426 ||
    error.serverCode !== 'pipeline_package_client_upgrade_required'
  ) {
    return null;
  }
  const required = error.requiredPackageVersion;
  return typeof required === 'number' &&
    Number.isInteger(required) &&
    required >= 1 &&
    required < PIPELINE_PACKAGE_CLIENT_VERSION
    ? required
    : null;
}

async function withLegacyPackageVersionFallback<T>(
  request: (headers: Record<string, string>) => Promise<T>,
  allowLegacy = true,
): Promise<T> {
  try {
    return await request(PACKAGE_HEADERS);
  } catch (error) {
    const required = legacyPackageVersionRequired(error);
    if (!allowLegacy || required === null) throw error;
    return request(packageHeaders(required));
  }
}

/**
 * Send an authenticated capability-package request with the newest supported
 * client version and retry once when the server asks for an older version.
 * Subject clients use this for negotiated detail reads as well as downloads.
 */
export async function withPackageVersionNegotiation<T>(
  request: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  return withLegacyPackageVersionFallback(request);
}

export interface PreparedPipelinePackageUpload {
  uploadId: string;
  expiresAt: string;
  missingBlobs: string[];
}

export interface CommittedPipelinePackageUpload {
  uploadId: string;
  digest: string;
  package: PipelinePackageSummary;
}

export interface PipelinePackageDownload {
  digest: string;
  manifest: PipelinePackageManifestV1;
}

/** Wire-compatible response shape for the dedicated Cloud organizations endpoint. */
export interface ListSharedOrganizationsPayload {
  data: CanopyOrganizationSummary[];
}

/** Wire-compatible response shape for the dedicated Cloud teams endpoint. */
export interface ListSharedTeamsPayload {
  data: CanopyTeamSummary[];
}

export async function listSharedPipelines(
  params: ListSharedPipelinesRequest,
  options: { personalOnly?: boolean } = {},
): Promise<SharedPipelineListPayload> {
  if (options.personalOnly && pipelineResourceContextEnabled()) {
    const query = sharedPipelineQuery(params);
    query.set('shareScope', 'private');
    return requestJson<SharedPipelineListPayload>(
      `${API_PREFIX}/pipelines?${query.toString()}`,
    );
  }
  if (pipelineResourceContextEnabled()) {
    return listPipelineLanes(params, (lane, cursor, etag) => {
      const query = sharedPipelineQuery({ ...params, cursor });
      query.set(
        'shareScope',
        lane.kind === 'personal' ? 'private' : 'organization',
      );
      if (lane.kind === 'organization')
        query.set('organizationId', lane.organizationId);
      return requestCanopyCloudJsonConditional<SharedPipelineListPayload>(
        `${API_PREFIX}/pipelines?${query.toString()}`,
        { etag },
      );
    });
  }
  const query = sharedPipelineQuery(params);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestJson<SharedPipelineListPayload>(
    `${API_PREFIX}/pipelines${suffix}`,
  );
}

function sharedPipelineQuery(
  params: ListSharedPipelinesRequest,
): URLSearchParams {
  const query = new URLSearchParams();
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  if (params.cursor) {
    query.set('cursor', params.cursor);
  }
  if (params.q) {
    query.set('q', params.q);
  }
  if (params.triggerType) {
    query.set('triggerType', params.triggerType);
  }
  if (params.createdBy) {
    query.set('createdBy', params.createdBy);
  }

  return query;
}

export async function getSharedPipeline(
  remoteId: string,
): Promise<SharedPipelineDetail> {
  const snapshot = pipelineResourceContextEnabled()
    ? await pipelineContextSnapshot()
    : undefined;
  const detail = await withLegacyPackageVersionFallback((headers) =>
    requestJson<SharedPipelineDetail>(
      `${API_PREFIX}/pipelines/${encodeURIComponent(remoteId)}`,
      { headers },
    ),
  );
  if (snapshot !== undefined) {
    await assertPipelineContext({ owner: detail.owner });
    await assertPipelineContextSnapshot(snapshot);
  }
  return detail;
}

/** Background read bound to account identity; the caller authorizes its owner. */
export async function getSharedPipelineForExecutionContext(
  remoteId: string,
): Promise<SharedPipelineDetail> {
  const before = await readCanopyCloudAccountWithStatus();
  if (before.status !== 'ok')
    throw new CanopyCloudClientError(
      'invalid-response',
      'Cloud account unavailable',
    );
  if (!before.entry?.account?.id)
    throw new Error('Workflow unavailable (access-removed)');
  const detail = await withLegacyPackageVersionFallback((headers) =>
    requestJson<SharedPipelineDetail>(
      `${API_PREFIX}/pipelines/${encodeURIComponent(remoteId)}`,
      { headers },
    ),
  );
  const after = await readCanopyCloudAccountWithStatus();
  if (after.status !== 'ok')
    throw new CanopyCloudClientError(
      'invalid-response',
      'Cloud account unavailable',
    );
  if (
    after.entry?.account?.id !== before.entry.account.id ||
    after.entry.apiKey !== before.entry.apiKey
  )
    throw new Error('Workflow unavailable (access-removed)');
  return detail;
}

export async function authorizeSharedPipelineCreate(
  request: CreateSharedPipelineRequest,
  loadSource?: (id: string) => Promise<string>,
): Promise<string> {
  const snapshot = pipelineResourceContextEnabled()
    ? await pipelineContextSnapshot()
    : undefined;
  let rawPipeline = request.rawPipeline;
  if (pipelineResourceContextEnabled()) {
    // Break the cycle: pipeline-install-context imports getSharedPipeline from this module.
    const {
      assertPipelineShareSourceContext,
      readPipelineShareSource,
      assertNewPipelineShareContent,
    } = await import('./pipeline-install-context');
    const source: PipelineShareSource | undefined =
      request.sourcePipeline ??
      (request.sourcePipelineId
        ? { kind: 'stored', id: request.sourcePipelineId }
        : undefined);
    if (source) {
      await assertPipelineShareSourceContext(source);
    }
    const owner =
      request.shareScope === 'organization'
        ? { type: 'organization', id: request.organizationId, name: null }
        : request.shareScope === 'team'
          ? (request.teamId
              ? (await listSharedTeams({ id: request.teamId })).data
              : []
            ).find((team) => team.id === request.teamId)
          : { type: 'user', id: 'local', name: null };
    await assertPipelineContext({
      owner:
        request.shareScope === 'team' && owner
          ? { ...owner, type: 'team' }
          : owner,
    });
    if (source) {
      await assertPipelineShareSourceContext(
        source,
        request.shareScope === 'team' && owner
          ? { ...owner, type: 'team' }
          : owner,
      );
      rawPipeline = loadSource
        ? await loadSource(
            source.kind === 'stored' ? source.id : source.pipelineFilePath,
          )
        : await readPipelineShareSource(source);
      // Loading may await filesystem or cloud I/O; the source must still be
      // authorized when those bytes are ready to leave this process.
      await assertPipelineShareSourceContext(
        source,
        request.shareScope === 'team' && owner
          ? { ...owner, type: 'team' }
          : owner,
      );
    } else {
      await assertNewPipelineShareContent(
        rawPipeline,
        request.shareScope === 'team' && owner
          ? { ...owner, type: 'team' }
          : owner,
      );
    }
  }
  if (snapshot !== undefined) await assertPipelineContextSnapshot(snapshot);
  return rawPipeline;
}

export async function createSharedPipeline(
  request: CreateSharedPipelineRequest,
  loadSource?: (id: string) => Promise<string>,
): Promise<SharedPipelineDetail> {
  assertShareScopeTarget(request, 'a pipeline');
  const snapshot = pipelineResourceContextEnabled()
    ? await pipelineContextSnapshot()
    : undefined;
  const rawPipeline = await authorizeSharedPipelineCreate(request, loadSource);
  // Build the wire-format envelope. Only forward scope-targeting fields
  // when they are meaningful for the chosen share scope.
  const body: {
    rawPipeline: string;
    shareScope?: PipelineShareScope;
    teamId?: string;
    organizationId?: string;
    distributionMode?: PipelineDistributionMode;
    committedPackageUploadId?: string;
  } = { rawPipeline };

  if (request.shareScope !== undefined) {
    body.shareScope = request.shareScope;
  }
  if (request.shareScope === 'team' && request.teamId) {
    body.teamId = request.teamId;
  }
  if (request.shareScope === 'organization' && request.organizationId) {
    body.organizationId = request.organizationId;
  }
  if (request.distributionMode !== undefined) {
    body.distributionMode = request.distributionMode;
  }
  if (request.committedPackageUploadId !== undefined) {
    body.committedPackageUploadId = request.committedPackageUploadId;
  }

  if (snapshot !== undefined) await assertPipelineContextSnapshot(snapshot);
  return requestJson<SharedPipelineDetail>(`${API_PREFIX}/pipelines`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function preparePipelinePackageUpload(
  request: {
    manifest: PipelinePackageManifestV1;
    expectedDigest: string;
  },
  options?: PackageUploadRequestOptions,
): Promise<PreparedPipelinePackageUpload> {
  const requiresPublisherNotes = Object.prototype.hasOwnProperty.call(
    request.manifest,
    'publisherNotes',
  );
  return withLegacyPackageVersionFallback(
    (headers) =>
      requestJson<PreparedPipelinePackageUpload>(
        `${PACKAGE_API_PREFIX}/pipeline-packages/uploads`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          ...packageUploadInit(options),
        },
      ),
    !requiresPublisherNotes,
  );
}

export async function uploadPipelinePackageBlob(
  uploadId: string,
  sha256: string,
  bytes: Uint8Array,
  options?: PackageUploadRequestOptions,
): Promise<void> {
  await withLegacyPackageVersionFallback((headers) =>
    requestNoContent(
      `${PACKAGE_API_PREFIX}/pipeline-packages/uploads/${encodeURIComponent(uploadId)}/blobs/${encodeURIComponent(sha256)}`,
      {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
        },
        body: Buffer.from(bytes),
        ...packageUploadInit(options),
      },
    ),
  );
}

export async function commitPipelinePackageUpload(
  uploadId: string,
  options?: PackageUploadRequestOptions,
): Promise<CommittedPipelinePackageUpload> {
  return withLegacyPackageVersionFallback((headers) =>
    requestJson<CommittedPipelinePackageUpload>(
      `${PACKAGE_API_PREFIX}/pipeline-packages/uploads/${encodeURIComponent(uploadId)}/commit`,
      { method: 'POST', headers, ...packageUploadInit(options) },
    ),
  );
}

export async function getPublicPipelinePackage(
  externalId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return withLegacyPackageVersionFallback((headers) =>
    requestPublicJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/public-shares/pipelines/${encodeURIComponent(externalId)}/package?${query.toString()}`,
      { headers },
    ),
  );
}

export async function getPublicPipelinePackageBlob(
  externalId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return new Uint8Array(
    await withLegacyPackageVersionFallback((headers) =>
      requestPublicBinary(
        `${PACKAGE_API_PREFIX}/public-shares/pipelines/${encodeURIComponent(externalId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
}

export async function getPipelinePackage(
  remoteId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const snapshot = pipelineResourceContextEnabled()
    ? await pipelineContextSnapshot()
    : undefined;
  if (snapshot !== undefined) {
    await getSharedPipeline(remoteId);
    await assertPipelineContextSnapshot(snapshot);
  }
  const query = new URLSearchParams({ expectedPackageDigest });
  const result = await withLegacyPackageVersionFallback((headers) =>
    requestJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/pipelines/${encodeURIComponent(remoteId)}/package?${query.toString()}`,
      { headers },
    ),
  );
  if (snapshot !== undefined) await assertPipelineContextSnapshot(snapshot);
  return result;
}

export async function getPipelinePackageBlob(
  remoteId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const snapshot = pipelineResourceContextEnabled()
    ? await pipelineContextSnapshot()
    : undefined;
  if (snapshot !== undefined) {
    await getSharedPipeline(remoteId);
    await assertPipelineContextSnapshot(snapshot);
  }
  const query = new URLSearchParams({ expectedPackageDigest });
  const result = new Uint8Array(
    await withLegacyPackageVersionFallback((headers) =>
      requestBinary(
        `${PACKAGE_API_PREFIX}/pipelines/${encodeURIComponent(remoteId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
  if (snapshot !== undefined) await assertPipelineContextSnapshot(snapshot);
  return result;
}

export async function getAutomationPackage(
  remoteId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  if (pipelineResourceContextEnabled()) {
    const { getSharedAutomation } =
      await import('../automations/canopy-server-client');
    await getSharedAutomation(remoteId);
  }
  const query = new URLSearchParams({ expectedPackageDigest });
  return withLegacyPackageVersionFallback((headers) =>
    requestJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/automations/${encodeURIComponent(remoteId)}/package?${query.toString()}`,
      { headers },
    ),
  );
}

export async function getAutomationPackageBlob(
  remoteId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  if (pipelineResourceContextEnabled()) {
    const { getSharedAutomation } =
      await import('../automations/canopy-server-client');
    await getSharedAutomation(remoteId);
  }
  const query = new URLSearchParams({ expectedPackageDigest });
  return new Uint8Array(
    await withLegacyPackageVersionFallback((headers) =>
      requestBinary(
        `${PACKAGE_API_PREFIX}/automations/${encodeURIComponent(remoteId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
}

export async function getPublicAutomationPackage(
  externalId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return withLegacyPackageVersionFallback((headers) =>
    requestPublicJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/public-shares/automations/${encodeURIComponent(externalId)}/package?${query.toString()}`,
      { headers },
    ),
  );
}

export async function getPublicAutomationPackageBlob(
  externalId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return new Uint8Array(
    await withLegacyPackageVersionFallback((headers) =>
      requestPublicBinary(
        `${PACKAGE_API_PREFIX}/public-shares/automations/${encodeURIComponent(externalId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
}

export async function getCuratedAutomationPackage(
  key: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return withLegacyPackageVersionFallback((headers) =>
    requestJson<PipelinePackageDownload>(
      `/api/v1/curated-automations/${encodeURIComponent(key)}/package?${query.toString()}`,
      { headers },
    ),
  );
}

export async function getCuratedAutomationPackageBlob(
  key: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return new Uint8Array(
    await withLegacyPackageVersionFallback((headers) =>
      requestBinary(
        `/api/v1/curated-automations/${encodeURIComponent(key)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
}

export async function getSkillPackage(
  remoteId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return withLegacyPackageVersionFallback((headers) =>
    requestJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/skills/${encodeURIComponent(remoteId)}/package?${query.toString()}`,
      { headers },
    ),
  );
}

export async function getSkillPackageBlob(
  remoteId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return new Uint8Array(
    await withLegacyPackageVersionFallback((headers) =>
      requestBinary(
        `${PACKAGE_API_PREFIX}/skills/${encodeURIComponent(remoteId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
}

export async function getPublicSkillPackage(
  externalId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return withLegacyPackageVersionFallback((headers) =>
    requestPublicJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/public-shares/skills/${encodeURIComponent(externalId)}/package?${query.toString()}`,
      { headers },
    ),
  );
}

export async function getPublicSkillPackageBlob(
  externalId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return new Uint8Array(
    await withLegacyPackageVersionFallback((headers) =>
      requestPublicBinary(
        `${PACKAGE_API_PREFIX}/public-shares/skills/${encodeURIComponent(externalId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
}

/**
 * Replaces a shared pipeline's YAML. Omitting `packageAttachment` makes the
 * server detach any existing package, because a package pins the previous
 * content hash; pass a freshly committed upload to keep a `package` share.
 */
export async function updateSharedPipeline(
  remoteId: string,
  rawPipeline: string,
  options: {
    expectedContentHash?: string;
    shareScope?: PipelineShareScope;
    teamId?: string;
    organizationId?: string;
    distributionMode?: PipelineDistributionMode;
    committedPackageUploadId?: string;
    revokePublicShare?: PublicShareVersion;
    preservePackage?: boolean;
  } = {},
): Promise<SharedPipelineDetail> {
  if (pipelineResourceContextEnabled()) {
    const snapshot = await pipelineContextSnapshot();
    const current = await getSharedPipeline(remoteId);
    if (options.shareScope) {
      const { assertResourceShareDestination, assertResourceShareTransition } =
        await import('../lib/resource-share-context');
      const destination = await assertResourceShareDestination(options);
      await assertResourceShareTransition(current.owner, destination);
    }
    await assertPipelineContextSnapshot(snapshot);
  }
  return requestJson<SharedPipelineDetail>(
    `${API_PREFIX}/pipelines/${encodeURIComponent(remoteId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        rawPipeline,
        ...options,
      }),
    },
  );
}

export async function deleteSharedPipeline(remoteId: string): Promise<void> {
  if (pipelineResourceContextEnabled()) {
    const snapshot = await pipelineContextSnapshot();
    await getSharedPipeline(remoteId);
    await assertPipelineContextSnapshot(snapshot);
  }
  await requestNoContent(
    `${API_PREFIX}/pipelines/${encodeURIComponent(remoteId)}`,
    { method: 'DELETE' },
  );
}

export async function publishPipelinePublicShare(
  remoteId: string,
): Promise<SharedPipelinePublicShareInfo> {
  if (pipelineResourceContextEnabled()) {
    const snapshot = await pipelineContextSnapshot();
    await getSharedPipeline(remoteId);
    await assertPipelineContextSnapshot(snapshot);
  }
  const response = await requestJson<{
    publicShare: SharedPipelinePublicShareInfo;
  }>(`${API_PREFIX}/pipelines/${encodeURIComponent(remoteId)}/public-share`, {
    method: 'POST',
  });
  return response.publicShare;
}

export async function revokePipelinePublicShare(
  remoteId: string,
): Promise<void> {
  if (pipelineResourceContextEnabled()) {
    const snapshot = await pipelineContextSnapshot();
    await getSharedPipeline(remoteId);
    await assertPipelineContextSnapshot(snapshot);
  }
  await requestNoContent(
    `${API_PREFIX}/pipelines/${encodeURIComponent(remoteId)}/public-share`,
    { method: 'DELETE' },
  );
}

export async function listSharedOrganizations(
  params: ListSharedOrganizationsRequest,
): Promise<ListSharedOrganizationsPayload> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  if (params.q) {
    query.set('q', params.q);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestJson<ListSharedOrganizationsPayload>(
    `${API_PREFIX}/organizations${suffix}`,
  );
}

export async function listSharedTeams(
  params: ListSharedTeamsRequest,
): Promise<ListSharedTeamsPayload> {
  const query = new URLSearchParams();
  if (params.id) query.set('id', params.id);
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  if (params.q) {
    query.set('q', params.q);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestJson<ListSharedTeamsPayload>(`${API_PREFIX}/teams${suffix}`);
}
