import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  PipelineExecutionScope,
  ResolvedPipelineExecutionTarget,
} from '@canopy/execution-engine/types/pipeline';
import type {
  ExecutionOptions,
  ExecutionRuntime,
  ResolvePipelineTargetRequest,
  ResolvePipelineTargetResult,
} from './types';

async function assertDirectoryExists(targetPath: string): Promise<void> {
  try {
    const stats = await fsp.stat(targetPath);
    if (!stats.isDirectory()) {
      throw new Error();
    }
  } catch {
    throw new Error(`Directory target path does not exist: ${targetPath}`);
  }
}

export function inferExecutionScope(
  options: Pick<ExecutionOptions, 'scope' | 'projectId' | 'worktreeId'>,
): PipelineExecutionScope {
  if (options.scope) {
    return options.scope;
  }
  return options.projectId && options.worktreeId ? 'worktree' : 'directory';
}

export function getExecutionCheckoutRoot(
  options: Pick<
    ExecutionOptions,
    'scope' | 'target' | 'executionCheckoutRoot' | 'cwd'
  >,
): string | null | undefined {
  if (options.scope === 'global' || options.target?.scope === 'global')
    return undefined;
  if (options.executionCheckoutRoot === null) return null;
  return options.executionCheckoutRoot ?? options.target?.path ?? options.cwd;
}

export function defaultTargetForExecution(
  scope: PipelineExecutionScope,
  cwd: string,
  options: Pick<ExecutionOptions, 'projectId' | 'worktreeId'>,
): ResolvedPipelineExecutionTarget {
  if (scope === 'global') {
    return { scope: 'global' };
  }
  if (scope === 'worktree') {
    if (!options.projectId || !options.worktreeId) {
      throw new Error('Worktree execution requires projectId and worktreeId');
    }
    return {
      scope: 'worktree',
      workspace_id: options.projectId,
      worktree_id: options.worktreeId,
      path: cwd,
      created: false,
    };
  }
  return { scope: 'directory', path: cwd };
}

export async function validateResolvedExecutionTarget(
  runtime: ExecutionRuntime,
  target: ResolvedPipelineExecutionTarget | undefined,
): Promise<void> {
  if (!target) {
    return;
  }
  if (target.scope === 'directory') {
    await assertDirectoryExists(target.path);
    return;
  }
  if (target.scope === 'worktree') {
    if (!runtime.resolvePipelineTarget) {
      throw new Error(
        `Worktree target "${target.workspace_id}/${target.worktree_id}" no longer exists`,
      );
    }
    try {
      const resolved = await runtime.resolvePipelineTarget({
        parent: {
          cwd: target.path,
          scope: 'worktree',
          target,
          projectId: target.workspace_id,
          worktreeId: target.worktree_id,
          repoPath: target.path,
        },
        requested: {
          scope: 'worktree',
          workspace_id: target.workspace_id,
          worktree: { id: target.worktree_id },
        },
      });
      if (resolved.target.scope !== 'worktree') {
        throw new Error();
      }
      await assertDirectoryExists(resolved.target.path);
    } catch {
      throw new Error(
        `Worktree target "${target.workspace_id}/${target.worktree_id}" no longer exists`,
      );
    }
  }
}

export async function resolvePipelineTarget(
  runtime: ExecutionRuntime,
  request: ResolvePipelineTargetRequest,
): Promise<ResolvePipelineTargetResult> {
  if (request.requested.scope === 'worktree') {
    if (!runtime.resolvePipelineTarget) {
      throw new Error('This runtime cannot resolve worktree pipeline targets');
    }
    return runtime.resolvePipelineTarget(request);
  }

  if (request.requested.scope === 'inherit') {
    const inheritedTarget =
      request.parent.target &&
      (request.parent.target.scope === 'global' ||
        request.parent.target.path === request.parent.cwd)
        ? request.parent.target
        : defaultTargetForExecution(request.parent.scope, request.parent.cwd, {
            projectId: request.parent.projectId,
            worktreeId: request.parent.worktreeId,
          });

    return {
      cwd: request.parent.cwd,
      scope: request.parent.scope,
      target: inheritedTarget,
      projectId: request.parent.projectId,
      worktreeId: request.parent.worktreeId,
      repoPath: request.parent.repoPath,
    };
  }

  if (request.requested.scope === 'directory') {
    const resolvedPath = request.requested.path
      ? path.resolve(request.parent.cwd, request.requested.path)
      : request.parent.cwd;
    await assertDirectoryExists(resolvedPath);
    return {
      cwd: resolvedPath,
      scope: 'directory',
      target: { scope: 'directory', path: resolvedPath },
      repoPath: resolvedPath,
    };
  }

  return {
    cwd: request.parent.cwd,
    scope: 'global',
    target: { scope: 'global' },
  };
}
