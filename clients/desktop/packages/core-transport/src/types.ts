// Browser-safe binding contract: no Node imports, so @canopy/core-client and
// browser hosts can depend on it through `@canopy/core-transport/types`.
import type {
  CanopyErrorPayload,
  CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';

export interface CanopyChannelCapsInput {
  readonly maxChunkBytes: number;
  readonly maxBufferedChunks: number;
}

export interface CanopyChannelOpenRequest {
  /** Dotted lower-camel channel kind, e.g. `pipeline.output`. */
  readonly kind: string;
  readonly leaseId: string;
  readonly caps: CanopyChannelCapsInput;
}

/** An inbound open as the accepting end sees it, before it is acknowledged. */
export interface CanopyChannelOpenAttempt extends CanopyChannelOpenRequest {
  readonly channelId: string;
}

export interface CanopyChannelListenerOptions {
  /**
   * Runs before the open is acknowledged. A returned error refuses the open:
   * the peer's `openChannel` rejects with it and no listener sees a channel.
   */
  readonly admit?: (
    attempt: CanopyChannelOpenAttempt,
  ) => CanopyErrorPayload | null;
}

/** A negotiated lease-bound bulk channel carrying opaque bytes (ADR 2). */
export interface CanopyByteChannel {
  readonly channelId: string;
  readonly kind: string;
  readonly leaseId: string;
  /** Negotiated caps; writes above `maxChunkBytes` fail with `resource_exhausted`. */
  readonly caps: CanopyChannelCapsInput;
  /** Aborts when the channel closes; the reason's `payload` is the typed error. */
  readonly signal: AbortSignal;
  /** Waits for channel credit once `caps.maxBufferedChunks` chunks are unacknowledged. */
  write(bytes: Uint8Array): Promise<void>;
  /** Resolves `null` once the channel has closed and its buffer is drained. */
  read(options?: { readonly signal?: AbortSignal }): Promise<Uint8Array | null>;
  close(error?: CanopyErrorPayload): void;
}

/**
 * One authenticated, multiplexed control connection (ADR 2). Every binding
 * (in-memory, Unix socket, named pipe) exposes this shape after its handshake.
 */
export interface CanopyFramedConnection {
  readonly connectionId: string;
  /** Aborts when the connection closes; the reason's `payload` is the typed error. */
  readonly signal: AbortSignal;
  /**
   * Largest envelope this end reassembles from message parts. Absent on
   * bindings without parts, which carry one frame per envelope.
   */
  readonly maxMessageBytes?: number;
  /**
   * The peer reassembles envelopes up to `bytes`, so `send` may split one
   * across message parts instead of refusing it as `resource_exhausted`.
   */
  allowPeerMessageBytes?(bytes: number): void;
  /** Resolves once the frame is accepted by a bounded peer buffer (backpressure). */
  send(message: CanopyJsonRpcMessage): Promise<void>;
  /** Next validated envelope; rejects with the close reason or `cancelled`. */
  receive(options?: {
    readonly signal?: AbortSignal;
  }): Promise<CanopyJsonRpcMessage>;
  openChannel(request: CanopyChannelOpenRequest): Promise<CanopyByteChannel>;
  /** Without a listener, inbound `channel.open` is refused as `capability_unavailable`. */
  onChannel(
    listener: (channel: CanopyByteChannel) => void,
    options?: CanopyChannelListenerOptions,
  ): () => void;
  close(error?: CanopyErrorPayload): void;
}
