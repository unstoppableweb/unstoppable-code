import { createCipheriv, createDecipheriv } from 'node:crypto';

const COUNTER_BYTES = 8;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
/** Bytes a sealed frame adds to its plaintext: counter and tag. */
export const SECURE_CHANNEL_OVERHEAD_BYTES = COUNTER_BYTES + TAG_BYTES;

export class SecureChannelError extends Error {
  constructor(
    readonly code: 'malformed' | 'replayed' | 'authentication',
    message: string,
  ) {
    super(message);
    this.name = 'SecureChannelError';
  }
}

function nonceFor(counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeBigUInt64BE(counter, NONCE_BYTES - COUNTER_BYTES);
  return nonce;
}

/**
 * The counter a sealed frame claims, read without authenticating it, or null
 * for a frame too short to be one. Only for discarding a frame unopened.
 */
export function sealedFrameCounter(frame: Uint8Array): bigint | null {
  if (frame.byteLength < COUNTER_BYTES + TAG_BYTES) return null;
  return Buffer.from(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).readBigUInt64BE(0);
}

/**
 * AES-256-GCM framing for one established session. (Electron's BoringSSL
 * build does not expose ChaCha20-Poly1305 through `createCipheriv`.) Each direction has
 * its own key and a strictly increasing counter used as the nonce. The relay
 * path is an ordered stream, so a frame whose counter is not exactly the next
 * one is a replay, a drop, or a reorder and ends the session.
 *
 * Session resume reuses the counters as sequence numbers: a sealed frame is
 * kept and re-sent byte for byte, never sealed again, so no nonce is ever
 * used for two plaintexts.
 *
 * Frame: `[counter u64 BE][ciphertext][tag 16]`, authenticated together with
 * the caller's associated data (the session header).
 */
export class SecureChannel {
  private sendCounter = BigInt(0);
  private receiveCounter = BigInt(0);

  constructor(
    private readonly sendKey: Buffer,
    private readonly receiveKey: Buffer,
  ) {
    if (sendKey.byteLength !== 32 || receiveKey.byteLength !== 32) {
      throw new Error('Secure channel keys are 32 bytes.');
    }
  }

  /** The counter the next sealed frame gets. */
  get nextSendCounter(): bigint {
    return this.sendCounter;
  }

  /** The counter the next frame opened must carry. */
  get nextReceiveCounter(): bigint {
    return this.receiveCounter;
  }

  seal(plaintext: Uint8Array, associatedData: Uint8Array): Buffer {
    const counter = this.sendCounter;
    this.sendCounter += BigInt(1);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.sendKey,
      nonceFor(counter),
      {
        authTagLength: TAG_BYTES,
      },
    );
    cipher.setAAD(associatedData);
    const header = Buffer.alloc(COUNTER_BYTES);
    header.writeBigUInt64BE(counter, 0);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, body, cipher.getAuthTag()]);
  }

  open(frame: Uint8Array, associatedData: Uint8Array): Buffer {
    if (frame.byteLength < COUNTER_BYTES + TAG_BYTES) {
      throw new SecureChannelError('malformed', 'Encrypted frame too short.');
    }
    const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    const counter = bytes.readBigUInt64BE(0);
    if (counter !== this.receiveCounter) {
      throw new SecureChannelError(
        'replayed',
        'Encrypted frame is out of sequence.',
      );
    }
    const ciphertext = bytes.subarray(
      COUNTER_BYTES,
      bytes.byteLength - TAG_BYTES,
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.receiveKey,
      nonceFor(counter),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(associatedData);
    decipher.setAuthTag(bytes.subarray(bytes.byteLength - TAG_BYTES));
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
    } catch {
      throw new SecureChannelError(
        'authentication',
        'Encrypted frame failed authentication.',
      );
    }
    this.receiveCounter += BigInt(1);
    return plaintext;
  }
}
