import type {
  CanopyInstructionHandler,
  WorkerGitCheckoutScope,
  WorkerGitFetchErrorCode,
  WorkerGitFetchResult,
  WorkerGitPullErrorCode,
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
  fetchGitOrigin,
  pullGitBranch,
  type GitSyncWritePort,
} from './sync-writes';
import { WorkerGitScopeError } from './worker-git-branch-list';
import { isWorkerGitWriteCaller } from './worker-git-branch-writes';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';

/** The message the caller refusal carries. */
export const WORKER_GIT_SYNC_CALLER_REFUSED_MESSAGE =
  'Git fetch and pull are available only from the desktop app on this machine.';

/**
 * Host port for `worker.git.fetch` and `worker.git.pull`. The host maps the
 * scope to a checkout from trusted records and supplies its Git port;
 * checkout handles and paths never leave the host. Commands are never handed
 * the dispatcher's signal: a started fetch or pull runs to completion.
 */
export interface WorkerGitSyncWriteHost<
  Checkout,
> extends WorkerGitServedSelection {
  /** Throws {@link WorkerGitScopeError} for a refused scope. */
  resolveCheckout(
    scope: WorkerGitCheckoutScope,
    context: CanopyHandlerContext,
  ): Promise<Checkout>;
  port(checkout: Checkout, context: CanopyHandlerContext): GitSyncWritePort;
}

export interface WorkerGitSyncWriteHandlers {
  'worker.git.fetch': CanopyInstructionHandler<
    'worker.git.fetch',
    CanopyHandlerContext
  >;
  'worker.git.pull': CanopyInstructionHandler<
    'worker.git.pull',
    CanopyHandlerContext
  >;
}

type WorkerGitSyncErrorCode = WorkerGitFetchErrorCode | WorkerGitPullErrorCode;

interface FamilyCodes<Code extends WorkerGitSyncErrorCode> {
  readonly invalidScope: Code;
  readonly scopeUnsupported: Code;
  readonly callerRefused: Code;
  readonly headChanged?: Code;
}

const FETCH_CODES: FamilyCodes<WorkerGitFetchErrorCode> = {
  invalidScope: 'worker.git.fetch.invalidScope',
  scopeUnsupported: 'worker.git.fetch.scopeUnsupported',
  callerRefused: 'worker.git.fetch.callerRefused',
};

const PULL_CODES: FamilyCodes<WorkerGitPullErrorCode> = {
  invalidScope: 'worker.git.pull.invalidScope',
  scopeUnsupported: 'worker.git.pull.scopeUnsupported',
  callerRefused: 'worker.git.pull.callerRefused',
  headChanged: 'worker.git.pull.headChanged',
};

// Refreshing the checkout's branch state is what makes a retry meaningful.
const REFRESH = {
  kind: 'after_refresh',
  resource: 'worker.git.branch.list',
} as const;

// The host's own error stays the runtime cause, so in-process projections can
// rethrow it with its exact message. Unclassified Git failures stay untyped
// and the dispatcher reports them as `internal`.
function typedError<Code extends WorkerGitSyncErrorCode>(
  error: unknown,
  codes: FamilyCodes<Code>,
): unknown {
  if (error instanceof WorkerGitScopeError)
    return new CanopyOperationError(
      error.reason === 'invalid'
        ? {
            kind: 'invalid_argument',
            code: codes.invalidScope,
            message: error.message.slice(0, 4_096),
            retry: { kind: 'never' },
          }
        : {
            kind: 'failed_precondition',
            code: codes.scopeUnsupported,
            message: error.message.slice(0, 4_096),
            retry: { kind: 'never' },
          },
      error.hostCause ?? error,
    );
  if (error instanceof GitBranchWriteInterrupted)
    return error.reason === 'cancelled'
      ? canopyCancelledError()
      : new CanopyOperationError(
          {
            kind: 'unavailable',
            message: error.message.slice(0, 4_096),
            retry: REFRESH,
          },
          error.hostCause ?? error,
        );
  if (
    error instanceof GitBranchWriteRefusal &&
    error.reason === 'head-changed' &&
    codes.headChanged !== undefined
  )
    return new CanopyOperationError(
      {
        kind: 'conflict',
        code: codes.headChanged,
        message: error.message.slice(0, 4_096),
        retry: REFRESH,
      },
      error,
    );
  return error;
}

/**
 * `worker.git.fetch` and `worker.git.pull` over a host's checkout port. The
 * caller and the served selection are checked before the scope is resolved or
 * any Git runs; the caller allowlist is the branch writes' (CAN-4108 Q8).
 */
export function createWorkerGitSyncWriteHandlers<Checkout>(
  host: WorkerGitSyncWriteHost<Checkout>,
): WorkerGitSyncWriteHandlers {
  const run = async <Result, Code extends WorkerGitSyncErrorCode>(
    scope: WorkerGitCheckoutScope,
    context: CanopyHandlerContext,
    codes: FamilyCodes<Code>,
    operation: (port: GitSyncWritePort) => Promise<Result>,
  ): Promise<Result> => {
    if (!isWorkerGitWriteCaller(context.caller))
      throw new CanopyOperationError(
        {
          kind: 'permission_denied',
          code: codes.callerRefused,
          message: WORKER_GIT_SYNC_CALLER_REFUSED_MESSAGE,
          retry: { kind: 'never' },
        },
        new Error(WORKER_GIT_SYNC_CALLER_REFUSED_MESSAGE),
      );
    assertWorkerGitServedSelection(scope, host);
    try {
      const checkout = await host.resolveCheckout(scope, context);
      return await operation(host.port(checkout, context));
    } catch (error) {
      throw typedError(error, codes);
    }
  };
  return {
    'worker.git.fetch': (params, context) =>
      run(
        params.scope,
        context,
        FETCH_CODES,
        async (port): Promise<WorkerGitFetchResult> => {
          await fetchGitOrigin(port, params.prune);
          return { remote: 'origin', pruned: params.prune };
        },
      ),
    'worker.git.pull': (params, context) =>
      run(params.scope, context, PULL_CODES, (port) =>
        pullGitBranch(port, params.branch, params.strategy, {
          expectedBranch: params.expected?.branch,
        }),
      ),
  };
}
