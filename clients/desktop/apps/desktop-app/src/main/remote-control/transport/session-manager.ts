import { randomBytes } from 'node:crypto';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import type { HostedDelegation } from '@canopy/protocol/remote-control';
import type { DeviceKeyPair } from '../crypto/device-key';
import {
  assertHello1Sender,
  HandshakeError,
  HandshakeInitiator,
  HandshakeResponder,
  Hello1Schema,
  Hello2Schema,
  Hello3Schema,
  Hello4Schema,
  type Hello1,
  type Hello4,
  type HandshakePurpose,
  type HandshakeResult,
} from '../crypto/handshake';
import { SecureChannel, sealedFrameCounter } from '../crypto/secure-channel';
import {
  buildResume1,
  buildResume2,
  createResumeNonce,
  openResume1,
  openResume2,
  Resume1Schema,
  Resume2Schema,
} from '../crypto/session-resume';
import {
  decodeEnvelope,
  encodeEnvelope,
  envelopeHeader,
  SESSION_ID_BYTES,
} from './envelope';
import {
  decodeAckFragment,
  encodeAckFragment,
  encodeMessage,
  isTransportControlFragment,
  MessageAssembler,
  type MessageCodecOptions,
} from './message-codec';

/** Minimal view of the relay connection the session layer needs. */
export interface RelayTransport {
  sendFrame(peerDeviceId: string, payload: Uint8Array): boolean;
  onFrame(
    listener: (peerDeviceId: string, payload: Buffer) => void,
  ): () => void;
  onPeerOffline(listener: (peerDeviceId: string) => void): () => void;
  /**
   * A peer is connected to the relay: listed in `ready` after this device
   * (re)connected, or announced since. A peer that reconnected may be
   * announced without going offline first.
   */
  onPeerOnline(listener: (peerDeviceId: string) => void): () => void;
  /** The relay could not deliver a frame because the peer is not connected. */
  onUndeliverable(listener: (peerDeviceId: string) => void): () => void;
}

export type SessionCloseReason =
  | 'closed'
  | 'peer_closed'
  | 'peer_offline'
  | 'protocol_error'
  | 'transport_error'
  | 'timeout'
  | 'revoked'
  | 'shutdown';

/**
 * Which end of the handshake this computer was: the controller initiates,
 * the controlled computer responds.
 */
export type SessionRole = 'initiator' | 'responder';

/** An established session ended; for diagnostics, no identities. */
export interface SessionClosedEvent {
  purpose: HandshakePurpose;
  role: SessionRole;
  reason: SessionCloseReason;
  /** Time from the end of the handshake to the close. */
  durationMs: number;
}

/**
 * `active`: frames go out as they are sealed. `suspended`: the relay path to
 * the peer is down; frames are sealed and held. `resuming`: the controller
 * asked the host to resume and holds frames until it answers. A session
 * that cannot resume closes instead of suspending.
 */
export type SessionState = 'active' | 'suspended' | 'resuming' | 'closed';

/** Bytes of sealed frames a session holds for re-sending after a drop. */
export const RESEND_BUFFER_BYTES = 16 * 1024 * 1024;
/** Acks follow received data within this long, or after this many bytes. */
const ACK_INTERVAL_MS = 250;
const ACK_BYTES = 1024 * 1024;
/**
 * How long a suspended session waits for a resume before it closes and the
 * controller falls back to a new handshake. The host waits longer, so the
 * controller, which asks, gives up first.
 */
export const CONTROLLER_RESUME_DEADLINE_MS = 120_000;
export const HOST_RESUME_DEADLINE_MS = 150_000;
/** The controller asks again this often while a session is not active. */
const RESUME_RETRY_MS = 5_000;

const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_PENDING_HANDSHAKES_PER_PEER = 4;
const MAX_SESSIONS_PER_PEER = 8;
/** One abort per unknown session per this window, at most this many tracked. */
const UNKNOWN_SESSION_ABORT_WINDOW_MS = 5_000;
const MAX_TRACKED_UNKNOWN_SESSIONS = 256;

/** Abort reason for traffic to a session this side does not have. */
export const UNKNOWN_SESSION_MESSAGE = 'unknown_session';

/**
 * What the responder authorized an incoming session as. Decided at hello1
 * and decided again after hello3; the two decisions must agree.
 */
export interface SessionGrant {
  /** The controller profile the session is held to. */
  readonly kind: DeviceKind;
  /** Whether `kind` came from relay-authenticated presence. */
  readonly kindAuthenticated: boolean;
  /**
   * The pinned hosted root a delegated session is attributed to, or null
   * when the initiator's own key is the pinned identity.
   */
  readonly rootDeviceId: string | null;
  /** Milliseconds since the epoch the grant lapses at, or null. */
  readonly expiresAt: number | null;
}

/**
 * One responder authorization question, asked before hello2, after hello3,
 * and before each resume.
 */
export interface HandshakeAdmission {
  /** `resume`: an established session asks to continue after a drop. */
  stage: 'hello1' | 'hello3' | 'resume';
  purpose: HandshakePurpose;
  initiatorKey: string;
  /** Source device the relay reported. */
  peerDeviceId: string;
  delegation: HostedDelegation | null;
}

function sameGrant(left: SessionGrant, right: SessionGrant): boolean {
  return (
    left.kind === right.kind &&
    left.kindAuthenticated === right.kindAuthenticated &&
    left.rootDeviceId === right.rootDeviceId
  );
}

export interface SecureSessionOptions {
  /** Overrides {@link RESEND_BUFFER_BYTES}, for tests. */
  resendBufferBytes?: number;
}

interface RetainedFrame {
  counter: bigint;
  /** The whole data envelope, sent again exactly as it was. */
  envelope: Buffer;
}

/**
 * An established, end-to-end encrypted session with one peer device.
 *
 * A control session whose peers negotiated resume (`setResumeNegotiated`)
 * survives a relay drop: it holds every sealed frame until the peer
 * acknowledges it, suspends instead of closing when the peer goes offline,
 * and re-sends the held frames, unchanged, once the session manager resumes
 * it. When the held frames would pass the buffer's cap while active, it drops
 * that batch and keeps a bounded tail. A drop closes it until an ack covers
 * every discarded frame; the retained tail makes later frames replayable.
 */
export class SecureSession {
  private readonly channel: SecureChannel;
  private readonly assembler = new MessageAssembler();
  private readonly dataHeader: Buffer;
  private readonly messageListeners = new Set<(value: unknown) => void>();
  private readonly closeListeners = new Set<
    (reason: SessionCloseReason) => void
  >();
  private readonly stateListeners = new Set<(state: SessionState) => void>();
  private closedReason: SessionCloseReason | null = null;
  private lastReceivedAtValue = Date.now();
  /** When the handshake finished (wall clock). */
  readonly establishedAt = Date.now();
  private stateValue: Exclude<SessionState, 'closed'> = 'active';
  private resumeNegotiatedValue = false;
  /** Pairing sessions never resume, so never hold frames. */
  private retaining: boolean;
  private retained: RetainedFrame[] = [];
  private retainedBytes = 0;
  private readonly resendBufferBytes: number;
  private unackedBytes = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Closed while suspended, still holding frames for the peer's resume. */
  private lingering = false;

  constructor(
    readonly sessionId: Buffer,
    readonly handshake: HandshakeResult,
    private readonly transport: RelayTransport,
    /** The responder's authorization; null on the initiating side. */
    readonly grant: SessionGrant | null = null,
    options: SecureSessionOptions = {},
  ) {
    this.channel = new SecureChannel(handshake.sendKey, handshake.receiveKey);
    this.dataHeader = envelopeHeader('data', sessionId);
    this.resendBufferBytes = options.resendBufferBytes ?? RESEND_BUFFER_BYTES;
    // Held from the first frame, so a drop right after the hello can resume;
    // released at once if the peers do not negotiate it.
    this.retaining = handshake.purpose === 'control';
  }

  get peerDeviceId(): string {
    return this.handshake.peerDeviceId;
  }

  get purpose(): HandshakePurpose {
    return this.handshake.purpose;
  }

  /** Only the responder holds a grant. */
  get role(): SessionRole {
    return this.grant === null ? 'initiator' : 'responder';
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }

  get state(): SessionState {
    return this.closedReason === null ? this.stateValue : 'closed';
  }

  get resumeNegotiated(): boolean {
    return this.resumeNegotiatedValue;
  }

  /** Whether a drop now would suspend this session rather than close it. */
  get resumable(): boolean {
    return (
      this.closedReason === null && this.resumeNegotiatedValue && this.retaining
    );
  }

  /**
   * Closed on purpose while suspended, and still holding what it sent last
   * (such as `session.ended`) until the controller resumes to receive it.
   */
  get isLingering(): boolean {
    return this.lingering;
  }

  /** The counter of the first frame from the peer not yet received. */
  get nextReceiveCounter(): bigint {
    return this.channel.nextReceiveCounter;
  }

  /**
   * When an authenticated frame last arrived, whole message or fragment, so
   * a large message still arriving counts as activity.
   */
  get lastReceivedAt(): number {
    return this.lastReceivedAtValue;
  }

  onMessage(listener: (value: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (reason: SessionCloseReason) => void): () => void {
    if (this.closedReason !== null) {
      listener(this.closedReason);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Told of every change between active, suspended and resuming. */
  onStateChange(listener: (state: SessionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Records whether both peers agreed to resume this session, from the
   * hello. Without agreement it stops holding frames and never resumes;
   * pairing sessions never do.
   */
  setResumeNegotiated(negotiated: boolean): void {
    if (this.closedReason !== null) return;
    if (!negotiated || this.purpose !== 'control') {
      this.resumeNegotiatedValue = false;
      this.retaining = false;
      this.dropRetained();
      return;
    }
    this.resumeNegotiatedValue = true;
  }

  /** Sends one message; returns false when the session or relay is down. */
  sendMessage(
    value: unknown,
    options: Pick<MessageCodecOptions, 'onSerialized'> = {},
  ): boolean {
    if (this.closedReason !== null) return false;
    // An unserializable value throws here and fails only this message.
    const fragments = encodeMessage(value, options);
    try {
      for (const fragment of fragments) {
        if (!this.sendFragment(fragment)) return false;
      }
    } catch {
      // Encryption or socket failures must never escape into timers or event
      // handlers in main; end the session instead.
      this.close('transport_error');
      return false;
    }
    return true;
  }

  /**
   * Seals one fragment and sends it, or holds it while the session is not
   * active. Returns false once the session closed.
   */
  private sendFragment(fragment: Buffer): boolean {
    const counter = this.channel.nextSendCounter;
    const envelope = Buffer.concat([
      this.dataHeader,
      this.channel.seal(fragment, this.dataHeader),
    ]);
    if (this.retaining || this.resumeNegotiatedValue)
      this.retain(counter, envelope);
    if (this.closedReason !== null) return false;
    if (this.stateValue !== 'active') return true;
    if (this.transport.sendFrame(this.peerDeviceId, envelope)) return true;
    if (this.suspendAfterFailedSend()) return true;
    this.close('transport_error');
    return false;
  }

  /**
   * A send failed while active. The controller suspends and asks to resume
   * itself. The host cannot ask: a lost relay socket already suspended it
   * through its peers going offline, so this is its relay queue overflowing,
   * which the controller would never notice. The host closes instead.
   */
  private suspendAfterFailedSend(): boolean {
    return this.role === 'initiator' && this.suspend();
  }

  private retain(counter: bigint, envelope: Buffer): void {
    if (this.retainedBytes + envelope.byteLength > this.resendBufferBytes) {
      if (this.stateValue !== 'active') {
        // Held frames were never sent, so they cannot be let go.
        this.close('transport_error');
        return;
      }
      // Discard this batch, but keep later frames in a bounded tail. A drop
      // closes the session until the peer acknowledges the discarded frames.
      this.retaining = false;
      this.dropRetained();
      return;
    }
    this.retained.push({ counter, envelope });
    this.retainedBytes += envelope.byteLength;
  }

  private dropRetained(): void {
    this.retained = [];
    this.retainedBytes = 0;
  }

  /** Lets go of held frames the peer has received. */
  private releaseRetained(nextExpected: bigint): void {
    let index = 0;
    while (
      index < this.retained.length &&
      (this.retained[index]?.counter ?? nextExpected) < nextExpected
    ) {
      this.retainedBytes -= this.retained[index]?.envelope.byteLength ?? 0;
      index += 1;
    }
    if (index > 0) this.retained = this.retained.slice(index);
  }

  /** Feeds one data envelope body; protocol violations end the session. */
  receive(body: Buffer): void {
    if (this.closedReason !== null) return;
    if (this.resumeNegotiatedValue) {
      const counter = sealedFrameCounter(body);
      const expected = this.channel.nextReceiveCounter;
      // Re-sent after a resume and already received: drop it unopened.
      if (counter !== null && counter < expected) return;
      // Sent past a gap the drop left; it is re-sent once the session
      // resumes. Only while not active: then a gap is fatal, as before.
      if (
        counter !== null &&
        counter > expected &&
        this.stateValue !== 'active'
      )
        return;
    }
    let fragment: Buffer;
    let decoded: { complete: true; value: unknown } | null;
    try {
      fragment = this.channel.open(body, this.dataHeader);
      this.lastReceivedAtValue = Date.now();
      if (isTransportControlFragment(fragment)) {
        this.handleAck(decodeAckFragment(fragment));
        return;
      }
      decoded = this.assembler.push(fragment);
    } catch {
      this.close('protocol_error');
      return;
    }
    this.noteReceived(fragment.byteLength);
    if (decoded === null) return;
    for (const listener of Array.from(this.messageListeners))
      listener(decoded.value);
  }

  private handleAck(nextExpected: bigint): void {
    if (nextExpected > this.channel.nextSendCounter) {
      throw new Error('Acknowledged a frame that was never sent.');
    }
    this.releaseRetained(nextExpected);
    if (
      !this.retaining &&
      this.resumeNegotiatedValue &&
      nextExpected >=
        (this.retained[0]?.counter ?? this.channel.nextSendCounter)
    ) {
      // The peer has every discarded frame; later frames remain replayable.
      // In particular, a later ack does not need its own ack to re-arm resume.
      this.retaining = true;
    }
  }

  /** Acks only data, never acks, so two sides cannot ack each other forever. */
  private noteReceived(byteLength: number): void {
    if (!this.resumeNegotiatedValue) return;
    this.unackedBytes += byteLength;
    if (this.unackedBytes >= ACK_BYTES) {
      this.sendAck();
      return;
    }
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.sendAck();
    }, ACK_INTERVAL_MS);
    this.ackTimer.unref?.();
  }

  private sendAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    // A resume carries the same counter, so a skipped ack loses nothing.
    if (this.closedReason !== null || this.stateValue !== 'active') return;
    this.unackedBytes = 0;
    try {
      this.sendFragment(encodeAckFragment(this.channel.nextReceiveCounter));
    } catch {
      this.close('transport_error');
    }
  }

  private setState(state: Exclude<SessionState, 'closed'>): void {
    if (this.closedReason !== null || this.stateValue === state) return;
    this.stateValue = state;
    if (state !== 'active') {
      if (this.ackTimer) clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    for (const listener of Array.from(this.stateListeners)) listener(state);
  }

  /**
   * The relay path to the peer is down. Returns false, changing nothing,
   * when this session cannot resume and must close instead.
   */
  suspend(): boolean {
    if (!this.resumable) return false;
    this.setState('suspended');
    return true;
  }

  /** The controller asked the host to resume; frames are held meanwhile. */
  markResuming(): void {
    if (this.resumable) this.setState('resuming');
  }

  /**
   * The peer has every frame below `peerNextExpected`: let those go, send
   * the rest again, unchanged, and become active. Returns false when the
   * counter is past what this side sent, which a correct peer never asks for.
   *
   * A counter below the oldest held frame is a retry that a newer ack
   * superseded: while resumable, held frames are only ever let go because
   * the peer acknowledged them, so the peer already has everything below
   * that frame. Re-sending from it is safe; the peer drops duplicates.
   */
  resumeFrom(peerNextExpected: bigint): boolean {
    const lingering = this.lingering;
    if (!this.resumable && !lingering) return false;
    if (peerNextExpected > this.channel.nextSendCounter) return false;
    this.releaseRetained(peerNextExpected);
    if (lingering && this.retained.length === 0) {
      // The controller has everything, the ending included.
      this.abandon();
      return true;
    }
    if (!lingering) this.setState('active');
    for (const frame of Array.from(this.retained)) {
      if (!lingering && (this.stateValue !== 'active' || this.isClosed)) break;
      if (!this.transport.sendFrame(this.peerDeviceId, frame.envelope)) {
        // A lingering session keeps them for the next resume.
        if (lingering) return true;
        if (!this.suspendAfterFailedSend()) this.close('transport_error');
        break;
      }
    }
    // Sent is only queued: a lingering session keeps its frames, and answers
    // the controller's next resume again, until that resume shows they all
    // arrived or its deadline passes.
    return true;
  }

  /**
   * Closes, but when the session is a suspended host session it first
   * lingers with what it holds, so an ending sent on purpose (the RPC
   * `close` and `session.ended`) still reaches the controller when it
   * resumes. The session manager drops it at the deadline.
   */
  closeAfterDelivery(reason: SessionCloseReason): void {
    if (this.closedReason !== null) return;
    if (
      this.role === 'responder' &&
      this.resumable &&
      this.stateValue !== 'active' &&
      this.retained.length > 0
    ) {
      this.lingering = true;
    }
    this.close(reason);
  }

  /** Lets go of a lingering session's held frames. */
  abandon(): void {
    this.lingering = false;
    this.dropRetained();
  }

  close(reason: SessionCloseReason): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (!this.lingering) this.dropRetained();
    this.retaining = false;
    this.messageListeners.clear();
    this.stateListeners.clear();
    const listeners = Array.from(this.closeListeners);
    this.closeListeners.clear();
    for (const listener of listeners) listener(reason);
  }
}

export interface SessionManagerOptions {
  transport: RelayTransport;
  identity: () => DeviceKeyPair;
  /**
   * Responder-side authorization for an incoming handshake, asked before
   * hello2 and again after hello3. Null (or a throw) refuses it. It may
   * persist first, for example to narrow a pairing's kind before access.
   */
  authorize: (
    request: HandshakeAdmission,
  ) => SessionGrant | null | Promise<SessionGrant | null>;
  onIncomingSession: (session: SecureSession) => void;
  /** An established session closed, for any reason; must not throw. */
  onSessionClosed?: (event: SessionClosedEvent) => void;
  handshakeTimeoutMs?: number;
  /**
   * Overrides {@link CONTROLLER_RESUME_DEADLINE_MS} and
   * {@link HOST_RESUME_DEADLINE_MS}, and the retry interval, for tests.
   */
  resumeDeadlineMs?: { initiator: number; responder: number };
  resumeRetryMs?: number;
  /** Overrides {@link RESEND_BUFFER_BYTES} for every session, for tests. */
  resendBufferBytes?: number;
}

/** The manager's bookkeeping for a session that is not active. */
interface ResumeEpisode {
  deadline: ReturnType<typeof setTimeout>;
  /** The controller's retry timer; null on the host. */
  retry: ReturnType<typeof setInterval> | null;
  /** The controller's nonce for this episode, bound into resume2. */
  nonce: Buffer;
  /** The host is re-authorizing a resume1. */
  authorizing: boolean;
}

export interface ConnectOptions {
  peerDeviceId: string;
  purpose: HandshakePurpose;
  pinnedPeerPublicKey: string | null;
  /** A hosted root's grant for this device's key, sent in hello1. */
  delegation?: HostedDelegation;
}

interface PendingInitiator {
  handshake: HandshakeInitiator;
  resolve: (session: SecureSession) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingResponder {
  /** Null while hello1 is being authorized. */
  handshake: HandshakeResponder | null;
  grant: SessionGrant | null;
  /** Hello3 arrived and its recheck is running. */
  finishing: boolean;
  sessionId: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

function sessionKey(peerDeviceId: string, sessionId: Buffer): string {
  return `${peerDeviceId}:${sessionId.toString('hex')}`;
}

function parseJson(body: Buffer): unknown {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return value;
  } catch {
    return null;
  }
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/**
 * Runs handshakes and routes encrypted envelopes for every session over one
 * relay connection. The controller initiates; the controlled device responds.
 */
export class RemoteSessionManager {
  private readonly sessions = new Map<string, SecureSession>();
  private readonly initiators = new Map<string, PendingInitiator>();
  private readonly responders = new Map<string, PendingResponder>();
  /** Unknown sessions recently answered with an abort, and when. */
  private readonly abortedUnknown = new Map<string, number>();
  private readonly episodes = new Map<SecureSession, ResumeEpisode>();
  private readonly stateListeners = new Set<
    (session: SecureSession, state: SessionState) => void
  >();
  private readonly unsubscribers: Array<() => void>;
  private disposed = false;

  constructor(private readonly options: SessionManagerOptions) {
    this.unsubscribers = [
      options.transport.onFrame((peer, payload) =>
        this.handleFrame(peer, payload),
      ),
      options.transport.onPeerOffline((peer) => this.handlePeerOffline(peer)),
      options.transport.onPeerOnline((peer) => this.handlePeerOnline(peer)),
      // A frame to a peer the relay does not have: it is offline, whatever
      // presence said. Fail its handshakes now instead of at their timeout,
      // so a retry can start as soon as it is back.
      options.transport.onUndeliverable((peer) => this.handlePeerOffline(peer)),
    ];
  }

  /**
   * Told whenever a session suspends, starts resuming or is active again,
   * for status shown to the user and presence that rides out a drop.
   */
  onSessionStateChange(
    listener: (session: SecureSession, state: SessionState) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Open sessions with `peerDeviceId` that are waiting to resume. */
  suspendedSessions(peerDeviceId: string): SecureSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) =>
        session.peerDeviceId === peerDeviceId &&
        (session.state === 'suspended' || session.state === 'resuming'),
    );
  }

  private get handshakeTimeoutMs(): number {
    return this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  }

  connect(options: ConnectOptions): Promise<SecureSession> {
    if (this.disposed) {
      return Promise.reject(new Error('Remote sessions are shut down.'));
    }
    const refusal = this.admissionRefusal(options.peerDeviceId);
    if (refusal !== null) return Promise.reject(new Error(refusal));
    const sessionId = randomBytes(SESSION_ID_BYTES);
    const key = sessionKey(options.peerDeviceId, sessionId);
    const handshake = new HandshakeInitiator({
      sessionId,
      purpose: options.purpose,
      identity: this.options.identity(),
      peerDeviceId: options.peerDeviceId,
      pinnedPeerPublicKey: options.pinnedPeerPublicKey,
      ...(options.delegation ? { delegation: options.delegation } : {}),
    });
    return new Promise<SecureSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.initiators.delete(key);
        reject(new Error('The other computer did not answer the connection.'));
      }, this.handshakeTimeoutMs);
      this.initiators.set(key, { handshake, resolve, reject, timer });
      const sent = this.options.transport.sendFrame(
        options.peerDeviceId,
        encodeEnvelope('hello1', sessionId, jsonBody(handshake.start())),
      );
      if (!sent) {
        clearTimeout(timer);
        this.initiators.delete(key);
        reject(new Error('Not connected to the relay.'));
      }
    });
  }

  /** Closes every session with one peer (for example after revocation). */
  closePeer(peerDeviceId: string, reason: SessionCloseReason): void {
    this.cancelHandshakes(peerDeviceId, reason);
    for (const session of Array.from(this.sessions.values())) {
      if (session.peerDeviceId !== peerDeviceId) continue;
      if (session.isLingering) this.forget(session);
      else session.close(reason);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const pending of Array.from(this.initiators.values())) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Remote sessions are shut down.'));
    }
    this.initiators.clear();
    for (const pending of Array.from(this.responders.values()))
      clearTimeout(pending.timer);
    this.responders.clear();
    for (const session of Array.from(this.sessions.values())) {
      session.close('shutdown');
      if (session.isLingering) this.forget(session);
    }
    for (const session of Array.from(this.episodes.keys()))
      this.endEpisode(session);
  }

  /** Drops a lingering session: it stops waiting for the peer's resume. */
  private forget(session: SecureSession): void {
    session.abandon();
    this.endEpisode(session);
    const key = sessionKey(session.peerDeviceId, session.sessionId);
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }

  private createSession(
    sessionId: Buffer,
    result: HandshakeResult,
    grant: SessionGrant | null,
  ): SecureSession {
    const { resendBufferBytes } = this.options;
    return new SecureSession(
      sessionId,
      result,
      this.options.transport,
      grant,
      resendBufferBytes === undefined ? {} : { resendBufferBytes },
    );
  }

  private trackSession(key: string, session: SecureSession): void {
    this.sessions.set(key, session);
    session.onStateChange((state) => {
      if (state === 'active') this.endEpisode(session);
      else this.beginEpisode(session);
      for (const listener of Array.from(this.stateListeners))
        listener(session, state);
    });
    session.onClose((reason) => {
      try {
        this.options.onSessionClosed?.({
          purpose: session.purpose,
          role: session.role,
          reason,
          durationMs: Date.now() - session.establishedAt,
        });
      } catch {
        // Diagnostics never affect the session layer.
      }
      // Still routable, so the controller's resume can collect what it holds.
      if (session.isLingering) return;
      this.endEpisode(session);
      this.sessions.delete(key);
      // Tell the peer at once instead of leaving it to its keepalive. The
      // abort is unauthenticated, so it can only end a session, which a
      // relay could already do by dropping frames.
      if (reason !== 'peer_closed' && reason !== 'peer_offline') {
        this.abort(session.peerDeviceId, session.sessionId, reason);
      }
    });
  }

  /**
   * Why another handshake with this peer, in either direction, is refused,
   * or null. Both directions count, so two computers connecting to each
   * other at once cannot pass the limits together.
   */
  private admissionRefusal(peer: string): string | null {
    const pending =
      this.countForPeer(this.initiators, peer) +
      this.countForPeer(this.responders, peer);
    if (
      pending >= MAX_PENDING_HANDSHAKES_PER_PEER ||
      pending + this.countForPeer(this.sessions, peer) >= MAX_SESSIONS_PER_PEER
    ) {
      return 'Too many connections with this device.';
    }
    return null;
  }

  private countForPeer(map: Map<string, unknown>, peer: string): number {
    let count = 0;
    for (const key of Array.from(map.keys())) {
      if (key.startsWith(`${peer}:`)) count += 1;
    }
    return count;
  }

  private abort(peer: string, sessionId: Buffer, message: string): void {
    this.options.transport.sendFrame(
      peer,
      encodeEnvelope('abort', sessionId, jsonBody({ message })),
    );
  }

  private handleFrame(peer: string, payload: Buffer): void {
    if (this.disposed) return;
    const envelope = decodeEnvelope(payload);
    if (envelope === null) return;
    const key = sessionKey(peer, envelope.sessionId);
    try {
      switch (envelope.type) {
        case 'data': {
          const session = this.sessions.get(key);
          if (session) session.receive(envelope.body);
          else this.answerUnknownSession(peer, envelope.sessionId, key);
          return;
        }
        case 'hello1':
          this.handleHello1(peer, envelope.sessionId, key, envelope.body);
          return;
        case 'hello2':
          this.handleHello2(peer, envelope.sessionId, key, envelope.body);
          return;
        case 'hello3':
          this.handleHello3(peer, envelope.sessionId, key, envelope.body);
          return;
        case 'hello4':
          this.handleHello4(peer, envelope.sessionId, key, envelope.body);
          return;
        case 'abort':
          this.handleAbort(key, envelope.body);
          return;
        case 'resume1':
          this.handleResume1(peer, envelope.sessionId, key, envelope.body);
          return;
        case 'resume2':
          this.handleResume2(peer, envelope.sessionId, key, envelope.body);
          return;
      }
    } catch (error) {
      this.failHandshake(peer, envelope.sessionId, key, error);
    }
  }

  private failHandshake(
    peer: string,
    sessionId: Buffer,
    key: string,
    error: unknown,
  ): void {
    const message =
      error instanceof Error ? error.message : 'Connection refused.';
    const initiator = this.initiators.get(key);
    if (initiator) {
      clearTimeout(initiator.timer);
      this.initiators.delete(key);
      initiator.reject(
        error instanceof Error ? error : new Error('Connection refused.'),
      );
      return;
    }
    const responder = this.responders.get(key);
    if (responder) {
      clearTimeout(responder.timer);
      this.responders.delete(key);
    }
    this.abort(peer, sessionId, message);
  }

  private handleHello1(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    if (this.responders.has(key) || this.sessions.has(key)) return;
    const refusal = this.admissionRefusal(peer);
    if (refusal !== null) {
      this.abort(peer, sessionId, refusal);
      return;
    }
    const hello1 = Hello1Schema.parse(parseJson(body));
    assertHello1Sender(hello1, peer);
    // The slot counts against the peer's limits while it is authorized.
    const pending: PendingResponder = {
      handshake: null,
      grant: null,
      finishing: false,
      sessionId,
      timer: setTimeout(() => {
        if (this.responders.get(key) === pending) this.responders.delete(key);
      }, this.handshakeTimeoutMs),
    };
    this.responders.set(key, pending);
    void this.admitHello1(peer, sessionId, key, hello1, pending);
  }

  private async authorizeSafely(
    request: HandshakeAdmission,
  ): Promise<SessionGrant | null> {
    try {
      return await this.options.authorize(request);
    } catch {
      return null;
    }
  }

  private async admitHello1(
    peer: string,
    sessionId: Buffer,
    key: string,
    hello1: Hello1,
    pending: PendingResponder,
  ): Promise<void> {
    const grant = await this.authorizeSafely({
      stage: 'hello1',
      purpose: hello1.purpose,
      initiatorKey: hello1.initiatorKey,
      peerDeviceId: peer,
      delegation: hello1.delegation ?? null,
    });
    // Abandoned meanwhile: timed out, aborted, peer offline or shut down.
    if (this.disposed || this.responders.get(key) !== pending) return;
    try {
      if (grant === null) {
        throw new HandshakeError(
          'unauthorized_peer',
          'This computer has not allowed that device.',
        );
      }
      const handshake = new HandshakeResponder({
        sessionId,
        identity: this.options.identity(),
        peerDeviceId: peer,
        authorize: (): boolean => true,
      });
      const hello2 = handshake.receiveHello1(hello1);
      pending.handshake = handshake;
      pending.grant = grant;
      this.options.transport.sendFrame(
        peer,
        encodeEnvelope('hello2', sessionId, jsonBody(hello2)),
      );
    } catch (error) {
      this.failHandshake(peer, sessionId, key, error);
    }
  }

  /**
   * Tells a peer that a session it is using does not exist here, for example
   * because this computer restarted, so the peer ends it at once instead of
   * waiting for its keepalive to time out. Throttled per session; never sent
   * in reply to an abort, so two sides cannot bounce aborts.
   */
  private answerUnknownSession(
    peer: string,
    sessionId: Buffer,
    key: string,
  ): void {
    const now = Date.now();
    const last = this.abortedUnknown.get(key);
    if (last !== undefined && now - last < UNKNOWN_SESSION_ABORT_WINDOW_MS) {
      return;
    }
    if (this.abortedUnknown.size >= MAX_TRACKED_UNKNOWN_SESSIONS) {
      for (const [tracked, at] of Array.from(this.abortedUnknown)) {
        if (now - at >= UNKNOWN_SESSION_ABORT_WINDOW_MS) {
          this.abortedUnknown.delete(tracked);
        }
      }
      if (this.abortedUnknown.size >= MAX_TRACKED_UNKNOWN_SESSIONS) return;
    }
    this.abortedUnknown.set(key, now);
    this.abort(peer, sessionId, UNKNOWN_SESSION_MESSAGE);
  }

  private handleHello2(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    const pending = this.initiators.get(key);
    if (!pending) {
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    const hello3 = pending.handshake.receiveHello2(
      Hello2Schema.parse(parseJson(body)),
    );
    this.options.transport.sendFrame(
      peer,
      encodeEnvelope('hello3', sessionId, jsonBody(hello3)),
    );
  }

  private handleHello3(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    const pending = this.responders.get(key);
    if (!pending) {
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    if (pending.finishing) return;
    const handshake = pending.handshake;
    const grant = pending.grant;
    if (handshake === null || grant === null) {
      throw new HandshakeError('unexpected_message', 'Unexpected hello3.');
    }
    const finished = handshake.receiveHello3(
      Hello3Schema.parse(parseJson(body)),
    );
    pending.finishing = true;
    void this.finishResponder(peer, sessionId, key, pending, grant, finished);
  }

  private async finishResponder(
    peer: string,
    sessionId: Buffer,
    key: string,
    pending: PendingResponder,
    first: SessionGrant,
    finished: { hello4: Hello4; result: HandshakeResult },
  ): Promise<void> {
    const { hello4, result } = finished;
    // Authorized at hello1; check again now, since the peer may have been
    // revoked, or its delegation lapsed, while the handshake was in flight.
    const grant = await this.authorizeSafely({
      stage: 'hello3',
      purpose: result.purpose,
      initiatorKey: result.peerPublicKey,
      peerDeviceId: peer,
      delegation: result.delegation,
    });
    if (this.disposed || this.responders.get(key) !== pending) return;
    clearTimeout(pending.timer);
    this.responders.delete(key);
    if (grant === null || !sameGrant(first, grant)) {
      this.abort(peer, sessionId, 'This computer is not allowed to connect.');
      return;
    }
    const session = this.createSession(sessionId, result, grant);
    this.trackSession(key, session);
    if (session.purpose === 'control') {
      // A controller that handshakes again has given up on its suspended
      // sessions here; end them now rather than at their deadline.
      for (const other of Array.from(this.sessions.values())) {
        if (
          other === session ||
          other.peerDeviceId !== peer ||
          other.role !== 'responder' ||
          other.state === 'active'
        ) {
          continue;
        }
        if (other.isLingering) this.forget(other);
        else other.close('peer_offline');
      }
    }
    const sent = this.options.transport.sendFrame(
      peer,
      encodeEnvelope('hello4', sessionId, jsonBody(hello4)),
    );
    if (!sent) {
      // The initiator never learns the handshake finished, so it would never
      // use this session: end it rather than serve one side of it.
      session.close('transport_error');
      return;
    }
    this.options.onIncomingSession(session);
  }

  private handleHello4(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    const pending = this.initiators.get(key);
    if (!pending) {
      // The initiator gave up (timed out); the responder's new session must
      // not wait for a keepalive timeout to end.
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    const result = pending.handshake.receiveHello4(
      Hello4Schema.parse(parseJson(body)),
    );
    clearTimeout(pending.timer);
    this.initiators.delete(key);
    const session = this.createSession(sessionId, result, null);
    this.trackSession(key, session);
    pending.resolve(session);
  }

  private handleAbort(key: string, body: Buffer): void {
    const session = this.sessions.get(key);
    if (session) {
      if (session.isLingering) this.forget(session);
      else session.close('peer_closed');
      return;
    }
    const responder = this.responders.get(key);
    if (responder) {
      // The initiator gave up; free its slot now, not at the timeout.
      clearTimeout(responder.timer);
      this.responders.delete(key);
      return;
    }
    const pending = this.initiators.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.initiators.delete(key);
    const parsed = parseJson(body);
    const message =
      parsed !== null &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof parsed.message === 'string'
        ? parsed.message
        : 'The other computer refused the connection.';
    pending.reject(new HandshakeError('unauthorized_peer', message));
  }

  /**
   * Abandons every handshake in flight with `peer`, so a handshake that was
   * authorized before a revocation cannot finish after it.
   */
  private cancelHandshakes(peer: string, reason: SessionCloseReason): void {
    const message =
      reason === 'peer_offline'
        ? 'The other computer went offline.'
        : 'The connection was closed.';
    for (const [key, pending] of Array.from(this.initiators)) {
      if (!key.startsWith(`${peer}:`)) continue;
      clearTimeout(pending.timer);
      this.initiators.delete(key);
      pending.reject(new Error(message));
    }
    for (const [key, pending] of Array.from(this.responders)) {
      if (!key.startsWith(`${peer}:`)) continue;
      clearTimeout(pending.timer);
      this.responders.delete(key);
      if (reason !== 'peer_offline') {
        this.abort(peer, pending.sessionId, message);
      }
    }
  }

  /**
   * The peer is unreachable: its handshakes fail at once, and each session
   * with it suspends if it can resume and closes if not.
   */
  private handlePeerOffline(peer: string): void {
    this.cancelHandshakes(peer, 'peer_offline');
    for (const session of Array.from(this.sessions.values())) {
      if (session.peerDeviceId !== peer) continue;
      if (!session.suspend()) session.close('peer_offline');
    }
  }

  /**
   * The peer is reachable. The controller asks to resume every session with
   * it that can, active ones too: a peer that reconnected without going
   * offline first may have lost frames this side sent.
   */
  private handlePeerOnline(peer: string): void {
    if (this.disposed) return;
    for (const session of Array.from(this.sessions.values())) {
      if (
        session.peerDeviceId === peer &&
        session.role === 'initiator' &&
        session.resumable
      ) {
        session.markResuming();
        this.sendResume1(session);
      }
    }
  }

  private beginEpisode(session: SecureSession): void {
    if (this.episodes.has(session) || session.isClosed) return;
    const initiator = session.role === 'initiator';
    const deadlines = this.options.resumeDeadlineMs;
    const deadlineMs = initiator
      ? (deadlines?.initiator ?? CONTROLLER_RESUME_DEADLINE_MS)
      : (deadlines?.responder ?? HOST_RESUME_DEADLINE_MS);
    // Past the deadline, the controller handshakes again and reloads.
    const deadline = setTimeout(() => {
      if (session.isLingering) this.forget(session);
      else session.close('peer_offline');
    }, deadlineMs);
    deadline.unref?.();
    let retry: ReturnType<typeof setInterval> | null = null;
    if (initiator) {
      retry = setInterval(() => {
        session.markResuming();
        this.sendResume1(session);
      }, this.options.resumeRetryMs ?? RESUME_RETRY_MS);
      retry.unref?.();
    }
    this.episodes.set(session, {
      deadline,
      retry,
      nonce: createResumeNonce(),
      authorizing: false,
    });
  }

  private endEpisode(session: SecureSession): void {
    const episode = this.episodes.get(session);
    if (!episode) return;
    clearTimeout(episode.deadline);
    if (episode.retry) clearInterval(episode.retry);
    this.episodes.delete(session);
  }

  private sendResume1(session: SecureSession): void {
    const episode = this.episodes.get(session);
    if (!episode || session.state !== 'resuming') return;
    const resume1 = buildResume1(
      session.handshake.resumeKey,
      session.sessionId,
      episode.nonce,
      session.nextReceiveCounter,
    );
    const sent = this.options.transport.sendFrame(
      session.peerDeviceId,
      encodeEnvelope('resume1', session.sessionId, jsonBody(resume1)),
    );
    // Not connected to the relay: wait for it, and for the peer, again.
    if (!sent) session.suspend();
  }

  /** Host: the controller asks to continue a session after a drop. */
  private handleResume1(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    const session = this.sessions.get(key);
    if (!session) {
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    // Only the controller asks.
    if (session.role !== 'responder') return;
    const parsed = Resume1Schema.safeParse(parseJson(body));
    const opened = parsed.success
      ? openResume1(session.handshake.resumeKey, sessionId, parsed.data)
      : null;
    // Not from the session's peer, or damaged: drop it, changing nothing.
    if (opened === null) return;
    if (
      !session.resumable &&
      !session.isLingering &&
      session.state !== 'active'
    ) {
      // Its held frames are gone; the controller must handshake again.
      session.close('transport_error');
      return;
    }
    // Re-asked before an answer: the controller asks again if it is lost.
    if (this.episodes.get(session)?.authorizing === true) return;
    const episode = this.episodes.get(session);
    if (episode) episode.authorizing = true;
    void this.admitResume(peer, session, opened);
  }

  private async admitResume(
    peer: string,
    session: SecureSession,
    request: { nonce: Buffer; nextExpected: bigint },
  ): Promise<void> {
    // Authorized at the handshake; check again, so a revocation during the
    // drop holds.
    const grant = await this.authorizeSafely({
      stage: 'resume',
      purpose: session.purpose,
      initiatorKey: session.handshake.peerPublicKey,
      peerDeviceId: peer,
      delegation: session.handshake.delegation,
    });
    const episode = this.episodes.get(session);
    if (episode) episode.authorizing = false;
    if (this.disposed || (session.isClosed && !session.isLingering)) return;
    if (
      grant === null ||
      session.grant === null ||
      !sameGrant(session.grant, grant)
    ) {
      // Nothing held is delivered to a controller no longer allowed.
      if (session.isLingering) {
        this.forget(session);
        this.abort(peer, session.sessionId, 'revoked');
      } else {
        session.close('revoked');
      }
      return;
    }
    const resume2 = buildResume2(
      session.handshake.resumeKey,
      session.sessionId,
      request.nonce,
      session.nextReceiveCounter,
    );
    const sent = this.options.transport.sendFrame(
      peer,
      encodeEnvelope('resume2', session.sessionId, jsonBody(resume2)),
    );
    if (!sent) {
      // Still suspended, or lingering, the controller asks again; an active
      // session cannot be left waiting for an answer that never went out.
      if (session.state === 'active') session.close('transport_error');
      return;
    }
    if (!session.resumable && !session.isLingering) {
      // Active, but missing frames since its buffer overflowed: a
      // re-announced peer that lost nothing carries on; one that did lose
      // frames sees the gap and ends the session.
      return;
    }
    if (!session.resumeFrom(request.nextExpected)) {
      if (session.isLingering) this.forget(session);
      else session.close('protocol_error');
      return;
    }
    if (session.isClosed && !session.isLingering) this.forget(session);
  }

  /** Controller: the host's answer to resume1. */
  private handleResume2(
    peer: string,
    sessionId: Buffer,
    key: string,
    body: Buffer,
  ): void {
    const session = this.sessions.get(key);
    if (!session) {
      this.answerUnknownSession(peer, sessionId, key);
      return;
    }
    // Accepted while suspended too: an undeliverable retry may have set it
    // back after the host already answered.
    if (session.role !== 'initiator' || session.state === 'active') return;
    const episode = this.episodes.get(session);
    const parsed = Resume2Schema.safeParse(parseJson(body));
    const nextExpected =
      episode && parsed.success
        ? openResume2(
            session.handshake.resumeKey,
            sessionId,
            episode.nonce,
            parsed.data,
          )
        : null;
    // An answer to an earlier episode's nonce, or forged: ignore it; the
    // retry asks again.
    if (nextExpected === null) return;
    if (!session.resumeFrom(nextExpected)) session.close('protocol_error');
  }
}
