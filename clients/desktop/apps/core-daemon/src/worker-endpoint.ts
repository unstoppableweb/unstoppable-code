import { once } from 'node:events';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import type {
  PlatformEndpointListener,
  PlatformEndpointServices,
} from '@canopy/core-runtime';
import {
  acceptCanopyFramedConnections,
  type CanopyControlPlaneConnectionOptions,
} from '@canopy/core-runtime/node';
import {
  CANOPY_MAX_MESSAGE_BYTES,
  createCanopyFramedConnection,
  type CanopyFramedAuthOptions,
  type CanopyFramedConnection,
} from '@canopy/core-transport';

/**
 * The private socket or pipe a split daemon's worker binds for its one core
 * connection (CAN-5073). The address sits in the data root's owner-only
 * runtime directory, or is an owner-only pipe; the handshake secret travels
 * only in the core's stdin handoff.
 */
export interface DaemonWorkerEndpoint {
  readonly path: string;
  /** Stops accepting and releases the address; resolves once it is closed. */
  close(): Promise<void>;
}

/**
 * Both ends of the binding run one build: the core launches its worker from
 * its own executable. So each end joins message parts and sends them up to
 * what the other joins, as the bundled pair does (CAN-5684), unless a caller
 * pins a smaller cap.
 */
function workerBindingConnection(
  connection: CanopyControlPlaneConnectionOptions = {},
): CanopyControlPlaneConnectionOptions {
  const maxMessageBytes =
    connection.maxMessageBytes ?? CANOPY_MAX_MESSAGE_BYTES;
  return {
    ...connection,
    maxMessageBytes,
    peerMaxMessageBytes: connection.peerMaxMessageBytes ?? maxMessageBytes,
  };
}

/** A fresh endpoint name per worker start; short enough for socket paths. */
export function daemonWorkerEndpointAddress(
  endpoints: PlatformEndpointServices,
  dataRoot: string,
  endpointName: string,
): string {
  return endpoints.address({ dataRoot, endpointName }).path;
}

/**
 * Binds the worker's endpoint and hands every authenticated connection to
 * `onConnection`, as the binding's server end; a failed handshake has
 * already closed its stream.
 */
export async function listenDaemonWorkerEndpoint(options: {
  readonly endpoints: PlatformEndpointServices;
  readonly dataRoot: string;
  readonly endpointName: string;
  readonly auth: CanopyFramedAuthOptions;
  readonly connection?: CanopyControlPlaneConnectionOptions;
  readonly onConnection: (connection: CanopyFramedConnection) => void;
}): Promise<DaemonWorkerEndpoint> {
  const { endpoints, dataRoot, endpointName } = options;
  const bound =
    endpoints.semantics === 'filesystem-socket'
      ? await endpoints.bind(endpoints.address({ dataRoot, endpointName }))
      : await endpoints.bind(endpoints.address({ dataRoot, endpointName }));
  if (bound.kind !== 'bound') throw new Error('Worker endpoint unavailable.');
  const listener: PlatformEndpointListener<{ readonly path: string }> =
    bound.listener;
  acceptCanopyFramedConnections({
    listener,
    auth: options.auth,
    connection: workerBindingConnection(options.connection),
    onConnection: options.onConnection,
  });
  return { path: listener.address.path, close: () => listener.close() };
}

/** Authenticates an open stream to a worker's endpoint as the binding's client end. */
export function authenticateDaemonWorkerStream(
  stream: Duplex,
  auth: CanopyFramedAuthOptions,
  connection?: CanopyControlPlaneConnectionOptions,
): Promise<CanopyFramedConnection> {
  return createCanopyFramedConnection(stream, {
    ...workerBindingConnection(connection),
    role: 'client',
    auth,
  });
}

/** Connects to a worker's endpoint as the binding's client end. */
export async function connectDaemonWorkerEndpoint(options: {
  readonly path: string;
  readonly auth: CanopyFramedAuthOptions;
  readonly signal?: AbortSignal;
  readonly connection?: CanopyControlPlaneConnectionOptions;
}): Promise<CanopyFramedConnection> {
  const socket = createConnection({ path: options.path });
  // A late error after setup would otherwise be unhandled; the codec sees the close.
  socket.on('error', () => undefined);
  const abandon = (): void => {
    socket.destroy();
  };
  options.signal?.addEventListener('abort', abandon, { once: true });
  try {
    await once(socket, 'connect', { signal: options.signal });
    return await authenticateDaemonWorkerStream(
      socket,
      options.auth,
      options.connection,
    );
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abandon);
  }
}
