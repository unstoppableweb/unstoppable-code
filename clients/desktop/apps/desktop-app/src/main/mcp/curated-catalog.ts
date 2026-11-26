import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { parseHarnessCompatibility } from '@canopy/protocol/plugins';
import {
  MCP_CATALOG_API_VERSION,
  curatedMcpDesktopOnly,
  isCuratedMcpServerListResponse,
  type CuratedMcpOAuthHints,
  type CuratedMcpProviderConnector,
  type CuratedMcpServerEntry,
  type CuratedMcpServerListResponse,
} from '@canopy/protocol/mcp-catalog';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  requestCanopyCloudPublicJson,
} from '../canopy-cloud/client';
import { getCuratedMcpCatalogFilePath } from '../lib/paths';

export const CURATED_CATALOG_MAX_AGE_MS = 60 * 60_000;
const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;

interface CuratedCatalogCacheFile {
  version: 1;
  fetchedAt: string;
  servers: CuratedMcpServerEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EMPTY_RESPONSE: CuratedMcpServerListResponse = {
  version: MCP_CATALOG_API_VERSION,
  servers: [],
};

export type CuratedMcpCatalogResolution =
  | {
      status: 'verified';
      catalog: CuratedMcpServerListResponse;
    }
  | { status: 'unavailable' };

function normalizeOAuthHints(
  hints: CuratedMcpOAuthHints | undefined,
): CuratedMcpOAuthHints | undefined {
  if (!hints) return undefined;
  const normalized: CuratedMcpOAuthHints = {
    ...(hints.authorizationUrl !== undefined
      ? { authorizationUrl: hints.authorizationUrl }
      : {}),
    ...(hints.tokenUrl !== undefined ? { tokenUrl: hints.tokenUrl } : {}),
    ...(hints.scopes !== undefined ? { scopes: [...hints.scopes] } : {}),
    ...(hints.audience !== undefined ? { audience: hints.audience } : {}),
    ...(hints.usePkce !== undefined ? { usePkce: hints.usePkce } : {}),
    ...(hints.clientId !== undefined ? { clientId: hints.clientId } : {}),
    ...(hints.callbackPort !== undefined
      ? { callbackPort: hints.callbackPort }
      : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Copy the connector config the hub sets.
 *
 * `normalizeServer` rebuilds entries field by field, so anything it does not
 * name is dropped with no error anywhere. This field is the only source of
 * which connectors are advertised, so omitting it turns the hub's checkbox into
 * a silent no-op.
 */
function normalizeProviderConnector(
  connector: CuratedMcpProviderConnector | undefined,
): CuratedMcpProviderConnector | undefined {
  if (!connector) return undefined;
  return {
    providers: [...connector.providers],
    ...(connector.claudeConnectorName !== undefined
      ? { claudeConnectorName: connector.claudeConnectorName }
      : {}),
    ...(connector.codexConnectorId !== undefined
      ? { codexConnectorId: connector.codexConnectorId }
      : {}),
  };
}

function normalizeServer(server: CuratedMcpServerEntry): CuratedMcpServerEntry {
  const oauthHints = normalizeOAuthHints(server.oauthHints);
  const providerConnector = normalizeProviderConnector(
    server.providerConnector,
  );
  return {
    harnessCompatibility: parseHarnessCompatibility(
      server.harnessCompatibility,
    ),
    key: server.key.trim(),
    name: server.name.trim(),
    shortDescription: server.shortDescription.trim(),
    ...(server.tryNowPrompt !== undefined
      ? { tryNowPrompt: server.tryNowPrompt }
      : {}),
    ...(server.longDescription !== undefined
      ? { longDescription: server.longDescription }
      : {}),
    ...(server.logoUrl !== undefined ? { logoUrl: server.logoUrl } : {}),
    url: server.url,
    transport: 'http',
    ...(oauthHints ? { oauthHints } : {}),
    ...(server.platformOAuth === true ? { platformOAuth: true } : {}),
    ...(providerConnector ? { providerConnector } : {}),
    // Named here for the same reason as `providerConnector`: a field this
    // rebuild omits is dropped, and Add would then route a desktop-only
    // server to an account connection the cloud cannot complete.
    ...(server.availability !== undefined
      ? { availability: server.availability }
      : {}),
    ...(server.requiredConfigFields !== undefined
      ? {
          requiredConfigFields: server.requiredConfigFields.map((field) => ({
            ...field,
          })),
        }
      : {}),
    ...(server.urlOptions !== undefined
      ? { urlOptions: server.urlOptions.map((option) => ({ ...option })) }
      : {}),
    ...(server.setupInstructions !== undefined
      ? { setupInstructions: server.setupInstructions }
      : {}),
    ...(server.authorName !== undefined
      ? { authorName: server.authorName }
      : {}),
    ...(server.authorUrl !== undefined ? { authorUrl: server.authorUrl } : {}),
    ...(server.docsUrl !== undefined ? { docsUrl: server.docsUrl } : {}),
    ...(server.supportUrl !== undefined
      ? { supportUrl: server.supportUrl }
      : {}),
    ...(server.privacyPolicyUrl !== undefined
      ? { privacyPolicyUrl: server.privacyPolicyUrl }
      : {}),
    categories: [...server.categories],
    popular: server.popular,
    sortOrder: server.sortOrder,
    updatedAt: server.updatedAt,
  };
}

export function normalizeCuratedCatalogResponse(
  value: unknown,
): CuratedMcpServerListResponse | null {
  if (
    !isCuratedMcpServerListResponse(value) ||
    value.version !== MCP_CATALOG_API_VERSION
  ) {
    return null;
  }
  const servers = value.servers.map(normalizeServer);
  if (
    servers.some(
      (server) => server.key.length === 0 || server.name.length === 0,
    )
  ) {
    return null;
  }
  return { version: MCP_CATALOG_API_VERSION, servers };
}

async function readCache(): Promise<CuratedCatalogCacheFile | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(getCuratedMcpCatalogFilePath(), 'utf8'),
    );
    if (!isRecord(parsed)) return null;
    const normalized = normalizeCuratedCatalogResponse({
      version: parsed.version,
      servers: parsed.servers,
    });
    if (
      parsed.version !== 1 ||
      typeof parsed.fetchedAt !== 'string' ||
      !normalized
    ) {
      return null;
    }
    return {
      version: 1,
      fetchedAt: parsed.fetchedAt,
      servers: normalized.servers,
    };
  } catch {
    return null;
  }
}

async function writeCache(
  response: CuratedMcpServerListResponse,
  fetchedAt: string,
): Promise<void> {
  const filePath = getCuratedMcpCatalogFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const cache: CuratedCatalogCacheFile = {
    version: 1,
    fetchedAt,
    servers: response.servers,
  };
  await writeFile(filePath, JSON.stringify(cache, null, 2), 'utf8');
}

function cacheResponse(
  cache: CuratedCatalogCacheFile | null,
): CuratedMcpServerListResponse {
  return cache
    ? { version: MCP_CATALOG_API_VERSION, servers: cache.servers }
    : EMPTY_RESPONSE;
}

function cacheIsFresh(cache: CuratedCatalogCacheFile, nowMs: number): boolean {
  const fetchedAt = Date.parse(cache.fetchedAt);
  return (
    Number.isFinite(fetchedAt) && nowMs - fetchedAt < CURATED_CATALOG_MAX_AGE_MS
  );
}

async function fetchCatalog(
  now: Date,
): Promise<CuratedMcpServerListResponse | null> {
  try {
    let raw: unknown;
    try {
      raw = await requestCanopyCloudJson<unknown>(
        `${API_PREFIX}/mcp-servers/curated`,
      );
    } catch (error) {
      if (
        !(error instanceof CanopyCloudClientError) ||
        error.code !== 'missing-api-key'
      ) {
        throw error;
      }
      raw = await requestCanopyCloudPublicJson<unknown>(
        '/api/v1/mcp-servers/curated',
      );
    }
    const normalized = normalizeCuratedCatalogResponse(raw);
    if (!normalized) return null;
    try {
      await writeCache(normalized, now.toISOString());
    } catch {
      // A read-only or temporarily unavailable cache must not hide live data.
    }
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Keys of the cached catalog's desktop-only servers (REG-3035), whatever the
 * cache's age. Plugin binding reads this on the session-start path, so it
 * never waits on the cloud: the catalog that synced the curated plugins and
 * fed the Plugins page wrote this cache, and the cloud proxy refuses a
 * desktop-only connection on its own when the cache is missing or behind.
 */
export async function readCachedCuratedMcpDesktopOnlyKeys(): Promise<
  ReadonlySet<string>
> {
  const cache = await readCache();
  return new Set(
    (cache?.servers ?? [])
      .filter((server): boolean => curatedMcpDesktopOnly(server))
      .map((server): string => server.key),
  );
}

/** Read-only recommendation lookup; absence never triggers a refresh. */
export async function readCachedCuratedMcpServers(): Promise<CuratedMcpServerListResponse | null> {
  const cache = await readCache();
  return cache ? cacheResponse(cache) : null;
}

/** Serve fresh data when available, retaining the last valid catalog offline. */
export async function listCuratedMcpServers(
  now: Date = new Date(),
): Promise<CuratedMcpServerListResponse> {
  const cache = await readCache();
  if (cache && cacheIsFresh(cache, now.getTime())) return cacheResponse(cache);
  return (await fetchCatalog(now)) ?? cacheResponse(cache);
}

/** Force a cloud request, retaining the last valid catalog on failure. */
export async function refreshCuratedMcpServers(
  now: Date = new Date(),
): Promise<CuratedMcpServerListResponse> {
  return (await fetchCatalog(now)) ?? cacheResponse(await readCache());
}

/**
 * Resolve the MCP catalog for plugin materialization without collapsing an
 * unavailable refresh into an authoritative empty catalog.
 */
export async function resolveCuratedMcpCatalogForSync(
  now: Date = new Date(),
): Promise<CuratedMcpCatalogResolution> {
  const cache = await readCache();
  if (cache && cacheIsFresh(cache, now.getTime())) {
    return { status: 'verified', catalog: cacheResponse(cache) };
  }
  const catalog = await fetchCatalog(now);
  return catalog ? { status: 'verified', catalog } : { status: 'unavailable' };
}
