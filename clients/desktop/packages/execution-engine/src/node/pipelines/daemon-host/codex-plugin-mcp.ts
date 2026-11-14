import {
  isCodexConfig,
  type CodexConfig,
} from '@canopy/execution-engine/lib/codex-model-config';
import type { CodexHttpMcpProxyService } from '../../codex-runtime/http-mcp-proxy';
import { pluginMcpServerContentHash } from '../../plugins/plugin-mcp-content-hash';
import {
  resolveCodexPluginMcpServers,
  type CodexPluginMcpSource,
  type ResolvedPluginRuntime,
} from '../../plugins/plugin-resolver';
import type { ChatTabPluginSelections } from '@canopy/execution-engine/execution-types';
import type { ResolvedPipelinePluginCollectionSnapshot } from '@canopy/execution-engine/types/pipeline';
import type { CodexPipelinePluginResolution } from '../codex-pipeline-prompt';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/execution-engine/types/plugins';
import { codexPluginMcpSnapshotKey } from '../../codex-runtime/capability-fingerprint';
import type { OwnerMcpCredentials } from './owner-mcp-credentials';
import type { CodexPluginSourceFacts } from './codex-plugin-admission';
import { mcpHttpAuthTargetKey } from '@canopy/execution-engine/lib/mcp-http-auth';

/** Why a Codex step's plugins can't run here: it stays in process. */
export const DAEMON_CODEX_PLUGINS_UNAVAILABLE =
  'Workflow plugins are not available here.';

/** One plugin HTTP server's declaration, as the owner reads and binds it. */
export interface DaemonCodexPluginMcpBindSource {
  readonly marketplaceId: string;
  readonly pluginName: string;
  readonly serverName: string;
  readonly contentHash: string;
}

export interface DaemonCodexPluginMcpPorts {
  /**
   * `owner.mcp.bind`, once per run for each declaration: the owner's route
   * ref, or null when it binds none (no OAuth needed, or refused).
   */
  bind(
    source: DaemonCodexPluginMcpBindSource,
    options?: {
      /** Binds again, replacing this route the owner called stale. */
      readonly staleRef?: string;
    },
  ): Promise<string | null>;
  readonly proxy: CodexHttpMcpProxyService;
  readonly credentials: OwnerMcpCredentials;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The Codex server fields a declaration carries besides how it is reached. */
function toolPolicy(server: CodexConfig): CodexConfig {
  const policy: CodexConfig = {};
  for (const key of [
    'enabled',
    'enabled_tools',
    'disabled_tools',
    'default_tools_approval_mode',
    'tools',
  ])
    if (server[key] !== undefined) policy[key] = server[key];
  if (server.enabled !== false) policy.required = false;
  return policy;
}

const CREDENTIAL_HEADER_FIELDS = [
  'headers',
  'http_headers',
  'env_http_headers',
  'bearer_token_env_var',
] as const;

/**
 * Whether a plugin HTTP server's declaration carries credential headers,
 * which in process go only through Electron main's own proxy.
 */
function declaresCredentialHeaders(
  declaration: Readonly<Record<string, unknown>>,
): boolean {
  return CREDENTIAL_HEADER_FIELDS.some(
    (field) => declaration[field] !== undefined,
  );
}

/**
 * How the daemon serves one Codex server, or null when it can't (CAN-6168
 * part 4): only a plugin's own servers, stdio without env, or HTTP without
 * credential headers from no curated plugin. An HTTP server's OAuth
 * credential stays with Electron main, which binds it for the run and
 * presents one header per upstream request.
 */
function servedAs(
  server: unknown,
  source: CodexPluginMcpSource | undefined,
): 'stdio' | 'http' | null {
  if (!source || !isCodexConfig(server)) return null;
  if (server.type === 'stdio')
    return typeof server.command === 'string' &&
      !(isRecord(server.env) && Object.keys(server.env).length > 0)
      ? 'stdio'
      : null;
  return server.type === 'http' &&
    typeof server.url === 'string' &&
    server.url === source.declaration.url &&
    source.marketplaceId !== CURATED_PLUGIN_MARKETPLACE_ID &&
    !declaresCredentialHeaders(source.declaration) &&
    !(isRecord(server.headers) && Object.keys(server.headers).length > 0)
    ? 'http'
    : null;
}

/**
 * Whether the daemon can serve every MCP server a Codex step's selections
 * bring (CAN-6168): no standalone server, and every plugin server one the
 * daemon serves. The launch keeps any other Codex step in process.
 */
export function codexPluginSelectionsServableInDaemon(
  selections: ChatTabPluginSelections,
  standaloneMcpServers?: Readonly<Record<string, unknown>>,
): boolean {
  // Collections expand only owner-side: an unexpanded one can't be judged.
  if (selections.collectionIds.length > 0) return false;
  // Electron main builds standalone skills its own way, so their capability
  // root would differ between hosts and a resumed session would be refused.
  if (selections.skillRefs.length > 0) return false;
  if ((selections.mcpServerRefs?.length ?? 0) > 0) return false;
  if (Object.keys(standaloneMcpServers ?? {}).length > 0) return false;
  const {
    mcpServers,
    codexPluginMcpSources,
    compatibilityPlugins,
    unresolvedPlugins,
    disabledMcpServers,
  } = resolveCodexPluginMcpServers(selections);
  // In process installs a missing plugin or builds a compatibility one;
  // here either would leave the step without it. A server a plugin turns
  // off stays in Electron main's config, turned off, so its capability
  // snapshot would differ from the daemon's.
  if (compatibilityPlugins || unresolvedPlugins || disabledMcpServers)
    return false;
  return Object.entries(mcpServers).every(
    ([name, server]) => servedAs(server, codexPluginMcpSources[name]) !== null,
  );
}

/** One plugin HTTP server a step's selections bring, for the launch to check. */
export interface CodexPluginHttpServer {
  readonly url: string;
  readonly marketplaceId: string;
  readonly pluginName: string;
  readonly serverName: string;
}

/**
 * The plugin HTTP servers a step's selections bring, for the launch to check
 * each one's effective auth handler and count the run's routes (CAN-6168).
 */
export function codexPluginHttpServers(
  selections: ChatTabPluginSelections,
): CodexPluginHttpServer[] {
  const { mcpServers, codexPluginMcpSources } =
    resolveCodexPluginMcpServers(selections);
  return Object.entries(mcpServers).flatMap(([name, server]) => {
    const source = codexPluginMcpSources[name];
    return source &&
      isCodexConfig(server) &&
      server.type === 'http' &&
      typeof server.url === 'string'
      ? [
          {
            url: server.url,
            marketplaceId: source.marketplaceId,
            pluginName: source.pluginName,
            serverName: source.serverName,
          },
        ]
      : [];
  });
}

/**
 * What one plugin source's selections bring, for the admission rule
 * (codex-plugin-admission.ts, CAN-6168): whether the daemon can serve them,
 * their plugin HTTP servers and their MCP auth overrides.
 */
export function codexPluginSourceFacts(
  selections: ChatTabPluginSelections,
  standaloneMcpServers?: Readonly<Record<string, unknown>>,
): CodexPluginSourceFacts {
  return {
    servable: codexPluginSelectionsServableInDaemon(
      selections,
      standaloneMcpServers,
    ),
    httpServers: codexPluginHttpServers(selections).map((server) => ({
      target: mcpHttpAuthTargetKey({
        kind: 'plugin',
        marketplaceId: server.marketplaceId,
        pluginName: server.pluginName,
        serverName: server.serverName,
      }),
      identity: JSON.stringify([
        server.marketplaceId,
        server.pluginName,
        server.serverName,
        server.url,
      ]),
    })),
    overrides: (selections.mcpHttpAuthPreferences ?? []).map((preference) => ({
      target: mcpHttpAuthTargetKey(preference.target),
      handler: preference.handler,
    })),
  };
}

/** A run's collections whose MCP servers the daemon serves to a Codex step (CAN-6168). */
export function codexServablePluginCollections(
  snapshots: Readonly<Record<string, ResolvedPipelinePluginCollectionSnapshot>>,
): ReadonlySet<string> {
  const servable = new Set<string>();
  for (const [id, snapshot] of Object.entries(snapshots))
    if (
      codexPluginSelectionsServableInDaemon(
        snapshot.selections,
        snapshot.mcpServers,
      )
    )
      servable.add(id);
  return servable;
}

/**
 * A daemon Codex step's plugin MCP servers (CAN-6168). Only servers a plugin
 * brings are served: stdio without env, and HTTP without credential headers
 * through the loopback proxy, with the owner's credential when it binds one.
 * Anything else is a server the step would silently lose here, so the whole
 * step is refused, and the classifier keeps such steps in process before
 * they start.
 */
export async function daemonCodexPluginResolution(
  resolved: ResolvedPluginRuntime,
  routeSessionId: string,
  ports: DaemonCodexPluginMcpPorts,
): Promise<CodexPipelinePluginResolution> {
  const sources = resolved.codexPluginMcpSources ?? {};
  const codexMcpServers: CodexConfig = {};
  const ids: string[] = [];
  for (const [name, server] of Object.entries(resolved.mcpServers)) {
    const source: CodexPluginMcpSource | undefined = sources[name];
    const kind = servedAs(server, source);
    if (kind === null || !source || !isCodexConfig(server))
      throw new Error(DAEMON_CODEX_PLUGINS_UNAVAILABLE);
    if (kind === 'stdio') {
      codexMcpServers[name] = {
        command: server.command,
        ...(Array.isArray(server.args) && { args: server.args }),
        ...(typeof server.cwd === 'string' && { cwd: server.cwd }),
        ...toolPolicy(server),
      };
      continue;
    }
    if (typeof server.url !== 'string')
      throw new Error(DAEMON_CODEX_PLUGINS_UNAVAILABLE);
    const contentHash = pluginMcpServerContentHash(source.declaration);
    const bindSource = {
      marketplaceId: source.marketplaceId,
      pluginName: source.pluginName,
      serverName: source.serverName,
      contentHash,
    };
    const routeRef = await ports.bind(bindSource);
    const lease = await ports.proxy.registerRoute({
      ownerId: routeSessionId,
      upstreamUrl: server.url,
      ...(routeRef !== null && {
        authorizer: {
          credentials: ports.credentials,
          credential: ports.credentials.register(routeRef, (staleRef) =>
            ports.bind(bindSource, { staleRef }),
          ),
        },
      }),
    });
    codexMcpServers[name] = { url: lease.url, ...toolPolicy(server) };
    // The snapshot names the server as Electron main does (fingerprint v2):
    // the owner binds a route exactly when the server needs OAuth.
    ids.push(
      `${name}:${codexPluginMcpSnapshotKey({
        marketplaceId: source.marketplaceId,
        pluginName: source.pluginName,
        serverName: source.serverName,
        declaration: source.declaration,
        oauthRequired: routeRef !== null,
      })}`,
    );
  }
  authorityIds.set(codexMcpServers, ids.sort());
  return {
    warnings: resolved.warnings,
    selectedCapabilityRoots: resolved.selectedCapabilityRoots,
    codexMcpServers,
  };
}

/**
 * The capability authority ids of each resolution's servers (CAN-6168):
 * `<server name>:<its plugin, name and declaration hash>`, stable across
 * steps and a resumed session, never the step's own proxy route. The
 * fingerprint leaves those servers' loopback URLs out by name.
 */
const authorityIds = new WeakMap<CodexConfig, string[]>();

export function daemonCodexMcpAuthorityIds(servers: CodexConfig): string[] {
  return [...(authorityIds.get(servers) ?? [])];
}
