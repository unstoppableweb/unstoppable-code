import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  PLUGIN_CATALOG_API_VERSION,
  isCuratedPluginContentResponse,
  isCuratedPluginListResponse,
  isCuratedSkillFilePath,
  type CuratedPluginContentResponse,
  type CuratedPluginEntry,
  type CuratedPluginListResponse,
  type CuratedPluginSkillManifest,
  type CuratedSkillFileManifestEntry,
} from '@canopy/protocol/plugin-catalog';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
import { getCuratedPluginsCatalogFilePath } from '../lib/paths';

export const CURATED_PLUGIN_CATALOG_MAX_AGE_MS = 60 * 60_000;
const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;

interface CuratedPluginCatalogCacheFile {
  cacheSchemaVersion: 1;
  apiVersion: number;
  fetchedAt: string;
  plugins: CuratedPluginEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EMPTY_RESPONSE: CuratedPluginListResponse = {
  version: PLUGIN_CATALOG_API_VERSION,
  plugins: [],
};

function normalizeSkillFile(
  file: CuratedSkillFileManifestEntry,
): CuratedSkillFileManifestEntry | null {
  if (!isCuratedSkillFilePath(file.path)) return null;
  return {
    path: file.path,
    sha256: file.sha256,
    size: file.size,
  };
}

function normalizeSkillManifest(
  skill: CuratedPluginSkillManifest,
): CuratedPluginSkillManifest | null {
  const key = skill.key.trim();
  if (key.length === 0) return null;
  const files = skill.files
    .map(normalizeSkillFile)
    .filter((file): file is CuratedSkillFileManifestEntry => file !== null);
  return {
    key,
    name: skill.name.trim(),
    contentHash: skill.contentHash,
    files,
  };
}

function normalizePlugin(entry: CuratedPluginEntry): CuratedPluginEntry {
  return {
    key: entry.key.trim(),
    name: entry.name.trim(),
    shortDescription: entry.shortDescription.trim(),
    ...(entry.tryNowPrompt !== undefined
      ? { tryNowPrompt: entry.tryNowPrompt }
      : {}),
    ...(entry.longDescription !== undefined
      ? { longDescription: entry.longDescription }
      : {}),
    ...(entry.logoUrl !== undefined ? { logoUrl: entry.logoUrl } : {}),
    ...(entry.version !== undefined ? { version: entry.version } : {}),
    ...(entry.authorName !== undefined ? { authorName: entry.authorName } : {}),
    ...(entry.authorUrl !== undefined ? { authorUrl: entry.authorUrl } : {}),
    ...(entry.docsUrl !== undefined ? { docsUrl: entry.docsUrl } : {}),
    categories: [...entry.categories],
    popular: entry.popular,
    ...(entry.recommended !== undefined
      ? { recommended: entry.recommended }
      : {}),
    sortOrder: entry.sortOrder,
    contentHash: entry.contentHash,
    mcpServers: [...entry.mcpServers],
    skills: entry.skills
      .map(normalizeSkillManifest)
      .filter((skill): skill is CuratedPluginSkillManifest => skill !== null),
    updatedAt: entry.updatedAt,
  };
}

export function normalizeCuratedPluginCatalogResponse(
  value: unknown,
): CuratedPluginListResponse | null {
  if (!isRecord(value) || !Array.isArray(value.plugins)) return null;

  const plugins: unknown[] = [];
  for (const entry of value.plugins) {
    if (!isRecord(entry)) {
      plugins.push(entry);
      continue;
    }

    const key = typeof entry.key === 'string' ? entry.key.trim() : entry.key;
    const name =
      typeof entry.name === 'string' ? entry.name.trim() : entry.name;
    if (key === '' || name === '') return null;

    let skills: unknown = entry.skills;
    if (Array.isArray(entry.skills)) {
      const normalizedSkills: unknown[] = [];
      for (const skill of entry.skills) {
        if (!isRecord(skill)) {
          normalizedSkills.push(skill);
          continue;
        }
        const skillKey =
          typeof skill.key === 'string' ? skill.key.trim() : skill.key;
        if (skillKey === '') return null;
        normalizedSkills.push({
          ...skill,
          key: skillKey,
          name: typeof skill.name === 'string' ? skill.name.trim() : skill.name,
        });
      }
      skills = normalizedSkills;
    }

    plugins.push({ ...entry, key, name, skills });
  }
  const normalizedValue = { ...value, plugins };
  if (
    !isCuratedPluginListResponse(normalizedValue) ||
    normalizedValue.version !== PLUGIN_CATALOG_API_VERSION
  ) {
    return null;
  }
  const normalizedPlugins = normalizedValue.plugins.map(normalizePlugin);
  return { version: PLUGIN_CATALOG_API_VERSION, plugins: normalizedPlugins };
}

async function readCache(): Promise<CuratedPluginCatalogCacheFile | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(getCuratedPluginsCatalogFilePath(), 'utf8'),
    );
    if (!isRecord(parsed)) return null;
    const normalized = normalizeCuratedPluginCatalogResponse({
      version: parsed.apiVersion,
      plugins: parsed.plugins,
    });
    if (
      parsed.cacheSchemaVersion !== 1 ||
      typeof parsed.fetchedAt !== 'string' ||
      !normalized
    ) {
      return null;
    }
    return {
      cacheSchemaVersion: 1,
      apiVersion: normalized.version,
      fetchedAt: parsed.fetchedAt,
      plugins: normalized.plugins,
    };
  } catch {
    return null;
  }
}

async function writeCache(
  response: CuratedPluginListResponse,
  fetchedAt: string,
): Promise<void> {
  const filePath = getCuratedPluginsCatalogFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const cache: CuratedPluginCatalogCacheFile = {
    cacheSchemaVersion: 1,
    apiVersion: response.version,
    fetchedAt,
    plugins: response.plugins,
  };
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(cache, null, 2), 'utf8');
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function cacheResponse(
  cache: CuratedPluginCatalogCacheFile | null,
): CuratedPluginListResponse {
  return cache
    ? { version: PLUGIN_CATALOG_API_VERSION, plugins: cache.plugins }
    : EMPTY_RESPONSE;
}

function cacheIsFresh(
  cache: CuratedPluginCatalogCacheFile,
  nowMs: number,
): boolean {
  const fetchedAt = Date.parse(cache.fetchedAt);
  return (
    Number.isFinite(fetchedAt) &&
    nowMs - fetchedAt < CURATED_PLUGIN_CATALOG_MAX_AGE_MS
  );
}

/**
 * Always attempts a live cloud fetch (no TTL short-circuit) and returns the
 * normalized response, best-effort caching it on success. Returns `null` on
 * ANY failure (cloud not configured, auth, network, guard mismatch, version
 * mismatch) so the sync engine (Task 7) can treat `null` as "do not touch
 * local state" — distinct from an empty-but-verified catalog.
 */
export async function fetchCuratedPluginsForSync(
  now: Date = new Date(),
): Promise<CuratedPluginListResponse | null> {
  try {
    const raw = await requestCanopyCloudJson<CuratedPluginListResponse>(
      `${API_PREFIX}/plugins/curated`,
    );
    const normalized = normalizeCuratedPluginCatalogResponse(raw);
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

/** Serve a fresh cache or fetch, returning empty when refresh is unavailable. */
export async function listCuratedPlugins(
  now: Date = new Date(),
): Promise<CuratedPluginListResponse> {
  const cache = await readCache();
  if (cache && cacheIsFresh(cache, now.getTime())) return cacheResponse(cache);
  const fetched = await fetchCuratedPluginsForSync(now);
  return fetched ?? EMPTY_RESPONSE;
}

/**
 * Fetches full skill file contents for one curated plugin. Not cached to
 * disk as JSON — the sync engine (Task 7) writes content directly into the
 * materialized marketplace. Returns `null` on any failure.
 */
export async function fetchCuratedPluginContent(
  key: string,
): Promise<CuratedPluginContentResponse | null> {
  try {
    const raw = await requestCanopyCloudJson<CuratedPluginContentResponse>(
      `${API_PREFIX}/plugins/curated/${encodeURIComponent(key)}/content`,
    );
    if (
      !isCuratedPluginContentResponse(raw) ||
      raw.version !== PLUGIN_CATALOG_API_VERSION
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}
