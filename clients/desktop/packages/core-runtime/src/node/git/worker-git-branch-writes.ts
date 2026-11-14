import type {
  CanopyCallerDescriptor,
  CanopyErrorKind,
  CanopyInstructionHandler,
  WorkerGitBranchCreateErrorCode,
  WorkerGitBranchCreateResult,
  WorkerGitBranchDeleteErrorCode,
  WorkerGitBranchDeleteResult,
  WorkerGitBranchRenameErrorCode,
  WorkerGitBranchRenameResult,
  WorkerGitCheckoutErrorCode,
  WorkerGitCheckoutResult,
  WorkerGitCheckoutScope,
  WorkerGitRecordedRepositoryScope,
} from '@canopy/protocol/canopy-core';
import {
  canopyCancelledError,
  CanopyOperationError,
} from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  checkoutGitBranch,
  createGitBranch,
  deleteGitBranch,
  gitBranchCreateRequest,
  gitBranchDeleteName,
  GitBranchWriteInterrupted,
  GitBranchWriteRefusal,
  renameGitBranch,
  type GitBranchDeletePort,
  type GitBranchWritePort,
  type GitBranchWriteRefusalReason,
} from './branch-writes';
import { WorkerGitScopeError } from './worker-git-branch-list';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';

/** The message the caller refusal carries. */
export const WORKER_GIT_WRITE_CALLER_REFUSED_MESSAGE =
  'Git branch changes are available only from the desktop app on this machine.';

/**
 * Who may change a checkout's branch (CAN-4108 Q8): the trusted core (the
 * desktop's in-process ports, and the daemon's core-to-worker binding), and
 * desktop IPC callers: the local desktop user and a paired controller acting
 * through the desktop's IPC bridge, which tunnels the same channels. Renderer
 * relay surfaces (`local-desktop-renderer:*`), Portal sessions (interface
 * `portal`) and every other principal are refused, whatever their grants.
 */
export function isWorkerGitWriteCaller(
  caller: Pick<CanopyCallerDescriptor, 'principalId' | 'interfaceKind'>,
): boolean {
  if (caller.principalId === 'core') return true;
  return (
    caller.interfaceKind === 'desktop' &&
    (caller.principalId === 'local-desktop-user' ||
      caller.principalId.startsWith('remote-device:'))
  );
}

/**
 * Host port for `worker.git.checkout`, `worker.git.branch.create`,
 * `worker.git.branch.rename` and `worker.git.branch.delete`. The host maps
 * the scope to a checkout or a recorded repository from trusted records and
 * supplies its Git port; handles and paths never leave the host. Effects are
 * never handed the dispatcher's signal: a started mutation runs to completion.
 */
export interface WorkerGitBranchWriteHost<
  Checkout,
  Repository = Checkout,
> extends WorkerGitServedSelection {
  /** Throws {@link WorkerGitScopeError} for a refused scope. */
  resolveCheckout(
    scope: WorkerGitCheckoutScope,
    context: CanopyHandlerContext,
  ): Promise<Checkout>;
  port(checkout: Checkout, context: CanopyHandlerContext): GitBranchWritePort;
  /**
   * The repository a workspace records for `scope`; throws
   * {@link WorkerGitScopeError} for a refused or unrecorded one.
   */
  resolveRepository(
    scope: WorkerGitRecordedRepositoryScope,
    context: CanopyHandlerContext,
  ): Promise<Repository>;
  deletePort(
    repository: Repository,
    context: CanopyHandlerContext,
  ): GitBranchDeletePort;
}

export interface WorkerGitBranchWriteHandlers {
  'worker.git.checkout': CanopyInstructionHandler<
    'worker.git.checkout',
    CanopyHandlerContext
  >;
  'worker.git.branch.create': CanopyInstructionHandler<
    'worker.git.branch.create',
    CanopyHandlerContext
  >;
  'worker.git.branch.rename': CanopyInstructionHandler<
    'worker.git.branch.rename',
    CanopyHandlerContext
  >;
  'worker.git.branch.delete': CanopyInstructionHandler<
    'worker.git.branch.delete',
    CanopyHandlerContext
  >;
}

type WorkerGitWriteErrorCode =
  | WorkerGitCheckoutErrorCode
  | WorkerGitBranchCreateErrorCode
  | WorkerGitBranchRenameErrorCode
  | WorkerGitBranchDeleteErrorCode;

interface FamilyCodes<Code extends WorkerGitWriteErrorCode> {
  readonly invalidScope: Code;
  readonly scopeUnsupported: Code;
  readonly callerRefused: Code;
  readonly refusals: Partial<Record<GitBranchWriteRefusalReason, Code>>;
}

const CHECKOUT_CODES: FamilyCodes<WorkerGitCheckoutErrorCode> = {
  invalidScope: 'worker.git.checkout.invalidScope',
  scopeUnsupported: 'worker.git.checkout.scopeUnsupported',
  callerRefused: 'worker.git.checkout.callerRefused',
  refusals: {
    'uncommitted-changes': 'worker.git.checkout.uncommittedChanges',
    'branch-occupied': 'worker.git.checkout.branchOccupied',
    'branch-not-found': 'worker.git.checkout.branchNotFound',
    'head-changed': 'worker.git.checkout.headChanged',
  },
};

const CREATE_CODES: FamilyCodes<WorkerGitBranchCreateErrorCode> = {
  invalidScope: 'worker.git.branch.invalidScope',
  scopeUnsupported: 'worker.git.branch.scopeUnsupported',
  callerRefused: 'worker.git.branch.callerRefused',
  refusals: {
    'uncommitted-changes': 'worker.git.branch.uncommittedChanges',
    'invalid-name': 'worker.git.branch.invalidName',
    'invalid-start-point': 'worker.git.branch.invalidStartPoint',
    'head-changed': 'worker.git.branch.headChanged',
  },
};

const RENAME_CODES: FamilyCodes<WorkerGitBranchRenameErrorCode> = {
  invalidScope: 'worker.git.branch.invalidScope',
  scopeUnsupported: 'worker.git.branch.scopeUnsupported',
  callerRefused: 'worker.git.branch.callerRefused',
  refusals: {
    'invalid-name': 'worker.git.branch.invalidName',
    'name-unavailable': 'worker.git.branch.nameUnavailable',
    'head-changed': 'worker.git.branch.headChanged',
  },
};

const DELETE_CODES: FamilyCodes<WorkerGitBranchDeleteErrorCode> = {
  invalidScope: 'worker.git.branch.invalidScope',
  scopeUnsupported: 'worker.git.branch.scopeUnsupported',
  callerRefused: 'worker.git.branch.callerRefused',
  refusals: {
    'invalid-name': 'worker.git.branch.invalidName',
    'checked-out': 'worker.git.branch.checkedOut',
  },
};

const REFUSAL_KINDS: Record<GitBranchWriteRefusalReason, CanopyErrorKind> = {
  'uncommitted-changes': 'failed_precondition',
  'branch-occupied': 'failed_precondition',
  'branch-not-found': 'not_found',
  'invalid-name': 'invalid_argument',
  'invalid-start-point': 'invalid_argument',
  'name-unavailable': 'conflict',
  'checked-out': 'failed_precondition',
  'head-changed': 'conflict',
};

// Refreshing the checkout's branch state is what makes a retry meaningful.
const REFRESH = {
  kind: 'after_refresh',
  resource: 'worker.git.branch.list',
} as const;

// The host's own error stays the runtime cause, so in-process projections can
// rethrow it with its exact message. Unclassified failures stay untyped and
// the dispatcher reports them as `internal`.
function typedError<Code extends WorkerGitWriteErrorCode>(
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
  // No change ran after the interruption, so a refreshed retry is safe.
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
  if (error instanceof GitBranchWriteRefusal) {
    const kind = REFUSAL_KINDS[error.reason];
    return new CanopyOperationError(
      {
        kind,
        code: codes.refusals[error.reason],
        message: error.publicMessage.slice(0, 4_096),
        retry: kind === 'invalid_argument' ? { kind: 'never' } : REFRESH,
      },
      error,
    );
  }
  return error;
}

function assertWriteCaller<Code extends WorkerGitWriteErrorCode>(
  context: CanopyHandlerContext,
  codes: FamilyCodes<Code>,
): void {
  if (!isWorkerGitWriteCaller(context.caller))
    throw new CanopyOperationError(
      {
        kind: 'permission_denied',
        code: codes.callerRefused,
        message: WORKER_GIT_WRITE_CALLER_REFUSED_MESSAGE,
        retry: { kind: 'never' },
      },
      new Error(WORKER_GIT_WRITE_CALLER_REFUSED_MESSAGE),
    );
}

/**
 * The four branch writes over a host's checkout and repository ports. The
 * caller and the served selection are checked before the scope is resolved
 * or any Git runs.
 */
export function createWorkerGitBranchWriteHandlers<Checkout, Repository>(
  host: WorkerGitBranchWriteHost<Checkout, Repository>,
): WorkerGitBranchWriteHandlers {
  const guarded = async <Result, Code extends WorkerGitWriteErrorCode>(
    scope: WorkerGitCheckoutScope | WorkerGitRecordedRepositoryScope,
    context: CanopyHandlerContext,
    codes: FamilyCodes<Code>,
    work: () => Promise<Result>,
  ): Promise<Result> => {
    assertWriteCaller(context, codes);
    assertWorkerGitServedSelection(scope, host);
    try {
      return await work();
    } catch (error) {
      throw typedError(error, codes);
    }
  };
  const run = <Request, Result, Code extends WorkerGitWriteErrorCode>(
    scope: WorkerGitCheckoutScope,
    context: CanopyHandlerContext,
    codes: FamilyCodes<Code>,
    prepare: () => Request,
    operation: (port: GitBranchWritePort, request: Request) => Promise<Result>,
  ): Promise<Result> =>
    guarded(scope, context, codes, async () => {
      const request = prepare();
      const checkout = await host.resolveCheckout(scope, context);
      return operation(host.port(checkout, context), request);
    });
  return {
    'worker.git.checkout': (params, context) =>
      run(
        params.scope,
        context,
        CHECKOUT_CODES,
        () => params.branch,
        async (port, branch): Promise<WorkerGitCheckoutResult> => {
          await checkoutGitBranch(port, branch, {
            expectedBranch: params.expected?.branch,
            remote: params.remote,
          });
          return { branch };
        },
      ),
    // The new name and start point are checked before the checkout resolves,
    // as the desktop dialog's handler checked them.
    'worker.git.branch.create': (params, context) =>
      run(
        params.scope,
        context,
        CREATE_CODES,
        () => gitBranchCreateRequest(params.name, params.startPoint),
        (port, request): Promise<WorkerGitBranchCreateResult> =>
          createGitBranch(port, request.name, request.startPoint, {
            expectedBranch: params.expected?.branch,
            baseBranch:
              params.startPoint.source === 'catalog'
                ? params.startPoint
                : undefined,
          }),
      ),
    'worker.git.branch.rename': (params, context) =>
      run(
        params.scope,
        context,
        RENAME_CODES,
        () => params.name,
        async (port, name): Promise<WorkerGitBranchRenameResult> => {
          await renameGitBranch(port, name, {
            expectedBranch: params.expected?.branch,
          });
          return { branch: name };
        },
      ),
    // The name is checked before the repository resolves.
    'worker.git.branch.delete': (params, context) =>
      guarded(
        params.scope,
        context,
        DELETE_CODES,
        async (): Promise<WorkerGitBranchDeleteResult> => {
          const branch = gitBranchDeleteName(params.branch);
          const repository = await host.resolveRepository(
            params.scope,
            context,
          );
          await deleteGitBranch(
            host.deletePort(repository, context),
            branch,
            params.deletion,
          );
          return { branch };
        },
      ),
  };
}
