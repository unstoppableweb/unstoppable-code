import {
  accountMcpConnectionsEnabled,
  loadAccountMcpRefConnections,
  normalizeAccountMcpSelections,
} from '../mcp/account-catalog';
import {
  accountMcpConnectionForRef,
  isCustomAccountMcpServerKey,
  legacyAccountMcpConnectionId,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { accountMcpAuthState } from '../mcp/connection-status';
import {
  readMcpAccountIndexEntry,
  pluginMcpCuratedKey,
} from '../mcp/account-routing';
import {
  CURATED_PLUGIN_MCP_AMBIGUOUS,
  CURATED_PLUGIN_MCP_LIST_UNAVAILABLE,
  curatedPluginMcpMemberKey,
  findCuratedAccountMcpConnection,
  findCuratedDeviceMcpServer,
} from '../mcp/curated-plugin-binding';
import { readCachedCuratedMcpDesktopOnlyKeys } from '../mcp/curated-catalog';
import {
  mcpAuthConnectLabel,
  mcpAuthStatusLabel,
} from '@canopy/ui-shared/lib/mcp-card-display';
import { BRAND } from '@canopy/brand/current';
import { safeReadJson } from '../lib/fs-utils';
import {
  getBundleConfigFilePath,
  getCollectionConfigFilePath,
  getMcpServerFilePath,
} from '../lib/paths';
import type {
  ChatTabPluginSelections,
  McpHttpAuthHandler,
} from '@canopy/desktop-shared/types';
import {
  getMcpHttpAuthDefault,
  getMcpHttpAuthHandler,
} from '@canopy/execution-engine/lib/mcp-http-auth';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { CollectionConfigFile } from '@canopy/desktop-shared/types/collections';
import type { BundleConfigFile } from '@canopy/desktop-shared/types/bundles';
import type {
  AccountMcpConnection,
  DetectedMcpServerInfo,
  ListDetectedMcpServersResponse,
  McpServerAuthStatus,
  McpServerFile,
  McpServerRef,
} from '@canopy/execution-engine/types/mcp-servers';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import { probeMcpHttpOAuthRequirement } from '../mcp/oauth-probe';
import {
  pluginMcpOAuthProbeInputs,
  standaloneMcpOAuthProbeInputs,
} from '../mcp/oauth-probe-inputs';
import { getMcpOAuthAuthStatusForDefinition } from '../mcp/oauth-token-store';
import { readPreferencesFile } from '../lib/preferences-store';
import { loadMarketplaces } from './plugin-service';
import {
  readPluginMcpAuthEntries,
  resolvePluginAuthPrimaryPath,
  resolvePluginInfoPath,
} from './plugin-resolver';
import {
  buildPluginHttpMcpServerForAuth,
  hasPluginManagedAuth,
  hasPluginOAuthLikeMetadata,
  type PluginMcpAuthIdentity,
} from './plugin-mcp-auth';

interface StandaloneInventoryRef extends McpServerRef {
  source: 'standalone' | 'collection' | 'bundle';
  collectionId?: string;
  /** @deprecated Legacy Collection id alias. */
  bundleId?: string;
}

type McpHttpOAuthProbeResult = Awaited<
  ReturnType<typeof probeMcpHttpOAuthRequirement>
>;

async function probeMcpHttpOAuthRequirementForInventory(
  mcpUrl: string,
  headers: Record<string, string>,
  context: Record<string, string>,
): Promise<McpHttpOAuthProbeResult | null> {
  try {
    return await probeMcpHttpOAuthRequirement(mcpUrl, headers, undefined, {
      cacheOnly: true,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      '[mcp-inventory] Failed to read cached HTTP MCP OAuth requirement; continuing without OAuth requirement.',
      {
        ...context,
        errorName: error instanceof Error ? error.name : typeof error,
      },
    );
    return null;
  }
}

function readCollectionForInventory(
  collectionId: string,
): CollectionConfigFile['collection'] | null {
  const collectionFile = safeReadJson<CollectionConfigFile>(
    getCollectionConfigFilePath(collectionId),
  );
  if (collectionFile?.collection) {
    return collectionFile.collection;
  }

  const legacyBundleFile = safeReadJson<BundleConfigFile>(
    getBundleConfigFilePath(collectionId),
  );
  if (!legacyBundleFile?.bundle) {
    return null;
  }
  return {
    ...legacyBundleFile.bundle,
    mcpServers: Array.isArray(legacyBundleFile.bundle.mcpServers)
      ? legacyBundleFile.bundle.mcpServers
      : [],
  };
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const entry = value[key];
  return typeof entry === 'string' ? entry : undefined;
}

function authStatusLabel(
  status: McpServerAuthStatus,
  lastError: string | undefined,
  canRefresh = false,
): string {
  return status === 'error' && lastError
    ? lastError
    : mcpAuthStatusLabel(status, canRefresh);
}

async function buildAccountEntry(
  ref: StandaloneInventoryRef,
  connection: AccountMcpConnection,
): Promise<DetectedMcpServerInfo> {
  const state = await accountMcpAuthState({
    serverId: connection.serverKey,
    configId: connection.configId,
    accountConnectionId: connection.id,
  });
  return {
    key: `${ref.source}:${connection.serverKey}:${connection.configId}`,
    source: ref.source,
    serverName: connection.displayName,
    displayName: connection.displayName,
    type: 'http',
    serverId: connection.serverKey,
    configId: connection.configId,
    configName: 'Default',
    collectionId: ref.collectionId,
    bundleId: ref.bundleId,
    enabled: true,
    scope: 'account',
    authHandler: 'account',
    httpAuthHandler: 'account',
    accountConnectionId: connection.id,
    ...(connection.kind === 'CURATED'
      ? { curatedKey: connection.serverKey }
      : {}),
    authStatus: state.authStatus,
    authStatusLabel:
      state.authStatus === 'connected'
        ? 'Account connected'
        : 'Reconnect in cloud',
    canConnect: false,
  };
}

async function buildStandaloneEntry(
  ref: StandaloneInventoryRef,
  selections: ChatTabPluginSelections,
  defaultHandler: McpHttpAuthHandler,
  warnings: string[],
  accountConnections: () => Promise<AccountMcpConnection[] | null>,
): Promise<DetectedMcpServerInfo | null> {
  const accountOnly =
    legacyAccountMcpConnectionId(ref.serverId) !== undefined ||
    isCustomAccountMcpServerKey(ref.serverId);
  let file: McpServerFile | undefined;
  if (!accountOnly) {
    try {
      file = normalizeMcpServerFile(
        safeReadJson<unknown>(getMcpServerFilePath(ref.serverId)),
        ref.serverId,
      );
    } catch {
      file = undefined;
    }
  }
  if (!file) {
    const connection = accountMcpConnectionsEnabled()
      ? accountMcpConnectionForRef(
          ref,
          (await accountConnections()) ?? [],
          'attended',
        )
      : undefined;
    if (connection) return buildAccountEntry(ref, connection);
    if (!accountOnly)
      warnings.push(`MCP server "${ref.serverId}" could not be loaded.`);
    return null;
  }

  const config = file.server.configs.find((entry) => entry.id === ref.configId);
  if (!config) {
    warnings.push(`MCP server "${ref.serverId}" could not be loaded.`);
    return null;
  }

  const definition = file.server.definition;
  const indexEntry = await readMcpAccountIndexEntry(definition.id);
  const base: DetectedMcpServerInfo = {
    key: `${ref.source}:${definition.id}:${config.id}`,
    source: ref.source,
    serverName: definition.name,
    displayName: definition.name,
    description: definition.description,
    type: definition.type,
    url: definition.url,
    serverId: definition.id,
    configId: config.id,
    configName: config.name,
    collectionId: ref.collectionId,
    bundleId: ref.bundleId,
    curatedKey: definition.curated?.key,
    ...indexEntry,
    enabled: config.enabled,
    authStatus: 'not_configured',
    authStatusLabel: 'No auth',
    canConnect: false,
  };

  if (definition.type === 'command') {
    return {
      ...base,
      authStatus: 'unsupported',
      authStatusLabel: 'Command server',
      canToggleCanopyProxy: false,
      canopyProxyEnabled: false,
    };
  }

  const target = {
    kind: 'standalone' as const,
    serverId: definition.id,
    configId: config.id,
  };
  const resolvedHandler = getMcpHttpAuthHandler(
    selections,
    target,
    getMcpHttpAuthDefault(definition, indexEntry, defaultHandler),
  );
  const { handler } = resolvedHandler;
  const source: 'default' | 'server' | 'override' =
    resolvedHandler.source === 'override'
      ? 'override'
      : definition.httpAuthHandler !== undefined
        ? 'server'
        : 'default';
  const withHandler = {
    ...base,
    canToggleCanopyProxy:
      handler !== 'account' && indexEntry?.scope !== 'account',
    authHandler: handler,
    canopyProxyEnabled: handler === 'canopy',
    httpAuthHandler: handler,
    httpAuthHandlerSource: source,
  };

  if (handler === 'account') {
    const { authStatus, accountConnectionId } = await accountMcpAuthState({
      serverId: definition.id,
      configId: config.id,
      curatedKey: definition.curated?.key,
      accountConnectionId: indexEntry?.accountConnectionId,
    });
    return {
      ...withHandler,
      scope: 'account',
      accountConnectionId:
        accountConnectionId ?? indexEntry?.accountConnectionId,
      authStatus,
      authStatusLabel:
        authStatus === 'connected'
          ? 'Connected'
          : authStatus === 'not_connected'
            ? 'Connect in cloud'
            : 'Reconnect in cloud',
      canConnect: false,
    };
  }

  if (handler === 'provider') {
    return {
      ...withHandler,
      authStatus: 'not_configured',
      authStatusLabel: 'Agent provider',
      canConnect: false,
    };
  }

  if (definition.type === 'http' && config.authToken) {
    return {
      ...withHandler,
      authStatus: 'connected',
      authStatusLabel: 'Bearer token',
    };
  }

  const probeInputs = standaloneMcpOAuthProbeInputs(definition, config);
  const probe = probeInputs
    ? await probeMcpHttpOAuthRequirementForInventory(
        probeInputs.url,
        probeInputs.headers,
        {
          source: ref.source,
          serverId: definition.id,
          configId: config.id,
        },
      )
    : null;
  const auth = await getMcpOAuthAuthStatusForDefinition(definition, config);
  const requiresOAuth =
    definition.oauth ||
    probe?.requiresOAuth === true ||
    auth.hasStoredToken === true;

  if (requiresOAuth) {
    return {
      ...withHandler,
      authStatus: auth.status,
      ...(auth.canRefresh ? { canRefresh: true } : {}),
      ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
      authStatusLabel: authStatusLabel(
        auth.status,
        auth.lastError,
        auth.canRefresh,
      ),
      canConnect:
        mcpAuthConnectLabel(auth.status, auth.canRefresh) !== undefined,
      connectLabel: mcpAuthConnectLabel(auth.status, auth.canRefresh),
      lastError: auth.lastError,
      authErrorRevision: auth.authErrorRevision,
    };
  }

  return {
    ...withHandler,
    authStatusLabel: probe?.requirement === 'none' ? 'No auth' : 'Not checked',
    ...(probeInputs && config.enabled && probe?.requirement !== 'none'
      ? { canConnect: true, connectLabel: 'Connect' as const }
      : {}),
  };
}

/** The label an unbound curated member shows until its connection exists. */
export const CURATED_PLUGIN_MCP_CONNECT_LABEL =
  'Connect from the MCP Servers card';

/**
 * Project a curated plugin member by the connection the resolver binds it to
 * (REG-3033): the connected account connection for its key, else the device
 * server carrying that key, else an unbound row that points at the card. A
 * desktop-only key (REG-3035) skips the account lookup, as the resolver does.
 */
async function buildCuratedPluginEntry(args: {
  base: DetectedMcpServerInfo;
  curatedKey: string;
  handler: McpHttpAuthHandler;
  handlerSource: 'default' | 'override';
  selections: ChatTabPluginSelections;
  defaultHandler: McpHttpAuthHandler;
  warnings: string[];
  accountConnections: () => Promise<AccountMcpConnection[] | null>;
  desktopOnlyKeys: () => Promise<ReadonlySet<string>>;
}): Promise<DetectedMcpServerInfo> {
  const { base, curatedKey } = args;
  const unbound: DetectedMcpServerInfo = {
    ...base,
    curatedKey,
    authHandler: args.handler,
    httpAuthHandler: args.handler,
    httpAuthHandlerSource: args.handlerSource,
    canToggleCanopyProxy: true,
    canopyProxyEnabled: false,
    authStatus: 'not_connected',
    authStatusLabel: CURATED_PLUGIN_MCP_CONNECT_LABEL,
    canConnect: false,
  };
  const label = `${base.pluginName ?? ''}/${base.pluginServerName ?? base.serverName}`;
  if (
    accountMcpConnectionsEnabled() &&
    !(await args.desktopOnlyKeys()).has(curatedKey)
  ) {
    // The same rule as the resolver: the lookup must succeed before a device
    // server is considered; an unreadable list or an ambiguous key stays
    // unbound and points at the card.
    const connections = await args.accountConnections();
    if (connections === null) {
      args.warnings.push(
        `Account MCP server "${label}" skipped: ${CURATED_PLUGIN_MCP_LIST_UNAVAILABLE}`,
      );
      return unbound;
    }
    const lookup = findCuratedAccountMcpConnection(connections, curatedKey, {
      directRefs: args.selections.mcpServerRefs ?? [],
    });
    if (lookup.kind === 'ambiguous') {
      args.warnings.push(
        `Account MCP server "${label}" skipped: ${CURATED_PLUGIN_MCP_AMBIGUOUS}`,
      );
      return unbound;
    }
    if (lookup.kind === 'connection') {
      const { connection } = lookup;
      // The same rule as the resolver: a connection that exists but is not
      // usable fails closed and never falls through to a device server.
      const turnedOff = connection.enabled === false;
      const connected = connection.status === 'CONNECTED' && !turnedOff;
      return {
        ...unbound,
        scope: 'account',
        authHandler: 'account',
        httpAuthHandler: 'account',
        canToggleCanopyProxy: false,
        accountConnectionId: connection.id,
        authStatus: connected
          ? 'connected'
          : connection.status === 'REAUTH_REQUIRED' && !turnedOff
            ? 'error'
            : 'not_connected',
        authStatusLabel: connected
          ? 'Connected'
          : turnedOff
            ? 'Turned off in cloud'
            : 'Reconnect in cloud',
      };
    }
  }
  const device = await findCuratedDeviceMcpServer(curatedKey);
  if (device) {
    const deviceEntry = await buildStandaloneEntry(
      {
        serverId: device.serverFile.server.definition.id,
        configId: device.config.id,
        source: 'standalone',
      },
      args.selections,
      args.defaultHandler,
      args.warnings,
      args.accountConnections,
    );
    if (deviceEntry) {
      return {
        ...deviceEntry,
        key: base.key,
        source: 'plugin',
        serverName: base.serverName,
        displayName: base.displayName,
        ...(base.pluginProvider ? { pluginProvider: base.pluginProvider } : {}),
        marketplaceId: base.marketplaceId,
        pluginName: base.pluginName,
        pluginServerName: base.pluginServerName,
        curatedKey,
      };
    }
  }
  return unbound;
}

async function buildPluginEntry(
  marketplaceId: string,
  plugin: PluginInfo,
  serverName: string,
  rawValue: Record<string, unknown>,
  selections: ChatTabPluginSelections,
  defaultHandler: McpHttpAuthHandler,
  identity: PluginMcpAuthIdentity,
  warnings: string[],
  accountConnections: () => Promise<AccountMcpConnection[] | null>,
  desktopOnlyKeys: () => Promise<ReadonlySet<string>>,
  provider?: 'claude' | 'codex',
): Promise<DetectedMcpServerInfo | null> {
  const url = readString(rawValue, 'url');
  const httpUrl =
    url !== undefined && (!rawValue.type || rawValue.type === 'http')
      ? url
      : undefined;
  const isHttp = httpUrl !== undefined;
  const isCommand = typeof rawValue.command === 'string';
  if (!isHttp && !isCommand) {
    return null;
  }

  const base: DetectedMcpServerInfo = {
    key: `plugin:${marketplaceId}:${plugin.name}:${serverName}${identity.authNamespace ? ':codex' : ''}`,
    source: 'plugin',
    serverName,
    displayName: identity.authNamespace ? `${serverName} (Codex)` : serverName,
    ...(provider ? { pluginProvider: provider } : {}),
    type: isHttp ? 'http' : 'command',
    url,
    marketplaceId,
    pluginName: plugin.name,
    pluginServerName: serverName,
    enabled: true,
    authStatus: 'not_configured',
    authStatusLabel: 'No auth',
    canConnect: false,
  };

  if (!isHttp) {
    return {
      ...base,
      canToggleCanopyProxy: false,
      canopyProxyEnabled: false,
    };
  }

  const target = {
    kind: 'plugin' as const,
    marketplaceId,
    pluginName: plugin.name,
    serverName,
  };
  const { handler, source } = getMcpHttpAuthHandler(
    selections,
    target,
    defaultHandler,
  );
  const curatedKey = curatedPluginMcpMemberKey(marketplaceId, rawValue);
  if (curatedKey !== undefined && source !== 'override') {
    return buildCuratedPluginEntry({
      base,
      curatedKey,
      handler,
      handlerSource: source,
      selections,
      defaultHandler,
      warnings,
      accountConnections,
      desktopOnlyKeys,
    });
  }
  const withHandler = {
    ...base,
    canToggleCanopyProxy: handler !== 'account',
    authHandler: handler,
    canopyProxyEnabled: handler === 'canopy',
    httpAuthHandler: handler,
    httpAuthHandlerSource: source,
  };

  if (handler === 'account') {
    const server = buildPluginHttpMcpServerForAuth(identity, rawValue, false);
    const curatedKey = pluginMcpCuratedKey(rawValue);
    const { authStatus, accountConnectionId } = server
      ? await accountMcpAuthState({
          serverId: server.definition.id,
          configId: server.config.id,
          curatedKey,
        })
      : {
          authStatus: 'not_connected' as const,
          accountConnectionId: undefined,
        };
    return {
      ...withHandler,
      scope: 'account',
      accountConnectionId,
      curatedKey,
      authStatus,
      authStatusLabel:
        authStatus === 'connected'
          ? 'Connected'
          : authStatus === 'not_connected'
            ? 'Connect in cloud'
            : 'Reconnect in cloud',
      canConnect: false,
    };
  }

  if (handler === 'provider') {
    return {
      ...withHandler,
      authStatus: 'not_configured',
      authStatusLabel: 'Agent provider',
      canConnect: false,
    };
  }

  const authManaged = hasPluginManagedAuth(rawValue);
  const oauthLike = hasPluginOAuthLikeMetadata(rawValue);
  const authProbeServer = buildPluginHttpMcpServerForAuth(
    identity,
    rawValue,
    oauthLike,
  );
  const probeInputs = pluginMcpOAuthProbeInputs(identity, rawValue);
  const probe = probeInputs
    ? await probeMcpHttpOAuthRequirementForInventory(
        probeInputs.url,
        probeInputs.headers,
        {
          source: 'plugin',
          marketplaceId,
          pluginName: plugin.name,
          serverName,
        },
      )
    : null;
  const auth =
    authProbeServer && (!authManaged || oauthLike)
      ? await getMcpOAuthAuthStatusForDefinition(
          authProbeServer.definition,
          authProbeServer.config,
        )
      : null;
  const requiresOAuth =
    oauthLike || probe?.requiresOAuth === true || auth?.hasStoredToken === true;
  if (
    authManaged &&
    !requiresOAuth &&
    authProbeServer &&
    authProbeServer.missingAuthEnvVars.length > 0
  ) {
    return {
      ...withHandler,
      authStatus: 'error',
      authStatusLabel: 'Missing plugin auth',
      lastError: `Plugin auth environment variables are not available to ${BRAND.displayName}.`,
      canConnect: false,
    };
  }
  if (requiresOAuth && auth) {
    return {
      ...withHandler,
      authStatus: auth.status,
      ...(auth.canRefresh ? { canRefresh: true } : {}),
      ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
      authStatusLabel: authStatusLabel(
        auth.status,
        auth.lastError,
        auth.canRefresh,
      ),
      canConnect:
        mcpAuthConnectLabel(auth.status, auth.canRefresh) !== undefined,
      connectLabel: mcpAuthConnectLabel(auth.status, auth.canRefresh),
      lastError: auth.lastError,
      authErrorRevision: auth.authErrorRevision,
    };
  }

  if (authManaged) {
    return {
      ...withHandler,
      authStatusLabel: 'Configured by plugin',
    };
  }

  return {
    ...withHandler,
    authStatusLabel: probe?.requirement === 'none' ? 'No auth' : 'Not checked',
    ...(probeInputs && probe?.requirement !== 'none'
      ? { canConnect: true, connectLabel: 'Connect' as const }
      : {}),
  };
}

async function buildPluginEntries(
  marketplaceId: string,
  plugin: PluginInfo,
  pluginPath: string,
  selections: ChatTabPluginSelections,
  defaultHandler: McpHttpAuthHandler,
  warnings: string[],
  accountConnections: () => Promise<AccountMcpConnection[] | null>,
  desktopOnlyKeys: () => Promise<ReadonlySet<string>>,
  provider?: 'claude' | 'codex',
  primaryPluginPath?: string | null,
): Promise<DetectedMcpServerInfo[]> {
  const rawEntries = await readPluginMcpAuthEntries(
    pluginPath,
    marketplaceId,
    plugin.name,
    provider,
    primaryPluginPath,
  );
  const entries = await Promise.all(
    rawEntries.map(
      async ({
        serverName,
        rawValue,
        identity,
      }): Promise<DetectedMcpServerInfo | null> =>
        buildPluginEntry(
          marketplaceId,
          plugin,
          serverName,
          rawValue,
          selections,
          defaultHandler,
          identity,
          warnings,
          accountConnections,
          desktopOnlyKeys,
          provider,
        ),
    ),
  );
  return entries.filter((entry): entry is DetectedMcpServerInfo => {
    return entry !== null;
  });
}

function findMarketplacePlugin(
  marketplaces: readonly MarketplaceInfo[],
  marketplaceId: string,
  pluginName: string,
): { marketplace: MarketplaceInfo; plugin: PluginInfo } | null {
  const marketplace = marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) {
    return null;
  }

  const plugin = marketplace.plugins.find((entry) => entry.name === pluginName);
  return plugin ? { marketplace, plugin } : null;
}

export async function listDetectedMcpServersForSelections(
  rawSelections: ChatTabPluginSelections,
): Promise<ListDetectedMcpServersResponse> {
  const warnings: string[] = [];
  const selections = await normalizeAccountMcpSelections(
    normalizePluginSelections(rawSelections),
    warnings,
  );
  let accountConnections: Promise<AccountMcpConnection[] | null> | undefined;
  const loadAccountConnections = (): Promise<AccountMcpConnection[] | null> =>
    (accountConnections ??= loadAccountMcpRefConnections());
  let desktopOnlyKeys: Promise<ReadonlySet<string>> | undefined;
  const loadDesktopOnlyKeys = (): Promise<ReadonlySet<string>> =>
    (desktopOnlyKeys ??= readCachedCuratedMcpDesktopOnlyKeys());
  const preferences = await readPreferencesFile();
  const defaultHandler = preferences.mcpHttpAuthDefaultHandler;
  const standaloneRefs = new Map<string, StandaloneInventoryRef>();
  const pluginRefs = new Map<
    string,
    { marketplaceId: string; pluginName: string }
  >();

  for (const ref of selections.mcpServerRefs ?? []) {
    standaloneRefs.set(`${ref.serverId}:${ref.configId}`, {
      ...ref,
      source: 'standalone',
    });
  }
  for (const ref of selections.pluginRefs) {
    pluginRefs.set(`${ref.marketplaceId}:${ref.pluginName}`, ref);
  }

  for (const collectionId of selections.collectionIds) {
    const collection = readCollectionForInventory(collectionId);
    if (!collection) {
      warnings.push(`Collection "${collectionId}" could not be loaded.`);
      continue;
    }

    for (const ref of collection.mcpServers ?? []) {
      const key = `${ref.serverId}:${ref.configId}`;
      if (!standaloneRefs.has(key)) {
        standaloneRefs.set(key, {
          ...ref,
          source: 'collection',
          collectionId,
          bundleId: collectionId,
        });
      }
    }

    for (const ref of collection.plugins) {
      const key = `${ref.marketplaceId}:${ref.pluginName}`;
      if (!pluginRefs.has(key)) {
        pluginRefs.set(key, ref);
      }
    }
  }

  const servers: DetectedMcpServerInfo[] = [];
  for (const ref of Array.from(standaloneRefs.values())) {
    const entry = await buildStandaloneEntry(
      ref,
      selections,
      defaultHandler,
      warnings,
      loadAccountConnections,
    );
    if (entry) {
      servers.push(entry);
    }
  }

  // Marketplace discovery can initialize provider runtimes when the cache is
  // cold. Standalone-only inventories do not consume that catalog, so return
  // before doing unrelated work that can delay the Activity panel indefinitely.
  if (pluginRefs.size === 0) {
    return { servers, warnings };
  }

  const cacheResult = await loadMarketplaces();
  const marketplaces =
    cacheResult.success && cacheResult.data
      ? cacheResult.data.marketplaces
      : [];
  const seenPluginServers = new Set<string>();
  for (const ref of Array.from(pluginRefs.values())) {
    const found = findMarketplacePlugin(
      marketplaces,
      ref.marketplaceId,
      ref.pluginName,
    );
    if (!found) {
      warnings.push(`Plugin "${ref.pluginName}" is not installed.`);
      continue;
    }

    const providers: Array<'claude' | 'codex' | undefined> = [];
    if (found.plugin.facets?.claude) providers.push('claude');
    if (found.plugin.facets?.codex) providers.push('codex');
    if (providers.length === 0) providers.push(undefined);
    for (const provider of providers) {
      const pluginPath = await resolvePluginInfoPath(
        found.plugin,
        found.marketplace,
        warnings,
        false,
        provider,
      );
      if (!pluginPath) continue;
      const primaryPath = await resolvePluginAuthPrimaryPath(
        found.plugin,
        found.marketplace,
        provider,
        warnings,
      );
      for (const entry of await buildPluginEntries(
        ref.marketplaceId,
        found.plugin,
        pluginPath,
        selections,
        defaultHandler,
        warnings,
        loadAccountConnections,
        loadDesktopOnlyKeys,
        provider,
        primaryPath,
      )) {
        if (seenPluginServers.has(entry.key)) continue;
        seenPluginServers.add(entry.key);
        servers.push(entry);
      }
    }
  }

  return { servers, warnings };
}
