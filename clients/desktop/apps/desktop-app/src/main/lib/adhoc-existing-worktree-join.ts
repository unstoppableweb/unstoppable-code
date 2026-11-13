import { assertLegacyCombineAllowed } from './org-shared-multi-repo-legacy-guard';
import { w5CompositionLocks } from './w5-composition-operation';
import { runW5BoundaryOperation } from './w5-boundary-operation';
import {
  W5RevisionConflictError,
  type W5CommitOptions,
} from './w5-commit-log-file-store';
import type { W5KeyedAttempt } from './w5-keyed-operation';
import {
  decodeW5CompositionOutcome,
  admitW5Composition,
  checkW5CompositionRevisions,
  commitW5BoundaryStep,
  w5ExistingCombineOutcomeParser,
  type W5CompositionOptions,
  type W5ExistingCombineOutcome,
} from './w5-composition-operation';
/**
 * Adhoc existing-worktree join: list candidate worktrees in other workspaces
 * that can be joined with a source worktree into a combined adhoc worktree,
 * and the combine orchestration that consumes both worktrees.
 *
 * `combineWorktreeWithExistingWorktree` mirrors the temporary-mode combine in
 * `adhoc-multi-repo-workspaces.ts`, with a second consumed side: the joined
 * worktree's checkouts are MOVED into the destination (never re-created), its
 * root becomes a compatibility symlink, its pipeline executions migrate, and
 * its worktree row is removed from its workspace.
 *
 * Vocabulary: the "join" worktree is the existing worktree being consumed;
 * its repo-level artifacts are named "target*"; "destination" is the combined
 * result.
 */
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type AdhocExistingWorktreeCombineRequest,
  type AdhocExistingWorktreeCombineResponse,
  type AdhocJoinedWorktreeMigration,
  type AdhocMultiRepoRepoMapping,
  type ExistingWorktreeJoinBusyReason,
  type ExistingWorktreeJoinCandidate,
  type ExistingWorktreeJoinOptionsRequest,
  type ExistingWorktreeJoinOptionsResponse,
  type ExistingWorktreeJoinRepoOverlap,
  type ExistingWorktreeJoinWorkspaceGroup,
  type MultiRepoSidebarItem,
  type SidebarItem,
  type SingleRepoSidebarItem,
  type WorkspaceRepoData,
  type WorktreeCompatibilitySymlink,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/execution-engine/node/pipelines/executor/types';
import { getActiveChatIds } from '../agents/session-manager';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { listExecutionSummaries } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import {
  createWorktree,
  getCurrentBranch,
  hasCommitsAhead,
  hasUncommittedChanges,
  moveWorktree,
} from './git';
import { mapWithConcurrency } from './concurrency';
import {
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorktreeDir,
} from './paths';
import { pathExists } from './fs-utils';
import { safeRemoveWorktree } from './safe-remove-worktree';
import { validateId } from './validation';
import { addWorkspaceRepository } from './workspace-repositories';
import {
  recordJoinedWorktree,
  undoJoinedWorktree,
  type JoinedWorktreeUndo,
  type RemovedCompositionRows,
  recordCompositionSource,
  undoCompositionSource,
  removeCompositionWorktree,
  restoreCompositionWorktrees,
  undoCompositionRepositories,
  type CompositionSourceUndo,
} from './workspace-composition-records';
import { listWorkspaceItems } from './workspace-service';
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
  identitiesMatch,
  mapCandidatesToDestinationRepos,
  mapTrackedRepoBaseBranches,
  migratePipelineExecutions,
  discardLedgerIntentOfWorktreeMove,
  LEDGER_JOIN_NOT_SAVED_MESSAGE,
  notifyLedgerOfWorktreeMove,
  recordLedgerIntentOfWorktreeMove,
  resolveDestinationWorkspace,
  resolveSourceCandidates,
  restoreConsumedRoot,
  restorePipelineSnapshots,
  reverseMovedCheckouts,
  scaffoldDestinationRoot,
  type ConsumedRootRestore,
  type LedgerWorktreeMove,
  type RepoCandidate,
  type ResolvedDestination,
} from './adhoc-combine-core';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

const CANDIDATE_STATS_CONCURRENCY = 4;

interface CheckoutChangeStatus {
  branch: string;
  hasChanges: boolean;
}

function baseBranchFor(
  worktree: WorktreeData,
  repoId: string | undefined,
): string | undefined {
  const perRepo = repoId
    ? worktree.trackedRepoBaseBranches?.[repoId]?.trim()
    : undefined;
  if (perRepo) {
    return perRepo;
  }
  const fallback = worktree.trackedBaseBranch?.trim();
  return fallback || undefined;
}

async function getCheckoutChangeStatus(
  checkoutPath: string,
  baseBranch: string | undefined,
): Promise<CheckoutChangeStatus> {
  const [branch, uncommitted, ahead] = await settleAll([
    getCurrentBranch(checkoutPath).catch(() => 'unknown'),
    hasUncommittedChanges(checkoutPath),
    hasCommitsAhead(checkoutPath, baseBranch),
  ]);
  return { branch, hasChanges: uncommitted || ahead };
}

async function assertSourceBackedRootCanBeConsumed(params: {
  workspace: SidebarItem;
  worktree: WorktreeData;
  workspaceId: string;
  worktreeId: string;
}): Promise<void> {
  if (
    params.workspace.type !== 'multi-repo' ||
    !params.workspace.sourceRepoPath
  ) {
    return;
  }
  const rootPath = getWorkspaceWorktreeDir(
    params.workspaceId,
    params.worktreeId,
  );
  const status = await getCheckoutChangeStatus(
    rootPath,
    baseBranchFor(params.worktree, WORKSPACE_ROOT_REPO_ID),
  );
  if (!status.hasChanges) {
    return;
  }
  throw new Error(
    `Cannot join source-backed worktree "${params.worktree.branchName}" because its project root has uncommitted changes or commits ahead of the tracked base branch. Commit, discard, or move those root-level changes before joining this worktree.`,
  );
}

interface SourceRepoStatus {
  candidate: RepoCandidate;
  status: CheckoutChangeStatus;
}

async function resolveSourceRepoStatuses(
  sourceWorkspace: SidebarItem,
  sourceWorktree: WorktreeData,
): Promise<SourceRepoStatus[]> {
  const candidates = await resolveSourceCandidates(
    sourceWorkspace,
    sourceWorktree.id,
    [],
  );
  const statuses: SourceRepoStatus[] = [];
  for (const candidate of candidates) {
    if (!candidate.oldWorktreePath) {
      continue;
    }
    statuses.push({
      candidate,
      status: await getCheckoutChangeStatus(
        candidate.oldWorktreePath,
        baseBranchFor(sourceWorktree, candidate.sourceRepoId),
      ),
    });
  }
  return statuses;
}

async function listRunningPipelineWorktreeKeys(): Promise<Set<string>> {
  const summaries = await listExecutionSummaries(
    createElectronExecutionRuntime().executionsDir,
  );
  const keys = new Set<string>();
  for (const summary of summaries) {
    if (summary.status === 'running') {
      keys.add(`${summary.project_id}/${summary.worktree_id}`);
    }
  }
  return keys;
}

function resolveBusyReason(
  workspace: SidebarItem,
  worktree: WorktreeData,
  runningPipelineKeys: Set<string>,
): ExistingWorktreeJoinBusyReason | undefined {
  if (worktree.setupPhase === 'git-pending') {
    return 'setup-pending';
  }
  if (worktree.healthIssue) {
    return 'health-issue';
  }
  if (getActiveChatIds(workspace.id, worktree.id).length > 0) {
    return 'active-chat';
  }
  if (runningPipelineKeys.has(`${workspace.id}/${worktree.id}`)) {
    return 'running-pipeline';
  }
  return undefined;
}

/**
 * Derive the checkout path of `entry`'s repo inside a specific worktree of
 * `workspace`, mirroring how `resolveSourceCandidates` builds
 * `oldWorktreePath`: single-repo worktrees are the worktree dir itself, while
 * multi-repo checkouts live under `repos/<repoId>` inside the worktree dir.
 */
function candidateCheckoutPath(
  workspace: SidebarItem,
  worktreeId: string,
  entry: RepoCandidate,
): string | undefined {
  if (workspace.type === 'single-repo') {
    return getWorktreeDir(workspace.id, worktreeId);
  }
  return entry.sourceRepoId
    ? getWorkspaceWorktreeRepoDir(workspace.id, worktreeId, entry.sourceRepoId)
    : undefined;
}

async function buildJoinCandidate(params: {
  workspace: SidebarItem;
  worktree: WorktreeData;
  workspaceRepoEntries: RepoCandidate[];
  sourceRepoStatuses: SourceRepoStatus[];
  runningPipelineKeys: Set<string>;
}): Promise<ExistingWorktreeJoinCandidate> {
  const { workspace, worktree } = params;
  const busyReason = resolveBusyReason(
    workspace,
    worktree,
    params.runningPipelineKeys,
  );

  // Empty means "not computed" for busy candidates, not "no overlap" —
  // consumers must check busyReason first.
  const repoOverlaps: ExistingWorktreeJoinRepoOverlap[] = [];
  // Whether the target brings in any repo the source worktree lacks. A target
  // repo with no matching source repo is a "new" repo. Defaults false for busy
  // candidates (overlaps are not computed; busyReason takes precedence in UI).
  let addsNewRepo = false;
  if (!busyReason) {
    for (const target of params.workspaceRepoEntries) {
      const checkoutPath = candidateCheckoutPath(
        workspace,
        worktree.id,
        target,
      );
      if (!checkoutPath) {
        continue;
      }
      const sourceEntry = params.sourceRepoStatuses.find((entry) =>
        identitiesMatch(entry.candidate.identity, target.identity),
      );
      if (!sourceEntry) {
        addsNewRepo = true;
        continue;
      }
      const targetStatus = await getCheckoutChangeStatus(
        checkoutPath,
        baseBranchFor(worktree, target.sourceRepoId),
      );
      repoOverlaps.push({
        repoName: target.name,
        sourceHasChanges: sourceEntry.status.hasChanges,
        targetHasChanges: targetStatus.hasChanges,
        sourceBranch: sourceEntry.status.branch,
        targetBranch: targetStatus.branch,
      });
    }
  }

  return {
    workspaceId: workspace.id,
    worktreeId: worktree.id,
    branchName: worktree.branchName,
    busyReason,
    repoOverlaps,
    addsNewRepo,
  };
}

export async function listExistingWorktreeJoinOptions(
  request: ExistingWorktreeJoinOptionsRequest,
): Promise<ExistingWorktreeJoinOptionsResponse> {
  validateId(request.sourceWorkspaceId, 'sourceWorkspaceId');
  validateId(request.sourceWorktreeId, 'sourceWorktreeId');
  const items = await listWorkspaceItems();
  const sourceWorkspace = findWorkspace(items, request.sourceWorkspaceId);
  if (!sourceWorkspace) {
    throw new Error(`Project ${request.sourceWorkspaceId} not found`);
  }
  if (sourceWorkspace.type === 'cowork') {
    throw new Error(
      `Project ${request.sourceWorkspaceId} is a cowork project and has no worktrees to join`,
    );
  }
  const sourceWorktree = sourceWorkspace.worktrees.find(
    (worktree) => worktree.id === request.sourceWorktreeId,
  );
  if (!sourceWorktree) {
    throw new Error(`Worktree ${request.sourceWorktreeId} not found`);
  }

  const [sourceRepoStatuses, runningPipelineKeys] = await settleAll([
    resolveSourceRepoStatuses(sourceWorkspace, sourceWorktree),
    listRunningPipelineWorktreeKeys(),
  ]);

  const eligibleWorkspaces = [...items]
    .sort(compareSidebarItems)
    .filter(
      (item): item is SingleRepoSidebarItem | MultiRepoSidebarItem =>
        item.type !== 'cowork' &&
        item.id !== request.sourceWorkspaceId &&
        item.worktrees.length > 0,
    );

  // Resolve each workspace's repo identities once, not once per worktree:
  // identity resolution shells out to `git remote get-url` per repo and
  // identities do not vary by worktree — only checkout paths do, and those
  // are re-derived per candidate in `candidateCheckoutPath`. We use
  // `resolveSourceCandidates` (rather than `resolveJoinCandidates`) because
  // it supplies per-worktree checkout paths alongside repo identities.
  const repoEntriesByWorkspace = await mapWithConcurrency(
    eligibleWorkspaces,
    CANDIDATE_STATS_CONCURRENCY,
    (item) => resolveSourceCandidates(item, item.worktrees[0].id, []),
  );

  // Flatten all (workspace, worktree) pairs into one bounded pool so many
  // small workspaces don't degenerate into sequential per-workspace batches.
  const tasks: {
    workspace: SidebarItem;
    worktree: WorktreeData;
    workspaceRepoEntries: RepoCandidate[];
  }[] = eligibleWorkspaces.flatMap((item, index) =>
    item.worktrees.map((worktree) => ({
      workspace: item,
      worktree,
      workspaceRepoEntries: repoEntriesByWorkspace[index],
    })),
  );
  const candidates = await mapWithConcurrency(
    tasks,
    CANDIDATE_STATS_CONCURRENCY,
    (task) =>
      buildJoinCandidate({
        ...task,
        sourceRepoStatuses,
        runningPipelineKeys,
      }),
  );

  // Group results back, preserving the sorted workspace order and each
  // workspace's worktree order (mapWithConcurrency preserves input order).
  const candidatesByWorkspace = new Map<
    string,
    ExistingWorktreeJoinCandidate[]
  >();
  candidates.forEach((candidate, index) => {
    const workspaceId = tasks[index].workspace.id;
    const bucket = candidatesByWorkspace.get(workspaceId);
    if (bucket) {
      bucket.push(candidate);
    } else {
      candidatesByWorkspace.set(workspaceId, [candidate]);
    }
  });

  const groups: ExistingWorktreeJoinWorkspaceGroup[] = eligibleWorkspaces.map(
    (item) => ({
      workspaceId: item.id,
      workspaceName: item.name,
      color: item.color,
      isMultiRepo: item.type === 'multi-repo',
      repoCount:
        item.type === 'multi-repo'
          ? item.repos.filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
              .length
          : 1,
      temporary: item.type === 'multi-repo' && item.temporary === true,
      ...(item.type === 'single-repo' ? { repoPath: item.repoPath } : {}),
      candidates: candidatesByWorkspace.get(item.id) ?? [],
    }),
  );
  return { groups };
}

interface OverlapEntry {
  source: RepoCandidate;
  target: RepoCandidate;
  winner: 'source' | 'target';
}

/**
 * Classify repos present on both sides by identity. Both sides dirty
 * (uncommitted changes OR commits ahead of the tracked base) rejects the
 * whole combine; one dirty side wins its checkout; both clean → source wins.
 */
async function classifyOverlaps(params: {
  sourceWorktree: WorktreeData;
  joinWorktree: WorktreeData;
  sourceCandidates: RepoCandidate[];
  targetCandidates: RepoCandidate[];
}): Promise<OverlapEntry[]> {
  const overlaps: OverlapEntry[] = [];
  for (const target of params.targetCandidates) {
    const source = params.sourceCandidates.find((candidate) =>
      identitiesMatch(candidate.identity, target.identity),
    );
    if (!source?.oldWorktreePath || !target.oldWorktreePath) {
      continue;
    }
    const [sourceStatus, targetStatus] = await settleAll([
      getCheckoutChangeStatus(
        source.oldWorktreePath,
        baseBranchFor(params.sourceWorktree, source.sourceRepoId),
      ),
      getCheckoutChangeStatus(
        target.oldWorktreePath,
        baseBranchFor(params.joinWorktree, target.sourceRepoId),
      ),
    ]);
    if (sourceStatus.hasChanges && targetStatus.hasChanges) {
      throw new Error(
        `Both worktrees have changes in repo "${target.name}". Commit or discard changes on one side first.`,
      );
    }
    overlaps.push({
      source,
      target,
      winner: targetStatus.hasChanges ? 'target' : 'source',
    });
  }
  return overlaps;
}

interface PlannedMove {
  repoPath: string;
  oldPath: string;
  newPath: string;
}

interface PlannedCleanRemoval {
  repoPath: string;
  path: string;
}

/**
 * Rollback helper: re-create removed overlap-loser clean checkouts at their
 * original paths, in reverse order. Must run AFTER `reverseMovedCheckouts` —
 * in a target-wins swap the moved target checkout occupies the removed source
 * checkout's path and has to move back out before the checkout is re-created
 * there. Failures are pushed into `rollbackErrors`.
 */
async function recreateRemovedCleanCheckouts(
  removed: Array<PlannedCleanRemoval & { branch: string }>,
  rollbackErrors: unknown[],
): Promise<void> {
  for (const removal of [...removed].reverse()) {
    if (!(await pathExists(removal.path))) {
      await createWorktree(
        removal.repoPath,
        removal.path,
        removal.branch,
      ).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
  }
}

/**
 * Remove one overlap-loser clean checkout: record its current branch (with a
 * fallback for unreadable roots), remove the checkout, and push the removal
 * onto `removedCleanCheckouts` so rollback can re-create it.
 */
async function removeCleanCheckout(params: {
  repoPath: string;
  path: string;
  fallbackBranch: string;
  removedCleanCheckouts: Array<PlannedCleanRemoval & { branch: string }>;
}): Promise<void> {
  const branch =
    (await getCurrentBranch(params.path).catch(() => null)) ??
    params.fallbackBranch;
  await safeRemoveWorktree(
    params.repoPath,
    params.path,
    'adhoc existing-worktree join overlap cleanup',
  );
  params.removedCleanCheckouts.push({
    repoPath: params.repoPath,
    path: params.path,
    branch,
  });
}

/**
 * Multi-repo worktree roots get a file-path rewrite from the consumed root to
 * the destination root; single-repo worktrees are covered by their per-repo
 * checkout rewrite instead.
 */
function buildRootRewrite(
  workspace: SidebarItem,
  workspaceId: string,
  worktreeId: string,
  toRoot: string,
): { fromRoot: string; toRoot: string } | undefined {
  return workspace.type === 'multi-repo'
    ? {
        fromRoot: getWorkspaceWorktreeDir(workspaceId, worktreeId),
        toRoot,
      }
    : undefined;
}

/**
 * Decide, per destination repo, which side's checkout moves in and which
 * (overlap-loser) clean checkout is removed. Every union repo has exactly
 * one mover; no fresh checkouts are created in existing-worktree joins.
 */
function planCheckoutMoves(params: {
  sourcePairs: Array<{ candidate: RepoCandidate; repo: WorkspaceRepoData }>;
  targetPairs: Array<{ candidate: RepoCandidate; repo: WorkspaceRepoData }>;
  overlaps: OverlapEntry[];
  destinationWorkspaceId: string;
  destinationWorktreeId: string;
}): { moves: PlannedMove[]; cleanRemovals: PlannedCleanRemoval[] } {
  // Look overlaps up by candidate object reference, not identity key:
  // `classifyOverlaps` pairs candidates via `identitiesMatch`, which can match
  // a mixed-kind pair (remote vs path with the same repoPath) whose derived
  // identity keys differ. The overlap entries hold the same candidate objects
  // that appear in `sourcePairs`/`targetPairs`, so reference lookup is exact.
  const overlapBySource = new Map(
    params.overlaps.map((entry) => [entry.source, entry]),
  );
  const overlapByTarget = new Map(
    params.overlaps.map((entry) => [entry.target, entry]),
  );
  const moves: PlannedMove[] = [];
  const cleanRemovals: PlannedCleanRemoval[] = [];
  // Per repo and side: no overlap entry -> the owning side moves; winner ===
  // side -> that side moves; otherwise that side's clean checkout is removed.
  for (const { candidate, repo } of params.sourcePairs) {
    if (!candidate.oldWorktreePath) {
      continue;
    }
    const overlap = overlapBySource.get(candidate);
    if (overlap?.winner === 'target') {
      cleanRemovals.push({
        repoPath: candidate.repoPath,
        path: candidate.oldWorktreePath,
      });
    } else {
      moves.push({
        repoPath: candidate.repoPath,
        oldPath: candidate.oldWorktreePath,
        newPath: getWorkspaceWorktreeRepoDir(
          params.destinationWorkspaceId,
          params.destinationWorktreeId,
          repo.id,
        ),
      });
    }
  }
  for (const { candidate, repo } of params.targetPairs) {
    if (!candidate.oldWorktreePath) {
      continue;
    }
    const overlap = overlapByTarget.get(candidate);
    if (!overlap || overlap.winner === 'target') {
      moves.push({
        repoPath: candidate.repoPath,
        oldPath: candidate.oldWorktreePath,
        newPath: getWorkspaceWorktreeRepoDir(
          params.destinationWorkspaceId,
          params.destinationWorktreeId,
          repo.id,
        ),
      });
    } else {
      cleanRemovals.push({
        repoPath: candidate.repoPath,
        path: candidate.oldWorktreePath,
      });
    }
  }
  return { moves, cleanRemovals };
}

function buildExistingJoinDestinationCandidates(params: {
  sourceCandidates: RepoCandidate[];
  targetCandidates: RepoCandidate[];
  overlaps: OverlapEntry[];
}): RepoCandidate[] {
  const targetWinsBySource = new Map(
    params.overlaps
      .filter((entry) => entry.winner === 'target')
      .map((entry) => [entry.source, entry.target]),
  );
  return dedupeCandidates([
    ...params.sourceCandidates.map(
      (candidate) => targetWinsBySource.get(candidate) ?? candidate,
    ),
    ...filterNewJoinCandidates(
      params.sourceCandidates,
      params.targetCandidates,
    ),
  ]);
}

function filterTrackedRepoBaseBranches(
  tracked: Record<string, string> | undefined,
  allowedRepoIds: ReadonlySet<string>,
): Record<string, string> | undefined {
  if (!tracked) {
    return undefined;
  }
  const filtered = Object.fromEntries(
    Object.entries(tracked).filter(([repoId]) => allowedRepoIds.has(repoId)),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

async function combineWorktreeWithExistingWorktreeAdmitted(
  request: AdhocExistingWorktreeCombineRequest,
  commit: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<AdhocExistingWorktreeCombineResponse> {
  const readOptions =
    commit.expectedRevisions || attempt
      ? { persistRemovalCleanup: false as const }
      : undefined;
  validateId(request.sourceWorkspaceId, 'sourceWorkspaceId');
  validateId(request.sourceWorktreeId, 'sourceWorktreeId');
  validateId(request.joinWorkspaceId, 'joinWorkspaceId');
  validateId(request.joinWorktreeId, 'joinWorktreeId');
  if (request.joinWorkspaceId === request.sourceWorkspaceId) {
    throw new Error('Cannot join a worktree from the same project');
  }

  await assertLegacyCombineAllowed(
    [request.sourceWorkspaceId, request.joinWorkspaceId],
    request.mode,
  );
  // Retry path: the source worktree may already have been handled by a prior
  // combine attempt.
  const existingDestination = await findExistingAdhocDestination(
    request.sourceWorkspaceId,
    request.sourceWorktreeId,
    readOptions,
  );
  if (existingDestination) {
    const sourceWorktreeSurvived =
      existingDestination.workspace.id === request.sourceWorkspaceId &&
      existingDestination.worktree.id === request.sourceWorktreeId;
    const joined =
      existingDestination.worktree.adhocTransitionSource
        ?.joinedWorktreeMigration;
    if (
      joined &&
      joined.workspaceId === request.joinWorkspaceId &&
      joined.worktreeId === request.joinWorktreeId
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
        removedSourceWorktree: !sourceWorktreeSurvived,
        joinedWorktree: joined,
      };
    }
    if (!sourceWorktreeSurvived) {
      throw new Error(
        'This worktree was already combined into another project.',
      );
    }
    // Update-source joins keep the original worktree row alive and attach
    // retry metadata to it. A later join from that same live worktree should
    // proceed normally unless it is retrying the same joined worktree.
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
      `Project ${request.sourceWorkspaceId} is a cowork project and has no worktrees to join`,
    );
  }
  const joinWorkspace = findWorkspace(items, request.joinWorkspaceId);
  if (!joinWorkspace) {
    throw new Error(`Project ${request.joinWorkspaceId} not found`);
  }
  if (joinWorkspace.type === 'cowork') {
    throw new Error(
      `Project ${request.joinWorkspaceId} is a cowork project and has no worktrees to join`,
    );
  }
  const sourceWorktree = sourceWorkspace.worktrees.find(
    (worktree) => worktree.id === request.sourceWorktreeId,
  );
  if (!sourceWorktree) {
    throw new Error('Source worktree no longer exists.');
  }
  const joinWorktree = joinWorkspace.worktrees.find(
    (worktree) => worktree.id === request.joinWorktreeId,
  );
  if (!joinWorktree) {
    throw new Error('Selected worktree no longer exists.');
  }
  if (sourceWorktree.setupPhase === 'git-pending') {
    throw new Error('Cannot join while source worktree setup is pending.');
  }
  if (sourceWorktree.healthIssue) {
    throw new Error('Cannot join from a worktree with a health issue.');
  }
  if (joinWorktree.setupPhase === 'git-pending') {
    throw new Error(
      'Cannot join while the selected worktree setup is pending.',
    );
  }
  if (joinWorktree.healthIssue) {
    throw new Error('Cannot join a worktree with a health issue.');
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
  await assertNoActiveWorktreeWork(
    request.joinWorkspaceId,
    request.joinWorktreeId,
    {
      activeChats:
        'Stop active chats in the selected worktree before joining it.',
      runningScripts:
        'Wait for the selected worktree’s running scripts, such as setup, to finish before joining it.',
      runningPipelines:
        'Wait for the selected worktree’s running workflow executions to finish before joining it.',
    },
  );

  const sourceCandidates = await resolveSourceCandidates(
    sourceWorkspace,
    request.sourceWorktreeId,
    [],
  );
  const targetCandidates = await resolveSourceCandidates(
    joinWorkspace,
    request.joinWorktreeId,
    sourceCandidates,
  );
  await assertSourceCheckoutsExist(sourceCandidates);
  await assertSourceCheckoutsExist(targetCandidates, {
    missing: 'Cannot join worktree: selected worktree checkout is missing at',
    notWorktreeRoot:
      'Cannot join worktree: selected worktree checkout is not a Git worktree root at',
  });

  const overlaps = await classifyOverlaps({
    sourceWorktree,
    joinWorktree,
    sourceCandidates,
    targetCandidates,
  });
  if (request.mode === 'temporary') {
    await assertSourceBackedRootCanBeConsumed({
      workspace: sourceWorkspace,
      worktree: sourceWorktree,
      workspaceId: request.sourceWorkspaceId,
      worktreeId: request.sourceWorktreeId,
    });
  }
  await assertSourceBackedRootCanBeConsumed({
    workspace: joinWorkspace,
    worktree: joinWorktree,
    workspaceId: request.joinWorkspaceId,
    worktreeId: request.joinWorktreeId,
  });

  // Reject no-op joins: when the target adds no new repos and the source wins
  // every overlap (target clean), nothing would be merged and the target
  // worktree would be consumed for no benefit. The UI disables these too.
  const newTargetCandidates = filterNewJoinCandidates(
    sourceCandidates,
    targetCandidates,
  );
  if (
    newTargetCandidates.length === 0 &&
    overlaps.length > 0 &&
    overlaps.every((overlap) => overlap.winner === 'source')
  ) {
    throw new Error(
      'Joining this worktree would make no changes: its repos are already here with no changes to bring over.',
    );
  }

  if (request.mode === 'update-source-workspace') {
    return handleExistingUpdateSourceWorkspace({
      commit,
      attempt,
      request,
      sourceWorkspace,
      sourceWorktree,
      joinWorkspace,
      joinWorktree,
      sourceCandidates,
      targetCandidates,
      overlaps,
    });
  }

  const finalCandidates = buildExistingJoinDestinationCandidates({
    sourceCandidates,
    targetCandidates,
    overlaps,
  });
  const destination = await resolveDestinationWorkspace(
    items,
    finalCandidates,
    {
      repoPathsMustMatch: true,
      reuseOwner: sourceWorkspace.owner,
      beforeEffects: attempt?.beforeEffects,
      commit,
    },
  );
  return handleExistingTemporaryCombine({
    commit,
    attempt,
    request,
    sourceWorkspace,
    sourceWorktree,
    joinWorkspace,
    joinWorktree,
    sourceCandidates,
    targetCandidates,
    overlaps,
    destination,
  });
}

/**
 * Update mode: the source workspace permanently absorbs the joined worktree
 * IN PLACE — the source worktree itself is the destination and nothing new is
 * created. Unlike the workspace-join update mode in
 * `adhoc-multi-repo-workspaces.ts`, checkouts are MOVED in from the joined
 * worktree (never freshly created) and a join that adds no new repos is
 * allowed: absorbing checkouts alone is meaningful.
 */
async function handleExistingUpdateSourceWorkspace(params: {
  commit: W5CommitOptions;
  attempt?: W5KeyedAttempt;
  request: AdhocExistingWorktreeCombineRequest;
  sourceWorkspace: SidebarItem;
  sourceWorktree: WorktreeData;
  joinWorkspace: SidebarItem;
  joinWorktree: WorktreeData;
  sourceCandidates: RepoCandidate[];
  targetCandidates: RepoCandidate[];
  overlaps: OverlapEntry[];
}): Promise<AdhocExistingWorktreeCombineResponse> {
  const { commit, request } = params;
  if (params.sourceWorkspace.type !== 'multi-repo') {
    throw new Error(
      'update-source-workspace mode requires a multi-repo source project',
    );
  }
  if (params.sourceWorkspace.temporary === true) {
    throw new Error(
      'Cannot update a temporary project. Promote it before updating its repo set.',
    );
  }

  const sourceWorktreeRoot = getWorkspaceWorktreeDir(
    request.sourceWorkspaceId,
    request.sourceWorktreeId,
  );
  const targetOnlyCandidates = filterNewJoinCandidates(
    params.sourceCandidates,
    params.targetCandidates,
  );

  const addedRepositories: WorkspaceRepoData[] = [];
  const moved: PlannedMove[] = [];
  const removedCleanCheckouts: Array<PlannedCleanRemoval & { branch: string }> =
    [];
  const createdSymlinks: string[] = [];
  let targetRootRestore: ConsumedRootRestore | undefined;
  let targetPipelineSnapshots = new Map<string, ExecutionState>();
  const targetRepoMappings: AdhocMultiRepoRepoMapping[] = [];
  let sourceUndo: CompositionSourceUndo | undefined;
  let removedJoinRows: RemovedCompositionRows = { rows: [], order: [] };
  let joinRowsRemoved = false;
  const targetKeptDestinationRepoIds = new Set<string>();
  const destinationRepos = [...params.sourceWorkspace.repos];
  // The joined worktree continues as the source row, which keeps its own ID
  // and creation time.
  const ledgerMove: LedgerWorktreeMove = {
    from: {
      workspaceId: request.joinWorkspaceId,
      worktree: params.joinWorktree,
    },
    to: {
      workspaceId: request.sourceWorkspaceId,
      worktree: params.sourceWorktree,
    },
  };
  let ledgerMoveRecorded = false;

  try {
    // 1. Target-only repos: extend the workspace config, then MOVE the
    //    target's checkout in (the workspace-join flow creates fresh
    //    checkouts here; existing-worktree joins absorb instead).
    for (const candidate of targetOnlyCandidates) {
      if (!candidate.oldWorktreePath) {
        continue;
      }
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
      destinationRepos.push(repo);
      addedRepositories.push(repo);
      const checkoutPath = getWorkspaceWorktreeRepoDir(
        request.sourceWorkspaceId,
        request.sourceWorktreeId,
        repo.id,
      );
      params.attempt?.beforeEffects();
      await mkdir(dirname(checkoutPath), { recursive: true });
      await moveWorktree(
        candidate.repoPath,
        candidate.oldWorktreePath,
        checkoutPath,
      );
      moved.push({
        repoPath: candidate.repoPath,
        oldPath: candidate.oldWorktreePath,
        newPath: checkoutPath,
      });
      targetRepoMappings.push({
        sourceRepoId: candidate.sourceRepoId,
        destinationRepoId: repo.id,
        repoName: repo.name,
        repoPath: repo.repoPath,
        oldWorktreePath: candidate.oldWorktreePath,
        newWorktreePath: checkoutPath,
      });
      targetKeptDestinationRepoIds.add(repo.id);
    }

    // 2. Overlapping repos: swap or drop the target checkout in place.
    for (const entry of params.overlaps) {
      if (!entry.source.oldWorktreePath || !entry.target.oldWorktreePath) {
        continue;
      }
      const destinationRepoId = entry.source.sourceRepoId;
      if (entry.winner === 'target') {
        if (entry.source.repoPath !== entry.target.repoPath) {
          throw new Error(
            `Cannot update source project with changes from "${entry.target.name}" because its checkout belongs to a different local clone. Use temporary mode instead.`,
          );
        }
        params.attempt?.beforeEffects();
        await removeCleanCheckout({
          repoPath: entry.source.repoPath,
          path: entry.source.oldWorktreePath,
          fallbackBranch: params.sourceWorktree.branchName,
          removedCleanCheckouts,
        });
        await moveWorktree(
          entry.target.repoPath,
          entry.target.oldWorktreePath,
          entry.source.oldWorktreePath,
        );
        moved.push({
          repoPath: entry.target.repoPath,
          oldPath: entry.target.oldWorktreePath,
          newPath: entry.source.oldWorktreePath,
        });
        if (destinationRepoId) {
          targetKeptDestinationRepoIds.add(destinationRepoId);
        }
      } else {
        params.attempt?.beforeEffects();
        await removeCleanCheckout({
          repoPath: entry.target.repoPath,
          path: entry.target.oldWorktreePath,
          fallbackBranch: params.joinWorktree.branchName,
          removedCleanCheckouts,
        });
      }
      if (destinationRepoId) {
        targetRepoMappings.push({
          sourceRepoId: entry.target.sourceRepoId,
          destinationRepoId,
          repoName: entry.target.name,
          repoPath: entry.target.repoPath,
          oldWorktreePath: entry.target.oldWorktreePath,
          newWorktreePath: entry.source.oldWorktreePath,
        });
      }
    }

    // 3. Consume the joined worktree root -> symlink to the source worktree.
    const targetRootRewrite = buildRootRewrite(
      params.joinWorkspace,
      request.joinWorkspaceId,
      request.joinWorktreeId,
      sourceWorktreeRoot,
    );
    const targetCompatibilitySymlinks: WorktreeCompatibilitySymlink[] = [];
    params.attempt?.beforeEffects();
    const targetRootLink = await consumeWorktreeRootWithSymlink({
      workspace: params.joinWorkspace,
      workspaceId: request.joinWorkspaceId,
      worktreeId: request.joinWorktreeId,
      repoMappings: targetRepoMappings,
      destinationRoot: sourceWorktreeRoot,
      fallbackBranchName: params.sourceWorktree.branchName,
      onRootConsumed: (restore) => {
        targetRootRestore = restore;
      },
    });
    if (targetRootLink) {
      createdSymlinks.push(targetRootLink.path);
      targetCompatibilitySymlinks.push(targetRootLink);
    }
    const targetRepoIdRewrites = buildRepoIdRewrites(targetRepoMappings);
    const targetRootRepoIdRewrite = buildSourceRootRepoIdRewrite(
      params.joinWorkspace,
      targetRepoMappings,
    );
    const targetFilePathRewrites = buildFilePathRewrites(
      targetRepoMappings,
      targetRootRewrite,
    );
    const joinedWorktreeMigration: AdhocJoinedWorktreeMigration = {
      workspaceId: request.joinWorkspaceId,
      worktreeId: request.joinWorktreeId,
      repoMappings: targetRepoMappings,
      selectedRepoIdRewrites: targetRepoIdRewrites,
      sourceRootRepoIdRewrite: targetRootRepoIdRewrite,
      filePathRewrites: targetFilePathRewrites,
      compatibilitySymlinks: targetCompatibilitySymlinks,
    };

    const finalSourceCandidates = dedupeCandidates([
      ...params.sourceCandidates,
      ...targetOnlyCandidates,
    ]);
    const sourceRepoMappings = (
      await mapCandidatesToDestinationRepos(finalSourceCandidates, {
        ...params.sourceWorkspace,
        repos: destinationRepos,
      })
    ).map(({ candidate, repo }) =>
      buildRepoMapping(
        candidate,
        repo,
        request.sourceWorkspaceId,
        request.sourceWorktreeId,
      ),
    );
    const selectedRepoIdRewrites = buildRepoIdRewrites(sourceRepoMappings);
    const sourceRootRepoIdRewrite = buildSourceRootRepoIdRewrite(
      params.sourceWorkspace,
      sourceRepoMappings,
    );
    const filePathRewrites = buildFilePathRewrites(sourceRepoMappings);

    // 4. Migrate the joined worktree's pipeline executions onto the source
    //    worktree, merge its tracked base branches, then remove it.
    targetPipelineSnapshots = await migratePipelineExecutions({
      sourceWorkspaceId: request.joinWorkspaceId,
      sourceWorktreeId: request.joinWorktreeId,
      destinationWorkspaceId: request.sourceWorkspaceId,
      destinationWorktreeId: request.sourceWorktreeId,
      rewrites: targetFilePathRewrites,
    });
    const targetTracked = filterTrackedRepoBaseBranches(
      mapTrackedRepoBaseBranches(params.joinWorktree, targetRepoIdRewrites),
      targetKeptDestinationRepoIds,
    );
    // Durable before the rows change, so an exit before the participant
    // cannot let startup retire the joined worktree's scope. Without it, the
    // join does not commit.
    ledgerMoveRecorded = true;
    if (!(await recordLedgerIntentOfWorktreeMove(ledgerMove))) {
      throw new Error(LEDGER_JOIN_NOT_SAVED_MESSAGE);
    }
    sourceUndo = await commitW5BoundaryStep(
      commit,
      w5CompositionLocks({ lists: [request.sourceWorkspaceId] }),
      () =>
        recordCompositionSource({
          source: 'existing_worktree_join',
          workspaceId: request.sourceWorkspaceId,
          worktree: params.sourceWorktree,
          trackedBranches: targetTracked,
          compatibilitySymlinks: targetCompatibilitySymlinks,
          transition: {
            sourceWorkspaceId: request.sourceWorkspaceId,
            sourceWorktreeId: request.sourceWorktreeId,
            sourceRepoIds: params.sourceCandidates
              .map((candidate) => candidate.sourceRepoId)
              .filter((repoId): repoId is string => repoId !== undefined),
            repoMappings: sourceRepoMappings,
            selectedRepoIdRewrites,
            sourceRootRepoIdRewrite,
            filePathRewrites,
            joinedWorktreeMigration,
            createdAt: new Date().toISOString(),
          },
        }),
    );
    removedJoinRows = await commitW5BoundaryStep(
      commit,
      w5CompositionLocks({ lists: [request.joinWorkspaceId] }),
      () =>
        removeCompositionWorktree({
          source: 'existing_worktree_join',
          workspaceId: request.joinWorkspaceId,
          worktree: params.joinWorktree,
        }),
    );
    joinRowsRemoved = true;
    const joinedRemovedTemporaryWorkspaceId =
      await getEmptyTemporaryWorkspaceId(request.joinWorkspaceId);

    // 5. Build the response off the refreshed source workspace.
    const base = await buildUpdatedSourceWorkspaceResponse({
      sourceWorkspaceId: request.sourceWorkspaceId,
      sourceWorktreeId: request.sourceWorktreeId,
      sourceWorkspace: params.sourceWorkspace,
      fallbackWorktree: params.sourceWorktree,
      finalCandidates: dedupeCandidates([
        ...params.sourceCandidates,
        ...targetOnlyCandidates,
      ]),
    });
    // Committed: the source worktree absorbed the joined one. The joined
    // worktree's ledger moves into it, unless the source has a ledger of its
    // own: then the joined one retires, since one worktree keeps one ledger.
    notifyLedgerOfWorktreeMove(ledgerMove);
    return {
      ...base,
      joinedWorktree: {
        ...joinedWorktreeMigration,
        removedTemporaryWorkspaceId: joinedRemovedTemporaryWorkspaceId,
      },
    };
  } catch (error) {
    if (ledgerMoveRecorded) discardLedgerIntentOfWorktreeMove(ledgerMove);
    await restorePipelineSnapshots(targetPipelineSnapshots).catch(() => {});
    for (const linkPath of createdSymlinks) {
      await rm(linkPath, { force: true }).catch(() => {});
    }
    const rollbackErrors: unknown[] = [];
    await restoreConsumedRoot(targetRootRestore, rollbackErrors);
    await reverseMovedCheckouts(moved, rollbackErrors);
    await recreateRemovedCleanCheckouts(removedCleanCheckouts, rollbackErrors);
    if (sourceUndo) {
      await undoCompositionSource(sourceUndo).catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    if (joinRowsRemoved) {
      await restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: request.joinWorkspaceId,
        ...removedJoinRows,
      }).catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    if (addedRepositories.length > 0) {
      await undoCompositionRepositories({
        source: 'existing_worktree_join',
        workspaceId: request.sourceWorkspaceId,
        repositories: addedRepositories,
      }).catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    if (rollbackErrors.length > 0) {
      throw buildRollbackFailureError(
        error,
        rollbackErrors,
        'Join worktree failed and rollback did not fully restore checkouts',
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

interface SideMigrationArtifacts {
  pairs: Array<{ candidate: RepoCandidate; repo: WorkspaceRepoData }>;
  repoMappings: AdhocMultiRepoRepoMapping[];
  repoIdRewrites: Record<string, string>;
  rootRepoIdRewrite: string | undefined;
  filePathRewrites: Array<{ fromRoot: string; toRoot: string }>;
}

/**
 * Build one consumed side's migration artifacts: destination repo pairs, repo
 * mappings, repo-id rewrites, the single-repo root rewrite, and file-path
 * rewrites (including the multi-repo worktree-root rewrite). Runs identically
 * for the source side and the joined ("target") side.
 */
async function buildSideMigrationArtifacts(params: {
  workspace: SidebarItem;
  workspaceId: string;
  worktreeId: string;
  candidates: RepoCandidate[];
  destinationWorkspace: MultiRepoSidebarItem;
  destinationWorktreeId: string;
  destinationRoot: string;
}): Promise<SideMigrationArtifacts> {
  const pairs = await mapCandidatesToDestinationRepos(
    params.candidates,
    params.destinationWorkspace,
  );
  const repoMappings = pairs.map(({ candidate, repo }) =>
    buildRepoMapping(
      candidate,
      repo,
      params.destinationWorkspace.id,
      params.destinationWorktreeId,
    ),
  );
  const rootRewrite = buildRootRewrite(
    params.workspace,
    params.workspaceId,
    params.worktreeId,
    params.destinationRoot,
  );
  return {
    pairs,
    repoMappings,
    repoIdRewrites: buildRepoIdRewrites(repoMappings),
    rootRepoIdRewrite: buildSourceRootRepoIdRewrite(
      params.workspace,
      repoMappings,
    ),
    filePathRewrites: buildFilePathRewrites(repoMappings, rootRewrite),
  };
}

async function handleExistingTemporaryCombine(params: {
  commit: W5CommitOptions;
  attempt?: W5KeyedAttempt;
  request: AdhocExistingWorktreeCombineRequest;
  sourceWorkspace: SidebarItem;
  sourceWorktree: WorktreeData;
  joinWorkspace: SidebarItem;
  joinWorktree: WorktreeData;
  sourceCandidates: RepoCandidate[];
  targetCandidates: RepoCandidate[];
  overlaps: OverlapEntry[];
  destination: ResolvedDestination;
}): Promise<AdhocExistingWorktreeCombineResponse> {
  const { commit, request, destination } = params;
  const destinationWorktreeId = await allocateAdhocDestinationWorktreeId(
    destination.workspace.id,
    request.sourceWorktreeId,
  );
  const destinationRoot = getWorkspaceWorktreeDir(
    destination.workspace.id,
    destinationWorktreeId,
  );

  const {
    pairs: sourcePairs,
    repoMappings: sourceRepoMappings,
    repoIdRewrites: selectedRepoIdRewrites,
    rootRepoIdRewrite: sourceRootRepoIdRewrite,
    filePathRewrites,
  } = await buildSideMigrationArtifacts({
    workspace: params.sourceWorkspace,
    workspaceId: request.sourceWorkspaceId,
    worktreeId: request.sourceWorktreeId,
    candidates: params.sourceCandidates,
    destinationWorkspace: destination.workspace,
    destinationWorktreeId,
    destinationRoot,
  });
  const {
    pairs: targetPairs,
    repoMappings: targetRepoMappings,
    repoIdRewrites: targetRepoIdRewrites,
    rootRepoIdRewrite: targetRootRepoIdRewrite,
    filePathRewrites: targetFilePathRewrites,
  } = await buildSideMigrationArtifacts({
    workspace: params.joinWorkspace,
    workspaceId: request.joinWorkspaceId,
    worktreeId: request.joinWorktreeId,
    candidates: params.targetCandidates,
    destinationWorkspace: destination.workspace,
    destinationWorktreeId,
    destinationRoot,
  });

  const { moves, cleanRemovals } = planCheckoutMoves({
    sourcePairs,
    targetPairs,
    overlaps: params.overlaps,
    destinationWorkspaceId: destination.workspace.id,
    destinationWorktreeId,
  });

  const moved: PlannedMove[] = [];
  const removedCleanCheckouts: Array<PlannedCleanRemoval & { branch: string }> =
    [];
  const createdSymlinks: string[] = [];
  let sourceRootRestore: ConsumedRootRestore | undefined;
  let targetRootRestore: ConsumedRootRestore | undefined;
  let pipelineSnapshots = new Map<string, ExecutionState>();
  let targetPipelineSnapshots = new Map<string, ExecutionState>();
  let destinationUndo: JoinedWorktreeUndo | undefined;
  let removedSourceRows: RemovedCompositionRows = { rows: [], order: [] };
  let sourceRowsRemoved = false;
  let removedJoinRows: RemovedCompositionRows = { rows: [], order: [] };
  let joinRowsRemoved = false;
  // Both worktrees continue as the combined row, which keeps the source's
  // creation time. The source's ledger is offered first, so it is the one
  // kept when both have a ledger.
  const combined = {
    workspaceId: destination.workspace.id,
    worktree: {
      id: destinationWorktreeId,
      createdAt: params.sourceWorktree.createdAt,
    },
  };
  const ledgerMoves: LedgerWorktreeMove[] = [
    {
      from: {
        workspaceId: request.sourceWorkspaceId,
        worktree: params.sourceWorktree,
      },
      to: combined,
    },
    {
      from: {
        workspaceId: request.joinWorkspaceId,
        worktree: params.joinWorktree,
      },
      to: combined,
    },
  ];
  let ledgerMovesRecorded = false;

  try {
    params.attempt?.beforeEffects();
    await scaffoldDestinationRoot(destinationRoot, destination.workspace.name);

    // Clean removals run BEFORE moves so both roots end repo-empty before
    // root consumption; rollback restores moves before re-creating removed
    // checkouts.
    for (const removal of cleanRemovals) {
      await removeCleanCheckout({
        repoPath: removal.repoPath,
        path: removal.path,
        fallbackBranch: destinationWorktreeId,
        removedCleanCheckouts,
      });
    }
    for (const move of moves) {
      await mkdir(dirname(move.newPath), { recursive: true });
      if (!(await pathExists(move.newPath))) {
        await moveWorktree(move.repoPath, move.oldPath, move.newPath);
        moved.push(move);
      }
    }

    const compatibilitySymlinks: WorktreeCompatibilitySymlink[] = [];
    const targetCompatibilitySymlinks: WorktreeCompatibilitySymlink[] = [];
    const sourceRootLink = await consumeWorktreeRootWithSymlink({
      workspace: params.sourceWorkspace,
      workspaceId: request.sourceWorkspaceId,
      worktreeId: request.sourceWorktreeId,
      repoMappings: sourceRepoMappings,
      destinationRoot,
      fallbackBranchName: destinationWorktreeId,
      onRootConsumed: (restore) => {
        sourceRootRestore = restore;
      },
    });
    if (sourceRootLink) {
      createdSymlinks.push(sourceRootLink.path);
      compatibilitySymlinks.push(sourceRootLink);
    }
    const targetRootLink = await consumeWorktreeRootWithSymlink({
      workspace: params.joinWorkspace,
      workspaceId: request.joinWorkspaceId,
      worktreeId: request.joinWorktreeId,
      repoMappings: targetRepoMappings,
      destinationRoot,
      fallbackBranchName: destinationWorktreeId,
      onRootConsumed: (restore) => {
        targetRootRestore = restore;
      },
    });
    if (targetRootLink) {
      createdSymlinks.push(targetRootLink.path);
      targetCompatibilitySymlinks.push(targetRootLink);
    }

    pipelineSnapshots = await migratePipelineExecutions({
      sourceWorkspaceId: request.sourceWorkspaceId,
      sourceWorktreeId: request.sourceWorktreeId,
      destinationWorkspaceId: destination.workspace.id,
      destinationWorktreeId,
      rewrites: filePathRewrites,
    });
    targetPipelineSnapshots = await migratePipelineExecutions({
      sourceWorkspaceId: request.joinWorkspaceId,
      sourceWorktreeId: request.joinWorktreeId,
      destinationWorkspaceId: destination.workspace.id,
      destinationWorktreeId,
      rewrites: targetFilePathRewrites,
    });

    const joinedWorktreeMigration: AdhocJoinedWorktreeMigration = {
      workspaceId: request.joinWorkspaceId,
      worktreeId: request.joinWorktreeId,
      repoMappings: targetRepoMappings,
      selectedRepoIdRewrites: targetRepoIdRewrites,
      sourceRootRepoIdRewrite: targetRootRepoIdRewrite,
      filePathRewrites: targetFilePathRewrites,
      compatibilitySymlinks: targetCompatibilitySymlinks,
    };

    // Durable before the commit, so an exit before the participant cannot
    // let startup retire either scope; the combined ID may be suffixed.
    // Without them, the combine does not commit.
    ledgerMovesRecorded = true;
    for (const move of ledgerMoves) {
      if (!(await recordLedgerIntentOfWorktreeMove(move))) {
        throw new Error(LEDGER_JOIN_NOT_SAVED_MESSAGE);
      }
    }
    const targetKeptDestinationRepoIds = new Set(
      targetPairs
        .filter(({ candidate }) => {
          const overlap = params.overlaps.find(
            (entry) => entry.target === candidate,
          );
          return !overlap || overlap.winner === 'target';
        })
        .map(({ repo }) => repo.id),
    );
    const targetTracked = filterTrackedRepoBaseBranches(
      mapTrackedRepoBaseBranches(params.joinWorktree, targetRepoIdRewrites),
      targetKeptDestinationRepoIds,
    );
    const destinationRecord = await commitW5BoundaryStep(
      commit,
      w5CompositionLocks({ lists: [destination.workspace.id] }),
      () =>
        recordJoinedWorktree({
          source: 'existing_worktree_join',
          workspaceId: destination.workspace.id,
          worktreeId: destinationWorktreeId,
          sourceWorktree: params.sourceWorktree,
          consumedWorktrees: [params.joinWorktree],
          repoIdRewrites: selectedRepoIdRewrites,
          compatibilitySymlinks: [
            ...compatibilitySymlinks,
            ...targetCompatibilitySymlinks,
          ],
          joinedTrackedBranches: targetTracked,
          transition: {
            sourceWorkspaceId: request.sourceWorkspaceId,
            sourceWorktreeId: request.sourceWorktreeId,
            sourceRepoIds: params.sourceCandidates
              .map((candidate) => candidate.sourceRepoId)
              .filter((repoId): repoId is string => repoId !== undefined),
            repoMappings: sourceRepoMappings,
            selectedRepoIdRewrites,
            sourceRootRepoIdRewrite,
            filePathRewrites,
            joinedWorktreeMigration,
            createdAt: new Date().toISOString(),
          },
        }),
    );
    const destinationWorktree = destinationRecord.worktree;
    destinationUndo = destinationRecord.undo;

    let removedTemporaryWorkspaceId: string | undefined;
    await commitW5BoundaryStep(
      commit,
      w5CompositionLocks({
        lists: [request.sourceWorkspaceId, request.joinWorkspaceId],
      }),
      async () => {
        removedSourceRows = await removeCompositionWorktree({
          source: 'existing_worktree_join',
          workspaceId: request.sourceWorkspaceId,
          worktree: params.sourceWorktree,
        });
        sourceRowsRemoved = true;
        removedTemporaryWorkspaceId = await getEmptyTemporaryWorkspaceId(
          request.sourceWorkspaceId,
        );
        removedJoinRows = await removeCompositionWorktree({
          source: 'existing_worktree_join',
          workspaceId: request.joinWorkspaceId,
          worktree: params.joinWorktree,
        });
        joinRowsRemoved = true;
      },
    );
    const joinedRemovedTemporaryWorkspaceId =
      await getEmptyTemporaryWorkspaceId(request.joinWorkspaceId);

    const refreshedDestination = (await listWorkspaceItems()).find(
      (item): item is MultiRepoSidebarItem =>
        item.type === 'multi-repo' && item.id === destination.workspace.id,
    );
    // Committed: both worktrees now live in the combined destination. The
    // source's ledger moves first; the joined worktree's moves only when the
    // source had none, and retires otherwise.
    for (const move of ledgerMoves) notifyLedgerOfWorktreeMove(move);
    return {
      sourceWorkspaceId: request.sourceWorkspaceId,
      sourceWorktreeId: request.sourceWorktreeId,
      destinationWorkspaceId: destination.workspace.id,
      destinationWorktreeId,
      destinationWorkspace: refreshedDestination ?? destination.workspace,
      destinationWorktree,
      repoMappings: sourceRepoMappings,
      selectedRepoIdRewrites,
      sourceRootRepoIdRewrite,
      filePathRewrites,
      compatibilitySymlinks,
      createdTemporaryWorkspace: destination.createdTemporaryWorkspace,
      reusedWorkspace: destination.reusedWorkspace,
      removedSourceWorktree: true,
      removedTemporaryWorkspaceId,
      joinedWorktree: {
        ...joinedWorktreeMigration,
        removedTemporaryWorkspaceId: joinedRemovedTemporaryWorkspaceId,
      },
    };
  } catch (error) {
    if (ledgerMovesRecorded) {
      for (const move of ledgerMoves) discardLedgerIntentOfWorktreeMove(move);
    }
    await restorePipelineSnapshots(pipelineSnapshots).catch(() => {});
    await restorePipelineSnapshots(targetPipelineSnapshots).catch(() => {});
    if (destinationUndo) {
      await undoJoinedWorktree(destinationUndo).catch(() => undefined);
    }
    for (const linkPath of createdSymlinks) {
      await rm(linkPath, { force: true }).catch(() => {});
    }
    const rollbackErrors: unknown[] = [];
    await restoreConsumedRoot(sourceRootRestore, rollbackErrors);
    await restoreConsumedRoot(targetRootRestore, rollbackErrors);
    await reverseMovedCheckouts(moved, rollbackErrors);
    await recreateRemovedCleanCheckouts(removedCleanCheckouts, rollbackErrors);
    if (sourceRowsRemoved) {
      await restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: request.sourceWorkspaceId,
        ...removedSourceRows,
      }).catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    if (joinRowsRemoved) {
      await restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: request.joinWorkspaceId,
        ...removedJoinRows,
      }).catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    // Only destroy the destination when rollback fully restored both sides —
    // after a partial rollback it may hold the only copy of a checkout.
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
      'Join worktree failed and rollback did not fully restore checkouts',
      destinationRoot,
    );
  }
}

export type ExistingWorktreeCombineRequest =
  AdhocExistingWorktreeCombineRequest & W5CompositionOptions;
export function combineWorktreeWithExistingWorktree(
  request: ExistingWorktreeCombineRequest & { idempotencyKey: string },
): Promise<W5ExistingCombineOutcome>;
export function combineWorktreeWithExistingWorktree(
  request: ExistingWorktreeCombineRequest & { idempotencyKey?: undefined },
): Promise<AdhocExistingWorktreeCombineResponse>;
export function combineWorktreeWithExistingWorktree(
  request: ExistingWorktreeCombineRequest,
): Promise<AdhocExistingWorktreeCombineResponse | W5ExistingCombineOutcome>;
export function combineWorktreeWithExistingWorktree(
  request: ExistingWorktreeCombineRequest,
): Promise<AdhocExistingWorktreeCombineResponse | W5ExistingCombineOutcome> {
  const { expectedRevisions, idempotencyKey } = request;
  return runW5BoundaryOperation<
    AdhocExistingWorktreeCombineResponse | W5ExistingCombineOutcome
  >(
    {
      operation: 'core.workspace.composition.combine',
      caller: 'desktop-host:composition-combine',
      idempotencyKey,
      parameters: {
        variant: 'existing-worktree',
        sourceWorkspaceId: request.sourceWorkspaceId,
        sourceWorktreeId: request.sourceWorktreeId,
        joinWorkspaceId: request.joinWorkspaceId,
        joinWorktreeId: request.joinWorktreeId,
        mode: request.mode,
      },
      isPreEffectRefusal: (error) => error instanceof W5RevisionConflictError,
    },
    (outcome) =>
      decodeW5CompositionOutcome(w5ExistingCombineOutcomeParser, outcome),
    async (commit, attempt) => {
      commit.expectedRevisions = expectedRevisions;
      await checkW5CompositionRevisions(commit);
      return admitW5Composition(attempt, () =>
        combineWorktreeWithExistingWorktreeAdmitted(request, commit, attempt),
      );
    },
  );
}
