/**
 * A device ID is the first 16 bytes of SHA-256 over the device's raw Ed25519
 * public key, base64url-encoded (22 characters). Binding the ID to the key
 * keeps a pairing record self-certifying. Kept free of Zod so light bundles
 * such as the desktop preload can read it.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}
