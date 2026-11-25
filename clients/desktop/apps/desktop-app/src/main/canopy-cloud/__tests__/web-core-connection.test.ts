import type {
  CanopyCallerDescriptor,
  CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CLOUD_SESSION_WAKE_HEADER } from '@canopy/protocol/cloud-session';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type { RelayBindingConnection } from '../../canopy-runtime/renderer-relay/definitions';
import { withCloudChatSendHookProvider } from '../cloud-chat-send-hook';
import {
  WEB_CORE_CONNECTIONS_PATH,
  createWebCoreBindingProvider,
  type WebCoreBindingOptions,
} from '../web-core-connection';

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-renderer:main',
  clientInstanceId: 'renderer-relay:test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

interface Call {
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

interface Push {
  readonly id: number;
  readonly message: CanopyJsonRpcMessage;
}

const push = (id: number): Push => ({
  id,
  message: { jsonrpc: '2.0', method: 'core.events.push', params: { n: id } },
});

const encoder = new TextEncoder();
const frame = (entry: Push): Uint8Array =>
  encoder.encode(`id: ${entry.id}\ndata: ${JSON.stringify(entry.message)}\n\n`);

/** The URL a fetch was called with; the binding always passes a URL. */
const urlOf = (input: URL | RequestInfo): URL =>
  input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);

const BASE_URL = 'https://cloud.example.com';
const KEY_A = 'csk_account_a';

/**
 * A stub web core reached with the desktop key. Its open returns a connection
 * token; its events route replays every push after `Last-Event-ID`, and the
 * first stream drops after `dropAfter` pushes. `initializeAs` is the
 * principal its `core.runtime.initialize` answer names.
 */
class StubWebCore {
  readonly calls: Call[] = [];
  readonly eventHeaders: Record<string, string>[] = [];
  pushes: Push[] = [];
  dropAfter: number | null = null;
  initializeAs: string | null = 'account-a';
  issueToken = true;
  /** The request methods a gateway answers 503, as during a blip. */
  failing: (method: unknown) => boolean = () => false;
  private nextConnection = 0;
  private readonly wakers: (() => void)[] = [];

  /** A push a live events stream delivers after it opened. */
  addPush(entry: Push): void {
    this.pushes.push(entry);
    this.wakers.splice(0).forEach((wake) => wake());
  }

  readonly fetch = (
    input: URL | RequestInfo,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = urlOf(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : null;
    this.calls.push({ path: url.pathname, method, headers, body });
    if (url.pathname === WEB_CORE_CONNECTIONS_PATH && method === 'POST') {
      this.nextConnection += 1;
      return Promise.resolve(
        Response.json(
          {
            connectionId: `connection-${this.nextConnection}`,
            ...(this.issueToken
              ? { connectionToken: `cwc_token_${this.nextConnection}` }
              : {}),
          },
          { status: 201 },
        ),
      );
    }
    if (method === 'DELETE')
      return Promise.resolve(new Response(null, { status: 204 }));
    if (url.pathname.endsWith('/events'))
      return Promise.resolve(this.events(headers, init.signal));
    const message: unknown = JSON.parse(body ?? 'null');
    const id: unknown =
      typeof message === 'object' && message !== null
        ? Reflect.get(message, 'id')
        : null;
    const method_: unknown =
      typeof message === 'object' && message !== null
        ? Reflect.get(message, 'method')
        : null;
    if (this.failing(method_))
      return Promise.resolve(
        new Response('upstream connect error', { status: 503 }),
      );
    if (method_ === 'core.runtime.initialize')
      return Promise.resolve(
        Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            authentication: {
              required: true,
              methods: [{ kind: 'desktop-key' }],
              ...(this.initializeAs === null
                ? {}
                : {
                    principal: { userId: this.initializeAs, brandId: 'canopy' },
                  }),
            },
          },
        }),
      );
    return Promise.resolve(
      Response.json({ jsonrpc: '2.0', id, result: { ok: true } }),
    );
  };

  private events(
    headers: Record<string, string>,
    signal: AbortSignal | null | undefined,
  ): Response {
    this.eventHeaders.push(headers);
    const after = Number(headers['last-event-id'] ?? '0');
    const replay = this.pushes.filter((entry) => entry.id > after);
    const drop = this.dropAfter;
    this.dropAfter = null;
    // A live stream also sends what arrives after it opened.
    const sent = drop === null ? null : replay.slice(0, drop);
    let next = 0;
    // Pull-driven, so the drop lands after the client read what was sent.
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        signal?.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            // Already errored.
          }
        });
      },
      pull: async (controller): Promise<void> => {
        for (;;) {
          const entry = (sent ??
            this.pushes.filter((later) => later.id > after))[next];
          if (entry !== undefined) {
            next += 1;
            return controller.enqueue(frame(entry));
          }
          if (drop !== null)
            return controller.error(new Error('stream dropped'));
          // A live stream stays open until it has more to say.
          await new Promise<void>((resolve) => this.wakers.push(resolve));
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
}

type AccountListener = Parameters<WebCoreBindingOptions['onAccountChange']>[0];

function binding(
  server: StubWebCore,
  overrides: Partial<WebCoreBindingOptions> = {},
): WebCoreBindingOptions & { readonly change: AccountListener } {
  const listeners = new Set<AccountListener>();
  return {
    isEnabled: () => true,
    readCredentials: () =>
      Promise.resolve({
        baseUrl: BASE_URL,
        apiKey: KEY_A,
        accountId: 'account-a',
      }),
    onAccountChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fetch: server.fetch,
    change: (current) => listeners.forEach((listener) => listener(current)),
    ...overrides,
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}

function open(
  provider: ReturnType<typeof createWebCoreBindingProvider>,
  signal = new AbortController().signal,
): Promise<RelayBindingConnection> {
  return provider({ caller: CALLER, webContentsId: 1, signal });
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const opened: CanopyFramedConnection[] = [];
afterEach(() => {
  opened.splice(0).forEach((connection) => connection.close());
  jest.restoreAllMocks();
});

const initialize = (id: number): CanopyJsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'core.runtime.initialize',
  params: {
    client: {
      name: 'test',
      version: '1',
      protocolVersions: [1],
      capabilities: [],
    },
  },
});

describe('web core connection with the desktop key (CAN-4185, CAN-5989)', () => {
  it('opens with the desktop key, then sends only the connection token; nothing from the renderer becomes a header', async () => {
    const globalFetch = jest.spyOn(globalThis, 'fetch');
    const server = new StubWebCore();
    const connection = await open(
      createWebCoreBindingProvider(binding(server)),
    );
    opened.push(connection);
    await connection.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'core.chat.list',
      params: {
        authorization: 'Bearer csk_renderer',
        headers: { cookie: 'session=renderer', authorization: 'Bearer csk_x' },
      },
    });
    await expect(connection.receive()).resolves.toMatchObject({ id: 1 });
    await eventually(() => server.eventHeaders.length > 0);

    expect(globalFetch).not.toHaveBeenCalled();
    const [openCall, ...later] = server.calls;
    expect(openCall).toMatchObject({
      path: WEB_CORE_CONNECTIONS_PATH,
      method: 'POST',
    });
    expect(openCall?.headers.authorization).toBe(`Bearer ${KEY_A}`);
    expect(later.length).toBeGreaterThanOrEqual(2);
    for (const call of later) {
      expect(call.headers.authorization).toBe('Bearer cwc_token_1');
      expect(call.headers.cookie).toBeUndefined();
      for (const name of Object.keys(call.headers))
        expect([
          'authorization',
          'origin',
          'content-type',
          'accept',
          'last-event-id',
        ]).toContain(name);
    }
    // The renderer's would-be credentials stay in the params, never headers.
    expect(JSON.stringify(later.map((call) => call.headers))).not.toMatch(
      /csk_|cookie/i,
    );
  });

  it('refuses an open the web core answers without a connection token', async () => {
    const server = new StubWebCore();
    server.issueToken = false;
    const error = await rejection(
      open(createWebCoreBindingProvider(binding(server))),
    );
    expect(error).toMatchObject({ payload: { kind: 'unauthenticated' } });
  });

  it('sign-out, an account switch or a new key ends the connection, and the next open uses the new key', async () => {
    const server = new StubWebCore();
    let credentials = {
      baseUrl: BASE_URL,
      apiKey: KEY_A,
      accountId: 'account-a',
    };
    const options = binding(server, {
      readCredentials: () => Promise.resolve(credentials),
    });
    const provider = createWebCoreBindingProvider(options);

    // A refresh that confirms the same key and account changes nothing.
    const kept = await open(provider);
    opened.push(kept);
    options.change({ apiKey: KEY_A, accountId: 'account-a' });
    expect(kept.signal.aborted).toBe(false);

    for (const next of [
      null,
      { apiKey: 'csk_account_b', accountId: 'account-b' },
      { apiKey: 'csk_rotated', accountId: 'account-a' },
    ]) {
      const before = await open(provider);
      opened.push(before);
      options.change(next);
      expect(before.signal.aborted).toBe(true);
    }

    credentials = {
      baseUrl: BASE_URL,
      apiKey: 'csk_account_b',
      accountId: 'account-b',
    };
    server.initializeAs = 'account-b';
    const after = await open(provider);
    opened.push(after);
    const lastOpen = server.calls
      .filter(
        (call) =>
          call.method === 'POST' && call.path === WEB_CORE_CONNECTIONS_PATH,
      )
      .at(-1);
    expect(lastOpen?.headers.authorization).toBe('Bearer csk_account_b');
  });

  it('an account change while the open is in flight ends the open', async () => {
    const server = new StubWebCore();
    let release: () => void = () => undefined;
    const options = binding(server, {
      // Holds the open until released, and fails it if it is aborted first.
      fetch: (input, init = {}) =>
        new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          release = (): void => void server.fetch(input, init).then(resolve);
        }),
    });
    const pending = rejection(open(createWebCoreBindingProvider(options)));
    await eventually(() => server.calls.length === 0);
    options.change({ apiKey: 'csk_account_b', accountId: 'account-b' });
    release();
    await expect(pending).resolves.toMatchObject({
      payload: { kind: 'unauthenticated' },
    });
  });

  it('an account change before the credentials are read leaves them suspect', async () => {
    const server = new StubWebCore();
    let resolveRead: () => void = () => undefined;
    const options = binding(server, {
      readCredentials: () =>
        new Promise((resolve) => {
          resolveRead = (): void =>
            resolve({
              baseUrl: BASE_URL,
              apiKey: KEY_A,
              accountId: 'account-a',
            });
        }),
    });
    const pending = rejection(open(createWebCoreBindingProvider(options)));
    options.change(null);
    resolveRead();
    await expect(pending).resolves.toMatchObject({
      payload: { kind: 'unauthenticated' },
    });
    expect(server.calls).toHaveLength(0);
  });

  it('an open whose body fails to arrive stays retryable', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        controller.error(new Error('connection reset'));
      },
    });
    const error = await rejection(
      open(
        createWebCoreBindingProvider(
          binding(new StubWebCore(), {
            fetch: () =>
              Promise.resolve(
                new Response(body, {
                  status: 201,
                  headers: { 'content-type': 'application/json' },
                }),
              ),
          }),
        ),
      ),
    );
    expect(error).toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
  });

  it('closes the connection when initialize names another account or none', async () => {
    for (const named of ['account-b', null]) {
      const server = new StubWebCore();
      server.initializeAs = named;
      const connection = await open(
        createWebCoreBindingProvider(binding(server)),
      );
      opened.push(connection);
      await connection.send(initialize(1));
      await expect(connection.receive()).rejects.toMatchObject({
        payload: { kind: 'unauthenticated' },
      });
      expect(connection.signal.aborted).toBe(true);
    }
    // The signed-in account's own answer passes through.
    const server = new StubWebCore();
    const connection = await open(
      createWebCoreBindingProvider(binding(server)),
    );
    opened.push(connection);
    await connection.send(initialize(2));
    await expect(connection.receive()).resolves.toMatchObject({ id: 2 });
    expect(connection.signal.aborted).toBe(false);
  });

  it('signed out refuses before any network call', async () => {
    const server = new StubWebCore();
    const error = await rejection(
      open(
        createWebCoreBindingProvider(
          binding(server, {
            readCredentials: () => Promise.reject(new Error('signed out')),
          }),
        ),
      ),
    );
    expect(error).toMatchObject({ payload: { kind: 'unauthenticated' } });
    expect(server.calls).toHaveLength(0);
  });

  it('a raw network failure stays retryable', async () => {
    const error = await rejection(
      open(
        createWebCoreBindingProvider(
          binding(new StubWebCore(), {
            fetch: () =>
              Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')),
          }),
        ),
      ),
    );
    expect(error).toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
  });

  it('flag off refuses before any network call', async () => {
    const server = new StubWebCore();
    const readCredentials = jest.fn(() =>
      Promise.resolve({
        baseUrl: BASE_URL,
        apiKey: KEY_A,
        accountId: 'account-a',
      }),
    );
    const error = await rejection(
      open(
        createWebCoreBindingProvider(
          binding(server, { isEnabled: () => false, readCredentials }),
        ),
      ),
    );
    expect(error).toMatchObject({
      payload: { kind: 'capability_unavailable', retry: { kind: 'never' } },
    });
    expect(readCredentials).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
  });

  it('a POST sends the cloud Origin', async () => {
    const server = new StubWebCore();
    const connection = await open(
      createWebCoreBindingProvider(binding(server)),
    );
    opened.push(connection);
    await connection.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'core.workspace.list',
      params: {},
    });
    await connection.receive();
    const posts = server.calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => call.path)).toEqual([
      WEB_CORE_CONNECTIONS_PATH,
      `${WEB_CORE_CONNECTIONS_PATH}/connection-1`,
    ]);
    for (const call of posts) expect(call.headers.origin).toBe(BASE_URL);
  });

  it('keeps the connection and its push stream when background cleanup keeps failing 503 through both relay wrappers, while five failed app requests in a row still end it (CAN-6558)', async () => {
    const server = new StubWebCore();
    server.failing = (method): boolean => method === 'core.events.unsubscribe';
    const unused = (): Promise<never> =>
      Promise.reject(new Error('No cloud chat send here.'));
    // The relay's own composition: the send hook over the desktop binding.
    const provider = withCloudChatSendHookProvider(
      createWebCoreBindingProvider(binding(server)),
      {
        accountId: () => Promise.resolve('account-a'),
        hasKeepInStepSkills: () => Promise.resolve(false),
        selectedItemIds: unused,
        keepInStep: unused,
        recordNotices: () => undefined,
        pruneNotices: () => undefined,
      },
    );
    const connection = await open(provider);
    opened.push(connection);
    // A rollover's burst of cleanup unsubscribes, each failing alone.
    for (let id = 1; id <= 6; id += 1)
      await connection.send(
        {
          jsonrpc: '2.0',
          id,
          method: 'core.events.unsubscribe',
          params: { subscriptionId: `ended-${String(id)}` },
        },
        { background: true },
      );
    for (let id = 1; id <= 6; id += 1)
      expect(Object.keys(await connection.receive())).toEqual(
        expect.arrayContaining(['id', 'error']),
      );
    expect(connection.signal.aborted).toBe(false);
    // The push stream still delivers.
    server.addPush(push(1));
    await expect(connection.receive()).resolves.toEqual(push(1).message);

    // The app's own requests still count: the fifth 503 in a row ends it.
    server.failing = (): boolean => true;
    for (let id = 11; id <= 15; id += 1)
      await connection.send({
        jsonrpc: '2.0',
        id,
        method: 'core.workspace.list',
        params: {},
      });
    await eventually(() => connection.signal.aborted);
  });

  it('a dropped events stream reopens with Last-Event-ID and delivers no push twice', async () => {
    const server = new StubWebCore();
    server.pushes = [push(1), push(2), push(3)];
    server.dropAfter = 2;
    const connection = await open(
      createWebCoreBindingProvider(binding(server)),
    );
    opened.push(connection);

    const delivered: CanopyJsonRpcMessage[] = [];
    for (let index = 0; index < 3; index += 1)
      delivered.push(await connection.receive());

    expect(delivered).toEqual(
      [push(1), push(2), push(3)].map((p) => p.message),
    );
    expect(server.eventHeaders).toHaveLength(2);
    expect(server.eventHeaders[0]?.['last-event-id']).toBeUndefined();
    expect(server.eventHeaders[1]?.['last-event-id']).toBe('2');
  });
});

describe("the wake proof is set in one place on desktop: main's Files wake (CAN-6724)", () => {
  const DESKTOP_SRC = join(__dirname, '..', '..', '..');

  function sourcesNaming(pattern: RegExp): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules')
            walk(full);
        } else if (
          /\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) &&
          pattern.test(readFileSync(full, 'utf8'))
        )
          found.push(relative(DESKTOP_SRC, full).split(sep).join('/'));
      }
    };
    walk(DESKTOP_SRC);
    return found.sort();
  }

  it('only the web core connection names the wake header, and only the Files wake opens the connection that sends it', () => {
    expect(sourcesNaming(/CLOUD_SESSION_WAKE_HEADER|x-canopy-wake/i)).toEqual([
      'main/canopy-cloud/web-core-connection.ts',
    ]);
    expect(sourcesNaming(/connectWebCoreForFilesWake/)).toEqual([
      'main/canopy-cloud/cloud-files-wake.ts',
      'main/canopy-cloud/web-core-connection.ts',
    ]);
  });

  it("the relay's binding never sends the wake header, even for a waking listing", async () => {
    const server = new StubWebCore();
    const connection = await open(
      createWebCoreBindingProvider(binding(server)),
    );
    opened.push(connection);
    await connection.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'worker.filesystem.directory.list',
      params: {
        scope: { chatId: 'chat-1' },
        fileRootId: 'workspace',
        relativePath: '',
        wake: true,
      },
    });
    await expect(connection.receive()).resolves.toMatchObject({ id: 7 });
    expect(
      server.calls.every(
        (call) => call.headers[CLOUD_SESSION_WAKE_HEADER] === undefined,
      ),
    ).toBe(true);
  });
});
