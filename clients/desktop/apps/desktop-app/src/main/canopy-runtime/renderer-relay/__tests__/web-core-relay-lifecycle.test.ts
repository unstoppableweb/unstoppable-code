import type {
  CanopyCallerDescriptor,
  CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import {
  WEB_CORE_CONNECTIONS_PATH,
  createWebCoreBindingProvider,
} from '../../../canopy-cloud/web-core-connection';

/** What the stub reads from a request the binding sends. */
interface StubRequest {
  readonly method?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal | null;
}
import { createWebCoreRendererRelay } from '../../../ipc/canopy-core-relay';
import type { RendererRelay, RendererRelayEvent } from '../relay';

/** The URL a fetch was called with; the binding always passes a URL. */
const urlOf = (input: URL | RequestInfo): URL =>
  input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);

/** The web core's unleased connection lifetime (apps/web connections.ts). */
const UNLEASED_TTL_MS = 90_000;
const LEASE_TTL_MS = 45_000;
const MAX_IN_FLIGHT = 256;
const EPOCH = 'epoch-1';
/** The web core's largest file read (apps/web web-core/files.ts). */
const WEB_CORE_MAX_READ_BYTES = 1024 * 1024;

interface StubSubscription {
  sent: number;
  acked: number;
  queued: number;
}

interface StubConnection {
  expiresAt: number;
  lease: { revision: number; expiresAt: number } | null;
  push: ((message: CanopyJsonRpcMessage) => void) | null;
  readonly backlog: CanopyJsonRpcMessage[];
  readonly subscriptions: Map<string, StubSubscription>;
}

/**
 * A web core behind the bridge: connection expiry and leases as the web core
 * keeps them, one stream (`core.chat.task.events`) holding at most
 * `MAX_IN_FLIGHT` unacknowledged items, `core.events.ack`, and, unless it
 * predates CAN-5970, `core.events.unsubscribe`.
 */
class StubWebCore {
  constructor(private readonly servesUnsubscribe = true) {}

  readonly connections = new Map<string, StubConnection>();
  readonly methods: string[] = [];
  private opened = 0;
  private subscriptionCount = 0;

  /** Queues `count` items on a subscription; they flow as acks allow. */
  emit(subscriptionId: string, count: number): void {
    for (const connection of this.connections.values()) {
      const subscription = connection.subscriptions.get(subscriptionId);
      if (!subscription) continue;
      subscription.queued += count;
      this.pump(connection, subscriptionId, subscription);
    }
  }

  subscription(subscriptionId: string): StubSubscription | undefined {
    for (const connection of this.connections.values()) {
      const found = connection.subscriptions.get(subscriptionId);
      if (found) return found;
    }
    return undefined;
  }

  get openedConnections(): number {
    return this.opened;
  }

  handle(path: string, init: StubRequest): Response {
    if (path === WEB_CORE_CONNECTIONS_PATH && init.method === 'POST') {
      this.opened += 1;
      const id = `conn-${this.opened}`;
      this.connections.set(id, {
        expiresAt: Date.now() + UNLEASED_TTL_MS,
        lease: null,
        push: null,
        backlog: [],
        subscriptions: new Map(),
      });
      return Response.json(
        { connectionId: id, connectionToken: `cwc_${id}` },
        { status: 201 },
      );
    }
    const [id, leg] = path
      .slice(WEB_CORE_CONNECTIONS_PATH.length + 1)
      .split('/');
    const connection = id === undefined ? undefined : this.connections.get(id);
    if (init.method === 'DELETE') {
      if (id !== undefined) this.connections.delete(id);
      return new Response(null, { status: 204 });
    }
    if (!connection || connection.expiresAt <= Date.now()) {
      if (id !== undefined) this.connections.delete(id);
      return new Response(null, { status: 404 });
    }
    if (leg === 'events') return this.events(connection, init);
    const request: unknown = JSON.parse(String(init.body));
    return Response.json(this.answer(connection, request));
  }

  private events(connection: StubConnection, init: StubRequest): Response {
    const encoder = new TextEncoder();
    let pushId = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        connection.push = (message): void => {
          pushId += 1;
          controller.enqueue(
            encoder.encode(
              `id: ${pushId}\ndata: ${JSON.stringify(message)}\n\n`,
            ),
          );
        };
        connection.backlog
          .splice(0)
          .forEach((message) => connection.push?.(message));
        init.signal?.addEventListener('abort', () => {
          connection.push = null;
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  private send(
    connection: StubConnection,
    message: CanopyJsonRpcMessage,
  ): void {
    if (connection.push) connection.push(message);
    else connection.backlog.push(message);
  }

  private pump(
    connection: StubConnection,
    subscriptionId: string,
    subscription: StubSubscription,
  ): void {
    while (
      subscription.queued > 0 &&
      subscription.sent - subscription.acked < MAX_IN_FLIGHT
    ) {
      subscription.queued -= 1;
      subscription.sent += 1;
      const sequence = subscription.sent;
      this.send(connection, {
        jsonrpc: '2.0',
        method: 'core.chat.task.events.item',
        params: {
          subscriptionId,
          cursor: { daemonEpoch: EPOCH, sequence },
          itemId: `${subscriptionId}-${sequence}`,
          occurredAt: '2026-11-07T12:00:00Z',
          item: {
            kind: 'task',
            workspaceId: 'workspace-1',
            worktreeId: 'task-1',
            batchId: `batch-${sequence}`,
          },
        },
      });
    }
  }

  private leaseResult(
    connection: StubConnection,
    clientInstanceId: string,
  ): unknown {
    const lease = connection.lease;
    if (!lease) throw new Error('no lease');
    return {
      leaseId: 'lease-1',
      clientInstanceId,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      renewAfterMs: 15_000,
      revision: lease.revision,
    };
  }

  private answer(connection: StubConnection, request: unknown): unknown {
    const message =
      typeof request === 'object' && request !== null ? request : {};
    const id: unknown = Reflect.get(message, 'id');
    const method = String(Reflect.get(message, 'method'));
    const rawParams: unknown = Reflect.get(message, 'params');
    const params =
      typeof rawParams === 'object' && rawParams !== null ? rawParams : {};
    this.methods.push(method);
    const now = Date.now();
    const result = (value: unknown): unknown => ({
      jsonrpc: '2.0',
      id,
      result: value,
    });
    switch (method) {
      case 'core.runtime.initialize':
        return result({
          runtime: {
            runtimeId: 'web-runtime',
            hostId: 'web-host',
            authorityId: 'web-core',
            profile: 'core',
            daemonEpoch: EPOCH,
            protocolVersions: [1],
            state: 'ready',
            buildVersion: '0.0.0-stub',
          },
          selectedProtocolVersion: 1,
          capabilities: {
            operations: [
              'core.workspace.list',
              'worker.filesystem.file.read',
              'core.client.lease.acquire',
              'core.client.lease.renew',
              'core.client.lease.release',
              'core.events.ack',
              ...(this.servesUnsubscribe ? ['core.events.unsubscribe'] : []),
            ],
            events: [],
            streams: ['core.chat.task.events'],
          },
          limits: {},
          authentication: {
            required: true,
            methods: [{ kind: 'desktop-key' }],
            principal: { userId: 'account-1', brandId: 'canopy' },
          },
        });
      case 'core.client.lease.acquire':
      case 'core.client.lease.renew': {
        connection.lease = {
          revision: method.endsWith('renew')
            ? (connection.lease?.revision ?? 0) + 1
            : 0,
          expiresAt: now + LEASE_TTL_MS,
        };
        connection.expiresAt = connection.lease.expiresAt + UNLEASED_TTL_MS;
        return result(
          this.leaseResult(
            connection,
            String(Reflect.get(params, 'clientInstanceId') ?? 'client'),
          ),
        );
      }
      case 'core.client.lease.release':
        connection.lease = null;
        connection.expiresAt = now + UNLEASED_TTL_MS;
        return result({
          released: true,
          releasedRegistrationCount: 0,
          failedRequestIds: [],
        });
      case 'core.workspace.list':
        return result({ items: [], nextCursor: null });
      case 'worker.filesystem.file.read':
        return result({
          fileRootId: 'workspace',
          relativePath: 'image.png',
          name: 'image.png',
          contentKind: 'image',
          encoding: 'base64',
          content: Buffer.alloc(WEB_CORE_MAX_READ_BYTES).toString('base64'),
          mediaType: 'image/png',
          sizeBytes: WEB_CORE_MAX_READ_BYTES,
          returnedBytes: WEB_CORE_MAX_READ_BYTES,
          truncated: false,
          modifiedAt: '2026-11-10T09:00:00.000Z',
          version: 'v1',
        });
      case 'core.chat.task.events': {
        this.subscriptionCount += 1;
        const subscriptionId = `sub-${this.subscriptionCount}`;
        connection.subscriptions.set(subscriptionId, {
          sent: 0,
          acked: 0,
          queued: 0,
        });
        return result({ subscriptionId, acceptedCursor: null });
      }
      case 'core.events.ack': {
        const subscriptionId = String(Reflect.get(params, 'subscriptionId'));
        const cursor: unknown = Reflect.get(params, 'cursor');
        const sequence = Number(
          typeof cursor === 'object' && cursor !== null
            ? Reflect.get(cursor, 'sequence')
            : 0,
        );
        const subscription = connection.subscriptions.get(subscriptionId);
        if (subscription) {
          subscription.acked = Math.max(subscription.acked, sequence);
          this.pump(connection, subscriptionId, subscription);
        }
        return result({ acknowledgedCursor: cursor });
      }
      case 'core.events.unsubscribe': {
        if (!this.servesUnsubscribe) break;
        const subscriptionId = String(Reflect.get(params, 'subscriptionId'));
        return result({
          unsubscribed: connection.subscriptions.delete(subscriptionId),
        });
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `${method} is not served.` },
    };
  }
}

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop',
  clientInstanceId: 'main',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

function mainWindowEvent(): RendererRelayEvent {
  const frame = {
    url: 'app://canopy/index.html',
    detached: false,
    isDestroyed: (): boolean => false,
  };
  return {
    sender: {
      id: 1,
      mainFrame: frame,
      getURL: () => frame.url,
      isDestroyed: () => false,
      on: () => undefined,
      removeListener: () => undefined,
    },
    senderFrame: frame,
  };
}

function webCoreRelay(server: StubWebCore): RendererRelay {
  return createWebCoreRendererRelay({
    bindingProvider: createWebCoreBindingProvider({
      isEnabled: () => true,
      readCredentials: () =>
        Promise.resolve({
          baseUrl: 'https://cloud.example.com',
          apiKey: 'csk_test',
          accountId: 'account-1',
        }),
      onAccountChange: () => () => undefined,
      fetch: (input, init = {}) =>
        Promise.resolve(server.handle(urlOf(input).pathname, init)),
    }),
    resolveSurface: () => ({ surface: 'main', caller: CALLER }),
  });
}

async function openTaskStream(
  relay: RendererRelay,
  event: RendererRelayEvent,
): Promise<string> {
  const reply = await relay.invoke(event, {
    kind: 'openStream',
    method: 'core.chat.task.events',
    params: { scope: 'all' },
  });
  if (!reply.ok) throw new Error(reply.error.message);
  const id: unknown =
    typeof reply.value === 'object' && reply.value !== null
      ? Reflect.get(reply.value, 'subscriptionId')
      : null;
  if (typeof id !== 'string') throw new Error('no relay subscription');
  return id;
}

async function readItem(
  relay: RendererRelay,
  event: RendererRelayEvent,
  subscriptionId: string,
): Promise<unknown> {
  const reply = await relay.invoke(event, {
    kind: 'readStream',
    subscriptionId,
  });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.value;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries += 1) {
    if (tries > 100) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const relays: RendererRelay[] = [];
afterEach(() => {
  relays.splice(0).forEach((relay) => relay.dispose());
  jest.useRealTimers();
});

describe('web core relay session lifecycle (CAN-4185 PR-C)', () => {
  it('a session open longer than the unleased connection lifetime still answers, and the renderer cannot call host-only operations', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const server = new StubWebCore();
    const relay = webCoreRelay(server);
    relays.push(relay);
    const event = mainWindowEvent();
    const list = { kind: 'request', method: 'core.workspace.list', params: {} };

    await expect(relay.invoke(event, list)).resolves.toMatchObject({
      ok: true,
    });
    expect(server.methods).toContain('core.client.lease.acquire');

    await jest.advanceTimersByTimeAsync(UNLEASED_TTL_MS * 3);
    await expect(relay.invoke(event, list)).resolves.toMatchObject({
      ok: true,
    });
    expect(server.openedConnections).toBe(1);
    expect(server.methods).toContain('core.client.lease.renew');

    for (const method of ['core.client.lease.acquire', 'core.events.ack'])
      await expect(
        relay.invoke(event, {
          kind: 'request',
          method,
          params: {
            subscriptionId: 'sub-1',
            cursor: { daemonEpoch: EPOCH, sequence: 1 },
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: 'capability_unavailable' },
      });
  });

  it('a file read at the web core read limit reaches the renderer whole (CAN-6175)', async () => {
    const server = new StubWebCore();
    const relay = webCoreRelay(server);
    relays.push(relay);
    const reply = await relay.invoke(mainWindowEvent(), {
      kind: 'request',
      method: 'worker.filesystem.file.read',
      params: {
        scope: { chatId: 'chat-1' },
        fileRootId: 'workspace',
        relativePath: 'image.png',
        maxBytes: WEB_CORE_MAX_READ_BYTES,
      },
    });
    expect(reply).toMatchObject({ ok: true });
    const content: unknown =
      reply.ok && typeof reply.value === 'object' && reply.value !== null
        ? Reflect.get(reply.value, 'content')
        : null;
    // Base64 of 1 MiB is past the 1 MiB local relay reply cap.
    expect(typeof content === 'string' && content.length).toBe(
      Math.ceil(WEB_CORE_MAX_READ_BYTES / 3) * 4,
    );
  });

  it('more than maxInFlight items flow through readStream without stalling', async () => {
    const server = new StubWebCore();
    const relay = webCoreRelay(server);
    relays.push(relay);
    const event = mainWindowEvent();
    const stream = await openTaskStream(relay, event);

    const total = MAX_IN_FLIGHT + 44;
    server.emit('sub-1', total);
    const cursors: number[] = [];
    for (let index = 0; index < total; index += 1) {
      const frame = await readItem(relay, event, stream);
      expect(frame).toMatchObject({ kind: 'item' });
      const cursor: unknown =
        typeof frame === 'object' && frame !== null
          ? Reflect.get(frame, 'cursor')
          : null;
      cursors.push(
        Number(
          typeof cursor === 'object' && cursor !== null
            ? Reflect.get(cursor, 'sequence')
            : 0,
        ),
      );
    }
    expect(cursors).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    );
  }, 20_000);

  it('closing one stream drops it at the web core and leaves a second stream delivering (CAN-5970)', async () => {
    const server = new StubWebCore();
    const relay = webCoreRelay(server);
    relays.push(relay);
    const event = mainWindowEvent();
    const first = await openTaskStream(relay, event);
    const second = await openTaskStream(relay, event);
    server.emit('sub-1', 1);
    await readItem(relay, event, first);

    await expect(
      relay.invoke(event, { kind: 'closeStream', subscriptionId: first }),
    ).resolves.toEqual({ ok: true, value: null });
    await waitFor(() => server.subscription('sub-1') === undefined);
    expect(
      server.methods.filter((method) => method === 'core.events.unsubscribe'),
    ).toHaveLength(1);
    server.emit('sub-2', 1);
    await expect(readItem(relay, event, second)).resolves.toMatchObject({
      kind: 'item',
      cursor: { sequence: 1 },
    });
    // Host-only: the renderer cannot unsubscribe a stream itself.
    await expect(
      relay.invoke(event, {
        kind: 'request',
        method: 'core.events.unsubscribe',
        params: { subscriptionId: 'sub-2' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    expect(server.subscription('sub-2')).toBeDefined();
    expect(server.openedConnections).toBe(1);
  });

  it('closing one stream on a web core without unsubscribe parks it and leaves a second stream delivering', async () => {
    const server = new StubWebCore(false);
    const relay = webCoreRelay(server);
    relays.push(relay);
    const event = mainWindowEvent();
    const first = await openTaskStream(relay, event);
    const second = await openTaskStream(relay, event);
    server.emit('sub-1', 1);
    server.emit('sub-2', 1);
    await readItem(relay, event, first);
    await readItem(relay, event, second);

    await expect(
      relay.invoke(event, { kind: 'closeStream', subscriptionId: first }),
    ).resolves.toEqual({ ok: true, value: null });
    server.emit('sub-1', 3);
    server.emit('sub-2', 1);
    await expect(readItem(relay, event, second)).resolves.toMatchObject({
      kind: 'item',
      cursor: { sequence: 2 },
    });
    await expect(
      relay.invoke(event, {
        kind: 'request',
        method: 'core.workspace.list',
        params: {},
      }),
    ).resolves.toMatchObject({ ok: true });
    // The parked subscription is never acknowledged past what was delivered.
    expect(server.subscription('sub-1')?.acked).toBe(1);
    expect(server.openedConnections).toBe(1);
  });
});
