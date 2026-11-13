import { isAbsolute, resolve } from 'node:path';
import type { WorkerGitCheckoutScope } from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '../../runtime/types';
import { GitBranchWriteInterrupted } from './branch-writes';
import type { GitChildEnvironment } from './repository-reads';
import {
  GitRepositoryWriteError,
  type GitRepositoryWrite,
  type GitRepositoryWriteFailureCode,
  type GitRepositoryWriteOutput,
  type GitRepositoryWritePort,
} from './repository-writes';
import type { GitSyncWritePort } from './sync-writes';
import type { WorkerGitSyncWriteHost } from './worker-git-sync-writes';

/** What the sync host needs from the recorded hosts: one checkout's path. */
export interface RecordedGitSyncCheckout {
  readonly path: string;
}

export interface RecordedWorkerGitSyncHostOptions<
  Checkout extends RecordedGitSyncCheckout,
> {
  readonly authorityId: string;
  /** The branch writes' resolution: a listed worktree's checkout or member. */
  readonly resolveCheckout: (
    scope: WorkerGitCheckoutScope,
    context: CanopyHandlerContext,
  ) => Promise<Checkout>;
  /** The fetch and pull commands, from the one Git write host. */
  readonly writes: GitRepositoryWritePort;
  /** Resolves when `absolutePath` exists. */
  readonly stat: (absolutePath: string) => Promise<unknown>;
}

/** Write-host failures that mean no Git ran: the call is unavailable. */
const UNAVAILABLE_WRITE_CODES: ReadonlySet<GitRepositoryWriteFailureCode> =
  new Set(['stopped', 'git_unavailable']);

const AUTOSTASH_UNMERGED = /^(U[UADM]|[ADM]U|DD|AA)/;

/**
 * `worker.git.fetch` and `worker.git.pull` over the daemon's Git write host,
 * in a checkout the branch writes' recorded resolution names. A host that is
 * stopping or has no Git interrupts the call instead of answering; after a
 * cancel, a fetch or pull not yet started does not start, and a started one
 * runs to its end. Every command runs with the request's forwarded
 * environment (CAN-5496). No Canopy store is read or written: fetch freshness
 * is the desktop adapter's.
 */
export function createRecordedWorkerGitSyncHost<
  Checkout extends RecordedGitSyncCheckout,
>(
  options: RecordedWorkerGitSyncHostOptions<Checkout>,
): WorkerGitSyncWriteHost<Checkout> {
  const { writes, stat } = options;

  function syncPort(
    checkout: Checkout,
    signal: AbortSignal,
    environment: GitChildEnvironment | undefined,
  ): GitSyncWritePort {
    const run = async (
      write: GitRepositoryWrite,
    ): Promise<GitRepositoryWriteOutput> => {
      try {
        return await writes.run(write, checkout.path, environment);
      } catch (error) {
        if (
          error instanceof GitRepositoryWriteError &&
          UNAVAILABLE_WRITE_CODES.has(error.code)
        )
          throw new GitBranchWriteInterrupted(
            'unavailable',
            error.message,
            error,
          );
        throw error;
      }
    };
    const succeeded = async (write: GitRepositoryWrite): Promise<string> => {
      const { exitCode, stdout } = await run(write);
      if (exitCode !== 0) throw new GitRepositoryWriteError('exit_status');
      return stdout;
    };
    // The caller was already answered `cancelled`: a command that has not
    // started does not start.
    const unlessCancelled = async (
      write: GitRepositoryWrite,
    ): Promise<void> => {
      if (signal.aborted)
        throw new GitBranchWriteInterrupted(
          'cancelled',
          'The operation was cancelled.',
        );
      await succeeded(write);
    };
    // desktop `hasAutostashEntry` and `hasUnmergedPaths`: Git's own failure
    // reads as `false`; an unavailable host does not.
    const lines = async (write: GitRepositoryWrite): Promise<string[]> => {
      try {
        return (await succeeded(write)).trim().split('\n');
      } catch (error) {
        if (error instanceof GitBranchWriteInterrupted) throw error;
        return [];
      }
    };
    const exists = async (
      name: 'rebase-merge' | 'rebase-apply',
    ): Promise<boolean> => {
      const gitPath = (
        await succeeded({ kind: 'rebase-state-path', name })
      ).trim();
      return stat(
        isAbsolute(gitPath) ? gitPath : resolve(checkout.path, gitPath),
      ).then(
        () => true,
        () => false,
      );
    };
    return {
      fetchOrigin: ({ prune }) =>
        unlessCancelled({ kind: 'fetch-origin', prune }),
      currentBranch: async () =>
        (await succeeded({ kind: 'current-branch' })).trim(),
      pullFastForward: (branch) =>
        unlessCancelled({ kind: 'pull-fast-forward', branch }),
      pullRebase: (branch) => unlessCancelled({ kind: 'pull-rebase', branch }),
      isRebaseInProgress: async () => {
        const [merge, apply] = await Promise.all([
          exists('rebase-merge'),
          exists('rebase-apply'),
        ]);
        return merge || apply;
      },
      hasAutostashEntry: async () =>
        (await lines({ kind: 'stash-list' })).some((line) =>
          line.includes('autostash'),
        ),
      hasUnmergedPaths: async () =>
        (await lines({ kind: 'porcelain-status' })).some((line) =>
          AUTOSTASH_UNMERGED.test(line),
        ),
    };
  }

  return {
    authorityId: options.authorityId,
    resolveCheckout: options.resolveCheckout,
    port: (checkout, { signal, execution }) =>
      syncPort(checkout, signal, execution?.childEnvironment),
  };
}
