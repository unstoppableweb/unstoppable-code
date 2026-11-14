import {
  HelloResultSchema,
  InvokeParamsSchema,
  PairRevokeResultSchema,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_MISMATCH_CODE,
  REMOTE_PROTOCOL_VERSION,
  RemoteTransportDisconnectedError,
  SessionEndedParamsSchema,
  UNKNOWN_METHOD_CODE,
  UnknownRemoteMethodError,
  UploadPutResultSchema,
  WEB_CONTROLLER_MIN_PROTOCOL_VERSION,
  unknownMethodMessage,
  type ControllerKind,
  type HelloParams,
  type HelloResult,
  type HostedDelegation,
  type RemoteIpcTransport,
  type RemoteSurface,
  type RemoteVersion,
} from '@canopy/protocol/remote-control';
import {
  HostUnsupportedError,
  RemoteSessionError,
  type HostSecurityFeature,
} from './errors';
import { RpcClosedError, RpcPeer, RpcRemoteError } from './rpc-peer';
import { defaultScheduler, type SchedulerPort } from './scheduler';
import type { RemoteSessionManager, SecureSession } from './session-manager';

/** How this controller identifies itself in `session.hello`. */
export interface ControllerProfile {
  kind: ControllerKind;
  /** This build's version; `protocolVersion` is its `REMOTE_PROTOCOL_VERSION`. */
  version: RemoteVersion;
  /**
   * Oldest host protocol this controller accepts. Restricted kinds (browser,
   * hosted, mobile) may accept any newer host that affirmatively advertises
   * controller profiles; desktop controllers require an exact match.
   */
  minVersion: number;
}

/**
 * The hello profile of a web controller: a browser tab, or the hosted agent
 * the web server runs for MCP Remote Control. It reports this build's
 * protocol and accepts any host from `WEB_CONTROLLER_MIN_PROTOCOL_VERSION`
 * up, so a desktop a release behind the web stays controllable. Host
 * features are checked separately (`assertHostSupportsController`).
 */
export function webControllerProfile(
  kind: Extract<ControllerKind, 'browser' | 'hosted'>,
  appVersion: string,
): ControllerProfile {
  return {
    kind,
    version: { protocolVersion: REMOTE_PROTOCOL_VERSION, appVersion },
    minVersion: WEB_CONTROLLER_MIN_PROTOCOL_VERSION,
  };
}

/** Host security features this controller will rely on for a session. */
export interface RequiredHostFeatures {
  hostedDelegation?: boolean;
  pairingProof?: boolean;
}

/** Hello timeout, as the desktop controller uses. */
export const SESSION_HELLO_TIMEOUT_MS = 15_000;

/**
 * Checks a host's `session.hello` answer for this controller. A restricted
 * controller needs `features.controllerProfiles` (plus `hostedDelegation` or
 * `pairingProof` when it uses them) and a host protocol of at least
 * `minVersion`; a desktop controller needs the exact protocol version.
 * Throws `HostUnsupportedError` otherwise; the caller must not retry with
 * another version.
 */
export function assertHostSupportsController(
  hello: HelloResult,
  profile: ControllerProfile,
  required: RequiredHostFeatures = {},
): void {
  const hostVersion = hello.version?.protocolVersion;
  if (profile.kind === 'desktop') {
    if (hostVersion !== profile.version.protocolVersion) {
      throw new HostUnsupportedError(['protocolVersion']);
    }
    return;
  }
  const missing: HostSecurityFeature[] = [];
  if (hostVersion === undefined || hostVersion < profile.minVersion) {
    missing.push('protocolVersion');
  }
  const features = hello.features;
  if (features?.controllerProfiles !== true) missing.push('controllerProfiles');
  if (
    required.hostedDelegation === true &&
    features?.hostedDelegation !== true
  ) {
    missing.push('hostedDelegation');
  }
  if (required.pairingProof === true && features?.pairingProof !== true) {
    missing.push('pairingProof');
  }
  if (missing.length > 0) throw new HostUnsupportedError(missing);
}

/**
 * Sends `session.hello` on a fresh RPC peer and validates the answer for this
 * controller. A protocol-mismatch refusal or an unknown method (a host too
 * old to serve hello where it is needed) becomes `HostUnsupportedError`.
 */
export async function helloHost(
  rpc: RpcPeer,
  profile: ControllerProfile,
  required: RequiredHostFeatures = {},
): Promise<HelloResult> {
  const params: HelloParams = {
    version: profile.version,
    controller: { kind: profile.kind, minVersion: profile.minVersion },
  };
  let answer: unknown;
  try {
    answer = await rpc.request(REMOTE_METHODS.hello, params, {
      timeoutMs: SESSION_HELLO_TIMEOUT_MS,
    });
  } catch (error) {
    if (
      error instanceof RpcRemoteError &&
      (error.code === REMOTE_PROTOCOL_MISMATCH_CODE ||
        error.code === UNKNOWN_METHOD_CODE ||
        error.message === unknownMethodMessage(REMOTE_METHODS.hello))
    ) {
      throw new HostUnsupportedError(['protocolVersion'], error.message);
    }
    throw error;
  }
  const hello = HelloResultSchema.parse(answer);
  assertHostSupportsController(hello, profile, required);
  return hello;
}

export type ControllerConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error';

export interface ControllerConnectionOptions {
  sessions: RemoteSessionManager;
  /** The paired host and its pinned public key. */
  host: { deviceId: string; publicKey: string };
  controller: ControllerProfile;
  /**
   * Hosted delegation for the session manager's identity. Required features
   * then include `hostedDelegation`; once it expires the connection stops
   * with `delegation_expired` instead of reconnecting.
   */
  delegation?: HostedDelegation;
  scheduler?: SchedulerPort;
  onStatusChange?: (
    status: ControllerConnectionStatus,
    error: Error | null,
  ) => void;
  /** A dropped session was re-established; resubscribe host-side interest. */
  onReconnected?: () => void;
  /** The open session closed or the connection was released. */
  onSessionEnded?: () => void;
  /**
   * Serves host → controller requests (`dialog.open` and the like). Without
   * it the controller answers with an unknown-method error, as releases
   * that predate a method do.
   */
  onHostRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Reconnect after an unexpected drop (default true). */
  autoReconnect?: boolean;
  minRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

const ENDED_MESSAGES = {
  disconnected: 'The other computer ended this session.',
  revoked: 'The other computer no longer allows this device to control it.',
} as const;

/**
 * A controller's control connection to one paired host, exposing the shared
 * `RemoteIpcTransport`:
 *
 * - `invoke` maps to `ipc.invoke { channel, args }` with no deadline. If the
 *   session drops first it rejects with `RemoteTransportDisconnectedError`
 *   (outcome unknown) and is never replayed. Without an open session (and
 *   none being opened) it rejects with `not_connected` and sends nothing.
 * - `send` maps to the `ipc.send` event and is dropped while disconnected.
 * - `on` filters `ipc.push` events by channel. Pushes addressed to another
 *   controller surface (the desktop App Advisor window) are not delivered.
 * - {@link transportFor} gives the same transport for another surface: its
 *   calls name that surface, so the host serves them from that surface's
 *   bridge, and it receives that surface's pushes plus untargeted ones.
 *
 * After an unexpected drop it reconnects with backoff unless the host ended
 * the session on purpose, refused this controller, or the delegation expired.
 */
export class RemoteControllerConnection {
  private rpc: RpcPeer | null = null;
  private pendingRpc: RpcPeer | null = null;
  private connecting: Promise<RpcPeer> | null = null;
  private wanted = false;
  private generation = 0;
  /** Set when reconnecting cannot help; cleared by `connect()`. */
  private terminalError: Error | null = null;
  private hadSession = false;
  private retryTimer: unknown = null;
  private attempt = 0;
  private statusValue: ControllerConnectionStatus = 'idle';
  private errorValue: Error | null = null;
  private helloValue: HelloResult | null = null;
  private readonly listeners = new Map<
    RemoteSurface,
    Map<string, Set<(...args: unknown[]) => void>>
  >();
  private readonly transports = new Map<RemoteSurface, RemoteIpcTransport>();
  private readonly scheduler: SchedulerPort;
  readonly transport: RemoteIpcTransport;

  constructor(private readonly options: ControllerConnectionOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.transport = this.transportFor('main');
  }

  /**
   * The transport for one controller surface. `main` is {@link transport};
   * `app-advisor` is the App Advisor surface, where the host delivers
   * Orchestrator questions. One instance per surface.
   */
  transportFor(surface: RemoteSurface): RemoteIpcTransport {
    const existing = this.transports.get(surface);
    if (existing) return existing;
    const transport: RemoteIpcTransport = {
      invoke: (channel, ...args): Promise<unknown> =>
        this.invoke(channel, args, surface),
      send: (channel, ...args): void => this.send(channel, args, surface),
      on: (channel, listener): (() => void) =>
        this.on(channel, listener, surface),
    };
    this.transports.set(surface, transport);
    return transport;
  }

  /**
   * Stores a file on the host (`upload.put`) and returns its path there.
   * Not retried: a drop before the answer rejects with an unknown outcome.
   */
  async upload(fileName: string, bytes: Uint8Array): Promise<string> {
    const rpc = await this.openRpc(REMOTE_METHODS.uploadPut);
    try {
      return UploadPutResultSchema.parse(
        await rpc.request(
          REMOTE_METHODS.uploadPut,
          { fileName, bytes },
          { timeoutMs: null },
        ),
      ).path;
    } catch (error) {
      if (error instanceof RpcClosedError)
        throw new RemoteTransportDisconnectedError(REMOTE_METHODS.uploadPut);
      throw error;
    }
  }

  get status(): ControllerConnectionStatus {
    return this.statusValue;
  }

  get error(): Error | null {
    return this.errorValue;
  }

  get hostInfo(): HelloResult | null {
    return this.helloValue;
  }

  /** Opens (or keeps) the session; resolves with the host's hello. */
  async connect(): Promise<HelloResult> {
    this.wanted = true;
    // Asking again is the user's choice to retry after a terminal refusal.
    this.terminalError = null;
    await this.ensure();
    const hello = this.helloValue;
    if (hello === null)
      throw new RemoteSessionError('not_connected', 'Not connected.');
    return hello;
  }

  /**
   * Asks the host to forget this controller's own pairing (for a delegated
   * hosted session, the root it acts for), then ends the session. Requires
   * the host's `pairRevoke` feature. Not retried: a disconnect before the
   * answer leaves the outcome unknown and rejects.
   */
  async revokeOwnPairing(): Promise<void> {
    const rpc = await this.ensure();
    if (this.helloValue?.features?.pairRevoke !== true)
      throw new HostUnsupportedError(['pairRevoke']);
    try {
      PairRevokeResultSchema.parse(
        await rpc.request(
          REMOTE_METHODS.pairRevoke,
          {},
          { timeoutMs: SESSION_HELLO_TIMEOUT_MS },
        ),
      );
    } catch (error) {
      if (error instanceof RpcClosedError)
        throw new RemoteTransportDisconnectedError(REMOTE_METHODS.pairRevoke);
      throw error;
    }
    this.close();
  }

  /** Retries now instead of waiting out the backoff (host came online). */
  retryNow(): void {
    if (
      !this.wanted ||
      this.terminalError !== null ||
      (this.rpc && !this.rpc.isClosed) ||
      this.connecting
    ) {
      return;
    }
    if (this.retryTimer !== null) this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    void this.ensure().catch(() => undefined);
  }

  /** Ends the session and stops reconnecting. Listeners stay registered. */
  close(): void {
    this.wanted = false;
    this.generation += 1;
    this.connecting = null;
    if (this.retryTimer !== null) this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const rpc = this.rpc;
    this.rpc = null;
    rpc?.close('closed');
    this.pendingRpc?.close('closed');
    this.pendingRpc = null;
    this.hadSession = false;
    this.options.onSessionEnded?.();
    this.setStatus('idle', null);
  }

  private ensure(): Promise<RpcPeer> {
    if (this.rpc && !this.rpc.isClosed) return Promise.resolve(this.rpc);
    if (this.connecting) return this.connecting;
    if (this.terminalError !== null) return Promise.reject(this.terminalError);
    this.setStatus('connecting', null);
    const generation = this.generation;
    const connecting = this.open(generation);
    this.connecting = connecting;
    void connecting.then(
      () => {
        if (this.connecting === connecting) this.connecting = null;
      },
      (error: unknown) => {
        if (this.connecting === connecting) this.connecting = null;
        if (generation !== this.generation) return;
        this.setStatus(
          'error',
          error instanceof Error ? error : new Error('Could not connect.'),
        );
        this.scheduleRetry();
      },
    );
    return connecting;
  }

  /** The open session's peer, or the one being opened; never a new one. */
  private async openRpc(channel: string): Promise<RpcPeer> {
    if (this.rpc && !this.rpc.isClosed) return this.rpc;
    // Never sent yet: waiting for the session being opened is not a replay.
    if (this.connecting) return this.connecting;
    throw new RemoteSessionError(
      'not_connected',
      `"${channel}" was not sent: not connected.`,
    );
  }

  private async invoke(
    channel: string,
    args: unknown[],
    surface: RemoteSurface,
  ): Promise<unknown> {
    const rpc = await this.openRpc(channel);
    try {
      return await rpc.request(
        REMOTE_METHODS.invoke,
        surface === 'main' ? { channel, args } : { channel, args, surface },
        { timeoutMs: null },
      );
    } catch (error) {
      if (error instanceof RpcClosedError)
        throw new RemoteTransportDisconnectedError(channel);
      throw error;
    }
  }

  private send(channel: string, args: unknown[], surface: RemoteSurface): void {
    const rpc = this.rpc;
    if (rpc && !rpc.isClosed)
      rpc.notify(
        REMOTE_EVENTS.ipcSend,
        surface === 'main' ? { channel, args } : { channel, args, surface },
      );
  }

  private on(
    channel: string,
    listener: (...args: unknown[]) => void,
    surface: RemoteSurface,
  ): () => void {
    const byChannel =
      this.listeners.get(surface) ??
      new Map<string, Set<(...args: unknown[]) => void>>();
    this.listeners.set(surface, byChannel);
    const set =
      byChannel.get(channel) ?? new Set<(...args: unknown[]) => void>();
    // A wrapper, so registering one function twice yields two removable entries.
    const entry = (...args: unknown[]): void => listener(...args);
    set.add(entry);
    byChannel.set(channel, set);
    return () => {
      set.delete(entry);
      if (set.size === 0 && byChannel.get(channel) === set)
        byChannel.delete(channel);
    };
  }

  private dispatchPush(payload: unknown): void {
    const parsed = InvokeParamsSchema.safeParse(payload);
    if (!parsed.success) return;
    const { channel, args, surface } = parsed.data;
    // A push without a surface goes to every surface, as to every window.
    const surfaces: readonly RemoteSurface[] =
      surface === undefined ? Array.from(this.listeners.keys()) : [surface];
    for (const target of surfaces) {
      const set = this.listeners.get(target)?.get(channel);
      if (!set) continue;
      for (const listener of Array.from(set)) {
        try {
          listener(...args);
        } catch {
          // One listener's failure must not starve the others.
        }
      }
    }
  }

  private async openSession(): Promise<SecureSession> {
    const delegation = this.options.delegation;
    if (
      delegation !== undefined &&
      delegation.expiresAt <= this.scheduler.now()
    ) {
      this.terminalError = new RemoteSessionError(
        'delegation_expired',
        'The agent session expired. Start a new one.',
      );
      throw this.terminalError;
    }
    return this.options.sessions.connect({
      peerDeviceId: this.options.host.deviceId,
      purpose: 'control',
      pinnedPeerPublicKey: this.options.host.publicKey,
      delegation: delegation ?? null,
    });
  }

  private async open(generation: number): Promise<RpcPeer> {
    const session = await this.openSession();
    if (generation !== this.generation) {
      session.close('closed');
      throw new RemoteSessionError('shut_down', 'The connection was closed.');
    }
    const rpc = new RpcPeer(session, {
      scheduler: this.scheduler,
      onRequest: (method, params): Promise<unknown> =>
        this.options.onHostRequest
          ? this.options.onHostRequest(method, params)
          : Promise.reject(new UnknownRemoteMethodError(method)),
      onEvent: (name, payload): void => {
        if (name === REMOTE_EVENTS.ended) {
          const ended = SessionEndedParamsSchema.safeParse(payload);
          if (ended.success) {
            this.terminalError = new RemoteSessionError(
              'session_ended',
              ENDED_MESSAGES[ended.data.reason],
            );
          }
          return;
        }
        if (name === REMOTE_EVENTS.push) this.dispatchPush(payload);
      },
    });
    rpc.onClose(() => this.handleDropped(rpc));
    this.pendingRpc = rpc;
    let hello: HelloResult;
    try {
      hello = await helloHost(rpc, this.options.controller, {
        hostedDelegation: this.options.delegation !== undefined,
      });
      if (generation !== this.generation) {
        throw new RemoteSessionError('shut_down', 'The connection was closed.');
      }
      if (rpc.isClosed)
        throw new RemoteSessionError('not_connected', 'The session closed.');
    } catch (error) {
      if (
        error instanceof HostUnsupportedError &&
        generation === this.generation
      ) {
        this.terminalError = error;
      }
      // Never leave a session open that nothing will use.
      rpc.close('closed');
      throw error;
    } finally {
      if (this.pendingRpc === rpc) this.pendingRpc = null;
    }
    this.helloValue = hello;
    this.rpc = rpc;
    this.attempt = 0;
    const reconnected = this.hadSession;
    this.hadSession = true;
    this.setStatus('connected', null);
    if (reconnected) this.options.onReconnected?.();
    return rpc;
  }

  private handleDropped(rpc: RpcPeer): void {
    if (this.rpc !== rpc) return;
    this.rpc = null;
    this.options.onSessionEnded?.();
    if (!this.wanted) {
      this.setStatus('idle', null);
      return;
    }
    if (this.terminalError !== null) {
      this.setStatus('error', this.terminalError);
      return;
    }
    this.setStatus('connecting', null);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (
      !this.wanted ||
      this.retryTimer !== null ||
      this.terminalError !== null ||
      this.options.autoReconnect === false
    ) {
      return;
    }
    const min = this.options.minRetryDelayMs ?? 1_000;
    const max = this.options.maxRetryDelayMs ?? 15_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    // Jitter, so controllers that lost a host together do not retry in step.
    const delay = base / 2 + this.scheduler.random() * (base / 2);
    this.attempt += 1;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) void this.ensure().catch(() => undefined);
    }, delay);
  }

  private setStatus(
    status: ControllerConnectionStatus,
    error: Error | null,
  ): void {
    if (this.statusValue === status && this.errorValue === error) return;
    this.statusValue = status;
    this.errorValue = error;
    this.options.onStatusChange?.(status, error);
  }
}
