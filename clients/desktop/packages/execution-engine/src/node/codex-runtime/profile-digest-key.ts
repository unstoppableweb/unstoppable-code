import { createHmac, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
let digestKey: Buffer | null = null;

/**
 * Codex profile identity digests (CAN-4117, CAN-5067 residual 9): HMAC-SHA-256
 * under one random key per process, so a profile id or pool key never is a
 * plain hash of environment or secret values. Ids are in-memory only.
 */
export function codexProfileDigest(input: string): string {
  digestKey ??= randomBytes(KEY_BYTES);
  return createHmac('sha256', digestKey).update(input).digest('hex');
}

/** Tests only: pin the key (32 bytes) or, with no argument, draw a new one. */
export function resetCodexProfileDigestKeyForTests(key?: Buffer): void {
  if (key !== undefined && key.length !== KEY_BYTES) {
    throw new Error('A Codex profile digest key is 32 bytes.');
  }
  digestKey = key ?? randomBytes(KEY_BYTES);
}
