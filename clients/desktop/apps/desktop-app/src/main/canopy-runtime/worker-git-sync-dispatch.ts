import { parseGitBranchName } from '@canopy/core-runtime/node/git';
import {
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import {
  WORKER_GIT_GRANTS,
  WorkerGitCheckoutScopeSchema,
  type CanopyCallerDescriptor,
  type WorkerGitCheckoutScope,
  type WorkerGitPullStrategy,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  mergeBranchIntoLocalBase,
  fetchOrigin,
  pullBranchFastForward,
  pullBranchRebase,
} from '../lib/git';
import {
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
} from '../lib/paths';
import {
  resolveRegisteredChatWorktree,
  type WorktreeTargetIds,
} from '../lib/resolve-worktree';
import { validateId } from '../lib/validation';
import {
  pullForLegacyIpc,
  type WorkerGitSyncDispatcher,
} from './worker-git-sync-adapter';

import {
  mergeForLegacyIpc,
  type WorkerGitMergeDispatcher,
} from './worker-git-merge-adapter';

/*
 * The `worker.git.fetch` and `worker.git.pull` projections behind
 * `github:pull`, each adding only `worker.git.write`. The IPC handler keeps
 * the Git-action lock, the repository entries, the skip reads and the
 * results; these run one repository's fetch or pull.
 */

/** One repository entry of a `github:pull` request. */
export interface GitSyncRepository {
  readonly repoPath: string;
  readonly repoId?: string;
}

function gitWriteCaller(
  caller: CanopyCallerDescriptor,
): CanopyCallerDescriptor {
  return { ...caller, grants: [WORKER_GIT_GRANTS.write] };
}

// The in-process binding keeps the host error as the runtime cause; Git
// errors need not be same-realm `Error`s.
function hostError(error: unknown): unknown {
  return error instanceof CanopyOperationError &&
    error.runtimeCause !== undefined
    ? error.runtimeCause
    : error;
}

function isSafeId(value: string): boolean {
  try {
    validateId(value, 'id');
    return true;
  } catch {
    return false;
  }
}

function borrowedWorktree(request: {
  readonly projectId: string;
  readonly worktreeId: string;
}): WorktreeTargetIds | null {
  try {
    return resolveRegisteredChatWorktree(request.projectId, request.worktreeId);
  } catch {
    // Unregistered since the entries were read: the entry's path still holds.
    return null;
  }
}

/**
 * The checkout scope a repository entry dispatches with: the real worktree a
 * registry-backed chat scope borrows, and `repoId` for a member under
 * `repos/`. `null` keeps the direct call as compatibility debt (CAN-5517):
 * an entry outside a workspace worktree (cowork, App Advisor and standalone
 * homes, which no workspace scope names), and identifiers the host's
 * validators or the scope refuse (an unsafe member directory name,
 * identifiers longer than the scope carries, as CAN-5136).
 */
export function syncScope(
  request: { readonly projectId: string; readonly worktreeId: string },
  entry: GitSyncRepository,
): WorkerGitCheckoutScope | null {
  const target = borrowedWorktree(request);
  if (target === null) return null;
  const repoId =
    entry.repoId === undefined ||
    entry.repoId === SINGLE_REPO_USAGE_REPO_ID ||
    entry.repoId === WORKSPACE_ROOT_REPO_ID
      ? undefined
      : entry.repoId;
  if (
    !isSafeId(target.projectId) ||
    !isSafeId(target.worktreeId) ||
    (repoId !== undefined && !isSafeId(repoId))
  )
    return null;
  const parsed = WorkerGitCheckoutScopeSchema.safeParse({
    workspaceId: target.projectId,
    worktreeId: target.worktreeId,
    ...(repoId === undefined ? {} : { repoId }),
  });
  if (!parsed.success) return null;
  // The workspace checkout the desktop host resolves this scope to.
  const checkoutPath =
    repoId === undefined
      ? getWorkspaceWorktreeDir(target.projectId, target.worktreeId)
      : getWorkspaceWorktreeRepoDir(
          target.projectId,
          target.worktreeId,
          repoId,
        );
  return checkoutPath === entry.repoPath ? parsed.data : null;
}

/**
 * `github:pull`'s fetch of one repository over `worker.git.fetch`. A failed
 * fetch rejects with the host's Git error, so the failed repository keeps
 * Git's message and its GitHub authentication classification.
 */
export async function fetchWorktreeRepository(
  dispatcher: WorkerGitSyncDispatcher,
  caller: CanopyCallerDescriptor,
  request: { readonly projectId: string; readonly worktreeId: string },
  entry: GitSyncRepository,
  options: { readonly prune: boolean },
): Promise<void> {
  const scope = syncScope(request, entry);
  if (scope === null) {
    await fetchOrigin(entry.repoPath, {
      prune: options.prune,
      signal: new AbortController().signal,
    });
    return;
  }
  try {
    await dispatcher.instruction(
      'worker.git.fetch',
      { scope, prune: options.prune },
      { caller: gitWriteCaller(caller) },
    );
  } catch (error) {
    throw hostError(error);
  }
}

/**
 * `github:pull`'s pull of one repository over `worker.git.pull`. A failed
 * pull, and a rebase `conflict` outcome, reject with the host's Git error,
 * so the legacy rebase-resolution path reads the error and checkout state it
 * read before.
 */
export async function pullWorktreeRepository(
  dispatcher: WorkerGitSyncDispatcher,
  caller: CanopyCallerDescriptor,
  request: { readonly projectId: string; readonly worktreeId: string },
  entry: GitSyncRepository,
  pull: { readonly branch: string; readonly strategy: WorkerGitPullStrategy },
): Promise<void> {
  const scope = syncScope(request, entry);
  if (scope === null) {
    const branch = parseGitBranchName(pull.branch);
    if (!branch) throw new Error('The branch name is not a valid branch name.');
    await (pull.strategy === 'rebase'
      ? pullBranchRebase(entry.repoPath, branch)
      : pullBranchFastForward(entry.repoPath, branch));
    return;
  }
  try {
    await pullForLegacyIpc(
      dispatcher,
      { scope, branch: pull.branch, strategy: pull.strategy },
      { caller: gitWriteCaller(caller) },
    );
  } catch (error) {
    throw hostError(error);
  }
}

/** Local-only merge uses the same checkout projection and legacy-scope debt as pull. */
export async function mergeWorktreeRepository(
  dispatcher: WorkerGitMergeDispatcher,
  caller: CanopyCallerDescriptor,
  request: { readonly projectId: string; readonly worktreeId: string },
  entry: GitSyncRepository,
  merge: { readonly sourceBranch: string; readonly baseBranch: string },
): Promise<string> {
  const scope = syncScope(request, entry);
  if (scope === null)
    return mergeBranchIntoLocalBase(
      entry.repoPath,
      merge.sourceBranch,
      merge.baseBranch,
    );
  try {
    return await mergeForLegacyIpc(
      dispatcher,
      { scope, ...merge },
      { caller: gitWriteCaller(caller) },
    );
  } catch (error) {
    throw hostError(error);
  }
}
