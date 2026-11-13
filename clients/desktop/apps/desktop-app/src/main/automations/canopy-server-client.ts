import { classifyResourceOwner } from '@canopy/execution-engine/lib/resource-context';
import { assertResourceShareDestination } from '../lib/resource-share-context';
import { assertShareScopeTarget } from '../lib/share-scope-target';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  resourceContextEnabled,
  resourceContextSnapshot,
  assertResourceContextSnapshot,
  assertResourceContext,
  assertResourceContextForContext,
  resourceAccountSnapshot,
  assertResourceAccountSnapshot,
} from '../lib/resource-context';
import { createResourceLaneInventory } from '../lib/resource-inventory';
import { BRAND } from '@canopy/brand/current';
import type {
  CreateSharedAutomationIpcRequest,
  DeleteSharedAutomationIpcRequest,
  ListSharedAutomationsIpcRequest,
  UpdateSharedAutomationIpcRequest,
} from '@canopy/desktop-shared/types';
import type {
  ListSharedAutomationsResponse,
  SharedAutomationDetail,
  SharedAutomationPublicShareInfo,
} from '@canopy/protocol/automations';
import {
  requestCanopyCloudJson,
  requestCanopyCloudJsonConditional,
  requestCanopyCloudNoContent,
} from '../canopy-cloud/client';

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;

const listLanes = createResourceLaneInventory<SharedAutomationSummary>();

export async function listSharedAutomations(
  request: ListSharedAutomationsIpcRequest,
): Promise<ListSharedAutomationsResponse> {
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
        await requestCanopyCloudJsonConditional<ListSharedAutomationsResponse>(
          `${API_PREFIX}/automations?${query.toString()}`,
          { etag },
        );
      return response.status === 'not-modified'
        ? response
        : {
            ...response,
            body: {
              data: response.body.automations,
              nextCursor: response.body.nextCursor ?? null,
            },
          };
    });
    return {
      automations: result.data,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }
  const query = new URLSearchParams();
  if (request.limit !== undefined) query.set('limit', String(request.limit));
  if (request.cursor) query.set('cursor', request.cursor);
  if (request.query) query.set('q', request.query);
  if (request.createdBy) query.set('createdBy', request.createdBy);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestCanopyCloudJson<ListSharedAutomationsResponse>(
    `${API_PREFIX}/automations${suffix}`,
  );
}

/**
 * Fetch a shared automation and authorize its owner. A trusted caller
 * context (an agent's project owner) replaces the selected sidebar context.
 */
export async function getSharedAutomation(
  automationId: string,
  callerContext?: WorkspaceContext,
): Promise<SharedAutomationDetail> {
  if (callerContext !== undefined) {
    // A response fetched for another account must not pass this account's policy.
    const account = resourceContextEnabled()
      ? await resourceAccountSnapshot()
      : undefined;
    const detail = await requestCanopyCloudJson<SharedAutomationDetail>(
      `${API_PREFIX}/automations/${encodeURIComponent(automationId)}`,
    );
    await assertResourceContextForContext(
      { owner: detail.owner },
      callerContext,
    );
    if (account !== undefined) await assertResourceAccountSnapshot(account);
    return detail;
  }
  const snapshot = resourceContextEnabled()
    ? await resourceContextSnapshot()
    : undefined;
  const detail = await requestCanopyCloudJson<SharedAutomationDetail>(
    `${API_PREFIX}/automations/${encodeURIComponent(automationId)}`,
  );
  await assertResourceContext({ owner: detail.owner });
  if (snapshot !== undefined) await assertResourceContextSnapshot(snapshot);
  return detail;
}

export async function createSharedAutomation(
  request: Omit<CreateSharedAutomationIpcRequest, 'activityId'>,
): Promise<SharedAutomationDetail> {
  assertShareScopeTarget(request, 'an automation');
  if (resourceContextEnabled()) {
    const destination = await assertResourceShareDestination(request);
    if (request.savedFrom) {
      const source = await getSharedAutomation(request.savedFrom.remoteId);
      if (
        typeof classifyResourceOwner(source.owner, { strict: true }) ===
        'object'
      ) {
        await assertResourceContext(
          { owner: source.owner },
          { workspaceOwner: destination },
        );
      }
    }
  }
  return requestCanopyCloudJson<SharedAutomationDetail>(
    `${API_PREFIX}/automations`,
    {
      method: 'POST',
      body: JSON.stringify({
        automation: request.automation,
        ...(request.shareScope ? { shareScope: request.shareScope } : {}),
        ...(request.shareScope === 'team' && request.teamId
          ? { teamId: request.teamId }
          : {}),
        ...(request.shareScope === 'organization' && request.organizationId
          ? { organizationId: request.organizationId }
          : {}),
        ...(request.savedFrom ? { savedFrom: request.savedFrom } : {}),
        ...(request.committedPackageUploadId
          ? { committedPackageUploadId: request.committedPackageUploadId }
          : {}),
      }),
    },
  );
}

export async function updateSharedAutomation(
  request: Omit<UpdateSharedAutomationIpcRequest, 'activityId'>,
): Promise<SharedAutomationDetail> {
  assertShareScopeTarget(request, 'an automation');
  if (resourceContextEnabled()) {
    const source = await getSharedAutomation(request.automationId);
    if ('shareScope' in request && request.shareScope) {
      const destination = await assertResourceShareDestination(request);
      if (
        typeof classifyResourceOwner(source.owner, { strict: true }) ===
        'object'
      ) {
        await assertResourceContext(
          { owner: source.owner },
          { workspaceOwner: destination },
        );
      }
    }
  }
  return requestCanopyCloudJson<SharedAutomationDetail>(
    `${API_PREFIX}/automations/${encodeURIComponent(request.automationId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        automation: request.automation,
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
        ...(request.committedPackageUploadId
          ? { committedPackageUploadId: request.committedPackageUploadId }
          : {}),
        ...(request.revokePublicShare
          ? { revokePublicShare: request.revokePublicShare }
          : {}),
      }),
    },
  );
}

export async function deleteSharedAutomation(
  request: DeleteSharedAutomationIpcRequest,
): Promise<void> {
  if (resourceContextEnabled()) await getSharedAutomation(request.automationId);
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/automations/${encodeURIComponent(request.automationId)}`,
    { method: 'DELETE' },
  );
}

export async function publishAutomationPublicShare(
  automationId: string,
): Promise<SharedAutomationPublicShareInfo> {
  if (resourceContextEnabled()) await getSharedAutomation(automationId);
  const response = await requestCanopyCloudJson<{
    publicShare: SharedAutomationPublicShareInfo;
  }>(
    `${API_PREFIX}/automations/${encodeURIComponent(automationId)}/public-share`,
    { method: 'POST' },
  );
  return response.publicShare;
}

export async function revokeAutomationPublicShare(
  automationId: string,
): Promise<void> {
  if (resourceContextEnabled()) await getSharedAutomation(automationId);
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/automations/${encodeURIComponent(automationId)}/public-share`,
    { method: 'DELETE' },
  );
}
