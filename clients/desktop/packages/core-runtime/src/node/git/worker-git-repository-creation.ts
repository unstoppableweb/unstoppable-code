import type { WORKER_GIT_REPOSITORY_CREATION_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherInstructionHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import { isWorkerGitWriteCaller } from './worker-git-branch-writes';

export type WorkerGitRepositoryCreationName =
  | 'worker.git.repository.initialize'
  | 'worker.git.repository.clone';

/** Destinations, remote URLs, clone options and progress stay behind the binding. */
export interface WorkerGitRepositoryCreationHost {
  consume(
    bindingId: string,
    operation: WorkerGitRepositoryCreationName,
    context: CanopyHandlerContext,
  ): () => Promise<void>;
}
export type WorkerGitRepositoryCreationHandlers =
  CanopyDispatcherInstructionHandlerMap<
    typeof WORKER_GIT_REPOSITORY_CREATION_INSTRUCTION_DEFINITIONS
  >;

export function createWorkerGitRepositoryCreationHandlers(
  host: WorkerGitRepositoryCreationHost,
): WorkerGitRepositoryCreationHandlers {
  const run = async (
    bindingId: string,
    operation: WorkerGitRepositoryCreationName,
    context: CanopyHandlerContext,
  ): Promise<Record<string, never>> => {
    const caller = context.caller;
    if (!isWorkerGitWriteCaller(caller) && caller.interfaceKind !== 'test')
      throw new CanopyOperationError({
        kind: 'permission_denied',
        code: 'worker.git.repository.callerRefused',
        message: 'This Git operation requires a local desktop caller.',
        retry: { kind: 'never' },
      });
    await host.consume(bindingId, operation, context)();
    return {};
  };
  return {
    'worker.git.repository.initialize': ({ bindingId }, context) =>
      run(bindingId, 'worker.git.repository.initialize', context),
    'worker.git.repository.clone': ({ bindingId }, context) =>
      run(bindingId, 'worker.git.repository.clone', context),
  };
}
