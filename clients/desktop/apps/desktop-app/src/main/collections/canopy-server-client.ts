import { assertInstalledResourceShare } from '../lib/resource-install-context';
import {
  assertResourceShareDestination,
  assertResourceShareTransition,
} from '../lib/resource-share-context';
import { assertShareScopeTarget } from '../lib/share-scope-target';
import {
  ShareOperationError,
  SkillSecretDetectedError,
} from '../sharing/share-operation-result';
import type {
  SharedCollectionPublicShareInfo,
  SharedCollectionSummary,
} from '@canopy/protocol/collections';
import {
  collectionSkillSecretMessage,
  scanSharedSkillForSecrets,
} from '@canopy/protocol/skills';
import {
  resourceContextEnabled,
  resourceContextSnapshot,
  assertResourceContextSnapshot,
  assertResourceContext,
} from '../lib/resource-context';
import { createResourceLaneInventory } from '../lib/resource-inventory';
import type {
  CreateSharedCollectionRequest,
  DeleteSharedCollectionRequest,
  ListSharedCollectionsRequest,
  ListSharedCollectionsResponse,
  SharedCollectionDetail,
  UpdateSharedCollectionRequest,
} from '@canopy/desktop-shared/types/collections';
import { BRAND } from '@canopy/brand/current';
import {
  requestCanopyCloudBinary,
  requestCanopyCloudJson,
  requestCanopyCloudJsonConditional,
  requestCanopyCloudNoContent,
  requestCanopyCloudPublicBinary,
  requestCanopyCloudPublicJson,
} from '../canopy-cloud/client';
import {
  withPackageVersionNegotiation,
  type PipelinePackageDownload,
} from '../pipelines/canopy-server-client';

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;
const PACKAGE_API_PREFIX = '/api/v1';

const listLanes = createResourceLaneInventory<SharedCollectionSummary>();

export async function listSharedCollections(
  request: ListSharedCollectionsRequest,
): Promise<ListSharedCollectionsResponse> {
  if (resourceContextEnabled()) {
    const result = await listLanes(request, async (lane, cursor, etag) => {
      const query = new URLSearchParams();
      if (request.limit !== undefined)
        query.set('limit', String(request.limit));
      if (cursor) query.set('cursor', cursor);
      if (request.query) query.set('q', request.query);
      if (request.createdBy) query.set('createdBy', request.createdBy);
      query.set(
        'shareScope',
        lane.kind === 'personal' ? 'private' : 'organization',
      );
      if (lane.kind === 'organization')
        query.set('organizationId', lane.organizationId);
      const response =
        await requestCanopyCloudJsonConditional<ListSharedCollectionsResponse>(
          `${API_PREFIX}/collections?${query.toString()}`,
          { etag },
        );
      return response.status === 'not-modified'
        ? response
        : {
            ...response,
            body: {
              data: response.body.collections,
              nextCursor: response.body.nextCursor ?? null,
            },
          };
    });
    return {
      collections: result.data,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }
  const query = new URLSearchParams();
  if (request.limit !== undefined) query.set('limit', String(request.limit));
  if (request.cursor) query.set('cursor', request.cursor);
  if (request.query) query.set('q', request.query);
  if (request.createdBy) query.set('createdBy', request.createdBy);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestCanopyCloudJson<ListSharedCollectionsResponse>(
    `${API_PREFIX}/collections${suffix}`,
  );
}

export async function getSharedCollection(
  collectionId: string,
): Promise<SharedCollectionDetail> {
  const snapshot = resourceContextEnabled()
    ? await resourceContextSnapshot()
    : undefined;
  const detail = await withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<SharedCollectionDetail>(
      `${API_PREFIX}/collections/${encodeURIComponent(collectionId)}`,
      { headers },
    ),
  );
  await assertResourceContext({ owner: detail.owner });
  if (snapshot !== undefined) await assertResourceContextSnapshot(snapshot);
  return detail;
}

export async function getCollectionPackage(
  collectionId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const snapshot = resourceContextEnabled()
    ? await resourceContextSnapshot()
    : undefined;
  if (snapshot !== undefined) {
    await getSharedCollection(collectionId);
    await assertResourceContextSnapshot(snapshot);
  }
  const query = new URLSearchParams({ expectedPackageDigest });
  const result = await withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/collections/${encodeURIComponent(collectionId)}/package?${query.toString()}`,
      { headers },
    ),
  );
  if (snapshot !== undefined) await assertResourceContextSnapshot(snapshot);
  return result;
}

export async function getCollectionPackageBlob(
  collectionId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const snapshot = resourceContextEnabled()
    ? await resourceContextSnapshot()
    : undefined;
  if (snapshot !== undefined) {
    await getSharedCollection(collectionId);
    await assertResourceContextSnapshot(snapshot);
  }
  const query = new URLSearchParams({ expectedPackageDigest });
  const result = new Uint8Array(
    await withPackageVersionNegotiation((headers) =>
      requestCanopyCloudBinary(
        `${PACKAGE_API_PREFIX}/collections/${encodeURIComponent(collectionId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
  if (snapshot !== undefined) await assertResourceContextSnapshot(snapshot);
  return result;
}

export async function getPublicCollectionPackage(
  collectionId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return withPackageVersionNegotiation((headers) =>
    requestCanopyCloudPublicJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/public-shares/collections/${encodeURIComponent(collectionId)}/package?${query.toString()}`,
      { headers },
    ),
  );
}

export async function getPublicCollectionPackageBlob(
  collectionId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return new Uint8Array(
    await withPackageVersionNegotiation((headers) =>
      requestCanopyCloudPublicBinary(
        `${PACKAGE_API_PREFIX}/public-shares/collections/${encodeURIComponent(collectionId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
}

async function assertCollectionCanBeShared(
  sourceCollectionId: string | undefined,
): Promise<void> {
  if (!sourceCollectionId) return;
  const { readCollectionConfig } = await import('./collection-store');
  const source = await readCollectionConfig(sourceCollectionId);
  if (!source) throw new Error('Collection not found.');
  if (source.collection.mcpServers.length > 0) {
    throw new ShareOperationError(
      'unavailable',
      'Collections containing MCP servers cannot be shared.',
      'access',
    );
  }
}

/**
 * Refuses to upload a collection whose custom skill text looks like it holds
 * a secret (CAN-7226). It runs on the exact text that would be sent, before
 * any read or request, so a refused share makes no network call. The message
 * names the skill, file and rule, never the match.
 */
function assertCustomSkillsHoldNoSecrets(
  customSkills: CreateSharedCollectionRequest['customSkills'],
): void {
  for (const skill of customSkills ?? []) {
    const finding = scanSharedSkillForSecrets({
      skillName: skill.name,
      files: [{ path: 'SKILL.md', text: skill.rawSkill }],
    });
    if (finding !== null)
      throw new SkillSecretDetectedError(
        collectionSkillSecretMessage(finding),
        'access',
      );
  }
}

export async function createSharedCollection(
  request: CreateSharedCollectionRequest,
): Promise<SharedCollectionDetail> {
  assertShareScopeTarget(request, 'a collection');
  assertCustomSkillsHoldNoSecrets(request.customSkills);
  await assertCollectionCanBeShared(request.sourceCollectionId);
  if (resourceContextEnabled()) {
    const destination = await assertResourceShareDestination(request);
    if (request.sourceCollectionId) {
      await assertInstalledResourceShare(
        'collections',
        request.sourceCollectionId,
        destination,
        getSharedCollection,
      );
    }
  }
  const body: {
    rawCollection: string;
    customSkills?: CreateSharedCollectionRequest['customSkills'];
    shareScope?: CreateSharedCollectionRequest['shareScope'];
    teamId?: string;
    organizationId?: string;
    capabilityPackage?: CreateSharedCollectionRequest['capabilityPackage'];
    committedPackageUploadId?: string;
  } = { rawCollection: request.rawCollection };
  if (request.customSkills) body.customSkills = request.customSkills;
  if (request.shareScope !== undefined) body.shareScope = request.shareScope;
  if (request.shareScope === 'team' && request.teamId)
    body.teamId = request.teamId;
  if (request.shareScope === 'organization' && request.organizationId) {
    body.organizationId = request.organizationId;
  }
  if (request.capabilityPackage !== undefined) {
    body.capabilityPackage = request.capabilityPackage;
  }
  if (request.committedPackageUploadId !== undefined) {
    body.committedPackageUploadId = request.committedPackageUploadId;
  }
  return requestCanopyCloudJson<SharedCollectionDetail>(
    `${API_PREFIX}/collections`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export async function updateSharedCollection(
  request: UpdateSharedCollectionRequest,
): Promise<SharedCollectionDetail> {
  assertShareScopeTarget(request, 'a collection');
  assertCustomSkillsHoldNoSecrets(request.customSkills);
  await assertCollectionCanBeShared(request.sourceCollectionId);
  if (resourceContextEnabled()) {
    const current = await getSharedCollection(request.collectionId);
    if (request.shareScope) {
      const destination = await assertResourceShareDestination(request);
      await assertResourceShareTransition(current.owner, destination);
      if (request.sourceCollectionId) {
        await assertInstalledResourceShare(
          'collections',
          request.sourceCollectionId,
          destination,
          getSharedCollection,
        );
      }
    }
  }
  return requestCanopyCloudJson<SharedCollectionDetail>(
    `${API_PREFIX}/collections/${encodeURIComponent(request.collectionId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        rawCollection: request.rawCollection,
        ...(request.customSkills ? { customSkills: request.customSkills } : {}),
        ...(request.expectedContentHash
          ? { expectedContentHash: request.expectedContentHash }
          : {}),
        ...(request.shareScope ? { shareScope: request.shareScope } : {}),
        ...(request.shareScope === 'team' && request.teamId
          ? { teamId: request.teamId }
          : {}),
        ...(request.shareScope === 'organization' && request.organizationId
          ? { organizationId: request.organizationId }
          : {}),
        ...(request.capabilityPackage !== undefined
          ? { capabilityPackage: request.capabilityPackage }
          : {}),
        ...(request.committedPackageUploadId !== undefined
          ? { committedPackageUploadId: request.committedPackageUploadId }
          : {}),
      }),
    },
  );
}

export async function deleteSharedCollection(
  request: DeleteSharedCollectionRequest,
): Promise<void> {
  if (resourceContextEnabled()) await getSharedCollection(request.collectionId);
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/collections/${encodeURIComponent(request.collectionId)}`,
    { method: 'DELETE' },
  );
}

export async function publishCollectionPublicShare(
  collectionId: string,
): Promise<SharedCollectionPublicShareInfo> {
  if (resourceContextEnabled()) await getSharedCollection(collectionId);
  const response = await requestCanopyCloudJson<{
    publicShare: SharedCollectionPublicShareInfo;
  }>(
    `${API_PREFIX}/collections/${encodeURIComponent(collectionId)}/public-share`,
    { method: 'POST' },
  );
  return response.publicShare;
}

export async function revokeCollectionPublicShare(
  collectionId: string,
): Promise<void> {
  if (resourceContextEnabled()) await getSharedCollection(collectionId);
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/collections/${encodeURIComponent(collectionId)}/public-share`,
    { method: 'DELETE' },
  );
}
