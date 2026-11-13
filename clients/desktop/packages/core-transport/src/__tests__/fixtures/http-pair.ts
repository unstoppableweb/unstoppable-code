// Client-side HTTP binding conformance (doc 05): the real `connectCanopyHttp`
// against a test-only server that speaks the web core's POST plus SSE
// contract (`apps/web/src/app/api/cloud/core/connections`) and hands each
// message to a framed server end. It stands in for the web core's routes and
// Postgres lease store, which this fixture does not exercise.
import {
  parseCanopyJsonRpcMessage,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';

import { connectCanopyHttp } from '../../http';
import {
  createInMemoryFramedPair,
  type CanopyFramedPair,
} from '../../in-memory';
import type { CanopyConformancePairOptions } from '../../conformance';
import type { CanopyFramedConnection } from '../../types';

const ENDPOINT = '/api/cloud/core/connections';

interface BridgedConnection {
  /** The bridge's end of the in-memory pair whose other end is `server`. */
  readonly relay: CanopyFramedConnection;
  /** POSTed requests awaiting their reply, by id. */
  readonly replies: Map<
    unknown,
    (message: CanopyJsonRpcMessage | null) => void
  >;
  /** Everything else the server sends, in order, as SSE events 1, 2, … */
  readonly pushes: CanopyJsonRpcMessage[];
  readonly wake: Set<() => void>;
}

const sse = (id: number, message: CanopyJsonRpcMessage): string =>
  `id: ${id}\ndata: ${JSON.stringify(message)}\n\n`;

export interface HttpTestServer {
  /** A same-origin fetch serving `ENDPOINT` (`/api/cloud/core/connections`). */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Ends a connection as a lapsed one ends; its next call answers 404. */
  end(connectionId: string): void;
  readonly connectionIds: () => readonly string[];
}

/**
 * The web core's POST plus SSE contract over in-memory framed pairs: each
 * opened connection hands its server end to `accept`, which refuses the open
 * with 409 by returning false.
 */
export function createHttpTestServer(
  accept: (server: CanopyFramedConnection) => boolean,
): HttpTestServer {
  const connections = new Map<string, BridgedConnection>();
  let opened = 0;
  const wakeAll = (bridged: BridgedConnection): void => {
    bridged.wake.forEach((wake) => wake());
    bridged.wake.clear();
  };
  const gone = (): Response =>
    Response.json({ error: 'not found' }, { status: 404 });

  const end = (id: string, bridged: BridgedConnection): void => {
    connections.delete(id);
    bridged.relay.close();
    bridged.replies.forEach((reply) => reply(null));
    bridged.replies.clear();
    wakeAll(bridged);
  };

  const bridge = (id: string, relay: CanopyFramedConnection): void => {
    const bridged: BridgedConnection = {
      relay,
      replies: new Map(),
      pushes: [],
      wake: new Set(),
    };
    connections.set(id, bridged);
    void (async (): Promise<void> => {
      for (;;) {
        const message = await bridged.relay.receive().catch(() => null);
        if (!message) break;
        const reply =
          'id' in message && !('method' in message)
            ? bridged.replies.get(message.id)
            : undefined;
        if (reply && 'id' in message) {
          bridged.replies.delete(message.id);
          reply(message);
        } else bridged.pushes.push(message);
        wakeAll(bridged);
      }
      // The server end closed: the connection is gone, as a lapsed one is.
      if (connections.get(id) === bridged) end(id, bridged);
    })();
  };

  const events = (
    bridged: BridgedConnection,
    id: string,
    after: number,
    signal: AbortSignal | null | undefined,
  ): Response => {
    let sent = after;
    // An aborted read ends its stream, as real fetch does.
    signal?.addEventListener('abort', () => wakeAll(bridged), { once: true });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller): Promise<void> => {
        while (sent >= bridged.pushes.length) {
          if (!connections.has(id) || signal?.aborted)
            return controller.close();
          await new Promise<void>((resolve) => bridged.wake.add(resolve));
        }
        sent += 1;
        controller.enqueue(encoder.encode(sse(sent, bridged.pushes[sent - 1])));
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === ENDPOINT) {
      const pair = await createInMemoryFramedPair();
      if (!accept(pair.server)) {
        pair.client.close();
        return Response.json({ error: 'refused' }, { status: 409 });
      }
      const id = `c-${(opened += 1)}`;
      bridge(id, pair.client);
      return Response.json({ connectionId: id }, { status: 201 });
    }
    const [id, leg] = path.slice(ENDPOINT.length + 1).split('/');
    const bridged = connections.get(id);
    if (!bridged) return gone();
    if (leg === 'events') {
      const header = new Headers(init?.headers).get('last-event-id');
      return events(bridged, id, Number(header ?? 0), init?.signal);
    }
    if (init?.method === 'DELETE') {
      end(id, bridged);
      return new Response(null, { status: 204 });
    }
    const body: unknown = JSON.parse(
      typeof init?.body === 'string' ? init.body : 'null',
    );
    const parsed = parseCanopyJsonRpcMessage(body);
    if (!parsed.success)
      return Response.json({ error: 'bad request' }, { status: 400 });
    const { message } = parsed;
    if (!('method' in message && 'id' in message)) {
      await bridged.relay.send(message);
      return new Response(null, { status: 202 });
    }
    const reply = new Promise<CanopyJsonRpcMessage | null>((resolve) =>
      bridged.replies.set(message.id, resolve),
    );
    await bridged.relay.send(message);
    const answered = await reply;
    return answered ? Response.json(answered) : gone();
  };

  return {
    fetch,
    end: (id) => {
      const bridged = connections.get(id);
      if (bridged) end(id, bridged);
    },
    connectionIds: () => Array.from(connections.keys()),
  };
}

/** One HTTP pair: `client` is `connectCanopyHttp`, `server` a framed end. */
export async function createHttpFramedPair(
  options: CanopyConformancePairOptions = {},
): Promise<CanopyFramedPair> {
  // Every pair option tunes the byte wire, auth or buffering HTTP lacks; fail
  // closed rather than silently pass a case that set one.
  if (Object.values(options).some((value) => value !== undefined))
    throw new Error('HTTP pairs take no pair options.');
  const servers: CanopyFramedConnection[] = [];
  // One connection per pair: a second open is refused.
  const http = createHttpTestServer(
    (opened) => servers.length === 0 && servers.push(opened) > 0,
  );
  const client = await connectCanopyHttp({
    endpoint: ENDPOINT,
    fetch: http.fetch,
  });
  const [server] = servers;
  if (!server) throw new Error('The HTTP pair did not open.');
  const clientWire = {
    write: (): never => {
      throw new Error('HTTP has no byte wire.');
    },
  };
  return { client, server, clientWire };
}
