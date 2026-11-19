import { BRAND } from '@canopy/brand/current';
import { createHash } from 'node:crypto';
import {
  MCP_ACCEPT_HEADER,
  readMcpJsonRpcMessage,
} from '@canopy/mcp-oauth-core';
import { resolveE2eMcpOAuthFixtureUrl } from './oauth-e2e-fixture';
import { noteMcpEgressHost } from '../local-only/mcp-egress-hosts';

export interface AuthorizationChallenge {
  resourceMetadataUrl?: string;
  scopes?: string[];
}

export interface McpHttpOAuthProbeResult {
  requirement: 'oauth' | 'none' | 'unknown';
  requiresOAuth: boolean;
  challenge: AuthorizationChallenge;
}

const MAX_PROBE_CACHE_ENTRIES = 256;
const oauthProbeCache = new Map<string, McpHttpOAuthProbeResult>();

function buildOAuthProbeCacheKey(
  mcpUrl: string,
  headers: Record<string, string>,
): string {
  const normalizedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    normalizedHeaders[normalizedName] = value;
  }

  // Bind discovery to every credential/header value without retaining secrets
  // or credential-bearing endpoints in cache keys.
  return createHash('sha256')
    .update(
      JSON.stringify({
        mcpUrl,
        headers: Object.entries(normalizedHeaders).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      }),
    )
    .digest('hex');
}

function setProbeCacheEntry(
  cacheKey: string,
  result: McpHttpOAuthProbeResult,
): void {
  oauthProbeCache.set(cacheKey, result);
  if (oauthProbeCache.size > MAX_PROBE_CACHE_ENTRIES) {
    const oldest = oauthProbeCache.keys().next().value;
    if (typeof oldest === 'string') {
      oauthProbeCache.delete(oldest);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidInitializeResponse(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.jsonrpc !== '2.0' ||
    value.id !== 1 ||
    value.error !== undefined
  ) {
    return false;
  }
  const result = value.result;
  if (!isRecord(result) || typeof result.protocolVersion !== 'string') {
    return false;
  }
  const capabilities = result.capabilities;
  const serverInfo = result.serverInfo;
  return (
    isRecord(capabilities) &&
    isRecord(serverInfo) &&
    typeof serverInfo.name === 'string' &&
    typeof serverInfo.version === 'string'
  );
}

function splitScopes(value: string | undefined): string[] {
  return value
    ? value
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0)
    : [];
}

function parseWwwAuthenticateHeader(
  header: string | null,
): AuthorizationChallenge {
  if (!header) {
    return {};
  }

  const match = header.match(/Bearer\s+(.+)/i);
  if (!match) {
    return {};
  }

  const params: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))/g;
  let paramMatch: RegExpExecArray | null = pattern.exec(match[1]);
  while (paramMatch) {
    params[paramMatch[1]] = paramMatch[2] ?? paramMatch[3] ?? '';
    paramMatch = pattern.exec(match[1]);
  }

  return {
    resourceMetadataUrl: params.resource_metadata,
    scopes: splitScopes(params.scope),
  };
}

export async function probeMcpHttpOAuthRequirement(
  mcpUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = 3_000,
  options: { cacheOnly?: boolean } = {},
): Promise<McpHttpOAuthProbeResult> {
  // Passive inventory must never initialize a remote server: initialization
  // can itself trigger an out-of-band authorization prompt at the provider.
  if (options.cacheOnly) {
    return (
      oauthProbeCache.get(buildOAuthProbeCacheKey(mcpUrl, headers)) ?? {
        requirement: 'unknown',
        requiresOAuth: false,
        challenge: {},
      }
    );
  }
  return probeMcpHttpOAuthRequirementInternal(mcpUrl, headers, timeoutMs, true);
}

export async function probeMcpHttpOAuthRequirementUncached(
  mcpUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = 3_000,
): Promise<McpHttpOAuthProbeResult> {
  return probeMcpHttpOAuthRequirementInternal(
    mcpUrl,
    headers,
    timeoutMs,
    false,
  );
}

async function probeMcpHttpOAuthRequirementInternal(
  mcpUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  useCache: boolean,
): Promise<McpHttpOAuthProbeResult> {
  const cacheKey = buildOAuthProbeCacheKey(mcpUrl, headers);
  const cached = oauthProbeCache.get(cacheKey);
  if (useCache && cached) {
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout((): void => {
    controller.abort();
  }, timeoutMs);

  try {
    const requestUrl =
      resolveE2eMcpOAuthFixtureUrl(new URL(mcpUrl)) ?? new URL(mcpUrl);
    noteMcpEgressHost(requestUrl);
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT_HEADER,
      },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: `${BRAND.internalName}-oauth-discovery`,
            version: '1.0.0',
          },
        },
      }),
    });
    try {
      const authenticateHeader = response.headers.get('www-authenticate');
      const challenge = parseWwwAuthenticateHeader(authenticateHeader);
      const requiresOAuth =
        (response.status === 401 || response.status === 403) &&
        /Bearer/i.test(authenticateHeader ?? '');
      let requirement: McpHttpOAuthProbeResult['requirement'] = 'unknown';
      if (requiresOAuth) {
        requirement = 'oauth';
      } else if (response.ok && !response.redirected) {
        try {
          const { message } = await readMcpJsonRpcMessage(response);
          requirement = isValidInitializeResponse(message) ? 'none' : 'unknown';
        } catch {
          requirement = 'unknown';
        }
      }
      const result: McpHttpOAuthProbeResult = {
        requirement,
        requiresOAuth,
        challenge,
      };
      if (useCache && requirement !== 'unknown') {
        setProbeCacheEntry(cacheKey, result);
      }
      return result;
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch {
    return {
      requirement: 'unknown',
      requiresOAuth: false,
      challenge: {},
    };
  } finally {
    clearTimeout(timeout);
  }
}
