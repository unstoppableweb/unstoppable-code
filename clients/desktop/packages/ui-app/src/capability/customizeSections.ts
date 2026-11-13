import {
  alwaysAvailableReason,
  BUNDLED_SKILL_FOOTNOTE,
  DEFAULT_PIPELINE_FILTERS,
  entryHasInstalledStatus,
  isBundledSkill,
  isPluginServerResult,
  marketplaceEntryInTab,
  pipelineFiltersActive,
  type MarketplaceCatalogTabId,
  type MarketplaceTypeTabId,
  type PipelineFilterValues,
  type UnifiedPluginEntry,
  type InstalledEntryStatusState,
  type InstalledEntryStatusStates,
  type InstalledStatusFilterValue,
} from '@canopy/ui-shared/lib';
import {
  buildMarketplaceBrowseGroups,
  listedAsItsPlugin,
  MARKETPLACE_BROWSE_SECTION_LIMIT,
  marketplaceResultEntries,
  marketplaceBrowseEntries,
  marketplaceEntryIsInstalled,
  pipelineMatchesFilters,
} from './marketplaceBrowse';
import { searchUnifiedEntries } from './unifiedPluginEntries';

export const CUSTOMIZE_INSTALLED_PREVIEW_LIMIT = 8;

/** A failed read remains retryable; it must never look like ready/empty. */
export type CustomizeInventoryState =
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'error';
export type CustomizeSectionId =
  | 'updates'
  | 'installed'
  | 'shared-by-me'
  | 'browse';

export interface CustomizeBrowseGroup {
  readonly id: string;
  readonly title: string;
  readonly entries: readonly UnifiedPluginEntry[];
  readonly previewLimit?: number;
}

export interface CustomizeSectionModel {
  readonly id: CustomizeSectionId;
  readonly domId: `customize-section-${CustomizeSectionId}`;
  readonly title: string;
  /** Full matching membership, before any local preview/expansion. */
  readonly entries: readonly UnifiedPluginEntry[];
  readonly count: number;
  readonly showEntryTypes: boolean;
  readonly previewLimit?: number;
  readonly groups?: readonly CustomizeBrowseGroup[];
  readonly inventoryState?: CustomizeInventoryState;
  readonly emptyReason?: 'search' | 'pipeline-filters';
  /** Installed only: set while a listed row is a plugin-bundled skill. */
  readonly installedFootnote?: string;
  /** A line under the section's list, such as when workflows run. */
  readonly footnote?: string;
}

/** Kinds whose Updates the host surfaces; applying may still be capability-gated by the host. */
export type CustomizeUpdateKind = 'skill' | 'automation' | 'collection';
/** Under the Workflows tab's Installed list (CAN-4845). */
export const WORKFLOW_INSTALLED_FOOTNOTE =
  'Pipelines run when you start them or their trigger fires. Automations run on their schedule.';

export interface CustomizeTabModelInput {
  readonly tab: MarketplaceCatalogTabId;
  readonly entries: readonly UnifiedPluginEntry[];
  readonly query?: string;
  /** Ranked matches whose searchable metadata is held by the catalog reader. */
  readonly searchMatchedEntryIds?: readonly string[];
  readonly installedInventory: CustomizeInventoryState;
  readonly ownershipAvailable?: boolean;
  /** Initial web hosts pass no supported updates. */
  readonly supportedUpdateKinds?: readonly CustomizeUpdateKind[];
  readonly pipelineFilters?: PipelineFilterValues;
  readonly pipelineCategory?: string | null;
  readonly installedExpanded?: boolean;
  readonly keepInstalledVisible?: boolean;
  /**
   * Ignored on tabs without statuses (`customizeTabHasInstalledStatuses`),
   * and `update-available` on tabs that do not offer it
   * (`customizeTabOffersUpdateFilter`).
   */
  readonly installedStatusFilter?: InstalledStatusFilterValue;
  readonly installedStatusStates?: InstalledEntryStatusStates;
  /** Pinned filter membership; entries absent from it are evaluated live. */
  readonly installedStatusSnapshot?: InstalledStatusMembership;
  readonly suggestedNames?: readonly string[];
  readonly agentsAvailable?: boolean;
  readonly projectTemplatesAvailable?: boolean;
  /** Plugin shares eligible for Shared by me on the MCP servers tab. */
  readonly mcpSharedEntryIds?: ReadonlySet<string>;
}

export interface CustomizeTabModel {
  readonly sections: readonly CustomizeSectionModel[];
  /** Distinct entries across eligible sections before previews, not row count. */
  readonly resultCount: number;
  readonly searchActive: boolean;
  readonly batchableUpdates: readonly UnifiedPluginEntry[];
  readonly showUpdateAll: boolean;
}

/**
 * Tabs whose Installed rows carry a status (CAN-4838). Workflows and agents
 * have none, Marketplaces and Project templates have no Installed section.
 */
export function customizeTabHasInstalledStatuses(
  tab: MarketplaceTypeTabId,
): boolean {
  switch (tab) {
    case 'all':
    case 'plugin':
    case 'app':
    case 'skill':
    case 'collection':
      return true;
    case 'workflow':
    case 'agent':
    case 'sources':
    case 'blueprint':
      return false;
  }
}

/** The update kinds a status tab's Installed rows can hold. */
function customizeTabUpdateKinds(
  tab: MarketplaceTypeTabId,
): readonly CustomizeUpdateKind[] {
  switch (tab) {
    case 'all':
      return ['skill', 'automation', 'collection'];
    case 'skill':
      return ['skill'];
    case 'collection':
      return ['collection'];
    case 'plugin':
    case 'app':
    case 'workflow':
    case 'agent':
    case 'sources':
    case 'blueprint':
      return [];
  }
}

/**
 * Whether a tab offers the Update available status filter (CAN-5309): it
 * carries statuses and the host surfaces updates for one of its kinds. The
 * offer depends only on the tab and the host, never on the current rows.
 */
export function customizeTabOffersUpdateFilter(
  tab: MarketplaceTypeTabId,
  supportedUpdateKinds: readonly CustomizeUpdateKind[] | undefined,
): boolean {
  return (
    customizeTabHasInstalledStatuses(tab) &&
    customizeTabUpdateKinds(tab).some((kind) =>
      supportedUpdateKinds?.includes(kind),
    )
  );
}

/**
 * The status filter a tab applies, which hosts also show in the search row.
 * A stored filter the tab cannot apply (a navigation intent or `?installed=`
 * landing on a tab without it) reads as Any; the host's stored value is left
 * alone.
 */
export function effectiveInstalledStatusFilter(
  tab: MarketplaceTypeTabId,
  filter: InstalledStatusFilterValue | undefined,
  supportedUpdateKinds: readonly CustomizeUpdateKind[] | undefined,
): InstalledStatusFilterValue | undefined {
  if (filter === undefined || !customizeTabHasInstalledStatuses(tab))
    return undefined;
  if (
    filter === 'update-available' &&
    !customizeTabOffersUpdateFilter(tab, supportedUpdateKinds)
  )
    return undefined;
  return filter;
}

/**
 * An update the Updates section lists: the host surfaces updates for the
 * entry's kind and the entry's source has one. Shared copies are separate
 * (`shareUpdateAvailable`); they update through the reviewed share flow.
 */
function surfacedUpdate(
  entry: UnifiedPluginEntry,
  supportedUpdateKinds: readonly CustomizeUpdateKind[] | undefined,
): boolean {
  return (
    entry.updateAvailable === true &&
    ((entry.kind === 'skill' &&
      entry.ref.type === 'skill' &&
      !entry.builtIn &&
      !entry.custom &&
      supportedUpdateKinds?.includes('skill') === true) ||
      (entry.kind === 'automation' &&
        entry.ref.type === 'automation' &&
        supportedUpdateKinds?.includes('automation') === true) ||
      (entry.kind === 'collection' &&
        entry.ref.type === 'local-collection' &&
        supportedUpdateKinds?.includes('collection') === true))
  );
}

/** A surfaced update or a shared copy whose source changed (CAN-5309). */
function entryHasUpdate(
  entry: UnifiedPluginEntry,
  supportedUpdateKinds: readonly CustomizeUpdateKind[] | undefined,
): boolean {
  return (
    surfacedUpdate(entry, supportedUpdateKinds) ||
    entry.shareUpdateAvailable === true
  );
}

/** Entry id to whether it matched the status filter when first read ready. */
export type InstalledStatusMembership = Readonly<Record<string, boolean>>;

/**
 * A membership snapshot and the `tab|context|filter` key it belongs to.
 * Hosts hold it above the list so it outlives an entry detail page, which
 * unmounts the list; a different key starts a fresh snapshot. `scope` is the
 * key without its context (`tab|filter`): a page that remounts before its
 * context resolves must not replace the held snapshot with an empty one.
 */
export interface InstalledStatusSnapshot {
  readonly key: string;
  readonly scope: string;
  readonly members: InstalledStatusMembership;
}

export const NO_INSTALLED_STATUS_MEMBERS: InstalledStatusMembership =
  Object.freeze({});

export const EMPTY_INSTALLED_STATUS_SNAPSHOT: InstalledStatusSnapshot = {
  key: '',
  scope: '',
  members: NO_INSTALLED_STATUS_MEMBERS,
};

/**
 * The id whose installed status a row follows: a catalog row's local
 * installation when it has one (CAN-5272), so a share and its install agree.
 */
export function installedStatusEntryId(
  entry: Pick<UnifiedPluginEntry, 'id' | 'installedEntryId'>,
): string {
  return entry.installedEntryId ?? entry.id;
}

function installedStatusState(
  entry: UnifiedPluginEntry,
  states: InstalledEntryStatusStates | undefined,
): InstalledEntryStatusState | undefined {
  return (
    states?.[statusEntryIdOf(entry)] ??
    (followsItsPlugin(entry) ? undefined : states?.[entry.id])
  );
}

function followsItsPlugin(
  entry: UnifiedPluginEntry,
): entry is UnifiedPluginEntry & { bundledBy: { entryId: string } } {
  return isBundledSkill(entry) || isPluginServerResult(entry);
}

/**
 * A bundled skill or a server's search result reads its plugin status; shares
 * read their exact install.
 */
export function statusEntryIdOf(entry: UnifiedPluginEntry): string {
  return followsItsPlugin(entry)
    ? entry.bundledBy.entryId
    : installedStatusEntryId(entry);
}

export function installedStatusMatches(
  entry: UnifiedPluginEntry,
  filter: InstalledStatusFilterValue,
  state: InstalledEntryStatusState | undefined,
  supportedUpdateKinds: readonly CustomizeUpdateKind[] | undefined,
): boolean {
  // Updates are not a status, so the status state does not decide them.
  if (filter === 'update-available')
    return entryHasUpdate(entry, supportedUpdateKinds);
  if (state?.kind === 'ready')
    return (
      state.item.status === filter ||
      (filter === 'active' && state.item.status === null)
    );
  if (state?.kind === 'fixed') return state.status === filter;
  // An unreadable status proves no match (CAN-5272).
  if (state?.kind === 'read-only') return false;
  // Built-in workflows show a fixed Available status, so they match it.
  if (state === undefined && alwaysAvailableReason(entry) !== undefined)
    return filter === 'available';
  // Unknown/error/loading states stay visible rather than implying that an
  // unread item is inactive; entries that cannot carry a status match none.
  // A bundled skill whose plugin status is unread stays listed, as an
  // installed plugin with an unread status does.
  return (
    state !== undefined ||
    followsItsPlugin(entry) ||
    entryHasInstalledStatus(entry)
  );
}

/**
 * Filter membership: a pinned ready match keeps its place, but a fixed or
 * unreadable status always decides on its own. Update membership only
 * extends: a pinned update stays, anything else is evaluated live.
 */
function installedStatusMember(
  entry: UnifiedPluginEntry,
  filter: InstalledStatusFilterValue,
  states: InstalledEntryStatusStates | undefined,
  snapshot: InstalledStatusMembership | undefined,
  supportedUpdateKinds: readonly CustomizeUpdateKind[] | undefined,
): boolean {
  const state = installedStatusState(entry, states);
  if (filter === 'update-available')
    return (
      snapshot?.[installedStatusEntryId(entry)] === true ||
      installedStatusMatches(entry, filter, state, supportedUpdateKinds)
    );
  const pinned =
    state?.kind === 'fixed' || state?.kind === 'read-only'
      ? undefined
      : snapshot?.[installedStatusEntryId(entry)];
  return (
    pinned ?? installedStatusMatches(entry, filter, state, supportedUpdateKinds)
  );
}

/**
 * Pins the filter match of every entry whose status is ready and not pinned
 * yet, so a status change while filtered keeps the row in place. Returns the
 * same reference when nothing was added; render-time callers rely on that.
 *
 * Update available pins only matches, whatever the status: a shared copy's
 * source hash resolves after the inventory, so a row may join later, and a
 * row that stops matching stays until the filter changes (CAN-5309).
 */
export function extendInstalledStatusSnapshot(
  snapshot: InstalledStatusMembership,
  filter: InstalledStatusFilterValue,
  entries: readonly UnifiedPluginEntry[],
  states: InstalledEntryStatusStates | undefined,
  supportedUpdateKinds: readonly CustomizeUpdateKind[] | undefined,
): InstalledStatusMembership {
  let next: Record<string, boolean> | undefined;
  for (const entry of entries) {
    const key = installedStatusEntryId(entry);
    const state = installedStatusState(entry, states);
    if (filter === 'update-available') {
      if (
        (next ?? snapshot)[key] === true ||
        !installedStatusMatches(entry, filter, state, supportedUpdateKinds)
      )
        continue;
      next ??= { ...snapshot };
      next[key] = true;
      continue;
    }
    if (state?.kind !== 'ready' || key in (next ?? snapshot)) continue;
    next ??= { ...snapshot };
    next[key] = installedStatusMatches(
      entry,
      filter,
      state,
      supportedUpdateKinds,
    );
  }
  return next ?? snapshot;
}

function unique(entries: readonly UnifiedPluginEntry[]): UnifiedPluginEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

/**
 * MCP search results for the servers plugins bundle that no row or card
 * represents: links to the plugin, never an independent install (CAN-5704).
 * A reference to an entry that is gone does not count as representing one.
 */
function pluginServerResults(
  entries: readonly UnifiedPluginEntry[],
): UnifiedPluginEntry[] {
  const listed = new Map(
    entries
      .filter((entry) => entry.kind === 'app')
      .map((entry) => [entry.id, entry]),
  );
  const results: UnifiedPluginEntry[] = [];
  for (const plugin of entries) {
    if (plugin.kind !== 'plugin') continue;
    const emitted = new Set<string>();
    for (const server of plugin.bundledServers ?? []) {
      if (emitted.has(server.key)) continue;
      emitted.add(server.key);
      const represented =
        server.entryId === undefined ? undefined : listed.get(server.entryId);
      const provider = represented?.bundledBy ?? represented?.installedVia;
      if (
        represented !== undefined &&
        (provider === undefined || provider.entryId === plugin.id)
      )
        continue;
      results.push({
        id: `plugin-server:${encodeURIComponent(plugin.id)}:${encodeURIComponent(server.key)}`,
        kind: 'app',
        origin: plugin.origin,
        name: server.name,
        description: '',
        logoUrl: plugin.logoUrl,
        bundledLogo: plugin.bundledLogo,
        brandMark: plugin.brandMark,
        categories: [],
        authorName: plugin.authorName,
        typeLabel: 'MCP server',
        sourceLabel: plugin.sourceLabel,
        ownershipLabel: plugin.ownershipLabel,
        availabilityLabel: plugin.availabilityLabel,
        components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
        providerSupport: plugin.providerSupport,
        state: plugin.state === 'available' ? 'available' : 'installed',
        recommended: false,
        bundledBy: { entryId: plugin.id, name: plugin.name },
        pluginServerResult: true,
        ref: plugin.ref,
      });
    }
  }
  return results;
}

const BROWSE_TITLES: Record<MarketplaceCatalogTabId, string> = {
  all: 'Browse',
  plugin: 'Browse plugins',
  app: 'Browse MCP servers',
  skill: 'Browse skills',
  workflow: 'Browse workflows',
  collection: 'Shared with you',
  agent: 'Shared with you',
  blueprint: 'Browse project templates',
};

/** Footnotes under a tab's installed section. */
export const INSTALLED_FOOTNOTES: Partial<
  Record<MarketplaceCatalogTabId, string>
> = {
  app: "Servers that come with a plugin are listed on the plugin's page.",
  workflow: WORKFLOW_INSTALLED_FOOTNOTE,
  collection:
    'Adding a collection adds everything in it. Removing it keeps what you already use.',
};

function isInstalled(entry: UnifiedPluginEntry): boolean {
  return entry.state === 'installed' || entry.state === 'needs-auth';
}

function allBrowseGroups(
  entries: UnifiedPluginEntry[],
  searchActive: boolean,
  suggestedNames?: readonly string[],
): CustomizeBrowseGroup[] {
  const plugins = entries.filter(
    (entry) => entry.kind === 'plugin' || entry.kind === 'app',
  );
  const otherGroups: CustomizeBrowseGroup[] = [
    {
      id: 'shared-plugins',
      title: 'Shared plugins',
      entries: plugins.filter((entry) => entry.origin === 'shared'),
    },
    {
      id: 'skills',
      title: 'Skills',
      entries: entries.filter((entry) => entry.kind === 'skill'),
    },
    {
      id: 'workflows',
      title: 'Workflows',
      entries: entries.filter(
        (entry) => entry.kind === 'pipeline' || entry.kind === 'automation',
      ),
    },
    {
      id: 'collections',
      title: 'Collections',
      entries: entries.filter((entry) => entry.kind === 'collection'),
    },
    {
      id: 'agents',
      title: 'Agents',
      entries: entries.filter((entry) => entry.kind === 'agent'),
    },
    {
      id: 'project-templates',
      title: 'Project templates',
      entries: entries.filter((entry) => entry.kind === 'blueprint'),
    },
  ];
  if (searchActive) {
    return [
      {
        id: 'plugins-and-mcp',
        title: 'Plugins and MCP servers',
        entries: plugins,
      },
      ...otherGroups.slice(1),
    ].filter((group) => group.entries.length > 0);
  }
  const curated = buildMarketplaceBrowseGroups(
    searchUnifiedEntries(
      plugins.filter((entry) => entry.origin !== 'shared'),
      '',
      null,
    ),
    { suggestedNames },
  ).map((group) => ({
    ...group,
    previewLimit: MARKETPLACE_BROWSE_SECTION_LIMIT,
  }));
  return [...curated, ...otherGroups].filter(
    (group) => group.entries.length > 0,
  );
}

/** Pure section policy. Hosts own reads, expansion resets, mutations and retries. */
export function buildCustomizeTabModel(
  input: CustomizeTabModelInput,
): CustomizeTabModel {
  const query = input.query?.trim() ?? '';
  const searchActive = query !== '';
  // Searching MCP servers reaches plugin-provided servers too, each linking to
  // its plugin; every other view keeps listing them as the plugin (CAN-3653).
  const keepPluginProvided = searchActive && input.tab === 'app';
  const candidates = unique(input.entries);
  const tabEntries = (
    keepPluginProvided
      ? [...candidates, ...pluginServerResults(candidates)]
      : candidates
  ).filter(
    (entry) =>
      (keepPluginProvided || !listedAsItsPlugin(entry)) &&
      marketplaceEntryInTab(entry, input.tab) &&
      (entry.kind !== 'agent' || input.agentsAvailable === true) &&
      (entry.kind !== 'blueprint' || input.projectTemplatesAvailable === true),
  );
  // Ranked search determines matching identities; section order remains stable.
  const matchIds = (rows: UnifiedPluginEntry[]): Set<string> | null =>
    searchActive
      ? new Set(
          marketplaceResultEntries(searchUnifiedEntries(rows, query, null))
            .map((entry) => entry.id)
            .concat(input.searchMatchedEntryIds ?? []),
        )
      : null;
  const matches = matchIds(tabEntries);
  const entries = tabEntries.filter(
    (entry) => matches === null || matches.has(entry.id),
  );
  const sections: CustomizeSectionModel[] = [];
  function section(
    id: CustomizeSectionId,
    title: string,
    rows: readonly UnifiedPluginEntry[],
    extras: Partial<CustomizeSectionModel> = {},
  ): void {
    sections.push({
      id,
      domId: `customize-section-${id}`,
      title,
      entries: rows,
      count: rows.length,
      // Only All mixes kinds; single-kind tabs already name the kind in the
      // tab, so their rows drop the type chip (CAN-4840).
      showEntryTypes: input.tab === 'all',
      ...extras,
    });
  }
  function canonicalInstallsOf(
    rows: readonly UnifiedPluginEntry[],
  ): Map<string, UnifiedPluginEntry> {
    const result = new Map<string, UnifiedPluginEntry>();
    for (const entry of rows) {
      if (
        entry.kind === 'blueprint' ||
        !marketplaceEntryIsInstalled(
          entry,
          isBundledSkill(entry) ? undefined : input.installedStatusStates,
        )
      )
        continue;
      const key = installedStatusEntryId(entry);
      if (!result.has(key) || entry.id === key) result.set(key, entry);
    }
    return result;
  }
  const canonicalInstalls = canonicalInstallsOf(entries);
  // Missing desktop inventory does not erase known cloud/project installs.
  const allInstalled = [...canonicalInstalls.values()];
  const statusFilter = effectiveInstalledStatusFilter(
    input.tab,
    input.installedStatusFilter,
    input.supportedUpdateKinds,
  );
  const matchesStatus = (entry: UnifiedPluginEntry): boolean =>
    statusFilter === undefined ||
    installedStatusMember(
      entry,
      statusFilter,
      input.installedStatusStates,
      input.installedStatusSnapshot,
      input.supportedUpdateKinds,
    );
  const installed = allInstalled.filter(matchesStatus);
  const updates = installed.filter((entry) =>
    surfacedUpdate(entry, input.supportedUpdateKinds),
  );
  if (updates.length) section('updates', 'Updates', updates);
  if (
    input.tab !== 'blueprint' &&
    (installed.length ||
      input.installedInventory !== 'ready' ||
      input.keepInstalledVisible ||
      (input.tab === 'collection' && !searchActive) ||
      statusFilter)
  ) {
    const previewLimit =
      input.tab === 'all' && !searchActive && !input.installedExpanded
        ? CUSTOMIZE_INSTALLED_PREVIEW_LIMIT
        : undefined;
    // The footnote explains rows on screen, so a collapsed preview counts
    // only the rows it shows: `CustomizeInstalledList` renders the first
    // `previewLimit` of these rows, in this order.
    const visibleInstalled =
      previewLimit === undefined ? installed : installed.slice(0, previewLimit);
    section(
      'installed',
      input.tab === 'collection'
        ? 'Added'
        : input.tab === 'agent'
          ? 'Your agents'
          : 'Installed',
      installed,
      {
        inventoryState: input.installedInventory,
        ...(INSTALLED_FOOTNOTES[input.tab]
          ? { footnote: INSTALLED_FOOTNOTES[input.tab] }
          : {}),
        ...(visibleInstalled.some(isBundledSkill)
          ? { installedFootnote: BUNDLED_SKILL_FOOTNOTE }
          : {}),
        ...(previewLimit !== undefined ? { previewLimit } : {}),
      },
    );
  }
  const ownedByViewer = (entry: UnifiedPluginEntry): boolean =>
    entry.origin === 'shared' &&
    entry.isShared !== false &&
    entry.ownedByViewer === true;
  // A standalone MCP server has no share flow, so the MCP tab lists only the
  // plugin shares its host joined to a listed card. They stay out of the tab's
  // entries, so they never reach Browse or Installed; the chip names the plugin.
  const mcpOwned = (): UnifiedPluginEntry[] => {
    const eligible = candidates.filter(
      (entry) =>
        entry.kind === 'plugin' &&
        ownedByViewer(entry) &&
        input.mcpSharedEntryIds?.has(entry.id) === true,
    );
    const shareMatches = matchIds(eligible);
    return eligible.filter(
      (entry) =>
        (shareMatches === null || shareMatches.has(entry.id)) &&
        matchesStatus(entry),
    );
  };
  const owned = !input.ownershipAvailable
    ? []
    : input.tab === 'app'
      ? mcpOwned()
      : entries.filter(
          (entry) =>
            ownedByViewer(entry) &&
            entry.kind !== 'app' &&
            matchesStatus(entry),
        );
  if (owned.length)
    section(
      'shared-by-me',
      'Shared by me',
      owned,
      input.tab === 'app' ? { showEntryTypes: true } : {},
    );
  // Browse is what is not installed (CAN-5272): a status filter only applies
  // to installs, so it hides Browse. Collection shares retain their Installed
  // label in Shared with you, as required by the collections tab.
  if (!statusFilter) {
    const filters = input.pipelineFilters ?? DEFAULT_PIPELINE_FILTERS;
    const category = input.pipelineCategory?.trim().toLowerCase();
    // Exclusion reads the unsearched tab, so an alias matching by name stays
    // out even when its installation does not match.
    const installedKeys = searchActive
      ? canonicalInstallsOf(tabEntries)
      : canonicalInstalls;
    // When Shared by me is shown, the viewer's own share folded into its
    // local Collection lists only there; the local row stands for it under
    // Installed.
    const installedCollectionShares = entries.filter(
      (entry) =>
        entry.ref.type === 'shared-collection' &&
        entry.origin === 'shared' &&
        isInstalled(entry) &&
        !(input.ownershipAvailable && ownedByViewer(entry)),
    );
    const browse = marketplaceBrowseEntries(
      entries,
      new Set(installedKeys.keys()),
      undefined,
      { keepPluginProvided },
    )
      .concat(installedCollectionShares)
      .filter(
        (entry) =>
          !isBundledSkill(entry) &&
          ['curated', 'marketplace', 'shared'].includes(entry.origin) &&
          (entry.origin !== 'shared' || entry.isShared !== false) &&
          (entry.kind !== 'pipeline' ||
            (pipelineMatchesFilters(entry, filters) &&
              (!category ||
                entry.categories.some(
                  (value) => value.toLowerCase() === category,
                )))),
      );
    const groups =
      input.tab === 'all'
        ? allBrowseGroups(browse, searchActive, input.suggestedNames)
        : undefined;
    const browseEntries = groups
      ? unique(groups.flatMap((group) => group.entries))
      : browse;
    if (
      browseEntries.length ||
      (input.tab === 'workflow' &&
        (searchActive || pipelineFiltersActive(filters) || !!category))
    ) {
      section('browse', BROWSE_TITLES[input.tab], browseEntries, {
        ...(groups ? { groups } : {}),
        ...(!browseEntries.length
          ? { emptyReason: searchActive ? 'search' : 'pipeline-filters' }
          : {}),
      });
    }
  }
  const batchableUpdates = updates.filter((entry) => entry.kind === 'skill');
  return {
    sections,
    // A share and its installation are one item.
    resultCount: new Set(
      sections.flatMap((section) =>
        section.entries.map(installedStatusEntryId),
      ),
    ).size,
    searchActive,
    batchableUpdates,
    showUpdateAll: batchableUpdates.length > 1,
  };
}
