import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { decodeBase64Url, encodeBase64Url } from './device-key';
import { HANDSHAKE_PROTOCOL } from './handshake';

/**
 * Messages that pick up an established session after a relay drop, without
 * a new handshake. Only the controller (the handshake's initiator) asks:
 *
 *   1. I → R  resume1  { nonce nI, nextExpected, mac_K("resume1", id, nI, n) }
 *   2. R → I  resume2  { nonce nR, nextExpected, mac_K("resume2", id, nI, nR, n) }
 *
 * K is the session's resume key, which only the two ends of the handshake
 * hold. `nextExpected` is the counter of the first frame the sender has not
 * received; the other side re-sends its held frames from there. The
 * initiator accepts only a resume2 whose MAC covers its current nonce, so an
 * old answer cannot be replayed to it. A replayed resume1 makes the
 * responder re-send ciphertext the relay has already carried, which the
 * initiator drops by counter: frames are never sealed twice, so no AES-GCM
 * nonce is reused.
 */
const RESUME_NONCE_BYTES = 32;
const MAX_COUNTER = (BigInt(1) << BigInt(64)) - BigInt(1);

const base64UrlField = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** A frame counter as a decimal string; JSON has no 64-bit integers. */
const counterField = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= MAX_COUNTER);

export const Resume1Schema = z.object({
  nonce: base64UrlField,
  nextExpected: counterField,
  mac: base64UrlField,
});
export type Resume1 = z.infer<typeof Resume1Schema>;

export const Resume2Schema = z.object({
  nonce: base64UrlField,
  nextExpected: counterField,
  mac: base64UrlField,
});
export type Resume2 = z.infer<typeof Resume2Schema>;

function lengthPrefixed(value: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.byteLength, 0);
  return Buffer.concat([length, value]);
}

function mac(key: Buffer, parts: Uint8Array[]): Buffer {
  const hmac = createHmac('sha256', key);
  for (const part of parts) hmac.update(lengthPrefixed(part));
  return hmac.digest();
}

function counterBytes(counter: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(counter, 0);
  return bytes;
}

function label(stage: 'resume1' | 'resume2'): Buffer {
  return Buffer.from(`${HANDSHAKE_PROTOCOL} ${stage}`, 'utf8');
}

function resume1Mac(
  key: Buffer,
  sessionId: Buffer,
  initiatorNonce: Buffer,
  nextExpected: bigint,
): Buffer {
  return mac(key, [
    label('resume1'),
    sessionId,
    initiatorNonce,
    counterBytes(nextExpected),
  ]);
}

function resume2Mac(
  key: Buffer,
  sessionId: Buffer,
  initiatorNonce: Buffer,
  responderNonce: Buffer,
  nextExpected: bigint,
): Buffer {
  return mac(key, [
    label('resume2'),
    sessionId,
    initiatorNonce,
    responderNonce,
    counterBytes(nextExpected),
  ]);
}

function sameMac(expected: Buffer, received: string): boolean {
  const bytes = decodeBase64Url(received);
  return (
    bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected)
  );
}

export function createResumeNonce(): Buffer {
  return randomBytes(RESUME_NONCE_BYTES);
}

export function buildResume1(
  key: Buffer,
  sessionId: Buffer,
  nonce: Buffer,
  nextExpected: bigint,
): Resume1 {
  return {
    nonce: encodeBase64Url(nonce),
    nextExpected: nextExpected.toString(),
    mac: encodeBase64Url(resume1Mac(key, sessionId, nonce, nextExpected)),
  };
}

/** The verified resume1's nonce and counter, or null when it does not verify. */
export function openResume1(
  key: Buffer,
  sessionId: Buffer,
  resume1: Resume1,
): { nonce: Buffer; nextExpected: bigint } | null {
  const nonce = decodeBase64Url(resume1.nonce);
  if (nonce.byteLength !== RESUME_NONCE_BYTES) return null;
  const nextExpected = BigInt(resume1.nextExpected);
  const expected = resume1Mac(key, sessionId, nonce, nextExpected);
  return sameMac(expected, resume1.mac) ? { nonce, nextExpected } : null;
}

export function buildResume2(
  key: Buffer,
  sessionId: Buffer,
  initiatorNonce: Buffer,
  nextExpected: bigint,
): Resume2 {
  const nonce = createResumeNonce();
  return {
    nonce: encodeBase64Url(nonce),
    nextExpected: nextExpected.toString(),
    mac: encodeBase64Url(
      resume2Mac(key, sessionId, initiatorNonce, nonce, nextExpected),
    ),
  };
}

/**
 * The verified resume2's counter, or null when it does not verify against
 * the initiator's current nonce.
 */
export function openResume2(
  key: Buffer,
  sessionId: Buffer,
  initiatorNonce: Buffer,
  resume2: Resume2,
): bigint | null {
  const responderNonce = decodeBase64Url(resume2.nonce);
  if (responderNonce.byteLength !== RESUME_NONCE_BYTES) return null;
  const nextExpected = BigInt(resume2.nextExpected);
  const expected = resume2Mac(
    key,
    sessionId,
    initiatorNonce,
    responderNonce,
    nextExpected,
  );
  return sameMac(expected, resume2.mac) ? nextExpected : null;
}
