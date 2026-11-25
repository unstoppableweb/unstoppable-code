import type {
  CanopyErrorPayload,
  CanopyJsonRpcId,
  CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';
import {
  CLOUD_SESSION_WAKE_HEADER,
  CLOUD_SESSION_WAKE_HEADER_VALUE,
} from '@canopy/protocol/cloud-session';
import { CanopyTransportError } from '@canopy/core-transport';
import { connectCanopyHttp } from '@canopy/core-transport/http';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type {
  RelayBindingConnection,
  RelayBindingProvider,
} from '../canopy-runtime/renderer-relay/definitions';

/**
 * Electron main's connection to the web core (CAN-4185 D1, D3; CAN-5989).
 *
 * Main opens each connection with the signed-in account's desktop key and
 * keeps the connection token the web core returns for it, in memory only;
 * every later request of that connection, the `/events` SSE included, carries
 * that token instead. The web core checks the key on every request, so
 * revoking it ends the connection. Neither credential reaches the renderer,
 * and nothing the renderer sends becomes a header or a credential.
 *
 * The same-origin wake proof is a header too, and main sets it in one place
 * only: `connectWebCoreForFilesWake`, the connection of main's own Files
 * wake (CAN-6724), on its one waking `worker.filesystem.directory.list`.
 * Every other connection, the renderer relay's included, never carries it.
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
  /**
   * Whether this connection's requests say the window can answer an agent's
   * secret requests (`canopy-shared-agent-secret-requests`), read per
   * request: the web core then lets a send announce `secret_requests` to
   * Agentic Core. Only the renderer's connection, which a person drives,
   * sets it; main's own sends never answer secret requests.
   */
  readonly announcesSecretRequests?: () => boolean;
}

/** The header Agentic Core and the web core read client capabilities from. */
export const AGENT_CONVERSATION_CAPABILITIES_HEADER =
  'x-agent-conversation-capabilities';
export const SECRET_REQUESTS_CAPABILITY = 'secret_requests';

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

const WAKING_LIST = 'worker.filesystem.directory.list';

/** Whether a posted body is a `directory.list` request that asks to wake. */
function isWakingList(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    isRecord(message) &&
    message.method === WAKING_LIST &&
    'id' in message &&
    isRecord(message.params) &&
    message.params.wake === true
  );
}

/**
 * Opens one authenticated web core connection: the relay's sessions and
 * main's own requests, such as attachment uploads (CAN-5988), share it.
 * It never carries the wake proof.
 */
export function connectWebCore(
  options: WebCoreBindingOptions,
  signal: AbortSignal,
): Promise<RelayBindingConnection> {
  return openWebCore(options, signal, false);
}

/**
 * The connection of main's Files wake (CAN-6724), and the only one that
 * carries the same-origin wake proof: on a `directory.list` that asks to
 * wake, never on any other request.
 */
export function connectWebCoreForFilesWake(
  options: WebCoreBindingOptions,
  signal: AbortSignal,
): Promise<RelayBindingConnection> {
  return openWebCore(options, signal, true);
}

async function openWebCore(
  options: WebCoreBindingOptions,
  signal: AbortSignal,
  wakeProof: boolean,
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
    headers.delete(CLOUD_SESSION_WAKE_HEADER);
    if (wakeProof && !isOpen && method === 'POST' && isWakingList(init.body))
      headers.set(CLOUD_SESSION_WAKE_HEADER, CLOUD_SESSION_WAKE_HEADER_VALUE);
    headers.delete(AGENT_CONVERSATION_CAPABILITIES_HEADER);
    if (method === 'POST' && options.announcesSecretRequests?.() === true)
      headers.set(
        AGENT_CONVERSATION_CAPABILITIES_HEADER,
        SECRET_REQUESTS_CAPABILITY,
      );
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
  return {
    ...withPrincipalCheck(opened, read.accountId),
    // Nothing to free here: the shared client sends `core.events.unsubscribe`
    // for a released stream (CAN-5970, CAN-6194) and drops its late frames.
    releaseStream: () => undefined,
  };
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
    send: (message, options) => {
      if (
        'method' in message &&
        message.method === INITIALIZE &&
        'id' in message
      )
        initializeIds.add(message.id);
      return connection.send(message, options);
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
