/**
 * Pipeline relay wire contract (CAN-6170, cloud pipelines CP-20).
 *
 * A cloud runner and the web core reach each other only through this relay:
 * the runner dials out once per incarnation with its runner credential, and
 * a web core pod dials in for the delegation it owns. The relay pairs the
 * two legs of one delegation and forwards each WebSocket text message
 * between them unchanged. The two ends hold an authenticated, encrypted
 * session end to end (ADR 31): each forwarded message is a session frame
 * whose ciphertext carries one JSON-RPC 2.0 envelope of the worker binding
 * (`worker.pipeline.*`). The relay is trusted for availability only; it
 * reads a frame's shape, never its payload.
 *
 * Design: docs/planning/2026-11-10-cloud-pipelines-relay-binding/README.md
 * (the binding) and docs/planning/2026-11-10-can-6170-web-core-runner-client/
 * (this relay and its credentials). It shares none of the device relay's
 * tokens, routing keys or paths.
 *
 * Environment-neutral: types, constants and pure validation only. Token
 * signing and verification use each host's own crypto.
 */
import { z } from 'zod';

/** WebSocket path a runner incarnation connects on. */
export const PIPELINE_RELAY_RUNNER_PATH = '/v1/runner';

/** WebSocket path a web core pod connects on for one delegation. */
export const PIPELINE_RELAY_CORE_PATH = '/v1/core';

/** The subprotocol a relay connection speaks; the relay selects it. */
export const PIPELINE_RELAY_SUBPROTOCOL = 'canopy-pipeline-relay.v1';

/** Prefix of the subprotocol entry that carries the relay token. */
export const PIPELINE_RELAY_TOKEN_SUBPROTOCOL_PREFIX =
  'canopy-pipeline-relay-token.';

/**
 * Subprotocols a leg offers when it connects: the relay protocol and its
 * token, so the token is checked before the upgrade.
 */
export function pipelineRelaySubprotocols(token: string): string[] {
  return [
    PIPELINE_RELAY_SUBPROTOCOL,
    `${PIPELINE_RELAY_TOKEN_SUBPROTOCOL_PREFIX}${token}`,
  ];
}

/** The token offered in a `Sec-WebSocket-Protocol` list, if exactly one. */
export function pipelineRelayTokenFromSubprotocols(
  offered: ReadonlyArray<string>,
): string | null {
  if (!offered.includes(PIPELINE_RELAY_SUBPROTOCOL)) return null;
  const tokens = offered.filter((entry) =>
    entry.startsWith(PIPELINE_RELAY_TOKEN_SUBPROTOCOL_PREFIX),
  );
  const token = tokens[0]?.slice(
    PIPELINE_RELAY_TOKEN_SUBPROTOCOL_PREFIX.length,
  );
  return tokens.length === 1 && token !== undefined && token.length > 0
    ? token
    : null;
}

/**
 * Largest message the relay forwards. A start carries its pinned definition
 * and inputs (at most 4 MiB recorded, CAN-6162), plus its envelope.
 */
export const PIPELINE_RELAY_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** A core leg's token is minted per connection and lives this long. */
export const PIPELINE_RELAY_CORE_TOKEN_TTL_MS = 60_000;

/**
 * The longest a runner credential is valid: one incarnation never outlives
 * its sandbox's provider session. The web core revokes it earlier, at exit.
 */
export const PIPELINE_RELAY_RUNNER_TOKEN_MAX_TTL_MS = 24 * 60 * 60_000;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const leaseEpoch = z.number().int().min(1).max(2_147_483_647);
const expiresAt = z.number().int().positive();

/**
 * A runner credential's claims: issued to one incarnation, for one lease
 * epoch of one delegation. `credentialId` names the web core's record of it,
 * which the web core checks, and revokes, on its side.
 */
export const PipelineRelayRunnerClaimsSchema = z.strictObject({
  v: z.literal(1),
  role: z.literal('runner'),
  delegationId: uuid,
  leaseEpoch,
  credentialId: uuid,
  expiresAt,
});
export type PipelineRelayRunnerClaims = z.infer<
  typeof PipelineRelayRunnerClaimsSchema
>;

/** A core leg's claims: the delegation and the lease epoch it accepts. */
export const PipelineRelayCoreClaimsSchema = z.strictObject({
  v: z.literal(1),
  role: z.literal('core'),
  delegationId: uuid,
  leaseEpoch,
  expiresAt,
});
export type PipelineRelayCoreClaims = z.infer<
  typeof PipelineRelayCoreClaimsSchema
>;

export const PipelineRelayTokenClaimsSchema = z.discriminatedUnion('role', [
  PipelineRelayRunnerClaimsSchema,
  PipelineRelayCoreClaimsSchema,
]);
export type PipelineRelayTokenClaims = z.infer<
  typeof PipelineRelayTokenClaimsSchema
>;

/**
 * The claims in the fixed key order both signers serialize, so the relay
 * and the web core sign the same bytes. A token is
 * `base64url(JSON(claims)) + '.' + base64url(HMAC-SHA256(secret, firstPart))`.
 */
export function canonicalPipelineRelayClaims(
  claims: PipelineRelayTokenClaims,
): PipelineRelayTokenClaims {
  const parsed = PipelineRelayTokenClaimsSchema.parse(claims);
  return parsed.role === 'runner'
    ? {
        v: parsed.v,
        role: parsed.role,
        delegationId: parsed.delegationId,
        leaseEpoch: parsed.leaseEpoch,
        credentialId: parsed.credentialId,
        expiresAt: parsed.expiresAt,
      }
    : {
        v: parsed.v,
        role: parsed.role,
        delegationId: parsed.delegationId,
        leaseEpoch: parsed.leaseEpoch,
        expiresAt: parsed.expiresAt,
      };
}

/** WebSocket close codes the relay uses when it ends a leg. */
export const PIPELINE_RELAY_CLOSE_CODES = {
  shuttingDown: 1001,
  /** A message that is not one JSON-RPC envelope, or is too large. */
  invalidMessage: 4400,
  unauthorized: 4401,
  /** The same role connected again for this delegation and epoch. */
  replaced: 4408,
  /** A newer lease epoch connected for this delegation. */
  superseded: 4409,
  /** The leg presented an older epoch than the delegation's other leg. */
  staleEpoch: 4410,
  /** The leg's messages stopped draining. */
  stalled: 4411,
} as const;

/**
 * Relay-private messages, which the relay never forwards. To the core leg:
 * `attached` when a runner of the core's epoch pairs with it, and `detached`
 * when that runner's leg ends; the core leg stays open across a runner
 * reconnect. From the core leg: `accept` once the web core has checked the
 * attached runner's credential, and `refuse` when it does not take it. The
 * relay forwards nothing either way between the two legs until the core
 * accepted that runner's attachment, and closes a refused runner. A method
 * prefix no operation can use, as `worker.binding.*` is the binding's own.
 */
export const PIPELINE_RELAY_ATTACHED_METHOD = 'pipeline.relay.attached';
export const PIPELINE_RELAY_DETACHED_METHOD = 'pipeline.relay.detached';
export const PIPELINE_RELAY_ACCEPT_METHOD = 'pipeline.relay.accept';
export const PIPELINE_RELAY_REFUSE_METHOD = 'pipeline.relay.refuse';

/** One runner leg's attachment: what the core accepts or refuses. */
const attachment = z.strictObject({
  credentialId: uuid,
  leaseEpoch,
  /** Minted by the relay per runner leg, so a reconnect is a new attachment. */
  attachmentId: uuid,
});

export const PipelineRelayAttachedSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.literal(PIPELINE_RELAY_ATTACHED_METHOD),
  params: attachment,
});
export type PipelineRelayAttached = z.infer<typeof PipelineRelayAttachedSchema>;

export const PipelineRelayDetachedSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.literal(PIPELINE_RELAY_DETACHED_METHOD),
  params: attachment,
});
export type PipelineRelayDetached = z.infer<typeof PipelineRelayDetachedSchema>;

export const PipelineRelayAcceptSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.literal(PIPELINE_RELAY_ACCEPT_METHOD),
  params: z.strictObject({ attachmentId: uuid }),
});
export type PipelineRelayAccept = z.infer<typeof PipelineRelayAcceptSchema>;

export const PipelineRelayRefuseSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.literal(PIPELINE_RELAY_REFUSE_METHOD),
  params: z.strictObject({ attachmentId: uuid }),
});
export type PipelineRelayRefuse = z.infer<typeof PipelineRelayRefuseSchema>;

const CONTROL_METHODS: ReadonlySet<unknown> = new Set([
  PIPELINE_RELAY_ATTACHED_METHOD,
  PIPELINE_RELAY_DETACHED_METHOD,
  PIPELINE_RELAY_ACCEPT_METHOD,
  PIPELINE_RELAY_REFUSE_METHOD,
]);

/** Whether a message's method is one of the relay's own. */
export function isPipelineRelayControlMethod(method: unknown): boolean {
  return CONTROL_METHODS.has(method);
}

/**
 * The web core's notice of the delegation lease (CP-11), sent inside the
 * session as a JSON-RPC notification, never to the relay: when it attaches
 * and each time it renews the lease. `expiresAt` is when the lease lapses
 * unless renewed again (epoch ms). The runner takes the same epoch as a
 * renewal, so its owner timers run to that expiry; a newer epoch as its
 * lease ending; an older one as a core that does not own the delegation.
 * A binding-private method: the runner's leg answers it, never an operation.
 */
export const PIPELINE_SESSION_LEASE_METHOD = 'pipeline.session.lease';

export const PipelineSessionLeaseSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.literal(PIPELINE_SESSION_LEASE_METHOD),
  params: z.strictObject({ leaseEpoch, expiresAt }),
});
export type PipelineSessionLease = z.infer<
  typeof PipelineSessionLeaseSchema
>['params'];

/*
 * The session between the web core and a runner (ADR 31). Both ends hold
 * the incarnation's session key: the web core derives it from its own secret
 * and the credential id, and hands it to the runner with its relay token at
 * provisioning; the relay never has it. Once the core accepted the
 * attachment:
 *
 * 1. The core sends `hello` with a fresh 32-byte nonce.
 * 2. The runner answers `hello` with its own nonce and a MAC proving it
 *    holds the key.
 * 3. The core checks it and sends `ready` with its own MAC.
 *
 * Both then derive one AES-256-GCM key per direction with HKDF-SHA256 over
 * the session key, salted with both nonces, and send `data` frames whose
 * ciphertext is one JSON-RPC envelope. Each direction numbers its frames
 * from 0; a frame out of order, or that fails to open, ends the session.
 * The reference implementation is the web core's
 * `apps/web/src/lib/web-core/cloud-runner-session.ts`, with test vectors in
 * `fixtures/session-vectors.json`.
 */

/** Labels the session's key schedule and MACs are bound to. */
export const PIPELINE_SESSION_VERSION = 1;
export const PIPELINE_SESSION_LABEL = 'canopy-pipeline-session/v1';

/** Room in a relay message for a data frame's JSON around its ciphertext. */
const SESSION_FRAME_OVERHEAD_BYTES = 128;
const SESSION_TAG_BYTES = 16;

/**
 * The longest envelope one data frame carries, before encryption: sealed,
 * base64url-encoded and wrapped, it still fits one relay message.
 */
export const PIPELINE_SESSION_MAX_PLAINTEXT_BYTES =
  Math.floor(
    ((PIPELINE_RELAY_MAX_MESSAGE_BYTES - SESSION_FRAME_OVERHEAD_BYTES) * 3) / 4,
  ) - SESSION_TAG_BYTES;

/** 32 bytes as unpadded base64url: 43 characters. */
const bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const nonce = bytes32;
const mac = bytes32;

export const PipelineSessionHelloSchema = z.strictObject({
  v: z.literal(PIPELINE_SESSION_VERSION),
  t: z.literal('hello'),
  nonce,
  /** The runner's key confirmation; the core's hello has none. */
  mac: mac.optional(),
});

export const PipelineSessionReadySchema = z.strictObject({
  v: z.literal(PIPELINE_SESSION_VERSION),
  t: z.literal('ready'),
  mac,
});

export const PipelineSessionDataSchema = z.strictObject({
  v: z.literal(PIPELINE_SESSION_VERSION),
  t: z.literal('data'),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** base64url of the AES-256-GCM ciphertext and its 16-byte tag. */
  ct: z
    .string()
    .min(22)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const PipelineSessionFrameSchema = z.discriminatedUnion('t', [
  PipelineSessionHelloSchema,
  PipelineSessionReadySchema,
  PipelineSessionDataSchema,
]);
export type PipelineSessionFrame = z.infer<typeof PipelineSessionFrameSchema>;

function messageObject(text: string): object | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}

/**
 * How the relay classifies a core message without reading its payload: the
 * core's `accept` or `refuse`, a session frame to forward, or anything else,
 * which is invalid. A plaintext envelope never crosses the relay.
 */
export type PipelineRelayCoreMessageCheck =
  | { readonly kind: 'forward' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'accept'; readonly attachmentId: string }
  | { readonly kind: 'refuse'; readonly attachmentId: string };

export function checkPipelineRelayCoreMessage(
  text: string,
): PipelineRelayCoreMessageCheck {
  const value = messageObject(text);
  if (value === null) return { kind: 'invalid' };
  if ('method' in value && isPipelineRelayControlMethod(value.method)) {
    const accept = PipelineRelayAcceptSchema.safeParse(value);
    if (accept.success)
      return { kind: 'accept', attachmentId: accept.data.params.attachmentId };
    const refuse = PipelineRelayRefuseSchema.safeParse(value);
    if (refuse.success)
      return { kind: 'refuse', attachmentId: refuse.data.params.attachmentId };
    // The relay's notices, or a malformed control message.
    return { kind: 'invalid' };
  }
  return PipelineSessionFrameSchema.safeParse(value).success
    ? { kind: 'forward' }
    : { kind: 'invalid' };
}

/**
 * How the relay classifies a runner message: a session frame to forward, one
 * of the relay's own messages, which the runner may never send, or anything
 * else, which is invalid.
 */
export type PipelineRelayRunnerMessageCheck = 'forward' | 'invalid' | 'control';

export function checkPipelineRelayRunnerMessage(
  text: string,
): PipelineRelayRunnerMessageCheck {
  const value = messageObject(text);
  if (value === null) return 'invalid';
  if ('method' in value && isPipelineRelayControlMethod(value.method))
    return 'control';
  return PipelineSessionFrameSchema.safeParse(value).success
    ? 'forward'
    : 'invalid';
}

export * from './activation';
