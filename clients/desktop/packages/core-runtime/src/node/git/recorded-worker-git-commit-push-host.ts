import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import type { WorkerGitCheckoutScope } from '@canopy/protocol/canopy-core';
import {
  GitRepositoryWriteError,
  gitWriteDetailsOf,
  gitWriteExitError,
  type GitRepositoryWrite,
  type GitRepositoryWriteOutput,
  type GitRepositoryWritePort,
} from './repository-writes';
import type {
  GitCommitPushPort,
  WorkerGitCommitPushHost,
} from './worker-git-commit-push';

export function createRecordedWorkerGitCommitPushHost<
  Checkout extends { readonly path: string },
>(options: {
  readonly authorityId: string;
  readonly resolveCheckout: (
    scope: WorkerGitCheckoutScope,
    context: CanopyHandlerContext,
  ) => Promise<Checkout>;
  readonly writes: GitRepositoryWritePort;
}): WorkerGitCommitPushHost<Checkout> {
  return {
    authorityId: options.authorityId,
    resolveCheckout: options.resolveCheckout,
    port: (checkout, context): GitCommitPushPort => {
      const run = (
        write: GitRepositoryWrite,
      ): Promise<GitRepositoryWriteOutput> =>
        options.writes.run(
          write,
          checkout.path,
          context.execution?.childEnvironment,
        );
      const succeeded = async (write: GitRepositoryWrite): Promise<string> => {
        const result = await run(write);
        if (result.exitCode !== 0) {
          if (
            write.kind === 'commit-message' &&
            /nothing to commit/i.test(result.stdout)
          )
            throw new CanopyOperationError({
              kind: 'failed_precondition',
              code: 'worker.git.commit.nothingToCommit',
              message: 'There are no changes to commit.',
              retry: { kind: 'never' },
            });
          const failure = gitWriteExitError(result);
          if (write.kind === 'push-head')
            throw new CanopyOperationError({
              kind: 'failed_precondition',
              code: 'worker.git.push.rejected',
              message: 'The remote rejected the push; the commits are kept.',
              ...gitWriteDetailsOf(failure),
              retry: { kind: 'never' },
            });
          throw failure;
        }
        return result.stdout.trim();
      };
      const sha = async (write: GitRepositoryWrite): Promise<string | null> => {
        const result = await run(write);
        if (result.exitCode === 0) return result.stdout.trim();
        // rev-parse --verify exits 128 for an absent ref.
        if (result.exitCode === 128 || result.exitCode === 1) return null;
        throw new GitRepositoryWriteError('exit_status');
      };
      return {
        currentBranch: () => succeeded({ kind: 'current-branch' }),
        head: () => sha({ kind: 'head-sha' }),
        trackingHead: (branch) => sha({ kind: 'tracking-head-sha', branch }),
        stageAll: async () => {
          await succeeded({ kind: 'stage-all' });
        },
        commit: async (message) => {
          await succeeded({ kind: 'commit-message', message });
          return succeeded({ kind: 'head-sha' });
        },
        push: async ({ branch, headSha }) => {
          const key = context.metadata.idempotencyKey;
          if (!key) throw new GitRepositoryWriteError('invalid_request');
          await succeeded({ kind: 'push-head', key, branch, headSha });
          // The push landed: tracking it is a convenience, as `-u` was, so
          // a failure here doesn't turn the landed push into an error.
          try {
            await run({ kind: 'set-upstream', branch });
          } catch {
            // Left untracked; the next push sets it again.
          }
        },
      };
    },
  };
}
