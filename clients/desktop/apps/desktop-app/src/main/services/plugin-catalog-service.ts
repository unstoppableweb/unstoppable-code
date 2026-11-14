import {
  getShareablePluginRefKey,
  officialMarketplaceRelativePackageUrl,
} from '@canopy/protocol/plugins';
import { listAdvertisedProviderConnectors } from '../mcp/provider-connectors';
import {
  McpConfigNotFoundError,
  McpConfigStateError,
} from '../mcp/config-repository-format';
import {
  projectPortalMcpStatus,
  isPortalMcpTestConnectionResult,
  type PortalMcpServerStatus,
  type PortalMcpTestConnectionResult,
  type PortalMcpDeleteServerResult,
} from '@canopy/protocol/portal';
import {
  createMarketplaceShareResolver as createSharedMarketplaceShareResolver,
  type MarketplaceShareResolver,
} from '@canopy/desktop-shared/lib/marketplace-share-resolution';
import {
  buildShareOrganizationAccess,
  MARKETPLACE_SHARE_BLOCKED_REASONS,
  type MarketplaceEntryShareResolution,
} from '@canopy/protocol/sharing';
import { ResourceContextUnavailableError } from '../lib/resource-context-error';
import type { CollectionSaveGuard } from '../collections/collection-store';
import {
  resourceContextSnapshot,
  assertResourceContextSnapshot,
  resourceAccountSnapshot,
} from '../lib/resource-context';
import { notifyDesktopInventoryChanged } from './desktop-inventory-sync-signals';
import { skillResourceContextEnabled } from '../skills/resource-lanes';
import { SkillServiceResultError } from '../canopy-runtime/core-skill-catalog-host';
import {
  annotateSharedSkillInstalls,
  filterPersonalStoredSkills,
  filterStoredSkillContexts,
} from '../skills/skill-install-context';
import {
  resultByteLength,
  truncateBodyToBytes,
} from '../portal/adapters/result-budget';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  PortalCatalogMarkdownContent,
  PortalCollectionsGetResult,
  PortalCollectionsListResult,
  PortalCollectionsSavePayload,
  PortalCollectionsSaveResult,
  PortalMarketplacePluginMcpServer,
  PortalMarketplacePluginSkill,
  PortalMarketplacePluginRow,
  PortalMarketplaceProviderStatusRow,
  PortalMarketplaceRow,
  PortalMcpGetServerResult,
  PortalMcpListServersResult,
  PortalMcpServerRow,
  PortalMcpServerConfigDetail,
  PortalMcpCuratedMetadata,
  PortalMcpServerDetail,
  PortalPluginCatalog,
  PortalPluginCatalogCollection,
  PortalPluginCatalogMcpServer,
  PortalPluginCatalogPlugin,
  PortalPluginCatalogSkill,
  PortalPluginDetailResult,
  PortalPluginsListMarketplacesResult,
  PortalSkillsListResult,
  PortalPluginsSharePluginResult,
} from '@canopy/desktop-shared/types';
import type {
  PortalShareResult,
  PortalShareScope,
  PortalSharingAccountResult,
  PortalSharingExistingShare,
  PortalSharingListTargetsResult,
} from '@canopy/protocol/portal';
import {
  PORTAL_CATALOG_CONTENT_MAX_BYTES,
  PORTAL_CATALOG_RESULT_MAX_BYTES,
} from '@canopy/desktop-shared/types';
import type {
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginInfo,
  PluginProvider,
  PluginProviderFacet,
} from '@canopy/execution-engine/types/plugins';
import type {
  PortalMarketplaceMutationResult,
  PortalMarketplaceRemoveResult,
  PortalMcpSetConfigEnabledResult,
  PortalPluginMutationResult,
} from '@canopy/desktop-shared/types';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import { skillSharePath } from '@canopy/protocol/skills';
import {
  collectionSharePath,
  MCP_SHARE_BLOCKED_MESSAGE,
} from '@canopy/protocol/collections';
import { pluginDisplayName } from '@canopy/ui-shared/lib';
import { parseGitHubRepo } from '@canopy/desktop-shared/lib/github-repo';
import { computePluginShareableRef } from '@canopy/execution-engine/plugin-refs';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import { assertSafeExternalPluginCloneUrl } from '../plugins/external-plugin-url';
import type {
  AccountMcpConnection,
  McpServerConfigSummary,
  McpServerCuratedMetadata,
  McpServerFile,
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/execution-engine/types/mcp-servers';
import { isCustomAccountMcpServerKey } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  readCollectionConfig,
  readCollectionIndex,
  readPersonalCollectionConfig,
  readPersonalCollectionIndex,
} from '../collections/collection-store';
import { loadSkills } from '../skills/skill-service';
import { loadMarketplaces } from '../plugins/plugin-service';
import { getMcpServersIndexFilePath } from '../lib/paths';
import { isErrnoException } from '../lib/type-guards';
import { offeredPluginHarnesses } from '@canopy/plugin-interop/harness-support';
import { isCursorHarnessEnabled } from '../cursor/feature-flag';
import { isCopilotHarnessEnabled } from '../copilot/feature-flag';
import { isOpenCodeHarnessEnabled } from '../opencode/feature-flag';
import {
  preserveOrganizationPublicLink,
  requirePortalShareAccountId,
  toPortalExistingShare,
} from '../lib/resource-share-context';

/**
 * Reads the desktop's CACHED local plugin inventory and reduces it to the
 * browser-safe {@link PortalPluginCatalog} the portal plugins selector renders
 * (CAN-1219). Mirrors `listEditorSlashCommands`: it only reads already-persisted
 * inventory (`readCollectionIndex` / `loadSkills` / cached `loadMarketplaces` /
 * the MCP index file) and never triggers a marketplace network refresh, so it is
 * cheap enough to answer a `portal.chat.list_plugin_catalog` request on demand.
 *
 * Each category is best-effort: a failure in one reader yields an empty list for
 * that category rather than failing the whole catalog, so a partial inventory
 * still lets the browser render the sections that did load.
 */
export async function buildPluginCatalog(): Promise<PortalPluginCatalog> {
  const [collections, plugins, mcpServers] = await Promise.all([
    readCatalogCollections(),
    readCatalogPlugins(),
    readCatalogMcpServers(),
  ]);
  return {
    collections,
    skills: await readCatalogSkills(),
    plugins,
    mcpServers,
  };
}

/**
 * The picker catalog for core reads (CAN-4123): the same lists as
 * buildPluginCatalog, with plugins read from the cache only. Never refreshes
 * providers and never seeds curated defaults.
 */
export async function buildCachedPluginCatalog(): Promise<PortalPluginCatalog> {
  const [collections, plugins, mcpServers] = await Promise.all([
    readCatalogCollections(),
    readCachedCatalogPlugins(),
    readCatalogMcpServers(),
  ]);
  return {
    collections,
    skills: await readCatalogSkills(),
    plugins,
    mcpServers,
  };
}

async function readCatalogCollections(): Promise<
  PortalPluginCatalogCollection[]
> {
  try {
    const index = await readCollectionIndex();
    return index.collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      description: collection.description,
      skillCount: collection.skillCount,
      pluginCount: collection.pluginCount,
      mcpServerCount: collection.mcpServerCount,
    }));
  } catch {
    return [];
  }
}

async function readCatalogSkills(): Promise<PortalPluginCatalogSkill[]> {
  try {
    const result = loadSkills();
    if (result.success && result.data)
      result.data = await filterStoredSkillContexts(result.data);
    if (!result.success || !result.data) {
      return [];
    }
    return result.data.map((skill) => ({
      sourceId: skill.sourceId,
      skillName: skill.name,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      ...(skill.builtIn ? { builtIn: true } : {}),
    }));
  } catch {
    return [];
  }
}

async function readCatalogPlugins(): Promise<PortalPluginCatalogPlugin[]> {
  try {
    const result = await loadMarketplaces();
    if (!result.success || !result.data) {
      return [];
    }
    const rows: PortalPluginCatalogPlugin[] = [];
    for (const marketplace of result.data.marketplaces) {
      for (const plugin of marketplace.plugins) {
        rows.push({
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.name,
          name: plugin.name,
          description: plugin.description ?? '',
          marketplaceName: marketplace.name,
          // Mirror the desktop chat Plugins-modal selectability rule
          // (`pluginSelectorScope.ts` → `getUnsupportedReason`), which gates on
          // provider support only. `codexCompatDisabled` gates real
          // invocability elsewhere but is intentionally NOT applied here so the
          // portal picker stays visually consistent with the desktop picker.
          claudeSupported: plugin.providerSupport.claude === 'native',
          codexSupported: plugin.providerSupport.codex !== 'none',
        });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function readCachedCatalogPlugins(): Promise<
  PortalPluginCatalogPlugin[]
> {
  try {
    const { loadMarketplacesCacheOnly } =
      await import('../plugins/plugin-service');
    const result = await loadMarketplacesCacheOnly();
    if (!result.success || !result.data) {
      return [];
    }
    const rows: PortalPluginCatalogPlugin[] = [];
    for (const marketplace of result.data.marketplaces) {
      for (const plugin of marketplace.plugins) {
        rows.push({
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.name,
          name: plugin.name,
          description: plugin.description ?? '',
          marketplaceName: marketplace.name,
          // Mirror the desktop chat Plugins-modal selectability rule
          // (`pluginSelectorScope.ts` → `getUnsupportedReason`), which gates on
          // provider support only. `codexCompatDisabled` gates real
          // invocability elsewhere but is intentionally NOT applied here so the
          // portal picker stays visually consistent with the desktop picker.
          claudeSupported: plugin.providerSupport.claude === 'native',
          codexSupported: plugin.providerSupport.codex !== 'none',
        });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCloudNotFound(error: unknown): boolean {
  return isRecord(error) && error.status === 404;
}

function isConfigSummary(value: unknown): value is McpServerConfigSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

function isServerEntry(value: unknown): value is McpServerIndexEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    (value.type === 'command' || value.type === 'http') &&
    Array.isArray(value.configs) &&
    value.configs.every(isConfigSummary)
  );
}

// ---------------------------------------------------------------------------
// Portal Plugins-section browse builders (design:
// docs/planning/2026-08-27-portal-plugins-section/design.md, PR 3).
//
// Read-only projections over the SAME cached inventory the picker catalog
// above reads. Every function here must stay refresh-free: no CLI execution,
// no marketplace network refresh, no MCP health checks or OAuth flows. The
// marketplace readers therefore go through `loadMarketplacesCacheOnly()`
// (never `loadMarketplaces()`, whose cache-miss path falls through to a full
// provider refresh).
// ---------------------------------------------------------------------------

/** Error with a stable portal failure code for `failServiceError` routing. */
function codedError(
  code:
    | 'not_found'
    | 'invalid_payload'
    | 'invalid_target'
    | 'execution_failed'
    | 'conflict'
    | 'permission_denied',
  message: string,
): Error {
  return Object.assign(new Error(message), { code });
}

function truncateBody(body: string): { body: string; truncated: boolean } {
  return truncateBodyToBytes(body, PORTAL_CATALOG_CONTENT_MAX_BYTES);
}

function withinResultBudget(result: unknown): boolean {
  return resultByteLength(result) <= PORTAL_CATALOG_RESULT_MAX_BYTES;
}

/**
 * UNIVERSAL byte-budget enforcement point for every portal catalog command
 * result. Measures the FINAL SERIALIZED form (`JSON.stringify` UTF-8 bytes —
 * so JSON escaping expansion of control characters is accounted for) against
 * {@link PORTAL_CATALOG_RESULT_MAX_BYTES} and, while over budget, applies the
 * command-specific degradation ladder in order (each step returns a smaller
 * result; steps loop internally where iterative shrinking is needed). If the
 * ladder is exhausted and even the minimal envelope exceeds the budget, this
 * THROWS so the adapter fails the command with `execution_failed` instead of
 * emitting an undeliverable >1 MiB portal event.
 */
function enforcePortalResultBudget<TResult>(
  result: TResult,
  ladder: Array<(current: TResult) => TResult>,
): TResult {
  let current = result;
  let step = 0;
  while (!withinResultBudget(current)) {
    if (step >= ladder.length) {
      throw new Error(
        'Portal catalog result exceeds the deliverable size budget even after degradation.',
      );
    }
    current = ladder[step](current);
    step += 1;
  }
  return current;
}

/**
 * Degradation-ladder step: iteratively HALVE a markdown body (by its UTF-8
 * byte length, cutting on code-point boundaries) until the SERIALIZED result
 * fits the budget or the body is empty. Halving by serialized measurement is
 * what makes control-character-heavy bodies safe: a body at the per-body byte
 * cap can still serialize to several times its raw size through JSON escaping.
 */
function halveBodyToBudget<TResult>(
  result: TResult,
  getBody: (current: TResult) => string,
  withBody: (current: TResult, body: string) => TResult,
): TResult {
  let current = result;
  let targetBytes = Buffer.byteLength(getBody(result), 'utf8');
  while (!withinResultBudget(current) && targetBytes > 0) {
    targetBytes = Math.floor(targetBytes / 2);
    current = withBody(
      result,
      truncateBodyToBytes(getBody(result), targetBytes).body,
    );
  }
  return current;
}

/**
 * Degradation-ladder step: binary-search the longest prefix of `items` whose
 * built result fits the budget (down to and including the empty list, whose
 * minimal envelope is then re-checked — and thrown on — by
 * {@link enforcePortalResultBudget}). Deterministic: the same inventory
 * always yields the same prefix.
 */
function cutListToFit<TItem, TResult>(
  items: TItem[],
  build: (items: TItem[], truncated: boolean) => TResult,
): TResult {
  let low = 0;
  let high = Math.max(0, items.length - 1);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (withinResultBudget(build(items.slice(0, mid), true))) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return build(items.slice(0, low), true);
}

/**
 * Final size guard for list-shaped results: route the complete result through
 * {@link enforcePortalResultBudget} with a single prefix-cut ladder step.
 */
function fitListToResultBudget<TItem, TResult>(
  items: TItem[],
  build: (items: TItem[], truncated: boolean) => TResult,
): TResult {
  return enforcePortalResultBudget(build(items, false), [
    (): TResult => cutListToFit(items, build),
  ]);
}

function toProviderStatusRow(
  status: MarketplaceProviderStatus,
): PortalMarketplaceProviderStatusRow {
  return {
    provider: status.provider,
    state: status.state,
    accepted: status.accepted,
    pluginCount: status.pluginCount,
    lastCheckedAt: status.lastCheckedAt,
    ...(status.error !== undefined ? { error: status.error } : {}),
  };
}

/** The shared resolver, naming plugin targets as the share dialogs do. */
function createMarketplaceShareResolver(
  marketplaces: readonly MarketplaceInfo[],
): MarketplaceShareResolver {
  return createSharedMarketplaceShareResolver(marketplaces, pluginDisplayName);
}

/** Whether the marketplace row is installed, as the Plugins page shows it. */
export function isPluginInstalled(plugin: PluginInfo): boolean {
  return (
    plugin.parked === true ||
    Boolean(plugin.cachePath) ||
    Boolean(plugin.globalInstallStatus?.claude?.installed) ||
    Boolean(plugin.globalInstallStatus?.codex?.installed)
  );
}

function toPluginRow(
  plugin: PluginInfo,
  marketplace?: MarketplaceInfo,
  shareResolver?: MarketplaceShareResolver,
): PortalMarketplacePluginRow {
  const installed = isPluginInstalled(plugin);
  const logoUrl = sanitizePortalArtworkUrl(plugin.logoUrl);
  return {
    name: plugin.name,
    marketplaceId: plugin.marketplaceId,
    providerSupport: plugin.providerSupport,
    installed,
    ...(plugin.displayName !== undefined
      ? { displayName: plugin.displayName }
      : {}),
    ...(plugin.description !== undefined
      ? { description: plugin.description }
      : {}),
    ...(plugin.tryNowPrompt !== undefined
      ? { tryNowPrompt: plugin.tryNowPrompt }
      : {}),
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    ...(plugin.author !== undefined ? { author: plugin.author } : {}),
    ...(plugin.category !== undefined ? { category: plugin.category } : {}),
    ...(logoUrl !== undefined ? { logoUrl } : {}),
    ...(plugin.builtIn !== undefined ? { builtIn: plugin.builtIn } : {}),
    ...(plugin.curated !== undefined ? { curated: plugin.curated } : {}),
    ...(plugin.recommended !== undefined
      ? { recommended: plugin.recommended }
      : {}),
    // The desktop decides shareability (CAN-2829) so the browser shows the
    // same Share affordances the desktop Marketplace shows.
    ...shareFields(plugin, marketplace, shareResolver),
    // CAN-3653: provenance the browser needs to join a plugin to the MCP
    // server it bundles and to name the plugin's publisher.
    ...provenanceFields(plugin, installed, marketplace),
  };
}

/**
 * Credential-free provenance for a plugin row: the sanitized http(s) package
 * source URL (never a `file:` host path), the bundled MCP servers, and the
 * bundled skills. Command servers cross without `command`, `args`, or env; an
 * http server whose URL does not sanitize is dropped. Skills cross as name and
 * description only, never their `path`, and only for an installed plugin: the
 * browser lists them under the installed plugin alone (CAN-4844).
 */
function provenanceFields(
  plugin: PluginInfo,
  installed: boolean,
  marketplace: MarketplaceInfo | undefined,
): Pick<
  PortalMarketplacePluginRow,
  'externalSourceUrl' | 'marketplacePackageSourceUrl' | 'mcpServers' | 'skills'
> {
  const sourceUrl = sanitizePortalUrl(plugin.externalSource?.url);
  const externalSourceUrl =
    sourceUrl !== undefined && /^https?:\/\//i.test(sourceUrl)
      ? sourceUrl
      : undefined;
  const marketplacePackageSourceUrl =
    marketplace && !plugin.externalSource?.url
      ? officialMarketplaceRelativePackageUrl(marketplace, plugin.sourcePath)
      : undefined;
  const mcpServers: PortalMarketplacePluginMcpServer[] = [];
  for (const server of plugin.details?.mcpServers ?? []) {
    if (server.type === 'command') {
      mcpServers.push({ name: server.name, type: 'command' });
      continue;
    }
    const url = sanitizePortalUrl(server.url);
    if (url !== undefined) {
      mcpServers.push({ name: server.name, type: 'http', url });
    }
  }
  const skills: PortalMarketplacePluginSkill[] = (
    installed ? (plugin.details?.skills ?? []) : []
  ).map((skill) => ({ name: skill.name, description: skill.description }));
  return {
    ...(externalSourceUrl !== undefined ? { externalSourceUrl } : {}),
    ...(marketplacePackageSourceUrl ? { marketplacePackageSourceUrl } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(skills.length > 0 ? { skills } : {}),
  };
}

/** State and target are resolved together; legacy flags retain compatibility. */
function shareFields(
  plugin: PluginInfo,
  marketplace: MarketplaceInfo | undefined,
  resolver?: MarketplaceShareResolver,
): Pick<
  PortalMarketplacePluginRow,
  'shareable' | 'shareSourceLabel' | 'sharing' | 'foldedMcp'
> {
  const shareResolver =
    resolver ??
    createMarketplaceShareResolver(marketplace ? [marketplace] : []);
  const sharing = shareResolver.plugin(plugin.marketplaceId, plugin.name);
  const foldedMcp = shareResolver.foldedMcp(plugin);
  const fields = { sharing, ...(foldedMcp ? { foldedMcp } : {}) };
  if (sharing.status !== 'shareable' || sharing.target.kind !== 'plugin')
    return fields;
  return {
    ...fields,
    shareable: true,
    shareSourceLabel: sharing.target.sourceLabel,
  };
}

function toMarketplaceRow(
  marketplace: MarketplaceInfo,
  shareResolver: MarketplaceShareResolver = createMarketplaceShareResolver([
    marketplace,
  ]),
): PortalMarketplaceRow {
  return {
    id: marketplace.id,
    name: marketplace.name,
    sourceType: marketplace.sourceType,
    // Sanitized: source URLs can embed credentials in userinfo/query.
    sourceUrl: sanitizePortalSourceRef(marketplace.sourceUrl),
    pluginCount: marketplace.pluginCount,
    validProviders: marketplace.validProviders,
    providerStatus: {
      claude: toProviderStatusRow(marketplace.providerStatus.claude),
      codex: toProviderStatusRow(marketplace.providerStatus.codex),
    },
    plugins: marketplace.plugins.map((plugin) =>
      toPluginRow(plugin, marketplace, shareResolver),
    ),
    ...(marketplace.description !== undefined
      ? { description: marketplace.description }
      : {}),
    ...(marketplace.builtIn !== undefined
      ? { builtIn: marketplace.builtIn }
      : {}),
    ...(marketplace.curated !== undefined
      ? { curated: marketplace.curated }
      : {}),
    ...(marketplace.removable !== undefined
      ? { removable: marketplace.removable }
      : {}),
    ...(marketplace.lastUpdated !== undefined
      ? { lastUpdated: marketplace.lastUpdated }
      : {}),
  };
}

async function readCachedMarketplaces(): Promise<{
  marketplaces: MarketplaceInfo[];
  lastRefreshed: string;
  available: boolean;
}> {
  const { loadMarketplacesCacheOnly } =
    await import('../plugins/plugin-service');
  const result = await loadMarketplacesCacheOnly();
  if (!result.success || !result.data) {
    return { marketplaces: [], lastRefreshed: '', available: false };
  }
  return {
    available: true,
    marketplaces: result.data.marketplaces,
    lastRefreshed: result.data.lastRefreshed,
  };
}

/**
 * `portal.plugins.share_plugin`: resolve the plugin from the cached
 * marketplaces, create the shared plugin in Canopy Cloud and publish its public
 * share, exactly as the desktop Marketplace's Share modal does.
 */
export async function sharePortalPlugin(input: {
  marketplaceId: string;
  pluginName: string;
  scope: PortalShareScope;
  teamId?: string;
  organizationId?: string;
}): Promise<PortalPluginsSharePluginResult> {
  const { marketplaces } = await readCachedMarketplaces();
  const resolver = createMarketplaceShareResolver(marketplaces);
  const found = resolver.findPlugin(input.marketplaceId, input.pluginName);
  if (found.status === 'missing')
    throw new Error('The plugin is no longer in the marketplace cache.');
  if (found.status !== 'resolved')
    throw new Error(MARKETPLACE_SHARE_BLOCKED_REASONS.unavailable);
  const { marketplace, plugin } = found.match;
  const sharing = resolver.plugin(input.marketplaceId, input.pluginName);
  if (sharing.status === 'blocked') throw new Error(sharing.reason);
  const ref = computePluginShareableRef(plugin, marketplace);
  if (!ref) throw new Error(MARKETPLACE_SHARE_BLOCKED_REASONS.noPublicSource);
  // Lazy like this service's other module imports (see the read builders):
  // the Cloud client stays off the catalog read path the portal hydrates on
  // every state refresh, and it is a local module, so the packaged main build
  // resolves it the same way as the plugin-service imports above.
  const {
    assertSharedPluginsSupported,
    createSharedPlugin,
    publishPluginPublicShare,
    updateSharedPlugin,
    revokePluginPublicShare,
  } = await import('../plugins/canopy-server-client');
  // Capability negotiation first, as the IPC share path does (review on #3130).
  // Nothing is published yet, so a failure here is a definite one.
  const { withShareStage } = await import('../sharing/share-operation-result');
  await withShareStage('access', assertSharedPluginsSupported);
  const request = {
    serverId: CANOPY_CLOUD_SERVER_ID,
    ref,
    name: pluginDisplayName(plugin),
    description: plugin.description ?? null,
    shareScope: input.scope === 'public' ? ('private' as const) : input.scope,
    ...(input.scope === 'team'
      ? { teamId: input.teamId }
      : input.scope === 'organization'
        ? {
            organizationId: input.organizationId,
          }
        : {}),
  };
  let shared = await createSharedPlugin(request);
  // Revoke before changing a scoped owner so a failed revoke cannot leave
  // the old public link live alongside the newly selected audience.
  if (
    input.scope !== 'public' &&
    shared.publicShare &&
    !(await preserveOrganizationPublicLink(shared.owner))
  ) {
    await revokePluginPublicShare(shared.externalId);
  }
  const ownerChanged =
    (shared.shareScope ?? 'private') !== request.shareScope ||
    (input.scope === 'team' &&
      (shared.owner?.type !== 'team' || shared.owner.id !== input.teamId)) ||
    (input.scope === 'organization' &&
      (shared.owner?.type !== 'organization' ||
        shared.owner.id !== input.organizationId));
  if (ownerChanged) {
    shared = await updateSharedPlugin({
      ...request,
      remoteId: shared.externalId,
    });
  }
  if (input.scope === 'public') {
    const published = await publishPluginPublicShare(shared.externalId);
    return { sharePath: published.sharePath };
  }
  return {
    sharePath: `/portal/plugins/plugins/shared/${encodeURIComponent(shared.externalId)}`,
  };
}

/** Build the `portal.plugins.list_marketplaces` result (cache-only). */
export async function listPortalMarketplaces(): Promise<PortalPluginsListMarketplacesResult> {
  const { marketplaces, lastRefreshed } = await readCachedMarketplaces();
  const resolver = createMarketplaceShareResolver(marketplaces);
  return fitListToResultBudget(
    marketplaces.map((marketplace) => toMarketplaceRow(marketplace, resolver)),
    (rows, truncated) => ({
      marketplaces: rows,
      lastRefreshed,
      ...(truncated ? { truncated: true } : {}),
    }),
  );
}

function requirePlainId(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    throw codedError('invalid_payload', `Invalid ${label}.`);
  }
  return value;
}

async function findCachedPlugin(
  marketplaceId: string,
  pluginName: string,
): Promise<{
  marketplace: MarketplaceInfo;
  plugin: PluginInfo;
  shareResolver: MarketplaceShareResolver;
}> {
  const { marketplaces } = await readCachedMarketplaces();
  const resolver = createMarketplaceShareResolver(marketplaces);
  const found = resolver.findPlugin(marketplaceId, pluginName);
  if (found.status === 'ambiguous')
    throw codedError(
      'not_found',
      MARKETPLACE_SHARE_BLOCKED_REASONS.unavailable,
    );
  if (found.status !== 'resolved')
    throw codedError(
      'not_found',
      `Plugin "${pluginName}" not found in marketplace "${marketplaceId}".`,
    );
  return {
    ...found.match,
    shareResolver: resolver,
  };
}

/**
 * Resolve the trusted read root for a cached plugin, mirroring the desktop
 * renderer's derivation (PluginDetailView): provider facets already resolve
 * to plugin roots; older top-level records use a marketplace root plus
 * `sourcePath`. The result feeds `readComponentContent`, which re-validates
 * everything against the known trusted roots — the browser never supplies a
 * path.
 */
function resolvePluginReadRoot(
  marketplace: MarketplaceInfo,
  plugin: PluginInfo,
): { installLocation: string; pluginSourcePath: string } {
  const facet: PluginProviderFacet | undefined =
    plugin.facets.claude ??
    plugin.facets.codex ??
    plugin.facets.codexCompatibility;
  const facetInstallRoot = facet?.cachePath ?? facet?.installLocation;
  const installLocation =
    facetInstallRoot ?? plugin.cachePath ?? marketplace.installLocation;
  const pluginSourcePath = facetInstallRoot
    ? ''
    : (facet?.sourcePath ?? (plugin.cachePath ? '' : plugin.sourcePath));
  return { installLocation, pluginSourcePath };
}

function resolvePluginDetails(
  plugin: PluginInfo,
): PortalPluginDetailResult['details'] {
  return (
    plugin.details ??
    plugin.facets.claude?.details ??
    plugin.facets.codex?.details ??
    plugin.facets.codexCompatibility?.details ??
    null
  );
}

/** Build the `portal.plugins.get_plugin_detail` result (cache-only + README read). */
export async function getPortalPluginDetail(
  marketplaceId: string,
  pluginName: string,
): Promise<PortalPluginDetailResult> {
  requirePlainId(marketplaceId, 'marketplace id');
  requirePlainId(pluginName, 'plugin name');
  const { marketplace, plugin, shareResolver } = await findCachedPlugin(
    marketplaceId,
    pluginName,
  );
  const details = resolvePluginDetails(plugin);

  let readme: PortalPluginDetailResult['readme'] = null;
  if (details?.hasReadme) {
    try {
      const { readComponentContent } =
        await import('../plugins/plugin-service');
      const { installLocation, pluginSourcePath } = resolvePluginReadRoot(
        marketplace,
        plugin,
      );
      const result = readComponentContent(
        installLocation,
        pluginSourcePath,
        'README.md',
      );
      if (result.success && result.data) {
        readme = truncateBody(result.data.body);
      }
    } catch {
      // A missing/unreadable README must not fail the whole detail.
      readme = null;
    }
  }

  const homepage = sanitizePortalUrl(plugin.homepage);
  const complete: PortalPluginDetailResult = {
    marketplaceId: marketplace.id,
    marketplaceName: marketplace.name,
    plugin: toPluginRow(plugin, marketplace, shareResolver),
    details: sanitizePluginDetails(details),
    readme,
    // The Portal lists the same harness rows as this desktop (CAN-4842).
    harnesses: offeredPluginHarnesses({
      cursor: isCursorHarnessEnabled(),
      copilot: isCopilotHarnessEnabled(),
      opencode: isOpenCodeHarnessEnabled(),
    }),
    // Per-provider install state and the Codex compatibility setting, read
    // the way the desktop plugin page reads them.
    ...(plugin.globalInstallStatus
      ? {
          harnessInstallation: {
            claude: plugin.globalInstallStatus.claude?.installed ?? false,
            codex: plugin.globalInstallStatus.codex?.installed ?? false,
          },
        }
      : {}),
    ...(plugin.codexCompatDisabled === true
      ? { codexCompatDisabled: true }
      : {}),
    ...(homepage !== undefined ? { homepage } : {}),
  };
  // Deterministic degrade ladder: shrink the README body (by SERIALIZED
  // size), then drop it, then drop the component lists.
  return enforcePortalResultBudget(complete, [
    (current): PortalPluginDetailResult => {
      if (!current.readme) {
        return current;
      }
      const seeded: PortalPluginDetailResult = { ...current, truncated: true };
      return halveBodyToBudget(
        seeded,
        (result): string => result.readme?.body ?? '',
        (result, body): PortalPluginDetailResult => ({
          ...result,
          readme: { body, truncated: true },
        }),
      );
    },
    (current): PortalPluginDetailResult => ({
      ...current,
      readme: null,
      truncated: true,
    }),
    (current): PortalPluginDetailResult => ({
      ...current,
      details: null,
      truncated: true,
    }),
  ]);
}

/**
 * Sanitize the plugin-manifest component lists before they cross the portal
 * boundary: MCP server `url` fields are URLs and get the standard
 * scheme+host+port+path treatment (field omitted when unparseable).
 */
function sanitizePluginDetails(
  details: PortalPluginDetailResult['details'],
): PortalPluginDetailResult['details'] {
  if (!details) {
    return details;
  }
  return {
    ...details,
    mcpServers: details.mcpServers.map((server) => {
      const url = sanitizePortalUrl(server.url);
      const sanitized = { ...server };
      delete sanitized.url;
      return { ...sanitized, ...(url !== undefined ? { url } : {}) };
    }),
  };
}

/**
 * Final size guard for markdown content results, measured on the SERIALIZED
 * form (JSON escaping can expand a byte-capped body several-fold): halve the
 * body until the envelope fits, then drop pathological frontmatter (and
 * re-shrink in case both were oversized).
 */
function fitMarkdownContentToBudget(
  content: PortalCatalogMarkdownContent,
): PortalCatalogMarkdownContent {
  return enforcePortalResultBudget(content, [
    (current): PortalCatalogMarkdownContent => {
      const seeded: PortalCatalogMarkdownContent = {
        ...current,
        truncated: true,
      };
      return halveBodyToBudget(
        seeded,
        (result): string => result.body,
        (result, body): PortalCatalogMarkdownContent => ({ ...result, body }),
      );
    },
    (current): PortalCatalogMarkdownContent => ({
      frontmatter: {},
      body: current.body,
      truncated: true,
    }),
    (current): PortalCatalogMarkdownContent =>
      halveBodyToBudget(
        current,
        (result): string => result.body,
        (result, body): PortalCatalogMarkdownContent => ({ ...result, body }),
      ),
  ]);
}

/**
 * Build the `portal.plugins.read_component_content` result. `componentFile`
 * comes from the browser but MUST be a plugin-relative path: absolute paths
 * are rejected here, and `readComponentContent` re-resolves the file under
 * the plugin's trusted root (rejecting traversal outside it).
 */
export async function readPortalPluginComponent(
  marketplaceId: string,
  pluginName: string,
  componentFile: string,
): Promise<PortalCatalogMarkdownContent> {
  requirePlainId(marketplaceId, 'marketplace id');
  requirePlainId(pluginName, 'plugin name');
  requirePlainId(componentFile, 'component file');
  if (
    path.isAbsolute(componentFile) ||
    /^[A-Za-z]:[\\/]/.test(componentFile) ||
    componentFile.startsWith('\\\\')
  ) {
    throw codedError('invalid_payload', 'Component file must be relative.');
  }
  const { marketplace, plugin } = await findCachedPlugin(
    marketplaceId,
    pluginName,
  );
  const { readComponentContent } = await import('../plugins/plugin-service');
  const { installLocation, pluginSourcePath } = resolvePluginReadRoot(
    marketplace,
    plugin,
  );
  const result = readComponentContent(
    installLocation,
    pluginSourcePath,
    componentFile,
  );
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to read component content.');
  }
  const { body, truncated } = truncateBody(result.data.body);
  return fitMarkdownContentToBudget({
    frontmatter: result.data.frontmatter,
    body,
    truncated,
  });
}

/**
 * Build the `portal.skills.list` result from the installed-skill inventory.
 * A `loadSkills` failure FAILS the command (it must not collapse to an empty
 * list): the web client renders a genuinely empty result as "no skills", so
 * only a successful read may report one.
 */
/**
 * Whether the desktop can share this installed skill. Mirrors the Skills tab's
 * own rule exactly (built-ins are shared as snapshot copies under the sharer's
 * account); plugin-owned and external skills stay out of the flow.
 */
function canSharePortalSkill(skill: {
  sourceId: string;
  builtIn?: boolean;
  custom?: boolean;
}): boolean {
  return (
    (skill.custom === true && skill.sourceId === 'custom:app') ||
    (skill.builtIn === true && skill.sourceId === 'builtin:app')
  );
}

async function buildPortalSkillsList(
  filter: typeof filterStoredSkillContexts,
  includeInstallOrigin = false,
): Promise<PortalSkillsListResult> {
  const { loadSkills: loadInstalledSkills } =
    await import('../skills/skill-service');
  const result = loadInstalledSkills();
  if (result.success && result.data) result.data = await filter(result.data);
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to load installed skills.');
  }
  // Paired-device display may read receipt names. Personal catalog sync uses
  // this builder too and must never annotate or publish those local snapshots.
  if (includeInstallOrigin)
    result.data = await annotateSharedSkillInstalls(result.data);
  const identityCounts = new Map<string, number>();
  for (const skill of result.data) {
    const key = JSON.stringify([skill.sourceId, skill.name]);
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
  }
  return fitListToResultBudget(
    result.data.map((skill) => {
      const unique =
        identityCounts.get(JSON.stringify([skill.sourceId, skill.name])) === 1;
      const sharing: MarketplaceEntryShareResolution =
        unique && canSharePortalSkill(skill)
          ? {
              status: 'shareable',
              target: {
                kind: 'skill',
                sourceId: skill.sourceId,
                skillName: skill.name,
              },
            }
          : {
              status: 'blocked',
              reason: MARKETPLACE_SHARE_BLOCKED_REASONS.unavailable,
            };
      return {
        name: skill.name,
        sourceId: skill.sourceId,
        sharing,
        ...(skill.remote ? { shareRemoteId: skill.remote.remoteId } : {}),
        ...(sharing.status === 'shareable' ? { shareable: true } : {}),
        description: skill.description,
        source: skill.source,
        installedAt: skill.installedAt,
        updatedAt: skill.updatedAt,
        updateAvailable: skill.updateAvailable,
        ...(skill.builtIn !== undefined ? { builtIn: skill.builtIn } : {}),
        ...(skill.custom !== undefined ? { custom: skill.custom } : {}),
        ...(includeInstallOrigin && skill.installedFromShare
          ? { installedFromShare: skill.installedFromShare }
          : {}),
      };
    }),
    (rows, truncated) => ({
      skills: rows,
      ...(truncated ? { truncated: true } : {}),
    }),
  );
}

export async function listPortalSkills(): Promise<PortalSkillsListResult> {
  return buildPortalSkillsList(filterStoredSkillContexts, true);
}

export async function listPersonalPortalSkills(): Promise<PortalSkillsListResult> {
  return buildPortalSkillsList(filterPersonalStoredSkills);
}

/**
 * Build the `portal.skills.read` result. `sourceId`/`skillName` are plain
 * identifiers (no path separators); `readSkillContent` re-validates the skill
 * directory against the trusted skills root.
 */
export async function readPortalSkill(
  sourceId: string,
  skillName: string,
): Promise<PortalCatalogMarkdownContent> {
  requirePlainId(sourceId, 'skill source id');
  requirePlainId(skillName, 'skill name');
  if (/[\\/]/.test(sourceId) || /[\\/]/.test(skillName)) {
    throw codedError(
      'invalid_payload',
      'Skill identifiers must not contain path separators.',
    );
  }
  let content: {
    frontmatter: Record<string, unknown>;
    body: string;
    truncated: boolean;
  };
  try {
    const { readSkillContentThroughCore } =
      await import('../canopy-runtime/skill-catalog-dispatch');
    content = await readSkillContentThroughCore(sourceId, skillName);
  } catch (error) {
    if (error instanceof SkillServiceResultError)
      throw codedError('not_found', error.message);
    throw error;
  }
  const { body, truncated } = truncateBody(content.body);
  return fitMarkdownContentToBudget({
    frontmatter: content.frontmatter,
    body,
    truncated: truncated || content.truncated,
  });
}

/** Cache-derived service read once per response; failures leave health unavailable. */
async function readPortalMcpStatuses(): Promise<McpServerStatusEntry[]> {
  try {
    const { listMcpServerStatuses } = await import('../mcp/connection-status');
    return await listMcpServerStatuses();
  } catch {
    return [];
  }
}

function selectPortalMcpStatus(
  statuses: Awaited<ReturnType<typeof readPortalMcpStatuses>>,
  serverId: string,
  configIds: string[],
  account: boolean,
): PortalMcpServerStatus | undefined {
  const matches = statuses.filter(
    (candidate) =>
      candidate.serverId === serverId &&
      (candidate.handler === 'account') === account &&
      candidate.configs.every((config) => configIds.includes(config.configId)),
  );
  const projected = projectPortalMcpStatus(matches[0]);
  if (
    projected?.handler === 'account' &&
    projected.lastCheckedAt === undefined
  ) {
    // The account inventory has one cached entry per connection/configuration.
    // Combine only configurations belonging to this exact selected identity.
    projected.configs = matches.flatMap(
      (candidate) => projectPortalMcpStatus(candidate)?.configs ?? [],
    );
    projected.connectionStatus = projected.configs.some(
      (config) => config.authStatus === 'error',
    )
      ? 'auth_required'
      : projected.configs.length === configIds.length &&
          projected.configs.every((config) => config.authStatus === 'connected')
        ? 'connected'
        : 'unknown';
  }
  return projected;
}

/**
 * Build `portal.mcp.list_servers` from the persisted device index and the
 * existing account inventory cache, plus the existing advertised provider read.
 * Optional provider discovery gets only a short wait; it never starts OAuth.
 *
 * Like {@link listPortalSkills}, a read or parse failure FAILS the command
 * (it must not collapse to an empty list): the web client renders a genuinely
 * empty result as "no servers", so only a successful read may report one. A
 * missing index file (ENOENT) means no device servers; account-only rows can
 * still be present.
 */
export async function listPortalMcpServers(): Promise<PortalMcpListServersResult> {
  let raw: string;
  try {
    raw = await readFile(getMcpServersIndexFilePath(), 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      raw = JSON.stringify({ servers: [] });
    } else {
      throw error;
    }
  }
  // Malformed JSON throws → the adapter fails the command (execution_failed).
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.servers)) {
    // Mirrors the collections index reader: an index that parses but has an
    // unexpected shape is treated as empty rather than failing the command.
    return { servers: [] };
  }
  const servers: PortalMcpServerRow[] = [];
  for (const server of parsed.servers) {
    if (!isServerEntry(server)) {
      continue;
    }
    const logoUrl = sanitizePortalUrl(
      typeof server.logoUrl === 'string' ? server.logoUrl : undefined,
    );
    servers.push({
      id: server.id,
      name: server.name,
      description: server.description,
      type: server.type,
      configs: server.configs.map((config) => ({
        id: config.id,
        name: config.name,
        enabled: config.enabled,
      })),
      updatedAt: typeof server.updatedAt === 'string' ? server.updatedAt : '',
      ...(server.scope === 'account' || server.scope === 'device'
        ? { scope: server.scope }
        : {}),
      ...(server.authHandler === 'account' ||
      server.authHandler === 'canopy' ||
      server.authHandler === 'provider'
        ? { authHandler: server.authHandler }
        : {}),
      ...(typeof server.accountConnectionId === 'string'
        ? { accountConnectionId: server.accountConnectionId }
        : {}),
      // Sanitized like every portal URL; omitted when unparseable.
      ...(logoUrl !== undefined ? { logoUrl } : {}),
      ...(typeof server.curatedKey === 'string'
        ? { curatedKey: server.curatedKey }
        : {}),
      ...(typeof server.urlHost === 'string'
        ? { urlHost: server.urlHost }
        : {}),
      ...(typeof server.urlScheme === 'string'
        ? { urlScheme: server.urlScheme }
        : {}),
    });
  }
  // Account-only rows have no device index entry. Carry their cached auth
  // status too, so the Portal's separately synthesized account inventory can
  // match by canonical server/config identity. One bounded metadata read,
  // shared with the existing account cache; never an MCP endpoint probe.
  const { loadAccountMcpRefConnections } =
    await import('../mcp/account-catalog');
  const connections = await loadAccountMcpRefConnections({
    waitMs: PORTAL_ACCOUNT_MCP_LOOKUP_WAIT_MS,
  }).catch(() => null);
  for (const connection of connections ?? []) {
    const detail = toPortalAccountMcpServer([connection]);
    if (
      !detail ||
      servers.some(
        (server) =>
          server.scope === 'account' &&
          server.id === connection.serverKey &&
          server.configs.some((config) => config.id === connection.configId),
      )
    )
      continue;
    servers.push({
      id: detail.id,
      name: detail.name,
      description: detail.description,
      type: 'http',
      scope: 'account',
      authHandler: 'account',
      updatedAt: '',
      configs: detail.configs.map((config) => ({
        id: config.id,
        name: config.name,
        enabled: config.enabled,
      })),
      accountConnectionId: connection.id,
      // Only portable status and configuration identity cross the boundary;
      // account route IDs, tool policy and future service fields stay private.
      status: detail.status,
      ...(connection.kind === 'CURATED'
        ? { curatedKey: connection.serverKey }
        : {}),
    });
  }
  // Reuse the desktop's provider read without holding cached inventory behind
  // its CLI health checks. Only completed link facts cross the boundary;
  // CLI diagnostics, install URLs and host paths stay local.
  const providerConnectors = await readPortalProviderConnectors();
  const statuses = servers.length ? await readPortalMcpStatuses() : [];
  const shareResolver = servers.some(
    (server) => server.curatedKey !== undefined,
  )
    ? await cachedMarketplaceShareResolver()
    : createMarketplaceShareResolver([]);
  return fitListToResultBudget(
    servers.map((server) => ({
      ...server,
      sharing: shareResolver.mcp(server.curatedKey),
      status:
        selectPortalMcpStatus(
          statuses,
          server.id,
          server.configs.map((config) => config.id),
          server.scope === 'account' || server.authHandler === 'account',
        ) ?? server.status,
    })),
    (rows, truncated) => ({
      servers: rows,
      ...(providerConnectors.length ? { providerConnectors } : {}),
      ...(truncated ? { truncated: true } : {}),
    }),
  );
}

type PortalProviderFacts = NonNullable<
  PortalMcpListServersResult['providerConnectors']
>;

interface PortalProviderDiscovery {
  request: Promise<PortalProviderFacts>;
  timedOutProjection?: string;
}

interface PortalProviderContext {
  scope: string;
  facts: PortalProviderFacts;
  pending?: PortalProviderDiscovery;
}

let portalProviderContext: PortalProviderContext | undefined;

/** Use existing observed auth boundaries; never probe or read credentials. */
async function portalProviderScope(): Promise<string> {
  const account = await resourceAccountSnapshot();
  const { peekProviderAccountIdentity } =
    await import('../auth/provider-auth-state');
  return JSON.stringify([
    account,
    peekProviderAccountIdentity('claude')?.providerAccountKey ?? null,
    peekProviderAccountIdentity('codex')?.providerAccountKey ?? null,
    process.env.CODEX_HOME ?? null,
  ]);
}

/** Preserve boundary-visible distinctions, ignoring irrelevant list ordering. */
function portalProviderProjection(facts: PortalProviderFacts): string {
  return JSON.stringify(
    facts
      .map(({ provider, connectors }) =>
        JSON.stringify([
          provider,
          connectors
            .map(({ displayName, connected }) =>
              JSON.stringify([displayName, connected]),
            )
            .sort(),
        ]),
      )
      .sort(),
  );
}

async function settlePortalProviderDiscovery(
  context: PortalProviderContext,
  discovery: PortalProviderDiscovery,
  facts: PortalProviderFacts,
): Promise<PortalProviderFacts> {
  const scope = await portalProviderScope();
  if (portalProviderContext !== context || context.scope !== scope) return [];
  context.facts = facts;
  if (
    discovery.timedOutProjection !== undefined &&
    discovery.timedOutProjection !== portalProviderProjection(facts)
  )
    notifyDesktopInventoryChanged(['mcp_servers']);
  return facts;
}

async function readPortalProviderConnectors(): Promise<PortalProviderFacts> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let context = portalProviderContext;
  try {
    const scope = await portalProviderScope();
    if (portalProviderContext?.scope !== scope)
      portalProviderContext = { scope, facts: [] };
    context = portalProviderContext;
    const currentContext = context;
    if (!context.pending) {
      const discovery: PortalProviderDiscovery = {
        request: listAdvertisedProviderConnectors()
          .then(
            (rows) =>
              settlePortalProviderDiscovery(
                currentContext,
                discovery,
                rows.map(({ provider, connectors }) => ({
                  provider,
                  connectors: connectors.map(({ displayName, connected }) => ({
                    displayName,
                    connected,
                  })),
                })),
              ),
            // A rejected discovery clears held facts, rather than retaining
            // a stale connected state. This is still an optional-read failure.
            () => {
              currentContext.facts = [];
              return settlePortalProviderDiscovery(
                currentContext,
                discovery,
                [],
              );
            },
          )
          .finally(() => {
            if (currentContext.pending === discovery)
              currentContext.pending = undefined;
          }),
      };
      context.pending = discovery;
    }
    const discovery = context.pending;
    const timeout = new Promise<PortalProviderFacts>((resolve): void => {
      timer = setTimeout((): void => {
        discovery.timedOutProjection ??= portalProviderProjection(
          currentContext.facts,
        );
        resolve(currentContext.facts);
      }, 250);
      timer.unref?.();
    });
    const facts = await Promise.race([discovery.request, timeout]);
    const currentScope = await portalProviderScope();
    return portalProviderContext === context && scope === currentScope
      ? facts
      : [];
  } catch {
    // An unavailable context cannot authorize retained optional facts.
    if (portalProviderContext === context) portalProviderContext = undefined;
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Failed inventory reads cannot establish standalone MCP status for a curated entry. */
async function cachedMarketplaceShareResolver(): Promise<MarketplaceShareResolver> {
  const cached = await readCachedMarketplaces().catch(() => ({
    marketplaces: [],
    lastRefreshed: '',
    available: false,
  }));
  if (cached.available)
    return createMarketplaceShareResolver(cached.marketplaces);
  const resolver = createMarketplaceShareResolver([]);
  return {
    ...resolver,
    mcp: (key): MarketplaceEntryShareResolution =>
      key === undefined
        ? resolver.mcp(key)
        : {
            status: 'blocked',
            reason: MARKETPLACE_SHARE_BLOCKED_REASONS.unavailable,
          },
  };
}

/** Device server ids and curated catalog keys. */
const SAFE_MCP_SERVER_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Account custom server keys, minted by the cloud as `custom:<uuid>`. */
const CUSTOM_ACCOUNT_MCP_SERVER_ID_RE =
  /^custom:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Bounds the account connection read so a slow cloud fails the command. */
const PORTAL_ACCOUNT_MCP_LOOKUP_WAIT_MS = 5_000;

/**
 * Whether `serverId` has a shape `portal.mcp.*` commands accept: a plain
 * slug (device server id or curated key) or an account custom key
 * `custom:<uuid>`. Anything else, including path-shaped values, is refused
 * before any file or cloud read.
 */
export function isPortalMcpServerId(serverId: string): boolean {
  return (
    SAFE_MCP_SERVER_ID_RE.test(serverId) ||
    CUSTOM_ACCOUNT_MCP_SERVER_ID_RE.test(serverId)
  );
}

function requirePortalMcpServerId(serverId: string): string {
  requirePlainId(serverId, 'MCP server id');
  if (!isPortalMcpServerId(serverId)) {
    throw codedError('invalid_payload', 'Invalid MCP server id.');
  }
  return serverId;
}

/**
 * The account connections serving `serverId`, default configuration first.
 * Empty when account connections are off, unreadable, or none match.
 */
async function findPortalAccountMcpConnections(
  serverId: string,
): Promise<AccountMcpConnection[]> {
  const { loadAccountMcpRefConnections } =
    await import('../mcp/account-catalog');
  const connections = await loadAccountMcpRefConnections({
    waitMs: PORTAL_ACCOUNT_MCP_LOOKUP_WAIT_MS,
  });
  const kind = isCustomAccountMcpServerKey(serverId) ? 'CUSTOM' : 'CURATED';
  return (connections ?? [])
    .filter(
      (connection) =>
        connection.kind === kind && connection.serverKey === serverId,
    )
    .sort(
      (a, b) =>
        Number(b.configId === 'default') - Number(a.configId === 'default') ||
        a.id.localeCompare(b.id),
    );
}

/** `https://<host>` for a bare upstream hostname; anything else is dropped. */
function accountMcpUpstreamUrl(host: string | undefined): string | undefined {
  if (typeof host !== 'string' || host.length === 0) return undefined;
  try {
    const parsed = new URL(`https://${host}`);
    return parsed.host === host.toLowerCase()
      ? sanitizePortalUrl(parsed.toString())
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * REDACTED `portal.mcp.get_server` projection of account connections. The
 * cloud holds every credential, so only names, the upstream host, and a
 * per-configuration signed-in flag cross the boundary.
 */
function toPortalAccountMcpServer(
  connections: readonly AccountMcpConnection[],
): PortalMcpServerDetail | undefined {
  const [primary] = connections;
  if (!primary) return undefined;
  const url = accountMcpUpstreamUrl(primary.upstreamHost);
  return {
    id: primary.serverKey,
    name: primary.displayName,
    description: '',
    type: 'http',
    scope: 'account',
    status: {
      connectionStatus: connections.some(
        (connection) => connection.status === 'REAUTH_REQUIRED',
      )
        ? 'auth_required'
        : connections.every((connection) => connection.status === 'CONNECTED')
          ? 'connected'
          : 'unknown',
      reachability: 'unknown',
      handler: 'account',
      configs: connections.map((connection) => ({
        configId: connection.configId,
        authStatus:
          connection.status === 'CONNECTED'
            ? 'connected'
            : connection.status === 'REAUTH_REQUIRED'
              ? 'error'
              : 'not_connected',
      })),
    },
    // The cloud reports no timestamps for a connection; none are invented.
    ...(url !== undefined ? { url } : {}),
    configs: connections.map((connection) => ({
      id: connection.configId,
      name: connection.configId === 'default' ? 'Default' : connection.configId,
      description: '',
      enabled: true,
      envVarNames: [],
      extraArgCount: 0,
      // Presence only; header names and values stay in the cloud.
      extraHeaderNames: [],
      ...(typeof connection.hasExtraHeaders === 'boolean'
        ? { hasExtraHeaders: connection.hasExtraHeaders }
        : {}),
      hasAuthToken:
        connection.status === 'CONNECTED' && connection.authMode !== 'NONE',
      createdAt: '',
      updatedAt: '',
    })),
  };
}

/**
 * Sanitize a URL for portal exposure: keep scheme + host + port + path only.
 * Userinfo, query string, and fragment are stripped — all three positions can
 * embed credentials (`https://user:token@host/…?token=…#…`). Unparseable
 * input returns undefined so the field is omitted entirely rather than
 * forwarded raw.
 */
/** Artwork revisions may live in the query. Credentials and fragments do not. */
function sanitizePortalArtworkUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return undefined;
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function sanitizePortalUrl(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    // `origin` excludes userinfo. Non-special schemes report origin 'null';
    // rebuild from protocol + host (also userinfo-free) for those.
    const base =
      parsed.origin !== 'null'
        ? parsed.origin
        : `${parsed.protocol}//${parsed.host}`;
    return `${base}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Explicit field-by-field projection of stored curated MCP metadata for the
 * portal — never forwards the stored object wholesale, and every URL field is
 * individually sanitized (omitted when unparseable).
 */
function toPortalCuratedMetadata(
  curated: McpServerCuratedMetadata,
): PortalMcpCuratedMetadata {
  const logoUrl = sanitizePortalUrl(curated.logoUrl);
  const docsUrl = sanitizePortalUrl(curated.docsUrl);
  const supportUrl = sanitizePortalUrl(curated.supportUrl);
  const privacyPolicyUrl = sanitizePortalUrl(curated.privacyPolicyUrl);
  const authorUrl = sanitizePortalUrl(curated.authorUrl);
  return {
    key: curated.key,
    ...(logoUrl !== undefined ? { logoUrl } : {}),
    ...(docsUrl !== undefined ? { docsUrl } : {}),
    ...(supportUrl !== undefined ? { supportUrl } : {}),
    ...(privacyPolicyUrl !== undefined ? { privacyPolicyUrl } : {}),
    ...(curated.authorName !== undefined
      ? { authorName: curated.authorName }
      : {}),
    ...(authorUrl !== undefined ? { authorUrl } : {}),
    ...(curated.requiresProviderAuth !== undefined
      ? { requiresProviderAuth: curated.requiresProviderAuth }
      : {}),
  };
}

/**
 * Sanitize a marketplace/source REFERENCE for portal exposure. Anything with
 * a scheme separator is a URL and goes through {@link sanitizePortalUrl}
 * (collapsing to '' when unparseable rather than leaking the raw value);
 * opaque refs (`owner/repo`, `builtin:app`, `curated:cloud`) pass through
 * unchanged. SSH-style refs with userinfo (`git@host:path`) are reduced to
 * the part after the userinfo.
 */
function sanitizePortalSourceRef(raw: string): string {
  if (raw.includes('://')) {
    return sanitizePortalUrl(raw) ?? '';
  }
  const atIndex = raw.lastIndexOf('@');
  if (atIndex !== -1) {
    return raw.slice(atIndex + 1);
  }
  return raw;
}

/**
 * Build the REDACTED `portal.mcp.get_server` result. Secrets never leave the
 * desktop: the bearer token collapses to a presence flag, env var and header
 * VALUES are stripped (names only), CLI argument vectors collapse to counts
 * (they routinely carry tokens/passwords), the OAuth client id/secret reduce
 * to presence flags, and every URL is sanitized via {@link sanitizePortalUrl}.
 * Never triggers health checks or OAuth.
 */
export async function getPortalMcpServer(
  serverId: string,
): Promise<PortalMcpGetServerResult> {
  requirePortalMcpServerId(serverId);
  // A device file wins, matching plugin resolution. Account custom keys never
  // name a device file, so they never reach a file path.
  let file: McpServerFile | undefined;
  if (!isCustomAccountMcpServerKey(serverId)) {
    const { readServer } = await import('../ipc/mcp-servers');
    try {
      file = await readServer(serverId);
    } catch {
      file = undefined;
    }
  }
  if (!file) {
    const account = toPortalAccountMcpServer(
      await findPortalAccountMcpConnections(serverId),
    );
    if (!account) {
      throw codedError('not_found', `MCP server "${serverId}" not found.`);
    }
    const sharing = (
      account.curated
        ? await cachedMarketplaceShareResolver()
        : createMarketplaceShareResolver([])
    ).mcp(account.curated?.key);
    const cachedStatus = selectPortalMcpStatus(
      await readPortalMcpStatuses(),
      serverId,
      account.configs.map((config) => config.id),
      true,
    );
    if (cachedStatus) account.status = cachedStatus;
    return fitListToResultBudget(account.configs, (rows, truncated) => ({
      server: { ...account, configs: rows, sharing },
      ...(truncated ? { truncated: true } : {}),
    }));
  }
  const { definition, configs } = file.server;

  const redactedConfigs: PortalMcpServerConfigDetail[] = configs.map(
    (config) => ({
      id: config.id,
      name: config.name,
      description: config.description,
      enabled: config.enabled,
      envVarNames: Object.keys(config.envVars ?? {}),
      // COUNT only: raw args are arbitrary user config and can carry secrets.
      extraArgCount: Array.isArray(config.extraArgs)
        ? config.extraArgs.length
        : 0,
      extraHeaderNames: Object.keys(config.extraHeaders ?? {}),
      hasAuthToken:
        typeof config.authToken === 'string' && config.authToken.length > 0,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    }),
  );

  const sanitizedUrl = sanitizePortalUrl(definition.url);
  const sanitizedAuthorizationUrl = sanitizePortalUrl(
    definition.oauth?.authorizationUrl,
  );
  const sanitizedTokenUrl = sanitizePortalUrl(definition.oauth?.tokenUrl);

  const sharing = (
    definition.curated
      ? await cachedMarketplaceShareResolver()
      : createMarketplaceShareResolver([])
  ).mcp(definition.curated?.key);
  const { resolveStandaloneHttpHandler } = await import('../ipc/mcp-servers');
  const effectiveHandler =
    definition.type === 'http'
      ? await resolveStandaloneHttpHandler(definition)
      : undefined;
  const status = selectPortalMcpStatus(
    await readPortalMcpStatuses(),
    serverId,
    configs.map((config) => config.id),
    effectiveHandler === 'account',
  );
  const server: PortalMcpServerDetail = {
    ...(/^[a-f0-9-]+$/.test(serverId) &&
    definition.id === serverId &&
    effectiveHandler !== 'provider'
      ? {
          managementTarget: {
            serverId,
            testConfigIds: configs
              .filter((config) => /^[a-f0-9-]+$/.test(config.id))
              .map((config) => config.id),
          },
        }
      : {}),
    status,
    sharing,
    id: definition.id,
    name: definition.name,
    description: definition.description,
    type: definition.type,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    configs: redactedConfigs,
    ...(definition.command !== undefined
      ? { command: definition.command }
      : {}),
    // COUNT only: raw args are arbitrary user config and can carry secrets.
    ...(definition.args !== undefined
      ? { argCount: definition.args.length }
      : {}),
    ...(sanitizedUrl !== undefined ? { url: sanitizedUrl } : {}),
    ...(definition.headers !== undefined
      ? { headerNames: Object.keys(definition.headers) }
      : {}),
    ...(definition.oauth !== undefined
      ? {
          oauth: {
            hasClientId:
              typeof definition.oauth.clientId === 'string' &&
              definition.oauth.clientId.length > 0,
            hasClientSecret:
              typeof definition.oauth.clientSecret === 'string' &&
              definition.oauth.clientSecret.length > 0,
            ...(sanitizedAuthorizationUrl !== undefined
              ? { authorizationUrl: sanitizedAuthorizationUrl }
              : {}),
            ...(sanitizedTokenUrl !== undefined
              ? { tokenUrl: sanitizedTokenUrl }
              : {}),
            ...(definition.oauth.scopes !== undefined
              ? { scopes: definition.oauth.scopes }
              : {}),
            ...(definition.oauth.audience !== undefined
              ? { audience: definition.oauth.audience }
              : {}),
          },
        }
      : {}),
    ...(definition.curated !== undefined
      ? { curated: toPortalCuratedMetadata(definition.curated) }
      : {}),
    ...(definition.httpAuthHandler !== undefined
      ? { httpAuthHandler: definition.httpAuthHandler }
      : {}),
  };

  return fitListToResultBudget(server.configs, (rows, truncated) => ({
    server: { ...server, configs: rows },
    ...(truncated ? { truncated: true } : {}),
  }));
}

/**
 * Build the `portal.collections.list` result from the Collection index.
 *
 * Like {@link listPortalSkills}, a `readCollectionIndex` failure (e.g. a
 * malformed index file) FAILS the command instead of collapsing to an empty
 * list: the web client renders a genuinely empty result as "no collections",
 * so only a successful read may report one. A missing index file is a
 * genuinely empty inventory (`readCollectionIndex` resolves it to an empty
 * index via the legacy-migration path), not a failure.
 */
export async function listPortalCollections(): Promise<PortalCollectionsListResult> {
  const index = await readCollectionIndex();
  return buildPortalCollectionsList(
    index,
    readCollectionConfig,
    filterStoredSkillContexts,
  );
}

export async function listPersonalPortalCollections(): Promise<PortalCollectionsListResult> {
  const index = await readPersonalCollectionIndex();
  return buildPortalCollectionsList(
    index,
    readPersonalCollectionConfig,
    filterPersonalStoredSkills,
  );
}

async function buildPortalCollectionsList(
  index: Awaited<ReturnType<typeof readCollectionIndex>>,
  readConfig: typeof readCollectionConfig,
  filterSkills: typeof filterStoredSkillContexts,
): Promise<PortalCollectionsListResult> {
  const sharing = await resolveCollectionSharingState(
    index.collections,
    readConfig,
    filterSkills,
  );
  return fitListToResultBudget(
    index.collections.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      updatedAt: entry.updatedAt,
      ...(entry.revision ? { revision: entry.revision } : {}),
      skillCount: entry.skillCount,
      pluginCount: entry.pluginCount,
      mcpServerCount: entry.mcpServerCount,
      ...(sharing.shareable.has(entry.id) ? { shareable: true } : {}),
      ...(sharing.existing.has(entry.id) ? { hasExistingShare: true } : {}),
      ...(entry.remote ? { shareRemoteId: entry.remote.remoteId } : {}),
      ...(entry.sharedSource ? { sharedSource: entry.sharedSource } : {}),
      ...(entry.hasSharedSource ? { hasSharedSource: true } : {}),
      ...(entry.provenanceUnknown ? { provenanceUnknown: true } : {}),
    })),
    (rows, truncated) => ({
      collections: rows,
      ...(truncated ? { truncated: true } : {}),
    }),
  );
}

/**
 * Which Collections the desktop can actually share, decided by the SAME
 * conversion the share command runs. Sharing rejects a Collection that
 * references a skill that is missing or not shareable, or
 * names a plugin whose marketplace is missing or not a shareable source — so
 * advertising Share on any of those offers an action guaranteed to fail
 * (review on #3180).
 *
 * Collections containing MCP servers cannot be shared. Configs are read here
 * for portable refs, while the skill inventory and marketplace cache are
 * loaded once and reused.
 */
async function resolveCollectionSharingState(
  entries: readonly { id: string; mcpServerCount: number }[],
  readConfig: typeof readCollectionConfig,
  filterSkills: typeof filterStoredSkillContexts,
): Promise<{
  shareable: ReadonlySet<string>;
  existing: ReadonlySet<string>;
}> {
  if (entries.length === 0) {
    return { shareable: new Set<string>(), existing: new Set<string>() };
  }
  const { loadSkills } = await import('../skills/skill-service');
  const { convertLocalCollectionToEditable } =
    await import('@canopy/desktop-shared/collections/shared-collection-payload');
  const skillsResult = loadSkills();
  if (skillsResult.success && skillsResult.data)
    skillsResult.data = await filterSkills(skillsResult.data);
  const installedSkills =
    skillsResult.success && skillsResult.data ? skillsResult.data : [];
  const { marketplaces: cached } = await readCachedMarketplaces();
  const marketplaces = cached.map((marketplace) => ({
    id: marketplace.id,
    sourceUrl: marketplace.sourceUrl,
  }));

  const shareable = new Set<string>();
  const existing = new Set<string>();
  for (const entry of entries) {
    try {
      const file = await readConfig(entry.id);
      if (!file?.collection) continue;
      if (file.collection.remote) existing.add(entry.id);
      if (entry.mcpServerCount > 0 || file.collection.mcpServers.length > 0)
        continue;
      const converted = convertLocalCollectionToEditable({
        config: file.collection,
        installedSkills,
        marketplaces,
      });
      if (
        converted.editable.items.some(
          (item) =>
            item.kind === 'draft_custom_skill' &&
            item.localSkillId.startsWith('local:'),
        )
      ) {
        continue;
      }
      shareable.add(entry.id);
    } catch {
      // Not convertible: leave it unshareable rather than offering a Share
      // that cannot succeed.
    }
  }
  return { shareable, existing };
}

/**
 * Build the `portal.collections.get` result. `readCollectionConfig` validates
 * the id against its safe-id pattern before any path use.
 */
type PortalCollectionDraft = PortalCollectionsSavePayload['collection'];

function parseCollectionDraftMembers(
  value: Record<string, unknown>,
): Pick<PortalCollectionDraft, 'skills' | 'plugins' | 'mcpServers'> {
  const { skills, plugins, mcpServers } = value;
  const invalid = (): Error =>
    codedError('invalid_payload', 'Collection save has an invalid member.');
  if (
    !Array.isArray(skills) ||
    !Array.isArray(plugins) ||
    !Array.isArray(mcpServers)
  ) {
    throw invalid();
  }
  return {
    skills: skills.map((skill: unknown) => {
      if (
        !isRecord(skill) ||
        typeof skill.sourceId !== 'string' ||
        typeof skill.skillName !== 'string' ||
        !skill.sourceId.trim() ||
        skill.sourceId.length > 2048 ||
        !skill.skillName.trim() ||
        skill.skillName.length > 2048
      )
        throw invalid();
      return { sourceId: skill.sourceId, skillName: skill.skillName };
    }),
    plugins: plugins.map((plugin: unknown) => {
      if (
        !isRecord(plugin) ||
        typeof plugin.marketplaceId !== 'string' ||
        typeof plugin.pluginName !== 'string' ||
        !plugin.marketplaceId.trim() ||
        plugin.marketplaceId.length > 2048 ||
        !plugin.pluginName.trim() ||
        plugin.pluginName.length > 2048
      )
        throw invalid();
      return {
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.pluginName,
      };
    }),
    mcpServers: mcpServers.map((ref: unknown) => {
      if (
        !isRecord(ref) ||
        typeof ref.serverId !== 'string' ||
        typeof ref.configId !== 'string' ||
        !/^[a-f0-9-]+$/.test(ref.serverId) ||
        !/^[a-f0-9-]+$/.test(ref.configId)
      )
        throw invalid();
      return { serverId: ref.serverId, configId: ref.configId };
    }),
  };
}

/**
 * `portal.collections.save`: create a collection, or replace an existing
 * one's name, description and members. The browser can never set or clear
 * share links or the creation date; an edit keeps the stored values, and an
 * unknown id is refused rather than created under the caller's choice.
 */
export async function savePortalCollection(
  input: unknown,
  assertCurrent?: () => Promise<void>,
): Promise<PortalCollectionsSaveResult> {
  // Capture before lazy imports, reads or waiting for another writer.
  const snapshot = await resourceContextSnapshot();
  const assertOrigin = async (): Promise<void> => {
    await assertCurrent?.();
    await assertResourceContextSnapshot(snapshot);
  };
  if (!isRecord(input)) {
    throw codedError('invalid_payload', 'Collection save needs a collection.');
  }
  // Reserve response space for server-owned metadata, UUIDs and timestamps.
  if (resultByteLength(input) > PORTAL_CATALOG_RESULT_MAX_BYTES - 4096) {
    throw codedError(
      'invalid_payload',
      'The collection is too large to save here.',
    );
  }
  if (
    input.id !== undefined &&
    (typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !/^[a-f0-9-]+$/.test(input.id))
  ) {
    throw codedError('invalid_payload', 'Invalid Collection id.');
  }
  const id = input.id;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name)
    throw codedError('invalid_payload', 'Collection name is required.');
  if (typeof input.description !== 'string') {
    throw codedError('invalid_payload', 'Collection description must be text.');
  }
  const members = parseCollectionDraftMembers(input);
  const { readCollectionConfig, saveCollectionConfig } =
    await import('../collections/collection-store');
  try {
    await assertOrigin();
    if (id !== undefined && !(await readCollectionConfig(id))) {
      throw codedError('not_found', `Collection "${id}" not found.`);
    }
    if (
      id !== undefined &&
      (typeof input.expectedRevision !== 'string' || !input.expectedRevision)
    ) {
      throw codedError(
        'conflict',
        'Reload the Collection before saving an edit.',
      );
    }
    // Allowlist only editable fields. The writer preserves metadata under its
    // lock, rather than replaying metadata from a stale preflight read.
    const guard: CollectionSaveGuard = {
      expectedRevision:
        typeof input.expectedRevision === 'string'
          ? input.expectedRevision
          : undefined,
      assertCurrent: assertOrigin,
      validatePrepared: (collection) => {
        if (resultByteLength({ collection }) > PORTAL_CATALOG_RESULT_MAX_BYTES)
          throw codedError(
            'invalid_payload',
            'The collection is too large to save here.',
          );
      },
    };
    const collection = await saveCollectionConfig(
      {
        ...(id !== undefined ? { id } : {}),
        name,
        description: input.description,
        ...members,
      },
      undefined,
      guard,
    );
    return { collection };
  } catch (error) {
    if (error instanceof ResourceContextUnavailableError) {
      throw codedError('permission_denied', error.message);
    }
    if (error instanceof Error && error.message.startsWith('Invalid '))
      throw codedError('invalid_payload', error.message);
    throw error;
  }
}

export async function getPortalCollection(
  collectionId: string,
): Promise<PortalCollectionsGetResult> {
  requirePlainId(collectionId, 'Collection id');
  const { readLocalCollectionSnapshot } =
    await import('../collections/collection-store');
  let file;
  try {
    file = await readLocalCollectionSnapshot(collectionId);
  } catch (error) {
    if (error instanceof ResourceContextUnavailableError) {
      throw codedError('permission_denied', error.message);
    }
    if (error instanceof Error && error.message.startsWith('Invalid ')) {
      throw codedError('invalid_payload', error.message);
    }
    throw error;
  }
  if (!file || !file.collection) {
    throw codedError('not_found', `Collection "${collectionId}" not found.`);
  }
  const collection = file.collection;
  const skills = Array.isArray(collection.skills) ? collection.skills : [];
  const plugins = Array.isArray(collection.plugins) ? collection.plugins : [];
  // The legacy-migration retry path inside readCollectionConfig can yield
  // configs without a normalized mcpServers array.
  const mcpServers = Array.isArray(collection.mcpServers)
    ? collection.mcpServers
    : [];
  const build = (
    cap: number,
    truncated: boolean,
  ): PortalCollectionsGetResult => ({
    collection: {
      id: collection.id,
      name: collection.name,
      description: collection.description,
      skills: skills.slice(0, cap),
      plugins: plugins.slice(0, cap),
      mcpServers: mcpServers.slice(0, cap),
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
      revision: collection.revision,
      ...(collection.sharedSource
        ? { sharedSource: collection.sharedSource }
        : {}),
    },
    ...(truncated ? { truncated: true } : {}),
  });
  const maxLength = Math.max(skills.length, plugins.length, mcpServers.length);
  // Deterministic degrade: prefix-cut all three item ref lists to the largest
  // shared cap that fits the result budget; enforcePortalResultBudget throws
  // when even the empty-list envelope is undeliverable.
  return enforcePortalResultBudget(build(maxLength, false), [
    (): PortalCollectionsGetResult => {
      let low = 0;
      let high = Math.max(0, maxLength - 1);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (withinResultBudget(build(mid, true))) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      return build(low, true);
    },
  ]);
}

async function readCatalogMcpServers(): Promise<
  PortalPluginCatalogMcpServer[]
> {
  try {
    const raw = await readFile(getMcpServersIndexFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.servers)) {
      return [];
    }
    const rows: PortalPluginCatalogMcpServer[] = [];
    for (const server of parsed.servers) {
      if (!isServerEntry(server)) {
        continue;
      }
      const transport: 'command' | 'http' =
        server.type === 'command' ? 'command' : 'http';
      for (const config of server.configs) {
        if (!config.enabled) {
          continue;
        }
        rows.push({
          serverId: server.id,
          configId: config.id,
          serverName: server.name,
          configName: config.name,
          description: server.description,
          transport,
        });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Portal Plugins-section MUTATION commands (design:
// docs/planning/2026-08-27-portal-plugins-section/design.md, phase B).
//
// Unlike everything above, these entry points DO mutate local state — but
// only through the SAME `plugin-service` / `saveMcpServer` functions the
// renderer IPC handlers call, wrapped in the shared `refreshAfterSuccess`
// helper so the invocable inventory refreshes identically. Results are
// projected through the same reduced row builders as the read commands, so
// nothing machine-local or credential-bearing crosses the portal boundary.
// Service `IPCResult` failures become thrown `execution_failed` errors the
// adapter maps onto `portal.command.failed`.
// ---------------------------------------------------------------------------

// Return type inferred: naming it would need a (lint-forbidden) `import()`
// type annotation, and the lazy-import pattern matches the read builders.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function pluginMutationDeps() {
  const [service, handlers] = await Promise.all([
    import('../plugins/plugin-service'),
    import('../plugins/plugin-handlers'),
  ]);
  return { service, handlers };
}

/**
 * In-process serialization for portal plugin/marketplace mutations.
 *
 * Portal mutations run DETACHED from the serial command loop (so a minutes-long
 * install never stalls chat — see `completeOffLoop` in the adapter), which
 * means several can be in flight in this process at once. The underlying
 * services guard only their own inner steps — `withCacheLock` serializes a
 * single cache read-modify-write, `withMarketplaceRefreshLock` only wraps
 * update/refresh — so a bare external install does an UNLOCKED read-modify-
 * write of the cache index and plugin-cache dir, and a concurrent add/remove
 * on the same marketplace could drop entries or orphan directories.
 *
 * This chain restores the lost ordering guarantee: every mutating portal
 * operation (install_builtin, install_external, add, update, remove, and the
 * fire-and-forget refresh_all) runs one-at-a-time, in submission order, across
 * the WHOLE operation (scan + clone + cache write), not just the inner cache
 * write. It is intentionally a single unkeyed queue so unrelated marketplaces
 * still mutually exclude — the shared plugin cache file is one document.
 *
 * The off-loop return property is preserved: callers still return the pending
 * promise immediately; only its BODY is deferred until the queue drains. The
 * tail swallows errors so one failed mutation never wedges the queue.
 */
import {
  runSerializedPluginMutation,
  resetPluginMutationQueueForTests,
} from '../plugins/plugin-mutation-queue';
export { runSerializedPluginMutation } from '../plugins/plugin-mutation-queue';

/**
 * Reset the serialization chain to idle. TEST-ONLY: keeps one test's pending
 * mutation from serializing (and thus stalling) the next test's mutations,
 * since the chain is a module singleton.
 */
export function __resetPluginMutationChainForTests(): void {
  resetPluginMutationQueueForTests();
}

function unwrapIpcResult<T>(result: IPCResult<T>, fallbackMessage: string): T {
  if (!result.success || result.data === undefined) {
    throw codedError(
      'execution_failed',
      (!result.success && result.error) || fallbackMessage,
    );
  }
  return result.data;
}

/**
 * Project a fresh {@link MarketplaceInfo} into the reduced mutation result,
 * prefix-cutting the row's plugin list if the result would blow the portal
 * event budget.
 */
function marketplaceMutationResult(
  marketplace: MarketplaceInfo,
): PortalMarketplaceMutationResult {
  const row = toMarketplaceRow(marketplace);
  return fitListToResultBudget(row.plugins, (plugins, truncated) => ({
    marketplace: { ...row, plugins },
    ...(truncated ? { truncated: true } : {}),
  }));
}

/**
 * In-flight collapsing for IDENTICAL portal plugin installs.
 *
 * The install commands are NOT idempotent — each run performs a real install —
 * and they run detached from the serial command loop, so a browser that
 * re-submits (a reload, a second tab, an impatient retry after the long-RPC
 * wait timed out) can land two identical commands in this process. The
 * serialization chain would then run the same install twice, back to back.
 *
 * Identical requests are therefore COLLAPSED onto one in-flight promise: the
 * work runs once and every caller resolves with the same result, so a
 * duplicate is invisible to the browser instead of surfacing as an error.
 * That is deliberately preferred over rejecting the second submission — a
 * desktop failure code does not survive the trip to the browser (the server's
 * event ingestion keeps only the message), so a rejection would reach the user
 * as an unexplained failure while a collapse simply answers correctly.
 *
 * The key includes the providers for built-in installs: installing to Claude
 * and installing to Codex are different operations and must not collapse onto
 * each other. Providers are sorted so argument order never defeats the match.
 *
 * Pure in-flight (deleted on settle, never a result cache), so a later install
 * of the same plugin always does real work. The identity-guarded delete keeps
 * an earlier attempt's settlement from evicting a newer entry.
 */
const inFlightPortalInstalls = new Map<
  string,
  Promise<PortalPluginInstallOutcome>
>();

/** A Portal install's row and which requested providers it installed (CAN-5859). */
export interface PortalPluginInstallOutcome {
  result: PortalPluginMutationResult;
  installedProviders: PluginProvider[];
  failedProviders: PluginProvider[];
}

function portalInstallDedupeKey(
  kind: 'builtin' | 'external',
  marketplaceId: string,
  pluginName: string,
  providers?: PluginProvider[],
): string {
  return JSON.stringify([
    kind,
    marketplaceId,
    pluginName,
    providers ? [...providers].sort() : null,
  ]);
}

function dedupePortalInstall(
  key: string,
  operation: () => Promise<PortalPluginInstallOutcome>,
): Promise<PortalPluginInstallOutcome> {
  const existing = inFlightPortalInstalls.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const request = operation().finally(() => {
    if (inFlightPortalInstalls.get(key) === request) {
      inFlightPortalInstalls.delete(key);
    }
  });
  inFlightPortalInstalls.set(key, request);
  return request;
}

/**
 * Drop all in-flight install entries. TEST-ONLY: the map is a module
 * singleton, so one test's pending install would otherwise collapse the next
 * test's identical install onto it.
 */
export function __resetInFlightPortalInstallsForTests(): void {
  inFlightPortalInstalls.clear();
}

/** Build the `portal.plugins.install_builtin` result. */
export async function installPortalBuiltInPlugin(
  marketplaceId: string,
  pluginName: string,
  providers: PluginProvider[],
): Promise<PortalPluginMutationResult> {
  return (
    await installPortalBuiltInPluginWithOutcomes(
      marketplaceId,
      pluginName,
      providers,
    )
  ).result;
}

/** {@link installPortalBuiltInPlugin}, also naming the providers that installed and failed. */
export async function installPortalBuiltInPluginWithOutcomes(
  marketplaceId: string,
  pluginName: string,
  providers: PluginProvider[],
): Promise<PortalPluginInstallOutcome> {
  requirePlainId(marketplaceId, 'marketplace id');
  requirePlainId(pluginName, 'plugin name');
  // Dedupe OUTSIDE the serialization chain: a duplicate must not consume a
  // queue slot behind the install it is a duplicate of.
  return dedupePortalInstall(
    portalInstallDedupeKey('builtin', marketplaceId, pluginName, providers),
    () =>
      runSerializedPluginMutation(async () => {
        const { service, handlers } = await pluginMutationDeps();
        const result = await handlers.refreshAfterSuccess(
          'portal.plugins.install_builtin',
          () =>
            service.installBuiltInPlugin({
              marketplaceId,
              pluginName,
              providers,
            }),
        );
        const data = unwrapIpcResult(
          result,
          'The plugin could not be installed.',
        );
        // One collapsed install is one real install, so this fires once for
        // the group rather than once per duplicate submission.
        handlers.reportCuratedPluginInstallBestEffort(
          marketplaceId,
          pluginName,
        );
        const installed = (provider: PluginProvider): boolean =>
          data.providerOutcomes[provider]?.installed === true;
        return {
          result: { plugin: toPluginRow(data.plugin) },
          installedProviders: providers.filter(installed),
          failedProviders: providers.filter((provider) => !installed(provider)),
        };
      }),
  );
}

/**
 * Build the `portal.plugins.install_external` result. The browser only names
 * the plugin; the clone URL is resolved from the desktop's OWN cached entry.
 *
 * That resolution is NOT sufficient on its own: a portal session can first
 * `portal.marketplace.add` an attacker-controlled repo whose manifest names an
 * arbitrary plugin `source.url`, so the "desktop-cached" URL is still
 * attacker-influenced. It is therefore re-validated with
 * {@link assertSafeExternalPluginCloneUrl} — https only, no credentials, no
 * ssh/file/SCP, no loopback/private/link-local/internal hosts — IMMEDIATELY
 * before it reaches `git clone` (SSRF / local-file boundary).
 */
export async function installPortalExternalPlugin(
  marketplaceId: string,
  pluginName: string,
): Promise<PortalPluginMutationResult> {
  requirePlainId(marketplaceId, 'marketplace id');
  requirePlainId(pluginName, 'plugin name');
  const { result } = await dedupePortalInstall(
    portalInstallDedupeKey('external', marketplaceId, pluginName),
    () =>
      runSerializedPluginMutation(async () => {
        const { plugin } = await findCachedPlugin(marketplaceId, pluginName);
        const sourceUrl =
          plugin.externalSource?.url ??
          plugin.facets.claude?.externalSource?.url;
        if (!sourceUrl) {
          throw codedError(
            'invalid_payload',
            `Plugin "${pluginName}" has no external source to install from.`,
          );
        }
        // SSRF / local-file gate: resolve-then-validate the manifest-supplied URL
        // right before the clone. Kept inside the serialized mutation so the cache
        // read that produced `sourceUrl` cannot be mutated out from under the
        // subsequent install by a concurrent add/remove.
        await assertSafeExternalPluginCloneUrl(sourceUrl);
        const { service, handlers } = await pluginMutationDeps();
        const result = await handlers.refreshAfterSuccess(
          'portal.plugins.install_external',
          () =>
            // `disableRedirects`: the manifest URL passed the address allowlist,
            // but git would otherwise follow a 3xx into a private host — refuse
            // all redirects for this clone. `skipRefresh`: suppress installPlugin's
            // own DETACHED refreshMarketplaces so it cannot run (under
            // withMarketplaceRefreshLock) after this queue slot releases and race
            // the next queued install; we drive the refresh below instead.
            service.installPlugin(marketplaceId, plugin.name, sourceUrl, {
              disableRedirects: true,
              skipRefresh: true,
            }),
        );
        const data = unwrapIpcResult(
          result,
          'The plugin could not be installed.',
        );
        // Run the post-install marketplace refresh INSIDE the serialized slot so
        // the queue does not release until it settles — otherwise the next queued
        // external install would overlap this refresh's locked cache read/write.
        // Failure of the refresh alone must not fail an install that succeeded.
        await service.refreshMarketplaces().catch(() => undefined);
        return {
          result: { plugin: toPluginRow(data) },
          installedProviders: ['claude'],
          failedProviders: [],
        };
      }),
  );
  return result;
}

/**
 * Build the `portal.marketplace.add` result. The browser-supplied `repo` is
 * re-validated with the SAME GitHub parser the desktop's add-marketplace UI
 * uses; the canonical `owner/repo` form is what reaches the provider CLIs.
 */
export async function addPortalMarketplace(
  repo: string,
): Promise<PortalMarketplaceMutationResult> {
  const parsed = typeof repo === 'string' ? parseGitHubRepo(repo) : null;
  if (!parsed) {
    throw codedError(
      'invalid_payload',
      'Marketplace source must be an owner/repo reference or a GitHub repository URL.',
    );
  }
  // No SSRF gate needed here: add only clones the GitHub marketplace REPO
  // itself (the parsed `owner/repo`, normalized to https://github.com/... by
  // the provider CLIs). It never clones a manifest-referenced plugin
  // `source.url`; those are fetched only on install_external, which is where
  // the clone-URL allowlist lives.
  return runSerializedPluginMutation(async () => {
    const { service, handlers } = await pluginMutationDeps();
    const result = await handlers.refreshAfterSuccess(
      'portal.marketplace.add',
      () => service.addMarketplace(parsed),
    );
    const data = unwrapIpcResult(result, 'The marketplace could not be added.');
    return marketplaceMutationResult(data.marketplace);
  });
}

/** Build the `portal.marketplace.update` result. */
export async function updatePortalMarketplace(
  marketplaceId: string,
): Promise<PortalMarketplaceMutationResult> {
  requirePlainId(marketplaceId, 'marketplace id');
  return runSerializedPluginMutation(async () => {
    const { service, handlers } = await pluginMutationDeps();
    const result = await handlers.refreshAfterSuccess(
      'portal.marketplace.update',
      () => service.updateMarketplace(marketplaceId),
    );
    const data = unwrapIpcResult(
      result,
      'The marketplace could not be updated.',
    );
    return marketplaceMutationResult(data);
  });
}

const MARKETPLACE_NOT_FOUND_RE = /^Marketplace ".*" not found\.$/;

/**
 * Build the `portal.marketplace.remove` result. Removal is IDEMPOTENT at the
 * portal boundary: a marketplace that is not registered at all completes with
 * `{removed: true, alreadyAbsent: true}` instead of failing, so a retried or
 * raced removal never surfaces a spurious error. Provider-level failures
 * (the row is left intact for retry) DO fail the command with the provider's
 * own message.
 */
export async function removePortalMarketplace(
  marketplaceId: string,
  providers?: PluginProvider[],
): Promise<PortalMarketplaceRemoveResult> {
  requirePlainId(marketplaceId, 'marketplace id');
  return runSerializedPluginMutation(async () => {
    const { service, handlers } = await pluginMutationDeps();
    const result = await handlers.refreshAfterSuccess(
      'portal.marketplace.remove',
      () => service.removeMarketplace(marketplaceId, { providers }),
    );
    if (!result.success) {
      if (result.error && MARKETPLACE_NOT_FOUND_RE.test(result.error)) {
        return { removed: true, alreadyAbsent: true };
      }
      throw codedError(
        'execution_failed',
        result.error ?? 'The marketplace could not be removed.',
      );
    }
    const outcomes = result.data?.providerOutcomes;
    const requested: readonly PluginProvider[] =
      providers && providers.length > 0 ? providers : ['claude', 'codex'];
    const errors = requested
      .map((provider) => {
        const error = outcomes?.[provider]?.error;
        return error ? `${provider}: ${error}` : null;
      })
      .filter((entry): entry is string => entry !== null);
    if (errors.length > 0) {
      throw codedError('execution_failed', errors.join('; '));
    }
    const alreadyAbsent = requested.every(
      (provider) => outcomes?.[provider]?.alreadyAbsent === true,
    );
    return { removed: true, ...(alreadyAbsent ? { alreadyAbsent: true } : {}) };
  });
}

/**
 * Kick off the full marketplace refresh WITHOUT waiting for it.
 * `portal.marketplace.refresh_all` is fire-and-forget: the fan-out refresh
 * routinely takes minutes — far past the 60s command TTL — so the adapter
 * completes the command immediately and the refresh finishes in the
 * background (the browser reconciles with a later refetch).
 *
 * The refresh is ENQUEUED on the same serialization chain as the other
 * mutations (not awaited here), so an install/add/remove cannot interleave
 * with a refresh mid-flight — it simply waits its turn — while the fire-and-
 * forget return is preserved. `refreshMarketplaces` itself never rejects.
 */
export async function startPortalMarketplacesRefresh(): Promise<void> {
  const { service, handlers } = await pluginMutationDeps();
  void runSerializedPluginMutation(() =>
    handlers.refreshAfterSuccess('portal.marketplace.refresh_all', () =>
      // Explicitly user-triggered, so force the provider recheck. Matching the
      // desktop `PLUGINS_CHANNELS.REFRESH` handler: `shouldRunProviderUpdates`
      // defaults to `'if-stale'`, which would silently make an explicit
      // "refresh all" a no-op inside the 24h TTL window.
      service.refreshMarketplaces(undefined, { providerUpdates: 'always' }),
    ),
  ).catch(() => undefined);
}

/** The `portal.plugins.install_*` result for a plugin, read from the cache (a replayed core install). */
export async function readPortalPluginMutationResult(
  marketplaceId: string,
  pluginName: string,
): Promise<PortalPluginMutationResult> {
  const { plugin } = await findCachedPlugin(marketplaceId, pluginName);
  return { plugin: toPluginRow(plugin) };
}

/** The `portal.marketplace.add/update` result for a marketplace, read from the cache. */
export async function readPortalMarketplaceMutationResult(
  marketplaceId: string,
): Promise<PortalMarketplaceMutationResult> {
  const { marketplaces } = await readCachedMarketplaces();
  const row = marketplaces.find(
    (marketplace) => marketplace.id === marketplaceId,
  );
  if (!row)
    throw codedError('not_found', `Marketplace "${marketplaceId}" not found.`);
  return marketplaceMutationResult(row);
}

/**
 * Flip the `enabled` flag on one config of a standalone MCP server and
 * return the saved server through the same REDACTED projection as
 * `portal.mcp.get_server`.
 *
 * Deliberately NARROW: the browser names ids and a boolean only. The desktop
 * re-reads its own stored `McpServerData` inside the queued
 * `setInstalledMcpConfigEnabled`, which saves through the renderer's
 * validation/save path (including the trailing portal MCP projection
 * refresh), because the browser's copy of the server is redacted and must
 * never round-trip back.
 */
export async function setPortalMcpConfigEnabled(
  serverId: string,
  configId: string,
  enabled: boolean,
): Promise<PortalMcpSetConfigEnabledResult> {
  requirePortalMcpServerId(serverId);
  requirePlainId(configId, 'MCP config id');
  // Account connections live in the cloud; there is no device config to flip.
  const accountManaged = (): Error =>
    codedError(
      'invalid_payload',
      'Account MCP servers are managed in your account.',
    );
  if (isCustomAccountMcpServerKey(serverId)) throw accountManaged();
  // Same fallback as `getPortalMcpServer`: a curated key with no device
  // file is served from the account, so it is refused the same way.
  const missingServer = async (): Promise<Error> =>
    (await findPortalAccountMcpConnections(serverId)).length > 0
      ? accountManaged()
      : codedError('not_found', `MCP server "${serverId}" not found.`);
  // Device ids only; the queued setter decides a no-op from current state.
  if (!/^[a-f0-9-]+$/.test(serverId)) throw await missingServer();
  const { setInstalledMcpConfigEnabled } = await import('../ipc/mcp-servers');
  try {
    await setInstalledMcpConfigEnabled(serverId, configId, enabled);
  } catch (error) {
    if (error instanceof McpConfigNotFoundError) {
      throw error.target === 'server'
        ? await missingServer()
        : codedError(
            'not_found',
            `Config "${configId}" not found on MCP server "${serverId}".`,
          );
    }
    if (error instanceof McpConfigStateError)
      throw codedError('execution_failed', error.message);
    throw error;
  }
  const detail = await getPortalMcpServer(serverId);
  return {
    server: detail.server,
    ...(detail.truncated ? { truncated: true } : {}),
  };
}

/**
 * `portal.skills.share_skill`: resolve the installed skill, upload its RAW
 * SKILL.md bytes (the server hashes them, so they must round-trip
 * byte-identical), and mint the link for the requested scope. Runs under the
 * DESKTOP's Cloud credentials — the browser never holds them.
 */
export async function sharePortalSkill(input: {
  sourceId: string;
  skillName: string;
  scope: PortalShareScope;
  teamId?: string;
  organizationId?: string;
}): Promise<PortalShareResult> {
  const { loadSkills, readRawSkill, writeSkillRemoteMetadata } =
    await import('../skills/skill-service');
  const installed = loadSkills();
  if (installed.success && installed.data)
    installed.data = await filterStoredSkillContexts(installed.data);
  const matches =
    installed.data?.filter(
      (candidate) =>
        candidate.sourceId === input.sourceId &&
        candidate.name === input.skillName,
    ) ?? [];
  if (matches.length > 1)
    throw new Error(MARKETPLACE_SHARE_BLOCKED_REASONS.unavailable);
  const skill = matches[0];
  if (!installed.success || !skill) {
    throw new Error('The skill is no longer installed.');
  }
  if (!canSharePortalSkill(skill)) {
    throw new Error('This skill cannot be shared.');
  }
  const accountId = await requirePortalShareAccountId(skill.remote);
  // Lazy like this service's other Cloud imports: keeps the client off the
  // catalog read path the portal hydrates on every state refresh.
  const {
    assertSharedSkillsSupported,
    createSharedSkill,
    getSharedSkill,
    publishSkillPublicShare,
    updateSharedSkill,
  } = await import('../skills/canopy-server-client');
  const { withShareStage } = await import('../sharing/share-operation-result');
  await withShareStage('access', assertSharedSkillsSupported);

  const rawSkill = await readRawSkill(`${input.sourceId}/${input.skillName}`);
  const localId = `${input.sourceId}/${input.skillName}`;
  const ownerFields = {
    shareScope: input.scope === 'public' ? ('private' as const) : input.scope,
    ...(input.scope === 'team' && input.teamId ? { teamId: input.teamId } : {}),
    ...(input.scope === 'organization' && input.organizationId
      ? { organizationId: input.organizationId }
      : {}),
  };
  const createRequest = {
    ...(skillResourceContextEnabled() ? { sourceSkillId: localId } : {}),
    rawSkill,
    ...ownerFields,
  };
  let detail;
  if (skill.remote) {
    try {
      const current = await getSharedSkill(skill.remote.remoteId);
      detail = await updateSharedSkill({
        ...(skillResourceContextEnabled() ? { sourceSkillId: localId } : {}),
        skillId: skill.remote.remoteId,
        rawSkill,
        expectedContentHash: current.contentHash,
        preservePackage: true,
        ...ownerFields,
        ...(input.scope !== 'public' &&
        current.publicShare &&
        !(await preserveOrganizationPublicLink(current.owner))
          ? {
              revokePublicShare: {
                externalId: current.publicShare.externalId,
                updatedAt: current.publicShare.updatedAt,
              },
            }
          : {}),
      });
    } catch (error) {
      if (!isCloudNotFound(error)) throw error;
      detail = await createSharedSkill(createRequest);
    }
  } else {
    detail = await createSharedSkill(createRequest);
  }

  // Creation can return another publisher's content-addressed Skill. Only a
  // mutable row is an author-side link for this local Skill.
  if (detail.canUpdate) {
    writeSkillRemoteMetadata(localId, {
      accountId,
      remoteId: detail.id,
      contentHash: detail.contentHash,
      shareScope: detail.shareScope,
      sharedAt: detail.updatedAt,
    });
  }

  if (input.scope === 'public') {
    try {
      const published = await publishSkillPublicShare(detail.id);
      return { sharePath: published.sharePath };
    } catch {
      // The copy exists; only the public link failed. Say so rather than
      // failing a share the user already got.
      return {
        message:
          'Skill shared privately, but the public link could not be created.',
      };
    }
  }
  if (input.scope === 'team' || input.scope === 'organization') {
    return { sharePath: skillSharePath(detail.id) };
  }
  return {};
}

/**
 * `portal.sharing.account`: the DESKTOP's Cloud account state. A row's
 * `shareable` flag says the desktop could share that resource; it says nothing
 * about whether the account is currently connected or supports team and
 * organization scopes, so the browser asks rather than assuming (review on
 * #3159).
 */
export async function getPortalSharingAccount(): Promise<PortalSharingAccountResult> {
  const { resourceContextEnabled } = await import('../lib/resource-context');
  const { loadCanopyCloudAccountPublicState } =
    await import('../lib/canopy-cloud-account-store');
  const state = await loadCanopyCloudAccountPublicState();
  return {
    organizationOwnershipPolicy: {
      enabled: resourceContextEnabled(),
      personalOrganizationId: state.personalOrganizationId ?? null,
    },
    // A degraded read collapses to a null entry, which is indistinguishable
    // from a sign-out; report not-connected and let the dialog say so rather
    // than offering a form that will fail on submit.
    connected: state.hasApiKey === true && state.account !== undefined,
    ...(state.account ? { id: state.account.id } : {}),
    capabilities: [...state.capabilities],
    // Membership comes from the stored account, matching the desktop dialog
    // binding: the startup reprobe refreshes it, and a state that omits the
    // field entirely leaves Team and Organization available.
    ...(state.organizations !== undefined
      ? { hasOrganization: state.organizations.length > 0 }
      : {}),
    ...(state.teams !== undefined ? { hasTeam: state.teams.length > 0 } : {}),
    // Advisory per-organization access from the stored account; an
    // organization without a billing state stays unknown, never denied.
    ...(state.organizations !== undefined ||
    state.orgBillingStates !== undefined
      ? {
          organizationAccess: buildShareOrganizationAccess(
            state.organizations ?? [],
            state.orgBillingStates ?? [],
          ),
        }
      : {}),
  };
}

/** Load a local Skill's current Cloud audience for Portal dialog preselection. */
export async function getPortalExistingSkillShare(input: {
  sourceId: string;
  skillName: string;
}): Promise<PortalSharingExistingShare | null> {
  const { loadSkills: loadInstalledSkills } =
    await import('../skills/skill-service');
  const result = loadInstalledSkills();
  if (result.success && result.data)
    result.data = await filterStoredSkillContexts(result.data);
  const skill = result.data?.find(
    (candidate) =>
      candidate.sourceId === input.sourceId &&
      candidate.name === input.skillName,
  );
  if (!result.success || !skill || !canSharePortalSkill(skill)) {
    throw codedError('not_found', 'Skill not found.');
  }
  if (!skill.remote) return null;
  await requirePortalShareAccountId(skill.remote);
  const { getSharedSkill } = await import('../skills/canopy-server-client');
  try {
    return toPortalExistingShare(await getSharedSkill(skill.remote.remoteId), {
      kind: 'skill',
      itemId: skill.remote.remoteId,
    });
  } catch (error) {
    if (isCloudNotFound(error)) return null;
    throw error;
  }
}

/** Read-only hosted lookup by the same account and portable ref used by plugin creation. */
export async function getPortalExistingPluginShare(input: {
  marketplaceId: string;
  pluginName: string;
}): Promise<PortalSharingExistingShare | null> {
  const accountId = await requirePortalShareAccountId();
  const { marketplace, plugin, shareResolver } = await findCachedPlugin(
    input.marketplaceId,
    input.pluginName,
  );
  const sharing = shareResolver.plugin(input.marketplaceId, input.pluginName);
  if (sharing.status === 'blocked')
    throw codedError('execution_failed', sharing.reason);
  const ref = computePluginShareableRef(plugin, marketplace);
  if (!ref)
    throw codedError(
      'execution_failed',
      MARKETPLACE_SHARE_BLOCKED_REASONS.noPublicSource,
    );
  const { assertSharedPluginsSupported, listSharedPlugins, getSharedPlugin } =
    await import('../plugins/canopy-server-client');
  await assertSharedPluginsSupported();
  const refKey = getShareablePluginRefKey(ref);
  const matches = (await listSharedPlugins({ createdBy: 'me' })).filter(
    (row) => row.refKey === refKey,
  );
  if (matches.length > 1)
    throw codedError(
      'execution_failed',
      'The current plugin share could not be identified.',
    );
  const match = matches[0];
  const detail = match ? await getSharedPlugin(match.externalId) : null;
  if ((await requirePortalShareAccountId()) !== accountId)
    throw codedError(
      'execution_failed',
      'The desktop Cloud account changed. Try again.',
    );
  return detail
    ? toPortalExistingShare(detail, {
        kind: 'plugin',
        itemId: detail.externalId,
      })
    : null;
}

/** Load a local Collection's current Cloud audience for Portal preselection. */
export async function getPortalExistingCollectionShare(
  collectionId: string,
): Promise<PortalSharingExistingShare | null> {
  requirePlainId(collectionId, 'Collection id');
  const { readCollectionConfig } =
    await import('../collections/collection-store');
  const file = await readCollectionConfig(collectionId);
  if (!file?.collection) {
    throw codedError('not_found', 'Collection not found.');
  }
  const remote = file.collection.remote;
  if (!remote) return null;
  await requirePortalShareAccountId(remote);
  const { getSharedCollection } =
    await import('../collections/canopy-server-client');
  try {
    return toPortalExistingShare(await getSharedCollection(remote.remoteId), {
      kind: 'collection',
      itemId: remote.remoteId,
    });
  } catch (error) {
    if (isCloudNotFound(error)) return null;
    throw error;
  }
}

/**
 * `portal.sharing.list_teams`: the desktop's Cloud teams, since the share is
 * created under the desktop's account rather than the browser user's.
 */
export async function listPortalShareTeams(
  query: string | undefined,
): Promise<PortalSharingListTargetsResult> {
  const { listSharedTeams } = await import('../pipelines/canopy-server-client');
  const page = await listSharedTeams({ ...(query ? { q: query } : {}) });
  return {
    targets: page.data.map((team) => ({
      id: team.id,
      name: team.name,
      ...(team.organization?.id
        ? { organizationId: team.organization.id }
        : {}),
      ...(team.organization?.name
        ? { secondaryLabel: team.organization.name }
        : {}),
    })),
  };
}

/** `portal.sharing.list_organizations`: the desktop account's organizations. */
export async function listPortalShareOrganizations(
  query: string | undefined,
): Promise<PortalSharingListTargetsResult> {
  const { listSharedOrganizations } =
    await import('../pipelines/canopy-server-client');
  const page = await listSharedOrganizations({
    ...(query ? { q: query } : {}),
  });
  return {
    targets: page.data.map((organization) => ({
      id: organization.id,
      name: organization.name,
    })),
  };
}

/**
 * `portal.collections.share`: rebuild the Collection payload from local state
 * — member refs plus the raw bytes of any custom skills it carries — and create
 * the shared copy under the DESKTOP's Cloud account.
 *
 * Public shares publish the Collection's pinned public snapshot after the
 * underlying shared row is created or refreshed.
 */
export async function sharePortalCollection(input: {
  collectionId: string;
  scope: PortalShareScope;
  teamId?: string;
  organizationId?: string;
}): Promise<PortalShareResult> {
  // The four dynamic imports in this function are lazy for the same reason as
  // this service's other Cloud/store imports: they pull the collection store,
  // skill service, payload builder and Cloud client, none of which belong on
  // the portal's hot catalog READ path that re-hydrates on every state
  // refresh. Each is a local or workspace module, so the packaged bytecode
  // main build resolves them exactly as the static imports above — the
  // packaged-resolution hazard in CLAUDE.md is about third-party dynamic
  // imports, not these.
  const { readCollectionConfig, writeCollectionRemoteMetadata } =
    await import('../collections/collection-store');
  requirePlainId(input.collectionId, 'Collection id');
  const file = await readCollectionConfig(input.collectionId);
  if (!file?.collection) {
    throw codedError('not_found', 'Collection not found.');
  }
  const config = file.collection;
  if (config.mcpServers.length > 0) {
    throw codedError('invalid_payload', MCP_SHARE_BLOCKED_MESSAGE);
  }
  const accountId = await requirePortalShareAccountId(config.remote);

  const { loadSkills, readRawSkill } = await import('../skills/skill-service');
  const skillsResult = loadSkills();
  if (skillsResult.success && skillsResult.data)
    skillsResult.data = await filterStoredSkillContexts(skillsResult.data);
  const installedSkills =
    skillsResult.success && skillsResult.data ? skillsResult.data : [];
  const { marketplaces: cachedMarketplaces } = await readCachedMarketplaces();
  const marketplaces = cachedMarketplaces.map((marketplace) => ({
    id: marketplace.id,
    sourceUrl: marketplace.sourceUrl,
  }));

  const { buildSharedCollectionPayload, convertLocalCollectionToEditable } =
    await import('@canopy/desktop-shared/collections/shared-collection-payload');
  const { editable } = convertLocalCollectionToEditable({
    config,
    installedSkills,
    marketplaces,
  });
  if (
    editable.items.some(
      (item) =>
        item.kind === 'draft_custom_skill' &&
        item.localSkillId.startsWith('local:'),
    )
  ) {
    throw codedError(
      'invalid_payload',
      'This Collection needs a capability package and cannot be shared from Portal.',
    );
  }
  const payload = await buildSharedCollectionPayload({
    name: editable.name,
    description: editable.description,
    items: editable.items,
    customSkillReader: (localSkillId) => readRawSkill(localSkillId),
  });

  const {
    createSharedCollection,
    deleteSharedCollection,
    getSharedCollection,
    updateSharedCollection,
    revokeCollectionPublicShare,
  } = await import('../collections/canopy-server-client');
  const shareRequest = {
    sourceCollectionId: input.collectionId,
    rawCollection: payload.rawCollection,
    ...(payload.customSkills.length > 0
      ? { customSkills: payload.customSkills }
      : {}),
    shareScope: input.scope === 'public' ? 'private' : input.scope,
    ...(input.scope === 'team' && input.teamId ? { teamId: input.teamId } : {}),
    ...(input.scope === 'organization' && input.organizationId
      ? { organizationId: input.organizationId }
      : {}),
  };
  let created = false;
  let detail;
  if (config.remote) {
    let current: Awaited<ReturnType<typeof getSharedCollection>> | null = null;
    try {
      current = await getSharedCollection(config.remote.remoteId);
    } catch (error) {
      if (!isCloudNotFound(error)) throw error;
    }
    if (current) {
      // Keep revocation outside the missing-resource retry: its failure must
      // stop the owner change, including a 404 for a stale public link.
      if (
        input.scope !== 'public' &&
        current.publicShare &&
        !(await preserveOrganizationPublicLink(current.owner))
      ) {
        await revokeCollectionPublicShare(config.remote.remoteId);
      }
      try {
        detail = await updateSharedCollection({
          ...shareRequest,
          collectionId: config.remote.remoteId,
          expectedContentHash: current.contentHash,
        });
      } catch (error) {
        if (!isCloudNotFound(error)) throw error;
        detail = await createSharedCollection(shareRequest);
        created = true;
      }
    } else {
      detail = await createSharedCollection(shareRequest);
      created = true;
    }
  } else {
    detail = await createSharedCollection(shareRequest);
    created = true;
  }

  try {
    const stored = await writeCollectionRemoteMetadata(input.collectionId, {
      accountId,
      remoteId: detail.id,
      contentHash: detail.contentHash,
      shareScope: detail.shareScope,
      sharedAt: detail.updatedAt,
    });
    if (!stored) throw new Error('Failed to store Collection share link.');
  } catch (error) {
    if (created) await deleteSharedCollection({ collectionId: detail.id });
    throw error;
  }

  if (input.scope === 'public') {
    const { publishCollectionPublicShare } =
      await import('../collections/canopy-server-client');
    const publicShare = await publishCollectionPublicShare(detail.id);
    return { sharePath: publicShare.sharePath };
  }
  return { sharePath: collectionSharePath(detail.id) };
}

/** Canonical device-file resolution; labels and a missing account scope confer no authority. */
async function requirePortalDeviceMcp(
  serverId: string,
): Promise<McpServerFile> {
  requirePortalMcpServerId(serverId);
  if (!/^[a-f0-9-]+$/.test(serverId)) {
    throw codedError(
      'invalid_target',
      'This operation requires a device MCP server.',
    );
  }
  const { readServer, resolveStandaloneHttpHandler } =
    await import('../ipc/mcp-servers');
  let file: McpServerFile;
  try {
    file = await readServer(serverId);
  } catch {
    throw codedError('not_found', 'The device MCP server is unavailable.');
  }
  if (file.server.definition.id !== serverId) {
    throw codedError(
      'invalid_target',
      'The MCP server identity changed. Refresh and try again.',
    );
  }
  if (file.server.definition.type === 'http') {
    const handler = await resolveStandaloneHttpHandler(
      file.server.definition,
    ).catch(() => {
      throw codedError(
        'execution_failed',
        'The MCP server authorization could not be checked.',
      );
    });
    if (handler === 'provider') {
      throw codedError(
        'invalid_target',
        'This MCP server is managed by its agent provider.',
      );
    }
  }
  return file;
}

/** Reuses the existing probe and cache writer; never forwards raw server output. */
export async function testPortalMcpConnection(
  serverId: string,
  configId?: string,
): Promise<PortalMcpTestConnectionResult> {
  const file = await requirePortalDeviceMcp(serverId);
  const configs = file.server.configs;
  if (configId !== undefined) requirePlainId(configId, 'MCP config id');
  const selected =
    configId === undefined && configs.length === 1
      ? configs[0]
      : configs.find((config) => config.id === configId);
  if (!selected || !/^[a-f0-9-]+$/.test(selected.id))
    throw codedError(
      'invalid_payload',
      'Select an existing MCP configuration to test.',
    );
  const { testMcpServerConnection } = await import('../ipc/mcp-servers');
  const credentialName =
    /token|secret|password|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key|cookie/i;
  const headerSecrets = (headers: Record<string, string> = {}): string[] =>
    Object.entries(headers)
      .filter(([name, value]) => credentialName.test(name) || value.length >= 8)
      .map(([, value]) => value);
  const args = [
    ...(file.server.definition.args ?? []),
    ...(selected.extraArgs ?? []),
  ];
  const secrets = [
    ...headerSecrets(file.server.definition.headers),
    ...headerSecrets(selected.extraHeaders),
    ...Object.entries(selected.envVars ?? {})
      .filter(([name]) => credentialName.test(name))
      .map(([, value]) => value),
    selected.authToken,
    file.server.definition.oauth?.clientSecret,
    ...args.flatMap((arg, index) => {
      const flag =
        /^--?[\w-]*(?:token|secret|password|key|credential)[\w-]*(?:=(.*))?$/i.exec(
          arg,
        );
      return flag ? [flag[1] ?? args[index + 1]] : [];
    }),
  ].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  let raw: unknown;
  try {
    raw = await testMcpServerConnection(serverId, selected.id, (probe) => {
      secrets.push(...headerSecrets(probe.headers));
    });
  } catch {
    throw codedError(
      'execution_failed',
      'The MCP connection test failed. Refresh and try again.',
    );
  }
  if (
    !isRecord(raw) ||
    raw.serverId !== serverId ||
    raw.configId !== selected.id ||
    typeof raw.success !== 'boolean'
  ) {
    throw codedError(
      'execution_failed',
      'The MCP connection test returned an invalid result.',
    );
  }
  const credentialValues = secrets
    .filter((value) => value.length > 0)
    .flatMap((value) => [
      value,
      // Tool identifiers cannot contain spaces, but can echo the credential
      // portion of an Authorization header without its scheme.
      value.replace(/^(?:Bearer|Basic)\s+/i, ''),
    ]);
  const result = {
    serverId,
    configId: selected.id,
    success: raw.success,
    message: raw.success
      ? 'Connection successful.'
      : 'Connection failed. Check the configuration on your desktop.',
    ...(raw.success
      ? {}
      : { error: 'The server did not complete the connection test.' }),
    ...(raw.endpointReachable === undefined
      ? {}
      : { endpointReachable: raw.endpointReachable }),
    ...(raw.responseTime === undefined
      ? {}
      : { responseTime: raw.responseTime }),
    ...(raw.tools === undefined ? {} : { tools: raw.tools }),
  };
  if (
    !isPortalMcpTestConnectionResult(result) ||
    result.tools?.some((tool) =>
      credentialValues.some((secret) => tool.includes(secret)),
    )
  ) {
    throw codedError(
      'execution_failed',
      'The MCP connection test returned an invalid or oversized result.',
    );
  }
  // No truncation: a partial result must never be reported as a successful test.
  return enforcePortalResultBudget(result, []);
}

/** Local device deletion only. The serialized existing writer retains cloud copies. */
export async function deletePortalMcpServer(
  serverId: string,
): Promise<PortalMcpDeleteServerResult> {
  await requirePortalDeviceMcp(serverId);
  const { deleteMcpServer } = await import('../ipc/mcp-servers');
  try {
    await deleteMcpServer(serverId);
  } catch {
    throw codedError(
      'execution_failed',
      'The MCP server could not be deleted. Refresh before trying again.',
    );
  }
  return { deleted: true };
}
