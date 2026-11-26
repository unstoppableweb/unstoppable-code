/**
 * CAN-7679: the host's tunnel dialer, which lets a paired desktop computer
 * open this computer's local web servers over Remote Control. Here it is
 * plugged straight into a real host session's `tunnelOpen`; production
 * offers it only with consent and the flag (CAN-7705). The real dialer,
 * destination policy, deny registry and listener-owner check serve a
 * controller driving streams through the in-memory relay to real HTTP and
 * WebSocket servers in another process, as a developer's dev server is.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { request, type IncomingHttpHeaders } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdtempSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as PathsModule from '../../lib/paths';
import { WebSocket } from 'ws';

/** The suite's private directories, created on first use, removed after. */
const tempDirs: { records?: string; uploads?: string } = {};

/** Where the account proxy keeps its process records in this test. */
function proxyRecordDir(): string {
  tempDirs.records ??= mkdtempSync(join(tmpdir(), 'can-7679-proxy-records-'));
  return tempDirs.records;
}

/** Run around file system calls, as another writer or a slow disk might. */
const mockAfterReaddir: { hook?: (path: unknown) => Promise<void> } = {};
const mockBeforeReadFile: { hook?: (path: unknown) => Promise<void> } = {};

/** The error reading a file this user may not read fails with. */
function accessDenied(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
    code: 'EACCES',
    errno: -13,
    syscall: 'open',
    path,
  });
}

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return {
    ...actual,
    readdir: async (
      ...args: Parameters<typeof actual.readdir>
    ): Promise<unknown> => {
      const names = await actual.readdir(...args);
      await mockAfterReaddir.hook?.(args[0]);
      return names;
    },
    readFile: async (
      ...args: Parameters<typeof actual.readFile>
    ): Promise<unknown> => {
      await mockBeforeReadFile.hook?.(args[0]);
      return actual.readFile(...args);
    },
  };
});

jest.mock('../../lib/paths', () => {
  const actual = jest.requireActual<typeof PathsModule>('../../lib/paths');
  return { ...actual, getAccountProxyLocalDir: proxyRecordDir };
});

jest.mock('../../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: () => void } => ({
    recordAppDiagnostic: (): void => undefined,
  }),
}));

import {
  recordedLocalAccountProxyPids,
  recordedLocalAccountProxyPorts,
  resetLocalAccountProxyForTests,
  setLocalAccountProxyDepsForTests,
} from '../../account-proxy/local-runtime';
import {
  loopbackListenerOwner,
  registerCanopyPorts,
  registerCanopyProcesses,
  reserveLoopbackPort,
  resetLoopbackListenerOwnersForTests,
  runSystemTool,
} from '../../lib/loopback-listeners';
import { RemoteAccountProxySignIns } from '../client/account-proxy-sign-in';
import type { HostBridge } from '../host/bridge-window';
import { RemoteHostSession } from '../host/host-session';
import {
  TunnelBudget,
  TunnelDialer,
  type TunnelDialerDeps,
  type TunnelDialerLimits,
} from '../host/tunnel-dialer';
import type { TunnelAddress } from '../host/tunnel-policy';
import { RemoteUploadStore } from '../host/uploads';
import {
  HelloResultSchema,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TRANSPORT_RESUME_VERSION,
  TunnelDataParamsSchema,
  type HelloResult,
  type TunnelDestinationClass,
} from '../remote-protocol';
import { RpcPeer } from '../transport/rpc-peer';
import type { SecureSession } from '../transport/session-manager';
import { TunnelStreamMux } from '../tunnel/stream-mux';
import { TunnelOpenError, type TunnelSocket } from '../tunnel/tunnel-socket';
import {
  ASSET_BYTES,
  NEXT_COOKIES,
  NEXT_PAGE,
  STREAM_GAP_MS,
  STREAM_PARTS,
  V6_PAGE,
  startDevServers,
  type DevServers,
} from './helpers/dev-servers';
import { flushRelay, InMemoryRelayHub } from './in-memory-relay';
import {
  createTestDevice,
  openControlSession,
  type TestDevice,
} from './session-pair';

jest.setTimeout(120_000);

const VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.0.0',
};

/** Every name the dialer asked the resolver for, in order. */
const lookedUp: string[] = [];

/** The real resolver, recording each name it is asked for. */
async function testLookup(name: string): Promise<TunnelAddress[]> {
  lookedUp.push(name);
  return (await lookup(name, { all: true, order: 'verbatim' })).flatMap(
    (entry): TunnelAddress[] =>
      entry.family === 4 || entry.family === 6
        ? [{ address: entry.address, family: entry.family }]
        : [],
  );
}

interface Preview {
  laptop: TestDevice;
  studio: TestDevice;
  host: RemoteHostSession;
  hostSession: SecureSession;
  controller: RpcPeer;
  controllerSession: SecureSession;
  tunnels: TunnelStreamMux;
  hello: HelloResult;
  dialer: TunnelDialer;
  /** Consent and flag together, as the service reads them. */
  allowed: { value: boolean };
  /** Opens that reached the dialer. */
  dialed: { count: number };
  /** `tunnel.data` bytes that reached the controller. */
  received: { bytes: number };
  logs: Array<{ message: string; fields: Record<string, number | string> }>;
}

async function preview(
  options: {
    kind?: DeviceKind;
    allowed?: boolean;
    deps?: Partial<TunnelDialerDeps>;
    limits?: Partial<TunnelDialerLimits>;
    /** Another session of the same paired computer shares it. */
    budget?: TunnelBudget;
    /** Whether the controller is still authorized; true unless changed. */
    authorized?: { value: boolean };
  } = {},
): Promise<Preview> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'Laptop');
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  const { initiator, responder } = await openControlSession(laptop, studio);
  const kind = options.kind ?? 'desktop';
  const allowed = { value: options.allowed ?? true };
  const dialed = { count: 0 };
  const logs: Preview['logs'] = [];
  const authorized = options.authorized ?? { value: true };
  const dialer = new TunnelDialer({
    kind,
    isAuthorized: (): boolean => authorized.value,
    allowed: (): boolean => allowed.value,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
    deps: {
      lookup: testLookup,
      log: (message, fields): void => {
        logs.push({ message, fields });
      },
      ...options.deps,
    },
  });
  const bridge: HostBridge = {
    getChatInterest: (): undefined => undefined,
    window: null,
    invoke: (channel: string): Promise<unknown> =>
      Promise.resolve({ answered: channel }),
    post: (): void => undefined,
    onPush: (): (() => void) => (): void => undefined,
    onClosed: (): (() => void) => (): void => undefined,
    destroy: (): void => undefined,
  };
  const host = new RemoteHostSession({
    session: responder,
    kind,
    attributedDeviceId: responder.peerDeviceId,
    createBridge: (): Promise<HostBridge> => Promise.resolve(bridge),
    mainWindowPushes: { subscribe: (): (() => void) => (): void => undefined },
    uploads: new RemoteUploadStore(
      (tempDirs.uploads ??= mkdtempSync(join(tmpdir(), 'can-7679-uploads-'))),
    ),
    readFile: (): Promise<never> =>
      Promise.reject(new Error('no reads in this test')),
    disposition: (): 'tunnel' => 'tunnel',
    isAuthorized: (): boolean => true,
    version: VERSION,
    hello: (): { name: string; platform: 'linux' } => ({
      name: 'Studio',
      platform: 'linux',
    }),
    onClose: (): void => dialer.close(),
    tunnelOpen: (request, signal): ReturnType<TunnelDialer['open']> => {
      dialed.count += 1;
      return dialer.open(request, signal);
    },
  });
  let tunnels: TunnelStreamMux | null = null;
  const received = { bytes: 0 };
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('unexpected request')),
    onEvent: (name, payload): void => {
      const data = TunnelDataParamsSchema.safeParse(payload);
      if (name === REMOTE_EVENTS.tunnelData && data.success)
        received.bytes += data.data.bytes.byteLength;
      tunnels?.handleEvent(name, payload);
    },
  });
  tunnels = new TunnelStreamMux({
    role: 'controller',
    transport: {
      notify: (name, payload, notifyOptions): boolean =>
        controller.notify(name, payload, notifyOptions),
      request: (method, params, requestOptions): Promise<unknown> =>
        controller.request(method, params, requestOptions),
      heldBytes: (): number => initiator.heldBytes,
      onHeldBytesReleased: (listener): (() => void) =>
        initiator.onHeldBytesReleased(listener),
    },
  });
  const mux = tunnels;
  controller.onClose(() => mux.close());
  const hello = HelloResultSchema.parse(
    await controller.request(REMOTE_METHODS.hello, {
      version: VERSION,
      transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION },
    }),
  );
  initiator.setResumeNegotiated(
    (hello.transport?.resume ?? 0) >= REMOTE_TRANSPORT_RESUME_VERSION,
  );
  return {
    laptop,
    studio,
    host,
    hostSession: responder,
    controller,
    controllerSession: initiator,
    tunnels,
    hello,
    dialer,
    allowed,
    dialed,
    received,
    logs,
  };
}

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** Milliseconds from the first body bytes to the end. */
  spreadMs: number;
}

/**
 * One HTTP request through a tunnel stream, as a browser would send it. It
 * fails unless the host's dialer served it, so nothing reaches the server
 * directly.
 */
async function get(p: Preview, port: number, path: string): Promise<Response> {
  const dialedBefore = p.dialed.count;
  const response = await sendThroughTunnel(p, port, path);
  expect(p.dialed.count).toBe(dialedBefore + 1);
  return response;
}

function sendThroughTunnel(
  p: Preview,
  port: number,
  path: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        host: 'localhost',
        port,
        path,
        // No agent: an agent would ignore `createConnection` and dial the
        // server directly.
        createConnection: (): TunnelSocket =>
          p.tunnels.openStream('localhost', port, { class: 'loopback' }),
      },
      (response) => {
        const parts: Buffer[] = [];
        let firstAt = 0;
        response.on('data', (part: Buffer) => {
          if (parts.length === 0) firstAt = Date.now();
          parts.push(part);
        });
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(parts),
            spreadMs: Date.now() - firstAt,
          }),
        );
        response.once('error', reject);
      },
    );
    sent.once('error', reject);
    sent.end();
  });
}

/**
 * One request on a raw stream, read until the stream closes however it ends
 * (complete, or reset by the byte budget); resolves with the bytes read,
 * headers included, without keeping them.
 */
function drain(p: Preview, port: number, path: string): Promise<number> {
  const socket = p.tunnels.openStream('localhost', port, {
    class: 'loopback',
  });
  let bytes = 0;
  socket.on('data', (part: Buffer) => {
    bytes += part.byteLength;
  });
  socket.on('error', () => undefined);
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
  );
  // Not `once(socket, 'close')`, which rejects on the reset's error.
  return new Promise((resolve) => socket.once('close', () => resolve(bytes)));
}

/** An HTTP response through the tunnel, hashed as it arrives. */
function digest(
  p: Preview,
  port: number,
  path: string,
): Promise<{ status: number; bytes: number; sha256: string }> {
  const dialedBefore = p.dialed.count;
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        host: 'localhost',
        port,
        path,
        createConnection: (): TunnelSocket =>
          p.tunnels.openStream('localhost', port, { class: 'loopback' }),
      },
      (response) => {
        const hash = createHash('sha256');
        let bytes = 0;
        response.on('data', (part: Buffer) => {
          hash.update(part);
          bytes += part.byteLength;
        });
        response.once('end', () => {
          expect(p.dialed.count).toBe(dialedBefore + 1);
          resolve({
            status: response.statusCode ?? 0,
            bytes,
            sha256: hash.digest('hex'),
          });
        });
        response.once('error', reject);
      },
    );
    sent.once('error', reject);
    sent.end();
  });
}

/** How a `tunnel.open` ended: `ok`, or the host's refusal code. */
function openOutcome(
  p: Preview,
  host: string,
  port: number,
  destinationClass: TunnelDestinationClass = 'loopback',
): Promise<string> {
  const socket = p.tunnels.openStream(host, port, { class: destinationClass });
  return new Promise((resolve) => {
    socket.once('connect', () => {
      socket.destroy();
      resolve('ok');
    });
    socket.once('error', (error: Error) =>
      resolve(error instanceof TunnelOpenError ? error.code : error.message),
    );
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting.');
}

/** A loopback port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string')
    throw new Error('No port.');
  return address.port;
}

/** A listener in this process, which stands in for Canopy main. */
/** A listener on loopback `port` in another process, as a dev server is. */
async function otherListener(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:net').createServer((s) => s.on('error', () => {})).listen(${String(port)}, '127.0.0.1', () => process.stdout.write('up\\n'))`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const stdout = child.stdout;
  if (!stdout) throw new Error('The listener has no output.');
  await once(stdout, 'data');
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function canopyListener(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    // The dialer resets a refused connection.
    socket.on('error', () => undefined);
    socket.end('canopy');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No port.');
  return { server, port: address.port };
}

let servers: DevServers;
const previews: Preview[] = [];

async function open(
  options: Parameters<typeof preview>[0] = {},
): Promise<Preview> {
  const created = await preview(options);
  previews.push(created);
  return created;
}

beforeAll(async () => {
  servers = await startDevServers();
});

afterEach(() => {
  resetLoopbackListenerOwnersForTests();
  for (const created of previews.splice(0)) {
    created.controller.close();
    created.dialer.close();
    created.laptop.manager.dispose();
    created.studio.manager.dispose();
    created.laptop.endpoint.stop();
    created.studio.endpoint.stop();
  }
});

afterAll(async () => {
  await servers.stop();
  for (const dir of [tempDirs.records, tempDirs.uploads])
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe('web preview through a host session', () => {
  it('streams a chunked response as it is written, byte for byte', async () => {
    const p = await open();
    const response = await get(p, servers.port, '/stream');
    expect(response.status).toBe(200);
    expect(response.headers['transfer-encoding']).toBe('chunked');
    expect(response.body.toString()).toBe(STREAM_PARTS.join(''));
    // Parts arrive as the server writes them, not all at the end.
    expect(response.spreadMs).toBeGreaterThanOrEqual(STREAM_GAP_MS);
  });

  it('carries a 20 MB asset byte for byte', async () => {
    const p = await open();
    // Hashed as it arrives, so the test never holds the 20 MB at once.
    const response = await digest(p, servers.port, '/asset');
    expect(response.status).toBe(200);
    expect(response.bytes).toBe(ASSET_BYTES);
    expect(response.sha256).toBe(servers.assetSha256);
  });

  it('passes an absolute redirect and cookies through unchanged', async () => {
    const p = await open();
    const redirect = await get(p, servers.port, '/redirect');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe(
      `http://localhost:${String(servers.port)}/next`,
    );
    const next = await get(
      p,
      servers.port,
      new URL(redirect.headers.location ?? '').pathname,
    );
    expect(next.status).toBe(200);
    expect(next.body.toString()).toBe(NEXT_PAGE);
    expect(next.headers['set-cookie']).toEqual(NEXT_COOKIES);
  });

  it('round-trips WebSocket messages, text and binary', async () => {
    const p = await open();
    const socket = new WebSocket(`ws://localhost:${String(servers.port)}/ws`, {
      createConnection: (): TunnelSocket =>
        p.tunnels.openStream('localhost', servers.port, {
          class: 'loopback',
        }),
    });
    await once(socket, 'open');
    expect(p.dialed.count).toBe(1);
    const binary = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const replies: Array<{ data: Buffer; isBinary: boolean }> = [];
    socket.on('message', (data: Buffer, isBinary: boolean) =>
      replies.push({ data, isBinary }),
    );
    socket.send('hot update');
    socket.send(binary);
    await until(() => replies.length === 2);
    expect(replies[0]?.data.toString()).toBe('hot update');
    expect(replies[0]?.isBinary).toBe(false);
    expect(replies[1]?.data.equals(binary)).toBe(true);
    expect(replies[1]?.isBinary).toBe(true);
    socket.close();
    await once(socket, 'close');
  });

  it('reaches a server listening on ::1 alone, by name and by literal', async () => {
    const v6Port = servers.v6Port;
    if (v6Port === null) {
      // This machine has no IPv6 loopback.
      return;
    }
    const p = await open();
    expect(await openOutcome(p, '[::1]', v6Port)).toBe('ok');
    // A name under localhost tries 127.0.0.1 first, then falls back to ::1.
    expect(await openOutcome(p, 'app.localhost', v6Port)).toBe('ok');
    // Nothing listens on 127.0.0.1 there: a literal is never rewritten.
    expect(await openOutcome(p, '127.0.0.1', v6Port)).toBe('refused');
    const response = await get(p, v6Port, '/');
    expect(response.body.toString()).toBe(V6_PAGE);
  });

  it("refuses Canopy's own listeners: reserved ports, and listeners its processes hold", async () => {
    const p = await open();
    // The deny registry refuses before dialing.
    const release = reserveLoopbackPort(servers.port);
    try {
      expect(await openOutcome(p, 'localhost', servers.port)).toBe('policy');
    } finally {
      release();
    }
    // Released, the port is no longer Canopy's.
    expect(await openOutcome(p, 'localhost', servers.port)).toBe('ok');
    // The fixed MCP proxy and managed Ollama ports.
    expect(await openOutcome(p, '127.0.0.1', 37645)).toBe('policy');
    expect(await openOutcome(p, '127.0.0.1', 11534)).toBe('policy');
    // A listener this process holds, as Canopy main would, found by the
    // owner lookup after the dial connected: /proc on Linux, an execFile of
    // lsof on macOS or netstat on Windows.
    const canopy = await canopyListener();
    try {
      expect(await openOutcome(p, '127.0.0.1', canopy.port)).toBe('policy');
      expect(await openOutcome(p, 'localhost', canopy.port)).toBe('policy');
    } finally {
      canopy.server.close();
    }
    // The dev server's process is not Canopy's.
    expect(await openOutcome(p, 'localhost', servers.port)).toBe('ok');
    const reasons = p.logs.map((entry) => entry.fields.reason);
    expect(reasons).toEqual(
      expect.arrayContaining(['reserved-port', 'canopy-listener']),
    );
  });

  it('tells a connection by the socket that accepted it, not by whoever listens on its port by the time the owner check runs', async () => {
    // A Canopy server accepts the dial, then stops listening while it keeps
    // the connection, and another program takes the port before the owner
    // check looks.
    const accepted: Socket[] = [];
    const canopy = createServer((socket) => {
      socket.on('error', () => undefined);
      accepted.push(socket);
    });
    canopy.listen(0, '127.0.0.1');
    await once(canopy, 'listening');
    const address = canopy.address();
    if (address === null || typeof address === 'string')
      throw new Error('No port.');
    const taken: { child?: ChildProcess } = {};
    const p = await open({
      deps: {
        listenerOwner: async (connection) => {
          await until(() => accepted.length > 0);
          canopy.close();
          taken.child = await otherListener(connection.port);
          return loopbackListenerOwner(connection);
        },
      },
    });
    try {
      expect(await openOutcome(p, '127.0.0.1', address.port)).toBe('policy');
    } finally {
      for (const socket of accepted) socket.destroy();
      if (taken.child) await stopChild(taken.child);
    }
  });

  it('tells a connection still queued on a busy ::1 listener from a Canopy listener on 127.0.0.1 at the same port', async () => {
    if (servers.v6Port === null) return;
    // A dev server on ::1 that is busy, so the dial waits in its accept
    // queue, beside a Canopy listener on 127.0.0.1 at the same port.
    const busy = spawn(
      process.execPath,
      [
        '-e',
        `const s = require('node:net').createServer((c) => c.end('dev')); s.listen(0, '::1', () => { process.stdout.write(s.address().port + '\\n'); process.stdin.once('data', () => { const end = Date.now() + 1500; while (Date.now() < end); }); });`,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const stdout = busy.stdout;
    const stdin = busy.stdin;
    if (!stdout || !stdin) throw new Error('The dev server has no pipes.');
    const port = Number.parseInt(String(await once(stdout, 'data')), 10);
    const canopy = createServer((socket) => socket.destroy());
    try {
      canopy.listen(port, '127.0.0.1');
      await once(canopy, 'listening');
      stdin.write('busy\n');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const p = await open();
      // Linux tells which listener queued it. lsof and netstat can't, and
      // there a connection no process holds yet is refused.
      expect(await openOutcome(p, '[::1]', port)).toBe(
        process.platform === 'linux' ? 'ok' : 'policy',
      );
    } finally {
      canopy.close();
      await stopChild(busy);
    }
  });

  it('fails closed when a listener owner cannot be found, and falls back to the registry where no lookup exists', async () => {
    const failing = await open({
      deps: { listenerOwner: () => Promise.reject(new Error('lsof failed')) },
    });
    expect(await openOutcome(failing, 'localhost', servers.port)).toBe(
      'policy',
    );
    const unknown = await open({
      deps: { listenerOwner: () => Promise.resolve('unknown') },
    });
    expect(await openOutcome(unknown, 'localhost', servers.port)).toBe(
      'policy',
    );
    const unavailable = await open({
      deps: { listenerOwner: () => Promise.resolve('unavailable') },
    });
    expect(await openOutcome(unavailable, 'localhost', servers.port)).toBe(
      'ok',
    );
    expect(await openOutcome(unavailable, '127.0.0.1', 37645)).toBe('policy');
    expect(
      unavailable.logs.filter((entry) =>
        entry.message.includes('cannot look up listener owners'),
      ),
    ).toHaveLength(1);
  });

  it('dials only localhost names and loopback literals, as sent, and refuses the rest unlooked-up', async () => {
    const p = await open({ limits: { opensPerSecond: 1000 } });
    lookedUp.length = 0;
    // Loopback names, any case, with trailing dots; subdomains are never
    // looked up and dial 127.0.0.1, then ::1.
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'app.localhost',
      'a.b.localhost..',
      '127.0.0.1',
    ])
      expect(await openOutcome(p, host, servers.port)).toBe('ok');
    expect(new Set(lookedUp)).toEqual(new Set(['localhost']));
    // A 127.0.0.0/8 literal is dialed as sent, never rewritten to the
    // address that listens. Only Linux routes all of 127/8 to loopback.
    if (process.platform === 'linux')
      expect(await openOutcome(p, '127.8.0.1', servers.port)).toBe('refused');

    lookedUp.length = 0;
    // Other names are refused before any lookup, whatever they resolve to,
    // so a controller learns nothing from this computer's resolver.
    for (const host of [
      'example.com',
      'localhost.example.com',
      'notlocalhost',
      'localhostx',
      'missing.invalid',
      '[localhost]',
      '127.1',
      '0x7f.0.0.1',
    ])
      expect(await openOutcome(p, host, servers.port)).toBe('policy');
    expect(lookedUp).toEqual([]);
    // Every address that is not loopback, or not exactly ::1 for IPv6.
    for (const address of [
      '0.0.0.0',
      '::',
      '::ffff:127.0.0.1',
      '[::ffff:7f00:1]',
      '169.254.169.254',
      'fe80::1',
      'fe80::1%eth0',
      'fd00:ec2::254',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.20',
      '100.64.0.1',
      'fd12:3456::1',
      '93.184.216.34',
      '2606:4700::1111',
      '224.0.0.1',
      'ff02::1',
      '255.255.255.255',
    ])
      expect(await openOutcome(p, address, servers.port)).toBe('policy');
    // Class lan is CAN-7686; even a loopback destination is refused.
    expect(await openOutcome(p, '192.168.1.20', 80, 'lan')).toBe('policy');
    expect(await openOutcome(p, 'localhost', servers.port, 'lan')).toBe(
      'policy',
    );
    // Logs name ports and fixed reasons, never hosts or addresses.
    const logged = JSON.stringify(p.logs);
    for (const secret of ['example.com', '93.184', '192.168', 'fe80'])
      expect(logged).not.toContain(secret);
  });

  it("shares one paired computer's limits across its sessions and reconnects", async () => {
    let now = 5_000_000;
    const budget = new TunnelBudget(
      { maxStreams: 1, byteBudget: 4 * 1024 * 1024 },
      () => now,
    );
    const first = await open({ budget });
    const second = await open({ budget });
    // The one stream the computer may hold is open in its first session.
    const held = first.tunnels.openStream('localhost', servers.port, {
      class: 'loopback',
    });
    held.on('error', () => undefined);
    await once(held, 'connect');
    expect(await openOutcome(second, 'localhost', servers.port)).toBe('limit');
    held.destroy();
    await until(() => budget.streams === 0);
    // Bytes spent in one session count in the next, as after a reconnect.
    expect(await drain(first, servers.port, '/five-mib')).toBeGreaterThan(0);
    await until(() => budget.exhausted);
    const reconnected = await open({ budget });
    expect(await openOutcome(reconnected, 'localhost', servers.port)).toBe(
      'limit',
    );
    now += 60 * 60 * 1000;
    expect(await openOutcome(reconnected, 'localhost', servers.port)).toBe(
      'ok',
    );
  });

  it("refuses an account proxy an earlier run left listening, by the proxy's records", async () => {
    const dir = proxyRecordDir();
    // Its command line names the proxy's config, as a real proxy's does.
    const proxy = await startDevServers([join(dir, 'config-earlier.yaml')]);
    // Another program that reused a recorded pid after the proxy exited.
    const reused = await startDevServers();
    // The command lines /proc or ps report for them, read the same way on
    // every platform, Windows included, where no reader exists.
    const commandLines = new Map([
      [proxy.pid, `node -e <proxy> ${join(dir, 'config-earlier.yaml')}`],
      [reused.pid, 'node -e <another program>'],
    ]);
    setLocalAccountProxyDepsForTests({
      commandLine: (pid: number): Promise<string | null> =>
        Promise.resolve(commandLines.get(pid) ?? null),
    });
    const stopPorts = registerCanopyPorts(recordedLocalAccountProxyPorts);
    let stopPids = (): void => undefined;
    try {
      const p = await open({ limits: { opensPerSecond: 1000 } });
      expect(await openOutcome(p, '127.0.0.1', proxy.port)).toBe('ok');
      await writeFile(
        join(dir, 'orphan-1.json'),
        JSON.stringify({ pid: proxy.pid, port: proxy.port }),
      );
      await writeFile(
        join(dir, 'orphan-2.json'),
        JSON.stringify({ pid: reused.pid, port: reused.port }),
      );
      // The confirmed proxy's recorded port alone refuses it: the check that
      // holds where no owner lookup exists.
      expect(await openOutcome(p, '127.0.0.1', proxy.port)).toBe('policy');
      // A reused pid is not the proxy: neither its port nor its process.
      stopPids = registerCanopyProcesses(recordedLocalAccountProxyPids);
      expect(await openOutcome(p, '127.0.0.1', reused.port)).toBe('ok');
      if (proxy.v6Port !== null)
        // The proxy's process is Canopy's on every port it holds.
        expect(await openOutcome(p, '[::1]', proxy.v6Port)).toBe('policy');

      // Where a command line can't be read, only the recorded port is
      // refused, never every listener of whatever holds the pid.
      setLocalAccountProxyDepsForTests({
        commandLine: (): Promise<null> => Promise.resolve(null),
      });
      expect(await openOutcome(p, '127.0.0.1', reused.port)).toBe('policy');
      if (reused.v6Port !== null)
        expect(await openOutcome(p, '[::1]', reused.v6Port)).toBe('ok');
    } finally {
      resetLocalAccountProxyForTests();
      stopPids();
      stopPorts();
      await rm(join(dir, 'orphan-1.json'), { force: true });
      await rm(join(dir, 'orphan-2.json'), { force: true });
      await proxy.stop();
      await reused.stop();
    }
  });

  it('refuses a running account proxy whose record cleanup renames while the records are read', async () => {
    const dir = proxyRecordDir();
    const record = join(dir, 'process.json');
    const orphan = join(dir, `orphan-${String(servers.pid)}.json`);
    // The dev server stands in for a running proxy whose command line can't
    // be read, as on Windows, so only its recorded port marks it.
    setLocalAccountProxyDepsForTests({
      commandLine: (): Promise<null> => Promise.resolve(null),
    });
    await writeFile(
      record,
      JSON.stringify({ pid: servers.pid, port: servers.port }),
    );
    // Cleanup renames the record into an orphan one just after the orphan
    // records were listed.
    let renamed = false;
    mockAfterReaddir.hook = async (path): Promise<void> => {
      if (path !== dir || !existsSync(record)) return;
      await rename(record, orphan);
      renamed = true;
    };
    const stopPorts = registerCanopyPorts(recordedLocalAccountProxyPorts);
    try {
      const p = await open();
      expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('policy');
      expect(renamed).toBe(true);
    } finally {
      mockAfterReaddir.hook = undefined;
      stopPorts();
      resetLocalAccountProxyForTests();
      await rm(record, { force: true });
      await rm(orphan, { force: true });
    }
  });

  it('refuses where an account proxy record exists but cannot be read', async () => {
    const dir = proxyRecordDir();
    const record = join(dir, 'orphan-1.json');
    setLocalAccountProxyDepsForTests({
      commandLine: (): Promise<null> => Promise.resolve(null),
    });
    await writeFile(
      record,
      JSON.stringify({ pid: servers.pid, port: servers.port }),
    );
    // The read fails as an unreadable file's does, for root too.
    mockBeforeReadFile.hook = (path): Promise<void> =>
      path === record
        ? Promise.reject(accessDenied(record))
        : Promise.resolve();
    const stopPorts = registerCanopyPorts(recordedLocalAccountProxyPorts);
    try {
      const p = await open();
      expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('policy');
    } finally {
      mockBeforeReadFile.hook = undefined;
      stopPorts();
      resetLocalAccountProxyForTests();
      await rm(record, { force: true });
    }
  });

  it('starts no further proxy record read once the dial that asked has timed out', async () => {
    const dir = proxyRecordDir();
    const own = join(dir, 'process.json');
    const orphan = join(dir, 'orphan-1.json');
    setLocalAccountProxyDepsForTests({
      commandLine: (): Promise<null> => Promise.resolve(null),
    });
    await writeFile(own, JSON.stringify({ pid: servers.pid, port: 1 }));
    await writeFile(orphan, JSON.stringify({ pid: servers.pid, port: 2 }));
    // This launch's record is read slowly, past the dial's timeout.
    const read: unknown[] = [];
    const held: { release?: () => void } = {};
    mockBeforeReadFile.hook = (path): Promise<void> => {
      read.push(path);
      return path === own && held.release === undefined
        ? new Promise((resolve) => {
            held.release = resolve;
          })
        : Promise.resolve();
    };
    const stopPorts = registerCanopyPorts(recordedLocalAccountProxyPorts);
    const budget = new TunnelBudget({ maxStreams: 1 });
    try {
      const p = await open({ budget, limits: { dialTimeoutMs: 100 } });
      expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe(
        'unreachable',
      );
      held.release?.();
      await until(() => budget.streams === 0);
      // The lookup was abandoned: neither the orphan record nor this
      // launch's record again.
      expect(read).toEqual([own]);
    } finally {
      mockBeforeReadFile.hook = undefined;
      held.release?.();
      stopPorts();
      resetLocalAccountProxyForTests();
      await rm(own, { force: true });
      await rm(orphan, { force: true });
    }
  });

  it('counts a recorded proxy running as a process this user may not signal', async () => {
    const dir = proxyRecordDir();
    const record = join(dir, 'orphan-1.json');
    // Process 1 runs as root: signalling it fails with EPERM, not ESRCH.
    setLocalAccountProxyDepsForTests({
      commandLine: (): Promise<null> => Promise.resolve(null),
    });
    await writeFile(record, JSON.stringify({ pid: 1, port: servers.port }));
    const stopPorts = registerCanopyPorts(recordedLocalAccountProxyPorts);
    try {
      const p = await open();
      expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('policy');
    } finally {
      stopPorts();
      resetLocalAccountProxyForTests();
      await rm(record, { force: true });
    }
  });

  it('holds a stream slot until every account proxy record read settles, even after one fails', async () => {
    const dir = proxyRecordDir();
    const unreadable = join(dir, 'orphan-1.json');
    const slow = join(dir, 'orphan-2.json');
    setLocalAccountProxyDepsForTests({
      commandLine: (): Promise<null> => Promise.resolve(null),
    });
    await writeFile(
      unreadable,
      JSON.stringify({ pid: servers.pid, port: servers.port }),
    );
    await writeFile(slow, JSON.stringify({ pid: servers.pid, port: 1 }));
    // One record can't be read (for root too) while another read is still
    // on its way.
    const held: { release?: () => void } = {};
    mockBeforeReadFile.hook = (path): Promise<void> =>
      path === unreadable
        ? Promise.reject(accessDenied(unreadable))
        : path === slow
          ? new Promise((resolve) => {
              held.release = resolve;
            })
          : Promise.resolve();
    const stopPorts = registerCanopyPorts(recordedLocalAccountProxyPorts);
    const budget = new TunnelBudget({ maxStreams: 1 });
    try {
      const p = await open({ budget, limits: { dialTimeoutMs: 100 } });
      expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe(
        'unreachable',
      );
      // The slow read still runs, so the open's slot is still taken.
      expect(budget.streams).toBe(1);
      expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('limit');
      mockBeforeReadFile.hook = undefined;
      held.release?.();
      await until(() => budget.streams === 0);
    } finally {
      mockBeforeReadFile.hook = undefined;
      held.release?.();
      stopPorts();
      resetLocalAccountProxyForTests();
      await rm(unreadable, { force: true });
      await rm(slow, { force: true });
    }
  });

  it('settles a lookup tool it stopped only once the process has closed', async () => {
    // Windows ends a process at once on SIGTERM, so no tool there can be
    // slow to exit after one; the delay this needs exists only on POSIX.
    if (process.platform === 'win32') return;
    const ready = join(proxyRecordDir(), 'tool-ready');
    const controller = new AbortController();
    // A tool that takes 300 ms to exit once signalled.
    const settled = runSystemTool(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000);`,
      ],
      controller.signal,
    );
    try {
      await until(() => existsSync(ready));
      const abortedAt = Date.now();
      controller.abort();
      const result = await settled;
      expect(result.ok).toBe(false);
      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(250);
    } finally {
      await rm(ready, { force: true });
    }
  });

  it("refuses a pending sign-in's callback even where no owner lookup exists", async () => {
    const ports = { claude: await freePort(), codex: await freePort() };
    const signIns = new RemoteAccountProxySignIns({
      openExternal: (): Promise<void> => Promise.resolve(),
      forward: (): Promise<void> => Promise.resolve(),
      ports,
    });
    const p = await open({
      deps: { listenerOwner: () => Promise.resolve('unavailable') },
    });
    try {
      await signIns.open({
        provider: 'claude',
        url: 'https://claude.ai/oauth/authorize?client=test',
        state: 'can-7679-sign-in',
      });
      expect(await openOutcome(p, '127.0.0.1', ports.claude)).toBe('policy');
    } finally {
      signIns.closeAll();
    }
    // Closed, the port is no longer the app's.
    expect(await openOutcome(p, '127.0.0.1', ports.claude)).toBe('refused');
  });

  it('resets open streams within a tick once the controller is no longer authorized', async () => {
    const authorized = { value: true };
    const p = await open({ authorized });
    const idle = new WebSocket(`ws://localhost:${String(servers.port)}/ws`, {
      createConnection: (): TunnelSocket =>
        p.tunnels.openStream('localhost', servers.port, {
          class: 'loopback',
        }),
    });
    idle.on('error', () => undefined);
    await once(idle, 'open');
    authorized.value = false;
    await once(idle, 'close');
    expect(p.dialer.openStreams).toBe(0);
  });

  it('answers refused for a port nothing listens on, and never opens a connection the listener reset', async () => {
    const p = await open();
    const closed = await canopyListener();
    closed.server.close();
    await once(closed.server, 'close');
    expect(await openOutcome(p, 'localhost', closed.port)).toBe('refused');

    // The listener resets each connection while the owner check runs.
    const resetting = createServer((socket) => {
      setTimeout(() => socket.resetAndDestroy(), 50);
    });
    resetting.listen(0, '127.0.0.1');
    await once(resetting, 'listening');
    const address = resetting.address();
    if (address === null || typeof address === 'string')
      throw new Error('No port.');
    const slow = await open({
      deps: {
        listenerOwner: () =>
          new Promise((resolve) => setTimeout(() => resolve('other'), 200)),
      },
    });
    try {
      expect(await openOutcome(slow, '127.0.0.1', address.port)).toBe(
        'unreachable',
      );
      expect(slow.dialer.openStreams).toBe(0);
    } finally {
      resetting.close();
    }
  });

  it('holds a stream slot until a lookup the open gave up on settles', async () => {
    const answers: Array<() => void> = [];
    const budget = new TunnelBudget({ maxStreams: 2 });
    const p = await open({
      budget,
      // Long enough for the last open's connect under a loaded runner; the
      // first two still give up, since their lookup never answers in time.
      limits: { dialTimeoutMs: 1_000 },
      deps: {
        lookup: (): Promise<TunnelAddress[]> =>
          new Promise((resolve) =>
            answers.push(() => resolve([{ address: '127.0.0.1', family: 4 }])),
          ),
        // The owner check isn't what this test is about.
        listenerOwner: (): Promise<'other'> => Promise.resolve('other'),
      },
    });
    // Both opens time out while the localhost lookup keeps running.
    expect(await openOutcome(p, 'localhost', servers.port)).toBe('unreachable');
    expect(await openOutcome(p, 'localhost', servers.port)).toBe('unreachable');
    // Their slots are still taken.
    expect(budget.streams).toBe(2);
    expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('limit');
    // The lookup settles: both slots free, and an open is served.
    for (const answer of answers.splice(0)) answer();
    await until(() => budget.streams === 0);
    expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('ok');
  });

  it('holds a stream slot until an owner lookup the open gave up on stops, and stops it', async () => {
    const lookups: Array<{ signal?: AbortSignal; finish: () => void }> = [];
    const budget = new TunnelBudget({ maxStreams: 2 });
    const p = await open({
      budget,
      limits: { dialTimeoutMs: 100 },
      deps: {
        listenerOwner: (_connection, signal) =>
          new Promise((resolve) =>
            lookups.push({ signal, finish: () => resolve('unknown') }),
          ),
      },
    });
    // Both opens time out while their owner lookups keep running.
    expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('unreachable');
    expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('unreachable');
    // The lookups were told to stop, and hold their slots until they do.
    expect(lookups.map((lookup) => lookup.signal?.aborted)).toEqual([
      true,
      true,
    ]);
    expect(budget.streams).toBe(2);
    expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('limit');
    for (const lookup of lookups.splice(0)) lookup.finish();
    await until(() => budget.streams === 0);
  });

  it('holds a stream slot until every Canopy process source settles, even after one fails', async () => {
    // One source fails at once while another, like a ps probe, still runs.
    const pending: { finish?: () => void } = {};
    const stopFailing = registerCanopyProcesses(() =>
      Promise.reject(new Error('malformed daemon descriptor')),
    );
    const stopPending = registerCanopyProcesses(
      () =>
        new Promise<number[]>((resolve) => {
          pending.finish = (): void => resolve([]);
        }),
    );
    const budget = new TunnelBudget({ maxStreams: 1 });
    try {
      const p = await open({ budget, limits: { dialTimeoutMs: 100 } });
      expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe(
        'unreachable',
      );
      // The probe still runs, so the open's slot is still taken.
      expect(budget.streams).toBe(1);
      expect(await openOutcome(p, '127.0.0.1', servers.port)).toBe('limit');
      pending.finish?.();
      await until(() => budget.streams === 0);
    } finally {
      stopFailing();
      stopPending();
    }
  });

  it('refuses controllers that are not desktops without dialing', async () => {
    for (const kind of ['browser', 'mobile'] as const) {
      const p = await open({ kind });
      expect(await openOutcome(p, 'localhost', servers.port)).toBe(
        'unavailable',
      );
      expect(p.dialed.count).toBe(0);
    }
  });

  it('refuses every open while web preview is not allowed', async () => {
    const off = await open({ allowed: false });
    expect(await openOutcome(off, 'localhost', servers.port)).toBe(
      'unavailable',
    );
    expect(off.dialer.openStreams).toBe(0);
    // Allowed, then disallowed: later opens are refused.
    const later = await open();
    later.allowed.value = false;
    expect(await openOutcome(later, 'localhost', servers.port)).toBe(
      'unavailable',
    );
  });

  it('enforces the open rate, stream count and byte budget', async () => {
    let now = 1_000_000;
    const rate = await open({ deps: { now: () => now } });
    const outcomes = await Promise.all(
      Array.from({ length: 52 }, () =>
        openOutcome(rate, 'localhost', servers.port),
      ),
    );
    expect(outcomes.filter((code) => code === 'ok')).toHaveLength(50);
    expect(outcomes.filter((code) => code === 'limit')).toHaveLength(2);
    now += 1_000;
    expect(await openOutcome(rate, 'localhost', servers.port)).toBe('ok');

    // An idle WebSocket stays open while a download spends the budget.
    const budget = await open({
      deps: { now: () => now },
      limits: { byteBudget: 4 * 1024 * 1024 },
    });
    const idle = new WebSocket(`ws://localhost:${String(servers.port)}/ws`, {
      createConnection: (): TunnelSocket =>
        budget.tunnels.openStream('localhost', servers.port, {
          class: 'loopback',
        }),
    });
    idle.on('error', () => undefined);
    await once(idle, 'open');
    // Watched from before the download: the reset may close it first.
    const idleClosed = once(idle, 'close');
    // The download may finish, or be reset part way once a sample sees the
    // budget spent; either way the budget is spent.
    expect(await drain(budget, servers.port, '/five-mib')).toBeGreaterThan(0);
    // Within a second of the budget passing (the dialer's setInterval byte
    // sample), every stream resets and later opens wait for the next window.
    await idleClosed;
    expect(budget.dialer.openStreams).toBe(0);
    expect(await openOutcome(budget, 'localhost', servers.port)).toBe('limit');
    expect(
      budget.logs.some((entry) => entry.message.includes('byte budget')),
    ).toBe(true);
    now += 60 * 60 * 1000;
    expect(await openOutcome(budget, 'localhost', servers.port)).toBe('ok');
  });

  it('rechecks the byte budget once a slow owner check returns', async () => {
    const parked = await canopyListener();
    const gate: { release?: () => void } = {};
    const p = await open({
      limits: { byteBudget: 4 * 1024 * 1024 },
      deps: {
        listenerOwner: ({ port }) =>
          port === parked.port
            ? new Promise((resolve) => {
                gate.release = (): void => resolve('other');
              })
            : Promise.resolve('other'),
      },
    });
    try {
      // Admitted under the budget, then held in its owner check...
      const held = openOutcome(p, '127.0.0.1', parked.port);
      await until(() => gate.release !== undefined);
      // ...while another stream spends the whole budget.
      expect(await drain(p, servers.port, '/five-mib')).toBeGreaterThan(0);
      gate.release?.();
      expect(await held).toBe('limit');
    } finally {
      parked.server.close();
    }
  });

  it('drops a dial the controller cancelled by sending on a stream not yet open', async () => {
    const parked = await canopyListener();
    const gate: { release?: () => void } = {};
    const budget = new TunnelBudget();
    const p = await open({
      budget,
      deps: {
        // Like the real lookup, it stops once its signal aborts.
        listenerOwner: (_connection, signal) =>
          new Promise((resolve) => {
            gate.release = (): void => resolve('other');
            signal?.addEventListener('abort', () => resolve('unknown'));
          }),
      },
    });
    try {
      // Stream 1 is held in its owner check after the dial connected.
      const pending = openOutcome(p, '127.0.0.1', parked.port);
      await until(() => gate.release !== undefined);
      // Data for a stream the host has not answered cancels the dial, at
      // once rather than at the 10 s dial bound.
      const cancelledAt = Date.now();
      p.controller.notify(REMOTE_EVENTS.tunnelData, {
        streamId: 1,
        bytes: new Uint8Array([1]),
      });
      expect(await pending).not.toBe('ok');
      await until(() => budget.streams === 0);
      expect(Date.now() - cancelledAt).toBeLessThan(2_000);
      gate.release?.();
      await until(() => budget.streams === 0);
      expect(p.dialer.openStreams).toBe(0);
    } finally {
      parked.server.close();
    }
  });

  it('abandons opens still looking up when the dialer closes, dialing nothing', async () => {
    let connects = 0;
    let lookupStarted = false;
    const lookup: { settle?: () => void } = {};
    const p = await open({
      deps: {
        lookup: () => {
          lookupStarted = true;
          return new Promise((resolve) => {
            lookup.settle = (): void => resolve([]);
          });
        },
        connect: (address, port) => {
          connects += 1;
          return connect({
            host: address.address,
            port,
            family: address.family,
            allowHalfOpen: true,
          });
        },
      },
    });
    const pending = openOutcome(p, 'localhost', servers.port);
    await until(() => lookupStarted);
    const closedAt = Date.now();
    p.dialer.close();
    expect(await pending).toBe('unavailable');
    // At once, not after the 10 s dial bound.
    expect(Date.now() - closedAt).toBeLessThan(2_000);
    lookup.settle?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(connects).toBe(0);
  });
});
