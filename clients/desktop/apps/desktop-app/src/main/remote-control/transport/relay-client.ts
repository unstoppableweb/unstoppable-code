import {
  DEVICE_RELAY_CLOSE_CODES,
  DEVICE_RELAY_CONNECT_PATH,
  DEVICE_RELAY_ERROR_CODES,
  DEVICE_RELAY_SHUTDOWN_REASON,
  decodeDeviceRelayDataFrame,
  deviceRelaySubprotocols,
  encodeDeviceRelayDataFrame,
  parseDeviceRelayServerMessage,
  type DeviceRelayClientMessage,
  type DeviceRelayDeviceInfo,
  type DeviceRelayErrorCode,
  type DeviceRelayTokenResponse,
} from '@canopy/protocol/device-relay';
import { MAX_MESSAGE_BYTES } from './message-codec';
import type {
  RelayFrameSendFailure,
  RelayFrameSendOptions,
  RelayTransport,
} from './session-manager';

/** The relay connection as the remote-control service uses it. */
export interface RemoteRelay extends RelayTransport {
  readonly connectionStatus: RelayConnectionStatus;
  readonly peers: ReadonlyArray<DeviceRelayDeviceInfo>;
  /**
   * Features the relay advertised in its last `ready`, empty while not
   * connected. `device-kind` means presence kinds are token-authenticated.
   */
  readonly features: ReadonlyArray<string>;
  start(): void;
  stop(): void;
  announce(): void;
  /**
   * Drops the current connection and connects again at once, for when the
   * network may have changed under it (wake from sleep, network change).
   */
  reconnectNow(): void;
}

/** The socket surface the relay client needs; tests supply a fake. */
export interface RelaySocket {
  readonly bufferedAmount: number;
  transmit(data: string | Uint8Array<ArrayBuffer>): void;
  close(): void;
}

export interface RelaySocketHandlers {
  onOpen(): void;
  onText(text: string): void;
  onBinary(bytes: Uint8Array): void;
  /**
   * The socket closed: its WebSocket close code, the close reason and whether
   * the close handshake completed.
   */
  onClose(code: number, reason: string, wasClean: boolean): void;
}

/**
 * Opens a socket to `url` offering `protocols`, which carry the relay token
 * (the relay authenticates before the upgrade).
 */
export type RelaySocketFactory = (
  url: string,
  protocols: string[],
  handlers: RelaySocketHandlers,
) => RelaySocket;

export const createWebSocketRelaySocket: RelaySocketFactory = (
  url,
  protocols,
  handlers,
) => {
  const socket = new WebSocket(url, protocols);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    const { data } = event;
    if (typeof data === 'string') {
      handlers.onText(data);
    } else if (data instanceof ArrayBuffer) {
      handlers.onBinary(new Uint8Array(data));
    }
  });
  socket.addEventListener('close', (event) =>
    handlers.onClose(event.code, event.reason, event.wasClean),
  );
  socket.addEventListener('error', () => {
    // A close event always follows; reconnect is driven from there.
  });
  return {
    get bufferedAmount(): number {
      return socket.bufferedAmount;
    },
    transmit: (data) => socket.send(data),
    close: () => socket.close(),
  };
};

export type RelayConnectionStatus =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unavailable';

/**
 * What ended a relay connection: the socket closing (`socket`, with the
 * relay's or the network's close code), or this client giving up on it.
 */
export type RelayCloseCause =
  | 'socket'
  | 'missed_pings'
  | 'ready_timeout'
  | 'reconnect_now'
  | 'rotation'
  | 'stopped';

/**
 * How far a connection got: the socket was being opened, it was open but
 * the relay had not said `ready`, or it was ready.
 */
export type RelayConnectionPhase = 'connecting' | 'open' | 'ready';

/**
 * One relay connection event, for diagnostics. Durations and counts only;
 * never a token, device ID, URL or close reason text.
 */
export type RelayClientDiagnostic =
  | {
      type: 'closed';
      cause: RelayCloseCause;
      /** The WebSocket close code, or null when this client gave up. */
      code: number | null;
      wasClean: boolean | null;
      /** The close reason is one the relay sends, not free text. */
      reasonKnown: boolean;
      phase: RelayConnectionPhase;
      /** Time since the socket opened, or null if it never did. */
      ageMs: number | null;
      /** Failed attempts since the last ready connection. */
      attempt: number;
    }
  | {
      type: 'connected';
      /** Failed attempts before this one since the last ready connection. */
      attempt: number;
      /**
       * Time since the last ready connection was lost, or null for the first
       * connection since the client started.
       */
      downMs: number | null;
      /** How long this attempt's token request took; 0 when reused. */
      tokenMs: number;
      /** This attempt reused an earlier token instead of fetching one. */
      tokenReused: boolean;
      /** From opening the socket to the relay's `ready`. */
      readyMs: number;
    }
  | {
      type: 'token_failed';
      attempt: number;
      tokenMs: number;
    };

/** Close reasons the relay itself sends: its error codes and shutdown. */
const KNOWN_CLOSE_REASONS: ReadonlySet<string> = new Set([
  ...DEVICE_RELAY_ERROR_CODES,
  DEVICE_RELAY_SHUTDOWN_REASON,
]);

/** How a socket closed, as far as this client knows. */
interface RelaySocketClose {
  cause: RelayCloseCause;
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface RelayClientOptions {
  fetchToken: () => Promise<DeviceRelayTokenResponse>;
  deviceInfo: () => DeviceRelayDeviceInfo;
  createSocket?: RelaySocketFactory;
  onStatusChange?: (status: RelayConnectionStatus, detail?: string) => void;
  onPeersChange?: (peers: ReadonlyArray<DeviceRelayDeviceInfo>) => void;
  /** Connection events for diagnostics; must not throw. */
  onDiagnostic?: (diagnostic: RelayClientDiagnostic) => void;
  /** Backoff bounds, overridable for tests. */
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  pingIntervalMs?: number;
  /** How long an open socket may wait for the relay's `ready`. */
  readyTimeoutMs?: number;
  /** Frames this client may hold while the socket is backed up. */
  maxQueuedBytes?: number;
  /**
   * The shortest maximum age a relay may advertise; shorter ones are raised
   * to it. Overridable for tests.
   */
  minConnectionAgeMs?: number;
}

/**
 * Bytes the socket may hold before frames wait in this client's own queue,
 * which drains as the socket does. Frames are never sent out of order or
 * dropped for backpressure: the encrypted sessions do not tolerate gaps.
 */
const SOCKET_HIGH_WATER_BYTES = 8 * 1024 * 1024;
/** Room for two of the largest messages in flight. */
const DEFAULT_MAX_QUEUED_BYTES = 2 * MAX_MESSAGE_BYTES;
const DRAIN_POLL_MS = 10;
const DEFAULT_PING_INTERVAL_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
/**
 * Backoff growth per failed attempt. Gentler than doubling, so a relay that
 * is back after a few seconds (a deploy, a restart) is reached within a few
 * seconds too, while a long outage still settles at the maximum.
 */
const RECONNECT_BACKOFF_FACTOR = 1.5;
/** The shortest jittered delay, so a failing relay is never hammered. */
const MIN_JITTERED_DELAY_MS = 100;
/**
 * The relay is reported unavailable only once it has been down this long
 * and this many attempts have failed; until then the client says it is
 * reconnecting. A relay deploy takes up to two minutes, and most outages
 * are far shorter than this.
 */
const UNAVAILABLE_AFTER_DOWN_MS = 90_000;
const ATTEMPTS_BEFORE_UNAVAILABLE = 5;
/**
 * After the relay closes with `shuttingDown` (a deploy or restart), the
 * replacement is usually listening within seconds: retry in this window,
 * spread so every device does not return in the same instant.
 */
const SHUTDOWN_RETRY_MIN_MS = 500;
const SHUTDOWN_RETRY_MAX_MS = 3_000;
/**
 * An abnormal close (1006) of a socket at least this old is the load
 * balancer's connection lifetime (an hour), not a failing relay: reconnect
 * at once. Devices connect at different times, so they do not return in
 * step.
 */
const LONG_LIVED_SOCKET_MS = 55 * 60_000;
/** The WebSocket code for a connection that closed without a close frame. */
const ABNORMAL_CLOSE_CODE = 1006;
/**
 * A token is reused for later connections while it has this much validity
 * left, so an outage does not send every device to the token endpoint on
 * every attempt.
 */
const TOKEN_REUSE_MIN_REMAINING_MS = 2 * 60_000;
/** Failed connections with one token after which a fresh one is fetched. */
const TOKEN_FAILURES_BEFORE_REFRESH = 3;

/**
 * Delay before reconnect attempt `attempt` (0-based): an exponential base
 * with factor 1.5 between `min` and `max`, with full jitter (anywhere from
 * 100 ms to the base) so devices that lost the relay together spread out
 * instead of returning in step.
 */
export function reconnectDelayMs(
  attempt: number,
  min: number,
  max: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(max, min * RECONNECT_BACKOFF_FACTOR ** attempt);
  return Math.max(MIN_JITTERED_DELAY_MS, random() * base);
}

/**
 * Delay after another connection took this device's place: the upper half
 * of the longest backoff, so two holders of one identity do not take turns.
 */
function contestedDelayMs(max: number): number {
  return max / 2 + Math.random() * (max / 2);
}

/** Delay after the relay closed for a shutdown: 0.5–3 s, spread evenly. */
function shutdownRetryDelayMs(): number {
  return (
    SHUTDOWN_RETRY_MIN_MS +
    Math.random() * (SHUTDOWN_RETRY_MAX_MS - SHUTDOWN_RETRY_MIN_MS)
  );
}

/**
 * How the client retries after a connection ends, from how it ended:
 * - `shutdown`: the relay is restarting; retry shortly, as a first attempt.
 * - `unauthorized`: the relay refused the token; fetch a fresh one.
 * - `expired_socket`: the load balancer cut a long-lived socket; at once.
 * - `backoff`: anything else, on the usual backoff.
 */
type ReconnectPolicy =
  | 'shutdown'
  | 'unauthorized'
  | 'expired_socket'
  | 'backoff';

/**
 * The longest a relay connection lives when the relay does not say:
 * `backendConfig.timeoutSec` in the relay's chart (86400 s), after which the
 * load balancer closes it.
 */
const DEFAULT_MAX_CONNECTION_AGE_MS = 86_400_000;
/**
 * Advertised maximum ages below this are raised to it, so a misconfigured
 * relay cannot make every device reconnect every few seconds.
 */
const DEFAULT_MIN_CONNECTION_AGE_MS = 60_000;
/** A rotation starts at most this long before the maximum age... */
const MAX_ROTATION_LEAD_MS = 15 * 60_000;
/** ...and within this last share of it. */
const ROTATION_LEAD_FRACTION = 0.05;
/** How soon a rotation held back by queued frames looks again. */
const ROTATION_RETRY_MS = 1_000;

/**
 * The connection age at which to rotate: `maxConnectionAgeMs - lead`, where
 * the lead is a random 50–100% of the smaller of 15 minutes and 5% of the
 * maximum age. It scales with the lifetime, so rotation always happens in
 * the last 5% of it, and devices that connected together rotate apart.
 */
function rotationAgeMs(
  maxConnectionAgeMs: number,
  random: () => number = Math.random,
): number {
  const lead =
    (0.5 + random() * 0.5) *
    Math.min(MAX_ROTATION_LEAD_MS, ROTATION_LEAD_FRACTION * maxConnectionAgeMs);
  return maxConnectionAgeMs - lead;
}
/** Pings without any reply after which the socket counts as dead. */
const MISSED_PINGS_BEFORE_RECONNECT = 3;

function relayConnectUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.pathname = DEVICE_RELAY_CONNECT_PATH;
  return url.toString();
}

/**
 * Holds this device's outbound connection to the device relay: token
 * refresh, authentication, presence of the account's other devices, frame
 * routing, keepalive and reconnect with jittered backoff.
 *
 * A token is reused while it has at least two minutes left, and replaced
 * after three failed connections or when the relay refuses it. Whatever
 * ends a connection (a refused upgrade, a relay restart, a dead network
 * noticed by missed pings, a relay error) takes the same path: peers are
 * reported offline, so the sessions over them suspend (or end, when they
 * cannot resume). How soon the client reconnects depends on how the
 * connection ended (see `ReconnectPolicy`). Peers listed in `ready` are
 * reported online again, which is when controllers resume.
 *
 * The load balancer in front of the relay closes every connection at a
 * maximum age, which the relay advertises in `ready`. Shortly before it, once
 * no frames are queued, the client reconnects on its own: the same path as a
 * drop, so resumable sessions ride it out, but at a time it chose and with no
 * backoff.
 */
export class RelayClient implements RelayTransport {
  private socket: RelaySocket | null = null;
  private status: RelayConnectionStatus = 'stopped';
  private readonly peerMap = new Map<string, DeviceRelayDeviceInfo>();
  private relayFeatures: ReadonlyArray<string> = [];
  private readonly frameListeners = new Set<
    (peerDeviceId: string, payload: Buffer) => void
  >();
  private readonly offlineListeners = new Set<(peerDeviceId: string) => void>();
  private readonly onlineListeners = new Set<(peerDeviceId: string) => void>();
  private readonly undeliverableListeners = new Set<
    (peerDeviceId: string) => void
  >();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly outbound: Uint8Array<ArrayBuffer>[] = [];
  private outboundBytes = 0;
  private attempt = 0;
  private generation = 0;
  private authenticated = false;
  /**
   * The relay said another connection took this device's place: wait the
   * longest backoff, so two holders of one identity do not take turns.
   */
  private contested = false;
  private lastInboundAt = 0;
  /** The current attempt's socket: created, opened and ready (wall clock). */
  private socketCreatedAt: number | null = null;
  private socketOpenedAt: number | null = null;
  private readyAt: number | null = null;
  private tokenMs = 0;
  private tokenReused = false;
  /** When the last ready connection was lost; null while none was. */
  private lostReadyAt: number | null = null;
  /** When `start` was called, for "unavailable" before any connection. */
  private startedAt = 0;
  /** A token kept for later connections, with its expiry (epoch ms). */
  private cachedToken: {
    response: DeviceRelayTokenResponse;
    expiresAt: number;
  } | null = null;
  /** Connections that failed with the cached token since it last worked. */
  private cachedTokenFailures = 0;

  constructor(private readonly options: RelayClientOptions) {}

  get connectionStatus(): RelayConnectionStatus {
    return this.status;
  }

  get peers(): ReadonlyArray<DeviceRelayDeviceInfo> {
    return Array.from(this.peerMap.values());
  }

  get features(): ReadonlyArray<string> {
    return this.relayFeatures;
  }

  getPeer(deviceId: string): DeviceRelayDeviceInfo | null {
    return this.peerMap.get(deviceId) ?? null;
  }

  start(): void {
    if (this.status !== 'stopped') return;
    this.startedAt = Date.now();
    this.setStatus('connecting');
    void this.connect();
  }

  stop(): void {
    this.generation += 1;
    this.noteClosed({ cause: 'stopped' });
    this.lostReadyAt = null;
    this.forgetToken();
    this.clearTimers();
    this.closeSocket();
    this.dropPeers();
    this.attempt = 0;
    this.setStatus('stopped');
  }

  reconnectNow(): void {
    this.restart('reconnect_now');
  }

  /** Replaces the connection at once, reporting it closed for `cause`. */
  private restart(cause: RelayCloseCause): void {
    if (this.status === 'stopped') return;
    this.generation += 1;
    this.noteClosed({ cause });
    this.clearTimers();
    this.closeSocket();
    this.dropPeers();
    this.attempt = 0;
    this.setStatus('connecting');
    void this.connect();
  }

  /** Re-announces this device after a settings change. */
  announce(): void {
    if (!this.authenticated) return;
    this.sendControl({
      type: 'device.update',
      device: this.options.deviceInfo(),
    });
  }

  /**
   * Sends a frame, or queues it behind earlier ones while the socket is
   * backed up. Callers can opt into the specific reason for a refusal.
   */
  sendFrame(
    peerDeviceId: string,
    payload: Uint8Array,
    options: RelayFrameSendOptions,
  ): true | RelayFrameSendFailure;
  sendFrame(peerDeviceId: string, payload: Uint8Array): boolean;
  sendFrame(
    peerDeviceId: string,
    payload: Uint8Array,
    options?: RelayFrameSendOptions,
  ): boolean | RelayFrameSendFailure {
    const socket = this.socket;
    if (!socket || !this.authenticated)
      return options?.includeFailureReason ? 'disconnected' : false;
    const frame = encodeDeviceRelayDataFrame(peerDeviceId, payload);
    if (
      this.outbound.length === 0 &&
      socket.bufferedAmount <= SOCKET_HIGH_WATER_BYTES
    ) {
      socket.transmit(frame);
      return true;
    }
    const maxQueued = this.options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    if (this.outboundBytes + frame.byteLength > maxQueued)
      return options?.includeFailureReason ? 'queue-full' : false;
    this.outbound.push(frame);
    this.outboundBytes += frame.byteLength;
    this.scheduleDrain();
    return true;
  }

  /** WebSocket has no drain event: poll until the socket takes the queue. */
  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, DRAIN_POLL_MS);
    this.drainTimer.unref?.();
  }

  private drain(): void {
    const socket = this.socket;
    if (!socket || !this.authenticated) {
      this.clearOutbound();
      return;
    }
    while (
      this.outbound.length > 0 &&
      socket.bufferedAmount <= SOCKET_HIGH_WATER_BYTES
    ) {
      const frame = this.outbound.shift();
      if (frame === undefined) break;
      this.outboundBytes -= frame.byteLength;
      socket.transmit(frame);
    }
    if (this.outbound.length > 0) this.scheduleDrain();
  }

  private clearOutbound(): void {
    this.outbound.length = 0;
    this.outboundBytes = 0;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  onFrame(
    listener: (peerDeviceId: string, payload: Buffer) => void,
  ): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onPeerOffline(listener: (peerDeviceId: string) => void): () => void {
    this.offlineListeners.add(listener);
    return () => this.offlineListeners.delete(listener);
  }

  onPeerOnline(listener: (peerDeviceId: string) => void): () => void {
    this.onlineListeners.add(listener);
    return () => this.onlineListeners.delete(listener);
  }

  onUndeliverable(listener: (peerDeviceId: string) => void): () => void {
    this.undeliverableListeners.add(listener);
    return () => this.undeliverableListeners.delete(listener);
  }

  private setStatus(status: RelayConnectionStatus, detail?: string): void {
    if (this.status === status && detail === undefined) return;
    this.status = status;
    this.options.onStatusChange?.(status, detail);
  }

  /** The cached token, when it may still be used for a connection. */
  private reusableToken(): DeviceRelayTokenResponse | null {
    const cached = this.cachedToken;
    if (cached === null) return null;
    if (
      this.cachedTokenFailures >= TOKEN_FAILURES_BEFORE_REFRESH ||
      cached.expiresAt - Date.now() < TOKEN_REUSE_MIN_REMAINING_MS
    ) {
      this.forgetToken();
      return null;
    }
    return cached.response;
  }

  private rememberToken(response: DeviceRelayTokenResponse): void {
    const expiresAt = Date.parse(response.expiresAt);
    this.cachedToken = Number.isFinite(expiresAt)
      ? { response, expiresAt }
      : null;
    this.cachedTokenFailures = 0;
  }

  private forgetToken(): void {
    this.cachedToken = null;
    this.cachedTokenFailures = 0;
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    let token = this.reusableToken();
    this.tokenReused = token !== null;
    if (token === null) {
      const tokenStartedAt = Date.now();
      try {
        token = await this.options.fetchToken();
      } catch (error) {
        if (generation !== this.generation) return;
        this.emitDiagnostic({
          type: 'token_failed',
          attempt: this.attempt,
          tokenMs: Date.now() - tokenStartedAt,
        });
        this.scheduleReconnect('backoff', {
          detail:
            error instanceof Error ? error.message : 'Relay is unavailable.',
        });
        return;
      }
      if (generation !== this.generation) return;
      this.tokenMs = Date.now() - tokenStartedAt;
      this.rememberToken(token);
    } else {
      this.tokenMs = 0;
    }
    const createSocket =
      this.options.createSocket ?? createWebSocketRelaySocket;
    this.authenticated = false;
    this.socketCreatedAt = Date.now();
    this.socketOpenedAt = null;
    this.readyAt = null;
    try {
      // The deadline also covers an upgrade that never completes.
      this.startReadyTimer(generation);
      this.socket = createSocket(
        relayConnectUrl(token.relayUrl),
        deviceRelaySubprotocols(token.token),
        {
          onOpen: () => {
            if (generation !== this.generation) return;
            this.lastInboundAt = Date.now();
            this.socketOpenedAt = this.lastInboundAt;
            // A fresh deadline once open: the relay has this long to say ready.
            this.startReadyTimer(generation);
            this.sendControl({
              type: 'hello',
              device: this.options.deviceInfo(),
            });
          },
          onText: (text) => {
            if (generation === this.generation) this.handleText(text);
          },
          onBinary: (bytes) => {
            if (generation === this.generation) this.handleBinary(bytes);
          },
          onClose: (code, reason, wasClean) => {
            if (generation !== this.generation) return;
            this.handleSocketClosed({
              cause: 'socket',
              code,
              reason,
              wasClean,
            });
          },
        },
      );
    } catch (error) {
      this.clearReadyTimer();
      this.socketCreatedAt = null;
      this.scheduleReconnect('backoff', {
        detail:
          error instanceof Error ? error.message : 'Relay connection failed.',
        tokenFailed: true,
      });
    }
  }

  private sendControl(message: DeviceRelayClientMessage): void {
    this.socket?.transmit(JSON.stringify(message));
  }

  private handleText(text: string): void {
    this.lastInboundAt = Date.now();
    const message = parseDeviceRelayServerMessage(text);
    if (message === null) return;
    switch (message.type) {
      case 'ready': {
        this.clearReadyTimer();
        this.authenticated = true;
        const readyAt = Date.now();
        this.readyAt = readyAt;
        this.emitDiagnostic({
          type: 'connected',
          attempt: this.attempt,
          downMs: this.lostReadyAt === null ? null : readyAt - this.lostReadyAt,
          tokenMs: this.tokenMs,
          tokenReused: this.tokenReused,
          readyMs: readyAt - (this.socketCreatedAt ?? readyAt),
        });
        this.lostReadyAt = null;
        this.attempt = 0;
        this.cachedTokenFailures = 0;
        this.contested = false;
        this.relayFeatures = message.features ?? [];
        this.peerMap.clear();
        for (const peer of message.peers) this.peerMap.set(peer.deviceId, peer);
        this.startPing();
        this.startRotationTimer(
          message.maxConnectionAgeMs ?? DEFAULT_MAX_CONNECTION_AGE_MS,
        );
        this.setStatus('connected');
        this.options.onPeersChange?.(this.peers);
        for (const peer of message.peers) this.announceOnline(peer.deviceId);
        return;
      }
      case 'peer.online':
        this.peerMap.set(message.peer.deviceId, message.peer);
        this.options.onPeersChange?.(this.peers);
        this.announceOnline(message.peer.deviceId);
        return;
      case 'peer.offline':
        this.removePeer(message.deviceId);
        return;
      case 'undeliverable':
        for (const listener of Array.from(this.undeliverableListeners)) {
          listener(message.deviceId);
        }
        return;
      case 'pong':
        return;
      case 'error':
        this.handleRelayError(message.code, message.message);
        return;
    }
  }

  private handleRelayError(code: DeviceRelayErrorCode, message: string): void {
    if (code === 'rate_limited' || code === 'invalid_message') return;
    if (code === 'replaced' || code === 'too_many_devices') {
      this.contested = true;
    }
    // The relay closes the socket after these, and the close handler
    // retries: with a fresh token after `unauthorized` (4401).
    this.setStatus('reconnecting', message);
  }

  private handleBinary(bytes: Uint8Array): void {
    this.lastInboundAt = Date.now();
    if (!this.authenticated) return;
    const frame = decodeDeviceRelayDataFrame(bytes);
    if (frame === null) return;
    const payload = Buffer.from(
      frame.payload.buffer,
      frame.payload.byteOffset,
      frame.payload.byteLength,
    );
    for (const listener of Array.from(this.frameListeners)) {
      listener(frame.deviceId, payload);
    }
  }

  private announceOnline(deviceId: string): void {
    for (const listener of Array.from(this.onlineListeners)) listener(deviceId);
  }

  private removePeer(deviceId: string): void {
    if (!this.peerMap.delete(deviceId)) return;
    for (const listener of Array.from(this.offlineListeners))
      listener(deviceId);
    this.options.onPeersChange?.(this.peers);
  }

  private handleSocketClosed(close: RelaySocketClose): void {
    const policy = this.reconnectPolicy(close);
    // An attempt that never got ready may have failed for its token.
    const tokenFailed = this.readyAt === null;
    this.noteClosed(close);
    this.clearReadyTimer();
    this.clearRotationTimer();
    this.clearOutbound();
    this.socket = null;
    this.authenticated = false;
    this.relayFeatures = [];
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.dropPeers();
    this.scheduleReconnect(policy, { tokenFailed });
  }

  /** Reads how the current attempt's socket closed; call before noting it. */
  private reconnectPolicy(close: RelaySocketClose): ReconnectPolicy {
    if (close.cause !== 'socket') return 'backoff';
    switch (close.code) {
      case DEVICE_RELAY_CLOSE_CODES.shuttingDown:
        return 'shutdown';
      case DEVICE_RELAY_CLOSE_CODES.unauthorized:
        return 'unauthorized';
      case ABNORMAL_CLOSE_CODE:
        return this.readyAt !== null &&
          this.socketOpenedAt !== null &&
          Date.now() - this.socketOpenedAt >= LONG_LIVED_SOCKET_MS
          ? 'expired_socket'
          : 'backoff';
      default:
        return 'backoff';
    }
  }

  /** Reports the current attempt's socket as closed, once. */
  private noteClosed(close: RelaySocketClose): void {
    const createdAt = this.socketCreatedAt;
    if (createdAt === null) return;
    const now = Date.now();
    const phase: RelayConnectionPhase =
      this.readyAt !== null
        ? 'ready'
        : this.socketOpenedAt !== null
          ? 'open'
          : 'connecting';
    if (phase === 'ready') this.lostReadyAt = now;
    this.emitDiagnostic({
      type: 'closed',
      cause: close.cause,
      code: close.code ?? null,
      wasClean: close.wasClean ?? null,
      reasonKnown:
        close.reason !== undefined && KNOWN_CLOSE_REASONS.has(close.reason),
      phase,
      ageMs: this.socketOpenedAt === null ? null : now - this.socketOpenedAt,
      attempt: this.attempt,
    });
    this.socketCreatedAt = null;
    this.socketOpenedAt = null;
    this.readyAt = null;
  }

  private emitDiagnostic(diagnostic: RelayClientDiagnostic): void {
    try {
      this.options.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics never affect the connection.
    }
  }

  private dropPeers(): void {
    for (const deviceId of Array.from(this.peerMap.keys()))
      this.removePeer(deviceId);
  }

  private scheduleReconnect(
    policy: ReconnectPolicy,
    options: { detail?: string; tokenFailed?: boolean } = {},
  ): void {
    if (this.status === 'stopped') return;
    this.closeSocket();
    if (options.tokenFailed === true && this.cachedToken !== null) {
      this.cachedTokenFailures += 1;
    }
    // The relay refused the token: the next attempt fetches a fresh one.
    if (policy === 'unauthorized') this.forgetToken();
    const min =
      this.options.minReconnectDelayMs ?? DEFAULT_MIN_RECONNECT_DELAY_MS;
    const max =
      this.options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    let delay: number;
    if (this.contested) {
      delay = contestedDelayMs(max);
      this.attempt += 1;
    } else if (policy === 'shutdown') {
      // A deploy is not a failure: start the backoff over and do not count
      // toward reporting the relay unavailable.
      this.attempt = 0;
      delay = shutdownRetryDelayMs();
    } else if (policy === 'expired_socket') {
      delay = 0;
      this.attempt += 1;
    } else {
      delay = reconnectDelayMs(this.attempt, min, max);
      this.attempt += 1;
    }
    this.setStatus(
      this.relayUnavailable() ? 'unavailable' : 'reconnecting',
      options.detail,
    );
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * Whether to tell people the relay is unavailable: only after a sustained
   * outage, so a deploy or a network blip shows as reconnecting.
   */
  private relayUnavailable(): boolean {
    const downSince = this.lostReadyAt ?? this.startedAt;
    return (
      this.attempt >= ATTEMPTS_BEFORE_UNAVAILABLE &&
      Date.now() - downSince > UNAVAILABLE_AFTER_DOWN_MS
    );
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const interval = this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => {
      // Wall-clock, so a socket that silently died while the computer slept
      // is noticed on the first tick after waking.
      if (
        Date.now() - this.lastInboundAt >
        interval * MISSED_PINGS_BEFORE_RECONNECT
      ) {
        this.generation += 1;
        this.closeSocket();
        this.handleSocketClosed({ cause: 'missed_pings' });
        return;
      }
      this.sendControl({ type: 'ping', sentAt: Date.now() });
    }, interval);
    this.pingTimer.unref?.();
  }

  private startRotationTimer(advertisedMaxAgeMs: number): void {
    this.clearRotationTimer();
    const maxConnectionAgeMs = Math.max(
      advertisedMaxAgeMs,
      this.options.minConnectionAgeMs ?? DEFAULT_MIN_CONNECTION_AGE_MS,
    );
    const openedAt = this.socketOpenedAt ?? Date.now();
    const rotateAt = openedAt + rotationAgeMs(maxConnectionAgeMs);
    this.scheduleRotation(this.generation, Math.max(0, rotateAt - Date.now()));
  }

  private scheduleRotation(generation: number, delayMs: number): void {
    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = null;
      if (generation !== this.generation || !this.authenticated) return;
      // Frames still waiting would be lost with the socket: wait for them.
      if (this.outbound.length > 0 || (this.socket?.bufferedAmount ?? 0) > 0) {
        this.scheduleRotation(generation, ROTATION_RETRY_MS);
        return;
      }
      this.restart('rotation');
    }, delayMs);
    this.rotationTimer.unref?.();
  }

  private clearRotationTimer(): void {
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    this.rotationTimer = null;
  }

  /**
   * A relay that accepts the socket but never says ready is as dead as one
   * that refuses it: give up and reconnect.
   */
  private startReadyTimer(generation: number): void {
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (generation !== this.generation || this.authenticated) return;
      this.generation += 1;
      this.closeSocket();
      this.handleSocketClosed({ cause: 'ready_timeout' });
    }, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    this.readyTimer.unref?.();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private clearTimers(): void {
    this.clearReadyTimer();
    this.clearRotationTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    // Queued frames belong to sessions that end with this socket.
    this.clearOutbound();
    this.authenticated = false;
    this.relayFeatures = [];
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}
