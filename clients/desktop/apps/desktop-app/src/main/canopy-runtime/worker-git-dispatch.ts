import {
  assertWorkingDirectoryAvailable,
  withWorkingDirectoryReadCheck,
} from '@canopy/desktop-shared/node/lib/working-directory';
import { isWorktreeReadAvailable } from '../lib/worktree-read-availability';
import { isWorkspaceTargetRemovalPending } from '../lib/workspace-target-exclusion';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ChangedFileInfo,
  type CreateBranchRequest,
  type CreateBranchResponse,
  type GetRemoteUrlResponse,
  type GitExecutableStatus,
  type HomeBranchTargetsRequest,
  type HomeBranchTargetsResponse,
  type ListBranchesRequest,
  type ListBranchesResponse,
  type SwitchBranchRequest,
  type SwitchBranchResponse,
  type WorktreeHealthCheckRequest,
  type WorktreeHealthCheckResponse,
  type WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import {
  CanopyWorkspaceScopeSchema,
  WORKER_GIT_GRANTS,
  WorkerGitCheckoutScopeSchema,
  WorkerGitWorktreeHealthScopeSchema,
  type CanopyCallerDescriptor,
  type WorkerGitBranchListParams,
  type WorkerGitBranchListResult,
  type WorkerGitCheckoutScope,
  type WorkerGitRemoteGetResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { GitChangeSetSample } from '@canopy/core-runtime/node/git';
import {
  checkoutBranch,
  createBranchAndCheckout,
  getChangedFilesList,
  getCommittedFilesBetween,
  getCommittedFilesList,
  getDiffStats,
  getDiffStatsAgainst,
  getMergeBaseForBranch,
  getRemoteUrl,
  listBranches,
  renameBranch,
  resolveDiffStatsBase,
} from '../lib/git';
import { resolveFreshDefaultBranch } from '../lib/git-default-branch';
import {
  legacyCommittedFiles,
  legacyUncommittedFiles,
} from '../lib/legacy-changed-files';
import { legacyDiffStats } from '../lib/legacy-diff-stats';
import type { WorktreeRepoDiffStatsReader } from '../lib/worktree-service';
import { assertWritableScope } from '../lib/read-only-scope';
import {
  resolveRegisteredChatWorktree,
  type WorktreeTargetIds,
} from '../lib/resolve-worktree';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { findRecordedRepository } from '../lib/workspace-recorded-repo';
import {
  checkUnrecordedWorktreeHealth,
  completeWorktreeHealthCheck,
  retryWorktreeHealthCheck,
} from '../lib/worktree-health';
import type { WorktreeBranchRenameGit } from '../lib/worktree-branch-rename';
import { resolveWorktreeRepoPath } from '../lib/worktree-repo-path';
import {
  legacyOriginUrl,
  queryGitBranchListWithEffects,
  queryGitExecutableForLegacyIpc,
  queryChangeSetForLegacyIpc,
  queryDiffStatsForLegacyIpc,
  queryGitRemoteAtLocation,
  queryWorktreeHealthForLegacyIpc,
  type GitRemoteLocation,
  type WorkerGitDispatcher,
  type WorkerGitWriteDispatcher,
} from './worker-git-adapter';
import type { DaemonGitRoute, DaemonGitRouteRequest } from './daemon-git-route';

interface GitBranchListRouteRequest extends DaemonGitRouteRequest {
  readonly route: DaemonGitRoute;
}

function queryBranchList(
  dispatcher: WorkerGitDispatcher,
  caller: CanopyCallerDescriptor,
  params: WorkerGitBranchListParams,
  routing: GitBranchListRouteRequest | undefined,
  requestedParams: WorkerGitBranchListParams = params,
): Promise<WorkerGitBranchListResult> {
  const options = { caller: gitReadCaller(caller) };
  const direct = (): Promise<WorkerGitBranchListResult> =>
    queryGitBranchListWithEffects(dispatcher, params, options);
  return routing
    ? routing.route.branchList(requestedParams, options, routing, direct)
    : direct();
}

/*
 * The `worker.git.*` projections behind `worktree:list-branches`,
 * `home:list-branch-targets`, `git-executable:status`,
 * `git-executable:redetect`, `repo:get-remote-url`, `worktree:health-check`
 * and `activity:changed-files`, each adding only `worker.git.read`, and
 * behind `worktree:switch-branch`, `worktree:create-branch` and the Git
 * effect of `worktree:rename-branch`, each adding only `worker.git.write`.
 */

function gitReadCaller(caller: CanopyCallerDescriptor): CanopyCallerDescriptor {
  return { ...caller, grants: [WORKER_GIT_GRANTS.read] };
}

function gitWriteCaller(
  caller: CanopyCallerDescriptor,
): CanopyCallerDescriptor {
  return { ...caller, grants: [WORKER_GIT_GRANTS.write] };
}

// Legacy channels surfaced the host error itself; the in-process binding
// keeps it as the runtime cause. Git errors need not be same-realm `Error`s.
function hostError(error: unknown): unknown {
  return error instanceof CanopyOperationError &&
    error.runtimeCause !== undefined
    ? error.runtimeCause
    : error;
}

// Validate before dispatch so rejected identifiers keep the legacy messages.
export async function listWorktreeBranches(
  dispatcher: WorkerGitDispatcher,
  caller: CanopyCallerDescriptor,
  request: ListBranchesRequest,
  routing?: GitBranchListRouteRequest,
): Promise<ListBranchesResponse> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateOptionalRepoId(request.repoId, 'repoId');
  const target = resolveRegisteredChatWorktree(
    request.projectId,
    request.worktreeId,
  );
  const repoId = request.repoId;
  const cwd = resolveWorktreeRepoPath({ ...target, repoId });
  if (
    !(await isWorktreeReadAvailable(target.projectId, target.worktreeId, cwd))
  ) {
    await assertWorkingDirectoryAvailable(cwd);
    throw new Error(`Worktree ${target.worktreeId} is no longer available`);
  }
  return withWorkingDirectoryReadCheck(
    () => !isWorkspaceTargetRemovalPending(target.projectId, target.worktreeId),
    async () => {
      if (target.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
        // Compatibility debt (CAN-4107 D9): run directories are not workspace
        // records, so the viewer keeps the direct listing.
        return listBranches(resolveWorktreeRepoPath({ ...target, repoId }), {
          resolveDefaultBranch: resolveFreshDefaultBranch,
        });
      }
      try {
        const result = await queryBranchList(
          dispatcher,
          caller,
          {
            scope: {
              workspaceId: target.projectId,
              worktreeId: target.worktreeId,
              ...(repoId === undefined ? {} : { repoId }),
            },
            repository: { kind: 'checkout' },
          },
          routing,
          {
            scope: {
              workspaceId: request.projectId,
              worktreeId: request.worktreeId,
              ...(repoId === undefined ? {} : { repoId }),
            },
            repository: { kind: 'checkout' },
          },
        );
        return {
          branches: result.branches,
          defaultBranch: result.defaultBranch,
        };
      } catch (error) {
        throw hostError(error);
      }
    },
  );
}

export async function listHomeBranchTargets(
  dispatcher: WorkerGitDispatcher,
  caller: CanopyCallerDescriptor,
  request: HomeBranchTargetsRequest,
  routing?: GitBranchListRouteRequest,
): Promise<HomeBranchTargetsResponse> {
  validateId(request.workspaceId, 'workspaceId');
  try {
    const result = await queryBranchList(
      dispatcher,
      caller,
      {
        scope: { workspaceId: request.workspaceId },
        repository: { kind: 'reference' },
        includeHeadState: true,
      },
      routing,
    );
    return {
      supported: true,
      branches: result.branches,
      defaultBranch: result.defaultBranch,
      ...(result.headUnborn === undefined
        ? {}
        : { headUnborn: result.headUnborn }),
    };
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.code === 'worker.git.branch.repositoryUnavailable'
    )
      return { supported: false, branches: [], defaultBranch: null };
    throw hostError(error);
  }
}

/**
 * `git-executable:status` (`recheck` false) and `git-executable:redetect`
 * (`recheck` true): the legacy status of the shared detection, byte for byte.
 */
export async function getGitExecutableStatus(
  dispatcher: WorkerGitDispatcher,
  caller: CanopyCallerDescriptor,
  request: { recheck: boolean },
): Promise<GitExecutableStatus> {
  try {
    const { legacyResult } = await queryGitExecutableForLegacyIpc(
      dispatcher,
      { recheck: request.recheck },
      { caller: gitReadCaller(caller) },
    );
    return legacyResult;
  } catch (error) {
    throw hostError(error);
  }
}

/**
 * `repo:get-remote-url` for a validated absolute path. A path a workspace
 * records is read through `worker.git.remote.get`; an absent origin and every
 * failure at that path answer `null`, as the direct read did.
 */
export async function readRepositoryRemoteUrl(
  dispatcher: WorkerGitDispatcher,
  caller: CanopyCallerDescriptor,
  repoPath: string,
): Promise<GetRemoteUrlResponse> {
  const recorded = await findRecordedRepository(repoPath).catch(() => null);
  if (recorded) {
    const location: GitRemoteLocation = {};
    // Failures become `null` below, as the direct read answered them.
    const result: WorkerGitRemoteGetResult | undefined =
      await queryGitRemoteAtLocation(
        dispatcher,
        {
          scope: {
            workspaceId: recorded.workspaceId,
            ...(recorded.repoId === undefined
              ? {}
              : { repoId: recorded.repoId }),
          },
          repository: { kind: 'recorded' },
        },
        { caller: gitReadCaller(caller) },
        location,
      ).catch(() => undefined);
    // Only an answer read at the requested path stands in for the direct
    // read; a record that changed or was refused falls through to it.
    if (location.repoPath === repoPath)
      return {
        remoteUrl:
          result === undefined ? null : legacyOriginUrl(result, location),
      };
  }
  // Capability-exception debt (CAN-5135 D3): a path no workspace records has
  // no scope to name, so it keeps the direct read.
  return { remoteUrl: await getRemoteUrl(repoPath) };
}

/**
 * Which path a `worktree:health-check` scope takes. A code-review or
 * plan-explore scope is checked as the real worktree it borrows (CAN-5460).
 * Compatibility debt: a borrowed shared-container run directory has no
 * worktree records (CAN-4107 D9), and validated ids may be longer than a
 * canonical scope carries (CAN-5136), so these keep the direct check.
 */
function worktreeHealthRoute(
  projectId: string,
  worktreeId: string,
):
  | { kind: 'run-directory' }
  | { kind: 'direct'; target: WorktreeTargetIds }
  | { kind: 'dispatch'; scope: { workspaceId: string; worktreeId: string } } {
  const target = resolveRegisteredChatWorktree(projectId, worktreeId);
  if (target.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
    return { kind: 'run-directory' };
  const scope = {
    workspaceId: target.projectId,
    worktreeId: target.worktreeId,
  };
  if (!WorkerGitWorktreeHealthScopeSchema.safeParse(scope).success)
    return { kind: 'direct', target };
  return { kind: 'dispatch', scope };
}

/**
 * `worktree:health-check`: refuses the read-only viewer before the worktree
 * is validated, as the legacy handler did, then records the captured legacy
 * issue on the checked worktree's row and returns the legacy response. The
 * caller is resolved only after those checks, and only to dispatch.
 */
export async function checkWorktreeHealth(
  dispatcher: WorkerGitDispatcher,
  resolveCaller: () => CanopyCallerDescriptor,
  request: WorktreeHealthCheckRequest,
): Promise<WorktreeHealthCheckResponse> {
  validateId(request.projectId, 'projectId');
  assertWritableScope(request.projectId);
  validateId(request.worktreeId, 'worktreeId');
  const route = worktreeHealthRoute(request.projectId, request.worktreeId);
  if (route.kind === 'run-directory')
    return checkUnrecordedWorktreeHealth(request.projectId, request.worktreeId);
  if (route.kind === 'direct')
    return retryWorktreeHealthCheck(
      route.target.projectId,
      route.target.worktreeId,
    );
  let issue: WorktreeHealthIssue | null;
  try {
    ({ legacyResult: issue } = await queryWorktreeHealthForLegacyIpc(
      dispatcher,
      { scope: route.scope },
      { caller: gitReadCaller(resolveCaller()) },
    ));
  } catch (error) {
    throw hostError(error);
  }
  return completeWorktreeHealthCheck(
    route.scope.workspaceId,
    route.scope.worktreeId,
    issue,
  );
}

/** The worktree a changed-files read names, and how the scope reaches it. */
export interface ChangedFilesTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  /** `__workspace_root__`, or a multi-repository member directory name. */
  readonly repoId: string;
  /** The checkout the legacy handler resolved, for the direct route. */
  readonly repoPath: string;
}

/**
 * The scope a changed-files read dispatches with: a code-review or
 * plan-explore scope as the real worktree it borrows. Compatibility debt
 * (CAN-4103): an unregistered app-managed scope, and validated ids longer
 * than a canonical scope carries, keep the direct read; so does a call that
 * reads another checkout or fails before reading.
 */
function changedFilesScope({
  projectId,
  worktreeId,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
}): { workspaceId: string; worktreeId: string } | null {
  let target: { projectId: string; worktreeId: string };
  try {
    target = resolveRegisteredChatWorktree(projectId, worktreeId);
  } catch {
    return null;
  }
  if (
    target.projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
    target.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID
  )
    return null;
  const scope = {
    workspaceId: target.projectId,
    worktreeId: target.worktreeId,
  };
  return CanopyWorkspaceScopeSchema.safeParse(scope).success ? scope : null;
}

/**
 * The reads of `target`'s checkout through `worker.git.diff.get`, or `null`
 * when the call did not read that checkout: the scope resolved elsewhere, or
 * the call failed before reading. The legacy lists never failed (defect 3,
 * kept), so `null` keeps the direct listing, recorded as debt (CAN-4103).
 */
async function changeSetOf(
  dispatcher: WorkerGitDispatcher,
  caller: CanopyCallerDescriptor,
  target: ChangedFilesTarget,
  scope: { workspaceId: string; worktreeId: string },
  base: string,
  head: string,
): Promise<GitChangeSetSample | null> {
  const read = await queryChangeSetForLegacyIpc(
    dispatcher,
    { scope, repoId: target.repoId, base, head },
    { caller: gitReadCaller(caller) },
  );
  return read?.repoPath === target.repoPath ? read.sample : null;
}

/**
 * `getChangedFilesList` for `activity:changed-files`: `HEAD..WORKTREE`
 * through `worker.git.diff.get`, returned as the legacy list rebuilt from the
 * same Git reads, byte for byte.
 */
export async function listUncommittedChangedFiles(
  dispatcher: WorkerGitDispatcher,
  caller: CanopyCallerDescriptor,
  target: ChangedFilesTarget,
): Promise<ChangedFileInfo[]> {
  const scope = changedFilesScope(target);
  const sample =
    scope === null
      ? null
      : await changeSetOf(
          dispatcher,
          caller,
          target,
          scope,
          'HEAD',
          'WORKTREE',
        );
  return sample === null
    ? getChangedFilesList(target.repoPath)
    : legacyUncommittedFiles(target.repoPath, sample);
}

/**
 * `getCommittedFilesList` for `activity:changed-files`. The merge base is
 * selected on the host as before, remote-default lookup included; the query
 * gets the resolved object id.
 */
export async function listCommittedChangedFiles(
  dispatcher: WorkerGitDispatcher,
  caller: CanopyCallerDescriptor,
  target: ChangedFilesTarget,
  baseBranch: string | undefined,
): Promise<ChangedFileInfo[]> {
  const scope = changedFilesScope(target);
  if (scope === null) return getCommittedFilesList(target.repoPath, baseBranch);
  const mergeBase = await getMergeBaseForBranch(target.repoPath, baseBranch);
  if (!mergeBase) return [];
  const sample = await changeSetOf(
    dispatcher,
    caller,
    target,
    scope,
    mergeBase,
    'HEAD',
  );
  return sample === null
    ? getCommittedFilesBetween(target.repoPath, mergeBase, 'HEAD')
    : legacyCommittedFiles(sample);
}

/**
 * The diff-stats reader of `worktree:diff-stats` and
 * `worktree:diff-stats-batch` for one worktree and an IPC caller: the base is
 * selected on the host as before, remote-default lookup included, and
 * `<merge base or HEAD>..WORKTREE` read through `worker.git.diff.get`; the
 * legacy totals are rebuilt from that call's reads, Git failures included.
 * Compatibility debt (CAN-4103): unresolved app-managed scopes, over-long ids,
 * another checkout and a call that fails before reading keep the direct read.
 * The caller is resolved once, when a read first dispatches.
 */
export function createLegacyDiffStatsReader(
  dispatcher: WorkerGitDispatcher,
  resolveCaller: () => CanopyCallerDescriptor,
  worktree: { readonly projectId: string; readonly worktreeId: string },
): WorktreeRepoDiffStatsReader {
  let caller: CanopyCallerDescriptor | undefined;
  return async ({ repoId, repoPath }, baseBranch) => {
    const scope = changedFilesScope(worktree);
    if (scope === null) return getDiffStats(repoPath, baseBranch);
    caller ??= gitReadCaller(resolveCaller());
    const base = await resolveDiffStatsBase(repoPath, baseBranch);
    const read = await queryDiffStatsForLegacyIpc(
      dispatcher,
      { scope, repoId, base, head: 'WORKTREE' },
      { caller },
    );
    return read?.repoPath === repoPath
      ? legacyDiffStats(repoPath, read.sample, read.legacy)
      : getDiffStatsAgainst(repoPath, base);
  };
}

/**
 * The checkout scope a branch-change request names, after a code-review or
 * plan-explore scope resolves to the real worktree it borrows. `null` keeps
 * the direct call as compatibility debt (CAN-4108): validated identifiers
 * longer than the scope carries (as CAN-5136), and a branch name that is not
 * a string, which no renderer sends.
 */
function branchChangeScope(
  request: { projectId: string; worktreeId: string; repoId?: string },
  names: readonly unknown[],
): WorkerGitCheckoutScope | null {
  if (names.some((name) => typeof name !== 'string')) return null;
  const target = resolveRegisteredChatWorktree(
    request.projectId,
    request.worktreeId,
  );
  const parsed = WorkerGitCheckoutScopeSchema.safeParse({
    workspaceId: target.projectId,
    worktreeId: target.worktreeId,
    ...(request.repoId === undefined ? {} : { repoId: request.repoId }),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * `worktree:switch-branch` over `worker.git.checkout`. The read-only and
 * identifier checks run first, with the desktop messages; the caller is
 * resolved only to dispatch. Refusals and Git failures rethrow the host error,
 * so messages are unchanged.
 */
export async function switchWorktreeBranch(
  dispatcher: WorkerGitWriteDispatcher,
  resolveCaller: () => CanopyCallerDescriptor,
  request: SwitchBranchRequest,
): Promise<SwitchBranchResponse> {
  validateId(request.projectId, 'projectId');
  assertWritableScope(request.projectId);
  validateId(request.worktreeId, 'worktreeId');
  validateOptionalRepoId(request.repoId, 'repoId');
  const scope = branchChangeScope(request, [request.branchName]);
  if (scope === null) {
    await checkoutBranch(resolveWorktreeRepoPath(request), request.branchName);
  } else {
    try {
      await dispatcher.instruction(
        'worker.git.checkout',
        { scope, branch: request.branchName },
        { caller: gitWriteCaller(resolveCaller()) },
      );
    } catch (error) {
      throw hostError(error);
    }
  }
  return { success: true, branchName: request.branchName };
}

/**
 * `worktree:create-branch` over `worker.git.branch.create`, refusing empty or
 * option-like names with the desktop messages before dispatch. Answers the
 * branch created, after any suffix.
 */
export async function createWorktreeBranch(
  dispatcher: WorkerGitWriteDispatcher,
  resolveCaller: () => CanopyCallerDescriptor,
  request: CreateBranchRequest,
): Promise<CreateBranchResponse> {
  validateId(request.projectId, 'projectId');
  assertWritableScope(request.projectId);
  validateId(request.worktreeId, 'worktreeId');
  validateOptionalRepoId(request.repoId, 'repoId');

  const newBranchName = request.newBranchName.trim();
  if (!newBranchName || newBranchName.startsWith('-')) {
    throw new Error('Invalid new branch name');
  }

  const baseBranch = (request.baseBranch ?? '').trim();
  if (!baseBranch || baseBranch.startsWith('-')) {
    throw new Error('Invalid base branch');
  }

  const remote = Boolean(request.baseBranchIsRemote);
  const scope = branchChangeScope(request, []);
  if (scope === null) {
    return {
      success: true,
      branchName: await createBranchAndCheckout(
        resolveWorktreeRepoPath(request),
        newBranchName,
        remote ? `origin/${baseBranch}` : baseBranch,
      ),
    };
  }
  try {
    const { branch } = await dispatcher.instruction(
      'worker.git.branch.create',
      {
        scope,
        name: newBranchName,
        startPoint: { branch: baseBranch, remote },
      },
      { caller: gitWriteCaller(resolveCaller()) },
    );
    return { success: true, branchName: branch };
  } catch (error) {
    throw hostError(error);
  }
}

/**
 * The Git effect of `worktree:rename-branch`'s W5 command over
 * `worker.git.branch.rename`. The command has already admitted the rename and
 * checked the name; the worker checks it again right before `branch -m`. The
 * caller is resolved only to dispatch, and a failure rethrows the host error,
 * so messages are unchanged.
 */
export function worktreeBranchRenameGit(
  dispatcher: WorkerGitWriteDispatcher,
  resolveCaller: () => CanopyCallerDescriptor,
): WorktreeBranchRenameGit {
  return {
    renameCheckoutBranch: async ({ workspaceId, worktreeId, repoId }, name) => {
      const request = {
        projectId: workspaceId,
        worktreeId,
        ...(repoId === undefined ? {} : { repoId }),
      };
      const scope = branchChangeScope(request, [name]);
      if (scope === null) {
        await renameBranch(resolveWorktreeRepoPath(request), name);
        return;
      }
      try {
        await dispatcher.instruction(
          'worker.git.branch.rename',
          { scope, name },
          { caller: gitWriteCaller(resolveCaller()) },
        );
      } catch (error) {
        throw hostError(error);
      }
    },
  };
}
