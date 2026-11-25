/**
 * CAN-7678: TCP-like byte streams carried side by side over one encrypted
 * Remote Control session. A real host session and a controller run over the
 * in-memory relay; the host's open handler, which CAN-7679 replaces with the
 * policy-checked dialer, connects each stream to a real local server.
 */
import { createHash, randomBytes, type Hash } from 'node:crypto';
import { once } from 'node:events';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, type Readable, type Writable } from 'node:stream';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import { z } from 'zod';

jest.mock('../../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: () => void } => ({
    recordAppDiagnostic: (): void => undefined,
  }),
}));

import type { HostBridge } from '../host/bridge-window';
import { RemoteHostSession } from '../host/host-session';
import { RemoteUploadStore } from '../host/uploads';
import {
  HelloResultSchema,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TRANSPORT_RESUME_VERSION,
  TUNNEL_INITIAL_WINDOW_BYTES,
  TUNNEL_MAX_CHUNK_BYTES,
  TUNNEL_SESSION_WINDOW_BYTES,
  TunnelCreditParamsSchema,
  TunnelDataParamsSchema,
  TunnelEndParamsSchema,
  TunnelOpenParamsSchema,
} from '../remote-protocol';
import { RpcPeer } from '../transport/rpc-peer';
import type { AckCadence, SecureSession } from '../transport/session-manager';
import {
  TunnelStreamMux,
  type TunnelOpenDecision,
  type TunnelOpenHandler,
  type TunnelOpenRequest,
  type TunnelTransport,
} from '../tunnel/stream-mux';
import { TunnelClosedError, type TunnelSocket } from '../tunnel/tunnel-socket';
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
const MiB = 1024 * 1024;

interface Harness {
  hub: InMemoryRelayHub;
  laptop: TestDevice;
  studio: TestDevice;
  host: RemoteHostSession;
  controller: RpcPeer;
  /** The host's end of the encrypted session. */
  hostSession: SecureSession;
  controllerSession: SecureSession;
  tunnels: TunnelStreamMux;
  /** Every host socket the open handler dialed. */
  dialed: Socket[];
  /** Every request the host's open handler was given. */
  opens: TunnelOpenRequest[];
  /** Opens the host gave up dialing because the controller cancelled. */
  abortedOpens: { count: number };
  invokes: string[];
  /** Bytes of `tunnel.data` that reached the controller, by stream. */
  arrived: Map<number, number>;
  /** Bytes the controller credited back, by stream. */
  credited: Map<number, number>;
  /** The largest received-but-uncredited count seen on any stream. */
  peakUncredited: { value: number };
  /** Streams whose credit the controller drops, as a faulty peer would. */
  ignoreCredit: Set<number>;
  /** The stream of each `tunnel.data` the controller sent, in order. */
  sentData: number[];
  /** `tunnel.credit` messages the controller sent. */
  creditMessages: { count: number };
  /** The stream of each `tunnel.end` the controller sent, in order. */
  sentEnds: number[];
}

/** A port whose stream reaches a socket that never takes a byte. */
const STALLED_PORT = 9;
/** A port whose dial never finishes unless the open is cancelled. */
const HANGING_PORT = 7;
/**
 * A port whose socket says it is done sending at once and holds its first
 * write in `heldWrites` until the test finishes or fails it.
 */
const PENDING_PORT = 11;
/** A port whose socket takes each 32 KiB 60 ms after the last. */
const SLOW_PORT = 13;
/**
 * A port whose socket sends `generator.total` random bytes, made only as the
 * tunnel pulls them, so backpressure is exact and no kernel buffer hides
 * any; it ignores what it is sent.
 */
const GENERATED_PORT = 17;

const generator: {
  /** Bytes each connection sends; Infinity sends until `stopped`. */
  total: number;
  stopped: boolean;
  /** Bytes made so far, every connection together. */
  produced: number;
  /** Each connection's digest, once it sent everything. */
  digests: Array<Promise<string>>;
} = { total: 0, stopped: false, produced: 0, digests: [] };

function generatedSocket(): Duplex {
  const total = generator.total;
  const hash = createHash('sha256');
  let produced = 0;
  let finish: (digest: string) => void = (): void => undefined;
  generator.digests.push(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
  );
  const socket: Duplex = new Duplex({
    read: (): void => {
      const size = Math.min(TUNNEL_MAX_CHUNK_BYTES, total - produced);
      if (size > 0 && !generator.stopped) {
        const part = randomBytes(size);
        produced += size;
        generator.produced += size;
        hash.update(part);
        socket.push(part);
        if (produced < total) return;
      }
      socket.push(null);
      finish(hash.digest('hex'));
    },
    write: (_chunk, _encoding, done): void => done(),
  });
  return socket;
}

/** The sockets the fake ports handed out, for the cases that inspect them. */
const fakeSockets: Duplex[] = [];
/** Write callbacks a pending-port socket holds. */
const heldWrites: Array<(error?: Error | null) => void> = [];
/** Bytes slow-port sockets accepted. */
let slowReceived = 0;

function pendingSocket(): Duplex {
  let writes = 0;
  const socket = new Duplex({
    highWaterMark: 64 * 1024 * 1024,
    read: (): void => undefined,
    write: (_chunk, _encoding, done): void => {
      writes += 1;
      // Node writes one at a time: the rest wait behind the first.
      if (writes > 1) done();
      else heldWrites.push(done);
    },
  });
  socket.push(null);
  return socket;
}

function slowSocket(): Duplex {
  const socket = new Duplex({
    read: (): void => undefined,
    write: (chunk: Buffer, _encoding, done): void => {
      setTimeout(() => {
        slowReceived += chunk.byteLength;
        done();
      }, 60);
    },
    final: (done): void => {
      socket.push(null);
      done();
    },
  });
  return socket;
}
const LOOPBACK = { class: 'loopback' } as const;

function stalledSocket(): Duplex {
  return new Duplex({
    read: (): void => undefined,
    write: (): void => undefined,
  });
}

/** Dials the local server on the requested port, as a dialer would. */
function dialLocal(
  dialed: Socket[],
  opens: TunnelOpenRequest[],
  abortedOpens: { count: number },
): TunnelOpenHandler {
  return (request, signal) =>
    new Promise((resolve) => {
      opens.push(request);
      if (request.port === HANGING_PORT) {
        signal.addEventListener('abort', () => {
          abortedOpens.count += 1;
          resolve({ ok: false, code: 'unavailable' });
        });
        return;
      }
      if (request.port === PENDING_PORT || request.port === SLOW_PORT) {
        const socket =
          request.port === PENDING_PORT ? pendingSocket() : slowSocket();
        fakeSockets.push(socket);
        resolve({ ok: true, socket });
        return;
      }
      if (request.port === GENERATED_PORT) {
        const socket = generatedSocket();
        fakeSockets.push(socket);
        resolve({ ok: true, socket });
        return;
      }
      if (request.port === STALLED_PORT) {
        const socket = stalledSocket();
        fakeSockets.push(socket);
        resolve({ ok: true, socket });
        return;
      }
      const socket = connect({
        host: '127.0.0.1',
        port: request.port,
        allowHalfOpen: true,
      });
      const abort = (): void => {
        socket.destroy();
        resolve({ ok: false, code: 'unavailable' });
      };
      signal.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => {
        signal.removeEventListener('abort', abort);
        dialed.push(socket);
        resolve({ ok: true, socket });
      });
      socket.once('error', () => {
        signal.removeEventListener('abort', abort);
        resolve({ ok: false, code: 'refused' });
      });
    });
}

async function harness(
  options: {
    kind?: DeviceKind;
    open?: TunnelOpenHandler | null;
    openTimeoutMs?: number;
    /** How often the controller acknowledges what it receives. */
    controllerAckCadence?: AckCadence;
    hostMaxStreams?: number;
    /** Held bytes past which the controller's stream data waits. */
    controllerHeldBytesLimit?: number;
    /** How long the controller's small credit waits to coalesce. */
    controllerCreditTickMs?: number;
  } = {},
): Promise<Harness> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(
    hub,
    'Laptop',
    options.controllerAckCadence
      ? { ackCadence: options.controllerAckCadence }
      : {},
  );
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  const { initiator, responder } = await openControlSession(laptop, studio);
  const dialed: Socket[] = [];
  const opens: TunnelOpenRequest[] = [];
  const abortedOpens = { count: 0 };
  const invokes: string[] = [];
  const bridge: HostBridge = {
    getChatInterest: (): undefined => undefined,
    window: null,
    invoke: (channel: string): Promise<unknown> => {
      invokes.push(channel);
      return Promise.resolve({ answered: channel });
    },
    post: (): void => undefined,
    onPush: (): (() => void) => (): void => undefined,
    onClosed: (): (() => void) => (): void => undefined,
    destroy: (): void => undefined,
  };
  const open =
    options.open === undefined
      ? dialLocal(dialed, opens, abortedOpens)
      : options.open;
  const host = new RemoteHostSession({
    session: responder,
    kind: options.kind ?? 'desktop',
    attributedDeviceId: responder.peerDeviceId,
    createBridge: (): Promise<HostBridge> => Promise.resolve(bridge),
    mainWindowPushes: { subscribe: (): (() => void) => (): void => undefined },
    uploads: new RemoteUploadStore(join(tmpdir(), 'tunnel-streams-uploads')),
    readFile: (): Promise<never> =>
      Promise.reject(new Error('no reads in this test')),
    disposition: (): 'tunnel' => 'tunnel',
    isAuthorized: (): boolean => true,
    version: VERSION,
    hello: (): { name: string; platform: 'darwin' } => ({
      name: 'Studio',
      platform: 'darwin',
    }),
    onClose: (): void => undefined,
    ...(open === null ? {} : { tunnelOpen: open }),
    ...(options.hostMaxStreams === undefined
      ? {}
      : { tunnelMaxStreams: options.hostMaxStreams }),
  });
  const arrived = new Map<number, number>();
  const credited = new Map<number, number>();
  const peakUncredited = { value: 0 };
  const ignoreCredit = new Set<number>();
  const sentData: number[] = [];
  const creditMessages = { count: 0 };
  const sentEnds: number[] = [];
  const uncredited = (streamId: number): number =>
    (arrived.get(streamId) ?? 0) - (credited.get(streamId) ?? 0);
  let tunnels: TunnelStreamMux | null = null;
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('unexpected request')),
    onEvent: (name, payload): void => {
      const data = TunnelDataParamsSchema.safeParse(payload);
      if (name === REMOTE_EVENTS.tunnelData && data.success) {
        const { streamId, bytes } = data.data;
        arrived.set(streamId, (arrived.get(streamId) ?? 0) + bytes.byteLength);
        peakUncredited.value = Math.max(
          peakUncredited.value,
          uncredited(streamId),
        );
      }
      const credit = TunnelCreditParamsSchema.safeParse(payload);
      if (
        name === REMOTE_EVENTS.tunnelCredit &&
        credit.success &&
        ignoreCredit.has(credit.data.streamId)
      )
        return;
      tunnels?.handleEvent(name, payload);
    },
  });
  // The controller's side of the session, counting the credit it returns.
  const transport: TunnelTransport = {
    notify: (name, payload, notifyOptions) => {
      const credit = TunnelCreditParamsSchema.safeParse(payload);
      if (name === REMOTE_EVENTS.tunnelCredit && credit.success) {
        const { streamId, bytes } = credit.data;
        credited.set(streamId, (credited.get(streamId) ?? 0) + bytes);
        creditMessages.count += 1;
      }
      const data = TunnelDataParamsSchema.safeParse(payload);
      if (name === REMOTE_EVENTS.tunnelData && data.success) {
        sentData.push(data.data.streamId);
      }
      const end = TunnelEndParamsSchema.safeParse(payload);
      if (name === REMOTE_EVENTS.tunnelEnd && end.success) {
        sentEnds.push(end.data.streamId);
      }
      return controller.notify(name, payload, notifyOptions);
    },
    request: (method, params, requestOptions) =>
      controller.request(method, params, requestOptions),
    heldBytes: () => initiator.heldBytes,
    onHeldBytesReleased: (listener) => initiator.onHeldBytesReleased(listener),
  };
  tunnels = new TunnelStreamMux({
    role: 'controller',
    transport,
    ...(options.openTimeoutMs === undefined
      ? {}
      : { openTimeoutMs: options.openTimeoutMs }),
    ...(options.controllerHeldBytesLimit === undefined
      ? {}
      : { heldBytesLimit: options.controllerHeldBytesLimit }),
    ...(options.controllerCreditTickMs === undefined
      ? {}
      : { creditTickMs: options.controllerCreditTickMs }),
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
    hub,
    laptop,
    studio,
    host,
    controller,
    hostSession: responder,
    controllerSession: initiator,
    tunnels,
    dialed,
    opens,
    abortedOpens,
    invokes,
    arrived,
    credited,
    peakUncredited,
    ignoreCredit,
    sentData,
    creditMessages,
    sentEnds,
  };
}

const servers: Server[] = [];
/** Every connection a test server accepted, destroyed between cases. */
const serverSockets: Socket[] = [];

async function listen(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    serverSockets.push(socket);
    onConnection(socket);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('No port.');
  }
  return address.port;
}

/** Echoes every byte, and half-closes once the client did. */
function echo(socket: Socket): void {
  socket.on('error', () => undefined);
  socket.pipe(socket);
}

/** Sends `payload` and half-closes. */
function serve(payload: Buffer): (socket: Socket) => void {
  return (socket) => {
    socket.on('error', () => undefined);
    socket.end(payload);
  };
}

function connected(socket: TunnelSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
}

/** Reads a socket to its end. */
async function readAll(socket: TunnelSocket): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of socket) {
    if (Buffer.isBuffer(part)) parts.push(part);
  }
  return Buffer.concat(parts);
}

/** Polls until `condition` holds; generous, since CI machines are slow. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${condition.toString()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Writes `total` random bytes a piece at a time, waiting for drain, and
 * half-closes. Resolves the bytes' digest; nothing larger than a piece is
 * held.
 */
async function writeGenerated(
  socket: Writable,
  total: number,
  onWritten: (bytes: number) => void = (): void => undefined,
): Promise<string> {
  const hash = createHash('sha256');
  const piece = 64 * 1024;
  for (let written = 0; written < total; written += piece) {
    const part = randomBytes(Math.min(piece, total - written));
    hash.update(part);
    onWritten(written + part.byteLength);
    if (!socket.write(part)) await once(socket, 'drain');
  }
  socket.end();
  return hash.digest('hex');
}

/** Reads a stream to its end, keeping only a running digest and count. */
async function hashAll(
  readable: Readable,
  onRead: (bytes: number) => void = (): void => undefined,
  hash: Hash = createHash('sha256'),
): Promise<{ digest: string; bytes: number }> {
  let bytes = 0;
  for await (const part of readable) {
    if (!Buffer.isBuffer(part)) continue;
    hash.update(part);
    bytes += part.byteLength;
    onRead(part.byteLength);
  }
  return { digest: hash.digest('hex'), bytes };
}

/** Serves `total` generated bytes per connection; records each digest. */
function serveGenerated(
  total: number,
  digests: Array<Promise<string>>,
): (socket: Socket) => void {
  return (socket) => {
    socket.on('error', () => undefined);
    digests.push(writeGenerated(socket, total));
  };
}

/** Writes `payload` in pieces, waiting for drain as a real writer does. */
async function writeAll(socket: TunnelSocket, payload: Buffer): Promise<void> {
  const piece = 256 * 1024;
  for (let offset = 0; offset < payload.byteLength; offset += piece) {
    if (!socket.write(payload.subarray(offset, offset + piece))) {
      await once(socket, 'drain');
    }
  }
  socket.end();
}

function errorOf(socket: TunnelSocket): Promise<Error> {
  return new Promise((resolve) => socket.once('error', resolve));
}

/** A small deterministic PRNG (mulberry32), so every seed replays. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One direction of a stand-in session: ordered frames, held until read. */
interface StandInPipe {
  frames: Array<{ size: number; deliver: () => void }>;
  /** Sealed bytes the sender holds: sent and not yet read. */
  held: number;
  released: Set<() => void>;
  /** Each stream's messages in the order they were sent. */
  log: Map<number, string[]>;
}

function standInPipe(): StandInPipe {
  return { frames: [], held: 0, released: new Set(), log: new Map() };
}

const FRAME_OVERHEAD = 64;

/**
 * Two real multiplexers joined by an ordered stand-in session whose
 * deliveries the caller drives: batches, pauses and drops are random,
 * order within a direction never changes.
 */
function standInSession(options: {
  open: TunnelOpenHandler;
  window: number;
  heldBytesLimit: number;
  creditTickMs: number;
}): {
  controller: TunnelStreamMux;
  host: TunnelStreamMux;
  toHost: StandInPipe;
  toController: StandInPipe;
} {
  const toHost = standInPipe();
  const toController = standInPipe();
  let host: TunnelStreamMux | null = null;
  let controller: TunnelStreamMux | null = null;
  const send = (
    pipe: StandInPipe,
    name: string,
    payload: unknown,
    deliver: (copy: unknown) => void,
  ): boolean => {
    const data = TunnelDataParamsSchema.safeParse(payload);
    const ref = z.object({ streamId: z.number() }).safeParse(payload);
    if (ref.success) {
      const entries = pipe.log.get(ref.data.streamId) ?? [];
      entries.push(name);
      pipe.log.set(ref.data.streamId, entries);
    }
    // The session serializes: the receiver gets its own copy.
    const copy = data.success
      ? { ...data.data, bytes: new Uint8Array(data.data.bytes) }
      : payload;
    const size =
      (data.success ? data.data.bytes.byteLength : 0) + FRAME_OVERHEAD;
    pipe.held += size;
    pipe.frames.push({ size, deliver: () => deliver(copy) });
    return true;
  };
  const transport = (
    out: StandInPipe,
    target: () => TunnelStreamMux | null,
  ): TunnelTransport => ({
    notify: (name, payload): boolean =>
      send(out, name, payload, (copy) => target()?.handleEvent(name, copy)),
    request: (_method, params): Promise<unknown> =>
      new Promise((resolve, reject) => {
        out.held += FRAME_OVERHEAD;
        out.frames.push({
          size: FRAME_OVERHEAD,
          deliver: () => {
            const answering = host;
            if (!answering) return;
            answering.serveOpen(params).then(
              (result) => {
                toController.held += FRAME_OVERHEAD;
                toController.frames.push({
                  size: FRAME_OVERHEAD,
                  deliver: () => resolve(result),
                });
              },
              (error: unknown) => {
                toController.held += FRAME_OVERHEAD;
                toController.frames.push({
                  size: FRAME_OVERHEAD,
                  deliver: () =>
                    reject(error instanceof Error ? error : new Error('open')),
                });
              },
            );
          },
        });
      }),
    heldBytes: (): number => out.held,
    onHeldBytesReleased: (listener): (() => void) => {
      out.released.add(listener);
      return () => out.released.delete(listener);
    },
  });
  controller = new TunnelStreamMux({
    role: 'controller',
    transport: transport(toHost, () => host),
    initialWindowBytes: options.window,
    heldBytesLimit: options.heldBytesLimit,
    creditTickMs: options.creditTickMs,
  });
  host = new TunnelStreamMux({
    role: 'host',
    transport: transport(toController, () => controller),
    open: options.open,
    initialWindowBytes: options.window,
    heldBytesLimit: options.heldBytesLimit,
    creditTickMs: options.creditTickMs,
  });
  return { controller, host, toHost, toController };
}

/** Delivers up to `count` frames of a pipe in one go, as one read does. */
function deliverBatch(pipe: StandInPipe, count: number): void {
  const batch = pipe.frames.splice(0, count);
  for (const frame of batch) {
    pipe.held -= frame.size;
    frame.deliver();
  }
  if (batch.length > 0)
    for (const listener of Array.from(pipe.released)) listener();
}

interface InterleavingPlan {
  upload: number;
  download: number;
  /** Controller destroys the stream after reading this many bytes. */
  controllerReset: number | null;
  /** Host's socket is destroyed after sending this many bytes. */
  hostReset: number | null;
  /** Controller cancels the stream right after opening it. */
  cancelAtOpen: boolean;
}

interface InterleavingOutcome {
  plan: InterleavingPlan;
  read: { digest: string; bytes: number };
  wrote: string;
  error: Error | null;
  resetByController: boolean;
}

/**
 * One seeded run: random streams, batches, pauses, credit timing, resets
 * and a relay drop over the stand-in session, checking the multiplexer's
 * invariants at every delivery and every byte at the end.
 */
async function runInterleaving(seed: number): Promise<void> {
  const rand = seededRandom(seed);
  const pick = (min: number, max: number): number =>
    min + Math.floor(rand() * (max - min + 1));
  const later = (): Promise<void> =>
    rand() < 0.6
      ? new Promise<void>((resolve) => setImmediate(resolve))
      : new Promise<void>((resolve) => setTimeout(resolve, pick(0, 2)));
  const window = 2 * TUNNEL_MAX_CHUNK_BYTES;
  const heldBytesLimit = 4 * TUNNEL_MAX_CHUNK_BYTES;
  const plans: InterleavingPlan[] = Array.from({ length: pick(1, 6) }, () => ({
    upload: pick(0, 72 * 1024),
    download: pick(0, 72 * 1024),
    controllerReset: rand() < 0.15 ? pick(1, 64 * 1024) : null,
    hostReset: rand() < 0.1 ? pick(1, 64 * 1024) : null,
    cancelAtOpen: rand() < 0.05,
  }));
  const destinations = new Map<
    number,
    {
      received: Hash;
      receivedBytes: number;
      sent: Hash;
      sentDigest: string | null;
      resetByHost: boolean;
      socket: Duplex;
    }
  >();
  const open: TunnelOpenHandler = (request) =>
    new Promise((resolve) => {
      const plan = plans[request.port - 1];
      if (!plan) {
        resolve({ ok: false, code: 'refused' });
        return;
      }
      const record = {
        received: createHash('sha256'),
        receivedBytes: 0,
        sent: createHash('sha256'),
        sentDigest: null as string | null,
        resetByHost: false,
        socket: new Duplex(),
      };
      let produced = 0;
      let pushing = false;
      const socket: Duplex = new Duplex({
        read: (): void => {
          if (pushing) return;
          pushing = true;
          const produce = (): void => {
            pushing = false;
            if (socket.destroyed) return;
            const size = Math.min(pick(1, 40 * 1024), plan.download - produced);
            if (size <= 0) {
              record.sentDigest = record.sent.digest('hex');
              socket.push(null);
              return;
            }
            const part = randomBytes(size);
            produced += size;
            record.sent.update(part);
            socket.push(part);
            if (plan.hostReset !== null && produced >= plan.hostReset) {
              record.resetByHost = true;
              socket.destroy();
            }
          };
          if (rand() < 0.5) setImmediate(produce);
          else setTimeout(produce, pick(0, 2));
        },
        write: (chunk: Buffer, _encoding, done): void => {
          record.received.update(chunk);
          record.receivedBytes += chunk.byteLength;
          if (rand() < 0.5) done();
          else setTimeout(done, pick(0, 2));
        },
      });
      record.socket = socket;
      destinations.set(request.port, record);
      setTimeout(() => resolve({ ok: true, socket }), pick(0, 1));
    });
  const { controller, host, toHost, toController } = standInSession({
    open,
    window,
    heldBytesLimit,
    creditTickMs: pick(1, 5),
  });

  const checkInvariants = (): void => {
    for (const mux of [controller, host]) {
      expect(mux.inFlightBytes).toBeLessThanOrEqual(
        TUNNEL_SESSION_WINDOW_BYTES,
      );
      for (let id = 1; id <= plans.length; id += 1) {
        const counters = mux.counters(id);
        if (!counters) continue;
        expect(counters.outstandingBytes).toBeLessThanOrEqual(window);
        expect(counters.uncreditedBytes).toBeLessThanOrEqual(window);
      }
    }
    for (const pipe of [toHost, toController]) {
      // At most one data chunk past the limit, plus small control frames.
      expect(pipe.held).toBeLessThanOrEqual(
        heldBytesLimit + TUNNEL_MAX_CHUNK_BYTES + 64 * FRAME_OVERHEAD,
      );
    }
  };

  const outcomes = plans.map(
    (plan, index): Promise<InterleavingOutcome> =>
      new Promise((resolve) => {
        const socket = controller.openStream('localhost', index + 1, LOOPBACK);
        const readHash = createHash('sha256');
        const writeHash = createHash('sha256');
        let readBytes = 0;
        let error: Error | null = null;
        let resetByController = false;
        socket.on('error', (cause: Error) => {
          error = cause;
        });
        socket.once('close', () =>
          resolve({
            plan,
            read: { digest: readHash.digest('hex'), bytes: readBytes },
            wrote: writeHash.digest('hex'),
            error,
            resetByController,
          }),
        );
        if (plan.cancelAtOpen) {
          resetByController = true;
          socket.destroy();
          return;
        }
        const write = async (): Promise<void> => {
          if (socket.connecting) await once(socket, 'connect');
          let written = 0;
          while (written < plan.upload && !socket.destroyed) {
            const part = randomBytes(
              Math.min(pick(1, 48 * 1024), plan.upload - written),
            );
            written += part.byteLength;
            writeHash.update(part);
            if (!socket.write(part))
              await Promise.race([
                once(socket, 'drain'),
                once(socket, 'close'),
              ]);
          }
          if (!socket.destroyed) socket.end();
        };
        write().catch(() => undefined);
        const poll = (): void => {
          if (socket.destroyed) return;
          let reads = pick(0, 4);
          let part: unknown;
          while (reads > 0 && (part = socket.read()) !== null) {
            reads -= 1;
            if (!Buffer.isBuffer(part)) continue;
            readHash.update(part);
            readBytes += part.byteLength;
            if (
              plan.controllerReset !== null &&
              readBytes >= plan.controllerReset
            ) {
              resetByController = true;
              socket.destroy();
              return;
            }
          }
          if (rand() < 0.3) setTimeout(poll, pick(0, 3));
          else setImmediate(poll);
        };
        poll();
      }),
  );
  let settled = false;
  const all = Promise.all(outcomes).then((results) => {
    settled = true;
    return results;
  });

  // Deliver in random batches; once, the relay drops for a while.
  let dropAt = rand() < 0.7 ? pick(1, 12) : -1;
  let paused = 0;
  for (let step = 0; ; step += 1) {
    if (step === dropAt) {
      paused = pick(3, 20);
      dropAt = -1;
    }
    if (paused > 0) {
      paused -= 1;
    } else {
      const pipes =
        rand() < 0.5 ? [toHost, toController] : [toController, toHost];
      for (const pipe of pipes) {
        deliverBatch(pipe, pick(1, 8));
        checkInvariants();
      }
    }
    if (
      settled &&
      toHost.frames.length === 0 &&
      toController.frames.length === 0 &&
      controller.streamCount === 0 &&
      host.streamCount === 0
    )
      break;
    if (step > 200_000) throw new Error(`Seed ${seed} did not settle.`);
    await later();
  }

  const results = await all;
  // A destination may still be working through writes the stream handed it.
  await waitFor(() =>
    Array.from(destinations.values()).every(
      (destination) =>
        destination.socket.writableFinished || destination.socket.destroyed,
    ),
  );
  results.forEach((outcome, index) => {
    const destination = destinations.get(index + 1);
    // Only resets the seed planned skip the byte checks; a stream that was
    // never dialed without one is a failure.
    if (outcome.resetByController || destination?.resetByHost === true) return;
    if (!destination)
      throw new Error(`Seed ${seed}: stream ${index + 1} was never dialed.`);
    // An undisturbed stream carried every byte, both ways.
    expect(outcome.error).toBeNull();
    expect(outcome.read.bytes).toBe(outcome.plan.download);
    expect(outcome.read.digest).toBe(destination.sentDigest);
    expect(destination.receivedBytes).toBe(outcome.plan.upload);
    expect(destination.received.digest('hex')).toBe(outcome.wrote);
  });
  // Nothing follows a stream's end or reset on the wire.
  for (const pipe of [toHost, toController]) {
    for (const messages of Array.from(pipe.log.values())) {
      const end = messages.indexOf(REMOTE_EVENTS.tunnelEnd);
      const reset = messages.indexOf(REMOTE_EVENTS.tunnelReset);
      if (end >= 0)
        expect(messages.slice(end + 1)).not.toContain(REMOTE_EVENTS.tunnelData);
      if (reset >= 0) expect(messages.slice(reset + 1)).toEqual([]);
      expect(
        messages.filter((name) => name === REMOTE_EVENTS.tunnelEnd).length,
      ).toBeLessThanOrEqual(1);
    }
  }
  for (const mux of [controller, host]) {
    expect(mux.inFlightBytes).toBe(0);
    expect(mux.problems.malformed).toBe(0);
    expect(mux.problems.overruns).toBe(0);
  }
  controller.close();
  host.close();
}

describe('tunnel streams over a Remote Control session', () => {
  let current: Harness | null = null;

  afterEach(async () => {
    if (current) {
      current.controller.close('closed');
      current.host.close('closed');
      current.laptop.manager.dispose();
      current.studio.manager.dispose();
    }
    current = null;
    for (const socket of serverSockets.splice(0)) socket.destroy();
    for (const socket of fakeSockets.splice(0)) socket.destroy();
    heldWrites.length = 0;
    slowReceived = 0;
    for (const server of servers.splice(0)) server.close();
    generator.total = 0;
    generator.stopped = false;
    generator.produced = 0;
    generator.digests = [];
    await flushRelay();
  });

  it('carries 2 MB each way byte for byte, and both half-closes', async () => {
    current = await harness();
    const port = await listen(echo);

    const socket = current.tunnels.openStream('localhost', port, LOOPBACK);
    await connected(socket);
    const [echoed, sent] = await Promise.all([
      hashAll(socket),
      writeGenerated(socket, 2 * MiB),
    ]);

    expect(echoed.bytes).toBe(2 * MiB);
    expect(echoed.digest).toBe(sent);
    // The stream finished cleanly: nothing was reset, and it left the table.
    const { tunnels } = current;
    await waitFor(() => tunnels.streamCount === 0);
    expect(tunnels.problems).toEqual({ malformed: 0, overruns: 0, stray: 0 });
    expect(tunnels.inFlightBytes).toBe(0);
  });

  it('delivers a half-close: the server answers after the client ends', async () => {
    current = await harness();
    const order: string[] = [];
    const port = await listen((server) => {
      const parts: Buffer[] = [];
      server.on('data', (part: Buffer) => parts.push(part));
      server.on('end', () => {
        order.push('server saw end');
        server.end(`bye ${Buffer.concat(parts).toString()}`);
      });
    });

    const socket = current.tunnels.openStream('localhost', port, LOOPBACK);
    await connected(socket);
    socket.end('hello');
    const reply = await readAll(socket);
    order.push('client read reply');

    expect(reply.toString()).toBe('bye hello');
    expect(order).toEqual(['server saw end', 'client read reply']);
    if (!socket.closed) await once(socket, 'close');
    expect(socket.errored).toBeNull();
    const [dialed] = current.dialed;
    if (!dialed) throw new Error('Nothing dialed.');
    if (!dialed.destroyed) await once(dialed, 'close');
  });

  it('never has more bytes in flight than the window while the reader is slow', async () => {
    current = await harness();
    const total = 4 * TUNNEL_INITIAL_WINDOW_BYTES;
    generator.total = total;

    const socket = current.tunnels.openStream(
      'localhost',
      GENERATED_PORT,
      LOOPBACK,
    );
    await connected(socket);
    socket.end();
    socket.pause();
    // The reader takes nothing: the sender stops at the window.
    const streamId = socket.streamId;
    const { arrived, credited } = current;
    await waitFor(
      () => (arrived.get(streamId) ?? 0) >= TUNNEL_INITIAL_WINDOW_BYTES,
    );
    for (let round = 0; round < 10; round += 1) await flushRelay();
    expect(arrived.get(streamId)).toBe(TUNNEL_INITIAL_WINDOW_BYTES);
    expect(credited.get(streamId) ?? 0).toBe(0);
    // The source is held back too: it made the window and what the sockets
    // between buffer, far short of everything.
    expect(generator.produced).toBeLessThan(2 * TUNNEL_INITIAL_WINDOW_BYTES);

    // A slow reader: 16 KiB at a time.
    const hash = createHash('sha256');
    let read = 0;
    while (read < total) {
      const part: unknown = socket.read(16 * 1024) ?? socket.read();
      if (Buffer.isBuffer(part)) {
        hash.update(part);
        read += part.byteLength;
        // The bytes the reader has not taken never pass the window.
        expect(socket.readableLength).toBeLessThanOrEqual(
          TUNNEL_INITIAL_WINDOW_BYTES,
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(hash.digest('hex')).toBe(await generator.digests[0]);
    expect(current.peakUncredited.value).toBeLessThanOrEqual(
      TUNNEL_INITIAL_WINDOW_BYTES,
    );
    expect(current.tunnels.problems.overruns).toBe(0);
  });

  it('carries many streams at once and answers ipc.invoke while they flow', async () => {
    current = await harness();
    // The sources send until stopped, so bulk traffic is still flowing when
    // the call goes out and when its answer comes back.
    generator.total = Number.POSITIVE_INFINITY;
    const count = 8;

    const { tunnels } = current;
    const sockets = Array.from({ length: count }, () =>
      tunnels.openStream('localhost', GENERATED_PORT, LOOPBACK),
    );
    let bulk = 0;
    let ended = 0;
    for (const socket of sockets) socket.end();
    const reads = sockets.map(async (socket) => {
      const result = await hashAll(socket, (bytes) => {
        bulk += bytes;
      });
      ended += 1;
      return result;
    });
    await Promise.all(sockets.map(connected));
    // Every stream's window is in use before the call.
    await waitFor(() => bulk >= count * TUNNEL_INITIAL_WINDOW_BYTES);

    const startedAt = bulk;
    const answer = await current.controller.request(REMOTE_METHODS.invoke, {
      channel: 'app:get-version',
      args: [],
    });
    const answeredAt = bulk;
    expect(answer).toEqual({ answered: 'app:get-version' });
    // The answer waited behind at most the bytes already in flight, and
    // every stream was still open when it came.
    expect(answeredAt - startedAt).toBeLessThan(
      2 * TUNNEL_SESSION_WINDOW_BYTES,
    );
    expect(ended).toBe(0);

    generator.stopped = true;
    const results = await Promise.all(reads);
    const sent = new Set(await Promise.all(generator.digests));
    for (const result of results) {
      expect(result.bytes).toBeGreaterThan(0);
      expect(sent.has(result.digest)).toBe(true);
    }
  });

  it('sends queued streams one chunk each in turn', async () => {
    current = await harness();
    const port = await listen((server) => {
      server.on('error', () => undefined);
      server.resume();
      server.on('end', () => server.end());
    });
    const sockets = Array.from({ length: 8 }, () =>
      current?.tunnels.openStream('localhost', port, LOOPBACK),
    ).filter((socket): socket is TunnelSocket => socket !== undefined);
    await Promise.all(sockets.map(connected));
    const payload = randomBytes(TUNNEL_INITIAL_WINDOW_BYTES + 64 * 1024);

    // Every stream has a megabyte queued before anything is sent.
    await Promise.all(
      sockets.map(async (socket) => {
        await Promise.all([readAll(socket), writeAll(socket, payload)]);
      }),
    );

    // While all eight had credit, they took turns one chunk each, in the
    // order they queued: every rotation serves every stream once.
    const order = sockets.map((socket) => socket.streamId);
    const rotations = TUNNEL_INITIAL_WINDOW_BYTES / TUNNEL_MAX_CHUNK_BYTES;
    const opening = current.sentData.slice(0, sockets.length * rotations);
    expect(opening).toHaveLength(sockets.length * rotations);
    for (let rotation = 0; rotation < rotations; rotation += 1) {
      const start = rotation * sockets.length;
      expect(opening.slice(start, start + sockets.length)).toEqual(order);
    }
  });

  it('keeps a stream through a relay drop and resume mid-transfer', async () => {
    current = await harness();
    const total = 4 * MiB;
    generator.total = total;

    const socket = current.tunnels.openStream(
      'localhost',
      GENERATED_PORT,
      LOOPBACK,
    );
    await connected(socket);
    socket.end();
    let read = 0;
    let dropped = false;
    const { laptop, studio } = current;
    const result = await hashAll(socket, (bytes) => {
      read += bytes;
      if (dropped || read < 1.5 * MiB) return;
      dropped = true;
      // The controller's relay link drops with frames in flight.
      laptop.endpoint.dropConnection();
      setTimeout(
        () => laptop.endpoint.restoreConnection([studio.endpoint]),
        50,
      );
    });

    expect(dropped).toBe(true);
    expect(result.bytes).toBe(total);
    expect(result.digest).toBe(await generator.digests[0]);
    expect(current.controller.isClosed).toBe(false);
    expect(current.tunnels.problems).toEqual({
      malformed: 0,
      overruns: 0,
      stray: 0,
    });
  });

  it('resets every stream when the session closes', async () => {
    current = await harness();
    const port = await listen(echo);
    const sockets = [
      current.tunnels.openStream('localhost', port, LOOPBACK),
      current.tunnels.openStream('localhost', port, LOOPBACK),
      current.tunnels.openStream('localhost', port, LOOPBACK),
    ];
    await Promise.all(sockets.map(connected));
    for (const socket of sockets) socket.write('still open');
    await flushRelay();
    const errors = sockets.map(errorOf);
    const dialedClosed = current.dialed.map((socket) => once(socket, 'close'));

    current.host.end('disconnected');

    for (const error of await Promise.all(errors)) {
      expect(error).toBeInstanceOf(TunnelClosedError);
    }
    await Promise.all(dialedClosed);
    expect(current.dialed).toHaveLength(3);
    expect(current.tunnels.streamCount).toBe(0);
    // A stream opened after the close fails at once.
    const late = current.tunnels.openStream('localhost', port, LOOPBACK);
    expect(await errorOf(late)).toBeInstanceOf(TunnelClosedError);
  });

  it('resets only the stream a malformed or overrunning message names', async () => {
    current = await harness();
    const port = await listen(echo);
    const victim = current.tunnels.openStream('localhost', port, LOOPBACK);
    const overrun = current.tunnels.openStream(
      'localhost',
      STALLED_PORT,
      LOOPBACK,
    );
    const bystander = current.tunnels.openStream('localhost', port, LOOPBACK);
    await Promise.all([victim, overrun, bystander].map(connected));
    const victimError = errorOf(victim);
    const overrunError = errorOf(overrun);

    // Larger than a chunk may be: malformed, so the host resets the stream.
    current.controller.notify(REMOTE_EVENTS.tunnelData, {
      streamId: victim.streamId,
      bytes: new Uint8Array(TUNNEL_MAX_CHUNK_BYTES + 1),
    });
    // Past the window the host gave: an overrun. The host's socket takes
    // only its first bytes, and the controller ignores that credit too.
    current.ignoreCredit.add(overrun.streamId);
    for (
      let sent = 0;
      sent <= 2 * TUNNEL_INITIAL_WINDOW_BYTES;
      sent += TUNNEL_MAX_CHUNK_BYTES
    ) {
      current.controller.notify(REMOTE_EVENTS.tunnelData, {
        streamId: overrun.streamId,
        bytes: new Uint8Array(TUNNEL_MAX_CHUNK_BYTES),
      });
    }

    expect(await victimError).toMatchObject({
      name: 'TunnelResetError',
      code: 'protocol',
    });
    expect(await overrunError).toMatchObject({
      name: 'TunnelResetError',
      code: 'flow_control',
    });
    // The session and every other stream carry on.
    bystander.end('still here');
    expect((await readAll(bystander)).toString()).toBe('still here');
    await expect(
      current.controller.request(REMOTE_METHODS.invoke, {
        channel: 'app:get-version',
        args: [],
      }),
    ).resolves.toEqual({ answered: 'app:get-version' });
    expect(current.controller.isClosed).toBe(false);
  });

  it('sends TLS streams uncompressed and plain streams compressed', async () => {
    current = await harness();
    const payload = Buffer.alloc(MiB, 0x61);
    const port = await listen(serve(payload));
    const relayed = async (tls: boolean): Promise<number> => {
      const hub = current?.hub;
      if (!hub || !current) throw new Error('No harness.');
      const before = hub.delivered.length;
      const socket = current.tunnels.openStream('localhost', port, {
        ...LOOPBACK,
        tls,
      });
      socket.end();
      const body = await readAll(socket);
      expect(body.equals(payload)).toBe(true);
      return hub.delivered
        .slice(before)
        .filter((frame) => frame.to === current?.laptop.identity.deviceId)
        .reduce((sum, frame) => sum + frame.bytes, 0);
    };

    const plain = await relayed(false);
    const tls = await relayed(true);
    expect(plain).toBeLessThan(payload.byteLength / 10);
    expect(tls).toBeGreaterThan(payload.byteLength);
  });

  it('stops compressing a stream once it turns out to carry TLS', async () => {
    current = await harness();
    // Takes everything and answers nothing.
    const port = await listen((server) => {
      server.on('error', () => undefined);
      server.resume();
      server.on('end', () => server.end());
    });
    const payload = Buffer.alloc(MiB, 0x61);
    const uploaded = async (compress: boolean): Promise<number> => {
      const hub = current?.hub;
      if (!hub || !current) throw new Error('No harness.');
      const studio = current.studio.identity.deviceId;
      const socket = current.tunnels.openStream('localhost', port, LOOPBACK);
      await connected(socket);
      // A CONNECT proxy learns the bytes are TLS only from the first one.
      socket.setCompression(compress);
      const before = hub.delivered.length;
      await Promise.all([readAll(socket), writeAll(socket, payload)]);
      return hub.delivered
        .slice(before)
        .filter((frame) => frame.to === studio)
        .reduce((sum, frame) => sum + frame.bytes, 0);
    };

    expect(await uploaded(true)).toBeLessThan(payload.byteLength / 10);
    expect(await uploaded(false)).toBeGreaterThan(payload.byteLength);
  });

  it('stops compressing both ways when the first byte the client sends is TLS', async () => {
    current = await harness();
    const port = await listen(echo);
    const relayed = async (
      first: number,
    ): Promise<{ toHost: number; toController: number }> => {
      if (!current) throw new Error('No harness.');
      const { hub, laptop, studio, tunnels } = current;
      // No tls flag and no setCompression: only the first byte tells.
      const socket = tunnels.openStream('localhost', port, LOOPBACK);
      await connected(socket);
      const before = hub.delivered.length;
      const payload = Buffer.alloc(MiB, 0x61);
      payload[0] = first;
      socket.end(payload);
      const echoed = await readAll(socket);
      expect(echoed.equals(payload)).toBe(true);
      const sum = (to: string): number =>
        hub.delivered
          .slice(before)
          .filter((frame) => frame.to === to)
          .reduce((total, frame) => total + frame.bytes, 0);
      return {
        toHost: sum(studio.identity.deviceId),
        toController: sum(laptop.identity.deviceId),
      };
    };

    const plain = await relayed(0x47);
    expect(plain.toHost).toBeLessThan(MiB / 5);
    expect(plain.toController).toBeLessThan(MiB / 5);
    const tls = await relayed(0x16);
    expect(tls.toHost).toBeGreaterThan(MiB);
    expect(tls.toController).toBeGreaterThan(MiB);
  });

  it('keeps a stream open, holding its slot, until its destination takes the upload', async () => {
    current = await harness({ hostMaxStreams: 1 });
    fakeSockets.length = 0;
    const port = await listen(echo);
    const { tunnels } = current;
    const first = tunnels.openStream('localhost', PENDING_PORT, LOOPBACK);
    await connected(first);
    expect((await readAll(first)).byteLength).toBe(0);
    let finished = false;
    first.end(randomBytes(64 * 1024), () => {
      finished = true;
    });
    await waitFor(() => heldWrites.length === 1);
    await flushRelay();

    // Both sides ended, but the destination has not taken the upload: no
    // credit, so the end has not finished and the stream keeps its slot.
    expect(finished).toBe(false);
    expect(tunnels.streamCount).toBe(1);
    const refused = tunnels.openStream('localhost', port, LOOPBACK);
    expect(await errorOf(refused)).toMatchObject({
      name: 'TunnelOpenError',
      code: 'limit',
    });

    // It takes the write: the stream completes and frees its slot.
    for (const done of heldWrites.splice(0)) done();
    await waitFor(() => finished && tunnels.streamCount === 0);
    const next = tunnels.openStream('localhost', port, LOOPBACK);
    next.end('room again');
    expect((await readAll(next)).toString()).toBe('room again');
  });

  it('opens and closes a burst of unused streams cleanly, leaking nothing', async () => {
    current = await harness();
    const port = await listen(echo);
    const { tunnels } = current;
    const errors: Error[] = [];
    // A browser opens six connections to one origin and uses one.
    const burst = Array.from({ length: 6 }, () => {
      const socket = tunnels.openStream('localhost', port, LOOPBACK);
      socket.on('error', (error: Error) => errors.push(error));
      return socket;
    });
    const [used, cancelledEarly, ...cancelledLater] = burst;
    if (!used || !cancelledEarly) throw new Error('No streams.');
    // One is closed before the host even answers.
    cancelledEarly.destroy();
    await Promise.all([used, ...cancelledLater].map(connected));
    // The others close unused once open: one ends, the rest are dropped.
    const [ended, ...dropped] = cancelledLater;
    ended?.end();
    for (const socket of dropped) socket.destroy();
    used.end('only this one');
    expect((await readAll(used)).toString()).toBe('only this one');
    if (ended) await readAll(ended);
    await waitFor(() => tunnels.streamCount === 0);

    expect(errors).toEqual([]);
    for (const socket of burst) expect(socket.errored).toBeNull();
    expect(tunnels.streamCount).toBe(0);
    expect(tunnels.inFlightBytes).toBe(0);
    expect(tunnels.problems.malformed).toBe(0);
    // The host let go of every socket it dialed for them.
    await Promise.all(
      current.dialed.map((socket) =>
        socket.destroyed ? Promise.resolve() : once(socket, 'close'),
      ),
    );
    // And it still opens streams, so none of its stream slots leaked.
    const next = tunnels.openStream('localhost', port, LOOPBACK);
    next.end('again');
    expect((await readAll(next)).toString()).toBe('again');
  });

  it('refuses opens without an open handler, from other controllers, and to closed ports', async () => {
    current = await harness({ open: null });
    const hello = HelloResultSchema.parse(
      await current.controller.request(REMOTE_METHODS.hello, {
        version: VERSION,
      }),
    );
    // Nothing advertises the feature yet (CAN-7679).
    expect(hello.features?.webPreview).toBeUndefined();
    const refused = current.tunnels.openStream('localhost', 1, LOOPBACK);
    expect(await errorOf(refused)).toMatchObject({
      name: 'TunnelOpenError',
      code: 'unavailable',
    });

    current.controller.close('closed');
    current = await harness({ kind: 'mobile' });
    const mobile = current.tunnels.openStream('localhost', 1, LOOPBACK);
    expect(await errorOf(mobile)).toMatchObject({
      name: 'TunnelOpenError',
      code: 'unavailable',
    });
    expect(current.dialed).toHaveLength(0);

    current.controller.close('closed');
    current = await harness();
    const closedPort = await listen(echo);
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const nothing = current.tunnels.openStream(
      'localhost',
      closedPort,
      LOOPBACK,
    );
    expect(await errorOf(nothing)).toMatchObject({
      name: 'TunnelOpenError',
      code: 'refused',
    });
  });
  it('passes the destination class to the host and refuses opens without a valid one', async () => {
    current = await harness();
    const port = await listen(echo);
    const loopback = current.tunnels.openStream('localhost', port, LOOPBACK);
    const lan = current.tunnels.openStream('localhost', port, { class: 'lan' });
    loopback.end('a');
    lan.end('b');
    expect((await readAll(loopback)).toString()).toBe('a');
    expect((await readAll(lan)).toString()).toBe('b');
    expect(current.opens.map((open) => open.class)).toEqual([
      'loopback',
      'lan',
    ]);

    const base = { streamId: 100, host: 'localhost', port };
    expect(TunnelOpenParamsSchema.safeParse(base).success).toBe(false);
    expect(
      TunnelOpenParamsSchema.safeParse({ ...base, class: 'internet' }).success,
    ).toBe(false);
    expect(
      TunnelOpenParamsSchema.safeParse({ ...base, class: 'lan' }).success,
    ).toBe(true);
    // The host refuses both before its open handler sees them.
    await expect(
      current.controller.request(REMOTE_METHODS.tunnelOpen, base),
    ).rejects.toThrow();
    await expect(
      current.controller.request(REMOTE_METHODS.tunnelOpen, {
        ...base,
        streamId: 101,
        class: 'internet',
      }),
    ).rejects.toThrow();
    expect(current.opens).toHaveLength(2);
  });

  it('resets a stream that sends before its open is answered', async () => {
    current = await harness();
    const socket = current.tunnels.openStream(
      'localhost',
      HANGING_PORT,
      LOOPBACK,
    );
    const { abortedOpens } = current;
    await waitFor(() => current?.opens.length === 1);
    // A faulty controller sends bytes while the host is still dialing.
    current.controller.notify(REMOTE_EVENTS.tunnelData, {
      streamId: socket.streamId,
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(await errorOf(socket)).toMatchObject({
      name: 'TunnelResetError',
      code: 'protocol',
    });
    await waitFor(() => abortedOpens.count === 1);
    expect(current.tunnels.streamCount).toBe(0);
    expect(current.controller.isClosed).toBe(false);
  });

  it('holds bytes the host sends before its answer, and drops them if the open fails', async () => {
    current = await harness({ openTimeoutMs: 300 });
    const { tunnels, abortedOpens, host, controller } = current;

    // Bytes from a faulty host before it answered an open that never is.
    const early = tunnels.openStream('localhost', HANGING_PORT, LOOPBACK);
    let delivered = 0;
    early.on('data', (part: Buffer) => {
      delivered += part.byteLength;
    });
    await waitFor(() => current?.opens.length === 1);
    host.rpc.notify(REMOTE_EVENTS.tunnelData, {
      streamId: early.streamId,
      bytes: new Uint8Array([1]),
    });
    expect(await errorOf(early)).toMatchObject({
      name: 'TunnelOpenError',
      code: 'unavailable',
    });
    expect(delivered).toBe(0);
    await waitFor(() => abortedOpens.count === 1);

    // A malformed message naming a stream the host is still dialing.
    const named = tunnels.openStream('localhost', HANGING_PORT, LOOPBACK);
    await waitFor(() => current?.opens.length === 2);
    controller.notify(REMOTE_EVENTS.tunnelData, {
      streamId: named.streamId,
      bytes: new Uint8Array(TUNNEL_MAX_CHUNK_BYTES + 1),
    });
    expect(await errorOf(named)).toMatchObject({
      name: 'TunnelResetError',
      code: 'protocol',
    });
    await waitFor(() => abortedOpens.count === 2);
    expect(tunnels.streamCount).toBe(0);
    expect(controller.isClosed).toBe(false);
  });

  it('keeps a stream whose answer and first bytes arrive in one read', async () => {
    current = await harness();
    const { hub, laptop, tunnels } = current;
    generator.total = 64 * 1024;
    const controllerId = laptop.identity.deviceId;
    // Frames to the controller pile up, then arrive together, as several
    // frames in one socket read do.
    hub.hold(controllerId);
    const socket = tunnels.openStream('localhost', GENERATED_PORT, LOOPBACK);
    socket.end();
    await waitFor(() => hub.heldCount(controllerId) >= 3);
    const result = hashAll(socket);
    hub.release(controllerId);

    const { digest, bytes } = await result;
    expect(bytes).toBe(64 * 1024);
    expect(digest).toBe(await generator.digests[0]);
    expect(tunnels.problems.malformed).toBe(0);
  });

  it('holds small credit for its tick even while the stream keeps sending', async () => {
    // A tick far longer than the case, so only the quarter-window threshold
    // could send credit.
    current = await harness({ controllerCreditTickMs: 60_000 });
    const port = await listen(echo);
    const socket = current.tunnels.openStream('localhost', port, LOOPBACK);
    socket.on('error', () => undefined);
    await connected(socket);
    const streamId = socket.streamId;
    const { creditMessages, credited, sentData } = current;
    const before = creditMessages.count;
    // Ten small exchanges: each write makes the controller send, and each
    // echo leaves it a little credit to return.
    for (let exchange = 0; exchange < 10; exchange += 1) {
      const sends = sentData.length;
      socket.write(Buffer.alloc(100, exchange));
      await waitFor(() => sentData.length > sends);
      await waitFor(() => socket.readableLength >= 100);
      socket.read(100);
    }
    expect(creditMessages.count).toBe(before);
    expect(credited.get(streamId) ?? 0).toBe(0);
    socket.destroy();
  });

  it('cancels the host dial when an open times out', async () => {
    current = await harness({ openTimeoutMs: 200 });
    const socket = current.tunnels.openStream(
      'localhost',
      HANGING_PORT,
      LOOPBACK,
    );

    expect(await errorOf(socket)).toMatchObject({
      name: 'TunnelOpenError',
      code: 'unavailable',
    });
    await flushRelay();
    expect(current.abortedOpens.count).toBe(1);
    expect(current.tunnels.streamCount).toBe(0);
  });

  it('returns credit when a paused reader takes a whole window, coalesced', async () => {
    current = await harness();
    const digests: Array<Promise<string>> = [];
    const port = await listen(serveGenerated(MiB, digests));
    const socket = current.tunnels.openStream('localhost', port, LOOPBACK);
    await connected(socket);
    socket.end();
    const streamId = socket.streamId;
    const { arrived, credited, creditMessages } = current;
    await waitFor(
      () => (arrived.get(streamId) ?? 0) >= TUNNEL_INITIAL_WINDOW_BYTES,
    );
    expect(arrived.get(streamId)).toBe(TUNNEL_INITIAL_WINDOW_BYTES);

    // Sixteen reads of 16 KiB in one go take the whole window. Credit goes
    // out once per quarter window, not once per read.
    const before = creditMessages.count;
    const hash = createHash('sha256');
    for (let index = 0; index < 16; index += 1) {
      const part: unknown = socket.read(16 * 1024);
      if (!Buffer.isBuffer(part)) throw new Error('Nothing to read.');
      hash.update(part);
    }
    expect(creditMessages.count - before).toBe(4);
    expect(credited.get(streamId)).toBe(TUNNEL_INITIAL_WINDOW_BYTES);

    const rest = await hashAll(socket, () => undefined, hash);
    expect(rest.bytes).toBe(MiB - TUNNEL_INITIAL_WINDOW_BYTES);
    expect(rest.digest).toBe(await digests[0]);
  });

  it('gives the session window back to waiting streams when streams holding it are dropped', async () => {
    current = await harness();
    const { tunnels } = current;
    const port = await listen(echo);
    // Each stalled stream holds a full window: together, the session's cap.
    const stalled = Array.from({ length: 17 }, () =>
      tunnels.openStream('localhost', STALLED_PORT, LOOPBACK),
    );
    await Promise.all(stalled.map(connected));
    const writeErrors: Error[] = [];
    // Well past a window each, so every write is still queued when its
    // stream drops; the bytes themselves do not matter.
    const filler = Buffer.alloc(2 * TUNNEL_INITIAL_WINDOW_BYTES);
    for (const socket of stalled) {
      socket.on('error', () => undefined);
      socket.write(filler, (error) => {
        if (error) writeErrors.push(error);
      });
    }
    await waitFor(() => tunnels.inFlightBytes >= TUNNEL_SESSION_WINDOW_BYTES);
    expect(tunnels.inFlightBytes).toBe(TUNNEL_SESSION_WINDOW_BYTES);

    const waiting = tunnels.openStream('localhost', port, LOOPBACK);
    await connected(waiting);
    waiting.write('after the cap');
    waiting.end();
    let answered = false;
    const reply = readAll(waiting).then((body) => {
      answered = true;
      return body;
    });
    for (let round = 0; round < 5; round += 1) await flushRelay();
    expect(answered).toBe(false);

    for (const socket of stalled) socket.destroy();

    expect((await reply).toString()).toBe('after the cap');
    // Every write still queued on a dropped stream failed instead of hanging.
    await waitFor(() => writeErrors.length === stalled.length);
    // The waiting stream's last bytes are credited on the host's tick.
    await waitFor(() => tunnels.inFlightBytes === 0);
  });
  it('serves a stream waiting on the session window before the stream whose credit freed it', async () => {
    // The real multiplexer with a stand-in session, so exactly one credit
    // frees exactly one chunk of the session window. The crediting stream
    // queues its next chunk either before the other stream starts waiting,
    // or in the same turn as its credit, so it is already in the rotation.
    for (const queuedWithCredit of [false, true]) {
      const sent: Array<{ name: string; streamId: number }> = [];
      const mux = new TunnelStreamMux({
        role: 'controller',
        initialWindowBytes: 2 * TUNNEL_MAX_CHUNK_BYTES,
        transport: {
          notify: (name, payload): boolean => {
            const data = TunnelDataParamsSchema.safeParse(payload);
            if (name === REMOTE_EVENTS.tunnelData && data.success)
              sent.push({ name, streamId: data.data.streamId });
            return true;
          },
          request: (): Promise<unknown> => Promise.resolve({ ok: true }),
        },
      });
      const window = 2 * TUNNEL_MAX_CHUNK_BYTES;
      const count = TUNNEL_SESSION_WINDOW_BYTES / window;
      const full = Array.from({ length: count }, () =>
        mux.openStream('localhost', 1, LOOPBACK),
      );
      await Promise.all(full.map(connected));
      // Every stream fills its window: the session window is full too.
      for (const socket of full) socket.write(Buffer.alloc(window));
      await waitFor(() => mux.inFlightBytes === TUNNEL_SESSION_WINDOW_BYTES);
      const [first] = full;
      if (!first) throw new Error('No streams.');
      // The first stream has more to send; a new stream waits on the session.
      if (!queuedWithCredit) first.write(Buffer.alloc(TUNNEL_MAX_CHUNK_BYTES));
      const waiting = mux.openStream('localhost', 1, LOOPBACK);
      await connected(waiting);
      waiting.write(Buffer.alloc(TUNNEL_MAX_CHUNK_BYTES));
      for (let round = 0; round < 5; round += 1) await flushRelay();
      const before = sent.length;

      // The first stream's credit frees one chunk; the waiting stream gets it.
      if (queuedWithCredit) first.write(Buffer.alloc(TUNNEL_MAX_CHUNK_BYTES));
      mux.handleEvent(REMOTE_EVENTS.tunnelCredit, {
        streamId: first.streamId,
        bytes: TUNNEL_MAX_CHUNK_BYTES,
      });
      await waitFor(() => sent.length > before);
      for (let round = 0; round < 5; round += 1) await flushRelay();
      expect(sent.slice(before).map((entry) => entry.streamId)).toEqual([
        waiting.streamId,
      ]);
      mux.close();
    }
  });

  it('keeps held bytes under the cap when acks come back slowly, and still resumes', async () => {
    // The controller credits as it reads but acknowledges only every
    // 64 MiB or 300 ms, so credit alone would let held bytes grow.
    current = await harness({
      controllerAckCadence: { bytes: 64 * MiB, intervalMs: 300 },
    });
    const { hub, laptop, studio, hostSession, tunnels } = current;
    let peakHeld = 0;
    hub.tap = (_from, _to, payload): Buffer => {
      peakHeld = Math.max(peakHeld, hostSession.heldBytes);
      return payload;
    };
    const perStream = 2 * TUNNEL_INITIAL_WINDOW_BYTES;
    generator.total = perStream;
    const sockets = Array.from({ length: 16 }, () =>
      tunnels.openStream('localhost', GENERATED_PORT, LOOPBACK),
    );
    for (const socket of sockets) socket.end();
    let total = 0;
    let dropped = false;
    const results = await Promise.all(
      sockets.map((socket) =>
        hashAll(socket, (bytes) => {
          total += bytes;
          if (dropped || total < 4 * MiB) return;
          dropped = true;
          laptop.endpoint.dropConnection();
          setTimeout(
            () => laptop.endpoint.restoreConnection([studio.endpoint]),
            50,
          );
        }),
      ),
    );

    const sent = new Set(await Promise.all(generator.digests));
    for (const result of results) {
      expect(result.bytes).toBe(perStream);
      expect(sent.has(result.digest)).toBe(true);
    }
    expect(dropped).toBe(true);
    // Held bytes stop near 4 MiB: one burst of chunks past it at most, far
    // below the 16 MiB re-send buffer, so the session never lost resume.
    expect(peakHeld).toBeGreaterThan(3 * MiB);
    expect(peakHeld).toBeLessThan(5 * MiB);
    expect(hostSession.resumable).toBe(true);
    expect(current.controller.isClosed).toBe(false);
  });

  it('delivers every byte to a destination that half-closed first', async () => {
    current = await harness();
    let received: Promise<{ digest: string; bytes: number }> = Promise.resolve({
      digest: '',
      bytes: 0,
    });
    const port = await listen((server) => {
      server.on('error', () => undefined);
      // The server says it is done sending before the client sends anything.
      server.end();
      received = hashAll(server);
    });
    const socket = current.tunnels.openStream('localhost', port, LOOPBACK);
    await connected(socket);
    // The far end's half-close arrives first; the client then sends it all.
    expect((await readAll(socket)).byteLength).toBe(0);
    const sent = await writeGenerated(socket, MiB);
    if (!socket.closed) await once(socket, 'close');

    const result = await received;
    expect(result.bytes).toBe(MiB);
    expect(result.digest).toBe(sent);
  });

  it('sends the end of one stream while held bytes keep the data of another waiting', async () => {
    const limit = 64 * 1024;
    current = await harness({ controllerHeldBytesLimit: limit });
    const { laptop, studio, tunnels, sentEnds } = current;
    const received = new Map<string, number>();
    const port = await listen((server) => {
      server.on('error', () => undefined);
      const key = String(server.remotePort);
      server.on('data', (part: Buffer) => {
        received.set(key, (received.get(key) ?? 0) + part.byteLength);
      });
      server.on('end', () => server.end());
    });
    const bulk = tunnels.openStream('localhost', port, LOOPBACK);
    const quiet = tunnels.openStream('localhost', port, LOOPBACK);
    await Promise.all([bulk, quiet].map(connected));

    // No acks while the relay is down, so held bytes pass the limit and
    // the bulk stream's data waits; the quiet stream only half-closes.
    laptop.endpoint.dropConnection();
    let written = false;
    bulk.write(randomBytes(4 * limit), () => {
      written = true;
    });
    const session = current.controllerSession;
    await waitFor(() => session.heldBytes > limit);
    for (let round = 0; round < 5; round += 1) await flushRelay();
    // The bulk stream is now first in turn and waiting; the end still goes.
    quiet.end();
    await waitFor(() => sentEnds.includes(quiet.streamId));
    expect(written).toBe(false);

    laptop.endpoint.restoreConnection([studio.endpoint]);
    await waitFor(() => written);
    bulk.end();
    await Promise.all([readAll(bulk), readAll(quiet)]);
    const total = Array.from(received.values()).reduce((a, b) => a + b, 0);
    expect(total).toBe(4 * limit);
  });

  it('holds small writes back during a relay drop instead of overflowing the re-send buffer', async () => {
    // A lower limit than the default 4 MiB, so a few thousand frames show
    // what tens of thousands would at the default.
    const limit = 512 * 1024;
    current = await harness({ controllerHeldBytesLimit: limit });
    const { laptop, studio, tunnels } = current;
    let received = 0;
    const port = await listen((server) => {
      server.on('error', () => undefined);
      server.on('data', (part: Buffer) => {
        received += part.byteLength;
      });
      server.on('end', () => server.end());
    });
    const socket = tunnels.openStream('localhost', port, LOOPBACK);
    await connected(socket);

    laptop.endpoint.dropConnection();
    // Each one-byte write is its own sealed frame of about 114 bytes, so
    // these seal to about 680 KB, past what the session may hold. Credit
    // alone would allow a whole window of them.
    const writes = 6_000;
    const one = Buffer.from([0x61]);
    for (let index = 0; index < writes; index += 1) socket.write(one);
    socket.end();
    // Let the controller seal and hold all it will while the relay is down.
    const session = current.controllerSession;
    let held = -1;
    let still = 0;
    for (let round = 0; round < 40_000 && !session.isClosed; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      still = session.heldBytes === held ? still + 1 : 0;
      held = session.heldBytes;
      if (still >= 200) break;
    }
    expect(session.isClosed).toBe(false);
    expect(session.heldBytes).toBeGreaterThan(limit);
    // Held back at the limit: at most a frame or two past it.
    expect(session.heldBytes).toBeLessThan(limit + 16 * 1024);
    laptop.endpoint.restoreConnection([studio.endpoint]);

    expect((await readAll(socket)).byteLength).toBe(0);
    expect(received).toBe(writes);
    expect(current.controller.isClosed).toBe(false);
  });
  it('reports an upload its destination fails to write as a reset, after both sides ended', async () => {
    current = await harness();
    fakeSockets.length = 0;
    const socket = current.tunnels.openStream(
      'localhost',
      PENDING_PORT,
      LOOPBACK,
    );
    await connected(socket);
    // The destination half-closed first; then the client sends and ends.
    expect((await readAll(socket)).byteLength).toBe(0);
    const failure = errorOf(socket);
    socket.end(randomBytes(64 * 1024));
    await waitFor(() => heldWrites.length === 1);
    await flushRelay();
    expect(socket.closed).toBe(false);

    // The held write fails: the writer gets a reset, not a clean close.
    heldWrites.splice(0)[0]?.(new Error('write EPIPE'));
    expect(await failure).toMatchObject({
      name: 'TunnelResetError',
      code: 'error',
    });
    const { tunnels } = current;
    await waitFor(() => tunnels.streamCount === 0);
  });

  it('reports a destination that closes with a write unfinished as a reset', async () => {
    current = await harness();
    fakeSockets.length = 0;
    const socket = current.tunnels.openStream(
      'localhost',
      PENDING_PORT,
      LOOPBACK,
    );
    await connected(socket);
    expect((await readAll(socket)).byteLength).toBe(0);
    const failure = errorOf(socket);
    // One chunk, so its write is the only one and nothing waits behind it.
    socket.end(randomBytes(16 * 1024));
    await waitFor(() => heldWrites.length === 1);
    const [destination] = fakeSockets;
    if (!destination) throw new Error('Nothing dialed.');

    // It closes without an error and without finishing the write.
    destination.destroy();
    expect(await failure).toMatchObject({
      name: 'TunnelResetError',
      code: 'error',
    });
  });

  it('resets a stream destroyed while its end still waits for credit', async () => {
    current = await harness();
    fakeSockets.length = 0;
    const { tunnels } = current;
    const socket = tunnels.openStream('localhost', PENDING_PORT, LOOPBACK);
    await connected(socket);
    expect((await readAll(socket)).byteLength).toBe(0);
    socket.end(randomBytes(16 * 1024));
    await waitFor(() => heldWrites.length === 1);
    const [destination] = fakeSockets;
    if (!destination) throw new Error('Nothing dialed.');

    // The far end half-closed and the client ended, but its bytes are not
    // credited yet: destroying the socket cancels the stream on both sides.
    socket.destroy();
    await waitFor(() => tunnels.streamCount === 0 && destination.destroyed);
  });

  it('copies received bytes, so a chunk holds only its own memory', async () => {
    const mux = new TunnelStreamMux({
      role: 'controller',
      transport: {
        notify: (): boolean => true,
        request: (): Promise<unknown> => Promise.resolve({ ok: true }),
      },
    });
    const socket = mux.openStream('localhost', 1, LOOPBACK);
    await connected(socket);
    // A chunk that is a view into a much larger decoded message.
    const message = new ArrayBuffer(MiB);
    mux.handleEvent(REMOTE_EVENTS.tunnelData, {
      streamId: socket.streamId,
      bytes: new Uint8Array(message, 1000, 16 * 1024),
    });
    const chunk: unknown = socket.read();
    if (!Buffer.isBuffer(chunk)) throw new Error('Nothing delivered.');
    expect(chunk.byteLength).toBe(16 * 1024);
    expect(chunk.buffer).not.toBe(message);
    expect(chunk.buffer.byteLength).toBeLessThan(MiB);
    mux.close();
  });

  it('destroys a destination still taking an upload when the session closes', async () => {
    current = await harness();
    fakeSockets.length = 0;
    const socket = current.tunnels.openStream(
      'localhost',
      PENDING_PORT,
      LOOPBACK,
    );
    await connected(socket);
    expect((await readAll(socket)).byteLength).toBe(0);
    const failure = errorOf(socket);
    socket.end(randomBytes(64 * 1024));
    await waitFor(() => heldWrites.length === 1);
    const [destination] = fakeSockets;
    if (!destination) throw new Error('Nothing dialed.');
    expect(destination.destroyed).toBe(false);

    current.host.end('disconnected');
    await flushRelay();
    expect(destination.destroyed).toBe(true);
    expect(await failure).toMatchObject({ name: 'TunnelClosedError' });
  });

  it('destroys the destination when a reset for its stream arrives late', async () => {
    // One destination never takes the upload, so its stream stays open. The
    // other takes it but does not close, so its stream completes and is
    // dropped first. A reset reaches the socket either way.
    for (const accepts of [false, true]) {
      const sent: string[] = [];
      const destination = new Duplex({
        autoDestroy: false,
        read(): void {
          this.push(null);
        },
        write: (_chunk, _encoding, done): void => {
          if (accepts) done();
        },
      });
      const host = new TunnelStreamMux({
        role: 'host',
        creditTickMs: 1,
        transport: {
          notify: (name): boolean => {
            sent.push(name);
            return true;
          },
          request: (): Promise<unknown> => Promise.resolve(null),
        },
        open: (): Promise<TunnelOpenDecision> =>
          Promise.resolve({ ok: true, socket: destination }),
      });
      await host.serveOpen({
        streamId: 1,
        host: 'localhost',
        port: 1,
        class: 'loopback',
      });
      host.handleEvent(REMOTE_EVENTS.tunnelData, {
        streamId: 1,
        bytes: new Uint8Array(10),
      });
      host.handleEvent(REMOTE_EVENTS.tunnelEnd, { streamId: 1 });
      await waitFor(() => sent.includes(REMOTE_EVENTS.tunnelEnd));
      await waitFor(() => host.streamCount === (accepts ? 0 : 1));
      expect(destination.destroyed).toBe(false);

      host.handleEvent(REMOTE_EVENTS.tunnelReset, {
        streamId: 1,
        code: 'cancelled',
      });
      expect(destination.destroyed).toBe(true);
      host.close();
    }
  });

  it('completes a sized read larger than the window', async () => {
    current = await harness();
    const port = await listen(echo);
    const socket = current.tunnels.openStream('localhost', port, LOOPBACK);
    // More than one window: the read waits for bytes still uncredited.
    const size = TUNNEL_INITIAL_WINDOW_BYTES + 1;
    socket.end(Buffer.alloc(size, 7));
    const whole = await new Promise<Buffer>((resolve) => {
      const take = (): void => {
        const chunk: unknown = socket.read(size);
        if (Buffer.isBuffer(chunk)) resolve(chunk);
        else socket.once('readable', take);
      };
      take();
    });
    expect(whole.byteLength).toBe(size);
    expect(whole.every((byte) => byte === 7)).toBe(true);
    expect((await readAll(socket)).byteLength).toBe(0);
  });

  it('refuses to decode, so credit always counts bytes', async () => {
    current = await harness();
    const port = await listen(echo);
    const socket = current.tunnels.openStream('localhost', port, LOOPBACK);
    expect(() => socket.setEncoding('utf8')).toThrow();
    socket.end();
    await readAll(socket);
  });

  it('stays out of idle timeout while one large write is still going out', async () => {
    current = await harness();
    const socket = current.tunnels.openStream('localhost', SLOW_PORT, LOOPBACK);
    await connected(socket);
    let timedOut = false;
    socket.setTimeout(1000, () => {
      timedOut = true;
    });
    // One write, sent a chunk at a time as the slow socket takes them, for
    // about 2 s: without its chunks counting as activity, it times out.
    await new Promise<void>((resolve, reject) =>
      socket.end(randomBytes(MiB), (error?: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
    expect(slowReceived).toBe(MiB);
    expect(timedOut).toBe(false);
    socket.setTimeout(0);
    socket.destroy();
  });
  it('keeps every invariant across randomized interleavings (fixed seeds)', async () => {
    const seeds = Array.from({ length: 50 }, (_, index) => 7919 * (index + 1));
    for (const seed of seeds) await runInterleaving(seed);
  });
});
