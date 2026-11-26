import { createHash, createHmac, timingSafeEqual, verify } from 'node:crypto';
import {
  parseExternalAgentSender,
  type ExternalAgentSender,
} from '@canopy/protocol/remote-control/shell/external-agent-sender';
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
  REMOTE_MEMBER_CHANNELS,
  browserInvocationAllowed,
  hostedInvocationAllowed,
  oneWindowChannelAllowed,
  oneWindowInvocationAllowed,
  oneWindowSendAllowed,
  scopedFileReadAllowed,
  type HostedInvocationProfile,
} from '@canopy/protocol/remote-control/channels';
import {
  DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION,
  DESKTOP_ONE_WINDOW_MODE,
  HOSTED_DELEGATION_MAX_MS,
  PAIR_PROOF_LABEL,
  decodeCanonicalBase64url,
  hostedDelegationSigningBytes,
  type HostedFirstPartyClient,
  type HelloParams,
  type HelloResult,
  type HostedDelegation,
  type RemoteVersion,
} from '@canopy/protocol/remote-control';
import type {
  ClaudeModSurfaceCommand,
  ClaudeModSurfaceUpdate,
} from '@canopy/protocol/extension-ui';
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
 * chats, send messages and archive one chat (CAN-7446), but never answer
 * approvals, close, discard or reset work.
 * Browser and mobile file reads use the same scoped-read policy as hosted controllers.
 * Browsers also pass their own argument policies (`browserInvocationAllowed`):
 * the repository owner lookup takes exactly `{ remoteUrl }` (CAN-7433);
 * `worktree:discard-describe` takes `recovery`, and `workspace:delete` and
 * `project:delete` take `discardPendingRecovery`, only on the first argument
 * and only in the exact shapes the adapter sends (CAN-7443, CAN-7444).
 * No controller of any kind may answer a Mod's composer request, and a Mod
 * surface command whose kind cannot be read is refused (CAN-7436).
 */
export function controllerMayInvoke(
  kind: DeviceKind,
  channel: string,
  args: readonly unknown[],
  disposition: (channel: string) => RemoteChannelDisposition,
  hostedProfile: HostedInvocationProfile = {},
): boolean {
  return (
    controllerInvokeDecision(
      kind,
      channel,
      args,
      disposition,
      hostedProfile,
    ) === 'allow'
  );
}

/**
 * The harness setup invokes (gap 1 of CAN-6718), whose browser argument
 * refusals answer `remote_arguments_refused`.
 */
const HARNESS_SETUP_INVOKES: ReadonlySet<string> = new Set(
  REMOTE_MEMBER_CHANNELS.harnessSetup.invoke,
);

/**
 * {@link controllerMayInvoke} with the reason for a refusal: `channel` when
 * the profile has no such channel (or one of the cross-profile policies
 * above refuses it), `arguments` when a browser's arguments fail a harness
 * setup channel's browser policy (`browserInvocationAllowed`). The host
 * answers `arguments` with `remote_arguments_refused`, so a browser tells a
 * value it should not have sent from an older computer (CAN-6718 review W1).
 * Every other refusal, including a browser policy on any other channel and
 * every hosted and mobile refusal, stays `channel`, as those channels'
 * clients and contracts expect.
 */
export function controllerInvokeDecision(
  kind: DeviceKind,
  channel: string,
  args: readonly unknown[],
  disposition: (channel: string) => RemoteChannelDisposition,
  hostedProfile: HostedInvocationProfile = {},
): 'allow' | 'channel' | 'arguments' {
  if (!controllerMayUseChannel(kind, channel, disposition)) return 'channel';
  // Require a workspace scope and refuse allowedRoot overrides into the
  // desktop's generated-image reader, using the existing hosted policy.
  if (
    (kind === 'browser' || kind === 'mobile') &&
    channel === 'file:read-content'
  )
    return scopedFileReadAllowed(args) ? 'allow' : 'channel';
  if (
    channel === CLAUDE_MOD_SURFACE_COMMAND_CHANNEL &&
    !controllerMaySendSurfaceCommand(nestedKind(args, 'command'))
  )
    return 'channel';
  if (kind === 'browser') {
    if (browserInvocationAllowed(channel, args)) return 'allow';
    return HARNESS_SETUP_INVOKES.has(channel) ? 'arguments' : 'channel';
  }
  return kind !== 'hosted' ||
    hostedInvocationAllowed(channel, args, hostedProfile)
    ? 'allow'
    : 'channel';
}

const CLAUDE_MOD_SURFACE_COMMAND_CHANNEL = 'claude-mods:surface-command';
const CLAUDE_MOD_SURFACE_PUSH_CHANNEL = 'claude-mods:surface-push';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `args[0][field].kind` when it is a string, else null. */
function nestedKind(args: readonly unknown[], field: string): string | null {
  const first = args[0];
  if (!isRecord(first)) return null;
  const inner = first[field];
  if (!isRecord(inner)) return null;
  return typeof inner.kind === 'string' ? inner.kind : null;
}

/**
 * Whether a controller may send each Mod surface command kind. Composer
 * reads and fills stay on the host's own desktop (CAN-7436), so no
 * controller of any kind sends a `composer-answer`. The record is
 * exhaustive, so a new kind fails to compile until someone decides whether
 * controllers may send it.
 */
const CONTROLLER_SURFACE_COMMANDS: Readonly<
  Record<ClaudeModSurfaceCommand['kind'], boolean>
> = {
  press: true,
  input: true,
  select: true,
  'pane-show': true,
  'pane-focus': true,
  'pane-close': true,
  'pane-resize': true,
  scroll: true,
  focus: true,
  resend: true,
  'composer-answer': false,
};

/**
 * Whether controllers receive each Mod surface push kind. A Mod's composer
 * requests and their withdrawals are answered only by the host's own desktop
 * window (CAN-7436); `composer-activity` still forwards, as the log line a
 * controller shows for a read or fill. Exhaustive, like the command record.
 */
const CONTROLLER_SURFACE_PUSHES: Readonly<
  Record<ClaudeModSurfaceUpdate['kind'], boolean>
> = {
  toast: true,
  status: true,
  log: true,
  panes: true,
  tree: true,
  scroll: true,
  focus: true,
  ended: true,
  'composer-activity': true,
  'composer-request': false,
  'composer-withdraw': false,
};

/**
 * Whether `record` allows `kind`; false when it is absent or unreadable.
 * Inherited properties are never `true`, so `toString` and the like fail.
 */
function kindAllowed(
  record: Readonly<Record<string, boolean>>,
  kind: string | null,
): boolean {
  return kind !== null && record[kind] === true;
}

/**
 * Whether a controller may send a Mod surface command of this kind. An
 * unreadable or unknown kind is refused: the gate fails closed rather than
 * leaving it to the handler's parser.
 */
function controllerMaySendSurfaceCommand(kind: string | null): boolean {
  return kindAllowed(CONTROLLER_SURFACE_COMMANDS, kind);
}

/**
 * Whether the host withholds this push from every controller, whatever its
 * kind, after the channel check passed. Only `claude-mods:surface-push` has
 * an argument policy: composer requests and withdrawals never leave the
 * host, and a push whose kind cannot be read is withheld.
 */
export function controllerPushWithheld(
  channel: string,
  args: readonly unknown[],
): boolean {
  if (channel !== CLAUDE_MOD_SURFACE_PUSH_CHANNEL) return false;
  return !kindAllowed(CONTROLLER_SURFACE_PUSHES, nestedKind(args, 'push'));
}

/**
 * The sender name of each first-party server caller (CAN-7604). The root's
 * signature over the v2 delegation vouches for it, so it shows as verified.
 */
const FIRST_PARTY_CLIENT_NAMES: Readonly<
  Record<HostedFirstPartyClient, string>
> = { slack: 'Slack' };

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
 *   A session whose verified v2 delegation names a first-party client
 *   (CAN-7604) is that client instead: its own name, its own connection
 *   identifier and `verified: true`.
 * - `userId`: the signed-in account. Null (refuse) when it is not known.
 *
 * The controller never supplies any of it.
 */
export function hostedAgentSender(input: {
  readonly rootDeviceId: string;
  readonly rootName: string;
  readonly accountUserId: string | null;
  readonly firstPartyClient?: HostedFirstPartyClient;
}): ExternalAgentSender | null {
  if (input.accountUserId === null) return null;
  const hash = createHash('sha256')
    .update(HOSTED_AGENT_SENDER_LABEL, 'utf8')
    .update(Buffer.from([0]))
    .update(input.rootDeviceId, 'utf8');
  // A first-party caller is its own sender, distinct from the agents pairing.
  if (input.firstPartyClient !== undefined)
    hash.update(Buffer.from([0])).update(input.firstPartyClient, 'utf8');
  const digest = hash.digest('hex');
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
  if (input.firstPartyClient !== undefined) {
    return parseExternalAgentSender({
      kind: 'external_agent',
      connectionId,
      clientName: FIRST_PARTY_CLIENT_NAMES[input.firstPartyClient],
      verified: true,
      userId: input.accountUserId,
    });
  }
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
 * key (and the first-party client it names, under the v2 label), it has not
 * expired, and it does not outlive the ten-minute maximum.
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
        delegation.firstPartyClient,
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
  /**
   * `oneWindow`: a desktop controller in one-window mode, served only
   * `ONE_WINDOW_CONTROLLER_CHANNELS`.
   */
  | { outcome: 'compatible'; oneWindow: boolean }
  /**
   * Answer with this host's version so the controller can explain, and serve
   * it only the core operations. `oneWindow` as above.
   */
  | { outcome: 'incompatible'; oneWindow: boolean }
  | { outcome: 'refused'; reason: string };

/**
 * Version negotiation for one hello. Without a `controller` profile, or for
 * a desktop controller that names no mode, versions must match exactly, as
 * before. A desktop controller in one-window mode is admitted from the floor
 * instead (`negotiateOneWindow`). A restricted controller whose profile
 * matches its authenticated kind may name a minimum version instead, honored
 * only when this host enforces every feature that kind needs. A profile
 * naming another kind is refused: a self-asserted kind never relaxes
 * compatibility.
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
  if (controller?.mode !== undefined) {
    return negotiateOneWindow(
      controller.mode,
      controller.minVersion,
      kind,
      params.version,
      host,
    );
  }
  if (params.version.protocolVersion === host.protocolVersion) {
    return { outcome: 'compatible', oneWindow: false };
  }
  if (controller === undefined || kind === 'desktop') {
    return { outcome: 'incompatible', oneWindow: false };
  }
  const supported = requiredFeatures(kind).every(
    (feature) => features[feature] === true,
  );
  return supported &&
    controller.minVersion <= host.protocolVersion &&
    controller.minVersion <= params.version.protocolVersion
    ? { outcome: 'compatible', oneWindow: false }
    : { outcome: 'incompatible', oneWindow: false };
}

/**
 * A desktop controller that names a mode (CAN-7758). Only desktop
 * controllers have modes; another kind naming one is refused. A mode this
 * host does not know is answered as incompatible, held as tightly as
 * one-window, so the controller sees this host's version and can say which
 * computer to update. One-window mode is admitted when both computers are at
 * or above both floors: the controller's `minVersion`, which this host must
 * meet, and `DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION`, which the controller
 * (and this host) must meet. The versions need not match: the reviewed list
 * is what both sides agree on. Below a floor only the core operations are
 * served.
 */
function negotiateOneWindow(
  mode: string,
  minVersion: number,
  kind: DeviceKind,
  controller: RemoteVersion,
  host: RemoteVersion,
): HelloDecision {
  if (kind !== 'desktop') {
    return {
      outcome: 'refused',
      reason: 'Only a desktop controller may name a mode.',
    };
  }
  const admitted =
    mode === DESKTOP_ONE_WINDOW_MODE &&
    minVersion <= host.protocolVersion &&
    minVersion <= controller.protocolVersion &&
    controller.protocolVersion >= DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION &&
    host.protocolVersion >= DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION;
  return { outcome: admitted ? 'compatible' : 'incompatible', oneWindow: true };
}

/**
 * Whether a desktop controller in one-window mode may use `channel`: invoke
 * it, send on it or receive its pushes. Only the reviewed list, and only
 * channels this host tunnels; anything else, unknown channels included, is
 * refused. Argument policies still apply on top (`controllerInvokeDecision`).
 */
export function oneWindowMayUseChannel(
  channel: string,
  disposition: (channel: string) => RemoteChannelDisposition,
): boolean {
  return disposition(channel) === 'tunnel' && oneWindowChannelAllowed(channel);
}

/**
 * {@link oneWindowMayUseChannel} for an invoke or send with these arguments
 * (`oneWindowInvocationAllowed`): the model catalog is read without the
 * options that start provider discovery, and every call that changes
 * something carries only the fields of its allowlist.
 */
export function oneWindowMayInvoke(
  channel: string,
  args: readonly unknown[],
  disposition: (channel: string) => RemoteChannelDisposition,
): boolean {
  return (
    oneWindowMayUseChannel(channel, disposition) &&
    oneWindowInvocationAllowed(channel, args)
  );
}

/**
 * {@link oneWindowMayUseChannel} for a send (`ipc.send`) with these
 * arguments (`oneWindowSendAllowed`): only the read-only channels, since
 * every call that changes something is an invoke on this computer.
 */
export function oneWindowMaySend(
  channel: string,
  args: readonly unknown[],
  disposition: (channel: string) => RemoteChannelDisposition,
): boolean {
  return (
    oneWindowMayUseChannel(channel, disposition) &&
    oneWindowSendAllowed(channel, args)
  );
}
