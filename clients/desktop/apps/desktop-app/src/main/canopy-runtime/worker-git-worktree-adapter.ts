import { AsyncLocalStorage } from 'node:async_hooks';
import { relative, sep } from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  createWorkerGitWorktreeWriteHandlers,
  WorkerGitScopeError,
  type WorkerGitWorktreeScope,
  type WorkerGitWorktreeWritePort,
} from '@canopy/core-runtime/node/git';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerGitCheckoutScope,
} from '@canopy/protocol/canopy-core';
import { createWorktree, removeWorktree, pruneWorktrees } from '../lib/git';
import {
  getWorkspaceWorktreesRootDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
} from '../lib/paths';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { validateId } from '../lib/validation';
import type { DesktopCanopyDispatcher } from './desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

export interface SourceChangeGit {
  createWorktree(
    this: void,
    repoPath: string,
    worktreePath: string,
    branch: string,
  ): Promise<string>;
  removeWorktree(
    this: void,
    repoPath: string,
    worktreePath: string,
  ): Promise<void>;
  bestEffortPruneWorktrees(this: void, repoPath: string, context: string): void;
}
type Scope = WorkerGitWorktreeScope;
interface Projection {
  scope: Scope;
  repoPath: string;
  worktreePath?: string;
  active: boolean;
}
const projections = new AsyncLocalStorage<Projection>();
function port(
  repoPath: string,
  worktreePath?: string,
): WorkerGitWorktreeWritePort {
  const target = (): string => {
    if (!worktreePath)
      throw new WorkerGitScopeError(
        'unsupported',
        'A worktree target is required.',
      );
    return worktreePath;
  };
  return {
    add: (branch, backgroundPriority) =>
      createWorktree(repoPath, target(), branch, { backgroundPriority }),
    remove: () => removeWorktree(repoPath, target()),
    prune: () => pruneWorktrees(repoPath),
  };
}
export function createDesktopWorktreeGitAdapter(): ReturnType<
  typeof createWorkerGitWorktreeWriteHandlers
> {
  return createWorkerGitWorktreeWriteHandlers({
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    resolve: async (scope, _context, operation) => {
      try {
        validateId(scope.workspaceId, 'workspaceId');
        if (scope.worktreeId !== undefined)
          validateId(scope.worktreeId, 'worktreeId');
        if (scope.repoId !== undefined && scope.repoId !== '__workspace_root__')
          validateId(scope.repoId, 'repoId');
      } catch (error) {
        throw new WorkerGitScopeError(
          'invalid',
          'The worktree scope identifiers are invalid.',
          error,
        );
      }
      // W5 additions/removals can precede record publication. Only the admitted
      // command's trusted projection bridges that gap; paths never cross the wire.
      const captured = projections.getStore();
      if (
        captured?.active &&
        scope.workspaceId === captured.scope.workspaceId &&
        scope.worktreeId === captured.scope.worktreeId &&
        scope.repoId === captured.scope.repoId
      )
        return port(captured.repoPath, captured.worktreePath);
      if (
        operation === 'remove' &&
        scope.worktreeId !== undefined &&
        !(
          await readWorkspaceWorktrees(scope.workspaceId, {
            persistRemovalCleanup: false,
          })
        ).some((row) => row.id === scope.worktreeId)
      )
        throw new WorkerGitScopeError(
          'unsupported',
          'The worktree is not recorded.',
        );
      const config = await readWorkspaceConfig(scope.workspaceId);
      const member =
        scope.repoId !== undefined && scope.repoId !== '__workspace_root__';
      const configured = member
        ? config.repos.find((repo) => repo.id === scope.repoId)?.repoPath
        : config.type === 'single-repo'
          ? config.repoPath
          : config.sourceRepoPath;
      if (!configured)
        throw new WorkerGitScopeError(
          'unsupported',
          'The repository is not recorded.',
        );
      const repoPath = member
        ? configured
        : await resolveProjectReferenceRepoPath(configured);
      const worktreePath =
        scope.worktreeId === undefined
          ? undefined
          : member
            ? getWorkspaceWorktreeRepoDir(
                scope.workspaceId,
                scope.worktreeId,
                scope.repoId ?? '',
              )
            : getWorkspaceWorktreeRootRepoDir(
                scope.workspaceId,
                scope.worktreeId,
              );
      return port(repoPath, worktreePath);
    },
  });
}
export function sourceChangeGit(
  workspaceId: string,
  dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>,
  caller: CanopyCallerDescriptor,
): SourceChangeGit {
  const repositories = new Map<string, Scope>();
  const scopeFor = (path: string): WorkerGitCheckoutScope => {
    const parts = relative(
      getWorkspaceWorktreesRootDir(workspaceId),
      path,
    ).split(sep);
    const [worktreeId, repos, repoId] = parts;
    if (
      !worktreeId ||
      !(
        parts.length === 1 ||
        (parts.length === 3 && repos === 'repos' && repoId)
      )
    )
      throw new WorkerGitScopeError(
        'invalid',
        'The worktree target is outside this workspace.',
      );
    validateId(worktreeId, 'worktreeId');
    if (repoId !== undefined) validateId(repoId, 'repoId');
    return {
      workspaceId,
      worktreeId,
      ...(repoId === undefined ? {} : { repoId }),
    };
  };
  const run = async <T>(
    projection: Omit<Projection, 'active'>,
    instruction: (
      runtime: Pick<DesktopCanopyDispatcher, 'instruction'>,
      scope: Scope,
    ) => Promise<T>,
  ): Promise<T> => {
    const captured = { ...projection, active: true };
    try {
      return await projections.run(captured, () =>
        instruction(dispatcher, captured.scope),
      );
    } catch (error) {
      if (
        error instanceof CanopyOperationError &&
        error.runtimeCause instanceof Error
      )
        throw error.runtimeCause;
      throw error;
    } finally {
      captured.active = false;
    }
  };
  // Only this command's own calls hold the worktree grant (CAN-7197).
  const options = {
    caller: { ...caller, grants: [WORKER_GIT_GRANTS.worktreeWrite] },
  };
  return {
    createWorktree: async (repoPath, worktreePath, branch) => {
      const scope = scopeFor(worktreePath);
      repositories.set(repoPath, {
        workspaceId,
        ...(scope.repoId === undefined ? {} : { repoId: scope.repoId }),
      });
      return run(
        { scope, repoPath, worktreePath },
        async (runtime) =>
          (
            await runtime.instruction(
              'worker.git.worktree.add',
              { scope, branch },
              options,
            )
          ).branch,
      );
    },
    removeWorktree: async (repoPath, worktreePath) => {
      const scope = scopeFor(worktreePath);
      repositories.set(repoPath, {
        workspaceId,
        ...(scope.repoId === undefined ? {} : { repoId: scope.repoId }),
      });
      await run({ scope, repoPath, worktreePath }, (runtime) =>
        runtime.instruction('worker.git.worktree.remove', { scope }, options),
      );
    },
    bestEffortPruneWorktrees: (repoPath, context) => {
      const prune = async (): Promise<void> => {
        const scope = repositories.get(repoPath);
        if (!scope)
          throw new WorkerGitScopeError(
            'unsupported',
            'The cleanup repository was not admitted.',
          );
        await run({ scope, repoPath }, (runtime) =>
          runtime.instruction('worker.git.worktree.prune', { scope }, options),
        );
      };
      void prune().catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[git] pruneWorktrees fallback failed (${context})`, {
          error,
          repoPath,
        });
      });
    },
  };
}
