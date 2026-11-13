import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  assertForkWorkspaceOwner,
  assertNewForkOwner,
  validateForkDestination,
} from './destination';
import {
  assertForkWorkspaceUnbound,
  assertOrganizationForkEligible,
  bindForkCodeWorkspaceToOrganization,
  organizationForkError,
  releaseForkOrganizationBinding,
  toOrganizationForkFailure,
} from './org-destination';
import { chmod, mkdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type {
  SharedContainerForkProvenance,
  SharedContainerForkRequest,
  SharedContainerForkResponse,
  SharedContainerRevisionSnapshotRepository,
  SharedContainerStartPage,
  AnySharedContainerRevisionLayout,
} from '@canopy/protocol/shared-containers';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import { MAX_SHARED_CONTAINER_ARTIFACT_BYTES } from '@canopy/protocol/shared-containers';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import {
  classifySharedContainerSymlinkTarget,
  decodeUtf8SymlinkTarget,
  deleteBranchIfMatches,
  getRemoteUrl,
  materializeGitCommitRaw,
  resolveRefSha,
} from '../../lib/git';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
} from '../../lib/worktree-service';
import { findOrCreateSingleRepoWorkspaceForRepo } from '../../lib/workspace-service';
import { createWorkspace } from '../../lib/workspace-creation';
import { addWorkspaceRepository } from '../../lib/workspace-repositories';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { deleteWorkspaceById } from '../../lib/workspace-deletion';
import { remoteUrlsMatch } from '../../lib/repo-url-matcher';
import {
  getDefaultReposDir,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
} from '../../lib/paths';
import { ensureUniqueDestination } from '../../lib/unique-destination';
import {
  resolveMaterializedPath,
  validateMaterializedRelativePath,
} from '../materialize/path-safety';
import type { SharedContainerReplicaStore } from '../replica/store';
import { copySharedContainerTree } from './copy-tree';
import {
  copyForkAttachments,
  rehydrateForkChats,
  resolveSafeForkDestination,
} from './finalize';
import {
  deleteForkWorkspaceOrHide,
  runWithSharedContainerForkRollback,
} from './rollback';
import type { SharedContainerForkRollback } from './rollback';
import { writeForkProvenanceForDestination } from './provenance';
import { recordSharedContainerForkStartPage } from './fork-metadata';
import type { W5CommitOptions } from '../../lib/w5-commit-scope';
import type { W5KeyedAttempt } from '../../lib/w5-keyed-operation';

interface ResolvedCodeDestination {
  workspace: Exclude<SidebarItem, { type: 'cowork' }>;
  repoIds: Map<string, string>;
  createdWorkspace: boolean;
  promotedPaths: string[];
}

type SharedContainerCodeLayout = AnySharedContainerRevisionLayout;

export function mapCodeForkStartPage(
  startPage: SharedContainerStartPage,
  repoIds: ReadonlyMap<string, string>,
  destinationType: 'single-repo' | 'multi-repo',
): ProjectStartPage | undefined {
  if (startPage.kind === 'url') return startPage;
  const repoId = repoIds.get(startPage.repoId);
  if (!repoId) return undefined;
  return destinationType === 'single-repo'
    ? { kind: 'file', path: startPage.relativePath }
    : { kind: 'file', repoId, path: startPage.relativePath };
}

function isSnapshotRepository(
  repository: SharedContainerCodeLayout['repositories'][number],
): repository is SharedContainerRevisionSnapshotRepository {
  return 'source' in repository && repository.source === 'snapshot';
}

function safeRepositoryFolderName(name: string): string {
  const candidate = basename(name.trim());
  if (
    candidate !== name.trim() ||
    validateMaterializedRelativePath(candidate).includes('/')
  ) {
    throw new Error('Shared-container repository name is not portable');
  }
  return candidate;
}

async function matchExistingWorkspace(
  layout: SharedContainerCodeLayout,
  workspaceId: string,
  owner: WorkspaceContext,
  readOnly = false,
): Promise<ResolvedCodeDestination> {
  const workspace = (
    await readAllSidebarItems(
      readOnly ? { persistRemovalCleanup: false } : undefined,
    )
  ).items.find((item) => item.id === workspaceId);
  if (!workspace || workspace.type === 'cowork') {
    throw new Error('Fork destination must be a git-backed workspace');
  }
  await assertForkWorkspaceOwner(workspace.id, owner);
  const repoIds = new Map<string, string>();
  if (workspace.type === 'single-repo') {
    const repository = layout.repositories[0];
    const remote = await getRemoteUrl(workspace.repoPath);
    if (
      layout.repositories.length !== 1 ||
      !repository ||
      isSnapshotRepository(repository) ||
      !remote ||
      !remoteUrlsMatch(remote, repository.remoteUrl)
    ) {
      throw new Error(
        'Fork destination does not contain the shared repository',
      );
    }
    repoIds.set(repository.repoId, workspace.id);
    return {
      workspace,
      repoIds,
      createdWorkspace: false,
      promotedPaths: [],
    };
  }

  const unused = new Set(workspace.repos.map((repo) => repo.id));
  for (const repository of layout.repositories) {
    if (isSnapshotRepository(repository)) {
      throw new Error(
        'Snapshot repositories must be forked into a new workspace',
      );
    }
    let matched: (typeof workspace.repos)[number] | undefined;
    for (const candidate of workspace.repos) {
      if (!unused.has(candidate.id)) continue;
      const remote = await getRemoteUrl(candidate.repoPath);
      if (remote && remoteUrlsMatch(remote, repository.remoteUrl)) {
        matched = candidate;
        break;
      }
    }
    if (!matched) {
      throw new Error(
        `Fork destination is missing repository ${repository.repoName}`,
      );
    }
    unused.delete(matched.id);
    repoIds.set(repository.repoId, matched.id);
  }
  return {
    workspace,
    repoIds,
    createdWorkspace: false,
    promotedPaths: [],
  };
}

async function createWorkspaceFromReplica(options: {
  request: SharedContainerForkRequest;
  owner: WorkspaceContext;
  organizationName?: string;
  layout: SharedContainerCodeLayout;
  revisionRoot: string;
  parentDirectory?: string;
  rollback: SharedContainerForkRollback;
  commit?: W5CommitOptions;
  attempt?: W5KeyedAttempt;
}): Promise<ResolvedCodeDestination> {
  const parentDirectory = options.parentDirectory ?? getDefaultReposDir();
  if (!isAbsolute(parentDirectory)) {
    throw new Error('Fork clone parent directory must be absolute');
  }
  options.attempt?.beforeEffects();
  await mkdir(parentDirectory, { recursive: true });
  const promotedPaths: string[] = [];
  let createdWorkspaceId: string | undefined;
  for (const repository of options.layout.repositories) {
    const destination = await ensureUniqueDestination(
      parentDirectory,
      safeRepositoryFolderName(repository.repoName),
    );
    await copySharedContainerTree(
      join(options.revisionRoot, 'repos', repository.repoId),
      destination,
    );
    promotedPaths.push(destination);
    options.rollback.defer(async () => {
      // Keep a checkout any remaining workspace still points at: this fork's
      // own, when its cleanup failed, or one a creator bound to it.
      if (
        (await readAllSidebarItems()).items.some(
          (item) =>
            item.id === createdWorkspaceId ||
            (item.type === 'single-repo' && item.repoPath === destination) ||
            (item.type === 'multi-repo' &&
              (item.sourceRepoPath === destination ||
                item.repos.some((repo) => repo.repoPath === destination))),
        )
      ) {
        throw new Error(
          `Preserved promoted repository after workspace cleanup failed: ${destination}`,
        );
      }
      await rm(destination, { recursive: true, force: true });
    });
    // Replica materialization includes the published overlay. The promoted
    // checkout becomes the workspace's source repository, so restore its raw
    // base tree before the overlay is replayed into the new worktree below.
    await materializeGitCommitRaw(destination, repository.baseCommitSha, {
      allowPromisorFetch: false,
      resolveDestination: (relativePath) =>
        resolveMaterializedPath(
          destination,
          validateMaterializedRelativePath(relativePath),
        ),
    });
  }

  if (options.layout.repositories.length === 1) {
    const repository = options.layout.repositories[0];
    const promotedPath = promotedPaths[0];
    if (!repository || !promotedPath) {
      throw new Error('Code fork has no repository');
    }
    const result = await findOrCreateSingleRepoWorkspaceForRepo(
      promotedPath,
      options.layout.title,
      { commit: options.commit },
    );
    if (!result.created) {
      throw new Error('Fork promotion unexpectedly reused a workspace');
    }
    createdWorkspaceId = result.workspace.id;
    options.rollback.defer(async () => {
      if (options.owner.kind === 'organization')
        await assertForkWorkspaceUnbound(result.workspace.id);
      await deleteForkWorkspaceOrHide(
        { source: 'code_fork', workspaceId: result.workspace.id },
        () => deleteWorkspaceById(result.workspace.id, 'shared_container_fork'),
      );
    });
    if (options.owner.kind === 'organization') {
      // Registered before binding: a creator can bind and then fail.
      options.rollback.defer(() =>
        releaseForkOrganizationBinding(result.workspace.id),
      );
      await bindForkCodeWorkspaceToOrganization({
        owner: options.owner,
        organizationName: options.organizationName,
        workspaceId: result.workspace.id,
        checkoutPath: promotedPath,
        containerId: options.request.containerId,
        revisionId: options.request.revisionId,
        title: options.layout.title,
        fallbackName: repository.repoName,
        ...(isSnapshotRepository(repository)
          ? {}
          : { remoteUrl: repository.remoteUrl }),
      });
    }
    return {
      workspace: result.workspace,
      repoIds: new Map([[repository.repoId, result.workspace.id]]),
      createdWorkspace: true,
      promotedPaths,
    };
  }

  if (options.owner.kind === 'organization') {
    // Refused before promotion; never stage a Personal multi-repo copy.
    throw organizationForkError(
      'organization-shape-unsupported',
      options.organizationName,
    );
  }
  const { workspace } = await createWorkspace(
    {
      source: 'shared_container_fork',
      variant: { kind: 'new-multi-repo', name: options.layout.title },
    },
    options.commit,
  );
  if (workspace.type !== 'multi-repo') {
    throw new Error('Created project was persisted with an unexpected type');
  }
  createdWorkspaceId = workspace.id;
  options.rollback.defer(async () => {
    await deleteForkWorkspaceOrHide(
      { source: 'code_fork', workspaceId: workspace.id },
      () => deleteWorkspaceById(workspace.id, 'shared_container_fork'),
    );
  });
  const repoIds = new Map<string, string>();
  for (let index = 0; index < options.layout.repositories.length; index += 1) {
    const repository = options.layout.repositories[index];
    if (!repository) throw new Error('Promoted repository metadata is missing');
    const promotedPath = promotedPaths[index];
    if (!promotedPath) throw new Error('Promoted repository is missing');
    const local = await addWorkspaceRepository(
      {
        workspaceId: workspace.id,
        source: 'shared_container_fork',
        repository: {
          id: repository.repoId,
          name: repository.repoName,
          repoPath: promotedPath,
        },
      },
      options.commit,
    );
    repoIds.set(repository.repoId, local.id);
    workspace.repos.push(local);
  }
  return {
    workspace,
    repoIds,
    createdWorkspace: true,
    promotedPaths,
  };
}

async function createDestinationWorktree(
  destination: ResolvedCodeDestination,
  layout: SharedContainerCodeLayout,
  commit?: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<{ id: string }> {
  const common = {
    w5BoundaryCommit: commit,
    w5BoundaryAttempt: attempt,
    workspaceId: destination.workspace.id,
    existingWorktreeIds: destination.workspace.worktrees.map((item) => item.id),
    allowBaseBranchNetwork: !destination.createdWorkspace,
  };
  if (destination.workspace.type === 'single-repo') {
    return createSingleRepoWorktree({
      ...common,
      baseBranch: layout.repositories[0]?.baseCommitSha,
    });
  }
  const response = await createMultiRepoWorktree({
    ...common,
    baseBranchesByRepo: Object.fromEntries(
      layout.repositories.map((repository) => {
        const localRepoId = destination.repoIds.get(repository.repoId);
        if (!localRepoId) {
          throw new Error('Fork repository mapping is incomplete');
        }
        return [localRepoId, repository.baseCommitSha];
      }),
    ),
    surfaceNeedsRepairInResponse: true,
  });
  if (response.needsRepair === true) {
    const referenceRepoPath = destination.workspace.sourceRepoPath;
    const expectedBranchTip = referenceRepoPath
      ? await resolveRefSha(
          referenceRepoPath,
          `refs/heads/${response.branchName}`,
        )
      : null;
    await archiveMultiRepoWorktree({
      archiveTrigger: 'internal-rollback',
      workspaceId: destination.workspace.id,
      worktreeId: response.id,
      expectedCreatedAt: response.createdAt,
      allowMissingRow: true,
      expectedBranchName: response.branchName,
      retainAsArchivedContainer: false,
      // createMultiRepoWorktree has already removed its reservation, so the
      // archive path cannot persist the journal required by branch deletion.
      deleteBranch: false,
    });
    if (referenceRepoPath && expectedBranchTip) {
      await deleteBranchIfMatches(
        referenceRepoPath,
        response.branchName,
        expectedBranchTip,
      );
    }
    throw new Error('Fork destination workspace root requires repair');
  }
  return response;
}

export async function replaySharedContainerOverlay(options: {
  store: SharedContainerReplicaStore;
  revisionRoot: string;
  layout: SharedContainerCodeLayout;
  workspaceId: string;
  worktreeId: string;
  repoIds: ReadonlyMap<string, string>;
  singleRepo: boolean;
}): Promise<void> {
  for (const repository of options.layout.repositories) {
    const localRepoId = options.repoIds.get(repository.repoId);
    if (!localRepoId) throw new Error('Fork repository mapping is incomplete');
    const destinationRoot = options.singleRepo
      ? getWorkspaceWorktreeDir(options.workspaceId, options.worktreeId)
      : getWorkspaceWorktreeRepoDir(
          options.workspaceId,
          options.worktreeId,
          localRepoId,
        );
    const files = repository.files.map((file) => ({
      file,
      relative: validateMaterializedRelativePath(file.path),
    }));
    const deletions = files
      .filter(({ file }) => file.status === 'deleted')
      .sort(
        (left, right) =>
          right.relative.split('/').length - left.relative.split('/').length,
      );
    for (const { relative } of deletions) {
      const target = await resolveSafeForkDestination(
        destinationRoot,
        relative,
      );
      await rm(target, { force: true });
      const parentSegments = relative.split('/').slice(0, -1);
      while (parentSegments.length > 0) {
        const parent = resolveMaterializedPath(
          destinationRoot,
          parentSegments.join('/'),
        );
        try {
          await rmdir(parent);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            parentSegments.pop();
            continue;
          }
          if (code === 'ENOTEMPTY' || code === 'EEXIST') break;
          throw error;
        }
        parentSegments.pop();
      }
    }
    for (const { file, relative } of files) {
      if (file.status === 'deleted') continue;
      const target = await resolveSafeForkDestination(
        destinationRoot,
        relative,
      );
      const source = options.store.resolvePathBelowForRead(
        options.revisionRoot,
        'repos',
        repository.repoId,
        relative,
      );
      // A `120000` entry is stored in the replica as a real symlink, not as a
      // file holding its target text, and the reader refuses to follow one
      // (`O_NOFOLLOW`). Reading it as bytes fails outright, so the link is
      // read and recreated the way materialization does, with the same
      // classification: an escaping or oversized target is skipped rather
      // than written.
      if (file.mode === '120000') {
        const linkTarget = decodeUtf8SymlinkTarget(
          await options.store.readLinkTargetForRead(
            options.revisionRoot,
            source,
          ),
          `Shared-container fork rejects non-UTF-8 symlink target: ${relative}`,
        );
        if (
          classifySharedContainerSymlinkTarget(relative, linkTarget) !==
          'in-repository'
        ) {
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { force: true, recursive: true });
        await symlink(linkTarget, target);
        continue;
      }
      const bytes = await options.store.readBoundedFileForRead(
        options.revisionRoot,
        source,
        MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
      );
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { force: true });
      const executable = file.mode === '100755';
      await writeFile(target, bytes, {
        flag: 'wx',
        mode: executable ? 0o700 : 0o600,
      });
      await chmod(target, executable ? 0o700 : 0o600);
    }
  }
}

export async function forkSharedCodeContainer(options: {
  request: SharedContainerForkRequest;
  owner: WorkspaceContext;
  /** The owning organization's display name, for refusals. */
  organizationName?: string;
  provenance: SharedContainerForkProvenance;
  revisionRoot: string;
  layout: SharedContainerCodeLayout;
  store: SharedContainerReplicaStore;
  commit?: W5CommitOptions;
  attempt?: W5KeyedAttempt;
}): Promise<SharedContainerForkResponse> {
  const requestedDestination = validateForkDestination(
    options.request.destination,
  );
  if (requestedDestination.kind === 'new-workspace') {
    assertNewForkOwner(requestedDestination, options.owner);
  }
  if (options.layout.containerType !== 'CODE_WORKTREE') {
    throw new Error('Shared-container fork type mismatch');
  }
  if (options.layout.repositories.length === 0) {
    throw new Error('Code fork has no repositories');
  }
  const newOrganizationCopy =
    requestedDestination.kind === 'new-workspace' &&
    options.owner.kind === 'organization';
  const assertEligible = (): Promise<void> => {
    const [repository] = options.layout.repositories;
    return assertOrganizationForkEligible({
      owner: options.owner,
      organizationName: options.organizationName,
      shape:
        options.layout.repositories.length > 1 ? 'multi-repo' : 'single-repo',
      ...(repository && !isSnapshotRepository(repository)
        ? { remoteUrl: repository.remoteUrl }
        : {}),
    });
  };
  const run = (): Promise<SharedContainerForkResponse> =>
    runWithSharedContainerForkRollback<SharedContainerForkResponse>(
      async (rollback) => {
        const destination =
          options.request.destination.kind === 'existing-workspace'
            ? await matchExistingWorkspace(
                options.layout,
                options.request.destination.workspaceId,
                options.owner,
                !!options.commit?.expectedRevisions || !!options.attempt,
              )
            : await createWorkspaceFromReplica({
                request: options.request,
                owner: options.owner,
                organizationName: options.organizationName,
                layout: options.layout,
                revisionRoot: options.revisionRoot,
                parentDirectory: options.request.destination.parentDirectory,
                rollback,
                commit: options.commit,
                attempt: options.attempt,
              });
        if (
          destination.createdWorkspace &&
          'startPage' in options.layout &&
          options.layout.startPage
        ) {
          const mappedStartPage = mapCodeForkStartPage(
            options.layout.startPage,
            destination.repoIds,
            destination.workspace.type,
          );
          if (mappedStartPage) {
            await recordSharedContainerForkStartPage(
              {
                source: 'code_fork',
                workspaceId: destination.workspace.id,
                startPage: mappedStartPage,
              },
              options.commit,
            );
          }
        }
        await assertForkWorkspaceOwner(
          destination.workspace.id,
          options.owner,
          true,
        );
        const worktree = await createDestinationWorktree(
          destination,
          options.layout,
          options.commit,
          options.attempt,
        );
        if (!destination.createdWorkspace) {
          rollback.defer(() =>
            destination.workspace.type === 'single-repo'
              ? archiveSingleRepoWorktree({
                  archiveTrigger: 'internal-rollback',
                  workspaceId: destination.workspace.id,
                  worktreeId: worktree.id,
                  retainAsArchivedContainer: false,
                  deleteBranch: true,
                })
              : archiveMultiRepoWorktree({
                  archiveTrigger: 'internal-rollback',
                  workspaceId: destination.workspace.id,
                  worktreeId: worktree.id,
                  retainAsArchivedContainer: false,
                  deleteBranch: true,
                }),
          );
        }
        await replaySharedContainerOverlay({
          store: options.store,
          revisionRoot: options.revisionRoot,
          layout: options.layout,
          workspaceId: destination.workspace.id,
          worktreeId: worktree.id,
          repoIds: destination.repoIds,
          singleRepo: destination.workspace.type === 'single-repo',
        });
        const attachments = await copyForkAttachments({
          store: options.store,
          revisionRoot: options.revisionRoot,
          layout: options.layout,
          projectId: destination.workspace.id,
          worktreeId: worktree.id,
          rollback,
        });
        const warnings = await rehydrateForkChats({
          containerId: options.request.containerId,
          revisionId: options.request.revisionId,
          projectId: destination.workspace.id,
          worktreeId: worktree.id,
          attachments,
        });
        await writeForkProvenanceForDestination(
          destination.workspace.id,
          worktree.id,
          options.provenance,
        );
        await assertForkWorkspaceOwner(destination.workspace.id, options.owner);
        return {
          containerType: 'CODE_WORKTREE',
          projectId: destination.workspace.id,
          worktreeId: worktree.id,
          warnings,
          provenance: options.provenance,
        };
      },
    );
  if (!newOrganizationCopy) return run();
  try {
    await assertEligible();
    return await run();
  } catch (error) {
    throw toOrganizationForkFailure(error, options.organizationName);
  }
}
