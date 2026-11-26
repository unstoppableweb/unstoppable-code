import { types } from 'node:util';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from './desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { activeLocalGitMutationDispatcher } from './worker-git-local-mutations-dispatch';
import {
  withRepositoryCreationBinding,
  type RepositoryCloneEffect,
  type RepositoryCreationEffect,
  type RepositoryInitializeEffect,
} from './worker-git-repository-creation-binding';

export type WorkerGitRepositoryCreationDispatcher = Pick<
  DesktopCanopyDispatcher,
  'instruction'
>;
/** An IPC projection's dispatcher and resolved caller; main's own callers omit it. */
export interface RepositoryCreationRoute {
  dispatcher: WorkerGitRepositoryCreationDispatcher;
  caller: CanopyCallerDescriptor;
}
const coreCaller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'desktop-core-git',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [WORKER_GIT_GRANTS.write],
};

async function dispatch(
  staged: RepositoryCreationEffect,
  route: RepositoryCreationRoute | undefined,
): Promise<void> {
  const dispatcher = route?.dispatcher ?? activeLocalGitMutationDispatcher();
  const caller = route
    ? { ...route.caller, grants: [WORKER_GIT_GRANTS.write] }
    : coreCaller;
  try {
    await withRepositoryCreationBinding(staged, (bindingId) =>
      dispatcher.instruction(staged.operation, { bindingId }, { caller }),
    );
  } catch (error) {
    // Callers keep the helper's own error: its message, code and, for a
    // refused clone, cleanupError.
    if (
      error instanceof CanopyOperationError &&
      (error.runtimeCause instanceof Error ||
        types.isNativeError(error.runtimeCause))
    )
      throw error.runtimeCause;
    throw error;
  }
}

export function initializeRepositoryThroughWorker(
  effect: RepositoryInitializeEffect,
  route?: RepositoryCreationRoute,
): Promise<void> {
  return dispatch(
    { operation: 'worker.git.repository.initialize', effect },
    route,
  );
}
export function cloneRepositoryThroughWorker(
  effect: RepositoryCloneEffect,
  route?: RepositoryCreationRoute,
): Promise<void> {
  return dispatch({ operation: 'worker.git.repository.clone', effect }, route);
}
