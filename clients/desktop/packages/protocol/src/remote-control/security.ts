import { z } from 'zod';

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Decode only canonical, unpadded base64url; unused trailing bits must be zero. */
export function decodeCanonicalBase64url(
  value: string,
  byteLength: number,
): Uint8Array<ArrayBuffer> | null {
  if (
    value.length !== Math.ceil((byteLength * 8) / 6) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return null;
  const bytes = new Uint8Array(byteLength);
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    accumulator = (accumulator << 6) | ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (accumulator >>> bits) & 255;
    }
  }
  return offset === byteLength && (accumulator & ((1 << bits) - 1)) === 0
    ? bytes
    : null;
}

export function canonicalBase64urlSchema(bytes: number): z.ZodString {
  return z
    .string()
    .refine(
      (value) => decodeCanonicalBase64url(value, bytes) !== null,
      'Invalid canonical base64url value.',
    );
}

export const CanonicalMacSchema = canonicalBase64urlSchema(32);
export const PAIR_PROOF_LABEL = 'canopy-pair-proof-v1';
export const HOSTED_DELEGATION_LABEL = 'canopy-hosted-delegation-v1';
/**
 * Label of a delegation that names a first-party server caller (CAN-7604).
 * A host that only knows v1 rebuilds the v1 bytes, so the signature fails and
 * it refuses the session: an older computer never takes a first-party
 * session as an ordinary hosted one.
 */
export const HOSTED_DELEGATION_V2_LABEL = 'canopy-hosted-delegation-v2';
export const HOSTED_DELEGATION_MAX_MS = 10 * 60_000;
/**
 * First-party server callers a hosted delegation may name (CAN-7604). Only
 * the web's own Slack worker opens a session that names `slack`; the hosted
 * MCP tools never name one. A host refuses any other value.
 */
export const HOSTED_FIRST_PARTY_CLIENTS = ['slack'] as const;
export type HostedFirstPartyClient =
  (typeof HOSTED_FIRST_PARTY_CLIENTS)[number];
export const HostedDelegationSchema = z.object({
  rootPublicKey: canonicalBase64urlSchema(32),
  sessionPublicKey: canonicalBase64urlSchema(32),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Signed under {@link HOSTED_DELEGATION_V2_LABEL} when present. */
  firstPartyClient: z.enum(HOSTED_FIRST_PARTY_CLIENTS).optional(),
  signature: canonicalBase64urlSchema(64),
});
export type HostedDelegation = z.infer<typeof HostedDelegationSchema>;

/**
 * v1: UTF-8 label || u32be key length || decoded key || u64be expiry.
 * v2 (with `firstPartyClient`): the v2 label, the same fields, then
 * u32be client length || UTF-8 client.
 */
export function hostedDelegationSigningBytes(
  sessionPublicKey: string,
  expiresAt: number,
  firstPartyClient?: HostedFirstPartyClient,
): Uint8Array<ArrayBuffer> {
  const key = decodeCanonicalBase64url(sessionPublicKey, 32);
  if (
    !key ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0 ||
    (firstPartyClient !== undefined &&
      !HOSTED_FIRST_PARTY_CLIENTS.includes(firstPartyClient))
  )
    throw new Error('Invalid hosted delegation.');
  const encoder = new TextEncoder();
  const label = encoder.encode(
    firstPartyClient === undefined
      ? HOSTED_DELEGATION_LABEL
      : HOSTED_DELEGATION_V2_LABEL,
  );
  const client =
    firstPartyClient === undefined ? null : encoder.encode(firstPartyClient);
  const bytes = new Uint8Array(
    label.length + 4 + key.length + 8 + (client ? 4 + client.length : 0),
  );
  bytes.set(label);
  const view = new DataView(bytes.buffer);
  view.setUint32(label.length, key.length, false);
  bytes.set(key, label.length + 4);
  const expiryOffset = label.length + 4 + key.length;
  view.setBigUint64(expiryOffset, BigInt(expiresAt), false);
  if (client) {
    view.setUint32(expiryOffset + 8, client.length, false);
    bytes.set(client, expiryOffset + 12);
  }
  return bytes;
}
