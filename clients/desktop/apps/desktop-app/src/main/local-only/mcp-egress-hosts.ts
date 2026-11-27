/**
 * Hosts of MCP servers and OAuth endpoints main has contacted for a server
 * the user configured, an allowed-host source of the egress guard
 * (docs/local-only-build.md). MCP state lives in several async stores, so the
 * MCP request paths record each URL right before they send to it. A leaf
 * module, so MCP code takes on no other dependency.
 */
import { isEgressGuardedBuild } from './profile';

const mcpHosts = new Set<string>();

/**
 * Records the host of an MCP server, OAuth metadata, registration, or token
 * URL main is about to contact for a server the user configured. A no-op
 * outside a local-only or self-host build.
 */
export function noteMcpEgressHost(url: string | URL): void {
  if (!isEgressGuardedBuild()) return;
  try {
    mcpHosts.add(
      typeof url === 'string' ? new URL(url).hostname : url.hostname,
    );
  } catch {
    // Not a URL; nothing to allow.
  }
}

export function getNotedMcpEgressHosts(): ReadonlySet<string> {
  return mcpHosts;
}

export function resetMcpEgressHostsForTests(): void {
  mcpHosts.clear();
}
