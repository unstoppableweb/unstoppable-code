import { randomUUID } from 'node:crypto';
import type {
  CanopyInstructionHandler,
  WorkerGitCheckoutScope,
  WorkerGitOperationHandle,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  canopyCancelledError,
  canopyCapabilityUnavailableError,
} from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import { WorkerGitScopeError } from './worker-git-branch-list';
import { isWorkerGitWriteCaller } from './worker-git-branch-writes';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';

export interface GitCommitPushPort {
  currentBranch(this: void): Promise<string>;
  head(this: void): Promise<string | null>;
  trackingHead(this: void, branch: string): Promise<string | null>;
  stageAll(this: void): Promise<void>;
  commit(this: void, message: string): Promise<string>;
  push(this: void): Promise<void>;
}

export interface WorkerGitCommitPushHost<
  Checkout,
> extends WorkerGitServedSelection {
  resolveCheckout(
    scope: WorkerGitCheckoutScope,
    context: CanopyHandlerContext,
  ): Promise<Checkout>;
  port(checkout: Checkout, context: CanopyHandlerContext): GitCommitPushPort;
}

export interface WorkerGitCommitPushHandlers {
  'worker.git.commit': CanopyInstructionHandler<
    'worker.git.commit',
    CanopyHandlerContext
  >;
  'worker.git.push': CanopyInstructionHandler<
    'worker.git.push',
    CanopyHandlerContext
  >;
}

type Kind = 'worker.git.commit' | 'worker.git.push';

function refuse(
  kind:
    | 'conflict'
    | 'invalid_argument'
    | 'permission_denied'
    | 'failed_precondition',
  code: `${Kind}.${string}`,
  message: string,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind,
      code,
      message,
      retry:
        kind === 'conflict'
          ? { kind: 'after_refresh', resource: 'worker.git.branch.list' }
          : { kind: 'never' },
    },
    new Error(message),
  );
}

/** The synchronous desktop/daemon handle is not retained (CAN-4733). */
export function createWorkerGitCommitPushHandlers<Checkout>(
  host: WorkerGitCommitPushHost<Checkout>,
): WorkerGitCommitPushHandlers {
  const run = async (
    kind: Kind,
    scope: WorkerGitCheckoutScope,
    context: CanopyHandlerContext,
    effect: (port: GitCommitPushPort) => Promise<void>,
  ): Promise<WorkerGitOperationHandle> => {
    if (!isWorkerGitWriteCaller(context.caller))
      throw refuse(
        'permission_denied',
        `${kind}.callerRefused`,
        'Git writes are available only from the desktop app on this machine.',
      );
    assertWorkerGitServedSelection(scope, host);
    try {
      const checkout = await host.resolveCheckout(scope, context);
      await effect(host.port(checkout, context));
      return { operationId: randomUUID(), kind, status: 'completed' };
    } catch (error) {
      if (error instanceof WorkerGitScopeError)
        throw new CanopyOperationError(
          {
            kind:
              error.reason === 'invalid'
                ? 'invalid_argument'
                : 'failed_precondition',
            code: `${kind}.${error.reason === 'invalid' ? 'invalidScope' : 'scopeUnsupported'}`,
            message: error.message.slice(0, 4096),
            retry: { kind: 'never' },
          },
          error.hostCause ?? error,
        );
      throw error;
    }
  };
  return {
    'worker.git.commit': (params, context) =>
      run('worker.git.commit', params.scope, context, async (port) => {
        const { message } = params;
        // The web core's head revision (CAN-6093); this host advertises none.
        if (params.revision !== undefined)
          throw new CanopyOperationError({
            kind: 'capability_unavailable',
            message: 'This worker does not serve this revision.',
            details: { unsupported: ['revision'], reason: 'unserved' },
            retry: {
              kind: 'after_refresh',
              resource: 'core.runtime.manifest.get',
            },
          });
        if (
          params.paths !== undefined ||
          params.amend === true ||
          params.sign === true
        )
          throw new CanopyOperationError({
            kind: 'capability_unavailable',
            message: 'This worker commits every change as a new commit.',
            retry: { kind: 'never' },
          });
        // Only the web core writes a message for an absent one. An empty one
        // stays invalid_argument, as the schema answered it before CAN-6115,
        // and a blank one still fails at the commit, after staging.
        if (message === undefined)
          throw canopyCapabilityUnavailableError(
            "This worker commits with the caller's message only.",
          );
        if (message === '')
          throw new CanopyOperationError({
            kind: 'invalid_argument',
            message: 'The commit message is empty.',
            retry: { kind: 'never' },
          });
        const branch = await port.currentBranch();
        if (
          (params.expected !== undefined &&
            branch !== params.expected.branch) ||
          (await port.head()) !== params.expectedHeadSha
        )
          throw refuse(
            'conflict',
            'worker.git.commit.headChanged',
            'The branch changed. Start a new push.',
          );
        if (context.signal.aborted) throw canopyCancelledError();
        await port.stageAll();
        // Staging may run a filter. Recheck before the commit as well.
        if (
          (await port.currentBranch()) !== branch ||
          (await port.head()) !== params.expectedHeadSha
        )
          throw refuse(
            'conflict',
            'worker.git.commit.headChanged',
            'The branch changed. Start a new push.',
          );
        if (context.signal.aborted) throw canopyCancelledError();
        await port.commit(message);
      }),
    'worker.git.push': (params, context) =>
      run('worker.git.push', params.scope, context, async (port) => {
        if (params.remote !== 'origin' || params.setUpstream !== true)
          throw new CanopyOperationError({
            kind: 'capability_unavailable',
            message: 'This worker pushes HEAD to origin with its upstream.',
            retry: { kind: 'never' },
          });
        if (
          (await port.currentBranch()) !== params.branch ||
          (await port.head()) !== params.expectedLocalHeadSha
        )
          throw refuse(
            'conflict',
            'worker.git.push.headChanged',
            'The branch changed. Start a new push.',
          );
        // Unpinned, the remote branch is not checked.
        if (
          params.expectedRemoteHeadSha !== undefined &&
          (await port.trackingHead(params.branch)) !==
            params.expectedRemoteHeadSha
        )
          throw refuse(
            'conflict',
            'worker.git.push.remoteChanged',
            'The remote branch changed. Start a new push.',
          );
        if (context.signal.aborted) throw canopyCancelledError();
        await port.push();
      }),
  };
}
