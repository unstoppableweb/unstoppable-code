/**
 * The allowed-host sources of the local-only egress guard
 * (docs/local-only-build.md). Each source is a synchronous getter over state
 * its owner already holds in memory, evaluated per request, so a provider,
 * gateway, MCP server or GitHub connection made while the app runs is
 * allowed from then on. A removed provider, gateway or GitHub connection is
 * blocked again; MCP hosts stay allowed until the app restarts.
 *
 * Nothing here registers anything unless the profile is on. MCP hosts are
 * recorded by `./mcp-egress-hosts`.
 */
import { peekProviderNativeAuthAvailability } from '../auth/provider-auth-state';
import {
  describeGitHubCredential,
  hasResolvedGitHubCredential,
} from '../lib/github-auth';
import {
  getCachedLocalModelGatewayHosts,
  readLocalModelGateway,
} from '../lib/local-model-gateway-store';
import {
  GITHUB_CONNECTED_HOSTS,
  PROVIDER_API_HOSTS,
  registerEgressAllowedHostSource,
} from './egress-policy';
import { getNotedMcpEgressHosts } from './mcp-egress-hosts';
import { isLocalOnlyBuild } from './profile';

function connectedProviderHosts(): string[] {
  const availability = peekProviderNativeAuthAvailability();
  const hosts: string[] = [];
  if (availability.claude === true) hosts.push(...PROVIDER_API_HOSTS.claude);
  if (availability.codex === true) hosts.push(...PROVIDER_API_HOSTS.codex);
  return hosts;
}

let registered = false;

/** Registers every source. Called once from main's entry. */
export function registerLocalOnlyEgressHostSources(): void {
  if (registered || !isLocalOnlyBuild()) return;
  registered = true;
  registerEgressAllowedHostSource(
    'ai-gateway',
    getCachedLocalModelGatewayHosts,
  );
  registerEgressAllowedHostSource('mcp', getNotedMcpEgressHosts);
  registerEgressAllowedHostSource('providers', connectedProviderHosts);
  registerEgressAllowedHostSource('github', () =>
    hasResolvedGitHubCredential() ? GITHUB_CONNECTED_HOSTS : [],
  );
}

/**
 * The gateway and GitHub sources answer from caches their owners fill on
 * first read. With background polling off, nothing may read them before the
 * person's first gateway or GitHub request, so main's ready handler calls
 * this once, after `prepareCanopySecureStorage()` has settled the secure
 * folder both stores live in and only in the single-instance owner. Both
 * reads are local: the gateway settings file, the secure store, and the
 * bundled `gh auth token` reading the GitHub CLI's stored login. A no-op
 * outside a local-only build.
 */
export async function primeLocalOnlyEgressHostCaches(): Promise<void> {
  if (!registered) return;
  await Promise.allSettled([
    readLocalModelGateway(),
    describeGitHubCredential(),
  ]);
}

export function resetEgressHostSourcesForTests(): void {
  registered = false;
}
