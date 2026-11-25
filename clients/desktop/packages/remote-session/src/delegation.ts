import {
  HOSTED_DELEGATION_MAX_MS,
  HostedDelegationSchema,
  decodeCanonicalBase64url,
  hostedDelegationSigningBytes,
  type HostedDelegation,
  type HostedFirstPartyClient,
} from '@canopy/protocol/remote-control';
import { encodeBase64Url } from './bytes';
import {
  signWithIdentity,
  verifyEd25519,
  type DeviceIdentity,
} from './identity';

/**
 * Hosted delegation: a long-term hosted root identity authorizes one
 * ephemeral session identity until `expiresAt`. It travels in handshake
 * hello1 as `delegation`; its session key must equal hello1's initiator key,
 * which the transcript already binds, so the delegation itself is not added
 * to the transcript. A first-party server caller (CAN-7604) is named in the
 * signed v2 bytes, so a host can trust it and an older host refuses it.
 */
export async function signHostedDelegation(
  root: DeviceIdentity,
  sessionPublicKey: string,
  expiresAt: number,
  firstPartyClient?: HostedFirstPartyClient,
): Promise<HostedDelegation> {
  const signature = await signWithIdentity(
    root,
    hostedDelegationSigningBytes(sessionPublicKey, expiresAt, firstPartyClient),
  );
  return HostedDelegationSchema.parse({
    rootPublicKey: root.publicKey,
    sessionPublicKey,
    expiresAt,
    ...(firstPartyClient === undefined ? {} : { firstPartyClient }),
    signature: encodeBase64Url(signature),
  });
}

export type HostedDelegationRefusal =
  | 'malformed'
  | 'session_key_mismatch'
  | 'bad_signature'
  | 'expired'
  | 'expiry_too_far'
  | 'root_not_trusted';

export type HostedDelegationVerdict =
  | {
      ok: true;
      rootPublicKey: string;
      expiresAt: number;
      firstPartyClient?: HostedFirstPartyClient;
    }
  | { ok: false; reason: HostedDelegationRefusal };

export interface VerifyHostedDelegationOptions {
  /** hello1's initiator key, which the delegation must name. */
  initiatorKey: string;
  now: number;
  /** Whether this root is currently pinned; checked on every call. */
  isTrustedRoot: (rootPublicKey: string) => boolean;
}

/**
 * Checks a delegation exactly as a host must before hello2 and again after
 * hello3: a pinned root, a matching session key, a valid root signature and
 * `now < expiresAt <= now + 10 minutes`.
 */
export async function verifyHostedDelegation(
  delegation: unknown,
  options: VerifyHostedDelegationOptions,
): Promise<HostedDelegationVerdict> {
  const parsed = HostedDelegationSchema.safeParse(delegation);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const value = parsed.data;
  if (value.sessionPublicKey !== options.initiatorKey) {
    return { ok: false, reason: 'session_key_mismatch' };
  }
  if (!(options.now < value.expiresAt)) return { ok: false, reason: 'expired' };
  if (value.expiresAt > options.now + HOSTED_DELEGATION_MAX_MS) {
    return { ok: false, reason: 'expiry_too_far' };
  }
  if (!options.isTrustedRoot(value.rootPublicKey)) {
    return { ok: false, reason: 'root_not_trusted' };
  }
  const signature = decodeCanonicalBase64url(value.signature, 64);
  if (
    signature === null ||
    !(await verifyEd25519(
      value.rootPublicKey,
      hostedDelegationSigningBytes(
        value.sessionPublicKey,
        value.expiresAt,
        value.firstPartyClient,
      ),
      signature,
    ))
  ) {
    return { ok: false, reason: 'bad_signature' };
  }
  return {
    ok: true,
    rootPublicKey: value.rootPublicKey,
    expiresAt: value.expiresAt,
    ...(value.firstPartyClient === undefined
      ? {}
      : { firstPartyClient: value.firstPartyClient }),
  };
}
