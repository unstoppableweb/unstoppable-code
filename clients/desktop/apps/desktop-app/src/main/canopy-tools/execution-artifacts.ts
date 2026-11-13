import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideExecutionsDir } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import { isPathInside } from '../lib/path-safety';

export function getExecutionPlanPath(state: ExecutionState): string | null {
  return (
    state.event_data?.plan_ready?.plan_path ??
    state.event_data?.task_ready?.plan_path ??
    null
  );
}

export function resolveAllowedPath(
  filePath: string | undefined,
  baseDir: string,
  allowedRoots: string[],
): string | null {
  if (!filePath?.trim()) return null;
  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(baseDir, filePath);
  return allowedRoots.some((root) => isPathInside(root, resolvedPath))
    ? resolvedPath
    : null;
}

async function readFileOrNull(resolvedPath: string): Promise<string | null> {
  try {
    return await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

/**
 * An execution's report or plan, read only from the path its state records
 * and only inside its allowed directories: a report inside the executions
 * directory, a plan inside it or the run's working directory. Worktree
 * chats' execution reads and App Advisor's pipeline actions read and send
 * only what this returns (CAN-6001).
 */
export async function readExecutionArtifact(
  state: ExecutionState,
  artifact: { kind: 'report'; format?: 'text' | 'json' } | { kind: 'plan' },
): Promise<{ filePath: string; content: string } | null> {
  const { createElectronExecutionRuntime } =
    await import('../pipelines/execution-runtime');
  const { executionsDir } = createElectronExecutionRuntime();
  let resolvedPath: string | null;
  if (artifact.kind === 'report') {
    const filePath =
      artifact.format === 'json'
        ? state.report_outputs?.report_json_file
        : artifact.format === 'text'
          ? state.report_outputs?.report_file
          : (state.report_outputs?.report_file ??
            state.report_outputs?.report_json_file);
    resolvedPath = filePath ? path.resolve(filePath) : null;
    if (resolvedPath && !isPathInsideExecutionsDir(executionsDir, resolvedPath))
      resolvedPath = null;
  } else {
    // The executions root may be reached through a symlink while the daemon
    // records canonical paths, so it is checked the way reports are.
    const planPath = getExecutionPlanPath(state);
    const candidate = planPath?.trim()
      ? path.isAbsolute(planPath)
        ? path.resolve(planPath)
        : path.resolve(state.cwd, planPath)
      : null;
    resolvedPath =
      candidate &&
      (isPathInsideExecutionsDir(executionsDir, candidate) ||
        isPathInside(state.cwd, candidate))
        ? candidate
        : null;
  }
  if (!resolvedPath) return null;
  const content = await readFileOrNull(resolvedPath);
  return content === null ? null : { filePath: resolvedPath, content };
}
