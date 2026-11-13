import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import type { WorkerPipelineHostLaunch } from '@canopy/protocol/canopy-core';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { isInheritedSensitiveEnv } from '@canopy/execution-engine/node/pipelines/executor/step-runner';

/*
 * What every client that sends a workflow to the daemon's pipeline host
 * (Electron main since CAN-5086, the CLI since CAN-5090) builds the same way.
 */

/** Which hosts may run workflows in the daemon. Windows since CAN-5091. */
export const DAEMON_PIPELINE_PLATFORMS: Readonly<
  Record<PlatformOperatingSystem, boolean>
> = {
  darwin: true,
  linux: true,
  win32: true,
};

/**
 * The base environment a launch sends as `_execution.childEnvironment`
 * (CAN-5086 D4): the enhanced environment without inherited credentials,
 * filtered as an in-process step's environment is, because the pipeline
 * host cannot tell what its launcher inherited.
 */
export function daemonPipelineProcessEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    getEnhancedEnv({ environment: false, includeCanopySecrets: false }),
  ))
    if (value !== undefined && !isInheritedSensitiveEnv(key, value))
      environment[key] = value;
  return environment;
}

function realOrNull(value: string): string | null {
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

function isWithin(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Whether every launch path lies where the daemon accepts it (CAN-5086 D17):
 * the working directory and repository in the worktree, the rest in the
 * worktree or the data root. The daemon refuses anything else, so such a
 * start runs in process instead.
 */
export function isDaemonPipelineLaunchInRoots(
  launch: WorkerPipelineHostLaunch,
  worktreePath: string,
): boolean {
  const worktree = realOrNull(worktreePath);
  const dataRoot = realOrNull(getCanopyDataDir());
  if (worktree === null) return false;
  const inWorktree = (value: string): boolean => {
    const real = realOrNull(value);
    return real !== null && isWithin(worktree, real);
  };
  const inRoots = (value: string): boolean => {
    const real = realOrNull(value);
    return (
      real !== null &&
      (isWithin(worktree, real) ||
        (dataRoot !== null && isWithin(dataRoot, real)))
    );
  };
  return (
    inWorktree(launch.cwd) &&
    (launch.repoPath === undefined || inWorktree(launch.repoPath)) &&
    [
      launch.pipelineFileDir,
      launch.pipelineDataDir,
      launch.assetsDir,
      launch.executionCheckoutRoot ?? undefined,
      ...Object.values(launch.assetPaths ?? {}),
    ].every((value) => value === undefined || inRoots(value))
  );
}
