import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
  loadWindowsPipeSecurity,
  type GitReadSelections,
} from '@canopy/core-platform';
import {
  serveLocalWorkerBinding,
  type LocalWorkerBindingServer,
  type PlatformServices,
  type ShutdownReport,
} from '@canopy/core-runtime';
import {
  createFilesystemScopeResolver,
  readNativeRootIdentity,
} from '@canopy/core-runtime/node';
import { createRecordedWorkerGitHosts } from '@canopy/core-runtime/node/git';
import type { CanopyFramedConnection } from '@canopy/core-transport';
import { CANOPY_IN_PROCESS_WORKER_TARGET_ID } from '@canopy/protocol/canopy-core';
import {
  createCanopyDaemonWorkerGraph,
  daemonWorkerCaller,
} from './bundled-graph';
import { createClosureGate } from './closure-gate';
import { sealClosure } from './seal-closure';
import {
  createDaemonDirectoryInputs,
  type DaemonDirectoryInputsOptions,
} from './directory-inputs';
import {
  listenDaemonWorkerEndpoint,
  type DaemonWorkerEndpoint,
} from './worker-endpoint';
import type { DaemonWorkerHandoff } from './worker-handoff';

// The core connects right after the ready line; a worker it never reaches exits.
const CONNECT_TIMEOUT_MS = 30_000;

export interface StartCanopyDaemonWorkerOptions {
  /** The supervising core's canonical data root. */
  readonly dataRoot: string;
  readonly handoff: DaemonWorkerHandoff;
  /** This process's environment, which the core supplied in full. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Windows only: the staged pipe-security addon. */
  readonly pipeSecurityModule?: string;
  /** Test seam: decorates the host platform before the closure gate holds it. */
  readonly platformFor?: (platform: PlatformServices) => PlatformServices;
  /** Test seam for the Git read host factory. */
  readonly createGitHost?: DaemonDirectoryInputsOptions['createGitHost'];
}

export interface RunningCanopyDaemonWorker {
  /** Resolves once the core's binding has ended, or it never connected. */
  readonly disconnected: Promise<void>;
  /** Ends the binding, then the worker graph's phases 1–7. */
  stop(reason: string): Promise<ShutdownReport>;
  /** Stops the Git hosts and refuses later helpers; never rejects. */
  seal(): Promise<boolean>;
  gitSelections(): GitReadSelections;
}

/**
 * The `--profile worker` process a split daemon supervises (CAN-5073): the
 * worker graph on its own Git hosts, served to exactly one authenticated
 * core connection on a private endpoint. The endpoint stays bound for the
 * worker's life, since closing it ends its accepted streams; every later
 * peer is closed after its handshake. The worker stops when the core's
 * binding ends.
 */
export async function startCanopyDaemonWorker(
  options: StartCanopyDaemonWorkerOptions,
): Promise<RunningCanopyDaemonWorker> {
  const { dataRoot, handoff } = options;
  const os = hostPlatformOperatingSystem();
  const decorate =
    options.platformFor ?? ((raw: PlatformServices): PlatformServices => raw);
  const gate = createClosureGate(
    decorate(
      hostPlatformServices(
        createPlatformEndpointServices(os, {
          ...(os === 'win32' && {
            namedPipeSecurity: loadWindowsPipeSecurity(
              options.pipeSecurityModule ?? '',
            ),
          }),
        }),
      ),
    ),
  );
  const { platform } = gate;
  const inputs = createDaemonDirectoryInputs({
    os,
    canonicalDataRoot: dataRoot,
    environment: options.environment,
    ...(options.createGitHost && { createGitHost: options.createGitHost }),
  });
  const seal = (): Promise<boolean> => sealClosure(gate, inputs);
  let served: LocalWorkerBindingServer | undefined;
  let disconnect = (): void => undefined;
  const disconnected = new Promise<void>((settle) => {
    disconnect = settle;
  });
  const graph = createCanopyDaemonWorkerGraph({
    identity: {
      runtimeId: randomUUID(),
      hostId: 'local',
      authorityId: handoff.authorityId,
    },
    filesystem: {
      // The split qualifier has no Trash backend; trash requests fail closed.
      os,
      resolveScope: await createFilesystemScopeResolver({
        canonicalDataRoot: dataRoot,
        authorityId: handoff.authorityId,
        targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
        coworkManagedDirName: handoff.coworkManagedDirName,
        paths: { join, resolve, isAbsolute, sep, basename },
        rootIdentity: readNativeRootIdentity,
      }),
      directoryInputs: inputs.directoryInputs,
      services: inputs.services,
    },
    git: createRecordedWorkerGitHosts({
      dataRoot,
      authorityId: handoff.authorityId,
      recordsTargetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      os,
      arch: process.arch,
      git: inputs.git,
      writes: inputs.writes,
    }),
  });
  const { executor } = graph;
  if (executor === null) throw new Error('Worker graph has no executor.');
  // Started before the endpoint exists; the core connects right after ready.
  const timer = setTimeout(() => {
    if (served === undefined) disconnect();
  }, CONNECT_TIMEOUT_MS);
  const serve = (connection: CanopyFramedConnection): void => {
    // One core per worker: any later peer, even an authenticated one, is closed.
    if (served !== undefined) return connection.close();
    clearTimeout(timer);
    served = serveLocalWorkerBinding({
      dispatcher: graph.dispatcher,
      definitions: executor.definitions,
      receipts: executor.receipts,
      caller: daemonWorkerCaller(handoff.authorityId),
      connection,
    });
    served.signal.addEventListener('abort', () => disconnect(), {
      once: true,
    });
  };
  let endpoint: DaemonWorkerEndpoint;
  try {
    await graph.start();
    endpoint = await listenDaemonWorkerEndpoint({
      endpoints: platform.endpoints,
      dataRoot,
      endpointName: handoff.endpointName,
      auth: { secret: handoff.secret, dataRootHash: handoff.dataRootHash },
      onConnection: serve,
    });
  } catch (error) {
    clearTimeout(timer);
    await graph.shutdown('startup failed').catch(() => undefined);
    await seal();
    throw error;
  }
  const bound = endpoint;
  let stopping: Promise<ShutdownReport> | undefined;
  return {
    disconnected,
    stop: (reason) =>
      (stopping ??= (async (): Promise<ShutdownReport> => {
        clearTimeout(timer);
        served?.close();
        await bound.close().catch(() => undefined);
        return graph.shutdown(reason);
      })()),
    seal,
    gitSelections: () => inputs.gitSelections(),
  };
}
