import { once } from 'node:events';
import { createConnection } from 'node:net';
import {
  CANOPY_MAX_MESSAGE_BYTES,
  createCanopyFramedConnection,
} from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type {
  CanopyInstructionDefinitionMap,
  CanopyQueryDefinitionMap,
  CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';

import { createCanopyClient } from '../client';
import { CanopyDeliveryScope } from '../delivery';
import { CanopyClientError, toCanopyClientError } from '../errors';
import type { CanopyClient, CanopyClientOptions } from '../types';
import { canopyLaunchDetails } from './daemon-refusal';
import {
  canopyConnectError,
  MAX_CANOPY_CONNECT_TIMEOUT_MS,
  validateCanopyEndpoint,
  validateCanopyTimeout,
  type CanopyClientEndpoint,
} from './endpoint';

export interface CanopyConnectOptions {
  readonly endpoint: CanopyClientEndpoint;
  /**
   * One deadline for connect, authentication, and initialize; defaults to
   * `CANOPY_CONNECTION_DEFAULTS.connectTimeoutMs`. Setup sends once: a caller
   * retrying under its own deadline passes the time it has left.
   */
  readonly timeoutMs?: number;
  /** Cancels setup. After `connectCanopyClient` succeeds, aborting closes the client. */
  readonly signal?: AbortSignal;
}

const ignore = (): void => {};
const SETUP_MESSAGES = {
  cancelled: 'Connection setup was cancelled.',
  timedOut: 'Connection setup timed out.',
};

function handshakeTimeoutMs(scope: CanopyDeliveryScope): number {
  const remaining = scope.remainingMs();
  scope.check();
  // +1 ms (capped): the setup timer fires first and destroys the socket; the
  // transport's own timeout writes a close frame a silent peer never reads.
  return Math.min(remaining + 1, MAX_CANOPY_CONNECT_TIMEOUT_MS);
}

/** Reads `code` structurally: Node errors may come from another realm (Jest). */
function socketError(error: unknown): CanopyClientError {
  const { errno } = canopyLaunchDetails(error);
  const details = errno ? { errno } : undefined;
  return errno === 'EACCES' || errno === 'EPERM'
    ? canopyConnectError(
        'permission_denied',
        'Core endpoint access denied.',
        details,
      )
    : canopyConnectError(
        'unavailable',
        'No core accepted the connection.',
        details,
      );
}

async function openFramed(
  endpoint: CanopyClientEndpoint,
  scope: CanopyDeliveryScope,
): Promise<CanopyFramedConnection> {
  if (endpoint.kind === 'inMemory') return endpoint.connection;
  const socket = createConnection({ path: endpoint.path });
  // A late error after setup aborts `once` would otherwise be unhandled.
  socket.on('error', ignore);
  try {
    const connected = once(socket, 'connect', { signal: scope.signal });
    await scope.guard(
      connected.catch((error: unknown) => Promise.reject(socketError(error))),
      ignore,
    );
    const authenticating = createCanopyFramedConnection(socket, {
      role: 'client',
      auth: endpoint.auth,
      maxFrameBytes: endpoint.maxFrameBytes,
      maxMessageBytes: CANOPY_MAX_MESSAGE_BYTES,
      handshakeTimeoutMs: handshakeTimeoutMs(scope),
    });
    return await scope.guard(authenticating, (connection) =>
      connection.close(),
    );
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function redacted(
  error: unknown,
  endpoint: CanopyClientEndpoint,
): CanopyClientError {
  const failure = toCanopyClientError(error);
  if (endpoint.kind === 'inMemory') return failure;
  // Compared JSON-escaped, so a pipe path's backslashes match too.
  const text = JSON.stringify(failure.payload);
  const leaks = [endpoint.path, endpoint.auth.secret].some(
    (value) =>
      typeof value === 'string' &&
      value.length > 0 &&
      text.includes(JSON.stringify(value).slice(1, -1)),
  );
  if (!leaks) return failure;
  const { kind, retry } = failure.payload;
  return new CanopyClientError({
    kind,
    message: 'Connection setup failed.',
    // `after_refresh` names a resource, which may itself leak.
    retry: retry.kind === 'after_refresh' ? { kind: 'never' } : retry,
  });
}

async function setUp<T>(
  options: CanopyConnectOptions,
  run: (scope: CanopyDeliveryScope) => Promise<T>,
  release: (value: T) => void,
): Promise<T> {
  const { endpoint } = options;
  let scope: CanopyDeliveryScope | undefined;
  try {
    validateCanopyEndpoint(endpoint);
    scope = new CanopyDeliveryScope({
      timeoutMs: validateCanopyTimeout(options.timeoutMs),
      signal: options.signal,
      messages: SETUP_MESSAGES,
    });
    scope.check();
    return await scope.guard(run(scope), release);
  } catch (error) {
    // The connector owns an adopted connection from the call onward.
    if (endpoint.kind === 'inMemory') endpoint.connection.close();
    throw redacted(error, endpoint);
  } finally {
    scope?.dispose();
  }
}

/** Connects and authenticates; the returned connection ignores later aborts of `signal`. */
export function connectCanopyFramedConnection(
  options: CanopyConnectOptions,
): Promise<CanopyFramedConnection> {
  return setUp(
    options,
    (scope) => openFramed(options.endpoint, scope),
    (connection) => connection.close(),
  );
}

/** Connects, authenticates, and initializes under one deadline; then `signal` closes the client. */
export function connectCanopyClient<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap = Record<never, never>,
  S extends CanopyStreamDefinitionMap = Record<never, never>,
>(
  options: CanopyConnectOptions &
    Omit<CanopyClientOptions<Q, I, S>, 'connection'>,
): Promise<CanopyClient<Q, I, S>> {
  const release = (client: CanopyClient<Q, I, S>): void => void client.close();
  return setUp(
    options,
    async (scope) => {
      const connection = await openFramed(options.endpoint, scope);
      const initializing = createCanopyClient<Q, I, S>({
        ...options,
        connection,
      });
      try {
        return await scope.guard(initializing, release);
      } catch (error) {
        connection.close();
        throw error;
      }
    },
    release,
  );
}
