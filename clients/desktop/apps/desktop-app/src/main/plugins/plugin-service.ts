import * as fs from 'fs';
import {
  BUILT_IN_PLUGIN_MARKETPLACE_REQUIRED_MESSAGE,
  CLAUDE_FACET_UNAVAILABLE_MESSAGE,
  CODEX_FACET_UNAVAILABLE_MESSAGE,
  PLUGIN_NOT_IN_MARKETPLACE_MESSAGE,
  PLUGIN_PROVIDER_REQUIRED_MESSAGE,
  PLUGIN_UNINSTALL_PENDING_MESSAGE,
  UNKNOWN_PLUGIN_PROVIDER_MESSAGE,
} from '@canopy/protocol/plugins/remote-install';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { PluginCacheIndex } from '@canopy/execution-engine/node/plugins/catalog-read-health';
import {
  isUsablePluginCopyAsync,
  matchPluginSources,
  stripPluginSourceCredentials,
} from '@canopy/execution-engine/node/plugins/plugin-copy';
import {
  pluginCopyPathIdentity,
  pluginCopyProtectionIdentity,
} from '@canopy/execution-engine/node/plugins/plugin-copy-references';
import {
  retirePluginCopies,
  sweepRetiredPluginCopies as sweepUnreferencedPluginCopies,
} from './plugin-copy-retirement';
import {
  pluginCopyProviderEvidence,
  openPluginCopySweepEvidence,
  admitsPluginCopySweep,
  readClaudeMarketplaceRegistryEvidence,
  taintPluginCopyEvidence,
  readPluginCopyJson,
  readPluginCopyJsonWithRecovery,
  readRegistryNamedJsonWithRecovery,
  readPluginCopyProviderFile,
  isPluginCopyInstallMetadata,
  isPluginCopyEvidenceRecord,
  isPluginCopyManifest,
} from './plugin-copy-provider-evidence';
import { BRAND } from '@canopy/brand/current';
import { StorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import {
  claudeMarketplaceNames,
  type InheritedPluginMarketplace,
} from './inherited-cursor-plugins';
import {
  runSerializedPluginMutation,
  enqueueDetachedPluginMutation,
  afterPluginMutationSettled,
} from './plugin-mutation-queue';
import {
  assertPluginCatalogAdmission,
  assertPluginPayloadAdmission,
  assertPluginCatalogHealth,
  assertPluginCatalogHealthAsync,
  observePluginCatalog,
  isPluginCatalogObservationCurrent,
  assertPluginCatalogObservation,
  pluginCatalogReadValidator,
  notePluginCatalogEffects,
  setPluginCatalogChangeListener,
  normalizePluginCatalog,
  normalizePluginCacheIndex,
  publishPluginCatalog,
  publishPluginCachePair,
  updatePluginCatalog,
  readPluginCatalogHealth,
  readPluginCatalogHealthAsync,
  readPluginIndexHealth,
  readPluginIndexHealthAsync,
  withPluginCatalogScan,
} from './plugin-catalog-store';
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
import { safeReadJson, safeReadJsonAsync } from '../lib/fs-utils';
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
import {
  parseCatalogFrontmatterAndBody,
  parseFrontmatterAndBody,
} from '../lib/frontmatter';
import {
  ContainedPathRefusedError,
  isPathInside,
  withContainedFile,
} from '../lib/path-safety';
import { parseGitHubSource } from '../skills/source-parser';
import {
  addCodexMarketplace as addCodexMarketplaceUnchecked,
  codexMarketplaceManifestPath,
  installCodexPlugin as installCodexPluginUnchecked,
  isStructuralCodexMarketplaceFailure,
  listCodexPlugins,
  readCuratedCodexInstalledRoots,
  refreshCuratedCodexPlugins,
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
import { restrictedPluginSourceRefusal } from './remote-install-source-gate';
import {
  updateWorkspacePlugins,
  WorkspacePluginsRefusedError,
} from '../lib/workspace-plugin-defaults';
import { isErrnoException } from '../lib/type-guards';
import { pruneMarketplaceRefsFromPreferences } from './marketplace-preferences-prune';
import {
  getCuratedPluginMarketplaceName,
  syncCuratedPlugins,
  type CuratedPluginSyncResult,
} from './curated-plugin-sync';
import {
  invalidateCuratedMarketplaceScanCache,
  mergeCuratedMarketplace,
  curatedCodexManifestPath,
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
import type {
  IPCResult,
  IPCResultWithAppError,
} from '@canopy/execution-engine/types/pipeline';
import { reportInstallFailure } from '../lib/install-failure-reporting';
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

async function withPluginEffects<T>(effect: () => Promise<T>): Promise<T> {
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  notePluginCatalogEffects();
  try {
    return await effect();
  } finally {
    notePluginCatalogEffects();
  }
}

function projectPluginPayloadPath(candidate: string): string {
  const suffix: string[] = [];
  let ancestor = path.resolve(candidate);
  for (;;) {
    try {
      return path.join(fs.realpathSync(ancestor), ...suffix.reverse());
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function assertPluginPayloadPathAdmission(candidate: string): void {
  assertPluginPayloadAdmission();
  const managedRoot = path.resolve(getPluginCacheDir());
  const target = path.resolve(candidate);
  const resolvedRoot = projectPluginPayloadPath(managedRoot);
  const resolvedTarget = projectPluginPayloadPath(target);
  const compatibilityRoot = path.resolve(getCodexCompatibilityCacheRootDir());
  const roots = [
    compatibilityRoot,
    projectPluginPayloadPath(compatibilityRoot),
  ];
  const targets = [target, resolvedTarget];
  if (
    roots.some((root) =>
      targets.some(
        (entry) => isPathInside(root, entry) || isPathInside(entry, root),
      ),
    )
  )
    throw new Error('Codex compatibility cache has a separate owner.');
  if (
    target === managedRoot ||
    !isPathInside(managedRoot, target) ||
    resolvedTarget === resolvedRoot ||
    !isPathInside(resolvedRoot, resolvedTarget)
  )
    throw new Error('Plugin cache is outside its managed directory.');
}

/** Sweep policy stays separate; payload writes remain with the admitted owner. */
export async function sweepRetiredPluginCopies(): Promise<void> {
  await runSerializedPluginMutation(() =>
    sweepUnreferencedPluginCopies(
      async (candidate) => {
        assertPluginPayloadPathAdmission(candidate);
        try {
          await fs.promises.rm(candidate, { recursive: true, force: true });
        } finally {
          notePluginCatalogEffects();
        }
      },
      {
        installedPlugins: getClaudeInstalledPluginsPath(),
        knownMarketplaces: getKnownMarketplacesPath(),
      },
    ),
  );
}

async function execPluginCli(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  assertCatalogHealth({
    allowLegacy: providerRevalidation.getStore() === true,
  });
  await withPluginEffects(() =>
    runClaudeCliProcessOffMain({
      command: file,
      args,
      env,
      timeoutMs: PLUGIN_CLI_TIMEOUT_MS,
    }),
  );
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
  const result = await withPluginEffects(() =>
    addCodexMarketplaceUnchecked(...args),
  );
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
  const result = await withPluginEffects(() =>
    removeCodexMarketplaceUnchecked(...args),
  );
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
  const result = await withPluginEffects(() =>
    upgradeCodexMarketplaceUnchecked(...args),
  );
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
  const result = await withPluginEffects(() =>
    installCodexPluginUnchecked(...args),
  );
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

/** The user-scope enabledPlugins flag for one Claude plugin id, if set. */
async function readClaudeEnabledFlag(id: string): Promise<boolean | undefined> {
  try {
    const settings: unknown = JSON.parse(
      await fs.promises.readFile(getClaudeSettingsPath(), 'utf8'),
    );
    const flag =
      isRecord(settings) && isRecord(settings.enabledPlugins)
        ? settings.enabledPlugins[id]
        : undefined;
    return typeof flag === 'boolean' ? flag : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn one Claude plugin on or off. The Claude CLI refuses a plugin that is
 * already in the requested state ("is already enabled at user scope", exit
 * 1), so an unchanged plugin is a no-op rather than a failed status change.
 */
async function setClaudeInstalledItemEnabledUnlocked(
  id: string,
  enabled: boolean,
): Promise<void> {
  if ((await readClaudeEnabledFlag(id)) === enabled) return;
  try {
    await execPluginCli(
      getBundledClaudeBinaryPath(),
      ['plugin', enabled ? 'enable' : 'disable', id, '--scope', 'user'],
      getEnhancedEnv(),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /\bis already (enabled|disabled)\b/i.test(error.message)
    )
      return;
    throw error;
  }
}

async function uninstallClaudeInstalledItemUnlocked(id: string): Promise<void> {
  await execPluginCli(
    getBundledClaudeBinaryPath(),
    ['plugin', 'uninstall', id, '--scope', 'user', '--keep-data'],
    getEnhancedEnv(),
  );
}

interface ClaudeEntryIdentity {
  marketplaceId: string;
  entryName: string;
  sourceUrl?: string;
}

function claudeManifestIdentities(
  marketplaceId: string,
  manifest: { plugins?: unknown } | null,
): ClaudeEntryIdentity[] {
  const entries: unknown[] = Array.isArray(manifest?.plugins)
    ? manifest.plugins
    : [];
  return entries.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.name === 'string' &&
    entry.name.length > 0 &&
    isRecord(entry.source) &&
    typeof entry.source.url === 'string'
      ? [
          {
            marketplaceId,
            entryName: entry.name,
            sourceUrl: entry.source.url,
          },
        ]
      : [],
  );
}

interface ClaudeEntryIdentityLookup {
  entries: readonly ClaudeEntryIdentity[];
  joinedKeyOwners: ReadonlyMap<string, ClaudeEntryIdentity | undefined>;
  legacyOwnershipKnown: boolean;
}

function indexClaudeEntryIdentities(
  entries: readonly ClaudeEntryIdentity[],
): ClaudeEntryIdentityLookup {
  const joinedKeyOwners = new Map<string, ClaudeEntryIdentity | undefined>();
  for (const entry of entries) {
    const key = cacheKey(entry.marketplaceId, entry.entryName);
    if (!joinedKeyOwners.has(key)) {
      joinedKeyOwners.set(key, entry);
      continue;
    }
    const owner = joinedKeyOwners.get(key);
    if (
      !owner ||
      owner.marketplaceId !== entry.marketplaceId ||
      owner.entryName !== entry.entryName
    )
      joinedKeyOwners.set(key, undefined);
  }
  return { entries, joinedKeyOwners, legacyOwnershipKnown: true };
}

async function readClaudeEntryIdentities(
  knownCache?: AnyPluginsCache | null,
): Promise<ClaudeEntryIdentityLookup> {
  const { known, complete } = await readKnownMarketplacesRegistry();
  const manifests = await mapWithConcurrency(
    Object.entries(known),
    MARKETPLACE_REFRESH_CONCURRENCY,
    async ([id, entry]): Promise<{
      id: string;
      entries: ClaudeEntryIdentity[];
    } | null> => {
      if (!isRecord(entry) || typeof entry.installLocation !== 'string')
        return null;
      const manifest = await readClaudeRegistryJson(
        path.join(entry.installLocation, '.claude-plugin', 'marketplace.json'),
      ).catch(() => undefined);
      const located = isRecord(manifest) && Array.isArray(manifest.plugins);
      // A registration names this manifest: unreadable is not an empty inventory.
      if (!located) taintPluginCopyEvidence();
      return located
        ? { id, entries: claudeManifestIdentities(id, manifest) }
        : null;
    },
  );
  const cache = knownCache === undefined ? await readCacheAsync() : knownCache;
  // An unreadable registry or registration could own any legacy key.
  let legacyOwnershipKnown =
    complete && manifests.every((registration) => registration !== null);
  const normalized = manifests.flatMap((registration) => {
    if (!registration) return [];
    const owners = (cache?.version === 2 ? cache.marketplaces : []).filter(
      (candidate) =>
        candidate.id === registration.id ||
        candidate.providerStatus.claude.marketplaceName === registration.id,
    );
    // Unresolved registration mappings defer removal, not unrelated legacy
    // operations. Checked per registration: an empty or local-only manifest
    // still hides which legacy keys it once owned.
    if (owners.length !== 1) legacyOwnershipKnown = false;
    return registration.entries.flatMap((entry) =>
      owners.length
        ? owners.map((owner) => ({ ...entry, marketplaceId: owner.id }))
        : [entry],
    );
  });
  // Recorded catalog tuples can reveal collisions even after a provider disappears.
  const recorded = (cache?.version === 2 ? cache.marketplaces : []).flatMap(
    (marketplace) =>
      marketplace.plugins.flatMap((plugin): ClaudeEntryIdentity[] => {
        const entryName = recordedClaudeEntryName(plugin);
        return plugin.facets.claude && entryName !== undefined
          ? [{ marketplaceId: marketplace.id, entryName }]
          : [];
      }),
  );
  return {
    ...indexClaudeEntryIdentities([...normalized, ...recorded]),
    legacyOwnershipKnown,
  };
}

const CLAUDE_REGISTRY_FILE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Registry and manifest reads run inside the plugin mutation queue. Open
 * without blocking and read only a bounded regular file, so a FIFO or device
 * cannot stall every mutation; callers treat a rejection as unknown ownership.
 */
async function readClaudeRegistryJson(file: string): Promise<unknown> {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > CLAUDE_REGISTRY_FILE_MAX_BYTES)
      throw new Error(`Skipped a non-regular or oversized file: ${file}`);
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    return parsed;
  } finally {
    await handle.close();
  }
}

function isMarketplaceEvidence(value: unknown): value is MarketplaceManifest {
  return isPluginCopyManifest(value);
}

async function readClaudeMarketplaceManifest(
  file: string,
): Promise<MarketplaceManifest | null> {
  return readPluginCopyJsonWithRecovery(file, isMarketplaceEvidence);
}

/** For manifests a Claude registration names; curated and bundled ones may be absent. */
async function readRegisteredClaudeMarketplaceManifest(
  file: string,
): Promise<MarketplaceManifest | null> {
  return readRegistryNamedJsonWithRecovery(file, isMarketplaceEvidence);
}

async function readCodexMarketplaceManifest(
  file: string,
): Promise<CodexMarketplaceManifest | null> {
  const accepts = (value: unknown): value is CodexMarketplaceManifest =>
    isPluginCopyEvidenceRecord(value) && Array.isArray(value.plugins);
  return readPluginCopyJsonWithRecovery(file, accepts);
}

function recordedClaudeEntryName(
  plugin: PluginInfo | undefined,
): string | undefined {
  return (
    plugin?.facets.claude?.provenance?.marketplaceEntryName ??
    plugin?.provenance?.marketplaceEntryName
  );
}

interface ResolvedClaudeEntryIdentity {
  entryName: string;
  bindingOwned: boolean;
}

/** The recorded entry name, else the requested literal name, as on develop. */
function resolveClaudeEntryIdentity(
  identities: ClaudeEntryIdentityLookup,
  marketplaceId: string,
  input: { entryName?: string; requestedName?: string },
  index: PluginCacheIndex,
): ResolvedClaudeEntryIdentity | undefined {
  const entryName = input.entryName ?? input.requestedName;
  if (entryName === undefined) return undefined;
  const key = cacheKey(marketplaceId, entryName);
  const recorded = index.entries[key]?.provenance?.marketplaceEntryName;
  if (recorded !== undefined)
    return { entryName, bindingOwned: recorded === entryName };
  // Joined keys do not encode tuple boundaries. Keep known collisions unclaimed.
  const owner = identities.joinedKeyOwners.get(key);
  const conflicting =
    identities.joinedKeyOwners.has(key) &&
    (!owner ||
      owner.marketplaceId !== marketplaceId ||
      owner.entryName !== entryName);
  return { entryName, bindingOwned: !conflicting };
}

/**
 * Mutation identity. Install, Update and uninstall never infer an entry from a
 * source URL: a reassigned URL would move them into another entry's slot. A
 * legacy row bound under an alias keeps that key, as on develop.
 */
function resolveInstalledClaudeEntryIdentity(
  identities: ClaudeEntryIdentityLookup,
  index: PluginCacheIndex,
  marketplaceId: string,
  plugin: PluginInfo | undefined,
  requestedName?: string,
): ResolvedClaudeEntryIdentity | undefined {
  const facet = plugin?.facets.claude;
  if (!facet && requestedName === undefined) return undefined;
  return resolveClaudeEntryIdentity(
    identities,
    marketplaceId,
    {
      entryName: facet ? recordedClaudeEntryName(plugin) : undefined,
      requestedName,
    },
    index,
  );
}

function marketplacePluginRows(
  cache: AnyPluginsCache | null,
  marketplaceId: string,
): PluginInfo[] {
  return cache?.version === 2
    ? (cache.marketplaces.find((entry) => entry.id === marketplaceId)
        ?.plugins ?? [])
    : [];
}

interface PluginInstallTarget {
  currentPlugin: PluginInfo | undefined;
  identity: ResolvedClaudeEntryIdentity | undefined;
  repairEntryName: string | undefined;
  marketplaceEntryName: string;
  key: string;
  /** The binding the install replaces. */
  prev: PluginCacheIndex['entries'][string] | undefined;
}

/** The row an install replaces and the index slot it binds. */
function resolvePluginInstallTarget(
  identities: ClaudeEntryIdentityLookup,
  index: PluginCacheIndex,
  plugins: readonly PluginInfo[],
  marketplaceId: string,
  pluginName: string,
  sourceUrl: string,
  repairIdentity: PluginRepairIdentity | undefined,
): PluginInstallTarget {
  const currentPlugin = findRequestedClaudePlugin(plugins, pluginName, {
    sourceUrl,
    listedSourceUrl: identities.entries.find(
      (entry) =>
        entry.marketplaceId === marketplaceId && entry.entryName === pluginName,
    )?.sourceUrl,
  });
  const identity = repairIdentity
    ? resolveClaudeEntryIdentity(
        identities,
        marketplaceId,
        { entryName: repairIdentity.entryName },
        index,
      )
    : resolveInstalledClaudeEntryIdentity(
        identities,
        index,
        marketplaceId,
        currentPlugin,
        pluginName,
      );
  const repairEntryName = repairIdentity
    ? undefined
    : rowRepairEntryName(identities, index, marketplaceId, currentPlugin);
  const marketplaceEntryName = identity?.entryName ?? pluginName;
  // Last writer wins the slot, as on develop; the recorded entry name keeps
  // ownership exact. Only a slot this entry owns has a copy to replace.
  // A legacy row bound under an alias keeps that key, as on develop.
  const key = cacheKey(marketplaceId, marketplaceEntryName);
  const prev = identity?.bindingOwned ? index.entries[key] : undefined;
  return {
    currentPlugin,
    identity,
    repairEntryName,
    marketplaceEntryName,
    key,
    prev,
  };
}

/**
 * Whether an automatic repair clones under the restricted policy: the session's
 * row, the current row, an index binding the repair replaces or yields to, or
 * any copy of this source in the marketplace was installed restricted. The
 * index can be ahead of the catalog (index-first publication) under any key a
 * user install chose, and nothing in-process records that across a restart.
 */
async function automaticRepairRestricted(
  marketplaceId: string,
  pluginName: string,
  sourceUrl: string,
  options: {
    disableRedirects?: boolean;
    repairIdentity?: PluginRepairIdentity & { sourceUrl: string };
  },
): Promise<boolean> {
  const expected = options.repairIdentity;
  if (
    options.disableRedirects === true ||
    expected?.binding.remoteSourceRestricted === true
  )
    return true;
  const index = await readCacheIndex();
  const plugins = marketplacePluginRows(await readCacheAsync(), marketplaceId);
  const identities = await readClaudeEntryIdentities();
  const target = resolvePluginInstallTarget(
    identities,
    index,
    plugins,
    marketplaceId,
    pluginName,
    sourceUrl,
    expected,
  );
  const rows = [
    target.currentPlugin,
    plugins.find((row) => row.name.toLowerCase() === pluginName.toLowerCase()),
  ].filter((row): row is PluginInfo => row !== undefined);
  const keys = new Set<string>();
  const copies = new Set([target.prev?.cachePath]);
  for (const row of rows) {
    const entryName = (
      await resolvePluginRepairIdentity(
        marketplaceId,
        row,
        expected?.userMutationGeneration,
      )
    )?.entryName;
    if (entryName !== undefined) keys.add(cacheKey(marketplaceId, entryName));
    copies.add(row.facets.claude?.cachePath);
    copies.add(row.cachePath);
  }
  if (expected) {
    keys.add(cacheKey(marketplaceId, expected.entryName));
    copies.add(userInstalledCopy(index, expected)?.cachePath);
  }
  return (
    rows.some((row) => pluginRepairBinding(row).remoteSourceRestricted) ||
    Object.entries(index.entries).some(
      ([key, binding]) =>
        binding.provenance?.remoteSourceRestricted === true &&
        (keys.has(key) ||
          copies.has(binding.cachePath) ||
          (key.startsWith(`${marketplaceId}/`) &&
            bindsPluginSource(binding, sourceUrl))),
    )
  );
}

/**
 * Read-side identity for damaged-index recovery and metadata-only history. A
 * row without a recorded entry matches its source to one manifest entry, as
 * develop's recovery did, and only while that entry's slot is empty or holds
 * the row's copy.
 */
function resolveSourceClaudeEntryIdentity(
  identities: ClaudeEntryIdentityLookup,
  index: PluginCacheIndex,
  marketplaceId: string,
  plugin: PluginInfo,
): ResolvedClaudeEntryIdentity | undefined {
  const facet = plugin.facets.claude;
  if (!facet) return undefined;
  const recorded = recordedClaudeEntryName(plugin);
  if (recorded !== undefined)
    return resolveClaudeEntryIdentity(
      identities,
      marketplaceId,
      { entryName: recorded },
      index,
    );
  const provenance = facet.provenance ?? plugin.provenance;
  // Catalog reads redact provenance URLs; prefer lossless or raw source text.
  const lossless =
    provenance?.sourceIdentityComplete === true
      ? provenance.sourceUrl
      : undefined;
  const raw = lossless ?? (facet.externalSource?.url || undefined);
  const sourceUrl = raw ?? provenance?.sourceUrl;
  if (!sourceUrl) return undefined;
  const compared = identities.entries
    .filter((entry) => entry.marketplaceId === marketplaceId)
    .map((entry) => ({
      entry,
      match:
        entry.sourceUrl === undefined
          ? 'different'
          : matchPluginSources(sourceUrl, entry.sourceUrl, raw !== undefined),
    }));
  const exact = compared.filter(({ match }) => match === 'exact');
  const matches =
    exact.length > 0
      ? exact
      : compared.filter(({ match }) => match === 'alias');
  const names = new Set(matches.map(({ entry }) => entry.entryName));
  if (names.size !== 1) return undefined;
  const entryName = matches[0].entry.entryName;
  const holdsCopy = (
    binding: PluginCacheIndex['entries'][string] | undefined,
  ): boolean =>
    !!binding &&
    (binding.cachePath === facet.cachePath ||
      binding.cachePath === plugin.cachePath);
  const slot = index.entries[cacheKey(marketplaceId, entryName)];
  // A copy still bound under another key already has its owner there.
  if (
    slot
      ? !holdsCopy(slot)
      : Object.entries(index.entries).some(
          ([key, binding]) =>
            key.startsWith(`${marketplaceId}/`) && holdsCopy(binding),
        )
  )
    return undefined;
  return resolveClaudeEntryIdentity(
    identities,
    marketplaceId,
    { entryName },
    index,
  );
}

/** Base deleted a request's literal-key copies; skip keys another entry owns. */
function isLiteralKeyForeign(
  identities: ClaudeEntryIdentityLookup,
  index: PluginCacheIndex,
  marketplaceId: string,
  entryName: string,
  selectedEntryName: string | undefined,
): boolean {
  if (
    entryName !== selectedEntryName &&
    identities.entries.some(
      (entry) =>
        entry.marketplaceId === marketplaceId && entry.entryName === entryName,
    )
  )
    return true;
  return (
    resolveClaudeEntryIdentity(identities, marketplaceId, { entryName }, index)
      ?.bindingOwned !== true
  );
}

function findRequestedClaudePlugin(
  plugins: readonly PluginInfo[],
  requestedName: string,
  install?: {
    sourceUrl: string;
    /** The source of the listed entry whose name is the requested name. */
    listedSourceUrl: string | undefined;
  },
): PluginInfo | undefined {
  const sourceOf = (plugin: PluginInfo): string | undefined =>
    (plugin.facets.claude?.externalSource ?? plugin.externalSource)?.url;
  // Callers name catalog rows by their installed name, not their entry name.
  const named = plugins.filter(
    (plugin) => plugin.name.toLowerCase() === requestedName.toLowerCase(),
  );
  // An installed name can equal another listed entry's name. Installs and
  // Updates pass the row's own source, which tells the rows apart.
  const sourced = named.filter(
    (plugin) => install !== undefined && sourceOf(plugin) === install.sourceUrl,
  );
  const row = named.length > 1 && sourced.length === 1 ? sourced[0] : named[0];
  const recorded = recordedClaudeEntryName(row);
  const requestsListedEntry =
    !!row &&
    !!install &&
    recorded !== undefined &&
    recorded !== requestedName &&
    install.listedSourceUrl === install.sourceUrl &&
    sourceOf(row) !== install.sourceUrl;
  // That entry's exact source names it, not the row its installed name merged into.
  return requestsListedEntry
    ? plugins.find(
        (plugin) => recordedClaudeEntryName(plugin) === requestedName,
      )
    : (row ??
        plugins.find(
          (plugin) => recordedClaudeEntryName(plugin) === requestedName,
        ));
}

/** Uninstall keeps marketplace checkout paths, which inline plugins resolve from. */
function checkoutPathOrEmpty(
  value: string,
  marketplace: MarketplaceInfo,
): string {
  if (!path.isAbsolute(value)) return value;
  const inside = (roots: readonly (string | undefined)[]): boolean =>
    roots.some((root) => !!root && isPathInside(root, value));
  return !inside([getPluginCacheDir(), getCodexCompatibilityCacheRootDir()]) &&
    inside([
      marketplace.installLocation,
      marketplace.providerStatus.claude.installLocation,
      marketplace.providerStatus.codex.installLocation,
    ])
    ? value
    : '';
}

interface PluginRepairBinding {
  cachePath?: string;
  installedAt?: string;
  remoteSourceRestricted: boolean;
}

type PluginRepairIdentity = Pick<
  ClaudeEntryIdentity,
  'marketplaceId' | 'entryName'
> & { userMutationGeneration: number; binding: PluginRepairBinding };

function pluginRepairBinding(plugin: PluginInfo): PluginRepairBinding {
  const facet = plugin.facets.claude;
  const provenance = facet?.provenance ?? plugin.provenance;
  return {
    cachePath: facet?.cachePath ?? plugin.cachePath,
    installedAt: provenance?.installedAt,
    remoteSourceRestricted: provenance?.remoteSourceRestricted === true,
  };
}

/** Refresh may drop a missing copy's path or backfill legacy provenance; installs replace both. */
function samePluginRepairBinding(
  selected: PluginRepairBinding,
  current: PluginRepairBinding,
): boolean {
  return (
    (current.cachePath === undefined ||
      current.cachePath === selected.cachePath) &&
    (selected.installedAt === undefined ||
      current.installedAt === selected.installedAt) &&
    current.remoteSourceRestricted === selected.remoteSourceRestricted
  );
}

let userMutationGeneration = 0;
const entryUserMutationGenerations = new Map<string, number>();

export function getPluginUserMutationGeneration(): number {
  return userMutationGeneration;
}

function notePluginUserMutation(
  marketplaceId: string,
  entryName: string,
): void {
  entryUserMutationGenerations.set(
    JSON.stringify([marketplaceId, entryName]),
    ++userMutationGeneration,
  );
}

function entryChangedSince(
  marketplaceId: string,
  entryName: string,
  generation: number,
): boolean {
  return (
    (entryUserMutationGenerations.get(
      JSON.stringify([marketplaceId, entryName]),
    ) ?? 0) > generation
  );
}

/** The index slot and fresh copy a user install published, by each entry it noted. */
const userInstalledCopies = new Map<
  string,
  { entryName: string; cachePath: string }
>();

/**
 * Index-first publication can land a user install's copy without its catalog
 * row. Every install clones a fresh folder, so a slot still holding that exact
 * path is the user's copy; a removed or rebound slot never matches. In-process
 * only: after a restart repair is ordinary, as on develop; revisit if a durable
 * marker is added.
 */
function notePluginUserInstall(
  marketplaceId: string,
  notedEntryNames: readonly (string | undefined)[],
  copy: { entryName: string; cachePath: string },
): void {
  for (const entryName of new Set(notedEntryNames)) {
    if (entryName === undefined) continue;
    userInstalledCopies.set(JSON.stringify([marketplaceId, entryName]), copy);
    notePluginUserMutation(marketplaceId, entryName);
  }
}

/** The copy the entry's last user install left in its index slot, as the requested plugin. */
function userInstalledCopy(
  index: PluginCacheIndex,
  expected: PluginRepairIdentity & { sourceUrl: string },
): PluginCacheIndex['entries'][string] | undefined {
  const copy = userInstalledCopies.get(
    JSON.stringify([expected.marketplaceId, expected.entryName]),
  );
  const indexed = copy
    ? index.entries[cacheKey(expected.marketplaceId, copy.entryName)]
    : undefined;
  return copy &&
    indexed?.cachePath === copy.cachePath &&
    isRequestedPluginCopy(indexed, copy.entryName, expected.sourceUrl)
    ? indexed
    : undefined;
}

/**
 * Automatic repair only. Mutations never infer an entry from a source URL; a
 * repair without a recorded entry matches its source to one manifest entry and
 * claims that entry's key only with this installation's copy as evidence.
 */
function inferRepairClaudeEntryName(
  identities: ClaudeEntryIdentityLookup,
  index: PluginCacheIndex,
  marketplaceId: string,
  input: {
    sourceUrl?: string;
    /** The name whose literal key a pre-provenance installation was bound under. */
    literalName?: string;
    /** The installation's recorded copies, the evidence for an inferred binding. */
    cachePaths?: readonly (string | undefined)[];
    /** Whether an occupied inferred entry is still claimed. */
    claimsOccupiedEntry?: (entryName: string) => boolean;
  },
): string | undefined {
  const sourceUrl = input.sourceUrl;
  if (!sourceUrl) return undefined;
  const candidates = identities.entries.filter(
    (entry) => entry.marketplaceId === marketplaceId,
  );
  const compared = candidates.map((entry) => ({
    entry,
    match:
      entry.sourceUrl === undefined
        ? 'different'
        : matchPluginSources(
            entry.sourceUrl,
            sourceUrl,
            // Raw manifest matching recovers entry ownership only. Copy
            // replacement separately requires qualified provenance.
            true,
          ),
  }));
  const exact = compared.filter(({ match }) => match === 'exact');
  const matches =
    exact.length > 0
      ? exact
      : compared.filter(({ match }) => match === 'alias');
  const names = new Set(matches.map(({ entry }) => entry.entryName));
  const inferred = names.size === 1 ? matches[0].entry.entryName : undefined;
  if (inferred === undefined) return undefined;
  const holdsThisCopy = (name: string | undefined): boolean => {
    const binding =
      name === undefined
        ? undefined
        : index.entries[cacheKey(marketplaceId, name)];
    return !!binding && !!input.cachePaths?.includes(binding.cachePath);
  };
  // Refresh reads only manifest entries' keys, so only a listed literal
  // entry holding this installation's copy outranks an empty inferred slot.
  // Only manifest identities carry a source URL.
  const literalListed = candidates.some(
    (entry) =>
      entry.sourceUrl !== undefined && entry.entryName === input.literalName,
  );
  if (holdsThisCopy(inferred)) return inferred;
  if (literalListed && holdsThisCopy(input.literalName))
    return input.literalName;
  return !index.entries[cacheKey(marketplaceId, inferred)] ||
    input.claimsOccupiedEntry?.(inferred)
    ? inferred
    : undefined;
}

/** The entry automatic repair binds for a row: its recorded entry, else a source match. */
function repairClaudeEntryName(
  identities: ClaudeEntryIdentityLookup,
  index: PluginCacheIndex,
  marketplaceId: string,
  plugin: PluginInfo,
  claimsOccupiedEntry?: (entryName: string) => boolean,
): string | undefined {
  const facet = plugin.facets.claude;
  return (
    recordedClaudeEntryName(plugin) ??
    inferRepairClaudeEntryName(identities, index, marketplaceId, {
      // Redaction leaves '' for a URL it cannot parse.
      sourceUrl:
        facet?.provenance?.sourceUrl ||
        plugin.provenance?.sourceUrl ||
        facet?.externalSource?.url ||
        plugin.externalSource?.url,
      literalName: plugin.name,
      // An occupied inferred key needs this installation's copy as evidence,
      cachePaths: [facet?.cachePath, plugin.cachePath],
      // or a user change since the snapshot that unbound the copy; the in-slot
      // check then yields to that change.
      claimsOccupiedEntry,
    })
  );
}

/**
 * User mutations name a legacy row by its literal key, not the entry repair
 * infers for it. Resolve that entry before the mutation changes the index and
 * note it too, so a stale repair of the row cannot undo the mutation.
 */
function rowRepairEntryName(
  identities: ClaudeEntryIdentityLookup,
  index: PluginCacheIndex,
  marketplaceId: string,
  plugin: PluginInfo | undefined,
): string | undefined {
  return plugin
    ? repairClaudeEntryName(identities, index, marketplaceId, plugin)
    : undefined;
}

function noteUserMutationEntries(
  marketplaceId: string,
  entryNames: readonly (string | undefined)[],
): void {
  for (const entryName of new Set(entryNames))
    if (entryName !== undefined)
      notePluginUserMutation(marketplaceId, entryName);
}

export async function resolvePluginRepairIdentity(
  marketplaceId: string,
  plugin: PluginInfo,
  generation = userMutationGeneration,
): Promise<PluginRepairIdentity | undefined> {
  const index = await readCacheIndex();
  const identities = await readClaudeEntryIdentities();
  const copies = [plugin.facets.claude?.cachePath, plugin.cachePath];
  const copyBound = Object.values(index.entries).some((entry) =>
    copies.includes(entry.cachePath),
  );
  // Automatic repair needs entry evidence; an installed name alone is not an owner.
  const entryName = repairClaudeEntryName(
    identities,
    index,
    marketplaceId,
    plugin,
    (name) => !copyBound && entryChangedSince(marketplaceId, name, generation),
  );
  const identity = resolveClaudeEntryIdentity(
    identities,
    marketplaceId,
    { entryName },
    index,
  );
  return identity
    ? {
        marketplaceId,
        entryName: identity.entryName,
        userMutationGeneration: generation,
        binding: pluginRepairBinding(plugin),
      }
    : undefined;
}

/** Remove only cache directories owned by Canopy, never an external source tree. */
async function removeInstalledPluginCacheUnlocked(
  marketplaceId: string,
  pluginName: string,
): Promise<void> {
  await withCacheLock(async () => {
    assertCatalogHealth();
    const index = await readCacheIndex();
    const cache = readCache();
    const plugins =
      cache?.version === 2
        ? (cache.marketplaces.find((entry) => entry.id === marketplaceId)
            ?.plugins ?? [])
        : [];
    const identities = await readClaudeEntryIdentities();
    const plugin = findRequestedClaudePlugin(plugins, pluginName);
    // A recorded entry name wins; fold case only for the literal-key fallback.
    let identity = resolveInstalledClaudeEntryIdentity(
      identities,
      index,
      marketplaceId,
      plugin,
    );
    if (!identity) {
      const requestedKey = cacheKey(marketplaceId, pluginName).toLowerCase();
      const storedKeys = Object.keys(index.entries).filter(
        (key) =>
          key.startsWith(`${marketplaceId}/`) &&
          key.toLowerCase() === requestedKey,
      );
      identity = resolveInstalledClaudeEntryIdentity(
        identities,
        index,
        marketplaceId,
        plugin,
        storedKeys.length === 1
          ? storedKeys[0].slice(marketplaceId.length + 1)
          : pluginName,
      );
      // Installed Items folds names; ambiguous stored spellings cannot authorize deletion.
      if (identity && storedKeys.length > 1) identity.bindingOwned = false;
    }
    const repairEntryName = rowRepairEntryName(
      identities,
      index,
      marketplaceId,
      plugin,
    );
    const key = identity?.bindingOwned
      ? cacheKey(marketplaceId, identity.entryName)
      : undefined;
    // Retire base's case-folded keys and the matched row, minus keys another
    // entry owns. Bindings follow identity.
    const prefix = `${marketplaceId}/`;
    const managedPaths = new Set<string>();
    for (const [storedKey, entry] of Object.entries(index.entries))
      if (
        entry.cachePath &&
        storedKey.startsWith(prefix) &&
        storedKey.slice(prefix.length).toLowerCase() ===
          pluginName.toLowerCase() &&
        !isLiteralKeyForeign(
          identities,
          index,
          marketplaceId,
          storedKey.slice(prefix.length),
          identity?.entryName,
        )
      )
        managedPaths.add(entry.cachePath);
    for (const candidate of [
      key === undefined ? undefined : index.entries[key]?.cachePath,
      plugin?.cachePath,
      plugin?.facets.claude?.cachePath,
    ]) {
      if (candidate) managedPaths.add(candidate);
    }
    const hadBinding = key !== undefined && key in index.entries;
    if (key !== undefined) delete index.entries[key];
    const nextCache: PluginsCache | undefined =
      cache?.version === 2
        ? {
            ...cache,
            marketplaces: cache.marketplaces.map((marketplace) =>
              marketplace.id !== marketplaceId
                ? marketplace
                : {
                    ...marketplace,
                    plugins: marketplace.plugins.map((row) =>
                      row !== plugin
                        ? row
                        : {
                            ...row,
                            sourcePath: checkoutPathOrEmpty(
                              row.sourcePath,
                              marketplace,
                            ),
                            cachePath: undefined,
                            cachedAt: undefined,
                            details: undefined,
                            provenance: undefined,
                            globalInstallStatus: row.globalInstallStatus
                              ? {
                                  ...row.globalInstallStatus,
                                  ...(row.globalInstallStatus.claude
                                    ? {
                                        claude: {
                                          ...row.globalInstallStatus.claude,
                                          installed: false,
                                          installError: undefined,
                                        },
                                      }
                                    : {}),
                                  ...(row.globalInstallStatus.codex
                                    ? {
                                        codex: {
                                          ...row.globalInstallStatus.codex,
                                          installed: false,
                                          installError: undefined,
                                        },
                                      }
                                    : {}),
                                }
                              : undefined,
                            facets: {
                              ...row.facets,
                              codexCompatibility: undefined,
                              claude: row.facets.claude
                                ? {
                                    ...row.facets.claude,
                                    sourcePath: checkoutPathOrEmpty(
                                      row.facets.claude.sourcePath,
                                      marketplace,
                                    ),
                                    installLocation: checkoutPathOrEmpty(
                                      row.facets.claude.installLocation,
                                      marketplace,
                                    ),
                                    cachePath: undefined,
                                    cachedAt: undefined,
                                    details: undefined,
                                    provenance: undefined,
                                  }
                                : undefined,
                              codex: row.facets.codex
                                ? {
                                    ...row.facets.codex,
                                    sourcePath: checkoutPathOrEmpty(
                                      row.facets.codex.sourcePath,
                                      marketplace,
                                    ),
                                    installLocation: checkoutPathOrEmpty(
                                      row.facets.codex.installLocation,
                                      marketplace,
                                    ),
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
          }
        : undefined;
    // Uninstall clears ownership now; only refresh may reclaim downloaded bytes.
    // Separately owned compatibility bytes deliberately remain with their owner.
    retirePluginCopies(index, managedPaths);
    try {
      if (hadBinding || managedPaths.size)
        await publishCatalogRetiringCopies(index, nextCache, hadBinding);
      else if (nextCache) await writeCache(nextCache);
    } finally {
      noteUserMutationEntries(marketplaceId, [
        identity?.entryName,
        repairEntryName,
      ]);
    }
    invalidateManagedMarketplaceScanCache(marketplaceId);
  });
}

function getBuiltInProviderMarketplaceName(): string {
  return `${BRAND.internalName}-plugins`;
}

function getBuiltInMarketplaceDisplayName(): string {
  return `${BRAND.displayName} Marketplace`;
}

export {
  readPluginCatalogHealth,
  readPluginIndexHealth,
} from './plugin-catalog-store';

function catalogReadError(state: string): Error {
  return new Error(
    `Couldn't use the plugin catalog because it is ${state}. Plugin changes and execution are blocked.`,
  );
}

function assertCatalogHealth(options?: { allowLegacy?: boolean }): void {
  assertPluginCatalogHealth(options?.allowLegacy);
  assertPluginCatalogAdmission();
}

async function assertCatalogHealthAsync(): Promise<void> {
  await assertPluginCatalogHealthAsync();
  assertPluginCatalogAdmission();
}

function scheduleCatalogConsumerRefresh(): void {
  trackDetachedWork(() =>
    (async (): Promise<void> => {
      const { refreshInvocableInventoryAfterMutation } =
        await import('./invocable-inventory-service');
      refreshInvocableInventoryAfterMutation('plugin-catalog:settled-change');
    })().catch((error) => {
      process.stderr.write(
        `[plugins] Catalog consumer refresh failed: ${errorMessage(error)}\n`,
      );
    }),
  );
}

setPluginCatalogChangeListener(() => {
  invalidateBuiltInMarketplaceScanCache();
  invalidateCuratedMarketplaceScanCache();
  afterPluginMutationSettled(scheduleCatalogConsumerRefresh);
});

function readCache(): AnyPluginsCache | null {
  const result = readPluginCatalogHealth();
  return result.state === 'absent' ? null : result.data;
}

async function readCacheAsync(): Promise<AnyPluginsCache | null> {
  const result = await readPluginCatalogHealthAsync();
  return result.state === 'absent' ? null : result.data;
}

function validateCachePayload(cache: PluginsCache): PluginsCache {
  return normalizePluginCatalog(cache);
}

function writeCache(
  cache: PluginsCache,
  revalidatedLegacy = false,
  advanceProviderStamp = false,
  observation?: ReturnType<typeof observePluginCatalog>,
): Promise<PluginsCache> {
  return publishPluginCatalog(cache, {
    allowLegacy: revalidatedLegacy,
    advanceProviderStamp,
    observation,
  });
}

/**
 * Publish an index change with its catalog. When the index change only records
 * retirements, leak the unrecorded copies rather than fail the catalog change.
 * A changed binding still fails it.
 */
function publishCatalogRetiringCopies(
  index: PluginCacheIndex,
  cache: PluginsCache | undefined,
  bindingChanged: boolean,
): Promise<PluginsCache | undefined> {
  // One slot keeps the pair's errors unwrapped for the uncertainty check.
  return withCacheLock(async () => {
    const observation = observePluginCatalog();
    try {
      return (await publishPluginCachePair(index, cache, observation)).catalog;
    } catch (error) {
      if (bindingChanged) throw error;
      // An uncertain index install advanced the generation exactly once; any
      // other change since the observation is foreign and fails the change.
      const fence =
        error instanceof StorageOutcomeUnknownError
          ? { ...observation, generation: observation.generation + 1 }
          : observation;
      if (!isPluginCatalogObservationCurrent(fence)) throw error;
      process.stderr.write(
        `[plugins] Publishing the catalog without a confirmed index write; unrecorded retired copies stay on disk: ${errorMessage(error)}\n`,
      );
      return cache ? writeCache(cache, false, false, fence) : undefined;
    }
  });
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

async function readCacheIndex(
  knownIdentities?: ClaudeEntryIdentityLookup,
  knownCache?: AnyPluginsCache | null,
): Promise<PluginCacheIndex> {
  const result = readPluginIndexHealth();
  if (result.state === 'absent') return { version: 1, entries: {} };
  if (!result.recovered) return result.data;
  // A recovered index is refilled from the catalog's install facets, so the
  // next scan keeps installed plugins bound. The next index write persists it.
  const cache = knownCache === undefined ? await readCacheAsync() : knownCache;
  const entries = { ...result.data.entries };
  const identities =
    knownIdentities ?? (await readClaudeEntryIdentities(cache));
  for (const marketplace of cache?.version === 2 ? cache.marketplaces : []) {
    for (const plugin of marketplace.plugins) {
      const facet = plugin.facets.claude;
      const provenance = { ...plugin.provenance, ...facet?.provenance };
      // Redaction leaves '' for a URL it cannot parse.
      const sourceUrl = provenance.sourceUrl || facet?.externalSource?.url;
      const identity = resolveSourceClaudeEntryIdentity(
        identities,
        { ...result.data, entries },
        marketplace.id,
        plugin,
      );
      if (facet?.cachePath && sourceUrl && identity?.bindingOwned) {
        const entryName = identity.entryName;
        entries[cacheKey(marketplace.id, entryName)] ??= {
          cachePath: facet.cachePath,
          sourceUrl,
          cachedAt: facet.cachedAt ?? '',
          provenance: {
            ...provenance,
            sourceUrl: stripPluginSourceCredentials(sourceUrl),
            installedAt: provenance.installedAt ?? facet.cachedAt ?? '',
            installedName: provenance.installedName ?? facet.name,
            marketplaceEntryName: entryName,
            remoteSourceRestricted:
              facet.provenance?.remoteSourceRestricted ??
              plugin.provenance?.remoteSourceRestricted,
          },
        };
      }
    }
  }
  return { ...result.data, version: 1, entries };
}

function validateCacheIndexPayload(index: PluginCacheIndex): PluginCacheIndex {
  return normalizePluginCacheIndex(index);
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

/** Folded: matching a retirement against a kept copy may only keep more. */
function legacyCopyKey(cachePath: string): string {
  return pluginCopyProtectionIdentity(
    pluginCopyPathIdentity(cachePath) ?? cachePath,
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

function withCacheLock<T>(work: () => Promise<T> | T): Promise<T> {
  return updatePluginCatalog(work);
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

async function readCodexMarketplaceInstallSource(
  installedRoot: string | undefined,
): Promise<{ sourceUrl: string; sourceType: string } | null> {
  if (!installedRoot) {
    return null;
  }

  const evidence = await readPluginCopyJson(
    path.join(installedRoot, '.codex-marketplace-install.json'),
    isPluginCopyInstallMetadata,
  );
  const metadata = evidence.state === 'present' ? evidence.value : null;
  if (!isRecord(metadata) || typeof metadata.source !== 'string') return null;

  return {
    sourceUrl: normalizeMarketplaceSourceUrl(metadata.source),
    sourceType: normalizeMarketplaceSourceType(
      typeof metadata.source_type === 'string' ? metadata.source_type : 'codex',
      metadata.source,
    ),
  };
}

async function codexDiscoveredMarketplaceSource(
  entry: PluginMarketplaceEntry,
): Promise<CodexDiscoveredMarketplaceSource> {
  const installedRoot = codexMarketplaceRootFromPath(entry.path) ?? undefined;
  const installedSource =
    await readCodexMarketplaceInstallSource(installedRoot);
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

function isKnownMarketplacesEvidence(
  value: unknown,
): value is KnownMarketplacesFile {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        isRecord(entry) &&
        isRecord(entry.source) &&
        typeof entry.source.source === 'string' &&
        typeof entry.installLocation === 'string',
    )
  );
}

/**
 * Mutation-path identity read. `complete` is false when the registry exists
 * but could not be read as an object.
 */
async function readKnownMarketplacesRegistry(): Promise<{
  known: Record<string, unknown>;
  complete: boolean;
}> {
  try {
    const parsed = await readClaudeRegistryJson(getKnownMarketplacesPath());
    return isRecord(parsed)
      ? { known: parsed, complete: true }
      : { known: {}, complete: false };
  } catch (error) {
    return {
      known: {},
      complete: isErrnoException(error) && error.code === 'ENOENT',
    };
  }
}

/** Discovery read; it also enrols the registry as sweep evidence during a refresh. */
async function readKnownMarketplacesForDiscovery(): Promise<KnownMarketplacesFile> {
  const evidence = await readPluginCopyJson(
    getKnownMarketplacesPath(),
    isKnownMarketplacesEvidence,
  );
  if (evidence.state === 'present') return evidence.value;
  if (evidence.state === 'absent') return {};
  // A registry the evidence check rejects keeps the legacy recovery read.
  const recovered = await safeReadJsonAsync<KnownMarketplacesFile>(
    getKnownMarketplacesPath(),
  );
  return isRecord(recovered) ? recovered : {};
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

function priorClaudeInstallationOwners(
  marketplaceId: string,
  previousMarketplaces: readonly MarketplaceInfo[],
  identities: ClaudeEntryIdentityLookup,
  cacheIndex: PluginCacheIndex,
): ReadonlyMap<string, PluginInfo | undefined> {
  // Resolve installation owners once per scan, not for every uninstalled entry.
  const owners = new Map<string, PluginInfo | undefined>();
  for (const marketplace of previousMarketplaces) {
    if (marketplace.id !== marketplaceId) continue;
    for (const plugin of marketplace.plugins) {
      // Uninstalled rows cannot own history or make installation ownership ambiguous.
      if (
        !plugin.facets.claude ||
        (plugin.facets.claude.provenance?.sourceUrl === undefined &&
          plugin.provenance?.sourceUrl === undefined)
      )
        continue;
      const identity = resolveSourceClaudeEntryIdentity(
        identities,
        cacheIndex,
        marketplaceId,
        plugin,
      );
      if (identity)
        owners.set(
          identity.entryName,
          owners.has(identity.entryName) ? undefined : plugin,
        );
    }
  }
  return owners;
}

async function readClaudePluginFacet(args: {
  marketplaceId: string;
  marketplaceInstallDir: string;
  pluginEntry: MarketplaceManifest['plugins'][number];
  cacheIndex: PluginCacheIndex;
  identities: ClaudeEntryIdentityLookup;
  priorInstallationOwners: ReadonlyMap<string, PluginInfo | undefined>;
}): Promise<PluginProviderFacet | null> {
  const {
    marketplaceId,
    marketplaceInstallDir,
    pluginEntry,
    cacheIndex,
    identities,
    priorInstallationOwners,
  } = args;
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
  let provenance: PluginProviderFacet['provenance'];
  let sourceChanged: boolean | undefined;

  if (sourcePath) {
    pluginDir = path.resolve(marketplaceInstallDir, sourcePath);
    if (!isPathInside(resolvedRoot, pluginDir)) {
      return null;
    }
    pluginManifest = safeReadJson<PluginManifest>(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    );
  } else if (typeof externalSource?.url === 'string') {
    const binding =
      cacheIndex.entries[cacheKey(marketplaceId, pluginEntry.name)];
    const identity = resolveClaudeEntryIdentity(
      identities,
      marketplaceId,
      { entryName: pluginEntry.name },
      cacheIndex,
    );
    const entryName = identity?.bindingOwned ? identity.entryName : undefined;
    const cached =
      identity?.bindingOwned !== true ||
      (binding?.provenance?.marketplaceEntryName !== undefined &&
        binding.provenance.marketplaceEntryName !== pluginEntry.name)
        ? undefined
        : binding;
    // Only an owned index wins partial publication. A slot a colliding entry
    // holds must not undo a published catalog install.
    const prior = cached
      ? undefined
      : priorInstallationOwners.get(pluginEntry.name);
    if (cached) {
      provenance = {
        ...cached.provenance,
        installedAt: cached.provenance?.installedAt ?? cached.cachedAt,
        ...(entryName === undefined ? {} : { marketplaceEntryName: entryName }),
        sourceUrl: stripPluginSourceCredentials(
          cached.provenance?.sourceUrl ?? cached.sourceUrl,
        ),
      };
    } else if (prior) {
      const recorded = {
        ...prior.provenance,
        ...prior.facets.claude?.provenance,
      };
      if (recorded.sourceUrl !== undefined) {
        provenance = {
          ...recorded,
          sourceUrl: stripPluginSourceCredentials(recorded.sourceUrl),
          installedAt: recorded.installedAt ?? '',
          ...(entryName === undefined
            ? {}
            : { marketplaceEntryName: entryName }),
        };
        const priorCopy = prior.facets.claude?.cachePath ?? prior.cachePath;
        // The loser of a shared slot keeps its copy. It goes metadata-only, with
        // its bytes left on disk, once the winner's marketplace removal unbinds
        // the slot, or at once when its row recorded no source (legacy); only a
        // copy the winner's Update retired is swept. Develop deleted those bytes
        // when the winner took the slot. Accepted: revisit if users hit it.
        if (
          identity?.bindingOwned === false &&
          priorCopy &&
          (await fs.promises.stat(priorCopy).then(
            (stat) => stat.isDirectory(),
            () => false,
          ))
        ) {
          pluginDir = priorCopy;
          cachePath = priorCopy;
          cachedAt = prior.facets.claude?.cachedAt ?? prior.cachedAt;
          pluginManifest = safeReadJson<PluginManifest>(
            path.join(priorCopy, '.claude-plugin', 'plugin.json'),
          );
        }
      }
    }
    if (provenance)
      sourceChanged =
        matchPluginSources(
          provenance.sourceUrl,
          externalSource.url,
          provenance.sourceIdentityComplete === true,
        ) === 'different';
    // Resolution alone verifies kept copies, so a same-source refresh cannot
    // drop the path that later keeps a damaged copy through source drift.
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
    // A row without bytes keeps its entry name: an installed alias could name
    // another entry and merge both rows.
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
    provenance,
    sourceChanged,
    details,
  };
}

async function scanClaudeMarketplace(input: {
  id: string;
  entry: KnownMarketplaceEntry | null;
  claudeEntryIdentities?: ClaudeEntryIdentityLookup;
  catalog?: AnyPluginsCache | null;
}): Promise<{
  facets: PluginProviderFacet[];
  status: MarketplaceProviderStatus;
  name?: string;
  description?: string;
  ownerName?: string;
  sourceUrl?: string;
  installLocation?: string;
  lastUpdated?: string;
}> {
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
  const manifest = await readRegisteredClaudeMarketplaceManifest(manifestPath);
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

  const catalog =
    input.catalog === undefined ? await readCacheAsync() : input.catalog;
  const identities = indexClaudeEntryIdentities([
    ...(
      input.claudeEntryIdentities ?? (await readClaudeEntryIdentities(catalog))
    ).entries,
    ...claudeManifestIdentities(id, manifest),
  ]);
  const cacheIndex = await readCacheIndex(identities, catalog);
  const priorInstallationOwners = priorClaudeInstallationOwners(
    id,
    catalog?.version === 2 ? catalog.marketplaces : [],
    identities,
    cacheIndex,
  );
  const facets = (
    await mapWithConcurrency(
      manifest.plugins,
      MARKETPLACE_REFRESH_CONCURRENCY,
      (pluginEntry) =>
        readClaudePluginFacet({
          marketplaceId: id,
          marketplaceInstallDir: entry.installLocation,
          pluginEntry,
          cacheIndex,
          identities,
          priorInstallationOwners,
        }),
    )
  ).filter((facet): facet is PluginProviderFacet => facet !== null);

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
    ownerName: manifestText(manifest.owner?.name)?.trim() || undefined,
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
    if (marketplaceName === getCuratedPluginMarketplaceName()) {
      const error = managedMarketplaceLoadError(list, marketplaceName);
      if (error) return { available: true, installed: false, version, error };
    }
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
    // First install registers Codex. Absence without a load error is known
    // uninstalled; an existing marketplace omitting this plugin is incomplete.
    if (
      marketplaceName === getCuratedPluginMarketplaceName() &&
      marketplace &&
      !summary
    ) {
      return {
        available: true,
        installed: false,
        version,
        error: 'Incomplete curated Codex plugin listing.',
      };
    }
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
  if (marketplaceName === getCuratedPluginMarketplaceName()) {
    await resolveCuratedActiveRoots(pluginsWithStatus, codexPluginListResult);
  }
  return carryOverBuiltInPluginInstallErrors(pluginsWithStatus);
}

/** Claude reports readFromFolder; Codex executes its installed cache copy.
 * Never infer installed revisions from plugin/read or marketplace source paths,
 * or borrow a path after a failed/partial listing.
 */
async function resolveCuratedActiveRoots(
  plugins: PluginInfo[],
  codexResult: CodexPluginListResult | undefined,
): Promise<void> {
  const name = getCuratedPluginMarketplaceName();
  const root = path.resolve(getCuratedPluginsMarketplaceDir());
  let claudeRows: unknown;
  let claudeError: string | undefined;
  if (plugins.some((plugin) => plugin.globalInstallStatus?.claude?.installed)) {
    try {
      claudeRows = await readCuratedClaudeListings();
    } catch (error) {
      claudeError = errorMessage(error);
    }
  }
  const codexMarketplace = codexResult?.success
    ? codexResult.data.marketplaces.find((entry) => entry.name === name)
    : undefined;
  const codexRoot =
    codexMarketplace && codexMarketplaceRootFromPath(codexMarketplace.path);
  const codexInstalledRoots =
    codexRoot && (await sameExistingPluginRoot(codexRoot, root))
      ? await readCuratedCodexInstalledRoots(
          name,
          codexMarketplace?.plugins.filter((entry) => entry.installed) ?? [],
        ).catch(() => new Map<string, string>())
      : new Map<string, string>();
  for (const plugin of plugins) {
    const expected = path.join(root, plugin.name);
    const claude = plugin.globalInstallStatus?.claude;
    if (claude?.installed && !claude.error) {
      const row: unknown = Array.isArray(claudeRows)
        ? claudeRows.find(
            (value: unknown) =>
              isRecord(value) &&
              value.id === `${plugin.name}@${name}` &&
              isUserScopedInstall(value),
          )
        : undefined;
      if (claudeError || !isRecord(row)) {
        claude.error = claudeError ?? 'Incomplete Claude plugin listing.';
      } else if (typeof row.readFromFolder === 'string') {
        if (await sameExistingPluginRoot(row.readFromFolder, expected))
          claude.installPath = expected;
        else
          claude.error =
            'The curated Claude plugin source does not match its managed folder.';
      }
      // Older CLIs omit readFromFolder: keep their recorded installPath.
    }
    const codex = plugin.globalInstallStatus?.codex;
    if (codex?.installed && !codex.error) {
      const summary = codexMarketplace?.plugins.find(
        (entry) => entry.name === plugin.name && entry.installed,
      );
      if (
        codexRoot &&
        (await sameExistingPluginRoot(codexRoot, root)) &&
        summary?.source.type === 'local' &&
        (await sameExistingPluginRoot(
          path.resolve(root, summary.source.path),
          expected,
        ))
      ) {
        // Unresolved runtime evidence suppresses artwork, not known install state.
        codex.installPath = codexInstalledRoots.get(plugin.name);
      } else
        codex.error =
          'The curated Codex plugin source is unavailable or incomplete.';
    }
  }
}

async function sameExistingPluginRoot(
  left: string,
  right: string,
): Promise<boolean> {
  try {
    const [actual, expected] = await Promise.all([
      fs.promises.realpath(left),
      fs.promises.realpath(right),
    ]);
    return actual === expected;
  } catch {
    return false;
  }
}

async function readCuratedClaudeListings(): Promise<unknown[]> {
  const root = path.resolve(getCuratedPluginsMarketplaceDir());
  if (
    claudeRegisteredMarketplaceRoot(
      await readKnownMarketplacesForDiscovery(),
      getCuratedPluginMarketplaceName(),
    ) !== root
  )
    throw new Error(
      'The curated Claude marketplace registration is unavailable.',
    );
  const result = await runClaudeCliProcessOffMain({
    command: getBundledClaudeBinaryPath(),
    args: ['plugin', 'list', '--json'],
    env: getEnhancedEnv(),
    timeoutMs: PLUGIN_CLI_TIMEOUT_MS,
  });
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows))
    throw new Error('Incomplete Claude plugin listing.');
  return rows.map((value: unknown) => value);
}

/** Older Claude releases may actually load installPath. Let that provider
 * refresh its own copy; never edit caches, uninstall, or change enabled state.
 * Current local installs explicitly report readFromFolder and need no refresh.
 */
async function refreshLegacyCuratedClaudeCopies(): Promise<void> {
  const rows = await readCuratedClaudeListings();
  const marketplaceName = getCuratedPluginMarketplaceName();
  const manifest = await readClaudeMarketplaceManifest(
    path.join(
      getCuratedPluginsMarketplaceDir(),
      '.claude-plugin',
      'marketplace.json',
    ),
  );
  for (const entry of manifest?.plugins ?? []) {
    const id = `${entry.name}@${marketplaceName}`;
    const row = rows.find(
      (value) =>
        isRecord(value) && value.id === id && isUserScopedInstall(value),
    );
    if (!isRecord(row) || typeof row.readFromFolder === 'string') continue;
    const installedRoot = installPathOf(row);
    if (!installedRoot) continue;
    const relative = path.join('.claude-plugin', 'canopy-display.json');
    const staged = safeReadJson<unknown>(
      path.join(getCuratedPluginsMarketplaceDir(), entry.name, relative),
    );
    if (
      !staged ||
      JSON.stringify(staged) ===
        JSON.stringify(
          safeReadJson<unknown>(path.join(installedRoot, relative)),
        )
    )
      continue;
    await execPluginCli(
      getBundledClaudeBinaryPath(),
      ['plugin', 'update', id, '--scope', 'user'],
      getEnhancedEnv(),
    );
  }
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
async function carryOverBuiltInPluginInstallErrors(
  plugins: PluginInfo[],
): Promise<PluginInfo[]> {
  const cache = await readCacheAsync();
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
      const current = status[provider];
      const prior = before[provider];
      if (
        isCuratedPluginMarketplaceId(plugin.marketplaceId) &&
        current?.error &&
        prior?.installed
      ) {
        next[provider] = { ...prior, error: current.error };
        changed = true;
        continue;
      }
      const installError = before[provider]?.installError;
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
  observation: ReturnType<typeof observePluginCatalog>;
  marketplace: MarketplaceInfo | null;
} | null = null;
let builtInScanGeneration = 0;

function invalidateBuiltInMarketplaceScanCache(): void {
  builtInScanGeneration += 1;
  builtInMarketplaceScanCache = null;
}

/**
 * @internal — exposed for testing only. Resets every locally managed
 * marketplace scan memo (built-in and curated).
 */
export function resetBuiltInMarketplaceScanCacheForTests(): void {
  invalidateBuiltInMarketplaceScanCache();
  invalidateCuratedMarketplaceScanCache();
}

/** A catalog read shared by one discovery pass's managed marketplace scans. */
interface ManagedScanSnapshot {
  catalog: AnyPluginsCache | null;
  /** From `pluginCatalogReadValidator`, taken before the catalog read. */
  isCurrent: () => boolean;
  claudeEntryIdentities?: ClaudeEntryIdentityLookup;
}

/** Scans retry after catalog writes; a retry rereads rather than reuse a stale read. */
function currentManagedScanSnapshot(
  snapshot: ManagedScanSnapshot | undefined,
): ManagedScanSnapshot | undefined {
  return snapshot?.isCurrent() ? snapshot : undefined;
}

async function scanBuiltInMarketplace(
  snapshot?: ManagedScanSnapshot,
): Promise<MarketplaceInfo | null> {
  if (
    builtInMarketplaceScanCache &&
    isPluginCatalogObservationCurrent(
      builtInMarketplaceScanCache.observation,
    ) &&
    Date.now() - builtInMarketplaceScanCache.scannedAt <
      BUILTIN_MARKETPLACE_SCAN_TTL_MS
  ) {
    // Clone so downstream merge/overlay steps can never mutate the cache.
    return structuredClone(builtInMarketplaceScanCache.marketplace);
  }
  for (;;) {
    const generation = builtInScanGeneration;
    const observation = observePluginCatalog();
    const current = currentManagedScanSnapshot(snapshot);
    const marketplace = await scanBuiltInMarketplaceUncached(
      current?.claudeEntryIdentities,
      current?.catalog,
    );
    if (
      generation !== builtInScanGeneration ||
      !isPluginCatalogObservationCurrent(observation)
    )
      continue;
    builtInMarketplaceScanCache = {
      scannedAt: Date.now(),
      marketplace,
      observation,
    };
    return structuredClone(marketplace);
  }
}

async function scanBuiltInMarketplaceUncached(
  claudeEntryIdentities?: ClaudeEntryIdentityLookup,
  knownCatalog?: AnyPluginsCache | null,
): Promise<MarketplaceInfo | null> {
  const claudeManifestPath = getBundledClaudePluginMarketplaceManifestPath();
  const [claudeManifest, codexManifest] = await Promise.all([
    readClaudeMarketplaceManifest(claudeManifestPath),
    readCodexMarketplaceManifest(
      getBundledCodexPluginMarketplaceManifestPath(),
    ),
  ]);
  const catalog =
    knownCatalog === undefined ? await readCacheAsync() : knownCatalog;
  const identities = indexClaudeEntryIdentities([
    ...(claudeEntryIdentities ?? (await readClaudeEntryIdentities(catalog)))
      .entries,
    ...claudeManifestIdentities(BUILTIN_PLUGIN_MARKETPLACE_ID, claudeManifest),
  ]);
  const cacheIndex = await readCacheIndex(identities, catalog);
  const hasClaudeManifest = !!claudeManifest;
  const hasCodexManifest = !!codexManifest;
  if (!hasClaudeManifest && !hasCodexManifest) {
    return null;
  }
  const priorInstallationOwners = priorClaudeInstallationOwners(
    BUILTIN_PLUGIN_MARKETPLACE_ID,
    catalog?.version === 2 ? catalog.marketplaces : [],
    identities,
    cacheIndex,
  );
  const claudeFacets =
    claudeManifest && Array.isArray(claudeManifest.plugins)
      ? (
          await mapWithConcurrency(
            claudeManifest.plugins,
            MARKETPLACE_REFRESH_CONCURRENCY,
            (pluginEntry) =>
              readClaudePluginFacet({
                marketplaceId: BUILTIN_PLUGIN_MARKETPLACE_ID,
                marketplaceInstallDir: getBundledPluginsDir(),
                pluginEntry,
                cacheIndex,
                identities,
                priorInstallationOwners,
              }),
          )
        ).filter((facet): facet is PluginProviderFacet => facet !== null)
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
  snapshot?: ManagedScanSnapshot,
): Promise<MarketplaceInfo[]> {
  const scanned = await scanBuiltInMarketplace(snapshot);
  const withoutBuiltIn = marketplaces.filter(
    (marketplace) => marketplace.id !== BUILTIN_PLUGIN_MARKETPLACE_ID,
  );
  return scanned ? [...withoutBuiltIn, scanned] : withoutBuiltIn;
}

async function readCuratedClaudeFacets(
  {
    marketplaceId,
    marketplaceInstallDir,
    pluginEntries,
  }: Parameters<CuratedMarketplaceScanDeps['readClaudeFacets']>[0],
  claudeEntryIdentities?: ClaudeEntryIdentityLookup,
  knownCatalog?: AnyPluginsCache | null,
): Promise<PluginProviderFacet[]> {
  const catalog =
    knownCatalog === undefined ? await readCacheAsync() : knownCatalog;
  const identities = indexClaudeEntryIdentities([
    ...(claudeEntryIdentities ?? (await readClaudeEntryIdentities(catalog)))
      .entries,
    ...claudeManifestIdentities(marketplaceId, { plugins: pluginEntries }),
  ]);
  const cacheIndex = await readCacheIndex(identities, catalog);
  const priorInstallationOwners = priorClaudeInstallationOwners(
    marketplaceId,
    catalog?.version === 2 ? catalog.marketplaces : [],
    identities,
    cacheIndex,
  );
  const facets = await mapWithConcurrency(
    pluginEntries,
    MARKETPLACE_REFRESH_CONCURRENCY,
    (pluginEntry) =>
      readClaudePluginFacet({
        marketplaceId,
        marketplaceInstallDir,
        pluginEntry,
        cacheIndex,
        identities,
        priorInstallationOwners,
      }),
  );
  return facets.filter((facet): facet is PluginProviderFacet => facet !== null);
}

/**
 * Scan primitives handed to `curated-plugin-marketplace.ts`. They are passed
 * in rather than imported there so this module stays the only side of that
 * relationship with an import (see that module's header).
 */
const curatedMarketplaceScanDeps: CuratedMarketplaceScanDeps = {
  readClaudeFacets: readCuratedClaudeFacets,
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
  snapshot: ManagedScanSnapshot,
): Promise<MarketplaceInfo[]> {
  return mergeCuratedMarketplace(
    await mergeBuiltInMarketplace(marketplaces, snapshot),
    {
      ...curatedMarketplaceScanDeps,
      readClaudeFacets: (input) => {
        const current = currentManagedScanSnapshot(snapshot);
        return readCuratedClaudeFacets(
          input,
          current?.claudeEntryIdentities,
          current?.catalog,
        );
      },
    },
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
  const { value: marketplace, observation } = await withPluginCatalogScan(() =>
    scanCuratedMarketplace(curatedMarketplaceScanDeps),
  );
  await withCacheLock(async () => {
    assertPluginCatalogObservation(observation);
    const latestCache = readCache();
    if (!latestCache) {
      if (!marketplace) return;
      // Cache-only onboarding reads need the newly materialized curated row
      // even before the first full marketplace discovery. Keep the refresh
      // stamp empty so the normal load path still performs that discovery
      // instead of treating this curated-only bootstrap cache as complete.
      await writeCache(
        {
          version: 2,
          lastRefreshed: '',
          marketplaces: [marketplace],
        },
        false,
        false,
        observation,
      );
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
    await writeCache(
      {
        ...baseCache,
        lastRefreshed: baseCache.lastRefreshed,
        marketplaces,
      },
      false,
      false,
      observation,
    );
  });
}

/** Drops the scan memo of whichever managed marketplace `marketplaceId` names. */
function invalidateManagedMarketplaceScanCache(marketplaceId: string): void {
  if (isCuratedPluginMarketplaceId(marketplaceId)) {
    invalidateCuratedMarketplaceScanCache();
    return;
  }
  invalidateBuiltInMarketplaceScanCache();
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
  invalidateBuiltInMarketplaceScanCache();
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
        provenance: facets.claude?.provenance ?? facets.codex?.provenance,
        sourceChanged:
          facets.claude?.sourceChanged ?? facets.codex?.sourceChanged,
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
  claudeEntryIdentities?: ClaudeEntryIdentityLookup;
  catalog?: AnyPluginsCache | null;
}): Promise<MarketplaceInfo> {
  const claude = await scanClaudeMarketplace({
    id: input.id,
    entry: input.knownEntry,
    claudeEntryIdentities: input.claudeEntryIdentities,
    catalog: input.catalog,
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
    ...(claude.ownerName ? { ownerName: claude.ownerName } : {}),
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
  const known = await readKnownMarketplacesForDiscovery();
  const isCatalogCurrent = pluginCatalogReadValidator();
  const cache = await readCacheAsync();
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
      const discovered = await codexDiscoveredMarketplaceSource(entry);
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

  const checkedSources = await mapWithConcurrency(
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
      return { source, recheck };
    },
  );
  // Rechecks may change manifests; share identities and the existing catalog snapshot.
  const claudeEntryIdentities = await readClaudeEntryIdentities(cache);
  const marketplaces = await mapWithConcurrency(
    checkedSources,
    MARKETPLACE_REFRESH_CONCURRENCY,
    async ({ source, recheck }) => {
      const refreshedKnown = await readKnownMarketplacesForDiscovery();
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
        claudeEntryIdentities,
        catalog: cache,
      });
    },
  );
  return mergeManagedMarketplaces(marketplaces, {
    catalog: cache,
    isCurrent: isCatalogCurrent,
    claudeEntryIdentities,
  });
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
    changed = false;
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
    const isCatalogCurrent = pluginCatalogReadValidator();
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
        { catalog: cache, isCurrent: isCatalogCurrent },
      );
      const nextCache: PluginsCache = {
        ...cache,
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
async function refreshInstalledPluginCatalogUnlocked(
  marketplaceId: string,
): Promise<void> {
  const cached = readCache();
  if (cached?.version !== 2 || !cached.lastRefreshed) return;
  invalidateManagedMarketplaceScanCache(marketplaceId);
  const { value: refreshed, observation } = await withPluginCatalogScan(() =>
    loadMarketplacesWithoutDefaults(),
  );
  if (!refreshed.success || !refreshed.data)
    throw new Error('Installed plugin catalog could not be refreshed.');
  const marketplace = refreshed.data.marketplaces.find(
    (row) => row.id === marketplaceId,
  );
  if (!marketplace) return;
  await withCacheLock(async () => {
    assertPluginCatalogObservation(observation);
    const latest = readCache();
    if (latest?.version !== 2) return;
    await writeCache(
      {
        ...latest,
        marketplaces: latest.marketplaces.map((row) =>
          row.id === marketplaceId ? marketplace : row,
        ),
      },
      false,
      false,
      observation,
    );
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

async function shouldRunProviderUpdates(
  options: RefreshMarketplacesOptions | undefined,
): Promise<boolean> {
  if ((options?.providerUpdates ?? 'if-stale') === 'always') {
    return true;
  }
  const cache = await readCacheAsync();
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
      await readKnownMarketplacesForDiscovery(),
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
    if (
      updated.accepted &&
      marketplaceName === getCuratedPluginMarketplaceName()
    ) {
      await refreshLegacyCuratedClaudeCopies();
      invalidateCuratedMarketplaceScanCache();
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
    return await runSerializedPluginMutation(() =>
      withMarketplaceRefreshLock(() =>
        syncCuratedPluginsForRefreshUnlocked(options),
      ),
    );
  } catch (error) {
    process.stderr.write(
      `[plugins] Curated plugin sync failed: ${errorMessage(error)}\n`,
    );
    return null;
  }
}

async function syncCuratedPluginsForRefreshUnlocked(options?: {
  force?: boolean;
  providerNudge?: 'await' | 'background';
}): Promise<CuratedPluginSyncResult | null> {
  try {
    await assertCatalogHealthAsync();
    const result = await withPluginEffects(() => syncCuratedPlugins(options));
    await assertCatalogHealthAsync();
    if (result.status === 'synced') invalidateCuratedMarketplaceScanCache();
    // A no-op sync can be an existing user's first run with curated defaults.
    if (result.status !== 'skipped') {
      const marketplace = await scanCuratedMarketplace(
        curatedMarketplaceScanDeps,
      );
      if (marketplace) await initializeCuratedPluginDefaults([marketplace]);
    }
    if (result.status !== 'skipped') {
      const refreshed = await withPluginEffects(() =>
        refreshCuratedCodexPlugins(
          getCuratedPluginMarketplaceName(),
          getCuratedPluginsMarketplaceDir(),
        ),
      ).catch((error) => {
        process.stderr.write(
          `[plugins] Curated Codex refresh deferred: ${errorMessage(error)}\n`,
        );
      });
      if (refreshed) {
        invalidateCuratedMarketplaceScanCache();
        await persistCuratedMarketplaceAfterSync();
      }
    }
    if (result.status !== 'synced') return result;
    await persistCuratedMarketplaceAfterSync();
    const nudgeProvider = async (): Promise<void> => {
      await nudgeManagedProviderMarketplace(
        getCuratedPluginMarketplaceName(),
        'curated',
      );
      invalidateCuratedMarketplaceScanCache();
      await persistCuratedMarketplaceAfterSync();
    };
    if (options?.providerNudge === 'background') {
      trackDetachedWork(() =>
        providerRevalidation.run(false, () =>
          enqueueDetachedPluginMutation(() =>
            withMarketplaceRefreshLock(nudgeProvider),
          ).catch((error) => {
            process.stderr.write(
              `[plugins] Failed to refresh the curated marketplace: ${errorMessage(error)}\n`,
            );
          }),
        ),
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
    return await runSerializedPluginMutation(() =>
      withMarketplaceRefreshLock(() =>
        providerRevalidation.run(true, () => {
          const evidence = openPluginCopySweepEvidence({
            marketplaceName: getCuratedPluginMarketplaceName(),
            manifestPath: curatedCodexManifestPath(),
          });
          return pluginCopyProviderEvidence.run(evidence, async () => {
            try {
              assertCatalogHealth({ allowLegacy: true });
              return await refreshMarketplacesUnlocked(progress, options);
            } finally {
              // Detached children must not reuse a completed refresh's proof.
              evidence.closed = true;
            }
          });
        }),
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
    // Enroll provider files before discovery/publication can reduce or replace them.
    await Promise.all([
      readPluginCatalogHealthAsync(),
      readPluginIndexHealthAsync(),
      readClaudeMarketplaceRegistryEvidence(getKnownMarketplacesPath()),
      readPluginCopyProviderFile(getClaudeInstalledPluginsPath()),
    ]);
    const providerUpdates = await shouldRunProviderUpdates(options);
    const curatedSync = await syncCuratedPluginsForRefreshUnlocked();
    if (providerUpdates) {
      // Nudge before the scan, mirroring the source loop's update-then-scan
      // ordering in `recheckMarketplaceProviders`.
      await nudgeManagedProviderMarketplaces({
        skipCurated: curatedSync?.status === 'synced',
      });
    }
    const { value: marketplaces, observation } = await withPluginCatalogScan(
      () =>
        buildMarketplaces(progress, {
          providerUpdates,
        }),
    );
    const result = await withCacheLock<IPCResult<PluginsCache>>(async () => {
      const previousCache = await readCacheAsync();
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
      const committed = await writeCache(
        cache,
        true,
        providerUpdates,
        observation,
      );
      return { success: true, data: committed };
    });
    if (!result.success) {
      return result;
    }
    if (admitsPluginCopySweep()) await sweepRetiredPluginCopies();
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
    const result = await runSerializedPluginMutation(() =>
      addMarketplaceUnlocked(...args),
    );
    assertCatalogHealth();
    return result;
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error),
      ...reportInstallFailure(error, 'plugin.marketplace.add'),
    };
  }
}

async function addMarketplaceUnlocked(
  repo: string,
  progress?: MarketplaceProgressReporter,
): Promise<IPCResultWithAppError<MarketplaceRegistrationResult>> {
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
  const known = await readKnownMarketplacesForDiscovery();
  const knownMatch = findKnownMarketplaceBySource(known, sourceUrl);
  const { value: marketplace, observation } = await withPluginCatalogScan(() =>
    assembleMarketplace({
      id: knownMatch?.id ?? id,
      sourceUrl,
      knownEntry: knownMatch?.entry ?? null,
      claudeResult: claudeAdd,
      codexAddResult: codexAdd,
    }),
  );

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
  const committedMarketplace = await withCacheLock(async () => {
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
    const committed = await writeCache(nextCache, false, false, observation);
    return (
      committed.marketplaces.find((entry) => entry.id === marketplace.id) ??
      marketplace
    );
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
      marketplace: committedMarketplace,
      providerOutcomes: committedMarketplace.providerStatus,
    },
  };
}

async function updateMarketplaceUnlocked(
  id: string,
  progress?: MarketplaceProgressReporter,
): Promise<IPCResultWithAppError<MarketplaceInfo>> {
  try {
    assertCatalogHealth();
    if (isCuratedPluginMarketplaceId(id)) {
      return {
        success: false,
        error: `The curated marketplace is managed by ${BRAND.displayName} and updates automatically.`,
      };
    }
    if (id === BUILTIN_PLUGIN_MARKETPLACE_ID) {
      const { value: marketplace, observation } = await withPluginCatalogScan(
        scanBuiltInMarketplace,
      );
      if (!marketplace) {
        return {
          success: false,
          error: 'Built-in marketplace resources were not found.',
        };
      }
      const committedMarketplace = await withCacheLock(async () => {
        const latestCache = readCache();
        const marketplaces =
          latestCache?.version === 2
            ? latestCache.marketplaces.filter((entry) => entry.id !== id)
            : [];
        marketplaces.push(marketplace);
        const committed = await writeCache(
          {
            version: 2,
            lastRefreshed: nowIso(),
            marketplaces,
          },
          false,
          false,
          observation,
        );
        return (
          committed.marketplaces.find((entry) => entry.id === id) ?? marketplace
        );
      });
      return { success: true, data: committedMarketplace };
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
    const known = await readKnownMarketplacesForDiscovery();
    const knownMatch =
      (existing
        ? findKnownMarketplaceBySource(known, existing.sourceUrl)
        : null) ?? (known[id] ? { id, entry: known[id] } : null);
    if (!existing && !knownMatch) {
      return { success: false, error: 'Marketplace not found.' };
    }
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
    const refreshedKnown = await readKnownMarketplacesForDiscovery();
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
    const { value: marketplace, observation } = await withPluginCatalogScan(
      () =>
        assembleMarketplace({
          id,
          sourceUrl,
          sourceType: existing?.sourceType,
          knownEntry: refreshedKnownMatch?.entry ?? knownMatch?.entry ?? null,
          codexMarketplaceName:
            existing?.providerStatus.codex.marketplaceName ?? existing?.name,
          codexInstalledRoot: existing?.providerStatus.codex.installLocation,
          claudeResult: claudeUpdate,
          codexAddResult: codexUpdateWithStructuralState,
        }),
    );
    reportMarketplaceProgress(progress, 'update', {
      status: 'running',
      currentStep: 3,
      totalSteps: 3,
      marketplaceId: id,
      repo: sourceUrl,
      message: 'Saving refreshed marketplace...',
    });
    let savedMarketplace = marketplace;
    await withCacheLock(async () => {
      const latestCache = readCache();
      const marketplaces =
        latestCache?.version === 2
          ? latestCache.marketplaces.filter((entry) => entry.id !== id)
          : [];
      savedMarketplace =
        mergePreservedCacheState([marketplace], latestCache)[0] ?? marketplace;
      marketplaces.push(savedMarketplace);
      const committed = await writeCache(
        {
          version: 2,
          lastRefreshed: nowIso(),
          marketplaces,
        },
        false,
        false,
        observation,
      );
      savedMarketplace =
        committed.marketplaces.find((entry) => entry.id === id) ??
        savedMarketplace;
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
    return {
      success: false,
      error: errorMessage(error),
      ...reportInstallFailure(error, 'plugin.marketplace.update'),
    };
  }
}

export async function updateMarketplace(
  id: string,
  progress?: MarketplaceProgressReporter,
): Promise<IPCResultWithAppError<MarketplaceInfo>> {
  try {
    const result = await runSerializedPluginMutation(async () => {
      const before = await readClaudeEntryIdentities().catch(() => undefined);
      return withMarketplaceRefreshLock(() =>
        updateMarketplaceUnlocked(id, progress),
      ).finally(async () => {
        const after = await readClaudeEntryIdentities().catch(() => undefined);
        for (const entry of [
          ...(before?.entries ?? []),
          ...(after?.entries ?? []),
        ])
          if (entry.marketplaceId === id)
            notePluginUserMutation(id, entry.entryName);
      });
    });
    assertCatalogHealth();
    return result;
  } catch (error) {
    reportMarketplaceProgress(progress, 'update', {
      status: 'error',
      marketplaceId: id,
      message: errorMessage(error),
    });
    return {
      success: false,
      error: errorMessage(error),
      ...reportInstallFailure(error, 'plugin.marketplace.update'),
    };
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

async function safeReadDir(
  target: string,
  onFailure: 'best-effort' | 'throw' = 'best-effort',
): Promise<fs.Dirent<string>[]> {
  try {
    return await fs.promises.readdir(target, {
      encoding: 'utf8',
      withFileTypes: true,
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    if (onFailure === 'throw') throw error;
    process.stderr.write(
      `[plugins] safeReadDir(${target}) failed: ${errorMessage(error)}\n`,
    );
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
  workspaceDiscovery: 'best-effort' | 'throw',
): Promise<void> {
  const workspacesRoot = path.join(getDataDir(), 'workspaces');
  const entries = await safeReadDir(workspacesRoot, workspaceDiscovery);
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

async function collectSelectionPruneTargets(
  workspaceDiscovery: 'best-effort' | 'throw' = 'best-effort',
): Promise<SelectionPruneTargets> {
  // Callers prune preferences and pipeline preferences through their stores;
  // the generic file loops must never receive their paths (admitted writers,
  // CAN-5152 and CAN-4480).
  const targets = new Set<SelectionPruneTarget>();
  const chatScopes: CanonicalChatScopePruneTarget[] = [];
  await settleAll([
    addWorkspaceSelectionPruneTargets(targets, chatScopes, workspaceDiscovery),
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

/**
 * Prunes one installed item from a workspace's `workspace.json`. Discovery
 * lists every folder under `workspaces/`, including leftovers that never had
 * a manifest (`default`, `standalone-chat`, old Cowork scopes). A project can
 * hold a manifest reference only through its manifest, so one that is absent
 * when read inside the write queue (refused `not-found`, also when it was
 * removed after discovery) holds nothing to prune and must not block the
 * removal. Every other failure, an unreadable or unsupported manifest
 * included, still fails the prune: it may hold a reference. The folder's chat
 * files and scopes are separate targets and are still pruned.
 */
async function pruneInstalledItemInWorkspaceConfig(
  workspaceId: string,
  ref: InstalledItemRef,
): Promise<void> {
  try {
    await updateWorkspacePlugins({
      workspaceId,
      change: { kind: 'pruneInstalledItem', ref },
      source: 'marketplace_removal',
    });
  } catch (error) {
    if (
      error instanceof WorkspacePluginsRefusedError &&
      error.reason === 'not-found'
    )
      return;
    throw error;
  }
}

/** Reuse selection discovery and canonical metadata writers for single-item removal. */
export async function pruneSelectionRefsForInstalledItem(
  ref: InstalledItemRef,
  options: { strictWorkspaceDiscovery: boolean },
): Promise<void> {
  // A failed enumeration cannot prove there were no workspace references.
  // Keep the device-removal receipt so cleanup can be retried.
  const targets = await collectSelectionPruneTargets(
    options.strictWorkspaceDiscovery ? 'throw' : 'best-effort',
  );
  await prunePipelinePreferenceSelections(
    (entries) => pruneInstalledItemRefs(entries, ref),
    'electron_main',
  );
  for (const file of targets.files) {
    if (typeof file !== 'string') {
      await pruneInstalledItemInWorkspaceConfig(file.workspaceId, ref);
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
    const result = await runSerializedPluginMutation(() =>
      removeMarketplaceUnlocked(...args),
    );
    assertCatalogHealth();
    return result;
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error),
      ...reportInstallFailure(error, 'plugin.marketplace.remove'),
    };
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
): Promise<IPCResultWithAppError<MarketplaceRemovalResult>> {
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
  const claudeMarketplaceName =
    marketplace.providerStatus.claude.marketplaceName ?? marketplace.id;
  const identities = await readClaudeEntryIdentities(cache);
  if (requested.has('claude')) {
    outcomes.claude = await removeClaudeMarketplace(claudeMarketplaceName);
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
  const cacheUpdate = await withCacheLock(async () => {
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
    const unbindCopies =
      deleteMarketplace || removedProviders.includes('claude');
    const index = await readCacheIndex();
    let indexChanged = false;
    let unbound = false;
    if (unbindCopies) {
      const copies = latestMarketplace.plugins
        .flatMap((plugin) => [
          plugin.cachePath,
          plugin.facets.claude?.cachePath,
        ])
        .filter((entry): entry is string => !!entry);
      const entryNames = new Set([
        ...identities.entries
          .filter((entry) => entry.marketplaceId === id)
          .map((entry) => entry.entryName),
        ...latestMarketplace.plugins.flatMap((plugin) => {
          const entryName = recordedClaudeEntryName(plugin);
          return plugin.facets.claude && entryName !== undefined
            ? [entryName]
            : [];
        }),
        ...Object.entries(index.entries).flatMap(([key, entry]) => {
          const name = entry.provenance?.marketplaceEntryName;
          return name !== undefined && key === cacheKey(id, name) ? [name] : [];
        }),
      ]);
      // Unknown legacy ownership keeps every unnamed binding's copy, discoverable or not.
      const legacyKept = new Set(
        identities.legacyOwnershipKnown
          ? []
          : Object.values(index.entries).flatMap((entry) =>
              entry.provenance?.marketplaceEntryName === undefined
                ? [legacyCopyKey(entry.cachePath)]
                : [],
            ),
      );
      for (const entryName of entryNames) {
        if (
          !resolveClaudeEntryIdentity(identities, id, { entryName }, index)
            ?.bindingOwned
        )
          continue;
        const key = cacheKey(id, entryName);
        const entry = index.entries[key];
        if (!entry) continue;
        if (
          !identities.legacyOwnershipKnown &&
          entry.provenance?.marketplaceEntryName === undefined
        )
          continue;
        copies.push(entry.cachePath);
        delete index.entries[key];
        unbound = true;
      }
      // Unknown legacy ownership defers retirement too, even of a removed row's copy.
      const retiring = copies.filter(
        (copy) => !legacyKept.has(legacyCopyKey(copy)),
      );
      if (retiring.length > 0) retirePluginCopies(index, retiring);
      indexChanged = unbound || retiring.length > 0;
    }
    const nextCache: PluginsCache = {
      version: 2,
      lastRefreshed: nowIso(),
      marketplaces,
    };
    // An unneeded index write could fail and block the catalog removal.
    const committed = indexChanged
      ? await publishCatalogRetiringCopies(index, nextCache, unbound)
      : await writeCache(nextCache);
    return {
      shouldDelete: deleteMarketplace,
      marketplace: deleteMarketplace
        ? null
        : (committed?.marketplaces.find((entry) => entry.id === id) ?? updated),
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
        const materialized = await withPluginEffects(() =>
          materializeCodexPluginsOffMain({
            nativeProjectionRoot,
            plugins: [
              {
                pluginName: claudeFacet.name,
                pluginPath:
                  claudeFacet.cachePath ?? claudeFacet.installLocation,
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
          }),
        );
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
      const committed = await writeCache({
        version: 2,
        lastRefreshed: nowIso(),
        marketplaces: cache.marketplaces.map((entry) =>
          entry.id === marketplaceId ? updatedMarketplace : entry,
        ),
      });
      return {
        success: true,
        data:
          committed.marketplaces
            .find((entry) => entry.id === marketplaceId)
            ?.plugins.find(
              (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
            ) ?? updatedPlugin,
      };
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
  await assertCatalogHealthAsync();
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

export async function readComponentContent(
  installLocation: string,
  pluginSourcePath: string,
  componentFile: string,
  mode?: 'catalog-checkout',
): Promise<IPCResult<PluginComponentContent & { truncated?: true }>> {
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
    if (mode === 'catalog-checkout') {
      // Anchor the entire walk at the registered root that holds the caller's
      // location, not at that location: any directory between the registered
      // checkout and the plugin, or the caller's location itself, might be a
      // link. The outermost registered root wins, so a plugin folder the
      // catalog also trusts never shortens the walk.
      let containmentRoot: string | null = null;
      for (const root of [...knownRoots, cacheRoot]) {
        if (
          isPathInside(root, resolvedLocation) &&
          (containmentRoot === null || isPathInside(root, containmentRoot))
        ) {
          containmentRoot = root;
        }
      }
      if (containmentRoot === null) {
        return { success: false, error: 'Invalid install location.' };
      }
      try {
        const limit = 256 * 1024;
        const data = await withContainedFile(
          containmentRoot,
          filePath,
          async (
            handle,
          ): Promise<PluginComponentContent & { truncated?: true }> => {
            const bytes = Buffer.alloc(limit + 1);
            let length = 0;
            while (length < bytes.length) {
              const { bytesRead } = await handle.read(
                bytes,
                length,
                bytes.length - length,
                length,
              );
              if (bytesRead === 0) break;
              length += bytesRead;
            }
            const truncated = length > limit;
            const raw = new TextDecoder().decode(
              bytes.subarray(0, Math.min(length, limit)),
              { stream: truncated },
            );
            return {
              ...parseCatalogFrontmatterAndBody(raw),
              ...(truncated ? { truncated: true } : {}),
            };
          },
        );
        return { success: true, data };
      } catch (error) {
        if (error instanceof ContainedPathRefusedError)
          return { success: false, error: 'Invalid component path.' };
        if (isErrnoException(error) && error.code === 'ENOENT')
          return { success: false, error: 'Component file not found.' };
        throw error;
      }
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
  const known = await readKnownMarketplacesForDiscovery();
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
      const refreshedExisting = (await readKnownMarketplacesForDiscovery())[
        marketplaceName
      ];
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
): Promise<IPCResultWithAppError<InstallBuiltInPluginResult>> {
  const marketplaceId =
    isRecord(request) && typeof request.marketplaceId === 'string'
      ? request.marketplaceId
      : undefined;
  let mutationEntryName: string | undefined;
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
        error: BUILT_IN_PLUGIN_MARKETPLACE_REQUIRED_MESSAGE,
      };
    }
    const providerValues = Array.from(new Set(request.providers));
    if (providerValues.length === 0) {
      return { success: false, error: PLUGIN_PROVIDER_REQUIRED_MESSAGE };
    }
    if (!providerValues.every(isPluginProvider)) {
      return { success: false, error: UNKNOWN_PLUGIN_PROVIDER_MESSAGE };
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
      return { success: false, error: PLUGIN_NOT_IN_MARKETPLACE_MESSAGE };
    }

    mutationEntryName =
      recordedClaudeEntryName(plugin) ?? plugin.facets.claude?.name;
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
        : { installed: false, error: CLAUDE_FACET_UNAVAILABLE_MESSAGE };
    }
    if (providers.includes('codex')) {
      providerOutcomes.codex = plugin.facets.codex
        ? await installCodexLocalManagedPlugin({
            pluginName: plugin.facets.codex.name,
            ...target,
          })
        : { installed: false, error: CODEX_FACET_UNAVAILABLE_MESSAGE };
    }

    const successes = Object.values(providerOutcomes).filter(
      (outcome) => outcome?.installed,
    );
    // The install just changed provider state the scan memo cannot know about,
    // so re-read it rather than serving the pre-install snapshot back.
    invalidateManagedMarketplaceScanCache(marketplaceId);
    const { value: refreshed, observation } = await withPluginCatalogScan(() =>
      scanManagedMarketplace(marketplaceId),
    );
    assertCatalogHealth();
    let refreshedPlugin = findBuiltInPlugin(refreshed, pluginName) ?? plugin;
    if (refreshed) {
      await withCacheLock(async () => {
        const latestCache = readCache();
        const marketplaces =
          latestCache?.version === 2
            ? latestCache.marketplaces.filter(
                (entry) => entry.id !== marketplaceId,
              )
            : [];
        marketplaces.push(refreshed);
        const committed = await writeCache(
          {
            version: 2,
            lastRefreshed: nowIso(),
            marketplaces,
          },
          false,
          false,
          observation,
        );
        refreshedPlugin =
          committed.marketplaces
            .find((entry) => entry.id === marketplaceId)
            ?.plugins.find(
              (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
            ) ?? refreshedPlugin;
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
    return {
      success: false,
      error: errorMessage(error),
      ...reportInstallFailure(error, 'plugin.install_built_in'),
    };
  } finally {
    if (marketplaceId && mutationEntryName !== undefined)
      notePluginUserMutation(marketplaceId, mutationEntryName);
  }
}

/**
 * Keep a failed provider install on the cached plugin's install status, so the
 * detail page can show it beside the Install button that retries it. A plugin
 * the cache does not carry, or one without install status, writes nothing.
 */
async function recordBuiltInPluginInstallErrorUnlocked(
  target: { marketplaceId: string; pluginName: string },
  provider: PluginProvider,
  error: string,
): Promise<void> {
  await withCacheLock(async () => {
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
    if (changed) await writeCache({ ...cache, marketplaces });
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
     * `installRemoteControlExternalPlugin`). Default fires the refresh as before.
     */
    skipRefresh?: boolean;
    repairIdentity?: PluginRepairIdentity & {
      sourceUrl: string;
    };
    /** An automatic repair, including one without a provable entry. */
    automaticRepair?: boolean;
  },
): Promise<IPCResultWithAppError<PluginInfo>> {
  try {
    assertCatalogHealth();
    if (!marketplaceId || !pluginName || !sourceUrl) {
      return { success: false, error: 'Missing required parameters.' };
    }

    const randomId = crypto.randomBytes(4).toString('hex');
    const safeName = pluginName.replace(/[^a-zA-Z0-9_-]/g, '-');
    const cacheDir = path.join(getPluginCacheDir(), `${safeName}-${randomId}`);
    assertPluginPayloadPathAdmission(cacheDir);
    await withPluginEffects(async () => {
      fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
      await cloneRepo(sourceUrl, cacheDir, {
        followRedirects: options?.disableRedirects !== true,
      });
    });

    let commit: string | null | undefined;
    try {
      commit = await getHeadCommitSha(cacheDir);
    } catch (error) {
      process.stderr.write(
        `[plugins] Could not record downloaded HEAD: ${errorMessage(error)}\n`,
      );
    }
    assertCatalogHealth();
    const observation = observePluginCatalog();
    const pluginManifest = safeReadJson<PluginManifest>(
      path.join(cacheDir, '.claude-plugin', 'plugin.json'),
    );
    const details = scanPluginDetails(cacheDir, pluginManifest);
    const cachedAt = nowIso();

    const committedPlugin = await withCacheLock(async () => {
      const index = await readCacheIndex();
      const cache = readCache();
      const plugins = marketplacePluginRows(cache, marketplaceId);
      const identities = await readClaudeEntryIdentities();
      const {
        currentPlugin,
        identity,
        repairEntryName,
        marketplaceEntryName,
        key,
        prev,
      } = resolvePluginInstallTarget(
        identities,
        index,
        plugins,
        marketplaceId,
        pluginName,
        sourceUrl,
        options?.repairIdentity,
      );
      const provenance = {
        sourceUrl: stripPluginSourceCredentials(sourceUrl),
        sourceIdentityComplete:
          stripPluginSourceCredentials(sourceUrl) === sourceUrl,
        commit: commit || undefined,
        manifestRequired:
          !!pluginManifest &&
          typeof pluginManifest === 'object' &&
          !Array.isArray(pluginManifest),
        installedAt: cachedAt,
        marketplaceEntryName,
        installedName: manifestText(pluginManifest?.name) || pluginName,
        reinstalled: !!prev,
        remoteSourceRestricted:
          options?.disableRedirects === true ? true : undefined,
      };
      index.entries[key] = {
        cachePath: cacheDir,
        sourceUrl,
        cachedAt,
        provenance,
      };
      const previousPaths = new Set([
        prev?.cachePath,
        currentPlugin?.cachePath,
        currentPlugin?.facets.claude?.cachePath,
      ]);
      for (const previousPath of previousPaths) {
        if (!previousPath || previousPath === cacheDir) continue;
        try {
          assertPluginPayloadPathAdmission(previousPath);
          retirePluginCopies(index, [previousPath]);
        } catch (error) {
          process.stderr.write(
            `[plugins] Leaving previous plugin copy outside managed storage (${previousPath}): ${errorMessage(error)}\n`,
          );
        }
      }

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
        provenance,
        details,
      };
      // Rows are selected by name. Another entry's row with the installed name
      // gives way, as refresh's merge by name does.
      const replaced = new Set(
        plugins.filter(
          (row) =>
            row === currentPlugin ||
            row.name.toLowerCase() === facet.name.toLowerCase(),
        ),
      );
      const codexFacets = [...replaced].flatMap((row) =>
        row.facets.codex ? [row.facets.codex] : [],
      );
      // Differing Claude and Codex names merge into separate rows; keep both.
      const merged = mergeProviderPluginFacets({
        marketplaceId,
        claudePlugins: [facet],
        codexPlugins: codexFacets,
      });
      const pluginInfo =
        merged.find((row) => row.facets.claude === facet) ?? merged[0];

      // Publish before returning; the detached refresh rehydrates from this index.
      let persisted: PluginsCache | undefined;
      if (cache?.version === 2) {
        persisted = {
          ...cache,
          marketplaces: cache.marketplaces.map((entry) => {
            if (entry.id !== marketplaceId) return entry;
            let placed = false;
            const rows = entry.plugins.flatMap((existing) => {
              if (!replaced.has(existing)) return [existing];
              if (placed) return [];
              placed = true;
              return merged;
            });
            return { ...entry, plugins: placed ? rows : [...rows, pluginInfo] };
          }),
        };
      }

      // Reject inconsistent output before publishing either file or retiring
      // the previous payload. I/O failures are not a cross-file transaction.
      const validatedIndex = validateCacheIndexPayload(index);
      const validatedCache = persisted
        ? validateCachePayload(persisted)
        : undefined;
      const notedEntryNames = [identity?.entryName, repairEntryName];
      const userCopy = { entryName: marketplaceEntryName, cachePath: cacheDir };
      const committed = await publishPluginCachePair(
        validatedIndex,
        validatedCache,
        observation,
      ).then(
        (published) => {
          if (!options?.repairIdentity)
            notePluginUserInstall(marketplaceId, notedEntryNames, userCopy);
          return published;
        },
        async (error: unknown) => {
          if (options?.repairIdentity) throw error;
          // Only a copy that landed in the index is a user change to protect.
          const landed = await readCacheIndex().then(
            (published) => published.entries[key]?.cachePath === cacheDir,
            () => undefined,
          );
          if (landed)
            notePluginUserInstall(marketplaceId, notedEntryNames, userCopy);
          else if (landed === undefined)
            noteUserMutationEntries(marketplaceId, notedEntryNames);
          throw error;
        },
      );

      return (
        committed.catalog?.marketplaces
          .find((entry) => entry.id === marketplaceId)
          ?.plugins.find((entry) => entry.cachePath === pluginInfo.cachePath) ??
        pluginInfo
      );
    });

    if (options?.skipRefresh !== true) {
      trackDetachedWork(() =>
        providerRevalidation.run(false, () =>
          enqueueDetachedPluginMutation(() => refreshMarketplaces()),
        ),
      );
    }
    // JSON omits undefined fields; retain the scanner's optional display shape.
    const presentedPlugin: PluginInfo = {
      ...committedPlugin,
      details: committedPlugin.details
        ? {
            ...committedPlugin.details,
            lspServers: committedPlugin.details.lspServers.map((server) => ({
              ...server,
              args: server.args,
              languages: server.languages,
            })),
          }
        : committedPlugin.details,
    };
    return { success: true, data: presentedPlugin };
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error),
      ...reportInstallFailure(error, 'plugin.install'),
    };
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
      const [marketplaceId, pluginName, sourceUrl, options] = args;
      const expected = options?.repairIdentity;
      let disableRedirects = options?.disableRedirects;
      if (expected) {
        // Validation runs before this slot; re-registration can reuse both names with a new source.
        const cache = await readCacheAsync();
        const current =
          cache?.version === 2
            ? cache.marketplaces
                .find((entry) => entry.id === marketplaceId)
                ?.plugins.find(
                  (entry) =>
                    entry.name.toLowerCase() === pluginName.toLowerCase(),
                )
            : undefined;
        const repair = await pluginRepairStatus(
          marketplaceId,
          expected,
          current,
        );
        if (repair.status === 'replaced') return { success: true };
        if (repair.status === 'rebound') {
          if (await pluginUninstallPending(marketplaceId, pluginName))
            return { success: true };
          const copy = await verifiedClaudeCopy(current, repair.copy);
          if (copy) return { success: true, data: copy };
          // Never skip what develop repaired; the clone below keeps the
          // user's stricter policy.
          if (!repair.slotBound) return { success: true };
        }
      }
      if (await pluginUninstallPending(marketplaceId, pluginName)) {
        return {
          success: false,
          error: PLUGIN_UNINSTALL_PENDING_MESSAGE,
        };
      }
      if (
        (expected || options?.automaticRepair === true) &&
        (await automaticRepairRestricted(
          marketplaceId,
          pluginName,
          sourceUrl,
          options ?? {},
        ))
      ) {
        // Rechecked here: the caller may have read an unrestricted snapshot, or
        // checked before waiting for this slot. A refusal fails this repair only.
        const refusal = await restrictedPluginSourceRefusal(sourceUrl);
        if (refusal !== undefined) return { success: false, error: refusal };
        disableRedirects = true;
      }
      const result = await installPluginUnlocked(
        marketplaceId,
        pluginName,
        sourceUrl,
        options && { ...options, disableRedirects },
      );
      assertCatalogHealth();
      return result;
    } catch (error) {
      return {
        success: false,
        error: errorMessage(error),
        ...reportInstallFailure(error, 'plugin.install'),
      };
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
          error: PLUGIN_UNINSTALL_PENDING_MESSAGE,
        };
      }
      const result = await installBuiltInPluginUnlocked(...args);
      assertCatalogHealth();
      return result;
    } catch (error) {
      return {
        success: false,
        error: errorMessage(error),
        ...reportInstallFailure(error, 'plugin.install_built_in'),
      };
    }
  });
}

type PluginCopyBinding = Pick<
  PluginCacheIndex['entries'][string],
  'cachePath' | 'provenance'
>;

interface PluginRepairRebound {
  status: 'rebound';
  /** The user's copy; otherwise the session loads the current row's. */
  copy?: PluginCopyBinding;
  slotBound: boolean;
}

/**
 * `replaced`: the row is now another entry or source. `rebound`: the same entry
 * gained a newer user change or another copy, which the session loads instead;
 * when that copy does not verify, a still-bound slot gets the ordinary repair.
 */
async function pluginRepairStatus(
  marketplaceId: string,
  expected: PluginRepairIdentity & { sourceUrl: string },
  current: PluginInfo | undefined,
): Promise<{ status: 'current' | 'replaced' } | PluginRepairRebound> {
  const identity = current
    ? await resolvePluginRepairIdentity(marketplaceId, current)
    : undefined;
  const source =
    current?.facets.claude?.externalSource ?? current?.externalSource;
  // Only stale automatic repairs yield to newer user intent; user installs bypass this guard.
  const userChanged = entryChangedSince(
    expected.marketplaceId,
    expected.entryName,
    expected.userMutationGeneration,
  );
  if (
    !identity ||
    identity.marketplaceId !== expected.marketplaceId ||
    !source?.url ||
    expected.sourceUrl !== source.url
  )
    return { status: 'replaced' };
  const index = await readCacheIndex();
  const slots = [expected.entryName, identity.entryName].map(
    (entryName) => index.entries[cacheKey(marketplaceId, entryName)],
  );
  const rebound = (copy?: PluginCopyBinding): PluginRepairRebound => ({
    status: 'rebound',
    copy,
    // An uninstall empties the slot; anything else still bound gets repaired.
    // The user's copy is bound under the key its install wrote, which a legacy
    // row's inferred entry need not have.
    slotBound: !!copy || slots.every((slot) => slot !== undefined),
  });
  const userCopy = userInstalledCopy(index, expected);
  if (userCopy) return rebound(userCopy);
  // A user reinstall of a legacy row binds its literal key, not the inferred
  // entry; the same row and source is that user's rebinding.
  if (identity.entryName !== expected.entryName)
    return userChanged ? rebound() : { status: 'replaced' };
  // A snapshot can predate a user install that landed before its generation read.
  return userChanged ||
    !samePluginRepairBinding(expected.binding, identity.binding)
    ? rebound()
    : { status: 'current' };
}

/**
 * An index copy stands in for the repair only as the requested plugin: the
 * entry its install bound and the repair's clone URL or a source matching it (a
 * redacted one never does). Otherwise the ordinary repair restores the selected
 * source. Clone restriction is not identity: adoption fetches nothing, and a
 * newer unmarked installation clears the recorded policy, as refresh does.
 */
function isRequestedPluginCopy(
  indexed: PluginCacheIndex['entries'][string],
  entryName: string,
  sourceUrl: string,
): boolean {
  return (
    indexed.provenance?.marketplaceEntryName === entryName &&
    bindsPluginSource(indexed, sourceUrl)
  );
}

/** Whether the binding's copy came from `sourceUrl` (a redacted source never matches). */
function bindsPluginSource(
  indexed: PluginCacheIndex['entries'][string],
  sourceUrl: string,
): boolean {
  const provenance = indexed.provenance;
  return (
    indexed.sourceUrl === sourceUrl ||
    (provenance !== undefined &&
      matchPluginSources(
        provenance.sourceUrl,
        sourceUrl,
        provenance.sourceIdentityComplete === true,
      ) !== 'different')
  );
}

/** The copy a fresh session would load for the row, when it verifies. */
async function verifiedClaudeCopy(
  plugin: PluginInfo | undefined,
  binding: PluginCopyBinding | undefined = plugin?.facets.claude?.cachePath
    ? {
        cachePath: plugin.facets.claude.cachePath,
        provenance: plugin.facets.claude.provenance,
      }
    : undefined,
): Promise<PluginInfo | undefined> {
  const copy = binding?.cachePath;
  return plugin &&
    copy &&
    (await fs.promises.stat(copy).then(
      (stat) => stat.isDirectory(),
      () => false,
    )) &&
    (await isUsablePluginCopyAsync(copy, binding.provenance))
    ? { ...plugin, cachePath: copy }
    : undefined;
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

export function removeInstalledPluginCache(
  ...args: Parameters<typeof removeInstalledPluginCacheUnlocked>
): ReturnType<typeof removeInstalledPluginCacheUnlocked> {
  return runSerializedPluginMutation(async () => {
    assertCatalogHealth();
    return removeInstalledPluginCacheUnlocked(...args);
  });
}

export function refreshInstalledPluginCatalog(
  ...args: Parameters<typeof refreshInstalledPluginCatalogUnlocked>
): ReturnType<typeof refreshInstalledPluginCatalogUnlocked> {
  return runSerializedPluginMutation(async () => {
    assertCatalogHealth();
    return refreshInstalledPluginCatalogUnlocked(...args);
  });
}

export function recordBuiltInPluginInstallError(
  ...args: Parameters<typeof recordBuiltInPluginInstallErrorUnlocked>
): ReturnType<typeof recordBuiltInPluginInstallErrorUnlocked> {
  return runSerializedPluginMutation(async () => {
    assertCatalogHealth();
    return recordBuiltInPluginInstallErrorUnlocked(...args);
  });
}

export function setClaudeInstalledItemEnabled(
  ...args: Parameters<typeof setClaudeInstalledItemEnabledUnlocked>
): ReturnType<typeof setClaudeInstalledItemEnabledUnlocked> {
  return runSerializedPluginMutation(async () => {
    assertCatalogHealth();
    return setClaudeInstalledItemEnabledUnlocked(...args);
  });
}

export function uninstallClaudeInstalledItem(
  ...args: Parameters<typeof uninstallClaudeInstalledItemUnlocked>
): ReturnType<typeof uninstallClaudeInstalledItemUnlocked> {
  return runSerializedPluginMutation(async () => {
    assertCatalogHealth();
    return uninstallClaudeInstalledItemUnlocked(...args);
  });
}
