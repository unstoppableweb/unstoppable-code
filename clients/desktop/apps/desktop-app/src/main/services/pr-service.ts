import type {
  CheckDetail,
  RemoteControlPrRefreshPayload,
  RemoteControlPullRequestCheckDetail,
  RemoteControlPullRequestRepo,
  RemoteControlPullRequestRepoStatus,
  RemoteControlPullRequestState,
} from '@canopy/desktop-shared/types';
import type {
  PrStatusData,
  RepoPrStatus,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import { isPrReadyToMerge } from '@canopy/desktop-shared/types/github';
import {
  clearStalePrCreationProgress,
  getPrCreationProgress,
} from './pr-creation-progress';
import { getPrMergeProgressFeed } from './pr-merge-progress';
import { fetchPrStatusForWorktree } from '../lib/github-pr';
import { validateId } from '../lib/validation';

function toRemoteControlReviewStatus(
  status: 'approved' | 'changes_requested' | 'pending' | 'none' | undefined,
): 'approved' | 'changes-requested' | 'pending' | 'none' | undefined {
  if (status === 'approved') return 'approved';
  if (status === 'changes_requested') return 'changes-requested';
  if (status === 'pending') return 'pending';
  // CAN-1528 L2: surface "no reviews" explicitly instead of collapsing it
  // into an absent field; renderers treat absent and 'none' the same.
  if (status === 'none') return 'none';
  return undefined;
}

/**
 * Map the desktop's per-check `CheckStatus` (`'passing' | 'failing' |
 * 'pending' | 'neutral' | 'none'`) onto the portal protocol's narrower
 * per-check status union. `'none'` is dropped — `none` is meaningful for
 * the aggregate "no checks configured" state but not for an individual
 * check row.
 */
function toRemoteControlCheckDetails(
  details: CheckDetail[] | undefined,
): RemoteControlPullRequestCheckDetail[] | undefined {
  if (!details || details.length === 0) return undefined;
  const mapped: RemoteControlPullRequestCheckDetail[] = [];
  for (const check of details) {
    let status: RemoteControlPullRequestCheckDetail['status'] | null = null;
    if (check.status === 'passing') status = 'success';
    else if (check.status === 'failing') status = 'failure';
    else if (check.status === 'pending') status = 'pending';
    else if (check.status === 'neutral') status = 'neutral';
    if (status !== null) {
      mapped.push({
        name: check.name,
        status,
        ...(check.executionState === undefined
          ? {}
          : { executionState: check.executionState }),
        detailsUrl: check.detailsUrl,
      });
    }
  }
  return mapped.length > 0 ? mapped : undefined;
}

/**
 * Project one repo's `PrStatusData` onto the flat per-repo portal shape
 * (CAN-1528 L2). Merge readiness is computed here with the shared
 * `isPrReadyToMerge` — its inputs (`mergeable`/`mergeableState`) are
 * desktop-only, so browser code never re-implements the semantics.
 */
function toRemoteControlRepoStatus(
  status: PrStatusData,
): RemoteControlPullRequestRepoStatus {
  return {
    number: status.prNumber,
    url: status.prUrl,
    state: status.state,
    baseRefName: status.baseRefName,
    title: status.title,
    checkStatus: status.checkStatus,
    checkDetails: toRemoteControlCheckDetails(status.checkDetails),
    reviewStatus: toRemoteControlReviewStatus(status.reviewStatus),
    labels: status.labels,
    hasConflicts: status.hasConflicts,
    commentCount: status.commentCount,
    unresolvedReviewThreadCount: status.unresolvedReviewThreadCount,
    updatedAt: status.updatedAt,
    mergeReady: isPrReadyToMerge(status),
  };
}

function toRemoteControlRepo(repo: RepoPrStatus): RemoteControlPullRequestRepo {
  return {
    repoId: repo.repoId,
    repoName: repo.repoName,
    status: repo.status ? toRemoteControlRepoStatus(repo.status) : null,
    ...(repo.prLookupAvailable !== undefined
      ? { prLookupAvailable: repo.prLookupAvailable }
      : {}),
  };
}

export async function refreshPullRequestState(
  request: RemoteControlPrRefreshPayload,
): Promise<RemoteControlPullRequestState> {
  validateId(request.workspaceLocalId, 'workspaceLocalId');
  validateId(request.worktreeLocalId, 'worktreeLocalId');
  const status = await fetchPrStatusForWorktree(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  return buildRemoteControlPrState(request, status);
}

/**
 * Project an already-fetched worktree PR status onto the portal shape,
 * attaching live creation/merge feeds.
 */
function buildRemoteControlPrState(
  request: RemoteControlPrRefreshPayload,
  status: WorktreePrStatus | null,
): RemoteControlPullRequestState {
  const first = status?.repos[0]?.status;
  const state: RemoteControlPullRequestState = {
    workspaceLocalId: request.workspaceLocalId,
    worktreeLocalId: request.worktreeLocalId,
    number: first?.prNumber ?? null,
    url: first?.prUrl ?? null,
    state: first?.state,
    baseBranch: first?.baseRefName,
    title: first?.title,
    checkStatus: first?.checkStatus,
    checkDetails: toRemoteControlCheckDetails(first?.checkDetails),
    reviewStatus: toRemoteControlReviewStatus(first?.reviewStatus),
    hasConflicts: first?.hasConflicts,
    commentCount: first?.commentCount,
    updatedAt: first?.updatedAt,
    // CAN-1528 L2 additive fields. The flat fields above stay populated from
    // the primary repo for back-compat readers; `repos` carries every repo.
    labels: first?.labels,
    mergeReady: first ? isPrReadyToMerge(first) : undefined,
    repos: status?.repos.map(toRemoteControlRepo),
  };
  // Drop a completed or stale-error creation feed once every repo has a PR, then attach
  // the (possibly cleared) feed — mirrors the renderer store's stale-progress
  // clearing so both surfaces settle to the PR card together.
  const clearedCreationProgress = clearStalePrCreationProgress(
    request.workspaceLocalId,
    request.worktreeLocalId,
    state,
  );
  const creationProgress = getPrCreationProgress(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  if (creationProgress !== undefined) {
    state.creationProgress = creationProgress;
  } else if (clearedCreationProgress) {
    state.creationProgress = null;
  }
  const mergeProgress = getPrMergeProgressFeed(
    request.workspaceLocalId,
    request.worktreeLocalId,
  );
  if (mergeProgress !== undefined) {
    state.mergeProgress = mergeProgress;
  }
  return state;
}
