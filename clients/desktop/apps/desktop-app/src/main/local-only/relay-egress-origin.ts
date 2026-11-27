/**
 * The device relay origin a self-host build may reach
 * (docs/local-only-build.md, "Self-host profile"). The self-hosted server
 * names its relay in the authenticated relay token response; the token fetch
 * records that origin here right after parsing, and the egress guard allows
 * it through the `relay` origin source.
 *
 * In memory only, for the life of the process: one origin per caller (the
 * relay client, and the install record Slack pairing mints). The relay
 * client may reuse a cached token across reconnects, so a token the other
 * caller fetches must not take its origin away. The next token a caller
 * accepts replaces that caller's origin, a rejected token leaves it
 * unchanged, and sign-out does not clear it. A leaf module, so Remote Control takes on no other
 * dependency. Also the sentinel the public export template checks for a
 * source tree with the self-host profile.
 */
import { type EgressAllowedOrigin, egressOriginFromUrl } from './egress-policy';
import { isLoopbackHost } from './loopback';
import { isSelfHostBuild } from './profile';

/** Who fetched the relay token whose origin is being recorded. */
export type RelayEgressCaller = 'relay-client' | 'install';

const relayOrigins = new Map<RelayEgressCaller, EgressAllowedOrigin>();

/** Thrown when the server hands out a relay address this build can't use. */
export class RelayEgressOriginError extends Error {
  constructor(detail: string) {
    super(
      `The server returned a relay address this build can't use (${detail}). ` +
        'The relay must use wss://, or ws:// on this computer only.',
    );
    this.name = 'RelayEgressOriginError';
  }
}

/**
 * Validates and records the relay origin from an accepted relay token. A
 * no-op outside a self-host build. Accepts `wss:`, or `ws:` only for a
 * loopback host; throws `RelayEgressOriginError` for an unparseable URL or
 * any other scheme, leaving the earlier origin in place.
 */
export function noteRelayEgressOrigin(
  relayUrl: string,
  caller: RelayEgressCaller,
): void {
  if (!isSelfHostBuild()) return;
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    throw new RelayEgressOriginError('not a valid URL');
  }
  const allowed =
    url.protocol === 'wss:' ||
    (url.protocol === 'ws:' && isLoopbackHost(url.hostname));
  if (!allowed) {
    throw new RelayEgressOriginError(`${url.protocol}//${url.host}`);
  }
  const origin = egressOriginFromUrl(relayUrl);
  if (!origin) {
    throw new RelayEgressOriginError('no host');
  }
  relayOrigins.set(caller, origin);
}

/** The relay origins the guard allows right now (at most one per caller). */
export function getNotedRelayEgressOrigins(): readonly EgressAllowedOrigin[] {
  return [...relayOrigins.values()];
}

export function resetRelayEgressOriginForTests(): void {
  relayOrigins.clear();
}
