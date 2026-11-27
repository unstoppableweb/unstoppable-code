import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  McpOAuthConfigData,
  McpServerConfigData,
  McpServerDefinitionData,
} from '@canopy/execution-engine/types/mcp-servers';

const SYNTHETIC_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export interface PluginMcpAuthIdentity {
  marketplaceId: string;
  pluginName: string;
  serverName: string;
  /** Distinguishes a Codex inventory row; legacy ID lookup takes its historical slot. */
  authNamespace?: 'codex';
}

export interface PluginHttpMcpServerForAuth {
  definition: McpServerDefinitionData;
  config: McpServerConfigData;
  headers: Record<string, string>;
  missingAuthEnvVars: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const entry = value[key];
  return typeof entry === 'string' && entry.trim().length > 0
    ? entry.trim()
    : undefined;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const entry = value[key];
  return typeof entry === 'boolean' ? entry : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const result = value.filter((entry): entry is string => {
      return typeof entry === 'string' && entry.trim().length > 0;
    });
    return result.length > 0 ? result : undefined;
  }

  if (typeof value === 'string') {
    const result = value
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return result.length > 0 ? result : undefined;
  }

  return undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function hasStringRecordEntries(
  value: unknown,
): value is Record<string, string> {
  return isStringRecord(value) && Object.keys(value).length > 0;
}

function isAuthHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === 'authorization' ||
    normalized === 'proxy-authorization' ||
    normalized.includes('api-key') ||
    normalized.includes('api_key') ||
    normalized.includes('token') ||
    normalized.includes('secret')
  );
}

function hasAuthHeader(value: unknown): boolean {
  return (
    hasStringRecordEntries(value) &&
    Object.keys(value).some((name) => isAuthHeaderName(name))
  );
}

export function hasPluginManagedAuth(
  rawValue: Record<string, unknown>,
): boolean {
  return (
    hasAuthHeader(rawValue.headers) ||
    hasAuthHeader(rawValue.http_headers) ||
    hasAuthHeader(rawValue.env_http_headers) ||
    typeof rawValue.bearer_token_env_var === 'string'
  );
}

export function hasPluginOAuthLikeMetadata(
  rawValue: Record<string, unknown>,
): boolean {
  return (
    isRecord(rawValue.oauth) ||
    typeof rawValue.authorizationUrl === 'string' ||
    typeof rawValue.authorization_url === 'string' ||
    typeof rawValue.tokenUrl === 'string' ||
    typeof rawValue.token_url === 'string' ||
    typeof rawValue.clientId === 'string' ||
    typeof rawValue.client_id === 'string'
  );
}
/** Every declaration field {@link resolvePluginHttpHeaders} reads a header from. */
const PLUGIN_MCP_HEADER_FIELDS = [
  'headers',
  'http_headers',
  'env_http_headers',
  'bearer_token_env_var',
] as const;

/**
 * Whether a declaration sets request headers of its own, from any field
 * {@link resolvePluginHttpHeaders} reads, whether or not the environment
 * variables it names are set right now.
 */
export function declaresPluginMcpHeaders(
  rawValue: Record<string, unknown>,
): boolean {
  return PLUGIN_MCP_HEADER_FIELDS.some(
    (field): boolean => rawValue[field] !== undefined,
  );
}

export function resolvePluginHttpHeaders(rawValue: Record<string, unknown>): {
  headers: Record<string, string>;
  missingEnvVars: string[];
} {
  const headers: Record<string, string> = {};
  const missingEnvVars: string[] = [];

  if (isStringRecord(rawValue.headers)) {
    Object.assign(headers, rawValue.headers);
  }
  if (isStringRecord(rawValue.http_headers)) {
    Object.assign(headers, rawValue.http_headers);
  }

  const bearerTokenEnvVar = readString(rawValue, 'bearer_token_env_var');
  if (bearerTokenEnvVar) {
    const token = process.env[bearerTokenEnvVar];
    if (token && token.trim().length > 0) {
      headers.Authorization = `Bearer ${token}`;
    } else {
      missingEnvVars.push(bearerTokenEnvVar);
    }
  }

  if (isStringRecord(rawValue.env_http_headers)) {
    for (const [headerName, envVarName] of Object.entries(
      rawValue.env_http_headers,
    )) {
      const value = process.env[envVarName];
      if (value && value.trim().length > 0) {
        headers[headerName] = value;
      } else {
        missingEnvVars.push(envVarName);
      }
    }
  }

  return {
    headers,
    missingEnvVars,
  };
}

export function getLegacyPluginMcpOAuthIds(identity: PluginMcpAuthIdentity): {
  serverId: string;
  configId: string;
} {
  const digest = createHash('sha256')
    .update(
      `${identity.marketplaceId}\0${identity.pluginName}\0${identity.serverName}${identity.authNamespace ? `\0${identity.authNamespace}` : ''}`,
    )
    .digest('hex');
  return {
    serverId: digest.slice(0, 32),
    configId: digest.slice(32, 64),
  };
}

/** Shared by inventory equivalence and credential keys; never resolves environment secrets. */
function canonicalPluginMcpAuthDeclaration(
  rawValue: Record<string, unknown>,
  normalizeEquivalentValues = true,
): string {
  let url = readString(rawValue, 'url') ?? '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    url = parsed.toString();
  } catch {
    // Preserve downstream validation of malformed declarations.
  }
  const headers = {
    ...(isStringRecord(rawValue.headers) ? rawValue.headers : {}),
    ...(isStringRecord(rawValue.http_headers) ? rawValue.http_headers : {}),
  };
  const sortedHeaders = (value: Record<string, string>): object => {
    const entries = new Map<string, string[]>();
    for (const [name, content] of Object.entries(value)) {
      const key = normalizeEquivalentValues ? name.toLowerCase() : name;
      const values = entries.get(key) ?? [];
      values.push(content);
      entries.set(key, values);
    }
    return Object.fromEntries(
      Array.from(entries)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, values]) => [
          name,
          values.length === 1 ? values[0] : values,
        ]),
    );
  };
  // Preserve conflicting case-duplicate headers in order rather than choosing
  // a credential or environment binding that the runtime did not choose.
  const oauth = parsePluginOAuthConfig(rawValue);
  if (normalizeEquivalentValues && oauth.scopes) {
    oauth.scopes = Array.from(
      new Set(oauth.scopes.map((scope) => scope.trim())),
    ).sort();
  }
  return JSON.stringify({
    url,
    oauth,
    headers: sortedHeaders(headers),
    envHeaders: sortedHeaders(
      isStringRecord(rawValue.env_http_headers)
        ? rawValue.env_http_headers
        : {},
    ),
    bearerTokenEnvVar: readString(rawValue, 'bearer_token_env_var'),
  });
}

/** Credential keys depend on this declaration, never another installed facet. */
function getPluginMcpOAuthIds(
  identity: PluginMcpAuthIdentity,
  rawValue: Record<string, unknown>,
  normalizeEquivalentValues = true,
): { serverId: string; configId: string } {
  const declaration = canonicalPluginMcpAuthDeclaration(
    rawValue,
    normalizeEquivalentValues,
  );
  const digest = createHash('sha256')
    .update(
      `${identity.marketplaceId}\0${identity.pluginName}\0${identity.serverName}\0oauth-v2\0${declaration}`,
    )
    .digest('hex');
  return { serverId: digest.slice(0, 32), configId: digest.slice(32, 64) };
}

/** Exact pre-normalization declaration key, used only for a bound token migration. */
export function getPreviousDeclarationPluginMcpOAuthIds(
  identity: PluginMcpAuthIdentity,
  rawValue: Record<string, unknown>,
): { serverId: string; configId: string } {
  return getPluginMcpOAuthIds(identity, rawValue, false);
}

function parsePluginOAuthConfig(
  rawValue: Record<string, unknown>,
): McpOAuthConfigData {
  const rawOAuth = isRecord(rawValue.oauth) ? rawValue.oauth : {};
  const scopes =
    readStringArray(rawOAuth.scopes) ??
    readStringArray(rawOAuth.scope) ??
    readStringArray(rawValue.scopes) ??
    readStringArray(rawValue.scope);

  return {
    clientId:
      readString(rawOAuth, 'clientId') ??
      readString(rawOAuth, 'client_id') ??
      readString(rawValue, 'clientId') ??
      readString(rawValue, 'client_id'),
    clientSecret:
      readString(rawOAuth, 'clientSecret') ??
      readString(rawOAuth, 'client_secret') ??
      readString(rawValue, 'clientSecret') ??
      readString(rawValue, 'client_secret'),
    authorizationUrl:
      readString(rawOAuth, 'authorizationUrl') ??
      readString(rawOAuth, 'authorization_url') ??
      readString(rawValue, 'authorizationUrl') ??
      readString(rawValue, 'authorization_url'),
    tokenUrl:
      readString(rawOAuth, 'tokenUrl') ??
      readString(rawOAuth, 'token_url') ??
      readString(rawValue, 'tokenUrl') ??
      readString(rawValue, 'token_url'),
    scopes,
    audience:
      readString(rawOAuth, 'audience') ?? readString(rawValue, 'audience'),
    usePkce:
      readBoolean(rawOAuth, 'usePkce') ??
      readBoolean(rawOAuth, 'use_pkce') ??
      readBoolean(rawValue, 'usePkce') ??
      readBoolean(rawValue, 'use_pkce') ??
      true,
  };
}

/** Keep historical slot selection unchanged while migrating old credentials. */
export function getLegacyPluginMcpAuthNamespace(
  rawValue: Record<string, unknown>,
  primary: Record<string, unknown> | undefined,
): 'codex' | undefined {
  if (!primary) return 'codex';
  const authDefinition = (value: Record<string, unknown>): unknown => {
    const url = readString(value, 'url');
    if (!url || (value.type && value.type !== 'http')) return value;
    return {
      url,
      ...resolvePluginHttpHeaders(value),
      oauth: parsePluginOAuthConfig(value),
    };
  };
  return isDeepStrictEqual(authDefinition(rawValue), authDefinition(primary))
    ? undefined
    : 'codex';
}

/** Equivalent HTTP facets must share both an inventory row and credential keys. */
export function getPluginMcpAuthNamespace(
  rawValue: Record<string, unknown>,
  primary: Record<string, unknown> | undefined,
): 'codex' | undefined {
  if (!primary) return 'codex';
  const isHttp = (value: Record<string, unknown>): boolean =>
    Boolean(readString(value, 'url')) && (!value.type || value.type === 'http');
  const equivalent =
    isHttp(rawValue) && isHttp(primary)
      ? canonicalPluginMcpAuthDeclaration(rawValue) ===
        canonicalPluginMcpAuthDeclaration(primary)
      : isDeepStrictEqual(rawValue, primary);
  return equivalent ? undefined : 'codex';
}

export function buildPluginHttpMcpServerForAuth(
  identity: PluginMcpAuthIdentity,
  rawValue: Record<string, unknown>,
  forceOAuth: boolean,
): PluginHttpMcpServerForAuth | null {
  const url = readString(rawValue, 'url');
  if (!url || (rawValue.type && rawValue.type !== 'http')) {
    return null;
  }

  const ids = getPluginMcpOAuthIds(identity, rawValue);
  const oauth =
    hasPluginOAuthLikeMetadata(rawValue) || forceOAuth
      ? parsePluginOAuthConfig(rawValue)
      : undefined;
  const resolvedHeaders = resolvePluginHttpHeaders(rawValue);

  return {
    definition: {
      id: ids.serverId,
      name: identity.serverName,
      description: '',
      type: 'http',
      url,
      headers: resolvedHeaders.headers,
      oauth,
      createdAt: SYNTHETIC_TIMESTAMP,
      updatedAt: SYNTHETIC_TIMESTAMP,
    },
    config: {
      id: ids.configId,
      name: 'Plugin',
      description: '',
      enabled: true,
      envVars: {},
      extraArgs: [],
      extraHeaders: {},
      createdAt: SYNTHETIC_TIMESTAMP,
      updatedAt: SYNTHETIC_TIMESTAMP,
    },
    headers: resolvedHeaders.headers,
    missingAuthEnvVars: resolvedHeaders.missingEnvVars,
  };
}
