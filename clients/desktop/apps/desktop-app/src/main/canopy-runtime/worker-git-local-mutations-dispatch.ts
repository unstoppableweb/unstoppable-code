import {
  CanopyOperationError,
  canopyUnavailableError,
} from '@canopy/core-runtime';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerGitFileRevertParams,
} from '@canopy/protocol/canopy-core';
import type { SnapshotRestoreRef } from '../lib/git';
import type {
  EnsureRepoShadowOptions,
  RepoShadowInfo,
} from '../lib/repo-shadow';
import type { DesktopCanopyDispatcher } from './desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { withLocalGitBinding } from './worker-git-local-mutations-binding';

export type WorkerGitLocalMutationDispatcher = Pick<
  DesktopCanopyDispatcher,
  'instruction'
>;
const coreCaller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'desktop-core-git',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [WORKER_GIT_GRANTS.write],
};
let activeLocalGitDispatcher: DesktopCanopyDispatcher | null = null;

/** Composition owns admission; an older runtime cannot clear a newer one. */
export function registerLocalGitMutationDispatcher(
  dispatcher: DesktopCanopyDispatcher,
): () => void {
  activeLocalGitDispatcher = dispatcher;
  return (): void => {
    if (activeLocalGitDispatcher === dispatcher)
      activeLocalGitDispatcher = null;
  };
}

/** The registered desktop dispatcher, or an unavailable error. */
export function activeLocalGitMutationDispatcher(): WorkerGitLocalMutationDispatcher {
  if (activeLocalGitDispatcher?.state !== 'accepting')
    throw canopyUnavailableError(
      'The desktop Git mutation runtime is unavailable.',
    );
  return activeLocalGitDispatcher;
}
async function legacy<Result>(effect: Promise<Result>): Promise<Result> {
  try {
    return await effect;
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.runtimeCause instanceof Error
    )
      throw error.runtimeCause;
    throw error;
  }
}

export async function revertFileThroughWorker(
  dispatcher: WorkerGitLocalMutationDispatcher,
  caller: CanopyCallerDescriptor,
  repoPath: string,
  params: Omit<WorkerGitFileRevertParams, 'bindingId'>,
): Promise<void> {
  await legacy(
    withLocalGitBinding(
      'worker.git.file.revert',
      repoPath,
      undefined,
      (bindingId) =>
        dispatcher.instruction(
          'worker.git.file.revert',
          { bindingId, ...params },
          { caller: { ...caller, grants: [WORKER_GIT_GRANTS.write] } },
        ),
    ),
  );
}
export async function restoreSnapshotThroughWorker(
  repoPath: string,
  ref: SnapshotRestoreRef,
  dispatcher?: WorkerGitLocalMutationDispatcher,
): Promise<void> {
  const runtime = dispatcher ?? activeLocalGitMutationDispatcher();
  await legacy(
    withLocalGitBinding(
      'worker.git.snapshot.restore',
      repoPath,
      undefined,
      (bindingId) =>
        runtime.instruction(
          'worker.git.snapshot.restore',
          { bindingId, ...ref },
          { caller: coreCaller },
        ),
    ),
  );
}
export async function persistTurnRefThroughWorker(
  repoPath: string,
  projectId: string,
  worktreeId: string,
  treeSha: string,
  dispatcher?: WorkerGitLocalMutationDispatcher,
): Promise<void> {
  const runtime = dispatcher ?? activeLocalGitMutationDispatcher();
  await legacy(
    withLocalGitBinding(
      'worker.git.turnRef.persist',
      repoPath,
      undefined,
      (bindingId) =>
        runtime.instruction(
          'worker.git.turnRef.persist',
          { bindingId, projectId, worktreeId, treeSha },
          { caller: coreCaller },
        ),
    ),
  );
}
export async function ensureRepoShadowThroughWorker(
  repoPath: string,
  options?: EnsureRepoShadowOptions,
  dispatcher?: WorkerGitLocalMutationDispatcher,
): Promise<RepoShadowInfo> {
  const runtime = dispatcher ?? activeLocalGitMutationDispatcher();
  const { shadow } = await legacy(
    withLocalGitBinding(
      'worker.git.repoShadow.ensure',
      repoPath,
      options,
      (bindingId) =>
        runtime.instruction(
          'worker.git.repoShadow.ensure',
          { bindingId },
          { caller: coreCaller },
        ),
    ),
  );
  if (shadow === undefined)
    throw new Error('The repository shadow result was not captured.');
  return shadow;
}
