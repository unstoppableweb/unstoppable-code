import { stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { ExecutionState } from '../../../types/pipeline';
import type { ExecutionRuntime } from './types';
import {
  defaultTargetForExecution,
  inferExecutionScope,
} from './pipeline-target-resolver';
import { getCompletedRootMigration } from '../../lib/completed-root-migration';
import {
  relocateCheckoutPath,
  relocateExecutionCheckout,
} from './execution-checkout-location';

/** Normalize the local replay copy before the executor reads any retained location. */
export async function resolveReplayLocation(
  state: ExecutionState,
  runtime: Pick<ExecutionRuntime, 'resolvePipelineTarget'>,
): Promise<ExecutionState> {
  const migration = await getCompletedRootMigration();
  const migrationRewrites = migration
    ? [{ fromRoot: migration.source, toRoot: migration.destination }]
    : [];
  const target = state.target;
  const scope =
    target?.scope ??
    inferExecutionScope({
      scope: state.scope,
      projectId: state.project_id,
      worktreeId: state.worktree_id,
    });
  const workspaceId =
    target?.scope === 'worktree' ? target.workspace_id : state.project_id;
  const worktreeId =
    target?.scope === 'worktree' ? target.worktree_id : state.worktree_id;
  const rewrites: Array<{ fromRoot: string; toRoot: string }> = [];
  if (
    scope === 'worktree' &&
    workspaceId &&
    worktreeId &&
    runtime.resolvePipelineTarget
  ) {
    const checkoutRoot =
      state.execution_checkout_root ??
      (target?.scope === 'worktree' ? target.path : state.cwd);
    const current = await runtime.resolvePipelineTarget({
      parent: {
        cwd: state.cwd,
        scope: 'worktree',
        target,
        projectId: workspaceId,
        worktreeId,
        repoPath: state.repo_path,
      },
      requested: {
        scope: 'worktree',
        workspace_id: workspaceId,
        worktree: { id: worktreeId },
      },
    });
    if (current.target.scope !== 'worktree')
      throw new Error('The current worktree location could not be resolved.');
    const currentRoot = relocateCheckoutPath(
      current.target.path,
      migrationRewrites,
    );
    const previousRoot = relocateCheckoutPath(
      currentRoot,
      migration
        ? [{ fromRoot: migration.destination, toRoot: migration.source }]
        : [],
    );
    // The retained checkout may be a selected repository inside the worktree.
    const fromRoot =
      [previousRoot, currentRoot].find((root) => {
        const suffix = relative(root, checkoutRoot);
        return (
          suffix !== '..' &&
          !suffix.startsWith(`..${sep}`) &&
          !isAbsolute(suffix)
        );
      }) ?? checkoutRoot;
    rewrites.push({
      fromRoot,
      toRoot: currentRoot,
    });
  }
  rewrites.push(...migrationRewrites);
  const relocated = relocateExecutionCheckout(state, {
    sourceWorkspaceId: workspaceId ?? '',
    sourceWorktreeId: worktreeId ?? '',
    destinationWorkspaceId: workspaceId ?? '',
    destinationWorktreeId: worktreeId ?? '',
    rewrites,
  });
  // A legacy replay otherwise reconstructs its target from the caller's cwd,
  // which can still name the retained root after this state's relocation.
  if (!target && relocated.cwd !== state.cwd) {
    relocated.target = defaultTargetForExecution(scope, relocated.cwd, {
      projectId: workspaceId,
      worktreeId,
    });
  }
  if (state.global_workspace_dir !== undefined) {
    relocated.global_workspace_dir = relocateCheckoutPath(
      state.global_workspace_dir,
      rewrites,
    );
  }
  const assets = state.pipeline_assets;
  if (assets) {
    relocated.pipeline_assets = {
      ...assets,
      asset_paths: Object.fromEntries(
        Object.entries(assets.asset_paths).map(([id, path]) => [
          id,
          relocateCheckoutPath(path, migrationRewrites),
        ]),
      ),
      ...(assets.pipeline_data_dir === undefined
        ? {}
        : {
            pipeline_data_dir: relocateCheckoutPath(
              assets.pipeline_data_dir,
              migrationRewrites,
            ),
          }),
      ...(assets.assets_dir === undefined
        ? {}
        : {
            assets_dir: relocateCheckoutPath(
              assets.assets_dir,
              migrationRewrites,
            ),
          }),
    };
  }
  // Never accept the predecessor just because its complete backup still exists.
  for (const [before, after] of [
    [state.cwd, relocated.cwd],
    [state.repo_path, relocated.repo_path],
    [state.execution_checkout_root, relocated.execution_checkout_root],
    [state.pipeline_file_dir, relocated.pipeline_file_dir],
    [
      target && target.scope !== 'global' ? target.path : undefined,
      relocated.target && relocated.target.scope !== 'global'
        ? relocated.target.path
        : undefined,
    ],
    [state.global_workspace_dir, relocated.global_workspace_dir],
    [assets?.pipeline_data_dir, relocated.pipeline_assets?.pipeline_data_dir],
    [assets?.assets_dir, relocated.pipeline_assets?.assets_dir],
    ...Object.entries(assets?.asset_paths ?? {}).map(([id, before]) => [
      before,
      relocated.pipeline_assets?.asset_paths[id],
    ]),
  ]) {
    if (!before || !after || before === after) continue;
    if (!(await directoryExists(after)))
      throw new Error(
        `Workflow replay refused: current folder does not exist: ${after}. The old folder is a backup; restore the current folder or start a new run.`,
      );
  }
  return relocated;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
