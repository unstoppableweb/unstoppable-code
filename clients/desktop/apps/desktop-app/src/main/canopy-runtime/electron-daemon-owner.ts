import { app } from 'electron';
import { CanopyClientError, type CanopyClient } from '@canopy/core-client';
import { probeCanopyDaemon } from '@canopy/core-client/node';
import {
  CORE_MUTATION_FENCE_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  MUTATION_FENCE_GRANTS,
  WORKER_PIPELINE_GRANTS,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  getElectronDaemonHost,
  peekElectronDaemonHost,
} from './electron-daemon-access';
import {
  createElectronDaemonConnectionService,
  type ElectronDaemonConnectionService,
  type ElectronDaemonSession,
} from './electron-daemon-connection';

/*
 * Electron main's daemon owner session (CAN-5771, CAN-5095): a leased
 * connection that proves this process spawned the running daemon, over which
 * Electron main settles that daemon's host requests. It never spawns a
 * daemon and makes no runtime reads; those stay on the interface session.
 */

export const DAEMON_PIPELINE_OWNER_CLIENT_INSTANCE_ID =
  'electron-main:pipeline-owner';

/**
 * What the owner session calls on the daemon: the lease, runtime reads, the
 * host request channel and its split-lock fences (CAN-4730 E2-G).
 */
export const ELECTRON_DAEMON_OWNER_DEFINITIONS = {
  queries: { ...CORE_TRANSPORT_QUERY_DEFINITIONS },
  instructions: {
    ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    ...CORE_MUTATION_FENCE_INSTRUCTION_DEFINITIONS,
    'worker.pipeline.hostRequest.respond':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.hostRequest.respond'
      ],
  },
  streams: {
    'worker.pipeline.hostRequests':
      WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.hostRequests'],
  },
};
type D = typeof ELECTRON_DAEMON_OWNER_DEFINITIONS;
export type ElectronDaemonOwnerClient = CanopyClient<
  D['queries'],
  D['instructions'],
  D['streams']
>;

const ownerUnavailableErrors = new WeakSet<object>();

function ownerUnavailable(): CanopyClientError {
  const error = new CanopyClientError({
    kind: 'failed_precondition',
    message: "This app is not the background service's owner.",
    retry: { kind: 'never' },
  });
  ownerUnavailableErrors.add(error);
  return error;
}

/** Whether `error` means this app may not be the running daemon's owner. */
export function isDaemonOwnerUnavailable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ownerUnavailableErrors.has(error)
  );
}

let service:
  | ElectronDaemonConnectionService<ElectronDaemonOwnerClient>
  | undefined;
let disposed = false;
// Main's own session, as CAN-5086's workflow route holds its own: no
// renderer document owns it, so it lives until quit.
const owner = new AbortController();

function ownerService(): ElectronDaemonConnectionService<ElectronDaemonOwnerClient> {
  service ??= createElectronDaemonConnectionService<ElectronDaemonOwnerClient>({
    enabled: !disposed,
    authorityId: async () => (await getElectronDaemonHost()).authorityId,
    // An owner failure is no background-service warning, so the session
    // reports no reachability and rides no shared observers.
    lease: {
      label: 'Workflow host steps',
      interactive: false,
      foreground: false,
    },
    attach: async (signal): Promise<ElectronDaemonOwnerClient> => {
      const trusted = await getElectronDaemonHost();
      if (!(await trusted.owner.isSpawnedDaemon(signal)))
        throw ownerUnavailable();
      try {
        // Attach only, as W5's attach-only path: the owner session never
        // spawns a daemon.
        const found = await probeCanopyDaemon({
          dataRootHash: trusted.launch.dataRootHash,
          ports: trusted.launch.ports,
          signal,
          connect: (endpoint, setup) =>
            trusted.owner.connect({
              endpoint,
              ...setup,
              clientName: 'desktop',
              clientVersion: app.getVersion(),
              definitions: ELECTRON_DAEMON_OWNER_DEFINITIONS,
            }),
          dispose: (late) => late.close(),
        });
        if (found.kind !== 'live') throw ownerUnavailable();
        return found.value;
      } catch (error) {
        // The daemon refused the proof: this app is not its owner.
        if (
          error instanceof CanopyClientError &&
          error.payload.kind === 'unauthenticated'
        )
          ownerUnavailableErrors.add(error);
        throw error;
      }
    },
  });
  return service;
}

/** True once this process has spawned a daemon, so it may be that daemon's owner. */
export function isDaemonPipelineOwnerPossible(): boolean {
  return peekElectronDaemonHost()?.owner.hasSpawned() === true;
}

/**
 * The owner session's client (CAN-5771, CAN-5095): a leased connection that
 * proved this process spawned the running daemon. Throws a `CanopyClientError`
 * for which `isDaemonOwnerUnavailable` is true when it did not.
 */
export async function getDaemonPipelineOwnerClient(): Promise<ElectronDaemonOwnerClient> {
  return (await getDaemonOwnerSession()).client;
}

/** The owner session itself, for observers of its lease (split-lock fences). */
export async function getDaemonOwnerSession(): Promise<
  ElectronDaemonSession<ElectronDaemonOwnerClient>
> {
  const { authorityId } = await getElectronDaemonHost();
  return await ownerService().get(
    {
      principalId: 'electron-main',
      clientInstanceId: DAEMON_PIPELINE_OWNER_CLIENT_INSTANCE_ID,
      authorityId,
      interfaceKind: 'desktop',
      grants: [WORKER_PIPELINE_GRANTS.host, MUTATION_FENCE_GRANTS.publish],
    },
    owner.signal,
  );
}

/**
 * Aborts once the owner is disposed at quit, so anything watching the owner
 * session stops with it (CAN-4730 E2-G's split-lock fence publisher).
 */
export function daemonOwnerLifetime(): AbortSignal {
  return owner.signal;
}

/** Closes the owner session; quit and tests. */
export async function disposeDaemonPipelineOwner(): Promise<void> {
  disposed = true;
  owner.abort();
  const current = service;
  service = undefined;
  await current?.dispose();
}
