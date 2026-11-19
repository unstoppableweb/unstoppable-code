import type {
  RemoteControlPrActionPayload,
  RemoteControlPrStatus,
  RemoteControlWorktreePrActionsState,
} from '@canopy/protocol/remote-control/shell';
import {
  remoteControlPlannedSteps,
  type RemoteControlPullRequestStep,
} from './pull-request-planned-steps';
import type {
  ProgressChecklistStep,
  WorktreePrBadgeCheckStatus,
  WorktreeRowPrStatus,
} from '@canopy/ui-shared/components';
import { PR_PHASE_LABELS } from '@canopy/ui-shared/lib';
import type {
  PullRequestSectionCheckStatus,
  PullRequestSectionPrStatus,
} from '../activity/PullRequestSectionBody';
import { remoteControlPrStatusToSectionModel } from '../activity/remote-control-pr-section-mapper';
import {
  repoRequiresCommitAndPush,
  repoRequiresCommitOnly,
  repoRequiresPull,
  repoRequiresPullCommitAndPush,
  repoRequiresPush,
  type BranchSyncAction,
  type PullRequestBranchFacts,
} from './branch-actions';
import type {
  PullRequestActionRequest,
  PullRequestProgressTarget,
} from './PullRequestActions';
import {
  IDLE_PULL_REQUEST_ACTIVITY,
  type PullRequestActionsActivity,
  type PullRequestActionsFacts,
  type PullRequestActionsPr,
} from './pull-request-actions-plan';
import {
  COMMIT_PUSH_PHASE_LABELS,
  type PullRequestProgressModel,
} from './PullRequestProgressTooltip';

/**
 * The header's PR actions for a host that speaks the Portal vocabulary
 * (REG-3025): the web cloud worktree today. Its server decides the action
 * state (`RemoteControlWorktreePrActionsState`) and reads the PR
 * (`RemoteControlPrStatus`); these map both onto the shared facts and the user's
 * request back onto a `pr.action` payload.
 *
 * A host that acts on every repository of a multi-repo worktree, as desktop's
 * header does (REG-3023), opts in with `repos`: every repository's row, the
 * root first. Without it the facts and payloads are one repository's.
 */

type RemoteControlActionsRepo =
  RemoteControlWorktreePrActionsState['repos'][number];

/** The opt-in: every repository's row, the root first. */
interface RemoteControlRepositoriesOption {
  readonly repos?: readonly RemoteControlActionsRepo[];
}

/** The rows of a multi-repo worktree whose host opted in, else null. */
function multiRepoRows(
  options: RemoteControlRepositoriesOption,
): readonly RemoteControlActionsRepo[] | null {
  return options.repos !== undefined && options.repos.length > 1
    ? options.repos
    : null;
}

/** One worktree's PR action state as a Portal host holds it. */
export interface RemoteControlPullRequestActionsRow {
  readonly repo: RemoteControlActionsRepo | null;
  /** The action in flight, with what the user asked for. */
  readonly pendingPayload: RemoteControlPrActionPayload | null;
  /** The steps the pending action runs, decided when it was asked for. */
  readonly plannedSteps: readonly (RemoteControlPullRequestStep | 'create')[];
  /** The step the server reports the pending action on (or about to start). */
  readonly pendingStep: RemoteControlPullRequestStep | 'create' | null;
  readonly cancellationRequested: boolean;
}

function badgeCheckStatus(
  status: PullRequestSectionCheckStatus,
): WorktreePrBadgeCheckStatus {
  return status === 'neutral' ? 'none' : status;
}

function tooltipOf(
  section: PullRequestSectionPrStatus,
  checkStatus: PullRequestSectionCheckStatus,
  unresolved: number | undefined,
): WorktreeRowPrStatus {
  return {
    state: section.state,
    checkStatus: badgeCheckStatus(checkStatus),
    reviewStatus: section.reviewStatus,
    ...(section.isMergeReady === undefined
      ? {}
      : { isMergeReady: section.isMergeReady }),
    url: section.prUrl,
    label: `PR #${section.prNumber}`,
    title: section.title,
    ciStatus: badgeCheckStatus(checkStatus),
    unresolvedCommentCount: unresolved ?? 0,
    hasConflicts: section.hasConflicts,
  };
}

/**
 * The repository's PR from a Portal status, or null without one. One
 * repository falls back to the status's first entry; a repository of a
 * multi-repo worktree (`exact`) never reads another's PR.
 */
function remoteControlPr(
  repo: RemoteControlActionsRepo,
  prStatus: RemoteControlPrStatus | undefined,
  exact = false,
): PullRequestActionsPr | null {
  const raw =
    prStatus?.repos?.find((entry) => entry.repoId === repo.repoId)?.status ??
    (exact ? null : prStatus?.repos?.[0]?.status) ??
    null;
  const sections = remoteControlPrStatusToSectionModel(prStatus).repos;
  const section =
    sections?.find((entry) => entry.repoId === repo.repoId)?.status ??
    (exact ? null : sections?.[0]?.status) ??
    null;
  if (raw === null || section === null) return null;
  const checkStatus = raw.checkStatus ?? 'none';
  const unresolved = raw.unresolvedReviewThreadCount;
  return {
    number: section.prNumber,
    url: section.prUrl === '' ? null : section.prUrl,
    state: section.state,
    checkStatus,
    checkDetails: section.checkDetails,
    readyToMerge: raw.mergeReady === true,
    // The Portal status carries no merge queue entry yet.
    inMergeQueue: false,
    hasConflicts: raw.hasConflicts === true,
    // Unknown thread state warns, as on desktop.
    reviewThreadsWarning: unresolved === undefined || unresolved > 0,
    mergeRoute: 'direct',
    reviewStatus: section.reviewStatus,
    tooltip: tooltipOf(section, checkStatus, unresolved),
  };
}

/** One Portal repository's git facts. */
function remoteControlBranchFacts(
  repo: RemoteControlActionsRepo,
): PullRequestBranchFacts {
  const ahead = repo.ahead ?? 0;
  const commitsAhead = repo.commitsAhead === true;
  return {
    repoId: repo.repoId,
    commitsAhead,
    hasUncommittedChanges: repo.dirty === true,
    // An unpublished branch's own commits have not been pushed either.
    hasUnpushedCommits: ahead > 0 || (repo.published === false && commitsAhead),
    hasUnpulledCommits: (repo.behind ?? 0) > 0,
    hasRemoteTrackingBranch: repo.published === true,
    hasOriginRemote: true,
  };
}

/**
 * The shared facts for one Portal worktree row: its one repository, or every
 * repository of a multi-repo worktree when the host opts in with `repos`.
 */
export function remoteControlPullRequestActionsFacts(
  repo: RemoteControlActionsRepo,
  prStatus: RemoteControlPrStatus | undefined,
  options: RemoteControlRepositoriesOption & {
    readonly agentHelpers?: boolean;
  } = {},
): PullRequestActionsFacts {
  const rows = multiRepoRows(options);
  // Splitting needs the desktop's diff-size eligibility; a Portal host
  // does not offer it.
  const host = { splitPr: null, agentHelpers: options.agentHelpers === true };
  if (rows === null) {
    return {
      isMultiRepo: false,
      repos: [
        {
          repoId: repo.repoId,
          repoName: repo.repoName,
          pr: remoteControlPr(repo, prStatus),
        },
      ],
      worktree: remoteControlBranchFacts(repo),
      ...host,
    };
  }
  const repoBranches = rows.map(remoteControlBranchFacts);
  const any = (fact: keyof PullRequestBranchFacts): boolean =>
    repoBranches.some((branch) => branch[fact] === true);
  return {
    isMultiRepo: true,
    repos: rows.map((row) => ({
      repoId: row.repoId,
      repoName: row.repoName,
      pr: remoteControlPr(row, prStatus, true),
    })),
    // The aggregate across repositories, as desktop's header reads it.
    worktree: {
      repoId: repo.repoId,
      commitsAhead: any('commitsAhead'),
      hasUncommittedChanges: any('hasUncommittedChanges'),
      hasUnpushedCommits: any('hasUnpushedCommits'),
      hasUnpulledCommits: any('hasUnpulledCommits'),
      hasRemoteTrackingBranch: any('hasRemoteTrackingBranch'),
      hasOriginRemote: true,
    },
    repoBranches,
    ...host,
  };
}

/** The repositories a branch-sync action applies to, by their own state. */
const BRANCH_SYNC_APPLIES: Readonly<
  Record<BranchSyncAction, (branch: PullRequestBranchFacts) => boolean>
> = {
  commit: repoRequiresCommitOnly,
  'commit-and-push': repoRequiresCommitAndPush,
  'pull-commit-and-push': repoRequiresPullCommitAndPush,
  push: repoRequiresPush,
  pull: repoRequiresPull,
};

/** Whether a repository's PR is open and ready to merge (the plan's rule). */
function readyToMerge(pr: PullRequestActionsPr | null): boolean {
  return (
    pr !== null &&
    pr.readyToMerge &&
    (pr.state === 'open' || pr.state === 'draft')
  );
}

/**
 * The repository whose PR Merge acts on: the row's own, or with the
 * multi-repo opt-in the first ready PR whose review threads warn, else the
 * first ready one. One click merges that one PR, the one the merge question
 * names (desktop's single-PR path; its multi-PR selection dialog has no
 * Portal equivalent). Null when no PR is ready.
 */
export function remoteControlPullRequestMergeRepo(
  repo: RemoteControlActionsRepo,
  prStatus: RemoteControlPrStatus | undefined,
  options: RemoteControlRepositoriesOption = {},
): RemoteControlActionsRepo | null {
  const rows = multiRepoRows(options);
  if (rows === null) return repo;
  const ready = rows
    .map((row) => ({ row, pr: remoteControlPr(row, prStatus, true) }))
    .filter(({ pr }) => readyToMerge(pr));
  return (
    (ready.find(({ pr }) => pr?.reviewThreadsWarning === true) ?? ready[0])
      ?.row ?? null
  );
}

/** The branch-sync action a pending payload is, if any. */
function branchSyncOf(
  payload: RemoteControlPrActionPayload,
): BranchSyncAction | null {
  switch (payload.action) {
    case 'commit':
      if (payload.push !== true) return 'commit';
      return payload.pullFirst === true
        ? 'pull-commit-and-push'
        : 'commit-and-push';
    case 'push':
      return 'push';
    case 'pull':
      return 'pull';
    default:
      return null;
  }
}

/**
 * What the row is running. A Portal merge is one GitHub call with no git
 * operation behind it, so it offers no cancel; nor does Create PR once its
 * own create call runs (every step before it stops at a boundary).
 */
export function remoteControlPullRequestActivity(
  row: Pick<
    RemoteControlPullRequestActionsRow,
    'pendingPayload' | 'cancellationRequested'
  > &
    Partial<Pick<RemoteControlPullRequestActionsRow, 'pendingStep'>>,
): PullRequestActionsActivity {
  const payload = row.pendingPayload;
  const sync = payload === null ? null : branchSyncOf(payload);
  return {
    ...IDLE_PULL_REQUEST_ACTIVITY,
    committingAndPushing: sync !== null,
    activeBranchSyncAction: sync,
    creatingPr: payload?.action === 'create_auto',
    mergingPr: payload?.action === 'merge',
    cancellationRequested: row.cancellationRequested,
    mergeCancellable: false,
    createCancellable: row.pendingStep !== 'create',
  };
}

const STEP_LABEL: Readonly<
  Record<RemoteControlPullRequestStep | 'create', string>
> = {
  pull: COMMIT_PUSH_PHASE_LABELS.pulling,
  commit: COMMIT_PUSH_PHASE_LABELS.committing,
  push: COMMIT_PUSH_PHASE_LABELS.pushing,
  create: PR_PHASE_LABELS.creating_pr,
};

/**
 * The progress checklist for a running action, or null while it is idle
 * or the target is not the action that runs. Steps before the one the
 * server reports are done; once the git steps are done, opening the PR is.
 */
export function remoteControlPullRequestProgress(
  target: PullRequestProgressTarget,
  row: RemoteControlPullRequestActionsRow,
): PullRequestProgressModel | null {
  const payload = row.pendingPayload;
  if (payload === null) return null;
  const sync = branchSyncOf(payload);
  const matches =
    (target.type === 'commit-push' && sync === target.action) ||
    (target.type === 'create-pr' && payload.action === 'create_auto');
  if (!matches || row.plannedSteps.length === 0) return null;
  const current =
    row.pendingStep === null
      ? 0
      : Math.max(0, row.plannedSteps.indexOf(row.pendingStep));
  const steps: ProgressChecklistStep[] = row.plannedSteps.map(
    (step, index) => ({
      key: step,
      label: STEP_LABEL[step],
      status:
        index < current
          ? 'completed'
          : index === current
            ? 'active'
            : 'pending',
    }),
  );
  return { steps, badge: { label: 'In progress', tone: 'progress' } };
}

/** The `merge` payload for one repository's PR, or null without one. */
function mergePayload(
  base: Omit<RemoteControlPrActionPayload, 'action'>,
  repo: RemoteControlActionsRepo,
  pr: NonNullable<RemoteControlPrStatus['repos']>[number]['status'] | null,
): RemoteControlPrActionPayload | null {
  return typeof pr?.number === 'number' && pr.baseRefName !== undefined
    ? {
        ...base,
        // GitHub's PR head the user saw, not the sandbox's head.
        ...(typeof repo.prHeadSha === 'string'
          ? { expectedHeadSha: repo.prHeadSha }
          : {}),
        action: 'merge',
        expectedPrNumber: pr.number,
        expectedBaseBranch: pr.baseRefName,
        expectedHeadBranch: repo.headBranch,
      }
    : null;
}

/**
 * The `pr.action` payload for what the user asked, pinned to what they saw:
 * the head always, the branches to create from, and the PR to merge or
 * align with. Null for a request the Portal host does not run.
 *
 * With the multi-repo opt-in (`repos`), the payload names every repository it
 * acts on in `repoIds`, as desktop's header does: Create PR the ones the plan
 * chose, and a branch-sync action each repository whose state calls for it.
 * Merge names the one PR `remoteControlPullRequestMergeRepo` picks. Aligning the
 * base stays the root's.
 */
export function remoteControlPullRequestActionPayload(
  request:
    | PullRequestActionRequest
    | { readonly kind: 'cancel' }
    | {
        readonly kind: 'align-base';
      },
  repo: RemoteControlActionsRepo,
  prStatus: RemoteControlPrStatus | undefined,
  target: {
    readonly workspaceLocalId: string;
    readonly worktreeLocalId: string;
  },
  options: RemoteControlRepositoriesOption = {},
): RemoteControlPrActionPayload | null {
  const rows = multiRepoRows(options);
  const head =
    repo.headSha === undefined || repo.headSha === null
      ? {}
      : { expectedHeadSha: repo.headSha };
  const base = { ...target, ...head };
  const pr = prStatus?.repos?.[0]?.status ?? null;
  switch (request.kind) {
    case 'branch-sync': {
      const applies = BRANCH_SYNC_APPLIES[request.action];
      const repoIds = rows
        ?.filter((row) => applies(remoteControlBranchFacts(row)))
        .map((row) => row.repoId);
      if (repoIds?.length === 0) return null;
      const scoped = repoIds === undefined ? base : { ...base, repoIds };
      switch (request.action) {
        case 'push':
        case 'pull':
          return { ...scoped, action: request.action };
        case 'commit':
          return { ...scoped, action: 'commit' };
        case 'commit-and-push':
          return { ...scoped, action: 'commit', push: true };
        case 'pull-commit-and-push':
          return { ...scoped, action: 'commit', push: true, pullFirst: true };
      }
      return null;
    }
    case 'create-pr':
      return repo.baseBranch === undefined
        ? null
        : {
            ...base,
            ...(request.repoIds === undefined
              ? {}
              : { repoIds: [...request.repoIds] }),
            action: 'create_auto',
            expectedBaseBranch: repo.baseBranch,
            expectedHeadBranch: repo.headBranch,
          };
    case 'merge': {
      if (rows === null) return mergePayload(base, repo, pr);
      const target = remoteControlPullRequestMergeRepo(repo, prStatus, options);
      return target === null
        ? null
        : mergePayload(
            { ...base, repoIds: [target.repoId] },
            target,
            prStatus?.repos?.find((entry) => entry.repoId === target.repoId)
              ?.status ?? null,
          );
    }
    case 'align-base':
      return pr?.baseRefName === undefined
        ? null
        : { ...base, action: 'update_base_branch', baseBranch: pr.baseRefName };
    case 'cancel':
      return { ...target, action: 'cancel' };
    default:
      return null;
  }
}

export { remoteControlPlannedSteps, type RemoteControlPullRequestStep };
