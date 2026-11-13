import type {
  CreateSharedContainerGrantResponse,
  ListDismissedSharedContainersResponse,
  ListSharedContainerRecipientsResponse,
  ListSharedContainersResponse,
  RestoreSharedContainerResponse,
  SearchSharedContainerMembersResponse,
  SharedContainerCreateRequest,
  SharedContainerDetail,
  SharedContainerDownloadUrlsResponse,
  SharedContainerFetchRevisionResponse,
  SharedContainerCommitRevisionResponse,
  SharedContainerStageRevisionRequest,
  SharedContainerStageRevisionResponse,
  SharedContainerUploadTarget,
  SharedContainerLink,
  SharedContainerLinkAudience,
  SharedContainerLinkClaimResult,
  SharedContainerLinkLanding,
  CreateSharedContainerLinkRequest,
  CreateSharedContainerLinkResult,
} from '@canopy/protocol/shared-containers';
import { ciphertextLengthFor } from '@canopy/artifact-crypto';
import { createHash } from 'node:crypto';
import {
  CAPABILITY_PACKAGE_MAX_FILE_BYTES,
  isCapabilityPackageDigest,
  isCapabilityPackageManifest,
  isPipelineContentHash,
} from '@canopy/protocol/pipelines';
import { computePipelinePackageDigestSync } from '@canopy/desktop-shared/node';
import type {
  ListDismissedSharedContainersRequest,
  ListSharedContainerRecipientsRequest,
  ListSharedContainersByMeRequest,
  ListSharedContainersWithMeRequest,
  SearchSharedContainerMembersRequest,
} from '@canopy/desktop-shared/types';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
  requestCanopyCloudJson,
  requestCanopyCloudBinary,
  requestCanopyCloudNoContent,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import {
  withPackageVersionNegotiation,
  type PipelinePackageDownload,
} from '../pipelines/canopy-server-client';
import { isRecord } from '../lib/type-guards';

// CAN-2544 mounted these routes at the unbranded `api/v1/**` root
// (`apps/web/src/app/api/v1/shared-containers/**`), not under the legacy
// `api/v1/[brandNamespace]/**` segment the older `runs` client uses. Do not
// re-introduce the brand namespace here: every call 404s.
const API_PREFIX = '/api/v1/shared-containers';
const LINK_API_PREFIX = '/api/v1/shared-container-links';
const SHARED_CONTAINERS_CAPABILITY = 'shared-containers-v1';
// Separate from the base capability: a server that advertises only
// `shared-containers-v1` hard-deletes on dismiss and has neither route below.
const SHARED_CONTAINER_DISMISSALS_CAPABILITY = 'shared-container-dismissals-v1';

async function assertSupported(
  signal?: AbortSignal,
  credentials?: CanopyCloudCredentialContext,
): Promise<void> {
  if (credentials) {
    await assertCanopyCloudCapability(
      SHARED_CONTAINERS_CAPABILITY,
      credentials,
      signal,
    );
    return;
  }
  if (signal) {
    await assertCanopyCloudCapability(
      SHARED_CONTAINERS_CAPABILITY,
      undefined,
      signal,
    );
    return;
  }
  await assertCanopyCloudCapability(SHARED_CONTAINERS_CAPABILITY);
}

/**
 * `organizationId` is an optional ownership hint on every container-scoped
 * route: the server locates the container by id and, when the hint is
 * present, requires it to match. Personal containers have no organization,
 * so the parameter is omitted rather than sent empty.
 */
function organizationQuery(
  organizationId: string | undefined,
): URLSearchParams {
  const query = new URLSearchParams();
  if (organizationId !== undefined) query.set('organizationId', organizationId);
  return query;
}

function withQuery(path: string, query: URLSearchParams): string {
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function appendPagination(
  query: URLSearchParams,
  request: { cursor?: string; limit?: number },
): void {
  if (request.cursor) query.set('cursor', request.cursor);
  if (request.limit !== undefined) query.set('limit', String(request.limit));
}

export async function supportsSharedContainers(): Promise<boolean> {
  try {
    await assertSupported();
    return true;
  } catch (error) {
    if (
      error instanceof CanopyCloudClientError &&
      error.code === 'unsupported-capability'
    ) {
      return false;
    }
    throw error;
  }
}

export async function createSharedContainerGrant(
  request: SharedContainerCreateRequest,
): Promise<CreateSharedContainerGrantResponse> {
  await assertSupported();
  return requestCanopyCloudJson<CreateSharedContainerGrantResponse>(
    API_PREFIX,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  );
}

export async function getSharedContainerLink(
  containerId: string,
): Promise<SharedContainerLink | null> {
  await assertSupported();
  return requestCanopyCloudJson<SharedContainerLink | null>(
    `${API_PREFIX}/${encodeURIComponent(containerId)}/link`,
  );
}

export async function createSharedContainerLink(
  request: CreateSharedContainerLinkRequest,
): Promise<CreateSharedContainerLinkResult> {
  await assertSupported();
  return requestCanopyCloudJson<CreateSharedContainerLinkResult>(
    `${API_PREFIX}/link`,
    { method: 'PUT', body: JSON.stringify(request) },
  );
}

export async function setSharedContainerLink(
  containerId: string,
  audience: SharedContainerLinkAudience | null,
): Promise<SharedContainerLink | null> {
  await assertSupported();
  const path = `${API_PREFIX}/${encodeURIComponent(containerId)}/link`;
  if (audience === null) {
    await requestCanopyCloudNoContent(path, { method: 'DELETE' });
    return null;
  }
  return requestCanopyCloudJson<SharedContainerLink>(path, {
    method: 'PUT',
    body: JSON.stringify({ audience }),
  });
}

export async function resetSharedContainerLink(
  containerId: string,
): Promise<SharedContainerLink> {
  await assertSupported();
  return requestCanopyCloudJson<SharedContainerLink>(
    `${API_PREFIX}/${encodeURIComponent(containerId)}/link/reset`,
    { method: 'POST' },
  );
}

export async function resolveSharedContainerLink(
  token: string,
): Promise<SharedContainerLinkLanding> {
  await assertSupported();
  return requestCanopyCloudJson<SharedContainerLinkLanding>(
    `${LINK_API_PREFIX}/${encodeURIComponent(token)}`,
  );
}

export async function claimSharedContainerLink(
  token: string,
): Promise<SharedContainerLinkClaimResult> {
  await assertSupported();
  return requestCanopyCloudJson<SharedContainerLinkClaimResult>(
    `${LINK_API_PREFIX}/${encodeURIComponent(token)}/claim`,
    { method: 'POST' },
  );
}

type ListSharedContainersServerRequest = Omit<
  ListSharedContainersByMeRequest,
  'projectId' | 'worktreeId'
> & {
  /**
   * Exact server worktree identity used for the bounded owner lookup. Omit it
   * to list every container the caller owns in the organization: the route
   * treats `worktreeId` as optional (`parseSharedContainerOwnerList`), and the
   * org-wide listing backs the sidebar shared badge and publish-status
   * reconciliation (CAN-2551).
   */
  worktreeId?: string;
};

async function listSharedContainers(
  route: 'shared-by-me' | 'shared-with-me',
  request: ListSharedContainersServerRequest,
): Promise<ListSharedContainersResponse> {
  await assertSupported();
  // Without an organization, `shared-by-me` lists the caller's personal
  // containers and `shared-with-me` lists direct shares.
  const query = organizationQuery(request.organizationId);
  if (request.worktreeId !== undefined) {
    query.set('worktreeId', request.worktreeId);
  }
  appendPagination(query, request);
  return withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<ListSharedContainersResponse>(
      withQuery(`${API_PREFIX}/${route}`, query),
      { headers },
    ),
  );
}

export function listSharedContainersByMe(
  request: ListSharedContainersServerRequest,
): Promise<ListSharedContainersResponse> {
  return listSharedContainers('shared-by-me', request);
}

export type { ListSharedContainersWithMeRequest };

export async function listSharedContainersWithMe(
  request: ListSharedContainersWithMeRequest,
): Promise<ListSharedContainersResponse> {
  await assertSupported();
  // No organization lists direct shares: containers shared with the caller by
  // email or from outside their organizations.
  const query = organizationQuery(request.organizationId);
  appendPagination(query, request);
  return withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<ListSharedContainersResponse>(
      withQuery(`${API_PREFIX}/shared-with-me`, query),
      { headers },
    ),
  );
}

// The recipient dismiss route exports `DELETE` only
// (`apps/web/src/app/api/v1/shared-containers/[containerId]/dismiss/route.ts`),
// matching the owner revoke route and the `204`-no-body contract documented on
// the response envelopes in `@canopy/protocol/shared-containers`.
export async function dismissSharedContainer(
  containerId: string,
  organizationId: string | undefined,
  credentials?: CanopyCloudCredentialContext,
): Promise<void> {
  const credentialContext =
    credentials ?? (await resolveCanopyCloudCredentialContext());
  await assertSupported(undefined, credentialContext);
  await requestCanopyCloudNoContent(
    withQuery(
      `${API_PREFIX}/${encodeURIComponent(containerId)}/dismiss`,
      organizationQuery(organizationId),
    ),
    { method: 'DELETE', credentialContext },
  );
}

/**
 * Shares the caller removed and may still restore. Asserts the dismissals
 * capability before any request, so an older server is never asked for a
 * route it does not have.
 */
export async function listDismissedSharedContainers(
  request: ListDismissedSharedContainersRequest,
): Promise<ListDismissedSharedContainersResponse> {
  await assertCanopyCloudCapability(SHARED_CONTAINER_DISMISSALS_CAPABILITY);
  const query = organizationQuery(request.organizationId);
  appendPagination(query, request);
  return requestCanopyCloudJson<ListDismissedSharedContainersResponse>(
    withQuery(`${API_PREFIX}/dismissed`, query),
  );
}

/** Returns a removed share to the caller's inbox as a pending invitation. */
export async function restoreSharedContainer(
  containerId: string,
  organizationId: string | undefined,
): Promise<RestoreSharedContainerResponse> {
  await assertCanopyCloudCapability(SHARED_CONTAINER_DISMISSALS_CAPABILITY);
  return requestCanopyCloudJson<RestoreSharedContainerResponse>(
    withQuery(
      `${API_PREFIX}/${encodeURIComponent(containerId)}/restore`,
      organizationQuery(organizationId),
    ),
    { method: 'POST' },
  );
}

export async function fetchLatestSharedContainerRevision(
  containerId: string,
  organizationId: string | undefined,
  signal?: AbortSignal,
): Promise<SharedContainerDetail> {
  await assertSupported(signal);
  return withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<SharedContainerDetail>(
      withQuery(
        `${API_PREFIX}/${encodeURIComponent(containerId)}/revisions/latest`,
        organizationQuery(organizationId),
      ),
      { headers, signal },
    ),
  );
}

export async function fetchSharedContainerRevision(
  containerId: string,
  revisionId: string,
  organizationId: string | undefined,
  signal?: AbortSignal,
): Promise<SharedContainerFetchRevisionResponse> {
  await assertSupported(signal);
  return withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<SharedContainerFetchRevisionResponse>(
      withQuery(
        `${API_PREFIX}/${encodeURIComponent(containerId)}/revisions/${encodeURIComponent(revisionId)}`,
        organizationQuery(organizationId),
      ),
      { headers, signal },
    ),
  );
}

function revisionPackagePath(containerId: string, revisionId: string): string {
  return `${API_PREFIX}/${encodeURIComponent(containerId)}/revisions/${encodeURIComponent(revisionId)}/package`;
}

function revisionPackageQuery(
  organizationId: string | undefined,
  expectedPackageDigest: string,
): URLSearchParams {
  if (!isCapabilityPackageDigest(expectedPackageDigest)) {
    throw new Error('Invalid shared-container package digest');
  }
  const query = organizationQuery(organizationId);
  query.set('expectedPackageDigest', expectedPackageDigest);
  return query;
}

/** Authenticated, revision-pinned reads; never resolve through a link or latest. */
export async function getSharedContainerRevisionPackage(
  containerId: string,
  revisionId: string,
  organizationId: string | undefined,
  expectedPackageDigest: string,
  signal?: AbortSignal,
): Promise<PipelinePackageDownload> {
  const query = revisionPackageQuery(organizationId, expectedPackageDigest);
  await assertSupported(signal);
  const download = await withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<unknown>(
      withQuery(revisionPackagePath(containerId, revisionId), query),
      { headers, signal },
    ),
  );
  if (!isRecord(download) || !isCapabilityPackageManifest(download.manifest)) {
    throw new Error('Shared-container package manifest is invalid');
  }
  if (
    download.digest !== expectedPackageDigest ||
    computePipelinePackageDigestSync(download.manifest) !==
      expectedPackageDigest
  ) {
    throw new Error('Shared-container package digest mismatch');
  }
  return { digest: expectedPackageDigest, manifest: download.manifest };
}

export async function getSharedContainerRevisionPackageBlob(
  containerId: string,
  revisionId: string,
  organizationId: string | undefined,
  expectedPackageDigest: string,
  sha256: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const query = revisionPackageQuery(organizationId, expectedPackageDigest);
  if (!isPipelineContentHash(sha256)) {
    throw new Error('Invalid shared-container package blob hash');
  }
  await assertSupported(signal);
  const bytes = await withPackageVersionNegotiation((headers) =>
    requestCanopyCloudBinary(
      withQuery(
        `${revisionPackagePath(containerId, revisionId)}/blobs/${encodeURIComponent(sha256)}`,
        query,
      ),
      { headers, signal },
    ),
  );
  if (
    bytes.byteLength > CAPABILITY_PACKAGE_MAX_FILE_BYTES ||
    createHash('sha256').update(bytes).digest('hex') !== sha256
  ) {
    throw new Error('Shared-container package blob hash or size mismatch');
  }
  return new Uint8Array(bytes);
}

export async function requestSharedContainerArtifactDownloadUrls(
  containerId: string,
  revisionId: string,
  organizationId: string | undefined,
  artifactIds: string[],
  signal?: AbortSignal,
): Promise<SharedContainerDownloadUrlsResponse> {
  await assertSupported(signal);
  return requestCanopyCloudJson<SharedContainerDownloadUrlsResponse>(
    withQuery(
      `${API_PREFIX}/${encodeURIComponent(containerId)}/revisions/${encodeURIComponent(revisionId)}/artifacts/download-urls`,
      organizationQuery(organizationId),
    ),
    {
      method: 'POST',
      body: JSON.stringify({ artifactIds }),
      signal,
    },
  );
}

export async function stageSharedContainerRevision(
  containerId: string,
  request: SharedContainerStageRevisionRequest,
  signal?: AbortSignal,
): Promise<SharedContainerStageRevisionResponse> {
  await assertSupported(signal);
  return withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<SharedContainerStageRevisionResponse>(
      `${API_PREFIX}/${encodeURIComponent(containerId)}/revisions/stage`,
      { method: 'POST', body: JSON.stringify(request), headers, signal },
    ),
  );
}

export async function commitSharedContainerRevision(
  containerId: string,
  organizationId: string | undefined,
  stagingSessionId: string,
  signal?: AbortSignal,
): Promise<SharedContainerCommitRevisionResponse> {
  await assertSupported(signal);
  return withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<SharedContainerCommitRevisionResponse>(
      withQuery(
        `${API_PREFIX}/${encodeURIComponent(containerId)}/revisions/commit`,
        organizationQuery(organizationId),
      ),
      {
        method: 'POST',
        body: JSON.stringify({ stagingSessionId }),
        headers,
        signal,
      },
    ),
  );
}

/**
 * Uploads ciphertext directly to the signed object-store target.
 *
 * The signed URL commits to exactly `Content-Length` and
 * `x-goog-meta-plaintext-sha256`, so the request sends that two-header contract
 * verbatim. Dropping or adding a signed header makes the object store reject
 * the PUT as a signature mismatch. The declared ciphertext length and
 * plaintext digest are cross-checked against what this publisher actually
 * staged before the request goes out, so a disagreement fails locally instead
 * of storing an object the recipient cannot verify.
 */
export async function uploadSharedContainerArtifact(input: {
  target: SharedContainerUploadTarget;
  body: BodyInit;
  plaintextSizeBytes: number;
  plaintextHash: string;
  signal?: AbortSignal;
}): Promise<void> {
  const signedHeaders = input.target.target.headers;
  const signedHeaderNames = Object.keys(signedHeaders).map((name) =>
    name.toLowerCase(),
  );
  const signedHeader = (name: string): string | undefined =>
    Object.entries(signedHeaders).find(
      ([key]) => key.toLowerCase() === name,
    )?.[1];
  if (
    signedHeaderNames.length !== 2 ||
    !signedHeaderNames.includes('content-length') ||
    !signedHeaderNames.includes('x-goog-meta-plaintext-sha256') ||
    signedHeader('content-length') !==
      String(ciphertextLengthFor(input.plaintextSizeBytes)) ||
    signedHeader('x-goog-meta-plaintext-sha256') !== input.plaintextHash
  ) {
    throw new Error(
      `Signed upload target disagrees with staged artifact ${input.target.artifactId}`,
    );
  }
  let response: Response;
  try {
    response = await fetch(input.target.target.url, {
      method: input.target.target.method,
      headers: signedHeaders,
      body: input.body,
      signal: input.signal,
      duplex: 'half',
    } as RequestInit);
  } catch (error) {
    throw new CanopyCloudClientError(
      'network-error',
      error instanceof Error ? error.message : 'Artifact upload failed',
    );
  }
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const retryAfterDate =
      retryAfter === null ? Number.NaN : Date.parse(retryAfter);
    const retryAfterMs =
      Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1_000
        : Number.isFinite(retryAfterDate)
          ? Math.max(0, retryAfterDate - Date.now())
          : undefined;
    throw new CanopyCloudClientError(
      'http-error',
      'Shared-container artifact upload failed',
      response.status,
      undefined,
      undefined,
      false,
      retryAfterMs,
    );
  }
}

export async function searchSharedContainerMembers(
  request: SearchSharedContainerMembersRequest,
): Promise<SearchSharedContainerMembersResponse> {
  await assertSupported();
  const query = new URLSearchParams({
    organizationId: request.organizationId,
  });
  // Team audience: only members of this team of the organization.
  if (request.teamId !== undefined) query.set('teamId', request.teamId);
  if (request.query) query.set('q', request.query);
  if (request.limit !== undefined) query.set('limit', String(request.limit));
  return requestCanopyCloudJson<SearchSharedContainerMembersResponse>(
    `${API_PREFIX}/members?${query.toString()}`,
  );
}

export async function listSharedContainerRecipients(
  request: ListSharedContainerRecipientsRequest,
): Promise<ListSharedContainerRecipientsResponse> {
  await assertSupported();
  // `organizationId` is an optional ownership hint: the server finds the
  // container by id and, when the hint is present, requires it to match.
  const query = organizationQuery(request.organizationId);
  appendPagination(query, request);
  return requestCanopyCloudJson<ListSharedContainerRecipientsResponse>(
    withQuery(
      `${API_PREFIX}/${encodeURIComponent(request.containerId)}/recipients`,
      query,
    ),
  );
}

/**
 * Revoke one grant, or one pending email invite, by its id from the recipients
 * listing. Email recipients expose no user id, so revocation is always by
 * grant id. A missing grant answers `404` with the machine-readable
 * `shared-container-grant-not-found` code, which callers treat as idempotent.
 */
export async function revokeSharedContainerGrant(
  containerId: string,
  grantId: string,
  organizationId: string | undefined,
): Promise<void> {
  await assertSupported();
  await requestCanopyCloudNoContent(
    withQuery(
      `${API_PREFIX}/${encodeURIComponent(containerId)}/grants/${encodeURIComponent(grantId)}`,
      organizationQuery(organizationId),
    ),
    { method: 'DELETE' },
  );
}
