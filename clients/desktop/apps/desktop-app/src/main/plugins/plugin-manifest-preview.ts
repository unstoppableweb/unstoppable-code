import {
  classifyHarnessCompatibility,
  parseGitHubRepo,
  type CompatibilityFacetEvidence,
  type PublisherPluginManifest,
} from '@canopy/plugin-interop';
import {
  PLUGIN_MANIFEST_PREVIEW_MAX_NAMES,
  PLUGIN_MANIFEST_PREVIEW_NAME_MAX_LENGTH,
  type PluginInfo,
  type PluginManifestPreview,
  type PluginManifestPreviewFailure,
  type PluginManifestPreviewResult,
} from '@canopy/protocol/plugins';
import { allowsAutomaticCall } from '../local-only/policy';
import { loadMarketplacesCacheOnly } from './plugin-service';

/**
 * Customize's light preview of a plugin not added yet (spec 3b): the
 * repository's file listing and its native manifests, read without cloning,
 * classified by the same compatibility rules as a scanned plugin. Cached in
 * memory like the logo cache; a host that asks us to wait is waited for.
 */

const API_HOST = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 750;
const MAX_TREE_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
/** GitHub's identifiers: `owner/repo`, and a commit sha. */
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** Native manifests, by the harness that reads them. */
const NATIVE_MANIFEST_PATHS: readonly string[] = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.github/plugin/plugin.json',
];

/** Manifest keys that move a plugin's parts out of their usual folders. */
const CUSTOM_ROOT_KEYS = [
  'skills',
  'commands',
  'agents',
  'hooks',
  'mcpServers',
  'lspServers',
];

class PreviewFailure extends Error {
  constructor(readonly reason: PluginManifestPreviewFailure) {
    super(reason);
    this.name = 'PreviewFailure';
  }
}

interface CacheEntry {
  readonly result: Promise<PluginManifestPreviewResult>;
}

const cache = new Map<string, CacheEntry>();
/** The host's own "try again after"; no request goes out before it. */
let rateLimitedUntil = 0;

/** Clears the cache and the rate-limit wait; tests and sign-out use it. */
export function resetPluginManifestPreviewCache(): void {
  cache.clear();
  rateLimitedUntil = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One GET, with one polite retry for a transient failure. */
async function fetchText(url: string, maxBytes: number): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (Date.now() < rateLimitedUntil) throw new PreviewFailure('rate_limited');
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'plugin-manifest-preview',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new PreviewFailure('unavailable');
    }
    if (response.status === 404) throw new PreviewFailure('not_found');
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get('x-ratelimit-remaining') === '0')
    ) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      rateLimitedUntil =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Date.now() + retryAfter * 1000
          : Number.isFinite(reset) && reset > 0
            ? reset * 1000
            : Date.now() + FAILURE_TTL_MS;
      throw new PreviewFailure('rate_limited');
    }
    if (response.status >= 500 && attempt === 0) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (!response.ok) throw new PreviewFailure('unavailable');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes)
      throw new PreviewFailure('unavailable');
    const text = await response.text();
    if (text.length > maxBytes) throw new PreviewFailure('unavailable');
    return text;
  }
  throw new PreviewFailure('unavailable');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The listing's file paths, and whether GitHub cut it short. */
async function readTree(
  repo: string,
  ref: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const body = parseJson(
    await fetchText(
      `${API_HOST}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      MAX_TREE_BYTES,
    ),
  );
  if (!isRecord(body) || !Array.isArray(body.tree))
    throw new PreviewFailure('unavailable');
  const paths: string[] = [];
  for (const item of body.tree)
    if (isRecord(item) && item.type === 'blob' && typeof item.path === 'string')
      paths.push(item.path);
  return { paths, truncated: body.truncated === true };
}

/** Server names from `.mcp.json`: `{ mcpServers: {...} }` or the bare map. */
async function readMcpServerNames(
  repo: string,
  ref: string,
): Promise<string[]> {
  let body: unknown;
  try {
    body = parseJson(
      await fetchText(
        `${RAW_HOST}/${repo}/${ref}/.mcp.json`,
        MAX_MANIFEST_BYTES,
      ),
    );
  } catch (error) {
    if (error instanceof PreviewFailure && error.reason === 'rate_limited')
      throw error;
    return [];
  }
  if (!isRecord(body)) return [];
  const servers = isRecord(body.mcpServers) ? body.mcpServers : body;
  return Object.entries(servers).flatMap(([name, server]) =>
    isRecord(server) ? [name] : [],
  );
}

/** A manifest part that names something: a path, entries, or members. */
function declaresContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function capped(values: Iterable<string>): string[] {
  return [...new Set(values)]
    .filter(
      (value) =>
        value.length > 0 &&
        value.length <= PLUGIN_MANIFEST_PREVIEW_NAME_MAX_LENGTH,
    )
    .sort((a, b) => a.localeCompare(b))
    .slice(0, PLUGIN_MANIFEST_PREVIEW_MAX_NAMES);
}

function matches(paths: readonly string[], pattern: RegExp): string[] {
  return paths.flatMap((path) => {
    const match = pattern.exec(path);
    return match?.[1] ? [match[1]] : [];
  });
}

async function buildPreview(
  repo: string,
  ref: string,
  provider: 'claude' | 'codex',
): Promise<PluginManifestPreview> {
  const { paths, truncated } = await readTree(repo, ref);
  const listed = new Set(paths);
  const publisherManifests: PublisherPluginManifest[] = [];
  const unreadPublisherManifests: string[] = [];
  let customRoots = false;
  // Parts a manifest declares itself, wherever their files live.
  let declaresHooks = false;
  let declaresMcpServers = false;
  const inlineMcpServerNames: string[] = [];
  for (const path of NATIVE_MANIFEST_PATHS) {
    if (!listed.has(path)) continue;
    try {
      const manifest = parseJson(
        await fetchText(
          `${RAW_HOST}/${repo}/${ref}/${path}`,
          MAX_MANIFEST_BYTES,
        ),
      );
      if (manifest === undefined) {
        unreadPublisherManifests.push(path);
        continue;
      }
      publisherManifests.push({ path, manifest });
      if (isRecord(manifest)) {
        if (CUSTOM_ROOT_KEYS.some((key) => declaresContent(manifest[key])))
          customRoots = true;
        if (declaresContent(manifest.hooks)) declaresHooks = true;
        if (declaresContent(manifest.mcpServers)) declaresMcpServers = true;
        if (isRecord(manifest.mcpServers))
          for (const [name, server] of Object.entries(manifest.mcpServers))
            if (isRecord(server)) inlineMcpServerNames.push(name);
      }
    } catch (error) {
      // A rate limit stops the whole preview; a missing file is just unread.
      if (error instanceof PreviewFailure && error.reason === 'rate_limited')
        throw error;
      unreadPublisherManifests.push(path);
    }
  }
  const skills = capped(matches(paths, /^skills\/([^/]+)\/SKILL\.md$/i));
  const commands = capped(
    matches(paths, /^commands\/(?:[^/]+\/)*([^/]+)\.md$/i),
  );
  const agents = capped(matches(paths, /^agents\/([^/]+)\.md$/i));
  const hooks = declaresHooks || listed.has('hooks/hooks.json');
  const mcpConfig = listed.has('.mcp.json');
  const mcpServers = declaresMcpServers || mcpConfig;
  const mcpServerNames = capped([
    ...inlineMcpServerNames,
    ...(mcpConfig ? await readMcpServerNames(repo, ref) : []),
  ]);
  // What the listing alone can't settle (hook and MCP details, parts moved
  // by the manifest, a cut-short listing) leaves derived harnesses unknown;
  // native manifests still count.
  const facet: CompatibilityFacetEvidence = {
    complete:
      !truncated &&
      !hooks &&
      !mcpServers &&
      !customRoots &&
      unreadPublisherManifests.length === 0,
    rootApp: listed.has('.app.json'),
    inventory: {
      skills: skills.map((name) => ({ name })),
      commands: commands.map((name) => ({ name })),
      agents: agents.map((name) => ({ name })),
      hooks: [],
      mcpServers: [],
      lspServers: [],
    },
  };
  const hasClaude = publisherManifests.some(
    ({ path }) => path === '.claude-plugin/plugin.json',
  );
  const hasCodex = publisherManifests.some(
    ({ path }) => path === '.codex-plugin/plugin.json',
  );
  const compatibility = classifyHarnessCompatibility({
    kind: 'plugin',
    publisherManifests,
    unreadPublisherManifests,
    facets:
      hasClaude || hasCodex
        ? {
            ...(hasClaude ? { claude: facet } : {}),
            ...(hasCodex ? { codex: facet } : {}),
          }
        : // No native manifest: the marketplace's own format.
          { [provider]: facet },
  });
  return {
    ...(compatibility ? { compatibility } : {}),
    skills,
    commands,
    agents,
    hooks,
    mcpServers,
    mcpServerNames,
  };
}

function cached(key: string): Promise<PluginManifestPreviewResult> | null {
  const entry = cache.get(key);
  if (!entry) return null;
  return entry.result;
}

function remember(
  key: string,
  result: Promise<PluginManifestPreviewResult>,
): Promise<PluginManifestPreviewResult> {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { result });
  // A failure is kept briefly, a success for hours.
  void result.then((settled) => {
    const ttl = settled.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    setTimeout(() => {
      if (cache.get(key)?.result === result) cache.delete(key);
    }, ttl).unref?.();
  });
  return result;
}

function externalUrl(plugin: PluginInfo): string | undefined {
  const source = plugin.externalSource;
  return typeof source?.url === 'string' ? source.url : undefined;
}

/** The preview of one catalog plugin, read from its cached listing. */
export async function previewPluginManifest(
  marketplaceId: string,
  pluginName: string,
): Promise<PluginManifestPreviewResult> {
  if (!allowsAutomaticCall('marketplace.manifest-preview'))
    return { ok: false, reason: 'unavailable' };
  const catalog = await loadMarketplacesCacheOnly();
  if (!catalog.success || !catalog.data)
    return { ok: false, reason: 'unavailable' };
  const marketplace = catalog.data.marketplaces.find(
    (candidate) => candidate.id === marketplaceId,
  );
  const plugin = marketplace?.plugins.find(
    (candidate) => candidate.name === pluginName,
  );
  if (!plugin) return { ok: false, reason: 'not_found' };
  // Only the catalog's own source is read, never a URL from the caller.
  const url = externalUrl(plugin);
  const repo = url ? parseGitHubRepo(url) : null;
  if (!repo || !REPO_PATTERN.test(repo))
    return { ok: false, reason: 'unsupported_source' };
  const sha = plugin.externalSource?.sha;
  const ref = sha && SHA_PATTERN.test(sha) ? sha : 'HEAD';
  const provider =
    plugin.providerSupport.claude === 'none' &&
    plugin.providerSupport.codex !== 'none'
      ? 'codex'
      : 'claude';
  const key = `${repo}@${ref}:${provider}`;
  return (
    cached(key) ??
    remember(
      key,
      buildPreview(repo, ref, provider).then(
        (preview): PluginManifestPreviewResult => ({ ok: true, preview }),
        (error: unknown): PluginManifestPreviewResult => ({
          ok: false,
          reason:
            error instanceof PreviewFailure ? error.reason : 'unavailable',
        }),
      ),
    )
  );
}
