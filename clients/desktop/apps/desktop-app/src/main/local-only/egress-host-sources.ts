/**
 * The allowed-host and allowed-origin sources of the egress guard in a
 * local-only or self-host build (docs/local-only-build.md). Each source is a synchronous getter over state
 * its owner already holds in memory, evaluated per request, so a provider,
 * gateway, MCP server or GitHub connection made while the app runs is
 * allowed from then on. A removed provider, gateway or GitHub connection is
 * blocked again; MCP hosts stay allowed until the app restarts.
 *
 * A self-host build also registers two origin sources: `cloud`, the
 * configured server (static, allowed from guard install), and `relay`, the
 * relay origin from the server's last accepted relay token.
 *
 * Nothing here registers anything unless a guarded profile is on. MCP hosts
 * are recorded by `./mcp-egress-hosts`, relay origins by
 * `./relay-egress-origin`.
 */
import { peekProviderNativeAuthAvailability } from '../auth/provider-auth-state';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import {
  describeGitHubCredential,
  hasResolvedGitHubCredential,
} from '../lib/github-auth';
import {
  getCachedLocalModelGatewayHosts,
  readLocalModelGateway,
} from '../lib/local-model-gateway-store';
import {
  type EgressAllowedOrigin,
  egressOriginFromUrl,
  GITHUB_CONNECTED_HOSTS,
  PROVIDER_API_HOSTS,
  registerEgressAllowedHostSource,
  registerEgressAllowedOriginSource,
} from './egress-policy';
import { getNotedMcpEgressHosts } from './mcp-egress-hosts';
import { isEgressGuardedBuild, isSelfHostBuild } from './profile';
import { getNotedRelayEgressOrigins } from './relay-egress-origin';

/** The configured server's origin, or nothing when it is unavailable. */
function cloudServerOrigins(): EgressAllowedOrigin[] {
  let baseUrl: string;
  try {
    baseUrl = getCanopyCloudBaseUrl();
  } catch {
    return [];
  }
  const origin = egressOriginFromUrl(baseUrl);
  return origin ? [origin] : [];
}

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
  if (registered || !isEgressGuardedBuild()) return;
  registered = true;
  if (isSelfHostBuild()) {
    // The server URL is a build constant (or the E2E override), read no
    // state, so it counts before the fail-closed window ends.
    registerEgressAllowedOriginSource('cloud', cloudServerOrigins, {
      static: true,
    });
    registerEgressAllowedOriginSource('relay', getNotedRelayEgressOrigins);
  }
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
 * outside a local-only or self-host build.
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
