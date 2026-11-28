import { AsyncLocalStorage } from 'node:async_hooks';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import type { WorkerScriptExecuteParams } from '@canopy/protocol/canopy-core';

/**
 * A one-operation route the `script:run` handler opens; the dispatcher's
 * worker.script.execute handler claims it (CAN-5087). Only that handler opens
 * one, so every other script caller keeps Electron main's worker. Work the
 * run schedules later inherits the async context, never the route.
 */
export interface DaemonScriptRoute {
  /** Takes the route for this run; false once one has taken it. */
  claim(): boolean;
  /** The run the route took went to the daemon, not in process. */
  servedByDaemon(): void;
}

const routes = new AsyncLocalStorage<DaemonScriptRoute>();

/** Runs `work` with the daemon route open when `selected`. */
export async function withDaemonScriptRoute<T>(
  selected: boolean,
  work: () => Promise<T>,
): Promise<{ value: T; daemon: boolean }> {
  if (!selected) return { value: await work(), daemon: false };
  let claimed = false;
  let daemon = false;
  const value = await routes.run(
    {
      claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      servedByDaemon: () => {
        daemon = true;
      },
    },
    work,
  );
  return { value, daemon };
}

/** The route this dispatch may take, if its IPC handler opened one. */
export function currentDaemonScriptRoute(): DaemonScriptRoute | undefined {
  return routes.getStore();
}

/** D2's per-run conditions, as code: recorded, not terminal-backed, normal priority, a worktree context with ids. */
export function isDaemonScriptRunEligible(
  params: WorkerScriptExecuteParams,
): boolean {
  return (
    params.record !== undefined &&
    params.terminal === undefined &&
    params.priority === 'normal' &&
    (params.context.kind === 'project' ||
      params.context.kind === 'workspace-root' ||
      params.context.kind === 'workspace-repo') &&
    params.scope.workspaceId !== undefined &&
    params.scope.worktreeId !== undefined
  );
}

// Not the run route's gate: a Windows record is never identified, so Stop stays in process.
export const DAEMON_SCRIPT_STOP_PLATFORMS: Readonly<
  Record<PlatformOperatingSystem, boolean>
> = {
  darwin: true,
  linux: true,
  win32: false,
};

export function isDaemonScriptStopPlatform(
  platform: PlatformOperatingSystem | null,
): boolean {
  return platform !== null && DAEMON_SCRIPT_STOP_PLATFORMS[platform] === true;
}
