// Browser-safe HTTP binding (doc 03, POST plus SSE): the same JSON-RPC 2.0
// envelopes, each POSTed to one server-issued connection with the response in
// the POST body, and server pushes as SSE from `<connection>/events`, reopened
// after the last event id it received. No Node imports.
import {
  parseCanopyJsonRpcMessage,
  type CanopyErrorPayload,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';

import { CanopyTransportError } from './errors';
import type { CanopyByteChannel, CanopyFramedConnection } from './types';

export interface CanopyHttpConnectOptions {
  /** The connections collection, for example `/api/cloud/core/connections`. */
  readonly endpoint: string;
  /** A same-origin fetch that carries the session (web: `fetchBackendUrl`). */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}

const CLOSED: CanopyErrorPayload = {
  kind: 'cancelled',
  message: 'The connection was closed.',
  retry: { kind: 'never' },
};

const STATUS_KINDS: ReadonlyMap<number, CanopyErrorPayload['kind']> = new Map([
  [401, 'unauthenticated'],
  [403, 'permission_denied'],
  [404, 'not_found'],
  [429, 'resource_exhausted'],
]);

function statusError(status: number): CanopyErrorPayload {
  const kind =
    STATUS_KINDS.get(status) ?? (status >= 500 ? 'unavailable' : 'internal');
  return {
    kind,
    message: `The web core answered HTTP ${status}.`,
    retry:
      kind === 'unavailable' ? { kind: 'same_request' } : { kind: 'never' },
  };
}

const UNREACHABLE: CanopyErrorPayload = {
  kind: 'unavailable',
  message: 'The web core is unreachable.',
  retry: { kind: 'same_request' },
};

const JSON_HEADERS = { 'content-type': 'application/json' };
const PUSH_RETRY_MS = 1_000;
const PUSH_MAX_RETRY_MS = 8_000;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  // An aborted signal never fires again, so its timer would outlive the connection.
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** One SSE frame's `id` and its `data` lines joined; comments are skipped. */
function sseFrame(frame: string): { id?: string; data?: string } {
  const values = (name: string): string[] =>
    frame
      .split('\n')
      .filter((line) => line.startsWith(`${name}:`))
      .map((line) => line.slice(name.length + 1).replace(/^ /, ''));
  const [id] = values('id');
  const data = values('data');
  return { id, data: data.length > 0 ? data.join('\n') : undefined };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The body as JSON (null when it is not JSON). A body that fails to arrive
 * is a transport failure, retryable unless the caller cancelled.
 */
async function readJson(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<{ readonly json: unknown } | CanopyErrorPayload> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return signal?.aborted ? CLOSED : UNREACHABLE;
  }
  return { json: parseJson(text) };
}

/** Opens one authenticated connection; rejects with the typed refusal. */
export async function connectCanopyHttp(
  options: CanopyHttpConnectOptions,
): Promise<CanopyFramedConnection> {
  const response = await options
    .fetch(options.endpoint, { method: 'POST', signal: options.signal })
    .catch(() => null);
  // A cancelled caller is never told to retry the setup it abandoned.
  if (!response)
    throw new CanopyTransportError(
      options.signal?.aborted ? CLOSED : UNREACHABLE,
    );
  if (!response.ok)
    throw new CanopyTransportError(statusError(response.status));
  const read = await readJson(response, options.signal);
  if (!('json' in read)) throw new CanopyTransportError(read);
  const body = read.json;
  const connectionId: unknown =
    typeof body === 'object' && body !== null
      ? Reflect.get(body, 'connectionId')
      : null;
  if (typeof connectionId !== 'string' || connectionId.length === 0)
    throw new CanopyTransportError({
      kind: 'internal',
      message: 'The web core returned no connection.',
      retry: { kind: 'never' },
    });
  const connection = new HttpConnection(connectionId, options);
  // An abort during setup fires before the connection listens for it.
  if (options.signal?.aborted) {
    connection.close();
    throw new CanopyTransportError(CLOSED);
  }
  return connection;
}

class HttpConnection implements CanopyFramedConnection {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly path: string;
  private readonly inbox: CanopyJsonRpcMessage[] = [];
  private readonly waiters: {
    resolve: (message: CanopyJsonRpcMessage) => void;
    reject: (error: CanopyTransportError) => void;
  }[] = [];
  private reason: CanopyErrorPayload = CLOSED;

  constructor(
    readonly connectionId: string,
    private readonly options: CanopyHttpConnectOptions,
  ) {
    this.path = `${options.endpoint}/${encodeURIComponent(connectionId)}`;
    options.signal?.addEventListener('abort', () => this.close(), {
      once: true,
      signal: this.signal,
    });
    void this.listen();
  }

  /**
   * The push leg. Reopened after a dropped or capped stream; given up when
   * the server serves none (streams off, or a connection the POSTs will
   * report gone), which leaves leases working without pushes.
   */
  private async listen(): Promise<void> {
    let lastEventId = '';
    let delayMs = PUSH_RETRY_MS;
    while (!this.signal.aborted) {
      const response = await this.options
        .fetch(`${this.path}/events`, {
          headers: {
            accept: 'text/event-stream',
            ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
          },
          signal: this.signal,
        })
        .catch(() => null);
      if (this.signal.aborted) return;
      const streaming =
        response?.ok === true &&
        response.headers.get('content-type')?.includes('text/event-stream') ===
          true;
      if (response && !streaming) {
        void response.body?.cancel().catch(() => undefined);
        if (response.status < 500 && response.status !== 429) return;
      } else if (response?.body) {
        lastEventId = await this.readPushes(response.body, lastEventId);
        delayMs = PUSH_RETRY_MS;
      }
      await pause(delayMs, this.signal);
      delayMs = Math.min(delayMs * 2, PUSH_MAX_RETRY_MS);
    }
  }

  /** Delivers each SSE `data` frame; returns the last event id seen. */
  private async readPushes(
    body: ReadableStream<Uint8Array>,
    lastEventId: string,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let seen = lastEventId;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done || this.signal.aborted) return seen;
        // A trailing CR waits for the next chunk: it may begin a CRLF.
        buffer = (
          buffer + decoder.decode(chunk.value, { stream: true })
        ).replace(/\r\n|\r(?!$)/g, '\n');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const { id, data } = sseFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (data === undefined) continue;
          const parsed = parseCanopyJsonRpcMessage(parseJson(data));
          if (!parsed.success) {
            this.finish(parsed.error);
            return seen;
          }
          if (id !== undefined) seen = id;
          this.deliver(parsed.message);
        }
      }
    } catch {
      // A dropped stream reopens after the last event id it delivered.
      return seen;
    } finally {
      reader.releaseLock();
    }
  }

  private deliver(message: CanopyJsonRpcMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(message);
    else this.inbox.push(message);
  }

  /** Resolves once the POST is issued; its response arrives through `receive`. */
  send(message: CanopyJsonRpcMessage): Promise<void> {
    if (this.signal.aborted)
      return Promise.reject(new CanopyTransportError(this.reason));
    void this.post(message);
    return Promise.resolve();
  }

  private async post(message: CanopyJsonRpcMessage): Promise<void> {
    const response = await this.options
      .fetch(this.path, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(message),
        signal: this.signal,
      })
      .catch(() => null);
    if (this.signal.aborted) return;
    if (!response) return this.finish(UNREACHABLE);
    if (!response.ok) return this.finish(statusError(response.status));
    // 202: a notification or response the server accepted with no reply.
    if (response.status === 202) return;
    const read = await readJson(response, this.signal);
    if (this.signal.aborted) return;
    if (!('json' in read)) return this.finish(read);
    const parsed = parseCanopyJsonRpcMessage(read.json);
    if (!parsed.success) return this.finish(parsed.error);
    this.deliver(parsed.message);
  }

  receive(options?: {
    readonly signal?: AbortSignal;
  }): Promise<CanopyJsonRpcMessage> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    if (this.signal.aborted)
      return Promise.reject(new CanopyTransportError(this.reason));
    if (options?.signal?.aborted)
      return Promise.reject(new CanopyTransportError(CLOSED));
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new CanopyTransportError(CLOSED));
      };
      const settle = (): void =>
        options?.signal?.removeEventListener('abort', cancel);
      const waiter = {
        resolve: (message: CanopyJsonRpcMessage): void => {
          settle();
          resolve(message);
        },
        reject: (error: CanopyTransportError): void => {
          settle();
          reject(error);
        },
      };
      this.waiters.push(waiter);
      options?.signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  openChannel(): Promise<CanopyByteChannel> {
    return Promise.reject(
      new CanopyTransportError({
        kind: 'capability_unavailable',
        message: 'Byte channels are not available over HTTP.',
        retry: { kind: 'never' },
      }),
    );
  }

  // No inbound channels exist on this binding.
  onChannel(): () => void {
    return () => undefined;
  }

  close(error?: CanopyErrorPayload): void {
    if (this.signal.aborted) return;
    // Best effort: an unreached server expires the connection with its lease.
    void this.options
      .fetch(this.path, { method: 'DELETE' })
      .catch(() => undefined);
    this.finish(error ?? CLOSED);
  }

  private finish(reason: CanopyErrorPayload): void {
    if (this.signal.aborted) return;
    this.reason = reason;
    this.controller.abort(new CanopyTransportError(reason));
    this.waiters
      .splice(0)
      .forEach((waiter) => waiter.reject(new CanopyTransportError(reason)));
  }
}
