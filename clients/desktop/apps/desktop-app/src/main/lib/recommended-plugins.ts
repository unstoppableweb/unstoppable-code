import {
  buildShareablePluginDisplay,
  getShareablePluginRefKey,
  normalizeGitHubRepoRef,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import {
  WORKSPACE_ROOT_REPO_ID,
  type ApplyRecommendedPluginsRequest,
  type ApplyRecommendedPluginsResponse,
  type ChatTabPluginSelections,
  type InspectRecommendedPluginsRequest,
  type InspectRecommendedPluginsResponse,
  type RecommendedPluginApplyResult,
  type RecommendedPluginInstallSpec,
  type RecommendedPluginItem,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type {
  BundleConfig,
  BundleConfigFile,
} from '@canopy/desktop-shared/types/bundles';
import type { CollectionConfigFile } from '@canopy/desktop-shared/types/collections';
import type {
  MarketplaceInfo,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import { parseGitHubSource } from '../skills/source-parser';
import { installSkills } from '../skills/skill-service';
import { getCanopyJsonPath, readCanopyJson } from './canopy-json';
import { access } from 'node:fs/promises';
import { safeReadJson } from './fs-utils';
import {
  getBundleConfigFilePath,
  getCollectionConfigFilePath,
  getCollectionsIndexFilePath,
  getWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
} from './paths';
import {
  addMarketplace,
  installPlugin,
  loadMarketplaces,
  refreshMarketplaces,
} from '../plugins/plugin-service';
import { dependenciesToEnvironmentRequirements } from '@canopy/desktop-shared/node';
import {
  evaluatePipelinePackageRequirements,
  probePipelinePackageRequirement,
} from '../pipelines/pipeline-package-service';
import {
  loadShareablePluginCatalog,
  matchShareablePluginRef,
  type ShareablePluginCatalog,
  type ShareablePluginMatch,
} from '../plugins/shareable-plugin-resolution';
import { BUILTIN_SOURCE_ID } from '../skills/paths';
import { readWorkspaceConfig } from './workspace-persistence';
import {
  normalizeDefaultPluginSelections,
  updateWorkspacePlugins,
  type RecommendedPluginSelection,
  type WorkspacePluginsUpdateOutcome,
  type WorkspacePluginsUserChangeRequest,
} from './workspace-plugin-defaults';

interface RecommendationScope {
  repoPath: string;
  sourcePath: string;
  scopeLabel: string;
}

interface ExpandedSelectionKeys {
  skillKeys: Set<string>;
  pluginKeys: Set<string>;
}

function normalizeSelectionSkillSourceId(sourceId: string): string {
  return sourceId === 'builtin' ? BUILTIN_SOURCE_ID : sourceId;
}

function getSkillSelectionKey(sourceId: string, skillName: string): string {
  return `${normalizeSelectionSkillSourceId(sourceId)}/${skillName}`;
}

function getPluginSelectionKey(
  marketplaceId: string,
  pluginName: string,
): string {
  return `${marketplaceId}/${pluginName}`;
}

function fromLegacyBundle(
  bundle: BundleConfig,
): CollectionConfigFile['collection'] {
  return {
    id: bundle.id,
    name: bundle.name,
    description: bundle.description,
    skills: bundle.skills,
    plugins: bundle.plugins,
    mcpServers: Array.isArray(bundle.mcpServers) ? bundle.mcpServers : [],
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
  };
}

type PluginInstallLookup =
  | { state: 'missing' }
  | { state: 'local' }
  | { state: 'external'; pluginName: string; sourceUrl: string };

function requireWorktreeId(request: {
  worktreeId: string;
  workspaceId: string;
}): string {
  if (!request.worktreeId) {
    throw new Error(
      `Cannot resolve recommended plugin scope for project ${request.workspaceId} without a worktreeId`,
    );
  }
  return request.worktreeId;
}

function resolveScope(
  config: WorkspaceConfigFile,
  request: InspectRecommendedPluginsRequest | ApplyRecommendedPluginsRequest,
): RecommendationScope {
  const worktreeId = requireWorktreeId(request);
  if (config.type === 'single-repo') {
    const repoPath = getWorktreeDir(request.workspaceId, worktreeId);
    return {
      repoPath,
      sourcePath: getCanopyJsonPath(repoPath),
      scopeLabel: 'Project worktree',
    };
  }

  if (request.repoId && request.repoId !== WORKSPACE_ROOT_REPO_ID) {
    const repoPath = getWorkspaceWorktreeRepoDir(
      request.workspaceId,
      worktreeId,
      request.repoId,
    );
    const repo = config.repos.find((entry) => entry.id === request.repoId);
    return {
      repoPath,
      sourcePath: getCanopyJsonPath(repoPath),
      scopeLabel: repo?.name ?? request.repoId,
    };
  }

  const repoPath = getWorkspaceWorktreeRootRepoDir(
    request.workspaceId,
    worktreeId,
  );
  return {
    repoPath,
    sourcePath: getCanopyJsonPath(repoPath),
    scopeLabel: 'Project root',
  };
}

function normalizeRecommendedPluginRefs(
  refs: readonly ShareablePluginRef[],
): ShareablePluginRef[] {
  const seenKeys = new Set<string>();
  const result: ShareablePluginRef[] = [];
  for (const ref of refs) {
    const key = getShareablePluginRefKey(ref);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    result.push(ref);
  }
  return result;
}

async function readCollectionConfig(
  collectionId: string,
): Promise<CollectionConfigFile | null> {
  if (!/^[a-f0-9-]+$/.test(collectionId)) {
    return null;
  }
  const collection = safeReadJson<CollectionConfigFile>(
    getCollectionConfigFilePath(collectionId),
  );
  if (collection) {
    return collection;
  }
  // Once collections exist, a legacy bundle is converted or deleted, never live.
  // An index published since the first read means the config is now written.
  if (
    await access(getCollectionsIndexFilePath()).then(
      () => true,
      () => false,
    )
  )
    return safeReadJson<CollectionConfigFile>(
      getCollectionConfigFilePath(collectionId),
    );
  const legacy = safeReadJson<BundleConfigFile>(
    getBundleConfigFilePath(collectionId),
  );
  return legacy?.bundle
    ? { version: 2, collection: fromLegacyBundle(legacy.bundle) }
    : null;
}

async function expandDefaultSelectionKeys(
  selections: ChatTabPluginSelections,
): Promise<ExpandedSelectionKeys> {
  const skillKeys = new Set<string>();
  const pluginKeys = new Set<string>();

  for (const ref of selections.skillRefs) {
    skillKeys.add(getSkillSelectionKey(ref.sourceId, ref.skillName));
  }
  for (const ref of selections.pluginRefs) {
    pluginKeys.add(getPluginSelectionKey(ref.marketplaceId, ref.pluginName));
  }

  for (const collectionId of selections.collectionIds) {
    const collectionFile = await readCollectionConfig(collectionId);
    const collection = collectionFile?.collection;
    if (!collection) {
      continue;
    }
    for (const ref of collection.skills) {
      skillKeys.add(getSkillSelectionKey(ref.sourceId, ref.skillName));
    }
    for (const ref of collection.plugins) {
      pluginKeys.add(getPluginSelectionKey(ref.marketplaceId, ref.pluginName));
    }
  }

  return { skillKeys, pluginKeys };
}

function isSelectedByDefault(
  match: ShareablePluginMatch,
  expandedSelections: ExpandedSelectionKeys,
): boolean {
  if (match.matchState !== 'matched') {
    return false;
  }
  if (match.selection.kind === 'skill') {
    return (
      expandedSelections.skillKeys.has(match.catalogKey) ||
      expandedSelections.skillKeys.has(
        getSkillSelectionKey(
          match.selection.sourceId,
          match.selection.skillName,
        ),
      )
    );
  }
  return (
    expandedSelections.pluginKeys.has(match.catalogKey) ||
    expandedSelections.pluginKeys.has(
      getPluginSelectionKey(
        match.selection.marketplaceId,
        match.selection.pluginName,
      ),
    )
  );
}

function getInstallSpec(
  ref: ShareablePluginRef,
  matched: boolean,
): RecommendedPluginInstallSpec | undefined {
  if (matched) {
    return undefined;
  }
  if (ref.type === 'skill' && ref.source.type === 'github') {
    return {
      kind: 'skill',
      repo: normalizeGitHubRepoRef(ref.source.repo),
      skillName: ref.skill_name,
    };
  }
  // Built-in marketplace plugins are bundled locally and need no dependency install action.
  if (
    (ref.type === 'plugin' || ref.type === 'claude_plugin') &&
    ref.marketplace.type === 'github'
  ) {
    return {
      kind: 'plugin',
      repo: normalizeGitHubRepoRef(ref.marketplace.repo),
      pluginName: ref.plugin_name,
    };
  }
  return undefined;
}

function buildRecommendedPluginItem(params: {
  ref: ShareablePluginRef;
  match: ShareablePluginMatch;
  selectedByDefault: boolean;
  optedOut: boolean;
}): RecommendedPluginItem {
  const display = buildShareablePluginDisplay(params.ref);
  const matched = params.match.matchState === 'matched';
  const installSpec = getInstallSpec(params.ref, matched);
  const installState = matched
    ? 'installed'
    : installSpec
      ? 'installable'
      : 'unavailable';
  const action = params.selectedByDefault
    ? 'none'
    : installState === 'installed'
      ? 'select'
      : installState === 'installable'
        ? 'install-and-select'
        : 'none';

  return {
    key: getShareablePluginRefKey(params.ref),
    kind: params.ref.type,
    displayName: display.title,
    displaySource: display.subtitle,
    ref: params.ref,
    installed: matched,
    selectedByDefault: params.selectedByDefault,
    optedOut: params.optedOut,
    installState,
    action,
    ...(installSpec ? { installSpec } : {}),
    ...(installState === 'unavailable'
      ? {
          unavailableReason:
            'This recommendation cannot be installed automatically.',
        }
      : {}),
  };
}

function getPromptItems(
  items: RecommendedPluginItem[],
): RecommendedPluginItem[] {
  return items.filter(
    (item) =>
      !item.selectedByDefault &&
      !item.optedOut &&
      (item.installState === 'installed' ||
        item.installState === 'installable'),
  );
}

export async function inspectRecommendedPlugins(
  request: InspectRecommendedPluginsRequest,
): Promise<InspectRecommendedPluginsResponse> {
  const config = await readWorkspaceConfig(request.workspaceId);
  const scope = resolveScope(config, request);
  const manifest = await readCanopyJson(scope.repoPath);
  const recommendations = normalizeRecommendedPluginRefs(
    manifest?.plugins ?? [],
  );
  const catalog = await loadShareablePluginCatalog();
  const selections = normalizeDefaultPluginSelections(
    config.defaultPluginSelections,
  );
  const expandedSelections = await expandDefaultSelectionKeys(selections);
  const optOutKeys = new Set(config.recommendedPluginOptOutKeys ?? []);

  const items = recommendations.map((ref) => {
    const match = matchShareablePluginRef(ref, catalog);
    return buildRecommendedPluginItem({
      ref,
      match,
      selectedByDefault: isSelectedByDefault(match, expandedSelections),
      optedOut: optOutKeys.has(getShareablePluginRefKey(ref)),
    });
  });
  const readiness = await evaluatePipelinePackageRequirements(
    dependenciesToEnvironmentRequirements(manifest?.dependencies ?? []),
    probePipelinePackageRequirement,
  );

  return {
    workspaceId: request.workspaceId,
    ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
    ...(request.repoId ? { repoId: request.repoId } : {}),
    scopeLabel: scope.scopeLabel,
    sourcePath: scope.sourcePath,
    items,
    promptItems: getPromptItems(items),
    requirements: readiness.requirements,
  };
}

function parseGitHubRepo(input: string): string | null {
  const parsed = parseGitHubSource(input);
  if (!parsed) {
    return null;
  }
  try {
    return normalizeGitHubRepoRef(`${parsed.owner}/${parsed.repo}`);
  } catch {
    return null;
  }
}

function findMarketplaceByRepo(
  cache: PluginsCache | undefined,
  repo: string,
): MarketplaceInfo | null {
  if (!cache) {
    return null;
  }
  const target = parseGitHubRepo(repo);
  if (!target) {
    return null;
  }
  for (const marketplace of cache.marketplaces) {
    const parsed = parseGitHubRepo(marketplace.sourceUrl);
    if (parsed === target) {
      return marketplace;
    }
  }
  return null;
}

function findPluginInstallLookup(
  cache: PluginsCache | undefined,
  marketplaceId: string,
  pluginName: string,
): PluginInstallLookup {
  if (!cache) {
    return { state: 'missing' };
  }
  const marketplace = cache.marketplaces.find(
    (entry) => entry.id === marketplaceId,
  );
  if (!marketplace) {
    return { state: 'missing' };
  }
  const normalizedPluginName = pluginName.trim().toLowerCase();
  const plugin = marketplace.plugins.find(
    (entry) => entry.name.trim().toLowerCase() === normalizedPluginName,
  );
  if (!plugin) {
    return { state: 'missing' };
  }
  if (plugin.externalSource?.url) {
    return {
      state: 'external',
      pluginName: plugin.name,
      sourceUrl: plugin.externalSource.url,
    };
  }
  return { state: 'local' };
}

async function installRecommendedPlugin(
  item: RecommendedPluginItem,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!item.installSpec) {
    return { ok: false, error: 'Missing install spec.' };
  }

  if (item.installSpec.kind === 'skill') {
    const result = await installSkills(item.installSpec.repo, [
      item.installSpec.skillName,
    ]);
    if (!result.success) {
      return { ok: false, error: result.error ?? 'Failed to install skill.' };
    }
    return { ok: true };
  }

  const { repo, pluginName } = item.installSpec;
  const initial = await loadMarketplaces();
  if (!initial.success) {
    return {
      ok: false,
      error: initial.error ?? 'Failed to load marketplaces.',
    };
  }

  let currentCache: PluginsCache | undefined = initial.data;
  let marketplace = findMarketplaceByRepo(currentCache, repo);
  if (!marketplace) {
    const added = await addMarketplace(repo);
    if (!added.success) {
      return { ok: false, error: added.error ?? 'Failed to add marketplace.' };
    }
    const refreshed = await refreshMarketplaces();
    if (!refreshed.success) {
      return {
        ok: false,
        error: refreshed.error ?? 'Failed to refresh marketplaces.',
      };
    }
    currentCache = refreshed.data;
    marketplace = findMarketplaceByRepo(currentCache, repo);
    if (!marketplace) {
      return {
        ok: false,
        error: `Marketplace ${repo} did not appear after registration.`,
      };
    }
  }

  let lookup = findPluginInstallLookup(
    currentCache,
    marketplace.id,
    pluginName,
  );
  if (lookup.state === 'missing') {
    // Recovery refresh, not an incidental one: the entry is missing from the
    // cache and the very next step hard-fails if it still is. Force the
    // provider update past the 24h TTL so an upstream manifest change can
    // actually be picked up - otherwise this self-healing path becomes a hard
    // error for any user whose last refresh was under a day ago.
    const refreshed = await refreshMarketplaces(undefined, {
      providerUpdates: 'always',
    });
    if (!refreshed.success) {
      return {
        ok: false,
        error: refreshed.error ?? 'Failed to refresh marketplaces.',
      };
    }
    currentCache = refreshed.data;
    lookup = findPluginInstallLookup(currentCache, marketplace.id, pluginName);
  }
  if (lookup.state === 'missing') {
    return { ok: false, error: `Plugin ${pluginName} not found in ${repo}.` };
  }
  if (lookup.state === 'local') {
    return { ok: true };
  }

  const installed = await installPlugin(
    marketplace.id,
    lookup.pluginName,
    lookup.sourceUrl,
  );
  if (!installed.success) {
    return {
      ok: false,
      error: installed.error ?? 'Failed to install plugin.',
    };
  }
  return { ok: true };
}

function selectInstalledRecommendation(params: {
  item: RecommendedPluginItem;
  selections: RecommendedPluginSelection[];
  catalog: ShareablePluginCatalog;
  installedDuringApply: boolean;
}): RecommendedPluginApplyResult {
  const match = matchShareablePluginRef(params.item.ref, params.catalog);
  if (match.matchState !== 'matched') {
    return {
      key: params.item.key,
      status: 'error',
      message: 'Recommendation was not found after installation.',
    };
  }

  params.selections.push(match.selection);
  return {
    key: params.item.key,
    status: params.installedDuringApply ? 'installed-and-selected' : 'selected',
  };
}

function normalizeKeyList(keys: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys ?? []) {
    const normalized = key.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * `updatePlugins` is the boundary write; the IPC handler passes the
 * projection of the registered plugins operation (W7b-1c).
 */
export async function applyRecommendedPlugins(
  request: ApplyRecommendedPluginsRequest,
  updatePlugins: (
    request: WorkspacePluginsUserChangeRequest,
  ) => Promise<WorkspacePluginsUpdateOutcome> = updateWorkspacePlugins,
): Promise<ApplyRecommendedPluginsResponse> {
  const inspection = await inspectRecommendedPlugins(request);
  const itemsByKey = new Map(inspection.items.map((item) => [item.key, item]));
  // Installs reach the network, so the selections are merged into the
  // defaults current when the boundary writes, not into a read from here.
  const selections: RecommendedPluginSelection[] = [];
  const selectedKeys = normalizeKeyList(request.selectedKeys);
  const selectedKeySet = new Set(selectedKeys);
  const optOutKeys = normalizeKeyList(request.optOutKeys);
  const clearOptOutKeys = normalizeKeyList(request.clearOptOutKeys);
  const results: RecommendedPluginApplyResult[] = [];
  const successfulSelectedKeys = new Set<string>();

  let catalog = await loadShareablePluginCatalog();
  for (const key of selectedKeys) {
    const item = itemsByKey.get(key);
    if (!item) {
      results.push({
        key,
        status: 'skipped',
        message: 'Unknown recommendation.',
      });
      continue;
    }
    if (item.selectedByDefault) {
      results.push({ key, status: 'skipped', message: 'Already selected.' });
      successfulSelectedKeys.add(key);
      continue;
    }

    if (item.installed) {
      const result = selectInstalledRecommendation({
        item,
        selections,
        catalog,
        installedDuringApply: false,
      });
      results.push(result);
      if (result.status !== 'error') {
        successfulSelectedKeys.add(key);
      }
      continue;
    }

    if (item.installState !== 'installable') {
      results.push({
        key,
        status: 'error',
        message: item.unavailableReason ?? 'Recommendation is unavailable.',
      });
      continue;
    }

    const installed = await installRecommendedPlugin(item);
    if (!installed.ok) {
      results.push({ key, status: 'error', message: installed.error });
      continue;
    }

    catalog = await loadShareablePluginCatalog();
    const result = selectInstalledRecommendation({
      item,
      selections,
      catalog,
      installedDuringApply: true,
    });
    results.push(result);
    if (result.status !== 'error') {
      successfulSelectedKeys.add(key);
    }
  }

  const outcome = await updatePlugins({
    workspaceId: request.workspaceId,
    change: {
      kind: 'selectRecommended',
      selections,
      optOutKeys: optOutKeys.filter((key) => !selectedKeySet.has(key)),
      // A recommendation the user just selected is no longer opted out.
      clearOptOutKeys: [
        ...clearOptOutKeys,
        ...Array.from(successfulSelectedKeys),
      ],
    },
    source: 'recommended_plugins',
  });

  return {
    workspaceId: request.workspaceId,
    ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
    ...(request.repoId ? { repoId: request.repoId } : {}),
    results,
    defaultPluginSelections:
      outcome.defaultPluginSelections ??
      normalizeDefaultPluginSelections(undefined),
    recommendedPluginOptOutKeys: outcome.recommendedPluginOptOutKeys ?? [],
  };
}
