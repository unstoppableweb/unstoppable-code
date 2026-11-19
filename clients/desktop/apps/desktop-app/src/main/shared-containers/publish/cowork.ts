import type { SharedContainerStageRevisionRequest } from '@canopy/protocol/shared-containers';
import { getInstallId } from '../../lib/install-identity';
import { listWorkEntries } from '../../lib/cowork-work-entries';
import {
  commitSharedContainerRevision,
  fetchSharedContainerRevision,
  stageSharedContainerRevision,
  uploadSharedContainerArtifact,
} from '../canopy-server-client';
import { readSharedContainerFileScope } from '../file-scope-store';
import type { SharedContainerPublicationRecord } from '../publication-state';
import { validateRevisionForStage } from './artifacts';
import {
  buildCoworkPublishInventory,
  type CoworkPublishInventory,
} from './inventory';
import {
  buildCoworkRevisionArtifacts,
  type CoworkRevisionArtifact,
} from './cowork-artifacts';
import {
  publishSharedContainerRevision,
  type PublishSharedContainerRevisionDependencies,
} from './pipeline';

export { buildCoworkRevisionArtifacts };
export type { CoworkRevisionArtifact };

export function validateCoworkRevisionForStage(
  artifacts: readonly CoworkRevisionArtifact[],
  organizationId: string | undefined,
  sourceDeviceId: string,
  idempotencyKey: string,
  parentRevisionId?: string,
): Omit<SharedContainerStageRevisionRequest, 'title'> {
  return validateRevisionForStage(
    artifacts,
    organizationId,
    sourceDeviceId,
    idempotencyKey,
    parentRevisionId,
  );
}

export interface PublishCoworkRevisionDependencies {
  buildInventory: typeof buildCoworkPublishInventory;
  readScope: typeof readSharedContainerFileScope;
  stage: typeof stageSharedContainerRevision;
  upload: typeof uploadSharedContainerArtifact;
  commit: typeof commitSharedContainerRevision;
  fetchRevision?: typeof fetchSharedContainerRevision;
  readDeviceId: () => Promise<string>;
  resolveTitles?: (input: {
    projectId: string;
    worktreeId: string;
    inventory: CoworkPublishInventory;
  }) => Promise<{ publishedTitle: string; listTitle: string }>;
  prepareCapabilityPackage?: PublishSharedContainerRevisionDependencies<CoworkPublishInventory>['prepareCapabilityPackage'];
}

/**
 * Titles for a Cowork share, both taken from the Work Entry name the publisher
 * sees in their own sidebar.
 *
 * The list title is the plaintext one the server stores and the recipient reads
 * before accepting, so it is the only thing they have to decide on. A literal
 * `Work Entry` for every share made that decision impossible, which mattered
 * more than the residual disclosure: the name is scoped to named grantees in
 * the publisher's own organization, `sanitizeSharedContainerTitle` strips
 * secrets and absolute paths from it, and `shared_containers` is not in the
 * Datastream publication, so it does not leave Postgres.
 */
export async function resolveCoworkSharedContainerTitles({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}): Promise<{ publishedTitle: string; listTitle: string }> {
  const title =
    (await listWorkEntries(projectId)).find((entry) => entry.id === worktreeId)
      ?.title ?? 'Work Entry';
  return { publishedTitle: title, listTitle: title };
}

const DEFAULT_DEPENDENCIES: PublishCoworkRevisionDependencies = {
  buildInventory: buildCoworkPublishInventory,
  readScope: readSharedContainerFileScope,
  stage: stageSharedContainerRevision,
  upload: uploadSharedContainerArtifact,
  commit: commitSharedContainerRevision,
  fetchRevision: fetchSharedContainerRevision,
  readDeviceId: getInstallId,
  resolveTitles: resolveCoworkSharedContainerTitles,
  // Deferred: the package analyzer is heavy and only needed while publishing.
  prepareCapabilityPackage: async (input) => {
    const { prepareCoworkSharedContainerCapabilityPackage } =
      await import('../capability-package/prepare');
    return prepareCoworkSharedContainerCapabilityPackage(input);
  },
};

export async function publishCoworkSharedContainerRevision(
  input: {
    projectId: string;
    worktreeId: string;
    /** Absent for a personal container. */
    organizationId?: string;
    containerId: string;
  },
  deps: PublishCoworkRevisionDependencies = DEFAULT_DEPENDENCIES,
): Promise<SharedContainerPublicationRecord> {
  return publishSharedContainerRevision(
    { ...input, containerType: 'COWORK_WORK_ENTRY' },
    {
      ...deps,
      buildArtifacts: buildCoworkRevisionArtifacts,
      validateArtifacts: validateCoworkRevisionForStage,
    },
  );
}
