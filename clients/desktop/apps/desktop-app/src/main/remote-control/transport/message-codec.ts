import { deserialize, serialize } from 'node:v8';
import {
  deflateRaw,
  deflateRawSync,
  inflateRaw,
  inflateRawSync,
} from 'node:zlib';
import {
  MAX_FRAGMENT_BYTES,
  MAX_MESSAGE_BYTES,
  COMPRESSION_THRESHOLD_BYTES,
} from '@canopy/protocol/remote-control';
export {
  MAX_FRAGMENT_BYTES,
  MAX_MESSAGE_BYTES,
} from '@canopy/protocol/remote-control';

/**
 * Encodes session messages for the encrypted channel.
 *
 * Values use V8 serialization, the structured-clone format Electron IPC uses,
 * so tunneled IPC arguments and results keep their exact shapes (typed
 * arrays, Dates, Maps, `undefined`). Large messages are deflated and split
 * into fragments that, sealed and framed, fill one relay frame exactly.
 *
 * Fragment: `[flags u8][bytes]`. Bit 0 marks the final fragment; bit 1 marks
 * a deflated message (set on every fragment of that message). Bit 2 marks a
 * transport-control fragment, which belongs to no message: it is sent only
 * once both sides negotiated session resume, and read before the assembler.
 *
 * Serializing, fragmenting and decoding are synchronous. Deflate and inflate
 * of messages over {@link SYNC_CODEC_BYTES} are not: they run on libuv's
 * thread pool through {@link MessageCompressor}, so a large message never
 * blocks main while it is compressed or decompressed (CAN-7764, CAN-7931).
 * Smaller ones stay on main, where they cost well under a millisecond,
 * because waiting for main to pick up a thread-pool result costs more than
 * that when main is busy. The session keeps sent and received messages in
 * order around both. Deflate is level 1, as it always was, so the bytes on
 * the wire are the same as before.
 */
const FLAG_FINAL = 0x01;
const FLAG_COMPRESSED = 0x02;
const FLAG_TRANSPORT_CONTROL = 0x04;
/** Transport-control kind: `[kind u8][nextExpected u64 BE]`. */
const CONTROL_ACK = 0x01;
const ACK_FRAGMENT_BYTES = 1 + 1 + 8;
/**
 * Output chunk for one thread-pool step. Node's default (16 KiB) would take
 * hundreds of round trips through main for a multi-megabyte message.
 */
const MAX_ZLIB_CHUNK_BYTES = 1024 * 1024;
/**
 * Messages up to this many bytes (serialized, and once inflated) are
 * deflated and inflated on main; larger ones go to the thread pool. Measured
 * under Electron 45's Node on a Ryzen 7 9800X3D at load 6, p99: level-1
 * deflate of 32 KiB costs 0.02 to 0.07 ms for terminal output and chat rows
 * and 0.61 ms at worst, for incompressible bytes; inflate of 32 KiB at most
 * 0.33 ms. At 64 KiB the worst case was 1.0 ms, past the workload's 1 ms
 * delay floor, so the bound stops at 32 KiB. A thread-pool round trip on a
 * busy Electron main took 0.8 ms p50 and 9 ms p95, and every message behind
 * it waits for it.
 */
export const SYNC_CODEC_BYTES = 32 * 1024;
const MIN_ZLIB_CHUNK_BYTES = 64 * 1024;

export class MessageCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageCodecError';
  }
}

export interface MessageCodecOptions {
  /** Largest serialized (uncompressed) message; both sides check the same. */
  maxMessageBytes?: number;
  /** Told the serialized (uncompressed) size, for diagnostics. */
  onSerialized?: (byteLength: number) => void;
  /**
   * False sends the message uncompressed whatever its size, for bytes that
   * are already encrypted (TLS) and must not leak compressed sizes.
   */
  compress?: boolean;
}

/**
 * The asynchronous half of the codec. The default runs Node's zlib on the
 * thread pool; CAN-7768 can swap in one that also runs off main, and tests
 * use it to slow or fail a step.
 */
export interface MessageCompressor {
  /** Raw deflate, or null when it would not be smaller than the input. */
  readonly deflate: (serialized: Buffer) => Promise<Buffer | null>;
  /**
   * Inflates raw deflate, rejecting with {@link MessageCodecError} on damaged
   * input or once the output would pass `maxBytes`.
   */
  readonly inflate: (compressed: Buffer, maxBytes: number) => Promise<Buffer>;
}

function chunkSize(expectedBytes: number): number {
  return Math.min(
    MAX_ZLIB_CHUNK_BYTES,
    Math.max(MIN_ZLIB_CHUNK_BYTES, expectedBytes),
  );
}

export const zlibMessageCompressor: MessageCompressor = {
  deflate: (serialized) =>
    new Promise((resolve, reject) => {
      deflateRaw(
        serialized,
        { level: 1, chunkSize: chunkSize(serialized.byteLength) },
        (error, deflated) => {
          if (error) reject(error);
          else
            resolve(
              deflated.byteLength < serialized.byteLength ? deflated : null,
            );
        },
      );
    }),
  inflate: (compressed, maxBytes) =>
    new Promise((resolve, reject) => {
      inflateRaw(
        compressed,
        {
          maxOutputLength: maxBytes,
          chunkSize: chunkSize(compressed.byteLength * 4),
        },
        (error, inflated) => {
          // Damaged input and output past the limit both end the session;
          // the message is the one the synchronous codec gave.
          if (error)
            reject(new MessageCodecError('Incoming message is too large.'));
          else resolve(inflated);
        },
      );
    }),
};

/**
 * Level-1 deflate on main, for messages up to {@link SYNC_CODEC_BYTES}; null
 * when it would not be smaller.
 */
export function deflateSmallMessage(serialized: Buffer): Buffer | null {
  const deflated = deflateRawSync(serialized, { level: 1 });
  return deflated.byteLength < serialized.byteLength ? deflated : null;
}

/**
 * Inflates on main when the message is at most {@link SYNC_CODEC_BYTES} once
 * inflated, which bounds the work; null when it is larger or damaged, so the
 * caller inflates it on the thread pool, which also reports the failure.
 */
export function inflateSmallMessage(
  compressed: Buffer,
  maxBytes: number,
): Buffer | null {
  if (compressed.byteLength > SYNC_CODEC_BYTES) return null;
  try {
    return inflateRawSync(compressed, {
      maxOutputLength: Math.min(SYNC_CODEC_BYTES, maxBytes),
    });
  } catch {
    return null;
  }
}

/**
 * Serializes now, so the value is captured when the caller sends it, and
 * checks the size the receiver will check after inflating.
 */
export function serializeMessage(
  value: unknown,
  options: MessageCodecOptions = {},
): Buffer {
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const serialized = serialize(value);
  options.onSerialized?.(serialized.byteLength);
  if (serialized.byteLength > maxMessageBytes) {
    throw new MessageCodecError('Message is too large to send.');
  }
  return serialized;
}

/** Whether the codec tries to deflate this serialized message. */
export function wantsCompression(
  serialized: Buffer,
  options: Pick<MessageCodecOptions, 'compress'> = {},
): boolean {
  return (
    options.compress !== false &&
    serialized.byteLength >= COMPRESSION_THRESHOLD_BYTES
  );
}

/** Splits one serialized or deflated message into fragments. */
export function fragmentPayload(
  payload: Buffer,
  compressed: boolean,
): Buffer[] {
  const fragments: Buffer[] = [];
  let offset = 0;
  do {
    const end = Math.min(offset + MAX_FRAGMENT_BYTES, payload.byteLength);
    const flags =
      (end === payload.byteLength ? FLAG_FINAL : 0) |
      (compressed ? FLAG_COMPRESSED : 0);
    fragments.push(
      Buffer.concat([Buffer.from([flags]), payload.subarray(offset, end)]),
    );
    offset = end;
  } while (offset < payload.byteLength);
  return fragments;
}

/** Serializes, deflates when worthwhile, and splits one message. */
export async function encodeMessage(
  value: unknown,
  options: MessageCodecOptions = {},
  compressor: MessageCompressor = zlibMessageCompressor,
): Promise<Buffer[]> {
  const serialized = serializeMessage(value, options);
  const deflated = wantsCompression(serialized, options)
    ? await compressor.deflate(serialized)
    : null;
  return deflated === null
    ? fragmentPayload(serialized, false)
    : fragmentPayload(deflated, true);
}

/**
 * A transport-control fragment acknowledging every frame below
 * `nextExpected`, so the sender can stop holding them for a resume.
 */
export function encodeAckFragment(nextExpected: bigint): Buffer {
  const fragment = Buffer.alloc(ACK_FRAGMENT_BYTES);
  fragment[0] = FLAG_TRANSPORT_CONTROL | FLAG_FINAL;
  fragment[1] = CONTROL_ACK;
  fragment.writeBigUInt64BE(nextExpected, 2);
  return fragment;
}

export function isTransportControlFragment(fragment: Buffer): boolean {
  return ((fragment[0] ?? 0) & FLAG_TRANSPORT_CONTROL) !== 0;
}

/** Reads an ack fragment; throws for any other transport-control fragment. */
export function decodeAckFragment(fragment: Buffer): bigint {
  if (
    fragment.byteLength !== ACK_FRAGMENT_BYTES ||
    fragment[0] !== (FLAG_TRANSPORT_CONTROL | FLAG_FINAL) ||
    fragment[1] !== CONTROL_ACK
  ) {
    throw new MessageCodecError('Unknown transport-control fragment.');
  }
  return fragment.readBigUInt64BE(2);
}

/** Reads one whole serialized message. */
export function decodeMessage(serialized: Buffer): unknown {
  try {
    return deserialize(serialized);
  } catch {
    throw new MessageCodecError('Incoming message could not be decoded.');
  }
}

/** One message's bytes, joined from its fragments, not yet inflated. */
export interface AssembledMessage {
  payload: Buffer;
  compressed: boolean;
}

/** Reassembles fragments from one ordered session into whole messages. */
export class MessageAssembler {
  private parts: Buffer[] = [];
  private size = 0;
  readonly maxMessageBytes: number;

  constructor(options: MessageCodecOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  }

  /** Bytes of the message still arriving, held until its last fragment. */
  get bufferedBytes(): number {
    return this.size;
  }

  /** Drops any partial fragments buffered for an incomplete message. */
  reset(): void {
    this.parts = [];
    this.size = 0;
  }

  /** Returns the message's bytes once its final fragment arrives. */
  pushFragment(fragment: Buffer): AssembledMessage | null {
    if (fragment.byteLength < 1) {
      throw new MessageCodecError('Empty message fragment.');
    }
    const flags = fragment[0] ?? 0;
    if ((flags & FLAG_TRANSPORT_CONTROL) !== 0) {
      throw new MessageCodecError('Unexpected transport-control fragment.');
    }
    const body = fragment.subarray(1);
    // Senders split only at full fragments, so every fragment but the last
    // is full: this bounds how many one message can arrive in.
    if ((flags & FLAG_FINAL) === 0 && body.byteLength !== MAX_FRAGMENT_BYTES) {
      throw new MessageCodecError('Message fragment is not full.');
    }
    this.size += body.byteLength;
    if (this.size > this.maxMessageBytes) {
      throw new MessageCodecError('Incoming message is too large.');
    }
    this.parts.push(body);
    if ((flags & FLAG_FINAL) === 0) return null;
    const payload = Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    return { payload, compressed: (flags & FLAG_COMPRESSED) !== 0 };
  }

  /**
   * `pushFragment`, then inflates and decodes. Calls must not overlap: a
   * session orders its own messages around the inflate instead.
   */
  async push(
    fragment: Buffer,
    compressor: MessageCompressor = zlibMessageCompressor,
  ): Promise<{ complete: true; value: unknown } | null> {
    const assembled = this.pushFragment(fragment);
    if (assembled === null) return null;
    const serialized = assembled.compressed
      ? await compressor.inflate(assembled.payload, this.maxMessageBytes)
      : assembled.payload;
    return { complete: true, value: decodeMessage(serialized) };
  }
}
