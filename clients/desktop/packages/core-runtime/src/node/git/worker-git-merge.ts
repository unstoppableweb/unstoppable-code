import type {
  CanopyInstructionHandler,
  WorkerGitCheckoutScope,
  WorkerGitMergeErrorCode,
} from '@canopy/protocol/canopy-core';
import {
  canopyCancelledError,
  CanopyOperationError,
} from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  GitBranchWriteInterrupted,
  GitBranchWriteRefusal,
} from './branch-writes';
import {
  GitMergeRefusal,
  mergeGitBranches,
  type GitMergeWritePort,
} from './merge-writes';
import { WorkerGitScopeError } from './worker-git-branch-list';
import { isWorkerGitWriteCaller } from './worker-git-branch-writes';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';

export interface WorkerGitMergeHost<Checkout> extends WorkerGitServedSelection {
  resolveCheckout(
    scope: WorkerGitCheckoutScope,
    context: CanopyHandlerContext,
  ): Promise<Checkout>;
  port(checkout: Checkout, context: CanopyHandlerContext): GitMergeWritePort;
}
export interface WorkerGitMergeHandlers {
  'worker.git.merge': CanopyInstructionHandler<
    'worker.git.merge',
    CanopyHandlerContext
  >;
}
const REFRESH = {
  kind: 'after_refresh',
  resource: 'worker.git.branch.list',
} as const;
const REFUSAL_CODES: Record<
  GitMergeRefusal['reason'],
  WorkerGitMergeErrorCode
> = {
  sameBranch: 'worker.git.merge.sameBranch',
  baseNotFound: 'worker.git.merge.baseNotFound',
  uncommittedChanges: 'worker.git.merge.uncommittedChanges',
  headChanged: 'worker.git.merge.headChanged',
};
export function createWorkerGitMergeHandlers<Checkout>(
  host: WorkerGitMergeHost<Checkout>,
): WorkerGitMergeHandlers {
  return {
    'worker.git.merge': async (params, context) => {
      if (!isWorkerGitWriteCaller(context.caller))
        throw new CanopyOperationError({
          kind: 'permission_denied',
          code: 'worker.git.merge.callerRefused',
          message:
            'Local branch merges are available only from the desktop app on this machine.',
          retry: { kind: 'never' },
        });
      assertWorkerGitServedSelection(params.scope, host);
      try {
        const checkout = await host.resolveCheckout(params.scope, context);
        return await mergeGitBranches(
          host.port(checkout, context),
          params.sourceBranch,
          params.baseBranch,
          params.expected?.branch,
        );
      } catch (error) {
        if (error instanceof WorkerGitScopeError)
          throw new CanopyOperationError(
            {
              kind:
                error.reason === 'invalid'
                  ? 'invalid_argument'
                  : 'failed_precondition',
              code:
                error.reason === 'invalid'
                  ? 'worker.git.merge.invalidScope'
                  : 'worker.git.merge.scopeUnsupported',
              message: error.message.slice(0, 4096),
              retry: { kind: 'never' },
            },
            error.hostCause ?? error,
          );
        // CAN-7169: a branch name Git would not accept never reaches the merge.
        if (
          error instanceof GitBranchWriteRefusal &&
          error.reason === 'invalid-name'
        )
          throw new CanopyOperationError(
            {
              kind: 'invalid_argument',
              message: error.message.slice(0, 4096),
              retry: { kind: 'never' },
            },
            error,
          );
        if (error instanceof GitMergeRefusal)
          throw new CanopyOperationError(
            {
              kind:
                error.reason === 'headChanged'
                  ? 'conflict'
                  : 'failed_precondition',
              code: REFUSAL_CODES[error.reason],
              message: error.message.slice(0, 4096),
              retry:
                error.reason === 'sameBranch' ? { kind: 'never' } : REFRESH,
            },
            error,
          );
        if (error instanceof GitBranchWriteInterrupted) {
          if (error.reason === 'cancelled') throw canopyCancelledError();
          throw new CanopyOperationError(
            {
              kind: 'unavailable',
              message: error.message.slice(0, 4096),
              retry: REFRESH,
            },
            error.hostCause ?? error,
          );
        }
        throw error;
      }
    },
  };
}
