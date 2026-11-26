import { toAppError } from '@canopy/protocol/app-errors';
import { randomBytes } from 'node:crypto';
import {
  decodeDeviceRelayDataFrame,
  encodeDeviceRelayDataFrame,
  parseDeviceRelayClientMessage,
  type DeviceRelayDeviceInfo,
  type DeviceRelayServerMessage,
  type DeviceRelayTokenResponse,
} from '@canopy/protocol/device-relay';
import {
  HelloParamsSchema,
  HelloResultSchema,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TRANSPORT_RESUME_VERSION,
} from '@canopy/protocol/remote-control';
import {
  generateDeviceKeyPair,
  type DeviceKeyPair,
} from '../../crypto/device-key';
import { decodeEnvelope } from '../envelope';
import { serialize } from 'node:v8';
import {
  SYNC_CODEC_BYTES,
  zlibMessageCompressor,
  type MessageCompressor,
} from '../message-codec';
import {
  RelayClient,
  type RelayClientDiagnostic,
  type RelaySocketFactory,
  type RelaySocketHandlers,
} from '../relay-client';
import { RpcPeer } from '../rpc-peer';
import {
  RemoteSessionManager,
  type RelayTransport,
  type SecureSession,
  type SessionCloseReason,
  type SessionGrant,
  type SessionState,
} from '../session-manager';

/**
 * Session resume across relay drops, over the real handshake, secure
 * channel, session manager and RPC peer. The relay here loses every frame in
 * flight when either side's socket drops, as a relay restart does.
 */

type Listener = (peer: string) => void;

interface InFlight {
  from: string;
  to: string;
  payload: Buffer;
  fromLink: number;
  toLink: number;
}

class TestRelay {
  readonly endpoints = new Map<string, TestEndpoint>();
  private readonly links = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  endpoint(deviceId: string): TestEndpoint {
    const endpoint = new TestEndpoint(deviceId, this);
    this.endpoints.set(deviceId, endpoint);
    return endpoint;
  }

  isConnected(deviceId: string): boolean {
    return (this.links.get(deviceId) ?? 0) > 0;
  }

  /** The device's socket opens and the relay says ready. */
  connect(deviceId: string): void {
    const link = Math.abs(this.links.get(deviceId) ?? 0) + 1;
    this.links.set(deviceId, link);
    const self = this.endpoints.get(deviceId);
    for (const [peer, endpoint] of this.endpoints) {
      if (peer === deviceId || !this.isConnected(peer)) continue;
      this.later(() => self?.emitOnline(peer));
      this.later(() => endpoint.emitOnline(deviceId));
    }
  }

  /**
   * The relay announces the device again without it going offline, as it
   * does for a replaced connection or a settings update.
   */
  announce(deviceId: string): void {
    for (const [peer, endpoint] of this.endpoints) {
      if (peer !== deviceId && this.isConnected(peer)) {
        this.later(() => endpoint.emitOnline(deviceId));
      }
    }
  }

  /** The device's socket closes; everything in flight to or from it is lost. */
  drop(deviceId: string): void {
    this.links.set(deviceId, -Math.abs(this.links.get(deviceId) ?? 0));
    const self = this.endpoints.get(deviceId);
    for (const [peer, endpoint] of this.endpoints) {
      if (peer === deviceId) continue;
      // The device drops its own peers; the relay tells the others.
      self?.emitOffline(peer);
      if (this.isConnected(peer))
        this.later(() => endpoint.emitOffline(deviceId));
    }
  }

  send(frame: InFlight): boolean {
    if (!this.isConnected(frame.from)) return false;
    if (!this.isConnected(frame.to)) {
      this.later(() =>
        this.endpoints.get(frame.from)?.emitUndeliverable(frame.to),
      );
      return true;
    }
    this.later(() => {
      if (
        this.links.get(frame.from) !== frame.fromLink ||
        this.links.get(frame.to) !== frame.toLink
      ) {
        return;
      }
      this.endpoints.get(frame.to)?.deliver(frame.from, frame.payload);
    });
    return true;
  }

  link(deviceId: string): number {
    return this.links.get(deviceId) ?? 0;
  }

  private later(run: () => void): void {
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            run();
            resolve();
          });
        }),
    );
  }

  async settle(): Promise<void> {
    for (let round = 0; round < 50; round += 1) {
      await this.queue;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

class TestEndpoint implements RelayTransport {
  private readonly frames = new Set<(peer: string, payload: Buffer) => void>();
  private readonly offline = new Set<Listener>();
  private readonly online = new Set<Listener>();
  private readonly undeliverable = new Set<Listener>();
  /** Envelope types sent, in order. */
  readonly sentTypes: string[] = [];
  /** Data frames to refuse while connected, as a full relay queue does. */
  refuseData = 0;
  /** Runs after each frame is handed to the relay. */
  afterSend: ((type: string | undefined) => void) | null = null;
  /** Every resume1 sent, so a test can deliver one again later. */
  readonly sentResume1: Buffer[] = [];

  constructor(
    readonly deviceId: string,
    private readonly relay: TestRelay,
  ) {}

  sendFrame(peer: string, payload: Uint8Array): boolean {
    const bytes = Buffer.from(payload);
    const type = decodeEnvelope(bytes)?.type;
    if (type === 'data' && this.refuseData > 0) {
      this.refuseData -= 1;
      return false;
    }
    if (type) this.sentTypes.push(type);
    if (type === 'resume1') this.sentResume1.push(bytes);
    const sent = this.relay.send({
      from: this.deviceId,
      to: peer,
      payload: bytes,
      fromLink: this.relay.link(this.deviceId),
      toLink: this.relay.link(peer),
    });
    this.afterSend?.(type);
    return sent;
  }

  onFrame(listener: (peer: string, payload: Buffer) => void): () => void {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onPeerOffline(listener: Listener): () => void {
    this.offline.add(listener);
    return () => this.offline.delete(listener);
  }

  onPeerOnline(listener: Listener): () => void {
    this.online.add(listener);
    return () => this.online.delete(listener);
  }

  onUndeliverable(listener: Listener): () => void {
    this.undeliverable.add(listener);
    return () => this.undeliverable.delete(listener);
  }

  deliver(from: string, payload: Buffer): void {
    for (const listener of Array.from(this.frames)) listener(from, payload);
  }

  emitOffline(peer: string): void {
    for (const listener of Array.from(this.offline)) listener(peer);
  }

  emitOnline(peer: string): void {
    for (const listener of Array.from(this.online)) listener(peer);
  }

  emitUndeliverable(peer: string): void {
    for (const listener of Array.from(this.undeliverable)) listener(peer);
  }

  count(type: string): number {
    return this.sentTypes.filter((sent) => sent === type).length;
  }
}

const GRANT: SessionGrant = {
  kind: 'desktop',
  kindAuthenticated: true,
  rootDeviceId: null,
  expiresAt: null,
};

interface Side {
  identity: DeviceKeyPair;
  endpoint: TestEndpoint;
  manager: RemoteSessionManager;
  incoming: SecureSession[];
  allowed: boolean;
}

interface Pair {
  relay: TestRelay;
  controller: Side;
  host: Side;
}

const managers: RemoteSessionManager[] = [];
const peers: RpcPeer[] = [];

afterEach(() => {
  jest.useRealTimers();
  for (const peer of peers.splice(0)) peer.close();
  for (const manager of managers.splice(0)) manager.dispose();
});

function side(
  relay: TestRelay,
  identity: DeviceKeyPair,
  compressor?: MessageCompressor,
  chains: { sendChainBytes?: number } = {},
): Side {
  const endpoint = relay.endpoint(identity.deviceId);
  const created: Side = {
    identity,
    endpoint,
    incoming: [],
    allowed: true,
    manager: new RemoteSessionManager({
      transport: endpoint,
      identity: () => identity,
      authorize: () => (created.allowed ? GRANT : null),
      onIncomingSession: (session) => created.incoming.push(session),
      resumeDeadlineMs: { initiator: 1_500, responder: 2_000 },
      resumeRetryMs: 50,
      ...(compressor ? { compressor } : {}),
      ...chains,
    }),
  };
  managers.push(created.manager);
  return created;
}

function pair(
  compressors: {
    controller?: MessageCompressor;
    host?: MessageCompressor;
    sendChainBytes?: number;
  } = {},
): Pair {
  const relay = new TestRelay();
  const controller = side(
    relay,
    generateDeviceKeyPair(),
    compressors.controller,
    {
      ...(compressors.sendChainBytes === undefined
        ? {}
        : { sendChainBytes: compressors.sendChainBytes }),
    },
  );
  const host = side(relay, generateDeviceKeyPair(), compressors.host);
  relay.connect(controller.identity.deviceId);
  relay.connect(host.identity.deviceId);
  return { relay, controller, host };
}

/** Restarts the host process: a new manager under the same identity. */
function restartHost(env: Pair): void {
  env.host.manager.dispose();
  env.relay.drop(env.host.identity.deviceId);
  env.host = side(env.relay, env.host.identity);
  env.relay.connect(env.host.identity.deviceId);
}

interface Connected {
  controllerSession: SecureSession;
  hostSession: SecureSession;
  controllerRpc: RpcPeer;
  hostRpc: RpcPeer;
  /** Events each side received, in order. */
  atController: unknown[];
  atHost: unknown[];
  controllerStates: SessionState[];
  closes: { controller: SessionCloseReason[]; host: SessionCloseReason[] };
}

/** What {@link connect} needs from either test relay. */
interface Ends {
  relay: { settle(): Promise<void> };
  controller: { manager: RemoteSessionManager };
  host: { identity: DeviceKeyPair; incoming: SecureSession[] };
}

async function connect(
  env: Ends,
  options: { resume?: { controller: boolean; host: boolean } } = {},
): Promise<Connected> {
  const resume = options.resume ?? { controller: true, host: true };
  const controllerSession = await env.controller.manager.connect({
    peerDeviceId: env.host.identity.deviceId,
    purpose: 'control',
    pinnedPeerPublicKey: env.host.identity.publicKey,
  });
  await env.relay.settle();
  const hostSession = env.host.incoming.at(-1);
  if (!hostSession) throw new Error('The host did not accept the session.');
  // What the hello negotiates: resume only when both offer it.
  const negotiated = resume.controller && resume.host;
  hostSession.setResumeNegotiated(negotiated);
  controllerSession.setResumeNegotiated(negotiated);
  const atController: unknown[] = [];
  const atHost: unknown[] = [];
  const controllerRpc = new RpcPeer(controllerSession, {
    onRequest: (): Promise<unknown> => Promise.resolve(null),
    onEvent: (name, payload): void => {
      if (name === 'seq') atController.push(payload);
    },
  });
  const hostRpc = new RpcPeer(hostSession, {
    onRequest: (method, params): Promise<unknown> => {
      if (method === 'upload' && params instanceof Uint8Array) {
        return Promise.resolve(params.byteLength);
      }
      return Promise.resolve(params);
    },
    onEvent: (name, payload): void => {
      if (name === 'seq') atHost.push(payload);
    },
  });
  peers.push(controllerRpc, hostRpc);
  const controllerStates: SessionState[] = [];
  controllerSession.onStateChange((state) => controllerStates.push(state));
  const closes: Connected['closes'] = { controller: [], host: [] };
  controllerSession.onClose((reason) => closes.controller.push(reason));
  hostSession.onClose((reason) => closes.host.push(reason));
  return {
    controllerSession,
    hostSession,
    controllerRpc,
    hostRpc,
    atController,
    atHost,
    controllerStates,
    closes,
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, index) => from + index);
}

async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** Opens every waiting zlib gate until `check` passes, within a deadline. */
async function openGatesUntil(
  gates: Array<() => void>,
  check: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
    for (const open of gates.splice(0)) open();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function send(rpc: RpcPeer, numbers: number[]): void {
  for (const number of numbers) rpc.notify('seq', number);
}

describe('session resume negotiation', () => {
  it('is an optional hello field that older peers strip and the version ignores', () => {
    const version = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      appVersion: '1.0.0',
    };
    const offer = {
      version,
      transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION },
    };
    expect(HelloParamsSchema.parse(offer)).toEqual(offer);
    expect(HelloParamsSchema.parse({ version })).toEqual({ version });
    const answer = HelloResultSchema.parse({
      name: 'Host',
      platform: 'darwin',
      appVersion: '1.0.0',
      version,
      transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION },
    });
    expect(answer.transport).toEqual({ resume: 1 });
    expect(REMOTE_TRANSPORT_RESUME_VERSION).toBe(1);
  });
});

describe('session resume across relay drops', () => {
  it('resumes after both sides drop, with no loss or duplication and no new handshake', async () => {
    const env = pair();
    const link = await connect(env);
    send(link.controllerRpc, range(0, 50));
    send(link.hostRpc, range(0, 50));
    // A relay restart: every frame still in flight is lost.
    env.relay.drop(env.controller.identity.deviceId);
    env.relay.drop(env.host.identity.deviceId);
    expect(link.controllerSession.state).toBe('suspended');
    expect(link.hostSession.state).toBe('suspended');
    // Sent while suspended: sealed and held.
    send(link.controllerRpc, range(50, 100));
    send(link.hostRpc, range(50, 100));
    await env.relay.settle();
    expect(link.atHost.length).toBeLessThan(100);
    env.relay.connect(env.host.identity.deviceId);
    env.relay.connect(env.controller.identity.deviceId);
    await waitFor(
      () => link.atHost.length === 100 && link.atController.length === 100,
      'every message after the resume',
    );
    await env.relay.settle();
    expect(link.atHost).toEqual(range(0, 100));
    expect(link.atController).toEqual(range(0, 100));
    expect(link.controllerSession.state).toBe('active');
    expect(link.hostSession.state).toBe('active');
    expect(link.closes).toEqual({ controller: [], host: [] });
    expect(link.controllerStates).toContain('resuming');
    expect(link.controllerStates.at(-1)).toBe('active');
    expect(env.controller.endpoint.count('hello1')).toBe(1);
    expect(env.controller.endpoint.count('resume1')).toBeGreaterThan(0);
    expect(env.host.endpoint.count('resume2')).toBeGreaterThan(0);
    // RPC still works over the same session.
    await expect(link.controllerRpc.request('echo', 'after')).resolves.toBe(
      'after',
    );
  });

  it('resumes a drop on one side only, in either direction', async () => {
    const env = pair();
    const link = await connect(env);
    send(link.hostRpc, range(0, 30));
    env.relay.drop(env.host.identity.deviceId);
    send(link.hostRpc, range(30, 60));
    await env.relay.settle();
    expect(link.controllerSession.state).toBe('suspended');
    env.relay.connect(env.host.identity.deviceId);
    await waitFor(() => link.atController.length === 60, 'host drop resumed');

    send(link.controllerRpc, range(0, 30));
    env.relay.drop(env.controller.identity.deviceId);
    send(link.controllerRpc, range(30, 60));
    await env.relay.settle();
    expect(link.hostSession.state).toBe('suspended');
    env.relay.connect(env.controller.identity.deviceId);
    await waitFor(() => link.atHost.length === 60, 'controller drop resumed');
    await env.relay.settle();
    expect(link.atController).toEqual(range(0, 60));
    expect(link.atHost).toEqual(range(0, 60));
    expect(link.closes).toEqual({ controller: [], host: [] });
    expect(env.controller.endpoint.count('hello1')).toBe(1);
  });

  it('keeps a session open when a resume retry arrives after acks superseded it', async () => {
    const env = pair();
    const link = await connect(env);
    env.relay.announce(env.host.identity.deviceId);
    await env.relay.settle();
    const stale = env.controller.endpoint.sentResume1.at(-1);
    if (!stale) throw new Error('The controller did not ask to resume.');
    // The host sends more, and the controller's acks release it all.
    send(link.hostRpc, range(0, 20));
    await waitFor(() => link.atController.length === 20, 'the stream');
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    await env.relay.settle();
    // A retry sent before those acks arrives only now.
    env.host.endpoint.deliver(env.controller.identity.deviceId, stale);
    await env.relay.settle();
    send(link.hostRpc, range(20, 30));
    await waitFor(() => link.atController.length === 30, 'later messages');
    await env.relay.settle();
    expect(link.atController).toEqual(range(0, 30));
    expect(link.closes).toEqual({ controller: [], host: [] });
  });

  it('drops frames re-sent after a resume of a live session as duplicates', async () => {
    const env = pair();
    const link = await connect(env);
    env.relay.announce(env.host.identity.deviceId);
    // In flight when the controller asks to resume, so the host sends them
    // again from the counter the controller had then.
    send(link.hostRpc, range(0, 40));
    await waitFor(() => link.atController.length >= 40, 'the stream');
    await env.relay.settle();
    expect(env.controller.endpoint.count('resume1')).toBeGreaterThan(0);
    expect(link.controllerStates.at(-1)).toBe('active');
    send(link.hostRpc, range(40, 50));
    await waitFor(() => link.atController.length === 50, 'later messages');
    await env.relay.settle();
    expect(link.atController).toEqual(range(0, 50));
    expect(link.closes).toEqual({ controller: [], host: [] });
  });

  it('keeps an overflowed host session open when the relay re-announces the host', async () => {
    const env = pair();
    const link = await connect(env);
    link.hostRpc.notify('big', randomBytes(20 * 1024 * 1024));
    // Sealed, and so held, once deflate on the thread pool finishes.
    await waitFor(() => !link.hostSession.resumable, 'the buffer to overflow');
    expect(link.hostSession.isClosed).toBe(false);
    env.relay.announce(env.host.identity.deviceId);
    send(link.hostRpc, range(0, 5));
    await waitFor(() => link.atController.length === 5, 'the stream');
    await env.relay.settle();
    expect(env.controller.endpoint.count('resume1')).toBeGreaterThan(0);
    expect(link.controllerSession.state).toBe('active');
    expect(link.closes).toEqual({ controller: [], host: [] });
  });

  it('delivers an ending sent while suspended once the controller resumes', async () => {
    const env = pair();
    const link = await connect(env);
    env.relay.drop(env.controller.identity.deviceId);
    await env.relay.settle();
    // The host ends the session on purpose while the controller is away.
    link.hostRpc.notify('seq', 'ended');
    link.hostRpc.close('revoked');
    expect(link.closes.host).toEqual(['revoked']);
    env.relay.connect(env.controller.identity.deviceId);
    await waitFor(
      () => link.closes.controller.length > 0,
      'the controller to receive the ending',
    );
    expect(link.atController).toEqual(['ended']);
    expect(link.closes.controller).toEqual(['peer_closed']);
  });

  it('keeps a held ending until it arrives, when the link drops again mid-delivery', async () => {
    const env = pair();
    const link = await connect(env);
    const controllerId = env.controller.identity.deviceId;
    env.relay.drop(controllerId);
    await env.relay.settle();
    link.hostRpc.notify('seq', 'ended');
    link.hostRpc.close('revoked');
    // The host's answer and re-sent frames are accepted by the relay, then
    // lost when the controller's socket drops before they arrive.
    env.host.endpoint.afterSend = (type): void => {
      if (type !== 'resume2') return;
      env.host.endpoint.afterSend = null;
      env.relay.drop(controllerId);
    };
    env.relay.connect(controllerId);
    await waitFor(
      () => env.host.endpoint.count('resume2') > 0,
      'the first resume',
    );
    await env.relay.settle();
    expect(link.closes.controller).toEqual([]);
    env.relay.connect(controllerId);
    await waitFor(
      () => link.closes.controller.length > 0,
      'the ending on the second resume',
    );
    expect(link.atController).toEqual(['ended']);
    expect(link.closes.controller).toEqual(['peer_closed']);
  });

  it('holds request deadlines while suspended', async () => {
    const env = pair();
    const link = await connect(env);
    // The hold runs on a fake clock. The controller retries resume every
    // 50 ms here, which makes it `resuming` until the relay answers that
    // the host is unreachable, so a real-time sleep would land on either
    // state. The relay's own delivery stays on real setImmediate.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    env.relay.drop(env.host.identity.deviceId);
    await env.relay.settle();
    // The request is sent once the controller knows the host dropped, so its
    // deadline never starts before the hold.
    expect(link.controllerSession.state).toBe('suspended');
    // Shorter than the 50 ms resume retry: a deadline started while
    // suspended would fire before the first retry's `resuming` pauses it.
    const answer = link.controllerRpc.request('echo', 'held', {
      timeoutMs: 40,
    });
    let settled = false;
    // Also handles a rejection, so a failure below cannot leave one to
    // surface in a later test when the peers close.
    const markSettled = (): void => {
      settled = true;
    };
    void answer.then(markSettled, markSettled);
    // Many deadlines' worth of hold, inside the controller's 1.5 s resume
    // deadline, retrying resume all the while.
    await jest.advanceTimersByTimeAsync(1_000);
    await env.relay.settle();
    expect(env.controller.endpoint.count('resume1')).toBeGreaterThan(1);
    expect(settled).toBe(false);
    expect(link.controllerSession.state).toBe('suspended');
    env.relay.connect(env.host.identity.deviceId);
    await env.relay.settle();
    // Resumed with no clock advance, so a broken resume fails here rather
    // than at the test timeout. The deadline's budget after a resume is not
    // exercised: the fake clock stays still until the answer arrives.
    expect(link.controllerSession.state).toBe('active');
    await expect(answer).resolves.toBe('held');
  });

  it('closes a host session whose relay queue refuses a frame, so the controller falls back', async () => {
    const env = pair();
    const link = await connect(env);
    env.host.endpoint.refuseData = 1;
    link.hostRpc.notify('seq', 1);
    expect(link.closes.host).toEqual(['transport_error']);
    await waitFor(
      () => link.closes.controller.length > 0,
      'the controller to learn of it',
    );
    expect(link.closes.controller).toEqual(['peer_closed']);
  });

  it('falls back to a new handshake when the host restarted', async () => {
    const env = pair();
    const link = await connect(env);
    restartHost(env);
    await waitFor(
      () => link.closes.controller.length > 0,
      'the controller to learn the session is gone',
    );
    // The new host answers resume1 with unknown_session.
    expect(link.closes.controller).toEqual(['peer_closed']);
    const again = await connect(env);
    await expect(again.controllerRpc.request('echo', 'new')).resolves.toBe(
      'new',
    );
    expect(env.controller.endpoint.count('hello1')).toBe(2);
  });

  it('keeps today’s close on a drop when the peer did not negotiate resume', async () => {
    const env = pair();
    const link = await connect(env, {
      resume: { controller: true, host: false },
    });
    env.relay.drop(env.host.identity.deviceId);
    await env.relay.settle();
    expect(link.closes.controller).toEqual(['peer_offline']);
    expect(link.closes.host).toEqual(['peer_offline']);
    expect(env.controller.endpoint.count('resume1')).toBe(0);
  });

  it('sends a 32 MiB upload over a healthy link, and re-arms resume once acks catch up', async () => {
    const env = pair();
    const link = await connect(env);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const bytes = randomBytes(32 * 1024 * 1024);
    const upload = link.controllerRpc.request('upload', bytes, {
      timeoutMs: null,
    });
    // More in flight than the resend buffer holds: not resumable for now,
    // yet the session stays open. It is sealed once deflate on the thread
    // pool finishes; setImmediate is not faked.
    const overflowBy = Date.now() + 10_000;
    while (link.controllerSession.resumable) {
      if (Date.now() > overflowBy)
        throw new Error('The buffer never overflowed.');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(link.controllerSession.isClosed).toBe(false);
    await expect(upload).resolves.toBe(bytes.byteLength);
    const pending: Array<() => boolean> = [];
    const sendFrame = env.host.endpoint.sendFrame.bind(env.host.endpoint);
    const held = jest
      .spyOn(env.host.endpoint, 'sendFrame')
      .mockImplementation((peer, payload) => {
        pending.push(() => sendFrame(peer, payload));
        return true;
      });
    // The controller acknowledges the response before the host's final
    // upload ack arrives. Lose that controller ack so resume must replay it.
    const lost = jest
      .spyOn(env.controller.endpoint, 'sendFrame')
      .mockReturnValue(true);
    await jest.advanceTimersByTimeAsync(250);
    await env.relay.settle();
    expect(pending.length).toBeGreaterThan(0);
    expect(lost).toHaveBeenCalled();
    held.mockRestore();
    lost.mockRestore();
    for (const send of pending) send();
    await env.relay.settle();
    jest.useRealTimers();
    await waitFor(
      () => link.controllerSession.resumable,
      'acks to cover everything sent',
      15_000,
    );
    expect(link.closes).toEqual({ controller: [], host: [] });
    send(link.controllerRpc, range(0, 10));
    env.relay.drop(env.host.identity.deviceId);
    env.relay.connect(env.host.identity.deviceId);
    await waitFor(() => link.atHost.length === 10, 'resume after re-arming');
    expect(link.atHost).toEqual(range(0, 10));
    expect(link.closes).toEqual({ controller: [], host: [] });
  }, 20_000);

  it('falls back when the link drops while the resend buffer is overflowed', async () => {
    const env = pair();
    const link = await connect(env);
    link.controllerRpc.notify('big', randomBytes(20 * 1024 * 1024));
    await waitFor(
      () => !link.controllerSession.resumable,
      'the buffer to overflow',
    );
    expect(link.controllerSession.isClosed).toBe(false);
    env.relay.drop(env.controller.identity.deviceId);
    expect(link.closes.controller).toEqual(['peer_offline']);
    env.relay.connect(env.controller.identity.deviceId);
    await env.relay.settle();
    expect(link.hostSession.state).toBe('suspended');
    // The controller's new handshake ends the host's suspended session.
    const again = await connect(env);
    expect(link.closes.host).toEqual(['peer_offline']);
    await expect(again.controllerRpc.request('echo', 'fresh')).resolves.toBe(
      'fresh',
    );
  });

  it('closes and falls back when sends while suspended pass the cap', async () => {
    const env = pair();
    const link = await connect(env);
    env.relay.drop(env.host.identity.deviceId);
    await env.relay.settle();
    expect(link.controllerSession.state).toBe('suspended');
    link.controllerRpc.notify('big', randomBytes(20 * 1024 * 1024));
    // Sealed while suspended once deflate on the thread pool finishes.
    await waitFor(() => link.closes.controller.length > 0, 'the close');
    expect(link.closes.controller).toEqual(['transport_error']);
  });

  it('refuses a resume after the controller was revoked while suspended', async () => {
    const env = pair();
    const link = await connect(env);
    env.relay.drop(env.controller.identity.deviceId);
    await env.relay.settle();
    env.host.allowed = false;
    env.relay.connect(env.controller.identity.deviceId);
    await waitFor(
      () => link.closes.controller.length > 0,
      'the controller to be refused',
    );
    expect(link.closes.host).toEqual(['revoked']);
    expect(link.closes.controller).toEqual(['peer_closed']);
  });

  it('closes a suspended session at its deadline', async () => {
    const env = pair();
    const link = await connect(env);
    env.relay.drop(env.host.identity.deviceId);
    await waitFor(
      () => link.closes.controller.length > 0,
      'the controller deadline',
    );
    expect(link.closes.controller).toEqual(['peer_offline']);
  });
});

interface SocketConnection {
  handlers: RelaySocketHandlers;
  device: DeviceRelayDeviceInfo | null;
  openedAt: number;
  open: boolean;
}

/**
 * A relay that speaks the device-relay wire protocol to real relay clients
 * over in-memory sockets. Every `ready` advertises a maximum connection age,
 * as the deployed relay does from its load balancer's timeout.
 */
class SocketRelay {
  private readonly registered = new Map<string, SocketConnection>();
  private readonly hellos = new Map<string, number>();
  /** How old each connection was when its client closed it. */
  readonly clientClosedAges: number[] = [];
  bufferedAmount = 0;

  constructor(private readonly maxConnectionAgeMs: number) {}

  readonly createSocket: RelaySocketFactory = (_url, _protocols, handlers) => {
    const connection: SocketConnection = {
      handlers,
      device: null,
      openedAt: Date.now(),
      open: true,
    };
    setImmediate(() => {
      if (connection.open) handlers.onOpen();
    });
    const getBufferedAmount = (): number => this.bufferedAmount;
    return {
      get bufferedAmount(): number {
        return getBufferedAmount();
      },
      transmit: (data): void => this.receive(connection, data),
      close: (): void => this.close(connection),
    };
  };

  /** How many times the device has said hello: its connection count. */
  connections(deviceId: string): number {
    return this.hellos.get(deviceId) ?? 0;
  }

  async settle(): Promise<void> {
    for (let round = 0; round < 50; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private receive(
    connection: SocketConnection,
    data: string | Uint8Array<ArrayBuffer>,
  ): void {
    if (!connection.open) return;
    if (typeof data === 'string') {
      const message = parseDeviceRelayClientMessage(data);
      if (message?.type === 'ping') {
        this.text(connection, { type: 'pong', sentAt: message.sentAt });
      }
      if (message?.type !== 'hello') return;
      const device = message.device;
      connection.device = device;
      const others = Array.from(this.registered.values());
      this.registered.set(device.deviceId, connection);
      this.hellos.set(device.deviceId, this.connections(device.deviceId) + 1);
      this.text(connection, {
        type: 'ready',
        deviceId: device.deviceId,
        peers: others.flatMap((other) => (other.device ? [other.device] : [])),
        maxConnectionAgeMs: this.maxConnectionAgeMs,
      });
      for (const other of others) {
        this.text(other, { type: 'peer.online', peer: device });
      }
      return;
    }
    const frame = decodeDeviceRelayDataFrame(data);
    const from = connection.device;
    if (!frame || !from) return;
    const target = this.registered.get(frame.deviceId);
    if (!target) {
      this.text(connection, {
        type: 'undeliverable',
        deviceId: frame.deviceId,
      });
      return;
    }
    const forwarded = encodeDeviceRelayDataFrame(from.deviceId, frame.payload);
    setImmediate(() => {
      if (target.open) target.handlers.onBinary(forwarded);
    });
  }

  private close(connection: SocketConnection): void {
    if (!connection.open) return;
    connection.open = false;
    this.clientClosedAges.push(Date.now() - connection.openedAt);
    const deviceId = connection.device?.deviceId;
    if (
      deviceId !== undefined &&
      this.registered.get(deviceId) === connection
    ) {
      this.registered.delete(deviceId);
      for (const other of this.registered.values()) {
        this.text(other, { type: 'peer.offline', deviceId });
      }
    }
    // A normal close, as the WebSocket reports one the client asked for.
    setImmediate(() => connection.handlers.onClose(1000, '', true));
  }

  private text(
    connection: SocketConnection,
    message: DeviceRelayServerMessage,
  ): void {
    setImmediate(() => {
      if (connection.open) connection.handlers.onText(JSON.stringify(message));
    });
  }
}

/**
 * Deflate of messages over 32 KiB runs on the thread pool (CAN-7764). These
 * hold the session's ordering rules (see `SecureSession`) with real zlib,
 * slowed per message so that a later small message would overtake a large
 * one if the send chain did not keep order.
 */
describe('ordered compression off main', () => {
  const LARGE_TEXT = 'a line of build output for the transcript page\n'.repeat(
    40_000,
  );

  function large(n: number): { n: number; text: string } {
    return { n, text: `${n}:${LARGE_TEXT}` };
  }

  function order(values: unknown[]): number[] {
    return values.map((value) =>
      typeof value === 'number'
        ? value
        : typeof value === 'object' &&
            value !== null &&
            'n' in value &&
            typeof value.n === 'number'
          ? value.n
          : -1,
    );
  }

  /**
   * Real zlib, held back: messages under 8 KiB skip it, so they would pass
   * every compressed message ahead of them if the send chain did not keep order.
   */
  function slowZlib(delayMs: number): MessageCompressor {
    const wait = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      deflate: async (serialized) => {
        await wait();
        return zlibMessageCompressor.deflate(serialized);
      },
    };
  }

  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
  });
  /** Gates of every gated zlib, opened after each test, failed or not. */
  const allGates: Array<Array<() => void>> = [];
  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    for (const gates of allGates.splice(0)) {
      for (const open of gates.splice(0)) open();
    }
  });

  function sendMixed(rpc: RpcPeer, count: number): void {
    for (let n = 0; n < count; n += 1) {
      const kind = n % 3;
      const payload =
        kind === 0
          ? large(n)
          : kind === 1
            ? { n, text: 'x'.repeat(20_000) }
            : n;
      rpc.notify('seq', payload);
    }
  }

  it('delivers mixed sizes in the order they were sent, in both directions', async () => {
    const env = pair({ controller: slowZlib(30), host: slowZlib(30) });
    const link = await connect(env);
    sendMixed(link.controllerRpc, 12);
    sendMixed(link.hostRpc, 12);
    await waitFor(
      () => link.atHost.length === 12 && link.atController.length === 12,
      'every message',
    );
    expect(order(link.atHost)).toEqual(range(0, 12));
    expect(order(link.atController)).toEqual(range(0, 12));
    expect(link.closes).toEqual({ controller: [], host: [] });
    expect(rejections).toEqual([]);
  });

  it('keeps order across a drop and resume while a large message is still deflating', async () => {
    const env = pair({ controller: slowZlib(60), host: slowZlib(60) });
    const link = await connect(env);
    link.controllerRpc.notify('seq', large(0));
    send(link.controllerRpc, range(1, 4));
    link.hostRpc.notify('seq', large(0));
    send(link.hostRpc, range(1, 4));
    // Both drop before either large message is sealed.
    env.relay.drop(env.host.identity.deviceId);
    env.relay.drop(env.controller.identity.deviceId);
    await env.relay.settle();
    send(link.controllerRpc, range(4, 6));
    send(link.hostRpc, range(4, 6));
    env.relay.connect(env.controller.identity.deviceId);
    env.relay.connect(env.host.identity.deviceId);
    await waitFor(
      () => link.atHost.length >= 6 && link.atController.length >= 6,
      'the resumed sessions',
    );
    await env.relay.settle();
    expect(order(link.atHost)).toEqual(range(0, 6));
    expect(order(link.atController)).toEqual(range(0, 6));
    expect(link.closes).toEqual({ controller: [], host: [] });
    expect(rejections).toEqual([]);
  });

  it('still sends what it accepted before an RPC close, in order and ahead of the close', async () => {
    const env = pair({ controller: slowZlib(200) });
    const link = await connect(env);
    // Accepted while still deflating, then the RPC peer closes: they leave,
    // compressed, before the close, and nothing more is accepted.
    link.controllerRpc.notify('seq', large(0));
    link.controllerRpc.notify('seq', 1);
    link.controllerRpc.close();
    expect(link.controllerRpc.notify('seq', 2)).toBe(false);
    await waitFor(() => link.closes.host.length > 0, 'the host to close');
    expect(link.closes.controller).toEqual(['closed']);
    expect(order(link.atHost)).toEqual([0, 1]);
    expect(link.closes.host).toEqual(['peer_closed']);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(rejections).toEqual([]);
  });

  it('drops what a revocation finds unsealed, and still delivers its ending', async () => {
    const env = pair({ host: slowZlib(200) });
    const link = await connect(env);
    link.hostRpc.notify('seq', large(0));
    link.hostRpc.notify('seq', 1);
    // As the host's end() does: nothing accepted before the ending and not
    // yet sealed may leave after it.
    link.hostSession.discardUnsent();
    link.hostRpc.notify('seq', 2);
    link.hostRpc.close('revoked');
    await waitFor(() => link.closes.controller.length > 0, 'the close');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(order(link.atController)).toEqual([2]);
    expect(link.closes.controller).toEqual(['peer_closed']);
    expect(rejections).toEqual([]);
  });

  it('still sends a small reply queued behind a deflate when a revocation drops the rest', async () => {
    const env = pair({ host: slowZlib(300) });
    const link = await connect(env);
    link.hostRpc.notify('seq', large(0));
    const queued = link.hostSession.heldBytes;
    const reply = link.controllerRpc.request('echo', 'revoked: true');
    // A file's contents, say: too large to keep past a revocation.
    const contents = link.controllerRpc.request('echo', 'f'.repeat(40_000));
    // The host answers while the large push ahead of it still deflates.
    await waitFor(
      () => link.hostSession.heldBytes > queued + 40_000,
      'the replies to queue',
    );
    link.hostSession.discardUnsent();
    link.hostRpc.notify('seq', 1);
    link.hostRpc.close('revoked');
    await expect(reply).resolves.toBe('revoked: true');
    await expect(contents).rejects.toThrow();
    await waitFor(() => link.closes.controller.length > 0, 'the close');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(order(link.atController)).toEqual([1]);
    expect(link.closes.controller).toEqual(['peer_closed']);
  });

  it('lets an explicit end replace a close still waiting for a deflate', async () => {
    const env = pair({ host: slowZlib(200) });
    const link = await connect(env);
    link.hostRpc.notify('seq', large(0));
    link.hostRpc.close();
    // As the host's end() does while that close still drains.
    link.hostSession.discardUnsent();
    expect(link.hostRpc.notify('seq', 1)).toBe(true);
    link.hostRpc.close('revoked');
    await waitFor(() => link.closes.controller.length > 0, 'the close');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(order(link.atController)).toEqual([1]);
    expect(link.closes.host).toEqual(['revoked']);
  });

  it('hands over what is still queued when the session manager shuts down, deflated', async () => {
    const env = pair({ host: slowZlib(200) });
    const link = await connect(env);
    link.hostRpc.notify('seq', large(0));
    // Behind it: a deflated mid-sized message and a small one.
    link.hostRpc.notify('seq', { n: 1, text: 'm'.repeat(20_000) });
    link.hostRpc.notify('seq', 2);
    const sent: number[] = [];
    const sendFrame = env.host.endpoint.sendFrame.bind(env.host.endpoint);
    jest
      .spyOn(env.host.endpoint, 'sendFrame')
      .mockImplementation((peer, payload) => {
        sent.push(payload.byteLength);
        return sendFrame(peer, payload);
      });
    // Turning incoming control off disposes the manager while that deflates.
    env.host.manager.dispose();
    expect(link.closes.host).toEqual(['shutdown']);
    // The large one, not deflated yet, is dropped rather than sent raw, so
    // what follows it (an ending, here the last message) cannot be stranded
    // behind megabytes in the relay socket; the rest goes deflated.
    expect(sent.reduce((total, bytes) => total + bytes, 0)).toBeLessThan(
      64 * 1024,
    );
    await waitFor(() => link.closes.controller.length > 0, 'the close');
    expect(order(link.atController)).toEqual([1, 2]);
    expect(link.closes.controller).toEqual(['peer_closed']);
  });

  it('reports a session as ending from the moment its close starts draining', async () => {
    const env = pair({ host: slowZlib(200) });
    const link = await connect(env);
    expect(link.hostSession.isEnding).toBe(false);
    link.hostRpc.notify('seq', large(0));
    link.hostRpc.close();
    // Still sending its last messages, but no longer serving its controller.
    expect(link.hostSession.isClosed).toBe(false);
    expect(link.hostSession.isEnding).toBe(true);
    await waitFor(() => link.closes.host.length > 0, 'the close');
    expect(link.hostSession.isEnding).toBe(true);
  });

  it('lets a suspended host close after a large message deflates, and delivers both on resume', async () => {
    const env = pair({ host: slowZlib(100) });
    const link = await connect(env);
    env.relay.drop(env.controller.identity.deviceId);
    await env.relay.settle();
    expect(link.hostSession.state).toBe('suspended');
    // 24 MiB serialized, more than the 16 MiB re-send buffer, but small
    // once deflated: the host holds it, as it did when deflate was
    // synchronous, instead of failing the linger.
    link.hostRpc.notify('seq', { n: 0, text: 'c'.repeat(24 * 1024 * 1024) });
    link.hostRpc.notify('seq', 1);
    link.hostRpc.close();
    await waitFor(() => link.closes.host.length > 0, 'the host to close');
    expect(link.closes.host).toEqual(['closed']);
    expect(link.hostSession.isLingering).toBe(true);
    env.relay.connect(env.controller.identity.deviceId);
    await waitFor(() => link.closes.controller.length > 0, 'the ending');
    expect(order(link.atController)).toEqual([0, 1]);
    expect(link.closes.controller).toEqual(['peer_closed']);
    expect(rejections).toEqual([]);
  });

  /** Real zlib that waits for `open` per call, counting calls in flight. */
  function gatedZlib(): {
    compressor: MessageCompressor;
    gates: Array<() => void>;
    stats: { running: number; most: number };
  } {
    const gates: Array<() => void> = [];
    allGates.push(gates);
    const stats = { running: 0, most: 0 };
    const gated = <T>(work: () => Promise<T>): Promise<T> => {
      stats.running += 1;
      stats.most = Math.max(stats.most, stats.running);
      return new Promise<T>((resolve, reject) => {
        gates.push(() => {
          work().then(resolve, reject);
        });
      }).finally(() => {
        stats.running -= 1;
      });
    };
    return {
      gates,
      stats,
      compressor: {
        deflate: (serialized) =>
          gated(() => zlibMessageCompressor.deflate(serialized)),
      },
    };
  }

  const MIB = 1024 * 1024;
  const SEVEN_MIB = 'b'.repeat(7 * MIB);

  it('counts messages still deflating as held, and runs one deflate per session at a time', async () => {
    const { compressor, gates, stats } = gatedZlib();
    const env = pair({ controller: compressor });
    const link = await connect(env);
    link.controllerRpc.notify('seq', { n: 0, text: SEVEN_MIB });
    link.controllerRpc.notify('seq', 1);
    link.controllerRpc.notify('seq', { n: 2, text: SEVEN_MIB });
    send(link.controllerRpc, [3]);
    // Waiting to be sealed counts against the senders that hold back.
    expect(link.controllerSession.heldBytes).toBeGreaterThan(14 * MIB);
    expect(gates).toHaveLength(1);
    await openGatesUntil(gates, () => link.atHost.length >= 4, 'every message');
    expect(order(link.atHost)).toEqual(range(0, 4));
    expect(stats.most).toBe(1);
    expect(link.closes).toEqual({ controller: [], host: [] });
    expect(rejections).toEqual([]);
  });

  it('ends the session, sending nothing uncompressed, once the send chain is full', async () => {
    const { compressor, gates } = gatedZlib();
    const env = pair({ controller: compressor, sendChainBytes: 20 * MIB });
    const link = await connect(env);
    link.controllerRpc.notify('seq', { n: 0, text: SEVEN_MIB });
    link.controllerRpc.notify('seq', { n: 1, text: SEVEN_MIB });
    expect(link.controllerRpc.notify('seq', { n: 2, text: SEVEN_MIB })).toBe(
      false,
    );
    expect(link.closes.controller).toEqual(['transport_error']);
    for (const open of gates.splice(0)) open();
    await waitFor(() => link.closes.host.length > 0, 'the host to close');
    await env.relay.settle();
    expect(link.atHost).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it('shares the send chain limit across a manager’s sessions', async () => {
    const { compressor, gates } = gatedZlib();
    const env = pair({ controller: compressor, sendChainBytes: 20 * MIB });
    const first = await connect(env);
    const second = await connect(env);
    first.controllerRpc.notify('seq', { n: 0, text: SEVEN_MIB });
    first.controllerRpc.notify('seq', { n: 1, text: SEVEN_MIB });
    // Within its own share, but past what the two sessions may hold together.
    expect(second.controllerRpc.notify('seq', { n: 0, text: SEVEN_MIB })).toBe(
      false,
    );
    expect(second.closes.controller).toEqual(['transport_error']);
    expect(first.closes.controller).toEqual([]);
    await openGatesUntil(
      gates,
      () => first.atHost.length >= 2,
      'the first session’s messages',
    );
    expect(order(first.atHost)).toEqual([0, 1]);
    // Its bytes are released once sealed, so a new send fits again.
    expect(first.controllerRpc.notify('seq', { n: 2, text: SEVEN_MIB })).toBe(
      true,
    );
    await openGatesUntil(gates, () => first.atHost.length >= 3, 'the next');
    expect(rejections).toEqual([]);
  });

  it('keeps a closed session’s running deflate charged until it settles', async () => {
    const { compressor, gates, stats } = gatedZlib();
    const env = pair({ controller: compressor, sendChainBytes: 20 * MIB });
    const first = await connect(env);
    const second = await connect(env);
    first.controllerRpc.notify('seq', { n: 0, text: SEVEN_MIB });
    expect(gates).toHaveLength(1);
    // Its message is dropped, but the deflate still holds its 7 MiB.
    first.controllerSession.close('closed');
    second.controllerRpc.notify('seq', { n: 0, text: SEVEN_MIB });
    expect(second.controllerRpc.notify('seq', { n: 1, text: SEVEN_MIB })).toBe(
      false,
    );
    expect(second.closes.controller).toEqual(['transport_error']);
    // Once both deflates settle, their bytes are free again.
    expect(gates).toHaveLength(2);
    for (const open of gates.splice(0)) open();
    await waitFor(() => stats.running === 0, 'both deflates to settle');
    await env.relay.settle();
    const third = await connect(env);
    third.controllerRpc.notify('seq', { n: 0, text: SEVEN_MIB });
    expect(third.controllerRpc.notify('seq', { n: 1, text: SEVEN_MIB })).toBe(
      true,
    );
    await openGatesUntil(gates, () => third.atHost.length >= 2, 'the third');
    expect(order(third.atHost)).toEqual([0, 1]);
    expect(rejections).toEqual([]);
  });

  it('still sends a small message at once when other sessions fill the send limit', async () => {
    const { compressor, gates } = gatedZlib();
    const env = pair({
      controller: compressor,
      sendChainBytes: 7 * MIB + 10 * 1024,
    });
    const first = await connect(env);
    const second = await connect(env);
    // Fills the shared limit to within 10 KiB while it deflates.
    first.controllerRpc.notify('seq', sized(7 * MIB, 0));
    expect(gates).toHaveLength(1);
    // Deflated on main and sealed at once: never held, so never refused.
    expect(second.controllerRpc.notify('seq', sized(20_000, 0))).toBe(true);
    await waitFor(() => second.atHost.length === 1, 'the small message');
    expect(second.closes.controller).toEqual([]);
    await openGatesUntil(gates, () => first.atHost.length === 1, 'the large');
    expect(first.closes.controller).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it('seals an ending at once after a revocation empties a batched send chain', async () => {
    const host = gatedZlib();
    const env = pair({ host: host.compressor });
    const link = await connect(env);
    link.hostRpc.notify('seq', large(0));
    send(link.hostRpc, range(1, 1_000));
    await waitFor(() => host.gates.length > 0, 'the host deflate');
    // Right after the first batch, with its continuation pending: as the
    // host revokes, it drops what is queued and sends its ending.
    let frames = 0;
    let endingSealedAtOnce: boolean | null = null;
    env.host.endpoint.afterSend = (type): void => {
      if (type !== 'data') return;
      frames += 1;
      if (frames !== 1) return;
      queueMicrotask(() => {
        link.hostSession.discardUnsent();
        const before = frames;
        link.hostRpc.notify('seq', 5_000);
        endingSealedAtOnce = frames > before;
      });
    };
    for (const open of host.gates.splice(0)) open();
    await waitFor(() => endingSealedAtOnce !== null, 'the ending');
    env.host.endpoint.afterSend = null;
    expect(endingSealedAtOnce).toBe(true);
    await waitFor(
      () => order(link.atController).includes(5_000),
      'the ending to arrive',
    );
    const received = order(link.atController);
    expect(received.at(-1)).toBe(5_000);
    expect(received.length).toBeLessThan(1_001);
    expect(rejections).toEqual([]);
  });

  it('deflates messages up to 32 KiB on main, so a stalled thread pool delays none of them', async () => {
    const stalled: MessageCompressor = {
      deflate: () => new Promise<Buffer | null>(() => undefined),
    };
    const env = pair({ controller: stalled, host: stalled });
    const link = await connect(env);
    for (let n = 0; n < 5; n += 1) {
      // About 20 KiB serialized, compressed on the wire.
      link.controllerRpc.notify('seq', { n, text: `${n}`.repeat(20_000) });
      link.hostRpc.notify('seq', { n, text: `${n}`.repeat(20_000) });
    }
    await waitFor(
      () => link.atHost.length === 5 && link.atController.length === 5,
      'every message',
    );
    expect(order(link.atHost)).toEqual(range(0, 5));
    expect(order(link.atController)).toEqual(range(0, 5));
  });

  /** A `seq` payload whose RPC event serializes to exactly `bytes`. */
  function sized(bytes: number, n: number): { n: number; text: string } {
    let length = bytes;
    for (;;) {
      const payload = { n, text: 'y'.repeat(length) };
      const actual = serialize({
        kind: 'event',
        name: 'seq',
        payload,
      }).byteLength;
      if (actual === bytes) return payload;
      length += bytes - actual;
    }
  }

  it('deflates messages up to 32 KiB on main and gives larger ones to the thread pool, both ways', async () => {
    const calls = { deflate: 0 };
    const counting: MessageCompressor = {
      deflate: (serialized) => {
        calls.deflate += 1;
        return zlibMessageCompressor.deflate(serialized);
      },
    };
    const env = pair({ controller: counting, host: counting });
    const link = await connect(env);
    link.controllerRpc.notify('seq', sized(SYNC_CODEC_BYTES, 0));
    link.hostRpc.notify('seq', sized(SYNC_CODEC_BYTES, 0));
    await waitFor(
      () => link.atHost.length === 1 && link.atController.length === 1,
      'the messages at the bound',
    );
    expect(calls).toEqual({ deflate: 0 });
    link.controllerRpc.notify('seq', sized(SYNC_CODEC_BYTES + 1, 1));
    link.hostRpc.notify('seq', sized(SYNC_CODEC_BYTES + 1, 1));
    await waitFor(
      () => link.atHost.length === 2 && link.atController.length === 2,
      'the messages past the bound',
    );
    expect(calls).toEqual({ deflate: 2 });
    expect(order(link.atHost)).toEqual([0, 1]);
    expect(order(link.atController)).toEqual([0, 1]);
  });

  it('still reads acks while an RPC close waits for a deflate', async () => {
    const { compressor, gates } = gatedZlib();
    const env = pair({ host: compressor });
    const link = await connect(env);
    // Sealed and held until the controller acknowledges them.
    send(link.hostRpc, range(0, 20));
    link.hostRpc.notify('seq', large(20));
    link.hostRpc.close();
    const held = link.hostSession.heldBytes;
    // The controller acknowledges within its 250 ms cadence.
    await waitFor(
      () => link.hostSession.heldBytes < held,
      'the ack to free held frames',
    );
    for (const open of gates.splice(0)) open();
    await waitFor(() => link.closes.controller.length > 0, 'the close');
    expect(order(link.atController)).toEqual(range(0, 21));
    expect(link.closes.host).toEqual(['closed']);
  });

  it('seals a backlog freed by one deflate in order, over several turns', async () => {
    const host = gatedZlib();
    const env = pair({ host: host.compressor });
    const link = await connect(env);
    link.hostRpc.notify('seq', large(0));
    send(link.hostRpc, range(1, 2_001));
    await waitFor(() => host.gates.length > 0, 'the host deflate');
    // Counts frames handed to the relay before main's next turn.
    let frames = 0;
    let firstTurn = -1;
    env.host.endpoint.afterSend = (type): void => {
      if (type !== 'data') return;
      frames += 1;
      if (frames === 1) {
        setImmediate(() => {
          firstTurn = frames;
        });
      }
    };
    for (const open of host.gates.splice(0)) open();
    await waitFor(() => link.atController.length >= 2_001, 'every message');
    env.host.endpoint.afterSend = null;
    expect(order(link.atController)).toEqual(range(0, 2_001));
    expect(firstTurn).toBeGreaterThan(0);
    expect(firstTurn).toBeLessThan(2_001);
    expect(link.closes).toEqual({ controller: [], host: [] });
    expect(rejections).toEqual([]);
  });
});

describe('socket-backed relay sessions', () => {
  const clients: RelayClient[] = [];
  const diagnostics: RelayClientDiagnostic[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.stop();
    diagnostics.length = 0;
  });

  /**
   * Waits on the fake clock, so the relay's ages and the clients' rotation
   * timers read the same time and a timer cannot fire a millisecond early.
   */
  async function advanceUntil(
    relay: SocketRelay,
    check: () => boolean,
    label: string,
    timeoutMs = 4_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
      await jest.advanceTimersByTimeAsync(5);
      await relay.settle();
    }
  }

  function rotatingSide(
    relay: SocketRelay,
    identity: DeviceKeyPair,
    name: string,
    maxQueuedBytes?: number,
  ): Ends['host'] & { manager: RemoteSessionManager; client: RelayClient } {
    const client = new RelayClient({
      fetchToken: (): Promise<DeviceRelayTokenResponse> =>
        Promise.resolve({
          token: 'token',
          relayUrl: 'wss://relay.test',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      deviceInfo: (): DeviceRelayDeviceInfo => ({
        deviceId: identity.deviceId,
        name,
        platform: 'darwin',
        appVersion: '1.0.0',
        publicKey: identity.publicKey,
        acceptsRemoteControl: true,
      }),
      createSocket: relay.createSocket,
      onDiagnostic: (diagnostic): void => {
        diagnostics.push(diagnostic);
      },
      minConnectionAgeMs: 0,
      maxQueuedBytes,
    });
    clients.push(client);
    const incoming: SecureSession[] = [];
    const manager = new RemoteSessionManager({
      transport: client,
      identity: (): DeviceKeyPair => identity,
      authorize: (): SessionGrant => GRANT,
      onIncomingSession: (session): void => {
        incoming.push(session);
      },
      resumeDeadlineMs: { initiator: 1_500, responder: 2_000 },
      resumeRetryMs: 50,
    });
    managers.push(manager);
    client.start();
    return { identity, manager, incoming, client };
  }

  it.each([
    { reason: 'disconnected', code: 'external.offline' },
    { reason: 'queue-full', code: 'app.unexpected' },
  ])(
    'classifies a $reason relay send during remote-control:invoke',
    async ({ reason, code }) => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const relay = new SocketRelay(600_000);
      const controller = rotatingSide(
        relay,
        generateDeviceKeyPair(),
        'Controller',
        1,
      );
      const peer = generateDeviceKeyPair();
      await advanceUntil(
        relay,
        () => controller.client.connectionStatus === 'connected',
        'controller ready',
      );

      if (reason === 'disconnected') {
        controller.client.stop();
      } else {
        relay.bufferedAmount = 16 * 1024 * 1024;
        expect(controller.client.connectionStatus).toBe('connected');
      }

      await expect(
        controller.manager
          .connect({
            peerDeviceId: peer.deviceId,
            purpose: 'control',
            pinnedPeerPublicKey: peer.publicKey,
          })
          .catch((error: unknown) => toAppError(error)),
      ).resolves.toMatchObject({ code });
      expect(
        controller.client.sendFrame(peer.deviceId, Buffer.from('test')),
      ).toBe(false);
      expect(
        controller.client.sendFrame(peer.deviceId, Buffer.from('test'), {
          includeFailureReason: true,
        }),
      ).toBe(reason);
    },
  );

  it('reconnects before the advertised maximum age, and sessions resume with no loss', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const maxConnectionAgeMs = 2_000;
    const relay = new SocketRelay(maxConnectionAgeMs);
    const controller = rotatingSide(
      relay,
      generateDeviceKeyPair(),
      'Controller',
    );
    const host = rotatingSide(relay, generateDeviceKeyPair(), 'Host');
    await advanceUntil(
      relay,
      () =>
        relay.connections(controller.identity.deviceId) === 1 &&
        relay.connections(host.identity.deviceId) === 1,
      'both devices on the relay',
    );
    await relay.settle();
    const link = await connect({ relay, controller, host });
    // Messages flow both ways the whole time either side rotates.
    let sent = 0;
    const pump = setInterval(() => {
      send(link.controllerRpc, [sent]);
      send(link.hostRpc, [sent]);
      sent += 1;
    }, 10);
    try {
      await advanceUntil(
        relay,
        () =>
          relay.connections(controller.identity.deviceId) === 2 &&
          relay.connections(host.identity.deviceId) === 2,
        'both devices to rotate',
        maxConnectionAgeMs * 2,
      );
      await advanceUntil(
        relay,
        () =>
          link.controllerSession.state === 'active' &&
          link.hostSession.state === 'active',
        'both sessions to resume',
      );
    } finally {
      clearInterval(pump);
    }
    await advanceUntil(
      relay,
      () => link.atHost.length === sent && link.atController.length === sent,
      'every message after the rotation',
    );
    await relay.settle();
    expect(link.atHost).toEqual(range(0, sent));
    expect(link.atController).toEqual(range(0, sent));
    // The rotation suspended the session and resumed it: no new handshake.
    expect(link.controllerStates).toContain('suspended');
    expect(link.controllerStates.at(-1)).toBe('active');
    expect(link.closes).toEqual({ controller: [], host: [] });
    expect(controller.incoming).toEqual([]);
    expect(host.incoming).toEqual([link.hostSession]);
    // Each client closed its own connection in the last 5% of its lifetime,
    // before the balancer would have.
    expect(relay.clientClosedAges).toHaveLength(2);
    for (const age of relay.clientClosedAges) {
      expect(age).toBeGreaterThanOrEqual(maxConnectionAgeMs * 0.95);
      expect(age).toBeLessThan(maxConnectionAgeMs);
    }
    // Diagnostics tell each rotation apart from a drop.
    const closes = diagnostics.flatMap((diagnostic) =>
      diagnostic.type === 'closed' ? [diagnostic] : [],
    );
    expect(closes.map((close) => [close.cause, close.phase])).toEqual([
      ['rotation', 'ready'],
      ['rotation', 'ready'],
    ]);
    await expect(link.controllerRpc.request('echo', 'after')).resolves.toBe(
      'after',
    );
  });
});
