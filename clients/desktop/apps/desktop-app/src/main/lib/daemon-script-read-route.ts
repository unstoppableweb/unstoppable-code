import { CanopyClientError } from '@canopy/core-client';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  CanopyOperationError,
  type PlatformOperatingSystem,
} from '@canopy/core-runtime';
import {
  recordScriptReadRoute,
  type ScriptReadRouteOperation,
} from '@canopy/desktop-shared/node/work-counters';
import type { WorkerScriptScope } from '@canopy/protocol/canopy-core';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';

/**
 * Electron main's script run reads on the daemon (CAN-7663). The daemon reads
 * the same run logs and process table, so on a selected host it answers them
 * on main's script session. An unreachable daemon, or a session that closes
 * under the read, reads in process; a reached refusal is the answer. Like the
 * code-graph status reads, these send no route telemetry event; each read is
 * counted in the `route` work counters, where it ran.
 */

/** Which hosts read script runs from the daemon. Windows stays in process. */
export const DAEMON_SCRIPT_READ_PLATFORMS: Readonly<
  Record<PlatformOperatingSystem, boolean>
> = {
  darwin: true,
  linux: true,
  win32: false,
};

function hostPlatform(): PlatformOperatingSystem | null {
  try {
    return hostPlatformOperatingSystem();
  } catch {
    return null;
  }
}

/**
 * Reads only local state: a selected host, a worktree scope with no other
 * authority or target, and the daemon not latched unreachable.
 */
export function selectDaemonScriptRead(scope: WorkerScriptScope): boolean {
  const platform = hostPlatform();
  return (
    platform !== null &&
    DAEMON_SCRIPT_READ_PLATFORMS[platform] === true &&
    scope.authorityId === undefined &&
    scope.targetId === undefined &&
    !getElectronDaemonHealth().isLatched()
  );
}

/** One script run read: the daemon's answer on a selected host, else `inProcess`. */
export async function readScriptRunsInDaemon<T>(
  operation: ScriptReadRouteOperation,
  scope: WorkerScriptScope,
  read: (session: ElectronDaemonClient) => Promise<T>,
  inProcess: () => Promise<T>,
): Promise<T> {
  if (!selectDaemonScriptRead(scope)) {
    recordScriptReadRoute(operation, 'direct');
    return inProcess();
  }
  const route = await import('./daemon-script-route');
  if (!route.isDaemonScriptRunLogPlace(scope)) {
    recordScriptReadRoute(operation, 'direct');
    return inProcess();
  }
  let answer: T;
  try {
    answer = await route.onDaemonScriptSession(read);
  } catch (error) {
    if (route.noteDaemonScriptFallback(error)) {
      recordScriptReadRoute(operation, 'daemon.fallback');
      return inProcess();
    }
    recordScriptReadRoute(operation, 'daemon.refused');
    throw error instanceof CanopyClientError
      ? new CanopyOperationError(error.payload, error)
      : error;
  }
  recordScriptReadRoute(operation, 'daemon.served');
  return answer;
}
