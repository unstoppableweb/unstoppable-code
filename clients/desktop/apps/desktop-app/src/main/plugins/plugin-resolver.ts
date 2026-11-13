import {
  inheritedPluginMcpTransportDigest,
  inheritedPluginInstallDigest,
} from '../agents/delegation/agent-mcp-fingerprint';
import type { AgentMcpHttpAuthPin } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  mcpCapabilityIdentityKey,
  type McpCapabilityIdentity,
} from '@canopy/protocol/mcp-servers';
import { skillResourceContextEnabled } from '../skills/resource-lanes';
import { readInstalledItemPolicy } from '../installed-items/installed-item-policy';
import {
  installedItemKey,
  type InstalledItemRef,
} from '@canopy/protocol/installed-items';
import { assertStoredSkillContext } from '../skills/skill-install-context';
import {
  accountMcpConnectionsEnabled,
  loadAccountMcpRefConnections,
} from '../mcp/account-catalog';
import {
  accountMcpConnectionForRef,
  isCustomAccountMcpServerKey,
  legacyAccountMcpConnectionId,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import type { AccountMcpConnection } from '@canopy/execution-engine/types/mcp-servers';
import {
  resolveAccountMcpProxyTarget,
  type AccountMcpConnectionTarget,
} from '../canopy-cloud/mcp-connections';
import { accountMcpConnectionUnusableReason } from '../canopy-cloud/mcp-connection-usable';
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
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import {
  CODEX_MCP_STDIO_LAUNCHER_COMMAND,
  createLocalCapabilityRoot,
  isCodexMcpRouteId,
  type CodexStdioMcpLaunchRequest,
  type CodexStdioMcpLaunchRoute,
  type CodexStdioMcpRegistrationOptions,
} from '@canopy/execution-engine/node/codex-runtime';
import {
  isCodexConfig,
  type CodexConfig,
} from '@canopy/execution-engine/lib/codex-model-config';
import { sanitizeEnvVars } from '@canopy/execution-engine/lib/mcp-security';
import {
  getMcpHttpAuthDefault,
  getMcpHttpAuthHandler,
  mcpHttpAuthTargetKey,
} from '@canopy/execution-engine/lib/mcp-http-auth';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  buildAccountMcpServerName,
  buildManagedMcpServerName,
  normalizeManagedMcpServerLabel,
} from '@canopy/execution-engine/node/plugins/mcp-server-name';
import {
  resolveCwdRelativePathArg,
  resolvePluginServerCwd,
} from '@canopy/execution-engine/node/plugins/plugin-resolver';
import { safeReadJson, safeReadJsonAsync, safeReadText } from '../lib/fs-utils';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  getChatPluginsRootDir,
  getChatSkillPluginDir,
  getDataDir,
  getMcpServerFilePath,
} from '../lib/paths';
import { isPathInside } from '../lib/path-safety';
import {
  assignCursorInvocationIds,
  cursorInvocationKey,
  cursorLoadsPluginMemberKind,
  emptyCursorCapabilityProjection,
  inheritedCursorEntryLabel,
  renderCursorCommandMarkdown,
  sortCursorPluginMembers,
  type CursorCapabilityProjection,
  type CursorInvocationSource,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import type { InheritedCursorCapabilities } from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
import {
  canonicalPathInside,
  discoverPluginCommandSources,
  discoverPluginSkills,
  type ClaudeSkillSource,
  type PluginCommandSource,
} from './plugin-members';
import { parseFrontmatter, parseFrontmatterAndBody } from '../lib/frontmatter';
import {
  getBundledSkillDir,
  getBundledSkillsDir,
} from '../pipelines/config-paths';
import {
  getSkillDir,
  getSkillsRootDir,
  isBuiltinSourceId,
} from '../skills/paths';
import type {
  AgentProviderType,
  ChatTabPluginSelections,
  CodexSelectedCapabilityRoot,
  McpHttpAuthHandler,
  McpHttpAuthPreference,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type { PipelinePackageCapabilityOverlay } from '@canopy/execution-engine/types/pipeline';
import { DEFAULT_MCP_HTTP_AUTH_HANDLER } from '@canopy/desktop-shared/types';
import { readCollectionConfig } from '../collections/collection-store';
import type {
  McpServerConfigData,
  McpServerDefinitionData,
  McpServerFile,
  McpServerIndexEntry,
} from '@canopy/execution-engine/types/mcp-servers';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import type {
  MarketplaceInfo,
  PluginProviderFacet,
  PluginInfo,
  PluginManifest,
} from '@canopy/execution-engine/types/plugins';
import { createGeneratedSkillName } from './codex-plugin-compat';
import { scanPluginMods } from './plugin-scanner';
import {
  installPlugin,
  loadMarketplaces,
  buildCodexCompatDisabledKey,
} from './plugin-service';
import {
  buildPluginHttpMcpServerForAuth,
  getPluginMcpAuthNamespace,
  getLegacyPluginMcpAuthNamespace,
  getLegacyPluginMcpOAuthIds,
  getPreviousDeclarationPluginMcpOAuthIds,
  hasPluginOAuthLikeMetadata,
  resolvePluginHttpHeaders,
  type PluginMcpAuthIdentity,
} from './plugin-mcp-auth';
import {
  projectClaudePluginForLaunch,
  projectClaudePluginWithoutMcpServers,
} from './claude-plugin-projection';
import {
  isPluginInstallRoot,
  registeredClaudePluginId,
} from './claude-enabled-plugins';
import { probeMcpHttpOAuthRequirement } from '../mcp/oauth-probe';
import { migratePluginMcpOAuthToken } from '../mcp/oauth-token-store';
import { getDesktopCodexCapabilityStore } from '../codex/capability-store';
import { materializeCodexPluginsOffMain } from './codex-plugin-materialization-runner';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import {
  evaluateClaudeModAdmission,
  inspectClaudePluginHooks,
  type ClaudeModAdmissionDecision,
  type ClaudeModPluginInput,
} from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import {
  resolveClaudeModAdmissionContext,
  resolveClaudeModConfigDirectory,
  type ClaudeModAdmissionContext,
} from '../agents/claude-mod-admission-launch';
import {
  isSkippedClaudeMod,
  type SkippedClaudeMod,
} from '@canopy/execution-engine/types/claude-mod-admission';

interface SdkPluginConfig {
  type: 'local';
  path: string;
}

export const MISSING_PLUGIN_PATH_WARNING_PREFIX = 'Plugin path does not exist:';

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  'user-invocable'?: boolean;
}

interface PluginResolvedPath {
  pluginPath: string;
  pluginName: string;
  marketplaceId: string;
  category: string;
  provider: 'claude' | 'codex';
  mode: 'native' | 'compat';
  /** Present only for a native Codex facet alongside a Claude facet. */
  primaryAuthPluginPath?: string | null;
}

interface PluginResolvedSkill {
  name: string;
  description: string;
  sourceDir: string;
  skillMdPath: string;
}

interface ResolvedStandaloneMcpServer {
  [key: string]: JsonValue | undefined;
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** The connection a resolved HTTP server is bound to, whoever asked for it. */
export type ResolvedMcpServerBindingTarget =
  | {
      kind: 'account';
      accountConnectionId: string;
      serverKey: string;
      configId: string;
    }
  | { kind: 'device'; serverId: string; configId: string };

/** A selection that asked for a bound server: a standalone ref or a plugin member. */
export type ResolvedMcpServerSource =
  | { kind: 'standalone'; serverId: string; configId: string }
  | {
      kind: 'plugin';
      marketplaceId: string;
      pluginName: string;
      serverName: string;
    };

/**
 * Provenance of one bound `mcpServers` entry. The managed name carries the
 * connection identity only; which plugin or ref selected it lives here so
 * warnings, inventory, and delegation can say "provided by plugin X" without
 * a second runtime server.
 */
export interface ResolvedMcpServerBinding {
  binding: ResolvedMcpServerBindingTarget;
  displayName: string;
  sources: ResolvedMcpServerSource[];
}

interface BoundMcpServer {
  serverName: string;
  server: ResolvedStandaloneMcpServer;
  binding: ResolvedMcpServerBinding;
}

interface McpHttpProxyRouteInput {
  sessionId: string | null;
  requireToolCallGate?: boolean;
  routeKey?: string;
  serverId: string;
  configId: string;
  displayName: string;
  upstreamUrl: string;
  headers: Record<string, string>;
  oauthEnabled: boolean;
  authSupplier?: 'oauth' | 'canopy-cloud';
  oauthRequired?: boolean;
  oauthDefinition?: McpServerDefinitionData;
  oauthConfig?: McpServerConfigData;
}

export interface McpHttpProxyServiceForResolver {
  ensureStarted(port: number): Promise<void>;
  registerRoute(route: McpHttpProxyRouteInput): Promise<string>;
  unregisterRoute(routeId: string): void;
  getProxyUrl(routeId: string): string;
  getSessionMcpAuthTargets?(
    sessionId: string,
    servers: Record<string, unknown>,
  ): Record<string, { serverId: string; configId: string }>;
}

export interface McpStdioBrokerForResolver {
  registerStdioMcpRoute(
    request: CodexStdioMcpLaunchRequest,
    options?: CodexStdioMcpRegistrationOptions,
  ): Promise<CodexStdioMcpLaunchRoute>;
}

export interface ResolvePluginsOptions {
  purpose?:
    | 'discovery'
    | 'claude-session'
    | 'codex-session'
    | 'codex-discovery'
    /** Codex-facet MCP resolution for managed delegation; no live plugin publication. */
    | 'delegation-codex-mcp'
    /**
     * Local Cursor chat: resolves the same MCP servers a Claude session would
     * (plugin, standalone, and HTTP-proxied definitions) without materializing
     * Claude SDK skill plugins or projections, which Cursor cannot load.
     */
    | 'cursor-session'
    | 'copilot-session'
    | 'opencode-session';
  installExternalPlugins?: boolean;
  enableHttpMcpProxy?: boolean;
  mcpHttpProxyService?: McpHttpProxyServiceForResolver;
  mcpStdioBroker?: McpStdioBrokerForResolver;
  sessionId?: string;
  /** Actual cwd and settings sources for a fresh Claude launch decision. */
  cwd?: string;
  settingSources?: readonly SettingSource[];
  /**
   * A per-launch host policy snapshot. An explicitly present `undefined`
   * means the caller already checked the flag and it is off; omitting this
   * property asks the resolver to read a fresh context itself.
   */
  claudeModAdmissionContext?: ClaudeModAdmissionContext;
  proxyOperationTimeoutMs?: number;
  runtimeDirs?: {
    rootDir: string;
    claudePluginDir: string;
  };
  /** Reuses the preference snapshot read by the global-overlay preflight. */
  preferences?: PreferencesData;
  packageOverlay?: PipelinePackageCapabilityOverlay;
  /**
   * Per-target handlers a delegating parent pinned from its own defaults.
   * They set the handler like a default would, below an explicit preference
   * in `selections`, and never count as a user override.
   */
  mcpHttpAuthPins?: readonly McpHttpAuthPreference[];
  /**
   * The user's home-folder skills and commands a Cursor, Copilot or
   * OpenCode chat inherits
   * (docs/planning/2026-10-05-cursor-inherited-capabilities/design.md).
   * Read for those three session purposes only. Appended after the
   * selection, so an explicit pick keeps its id on a collision.
   */
  inheritedCursorCapabilities?: InheritedCursorCapabilities;
  /**
   * Claude Code plugins a Cursor chat inherits (`inheritedClaudePluginRefs`).
   * Appended after the selection and its Collections, in this order, so a
   * pick keeps its id on a collision and the inventory, which numbers ids the
   * same way, agrees. A ref the selection already holds adds nothing. Each
   * ref carries the folder Claude Code installed, and its skills, commands,
   * and MCP servers are read from that folder alone: never a marketplace
   * copy, a cache, or a fresh install.
   */
  inheritedPluginRefs?: readonly {
    marketplaceId: string;
    pluginName: string;
    installPath: string;
  }[];
}

const parentBrokeredStdioServers = new WeakSet<object>();
const DEFAULT_MCP_PROXY_OPERATION_TIMEOUT_MS = 3_000;

async function withResolverTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          reject(
            new Error(`${label} exceeded its ${String(timeoutMs)}ms deadline.`),
          );
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function proxyOperationTimeoutMs(
  options: ResolvePluginsOptions | undefined,
): number {
  return (
    options?.proxyOperationTimeoutMs ?? DEFAULT_MCP_PROXY_OPERATION_TIMEOUT_MS
  );
}

function claudeModPluginIdentity(
  pluginPath: string,
  index: number,
  resolvedPlugins: readonly PluginResolvedPath[],
  registeredPluginId: (catalogPluginId: string) => string,
): ClaudeModPluginInput {
  const installPath = path.resolve(pluginPath);
  const resolved = resolvedPlugins.find(
    (candidate) =>
      candidate.provider === 'claude' &&
      path.resolve(candidate.pluginPath) === installPath,
  );
  if (resolved) {
    return {
      // Consent keys a natively installed plugin by its registered name.
      pluginId: registeredPluginId(
        `${resolved.pluginName}@${resolved.marketplaceId}`,
      ),
      installPath,
    };
  }

  const inspection = inspectClaudePluginHooks(installPath);
  const manifestName =
    inspection.success && typeof inspection.manifest?.name === 'string'
      ? inspection.manifest.name
      : undefined;
  const safeName =
    manifestName && /^[^@\s/\\]+$/.test(manifestName)
      ? manifestName
      : `local-${index + 1}`;
  return { pluginId: `${safeName}@inline`, installPath };
}

function addSkippedClaudeMod(
  entries: SkippedClaudeMod[],
  entry: SkippedClaudeMod,
): void {
  if (!isSkippedClaudeMod(entry)) return;
  if (
    entries.some(
      (existing) =>
        existing.pluginId === entry.pluginId &&
        existing.source === entry.source &&
        existing.reason === entry.reason,
    )
  ) {
    return;
  }
  entries.push(entry);
}

function claudeModPluginKey(plugin: ClaudeModPluginInput): string {
  return `${plugin.pluginId}\0${plugin.installPath ?? ''}`;
}

interface McpProxyRouteScope {
  sessionId: string | null;
  routeKey?: string;
}

/** Non-secret identity captured from the exact installed declarations used by this turn. */
export interface InheritedPluginBinding {
  readonly installationDigest: string;
  readonly marketplaceId: string;
  readonly pluginName: string;
  readonly mcpServers: readonly { serverName: string; configDigest: string }[];
  readonly mcpHttpAuthPreferences: readonly AgentMcpHttpAuthPin[];
}

export interface ResolvedPlugins {
  claudeModAdmission?: {
    settings?: {
      enabledPlugins?: Record<string, false>;
    };
    skippedMods: readonly SkippedClaudeMod[];
  };
  inheritedPluginBindings?: readonly InheritedPluginBinding[];
  sdkPlugins: SdkPluginConfig[];
  /**
   * Claude purposes: `sdkPlugins` with each plugin's id, so a later launch
   * decision (discovery, helpers) checks consent for the plugin the person
   * allowed. A bare path reads as an `@inline` plugin nobody allowed.
   */
  identifiedSdkPlugins?: (SdkPluginConfig & {
    pluginId: string;
    /** The installed copy a projected `path` was made from. */
    sourcePath?: string;
  })[];
  skillPluginDir: string | null;
  selectedCapabilityRoots: CodexSelectedCapabilityRoot[];
  /**
   * Plugin-declared MCP servers translated to Codex's thread config shape.
   * Standalone MCP selections continue to load through the aggregate plugin.
   */
  codexMcpServers: CodexConfig;
  mcpServers: Record<string, unknown>;
  /** Provenance for every `mcpServers` entry bound to a connection, by name. */
  mcpServerBindings: Record<string, ResolvedMcpServerBinding>;
  /** Selected resource identities for every runtime server, including stdio. */
  mcpCapabilityIdentities?: Record<string, McpCapabilityIdentity[]>;
  /** Credential route selectors, captured from this resolver's own proxy routes. */
  mcpAuthTargets?: Record<string, { serverId: string; configId: string }>;
  /**
   * Problems every provider shares (a selection that no longer exists, a
   * server that could not be proxied). Callers log these; Claude and Codex
   * never show them in a transcript.
   */
  warnings: string[];
  /**
   * Limits specific to a Cursor session: a selection the other providers load
   * but Cursor cannot. The Cursor session shows these once per session so the
   * difference is visible without repeating on every turn.
   */
  cursorNotices: string[];
  /**
   * Skills and commands to materialize into the chat's private Cursor root.
   * Populated for `cursor-session` only; empty for every other purpose.
   */
  cursorCapabilities: CursorCapabilityProjection;
  timings?: {
    selectionMs: number;
    mcpMs: number;
    materializationMs: number;
    publishMs: number;
    totalMs: number;
  };
}

async function brokerCodexStdioMcpServers(
  servers: Record<string, unknown>,
  options: ResolvePluginsOptions | undefined,
  warnings: string[],
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [serverName, rawServer] of Object.entries(servers)) {
    if (
      !isRecord(rawServer) ||
      rawServer.type !== 'stdio' ||
      typeof rawServer.command !== 'string' ||
      rawServer.enabled === false
    ) {
      result[serverName] = rawServer;
      continue;
    }
    if (!options?.mcpStdioBroker || !options.sessionId) {
      warnings.push(
        `MCP server "${serverName}" requires the parent stdio launcher and was skipped.`,
      );
      continue;
    }
    let route: CodexStdioMcpLaunchRoute;
    const registrationController = new AbortController();
    try {
      route = await withResolverTimeout(
        options.mcpStdioBroker.registerStdioMcpRoute(
          {
            ownerId: options.sessionId,
            routeKey: serverName,
            command: rawServer.command,
            ...(readStringArray(rawServer.args)
              ? { args: readStringArray(rawServer.args) }
              : {}),
            ...(typeof rawServer.cwd === 'string'
              ? { cwd: rawServer.cwd }
              : {}),
            ...(isStringRecord(rawServer.env) ? { env: rawServer.env } : {}),
          },
          {
            signal: registrationController.signal,
          },
        ),
        proxyOperationTimeoutMs(options),
        `Registering stdio MCP broker route for "${serverName}"`,
        () => registrationController.abort(),
      );
    } catch (error) {
      warnings.push(
        `MCP server "${serverName}" could not be registered with the parent stdio broker: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    const {
      command: _command,
      args: _args,
      cwd: _cwd,
      env: _env,
      ...brokerSafeServer
    } = rawServer;
    void _command;
    void _args;
    void _cwd;
    void _env;
    const brokeredServer = {
      ...brokerSafeServer,
      command: route.command,
      args: route.args,
      ...(route.cwd ? { cwd: route.cwd } : {}),
    };
    parentBrokeredStdioServers.add(brokeredServer);
    result[serverName] = brokeredServer;
  }
  return result;
}

function isCodexPluginResolutionPurpose(
  purpose: ResolvePluginsOptions['purpose'],
): boolean {
  return (
    purpose === 'codex-session' ||
    purpose === 'codex-discovery' ||
    purpose === 'delegation-codex-mcp'
  );
}

function sortStringRecord(
  record: Record<string, string>,
): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) {
      sorted[key] = value;
    }
  }
  return sorted;
}

function buildCodexPluginMcpServers(
  mcpServers: Record<string, unknown>,
  warnings: string[],
): CodexConfig {
  const result: CodexConfig = {};

  for (const [serverName, rawServer] of Object.entries(mcpServers)) {
    if (!isRecord(rawServer)) {
      continue;
    }

    if (rawServer.type === 'stdio' && typeof rawServer.command === 'string') {
      const args = readStringArray(rawServer.args);
      const enabled = rawServer.enabled !== false;
      const launcherMarkerIndex =
        args?.lastIndexOf(CODEX_MCP_STDIO_LAUNCHER_COMMAND) ?? -1;
      const isParentBrokerLauncher =
        parentBrokeredStdioServers.has(rawServer) &&
        launcherMarkerIndex >= 0 &&
        args !== undefined &&
        /^[a-f0-9]{64}$/.test(args[launcherMarkerIndex + 1] ?? '') &&
        isCodexMcpRouteId(args[launcherMarkerIndex + 2] ?? '');
      if (
        enabled &&
        isStringRecord(rawServer.env) &&
        Object.keys(rawServer.env).length > 0 &&
        !isParentBrokerLauncher
      ) {
        warnings.push(
          `Plugin MCP server "${serverName}" bypassed the parent stdio broker and was skipped.`,
        );
        continue;
      }
      result[serverName] = {
        command: rawServer.command,
        ...(args ? { args } : {}),
        ...(typeof rawServer.cwd === 'string' ? { cwd: rawServer.cwd } : {}),
        ...(typeof rawServer.enabled === 'boolean'
          ? { enabled: rawServer.enabled }
          : {}),
        ...(enabled ? { required: false } : {}),
        ...buildCodexMcpToolPolicy(rawServer),
      };
      continue;
    }

    if (rawServer.type !== 'http' || typeof rawServer.url !== 'string') {
      continue;
    }

    const headers = isStringRecord(rawServer.headers) ? rawServer.headers : {};
    if (Object.keys(headers).length > 0) {
      warnings.push(
        `Plugin MCP server "${serverName}" requires HTTP headers but could not use the local credential proxy and was skipped.`,
      );
      continue;
    }

    const enabled = rawServer.enabled !== false;
    result[serverName] = {
      url: rawServer.url,
      ...(typeof rawServer.enabled === 'boolean'
        ? { enabled: rawServer.enabled }
        : {}),
      ...(enabled ? { required: false } : {}),
      ...buildCodexMcpToolPolicy(rawServer),
    };
  }

  return result;
}

function buildCodexMcpToolPolicy(
  rawServer: Record<string, unknown>,
): CodexConfig {
  const enabledTools = readStringArray(rawServer.enabled_tools);
  const disabledTools = readStringArray(rawServer.disabled_tools);

  return {
    ...(enabledTools ? { enabled_tools: enabledTools } : {}),
    ...(disabledTools ? { disabled_tools: disabledTools } : {}),
    ...(typeof rawServer.default_tools_approval_mode === 'string'
      ? {
          default_tools_approval_mode: rawServer.default_tools_approval_mode,
        }
      : {}),
    ...(isCodexConfig(rawServer.tools) ? { tools: rawServer.tools } : {}),
  };
}

function buildCodexMcpProxyRouteKey(options: {
  purpose: ResolvePluginsOptions['purpose'];
  kind: 'standalone' | 'plugin';
  serverId: string;
  configId: string;
  upstreamUrl: string;
  headers: Record<string, string>;
  oauthEnabled: boolean;
  oauthRequired: boolean;
}): string | null {
  if (!isCodexPluginResolutionPurpose(options.purpose)) {
    return null;
  }

  const payload = {
    kind: options.kind,
    serverId: options.serverId,
    configId: options.configId,
    upstreamUrl: options.upstreamUrl,
    headers: sortStringRecord(options.headers),
    oauthEnabled: options.oauthEnabled,
    oauthRequired: options.oauthRequired,
  };
  return `codex-${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 32)}`;
}

function buildMcpProxyRouteScope(
  options: ResolvePluginsOptions | undefined,
  routeKey: string | null,
): McpProxyRouteScope {
  if (routeKey) {
    return {
      sessionId: options?.sessionId ?? null,
      routeKey,
    };
  }

  return {
    sessionId: options?.sessionId ?? null,
  };
}

interface HttpMcpResolutionContext {
  capabilityIdentities: Record<string, McpCapabilityIdentity[]>;
  selections: ChatTabPluginSelections;
  defaultHandler: McpHttpAuthHandler;
  proxyAvailable: boolean;
  proxyFallbackWarningEmitted: boolean;
  /**
   * Servers already bound to a connection, keyed by {@link accountBindingKey}
   * or {@link deviceBindingKey}. Shared by the standalone pass and the plugin
   * pass so a connection resolves once however many selections name it.
   */
  boundServers: Map<string, BoundMcpServer>;
  /** The account connection list, read at most once per resolution. */
  accountConnections?: Promise<AccountMcpConnection[] | null>;
  /** The cached catalog's desktop-only keys, read at most once per resolution. */
  desktopOnlyCuratedKeys?: Promise<ReadonlySet<string>>;
  /** Delegated default pins by {@link mcpHttpAuthTargetKey}; see `mcpHttpAuthPins`. */
  pinnedHandlers?: ReadonlyMap<string, McpHttpAuthHandler>;
}

interface McpProxyStartState {
  port: number | null;
}

function accountBindingKey(accountConnectionId: string): string {
  return `account:${accountConnectionId}`;
}

function deviceBindingKey(serverId: string, configId: string): string {
  return `device:${serverId}/${configId}`;
}

function recordBoundServer(
  context: HttpMcpResolutionContext,
  keys: readonly string[],
  entry: BoundMcpServer,
): BoundMcpServer {
  for (const key of keys) context.boundServers.set(key, entry);
  return entry;
}

/** Reuse a bound server for another selection; the caller decides whether to warn. */
function adoptBoundServer(
  entry: BoundMcpServer,
  source: ResolvedMcpServerSource,
): BoundMcpServer {
  entry.binding.sources.push(source);
  return entry;
}

function loadSharedAccountMcpConnections(
  context: HttpMcpResolutionContext,
): Promise<AccountMcpConnection[] | null> {
  context.accountConnections ??= loadAccountMcpRefConnections();
  return context.accountConnections;
}

function loadSharedDesktopOnlyCuratedKeys(
  context: HttpMcpResolutionContext,
): Promise<ReadonlySet<string>> {
  context.desktopOnlyCuratedKeys ??= readCachedCuratedMcpDesktopOnlyKeys();
  return context.desktopOnlyCuratedKeys;
}

function mcpServerBindingsByName(
  context: HttpMcpResolutionContext,
): Record<string, ResolvedMcpServerBinding> {
  const bindings: Record<string, ResolvedMcpServerBinding> = {};
  for (const entry of Array.from(context.boundServers.values())) {
    bindings[entry.serverName] = entry.binding;
  }
  return bindings;
}

function mcpCapabilityIdentitiesByName(
  context: HttpMcpResolutionContext,
  servers: Record<string, unknown>,
): Record<string, McpCapabilityIdentity[]> {
  const identities = { ...context.capabilityIdentities };
  for (const entry of Array.from(context.boundServers.values())) {
    const targets: McpCapabilityIdentity[] = [...entry.binding.sources];
    if (entry.binding.binding.kind === 'account') {
      targets.push({
        kind: 'account',
        connectionId: entry.binding.binding.accountConnectionId,
        configId: entry.binding.binding.configId,
      });
    }
    identities[entry.serverName] = Array.from(
      new Map(
        targets.map((target) => [mcpCapabilityIdentityKey(target), target]),
      ).values(),
    );
  }
  return Object.fromEntries(
    Object.entries(identities).filter(([name]) =>
      Object.prototype.hasOwnProperty.call(servers, name),
    ),
  );
}

interface PluginMcpResolutionResult {
  retained?: InheritedPluginBinding;
  servers: Record<string, unknown>;
  hasMcpServers: boolean;
}

export interface EffectivePluginSelectionRefs {
  disabledRefs: InstalledItemRef[];
  skillRefs: Array<{ sourceId: string; skillName: string }>;
  pluginRefs: Array<{ marketplaceId: string; pluginName: string }>;
  mcpServerRefs: Array<{ serverId: string; configId: string }>;
  warnings: string[];
}

export function resolveSelectedSkillDirectory(
  ref: { sourceId: string; skillName: string },
  warnings: string[],
): string | null {
  const isBuiltin = isBuiltinSourceId(ref.sourceId);
  const skillsRoot = path.resolve(
    isBuiltin ? getBundledSkillsDir() : getSkillsRootDir(),
  );
  const skillDir = path.resolve(
    isBuiltin
      ? getBundledSkillDir(ref.skillName)
      : getSkillDir(ref.sourceId, ref.skillName),
  );
  if (skillDir === skillsRoot || !isPathInside(skillsRoot, skillDir)) {
    warnings.push(
      `Skill "${ref.skillName}" (source: ${ref.sourceId}) resolved outside the skills root, skipping.`,
    );
    return null;
  }
  return skillDir;
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * The canonical directory of a selected standalone skill as a Cursor session
 * copies it: inside the skills root with every symbolic link resolved, and
 * holding a `SKILL.md`. Null (with a warning, when `warnings` is given and the
 * directory exists but escapes) otherwise. The inventory filters with this
 * too, so both sides assign ids over the same skills.
 */
export function cursorSkillSourceDir(
  ref: { sourceId: string; skillName: string },
  warnings?: string[],
): string | null {
  const isBuiltin = isBuiltinSourceId(ref.sourceId);
  const skillsRoot = isBuiltin ? getBundledSkillsDir() : getSkillsRootDir();
  const skillDir = isBuiltin
    ? getBundledSkillDir(ref.skillName)
    : getSkillDir(ref.sourceId, ref.skillName);
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) return null;
  // One realpath for the root and one for the skill: this runs on the main
  // process, per selected skill, at selection time and on every turn.
  const canonical = canonicalPathInside(skillsRoot, skillDir);
  if (!canonical || canonical === realpathOrNull(skillsRoot)) {
    warnings?.push(
      `Skill "${ref.skillName}" (source: ${ref.sourceId}) resolves outside the skills root, skipping.`,
    );
    return null;
  }
  return canonical;
}

type InheritedPluginRefOption = NonNullable<
  ResolvePluginsOptions['inheritedPluginRefs']
>[number];

/**
 * Inherited plugins follow the selection and its Collections, so a pick keeps
 * its id on a collision and the inventory, which orders the same way, agrees.
 * A plugin the selection already names is the user's pick and resolves as
 * one; its inherited copy adds nothing.
 */
function inheritedPluginsToResolve(
  effective: EffectivePluginSelectionRefs,
  inherited: readonly InheritedPluginRefOption[] | undefined,
): InheritedPluginRefOption[] {
  if (!inherited || inherited.length === 0) return [];
  const seen = new Set(
    effective.pluginRefs.map((ref) => `${ref.marketplaceId}/${ref.pluginName}`),
  );
  const refs: InheritedPluginRefOption[] = [];
  for (const ref of inherited) {
    const key = `${ref.marketplaceId}/${ref.pluginName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * An inherited Claude Code plugin resolves from the folder Claude Code
 * installed and nowhere else: not the marketplace checkout, not Canopy's
 * cache, and never a fresh install. The session then loads exactly the
 * skills, commands, and MCP servers the user installed there, and an
 * inherited plugin, which no one picked, can never start a server version
 * the user never installed. A folder that is gone is skipped and reported,
 * not replaced.
 */
function resolveInheritedPlugin(
  ref: InheritedPluginRefOption,
  warnings: string[],
  cursorNotices: string[],
): PluginResolvedPath | null {
  if (!isPluginInstallRoot(ref.installPath)) {
    const notice = `Claude Code plugin "${ref.pluginName}" in marketplace "${ref.marketplaceId}" has no installed folder at ${ref.installPath}, so it was not inherited.`;
    warnings.push(notice);
    cursorNotices.push(notice);
    return null;
  }
  return {
    pluginPath: path.resolve(ref.installPath),
    pluginName: ref.pluginName,
    marketplaceId: ref.marketplaceId,
    category: '',
    provider: 'claude',
    mode: 'native',
  };
}

export async function resolveEffectivePluginSelectionRefs(
  rawSelections: ChatTabPluginSelections,
  warnings: string[] = [],
  projectId?: string,
  preferences?: PreferencesData,
): Promise<EffectivePluginSelectionRefs> {
  const selections = normalizePluginSelections(rawSelections);
  const policy = await readInstalledItemPolicy(preferences);
  const disabledRefs = new Map<string, InstalledItemRef>();
  const disabled = (ref: InstalledItemRef): boolean => {
    if (!policy.isDisabled(ref)) return false;
    const canonical = policy.canonical(ref);
    disabledRefs.set(installedItemKey(canonical), canonical);
    return true;
  };
  const skillRefs = new Map<string, { sourceId: string; skillName: string }>();
  const pluginRefs = new Map<
    string,
    { marketplaceId: string; pluginName: string }
  >();
  const mcpRefs = new Map<string, { serverId: string; configId: string }>();

  for (const ref of selections.skillRefs) {
    skillRefs.set(installedItemKey({ kind: 'skill', ...ref }), ref);
  }
  for (const ref of selections.pluginRefs) {
    pluginRefs.set(installedItemKey({ kind: 'plugin', ...ref }), ref);
  }
  for (const ref of selections.mcpServerRefs ?? []) {
    mcpRefs.set(installedItemKey({ kind: 'mcp-config', ...ref }), ref);
  }

  const safeCollectionId = /^[a-f0-9-]+$/;
  for (const collectionId of selections.collectionIds) {
    if (disabled({ kind: 'collection', collectionId })) continue;
    if (!safeCollectionId.test(collectionId)) {
      warnings.push(`Invalid Collection id "${collectionId}", skipping.`);
      continue;
    }

    const collectionFile = await readCollectionConfig(collectionId);
    if (!collectionFile?.collection) {
      warnings.push(`Collection "${collectionId}" not found, skipping.`);
      continue;
    }

    for (const ref of collectionFile.collection.skills) {
      const key = installedItemKey({ kind: 'skill', ...ref });
      if (!skillRefs.has(key)) {
        skillRefs.set(key, ref);
      }
    }
    for (const ref of collectionFile.collection.plugins) {
      const key = installedItemKey({ kind: 'plugin', ...ref });
      if (!pluginRefs.has(key)) {
        pluginRefs.set(key, ref);
      }
    }
    for (const ref of collectionFile.collection.mcpServers ?? []) {
      const key = installedItemKey({ kind: 'mcp-config', ...ref });
      if (!mcpRefs.has(key)) {
        mcpRefs.set(key, ref);
      }
    }
  }

  for (const [key, ref] of Array.from(skillRefs)) {
    if (disabled({ kind: 'skill', ...ref })) skillRefs.delete(key);
  }
  for (const [key, ref] of Array.from(pluginRefs)) {
    if (disabled({ kind: 'plugin', ...ref })) pluginRefs.delete(key);
  }
  let accountConnections: AccountMcpConnection[] | null | undefined;
  for (const [key, ref] of Array.from(mcpRefs)) {
    const accountOnly =
      legacyAccountMcpConnectionId(ref.serverId) !== undefined ||
      isCustomAccountMcpServerKey(ref.serverId);
    let enabled: boolean | undefined;
    if (!accountOnly) {
      try {
        const file = normalizeMcpServerFile(
          await safeReadJsonAsync<unknown>(getMcpServerFilePath(ref.serverId)),
          ref.serverId,
        );
        enabled = file.server.configs.find(
          (config) => config.id === ref.configId,
        )?.enabled;
      } catch {
        // Missing/invalid resources retain the existing missing-selection path.
      }
    }
    if (enabled === undefined && accountMcpConnectionsEnabled()) {
      accountConnections ??= await loadAccountMcpRefConnections();
      enabled = accountMcpConnectionForRef(
        ref,
        accountConnections ?? [],
      )?.enabled;
    }
    if (enabled === false) {
      mcpRefs.delete(key);
      const target = { kind: 'mcp-config', ...ref } as const;
      disabledRefs.set(installedItemKey(target), target);
    }
  }
  for (const ref of Array.from(skillRefs.values())) {
    await assertStoredSkillContext(
      `${ref.sourceId}/${ref.skillName}`,
      projectId,
    );
  }
  return {
    skillRefs: Array.from(skillRefs.values()),
    pluginRefs: Array.from(pluginRefs.values()),
    mcpServerRefs: Array.from(mcpRefs.values()),
    disabledRefs: Array.from(disabledRefs.values()),
    warnings,
  };
}

export function codexAggregateSkillInvocationNamesForRefs(
  skillRefs: readonly { sourceId: string; skillName: string }[],
  warnings: string[] = [],
): Map<string, string> {
  const explicitSkills: Array<{ key: string; name: string }> = [];
  const usedSkillNames = new Map<string, number>();

  for (const ref of skillRefs) {
    const sourceSkillDir = resolveSelectedSkillDirectory(ref, warnings);
    if (!sourceSkillDir) continue;
    const skillMdPath = path.join(sourceSkillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      warnings.push(
        `Skill "${ref.skillName}" (source: ${ref.sourceId}) not found, skipping.`,
      );
      continue;
    }

    explicitSkills.push({
      key: `${ref.sourceId}/${ref.skillName}`,
      name: deduplicateName(ref.skillName, usedSkillNames),
    });
  }

  const usedGeneratedNames = new Set<string>();
  const result = new Map<string, string>();
  for (const skill of explicitSkills) {
    result.set(
      skill.key,
      createGeneratedSkillName(skill.name, usedGeneratedNames),
    );
  }
  return result;
}

export async function resolvePlugins(
  rawSelections: ChatTabPluginSelections,
  projectId: string,
  worktreeId: string,
  chatId: string,
  options?: ResolvePluginsOptions,
): Promise<ResolvedPlugins> {
  const resolutionStartedAt = Date.now();
  let stageStartedAt = resolutionStartedAt;
  let selectionMs = 0;
  let mcpMs = 0;
  let materializationMs = 0;
  let publishMs = 0;
  const purpose = options?.purpose ?? 'claude-session';
  const codexPurpose = isCodexPluginResolutionPurpose(purpose);
  const hasPrecomputedClaudeModContext =
    options !== undefined &&
    Object.prototype.hasOwnProperty.call(options, 'claudeModAdmissionContext');
  let claudeModAdmissionContext: ClaudeModAdmissionContext | undefined;
  if (hasPrecomputedClaudeModContext) {
    claudeModAdmissionContext = options?.claudeModAdmissionContext;
  } else if (purpose === 'claude-session') {
    claudeModAdmissionContext = await resolveClaudeModAdmissionContext({
      cwd: options?.cwd ?? process.cwd(),
      settingSources: options?.settingSources,
    });
  }
  let claudeModAdmission: ResolvedPlugins['claudeModAdmission'];
  let claudeModAdmissionDecision: ClaudeModAdmissionDecision | undefined;
  let selectedClaudeModInputs: ClaudeModPluginInput[] = [];
  const warnings: string[] = [];
  const cursorNotices: string[] = [];
  const sdkPlugins: SdkPluginConfig[] = [];
  let skillPluginDir: string | null = null;
  let selectedCapabilityRoots: CodexSelectedCapabilityRoot[] = [];
  // The global default-plugin overlay is applied by the caller via
  // `resolveEffectiveChatPluginSelections` (global-plugin-overlay.ts) before
  // this function runs; `rawSelections` are already effective selections.
  const preferences = options?.preferences ?? (await readPreferencesFile());
  const selections = normalizePluginSelections(rawSelections);
  const codexCompatDisabledKeys = new Set<string>(
    preferences.codexCompatDisabledPlugins ?? [],
  );
  const proxyAvailable =
    options?.enableHttpMcpProxy === true && !!options.mcpHttpProxyService;
  const httpMcpContext: HttpMcpResolutionContext = {
    capabilityIdentities: {},
    selections,
    defaultHandler:
      preferences.mcpHttpAuthDefaultHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
    proxyAvailable,
    proxyFallbackWarningEmitted: false,
    boundServers: new Map(),
    ...(options?.mcpHttpAuthPins?.length
      ? {
          pinnedHandlers: new Map(
            options.mcpHttpAuthPins.map((pin) => [
              mcpHttpAuthTargetKey(pin.target),
              pin.handler,
            ]),
          ),
        }
      : {}),
  };
  let skillTargetProjectId = projectId;
  if (
    skillResourceContextEnabled() &&
    projectId === STANDALONE_CHAT_PROJECT_ID
  ) {
    const { resolveCoworkWorkspaceId } =
      await import('../lib/cowork-migration-map');
    skillTargetProjectId = resolveCoworkWorkspaceId(worktreeId);
  }
  const effectiveRefs = await resolveEffectivePluginSelectionRefs(
    selections,
    warnings,
    skillTargetProjectId,
    preferences,
  );
  const policy = await readInstalledItemPolicy(preferences);
  const disabledRefs = new Map(
    (effectiveRefs.disabledRefs ?? []).map((ref) => [
      installedItemKey(ref),
      ref,
    ]),
  );
  const packageResources = (options?.packageOverlay?.resources ?? []).filter(
    (resource) => {
      const kind = resource.kind === 'standalone_skill' ? 'skill' : 'plugin';
      if (!resource.installedItemRef && policy.hasDisabledKind(kind)) {
        const warning = `Pinned ${kind} resources without an original installed identity cannot be checked against Disabled items. Re-export the package before executing it.`;
        if (!warnings.includes(warning)) warnings.push(warning);
        return false;
      }
      const ref =
        resource.installedItemRef ??
        (resource.kind === 'standalone_skill'
          ? ({
              kind: 'skill',
              sourceId: resource.virtualSourceId,
              skillName: path.basename(resource.rootPath),
            } as const)
          : ({
              kind: 'plugin',
              marketplaceId: `pipeline-package:${options?.packageOverlay?.packageDigest ?? ''}`,
              pluginName: resource.resourceId,
            } as const));
      if (!policy.isDisabled(ref)) return true;
      const canonical = policy.canonical(ref);
      disabledRefs.set(installedItemKey(canonical), canonical);
      return false;
    },
  );
  const inheritedRefs = inheritedPluginsToResolve(
    effectiveRefs,
    options?.inheritedPluginRefs?.filter((ref) => {
      const item: InstalledItemRef = {
        kind: 'plugin',
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
      };
      if (!policy.isDisabled(item)) return true;
      const canonical = policy.canonical(item);
      disabledRefs.set(installedItemKey(canonical), canonical);
      return false;
    }),
  );
  for (const ref of Array.from(disabledRefs.values()))
    warnings.push(
      `Installed item ${installedItemKey(ref)} is Disabled and was not loaded.`,
    );

  const resolvedPlugins: PluginResolvedPath[] = packageResources.flatMap(
    (resource) => {
      if (
        resource.kind === 'standalone_skill' ||
        resource.provider !== (codexPurpose ? 'codex' : 'claude')
      ) {
        return [];
      }
      if (!codexPurpose) {
        sdkPlugins.push({ type: 'local', path: resource.rootPath });
      }
      return [
        {
          pluginPath: resource.rootPath,
          pluginName: resource.resourceId,
          marketplaceId: `pipeline-package:${options?.packageOverlay?.packageDigest ?? ''}`,
          category: 'pipeline-package',
          provider: resource.provider,
          mode: 'native',
        },
      ];
    },
  );
  let marketplaces: MarketplaceInfo[] = [];
  // Each projected plugin copy, by the install it was made from.
  const projectionSources = new Map<string, string>();
  // Claude's config folder, resolved once, on the first plugin id named.
  let registeredLookupDir: string | undefined;
  const registeredPluginId = (catalogPluginId: string): string => {
    registeredLookupDir ??=
      claudeModAdmissionContext?.claudeConfigDir ??
      resolveClaudeModConfigDirectory({
        environment: { runtime: 'agent', workspaceId: projectId },
        cwd: options?.cwd ?? process.cwd(),
      });
    return registeredClaudePluginId(
      catalogPluginId,
      marketplaces,
      registeredLookupDir,
    );
  };
  if (effectiveRefs.pluginRefs.length > 0) {
    const cacheResult = await loadMarketplaces();
    marketplaces =
      cacheResult.success && cacheResult.data
        ? cacheResult.data.marketplaces
        : [];

    for (const ref of effectiveRefs.pluginRefs) {
      const resolvedPlugin = await resolvePluginSelection(
        ref.marketplaceId,
        ref.pluginName,
        marketplaces,
        warnings,
        options?.installExternalPlugins === true,
        purpose,
        codexCompatDisabledKeys,
      );
      if (!resolvedPlugin) {
        continue;
      }

      resolvedPlugins.push(resolvedPlugin);
      if (
        !isCodexPluginResolutionPurpose(purpose) &&
        resolvedPlugin.provider === 'claude'
      ) {
        sdkPlugins.push({ type: 'local', path: resolvedPlugin.pluginPath });
      }
    }
  }
  // After the selection and its Collections, the inventory's order. These
  // need no marketplace lookup: the folder to read is known.
  for (const ref of inheritedRefs) {
    const resolvedPlugin = resolveInheritedPlugin(ref, warnings, cursorNotices);
    if (!resolvedPlugin) continue;
    resolvedPlugins.push(resolvedPlugin);
    if (!isCodexPluginResolutionPurpose(purpose)) {
      sdkPlugins.push({ type: 'local', path: resolvedPlugin.pluginPath });
    }
  }

  const explicitSkills: PluginResolvedSkill[] = packageResources.flatMap(
    (resource) => {
      const skillMdPath = path.join(resource.rootPath, 'SKILL.md');
      return resource.kind === 'standalone_skill' &&
        resource.provider === (codexPurpose ? 'codex' : 'claude') &&
        fs.existsSync(skillMdPath)
        ? [
            {
              name: path.basename(resource.rootPath),
              description: readSkillDescription(skillMdPath),
              sourceDir: resource.rootPath,
              skillMdPath,
            },
          ]
        : [];
    },
  );
  const usedSkillNames = new Map<string, number>();
  // Standalone skills the capability projection loads from its private root, in
  // selection order; ids are assigned with the plugin members below.
  const cursorStandaloneSkills: {
    ref: { sourceId: string; skillName: string };
    sourceDir: string;
    description: string;
    userInvocable: boolean;
  }[] = (
    purpose === 'cursor-session' ||
    purpose === 'copilot-session' ||
    purpose === 'opencode-session'
      ? packageResources
      : []
  ).flatMap((resource) => {
    const skillMdPath = path.join(resource.rootPath, 'SKILL.md');
    return resource.kind === 'standalone_skill' &&
      resource.provider === 'claude' &&
      fs.existsSync(skillMdPath)
      ? [
          {
            ref: {
              sourceId: resource.virtualSourceId,
              skillName: path.basename(resource.rootPath),
            },
            // Private package roots may inherit a host alias such as /var.
            // The capability loader requires canonical roots, like local skills.
            sourceDir: fs.realpathSync(resource.rootPath),
            ...readSkillMetadata(skillMdPath),
          },
        ]
      : [];
  });
  for (const ref of effectiveRefs.skillRefs) {
    const sourceSkillDir = resolveSelectedSkillDirectory(ref, warnings);
    if (!sourceSkillDir) continue;
    const skillMdPath = path.join(sourceSkillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      warnings.push(
        `Skill "${ref.skillName}" (source: ${ref.sourceId}) not found, skipping.`,
      );
      continue;
    }

    if (
      purpose === 'cursor-session' ||
      purpose === 'copilot-session' ||
      purpose === 'opencode-session'
    ) {
      // Copied into the chat's root, so the directory must really be inside
      // the skills root once links are resolved, not only by its spelling.
      // Claude and Codex sessions still accept the skill, so this is a
      // Cursor-only gap the user is told about, not only a logged warning.
      const cursorWarnings: string[] = [];
      const canonicalDir = cursorSkillSourceDir(ref, cursorWarnings);
      warnings.push(...cursorWarnings);
      cursorNotices.push(...cursorWarnings);
      if (!canonicalDir) continue;
      cursorStandaloneSkills.push({
        ref,
        sourceDir: canonicalDir,
        ...readSkillMetadata(skillMdPath),
      });
      continue;
    }

    explicitSkills.push({
      name: deduplicateName(ref.skillName, usedSkillNames),
      description: readSkillDescription(skillMdPath),
      sourceDir: sourceSkillDir,
      skillMdPath,
    });
  }

  if (
    (purpose === 'claude-session' || purpose === 'discovery') &&
    explicitSkills.length > 0
  ) {
    const pluginDir = buildClaudeSkillPluginDir(
      projectId,
      worktreeId,
      chatId,
      explicitSkills,
      warnings,
      options?.runtimeDirs,
    );
    if (pluginDir) {
      skillPluginDir = pluginDir;
      sdkPlugins.push({ type: 'local', path: pluginDir });
    }
  }

  if (purpose === 'claude-session' && claudeModAdmissionContext?.enabled) {
    selectedClaudeModInputs = sdkPlugins.map((plugin, index) =>
      claudeModPluginIdentity(
        plugin.path,
        index,
        resolvedPlugins,
        registeredPluginId,
      ),
    );
    const decision = evaluateClaudeModAdmission({
      ...claudeModAdmissionContext,
      selectedPlugins: selectedClaudeModInputs,
    });
    claudeModAdmissionDecision = decision;
    claudeModAdmission = {
      ...(decision.settings ? { settings: decision.settings } : {}),
      skippedMods: decision.skippedMods,
    };
  }

  selectionMs = Date.now() - stageStartedAt;
  stageStartedAt = Date.now();
  const rawStandaloneMcpServers = await resolveStandaloneMcpServers(
    new Map(
      effectiveRefs.mcpServerRefs.map((ref) => [
        `${ref.serverId}/${ref.configId}`,
        ref,
      ]),
    ),
    warnings,
    options,
    httpMcpContext,
    preferences.mcpProxyPort,
  );
  const standaloneMcpServers = codexPurpose
    ? await brokerCodexStdioMcpServers(
        rawStandaloneMcpServers,
        options,
        warnings,
      )
    : rawStandaloneMcpServers;
  const mcpServers: Record<string, unknown> = {
    ...standaloneMcpServers,
  };
  const inheritedPluginBindings: InheritedPluginBinding[] = [];
  const resolvedPluginMcpServers: Record<string, unknown> = {};
  const pluginsWithMcpServers = new Set<string>();
  const codexPluginsWithMcpServers = new Set<string>();
  const cursorPluginsWithMcpServers = new Set<string>();

  for (const plugin of resolvedPlugins) {
    const pluginMcpResolution = await resolvePluginMcpServers(
      plugin,
      warnings,
      options,
      httpMcpContext,
      preferences.mcpProxyPort,
      inheritedRefs.some(
        (ref) =>
          ref.marketplaceId === plugin.marketplaceId &&
          ref.pluginName === plugin.pluginName,
      ),
    );
    if (
      purpose === 'claude-session' &&
      plugin.provider === 'codex' &&
      !pluginMcpResolution.hasMcpServers
    ) {
      warnings.push(
        `Codex-native plugin "${plugin.pluginName}" in marketplace "${plugin.marketplaceId}" does not declare MCP servers and cannot be used in a Claude session.`,
      );
    }
    if (pluginMcpResolution.hasMcpServers) {
      cursorPluginsWithMcpServers.add(plugin.pluginPath);
    }
    if (plugin.provider === 'claude' && pluginMcpResolution.hasMcpServers) {
      pluginsWithMcpServers.add(plugin.pluginPath);
    }
    if (codexPurpose && pluginMcpResolution.hasMcpServers) {
      codexPluginsWithMcpServers.add(plugin.pluginPath);
    }
    if (pluginMcpResolution.retained)
      inheritedPluginBindings.push(pluginMcpResolution.retained);
    const pluginServers = codexPurpose
      ? await brokerCodexStdioMcpServers(
          pluginMcpResolution.servers,
          options,
          warnings,
        )
      : pluginMcpResolution.servers;
    for (const [serverName, server] of Object.entries(pluginServers)) {
      mcpServers[serverName] = server;
      resolvedPluginMcpServers[serverName] = server;
    }
  }
  let codexMcpServers: CodexConfig = {};
  const cursorCapabilities =
    purpose === 'cursor-session' ||
    purpose === 'copilot-session' ||
    purpose === 'opencode-session'
      ? buildCursorCapabilityProjection(
          cursorStandaloneSkills,
          resolvedPlugins,
          cursorPluginsWithMcpServers,
          cursorNotices,
          warnings,
          // Cursor, Copilot and OpenCode read the user's home folders every
          // turn, through the same projection.
          options?.inheritedCursorCapabilities,
        )
      : emptyCursorCapabilityProjection();

  if (purpose === 'claude-session' && claudeModAdmissionContext?.enabled) {
    const selectedByPath = new Map(
      selectedClaudeModInputs.flatMap((plugin) =>
        plugin.installPath ? [[plugin.installPath, plugin] as const] : [],
      ),
    );
    const stripKeys = new Set(
      (claudeModAdmissionDecision?.stripSelectedPlugins ?? []).map(
        claudeModPluginKey,
      ),
    );
    const mcpPaths = new Set(
      Array.from(pluginsWithMcpServers, (pluginPath) =>
        path.resolve(pluginPath),
      ),
    );
    const projectionRootDir = path.join(
      options?.runtimeDirs?.claudePluginDir ??
        getChatSkillPluginDir(projectId, worktreeId, chatId),
      'projected-plugins',
    );
    const failedPaths = new Set<string>();
    for (const sdkPlugin of sdkPlugins) {
      const sourcePath = path.resolve(sdkPlugin.path);
      const selected = selectedByPath.get(sourcePath);
      const removeModules =
        selected !== undefined && stripKeys.has(claudeModPluginKey(selected));
      const removeMcpServers = mcpPaths.has(sourcePath);
      if (!removeModules && !removeMcpServers) continue;
      // With no Mod to strip, remove MCP servers exactly as flag-off does; an
      // admitted Mod's digest already refused any symlink in its tree.
      const mcpOnlySource = removeModules
        ? undefined
        : resolvedPlugins.find(
            (plugin) => path.resolve(plugin.pluginPath) === sourcePath,
          );
      const projectedPath = mcpOnlySource
        ? projectClaudePluginWithoutMcpServers({
            sourcePluginPath: mcpOnlySource.pluginPath,
            marketplaceId: mcpOnlySource.marketplaceId,
            pluginName: mcpOnlySource.pluginName,
            projectionRootDir,
            warnings,
          })
        : projectClaudePluginForLaunch({
            sourcePluginPath: sourcePath,
            projectionRootDir,
            removeModules,
            removeMcpServers,
          });
      if (projectedPath) {
        projectionSources.set(projectedPath, sourcePath);
        sdkPlugin.path = projectedPath;
        continue;
      }

      failedPaths.add(sourcePath);
      const pluginId = selected?.pluginId ?? 'unknown@inline';
      warnings.push(
        `Claude plugin projection failed for selected plugin "${pluginId}"; it was omitted from this launch.`,
      );
      if (removeModules && selected) {
        const skippedMods = [...(claudeModAdmission?.skippedMods ?? [])];
        const sourceSkipped = skippedMods.find(
          (entry) =>
            entry.pluginId === selected.pluginId && entry.source === 'selected',
        );
        addSkippedClaudeMod(skippedMods, {
          pluginId: selected.pluginId,
          source: 'selected',
          contentDigest: sourceSkipped?.contentDigest ?? null,
          reason: 'projection-failed',
        });
        claudeModAdmission = {
          ...(claudeModAdmission?.settings
            ? { settings: claudeModAdmission.settings }
            : {}),
          skippedMods,
        };
      }
    }
    for (let index = sdkPlugins.length - 1; index >= 0; index--) {
      const plugin = sdkPlugins[index];
      if (plugin && failedPaths.has(path.resolve(plugin.path))) {
        sdkPlugins.splice(index, 1);
      }
    }
  } else if (purpose === 'claude-session' && pluginsWithMcpServers.size > 0) {
    const projectionRootDir = path.join(
      options?.runtimeDirs?.claudePluginDir ??
        getChatSkillPluginDir(projectId, worktreeId, chatId),
      'projected-plugins',
    );
    for (const plugin of resolvedPlugins) {
      if (!pluginsWithMcpServers.has(plugin.pluginPath)) {
        continue;
      }
      const projectedPath = projectClaudePluginWithoutMcpServers({
        sourcePluginPath: plugin.pluginPath,
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.pluginName,
        projectionRootDir,
        warnings,
      });
      for (const sdkPlugin of sdkPlugins) {
        if (sdkPlugin.path === plugin.pluginPath) {
          projectionSources.set(projectedPath, plugin.pluginPath);
          sdkPlugin.path = projectedPath;
        }
      }
    }
  }

  mcpMs = Date.now() - stageStartedAt;
  if (codexPurpose && purpose !== 'delegation-codex-mcp') {
    stageStartedAt = Date.now();
    let nativeProjectionRoot: string | null = null;
    try {
      nativeProjectionRoot = await fs.promises.mkdtemp(
        path.join(getDataDir(), 'codex-capability-build-'),
      );
      const materialized = await materializeCodexPluginsOffMain({
        nativeProjectionRoot,
        plugins: resolvedPlugins.map((plugin) => ({
          ...plugin,
          removeMcpServers: codexPluginsWithMcpServers.has(plugin.pluginPath),
        })),
        skills: explicitSkills,
      });
      materializationMs = Date.now() - stageStartedAt;
      warnings.push(...materialized.warnings);

      const uniqueSelectedPlugins = selectUniqueCapabilityPlugins(
        materialized.selectedPlugins,
        warnings,
      );
      selectedCapabilityRoots = uniqueSelectedPlugins.map((plugin) =>
        createLocalCapabilityRoot(plugin.cacheDir),
      );
      stageStartedAt = Date.now();
      try {
        selectedCapabilityRoots = (
          await getDesktopCodexCapabilityStore().publishSelectedRoots(
            selectedCapabilityRoots,
          )
        ).roots;
      } catch (error) {
        selectedCapabilityRoots = [];
        warnings.push(
          `Codex plugin capabilities could not be published and were skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        publishMs = Date.now() - stageStartedAt;
      }
    } catch (error) {
      selectedCapabilityRoots = [];
      materializationMs = Date.now() - stageStartedAt;
      warnings.push(
        `Codex plugin capabilities could not be materialized and were skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (nativeProjectionRoot) {
        try {
          await fs.promises.rm(nativeProjectionRoot, {
            recursive: true,
            force: true,
          });
        } catch (error) {
          warnings.push(
            `Temporary Codex capability files could not be removed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  if (codexPurpose) {
    codexMcpServers = buildCodexPluginMcpServers(
      {
        ...standaloneMcpServers,
        ...resolvedPluginMcpServers,
      },
      warnings,
    );
  }
  const validatedSdkPlugins = sdkPlugins.filter((plugin) => {
    if (fs.existsSync(plugin.path)) {
      return true;
    }

    warnings.push(`${MISSING_PLUGIN_PATH_WARNING_PREFIX} ${plugin.path}`);
    return false;
  });

  return {
    ...(claudeModAdmission ? { claudeModAdmission } : {}),
    inheritedPluginBindings,
    sdkPlugins: validatedSdkPlugins,
    ...(codexPurpose
      ? {}
      : {
          identifiedSdkPlugins: validatedSdkPlugins.map((plugin, index) => {
            // A projection keeps the identity of the install it was made from.
            const sourcePath = projectionSources.get(plugin.path);
            return {
              ...plugin,
              pluginId: claudeModPluginIdentity(
                sourcePath ?? plugin.path,
                index,
                resolvedPlugins,
                registeredPluginId,
              ).pluginId,
              ...(sourcePath ? { sourcePath } : {}),
            };
          }),
        }),
    skillPluginDir,
    selectedCapabilityRoots,
    codexMcpServers,
    mcpServers,
    mcpServerBindings: mcpServerBindingsByName(httpMcpContext),
    mcpCapabilityIdentities: mcpCapabilityIdentitiesByName(
      httpMcpContext,
      mcpServers,
    ),
    mcpAuthTargets: options?.sessionId
      ? options.mcpHttpProxyService?.getSessionMcpAuthTargets?.(
          options.sessionId,
          mcpServers,
        )
      : undefined,
    warnings,
    cursorNotices,
    cursorCapabilities,
    timings: {
      selectionMs,
      mcpMs,
      materializationMs,
      publishMs,
      totalMs: Date.now() - resolutionStartedAt,
    },
  };
}

function buildClaudeSkillPluginDir(
  projectId: string,
  worktreeId: string,
  chatId: string,
  skills: readonly PluginResolvedSkill[],
  warnings: string[],
  runtimeDirs?: ResolvePluginsOptions['runtimeDirs'],
): string | null {
  const chatPluginsRootDir = path.resolve(
    runtimeDirs?.rootDir ?? getChatPluginsRootDir(),
  );
  const pluginDir = path.resolve(
    runtimeDirs?.claudePluginDir ??
      getChatSkillPluginDir(projectId, worktreeId, chatId),
  );

  if (!isPathInside(chatPluginsRootDir, pluginDir)) {
    warnings.push(
      'Computed chat skill plugin directory is outside the chat plugins root, skipping skill plugin resolution.',
    );
    return null;
  }

  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }

  let linkedCount = 0;
  for (const skill of skills) {
    const targetDir = path.join(pluginDir, 'skills', skill.name);
    if (!isPathInside(pluginDir, targetDir)) {
      warnings.push(
        `Skill name "${skill.name}" produces unsafe path, skipping.`,
      );
      continue;
    }

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.symlinkSync(skill.sourceDir, targetDir, getDirectorySymlinkType());
    linkedCount += 1;
  }

  if (linkedCount === 0) {
    return null;
  }

  const manifestDir = path.join(pluginDir, '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify({ name: 'canopy-chat-skills' }, null, 2),
    'utf8',
  );

  return pluginDir;
}

function warnHttpProxyFallbackOnce(
  warnings: string[],
  context: HttpMcpResolutionContext,
): void {
  if (context.proxyFallbackWarningEmitted) {
    return;
  }
  warnings.push(
    'HTTP MCP servers are using direct injection because the local proxy is not available in this context.',
  );
  context.proxyFallbackWarningEmitted = true;
}

function warnOAuthHttpMcpSkipped(
  warnings: string[],
  label: string,
  reason: string,
): void {
  warnings.push(
    `MCP server "${label}" requires OAuth, but ${reason}; skipping to avoid provider-side browser login.`,
  );
}

function warnUnverifiedHttpMcpSkipped(
  warnings: string[],
  label: string,
  reason: string,
): void {
  warnings.push(
    `MCP server "${label}" authentication requirements could not be verified and ${reason}; skipping direct provider fallback.`,
  );
}

function warnProtectedHttpMcpSkipped(
  warnings: string[],
  label: string,
  reason: string,
): void {
  warnings.push(
    `MCP server "${label}" uses credentials or fixed headers, but ${reason}; skipping to keep them parent-owned.`,
  );
}

function hasProtectedHttpHeaders(headers: Record<string, string>): boolean {
  return Object.keys(headers).length > 0;
}

export function resolveHttpMcpHandler(args: {
  warnings: string[];
  context: HttpMcpResolutionContext;
  target:
    | { kind: 'standalone'; serverId: string; configId: string }
    | {
        kind: 'plugin';
        marketplaceId: string;
        pluginName: string;
        serverName: string;
      };
  definition?: McpServerDefinitionData;
  indexEntry?: Pick<
    McpServerIndexEntry,
    'scope' | 'authHandler' | 'accountConnectionId'
  >;
}): {
  handler: McpHttpAuthHandler;
  source: 'default' | 'server' | 'override' | 'pinned';
} {
  const pinned = args.context.pinnedHandlers?.get(
    mcpHttpAuthTargetKey(args.target),
  );
  const result = getMcpHttpAuthHandler(
    args.context.selections,
    args.target,
    pinned ??
      (args.definition
        ? getMcpHttpAuthDefault(
            args.definition,
            args.indexEntry,
            args.context.defaultHandler,
          )
        : args.context.defaultHandler),
  );
  return {
    handler: result.handler,
    source:
      result.source === 'override'
        ? 'override'
        : pinned !== undefined
          ? 'pinned'
          : args.definition?.httpAuthHandler != null
            ? 'server'
            : 'default',
  };
}

async function resolveAccountHttpMcp(args: {
  options: ResolvePluginsOptions | undefined;
  context: HttpMcpResolutionContext;
  warnings: string[];
  proxyPortPreference: number;
  serverId: string;
  configId: string;
  displayName: string;
  curatedKey?: string;
  accountConnectionId?: string;
}): Promise<
  | { server: ResolvedStandaloneMcpServer; connection: AccountMcpConnection }
  | undefined
> {
  const { options, context } = args;
  try {
    if (!context.proxyAvailable || !options?.mcpHttpProxyService)
      throw new Error('the local proxy is unavailable');
    const { upstreamUrl, connection } =
      await resolveAccountMcpProxyTarget(args);
    return {
      server: await registerAccountMcpProxyRoute({
        options,
        proxyPortPreference: args.proxyPortPreference,
        serverId: args.serverId,
        configId: args.configId,
        displayName: args.displayName,
        upstreamUrl,
      }),
      connection,
    };
  } catch (error) {
    args.warnings.push(
      `Account MCP server "${args.displayName}" skipped: ${error instanceof Error ? error.message : 'connection unavailable'}`,
    );
    return undefined;
  }
}

/** Register the cloud-authenticated proxy route for one account upstream. */
async function registerAccountMcpProxyRoute(args: {
  options: ResolvePluginsOptions;
  proxyPortPreference: number;
  serverId: string;
  configId: string;
  displayName: string;
  upstreamUrl: string;
}): Promise<ResolvedStandaloneMcpServer> {
  const { options } = args;
  if (!options.mcpHttpProxyService)
    throw new Error('the local proxy is unavailable');
  await withResolverTimeout(
    options.mcpHttpProxyService.ensureStarted(args.proxyPortPreference),
    proxyOperationTimeoutMs(options),
    'Starting the local MCP proxy',
  );
  const routeKey = buildCodexMcpProxyRouteKey({
    purpose: options.purpose,
    kind: 'standalone',
    serverId: args.serverId,
    configId: args.configId,
    upstreamUrl: args.upstreamUrl,
    headers: {},
    oauthEnabled: false,
    oauthRequired: false,
  });
  const routeId = await withResolverTimeout(
    options.mcpHttpProxyService.registerRoute({
      ...buildMcpProxyRouteScope(options, routeKey),
      serverId: args.serverId,
      configId: args.configId,
      displayName: args.displayName,
      upstreamUrl: args.upstreamUrl,
      headers: {},
      authSupplier: 'canopy-cloud',
      oauthEnabled: false,
      oauthRequired: false,
    }),
    proxyOperationTimeoutMs(options),
    'Registering account MCP proxy route',
  );
  try {
    return {
      type: 'http',
      url: options.mcpHttpProxyService.getProxyUrl(routeId),
      headers: undefined,
    };
  } catch (error) {
    options.mcpHttpProxyService.unregisterRoute(routeId);
    throw error;
  }
}

/**
 * Bind a selection to the account connection its target names. The lookup
 * runs first so every selection that lands on one connection, by id or by
 * curated key, shares the entry, the route, and the connection-derived name
 * another selection in this resolution already produced.
 */
async function bindAccountMcpConnection(args: {
  options: ResolvePluginsOptions | undefined;
  context: HttpMcpResolutionContext;
  warnings: string[];
  proxyPortPreference: number;
  target: AccountMcpConnectionTarget;
  /** Names the selection in the skip warning, as the caller knows it. */
  displayName: string;
  source: ResolvedMcpServerSource;
}): Promise<{ entry: BoundMcpServer; reused: boolean } | undefined> {
  const { options, context } = args;
  try {
    if (!context.proxyAvailable || !options?.mcpHttpProxyService)
      throw new Error('the local proxy is unavailable');
    const { upstreamUrl, connection } = await resolveAccountMcpProxyTarget(
      args.target,
    );
    const key = accountBindingKey(connection.id);
    const existing = context.boundServers.get(key);
    if (existing)
      return { entry: adoptBoundServer(existing, args.source), reused: true };
    const server = await registerAccountMcpProxyRoute({
      options,
      proxyPortPreference: args.proxyPortPreference,
      serverId: connection.serverKey,
      configId: connection.configId,
      displayName: connection.displayName,
      upstreamUrl,
    });
    return {
      entry: recordBoundServer(context, [key], {
        serverName: buildAccountMcpServerName(connection),
        server,
        binding: {
          binding: {
            kind: 'account',
            accountConnectionId: connection.id,
            serverKey: connection.serverKey,
            configId: connection.configId,
          },
          displayName: connection.displayName,
          sources: [args.source],
        },
      }),
      reused: false,
    };
  } catch (error) {
    args.warnings.push(
      `Account MCP server "${args.displayName}" skipped: ${error instanceof Error ? error.message : 'connection unavailable'}`,
    );
    return undefined;
  }
}

async function determineStandaloneProxyAuth(args: {
  definition: McpServerDefinitionData;
  config: McpServerConfigData;
  headers: Record<string, string>;
}): Promise<{ oauthEnabled: boolean; oauthRequired: boolean | undefined }> {
  // Match the proxy headers, inventory, and explicit connection checks: a
  // configured bearer token owns this config even with optional OAuth metadata.
  if (args.config.authToken) {
    return { oauthEnabled: false, oauthRequired: false };
  }

  if (args.definition.oauth) {
    return { oauthEnabled: true, oauthRequired: true };
  }

  if (!args.definition.url) {
    return { oauthEnabled: false, oauthRequired: false };
  }

  const probe = await probeMcpHttpOAuthRequirement(
    args.definition.url,
    args.headers,
    1_000,
  );
  if (probe.requirement === 'oauth') {
    return { oauthEnabled: true, oauthRequired: true };
  }
  return {
    oauthEnabled: false,
    oauthRequired: probe.requirement === 'none' ? false : undefined,
  };
}

interface ResolvedDeviceHttpMcpServer {
  serverName: string;
  server: ResolvedStandaloneMcpServer;
  /** Set when the device server routed through an account connection. */
  bound?: BoundMcpServer;
  /** True when another selection already produced `bound`; nothing new to load. */
  reused: boolean;
}

/**
 * Resolve one enabled HTTP config of a device server file: the handler
 * decision, the proxy route, and the managed name are the same whether a
 * standalone ref or a curated plugin member asked for it.
 */
async function resolveDeviceHttpMcpServer(args: {
  serverFile: McpServerFile;
  config: McpServerConfigData;
  warnings: string[];
  options: ResolvePluginsOptions | undefined;
  context: HttpMcpResolutionContext;
  proxyPortPreference: number;
  proxyState: McpProxyStartState;
  source: ResolvedMcpServerSource;
}): Promise<ResolvedDeviceHttpMcpServer | undefined> {
  const {
    config,
    warnings,
    options,
    context,
    proxyPortPreference,
    proxyState,
  } = args;
  const definition = args.serverFile.server.definition;
  if (definition.type !== 'http' || !definition.url) return undefined;
  const friendlyParts =
    normalizeManagedMcpServerLabel(config.name) !== 'default'
      ? [definition.name, config.name]
      : [definition.name];
  const identityParts = [definition.id, config.id];
  const dynamicServerName = buildManagedMcpServerName({
    kind: 'dynamic',
    friendlyParts,
    identityParts,
  });
  const headers: Record<string, string> = {
    ...(definition.headers ?? {}),
    ...config.extraHeaders,
  };
  if (config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }

  const indexEntry = await readMcpAccountIndexEntry(definition.id);
  const { handler } = resolveHttpMcpHandler({
    warnings,
    context,
    definition,
    indexEntry,
    target: {
      kind: 'standalone',
      serverId: definition.id,
      configId: config.id,
    },
  });

  if (handler === 'account') {
    const bound = await bindAccountMcpConnection({
      options,
      context,
      warnings,
      proxyPortPreference,
      target: {
        curatedKey: definition.curated?.key,
        accountConnectionId: indexEntry?.accountConnectionId,
        configId: config.id,
      },
      displayName: definition.name,
      source: args.source,
    });
    if (!bound) return undefined;
    return {
      serverName: bound.entry.serverName,
      server: bound.entry.server,
      bound: bound.entry,
      reused: bound.reused,
    };
  }

  if (
    handler === 'canopy' &&
    context.proxyAvailable &&
    options?.mcpHttpProxyService
  ) {
    try {
      if (proxyState.port === null) {
        await withResolverTimeout(
          options.mcpHttpProxyService.ensureStarted(proxyPortPreference),
          proxyOperationTimeoutMs(options),
          'Starting the local MCP OAuth proxy',
        );
        proxyState.port = proxyPortPreference;
      }

      const proxyAuth = await determineStandaloneProxyAuth({
        definition,
        config,
        headers,
      });
      const routeKey = buildCodexMcpProxyRouteKey({
        purpose: options?.purpose,
        kind: 'standalone',
        serverId: definition.id,
        configId: config.id,
        upstreamUrl: definition.url,
        headers,
        oauthEnabled: proxyAuth.oauthEnabled,
        oauthRequired: proxyAuth.oauthRequired === true,
      });
      const routeId = await withResolverTimeout(
        options.mcpHttpProxyService.registerRoute({
          ...buildMcpProxyRouteScope(options, routeKey),
          serverId: definition.id,
          configId: config.id,
          displayName: definition.name,
          upstreamUrl: definition.url,
          headers,
          oauthEnabled: proxyAuth.oauthEnabled,
          oauthRequired: proxyAuth.oauthRequired,
          oauthDefinition: proxyAuth.oauthEnabled ? definition : undefined,
          oauthConfig: proxyAuth.oauthEnabled ? config : undefined,
        }),
        proxyOperationTimeoutMs(options),
        `Registering MCP proxy route for "${definition.name || definition.id}"`,
      );
      const proxyServerName = buildManagedMcpServerName({
        kind: 'proxy',
        friendlyParts,
        identityParts,
      });
      try {
        return {
          serverName: proxyServerName,
          server: {
            type: 'http',
            url: options.mcpHttpProxyService.getProxyUrl(routeId),
            headers: undefined,
          },
          reused: false,
        };
      } catch (error) {
        options.mcpHttpProxyService.unregisterRoute(routeId);
        throw error;
      }
    } catch (error) {
      warnings.push(
        `MCP server "${definition.name || definition.id}" could not be proxied: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const proxyAuth = await determineStandaloneProxyAuth({
        definition,
        config,
        headers,
      });
      if (proxyAuth.oauthRequired !== false) {
        const warn =
          proxyAuth.oauthRequired === true
            ? warnOAuthHttpMcpSkipped
            : warnUnverifiedHttpMcpSkipped;
        warn(
          warnings,
          definition.name || definition.id,
          'the local proxy could not be configured',
        );
        return undefined;
      }
      if (hasProtectedHttpHeaders(headers)) {
        warnProtectedHttpMcpSkipped(
          warnings,
          definition.name || definition.id,
          'the local proxy could not be configured',
        );
        return undefined;
      }
      warnHttpProxyFallbackOnce(warnings, context);
    }
  }

  if (handler === 'canopy' && !context.proxyAvailable) {
    const proxyAuth = await determineStandaloneProxyAuth({
      definition,
      config,
      headers,
    });
    if (proxyAuth.oauthRequired !== false) {
      const warn =
        proxyAuth.oauthRequired === true
          ? warnOAuthHttpMcpSkipped
          : warnUnverifiedHttpMcpSkipped;
      warn(
        warnings,
        definition.name || definition.id,
        'the local proxy is not available in this context',
      );
      return undefined;
    }
    if (hasProtectedHttpHeaders(headers)) {
      warnProtectedHttpMcpSkipped(
        warnings,
        definition.name || definition.id,
        'the local proxy is not available in this context',
      );
      return undefined;
    }
    warnHttpProxyFallbackOnce(warnings, context);
  }

  return {
    serverName: dynamicServerName,
    server: {
      type: 'http',
      url: definition.url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    },
    reused: false,
  };
}

/** Record a device server's binding for every later selection that names it. */
function recordDeviceHttpMcpServer(
  context: HttpMcpResolutionContext,
  serverFile: McpServerFile,
  config: McpServerConfigData,
  resolved: ResolvedDeviceHttpMcpServer,
  source: ResolvedMcpServerSource,
): BoundMcpServer {
  const definition = serverFile.server.definition;
  const key = deviceBindingKey(definition.id, config.id);
  // An account-routed device server is already recorded under its connection
  // (with this source); only the device alias is new.
  if (resolved.bound) return recordBoundServer(context, [key], resolved.bound);
  return recordBoundServer(context, [key], {
    serverName: resolved.serverName,
    server: resolved.server,
    binding: {
      binding: { kind: 'device', serverId: definition.id, configId: config.id },
      displayName: definition.name,
      sources: [source],
    },
  });
}

async function resolveStandaloneMcpServers(
  mcpRefs: ReadonlyMap<string, { serverId: string; configId: string }>,
  warnings: string[],
  options: ResolvePluginsOptions | undefined,
  context: HttpMcpResolutionContext,
  proxyPortPreference: number,
): Promise<Record<string, ResolvedStandaloneMcpServer>> {
  const result: Record<string, ResolvedStandaloneMcpServer> = {};
  const proxyState: McpProxyStartState = { port: null };

  for (const ref of Array.from(mcpRefs.values())) {
    // Account servers are selected by server key (curated key or
    // `custom:<uuid>`) plus config; legacy `account:<connectionId>` refs map
    // to the same connection. A device file with the ref's id still wins.
    const accountOnly =
      legacyAccountMcpConnectionId(ref.serverId) !== undefined ||
      isCustomAccountMcpServerKey(ref.serverId);
    let serverFile: McpServerFile | undefined;
    if (!accountOnly) {
      try {
        serverFile = normalizeMcpServerFile(
          safeReadJson<unknown>(getMcpServerFilePath(ref.serverId)),
          ref.serverId,
        );
      } catch {
        serverFile = undefined;
      }
    }
    if (!serverFile) {
      if (!accountMcpConnectionsEnabled()) {
        warnings.push(
          accountOnly
            ? 'Account MCP connections are unavailable.'
            : `MCP server "${ref.serverId}" not found, skipping.`,
        );
        continue;
      }
      const connection = accountMcpConnectionForRef(
        ref,
        (await loadSharedAccountMcpConnections(context)) ?? [],
      );
      if (!connection) {
        warnings.push(
          accountOnly
            ? 'Account MCP connection is unavailable. Connect again.'
            : `MCP server "${ref.serverId}" not found, skipping.`,
        );
        continue;
      }
      const bound = await bindAccountMcpConnection({
        options,
        context,
        warnings,
        proxyPortPreference,
        target: { accountConnectionId: connection.id },
        displayName: connection.displayName,
        source: {
          kind: 'standalone',
          serverId: connection.serverKey,
          configId: connection.configId,
        },
      });
      // Two refs to one connection load it once, as before.
      if (bound && !bound.reused)
        result[bound.entry.serverName] = bound.entry.server;
      continue;
    }

    const config = serverFile.server.configs.find(
      (entry) => entry.id === ref.configId,
    );
    if (!config) {
      warnings.push(
        `MCP config "${ref.configId}" not found on server "${ref.serverId}", skipping.`,
      );
      continue;
    }
    if (!config.enabled) {
      warnings.push(
        `MCP config "${ref.configId}" on server "${ref.serverId}" is disabled, skipping.`,
      );
      continue;
    }

    const definition = serverFile.server.definition;
    const friendlyParts =
      normalizeManagedMcpServerLabel(config.name) !== 'default'
        ? [definition.name, config.name]
        : [definition.name];
    const identityParts = [definition.id, config.id];
    const dynamicServerName = buildManagedMcpServerName({
      kind: 'dynamic',
      friendlyParts,
      identityParts,
    });
    context.capabilityIdentities[dynamicServerName] = [
      {
        kind: 'standalone',
        serverId: definition.id,
        configId: config.id,
      },
    ];

    if (definition.type === 'command' && definition.command) {
      result[dynamicServerName] = {
        type: 'stdio',
        command: definition.command,
        args: [...(definition.args ?? []), ...config.extraArgs],
        env:
          Object.keys(config.envVars).length > 0
            ? sanitizeEnvVars(config.envVars)
            : undefined,
      };
      continue;
    }

    if (definition.type === 'http' && definition.url) {
      const key = deviceBindingKey(definition.id, config.id);
      const source: ResolvedMcpServerSource = {
        kind: 'standalone',
        serverId: definition.id,
        configId: config.id,
      };
      const existing = context.boundServers.get(key);
      if (existing) {
        adoptBoundServer(existing, source);
        continue;
      }
      const resolved = await resolveDeviceHttpMcpServer({
        serverFile,
        config,
        warnings,
        options,
        context,
        proxyPortPreference,
        proxyState,
        source,
      });
      if (!resolved) continue;
      recordDeviceHttpMcpServer(context, serverFile, config, resolved, source);
      if (!resolved.reused) result[resolved.serverName] = resolved.server;
    }
  }

  return result;
}

/**
 * Load a provider-specific plugin manifest. For backwards compatibility,
 * Claude lookups fall back to a Codex manifest when no Claude manifest exists.
 */
export function loadPluginManifest(
  pluginPath: string,
  provider: PluginResolvedPath['provider'] = 'claude',
): PluginManifest | null {
  const manifestPath = path.join(
    pluginPath,
    provider === 'codex' ? '.codex-plugin' : '.claude-plugin',
    'plugin.json',
  );
  const manifest = safeReadJson<PluginManifest>(manifestPath);
  if (manifest || provider === 'codex') {
    return manifest;
  }
  return safeReadJson<PluginManifest>(
    path.join(pluginPath, '.codex-plugin', 'plugin.json'),
  );
}

function extractPluginMcpServers(
  config: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const servers =
    isRecord(config.mcpServers) && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : config;
  if (!isRecord(servers)) {
    return {};
  }

  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (isRecord(value)) {
      result[name] = value;
    }
  }
  return result;
}

export function readPluginMcpConfigObjects(
  pluginPath: string,
  manifest: PluginManifest | null,
): Record<string, Record<string, unknown>> {
  const manifestValue = manifest?.mcpServers;
  if (manifestValue) {
    if (typeof manifestValue === 'string') {
      const resolvedPath = path.resolve(pluginPath, manifestValue);
      if (isPathInside(pluginPath, resolvedPath)) {
        const config = safeReadJson<Record<string, unknown>>(resolvedPath);
        return config ? extractPluginMcpServers(config) : {};
      }
      return {};
    }

    if (Array.isArray(manifestValue)) {
      const merged: Record<string, Record<string, unknown>> = {};
      for (const entry of manifestValue) {
        if (typeof entry !== 'string') {
          continue;
        }

        const resolvedPath = path.resolve(pluginPath, entry);
        if (!isPathInside(pluginPath, resolvedPath)) {
          continue;
        }

        const config = safeReadJson<Record<string, unknown>>(resolvedPath);
        if (!config) {
          continue;
        }

        Object.assign(merged, extractPluginMcpServers(config));
      }
      return merged;
    }

    if (isRecord(manifestValue)) {
      return extractPluginMcpServers(manifestValue);
    }
  }

  const defaultPath = path.join(pluginPath, '.mcp.json');
  const defaultConfig = safeReadJson<Record<string, unknown>>(defaultPath);
  return defaultConfig ? extractPluginMcpServers(defaultConfig) : {};
}

/** Read the same declaration and credential identity for inventory, login and execution. */
export async function readPluginMcpAuthEntries(
  pluginPath: string,
  marketplaceId: string,
  pluginName: string,
  provider: 'claude' | 'codex' = 'claude',
  primaryPluginPath?: string | null,
): Promise<
  Array<{
    serverName: string;
    rawValue: Record<string, unknown>;
    identity: PluginMcpAuthIdentity;
  }>
> {
  const rawServers = readPluginMcpConfigObjects(
    pluginPath,
    loadPluginManifest(pluginPath, provider),
  );
  const primaryServers = primaryPluginPath
    ? readPluginMcpConfigObjects(
        primaryPluginPath,
        loadPluginManifest(primaryPluginPath, 'claude'),
      )
    : {};
  return Promise.all(
    Object.entries(rawServers).map(async ([serverName, rawValue]) => {
      const authNamespace =
        provider === 'codex' && primaryPluginPath !== undefined
          ? getPluginMcpAuthNamespace(rawValue, primaryServers[serverName])
          : undefined;
      const identity: PluginMcpAuthIdentity = {
        marketplaceId,
        pluginName,
        serverName,
        authNamespace,
      };
      const server = buildPluginHttpMcpServerForAuth(identity, rawValue, true);
      if (server) {
        const legacyNamespace =
          provider === 'codex' && primaryPluginPath !== undefined
            ? getLegacyPluginMcpAuthNamespace(
                rawValue,
                primaryServers[serverName],
              )
            : undefined;
        const sources = [
          {
            ...getPreviousDeclarationPluginMcpOAuthIds(identity, rawValue),
            allowDiscoveredClient: true,
          },
          {
            ...getLegacyPluginMcpOAuthIds({
              ...identity,
              authNamespace: legacyNamespace,
            }),
            allowDiscoveredClient: true,
          },
        ];
        const primary = primaryServers[serverName];
        if (provider === 'codex' && primary && authNamespace === undefined) {
          // The complete declarations are equivalent, so the primary's old
          // declaration-bound grant belongs to this same connection as well.
          sources.push({
            ...getPreviousDeclarationPluginMcpOAuthIds(identity, primary),
            allowDiscoveredClient: true,
          });
        }
        if (provider === 'codex') {
          // Older versions used a shared slot even for distinct Codex facets.
          // Adopt the other slot only with an explicit matching client binding;
          // never guess a dynamically registered client across provider slots.
          sources.push({
            ...getLegacyPluginMcpOAuthIds({
              ...identity,
              authNamespace: legacyNamespace ? undefined : 'codex',
            }),
            allowDiscoveredClient: false,
          });
        }
        await migratePluginMcpOAuthToken(
          server.definition,
          server.config,
          sources,
        );
      }
      return { serverName, rawValue, identity };
    }),
  );
}

export async function resolvePluginAuthPrimaryPath(
  plugin: PluginInfo,
  marketplace: MarketplaceInfo,
  provider: 'claude' | 'codex' | undefined,
  warnings: string[],
): Promise<string | null | undefined> {
  const facets = getPluginFacets(plugin, marketplace);
  return provider === 'codex' && facets.claude
    ? resolveFacetPath(plugin, facets.claude, marketplace, warnings, false)
    : undefined;
}

/** Mirrors the cloud producer's skip wording so both surfaces read the same. */
const CURATED_PLUGIN_MCP_NOT_CONNECTED =
  'is not connected; connect it from the MCP Servers panel';

/**
 * Bind a curated plugin's HTTP member, in order: a connected account
 * connection for its key, else the device server file carrying that key,
 * else nothing. A desktop-only key (REG-3035) skips the account lookup: an
 * account connection made before the catalog marked it binds nothing and
 * never blocks the device server, matching the Plugins card. A bound member
 * shares the entry, route, and name of whatever already resolved that
 * connection in this resolution. Unbound members are reported and skipped;
 * the plugin never runs its own OAuth, because that is how a grant the MCP
 * Servers card never knew about used to come to exist.
 */
async function bindCuratedPluginMcpMember(args: {
  plugin: PluginResolvedPath;
  serverName: string;
  curatedKey: string;
  warnings: string[];
  options: ResolvePluginsOptions | undefined;
  context: HttpMcpResolutionContext;
  proxyPortPreference: number;
  proxyState: McpProxyStartState;
}): Promise<BoundMcpServer | undefined> {
  const { plugin, serverName, curatedKey, warnings, options, context } = args;
  const label = `${plugin.pluginName}/${serverName}`;
  const source: ResolvedMcpServerSource = {
    kind: 'plugin',
    marketplaceId: plugin.marketplaceId,
    pluginName: plugin.pluginName,
    serverName,
  };
  const collapsed = (entry: BoundMcpServer): BoundMcpServer => {
    warnings.push(
      `MCP server "${label}" is already connected as "${entry.binding.displayName}"; loading it once.`,
    );
    return entry;
  };

  // The account lookup must succeed before a device file is considered: an
  // unreadable list or an ambiguous key fails closed rather than binding a
  // grant the account card does not know.
  if (
    accountMcpConnectionsEnabled() &&
    !(await loadSharedDesktopOnlyCuratedKeys(context)).has(curatedKey)
  ) {
    const connections = await loadSharedAccountMcpConnections(context);
    if (connections === null) {
      warnings.push(
        `Account MCP server "${label}" skipped: ${CURATED_PLUGIN_MCP_LIST_UNAVAILABLE}`,
      );
      return undefined;
    }
    const lookup = findCuratedAccountMcpConnection(connections, curatedKey);
    if (lookup.kind === 'ambiguous') {
      warnings.push(
        `Account MCP server "${label}" skipped: ${CURATED_PLUGIN_MCP_AMBIGUOUS}`,
      );
      return undefined;
    }
    const connection =
      lookup.kind === 'connection' ? lookup.connection : undefined;
    const unusable =
      connection === undefined
        ? null
        : accountMcpConnectionUnusableReason(connection);
    if (connection !== undefined && unusable === null) {
      const bound = await bindAccountMcpConnection({
        options,
        context,
        warnings,
        proxyPortPreference: args.proxyPortPreference,
        target: { accountConnectionId: connection.id },
        displayName: label,
        source,
      });
      // A failed account route already warned; never fall back to a local grant.
      if (!bound) return undefined;
      return bound.reused ? collapsed(bound.entry) : bound.entry;
    }
    // A connection that exists but is not usable fails closed: the member
    // never falls back to a device grant the account card does not know.
    if (unusable !== null) {
      warnings.push(`Account MCP server "${label}" skipped: ${unusable}`);
      return undefined;
    }
  }

  const device = await findCuratedDeviceMcpServer(curatedKey);
  if (device) {
    const definition = device.serverFile.server.definition;
    const existing = context.boundServers.get(
      deviceBindingKey(definition.id, device.config.id),
    );
    if (existing) return collapsed(adoptBoundServer(existing, source));
    const resolved = await resolveDeviceHttpMcpServer({
      serverFile: device.serverFile,
      config: device.config,
      warnings,
      options,
      context,
      proxyPortPreference: args.proxyPortPreference,
      proxyState: args.proxyState,
      source,
    });
    if (!resolved) return undefined;
    const entry = recordDeviceHttpMcpServer(
      context,
      device.serverFile,
      device.config,
      resolved,
      source,
    );
    return resolved.reused ? collapsed(entry) : entry;
  }

  warnings.push(
    `plugin "${plugin.pluginName}" mcp server "${curatedKey}" ${CURATED_PLUGIN_MCP_NOT_CONNECTED}`,
  );
  return undefined;
}

async function resolvePluginMcpServers(
  plugin: PluginResolvedPath,
  warnings: string[],
  options: ResolvePluginsOptions | undefined,
  context: HttpMcpResolutionContext,
  proxyPortPreference: number,
  retainInherited = false,
): Promise<PluginMcpResolutionResult> {
  const entries = await readPluginMcpAuthEntries(
    plugin.pluginPath,
    plugin.marketplaceId,
    plugin.pluginName,
    plugin.provider,
    plugin.primaryAuthPluginPath,
  );
  const authPins = new Map<string, AgentMcpHttpAuthPin>();
  const result: Record<string, unknown> = {};
  let hasMcpServers = false;
  const proxyState: McpProxyStartState = { port: null };
  const codexPurpose = isCodexPluginResolutionPurpose(options?.purpose);
  // Codex and Cursor launch the server directly from this definition, so the
  // plugin-root placeholder must be expanded here; Claude's plugin runtime
  // expands it itself.
  const expandsPluginRoot =
    codexPurpose ||
    options?.purpose === 'cursor-session' ||
    options?.purpose === 'copilot-session' ||
    options?.purpose === 'opencode-session';
  const replacePluginRoot = (value: string): string =>
    expandsPluginRoot
      ? value.split('${CLAUDE_PLUGIN_ROOT}').join(plugin.pluginPath)
      : value;

  for (const { serverName, rawValue, identity } of entries) {
    hasMcpServers = true;
    const resolvedName = buildManagedMcpServerName({
      kind: 'plugin',
      friendlyParts: [plugin.pluginName, serverName],
      identityParts: [plugin.marketplaceId, plugin.pluginName, serverName],
    });
    context.capabilityIdentities[resolvedName] = [
      {
        kind: 'plugin',
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.pluginName,
        serverName,
      },
    ];
    if (
      rawValue.enabled === false &&
      typeof rawValue.url === 'string' &&
      (!rawValue.type || rawValue.type === 'http')
    ) {
      if (codexPurpose) {
        result[resolvedName] = {
          type: 'http',
          url: replacePluginRoot(rawValue.url),
          enabled: false,
          ...buildCodexMcpToolPolicy(rawValue),
        };
      }
      continue;
    }
    const env =
      isStringRecord(rawValue.env) && Object.keys(rawValue.env).length > 0
        ? sanitizeEnvVars(
            Object.fromEntries(
              Object.entries(rawValue.env).map(([key, value]) => [
                key,
                replacePluginRoot(value),
              ]),
            ),
          )
        : undefined;
    const resolvedHeaders = resolvePluginHttpHeaders(rawValue);
    const headers =
      Object.keys(resolvedHeaders.headers).length > 0
        ? Object.fromEntries(
            Object.entries(resolvedHeaders.headers).map(([key, value]) => [
              key,
              replacePluginRoot(value),
            ]),
          )
        : undefined;

    if (typeof rawValue.command === 'string') {
      const cursorPurpose =
        options?.purpose === 'cursor-session' ||
        options?.purpose === 'copilot-session' ||
        options?.purpose === 'opencode-session';
      const command = replacePluginRoot(rawValue.command);
      // Only Codex starts the server in a declared cwd; the Claude CLI
      // ignores the field and ACP has none. A script path written relative
      // to a declared directory is therefore made absolute, with the
      // placeholder always expanded for the lookup even where the emitted
      // definition leaves it to the harness. Without a declared cwd the
      // harness legitimately starts the server in the chat's working
      // directory, so args stay as written. The rewrite applies to Codex
      // sessions as well so every session shares one output shape; on Codex
      // the absolute path names the same file it would have resolved itself.
      const declaredCwd =
        typeof rawValue.cwd === 'string'
          ? resolvePluginServerCwd(rawValue.cwd, plugin.pluginPath)
          : undefined;
      result[resolvedName] = {
        type: 'stdio',
        // ACP has no cwd field, so a plugin-relative command is made
        // absolute here for Cursor; Codex keeps its pinned cwd instead.
        command:
          cursorPurpose && command.includes('/') && !path.isAbsolute(command)
            ? path.resolve(plugin.pluginPath, command)
            : command,
        args: readStringArray(rawValue.args)?.map((arg) =>
          declaredCwd === undefined
            ? replacePluginRoot(arg)
            : resolveCwdRelativePathArg(replacePluginRoot(arg), declaredCwd),
        ),
        ...((codexPurpose || cursorPurpose) &&
        typeof rawValue.enabled === 'boolean'
          ? { enabled: rawValue.enabled }
          : {}),
        ...(codexPurpose
          ? { cwd: declaredCwd ?? plugin.pluginPath }
          : cursorPurpose && declaredCwd !== undefined
            ? { cwd: declaredCwd }
            : {}),
        env,
        ...(codexPurpose ? buildCodexMcpToolPolicy(rawValue) : {}),
      };
      continue;
    }

    if (
      typeof rawValue.url === 'string' &&
      (!rawValue.type || rawValue.type === 'http')
    ) {
      const handlerResolution = resolveHttpMcpHandler({
        warnings,
        context,
        target: {
          kind: 'plugin',
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.pluginName,
          serverName,
        },
      });
      const { handler } = handlerResolution;
      authPins.set(serverName, {
        target: {
          kind: 'plugin',
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.pluginName,
          serverName,
        },
        handler,
        source:
          handlerResolution.source === 'override' ? 'override' : 'default',
      });
      const codexExtras: Record<string, unknown> = {
        ...(codexPurpose && typeof rawValue.enabled === 'boolean'
          ? { enabled: rawValue.enabled }
          : {}),
        ...(codexPurpose ? buildCodexMcpToolPolicy(rawValue) : {}),
      };
      // A curated member names the connection it reaches. Unless the chat
      // overrides the handler for this member, it binds to that connection
      // or is skipped; it never starts a sign-in of its own.
      const curatedKey = curatedPluginMcpMemberKey(
        plugin.marketplaceId,
        rawValue,
      );
      if (curatedKey !== undefined && handlerResolution.source !== 'override') {
        const bound = await bindCuratedPluginMcpMember({
          plugin,
          serverName,
          curatedKey,
          warnings,
          options,
          context,
          proxyPortPreference,
          proxyState,
        });
        if (bound)
          result[bound.serverName] = { ...bound.server, ...codexExtras };
        continue;
      }
      if (handler === 'account') {
        const pluginServer = buildPluginHttpMcpServerForAuth(
          identity,
          rawValue,
          false,
        );
        if (pluginServer) {
          const proxied = await resolveAccountHttpMcp({
            options,
            context,
            warnings,
            proxyPortPreference,
            serverId: pluginServer.definition.id,
            configId: pluginServer.config.id,
            displayName: `${plugin.pluginName}/${serverName}`,
            curatedKey: pluginMcpCuratedKey(rawValue),
          });
          if (proxied)
            result[resolvedName] = { ...proxied.server, ...codexExtras };
        } else
          warnings.push(
            `Account MCP server "${serverName}" could not be resolved; skipping.`,
          );
        continue;
      }
      if (handler === 'canopy') {
        const oauthLike = hasPluginOAuthLikeMetadata(rawValue);
        const probe = !oauthLike
          ? await probeMcpHttpOAuthRequirement(
              rawValue.url,
              resolvedHeaders.headers,
              1_000,
            )
          : null;
        const forceOAuth = oauthLike || probe?.requiresOAuth === true;
        const directFallbackAllowed =
          !oauthLike && probe?.requirement === 'none';
        const pluginServer = buildPluginHttpMcpServerForAuth(
          identity,
          rawValue,
          forceOAuth,
        );
        if (
          pluginServer &&
          context.proxyAvailable &&
          options?.mcpHttpProxyService
        ) {
          try {
            if (proxyState.port === null) {
              await withResolverTimeout(
                options.mcpHttpProxyService.ensureStarted(proxyPortPreference),
                proxyOperationTimeoutMs(options),
                'Starting the local MCP OAuth proxy',
              );
              proxyState.port = proxyPortPreference;
            }

            const upstreamUrl = pluginServer.definition.url ?? rawValue.url;
            const routeKey = buildCodexMcpProxyRouteKey({
              purpose: options?.purpose,
              kind: 'plugin',
              serverId: pluginServer.definition.id,
              configId: pluginServer.config.id,
              upstreamUrl,
              headers: pluginServer.headers,
              oauthEnabled: pluginServer.definition.oauth !== undefined,
              oauthRequired: forceOAuth,
            });
            const routeId = await withResolverTimeout(
              options.mcpHttpProxyService.registerRoute({
                ...buildMcpProxyRouteScope(options, routeKey),
                serverId: pluginServer.definition.id,
                configId: pluginServer.config.id,
                displayName: `${plugin.pluginName}/${serverName}`,
                upstreamUrl,
                headers: pluginServer.headers,
                oauthEnabled: pluginServer.definition.oauth !== undefined,
                oauthRequired: forceOAuth,
                oauthDefinition: pluginServer.definition,
                oauthConfig: pluginServer.config,
              }),
              proxyOperationTimeoutMs(options),
              `Registering MCP proxy route for "${plugin.pluginName}/${serverName}"`,
            );
            try {
              result[resolvedName] = {
                type: 'http',
                url: options.mcpHttpProxyService.getProxyUrl(routeId),
                headers: undefined,
                ...(codexPurpose && typeof rawValue.enabled === 'boolean'
                  ? { enabled: rawValue.enabled }
                  : {}),
                ...(codexPurpose ? buildCodexMcpToolPolicy(rawValue) : {}),
              };
            } catch (error) {
              options.mcpHttpProxyService.unregisterRoute(routeId);
              throw error;
            }
            continue;
          } catch (error: unknown) {
            warnings.push(
              `Plugin MCP server "${plugin.marketplaceId}/${plugin.pluginName}:${serverName}" could not be proxied: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`,
            );
            if (!directFallbackAllowed) {
              const warn = forceOAuth
                ? warnOAuthHttpMcpSkipped
                : warnUnverifiedHttpMcpSkipped;
              warn(
                warnings,
                `${plugin.marketplaceId}/${plugin.pluginName}:${serverName}`,
                'the local proxy could not be configured',
              );
              continue;
            }
            if (hasProtectedHttpHeaders(resolvedHeaders.headers)) {
              warnProtectedHttpMcpSkipped(
                warnings,
                `${plugin.marketplaceId}/${plugin.pluginName}:${serverName}`,
                'the local proxy could not be configured',
              );
              continue;
            }
          }
        }

        if (!context.proxyAvailable) {
          if (!directFallbackAllowed) {
            const warn = forceOAuth
              ? warnOAuthHttpMcpSkipped
              : warnUnverifiedHttpMcpSkipped;
            warn(
              warnings,
              `${plugin.marketplaceId}/${plugin.pluginName}:${serverName}`,
              'the local proxy is not available in this context',
            );
            continue;
          }
          if (hasProtectedHttpHeaders(resolvedHeaders.headers)) {
            warnProtectedHttpMcpSkipped(
              warnings,
              `${plugin.marketplaceId}/${plugin.pluginName}:${serverName}`,
              'the local proxy is not available in this context',
            );
            continue;
          }
          warnHttpProxyFallbackOnce(warnings, context);
        }
      }

      result[resolvedName] = {
        type: 'http',
        url: replacePluginRoot(rawValue.url),
        headers,
        ...(codexPurpose && typeof rawValue.enabled === 'boolean'
          ? { enabled: rawValue.enabled }
          : {}),
        ...(codexPurpose ? buildCodexMcpToolPolicy(rawValue) : {}),
      };
      continue;
    }

    warnings.push(
      `Plugin MCP server "${plugin.marketplaceId}/${plugin.pluginName}:${serverName}" is invalid, skipping.`,
    );
  }

  if (!retainInherited) return { servers: result, hasMcpServers };
  let installationDigest: string;
  try {
    installationDigest = inheritedPluginInstallDigest(plugin.pluginPath);
  } catch {
    warnings.push(
      `Inherited plugin ${plugin.pluginName} could not be retained for delegates.`,
    );
    return { servers: result, hasMcpServers };
  }
  const bindings = mcpServerBindingsByName(context);
  const retainedEntries = entries.filter(({ serverName, rawValue }) => {
    if (rawValue.enabled === false) return false;
    const name = buildManagedMcpServerName({
      kind: 'plugin',
      friendlyParts: [plugin.pluginName, serverName],
      identityParts: [plugin.marketplaceId, plugin.pluginName, serverName],
    });
    return (
      Object.prototype.hasOwnProperty.call(result, name) ||
      Object.keys(result).some((key) =>
        bindings[key]?.sources.some(
          (source) =>
            source.kind === 'plugin' &&
            source.marketplaceId === plugin.marketplaceId &&
            source.pluginName === plugin.pluginName &&
            source.serverName === serverName,
        ),
      )
    );
  });
  return {
    servers: result,
    hasMcpServers,
    retained: {
      installationDigest,
      marketplaceId: plugin.marketplaceId,
      pluginName: plugin.pluginName,
      mcpServers: retainedEntries.map(({ serverName, rawValue }) => ({
        serverName,
        configDigest: inheritedPluginMcpTransportDigest(rawValue, {
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.pluginName,
          serverName,
        }),
      })),
      mcpHttpAuthPreferences: retainedEntries.flatMap(({ serverName }) => {
        const pin = authPins.get(serverName);
        return pin ? [pin] : [];
      }),
    },
  };
}

async function resolvePluginSelection(
  marketplaceId: string,
  pluginName: string,
  marketplaces: readonly MarketplaceInfo[],
  warnings: string[],
  installExternalPlugins: boolean,
  purpose: ResolvePluginsOptions['purpose'],
  codexCompatDisabledKeys: ReadonlySet<string>,
): Promise<PluginResolvedPath | null> {
  const marketplace = marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) {
    warnings.push(`Marketplace "${marketplaceId}" not found.`);
    return null;
  }

  const pluginInfo = marketplace.plugins.find(
    (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
  );
  if (!pluginInfo) {
    warnings.push(
      `Plugin "${pluginName}" not found in marketplace "${marketplaceId}".`,
    );
    return null;
  }

  const facets = getPluginFacets(pluginInfo, marketplace);
  const codexPurpose = isCodexPluginResolutionPurpose(purpose);
  if (!codexPurpose) {
    if (facets.claude) {
      const pluginPath = await resolveFacetPath(
        pluginInfo,
        facets.claude,
        marketplace,
        warnings,
        installExternalPlugins,
      );
      if (!pluginPath) {
        return null;
      }

      return {
        pluginPath,
        pluginName: facets.claude.name,
        marketplaceId,
        category: facets.claude.category ?? pluginInfo.category ?? '',
        provider: 'claude',
        mode: 'native',
      };
    }

    if (facets.codex) {
      // Don't auto-install Codex-native plugins during a Claude session; only
      // surface MCP servers from already-installed plugins.
      const warningCount = warnings.length;
      const pluginPath = await resolveFacetPath(
        pluginInfo,
        facets.codex,
        marketplace,
        warnings,
        false,
      );
      if (!pluginPath) {
        if (warnings.length === warningCount) {
          warnings.push(
            `Codex-native plugin "${pluginName}" in marketplace "${marketplaceId}" has no verified install location.`,
          );
        }
        return null;
      }

      return {
        pluginPath,
        pluginName: facets.codex.name,
        marketplaceId,
        category: facets.codex.category ?? pluginInfo.category ?? '',
        provider: 'codex',
        mode: 'native',
      };
    }

    warnings.push(
      `Plugin "${pluginName}" in marketplace "${marketplaceId}" is not available for Claude.`,
    );
    return null;
  }

  const nativeWarnings: string[] = [];
  if (facets.codex) {
    const pluginPath = await resolveFacetPath(
      pluginInfo,
      facets.codex,
      marketplace,
      nativeWarnings,
      installExternalPlugins,
    );
    if (pluginPath) {
      return {
        pluginPath,
        pluginName: facets.codex.name,
        marketplaceId,
        category: facets.codex.category ?? pluginInfo.category ?? '',
        provider: 'codex',
        mode: 'native',
        primaryAuthPluginPath: await resolvePluginAuthPrimaryPath(
          pluginInfo,
          marketplace,
          'codex',
          warnings,
        ),
      };
    }

    if (!facets.claude) {
      warnings.push(...nativeWarnings);
      if (nativeWarnings.length === 0) {
        warnings.push(
          `Codex-native plugin "${pluginName}" in marketplace "${marketplaceId}" has no verified install location.`,
        );
      }
      return null;
    }
  } else if (!facets.claude) {
    warnings.push(
      `Plugin "${pluginName}" in marketplace "${marketplaceId}" is not available for Codex.`,
    );
    return null;
  }

  if (
    codexCompatDisabledKeys.has(
      buildCodexCompatDisabledKey(marketplaceId, pluginName),
    )
  ) {
    warnings.push(
      `Plugin "${pluginName}" in marketplace "${marketplaceId}" has Codex compatibility disabled; skipping for Codex.`,
    );
    return null;
  }

  const pluginPath = await resolveFacetPath(
    pluginInfo,
    facets.claude,
    marketplace,
    warnings,
    installExternalPlugins,
  );
  if (!pluginPath) {
    return null;
  }

  if (facets.codex) {
    warnings.push(
      `Codex-native plugin "${pluginName}" in marketplace "${marketplaceId}" has a stale install location; using Claude compatibility fallback. ${nativeWarnings.join(
        ' ',
      )}`.trim(),
    );
  }

  return {
    pluginPath,
    pluginName: facets.claude.name,
    marketplaceId,
    category: facets.claude.category ?? pluginInfo.category ?? '',
    provider: 'claude',
    mode: 'compat',
  };
}

/** Fail configured prompt mentions closed using the same path and provider checks as chat selection. */
export async function isConfiguredPromptPluginUsable(
  selection: { marketplaceId: string; pluginName: string },
  marketplaces: readonly MarketplaceInfo[],
  providerType: AgentProviderType,
): Promise<boolean> {
  const preferences = await readPreferencesFile();
  const resolved = await resolvePluginSelection(
    selection.marketplaceId,
    selection.pluginName,
    marketplaces,
    [],
    false,
    providerType === 'codex'
      ? 'codex-session'
      : providerType === 'opencode'
        ? 'opencode-session'
        : providerType === 'copilot'
          ? 'copilot-session'
          : providerType === 'cursor'
            ? 'cursor-session'
            : 'claude-session',
    new Set(preferences.codexCompatDisabledPlugins ?? []),
  );
  return resolved !== null;
}

export async function resolvePluginInfoPath(
  plugin: PluginInfo,
  marketplace: MarketplaceInfo,
  warnings: string[],
  installExternalPlugins: boolean,
  provider?: 'claude' | 'codex',
): Promise<string | null> {
  const facets = getPluginFacets(plugin, marketplace);
  if (provider) {
    const facet = facets[provider];
    if (!facet) {
      warnings.push(`Plugin "${plugin.name}" has no native ${provider} facet.`);
      return null;
    }
    return resolveFacetPath(
      plugin,
      facet,
      marketplace,
      warnings,
      installExternalPlugins,
    );
  }
  if (facets.claude) {
    return resolveFacetPath(
      plugin,
      facets.claude,
      marketplace,
      warnings,
      installExternalPlugins,
    );
  }
  if (facets.codex) {
    return resolveFacetPath(plugin, facets.codex, marketplace, warnings, false);
  }

  if (plugin.cachePath && fs.existsSync(plugin.cachePath)) {
    return plugin.cachePath;
  }

  if (plugin.sourcePath && !plugin.externalSource) {
    const resolved = path.resolve(
      marketplace.installLocation,
      plugin.sourcePath,
    );
    if (!isPathInside(marketplace.installLocation, resolved)) {
      warnings.push(
        `Plugin "${plugin.name}" path escapes marketplace root, skipping.`,
      );
      return null;
    }
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    warnings.push(`Local plugin path does not exist: ${resolved}`);
    return null;
  }

  if (plugin.externalSource?.url) {
    if (!installExternalPlugins) {
      warnings.push(
        `External plugin "${plugin.name}" is not installed locally; skipping. Install or update it from the plugin catalog before using it in chat.`,
      );
      return null;
    }

    try {
      const result = await installPlugin(
        marketplace.id,
        plugin.name,
        plugin.externalSource.url,
      );
      if (result.success && result.data?.cachePath) {
        return result.data.cachePath;
      }

      warnings.push(
        `Failed to install external plugin "${plugin.name}": ${
          result.success ? 'no cache path' : result.error
        }`,
      );
    } catch (error: unknown) {
      warnings.push(
        `Error installing external plugin "${plugin.name}": ${String(error)}`,
      );
    }
  }

  return null;
}

function getPluginFacets(
  plugin: PluginInfo,
  marketplace: MarketplaceInfo,
): PluginInfo['facets'] {
  if (plugin.facets) {
    return plugin.facets;
  }

  const legacy = plugin as PluginInfo & {
    externalSource?: { url?: string; sha?: string } | null;
    cachePath?: string | null;
    cachedAt?: string | null;
  };
  const legacyInstallLocation =
    legacy.cachePath ??
    (plugin.sourcePath && !legacy.externalSource
      ? path.resolve(marketplace.installLocation, plugin.sourcePath)
      : '');
  return {
    claude: {
      provider: 'claude',
      mode: 'native',
      name: plugin.name,
      description: plugin.description ?? '',
      version: plugin.version ?? '',
      author: plugin.author ?? '',
      category: plugin.category ?? '',
      homepage: plugin.homepage ?? '',
      installLocation: legacyInstallLocation,
      sourcePath: plugin.sourcePath ?? '',
      externalSource: legacy.externalSource?.url
        ? {
            source: 'github',
            url: legacy.externalSource.url,
            sha: legacy.externalSource.sha,
          }
        : undefined,
      cachePath: legacy.cachePath ?? undefined,
      cachedAt: legacy.cachedAt ?? undefined,
      details: plugin.details,
    },
  };
}

async function resolveFacetPath(
  plugin: PluginInfo,
  facet: PluginProviderFacet,
  marketplace: MarketplaceInfo,
  warnings: string[],
  installExternalPlugins: boolean,
): Promise<string | null> {
  const externalSource = facet.externalSource;
  const externalSourceUrl =
    externalSource &&
    typeof externalSource === 'object' &&
    'url' in externalSource
      ? externalSource.url
      : undefined;

  if (facet.cachePath && fs.existsSync(facet.cachePath)) {
    return facet.cachePath;
  }

  if (
    !externalSourceUrl &&
    facet.installLocation &&
    fs.existsSync(facet.installLocation)
  ) {
    return facet.installLocation;
  }

  if (facet.sourcePath) {
    const resolved = path.isAbsolute(facet.sourcePath)
      ? path.resolve(facet.sourcePath)
      : path.resolve(marketplace.installLocation, facet.sourcePath);
    if (
      !path.isAbsolute(facet.sourcePath) &&
      !isPathInside(marketplace.installLocation, resolved)
    ) {
      warnings.push(
        `Plugin "${plugin.name}" path escapes marketplace root, skipping.`,
      );
      return null;
    }
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  if (externalSourceUrl) {
    if (!installExternalPlugins) {
      warnings.push(
        `External plugin "${plugin.name}" is not installed locally; skipping. Install or update it from the plugin catalog before using it in chat.`,
      );
      return null;
    }

    try {
      const result = await installPlugin(
        marketplace.id,
        plugin.name,
        externalSourceUrl,
      );
      if (result.success && result.data?.cachePath) {
        return result.data.cachePath;
      }
      warnings.push(
        `Failed to install external plugin "${plugin.name}": ${
          result.success ? 'no cache path' : result.error
        }`,
      );
    } catch (error: unknown) {
      warnings.push(
        `Error installing external plugin "${plugin.name}": ${String(error)}`,
      );
    }
  }

  warnings.push(
    `${MISSING_PLUGIN_PATH_WARNING_PREFIX} ${
      facet.sourcePath || facet.installLocation
    }`,
  );
  return null;
}

/**
 * Projects a Cursor session's selection into the skills and commands its
 * private root will hold. Standalone skills are assigned ids first, then each
 * plugin's skills and commands, so a plugin member never displaces a skill the
 * user installed by name. Plugin commands are rewritten into the markdown
 * shape the pinned CLI parses (see `renderCursorCommandMarkdown`).
 */
/** One plugin member as a Cursor session loads it, in id-assignment order. */
export type CursorPluginMember =
  | { kind: 'plugin_skill'; name: string; skill: ClaudeSkillSource }
  | { kind: 'plugin_command'; name: string; command: PluginCommandSource };

/**
 * The members of an installed plugin a Cursor session loads, read from disk
 * and in the order ids are assigned. The inventory resolves a selection
 * against this same listing so the token it inserts is the id the chat root
 * will hold. The member rule itself is `@canopy/plugin-interop`'s
 * `cursor-support`, which the surfaces that show per-harness support read
 * over catalog facets; the resolver test checks the two agree.
 */
export function discoverCursorPluginMembers(
  pluginPath: string,
  provider: PluginResolvedPath['provider'],
  warnings?: string[],
): CursorPluginMember[] {
  const manifest = loadPluginManifest(pluginPath, provider);
  const members: CursorPluginMember[] = discoverPluginSkills(
    pluginPath,
    manifest,
    warnings,
  ).map((skill) => ({ kind: 'plugin_skill', name: skill.name, skill }));
  if (cursorLoadsPluginMemberKind(provider, 'commands'))
    for (const command of discoverPluginCommandSources(
      pluginPath,
      manifest,
      warnings,
    ))
      members.push({ kind: 'plugin_command', name: command.name, command });
  return sortCursorPluginMembers(members);
}

export function buildCursorCapabilityProjection(
  standaloneSkills: readonly {
    ref: { sourceId: string; skillName: string };
    sourceDir: string;
    description: string;
    userInvocable?: boolean;
  }[],
  plugins: readonly PluginResolvedPath[],
  pluginsWithMcpServers: ReadonlySet<string>,
  cursorNotices: string[],
  warnings: string[],
  inherited?: InheritedCursorCapabilities,
): CursorCapabilityProjection {
  const sources: CursorInvocationSource[] = [];
  const skills: {
    source: CursorInvocationSource;
    sourceDir: string;
    description: string;
    label: string;
    userInvocable: boolean;
  }[] = [];
  const commands: {
    source: CursorInvocationSource;
    markdown: (id: string) => string;
    description: string;
    label: string;
  }[] = [];
  for (const skill of standaloneSkills) {
    const source: CursorInvocationSource = { kind: 'skill', ...skill.ref };
    sources.push(source);
    skills.push({
      source,
      sourceDir: skill.sourceDir,
      description: skill.description,
      label: skill.ref.skillName,
      userInvocable: skill.userInvocable !== false,
    });
  }
  for (const plugin of plugins) {
    // A member root the plugin declares but that resolves outside it is a
    // Cursor-only gap (the same plugin still loads elsewhere): tell the user.
    const memberWarnings: string[] = [];
    const members = discoverCursorPluginMembers(
      plugin.pluginPath,
      plugin.provider,
      memberWarnings,
    );
    warnings.push(...memberWarnings);
    cursorNotices.push(...memberWarnings);
    if (
      scanPluginMods(
        plugin.pluginPath,
        loadPluginManifest(plugin.pluginPath, plugin.provider),
      ).length > 0
    ) {
      cursorNotices.push(
        `Plugin "${plugin.pluginName}" has a mod. Its mod runs in Claude chats only.`,
      );
    }
    for (const member of members) {
      const source: CursorInvocationSource = {
        kind: member.kind,
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.pluginName,
        memberName: member.name,
      };
      sources.push(source);
      const label = `${plugin.pluginName}:${member.name}`;
      if (member.kind === 'plugin_skill') {
        skills.push({
          source,
          sourceDir: member.skill.sourceDir,
          description: member.skill.description,
          label,
          userInvocable: member.skill.metadata['user-invocable'] !== false,
        });
        continue;
      }
      const { command } = member;
      const body = parseFrontmatterAndBody(command.content).body;
      commands.push({
        source,
        markdown: (id) =>
          renderCursorCommandMarkdown({
            id,
            description: command.description,
            body,
          }),
        description: command.description,
        label,
      });
    }
    if (
      !pluginsWithMcpServers.has(plugin.pluginPath) &&
      members.length === 0 &&
      memberWarnings.length === 0
    ) {
      // The picker lets every plugin through; one that carries nothing a
      // Cursor session loads is reported once rather than silently ignored.
      cursorNotices.push(
        `Plugin "${plugin.pluginName}" in marketplace "${plugin.marketplaceId}" declares no MCP servers, skills, or commands, so it adds nothing to a Cursor session.`,
      );
    }
  }
  // The user's own home-folder entries come last: a Canopy selection keeps
  // its id on a collision and the inherited copy takes the suffix. An
  // inherited directory that IS a selected skill's directory adds nothing.
  const selectedSkillDirs = new Set(skills.map((skill) => skill.sourceDir));
  for (const skill of inherited?.skills ?? []) {
    if (selectedSkillDirs.has(skill.sourceDir)) continue;
    // `satisfies` keeps the literal `kind`, which the label helper needs;
    // an annotation of the whole union would widen it. A cached Cursor
    // plugin member carries its plugin, which is part of its identity.
    const source =
      skill.plugin === undefined
        ? ({
            kind: 'inherited_skill',
            origin: skill.origin,
            name: skill.name,
          } satisfies CursorInvocationSource)
        : ({
            kind: 'inherited_skill',
            origin: skill.origin,
            name: skill.name,
            plugin: skill.plugin,
          } satisfies CursorInvocationSource);
    sources.push(source);
    skills.push({
      source,
      sourceDir: skill.sourceDir,
      description: skill.description,
      label: inheritedCursorEntryLabel(source),
      userInvocable: skill.userInvocable,
    });
  }
  for (const command of inherited?.commands ?? []) {
    const source =
      command.plugin === undefined
        ? ({
            kind: 'inherited_command',
            origin: command.origin,
            name: command.name,
          } satisfies CursorInvocationSource)
        : ({
            kind: 'inherited_command',
            origin: command.origin,
            name: command.name,
            plugin: command.plugin,
          } satisfies CursorInvocationSource);
    sources.push(source);
    commands.push({
      source,
      markdown: () => command.markdown,
      description: command.description,
      label: inheritedCursorEntryLabel(source),
    });
  }
  const ids = assignCursorInvocationIds(sources);
  const idFor = (source: CursorInvocationSource): string =>
    ids.get(cursorInvocationKey(source)) ?? '';
  return {
    skills: skills.map((skill) => ({
      id: idFor(skill.source),
      source: skill.source,
      sourceDir: skill.sourceDir,
      description: skill.description,
      label: skill.label,
      userInvocable: skill.userInvocable,
    })),
    commands: commands.map((command) => {
      const id = idFor(command.source);
      return {
        id,
        markdown: command.markdown(id),
        source: command.source,
        description: command.description,
        label: command.label,
      };
    }),
  };
}

function readSkillDescription(skillMdPath: string): string {
  return readSkillMetadata(skillMdPath).description;
}

function readSkillMetadata(skillMdPath: string): {
  description: string;
  userInvocable: boolean;
} {
  const skillMd = safeReadText(skillMdPath);
  const frontmatter = skillMd
    ? parseFrontmatter<ParsedFrontmatter>(skillMd)
    : undefined;
  return {
    description: frontmatter?.description?.trim() ?? '',
    userInvocable: frontmatter?.['user-invocable'] !== false,
  };
}

function deduplicateName(
  baseName: string,
  usedNames: Map<string, number>,
): string {
  if (!usedNames.has(baseName)) {
    usedNames.set(baseName, 1);
    return baseName;
  }

  const counter = usedNames.get(baseName) ?? 1;
  usedNames.set(baseName, counter + 1);
  return `${baseName}-${counter}`;
}

interface SelectedCodexPlugin {
  pluginName: string;
  category: string;
  cacheDir: string;
}

function selectUniqueCapabilityPlugins(
  plugins: readonly SelectedCodexPlugin[],
  warnings: string[],
): SelectedCodexPlugin[] {
  const seen = new Set<string>();
  const result: SelectedCodexPlugin[] = [];

  for (const plugin of plugins) {
    const key = plugin.pluginName.toLowerCase();
    if (seen.has(key)) {
      warnings.push(
        `Skipping duplicate Codex compatibility plugin "${plugin.pluginName}".`,
      );
      continue;
    }
    seen.add(key);
    result.push(plugin);
  }

  return result;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function getDirectorySymlinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

export {
  cleanupChatSkillPluginDir,
  cleanupWorktreeChatPluginDirs,
} from './plugin-cleanup';
