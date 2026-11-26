import { lookup } from 'node:dns/promises';
import { connect, type Socket } from 'node:net';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import {
  TUNNEL_MAX_STREAMS,
  type TunnelOpenFailureCode,
} from '@canopy/protocol/remote-control';
import {
  isReservedLoopbackPort,
  loopbackListenerOwner,
  type DialedConnection,
  type LoopbackListenerOwner,
} from '../../lib/loopback-listeners';
import type {
  TunnelOpenDecision,
  TunnelOpenHandler,
  TunnelOpenRequest,
} from '../tunnel/stream-mux';
import {
  loopbackCandidates,
  planDestination,
  type TunnelPolicyRefusal,
  type TunnelAddress,
} from './tunnel-policy';

/**
 * The host's dialer for one session's tunnel streams (CAN-7679,
 * docs/remote-control-protocol.md "Tunnel streams"). It answers each
 * `tunnel.open` with a socket connected to a loopback listener on this
 * computer, or a fixed refusal code:
 *
 * - Desktop controllers only, while the controller is still authorized and
 *   web preview is allowed (consent and flag), checked again once the dial
 *   connected.
 * - The destination policy in `tunnel-policy.ts`; a name is resolved once
 *   and the checked address is dialed, never the name.
 * - Never Canopy's own listeners: ports in the deny registry are refused
 *   before dialing, and after the dial connects the listener's owner is
 *   looked up before the open is answered. An owner that can't be
 *   determined is refused; on a platform with no lookup at all only the
 *   deny registry applies, and that is logged once.
 * - Limits per paired computer, shared by all of its sessions and kept
 *   across reconnects (`TunnelBudget`): streams, opens per second, and bytes
 *   per hour, past which every stream is reset and opens are refused until
 *   the hour ends.
 *
 * Logs carry ports, counts and fixed reasons only: never payloads, names or
 * addresses.
 */

export interface TunnelDialerLimits {
  /** Streams open or dialing at once, across the computer's sessions. */
  maxStreams: number;
  /** Opens a second, with the same burst. */
  opensPerSecond: number;
  /** Bytes both ways per budget window; past it every stream resets. */
  byteBudget: number;
  byteBudgetWindowMs: number;
  /** One open's lookup, dial and owner check together. */
  dialTimeoutMs: number;
}

export const DEFAULT_TUNNEL_DIALER_LIMITS: TunnelDialerLimits = {
  maxStreams: TUNNEL_MAX_STREAMS,
  opensPerSecond: 50,
  byteBudget: 2 * 1024 * 1024 * 1024,
  byteBudgetWindowMs: 60 * 60 * 1000,
  dialTimeoutMs: 10_000,
};

export interface TunnelDialerDeps {
  /** Every address a name resolves to on this computer. */
  lookup(name: string): Promise<TunnelAddress[]>;
  connect(address: TunnelAddress, port: number): Socket;
  isReservedPort(port: number): boolean;
  /**
   * Who holds the accepting side of `connection`, the dial's own.
   * `signal` stops the lookup.
   */
  listenerOwner(
    connection: DialedConnection,
    signal?: AbortSignal,
  ): Promise<LoopbackListenerOwner>;
  log(message: string, fields: Record<string, number | string>): void;
  now(): number;
}

export interface TunnelDialerOptions {
  /** The controller profile the session authorized. */
  kind: DeviceKind;
  /** Whether the controller may still control this computer. */
  isAuthorized(): boolean;
  /** Whether web preview is allowed now: consent and flag. */
  allowed(): boolean;
  /**
   * The paired computer's shared limits. Without one the dialer keeps its
   * own, made from `limits`.
   */
  budget?: TunnelBudget;
  limits?: Partial<TunnelDialerLimits>;
  deps?: Partial<TunnelDialerDeps>;
}

/**
 * Web preview's limits for one paired computer: every session it opens
 * shares them and they outlive reconnects, so more sessions or a reconnect
 * never buy more streams, opens or bytes.
 */
export class TunnelBudget {
  readonly limits: TunnelDialerLimits;
  /** Streams open or dialing across the computer's sessions. */
  streams = 0;
  private tokens: number;
  private tokensAt: number;
  private windowStart: number;
  private windowBytesValue = 0;

  constructor(
    limits: Partial<TunnelDialerLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_TUNNEL_DIALER_LIMITS, ...limits };
    this.tokens = this.limits.opensPerSecond;
    this.tokensAt = now();
    this.windowStart = now();
  }

  /** Bytes both ways in the current window. */
  get windowBytes(): number {
    this.roll();
    return this.windowBytesValue;
  }

  get exhausted(): boolean {
    return this.windowBytes >= this.limits.byteBudget;
  }

  addBytes(bytes: number): void {
    this.roll();
    this.windowBytesValue += bytes;
  }

  /** A token bucket refilled at `opensPerSecond`, with that burst. */
  takeOpenToken(): boolean {
    const now = this.now();
    const rate = this.limits.opensPerSecond;
    this.tokens = Math.min(
      rate,
      this.tokens + ((now - this.tokensAt) / 1000) * rate,
    );
    this.tokensAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private roll(): void {
    const now = this.now();
    if (now - this.windowStart < this.limits.byteBudgetWindowMs) return;
    this.windowStart = now;
    this.windowBytesValue = 0;
  }
}

/** Why an open was refused, for the log only. */
type RefusalReason =
  | 'closed'
  | 'not-desktop'
  | 'not-allowed'
  | 'not-authorized'
  | 'byte-budget'
  | 'open-rate'
  | 'stream-limit'
  | TunnelPolicyRefusal
  | 'reserved-port'
  | 'canopy-listener'
  | 'owner-unknown'
  | 'connect-refused'
  | 'connect-failed'
  | 'timeout'
  | 'cancelled';

/** An open's refusal: its public code, and the reason only logs see. */
class Refused extends Error {
  constructor(
    readonly code: TunnelOpenFailureCode,
    readonly reason: RefusalReason,
  ) {
    super(`Tunnel open refused: ${reason}`);
    this.name = 'Refused';
  }
}

type ConnectOutcome =
  | { kind: 'connected'; socket: Socket }
  | { kind: 'refused' | 'failed' | 'aborted' };

/** How often open sockets' byte counts are added to the budget. */
const BYTE_SAMPLE_MS = 1_000;

/**
 * The `localhost` lookup running now, shared by every open of every
 * session. A lookup can't be cancelled, so one an open gave up on still
 * holds that open's stream slot until it settles.
 */
let localhostLookup: Promise<TunnelAddress[]> | null = null;

/**
 * An open's hold on its stream slot, kept while work it started still runs,
 * such as a lookup it stopped waiting for.
 */
interface DialSlot {
  pending: Array<Promise<void>>;
}

const defaultDeps: TunnelDialerDeps = {
  lookup: async (name) =>
    (await lookup(name, { all: true, order: 'verbatim' })).flatMap(
      (entry): TunnelAddress[] =>
        entry.family === 4 || entry.family === 6
          ? [{ address: entry.address, family: entry.family }]
          : [],
    ),
  connect: (address, port) =>
    connect({
      host: address.address,
      port,
      family: address.family,
      // Each direction ends on its own: HTTP/1.0 bodies, Connection: close.
      allowHalfOpen: true,
    }),
  isReservedPort: isReservedLoopbackPort,
  listenerOwner: loopbackListenerOwner,
  log: () => undefined,
  now: () => Date.now(),
};

export class TunnelDialer {
  /** Plugs into `HostSessionOptions.tunnelOpen`. */
  readonly open: TunnelOpenHandler = (request, signal) =>
    this.serve(request, signal);

  private readonly limits: TunnelDialerLimits;
  private readonly deps: TunnelDialerDeps;
  private readonly budget: TunnelBudget;
  private readonly sockets = new Set<Socket>();
  /** Bytes of each open socket already added to the budget. */
  private readonly counted = new WeakMap<Socket, number>();
  private dialing = 0;
  private closed = false;
  /** Aborts every open still looking up, dialing or checking on close. */
  private readonly shutdown = new AbortController();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private ownerLookupUnavailableLogged = false;
  private totalBytes = 0;
  private streamsOpened = 0;

  constructor(private readonly options: TunnelDialerOptions) {
    this.limits = { ...DEFAULT_TUNNEL_DIALER_LIMITS, ...options.limits };
    this.deps = { ...defaultDeps, ...options.deps };
    this.budget =
      options.budget ?? new TunnelBudget(options.limits, () => this.deps.now());
  }

  /** Streams connected and not yet closed. */
  get openStreams(): number {
    return this.sockets.size;
  }

  /**
   * The session closed or preview was revoked: every socket is destroyed,
   * which resets its stream, and every later open is refused.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutdown.abort();
    this.stopSampling();
    for (const socket of Array.from(this.sockets)) socket.destroy();
    if (this.streamsOpened > 0) {
      this.deps.log('Remote web preview session ended', {
        streams: this.streamsOpened,
        bytes: this.totalBytes,
      });
    }
  }

  private async serve(
    request: TunnelOpenRequest,
    signal: AbortSignal,
  ): Promise<TunnelOpenDecision> {
    try {
      this.admit(request);
      this.dialing += 1;
      this.budget.streams += 1;
      const release = (): void => {
        this.dialing -= 1;
        this.budget.streams -= 1;
      };
      const slot: DialSlot = { pending: [] };
      try {
        return await this.dial(request, signal, slot);
      } finally {
        if (slot.pending.length === 0) release();
        else void Promise.all(slot.pending).then(release);
      }
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      // Cancelled opens are the controller's own doing; nothing to report.
      if (error.reason !== 'cancelled') {
        this.deps.log('Remote web preview stream refused', {
          port: request.port,
          code: error.code,
          reason: error.reason,
        });
      }
      return { ok: false, code: error.code };
    }
  }

  /** Checks that need no lookup or dial, in a fixed order. */
  private admit(request: TunnelOpenRequest): void {
    if (this.closed) throw new Refused('unavailable', 'closed');
    if (this.options.kind !== 'desktop')
      throw new Refused('policy', 'not-desktop');
    if (!this.options.isAuthorized())
      throw new Refused('unavailable', 'not-authorized');
    if (!this.options.allowed())
      throw new Refused('unavailable', 'not-allowed');
    if (this.budget.exhausted) throw new Refused('limit', 'byte-budget');
    if (!this.budget.takeOpenToken()) throw new Refused('limit', 'open-rate');
    if (this.budget.streams >= this.budget.limits.maxStreams)
      throw new Refused('limit', 'stream-limit');
    if (request.class !== 'loopback') throw new Refused('policy', 'lan-class');
    if (this.deps.isReservedPort(request.port))
      throw new Refused('policy', 'reserved-port');
  }

  private async dial(
    request: TunnelOpenRequest,
    cancelled: AbortSignal,
    slot: DialSlot,
  ): Promise<TunnelOpenDecision> {
    const timeout = AbortSignal.timeout(this.limits.dialTimeoutMs);
    const signal = AbortSignal.any([cancelled, timeout, this.shutdown.signal]);
    const stopped = (): Refused =>
      this.closed
        ? new Refused('unavailable', 'closed')
        : cancelled.aborted
          ? new Refused('unavailable', 'cancelled')
          : new Refused('unreachable', 'timeout');
    const candidates = await this.candidates(request, signal, stopped, slot);
    let sawRefusal = false;
    let socket: Socket | null = null;
    for (const candidate of candidates) {
      const outcome = await this.connectOnce(candidate, request.port, signal);
      if (outcome.kind === 'connected') {
        socket = outcome.socket;
        break;
      }
      if (outcome.kind === 'aborted') throw stopped();
      if (outcome.kind === 'refused') sawRefusal = true;
    }
    if (socket === null) {
      throw sawRefusal
        ? new Refused('refused', 'connect-refused')
        : new Refused('unreachable', 'connect-failed');
    }
    try {
      const connection = dialedConnection(socket, request.port);
      // A socket without its addresses has already closed.
      if (connection === null)
        throw new Refused('unreachable', 'connect-failed');
      await this.checkOwner(connection, signal, stopped, slot);
      // The listener may have reset the connection meanwhile.
      if (socket.destroyed) throw new Refused('unreachable', 'connect-failed');
      // Anything may have changed while the dial and lookup ran, including
      // the budget, which other streams spend meanwhile.
      if (this.closed) throw new Refused('unavailable', 'closed');
      if (!this.options.isAuthorized())
        throw new Refused('unavailable', 'not-authorized');
      if (!this.options.allowed())
        throw new Refused('unavailable', 'not-allowed');
      this.countBytes();
      if (this.budget.exhausted) throw new Refused('limit', 'byte-budget');
    } catch (error) {
      socket.destroy();
      throw error;
    }
    this.track(socket);
    return { ok: true, socket };
  }

  /** The addresses to try, in order; only `localhost` is looked up. */
  private async candidates(
    request: TunnelOpenRequest,
    signal: AbortSignal,
    stopped: () => Refused,
    slot: DialSlot,
  ): Promise<readonly TunnelAddress[]> {
    const plan = planDestination(request);
    if (plan.kind === 'refuse') throw new Refused('policy', plan.reason);
    if (plan.kind === 'dial') return plan.candidates;
    let answers: TunnelAddress[] = [];
    try {
      answers = await abortable(this.lookUpLocalhost(slot), signal);
    } catch {
      if (signal.aborted) throw stopped();
      // Without an answer, `localhost` still means loopback: both
      // families are tried.
    }
    return loopbackCandidates(answers);
  }

  /**
   * The one `localhost` lookup, shared with opens already waiting on it.
   * The open's slot stays taken until the lookup itself settles, even when
   * the open was cancelled or timed out first.
   */
  private lookUpLocalhost(slot: DialSlot): Promise<TunnelAddress[]> {
    let lookup = localhostLookup;
    if (lookup === null) {
      const started = this.deps.lookup('localhost');
      lookup = started;
      localhostLookup = started;
      const forget = (): void => {
        if (localhostLookup === started) localhostLookup = null;
      };
      started.then(forget, forget);
    }
    slot.pending.push(settled(lookup));
    return lookup;
  }

  private connectOnce(
    address: TunnelAddress,
    port: number,
    signal: AbortSignal,
  ): Promise<ConnectOutcome> {
    if (signal.aborted) return Promise.resolve({ kind: 'aborted' });
    return new Promise((resolve) => {
      const socket = this.deps.connect(address, port);
      const settle = (outcome: ConnectOutcome): void => {
        signal.removeEventListener('abort', abort);
        socket.off('connect', connected);
        socket.off('error', failed);
        resolve(outcome);
      };
      const abort = (): void => {
        socket.destroy();
        settle({ kind: 'aborted' });
      };
      const connected = (): void => {
        // The stream's splice handles errors once it owns the socket. Until
        // then, through the owner check, an error must not reach main's
        // uncaught handler; the socket is destroyed and its stream resets.
        socket.on('error', () => socket.destroy());
        settle({ kind: 'connected', socket });
      };
      const failed = (error: NodeJS.ErrnoException): void => {
        socket.destroy();
        settle({ kind: error.code === 'ECONNREFUSED' ? 'refused' : 'failed' });
      };
      signal.addEventListener('abort', abort, { once: true });
      socket.once('connect', connected);
      socket.once('error', failed);
    });
  }

  /**
   * Refuses a connection Canopy accepted, told by its own accepting socket
   * through the dial's local port, or one whose owner can't be told. The
   * socket stays connected and unread meanwhile, so nothing is forwarded
   * before the answer.
   */
  private async checkOwner(
    connection: DialedConnection,
    signal: AbortSignal,
    stopped: () => Refused,
    slot: DialSlot,
  ): Promise<void> {
    const { port } = connection;
    let owner: LoopbackListenerOwner;
    try {
      // Aborting stops the lookup's work; the slot waits for it to stop.
      const lookup = this.deps.listenerOwner(connection, signal);
      slot.pending.push(settled(lookup));
      owner = await abortable(lookup, signal);
    } catch {
      if (signal.aborted) throw stopped();
      owner = 'unknown';
    }
    if (owner === 'canopy') throw new Refused('policy', 'canopy-listener');
    if (owner === 'unknown') throw new Refused('policy', 'owner-unknown');
    if (owner === 'unavailable' && !this.ownerLookupUnavailableLogged) {
      this.ownerLookupUnavailableLogged = true;
      this.deps.log(
        'Remote web preview cannot look up listener owners here; only reserved ports are refused',
        { port },
      );
    }
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    this.counted.set(socket, 0);
    this.streamsOpened += 1;
    this.budget.streams += 1;
    socket.once('close', () => {
      this.sample(socket);
      this.sockets.delete(socket);
      this.budget.streams -= 1;
      if (this.sockets.size === 0) this.stopSampling();
    });
    if (this.sampleTimer === null) {
      this.sampleTimer = setInterval(() => this.sampleAll(), BYTE_SAMPLE_MS);
      this.sampleTimer.unref?.();
    }
  }

  private stopSampling(): void {
    if (this.sampleTimer !== null) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  /** Adds a socket's new bytes, both ways, to the budget. */
  private sample(socket: Socket): void {
    const total = socket.bytesRead + socket.bytesWritten;
    const added = total - (this.counted.get(socket) ?? total);
    this.counted.set(socket, total);
    if (added <= 0) return;
    this.budget.addBytes(added);
    this.totalBytes += added;
  }

  /** Adds every open socket's new bytes to the budget. */
  private countBytes(): void {
    for (const socket of Array.from(this.sockets)) this.sample(socket);
  }

  /**
   * The sampler's tick: count, and reset this session's streams once the
   * computer's budget is spent. Its other sessions reset on their own ticks.
   */
  private sampleAll(): void {
    this.countBytes();
    // A stream outlives no revocation by more than a tick: authorization
    // or consent gone resets every stream.
    if (!this.options.isAuthorized() || !this.options.allowed()) {
      this.deps.log('Remote web preview no longer allowed; streams reset', {
        streams: this.sockets.size,
      });
      for (const socket of Array.from(this.sockets)) socket.destroy();
      return;
    }
    if (!this.budget.exhausted) return;
    this.deps.log('Remote web preview byte budget reached; streams reset', {
      bytes: this.budget.windowBytes,
      streams: this.sockets.size,
    });
    for (const socket of Array.from(this.sockets)) socket.destroy();
  }
}

/** `promise`, rejected early when `signal` aborts. */
/** The connection `socket` made to loopback `port`, or null once closed. */
function dialedConnection(
  socket: Socket,
  port: number,
): DialedConnection | null {
  const { remoteAddress, localAddress, localPort } = socket;
  if (
    remoteAddress === undefined ||
    localAddress === undefined ||
    localPort === undefined
  )
    return null;
  return {
    address: remoteAddress,
    port,
    peerAddress: localAddress,
    peerPort: localPort,
  };
}

function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error('failed'));
      },
    );
  });
}
