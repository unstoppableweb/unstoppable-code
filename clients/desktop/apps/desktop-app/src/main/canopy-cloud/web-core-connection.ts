import type {
  CanopyErrorPayload,
  CanopyJsonRpcId,
  CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';
import { CanopyTransportError } from '@canopy/core-transport';
import { connectCanopyHttp } from '@canopy/core-transport/http';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type {
  RelayBindingConnection,
  RelayBindingProvider,
} from '../canopy-runtime/renderer-relay/definitions';
import { logMainProcessWarn } from '../lib/main-process-logging';

/**
 * Electron main's connection to the web core (CAN-4185 D1, D3; CAN-5989).
 *
 * Main opens each connection with the signed-in account's desktop key and
 * keeps the connection token the web core returns for it, in memory only;
 * every later request of that connection, the `/events` SSE included, carries
 * that token instead. The web core checks the key on every request, so
 * revoking it ends the connection. Neither credential reaches the renderer,
 * and nothing the renderer sends becomes a header or a credential.
 */

export const WEB_CORE_CONNECTIONS_PATH = '/api/cloud/core/connections';
const CONNECTION_TOKEN_PREFIX = 'cwc_';
const INITIALIZE = 'core.runtime.initialize';

/** What main opens a connection with; read fresh for each open. */
export interface WebCoreCredentials {
  /** The cloud origin the desktop is configured for. */
  readonly baseUrl: string;
  /** The signed-in account's OAuth desktop key. */
  readonly apiKey: string;
  /** The account's external id, which the web core must report back. */
  readonly accountId: string;
}

export interface WebCoreBindingOptions {
  /** `canopyDesktopCloudChats`, evaluated in main. */
  readonly isEnabled: () => boolean;
  /** The current account's credentials; rejects when signed out. */
  readonly readCredentials: () => Promise<WebCoreCredentials>;
  /**
   * Calls `listener` with the signed-in key and account after every account
   * change, or null after sign-out; returns the unsubscribe.
   */
  readonly onAccountChange: (
    listener: (
      current: { readonly apiKey: string; readonly accountId: string } | null,
    ) => void,
  ) => () => void;
  /** Defaults to the global fetch; tests inject a stub web core. */
  readonly fetch?: typeof fetch;
}

const NEVER: CanopyRetryDirective = { kind: 'never' };

const DISABLED: CanopyErrorPayload = {
  kind: 'capability_unavailable',
  message: 'Cloud chats are not available.',
  retry: NEVER,
};

const SESSION_ENDED: CanopyErrorPayload = {
  kind: 'unauthenticated',
  message: 'The cloud session ended.',
  retry: NEVER,
};

const CLOSED: CanopyErrorPayload = {
  kind: 'cancelled',
  message: 'The connection was closed.',
  retry: NEVER,
};

const WRONG_ACCOUNT: CanopyErrorPayload = {
  kind: 'unauthenticated',
  message: 'The cloud connection is not for the signed-in account.',
  retry: NEVER,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parked subscriptions on one connection that log a warning, once. */
export const PARKED_SUBSCRIPTION_WARNING_AT = 16;

/**
 * The connection with a local stream release. A web core that serves
 * `core.events.unsubscribe` drops a stream the renderer closes (the shared
 * client asks it, CAN-5970). One that predates it parks the stream: the relay
 * stops delivering and acknowledging it, and the core holds at most its
 * `maxInFlight` undelivered pushes until the connection ends. Other streams
 * keep running either way.
 */
function withParkedStreams(
  connection: CanopyFramedConnection,
): RelayBindingConnection {
  const parked = new Set<string>();
  return {
    connectionId: connection.connectionId,
    signal: connection.signal,
    send: (message) => connection.send(message),
    receive: (options) => connection.receive(options),
    openChannel: (request) => connection.openChannel(request),
    onChannel: (listener, options) => connection.onChannel(listener, options),
    close: (error) => connection.close(error),
    releaseStream: (subscriptionId, reason) => {
      if (
        reason === 'ended' ||
        reason === 'unsubscribed' ||
        parked.has(subscriptionId)
      )
        return;
      parked.add(subscriptionId);
      if (parked.size === PARKED_SUBSCRIPTION_WARNING_AT)
        logMainProcessWarn(
          '[web-core] A web core connection holds 16 parked stream subscriptions.',
        );
    },
  };
}

/**
 * One web core connection per relay session. Credentials are read per open,
 * so after an account change (which ends this connection) the next open uses
 * the new account's key.
 */
export function createWebCoreBindingProvider(
  options: WebCoreBindingOptions,
): RelayBindingProvider {
  return ({ signal }) => connectWebCore(options, signal);
}

/**
 * Opens one authenticated web core connection: the relay's sessions and
 * main's own requests, such as attachment uploads (CAN-5988), share it.
 */
export async function connectWebCore(
  options: WebCoreBindingOptions,
  signal: AbortSignal,
): Promise<RelayBindingConnection> {
  if (!options.isEnabled()) throw new CanopyTransportError(DISABLED);
  // Watch for sign-out, an account switch or a new key from before the
  // credentials are read: a change while the open is in flight ends it, and
  // one before the read completes leaves those credentials suspect. The web
  // core also ends a connection once its key is revoked.
  let credentials: WebCoreCredentials | null = null;
  let connection: CanopyFramedConnection | null = null;
  let ended = false;
  const opening = new AbortController();
  const stop = options.onAccountChange((current) => {
    if (
      credentials !== null &&
      current !== null &&
      current.apiKey === credentials.apiKey &&
      current.accountId === credentials.accountId
    )
      return;
    ended = true;
    opening.abort();
    connection?.close(SESSION_ENDED);
  });
  const fail = (payload: CanopyErrorPayload): never => {
    stop();
    throw new CanopyTransportError(payload);
  };
  let read: WebCoreCredentials;
  try {
    read = await options.readCredentials();
  } catch {
    return fail(SESSION_ENDED);
  }
  if (ended) return fail(SESSION_ENDED);
  if (signal.aborted) return fail(CLOSED);
  credentials = read;
  const send = options.fetch ?? globalThis.fetch;
  const origin = new URL(read.baseUrl).origin;
  let token: string | null = null;
  // The transport reports a failed open only as unreachable; keep the typed
  // refusal so the open answers with it. A raw network error, a body that
  // fails to arrive included, keeps the transport's retryable classification.
  let refusal: CanopyErrorPayload | null = null;

  // The key crosses only on the open; every later request carries the
  // connection token the open returned, which never leaves main.
  const fetch = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const isOpen = method === 'POST' && path === WEB_CORE_CONNECTIONS_PATH;
    const credential = isOpen ? read.apiKey : token;
    if (credential === null) {
      refusal = SESSION_ENDED;
      throw new CanopyTransportError(SESSION_ENDED);
    }
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${credential}`);
    if (method !== 'GET') headers.set('origin', origin);
    const response = await send(new URL(path, origin), {
      ...init,
      method,
      headers,
    });
    if (!isOpen || !response.ok) return response;
    const body: unknown = await response.json();
    const connectionId = isRecord(body) ? body.connectionId : undefined;
    const connectionToken = isRecord(body) ? body.connectionToken : undefined;
    if (
      typeof connectionToken !== 'string' ||
      !connectionToken.startsWith(CONNECTION_TOKEN_PREFIX)
    ) {
      refusal = SESSION_ENDED;
      throw new CanopyTransportError(SESSION_ENDED);
    }
    token = connectionToken;
    // The transport sees the connection id only.
    return Response.json({ connectionId }, { status: response.status });
  };

  const opened = await connectCanopyHttp({
    endpoint: WEB_CORE_CONNECTIONS_PATH,
    fetch,
    signal: AbortSignal.any([signal, opening.signal]),
  }).catch((error: unknown) => {
    if (ended) return fail(SESSION_ENDED);
    if (refusal !== null && !signal.aborted) return fail(refusal);
    stop();
    throw error;
  });
  connection = opened;
  opened.signal.addEventListener('abort', stop, { once: true });
  if (ended) opened.close(SESSION_ENDED);
  return withParkedStreams(withPrincipalCheck(opened, read.accountId));
}

/**
 * The connection, closed unless the web core's `core.runtime.initialize`
 * answer names the account main opened it for. Fails closed: an answer with
 * no principal, or another account's, ends the connection before anything
 * else is served.
 */
function withPrincipalCheck(
  connection: CanopyFramedConnection,
  accountId: string,
): CanopyFramedConnection {
  const initializeIds = new Set<CanopyJsonRpcId>();
  return {
    connectionId: connection.connectionId,
    signal: connection.signal,
    send: (message) => {
      if (
        'method' in message &&
        message.method === INITIALIZE &&
        'id' in message
      )
        initializeIds.add(message.id);
      return connection.send(message);
    },
    receive: async (options) => {
      const message = await connection.receive(options);
      if (!('id' in message) || 'method' in message || message.id === null)
        return message;
      if (!initializeIds.delete(message.id)) return message;
      if (!('result' in message)) return message;
      const authentication = isRecord(message.result)
        ? message.result.authentication
        : undefined;
      const principal = isRecord(authentication)
        ? authentication.principal
        : undefined;
      if (!isRecord(principal) || principal.userId !== accountId) {
        connection.close(WRONG_ACCOUNT);
        throw new CanopyTransportError(WRONG_ACCOUNT);
      }
      return message;
    },
    openChannel: (request) => connection.openChannel(request),
    onChannel: (listener, options) => connection.onChannel(listener, options),
    close: (error) => connection.close(error),
  };
}
