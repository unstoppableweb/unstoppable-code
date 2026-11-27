import { Buffer } from 'node:buffer';
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import {
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  CANOPY_JSON_RPC_VERSION,
  CanopyJsonRpcIdSchema,
  CanopyJsonRpcMessageSchema,
  parseCanopyJsonRpcMessage,
  type CanopyErrorKind,
  type CanopyErrorPayload,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';

import {
  CANOPY_DEFAULT_MAX_FRAME_BYTES,
  CanopyFrameDecoder,
  CanopyTransportError,
  encodeCanopyChannelDataFrame,
  encodeCanopyJsonFrame,
  encodeCanopyJsonMessage,
  type CanopyDecodedFrame,
} from './codec';
import {
  CanopyBindingFrameSchema,
  CanopyChannelOpenFrameSchema,
  CanopyDataRootHashSchema,
  type CanopyBindingFrame,
  type CanopyChannelCaps,
} from './frames';
import type {
  CanopyByteChannel,
  CanopyChannelListenerOptions,
  CanopyChannelOpenAttempt,
  CanopyChannelOpenRequest,
  CanopyFramedConnection,
} from './types';

export interface CanopyFramedAuthOptions {
  /** Token-file secret; never sent, only used to key the nonce proof. */
  readonly secret: string | Uint8Array;
  readonly dataRootHash: string;
}

export interface CanopyFramedConnectionOptions {
  readonly role: 'client' | 'server';
  readonly auth: CanopyFramedAuthOptions;
  readonly maxFrameBytes?: number;
  /**
   * Largest inbound envelope reassembled from message parts; one frame by
   * default. Peers learn it out of band, such as `core.runtime.initialize`.
   */
  readonly maxMessageBytes?: number;
  /** The peer's `maxMessageBytes`, when the composition already knows it. */
  readonly peerMaxMessageBytes?: number;
  /** Inbound envelopes held before the binding stops reading (backpressure). */
  readonly maxBufferedMessages?: number;
  /** Encoded bytes of inbound envelopes held before the binding stops reading. */
  readonly maxBufferedBytes?: number;
  /** Accepted channels are clamped to these receive caps and this count. */
  readonly maxChannels?: number;
  readonly maxChannelChunkBytes?: number;
  readonly maxChannelBufferedChunks?: number;
  /** Bytes in flight per accepted channel: `maxChunkBytes × maxBufferedChunks` stays within it. */
  readonly maxChannelBufferedBytes?: number;
  readonly handshakeTimeoutMs?: number;
  /** After a close, a duplex the peer has not finished closing is destroyed. */
  readonly closeTimeoutMs?: number;
}

const DEFAULT_MAX_BUFFERED_MESSAGES = 256;
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Receive caps an accepting end applies when its options leave them unset. */
export const CANOPY_DEFAULT_CHANNEL_LIMITS = {
  maxChannels: 16,
  maxChunkBytes: 256 * 1024,
  maxBufferedChunks: 16,
  // 16 channels x 4 MiB bounds channel buffering at 64 MiB per connection.
  maxBufferedBytes: 4 * 1024 * 1024,
} as const;
/** Effective accept-side channel limits: what an accepter enforces and advertises. */
export interface CanopyChannelReceiveLimits {
  readonly maxChannels: number;
  readonly maxChunkBytes: number;
  readonly maxBufferedChunks: number;
  readonly maxBufferedBytes: number;
}

type ChannelLimitOptions = Pick<
  CanopyFramedConnectionOptions,
  | 'maxFrameBytes'
  | 'maxChannels'
  | 'maxChannelChunkBytes'
  | 'maxChannelBufferedChunks'
  | 'maxChannelBufferedBytes'
>;

/**
 * Applies defaults and clamps: a chunk fits one data frame and the byte
 * budget, and the window holds at least one chunk.
 */
export function resolveCanopyChannelLimits(
  options: ChannelLimitOptions = {},
): CanopyChannelReceiveLimits {
  const maxBufferedBytes =
    options.maxChannelBufferedBytes ??
    CANOPY_DEFAULT_CHANNEL_LIMITS.maxBufferedBytes;
  const maxChunkBytes = Math.max(
    1,
    Math.min(
      options.maxChannelChunkBytes ??
        CANOPY_DEFAULT_CHANNEL_LIMITS.maxChunkBytes,
      (options.maxFrameBytes ?? CANOPY_DEFAULT_MAX_FRAME_BYTES) -
        CHANNEL_DATA_OVERHEAD_BYTES,
      maxBufferedBytes,
      MAX_CHANNEL_CHUNK_BYTES,
    ),
  );
  return {
    maxChannels:
      options.maxChannels ?? CANOPY_DEFAULT_CHANNEL_LIMITS.maxChannels,
    maxChunkBytes,
    maxBufferedChunks: windowFor(
      options.maxChannelBufferedChunks ??
        CANOPY_DEFAULT_CHANNEL_LIMITS.maxBufferedChunks,
      maxBufferedBytes,
      maxChunkBytes,
    ),
    maxBufferedBytes,
  };
}

/** Caps an accepter grants: never above the request or its limits. */
export function negotiateCanopyChannelCaps(
  requested: CanopyChannelCaps,
  limits: CanopyChannelReceiveLimits,
): CanopyChannelCaps {
  const maxChunkBytes = Math.min(requested.maxChunkBytes, limits.maxChunkBytes);
  return {
    maxChunkBytes,
    maxBufferedChunks: windowFor(
      Math.min(requested.maxBufferedChunks, limits.maxBufferedChunks),
      limits.maxBufferedBytes,
      maxChunkBytes,
    ),
  };
}

function windowFor(
  chunks: number,
  maxBufferedBytes: number,
  maxChunkBytes: number,
): number {
  return Math.max(
    1,
    Math.min(
      chunks,
      Math.floor(maxBufferedBytes / maxChunkBytes),
      MAX_CHANNEL_BUFFERED_CHUNKS,
    ),
  );
}

// Schema ceilings for negotiated caps (`CanopyChannelCapsSchema`).
const MAX_CHANNEL_CHUNK_BYTES = 16_777_216;
const MAX_CHANNEL_BUFFERED_CHUNKS = 65_536;
// Unflushed replies (protocol errors, channel acks) tolerated before a peer that
// does not read is dropped.
const MAX_PENDING_REPLIES = 16;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
// Tag, id length, and a 64-byte channel id precede the chunk in a data frame.
const CHANNEL_DATA_OVERHEAD_BYTES = 66;

function transportError(
  kind: CanopyErrorKind,
  message: string,
  details?: CanopyErrorPayload['details'],
): CanopyErrorPayload {
  return {
    kind,
    message,
    ...(details === undefined ? {} : { details }),
    retry:
      kind === 'unavailable' ? { kind: 'same_request' } : { kind: 'never' },
  };
}

const CONNECTION_CLOSED = transportError('unavailable', 'Connection closed.');

const BINDING_FRAME_TYPES: ReadonlySet<unknown> = new Set(
  CanopyBindingFrameSchema.options.map((option) => option.shape.type.value),
);

function payloadOf(error: unknown): CanopyErrorPayload {
  return error instanceof CanopyTransportError
    ? error.payload
    : transportError('internal', 'Transport failure.');
}

/** Base64url HMAC-SHA256 of the challenge nonce keyed by the token-file secret (D3). */
export function createCanopyAuthProof(
  secret: string | Uint8Array,
  nonce: string,
): string {
  return createHmac('sha256', secret).update(nonce).digest('base64url');
}

function proofMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Keeps an owner proof from ever matching an auth proof (CAN-5771). */
export const CANOPY_OWNER_PROOF_LABEL = 'canopy-daemon-owner-v1';

/**
 * Base64url HMAC-SHA256, keyed by a daemon's owner secret, over this
 * connection's server-issued id and the data root hash (CAN-5771). Valid on
 * that one connection only.
 */
export function createCanopyOwnerProof(
  secret: Uint8Array,
  connectionId: string,
  dataRootHash: string,
): string {
  return createHmac('sha256', secret)
    .update(
      `${CANOPY_OWNER_PROOF_LABEL}\n${connectionId}\n${dataRootHash}`,
      'utf8',
    )
    .digest('base64url');
}

/** Timing-safe comparison of two proofs (the file's `proofMatches`). */
export function canopyOwnerProofMatches(
  expected: string,
  actual: string,
): boolean {
  return proofMatches(expected, actual);
}

/** Keeps a desktop peer proof from ever matching an owner proof. */
export const CANOPY_DESKTOP_PEER_PROOF_LABEL = 'canopy-daemon-desktop-peer-v1';

/**
 * Base64url HMAC-SHA256, keyed by a daemon's owner secret, over this
 * connection's server-issued id and the data root hash: proves an
 * ordinary connection comes from the desktop that launched the daemon. Valid
 * on that one connection only, and never as an owner proof.
 */
export function createCanopyDesktopPeerProof(
  secret: Uint8Array,
  connectionId: string,
  dataRootHash: string,
): string {
  return createHmac('sha256', secret)
    .update(
      `${CANOPY_DESKTOP_PEER_PROOF_LABEL}\n${connectionId}\n${dataRootHash}`,
      'utf8',
    )
    .digest('base64url');
}

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: CanopyTransportError): void;
}

/** Queue whose readers wait; `end` drains buffered values before failing. */
class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private ended: CanopyErrorPayload | null = null;
  /** Sum of `weigh` over buffered values. */
  weight = 0;

  constructor(
    private readonly onDequeue: () => void = (): void => {},
    private readonly weigh: (value: T) => number = (): number => 0,
    private readonly onDirectDelivery = false,
  ) {}

  get size(): number {
    return this.values.length;
  }

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (this.onDirectDelivery) this.onDequeue();
      return waiter.resolve(value);
    }
    this.values.push(value);
    this.weight += this.weigh(value);
  }

  next(signal?: AbortSignal): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) {
      this.weight -= this.weigh(value);
      this.onDequeue();
      return Promise.resolve(value);
    }
    if (this.ended) return Promise.reject(new CanopyTransportError(this.ended));
    if (signal?.aborted)
      return Promise.reject(
        new CanopyTransportError(transportError('cancelled', 'Cancelled.')),
      );
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(
          new CanopyTransportError(transportError('cancelled', 'Cancelled.')),
        );
      };
      const waiter: Waiter<T> = {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  end(reason: CanopyErrorPayload): void {
    this.ended ??= reason;
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new CanopyTransportError(reason));
  }
}

class FramedChannel implements CanopyByteChannel {
  private readonly controller = new AbortController();
  private readonly chunks = new AsyncQueue<Uint8Array>(
    () => this.chunkConsumed(),
    undefined,
    true,
  );
  private readonly creditWaiters: Waiter<void>[] = [];
  private sendCredit: number;
  /** Chunks written to the wire that the peer has not credited back yet. */
  private uncredited = 0;
  /** Credit the peer holds: the window, less deliveries, plus credit sent. */
  private peerCredit: number;
  private unreturned = 0;
  private terminalPayload: CanopyErrorPayload | null = null;
  readonly signal = this.controller.signal;

  constructor(
    private readonly connection: FramedConnection,
    readonly channelId: string,
    readonly kind: string,
    readonly leaseId: string,
    readonly caps: CanopyChannelCaps,
  ) {
    this.sendCredit = caps.maxBufferedChunks;
    this.peerCredit = caps.maxBufferedChunks;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.signal.aborted)
      throw new CanopyTransportError(this.terminalPayload ?? CONNECTION_CLOSED);
    if (bytes.length > this.caps.maxChunkBytes)
      throw new CanopyTransportError(
        transportError(
          'resource_exhausted',
          `Chunk exceeds the channel cap of ${this.caps.maxChunkBytes} bytes; split writes to at most ${this.caps.maxChunkBytes} bytes.`,
          { maxChunkBytes: this.caps.maxChunkBytes },
        ),
      );
    await this.acquireCredit();
    if (this.signal.aborted)
      throw new CanopyTransportError(this.terminalPayload ?? CONNECTION_CLOSED);
    this.uncredited += 1;
    await this.connection.writeFrame(
      encodeCanopyChannelDataFrame(
        this.channelId,
        bytes,
        this.connection.maxFrameBytes,
      ),
      this.signal,
      () => this.terminalPayload ?? CONNECTION_CLOSED,
    );
  }

  async read(options?: {
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array | null> {
    try {
      return await this.chunks.next(options?.signal);
    } catch (error) {
      if (this.signal.aborted && !options?.signal?.aborted) return null;
      throw error;
    }
  }

  close(error?: CanopyErrorPayload): void {
    if (this.signal.aborted) return;
    void this.connection
      .writeBinding({
        type: 'channel.close',
        channelId: this.channelId,
        error: error ?? null,
      })
      .catch(() => {});
    this.finish(error);
  }

  /** Inbound chunk; a peer that ignores the negotiated caps loses the channel. */
  deliver(bytes: Uint8Array): void {
    if (bytes.length > this.caps.maxChunkBytes)
      return this.close(
        transportError(
          'resource_exhausted',
          `A chunk exceeded the negotiated maxChunkBytes of ${this.caps.maxChunkBytes} bytes.`,
          { maxChunkBytes: this.caps.maxChunkBytes },
        ),
      );
    // Consumed chunks free no peer credit until their batched credit is sent.
    if (this.peerCredit <= 0)
      return this.close(
        transportError(
          'resource_exhausted',
          `The peer exceeded the channel credit window of ${this.caps.maxBufferedChunks} chunks.`,
          { maxBufferedChunks: this.caps.maxBufferedChunks },
        ),
      );
    this.peerCredit -= 1;
    this.chunks.push(bytes);
  }

  finish(error?: CanopyErrorPayload): void {
    if (this.signal.aborted) return;
    const reason = error ?? CONNECTION_CLOSED;
    this.terminalPayload = reason;
    this.connection.forgetChannel(this.channelId);
    this.chunks.end(reason);
    for (const waiter of this.creditWaiters.splice(0))
      waiter.reject(new CanopyTransportError(reason));
    this.controller.abort(new CanopyTransportError(reason));
  }

  addCredit(chunks: number): void {
    if (this.signal.aborted) return;
    // Credit can only return chunks the peer has received; a grant for a
    // write released but not yet sent would let it exceed the window.
    if (chunks > this.uncredited)
      return this.close(
        transportError(
          'invalid_argument',
          'Channel credit exceeds the negotiated window.',
        ),
      );
    this.uncredited -= chunks;
    this.sendCredit += chunks;
    while (this.sendCredit > 0 && this.creditWaiters.length > 0) {
      this.sendCredit -= 1;
      this.creditWaiters.shift()?.resolve();
    }
  }

  private acquireCredit(): Promise<void> {
    if (this.signal.aborted)
      return Promise.reject(
        new CanopyTransportError(this.terminalPayload ?? CONNECTION_CLOSED),
      );
    if (this.sendCredit > 0) {
      this.sendCredit -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.creditWaiters.push({ resolve, reject });
    });
  }

  private chunkConsumed(): void {
    if (this.signal.aborted) return;
    this.unreturned += 1;
    if (this.unreturned < Math.ceil(this.caps.maxBufferedChunks / 2)) return;
    const chunks = this.unreturned;
    this.unreturned = 0;
    this.peerCredit += chunks;
    void this.connection
      .writeBinding({
        type: 'channel.credit',
        channelId: this.channelId,
        chunks,
      })
      .catch(() => {});
  }
}

class FramedConnection implements CanopyFramedConnection {
  private readonly controller = new AbortController();
  private readonly decoder: CanopyFrameDecoder;
  private readonly maxBufferedMessages: number;
  private readonly messages = new AsyncQueue<{
    readonly message: CanopyJsonRpcMessage;
    readonly byteLength: number;
  }>(
    () => this.drainBacklog(),
    (entry) => entry.byteLength,
  );
  private readonly handshakeFrames = new AsyncQueue<CanopyBindingFrame>();
  private readonly channels = new Map<string, FramedChannel>();
  private readonly pendingOpens = new Map<
    string,
    Waiter<FramedChannel> & { readonly request: CanopyChannelOpenRequest }
  >();
  private readonly listeners = new Map<
    (channel: CanopyByteChannel) => void,
    CanopyChannelListenerOptions | undefined
  >();
  private authenticated = false;
  private awaitingAuthOutcome = false;
  private repliesAwaitingDrain = 0;
  private peerMessageBytes: number;
  private closeReason: CanopyErrorPayload = CONNECTION_CLOSED;
  connectionId = '';
  readonly signal = this.controller.signal;

  constructor(
    private readonly duplex: Duplex,
    private readonly options: CanopyFramedConnectionOptions,
  ) {
    // Parts are joined only once the peer has authenticated.
    this.decoder = new CanopyFrameDecoder(this.maxFrameBytes);
    this.peerMessageBytes = options.peerMaxMessageBytes ?? this.maxFrameBytes;
    this.maxBufferedMessages =
      options.maxBufferedMessages ?? DEFAULT_MAX_BUFFERED_MESSAGES;
    duplex.on('data', (chunk: Buffer) => this.onData(chunk));
    duplex.on('drain', () => {
      this.repliesAwaitingDrain = 0;
    });
    duplex.on('end', () => this.finish(CONNECTION_CLOSED));
    duplex.on('close', () => this.finish(CONNECTION_CLOSED));
    duplex.on('error', () => this.finish(CONNECTION_CLOSED));
  }

  get maxFrameBytes(): number {
    return this.options.maxFrameBytes ?? CANOPY_DEFAULT_MAX_FRAME_BYTES;
  }

  get maxMessageBytes(): number {
    return Math.max(
      this.maxFrameBytes,
      this.options.maxMessageBytes ?? this.maxFrameBytes,
    );
  }

  private authenticate(): void {
    this.authenticated = true;
    this.decoder.setMaxMessageBytes(this.maxMessageBytes);
  }

  allowPeerMessageBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new CanopyTransportError(
        transportError(
          'invalid_argument',
          'maxMessageBytes must be a positive integer.',
        ),
      );
    this.peerMessageBytes = bytes;
  }

  async handshake(): Promise<void> {
    const { auth, role } = this.options;
    const timer = setTimeout(
      () =>
        this.fail(transportError('deadline_exceeded', 'Handshake timed out.')),
      this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    try {
      if (role === 'server') {
        const nonce = randomBytes(32).toString('base64url');
        await this.writeBinding({
          type: 'auth.challenge',
          nonce,
          dataRootHash: auth.dataRootHash,
        });
        const response = await this.handshakeFrames.next();
        if (
          response.type !== 'auth.response' ||
          response.dataRootHash !== auth.dataRootHash ||
          !proofMatches(
            createCanopyAuthProof(auth.secret, nonce),
            response.proof,
          )
        ) {
          const error = transportError(
            'unauthenticated',
            'Authentication failed.',
          );
          await this.writeBinding({ type: 'auth.failed', error }).catch(
            () => {},
          );
          throw new CanopyTransportError(error);
        }
        this.connectionId = randomUUID();
        // The client may send as soon as auth.ok lands.
        this.authenticate();
        await this.writeBinding({
          type: 'auth.ok',
          connectionId: this.connectionId,
        });
      } else {
        const challenge = await this.handshakeFrames.next();
        if (challenge.type !== 'auth.challenge')
          throw new CanopyTransportError(
            transportError('invalid_argument', 'Expected auth.challenge.'),
          );
        if (challenge.dataRootHash !== auth.dataRootHash)
          throw new CanopyTransportError(
            transportError(
              'failed_precondition',
              'The daemon serves a different data root.',
            ),
          );
        this.awaitingAuthOutcome = true;
        await this.writeBinding({
          type: 'auth.response',
          proof: createCanopyAuthProof(auth.secret, challenge.nonce),
          dataRootHash: auth.dataRootHash,
        });
        const outcome = await this.handshakeFrames.next();
        if (outcome.type === 'auth.failed')
          throw new CanopyTransportError(outcome.error);
        if (outcome.type !== 'auth.ok')
          throw new CanopyTransportError(
            transportError('invalid_argument', 'Expected auth.ok.'),
          );
        this.connectionId = outcome.connectionId;
      }
      this.authenticate();
    } catch (error) {
      this.fail(payloadOf(error));
      throw new CanopyTransportError(payloadOf(error));
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message: CanopyJsonRpcMessage): Promise<void> {
    if (!CanopyJsonRpcMessageSchema.safeParse(message).success)
      throw new CanopyTransportError(
        transportError('invalid_argument', 'Invalid JSON-RPC 2.0 envelope.'),
      );
    await this.writeFrame(
      encodeCanopyJsonMessage(
        message,
        this.maxFrameBytes,
        this.peerMessageBytes,
      ),
    );
  }

  receive(options?: {
    readonly signal?: AbortSignal;
  }): Promise<CanopyJsonRpcMessage> {
    return this.messages.next(options?.signal).then(({ message }) => message);
  }

  openChannel(request: CanopyChannelOpenRequest): Promise<CanopyByteChannel> {
    const channelId = randomBytes(16).toString('base64url');
    // Never request a chunk this end cannot encode into one frame.
    const caps = {
      ...request.caps,
      maxChunkBytes: Math.min(
        request.caps.maxChunkBytes,
        this.maxFrameBytes - CHANNEL_DATA_OVERHEAD_BYTES,
      ),
    };
    const frame = CanopyChannelOpenFrameSchema.safeParse({
      type: 'channel.open',
      channelId,
      ...request,
      caps,
    });
    if (!frame.success)
      return Promise.reject(
        new CanopyTransportError(
          transportError('invalid_argument', 'Invalid channel request.'),
        ),
      );
    return new Promise<FramedChannel>((resolve, reject) => {
      this.pendingOpens.set(channelId, {
        resolve,
        reject,
        request: { ...request, caps },
      });
      this.writeBinding(frame.data).catch((error: unknown) => {
        this.pendingOpens.delete(channelId);
        reject(new CanopyTransportError(payloadOf(error)));
      });
    });
  }

  onChannel(
    listener: (channel: CanopyByteChannel) => void,
    options?: CanopyChannelListenerOptions,
  ): () => void {
    this.listeners.set(listener, options);
    return () => this.listeners.delete(listener);
  }

  close(error?: CanopyErrorPayload): void {
    if (this.signal.aborted) return;
    // Written before `finish` ends the duplex, so the frame flushes first.
    void this.writeBinding({
      type: 'connection.close',
      error: error ?? null,
    }).catch(() => {});
    this.finish(error ?? CONNECTION_CLOSED);
  }

  async writeFrame(
    frame: Buffer,
    signal: AbortSignal = this.signal,
    reason?: () => CanopyErrorPayload,
  ): Promise<void> {
    const failureReason =
      reason ?? ((): CanopyErrorPayload => this.closeReason);
    if (signal.aborted) throw new CanopyTransportError(failureReason());
    if (this.duplex.write(frame)) return;
    try {
      await once(this.duplex, 'drain', { signal });
    } catch {
      throw new CanopyTransportError(failureReason());
    }
  }

  async writeBinding(frame: CanopyBindingFrame): Promise<void> {
    await this.writeFrame(encodeCanopyJsonFrame(frame, this.maxFrameBytes));
  }

  forgetChannel(channelId: string): void {
    this.channels.delete(channelId);
  }

  private hasInboundRoom(): boolean {
    return (
      this.messages.size < this.maxBufferedMessages &&
      this.messages.weight <
        (this.options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES)
    );
  }

  private onData(chunk: Buffer): void {
    // A closed connection ignores whatever the peer keeps writing.
    if (this.signal.aborted) return;
    this.decoder.append(chunk);
    this.drainBacklog();
  }

  /**
   * Decodes one frame at a time while the inbound queue is under its bound;
   * the rest stays as raw bytes in the decoder until the queue drains.
   */
  private drainBacklog(): void {
    while (!this.signal.aborted && this.hasInboundRoom()) {
      let frame: CanopyDecodedFrame | null;
      try {
        frame = this.decoder.nextFrame();
      } catch (error) {
        return this.fail(payloadOf(error));
      }
      if (!frame) break;
      this.dispatch(frame);
    }
    if (this.signal.aborted) return;
    if (!this.hasInboundRoom()) this.duplex.pause();
    else if (this.duplex.isPaused()) this.duplex.resume();
  }

  private dispatch(frame: CanopyDecodedFrame): void {
    if (frame.type === 'channel.data') {
      // Data racing a local close is dropped.
      if (this.authenticated)
        this.channels.get(frame.channelId)?.deliver(frame.bytes);
      else this.fail(transportError('unauthenticated', 'Not authenticated.'));
      return;
    }
    const { value } = frame;
    // Anything that is not a known binding frame is judged as an envelope, so
    // a request missing `jsonrpc` gets -32600 rather than closing the connection.
    if (
      Array.isArray(value) ||
      'jsonrpc' in value ||
      !('type' in value && BINDING_FRAME_TYPES.has(value.type))
    ) {
      if (!this.authenticated)
        return this.fail(
          transportError('unauthenticated', 'Not authenticated.'),
        );
      const parsed = parseCanopyJsonRpcMessage(value);
      if (parsed.success)
        this.messages.push({
          message: parsed.message,
          byteLength: frame.byteLength,
        });
      else this.rejectEnvelope(value, parsed.error);
      return;
    }
    const binding = CanopyBindingFrameSchema.safeParse(value);
    if (!binding.success)
      return this.fail(
        transportError('invalid_argument', 'Invalid binding frame.'),
      );
    const bindingFrame = binding.data;
    if (bindingFrame.type === 'auth.ok' && this.awaitingAuthOutcome) {
      // Authenticate synchronously: frames sharing this chunk dispatch next.
      this.awaitingAuthOutcome = false;
      this.connectionId = bindingFrame.connectionId;
      this.authenticate();
      this.handshakeFrames.push(bindingFrame);
    } else if (this.authenticated || bindingFrame.type === 'connection.close')
      this.onBindingFrame(bindingFrame);
    else if (bindingFrame.type.startsWith('auth.'))
      this.handshakeFrames.push(bindingFrame);
    else this.fail(transportError('unauthenticated', 'Not authenticated.'));
  }

  /** Servers answer a well-framed invalid envelope; clients treat it as a broken peer. */
  private rejectEnvelope(value: unknown, error: CanopyErrorPayload): void {
    if (this.options.role === 'client')
      return this.fail(transportError('internal', 'Malformed peer envelope.'));
    const id =
      !Array.isArray(value) &&
      typeof value === 'object' &&
      value !== null &&
      'id' in value
        ? CanopyJsonRpcIdSchema.safeParse(value.id)
        : null;
    this.replyWithoutWaiting({
      jsonrpc: CANOPY_JSON_RPC_VERSION,
      id: id?.success ? id.data : null,
      error: {
        code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.invalidRequest,
        message: error.message,
        data: error,
      },
    });
  }

  /**
   * Writes a reply the dispatcher cannot await. Too many unflushed replies
   * mean the peer is not reading, so the connection closes.
   */
  private replyWithoutWaiting(frame: object): void {
    if (this.signal.aborted) return;
    let encoded: Buffer;
    try {
      encoded = encodeCanopyJsonFrame(frame, this.maxFrameBytes);
    } catch (error) {
      return this.fail(payloadOf(error));
    }
    // Only replies queued behind an undrained write count; `drain` resets it.
    if (this.duplex.writableNeedDrain) {
      if (this.repliesAwaitingDrain >= MAX_PENDING_REPLIES)
        return this.fail(
          transportError('resource_exhausted', 'Too many unread replies.'),
        );
      this.repliesAwaitingDrain += 1;
    }
    this.duplex.write(encoded);
  }

  private onBindingFrame(frame: CanopyBindingFrame): void {
    switch (frame.type) {
      case 'channel.open':
        return this.acceptChannel(frame);
      case 'channel.opened': {
        const pending = this.pendingOpens.get(frame.channelId);
        const requested = pending?.request.caps;
        if (
          pending &&
          requested &&
          frame.caps.maxChunkBytes <= requested.maxChunkBytes &&
          frame.caps.maxBufferedChunks <= requested.maxBufferedChunks
        ) {
          this.pendingOpens.delete(frame.channelId);
          // Registered before the next frame in this chunk is dispatched, so
          // data or a close that follows `channel.opened` reaches the channel.
          return pending.resolve(
            this.registerChannel(frame.channelId, pending.request, frame.caps),
          );
        }
        // Left pending so `finish` rejects the open with this error.
        return this.fail(
          transportError('invalid_argument', 'Bad channel.opened.'),
        );
      }
      case 'channel.close': {
        const pending = this.pendingOpens.get(frame.channelId);
        this.pendingOpens.delete(frame.channelId);
        pending?.reject(
          new CanopyTransportError(
            frame.error ?? transportError('unavailable', 'Channel refused.'),
          ),
        );
        return this.channels
          .get(frame.channelId)
          ?.finish(frame.error ?? undefined);
      }
      case 'channel.credit':
        return this.channels.get(frame.channelId)?.addCredit(frame.chunks);
      case 'connection.close':
        return this.finish(frame.error ?? CONNECTION_CLOSED);
      default:
        return this.fail(
          transportError('invalid_argument', `Unexpected ${frame.type} frame.`),
        );
    }
  }

  private acceptChannel(
    frame: Extract<CanopyBindingFrame, { type: 'channel.open' }>,
  ): void {
    const refuse = (error: CanopyErrorPayload): void =>
      this.replyWithoutWaiting({
        type: 'channel.close',
        channelId: frame.channelId,
        error,
      });
    // A pending outbound open owns its id too, or `channel.opened` would
    // later overwrite the inbound channel and misroute its frames.
    if (
      this.channels.has(frame.channelId) ||
      this.pendingOpens.has(frame.channelId)
    )
      return refuse(transportError('already_exists', 'Channel id in use.'));
    if (!this.listeners.size)
      return refuse(
        transportError('capability_unavailable', 'Channels are not accepted.'),
      );
    const openAttempt: CanopyChannelOpenAttempt = {
      channelId: frame.channelId,
      kind: frame.kind,
      leaseId: frame.leaseId,
      caps: frame.caps,
    };
    for (const options of Array.from(this.listeners.values())) {
      const refusal = this.admission(options, openAttempt);
      if (refusal) return refuse(refusal);
    }
    const limits = resolveCanopyChannelLimits(this.options);
    if (this.channels.size >= limits.maxChannels)
      return refuse(transportError('resource_exhausted', 'Too many channels.'));
    const caps = negotiateCanopyChannelCaps(frame.caps, limits);
    const channel = this.registerChannel(frame.channelId, frame, caps);
    this.replyWithoutWaiting({
      type: 'channel.opened',
      channelId: frame.channelId,
      caps,
    });
    this.listeners.forEach((_options, listener) => listener(channel));
  }

  private admission(
    options: CanopyChannelListenerOptions | undefined,
    attempt: CanopyChannelOpenAttempt,
  ): CanopyErrorPayload | null {
    try {
      return options?.admit?.(attempt) ?? null;
    } catch {
      return transportError('internal', 'Channel admission failed.');
    }
  }

  private registerChannel(
    channelId: string,
    request: CanopyChannelOpenRequest,
    caps: CanopyChannelCaps,
  ): FramedChannel {
    const channel = new FramedChannel(
      this,
      channelId,
      request.kind,
      request.leaseId,
      caps,
    );
    if (this.signal.aborted) channel.finish(this.closeReason);
    else this.channels.set(channelId, channel);
    return channel;
  }

  private fail(error: CanopyErrorPayload): void {
    if (this.signal.aborted) return;
    this.close(error);
  }

  private finish(reason: CanopyErrorPayload): void {
    if (this.signal.aborted) return;
    this.closeReason = reason;
    this.controller.abort(new CanopyTransportError(reason));
    this.messages.end(reason);
    this.handshakeFrames.end(reason);
    this.pendingOpens.forEach((pending) =>
      pending.reject(new CanopyTransportError(reason)),
    );
    this.pendingOpens.clear();
    Array.from(this.channels.values()).forEach((channel) =>
      channel.finish(reason),
    );
    // End our side so the peer sees EOF whatever closed us. Backpressure may
    // have paused input: resume so `onData` drops the rest and the peer's EOF
    // is read, or neither duplex finishes closing.
    this.duplex.end();
    if (this.duplex.isPaused()) this.duplex.resume();
    // A peer that stops reading never completes the graceful close; destroy
    // the duplex so its queued writes are released.
    if (!this.duplex.destroyed) {
      const deadline = setTimeout(
        () => this.duplex.destroy(),
        this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      );
      deadline.unref();
      this.duplex.once('close', () => clearTimeout(deadline));
    }
  }
}

/** Authenticates `duplex` (D3 nonce handshake) and returns the framed connection. */
export async function createCanopyFramedConnection(
  duplex: Duplex,
  options: CanopyFramedConnectionOptions,
): Promise<CanopyFramedConnection> {
  for (const [name, value] of Object.entries({
    maxFrameBytes: options.maxFrameBytes,
    maxMessageBytes: options.maxMessageBytes,
    peerMaxMessageBytes: options.peerMaxMessageBytes,
    maxBufferedMessages: options.maxBufferedMessages,
    maxBufferedBytes: options.maxBufferedBytes,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    maxChannels: options.maxChannels,
    maxChannelChunkBytes: options.maxChannelChunkBytes,
    maxChannelBufferedChunks: options.maxChannelBufferedChunks,
    maxChannelBufferedBytes: options.maxChannelBufferedBytes,
  }))
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new CanopyTransportError(
        transportError(
          'invalid_argument',
          `${name} must be a positive integer.`,
        ),
      );
  if (!CanopyDataRootHashSchema.safeParse(options.auth.dataRootHash).success)
    throw new CanopyTransportError(
      transportError(
        'invalid_argument',
        'auth.dataRootHash must be a SHA-256 hex digest.',
      ),
    );
  // HMAC accepts an empty key, so two unconfigured ends would authenticate.
  if (options.auth.secret.length === 0)
    throw new CanopyTransportError(
      transportError('invalid_argument', 'auth.secret must not be empty.'),
    );
  const connection = new FramedConnection(duplex, options);
  await connection.handshake();
  return connection;
}
