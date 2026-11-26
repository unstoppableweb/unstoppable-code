import { getSharedCollection } from '../collections/canopy-server-client';
import { getSharedPlugin } from '../plugins/canopy-server-client';
import { agentResourceContextEnabled } from '../agents/resource-lanes';
import { getSharedAgent } from '../agents/canopy-server-client';
import { withPackageVersionNegotiation } from './package-version-negotiation';
import { skillResourceContextEnabled } from '../skills/resource-lanes';
import { getSharedPipeline } from '../pipelines/canopy-server-client';
import { pipelineResourceContextEnabled } from '../pipelines/resource-lanes';
import { createHash } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import {
  PIPELINE_PACKAGE_VERSION_HEADER,
  publicShareSnapshotApiPath,
  type PipelineDistributionMode,
  type PublicPipelineShareSnapshot,
  type PublicPluginShareSnapshot,
  type PublicSkillShareSnapshot,
  type PublicAgentShareSnapshot,
  type PublicAutomationShareSnapshot,
  type PublicWorkspaceTemplateShareSnapshot,
  type PublicCollectionShareSnapshot,
  type SharedPipelineDetail,
  type SharedSkillDetail,
  type ScopedShareProvenance,
} from '@canopy/protocol';
import { isResourceOwner } from '@canopy/protocol/resource-owner';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  requestCanopyCloudPublicJson,
} from './client';

function isNotFound(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    error.code === 'http-error' &&
    error.status === 404
  );
}

function scopedResourcePath(
  entity: 'skills' | 'pipelines',
  id: string,
): string {
  return `/api/v1/${BRAND.web.apiNamespace}/${entity}/${encodeURIComponent(id)}`;
}

function requireScopedShare(
  scope: string | undefined,
): asserts scope is ScopedShareProvenance['shareScope'] {
  if (scope === 'team' || scope === 'organization') return;
  throw new CanopyCloudClientError('http-error', 'Share not found', 404);
}

/**
 * Anonymous pinned-snapshot reads behind the desktop deep-link landing view
 * (CAN-2361). These hit the web public-share resolve endpoints without
 * credentials, so a signed-out desktop can still render exactly what the
 * public `/share/*` page showed. Errors surface as `CanopyCloudClientError`
 * (`http-error` with status 404 for unavailable shares). After a public 404,
 * eligible scoped reads preserve their own failure, including authorization,
 * policy denial and transport errors; a 404 alone does not prove revocation.
 */
export async function getPublicSkillShareSnapshot(
  externalId: string,
): Promise<PublicSkillShareSnapshot> {
  const path = publicShareSnapshotApiPath(
    BRAND.web.apiNamespace,
    'skill',
    externalId,
  );
  try {
    // A packaged skill is read exactly like a packaged pipeline, so this is
    // version-negotiated for the same reason: it is the primary recipient path
    // for a public skill link, and an un-negotiated read fails outright against
    // a web deploy older than this client.
    return await withPackageVersionNegotiation((version) =>
      requestCanopyCloudPublicJson<PublicSkillShareSnapshot>(path, {
        headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) },
      }),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return getScopedSkillShareSnapshot(externalId);
  }
}

/** Scoped handoffs never depend on or fall back to a public publication. */
export async function getScopedSkillShareSnapshot(
  externalId: string,
): Promise<PublicSkillShareSnapshot> {
  // Negotiated like the public read. Without the header the skills route
  // serves the definition-only projection, so forwarding `package` below
  // would forward nothing and a packaged team skill would still install
  // without its files.
  const skill = skillResourceContextEnabled()
    ? await (
        await import('../skills/canopy-server-client')
      ).getSharedSkill(externalId)
    : await withPackageVersionNegotiation((version) =>
        requestCanopyCloudJson<SharedSkillDetail>(
          scopedResourcePath('skills', externalId),
          {
            headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) },
          },
        ),
      );
  const shareScope = skill.shareScope;
  requireScopedShare(shareScope);
  return {
    ...(skillResourceContextEnabled() ? { sourceRemoteId: skill.id } : {}),
    entity: 'skill',
    externalId: skill.id,
    name: skill.name,
    description: skill.description,
    rawSkill: skill.rawSkill,
    contentHash: skill.contentHash,
    dependencies: [],
    // Forwarded rather than dropped: omitting these means definition-only
    // by the snapshot type's own contract, so a packaged skill reached
    // through this path would silently lose its files.
    distributionMode: skill.distributionMode,
    package: skill.package,
    // This package hangs off the skill, not a public share, so the install
    // must not read it through the public endpoints.
    scopedShare: true,
    authorUsername: null,
    // Older servers sent a team owner without its organization; the review
    // falls back rather than describe provenance it cannot read.
    ...(isResourceOwner(skill.owner)
      ? {
          sharedBy: {
            name: skill.createdBy.name,
            owner: skill.owner,
            shareScope,
          },
        }
      : {}),
    updatedAt: skill.updatedAt,
  };
}

/**
 * Install pin forwarded verbatim from the reviewed `/share/pipelines/{id}`
 * page (see `parseDesktopShareDeepLink`). The web resolve compares it against
 * the live share row and answers `409 pipeline_share_changed` when the share
 * was republished between review and install, so the desktop can never follow
 * a link to content the recipient did not see.
 */
export interface PublicPipelineSharePin {
  expectedPipelineContentHash?: string;
  expectedDistributionMode?: PipelineDistributionMode;
  expectedPackageDigest?: string;
}

export async function getPublicPipelineShareSnapshot(
  externalId: string,
  pin?: PublicPipelineSharePin,
): Promise<PublicPipelineShareSnapshot> {
  const query = new URLSearchParams();
  if (pin?.expectedPipelineContentHash !== undefined)
    query.set('expectedPipelineContentHash', pin.expectedPipelineContentHash);
  if (pin?.expectedDistributionMode !== undefined)
    query.set('expectedDistributionMode', pin.expectedDistributionMode);
  if (pin?.expectedPackageDigest !== undefined)
    query.set('expectedPackageDigest', pin.expectedPackageDigest);
  const path = publicShareSnapshotApiPath(
    BRAND.web.apiNamespace,
    'pipeline',
    externalId,
  );
  try {
    const requestSnapshot = (
      version: number,
    ): Promise<PublicPipelineShareSnapshot> =>
      requestCanopyCloudPublicJson<PublicPipelineShareSnapshot>(
        query.size > 0 ? `${path}?${query.toString()}` : path,
        {
          headers: {
            [PIPELINE_PACKAGE_VERSION_HEADER]: String(version),
          },
        },
      );
    return await withPackageVersionNegotiation(requestSnapshot);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const pipeline = pipelineResourceContextEnabled()
      ? await getSharedPipeline(externalId)
      : await requestCanopyCloudJson<SharedPipelineDetail>(
          scopedResourcePath('pipelines', externalId),
        );
    requireScopedShare(pipeline.shareScope);
    return {
      entity: 'pipeline',
      ...(pipelineResourceContextEnabled()
        ? {
            sourceRemoteId: pipeline.id,
            distributionMode: pipeline.distributionMode ?? 'definition_only',
            ...(pipeline.package ? { package: pipeline.package } : {}),
          }
        : {}),
      externalId: pipeline.id,
      name: pipeline.name,
      description: pipeline.description,
      rawPipeline: pipeline.rawPipeline,
      contentHash: createHash('sha256')
        .update(pipeline.rawPipeline)
        .digest('hex'),
      authorUsername: null,
      updatedAt: pipeline.updatedAt,
    };
  }
}

export async function getPublicPluginShareSnapshot(
  externalId: string,
): Promise<PublicPluginShareSnapshot> {
  return requestCanopyCloudPublicJson<PublicPluginShareSnapshot>(
    publicShareSnapshotApiPath(BRAND.web.apiNamespace, 'plugin', externalId),
  );
}

export async function getPublicCollectionShareSnapshot(
  externalId: string,
  signal?: AbortSignal,
): Promise<PublicCollectionShareSnapshot> {
  const path = publicShareSnapshotApiPath(
    BRAND.web.apiNamespace,
    'collection',
    externalId,
  );
  return withPackageVersionNegotiation((version) =>
    requestCanopyCloudPublicJson<PublicCollectionShareSnapshot>(path, {
      headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) },
      ...(signal ? { signal } : {}),
    }),
  );
}

export async function getPublicAgentShareSnapshot(
  externalId: string,
): Promise<PublicAgentShareSnapshot> {
  const path = publicShareSnapshotApiPath(
    BRAND.web.apiNamespace,
    'agent',
    externalId,
  );
  try {
    return await withPackageVersionNegotiation((version) =>
      requestCanopyCloudPublicJson<PublicAgentShareSnapshot>(path, {
        headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) },
      }),
    );
  } catch (error) {
    if (!agentResourceContextEnabled() || !isNotFound(error)) throw error;
    return getScopedAgentShareSnapshot(externalId);
  }
}

/** Scoped handoffs never depend on or fall back to a public publication. */
export async function getScopedAgentShareSnapshot(
  externalId: string,
): Promise<PublicAgentShareSnapshot> {
  const detail = await getSharedAgent(externalId);
  requireScopedShare(detail.shareScope);
  return {
    entity: 'agent',
    externalId: detail.id,
    sourceRemoteId: detail.id,
    agent: detail.agent,
    contentHash: detail.contentHash,
    // Forwarded so the landing reviews the package the scoped install brings.
    distributionMode: detail.distributionMode,
    package: detail.package,
    authorUsername: null,
    updatedAt: detail.updatedAt,
  };
}

export async function getPublicAutomationShareSnapshot(
  externalId: string,
  expectedAutomationContentHash?: string,
): Promise<PublicAutomationShareSnapshot> {
  const path = publicShareSnapshotApiPath(
    BRAND.web.apiNamespace,
    'automation',
    externalId,
  );
  // The header goes on every read, not just the pinned one. Gating version
  // negotiation on an unrelated pin parameter made the pinned branch — the one
  // an older web deploy rejects — the only branch without a downgrade path.
  const query = new URLSearchParams();
  if (expectedAutomationContentHash !== undefined) {
    query.set('expectedAutomationContentHash', expectedAutomationContentHash);
  }
  const url = query.size > 0 ? `${path}?${query.toString()}` : path;
  return withPackageVersionNegotiation((version) =>
    requestCanopyCloudPublicJson<PublicAutomationShareSnapshot>(url, {
      headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) },
    }),
  );
}

export async function getPublicWorkspaceTemplateSnapshot(
  externalId: string,
  expectedWorkspaceTemplateContentHash?: string,
): Promise<PublicWorkspaceTemplateShareSnapshot> {
  const path = publicShareSnapshotApiPath(
    BRAND.web.apiNamespace,
    'workspace',
    externalId,
  );
  const query = new URLSearchParams();
  if (expectedWorkspaceTemplateContentHash !== undefined) {
    query.set(
      'expectedWorkspaceTemplateContentHash',
      expectedWorkspaceTemplateContentHash,
    );
  }
  // Negotiated like the other package-bearing snapshots. Without the header
  // the route serves the definition-only projection, so a packaged Blueprint
  // (or its per-skill packages) would never reach the install.
  try {
    return await withPackageVersionNegotiation((version) =>
      requestCanopyCloudPublicJson<PublicWorkspaceTemplateShareSnapshot>(
        query.size > 0 ? `${path}?${query.toString()}` : path,
        { headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) } },
      ),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return withPackageVersionNegotiation((version) =>
      requestCanopyCloudJson<PublicWorkspaceTemplateShareSnapshot>(
        `/api/v1/${BRAND.web.apiNamespace}/workspace-template-shares/${encodeURIComponent(externalId)}${query.size > 0 ? `?${query.toString()}` : ''}`,
        { headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) } },
      ),
    );
  }
}

/** Scoped handoffs never depend on or fall back to a public publication. */
export async function getScopedPluginShareSnapshot(
  externalId: string,
): Promise<PublicPluginShareSnapshot> {
  const detail = await getSharedPlugin(externalId);
  const shareScope = detail.shareScope;
  requireScopedShare(shareScope);
  return {
    entity: 'plugin',
    externalId: detail.externalId,
    name: detail.name,
    description: detail.description,
    ref: detail.ref,
    refKey: detail.refKey,
    marketplaceOrigin: detail.marketplaceOrigin,
    authorUsername: null,
    // Older servers sent a team owner without its organization; the review
    // falls back rather than describe provenance it cannot read.
    ...(isResourceOwner(detail.owner)
      ? {
          sharedBy: {
            name: detail.createdBy.name,
            owner: detail.owner,
            shareScope,
          },
        }
      : {}),
    updatedAt: detail.updatedAt,
  };
}

export async function getScopedCollectionShareSnapshot(
  externalId: string,
): Promise<PublicCollectionShareSnapshot> {
  const detail = await getSharedCollection(externalId);
  requireScopedShare(detail.shareScope);
  return {
    entity: 'collection',
    externalId: detail.id,
    collection: detail.collection,
    contentHash: detail.contentHash,
    itemCounts: detail.itemCounts,
    customSkills: detail.customSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      rawSkill: skill.rawSkill,
      contentHash: skill.contentHash,
    })),
    distributionMode: detail.distributionMode,
    ...(detail.package ? { package: detail.package } : {}),
    authorUsername: null,
    updatedAt: detail.updatedAt,
  };
}
