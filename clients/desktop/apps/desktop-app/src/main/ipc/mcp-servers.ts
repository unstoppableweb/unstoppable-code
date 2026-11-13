import { z } from 'zod';
import { parseMcpExtraHeaders } from '@canopy/protocol/mcp-servers';
import {
  accountMcpConnectionsEnabled,
  mergeAccountMcpInventory,
  withAccountMcpInventory,
} from '../mcp/account-catalog';
import { findAccountMcpRow } from '@canopy/ui-app/capability/accountMcpRows';
import {
  accountMcpConnectionForRef,
  isCustomAccountMcpServerKey,
  legacyAccountMcpConnectionId,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { subscribeCanopyCloudAccountChanges } from '../lib/canopy-cloud-account-store';
import {
  listAccountMcpConnections,
  startAccountMcpConnection,
  getAccountMcpConnection,
  disconnectAccountMcpConnection,
  setAccountMcpConnectionTools,
  listAccountMcpUpstreamTools,
  awaitAccountMcpConnection,
  invalidateAccountMcpConnections,
  removeAccountMcpConnection,
  updateAccountMcpConnection,
} from '../canopy-cloud/mcp-connections';
import { rewriteMcpServerRefs } from '../mcp/server-ref-rewrite';
import { getMcpHttpAuthDefault } from '@canopy/execution-engine/lib/mcp-http-auth';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import {
  readMcpAccountIndexEntry,
  withAccountMcpProxy,
} from '../mcp/account-routing';
import { spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile, readdir } from 'node:fs/promises';
import { McpConfigRepository } from '../mcp/config-repository';
import {
  McpConfigNotFoundError,
  McpConfigStateError,
} from '../mcp/config-repository-format';
import type { BrowserWindow } from 'electron';
import { DEFAULT_MCP_HTTP_AUTH_HANDLER } from '@canopy/desktop-shared/types';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import type {
  AccountMcpConnectionSummary,
  SaveMcpServerRequest,
  ClearMcpOAuthTokenRequest,
  ListDetectedMcpServersRequest,
  McpProxyState,
  McpServerData,
  McpServerFile,
  McpServerFileView,
  McpServerIndexEntry,
  McpServersIndexFile,
  McpServerConfigSummary,
  McpServerHealthCheckResult,
  McpServerTestConnectionResult,
  McpServerToolsCacheEntry,
  AccountMcpConnectionFailure,
  AccountMcpConnection,
  AccountMcpUpstreamTool,
  RemoveAccountMcpConnectionResponse,
  RewriteMcpServerRefsRequest,
  RewriteMcpServerRefsResponse,
  StartAccountMcpConnectionResponse,
  McpServerDefinitionData,
  McpServerConfigData,
  StartMcpOAuthLoginRequest,
  StartMcpOAuthPluginTarget,
  McpHttpAuthHandler,
  ProviderConnectorProvider,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  AccountMcpConnectionError,
  normalizeCuratedMetadata,
  normalizeHttpAuthHandler,
} from '@canopy/execution-engine/types/mcp-servers';
import { sanitizeEnvVars } from '@canopy/execution-engine/lib/mcp-security';
import {
  projectMcpServerData,
  projectMcpServerFile,
  resolveAccountSecretInputs,
  resolveMcpServerInput,
} from '../mcp/server-secret-view';
import { StoredSecretError } from '../lib/stored-secrets';
import { getMcpServersIndexFilePath, getMcpServerFilePath } from '../lib/paths';
import {
  readPreferencesFile,
  writePreferencesFile,
} from '../lib/preferences-store';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { resumeChatsAfterMcpOAuthSuccess } from '../lib/auth-failure-resume';
import { setMcpOAuthSettledListener } from '../mcp/oauth-client';
import { getMcpOAuthCoordinator } from '../mcp/oauth-coordinator';
import {
  clearMcpOAuthToken,
  getMcpOAuthAuthStatusForDefinition,
  getMcpOAuthTokenRevision,
  setMcpOAuthTokensChangedListener,
} from '../mcp/oauth-token-store';
import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import { sendToAllWindows } from '../lib/window-send';
import { listDetectedMcpServersForSelections } from '../plugins/mcp-inventory';
import {
  buildPluginHttpMcpServerForAuth,
  type PluginHttpMcpServerForAuth,
  type PluginMcpAuthIdentity,
} from '../plugins/plugin-mcp-auth';
import {
  pluginMcpOAuthProbeInputs,
  standaloneMcpOAuthProbeInputs,
} from '../mcp/oauth-probe-inputs';
import { probeMcpHttpOAuthRequirement } from '../mcp/oauth-probe';
import { loadMarketplaces } from '../plugins/plugin-service';
import {
  readPluginMcpAuthEntries,
  resolvePluginAuthPrimaryPath,
  resolvePluginInfoPath,
} from '../plugins/plugin-resolver';
import { openExternalGuarded } from '../lib/open-external';
import {
  PROVIDER_CONNECTOR_MANAGE_URLS,
  listAdvertisedProviderConnectors,
} from '../mcp/provider-connectors';
import { registerIpcHandler } from './register';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import {
  IdentifierValidationError,
  validateId,
  validateMcpServerRefId,
} from '../lib/validation';
import {
  listCuratedMcpServers,
  refreshCuratedMcpServers,
} from '../mcp/curated-catalog';
import { resolveRemoteImageDataUrl } from '../mcp/remote-image-cache';
import { refreshProjectedPortalMcpServers } from '../portal/adapters/mcp-adapter';
import {
  MCP_ACCEPT_HEADER,
  McpToolDiscoveryError,
  discoverHttpTools,
  getMcpToolsCacheEntry,
  mcpToolsSourceFingerprint,
  mergeConfigIntoDefinition,
  withStoredOAuthAuthorization,
  writeMcpToolsCacheEntry,
  fetchWithSafeRedirects,
} from '../mcp/tool-discovery';
import {
  listMcpServerStatuses,
  clearMcpServerAuthHealthCache,
  getMcpServerHealth,
  getMcpServerHealthGeneration,
  recordMcpServerHealth,
} from '../mcp/connection-status';
import { refreshCodexSessionsAfterMcpOAuth } from '../agents/session-manager';
import { MCP_ACCOUNT_RECONNECT_DETAIL } from '../mcp/account-copy';
import {
  captureMcpRefRewriteOutcome,
  recordMcpRefRewriteFailure,
  inMcpRefRewritePhase,
  unwrapMcpRefRewriteOutcome,
  type McpRefRewriteOutcome,
} from '../mcp/server-ref-rewrite-outcome';

const SAFE_ID_RE = /^[a-f0-9-]+$/;

const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    customUrl: z
      .string()
      .url()
      .max(4096)
      .refine(
        (url): boolean => new URL(url).protocol === 'https:',
        'Use an HTTPS URL.',
      )
      .optional(),
    headers: z.unknown().optional(),
    bearerToken: z.string().min(1).max(16384).nullable().optional(),
    expectedAccountId: z.string().trim().min(1).max(256).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value): boolean =>
      value.displayName !== undefined ||
      value.customUrl !== undefined ||
      value.headers !== undefined ||
      value.bearerToken !== undefined ||
      value.enabled !== undefined,
    'Nothing to update.',
  );

const serverRefIdSchema = z.string().max(256);
const configRefIdSchema = z.string().max(128);
const rewriteRefsSchema = z
  .object({
    from: z
      .array(
        z
          .object({
            serverId: serverRefIdSchema,
            configId: configRefIdSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    to: z
      .object({ serverId: serverRefIdSchema, configId: configRefIdSchema })
      .strict(),
    retire: z
      .object({ serverId: z.string(), fingerprint: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The rewrite request with every id checked: device ids, curated keys and
 * config ids by `validateId`, and `custom:<uuid>` keys and legacy
 * `account:<connectionId>` refs by `validateMcpServerRefId`.
 */
function parseRewriteRefsRequest(raw: unknown): RewriteMcpServerRefsRequest {
  const request = rewriteRefsSchema.parse(raw);
  for (const ref of request.from) {
    validateMcpServerRefId(ref.serverId, 'MCP server id');
    if (ref.configId !== undefined) validateId(ref.configId, 'MCP config id');
  }
  validateMcpServerRefId(request.to.serverId, 'MCP server id');
  validateId(request.to.configId, 'MCP config id');
  if (request.retire) {
    validateId(request.retire.serverId, 'MCP server id');
    if (!SAFE_ID_RE.test(request.retire.serverId)) {
      throw recordMcpRefRewriteFailure(
        new Error(`Invalid MCP server id: ${request.retire.serverId}`),
        'validation',
        'invalidRef',
      );
    }
    if (
      !request.from.some((ref) => ref.serverId === request.retire?.serverId)
    ) {
      throw recordMcpRefRewriteFailure(
        new Error('A retired MCP server must be one of the rewritten refs'),
        'validation',
        'retireNotRewritten',
      );
    }
  }
  return request;
}

export async function rewriteMcpServerRefsOutcome(
  raw: unknown,
): Promise<McpRefRewriteOutcome> {
  return captureMcpRefRewriteOutcome(async () => {
    let request: RewriteMcpServerRefsRequest;
    try {
      request = parseRewriteRefsRequest(raw);
    } catch (error) {
      recordMcpRefRewriteFailure(
        error,
        'validation',
        error instanceof z.ZodError ||
          error instanceof IdentifierValidationError
          ? 'invalidRef'
          : undefined,
      );
      throw error;
    }
    return request.retire
      ? removeServerAndOAuthTokensAfterMovingRefs(request, request.retire)
      : rewriteMcpServerRefs(request);
  });
}

const configRepository = new McpConfigRepository(
  { index: getMcpServersIndexFilePath, server: getMcpServerFilePath },
  { mkdir, writeFile, unlink, readFile, readdir },
);

/** Serialized device deletion; cloud connections retain their own credentials. */
export async function deleteMcpServer(id: string): Promise<void> {
  if (!id || !SAFE_ID_RE.test(id)) throw new Error('Invalid MCP server id.');
  await configRepository.withServerMutation(id, () =>
    deleteMcpServerAndOAuthTokens(id),
  );
}

async function deleteMcpServerAndOAuthTokens(id: string): Promise<void> {
  const configIds = await inMcpRefRewritePhase('retirementRead', () =>
    readServer(id)
      .then(({ server }): string[] =>
        server.configs.map((config): string => config.id),
      )
      .catch(
        async (): Promise<string[]> =>
          (await readIndex()).servers
            .find((server) => server.id === id)
            ?.configs.map((config) => config.id) ?? [],
      ),
  );
  // Sign-ins belong to the device server; a bound cloud connection keeps
  // its own and stays in the cloud account.
  await inMcpRefRewritePhase('tokenClear', async () => {
    const cleanup = await Promise.allSettled(
      configIds.map((configId) => clearMcpOAuthToken(id, configId)),
    );
    const failed = cleanup.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
  // Cleanup failure retains config identities for retries.
  await configRepository.remove(id, inMcpRefRewritePhase);
  await notifyConfigIndexChanged();
  await refreshProjectedPortalMcpServers().catch((error: unknown) => {
    logMainProcessError('Portal MCP projection refresh failed', error);
  });
}

/**
 * Moves references and retires the device server as one step: nothing is
 * rewritten or removed unless the server file is still the one the caller saw.
 */
async function removeServerAndOAuthTokensAfterMovingRefs(
  request: RewriteMcpServerRefsRequest,
  retire: NonNullable<RewriteMcpServerRefsRequest['retire']>,
): Promise<RewriteMcpServerRefsResponse> {
  return configRepository.withServerMutation(retire.serverId, async () => {
    const current = await inMcpRefRewritePhase('retirementGuard', () =>
      readServer(retire.serverId).then(
        async ({ server }) =>
          (await resolveStandaloneHttpHandler(server.definition)) === 'canopy'
            ? // The caller fingerprints the reply it saw, which carries
              // references; any save also moves `updatedAt`.
              stableStringify(projectMcpServerData(server))
            : undefined,
        (): undefined => undefined,
      ),
    );
    if (current !== retire.fingerprint) {
      return {
        globalDefaults: false,
        workspaces: 0,
        chats: 0,
        retired: 'changed',
      };
    }
    const result = await rewriteMcpServerRefs({
      from: request.from,
      to: request.to,
    });
    const stillCurrent = await inMcpRefRewritePhase('retirementGuard', () =>
      readServer(retire.serverId).then(
        ({ server }) =>
          stableStringify(projectMcpServerData(server)) === retire.fingerprint,
        (): boolean => false,
      ),
    );
    if (!stillCurrent) return { ...result, retired: 'changed' };
    await deleteMcpServerAndOAuthTokens(retire.serverId);
    return { ...result, retired: 'removed' };
  });
}

// ---------------------------------------------------------------------------
// Security — command allowlist and dangerous flag detection
// ---------------------------------------------------------------------------

const SAFE_COMMANDS = new Set([
  'npx',
  'npm',
  'node',
  'python',
  'python3',
  'uv',
  'uvx',
]);

const DANGEROUS_FLAGS = new Set([
  '--eval',
  '-e',
  '-c',
  '--exec',
  '--import',
  '-p',
  '--print',
  '--input-type=module',
  '--experimental-loader',
  '--require',
  '-r',
]);

const SHELL_METACHARACTERS = [
  '&',
  '|',
  '>',
  '<',
  '^',
  '%',
  ';',
  '$',
  '`',
  '\n',
  '\r',
];

/**
 * Validate that a command is in the safe allowlist.
 * Rejects commands containing path separators.
 */
export function isCommandSafe(command: string | undefined): boolean {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\')) return false;
  return SAFE_COMMANDS.has(command);
}

/**
 * Validate that args don't contain dangerous interpreter flags or shell metacharacters.
 */
export function areArgsSafe(args: string[] | undefined): boolean {
  if (!args || args.length === 0) return true;
  if (args.some((arg) => DANGEROUS_FLAGS.has(arg))) return false;
  if (
    args.some((arg) => SHELL_METACHARACTERS.some((char) => arg.includes(char)))
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readIndex(): Promise<McpServersIndexFile> {
  return configRepository.readIndex();
}

async function notifyConfigIndexChanged(): Promise<void> {
  // Publication already succeeded; notification errors must not invite a replay.
  try {
    notifyDesktopInventoryChanged(['mcp_servers']);
    const { notifyInstalledItemsChanged } =
      await import('../installed-items/installed-item-events');
    notifyInstalledItemsChanged();
  } catch (error) {
    logMainProcessError('MCP inventory notification failed', error);
  }
}

/**
 * Read and normalize one persisted standalone MCP server file.
 *
 * Exported for the read-only portal catalog service
 * (`services/plugin-catalog-service.ts`), which REDACTS the result before it
 * leaves the desktop (auth tokens, env var values, OAuth secrets, header
 * values are stripped). Callers must never forward the raw `McpServerFile`
 * across a remote boundary. `getMcpServerFilePath` validates the id, so a
 * hostile id cannot escape the mcp-servers directory.
 */
export function readServer(id: string): Promise<McpServerFile> {
  return configRepository.readServer(id);
}

function validatePluginOAuthTarget(target: StartMcpOAuthPluginTarget): void {
  if (
    target.provider !== undefined &&
    target.provider !== 'claude' &&
    target.provider !== 'codex'
  ) {
    throw new Error('Invalid plugin provider.');
  }
  if (target.marketplaceId.trim().length === 0) {
    throw new Error('Invalid plugin marketplace id.');
  }
  if (target.pluginName.trim().length === 0) {
    throw new Error('Invalid plugin name.');
  }
  if (target.serverName.trim().length === 0) {
    throw new Error('Invalid plugin MCP server name.');
  }
}

async function resolvePluginOAuthTarget(
  target: StartMcpOAuthPluginTarget,
): Promise<
  PluginHttpMcpServerForAuth & {
    identity: PluginMcpAuthIdentity;
    rawValue: Record<string, unknown>;
  }
> {
  validatePluginOAuthTarget(target);
  const cacheResult = await loadMarketplaces();
  const marketplaces =
    cacheResult.success && cacheResult.data
      ? cacheResult.data.marketplaces
      : [];
  const marketplace = marketplaces.find(
    (entry) => entry.id === target.marketplaceId,
  );
  if (!marketplace) {
    throw new Error(`Marketplace "${target.marketplaceId}" not found.`);
  }

  const plugin = marketplace.plugins.find(
    (entry) => entry.name === target.pluginName,
  );
  if (!plugin) {
    throw new Error(
      `Plugin "${target.pluginName}" not found in marketplace "${target.marketplaceId}".`,
    );
  }

  const warnings: string[] = [];
  const pluginPath = await resolvePluginInfoPath(
    plugin,
    marketplace,
    warnings,
    true,
    target.provider,
  );
  if (!pluginPath) {
    throw new Error(warnings[0] ?? 'Plugin is not available locally.');
  }

  const primaryPath = await resolvePluginAuthPrimaryPath(
    plugin,
    marketplace,
    target.provider,
    warnings,
  );
  const entry = (
    await readPluginMcpAuthEntries(
      pluginPath,
      target.marketplaceId,
      target.pluginName,
      target.provider,
      primaryPath,
    )
  ).find((entry) => entry.serverName === target.serverName);
  if (!entry) {
    throw new Error(
      `MCP server "${target.serverName}" not found in plugin "${target.pluginName}".`,
    );
  }

  const pluginServer = buildPluginHttpMcpServerForAuth(
    entry.identity,
    entry.rawValue,
    true,
  );
  if (!pluginServer) {
    throw new Error('OAuth is only supported for HTTP MCP servers.');
  }
  return {
    ...pluginServer,
    identity: entry.identity,
    rawValue: entry.rawValue,
  };
}

/**
 * Whether Connect ends here: discovery positively found no sign-in. A stored
 * token keeps inventory offering Reconnect, and a health check can see a 401
 * past an open `initialize`, so either one keeps the real flow.
 */
async function connectNeedsNoSignIn(
  probeInputs: { url: string; headers: Record<string, string> } | null,
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
): Promise<boolean> {
  if (!probeInputs) return false;
  const probe = await probeMcpHttpOAuthRequirement(
    probeInputs.url,
    probeInputs.headers,
  );
  if (probe.requirement !== 'none') return false;
  if (getMcpServerHealth(definition.id)?.status === 'needs_auth') return false;
  const auth = await getMcpOAuthAuthStatusForDefinition(definition, config);
  return auth.hasStoredToken !== true;
}

/** Non-secret parts of an HTTP server URL: never a path, query, or credentials. */
function urlIndexFields(url: string | undefined): {
  urlHost?: string;
  urlScheme?: string;
} {
  if (!url) return {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  if (!parsed.hostname) return {};
  return {
    urlHost: parsed.hostname,
    urlScheme: parsed.protocol.replace(/:$/, ''),
  };
}

function lacksUrlIndexFields(entry: McpServerIndexEntry): boolean {
  return (
    entry.type === 'http' &&
    (entry.urlHost === undefined || entry.urlScheme === undefined)
  );
}

/**
 * Index entries written before `urlHost`/`urlScheme` existed carry neither, so
 * a custom HTTPS row would never be promotable. Derive them from the stored
 * definition for just those rows and persist the result once; a complete
 * index costs nothing beyond the scan.
 */
async function readIndexWithUrlBackfill(): Promise<McpServersIndexFile> {
  let backfilled;
  try {
    backfilled = await configRepository.backfill(
      lacksUrlIndexFields,
      (server) =>
        server.definition.type === 'http'
          ? urlIndexFields(server.definition.url)
          : {},
    );
  } catch (error) {
    if (!(error instanceof McpConfigStateError)) throw error;
    // Display fallback only: the refused index is never rewritten from it.
    logMainProcessWarn('MCP index backfill refused', error.detail);
    return readIndex();
  }
  if (backfilled.changed) await notifyConfigIndexChanged();
  return backfilled.index;
}

/** The MCP index the window's list shows, account connections included. */
export async function readMcpServersIndexForPresentation(): Promise<McpServersIndexFile> {
  return withAccountMcpInventory(await readIndexWithUrlBackfill());
}

export function toIndexEntry(
  server: McpServerData,
  effectiveHttpAuthHandler: McpHttpAuthHandler = server.definition
    .httpAuthHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
): McpServerIndexEntry {
  const configs: McpServerConfigSummary[] = server.configs.map((c) => ({
    id: c.id,
    name: c.name,
    enabled: c.enabled,
  }));
  const urlFields =
    server.definition.type === 'http'
      ? urlIndexFields(server.definition.url)
      : {};
  return {
    id: server.definition.id,
    name: server.definition.name,
    description: server.definition.description,
    type: server.definition.type,
    configs,
    ...(server.definition.curated?.logoUrl
      ? { logoUrl: server.definition.curated.logoUrl }
      : {}),
    ...(server.definition.curated?.key
      ? { curatedKey: server.definition.curated.key }
      : {}),
    ...urlFields,
    ...(server.definition.type === 'http' &&
    effectiveHttpAuthHandler === 'account'
      ? { scope: 'account' as const, authHandler: 'account' as const }
      : {}),
    updatedAt: server.definition.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Health check helpers
// ---------------------------------------------------------------------------

/**
 * Merge a specific config into a definition to produce a
 * fully-resolved definition for testing purposes.
 */
function validateCommandDefinition(
  definition: McpServerDefinitionData,
  configs: McpServerConfigData[],
): void {
  if (!definition.command) {
    throw new Error('Command server command is required');
  }
  if (!isCommandSafe(definition.command)) {
    throw new Error(
      `Invalid command '${definition.command}' - not in allowlist`,
    );
  }
  if (!areArgsSafe(definition.args)) {
    throw new Error(
      'Command args contain dangerous flags or shell metacharacters',
    );
  }
  for (const config of configs) {
    if (!areArgsSafe(config.extraArgs)) {
      throw new Error(
        `Config '${config.name}' args contain dangerous flags or shell metacharacters`,
      );
    }
  }
}

function validateHttpDefinition(definition: McpServerDefinitionData): void {
  if (!definition.url?.trim()) {
    throw new Error('HTTP server URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(definition.url);
  } catch {
    throw new Error('HTTP server URL is not a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('HTTP server URL must use http:// or https://');
  }
}

function validateOAuthDefinition(definition: McpServerDefinitionData): void {
  if (!definition.oauth) {
    return;
  }

  if (definition.type !== 'http') {
    throw new Error('OAuth is only supported for HTTP MCP servers.');
  }

  if (
    definition.oauth.clientId !== undefined &&
    typeof definition.oauth.clientId !== 'string'
  ) {
    throw new Error('OAuth client ID must be a string.');
  }

  if (
    definition.oauth.clientSecret !== undefined &&
    typeof definition.oauth.clientSecret !== 'string'
  ) {
    throw new Error('OAuth client secret must be a string.');
  }

  if (
    definition.oauth.callbackPort !== undefined &&
    (!Number.isInteger(definition.oauth.callbackPort) ||
      definition.oauth.callbackPort < 1 ||
      definition.oauth.callbackPort > 65_535)
  ) {
    throw new Error('OAuth callback port must be an integer from 1 to 65535.');
  }

  if (
    typeof definition.oauth.clientSecret === 'string' &&
    definition.oauth.clientSecret.trim().length > 0
  ) {
    throw new Error(
      'Standalone MCP OAuth client secrets are not supported because they would be stored unencrypted.',
    );
  }

  if (
    definition.oauth.scopes !== undefined &&
    (!Array.isArray(definition.oauth.scopes) ||
      definition.oauth.scopes.some((scope) => typeof scope !== 'string'))
  ) {
    throw new Error('OAuth scopes must be an array of strings.');
  }

  if (
    definition.oauth.usePkce !== undefined &&
    typeof definition.oauth.usePkce !== 'boolean'
  ) {
    throw new Error('OAuth PKCE setting must be a boolean.');
  }

  try {
    if (definition.oauth.authorizationUrl !== undefined) {
      const authorizationUrl = new URL(definition.oauth.authorizationUrl);
      if (!['http:', 'https:'].includes(authorizationUrl.protocol)) {
        throw new Error('Invalid OAuth URL protocol');
      }
    }
    if (definition.oauth.tokenUrl !== undefined) {
      const tokenUrl = new URL(definition.oauth.tokenUrl);
      if (!['http:', 'https:'].includes(tokenUrl.protocol)) {
        throw new Error('Invalid OAuth URL protocol');
      }
    }
  } catch {
    throw new Error(
      'OAuth authorization and token URLs must be valid HTTP or HTTPS URLs.',
    );
  }
}

function encodeMcpMessage(message: Record<string, unknown>): string {
  const payload = JSON.stringify(message);
  return `Content-Length: ${String(Buffer.byteLength(payload, 'utf8'))}\r\n\r\n${payload}`;
}

interface ParsedMcpMessages {
  messages: Record<string, unknown>[];
  remaining: Buffer;
}

function parseMcpMessages(buffer: Buffer): ParsedMcpMessages {
  const messages: Record<string, unknown>[] = [];
  let remaining = buffer;
  const separator = '\r\n\r\n';

  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf(separator);
    if (headerEnd === -1) break;

    const header = remaining.subarray(0, headerEnd).toString('utf8');
    const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    const messageStart = headerEnd + separator.length;

    if (!contentLengthMatch) {
      remaining = remaining.subarray(messageStart);
      continue;
    }

    const contentLength = Number(contentLengthMatch[1]);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      remaining = remaining.subarray(messageStart);
      continue;
    }

    const messageEnd = messageStart + contentLength;
    if (remaining.length < messageEnd) break;

    const payload = remaining
      .subarray(messageStart, messageEnd)
      .toString('utf8');
    remaining = remaining.subarray(messageEnd);

    try {
      messages.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      // Ignore malformed frames and keep scanning the stream.
    }
  }

  return { messages, remaining };
}

interface ResolvedTestDefinition {
  baseDefinition: McpServerDefinitionData;
  definition: McpServerDefinitionData;
  envVars: Record<string, string>;
  config?: McpServerConfigData;
}

/**
 * Resolve a definition for health/connection testing,
 * optionally merging a config by id.
 */
async function resolveDefinitionForTest(
  serverId: string,
  configId?: string,
): Promise<ResolvedTestDefinition> {
  const file = await readServer(serverId);
  const { definition, configs } = file.server;
  const config = configId
    ? configs.find((candidate) => candidate.id === configId)
    : (configs.find((candidate) => candidate.enabled) ?? configs[0]);
  if (!config) {
    if (
      definition.type === 'http' &&
      (await resolveStandaloneHttpHandler(definition)) === 'account'
    ) {
      throw new Error('Account MCP connection requires a config.');
    }
    if (configId) {
      throw new Error(`Config ${configId} not found on server ${serverId}`);
    }
    return { baseDefinition: definition, definition, envVars: {} };
  }
  return {
    baseDefinition: definition,
    definition: mergeConfigIntoDefinition(definition, config),
    envVars: config.envVars,
    config,
  };
}

export async function resolveStandaloneHttpHandler(
  definition: McpServerDefinitionData,
): Promise<McpHttpAuthHandler> {
  const preferences = await readPreferencesFile();
  return getMcpHttpAuthDefault(
    definition,
    await readMcpAccountIndexEntry(definition.id),
    preferences.mcpHttpAuthDefaultHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
  );
}

async function checkHttpHealth(
  serverId: string,
  configId: string | undefined,
  def: McpServerDefinitionData,
  startTime: number,
): Promise<McpServerHealthCheckResult> {
  if (!def.url) {
    return {
      serverId,
      configId,
      status: 'unhealthy',
      message: 'No URL configured',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT_HEADER,
      ...(def.headers ?? {}),
    };

    const response = await fetchWithSafeRedirects(
      def.url,
      headers,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'canopy-health-check', version: '1.0.0' },
        },
      },
      controller.signal,
      'initialize',
    );

    clearTimeout(timeout);
    // Only the status verdict matters; an SSE body would otherwise stay open.
    await response.body?.cancel().catch(() => undefined);
    const responseTime = Date.now() - startTime;

    let status: 'healthy' | 'unhealthy' | 'needs_auth';
    let message: string;

    if (response.ok) {
      status = 'healthy';
      message = 'Server is responding';
    } else if (response.status === 401 || response.status === 403) {
      status = 'needs_auth';
      message =
        response.status === 401
          ? 'Authentication required'
          : 'Access forbidden';
    } else {
      status = 'unhealthy';
      message = `HTTP ${String(response.status)}: ${response.statusText}`;
    }

    return {
      serverId,
      configId,
      status,
      statusCode: response.status,
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  } catch (error: unknown) {
    const responseTime = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    let message = errorMessage;
    if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
      message = 'Connection timed out';
    } else if (errorMessage.includes('ECONNREFUSED')) {
      message = 'Connection refused - server may be down';
    } else if (errorMessage.includes('ENOTFOUND')) {
      message = 'Server not found - check URL';
    }

    return {
      serverId,
      configId,
      status: 'unhealthy',
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  }
}

async function checkCommandHealth(
  serverId: string,
  configId: string | undefined,
  def: McpServerDefinitionData,
  startTime: number,
): Promise<McpServerHealthCheckResult> {
  if (!def.command) {
    return {
      serverId,
      configId,
      status: 'unhealthy',
      message: 'No command configured',
      checkedAt: new Date().toISOString(),
    };
  }

  if (!isCommandSafe(def.command)) {
    return {
      serverId,
      configId,
      status: 'unhealthy',
      message: `Invalid command '${def.command}' - not in allowlist`,
      checkedAt: new Date().toISOString(),
    };
  }

  if (!areArgsSafe(def.args)) {
    return {
      serverId,
      configId,
      status: 'unhealthy',
      message: 'Args contain dangerous flags or shell metacharacters',
      checkedAt: new Date().toISOString(),
    };
  }

  const command = def.command;

  return new Promise<McpServerHealthCheckResult>((resolve) => {
    const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
    const proc = spawn(lookupCmd, [command], {
      timeout: 5000,
      windowsHide: true,
    });

    let found = false;

    proc.stdout.on('data', () => {
      found = true;
    });

    proc.on('error', (error: Error) => {
      const responseTime = Date.now() - startTime;
      const errCode = (error as NodeJS.ErrnoException).code;
      let message = `Failed to check command '${command}'`;

      if (errCode === 'ENOENT') {
        message = `System utility '${lookupCmd}' not found. Check system PATH configuration.`;
      } else if (errCode === 'EACCES') {
        message = `Permission denied checking command '${command}'`;
      }

      resolve({
        serverId,
        configId,
        status: 'unhealthy',
        message,
        responseTime,
        checkedAt: new Date().toISOString(),
      });
    });

    proc.on('close', (code) => {
      const responseTime = Date.now() - startTime;

      if (code === 0 || found) {
        resolve({
          serverId,
          configId,
          status: 'healthy',
          message: `Command '${command}' found`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      } else {
        resolve({
          serverId,
          configId,
          status: 'unhealthy',
          message: `Command '${command}' not found in PATH`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Connection test helpers
// ---------------------------------------------------------------------------

async function testHttpConnection(
  serverId: string,
  configId: string | undefined,
  def: McpServerDefinitionData,
  startTime: number,
): Promise<McpServerTestConnectionResult> {
  if (!def.url) {
    return {
      serverId,
      configId,
      success: false,
      message: 'No URL configured',
    };
  }

  try {
    const tools = await discoverHttpTools(def);
    const responseTime = Date.now() - startTime;

    return {
      serverId,
      configId,
      success: true,
      message:
        tools.length > 0
          ? `Connected successfully, ${String(tools.length)} tools available`
          : 'Connected successfully',
      tools,
      responseTime,
    };
  } catch (error: unknown) {
    const responseTime = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    if (error instanceof McpToolDiscoveryError) {
      const endpointReachable = error.phase === 'tools';
      if (error.kind === 'auth') {
        return {
          serverId,
          configId,
          success: false,
          message: 'Authentication failed',
          error: error.message,
          endpointReachable,
          responseTime,
        };
      }
      if (error.kind === 'http') {
        return {
          serverId,
          configId,
          success: false,
          message: 'Server returned error',
          error: error.message,
          endpointReachable,
          responseTime,
        };
      }
      if (error.kind === 'rpc') {
        return {
          serverId,
          configId,
          success: false,
          message: 'MCP error',
          error: error.message,
          endpointReachable,
          responseTime,
        };
      }
      if (error.kind === 'tools-http') {
        return {
          serverId,
          configId,
          success: false,
          message: 'MCP tools/list failed',
          error: error.message,
          endpointReachable,
          responseTime,
        };
      }
      if (error.kind === 'invalid') {
        return {
          serverId,
          configId,
          success: false,
          message: error.message,
          endpointReachable,
          responseTime,
        };
      }
    }

    let message = 'Connection failed';
    if (
      (error instanceof McpToolDiscoveryError && error.kind === 'timeout') ||
      errorMessage.includes('abort') ||
      errorMessage.includes('timeout')
    ) {
      message = 'Connection timed out';
    } else if (errorMessage.includes('ECONNREFUSED')) {
      message = 'Connection refused - server may be down';
    } else if (errorMessage.includes('ENOTFOUND')) {
      message = 'Server not found - check URL';
    }

    return {
      serverId,
      configId,
      success: false,
      message,
      error: errorMessage,
      ...(error instanceof McpToolDiscoveryError
        ? { endpointReachable: error.phase === 'tools' }
        : {}),
      responseTime,
    };
  }
}

async function ensureMcpProxyStartedForOAuth(): Promise<number> {
  const preferences = await readPreferencesFile();
  const proxy = getMcpHttpProxyService();
  await proxy.ensureStarted(preferences.mcpProxyPort);
  return proxy.getPort() ?? preferences.mcpProxyPort;
}

async function testCommandConnection(
  serverId: string,
  configId: string | undefined,
  def: McpServerDefinitionData,
  startTime: number,
  envVars: Record<string, string>,
): Promise<McpServerTestConnectionResult> {
  if (!def.command) {
    return {
      serverId,
      configId,
      success: false,
      message: 'No command configured',
    };
  }

  if (!isCommandSafe(def.command)) {
    return {
      serverId,
      configId,
      success: false,
      message: `Invalid command '${def.command}' - not in allowlist`,
    };
  }

  if (!areArgsSafe(def.args)) {
    return {
      serverId,
      configId,
      success: false,
      message: 'Args contain dangerous flags or shell metacharacters',
    };
  }

  const command = def.command;
  const args = def.args ?? [];

  return new Promise<McpServerTestConnectionResult>((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
      env: { ...process.env, ...sanitizeEnvVars(envVars) },
      windowsHide: true,
    });

    let stdoutBuffer: Buffer = Buffer.alloc(0);
    let stderr = '';
    let resolved = false;

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        const responseTime = Date.now() - startTime;
        resolve({
          serverId,
          configId,
          success: false,
          message: 'Connection timed out',
          responseTime,
        });
      }
    }, 15_000);

    // Send MCP initialize request
    const initRequest = encodeMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'canopy-health-check',
          version: '1.0.0',
        },
      },
    });

    proc.stdout.on('data', (data: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, data]);

      const parsed = parseMcpMessages(stdoutBuffer);
      stdoutBuffer = parsed.remaining;

      for (const response of parsed.messages) {
        if (response['id'] === 1 && response['result']) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            proc.kill();
            const responseTime = Date.now() - startTime;
            resolve({
              serverId,
              configId,
              success: true,
              message: 'MCP server started successfully',
              responseTime,
            });
          }
          return;
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8');
    });

    const failConnection = (error: Error, message: string): void => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const responseTime = Date.now() - startTime;
        resolve({
          serverId,
          configId,
          success: false,
          message,
          error: error.message,
          responseTime,
        });
        proc.kill();
      }
    };
    proc.on('error', (error: Error) =>
      failConnection(error, 'Failed to start server'),
    );
    proc.stdin.on('error', (error: Error) =>
      failConnection(error, 'MCP server input pipe failed'),
    );

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const responseTime = Date.now() - startTime;
        resolve({
          serverId,
          configId,
          success: false,
          message:
            code === 0
              ? 'Server exited before completing MCP initialization'
              : `Server exited with code ${String(code)}`,
          error: stderr || undefined,
          responseTime,
        });
      }
    });
    try {
      proc.stdin.write(initRequest);
    } catch (error) {
      failConnection(
        error instanceof Error ? error : new Error(String(error)),
        'MCP server input pipe failed',
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function broadcastMcpProxyStatus(
  getWindow: () => BrowserWindow | null,
  state: McpProxyState,
): void {
  void getWindow;
  sendToAllWindows(MCP_SERVER_CHANNELS.PROXY_STATUS, state);
}

function isValidProxyPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

function healthFromConnectionTest(
  result: McpServerTestConnectionResult,
): McpServerHealthCheckResult {
  const authFailure =
    result.message === 'Authentication failed' ||
    (result.message === 'MCP tools/list failed' &&
      (result.error?.startsWith('HTTP 401') === true ||
        result.error?.startsWith('HTTP 403') === true));
  return {
    serverId: result.serverId,
    ...(result.configId ? { configId: result.configId } : {}),
    status: result.success
      ? 'healthy'
      : authFailure
        ? 'needs_auth'
        : result.endpointReachable
          ? 'healthy'
          : 'unhealthy',
    message: result.message,
    responseTime: result.responseTime,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Validate and persist an MCP server (create or update), then refresh the
 * portal MCP projection. Extracted from the SAVE_SERVER IPC handler so the
 * portal `portal.mcp.set_config_enabled` adapter saves through the EXACT
 * same validation path the renderer uses — a browser-side toggle can never
 * bypass the definition/config/OAuth checks or skip the projection refresh.
 *
 * Throws plain `Error`s on validation failure (the IPC layer and the portal
 * adapter both translate them for their own transports).
 */
/**
 * Saves a device server. Every caller (IPC, Portal, catalog) shares the
 * per-server write queue, so a save never interleaves with a retirement.
 */
export async function saveMcpServer(
  server: SaveMcpServerRequest,
): Promise<McpServerFile> {
  const id = server.definition.id || randomUUID();
  if (!SAFE_ID_RE.test(id)) throw new Error(`Invalid MCP server id: ${id}`);
  const definition = {
    ...server.definition,
    id,
    createdAt: server.definition.id
      ? server.definition.createdAt
      : new Date().toISOString(),
  };
  return configRepository.withServerMutation(id, async () => {
    // Kept stored secrets resolve against the server as stored now, inside
    // its lease, so a value kept here is the one this save replaces.
    const current = server.definition.id
      ? (await configRepository.readServerForMutation(id))?.server
      : undefined;
    const resolved = resolveMcpServerInput(
      id,
      { definition, configs: server.configs },
      current,
    );
    return writeMcpServer({
      ...resolved,
      ...(server.accountConnectionId !== undefined
        ? { accountConnectionId: server.accountConnectionId }
        : {}),
      ...(server.accountRouting !== undefined
        ? { accountRouting: server.accountRouting }
        : {}),
    });
  });
}

const destinationChanged = (): StoredSecretError =>
  new StoredSecretError(
    'stored_secret_destination_changed',
    'Re-enter saved secrets after changing where this server connects or what it runs.',
  );

function urlHostname(url: string | undefined): string | undefined {
  try {
    return url === undefined ? undefined : new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the kept header and token references a cloud move sends, against
 * the device server the request names in `secretSource`. A start sends them
 * only to a custom URL on that server's own origin. An update sends them only
 * to the connection the server is bound to, and must set that connection's
 * URL to the server's own origin in the same request: the cloud reports only
 * the upstream hostname, so a connection pointed at another port or host
 * first could otherwise collect them.
 */
async function resolveAccountRequestSecrets(
  raw: unknown,
  boundConnectionId?: string,
): Promise<unknown> {
  if (typeof raw !== 'object' || raw === null || !('secretSource' in raw))
    return raw;
  const source = raw.secretSource;
  const serverId =
    typeof source === 'object' && source !== null && 'serverId' in source
      ? source.serverId
      : undefined;
  validateId(serverId, 'MCP server id');
  const customUrl =
    'customUrl' in raw && typeof raw.customUrl === 'string'
      ? raw.customUrl
      : undefined;
  const upstreamHost =
    boundConnectionId === undefined
      ? undefined
      : (await getAccountMcpConnection(boundConnectionId)).upstreamHost;
  return configRepository.withServerMutation(serverId, async () => {
    const current = await configRepository.readServerForMutation(serverId);
    if (!current)
      throw new StoredSecretError(
        'stored_secret_unknown',
        'A saved secret changed or was removed. Reload and try again.',
      );
    const deviceUrl = current.server.definition.url;
    if (boundConnectionId !== undefined) {
      const entry = (await configRepository.readIndex()).servers.find(
        (candidate) => candidate.id === serverId,
      );
      if (
        entry?.accountConnectionId !== boundConnectionId ||
        upstreamHost === undefined ||
        upstreamHost !== urlHostname(deviceUrl)
      )
        throw destinationChanged();
    }
    return resolveAccountSecretInputs(raw, {
      server: current.server,
      destinationUrl: customUrl ?? '',
    });
  });
}

/** Decides the no-op from strict state read inside the server lease. */
export function setInstalledMcpConfigEnabled(
  serverId: string,
  configId: string,
  enabled: boolean,
): Promise<McpServerFile> {
  if (!SAFE_ID_RE.test(serverId)) throw new Error('Invalid MCP server id.');
  return configRepository.withServerMutation(serverId, async () => {
    const current = await configRepository.readServerForMutation(serverId);
    if (!current) throw new McpConfigNotFoundError('server');
    const { server } = current;
    const target = server.configs.find((config) => config.id === configId);
    if (!target) throw new McpConfigNotFoundError('config');
    if (target.enabled === enabled) return current;
    return writeMcpServer({
      definition: server.definition,
      configs: server.configs.map((config) =>
        config.id === configId ? { ...config, enabled } : config,
      ),
    });
  });
}

export async function uninstallInstalledDeviceMcpServer(
  id: string,
): Promise<void> {
  if (!id || !SAFE_ID_RE.test(id))
    throw new Error(`Invalid MCP server id: ${id}`);
  await configRepository.withServerMutation(id, () =>
    deleteMcpServerAndOAuthTokens(id),
  );
}

async function writeMcpServer(
  server: McpServerData &
    Pick<SaveMcpServerRequest, 'accountConnectionId' | 'accountRouting'>,
): Promise<McpServerFile> {
  if (
    server.accountConnectionId !== undefined &&
    !z.string().uuid().safeParse(server.accountConnectionId).success
  ) {
    throw new Error('Account connection id must be a UUID');
  }
  const now = new Date().toISOString();
  const resolvedDefinition: McpServerDefinitionData = {
    ...server.definition,
    id: server.definition.id || randomUUID(),
    createdAt: server.definition.id ? server.definition.createdAt : now,
    updatedAt: now,
  };

  resolvedDefinition.curated = normalizeCuratedMetadata(resolvedDefinition);
  const requestedHttpAuthHandler = normalizeHttpAuthHandler(
    server.definition.httpAuthHandler,
  );
  const persistedProviderRequirement =
    resolvedDefinition.curated?.requiresProviderAuth;
  let curatedRequiresProvider = persistedProviderRequirement === true;
  if (
    resolvedDefinition.curated &&
    persistedProviderRequirement === undefined
  ) {
    const catalog = await listCuratedMcpServers();
    const catalogEntry = catalog.servers.find(
      (entry) => entry.key === resolvedDefinition.curated?.key,
    );
    if (catalogEntry) {
      curatedRequiresProvider = Boolean(
        catalogEntry.requiredConfigFields?.some(
          (field) => field.kind === 'oauth-client-secret',
        ),
      );
      resolvedDefinition.curated.requiresProviderAuth = curatedRequiresProvider;
    }
  }
  if (
    curatedRequiresProvider &&
    requestedHttpAuthHandler !== 'provider' &&
    requestedHttpAuthHandler !== 'account'
  ) {
    throw new Error('This curated MCP server requires provider-managed OAuth.');
  }
  const preferences = await readPreferencesFile();
  const serverFile = await configRepository.save(
    resolvedDefinition.id,
    (index) => {
      const isCreate = !index.servers.some(
        (entry) => entry.id === resolvedDefinition.id,
      );
      const httpAuthHandler =
        requestedHttpAuthHandler ??
        (isCreate && resolvedDefinition.curated ? 'canopy' : undefined);
      if (resolvedDefinition.type !== 'http' && httpAuthHandler !== undefined) {
        throw new Error(
          'HTTP auth handler is only supported for HTTP servers.',
        );
      }
      resolvedDefinition.httpAuthHandler = httpAuthHandler;

      if (!SAFE_ID_RE.test(resolvedDefinition.id)) {
        throw new Error(`Invalid MCP server id: ${resolvedDefinition.id}`);
      }
      if (!resolvedDefinition.name || !resolvedDefinition.name.trim()) {
        throw new Error('Server name is required');
      }
      if (!resolvedDefinition.type) {
        throw new Error('Server type is required');
      }

      // Validate configs
      if (!Array.isArray(server.configs)) {
        throw new Error('Invalid server: configs must be an array');
      }
      for (const c of server.configs) {
        if (!c.id || !c.name) {
          throw new Error('Each config must have an id and name');
        }
      }
      if (resolvedDefinition.type === 'command') {
        validateCommandDefinition(resolvedDefinition, server.configs);
      } else if (resolvedDefinition.type === 'http') {
        validateHttpDefinition(resolvedDefinition);
      }
      validateOAuthDefinition(resolvedDefinition);

      const resolvedServer: McpServerData = {
        definition: resolvedDefinition,
        configs: server.configs,
      };

      // Update index
      const existing = index.servers.findIndex(
        (s) => s.id === resolvedDefinition.id,
      );
      const previousEntry =
        server.accountRouting === 'clear' ? undefined : index.servers[existing];
      const effectiveHttpAuthHandler = getMcpHttpAuthDefault(
        resolvedDefinition,
        previousEntry,
        preferences.mcpHttpAuthDefaultHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
      );
      const accountConnectionId =
        server.accountConnectionId ?? previousEntry?.accountConnectionId;
      const entry: McpServerIndexEntry = {
        ...(previousEntry
          ? {
              scope: previousEntry.scope,
              authHandler: previousEntry.authHandler,
              accountConnectionId: previousEntry.accountConnectionId,
            }
          : {}),
        ...toIndexEntry(resolvedServer, effectiveHttpAuthHandler),
        ...(resolvedDefinition.type === 'http' &&
        effectiveHttpAuthHandler === 'account' &&
        accountConnectionId !== undefined
          ? { accountConnectionId }
          : {}),
      };
      return { server: resolvedServer, entry };
    },
  );
  await notifyConfigIndexChanged();
  await refreshProjectedPortalMcpServers().catch((error: unknown) => {
    logMainProcessError('Portal MCP projection refresh failed', error);
  });

  return serverFile;
}

/** Existing connection-test use case shared by IPC and Portal compatibility adapters. */
export async function testMcpServerConnection(
  serverId: string,
  configId?: string,
  inspectProbe?: (definition: McpServerDefinitionData) => void,
): Promise<McpServerTestConnectionResult> {
  if (!serverId || !SAFE_ID_RE.test(serverId)) {
    throw new Error(`Invalid MCP server id: ${serverId}`);
  }
  if (configId && !SAFE_ID_RE.test(configId)) {
    throw new Error(`Invalid MCP server config id: ${configId}`);
  }

  const startTime = Date.now();
  const resolved = await resolveDefinitionForTest(serverId, configId);
  const { definition: def, baseDefinition, config, envVars } = resolved;

  let result: McpServerTestConnectionResult;
  let healthGeneration: number;
  if (def.type === 'http') {
    const handler = await resolveStandaloneHttpHandler(baseDefinition);
    // Probe the underlying endpoint directly (never the Canopy proxy),
    // attaching the stored Canopy-managed OAuth token when applicable.
    const probeDefinition =
      handler === 'canopy' && config
        ? await withStoredOAuthAuthorization(def, config)
        : def;
    healthGeneration = getMcpServerHealthGeneration(serverId);
    const run = (
      probe: McpServerDefinitionData,
    ): ReturnType<typeof testHttpConnection> => {
      // In-process consumers can redact against the exact attached credentials,
      // including vault tokens, without adding them to any result or DTO.
      inspectProbe?.(probe);
      return testHttpConnection(
        serverId,
        config?.id ?? configId,
        probe,
        startTime,
      );
    };
    result =
      handler === 'account' && config
        ? await withAccountMcpProxy(
            baseDefinition,
            config,
            getMcpHttpProxyService(),
            (await readPreferencesFile()).mcpProxyPort,
            run,
          )
        : await run(probeDefinition);
  } else {
    healthGeneration = getMcpServerHealthGeneration(serverId);
    result = await testCommandConnection(
      serverId,
      configId,
      def,
      startTime,
      envVars,
    );
  }
  if (
    recordMcpServerHealth(healthFromConnectionTest(result), healthGeneration)
  ) {
    notifyDesktopInventoryChanged(['mcp_servers']);
  }
  if (result.success && config && result.tools) {
    try {
      await writeMcpToolsCacheEntry(serverId, config.id, {
        tools: result.tools,
        discoveredAt: new Date().toISOString(),
        sourceFingerprint: await mcpToolsSourceFingerprint(
          baseDefinition,
          config,
          await getMcpOAuthTokenRevision(serverId, config.id),
        ),
      });
    } catch {
      // Cache population is opportunistic and must not fail a valid probe.
    }
  }
  return result;
}

export function registerMcpServerHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  setMcpOAuthTokensChangedListener((serverIds): void => {
    clearMcpServerAuthHealthCache(serverIds);
    sendToAllWindows(MCP_SERVER_CHANNELS.AUTH_CHANGED);
  });
  // OAuth settles asynchronously in the callback server, long after the
  // start-login IPC returns; refresh the portal projection at that point so
  // the MCP card reflects the post-auth status.
  setMcpOAuthSettledListener((event): void => {
    void refreshProjectedPortalMcpServers().catch((error: unknown) => {
      logMainProcessError('Portal MCP projection refresh failed', error);
    });
    if (event.success && event.serverId && event.configId) {
      const serverId = event.serverId;
      const configId = event.configId;
      void refreshCodexSessionsAfterMcpOAuth({ serverId, configId });
      // Re-drive any turn this server stopped (CAN-1814 PR 6). Driven from
      // here rather than from the renderer card so the resume still happens
      // when the user navigates away during the browser leg, and so the
      // auto-resume safety gate lives next to the state that decides it.
      void resumeChatsAfterMcpOAuthSuccess({
        serverId,
        configId,
        getWindow,
      })
        .then((statuses): void => {
          // The statuses used to be dropped on the floor, so a resume that
          // never fired was indistinguishable from one that was never attempted
          // (CAN-1814 review). Each outcome also lands as an
          // `auth_resume_outcome` session diagnostic.
          const failed = statuses.filter(
            (status) => status === 'dispatch-failed' || status === 'chat-busy',
          );
          if (failed.length === 0) return;
          logMainProcessWarn(
            `Some chats did not resume after MCP OAuth success for ${serverId}:${configId}`,
            failed,
          );
        })
        .catch((error: unknown) => {
          logMainProcessError(
            'Resuming chats after MCP OAuth success failed',
            error,
          );
        });
    }
  });
  const proxy = getMcpHttpProxyService();
  proxy.setWindowAccessor(getWindow);
  void readPreferencesFile()
    .then((prefs): void => {
      void proxy.refreshPreferredPortStatus(prefs.mcpProxyPort);
    })
    .catch((): void => {
      // Preferences load failures are non-fatal here — defaults already applied.
    });
  proxy.setBroadcastHandlers({
    status: (state: McpProxyState): void =>
      broadcastMcpProxyStatus(getWindow, state),
  });

  registerIpcHandler(
    MCP_SERVER_CHANNELS.GET_PROXY_STATE,
    async (): Promise<McpProxyState> => {
      const prefs = await readPreferencesFile();
      proxy.setPreferredPort(prefs.mcpProxyPort);
      return proxy.getState();
    },
  );

  registerIpcHandler(
    MCP_SERVER_CHANNELS.APPLY_PROXY_PORT,
    async (_event, port: unknown): Promise<McpProxyState> => {
      if (!isValidProxyPort(port)) {
        throw new Error('Port must be an integer between 1 and 65535.');
      }

      const previous = await readPreferencesFile();
      let persistedPort = false;
      try {
        await proxy.assertPortAvailable(port);
        await writePreferencesFile({ mcpProxyPort: port });
        persistedPort = true;
        if (proxy.isRunning()) {
          await proxy.updatePort(port);
        } else {
          proxy.setPreferredPort(port);
        }
      } catch (error: unknown) {
        if (persistedPort) {
          await writePreferencesFile({ mcpProxyPort: previous.mcpProxyPort });
        }
        if (!proxy.isRunning()) {
          proxy.setPreferredPort(previous.mcpProxyPort);
        }
        throw error instanceof Error
          ? error
          : new Error('Could not apply MCP proxy port.');
      }
      return proxy.getState();
    },
  );

  const accountResult = async <T>(
    operation: () => Promise<T>,
  ): Promise<T | AccountMcpConnectionFailure> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AccountMcpConnectionError)
        return {
          error: {
            code: error.code,
            ...(error.header ? { header: error.header } : {}),
            ...(error.details.clientSetup
              ? { clientSetup: error.details.clientSetup }
              : {}),
            ...(error.details.serverCode
              ? { serverCode: error.details.serverCode }
              : {}),
            ...(error.details.desktopSignIn !== undefined
              ? { desktopSignIn: error.details.desktopSignIn }
              : {}),
          },
        };
      throw error;
    }
  };
  const accountChanged = (): void => {
    invalidateAccountMcpConnections();
    sendToAllWindows(MCP_SERVER_CHANNELS.AUTH_CHANGED);
    void import('../installed-items/installed-item-events')
      .then(({ notifyInstalledItemsChanged }) => notifyInstalledItemsChanged())
      .catch((error: unknown) =>
        logMainProcessError('Installed MCP state notification failed', error),
      );
  };
  subscribeCanopyCloudAccountChanges(accountChanged);
  const assertAccountEnabled = (): void => {
    if (!accountMcpConnectionsEnabled())
      throw new Error('Account MCP connections are unavailable.');
  };
  // Account rows are addressed by server key (`github`, `custom:<uuid>`);
  // legacy `account:<connectionId>` ids still resolve. A device server with
  // the same id wins, matching plugin resolution.
  const accountConnectionForTools = async (
    serverId: string,
    configId: string | undefined,
  ): Promise<AccountMcpConnection | undefined> => {
    const legacyId = legacyAccountMcpConnectionId(serverId);
    const custom = isCustomAccountMcpServerKey(serverId);
    if (legacyId !== undefined || custom) assertAccountEnabled();
    else if (!accountMcpConnectionsEnabled()) return undefined;
    if (legacyId !== undefined) {
      validateId(legacyId, 'MCP account connection id');
      const connection = await getAccountMcpConnection(legacyId);
      if (configId && configId !== connection.configId)
        throw new Error('Account MCP config does not match.');
      return connection;
    }
    if (!custom) {
      try {
        await readServer(serverId);
        return undefined;
      } catch {
        // Not a device server; look for the account row below.
      }
    }
    const connections = await listAccountMcpConnections();
    const connection = configId
      ? accountMcpConnectionForRef({ serverId, configId }, connections)
      : findAccountMcpRow(mergeAccountMcpInventory([], connections), serverId)
          ?.accountConnection;
    if (!connection && custom)
      throw new Error('Account MCP connection is unavailable.');
    return connection;
  };
  const startSchema = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('curated'),
      serverKey: z.string().min(1).max(256),
      endpointUrl: z
        .string()
        .url()
        .max(4096)
        .refine((url): boolean => new URL(url).protocol === 'https:')
        .optional(),
    }),
    z.object({
      kind: z.literal('custom'),
      customUrl: z
        .string()
        .url()
        .max(4096)
        .refine(
          (url): boolean => new URL(url).protocol === 'https:',
          'Use an HTTPS URL.',
        ),
      displayName: z.string().trim().min(1).max(120).optional(),
    }),
  ]);
  registerIpcHandler(
    MCP_SERVER_CHANNELS.START_ACCOUNT,
    async (
      _event,
      raw: unknown,
    ): Promise<
      StartAccountMcpConnectionResponse | AccountMcpConnectionFailure
    > => {
      assertAccountEnabled();
      const input = z
        .object({
          serverKey: z.string().optional(),
          customUrl: z.string().optional(),
          displayName: z.string().optional(),
          headers: z.unknown().optional(),
          endpointUrl: z.string().optional(),
          configId: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
          bearerToken: z.string().min(1).max(16384).optional(),
          oauthClient: z
            .object({
              clientId: z.string().trim().min(1).max(4096),
              clientSecret: z.string().min(1).max(16384).optional(),
            })
            .strict()
            .optional(),
          expectedAccountId: z.string().trim().min(1).max(256).optional(),
          browser: z.literal('embedded').optional(),
        })
        .strict()
        .refine((value): boolean => !(value.bearerToken && value.oauthClient))
        .parse(await resolveAccountRequestSecrets(raw));
      if (Boolean(input.serverKey) === Boolean(input.customUrl))
        throw new Error('Choose a server key or a custom URL.');
      if (input.endpointUrl !== undefined && !input.serverKey)
        throw new Error('Choose a curated server for an endpoint selection.');
      if (input.displayName !== undefined && !input.customUrl)
        throw new Error('Only a custom server takes a display name.');
      if (input.headers !== undefined && !input.customUrl)
        throw new Error('Only a custom server takes headers.');
      const headers =
        input.headers === undefined
          ? undefined
          : parseMcpExtraHeaders(input.headers);
      if (headers === null) throw new Error('Check the server headers.');
      const target = startSchema.parse(
        input.serverKey
          ? {
              kind: 'curated',
              serverKey: input.serverKey,
              endpointUrl: input.endpointUrl,
            }
          : {
              kind: 'custom',
              customUrl: input.customUrl,
              displayName: input.displayName,
            },
      );
      const result = await accountResult(
        (): Promise<StartAccountMcpConnectionResponse> =>
          startAccountMcpConnection({
            ...(target.kind === 'curated'
              ? {
                  serverKey: target.serverKey,
                  ...(target.endpointUrl
                    ? { endpointUrl: target.endpointUrl }
                    : {}),
                }
              : {
                  customUrl: target.customUrl,
                  ...(target.displayName
                    ? { displayName: target.displayName }
                    : {}),
                  ...(headers && Object.keys(headers).length > 0
                    ? { headers }
                    : {}),
                }),
            configId: input.configId,
            ...(input.browser ? { browser: input.browser } : {}),
            ...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
            ...(input.oauthClient ? { oauthClient: input.oauthClient } : {}),
            ...(input.expectedAccountId
              ? { expectedAccountId: input.expectedAccountId }
              : {}),
          }),
      );
      accountChanged();
      return result;
    },
  );
  registerIpcHandler(
    MCP_SERVER_CHANNELS.GET_ACCOUNT,
    async (_event, id: unknown): Promise<AccountMcpConnection> => {
      assertAccountEnabled();
      validateId(id, 'MCP account connection id');
      return getAccountMcpConnection(id);
    },
  );
  registerIpcHandler(
    MCP_SERVER_CHANNELS.UPDATE_ACCOUNT,
    async (
      _event,
      id: unknown,
      raw: unknown,
    ): Promise<AccountMcpConnection | AccountMcpConnectionFailure> => {
      assertAccountEnabled();
      validateId(id, 'MCP account connection id');
      const input = updateAccountSchema.parse(
        await resolveAccountRequestSecrets(raw, id),
      );
      const headers =
        input.headers === undefined
          ? undefined
          : parseMcpExtraHeaders(input.headers);
      if (headers === null) throw new Error('Check the server headers.');
      const result = await accountResult(
        (): Promise<AccountMcpConnection> =>
          updateAccountMcpConnection(id, {
            ...(input.displayName !== undefined
              ? { displayName: input.displayName }
              : {}),
            ...(input.customUrl !== undefined
              ? { customUrl: input.customUrl }
              : {}),
            ...(headers !== undefined ? { headers } : {}),
            ...(input.bearerToken !== undefined
              ? { bearerToken: input.bearerToken }
              : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.expectedAccountId !== undefined
              ? { expectedAccountId: input.expectedAccountId }
              : {}),
          }),
      );
      accountChanged();
      return result;
    },
  );
  registerIpcHandler(
    MCP_SERVER_CHANNELS.REMOVE_ACCOUNT,
    async (
      _event,
      id: unknown,
    ): Promise<RemoveAccountMcpConnectionResponse> => {
      assertAccountEnabled();
      validateId(id, 'MCP account connection id');
      const result = await removeAccountMcpConnection(id);
      accountChanged();
      return result;
    },
  );
  registerIpcHandler(
    MCP_SERVER_CHANNELS.REWRITE_REFS,
    async (_event, raw: unknown): Promise<RewriteMcpServerRefsResponse> => {
      return unwrapMcpRefRewriteOutcome(await rewriteMcpServerRefsOutcome(raw));
    },
  );
  registerIpcHandler(
    MCP_SERVER_CHANNELS.DISCONNECT_ACCOUNT,
    async (_event, id: unknown): Promise<void> => {
      assertAccountEnabled();
      validateId(id, 'MCP account connection id');
      await disconnectAccountMcpConnection(id);
      accountChanged();
    },
  );
  registerIpcHandler(
    MCP_SERVER_CHANNELS.SET_ACCOUNT_TOOLS,
    async (
      _event,
      id: unknown,
      tools: unknown,
    ): Promise<AccountMcpConnection> => {
      assertAccountEnabled();
      validateId(id, 'MCP account connection id');
      const result = await setAccountMcpConnectionTools(
        id,
        z.array(z.string().min(1).max(256)).max(1000).nullable().parse(tools),
      );
      accountChanged();
      return result;
    },
  );
  registerIpcHandler(
    MCP_SERVER_CHANNELS.LIST_ACCOUNT_UPSTREAM_TOOLS,
    async (_event, id: unknown): Promise<AccountMcpUpstreamTool[]> => {
      assertAccountEnabled();
      validateId(id, 'MCP account connection id');
      return listAccountMcpUpstreamTools(id);
    },
  );
  registerIpcHandler(
    MCP_SERVER_CHANNELS.AWAIT_ACCOUNT,
    async (
      _event,
      id: unknown,
      options: unknown,
    ): Promise<AccountMcpConnection | AccountMcpConnectionFailure> => {
      assertAccountEnabled();
      validateId(id, 'MCP account connection id');
      const result = await accountResult(
        (): Promise<AccountMcpConnection> =>
          awaitAccountMcpConnection(
            id,
            z
              .object({
                timeoutMs: z.number().int().min(1).max(600_000).optional(),
              })
              .strict()
              .optional()
              .parse(options),
          ),
      );
      accountChanged();
      return result;
    },
  );

  // Account rows are ephemeral; CRUD writers always read the device-only index.
  registerIpcHandler(
    MCP_SERVER_CHANNELS.LOAD_INDEX,
    async (): Promise<McpServersIndexFile> =>
      withAccountMcpInventory(await readIndexWithUrlBackfill()),
  );

  registerIpcHandler(MCP_SERVER_CHANNELS.LIST_PROVIDER_CONNECTORS, async () => {
    return listAdvertisedProviderConnectors();
  });

  registerIpcHandler<
    [{ provider: ProviderConnectorProvider; installUrl?: string }],
    void
  >(
    MCP_SERVER_CHANNELS.OPEN_PROVIDER_CONNECTOR_SETTINGS,
    async (_event, request) => {
      // Neither CLI can create a connector, so linking always ends in the
      // browser. Codex publishes a page per app; when one is missing, fall
      // back to that provider's own directory — a single fallback sent every
      // Codex connect to Claude's connectors page.
      //
      // Both inputs are validated before they reach the shell.
      // `openExternalGuarded` performs no scheme check of its own, and neither
      // input is trustworthy: `provider` and `installUrl` arrive over IPC, and
      // `installUrl` originates in `~/.codex/cache/codex_app_directory`, a file
      // Canopy neither writes nor validates. An unexpected `provider` would
      // also make the fallback `undefined` and throw inside the handler. Every
      // legitimate target here is an https page on the provider's own site.
      if (request.provider !== 'claude' && request.provider !== 'codex') return;
      const target =
        request.installUrl ?? PROVIDER_CONNECTOR_MANAGE_URLS[request.provider];
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return;
      }
      if (parsed.protocol !== 'https:') return;
      await openExternalGuarded(parsed.toString());
    },
  );

  registerIpcHandler(MCP_SERVER_CHANNELS.LIST_CURATED, async () =>
    listCuratedMcpServers(),
  );

  registerIpcHandler(
    MCP_SERVER_CHANNELS.REFRESH_CURATED,
    async (): Promise<Awaited<ReturnType<typeof refreshCuratedMcpServers>>> => {
      const catalog = await refreshCuratedMcpServers();
      accountChanged();
      return catalog;
    },
  );

  registerIpcHandler(
    MCP_SERVER_CHANNELS.RESOLVE_REMOTE_IMAGE,
    async (_event, url: string) => resolveRemoteImageDataUrl(url),
  );

  registerIpcHandler(MCP_SERVER_CHANNELS.LIST_STATUS, async () =>
    listMcpServerStatuses(),
  );

  registerIpcHandler(
    MCP_SERVER_CHANNELS.LIST_ACCOUNT_CONNECTIONS,
    async (): Promise<AccountMcpConnectionSummary[]> => {
      invalidateAccountMcpConnections();
      const connections = await listAccountMcpConnections();
      return connections.map(
        ({
          id,
          serverKey,
          configId,
          displayName,
          status,
          kind,
          authMode,
          upstreamHost,
          hasExtraHeaders,
        }): AccountMcpConnectionSummary => ({
          id,
          serverKey,
          configId,
          displayName,
          status,
          kind,
          ...(authMode === undefined ? {} : { authMode }),
          ...(upstreamHost === undefined ? {} : { upstreamHost }),
          ...(hasExtraHeaders === undefined ? {} : { hasExtraHeaders }),
        }),
      );
    },
  );

  // Load single server
  // Replies never carry stored secrets (CAN-4411); see server-secret-view.
  registerIpcHandler(
    MCP_SERVER_CHANNELS.LOAD_SERVER,
    async (_event, id: string): Promise<McpServerFileView> => {
      if (!id || !SAFE_ID_RE.test(id)) {
        throw new Error(`Invalid MCP server id: ${id}`);
      }
      return projectMcpServerFile(await readServer(id));
    },
  );

  // Save server (create or update)
  registerIpcHandler(
    MCP_SERVER_CHANNELS.SAVE_SERVER,
    async (_event, server: SaveMcpServerRequest): Promise<McpServerFileView> =>
      projectMcpServerFile(await saveMcpServer(server)),
  );

  // Delete server
  registerIpcHandler(
    MCP_SERVER_CHANNELS.DELETE_SERVER,
    async (_event, id: string) => {
      if (!id || !SAFE_ID_RE.test(id)) {
        throw new Error(`Invalid MCP server id: ${id}`);
      }
      await configRepository.withServerMutation(id, () =>
        deleteMcpServerAndOAuthTokens(id),
      );
    },
  );

  // Health check
  registerIpcHandler(
    MCP_SERVER_CHANNELS.CHECK_HEALTH,
    async (
      _event,
      serverId: string,
      configId?: string,
    ): Promise<McpServerHealthCheckResult> => {
      if (!serverId || !SAFE_ID_RE.test(serverId)) {
        throw new Error(`Invalid MCP server id: ${serverId}`);
      }
      if (configId && !SAFE_ID_RE.test(configId)) {
        throw new Error(`Invalid MCP server config id: ${configId}`);
      }

      const startTime = Date.now();
      const resolved = await resolveDefinitionForTest(serverId, configId);
      const { definition: def, baseDefinition, config } = resolved;

      let result: McpServerHealthCheckResult;
      let healthGeneration: number;
      if (def.type === 'http') {
        const handler = await resolveStandaloneHttpHandler(baseDefinition);
        // Local handlers probe the endpoint directly; account handlers use
        // a temporary loopback route that supplies the cloud credential.
        const probeDefinition =
          handler === 'canopy' && config
            ? await withStoredOAuthAuthorization(def, config)
            : def;
        healthGeneration = getMcpServerHealthGeneration(serverId);
        const run = (
          probe: McpServerDefinitionData,
        ): ReturnType<typeof checkHttpHealth> =>
          checkHttpHealth(serverId, config?.id ?? configId, probe, startTime);
        result =
          handler === 'account' && config
            ? await withAccountMcpProxy(
                baseDefinition,
                config,
                getMcpHttpProxyService(),
                (await readPreferencesFile()).mcpProxyPort,
                run,
              )
            : await run(probeDefinition);
      } else {
        healthGeneration = getMcpServerHealthGeneration(serverId);
        result = await checkCommandHealth(serverId, configId, def, startTime);
      }
      recordMcpServerHealth(result, healthGeneration);
      return result;
    },
  );

  // Connection test
  registerIpcHandler(
    MCP_SERVER_CHANNELS.TEST_CONNECTION,
    async (
      _event,
      serverId: string,
      configId?: string,
    ): Promise<McpServerTestConnectionResult> => {
      return testMcpServerConnection(serverId, configId);
    },
  );

  registerIpcHandler(
    MCP_SERVER_CHANNELS.GET_TOOLS,
    async (
      _event,
      serverId: string,
      configId?: string,
    ): Promise<McpServerToolsCacheEntry | null> => {
      const connection =
        typeof serverId === 'string'
          ? await accountConnectionForTools(serverId, configId)
          : undefined;
      if (connection) {
        const now = new Date().toISOString();
        const definition: McpServerDefinitionData = {
          id: connection.serverKey,
          name: connection.displayName,
          description: '',
          type: 'http',
          httpAuthHandler: 'account',
          createdAt: now,
          updatedAt: now,
        };
        const config: McpServerConfigData = {
          id: connection.configId,
          name: 'Default',
          description: '',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: now,
          updatedAt: now,
        };
        const tools = await withAccountMcpProxy(
          definition,
          config,
          getMcpHttpProxyService(),
          (await readPreferencesFile()).mcpProxyPort,
          discoverHttpTools,
          connection.id,
        );
        return { tools, discoveredAt: new Date().toISOString() };
      }
      validateId(serverId, 'MCP server id');
      if (configId) validateId(configId, 'MCP server config id');
      const file = await readServer(serverId);
      const config = configId
        ? file.server.configs.find((entry) => entry.id === configId)
        : (file.server.configs.find((entry) => entry.enabled) ??
          file.server.configs[0]);
      if (configId && !config) {
        throw new Error(`Config ${configId} not found on server ${serverId}`);
      }
      if (!config) return null;
      return getMcpToolsCacheEntry(
        serverId,
        config.id,
        await mcpToolsSourceFingerprint(
          file.server.definition,
          config,
          await getMcpOAuthTokenRevision(serverId, config.id),
        ),
      );
    },
  );

  registerIpcHandler(
    MCP_SERVER_CHANNELS.LIST_DETECTED,
    async (_event, request: ListDetectedMcpServersRequest) =>
      listDetectedMcpServersForSelections(request.selections),
  );

  registerIpcHandler(
    MCP_SERVER_CHANNELS.CANCEL_OAUTH_LOGIN,
    async (_event, flowId: string) => {
      if (typeof flowId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(flowId)) {
        throw new Error('Invalid sign-in identifier.');
      }
      await getMcpOAuthCoordinator().cancel(flowId);
    },
  );

  registerIpcHandler(
    MCP_SERVER_CHANNELS.START_OAUTH_LOGIN,
    async (event, request: StartMcpOAuthLoginRequest) => {
      if (request.plugin) {
        const pluginServer = await resolvePluginOAuthTarget(request.plugin);
        const probeInputs = pluginMcpOAuthProbeInputs(
          pluginServer.identity,
          pluginServer.rawValue,
        );
        if (
          await connectNeedsNoSignIn(
            probeInputs,
            pluginServer.definition,
            pluginServer.config,
          )
        ) {
          await refreshProjectedPortalMcpServers();
          return { status: 'completed' };
        }
        const proxyPort = await ensureMcpProxyStartedForOAuth();
        const result = await getMcpOAuthCoordinator().start({
          definition: pluginServer.definition,
          config: pluginServer.config,
          proxyPort,
          force: request.force,
          browser: request.browser,
          presenterWebContentsId: event.sender.id,
        });
        if (result.status === 'completed') {
          await refreshCodexSessionsAfterMcpOAuth({
            serverId: pluginServer.definition.id,
            configId: pluginServer.config.id,
          });
        }
        await refreshProjectedPortalMcpServers().catch((error: unknown) => {
          logMainProcessError('Portal MCP projection refresh failed', error);
        });
        return result;
      }

      if (!request.serverId || !SAFE_ID_RE.test(request.serverId)) {
        throw new Error(`Invalid MCP server id: ${request.serverId}`);
      }
      if (!request.configId || !SAFE_ID_RE.test(request.configId)) {
        throw new Error(`Invalid MCP server config id: ${request.configId}`);
      }

      const file = await readServer(request.serverId);
      if (
        (await resolveStandaloneHttpHandler(file.server.definition)) ===
        'account'
      )
        throw new Error(MCP_ACCOUNT_RECONNECT_DETAIL);
      const { definition, configs } = file.server;
      const config = configs.find((entry) => entry.id === request.configId);
      if (!config) {
        throw new Error(
          `Config ${request.configId} not found on server ${request.serverId}`,
        );
      }
      if (definition.type !== 'http') {
        throw new Error('OAuth is only supported for HTTP MCP servers.');
      }

      const probeInputs = standaloneMcpOAuthProbeInputs(definition, config);
      if (await connectNeedsNoSignIn(probeInputs, definition, config)) {
        await refreshProjectedPortalMcpServers();
        return { status: 'completed' };
      }
      const proxyPort = await ensureMcpProxyStartedForOAuth();
      const definitionForOAuth: McpServerDefinitionData = definition.oauth
        ? definition
        : {
            ...definition,
            oauth: { usePkce: true },
          };
      const result = await getMcpOAuthCoordinator().start({
        definition: definitionForOAuth,
        config,
        proxyPort,
        force: request.force,
        browser: request.browser,
        presenterWebContentsId: event.sender.id,
      });
      if (result.status === 'completed') {
        await refreshCodexSessionsAfterMcpOAuth({
          serverId: definitionForOAuth.id,
          configId: config.id,
        });
      }
      await refreshProjectedPortalMcpServers().catch((error: unknown) => {
        logMainProcessError('Portal MCP projection refresh failed', error);
      });
      return result;
    },
  );

  registerIpcHandler(
    MCP_SERVER_CHANNELS.CLEAR_OAUTH_TOKEN,
    async (_event, request: ClearMcpOAuthTokenRequest) => {
      if (!request.serverId || !SAFE_ID_RE.test(request.serverId)) {
        throw new Error(`Invalid MCP server id: ${request.serverId}`);
      }
      if (!request.configId || !SAFE_ID_RE.test(request.configId)) {
        throw new Error(`Invalid MCP server config id: ${request.configId}`);
      }
      await clearMcpOAuthToken(request.serverId, request.configId);
      await refreshProjectedPortalMcpServers().catch((error: unknown) => {
        logMainProcessError('Portal MCP projection refresh failed', error);
      });
    },
  );
}
