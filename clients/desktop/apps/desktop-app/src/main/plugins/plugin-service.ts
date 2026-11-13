import * as fs from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  decodePluginCatalog,
  decodePluginCacheIndex,
  readPluginCatalog,
  readPluginCacheIndex,
  type PluginCacheIndex,
  type PluginReadHealth,
} from '@canopy/execution-engine/node/plugins/catalog-read-health';
import { BRAND } from '@canopy/brand/current';
import {
  claudeMarketplaceNames,
  type InheritedPluginMarketplace,
} from './inherited-cursor-plugins';
import { runSerializedPluginMutation } from './plugin-mutation-queue';
import { pruneInstalledItemRefs } from '../installed-items/installed-item-ref-prune';
import { prunePipelinePreferenceSelections } from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import {
  canonicalInstalledItemRef,
  installedItemKey,
  parseInstalledItemKey,
  type InstalledItemRef,
} from '@canopy/protocol/installed-items';
import { DEFAULT_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { normalizeGitHubRepoRef } from '@canopy/execution-engine/plugin-refs';
import {
  getBundledClaudePluginMarketplaceManifestPath,
  getBundledClaudeBinaryPath,
  getBundledCodexPluginMarketplaceManifestPath,
  getBundledPluginsDir,
  getEnhancedEnv,
} from '../pipelines/config-paths';
import {
  // Legacy `standalone-chat/{project}` path helpers. Kept only for the
  // best-effort legacy-tree scan in `addStandaloneSelectionPruneTargets`,
  // which becomes a no-op once the cowork migration has deleted
  // `standalone-chat/` — migrated cowork workspaces' `workspace.json` and
  // `chats/*.json` are already covered generically by
  // `addWorkspaceSelectionPruneTargets`'s sweep of every `workspaces/{id}/`
  // dir; their `chat-history/{chatId}/meta.json` files are covered below via
  // `getWorkspaceChatHistoryRootDir`/`getWorkspaceChatHistoryMetaFilePath`.
  getChatProjectChatTabsFilePath,
  getChatProjectHistoryDir,
  getChatProjectMetaFilePath,
  getChatProjectProjectFilePath,
  getChatProjectsFilePath,
  getCuratedPluginsMarketplaceDir,
  getCodexCompatibilityCacheRootDir,
  getDataDir,
  getPluginCacheDir,
  getWorkspaceChatHistoryMetaFilePath,
  getWorkspaceChatHistoryRootDir,
} from '../lib/paths';
import {
  cloneRepo,
  getHeadCommitSha,
  getRemoteHeadCommitSha,
} from '../lib/git';
import { isE2eBuild } from '../lib/e2e-gate';
import {
  projectPreferencesForRuntime,
  readPreferencesFile,
  peekPreferencesLoadError,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { mapWithConcurrency } from '../lib/concurrency';
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
import { unionPluginSelections } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { safeReadJson } from '../lib/fs-utils';
import {
  claudeInstalledPluginsMap,
  installPathOf,
  isPluginInstallRoot,
  isUserScopedInstall,
} from './claude-enabled-plugins';
import {
  chatStorageScopeIds,
  readChatStorageDiscoveryIndex,
} from '../lib/chat-storage-discovery';
import { parseFrontmatterAndBody } from '../lib/frontmatter';
import { isPathInside } from '../lib/path-safety';
import { parseGitHubSource } from '../skills/source-parser';
import {
  addCodexMarketplace as addCodexMarketplaceUnchecked,
  codexMarketplaceManifestPath,
  installCodexPlugin as installCodexPluginUnchecked,
  isStructuralCodexMarketplaceFailure,
  listCodexPlugins,
  readCodexMarketplaceInstallMetadata,
  removeCodexMarketplace as removeCodexMarketplaceUnchecked,
  resolveCodexPluginInstallRoots,
  upgradeCodexMarketplace as upgradeCodexMarketplaceUnchecked,
  type CodexMarketplaceOperationResult,
} from './codex-marketplace-service';
import { codexMarketplaceRootFromPath } from './codex-marketplace-paths';
import { scanPluginDetails } from './plugin-scanner';
import { materializeCodexPluginsOffMain } from './codex-plugin-materialization-runner';
import type { MaterializedCodexPlugin } from './codex-plugin-materialization-protocol';
import { pruneMarketplacePluginRefsFromValue } from './marketplace-plugin-ref-prune';
import { updateWorkspacePlugins } from '../lib/workspace-plugin-defaults';
import { pruneMarketplaceRefsFromPreferences } from './marketplace-preferences-prune';
import {
  getCuratedPluginMarketplaceName,
  syncCuratedPlugins,
  type CuratedPluginSyncResult,
} from './curated-plugin-sync';
import {
  invalidateCuratedMarketplaceScanCache,
  mergeCuratedMarketplace,
  scanCuratedMarketplace,
  type CuratedMarketplaceScanDeps,
} from './curated-plugin-marketplace';
import { runClaudeCliProcessOffMain } from '../agents/claude-process-host-runner';
import { withMarketplaceRefreshLock } from './marketplace-refresh-lock';
import {
  hasManagedMarketplaceReceipt,
  reconcileManagedMarketplaceReceipts,
  recordManagedMarketplaceReceipt,
  type ManagedMarketplaceObservation,
  type ManagedMarketplaceReceiptWrite,
} from './managed-marketplace-ledger';
import {
  BUILTIN_PLUGIN_MARKETPLACE_ID,
  CURATED_PLUGIN_MARKETPLACE_ID,
  BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL,
  isCuratedPluginMarketplaceId,
  type AnyPluginsCache,
  type BuiltInPluginInstallStatus,
  type BuiltInProviderInstallStatus,
  type InstallBuiltInPluginRequest,
  type InstallBuiltInPluginResult,
  type KnownMarketplaceEntry,
  type KnownMarketplacesFile,
  type MarketplaceInfo,
  type MarketplaceInfoV1,
  type MarketplaceManifest,
  type MarketplaceOperationKind,
  type MarketplaceOperationProgress,
  type MarketplaceProviderStatus,
  type MarketplaceRegistrationResult,
  type MarketplaceRemovalResult,
  type PluginComponentContent,
  type PluginInfo,
  type PluginInfoV1,
  type PluginManifest,
  type PluginProvider,
  type PluginProviderFacet,
  type PluginsCache,
  type PluginsCacheV1,
} from '@canopy/execution-engine/types/plugins';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import type { PluginMarketplaceEntry } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginMarketplaceEntry';
import type { PluginSummary } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginSummary';
import {
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

const DEFAULT_MARKETPLACE_REMOVAL_PROVIDERS: PluginProvider[] = [
  'claude',
  'codex',
];
const MARKETPLACE_REFRESH_CONCURRENCY = 4;
const PLUGIN_CLI_TIMEOUT_MS = 60_000;
// One-release read-time cleanup for stale marketplace records written by the
// removed per-chat Codex state implementation. This is not registered or used
// as a capability source and can be deleted after the cleanup release ships.
const LEGACY_CODEX_CHAT_PLUGIN_MARKETPLACE_NAME = 'canopy-chat-plugins';
// How long startup marketplace discovery trusts the last full provider
// refresh before re-running per-marketplace `claude plugin marketplace
// update` / Codex upgrade commands. Discovery (scanning registrations and
// adding newly supported providers) always runs regardless.
const MARKETPLACE_PROVIDER_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

// Only an explicit provider refresh may consume supported legacy sources.
const providerRevalidation = new AsyncLocalStorage<boolean>();

async function execPluginCli(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  await runClaudeCliProcessOffMain({
    command: file,
    args,
    env,
    timeoutMs: PLUGIN_CLI_TIMEOUT_MS,
  });
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
}

async function addCodexMarketplace(
  ...args: Parameters<typeof addCodexMarketplaceUnchecked>
): ReturnType<typeof addCodexMarketplaceUnchecked> {
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  const result = await addCodexMarketplaceUnchecked(...args);
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  return result;
}

async function removeCodexMarketplace(
  ...args: Parameters<typeof removeCodexMarketplaceUnchecked>
): ReturnType<typeof removeCodexMarketplaceUnchecked> {
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  const result = await removeCodexMarketplaceUnchecked(...args);
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  return result;
}

async function upgradeCodexMarketplace(
  ...args: Parameters<typeof upgradeCodexMarketplaceUnchecked>
): ReturnType<typeof upgradeCodexMarketplaceUnchecked> {
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  const result = await upgradeCodexMarketplaceUnchecked(...args);
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  return result;
}

async function installCodexPlugin(
  ...args: Parameters<typeof installCodexPluginUnchecked>
): ReturnType<typeof installCodexPluginUnchecked> {
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  const result = await installCodexPluginUnchecked(...args);
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  return result;
}

type MarketplaceProgressReporter = (
  progress: MarketplaceOperationProgress,
) => void;
type CodexPluginList = Awaited<ReturnType<typeof listCodexPlugins>>;
type CodexPluginListResult =
  | { success: true; data: CodexPluginList }
  | { success: false; error: string };

let backgroundSelectionPruneQueue: Promise<void> = Promise.resolve();

function getPluginsCacheFilePath(): string {
  return path.join(getDataDir(), 'plugins-cache.json');
}

function getKnownMarketplacesPath(): string {
  return path.join(
    getClaudeConfigDirectory(),
    'plugins',
    'known_marketplaces.json',
  );
}

function getClaudeInstalledPluginsPath(): string {
  return path.join(
    getClaudeConfigDirectory(),
    'plugins',
    'installed_plugins.json',
  );
}

function getClaudeSettingsPath(): string {
  return path.join(getClaudeConfigDirectory(), 'settings.json');
}

function getClaudeConfigDirectory(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude')
  );
}

export function readClaudeInstalledItemState(
  marketplace: InheritedPluginMarketplace,
  pluginName: string,
  marketplaces: readonly InheritedPluginMarketplace[],
): { ids: string[]; enabled: boolean } {
  const read = (file: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    }
  };
  const installed = claudeInstalledPluginsMap(
    read(getClaudeInstalledPluginsPath()),
  );
  const settings = read(getClaudeSettingsPath());
  const flags =
    isRecord(settings) && isRecord(settings.enabledPlugins)
      ? settings.enabledPlugins
      : {};
  const ids = Object.entries(installed ?? {}).flatMap(([id, raw]) => {
    const separator = id.lastIndexOf('@');
    if (
      id.slice(0, separator).toLowerCase() !== pluginName.toLowerCase() ||
      !claudeMarketplaceNames(marketplace).includes(id.slice(separator + 1))
    )
      return [];
    const entries = Array.isArray(raw) ? raw : [raw];
    if (!entries.some((entry) => isRecord(entry) && isUserScopedInstall(entry)))
      return [];
    const name = id.slice(separator + 1);
    const exactOwners = marketplaces.filter(
      (candidate) =>
        candidate.id === name ||
        candidate.providerStatus?.claude?.marketplaceName === name,
    );
    const owners = new Set(
      (exactOwners.length
        ? exactOwners
        : marketplaces.filter((candidate) => candidate.name === name)
      ).map((candidate) => candidate.id),
    );
    if (!owners.has(marketplace.id)) return [];
    if (owners.size > 1)
      throw new Error(
        'Claude marketplace identity is ambiguous. Refresh the installed catalog before changing it.',
      );
    return [id];
  });
  return { ids, enabled: ids.every((id) => flags[id] !== false) };
}

export async function setClaudeInstalledItemEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await execPluginCli(
    getBundledClaudeBinaryPath(),
    ['plugin', enabled ? 'enable' : 'disable', id, '--scope', 'user'],
    getEnhancedEnv(),
  );
}

export async function uninstallClaudeInstalledItem(id: string): Promise<void> {
  await execPluginCli(
    getBundledClaudeBinaryPath(),
    ['plugin', 'uninstall', id, '--scope', 'user', '--keep-data'],
    getEnhancedEnv(),
  );
}

/** Remove only cache directories owned by Canopy, never an external source tree. */
export async function removeInstalledPluginCache(
  marketplaceId: string,
  pluginName: string,
): Promise<void> {
  await withCacheLock(() => {
    assertCatalogHealth();
    const index = readCacheIndex();
    const prefix = `${marketplaceId}/`;
    const entries = Object.entries(index.entries).filter(
      ([key]) =>
        key.startsWith(prefix) &&
        key.slice(prefix.length).toLowerCase() === pluginName.toLowerCase(),
    );
    const cache = readCache();
    const plugin =
      cache?.version === 2
        ? cache.marketplaces
            .find((marketplace) => marketplace.id === marketplaceId)
            ?.plugins.find(
              (candidate) =>
                candidate.name.toLowerCase() === pluginName.toLowerCase(),
            )
        : undefined;
    const managedPaths = new Map<string, string>();
    for (const candidate of [
      ...entries.map(([, entry]) => entry.cachePath),
      plugin?.cachePath,
      plugin?.facets.claude?.cachePath,
    ]) {
      if (candidate) managedPaths.set(candidate, getPluginCacheDir());
    }
    if (plugin?.facets.codexCompatibility?.cachePath)
      managedPaths.set(
        plugin.facets.codexCompatibility.cachePath,
        getCodexCompatibilityCacheRootDir(),
      );
    for (const [candidate, ownedRoot] of Array.from(managedPaths)) {
      if (!fs.existsSync(candidate)) continue;
      const root = fs.realpathSync(ownedRoot);
      const target = fs.realpathSync(candidate);
      if (target === root || !isPathInside(root, target))
        throw new Error('Plugin cache is outside its managed directory.');
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (entries.length) {
      for (const [key] of entries) delete index.entries[key];
      writeCacheIndex(index);
    }
    if (cache?.version === 2)
      writeCache({
        ...cache,
        marketplaces: cache.marketplaces.map((marketplace) =>
          marketplace.id !== marketplaceId
            ? marketplace
            : {
                ...marketplace,
                plugins: marketplace.plugins.map((plugin) =>
                  plugin.name.toLowerCase() !== pluginName.toLowerCase()
                    ? plugin
                    : {
                        ...plugin,
                        cachePath: undefined,
                        cachedAt: undefined,
                        details: undefined,
                        globalInstallStatus: plugin.globalInstallStatus
                          ? {
                              ...plugin.globalInstallStatus,
                              ...(plugin.globalInstallStatus.claude
                                ? {
                                    claude: {
                                      ...plugin.globalInstallStatus.claude,
                                      installed: false,
                                      installError: undefined,
                                    },
                                  }
                                : {}),
                              ...(plugin.globalInstallStatus.codex
                                ? {
                                    codex: {
                                      ...plugin.globalInstallStatus.codex,
                                      installed: false,
                                      installError: undefined,
                                    },
                                  }
                                : {}),
                            }
                          : undefined,
                        facets: {
                          ...plugin.facets,
                          codexCompatibility: undefined,
                          claude: plugin.facets.claude
                            ? {
                                ...plugin.facets.claude,
                                cachePath: undefined,
                                cachedAt: undefined,
                                details: undefined,
                              }
                            : undefined,
                          codex: plugin.facets.codex
                            ? {
                                ...plugin.facets.codex,
                                cachePath: undefined,
                                cachedAt: undefined,
                                details: undefined,
                              }
                            : undefined,
                        },
                      },
                ),
              },
        ),
      });
    invalidateManagedMarketplaceScanCache(marketplaceId);
  });
}

function getBuiltInProviderMarketplaceName(): string {
  return `${BRAND.internalName}-plugins`;
}

function getBuiltInMarketplaceDisplayName(): string {
  return `${BRAND.displayName} Marketplace`;
}

export function readPluginCatalogHealth(): PluginReadHealth<
  PluginsCache,
  PluginsCacheV1
> {
  return readPluginCatalog(getPluginsCacheFilePath());
}

export function readPluginIndexHealth(): PluginReadHealth<PluginCacheIndex> {
  return readPluginCacheIndex(getCacheIndexPath());
}

function catalogReadError(state: string): Error {
  return new Error(
    `Couldn't use the plugin catalog because it is ${state}. Plugin changes and execution are blocked.`,
  );
}

function assertCatalogHealth(options?: { allowLegacy?: boolean }): void {
  const catalog = readPluginCatalogHealth();
  if (
    catalog.state !== 'valid' &&
    catalog.state !== 'absent' &&
    !(options?.allowLegacy && catalog.state === 'legacy')
  ) {
    throw catalogReadError(catalog.state);
  }
  const index = readPluginIndexHealth();
  if (index.state !== 'valid' && index.state !== 'absent') {
    throw catalogReadError(index.state);
  }
}

// Strict internal read: callers must translate failure, never treat it as absence.
function readCache(): AnyPluginsCache | null {
  const result = readPluginCatalogHealth();
  if (result.state === 'absent') return null;
  if (result.state === 'valid' || result.state === 'legacy') return result.data;
  throw catalogReadError(result.state);
}

function validateCachePayload(cache: PluginsCache): PluginsCache {
  // Preserve the provider-refresh stamp across writers that rebuild the
  // cache literal (single-marketplace updates, install/uninstall, etc.) so
  // only refreshes that actually ran provider updates move it forward.
  const previous = readCache();
  const lastProviderRefreshAt =
    cache.lastProviderRefreshAt ??
    (previous?.version === 2 ? previous.lastProviderRefreshAt : undefined);
  const nextCache: PluginsCache = {
    ...cache,
    ...(lastProviderRefreshAt ? { lastProviderRefreshAt } : {}),
  };
  const outgoing = decodePluginCatalog(nextCache);
  if (outgoing.state !== 'valid') {
    throw new Error(
      "Couldn't save the plugin catalog because the updated data doesn't match the supported format. The existing file hasn't changed.",
    );
  }
  return outgoing.data;
}

function writeCache(cache: PluginsCache, revalidatedLegacy = false): void {
  assertCatalogHealth({ allowLegacy: revalidatedLegacy });
  const outgoing = validateCachePayload(cache);
  const filePath = getPluginsCacheFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(outgoing, null, 2), 'utf-8');
}

interface CodexDiscoveredMarketplaceSource {
  id: string;
  sourceUrl: string;
  sourceType: string;
  marketplaceName: string;
  installedRoot?: string;
  scanOnly: boolean;
  listedMarketplace: PluginMarketplaceEntry;
}

interface MarketplaceRefreshSource {
  id: string;
  sourceUrl: string;
  knownEntry: KnownMarketplaceEntry | null;
  knownId?: string;
  v1SourceType?: string;
  v1InstallLocation?: string;
  v1LastUpdated?: string;
  codexMarketplaceName?: string;
  codexInstalledRoot?: string;
  codexScanOnly?: boolean;
  codexListedMarketplace?: PluginMarketplaceEntry;
  sourceType?: string;
}

function getCacheIndexPath(): string {
  return path.join(getDataDir(), 'plugin-cache-index.json');
}

function readCacheIndex(): PluginCacheIndex {
  const result = readPluginIndexHealth();
  if (result.state === 'valid') return result.data;
  if (result.state === 'absent') return { version: 1, entries: {} };
  throw catalogReadError(result.state);
}

function validateCacheIndexPayload(index: PluginCacheIndex): PluginCacheIndex {
  const outgoing = decodePluginCacheIndex(index);
  if (outgoing.state !== 'valid') {
    throw new Error(
      "Couldn't save the plugin cache index because the updated data doesn't match the supported format. The existing file hasn't changed.",
    );
  }
  return outgoing.data;
}

function writeCacheIndex(index: PluginCacheIndex): void {
  assertCatalogHealth();
  const outgoing = validateCacheIndexPayload(index);
  const filePath = getCacheIndexPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(outgoing, null, 2), 'utf-8');
}

function normalizeLocalMarketplaceRoot(sourceRoot: string): string | null {
  if (!path.isAbsolute(sourceRoot)) {
    return null;
  }
  return path.resolve(sourceRoot);
}

/**
 * True when a `known_marketplaces.json` entry actually points at the given
 * locally managed marketplace root (bundled built-in dir, or the curated
 * marketplace dir) — not just an entry that happens to share the managed
 * marketplace's reserved NAME. Marketplace names are author-controlled (the
 * added repo's own manifest `name` field), so a same-named external
 * marketplace at a different location is a distinct marketplace and must
 * keep producing its own row.
 *
 * Mirrors the location classification in
 * `evaluateClaudeBuiltInMarketplaceConflict`: an exact root match is ours; a
 * different location that exists on disk is a real, distinct marketplace; a
 * missing location is only ours if Canopy previously recorded registering
 * exactly this (provider, name, root) tuple (e.g. the bundled root moved
 * between app versions).
 */
function isKnownMarketplaceEntryManagedRoot(
  marketplaceName: string,
  managedRoot: string,
  entry: KnownMarketplaceEntry,
): boolean {
  return isManagedProviderMarketplaceSource(
    'claude',
    marketplaceName,
    managedRoot,
    entry.installLocation,
  );
}

function isManagedProviderMarketplaceSource(
  provider: PluginProvider,
  marketplaceName: string,
  managedRoot: string,
  sourceRoot: string | null | undefined,
): boolean {
  const normalizedSource = normalizeLocalMarketplaceRoot(sourceRoot ?? '');
  if (!normalizedSource) {
    return false;
  }
  if (normalizedSource === managedRoot) {
    return true;
  }
  if (fs.existsSync(normalizedSource)) {
    return false;
  }
  return hasManagedMarketplaceReceipt({
    provider,
    marketplaceName,
    sourceRoot: normalizedSource,
  });
}

interface ManagedMarketplaceTarget {
  marketplaceName: string;
  root: string;
}

/** Both locally managed marketplaces: provider-facing name and local root. */
function managedMarketplaceTargets(): ManagedMarketplaceTarget[] {
  return [
    {
      marketplaceName: getBuiltInProviderMarketplaceName(),
      root: path.resolve(getBundledPluginsDir()),
    },
    {
      marketplaceName: getCuratedPluginMarketplaceName(),
      root: path.resolve(getCuratedPluginsMarketplaceDir()),
    },
  ];
}

/** The local root Claude currently has registered under `marketplaceName`. */
function claudeRegisteredMarketplaceRoot(
  known: KnownMarketplacesFile,
  marketplaceName: string,
): string | null {
  const entry: unknown = known[marketplaceName];
  return isRecord(entry) && typeof entry.installLocation === 'string'
    ? normalizeLocalMarketplaceRoot(entry.installLocation)
    : null;
}

function claudeManagedMarketplaceObservations(
  known: KnownMarketplacesFile,
): ManagedMarketplaceObservation[] {
  return managedMarketplaceTargets().map(({ marketplaceName, root }) => ({
    provider: 'claude',
    marketplaceName,
    managedRoot: root,
    registeredRoot: claudeRegisteredMarketplaceRoot(known, marketplaceName),
  }));
}

function codexManagedMarketplaceObservations(
  entries: readonly PluginMarketplaceEntry[],
): ManagedMarketplaceObservation[] {
  return managedMarketplaceTargets().flatMap(({ marketplaceName, root }) =>
    entries
      .filter((entry) => entry.name === marketplaceName)
      .map((entry) => ({
        provider: 'codex',
        marketplaceName,
        managedRoot: root,
        registeredRoot: normalizeLocalMarketplaceRoot(
          codexMarketplaceRootFromPath(entry.path) ?? '',
        ),
      })),
  );
}

function logFailedReceiptWrite(
  outcome: ManagedMarketplaceReceiptWrite,
  subject: string,
): void {
  if (outcome.status === 'failed') {
    process.stderr.write(
      `[plugins] Failed to record ${subject}: ${outcome.error}\n`,
    );
  }
}

/**
 * Records that this app registered `root` under `marketplaceName`. The
 * registration already happened, so a failed write is logged, not raised: the
 * receipt only matters if the root later moves.
 */
function recordManagedMarketplaceRegistration(
  provider: PluginProvider,
  marketplaceName: string,
  root: string,
): void {
  logFailedReceiptWrite(
    recordManagedMarketplaceReceipt({
      provider,
      marketplaceName,
      sourceRoot: root,
    }),
    `the ${provider} receipt for the "${marketplaceName}" marketplace`,
  );
}

/**
 * Startup receipt reconciliation. It reads Claude's `known_marketplaces.json`
 * only, so it starts no provider process and can run on every platform; Codex
 * receipts are reconciled from the plugin list each refresh already reads.
 */
export function reconcileManagedMarketplaceReceiptsAtStartup(): ManagedMarketplaceReceiptWrite {
  return reconcileManagedMarketplaceReceipts(
    claudeManagedMarketplaceObservations(readKnownMarketplaces()),
  );
}

function cacheKey(marketplaceId: string, pluginName: string): string {
  return `${marketplaceId}/${pluginName}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyRegisteredMessage(message: string): boolean {
  return /already (added|exists|installed|registered)/i.test(message);
}

let cacheWriteChain: Promise<unknown> = Promise.resolve();

function withCacheLock<T>(work: () => Promise<T> | T): Promise<T> {
  const next = cacheWriteChain.then(() => work());
  cacheWriteChain = next.catch(() => undefined);
  return next;
}

function mergePreservedCacheState(
  marketplaces: MarketplaceInfo[],
  previousCache: AnyPluginsCache | null,
): MarketplaceInfo[] {
  if (previousCache?.version !== 2) {
    return marketplaces;
  }
  const previousMarketplaces = new Map(
    previousCache.marketplaces.map((marketplace) => [
      marketplace.id,
      marketplace,
    ]),
  );
  return marketplaces.map((marketplace) => {
    const previousMarketplace = previousMarketplaces.get(marketplace.id);
    if (!previousMarketplace) {
      return marketplace;
    }
    const previousPlugins = new Map(
      previousMarketplace.plugins.map((plugin) => [
        plugin.name.toLowerCase(),
        plugin,
      ]),
    );
    let changed = false;
    const plugins = marketplace.plugins.map((plugin) => {
      if (plugin.facets.codex || plugin.facets.codexCompatibility) {
        return plugin;
      }
      const previousPlugin = previousPlugins.get(plugin.name.toLowerCase());
      const codexCompatibility = previousPlugin?.facets.codexCompatibility;
      if (!codexCompatibility) {
        return plugin;
      }
      changed = true;
      return {
        ...plugin,
        providerSupport: {
          ...plugin.providerSupport,
          codex: 'compat' as const,
        },
        facets: {
          ...plugin.facets,
          codexCompatibility,
        },
      };
    });
    return changed ? { ...marketplace, plugins } : marketplace;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPluginProvider(value: unknown): value is PluginProvider {
  return value === 'claude' || value === 'codex';
}

function isLegacyCodexChatPluginMarketplace(marketplace: {
  id?: string;
  name?: string;
  sourceUrl?: string;
  providerStatus?: { codex?: { marketplaceName?: string } };
}): boolean {
  return (
    marketplace.id === LEGACY_CODEX_CHAT_PLUGIN_MARKETPLACE_NAME ||
    marketplace.name === LEGACY_CODEX_CHAT_PLUGIN_MARKETPLACE_NAME ||
    marketplace.sourceUrl === LEGACY_CODEX_CHAT_PLUGIN_MARKETPLACE_NAME ||
    marketplace.providerStatus?.codex?.marketplaceName ===
      LEGACY_CODEX_CHAT_PLUGIN_MARKETPLACE_NAME
  );
}

function normalizeMarketplaceSourceUrl(sourceUrl: string | undefined): string {
  if (!sourceUrl) {
    return '';
  }
  const parsed = parseGitHubSource(sourceUrl);
  if (!parsed) {
    return sourceUrl.trim();
  }
  try {
    return `https://github.com/${normalizeGitHubRepoRef(
      `${parsed.owner}/${parsed.repo}`,
    )}`;
  } catch {
    return sourceUrl.trim();
  }
}

function marketplaceInfoSourceUrl(
  sourceUrl: string,
  sourceType?: string,
): string {
  if (sourceType === 'codex') {
    return sourceUrl.trim();
  }
  return normalizeMarketplaceSourceUrl(sourceUrl);
}

function normalizeMarketplaceId(source: string): string {
  const parsed = parseGitHubSource(source);
  if (!parsed) {
    return source.trim();
  }
  try {
    return normalizeGitHubRepoRef(`${parsed.owner}/${parsed.repo}`);
  } catch {
    return `${parsed.owner}/${parsed.repo}`;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function marketplaceSourceKey(
  source: Pick<
    MarketplaceRefreshSource,
    'sourceUrl' | 'sourceType' | 'codexScanOnly'
  >,
): string {
  if (source.codexScanOnly === true || source.sourceType === 'codex') {
    return `codex:${source.sourceUrl.trim().toLowerCase()}`;
  }
  return normalizeMarketplaceSourceUrl(source.sourceUrl).toLowerCase();
}

function normalizeMarketplaceSourceType(
  sourceType: string | undefined,
  sourceUrl: string,
): string {
  if (sourceType === 'codex') {
    return 'codex';
  }
  if (parseGitHubSource(sourceUrl)) {
    return 'github';
  }
  return sourceType ?? 'github';
}

// Types that are definitively not Git-configured, so `marketplace/upgrade`
// would reject them. Everything else — including source types this build has
// never seen — stays upgradeable, matching current behavior.
const NON_GIT_CODEX_MARKETPLACE_SOURCE_TYPES = new Set([
  'codex',
  'local',
  'directory',
  'builtin',
  'curated',
]);

function isGitBackedCodexMarketplaceSource(input: {
  sourceType?: string;
  sourceUrl: string;
}): boolean {
  const sourceType = normalizeMarketplaceSourceType(
    input.sourceType,
    input.sourceUrl,
  );
  return !NON_GIT_CODEX_MARKETPLACE_SOURCE_TYPES.has(sourceType);
}

function knownMarketplaceSourceUrl(
  entry: KnownMarketplaceEntry | null | undefined,
): string {
  return normalizeMarketplaceSourceUrl(
    entry?.source?.repo ?? entry?.source?.url,
  );
}

function knownMarketplaceSourceType(
  entry: KnownMarketplaceEntry | null | undefined,
): string | undefined {
  if (!entry) {
    return undefined;
  }
  return normalizeMarketplaceSourceType(
    entry.source.source,
    knownMarketplaceSourceUrl(entry),
  );
}

function readCodexMarketplaceInstallSource(
  installedRoot: string | undefined,
): { sourceUrl: string; sourceType: string } | null {
  if (!installedRoot) {
    return null;
  }

  const metadata = safeReadJson<{
    source?: unknown;
    source_type?: unknown;
  }>(path.join(installedRoot, '.codex-marketplace-install.json'));
  if (!metadata || typeof metadata.source !== 'string') {
    return null;
  }

  return {
    sourceUrl: normalizeMarketplaceSourceUrl(metadata.source),
    sourceType: normalizeMarketplaceSourceType(
      typeof metadata.source_type === 'string' ? metadata.source_type : 'codex',
      metadata.source,
    ),
  };
}

function codexDiscoveredMarketplaceSource(
  entry: PluginMarketplaceEntry,
): CodexDiscoveredMarketplaceSource {
  const installedRoot = codexMarketplaceRootFromPath(entry.path) ?? undefined;
  const installedSource = readCodexMarketplaceInstallSource(installedRoot);
  const sourceUrl = installedSource?.sourceUrl ?? entry.name;
  const hasClaudeMarketplaceManifest = installedRoot
    ? fs.existsSync(
        path.join(installedRoot, '.claude-plugin', 'marketplace.json'),
      )
    : false;
  return {
    id: installedSource ? normalizeMarketplaceId(sourceUrl) : entry.name,
    sourceUrl,
    sourceType: installedSource?.sourceType ?? 'codex',
    marketplaceName: entry.name,
    installedRoot,
    // Source metadata alone does not make a Codex catalog compatible with
    // Claude. Registering a Codex-only repository makes Claude clone and reject
    // it on every refresh, leaking the provider's staging directory each time.
    scanOnly: installedSource === null || !hasClaudeMarketplaceManifest,
    listedMarketplace: entry,
  };
}

function mergeMarketplaceRefreshSource(
  existing: MarketplaceRefreshSource | undefined,
  incoming: MarketplaceRefreshSource,
): MarketplaceRefreshSource {
  if (!existing) {
    return {
      ...incoming,
      sourceType: normalizeMarketplaceSourceType(
        incoming.sourceType,
        incoming.sourceUrl,
      ),
    };
  }

  const sourceUrl = existing.sourceUrl || incoming.sourceUrl;
  const sourceType = normalizeMarketplaceSourceType(
    existing.sourceType ?? incoming.sourceType,
    sourceUrl,
  );
  return {
    id: existing.id,
    sourceUrl,
    knownEntry: existing.knownEntry ?? incoming.knownEntry,
    knownId: existing.knownId ?? incoming.knownId,
    v1SourceType: existing.v1SourceType ?? incoming.v1SourceType,
    v1InstallLocation: existing.v1InstallLocation ?? incoming.v1InstallLocation,
    v1LastUpdated: existing.v1LastUpdated ?? incoming.v1LastUpdated,
    codexMarketplaceName:
      incoming.codexMarketplaceName ?? existing.codexMarketplaceName,
    codexInstalledRoot:
      incoming.codexInstalledRoot ?? existing.codexInstalledRoot,
    // Later Codex discovery is authoritative over a persisted cache row. This
    // keeps a freshly detected scan-only source sticky without preventing a
    // future manifest from advertising newly added Claude compatibility.
    codexScanOnly: incoming.codexScanOnly ?? existing.codexScanOnly,
    codexListedMarketplace:
      incoming.codexListedMarketplace ?? existing.codexListedMarketplace,
    sourceType,
  };
}

function isPersistedCodexScanOnlyMarketplace(
  marketplace: MarketplaceInfo,
): boolean {
  return (
    marketplace.sourceType === 'codex' ||
    marketplace.providerStatus.claude.error ===
      'Marketplace is available only through Codex.'
  );
}

function providerStatus(
  provider: PluginProvider,
  input: Partial<MarketplaceProviderStatus>,
): MarketplaceProviderStatus {
  const accepted = input.accepted === true;
  const pluginCount = input.pluginCount ?? 0;
  return {
    provider,
    state: accepted && pluginCount > 0 ? 'valid' : 'invalid',
    accepted,
    pluginCount,
    lastCheckedAt: input.lastCheckedAt ?? nowIso(),
    error: input.error,
    marketplaceName: input.marketplaceName,
    marketplacePath: input.marketplacePath,
    installLocation: input.installLocation,
    structurallyInvalidAtRevision: input.structurallyInvalidAtRevision,
  };
}

function providerSummary(status: MarketplaceProviderStatus): string {
  if (status.accepted && status.pluginCount === 0) {
    return 'accepted, 0 plugins detected';
  }
  if (!status.accepted && status.error) {
    return `rejected (${status.error})`;
  }
  if (!status.accepted) {
    return 'rejected';
  }
  return `${status.pluginCount} plugins detected`;
}

function reportMarketplaceProgress(
  report: MarketplaceProgressReporter | undefined,
  operation: MarketplaceOperationKind,
  input: Omit<MarketplaceOperationProgress, 'operation'>,
): void {
  report?.({ operation, ...input });
}

type ClaudeMarketplaceOperationResult = {
  accepted: boolean;
  error?: string;
};

function readKnownMarketplaces(): KnownMarketplacesFile {
  return safeReadJson<KnownMarketplacesFile>(getKnownMarketplacesPath()) ?? {};
}

function findKnownMarketplaceBySource(
  known: KnownMarketplacesFile,
  sourceUrl: string,
): { id: string; entry: KnownMarketplaceEntry } | null {
  const normalized = normalizeMarketplaceSourceUrl(sourceUrl);
  for (const [id, entry] of Object.entries(known)) {
    if (knownMarketplaceSourceUrl(entry) === normalized) {
      return { id, entry };
    }
  }
  return null;
}

function manifestText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function manifestAuthor(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : isRecord(value)
      ? manifestText(value.name)
      : undefined;
}

function readClaudePluginFacet(args: {
  marketplaceId: string;
  marketplaceInstallDir: string;
  pluginEntry: MarketplaceManifest['plugins'][number];
  cacheIndex: PluginCacheIndex;
}): PluginProviderFacet | null {
  const { marketplaceId, marketplaceInstallDir, pluginEntry, cacheIndex } =
    args;
  if (
    !pluginEntry ||
    typeof pluginEntry.name !== 'string' ||
    !pluginEntry.name
  ) {
    return null;
  }

  const resolvedRoot = path.resolve(marketplaceInstallDir);
  const sourcePath =
    typeof pluginEntry.source === 'string' ? pluginEntry.source : null;
  const source = pluginEntry.source;
  if (
    source !== undefined &&
    typeof source !== 'string' &&
    (!isRecord(source) ||
      (source.source !== undefined && typeof source.source !== 'string') ||
      (source.url !== undefined && typeof source.url !== 'string'))
  )
    return null;
  const externalSource =
    isRecord(source) &&
    (source.source === undefined || typeof source.source === 'string') &&
    (source.url === undefined || typeof source.url === 'string')
      ? {
          ...source,
          source: source.source,
          url: source.url,
          sha: manifestText(source.sha),
        }
      : undefined;

  let pluginManifest: PluginManifest | null = null;
  let pluginDir: string | null = null;
  let cachePath: string | undefined;
  let cachedAt: string | undefined;

  if (sourcePath) {
    pluginDir = path.resolve(marketplaceInstallDir, sourcePath);
    if (!isPathInside(resolvedRoot, pluginDir)) {
      return null;
    }
    pluginManifest = safeReadJson<PluginManifest>(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    );
  } else if (typeof externalSource?.url === 'string') {
    const cached =
      cacheIndex.entries[cacheKey(marketplaceId, pluginEntry.name)];
    if (cached && fs.existsSync(cached.cachePath)) {
      pluginDir = cached.cachePath;
      cachePath = cached.cachePath;
      cachedAt = cached.cachedAt;
      pluginManifest = safeReadJson<PluginManifest>(
        path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      );
    }
  }

  const details = pluginDir
    ? scanPluginDetails(pluginDir, pluginManifest)
    : undefined;
  return {
    provider: 'claude',
    mode: 'native',
    name: manifestText(pluginManifest?.name) || pluginEntry.name,
    displayName:
      typeof pluginEntry.displayName === 'string'
        ? pluginEntry.displayName.trim() || undefined
        : undefined,
    description:
      manifestText(pluginManifest?.description) ||
      manifestText(pluginEntry.description) ||
      '',
    version:
      manifestText(pluginManifest?.version) ||
      manifestText(pluginEntry.version) ||
      '',
    author:
      manifestAuthor(pluginManifest?.author) ||
      manifestAuthor(pluginEntry.author) ||
      '',
    category: manifestText(pluginEntry.category) || '',
    homepage:
      manifestText(pluginManifest?.homepage) ||
      manifestText(pluginEntry.homepage) ||
      '',
    installLocation: pluginDir ?? '',
    sourcePath: sourcePath || cachePath || '',
    marketplacePath: path.join(
      marketplaceInstallDir,
      '.claude-plugin',
      'marketplace.json',
    ),
    externalSource,
    cachePath,
    cachedAt,
    details,
  };
}

function scanClaudeMarketplace(input: {
  id: string;
  entry: KnownMarketplaceEntry | null;
}): {
  facets: PluginProviderFacet[];
  status: MarketplaceProviderStatus;
  name?: string;
  description?: string;
  sourceUrl?: string;
  installLocation?: string;
  lastUpdated?: string;
} {
  const { id, entry } = input;
  if (!entry?.installLocation || !fs.existsSync(entry.installLocation)) {
    return {
      facets: [],
      status: providerStatus('claude', {
        accepted: false,
        error: entry
          ? 'Claude marketplace install location is missing.'
          : undefined,
      }),
    };
  }

  const manifestPath = path.join(
    entry.installLocation,
    '.claude-plugin',
    'marketplace.json',
  );
  const manifest = safeReadJson<MarketplaceManifest>(manifestPath);
  if (!manifest || !Array.isArray(manifest.plugins)) {
    return {
      facets: [],
      status: providerStatus('claude', {
        accepted: true,
        pluginCount: 0,
        marketplacePath: manifestPath,
        installLocation: entry.installLocation,
        error: 'No Claude plugins were detected.',
      }),
      sourceUrl: knownMarketplaceSourceUrl(entry),
      installLocation: entry.installLocation,
      lastUpdated: manifestText(entry.lastUpdated),
    };
  }

  const cacheIndex = readCacheIndex();
  const facets = manifest.plugins
    .map((pluginEntry) =>
      readClaudePluginFacet({
        marketplaceId: id,
        marketplaceInstallDir: entry.installLocation,
        pluginEntry,
        cacheIndex,
      }),
    )
    .filter((facet): facet is PluginProviderFacet => facet !== null);

  return {
    facets,
    status: providerStatus('claude', {
      accepted: true,
      pluginCount: facets.length,
      marketplaceName: manifestText(manifest.name) || id,
      marketplacePath: manifestPath,
      installLocation: entry.installLocation,
      error:
        facets.length === 0 ? 'No Claude plugins were detected.' : undefined,
    }),
    name: manifestText(manifest.name) || id,
    description: manifestText(manifest.description) || '',
    sourceUrl: knownMarketplaceSourceUrl(entry),
    installLocation: entry.installLocation,
    lastUpdated: manifestText(entry.lastUpdated),
  };
}

function pluginMetadataFromSummary(summary: PluginSummary | undefined): {
  description: string;
  author: string;
  category: string;
  homepage: string;
  logoUrl?: string;
  displayName?: string;
} {
  return {
    displayName: manifestText(summary?.interface?.displayName) ?? undefined,
    description:
      manifestText(summary?.interface?.shortDescription) ??
      manifestText(summary?.interface?.longDescription) ??
      '',
    author: manifestText(summary?.interface?.developerName) ?? '',
    category: manifestText(summary?.interface?.category) ?? '',
    homepage: manifestText(summary?.interface?.websiteUrl) ?? '',
    logoUrl: manifestText(summary?.interface?.logoUrl) ?? undefined,
  };
}

interface CodexMarketplaceManifestPluginEntry {
  name?: string;
  source?: { source?: string; path?: string } | string;
  category?: string;
}

interface CodexMarketplaceManifest {
  name?: string;
  interface?: { displayName?: string };
  plugins?: CodexMarketplaceManifestPluginEntry[];
}

function readCodexLocalPluginFacet(args: {
  marketplaceRoot: string;
  marketplacePath: string;
  pluginEntry: CodexMarketplaceManifestPluginEntry;
}): PluginProviderFacet | null {
  const { marketplaceRoot, marketplacePath, pluginEntry } = args;
  if (!pluginEntry) return null;
  const sourcePath =
    typeof pluginEntry.source === 'string'
      ? pluginEntry.source
      : pluginEntry.source?.source === 'local'
        ? pluginEntry.source.path
        : undefined;
  if (
    typeof pluginEntry.name !== 'string' ||
    !pluginEntry.name ||
    typeof sourcePath !== 'string' ||
    !sourcePath
  ) {
    return null;
  }
  const pluginRoot = path.resolve(marketplaceRoot, sourcePath);
  if (!isPathInside(marketplaceRoot, pluginRoot)) {
    return null;
  }
  const manifest = safeReadJson<PluginManifest & Record<string, unknown>>(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
  );
  if (!manifest) {
    return null;
  }
  const details = scanPluginDetails(pluginRoot, manifest, {
    manifestKind: 'codex',
  });
  return {
    provider: 'codex',
    mode: 'native',
    name: typeof manifest.name === 'string' ? manifest.name : pluginEntry.name,
    displayName:
      typeof manifest.interface === 'object' &&
      manifest.interface !== null &&
      'displayName' in manifest.interface &&
      typeof manifest.interface.displayName === 'string'
        ? manifest.interface.displayName
        : undefined,
    description:
      (typeof manifest.description === 'string' ? manifest.description : '') ||
      '',
    version:
      (typeof manifest.version === 'string' ? manifest.version : '') || '',
    author: manifestAuthor(manifest.author) ?? '',
    category: manifestText(pluginEntry.category) ?? '',
    homepage:
      (typeof manifest.homepage === 'string' ? manifest.homepage : '') || '',
    installLocation: pluginRoot,
    sourcePath: pluginRoot,
    marketplacePath,
    details,
  };
}

function scanBundledCodexMarketplace(
  manifest: CodexMarketplaceManifest | null = safeReadJson<CodexMarketplaceManifest>(
    getBundledCodexPluginMarketplaceManifestPath(),
  ),
): {
  facets: PluginProviderFacet[];
  status: MarketplaceProviderStatus;
  name?: string;
} {
  const manifestPath = getBundledCodexPluginMarketplaceManifestPath();
  if (!manifest || !Array.isArray(manifest.plugins)) {
    return {
      facets: [],
      status: providerStatus('codex', {
        accepted: false,
        marketplaceName: getBuiltInProviderMarketplaceName(),
        marketplacePath: manifestPath,
        installLocation: getBundledPluginsDir(),
        error: fs.existsSync(manifestPath)
          ? 'No Codex plugins were detected.'
          : undefined,
      }),
    };
  }

  const facets = manifest.plugins
    .map((pluginEntry) =>
      readCodexLocalPluginFacet({
        marketplaceRoot: getBundledPluginsDir(),
        marketplacePath: manifestPath,
        pluginEntry,
      }),
    )
    .filter((facet): facet is PluginProviderFacet => facet !== null);

  return {
    facets,
    name:
      manifestText(manifest.interface?.displayName) ??
      manifestText(manifest.name),
    status: providerStatus('codex', {
      accepted: true,
      pluginCount: facets.length,
      marketplaceName:
        manifestText(manifest.name) ?? getBuiltInProviderMarketplaceName(),
      marketplacePath: manifestPath,
      installLocation: getBundledPluginsDir(),
      error:
        facets.length === 0 ? 'No Codex plugins were detected.' : undefined,
    }),
  };
}

function readClaudeBuiltInPluginInstallStatus(
  pluginName: string,
  version?: string,
  marketplaceName: string = getBuiltInProviderMarketplaceName(),
): BuiltInProviderInstallStatus {
  const key = `${pluginName}@${marketplaceName}`;
  try {
    const installedPluginsPath = getClaudeInstalledPluginsPath();
    const installedPlugins = safeReadJson<unknown>(installedPluginsPath);
    if (installedPlugins === null && fs.existsSync(installedPluginsPath)) {
      // The file is there but could not be read or parsed: the install state
      // is unknown, which is not the same as "not installed".
      return {
        available: true,
        installed: false,
        version,
        error: `Could not read ${installedPluginsPath}.`,
      };
    }
    // Parse the file with the helpers and user-scope rule chats use when they
    // inherit Claude plugins without a project.
    const entry = claudeInstalledPluginsMap(installedPlugins)?.[key];
    const entries = Array.isArray(entry) ? entry : entry ? [entry] : [];
    for (const candidate of entries) {
      // Installs here are user-scoped; a project or local install belongs to
      // one repository and does not make the plugin available everywhere.
      if (!isRecord(candidate) || !isUserScopedInstall(candidate)) {
        continue;
      }
      const installPath = installPathOf(candidate);
      if (installPath === undefined || !isPluginInstallRoot(installPath)) {
        continue;
      }
      const settingsPath = getClaudeSettingsPath();
      const settings = safeReadJson<{
        enabledPlugins?: Record<string, boolean>;
      }>(settingsPath);
      if (settings === null && fs.existsSync(settingsPath)) {
        // The settings file is there but could not be read or parsed, so
        // whether the user turned the plugin off is unknown: a failed read,
        // not "on".
        return {
          available: true,
          installed: true,
          version,
          installPath,
          error: `Could not read ${settingsPath}.`,
        };
      }
      return {
        available: true,
        installed: true,
        enabled: settings?.enabledPlugins?.[key] !== false,
        version,
        installPath,
      };
    }
  } catch (error) {
    return {
      available: true,
      installed: false,
      version,
      error: errorMessage(error),
    };
  }
  return { available: true, installed: false, version };
}

/** The on-disk root of a marketplace Canopy manages, by its provider name. */
function managedMarketplaceRootForName(
  marketplaceName: string,
): string | undefined {
  if (marketplaceName === getBuiltInProviderMarketplaceName())
    return path.resolve(getBundledPluginsDir());
  if (marketplaceName === getCuratedPluginMarketplaceName())
    return path.resolve(getCuratedPluginsMarketplaceDir());
  return undefined;
}

/**
 * Why Codex could not load the managed marketplace `marketplaceName`, when
 * `plugin/list` reports a load error under its root; `undefined` when it
 * loaded, or when the failures belong to other marketplaces.
 */
function managedMarketplaceLoadError(
  list: CodexPluginList,
  marketplaceName: string,
): string | undefined {
  const root = managedMarketplaceRootForName(marketplaceName);
  if (root === undefined) return undefined;
  return list.marketplaceLoadErrors.find((failure) =>
    isPathInside(root, failure.marketplacePath),
  )?.message;
}

async function readCodexBuiltInPluginInstallStatus(
  pluginName: string,
  version?: string,
  pluginListResult?: CodexPluginListResult,
  marketplaceName: string = getBuiltInProviderMarketplaceName(),
): Promise<BuiltInProviderInstallStatus> {
  try {
    const listResult =
      pluginListResult ??
      ({
        success: true,
        data: await listCodexPlugins(),
      } satisfies CodexPluginListResult);
    if (!listResult.success) {
      return {
        available: true,
        installed: false,
        version,
        error: listResult.error,
      };
    }
    const list = listResult.data;
    const marketplace = list.marketplaces.find(
      (entry) => entry.name === marketplaceName,
    );
    if (marketplace === undefined) {
      // A marketplace Codex failed to load is missing from the list, which
      // would read as "not installed" for every plugin in it.
      const loadError = managedMarketplaceLoadError(list, marketplaceName);
      if (loadError !== undefined) {
        return { available: true, installed: false, version, error: loadError };
      }
    }
    const summary = marketplace?.plugins.find(
      (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
    );
    return {
      available: true,
      installed: summary?.installed === true,
      enabled:
        typeof summary?.enabled === 'boolean' ? summary.enabled : undefined,
      version: manifestText(version) ?? manifestText(summary?.localVersion),
    };
  } catch (error) {
    return {
      available: true,
      installed: false,
      version,
      error: errorMessage(error),
    };
  }
}

async function readBuiltInPluginInstallStatus(
  plugin: PluginInfo,
  codexPluginListResult?: CodexPluginListResult,
  marketplaceName: string = getBuiltInProviderMarketplaceName(),
): Promise<BuiltInPluginInstallStatus> {
  const status: BuiltInPluginInstallStatus = { checkedAt: nowIso() };
  if (plugin.facets.claude) {
    status.claude = readClaudeBuiltInPluginInstallStatus(
      plugin.facets.claude.name,
      plugin.facets.claude.version,
      marketplaceName,
    );
  } else {
    status.claude = { available: false, installed: false };
  }
  if (plugin.facets.codex) {
    status.codex = await readCodexBuiltInPluginInstallStatus(
      plugin.facets.codex.name,
      plugin.facets.codex.version,
      codexPluginListResult,
      marketplaceName,
    );
  } else {
    status.codex = { available: false, installed: false };
  }
  return status;
}

/**
 * Populates `globalInstallStatus` for the plugins of a locally managed
 * marketplace (built-in or curated), sharing one `listCodexPlugins()` call
 * across every plugin that has a Codex facet.
 */
async function withManagedPluginInstallStatus(
  plugins: PluginInfo[],
  marketplaceName: string,
): Promise<PluginInfo[]> {
  const codexPluginListResult: CodexPluginListResult | undefined = plugins.some(
    (plugin) => plugin.facets.codex,
  )
    ? await listCodexPlugins()
        .then((data) => ({ success: true as const, data }))
        .catch((error) => ({
          success: false as const,
          error: errorMessage(error),
        }))
    : undefined;
  const pluginsWithStatus: PluginInfo[] = [];
  for (const plugin of plugins) {
    pluginsWithStatus.push({
      ...plugin,
      globalInstallStatus: await readBuiltInPluginInstallStatus(
        plugin,
        codexPluginListResult,
        marketplaceName,
      ),
    });
  }
  return carryOverBuiltInPluginInstallErrors(pluginsWithStatus);
}

const BUILT_IN_INSTALL_PROVIDERS: readonly PluginProvider[] = [
  'claude',
  'codex',
];

/**
 * A failed install stays on the plugin's cached status until an install into
 * that provider succeeds. A scan rebuilds every status from the provider
 * apps, which know nothing of the attempt, so the recorded failure is carried
 * over from the cache while the plugin remains uninstalled there.
 */
function carryOverBuiltInPluginInstallErrors(
  plugins: PluginInfo[],
): PluginInfo[] {
  const cache = readCache();
  if (cache?.version !== 2) return plugins;
  const previous = new Map<string, BuiltInPluginInstallStatus>();
  for (const marketplace of cache.marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (plugin.globalInstallStatus)
        previous.set(
          `${plugin.marketplaceId}\n${plugin.name}`,
          plugin.globalInstallStatus,
        );
    }
  }
  return plugins.map((plugin) => {
    const before = previous.get(`${plugin.marketplaceId}\n${plugin.name}`);
    const status = plugin.globalInstallStatus;
    if (!before || !status) return plugin;
    let changed = false;
    const next: BuiltInPluginInstallStatus = { ...status };
    for (const provider of BUILT_IN_INSTALL_PROVIDERS) {
      const installError = before[provider]?.installError;
      const current = status[provider];
      if (
        installError === undefined ||
        !current ||
        current.installed ||
        current.installError !== undefined
      )
        continue;
      next[provider] = { ...current, installError };
      changed = true;
    }
    return changed ? { ...plugin, globalInstallStatus: next } : plugin;
  });
}

async function scanCodexMarketplace(input: {
  marketplaceName?: string;
  installedRoot?: string;
  listedMarketplace?: PluginMarketplaceEntry;
  addResult?: CodexMarketplaceOperationResult;
}): Promise<{
  facets: PluginProviderFacet[];
  status: MarketplaceProviderStatus;
  name?: string;
  description?: string;
  installLocation?: string;
}> {
  const { marketplaceName, installedRoot, addResult } = input;
  let accepted = addResult ? addResult.accepted : true;
  const name = addResult?.marketplaceName ?? marketplaceName;
  if (!name) {
    return {
      facets: [],
      status: providerStatus('codex', {
        accepted: false,
        error: addResult?.error,
      }),
    };
  }

  let marketplaceEntry: PluginMarketplaceEntry | undefined;
  try {
    marketplaceEntry = input.listedMarketplace;
    if (!marketplaceEntry) {
      const list = await listCodexPlugins();
      marketplaceEntry = list.marketplaces.find((entry) => entry.name === name);
    }
  } catch (error) {
    return {
      facets: [],
      status: providerStatus('codex', {
        accepted: false,
        marketplaceName: name,
        error: errorMessage(error),
        structurallyInvalidAtRevision:
          addResult?.structurallyInvalidAtRevision ??
          addResult?.structuralRevisionFallback,
      }),
    };
  }

  let resolved;
  try {
    resolved = await resolveCodexPluginInstallRoots(name, {
      listedMarketplace: marketplaceEntry,
      installedRoot: addResult?.installedRoot ?? installedRoot,
    });
  } catch (error) {
    return {
      facets: [],
      status: providerStatus('codex', {
        accepted,
        marketplaceName: name,
        marketplacePath: marketplaceEntry?.path ?? undefined,
        installLocation: addResult?.installedRoot ?? installedRoot,
        error: errorMessage(error),
        structurallyInvalidAtRevision:
          addResult?.structurallyInvalidAtRevision ??
          addResult?.structuralRevisionFallback,
      }),
    };
  }

  const summaryByName = new Map<string, PluginSummary>();
  for (const summary of marketplaceEntry?.plugins ?? []) {
    if (typeof summary?.name === 'string')
      summaryByName.set(summary.name.toLowerCase(), summary);
  }

  const facets = accepted
    ? resolved.locations.map<PluginProviderFacet>((location) => {
        const manifestPath = path.join(
          location.installRoot,
          '.codex-plugin',
          'plugin.json',
        );
        const manifest = safeReadJson<PluginManifest & Record<string, unknown>>(
          manifestPath,
        );
        const summary = summaryByName.get(location.pluginName.toLowerCase());
        const metadata = pluginMetadataFromSummary(summary);
        const details = scanPluginDetails(location.installRoot, manifest, {
          manifestKind: 'codex',
        });
        return {
          provider: 'codex',
          mode: 'native',
          name:
            typeof manifest?.name === 'string'
              ? manifest.name
              : location.pluginName,
          displayName: metadata.displayName,
          description:
            (typeof manifest?.description === 'string'
              ? manifest.description
              : '') || metadata.description,
          version:
            (typeof manifest?.version === 'string' ? manifest.version : '') ||
            manifestText(summary?.localVersion) ||
            '',
          author: (manifestAuthor(manifest?.author) ?? '') || metadata.author,
          category: metadata.category,
          homepage:
            (typeof manifest?.homepage === 'string' ? manifest.homepage : '') ||
            metadata.homepage,
          logoUrl: metadata.logoUrl,
          installLocation: location.installRoot,
          sourcePath: location.installRoot,
          marketplacePath: marketplaceEntry?.path ?? undefined,
          details,
        };
      })
    : [];

  const unresolvedMessages = resolved.unresolved.map(
    (entry) => `${entry.pluginName}: ${entry.reason}`,
  );
  const operationError =
    addResult?.alreadySatisfied && !addResult.structurallyInvalidAtRevision
      ? undefined
      : addResult?.error;
  const structuralError =
    unresolvedMessages.join('; ') ||
    operationError ||
    (facets.length === 0 ? 'No Codex plugins were detected.' : undefined);
  // Classify PER ENTRY, never over the joined reason string. `structuralError`
  // is `unresolvedMessages.join('; ')` and the structural check is a `.test()`
  // that matches anywhere in it, which is wrong in two distinct ways:
  //
  //   1. ONE structural entry makes a whole mixed set structural. A
  //      marketplace with some Claude-only plugins and some Codex plugins gets
  //      deregistered as soon as the Codex plugin is unresolvable - whether
  //      because its checkout is mid-clone, or because it uses a `git`/
  //      `remote` source whose install path the app-server does not expose. In
  //      the latter case Canopy cannot tell whether a Codex facet exists at
  //      all, so "no evidence" must not read as "no facet".
  //   2. `[^\n]*` spans the `'; '` separator, so two individually
  //      NON-structural reasons can combine into a match ("...is missing from
  //      the manifest" + "...needs .codex-plugin/plugin.json").
  //
  // Requiring EVERY entry to be individually structural closes both, and
  // subsumes the narrower transient veto this replaces. Deregistration mutates
  // Codex's own state, so a false positive costs the user plugins in Codex
  // itself, not just in Canopy's catalog - the verdict has to be earned by
  // every entry, not by a substring somewhere in their concatenation.
  const structuralUnresolvedVerdict =
    resolved.unresolved.length > 0
      ? resolved.unresolved.every((entry) =>
          isStructuralCodexMarketplaceFailure(entry.reason),
        )
      : // Nothing unresolved to classify. An accepted operation with no
        // locations, or an explicit structural provider error, is positive
        // evidence of absence. A silent no-op is not: `structuralError`
        // degrades to the `'No Codex plugins were detected.'` literal in that
        // case even when manifest-verified locations were found.
        //
        // Defence in depth: this arm cannot currently reach a deregistration,
        // because an empty `unresolved` implies every plugin resolved into
        // `locations`, while the guard below requires `locations` to be empty.
        // Kept so the verdict stays correct on its own terms if
        // `resolveCodexPluginInstallRoots` ever yields neither - do not delete
        // it on the assumption the guard makes it redundant.
        (accepted || operationError !== undefined) &&
        isStructuralCodexMarketplaceFailure(structuralError);
  let structurallyInvalidAtRevision = addResult?.structurallyInvalidAtRevision;
  if (
    // `facets` is NOT evidence of absence on its own - it is zeroed by
    // `accepted` above, which reflects the add/upgrade operation rather than
    // the marketplace's contents. `upgradeCodexMarketplace` returns
    // `{ accepted: false, error: undefined }` whenever `marketplace/upgrade`
    // responds `{ selectedMarketplaces: [], errors: [] }`, so a perfectly
    // healthy marketplace can reach here with manifest-verified plugins
    // sitting in `resolved.locations`. Deregistration mutates Codex's own
    // state, so it requires POSITIVE evidence that the scan found no Codex
    // plugin locations at all.
    facets.length === 0 &&
    resolved.locations.length === 0 &&
    !structurallyInvalidAtRevision &&
    structuralUnresolvedVerdict
  ) {
    const installMetadata = await readCodexMarketplaceInstallMetadata(name);
    const revisionRoot = addResult?.installedRoot ?? installedRoot;
    const revision =
      addResult?.structuralFailureRevision ??
      installMetadata?.revision ??
      (revisionRoot ? await getHeadCommitSha(revisionRoot) : null);
    // Deregistration is safe only when the suppression decision can be tied to
    // a concrete revision. Otherwise the next refresh would target a removed
    // marketplace by its persisted name and recreate the churn this guard is
    // intended to stop.
    if (revision) {
      const removal = await removeCodexMarketplace(name);
      // Stamp the TESTED revision even when removal fails. A structurally
      // failed `add` usually leaves nothing registered, so removal failing is
      // the common case rather than the exception - and falling through to
      // `structuralRevisionFallback` (the OLDER revision) would make the next
      // provider update see a changed revision again and retry the add/remove
      // forever, once per TTL cycle. Suppression is keyed on "this revision was
      // tested and found structurally invalid", which is true regardless of
      // whether Codex still had a registration to drop.
      structurallyInvalidAtRevision = revision;
      if (removal.accepted) {
        accepted = false;
      }
    }
  }
  if (facets.length === 0 && !structurallyInvalidAtRevision) {
    structurallyInvalidAtRevision = addResult?.structuralRevisionFallback;
  }
  return {
    facets,
    status: providerStatus('codex', {
      accepted,
      pluginCount: facets.length,
      marketplaceName: name,
      marketplacePath: marketplaceEntry?.path ?? undefined,
      installLocation: addResult?.installedRoot ?? installedRoot,
      error:
        facets.length === 0
          ? structuralError
          : unresolvedMessages.length > 0
            ? unresolvedMessages.join('; ')
            : operationError,
      structurallyInvalidAtRevision:
        facets.length === 0 ? structurallyInvalidAtRevision : undefined,
    }),
    name: manifestText(marketplaceEntry?.interface?.displayName) ?? name,
    installLocation: addResult?.installedRoot ?? installedRoot,
  };
}

// The bundled marketplace is static at runtime, but scanning it reads the
// manifest plus per-plugin facets from disk. It sits on the terminal-launch
// hot path (resolvePlugins → loadMarketplaces), so memoize briefly; the TTL
// keeps dev rebuilds reasonably fresh without paying the scan per launch.
const BUILTIN_MARKETPLACE_SCAN_TTL_MS = 30_000;
let builtInMarketplaceScanCache: {
  scannedAt: number;
  marketplace: MarketplaceInfo | null;
} | null = null;

/**
 * @internal — exposed for testing only. Resets every locally managed
 * marketplace scan memo (built-in and curated).
 */
export function resetBuiltInMarketplaceScanCacheForTests(): void {
  builtInMarketplaceScanCache = null;
  invalidateCuratedMarketplaceScanCache();
}

async function scanBuiltInMarketplace(): Promise<MarketplaceInfo | null> {
  if (
    builtInMarketplaceScanCache &&
    Date.now() - builtInMarketplaceScanCache.scannedAt <
      BUILTIN_MARKETPLACE_SCAN_TTL_MS
  ) {
    // Clone so downstream merge/overlay steps can never mutate the cache.
    return structuredClone(builtInMarketplaceScanCache.marketplace);
  }
  const marketplace = await scanBuiltInMarketplaceUncached();
  builtInMarketplaceScanCache = { scannedAt: Date.now(), marketplace };
  return structuredClone(marketplace);
}

async function scanBuiltInMarketplaceUncached(): Promise<MarketplaceInfo | null> {
  const cacheIndex = readCacheIndex();
  const claudeManifestPath = getBundledClaudePluginMarketplaceManifestPath();
  const claudeManifest =
    safeReadJson<MarketplaceManifest>(claudeManifestPath) ?? null;
  const codexManifest =
    safeReadJson<CodexMarketplaceManifest>(
      getBundledCodexPluginMarketplaceManifestPath(),
    ) ?? null;
  const hasClaudeManifest = !!claudeManifest;
  const hasCodexManifest = !!codexManifest;
  if (!hasClaudeManifest && !hasCodexManifest) {
    return null;
  }
  const claudeFacets =
    claudeManifest && Array.isArray(claudeManifest.plugins)
      ? claudeManifest.plugins
          .map((pluginEntry) =>
            readClaudePluginFacet({
              marketplaceId: BUILTIN_PLUGIN_MARKETPLACE_ID,
              marketplaceInstallDir: getBundledPluginsDir(),
              pluginEntry,
              cacheIndex,
            }),
          )
          .filter((facet): facet is PluginProviderFacet => facet !== null)
      : [];
  const claudeStatus = providerStatus('claude', {
    accepted: hasClaudeManifest,
    pluginCount: claudeFacets.length,
    marketplaceName:
      manifestText(claudeManifest?.name) ?? getBuiltInProviderMarketplaceName(),
    marketplacePath: claudeManifestPath,
    installLocation: getBundledPluginsDir(),
    error:
      hasClaudeManifest && claudeFacets.length === 0
        ? 'No Claude plugins were detected.'
        : undefined,
  });
  const codex = scanBundledCodexMarketplace(codexManifest);
  const plugins = mergeProviderPluginFacets({
    marketplaceId: BUILTIN_PLUGIN_MARKETPLACE_ID,
    claudePlugins: claudeFacets,
    codexPlugins: codex.facets,
  });
  const pluginsWithStatus: PluginInfo[] = (
    await withManagedPluginInstallStatus(
      plugins,
      getBuiltInProviderMarketplaceName(),
    )
  ).map((plugin) => ({ ...plugin, builtIn: true }));
  const validProviders: PluginProvider[] = [
    ...(claudeStatus.state === 'valid' ? (['claude'] as const) : []),
    ...(codex.status.state === 'valid' ? (['codex'] as const) : []),
  ];
  return {
    id: BUILTIN_PLUGIN_MARKETPLACE_ID,
    name: getBuiltInMarketplaceDisplayName(),
    description: `Built-in plugins bundled with ${BRAND.displayName}.`,
    sourceType: 'builtin',
    sourceUrl: BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL,
    installLocation: getBundledPluginsDir(),
    lastUpdated: nowIso(),
    builtIn: true,
    removable: false,
    pluginCount: pluginsWithStatus.length,
    plugins: pluginsWithStatus,
    providerStatus: {
      claude: claudeStatus,
      codex: codex.status,
    },
    validProviders,
  };
}

async function mergeBuiltInMarketplace(
  marketplaces: MarketplaceInfo[],
): Promise<MarketplaceInfo[]> {
  const scanned = await scanBuiltInMarketplace();
  const withoutBuiltIn = marketplaces.filter(
    (marketplace) => marketplace.id !== BUILTIN_PLUGIN_MARKETPLACE_ID,
  );
  return scanned ? [...withoutBuiltIn, scanned] : withoutBuiltIn;
}

/**
 * Scan primitives handed to `curated-plugin-marketplace.ts`. They are passed
 * in rather than imported there so this module stays the only side of that
 * relationship with an import (see that module's header).
 */
const curatedMarketplaceScanDeps: CuratedMarketplaceScanDeps = {
  readClaudeFacets: ({
    marketplaceId,
    marketplaceInstallDir,
    pluginEntries,
  }) => {
    const cacheIndex = readCacheIndex();
    return pluginEntries
      .map((pluginEntry) =>
        readClaudePluginFacet({
          marketplaceId,
          marketplaceInstallDir,
          pluginEntry,
          cacheIndex,
        }),
      )
      .filter((facet): facet is PluginProviderFacet => facet !== null);
  },
  readCodexFacets: ({ marketplaceRoot, marketplacePath, pluginEntries }) =>
    pluginEntries
      .map((pluginEntry) =>
        readCodexLocalPluginFacet({
          marketplaceRoot,
          marketplacePath,
          pluginEntry,
        }),
      )
      .filter((facet): facet is PluginProviderFacet => facet !== null),
  mergeProviderPluginFacets,
  providerStatus,
  readInstallStatuses: ({ plugins, marketplaceName }) =>
    withManagedPluginInstallStatus(plugins, marketplaceName),
};

/**
 * Applies both locally managed marketplace rows to a marketplace list.
 * Built-in is merged first and curated second, so managed rows always land in
 * a stable order at the end of the list: `[...external, built-in, curated]`.
 */
async function mergeManagedMarketplaces(
  marketplaces: MarketplaceInfo[],
): Promise<MarketplaceInfo[]> {
  return mergeCuratedMarketplace(
    await mergeBuiltInMarketplace(marketplaces),
    curatedMarketplaceScanDeps,
  );
}

/** Scans whichever locally managed marketplace `marketplaceId` names. */
async function scanManagedMarketplace(
  marketplaceId: string,
): Promise<MarketplaceInfo | null> {
  return isCuratedPluginMarketplaceId(marketplaceId)
    ? scanCuratedMarketplace(curatedMarketplaceScanDeps)
    : scanBuiltInMarketplace();
}

/**
 * Replaces the cached curated row with the post-sync filesystem scan. The
 * invocable-inventory rebuild is cache-only, so this write must complete
 * before callers trigger it. An empty scan removes the stale cached row.
 */
async function persistCuratedMarketplaceAfterSync(): Promise<void> {
  const marketplace = await scanCuratedMarketplace(curatedMarketplaceScanDeps);
  await withCacheLock(() => {
    const latestCache = readCache();
    if (!latestCache) {
      if (!marketplace) return;
      // Cache-only onboarding reads need the newly materialized curated row
      // even before the first full marketplace discovery. Keep the refresh
      // stamp empty so the normal load path still performs that discovery
      // instead of treating this curated-only bootstrap cache as complete.
      writeCache({
        version: 2,
        lastRefreshed: '',
        marketplaces: [marketplace],
      });
      return;
    }
    const baseCache =
      latestCache.version === 2
        ? latestCache
        : migrateLegacyCacheForFastLoad(latestCache);
    const marketplaces = baseCache.marketplaces.filter(
      (entry) => !isCuratedPluginMarketplaceId(entry.id),
    );
    if (marketplace) {
      marketplaces.push(
        mergePreservedCacheState([marketplace], latestCache)[0] ?? marketplace,
      );
    }
    writeCache({
      ...baseCache,
      lastRefreshed: baseCache.lastRefreshed,
      marketplaces,
    });
  });
}

/** Drops the scan memo of whichever managed marketplace `marketplaceId` names. */
function invalidateManagedMarketplaceScanCache(marketplaceId: string): void {
  if (isCuratedPluginMarketplaceId(marketplaceId)) {
    invalidateCuratedMarketplaceScanCache();
    return;
  }
  builtInMarketplaceScanCache = null;
}

/**
 * The built-in and curated marketplaces read fresh from the provider apps,
 * past the scan memo, for a caller that must not act on a stale snapshot:
 * the provider plugin backfill plans installs from what the other provider
 * has installed and enabled right now.
 */
export async function scanManagedMarketplacesFresh(): Promise<
  MarketplaceInfo[]
> {
  builtInMarketplaceScanCache = null;
  invalidateCuratedMarketplaceScanCache();
  const rows = await settleAll([
    scanBuiltInMarketplace(),
    scanCuratedMarketplace(curatedMarketplaceScanDeps),
  ]);
  return rows.filter((row): row is MarketplaceInfo => row !== null);
}

/**
 * Provider-facing marketplace name and local source root for a locally
 * managed marketplace, or `null` when the id is not a managed marketplace.
 */
function resolveManagedMarketplaceTarget(
  marketplaceId: string,
): { marketplaceName: string; root: string } | null {
  if (marketplaceId === BUILTIN_PLUGIN_MARKETPLACE_ID) {
    return {
      marketplaceName: getBuiltInProviderMarketplaceName(),
      root: path.resolve(getBundledPluginsDir()),
    };
  }
  if (isCuratedPluginMarketplaceId(marketplaceId)) {
    return {
      marketplaceName: getCuratedPluginMarketplaceName(),
      root: path.resolve(getCuratedPluginsMarketplaceDir()),
    };
  }
  return null;
}

export function mergeProviderPluginFacets(input: {
  marketplaceId: string;
  claudePlugins: PluginProviderFacet[];
  codexPlugins: PluginProviderFacet[];
}): PluginInfo[] {
  const byName = new Map<
    string,
    { claude?: PluginProviderFacet; codex?: PluginProviderFacet }
  >();
  for (const facet of input.claudePlugins) {
    const key = facet.name.toLowerCase();
    byName.set(key, { ...byName.get(key), claude: facet });
  }
  for (const facet of input.codexPlugins) {
    const key = facet.name.toLowerCase();
    byName.set(key, { ...byName.get(key), codex: facet });
  }

  return Array.from(byName.values())
    .map((facets) => {
      const canonical = facets.claude ?? facets.codex;
      const codexSupport = facets.codex
        ? 'native'
        : facets.claude
          ? 'compat'
          : 'none';
      const plugin: PluginInfo = {
        name: canonical?.name ?? '',
        displayName:
          facets.codex?.displayName ?? facets.claude?.displayName ?? undefined,
        description:
          facets.claude?.description ?? facets.codex?.description ?? '',
        version: facets.claude?.version ?? facets.codex?.version ?? '',
        author: facets.claude?.author ?? facets.codex?.author ?? '',
        category: facets.claude?.category ?? facets.codex?.category ?? '',
        homepage: facets.claude?.homepage ?? facets.codex?.homepage ?? '',
        logoUrl: facets.codex?.logoUrl ?? facets.claude?.logoUrl,
        sourcePath: canonical?.sourcePath ?? '',
        marketplaceId: input.marketplaceId,
        details: facets.claude?.details ?? facets.codex?.details,
        externalSource:
          facets.claude?.externalSource ?? facets.codex?.externalSource,
        cachePath: facets.claude?.cachePath ?? facets.codex?.cachePath,
        cachedAt: facets.claude?.cachedAt ?? facets.codex?.cachedAt,
        providerSupport: {
          claude: facets.claude ? 'native' : 'none',
          codex: codexSupport,
        },
        facets: {
          claude: facets.claude,
          codex: facets.codex,
        },
      };
      return plugin;
    })
    .filter((plugin) => plugin.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function assembleMarketplace(input: {
  id: string;
  sourceUrl: string;
  sourceType?: string;
  knownEntry: KnownMarketplaceEntry | null;
  codexMarketplaceName?: string;
  codexInstalledRoot?: string;
  codexListedMarketplace?: PluginMarketplaceEntry;
  codexAddResult?: CodexMarketplaceOperationResult;
  claudeResult?: ClaudeMarketplaceOperationResult;
}): Promise<MarketplaceInfo> {
  const claude = scanClaudeMarketplace({
    id: input.id,
    entry: input.knownEntry,
  });
  const codex = await scanCodexMarketplace({
    marketplaceName:
      input.codexAddResult?.marketplaceName ?? input.codexMarketplaceName,
    installedRoot:
      input.codexAddResult?.installedRoot ?? input.codexInstalledRoot,
    listedMarketplace: input.codexListedMarketplace,
    addResult: input.codexAddResult,
  });
  if (input.claudeResult && !input.claudeResult.accepted) {
    claude.status = providerStatus('claude', {
      ...claude.status,
      accepted: false,
      pluginCount: 0,
      error: input.claudeResult.error ?? claude.status.error,
    });
    claude.facets = [];
  }
  const plugins = mergeProviderPluginFacets({
    marketplaceId: input.id,
    claudePlugins: claude.facets,
    codexPlugins: codex.facets,
  });
  const validProviders: PluginProvider[] = [
    ...(claude.status.state === 'valid' ? (['claude'] as const) : []),
    ...(codex.status.state === 'valid' ? (['codex'] as const) : []),
  ];
  const installLocation =
    claude.installLocation ??
    codex.installLocation ??
    input.codexInstalledRoot ??
    input.knownEntry?.installLocation ??
    '';
  return {
    id: input.id,
    name: claude.name ?? codex.name ?? input.id,
    description: claude.description ?? codex.description ?? '',
    sourceType:
      input.sourceType ??
      knownMarketplaceSourceType(input.knownEntry) ??
      'github',
    sourceUrl: claude.sourceUrl
      ? claude.sourceUrl
      : marketplaceInfoSourceUrl(input.sourceUrl, input.sourceType),
    installLocation,
    lastUpdated: claude.lastUpdated ?? nowIso(),
    pluginCount: plugins.length,
    plugins,
    providerStatus: {
      claude: claude.status,
      codex: codex.status,
    },
    validProviders,
  };
}

async function recheckMarketplaceProviders(
  input: {
    id: string;
    sourceUrl: string;
    sourceType?: string;
    knownId?: string;
    knownEntry: KnownMarketplaceEntry | null;
    existing?: MarketplaceInfo | null;
    codexMarketplaceName?: string;
    codexInstalledRoot?: string;
    codexScanOnly?: boolean;
  },
  options?: { providerUpdates?: boolean },
): Promise<{
  claude: ClaudeMarketplaceOperationResult;
  codex: CodexMarketplaceOperationResult;
}> {
  // When provider updates are skipped (fresh startup discovery), already
  // registered providers are treated as satisfied without shelling out to
  // the claude/codex CLIs. Unregistered providers are still added so newly
  // supported discovery paths (e.g. a marketplace gaining Codex support)
  // are picked up.
  const providerUpdates = options?.providerUpdates !== false;
  const claudeRegistered = !!input.knownEntry || !!input.knownId;
  const claudeName =
    input.knownId ??
    input.existing?.providerStatus.claude.marketplaceName ??
    input.id;
  const codexName =
    input.existing?.providerStatus.codex.marketplaceName ??
    input.existing?.name ??
    input.codexMarketplaceName ??
    input.id;
  const codexRegistered =
    input.existing?.providerStatus.codex.accepted === true ||
    !!input.existing?.providerStatus.codex.marketplaceName ||
    !!input.codexMarketplaceName;
  const codexUpgradeable = isGitBackedCodexMarketplaceSource({
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
  });
  const codexScanOnly =
    !claudeRegistered &&
    (input.codexScanOnly === true || input.sourceType === 'codex');
  const structurallyInvalidAtRevision =
    input.existing?.providerStatus.codex.structurallyInvalidAtRevision;
  const claudePromise = claudeRegistered
    ? providerUpdates
      ? updateClaudeMarketplace(claudeName)
      : Promise.resolve({ accepted: true })
    : codexScanOnly
      ? Promise.resolve({
          accepted: false,
          error: 'Marketplace is available only through Codex.',
        })
      : addClaudeMarketplace(input.sourceUrl);
  let currentRevision: string | null = null;
  if (structurallyInvalidAtRevision) {
    const codexInstallMetadata =
      await readCodexMarketplaceInstallMetadata(codexName);
    currentRevision = codexInstallMetadata?.revision ?? null;
    if (currentRevision === null && providerUpdates) {
      if (claudeRegistered) {
        // Once Codex has been deregistered its checkout may no longer exist. A
        // successfully updated Claude checkout for the same registered source
        // is then local evidence that the source revision moved. Never use a
        // stale or failed Claude update to override authoritative Codex
        // metadata and accidentally re-register the unchanged invalid revision.
        const claude = await claudePromise;
        if (claude.accepted) {
          const sourceInstallRoot =
            input.knownEntry?.installLocation ??
            input.existing?.installLocation;
          currentRevision = sourceInstallRoot
            ? await getHeadCommitSha(sourceInstallRoot)
            : null;
        }
      } else if (codexScanOnly && codexUpgradeable) {
        // A Codex-only marketplace has no Claude checkout to update, and Codex
        // removes its own metadata when a structurally invalid registration is
        // removed. Resolve the Git remote's HEAD during a provider update so a
        // later revision can automatically escape structural suppression.
        //
        // LIMITATION: this resolves the DEFAULT BRANCH tip. Codex's
        // `.codex-marketplace-install.json` also carries a `ref_name`, and for
        // a source pinned to a non-default ref that tip can never equal the
        // stamped revision - so such a marketplace would pay one
        // `addCodexMarketplace` clone per TTL cycle instead of converging on
        // the skip branch. We cannot detect it here: reaching this line means
        // the install metadata (and with it `ref_name`) is already gone.
        // Closing it properly means persisting `ref_name` alongside
        // `structurallyInvalidAtRevision` and resolving
        // `ls-remote <remote> <ref>`. Deliberately deferred - every Codex
        // marketplace observed in practice reports `ref_name: null`, and the
        // cost is bounded at one clone per 24h rather than the ~50/hour loop
        // this change exists to stop.
        currentRevision = await getRemoteHeadCommitSha(input.sourceUrl);
      }
    }
  }
  const skipStructurallyInvalidCodexRevision =
    !!structurallyInvalidAtRevision &&
    (currentRevision === null ||
      currentRevision === structurallyInvalidAtRevision);
  const retryStructurallyInvalidCodexRevision =
    !!structurallyInvalidAtRevision &&
    currentRevision !== null &&
    currentRevision !== structurallyInvalidAtRevision;
  const alreadySatisfiedCodexResult: CodexMarketplaceOperationResult = {
    accepted: true,
    marketplaceName: codexName,
    installedRoot:
      input.codexInstalledRoot ??
      input.existing?.providerStatus.codex.installLocation,
    alreadySatisfied: true,
  };
  const structurallyInvalidCodexResult: CodexMarketplaceOperationResult = {
    accepted: false,
    marketplaceName: codexName,
    installedRoot:
      input.codexInstalledRoot ??
      input.existing?.providerStatus.codex.installLocation,
    alreadySatisfied: true,
    error: input.existing?.providerStatus.codex.error,
    structurallyInvalidAtRevision,
  };

  const [claude, codexResult] = await settleAll([
    claudePromise,
    // Codex-discovered built-in catalogs are registered and scan-only, but
    // `marketplace/upgrade` accepts Git-configured marketplaces. Keep
    // Git-backed Codex-only sources upgradeable while rescanning non-Git
    // registrations from current plugin/list evidence.
    skipStructurallyInvalidCodexRevision
      ? Promise.resolve(structurallyInvalidCodexResult)
      : retryStructurallyInvalidCodexRevision
        ? addCodexMarketplace(input.sourceUrl)
        : codexRegistered
          ? providerUpdates && codexUpgradeable
            ? upgradeCodexMarketplace(codexName)
            : Promise.resolve(alreadySatisfiedCodexResult)
          : codexScanOnly
            ? Promise.resolve(alreadySatisfiedCodexResult)
            : addCodexMarketplace(input.sourceUrl),
  ]);
  const codex = retryStructurallyInvalidCodexRevision
    ? {
        ...codexResult,
        structuralRevisionFallback: structurallyInvalidAtRevision,
        structuralFailureRevision: currentRevision ?? undefined,
        ...(!codexResult.accepted &&
        !isStructuralCodexMarketplaceFailure(codexResult.error)
          ? { structurallyInvalidAtRevision }
          : {}),
      }
    : codexResult;
  return { claude, codex };
}

async function buildMarketplaces(
  progress?: MarketplaceProgressReporter,
  options?: { providerUpdates?: boolean },
): Promise<MarketplaceInfo[]> {
  const known = readKnownMarketplaces();
  const cache = readCache();
  const sources = new Map<string, MarketplaceRefreshSource>();
  const sourceKeyToSourceId = new Map<string, string>();

  const upsertSource = (source: MarketplaceRefreshSource): void => {
    const sourceKey = marketplaceSourceKey(source);
    const existingId = sourceKeyToSourceId.get(sourceKey);
    const canMatchCodexMarketplaceName =
      !!source.codexMarketplaceName &&
      !(
        source.codexScanOnly === true &&
        parseGitHubSource(source.codexMarketplaceName)
      );
    const marketplaceNameMatch = canMatchCodexMarketplaceName
      ? Array.from(sources.entries()).find(
          ([, entry]) =>
            entry.codexMarketplaceName === source.codexMarketplaceName ||
            entry.id === source.codexMarketplaceName ||
            entry.knownId === source.codexMarketplaceName,
        )
      : undefined;
    const targetId = existingId ?? marketplaceNameMatch?.[0] ?? source.id;
    const existing = sources.get(targetId);
    sources.set(targetId, mergeMarketplaceRefreshSource(existing, source));
    sourceKeyToSourceId.set(sourceKey, targetId);
    if (targetId !== source.id) {
      sources.delete(source.id);
    }
  };

  // Claude keys `known_marketplaces.json` by the registered marketplace NAME
  // (see `known[marketplaceName]` in `ensureClaudeLocalManagedMarketplaceRegistered`),
  // so once Canopy registers the built-in or curated marketplace with Claude,
  // its own entry shows up here too. Skip it: the managed row for it is
  // assembled separately by `mergeManagedMarketplaces`, and without this
  // guard the same on-disk marketplace would also surface as a second,
  // user-removable external row keyed by that name. Name alone is not
  // enough to skip, though — marketplace names are author-controlled, so a
  // user-added external marketplace could legitimately reuse a managed name
  // while pointing somewhere else entirely; only skip when the entry's
  // location also actually resolves to the managed root.
  const managedMarketplaceRootsByName = new Map<string, string>(
    managedMarketplaceTargets().map((target) => [
      target.marketplaceName,
      target.root,
    ]),
  );
  for (const [id, entry] of Object.entries(known)) {
    const managedRoot = managedMarketplaceRootsByName.get(id);
    if (
      managedRoot !== undefined &&
      isKnownMarketplaceEntryManagedRoot(id, managedRoot, entry)
    ) {
      continue;
    }
    upsertSource({
      id,
      sourceUrl: knownMarketplaceSourceUrl(entry),
      knownEntry: entry,
      knownId: id,
      sourceType: knownMarketplaceSourceType(entry),
    });
  }

  for (const marketplace of cache?.version === 2 ? cache.marketplaces : []) {
    const id = marketplace.id;
    if (
      id === BUILTIN_PLUGIN_MARKETPLACE_ID ||
      isCuratedPluginMarketplaceId(id) ||
      isLegacyCodexChatPluginMarketplace(marketplace)
    ) {
      continue;
    }
    const sourceUrl = marketplace.sourceUrl || id;
    const knownMatch = findKnownMarketplaceBySource(known, sourceUrl);
    upsertSource({
      id,
      sourceUrl,
      knownEntry: knownMatch?.entry ?? null,
      knownId: knownMatch?.id,
      codexMarketplaceName: marketplace.providerStatus?.codex?.marketplaceName,
      codexInstalledRoot: marketplace.providerStatus?.codex?.installLocation,
      codexScanOnly: isPersistedCodexScanOnlyMarketplace(marketplace)
        ? true
        : undefined,
      sourceType: marketplace.sourceType,
    });
  }

  for (const marketplace of cache?.version === 1 ? cache.marketplaces : []) {
    const id = marketplace.id;
    if (
      id === BUILTIN_PLUGIN_MARKETPLACE_ID ||
      isCuratedPluginMarketplaceId(id) ||
      isLegacyCodexChatPluginMarketplace(marketplace)
    ) {
      continue;
    }
    const sourceUrl = marketplace.sourceUrl || id;
    const knownMatch = findKnownMarketplaceBySource(known, sourceUrl);
    upsertSource({
      id,
      sourceUrl,
      knownEntry: knownMatch?.entry ?? null,
      knownId: knownMatch?.id,
      v1SourceType: marketplace.sourceType,
      v1InstallLocation: marketplace.installLocation,
      v1LastUpdated: marketplace.lastUpdated,
    });
  }

  // Provider state this refresh read anyway; a provider that could not be
  // read contributes no observations, so its receipts are left for later.
  const receiptObservations = claudeManagedMarketplaceObservations(known);
  try {
    const codexList = await listCodexPlugins();
    receiptObservations.push(
      ...codexManagedMarketplaceObservations(codexList.marketplaces),
    );
    for (const entry of codexList.marketplaces) {
      if (entry.name === LEGACY_CODEX_CHAT_PLUGIN_MARKETPLACE_NAME) {
        continue;
      }
      const discovered = codexDiscoveredMarketplaceSource(entry);
      const managedRoot = managedMarketplaceRootsByName.get(
        discovered.marketplaceName,
      );
      if (
        managedRoot !== undefined &&
        isManagedProviderMarketplaceSource(
          'codex',
          discovered.marketplaceName,
          managedRoot,
          discovered.installedRoot,
        )
      ) {
        continue;
      }
      upsertSource({
        id: discovered.id,
        sourceUrl: discovered.sourceUrl,
        knownEntry: null,
        codexMarketplaceName: discovered.marketplaceName,
        codexInstalledRoot: discovered.installedRoot,
        codexScanOnly: discovered.scanOnly,
        codexListedMarketplace: discovered.listedMarketplace,
        sourceType: discovered.sourceType,
      });
    }
  } catch {
    // Known marketplace scans surface Codex errors separately. Direct-only
    // Codex marketplaces cannot be seeded if Codex cannot list them.
  }
  logFailedReceiptWrite(
    reconcileManagedMarketplaceReceipts(receiptObservations),
    'managed marketplace receipts',
  );

  const marketplaces = await mapWithConcurrency(
    Array.from(sources.values()),
    MARKETPLACE_REFRESH_CONCURRENCY,
    async (source, sourceIndex) => {
      const index = sourceIndex + 1;
      reportMarketplaceProgress(progress, 'refresh', {
        status: 'running',
        currentStep: index,
        totalSteps: Math.max(sources.size, 1),
        marketplaceId: source.id,
        repo: source.sourceUrl,
        message: `Checking ${source.id} with Claude and Codex...`,
      });
      const existing =
        cache?.version === 2
          ? (cache.marketplaces.find(
              (marketplace) => marketplace.id === source.id,
            ) ?? null)
          : null;
      const recheck = await recheckMarketplaceProviders(
        {
          id: source.id,
          sourceUrl: source.sourceUrl,
          sourceType: source.sourceType,
          knownId: source.knownId,
          knownEntry: source.knownEntry,
          existing,
          codexMarketplaceName: source.codexMarketplaceName,
          codexInstalledRoot: source.codexInstalledRoot,
          codexScanOnly: source.codexScanOnly,
        },
        options,
      );
      const refreshedKnown = readKnownMarketplaces();
      const refreshedKnownMatch =
        source.codexScanOnly === true || source.sourceType === 'codex'
          ? null
          : findKnownMarketplaceBySource(refreshedKnown, source.sourceUrl);
      const fallbackKnownEntry =
        source.v1InstallLocation && source.v1LastUpdated
          ? {
              source: {
                source: source.v1SourceType ?? 'github',
                repo: source.sourceUrl,
              },
              installLocation: source.v1InstallLocation,
              lastUpdated: source.v1LastUpdated,
            }
          : null;
      return assembleMarketplace({
        ...source,
        knownEntry:
          refreshedKnownMatch?.entry ?? source.knownEntry ?? fallbackKnownEntry,
        sourceType: source.sourceType,
        codexListedMarketplace: source.codexListedMarketplace,
        claudeResult: recheck.claude,
        codexAddResult: recheck.codex,
      });
    },
  );
  return mergeManagedMarketplaces(marketplaces);
}

export async function loadMarketplaces(
  progress?: MarketplaceProgressReporter,
): Promise<IPCResult<PluginsCache>> {
  try {
    const result = await loadMarketplacesWithoutDefaults(progress);
    if (result.success && result.data) {
      await initializeCuratedPluginDefaults(result.data.marketplaces);
      assertCatalogHealth();
    }
    return result;
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

/** Preserve legacy selections on migration, then apply newly seen curated defaults once. */
async function initializeCuratedPluginDefaults(
  marketplaces: MarketplaceInfo[],
): Promise<void> {
  try {
    await persistCuratedPluginDefaults(marketplaces);
  } catch (error) {
    // Catalog discovery remains usable when this optional defaults write fails;
    // leave its marker unset so a subsequent load can retry.
    process.stderr.write(
      `[plugins] Failed to initialize curated defaults: ${errorMessage(error)}\n`,
    );
  }
}

async function persistCuratedPluginDefaults(
  marketplaces: MarketplaceInfo[],
): Promise<void> {
  const names = marketplaces
    .filter((marketplace) => isCuratedPluginMarketplaceId(marketplace.id))
    .flatMap((marketplace) => marketplace.plugins.map((plugin) => plugin.name));
  if (names.length === 0) return;
  const current = await readPreferencesFile();
  assertCatalogHealth();
  if (peekPreferencesLoadError()) return;
  const initialized = new Set(current.initializedCuratedPluginDefaults ?? []);
  if (names.every((name) => initialized.has(name))) return;

  let changed = false;
  const preferences = await updatePreferencesFile((latest) => {
    assertCatalogHealth();
    const seen = new Set(latest.initializedCuratedPluginDefaults ?? []);
    const additions = names.filter((name) => !seen.has(name));
    if (additions.length === 0) return {};
    // A missing marker identifies legacy preferences. Record today's catalog
    // without guessing whether an absent selection was an explicit opt-out.
    if (latest.initializedCuratedPluginDefaults === undefined) {
      return { initializedCuratedPluginDefaults: Array.from(new Set(names)) };
    }
    changed = true;
    return {
      initializedCuratedPluginDefaults: Array.from(
        new Set([...Array.from(seen), ...additions]),
      ),
      globalPluginSelections: unionPluginSelections(
        latest.globalPluginSelections ?? {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: additions.map((pluginName) => ({
            marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
            pluginName,
          })),
        },
      ),
    };
  });
  if (changed) {
    // session-manager imports plugin resolution, which imports this service.
    // Load it only after initialization to avoid that module cycle.
    const { bumpGlobalPluginDefaultsRevision } =
      await import('../agents/session-manager');
    bumpGlobalPluginDefaultsRevision();
    broadcastPreferencesSynced(preferences, projectPreferencesForRuntime);
  }
}

async function loadMarketplacesWithoutDefaults(
  progress?: MarketplaceProgressReporter,
): Promise<IPCResult<PluginsCache>> {
  try {
    assertCatalogHealth();
    const cache = readCache();
    if (cache?.version === 2 && cache.lastRefreshed !== '') {
      const filteredCachedMarketplaces = cache.marketplaces.filter(
        (marketplace) => !isLegacyCodexChatPluginMarketplace(marketplace),
      );
      if (isE2eBuild()) {
        return await applyCodexCompatDisabledOverlay({
          success: true,
          data: { ...cache, marketplaces: filteredCachedMarketplaces },
        });
      }
      const marketplaces = await mergeManagedMarketplaces(
        filteredCachedMarketplaces,
      );
      const nextCache: PluginsCache = {
        version: 2,
        lastRefreshed: cache.lastRefreshed,
        marketplaces,
      };
      return await applyCodexCompatDisabledOverlay({
        success: true,
        data: nextCache,
      });
    }
    if (cache?.version === 1) {
      return { success: false, error: catalogReadError('legacy').message };
    }
    reportMarketplaceProgress(progress, 'load', {
      status: 'running',
      currentStep: 1,
      totalSteps: 1,
      message: 'Preparing marketplace cache...',
    });
    return await refreshMarketplaces(progress, { providerUpdates: 'always' });
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

/** Display projection only: never use this result to plan effects or execution. */
export async function loadMarketplacesForPresentation(
  progress?: MarketplaceProgressReporter,
  cacheOnly = false,
): Promise<IPCResult<PluginsCache>> {
  const health = readPluginCatalogHealth();
  const index = readPluginIndexHealth();
  if (
    (health.state === 'valid' || health.state === 'absent') &&
    (index.state === 'valid' || index.state === 'absent')
  ) {
    return cacheOnly ? loadMarketplacesCacheOnly() : loadMarketplaces(progress);
  }
  const fallback = readPluginCatalogHealth();
  return {
    success: true,
    data:
      fallback.state === 'legacy'
        ? migrateLegacyCacheForFastLoad(fallback.data)
        : fallback.state === 'valid'
          ? fallback.data
          : { version: 2, lastRefreshed: '', marketplaces: [] },
  };
}

export async function loadMarketplacesCacheOnly(): Promise<
  IPCResult<PluginsCache>
> {
  try {
    assertCatalogHealth();
    const cache = readCache();
    if (cache?.version === 2) {
      return await applyCodexCompatDisabledOverlay({
        success: true,
        data: {
          ...cache,
          marketplaces: cache.marketplaces.filter(
            (marketplace) => !isLegacyCodexChatPluginMarketplace(marketplace),
          ),
        },
      });
    }
    if (cache?.version === 1) {
      return { success: false, error: catalogReadError('legacy').message };
    }
    return {
      success: true,
      data: {
        version: 2,
        lastRefreshed: '',
        marketplaces: [],
      },
    };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

/** Refresh installed metadata after a serialized lifecycle operation, without provider updates or curated seeding. */
export async function refreshInstalledPluginCatalog(
  marketplaceId: string,
): Promise<void> {
  const cached = readCache();
  if (cached?.version !== 2 || !cached.lastRefreshed) return;
  invalidateManagedMarketplaceScanCache(marketplaceId);
  const refreshed = await loadMarketplacesWithoutDefaults();
  if (!refreshed.success || !refreshed.data)
    throw new Error('Installed plugin catalog could not be refreshed.');
  const marketplace = refreshed.data.marketplaces.find(
    (row) => row.id === marketplaceId,
  );
  if (!marketplace) return;
  await withCacheLock(() => {
    const latest = readCache();
    if (latest?.version !== 2) return;
    writeCache({
      ...latest,
      marketplaces: latest.marketplaces.map((row) =>
        row.id === marketplaceId ? marketplace : row,
      ),
    });
  });
}

export interface RefreshMarketplacesOptions {
  /**
   * `'always'` runs the per-marketplace provider update commands.
   * `'if-stale'` (default) runs them only when the last full provider refresh is older
   * than {@link MARKETPLACE_PROVIDER_REFRESH_TTL_MS}; otherwise the refresh
   * still performs discovery (rescanning registrations and registering
   * providers for marketplaces that gained support) without shelling out to
   * `claude plugin marketplace update` / Codex upgrades for marketplaces
   * that are already registered.
   */
  providerUpdates?: 'always' | 'if-stale';
}

function shouldRunProviderUpdates(
  options: RefreshMarketplacesOptions | undefined,
): boolean {
  if ((options?.providerUpdates ?? 'if-stale') === 'always') {
    return true;
  }
  const cache = readCache();
  const lastProviderRefreshAt =
    cache?.version === 2 ? cache.lastProviderRefreshAt : undefined;
  const lastAt = lastProviderRefreshAt
    ? Date.parse(lastProviderRefreshAt)
    : Number.NaN;
  return (
    !Number.isFinite(lastAt) ||
    Date.now() - lastAt > MARKETPLACE_PROVIDER_REFRESH_TTL_MS
  );
}

/**
 * Best-effort provider nudge for one locally managed marketplace (the
 * bundled built-in tree or the curated tree). Claude is nudged only while its
 * registration under that name points at the managed root, so a nudge never
 * registers anything and never updates a same-named foreign marketplace.
 * Failures are logged and ignored: the on-disk tree is already the source of
 * truth, and the next install re-registers anyway.
 *
 * There is no `win32` suppression here on purpose: `refreshMarketplaces`
 * already shells out to the provider CLIs on every platform. Windows keeps
 * these refreshes user-initiated at the scheduling layer instead
 * (`scheduleDeferredStartupBackgroundTasks`).
 */
async function nudgeManagedProviderMarketplace(
  marketplaceName: string,
  label: string,
): Promise<void> {
  const managedRoot = managedMarketplaceTargets().find(
    (target) => target.marketplaceName === marketplaceName,
  )?.root;
  if (
    managedRoot !== undefined &&
    claudeRegisteredMarketplaceRoot(
      readKnownMarketplaces(),
      marketplaceName,
    ) === managedRoot
  ) {
    const updated = await updateClaudeMarketplace(marketplaceName);
    if (!updated.accepted) {
      process.stderr.write(
        `[plugins] Failed to refresh the ${label} Claude marketplace: ${
          updated.error ?? 'unknown error'
        }\n`,
      );
    }
  }
  // Managed Codex marketplaces are registered from absolute local roots, not
  // Git repositories. The provider scan that follows this nudge observes their
  // current contents; asking Codex to upgrade them would reject valid catalogs.
}

/**
 * Periodic provider nudge for BOTH managed marketplaces, run on the same
 * stale gate as the external-source provider updates.
 *
 * Managed marketplaces are deliberately excluded from the
 * `known_marketplaces.json` source loop (see `buildMarketplaces`), so without
 * this they would never receive a periodic
 * `claude plugin marketplace update` at all. Managed Codex marketplaces are
 * scan-only because their local roots are not Git repositories. Neither path
 * is reachable through `updateMarketplace`, so there is no manual heal either.
 * Best-effort and non-fatal: a refresh must still succeed when a provider CLI
 * is unhappy.
 */
async function nudgeManagedProviderMarketplaces(options: {
  /** True when the curated sync already nudged it earlier in this refresh. */
  skipCurated: boolean;
}): Promise<void> {
  const targets: Array<{ name: string; label: string }> = [
    { name: getBuiltInProviderMarketplaceName(), label: 'built-in' },
    ...(options.skipCurated
      ? []
      : [{ name: getCuratedPluginMarketplaceName(), label: 'curated' }]),
  ];
  for (const target of targets) {
    try {
      await nudgeManagedProviderMarketplace(target.name, target.label);
    } catch (error) {
      process.stderr.write(
        `[plugins] Failed to refresh the ${target.label} marketplace: ${errorMessage(
          error,
        )}\n`,
      );
    }
  }
}

/**
 * Runs the curated catalog sync and the full post-sync reaction. Never
 * throws: a sync failure must not fail the caller that triggered it. On a
 * committed sync the curated scan memo is dropped so the CALLER observes the
 * fresh tree, and the providers that registered the curated marketplace are
 * nudged.
 *
 * Both the user-triggered marketplace refresh and the background curated
 * refresh scheduler (`mcp/refresh-scheduler.ts`, which dynamically imports
 * this function) go through here, so a scheduler-committed sync reacts
 * identically to a refresh-committed one.
 *
 * Returns the sync result, or `null` when the sync threw and was logged.
 */
export async function syncCuratedPluginsForRefresh(options?: {
  force?: boolean;
  /**
   * Onboarding only needs the post-sync cache write before it can navigate.
   * Its provider CLI nudge remains best-effort, but must not hold the wizard
   * behind the CLI timeout. Full marketplace refreshes keep awaiting it.
   */
  providerNudge?: 'await' | 'background';
}): Promise<CuratedPluginSyncResult | null> {
  try {
    return await withMarketplaceRefreshLock(() =>
      syncCuratedPluginsForRefreshUnlocked(options, {
        lockBackgroundNudge: true,
      }),
    );
  } catch (error) {
    process.stderr.write(
      `[plugins] Curated plugin sync failed: ${errorMessage(error)}\n`,
    );
    return null;
  }
}

async function syncCuratedPluginsForRefreshUnlocked(
  options?: {
    force?: boolean;
    providerNudge?: 'await' | 'background';
  },
  behavior?: { lockBackgroundNudge?: boolean },
): Promise<CuratedPluginSyncResult | null> {
  try {
    assertCatalogHealth();
    const result = await syncCuratedPlugins(options);
    assertCatalogHealth();
    if (result.status === 'synced') invalidateCuratedMarketplaceScanCache();
    // A no-op sync can be an existing user's first run with curated defaults.
    if (result.status !== 'skipped') {
      const marketplace = await scanCuratedMarketplace(
        curatedMarketplaceScanDeps,
      );
      if (marketplace) await initializeCuratedPluginDefaults([marketplace]);
    }
    if (result.status !== 'synced') return result;
    await persistCuratedMarketplaceAfterSync();
    const nudgeProvider = (): Promise<void> =>
      nudgeManagedProviderMarketplace(
        getCuratedPluginMarketplaceName(),
        'curated',
      );
    if (options?.providerNudge === 'background') {
      const providerNudge = behavior?.lockBackgroundNudge
        ? withMarketplaceRefreshLock(nudgeProvider)
        : nudgeProvider();
      trackDetachedWork(() =>
        providerNudge.catch((error) => {
          process.stderr.write(
            `[plugins] Failed to refresh the curated marketplace: ${errorMessage(
              error,
            )}\n`,
          );
        }),
      );
    } else {
      await nudgeProvider();
    }
    return result;
  } catch (error) {
    process.stderr.write(
      `[plugins] Curated plugin sync failed: ${errorMessage(error)}\n`,
    );
    return null;
  }
}

export async function refreshMarketplaces(
  progress?: MarketplaceProgressReporter,
  options?: RefreshMarketplacesOptions,
): Promise<IPCResult<PluginsCache>> {
  try {
    assertCatalogHealth({ allowLegacy: true });
    return await withMarketplaceRefreshLock(() =>
      providerRevalidation.run(true, () =>
        refreshMarketplacesUnlocked(progress, options),
      ),
    );
  } catch (error) {
    reportMarketplaceProgress(progress, 'refresh', {
      status: 'error',
      message: errorMessage(error),
    });
    return { success: false, error: errorMessage(error) };
  }
}

async function refreshMarketplacesUnlocked(
  progress?: MarketplaceProgressReporter,
  options?: RefreshMarketplacesOptions,
): Promise<IPCResult<PluginsCache>> {
  try {
    reportMarketplaceProgress(progress, 'refresh', {
      status: 'running',
      currentStep: 1,
      totalSteps: 1,
      message: 'Checking installed marketplaces...',
    });
    assertCatalogHealth({ allowLegacy: true });
    const providerUpdates = shouldRunProviderUpdates(options);
    const curatedSync = await syncCuratedPluginsForRefreshUnlocked();
    if (providerUpdates) {
      // Nudge before the scan, mirroring the source loop's update-then-scan
      // ordering in `recheckMarketplaceProviders`.
      await nudgeManagedProviderMarketplaces({
        skipCurated: curatedSync?.status === 'synced',
      });
    }
    const marketplaces = await buildMarketplaces(progress, {
      providerUpdates,
    });
    const result = await withCacheLock<IPCResult<PluginsCache>>(() => {
      const previousCache = readCache();
      const externalMarketplaces = marketplaces.filter(
        (marketplace) =>
          marketplace.id !== BUILTIN_PLUGIN_MARKETPLACE_ID &&
          !isCuratedPluginMarketplaceId(marketplace.id),
      );
      if (
        previousCache?.version === 1 &&
        previousCache.marketplaces.some(
          (marketplace) =>
            marketplace.id !== BUILTIN_PLUGIN_MARKETPLACE_ID &&
            !isCuratedPluginMarketplaceId(marketplace.id) &&
            !isLegacyCodexChatPluginMarketplace(marketplace),
        ) &&
        externalMarketplaces.length > 0 &&
        externalMarketplaces.every(
          (marketplace) => marketplace.validProviders.length === 0,
        )
      ) {
        return {
          success: false,
          error:
            'Unable to migrate the version 1 plugin cache because provider revalidation failed for every marketplace.',
        };
      }
      const mergedMarketplaces = mergePreservedCacheState(
        marketplaces,
        previousCache,
      );
      const cache: PluginsCache = {
        version: 2,
        lastRefreshed: nowIso(),
        ...(providerUpdates ? { lastProviderRefreshAt: nowIso() } : {}),
        marketplaces: mergedMarketplaces,
      };
      writeCache(cache, true);
      return { success: true, data: cache };
    });
    if (!result.success) {
      return result;
    }
    reportMarketplaceProgress(progress, 'refresh', {
      status: 'complete',
      currentStep: 1,
      totalSteps: 1,
      message: 'Marketplace refresh complete.',
    });
    return await applyCodexCompatDisabledOverlay(result);
  } catch (error) {
    reportMarketplaceProgress(progress, 'refresh', {
      status: 'error',
      message: errorMessage(error),
    });
    return { success: false, error: errorMessage(error) };
  }
}

async function addClaudeMarketplace(
  repo: string,
): Promise<{ accepted: boolean; error?: string }> {
  try {
    await execPluginCli(
      getBundledClaudeBinaryPath(),
      ['plugin', 'marketplace', 'add', repo],
      getEnhancedEnv({ environment: { runtime: 'canopy' } }),
    );
    return { accepted: true };
  } catch (error) {
    const message = errorMessage(error);
    if (/already (added|exists|installed|registered)/i.test(message)) {
      return { accepted: true, error: message };
    }
    return { accepted: false, error: message };
  }
}

async function updateClaudeMarketplace(
  name: string,
): Promise<{ accepted: boolean; error?: string }> {
  try {
    await execPluginCli(
      getBundledClaudeBinaryPath(),
      ['plugin', 'marketplace', 'update', name],
      getEnhancedEnv({ environment: { runtime: 'canopy' } }),
    );
    return { accepted: true };
  } catch (error) {
    return { accepted: false, error: errorMessage(error) };
  }
}

async function removeClaudeMarketplace(
  name: string,
): Promise<{ removed: boolean; alreadyAbsent: boolean; error?: string }> {
  try {
    await execPluginCli(
      getBundledClaudeBinaryPath(),
      ['plugin', 'marketplace', 'remove', name],
      getEnhancedEnv({ environment: { runtime: 'canopy' } }),
    );
    return { removed: true, alreadyAbsent: false };
  } catch (error) {
    const message = errorMessage(error);
    if (/not found|not installed|unknown marketplace/i.test(message)) {
      return { removed: false, alreadyAbsent: true };
    }
    return { removed: false, alreadyAbsent: false, error: message };
  }
}

export async function addMarketplace(
  ...args: Parameters<typeof addMarketplaceUnlocked>
): ReturnType<typeof addMarketplaceUnlocked> {
  try {
    assertCatalogHealth();
    const result = await addMarketplaceUnlocked(...args);
    assertCatalogHealth();
    return result;
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

async function addMarketplaceUnlocked(
  repo: string,
  progress?: MarketplaceProgressReporter,
): Promise<IPCResult<MarketplaceRegistrationResult>> {
  const id = normalizeMarketplaceId(repo);
  const sourceUrl = normalizeMarketplaceSourceUrl(repo);
  reportMarketplaceProgress(progress, 'add', {
    status: 'running',
    currentStep: 1,
    totalSteps: 3,
    marketplaceId: id,
    repo: sourceUrl,
    message: 'Registering marketplace with Claude and Codex...',
  });
  const [claudeAdd, codexAdd] = await settleAll([
    addClaudeMarketplace(repo),
    addCodexMarketplace(repo),
  ]);

  reportMarketplaceProgress(progress, 'add', {
    status: 'running',
    currentStep: 2,
    totalSteps: 3,
    marketplaceId: id,
    repo: sourceUrl,
    message: 'Scanning detected plugins...',
  });
  const known = readKnownMarketplaces();
  const knownMatch = findKnownMarketplaceBySource(known, sourceUrl);
  const marketplace = await assembleMarketplace({
    id: knownMatch?.id ?? id,
    sourceUrl,
    knownEntry: knownMatch?.entry ?? null,
    claudeResult: claudeAdd,
    codexAddResult: codexAdd,
  });

  if (marketplace.validProviders.length === 0) {
    reportMarketplaceProgress(progress, 'add', {
      status: 'error',
      currentStep: 2,
      totalSteps: 3,
      marketplaceId: id,
      repo: sourceUrl,
      message: 'No Claude or Codex plugins were detected.',
    });
    return {
      success: false,
      error: `No Claude or Codex plugins were detected in that repository. Claude: ${providerSummary(
        marketplace.providerStatus.claude,
      )}. Codex: ${providerSummary(marketplace.providerStatus.codex)}.`,
    };
  }

  reportMarketplaceProgress(progress, 'add', {
    status: 'running',
    currentStep: 3,
    totalSteps: 3,
    marketplaceId: marketplace.id,
    repo: sourceUrl,
    message: 'Saving marketplace...',
  });
  await withCacheLock(() => {
    const cache = readCache();
    const marketplaces =
      cache?.version === 2
        ? cache.marketplaces.filter((entry) => entry.id !== marketplace.id)
        : [];
    marketplaces.push(marketplace);
    const nextCache: PluginsCache = {
      version: 2,
      lastRefreshed: nowIso(),
      marketplaces,
    };
    writeCache(nextCache);
  });
  reportMarketplaceProgress(progress, 'add', {
    status: 'complete',
    currentStep: 3,
    totalSteps: 3,
    marketplaceId: marketplace.id,
    repo: sourceUrl,
    message: 'Marketplace added.',
  });
  return {
    success: true,
    data: {
      marketplace,
      providerOutcomes: marketplace.providerStatus,
    },
  };
}

async function updateMarketplaceUnlocked(
  id: string,
  progress?: MarketplaceProgressReporter,
): Promise<IPCResult<MarketplaceInfo>> {
  try {
    assertCatalogHealth();
    if (isCuratedPluginMarketplaceId(id)) {
      return {
        success: false,
        error: `The curated marketplace is managed by ${BRAND.displayName} and updates automatically.`,
      };
    }
    if (id === BUILTIN_PLUGIN_MARKETPLACE_ID) {
      const marketplace = await scanBuiltInMarketplace();
      if (!marketplace) {
        return {
          success: false,
          error: 'Built-in marketplace resources were not found.',
        };
      }
      await withCacheLock(() => {
        const latestCache = readCache();
        const marketplaces =
          latestCache?.version === 2
            ? latestCache.marketplaces.filter((entry) => entry.id !== id)
            : [];
        marketplaces.push(marketplace);
        writeCache({
          version: 2,
          lastRefreshed: nowIso(),
          marketplaces,
        });
      });
      return { success: true, data: marketplace };
    }
    reportMarketplaceProgress(progress, 'update', {
      status: 'running',
      currentStep: 1,
      totalSteps: 3,
      marketplaceId: id,
      message: 'Checking marketplace providers...',
    });
    const cache = readCache();
    const existing =
      cache?.version === 2
        ? (cache.marketplaces.find((marketplace) => marketplace.id === id) ??
          null)
        : null;
    const known = readKnownMarketplaces();
    const knownMatch =
      (existing
        ? findKnownMarketplaceBySource(known, existing.sourceUrl)
        : null) ?? (known[id] ? { id, entry: known[id] } : null);
    const sourceUrl =
      existing?.sourceUrl || knownMarketplaceSourceUrl(knownMatch?.entry) || id;
    const claudeRegistered = !!knownMatch;
    // A structurally invalid Codex facet was deregistered from Codex when the
    // stamp was written, so the persisted `marketplaceName` no longer implies a
    // live registration. `updateMarketplace` is the explicit user retry the
    // Plugins page points at, so its Codex leg must re-add the source instead
    // of issuing `marketplace/upgrade` (or a scan-only no-op) against a name
    // Codex no longer knows. Only the Codex leg changes; Claude registration
    // and the persisted scan-only classification are untouched.
    const codexStructurallyDeregistered =
      !!existing?.providerStatus.codex.structurallyInvalidAtRevision;
    const codexRegistered =
      existing?.providerStatus.codex.accepted === true ||
      !!existing?.providerStatus.codex.marketplaceName;
    const codexName =
      existing?.providerStatus.codex.marketplaceName ?? existing?.name ?? id;
    const codexUpgradeable = isGitBackedCodexMarketplaceSource({
      sourceType: existing?.sourceType,
      sourceUrl,
    });
    const codexScanOnly = existing
      ? isPersistedCodexScanOnlyMarketplace(existing)
      : false;
    const alreadySatisfiedCodexResult: CodexMarketplaceOperationResult = {
      accepted: true,
      marketplaceName: codexName,
      installedRoot: existing?.providerStatus.codex.installLocation,
      alreadySatisfied: true,
    };

    reportMarketplaceProgress(progress, 'update', {
      status: 'running',
      currentStep: 2,
      totalSteps: 3,
      marketplaceId: id,
      repo: sourceUrl,
      message: 'Refreshing Claude and Codex registrations...',
    });
    const [claudeUpdate, codexUpdate] = await settleAll([
      claudeRegistered
        ? updateClaudeMarketplace(
            knownMatch?.id ??
              existing?.providerStatus.claude.marketplaceName ??
              id,
          )
        : codexScanOnly
          ? Promise.resolve({
              accepted: false,
              error: 'Marketplace is available only through Codex.',
            })
          : addClaudeMarketplace(sourceUrl),
      // Registered built-in/local catalogs are rescanned without issuing a
      // Git-only upgrade request. Git-backed Codex-only marketplaces retain
      // their named upgrade before the live plugin/list rescan below.
      codexStructurallyDeregistered
        ? addCodexMarketplace(sourceUrl)
        : codexRegistered
          ? codexUpgradeable
            ? upgradeCodexMarketplace(codexName)
            : Promise.resolve(alreadySatisfiedCodexResult)
          : codexScanOnly
            ? Promise.resolve(alreadySatisfiedCodexResult)
            : addCodexMarketplace(sourceUrl),
    ]);
    const refreshedKnown = readKnownMarketplaces();
    const refreshedKnownMatch = findKnownMarketplaceBySource(
      refreshedKnown,
      sourceUrl,
    );

    // Resolve the revision this retry actually tested, the same way
    // `recheckMarketplaceProviders` does. Without it, a retry that fails
    // structurally at a NEW revision re-stamps the OLD one (Codex install
    // metadata is gone after deregistration, so `scanCodexMarketplace` can
    // resolve nothing and falls back), and the next automatic recheck sees a
    // changed revision and pays another add/clone cycle before converging -
    // exactly the clone this change exists to eliminate.
    const codexRetryTestedRevision = codexStructurallyDeregistered
      ? ((await readCodexMarketplaceInstallMetadata(codexName))?.revision ??
        (codexUpdate.installedRoot
          ? await getHeadCommitSha(codexUpdate.installedRoot)
          : null) ??
        (knownMatch?.entry?.installLocation
          ? await getHeadCommitSha(knownMatch.entry.installLocation)
          : null) ??
        (codexUpgradeable ? await getRemoteHeadCommitSha(sourceUrl) : null))
      : null;

    const codexUpdateWithStructuralState = codexStructurallyDeregistered
      ? {
          ...codexUpdate,
          structuralRevisionFallback:
            existing?.providerStatus.codex.structurallyInvalidAtRevision,
          ...(codexRetryTestedRevision
            ? { structuralFailureRevision: codexRetryTestedRevision }
            : {}),
          ...(!codexUpdate.accepted &&
          !isStructuralCodexMarketplaceFailure(codexUpdate.error)
            ? {
                structurallyInvalidAtRevision:
                  existing?.providerStatus.codex.structurallyInvalidAtRevision,
              }
            : {}),
        }
      : codexUpdate;
    const marketplace = await assembleMarketplace({
      id,
      sourceUrl,
      sourceType: existing?.sourceType,
      knownEntry: refreshedKnownMatch?.entry ?? knownMatch?.entry ?? null,
      codexMarketplaceName:
        existing?.providerStatus.codex.marketplaceName ?? existing?.name,
      codexInstalledRoot: existing?.providerStatus.codex.installLocation,
      claudeResult: claudeUpdate,
      codexAddResult: codexUpdateWithStructuralState,
    });
    reportMarketplaceProgress(progress, 'update', {
      status: 'running',
      currentStep: 3,
      totalSteps: 3,
      marketplaceId: id,
      repo: sourceUrl,
      message: 'Saving refreshed marketplace...',
    });
    let savedMarketplace = marketplace;
    await withCacheLock(() => {
      const latestCache = readCache();
      const marketplaces =
        latestCache?.version === 2
          ? latestCache.marketplaces.filter((entry) => entry.id !== id)
          : [];
      savedMarketplace =
        mergePreservedCacheState([marketplace], latestCache)[0] ?? marketplace;
      marketplaces.push(savedMarketplace);
      writeCache({
        version: 2,
        lastRefreshed: nowIso(),
        marketplaces,
      });
    });
    reportMarketplaceProgress(progress, 'update', {
      status: 'complete',
      currentStep: 3,
      totalSteps: 3,
      marketplaceId: id,
      repo: sourceUrl,
      message: 'Marketplace refresh complete.',
    });
    return { success: true, data: savedMarketplace };
  } catch (error) {
    reportMarketplaceProgress(progress, 'update', {
      status: 'error',
      marketplaceId: id,
      message: errorMessage(error),
    });
    return { success: false, error: errorMessage(error) };
  }
}

export async function updateMarketplace(
  id: string,
  progress?: MarketplaceProgressReporter,
): Promise<IPCResult<MarketplaceInfo>> {
  try {
    const result = await withMarketplaceRefreshLock(() =>
      updateMarketplaceUnlocked(id, progress),
    );
    assertCatalogHealth();
    return result;
  } catch (error) {
    reportMarketplaceProgress(progress, 'update', {
      status: 'error',
      marketplaceId: id,
      message: errorMessage(error),
    });
    return { success: false, error: errorMessage(error) };
  }
}

function recomputeMarketplaceFromFacets(
  marketplace: MarketplaceInfo,
  claudeFacets: PluginProviderFacet[],
  codexFacets: PluginProviderFacet[],
): MarketplaceInfo {
  const plugins = mergeProviderPluginFacets({
    marketplaceId: marketplace.id,
    claudePlugins: claudeFacets,
    codexPlugins: codexFacets,
  });
  const claudeStatus = providerStatus('claude', {
    ...marketplace.providerStatus.claude,
    accepted: claudeFacets.length > 0,
    pluginCount: claudeFacets.length,
    marketplacePath:
      claudeFacets.length > 0
        ? marketplace.providerStatus.claude.marketplacePath
        : undefined,
    installLocation:
      claudeFacets.length > 0
        ? marketplace.providerStatus.claude.installLocation
        : undefined,
    error:
      claudeFacets.length > 0
        ? undefined
        : marketplace.providerStatus.claude.error,
  });
  const codexStatus = providerStatus('codex', {
    ...marketplace.providerStatus.codex,
    accepted: codexFacets.length > 0,
    pluginCount: codexFacets.length,
    marketplacePath:
      codexFacets.length > 0
        ? marketplace.providerStatus.codex.marketplacePath
        : undefined,
    installLocation:
      codexFacets.length > 0
        ? marketplace.providerStatus.codex.installLocation
        : undefined,
    error:
      codexFacets.length > 0
        ? undefined
        : marketplace.providerStatus.codex.error,
  });
  const installLocation =
    claudeStatus.installLocation ??
    codexStatus.installLocation ??
    (plugins.length > 0 ? marketplace.installLocation : '');
  return {
    ...marketplace,
    installLocation,
    plugins,
    pluginCount: plugins.length,
    providerStatus: {
      claude: claudeStatus,
      codex: codexStatus,
    },
    validProviders: [
      ...(claudeStatus.state === 'valid' ? (['claude'] as const) : []),
      ...(codexStatus.state === 'valid' ? (['codex'] as const) : []),
    ],
  };
}

function legacyPluginToInfo(
  marketplace: MarketplaceInfoV1,
  plugin: PluginInfoV1,
): PluginInfo {
  const pluginRoot =
    plugin.cachePath ??
    (plugin.sourcePath
      ? path.resolve(marketplace.installLocation, plugin.sourcePath)
      : marketplace.installLocation);
  const externalSource = plugin.externalSource
    ? {
        source: 'github',
        url: plugin.externalSource.url,
        sha: plugin.externalSource.sha,
      }
    : undefined;
  const facet: PluginProviderFacet = {
    provider: 'claude',
    mode: 'native',
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    author: plugin.author,
    category: plugin.category,
    homepage: plugin.homepage,
    installLocation: pluginRoot,
    sourcePath: plugin.cachePath ? '' : plugin.sourcePath,
    marketplacePath: path.join(
      marketplace.installLocation,
      '.claude-plugin',
      'marketplace.json',
    ),
    externalSource,
    cachePath: plugin.cachePath ?? undefined,
    cachedAt: plugin.cachedAt ?? undefined,
    details: plugin.details,
  };
  return {
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    author: plugin.author,
    category: plugin.category,
    homepage: plugin.homepage,
    sourcePath: plugin.sourcePath,
    marketplaceId: plugin.marketplaceId,
    details: plugin.details,
    externalSource,
    cachePath: plugin.cachePath ?? undefined,
    cachedAt: plugin.cachedAt ?? undefined,
    providerSupport: {
      claude: 'native',
      codex: 'compat',
    },
    facets: {
      claude: facet,
    },
  };
}

function migrateLegacyCacheForFastLoad(cache: PluginsCacheV1): PluginsCache {
  return {
    version: 2,
    lastRefreshed: cache.lastRefreshed,
    marketplaces: cache.marketplaces.map((marketplace) => {
      const plugins = marketplace.plugins.map((plugin) =>
        legacyPluginToInfo(marketplace, plugin),
      );
      const claudeStatus = providerStatus('claude', {
        accepted: plugins.length > 0,
        pluginCount: plugins.length,
        lastCheckedAt: cache.lastRefreshed,
        marketplaceName: marketplace.name,
        marketplacePath: path.join(
          marketplace.installLocation,
          '.claude-plugin',
          'marketplace.json',
        ),
        installLocation: marketplace.installLocation,
        error:
          plugins.length > 0 ? undefined : 'No Claude plugins were detected.',
      });
      const codexStatus = providerStatus('codex', {
        accepted: false,
        pluginCount: 0,
        lastCheckedAt: cache.lastRefreshed,
        error:
          'Codex support has not been checked yet. Refresh the marketplace to check Codex.',
      });
      return {
        id: marketplace.id,
        name: marketplace.name,
        description: marketplace.description,
        sourceType: marketplace.sourceType,
        sourceUrl: marketplace.sourceUrl,
        installLocation: marketplace.installLocation,
        lastUpdated: marketplace.lastUpdated,
        pluginCount: plugins.length,
        plugins,
        providerStatus: {
          claude: claudeStatus,
          codex: codexStatus,
        },
        validProviders:
          claudeStatus.state === 'valid'
            ? (['claude'] as PluginProvider[])
            : [],
      };
    }),
  };
}

async function safeReadDir(target: string): Promise<fs.Dirent<string>[]> {
  try {
    return await fs.promises.readdir(target, {
      encoding: 'utf8',
      withFileTypes: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      process.stderr.write(
        `[plugins] safeReadDir(${target}) failed: ${errorMessage(error)}\n`,
      );
    }
    return [];
  }
}

async function addWorkspaceChatHistoryMetaTargets(
  targets: Set<SelectionPruneTarget>,
  workspaceId: string,
): Promise<void> {
  const chatHistoryEntries = await safeReadDir(
    getWorkspaceChatHistoryRootDir(workspaceId),
  );
  for (const entry of chatHistoryEntries) {
    if (entry.isDirectory()) {
      targets.add(getWorkspaceChatHistoryMetaFilePath(workspaceId, entry.name));
    }
  }
}

interface CanonicalChatScopePruneTarget {
  root: string;
  projectId: string;
  worktreeId: string;
}

/** A legacy file path, or one workspace's `workspace.json` by its id. */
type SelectionPruneTarget = string | { readonly workspaceId: string };

interface SelectionPruneTargets {
  /** In discovery order; each workspace manifest routes through its id. */
  files: SelectionPruneTarget[];
  chatScopes: CanonicalChatScopePruneTarget[];
}

async function addWorkspaceSelectionPruneTargets(
  targets: Set<SelectionPruneTarget>,
  chatScopes: CanonicalChatScopePruneTarget[],
): Promise<void> {
  const workspacesRoot = path.join(getDataDir(), 'workspaces');
  const entries = await safeReadDir(workspacesRoot);
  await settleAll(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const workspaceId = entry.name;
        targets.add({ workspaceId });
        // Chat scopes that migrated to canonical v2 storage keep their tab
        // metadata in `chat-storage-v2/{scope}/live-index.json`; those are
        // pruned through the chat state service below. Any `chats/{scope}.json`
        // still beside a v2 manifest is a retained migration input and must
        // never be rewritten, so exclude it from the legacy file targets.
        const workspaceRoot = path.join(workspacesRoot, workspaceId);
        let scopeIds: string[] = [];
        try {
          scopeIds = await chatStorageScopeIds(workspaceRoot);
        } catch {
          // Unreadable manifests directory: fall back to legacy pruning only.
        }
        for (const scopeId of scopeIds) {
          chatScopes.push({
            root: workspaceRoot,
            projectId: workspaceId,
            worktreeId: scopeId,
          });
        }
        const migrated = new Set(scopeIds.map((scopeId) => `${scopeId}.json`));
        const chatsDir = path.join(workspaceRoot, 'chats');
        for (const chatEntry of await safeReadDir(chatsDir)) {
          if (
            chatEntry.isFile() &&
            chatEntry.name.endsWith('.json') &&
            !migrated.has(chatEntry.name)
          ) {
            targets.add(path.join(chatsDir, chatEntry.name));
          }
        }
        // Cowork workspaces (migrated standalone-chat projects) archive
        // chats under `chat-history/{chatId}/meta.json` — a subtree regular
        // git-backed workspaces don't have, so this is a harmless no-op for
        // them (`safeReadDir` on a missing dir returns []).
        await addWorkspaceChatHistoryMetaTargets(targets, workspaceId);
      }),
  );
}

async function discoverStandaloneProjectIds(): Promise<Set<string>> {
  const ids = new Set<string>([DEFAULT_CHAT_PROJECT_ID]);
  try {
    const raw = await fs.promises.readFile(getChatProjectsFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && Array.isArray(parsed.projects)) {
      for (const project of parsed.projects) {
        if (isRecord(project) && typeof project.id === 'string') {
          ids.add(project.id);
        }
      }
    }
  } catch {
    // Missing or invalid standalone project index is fine for best-effort cleanup.
  }

  const projectRootEntries = await safeReadDir(
    path.join(getDataDir(), 'standalone-chat', 'projects'),
  );
  for (const entry of projectRootEntries) {
    if (entry.isDirectory()) {
      ids.add(entry.name);
    }
  }
  return ids;
}

async function addStandaloneSelectionPruneTargets(
  targets: Set<SelectionPruneTarget>,
): Promise<void> {
  targets.add(getChatProjectsFilePath());
  const projectIds = await discoverStandaloneProjectIds();
  await settleAll(
    Array.from(projectIds).map(async (projectId) => {
      targets.add(getChatProjectProjectFilePath(projectId));
      targets.add(getChatProjectChatTabsFilePath(projectId));

      const historyEntries = await safeReadDir(
        getChatProjectHistoryDir(projectId),
      );
      for (const entry of historyEntries) {
        if (entry.isDirectory()) {
          targets.add(getChatProjectMetaFilePath(projectId, entry.name));
        }
      }
    }),
  );
}

async function collectSelectionPruneTargets(): Promise<SelectionPruneTargets> {
  // Callers prune preferences and pipeline preferences through their stores;
  // the generic file loops must never receive their paths (admitted writers,
  // CAN-5152 and CAN-4480).
  const targets = new Set<SelectionPruneTarget>();
  const chatScopes: CanonicalChatScopePruneTarget[] = [];
  await settleAll([
    addWorkspaceSelectionPruneTargets(targets, chatScopes),
    addStandaloneSelectionPruneTargets(targets),
  ]);
  return { files: Array.from(targets), chatScopes };
}

/**
 * Prune one workspace's `workspace.json` through the typed plugins boundary
 * (`core.workspace.plugins.update`, CAN-3817): inside the per-workspace write
 * queue, and never over a manifest it could not read. A fan-out request ID
 * keys it per workspace, so a retry replays its saved result (CAN-4717).
 */
async function pruneSelectionRefsInWorkspaceConfig(
  workspaceId: string,
  marketplaceId: string,
  fanOutRequestId: string | undefined,
): Promise<void> {
  try {
    await updateWorkspacePlugins({
      workspaceId,
      change: { kind: 'pruneMarketplace', marketplaceId },
      source: 'marketplace_removal',
      fanOutRequestId,
    });
  } catch {
    // Best-effort cleanup should not block or fail marketplace removal; a
    // folder without a readable manifest is refused and skipped.
  }
}

async function pruneSelectionRefsInFile(
  target: SelectionPruneTarget,
  marketplaceId: string,
  fanOutRequestId: string | undefined,
): Promise<void> {
  if (typeof target !== 'string') {
    await pruneSelectionRefsInWorkspaceConfig(
      target.workspaceId,
      marketplaceId,
      fanOutRequestId,
    );
    return;
  }
  const filePath = target;
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!pruneMarketplacePluginRefsFromValue(parsed, marketplaceId)) {
      return;
    }
    await fs.promises.writeFile(
      filePath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Best-effort cleanup should not block or fail marketplace removal.
  }
}

/**
 * Prune saved plugin selections from one canonical v2 chat scope. The
 * read-only discovery index decides whether the scope references the
 * marketplace at all, so untouched scopes are never admitted into the
 * repository; affected tabs are then rewritten through the metadata-only
 * compatibility mutation, which is the only sanctioned writer of
 * `live-index.json`.
 */
async function pruneSelectionRefsInChatScope(
  target: CanonicalChatScopePruneTarget,
  marketplaceId: string,
): Promise<void> {
  try {
    const index = await readChatStorageDiscoveryIndex(
      target.root,
      target.worktreeId,
    );
    const affectedChatIds: string[] = [];
    for (const tab of index.tabs) {
      if (
        typeof tab.id === 'string' &&
        pruneMarketplacePluginRefsFromValue(structuredClone(tab), marketplaceId)
      ) {
        affectedChatIds.push(tab.id);
      }
    }
    if (affectedChatIds.length === 0) {
      return;
    }
    // Lazy import breaks the plugin-service/chat-state projection cycle
    // (same pattern as chat-tabs-reader.ts).
    const { getChatStateService } =
      await import('../services/chat-state-service');
    const service = getChatStateService();
    const scope = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
    };
    for (const chatId of affectedChatIds) {
      await service.updateCompatibilityTab(
        scope,
        chatId,
        (current) => {
          const next = structuredClone(current);
          return pruneMarketplacePluginRefsFromValue(next, marketplaceId)
            ? next
            : null;
        },
        undefined,
        { metadataOnly: true },
      );
    }
  } catch {
    // Best-effort cleanup should not block or fail marketplace removal.
  }
}

async function pruneSelectionRefsForMarketplace(
  marketplaceId: string,
  fanOutRequestId: string | undefined,
): Promise<void> {
  const targets = await collectSelectionPruneTargets();
  try {
    await pruneMarketplaceRefsFromPreferences(marketplaceId);
  } catch {
    // Best-effort cleanup should not block or fail marketplace removal.
  }
  try {
    await prunePipelinePreferenceSelections(
      (entries) => pruneMarketplacePluginRefsFromValue(entries, marketplaceId),
      'electron_main',
    );
  } catch {
    // Best-effort cleanup should not block or fail marketplace removal.
  }
  for (const target of targets.files) {
    await pruneSelectionRefsInFile(target, marketplaceId, fanOutRequestId);
  }
  for (const scope of targets.chatScopes) {
    await pruneSelectionRefsInChatScope(scope, marketplaceId);
  }
}

/** Reuse selection discovery and canonical metadata writers for single-item removal. */
export async function pruneSelectionRefsForInstalledItem(
  ref: InstalledItemRef,
): Promise<void> {
  const targets = await collectSelectionPruneTargets();
  await prunePipelinePreferenceSelections(
    (entries) => pruneInstalledItemRefs(entries, ref),
    'electron_main',
  );
  for (const file of targets.files) {
    if (typeof file !== 'string') {
      await updateWorkspacePlugins({
        workspaceId: file.workspaceId,
        change: { kind: 'pruneInstalledItem', ref },
        source: 'marketplace_removal',
      });
      continue;
    }
    const raw = await fs.promises
      .readFile(file, 'utf8')
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      });
    if (raw === null) continue;
    const value: unknown = JSON.parse(raw);
    if (pruneInstalledItemRefs(value, ref))
      await fs.promises.writeFile(
        file,
        `${JSON.stringify(value, null, 2)}\n`,
        'utf8',
      );
  }
  const { getChatStateService } =
    await import('../services/chat-state-service');
  for (const scope of targets.chatScopes) {
    const index = await readChatStorageDiscoveryIndex(
      scope.root,
      scope.worktreeId,
    );
    for (const tab of index.tabs) {
      if (
        typeof tab.id !== 'string' ||
        !pruneInstalledItemRefs(structuredClone(tab), ref)
      )
        continue;
      await getChatStateService().updateCompatibilityTab(
        { projectId: scope.projectId, worktreeId: scope.worktreeId },
        tab.id,
        (current) => {
          const next = structuredClone(current);
          return pruneInstalledItemRefs(next, ref) ? next : null;
        },
        undefined,
        { metadataOnly: true },
      );
    }
  }
}

function scheduleSelectionRefsPruneForMarketplace(
  marketplaceId: string,
  fanOutRequestId: string | undefined,
): void {
  backgroundSelectionPruneQueue = backgroundSelectionPruneQueue
    .then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        }),
    )
    .then(() =>
      pruneSelectionRefsForMarketplace(marketplaceId, fanOutRequestId),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `[plugins] Failed to prune saved plugin selections for ${marketplaceId}: ${errorMessage(
          error,
        )}\n`,
      );
    });
}

export function flushMarketplaceSelectionPruneForTests(): Promise<void> {
  return backgroundSelectionPruneQueue;
}

export async function removeMarketplace(
  ...args: Parameters<typeof removeMarketplaceUnlocked>
): ReturnType<typeof removeMarketplaceUnlocked> {
  try {
    assertCatalogHealth();
    const result = await removeMarketplaceUnlocked(...args);
    assertCatalogHealth();
    return result;
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

async function removeMarketplaceUnlocked(
  id: string,
  options?: {
    providers?: PluginProvider[];
    /** Keys each workspace's prune; no adapter supplies one yet (CAN-4717). */
    fanOutRequestId?: string;
  },
  progress?: MarketplaceProgressReporter,
): Promise<IPCResult<MarketplaceRemovalResult>> {
  if (id === BUILTIN_PLUGIN_MARKETPLACE_ID) {
    return {
      success: false,
      error: `The built-in marketplace cannot be removed from ${BRAND.displayName}.`,
    };
  }
  if (isCuratedPluginMarketplaceId(id)) {
    return {
      success: false,
      error: `The curated marketplace is managed by ${BRAND.displayName} and cannot be removed.`,
    };
  }
  const cache = readCache();
  if (cache?.version !== 2) {
    return { success: false, error: 'Plugin cache is not initialized.' };
  }
  const marketplace = cache.marketplaces.find((entry) => entry.id === id);
  if (!marketplace) {
    return { success: false, error: `Marketplace "${id}" not found.` };
  }

  const requestedProviders =
    options?.providers && options.providers.length > 0
      ? options.providers
      : DEFAULT_MARKETPLACE_REMOVAL_PROVIDERS;
  const requested = new Set(requestedProviders);
  const outcomes: MarketplaceRemovalResult['providerOutcomes'] = {
    claude: { removed: false, alreadyAbsent: false },
    codex: { removed: false, alreadyAbsent: false },
  };

  reportMarketplaceProgress(progress, 'remove', {
    status: 'running',
    currentStep: 1,
    totalSteps: 2,
    marketplaceId: id,
    message: 'Removing marketplace from providers...',
  });
  if (requested.has('claude')) {
    outcomes.claude = await removeClaudeMarketplace(
      marketplace.providerStatus.claude.marketplaceName ?? marketplace.id,
    );
  }
  if (requested.has('codex')) {
    const result = await removeCodexMarketplace(
      marketplace.providerStatus.codex.marketplaceName ?? marketplace.name,
    );
    outcomes.codex = {
      removed: result.accepted && !result.alreadySatisfied,
      alreadyAbsent: result.alreadySatisfied === true,
      error: result.accepted ? undefined : result.error,
    };
  }

  const removedProviders = (['claude', 'codex'] as const).filter((provider) => {
    const outcome = outcomes[provider];
    return (
      requested.has(provider) && (outcome.removed || outcome.alreadyAbsent)
    );
  });
  const hasError = (['claude', 'codex'] as const).some(
    (provider) => requested.has(provider) && outcomes[provider].error,
  );

  reportMarketplaceProgress(progress, 'remove', {
    status: 'running',
    currentStep: 2,
    totalSteps: 2,
    marketplaceId: id,
    message: 'Updating marketplace cache...',
  });
  const cacheUpdate = await withCacheLock(() => {
    const latestCache = readCache();
    const latestMarketplace =
      latestCache?.version === 2
        ? (latestCache.marketplaces.find((entry) => entry.id === id) ??
          marketplace)
        : marketplace;
    let claudeFacets = latestMarketplace.plugins
      .map((plugin) => plugin.facets.claude)
      .filter((facet): facet is PluginProviderFacet => !!facet);
    let codexFacets = latestMarketplace.plugins
      .map((plugin) => plugin.facets.codex)
      .filter((facet): facet is PluginProviderFacet => !!facet);
    if (removedProviders.includes('claude')) {
      claudeFacets = [];
    }
    if (removedProviders.includes('codex')) {
      codexFacets = [];
    }

    const updated = recomputeMarketplaceFromFacets(
      latestMarketplace,
      claudeFacets,
      codexFacets,
    );
    for (const provider of ['claude', 'codex'] as const) {
      const error = outcomes[provider].error;
      if (requested.has(provider) && error) {
        updated.providerStatus[provider] = {
          ...updated.providerStatus[provider],
          error,
        };
      }
    }
    const deleteMarketplace =
      updated.validProviders.length === 0 &&
      !hasError &&
      Array.from(requested).every((provider) => {
        const outcome = outcomes[provider];
        return outcome.removed || outcome.alreadyAbsent;
      });

    const marketplaces =
      latestCache?.version === 2
        ? latestCache.marketplaces.filter((entry) => entry.id !== id)
        : [];
    if (!deleteMarketplace) {
      marketplaces.push(updated);
    }
    writeCache({
      version: 2,
      lastRefreshed: nowIso(),
      marketplaces,
    });
    return {
      shouldDelete: deleteMarketplace,
      marketplace: deleteMarketplace ? null : updated,
    };
  });
  const { shouldDelete } = cacheUpdate;
  if (shouldDelete) {
    scheduleSelectionRefsPruneForMarketplace(id, options?.fanOutRequestId);
  }

  reportMarketplaceProgress(progress, 'remove', {
    status: 'complete',
    currentStep: 2,
    totalSteps: 2,
    marketplaceId: id,
    message: shouldDelete
      ? 'Marketplace removed. Saved plugin selections will be cleaned up in the background.'
      : 'Marketplace updated.',
  });
  return {
    success: true,
    data: {
      marketplace: cacheUpdate.marketplace,
      removedProviders,
      providerOutcomes: outcomes,
    },
  };
}

export async function prepareCodexCompatibilityPlugin(
  marketplaceId: string,
  pluginName: string,
): Promise<IPCResult<PluginInfo>> {
  try {
    const result = await runSerializedPluginMutation(() =>
      prepareCodexCompatibilityPluginUnlocked(marketplaceId, pluginName),
    );
    assertCatalogHealth();
    return result;
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

async function prepareCodexCompatibilityPluginUnlocked(
  marketplaceId: string,
  pluginName: string,
): Promise<IPCResult<PluginInfo>> {
  try {
    assertCatalogHealth();
    return await withCacheLock(async () => {
      assertCatalogHealth();
      const cache = readCache();
      if (cache?.version !== 2) {
        return { success: false, error: 'Plugin cache is not initialized.' };
      }

      const marketplace = cache.marketplaces.find(
        (entry) => entry.id === marketplaceId,
      );
      const plugin = marketplace?.plugins.find(
        (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
      );
      if (!marketplace || !plugin) {
        return { success: false, error: 'Plugin not found.' };
      }
      if (plugin.facets.codex) {
        return { success: true, data: plugin };
      }
      const claudeFacet = plugin.facets.claude;
      if (!claudeFacet) {
        return {
          success: false,
          error: 'Codex compatibility requires a Claude plugin facet.',
        };
      }
      if (plugin.facets.codexCompatibility) {
        return { success: true, data: plugin };
      }

      const nativeProjectionRoot = await fs.promises.mkdtemp(
        path.join(getDataDir(), 'codex-capability-build-'),
      );
      let compatibility: MaterializedCodexPlugin | undefined;
      try {
        assertCatalogHealth();
        const materialized = await materializeCodexPluginsOffMain({
          nativeProjectionRoot,
          plugins: [
            {
              pluginName: claudeFacet.name,
              pluginPath: claudeFacet.cachePath ?? claudeFacet.installLocation,
              marketplaceId,
              category: claudeFacet.category ?? plugin.category ?? '',
              provider: 'claude',
              mode: 'compat',
              removeMcpServers: false,
              includeMcpServers: true,
              scanDetails: true,
            },
          ],
          skills: [],
        });
        compatibility = materialized.selectedPlugins[0];
        if (!compatibility) {
          return {
            success: false,
            error: 'Codex compatibility projection produced no plugin.',
          };
        }
      } finally {
        try {
          await fs.promises.rm(nativeProjectionRoot, {
            recursive: true,
            force: true,
          });
        } catch {
          // The compatibility cache is already materialized. Temporary
          // projection cleanup must not replace that successful result.
        }
      }
      const details = compatibility.details;
      if (!details) {
        return {
          success: false,
          error:
            'Codex compatibility projection did not return plugin details.',
        };
      }
      const facet: PluginProviderFacet = {
        provider: 'codex',
        mode: 'compat',
        name: compatibility.pluginName,
        description: claudeFacet.description,
        version: claudeFacet.version,
        author: claudeFacet.author,
        category: compatibility.category || claudeFacet.category,
        homepage: claudeFacet.homepage,
        installLocation: compatibility.cacheDir,
        sourcePath: '',
        marketplacePath: claudeFacet.marketplacePath,
        cachePath: compatibility.cacheDir,
        cachedAt: nowIso(),
        details,
      };

      const updatedPlugin: PluginInfo = {
        ...plugin,
        providerSupport: {
          ...plugin.providerSupport,
          codex: 'compat',
        },
        facets: {
          ...plugin.facets,
          codexCompatibility: facet,
        },
      };
      const updatedMarketplace: MarketplaceInfo = {
        ...marketplace,
        plugins: marketplace.plugins.map((entry) =>
          entry.name.toLowerCase() === pluginName.toLowerCase()
            ? updatedPlugin
            : entry,
        ),
      };
      writeCache({
        version: 2,
        lastRefreshed: nowIso(),
        marketplaces: cache.marketplaces.map((entry) =>
          entry.id === marketplaceId ? updatedMarketplace : entry,
        ),
      });
      return { success: true, data: updatedPlugin };
    });
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

function addFacetTrustedRoots(
  roots: Set<string>,
  marketplace: MarketplaceInfo,
  facet: PluginProviderFacet,
): void {
  if (facet.installLocation) {
    roots.add(path.resolve(facet.installLocation));
  }
  if (facet.cachePath) {
    roots.add(path.resolve(facet.cachePath));
  }
  if (!facet.sourcePath) {
    return;
  }
  if (path.isAbsolute(facet.sourcePath)) {
    roots.add(path.normalize(facet.sourcePath));
  } else if (facet.installLocation) {
    const resolved = path.resolve(facet.installLocation, facet.sourcePath);
    if (isPathInside(facet.installLocation, resolved)) {
      roots.add(resolved);
    }
  } else if (marketplace.installLocation) {
    const resolved = path.resolve(
      marketplace.installLocation,
      facet.sourcePath,
    );
    if (isPathInside(marketplace.installLocation, resolved)) {
      roots.add(resolved);
    }
  }
}

function collectTrustedRoots(cache: AnyPluginsCache | null): string[] {
  if (cache?.version !== 2) {
    return fs.existsSync(getBundledPluginsDir())
      ? [path.resolve(getBundledPluginsDir())]
      : [];
  }
  const roots = new Set<string>();
  if (fs.existsSync(getBundledPluginsDir())) {
    roots.add(path.resolve(getBundledPluginsDir()));
  }
  for (const marketplace of cache.marketplaces) {
    if (marketplace.installLocation && marketplace.validProviders.length > 0) {
      roots.add(path.resolve(marketplace.installLocation));
    }
    for (const status of [
      marketplace.providerStatus.claude,
      marketplace.providerStatus.codex,
    ]) {
      if (status.state === 'valid' && status.installLocation) {
        roots.add(path.resolve(status.installLocation));
      }
    }
    for (const plugin of marketplace.plugins) {
      for (const facet of [
        plugin.facets.claude,
        plugin.facets.codex,
        plugin.facets.codexCompatibility,
      ]) {
        if (!facet) {
          continue;
        }
        addFacetTrustedRoots(roots, marketplace, facet);
      }
    }
  }
  return Array.from(roots);
}

/**
 * Build the stable preference key for a plugin's Codex-compat opt-out. The
 * plugin-name portion is lowercased so it matches the case-insensitive plugin
 * lookup performed during resolution. This format MUST stay in sync between the
 * resolver, the read-path overlay, and the `setCodexCompatDisabled` writer.
 */
export function buildCodexCompatDisabledKey(
  marketplaceId: string,
  pluginName: string,
): string {
  return `${marketplaceId}/${pluginName.toLowerCase()}`;
}

/**
 * Overlay the derived `codexCompatDisabled` flag onto every plugin row in a
 * fresh copy of the cache. The persisted cache must never contain this flag, so
 * this always returns a new object graph and leaves the input untouched.
 */
function overlayCodexCompatDisabled(
  cache: PluginsCache,
  disabled: ReadonlySet<string>,
): PluginsCache {
  const marketplaces = cache.marketplaces.map((marketplace) => ({
    ...marketplace,
    plugins: marketplace.plugins.map((plugin) => ({
      ...plugin,
      codexCompatDisabled: disabled.has(
        buildCodexCompatDisabledKey(marketplace.id, plugin.name),
      ),
    })),
  }));
  return { ...cache, marketplaces };
}

/**
 * Apply the Codex-compat disabled overlay to a successful cache result before it
 * is served to the renderer. Failures and empty data pass through unchanged.
 */
async function applyCodexCompatDisabledOverlay(
  result: IPCResult<PluginsCache>,
): Promise<IPCResult<PluginsCache>> {
  if (!result.success || !result.data) {
    return result;
  }
  const preferences = await readPreferencesFile();
  assertCatalogHealth();
  const disabled = new Set<string>(
    preferences.codexCompatDisabledPlugins ?? [],
  );
  const data = result.data;
  const parked = new Set(
    (preferences.parkedCodexPlugins ?? []).flatMap((entry) => {
      const ref = parseInstalledItemKey(entry.key);
      return ref
        ? [installedItemKey(canonicalInstalledItemRef(ref, data.marketplaces))]
        : [];
    }),
  );
  const cache = overlayCodexCompatDisabled(result.data, disabled);
  return {
    success: true,
    data: {
      ...cache,
      marketplaces: cache.marketplaces.map((marketplace) => ({
        ...marketplace,
        plugins: marketplace.plugins.map((plugin) => ({
          ...plugin,
          parked:
            parked.has(
              installedItemKey({
                kind: 'plugin',
                marketplaceId: marketplace.id,
                pluginName: plugin.name,
              }),
            ) || undefined,
        })),
      })),
    },
  };
}

/**
 * Toggle the Claude→Codex compatibility opt-out for a single plugin. Adds or
 * removes the plugin's stable key in preferences and returns the plugin row with
 * the derived `codexCompatDisabled` flag set. The persisted cache is never
 * mutated.
 */
export async function setCodexCompatDisabled(
  marketplaceId: string,
  pluginName: string,
  disabled: boolean,
): Promise<IPCResult<PluginInfo>> {
  try {
    const marketplaceResult = await loadMarketplaces();
    if (!marketplaceResult.success || !marketplaceResult.data) {
      return {
        success: false,
        error: marketplaceResult.success
          ? 'Plugin cache is not initialized.'
          : marketplaceResult.error,
      };
    }
    const marketplace = marketplaceResult.data.marketplaces.find(
      (entry) => entry.id === marketplaceId,
    );
    const plugin = marketplace?.plugins.find(
      (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
    );
    if (!marketplace || !plugin) {
      return { success: false, error: 'Plugin not found.' };
    }

    const key = buildCodexCompatDisabledKey(marketplaceId, plugin.name);
    await updatePreferencesFile((latest) => {
      assertCatalogHealth();
      const current = new Set<string>(latest.codexCompatDisabledPlugins ?? []);
      if (disabled) {
        current.add(key);
      } else {
        current.delete(key);
      }
      return {
        codexCompatDisabledPlugins: Array.from(current),
      };
    });
    assertCatalogHealth();

    const updated: PluginInfo = { ...plugin, codexCompatDisabled: disabled };
    return { success: true, data: updated };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

export function readComponentContent(
  installLocation: string,
  pluginSourcePath: string,
  componentFile: string,
): IPCResult<PluginComponentContent> {
  try {
    if (typeof installLocation !== 'string' || !installLocation) {
      return { success: false, error: 'Missing install location.' };
    }
    if (typeof pluginSourcePath !== 'string') {
      return {
        success: false,
        error: 'Missing plugin source path. Try refreshing the marketplace.',
      };
    }
    if (typeof componentFile !== 'string' || !componentFile) {
      return { success: false, error: 'Missing component file path.' };
    }

    const cached = readCache();
    const knownRoots = collectTrustedRoots(cached);
    const cacheRoot = path.resolve(getPluginCacheDir());
    const resolvedLocation = path.resolve(installLocation);
    const isTrusted =
      knownRoots.some((root) => isPathInside(root, resolvedLocation)) ||
      isPathInside(cacheRoot, resolvedLocation);
    if (!isTrusted) {
      return { success: false, error: 'Invalid install location.' };
    }

    const pluginDir = path.isAbsolute(pluginSourcePath)
      ? path.resolve(pluginSourcePath)
      : path.resolve(installLocation, pluginSourcePath);
    if (
      !knownRoots.some((root) => isPathInside(root, pluginDir)) &&
      !isPathInside(installLocation, pluginDir)
    ) {
      return { success: false, error: 'Invalid plugin path.' };
    }

    const filePath = path.resolve(pluginDir, componentFile);
    if (!isPathInside(pluginDir, filePath)) {
      return { success: false, error: 'Invalid component path.' };
    }
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'Component file not found.' };
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    return { success: true, data: parseFrontmatterAndBody(raw) };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

function findBuiltInPlugin(
  marketplace: MarketplaceInfo | null,
  pluginName: string,
): PluginInfo | null {
  return (
    marketplace?.plugins.find(
      (plugin) => plugin.name.toLowerCase() === pluginName.toLowerCase(),
    ) ?? null
  );
}

async function evaluateClaudeBuiltInMarketplaceConflict(
  marketplaceName: string,
  bundledRoot: string,
  existing: KnownMarketplaceEntry,
): Promise<{ accepted: boolean; removed?: boolean; error?: string }> {
  const existingLocation = normalizeLocalMarketplaceRoot(
    existing.installLocation ?? '',
  );
  if (!existingLocation) {
    return {
      accepted: false,
      error: `Claude marketplace "${marketplaceName}" already exists without a valid local source. Remove it from Claude or choose another marketplace name.`,
    };
  }

  if (existingLocation === bundledRoot) {
    recordManagedMarketplaceRegistration(
      'claude',
      marketplaceName,
      bundledRoot,
    );
    return { accepted: true };
  }

  if (fs.existsSync(existingLocation)) {
    return {
      accepted: false,
      error: `Claude marketplace "${marketplaceName}" already exists with a different source. Remove it from Claude or choose another marketplace name.`,
    };
  }

  if (
    !hasManagedMarketplaceReceipt({
      provider: 'claude',
      marketplaceName,
      sourceRoot: existingLocation,
    })
  ) {
    return {
      accepted: false,
      error: `Claude marketplace "${marketplaceName}" already exists with a missing different source that ${BRAND.displayName} did not previously register. Remove it from Claude or choose another marketplace name.`,
    };
  }

  const removed = await removeClaudeMarketplace(marketplaceName);
  if (removed.error) {
    return { accepted: false, error: removed.error };
  }
  return { accepted: false, removed: true };
}

/**
 * Registers a locally managed marketplace (built-in or curated) with Claude.
 * `marketplaceName`/`root` identify which one; everything else — conflict
 * evaluation, receipt recording, and the one repair retry — is shared.
 */
async function ensureClaudeLocalManagedMarketplaceRegistered(
  target: { marketplaceName: string; root: string },
  attempt = 0,
): Promise<{
  accepted: boolean;
  error?: string;
}> {
  const { marketplaceName, root: sourceRoot } = target;
  const known = readKnownMarketplaces();
  const existing = known[marketplaceName];
  if (existing) {
    const evaluated = await evaluateClaudeBuiltInMarketplaceConflict(
      marketplaceName,
      sourceRoot,
      existing,
    );
    if (evaluated.accepted) {
      return { accepted: true };
    }
    if (!evaluated.removed) {
      return { accepted: false, error: evaluated.error };
    }
  }

  try {
    await execPluginCli(
      getBundledClaudeBinaryPath(),
      ['plugin', 'marketplace', 'add', sourceRoot, '--scope', 'user'],
      getEnhancedEnv(),
    );
    recordManagedMarketplaceRegistration('claude', marketplaceName, sourceRoot);
    return { accepted: true };
  } catch (error) {
    const message = errorMessage(error);
    if (isAlreadyRegisteredMessage(message)) {
      const refreshedExisting = readKnownMarketplaces()[marketplaceName];
      if (!refreshedExisting) {
        return {
          accepted: false,
          error: `Claude marketplace "${marketplaceName}" is already registered, but ${BRAND.displayName} could not verify that it points at the managed marketplace. Remove it from Claude or choose another marketplace name.`,
        };
      }
      const evaluated = await evaluateClaudeBuiltInMarketplaceConflict(
        marketplaceName,
        sourceRoot,
        refreshedExisting,
      );
      if (evaluated.accepted) {
        return { accepted: true };
      }
      if (evaluated.removed) {
        if (attempt >= 1) {
          return {
            accepted: false,
            error: `The "${marketplaceName}" marketplace could not be re-registered after repair.`,
          };
        }
        return ensureClaudeLocalManagedMarketplaceRegistered(
          target,
          attempt + 1,
        );
      }
      return { accepted: false, error: evaluated.error ?? message };
    }
    return { accepted: false, error: message };
  }
}

async function installClaudeLocalManagedPlugin(input: {
  pluginName: string;
  marketplaceName: string;
  root: string;
}): Promise<{ installed: boolean; error?: string }> {
  const { pluginName, marketplaceName } = input;
  const registered = await ensureClaudeLocalManagedMarketplaceRegistered({
    marketplaceName,
    root: input.root,
  });
  if (!registered.accepted) {
    return { installed: false, error: registered.error };
  }
  try {
    await execPluginCli(
      getBundledClaudeBinaryPath(),
      [
        'plugin',
        'install',
        `${pluginName}@${marketplaceName}`,
        '--scope',
        'user',
      ],
      getEnhancedEnv(),
    );
    return { installed: true };
  } catch (error) {
    const message = errorMessage(error);
    if (isAlreadyRegisteredMessage(message)) {
      const status = readClaudeBuiltInPluginInstallStatus(
        pluginName,
        undefined,
        marketplaceName,
      );
      if (status.installed) {
        return { installed: true };
      }
      return {
        installed: false,
        error:
          status.error ??
          `Claude reported that "${pluginName}" is already installed, but ${BRAND.displayName} could not verify the installed plugin.`,
      };
    }
    return { installed: false, error: message };
  }
}

async function installCodexLocalManagedPlugin(input: {
  pluginName: string;
  marketplaceName: string;
  root: string;
}): Promise<{ installed: boolean; error?: string }> {
  const { pluginName, marketplaceName, root: sourceRoot } = input;
  const added = await addCodexMarketplace(sourceRoot, {
    repairEquivalentSourceConflict: true,
    repairMissingLocalSourceConflict: (conflict) =>
      conflict.marketplaceName === marketplaceName &&
      hasManagedMarketplaceReceipt({
        provider: 'codex',
        marketplaceName,
        sourceRoot: conflict.existingSource,
      }),
  });
  if (!added.accepted) {
    return {
      installed: false,
      error:
        added.error ??
        `Codex marketplace "${marketplaceName}" could not be registered.`,
    };
  }
  recordManagedMarketplaceRegistration(
    'codex',
    added.marketplaceName ?? marketplaceName,
    sourceRoot,
  );
  try {
    // Address the marketplace we just registered by its manifest on disk.
    // `remoteMarketplaceName` is NOT an alternative spelling of the same
    // thing: it names a marketplace served by the remote plugin catalog, so
    // setting it made the app-server resolve the plugin against
    // `chatgpt.com/backend-api/ps/plugins/<name>` and fail with a 404 for
    // every locally managed plugin, curated and built-in alike.
    await installCodexPlugin({
      remoteMarketplaceName: null,
      marketplacePath: codexMarketplaceManifestPath(sourceRoot),
      pluginName,
    });
    return { installed: true };
  } catch (error) {
    const message = errorMessage(error);
    if (isAlreadyRegisteredMessage(message)) {
      const status = await readCodexBuiltInPluginInstallStatus(
        pluginName,
        undefined,
        undefined,
        marketplaceName,
      );
      if (status.installed) {
        return { installed: true };
      }
      return {
        installed: false,
        error:
          status.error ??
          `Codex reported that "${pluginName}" is already installed, but ${BRAND.displayName} could not verify the installed plugin.`,
      };
    }
    return { installed: false, error: message };
  }
}

async function installBuiltInPluginUnlocked(
  request: InstallBuiltInPluginRequest,
  progress?: MarketplaceProgressReporter,
): Promise<IPCResult<InstallBuiltInPluginResult>> {
  const marketplaceId =
    isRecord(request) && typeof request.marketplaceId === 'string'
      ? request.marketplaceId
      : undefined;
  try {
    assertCatalogHealth();
    if (
      !isRecord(request) ||
      typeof request.marketplaceId !== 'string' ||
      typeof request.pluginName !== 'string' ||
      !Array.isArray(request.providers)
    ) {
      return {
        success: false,
        error: 'Invalid built-in plugin install request.',
      };
    }
    const pluginName = request.pluginName;
    const target = marketplaceId
      ? resolveManagedMarketplaceTarget(marketplaceId)
      : null;
    if (!marketplaceId || !target) {
      return {
        success: false,
        error:
          'Built-in plugin installs require the built-in or curated marketplace.',
      };
    }
    const providerValues = Array.from(new Set(request.providers));
    if (providerValues.length === 0) {
      return { success: false, error: 'At least one provider is required.' };
    }
    if (!providerValues.every(isPluginProvider)) {
      return { success: false, error: 'Unknown plugin provider requested.' };
    }
    const providers: PluginProvider[] = providerValues;

    reportMarketplaceProgress(progress, 'install-built-in-plugin', {
      status: 'running',
      currentStep: 1,
      totalSteps: 3,
      marketplaceId,
      message: 'Scanning marketplace...',
    });
    const marketplace = await scanManagedMarketplace(marketplaceId);
    const plugin = findBuiltInPlugin(marketplace, pluginName);
    if (!marketplace || !plugin) {
      return { success: false, error: 'Plugin not found in the marketplace.' };
    }

    const providerOutcomes: InstallBuiltInPluginResult['providerOutcomes'] = {};
    reportMarketplaceProgress(progress, 'install-built-in-plugin', {
      status: 'running',
      currentStep: 2,
      totalSteps: 3,
      marketplaceId,
      message: 'Installing the plugin in selected providers...',
    });
    if (providers.includes('claude')) {
      providerOutcomes.claude = plugin.facets.claude
        ? await installClaudeLocalManagedPlugin({
            pluginName: plugin.facets.claude.name,
            ...target,
          })
        : { installed: false, error: 'Claude facet is unavailable.' };
    }
    if (providers.includes('codex')) {
      providerOutcomes.codex = plugin.facets.codex
        ? await installCodexLocalManagedPlugin({
            pluginName: plugin.facets.codex.name,
            ...target,
          })
        : { installed: false, error: 'Codex facet is unavailable.' };
    }

    const successes = Object.values(providerOutcomes).filter(
      (outcome) => outcome?.installed,
    );
    // The install just changed provider state the scan memo cannot know about,
    // so re-read it rather than serving the pre-install snapshot back.
    invalidateManagedMarketplaceScanCache(marketplaceId);
    const refreshed = await scanManagedMarketplace(marketplaceId);
    assertCatalogHealth();
    const refreshedPlugin = findBuiltInPlugin(refreshed, pluginName) ?? plugin;
    if (refreshed) {
      await withCacheLock(() => {
        const latestCache = readCache();
        const marketplaces =
          latestCache?.version === 2
            ? latestCache.marketplaces.filter(
                (entry) => entry.id !== marketplaceId,
              )
            : [];
        marketplaces.push(refreshed);
        writeCache({
          version: 2,
          lastRefreshed: nowIso(),
          marketplaces,
        });
      });
    }

    if (successes.length === 0) {
      const error = Object.entries(providerOutcomes)
        .map(
          ([provider, outcome]) => `${provider}: ${outcome?.error ?? 'failed'}`,
        )
        .join('; ');
      return {
        success: false,
        error,
        data: { plugin: refreshedPlugin, providerOutcomes },
      };
    }

    reportMarketplaceProgress(progress, 'install-built-in-plugin', {
      status: 'complete',
      currentStep: 3,
      totalSteps: 3,
      marketplaceId,
      message: 'Plugin install complete.',
    });
    return {
      success: true,
      data: { plugin: refreshedPlugin, providerOutcomes },
    };
  } catch (error) {
    // Provider state may have changed before the throw; the next load rescans.
    if (marketplaceId) invalidateManagedMarketplaceScanCache(marketplaceId);
    reportMarketplaceProgress(progress, 'install-built-in-plugin', {
      status: 'error',
      ...(marketplaceId ? { marketplaceId } : {}),
      message: errorMessage(error),
    });
    return { success: false, error: errorMessage(error) };
  }
}

/**
 * Keep a failed provider install on the cached plugin's install status, so the
 * detail page can show it beside the Install button that retries it. A plugin
 * the cache does not carry, or one without install status, writes nothing.
 */
export async function recordBuiltInPluginInstallError(
  target: { marketplaceId: string; pluginName: string },
  provider: PluginProvider,
  error: string,
): Promise<void> {
  await withCacheLock(() => {
    const cache = readCache();
    if (cache?.version !== 2) return;
    let changed = false;
    const marketplaces = cache.marketplaces.map((marketplace) => {
      if (marketplace.id !== target.marketplaceId) return marketplace;
      return {
        ...marketplace,
        plugins: marketplace.plugins.map((plugin) => {
          const current = plugin.globalInstallStatus?.[provider];
          if (
            plugin.name !== target.pluginName ||
            !plugin.globalInstallStatus ||
            !current
          )
            return plugin;
          changed = true;
          return {
            ...plugin,
            globalInstallStatus: {
              ...plugin.globalInstallStatus,
              [provider]: { ...current, installError: error },
            },
          };
        }),
      };
    });
    if (changed) writeCache({ ...cache, marketplaces });
  });
  // A load served from the scan memo would carry the pre-record snapshot and
  // could write it back over the recorded error; the next load scans anew.
  invalidateManagedMarketplaceScanCache(target.marketplaceId);
}

async function installPluginUnlocked(
  marketplaceId: string,
  pluginName: string,
  sourceUrl: string,
  options?: {
    /**
     * Refuse HTTP redirects during the clone (SSRF defense for the portal
     * external-install path, where `sourceUrl` came from an untrusted
     * marketplace manifest). Default follows redirects for trusted callers.
     */
    disableRedirects?: boolean;
    /**
     * Skip the trailing detached `refreshMarketplaces()`. The portal path sets
     * this and drives the refresh itself INSIDE its serialization slot so the
     * next queued mutation cannot overlap the refresh (see
     * `installPortalExternalPlugin`). Default fires the refresh as before.
     */
    skipRefresh?: boolean;
  },
): Promise<IPCResult<PluginInfo>> {
  try {
    assertCatalogHealth();
    if (!marketplaceId || !pluginName || !sourceUrl) {
      return { success: false, error: 'Missing required parameters.' };
    }

    const randomId = crypto.randomBytes(4).toString('hex');
    const safeName = pluginName.replace(/[^a-zA-Z0-9_-]/g, '-');
    const cacheDir = path.join(getPluginCacheDir(), `${safeName}-${randomId}`);
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    await cloneRepo(sourceUrl, cacheDir, {
      followRedirects: options?.disableRedirects !== true,
    });

    assertCatalogHealth();
    const pluginManifest = safeReadJson<PluginManifest>(
      path.join(cacheDir, '.claude-plugin', 'plugin.json'),
    );
    const details = scanPluginDetails(cacheDir, pluginManifest);
    const cachedAt = nowIso();

    const index = readCacheIndex();
    const key = cacheKey(marketplaceId, pluginName);
    const prev = index.entries[key];
    index.entries[key] = {
      cachePath: cacheDir,
      sourceUrl,
      cachedAt,
    };

    const facet: PluginProviderFacet = {
      provider: 'claude',
      mode: 'native',
      name: manifestText(pluginManifest?.name) || pluginName,
      description: manifestText(pluginManifest?.description) || '',
      version: manifestText(pluginManifest?.version) || '',
      author: manifestAuthor(pluginManifest?.author) || '',
      category: '',
      homepage: manifestText(pluginManifest?.homepage) || '',
      installLocation: cacheDir,
      sourcePath: cacheDir,
      externalSource: { source: 'github', url: sourceUrl },
      cachePath: cacheDir,
      cachedAt,
      details,
    };
    const cache = readCache();
    const currentPlugin =
      cache?.version === 2
        ? cache.marketplaces
            .find((entry) => entry.id === marketplaceId)
            ?.plugins.find(
              (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
            )
        : undefined;
    const existingCodexFacet = currentPlugin?.facets.codex;
    const pluginInfo = mergeProviderPluginFacets({
      marketplaceId,
      claudePlugins: [facet],
      codexPlugins: existingCodexFacet ? [existingCodexFacet] : [],
    })[0];

    // Persist the install into the cache synchronously so a reload (e.g. after
    // navigating away from and back to the plugins page) reflects it
    // immediately. The background refresh below re-hydrates external installs
    // from the cache index, so it stays consistent with this write.
    let persisted: PluginsCache | undefined;
    if (cache?.version === 2) {
      const target = pluginName.toLowerCase();
      persisted = {
        ...cache,
        marketplaces: cache.marketplaces.map((entry) =>
          entry.id !== marketplaceId
            ? entry
            : {
                ...entry,
                plugins: entry.plugins.map((existing) =>
                  existing.name.toLowerCase() === target
                    ? pluginInfo
                    : existing,
                ),
              },
        ),
      };
    }

    // Reject inconsistent output before publishing either file or retiring
    // the previous payload. I/O failures are not a cross-file transaction.
    const validatedIndex = validateCacheIndexPayload(index);
    const validatedCache = persisted
      ? validateCachePayload(persisted)
      : undefined;
    writeCacheIndex(validatedIndex);
    if (validatedCache) writeCache(validatedCache);
    if (
      prev?.cachePath &&
      prev.cachePath !== cacheDir &&
      fs.existsSync(prev.cachePath)
    ) {
      fs.rmSync(prev.cachePath, { recursive: true, force: true });
    }

    if (options?.skipRefresh !== true) {
      trackDetachedWork(() => refreshMarketplaces());
    }
    return { success: true, data: pluginInfo };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

export type {
  MarketplaceRegistrationResult,
  MarketplaceRemovalResult,
} from '@canopy/execution-engine/types/plugins';

export function installPlugin(
  ...args: Parameters<typeof installPluginUnlocked>
): ReturnType<typeof installPluginUnlocked> {
  return runSerializedPluginMutation(async () => {
    try {
      assertCatalogHealth();
      if (await pluginUninstallPending(args[0], args[1])) {
        return {
          success: false,
          error: 'Finish uninstalling this plugin before adding it again.',
        };
      }
      const result = await installPluginUnlocked(...args);
      assertCatalogHealth();
      return result;
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
}

export function installBuiltInPlugin(
  ...args: Parameters<typeof installBuiltInPluginUnlocked>
): ReturnType<typeof installBuiltInPluginUnlocked> {
  return runSerializedPluginMutation(async () => {
    try {
      assertCatalogHealth();
      if (
        await pluginUninstallPending(
          args[0]?.marketplaceId,
          args[0]?.pluginName,
        )
      ) {
        return {
          success: false,
          error: 'Finish uninstalling this plugin before adding it again.',
        };
      }
      const result = await installBuiltInPluginUnlocked(...args);
      assertCatalogHealth();
      return result;
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
}

async function pluginUninstallPending(
  marketplaceId: unknown,
  pluginName: unknown,
): Promise<boolean> {
  if (typeof marketplaceId !== 'string' || typeof pluginName !== 'string')
    return false;
  const pending =
    (await readPreferencesFile()).pendingInstalledItemUninstalls ?? [];
  if (!pending.length) return false;
  const cache = readCache();
  const marketplaces = cache?.version === 2 ? cache.marketplaces : [];
  const key = installedItemKey(
    canonicalInstalledItemRef(
      { kind: 'plugin', marketplaceId, pluginName },
      marketplaces,
    ),
  );
  return pending.some(
    (entry) =>
      entry.target.kind === 'plugin' &&
      installedItemKey(
        canonicalInstalledItemRef(entry.target, marketplaces),
      ) === key,
  );
}
