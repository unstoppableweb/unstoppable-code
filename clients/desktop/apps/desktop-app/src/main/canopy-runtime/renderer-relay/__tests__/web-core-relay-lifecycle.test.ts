import {
  encodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import {
  DELEGATION_STOP_REFUSAL,
  FORGED_DELEGATION_STOP,
  MISSING_DELEGATION_STOP,
} from '@canopy/protocol/canopy-core/core/managedDelegation/testing';
import { CLOUD_SESSION_WAKE_HEADER } from '@canopy/protocol/cloud-session';
import {
  WEB_CORE_CONNECTIONS_PATH,
  createWebCoreBindingProvider,
  type WebCoreBindingOptions,
} from '../../../canopy-cloud/web-core-connection';
import { createWebCoreFilesWaker } from '../../../canopy-cloud/cloud-files-wake';

/** What the stub reads from a request the binding sends. */
interface StubRequest {
  readonly method?: string;
  readonly headers?: HeadersInit;
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
  constructor(
    private readonly servesUnsubscribe = true,
    /** The minor revisions its manifest advertises (protocol rule 5). */
    private readonly schemaRevisions: Readonly<Record<string, number>> = {},
  ) {}

  /** The params of each chat transcript page read and event stream open. */
  readonly chatReads: { method: string; params: object }[] = [];

  /** The params of each `core.catalog.snapshot.get` the web core received. */
  readonly snapshotReads: unknown[] = [];
  /** The params of each `core.archive.container.list` it received. */
  readonly archiveLists: unknown[] = [];

  readonly connections = new Map<string, StubConnection>();
  readonly methods: string[] = [];
  /** The params of each `worker.filesystem.file.read` the web core received. */
  readonly fileReads: unknown[] = [];
  /** Each JSON-RPC request's method and its wake proof header, if any. */
  readonly proofs: { method: string; proof: string | null }[] = [];
  /** The params of each `worker.filesystem.directory.list` it received. */
  readonly directoryLists: unknown[] = [];
  /** The params of each `core.managedDelegation.stop` it received. */
  readonly delegationStops: unknown[] = [];
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
    this.proofs.push({
      method: String(
        typeof request === 'object' && request !== null
          ? Reflect.get(request, 'method')
          : '',
      ),
      proof: new Headers(init.headers).get(CLOUD_SESSION_WAKE_HEADER),
    });
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
              'worker.filesystem.roots.list',
              'worker.filesystem.directory.list',
              'core.client.lease.acquire',
              'core.client.lease.renew',
              'core.client.lease.release',
              'core.events.ack',
              'core.chat.transcript.page',
              ...(this.servesUnsubscribe ? ['core.events.unsubscribe'] : []),
              'core.catalog.snapshot.get',
              'core.archive.container.list',
              'core.managedDelegation.stop',
            ],
            events: [],
            streams: ['core.chat.task.events', 'core.chat.events'],
            schemaRevisions: this.schemaRevisions,
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
      case 'core.catalog.snapshot.get':
        this.snapshotReads.push(params);
        return result({
          revision: 0,
          entries: [],
          generatedAt: '2026-11-13T00:00:00.000Z',
        });
      case 'worker.filesystem.file.read':
        this.fileReads.push(params);
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
      case 'core.managedDelegation.stop':
        // As the web core answers a delegate outside the asking chat's tree,
        // and one that doesn't exist (CAN-7245).
        this.delegationStops.push(params);
        return {
          jsonrpc: '2.0',
          id,
          error: encodeCanopyError(DELEGATION_STOP_REFUSAL),
        };
      case 'core.archive.container.list':
        this.archiveLists.push(params);
        return result({ workspaceId: null, containers: [] });
      case 'core.chat.transcript.page':
        this.chatReads.push({ method, params });
        return result({
          messages: [],
          totalMessages: 0,
          transcriptRevision: 0,
        });
      case 'core.chat.events':
        this.chatReads.push({ method, params });
        this.subscriptionCount += 1;
        connection.subscriptions.set(`sub-${this.subscriptionCount}`, {
          sent: 0,
          acked: 0,
          queued: 0,
        });
        return result({
          subscriptionId: `sub-${this.subscriptionCount}`,
          acceptedCursor: null,
        });
      case 'worker.filesystem.roots.list':
        return result({
          roots: [
            {
              fileRootId: 'workspace',
              name: 'Workspace',
              kind: 'workspace-root',
            },
          ],
        });
      case 'worker.filesystem.directory.list':
        this.directoryLists.push(params);
        return result({ entries: [] });
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

function mainWindowEvent(senderId = 1): RendererRelayEvent {
  const frame = {
    url: 'app://canopy/index.html',
    detached: false,
    isDestroyed: (): boolean => false,
  };
  return {
    sender: {
      id: senderId,
      mainFrame: frame,
      getURL: () => frame.url,
      isDestroyed: () => false,
      on: () => undefined,
      removeListener: () => undefined,
    },
    senderFrame: frame,
  };
}

function stubBinding(server: StubWebCore): WebCoreBindingOptions {
  return {
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
  };
}

function webCoreRelay(
  server: StubWebCore,
  surface: 'main' | 'app-advisor' = 'main',
): RendererRelay {
  return createWebCoreRendererRelay({
    bindingProvider: createWebCoreBindingProvider(stubBinding(server)),
    resolveSurface: () => ({ surface, caller: CALLER }),
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

  it.each([
    [4, 4],
    [3, 2],
    [null, 2],
  ] as const)(
    'raises the catalog read to revision 4 only for a web core advertising %p, so its plugins carry this desktop’s uploads (CAN-6725)',
    async (advertised, sent) => {
      const server = new StubWebCore(
        true,
        advertised === null ? {} : { 'core.catalog.snapshot.get': advertised },
      );
      const relay = webCoreRelay(server);
      relays.push(relay);
      const params = {
        scope: { workspaceId: 'ws-1' },
        kinds: [],
        includeUnavailable: true,
        revision: 2,
      };
      const reply = await relay.invoke(mainWindowEvent(), {
        kind: 'request',
        method: 'core.catalog.snapshot.get',
        params,
      });
      expect(reply).toMatchObject({ ok: true });
      // An older web core gets the revision the renderer sent, as before.
      expect(server.snapshotReads).toHaveLength(1);
      expect(server.snapshotReads[0]).toMatchObject({
        ...params,
        revision: sent,
      });
    },
  );

  it("describes its session's account as the web core's initialize named it, and the revisions it advertises for what the renderer may call, and nothing else (CAN-6828)", async () => {
    // initialize also names the brand, and the web core advertises a
    // revision for a method only main may call: neither reaches the renderer.
    const server = new StubWebCore(true, {
      'core.chat.message.send': 3,
      'core.chat.transcript.page': 2,
      'core.runtime.initialize': 3,
    });
    const relay = webCoreRelay(server);
    relays.push(relay);
    await expect(
      relay.invoke(mainWindowEvent(), { kind: 'describe' }),
    ).resolves.toEqual({
      ok: true,
      value: {
        principalId: 'account-1',
        schemaRevisions: {
          'core.chat.message.send': 3,
          'core.chat.transcript.page': 2,
        },
      },
    });
  });

  it("describes the revision the web core advertises for a stream the renderer may open, so it knows whether a chat's events carry sandbox.changed (CAN-6841)", async () => {
    for (const advertised of [2, 3]) {
      const relay = webCoreRelay(
        new StubWebCore(true, { 'core.chat.events': advertised }),
      );
      relays.push(relay);
      await expect(
        relay.invoke(mainWindowEvent(), { kind: 'describe' }),
      ).resolves.toEqual({
        ok: true,
        value: {
          principalId: 'account-1',
          schemaRevisions: { 'core.chat.events': advertised },
        },
      });
    }
  });

  it('main asks for archive list revision 2 only where the web core advertises it (CAN-6792)', async () => {
    const list = async (server: StubWebCore): Promise<void> => {
      const relay = webCoreRelay(server);
      relays.push(relay);
      await expect(
        relay.invoke(mainWindowEvent(), {
          kind: 'request',
          method: 'core.archive.container.list',
          params: { workspaceId: '00000000-0000-4000-8000-000000000001' },
        }),
      ).resolves.toMatchObject({ ok: true });
    };
    const older = new StubWebCore();
    await list(older);
    expect(older.archiveLists).toEqual([
      expect.objectContaining({
        workspaceId: '00000000-0000-4000-8000-000000000001',
      }),
    ]);
    expect(older.archiveLists[0]).not.toHaveProperty('revision');
    const current = new StubWebCore(true, { 'core.archive.container.list': 2 });
    await list(current);
    expect(current.archiveLists).toEqual([
      expect.objectContaining({
        workspaceId: '00000000-0000-4000-8000-000000000001',
        revision: 2,
      }),
    ]);
  });

  it('sends a catalog read the renderer sends with no revision as it is, even to a web core advertising revision 4, while a transcript page read with none is raised (CAN-6725, CAN-6755)', async () => {
    const server = new StubWebCore(true, {
      'core.catalog.snapshot.get': 4,
      'core.chat.transcript.page': 2,
    });
    const relay = webCoreRelay(server);
    relays.push(relay);
    const event = mainWindowEvent();
    const params = {
      scope: { workspaceId: 'ws-1' },
      kinds: [],
      includeUnavailable: true,
    };
    await expect(
      relay.invoke(event, {
        kind: 'request',
        method: 'core.catalog.snapshot.get',
        params,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      relay.invoke(event, {
        kind: 'request',
        method: 'core.chat.transcript.page',
        params: {
          scope: {
            workspaceId: 'workspace-1',
            worktreeId: 'task-1',
            chatId: 'chat-1',
          },
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(server.snapshotReads).toHaveLength(1);
    expect(server.snapshotReads[0]).toMatchObject(params);
    expect(server.snapshotReads[0]).not.toHaveProperty('revision');
    expect(
      server.chatReads.map(({ params }): unknown =>
        Reflect.get(params, 'revision'),
      ),
    ).toEqual([2]);
  });

  it("sends a renderer-forged delegate stop for another of the user's chats to the web core as it is, and hands the renderer the web core's refusal, the same as for a delegate that doesn't exist (CAN-7245, end to end, desktop half)", async () => {
    const server = new StubWebCore();
    const relay = webCoreRelay(server);
    relays.push(relay);
    const event = mainWindowEvent();
    const forged = await relay.invoke(event, {
      kind: 'request',
      method: FORGED_DELEGATION_STOP.method,
      params: FORGED_DELEGATION_STOP.params,
    });
    const missing = await relay.invoke(event, {
      kind: 'request',
      method: MISSING_DELEGATION_STOP.method,
      params: MISSING_DELEGATION_STOP.params,
    });
    // The relay can't tell which chat the window shows: the request reaches
    // the web core unchanged, its key included.
    const { _meta: forgedMeta, ...forgedParams } =
      FORGED_DELEGATION_STOP.params;
    expect(server.delegationStops).toHaveLength(2);
    const sent: unknown = server.delegationStops[0];
    if (typeof sent !== 'object' || sent === null)
      throw new Error('No stop reached the web core.');
    expect(sent).toMatchObject(forgedParams);
    expect(Object.keys(sent).sort()).toEqual(
      [...Object.keys(forgedParams), '_meta'].sort(),
    );
    expect(Reflect.get(sent, '_meta')).toMatchObject(forgedMeta);
    // The renderer gets the web core's refusal whole, and nothing tells the
    // forged stop from a stop of a delegate that doesn't exist.
    expect(forged).toEqual({ ok: false, error: DELEGATION_STOP_REFUSAL });
    expect(forged).toEqual(missing);
  });

  it('a renderer wake never reaches the web core: main has no wake proof, so the read stays non-waking (CAN-6114)', async () => {
    const server = new StubWebCore();
    const relay = webCoreRelay(server);
    relays.push(relay);
    const read = {
      scope: { chatId: 'chat-1' },
      fileRootId: 'workspace',
      relativePath: 'image.png',
      maxBytes: 1024,
    };
    await expect(
      relay.invoke(mainWindowEvent(), {
        kind: 'request',
        method: 'worker.filesystem.file.read',
        params: { ...read, wake: true },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(server.fileReads).toEqual([expect.objectContaining(read)]);
    expect(server.fileReads[0]).not.toHaveProperty('wake');
  });

  it("reads a cloud chat's transcript pages at revision 2 and events at revision 3 where the web core advertises them, and at revision 1 where it does not (CAN-6755)", async () => {
    for (const advertised of [true, false]) {
      // Revision 2 carries each answer's meter (CAN-6509); events revision 3
      // keeps it and adds the sandbox's state (CAN-6766).
      const server = new StubWebCore(
        true,
        advertised
          ? { 'core.chat.transcript.page': 2, 'core.chat.events': 3 }
          : {},
      );
      const relay = webCoreRelay(server);
      relays.push(relay);
      const event = mainWindowEvent();
      await expect(
        relay.invoke(event, {
          kind: 'request',
          method: 'core.chat.transcript.page',
          params: {
            scope: {
              workspaceId: 'workspace-1',
              worktreeId: 'task-1',
              chatId: 'chat-1',
            },
          },
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        relay.invoke(event, {
          kind: 'openStream',
          method: 'core.chat.events',
          params: {
            scope: { projectId: 'workspace-1', worktreeId: 'task-1' },
            cursor: null,
          },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(
        server.chatReads.map(({ method, params }): [string, unknown] => [
          method,
          Reflect.get(params, 'revision'),
        ]),
      ).toEqual([
        ['core.chat.transcript.page', advertised ? 2 : undefined],
        ['core.chat.events', advertised ? 3 : undefined],
      ]);
    }
  });

  it.each([
    [4, 3],
    [3, 3],
    [2, 2],
    [1, undefined],
  ] as const)(
    "opens a cloud chat's events at the highest revision both sides support: advertised %p, asked %p (CAN-6841)",
    async (advertised, asked) => {
      // Main reads events revisions 2 (meters) and 3 (sandbox state).
      const server = new StubWebCore(true, { 'core.chat.events': advertised });
      const relay = webCoreRelay(server);
      relays.push(relay);
      await expect(
        relay.invoke(mainWindowEvent(), {
          kind: 'openStream',
          method: 'core.chat.events',
          params: {
            scope: { projectId: 'workspace-1', worktreeId: 'task-1' },
            cursor: null,
          },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(
        server.chatReads.map(({ params }): unknown =>
          Reflect.get(params, 'revision'),
        ),
      ).toEqual([asked]);
    },
  );

  it("a renderer's waking listing reaches the web core with no wake and no wake proof (CAN-6724)", async () => {
    const server = new StubWebCore();
    const relay = webCoreRelay(server);
    relays.push(relay);
    const list = {
      scope: { chatId: 'chat-1' },
      fileRootId: 'workspace',
      relativePath: '',
    };
    // A param named like the header stays a param, whatever becomes of it.
    await relay.invoke(mainWindowEvent(), {
      kind: 'request',
      method: 'worker.filesystem.directory.list',
      params: { ...list, wake: true, [CLOUD_SESSION_WAKE_HEADER]: '1' },
    });
    await expect(
      relay.invoke(mainWindowEvent(), {
        kind: 'request',
        method: 'worker.filesystem.directory.list',
        params: { ...list, wake: true },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(server.directoryLists).toContainEqual(expect.objectContaining(list));
    expect(
      server.directoryLists.every(
        (params) =>
          typeof params === 'object' && params !== null && !('wake' in params),
      ),
    ).toBe(true);
    expect(server.proofs.length).toBeGreaterThan(0);
    expect(server.proofs.every((each) => each.proof === null)).toBe(true);
  });

  it("main's Files wake sends the wake proof on its one waking listing only, on a connection of its own (CAN-6724)", async () => {
    const server = new StubWebCore();
    const relay = webCoreRelay(server);
    relays.push(relay);
    await relay.invoke(mainWindowEvent(), {
      kind: 'request',
      method: 'core.workspace.list',
      params: {},
    });

    await createWebCoreFilesWaker(stubBinding(server), '1.0.0')('chat-1');

    expect(server.directoryLists).toEqual([
      {
        scope: { chatId: 'chat-1' },
        fileRootId: 'workspace',
        relativePath: '',
        wake: true,
      },
    ]);
    const proved = server.proofs.filter((each) => each.proof !== null);
    expect(proved).toEqual([
      { method: 'worker.filesystem.directory.list', proof: '1' },
    ]);
    // The relay's calls, before and after, carry none.
    await relay.invoke(mainWindowEvent(), {
      kind: 'request',
      method: 'core.workspace.list',
      params: {},
    });
    expect(server.proofs.filter((each) => each.proof !== null)).toHaveLength(1);
  });

  it("follows answers only for the asking main window's open chat streams (CAN-6724)", async () => {
    const server = new StubWebCore();
    const relay = webCoreRelay(server);
    relays.push(relay);
    const event = mainWindowEvent();
    const chat =
      (id: string) =>
      (params: Readonly<Record<string, unknown>>): boolean =>
        typeof params.scope === 'object' &&
        params.scope !== null &&
        Reflect.get(params.scope, 'worktreeId') === id;
    expect(relay.follows(event, 'core.chat.events', chat('chat-1'))).toBe(
      false,
    );
    const reply = await relay.invoke(event, {
      kind: 'openStream',
      method: 'core.chat.events',
      params: {
        scope: { projectId: 'ws-1', worktreeId: 'chat-1' },
        cursor: null,
      },
    });
    if (!reply.ok) throw new Error(reply.error.message);
    const subscriptionId = String(
      Reflect.get(Object(reply.value), 'subscriptionId'),
    );
    expect(relay.follows(event, 'core.chat.events', chat('chat-1'))).toBe(true);
    expect(relay.follows(event, 'core.chat.events', chat('chat-2'))).toBe(
      false,
    );
    expect(relay.follows(event, 'core.chat.task.events', chat('chat-1'))).toBe(
      false,
    );
    // Another window follows nothing it didn't open.
    expect(
      relay.follows(mainWindowEvent(2), 'core.chat.events', chat('chat-1')),
    ).toBe(false);
    await relay.invoke(event, { kind: 'closeStream', subscriptionId });
    expect(relay.follows(event, 'core.chat.events', chat('chat-1'))).toBe(
      false,
    );
    // App Advisor's surface follows nothing.
    const advisor = webCoreRelay(server, 'app-advisor');
    relays.push(advisor);
    expect(advisor.follows(event, 'core.chat.events', chat('chat-1'))).toBe(
      false,
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

  it('closing one stream on a web core whose manifest lacks unsubscribe still sends it, drops late items and leaves a second stream delivering (CAN-6194)', async () => {
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
    // Sent anyway; this older core answers method-not-found, which is ignored.
    await waitFor(() => server.methods.includes('core.events.unsubscribe'));
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
    // Late items for the closed stream are dropped, never acknowledged.
    expect(server.subscription('sub-1')?.acked).toBe(1);
    expect(
      server.methods.filter((method) => method === 'core.events.unsubscribe'),
    ).toHaveLength(1);
    expect(server.openedConnections).toBe(1);
  });
});
