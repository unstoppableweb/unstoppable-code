import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  WorkerGitFetchParams,
  WorkerGitFetchResult,
  WorkerGitPullParams,
  WorkerGitPullResult,
} from '@canopy/protocol/canopy-core';
import type { CanopyInstructionOptions } from '@canopy/core-runtime';
import {
  createWorkerGitSyncWriteHandlers,
  type GitSyncWritePort,
  type WorkerGitSyncWriteHandlers,
  type WorkerGitSyncWriteHost,
} from '@canopy/core-runtime/node/git';
import {
  fetchOrigin,
  getCurrentBranch,
  hasAutostashEntry,
  hasUnmergedPaths,
  isRebaseInProgress,
  pullBranchFastForward,
  pullBranchRebase,
} from '../lib/git';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { desktopWorkerGitBranchWriteHost } from './worker-git-adapter';

/** The dispatcher surface the `worker.git` fetch and pull projections use. */
export interface WorkerGitSyncDispatcher {
  instruction(
    name: 'worker.git.fetch',
    params: WorkerGitFetchParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerGitFetchResult>;
  instruction(
    name: 'worker.git.pull',
    params: WorkerGitPullParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerGitPullResult>;
}

/** One projected pull's capture: the Git error a conflict outcome stands for. */
interface PullCapture {
  failure?: { readonly error: unknown };
}

const pullCapture = new AsyncLocalStorage<PullCapture>();

/**
 * The desktop's port for `worker.git.fetch` and `worker.git.pull` in one
 * checkout: `github:pull`'s helpers with their runners and environments (D8).
 * The fetch is `fetchOrigin` with a signal that never aborts, so it fails
 * instead of swallowing a failure, and keeps the adapter's in-flight join and
 * fetch freshness (`git_fetch_freshness`) around the command. No command
 * takes the dispatcher's signal (Q11).
 */
export function desktopGitSyncWritePort(repoPath: string): GitSyncWritePort {
  return {
    fetchOrigin: ({ prune }) =>
      fetchOrigin(repoPath, { prune, signal: new AbortController().signal }),
    currentBranch: () => getCurrentBranch(repoPath),
    pullFastForward: (branch) => pullBranchFastForward(repoPath, branch),
    pullRebase: async (branch) => {
      try {
        await pullBranchRebase(repoPath, branch);
      } catch (error) {
        const capture = pullCapture.getStore();
        if (capture) capture.failure = { error };
        throw error;
      }
    },
    isRebaseInProgress: () => isRebaseInProgress(repoPath),
    hasAutostashEntry: () => hasAutostashEntry(repoPath),
    hasUnmergedPaths: () => hasUnmergedPaths(repoPath),
  };
}

/**
 * The desktop host for `worker.git.fetch` and `worker.git.pull`: the branch
 * writes' resolution locates the checkout from trusted workspace records,
 * and today's helpers run in it.
 */
export const desktopWorkerGitSyncWriteHost: WorkerGitSyncWriteHost<string> = {
  // No enrolled targets: any explicit target is refused.
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  resolveCheckout: (scope, context) =>
    desktopWorkerGitBranchWriteHost.resolveCheckout(scope, context),
  port: (repoPath) => desktopGitSyncWritePort(repoPath),
};

/** `worker.git.fetch` and `worker.git.pull` handlers over a desktop host. */
export function createWorkerGitSyncWriteAdapter(
  host: WorkerGitSyncWriteHost<string> = desktopWorkerGitSyncWriteHost,
): WorkerGitSyncWriteHandlers {
  return createWorkerGitSyncWriteHandlers(host);
}

/**
 * Dispatches `worker.git.pull` in the projection context. A `conflict`
 * outcome rejects with the Git error the desktop host captured for it, which
 * the legacy rebase-resolution path reads; other callers get the outcome.
 */
export async function pullForLegacyIpc(
  dispatcher: WorkerGitSyncDispatcher,
  params: WorkerGitPullParams,
  options: CanopyInstructionOptions,
): Promise<void> {
  const capture: PullCapture = {};
  const result = await pullCapture.run(capture, () =>
    dispatcher.instruction('worker.git.pull', params, options),
  );
  if (result.outcome === 'pulled') return;
  if (!capture.failure)
    throw new Error('The pull conflict was not captured in this context.');
  throw capture.failure.error;
}
