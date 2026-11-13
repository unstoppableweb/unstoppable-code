import { createHash } from 'node:crypto';
import {
  CatalogHostRefusedError,
  type CatalogPublication,
  type CatalogPublishPackage,
} from '@canopy/core-runtime/node/catalog';
import {
  CLOUD_CUSTOM_SKILL_SOURCE_ID,
  skillEntryId,
} from '@canopy/protocol/canopy-core';
import type { PipelinePackageRef } from '@canopy/protocol/pipelines';
import type { ShareRemoteMetadata } from '@canopy/protocol/sharing';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/protocol/skills';
import {
  CanopyCloudClientError,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import type { SkillAnalysisSubject } from '../pipelines/pipeline-package-service';
import { ShareOperationError } from '../sharing/share-operation-result';
import { CUSTOM_SOURCE_ID } from './paths';

/** What a skill publish calls; tests inject fakes. Defaults load lazily. */
export interface PublishSkillDeps {
  /** The installed skills, each with its author-side link. */
  loadSkills: () => Promise<readonly InstalledSkillInfo[]>;
  readRawSkill: (localId: string) => Promise<string>;
  /**
   * The skill a live analysis covered and the content hash it was made over;
   * null once expired or for a pipeline analysis.
   */
  analysisSubject: (analysisId: string) => Promise<SkillAnalysisSubject | null>;
  /**
   * The signed-in account and its credentials, resolved once per publish so
   * every request lands in the account the person consented under; throws
   * `missing-api-key` when signed out.
   */
  credentials: () => Promise<{
    accountId: string;
    context: CanopyCloudCredentialContext;
  }>;
  commitPackage: (
    pkg: CatalogPublishPackage,
    context: CanopyCloudCredentialContext,
  ) => Promise<{
    capabilityPackage: PipelinePackageRef;
    committedPackageUploadId: string;
  }>;
  createSharedSkill: (
    request: {
      sourceSkillId: string;
      rawSkill: string;
      shareScope: 'private';
      capabilityPackage: PipelinePackageRef;
      committedPackageUploadId: string;
      expectedSourceSha256: string;
    },
    context: CanopyCloudCredentialContext,
  ) => Promise<SharedSkillDetail>;
  updateSharedSkill: (
    request: {
      sourceSkillId: string;
      skillId: string;
      rawSkill: string;
      expectedContentHash: string;
      capabilityPackage: PipelinePackageRef;
      committedPackageUploadId: string;
      expectedSourceSha256: string;
    },
    context: CanopyCloudCredentialContext,
  ) => Promise<SharedSkillDetail>;
  writeLink: (localId: string, remote: ShareRemoteMetadata) => Promise<void>;
}

const defaultDeps: PublishSkillDeps = {
  loadSkills: async () => {
    const { loadSkills } = await import('./skill-service');
    const { filterStoredSkillContexts } =
      await import('./skill-install-context');
    const loaded = loadSkills();
    return loaded.success && loaded.data
      ? filterStoredSkillContexts(loaded.data)
      : [];
  },
  readRawSkill: async (localId) =>
    (await import('./skill-service')).readRawSkill(localId),
  analysisSubject: async (analysisId) =>
    (
      await import('../pipelines/pipeline-package-service')
    ).skillAnalysisSubject(analysisId),
  credentials: async () => {
    const { resolveCanopyCloudCredentialContext } =
      await import('../canopy-cloud/client');
    const context = await resolveCanopyCloudCredentialContext();
    const accountId = context.apiKey ? context.account?.id.trim() : undefined;
    if (!accountId)
      throw new CanopyCloudClientError(
        'missing-api-key',
        'Sign in to add skills to the cloud.',
      );
    return { accountId, context };
  },
  commitPackage: async (pkg, context) => {
    const { assertSharedSkillsSupported } =
      await import('./canopy-server-client');
    await assertSharedSkillsSupported(context);
    return (
      await import('../pipelines/pipeline-package-service')
    ).createSubjectCapabilityPackage(
      {
        analysisId: pkg.analysisId,
        selectedOptionalResourceIds: [...pkg.selectedOptionalResourceIds],
      },
      undefined,
      context,
    );
  },
  createSharedSkill: async (request, context) =>
    (await import('./canopy-server-client')).createSharedSkill(
      request,
      context,
    ),
  updateSharedSkill: async (request, context) =>
    (await import('./canopy-server-client')).updateSharedSkill(
      request,
      context,
    ),
  writeLink: async (localId, remote) =>
    (await import('./skill-service')).writeSkillRemoteMetadata(localId, remote),
};

const CUSTOM_PREFIX = `skill:${CUSTOM_SOURCE_ID}/`;

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

function cloudRefusal(error: unknown): CatalogHostRefusedError {
  return new CatalogHostRefusedError(
    // The package commit and the share client refuse an expired, blocked or
    // outdated analysis, or a SKILL.md edited since the check, locally.
    error instanceof ShareOperationError && error.kind === 'dependency-review'
      ? 'publish-package-stale'
      : error instanceof CanopyCloudClientError && error.status === 409
        ? 'publish-revision-moved'
        : 'publish-remote-unavailable',
    error,
  );
}

/**
 * Publishes a custom skill as the account's cloud copy (CAN-6176, D6 to D8).
 * Only the local SKILL.md and the package the person consented to travel:
 * the analysis must have covered this skill and been made over its file as it
 * is now, so another skill's analysis or a skill edited after the consent
 * dialog answers `publish-package-stale` and nothing uploads. A linked copy is updated in its existing scope against the hash it
 * was last published with, so a copy changed elsewhere answers 409.
 */
export async function publishSkillToCloud(
  entryId: string,
  pkg: CatalogPublishPackage,
  deps: PublishSkillDeps = defaultDeps,
): Promise<CatalogPublication> {
  if (!entryId.startsWith(CUSTOM_PREFIX))
    throw new CatalogHostRefusedError('publish-source-unsupported');
  const skillName = entryId.slice(CUSTOM_PREFIX.length);
  const skill = (await deps.loadSkills()).find(
    (candidate) =>
      candidate.sourceId === CUSTOM_SOURCE_ID && candidate.name === skillName,
  );
  if (skill === undefined)
    throw new CatalogHostRefusedError('publish-entry-not-found');
  const localId = `${CUSTOM_SOURCE_ID}/${skillName}`;
  const rawSkill = await deps.readRawSkill(localId);
  const checked = sha256(rawSkill);
  const analysed = await deps.analysisSubject(pkg.analysisId);
  if (
    analysed?.sourceId !== CUSTOM_SOURCE_ID ||
    analysed.skillName !== skillName ||
    analysed.contentHash !== checked
  )
    throw new CatalogHostRefusedError('publish-package-stale');

  let accountId: string;
  let detail: SharedSkillDetail;
  try {
    // Every request below uses this one context, so an account switch
    // mid-publish cannot split the copy and its link across accounts.
    const credentials = await deps.credentials();
    accountId = credentials.accountId;
    const committed = await deps.commitPackage(pkg, credentials.context);
    // Only an author link of this account is a copy to update.
    const link =
      skill.remote !== undefined && skill.remote.accountId === accountId
        ? skill.remote
        : undefined;
    const create = (): Promise<SharedSkillDetail> =>
      deps.createSharedSkill(
        {
          sourceSkillId: localId,
          rawSkill,
          shareScope: 'private',
          ...committed,
          expectedSourceSha256: checked,
        },
        credentials.context,
      );
    try {
      detail =
        link === undefined
          ? await create()
          : await deps.updateSharedSkill(
              {
                sourceSkillId: localId,
                skillId: link.remoteId,
                rawSkill,
                expectedContentHash: link.contentHash,
                ...committed,
                expectedSourceSha256: checked,
              },
              credentials.context,
            );
    } catch (error) {
      // The linked copy was deleted in the cloud: start a new private one.
      if (
        link === undefined ||
        !(error instanceof CanopyCloudClientError && error.status === 404)
      )
        throw error;
      // A 404 after an account switch means "not this account's", not
      // "deleted": a new copy would fork the skill.
      if ((await deps.credentials()).accountId !== accountId) throw error;
      detail = await create();
    }
  } catch (error) {
    throw cloudRefusal(error);
  }
  // Creation is content-addressed and can return another publisher's row;
  // only a row this account can update is an author link.
  if (detail.canUpdate)
    await deps.writeLink(localId, {
      accountId,
      remoteId: detail.id,
      contentHash: detail.contentHash,
      shareScope: detail.shareScope,
      sharedAt: detail.updatedAt,
    });
  return {
    publicationId: detail.id,
    remoteEntryId: skillEntryId({
      sourceId: CLOUD_CUSTOM_SKILL_SOURCE_ID,
      skillName: detail.id,
    }),
    revision: detail.contentHash,
  };
}
