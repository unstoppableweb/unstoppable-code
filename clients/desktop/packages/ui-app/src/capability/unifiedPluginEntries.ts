import { withoutAutomationOwnedPipelines } from '../workflows/workflow-library-model';
import { installedShareUpdateAvailable } from './installed-share-provenance';
import type { ResourceOwner } from '@canopy/protocol/resource-owner';
/**
 * Unified capability marketplace projection (CAN-1080 / API-2153 / CAN-1565).
 * A PURE projection over already-loaded desktop data — no React, no IPC, no
 * side effects. Every function here is deterministic given its inputs and
 * never mutates them.
 *
 * See `docs/planning/2026-08-17-plugins-discovery-redesign/design.md` for the
 * design decisions this module implements (unified entry shape, dedup rules,
 * search bands).
 */
import {
  curatedMcpDesktopOnly,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import type {
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/protocol/mcp-servers';
import {
  mcpAuthConnectLabel,
  resolveMcpConnectionBadge,
} from '@canopy/ui-shared/lib/mcp-card-display';
import { mcpAggregateConnection } from '@canopy/ui-shared/lib/mcp-row-health';
import type { CuratedPluginEntry } from '@canopy/protocol/plugin-catalog';
import type { PluginProviderSupport } from '@canopy/protocol/plugins/catalog';
import {
  CURATED_PLUGIN_MARKETPLACE_ID,
  type MarketplaceInfo,
  type PluginDetails,
  type PluginInfo,
  type PluginSkillInfo,
  type SharedPluginSummary,
} from '@canopy/protocol/plugins';
import type { SharedAgentSummary } from '@canopy/protocol/agents';
import {
  WORKSPACE_TEMPLATE_SHARE_LABEL,
  type WorkspaceTemplateShareSummary,
} from '@canopy/protocol/workspace-templates';
import type {
  InstalledSkillInfo,
  SharedSkillInstallOrigin,
  SharedSkillSummary,
} from '@canopy/protocol/skills';
import type { PipelineInfo } from '@canopy/protocol/pipelines';
import {
  authorLinkedLocalIndex,
  type AuthorShareLink,
} from '@canopy/protocol/sharing';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import type { CuratedAutomationSummary } from '@canopy/protocol/automation-catalog';
import type { CuratedPipelineSummary } from '@canopy/protocol/pipeline-catalog';
import type {
  CollectionIndexEntry,
  SharedCollectionSummary,
} from '@canopy/protocol/collections';
import {
  localAgentEntryId,
  type UnifiedEntryOrigin,
  type UnifiedEntryState,
  type UnifiedLocalAgentInput,
} from '@canopy/protocol/unified-entry';
import {
  marketplaceBrowseNameKey,
  marketplaceTitleCase,
  officialProductLogoKey,
  pluginDisplayAuthor,
  pluginDisplayName,
  type UnifiedEntryConnection,
  type UnifiedEntryConnectionStatus,
  type UnifiedEntryFoldedConnector,
  type UnifiedEntryFoldedPlugin,
  type UnifiedEntryAlternative,
  type UnifiedEntryBundledServer,
  type UnifiedEntryBundledServerRow,
  type UnifiedEntryInstalledFrom,
  type UnifiedEntryPluginLink,
  type UnifiedEntryPublicShare,
  type UnifiedEntryRequirement,
  type UnifiedPluginEntry,
  type UnifiedWorkflowFacets,
  type WorkflowLastRun,
  ownShareAudienceText,
} from '@canopy/ui-shared';
import { markdownDescriptionToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';
import { sourceLabelProvider } from '@canopy/ui-shared/lib/unified-plugin-entry';
export { marketplaceTitleCase } from '@canopy/ui-shared';
import { MCP_BRAND_LOGOS } from '@canopy/ui-shared/lib/mcp-brand-logos';
import {
  describeRunUnavailable,
  pipelineTriggerKinds,
} from '../workflows/workflow-library-model';
import {
  WORKFLOW_ITEM_LABEL,
  workflowSearchAlias,
} from '@canopy/ui-shared/lib/workflow-labels';

// ---------------------------------------------------------------------------
// Public types — verbatim per the task brief; later tasks depend on these
// exact names.
// ---------------------------------------------------------------------------

// Shared with the connector rows so "what do we advertise" has one answer.
import {
  buildProviderConnectorRows,
  type ProviderConnectorInput,
} from './providerConnectorRows';
import {
  bundledMcpServersOf,
  githubOwner,
  mcpEndpointKey,
  pluginPackageKey,
  marketplacePluginCatalogKeys,
  pluginSourceLabel,
  shareRefCatalogKey,
} from './pluginProvenance';
import { normalizeShareContentHash } from './share-content-hash';

export type {
  UnifiedEntryKind,
  UnifiedEntryOrigin,
  UnifiedEntryRef,
  UnifiedEntryState,
} from '@canopy/protocol/unified-entry';
export type { UnifiedPluginEntry } from '@canopy/ui-shared';

/** Structural marketplace row required by the pure unified projection. */
export interface UnifiedMarketplacePluginInput extends Pick<
  PluginInfo,
  | 'name'
  | 'displayName'
  | 'description'
  | 'version'
  | 'author'
  | 'category'
  | 'builtIn'
  | 'providerSupport'
  | 'logoUrl'
  | 'homepage'
  | 'externalSource'
  | 'globalInstallStatus'
  | 'codexCompatDisabled'
  | 'parked'
> {
  marketplaceId: string;
  curated?: boolean;
  recommended?: boolean;
  details?: Pick<
    PluginDetails,
    'skills' | 'mcpServers' | 'commands' | 'agents'
  > | null;
  /** Browser summaries collapse provider-specific install state to one bit. */
  installed?: boolean;
  /**
   * The plugin package's own source URL, for hosts whose rows carry no
   * `externalSource` (the Portal's sanitized projection). Distinct from the
   * marketplace's repository URL.
   */
  externalSourceUrl?: string;
  /** Bundled MCP servers, for hosts whose rows carry no `details`. */
  bundledMcpServers?: readonly UnifiedBundledMcpServerInput[];
  /** Bundled skills, for hosts whose rows carry no `details` (CAN-4844). */
  bundledSkills?: readonly Pick<PluginSkillInfo, 'name' | 'description'>[];
}

/** An MCP server a plugin bundles, without command, args, or env. */
export interface UnifiedBundledMcpServerInput {
  name: string;
  type: 'command' | 'http';
  url?: string;
}

export interface UnifiedMarketplaceInput
  extends
    Pick<MarketplaceInfo, 'id' | 'name' | 'curated'>,
    Partial<Pick<MarketplaceInfo, 'sourceType' | 'sourceUrl' | 'builtIn'>> {
  plugins: UnifiedMarketplacePluginInput[];
}

export type UnifiedInstalledSkillInput = Pick<
  InstalledSkillInfo,
  'name' | 'sourceId' | 'description' | 'builtIn'
> &
  Partial<
    Pick<
      InstalledSkillInfo,
      | 'updateAvailable'
      | 'custom'
      | 'updatedAt'
      | 'remote'
      | 'installedFromShare'
    >
  > & {
    /** Existing browser-safe author-side identity supplied by the Portal. */
    shareRemoteId?: string;
    /** Current source hash resolved independently of the paginated browse list. */
    sourceContentHash?: string;
  };

/**
 * A pipeline row. Desktop local rows link to their own share through
 * `remote`; the Portal supplies the same browser-safe link as
 * `shareRemoteId`, with that share's audience in `shareScope` (the skills
 * precedent is {@link UnifiedInstalledSkillInput}).
 */
export type UnifiedPipelineInput = PipelineInfo & { shareRemoteId?: string };

/**
 * A local Collection row. Desktop links its own share through `remote`; the
 * Portal supplies `shareRemoteId`.
 */
export type UnifiedCollectionInput = CollectionIndexEntry & {
  shareRemoteId?: string;
};

/**
 * Structural local automation row. `@canopy/ui-app` cannot import the desktop
 * `ScheduledActivity`, so the host maps its automations onto this shape.
 */
export interface UnifiedLocalAutomationInput {
  /** Local scheduled-activity id. */
  id: string;
  name: string;
  /** One line saying when it runs and what it does. */
  description: string;
  /** Team share this automation was published as, when the user shared it. */
  sharedRemoteId?: string;
  /** Where this copy was installed from, when it was installed. */
  installedFrom?: {
    /** Team-share id, public-share id, or curated key, per `sourceKind`. */
    remoteId: string;
    contentHash: string;
    /** Absent means a team share. */
    sourceKind?: 'shared' | 'public' | 'curated';
  };
  /** Current source hash resolved independently of the paginated browse list. */
  sourceContentHash?: string;
  /** Trigger, action, last run and on/off for the Customize Workflows row. */
  readonly workflow?: Pick<
    UnifiedWorkflowFacets,
    'triggerText' | 'summary' | 'lastRun' | 'enabled'
  >;
}

/**
 * Cached MCP status a host supplies. Desktop status entries and the Portal's
 * redacted row projection (with its row id as `serverId`) both satisfy it.
 */
export interface UnifiedMcpStatusInput {
  serverId: string;
  connectionStatus: McpServerStatusEntry['connectionStatus'];
  reachability: McpServerStatusEntry['reachability'];
  handler?: McpServerStatusEntry['handler'];
  lastCheckedAt?: McpServerStatusEntry['lastCheckedAt'];
  configs: ReadonlyArray<
    Pick<
      McpServerStatusEntry['configs'][number],
      'configId' | 'authStatus' | 'canRefresh'
    >
  >;
}

export interface UnifiedEntryInputs {
  /** Authenticated account id in the shared summaries' creator namespace. */
  viewerId?: string | null;
  personalOrganizationId?: string | null;
  curatedPlugins: CuratedPluginEntry[];
  marketplaces: UnifiedMarketplaceInput[];
  installedSkills: UnifiedInstalledSkillInput[];
  mcpServers: McpServerIndexEntry[];
  mcpStatuses: UnifiedMcpStatusInput[];
  curatedMcpServers: CuratedMcpServerEntry[];
  /** Per-provider connector reads; empty until they resolve. */
  providerConnectors: ProviderConnectorInput[];
  pipelines?: UnifiedPipelineInput[];
  /**
   * User pipelines a live automation owns (CAN-4551); each is listed under
   * its automation instead of as a pipeline.
   */
  ownedPipelineIds?: ReadonlySet<string>;
  /**
   * Newest run per pipeline id; a listed id with no run maps to null.
   * Omitted when the host has no run data (or has not loaded it yet).
   */
  pipelineLastRuns?: ReadonlyMap<string, WorkflowLastRun | null>;
  /** Host-specific reason a manually runnable pipeline entry cannot run. */
  pipelineRunUnavailable?: ReadonlyMap<string, string>;
  localCollections?: UnifiedCollectionInput[];
  sharedSkills?: SharedSkillSummary[];
  sharedCollections?: SharedCollectionSummary[];
  localAutomations?: UnifiedLocalAutomationInput[];
  sharedAutomations?: SharedAutomationSummary[];
  curatedAutomations?: CuratedAutomationSummary[];
  /** Pipeline templates from the cloud's curated catalog. */
  curatedPipelines?: CuratedPipelineSummary[];
  /**
   * List every shared automation even when a local copy or source exists.
   * Only the Automations tab's "Shared by me" facet sets it, so the user's
   * own share appears beside the local automation it was published from.
   */
  skipLocalAutomationDedupe?: boolean;
  /** New section hosts keep installed catalog rows in Browse as well. */
  retainAutomationCatalogEntries?: boolean;
  /**
   * The host's complete local agent inventory; omitted while the Agents flag
   * is off or when the host has no local agents to supply.
   */
  localAgents?: UnifiedLocalAgentInput[];
  /** Agents shared with the viewer; omitted while the Agents flag is off. */
  sharedAgents?: SharedAgentSummary[];
  /** Plugin references shared with the viewer. */
  sharedPlugins?: SharedPluginSummary[];
  /** Project templates shared with the viewer's teams and organizations. */
  sharedBlueprints?: WorkspaceTemplateShareSummary[];
  appName?: string;
  /**
   * Fold a curated plugin that declares exactly one curated MCP key into that
   * key's integration card (REG-3033). Only a host whose MCP detail can
   * install the folded plugin opts in; a host whose card detail cannot keeps
   * the plugin's own card so it stays reachable and installable.
   */
  foldSingleKeyPlugins?: boolean;
}

export interface RankedResults {
  installed: UnifiedPluginEntry[];
  curatedPlugins: UnifiedPluginEntry[];
  curatedApps: UnifiedPluginEntry[];
  marketplace: UnifiedPluginEntry[];
  /** Plugin references shared with the viewer, apart from the catalog. */
  sharedPlugins: UnifiedPluginEntry[];
  skills: UnifiedPluginEntry[];
  pipelines: UnifiedPluginEntry[];
  automations: UnifiedPluginEntry[];
  collections: UnifiedPluginEntry[];
  agents: UnifiedPluginEntry[];
  projectTemplates: UnifiedPluginEntry[];
}

/**
 * Project the curated marketplace row back into catalog-entry shape for the
 * unified projection.
 *
 * The curated **plugin** catalog is fetched, hashed, and materialized entirely
 * in the main process (`main/plugins/curated-plugin-catalog.ts`); the renderer
 * has no `CuratedPluginEntry` accessor and this change adds no IPC. What the
 * renderer does receive is the synced `curated/cloud` marketplace row, whose
 * `PluginInfo` entries carry the catalog's display metadata (`displayName`,
 * `description`, `category`, `author`) plus the per-user `recommended` flag
 * that the curated scan copies out of the managed marketplace manifest.
 *
 * Fields the row genuinely cannot carry (`logoUrl`, `contentHash`,
 * `sortOrder`, `updatedAt`, `popular`) are filled with inert defaults — the
 * projection never reads them. `key` is the plugin `name`, which is exactly the
 * join key `buildUnifiedPluginEntries` uses to merge a catalog entry with its
 * marketplace row.
 */
export function curatedCatalogFromMarketplaces(
  marketplaces: UnifiedMarketplaceInput[],
): CuratedPluginEntry[] {
  const curated = marketplaces.find(
    (marketplace) =>
      marketplace.curated === true ||
      marketplace.id === CURATED_PLUGIN_MARKETPLACE_ID,
  );
  if (!curated) return [];
  return curated.plugins.map((plugin, index): CuratedPluginEntry => {
    const details = plugin.details;
    return {
      key: plugin.name,
      name: pluginDisplayName(plugin),
      shortDescription: plugin.description ?? '',
      version: plugin.version,
      authorName: plugin.author,
      categories: plugin.category ? [plugin.category] : [],
      popular: false,
      recommended: plugin.recommended === true,
      sortOrder: index,
      contentHash: '',
      mcpServers: (details?.mcpServers ?? []).map((server) => server.name),
      skills: (details?.skills ?? []).map((skill) => ({
        key: skill.name,
        name: skill.name,
        contentHash: '',
        files: [],
      })),
      updatedAt: '',
    };
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NEUTRAL_PROVIDER_SUPPORT: { claude: boolean; codex: boolean } = {
  claude: true,
  codex: true,
};

function emptyComponents(): UnifiedPluginEntry['components'] {
  return { skills: 0, mcpServers: 0, commands: 0, agents: 0 };
}

function availabilityLabel(state: UnifiedEntryState): string {
  if (state === 'installed') return 'Installed';
  if (state === 'needs-auth') return 'Needs attention';
  return 'Available';
}

function sharedOwnershipLabel(
  owner: ResourceOwner | undefined,
  shareScope: string | undefined,
): string | undefined {
  const ownerLabel =
    owner && owner.type !== 'system'
      ? owner.name?.trim() || undefined
      : undefined;
  const scopeLabel =
    shareScope && shareScope !== 'private'
      ? `${shareScope.charAt(0).toUpperCase()}${shareScope.slice(1)}`
      : undefined;
  return [ownerLabel, scopeLabel].filter(Boolean).join(' · ') || undefined;
}

/**
 * The ownership label of a local row the viewer's own loaded share folds
 * into. A private (public-link) share reads `Shared`, not the viewer's name.
 */
function authorShareOwnershipLabel(share: {
  owner?: ResourceOwner;
  shareScope?: string;
}): string | undefined {
  return share.shareScope === 'private'
    ? ownShareAudienceText('private')
    : sharedOwnershipLabel(share.owner, share.shareScope);
}

/**
 * The team or organization a shared row is shared with, read from its owner.
 * A personal owner (a private or public share) names no narrower audience.
 */
function sharedWithFromOwner(
  owner: ResourceOwner | undefined,
): Pick<UnifiedPluginEntry, 'sharedWith'> {
  if (!owner || (owner.type !== 'team' && owner.type !== 'organization')) {
    return {};
  }
  const name = owner.name?.trim();
  return {
    sharedWith: {
      audience: owner.type,
      ...(owner.type === 'organization' ? { organizationId: owner.id } : {}),
      ...(name ? { name } : {}),
    },
  };
}

/**
 * For each share the viewer created that exactly one local row links to, the
 * index of that row (see `authorLinkedLocalIndex`), keyed by share id.
 */
function authorLinkedLocals<TShare>(
  shares: readonly TShare[],
  shareKey: (
    share: TShare,
  ) => { id: string; createdBy?: { id: string } | null } | undefined,
  locals: readonly AuthorShareLink[],
  viewerId: string | null | undefined,
): Map<string, number> {
  const linked = new Map<string, number>();
  if (!viewerId || locals.length === 0) return linked;
  for (const share of shares) {
    const key = shareKey(share);
    if (!key) continue;
    const index = authorLinkedLocalIndex(key, locals, viewerId);
    if (index !== undefined) linked.set(key.id, index);
  }
  return linked;
}

/** Which providers a capability can actually run on. */
export interface CapabilityReach {
  claude: boolean;
  codex: boolean;
}

/**
 * `PluginProviderSupport` uses per-facet mode strings; every consumer of this
 * module only needs a boolean per provider. Codex `'compat'` still counts as
 * supported — the compatibility layer makes the plugin usable from Codex.
 *
 * Exported so the plugin picker derives reach the same way this page does,
 * instead of re-deriving it from the mode strings and drifting.
 */
export function capabilityReach(
  support: PluginProviderSupport,
): CapabilityReach {
  return {
    claude: support.claude === 'native',
    codex: support.codex !== 'none',
  };
}

/**
 * Whether `a` reaches every provider `b` does, so dropping `b` in favour of
 * `a` takes nothing away.
 *
 * Exported because the picker collapses the same duplicates this page does and
 * must not use a different rule: a Claude-only copy and a Codex-only copy both
 * "reach one provider", so a plain first-wins tie-break lets marketplace order
 * decide which survives, and whichever loses takes that capability away
 * entirely from users of its provider.
 */
export function capabilityCovers(
  a: CapabilityReach,
  b: CapabilityReach,
): boolean {
  return (a.claude || !b.claude) && (a.codex || !b.codex);
}

function pluginProviderSupport(
  plugin: UnifiedMarketplacePluginInput,
): CapabilityReach {
  return capabilityReach(plugin.providerSupport);
}

function builtInAnyProviderInstalled(
  status: PluginInfo['globalInstallStatus'],
): boolean {
  if (!status) return false;
  return Boolean(status.claude?.installed) || Boolean(status.codex?.installed);
}

function pluginDetailsComponents(
  details:
    | Pick<PluginDetails, 'skills' | 'mcpServers' | 'commands' | 'agents'>
    | null
    | undefined,
): UnifiedPluginEntry['components'] {
  return {
    skills: details?.skills.length ?? 0,
    mcpServers: details?.mcpServers.length ?? 0,
    commands: details?.commands.length ?? 0,
    agents: details?.agents.length ?? 0,
  };
}

function isCuratedMarketplace(marketplace: UnifiedMarketplaceInput): boolean {
  return (
    marketplace.curated === true ||
    marketplace.id === CURATED_PLUGIN_MARKETPLACE_ID
  );
}

// ---------------------------------------------------------------------------
// Rule 1 — curated plugins: catalog entry + curated/cloud marketplace row.
// ---------------------------------------------------------------------------

function findCuratedMarketplace(
  marketplaces: UnifiedMarketplaceInput[],
): UnifiedMarketplaceInput | undefined {
  return marketplaces.find(isCuratedMarketplace);
}

/** Distinct curated MCP keys a plugin declares, in declaration order. */
function pluginCuratedMcpKeys(entry: CuratedPluginEntry): string[] {
  return Array.from(new Set(entry.mcpServers));
}

/**
 * Whether the user installed this curated plugin. Provider install state is
 * the answer when the row carries it; the portal's collapsed bit otherwise.
 * The desktop marks every materialized curated plugin `installed` because
 * its content is on disk, which is not the same as the user having added it.
 */
function curatedPluginInstalled(
  row: UnifiedMarketplacePluginInput | undefined,
): boolean {
  if (!row) return false;
  if (row.parked) return true;
  if (row.globalInstallStatus)
    return builtInAnyProviderInstalled(row.globalInstallStatus);
  return row.installed === true;
}

interface CuratedPluginProjection {
  entries: UnifiedPluginEntry[];
  /** Plugins folded into the integration card for their one curated key. */
  folded: Map<string, UnifiedEntryFoldedPlugin>;
}

/**
 * Rule 1 with the REG-3033 fold: a curated plugin that declares exactly one
 * curated MCP key the catalog lists becomes part of that key's integration
 * card instead of a card of its own. A plugin that needs several integrations
 * stays a plugin card with one requirement chip per key, because folding it
 * anywhere would hide the other requirements.
 */
function buildCuratedPluginEntries(
  curatedPlugins: CuratedPluginEntry[],
  marketplaces: UnifiedMarketplaceInput[],
  curatedMcpByKey: ReadonlyMap<string, CuratedMcpServerEntry>,
  foldSingleKeyPlugins: boolean,
): CuratedPluginProjection {
  const curatedMarketplace = findCuratedMarketplace(marketplaces);
  const rowsByPluginName = new Map<string, UnifiedMarketplacePluginInput>();
  if (curatedMarketplace) {
    for (const plugin of curatedMarketplace.plugins) {
      rowsByPluginName.set(plugin.name, plugin);
    }
  }

  const folded = new Map<string, UnifiedEntryFoldedPlugin>();
  const entries: UnifiedPluginEntry[] = [];
  for (const entry of curatedPlugins) {
    const row = rowsByPluginName.get(entry.key);
    const name = pluginDisplayName({
      name: entry.name,
      displayName: row?.displayName,
    });
    const keys = pluginCuratedMcpKeys(entry);
    const [onlyKey] = keys;
    const foldable =
      foldSingleKeyPlugins &&
      keys.length === 1 &&
      onlyKey !== undefined &&
      curatedMcpByKey.has(onlyKey);
    // One key, one card: the first plugin to claim a key folds into it. A
    // later plugin for the same key keeps its own card, naming the
    // integration it needs, rather than vanishing behind the first.
    if (foldable && !folded.has(onlyKey)) {
      folded.set(onlyKey, {
        key: entry.key,
        name,
        skills: entry.skills.length,
        installed: curatedPluginInstalled(row),
      });
      continue;
    }
    const state: UnifiedEntryState = row
      ? marketplacePluginState(row)
      : 'available';
    const providerSupport = row
      ? pluginProviderSupport(row)
      : NEUTRAL_PROVIDER_SUPPORT;
    const requirements: UnifiedEntryRequirement[] = keys.map((key) => ({
      key,
      name: curatedMcpByKey.get(key)?.name ?? key,
      entryId: `mcp-catalog:${key}`,
    }));
    entries.push({
      id: `curated:${entry.key}`,
      kind: 'plugin',
      origin: 'curated',
      name,
      description: entry.shortDescription,
      logoUrl: entry.logoUrl ?? marketplaceProductIconUrl(entry.authorUrl),
      categories: [...entry.categories],
      authorName: entry.authorName,
      typeLabel: 'Plugin',
      sourceLabel: 'Curated',
      ownershipLabel: entry.authorName,
      availabilityLabel: availabilityLabel(state),
      components: {
        skills: entry.skills.length,
        mcpServers: entry.mcpServers.length,
        commands: 0,
        agents: 0,
      },
      providerSupport,
      ...installedPluginFacts(row),
      state,
      recommended: entry.recommended === true,
      catalogSortOrder: entry.sortOrder,
      ...(requirements.length > 1 || foldable ? { requirements } : {}),
      ref: { type: 'curated-plugin', key: entry.key },
    });
  }
  return { entries, folded };
}

// ---------------------------------------------------------------------------
// Rules 2 & 5 — MCP server entries: curated-catalog merge, and local-only.
// ---------------------------------------------------------------------------

/** Portable Portal account rows carry configuration identity without cloud credentials. */
function accountConfigId(server: McpServerIndexEntry): string | undefined {
  return (
    server.accountConnection?.configId ??
    (server.scope === 'account' && server.configs.length === 1
      ? server.configs[0]?.id
      : undefined)
  );
}

function findMcpStatus(
  serverId: string,
  statuses: readonly UnifiedMcpStatusInput[],
  configId?: string,
): UnifiedMcpStatusInput | undefined {
  return statuses.find(
    (status) =>
      status.serverId === serverId &&
      (configId === undefined ||
        status.configs.some((config) => config.configId === configId)),
  );
}

function mcpStateFromStatus(
  status: UnifiedMcpStatusInput | undefined,
): UnifiedEntryState {
  return status?.connectionStatus === 'auth_required'
    ? 'needs-auth'
    : 'installed';
}

type McpConfigAuthStatus =
  McpServerStatusEntry['configs'][number]['authStatus'];

/**
 * The state an account row's cloud connection lifecycle decides, or
 * `undefined` when the status decides (a connected or non-account row). A
 * pending or disconnected connection is not installed, whatever its status
 * entry says; configuration auth only refines a connected row. A Portal
 * account row can arrive without its connection, and there the desktop's
 * `not_connected` stands for that same pending or disconnected lifecycle.
 */
function accountLifecycleState(
  server: McpServerIndexEntry,
  ownAuthStatus: McpConfigAuthStatus | undefined,
): UnifiedEntryState | undefined {
  switch (server.accountConnection?.status) {
    case 'PENDING':
    case 'DISCONNECTED':
      return 'available';
    case 'REAUTH_REQUIRED':
      return 'needs-auth';
    case 'CONNECTED':
      return undefined;
    case undefined:
      return server.scope === 'account' && ownAuthStatus === 'not_connected'
        ? 'available'
        : undefined;
  }
}

function mcpServerState(
  server: McpServerIndexEntry,
  status: UnifiedMcpStatusInput | undefined,
): UnifiedEntryState {
  return accountLifecycleState(server, undefined) ?? mcpStateFromStatus(status);
}

/**
 * The Installed badge for one server, from the same derivation the detail
 * health section uses. An account row reads only its own configuration's
 * status; without one it falls back to the cloud connection state.
 */
function mcpEntryConnection(
  server: McpServerIndexEntry,
  status: UnifiedMcpStatusInput | undefined,
): UnifiedEntryConnectionStatus {
  const configId = accountConfigId(server);
  const own =
    status !== undefined &&
    (configId === undefined ||
      status.configs.length === 0 ||
      status.configs.some((config) => config.configId === configId))
      ? status
      : undefined;
  const badge = resolveMcpConnectionBadge(
    own,
    server.accountConnection?.status,
  );
  const lastCheckedAt = own?.lastCheckedAt;
  const ownConfigs =
    own?.configs.filter(
      (config) => configId === undefined || config.configId === configId,
    ) ?? [];
  const labels = ownConfigs.map((config) =>
    mcpAuthConnectLabel(config.authStatus, config.canRefresh),
  );
  const signIn = labels.includes('Reconnect')
    ? 'reconnect'
    : labels.includes('Connect')
      ? 'connect'
      : undefined;
  // Status carries no probe result, so a device HTTP server this desktop signs
  // in to reads as unknown until a check says otherwise; never as `No auth`.
  // It also reports a disabled config as not_configured, which asks nothing.
  const requirementUnknown =
    badge.status === 'unknown' &&
    server.type === 'http' &&
    !isAccountServer(server) &&
    !badge.isProvider &&
    (own?.handler ?? server.authHandler ?? 'canopy') === 'canopy' &&
    ownConfigs.length > 0 &&
    ownConfigs.every((config) => config.authStatus === 'not_configured') &&
    server.configs.some(
      (config) =>
        config.enabled && ownConfigs.some((own) => own.configId === config.id),
    );
  return {
    status: badge.status,
    ...(badge.isProvider ? { provider: true } : {}),
    ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
    ...(signIn !== undefined ? { signIn } : {}),
    ...(requirementUnknown ? { requirementUnknown } : {}),
    ...(!mcpServerEnabled(server) ? { disabled: true } : {}),
  };
}

function mcpAppComponents(): UnifiedPluginEntry['components'] {
  return { ...emptyComponents(), mcpServers: 1 };
}

/** The card's state from everything bound to it: the best binding wins. */
function integrationState(
  connections: readonly UnifiedEntryConnection[],
  plugin: UnifiedEntryFoldedPlugin | undefined,
): UnifiedEntryState {
  if (connections.some((connection) => connection.state === 'installed'))
    return 'installed';
  if (connections.some((connection) => connection.state === 'needs-auth'))
    return 'needs-auth';
  // The plugin is installed but has nothing to run against: the card asks
  // for the connection rather than offering Add again.
  if (plugin?.installed) return 'needs-auth';
  return 'available';
}

/** How an index row names itself on its integration card. */
function connectionName(server: McpServerIndexEntry): string {
  const account =
    server.scope === 'account' || server.accountConnection !== undefined;
  if (account) {
    return (
      server.configs[0]?.name ??
      server.accountConnection?.displayName ??
      server.name
    );
  }
  return server.name;
}

/**
 * The state of one connection on a card. Account rows for one key share the
 * provider server id, so a status matched on the id alone handed every
 * connection the first match's state; an account row reads the status entry's
 * own configuration. The connection's lifecycle decides first; the
 * configuration only refines a connected row.
 */
function connectionState(
  server: McpServerIndexEntry,
  status: UnifiedMcpStatusInput | undefined,
): UnifiedEntryState {
  const configId = accountConfigId(server);
  if (status && configId !== undefined && status.configs.length > 0) {
    // Undefined when the entry describes other configurations, not this one.
    const config = status.configs.find(
      (candidate) => candidate.configId === configId,
    );
    return (
      accountLifecycleState(server, config?.authStatus) ??
      (config ? authStatusState(config.authStatus) : 'installed')
    );
  }
  return mcpServerState(server, status);
}

function authStatusState(authStatus: McpConfigAuthStatus): UnifiedEntryState {
  switch (authStatus) {
    case 'not_connected':
    case 'expired':
    case 'error':
      return 'needs-auth';
    default:
      return 'installed';
  }
}

/**
 * Whether a configuration waits for the user to sign in: never connected, or
 * its sign-in expired. An auth error is a failure to fix, not a pending
 * sign-in, so it keeps `Needs attention` (CAN-4840).
 */
function authStatusAwaitsSignIn(authStatus: McpConfigAuthStatus): boolean {
  switch (authStatus) {
    case 'not_connected':
    case 'expired':
      return true;
    default:
      return false;
  }
}

/** The sign-in half of `mcpServerState`. */
function serverAwaitsSignIn(
  server: McpServerIndexEntry,
  status: UnifiedMcpStatusInput | undefined,
): boolean {
  const lifecycle = accountLifecycleState(server, undefined);
  if (lifecycle !== undefined) return lifecycle === 'needs-auth';
  return status?.connectionStatus === 'auth_required';
}

/** The sign-in half of `connectionState`, read from the same sources. */
function connectionAwaitsSignIn(
  server: McpServerIndexEntry,
  status: UnifiedMcpStatusInput | undefined,
): boolean {
  const configId = accountConfigId(server);
  if (status && configId !== undefined && status.configs.length > 0) {
    const config = status.configs.find(
      (candidate) => candidate.configId === configId,
    );
    const lifecycle = accountLifecycleState(server, config?.authStatus);
    if (lifecycle !== undefined) return lifecycle === 'needs-auth';
    return config ? authStatusAwaitsSignIn(config.authStatus) : false;
  }
  return serverAwaitsSignIn(server, status);
}

/**
 * How many sign-ins one installed row is waiting on; the row's chip shows
 * exactly this count. A device row with configurations counts each one that
 * waits for sign-in; any other row counts its own connection.
 */
function mcpPendingSignIns(
  server: McpServerIndexEntry,
  status: UnifiedMcpStatusInput | undefined,
): number {
  if (
    status &&
    accountConfigId(server) === undefined &&
    status.configs.length > 0
  ) {
    return status.configs.filter((config) =>
      authStatusAwaitsSignIn(config.authStatus),
    ).length;
  }
  return connectionAwaitsSignIn(server, status) ? 1 : 0;
}

function isAccountServer(server: McpServerIndexEntry): boolean {
  return server.scope === 'account' || server.accountConnection !== undefined;
}

function mcpServerEnabled(server: McpServerIndexEntry): boolean {
  return (
    server.accountConnection?.enabled !== false &&
    ((server.configs?.length ?? 0) === 0 ||
      server.configs.some((config) => config.enabled))
  );
}

function serverConnection(
  server: McpServerIndexEntry,
  state: UnifiedEntryState,
): UnifiedEntryConnection {
  const account = isAccountServer(server);
  const configId =
    server.accountConnection?.configId ??
    server.configs.find((config) => config.enabled)?.id ??
    server.configs[0]?.id;
  return {
    serverId: server.id,
    ...(configId !== undefined ? { configId } : {}),
    name: connectionName(server),
    binding: account ? 'account' : 'device',
    state,
    ...(server.accountConnectionId !== undefined
      ? { accountConnectionId: server.accountConnectionId }
      : {}),
  };
}

interface FoldedConnector extends UnifiedEntryFoldedConnector {
  /** Providers the connector is linked on, for the card's connection rows. */
  connectedProviders: readonly ('claude' | 'codex')[];
}

const PROVIDER_ACCOUNT_LABELS: Record<'claude' | 'codex', string> = {
  claude: 'Claude account',
  codex: 'Codex account',
};

/**
 * Rule 2 with the REG-3033 fold: one card per curated key carrying every
 * connection to it (account, device, or a provider account) and the plugin
 * that ships its skills.
 */
function buildCuratedMcpEntry(
  entry: CuratedMcpServerEntry,
  servers: readonly McpServerIndexEntry[],
  mcpStatuses: readonly UnifiedMcpStatusInput[],
  plugin: UnifiedEntryFoldedPlugin | undefined,
  connector: FoldedConnector | undefined,
): UnifiedPluginEntry {
  const connections: UnifiedEntryConnection[] = servers.map((server) =>
    serverConnection(
      server,
      connectionState(
        server,
        findMcpStatus(server.id, mcpStatuses, accountConfigId(server)),
      ),
    ),
  );
  for (const provider of connector?.connectedProviders ?? []) {
    connections.push({
      serverId: entry.key,
      name: PROVIDER_ACCOUNT_LABELS[provider],
      binding: 'provider',
      state: 'installed',
    });
  }
  const desktopOnly = curatedMcpDesktopOnly(entry);
  // The cloud account never runs a desktop-only server (REG-3035). A
  // connection made before it was marked stays on the card so its detail can
  // disconnect it, but it never decides the card's state: it cannot make the
  // card set up, ask for a cloud reconnect, or stand in for the device
  // server Add creates.
  const state = integrationState(
    desktopOnly
      ? connections.filter((connection) => connection.binding !== 'account')
      : connections,
    plugin,
  );
  const accountBound = connections.some(
    (connection) => connection.binding === 'account',
  );
  // The sum of what each server's own row would count; provider account
  // connections never wait for sign-in here.
  const pendingSignIns = servers
    .filter((server) => !desktopOnly || !isAccountServer(server))
    .reduce(
      (count, server) =>
        count +
        mcpPendingSignIns(
          server,
          findMcpStatus(server.id, mcpStatuses, accountConfigId(server)),
        ),
      0,
    );
  const surface = desktopOnly ? 'desktop' : accountBound ? 'cloud' : undefined;
  const logoUrl =
    entry.logoUrl ?? servers.find((server) => server.logoUrl)?.logoUrl;
  // One binding has one health; several (Personal and Work) keep theirs on
  // the detail rather than an invented aggregate.
  const onlyServer = servers.length === 1 ? servers[0] : undefined;
  const connection =
    onlyServer === undefined
      ? undefined
      : mcpEntryConnection(
          onlyServer,
          findMcpStatus(
            onlyServer.id,
            mcpStatuses,
            accountConfigId(onlyServer),
          ),
        );
  const aggregateConnection =
    servers.length > 1
      ? mcpAggregateConnection(
          servers
            .filter((server) => !desktopOnly || !isAccountServer(server))
            .map((server) => ({
              enabled: mcpServerEnabled(server),
              connection: mcpEntryConnection(
                server,
                findMcpStatus(server.id, mcpStatuses, accountConfigId(server)),
              ),
            })),
        )
      : undefined;
  const bindings = new Set(connections.map((connection) => connection.binding));
  const placement =
    bindings.has('account') && bindings.has('device')
      ? 'both'
      : bindings.has('account')
        ? 'account'
        : bindings.has('device')
          ? 'desktop'
          : undefined;
  return {
    id: `mcp-catalog:${entry.key}`,
    kind: 'app',
    origin: 'curated',
    name: entry.name,
    description: entry.shortDescription,
    logoUrl: logoUrl ?? marketplaceProductIconUrl(entry.authorUrl),
    categories: [...entry.categories],
    authorName: entry.authorName,
    typeLabel: 'MCP server',
    sourceLabel: 'Curated',
    ownershipLabel: entry.authorName,
    availabilityLabel: availabilityLabel(state),
    components: { ...mcpAppComponents(), skills: plugin?.skills ?? 0 },
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state,
    ...(surface ? { surface } : {}),
    ...(connection ? { connection } : {}),
    ...(aggregateConnection ? { aggregateConnection } : {}),
    ...(placement ? { placement } : {}),
    mcpTargetCount:
      servers.reduce(
        (count, server) => count + (server.configs?.length ?? 0),
        0,
      ) + (connector?.connectedProviders.length ?? 0),
    ...(pendingSignIns > 0 ? { pendingSignIns } : {}),
    recommended: false,
    catalogSortOrder: entry.sortOrder,
    integration: {
      curatedKey: entry.key,
      ...(plugin ? { plugin } : {}),
      ...(connector
        ? {
            connector: {
              displayName: connector.displayName,
              connected: connector.connected,
            },
          }
        : {}),
      connections,
    },
    ref: { type: 'curated-mcp', key: entry.key },
  };
}

function buildLocalMcpEntry(
  server: McpServerIndexEntry,
  state: UnifiedEntryState,
  connection: UnifiedEntryConnectionStatus,
  pendingSignIns: number,
): UnifiedPluginEntry {
  // Account rows for one key share the server id, so the configuration is
  // part of the identity; a device row's id is already its own.
  const configId = accountConfigId(server);
  return {
    id:
      configId === undefined
        ? `mcp-local:${server.id}`
        : `mcp-local:${server.id}/${configId}`,
    kind: 'app',
    origin: 'installed-standalone',
    name: server.name,
    description: server.description,
    logoUrl: server.logoUrl,
    categories: [],
    authorName: undefined,
    typeLabel: 'MCP server',
    sourceLabel: 'Local',
    availabilityLabel: availabilityLabel(state),
    components: mcpAppComponents(),
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state,
    surface:
      server.scope === 'account' || server.accountConnection
        ? 'cloud'
        : 'desktop',
    connection,
    mcpTargetCount: server.configs?.length ?? 0,
    ...(connection.provider === true
      ? {}
      : {
          placement:
            server.scope === 'account' || server.accountConnection
              ? ('account' as const)
              : ('desktop' as const),
        }),
    ...(pendingSignIns > 0 ? { pendingSignIns } : {}),
    recommended: false,
    ref: {
      type: 'local-mcp',
      serverId: server.id,
      ...(configId !== undefined ? { configId } : {}),
      // The catalog can be empty or stale while the bundled mark for this key
      // ships with the app; keep the key so the logo still resolves.
      ...(server.curatedKey ? { curatedKey: server.curatedKey } : {}),
    },
  };
}

interface CuratedServerGroups {
  /** Every server for a key, in index order: a Personal and a Work connection are two rows on one card. */
  serversByKey: Map<string, McpServerIndexEntry[]>;
  /** Curated keys in the order the index first names them. */
  cardOrder: string[];
  /** Rows no catalog entry claims; each keeps a card of its own. */
  uncurated: McpServerIndexEntry[];
}

/**
 * Groups the index by curated key. The inventory nests a device file under
 * the account row it shadows, and the picker projection lifts only the copies
 * whose key differs from the row's; a same-key copy is still one of the key's
 * bindings, so it counts on the card. A device id is taken once even where a
 * copy was also lifted to the top level.
 */
function groupServersByCuratedKey(
  mcpServers: readonly McpServerIndexEntry[],
  curatedByKey: ReadonlyMap<string, CuratedMcpServerEntry>,
): CuratedServerGroups {
  const groups: CuratedServerGroups = {
    serversByKey: new Map(),
    cardOrder: [],
    uncurated: [],
  };
  const seenDeviceIds = new Set<string>();
  const place = (server: McpServerIndexEntry): void => {
    const curated = server.curatedKey
      ? curatedByKey.get(server.curatedKey)
      : undefined;
    if (!curated) return;
    if (server.scope !== 'account') {
      if (seenDeviceIds.has(server.id)) return;
      seenDeviceIds.add(server.id);
    }
    const group = groups.serversByKey.get(curated.key);
    if (group) group.push(server);
    else {
      groups.serversByKey.set(curated.key, [server]);
      groups.cardOrder.push(curated.key);
    }
  };
  for (const server of mcpServers) {
    const curated = server.curatedKey
      ? curatedByKey.get(server.curatedKey)
      : undefined;
    if (!curated) {
      groups.uncurated.push(server);
      continue;
    }
    place(server);
    for (const copy of server.deviceCopies ?? []) place(copy);
  }
  return groups;
}

function buildMcpAppEntries(
  mcpServers: McpServerIndexEntry[],
  mcpStatuses: readonly UnifiedMcpStatusInput[],
  curatedMcpServers: CuratedMcpServerEntry[],
  curatedByKey: ReadonlyMap<string, CuratedMcpServerEntry>,
  foldedPlugins: ReadonlyMap<string, UnifiedEntryFoldedPlugin>,
  foldedConnectors: ReadonlyMap<string, FoldedConnector>,
): UnifiedPluginEntry[] {
  const { serversByKey, cardOrder, uncurated } = groupServersByCuratedKey(
    mcpServers,
    curatedByKey,
  );
  const entries: UnifiedPluginEntry[] = uncurated.map((server) => {
    const status = findMcpStatus(
      server.id,
      mcpStatuses,
      accountConfigId(server),
    );
    const state = connectionState(server, status);
    return buildLocalMcpEntry(
      server,
      state,
      mcpEntryConnection(server, status),
      mcpPendingSignIns(server, status),
    );
  });

  const cards: UnifiedPluginEntry[] = [];
  for (const key of [
    ...cardOrder,
    ...curatedMcpServers
      .map((entry) => entry.key)
      .filter((key) => !serversByKey.has(key)),
  ]) {
    const curated = curatedByKey.get(key);
    if (!curated) continue;
    cards.push(
      buildCuratedMcpEntry(
        curated,
        serversByKey.get(key) ?? [],
        mcpStatuses,
        foldedPlugins.get(key),
        foldedConnectors.get(key),
      ),
    );
  }
  return [...cards, ...entries];
}

// ---------------------------------------------------------------------------
// Rule 3 — non-curated marketplace plugins.
// ---------------------------------------------------------------------------

function marketplacePluginState(
  plugin: UnifiedMarketplacePluginInput,
): UnifiedEntryState {
  if (plugin.parked || plugin.installed === true) return 'installed';
  if (!plugin.globalInstallStatus) return 'available';
  return builtInAnyProviderInstalled(plugin.globalInstallStatus)
    ? 'installed'
    : 'available';
}

/** Pixel size requested from GitHub's avatar endpoint. */
const GITHUB_AVATAR_SIZE_PX = 128;

/**
 * GitHub owner avatar for a repository URL, or nothing if it is not one.
 *
 * Fetching is not done here: the returned URL is handed to the existing
 * main-process image resolver (`useSafeRemoteImageUrl`), which fetches off the
 * renderer, refuses private hosts, caps size and redirects, and hands back an
 * inert data URL.
 */
export function githubOwnerAvatarUrl(
  repoUrl: string | undefined,
): string | undefined {
  // The owner is validated against a strict handle pattern before it is
  // interpolated, so nothing can carry a path or query out of that position.
  const owner = githubOwner(repoUrl);
  if (owner === undefined) return undefined;
  return `https://github.com/${owner}.png?size=${String(GITHUB_AVATAR_SIZE_PX)}`;
}

/**
 * A product-site favicon for catalog records whose provider omitted artwork.
 *
 * The result still goes through the main-process remote-image resolver before
 * it reaches an `<img>`, so the renderer never loads the third-party resource
 * directly. Keeping this as a final fallback means catalog product artwork and
 * bundled marks always win, while every official connector with an author URL
 * avoids dropping all the way to a misleading initial-only avatar.
 */
function marketplaceProductIconUrl(
  productUrl: string | undefined,
): string | undefined {
  if (productUrl === undefined || productUrl === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(productUrl);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return undefined;
  }
  parsed.hash = '';
  return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(parsed.toString())}&sz=128`;
}

/**
 * Bundled mark for a marketplace plugin, when Canopy already ships one.
 *
 * Two cases, both resolved from data rather than from a per-plugin mapping:
 *
 * - Canopy's OWN built-in plugins wear the app's brand mark. They ship inside
 *   the app, so there is no publisher repo to point at, and the brand asset
 *   comes from the runtime rather than a constant so whitelabel builds show
 *   their own mark rather than Canopy's.
 * - Recognizable entries from Codex's built-in marketplace reuse their product
 *   mark. Publisher metadata is not consistent enough to establish identity:
 *   the same official feed may identify the publisher as OpenAI, the connected
 *   product, or omit it. The marketplace id plus the explicit product mapping
 *   below is stable, while an arbitrary plugin merely named `github` cannot
 *   impersonate GitHub.
 */
function bundledPluginLogo(
  marketplaceId: string,
  plugin: MarketplacePluginLogoInput,
): string | undefined {
  const logoKey = officialProductLogoKey(marketplaceId, plugin);
  return logoKey === undefined ? undefined : MCP_BRAND_LOGOS[logoKey];
}

/**
 * Fallback logo for a marketplace plugin: the avatar of whoever publishes it.
 *
 * Codex catalog entries normally carry their own product logo. Older cached
 * rows and provider catalogs without that field still use this source-derived
 * fallback before the card gives up and renders a monogram.
 *
 * Resolved PER PLUGIN, from the plugin's own source, never from the
 * marketplace that lists it. A marketplace is usually an aggregator:
 * `claude-plugins-official` publishes 286 plugins from 179 different owners
 * (Auth0, CrowdStrike, Adobe, Figma…). Using the marketplace owner would badge
 * every one of those with Anthropic's mark, which is worse than a monogram —
 * a blank tile says nothing, but the wrong logo asserts the wrong provenance.
 *
 * `externalSource.url` is the vendored repo the plugin is pulled from and is
 * the strongest signal; `homepage` covers the plugins that live in the
 * marketplace repo itself (it points at their own subdirectory, so the owner
 * still resolves correctly — including genuinely first-party ones). A plugin
 * with neither keeps its monogram rather than borrowing the marketplace's
 * identity.
 */
export function pluginOwnerAvatarUrl(
  plugin: Pick<UnifiedMarketplacePluginInput, 'externalSource' | 'homepage'>,
): string | undefined {
  return (
    githubOwnerAvatarUrl(plugin.externalSource?.url) ??
    githubOwnerAvatarUrl(plugin.homepage)
  );
}

/** The fields a marketplace listing's mark is resolved from. */
export type MarketplacePluginLogoInput = Pick<
  UnifiedMarketplacePluginInput,
  'name' | 'logoUrl' | 'homepage' | 'externalSource' | 'builtIn'
>;

/**
 * The mark a non-curated marketplace listing wears, resolved exactly as its
 * card resolves it. Curated listings' cards resolve through
 * `buildCuratedPluginEntries` instead; on the portal the two agree today only
 * because the wire row carries no `logoUrl`, `homepage` or `authorUrl`.
 *
 * Exported because a detail page can load a listing on its own — the web
 * portal's does, by route, and never sees the entry its card was built from.
 * Resolving there by hand is how the portal detail came to show a monogram
 * beside a card wearing the Microsoft 365 mark; sharing the resolver keeps the
 * two from drifting.
 */
export function marketplacePluginLogo(
  marketplaceId: string,
  plugin: MarketplacePluginLogoInput,
): Pick<UnifiedPluginEntry, 'logoUrl' | 'bundledLogo' | 'brandMark'> {
  const bundledLogo = bundledPluginLogo(marketplaceId, plugin);
  return {
    logoUrl:
      plugin.logoUrl ??
      pluginOwnerAvatarUrl(plugin) ??
      (bundledLogo === undefined
        ? marketplaceProductIconUrl(plugin.homepage)
        : undefined),
    bundledLogo,
    brandMark: plugin.builtIn === true,
  };
}

function installedPluginFacts(
  plugin: UnifiedMarketplacePluginInput | undefined,
): Pick<UnifiedPluginEntry, 'version' | 'installedHarnesses'> {
  const status = plugin?.globalInstallStatus;
  if (!status) {
    // Without provider status the manifest version is the installed cache's.
    const version = plugin?.version?.trim();
    return plugin && version && marketplacePluginState(plugin) === 'installed'
      ? { version }
      : {};
  }
  // Turning Codex compatibility off leaves the generated copy's install status
  // in place, but Codex no longer runs it.
  const codex = plugin?.codexCompatDisabled === true ? undefined : status.codex;
  const installed = [status.claude, codex].filter(
    (provider) => provider?.installed === true,
  );
  const version = installed[0]?.version;
  return {
    installedHarnesses: {
      claude: status.claude?.installed === true,
      codex: codex?.installed === true,
    },
    ...(version && installed.every((provider) => provider?.version === version)
      ? { version }
      : {}),
  };
}

function buildMarketplacePluginEntries(
  marketplaces: readonly UnifiedMarketplaceInput[],
): UnifiedPluginEntry[] {
  const entries: UnifiedPluginEntry[] = [];
  for (const marketplace of marketplaces) {
    if (isCuratedMarketplace(marketplace)) continue;
    for (const plugin of marketplace.plugins) {
      const logo = marketplacePluginLogo(marketplace.id, plugin);
      // Product over publisher, the same rule the mark above follows.
      const author = pluginDisplayAuthor(marketplace.id, plugin);
      entries.push({
        id: `mkt:${marketplace.id}/${plugin.name}`,
        kind: 'plugin',
        origin: 'marketplace',
        name: pluginDisplayName(plugin),
        description: plugin.description ?? '',
        logoUrl: logo.logoUrl,
        bundledLogo: logo.bundledLogo,
        brandMark: logo.brandMark,
        categories: plugin.category ? [plugin.category] : [],
        authorName: author,
        typeLabel: 'Plugin',
        sourceLabel: pluginSourceLabel(marketplace, plugin),
        ownershipLabel: author,
        availabilityLabel: availabilityLabel(marketplacePluginState(plugin)),
        components: pluginDetailsComponents(plugin.details),
        providerSupport: pluginProviderSupport(plugin),
        state: marketplacePluginState(plugin),
        ...installedPluginFacts(plugin),
        recommended: false,
        ref: {
          type: 'marketplace-plugin',
          marketplaceId: marketplace.id,
          pluginName: plugin.name,
        },
      });
    }
  }
  return entries;
}

/** A plugin's bundled skills, first of each name only. */
function bundledSkillsOf(
  plugin: UnifiedMarketplacePluginInput,
): readonly Pick<PluginSkillInfo, 'name' | 'description'>[] {
  const skills = plugin.bundledSkills ?? plugin.details?.skills ?? [];
  const byName = new Map<
    string,
    Pick<PluginSkillInfo, 'name' | 'description'>
  >();
  for (const skill of skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

/**
 * The skills each installed marketplace plugin bundles, as Installed rows
 * that follow the plugin's status (CAN-4844). They have no status, update or
 * removal of their own; `bundledBy` links them to the canonical plugin row,
 * including curated plugins whose ids come from the catalog projection.
 */
export function buildPluginSkillEntries(
  marketplaces: readonly UnifiedMarketplaceInput[],
  curatedEntries: readonly UnifiedPluginEntry[] = [],
): UnifiedPluginEntry[] {
  const curatedByKey = new Map<string, UnifiedPluginEntry>();
  for (const entry of curatedEntries) {
    if (entry.ref.type === 'curated-plugin') {
      curatedByKey.set(entry.ref.key, entry);
    }
  }
  const entries: UnifiedPluginEntry[] = [];
  const seen = new Set<string>();
  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      const curated = isCuratedMarketplace(marketplace);
      const parent = curated ? curatedByKey.get(plugin.name) : undefined;
      if (curated && !parent) continue;
      const state = parent?.state ?? marketplacePluginState(plugin);
      if (state !== 'installed') continue;
      const logo = marketplacePluginLogo(marketplace.id, plugin);
      const bundledBy: UnifiedEntryPluginLink = {
        entryId: parent?.id ?? `mkt:${marketplace.id}/${plugin.name}`,
        name: parent?.name ?? pluginDisplayName(plugin),
      };
      for (const skill of bundledSkillsOf(plugin)) {
        const id = `plugin-skill:${marketplace.id}/${plugin.name}:${skill.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        entries.push({
          id,
          kind: 'skill',
          origin: 'marketplace',
          name: skill.name,
          description: skill.description,
          logoUrl: logo.logoUrl,
          bundledLogo: logo.bundledLogo,
          brandMark: logo.brandMark,
          categories: [],
          authorName: undefined,
          typeLabel: 'Skill',
          sourceLabel: pluginSourceLabel(marketplace, plugin),
          availabilityLabel: 'Installed',
          components: { ...emptyComponents(), skills: 1 },
          providerSupport: pluginProviderSupport(plugin),
          state: 'installed',
          bundledBy,
          recommended: false,
          ref: {
            type: 'plugin-skill',
            marketplaceId: marketplace.id,
            pluginName: plugin.name,
            skillName: skill.name,
          },
        });
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Rule 4 — installed skills.
// ---------------------------------------------------------------------------

/**
 * Publisher avatar for an installed skill, from the repo it was installed
 * from.
 *
 * Skills record their origin as `github:<owner>:<repo>` (colon-separated, not
 * a URL — see `SkillLockEntry.sourceId`), so this reassembles the repo URL and
 * reuses the same resolution the plugin entries use. Locally authored and
 * built-in skills have no such origin and keep their monogram.
 */
export function skillOwnerAvatarUrl(
  skill: UnifiedInstalledSkillInput,
): string | undefined {
  const [kind, owner, repo] = skill.sourceId.split(':');
  if (kind !== 'github' || !owner || !repo) {
    return undefined;
  }
  return githubOwnerAvatarUrl(`https://github.com/${owner}/${repo}`);
}

/** The unified entry id of a locally installed skill. */
function installedSkillEntryId(skill: UnifiedInstalledSkillInput): string {
  return `skill:${skill.sourceId}:${skill.name}`;
}

/**
 * The install receipt of a skill copied from a share, when it may stand in
 * for that share: only an app-authored copy, never a built-in one.
 */
function sharedInstallReceipt(
  skill: UnifiedInstalledSkillInput,
): SharedSkillInstallOrigin | undefined {
  return skill.sourceId === 'custom:app' && skill.builtIn !== true
    ? skill.installedFromShare
    : undefined;
}

function trimmedName(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** The receipt's names for the installed row; empty when it names nobody. */
function receiptAttribution(
  receipt: SharedSkillInstallOrigin,
): UnifiedEntryInstalledFrom {
  const sharedByName = trimmedName(receipt.sharedByName);
  const ownerName = trimmedName(receipt.ownerName);
  const teamName = trimmedName(receipt.teamName);
  return {
    ...(sharedByName ? { sharedByName } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(teamName ? { teamName } : {}),
  };
}

function projectInstalledSkill(
  skill: UnifiedInstalledSkillInput,
): UnifiedPluginEntry {
  const receipt = sharedInstallReceipt(skill);
  return {
    id: installedSkillEntryId(skill),
    kind: 'skill',
    origin: 'installed-standalone',
    name: skill.name,
    description: skill.description,
    logoUrl: skillOwnerAvatarUrl(skill),
    // Built-in skills ship inside the app, same as built-in plugins, so they
    // wear the app's mark rather than a publisher's.
    brandMark: skill.builtIn === true,
    categories: [],
    authorName: undefined,
    typeLabel: 'Skill',
    sourceLabel: skill.builtIn
      ? 'Built-in'
      : skill.sourceId.startsWith('github:')
        ? 'GitHub'
        : 'Local',
    ownershipLabel: skill.sourceId.startsWith('github:')
      ? skill.sourceId.split(':')[1]
      : undefined,
    availabilityLabel: 'Installed',
    components: { ...emptyComponents(), skills: 1 },
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state: 'installed',
    updateAvailable: skill.updateAvailable,
    builtIn: skill.builtIn,
    custom: skill.custom,
    ...(receipt
      ? {
          installedFrom: receiptAttribution(receipt),
          shareUpdateAvailable: installedShareUpdateAvailable(
            receipt,
            skill.sourceContentHash,
          ),
        }
      : {}),
    // Built-in skills carry an empty `updatedAt`; only the viewer's own skills
    // say when they were edited (CAN-4844).
    editedAt:
      skill.custom === true && skill.updatedAt ? skill.updatedAt : undefined,
    recommended: false,
    ref: { type: 'skill', sourceId: skill.sourceId, skillName: skill.name },
  };
}

function buildSkillEntries(
  installedSkills: UnifiedInstalledSkillInput[],
): UnifiedPluginEntry[] {
  return installedSkills.map(projectInstalledSkill);
}

/**
 * The `buildUnifiedPluginEntries` entry for one locally installed skill,
 * display name included. Exported so a host can open an installed skill's
 * detail page before its own inventory projection has caught up (CAN-3483).
 */
export function buildInstalledSkillEntry(
  skill: UnifiedInstalledSkillInput,
): UnifiedPluginEntry {
  const entry = projectInstalledSkill(skill);
  return { ...entry, name: marketplaceTitleCase(entry.name) };
}

// ---------------------------------------------------------------------------
// Capability marketplace additions (CAN-1565 / CAN-1567).
// ---------------------------------------------------------------------------

function pipelineSourceLabel(source: PipelineInfo['source']): string {
  switch (source) {
    case 'curated':
      return 'Curated';
    case 'bundled':
      return 'Built-in';
    case 'project':
      return 'Project';
    case 'shared':
      return 'Shared';
    case 'user':
      return 'Local';
  }
}

function pipelineOrigin(source: PipelineInfo['source']): UnifiedEntryOrigin {
  switch (source) {
    case 'curated':
      return 'curated';
    case 'bundled':
      return 'built-in';
    case 'project':
      return 'project';
    case 'shared':
      return 'shared';
    case 'user':
      return 'installed-standalone';
  }
}

function pipelineWorkflowFacets(
  pipeline: PipelineInfo,
  lastRuns: ReadonlyMap<string, WorkflowLastRun | null> | undefined,
  runUnavailable: ReadonlyMap<string, string> | undefined,
): UnifiedWorkflowFacets {
  const kinds = pipelineTriggerKinds(pipeline.triggerTypes ?? []);
  const hostUnavailable = runUnavailable?.get(
    `pipeline:${pipeline.source}:${pipeline.id}`,
  );
  const runnable = kinds.includes('manual') && hostUnavailable === undefined;
  return {
    triggers: kinds.map((kind) => {
      switch (kind) {
        case 'schedule':
          return {
            kind,
            label: 'Schedule',
            explainer: 'Runs on its schedule',
          };
        case 'once':
          return {
            kind,
            label: 'One time',
            explainer: 'Runs once at the scheduled time',
          };
        case 'manual':
          return {
            kind,
            label: 'Manual',
            explainer: 'Runs when you start it',
          };
        case 'plan-approved':
          return {
            kind,
            label: 'Plan approval',
            explainer: 'Runs automatically when a plan is approved',
          };
        case 'task-ready':
          return {
            kind,
            label: 'Task ready',
            explainer: 'Runs when a task is marked ready',
          };
        case 'workflow':
          return {
            kind,
            label: 'Workflow',
            explainer: 'Runs from the Workflows page and its schedules',
          };
      }
    }),
    ...(pipeline.stepCount === undefined
      ? {}
      : { stepCount: pipeline.stepCount }),
    runnable,
    ...(pipeline.readonly ? { readonly: true } : {}),
    ...(runnable
      ? {}
      : {
          runUnavailableLabel: hostUnavailable ?? describeRunUnavailable(kinds),
        }),
    ...(lastRuns ? { lastRun: lastRuns.get(pipeline.id) ?? null } : {}),
  };
}

/**
 * Pipeline rows. The viewer's own share that exactly one local pipeline links
 * to folds into that row: the share stays in the projection with
 * `installedEntryId`, so Browse leaves it out while direct links and "Shared
 * by me" still find it, and the local row carries the share's audience.
 */
function buildPipelineEntries(
  pipelines: UnifiedPipelineInput[],
  viewerId: string | null | undefined,
  lastRuns?: ReadonlyMap<string, WorkflowLastRun | null>,
  runUnavailable?: ReadonlyMap<string, string>,
): UnifiedPluginEntry[] {
  const listed = pipelines.filter(
    (
      pipeline,
    ): pipeline is UnifiedPipelineInput & {
      source: Exclude<PipelineInfo['source'], 'curated'>;
    } => pipeline.source !== 'curated',
  );
  const entryId = (pipeline: (typeof listed)[number]): string =>
    `pipeline:${pipeline.source}:${pipeline.id}`;
  const locals = listed.filter((pipeline) => pipeline.source !== 'shared');
  const shares = listed.filter((pipeline) => pipeline.source === 'shared');
  const localIndexByShare = authorLinkedLocals(
    shares,
    (share) =>
      share.remoteId
        ? { id: share.remoteId, createdBy: share.createdBy }
        : undefined,
    locals,
    viewerId,
  );
  const shareByLocalEntryId = new Map<string, (typeof listed)[number]>();
  const localEntryIdByShare = new Map<string, string>();
  for (const share of shares) {
    const index = share.remoteId
      ? localIndexByShare.get(share.remoteId)
      : undefined;
    const local = index === undefined ? undefined : locals[index];
    if (!local) continue;
    shareByLocalEntryId.set(entryId(local), share);
    localEntryIdByShare.set(entryId(share), entryId(local));
  }
  return listed.map((pipeline): UnifiedPluginEntry => {
    const id = entryId(pipeline);
    const installedEntryId = localEntryIdByShare.get(id);
    const state: UnifiedEntryState =
      pipeline.source === 'shared' && !installedEntryId
        ? 'available'
        : 'installed';
    const authorShare = shareByLocalEntryId.get(id);
    const authorScope =
      pipeline.remote?.shareScope ??
      (pipeline.shareRemoteId ? pipeline.shareScope : undefined);
    return {
      id,
      kind: 'pipeline',
      origin: pipelineOrigin(pipeline.source),
      name: pipeline.name,
      description: pipeline.description,
      categories: [],
      authorName: pipeline.owner?.name ?? undefined,
      typeLabel: WORKFLOW_ITEM_LABEL,
      sourceLabel: pipelineSourceLabel(pipeline.source),
      ownershipLabel: authorShare
        ? authorShareOwnershipLabel(authorShare)
        : authorScope
          ? ownShareAudienceText(authorScope)
          : sharedOwnershipLabel(pipeline.owner, pipeline.shareScope),
      ...(pipeline.source === 'shared'
        ? sharedWithFromOwner(pipeline.owner)
        : authorShare
          ? sharedWithFromOwner(authorShare.owner)
          : {}),
      availabilityLabel: availabilityLabel(state),
      components: emptyComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state,
      ...(installedEntryId ? { installedEntryId } : {}),
      recommended: false,
      pipeline: {
        source: pipeline.source,
        scopes: pipeline.scopes ?? ['directory'],
        triggerTypes: pipeline.triggerTypes ?? [],
      },
      workflow: pipelineWorkflowFacets(pipeline, lastRuns, runUnavailable),
      ref: {
        type: 'pipeline',
        pipelineId: pipeline.id,
        source: pipeline.source,
        ...(pipeline.filePath ? { filePath: pipeline.filePath } : {}),
        ...(pipeline.remoteId ? { remoteId: pipeline.remoteId } : {}),
      },
    };
  });
}

/**
 * The local copy each share was installed as, by install receipt (CAN-5223).
 * The receipt's share id wins anywhere in the inventory; otherwise a copy
 * whose recorded source hash equals the share's, which recognizes a source
 * shared again under a new id. The receipt hash describes the installed
 * source, not the current file, so it never proves byte equality. Within each
 * rule the first copy wins. Copies without a receipt (resource context
 * enforcement off) never match here; the detail page still finds them by
 * reading their bytes.
 */
function sharedSkillInstalls(
  installedSkills: UnifiedInstalledSkillInput[],
): (skill: SharedSkillSummary) => string | undefined {
  const byShareId = new Map<string, string>();
  const byHash = new Map<string, string>();
  for (const installed of installedSkills) {
    const receipt = sharedInstallReceipt(installed);
    if (!receipt) continue;
    const entryId = installedSkillEntryId(installed);
    if (!byShareId.has(receipt.remoteId))
      byShareId.set(receipt.remoteId, entryId);
    const hash = normalizeShareContentHash(receipt.contentHash);
    if (hash && !byHash.has(hash)) byHash.set(hash, entryId);
  }
  return (skill) => {
    const byId = byShareId.get(skill.id);
    if (byId) return byId;
    const hash = normalizeShareContentHash(skill.contentHash);
    return hash ? byHash.get(hash) : undefined;
  };
}

/**
 * Shared skills, each folded into its local copy when one is installed. The
 * alias stays in the projection, so shared-detail routes and Shared by me
 * still find it; Customize lists the local copy and leaves it out of Browse.
 */
function buildSharedSkillEntries(
  skills: SharedSkillSummary[],
  installedSkills: UnifiedInstalledSkillInput[],
  viewerId: string | null | undefined,
): UnifiedPluginEntry[] {
  const installedEntryIdFor = sharedSkillInstalls(installedSkills);
  function authorInstalledEntryId(
    share: SharedSkillSummary,
  ): string | undefined {
    const index = authorLinkedLocalIndex(share, installedSkills, viewerId);
    const match = index === undefined ? undefined : installedSkills[index];
    return match ? installedSkillEntryId(match) : undefined;
  }
  return skills.map((skill): UnifiedPluginEntry => {
    const installedEntryId =
      installedEntryIdFor(skill) ?? authorInstalledEntryId(skill);
    return {
      id: `skill:shared:${skill.id}`,
      kind: 'skill',
      origin: 'shared',
      name: skill.name,
      description: skill.description,
      categories: [],
      authorName:
        skill.owner.type === 'system'
          ? undefined
          : (skill.owner.name ?? undefined),
      typeLabel: 'Skill',
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(skill.owner, skill.shareScope),
      ...sharedWithFromOwner(skill.owner),
      sharedSince: skill.createdAt,
      availabilityLabel: installedEntryId ? 'Installed' : 'Available',
      components: { ...emptyComponents(), skills: 1 },
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: installedEntryId ? 'installed' : 'available',
      ...(installedEntryId ? { installedEntryId } : {}),
      recommended: false,
      ref: { type: 'shared-skill', skillId: skill.id },
    };
  });
}

/** Plugins and skills a shared collection lists, custom skills included. */
function sharedCollectionItemCounts(collection: SharedCollectionSummary): {
  skills: number;
  plugins: number;
} {
  return {
    skills: collection.itemCounts.skills + collection.itemCounts.customSkills,
    plugins: collection.itemCounts.plugins,
  };
}

/**
 * Local and shared collections, with each local copy added from a share
 * linked to that share: the local row learns who shared it and whether the
 * share changed since, and the share's Browse card reads Installed. When
 * several local copies name one share, all of them link and the card installs
 * to the first by index order. The viewer's own share that exactly one local
 * Collection links to folds the same way, and that local row carries the
 * share's audience.
 */
function buildCollectionEntries(
  localCollections: UnifiedCollectionInput[],
  sharedCollections: SharedCollectionSummary[],
  viewerId: string | null | undefined,
): UnifiedPluginEntry[] {
  const sharesById = new Map(
    sharedCollections.map((share) => [share.id, share]),
  );
  const localEntryIdByShare = new Map<string, string>();
  for (const collection of localCollections) {
    const remoteId = collection.sharedSource?.remoteId;
    if (remoteId && !localEntryIdByShare.has(remoteId)) {
      localEntryIdByShare.set(remoteId, localCollectionEntryId(collection.id));
    }
  }
  const authorShareByLocalIndex = new Map<number, SharedCollectionSummary>();
  for (const [shareId, index] of authorLinkedLocals(
    sharedCollections,
    (share) => share,
    localCollections,
    viewerId,
  )) {
    const share = sharesById.get(shareId);
    if (share) authorShareByLocalIndex.set(index, share);
  }
  const authorEntryIdByShare = new Map<string, string>();
  for (const [index, share] of authorShareByLocalIndex) {
    const local = localCollections[index];
    if (local) {
      authorEntryIdByShare.set(share.id, localCollectionEntryId(local.id));
    }
  }

  const local = localCollections.map(
    (collection, index): UnifiedPluginEntry => {
      const authorShare = authorShareByLocalIndex.get(index);
      const base: UnifiedPluginEntry = {
        id: localCollectionEntryId(collection.id),
        kind: 'collection',
        origin: 'installed-standalone',
        name: collection.name,
        description: collection.description,
        categories: [],
        typeLabel: 'Collection',
        sourceLabel: 'Local',
        collectionRevision: collection.revision ?? collection.updatedAt,
        collectionProvenanceUnknown:
          collection.hasSharedSource === true ||
          collection.provenanceUnknown === true,
        ownedByViewer:
          !collection.sharedSource &&
          !collection.hasSharedSource &&
          !collection.provenanceUnknown,
        availabilityLabel: 'Installed',
        components: {
          skills: collection.skillCount,
          mcpServers: collection.mcpServerCount,
          commands: 0,
          agents: 0,
          plugins: collection.pluginCount,
        },
        providerSupport: NEUTRAL_PROVIDER_SUPPORT,
        state: 'installed',
        recommended: false,
        ...(authorShare
          ? {
              ownershipLabel: authorShareOwnershipLabel(authorShare),
              ...sharedWithFromOwner(authorShare.owner),
            }
          : collection.remote
            ? {
                ownershipLabel: ownShareAudienceText(
                  collection.remote.shareScope,
                ),
              }
            : {}),
        ref: { type: 'local-collection', collectionId: collection.id },
      };
      const source = collection.sharedSource;
      if (!source) return base;
      base.ownedByViewer = undefined;
      const installedContentHash = source.contentHash;
      const share = sharesById.get(source.remoteId);
      if (!share) {
        return {
          ...base,
          sharedSource: {
            remoteId: source.remoteId,
            ...(installedContentHash ? { installedContentHash } : {}),
          },
        };
      }
      const sharedBy =
        share.createdBy?.name?.trim() || ownerDisplayName(share.owner);
      const updateAvailable =
        !!installedContentHash &&
        !!share.contentHash &&
        installedContentHash !== share.contentHash;
      return {
        ...base,
        authorName: sharedBy,
        ownershipLabel: sharedOwnershipLabel(share.owner, share.shareScope),
        ...sharedWithFromOwner(share.owner),
        availabilityLabel: updateAvailable ? 'Update available' : 'Installed',
        ...(updateAvailable ? { updateAvailable: true } : {}),
        ...(viewerId != null
          ? { ownedByViewer: share.createdBy?.id === viewerId }
          : {}),
        sharedSource: {
          remoteId: source.remoteId,
          ...(installedContentHash ? { installedContentHash } : {}),
          latestContentHash: share.contentHash,
          ...(sharedBy ? { sharedBy } : {}),
          updatedAt: share.updatedAt,
          latestItemCounts: sharedCollectionItemCounts(share),
        },
      };
    },
  );

  const shared = sharedCollections.map((collection): UnifiedPluginEntry => {
    const installedEntryId =
      localEntryIdByShare.get(collection.id) ??
      authorEntryIdByShare.get(collection.id);
    const counts = sharedCollectionItemCounts(collection);
    return {
      id: `collection:shared:${collection.id}`,
      kind: 'collection',
      origin: 'shared',
      name: collection.name,
      description: collection.description,
      categories: [],
      authorName:
        collection.createdBy?.name ??
        (collection.owner.type === 'system'
          ? undefined
          : (collection.owner.name ?? undefined)),
      typeLabel: 'Collection',
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(
        collection.owner,
        collection.shareScope,
      ),
      ...sharedWithFromOwner(collection.owner),
      sharedSince: collection.createdAt,
      availabilityLabel: installedEntryId ? 'Installed' : 'Available',
      components: {
        skills: counts.skills,
        mcpServers: 0,
        commands: 0,
        agents: 0,
        plugins: counts.plugins,
      },
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: installedEntryId ? 'installed' : 'available',
      ...(installedEntryId ? { installedEntryId } : {}),
      recommended: false,
      ref: { type: 'shared-collection', collectionId: collection.id },
    };
  });

  return [...local, ...shared];
}

/** The unified entry id of a local collection, as its detail page opens it. */
export function localCollectionEntryId(collectionId: string): string {
  return `collection:local:${collectionId}`;
}

// ---------------------------------------------------------------------------
// Agents, plugin references and project templates shared with the viewer.
// ---------------------------------------------------------------------------

function ownerDisplayName(owner: ResourceOwner): string | undefined {
  return owner.type === 'system' ? undefined : (owner.name ?? undefined);
}

function buildLocalAgentEntries(
  agents: UnifiedLocalAgentInput[],
): UnifiedPluginEntry[] {
  return agents.map(
    (agent): UnifiedPluginEntry => ({
      id: localAgentEntryId(agent.id),
      kind: 'agent',
      origin: 'installed-standalone',
      name: agent.name,
      description: agent.description,
      categories: [],
      typeLabel: 'Agent',
      sourceLabel: 'Local',
      availabilityLabel: agent.available ? 'Installed' : 'Unavailable',
      components: { ...emptyComponents(), agents: 1 },
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'installed',
      recommended: false,
      ref: { type: 'local-agent', agentId: agent.id },
    }),
  );
}

const LOCAL_AGENT_ENTRY_PREFIX = localAgentEntryId('');

/** The local agent id an entry id names, or `null` for any other entry. */
export function localAgentIdFromEntryId(entryId: string): string | null {
  if (!entryId.startsWith(LOCAL_AGENT_ENTRY_PREFIX)) return null;
  const agentId = entryId.slice(LOCAL_AGENT_ENTRY_PREFIX.length);
  return agentId === '' ? null : agentId;
}

/**
 * A local agent opened by id before the inventory lists it, such as a deep
 * link that lands while agents hydrate. Its detail resolves the definition,
 * or reports the agent missing once the inventory has settled.
 */
export function pendingLocalAgentEntry(
  entryId: string,
): UnifiedPluginEntry | null {
  const agentId = localAgentIdFromEntryId(entryId);
  if (agentId === null) return null;
  return {
    id: entryId,
    kind: 'agent',
    origin: 'installed-standalone',
    name: 'Agent',
    description: '',
    categories: [],
    typeLabel: 'Agent',
    sourceLabel: 'Local',
    availabilityLabel: 'Installed',
    components: { ...emptyComponents(), agents: 1 },
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state: 'installed',
    recommended: false,
    ref: { type: 'local-agent', agentId },
  };
}

/**
 * Shared agents the viewer already holds a local copy of are listed once, as
 * the local row. Only an exact `sharedRemoteId` match folds; names never do.
 * The viewer's own non-private share passes through so it stays resolvable
 * for direct links and "Shared by me"; {@link buildSharedAgentEntries} folds
 * it into the local row.
 */
function sharedAgentsWithoutLocalCopies(
  shared: SharedAgentSummary[],
  local: UnifiedLocalAgentInput[],
  viewerId?: string | null,
): SharedAgentSummary[] {
  const localRemoteIds = new Set(
    local.flatMap((agent) =>
      agent.sharedRemoteId ? [agent.sharedRemoteId] : [],
    ),
  );
  if (localRemoteIds.size === 0) return shared;
  return shared.filter(
    (agent) =>
      !localRemoteIds.has(agent.id) ||
      (viewerId != null &&
        agent.createdBy.id === viewerId &&
        agent.shareScope !== 'private'),
  );
}

function buildSharedAgentEntries(
  agents: SharedAgentSummary[],
  local: readonly UnifiedLocalAgentInput[],
  viewerId: string | null | undefined,
): UnifiedPluginEntry[] {
  // A local agent records no account on its link, so any link counts.
  const localIndexByShare = authorLinkedLocals(
    agents,
    (agent) => agent,
    local.map((agent) => ({ shareRemoteId: agent.sharedRemoteId })),
    viewerId,
  );
  return agents.map((agent): UnifiedPluginEntry => {
    const index = localIndexByShare.get(agent.id);
    const linked = index === undefined ? undefined : local[index];
    const installedEntryId = linked ? localAgentEntryId(linked.id) : undefined;
    return {
      id: `agent:shared:${agent.id}`,
      kind: 'agent',
      origin: 'shared',
      name: agent.name,
      description: agent.instructionsPreview,
      categories: [],
      authorName: agent.createdBy.name ?? ownerDisplayName(agent.owner),
      typeLabel: 'Agent',
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(agent.owner, agent.shareScope),
      ...sharedWithFromOwner(agent.owner),
      sharedSince: agent.createdAt,
      availabilityLabel: installedEntryId ? 'Installed' : 'Available',
      components: { ...emptyComponents(), agents: 1 },
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: installedEntryId ? 'installed' : 'available',
      ...(installedEntryId ? { installedEntryId } : {}),
      recommended: false,
      ref: { type: 'shared-agent', agentId: agent.id },
    };
  });
}

/**
 * A shared plugin carries no logo of its own, so it shows its catalog
 * listing's. Joined on the ref's catalog and plugin name, never on the display
 * name, so a same-named plugin from another catalog lends it nothing.
 */
interface SharedPluginListing {
  marketplace: UnifiedMarketplaceInput;
  plugin: UnifiedMarketplacePluginInput;
}

function sharedPluginCatalogFacts(
  plugins: readonly SharedPluginSummary[],
  marketplaces: readonly UnifiedMarketplaceInput[],
): (
  plugin: SharedPluginSummary,
) => Pick<
  UnifiedPluginEntry,
  'logoUrl' | 'bundledLogo' | 'brandMark' | 'sharedSourceProvider'
> & { listing?: SharedPluginListing } {
  const listings = new Map<string, SharedPluginListing>();
  if (plugins.length > 0) {
    for (const marketplace of marketplaces) {
      for (const plugin of marketplace.plugins) {
        for (const key of marketplacePluginCatalogKeys(
          marketplace,
          plugin.name,
        )) {
          if (!listings.has(key)) listings.set(key, { marketplace, plugin });
        }
      }
    }
  }
  return (shared) => {
    const refProvider =
      shared.ref.type === 'codex_plugin'
        ? 'Codex'
        : shared.ref.type === 'claude_plugin'
          ? 'Claude'
          : undefined;
    const key = shareRefCatalogKey(shared.ref);
    const listing = key === undefined ? undefined : listings.get(key);
    const provider =
      refProvider ??
      (listing &&
        sourceLabelProvider(
          pluginSourceLabel(listing.marketplace, listing.plugin),
        ));
    return {
      ...(listing
        ? marketplacePluginLogo(listing.marketplace.id, listing.plugin)
        : {}),
      ...(provider ? { sharedSourceProvider: provider } : {}),
      ...(listing ? { listing } : {}),
    };
  };
}

/**
 * Shared plugin references. A shared plugin has no author-side link, so the
 * viewer's own share folds into the catalog listing it names when that
 * listing is installed and listed (`installedListingIds`).
 */
function buildSharedPluginEntries(
  plugins: SharedPluginSummary[],
  marketplaces: readonly UnifiedMarketplaceInput[],
  viewerId: string | null | undefined,
  installedListingIds: ReadonlySet<string>,
): UnifiedPluginEntry[] {
  const catalogFacts = sharedPluginCatalogFacts(plugins, marketplaces);
  return plugins.map((plugin): UnifiedPluginEntry => {
    const { listing, ...facts } = catalogFacts(plugin);
    const listingId = listing
      ? `mkt:${listing.marketplace.id}/${listing.plugin.name}`
      : undefined;
    const installedEntryId =
      viewerId &&
      plugin.createdBy.id === viewerId &&
      listingId &&
      installedListingIds.has(listingId)
        ? listingId
        : undefined;
    return {
      id: `plugin:shared:${plugin.externalId}`,
      ...facts,
      kind: 'plugin',
      origin: 'shared',
      name: plugin.name,
      description: plugin.description ?? '',
      categories: [],
      authorName: plugin.createdBy.name ?? ownerDisplayName(plugin.owner),
      typeLabel: 'Plugin',
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(plugin.owner, plugin.shareScope),
      ...sharedWithFromOwner(plugin.owner),
      sharedSince: plugin.createdAt,
      availabilityLabel: installedEntryId ? 'Installed' : 'Available',
      components: emptyComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: installedEntryId ? 'installed' : 'available',
      ...(installedEntryId ? { installedEntryId } : {}),
      recommended: false,
      ref: { type: 'shared-plugin', pluginId: plugin.externalId },
    };
  });
}

function buildCuratedPipelineEntries(
  pipelines: readonly CuratedPipelineSummary[],
): UnifiedPluginEntry[] {
  return pipelines.map(
    (pipeline): UnifiedPluginEntry => ({
      id: `pipeline:curated:${pipeline.key}`,
      kind: 'pipeline',
      origin: 'curated',
      name: pipeline.name,
      description: pipeline.shortDescription,
      categories: pipeline.categories,
      authorName: pipeline.authorName ?? undefined,
      typeLabel: WORKFLOW_ITEM_LABEL,
      sourceLabel: 'Curated',
      availabilityLabel: 'Available',
      components: emptyComponents(),
      providerSupport: { claude: false, codex: false },
      state: 'available',
      recommended: pipeline.popular,
      catalogSortOrder: pipeline.sortOrder,
      pipeline: {
        source: 'curated',
        scopes: pipeline.scopes,
        triggerTypes: pipeline.triggerTypes,
      },
      ref: { type: 'curated-pipeline', key: pipeline.key },
    }),
  );
}

function buildSharedBlueprintEntries(
  blueprints: WorkspaceTemplateShareSummary[],
): UnifiedPluginEntry[] {
  return blueprints.map(
    (blueprint): UnifiedPluginEntry => ({
      id: `blueprint:shared:${blueprint.externalId}`,
      kind: 'blueprint',
      origin: 'shared',
      name: blueprint.name,
      description: blueprint.description,
      categories: [],
      authorName: blueprint.createdBy.name ?? ownerDisplayName(blueprint.owner),
      // `blueprint` is the internal kind; users read "project template".
      typeLabel: WORKSPACE_TEMPLATE_SHARE_LABEL,
      sourceLabel: 'Shared',
      ownershipLabel: sharedOwnershipLabel(
        blueprint.owner,
        blueprint.audience === 'PUBLIC'
          ? undefined
          : blueprint.audience.toLowerCase(),
      ),
      ...sharedWithFromOwner(blueprint.owner),
      sharedSince: blueprint.createdAt,
      availabilityLabel: 'Available',
      components: emptyComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'available',
      recommended: false,
      ref: { type: 'shared-blueprint', blueprintId: blueprint.externalId },
    }),
  );
}

// ---------------------------------------------------------------------------
// Automations: local copies, team shares, and the curated catalog.
// ---------------------------------------------------------------------------

type AutomationInstallSourceKind = 'shared' | 'curated';

/**
 * Which Marketplace source a local automation was installed from, or `null`
 * for one the user authored or installed from a public share. Public installs
 * record a public-share id, a different namespace from team-share ids and
 * curated keys, so they never pair with a Marketplace row.
 */
function automationInstallSourceKind(
  automation: UnifiedLocalAutomationInput,
): AutomationInstallSourceKind | null {
  if (!automation.installedFrom) return null;
  const sourceKind = automation.installedFrom.sourceKind ?? 'shared';
  return sourceKind === 'public' ? null : sourceKind;
}

interface AutomationEntryOptions {
  /**
   * Keep a shared row even when a local copy or source exists. Set only by
   * the "Shared by me" facet; curated rows keep their local-copy rule.
   */
  readonly skipLocalDedupe?: boolean;
  readonly retainCatalogEntries?: boolean;
}

/** Entry id prefix of a team-shared automation: `automation:shared:<id>`. */
const SHARED_AUTOMATION_ENTRY_PREFIX = 'automation:shared:';

function sharedAutomationEntry(
  summary: SharedAutomationSummary,
): UnifiedPluginEntry {
  return {
    id: `${SHARED_AUTOMATION_ENTRY_PREFIX}${summary.id}`,
    kind: 'automation',
    origin: 'shared',
    name: summary.name,
    description: markdownDescriptionToPlainText(summary.description) ?? '',
    categories: [],
    authorName:
      summary.owner.type === 'system'
        ? undefined
        : (summary.owner.name ?? undefined),
    typeLabel: 'Automation',
    sourceLabel: 'Shared',
    ownershipLabel: sharedOwnershipLabel(summary.owner, summary.shareScope),
    ...sharedWithFromOwner(summary.owner),
    sharedSince: summary.createdAt,
    availabilityLabel: 'Available',
    components: emptyComponents(),
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state: 'available',
    recommended: false,
    ref: { type: 'shared-automation', automationId: summary.id },
  };
}

/**
 * A stand-in entry for a shared automation opened by id while the browse
 * inventory does not list it, such as the user's own public-link-only share
 * outside the "Shared by me" facet. The detail loads the share by id and
 * reports its real name. Returns `null` for any other entry id.
 */
export function pendingSharedAutomationEntry(
  entryId: string,
): UnifiedPluginEntry | null {
  if (!entryId.startsWith(SHARED_AUTOMATION_ENTRY_PREFIX)) return null;
  const automationId = entryId.slice(SHARED_AUTOMATION_ENTRY_PREFIX.length);
  if (automationId === '') return null;
  return {
    id: entryId,
    kind: 'automation',
    origin: 'shared',
    name: 'Shared automation',
    description: '',
    categories: [],
    typeLabel: 'Automation',
    sourceLabel: 'Shared',
    availabilityLabel: 'Available',
    components: emptyComponents(),
    providerSupport: NEUTRAL_PROVIDER_SUPPORT,
    state: 'available',
    recommended: false,
    ref: { type: 'shared-automation', automationId },
  };
}

/**
 * One row per automation, and the local copy wins. A team share the user
 * published or installed lists only as their local automation, and so does a
 * curated automation they installed; the local row says when its source has
 * changed since. On every path the user's own share stays in the projection
 * folded into its local row (`installedEntryId`), so direct links resolve it
 * and "Shared by me" lists it through ownership rather than as a separate
 * Browse row.
 */
function buildAutomationEntries(
  localAutomations: UnifiedLocalAutomationInput[],
  sharedAutomations: SharedAutomationSummary[],
  curatedAutomations: CuratedAutomationSummary[],
  {
    skipLocalDedupe = false,
    retainCatalogEntries = false,
  }: AutomationEntryOptions = {},
  viewerId?: string | null,
): UnifiedPluginEntry[] {
  const sharedHashes = new Map<string, string>();
  const sharedOwners = new Map<string, { name: string; isPerson: boolean }>();
  for (const summary of sharedAutomations) {
    sharedHashes.set(summary.id, summary.contentHash);
    const { owner } = summary;
    if (owner.type !== 'system' && owner.name) {
      sharedOwners.set(summary.id, {
        name: owner.name,
        isPerson: owner.type === 'user',
      });
    }
  }
  const curatedHashes = new Map<string, string>();
  for (const summary of curatedAutomations) {
    curatedHashes.set(summary.key, summary.contentHash);
  }

  const localSharedIds = new Map<string, string>();
  const localCuratedKeys = new Map<string, string>();
  const entries: UnifiedPluginEntry[] = [];

  for (const automation of localAutomations) {
    if (automation.sharedRemoteId !== undefined) {
      localSharedIds.set(
        automation.sharedRemoteId,
        `automation:local:${automation.id}`,
      );
    }
    const sourceKind = automationInstallSourceKind(automation);
    const installedFrom = automation.installedFrom;
    let sourceHash: string | undefined;
    if (installedFrom && sourceKind === 'shared') {
      localSharedIds.set(
        installedFrom.remoteId,
        `automation:local:${automation.id}`,
      );
      sourceHash =
        automation.sourceContentHash ??
        sharedHashes.get(installedFrom.remoteId);
    } else if (installedFrom && sourceKind === 'curated') {
      localCuratedKeys.set(
        installedFrom.remoteId,
        `automation:local:${automation.id}`,
      );
      sourceHash =
        automation.sourceContentHash ??
        curatedHashes.get(installedFrom.remoteId);
    }
    const updateAvailable =
      installedFrom !== undefined &&
      sourceHash !== undefined &&
      sourceHash !== installedFrom.contentHash;
    const sharedOwner =
      installedFrom && sourceKind === 'shared'
        ? sharedOwners.get(installedFrom.remoteId)
        : undefined;
    entries.push({
      id: `automation:local:${automation.id}`,
      kind: 'automation',
      origin: 'installed-standalone',
      name: automation.name,
      description: automation.description,
      categories: [],
      typeLabel: 'Automation',
      sourceLabel: 'Local',
      availabilityLabel: updateAvailable ? 'Update available' : 'Installed',
      components: emptyComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'installed',
      ...(updateAvailable ? { updateAvailable: true } : {}),
      recommended: false,
      ...(automation.workflow
        ? {
            workflow: {
              ...automation.workflow,
              ...(sharedOwner
                ? {
                    sourceText: `Shared by ${sharedOwner.name}`,
                    ...(sharedOwner.isPerson ? { sourceIsPerson: true } : {}),
                  }
                : {}),
            },
          }
        : {}),
      ref: { type: 'automation', activityId: automation.id },
    });
  }

  // The author fold follows the shared rule (exactly one local copy links to
  // the viewer's share); a local automation records no account on its link.
  // The viewer's own share is never dropped, so an ambiguous one stays listed.
  const authorIndexByShare = authorLinkedLocals(
    sharedAutomations,
    (summary) => summary,
    localAutomations.map((automation) => ({
      shareRemoteId: automation.sharedRemoteId,
    })),
    viewerId,
  );
  for (const summary of sharedAutomations) {
    const authorIndex = authorIndexByShare.get(summary.id);
    const authorLocal =
      authorIndex === undefined ? undefined : localAutomations[authorIndex];
    const authorLinked = authorLocal !== undefined;
    const installedEntryId = authorLocal
      ? `automation:local:${authorLocal.id}`
      : localSharedIds.get(summary.id);
    const ownShare = viewerId != null && summary.createdBy?.id === viewerId;
    if (
      !retainCatalogEntries &&
      !skipLocalDedupe &&
      installedEntryId !== undefined &&
      !ownShare
    )
      continue;
    entries.push({
      ...sharedAutomationEntry(summary),
      ...((retainCatalogEntries || authorLinked) && installedEntryId
        ? {
            state: 'installed',
            availabilityLabel: 'Installed',
            installedEntryId,
          }
        : {}),
    });
  }

  for (const summary of curatedAutomations) {
    if (!retainCatalogEntries && localCuratedKeys.has(summary.key)) continue;
    const installedEntryId = localCuratedKeys.get(summary.key);
    entries.push({
      id: `automation:curated:${summary.key}`,
      kind: 'automation',
      origin: 'curated',
      name: summary.name,
      description: summary.shortDescription,
      categories: [...summary.categories],
      authorName: summary.authorName ?? undefined,
      typeLabel: 'Automation',
      sourceLabel: 'Curated',
      ownershipLabel: summary.authorName ?? undefined,
      availabilityLabel: 'Available',
      components: emptyComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      state: 'available',
      recommended: summary.popular,
      catalogSortOrder: summary.sortOrder,
      ref: { type: 'curated-automation', key: summary.key },
      ...(retainCatalogEntries && installedEntryId
        ? {
            state: 'installed',
            availabilityLabel: 'Installed',
            installedEntryId,
          }
        : {}),
    });
  }

  return entries;
}

/**
 * Marketplaces whose catalogues overlap, so the same plugin arrives more than
 * once.
 *
 * Deliberately a fixed set rather than a global name match. Codex subscribes to
 * Anthropic's marketplace as well as OpenAI's, so the same `slack` package
 * shows up from `claude-plugins-official` through both providers — rows that
 * differ only by the catalog that relisted them. Collapsing on name across
 * *every* marketplace would silently merge two genuinely different plugins
 * that a user or org happened to name the same. Even inside this set, copies
 * collapse only when they are the same package (CAN-3653); two different
 * packages for one app both stay, each with its source label, and link to
 * each other from their plugin pages.
 */
export const OVERLAPPING_MARKETPLACE_IDS: ReadonlySet<string> = new Set([
  'openai-curated-remote',
  'openai-curated',
  'claude-plugins-official',
]);

/**
 * Whether a catalog entry advertises a connector that can actually produce a
 * row. One predicate for all three consumers — the picker's read gate, the
 * source options, and the Plugins page — because they had drifted into three.
 * An entry with `providerConnector: { providers: [] }`, a shape the catalog
 * reader tolerates for forward-compatibility, passed a `!== undefined` gate
 * and then produced no row and no source option: a Claude CLI spawn and a
 * Codex cache parse paid for nothing.
 */
export function advertisesProviderConnector(
  entry: CuratedMcpServerEntry,
): boolean {
  return (entry.providerConnector?.providers.length ?? 0) > 0;
}

/** Names and catalog keys already covered by a provider-account connector. */
export interface ConnectorOwnership {
  names: ReadonlySet<string>;
  keys: ReadonlySet<string>;
}

/**
 * Whether a connector row already covers this capability, so listing it again
 * would show the same thing twice.
 *
 * Shared by the Plugins page and the chat plugin picker. The picker grew
 * connector rows without this rule and immediately showed two Gmails — the
 * connector plus the provider's own marketplace wrapper — which is the
 * duplicate this whole change exists to remove. The wrapper is also the worse
 * of the two: its `ON_INSTALL` auth is not implemented, so it is the copy that
 * dead-ends, and it is the one the user can actually tick.
 *
 * Curated entries match on catalog key, which is what the connector actually
 * replaces; a display name is neither unique nor stable. Everything else is
 * matched case-folded, because Codex's plugin manifests carry no displayName
 * and fall back to a bare `name` — `slack`, not `Slack`.
 */
export function supersededByConnector(
  candidate: { name: string; curatedKey?: string },
  ownership: ConnectorOwnership,
): boolean {
  if (candidate.curatedKey !== undefined) {
    return ownership.keys.has(candidate.curatedKey);
  }
  return ownership.names.has(candidate.name.toLowerCase());
}

/**
 * Collapse duplicate copies of a capability, keeping every copy that reaches a
 * provider no kept copy reaches.
 *
 * Exported and generic because the chat plugin picker collapses the same
 * duplicates this page does, and sharing only the `capabilityCovers` predicate
 * was not enough: the picker had its own single-slot first-seen comparison, so
 * with three overlapping copies the two surfaces still returned different
 * counts, and a pinned subset could evict the covering superset. Sharing the
 * whole traversal is what makes them agree.
 *
 * @param groupKey Folded key for collapsible items; `null` passes an item
 *   through untouched.
 * @param pinned Items that must never be dropped — installed copies on the
 *   Plugins page, already-selected rows in the picker. A pinned item displaces
 *   another only when it actually covers it.
 */
export function collapseByCoverage<T>(
  items: readonly T[],
  options: {
    groupKey: (item: T) => string | null;
    reach: (item: T) => CapabilityReach;
    pinned?: (item: T) => boolean;
  },
): T[] {
  const { groupKey, reach, pinned } = options;
  const groups = new Map<string, T[]>();
  const order: Array<{ key: string | null; item: T }> = [];
  for (const item of items) {
    const key = groupKey(item);
    if (key === null) {
      order.push({ key: null, item });
      continue;
    }
    const group = groups.get(key);
    if (group) {
      group.push(item);
      continue;
    }
    groups.set(key, [item]);
    order.push({ key, item });
  }

  const covers = (a: T, b: T): boolean => capabilityCovers(reach(a), reach(b));

  /** Keep every copy that nothing else in the same set covers. */
  const survivorsOf = (items: readonly T[]): T[] =>
    items.filter(
      (candidate, index) =>
        !items.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            covers(other, candidate) &&
            // A strict cover, or the earlier of two equals — so mutually
            // covering copies collapse to one rather than eliminating both.
            (!covers(candidate, other) || otherIndex < index),
        ),
    );

  const chosen = new Map<string, T[]>();
  for (const [key, group] of Array.from(groups.entries())) {
    const keep = pinned ? group.filter((item) => pinned(item)) : [];
    // Pinned copies are always kept, and they hide another copy only when they
    // actually cover it — otherwise pinning a Codex-only copy would take the
    // Claude-capable one away from Claude users.
    if (keep.length > 0) {
      const uncovered = group.filter(
        (candidate) =>
          !(pinned?.(candidate) ?? false) &&
          !keep.some((survivor) => covers(survivor, candidate)),
      );
      // The survivors of what the pinned copies did not cover still have to be
      // deduped against each other. Comparing them only against `keep` left two
      // identical uninstalled copies both standing — the same "three Slacks"
      // the unpinned branch below has always collapsed, surviving whenever one
      // copy happened to be installed.
      chosen.set(key, [...keep, ...survivorsOf(uncovered)]);
      continue;
    }
    const survivors = survivorsOf(group);
    chosen.set(
      key,
      survivors.length > 0
        ? survivors
        : [group[0]].flatMap((item) => (item ? [item] : [])),
    );
  }

  return order.flatMap(({ key, item }) =>
    key === null ? [item] : (chosen.get(key) ?? [item]),
  );
}

/**
 * Collapse the same package published by overlapping marketplaces.
 *
 * Copies group by name AND package (`pluginPackageKey`): two copies with the
 * same external source collapse, as do two copies that publish none (the name
 * is all there is to go on). A copy with a source never collapses with one
 * without, nor with a different source: those are different packages for one
 * app, which `linkSameAppPlugins` links instead (CAN-3653).
 *
 * Never collapses two copies the user has installed: those are two things they
 * can uninstall, and hiding one leaves no way to reach it from this list —
 * which is the invariant `notOwned` above spends fifteen lines defending.
 *
 * Among uninstalled copies, one is dropped only when another genuinely covers
 * it — its provider support is a superset. A count-based comparison looked
 * equivalent and was not: a Claude-only copy and a Codex-only copy both
 * "reach one provider", so marketplace order decided which survived, and
 * whichever lost took that capability away entirely from users of its
 * provider. Copies that cover each other collapse; copies that merely tie do
 * not.
 *
 * The copies not shown remain listed in the per-marketplace plugins modal,
 * which reads `marketplace.plugins` directly rather than this projection.
 */
function collapseDuplicateCapabilities(
  entries: UnifiedPluginEntry[],
  packageKeys: ReadonlyMap<string, string | undefined>,
): UnifiedPluginEntry[] {
  return collapseByCoverage(entries, {
    groupKey: (entry) =>
      entry.ref.type === 'marketplace-plugin' &&
      OVERLAPPING_MARKETPLACE_IDS.has(entry.ref.marketplaceId)
        ? `${entry.name.toLowerCase()}|${packageKeys.get(entry.id) ?? ''}`
        : null,
    reach: (entry) => entry.providerSupport,
    // Two installs are two things the user can uninstall; hiding either leaves
    // no way to reach it from this list.
    pinned: (entry) => entry.state !== 'available',
  });
}

/** Entry id → bundled MCP servers for every marketplace plugin. */
function marketplaceBundledServers(
  marketplaces: readonly UnifiedMarketplaceInput[],
): Map<string, readonly UnifiedBundledMcpServerInput[]> {
  const servers = new Map<string, readonly UnifiedBundledMcpServerInput[]>();
  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      servers.set(
        `mkt:${marketplace.id}/${plugin.name}`,
        bundledMcpServersOf(plugin),
      );
    }
  }
  return servers;
}

/** Entry id → package key for every marketplace plugin. */
function marketplacePackageKeys(
  marketplaces: readonly UnifiedMarketplaceInput[],
): Map<string, string | undefined> {
  const keys = new Map<string, string | undefined>();
  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      keys.set(
        `mkt:${marketplace.id}/${plugin.name}`,
        pluginPackageKey(plugin),
      );
    }
  }
  return keys;
}

/**
 * How a linked plugin's source reads after "Also available from". The
 * curated catalog's rows carry the bare label `Curated`, which does not.
 */
function alternativeLabel(entry: UnifiedPluginEntry): string {
  if (entry.origin === 'curated') return 'the curated catalog';
  return entry.sourceLabel ?? entry.name;
}

/**
 * Link each catalog plugin to the same app's plugins from other catalogs, so
 * a plugin page can say where else the app is published. Runs after the
 * collapse, so a copy collapsed away is never offered.
 */
function linkSameAppPlugins(
  entries: readonly UnifiedPluginEntry[],
): UnifiedPluginEntry[] {
  const linkable = (entry: UnifiedPluginEntry): boolean =>
    entry.kind === 'plugin' &&
    (entry.origin === 'marketplace' || entry.origin === 'curated');
  const byName = new Map<string, UnifiedPluginEntry[]>();
  for (const entry of entries) {
    if (!linkable(entry)) continue;
    const key = marketplaceBrowseNameKey(entry.name);
    const group = byName.get(key);
    if (group) group.push(entry);
    else byName.set(key, [entry]);
  }
  return entries.map((entry) => {
    if (!linkable(entry)) return entry;
    const others = (byName.get(marketplaceBrowseNameKey(entry.name)) ?? [])
      .filter((other) => other.id !== entry.id)
      .map(
        (other): UnifiedEntryAlternative => ({
          entryId: other.id,
          label: alternativeLabel(other),
          ref: other.ref,
        }),
      );
    return others.length > 0 ? { ...entry, alsoAvailableFrom: others } : entry;
  });
}

/** What the provenance pass needs that the entries themselves do not carry. */
interface ProvenanceFacts {
  /** Marketplace plugin entry id → the MCP servers it bundles. */
  bundledServers: ReadonlyMap<string, readonly UnifiedBundledMcpServerInput[]>;
  curatedPlugins: ReadonlyMap<string, CuratedPluginEntry>;
  curatedMcp: ReadonlyMap<string, CuratedMcpServerEntry>;
  mcpServers: ReadonlyMap<string, McpServerIndexEntry>;
}

function endpointClaimKey(endpoint: string, name: string): string {
  return `${endpoint}|${marketplaceBrowseNameKey(name)}`;
}

/**
 * Whether a server a plugin bundled is listed as that plugin rather than on
 * its own row: not when it needs attention, since hiding it would also hide
 * the only place to connect it or see its failure (CAN-3653).
 */
export function bundledServerStandsBehindPlugin(
  entry: UnifiedPluginEntry,
): boolean {
  return (
    entry.state !== 'needs-auth' && entry.connection?.status !== 'unreachable'
  );
}

/**
 * Records on every plugin, installed or not, the MCP servers it bundles and
 * the row or card already representing each one, so search can reach a server
 * through its plugin. A command server is never matched to a row: the index
 * carries no executable, so a shared name does not show it is the same server.
 */
function withBundledServers(
  entries: readonly UnifiedPluginEntry[],
  facts: ProvenanceFacts,
): UnifiedPluginEntry[] {
  const representing = new Map<string, string>();
  const represent = (
    endpoint: string | null,
    name: string,
    id: string,
  ): void => {
    if (endpoint === null) return;
    const key = endpointClaimKey(endpoint, name);
    if (!representing.has(key)) representing.set(key, id);
  };
  const cards = new Set<string>();
  for (const entry of entries) {
    if (entry.ref.type === 'curated-mcp') {
      cards.add(entry.id);
      const catalog = facts.curatedMcp.get(entry.ref.key);
      if (catalog)
        represent(
          mcpEndpointKey({ type: 'http', url: catalog.url }),
          catalog.name,
          entry.id,
        );
    } else if (entry.ref.type === 'local-mcp') {
      const server = facts.mcpServers.get(entry.ref.serverId);
      if (server && server.type !== 'command')
        represent(mcpEndpointKey(server), server.name, entry.id);
    }
  }
  const bundledServersOf = (
    entry: UnifiedPluginEntry,
  ): UnifiedEntryBundledServer[] => {
    if (entry.ref.type === 'marketplace-plugin') {
      return (facts.bundledServers.get(entry.id) ?? []).map((server) => {
        const endpoint = mcpEndpointKey(server);
        const entryId =
          endpoint === null || server.type === 'command'
            ? undefined
            : representing.get(endpointClaimKey(endpoint, server.name));
        return {
          key: server.name,
          name: server.name,
          ...(endpoint !== null ? { endpoint } : {}),
          ...(entryId !== undefined ? { entryId } : {}),
        };
      });
    }
    if (entry.ref.type !== 'curated-plugin') return [];
    return (facts.curatedPlugins.get(entry.ref.key)?.mcpServers ?? []).map(
      (key) => {
        const catalog = facts.curatedMcp.get(key);
        const endpoint = catalog
          ? mcpEndpointKey({ type: 'http', url: catalog.url })
          : null;
        const entryId = `mcp-catalog:${key}`;
        return {
          key,
          name: catalog?.name ?? key,
          ...(endpoint !== null ? { endpoint } : {}),
          ...(cards.has(entryId) ? { entryId } : {}),
        };
      },
    );
  };
  return entries.map((entry) => {
    if (entry.kind !== 'plugin') return entry;
    const bundledServers = bundledServersOf(entry);
    return bundledServers.length > 0 ? { ...entry, bundledServers } : entry;
  });
}

/**
 * Attribute MCP rows and catalog cards to the installed plugin that bundles
 * their endpoint (CAN-3653). An installed server row the plugin brought gets
 * `bundledBy`, so sections hide it behind its plugin; an uninstalled catalog
 * card for that endpoint gets `installedVia` instead of offering Add again.
 *
 * Installed plugins claim endpoints in list order and the first claim wins, so
 * two installed plugins bundling one endpoint attribute deterministically.
 * An endpoint is its `mcpEndpointKey` plus the server's name: index rows know
 * only their host, so the name keeps two servers on one host apart.
 *
 * Never tagged: account connections, rows installed from the catalog
 * (`curatedKey`), cards already holding a connection, a folded plugin, or a
 * provider connector — those are the user's own connections or connect
 * flows, not something a plugin brought along. Command server rows are never
 * tagged either: the index carries no executable, so a name match cannot show
 * the plugin installed the row, and hiding a user's own server would drop its
 * only management entry. For the same reason, when several installed rows
 * match one bundled server, none of them is tagged.
 */
function attachPluginProvenance(
  entries: readonly UnifiedPluginEntry[],
  facts: ProvenanceFacts,
): UnifiedPluginEntry[] {
  const claims = new Map<string, UnifiedEntryPluginLink>();
  // Claim key → the bundled server's manifest name and endpoint, for the
  // plugin page.
  const claimedServers = new Map<string, { name: string; endpoint: string }>();
  const claim = (
    key: string,
    link: UnifiedEntryPluginLink,
    server?: { name: string; endpoint: string },
  ): void => {
    if (claims.has(key)) return;
    claims.set(key, link);
    if (server !== undefined) claimedServers.set(key, server);
  };
  for (const entry of entries) {
    if (entry.kind !== 'plugin' || entry.state === 'available') continue;
    const link: UnifiedEntryPluginLink = {
      entryId: entry.id,
      name: entry.name,
    };
    if (entry.ref.type === 'marketplace-plugin') {
      for (const server of facts.bundledServers.get(entry.id) ?? []) {
        const endpoint = mcpEndpointKey(server);
        if (endpoint !== null) {
          claim(endpointClaimKey(endpoint, server.name), link, {
            name: server.name,
            endpoint,
          });
        }
      }
    } else if (entry.ref.type === 'curated-plugin') {
      for (const key of facts.curatedPlugins.get(entry.ref.key)?.mcpServers ??
        []) {
        claim(`curated:${key}`, link);
      }
    }
  }
  if (claims.size === 0) return withBundledServers(entries, facts);

  const claimOf = (
    key: string,
  ): { key: string; owner: UnifiedEntryPluginLink } | null => {
    const owner = claims.get(key);
    return owner === undefined ? null : { key, owner };
  };
  const ownerOf = (
    entry: UnifiedPluginEntry,
  ): { key: string; owner: UnifiedEntryPluginLink } | null => {
    if (entry.kind !== 'app') return null;
    if (entry.ref.type === 'local-mcp') {
      if (entry.ref.curatedKey !== undefined) return null;
      const server = facts.mcpServers.get(entry.ref.serverId);
      if (
        !server ||
        server.type === 'command' ||
        server.scope === 'account' ||
        server.accountConnection !== undefined
      ) {
        return null;
      }
      const endpoint = mcpEndpointKey(server);
      return endpoint === null
        ? null
        : claimOf(endpointClaimKey(endpoint, server.name));
    }
    if (entry.ref.type === 'curated-mcp') {
      const catalog = facts.curatedMcp.get(entry.ref.key);
      if (
        !catalog ||
        entry.state !== 'available' ||
        entry.integration?.plugin !== undefined ||
        entry.integration?.connector !== undefined ||
        catalog.providerConnector !== undefined
      ) {
        return null;
      }
      const viaKey = claimOf(`curated:${catalog.key}`);
      if (viaKey) return viaKey;
      const endpoint = mcpEndpointKey({ type: 'http', url: catalog.url });
      return endpoint === null
        ? null
        : claimOf(endpointClaimKey(endpoint, catalog.name));
    }
    return null;
  };

  const claimedEntries = entries.map((entry) => ({
    entry,
    claimed: ownerOf(entry),
  }));
  // Several installed rows matching one bundled server leave which one the
  // plugin brought unknown, so none of them is hidden behind it.
  const localRowsPerClaim = new Map<string, number>();
  for (const { entry, claimed } of claimedEntries) {
    if (claimed === null || entry.ref.type !== 'local-mcp') continue;
    localRowsPerClaim.set(
      claimed.key,
      (localRowsPerClaim.get(claimed.key) ?? 0) + 1,
    );
  }
  // Plugin entry id → the installed rows hidden behind it, so its page can
  // still open each row's own settings.
  const hiddenRows = new Map<string, UnifiedEntryBundledServerRow[]>();
  // Plugin entry id → sign-ins its hidden rows are waiting on.
  const pendingSignIns = new Map<string, number>();
  const tagged = claimedEntries.map(({ entry, claimed }) => {
    if (claimed === null) return entry;
    if (entry.ref.type !== 'local-mcp') {
      return { ...entry, installedVia: claimed.owner };
    }
    if ((localRowsPerClaim.get(claimed.key) ?? 0) > 1) return entry;
    const server = claimedServers.get(claimed.key);
    if (server === undefined) return entry;
    const rows = hiddenRows.get(claimed.owner.entryId) ?? [];
    rows.push({
      serverName: server.name,
      endpoint: server.endpoint,
      entryId: entry.id,
      serverId: entry.ref.serverId,
    });
    hiddenRows.set(claimed.owner.entryId, rows);
    // The plugin row shows the sign-ins of the servers it stands in for
    // (CAN-4840); a server that stays listed shows its own.
    const waiting = bundledServerStandsBehindPlugin(entry)
      ? (entry.pendingSignIns ?? 0)
      : 0;
    if (waiting > 0) {
      pendingSignIns.set(
        claimed.owner.entryId,
        (pendingSignIns.get(claimed.owner.entryId) ?? 0) + waiting,
      );
    }
    return { ...entry, bundledBy: claimed.owner };
  });
  return withBundledServers(
    tagged.map((entry) => {
      const rows = hiddenRows.get(entry.id);
      if (!rows) return entry;
      const pending = pendingSignIns.get(entry.id) ?? 0;
      return {
        ...entry,
        bundledServerRows: rows,
        ...(pending > 0 ? { pendingSignIns: pending } : {}),
      };
    }),
    facts,
  );
}

/**
 * The installed MCP rows hidden behind one marketplace plugin, for a plugin
 * page that loaded that plugin on its own (the web Portal's detail route).
 * Runs the projection's provenance pass over marketplace plugins and the
 * installed MCP index only.
 */
export function marketplacePluginBundledServerRows(
  marketplaces: readonly UnifiedMarketplaceInput[],
  mcpServers: McpServerIndexEntry[],
  ref: { marketplaceId: string; pluginName: string },
): UnifiedEntryBundledServerRow[] {
  const entries = attachPluginProvenance(
    [
      ...collapseDuplicateCapabilities(
        buildMarketplacePluginEntries(marketplaces),
        marketplacePackageKeys(marketplaces),
      ),
      ...buildMcpAppEntries(
        mcpServers,
        [],
        [],
        new Map(),
        new Map(),
        new Map(),
      ),
    ],
    {
      bundledServers: marketplaceBundledServers(marketplaces),
      curatedPlugins: new Map(),
      curatedMcp: new Map(),
      mcpServers: new Map(mcpServers.map((server) => [server.id, server])),
    },
  );
  const id = `mkt:${ref.marketplaceId}/${ref.pluginName}`;
  return [
    ...(entries.find((entry) => entry.id === id)?.bundledServerRows ?? []),
  ];
}

/**
 * The same app's plugins from other catalogs, for a plugin page that loaded
 * one marketplace plugin on its own (the web Portal's detail route). Runs the
 * projection's collapse and linking over marketplace plugins only.
 */
export function marketplacePluginAlternatives(
  marketplaces: readonly UnifiedMarketplaceInput[],
  ref: { marketplaceId: string; pluginName: string },
): UnifiedEntryAlternative[] {
  const linked = linkSameAppPlugins(
    collapseDuplicateCapabilities(
      buildMarketplacePluginEntries(marketplaces),
      marketplacePackageKeys(marketplaces),
    ),
  );
  const id = `mkt:${ref.marketplaceId}/${ref.pluginName}`;
  return [
    ...(linked.find((entry) => entry.id === id)?.alsoAvailableFrom ?? []),
  ];
}

// ---------------------------------------------------------------------------
// Projection entry point
// ---------------------------------------------------------------------------

export function buildUnifiedPluginEntries(
  inputs: UnifiedEntryInputs,
): UnifiedPluginEntry[] {
  const curatedMcpByKey = new Map<string, CuratedMcpServerEntry>();
  for (const entry of inputs.curatedMcpServers) {
    curatedMcpByKey.set(entry.key, entry);
  }
  const connectors = buildProviderConnectorEntries(
    inputs.providerConnectors,
    inputs.curatedMcpServers,
    curatedMcpByKey,
    inputs.appName,
  );
  const providerEntries = connectors.entries;
  // One card per curated key (REG-3033). A connector the catalog advertises
  // for a key folds into that key's card as an alternative binding; it no
  // longer stands in for the entry. Gmail and Drive once needed the stand-in
  // because their curated endpoints could not authenticate; the card now
  // carries the connector route alongside, so the working path stays visible
  // and the user sees one Gmail rather than three.
  //
  // Connectors the catalog does not describe keep their own row, and their
  // names still suppress the provider marketplace's connector wrappers (whose
  // ON_INSTALL auth is not implemented), as the folded connectors' names do.
  //
  // A server the user installed is never suppressed. The advertised set is
  // served, so suppressing on it alone would let a catalog change hide a
  // server the user configured and authenticated — their configuration, hidden
  // by remote data they cannot see.
  //
  // Case-folded for the rest: Codex's plugin manifests carry no displayName, so
  // their entries fall back to a bare `name` — `slack`, not `Slack` — and an
  // exact comparison let every one of them through as a duplicate.
  const ownedNames = new Set(
    [
      ...providerEntries.map((entry) => entry.name),
      ...Array.from(connectors.folded.values()).map(
        (connector) => connector.displayName,
      ),
    ].map((name) => name.toLowerCase()),
  );
  // Nothing the user already has is ever suppressed, whatever kind it is.
  //
  // Keyed on state rather than ref type, because `notOwned` guards three lists
  // and narrower exemptions kept missing one. A `local-mcp`-only exemption
  // missed installed curated servers; adding those missed installed curated
  // and marketplace plugins — and Codex's marketplace publishes connector
  // wrappers for these very capabilities, so that collision is the expected
  // shape. Each miss was the same failure: a working, authenticated capability
  // vanishing from the grid and the Installed list, replaced by a row reading
  // "not set up", triggerable remotely by a hub checkbox.
  //
  // An MCP row is `available` only for a disconnected or pending account
  // connection (`accountLifecycleState`), so "not available" is exactly "the
  // user has this already".
  const ownership: ConnectorOwnership = {
    names: ownedNames,
    // Every keyed connector folds into its card, so no key is owned by a
    // stand-in any more.
    keys: new Set<string>(),
  };
  const notOwned = (entry: UnifiedPluginEntry): boolean => {
    if (entry.state !== 'available') return true;
    // Name suppression is for a provider marketplace's wrapper of the
    // connector. A curated plugin is not one: a multi-key plugin named like a
    // folded connector keeps its card and its requirement chips.
    if (entry.ref.type === 'curated-plugin') return true;
    // Curated entries match on catalog key, which is what the connector
    // actually replaces; a display name is neither unique nor stable.
    return !supersededByConnector(
      {
        name: entry.name,
        curatedKey:
          entry.ref.type === 'curated-mcp' ? entry.ref.key : undefined,
      },
      ownership,
    );
  };

  const curatedPlugins = buildCuratedPluginEntries(
    inputs.curatedPlugins,
    inputs.marketplaces,
    curatedMcpByKey,
    inputs.foldSingleKeyPlugins === true,
  );
  // Installed listings are pinned through the collapse, so a shared plugin
  // folds into a listing id that survives it.
  const marketplacePlugins = collapseDuplicateCapabilities(
    buildMarketplacePluginEntries(inputs.marketplaces).filter(notOwned),
    marketplacePackageKeys(inputs.marketplaces),
  );
  const assembled = [
    ...providerEntries,
    ...curatedPlugins.entries.filter(notOwned),
    ...buildMcpAppEntries(
      inputs.mcpServers,
      inputs.mcpStatuses,
      inputs.curatedMcpServers,
      curatedMcpByKey,
      curatedPlugins.folded,
      connectors.folded,
    ).filter(notOwned),
    ...buildSkillEntries(inputs.installedSkills),
    ...buildSharedSkillEntries(
      inputs.sharedSkills ?? [],
      inputs.installedSkills,
      inputs.viewerId,
    ),
    ...buildPipelineEntries(
      withoutAutomationOwnedPipelines(
        inputs.pipelines ?? [],
        inputs.ownedPipelineIds ?? new Set(),
      ),
      inputs.viewerId,
      inputs.pipelineLastRuns,
      inputs.pipelineRunUnavailable,
    ),
    ...buildAutomationEntries(
      inputs.localAutomations ?? [],
      [
        ...new Map(
          (inputs.sharedAutomations ?? []).map((share) => [share.id, share]),
        ).values(),
      ],
      inputs.curatedAutomations ?? [],
      {
        skipLocalDedupe: inputs.skipLocalAutomationDedupe === true,
        retainCatalogEntries: inputs.retainAutomationCatalogEntries === true,
      },
      inputs.viewerId,
    ),
    ...buildCollectionEntries(
      inputs.localCollections ?? [],
      inputs.sharedCollections ?? [],
      inputs.viewerId,
    ),
    ...buildLocalAgentEntries(inputs.localAgents ?? []),
    ...buildSharedAgentEntries(
      sharedAgentsWithoutLocalCopies(
        inputs.sharedAgents ?? [],
        inputs.localAgents ?? [],
        inputs.viewerId,
      ),
      inputs.localAgents ?? [],
      inputs.viewerId,
    ),
    ...buildSharedBlueprintEntries(inputs.sharedBlueprints ?? []),
    ...marketplacePlugins,
    ...buildPluginSkillEntries(inputs.marketplaces, curatedPlugins.entries),
    ...buildSharedPluginEntries(
      inputs.sharedPlugins ?? [],
      inputs.marketplaces,
      inputs.viewerId,
      new Set(
        marketplacePlugins
          .filter((entry) => entry.state === 'installed')
          .map((entry) => entry.id),
      ),
    ),
    ...buildCuratedPipelineEntries(inputs.curatedPipelines ?? []),
  ];
  const entries = attachPluginProvenance(linkSameAppPlugins(assembled), {
    bundledServers: marketplaceBundledServers(inputs.marketplaces),
    curatedPlugins: new Map(
      inputs.curatedPlugins.map((plugin) => [plugin.key, plugin]),
    ),
    curatedMcp: curatedMcpByKey,
    mcpServers: new Map(inputs.mcpServers.map((server) => [server.id, server])),
  });
  const creators = new Map<string, string>();
  const publications = new Map<string, boolean>();
  // Rebuilt from the current summaries on every projection, so a removed
  // link never outlives its summary. `null` and absent both mean no link.
  const publicShares = new Map<string, UnifiedEntryPublicShare>();
  const publicOnlyShares = new Set<string>();
  function recordShare(
    id: string,
    share: {
      createdBy: { id: string };
      shareScope: string;
      publicShare?: { createdAt?: string; upToDate?: boolean } | null;
    },
  ): void {
    creators.set(id, share.createdBy?.id);
    publications.set(
      id,
      share.shareScope === 'team' ||
        share.shareScope === 'organization' ||
        !!share.publicShare,
    );
    if (share.publicShare) {
      if (share.shareScope !== 'team' && share.shareScope !== 'organization')
        publicOnlyShares.add(id);
      const { createdAt, upToDate } = share.publicShare;
      publicShares.set(id, {
        ...(createdAt !== undefined ? { since: createdAt } : {}),
        ...(upToDate !== undefined ? { upToDate } : {}),
      });
    }
  }
  for (const share of inputs.sharedSkills ?? [])
    recordShare(`skill:shared:${share.id}`, share);
  for (const share of inputs.sharedAutomations ?? [])
    recordShare(`${SHARED_AUTOMATION_ENTRY_PREFIX}${share.id}`, share);
  for (const share of inputs.sharedCollections ?? [])
    recordShare(`collection:shared:${share.id}`, share);
  for (const share of inputs.sharedAgents ?? [])
    recordShare(`agent:shared:${share.id}`, share);
  for (const share of inputs.sharedPlugins ?? [])
    recordShare(`plugin:shared:${share.externalId}`, share);
  for (const share of inputs.sharedBlueprints ?? []) {
    creators.set(`blueprint:shared:${share.externalId}`, share.createdBy?.id);
    publications.set(`blueprint:shared:${share.externalId}`, true);
  }
  // A shared pipeline names its creator on the row itself, so the viewer's
  // own share (folded into its local copy or not) lists in "Shared by me".
  for (const pipeline of inputs.pipelines ?? []) {
    if (pipeline.source === 'shared' && pipeline.createdBy) {
      creators.set(`pipeline:shared:${pipeline.id}`, pipeline.createdBy.id);
    }
  }
  return entries.map((entry) => ({
    ...entry,
    ...(publications.has(entry.id)
      ? { isShared: publications.get(entry.id) }
      : {}),
    ...(entry.origin === 'shared' && publicShares.has(entry.id)
      ? { publicShare: publicShares.get(entry.id) }
      : {}),
    ...(inputs.viewerId && entry.origin === 'shared'
      ? {
          ownedByViewer: creators.get(entry.id) === inputs.viewerId,
        }
      : {}),
    ...(entry.sharedWith?.audience === 'organization' &&
    inputs.personalOrganizationId &&
    entry.sharedWith.organizationId === inputs.personalOrganizationId
      ? {
          sharedWith: { ...entry.sharedWith, personal: true, name: 'Personal' },
        }
      : {}),
    // An owner is not necessarily an audience: private shares can have just
    // a public link. Match the detail card instead of naming their owner or
    // treating the record's creation date as an account-share date.
    ...(entry.origin === 'shared' && publicOnlyShares.has(entry.id)
      ? { sharedWith: undefined, sharedSince: undefined }
      : {}),
    // Plugins, agents, project templates and curated pipeline templates carry
    // an authored display name; every other kind is named by a slug that
    // reads better title-cased.
    name:
      entry.kind === 'plugin' ||
      entry.kind === 'agent' ||
      entry.kind === 'blueprint' ||
      entry.ref.type === 'curated-pipeline'
        ? entry.name
        : marketplaceTitleCase(entry.name),
  }));
}

interface ProviderConnectorProjection {
  /** Connectors the catalog does not describe, as rows of their own. */
  entries: UnifiedPluginEntry[];
  /** Connectors folded into the integration card for their catalog key. */
  folded: Map<string, FoldedConnector>;
}

/**
 * Connectors reachable through a provider's own account.
 *
 * These are advertised whether or not anything is linked — a user with nothing
 * set up still has to be able to discover that Gmail is connectable, and the
 * providers publish no way to ask "could I connect this?" without asking the
 * account. The served catalog is the only source of what to advertise; there
 * is no bundled fallback, so a cold or unreachable catalog hides connectors
 * exactly as it already hides every other curated entry.
 */
function buildProviderConnectorEntries(
  results: ProviderConnectorInput[],
  curated: CuratedMcpServerEntry[],
  curatedByKey: ReadonlyMap<string, CuratedMcpServerEntry>,
  appName: string | undefined,
): ProviderConnectorProjection {
  // Deliberately not gated on `results`. The catalog decides which connectors
  // exist and is available on first paint; the reads only decide whether each
  // is linked and take seconds. Returning [] here meant the first paint had no
  // connector rows, so nothing was suppressed and the provider's own
  // marketplace plugins rendered — then swapped once the reads landed. It also
  // conflated "the catalog advertises nothing" with "the read failed".
  // Linked state comes from the same builder the detail panel uses. Computing
  // it here independently meant the two joins could disagree: this one matched
  // on the catalog display name alone, so a connector linked under a different
  // account-side name (`claudeConnectorName`, or a Codex entry pinned by id)
  // read "Connected" in the detail panel and `available` in this list.
  const rows = buildProviderConnectorRows(results, curated);
  const folded = new Map<string, FoldedConnector>();
  const entries: UnifiedPluginEntry[] = [];
  for (const row of rows) {
    const connected = row.providers.some((provider) => provider.connected);
    const catalogEntry = row.curatedKey
      ? curatedByKey.get(row.curatedKey)
      : undefined;
    if (catalogEntry) {
      folded.set(catalogEntry.key, {
        displayName: row.displayName,
        connected,
        connectedProviders: row.providers
          .filter((provider) => provider.connected)
          .map((provider) => provider.provider),
      });
      continue;
    }
    entries.push({
      id: `provider-connector:${row.displayName}`,
      kind: 'app',
      origin: 'curated',
      name: row.displayName,
      description: `Connect with your Claude or Codex account. ${appName ?? 'The app'} never sees these credentials.`,
      categories: [],
      authorName: undefined,
      components: mcpAppComponents(),
      providerSupport: NEUTRAL_PROVIDER_SUPPORT,
      // `needs-auth` buckets into Installed, which is right for a curated
      // server the user added and wrong here: an unlinked connector was never
      // installed, so listing it as such — with a "Needs attention" badge —
      // reports work the user never started.
      state: connected ? 'installed' : 'available',
      recommended: false,
      ref: {
        type: 'provider-connector',
        displayName: row.displayName,
        ...(row.curatedKey ? { curatedKey: row.curatedKey } : {}),
      },
    });
  }
  return { entries, folded };
}

// ---------------------------------------------------------------------------
// Search / ranking
// ---------------------------------------------------------------------------

interface ScoredEntry {
  entry: UnifiedPluginEntry;
  score: number;
}

function matchScore(
  entry: UnifiedPluginEntry,
  normalizedQuery: string,
): number {
  let score = 0;
  const readableQuery = normalizedQuery.replace(/[-_]+/g, ' ');
  if (entry.name.toLowerCase().includes(readableQuery)) score += 3;
  if (entry.description.toLowerCase().includes(normalizedQuery)) score += 2;
  if (
    entry.categories.some((category) =>
      category.toLowerCase().includes(normalizedQuery),
    )
  ) {
    score += 1;
  }
  if (
    [
      entry.typeLabel,
      workflowSearchAlias(entry.kind),
      entry.sourceLabel,
      entry.ownershipLabel,
      entry.sharedWith?.name,
      entry.availabilityLabel,
      entry.authorName,
      // A bundled skill or server is found by its plugin's name (CAN-4844).
      entry.bundledBy?.name,
      entry.installedVia?.name,
      entry.integration?.plugin?.name,
      // A plugin is found by the servers it bundles.
      ...(entry.bundledServers?.map((server) => server.name) ?? []),
      // The source label names provider and owner, not the catalog (CAN-3653).
      entry.ref.type === 'marketplace-plugin'
        ? entry.ref.marketplaceId
        : undefined,
    ].some((value) => value?.toLowerCase().includes(normalizedQuery))
  ) {
    score += 1;
  }
  return score;
}

type RankedResultsKey = keyof RankedResults;

const BAND_ORDER: RankedResultsKey[] = [
  'installed',
  'curatedPlugins',
  'curatedApps',
  'marketplace',
  'sharedPlugins',
  'skills',
  'pipelines',
  'automations',
  'collections',
  'agents',
  'projectTemplates',
];

function bandFor(entry: UnifiedPluginEntry): RankedResultsKey {
  if (entry.kind === 'pipeline') return 'pipelines';
  if (entry.kind === 'automation') return 'automations';
  if (entry.kind === 'collection') return 'collections';
  if (entry.kind === 'agent') return 'agents';
  if (entry.kind === 'blueprint') return 'projectTemplates';
  if (entry.kind === 'skill' && entry.origin === 'shared') return 'skills';
  // A shared plugin reference is not a catalog listing: it has no category
  // and is listed under its own heading, like shared skills.
  if (entry.kind === 'plugin' && entry.origin === 'shared') {
    return 'sharedPlugins';
  }
  if (entry.state !== 'available') return 'installed';
  if (entry.origin === 'curated' && entry.kind === 'plugin') {
    return 'curatedPlugins';
  }
  if (entry.origin === 'curated' && entry.kind === 'app') {
    return 'curatedApps';
  }
  return 'marketplace';
}

function isCuratedBand(band: RankedResultsKey): boolean {
  return band === 'curatedPlugins' || band === 'curatedApps';
}

function compareByScoreThenName(a: ScoredEntry, b: ScoredEntry): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.entry.name.localeCompare(b.entry.name);
}

function compareCuratedBand(a: ScoredEntry, b: ScoredEntry): number {
  if (a.entry.recommended !== b.entry.recommended) {
    return a.entry.recommended ? -1 : 1;
  }
  return compareByScoreThenName(a, b);
}

/** Local agents lead their section; each group keeps a stable order. */
function compareAgentBand(a: ScoredEntry, b: ScoredEntry): number {
  const aLocal = a.entry.ref.type === 'local-agent';
  const bLocal = b.entry.ref.type === 'local-agent';
  if (aLocal !== bLocal) return aLocal ? -1 : 1;
  return compareByScoreThenName(a, b) || a.entry.id.localeCompare(b.entry.id);
}

function bandComparator(
  band: RankedResultsKey,
): (a: ScoredEntry, b: ScoredEntry) => number {
  if (isCuratedBand(band)) return compareCuratedBand;
  if (band === 'agents') return compareAgentBand;
  return compareByScoreThenName;
}

function emptyRankedResults(): RankedResults {
  return {
    installed: [],
    curatedPlugins: [],
    curatedApps: [],
    marketplace: [],
    sharedPlugins: [],
    skills: [],
    pipelines: [],
    automations: [],
    collections: [],
    agents: [],
    projectTemplates: [],
  };
}

export function searchUnifiedEntries(
  entries: UnifiedPluginEntry[],
  query: string,
  category: string | null,
): RankedResults {
  const normalizedCategory = category === null ? null : category.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  const banded: Record<RankedResultsKey, ScoredEntry[]> = {
    installed: [],
    curatedPlugins: [],
    curatedApps: [],
    marketplace: [],
    sharedPlugins: [],
    skills: [],
    pipelines: [],
    automations: [],
    collections: [],
    agents: [],
    projectTemplates: [],
  };

  for (const entry of entries) {
    if (
      normalizedCategory !== null &&
      !entry.categories.some(
        (category_) => category_.toLowerCase() === normalizedCategory,
      )
    ) {
      continue;
    }
    const score =
      normalizedQuery === '' ? 0 : matchScore(entry, normalizedQuery);
    if (normalizedQuery !== '' && score === 0) continue;
    banded[bandFor(entry)].push({ entry, score });
  }

  const results = emptyRankedResults();
  for (const band of BAND_ORDER) {
    results[band] = [...banded[band]]
      .sort(bandComparator(band))
      .map((scored) => scored.entry);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Category union
// ---------------------------------------------------------------------------

export function collectEntryCategories(
  entries: UnifiedPluginEntry[],
): string[] {
  // Catalog and marketplace data mix casings ("productivity" vs
  // "Productivity"); merge case-insensitively, keeping the first-seen
  // display casing. Filtering already lowercases, so any variant matches.
  const categories = new Map<string, string>();
  for (const entry of entries) {
    for (const category of entry.categories) {
      const key = category.toLowerCase();
      if (!categories.has(key)) {
        categories.set(key, category);
      }
    }
  }
  return Array.from(categories.values()).sort((a, b) => a.localeCompare(b));
}
