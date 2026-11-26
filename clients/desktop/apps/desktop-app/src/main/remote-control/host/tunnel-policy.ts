import { BlockList, isIP } from 'node:net';
import type { TunnelDestinationClass } from '@canopy/protocol/remote-control';

/**
 * Where a controller's tunnel stream may go on this computer (CAN-7679,
 * docs/remote-control-protocol.md "Tunnel streams"). Pure: it never resolves
 * or dials. Version 1 reaches loopback only:
 *
 * - Only `localhost`, `*.localhost` (any trailing dot removed), `127.0.0.0/8`
 *   and `::1` are loopback. They are allowed with class `loopback`. A
 *   literal is dialed as requested. `localhost` itself is looked up once on
 *   this computer and only its loopback answers are dialed, with the other
 *   loopback family as a fallback, so a server listening on `::1` alone is
 *   reached. A name under `localhost` is never looked up, so a controller's
 *   name never reaches a resolver: it dials `127.0.0.1`, then `::1`.
 * - Any other name is refused without a lookup. Whatever it resolves to, a
 *   v1 host would refuse it: a loopback or unspecified answer because only
 *   the names above reach loopback, anything else because it does not match
 *   class `loopback`. Looking it up would only let a controller learn what
 *   this computer's resolver answers. LAN preview (CAN-7686) resolves names
 *   once and dials the checked address, never the name again.
 * - Class `lan` is reserved for LAN preview (CAN-7686) and always refused.
 * - Unspecified, link-local (cloud metadata included), multicast,
 *   broadcast, private, unique-local, IPv4-mapped and public addresses are
 *   all refused: the host is never an egress proxy.
 */

/** What an address is, for the policy and for logs. */
export type TunnelAddressKind =
  | 'loopback'
  | 'unspecified'
  | 'link-local'
  | 'multicast'
  | 'broadcast'
  | 'private'
  | 'ipv4-mapped'
  | 'reserved'
  | 'public';

export interface TunnelAddress {
  address: string;
  family: 4 | 6;
}

/** Why the policy refuses a destination, for the log. */
export type TunnelPolicyRefusal = 'lan-class' | 'not-loopback' | 'other-name';

/** What to dial for one `tunnel.open`, before any lookup. */
export type TunnelDestinationPlan =
  /** Try these loopback addresses in turn. */
  | { kind: 'dial'; candidates: readonly TunnelAddress[] }
  /**
   * `localhost`: look it up once and dial what `loopbackCandidates` keeps,
   * in order.
   */
  | { kind: 'resolve-localhost' }
  | { kind: 'refuse'; reason: TunnelPolicyRefusal };

const IPV4_LOOPBACK: TunnelAddress = { address: '127.0.0.1', family: 4 };
const IPV6_LOOPBACK: TunnelAddress = { address: '::1', family: 6 };

function subnets(
  entries: ReadonlyArray<readonly [string, number, 'ipv4' | 'ipv6']>,
): BlockList {
  const list = new BlockList();
  for (const [network, prefix, type] of entries)
    list.addSubnet(network, prefix, type);
  return list;
}

// Checked in this order; the first match wins.
const IPV4_KINDS: ReadonlyArray<readonly [TunnelAddressKind, BlockList]> = [
  ['loopback', subnets([['127.0.0.0', 8, 'ipv4']])],
  ['unspecified', subnets([['0.0.0.0', 8, 'ipv4']])],
  ['link-local', subnets([['169.254.0.0', 16, 'ipv4']])],
  ['multicast', subnets([['224.0.0.0', 4, 'ipv4']])],
  ['broadcast', subnets([['255.255.255.255', 32, 'ipv4']])],
  [
    'private',
    subnets([
      ['10.0.0.0', 8, 'ipv4'],
      ['172.16.0.0', 12, 'ipv4'],
      ['192.168.0.0', 16, 'ipv4'],
      ['100.64.0.0', 10, 'ipv4'],
    ]),
  ],
  [
    'reserved',
    subnets([
      ['192.0.0.0', 24, 'ipv4'],
      ['198.18.0.0', 15, 'ipv4'],
      ['240.0.0.0', 4, 'ipv4'],
    ]),
  ],
];

// IPv4-mapped first: `BlockList` would match `::ffff:127.0.0.1` against the
// IPv4 loopback subnet, and only `::1` is IPv6 loopback here.
const IPV6_KINDS: ReadonlyArray<readonly [TunnelAddressKind, BlockList]> = [
  ['ipv4-mapped', subnets([['::ffff:0:0', 96, 'ipv6']])],
  ['loopback', subnets([['::1', 128, 'ipv6']])],
  ['unspecified', subnets([['::', 128, 'ipv6']])],
  [
    'link-local',
    subnets([
      ['fe80::', 10, 'ipv6'],
      ['fd00:ec2::254', 128, 'ipv6'],
    ]),
  ],
  ['multicast', subnets([['ff00::', 8, 'ipv6']])],
  [
    'private',
    subnets([
      ['fc00::', 7, 'ipv6'],
      ['fec0::', 10, 'ipv6'],
    ]),
  ],
  [
    'reserved',
    subnets([
      ['::', 96, 'ipv6'],
      ['64:ff9b::', 96, 'ipv6'],
      ['2001:db8::', 32, 'ipv6'],
      ['100::', 64, 'ipv6'],
    ]),
  ],
];

/** The address literal `host` names, or null for a name. */
export function parseAddressLiteral(host: string): TunnelAddress | null {
  // URLs bracket IPv6 literals.
  const bare =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = isIP(bare);
  if (family === 4 || family === 6) return { address: bare, family };
  return null;
}

/** Classifies one address literal that `isIP` accepted. */
export function classifyAddress(address: TunnelAddress): TunnelAddressKind {
  // A zone index ("fe80::1%en0") only names an interface: link-local.
  if (address.family === 6 && address.address.includes('%'))
    return 'link-local';
  const type = address.family === 4 ? 'ipv4' : 'ipv6';
  const kinds = address.family === 4 ? IPV4_KINDS : IPV6_KINDS;
  for (const [kind, list] of kinds) {
    if (list.check(address.address, type)) return kind;
  }
  return 'public';
}

/**
 * `localhost` or a name under it, case-insensitively, with any trailing
 * dots removed. These always mean this computer's loopback.
 */
export function isLoopbackName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

/**
 * The first step for one open: dial a loopback literal or a name under
 * `localhost`, look `localhost` up, or refuse. Nothing else is looked up.
 */
export function planDestination(request: {
  host: string;
  class: TunnelDestinationClass;
}): TunnelDestinationPlan {
  // LAN preview is CAN-7686; a v1 host refuses every LAN open.
  if (request.class !== 'loopback')
    return { kind: 'refuse', reason: 'lan-class' };
  const literal = parseAddressLiteral(request.host);
  if (literal) {
    return classifyAddress(literal) === 'loopback'
      ? { kind: 'dial', candidates: [literal] }
      : { kind: 'refuse', reason: 'not-loopback' };
  }
  if (!isLoopbackName(request.host))
    return { kind: 'refuse', reason: 'other-name' };
  if (request.host.toLowerCase().replace(/\.+$/, '') === 'localhost')
    return { kind: 'resolve-localhost' };
  return { kind: 'dial', candidates: [IPV4_LOOPBACK, IPV6_LOOPBACK] };
}

/**
 * The addresses to try for a loopback name, in order: the loopback answers
 * of its lookup in the resolver's order, then whichever of `127.0.0.1` and
 * `::1` the lookup left out, so a server listening on only one family is
 * still reached. Any other answer is dropped, never dialed. A failed lookup
 * passes no answers and gets both.
 */
export function loopbackCandidates(
  resolved: readonly TunnelAddress[],
): TunnelAddress[] {
  const candidates: TunnelAddress[] = [];
  const seen = new Set<string>();
  const add = (address: TunnelAddress): void => {
    const key = `${String(address.family)}/${address.address}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(address);
  };
  for (const address of resolved)
    if (classifyAddress(address) === 'loopback') add(address);
  const families = new Set(candidates.map((address) => address.family));
  if (!families.has(4)) add(IPV4_LOOPBACK);
  if (!families.has(6)) add(IPV6_LOOPBACK);
  return candidates;
}
