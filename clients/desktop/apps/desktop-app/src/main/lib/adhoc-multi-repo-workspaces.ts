import { assertLegacyCombineAllowed } from './org-shared-multi-repo-legacy-guard';
import { w5CompositionLocks } from './w5-composition-operation';
import {
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  W5RevisionConflictError,
  type W5CommitOptions,
} from './w5-commit-log-file-store';
import type { W5KeyedAttempt } from './w5-keyed-operation';
import { w5LifecycleReceiptCaller, type W5WireCall } from './w5-wire-call';
import {
  decodeW5CompositionOutcome,
  admitW5Composition,
  checkW5CompositionRevisions,
  commitW5BoundaryStep,
  w5CombineOutcomeParser,
  w5PromoteOutcomeParser,
  type W5CompositionOptions,
  type W5CombineOutcome,
  type W5PromoteOutcome,
} from './w5-composition-operation';
import { lstat, mkdir, readlink, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type AdhocMultiRepoCombineRequest,
  type AdhocMultiRepoCombineResponse,
  type AdhocMultiRepoJoinOption,
  type AdhocMultiRepoJoinOptionsRequest,
  type AdhocMultiRepoJoinOptionsResponse,
  type MultiRepoSidebarItem,
  type PromoteTemporaryWorkspaceRequest,
  type RepoSelection,
  type SidebarItem,
  type WorktreeCompatibilitySymlink,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  allocateAdhocDestinationWorktreeId,
  assertNoActiveWorktreeWork,
  assertSourceCheckoutsExist,
  buildExistingDestinationMigrationPayload,
  buildFilePathRewrites,
  buildRepoIdRewrites,
  buildRepoMapping,
  buildRollbackFailureError,
  buildSourceRootRepoIdRewrite,
  buildUpdatedSourceWorkspaceResponse,
  cleanupFailedDestination,
  compareSidebarItems,
  consumeWorktreeRootWithSymlink,
  dedupeCandidates,
  filterNewJoinCandidates,
  findExistingAdhocDestination,
  findWorkspace,
  getEmptyTemporaryWorkspaceId,
  mapCandidatesToDestinationRepos,
  migratePipelineExecutions,
  discardLedgerIntentOfWorktreeMove,
  LEDGER_COMBINE_NOT_SAVED_MESSAGE,
  normalizeRepoIdentityKeySet,
  normalizeWorkspaceIdSet,
  notifyLedgerOfWorktreeMove,
  recordLedgerIntentOfWorktreeMove,
  repoIdentityKey,
  resolveDestinationWorkspace,
  resolveJoinCandidatesForWorkspaces,
  resolveRepoIdentity,
  resolveSidebarItemRepoIdentities,
  resolveSourceCandidates,
  resolveWorkspaceForTemporaryRepoSelection,
  restoreConsumedRoot,
  restorePipelineSnapshots,
  reverseMovedCheckouts,
  scaffoldDestinationRoot,
  workspaceAddsNewRepo,
  type ConsumedRootRestore,
  type LedgerWorktreeMove,
  type RepoCandidate,
  type ResolvedDestination,
} from './adhoc-combine-core';
import {
  createWorktreeAvoidingCheckedOutBranch,
  getCurrentBranch,
  moveWorktree,
  removeWorktree,
} from './git';
import { getWorkspaceWorktreeDir, getWorkspaceWorktreeRepoDir } from './paths';
import { pathExists } from './fs-utils';
import { readAllSidebarItems } from './sidebar-items';
import { slugify } from './string-utils';
import { validateId } from './validation';
import { readWorkspaceConfig } from './workspace-persistence';
import { listWorkspaceItems } from './workspace-service';
import { addRepoCheckoutToWorktree } from './workspace-repo-mutators';
import { addWorkspaceRepository } from './workspace-repositories';
import {
  recordJoinedWorktree,
  undoJoinedWorktree,
  type JoinedWorktreeUndo,
  removeCompositionWorktree,
  undoCompositionRepositories,
  promoteCompositionWorkspace,
} from './workspace-composition-records';
import { initializeWorkspaceSourceRepo } from './workspace-source-control';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

export { listCompatibilitySymlinkReservedWorktreeIds } from './adhoc-combine-core';

function getJoinWorkspaceIds(request: AdhocMultiRepoCombineRequest): string[] {
  const ids = [...(request.joinWorkspaceIds ?? [])];
  if (request.joinWorkspaceId) {
    ids.push(request.joinWorkspaceId);
  }
  return Array.from(new Set(ids));
}

function toJoinOption(item: SidebarItem): AdhocMultiRepoJoinOption {
  if (item.type === 'multi-repo') {
    return {
      id: item.id,
      name: item.name,
      color: item.color,
      isMultiRepo: true,
      repoCount: item.repos.filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
        .length,
      temporary: item.temporary === true,
    };
  }
  return {
    id: item.id,
    name: item.name,
    color: item.color,
    isMultiRepo: false,
    repoCount: 1,
    temporary: false,
    repoPath: item.type === 'single-repo' ? item.repoPath : undefined,
  };
}

export async function listAdhocMultiRepoJoinOptions(
  request: AdhocMultiRepoJoinOptionsRequest,
): Promise<AdhocMultiRepoJoinOptionsResponse> {
  validateId(request.sourceWorkspaceId, 'sourceWorkspaceId');
  const items = await listWorkspaceItems();
  const sourceWorkspace = findWorkspace(items, request.sourceWorkspaceId);
  if (!sourceWorkspace) {
    throw new Error(`Project ${request.sourceWorkspaceId} not found`);
  }

  // Cowork workspaces are non-git and have no repos, so they can neither be a
  // combine source nor a join candidate. Exclude them entirely (matching
  // `listExistingWorktreeJoinOptions`) so `resolveSidebarItemRepoIdentities`
  // never throws on one.
  if (sourceWorkspace.type === 'cowork') {
    return { options: [] };
  }

  const sourceIdentities =
    await resolveSidebarItemRepoIdentities(sourceWorkspace);
  const options: AdhocMultiRepoJoinOption[] = [];
  for (const item of items) {
    if (item.id === request.sourceWorkspaceId || item.type === 'cowork') {
      continue;
    }
    const joinIdentities = await resolveSidebarItemRepoIdentities(item);
    if (workspaceAddsNewRepo(sourceIdentities, joinIdentities)) {
      options.push(toJoinOption(item));
    }
  }
  return { options };
}

export async function createOrReuseTemporaryWorkspaceFromRepos(
  repos: RepoSelection[],
): Promise<{
  workspace: SidebarItem;
  createdTemporaryWorkspace: boolean;
  reusedWorkspace: boolean;
}> {
  if (repos.length === 0) {
    throw new Error('Choose at least one repository');
  }

  const seenPaths = new Set<string>();
  const candidates = await settleAll(
    repos.map(async (repo) => {
      const repoPath = resolve(repo.path);
      if (seenPaths.has(repoPath)) {
        throw new Error(`Repository "${repoPath}" was selected more than once`);
      }
      seenPaths.add(repoPath);
      const name = repo.name.trim() || basename(repoPath);
      return {
        source: 'join' as const,
        preferredRepoId: slugify(name) || 'repo',
        name,
        repoPath,
        identity: await resolveRepoIdentity(repoPath),
      };
    }),
  );

  const dedupedCandidates = dedupeCandidates(candidates);
  if (dedupedCandidates.length !== candidates.length) {
    throw new Error('Selected repositories must be unique');
  }

  const items = await listWorkspaceItems({ includeEmptyTemporary: true });
  return resolveWorkspaceForTemporaryRepoSelection(items, dedupedCandidates, {
    commit: { operation: 'core.workspace.create' },
    repoIdentityKeys: normalizeRepoIdentityKeySet(
      dedupedCandidates.map((candidate) => repoIdentityKey(candidate.identity)),
    ),
  });
}

export async function createOrReuseTemporaryWorkspaceFromWorkspaces(
  workspaceIds: string[],
): Promise<{
  workspace: SidebarItem;
  createdTemporaryWorkspace: boolean;
  reusedWorkspace: boolean;
}> {
  if (workspaceIds.length === 0) {
    throw new Error('Choose at least one project');
  }

  const uniqueWorkspaceIds = Array.from(new Set(workspaceIds));
  if (uniqueWorkspaceIds.length !== workspaceIds.length) {
    throw new Error('Selected projects must be unique');
  }

  for (const workspaceId of uniqueWorkspaceIds) {
    validateId(workspaceId, 'workspaceId');
  }

  const items = await listWorkspaceItems({ includeEmptyTemporary: true });
  const workspaces = uniqueWorkspaceIds
    .map((workspaceId) => {
      const workspace = findWorkspace(items, workspaceId);
      if (!workspace) {
        throw new Error(`Project ${workspaceId} not found`);
      }
      return workspace;
    })
    .sort(compareSidebarItems);
  const candidates = dedupeCandidates(
    await resolveJoinCandidatesForWorkspaces(workspaces),
  );
  if (candidates.length === 0) {
    throw new Error('Selected projects do not contain any repos');
  }

  return resolveWorkspaceForTemporaryRepoSelection(items, candidates, {
    commit: { operation: 'core.workspace.create' },
    repoIdentityKeys: normalizeRepoIdentityKeySet(
      candidates.map((candidate) => repoIdentityKey(candidate.identity)),
    ),
    sourceWorkspaceIds: normalizeWorkspaceIdSet(uniqueWorkspaceIds),
  });
}

export async function cleanupCompatibilitySymlinks(
  worktree: WorktreeData,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const link of worktree.compatibilitySymlinks ?? []) {
    try {
      const stat = await lstat(link.path).catch(() => null);
      if (!stat?.isSymbolicLink()) {
        continue;
      }
      const currentTarget = resolve(
        dirname(link.path),
        await readlink(link.path),
      );
      if (currentTarget !== resolve(link.targetPath)) {
        continue;
      }
      await rm(link.path, { force: true });
    } catch {
      warnings.push(`Failed to remove compatibility symlink: ${link.path}`);
    }
  }
  return warnings;
}

async function handleUpdateSourceWorkspace(
  request: AdhocMultiRepoCombineRequest,
  sourceWorkspace: MultiRepoSidebarItem,
  sourceWorktree: WorktreeData,
  sourceCandidates: RepoCandidate[],
  joinCandidates: RepoCandidate[],
  commit: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<AdhocMultiRepoCombineResponse> {
  if (sourceWorkspace.temporary === true) {
    throw new Error(
      'Cannot update a temporary project. Promote it before updating its repo set.',
    );
  }
  const missingJoinCandidates = filterNewJoinCandidates(
    sourceCandidates,
    joinCandidates,
  );
  if (missingJoinCandidates.length === 0) {
    throw new Error('Selected projects do not add any new repos.');
  }
  const addedRepositories: MultiRepoSidebarItem['repos'] = [];
  const createdCheckouts: Array<{ repoPath: string; checkoutPath: string }> =
    [];
  try {
    for (const candidate of missingJoinCandidates) {
      const repo = await addWorkspaceRepository(
        {
          workspaceId: request.sourceWorkspaceId,
          source: 'temporary_combine',
          repository: {
            id: candidate.preferredRepoId,
            name: candidate.name,
            repoPath: candidate.repoPath,
          },
        },
        commit,
      );
      addedRepositories.push(repo);
      const checkoutPath = getWorkspaceWorktreeRepoDir(
        request.sourceWorkspaceId,
        request.sourceWorktreeId,
        repo.id,
      );
      attempt?.beforeEffects();
      await addRepoCheckoutToWorktree(
        request.sourceWorkspaceId,
        request.sourceWorktreeId,
        repo,
      );
      createdCheckouts.push({ repoPath: repo.repoPath, checkoutPath });
    }

    return await buildUpdatedSourceWorkspaceResponse({
      sourceWorkspaceId: request.sourceWorkspaceId,
      sourceWorktreeId: request.sourceWorktreeId,
      sourceWorkspace,
      fallbackWorktree: sourceWorktree,
      finalCandidates: dedupeCandidates([
        ...sourceCandidates,
        ...missingJoinCandidates,
      ]),
    });
  } catch (error) {
    for (const { repoPath, checkoutPath } of createdCheckouts.reverse()) {
      await removeWorktree(repoPath, checkoutPath).catch(() =>
        rm(checkoutPath, { recursive: true, force: true }),
      );
    }
    await undoCompositionRepositories({
      source: 'workspace_combine',
      workspaceId: request.sourceWorkspaceId,
      repositories: addedRepositories,
    });
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function handleTemporaryCombine(
  request: AdhocMultiRepoCombineRequest,
  sourceWorkspace: SidebarItem,
  sourceWorktree: WorktreeData,
  finalCandidates: RepoCandidate[],
  sourceCandidates: RepoCandidate[],
  destination: ResolvedDestination,
  commit: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<AdhocMultiRepoCombineResponse> {
  const destinationWorktreeId = await allocateAdhocDestinationWorktreeId(
    destination.workspace.id,
    request.sourceWorktreeId,
  );
  const destinationRoot = getWorkspaceWorktreeDir(
    destination.workspace.id,
    destinationWorktreeId,
  );
  const repoPairs = await mapCandidatesToDestinationRepos(
    finalCandidates,
    destination.workspace,
  );
  const repoMappings = repoPairs.map(({ candidate, repo }) =>
    buildRepoMapping(
      candidate,
      repo,
      destination.workspace.id,
      destinationWorktreeId,
    ),
  );
  const selectedRepoIdRewrites = buildRepoIdRewrites(repoMappings);
  const sourceRootRepoIdRewrite = buildSourceRootRepoIdRewrite(
    sourceWorkspace,
    repoMappings,
  );
  const rootRewrite =
    sourceWorkspace.type === 'multi-repo'
      ? {
          fromRoot: getWorkspaceWorktreeDir(
            request.sourceWorkspaceId,
            request.sourceWorktreeId,
          ),
          toRoot: destinationRoot,
        }
      : undefined;
  const filePathRewrites = buildFilePathRewrites(repoMappings, rootRewrite);
  const moved: Array<{ repoPath: string; oldPath: string; newPath: string }> =
    [];
  const createdSymlinks: string[] = [];
  const createdMissingWorktrees: Array<{ repoPath: string; path: string }> = [];
  let sourceRootRestore: ConsumedRootRestore | undefined;
  let pipelineSnapshots = new Map<string, ExecutionState>();
  let destinationUndo: JoinedWorktreeUndo | undefined;
  // The worktree continues as the destination row, keeping its creation time.
  const ledgerMove: LedgerWorktreeMove = {
    from: { workspaceId: request.sourceWorkspaceId, worktree: sourceWorktree },
    to: {
      workspaceId: destination.workspace.id,
      worktree: {
        id: destinationWorktreeId,
        createdAt: sourceWorktree.createdAt,
      },
    },
  };
  let ledgerMoveRecorded = false;

  attempt?.beforeEffects();
  try {
    await scaffoldDestinationRoot(destinationRoot, destination.workspace.name);

    const branchSeed =
      (await settleAll(
        sourceCandidates.map((candidate) =>
          candidate.oldWorktreePath
            ? getCurrentBranch(candidate.oldWorktreePath).catch(() => null)
            : Promise.resolve(null),
        ),
      ).then((branches) =>
        branches.find((branch) => branch && branch !== 'HEAD'),
      )) ?? destinationWorktreeId;

    for (const mapping of repoMappings) {
      const candidate = finalCandidates.find(
        (entry) =>
          (mapping.oldWorktreePath !== undefined &&
            entry.oldWorktreePath === mapping.oldWorktreePath) ||
          (entry.sourceRepoId === mapping.sourceRepoId &&
            entry.repoPath === mapping.repoPath),
      );
      if (mapping.oldWorktreePath) {
        const sourceRepoPath = candidate?.repoPath ?? mapping.repoPath;
        await mkdir(dirname(mapping.newWorktreePath), { recursive: true });
        if (!(await pathExists(mapping.newWorktreePath))) {
          await moveWorktree(
            sourceRepoPath,
            mapping.oldWorktreePath,
            mapping.newWorktreePath,
          );
          moved.push({
            repoPath: sourceRepoPath,
            oldPath: mapping.oldWorktreePath,
            newPath: mapping.newWorktreePath,
          });
        }
        continue;
      }
      if (!candidate) {
        continue;
      }
      await mkdir(dirname(mapping.newWorktreePath), { recursive: true });
      // The seed branch may already be checked out at another worktree of
      // this repo — e.g. the destination worktree a previous split of this
      // same combination left behind. Fall back to a fresh branch at the
      // same commit instead of failing the whole combine.
      await createWorktreeAvoidingCheckedOutBranch(
        mapping.repoPath,
        mapping.newWorktreePath,
        branchSeed,
      );
      createdMissingWorktrees.push({
        repoPath: mapping.repoPath,
        path: mapping.newWorktreePath,
      });
    }

    const compatibilitySymlinks: WorktreeCompatibilitySymlink[] = [];
    const consumedRootLink = await consumeWorktreeRootWithSymlink({
      workspace: sourceWorkspace,
      workspaceId: request.sourceWorkspaceId,
      worktreeId: request.sourceWorktreeId,
      repoMappings,
      destinationRoot,
      fallbackBranchName: destinationWorktreeId,
      onRootConsumed: (restore) => {
        sourceRootRestore = restore;
      },
    });
    if (consumedRootLink) {
      createdSymlinks.push(consumedRootLink.path);
      compatibilitySymlinks.push(consumedRootLink);
    }

    pipelineSnapshots = await migratePipelineExecutions({
      sourceWorkspaceId: request.sourceWorkspaceId,
      sourceWorktreeId: request.sourceWorktreeId,
      destinationWorkspaceId: destination.workspace.id,
      destinationWorktreeId,
      rewrites: filePathRewrites,
    });

    // Durable before the commit: after an exit before the participant runs,
    // startup finds the worktree even under a suffixed ID. Without it, the
    // combine does not commit.
    ledgerMoveRecorded = true;
    if (!(await recordLedgerIntentOfWorktreeMove(ledgerMove))) {
      throw new Error(LEDGER_COMBINE_NOT_SAVED_MESSAGE);
    }
    const destinationRecord = await commitW5BoundaryStep(
      commit,
      w5CompositionLocks({ lists: [destination.workspace.id] }),
      () =>
        recordJoinedWorktree({
          source: 'workspace_combine',
          workspaceId: destination.workspace.id,
          worktreeId: destinationWorktreeId,
          sourceWorktree,
          repoIdRewrites: selectedRepoIdRewrites,
          compatibilitySymlinks,
          transition: {
            sourceWorkspaceId: request.sourceWorkspaceId,
            sourceWorktreeId: request.sourceWorktreeId,
            sourceRepoIds: sourceCandidates
              .map((candidate) => candidate.sourceRepoId)
              .filter((repoId): repoId is string => repoId !== undefined),
            repoMappings,
            selectedRepoIdRewrites,
            sourceRootRepoIdRewrite,
            filePathRewrites,
            createdAt: new Date().toISOString(),
          },
        }),
    );
    const destinationWorktree = destinationRecord.worktree;
    destinationUndo = destinationRecord.undo;

    await commitW5BoundaryStep(
      commit,
      w5CompositionLocks({ lists: [request.sourceWorkspaceId] }),
      () =>
        removeCompositionWorktree({
          source: 'workspace_combine',
          workspaceId: request.sourceWorkspaceId,
          worktree: sourceWorktree,
        }),
    );
    const removedTemporaryWorkspaceId = await getEmptyTemporaryWorkspaceId(
      request.sourceWorkspaceId,
    );
    const refreshedDestination = (await listWorkspaceItems()).find(
      (item): item is MultiRepoSidebarItem =>
        item.type === 'multi-repo' && item.id === destination.workspace.id,
    );
    // Committed: the worktree now lives in the destination workspace.
    notifyLedgerOfWorktreeMove(ledgerMove);
    return {
      sourceWorkspaceId: request.sourceWorkspaceId,
      sourceWorktreeId: request.sourceWorktreeId,
      destinationWorkspaceId: destination.workspace.id,
      destinationWorktreeId,
      destinationWorkspace: refreshedDestination ?? destination.workspace,
      destinationWorktree,
      repoMappings,
      selectedRepoIdRewrites,
      sourceRootRepoIdRewrite,
      filePathRewrites,
      compatibilitySymlinks,
      createdTemporaryWorkspace: destination.createdTemporaryWorkspace,
      reusedWorkspace: destination.reusedWorkspace,
      removedSourceWorktree: true,
      removedTemporaryWorkspaceId,
    };
  } catch (error) {
    if (ledgerMoveRecorded) discardLedgerIntentOfWorktreeMove(ledgerMove);
    await restorePipelineSnapshots(pipelineSnapshots).catch(() => {});
    if (destinationUndo) {
      await undoJoinedWorktree(destinationUndo).catch(() => undefined);
    }
    for (const linkPath of createdSymlinks) {
      await rm(linkPath, { force: true }).catch(() => {});
    }
    const rollbackErrors: unknown[] = [];
    await restoreConsumedRoot(sourceRootRestore, rollbackErrors);
    for (const created of createdMissingWorktrees.reverse()) {
      await removeWorktree(created.repoPath, created.path).catch(() =>
        rm(created.path, { recursive: true, force: true }),
      );
    }
    await reverseMovedCheckouts(moved, rollbackErrors);
    // Only destroy the destination when rollback fully restored the source
    // side — after a partial rollback it may hold the only copy of a checkout.
    if (rollbackErrors.length === 0) {
      await cleanupFailedDestination({
        createdTemporaryWorkspace: destination.createdTemporaryWorkspace,
        destinationWorkspaceId: destination.workspace.id,
        destinationRoot,
      });
      throw error instanceof Error ? error : new Error(String(error));
    }
    throw buildRollbackFailureError(
      error,
      rollbackErrors,
      'Add repo failed and rollback did not fully restore source checkouts',
      destinationRoot,
    );
  }
}

async function combineWorktreeWithWorkspaceAdmitted(
  request: AdhocMultiRepoCombineRequest,
  commit: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<AdhocMultiRepoCombineResponse> {
  const readOptions =
    commit.expectedRevisions || attempt
      ? { persistRemovalCleanup: false as const }
      : undefined;
  validateId(request.sourceWorkspaceId, 'sourceWorkspaceId');
  validateId(request.sourceWorktreeId, 'sourceWorktreeId');
  const joinWorkspaceIds = getJoinWorkspaceIds(request);
  if (joinWorkspaceIds.length === 0) {
    throw new Error('Choose at least one project to add');
  }
  for (const joinWorkspaceId of joinWorkspaceIds) {
    validateId(joinWorkspaceId, 'joinWorkspaceId');
  }
  if (joinWorkspaceIds.includes(request.sourceWorkspaceId)) {
    throw new Error('Cannot add a project to itself');
  }

  await assertLegacyCombineAllowed(
    [request.sourceWorkspaceId, ...joinWorkspaceIds],
    request.mode,
  );
  const existingDestination = await findExistingAdhocDestination(
    request.sourceWorkspaceId,
    request.sourceWorktreeId,
    readOptions,
  );
  if (
    existingDestination &&
    (existingDestination.workspace.id !== request.sourceWorkspaceId ||
      existingDestination.worktree.id !== request.sourceWorktreeId)
  ) {
    const migrationPayload =
      buildExistingDestinationMigrationPayload(existingDestination);
    return {
      sourceWorkspaceId: request.sourceWorkspaceId,
      sourceWorktreeId: request.sourceWorktreeId,
      destinationWorkspaceId: existingDestination.workspace.id,
      destinationWorktreeId: existingDestination.worktree.id,
      destinationWorkspace: existingDestination.workspace,
      destinationWorktree: existingDestination.worktree,
      repoMappings: migrationPayload.repoMappings,
      selectedRepoIdRewrites: migrationPayload.selectedRepoIdRewrites,
      sourceRootRepoIdRewrite: migrationPayload.sourceRootRepoIdRewrite,
      filePathRewrites: migrationPayload.filePathRewrites,
      compatibilitySymlinks:
        existingDestination.worktree.compatibilitySymlinks ?? [],
      createdTemporaryWorkspace: false,
      reusedWorkspace: true,
      removedSourceWorktree: true,
    };
  }

  const items = await listWorkspaceItems({
    includeEmptyTemporary: true,
    ...readOptions,
  });
  const sourceWorkspace = findWorkspace(items, request.sourceWorkspaceId);
  if (!sourceWorkspace) {
    throw new Error(`Project ${request.sourceWorkspaceId} not found`);
  }
  if (sourceWorkspace.type === 'cowork') {
    throw new Error(
      `Project ${request.sourceWorkspaceId} is a cowork project and has no worktrees`,
    );
  }
  const joinWorkspaces = joinWorkspaceIds.map((joinWorkspaceId) => {
    const workspace = findWorkspace(items, joinWorkspaceId);
    if (!workspace) {
      throw new Error(`Project ${joinWorkspaceId} not found`);
    }
    return workspace;
  });

  const sourceWorktree = sourceWorkspace.worktrees.find(
    (worktree) => worktree.id === request.sourceWorktreeId,
  );
  if (!sourceWorktree) {
    throw new Error('Cannot retry add repo: source worktree no longer exists.');
  }
  if (sourceWorktree.setupPhase === 'git-pending') {
    throw new Error('Cannot add repo while source worktree setup is pending.');
  }

  await assertNoActiveWorktreeWork(
    request.sourceWorkspaceId,
    request.sourceWorktreeId,
    {
      activeChats: 'Stop active chats before adding a repo to this worktree.',
      runningScripts:
        'Wait for running scripts, such as setup, to finish before adding a repo to this worktree.',
      runningPipelines:
        'Wait for running workflow executions to finish before adding a repo to this worktree.',
    },
  );
  const joinCandidates =
    await resolveJoinCandidatesForWorkspaces(joinWorkspaces);
  const sourceCandidates = await resolveSourceCandidates(
    sourceWorkspace,
    request.sourceWorktreeId,
    joinCandidates,
  );
  await assertSourceCheckoutsExist(sourceCandidates);
  if (filterNewJoinCandidates(sourceCandidates, joinCandidates).length === 0) {
    throw new Error('Selected projects do not add any new repos.');
  }

  if (request.mode === 'update-source-workspace') {
    if (sourceWorkspace.type !== 'multi-repo') {
      throw new Error(
        'update-source-workspace mode requires a multi-repo source project',
      );
    }
    return handleUpdateSourceWorkspace(
      request,
      sourceWorkspace,
      sourceWorktree,
      sourceCandidates,
      joinCandidates,
      commit,
      attempt,
    );
  }

  const finalCandidates = dedupeCandidates([
    ...sourceCandidates,
    ...joinCandidates,
  ]);
  const destination = await resolveDestinationWorkspace(
    items,
    finalCandidates,
    {
      reuseOwner: sourceWorkspace.owner,
      beforeEffects: attempt?.beforeEffects,
      commit,
    },
  );
  return handleTemporaryCombine(
    request,
    sourceWorkspace,
    sourceWorktree,
    finalCandidates,
    sourceCandidates,
    destination,
    commit,
    attempt,
  );
}

async function promoteTemporaryWorkspaceAdmitted(
  request: PromoteTemporaryWorkspaceRequest,
  commit: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<MultiRepoSidebarItem> {
  validateId(request.workspaceId, 'workspaceId');
  const name = request.name.trim();
  if (!name) {
    throw new Error('Project name is required');
  }
  const sidebarItems = await readAllSidebarItems(
    commit.expectedRevisions || attempt
      ? { persistRemovalCleanup: false }
      : undefined,
  );
  const { items } = sidebarItems;
  const workspace = items.find((item) => item.id === request.workspaceId);
  if (!workspace || workspace.type !== 'multi-repo') {
    throw new Error(
      `Project ${request.workspaceId} is not a multi-repo project`,
    );
  }
  if (workspace.temporary !== true) {
    throw new Error(`Project ${request.workspaceId} is not temporary`);
  }
  const { sourceRepoPath } = await initializeWorkspaceSourceRepo(
    {
      workspaceId: request.workspaceId,
      workspaceName: name,
      source: 'temporary_promote',
    },
    { commit, beforeEffects: attempt?.beforeEffects },
  );
  const initializedConfig = await readWorkspaceConfig(request.workspaceId);
  const updated: MultiRepoSidebarItem = {
    ...workspace,
    name,
    repos: initializedConfig.repos,
    temporary: undefined,
    temporarySourceWorkspaceIds: undefined,
    temporaryRepoIdentityKeys: undefined,
    sourceRepoPath,
  };
  await commitW5BoundaryStep(
    commit,
    w5CompositionLocks({ index: true, manifests: [request.workspaceId] }),
    () =>
      promoteCompositionWorkspace({
        source: 'temporary_promote',
        workspaceId: request.workspaceId,
        name,
        sourceRepoPath,
      }),
  );
  return updated;
}

export type WorkspaceCombineRequest = AdhocMultiRepoCombineRequest &
  W5CompositionOptions;
export function combineWorktreeWithWorkspace(
  request: WorkspaceCombineRequest & { idempotencyKey: string },
): Promise<W5CombineOutcome>;
export function combineWorktreeWithWorkspace(
  request: WorkspaceCombineRequest & { idempotencyKey?: undefined },
): Promise<AdhocMultiRepoCombineResponse>;
export function combineWorktreeWithWorkspace(
  request: WorkspaceCombineRequest,
): Promise<AdhocMultiRepoCombineResponse | W5CombineOutcome>;
export function combineWorktreeWithWorkspace(
  request: WorkspaceCombineRequest,
): Promise<AdhocMultiRepoCombineResponse | W5CombineOutcome> {
  const { expectedRevisions, idempotencyKey } = request;
  return runW5BoundaryOperation<
    AdhocMultiRepoCombineResponse | W5CombineOutcome
  >(
    {
      operation: 'core.workspace.composition.combine',
      caller: 'desktop-host:composition-combine',
      idempotencyKey,
      parameters: {
        variant: 'workspace',
        sourceWorkspaceId: request.sourceWorkspaceId,
        sourceWorktreeId: request.sourceWorktreeId,
        joinWorkspaceIds: getJoinWorkspaceIds(request),
        mode: request.mode,
      },
      isPreEffectRefusal: (error) => error instanceof W5RevisionConflictError,
    },
    (outcome) => decodeW5CompositionOutcome(w5CombineOutcomeParser, outcome),
    async (commit, attempt) => {
      commit.expectedRevisions = expectedRevisions;
      await checkW5CompositionRevisions(commit);
      return admitW5Composition(attempt, () =>
        combineWorktreeWithWorkspaceAdmitted(request, commit, attempt),
      );
    },
  );
}

export type WorkspacePromoteRequest = PromoteTemporaryWorkspaceRequest &
  W5BoundaryOptions & {
    /** A registered wire call's receipt scope and admission (W7b-4). */
    wireCall?: W5WireCall;
  };
export function promoteTemporaryWorkspace(
  request: WorkspacePromoteRequest & { idempotencyKey: string },
): Promise<W5PromoteOutcome>;
export function promoteTemporaryWorkspace(
  request: WorkspacePromoteRequest & { idempotencyKey?: undefined },
): Promise<MultiRepoSidebarItem>;
export function promoteTemporaryWorkspace(
  request: WorkspacePromoteRequest,
): Promise<MultiRepoSidebarItem | W5PromoteOutcome>;
export function promoteTemporaryWorkspace(
  request: WorkspacePromoteRequest,
): Promise<MultiRepoSidebarItem | W5PromoteOutcome> {
  const { expectedRevision, idempotencyKey } = request;
  return runW5BoundaryOperation<MultiRepoSidebarItem | W5PromoteOutcome>(
    {
      operation: 'core.workspace.composition.promote',
      caller: w5LifecycleReceiptCaller('composition-promote', request.wireCall),
      idempotencyKey,
      admit: request.wireCall?.admit,
      parameters: {
        workspaceId: request.workspaceId,
        name: request.name.trim(),
      },
      isPreEffectRefusal: (error) => error instanceof W5RevisionConflictError,
    },
    (outcome) => decodeW5CompositionOutcome(w5PromoteOutcomeParser, outcome),
    async (commit, attempt) => {
      commit.expectedRevisions = w5ExpectedRevision(
        { kind: 'workspace', workspaceId: request.workspaceId },
        expectedRevision,
      );
      await checkW5CompositionRevisions(commit);
      return admitW5Composition(attempt, () =>
        promoteTemporaryWorkspaceAdmitted(request, commit, attempt),
      );
    },
  );
}
