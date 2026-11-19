import { isDeviceId } from '../device-relay';
import { decodeCanonicalBase64url } from './security';

/** Web page a scanned pairing QR code opens. */
export const REMOTE_CONTROL_PAIRING_PATH = '/portal/pair';

export interface PairingFragment {
  deviceId: string;
  secret: string;
}

export function parsePairingFragment(hash: string): PairingFragment | null {
  const match = /^#device=([A-Za-z0-9_-]{22})&secret=([A-Za-z0-9_-]{43})$/.exec(
    hash,
  );
  const deviceId = match?.[1];
  const secret = match?.[2];
  if (
    !deviceId ||
    !secret ||
    !decodeCanonicalBase64url(deviceId, 16) ||
    !decodeCanonicalBase64url(secret, 32)
  )
    return null;
  return { deviceId, secret };
}

export function buildPairingLink(
  webOrigin: string,
  deviceId: string,
  secret: string,
): string {
  const origin = new URL(webOrigin);
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !isDeviceId(deviceId) ||
    !parsePairingFragment(`#device=${deviceId}&secret=${secret}`)
  )
    throw new Error('Invalid pairing link.');
  if (
    origin.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  )
    throw new Error('Pairing links require HTTPS.');
  return `${origin.origin}${REMOTE_CONTROL_PAIRING_PATH}#device=${deviceId}&secret=${secret}`;
}
