import { CanopyClientError } from '@canopy/core-client';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  CanopyOperationError,
  type PlatformOperatingSystem,
} from '@canopy/core-runtime';
import {
  recordPipelineReadRoute,
  type PipelineReadRouteOperation,
} from '@canopy/desktop-shared/node/work-counters';
import {
  WORKER_PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  daemonUnreachableReason,
  markUnreachable,
} from '../canopy-runtime/electron-daemon-connection';
import {
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
} from '../canopy-runtime/electron-daemon-access';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';

/**
 * Electron main's pipeline execution reads on the daemon (CAN-7874). On a
 * selected host main asks the daemon on its own read session. The daemon
 * reads runs under its own data root, which nothing on this path proves is
 * main's, so a run it doesn't know is read in process: a run main started
 * never goes missing. An unreachable daemon, or a session that closes under
 * the read, reads in process too; any other refusal is the answer. Each read
 * is counted in the `route` work counters, where it ran.
 */

/** Which hosts read pipeline executions from the daemon. Windows stays in process. */
export const DAEMON_PIPELINE_READ_PLATFORMS: Readonly<
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

/** Reads only local state: a selected host and the daemon not latched unreachable. */
export function selectDaemonPipelineRead(): boolean {
  const platform = hostPlatform();
  return (
    platform !== null &&
    DAEMON_PIPELINE_READ_PLATFORMS[platform] === true &&
    !getElectronDaemonHealth().isLatched()
  );
}

const owner = new AbortController();

/** Main's own pipeline read session with the daemon, under its verified authority. */
async function client(): Promise<ElectronDaemonClient> {
  getElectronDaemonHealth().setConsumerEnabled('pipelines', true);
  const { authorityId } = await getElectronDaemonFilesContext();
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-main:pipeline-reads',
    authorityId,
    interfaceKind: 'desktop',
    grants: [WORKER_PIPELINE_GRANTS.read],
  };
  return (await getElectronDaemonConnections().get(caller, owner.signal))
    .client;
}

/** A read on a fresh session; one the session dropped under reads as unreachable. */
async function onSession<T>(
  read: (session: ElectronDaemonClient) => Promise<T>,
): Promise<T> {
  const session = await client();
  try {
    return await read(session);
  } catch (error) {
    throw session.signal.aborted && !owner.signal.aborted
      ? markUnreachable(error, 'connection_lost')
      : error;
  }
}

function isNotFound(error: unknown): boolean {
  const payload =
    error instanceof CanopyClientError || error instanceof CanopyOperationError
      ? error.payload
      : undefined;
  return payload?.kind === 'not_found';
}

/** One pipeline execution read: the daemon's answer on a selected host, else `inProcess`. */
export async function readPipelineExecutionInDaemon<T>(
  operation: PipelineReadRouteOperation,
  read: (session: ElectronDaemonClient) => Promise<T>,
  inProcess: () => Promise<T>,
): Promise<T> {
  if (!selectDaemonPipelineRead()) {
    recordPipelineReadRoute(operation, 'direct');
    return inProcess();
  }
  let answer: T;
  try {
    answer = await onSession(read);
  } catch (error) {
    const reason = daemonUnreachableReason(error);
    if (reason !== null) {
      getElectronDaemonHealth().noteFallback('pipelines', reason);
      recordPipelineReadRoute(operation, 'daemon.fallback');
      return inProcess();
    }
    if (isNotFound(error)) {
      recordPipelineReadRoute(operation, 'daemon.fallback');
      return inProcess();
    }
    recordPipelineReadRoute(operation, 'daemon.refused');
    throw error instanceof CanopyClientError
      ? new CanopyOperationError(error.payload, error)
      : error;
  }
  recordPipelineReadRoute(operation, 'daemon.served');
  return answer;
}
