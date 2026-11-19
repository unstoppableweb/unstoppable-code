import { createHash, createHmac, timingSafeEqual, verify } from 'node:crypto';
import {
  parseExternalAgentSender,
  type ExternalAgentSender,
} from '@canopy/protocol/portal/external-agent-sender';
import {
  DEVICE_RELAY_FEATURE_DEVICE_KIND,
  deviceKindOrDefault,
  type DeviceKind,
  type DeviceRelayDeviceInfo,
} from '@canopy/protocol/device-relay';
import {
  BROWSER_CONTROLLER_CHANNELS,
  HOSTED_CONTROLLER_CHANNELS,
  MOBILE_CONTROLLER_CHANNELS,
  hostedInvocationAllowed,
} from '@canopy/protocol/remote-control/channels';
import {
  HOSTED_DELEGATION_MAX_MS,
  PAIR_PROOF_LABEL,
  decodeCanonicalBase64url,
  hostedDelegationSigningBytes,
  type HelloParams,
  type HelloResult,
  type HostedDelegation,
  type RemoteVersion,
} from '@canopy/protocol/remote-control';
import type { RemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { importEd25519PublicKey } from '../crypto/device-key';

/**
 * Controller profiles: what each kind of controller may do on this computer.
 *
 * A desktop controller keeps every `tunnel` channel, as before kinds. Mobile,
 * browser and hosted controllers are held to their explicit lists, and are
 * distinct profiles rather than a ladder: none of them includes another.
 * The kind always comes from relay-authenticated presence or the pinned
 * pairing record, never from what the controller says about itself.
 */

/** Security features this host enforces, advertised in `session.hello`. */
export const HOST_FEATURES: NonNullable<HelloResult['features']> = {
  controllerProfiles: true,
  pairingProof: true,
  hostedDelegation: true,
  pairRevoke: true,
};

const RESTRICTED_CHANNELS: Readonly<
  Record<Exclude<DeviceKind, 'desktop'>, ReadonlySet<string>>
> = {
  mobile: new Set<string>(MOBILE_CONTROLLER_CHANNELS),
  browser: new Set<string>(BROWSER_CONTROLLER_CHANNELS),
  hosted: new Set<string>(HOSTED_CONTROLLER_CHANNELS),
};

/**
 * Whether a controller of `kind` may use `channel`: invoke it, send on it or
 * receive its pushes. Channels the host does not tunnel are never allowed.
 */
export function controllerMayUseChannel(
  kind: DeviceKind,
  channel: string,
  disposition: (channel: string) => RemoteChannelDisposition,
): boolean {
  if (disposition(channel) !== 'tunnel') return false;
  if (kind === 'desktop') return true;
  return RESTRICTED_CHANNELS[kind].has(channel);
}

/**
 * Whether a controller of `kind` may invoke or send on `channel` with these
 * arguments. The channel must be allowed; hosted controllers also pass the
 * argument policy of generic dispatch channels, so `chat:command` can start
 * chats and send messages but never answer approvals, archive or reset work.
 * Browser and mobile file reads use the same scoped-read policy as hosted controllers.
 */
export function controllerMayInvoke(
  kind: DeviceKind,
  channel: string,
  args: readonly unknown[],
  disposition: (channel: string) => RemoteChannelDisposition,
): boolean {
  if (!controllerMayUseChannel(kind, channel, disposition)) return false;
  // Require a workspace scope and refuse allowedRoot overrides into the
  // desktop's generated-image reader, using the existing hosted policy.
  if (
    (kind === 'browser' || kind === 'mobile') &&
    channel === 'file:read-content'
  )
    return hostedInvocationAllowed(channel, args);
  return kind !== 'hosted' || hostedInvocationAllowed(channel, args);
}

/** Domain label for the hosted agent attribution's connection identifier. */
const HOSTED_AGENT_SENDER_LABEL = 'canopy-hosted-agent-sender-v1';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_AGENT_NAME_LENGTH = 120;

/** The signed-in account's user ID from `signedInAccount()`, when it is one. */
export function accountUserIdFrom(
  signedInAccount: string | null,
): string | null {
  if (signedInAccount === null || !signedInAccount.startsWith('account:'))
    return null;
  const id = signedInAccount.slice('account:'.length).trim().toLowerCase();
  return UUID_PATTERN.test(id) ? id : null;
}

/**
 * The attribution this computer records on a hosted agent's sends and answers
 * (CAN-5985), derived only from the authenticated session: the pinned hosted
 * root it is attributed to and the account this computer is signed in to.
 * It has the external agent shape Portal's command origin records, so the
 * desktop shows the same "Sent by" marker:
 *
 * - `connectionId`: a stable identifier of the hosted pairing, derived from
 *   the root's device ID (the computer cannot see which agent connection
 *   behind the hosted service sent it).
 * - `clientName`: the hosted pairing's name, as approved on this computer.
 * - `verified`: false; the computer cannot attest the agent's identity.
 * - `userId`: the signed-in account. Null (refuse) when it is not known.
 *
 * The controller never supplies any of it.
 */
export function hostedAgentSender(input: {
  readonly rootDeviceId: string;
  readonly rootName: string;
  readonly accountUserId: string | null;
}): ExternalAgentSender | null {
  if (input.accountUserId === null) return null;
  const digest = createHash('sha256')
    .update(HOSTED_AGENT_SENDER_LABEL, 'utf8')
    .update(Buffer.from([0]))
    .update(input.rootDeviceId, 'utf8')
    .digest('hex');
  // RFC 9562 version 8 (custom) with the RFC variant bits.
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(
    16,
  );
  const connectionId = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `8${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
  const name = input.rootName
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let clientName = '';
  for (const character of name) {
    if (clientName.length + character.length > MAX_AGENT_NAME_LENGTH) break;
    clientName += character;
  }
  return parseExternalAgentSender({
    kind: 'external_agent',
    connectionId,
    clientName: clientName.trim() || 'Agents',
    verified: false,
    userId: input.accountUserId,
  });
}

/** Kinds that may pair by link proof; hosted always needs desktop approval. */
export function kindMayPairByProof(kind: DeviceKind): boolean {
  return kind === 'desktop' || kind === 'mobile' || kind === 'browser';
}

/**
 * The relay-authenticated kind of a connected peer: null when the peer is
 * not present, or when the relay does not authenticate kinds (an older relay
 * forwards no kind, so every peer would read as desktop).
 */
export function authenticatedPresenceKind(
  peer: DeviceRelayDeviceInfo | undefined,
  relayFeatures: ReadonlyArray<string>,
): DeviceKind | null {
  if (!peer) return null;
  if (!relayFeatures.includes(DEVICE_RELAY_FEATURE_DEVICE_KIND)) return null;
  return deviceKindOrDefault(peer);
}

export type PairedKindDecision =
  | { outcome: 'grant'; kind: DeviceKind; authenticated: boolean }
  /** The record is desktop and the device now authenticates as restricted. */
  | { outcome: 'narrow'; kind: Exclude<DeviceKind, 'desktop'> }
  | { outcome: 'deny' };

/**
 * The profile a paired controller gets, from its pinned kind and the kind
 * the relay authenticates now. Desktop records narrow to a restricted kind
 * (persisted before access); restricted records accept only the same kind;
 * a restricted record without authenticated presence fails closed.
 */
export function decidePairedKind(
  pinned: DeviceKind,
  presence: DeviceKind | null,
): PairedKindDecision {
  if (presence === null) {
    return pinned === 'desktop'
      ? { outcome: 'grant', kind: 'desktop', authenticated: false }
      : { outcome: 'deny' };
  }
  if (presence === pinned) {
    return { outcome: 'grant', kind: pinned, authenticated: true };
  }
  if (pinned === 'desktop' && presence !== 'desktop') {
    return { outcome: 'narrow', kind: presence };
  }
  return { outcome: 'deny' };
}

/**
 * Whether a hosted delegation is valid now: the root signed this session
 * key, it has not expired, and it does not outlive the ten-minute maximum.
 * The caller checks that the root is pinned and the peer authenticated.
 */
export function verifyHostedDelegation(
  delegation: HostedDelegation,
  initiatorKey: string,
  now: number,
): boolean {
  if (delegation.sessionPublicKey !== initiatorKey) return false;
  if (
    !(now < delegation.expiresAt) ||
    delegation.expiresAt > now + HOSTED_DELEGATION_MAX_MS
  ) {
    return false;
  }
  const signature = decodeCanonicalBase64url(delegation.signature, 64);
  if (signature === null) return false;
  try {
    return verify(
      null,
      hostedDelegationSigningBytes(
        delegation.sessionPublicKey,
        delegation.expiresAt,
      ),
      importEd25519PublicKey(delegation.rootPublicKey),
      signature,
    );
  } catch {
    return false;
  }
}

/** `HMAC-SHA256(secret, PAIR_PROOF_LABEL || transcriptHash)`. */
export function pairingProofFor(
  secret: Uint8Array,
  transcriptHash: Uint8Array,
): Buffer {
  return createHmac('sha256', secret)
    .update(PAIR_PROOF_LABEL, 'utf8')
    .update(transcriptHash)
    .digest();
}

/** Constant-time check of a canonical base64url proof. */
export function pairingProofMatches(
  proof: string,
  secret: Uint8Array,
  transcriptHash: Uint8Array,
): boolean {
  const received = decodeCanonicalBase64url(proof, 32);
  if (received === null) return false;
  const expected = pairingProofFor(secret, transcriptHash);
  return (
    received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected)
  );
}

/** Features a restricted controller needs before a minimum version applies. */
function requiredFeatures(
  kind: DeviceKind,
): ReadonlyArray<keyof NonNullable<HelloResult['features']>> {
  switch (kind) {
    case 'desktop':
      return [];
    case 'mobile':
    case 'browser':
      return ['controllerProfiles', 'pairingProof'];
    case 'hosted':
      return ['controllerProfiles', 'hostedDelegation'];
  }
}

export type HelloDecision =
  | { outcome: 'compatible' }
  /** Answer with this host's version so the controller can explain. */
  | { outcome: 'incompatible' }
  | { outcome: 'refused'; reason: string };

/**
 * Version negotiation for one hello. Without a `controller` profile, or for
 * a desktop controller, versions must match exactly, as before. A restricted
 * controller whose profile matches its authenticated kind may name a
 * minimum version instead, honored only when this host enforces every
 * feature that kind needs. A profile naming another kind is refused: a
 * self-asserted kind never relaxes compatibility.
 */
export function negotiateHello(
  params: HelloParams,
  kind: DeviceKind,
  host: RemoteVersion,
  features: NonNullable<HelloResult['features']> = HOST_FEATURES,
): HelloDecision {
  const controller = params.controller;
  if (controller !== undefined && controller.kind !== kind) {
    return {
      outcome: 'refused',
      reason: 'The controller profile does not match this device.',
    };
  }
  if (params.version.protocolVersion === host.protocolVersion) {
    return { outcome: 'compatible' };
  }
  if (controller === undefined || kind === 'desktop') {
    return { outcome: 'incompatible' };
  }
  const supported = requiredFeatures(kind).every(
    (feature) => features[feature] === true,
  );
  return supported &&
    controller.minVersion <= host.protocolVersion &&
    controller.minVersion <= params.version.protocolVersion
    ? { outcome: 'compatible' }
    : { outcome: 'incompatible' };
}
