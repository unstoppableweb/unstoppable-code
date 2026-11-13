/**
 * Session envelope carried inside a relay data frame:
 * `[type u8][sessionId 16 bytes][body]`.
 *
 * Handshake bodies are JSON. Data bodies are secure-channel frames whose
 * associated data is the envelope header, binding each ciphertext to its
 * session.
 */
export const ENVELOPE_TYPES = {
  hello1: 0x10,
  hello2: 0x11,
  hello3: 0x12,
  hello4: 0x13,
  data: 0x20,
  /** Unauthenticated refusal during the handshake; never ends a live session. */
  abort: 0x30,
  /**
   * Session resume after a relay drop, sent only on sessions whose peers
   * negotiated it: the controller's request and the host's answer, each
   * authenticated with the session's resume key.
   */
  resume1: 0x40,
  resume2: 0x41,
} as const;

export type EnvelopeType = keyof typeof ENVELOPE_TYPES;

export const SESSION_ID_BYTES = 16;
/** Envelope header: type byte and session ID. */
export const ENVELOPE_HEADER_BYTES = 1 + SESSION_ID_BYTES;
const HEADER_BYTES = ENVELOPE_HEADER_BYTES;

export interface Envelope {
  type: EnvelopeType;
  sessionId: Buffer;
  body: Buffer;
}

function typeForByte(value: number): EnvelopeType | null {
  for (const [name, byte] of Object.entries(ENVELOPE_TYPES)) {
    if (byte === value && isEnvelopeType(name)) return name;
  }
  return null;
}

function isEnvelopeType(value: string): value is EnvelopeType {
  return Object.prototype.hasOwnProperty.call(ENVELOPE_TYPES, value);
}

export function envelopeHeader(type: EnvelopeType, sessionId: Buffer): Buffer {
  if (sessionId.byteLength !== SESSION_ID_BYTES) {
    throw new Error('Session IDs are 16 bytes.');
  }
  return Buffer.concat([Buffer.from([ENVELOPE_TYPES[type]]), sessionId]);
}

export function encodeEnvelope(
  type: EnvelopeType,
  sessionId: Buffer,
  body: Uint8Array,
): Buffer {
  return Buffer.concat([envelopeHeader(type, sessionId), body]);
}

export function decodeEnvelope(bytes: Uint8Array): Envelope | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = typeForByte(buffer[0] ?? -1);
  if (type === null) return null;
  return {
    type,
    sessionId: buffer.subarray(1, HEADER_BYTES),
    body: buffer.subarray(HEADER_BYTES),
  };
}
