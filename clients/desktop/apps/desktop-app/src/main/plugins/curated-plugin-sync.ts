/**
 * Curated plugin sync engine (desktop main only).
 *
 * Fetches the curated plugin catalog, hash-diffs it against a local lock
 * file, downloads changed plugin content, and materializes each plugin into
 * a harness-native on-disk marketplace under
 * `<dataDir>/curated-plugins/marketplace/`:
 *
 * ```text
 * marketplace/
 *   .claude-plugin/marketplace.json    # Claude marketplace manifest
 *   .agents/plugins/marketplace.json   # Codex marketplace manifest
 *   <plugin-key>/
 *     .claude-plugin/plugin.json
 *     .codex-plugin/plugin.json
 *     .mcp.json                        # only when curated MCP keys resolve
 *     skills/<skill-key>/<file path>
 * ```
 *
 * The relative manifest locations mirror the bundled built-in marketplace
 * (`getBundledClaudePluginMarketplaceManifestPath()` /
 * `getBundledCodexPluginMarketplaceManifestPath()`) so the built-in scanners
 * can simply be parameterized over this root. One directory holds BOTH
 * provider facets of a plugin (the bundled tree splits `claude-plugins/` and
 * `codex-plugins/` only because its provider content differs after brand
 * rendering; curated content is identical for both providers).
 *
 * This module deliberately does NOT import `plugin-service.ts` (or
 * `invocable-inventory-service.ts`, which imports it) to avoid a module
 * cycle once plugin-service scans this marketplace. Provider "nudges"
 * (`claude plugin marketplace update` / Codex marketplace upgrade) and
 * invocable-inventory refresh are the caller's job: react to
 * `status === 'synced'`.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import type {
  MarketplaceManifest,
  MarketplacePluginEntry,
} from '@canopy/execution-engine/types/plugins';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import {
  isCuratedCatalogKey,
  isCuratedSkillFilePath,
  type CuratedPluginContentResponse,
  type CuratedPluginEntry,
} from '@canopy/protocol/plugin-catalog';
import {
  getCuratedPluginsMarketplaceDir,
  getCuratedPluginsStagingDir,
  getCuratedPluginsSyncLockFilePath,
} from '../lib/paths';
import { isPathInside } from '../lib/path-safety';
import {
  curatedPluginDisplay,
  CURATED_DISPLAY_FILE,
} from './curated-plugin-display';
import {
  resolveCuratedMcpCatalogForSync,
  type CuratedMcpCatalogResolution,
} from '../mcp/curated-catalog';
import {
  fetchCuratedPluginContent,
  fetchCuratedPluginsForSync,
} from './curated-plugin-catalog';

/**
 * Minimum spacing between catalog fetches, so callers that piggyback on user
 * actions (every marketplace refresh) can call this freely. No caller passes
 * `force: true` today; the option exists for a future flow that must bypass
 * the spacing (the 6h background scheduler is far coarser than this TTL, so
 * it does not need to).
 */
export const CURATED_PLUGIN_SYNC_TTL_MS = 5 * 60_000;

/** Version literal of the on-disk sync lock file. */
const LOCK_VERSION = 1;

/** Version literal written into the generated Claude marketplace manifest. */
const MARKETPLACE_MANIFEST_VERSION = '1.0.0';

/** Max characters retained in the lock's `lastError` diagnostic string. */
const MAX_LAST_ERROR_LENGTH = 1_000;

/**
 * Catalog keys are lower-kebab slugs (`SLUG_PATTERN` in
 * `apps/web/src/lib/curated-plugins/admin/schemas.ts`). Re-checked here
 * because keys become directory names: a malformed key must never reach the
 * filesystem, no matter what the server sent.
 */

export interface CuratedPluginSyncResult {
  /**
   * - `skipped`: the catalog fetch failed; nothing on disk was touched.
   * - `noop`: the catalog was fetched (or the TTL short-circuited) and the
   *   materialized marketplace already matched it; nothing was written.
   * - `synced`: something on disk changed. Callers should refresh dependent
   *   caches (invocable inventory, plugin marketplaces) and may nudge the
   *   providers.
   */
  status: 'skipped' | 'synced' | 'noop';
  added: string[];
  changed: string[];
  removed: string[];
  /**
   * Per-plugin failures. A failing plugin keeps its previously materialized
   * version (and its previous lock entry) so the next sync retries it.
   */
  errors: Array<{ key: string; message: string }>;
}

interface CuratedPluginSyncLockEntry {
  contentHash: string;
  version?: string;
  syncedAt: string;
  /** Materialized plugin-relative POSIX path -> sha256 of the file bytes. */
  files: Record<string, string>;
  /** Curated MCP catalog keys the plugin declared, resolvable or not. */
  curatedMcpKeys: string[];
}

interface CuratedPluginSyncLockFile {
  version: typeof LOCK_VERSION;
  syncedAt: string;
  lastError?: string;
  plugins: Record<string, CuratedPluginSyncLockEntry>;
}

/** Generated `.claude-plugin/marketplace.json` shape. */
interface GeneratedClaudeMarketplaceManifest extends MarketplaceManifest {
  name: string;
  version: string;
  description: string;
  metadata: { description: string };
  owner: { name: string };
}

/** Generated `.claude-plugin/plugin.json` shape. */
interface GeneratedClaudePluginManifest {
  name: string;
  version?: string;
  description: string;
  author?: { name: string };
  homepage?: string;
  mcpServers?: string;
}

/** One entry in the generated Codex `.agents/plugins/marketplace.json`. */
interface GeneratedCodexMarketplacePluginEntry {
  tryNowPrompt?: string;
  name: string;
  source: { source: 'local'; path: string };
  policy: { installation: 'AVAILABLE'; authentication: 'ON_INSTALL' };
  category?: string;
  author?: { name: string };
}

/** Generated `.agents/plugins/marketplace.json` shape. */
interface GeneratedCodexMarketplaceManifest {
  name: string;
  interface: { displayName: string };
  plugins: GeneratedCodexMarketplacePluginEntry[];
}

interface PreservedMarketplaceEntries {
  claude: Map<string, MarketplacePluginEntry>;
  codex: Map<string, GeneratedCodexMarketplacePluginEntry>;
}

/** Generated `.codex-plugin/plugin.json` shape. */
interface GeneratedCodexPluginManifest extends GeneratedClaudePluginManifest {
  skills?: string;
  interface: { displayName: string };
}

/**
 * One HTTP MCP server as written into a plugin's `.mcp.json`. The curated key
 * is the member's identity: the resolver and inventory bind a member to the
 * account or device connection that carries the same key instead of starting
 * a second sign-in for the same upstream. Provider projections strip the
 * declaration after extraction, so the field never reaches a runtime.
 */
interface GeneratedPluginMcpServer {
  type: 'http';
  url: string;
  curated: { key: string };
}

interface StagedPlugin {
  dir: string;
  lockEntry: CuratedPluginSyncLockEntry;
}

let syncChain: Promise<unknown> = Promise.resolve();
let lastSuccessfulSyncAtMs: number | null = null;

/** @internal — exposed for testing only */
export function resetCuratedPluginSyncStateForTests(): void {
  syncChain = Promise.resolve();
  lastSuccessfulSyncAtMs = null;
}

/**
 * Restores or completes directory swaps left by an interrupted promotion.
 * Marketplace scans call this before reading manifests so they never report a
 * plugin missing solely because the app stopped between the two renames.
 */
export async function recoverCuratedPluginPromotions(): Promise<void> {
  const next = syncChain.then(() => recoverInterruptedPromotions());
  syncChain = next.catch(() => undefined);
  return next;
}

/**
 * Provider-facing marketplace name for the curated marketplace. Mirrors the
 * built-in marketplace's `${BRAND.internalName}-plugins` (see
 * `getBuiltInProviderMarketplaceName()` in `plugin-service.ts`), so both
 * managed marketplaces stay brand-namespaced and collision-free.
 */
export function getCuratedPluginMarketplaceName(): string {
  return `${BRAND.internalName}-curated`;
}

/**
 * Syncs the curated plugin marketplace. Never throws: every failure is
 * reported through the returned result. Concurrent calls are serialized
 * through a module-level promise chain (same idiom as `withCacheLock` in
 * `plugin-service.ts`, without importing it).
 */
export async function syncCuratedPlugins(options?: {
  force?: boolean;
}): Promise<CuratedPluginSyncResult> {
  const force = options?.force === true;
  const next = syncChain.then(() => runSync(force));
  syncChain = next.catch(() => undefined);
  return next;
}

async function runSync(force: boolean): Promise<CuratedPluginSyncResult> {
  const result: CuratedPluginSyncResult = {
    status: 'noop',
    added: [],
    changed: [],
    removed: [],
    errors: [],
  };
  let committing = false;
  try {
    if (
      !force &&
      lastSuccessfulSyncAtMs !== null &&
      Date.now() - lastSuccessfulSyncAtMs < CURATED_PLUGIN_SYNC_TTL_MS
    ) {
      return result;
    }

    const catalog = await fetchCuratedPluginsForSync();
    if (!catalog) {
      // Fetch failure is never a signal to mutate local state.
      result.status = 'skipped';
      return result;
    }

    await syncCatalog(catalog.plugins, result, () => {
      committing = true;
    });
    if (result.status !== 'skipped') lastSuccessfulSyncAtMs = Date.now();
    return result;
  } catch (error) {
    // Unexpected top-level failure. The lock is written last, so a partial
    // commit is self-healing: the next run re-diffs against the stale lock.
    result.status = committing ? 'synced' : 'noop';
    result.errors.push({ key: '(sync)', message: errorMessage(error) });
    return result;
  }
}

async function syncCatalog(
  plugins: CuratedPluginEntry[],
  result: CuratedPluginSyncResult,
  markCommitting: () => void,
): Promise<void> {
  await recoverInterruptedPromotions();
  const marketplaceDir = getCuratedPluginsMarketplaceDir();
  const entries = collectSafeEntries(plugins, result);
  const mcpResolution = await resolveCuratedMcpServers(entries);
  if (mcpResolution.status === 'unavailable') {
    for (const entry of entries) {
      if (entry.mcpServers.length > 0) {
        result.errors.push({
          key: entry.key,
          message: 'Curated MCP catalog unavailable; plugin sync deferred',
        });
      }
    }
    result.status = 'skipped';
    return;
  }

  const lock = await readLock();
  await sweepStagingDir();

  const materialized = new Set<string>();
  const added: CuratedPluginEntry[] = [];
  const changed: CuratedPluginEntry[] = [];
  for (const entry of entries) {
    const previous = getOwn(lock.plugins, entry.key);
    if (!previous) {
      added.push(entry);
      continue;
    }
    const dirExists = await isDirectory(join(marketplaceDir, entry.key));
    if (dirExists) {
      materialized.add(entry.key);
    }
    if (
      previous.contentHash !== entry.contentHash ||
      !dirExists ||
      !(await materializedPluginMatches(entry, previous, mcpResolution))
    ) {
      changed.push(entry);
    }
  }
  const catalogKeys = new Set(entries.map((entry) => entry.key));
  const removed = Object.keys(lock.plugins).filter(
    (key) => !catalogKeys.has(key),
  );

  const nothingMaterialized =
    entries.length === 0 &&
    Object.keys(lock.plugins).length === 0 &&
    !(await isDirectory(marketplaceDir));
  if (nothingMaterialized) {
    // Verified-empty catalog on a machine that never materialized anything:
    // do not create an empty marketplace tree just to describe nothing.
    return;
  }

  const staged = new Map<string, StagedPlugin>();
  const syncedAt = new Date().toISOString();
  for (const entry of [...added, ...changed]) {
    try {
      staged.set(
        entry.key,
        await stagePlugin(entry, mcpResolution.byKey, syncedAt),
      );
    } catch (error) {
      result.errors.push({ key: entry.key, message: errorMessage(error) });
    }
  }

  const preservedEntries = await readPreservedMarketplaceEntries();
  const preCommitOverrides = selectPreservedMarketplaceEntries(
    preservedEntries,
    new Set(preCommitEntryKeys(materialized, entries)),
  );
  const failedExistingKeys = new Set(
    changed
      .filter((entry) => materialized.has(entry.key) && !staged.has(entry.key))
      .map((entry) => entry.key),
  );
  const finalOverrides = selectPreservedMarketplaceEntries(
    preservedEntries,
    failedExistingKeys,
  );

  const finalEntries = entries.filter(
    (entry) => staged.has(entry.key) || materialized.has(entry.key),
  );
  // Everything currently on disk, minus what is about to be removed. Used as
  // the pre-commit manifest so no manifest ever names a directory that the
  // removal step has already deleted.
  const preCommitEntries = entries.filter((entry) =>
    materialized.has(entry.key),
  );

  const desiredLock = buildLock(
    finalEntries,
    lock,
    staged,
    syncedAt,
    result.errors,
  );
  const manifestsUpToDate = await marketplaceManifestsMatch(
    finalEntries,
    finalOverrides,
  );
  const lockUpToDate =
    stableStringify(desiredLock.plugins) === stableStringify(lock.plugins);
  if (
    removed.length === 0 &&
    staged.size === 0 &&
    result.errors.length === 0 &&
    manifestsUpToDate &&
    lockUpToDate
  ) {
    return;
  }

  markCommitting();
  // (a) drop removed plugins from the manifests before their directories go.
  await writeMarketplaceManifests(preCommitEntries, preCommitOverrides);
  // (b) remove plugins the catalog no longer serves.
  for (const key of removed) {
    await removePluginDir(key);
  }
  // (c) promote staged plugins through a recoverable directory swap.
  // `Array.from` because the ES5 build target forbids `for...of` over a Map.
  for (const [key, plugin] of Array.from(staged.entries())) {
    await promoteStagedPlugin(key, plugin.dir);
  }
  // (d) publish the final plugin set.
  await writeMarketplaceManifests(finalEntries, finalOverrides);
  // (e) lock last: it is the record that the commit above completed.
  await writeLock(desiredLock);

  result.status = 'synced';
  result.removed = [...removed];
  for (const entry of added) {
    if (staged.has(entry.key)) result.added.push(entry.key);
  }
  for (const entry of changed) {
    if (staged.has(entry.key)) result.changed.push(entry.key);
  }
}

// ---------------------------------------------------------------------------
// Catalog entry safety
// ---------------------------------------------------------------------------

function isSafeCatalogKey(value: string): boolean {
  return isCuratedCatalogKey(value);
}

function collectSafeEntries(
  plugins: CuratedPluginEntry[],
  result: CuratedPluginSyncResult,
): CuratedPluginEntry[] {
  const seen = new Set<string>();
  const entries: CuratedPluginEntry[] = [];
  for (const plugin of plugins) {
    if (!isSafeCatalogKey(plugin.key)) {
      result.errors.push({
        key: plugin.key,
        message: 'Unsupported plugin key',
      });
      continue;
    }
    if (seen.has(plugin.key)) continue;
    seen.add(plugin.key);
    entries.push(plugin);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Curated MCP resolution
// ---------------------------------------------------------------------------

async function resolveCuratedMcpServers(
  entries: CuratedPluginEntry[],
): Promise<{
  status: CuratedMcpCatalogResolution['status'];
  byKey: Map<string, CuratedMcpServerEntry>;
}> {
  const byKey = new Map<string, CuratedMcpServerEntry>();
  if (!entries.some((entry) => entry.mcpServers.length > 0)) {
    return { status: 'verified', byKey };
  }
  const resolution = await resolveCuratedMcpCatalogForSync();
  if (resolution.status === 'unavailable') {
    return { status: 'unavailable', byKey };
  }
  for (const server of resolution.catalog.servers) {
    byKey.set(server.key, server);
  }
  return { status: 'verified', byKey };
}

/**
 * Builds the plugin's `.mcp.json` server map from its curated MCP keys.
 * Unknown keys are skipped (they are still recorded in the lock). Keys are
 * emitted in sorted order so the rendered file is byte-stable.
 */
function buildPluginMcpServers(
  entry: CuratedPluginEntry,
  mcpByKey: Map<string, CuratedMcpServerEntry>,
): Record<string, GeneratedPluginMcpServer> {
  const servers: Record<string, GeneratedPluginMcpServer> = {};
  for (const key of [...entry.mcpServers].sort()) {
    const server = mcpByKey.get(key);
    if (!server) continue;
    servers[key] = { type: 'http', url: server.url, curated: { key } };
  }
  return servers;
}

function renderPluginMcpJson(
  servers: Record<string, GeneratedPluginMcpServer>,
): string | null {
  if (Object.keys(servers).length === 0) return null;
  return renderJson({ mcpServers: servers });
}

/**
 * Self-heal check: a plugin whose curated MCP keys did not resolve when it
 * was materialized (curated MCP catalog unavailable) would otherwise keep a
 * stale `.mcp.json` forever, because the plugin `contentHash` covers only
 * the MCP *keys*, not their resolved URLs.
 */
async function materializedMcpConfigMatches(
  entry: CuratedPluginEntry,
  resolution: Awaited<ReturnType<typeof resolveCuratedMcpServers>>,
): Promise<boolean> {
  if (resolution.status === 'unavailable') return true;
  const desired = renderPluginMcpJson(
    buildPluginMcpServers(entry, resolution.byKey),
  );
  const actual = await readTextFile(
    join(getCuratedPluginsMarketplaceDir(), entry.key, '.mcp.json'),
  );
  return desired === actual;
}

async function materializedPluginMatches(
  entry: CuratedPluginEntry,
  lockEntry: CuratedPluginSyncLockEntry,
  resolution: Awaited<ReturnType<typeof resolveCuratedMcpServers>>,
): Promise<boolean> {
  const expectedFiles = new Map<string, string>();
  for (const skill of entry.skills) {
    for (const file of skill.files) {
      expectedFiles.set(`skills/${skill.key}/${file.path}`, file.sha256);
    }
  }
  if (Object.keys(lockEntry.files).length !== expectedFiles.size) return false;

  const pluginDir = join(getCuratedPluginsMarketplaceDir(), entry.key);
  const display = renderJson(curatedPluginDisplay(entry));
  for (const provider of ['claude', 'codex']) {
    if (
      (await readTextFile(
        join(pluginDir, `.${provider}-plugin`, CURATED_DISPLAY_FILE),
      )) !== display
    )
      return false;
  }
  for (const [relativePath, expectedSha256] of Array.from(
    expectedFiles.entries(),
  )) {
    if (lockEntry.files[relativePath] !== expectedSha256) return false;
    const target = join(pluginDir, ...relativePath.split('/'));
    if (!isPathInside(pluginDir, target)) return false;
    const actual = await readTextFile(target);
    if (actual === null || sha256Utf8(actual) !== expectedSha256) return false;
  }

  if (!(await materializedMcpConfigMatches(entry, resolution))) return false;
  const hasMcpServers =
    renderPluginMcpJson(buildPluginMcpServers(entry, resolution.byKey)) !==
    null;
  const claudeManifest = await readTextFile(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
  );
  if (
    claudeManifest !==
    renderJson(buildClaudePluginManifest(entry, hasMcpServers))
  ) {
    return false;
  }
  const codexManifest = await readTextFile(
    join(pluginDir, '.codex-plugin', 'plugin.json'),
  );
  return (
    codexManifest === renderJson(buildCodexPluginManifest(entry, hasMcpServers))
  );
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

async function stagePlugin(
  entry: CuratedPluginEntry,
  mcpByKey: Map<string, CuratedMcpServerEntry>,
  syncedAt: string,
): Promise<StagedPlugin> {
  const content = await fetchCuratedPluginContent(entry.key);
  if (!content) {
    throw new Error('Failed to download plugin content');
  }
  // Verify everything before a single byte is written, so a bad payload
  // cannot leave a half-written staging directory behind.
  verifyPluginContent(entry, content);

  const dir = join(
    getCuratedPluginsStagingDir(),
    `${entry.key}-${randomUUID()}`,
  );
  try {
    const files = await writeStagedSkills(dir, entry, content);
    const mcpServers = buildPluginMcpServers(entry, mcpByKey);
    await writeStagedManifests(dir, entry, mcpServers);
    return {
      dir,
      lockEntry: {
        contentHash: entry.contentHash,
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        syncedAt,
        files,
        curatedMcpKeys: [...entry.mcpServers],
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function verifyPluginContent(
  entry: CuratedPluginEntry,
  content: CuratedPluginContentResponse,
): void {
  if (content.key !== entry.key) {
    throw new Error('Content response is for a different plugin');
  }
  if (content.contentHash !== entry.contentHash) {
    throw new Error('Content response hash does not match the catalog');
  }
  const contentSkills = new Map(
    content.skills.map((skill) => [skill.key, skill]),
  );
  for (const skill of entry.skills) {
    if (!isSafeCatalogKey(skill.key)) {
      throw new Error(`Unsupported skill key "${skill.key}"`);
    }
    const contentSkill = contentSkills.get(skill.key);
    if (!contentSkill) {
      throw new Error(`Missing content for skill "${skill.key}"`);
    }
    if (contentSkill.contentHash !== skill.contentHash) {
      throw new Error(`Content hash mismatch for skill "${skill.key}"`);
    }
    // Defense in depth at the disk boundary: the protocol guard already
    // rejects unsafe paths, but nothing that becomes a filesystem path is
    // trusted on the word of the server alone. Checked outside the loop body
    // so the failure message can still name the offending path (inside a
    // negated type guard the value narrows to `never`).
    const unsafeFile = skill.files.find(
      (file) => !isCuratedSkillFilePath(file.path),
    );
    if (unsafeFile) {
      throw new Error(`Unsupported skill file path "${unsafeFile.path}"`);
    }
    const contentFiles = new Map(
      contentSkill.files.map((file) => [file.path, file]),
    );
    for (const file of skill.files) {
      const contentFile = contentFiles.get(file.path);
      if (!contentFile) {
        throw new Error(`Missing content for "${skill.key}/${file.path}"`);
      }
      if (contentFile.sha256 !== file.sha256) {
        throw new Error(
          `Manifest/content sha256 mismatch for "${skill.key}/${file.path}"`,
        );
      }
      if (sha256Utf8(contentFile.content) !== file.sha256) {
        throw new Error(
          `sha256 verification failed for "${skill.key}/${file.path}"`,
        );
      }
      if (Buffer.byteLength(contentFile.content, 'utf8') !== file.size) {
        throw new Error(
          `Size verification failed for "${skill.key}/${file.path}"`,
        );
      }
    }
  }
}

async function writeStagedSkills(
  dir: string,
  entry: CuratedPluginEntry,
  content: CuratedPluginContentResponse,
): Promise<Record<string, string>> {
  const contentSkills = new Map(
    content.skills.map((skill) => [skill.key, skill]),
  );
  const files: Record<string, string> = {};
  for (const skill of entry.skills) {
    const contentSkill = contentSkills.get(skill.key);
    if (!contentSkill) continue;
    const contentFiles = new Map(
      contentSkill.files.map((file) => [file.path, file]),
    );
    for (const file of skill.files) {
      const contentFile = contentFiles.get(file.path);
      if (!contentFile) continue;
      const relativePath = `skills/${skill.key}/${file.path}`;
      const target = join(dir, 'skills', skill.key, ...file.path.split('/'));
      if (!isPathInside(dir, target)) {
        throw new Error(`Refusing to write outside the plugin: "${file.path}"`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contentFile.content, 'utf8');
      files[relativePath] = file.sha256;
    }
  }
  return files;
}

async function writeStagedManifests(
  dir: string,
  entry: CuratedPluginEntry,
  mcpServers: Record<string, GeneratedPluginMcpServer>,
): Promise<void> {
  const mcpJson = renderPluginMcpJson(mcpServers);
  if (mcpJson !== null) {
    await writeTextFile(join(dir, '.mcp.json'), mcpJson);
  }
  await writeTextFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    renderJson(buildClaudePluginManifest(entry, mcpJson !== null)),
  );
  await writeTextFile(
    join(dir, '.codex-plugin', 'plugin.json'),
    renderJson(buildCodexPluginManifest(entry, mcpJson !== null)),
  );
  const display = renderJson(curatedPluginDisplay(entry));
  for (const provider of ['claude', 'codex']) {
    await writeTextFile(
      join(dir, `.${provider}-plugin`, CURATED_DISPLAY_FILE),
      display,
    );
  }
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

/**
 * The provider-facing plugin name is the catalog KEY, not the display name:
 * the marketplace entry name, the plugin manifest name, and the directory
 * name must agree for provider install/enable commands
 * (`<plugin>@<marketplace>`) and for cross-provider facet merging, which
 * keys on the lowercased plugin name.
 */
function buildClaudePluginManifest(
  entry: CuratedPluginEntry,
  hasMcpServers: boolean,
): GeneratedClaudePluginManifest {
  return {
    name: entry.key,
    ...(entry.version !== undefined ? { version: entry.version } : {}),
    description: entry.shortDescription,
    ...(entry.authorName !== undefined
      ? { author: { name: entry.authorName } }
      : {}),
    ...(entry.docsUrl !== undefined ? { homepage: entry.docsUrl } : {}),
    ...(hasMcpServers ? { mcpServers: './.mcp.json' } : {}),
  };
}

function buildCodexPluginManifest(
  entry: CuratedPluginEntry,
  hasMcpServers: boolean,
): GeneratedCodexPluginManifest {
  return {
    ...buildClaudePluginManifest(entry, hasMcpServers),
    ...(entry.skills.length > 0 ? { skills: './skills/' } : {}),
    interface: { displayName: entry.name },
  };
}

function buildClaudeMarketplaceEntry(
  entry: CuratedPluginEntry,
): MarketplacePluginEntry {
  return {
    name: entry.key,
    ...(entry.tryNowPrompt !== undefined
      ? { tryNowPrompt: entry.tryNowPrompt }
      : {}),
    description: entry.shortDescription,
    ...(entry.version !== undefined ? { version: entry.version } : {}),
    source: `./${entry.key}`,
    ...(entry.categories[0] !== undefined
      ? { category: entry.categories[0] }
      : {}),
    ...(entry.authorName !== undefined
      ? { author: { name: entry.authorName } }
      : {}),
    ...(entry.docsUrl !== undefined ? { homepage: entry.docsUrl } : {}),
    ...(entry.recommended === true ? { recommended: true } : {}),
  };
}

function buildCodexMarketplaceEntry(
  entry: CuratedPluginEntry,
): GeneratedCodexMarketplacePluginEntry {
  return {
    name: entry.key,
    source: { source: 'local', path: `./${entry.key}` },
    ...(entry.tryNowPrompt !== undefined
      ? { tryNowPrompt: entry.tryNowPrompt }
      : {}),
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    ...(entry.categories[0] !== undefined
      ? { category: entry.categories[0] }
      : {}),
    ...(entry.authorName !== undefined
      ? { author: { name: entry.authorName } }
      : {}),
  };
}

function buildClaudeMarketplaceManifest(
  entries: CuratedPluginEntry[],
  overrides: Map<string, MarketplacePluginEntry> = new Map(),
): GeneratedClaudeMarketplaceManifest {
  return {
    name: getCuratedPluginMarketplaceName(),
    version: MARKETPLACE_MANIFEST_VERSION,
    description: `Curated plugin marketplace for ${BRAND.displayName}.`,
    metadata: {
      description: `Curated plugins synced from the ${BRAND.displayName} catalog.`,
    },
    owner: { name: BRAND.displayName },
    plugins: entries.map(
      (entry) => overrides.get(entry.key) ?? buildClaudeMarketplaceEntry(entry),
    ),
  };
}

function buildCodexMarketplaceManifest(
  entries: CuratedPluginEntry[],
  overrides: Map<string, GeneratedCodexMarketplacePluginEntry> = new Map(),
): GeneratedCodexMarketplaceManifest {
  return {
    name: getCuratedPluginMarketplaceName(),
    interface: { displayName: `${BRAND.displayName} Curated Marketplace` },
    plugins: entries.map(
      (entry) => overrides.get(entry.key) ?? buildCodexMarketplaceEntry(entry),
    ),
  };
}

function getClaudeMarketplaceManifestPath(): string {
  return join(
    getCuratedPluginsMarketplaceDir(),
    '.claude-plugin',
    'marketplace.json',
  );
}

function getCodexMarketplaceManifestPath(): string {
  return join(
    getCuratedPluginsMarketplaceDir(),
    '.agents',
    'plugins',
    'marketplace.json',
  );
}

async function marketplaceManifestsMatch(
  entries: CuratedPluginEntry[],
  overrides?: PreservedMarketplaceEntries,
): Promise<boolean> {
  const claude = await readTextFile(getClaudeMarketplaceManifestPath());
  if (
    claude !==
    renderJson(buildClaudeMarketplaceManifest(entries, overrides?.claude))
  ) {
    return false;
  }
  const codex = await readTextFile(getCodexMarketplaceManifestPath());
  return (
    codex ===
    renderJson(buildCodexMarketplaceManifest(entries, overrides?.codex))
  );
}

/** Writes both manifests, skipping files whose content is already current. */
async function writeMarketplaceManifests(
  entries: CuratedPluginEntry[],
  overrides?: PreservedMarketplaceEntries,
): Promise<void> {
  const claudePath = getClaudeMarketplaceManifestPath();
  const claude = renderJson(
    buildClaudeMarketplaceManifest(entries, overrides?.claude),
  );
  if ((await readTextFile(claudePath)) !== claude) {
    await writeTextFile(claudePath, claude);
  }
  const codexPath = getCodexMarketplaceManifestPath();
  const codex = renderJson(
    buildCodexMarketplaceManifest(entries, overrides?.codex),
  );
  if ((await readTextFile(codexPath)) !== codex) {
    await writeTextFile(codexPath, codex);
  }
}

function isClaudeMarketplacePluginEntry(
  value: unknown,
): value is MarketplacePluginEntry {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  if (typeof value.source === 'string') return true;
  return (
    isRecord(value.source) &&
    typeof value.source.source === 'string' &&
    typeof value.source.url === 'string'
  );
}

function isCodexMarketplacePluginEntry(
  value: unknown,
): value is GeneratedCodexMarketplacePluginEntry {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isRecord(value.source) &&
    value.source.source === 'local' &&
    typeof value.source.path === 'string' &&
    isRecord(value.policy) &&
    value.policy.installation === 'AVAILABLE' &&
    value.policy.authentication === 'ON_INSTALL'
  );
}

async function readMarketplaceEntries<T extends { name: string }>(
  filePath: string,
  isEntry: (value: unknown) => value is T,
): Promise<Map<string, T>> {
  const entries = new Map<string, T>();
  const raw = await readTextFile(filePath);
  if (raw === null) return entries;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) return entries;
    for (const plugin of parsed.plugins) {
      if (isEntry(plugin)) {
        entries.set(plugin.name, plugin);
      }
    }
  } catch {
    return entries;
  }
  return entries;
}

async function readPreservedMarketplaceEntries(): Promise<PreservedMarketplaceEntries> {
  const [claude, codex] = await Promise.all([
    readMarketplaceEntries(
      getClaudeMarketplaceManifestPath(),
      isClaudeMarketplacePluginEntry,
    ),
    readMarketplaceEntries(
      getCodexMarketplaceManifestPath(),
      isCodexMarketplacePluginEntry,
    ),
  ]);
  return { claude, codex };
}

function selectPreservedMarketplaceEntries(
  entries: PreservedMarketplaceEntries,
  keys: Set<string>,
): PreservedMarketplaceEntries {
  const select = <T>(source: Map<string, T>): Map<string, T> =>
    new Map(Array.from(source.entries()).filter(([key]) => keys.has(key)));
  return { claude: select(entries.claude), codex: select(entries.codex) };
}

function preCommitEntryKeys(
  materialized: Set<string>,
  entries: CuratedPluginEntry[],
): string[] {
  return entries
    .filter((entry) => materialized.has(entry.key))
    .map((entry) => entry.key);
}

// ---------------------------------------------------------------------------
// Lock file
// ---------------------------------------------------------------------------

function emptyLock(): CuratedPluginSyncLockFile {
  return { version: LOCK_VERSION, syncedAt: '', plugins: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Own-property lookup. Catalog keys are server-controlled, and slugs like
 * `constructor` would otherwise resolve to an inherited `Object.prototype`
 * member and be mistaken for a real lock entry.
 */
function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function normalizeLockEntry(value: unknown): CuratedPluginSyncLockEntry | null {
  if (!isRecord(value)) return null;
  const { contentHash, version, syncedAt, files, curatedMcpKeys } = value;
  if (typeof contentHash !== 'string' || contentHash.length === 0) return null;
  if (typeof syncedAt !== 'string') return null;
  const normalizedFiles: Record<string, string> = {};
  if (isRecord(files)) {
    for (const [path, sha256] of Object.entries(files)) {
      if (typeof sha256 === 'string' && isCuratedSkillFilePath(path)) {
        normalizedFiles[path] = sha256;
      }
    }
  }
  return {
    contentHash,
    ...(typeof version === 'string' ? { version } : {}),
    syncedAt,
    files: normalizedFiles,
    curatedMcpKeys: Array.isArray(curatedMcpKeys)
      ? curatedMcpKeys.filter((key): key is string => typeof key === 'string')
      : [],
  };
}

/** Reads and normalizes the lock; anything unusable becomes a full resync. */
async function readLock(): Promise<CuratedPluginSyncLockFile> {
  const raw = await readTextFile(getCuratedPluginsSyncLockFilePath());
  if (raw === null) return emptyLock();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyLock();
  }
  if (!isRecord(parsed) || parsed.version !== LOCK_VERSION) return emptyLock();
  const plugins: Record<string, CuratedPluginSyncLockEntry> = {};
  if (isRecord(parsed.plugins)) {
    for (const [key, value] of Object.entries(parsed.plugins)) {
      if (!isSafeCatalogKey(key)) continue;
      const entry = normalizeLockEntry(value);
      if (entry) plugins[key] = entry;
    }
  }
  return {
    version: LOCK_VERSION,
    syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '',
    ...(typeof parsed.lastError === 'string'
      ? { lastError: parsed.lastError }
      : {}),
    plugins,
  };
}

function buildLock(
  finalEntries: CuratedPluginEntry[],
  previous: CuratedPluginSyncLockFile,
  staged: Map<string, StagedPlugin>,
  syncedAt: string,
  errors: Array<{ key: string; message: string }>,
): CuratedPluginSyncLockFile {
  const plugins: Record<string, CuratedPluginSyncLockEntry> = {};
  for (const key of finalEntries.map((entry) => entry.key).sort()) {
    // A plugin that failed to stage keeps its previous entry, so its lock
    // hash keeps describing the content that is actually on disk.
    const entry = staged.get(key)?.lockEntry ?? getOwn(previous.plugins, key);
    if (entry) plugins[key] = entry;
  }
  const lastError = errors
    .map((error) => `${error.key}: ${error.message}`)
    .join('; ')
    .slice(0, MAX_LAST_ERROR_LENGTH);
  return {
    version: LOCK_VERSION,
    syncedAt,
    ...(lastError.length > 0 ? { lastError } : {}),
    plugins,
  };
}

/** Atomic write (tmp + rename), mirroring `skills/lock-file.ts`. */
async function writeLock(lock: CuratedPluginSyncLockFile): Promise<void> {
  const filePath = getCuratedPluginsSyncLockFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, renderJson(lock), 'utf8');
  await rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function removePluginDir(key: string): Promise<void> {
  const marketplaceDir = getCuratedPluginsMarketplaceDir();
  const dir = join(marketplaceDir, key);
  if (!isSafeCatalogKey(key) || !isPathInside(marketplaceDir, dir)) return;
  await rm(dir, { recursive: true, force: true });
}

function promotionBackupRoot(): string {
  return join(dirname(getCuratedPluginsMarketplaceDir()), 'promotion-backups');
}

function promotionBackupDir(key: string): string {
  return join(promotionBackupRoot(), key);
}

async function recoverInterruptedPromotions(): Promise<void> {
  const backupRoot = promotionBackupRoot();
  let keys: string[] = [];
  try {
    keys = await readdir(backupRoot);
  } catch {
    return;
  }
  const marketplaceDir = getCuratedPluginsMarketplaceDir();
  for (const key of keys) {
    if (!isSafeCatalogKey(key)) continue;
    const backupDir = promotionBackupDir(key);
    const liveDir = join(marketplaceDir, key);
    if (await isDirectory(liveDir)) {
      await rm(backupDir, { recursive: true, force: true });
      continue;
    }
    await mkdir(marketplaceDir, { recursive: true });
    await rename(backupDir, liveDir);
  }
}

async function promoteStagedPlugin(
  key: string,
  stagedDir: string,
): Promise<void> {
  const marketplaceDir = getCuratedPluginsMarketplaceDir();
  const liveDir = join(marketplaceDir, key);
  const backupRoot = promotionBackupRoot();
  const backupDir = promotionBackupDir(key);
  await mkdir(backupRoot, { recursive: true });
  await rm(backupDir, { recursive: true, force: true });

  const hadLiveDirectory = await isDirectory(liveDir);
  if (hadLiveDirectory) {
    await rename(liveDir, backupDir);
  }
  try {
    await rename(stagedDir, liveDir);
  } catch (error) {
    if (hadLiveDirectory) {
      await rm(liveDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      try {
        await rename(backupDir, liveDir);
      } catch (rollbackError) {
        throw new Error(
          `${errorMessage(error)}; failed to restore previous plugin: ${errorMessage(rollbackError)}`,
        );
      }
    }
    throw error;
  }
  if (hadLiveDirectory) {
    await rm(backupDir, { recursive: true, force: true });
  }
}

/**
 * Removes staging directories left behind by an interrupted run. Runs only
 * after a successful fetch, so a failed fetch touches nothing at all.
 */
async function sweepStagingDir(): Promise<void> {
  const stagingDir = getCuratedPluginsStagingDir();
  let names: string[] = [];
  try {
    names = await readdir(stagingDir);
  } catch {
    return;
  }
  for (const name of names) {
    await rm(join(stagingDir, name), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Deterministic serialization used only for change detection. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Utf8(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
