import { readClaudeEnabledPlugins } from '../../plugins/claude-enabled-plugins';
import { resolveInheritedCursorRoots } from '../../cursor/inherited-roots';
import { getOpenCodeMcpBaseEnv } from '../../opencode/mcp-servers';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentCapabilitySnapshot,
  AgentMcpHttpAuthPin,
  AgentMcpSelection,
} from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import {
  buildManagedMcpServerIdentityDigest,
  normalizeManagedMcpServerLabel,
  readManagedMcpServerNameDigest,
} from '@canopy/execution-engine/node/plugins/mcp-server-name';
import { resolvePluginServerCwd } from '@canopy/execution-engine/node/plugins/plugin-resolver';
import type { CodexConfig } from '@canopy/execution-engine/lib/codex-model-config';
import { getMcpHttpAuthHandler } from '@canopy/execution-engine/lib/mcp-http-auth';
import type {
  McpHttpAuthPreference,
  McpHttpAuthTarget,
} from '@canopy/desktop-shared/types';
import {
  loadPluginManifest,
  readPluginMcpConfigObjects,
  resolvePluginInfoPath,
  resolvePlugins,
  type McpHttpProxyServiceForResolver,
  type McpStdioBrokerForResolver,
  type ResolvedMcpServerBinding,
  type ResolvedMcpServerSource,
} from '../../plugins/plugin-resolver';
import { loadMarketplacesCacheOnly } from '../../plugins/plugin-service';
import { getMcpServerFilePath } from '../../lib/paths';
import { DelegationAgentCapabilityError } from './agent-capability-error';
import {
  accountMcpTransportDigest,
  mcpTransportDigest,
  inheritedPluginMcpTransportDigest,
  inheritedPluginInstallDigest,
  standaloneMcpTransportDigest,
} from './agent-mcp-fingerprint';
import {
  accountMcpConnectionsEnabled,
  loadAccountMcpRefConnections,
} from '../../mcp/account-catalog';
import { resolveAccountMcpProxyTarget } from '../../canopy-cloud/mcp-connections';
import { accountMcpConnectionForRef } from '@canopy/desktop-shared/lib/effective-plugin-selections';

/** Friendly, non-secret reason a live selection produced no usable server. */
export type DelegatedMcpUnavailableReason =
  | 'sign_in_required'
  | 'account_unavailable'
  | 'provider_unsupported'
  | 'unavailable';

/** A live selection that could not be materialized this run. `name` is
 * always a friendly display name, never a path, URL, or raw resolver text. */
export interface DelegatedMcpUnavailable {
  readonly name: string;
  readonly reason: DelegatedMcpUnavailableReason;
}

const UNAVAILABLE_REASON_LABEL: Readonly<
  Record<DelegatedMcpUnavailableReason, string>
> = {
  sign_in_required: 'sign-in required',
  account_unavailable: 'account unavailable',
  provider_unsupported: 'unavailable in this run',
  unavailable: 'unavailable',
};

/** One run-instruction paragraph naming every unavailable server and why,
 * so the child does not retry a tool that can never succeed. Empty when
 * nothing is unavailable. */
export function delegatedMcpUnavailableGuidance(
  unavailable: readonly DelegatedMcpUnavailable[],
): string {
  if (!unavailable.length) return '';
  const items = unavailable
    .map((entry) => `${entry.name} (${UNAVAILABLE_REASON_LABEL[entry.reason]})`)
    .join(', ');
  return `These MCP servers are unavailable in this run: ${items}. Do not try to call their tools.`;
}

interface LiveSelection {
  readonly selected: AgentMcpSelection;
  readonly sourceRoot?: string;
  readonly friendlyName: string;
  readonly digest: string;
  /** Standalone provider-owned HTTP uses the resolver's dynamic identity. */
  readonly directHttpDigest?: string;
  readonly transportUrl?: string;
  readonly transportCommand?: string;
  readonly transportArgs?: readonly string[];
  /** The directory a plugin stdio definition declares (resolved against the
   * live root); the resolver makes path args absolute against it. */
  readonly transportCwd?: string;
  /** Non-empty candidate substrings of a resolver warning about this
   * selection, used only to classify a friendly unavailable reason. */
  readonly warningIdentifiers: readonly string[];
}

export interface DelegatedMcpResolutionOptions {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly sessionId: string;
  /** Reserved for content staging (skill/plugin files the model reads);
   * MCP server processes now launch from the installed plugin root. */
  readonly stagedRootDir: string;
  /** The original host chat scope, never the child staging directory. */
  readonly inheritedPluginProjectPath?: string;
  readonly provider:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode';
  readonly signal: AbortSignal;
  readonly mcpHttpProxyService: McpHttpProxyServiceForResolver;
  readonly mcpStdioBroker: McpStdioBrokerForResolver;
  /** Unused; a stdio server launches without a separate consent prompt, like the parent chat. */
  readonly authorizeServerLaunch?: (
    serverName: string,
    command: string,
    args: readonly string[],
    signal: AbortSignal,
    cwd?: string,
  ) => Promise<boolean>;
  readonly authorizeToolCall: (
    serverName: string,
    toolName: string,
    args: unknown,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Filters a possibly-unknown value down to its string-valued entries. Used
 * for both stdio environment and HTTP headers: arbitrary names are allowed,
 * matching the parent's own launch environment and provider configuration. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

async function liveSelections(
  selections: readonly AgentMcpSelection[],
  provider:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode',
  inheritedPluginProjectPath?: string,
): Promise<LiveSelection[]> {
  const live: LiveSelection[] = [];
  const cache = selections.some(
    (entry) => entry.source === 'plugin' || entry.source === 'inherited-plugin',
  )
    ? await loadMarketplacesCacheOnly()
    : undefined;
  if (
    selections.some((entry) => entry.source === 'plugin') &&
    cache &&
    (!cache.success || !cache.data)
  )
    throw new DelegationAgentCapabilityError('missing_selection');
  let accountConnections:
    | ReturnType<typeof loadAccountMcpRefConnections>
    | undefined;
  for (const selection of selections) {
    if (selection.source === 'account') {
      if (!accountMcpConnectionsEnabled())
        throw new DelegationAgentCapabilityError('unsupported_capability');
      accountConnections ??= loadAccountMcpRefConnections();
      const connection = accountMcpConnectionForRef(
        selection,
        (await accountConnections) ?? [],
      );
      if (!connection)
        throw new DelegationAgentCapabilityError('missing_selection');
      if (accountMcpTransportDigest(connection) !== selection.configDigest)
        throw new DelegationAgentCapabilityError('config_changed');
      let upstreamUrl: string;
      try {
        ({ upstreamUrl } = await resolveAccountMcpProxyTarget({
          accountConnectionId: connection.id,
        }));
      } catch {
        throw new DelegationAgentCapabilityError('missing_selection');
      }
      live.push({
        selected: selection,
        friendlyName: connection.displayName,
        digest: buildManagedMcpServerIdentityDigest({
          kind: 'proxy',
          identityParts: [connection.serverKey, connection.configId],
        }),
        transportUrl: upstreamUrl,
        warningIdentifiers: [connection.displayName],
      });
      continue;
    }
    if (selection.source === 'standalone') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await readFile(getMcpServerFilePath(selection.serverId), 'utf8'),
        );
      } catch {
        throw new DelegationAgentCapabilityError('missing_selection');
      }
      let server;
      try {
        server = normalizeMcpServerFile(parsed, selection.serverId).server;
      } catch {
        throw new DelegationAgentCapabilityError('config_changed');
      }
      const config = server.configs.find(
        (entry) => entry.id === selection.configId,
      );
      if (!config || !config.enabled)
        throw new DelegationAgentCapabilityError('config_changed');
      const digest = standaloneMcpTransportDigest(
        selection.serverId,
        selection.configId,
        server.definition,
        config,
      );
      if (digest !== selection.configDigest)
        throw new DelegationAgentCapabilityError('config_changed');
      live.push({
        selected: selection,
        friendlyName:
          normalizeManagedMcpServerLabel(config.name) === 'default'
            ? server.definition.name
            : `${server.definition.name}/${config.name}`,
        digest: buildManagedMcpServerIdentityDigest({
          kind: server.definition.type === 'http' ? 'proxy' : 'dynamic',
          identityParts: [server.definition.id, config.id],
        }),
        ...(server.definition.type === 'http'
          ? {
              directHttpDigest: buildManagedMcpServerIdentityDigest({
                kind: 'dynamic',
                identityParts: [server.definition.id, config.id],
              }),
            }
          : {}),
        ...(server.definition.url
          ? { transportUrl: server.definition.url }
          : {}),
        ...(server.definition.command
          ? {
              transportCommand: server.definition.command,
              transportArgs: [
                ...(server.definition.args ?? []),
                ...config.extraArgs,
              ],
            }
          : {}),
        warningIdentifiers: [server.definition.name, server.definition.id],
      });
      continue;
    }
    let sourceRoot: string;
    let sourceProvider: 'claude' | 'codex' = 'claude';
    if (selection.source === 'inherited-plugin') {
      if (!inheritedPluginProjectPath)
        throw new DelegationAgentCapabilityError('missing_selection');
      const enabled = readClaudeEnabledPlugins(
        resolveInheritedCursorRoots().claudeConfigDir,
        inheritedPluginProjectPath,
      );
      const alias = cache?.success
        ? cache.data?.marketplaces.find(
            (entry) => entry.id === selection.marketplaceId,
          )?.name
        : undefined;
      const installed =
        enabled?.get(`${selection.pluginName}@${selection.marketplaceId}`) ??
        (alias ? enabled?.get(`${selection.pluginName}@${alias}`) : undefined);
      if (!installed)
        throw new DelegationAgentCapabilityError('missing_selection');
      try {
        if (
          inheritedPluginInstallDigest(installed) !==
          selection.installationDigest
        )
          throw new DelegationAgentCapabilityError('config_changed');
      } catch {
        throw new DelegationAgentCapabilityError('config_changed');
      }
      sourceRoot = installed;
    } else {
      const marketplace = cache?.data?.marketplaces.find(
        (entry) => entry.id === selection.marketplaceId,
      );
      const plugin = marketplace?.plugins.find(
        (entry) =>
          entry.name.toLowerCase() === selection.pluginName.toLowerCase(),
      );
      if (!marketplace || !plugin)
        throw new DelegationAgentCapabilityError('missing_selection');
      const selectedPlugin =
        provider === 'codex' && plugin.facets?.codex
          ? { ...plugin, facets: { codex: plugin.facets.codex } }
          : plugin;
      const warnings: string[] = [];
      const resolvedRoot = await resolvePluginInfoPath(
        selectedPlugin,
        marketplace,
        warnings,
        false,
      );
      if (!resolvedRoot || warnings.length)
        throw new DelegationAgentCapabilityError('missing_selection');
      sourceRoot = resolvedRoot;
      sourceProvider =
        provider === 'codex' && plugin.facets?.codex ? 'codex' : 'claude';
    }
    const manifest = loadPluginManifest(sourceRoot, sourceProvider);
    const raw = readPluginMcpConfigObjects(sourceRoot, manifest)[
      selection.serverName
    ];
    if (!raw) throw new DelegationAgentCapabilityError('config_changed');
    const digest = (
      selection.source === 'inherited-plugin'
        ? inheritedPluginMcpTransportDigest
        : mcpTransportDigest
    )(raw, {
      marketplaceId: selection.marketplaceId,
      pluginName: selection.pluginName,
      serverName: selection.serverName,
    });
    if (digest !== selection.configDigest)
      throw new DelegationAgentCapabilityError('config_changed');
    live.push({
      selected: selection,
      sourceRoot,
      friendlyName: `${selection.pluginName}/${selection.serverName}`,
      digest: buildManagedMcpServerIdentityDigest({
        kind: 'plugin',
        identityParts: [
          selection.marketplaceId,
          selection.pluginName,
          selection.serverName,
        ],
      }),
      ...(typeof raw.url === 'string' ? { transportUrl: raw.url } : {}),
      ...(typeof raw.command === 'string'
        ? {
            transportCommand: raw.command,
            transportArgs: strings(raw.args),
            transportCwd: resolvePluginServerCwd(raw.cwd, sourceRoot),
          }
        : {}),
      warningIdentifiers: [
        `${selection.marketplaceId}/${selection.pluginName}:${selection.serverName}`,
        `${selection.marketplaceId}/${selection.pluginName}`,
        `${selection.pluginName}/${selection.serverName}`,
        selection.serverName,
      ],
    });
  }
  return live;
}

function expandedSourceValue(value: string, live: LiveSelection): string {
  return live.sourceRoot
    ? value.split('${CLAUDE_PLUGIN_ROOT}').join(live.sourceRoot)
    : value;
}

/** Pins a resolved stdio command/args against the selection's pinned
 * transport, expanded against the plugin's installed (live) root — the same
 * root the parent launches from. */
function matchesSelectedStdio(
  live: LiveSelection,
  command: string,
  args: readonly string[],
): boolean {
  // A plugin-relative command is resolved against the root only; the
  // resolver never resolves a command against cwd, and a bare command such
  // as `node` is a PATH lookup, never a root-relative file.
  const expectedCommand = (value: string): string[] => {
    const expanded = expandedSourceValue(value, live);
    return live.sourceRoot &&
      expanded.includes('/') &&
      !path.isAbsolute(expanded)
      ? [expanded, path.resolve(live.sourceRoot, expanded)]
      : [expanded];
  };
  // The resolver makes a cwd-relative arg that names a file absolute, bare
  // names included, so a non-absolute pinned arg may legitimately arrive
  // resolved against the declared cwd (the root when none is declared). The
  // match deliberately does not consult the filesystem: it only widens what
  // counts as the same spelling, never what the resolver may emit.
  const expectedArg = (value: string): string[] => {
    const expanded = expandedSourceValue(value, live);
    if (!live.sourceRoot || expanded === '' || path.isAbsolute(expanded))
      return [expanded];
    return [
      expanded,
      path.resolve(live.transportCwd ?? live.sourceRoot, expanded),
    ];
  };
  return (
    live.transportCommand !== undefined &&
    expectedCommand(live.transportCommand).includes(command) &&
    args.length === (live.transportArgs ?? []).length &&
    args.every((entry, index) =>
      expectedArg((live.transportArgs ?? [])[index] ?? '').includes(entry),
    )
  );
}

/** Whether a bound server's recorded source is this live selection. */
function sourceMatchesSelection(
  source: ResolvedMcpServerSource,
  selected: AgentMcpSelection,
): boolean {
  if (source.kind === 'plugin')
    return (
      (selected.source === 'plugin' ||
        selected.source === 'inherited-plugin') &&
      selected.marketplaceId === source.marketplaceId &&
      selected.pluginName === source.pluginName &&
      selected.serverName === source.serverName
    );
  return (
    selected.source !== 'plugin' &&
    selected.source !== 'inherited-plugin' &&
    selected.serverId === source.serverId &&
    selected.configId === source.configId
  );
}

/** Whether a standalone/plugin HTTP target's recorded per-chat preference is
 * an explicit 'account' override. When it is, the resolver proxies the
 * server through the connected account's own upstream, which is not the
 * selection's own definition URL — so the strict upstream-must-match-pinned
 * check is relaxed for this one target (still only ever a proxied route). */
function accountHandledHttpTarget(
  selected: AgentMcpSelection,
  preferences: readonly McpHttpAuthPreference[],
): boolean {
  if (!preferences.length) return false;
  const target: McpHttpAuthTarget | undefined =
    selected.source === 'plugin' || selected.source === 'inherited-plugin'
      ? {
          kind: 'plugin',
          marketplaceId: selected.marketplaceId,
          pluginName: selected.pluginName,
          serverName: selected.serverName,
        }
      : selected.source === 'standalone'
        ? {
            kind: 'standalone',
            serverId: selected.serverId,
            configId: selected.configId,
          }
        : undefined;
  if (!target) return false;
  const resolved = getMcpHttpAuthHandler(
    {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpHttpAuthPreferences: [...preferences],
    },
    target,
    'canopy',
  );
  return resolved.source === 'override' && resolved.handler === 'account';
}

/** Best-effort, non-secret classification of why a live selection produced
 * no server: match the resolver's own warning text against the selection's
 * identifiers, then look for known phrases. Defaults to the generic reason
 * when nothing matches, never surfacing raw warning text. */
function classifyUnavailableReason(
  warnings: readonly string[],
  identifiers: readonly string[],
): DelegatedMcpUnavailableReason {
  const candidates = identifiers.filter((identifier) => identifier.length > 0);
  const matches = warnings.filter((warning) =>
    candidates.some((identifier) => warning.includes(identifier)),
  );
  if (!matches.length) return 'unavailable';
  const text = matches.join(' ').toLowerCase();
  if (text.includes('oauth')) return 'sign_in_required';
  if (text.includes('account')) return 'account_unavailable';
  return 'unavailable';
}

/** Resolve only retained selections, verify transport drift, and require scoped gateways. */
export async function resolveDelegatedMcpCapabilities(
  capabilities: AgentCapabilitySnapshot,
  options: DelegatedMcpResolutionOptions,
): Promise<{
  mcpServers: Record<string, McpServerConfig>;
  codexMcpServers: CodexConfig;
  serverNameByProxyUrl: Readonly<Record<string, string>>;
  providerGatedServers: string[];
  unavailable: DelegatedMcpUnavailable[];
}> {
  if (capabilities.hookDeclarations.length)
    throw new DelegationAgentCapabilityError('unsupported_hooks');
  if (options.signal.aborted)
    throw new DelegationAgentCapabilityError('unsupported_capability');
  if (!capabilities.mcpSelections.length)
    return {
      mcpServers: {},
      codexMcpServers: {},
      serverNameByProxyUrl: {},
      providerGatedServers: [],
      unavailable: [],
    };
  const live = await liveSelections(
    capabilities.mcpSelections,
    options.provider,
    options.inheritedPluginProjectPath,
  );
  const registeredProxyIds = new Set<string>();
  const proxyUpstreams = new Map<string, string>();
  const brokeredByName = new Map<string, { command: string; args: string[] }>();
  // The general resolver turns broker failures into warnings. Preserve a
  // delegated capability rejection so its public error code survives.
  let brokerCapabilityError: DelegationAgentCapabilityError | undefined;
  const proxy: McpHttpProxyServiceForResolver = {
    ensureStarted: (port) => options.mcpHttpProxyService.ensureStarted(port),
    registerRoute: async (route) => {
      if (route.sessionId !== options.sessionId || options.signal.aborted)
        throw new DelegationAgentCapabilityError('invalid_projection');
      const routeId = await options.mcpHttpProxyService.registerRoute({
        ...route,
        requireToolCallGate: true,
      });
      if (options.signal.aborted) {
        options.mcpHttpProxyService.unregisterRoute(routeId);
        throw new DelegationAgentCapabilityError('unsupported_capability');
      }
      registeredProxyIds.add(routeId);
      proxyUpstreams.set(routeId, route.upstreamUrl);
      return routeId;
    },
    unregisterRoute: (routeId) =>
      options.mcpHttpProxyService.unregisterRoute(routeId),
    getProxyUrl: (routeId) => options.mcpHttpProxyService.getProxyUrl(routeId),
  };
  const pluginRefs = new Map<
    string,
    { marketplaceId: string; pluginName: string }
  >();
  const inheritedPluginRefs = new Map<
    string,
    { marketplaceId: string; pluginName: string; installPath: string }
  >();
  const mcpServerRefs: { serverId: string; configId: string }[] = [];
  for (const entry of live) {
    const selected = entry.selected;
    if (selected.source === 'plugin')
      pluginRefs.set(`${selected.marketplaceId}/${selected.pluginName}`, {
        marketplaceId: selected.marketplaceId,
        pluginName: selected.pluginName,
      });
    else if (selected.source === 'inherited-plugin') {
      if (!entry.sourceRoot)
        throw new DelegationAgentCapabilityError('missing_selection');
      inheritedPluginRefs.set(
        `${selected.marketplaceId}/${selected.pluginName}`,
        {
          marketplaceId: selected.marketplaceId,
          pluginName: selected.pluginName,
          installPath: entry.sourceRoot,
        },
      );
    } else
      mcpServerRefs.push({
        serverId: selected.serverId,
        configId: selected.configId,
      });
  }
  const broker: McpStdioBrokerForResolver = {
    registerStdioMcpRoute: async (request, registration) => {
      const signal = registration?.signal
        ? AbortSignal.any([options.signal, registration.signal])
        : options.signal;
      if (signal.aborted)
        throw new DelegationAgentCapabilityError('unsupported_capability');
      const identity = readManagedMcpServerNameDigest(request.routeKey);
      const selected = live.find((entry) => entry.digest === identity);
      if (!selected)
        throw new DelegationAgentCapabilityError('invalid_projection');
      if (!matchesSelectedStdio(selected, request.command, request.args ?? []))
        throw new DelegationAgentCapabilityError('config_changed');
      // The resolver already expanded ${CLAUDE_PLUGIN_ROOT} to the plugin's
      // installed root, exactly as the parent launches it. Default the
      // working directory to that same root when the server declares none.
      const cwd =
        request.cwd ??
        (selected.selected.source === 'plugin' ||
        selected.selected.source === 'inherited-plugin'
          ? selected.sourceRoot
          : undefined);
      const route = await options.mcpStdioBroker.registerStdioMcpRoute(
        { ...request, ...(cwd ? { cwd } : {}) },
        {
          signal,
          toolCallGate: (call) =>
            options.authorizeToolCall(
              request.routeKey,
              call.toolName,
              call.arguments,
              call.signal,
            ),
        },
      );
      brokeredByName.set(request.routeKey, {
        command: route.command,
        args: route.args,
      });
      return route;
    },
  };
  // Only the parent's explicit overrides are overrides in the child; pins
  // synthesized from inherited defaults set the handler as defaults, so a
  // curated member pinned to a default still binds to its connection.
  const strip = (pin: AgentMcpHttpAuthPin): McpHttpAuthPreference => ({
    target: pin.target,
    handler: pin.handler,
  });
  const resolved = await resolvePlugins(
    {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: Array.from(pluginRefs.values()),
      mcpServerRefs,
      mcpHttpAuthPreferences: capabilities.mcpHttpAuthPreferences
        .filter((pin) => pin.source !== 'default')
        .map(strip),
    },
    options.projectId,
    options.worktreeId,
    options.chatId,
    {
      purpose:
        options.provider === 'codex'
          ? 'delegation-codex-mcp'
          : options.provider === 'opencode'
            ? 'opencode-session'
            : options.provider === 'copilot'
              ? 'copilot-session'
              : 'cursor-session',
      installExternalPlugins: false,
      ...(inheritedPluginRefs.size
        ? { inheritedPluginRefs: Array.from(inheritedPluginRefs.values()) }
        : {}),
      enableHttpMcpProxy: true,
      mcpHttpProxyService: proxy,
      mcpHttpAuthPins: capabilities.mcpHttpAuthPreferences
        .filter((pin) => pin.source === 'default')
        .map(strip),
      ...(options.provider === 'codex'
        ? {
            mcpStdioBroker: {
              registerStdioMcpRoute: async (
                ...args
              ): Promise<
                Awaited<
                  ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>
                >
              > => {
                try {
                  return await broker.registerStdioMcpRoute(...args);
                } catch (error) {
                  if (error instanceof DelegationAgentCapabilityError)
                    brokerCapabilityError ??= error;
                  throw error;
                }
              },
            },
          }
        : {}),
      sessionId: options.sessionId,
    },
  );
  if (options.signal.aborted)
    throw new DelegationAgentCapabilityError('unsupported_capability');
  if (brokerCapabilityError) throw brokerCapabilityError;
  // Credential values can change while the source transport must stay pinned.
  await liveSelections(
    capabilities.mcpSelections,
    options.provider,
    options.inheritedPluginProjectPath,
  );
  const proxyUrls = new Map(
    Array.from(registeredProxyIds).map((routeId) => [
      proxy.getProxyUrl(routeId),
      proxyUpstreams.get(routeId),
    ]),
  );
  const mcpServers: Record<string, McpServerConfig> = {};
  const codexMcpServers: CodexConfig = {};
  const serverNameByProxyUrl: Record<string, string> = {};
  const providerGatedServers: string[] = [];
  const unavailable: DelegatedMcpUnavailable[] = [];
  const used = new Set<LiveSelection>();
  for (const [name, raw] of Object.entries(resolved.mcpServers)) {
    const server = record(raw);
    if (!server)
      throw new DelegationAgentCapabilityError('unsupported_capability');
    if (server.enabled === false) continue;
    if (name.startsWith('canopy') || name.startsWith('mcp__'))
      throw new DelegationAgentCapabilityError('invalid_projection');
    const identity = readManagedMcpServerNameDigest(name);
    // A server bound to a connection (REG-3033) is named by that connection,
    // so a curated plugin member that collapsed into it is matched through
    // the resolver's recorded provenance rather than its plugin digest.
    const bound: ResolvedMcpServerBinding | undefined =
      resolved.mcpServerBindings[name];
    const matching = live.filter(
      (entry) =>
        entry.digest === identity ||
        (server.type === 'http' &&
          entry.directHttpDigest !== undefined &&
          entry.directHttpDigest === identity) ||
        bound?.sources.some((source) =>
          sourceMatchesSelection(source, entry.selected),
        ) === true,
    );
    const selected = matching[0];
    if (!selected || matching.some((entry) => used.has(entry)))
      throw new DelegationAgentCapabilityError('invalid_projection');
    for (const entry of matching) used.add(entry);
    if (server.type === 'http' && typeof server.url === 'string') {
      const proxyUpstream = proxyUrls.get(server.url);
      if (proxyUpstream !== undefined) {
        // Proxied: 'canopy' (or 'account' on a standalone/plugin server)
        // handled this server, so the child config never holds the secret.
        // A bound server's upstream is the connection's, by construction.
        const accountRouted =
          bound !== undefined ||
          accountHandledHttpTarget(
            selected.selected,
            capabilities.mcpHttpAuthPreferences,
          );
        if (
          (!accountRouted && proxyUpstream !== selected.transportUrl) ||
          record(server.headers)
        )
          throw new DelegationAgentCapabilityError('unsupported_capability');
        mcpServers[name] = { type: 'http', url: server.url, alwaysLoad: true };
        codexMcpServers[name] = { url: server.url, required: false };
        serverNameByProxyUrl[server.url] = name;
        continue;
      }
      // Direct, provider-handled entry: the same definition the parent would
      // pass to the provider, including any static headers. The provider's
      // own tool-approval path gates these calls, not our proxy.
      if (server.url !== selected.transportUrl)
        throw new DelegationAgentCapabilityError('unsupported_capability');
      // Cursor ACP approval is advisory. A child must have an execution-time
      // proxy/broker gate; a direct provider-owned HTTP transport has none.
      if (
        options.provider === 'cursor' ||
        options.provider === 'copilot' ||
        options.provider === 'opencode'
      ) {
        unavailable.push({
          name: selected.friendlyName,
          reason: 'provider_unsupported',
        });
        continue;
      }
      const headers = stringRecord(server.headers);
      if (options.provider === 'codex') {
        const configured = resolved.codexMcpServers[name];
        if (!configured) {
          // buildCodexPluginMcpServers drops headered HTTP servers for
          // Codex parents too; parity means unavailable, not an error.
          unavailable.push({
            name: selected.friendlyName,
            reason: 'provider_unsupported',
          });
          continue;
        }
        codexMcpServers[name] = configured;
      } else {
        mcpServers[name] = {
          type: 'http',
          url: server.url,
          ...(headers ? { headers } : {}),
          alwaysLoad: true,
        };
      }
      providerGatedServers.push(name);
      continue;
    }
    if (server.type !== 'stdio' || typeof server.command !== 'string')
      throw new DelegationAgentCapabilityError('unsupported_capability');
    if (options.provider === 'codex') {
      const brokered = brokeredByName.get(name);
      if (
        !brokered ||
        brokered.command !== server.command ||
        JSON.stringify(brokered.args) !== JSON.stringify(strings(server.args))
      )
        throw new DelegationAgentCapabilityError('invalid_projection');
      mcpServers[name] = {
        type: 'stdio',
        command: brokered.command,
        args: brokered.args,
        alwaysLoad: true,
      };
      const configured = resolved.codexMcpServers[name];
      if (!configured)
        throw new DelegationAgentCapabilityError('invalid_projection');
      codexMcpServers[name] = configured;
      continue;
    }
    if (!matchesSelectedStdio(selected, server.command, strings(server.args)))
      throw new DelegationAgentCapabilityError('config_changed');
    const command = server.command;
    const args = strings(server.args);
    const cwd =
      typeof server.cwd === 'string'
        ? server.cwd
        : selected.selected.source === 'plugin' ||
            selected.selected.source === 'inherited-plugin'
          ? selected.sourceRoot
          : undefined;
    const env = stringRecord(server.env);
    const route = await options.mcpStdioBroker.registerStdioMcpRoute(
      {
        ownerId: options.sessionId,
        routeKey: name,
        command,
        args,
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
        // OpenCode's retained route is also used for discovery before a tool
        // approval. Match its ordinary host policy, excluding managed secrets.
        ...(options.provider === 'opencode'
          ? { baseEnv: getOpenCodeMcpBaseEnv() }
          : {}),
      },
      {
        signal: options.signal,
        toolCallGate: (call) =>
          options.authorizeToolCall(
            name,
            call.toolName,
            call.arguments,
            call.signal,
          ),
      },
    );
    if (options.signal.aborted)
      throw new DelegationAgentCapabilityError('unsupported_capability');
    mcpServers[name] = {
      type: 'stdio',
      command: route.command,
      args: route.args,
      // The Claude process has a private TMPDIR. Its broker launcher must
      // rendezvous with the parent broker in the parent's runtime directory.
      env: {
        TMPDIR: os.tmpdir(),
        TMP: os.tmpdir(),
        TEMP: os.tmpdir(),
      },
      alwaysLoad: true,
    };
    codexMcpServers[name] = {
      command: route.command,
      args: route.args,
      ...(route.cwd ? { cwd: route.cwd } : {}),
      required: false,
    };
  }
  // Every remaining live selection produced no server and no fatal error:
  // the resolver degraded it, exactly as it would for the parent chat.
  for (const selected of live) {
    if (used.has(selected)) continue;
    unavailable.push({
      name: selected.friendlyName,
      reason: classifyUnavailableReason(
        resolved.warnings,
        selected.warningIdentifiers,
      ),
    });
  }
  return {
    mcpServers,
    codexMcpServers,
    serverNameByProxyUrl,
    providerGatedServers,
    unavailable,
  };
}
