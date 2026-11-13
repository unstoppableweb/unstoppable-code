import type {
  WorkerGitPullConflict,
  WorkerGitPullResult,
  WorkerGitPullStrategy,
} from '@canopy/protocol/canopy-core';
import {
  GIT_BRANCH_HEAD_CHANGED_MESSAGE,
  GitBranchWriteInterrupted,
  GitBranchWriteRefusal,
} from './branch-writes';

/**
 * The Git commands one checkout's fetch and pull run, each named by the
 * command the desktop's `github:pull` runs for it. Hosts supply their own
 * runners and environments; no command is aborted once started. Any member
 * may reject with {@link GitBranchWriteInterrupted}, which the policy never
 * reads as an answer.
 */
export interface GitSyncWritePort {
  /** `fetch --prune origin`, or `fetch origin`; rejects when Git fails. */
  fetchOrigin(this: void, options: { readonly prune: boolean }): Promise<void>;
  /** `rev-parse --abbrev-ref HEAD`. */
  currentBranch(this: void): Promise<string>;
  /** Effect: `pull --ff-only origin <branch>`. */
  pullFastForward(this: void, branch: string): Promise<void>;
  /** Effect: `pull --rebase --autostash origin <branch>`. */
  pullRebase(this: void, branch: string): Promise<void>;
  /** Git's `rebase-merge` or `rebase-apply` directory exists. */
  isRebaseInProgress(this: void): Promise<boolean>;
  /** `stash list` names an `autostash` entry; a failed listing is `false`. */
  hasAutostashEntry(this: void): Promise<boolean>;
  /** `status --porcelain=v1` lists an unmerged path; a failure is `false`. */
  hasUnmergedPaths(this: void): Promise<boolean>;
}

export interface GitPullOptions {
  /** Refuse unless this branch is checked out right before the pull. */
  readonly expectedBranch?: string;
}

/** Fetches the checkout's `origin`. */
export async function fetchGitOrigin(
  port: GitSyncWritePort,
  prune: boolean,
): Promise<void> {
  await port.fetchOrigin({ prune });
}

/**
 * Where a failed rebase pull left the checkout, as the desktop's
 * `classifyPullRebaseFailure` reads it; `null` when it is neither.
 */
export async function classifyGitPullConflict(
  port: GitSyncWritePort,
): Promise<WorkerGitPullConflict | null> {
  if (await port.isRebaseInProgress()) return 'rebase';
  const [autostash, unmerged] = await Promise.all([
    port.hasAutostashEntry(),
    port.hasUnmergedPaths(),
  ]);
  return autostash && unmerged ? 'autostash' : null;
}

/**
 * Pulls `origin`'s `branch` into the checkout. A rebase pull that fails with
 * the checkout mid-rebase, or with its autostash unmerged, answers the
 * conflict; every other failure rejects with Git's own error. The expected
 * head is checked right before the pull.
 */
export async function pullGitBranch(
  port: GitSyncWritePort,
  branch: string,
  strategy: WorkerGitPullStrategy,
  options: GitPullOptions = {},
): Promise<WorkerGitPullResult> {
  if (
    options.expectedBranch !== undefined &&
    (await port.currentBranch()) !== options.expectedBranch
  )
    throw new GitBranchWriteRefusal(
      'head-changed',
      GIT_BRANCH_HEAD_CHANGED_MESSAGE,
    );
  if (strategy === 'fast-forward') {
    await port.pullFastForward(branch);
    return { outcome: 'pulled' };
  }
  try {
    await port.pullRebase(branch);
    return { outcome: 'pulled' };
  } catch (error) {
    if (error instanceof GitBranchWriteInterrupted) throw error;
    // A read Git fails leaves Git's pull failure as the answer.
    const conflict = await classifyGitPullConflict(port).catch(
      (readError: unknown): null => {
        if (readError instanceof GitBranchWriteInterrupted) throw readError;
        return null;
      },
    );
    if (conflict === null) throw error;
    return { outcome: 'conflict', conflict };
  }
}
