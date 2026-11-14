import { basename } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  type AppAdvisorActionErrorCode,
  type AppAdvisorActionResponse,
  type ListBranchesResponse,
  type SidebarItem,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type {
  DependentBaseBranchUpdate,
  PrStatusData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { CorePullRequestDispatcher } from '../canopy-runtime/core-pull-request-adapter';
import { updatePullRequestBaseForIpc } from '../canopy-runtime/github-pull-request-write-dispatch';
import type { WorkerGitDispatcher } from '../canopy-runtime/worker-git-adapter';
import { listWorktreeBranches } from '../canopy-runtime/worker-git-dispatch';
import { isGitActionActive } from '../ipc/git-action-cancellation';
import { invalidateWorktreeDiffStats } from '../services/worktree-diff-stats-cache';
import { isSplitLocked } from '../services/split-lock-service';
import { enqueueFastRefresh } from './github-poller';
import { getCurrentBranch, getRemoteUrlStrict } from './git';
import {
  fetchRepoPrTrackingDataForRemote,
  parseGitHubRemote,
} from './github-pr';
import { resolveWorktreeCwd } from './resolve-worktree';
import { readAllSidebarItems } from './sidebar-items';
import { sendToAllWindows } from './window-send';
import { readWorkspaceWorktrees } from './workspace-persistence';
import { isAskUserDismissal } from './ask-user-outcomes';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import { isMultiRepoWorkspace } from './workspace-registry';
import { updateWorktree, WorktreeUpdateRefusedError } from './worktree-update';

/*
 * CAN-6024: the SetBaseBranch flow in Electron main, ported from the
 * renderer's `setWorktreeBaseBranch` with each renderer-only input read from
 * its main owner: the Git action and Split locks, the worktree's PR status,
 * the branch list through `worker.git.branch.list`, the tracked base through
 * the keyed `core.worktree.update` writer, and the PR base through
 * `core.pullRequest.update`. The "update the PR too" choice is asked through
 * the caller's question path; nobody to ask refuses before any write.
 */

export type WorktreeBaseBranchChoice = 'update-pr' | 'local-only';

export interface WorktreeBaseBranchRequest {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  baseBranch: string;
}

export interface WorktreeBaseBranchConfirmation {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  repoName: string;
  baseBranch: string;
  prNumber: number;
}

export type WorktreeBaseBranchOutcome =
  | { status: 'updated'; baseBranch: string; pullRequestUpdated: boolean }
  | { status: 'cancelled' };

/** Thrown by a confirm port that has nobody to ask. */
export class WorktreeBaseBranchConfirmationUnavailableError extends Error {
  constructor() {
    super('Nobody can answer the base branch question.');
    this.name = 'WorktreeBaseBranchConfirmationUnavailableError';
  }
}

export class WorktreeBaseBranchError extends Error {
  constructor(
    readonly code: AppAdvisorActionErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'WorktreeBaseBranchError';
  }
}

export const WORKTREE_BASE_BRANCH_TEXTS = Object.freeze({
  needsConfirmation:
    'This base branch change needs your confirmation in the app because the worktree has an open pull request.',
  activeGitOperation:
    'The pull request base cannot be changed while another Git operation is active for this worktree.',
  pullRequestChanged:
    'The open pull request changed while the base-branch confirmation was open. Review the latest state and try again.',
  pullRequestUnknown:
    "The worktree's pull request could not be checked, so the base branch was not changed. Try again.",
  baseMovedOn:
    'The base branch changed after this request was first made, so the pull request was not changed. Check the current state.',
  cancelled: 'Base branch change was cancelled.',
  question: (request: WorktreeBaseBranchConfirmation): string =>
    `${request.repoName} has open PR #${request.prNumber}. Change its PR base branch to ${request.baseBranch} too, or only this worktree's base?`,
  updatePullRequest: 'Update PR base',
  localOnly: 'Change worktree only',
});

/** The main owners the flow reads and writes; tests replace them. */
export interface WorktreeBaseBranchPorts {
  readItems(): Promise<SidebarItem[]>;
  listBranches(request: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
  }): Promise<ListBranchesResponse>;
  /** The worktree's PR status; `unavailable` when the lookup failed, never mistaken for no PR. */
  readPrStatus(request: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
  }): Promise<WorktreePrStatus | null | 'unavailable'>;
  gitOperationActive(projectId: string, worktreeId: string): boolean;
  writeTrackedBaseBranch(request: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
    baseBranch: string;
    /** The tracked base before this change, for the renderer's reconciliation. */
    previousBaseBranch: string | null;
    idempotencyKey: string;
  }): Promise<WorktreeData>;
  updatePullRequestBase(request: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
    prNumber: number;
    baseBranch: string;
  }): Promise<void>;
}

export interface WorktreeBaseBranchDeps {
  ports: WorktreeBaseBranchPorts;
  idempotencyKey: string;
  /** Resolves the user's choice, `null` when dismissed; throws {@link WorktreeBaseBranchConfirmationUnavailableError} when nobody can answer. */
  confirm(
    request: WorktreeBaseBranchConfirmation,
  ): Promise<WorktreeBaseBranchChoice | null>;
  signal?: AbortSignal;
}

interface PullRequestTarget {
  repoName: string;
  status: PrStatusData;
}

/** Checks the target as the renderer did; returns its current tracked base. */
function requireTarget(
  request: WorktreeBaseBranchRequest,
  items: SidebarItem[],
): string | null {
  const project = items.find((candidate) => candidate.id === request.projectId);
  if (!project) {
    throw new WorktreeBaseBranchError(
      'not_found',
      `Project "${request.projectId}" was not found.`,
    );
  }
  if (project.type === 'cowork') {
    throw new WorktreeBaseBranchError(
      'invalid_target',
      'Cowork projects do not have Git base branches.',
    );
  }
  const worktree = project.worktrees.find(
    (candidate) => candidate.id === request.worktreeId,
  );
  if (!worktree) {
    throw new WorktreeBaseBranchError(
      'not_found',
      `Worktree "${request.worktreeId}" was not found in project "${request.projectId}".`,
    );
  }
  if (project.type === 'single-repo') {
    if (request.repoId !== undefined) {
      throw new WorktreeBaseBranchError(
        'invalid_target',
        'repoId must be omitted for a single-repository project.',
      );
    }
    return worktree.trackedBaseBranch ?? null;
  }
  if (!request.repoId) {
    throw new WorktreeBaseBranchError(
      'invalid_target',
      'repoId is required for a multi-repository project.',
    );
  }
  const repoExists =
    project.repos.some((repo) => repo.id === request.repoId) ||
    (request.repoId === WORKSPACE_ROOT_REPO_ID &&
      typeof project.sourceRepoPath === 'string');
  if (!repoExists) {
    throw new WorktreeBaseBranchError(
      'invalid_target',
      `Repository "${request.repoId}" was not found in project "${request.projectId}".`,
    );
  }
  return worktree.trackedRepoBaseBranches?.[request.repoId] ?? null;
}

function validateBaseBranch(baseBranch: string): string {
  if (!baseBranch || baseBranch.startsWith('-') || baseBranch === 'HEAD') {
    throw new WorktreeBaseBranchError(
      'validation_failed',
      'baseBranch must be a valid branch name and cannot be HEAD.',
    );
  }
  return baseBranch;
}

async function resolvePresence(
  ports: WorktreeBaseBranchPorts,
  request: WorktreeBaseBranchRequest,
  baseBranch: string,
): Promise<{ existsLocally: boolean; existsInRemote: boolean }> {
  let response: ListBranchesResponse;
  try {
    response = await ports.listBranches({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      ...(request.repoId ? { repoId: request.repoId } : {}),
    });
  } catch (error) {
    throw new WorktreeBaseBranchError(
      'execution_failed',
      error instanceof Error ? error.message : 'Failed to list branches.',
      true,
    );
  }
  const matches = response.branches.filter(
    (branch) => branch.name === baseBranch,
  );
  const presence = {
    existsLocally: matches.some((branch) => branch.hasLocalRef),
    existsInRemote: matches.some((branch) => branch.hasRemoteRef),
  };
  if (!presence.existsLocally && !presence.existsInRemote) {
    throw new WorktreeBaseBranchError(
      'validation_failed',
      `Base branch "${baseBranch}" is no longer available locally or on origin.`,
      true,
    );
  }
  return presence;
}

async function findOpenPullRequest(
  ports: WorktreeBaseBranchPorts,
  request: WorktreeBaseBranchRequest,
): Promise<PullRequestTarget | null | 'unavailable'> {
  const status = await ports.readPrStatus({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    ...(request.repoId ? { repoId: request.repoId } : {}),
  });
  if (status === 'unavailable') return 'unavailable';
  const repo = request.repoId
    ? status?.repos.find((candidate) => candidate.repoId === request.repoId)
    : status?.repos.find(
        (candidate) =>
          candidate.status?.state === 'open' ||
          candidate.status?.state === 'draft',
      );
  if (
    !repo?.status ||
    (repo.status.state !== 'open' && repo.status.state !== 'draft')
  ) {
    return null;
  }
  return { repoName: repo.repoName, status: repo.status };
}

function isSamePullRequest(
  current: PullRequestTarget | null | 'unavailable',
  expected: PullRequestTarget,
): boolean {
  if (current === null || current === 'unavailable') return false;
  return (
    current.status.prNumber === expected.status.prNumber &&
    current.status.baseRefName === expected.status.baseRefName
  );
}

/** The renderer's `setWorktreeBaseBranch`, in main. */
export async function setWorktreeBaseBranchInMain(
  request: WorktreeBaseBranchRequest,
  deps: WorktreeBaseBranchDeps,
): Promise<WorktreeBaseBranchOutcome> {
  const { ports, signal } = deps;
  const previousBaseBranch = requireTarget(request, await ports.readItems());
  const baseBranch = validateBaseBranch(request.baseBranch);
  let presence = await resolvePresence(ports, request, baseBranch);
  const found = await findOpenPullRequest(ports, request);
  // Without the PR state the change could skip a question the user is owed.
  if (found === 'unavailable' && presence.existsInRemote)
    throw new WorktreeBaseBranchError(
      'execution_failed',
      WORKTREE_BASE_BRANCH_TEXTS.pullRequestUnknown,
      true,
    );
  const openPullRequest = found === 'unavailable' ? null : found;
  let choice: WorktreeBaseBranchChoice = 'local-only';

  if (openPullRequest && presence.existsInRemote) {
    let confirmed: WorktreeBaseBranchChoice | null;
    try {
      confirmed = await deps.confirm({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        ...(request.repoId ? { repoId: request.repoId } : {}),
        repoName: openPullRequest.repoName,
        baseBranch,
        prNumber: openPullRequest.status.prNumber,
      });
    } catch (error) {
      if (error instanceof WorktreeBaseBranchConfirmationUnavailableError)
        throw new WorktreeBaseBranchError(
          'surface_unavailable',
          WORKTREE_BASE_BRANCH_TEXTS.needsConfirmation,
          true,
        );
      throw error;
    }
    if (confirmed === null || signal?.aborted) return { status: 'cancelled' };
    choice = confirmed;
    if (choice === 'update-pr') {
      if (ports.gitOperationActive(request.projectId, request.worktreeId))
        throw new WorktreeBaseBranchError(
          'surface_unavailable',
          WORKTREE_BASE_BRANCH_TEXTS.activeGitOperation,
          true,
        );
      if (
        !isSamePullRequest(
          await findOpenPullRequest(ports, request),
          openPullRequest,
        )
      )
        throw new WorktreeBaseBranchError(
          'stale_ui_state',
          WORKTREE_BASE_BRANCH_TEXTS.pullRequestChanged,
          true,
        );
    }
    // A question can stay open while refs change; either choice revalidates
    // availability before persisting.
    presence = await resolvePresence(ports, request, baseBranch);
  }

  if (choice === 'update-pr' && !presence.existsInRemote) choice = 'local-only';
  if (signal?.aborted) return { status: 'cancelled' };

  const stored = await ports.writeTrackedBaseBranch({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    ...(request.repoId ? { repoId: request.repoId } : {}),
    baseBranch,
    previousBaseBranch,
    idempotencyKey: deps.idempotencyKey,
  });
  // A same-key retry replays the first write; if the base has moved on
  // since, this request must not move the pull request back.
  const storedBase =
    request.repoId === undefined
      ? stored.trackedBaseBranch
      : stored.trackedRepoBaseBranches?.[request.repoId];
  if (choice === 'update-pr' && storedBase !== baseBranch)
    throw new WorktreeBaseBranchError(
      'stale_ui_state',
      WORKTREE_BASE_BRANCH_TEXTS.baseMovedOn,
    );

  if (signal?.aborted) return { status: 'cancelled' };

  if (choice === 'update-pr' && openPullRequest) {
    try {
      await ports.updatePullRequestBase({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        ...(request.repoId ? { repoId: request.repoId } : {}),
        prNumber: openPullRequest.status.prNumber,
        baseBranch,
      });
    } catch (error) {
      throw new WorktreeBaseBranchError(
        'execution_failed',
        error instanceof Error
          ? error.message
          : 'Failed to update the pull request base branch.',
      );
    }
  }

  return {
    status: 'updated',
    baseBranch,
    pullRequestUpdated: choice === 'update-pr',
  };
}

/** The `worktree.set_base_branch` action response the renderer dispatcher gave. */
export async function setWorktreeBaseBranchAction(
  request: WorktreeBaseBranchRequest,
  deps: WorktreeBaseBranchDeps,
  requestId: string,
): Promise<AppAdvisorActionResponse> {
  try {
    const outcome = await setWorktreeBaseBranchInMain(request, deps);
    if (outcome.status === 'cancelled')
      return {
        requestId,
        ok: false,
        error: {
          code: 'execution_failed',
          message: WORKTREE_BASE_BRANCH_TEXTS.cancelled,
          retryable: false,
        },
      };
    return {
      requestId,
      ok: true,
      result: {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        ...(request.repoId ? { repoId: request.repoId } : {}),
        baseBranch: outcome.baseBranch,
        pullRequestUpdated: outcome.pullRequestUpdated,
      },
    };
  } catch (error) {
    if (error instanceof WorktreeBaseBranchError)
      return {
        requestId,
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      };
    return {
      requestId,
      ok: false,
      error: {
        code: 'execution_failed',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to set the base branch.',
      },
    };
  }
}

type BaseBranchDispatcher = WorkerGitDispatcher & CorePullRequestDispatcher;

/** The ports over main's owners, dispatching through `dispatcher` as `caller`. */
export function mainWorktreeBaseBranchPorts(
  dispatcher: BaseBranchDispatcher,
  caller: CanopyCallerDescriptor,
  readCurrentWorktree: (
    projectId: string,
    worktreeId: string,
  ) => Promise<WorktreeData | undefined> = async (projectId, worktreeId) =>
    (await readWorkspaceWorktrees(projectId)).find(
      (candidate) => candidate.id === worktreeId,
    ),
): WorktreeBaseBranchPorts {
  return {
    readItems: async () => (await readAllSidebarItems()).items,
    listBranches: (request) =>
      listWorktreeBranches(dispatcher, caller, request),
    readPrStatus: async (request) => {
      const cwd = resolveWorktreeCwd(request.projectId, request.worktreeId);
      let repoPath = cwd;
      let repoId = basename(cwd);
      let repoName = basename(cwd);
      if (request.repoId && isMultiRepoWorkspace(request.projectId)) {
        const entry = (
          await listWorkspaceWorktreeRepoEntries(request.projectId, cwd)
        ).find((candidate) => candidate.repoId === request.repoId);
        if (!entry) return null;
        repoPath = entry.repoPath;
        repoId = request.repoId;
        repoName = entry.repoName;
      }
      // A failed branch read is a failed lookup; only a branchless
      // (detached) checkout has no pull request to ask about.
      let branch: string;
      try {
        branch = await getCurrentBranch(repoPath);
      } catch {
        return 'unavailable';
      }
      if (!branch) return null;
      // Every lookup failure is a failed read; only a missing or
      // non-GitHub origin means there is no pull request.
      let tracking: Awaited<
        ReturnType<typeof fetchRepoPrTrackingDataForRemote>
      >;
      try {
        const remoteUrl = await getRemoteUrlStrict(repoPath);
        const remote = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
        if (!remote) return null;
        tracking = await fetchRepoPrTrackingDataForRemote(remote, branch, {
          priority: 'high',
        });
      } catch {
        return 'unavailable';
      }
      return {
        repos: [{ repoId, repoName, status: tracking.status ?? null }],
        lastCheckedAt: new Date().toISOString(),
      };
    },
    gitOperationActive: (projectId, worktreeId) =>
      isGitActionActive({ projectId, worktreeId }) ||
      isSplitLocked(projectId, worktreeId),
    writeTrackedBaseBranch: async (request) => {
      let worktree: WorktreeData;
      try {
        ({ worktree } = await updateWorktree({
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
          patch:
            request.repoId === undefined
              ? { trackedBaseBranch: request.baseBranch }
              : {
                  trackedRepoBaseBranches: {
                    [request.repoId]: request.baseBranch,
                  },
                },
          idempotencyKey: request.idempotencyKey,
        }));
      } catch (error) {
        if (
          error instanceof WorktreeUpdateRefusedError &&
          error.reason === 'not-found'
        )
          throw new WorktreeBaseBranchError(
            'not_found',
            `Worktree "${request.worktreeId}" was not found in project "${request.projectId}".`,
          );
        throw error;
      }
      // A same-key retry replays the first write's row, which may be older
      // than the stored one: announce the row as it is now, and the base
      // change only while it still holds, so no window goes back in time.
      const current =
        (await readCurrentWorktree(request.projectId, request.worktreeId)) ??
        worktree;
      sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, {
        workspaceId: request.projectId,
        worktree: current,
      });
      invalidateWorktreeDiffStats(request.projectId, request.worktreeId);
      const currentBase =
        request.repoId === undefined
          ? current.trackedBaseBranch
          : current.trackedRepoBaseBranches?.[request.repoId];
      if (
        currentBase === request.baseBranch &&
        request.previousBaseBranch !== request.baseBranch
      ) {
        // The renderer's reconciliation for a base branch main changed: it
        // updates the shown base, then refreshes diff stats and Changed
        // Files, as its own setter did after a write.
        const update: DependentBaseBranchUpdate = {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          ...(request.repoId ? { repoId: request.repoId } : {}),
          previousBaseBranch: request.previousBaseBranch ?? '',
          nextBaseBranch: request.baseBranch,
        };
        sendToAllWindows(IPC_CHANNELS.githubDependentBaseBranchesUpdated, {
          updates: [update],
        });
      }
      return current;
    },
    updatePullRequestBase: async (request) => {
      const cwd = resolveWorktreeCwd(request.projectId, request.worktreeId);
      let repoPath = cwd;
      if (request.repoId && isMultiRepoWorkspace(request.projectId)) {
        const entry = (
          await listWorkspaceWorktreeRepoEntries(request.projectId, cwd)
        ).find((candidate) => candidate.repoId === request.repoId);
        if (!entry)
          throw new Error(`Repo ${request.repoId} not found in project.`);
        repoPath = entry.repoPath;
      }
      await updatePullRequestBaseForIpc(dispatcher, () => caller, {
        projectId: request.projectId,
        repoId: request.repoId,
        repoPath,
        prNumber: request.prNumber,
        newBaseBranch: request.baseBranch,
      });
      enqueueFastRefresh(request.projectId, request.worktreeId, false);
    },
  };
}

/** The confirm port over an agent's AskUserQuestion path. */
export function askUserBaseBranchConfirmation(
  requestUserAnswers: (
    questions: Array<{
      question: string;
      options: string[];
      multiSelect?: boolean;
      allowOther?: boolean;
    }>,
  ) => Promise<
    Array<{ selectedOptions: string[]; answeredBy?: 'person' | 'agent' }>
  >,
): WorktreeBaseBranchDeps['confirm'] {
  return async (request) => {
    let answers: Array<{
      selectedOptions: string[];
      answeredBy?: 'person' | 'agent';
    }>;
    try {
      answers = await requestUserAnswers([
        {
          question: WORKTREE_BASE_BRANCH_TEXTS.question(request),
          options: [
            WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest,
            WORKTREE_BASE_BRANCH_TEXTS.localOnly,
          ],
          multiSelect: false,
          allowOther: false,
        },
      ]);
    } catch (error) {
      // A dismissed, timed-out or stopped question cancels; any failure to
      // put the question to someone fails closed before a write.
      if (isAskUserDismissal(error)) return null;
      throw new WorktreeBaseBranchConfirmationUnavailableError();
    }
    const answer = answers[0];
    // Only a person's answer chooses; an agent's, an automation's or one
    // of unknown origin never authorizes a PR change.
    if (answer?.answeredBy !== 'person')
      throw new WorktreeBaseBranchConfirmationUnavailableError();
    const selected = answer.selectedOptions;
    if (selected.includes(WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest))
      return 'update-pr';
    if (selected.includes(WORKTREE_BASE_BRANCH_TEXTS.localOnly))
      return 'local-only';
    return null;
  };
}
