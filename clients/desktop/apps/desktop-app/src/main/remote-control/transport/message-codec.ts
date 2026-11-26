import { deserialize, serialize } from 'node:v8';
import { deflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib';
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
 * Serializing, fragmenting, inflating and decoding are synchronous. Deflate
 * of messages over {@link SYNC_CODEC_BYTES} is not: it runs on libuv's thread
 * pool through {@link MessageCompressor}, so a large message never blocks
 * main while it is compressed (CAN-7764). Smaller ones stay on main, where
 * they cost well under a millisecond, because waiting for main to pick up a
 * thread-pool result costs more than that when main is busy. The session
 * keeps sent messages in order around both. Deflate is level 1, as it always
 * was, so the bytes on the wire are the same as before. Inflating off main
 * is a separate change.
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
 * Messages up to this many serialized bytes are deflated on main; larger
 * ones go to the thread pool. Measured under Electron 45's Node on a Ryzen 7
 * 9800X3D at load 6, p99: level-1 deflate of 32 KiB costs 0.02 to 0.07 ms
 * for terminal output and chat rows and 0.61 ms at worst, for incompressible
 * bytes. At 64 KiB the worst case was 1.0 ms, past the workload's 1 ms delay
 * floor, so the bound stops at 32 KiB. A thread-pool round trip on a busy
 * Electron main took 0.8 ms p50 and 9 ms p95, and every message behind it
 * waits for it.
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

/** Reassembles fragments from one ordered session into whole messages. */
export class MessageAssembler {
  private parts: Buffer[] = [];
  private size = 0;
  private readonly maxMessageBytes: number;

  constructor(options: MessageCodecOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  }

  /** Returns the decoded message once its final fragment arrives. */
  push(fragment: Buffer): { complete: true; value: unknown } | null {
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
    const joined = Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    const serialized =
      (flags & FLAG_COMPRESSED) !== 0 ? this.inflate(joined) : joined;
    let value: unknown;
    try {
      value = deserialize(serialized);
    } catch {
      throw new MessageCodecError('Incoming message could not be decoded.');
    }
    return { complete: true, value };
  }

  private inflate(joined: Buffer): Buffer {
    try {
      return inflateRawSync(joined, { maxOutputLength: this.maxMessageBytes });
    } catch {
      throw new MessageCodecError('Incoming message is too large.');
    }
  }
}
