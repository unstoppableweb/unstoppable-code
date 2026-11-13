import { deserialize, serialize } from 'node:v8';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
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
 */
const FLAG_FINAL = 0x01;
const FLAG_COMPRESSED = 0x02;
const FLAG_TRANSPORT_CONTROL = 0x04;
/** Transport-control kind: `[kind u8][nextExpected u64 BE]`. */
const CONTROL_ACK = 0x01;
const ACK_FRAGMENT_BYTES = 1 + 1 + 8;

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
}

export function encodeMessage(
  value: unknown,
  options: MessageCodecOptions = {},
): Buffer[] {
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const serialized = serialize(value);
  options.onSerialized?.(serialized.byteLength);
  // The receiver checks the inflated size, so check the same size here,
  // before compression can hide it.
  if (serialized.byteLength > maxMessageBytes) {
    throw new MessageCodecError('Message is too large to send.');
  }
  let payload = serialized;
  let compressed = false;
  if (serialized.byteLength >= COMPRESSION_THRESHOLD_BYTES) {
    const deflated = deflateRawSync(serialized, { level: 1 });
    if (deflated.byteLength < serialized.byteLength) {
      payload = deflated;
      compressed = true;
    }
  }
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
