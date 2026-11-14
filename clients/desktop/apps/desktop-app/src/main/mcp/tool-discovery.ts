import { findAccountMcpConnection } from '../canopy-cloud/mcp-connections';
import { getMcpHttpAuthDefault } from '@canopy/execution-engine/lib/mcp-http-auth';
import {
  readMcpAccountIndexEntry,
  withAccountMcpProxy,
} from './account-routing';
import { getMcpHttpProxyService } from './http-proxy-service';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { dirname } from 'node:path';
import { DEFAULT_MCP_HTTP_AUTH_HANDLER } from '@canopy/desktop-shared/types';
import type {
  McpHttpAuthHandler,
  McpServerConfigData,
  McpServerDefinitionData,
  McpServerFile,
  McpServerHealthCheckResult,
  McpServerToolsCacheEntry,
  McpServerToolsCacheFile,
  McpServersIndexFile,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  isMcpServersIndexFile,
  normalizeMcpServerFile,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  getMcpServerFilePath,
  getMcpServersIndexFilePath,
  getMcpServerToolsCacheFilePath,
} from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import { getValidMcpAccessToken } from './oauth-client';
import { getMcpOAuthTokenRevision } from './oauth-token-store';
import {
  getMcpServerHealthGeneration,
  recordMcpServerHealth,
} from './connection-status';
import {
  fetchPinnedHttpResponse,
  type PinnedHttpAddress,
} from './pinned-http-fetch';
import {
  MCP_ACCEPT_HEADER,
  MCP_MAX_RESPONSE_BYTES as MCP_DISCOVERY_MAX_RESPONSE_BYTES,
  readMcpJsonRpcMessage,
  type McpJsonRpcMessage,
} from '@canopy/mcp-oauth-core';
import { listMcpToolNames, McpToolDiscoveryError } from './tool-list';

export {
  MCP_ACCEPT_HEADER,
  MCP_MAX_RESPONSE_BYTES as MCP_DISCOVERY_MAX_RESPONSE_BYTES,
} from '@canopy/mcp-oauth-core';

export {
  MCP_DISCOVERY_MAX_TOOLS,
  MCP_DISCOVERY_MAX_TOOL_NAME_BYTES,
  MCP_DISCOVERY_MAX_TOOL_PAGES,
  MCP_DISCOVERY_MAX_TOOLS_DURATION_MS,
  McpToolDiscoveryError,
} from './tool-list';

export const MCP_TOOLS_MAX_AGE_MS = 24 * 60 * 60_000;
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_SUPPORTED_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  '2025-03-26',
  '2024-11-05',
]);
const MCP_MAX_REDIRECTS = 5;
const PRIVATE_NETWORKS = new BlockList();
const LOOPBACK_NETWORKS = new BlockList();
LOOPBACK_NETWORKS.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_NETWORKS.addAddress('::1', 'ipv6');
PRIVATE_NETWORKS.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_NETWORKS.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_NETWORKS.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE_NETWORKS.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_NETWORKS.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_NETWORKS.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_NETWORKS.addSubnet('192.0.0.0', 24, 'ipv4');
PRIVATE_NETWORKS.addSubnet('192.0.2.0', 24, 'ipv4');
PRIVATE_NETWORKS.addSubnet('192.88.99.0', 24, 'ipv4');
PRIVATE_NETWORKS.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_NETWORKS.addSubnet('198.18.0.0', 15, 'ipv4');
PRIVATE_NETWORKS.addSubnet('198.51.100.0', 24, 'ipv4');
PRIVATE_NETWORKS.addSubnet('203.0.113.0', 24, 'ipv4');
PRIVATE_NETWORKS.addSubnet('224.0.0.0', 4, 'ipv4');
PRIVATE_NETWORKS.addSubnet('240.0.0.0', 4, 'ipv4');
PRIVATE_NETWORKS.addAddress('::', 'ipv6');
PRIVATE_NETWORKS.addAddress('::1', 'ipv6');
PRIVATE_NETWORKS.addSubnet('64:ff9b:1::', 48, 'ipv6');
PRIVATE_NETWORKS.addSubnet('100::', 64, 'ipv6');
PRIVATE_NETWORKS.addSubnet('2001::', 23, 'ipv6');
PRIVATE_NETWORKS.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_NETWORKS.addSubnet('fe80::', 10, 'ipv6');
PRIVATE_NETWORKS.addSubnet('ff00::', 8, 'ipv6');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cacheKey(serverId: string, configId: string): string {
  return `${serverId}:${configId}`;
}

function normalizeCache(value: unknown): McpServerToolsCacheFile {
  if (!isRecord(value)) return { version: 1, entries: {} };
  if (value.version !== 1 || !isRecord(value.entries)) {
    return { version: 1, entries: {} };
  }
  const entries: McpServerToolsCacheFile['entries'] = {};
  for (const [key, raw] of Object.entries(value.entries)) {
    if (
      isRecord(raw) &&
      Array.isArray(raw.tools) &&
      raw.tools.every((tool) => typeof tool === 'string') &&
      typeof raw.discoveredAt === 'string'
    ) {
      entries[key] = {
        tools: [...raw.tools],
        discoveredAt: raw.discoveredAt,
        ...(typeof raw.sourceFingerprint === 'string'
          ? { sourceFingerprint: raw.sourceFingerprint }
          : {}),
      };
    }
  }
  return { version: 1, entries };
}

export async function readMcpToolsCache(): Promise<McpServerToolsCacheFile> {
  try {
    return normalizeCache(
      JSON.parse(await readFile(getMcpServerToolsCacheFilePath(), 'utf8')),
    );
  } catch {
    return { version: 1, entries: {} };
  }
}

async function writeMcpToolsCache(
  cache: McpServerToolsCacheFile,
): Promise<void> {
  const filePath = getMcpServerToolsCacheFilePath();
  const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, JSON.stringify(cache, null, 2), 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

let toolsCacheMutationQueue: Promise<void> = Promise.resolve();

export async function writeMcpToolsCacheEntry(
  serverId: string,
  configId: string,
  entry: McpServerToolsCacheEntry,
): Promise<void> {
  const mutation = toolsCacheMutationQueue.then(async () => {
    const cache = await readMcpToolsCache();
    cache.entries[cacheKey(serverId, configId)] = {
      tools: [...entry.tools],
      discoveredAt: entry.discoveredAt,
      ...(entry.sourceFingerprint
        ? { sourceFingerprint: entry.sourceFingerprint }
        : {}),
    };
    await writeMcpToolsCache(cache);
  });
  // A failed write must reject its caller without poisoning later mutations.
  toolsCacheMutationQueue = mutation.catch(() => undefined);
  await mutation;
}

export async function getMcpToolsCacheEntry(
  serverId: string,
  configId: string,
  expectedSourceFingerprint?: string,
): Promise<McpServerToolsCacheEntry | null> {
  const entry = (await readMcpToolsCache()).entries[
    cacheKey(serverId, configId)
  ];
  if (
    !entry ||
    (expectedSourceFingerprint !== undefined &&
      entry.sourceFingerprint !== expectedSourceFingerprint)
  ) {
    return null;
  }
  return {
    tools: [...entry.tools],
    discoveredAt: entry.discoveredAt,
    ...(entry.sourceFingerprint
      ? { sourceFingerprint: entry.sourceFingerprint }
      : {}),
  };
}

/** Stable hash of every server/config field that can affect tools/list. */
export async function mcpToolsSourceFingerprint(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
  oauthRevision = 'missing',
): Promise<string> {
  const indexEntry = await readMcpAccountIndexEntry(definition.id);
  const preferences = await readPreferencesFile();
  const handler = getMcpHttpAuthDefault(
    definition,
    indexEntry,
    preferences.mcpHttpAuthDefaultHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
  );
  const connection =
    handler === 'account'
      ? await findAccountMcpConnection({
          curatedKey: definition.curated?.key,
          accountConnectionId: indexEntry?.accountConnectionId,
          configId: config.id,
        }).catch((): undefined => undefined)
      : undefined;

  return createHash('sha256')
    .update(
      JSON.stringify({
        definition: {
          type: definition.type,
          command: definition.command,
          args: definition.args,
          url: definition.url,
          headers: definition.headers,
          oauth: definition.oauth,
          httpAuthHandler: definition.httpAuthHandler,
        },
        config: {
          enabled: config.enabled,
          envVars: config.envVars,
          extraArgs: config.extraArgs,
          extraHeaders: config.extraHeaders,
          authToken: config.authToken,
        },
        oauthRevision,
        handler,
        ...(handler === 'account'
          ? {
              account: {
                accountConnectionId: indexEntry?.accountConnectionId,
                curatedKey: definition.curated?.key,
                configId: config.id,
                connectionId: connection?.id,
                routeId: connection?.routeId,
                enabledTools: connection?.enabledTools,
                enabled: connection?.enabled,
              },
            }
          : {}),
      }),
    )
    .digest('hex');
}

export function mergeConfigIntoDefinition(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
): McpServerDefinitionData {
  const merged: McpServerDefinitionData = { ...definition };
  if (config.extraArgs.length > 0) {
    merged.args = [...(definition.args ?? []), ...config.extraArgs];
  }
  if (Object.keys(config.extraHeaders).length > 0 || config.authToken) {
    const headers: Record<string, string> = {
      ...(definition.headers ?? {}),
      ...config.extraHeaders,
    };
    if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
    merged.headers = headers;
  }
  return merged;
}

function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'canopy-health-check', version: '1.0.0' },
    },
  };
}

function isAbortLikeError(error: unknown): boolean {
  const name =
    error instanceof Error || isRecord(error) ? error.name : undefined;
  const message =
    error instanceof Error || isRecord(error) ? error.message : undefined;
  return (
    name === 'AbortError' ||
    (typeof message === 'string' && /abort|timeout/i.test(message))
  );
}

function normalizeError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  const normalized = new Error(
    isRecord(error) && typeof error.message === 'string'
      ? error.message
      : fallbackMessage,
  );
  if (isRecord(error) && typeof error.name === 'string') {
    normalized.name = error.name;
  }
  return normalized;
}

async function readJsonRpcMessage(
  response: Response,
  phase: 'initialize' | 'tools',
): Promise<McpJsonRpcMessage> {
  try {
    return await readMcpJsonRpcMessage(response);
  } catch (error) {
    if (error instanceof McpToolDiscoveryError) throw error;
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new McpToolDiscoveryError(
      isAbortLikeError(error)
        ? message
        : `Invalid MCP response body: ${message}`,
      isAbortLikeError(error) ? 'timeout' : 'invalid',
      phase,
    );
  }
}

async function sendInitializedNotification(
  url: string,
  headers: Record<string, string>,
  safeTarget: SafeHttpTarget,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchWithSafeRedirects(
      url,
      headers,
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
      controller.signal,
      'tools',
      safeTarget,
    );
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new McpToolDiscoveryError(
        `HTTP ${String(response.status)}: ${response.statusText}`,
        'tools-http',
        'tools',
        response.status,
      );
    }
  } catch (error) {
    if (error instanceof McpToolDiscoveryError) throw error;
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new McpToolDiscoveryError(
      message,
      isAbortLikeError(error) ? 'timeout' : 'network',
      'tools',
    );
  } finally {
    clearTimeout(timeout);
  }
}

interface JsonRpcHttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  sessionId: string | null;
  message: Record<string, unknown> | null;
  responseBytes: number;
  safeTarget: SafeHttpTarget;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return (
    (family === 4 && PRIVATE_NETWORKS.check(address, 'ipv4')) ||
    (family === 6 && PRIVATE_NETWORKS.check(address, 'ipv6'))
  );
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  return (
    (family === 4 && LOOPBACK_NETWORKS.check(address, 'ipv4')) ||
    (family === 6 && LOOPBACK_NETWORKS.check(address, 'ipv6'))
  );
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || isLoopbackAddress(normalized);
}

export interface SafeHttpTarget {
  url: URL;
  addresses: PinnedHttpAddress[];
}

async function resolveSafeHttpTarget(
  rawUrl: string,
  phase: 'initialize' | 'tools',
  signal: AbortSignal,
): Promise<SafeHttpTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new McpToolDiscoveryError(
      'MCP endpoint URL is invalid',
      'invalid',
      phase,
    );
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new McpToolDiscoveryError(
      'MCP endpoint must use HTTP(S) without embedded credentials',
      'invalid',
      phase,
    );
  }
  const lookupHostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const onAbort = (): void => {
      reject(normalizeError(signal.reason, 'MCP DNS lookup aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void lookup(lookupHostname, { all: true, verbatim: true }).then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(normalizeError(error, 'MCP DNS lookup failed'));
      },
    );
  });
  const explicitlyConfiguredLoopback = isExplicitLoopbackHostname(url.hostname);
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address }) =>
        isPrivateAddress(address) &&
        !(explicitlyConfiguredLoopback && isLoopbackAddress(address)),
    )
  ) {
    throw new McpToolDiscoveryError(
      'MCP endpoint resolves to a private or reserved network address',
      'invalid',
      phase,
    );
  }
  return {
    url,
    addresses: addresses.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    })),
  };
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

export async function fetchWithSafeRedirects(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
  phase: 'initialize' | 'tools',
  safeTarget?: SafeHttpTarget,
): Promise<Response> {
  const target =
    safeTarget ?? (await resolveSafeHttpTarget(url, phase, signal));
  let requestUrl = target.url;
  let redirects = 0;
  const encodedBody = JSON.stringify(body);
  while (true) {
    const response = await fetchPinnedHttpResponse(
      requestUrl,
      target.addresses,
      headers,
      encodedBody,
      signal,
    );
    if (!isRedirectStatus(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) return response;
    if (redirects >= MCP_MAX_REDIRECTS) {
      throw new McpToolDiscoveryError(
        `MCP redirect limit of ${String(MCP_MAX_REDIRECTS)} exceeded`,
        'invalid',
        phase,
      );
    }
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, requestUrl);
    } catch {
      throw new McpToolDiscoveryError(
        'MCP redirect has an invalid Location header',
        'invalid',
        phase,
      );
    }
    if (
      redirectUrl.origin !== target.url.origin ||
      redirectUrl.username !== '' ||
      redirectUrl.password !== ''
    ) {
      throw new McpToolDiscoveryError(
        'MCP redirect must remain on the configured HTTP(S) origin',
        'invalid',
        phase,
      );
    }
    requestUrl = redirectUrl;
    redirects += 1;
  }
}

/**
 * POST one JSON-RPC request and read its response (plain JSON or SSE). The
 * timeout bounds the whole exchange, including the body read, because SSE
 * bodies can stay open after the response headers arrive.
 */
async function requestJsonRpc(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  phase: 'initialize' | 'tools',
  safeTarget?: SafeHttpTarget,
): Promise<JsonRpcHttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    let target: SafeHttpTarget;
    try {
      target =
        safeTarget ??
        (await resolveSafeHttpTarget(url, phase, controller.signal));
      response = await fetchWithSafeRedirects(
        url,
        headers,
        body,
        controller.signal,
        phase,
        target,
      );
    } catch (error) {
      if (error instanceof McpToolDiscoveryError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new McpToolDiscoveryError(
        message,
        isAbortLikeError(error) ? 'timeout' : 'network',
        phase,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        sessionId: response.headers.get('mcp-session-id'),
        message: null,
        responseBytes: 0,
        safeTarget: target,
      };
    }
    const rpcMessage = await readJsonRpcMessage(response, phase);
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      sessionId: response.headers.get('mcp-session-id'),
      message: rpcMessage.message,
      responseBytes: rpcMessage.bytesRead,
      safeTarget: target,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Initialize an HTTP MCP endpoint and return its advertised tool names. */
export async function discoverHttpTools(
  definition: McpServerDefinitionData,
): Promise<string[]> {
  if (!definition.url) {
    throw new McpToolDiscoveryError(
      'No URL configured',
      'invalid',
      'initialize',
    );
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: MCP_ACCEPT_HEADER,
    ...(definition.headers ?? {}),
  };
  const init = await requestJsonRpc(
    definition.url,
    headers,
    initializeBody(),
    30_000,
    'initialize',
  );
  const safeTarget = init.safeTarget;
  if (!init.ok) {
    throw new McpToolDiscoveryError(
      `HTTP ${String(init.status)}: ${init.statusText}`,
      init.status === 401 || init.status === 403 ? 'auth' : 'http',
      'initialize',
      init.status,
    );
  }
  const initData = init.message ?? {};
  if (initData.error) {
    const rpcError = initData.error;
    throw new McpToolDiscoveryError(
      isRecord(rpcError) && typeof rpcError.message === 'string'
        ? rpcError.message
        : JSON.stringify(rpcError),
      'rpc',
      'initialize',
    );
  }
  if (!isRecord(initData.result)) {
    throw new McpToolDiscoveryError(
      'Invalid MCP initialize response — missing result field',
      'invalid',
      'initialize',
    );
  }

  const negotiatedProtocolVersion = initData.result.protocolVersion;
  if (
    typeof negotiatedProtocolVersion !== 'string' ||
    !MCP_SUPPORTED_PROTOCOL_VERSIONS.has(negotiatedProtocolVersion)
  ) {
    throw new McpToolDiscoveryError(
      'MCP server returned an unsupported protocol version',
      'invalid',
      'initialize',
    );
  }

  const sessionId = init.sessionId;
  const sessionHeaders = {
    ...headers,
    'MCP-Protocol-Version': negotiatedProtocolVersion,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
  const url = definition.url;
  await sendInitializedNotification(url, sessionHeaders, safeTarget);
  return listMcpToolNames(async (request, timeoutMs) => {
    const toolsResult = await requestJsonRpc(
      url,
      sessionHeaders,
      request,
      timeoutMs,
      'tools',
      safeTarget,
    );
    if (!toolsResult.ok) {
      throw new McpToolDiscoveryError(
        `HTTP ${String(toolsResult.status)}`,
        'tools-http',
        'tools',
        toolsResult.status,
      );
    }
    return {
      message: toolsResult.message,
      responseBytes: toolsResult.responseBytes,
    };
  }, MCP_DISCOVERY_MAX_RESPONSE_BYTES);
}

async function readServer(serverId: string): Promise<McpServerFile> {
  const parsed: unknown = JSON.parse(
    await readFile(getMcpServerFilePath(serverId), 'utf8'),
  );
  return normalizeMcpServerFile(parsed, serverId);
}

/**
 * Return `definition` with the stored Canopy-managed OAuth access token
 * attached as an Authorization header, refreshing it first when needed.
 *
 * Health checks, connection tests, and tool discovery deliberately probe the
 * underlying MCP endpoint directly instead of routing through the local
 * Canopy proxy: a probe must report the real upstream verdict, not the
 * proxy's. When no valid token exists the definition is returned unchanged so
 * the upstream's own 401/403 drives the needs-auth verdict.
 */
export async function withStoredOAuthAuthorization(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
): Promise<McpServerDefinitionData> {
  if (
    definition.url === undefined ||
    new URL(definition.url).protocol !== 'https:'
  ) {
    return definition;
  }
  if (config.authToken) {
    return definition;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let accessToken: string | null;
  try {
    accessToken = await getValidMcpAccessToken(
      definition,
      config,
      controller.signal,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!accessToken) return definition;
  return {
    ...definition,
    headers: {
      ...(definition.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  };
}

function healthFromDiscoveryError(
  serverId: string,
  configId: string,
  error: unknown,
): McpServerHealthCheckResult {
  const now = new Date().toISOString();
  if (
    error instanceof McpToolDiscoveryError &&
    (error.kind === 'auth' ||
      (error.kind === 'tools-http' &&
        (error.statusCode === 401 || error.statusCode === 403)))
  ) {
    return {
      serverId,
      configId,
      status: 'needs_auth',
      statusCode: error.statusCode,
      message: error.message,
      checkedAt: now,
    };
  }
  if (error instanceof McpToolDiscoveryError && error.phase === 'tools') {
    return {
      serverId,
      configId,
      status: 'healthy',
      statusCode: error.statusCode,
      message: error.message,
      checkedAt: now,
    };
  }
  return {
    serverId,
    configId,
    status: 'unhealthy',
    message: error instanceof Error ? error.message : 'Tool discovery failed',
    checkedAt: now,
  };
}

/** Discover and cache tools for one concrete standalone server configuration. */
export async function discoverAndCacheMcpTools(
  serverId: string,
  configId: string,
  now: Date = new Date(),
): Promise<McpServerToolsCacheEntry> {
  const file = await readServer(serverId);
  const config = file.server.configs.find((entry) => entry.id === configId);
  if (!config)
    throw new Error(`Config ${configId} not found on server ${serverId}`);
  if (file.server.definition.type !== 'http') {
    throw new Error('Tool discovery is only supported for HTTP MCP servers');
  }
  const preferences = await readPreferencesFile();
  const handler: McpHttpAuthHandler = getMcpHttpAuthDefault(
    file.server.definition,
    await readMcpAccountIndexEntry(serverId),
    preferences.mcpHttpAuthDefaultHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
  );
  const definition = mergeConfigIntoDefinition(file.server.definition, config);
  let healthGeneration: number | undefined;
  try {
    const probeDefinition =
      handler === 'canopy'
        ? await withStoredOAuthAuthorization(definition, config)
        : definition;
    healthGeneration = getMcpServerHealthGeneration(serverId);
    const sourceFingerprint = await mcpToolsSourceFingerprint(
      file.server.definition,
      config,
      await getMcpOAuthTokenRevision(serverId, configId),
    );
    const tools =
      handler === 'account'
        ? await withAccountMcpProxy(
            file.server.definition,
            config,
            getMcpHttpProxyService(),
            preferences.mcpProxyPort,
            discoverHttpTools,
          )
        : await discoverHttpTools(probeDefinition);
    const entry = {
      tools,
      discoveredAt: now.toISOString(),
      sourceFingerprint,
    };
    await writeMcpToolsCacheEntry(serverId, configId, entry);
    recordMcpServerHealth(
      {
        serverId,
        configId,
        status: 'healthy',
        message: 'Server is responding',
        checkedAt: now.toISOString(),
      },
      healthGeneration,
    );
    return entry;
  } catch (error) {
    recordMcpServerHealth(
      healthFromDiscoveryError(serverId, configId, error),
      healthGeneration ?? getMcpServerHealthGeneration(serverId),
    );
    throw error;
  }
}

function entryIsStale(
  entry: McpServerToolsCacheEntry | undefined,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (!entry) return true;
  const discoveredAt = Date.parse(entry.discoveredAt);
  return !Number.isFinite(discoveredAt) || nowMs - discoveredAt >= maxAgeMs;
}

/** Sequentially refresh stale authoritative HTTP tool entries with isolation. */
export async function refreshStaleMcpTools(
  now: Date = new Date(),
  maxAgeMs: number = MCP_TOOLS_MAX_AGE_MS,
): Promise<void> {
  let index: McpServersIndexFile;
  try {
    const parsed: unknown = JSON.parse(
      await readFile(getMcpServersIndexFilePath(), 'utf8'),
    );
    if (!isMcpServersIndexFile(parsed)) return;
    index = parsed;
  } catch {
    return;
  }
  if (index.version !== 1 || !Array.isArray(index.servers)) return;
  const cache = await readMcpToolsCache();
  for (const indexed of index.servers) {
    if (indexed.type !== 'http') continue;
    try {
      const file = await readServer(indexed.id);
      const config =
        file.server.configs.find((entry) => entry.enabled) ??
        file.server.configs[0];
      if (!config || !config.enabled) continue;
      const oauthRevision = await getMcpOAuthTokenRevision(
        indexed.id,
        config.id,
      );
      if (
        !entryIsStale(
          cache.entries[cacheKey(indexed.id, config.id)]?.sourceFingerprint ===
            (await mcpToolsSourceFingerprint(
              file.server.definition,
              config,
              oauthRevision,
            ))
            ? cache.entries[cacheKey(indexed.id, config.id)]
            : undefined,
          now.getTime(),
          maxAgeMs,
        )
      ) {
        continue;
      }
      await discoverAndCacheMcpTools(indexed.id, config.id, now);
    } catch {
      // A failed endpoint must not prevent later local servers from refreshing.
    }
  }
}
