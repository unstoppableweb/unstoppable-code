import { createHash } from 'node:crypto';
import { CanopyClientError } from '@canopy/core-client';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  CanopyOperationError,
  type PlatformOperatingSystem,
} from '@canopy/core-runtime';
import { recordScriptWriteRoute } from '@canopy/desktop-shared/node/work-counters';
import type {
  WorkerScriptExecutionClearParams,
  WorkerScriptExecutionClearResult,
} from '@canopy/protocol/canopy-core';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';

/**
 * Electron main's clear of a finished script run on the daemon (CAN-7663).
 * Both hosts change the run logs under the same cross-process lock
 * (CAN-5839), so on a selected host the daemon removes the run, sent with the
 * caller's key. Only a daemon unreachable before the send clears in process;
 * once sent, the daemon's answer, or its loss, is the answer. Each clear is
 * counted where it ran in the `route` work counters.
 */

/** Which hosts clear script runs on the daemon. Windows stays in process. */
export const DAEMON_SCRIPT_WRITE_PLATFORMS: Readonly<
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
export function selectDaemonScriptWrite(
  scope: WorkerScriptExecutionClearParams['scope'],
): boolean {
  const platform = hostPlatform();
  return (
    platform !== null &&
    DAEMON_SCRIPT_WRITE_PLATFORMS[platform] === true &&
    scope.authorityId === undefined &&
    scope.targetId === undefined &&
    !getElectronDaemonHealth().isLatched()
  );
}

/**
 * The key a routed clear is sent with. The daemon scopes keys per peer, and
 * every routed clear shares main's script session, so the caller's key is
 * bound to its principal, as the in-process handler scopes it.
 */
export function forwardedClearKey(
  principalId: string,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update('worker.script.execution.clear\0')
    .update(principalId)
    .update('\0')
    .update(idempotencyKey)
    .digest('hex');
}

/** One run's clear: the daemon's answer on a selected host, else `inProcess`. */
export async function clearScriptRunInDaemon(
  params: WorkerScriptExecutionClearParams,
  idempotencyKey: string,
  inProcess: () => Promise<WorkerScriptExecutionClearResult>,
): Promise<WorkerScriptExecutionClearResult> {
  if (!selectDaemonScriptWrite(params.scope)) {
    recordScriptWriteRoute('clear', 'direct');
    return inProcess();
  }
  const route = await import('./daemon-script-route');
  if (!route.isDaemonScriptRunLogPlace(params.scope)) {
    recordScriptWriteRoute('clear', 'direct');
    return inProcess();
  }
  let session: ElectronDaemonClient;
  try {
    session = await route.daemonScriptSession();
  } catch (error) {
    if (route.noteDaemonScriptFallback(error)) {
      recordScriptWriteRoute('clear', 'daemon.fallback');
      return inProcess();
    }
    recordScriptWriteRoute('clear', 'daemon.failed');
    throw error;
  }
  let answer: WorkerScriptExecutionClearResult;
  try {
    answer = await session.instruction(
      'worker.script.execution.clear',
      params,
      { metadata: { idempotencyKey } },
    );
  } catch (error) {
    recordScriptWriteRoute('clear', 'daemon.failed');
    throw error instanceof CanopyClientError
      ? new CanopyOperationError(error.payload, error)
      : error;
  }
  recordScriptWriteRoute('clear', 'daemon.served');
  return answer;
}
