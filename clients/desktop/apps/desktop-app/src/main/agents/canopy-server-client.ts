import { isDeepStrictEqual } from 'node:util';
import { normalizeShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import { requireProviderForModel } from '@canopy/desktop-shared/types';
import { isAgentDefaultBaseModel } from '@canopy/protocol/agents';
import {
  emptyPluginSelections,
  normalizePluginSelections,
} from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  assertAgentContext,
  assertAgentContextSnapshot,
  listAgentLanes,
  agentContextSnapshot,
  agentResourceContextEnabled,
} from './resource-lanes';
import { BRAND } from '@canopy/brand/current';
import type {
  AgentModelDefinition,
  SharedAgentDocument,
  CreateSharedAgentRequest,
  DeleteSharedAgentRequest,
  ListSharedAgentsRequest,
  ListSharedAgentsResponse,
  SharedAgentDetail,
  SharedAgentPublicShareInfo,
  UpdateSharedAgentRequest,
} from '@canopy/execution-engine/types/agent-models';
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

export async function listSharedAgents(
  request: ListSharedAgentsRequest,
): Promise<ListSharedAgentsResponse> {
  if (agentResourceContextEnabled()) {
    return listAgentLanes(request, (lane, cursor, etag) => {
      const query = sharedAgentQuery({ ...request, cursor });
      query.set(
        'shareScope',
        lane.kind === 'personal' ? 'private' : 'organization',
      );
      if (lane.kind === 'organization')
        query.set('organizationId', lane.organizationId);
      return requestCanopyCloudJsonConditional<ListSharedAgentsResponse>(
        `${API_PREFIX}/agents?${query.toString()}`,
        { etag },
      );
    });
  }
  const query = sharedAgentQuery(request);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestCanopyCloudJson<ListSharedAgentsResponse>(
    `${API_PREFIX}/agents${suffix}`,
  );
}

function sharedAgentQuery(request: ListSharedAgentsRequest): URLSearchParams {
  const query = new URLSearchParams();
  if (request.limit !== undefined) query.set('limit', String(request.limit));
  if (request.cursor) query.set('cursor', request.cursor);
  if (request.query) query.set('q', request.query);
  if (request.createdBy) query.set('createdBy', request.createdBy);
  return query;
}

export async function getSharedAgent(
  agentId: string,
): Promise<SharedAgentDetail> {
  const snapshot = agentResourceContextEnabled()
    ? await agentContextSnapshot()
    : undefined;
  const detail = await withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<SharedAgentDetail>(
      `${API_PREFIX}/agents/${encodeURIComponent(agentId)}`,
      { headers },
    ),
  );
  if (snapshot !== undefined) {
    await assertAgentContext({ owner: detail.owner });
    await assertAgentContextSnapshot(snapshot);
  }
  return detail;
}

export async function getAgentPackage(
  agentId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return withPackageVersionNegotiation((headers) =>
    requestCanopyCloudJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/agents/${encodeURIComponent(agentId)}/package?${query.toString()}`,
      { headers },
    ),
  );
}

export async function getAgentPackageBlob(
  agentId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return new Uint8Array(
    await withPackageVersionNegotiation((headers) =>
      requestCanopyCloudBinary(
        `${PACKAGE_API_PREFIX}/agents/${encodeURIComponent(agentId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
}

export async function getPublicAgentPackage(
  externalId: string,
  expectedPackageDigest: string,
): Promise<PipelinePackageDownload> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return withPackageVersionNegotiation((headers) =>
    requestCanopyCloudPublicJson<PipelinePackageDownload>(
      `${PACKAGE_API_PREFIX}/public-shares/agents/${encodeURIComponent(externalId)}/package?${query.toString()}`,
      { headers },
    ),
  );
}

export async function getPublicAgentPackageBlob(
  externalId: string,
  expectedPackageDigest: string,
  sha256: string,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ expectedPackageDigest });
  return new Uint8Array(
    await withPackageVersionNegotiation((headers) =>
      requestCanopyCloudPublicBinary(
        `${PACKAGE_API_PREFIX}/public-shares/agents/${encodeURIComponent(externalId)}/package/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
        { headers },
      ),
    ),
  );
}

async function assertAgentShareDestination(
  request: CreateSharedAgentRequest,
): Promise<unknown> {
  if (!agentResourceContextEnabled()) return;
  // Defer the pipeline client and its resource-policy graph until sharing is enabled.
  const { listSharedTeams } = await import('../pipelines/canopy-server-client');
  const team =
    request.shareScope === 'team'
      ? (await listSharedTeams({ id: request.teamId })).data.find(
          (row) => row.id === request.teamId,
        )
      : undefined;
  const owner =
    request.shareScope === 'organization'
      ? { type: 'organization', id: request.organizationId, name: null }
      : request.shareScope === 'team'
        ? team
          ? { ...team, type: 'team' }
          : undefined
        : { type: 'user', id: 'local', name: null };
  await assertAgentContext({ owner });
  return owner;
}

async function authorizedAgentSource(
  id: string,
  owner: unknown,
): Promise<AgentModelDefinition> {
  // Break the cycle: receipt authorization and the store depend on this client.
  const { assertAgentShareOrigin } = await import('./agent-install-context');
  const { getAgentModel } = await import('./agent-model-store');
  const agent = await getAgentModel(id);
  if (!agent) throw new Error('Agent not found');
  await assertAgentShareOrigin(id, owner);
  return agent;
}

async function authorizedAgentDocument(
  source: AgentModelDefinition,
  document: SharedAgentDocument,
): Promise<SharedAgentDocument> {
  const plugins = document.plugins.map(normalizeShareablePluginRef);
  const selections = emptyPluginSelections();
  if (plugins.length > 0) {
    // Defer the heavy skill/marketplace catalog until sharing needs it.
    const { loadShareablePluginCatalog, resolveShareablePluginRefs } =
      await import('../plugins/shareable-plugin-resolution');
    const matches = resolveShareablePluginRefs(
      plugins,
      await loadShareablePluginCatalog(),
      // An inheriting Agent's provider is unknown until a chat starts.
      isAgentDefaultBaseModel(source.baseModel)
        ? {}
        : { providerType: requireProviderForModel(source.baseModel) },
    );
    for (const match of matches) {
      if (match.matchState === 'unmatched')
        throw new Error('Agent plugins do not match stored source');
      if (match.selection.kind === 'skill') {
        selections.skillRefs.push({
          sourceId: match.selection.sourceId,
          skillName: match.selection.skillName,
        });
      } else {
        selections.pluginRefs.push({
          marketplaceId: match.selection.marketplaceId,
          pluginName: match.selection.pluginName,
        });
      }
    }
  }
  const stored = normalizePluginSelections(source.pluginSelections);
  if (
    stored.collectionIds.length > 0 ||
    (stored.mcpServerRefs?.length ?? 0) > 0 ||
    (stored.mcpHttpAuthPreferences?.length ?? 0) > 0 ||
    !isDeepStrictEqual(
      stored.skillRefs,
      normalizePluginSelections(selections).skillRefs,
    ) ||
    !isDeepStrictEqual(
      stored.pluginRefs,
      normalizePluginSelections(selections).pluginRefs,
    )
  ) {
    throw new Error('Agent plugins do not match stored source');
  }
  return {
    version: 1,
    id: source.id,
    name: source.name,
    baseModel: source.baseModel,
    instructions: source.instructions,
    plugins,
  };
}

export async function createSharedAgent(
  request: CreateSharedAgentRequest,
): Promise<SharedAgentDetail> {
  let agent = request.agent;
  if (agentResourceContextEnabled()) {
    const owner = await assertAgentShareDestination(request);
    const source = await authorizedAgentSource(request.agent.id, owner);
    agent = await authorizedAgentDocument(source, request.agent);
  }
  return requestCanopyCloudJson<SharedAgentDetail>(`${API_PREFIX}/agents`, {
    method: 'POST',
    body: JSON.stringify({
      agent,
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
  });
}

export async function updateSharedAgent(
  request: UpdateSharedAgentRequest,
): Promise<SharedAgentDetail> {
  let agent = request.agent;
  if (agentResourceContextEnabled()) {
    const current = await getSharedAgent(request.agentId);
    const owner = request.shareScope
      ? await assertAgentShareDestination(request)
      : current.owner;
    const source = await authorizedAgentSource(request.agent.id, owner);
    if (request.shareScope) {
      // Break the cycle: receipt checks use this client for remote authorization.
      const { assertAgentOwnerDestination } =
        await import('./agent-install-context');
      await assertAgentOwnerDestination(current.owner, owner);
    }
    agent = await authorizedAgentDocument(source, request.agent);
  }
  return requestCanopyCloudJson<SharedAgentDetail>(
    `${API_PREFIX}/agents/${encodeURIComponent(request.agentId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        agent,
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
        ...(request.revokePublicShare
          ? { revokePublicShare: request.revokePublicShare }
          : {}),
      }),
    },
  );
}

export async function deleteSharedAgent(
  request: DeleteSharedAgentRequest,
): Promise<void> {
  if (agentResourceContextEnabled()) await getSharedAgent(request.agentId);
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/agents/${encodeURIComponent(request.agentId)}`,
    { method: 'DELETE' },
  );
}

export async function publishAgentPublicShare(
  agentId: string,
): Promise<SharedAgentPublicShareInfo> {
  if (agentResourceContextEnabled()) await getSharedAgent(agentId);
  const response = await requestCanopyCloudJson<{
    publicShare: SharedAgentPublicShareInfo;
  }>(`${API_PREFIX}/agents/${encodeURIComponent(agentId)}/public-share`, {
    method: 'POST',
  });
  return response.publicShare;
}

export async function revokeAgentPublicShare(agentId: string): Promise<void> {
  if (agentResourceContextEnabled()) await getSharedAgent(agentId);
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/agents/${encodeURIComponent(agentId)}/public-share`,
    { method: 'DELETE' },
  );
}
