import type { CanopyJsonRpcMessage } from '@canopy/protocol/canopy-core';

import { connectCanopyHttp } from '../http';

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

/** A fake same-origin fetch: one JSON response per path, recorded calls. */
function fakeFetch(
  respond: (path: string, method: string, body: unknown) => Response,
): {
  readonly calls: Call[];
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (path, init): Promise<Response> => {
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body });
      // No push leg unless a test serves one.
      if (path.endsWith('/events'))
        return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(respond(path, method, body));
    },
  };
}

const ENDPOINT = '/api/cloud/core/connections';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const created = (): Response =>
  Response.json({ connectionId: 'c-1' }, { status: 201 });

describe('connectCanopyHttp', () => {
  it('posts each request and receives its JSON-RPC response', async () => {
    const http = fakeFetch((path, method, body) => {
      if (path === ENDPOINT) return created();
      if (method === 'DELETE') return new Response(null, { status: 204 });
      const id: unknown =
        typeof body === 'object' && body !== null
          ? Reflect.get(body, 'id')
          : undefined;
      const request: CanopyJsonRpcMessage | null =
        typeof id === 'string' || typeof id === 'number'
          ? { jsonrpc: '2.0', id, result: { ok: 1 } }
          : null;
      return request
        ? Response.json(request)
        : new Response(null, { status: 202 });
    });
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: http.fetch,
    });
    expect(connection.connectionId).toBe('c-1');

    await connection.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'core.runtime.initialize',
      params: {},
    });
    await expect(connection.receive()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { ok: 1 },
    });
    expect(
      http.calls.find((call) => call.method === 'POST' && call.body),
    ).toEqual({
      path: `${ENDPOINT}/c-1`,
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        id: 7,
        method: 'core.runtime.initialize',
        params: {},
      },
    });

    connection.close();
    expect(connection.signal.aborted).toBe(true);
    await expect(connection.receive()).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    expect(http.calls.at(-1)).toMatchObject({
      path: `${ENDPOINT}/c-1`,
      method: 'DELETE',
    });
  });

  it('closes with unauthenticated when the session is gone', async () => {
    const http = fakeFetch((path) =>
      path === ENDPOINT
        ? created()
        : Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: http.fetch,
    });
    const pending = connection.receive();
    await connection.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'core.client.lease.renew',
      params: {},
    });
    await expect(pending).rejects.toMatchObject({
      payload: { kind: 'unauthenticated' },
    });
    expect(connection.signal.aborted).toBe(true);
  });

  it('keeps the connection when a gateway answers one POST 503, and fails only that request, retryably', async () => {
    // As staging's load balancer answers when a deploy closes the pod's
    // connection mid-request (CAN-6394).
    let gatewayDown = true;
    const http = fakeFetch((path, _method, body) => {
      if (path === ENDPOINT) return created();
      if (gatewayDown) {
        gatewayDown = false;
        return new Response('upstream connect error', { status: 503 });
      }
      const id = Reflect.get(Object(body), 'id') as number;
      return Response.json({ jsonrpc: '2.0', id, result: { ok: 1 } });
    });
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: http.fetch,
    });
    await connection.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'core.chat.task.list',
      params: {},
    });
    await expect(connection.receive()).resolves.toMatchObject({
      id: 1,
      error: {
        data: { kind: 'unavailable', retry: { kind: 'same_request' } },
      },
    });
    expect(connection.signal.aborted).toBe(false);
    await connection.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'core.chat.task.list',
      params: {},
    });
    await expect(connection.receive()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { ok: 1 },
    });
    connection.close();
  });

  it('keeps the connection when one POST gets no response, and fails only that request, retryably (CAN-6442)', async () => {
    // As a local network blip leaves one request with no answer at all
    // ("fetch failed").
    let dropped = false;
    const http = fakeFetch((path, _method, body) => {
      if (path === ENDPOINT) return created();
      const id = Reflect.get(Object(body), 'id') as number;
      return Response.json({ jsonrpc: '2.0', id, result: { ok: 1 } });
    });
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: (path, init) => {
        if (path !== ENDPOINT && init?.method === 'POST' && !dropped) {
          dropped = true;
          return Promise.reject(new TypeError('fetch failed'));
        }
        return http.fetch(path, init);
      },
    });
    await connection.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'core.chat.task.list',
      params: {},
    });
    await expect(connection.receive()).resolves.toMatchObject({
      id: 1,
      error: {
        data: { kind: 'unavailable', retry: { kind: 'same_request' } },
      },
    });
    expect(connection.signal.aborted).toBe(false);
    await connection.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'core.chat.task.list',
      params: {},
    });
    await expect(connection.receive()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { ok: 1 },
    });
    connection.close();
  });

  it('ends the connection as unreachable when a second POST in a row gets no response (CAN-6442)', async () => {
    // A network that stays down is not a blip: the owner goes offline and
    // reconnects.
    const http = fakeFetch((path) =>
      path === ENDPOINT ? created() : new Response(null, { status: 500 }),
    );
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: (path, init) =>
        path !== ENDPOINT && init?.method === 'POST'
          ? Promise.reject(new TypeError('fetch failed'))
          : http.fetch(path, init),
    });
    await connection.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'core.chat.task.list',
      params: {},
    });
    await expect(connection.receive()).resolves.toMatchObject({ id: 1 });
    expect(connection.signal.aborted).toBe(false);
    const pending = connection.receive();
    await connection.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'core.chat.task.list',
      params: {},
    });
    await expect(pending).rejects.toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
    expect(connection.signal.aborted).toBe(true);
  });

  it('refuses to connect when the server refuses the connection', async () => {
    const http = fakeFetch(() => new Response(null, { status: 404 }));
    await expect(
      connectCanopyHttp({ endpoint: ENDPOINT, fetch: http.fetch }),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
  });

  it('closes the connection when the caller aborts during setup', async () => {
    const controller = new AbortController();
    const http = fakeFetch((path, method) => {
      if (method === 'DELETE') return new Response(null, { status: 204 });
      // The caller gives up while the opening response is being decoded.
      controller.abort();
      return created();
    });
    await expect(
      connectCanopyHttp({
        endpoint: ENDPOINT,
        fetch: http.fetch,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    expect(http.calls.at(-1)).toMatchObject({
      path: `${ENDPOINT}/c-1`,
      method: 'DELETE',
    });
  });

  it('reports a cancelled opening fetch as cancelled, not unavailable', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      connectCanopyHttp({
        endpoint: ENDPOINT,
        fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'cancelled', retry: { kind: 'never' } },
    });
  });

  it('never hands a reply to a receive that was already cancelled', async () => {
    const http = fakeFetch((path, _method, body) => {
      const id: unknown = Reflect.get(Object(body), 'id');
      return path === ENDPOINT
        ? created()
        : Response.json({ jsonrpc: '2.0', id, result: {} });
    });
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: http.fetch,
    });
    await expect(
      connection.receive({ signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    const live = connection.receive();
    await connection.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'core.runtime.initialize',
      params: {},
    });
    await expect(live).resolves.toMatchObject({ id: 3 });
    connection.close();
  });

  it('keeps a body that fails to arrive retryable, unlike a malformed one', async () => {
    const broken = (status: number): Response =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.error(new TypeError('reset')),
        }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    // The opening response drops mid-body: retry the setup.
    await expect(
      connectCanopyHttp({
        endpoint: ENDPOINT,
        fetch: () => Promise.resolve(broken(201)),
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
    // A complete body that is not JSON is the server's fault: never retried.
    await expect(
      connectCanopyHttp({
        endpoint: ENDPOINT,
        fetch: () => Promise.resolve(new Response('{', { status: 201 })),
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'internal', retry: { kind: 'never' } },
    });
    // A reply that drops mid-body closes the connection as unreachable.
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: (path) =>
        Promise.resolve(path === ENDPOINT ? created() : broken(200)),
    });
    const pending = connection.receive();
    await connection.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'core.runtime.initialize',
      params: {},
    });
    await expect(pending).rejects.toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
  });

  it('receives pushes over the event stream and resumes after the last one', async () => {
    const push = (n: number): CanopyJsonRpcMessage => ({
      jsonrpc: '2.0',
      method: 'core.client.lease.evicted',
      params: {
        leaseId: `l-${n}`,
        reason: 'expired',
        releasedRegistrationCount: 0,
      },
    });
    const sse = (chunks: string[], open = false): Response =>
      new Response(
        new ReadableStream({
          start: (controller): void => {
            for (const chunk of chunks)
              controller.enqueue(new TextEncoder().encode(chunk));
            if (!open) controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const opened: (string | null)[] = [];
    const fetch = (path: string, init?: RequestInit): Promise<Response> => {
      if (path === ENDPOINT) return Promise.resolve(created());
      if (path.endsWith('/events')) {
        opened.push(new Headers(init?.headers).get('last-event-id'));
        // Each stream ends after one push, as the lifetime cap does; the
        // second splits a CRLF across chunks.
        const streams = [
          [`: connected\n\nid: 1\ndata: ${JSON.stringify(push(1))}\n\n`],
          ['id: 2\r', `\ndata: ${JSON.stringify(push(2))}\r\n\r\n`],
        ];
        const next = streams[opened.length - 1];
        return Promise.resolve(next ? sse(next) : sse([], true));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const connection = await connectCanopyHttp({ endpoint: ENDPOINT, fetch });
    await expect(connection.receive()).resolves.toEqual(push(1));
    await expect(connection.receive()).resolves.toEqual(push(2));
    await until(() => opened.length === 3);
    expect(opened).toEqual([null, '1', '2']);
    connection.close();
  });

  it('leaves no retry timer behind when it closes during an open event stream', async () => {
    let setTimer: jest.SpiedFunction<typeof setTimeout> | undefined;
    let clearTimer: jest.SpiedFunction<typeof clearTimeout> | undefined;
    try {
      let streaming = false;
      const connection = await connectCanopyHttp({
        endpoint: ENDPOINT,
        fetch: (path, init) => {
          if (path === ENDPOINT) return Promise.resolve(created());
          if (!path.endsWith('/events'))
            return Promise.resolve(new Response(null, { status: 204 }));
          streaming = true;
          // An open stream that errors once its request is aborted, as fetch's does.
          const body = new ReadableStream<Uint8Array>({
            start: (controller): void =>
              init?.signal?.addEventListener('abort', () =>
                controller.error(new Error('aborted')),
              ),
          });
          return Promise.resolve(
            new Response(body, {
              headers: { 'content-type': 'text/event-stream' },
            }),
          );
        },
      });
      await until(() => streaming);
      // Spied only now, so a timer `until` armed and that fired is not counted.
      setTimer = jest.spyOn(globalThis, 'setTimeout');
      clearTimer = jest.spyOn(globalThis, 'clearTimeout');
      connection.close();
      for (let turn = 0; turn < 10; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      const cleared = new Set<unknown>(
        clearTimer.mock.calls.map(([timer]) => timer),
      );
      const pending = setTimer.mock.results
        .map(({ value }: { value: unknown }) => value)
        .filter((timer) => !cleared.has(timer));
      expect(pending).toEqual([]);
    } finally {
      setTimer?.mockRestore();
      clearTimer?.mockRestore();
    }
  });

  it('discards the body of an event stream answer that is not SSE', async () => {
    let cancelled = false;
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: (path) =>
        Promise.resolve(
          path === ENDPOINT
            ? created()
            : path.endsWith('/events')
              ? new Response(
                  new ReadableStream({
                    cancel: (): void => {
                      cancelled = true;
                    },
                  }),
                  { status: 404 },
                )
              : new Response(null, { status: 204 }),
        ),
    });
    await until(() => cancelled);
    connection.close();
  });

  it('stops the event stream when the server serves none, and leases still work', async () => {
    const http = fakeFetch((path, method, body) => {
      if (path === ENDPOINT) return created();
      if (path.endsWith('/events')) return new Response(null, { status: 404 });
      const id: unknown = Reflect.get(Object(body), 'id');
      return method === 'POST'
        ? Response.json({ jsonrpc: '2.0', id, result: {} })
        : new Response(null, { status: 204 });
    });
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: http.fetch,
    });
    await connection.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'core.runtime.initialize',
      params: {},
    });
    await expect(connection.receive()).resolves.toMatchObject({ id: 1 });
    expect(connection.signal.aborted).toBe(false);
    expect(
      http.calls.filter((call) => call.path.endsWith('/events')),
    ).toHaveLength(1);
    connection.close();
  });

  it('refuses byte channels in v1', async () => {
    const connection = await connectCanopyHttp({
      endpoint: ENDPOINT,
      fetch: fakeFetch(() => created()).fetch,
    });
    await expect(
      connection.openChannel({
        kind: 'pipeline.output',
        leaseId: 'l-1',
        caps: { maxChunkBytes: 1024, maxBufferedChunks: 4 },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    connection.close();
  });
});
