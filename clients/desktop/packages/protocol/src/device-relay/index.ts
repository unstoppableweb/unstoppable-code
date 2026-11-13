/**
 * Device relay wire contract (device-to-device remote control).
 *
 * Two desktops signed in to the same account each hold one outbound WebSocket
 * to the device relay. The relay authenticates each socket during the
 * WebSocket upgrade with a short-lived token minted by the web app (carried
 * as a subprotocol, see {@link deviceRelaySubprotocols}), tells each device
 * which of the account's other devices are online, and forwards opaque binary
 * frames between them. Frame payloads are end-to-end encrypted by the
 * desktops; the relay never parses them.
 *
 * Design: docs/planning/2026-10-05-device-remote-control/README.md
 *
 * Environment-neutral: types, constants, pure framing and validation only.
 * Token signing and verification use each host's own crypto.
 */
import { z } from 'zod';

export const DEVICE_RELAY_PROTOCOL_VERSION = 2;

export const DEVICE_KINDS = ['desktop', 'mobile', 'browser', 'hosted'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_RELAY_FEATURE_DEVICE_KIND = 'device-kind';

/** Missing kind is the legacy desktop profile, never a platform inference. */
export function deviceKindOrDefault(device: { kind?: DeviceKind }): DeviceKind {
  return device.kind ?? 'desktop';
}

/** WebSocket path the relay accepts device connections on. */
export const DEVICE_RELAY_CONNECT_PATH = '/v2/connect';

/** The subprotocol a relay connection speaks; the relay selects it. */
export const DEVICE_RELAY_SUBPROTOCOL = 'canopy-device-relay.v2';

/**
 * Prefix of the subprotocol entry that carries the relay token. A token is
 * base64url segments joined by `.`, all valid subprotocol characters.
 */
export const DEVICE_RELAY_TOKEN_SUBPROTOCOL_PREFIX = 'canopy-relay-token.';

/**
 * Subprotocols a device offers when it connects: the relay protocol and its
 * token. Browser-style WebSocket clients cannot set headers, so the token
 * travels in `Sec-WebSocket-Protocol` and is checked before the upgrade.
 */
export function deviceRelaySubprotocols(token: string): string[] {
  return [
    DEVICE_RELAY_SUBPROTOCOL,
    `${DEVICE_RELAY_TOKEN_SUBPROTOCOL_PREFIX}${token}`,
  ];
}

/** The token offered in a `Sec-WebSocket-Protocol` list, if exactly one. */
export function deviceRelayTokenFromSubprotocols(
  offered: ReadonlyArray<string>,
): string | null {
  if (!offered.includes(DEVICE_RELAY_SUBPROTOCOL)) return null;
  const tokens = offered.filter((entry) =>
    entry.startsWith(DEVICE_RELAY_TOKEN_SUBPROTOCOL_PREFIX),
  );
  const token = tokens[0]?.slice(DEVICE_RELAY_TOKEN_SUBPROTOCOL_PREFIX.length);
  return tokens.length === 1 && token !== undefined && token.length > 0
    ? token
    : null;
}

/** Relay tokens are short-lived; desktops refresh them before reconnecting. */
export const DEVICE_RELAY_TOKEN_TTL_MS = 10 * 60_000;

/**
 * Largest message the relay accepts, frame header included. Small frames keep
 * the relay's worst-case memory per connection small; desktops fragment
 * session messages to fit.
 */
export const DEVICE_RELAY_MAX_FRAME_BYTES = 64 * 1024;

/** Bytes a data frame adds around its payload: kind, ID length, device ID. */
export const DEVICE_RELAY_DATA_FRAME_OVERHEAD_BYTES = 2 + 22;

/**
 * Smallest payload a data frame may carry. Every desktop payload starts with
 * a 17-byte session envelope header, so smaller frames are malformed; the
 * floor also bounds how many frames one read can hold.
 */
export const DEVICE_RELAY_MIN_DATA_PAYLOAD_BYTES = 16;

/**
 * A device ID is the first 16 bytes of SHA-256 over the device's raw Ed25519
 * public key, base64url-encoded (22 characters). Binding the ID to the key
 * keeps a pairing record self-certifying.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

/** Raw 32-byte Ed25519 public key, base64url-encoded without padding. */
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// ===========================================================================
// Token minting (web) and verification (relay)
// ===========================================================================

export const DeviceRelayTokenRequestSchema = z.object({
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
  kind: z.enum(DEVICE_KINDS).optional(),
});
export type DeviceRelayTokenRequest = z.infer<
  typeof DeviceRelayTokenRequestSchema
>;

export const DEVICE_RELAY_TOKEN_ERROR_CODES = [
  'unauthorized',
  'personal_account_required',
  'feature_disabled',
  'device_relay_not_configured',
  'payload_too_large',
  'invalid_request',
  'origin_mismatch',
  'entitlement_denied',
  'entitlement_unavailable',
] as const;
export type DeviceRelayTokenErrorCode =
  (typeof DEVICE_RELAY_TOKEN_ERROR_CODES)[number];

export interface DeviceRelayTokenResponse {
  token: string;
  relayUrl: string;
  /** ISO timestamp. */
  expiresAt: string;
}

export const DeviceRelayTokenResponseSchema = z.object({
  token: z.string().min(1),
  relayUrl: z.string().url(),
  expiresAt: z.string().min(1),
});

/**
 * Claims carried by a relay token. Encoded as
 * `base64url(JSON(claims)) + '.' + base64url(HMAC-SHA256(secret, firstPart))`.
 */
export const DeviceRelayTokenClaimsSchema = z.object({
  v: z.literal(1),
  userId: z.string().min(1),
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
  /** Milliseconds since the epoch. */
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(DEVICE_KINDS).optional(),
});
export type DeviceRelayTokenClaims = z.infer<
  typeof DeviceRelayTokenClaimsSchema
>;

// ===========================================================================
// Control messages (JSON text frames)
// ===========================================================================

export const DEVICE_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DeviceRelayDeviceInfoSchema = z.object({
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
  name: z.string().min(1).max(120),
  platform: z.enum(DEVICE_PLATFORMS),
  kind: z.enum(DEVICE_KINDS).optional(),
  appVersion: z.string().min(1).max(64),
  publicKey: z.string().regex(PUBLIC_KEY_PATTERN),
  /** Whether this device currently accepts remote-control sessions. */
  acceptsRemoteControl: z.boolean(),
});
export type DeviceRelayDeviceInfo = z.infer<typeof DeviceRelayDeviceInfoSchema>;

export const DeviceRelayClientMessageSchema = z.discriminatedUnion('type', [
  /** First message after the upgrade: the device this token was minted for. */
  z.object({
    type: z.literal('hello'),
    device: DeviceRelayDeviceInfoSchema,
  }),
  z.object({
    type: z.literal('device.update'),
    device: DeviceRelayDeviceInfoSchema,
  }),
  z.object({ type: z.literal('ping'), sentAt: z.number() }),
]);
export type DeviceRelayClientMessage = z.infer<
  typeof DeviceRelayClientMessageSchema
>;

export const DEVICE_RELAY_ERROR_CODES = [
  'unauthorized',
  'invalid_message',
  'rate_limited',
  'replaced',
  'too_many_devices',
] as const;
export type DeviceRelayErrorCode = (typeof DEVICE_RELAY_ERROR_CODES)[number];

/**
 * WebSocket close codes the relay uses when it ends a connection. A relay
 * that refuses a message first sends an `error` naming the code it closes
 * with, and the close reason repeats that error code.
 */
export const DEVICE_RELAY_CLOSE_CODES = {
  /** The relay is shutting down, for example for a deploy. */
  shuttingDown: 1001,
  invalidMessage: 4400,
  unauthorized: 4401,
  /** No `hello` arrived in time after the upgrade. */
  helloTimeout: 4408,
  /** Another connection for this device replaced this one. */
  replaced: 4409,
  stalled: 4410,
  tooManyDevices: 4429,
} as const;
export type DeviceRelayCloseCode =
  (typeof DEVICE_RELAY_CLOSE_CODES)[keyof typeof DEVICE_RELAY_CLOSE_CODES];

/** The close reason the relay gives with `shuttingDown`. */
export const DEVICE_RELAY_SHUTDOWN_REASON = 'shutting down';

export const DeviceRelayServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    features: z.array(z.string().min(1).max(64)).max(32).optional(),
    deviceId: z.string().regex(DEVICE_ID_PATTERN),
    peers: z.array(DeviceRelayDeviceInfoSchema),
    /**
     * The longest this connection is expected to live: the load balancer in
     * front of the relay closes it then. A client may reconnect shortly
     * before it elapses instead of being cut. Absent when the relay does not
     * know. The relay itself never enforces it.
     */
    maxConnectionAgeMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('peer.online'),
    peer: DeviceRelayDeviceInfoSchema,
  }),
  z.object({
    type: z.literal('peer.offline'),
    deviceId: z.string().regex(DEVICE_ID_PATTERN),
  }),
  z.object({
    type: z.literal('undeliverable'),
    deviceId: z.string().regex(DEVICE_ID_PATTERN),
  }),
  z.object({ type: z.literal('pong'), sentAt: z.number() }),
  z.object({
    type: z.literal('error'),
    code: z.enum(DEVICE_RELAY_ERROR_CODES),
    message: z.string(),
  }),
]);
export type DeviceRelayServerMessage = z.infer<
  typeof DeviceRelayServerMessageSchema
>;

export function parseDeviceRelayClientMessage(
  text: string,
): DeviceRelayClientMessage | null {
  return parseJson(text, DeviceRelayClientMessageSchema);
}

export function parseDeviceRelayServerMessage(
  text: string,
): DeviceRelayServerMessage | null {
  return parseJson(text, DeviceRelayServerMessageSchema);
}

function parseJson<T>(text: string, schema: z.ZodType<T>): T | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

// ===========================================================================
// Data frames (binary)
// ===========================================================================

/**
 * Binary data frame: `[kind=0x01][idLength][deviceId ASCII][payload]`.
 * A device addresses the frame to the destination device; the relay rewrites
 * the ID to the source device before forwarding.
 */
export const DEVICE_RELAY_DATA_FRAME_KIND = 0x01;

export interface DeviceRelayDataFrame {
  deviceId: string;
  payload: Uint8Array;
}

export function encodeDeviceRelayDataFrame(
  deviceId: string,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (!isDeviceId(deviceId)) {
    throw new Error('Invalid device ID for relay data frame.');
  }
  const frame = new Uint8Array(2 + deviceId.length + payload.byteLength);
  frame[0] = DEVICE_RELAY_DATA_FRAME_KIND;
  frame[1] = deviceId.length;
  for (let index = 0; index < deviceId.length; index += 1) {
    frame[2 + index] = deviceId.charCodeAt(index);
  }
  frame.set(payload, 2 + deviceId.length);
  return frame;
}

export function decodeDeviceRelayDataFrame(
  frame: Uint8Array,
): DeviceRelayDataFrame | null {
  if (frame.byteLength < 2 || frame[0] !== DEVICE_RELAY_DATA_FRAME_KIND) {
    return null;
  }
  const idLength = frame[1] ?? 0;
  if (frame.byteLength < 2 + idLength) return null;
  let deviceId = '';
  for (let index = 0; index < idLength; index += 1) {
    deviceId += String.fromCharCode(frame[2 + index] ?? 0);
  }
  if (!isDeviceId(deviceId)) return null;
  return { deviceId, payload: frame.subarray(2 + idLength) };
}
