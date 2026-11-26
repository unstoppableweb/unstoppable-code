import { classifyError } from '@canopy/protocol/app-errors/classification';
import { randomBytes } from 'node:crypto';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import type {
  HostedDelegation,
  HostedFirstPartyClient,
} from '@canopy/protocol/remote-control';
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
  decodeMessage,
  deflateSmallMessage,
  encodeAckFragment,
  fragmentPayload,
  inflateSmallMessage,
  isTransportControlFragment,
  MAX_MESSAGE_BYTES,
  MessageAssembler,
  serializeMessage,
  SYNC_CODEC_BYTES,
  wantsCompression,
  zlibMessageCompressor,
  type AssembledMessage,
  type MessageCodecOptions,
  type MessageCompressor,
} from './message-codec';

export type RelayFrameSendFailure = 'disconnected' | 'queue-full';

export interface RelayFrameSendOptions {
  readonly includeFailureReason: true;
}

/** Minimal view of the relay connection the session layer needs. */
export interface RelayTransport {
  /** Boolean-only implementations can ignore options and return false. */
  sendFrame(
    peerDeviceId: string,
    payload: Uint8Array,
    options: RelayFrameSendOptions,
  ): boolean | RelayFrameSendFailure;
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
/**
 * Serialized bytes the send chains of all of a session manager's sessions
 * may hold together: what the relay client's own queue, which they share,
 * may already hold (`DEFAULT_MAX_QUEUED_BYTES`). A send that would pass it
 * ends its session, as a full relay queue ends a host session. It is never
 * sent uncompressed instead: sealed that way while suspended, it could
 * overflow the re-send buffer where its deflated size fits.
 */
export const SEND_CHAIN_BYTES = 2 * MAX_MESSAGE_BYTES;

/** Serialized bytes waiting on send chains, shared by a manager's sessions. */
export interface SendBudget {
  used: number;
  readonly limit: number;
}
/**
 * At most this many messages are sealed and handed over from the send chain
 * before main gets a turn, so a backlog freed by one deflate does not hold
 * it.
 */
const SEND_BATCH_MESSAGES = 256;
/**
 * Bytes of received message fragments and whole messages a session's receive
 * chain may hold while one ahead of them is inflated: the most one message
 * may already take while its fragments arrive. Past it the session ends as
 * for an oversized message.
 */
export const RECEIVE_CHAIN_BYTES = MAX_MESSAGE_BYTES;
/**
 * Minimum charge per message waiting on the receive chain, so tiny or empty
 * messages cannot queue without bound behind one being inflated.
 */
const RECEIVE_ENTRY_MIN_BYTES = 1024;

function receiveChainCharge(payload: Buffer): number {
  return Math.max(payload.byteLength, RECEIVE_ENTRY_MIN_BYTES);
}

/**
 * At most this many messages are delivered from the receive chain before
 * main gets a turn, so a backlog freed by one inflate does not hold it.
 */
const RECEIVE_BATCH_MESSAGES = 256;

/** A first-in, first-out queue whose shift is O(1). */
class Fifo<T> {
  private items: Array<T | undefined> = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  peek(): T | undefined {
    return this.items[this.head];
  }

  push(item: T): void {
    this.items.push(item);
  }

  shift(): void {
    if (this.head >= this.items.length) return;
    this.items[this.head] = undefined;
    this.head += 1;
    if (this.head === this.items.length) {
      this.clear();
    } else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }

  /** Removes and returns every item, in order. */
  takeAll(): T[] {
    const taken: T[] = [];
    for (let index = this.head; index < this.items.length; index += 1) {
      const item = this.items[index];
      if (item !== undefined) taken.push(item);
    }
    this.clear();
    return taken;
  }

  /** Keeps only the items `keep` accepts, in order. */
  retainWhere(keep: (item: T) => boolean): void {
    const kept = this.takeAll().filter(keep);
    this.items = kept;
  }

  [Symbol.iterator](): Iterator<T> {
    const items = this.items.slice(this.head);
    let index = 0;
    return {
      next: (): IteratorResult<T> => {
        while (index < items.length) {
          const item = items[index];
          index += 1;
          if (item !== undefined) return { value: item, done: false };
        }
        return { value: undefined, done: true };
      },
    };
  }
}
/** Acks follow received data within this long, or after this many bytes. */
const ACK_INTERVAL_MS = 250;

/**
 * Runs one asynchronous inflate at a time in the process, across sessions,
 * so peak inflate memory is one message, as it was when inflate ran on main.
 * `run` returns a cancel that removes a job still waiting, so a closed
 * session's payload is not retained here.
 */
class InflateGate {
  private running = false;
  private readonly waiting = new Set<() => void>();

  run(task: () => Promise<void>): (() => void) | null {
    if (!this.running) {
      this.start(task);
      return null;
    }
    const job = (): void => this.start(task);
    this.waiting.add(job);
    return () => {
      this.waiting.delete(job);
    };
  }

  private start(task: () => Promise<void>): void {
    this.running = true;
    let work: Promise<void>;
    try {
      work = task();
    } catch {
      this.next();
      return;
    }
    work.then(
      () => this.next(),
      () => this.next(),
    );
  }

  private next(): void {
    const next = this.waiting.values().next();
    if (next.done) {
      this.running = false;
      return;
    }
    this.waiting.delete(next.value);
    next.value();
  }
}

const inflateGate = new InflateGate();

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
/**
 * Late data and resume frames for a session that just closed in-band are
 * dropped quietly for this window instead of triggering an unknown-session
 * abort that could overtake the peer's async inflate.
 */
const IN_BAND_CLOSE_QUIET_MS = 10_000;
const MAX_TRACKED_IN_BAND_CLOSES = 256;

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
  /**
   * The first-party server caller a verified v2 delegation names (CAN-7604),
   * such as the web's Slack worker. Absent for every other session.
   */
  readonly firstPartyClient?: HostedFirstPartyClient;
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
    left.rootDeviceId === right.rootDeviceId &&
    left.firstPartyClient === right.firstPartyClient
  );
}

/** How often a session acknowledges received data. */
export interface AckCadence {
  bytes: number;
  intervalMs: number;
}

export interface SecureSessionOptions {
  /** Overrides {@link RESEND_BUFFER_BYTES}, for tests. */
  resendBufferBytes?: number;
  /**
   * Overrides {@link ACK_BYTES} and {@link ACK_INTERVAL_MS}, for tests of a
   * peer that acknowledges late.
   */
  ackCadence?: AckCadence;
  /** Overrides the thread-pool zlib, for tests and the codec worker. */
  compressor?: MessageCompressor;
  /**
   * The budget this session's send chain shares with the manager's other
   * sessions; by default its own, of {@link SEND_CHAIN_BYTES}.
   */
  sendBudget?: SendBudget;
  /** Overrides {@link RECEIVE_CHAIN_BYTES}, for tests. */
  receiveChainBytes?: number;
}

/** A message waiting on the send chain. */
interface QueuedSend {
  serialized: Buffer;
  compress: boolean;
  /** Kept by `discardUnsent`: an RPC response the peer is waiting for. */
  keepOnDiscard: boolean;
  /** Undefined until deflated; null when it goes uncompressed. */
  deflated: Buffer | null | undefined;
}

/** A whole assembled message waiting on the receive chain. */
interface QueuedReceive {
  payload: Buffer;
  compressed: boolean;
  /** Next receive counter immediately after this message's final fragment. */
  endCounter: bigint;
  /** Wire fragment bytes not yet accounted for in `noteReceived`. */
  ackBytes: number;
  inflated: Buffer | undefined;
  inflating: boolean;
  failed: boolean;
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
 *
 * Messages over {@link SYNC_CODEC_BYTES} are deflated off main (CAN-7764),
 * on an ordered send chain, so these rules hold whatever their sizes:
 *
 * - Send order. Messages are sealed and handed to the relay in the order
 *   `sendMessage` accepted them: a message waits behind any earlier one still
 *   being deflated. Only messages over {@link SYNC_CODEC_BYTES} are deflated
 *   on the thread pool; a smaller one with nothing ahead of it is deflated
 *   (from 8 KiB) and sealed at once, as before. Sealing assigns the frame
 *   counters, so sequence numbers, acks and the frames held for resume mean
 *   what they did; a message sealed while suspended is held like any other.
 *   A backlog freed by one deflate is sealed at most
 *   {@link SEND_BATCH_MESSAGES} per turn of main.
 * - Receive. Frames are opened and reassembled on main in arrival order.
 *   Compressed messages over {@link SYNC_CODEC_BYTES} are inflated on the
 *   thread pool through a process-wide {@link InflateGate}, one at a time;
 *   smaller ones stay on main unless an earlier message is still inflating
 *   ahead of them. A backlog freed by an inflate is delivered at most
 *   {@link RECEIVE_BATCH_MESSAGES} per turn of main. A message's final
 *   fragment is acknowledged (and reported in resume counters) only after
 *   the message is delivered, so the peer is never told an undelivered
 *   message was received. Any end condition closes the session immediately
 *   and drops messages still waiting on the receive chain.
 * - Close. `closeAfterDelivery`, the RPC peer's close, stops delivering at
 *   once and refuses new sends, but still reads acks, then closes once every
 *   message it accepted is sealed, deflated as usual, so a suspended host
 *   still holds them for the controller's resume. `close` ends the session
 *   at once: messages accepted but not yet sealed are dropped, except on
 *   `shutdown` (the session manager disposing, the app quitting), which
 *   first hands over what is queued, deflated as usual, dropping only a
 *   message over 32 KiB whose deflate has not finished. `isEnding` is true
 *   from the moment a close starts draining. `discardUnsent` drops queued
 *   events, requests and large replies without closing, for a revocation
 *   that still sends its ending; queued RPC responses up to 32 KiB stay, as
 *   the `pair.revoke` reply must go out before the ending. A deflate still
 *   running finishes on the thread pool and is ignored.
 * - Memory. The send chains of a manager's sessions hold at most
 *   {@link SEND_CHAIN_BYTES} together, the bound the relay client's queue
 *   they share already has; a send that would wait past it ends its
 *   session with `transport_error`. One sealed at once is never held, so
 *   it is never refused. Each session runs at most one deflate
 *   at a time, and holds its slot until it settles, even when its message
 *   was dropped meanwhile.
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
  private readonly heldReleaseListeners = new Set<() => void>();
  private closedReason: SessionCloseReason | null = null;
  private lastReceivedAtValue = Date.now();
  /** When the handshake finished (wall clock). */
  readonly establishedAt = Date.now();
  private stateValue: Exclude<SessionState, 'closed'> = 'active';
  private resumeNegotiatedValue = false;
  /** True once resume was agreed at hello, even if later disabled on preview revocation. */
  private resumeEverNegotiated = false;
  /** Pairing sessions never resume, so never hold frames. */
  private retaining: boolean;
  private retained: RetainedFrame[] = [];
  private retainedBytes = 0;
  private readonly resendBufferBytes: number;
  private unackedBytes = 0;
  private readonly ackCadence: AckCadence;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Closed while suspended, still holding frames for the peer's resume. */
  private lingering = false;
  private readonly compressor: MessageCompressor;
  private readonly sendBudget: SendBudget;
  private readonly sendChain = new Fifo<QueuedSend>();
  private sendChainBytes = 0;
  /** The next batch of the send chain is due on a later turn. */
  private sendYield: ReturnType<typeof setImmediate> | null = null;
  /** The message whose deflate is running; one per session at a time. */
  private deflating: QueuedSend | null = null;
  /**
   * Bytes of a message dropped from the send chain while its deflate still
   * runs: the compressor holds its buffer until it settles, so they stay
   * charged to the shared send budget until then.
   */
  private droppedDeflateBytes = 0;
  /** A message's fragments are being sealed and handed over. */
  private sending = false;
  /**
   * A shutdown is handing over what was queued: a failed send stops it but
   * leaves the reason to the shutdown.
   */
  private handingOver = false;
  /** `closeAfterDelivery` is waiting for the send chain to drain. */
  private closingAfterDelivery: SessionCloseReason | null = null;
  /**
   * `closeAfterDelivery` is draining sends: frames are still opened, so
   * acks free held frames, but no message is reassembled or delivered.
   */
  private deliveryEnded = false;
  private inBandCloseSent = false;
  private closedInBandValue = false;
  private readonly receiveChain = new Fifo<QueuedReceive>();
  private receiveChainBytes = 0;
  private readonly receiveChainLimit: number;
  /** The next batch of the receive chain is due on a later turn. */
  private receiveYield: ReturnType<typeof setImmediate> | null = null;
  /** Messages are currently being delivered from the receive chain. */
  private delivering = false;
  /** Cancels a queued inflate waiting on the process-wide gate. */
  private cancelQueuedInflate: (() => void) | null = null;
  /**
   * Highest receive counter safe to advertise in acks and resume frames:
   * never advances past an undelivered message.
   */
  private ackableReceiveCounter = BigInt(0);
  /** Wire bytes of fragments buffered while waiting behind the receive chain. */
  private assemblerAckBytes = 0;

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
    this.ackCadence = options.ackCadence ?? {
      bytes: ACK_BYTES,
      intervalMs: ACK_INTERVAL_MS,
    };
    this.compressor = options.compressor ?? zlibMessageCompressor;
    this.sendBudget = options.sendBudget ?? {
      used: 0,
      limit: SEND_CHAIN_BYTES,
    };
    this.receiveChainLimit = options.receiveChainBytes ?? RECEIVE_CHAIN_BYTES;
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

  /**
   * Closed, or closing: draining after the RPC peer's close. Callers that
   * decide whether the session still serves its controller treat it as gone
   * from that moment.
   */
  get isEnding(): boolean {
    return this.closedReason !== null || this.closingAfterDelivery !== null;
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

  /**
   * The counter of the first frame from the peer not yet acknowledged as
   * received; never advances past a message still waiting on the receive chain.
   */
  get nextReceiveCounter(): bigint {
    return this.ackableReceiveCounter;
  }

  /**
   * Closed after handing an in-band RPC close frame to an active relay link,
   * so an out-of-band abort would race ahead of the peer's async inflate.
   */
  get closedInBand(): boolean {
    return this.closedInBandValue;
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

  /**
   * Sealed bytes held for a resume that the peer has not acknowledged yet,
   * plus the serialized bytes of messages still on the send chain, which
   * will be held once sealed. Senders that can wait, such as tunnel streams,
   * hold back while it is high, so the re-send buffer never overflows and
   * resume stays possible.
   */
  get heldBytes(): number {
    return this.holdsFrames
      ? this.retainedBytes + this.sendChainBytes
      : this.retainedBytes;
  }

  /** Whether sealed frames are held for a resume. */
  private get holdsFrames(): boolean {
    return this.retaining || this.resumeNegotiatedValue;
  }

  /** Told whenever held bytes are let go, usually because an ack arrived. */
  onHeldBytesReleased(listener: () => void): () => void {
    this.heldReleaseListeners.add(listener);
    return () => this.heldReleaseListeners.delete(listener);
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
    this.resumeEverNegotiated = true;
  }

  /**
   * Sends one message, in order after every message accepted before it.
   * Returns false when the session or relay is down. True means it was
   * handed to the relay, or will be in order unless the session ends first.
   */
  sendMessage(
    value: unknown,
    options: Pick<MessageCodecOptions, 'onSerialized' | 'compress'> & {
      /** An RPC response, kept by `discardUnsent`. */
      keepOnDiscard?: boolean;
    } = {},
  ): boolean {
    if (this.closedReason !== null || this.closingAfterDelivery !== null)
      return false;
    // An unserializable value throws here and fails only this message.
    const serialized = serializeMessage(value, options);
    const compress = wantsCompression(serialized, options);
    // Sealed in this call: nothing ahead of it and no deflate to wait for,
    // so it is never held and the shared budget does not apply.
    const sealsAtOnce =
      this.sendChain.length === 0 &&
      this.sendYield === null &&
      !this.sending &&
      (!compress || serialized.byteLength <= SYNC_CODEC_BYTES);
    if (
      !sealsAtOnce &&
      this.sendBudget.used + serialized.byteLength > this.sendBudget.limit
    ) {
      // Deflate is not keeping up with what main accepts.
      this.close('transport_error');
      return false;
    }
    this.sendChain.push({
      serialized,
      compress,
      keepOnDiscard: options.keepOnDiscard === true,
      deflated: undefined,
    });
    this.setQueuedBytes(this.sendChainBytes + serialized.byteLength);
    this.pumpSendChain();
    return this.closedReason === null;
  }

  /**
   * Seals and hands over messages from the head of the send chain until one
   * still needs deflating, which it starts.
   */
  private pumpSendChain(): void {
    // A send from a listener while fragments go out joins the chain; the
    // running pump reaches it, so fragments never interleave. With a batch
    // continuation pending, that continuation reaches it, in order.
    if (this.sending || this.sendYield !== null) return;
    let sealed = 0;
    while (this.sendChain.length > 0 && this.closedReason === null) {
      const head = this.sendChain.peek();
      if (!head) return;
      if (sealed >= SEND_BATCH_MESSAGES) {
        // The rest follow on a later turn, still ahead of anything newer.
        this.yieldSend();
        return;
      }
      if (head.compress && head.deflated === undefined) {
        if (head.serialized.byteLength > SYNC_CODEC_BYTES) {
          this.startDeflate(head);
          return;
        }
        head.deflated = this.deflateSmall(head.serialized);
      }
      this.sendChain.shift();
      this.setQueuedBytes(this.sendChainBytes - head.serialized.byteLength);
      sealed += 1;
      this.transmit(
        head.deflated
          ? fragmentPayload(head.deflated, true)
          : fragmentPayload(head.serialized, false),
      );
      // Held bytes changed from its serialized size to its sealed size.
      if (this.closedReason === null && this.holdsFrames)
        this.notifyHeldReleased();
    }
    if (
      this.sendChain.length === 0 &&
      this.closingAfterDelivery !== null &&
      this.closedReason === null
    ) {
      this.finishCloseAfterDelivery(this.closingAfterDelivery);
    }
  }

  /**
   * After messages are dropped from the send chain: a deflate still running
   * was for the chain's head, so if that message is gone its bytes stay
   * charged until the deflate settles.
   */
  private keepDroppedDeflateCharged(): void {
    const running = this.deflating;
    if (
      running === null ||
      this.droppedDeflateBytes !== 0 ||
      this.sendChain.peek() === running
    )
      return;
    this.droppedDeflateBytes = running.serialized.byteLength;
    this.sendBudget.used += this.droppedDeflateBytes;
  }

  /** Sets this session's queued bytes, and the shared budget with them. */
  private setQueuedBytes(bytes: number): void {
    this.sendBudget.used += bytes - this.sendChainBytes;
    this.sendChainBytes = bytes;
  }

  private yieldSend(): void {
    if (this.sendYield !== null) return;
    this.sendYield = setImmediate(() => {
      this.sendYield = null;
      try {
        this.pumpSendChain();
      } catch {
        // A close listener's failure must not escape the event loop.
      }
    });
  }

  private deflateSmall(serialized: Buffer): Buffer | null {
    try {
      return deflateSmallMessage(serialized);
    } catch {
      // Nothing is lost by sending it as it is.
      return null;
    }
  }

  /** Starts the head's deflate, unless another one still holds the slot. */
  private startDeflate(entry: QueuedSend): void {
    if (this.deflating !== null) return;
    this.deflating = entry;
    this.compressor.deflate(entry.serialized).then(
      (deflated) => this.deflated(entry, deflated),
      // Nothing is lost by sending it as it is.
      () => this.deflated(entry, null),
    );
  }

  private deflated(entry: QueuedSend, deflated: Buffer | null): void {
    this.deflating = null;
    this.sendBudget.used -= this.droppedDeflateBytes;
    this.droppedDeflateBytes = 0;
    if (this.closedReason !== null) return;
    // Dropped meanwhile, it is not used; the next message may start its
    // deflate now.
    if (this.sendChain.peek() === entry) entry.deflated = deflated;
    try {
      this.pumpSendChain();
    } catch {
      // A close listener's failure must not become an unhandled rejection.
    }
  }

  /**
   * Drops every message accepted but not yet sealed, without closing, so a
   * revocation sends its ending with no event or request it accepted before
   * going out after it. Frames already sealed are unaffected. RPC responses
   * up to {@link SYNC_CODEC_BYTES} still waiting are kept, in order: they
   * answer requests the peer made while it was allowed to (the reply to
   * `pair.revoke` among them, which the protocol sends before the ending).
   * Larger responses, such as file contents, are dropped with the rest, so a
   * revoked controller waits for no deflate to receive them. A pending
   * `closeAfterDelivery` is cancelled too, so the ending and its own close
   * can still be sent.
   */
  discardUnsent(): void {
    this.sendChain.retainWhere(
      (entry) =>
        entry.keepOnDiscard && entry.serialized.byteLength <= SYNC_CODEC_BYTES,
    );
    let kept = 0;
    for (const entry of this.sendChain) kept += entry.serialized.byteLength;
    this.setQueuedBytes(kept);
    this.keepDroppedDeflateCharged();
    if (this.sendChain.length === 0 && this.sendYield !== null) {
      // Nothing left for it: the ending that follows is sealed at once.
      clearImmediate(this.sendYield);
      this.sendYield = null;
    }
    this.closingAfterDelivery = null;
    this.inBandCloseSent = false;
    this.pumpSendChain();
  }

  /**
   * On shutdown, hands over the messages still queued, in order, as the
   * synchronous codec had already done: a revoked controller's
   * `session.ended`, queued behind a reply, still leaves before the relay
   * goes away. Each goes deflated as usual (up to 32 KiB on main), except a
   * larger one whose deflate has not finished, which is dropped as `close`
   * drops it: sent uncompressed it could fill the relay socket and strand
   * the ending behind it when the relay stops. What a revocation dropped is
   * no longer queued. Queued events and replies go too, on any shutdown
   * (a sign-out or account switch included): they were accepted while the
   * controller was allowed, and develop's synchronous codec had handed them
   * to the relay when they were sent. It runs in one turn of main, once, at
   * shutdown: it seals what develop would already have sealed at send
   * time, bounded by the shared send budget, and the relay is closed right
   * after, so it cannot wait for later turns.
   */
  private handOverQueued(): void {
    if (this.sending || this.sendChain.length === 0) return;
    const queued = this.sendChain.takeAll();
    this.setQueuedBytes(0);
    this.keepDroppedDeflateCharged();
    this.handingOver = true;
    try {
      for (const entry of queued) {
        if (entry.compress && entry.deflated === undefined) {
          if (entry.serialized.byteLength > SYNC_CODEC_BYTES) continue;
          entry.deflated = this.deflateSmall(entry.serialized);
        }
        const sent = this.transmit(
          entry.deflated
            ? fragmentPayload(entry.deflated, true)
            : fragmentPayload(entry.serialized, false),
        );
        if (!sent || this.closedReason !== null) return;
      }
    } finally {
      this.handingOver = false;
    }
  }

  /** Seals and hands over one message's fragments; false once closed. */
  private transmit(fragments: Buffer[]): boolean {
    this.sending = true;
    try {
      for (const fragment of fragments) {
        if (!this.sendFragment(fragment)) return false;
      }
      return true;
    } catch {
      // Encryption or socket failures must never escape into timers or event
      // handlers in main; end the session instead.
      this.close('transport_error');
      return false;
    } finally {
      this.sending = false;
    }
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
    if (this.holdsFrames) this.retain(counter, envelope);
    if (this.closedReason !== null) return false;
    if (this.stateValue !== 'active') return true;
    if (this.transport.sendFrame(this.peerDeviceId, envelope)) return true;
    if (this.handingOver) return false;
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
    const held = this.retainedBytes;
    this.retained = [];
    this.retainedBytes = 0;
    if (held > 0) this.notifyHeldReleased();
  }

  private notifyHeldReleased(): void {
    for (const listener of Array.from(this.heldReleaseListeners)) {
      try {
        listener();
      } catch {
        // A listener's failure must not reach the receive path.
      }
    }
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
    if (index === 0) return;
    this.retained = this.retained.slice(index);
    this.notifyHeldReleased();
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
    let assembled: AssembledMessage | null;
    try {
      fragment = this.channel.open(body, this.dataHeader);
      this.lastReceivedAtValue = Date.now();
      if (isTransportControlFragment(fragment)) {
        this.handleAck(decodeAckFragment(fragment));
        if (
          this.closedReason === null &&
          !this.deliveryEnded &&
          this.receiveChain.length === 0 &&
          !this.delivering &&
          this.assembler.bufferedBytes === 0 &&
          this.channel.nextReceiveCounter > this.ackableReceiveCounter
        ) {
          this.ackableReceiveCounter = this.channel.nextReceiveCounter;
        }
        return;
      }
      // Closing after delivery: acks above still free held frames.
      if (this.deliveryEnded) return;
      // Fragments of a message still arriving count against the same
      // per-session budget as whole messages waiting behind an inflate.
      const payloadBytes = Math.max(0, fragment.byteLength - 1);
      if (
        this.receiveChainBytes + this.assembler.bufferedBytes + payloadBytes >
        this.receiveChainLimit
      ) {
        this.close('protocol_error');
        return;
      }
      assembled = this.assembler.pushFragment(fragment);
    } catch {
      this.close('protocol_error');
      return;
    }
    if (assembled === null) {
      if (this.receiveChain.length === 0 && !this.delivering) {
        if (this.channel.nextReceiveCounter > this.ackableReceiveCounter) {
          this.ackableReceiveCounter = this.channel.nextReceiveCounter;
        }
        const ackBytes = this.assemblerAckBytes + fragment.byteLength;
        this.assemblerAckBytes = 0;
        this.noteReceived(ackBytes);
      } else {
        this.assemblerAckBytes += fragment.byteLength;
      }
      return;
    }
    const ackBytes = this.assemblerAckBytes + fragment.byteLength;
    this.assemblerAckBytes = 0;
    const charged = receiveChainCharge(assembled.payload);
    if (this.receiveChainBytes + charged > this.receiveChainLimit) {
      this.close('protocol_error');
      return;
    }
    this.receiveChain.push({
      payload: assembled.payload,
      compressed: assembled.compressed,
      endCounter: this.channel.nextReceiveCounter,
      ackBytes,
      inflated: undefined,
      inflating: false,
      failed: false,
    });
    this.receiveChainBytes += charged;
    this.pumpReceiveChain();
  }

  /**
   * Delivers messages from the head of the receive chain until one still
   * needs inflating on the thread pool, which it starts, or the batch cap is
   * reached.
   */
  private pumpReceiveChain(): void {
    // A frame received from a listener joins the chain; the running pump
    // reaches it in order. With a batch continuation pending, that
    // continuation reaches it, so a burst cannot deliver more than one batch
    // per turn of main.
    if (this.delivering || this.receiveYield !== null) return;
    this.delivering = true;
    let delivered = 0;
    try {
      while (
        this.receiveChain.length > 0 &&
        this.closedReason === null &&
        !this.deliveryEnded
      ) {
        const head = this.receiveChain.peek();
        if (!head) return;
        if (delivered >= RECEIVE_BATCH_MESSAGES) {
          this.yieldReceive();
          return;
        }
        if (head.failed) {
          this.close('protocol_error');
          return;
        }
        if (head.compressed && head.inflated === undefined) {
          if (head.inflating) return;
          const inflated = inflateSmallMessage(
            head.payload,
            this.assembler.maxMessageBytes,
          );
          if (inflated === null) {
            this.startInflate(head);
            return;
          }
          head.inflated = inflated;
        }
        this.receiveChain.shift();
        this.receiveChainBytes -= receiveChainCharge(head.payload);
        let value: unknown;
        try {
          value = decodeMessage(head.inflated ?? head.payload);
        } catch {
          this.close('protocol_error');
          return;
        }
        delivered += 1;
        for (const listener of Array.from(this.messageListeners)) {
          if (this.closedReason !== null || this.deliveryEnded) return;
          try {
            listener(value);
          } catch {
            // A listener's failure ends neither the session nor delivery.
          }
        }
        if (this.closedReason !== null || this.deliveryEnded) return;
        const nextAckable =
          this.receiveChain.length === 0 && this.assembler.bufferedBytes === 0
            ? this.channel.nextReceiveCounter
            : head.endCounter;
        if (nextAckable > this.ackableReceiveCounter) {
          this.ackableReceiveCounter = nextAckable;
        }
        this.noteReceived(head.ackBytes);
      }
    } finally {
      this.delivering = false;
    }
  }

  private yieldReceive(): void {
    if (this.receiveYield !== null) return;
    this.receiveYield = setImmediate(() => {
      this.receiveYield = null;
      try {
        this.pumpReceiveChain();
      } catch {
        // A close listener's failure must not escape the event loop.
      }
    });
  }

  private startInflate(entry: QueuedReceive): void {
    if (entry.inflating) return;
    entry.inflating = true;
    this.cancelQueuedInflate = inflateGate.run(() => {
      this.cancelQueuedInflate = null;
      if (
        this.closedReason !== null ||
        this.deliveryEnded ||
        this.receiveChain.peek() !== entry
      ) {
        return Promise.resolve();
      }
      let work: Promise<Buffer>;
      try {
        work = this.compressor.inflate(
          entry.payload,
          this.assembler.maxMessageBytes,
        );
      } catch {
        entry.failed = true;
        this.inflated(entry);
        return Promise.resolve();
      }
      return work.then(
        (inflated) => {
          entry.inflated = inflated;
          this.inflated(entry);
        },
        () => {
          entry.failed = true;
          this.inflated(entry);
        },
      );
    });
  }

  private inflated(entry: QueuedReceive): void {
    if (
      this.closedReason !== null ||
      this.deliveryEnded ||
      this.receiveChain.peek() !== entry
    ) {
      return;
    }
    try {
      this.pumpReceiveChain();
    } catch {
      // A listener's failure must not become an unhandled rejection.
    }
  }

  private clearReceiveChain(): void {
    this.receiveChain.clear();
    this.receiveChainBytes = 0;
    this.assembler.reset();
    this.assemblerAckBytes = 0;
    this.cancelQueuedInflate?.();
    this.cancelQueuedInflate = null;
    if (this.receiveYield !== null) clearImmediate(this.receiveYield);
    this.receiveYield = null;
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
    if (this.unackedBytes >= this.ackCadence.bytes) {
      this.sendAck();
      return;
    }
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.sendAck();
    }, this.ackCadence.intervalMs);
    this.ackTimer.unref?.();
  }

  /**
   * Acks belong to no message and the peer reads them before reassembly, so
   * they skip the send chain: the peer can release held frames while a large
   * message is still being deflated here.
   */
  private sendAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    // Not active yet: resume carries the counter, and resumeFrom flushes any
    // advance delivered while resuming.
    if (
      this.closedReason !== null ||
      this.deliveryEnded ||
      this.stateValue !== 'active'
    )
      return;
    this.unackedBytes = 0;
    try {
      this.sendFragment(encodeAckFragment(this.ackableReceiveCounter));
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
  resumeFrom(
    peerNextExpected: bigint,
    advertisedReceiveCounter?: bigint,
  ): boolean {
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
    if (
      !lingering &&
      this.resumeNegotiatedValue &&
      advertisedReceiveCounter !== undefined &&
      this.ackableReceiveCounter > advertisedReceiveCounter
    ) {
      this.sendAck();
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
  closeAfterDelivery(
    reason: SessionCloseReason,
    options: { inBandCloseSent?: boolean } = {},
  ): void {
    if (this.closedReason !== null || this.closingAfterDelivery !== null)
      return;
    this.inBandCloseSent = options.inBandCloseSent === true;
    if (this.sendChain.length === 0) {
      this.finishCloseAfterDelivery(reason);
      return;
    }
    // Messages still being deflated go first, compressed as usual, so a
    // suspended host holds no more than it would have. Nothing more is
    // delivered or accepted meanwhile; acks are still read.
    this.closingAfterDelivery = reason;
    this.deliveryEnded = true;
    this.clearReceiveChain();
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.messageListeners.clear();
    this.pumpSendChain();
  }

  private finishCloseAfterDelivery(reason: SessionCloseReason): void {
    if (
      this.role === 'responder' &&
      this.resumable &&
      this.stateValue !== 'active' &&
      this.retained.length > 0
    ) {
      this.lingering = true;
    } else if (
      this.resumeEverNegotiated &&
      this.purpose === 'control' &&
      this.stateValue === 'active' &&
      this.inBandCloseSent
    ) {
      // Resumable peers inflate large messages off main: skipping the
      // out-of-band abort after an in-band RPC close avoids overtaking a
      // queued inflate. Non-resumable peers (e.g. remote-session) still get
      // abort so bursts ending on 0x30 behave unchanged.
      this.closedInBandValue = true;
    }
    this.close(reason);
  }

  /** Lets go of a lingering session's held frames. */
  abandon(): void {
    this.lingering = false;
    this.dropRetained();
  }

  /**
   * Ends the session at once. Messages accepted but not yet sealed are
   * dropped, except on `shutdown`, which hands them over first; nothing
   * more is delivered.
   */
  close(reason: SessionCloseReason): void {
    if (this.closedReason !== null) return;
    if (reason === 'shutdown') this.handOverQueued();
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    this.sendChain.clear();
    this.setQueuedBytes(0);
    this.keepDroppedDeflateCharged();
    if (this.sendYield !== null) clearImmediate(this.sendYield);
    this.sendYield = null;
    this.clearReceiveChain();
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (!this.lingering) this.dropRetained();
    this.retaining = false;
    this.messageListeners.clear();
    this.stateListeners.clear();
    this.heldReleaseListeners.clear();
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
  /** Overrides the ack cadence for every session, for tests. */
  ackCadence?: AckCadence;
  /**
   * Overrides the thread-pool zlib for every session, for tests and the
   * codec worker (CAN-7768).
   */
  compressor?: MessageCompressor;
  /** Overrides {@link SEND_CHAIN_BYTES}, the sessions' shared limit, for tests. */
  sendChainBytes?: number;
  /** Overrides {@link RECEIVE_CHAIN_BYTES} for every session, for tests. */
  receiveChainBytes?: number;
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
  /** Lowest receive counter advertised by a sent resume1 in this episode. */
  advertisedReceiveCounter: bigint | null;
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
  /** Sessions recently closed in-band, and when; late data frames drop quietly. */
  private readonly closedInBandAt = new Map<string, number>();
  private readonly episodes = new Map<SecureSession, ResumeEpisode>();
  private readonly stateListeners = new Set<
    (session: SecureSession, state: SessionState) => void
  >();
  private readonly unsubscribers: Array<() => void>;
  private disposed = false;
  private readonly sendBudget: SendBudget;

  constructor(private readonly options: SessionManagerOptions) {
    this.sendBudget = {
      used: 0,
      limit: options.sendChainBytes ?? SEND_CHAIN_BYTES,
    };
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
        reject(
          classifyError(
            new Error('The other computer did not answer the connection.'),
            'external.service_unavailable',
          ),
        );
      }, this.handshakeTimeoutMs);
      this.initiators.set(key, { handshake, resolve, reject, timer });
      const sent = this.options.transport.sendFrame(
        options.peerDeviceId,
        encodeEnvelope('hello1', sessionId, jsonBody(handshake.start())),
        { includeFailureReason: true },
      );
      if (sent !== true) {
        clearTimeout(timer);
        this.initiators.delete(key);
        const error = new Error(
          sent === 'queue-full'
            ? 'Relay send queue is full.'
            : 'Not connected to the relay.',
        );
        reject(
          sent === 'disconnected'
            ? classifyError(error, 'external.offline')
            : error,
        );
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
    this.closedInBandAt.clear();
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
    const { resendBufferBytes, ackCadence, compressor, receiveChainBytes } =
      this.options;
    return new SecureSession(sessionId, result, this.options.transport, grant, {
      ...(resendBufferBytes === undefined ? {} : { resendBufferBytes }),
      ...(ackCadence === undefined ? {} : { ackCadence }),
      ...(compressor === undefined ? {} : { compressor }),
      sendBudget: this.sendBudget,
      ...(receiveChainBytes === undefined ? {} : { receiveChainBytes }),
    });
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
      if (session.closedInBand) {
        this.recordClosedInBand(key);
      } else if (reason !== 'peer_closed' && reason !== 'peer_offline') {
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
          else if (!this.wasRecentlyClosedInBand(key))
            this.answerUnknownSession(peer, envelope.sessionId, key);
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

  private recordClosedInBand(key: string): void {
    const now = Date.now();
    this.closedInBandAt.delete(key);
    if (this.closedInBandAt.size >= MAX_TRACKED_IN_BAND_CLOSES) {
      for (const [tracked, at] of Array.from(this.closedInBandAt)) {
        if (now - at >= IN_BAND_CLOSE_QUIET_MS) {
          this.closedInBandAt.delete(tracked);
        }
      }
      while (this.closedInBandAt.size >= MAX_TRACKED_IN_BAND_CLOSES) {
        const oldest = this.closedInBandAt.keys().next();
        if (oldest.done) break;
        this.closedInBandAt.delete(oldest.value);
      }
    }
    this.closedInBandAt.set(key, now);
  }

  private wasRecentlyClosedInBand(key: string): boolean {
    const at = this.closedInBandAt.get(key);
    if (at === undefined) return false;
    if (Date.now() - at >= IN_BAND_CLOSE_QUIET_MS) {
      this.closedInBandAt.delete(key);
      return false;
    }
    return true;
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
      const error = new Error(message);
      pending.reject(
        reason === 'peer_offline'
          ? classifyError(error, 'external.offline')
          : error,
      );
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
      advertisedReceiveCounter: null,
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
    const advertised = session.nextReceiveCounter;
    const resume1 = buildResume1(
      session.handshake.resumeKey,
      session.sessionId,
      episode.nonce,
      advertised,
    );
    const firstAttempt = episode.advertisedReceiveCounter === null;
    if (firstAttempt) episode.advertisedReceiveCounter = advertised;
    const sent = this.options.transport.sendFrame(
      session.peerDeviceId,
      encodeEnvelope('resume1', session.sessionId, jsonBody(resume1)),
    );
    // Not connected to the relay: wait for it, and for the peer, again.
    if (!sent) {
      if (firstAttempt) episode.advertisedReceiveCounter = null;
      session.suspend();
    }
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
      if (!this.wasRecentlyClosedInBand(key)) {
        this.answerUnknownSession(peer, sessionId, key);
      }
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
      if (!this.wasRecentlyClosedInBand(key)) {
        this.answerUnknownSession(peer, sessionId, key);
      }
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
    if (
      !session.resumeFrom(
        nextExpected,
        episode?.advertisedReceiveCounter ?? undefined,
      )
    ) {
      session.close('protocol_error');
    }
  }
}
