import { isIP } from 'node:net';

/**
 * Normalizes a host for exact egress matching: lowercase, IPv6 brackets
 * removed, one trailing dot removed. Ports are not part of a host; callers
 * pass `URL.hostname` or a socket `host` option.
 */
export function normalizeEgressHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  if (value.endsWith('.')) {
    value = value.slice(0, -1);
  }
  return value;
}

/**
 * Whether `host` names this machine's loopback interface: `localhost`, any
 * IPv4 address in 127.0.0.0/8, `::1`, or an IPv4-mapped IPv6 loopback
 * address. Matching is exact, so `localhost.example.com` and
 * `127.0.0.1.example.com` are not loopback.
 *
 * Production copy of the test helper `isLoopbackHost` in
 * tests/electron/browser-agent-phase0/provider/shared/process-guard.mjs, made
 * stricter: that copy accepts any host starting with `127.`.
 */
export function isLoopbackHost(host: string): boolean {
  const value = normalizeEgressHost(host);
  if (value === 'localhost') return true;
  if (isIP(value) === 4) return value.split('.')[0] === '127';
  if (isIP(value) !== 6) return false;
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(
    value,
  )?.[1];
  if (mapped !== undefined) return isLoopbackHost(mapped);
  // IPv4-mapped loopback in hex form, for example ::ffff:7f00:1.
  const hexMapped =
    /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(value)?.[1];
  return hexMapped !== undefined && parseInt(hexMapped, 16) >> 8 === 0x7f;
}
