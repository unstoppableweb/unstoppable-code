import {
  sharedContainerPublishedLayoutHasWebPage,
  type AnySharedContainerRevisionLayout,
  type SharedContainerRevisionLayout,
} from '@canopy/protocol/shared-containers';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  commitSharedContainerRevision,
  fetchSharedContainerRevision,
  stageSharedContainerRevision,
  uploadSharedContainerArtifact,
} from '../canopy-server-client';
import { readSharedContainerFileScope } from '../file-scope-store';
import { getInstallId } from '../../lib/install-identity';
import { readWorkspaceWorktrees } from '../../lib/workspace-persistence';
import type { SharedContainerPublicationRecord } from '../publication-state';
import { buildCoworkRevisionArtifacts } from './cowork';
import {
  publishSharedContainerRevision,
  type PublishSharedContainerRevisionDependencies,
} from './pipeline';
import {
  assertCodePublishInventoryHeadsStable,
  buildCodePublishInventory,
  type CodePublishInventory,
} from './code-inventory';
import {
  createArtifactInterner,
  createOutputPathDomain,
  finalizeRevisionArtifacts,
  validateRevisionForStage,
  type RevisionArtifact,
} from './artifacts';
import { getFeatureFlagService } from '../../feature-flags';
import { isSharedContainerRunPublishingEnabled } from '../run/availability';

export function buildCodeRevisionArtifacts(
  inventory: CodePublishInventory,
  artifactIdSeed?: string,
  title = 'Shared worktree',
): RevisionArtifact[] {
  const contentDomain = createOutputPathDomain();
  for (const chat of inventory.chats) {
    contentDomain.reserve(`chats/${chat.id}.json`);
  }
  for (const note of inventory.notes) {
    contentDomain.reserve(`notes/${note.meta.id}.md`);
  }
  for (const prompt of inventory.prompts) {
    contentDomain.reserve(`prompts/${prompt.meta.id}.md`);
  }
  for (const attachment of inventory.attachments) {
    contentDomain.reserve(`attachments/${attachment.displayName}`);
  }
  for (const plan of inventory.plans) {
    contentDomain.reserve(`plans/${plan.planId}.json`);
  }
  const common = buildCoworkRevisionArtifacts(
    {
      chats: inventory.chats,
      attachments: inventory.attachments,
      notes: inventory.notes,
      prompts: inventory.prompts,
      files: [],
    },
    artifactIdSeed,
    title,
  );
  const commonLayoutArtifact = common[common.length - 1];
  if (
    commonLayoutArtifact?.path !== 'container.json' ||
    !commonLayoutArtifact.bytes
  ) {
    throw new Error(
      'Common shared-container artifacts are missing container.json',
    );
  }
  const commonLayout = JSON.parse(
    commonLayoutArtifact.bytes.toString('utf8'),
  ) as SharedContainerRevisionLayout;
  const artifacts = common.slice(0, -1);
  const intern = createArtifactInterner(artifacts, artifactIdSeed);
  for (const plan of inventory.plans) {
    intern(`plans/${plan.planId}.json`, Buffer.from(JSON.stringify(plan)));
  }
  const repoIdDomain = createOutputPathDomain();
  const repositories = inventory.repositories.map((repository) => {
    repoIdDomain.reserve(repository.repoId);
    const fileDomain = createOutputPathDomain();
    const files = repository.files.map((file) => {
      const path = fileDomain.reserve(file.path);
      if (file.status === 'deleted') {
        return { path, status: file.status, mode: file.mode };
      }
      if (!file.source) {
        throw new Error(
          `Shared-container file is missing content: ${file.path}`,
        );
      }
      const hash = file.source.hash.slice('sha256:'.length);
      const artifact = intern(
        `repos/${repository.repoId}/files/${hash}`,
        file.source,
      );
      return {
        path,
        status: file.status,
        mode: file.mode,
        artifactId: artifact.artifactId,
      };
    });
    if (repository.source === 'snapshot') {
      if (!repository.snapshot) {
        throw new Error('Snapshot repository is missing its bundle');
      }
      const bundleArtifactIds = repository.snapshot.chunks.map((chunk) => {
        if (!chunk.source) {
          throw new Error('Snapshot repository is missing bundle content');
        }
        return intern(
          `repos/${repository.repoId}/snapshot/${chunk.hash}`,
          chunk.source,
        ).artifactId;
      });
      return {
        repoId: repository.repoId,
        repoName: repository.repoName,
        source: 'snapshot' as const,
        baseCommitSha: repository.baseCommitSha,
        snapshot: {
          bundleArtifactIds,
          treeFileCount: repository.snapshot.treeFileCount,
          treeBytes: repository.snapshot.treeBytes.toString(),
        },
        files,
      };
    }
    if (!repository.remoteUrl || !repository.owner || !repository.repository) {
      throw new Error('GitHub repository is missing remote coordinates');
    }
    return {
      repoId: repository.repoId,
      repoName: repository.repoName,
      remoteUrl: repository.remoteUrl,
      owner: repository.owner,
      repository: repository.repository,
      baseCommitSha: repository.baseCommitSha,
      files,
      // Committed work is metadata only. Omit each field when the publisher
      // could not resolve it so the revision stays byte-identical to a
      // pre-CAN-2551 manifest and the recipient's optional-field reader path
      // is exercised by real revisions, not only by old ones.
      ...(repository.baseBranch ? { baseBranch: repository.baseBranch } : {}),
      ...(repository.mergeBaseSha
        ? { mergeBaseSha: repository.mergeBaseSha }
        : {}),
      ...(repository.mergeBaseSha && repository.committedFiles
        ? { committedFiles: repository.committedFiles }
        : {}),
    };
  });
  const hasSnapshot = inventory.repositories.some(
    (repository) => repository.source === 'snapshot',
  );
  const layout = {
    ...commonLayout,
    schemaVersion: sharedContainerPublishedLayoutHasWebPage(inventory.layout)
      ? 5
      : inventory.startPage
        ? 4
        : inventory.layout
          ? 3
          : hasSnapshot
            ? 2
            : 1,
    containerType: 'CODE_WORKTREE',
    repositories,
    files: [],
    ...(inventory.withheldFileCount > 0
      ? {
          withheldFileCount: inventory.withheldFileCount,
          withheldFileReasons: inventory.withheldFileReasons,
        }
      : {}),
    ...(inventory.run ? { run: inventory.run } : {}),
    ...(inventory.layout ? { layout: inventory.layout } : {}),
    ...(inventory.startPage ? { startPage: inventory.startPage } : {}),
  } as AnySharedContainerRevisionLayout;
  return finalizeRevisionArtifacts(artifacts, layout, artifactIdSeed);
}

export interface PublishCodeRevisionDependencies {
  buildInventory: typeof buildCodePublishInventory;
  readScope: typeof readSharedContainerFileScope;
  stage: typeof stageSharedContainerRevision;
  upload: typeof uploadSharedContainerArtifact;
  commit: typeof commitSharedContainerRevision;
  fetchRevision?: typeof fetchSharedContainerRevision;
  readDeviceId: () => Promise<string>;
  beforeStage: typeof assertCodePublishInventoryHeadsStable;
  disposeInventory?: (inventory: CodePublishInventory) => Promise<void>;
  resolveTitles?: (input: {
    projectId: string;
    worktreeId: string;
    inventory: CodePublishInventory;
  }) => Promise<{ publishedTitle: string; listTitle: string }>;
  prepareCapabilityPackage?: PublishSharedContainerRevisionDependencies<CodePublishInventory>['prepareCapabilityPackage'];
}

async function disposeCodePublishInventory(
  inventory: CodePublishInventory,
): Promise<void> {
  const sources = new Set(
    inventory.repositories.flatMap(
      (repository) =>
        repository.snapshot?.chunks.flatMap((chunk) =>
          chunk.source?.dispose ? [chunk.source] : [],
        ) ?? [],
    ),
  );
  await Promise.all(
    Array.from(sources, (source) => {
      if (!source.dispose) return Promise.resolve();
      return source.dispose();
    }),
  );
}

const DEFAULT_DEPENDENCIES: PublishCodeRevisionDependencies = {
  buildInventory: (input) =>
    buildCodePublishInventory({
      ...input,
      runEnabled: isSharedContainerRunPublishingEnabled(
        getFeatureFlagService().isEnabled(
          CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
        ),
      ),
    }),
  readScope: readSharedContainerFileScope,
  stage: stageSharedContainerRevision,
  upload: uploadSharedContainerArtifact,
  commit: commitSharedContainerRevision,
  fetchRevision: fetchSharedContainerRevision,
  readDeviceId: getInstallId,
  beforeStage: assertCodePublishInventoryHeadsStable,
  disposeInventory: disposeCodePublishInventory,
  resolveTitles: async ({ projectId, worktreeId }) => {
    const branchName =
      (await readWorkspaceWorktrees(projectId)).find(
        (worktree) => worktree.id === worktreeId,
      )?.branchName ?? worktreeId;
    return { publishedTitle: branchName, listTitle: branchName };
  },
  // Deferred: the package analyzer is heavy and only needed while publishing.
  prepareCapabilityPackage: async (input) => {
    const { prepareCodeSharedContainerCapabilityPackage } =
      await import('../capability-package/prepare');
    return prepareCodeSharedContainerCapabilityPackage(input);
  },
};

export async function publishCodeSharedContainerRevision(
  input: {
    projectId: string;
    worktreeId: string;
    /** Absent for a personal container. */
    organizationId?: string;
    containerId: string;
  },
  deps: PublishCodeRevisionDependencies = DEFAULT_DEPENDENCIES,
): Promise<SharedContainerPublicationRecord> {
  return publishSharedContainerRevision(
    { ...input, containerType: 'CODE_WORKTREE' },
    {
      ...deps,
      buildArtifacts: buildCodeRevisionArtifacts,
      validateArtifacts: validateRevisionForStage,
    },
  );
}
