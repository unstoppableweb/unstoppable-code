// A cloud project's sandbox network and host settings, validated the same
// way everywhere they are entered or carried (CAN-7053): the web's REST and
// web core boundary, the web and desktop settings dialogs, and the desktop
// relay that forwards a desktop save. Browser-safe: no Node, no React.

/** Most ports one project may declare on its sandbox, after deduplication. */
export const MAX_HOST_PORTS = 4;
/** Inclusive TCP port range every declared host port must fall in. */
export const MIN_HOST_PORT = 1;
export const MAX_HOST_PORT = 65535;
/** Most hostnames a project's sandbox may reach. */
export const MAX_EGRESS_ALLOWED_HOSTS = 64;

/** Why a host port list is refused; each caller words it its own way. */
export type HostPortsRefusal = 'not_ports' | 'too_many';

export type ParsedHostPorts =
  | { readonly ok: true; readonly ports: number[] }
  | { readonly ok: false; readonly reason: HostPortsRefusal };

/**
 * A declared host port list: integers in range, deduplicated in order, at
 * most {@link MAX_HOST_PORTS} after deduplication.
 */
export function parseHostPorts(value: unknown): ParsedHostPorts {
  if (
    !Array.isArray(value) ||
    !value.every(
      (port): port is number =>
        typeof port === 'number' &&
        Number.isInteger(port) &&
        port >= MIN_HOST_PORT &&
        port <= MAX_HOST_PORT,
    )
  )
    return { ok: false, reason: 'not_ports' };
  const ports = [...new Set(value)];
  if (ports.length > MAX_HOST_PORTS) return { ok: false, reason: 'too_many' };
  return { ok: true, ports };
}

export type ParsedHostPortsInput =
  | { readonly ok: true; readonly ports: number[] }
  | { readonly ok: false; readonly error: string };

/**
 * The settings dialogs' comma-separated ports field ("3000, 8080") as the
 * port list a save sends. Blank input is a valid empty list: host mode with
 * no ports declares nothing.
 */
export function parseHostPortsInput(text: string): ParsedHostPortsInput {
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const ports: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      return { ok: false, error: `"${entry}" is not a port number.` };
    }
    const port = Number(entry);
    if (port < MIN_HOST_PORT || port > MAX_HOST_PORT) {
      return {
        ok: false,
        error: `Ports must be between ${MIN_HOST_PORT} and ${MAX_HOST_PORT}.`,
      };
    }
    if (!ports.includes(port)) ports.push(port);
  }
  if (ports.length > MAX_HOST_PORTS) {
    return {
      ok: false,
      error: `At most ${MAX_HOST_PORTS} ports can be exposed.`,
    };
  }
  return { ok: true, ports };
}

/**
 * A project's allowed egress hosts: at most {@link MAX_EGRESS_ALLOWED_HOSTS}
 * hostnames, lower-cased and deduplicated, with no URL, port or wildcard.
 */
export function parseEgressAllowedHosts(
  value: unknown,
): { ok: true; hosts: string[] } | { ok: false; error: string } {
  if (
    !Array.isArray(value) ||
    value.length > MAX_EGRESS_ALLOWED_HOSTS ||
    !value.every((host): host is string => typeof host === 'string')
  )
    return {
      ok: false,
      error: `Enter at most ${MAX_EGRESS_ALLOWED_HOSTS} hostnames.`,
    };
  const hosts = [...new Set(value.map((host) => host.trim().toLowerCase()))];
  if (
    hosts.some(
      (host) =>
        host.length > 253 ||
        !host
          .split('.')
          .every((label) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
          ),
    )
  )
    return {
      ok: false,
      error: 'Enter hostnames without URLs, ports, or wildcards.',
    };
  return { ok: true, hosts };
}
