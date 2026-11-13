import type { CustomizeRowMenuItem } from '@canopy/ui-shared/components/CustomizeRowMenu';
import { isLocalCollectionConfig } from '@canopy/protocol/collections';
import { Stack, Button } from '@canopy/ui-shared/components';
import type { PluginMcpNavigationTarget } from '@canopy/ui-shared/components';
import {
  CustomizeSearchRow,
  CustomizeTabSections,
  useCollectionUpdateSummaries,
  EMPTY_INSTALLED_STATUS_SNAPSHOT,
  MarketplaceUnshareAction,
  buildCustomizeTabModel,
  customizeTabOffersUpdateFilter,
  effectiveInstalledStatusFilter,
  mcpSharedPluginEntryIds,
  type CustomizeUpdateKind,
  type InstalledStatusSnapshot,
  useOpenCreatedCustomItem,
  useResourceContext,
  type CustomizeMcpRowActions,
} from '@canopy/ui-app/capability';
import { useCapabilities, useCanopyClient } from '@canopy/app-state';
import type { MarketplaceSource } from '@canopy/app-core/client';
import {
  EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS,
  MarketplaceSourceAddDialog,
  MarketplaceSourceDetail,
  MarketplaceSourcesList,
  useMarketplaceSources,
  useMarketplaceSourcesAccess,
  type MarketplaceSourcePluginFilters,
} from '@canopy/ui-app/marketplace-sources';
import {
  scrollSectionToTop,
  useSidebarSectionRoot,
} from '@canopy/ui-app/sidebar';
import {
  formatMarketplaceRemoveBodyCopy,
  marketplaceSourceValidProviders,
} from '@/client/marketplace-source-summary';
import { isFeatureSurfaceAvailable } from '@canopy/app-core/gating';
import { CuratedPipelinePreview } from '../pipeline/CuratedPipelinePreview';
import { curatedPipelineId } from '../pipeline/pipeline-catalog-entry';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useLayoutEffect,
  useState,
} from 'react';
import { PageTitlebar } from '../shared/PageTitlebar';
import { PageContent } from '../shared/PageContent';
import { useMarketplaceList } from '../../hooks/useMarketplaceList';
import { useCuratedMcpServers } from '../../hooks/useCuratedMcpServers';
import { useMcpServerList } from '../../hooks/useMcpServerList';
import { useSkillList } from '../../hooks/useSkillList';
import { useCustomizeSkillUpdates } from '../../hooks/useCustomizeSkillUpdates';
import { usePublisherSkills } from '../../hooks/usePublisherSkills';
import {
  useCapabilityMarketplaceInventory,
  type CapabilityMarketplaceInventory,
} from '../../hooks/useCapabilityMarketplaceInventory';
import { MCP_MANAGEMENT_REASONS } from '@canopy/ui-shared/lib/mcp-card-display';
import { mcpConnectErrorCodeTitle } from '@canopy/ui-shared/lib';
import { formatRelativeTime } from '@/lib/format';
import { mcpHasMultipleTargets } from '@canopy/ui-shared/lib/mcp-row-health';
import { useDetectedMcpServers } from '../../hooks/useDetectedMcpServers';
import { McpServerDialog } from './McpServersTab';
import { AddSkillsModal, CreateSkillModal } from './SkillsTab';
import { CollectionModal } from './CollectionsTab';
import { ErrorBanner } from '../shared';
import { McpServerLogo } from '../shared/McpServerLogo';
import { summarizeLoadErrors } from '@/lib/summarizeLoadErrors';
import {
  buildInstalledSkillEntry,
  buildUnifiedPluginEntries,
  collectEntryCategories,
  curatedCatalogFromMarketplaces,
  marketplaceTitleCase,
  findAccountMcpRow,
  pickerMcpServers,
  searchUnifiedEntries,
  buildMarketplaceBrowseGroups,
  marketplaceCategoryPageEntries,
  localAgentIdFromEntryId,
  pendingLocalAgentEntry,
  pendingSharedAutomationEntry,
  type UnifiedPluginEntry,
  visibleEntryId,
} from '../../lib/unifiedPluginEntries';
import { marketplaceBrowseNameKey } from '../../lib/marketplaceBrowseCuration';
import {
  ROLE_PLUGIN_RECOMMENDATIONS,
  resolveRolePluginRecommendations,
} from '@canopy/desktop-shared/lib/role-plugin-recommendations';
import { useAutomationsStore } from '@/stores/automationsStore';
import { AutomationUpdateModal } from '../automations/AutomationUpdateModal';
import { useAutomationUpdateSource } from '../automations/useAutomationUpdateSource';
import { useCustomizeWorkflowActions } from '../plugins/useCustomizeWorkflowActions';
import { useSavedProfileRoles } from '@/hooks/useSavedProfileRoles';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { PluginsDiscoveryList } from '../plugins/PluginsDiscoveryList';
import type { PluginsDiscoverySectionId } from '../plugins/pluginsDiscoverySections';
import { PluginEntryDetail } from '../plugins/PluginEntryDetail';
import type { MarketplaceUnshareKind } from '@canopy/ui-shared/lib/marketplace-unshare';
import {
  followMarketplaceUnshare,
  unshareMarketplaceResource,
  unshareOwnerName,
} from '@/lib/marketplaceUnshare';
import { PipelineCatalogStatus } from '../plugins/PipelineCatalogStatus';
import { AutomationCatalogStatus } from '../plugins/AutomationCatalogStatus';
import {
  accountRowOf,
  customizeMcpSurfaceInForeground,
} from '../mcp/accountMcpActionRequests';
import { useAccountMcpActionRequests } from '../mcp/useAccountMcpActionRequests';
import { accountMcpConnectionKey } from '@/hooks/useAccountMcpActions';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useWorkspaceContextReset } from '@/hooks/useWorkspaceContextReset';
import { useProviderConnectors } from '@/hooks/useProviderConnectors';
import { advertisesProviderConnector } from '@/lib/unifiedPluginEntries';
import { SharePluginModal } from '@/components/plugins/SharePluginModal';
import {
  desktopSectionRoot,
  useNavigationStore,
  type CapabilityMarketplaceTabId,
  type CapabilityMarketplaceReturnTarget,
  type PluginsPresentationLocation,
  type PipelineReturnTarget,
} from '@/stores/navigationStore';
import type { PluginsManagementSectionId } from '@canopy/desktop-shared/types';
import type {
  McpServerStatusEntry,
  McpServerIndexEntry,
  AccountMcpConnection,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  CUSTOMIZE_SECTION_SUBTITLE,
  EmptyState,
  PageHeader,
  MarketplaceSearchField,
  PageSearchRow,
  MarketplaceTypeTabs,
  PluginsAddCustomMenu,
  Notice,
  NoticeButton,
  PluginsPipelineFilters,
  RefreshButton,
  useOverlayEscape,
  CustomizeBreadcrumbs,
} from '@canopy/ui-shared/components';
import {
  DEFAULT_PIPELINE_FILTERS,
  type MarketplaceCatalogTabId,
  marketplaceEntityTypeLabel,
  marketplaceShareAction,
  marketplaceTypeTabs,
  marketplaceEntryInTab,
  marketplaceTabForKind,
  normalizeMarketplaceNavigation,
  marketplaceManagementDestination,
  pipelineFiltersActive,
  type MarketplaceEntryShareState,
  type PipelineFilterValues,
} from '@canopy/ui-shared/lib';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import {
  parseInstalledStatusFilter,
  type InstalledStatusFilterValue,
} from '@canopy/ui-shared/lib/installed-item-status';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useShareAction } from '@/hooks/useShareAction';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useMarketplaceOwnedShare } from '../plugins/useMarketplaceOwnedShare';
import {
  createMarketplaceEntryShareResolver,
  refreshMarketplaceEntryShareResolution,
  marketplaceEntryShareState,
  pluginShareRefKey,
  type MarketplaceShareResolution,
  type PluginShareTarget,
} from '../plugins/marketplaceShareResolution';
import { pluginNeedsInstall } from '@/lib/pluginInstallStatus';
import { CUSTOM_SKILL_SOURCE_ID } from '@/lib/sharedSkillImport';
import { useSkillsChangedRefresh } from '@/lib/skillsChanged';
import { COLLECTIONS_CHANGED_EVENT } from '../share/installReveal';
import { marketplaceEntryInstallLink } from '@/lib/sharedResourceInstallLink';
import { useDesktopInstalledItemStatuses } from '@/hooks/useDesktopInstalledItemStatuses';
import { useInstalledShareSourceHashes } from '@/hooks/useInstalledShareSourceHashes';
import {
  installedEntryStatusStates,
  type PluginsEntryStatusBinding,
} from '@canopy/ui-shared';
import { AgentModelModal } from '../agents/AgentModelModal';
import { DeleteConfirmModal } from '../shared/DeleteConfirmModal';
import { useAgentsStore } from '@/stores/agentsStore';
import { extractIpcErrorMessage } from '@/lib/errors';
import type { SaveAgentModelRequest } from '@canopy/execution-engine/types/agent-models';
import type { SharedSkillSummary } from '@canopy/desktop-shared/types/skills';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';

/**
 * Curated MCP browse. The event used to be handled by `McpServersTab`, but the
 * redesign removed the curated Browse affordance from the MCP section and gave
 * discovery ownership of it (API-2153, design section 5).
 */
function entryUsesDetailPage(
  entry: UnifiedPluginEntry,
  mcpServers: readonly McpServerIndexEntry[],
): boolean {
  const ref = entry.ref;
  // Every installed skill, custom ones included, opens as a page (CAN-3483);
  // editing a custom skill opens its editor dialog over that page.
  if (ref.type === 'skill') return true;
  if (ref.type === 'local-mcp')
    return !findAccountMcpRow(mcpServers, ref.serverId);
  if (ref.type === 'curated-mcp') return true;
  return true;
}

/** Every curated name any role can recommend, in first-seen order. */
const ROLE_RECOMMENDATION_NAMES = Array.from(
  new Set(Object.values(ROLE_PLUGIN_RECOMMENDATIONS).flat()),
);

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

/** The local-agent dialog the page hosts over discovery or a detail. */
type AgentDialog =
  | { mode: 'create' }
  | { mode: 'edit'; agentId: string }
  | { mode: 'delete'; agentId: string };

function noopOpenAccountSettings(): void {}

// ---------------------------------------------------------------------------
// PluginsPage main export
// ---------------------------------------------------------------------------

interface PluginsPageProps {
  onOpenAccountSettings?: () => void;
}

/**
 * Unified capability marketplace (API-2153 / CAN-1565 / CAN-1567).
 *
 * The page IS discovery: search over one unified list of
 * curated plugins, curated/local MCP "apps", local/shared skills, pipelines,
 * and Collections. Installed content collapses into the Installed section, and
 * the technical add-flows live behind the "Add custom…" dropdown — each item
 * opening the pre-existing dialog.
 */
const SCROLL_PRESENTATION_WRITE_DELAY_MS = 150;
/**
 * One value for the Updates section and the Update available filter offer,
 * so the two cannot drift (CAN-5309).
 */
const CUSTOMIZE_SUPPORTED_UPDATE_KINDS: readonly CustomizeUpdateKind[] = [
  'skill',
  'automation',
  'collection',
];

interface RowUnshareTarget {
  readonly kind: MarketplaceUnshareKind;
  readonly shareId: string;
  readonly name: string;
  readonly owner: { readonly type: string; readonly name?: string | null };
  readonly canDelete?: boolean;
}

function unshareTarget(
  kind: MarketplaceUnshareKind,
  shareId: string,
  share: Omit<RowUnshareTarget, 'kind' | 'shareId'>,
): RowUnshareTarget {
  return {
    kind,
    shareId,
    name: share.name,
    owner: share.owner,
    canDelete: share.canDelete,
  };
}

/** The account share behind a Shared by me row, from the page's lists. */
function rowUnshareTarget(
  entry: UnifiedPluginEntry,
  inventory: Pick<
    CapabilityMarketplaceInventory,
    'sharedSkills' | 'sharedCollections' | 'sharedAgents' | 'sharedPlugins'
  >,
): RowUnshareTarget | null {
  const ref = entry.ref;
  if (ref.type === 'shared-skill') {
    const share = inventory.sharedSkills.find((row) => row.id === ref.skillId);
    return share ? unshareTarget('skill', share.id, share) : null;
  }
  if (ref.type === 'shared-collection') {
    const share = inventory.sharedCollections.find(
      (row) => row.id === ref.collectionId,
    );
    return share ? unshareTarget('collection', share.id, share) : null;
  }
  if (ref.type === 'shared-agent') {
    const share = inventory.sharedAgents.find((row) => row.id === ref.agentId);
    return share ? unshareTarget('agent', share.id, share) : null;
  }
  if (ref.type === 'shared-plugin') {
    const share = inventory.sharedPlugins.find(
      (row) => row.externalId === ref.pluginId,
    );
    return share ? unshareTarget('plugin', share.externalId, share) : null;
  }
  return null;
}

export function PluginsPage({
  onOpenAccountSettings,
}: PluginsPageProps): JSX.Element {
  const savedPresentation = useRef(
    useNavigationStore.getState().pluginsPresentation,
  ).current;
  const [query, setQuery] = useState(savedPresentation?.browse.query ?? '');
  const deferredQuery = useDeferredValue(query);

  // --- Data sources (composed through existing hooks and wire contracts) ---
  // Exactly one `useMarketplaceList` for the whole surface: the hook loads on
  // mount and its `upsert`/`removal` mutators are per-instance, so every
  // section is fed from here rather than mounting a second copy.
  const {
    cache,
    loading,
    error,
    reload: reloadMarketplaces,
  } = useMarketplaceList();
  const {
    skills,
    loading: skillsLoading,
    error: skillsError,
    refresh: refreshSkills,
    refreshOrThrow: refreshSkillsOrThrow,
  } = useSkillList();
  const skillUpdates = useCustomizeSkillUpdates(refreshSkills);
  const updateSkillEntry = skillUpdates.update;
  const {
    servers,
    loading: mcpLoading,
    error: mcpError,
    refresh: refreshServers,
    accountConnectionsAvailable,
    accountConnectionsUnavailableReason,
  } = useMcpServerList();
  const { entries: curatedMcpServers } = useCuratedMcpServers();
  const savedRoles = useSavedProfileRoles();
  const previousSavedRolesRef = useRef<typeof savedRoles>(undefined);
  useEffect(() => {
    if (savedRoles === undefined) return;
    const previous = previousSavedRolesRef.current;
    previousSavedRolesRef.current = savedRoles;
    if (previous !== undefined) void reloadMarketplaces();
  }, [reloadMarketplaces, savedRoles]);
  const pickerServers = useMemo(
    (): McpServerIndexEntry[] => pickerMcpServers(servers),
    [servers],
  );
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatusEntry[]>([]);

  // Read-only status snapshot. Deliberately does NOT drive the health sweep
  // that `useMcpServerStatuses` performs for the MCP Servers table: discovery
  // only needs the already-derived auth state, and probing every configured
  // server on page open would be a new cost on a landing surface.
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const entries = await window.mcpServers.listStatus();
        if (!cancelled) setMcpStatuses(entries);
      } catch {
        // No handler / transport failure → degrade to "no status known".
        if (!cancelled) setMcpStatuses([]);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [servers]);

  // A browser sign-in settles after its Connect returned, with no other signal.
  useEffect(
    () =>
      window.mcpServers?.onAuthChanged?.(() => {
        void window.mcpServers
          .listStatus()
          .then(setMcpStatuses, () => undefined);
      }),
    [],
  );

  /** Re-reads the status cache; a failed read rejects, unlike the passive one. */
  const refreshMcpStatuses = useCallback(async (): Promise<void> => {
    setMcpStatuses(await window.mcpServers.listStatus());
  }, []);

  // --- Discovery state ---
  const [category, setCategory] = useState<string | null>(
    savedPresentation?.browse.category ?? null,
  );
  /** Restricts discovery to the capability type selected in the peer tabs. */
  const [kindFilter, setKindFilter] = useState<Exclude<
    CapabilityMarketplaceTabId,
    'all'
  > | null>(
    savedPresentation?.browse.tab === 'all'
      ? null
      : (savedPresentation?.browse.tab ?? null),
  );
  const [pipelineFilterValues, setPipelineFilterValues] =
    useState<PipelineFilterValues>(
      savedPresentation?.browse.pipelineFilters ?? DEFAULT_PIPELINE_FILTERS,
    );
  // Every filter narrows pipelines only, so they apply on the Pipelines tab
  // alone and a choice made there never hides rows on another tab.
  const pipelineFilters =
    kindFilter === 'workflow' ? pipelineFilterValues : DEFAULT_PIPELINE_FILTERS;
  const capabilities = useCapabilities();
  const ownershipAvailable =
    isFeatureSurfaceAvailable(capabilities, 'marketplace-owned-shares') ||
    isFeatureSurfaceAvailable(
      capabilities,
      'marketplace-owned-automation-shares',
    );
  const [focusSection, setFocusSection] = useState<
    'installed' | 'shared-by-me' | null
  >(null);
  // Shared agents list behind the Agents rollout flag, like the Agents page.
  // Project templates get a tab once the desktop can list team and
  // organization template shares.
  const sharedCustomAgentsEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key),
  );
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(
    savedPresentation?.entry?.id ?? null,
  );
  const sourceClient = useCanopyClient();
  const canAddMarketplace =
    sourceClient.capabilities.marketplaceSourceAdd === true &&
    typeof sourceClient.marketplaceSources?.createAddSession === 'function';
  const [installedExpanded, setInstalledExpanded] = useState(
    savedPresentation?.browse.installedExpanded === true,
  );
  const marketplaceSourcesAccess = useMarketplaceSourcesAccess();
  const marketplaceSourcesAvailable = marketplaceSourcesAccess.client !== null;
  const typeTabs = useMemo(
    () =>
      marketplaceTypeTabs({
        agents: sharedCustomAgentsEnabled,
        sources: marketplaceSourcesAvailable,
      }),
    [marketplaceSourcesAvailable, sharedCustomAgentsEnabled],
  );
  // The Marketplaces tab (CAN-4262) is navigation state, not a catalog kind:
  // it swaps the catalog for the shared source list and loads nothing else.
  const showingSources =
    kindFilter === 'sources' && marketplaceSourcesAvailable;
  const sourcesVisible = showingSources && selectedEntryId === null;
  const marketplaceSources = useMarketplaceSources(marketplaceSourcesAccess, {
    enabled: showingSources,
  });
  const [sourceBulkState, setSourceBulkState] = useState({
    running: false,
    cancelling: false,
    done: 0,
    total: 0,
  });
  const sourceRequestGeneration = useRef(0);
  const [pendingSourcePlugin, setPendingSourcePlugin] = useState<{
    sourceId: string;
    pluginKey: string;
    generation: number;
  } | null>(null);
  const [sourceNavigationError, setSourceNavigationError] = useState<
    string | null
  >(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(
    savedPresentation?.source?.sourceId ?? null,
  );
  const [sourcePluginFilters, setSourcePluginFilters] =
    useState<MarketplaceSourcePluginFilters>(
      savedPresentation?.source?.filters ??
        EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS,
    );
  const openMarketplaceSource = useCallback((sourceId: string): void => {
    setSourcePluginFilters(EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS);
    setSourceNavigationError(null);
    setPendingSourcePlugin(null);
    setSelectedSourceId(sourceId);
  }, []);
  const closeMarketplaceSource = useCallback((): void => {
    setSelectedSourceId(null);
    setPendingSourcePlugin(null);
    setSourceNavigationError(null);
  }, []);
  const sourceDetailOpen = sourcesVisible && selectedSourceId !== null;
  const selectedSource =
    selectedSourceId !== null
      ? marketplaceSources.sources?.find(
          (source) => source.id === selectedSourceId,
        )
      : undefined;
  const marketplaceSourceRemoveConfirmation = useCallback(
    (source: MarketplaceSource) => ({
      title: (
        <>
          Remove <span className="ph-mask">{source.name}</span>?
        </>
      ),
      message: formatMarketplaceRemoveBodyCopy(
        marketplaceSourceValidProviders(source),
      ),
    }),
    [],
  );
  // Local agents (CAN-4266): the page hosts their dialogs; a pending editor
  // request waits here until the inventory can resolve it.
  const [agentDialog, setAgentDialog] = useState<AgentDialog | null>(null);
  const [pendingAgentEditId, setPendingAgentEditId] = useState<string | null>(
    null,
  );
  const selectedLocalAgentId =
    selectedEntryId === null ? null : localAgentIdFromEntryId(selectedEntryId);
  const curatedEnabled = kindFilter === null || kindFilter === 'workflow';
  const capabilityInventory = useCapabilityMarketplaceInventory(deferredQuery, {
    category: category ?? undefined,
    curatedEnabled,
    completeSharedCatalogs:
      ownershipAvailable &&
      (kindFilter === null ||
        kindFilter === 'skill' ||
        kindFilter === 'collection'),
    // Automations list on the All and Automations tabs only, so their catalog
    // stays unloaded everywhere else. "Shared by me" lists no curated rows.
    curatedAutomationsEnabled: kindFilter === null || kindFilter === 'workflow',
    ownedAutomationSharesEnabled:
      ownershipAvailable && (kindFilter === null || kindFilter === 'workflow'),
    // Shared agents and plugin references load only where they list. Agents
    // stay behind the Agents rollout flag.
    sharedAgentsEnabled:
      sharedCustomAgentsEnabled &&
      (kindFilter === null || kindFilter === 'agent'),
    ownedAgentSharesEnabled:
      ownershipAvailable && (kindFilter === null || kindFilter === 'agent'),
    // Local agents also load for an open agent detail or a pending editor,
    // so a deep link resolves whichever tab was selected before.
    localAgentsEnabled:
      sharedCustomAgentsEnabled &&
      (kindFilter === null ||
        kindFilter === 'agent' ||
        selectedLocalAgentId !== null ||
        pendingAgentEditId !== null ||
        agentDialog !== null),
    // Shared plugins also load for an open plugin detail, so an installed
    // plugin's Shared by you finds the owner's share under any type filter
    // (CAN-4842), and for MCP servers, whose Shared by me lists the plugin
    // shares that match a listed server (CAN-4843).
    sharedPluginsEnabled:
      kindFilter === null ||
      kindFilter === 'plugin' ||
      kindFilter === 'app' ||
      selectedEntryId?.startsWith('mkt:') === true ||
      selectedEntryId?.startsWith('curated:') === true ||
      selectedEntryId?.startsWith('plugin:shared:') === true,
    sharedBlueprintsEnabled: kindFilter === null || kindFilter === 'blueprint',
  });
  const [retainedDetailEntry, setRetainedDetailEntry] =
    useState<UnifiedPluginEntry | null>(null);
  // A rename saved from an open detail's edit overlay, applied on top of the
  // resolved entry so the breadcrumb tracks the fresh name even while the
  // inventory row is stale or (server-filtered) missing entirely.
  const [detailNameOverride, setDetailNameOverride] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [entryDetailIntent, setEntryDetailIntent] = useState<'view' | 'add'>(
    'view',
  );
  /**
   * Entry ids behind the currently open detail: a related-item click swaps
   * the detail in place and pushes the previous entry here so its Back
   * affordance can restore it (CAN-2382).
   */
  const [entryDetailStack, setEntryDetailStack] = useState<string[]>(
    savedPresentation?.entry?.stack ?? [],
  );
  /**
   * Pipeline to reopen when the current detail was opened from a pipeline
   * editor's related-capability click (CAN-2382). Back on the detail
   * restores that editor instead of stranding the user on this page.
   */
  const [entryDetailPipelineReturn, setEntryDetailPipelineReturn] =
    useState<PipelineReturnTarget | null>(
      savedPresentation?.entry?.pipelineReturn ?? null,
    );
  /**
   * Whether the open detail page was reached from an installed list (the
   * Installed strip or the Installed section), so its breadcrumb keeps the
   * Installed level: `Customize > Installed > Skills > <name>` (CAN-3484).
   */
  const [entryDetailFromInstalled, setEntryDetailFromInstalled] = useState(
    savedPresentation?.entry?.fromInstalled === true,
  );
  /** Management section restored by the detail's Back control, when any. */
  const [entryDetailBrowseReturn, setEntryDetailBrowseReturn] =
    useState<CapabilityMarketplaceReturnTarget | null>(
      savedPresentation?.entry?.browseReturn ?? null,
    );
  /**
   * Installed skill opened by identity (the Installed Skills list or a deep
   * link), resolved by `selectedEntry` until the projection lists it.
   */
  const [installedSkillDetailEntry, setInstalledSkillDetailEntry] =
    useState<UnifiedPluginEntry | null>(null);
  /**
   * Shared skill a deep link read by id. The shared inventory is filtered by
   * the page's search, so it may not list the skill the link names.
   */
  const [linkedSharedSkill, setLinkedSharedSkill] =
    useState<SharedSkillSummary | null>(null);
  /**
   * Bumped whenever the page's own navigation moves on (a reset, a closed or
   * newly opened entry, a context or Cloud account change); a shared-skill
   * link read from before it is dropped.
   */
  const sharedSkillLinkGeneration = useRef(0);
  /** Shared skill whose link read is in flight, consumed if the page closes. */
  const sharedSkillLinkInFlight = useRef<string | null>(null);
  /** Supporting file an installed skill's deep link opens its page on. */
  const [skillDetailFilePath, setSkillDetailFilePath] = useState<{
    entryId: string;
    filePath: string;
  } | null>(
    savedPresentation?.entry?.skillFilePath
      ? {
          entryId: savedPresentation.entry.id,
          filePath: savedPresentation.entry.skillFilePath,
        }
      : null,
  );
  /**
   * Installed custom skill whose edit page replaces its detail page
   * (CAN-3485): `Customize > Installed > Skills > <name> > Edit`. Keyed by
   * entry id, so moving to any other detail (a rename included) ends it.
   */
  const [mcpNavigation, setMcpNavigation] = useState<{
    entryId: string;
    target: PluginMcpNavigationTarget;
  } | null>(null);
  const [skillEditorEntryId, setSkillEditorEntryId] = useState<string | null>(
    null,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const categorySearchInputRef = useRef<HTMLInputElement>(null);
  const pageScrollRef = useRef<HTMLDivElement>(null);
  // Whether the page has scrolled past its top. The pinned titlebar draws its
  // bottom hairline only then: at rest the bar is just the window's top
  // inset, and a divider there would underline nothing.
  const [pageScrolled, setPageScrolled] = useState(false);
  useEffect(() => {
    const node = pageScrollRef.current;
    if (!node) return undefined;
    const update = (): void => {
      const next = node.scrollTop > 0;
      setPageScrolled((previous) => (previous === next ? previous : next));
    };
    update();
    node.addEventListener('scroll', update, { passive: true });
    return (): void => node.removeEventListener('scroll', update);
  }, []);
  const browseScrollTopRef = useRef(savedPresentation?.browseScrollTop ?? 0);
  const detailReturnScrollTopRef = useRef(
    savedPresentation?.detailReturnScrollTop ?? 0,
  );
  const pendingScrollTop = useRef<number | null>(
    savedPresentation?.scrollTop ?? null,
  );
  const detailPageEntryIdRef = useRef<string | null>(null);

  /**
   * Capture the browse scroll position synchronously in the opening event
   * handler: by the time any effect runs, the detail DOM has replaced the
   * browse content and the scroller has already clamped `scrollTop`.
   * Related-entry hops keep the original capture, so closing a chain of
   * details restores the pre-detail browse position.
   */
  const captureDetailReturnScrollTop = useCallback((): void => {
    if (detailPageEntryIdRef.current !== null) return;
    detailReturnScrollTopRef.current = pageScrollRef.current?.scrollTop ?? 0;
  }, []);
  // The Customize row clicked on the Customize home (QA, 2026-10-23): back
  // to All at the top, in place. From a detail, a source or the installed
  // view the page mounts fresh instead; the store sees an open category.
  useSidebarSectionRoot(
    desktopSectionRoot,
    selectedEntryId === null && !sourceDetailOpen && !installedExpanded,
    (): void => {
      setQuery('');
      setCategory(null);
      setKindFilter(null);
      // The status filter belongs to the tab being left (CAN-4838).
      setInstalledStatusFilter(null);
      scrollSectionToTop(pageScrollRef.current);
    },
  );
  const browseSectionId = useNavigationStore(
    (state) => state.pluginsBrowseSectionId,
  ) as PluginsDiscoverySectionId | null;
  const setBrowseSectionId = useNavigationStore(
    (state) => state.setPluginsBrowseSectionId,
  );
  const previousBrowseSectionIdRef = useRef<string | null>(browseSectionId);
  const [categoryQuery, setCategoryQuery] = useState(
    savedPresentation?.categoryQuery ?? '',
  );
  const deferredCategoryQuery = useDeferredValue(categoryQuery);
  const [installedStatusFilter, setInstalledStatusFilter] =
    useState<InstalledStatusFilterValue | null>(
      parseInstalledStatusFilter(
        savedPresentation?.browse.installedStatusFilter,
      ) ?? null,
    );
  // Held here, not in the list, so a row changed while filtered keeps its
  // place across an entry detail page, which unmounts the list (CAN-4838).
  const [installedStatusSnapshot, setInstalledStatusSnapshot] =
    useState<InstalledStatusSnapshot>(EMPTY_INSTALLED_STATUS_SNAPSHOT);

  // --- Dialog state (every dialog is an existing component) ---
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const [marketplaceInitialRepo, setMarketplaceInitialRepo] = useState('');
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [mcpEditServerId, setMcpEditServerId] = useState<string | null>(null);
  const [mcpEditAccount, setMcpEditAccount] =
    useState<AccountMcpConnection | null>(null);
  const [mcpRowError, setMcpRowError] = useState('');
  const rowMcpSelections = useMemo(
    () => ({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: servers.flatMap((server) =>
        server.configs.map((config) => ({
          serverId: server.id,
          configId: config.id,
        })),
      ),
    }),
    [servers],
  );
  const rowMcp = useDetectedMcpServers(rowMcpSelections, {
    ownerKey: 'customize-mcp-rows',
    cancelOnDispose: true,
  });
  useEffect(() => {
    if (rowMcp.error) setMcpRowError(rowMcp.error);
  }, [rowMcp.error]);
  const [addSkillsOpen, setAddSkillsOpen] = useState(false);
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [collectionEditor, setCollectionEditor] = useState<{
    id: string | null;
    context: string;
  } | null>(null);
  const createCollectionOpen = collectionEditor !== null;
  const [collectionActionError, setCollectionActionError] = useState('');
  const collectionMutations = useRef(new Set<string>());
  const collectionCopyReconciliation = useRef(new Set<string>());
  const [pluginShareTarget, setPluginShareTarget] =
    useState<PluginShareTarget | null>(null);
  const shareAction = useShareAction();
  const { shareGateModal } = shareAction;
  const shareScopingContext = useSidebarScopingContext();

  useEffect(() => {
    if (!canAddMarketplace) setAddMarketplaceOpen(false);
  }, [canAddMarketplace]);
  const closePageOwnedDialogs = useCallback(
    (preserveBrowse = false): void => {
      sourceRequestGeneration.current += 1;
      sharedSkillLinkGeneration.current += 1;
      setSelectedEntryId(null);
      setSelectedSourceId(null);
      setPendingSourcePlugin(null);
      setSourceNavigationError(null);
      setFocusSection(null);
      setEntryDetailIntent('view');
      setEntryDetailStack([]);
      setEntryDetailPipelineReturn(null);
      setEntryDetailFromInstalled(false);
      setEntryDetailBrowseReturn(null);
      setSkillDetailFilePath(null);
      setInstalledSkillDetailEntry(null);
      setLinkedSharedSkill(null);
      setSkillEditorEntryId(null);
      setAddMarketplaceOpen(false);
      setMarketplaceInitialRepo('');
      setMcpDialogOpen(false);
      setMcpEditServerId(null);
      setMcpEditAccount(null);
      setAddSkillsOpen(false);
      setCreateSkillOpen(false);
      setCollectionEditor(null);
      setAgentDialog(null);
      setPendingAgentEditId(null);
      if (!preserveBrowse) {
        setBrowseSectionId(null);
        setCategoryQuery('');
      }
    },
    [setBrowseSectionId],
  );

  const marketplaces = useMemo(
    () => cache?.marketplaces ?? [],
    [cache?.marketplaces],
  );

  const {
    results: providerConnectors,
    loading: providerConnectorsLoading,
    refresh: refreshProviderConnectors,
  } = useProviderConnectors({
    // The third call site. Same gate the picker uses: with no advertised
    // connector nothing can join the read, so the Claude CLI spawn and the
    // Codex cache parse would be paid for a discarded result.
    enabled: curatedMcpServers.some(advertisesProviderConnector),
  });

  // Customize › Workflows rows run, toggle, edit and delete through the same
  // stores and commands as the Workflows page (CAN-4845).
  const { workflowActions, pipelineLastRuns, dispatchPipelineModal } =
    useCustomizeWorkflowActions({
      pipelines: capabilityInventory.pipelines,
      activities: capabilityInventory.automationActivities,
      refreshPipelines: capabilityInventory.refreshPipelines,
      deletePipeline: capabilityInventory.deletePipeline,
      deleteSharedPipeline: capabilityInventory.deleteSharedPipeline,
    });
  const automationUpdate = useAutomationUpdateSource();

  const publisherSkills = usePublisherSkills();
  const { personalOrganizationId } = useResourceContext();
  // A shared copy's row shows Update available from the same source read as
  // its detail (CAN-5309); unresolved sources leave the hash out.
  const shareSourceHashes = useInstalledShareSourceHashes(
    skills,
    capabilityInventory.skillCloudAccount,
  );
  const installedSkills = useMemo(
    () =>
      shareSourceHashes.size === 0
        ? skills
        : skills.map((skill) => {
            const remoteId = skill.installedFromShare?.remoteId;
            const sourceContentHash =
              remoteId === undefined
                ? undefined
                : shareSourceHashes.get(remoteId);
            return sourceContentHash === undefined
              ? skill
              : { ...skill, sourceContentHash };
          }),
    [skills, shareSourceHashes],
  );
  const entries = useMemo(
    () =>
      buildUnifiedPluginEntries({
        personalOrganizationId,
        viewerId: capabilityInventory.viewerId,
        retainAutomationCatalogEntries: true,
        publisherSkills: publisherSkills.skills,
        curatedPlugins: curatedCatalogFromMarketplaces(marketplaces),
        // App availability comes from materialized plugin content. Global
        // provider installation is separate and remains visible in details.
        marketplaces: marketplaces.map((marketplace) => ({
          ...marketplace,
          plugins: marketplace.plugins.map((plugin) => ({
            ...plugin,
            installed: !pluginNeedsInstall(plugin),
          })),
        })),
        installedSkills,
        mcpServers: pickerServers,
        mcpStatuses,
        curatedMcpServers,
        // The integration card's detail installs the folded plugin here
        // (REG-3033); the portal's MCP panel cannot, so it keeps plugin cards.
        foldSingleKeyPlugins: true,
        providerConnectors: providerConnectors ?? [],
        pipelines: capabilityInventory.pipelines,
        // An automation's own pipeline lists under it (CAN-4551).
        ownedPipelineIds: new Set(
          capabilityInventory.automationActivities.flatMap((activity) =>
            activity.ownedPipeline ? [activity.ownedPipeline.pipelineId] : [],
          ),
        ),
        pipelineLastRuns,
        curatedPipelines: capabilityInventory.curated?.rows,
        localCollections: capabilityInventory.localCollections,
        sharedSkills: capabilityInventory.sharedSkills,
        sharedCollections: capabilityInventory.sharedCollections,
        localAutomations: capabilityInventory.localAutomations,
        sharedAutomations: capabilityInventory.sharedAutomations,
        curatedAutomations: capabilityInventory.curatedAutomations.rows,
        // Both agent lists follow the flag here too, so a list still in
        // flight when agents switch off never reaches the page.
        // An owned share keeps its shared row, folded into its local copy, so
        // "Shared by me" and direct links still resolve it.
        localAgents: sharedCustomAgentsEnabled
          ? capabilityInventory.localAgents
          : undefined,
        sharedAgents: sharedCustomAgentsEnabled
          ? capabilityInventory.sharedAgents
          : undefined,
        sharedPlugins: capabilityInventory.sharedPlugins,
        sharedBlueprints: capabilityInventory.sharedBlueprints,
      }).map(skillUpdates.project),
    [
      personalOrganizationId,
      marketplaces,
      publisherSkills.skills,
      installedSkills,
      pickerServers,
      mcpStatuses,
      curatedMcpServers,
      providerConnectors,
      capabilityInventory.pipelines,
      capabilityInventory.automationActivities,
      pipelineLastRuns,
      capabilityInventory.curated?.rows,
      capabilityInventory.localCollections,
      capabilityInventory.sharedSkills,
      capabilityInventory.sharedCollections,
      capabilityInventory.localAutomations,
      capabilityInventory.sharedAutomations,
      capabilityInventory.curatedAutomations.rows,
      capabilityInventory.localAgents,
      capabilityInventory.sharedAgents,
      capabilityInventory.sharedPlugins,
      capabilityInventory.sharedBlueprints,
      capabilityInventory.viewerId,
      skillUpdates.project,
      sharedCustomAgentsEnabled,
    ],
  );

  const linkedSharedSkillEntry = useMemo(
    () =>
      linkedSharedSkill
        ? (buildUnifiedPluginEntries({
            personalOrganizationId,
            viewerId: capabilityInventory.viewerId,
            curatedPlugins: [],
            marketplaces: [],
            installedSkills: [],
            mcpServers: [],
            mcpStatuses: [],
            curatedMcpServers: [],
            providerConnectors: [],
            sharedSkills: [linkedSharedSkill],
          }).find(
            (entry) => entry.id === `skill:shared:${linkedSharedSkill.id}`,
          ) ?? null)
        : null,
    [capabilityInventory.viewerId, linkedSharedSkill, personalOrganizationId],
  );
  // The detail reads its summary from this list; the inventory's copy wins
  // once the search lists the skill again.
  const detailSharedSkills = useMemo(
    () =>
      linkedSharedSkill &&
      !capabilityInventory.sharedSkills.some(
        (skill) => skill.id === linkedSharedSkill.id,
      )
        ? [...capabilityInventory.sharedSkills, linkedSharedSkill]
        : capabilityInventory.sharedSkills,
    [capabilityInventory.sharedSkills, linkedSharedSkill],
  );

  const collectionLocalRows = capabilityInventory.localCollections;
  const collectionSharedRows = capabilityInventory.sharedCollections;
  const refreshCollectionList = capabilityInventory.refreshLocalCollections;
  const refreshCollectionShares = capabilityInventory.refreshSharedCollections;
  const collectionContextKey = JSON.stringify([
    shareScopingContext,
    capabilityInventory.viewerId,
  ]);
  const collectionScope = useMemo(
    () => ({ key: collectionContextKey }),
    [collectionContextKey],
  );
  const collectionPending = useRef<typeof collectionScope | null>(null);
  const [pendingCollectionScope, setPendingCollectionScope] = useState<
    typeof collectionScope | null
  >(null);
  const [unknownCollectionCreates, setUnknownCollectionCreates] = useState<
    ReadonlySet<string>
  >(new Set());
  const canCreateCollection =
    pendingCollectionScope !== collectionScope &&
    !unknownCollectionCreates.has(collectionContextKey);
  const openCollectionCreate = useCallback((): void => {
    if (
      collectionPending.current !== collectionScope &&
      !unknownCollectionCreates.has(collectionContextKey)
    )
      setCollectionEditor({ id: null, context: collectionContextKey });
  }, [collectionScope, collectionContextKey, unknownCollectionCreates]);
  const currentCollectionContext = useRef(collectionScope);
  currentCollectionContext.current = collectionScope;
  useEffect(() => {
    setCollectionEditor(null);
    setCollectionActionError('');
  }, [collectionScope]);
  const collectionSummaryPorts = useMemo(
    () => ({
      contextKey: collectionContextKey,
      onRevisionMismatch: (): void => {
        void refreshCollectionShares();
        void refreshCollectionList();
      },
      refreshKey: JSON.stringify([
        collectionLocalRows,
        collectionSharedRows.map((share) => [share.id, share.contentHash]),
      ]),
      loadLocalMembers: (
        id: string,
      ): ReturnType<typeof window.collections.loadCollection> =>
        window.collections.loadCollection(id),
      loadSharedDocument: (
        id: string,
      ): ReturnType<typeof window.collections.getShared> =>
        window.collections.getShared(id),
    }),
    [
      refreshCollectionShares,
      refreshCollectionList,
      collectionContextKey,
      collectionLocalRows,
      collectionSharedRows,
    ],
  );
  const collectionSummaries = useCollectionUpdateSummaries(
    entries,
    collectionSummaryPorts,
  );

  // A collection installed from the share install review (CAN-3710) is listed
  // before its detail opens, even when this page was already mounted.
  const refreshLocalCollections = capabilityInventory.refreshLocalCollections;
  useEffect(() => {
    const handleCollectionsChanged = (): void => {
      void refreshLocalCollections();
    };
    window.addEventListener(
      COLLECTIONS_CHANGED_EVENT,
      handleCollectionsChanged,
    );
    return (): void => {
      window.removeEventListener(
        COLLECTIONS_CHANGED_EVENT,
        handleCollectionsChanged,
      );
    };
  }, [refreshLocalCollections]);

  // The user's own skills, pipelines, automations and collections share
  // through the dialogs their own pages use.
  const ownedShare = useMarketplaceOwnedShare({
    shareAction,
    onOpenAccountSettings: onOpenAccountSettings ?? noopOpenAccountSettings,
    onSharedSkillsChanged: (): void =>
      void capabilityInventory.refreshSharedSkills(),
    onSharedCollectionsChanged: (): void =>
      void capabilityInventory.refreshSharedCollections(),
    onPipelinesChanged: (): void => void capabilityInventory.refreshPipelines(),
    onLocalAgentsChanged: (): void =>
      void capabilityInventory.refreshLocalAgents(),
    onSharedAgentsChanged: capabilityInventory.refreshSharedAgents,
  });
  const { canShare: canShareOwned, share: shareOwned } = ownedShare;
  // CAN-3704: one resolver per inventory snapshot. Every plugin, MCP and
  // skill entry resolves to a target or a blocked reason, installed or not;
  // the card, the detail and the click all read the same result.
  const resolveEntryShare = useMemo(
    () =>
      createMarketplaceEntryShareResolver({
        marketplaces,
        skills,
        sharedSkills: detailSharedSkills,
        sharedPlugins: capabilityInventory.sharedPlugins,
        localCollections: capabilityInventory.localCollections,
        pipelines: capabilityInventory.pipelines,
        automationActivities: capabilityInventory.automationActivities,
        localAgents: capabilityInventory.localAgentDefinitions,
        context: shareScopingContext,
      }),
    [
      capabilityInventory.automationActivities,
      capabilityInventory.localAgentDefinitions,
      capabilityInventory.localCollections,
      capabilityInventory.pipelines,
      capabilityInventory.sharedPlugins,
      detailSharedSkills,
      marketplaces,
      shareScopingContext,
      skills,
    ],
  );
  const canShareResolution = useCallback(
    (resolution: MarketplaceShareResolution | null): boolean =>
      resolution?.status !== 'shareable' ||
      (resolution.activation.kind === 'plugin'
        ? shareAction.canShare('plugin')
        : canShareOwned(resolution.activation.target.kind)),
    [canShareOwned, shareAction],
  );
  const entryShareStates = useMemo(() => {
    const states = new Map<string, MarketplaceEntryShareState>();
    // A linked shared skill the search hides still needs its detail's share
    // state; it never joins the browse list.
    const shareEntries =
      linkedSharedSkillEntry &&
      !entries.some((entry) => entry.id === linkedSharedSkillEntry.id)
        ? [...entries, linkedSharedSkillEntry]
        : entries;
    for (const entry of shareEntries) {
      const resolution = resolveEntryShare(entry);
      if (!canShareResolution(resolution)) continue;
      const state = marketplaceEntryShareState(entry, resolution);
      if (state) states.set(entry.id, state);
    }
    return states;
  }, [canShareResolution, entries, linkedSharedSkillEntry, resolveEntryShare]);

  // A newer click or unmount cancels an in-flight share. An inventory
  // snapshot that changes mid-click (opening a detail page refreshes one)
  // does not: the click proceeds only if the newest snapshot still resolves
  // the entry as shareable, so it fails closed without being dropped.
  const shareRequest = useRef(0);
  const shareSnapshot = useRef(0);
  const latestEntryShareable = useRef<(entry: UnifiedPluginEntry) => boolean>(
    () => false,
  );
  useEffect(() => {
    shareSnapshot.current += 1;
    latestEntryShareable.current = (entry): boolean => {
      const latest = resolveEntryShare(entry);
      return latest?.status === 'shareable' && canShareResolution(latest);
    };
  }, [canShareResolution, resolveEntryShare]);
  useEffect(
    () => (): void => {
      shareRequest.current += 1;
    },
    [],
  );
  const handleShareEntry = useCallback(
    (entry: UnifiedPluginEntry): void => {
      const current = resolveEntryShare(entry);
      if (current?.status !== 'shareable' || !canShareResolution(current))
        return;
      const sequence = ++shareRequest.current;
      const snapshot = shareSnapshot.current;
      void refreshMarketplaceEntryShareResolution(entry, {
        marketplaces,
        skills,
        sharedSkills: detailSharedSkills,
        sharedPlugins: capabilityInventory.sharedPlugins,
        localCollections: capabilityInventory.localCollections,
        pipelines: capabilityInventory.pipelines,
        automationActivities: capabilityInventory.automationActivities,
        localAgents: capabilityInventory.localAgentDefinitions,
        context: shareScopingContext,
      }).then((resolution) => {
        if (
          sequence !== shareRequest.current ||
          (snapshot !== shareSnapshot.current &&
            !latestEntryShareable.current(entry)) ||
          resolution?.status !== 'shareable' ||
          !canShareResolution(resolution)
        )
          return;
        const { activation } = resolution;
        if (activation.kind === 'owned') {
          shareOwned(activation.target);
          return;
        }
        shareAction.share('plugin', () =>
          setPluginShareTarget(activation.target),
        );
      });
    },
    [
      canShareResolution,
      capabilityInventory,
      detailSharedSkills,
      marketplaces,
      resolveEntryShare,
      shareAction,
      shareOwned,
      shareScopingContext,
      skills,
    ],
  );

  // Membership is determined before section-specific filters.
  const visibleEntries = useMemo(
    () =>
      entries.filter((entry) =>
        marketplaceEntryInTab(entry, kindFilter ?? 'all'),
      ),
    [entries, kindFilter],
  );

  const categories = useMemo(
    () => collectEntryCategories(visibleEntries),
    [visibleEntries],
  );

  // Category chips can outlive the entries that produced them (a marketplace
  // removal, a catalog refresh); drop a filter that no longer matches anything.
  useEffect(() => {
    if (
      category !== null &&
      !categories.includes(category) &&
      !capabilityInventory.curated?.loading &&
      !capabilityInventory.curated?.nextCursor &&
      !capabilityInventory.curated?.error
    ) {
      setCategory(null);
    }
  }, [
    categories,
    category,
    capabilityInventory.curated?.loading,
    capabilityInventory.curated?.nextCursor,
    capabilityInventory.curated?.error,
  ]);

  const searchActive = deferredQuery.trim() !== '';
  const activeTypeTab: CapabilityMarketplaceTabId = kindFilter ?? 'all';
  const activeCatalogTab: MarketplaceCatalogTabId =
    activeTypeTab === 'sources' ? 'all' : activeTypeTab;
  const results = useMemo(
    () => searchUnifiedEntries(visibleEntries, deferredQuery, category),
    [visibleEntries, deferredQuery, category],
  );

  // Suggested follows Getting Started's role shortlist: resolved against the
  // whole catalog (installed or not) so the role/fallback choice is stable,
  // then stripped of anything already installed from any source.
  const suggestedNames = useMemo(() => {
    if (savedRoles === undefined) return [];
    const catalogKeys = new Set<string>();
    const installedKeys = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== 'plugin') continue;
      const key = marketplaceBrowseNameKey(entry.name);
      catalogKeys.add(key);
      if (entry.state !== 'available') installedKeys.add(key);
    }
    const inCatalog = ROLE_RECOMMENDATION_NAMES.filter((name) =>
      catalogKeys.has(marketplaceBrowseNameKey(name)),
    );
    return resolveRolePluginRecommendations(
      savedRoles,
      inCatalog,
      inCatalog.filter((name) =>
        installedKeys.has(marketplaceBrowseNameKey(name)),
      ),
    );
  }, [entries, savedRoles]);

  const installedStatuses = useDesktopInstalledItemStatuses();
  const [installedStatusError, setInstalledStatusError] = useState<
    string | null
  >(null);
  const entryStatusStates = useMemo(
    () => installedEntryStatusStates(entries, installedStatuses.state),
    [entries, installedStatuses.state],
  );
  const browseGroups = useMemo(
    () =>
      buildMarketplaceBrowseGroups(results, {
        suggestedNames,
        installedStatusStates: entryStatusStates,
      }),
    [entryStatusStates, results, suggestedNames],
  );

  const activeBrowseGroup = useMemo(
    () => browseGroups.find((group) => group.id === browseSectionId) ?? null,
    [browseGroups, browseSectionId],
  );

  useEffect(() => {
    const previousSectionId = previousBrowseSectionIdRef.current;
    previousBrowseSectionIdRef.current = browseSectionId;
    if (previousSectionId === null && browseSectionId !== null) {
      if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
    } else if (previousSectionId !== null && browseSectionId === null) {
      if (pageScrollRef.current) {
        pageScrollRef.current.scrollTop = browseScrollTopRef.current;
      }
    }
  }, [browseSectionId]);

  const openBrowseGroup = useCallback(
    (sectionId: PluginsDiscoverySectionId): void => {
      browseScrollTopRef.current = pageScrollRef.current?.scrollTop ?? 0;
      setCategoryQuery('');
      setBrowseSectionId(sectionId);
    },
    [setBrowseSectionId],
  );

  const closeBrowseGroup = useCallback((): void => {
    setBrowseSectionId(null);
    setCategoryQuery('');
  }, [setBrowseSectionId]);

  const categoryPageEntries = useMemo(
    () =>
      activeBrowseGroup
        ? marketplaceCategoryPageEntries(
            activeBrowseGroup,
            deferredCategoryQuery,
          )
        : [],
    [activeBrowseGroup, deferredCategoryQuery],
  );

  // Manual refresh for the Pipelines tab, the one tab whose content does not
  // stay current by itself: the curated catalog is served from a saved copy
  // that only a forced refresh replaces. The other inventories load with the
  // page and stay current through their mutation callbacks or existing change,
  // focus, and account events. The ref swallows a second click that lands
  // before the disabled state renders.
  const refreshPipelineLists = capabilityInventory.refreshPipelines;
  const curatedPipelineRefreshRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    curatedPipelineRefreshRef.current = curatedEnabled
      ? capabilityInventory.curated?.onRefresh
      : undefined;
  });
  const pipelinesRefreshInFlightRef = useRef(false);
  const [pipelinesRefreshing, setPipelinesRefreshing] = useState(false);
  const pipelinesRefreshBusy =
    pipelinesRefreshing ||
    (curatedEnabled && capabilityInventory.curated?.loading === true);
  const handleRefreshPipelines = useCallback((): void => {
    if (pipelinesRefreshInFlightRef.current) return;
    pipelinesRefreshInFlightRef.current = true;
    setPipelinesRefreshing(true);
    curatedPipelineRefreshRef.current?.();
    void (async (): Promise<void> => {
      try {
        await refreshPipelineLists();
      } finally {
        pipelinesRefreshInFlightRef.current = false;
        setPipelinesRefreshing(false);
      }
    })();
  }, [refreshPipelineLists]);

  // A removed row disappears once its inventory re-reads (CAN-4840).
  const refreshAfterRemoval = useCallback(
    (entry: UnifiedPluginEntry): void => {
      const ref = entry.ref;
      switch (ref.type) {
        case 'skill':
          void refreshSkills();
          return;
        case 'local-mcp':
        case 'curated-mcp':
        case 'mcp-server':
          void refreshServers();
          return;
        case 'local-collection':
          void refreshLocalCollections();
          return;
        case 'marketplace-plugin':
        case 'curated-plugin':
          void reloadMarketplaces();
          return;
        // These rows never carry an installed-items status, so they offer no
        // removal from the row menu. A plugin-bundled skill follows its plugin
        // (CAN-4844).
        case 'plugin-skill':
        case 'public-share':
        case 'curated-pipeline':
        case 'provider-connector':
        case 'pipeline':
        case 'local-agent':
        case 'automation':
        case 'curated-automation':
        case 'shared-skill':
        case 'shared-collection':
        case 'shared-agent':
        case 'shared-plugin':
        case 'shared-blueprint':
        case 'shared-automation':
          return;
        default: {
          const unhandled: never = ref;
          return unhandled;
        }
      }
    },
    [
      refreshSkills,
      refreshServers,
      refreshLocalCollections,
      reloadMarketplaces,
    ],
  );
  const entryStatus: PluginsEntryStatusBinding = useMemo(
    () => ({
      states: entryStatusStates,
      pendingKeys: installedStatuses.pendingKeys,
      onSetStatus: installedStatuses.setStatus,
      onError: setInstalledStatusError,
      onUninstall: installedStatuses.uninstall,
      onUninstalled: refreshAfterRemoval,
    }),
    [
      entryStatusStates,
      installedStatuses.pendingKeys,
      installedStatuses.setStatus,
      installedStatuses.uninstall,
      refreshAfterRemoval,
    ],
  );
  const {
    removeSharedResource,
    refreshSharedSkills,
    refreshSharedCollections,
  } = capabilityInventory;
  // The owner's Unshare in a Shared by me row menu, with the same
  // follow-up as the shared detail's Unshare minus closing a detail.
  const renderRowUnshare = useCallback(
    (
      entry: UnifiedPluginEntry,
      renderRow: (item: CustomizeRowMenuItem) => ReactNode,
    ): ReactNode => {
      const share = rowUnshareTarget(entry, {
        sharedSkills: capabilityInventory.sharedSkills,
        sharedCollections: capabilityInventory.sharedCollections,
        sharedAgents: capabilityInventory.sharedAgents,
        sharedPlugins: capabilityInventory.sharedPlugins,
      });
      if (share?.canDelete !== true) return null;
      const { kind, shareId, name } = share;
      return (
        <MarketplaceUnshareAction
          key={`${kind}:${shareId}`}
          renderTrigger={(unshare) =>
            renderRow({ ...unshare.item, label: 'Unshare…' })
          }
          kind={kind}
          name={name}
          ownerName={unshareOwnerName(share.owner)}
          onUnshare={() => unshareMarketplaceResource(kind, shareId)}
          onUnshared={(): void => {
            removeSharedResource(kind, shareId);
            followMarketplaceUnshare(kind, name, {
              sharedSkills: refreshSharedSkills,
              sharedCollections: refreshSharedCollections,
            });
          }}
          dataTestId={`customize-row-unshare-${entry.id}`}
        />
      );
    },
    [
      capabilityInventory.sharedSkills,
      capabilityInventory.sharedCollections,
      capabilityInventory.sharedAgents,
      capabilityInventory.sharedPlugins,
      removeSharedResource,
      refreshSharedSkills,
      refreshSharedCollections,
    ],
  );
  // Existing shares list whether or not this viewer can create one now.
  const mcpSharedEntryIds = useMemo(
    () =>
      activeCatalogTab === 'app'
        ? mcpSharedPluginEntryIds(
            entries,
            capabilityInventory.sharedPlugins,
            (entry) => pluginShareRefKey(resolveEntryShare(entry)),
          )
        : undefined,
    [
      activeCatalogTab,
      entries,
      capabilityInventory.sharedPlugins,
      resolveEntryShare,
    ],
  );
  const sectionModel = useMemo(
    () =>
      buildCustomizeTabModel({
        tab: activeCatalogTab,
        entries,
        query: deferredQuery,
        installedInventory: capabilityInventory.installedInventory,
        ownershipAvailable:
          ownershipAvailable && !!capabilityInventory.viewerId,
        supportedUpdateKinds: CUSTOMIZE_SUPPORTED_UPDATE_KINDS,
        pipelineFilters,
        pipelineCategory: category,
        suggestedNames,
        agentsAvailable: sharedCustomAgentsEnabled,
        projectTemplatesAvailable: true,
        mcpSharedEntryIds,
      }),
    [
      activeCatalogTab,
      entries,
      deferredQuery,
      capabilityInventory.installedInventory,
      ownershipAvailable,
      capabilityInventory.viewerId,
      pipelineFilters,
      category,
      suggestedNames,
      sharedCustomAgentsEnabled,
      mcpSharedEntryIds,
    ],
  );
  const resultCount = sectionModel.resultCount;
  const categorySearchActive = deferredCategoryQuery.trim() !== '';
  const reportedSearchActive = activeBrowseGroup
    ? categorySearchActive
    : searchActive;
  const reportedResultCount = activeBrowseGroup
    ? categoryPageEntries.length
    : resultCount;
  // Never report the search text — only whether a search is active and how
  // many rows it produced.
  useCurrentUiStateReporter(
    'plugins.page',
    useMemo(
      () => ({
        view: 'discovery',
        customizeTab: kindFilter ?? 'all',
        installedStatusFilter,
        installedExpanded,
        searchActive: reportedSearchActive,
        resultCount: reportedResultCount,
        selectedEntryId,
        detailHistoryDepth: entryDetailStack.length,
        detailBackTarget:
          entryDetailStack.length > 0
            ? 'entry'
            : entryDetailPipelineReturn
              ? 'pipeline'
              : null,
        // The create-mode collection editor is page-owned modal state, so
        // App Advisor sees it like every other dialog this page can open.
        createCollectionOpen,
        // A custom skill's edit page replaces its detail (CAN-3485).
        skillEditorOpen:
          selectedEntryId !== null && skillEditorEntryId === selectedEntryId,
        // Local agent dialogs the page hosts (CAN-4266); ids only, never the
        // agent's instructions or plugin configuration.
        agentDialog: agentDialog?.mode ?? null,
        agentDialogAgentId:
          agentDialog && agentDialog.mode !== 'create'
            ? agentDialog.agentId
            : null,
      }),
      [
        agentDialog,
        kindFilter,
        installedStatusFilter,
        installedExpanded,
        reportedSearchActive,
        reportedResultCount,
        selectedEntryId,
        entryDetailStack.length,
        entryDetailPipelineReturn,
        createCollectionOpen,
        skillEditorEntryId,
      ],
    ),
  );

  // App Advisor sees the Marketplaces tab beside the legacy snapshot keys.
  const reportedSources = marketplaceSources.sources;
  useCurrentUiStateReporter(
    sourcesVisible ? 'plugins.marketplaceSources' : null,
    useMemo(
      () => ({
        sourceCount: reportedSources?.length ?? null,
        invalidCount:
          reportedSources?.filter((source) => source.status.state === 'invalid')
            .length ?? null,
        loading: marketplaceSources.loading,
        refreshing: marketplaceSources.refreshing,
        listError: marketplaceSources.listError !== null,
        selectedSourceId,
        filters:
          selectedSourceId === null
            ? null
            : {
                searchActive: sourcePluginFilters.query.trim() !== '',
                categoryActive: sourcePluginFilters.category !== null,
                authorActive: sourcePluginFilters.author !== null,
              },
        busySourceIds: Object.keys(marketplaceSources.operations),
        bulkInstall: sourceBulkState,
      }),
      [
        marketplaceSources.listError,
        marketplaceSources.loading,
        marketplaceSources.operations,
        marketplaceSources.refreshing,
        reportedSources,
        selectedSourceId,
        sourcePluginFilters,
        sourceBulkState,
      ],
    ),
  );

  useEffect(() => {
    if (marketplaceSourcesAvailable) return;
    sourceRequestGeneration.current += 1;
    setPendingSourcePlugin(null);
    setSelectedSourceId(null);
  }, [marketplaceSourcesAvailable]);
  const settingsOpen = useNavigationStore((state) => state.settingsOpen);
  useEffect(() => {
    if (settingsOpen) setAddMarketplaceOpen(false);
  }, [settingsOpen]);

  const currentBrowseState = useMemo<CapabilityMarketplaceReturnTarget>(
    () => ({
      query,
      tab: kindFilter ?? 'all',
      ...(category ? { category } : {}),
      ...(installedStatusFilter ? { installedStatusFilter } : {}),
      installedExpanded,
      ...(pipelineFiltersActive(pipelineFilterValues)
        ? { pipelineFilters: pipelineFilterValues }
        : {}),
    }),
    [
      query,
      kindFilter,
      category,
      installedStatusFilter,
      installedExpanded,
      pipelineFilterValues,
    ],
  );
  const currentDetailReturn = useMemo<CapabilityMarketplaceReturnTarget>(
    () => ({
      ...currentBrowseState,
      ...(selectedSourceId
        ? {
            source: {
              sourceId: selectedSourceId,
              filters: sourcePluginFilters,
            },
          }
        : {}),
    }),
    [currentBrowseState, selectedSourceId, sourcePluginFilters],
  );
  // Row actions read the latest return destination without invalidating
  // every Browse row when only the search text changes.
  const currentDetailReturnRef = useRef(currentDetailReturn);
  useLayoutEffect(() => {
    currentDetailReturnRef.current = currentDetailReturn;
  }, [currentDetailReturn]);
  const applyBrowseDestination = useCallback(
    (destination: CapabilityMarketplaceReturnTarget): void => {
      if (destination.tab === 'sources' && !marketplaceSourcesAvailable) {
        setKindFilter(null);
        setSelectedSourceId(null);
        setPendingSourcePlugin(null);
        setSourceNavigationError('Marketplaces are not available right now.');
        return;
      }
      setQuery(destination.query);
      setCategory(destination.category ?? null);
      setKindFilter(destination.tab === 'all' ? null : destination.tab);
      setFocusSection(destination.focusSection ?? null);
      setInstalledStatusFilter(
        parseInstalledStatusFilter(destination.installedStatusFilter) ?? null,
      );
      setInstalledExpanded(destination.installedExpanded === true);
      setPipelineFilterValues(
        destination.pipelineFilters ?? DEFAULT_PIPELINE_FILTERS,
      );
      setSelectedSourceId(destination.source?.sourceId ?? null);
      if (destination.source)
        setSourcePluginFilters(destination.source.filters);
    },
    [marketplaceSourcesAvailable],
  );
  // Scrolling records the page offset for history, but one store write per
  // scroll event re-runs every navigation selector and rewrites the current
  // history entry. Keep the latest offset and write it once the scroll
  // settles, or when the page unmounts so Back/Forward still restore it.
  const pendingScrollTopRef = useRef<number | null>(null);
  const scrollWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const flushScrollTop = useCallback((): void => {
    if (scrollWriteTimerRef.current !== null) {
      clearTimeout(scrollWriteTimerRef.current);
      scrollWriteTimerRef.current = null;
    }
    const scrollTop = pendingScrollTopRef.current;
    pendingScrollTopRef.current = null;
    if (scrollTop === null) return;
    const navigation = useNavigationStore.getState();
    if (navigation.pluginsPresentation)
      navigation.setPluginsPresentation({
        ...navigation.pluginsPresentation,
        scrollTop,
      });
  }, []);
  useEffect(() => flushScrollTop, [flushScrollTop]);
  useEffect(() => {
    const location: PluginsPresentationLocation = {
      browse: currentBrowseState,
      scrollTop: pageScrollRef.current?.scrollTop ?? 0,
      browseScrollTop: browseScrollTopRef.current,
      detailReturnScrollTop: detailReturnScrollTopRef.current,
      categoryQuery,
      ...(selectedSourceId
        ? {
            source: {
              sourceId: selectedSourceId,
              filters: sourcePluginFilters,
            },
          }
        : {}),
      ...(selectedEntryId
        ? {
            entry: {
              id: selectedEntryId,
              stack: entryDetailStack,
              fromInstalled: entryDetailFromInstalled,
              ...(skillDetailFilePath?.entryId === selectedEntryId
                ? { skillFilePath: skillDetailFilePath.filePath }
                : {}),
              ...(entryDetailPipelineReturn
                ? { pipelineReturn: entryDetailPipelineReturn }
                : {}),
              ...(entryDetailBrowseReturn
                ? { browseReturn: entryDetailBrowseReturn }
                : {}),
            },
          }
        : {}),
    };
    useNavigationStore.getState().setPluginsPresentation(location);
  }, [
    currentBrowseState,
    selectedSourceId,
    sourcePluginFilters,
    selectedEntryId,
    entryDetailStack,
    entryDetailFromInstalled,
    entryDetailPipelineReturn,
    entryDetailBrowseReturn,
    skillDetailFilePath,
    categoryQuery,
  ]);

  const pendingPluginsNavigation = useNavigationStore(
    (state) => state.pendingPluginsNavigation,
  );
  const consumePluginsNavigation = useNavigationStore(
    (state) => state.consumePluginsNavigation,
  );
  useEffect(() => {
    if (!pendingPluginsNavigation) return;
    closePageOwnedDialogs(pendingPluginsNavigation.kind === 'restore');
    // A `switch` rather than an if/else chain so the union stays closed: a
    // new `PluginsNavigationIntent` kind must add its own case instead of
    // silently inheriting the discovery reset below.
    switch (pendingPluginsNavigation.kind) {
      case 'restore':
        if (
          pendingPluginsNavigation.location.browse.tab === 'sources' &&
          !marketplaceSourcesAvailable
        ) {
          applyBrowseDestination({ query: '', tab: 'all' });
          setSourceNavigationError('Marketplaces are not available right now.');
          break;
        }
        pendingScrollTop.current =
          pendingPluginsNavigation.location.scrollTop ?? 0;
        browseScrollTopRef.current =
          pendingPluginsNavigation.location.browseScrollTop ?? 0;
        detailReturnScrollTopRef.current =
          pendingPluginsNavigation.location.detailReturnScrollTop ?? 0;
        setSkillDetailFilePath(
          pendingPluginsNavigation.location.entry?.skillFilePath
            ? {
                entryId: pendingPluginsNavigation.location.entry.id,
                filePath: pendingPluginsNavigation.location.entry.skillFilePath,
              }
            : null,
        );
        setCategoryQuery(pendingPluginsNavigation.location.categoryQuery ?? '');
        applyBrowseDestination(pendingPluginsNavigation.location.browse);
        setSelectedSourceId(
          pendingPluginsNavigation.location.source?.sourceId ?? null,
        );
        setSourcePluginFilters(
          pendingPluginsNavigation.location.source?.filters ??
            EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS,
        );
        setSelectedEntryId(pendingPluginsNavigation.location.entry?.id ?? null);
        setEntryDetailStack(
          pendingPluginsNavigation.location.entry?.stack ?? [],
        );
        setEntryDetailFromInstalled(
          pendingPluginsNavigation.location.entry?.fromInstalled === true,
        );
        setEntryDetailPipelineReturn(
          pendingPluginsNavigation.location.entry?.pipelineReturn ?? null,
        );
        setEntryDetailBrowseReturn(
          pendingPluginsNavigation.location.entry?.browseReturn ?? null,
        );
        break;
      case 'management':
        // A fresh visit, even to the filter already applied; a restore keeps
        // the snapshot so Back from an entry detail keeps its rows.
        setInstalledStatusSnapshot(EMPTY_INSTALLED_STATUS_SNAPSHOT);
        applyBrowseDestination(
          marketplaceManagementDestination(
            pendingPluginsNavigation.section,
            pendingPluginsNavigation.statusFilter,
          ),
        );
        break;
      case 'marketplace-source':
        if (!marketplaceSourcesAvailable) {
          setSourceNavigationError('Marketplaces are not available right now.');
          break;
        }
        applyBrowseDestination({ query: '', tab: 'sources' });
        setSourcePluginFilters(EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS);
        setSelectedSourceId(
          pendingPluginsNavigation.target === 'detail'
            ? pendingPluginsNavigation.sourceId
            : null,
        );
        if (
          pendingPluginsNavigation.target === 'detail' &&
          pendingPluginsNavigation.pluginKey
        ) {
          setPendingSourcePlugin({
            sourceId: pendingPluginsNavigation.sourceId,
            pluginKey: pendingPluginsNavigation.pluginKey,
            generation: sourceRequestGeneration.current,
          });
        }
        break;
      case 'entry-detail': {
        setMcpNavigation(
          pendingPluginsNavigation.mcpTarget
            ? {
                entryId: pendingPluginsNavigation.entryId,
                target: pendingPluginsNavigation.mcpTarget,
              }
            : null,
        );
        const agentId = localAgentIdFromEntryId(
          pendingPluginsNavigation.entryId,
        );
        if (
          agentId !== null ||
          pendingPluginsNavigation.entryId.startsWith('agent:shared:')
        ) {
          // A local agent (CAN-4266) opens on the Agents tab with no stale
          // search narrowing it. With agents switched off the request is
          // dropped rather than replayed when they return.
          if (!sharedCustomAgentsEnabled) break;
          setQuery('');
          setCategory(null);
          setKindFilter('agent');
          setEntryDetailIntent('view');
          captureDetailReturnScrollTop();
          setSelectedEntryId(pendingPluginsNavigation.entryId);
          if (agentId !== null && pendingPluginsNavigation.intent === 'edit') {
            setPendingAgentEditId(agentId);
          }
          break;
        }
        setEntryDetailIntent(
          pendingPluginsNavigation.intent === 'connect' ? 'add' : 'view',
        );
        // Related-item navigation from pipeline surfaces (CAN-2382). The
        // resolved entry decides whether management closes for an inline page
        // or remains behind a dialog-owned detail. The `from` context becomes
        // the detail's Back target: a source entry seeds the detail stack, a
        // source pipeline reopens its editor. The browse DOM is still mounted
        // when this intent is consumed, so the scroll capture is still valid.
        captureDetailReturnScrollTop();
        setSelectedEntryId(pendingPluginsNavigation.entryId);
        const from = pendingPluginsNavigation.from;
        if (
          from?.kind === 'entry' &&
          from.entryId !== pendingPluginsNavigation.entryId
        ) {
          setEntryDetailStack([from.entryId]);
        } else if (from?.kind === 'entry-context') {
          setEntryDetailStack(from.stack);
          setEntryDetailPipelineReturn(from.pipelineReturn ?? null);
          setEntryDetailFromInstalled(from.fromInstalled === true);
          const returnBrowse = from.managementReturn
            ? marketplaceManagementDestination(from.managementReturn)
            : (from.marketplace ?? null);
          setEntryDetailBrowseReturn(returnBrowse);
          // The page unmounted while the pipeline editor was open, so the
          // browse state behind the detail comes back through the intent.
          if (returnBrowse) {
            const normalized = normalizeMarketplaceNavigation(
              returnBrowse.tab,
              returnBrowse.focusSection ??
                Reflect.get(returnBrowse, 'ownership'),
            );
            applyBrowseDestination({ ...returnBrowse, ...normalized });
          }
        } else if (from?.kind === 'pipeline') {
          setEntryDetailPipelineReturn({
            pipelineId: from.pipelineId,
            cwd: from.cwd,
            filePath: from.filePath,
            source: from.source,
            sharedRemoteId: from.sharedRemoteId,
            returnToEntryId: from.returnToEntryId,
            returnToEntryContext: from.returnToEntryContext,
            returnToPipeline: from.returnToPipeline,
          });
        }
        break;
      }
      case 'browse-apps':
      case 'discovery':
        setPipelineFilterValues(DEFAULT_PIPELINE_FILTERS);
        setInstalledStatusFilter(null);
        setInstalledExpanded(false);
        setSelectedSourceId(null);
        // Both open discovery and differ only in the kind filter:
        // `browse-apps` narrows to MCP apps, while `discovery` is the
        // unfiltered browse surface and must not inherit an app-only filter
        // (that filter hides exactly the skills and plugins its callers want).
        setQuery(
          pendingPluginsNavigation.kind === 'discovery'
            ? (pendingPluginsNavigation.searchQuery ?? '')
            : '',
        );
        setCategory(null);
        setKindFilter(
          pendingPluginsNavigation.kind === 'browse-apps' ? 'app' : null,
        );
        searchInputRef.current?.focus();
        break;
      case 'marketplace-browse': {
        applyBrowseDestination(pendingPluginsNavigation);
        break;
      }
      default: {
        const exhaustive: never = pendingPluginsNavigation;
        void exhaustive;
        break;
      }
    }
    consumePluginsNavigation(pendingPluginsNavigation);
  }, [
    applyBrowseDestination,
    captureDetailReturnScrollTop,
    closePageOwnedDialogs,
    consumePluginsNavigation,
    pendingPluginsNavigation,
    marketplaceSourcesAvailable,
    sharedCustomAgentsEnabled,
  ]);

  // Discovery's `useSkillList()` is its own hook instance with its own cache,
  // so a skill installed, created, imported or removed elsewhere (App Advisor,
  // an installed skill's detail page) only
  // reaches this projection by refreshing on the shared skills-changed event.
  // The refresh is tracked so a sender can wait for it.
  useSkillsChangedRefresh(refreshSkillsOrThrow);

  /**
   * Entry for an installed skill opened by identity (the Installed Skills list
   * or a deep link). That list and deep links can run ahead of this page's
   * inventory, and publisher installs are not listed as plain skill entries,
   * so the entry is built from the identity until the projection has it.
   */
  const installedSkillEntry = useCallback(
    (sourceId: string, name: string): UnifiedPluginEntry => {
      const record = skills.find(
        (skill) => skill.sourceId === sourceId && skill.name === name,
      );
      const built = buildInstalledSkillEntry({
        sourceId,
        name,
        description: record?.description ?? '',
        builtIn: record?.builtIn,
      });
      return entries.find((entry) => entry.id === built.id) ?? built;
    },
    [entries, skills],
  );

  /**
   * Open an installed skill's detail page as part of Your Installed Skills
   * (CAN-3483): `Customize > Installed > Skills > <name>`, with Back and the
   * Skills crumb returning to that list. `edit` opens a custom skill's edit
   * page over that detail (CAN-3485), so Cancel lands on the detail.
   */
  const openInstalledSkillDetail = useCallback(
    (skill: {
      sourceId: string;
      name: string;
      filePath?: string;
      edit?: true;
    }): void => {
      const entry = installedSkillEntry(skill.sourceId, skill.name);
      sharedSkillLinkGeneration.current += 1;
      captureDetailReturnScrollTop();
      setEntryDetailIntent('view');
      setEntryDetailStack([]);
      setEntryDetailPipelineReturn(null);
      setEntryDetailFromInstalled(true);
      setEntryDetailBrowseReturn(marketplaceManagementDestination('skills'));
      setSkillDetailFilePath(
        skill.filePath ? { entryId: entry.id, filePath: skill.filePath } : null,
      );
      setInstalledSkillDetailEntry(entry);
      setSkillEditorEntryId(skill.edit ? entry.id : null);
      setSelectedEntryId(entry.id);
    },
    [captureDetailReturnScrollTop, installedSkillEntry],
  );

  // Store-backed skill deep link (Cmd+K palette, chat artifacts, App Advisor):
  // the pending payload survives this page's lazy mount. An installed skill
  // opens its detail page here; a shared skill opens its shared detail.
  const pendingSkillViewer = useNavigationStore((s) => s.pendingSkillViewer);
  // A shared skill is read by id, not from the search-filtered inventory. Its
  // own effect keeps inventory loads from cancelling and resending the read.
  // The link is consumed once its detail opens or its failure is shown, or
  // dropped when the page navigated, the context or Cloud account changed,
  // or the page closed during the read.
  const pendingSharedSkillId =
    pendingSkillViewer &&
    'kind' in pendingSkillViewer &&
    pendingSkillViewer.kind === 'shared'
      ? pendingSkillViewer.skillId
      : null;
  useEffect(() => {
    if (pendingSharedSkillId === null) return undefined;
    let cancelled = false;
    const generation = sharedSkillLinkGeneration.current;
    sharedSkillLinkInFlight.current = pendingSharedSkillId;
    const settle = (open: () => void): void => {
      if (cancelled) return;
      sharedSkillLinkInFlight.current = null;
      if (generation === sharedSkillLinkGeneration.current) {
        closePageOwnedDialogs();
        open();
      }
      useNavigationStore.getState().consumeSkillViewer();
    };
    void window.skills.getShared(pendingSharedSkillId).then(
      (detail) =>
        settle((): void => {
          setLinkedSharedSkill(detail);
          setSelectedEntryId(`skill:shared:${detail.id}`);
        }),
      (error: unknown) =>
        settle((): void =>
          setSourceNavigationError(resolveSharedResourceErrorMessage(error)),
        ),
    );
    return (): void => {
      cancelled = true;
    };
  }, [closePageOwnedDialogs, pendingSharedSkillId]);
  useEffect(
    () => (): void => {
      const inFlight = sharedSkillLinkInFlight.current;
      const pending = useNavigationStore.getState().pendingSkillViewer;
      if (
        inFlight !== null &&
        pending &&
        'kind' in pending &&
        pending.kind === 'shared' &&
        pending.skillId === inFlight
      )
        useNavigationStore.getState().consumeSkillViewer();
    },
    [],
  );
  useEffect(() => {
    if (
      !pendingSkillViewer ||
      ('kind' in pendingSkillViewer && pendingSkillViewer.kind === 'shared')
    )
      return;
    closePageOwnedDialogs();
    openInstalledSkillDetail({
      sourceId: pendingSkillViewer.sourceId,
      name: pendingSkillViewer.skillName,
      ...(pendingSkillViewer.filePath
        ? { filePath: pendingSkillViewer.filePath }
        : {}),
    });
    useNavigationStore.getState().consumeSkillViewer();
  }, [closePageOwnedDialogs, openInstalledSkillDetail, pendingSkillViewer]);
  const selectEntry = useCallback(
    (selected: UnifiedPluginEntry, fromInstalled: boolean): void => {
      // A bundled skill has no detail of its own; it opens its plugin, and
      // does nothing once that plugin is gone from the list (CAN-4844).
      const entry =
        selected.ref.type === 'plugin-skill'
          ? entries.find(
              (candidate) => candidate.id === selected.bundledBy?.entryId,
            )
          : selected;
      if (entry === undefined) return;
      // The user's own choice outranks a shared-skill link still being read.
      sharedSkillLinkGeneration.current += 1;
      if (entry.ref.type === 'curated-pipeline') {
        const key = entry.ref.key;
        const row = capabilityInventory.curated?.rows.find(
          (row) => row.key === key,
        );
        if (row) capabilityInventory.curated?.onSelect(row);
        return;
      }
      setEntryDetailIntent('view');
      if (entryUsesDetailPage(entry, servers)) {
        captureDetailReturnScrollTop();
        // The Installed section lists only installed content, so a detail it
        // opens keeps the Installed breadcrumb level just like the strip.
        setEntryDetailFromInstalled(fromInstalled || installedExpanded);
        setEntryDetailBrowseReturn(currentDetailReturnRef.current);
      }
      setSelectedEntryId(entry.id);
    },
    [
      captureDetailReturnScrollTop,
      capabilityInventory.curated,
      entries,
      installedExpanded,
      servers,
    ],
  );
  const handleSelectEntry = useCallback(
    (entry: UnifiedPluginEntry): void => selectEntry(entry, false),
    [selectEntry],
  );
  const refreshCollectionResources = useCallback(async (): Promise<void> => {
    await Promise.all([
      refreshCollectionList(),
      refreshCollectionShares(),
      refreshSkills(),
      reloadMarketplaces(),
      refreshServers(),
    ]);
  }, [
    refreshCollectionList,
    refreshCollectionShares,
    refreshSkills,
    reloadMarketplaces,
    refreshServers,
  ]);
  const handleDuplicateCollection = useCallback(
    async (entry: UnifiedPluginEntry): Promise<void> => {
      if (entry.ref.type !== 'local-collection') return;
      const context = collectionScope;
      const key = `${context.key}/${entry.id}/duplicate`;
      if (
        collectionMutations.current.has(key) ||
        collectionPending.current === context
      )
        return;
      if (collectionCopyReconciliation.current.has(key)) {
        setCollectionActionError(
          'The copy outcome is still unknown. Check the collection list on your desktop before creating another copy.',
        );
        return;
      }
      collectionMutations.current.add(key);
      collectionPending.current = context;
      setPendingCollectionScope(context);
      setCollectionActionError('');
      try {
        const copy = await window.collections.duplicateCollection({
          collectionId: entry.ref.collectionId,
        });
        if (!isLocalCollectionConfig(copy) || !copy.revision)
          throw new Error('The desktop returned an incomplete copy response.');
        if (currentCollectionContext.current !== context) return;
        // Creation is already committed. A failed refresh must never create again.
        try {
          await refreshCollectionList();
        } catch {
          if (currentCollectionContext.current === context)
            setCollectionActionError(
              'Collection copied, but the list could not refresh.',
            );
        }
        if (currentCollectionContext.current === context)
          setCollectionEditor({ id: copy.id, context: collectionContextKey });
      } catch (error) {
        // An IPC rejection cannot establish whether the non-idempotent create
        // committed. Inventory reads alone cannot identify that outcome.
        collectionCopyReconciliation.current.add(key);
        if (currentCollectionContext.current !== context) return;
        const message =
          error instanceof Error
            ? error.message
            : 'Could not copy the collection.';
        try {
          await refreshCollectionList();
          if (currentCollectionContext.current === context)
            setCollectionActionError(
              `${message} The copy outcome is still unknown. Check the refreshed list on your desktop before creating another copy.`,
            );
        } catch {
          collectionCopyReconciliation.current.add(key);
          if (currentCollectionContext.current === context)
            setCollectionActionError(
              `${message} Could not reconcile the collection list. Refresh before copying again.`,
            );
        }
      } finally {
        collectionMutations.current.delete(key);
        if (collectionPending.current === context)
          collectionPending.current = null;
        setPendingCollectionScope((pending) =>
          pending === context ? null : pending,
        );
      }
    },
    [collectionContextKey, collectionScope, refreshCollectionList],
  );
  const editCollection = useCallback(
    (entry: UnifiedPluginEntry): void => {
      if (entry.ref.type === 'local-collection')
        setCollectionEditor({
          id: entry.ref.collectionId,
          context: collectionContextKey,
        });
    },
    [collectionContextKey],
  );
  const duplicateCollection = useCallback(
    (entry: UnifiedPluginEntry): void => {
      void handleDuplicateCollection(entry);
    },
    [handleDuplicateCollection],
  );
  // A custom skill's row menu Edit opens its edit page (CAN-3485, CAN-4844).
  const handleEditEntry = useCallback(
    (entry: UnifiedPluginEntry): void => {
      if (entry.ref.type === 'skill')
        openInstalledSkillDetail({
          sourceId: entry.ref.sourceId,
          name: entry.ref.skillName,
          edit: true,
        });
    },
    [openInstalledSkillDetail],
  );
  const automationActivities = capabilityInventory.automationActivities;
  const openAutomationUpdate = automationUpdate.openUpdate;
  const handleUpdateEntry = useCallback(
    async (entry: UnifiedPluginEntry): Promise<void> => {
      if (entry.ref.type === 'skill') {
        await updateSkillEntry(entry);
        return;
      }
      if (entry.ref.type === 'local-collection') {
        const context = collectionScope;
        setCollectionActionError('');
        try {
          const local = await window.collections.loadCollection(
            entry.ref.collectionId,
          );
          if (currentCollectionContext.current !== context) return;
          if (!local?.revision)
            throw new Error(
              'Could not read the current collection. Refresh and try again.',
            );
          const result = await window.collections.applySharedUpdate({
            collectionId: local.id,
            expectedRevision: local.revision,
          });
          if (currentCollectionContext.current !== context) return;
          const limits = [
            result.preservedLegacyMcpRefs
              ? 'Existing MCP server references were kept because this share does not describe them.'
              : '',
            result.uninstalledResourceLabels?.length
              ? `These package resources were not installed: ${result.uninstalledResourceLabels.join(', ')}.`
              : '',
            result.keptLocalFiles?.length
              ? `Existing local files were kept: ${result.keptLocalFiles.join(', ')}.`
              : '',
          ]
            .filter(Boolean)
            .join(' ');
          setCollectionActionError(limits);
        } catch (error) {
          if (currentCollectionContext.current === context)
            setCollectionActionError(
              `${error instanceof Error ? error.message : 'Could not update the collection.'} Some resource imports may have completed. Refresh before retrying.`,
            );
        } finally {
          if (currentCollectionContext.current === context) {
            try {
              await refreshCollectionResources();
            } catch {
              if (currentCollectionContext.current === context)
                setCollectionActionError((message) =>
                  `${message} Could not refresh the collection inventory.`.trim(),
                );
            }
          }
        }
        return;
      }
      if (entry.ref.type === 'pipeline') {
        // TODO(follow-up under CAN-4837, "Apply team-shared pipeline updates
        // from Customize Workflows"): the existing pipeline APIs can read install
        // provenance and the current team share, but none can re-import that
        // share over its installed local copy. Keep this branch explicit so a
        // pipeline update never degrades into opening details and pretending
        // the update was applied.
        throw new Error('Pipeline updates are not available yet.');
      }
      if (entry.ref.type !== 'automation') return;
      // The install wizard applies the update in place; a load failure
      // rejects into the Updates failure report.
      const activityId = entry.ref.activityId;
      const activity = automationActivities.find(
        (candidate) => candidate.id === activityId,
      );
      if (activity) await openAutomationUpdate(activity);
      else handleSelectEntry(entry);
    },
    [
      automationActivities,
      handleSelectEntry,
      openAutomationUpdate,
      updateSkillEntry,
      collectionScope,
      refreshCollectionResources,
    ],
  );
  // A requirement chip on a multi-connection plugin card opens that
  // integration's card (REG-3033).
  const handleOpenEntryId = useCallback(
    (entryId: string): void => {
      const target = entries.find((entry) => entry.id === entryId);
      if (target) selectEntry(target, false);
    },
    [entries, selectEntry],
  );
  // An item created from Add custom opens its detail, as its row would.
  const openCreatedCustomItem = useOpenCreatedCustomItem(
    entries,
    handleSelectEntry,
  );
  // A source plugin opens the catalog entry the inventory built for it; a
  // plugin the catalog does not list stays non-interactive.
  const sourcePluginEntry = useCallback(
    (sourceId: string, pluginKey: string): UnifiedPluginEntry | undefined => {
      const source = marketplaceSources.sources?.find(
        (entry) => entry.id === sourceId,
      );
      const entryId =
        source?.kind === 'curated'
          ? `curated:${pluginKey}`
          : `mkt:${sourceId}/${pluginKey}`;
      return entries.find((entry) => entry.id === entryId);
    },
    [entries, marketplaceSources.sources],
  );

  useEffect(() => {
    if (
      !pendingSourcePlugin ||
      pendingSourcePlugin.generation !== sourceRequestGeneration.current ||
      !showingSources ||
      marketplaceSources.loading ||
      marketplaceSources.sources === null ||
      loading ||
      capabilityInventory.loading
    )
      return;
    const source = marketplaceSources.sources.find(
      (entry) => entry.id === pendingSourcePlugin.sourceId,
    );
    if (!source) {
      setPendingSourcePlugin(null);
      return;
    }
    const plugin = source.plugins.find(
      (entry) =>
        entry.key.toLowerCase() === pendingSourcePlugin.pluginKey.toLowerCase(),
    );
    const entry = plugin ? sourcePluginEntry(source.id, plugin.key) : undefined;
    if (entry) handleSelectEntry(entry);
    else
      setSourceNavigationError(
        'This plugin is no longer available. Choose another plugin or return to Marketplaces.',
      );
    setPendingSourcePlugin(null);
  }, [
    pendingSourcePlugin,
    showingSources,
    marketplaceSources.loading,
    marketplaceSources.sources,
    loading,
    capabilityInventory.loading,
    sourcePluginEntry,
    handleSelectEntry,
  ]);

  // Only the shared lists, so the card handler is not rebuilt on every
  // unrelated inventory change.
  const {
    sharedSkills,
    sharedCollections,
    sharedAgents,
    sharedPlugins,
    sharedBlueprints,
  } = capabilityInventory;
  const sharedInstallInventory = useMemo(
    () => ({
      sharedSkills,
      sharedCollections,
      sharedAgents,
      sharedPlugins,
      sharedBlueprints,
      sharedAutomations: capabilityInventory.sharedAutomations,
    }),
    [
      sharedSkills,
      sharedCollections,
      sharedAgents,
      sharedPlugins,
      sharedBlueprints,
      capabilityInventory.sharedAutomations,
    ],
  );
  const handleAddEntry = useCallback(
    (entry: UnifiedPluginEntry): void => {
      // A shared resource's Add opens the install review straight from the
      // card (CAN-3710); the detail page is not visited first. A private
      // share has nothing to install from here, so it opens its detail.
      const installLink = marketplaceEntryInstallLink(
        entry.ref,
        sharedInstallInventory,
      );
      if (installLink !== undefined) {
        if (installLink === null) {
          handleSelectEntry(entry);
          return;
        }
        useNavigationStore.getState().openShareInstall(installLink, 'in-app');
        return;
      }
      const opensAddSurface =
        entry.ref.type === 'curated-mcp' ||
        entry.ref.type === 'curated-plugin' ||
        entry.ref.type === 'marketplace-plugin';
      if (!opensAddSurface) {
        handleSelectEntry(entry);
        return;
      }
      sharedSkillLinkGeneration.current += 1;
      setEntryDetailIntent('add');
      if (entryUsesDetailPage(entry, servers)) {
        captureDetailReturnScrollTop();
        setEntryDetailFromInstalled(installedExpanded);
        setEntryDetailBrowseReturn(currentDetailReturnRef.current);
      }
      setSelectedEntryId(entry.id);
    },
    [
      captureDetailReturnScrollTop,
      handleSelectEntry,
      sharedInstallInventory,
      installedExpanded,
      servers,
    ],
  );

  // Resolved against the full projection, not `visibleEntries`: a detail
  // surface must survive the user switching away from the MCP servers tab.
  const foundSelectedEntry = useMemo(() => {
    const entry = entries.find((item) => item.id === selectedEntryId);
    if (entry) return entry;
    // Dedupe affects browsing only. Direct shared-agent links still resolve
    // from the unfiltered shared inventory and retain their install review.
    if (
      !sharedCustomAgentsEnabled ||
      !selectedEntryId?.startsWith('agent:shared:')
    )
      return null;
    return (
      buildUnifiedPluginEntries({
        curatedPlugins: [],
        marketplaces: [],
        installedSkills: [],
        mcpServers: [],
        mcpStatuses: [],
        curatedMcpServers: [],
        providerConnectors: [],
        sharedAgents: capabilityInventory.sharedAgents,
      }).find((item) => item.id === selectedEntryId) ?? null
    );
  }, [
    entries,
    selectedEntryId,
    sharedCustomAgentsEnabled,
    capabilityInventory.sharedAgents,
  ]);
  // Shared skills and collections are filtered server-side. Retain the last
  // resolved entry so a rename that stops matching the query does not close
  // its open detail page when the refreshed inventory omits that row.
  useEffect(() => {
    if (selectedEntryId === null) {
      setRetainedDetailEntry(null);
    } else if (foundSelectedEntry) {
      setRetainedDetailEntry(foundSelectedEntry);
    }
  }, [foundSelectedEntry, selectedEntryId]);
  useEffect(() => {
    if (
      showingSources &&
      selectedSourceId &&
      marketplaceSources.sources !== null &&
      !selectedSource
    ) {
      setSelectedEntryId(null);
      setRetainedDetailEntry(null);
    }
  }, [
    marketplaceSources.sources,
    selectedSource,
    selectedSourceId,
    showingSources,
  ]);
  const selectedEntry = useMemo(() => {
    const base =
      foundSelectedEntry ??
      (retainedDetailEntry?.id === selectedEntryId
        ? retainedDetailEntry
        : null) ??
      (installedSkillDetailEntry?.id === selectedEntryId
        ? installedSkillDetailEntry
        : null) ??
      (linkedSharedSkillEntry?.id === selectedEntryId
        ? linkedSharedSkillEntry
        : null) ??
      // A shared automation the browse inventory does not list, such as the
      // user's own public-link-only share outside "Shared by me", still opens
      // by id: its detail loads the share and reports the real name.
      (selectedEntryId === null
        ? null
        : (pendingSharedAutomationEntry(selectedEntryId) ??
          (sharedCustomAgentsEnabled
            ? pendingLocalAgentEntry(selectedEntryId)
            : null)));
    if (!base) return null;
    return detailNameOverride &&
      detailNameOverride.id === base.id &&
      detailNameOverride.name !== base.name
      ? { ...base, name: detailNameOverride.name }
      : base;
  }, [
    detailNameOverride,
    foundSelectedEntry,
    retainedDetailEntry,
    installedSkillDetailEntry,
    linkedSharedSkillEntry,
    selectedEntryId,
    sharedCustomAgentsEnabled,
  ]);
  const selectedAccountRow = useMemo(
    () => (selectedEntry ? accountRowOf(selectedEntry, servers) : undefined),
    [selectedEntry, servers],
  );
  const accountRequests = useAccountMcpActionRequests({
    clearSurfaceError: (): void => setMcpRowError(''),
    servers,
    curatedEntries: curatedMcpServers,
    statuses: mcpStatuses,
    loading: mcpLoading,
    accountConnectionsAvailable,
    accountConnectionsUnavailableReason,
    refresh: refreshServers,
    mcpSurfaceInForeground: customizeMcpSurfaceInForeground({
      activeTab: kindFilter,
      selectedEntryId,
      selectedEntryType: selectedEntry?.ref.type,
    }),
    detailRowId: selectedAccountRow
      ? (selectedAccountRow.accountConnectionId ?? selectedAccountRow.id)
      : null,
    openDeviceEditor: (serverId): void => {
      setMcpEditAccount(null);
      setMcpEditServerId(serverId);
    },
    openCloudEditor: (connection): void => {
      setMcpEditServerId(null);
      setMcpEditAccount(connection);
    },
  });

  const { connectRow: connectAccountRow, pendingOf: accountPendingOf } =
    accountRequests;
  const mcpBannerError = mcpRowError || accountRequests.error;
  // A cloud refusal's code stays out of the sentence but at hand.
  const mcpBannerErrorCode =
    mcpBannerError !== '' && mcpBannerError === accountRequests.error
      ? accountRequests.errorCode
      : null;

  const mcpRowActions = useMemo((): CustomizeMcpRowActions => {
    const deviceTarget = (
      entry: UnifiedPluginEntry,
    ): { serverId: string; configId: string | undefined } | null => {
      if (mcpHasMultipleTargets(entry)) return null;
      const [only, ...others] = entry.integration?.connections ?? [];
      if (only) {
        return others.length === 0 && only.binding === 'device'
          ? { serverId: only.serverId, configId: only.configId }
          : null;
      }
      if (entry.ref.type !== 'local-mcp' || entry.placement !== 'desktop')
        return null;
      const { serverId } = entry.ref;
      const configs = servers.find((row) => row.id === serverId)?.configs;
      const [onlyConfig, ...otherConfigs] = configs ?? [];
      return onlyConfig && otherConfigs.length === 0
        ? { serverId, configId: onlyConfig.id }
        : null;
    };
    const runTest = async (target: {
      serverId: string;
      configId: string | undefined;
    }): Promise<void> => {
      setMcpRowError('');
      const result = await window.mcpServers.testConnection(
        target.serverId,
        target.configId,
      );
      await refreshMcpStatuses();
      if (!result.success) throw new Error(result.error ?? result.message);
    };
    return {
      formatTimestamp: formatRelativeTime,
      // The shared row shows a thrown message verbatim.
      onError: (message) => setMcpRowError(extractIpcErrorMessage(message)),
      test: (entry) => {
        if ((entry.connection ?? entry.aggregateConnection)?.provider)
          return { available: false, reason: MCP_MANAGEMENT_REASONS.provider };
        if ((entry.connection ?? entry.aggregateConnection)?.disabled)
          return {
            available: false,
            reason: 'Enable this server before testing its connection.',
          };
        if (mcpHasMultipleTargets(entry))
          return {
            available: true,
            run: () => Promise.resolve(handleSelectEntry(entry)),
          };
        const target = deviceTarget(entry);
        return target
          ? { available: true, run: () => runTest(target) }
          : { available: false, reason: MCP_MANAGEMENT_REASONS.cloudTest };
      },
      pending: (entry) => {
        const target = deviceTarget(entry);
        if (!target) {
          const accountRow = accountRowOf(entry, servers);
          const pending = accountRow && accountPendingOf(accountRow);
          return pending ? { onCancel: pending.cancel } : undefined;
        }
        if (rowMcp.connectingKey === null) return undefined;
        const active = rowMcp.servers.find(
          (server) =>
            server.key === rowMcp.connectingKey &&
            server.serverId === target.serverId &&
            server.configId === target.configId,
        );
        return active
          ? {
              authorizationUrl: rowMcp.signInUrl,
              onCancel: () => rowMcp.cancelConnect(),
            }
          : undefined;
      },
      connect: (entry) => {
        if (rowMcp.connectingKey !== null)
          return {
            available: false,
            reason: 'Finish the current sign-in first.',
          };
        const target = deviceTarget(entry);
        if (!target) {
          const accountRow = accountRowOf(entry, servers);
          const connection = accountRow?.accountConnection;
          // A custom connection has no catalog entry for Add to open, so its
          // Connect and Reconnect start here. Curated rows keep their detail.
          if (accountRow && connection?.kind === 'CUSTOM') {
            if (accountPendingOf(accountRow))
              return {
                available: false,
                reason: 'Finish the current sign-in first.',
              };
            return {
              available: true,
              run: () => {
                setMcpRowError('');
                const started = connectAccountRow(accountRow);
                if (started.kind === 'unsupported')
                  throw new Error(started.message);
                // Blocked starts nothing: the detail says what it waits for.
                if (started.kind === 'blocked') handleSelectEntry(entry);
              },
            };
          }
          return { available: true, run: () => handleAddEntry(entry) };
        }
        return {
          available: true,
          run: async () => {
            setMcpRowError('');
            const server = rowMcp.servers.find(
              (candidate) =>
                candidate.serverId === target.serverId &&
                candidate.configId === target.configId,
            );
            if (!server) throw new Error(MCP_MANAGEMENT_REASONS.noTarget);
            const connection = entry.connection ?? entry.aggregateConnection;
            const signInRequired =
              connection?.status === 'auth_required' ||
              connection?.signIn === 'connect' ||
              connection?.signIn === 'reconnect';
            if (
              (server.canConnect || signInRequired) &&
              !(await rowMcp.connect(server, { signInRequired }))
            )
              return;
            await runTest(target);
          },
        };
      },
      edit: (entry) => {
        if (!mcpHasMultipleTargets(entry)) {
          const connectionId =
            entry.integration?.connections[0]?.accountConnectionId;
          const connection = servers.find((server) =>
            connectionId !== undefined
              ? server.accountConnection?.id === connectionId
              : entry.ref.type === 'local-mcp' &&
                server.id === entry.ref.serverId &&
                server.accountConnection?.configId === entry.ref.configId,
          )?.accountConnection;
          if (connection)
            return {
              available: true,
              run: (): void => {
                accountRequests.detailSignIn.clearError(
                  accountMcpConnectionKey(connection),
                );
                setMcpEditAccount(connection);
              },
            };
        }
        const target = deviceTarget(entry);
        return target
          ? {
              available: true,
              run: (): void => {
                accountRequests.detailSignIn.clearError(target.serverId);
                setMcpEditServerId(target.serverId);
              },
            }
          : {
              available: true,
              run: () => handleSelectEntry(entry),
            };
      },
    };
  }, [
    accountPendingOf,
    accountRequests.detailSignIn,
    connectAccountRow,
    handleAddEntry,
    handleSelectEntry,
    refreshMcpStatuses,
    rowMcp,
    servers,
  ]);

  useEffect(() => {
    setDetailNameOverride(null);
  }, [selectedEntryId]);
  const selectedEntryUsesDetailPage = useMemo(() => {
    if (!selectedEntry) return false;
    return entryUsesDetailPage(selectedEntry, servers);
  }, [selectedEntry, servers]);
  const selectedDetailPageEntryId =
    selectedEntryUsesDetailPage && selectedEntry ? selectedEntry.id : null;
  const skillEditorOpen =
    selectedDetailPageEntryId !== null &&
    skillEditorEntryId === selectedDetailPageEntryId;

  useEffect(() => {
    const previousId = detailPageEntryIdRef.current;
    detailPageEntryIdRef.current = selectedDetailPageEntryId;
    if (
      selectedDetailPageEntryId !== null &&
      previousId !== selectedDetailPageEntryId
    ) {
      // Entering a detail page or hopping between related details: both start
      // reading from the top.
      if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
    } else if (previousId !== null && selectedDetailPageEntryId === null) {
      if (pageScrollRef.current) {
        pageScrollRef.current.scrollTop = detailReturnScrollTopRef.current;
      }
    }
  }, [selectedDetailPageEntryId]);

  useEffect(() => {
    if (
      pendingScrollTop.current === null ||
      loading ||
      skillsLoading ||
      capabilityInventory.loading ||
      marketplaceSources.loading
    )
      return;
    if (pageScrollRef.current)
      pageScrollRef.current.scrollTop = pendingScrollTop.current;
    pendingScrollTop.current = null;
  }, [
    selectedDetailPageEntryId,
    selectedSourceId,
    loading,
    skillsLoading,
    capabilityInventory.loading,
    marketplaceSources.loading,
  ]);

  const closeEntryDetail = useCallback((): void => {
    sharedSkillLinkGeneration.current += 1;
    setPendingAgentEditId(null);
    setSelectedEntryId(null);
    setEntryDetailIntent('view');
    setEntryDetailStack([]);
    setEntryDetailPipelineReturn(null);
    setEntryDetailFromInstalled(false);
    setEntryDetailBrowseReturn(null);
    setSkillDetailFilePath(null);
    setInstalledSkillDetailEntry(null);
    setLinkedSharedSkill(null);
    setSkillEditorEntryId(null);
  }, []);
  useEffect(() => {
    if (!selectedSource || !selectedEntry) return;
    const ref = selectedEntry.ref;
    const key =
      ref.type === 'marketplace-plugin' &&
      ref.marketplaceId === selectedSource.id
        ? ref.pluginName
        : ref.type === 'curated-plugin' && selectedSource.kind === 'curated'
          ? ref.key
          : null;
    if (
      key !== null &&
      !selectedSource.plugins.some(
        (plugin) => plugin.key.toLowerCase() === key.toLowerCase(),
      )
    ) {
      closeEntryDetail();
      setSourceNavigationError(
        'This plugin is no longer available. Choose another plugin or return to Marketplaces.',
      );
    }
  }, [selectedSource, selectedEntry, closeEntryDetail]);

  const navigateBackFromEntryDetail = useCallback((): void => {
    const managementReturn = entryDetailBrowseReturn;
    closeEntryDetail();
    if (managementReturn !== null) applyBrowseDestination(managementReturn);
  }, [applyBrowseDestination, closeEntryDetail, entryDetailBrowseReturn]);

  // --- Local agents (CAN-4266) ---
  const {
    localAgentDefinitions,
    localAgentsLoaded,
    localAgentsLoading,
    localAgentsError,
    refreshLocalAgents,
  } = capabilityInventory;
  const saveAgent = useAgentsStore((state) => state.save);
  const removeAgent = useAgentsStore((state) => state.remove);
  const agentDialogTarget =
    agentDialog && agentDialog.mode !== 'create'
      ? (localAgentDefinitions.find(
          (agent) => agent.id === agentDialog.agentId,
        ) ?? null)
      : null;
  // A pending editor asks for a fresh agent list: the cached one may predate
  // an agent created elsewhere while this page held no subscription.
  const [pendingAgentEditRefreshed, setPendingAgentEditRefreshed] =
    useState(false);
  useEffect(() => {
    setPendingAgentEditRefreshed(false);
    if (pendingAgentEditId === null) return undefined;
    let current = true;
    void refreshLocalAgents().finally(() => {
      if (current) setPendingAgentEditRefreshed(true);
    });
    return (): void => {
      current = false;
    };
  }, [pendingAgentEditId, refreshLocalAgents]);
  // A pending editor opens once that fresh load settled without an error and
  // the inventory resolves it, exactly once: the editor seeds its fields when it opens, so
  // a cached definition could save stale values over a newer one. A later
  // refresh never reopens a dismissed editor, and only an inventory that
  // settled after the fresh load leaves its detail to report it missing.
  useEffect(() => {
    if (pendingAgentEditId === null || !pendingAgentEditRefreshed) return;
    // A failed read keeps the cached list, which may predate the agent; the
    // request waits for a successful one (the detail offers Try again).
    if (localAgentsLoading || localAgentsError) return;
    if (
      localAgentDefinitions.some((agent) => agent.id === pendingAgentEditId)
    ) {
      setAgentDialog({ mode: 'edit', agentId: pendingAgentEditId });
      setPendingAgentEditId(null);
    } else if (localAgentsLoaded) {
      setPendingAgentEditId(null);
    }
  }, [
    localAgentDefinitions,
    localAgentsLoaded,
    localAgentsLoading,
    localAgentsError,
    pendingAgentEditId,
    pendingAgentEditRefreshed,
  ]);
  // An agent deleted elsewhere takes its editor or confirmation with it.
  useEffect(() => {
    if (
      agentDialog &&
      agentDialog.mode !== 'create' &&
      localAgentsLoaded &&
      !localAgentsLoading &&
      !localAgentsError &&
      agentDialogTarget === null
    ) {
      setAgentDialog(null);
    }
  }, [
    agentDialog,
    agentDialogTarget,
    localAgentsLoaded,
    localAgentsLoading,
    localAgentsError,
  ]);
  const [agentDeletePending, setAgentDeletePending] = useState(false);
  const [agentDeleteError, setAgentDeleteError] = useState<string | null>(null);
  const agentDeleteInFlightRef = useRef(false);
  const selectedEntryForAgentDeleteRef = useRef<string | null>(null);
  useEffect(() => {
    selectedEntryForAgentDeleteRef.current = selectedLocalAgentId;
  }, [selectedLocalAgentId]);
  const openAgentDialog = useCallback((dialog: AgentDialog): void => {
    setAgentDeleteError(null);
    setAgentDialog(dialog);
  }, []);
  const handleSaveAgent = useCallback(
    async (request: SaveAgentModelRequest): Promise<void> => {
      const saved = await saveAgent(request);
      if (request.id === undefined)
        openCreatedCustomItem({ kind: 'agent', agentId: saved.id });
    },
    [openCreatedCustomItem, saveAgent],
  );
  const handleConfirmDeleteAgent = useCallback(
    (agentId: string): void => {
      if (agentDeleteInFlightRef.current) return;
      agentDeleteInFlightRef.current = true;
      setAgentDeletePending(true);
      setAgentDeleteError(null);
      void (async (): Promise<void> => {
        try {
          await removeAgent(agentId);
          setAgentDialog(null);
          // The detail closes only once the agent is really gone.
          if (selectedEntryForAgentDeleteRef.current === agentId) {
            navigateBackFromEntryDetail();
          }
        } catch (error: unknown) {
          setAgentDeleteError(extractIpcErrorMessage(error));
        } finally {
          agentDeleteInFlightRef.current = false;
          setAgentDeletePending(false);
        }
      })();
    },
    [navigateBackFromEntryDetail, removeAgent],
  );
  // A Personal/organization switch takes the previous context's dialogs,
  // including any open Share dialog, pending editor and open agent detail
  // with it.
  useWorkspaceContextReset((): void => {
    closePageOwnedDialogs();
    setSelectedSourceId(null);
    setInstalledStatusFilter(null);
    setInstalledExpanded(false);
    setAgentDialog(null);
    setPendingAgentEditId(null);
    if (ownedShare.openKind !== null) ownedShare.close();
    if (selectedLocalAgentId !== null) closeEntryDetail();
  });
  // Switching agents off live hides every agent surface: dialogs close, a
  // pending editor is dropped, and an agent view returns to an allowed state.
  // Turning them back on replays nothing.
  const closeOwnedShare = ownedShare.close;
  const ownedShareKind = ownedShare.openKind;
  useEffect(() => {
    if (sharedCustomAgentsEnabled) return;
    setAgentDialog(null);
    setPendingAgentEditId(null);
    if (ownedShareKind === 'agent') closeOwnedShare();
    if (kindFilter === 'agent') setKindFilter(null);
    if (selectedEntry?.kind === 'agent') closeEntryDetail();
  }, [
    closeEntryDetail,
    closeOwnedShare,
    kindFilter,
    ownedShareKind,
    selectedEntry?.kind,
    sharedCustomAgentsEnabled,
  ]);

  // A Cloud sign-out or account switch invalidates shared rows outright; a
  // retained shared detail must not survive it the way it survives a
  // same-account filtered refresh (CAN-2779 review round 6). The latest
  // selected entry rides in a ref so the listener registers once.
  const selectedEntryForAccountRef = useRef<UnifiedPluginEntry | null>(null);
  useEffect(() => {
    selectedEntryForAccountRef.current = selectedEntry;
  }, [selectedEntry]);
  useEffect(() => {
    const handleAccountChanged = (): void => {
      sharedSkillLinkGeneration.current += 1;
      setAddMarketplaceOpen(false);
      setPendingSourcePlugin(null);
      const current = selectedEntryForAccountRef.current;
      if (
        current &&
        (current.ref.type === 'shared-skill' ||
          current.ref.type === 'shared-collection' ||
          current.ref.type === 'shared-automation' ||
          current.ref.type === 'curated-automation' ||
          current.ref.type === 'shared-agent' ||
          current.ref.type === 'shared-plugin')
      ) {
        closeEntryDetail();
      }
      setRetainedDetailEntry(null);
      setLinkedSharedSkill(null);
      setDetailNameOverride(null);
    };
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      handleAccountChanged,
    );
    return (): void => {
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        handleAccountChanged,
      );
    };
  }, [closeEntryDetail]);

  // The curated automation catalog owns the one detail it has loaded. Keep
  // its selection on whichever curated automation is open, however the entry
  // was reached (a card, its Add, a deep link, or a related-item hop), and
  // release it when the detail closes.
  const selectedCuratedAutomationKey =
    selectedEntry?.ref.type === 'curated-automation'
      ? selectedEntry.ref.key
      : null;
  const {
    selectedKey: curatedAutomationSelectedKey,
    onSelectKey: selectCuratedAutomation,
    onClearDetail: clearCuratedAutomation,
  } = capabilityInventory.curatedAutomations;
  useEffect(() => {
    if (selectedCuratedAutomationKey === curatedAutomationSelectedKey) return;
    if (selectedCuratedAutomationKey === null) {
      clearCuratedAutomation();
    } else {
      selectCuratedAutomation(selectedCuratedAutomationKey);
    }
  }, [
    clearCuratedAutomation,
    curatedAutomationSelectedKey,
    selectCuratedAutomation,
    selectedCuratedAutomationKey,
  ]);

  const openAutomationInEditor = useCallback((activityId: string): void => {
    useNavigationStore.getState().openAutomationEdit({ activityId });
  }, []);

  // Escape leaves the detail sub-page only while nothing sits above it: the
  // shared overlay stack lets a dialog opened from inside the detail (add
  // flows, share modal) consume Escape first instead of unmounting the page.
  // It acts as Back, so a detail opened from an installed list returns there,
  // and a skill's edit page returns to the skill's detail (CAN-3485). As a
  // page layer it stays beneath a dialog that opened first, such as the
  // install review over a detail an install just landed on (CAN-3710).
  useOverlayEscape(
    selectedDetailPageEntryId !== null,
    (): void => {
      if (skillEditorOpen) {
        setSkillEditorEntryId(null);
        return;
      }
      navigateBackFromEntryDetail();
    },
    undefined,
    { layer: 'page' },
  );

  // One prop wiring for both presentations: the inline sub-page (shell-owned
  // branches) and the dialog fallback (skill/MCP-owned branches) must stay
  // behaviorally identical, so they render from the same closure.
  const renderEntryDetail = (
    detailEntry: UnifiedPluginEntry,
    presentation: 'modal' | 'page',
  ): JSX.Element => (
    <PluginEntryDetail
      key={`${detailEntry.id}:${entryDetailIntent}`}
      entry={detailEntry}
      onOpenMarketplaceSource={
        marketplaceSourcesAvailable
          ? (sourceId): void => {
              closeEntryDetail();
              setKindFilter('sources');
              openMarketplaceSource(sourceId);
            }
          : undefined
      }
      presentation={presentation}
      initialIntent={entryDetailIntent}
      mcpTarget={
        mcpNavigation?.entryId === selectedEntryId
          ? mcpNavigation.target
          : undefined
      }
      shareAction={marketplaceShareAction(
        entryShareStates.get(detailEntry.id),
        (): void => handleShareEntry(detailEntry),
      )}
      preferCatalogDetail={browseGroups.some(
        (group) =>
          group.id === 'suggested' &&
          group.entries.some((entry) => entry.id === detailEntry.id),
      )}
      marketplaces={marketplaces}
      mcpServers={servers}
      accountConnectionsAvailable={accountConnectionsAvailable}
      accountSignIn={accountRequests.detailSignIn}
      sharedCollectionEditAvailable={isFeatureSurfaceAvailable(
        capabilities,
        'marketplace-shared-collection-edit',
      )}
      curatedMcpServers={curatedMcpServers}
      localCollections={capabilityInventory.localCollections}
      sharedCollections={capabilityInventory.sharedCollections}
      sharedSkills={detailSharedSkills}
      pipelines={capabilityInventory.pipelines}
      automationActivities={capabilityInventory.automationActivities}
      curatedAutomations={capabilityInventory.curatedAutomations}
      onOpenAutomation={openAutomationInEditor}
      localAgents={localAgentDefinitions}
      localAgentsLoading={localAgentsLoading}
      localAgentsError={localAgentsError}
      onRetryLocalAgents={() => void refreshLocalAgents()}
      onEditLocalAgent={(agent): void =>
        openAgentDialog({ mode: 'edit', agentId: agent.id })
      }
      onDeleteLocalAgent={(agent): void =>
        openAgentDialog({ mode: 'delete', agentId: agent.id })
      }
      sharedAgents={capabilityInventory.sharedAgents}
      sharedPlugins={capabilityInventory.sharedPlugins}
      ownSharedPlugins={capabilityInventory.ownSharedPlugins}
      sharedBlueprints={capabilityInventory.sharedBlueprints}
      providerConnectors={providerConnectors ?? []}
      providerConnectorsLoading={providerConnectorsLoading}
      onProviderConnectorsChanged={refreshProviderConnectors}
      // A page leaves to where it was opened from (a delete, a related
      // navigation): the list, or the management section that opened it.
      onClose={
        presentation === 'page' ? navigateBackFromEntryDetail : closeEntryDetail
      }
      onOpenEntry={(requestedEntryId) => {
        const entryId = visibleEntryId(
          requestedEntryId,
          publisherSkills.skills,
        );
        // No-op while a detail page is already open; captures when a
        // dialog-owned detail hops to a page-owned related entry.
        captureDetailReturnScrollTop();
        setEntryDetailStack((prev) =>
          detailEntry.id === entryId ? prev : [...prev, detailEntry.id],
        );
        setSelectedEntryId(entryId);
        setEntryDetailIntent('view');
      }}
      onOpenPipeline={(target) => {
        const returnToEntryContext = {
          entryId: detailEntry.id,
          stack: entryDetailStack,
          ...(entryDetailPipelineReturn
            ? { pipelineReturn: entryDetailPipelineReturn }
            : {}),
          ...(entryDetailFromInstalled ? { fromInstalled: true } : {}),
          marketplace: entryDetailBrowseReturn ?? currentDetailReturn,
        };
        closeEntryDetail();
        useNavigationStore.getState().openPipelineEdit({
          ...target,
          returnToEntryContext,
        });
      }}
      returnToMarketplace={{
        query,
        tab: activeTypeTab,
        ...(category ? { category } : {}),
      }}
      onDisplayNameChange={(name): void => {
        const displayName = marketplaceTitleCase(name);
        // Bail out on identical content so repeated reports cannot feed a
        // render loop through a fresh object identity.
        setDetailNameOverride((prev) =>
          prev && prev.id === detailEntry.id && prev.name === displayName
            ? prev
            : { id: detailEntry.id, name: displayName },
        );
      }}
      // A page's breadcrumb sits right above the title, so it shows no Back
      // (CAN-4261): leaving goes through the breadcrumb, the app's history,
      // or `onClose` after a delete. A dialog keeps Back for its own stack.
      onNavigateBack={
        presentation === 'page'
          ? undefined
          : entryDetailStack.length > 0
            ? (): void => {
                const previous = entryDetailStack[entryDetailStack.length - 1];
                setEntryDetailStack((prev) => prev.slice(0, -1));
                setSelectedEntryId(previous);
              }
            : entryDetailPipelineReturn
              ? (): void => {
                  const target = entryDetailPipelineReturn;
                  closeEntryDetail();
                  useNavigationStore.getState().openPipelineEdit(target);
                }
              : undefined
      }
      onServersChanged={refreshServers}
      installedSkills={skills}
      initialSkillFilePath={
        skillDetailFilePath?.entryId === detailEntry.id
          ? skillDetailFilePath.filePath
          : undefined
      }
      skillEditing={skillEditorEntryId === detailEntry.id}
      onSkillEditingChange={(editing): void =>
        setSkillEditorEntryId(editing ? detailEntry.id : null)
      }
      onInstalledSkillRenamed={(skill): void => {
        // Follow the renamed skill in place, keeping the detail's Back and
        // breadcrumb context.
        const renamed = installedSkillEntry(skill.sourceId, skill.name);
        setInstalledSkillDetailEntry(renamed);
        setSelectedEntryId(renamed.id);
      }}
      onOpenAccountSettings={onOpenAccountSettings}
      onLocalCollectionsChanged={capabilityInventory.refreshLocalCollections}
      onSharedSkillsChanged={capabilityInventory.refreshSharedSkills}
      onSharedCollectionsChanged={capabilityInventory.refreshSharedCollections}
      onSharedResourceUnshared={capabilityInventory.removeSharedResource}
    />
  );

  const handleAddMarketplaceFromSkills = (repo: string): void => {
    setMarketplaceInitialRepo(repo);
    setAddMarketplaceOpen(true);
  };

  const showLoading =
    (loading ||
      skillsLoading ||
      mcpLoading ||
      capabilityInventory.loading ||
      publisherSkills.loading) &&
    entries.length === 0;
  // A failed local load is never shown as an empty inventory, and never
  // hides the shared agents that did load.
  const showLocalAgentsError =
    sharedCustomAgentsEnabled &&
    localAgentsError !== null &&
    (kindFilter === null || kindFilter === 'agent');
  const inventoryError = [
    skillsError ? `Skills: ${skillsError}` : null,
    mcpError ? `MCP servers: ${mcpError}` : null,
    capabilityInventory.error,
  ]
    .filter((message): message is string => message !== null)
    .join('\n');
  // Early access: every source that failed, in one notice. Sources that
  // failed for the same reason (usually the Cloud not being set up) are named
  // together rather than repeating the raw error once per source.
  const inventoryErrorSummary = summarizeLoadErrors([
    ...(skillsError ? [{ source: 'Skills', message: skillsError }] : []),
    ...(mcpError ? [{ source: 'MCP servers', message: mcpError }] : []),
    ...capabilityInventory.loadErrors,
  ]);

  // Entity-type level of a detail page's breadcrumb (CAN-3484). It leads to
  // the list of that type: the matching management section when the detail
  // was reached from an installed list, otherwise the Marketplace narrowed to
  // that type tab. The search and category are cleared so the crumb always
  // lands on the full list; Back is what returns to the search that led here.
  const selectedEntryKindFilter = selectedEntry
    ? marketplaceTabForKind(selectedEntry.kind)
    : null;
  const openInstalledFromDetail = (
    section: PluginsManagementSectionId,
  ): void => {
    closeEntryDetail();
    closeBrowseGroup();
    applyBrowseDestination(marketplaceManagementDestination(section));
  };
  const openEntryTypeFromDetail = (): void => {
    if (selectedEntryKindFilter === null) return;
    if (entryDetailFromInstalled) {
      closeEntryDetail();
      closeBrowseGroup();
      applyBrowseDestination({
        query: '',
        tab: selectedEntryKindFilter,
        focusSection: 'installed',
        installedExpanded: true,
      });
      return;
    }
    detailReturnScrollTopRef.current = 0;
    closeEntryDetail();
    closeBrowseGroup();
    setQuery('');
    setCategory(null);
    setKindFilter(
      selectedEntryKindFilter === 'all' ? null : selectedEntryKindFilter,
    );
  };
  // A requested curated pipeline preview (App Advisor) opens once the
  // catalog is available here.
  const pendingCuratedPipelinePreviewKey = useNavigationStore(
    (state) => state.pendingCuratedPipelinePreviewKey,
  );
  const selectCuratedPipeline = capabilityInventory.curated?.onSelectKey;
  // The request waits for the catalog, as it did on the Pipelines page.
  const { curatedReady } = capabilityInventory;
  useEffect(() => {
    if (
      !pendingCuratedPipelinePreviewKey ||
      !selectCuratedPipeline ||
      !curatedReady
    ) {
      return;
    }
    useNavigationStore.getState().consumeCuratedPipelinePreview();
    selectCuratedPipeline(pendingCuratedPipelinePreviewKey);
  }, [curatedReady, pendingCuratedPipelinePreviewKey, selectCuratedPipeline]);
  // A template keeps the launch on/off preference the Pipelines list's
  // template preview owned before Workflows › Library replaced that list.
  const [curatedTemplateToggling, setCuratedTemplateToggling] = useState(false);
  const selectedCuratedTemplateId =
    capabilityInventory.curated?.selectedKey !== null &&
    capabilityInventory.curated?.selectedKey !== undefined
      ? curatedPipelineId(capabilityInventory.curated.selectedKey)
      : null;
  const { disabledPipelineIds, setPipelineEnabled } = capabilityInventory;
  const curatedTemplateAvailability =
    selectedCuratedTemplateId !== null
      ? {
          enabled: !disabledPipelineIds.has(selectedCuratedTemplateId),
          pending: curatedTemplateToggling,
          onChange: (enabled: boolean): void => {
            setCuratedTemplateToggling(true);
            void setPipelineEnabled(selectedCuratedTemplateId, enabled).finally(
              () => setCuratedTemplateToggling(false),
            );
          },
        }
      : undefined;
  const curatedPipelineBreadcrumbTitle =
    capabilityInventory.curated?.selectedKey !== null &&
    capabilityInventory.curated?.selectedKey !== undefined
      ? (capabilityInventory.curated.detail?.name ??
        capabilityInventory.curated.rows.find(
          (row) => row.key === capabilityInventory.curated?.selectedKey,
        )?.name ??
        capabilityInventory.curated.selectedKey)
      : null;
  const openCuratedPipelineType = (): void => {
    capabilityInventory.curated?.onBack();
    closeBrowseGroup();
    setQuery('');
    setCategory(null);
    setKindFilter('workflow');
  };

  // A breadcrumb (entry detail or category page) needs the taller bar; the
  // root Marketplace keeps the shared 40px so its title stays on the
  // sidebar's Search row, which the Suggested E2E test pins.
  const titlebarHasBreadcrumb = Boolean(
    (selectedEntryUsesDetailPage && selectedEntry) ||
    sourceDetailOpen ||
    activeBrowseGroup,
  );

  return (
    <div
      ref={pageScrollRef}
      className="marketplace-page-scroll page-scroll-gutter h-full w-full overflow-y-auto"
      onScroll={(event): void => {
        pendingScrollTopRef.current = event.currentTarget.scrollTop;
        if (scrollWriteTimerRef.current !== null)
          clearTimeout(scrollWriteTimerRef.current);
        scrollWriteTimerRef.current = setTimeout(
          flushScrollTop,
          SCROLL_PRESENTATION_WRITE_DELAY_MS,
        );
      }}
      data-testid="page-plugins"
      data-tall-titlebar={titlebarHasBreadcrumb ? 'true' : undefined}
    >
      {/*
        Pinned: the page root is the only vertical scroller, so without the
        bar staying put the breadcrumb ("Customize > Productivity", or an
        entry's trail) scrolls away with the first screen of a long category
        or detail page and the way back disappears with it. The pinned bar is
        opaque and carries the bottom hairline that fades in once the page has
        scrolled; `z-20` keeps it above the list's own stacking.

        With a breadcrumb the bar is 46px rather than the shared 40px: the
        breadcrumb keeps the sidebar's 9px top inset so it stays on the
        sidebar controls' line, and gets the same 9px below it before the
        divider. The page content under it pulls up by the 6px difference so
        the category and detail headings sit exactly where the root
        Marketplace heading sits.
      */}
      <PageTitlebar
        pinned
        scrolled={pageScrolled}
        height={titlebarHasBreadcrumb ? 'breadcrumb' : 'bar'}
        className="z-20"
        testId="plugins-page-titlebar"
      >
        {selectedEntryUsesDetailPage && selectedEntry ? (
          <div
            className="flex h-full items-start pl-2.25 pt-2.25"
            data-testid="plugins-entry-detail-titlebar"
          >
            <div className="electron-no-drag min-w-0">
              <CustomizeBreadcrumbs
                testId="plugins-entry-detail-breadcrumbs"
                items={[
                  {
                    key: 'root',
                    label: CUSTOMIZE_LABEL,
                    testId: 'plugins-entry-detail-breadcrumb-root',
                    onSelect: (): void => {
                      if (activeBrowseGroup) {
                        detailReturnScrollTopRef.current =
                          browseScrollTopRef.current;
                      }
                      closeEntryDetail();
                      if (selectedSourceId) setSelectedSourceId(null);
                      closeBrowseGroup();
                    },
                  },
                  ...(selectedSourceId
                    ? [
                        {
                          key: 'sources',
                          label: 'Marketplaces',
                          testId: 'plugins-entry-detail-breadcrumb-sources',
                          onSelect: (): void => {
                            closeEntryDetail();
                            setSelectedSourceId(null);
                          },
                        },
                        {
                          key: 'source',
                          label: selectedSource?.name ?? 'Marketplace',
                          privateLabel: true,
                          testId: 'plugins-entry-detail-breadcrumb-source',
                          onSelect: closeEntryDetail,
                        },
                      ]
                    : []),
                  ...(entryDetailFromInstalled
                    ? [
                        {
                          key: 'installed',
                          label: 'Installed',
                          testId: 'plugins-entry-detail-breadcrumb-installed',
                          onSelect: (): void =>
                            openInstalledFromDetail('installed'),
                        },
                      ]
                    : activeBrowseGroup
                      ? [
                          {
                            key: 'category',
                            label: activeBrowseGroup.title,
                            testId: 'plugins-entry-detail-breadcrumb-category',
                            onSelect: closeEntryDetail,
                          },
                        ]
                      : []),
                  {
                    key: 'type',
                    label: marketplaceEntityTypeLabel(selectedEntry.kind),
                    testId: 'plugins-entry-detail-breadcrumb-type',
                    entryKind: selectedEntry.kind,
                    ...(selectedEntryKindFilter === null
                      ? {}
                      : { onSelect: openEntryTypeFromDetail }),
                  },
                  ...(skillEditorOpen
                    ? [
                        {
                          key: 'entry',
                          label: selectedEntry.name,
                          title: selectedEntry.name,
                          shrink: true,
                          testId: 'plugins-entry-detail-breadcrumb-entry',
                          onSelect: (): void => setSkillEditorEntryId(null),
                        },
                        {
                          key: 'edit',
                          label: 'Edit',
                          testId: 'plugins-entry-detail-breadcrumb-edit',
                        },
                      ]
                    : [
                        {
                          key: 'current',
                          label: selectedEntry.name,
                          testId: 'plugins-entry-detail-breadcrumb-current',
                        },
                      ]),
                ]}
              />
            </div>
          </div>
        ) : sourceDetailOpen ? (
          <div
            className="flex h-full items-start pl-2.25 pt-2.25"
            data-testid="marketplace-source-titlebar"
          >
            <div className="electron-no-drag min-w-0">
              <CustomizeBreadcrumbs
                testId="marketplace-source-breadcrumbs"
                items={[
                  {
                    key: 'root',
                    label: CUSTOMIZE_LABEL,
                    testId: 'marketplace-source-breadcrumb-root',
                    onSelect: (): void => {
                      setSelectedSourceId(null);
                      setKindFilter(null);
                    },
                  },
                  {
                    key: 'sources',
                    label: 'Marketplaces',
                    testId: 'marketplace-source-breadcrumb-sources',
                    onSelect: closeMarketplaceSource,
                  },
                  {
                    key: 'current',
                    label: selectedSource?.name ?? 'Marketplace',
                    testId: 'marketplace-source-breadcrumb-current',
                    privateLabel: true,
                  },
                ]}
              />
            </div>
          </div>
        ) : activeBrowseGroup ? (
          <div
            className="flex h-full items-start pl-2.25 pt-2.25"
            data-testid="plugins-category-titlebar"
          >
            <div className="electron-no-drag min-w-0">
              <CustomizeBreadcrumbs
                testId="plugins-category-breadcrumbs"
                items={[
                  {
                    key: 'root',
                    label: CUSTOMIZE_LABEL,
                    testId: 'plugins-category-breadcrumb-root',
                    onSelect: closeBrowseGroup,
                  },
                  {
                    key: 'current',
                    label: activeBrowseGroup.title,
                    testId: 'plugins-category-breadcrumb-current',
                  },
                ]}
              />
            </div>
          </div>
        ) : null}
      </PageTitlebar>
      <PageContent bottomInset="spacious">
        {selectedEntryUsesDetailPage && selectedEntry ? (
          <div data-testid="plugins-entry-detail-page" className="-mt-1.5">
            {renderEntryDetail(selectedEntry, 'page')}
          </div>
        ) : sourceDetailOpen && selectedSourceId !== null ? (
          <div data-testid="marketplace-source-page" className="-mt-1.5">
            <>
              <ErrorBanner error={sourceNavigationError} />
              <MarketplaceSourceDetail
                state={marketplaceSources}
                onBulkStateChange={setSourceBulkState}
                sourceId={selectedSourceId}
                onNavigateBack={closeMarketplaceSource}
                breadcrumbs={null}
                filters={sourcePluginFilters}
                onFiltersChange={setSourcePluginFilters}
                canOpenPlugin={(sourceId, pluginKey) =>
                  sourcePluginEntry(sourceId, pluginKey) !== undefined
                }
                onOpenPlugin={(sourceId, pluginKey) => {
                  const entry = sourcePluginEntry(sourceId, pluginKey);
                  if (entry) selectEntry(entry, false);
                }}
              />
            </>
          </div>
        ) : activeBrowseGroup ? (
          <div
            data-testid="plugins-category-page"
            className="flex flex-col -mt-1.5 gap-4"
          >
            <PageHeader
              title={activeBrowseGroup.title}
              description={`Browse all ${activeBrowseGroup.title.toLowerCase()} capabilities.`}
            />

            <PageSearchRow className="">
              <MarketplaceSearchField
                inputRef={categorySearchInputRef}
                value={categoryQuery}
                onChange={setCategoryQuery}
                onEscapeEmpty={closeBrowseGroup}
                ariaLabel={`Search ${activeBrowseGroup.title}`}
                clearAriaLabel={`Clear ${activeBrowseGroup.title} search`}
                testId="plugins-category-search"
                clearTestId="plugins-category-search-clear"
              />
            </PageSearchRow>

            <div>
              <PluginsDiscoveryList
                sections={[
                  {
                    id: 'category-page',
                    title: '',
                    entries: categoryPageEntries,
                  },
                ]}
                selectedEntryId={selectedEntryId}
                onSelectEntry={handleSelectEntry}
                onAddEntry={handleAddEntry}
                entryShareStates={entryShareStates}
                onShareEntry={handleShareEntry}
                onConnectEntry={handleAddEntry}
                onOpenEntryId={handleOpenEntryId}
                emptyMessage="Nothing matches your search."
              />
            </div>
          </div>
        ) : (
          <Stack gap="section">
            <div className="flex flex-col gap-0">
              <PageHeader
                title={CUSTOMIZE_LABEL}
                description={CUSTOMIZE_SECTION_SUBTITLE}
                actions={
                  <PluginsAddCustomMenu
                    onAddMarketplace={
                      canAddMarketplace
                        ? (): void => setAddMarketplaceOpen(true)
                        : undefined
                    }
                    onAddMcpServer={() => setMcpDialogOpen(true)}
                    onInstallSkillsFromGitHub={() => setAddSkillsOpen(true)}
                    onCreateCustomSkill={() => setCreateSkillOpen(true)}
                    onCreateCollection={
                      canCreateCollection ? openCollectionCreate : undefined
                    }
                    onCreateAgent={
                      sharedCustomAgentsEnabled
                        ? (): void => openAgentDialog({ mode: 'create' })
                        : undefined
                    }
                  />
                }
              />

              {(sourceNavigationError || installedStatusError) && (
                <Stack gap="tight">
                  <ErrorBanner className="" error={sourceNavigationError} />
                  <ErrorBanner className="" error={installedStatusError} />
                </Stack>
              )}
            </div>

            {/* Marketplace controls and results use the full shared page width,
            matching the other top-level utility pages. */}
            <div
              className={
                showingSources ? 'flex flex-col gap-6' : 'flex flex-col gap-0'
              }
            >
              <div className="flex flex-col gap-4">
                <MarketplaceTypeTabs
                  value={activeTypeTab}
                  tabs={typeTabs}
                  onChange={(tab) => {
                    setAddMarketplaceOpen(false);
                    setPendingSourcePlugin(null);
                    setSelectedSourceId(null);
                    setInstalledStatusFilter(null);
                    setInstalledExpanded(false);
                    setFocusSection(null);
                    setKindFilter(tab === 'all' ? null : tab);
                    setFocusSection(null);
                    setCategory(null);
                    setSelectedSourceId(null);
                  }}
                />

                {/* The search sits under the tabs it searches within, as the
              page's toolbar. */}
                {!showingSources && (
                  <CustomizeSearchRow
                    tab={activeTypeTab}
                    search={{
                      inputRef: searchInputRef,
                      value: query,
                      onChange: (value) => {
                        setAddMarketplaceOpen(false);
                        setPendingSourcePlugin(null);
                        setQuery(value);
                        setFocusSection(null);
                      },
                      onEscapeEmpty: () => setCategory(null),
                      ariaLabel: 'Search all capabilities',
                      clearAriaLabel: `Clear ${CUSTOMIZE_LABEL} search`,
                      testId: 'plugins-search',
                      clearTestId: 'plugins-search-clear',
                    }}
                    installedStatusFilter={
                      effectiveInstalledStatusFilter(
                        activeTypeTab,
                        installedStatusFilter ?? undefined,
                        CUSTOMIZE_SUPPORTED_UPDATE_KINDS,
                      ) ?? null
                    }
                    updateFilterAvailable={customizeTabOffersUpdateFilter(
                      activeTypeTab,
                      CUSTOMIZE_SUPPORTED_UPDATE_KINDS,
                    )}
                    onInstalledStatusFilterChange={(value) => {
                      setInstalledStatusFilter(value);
                      setFocusSection(null);
                    }}
                  />
                )}
              </div>

              {showingSources ? (
                <div data-testid="plugins-marketplace-sources">
                  <MarketplaceSourcesList
                    state={marketplaceSources}
                    onOpenSource={openMarketplaceSource}
                    removeConfirmation={marketplaceSourceRemoveConfirmation}
                    addAction={
                      canAddMarketplace ? (
                        <Button
                          size="compact"
                          data-testid="marketplace-sources-add"
                          onClick={() => setAddMarketplaceOpen(true)}
                        >
                          Add marketplace
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <Stack gap="group" data-testid="plugins-results-scroll">
                  <div className="flex flex-col gap-0">
                    <ErrorBanner error={error} />
                    {inventoryErrorSummary && (
                      <Notice
                        className=""
                        intent="destructive"
                        title={inventoryErrorSummary.title}
                        data-testid="plugins-load-error"
                      >
                        {inventoryErrorSummary.message}
                      </Notice>
                    )}
                  </div>
                  {publisherSkills.error ? (
                    <Notice
                      className=""
                      intent="destructive"
                      data-testid="publisher-skills-error"
                      actions={
                        <NoticeButton
                          onClick={() => void publisherSkills.refresh()}
                        >
                          Try again
                        </NoticeButton>
                      }
                    >
                      Couldn't load publisher skills.
                    </Notice>
                  ) : null}

                  {showLocalAgentsError && (
                    <Notice
                      className=""
                      intent="destructive"
                      data-testid="plugins-local-agents-error"
                      actions={
                        <NoticeButton onClick={() => void refreshLocalAgents()}>
                          Try again
                        </NoticeButton>
                      }
                    >
                      Couldn't load your agents.
                    </Notice>
                  )}

                  {/* The parent keeps this 16px under the page search row. */}
                  <Stack gap="section">
                    <div>
                      <ErrorBanner error={skillUpdates.error} />
                      <ErrorBanner
                        error={collectionActionError}
                        blockMessageFromReplay
                      />
                      <div
                        title={mcpConnectErrorCodeTitle(mcpBannerErrorCode)}
                        data-mcp-error-code={mcpBannerErrorCode ?? undefined}
                      >
                        <ErrorBanner
                          error={mcpBannerError}
                          blockMessageFromReplay
                        />
                      </div>
                      <CustomizeTabSections
                        tab={activeCatalogTab}
                        entries={entries}
                        query={deferredQuery}
                        onClearSearch={() => {
                          setQuery('');
                          setFocusSection(null);
                          searchInputRef.current?.focus();
                        }}
                        installedInventory={
                          error ||
                          skillsError ||
                          mcpError ||
                          capabilityInventory.installedInventory === 'error'
                            ? 'error'
                            : loading ||
                                skillsLoading ||
                                mcpLoading ||
                                capabilityInventory.installedInventory ===
                                  'loading'
                              ? 'loading'
                              : 'ready'
                        }
                        loading={
                          showLoading ||
                          (kindFilter === 'agent' && localAgentsLoading)
                        }
                        ownershipAvailable={
                          ownershipAvailable && !!capabilityInventory.viewerId
                        }
                        supportedUpdateKinds={CUSTOMIZE_SUPPORTED_UPDATE_KINDS}
                        pipelineFilters={pipelineFilters}
                        pipelineCategory={category}
                        suggestedNames={suggestedNames}
                        agentsAvailable={sharedCustomAgentsEnabled}
                        projectTemplatesAvailable
                        mcpSharedEntryIds={mcpSharedEntryIds}
                        McpServerLogoComponent={McpServerLogo}
                        contextKey={JSON.stringify([
                          shareScopingContext,
                          capabilityInventory.viewerId,
                        ])}
                        selectedEntryId={selectedEntryId}
                        onSelectEntry={handleSelectEntry}
                        onEditEntry={handleEditEntry}
                        onAddEntry={handleAddEntry}
                        onConnectEntry={handleAddEntry}
                        onOpenEntryId={handleOpenEntryId}
                        entryShareStates={entryShareStates}
                        onShareEntry={handleShareEntry}
                        onExpandBrowseGroup={(id) =>
                          openBrowseGroup(
                            id.startsWith('category-')
                              ? `category-${id.slice(9)}`
                              : 'suggested',
                          )
                        }
                        collectionUpdateSummaries={collectionSummaries}
                        onCreateCollection={
                          canCreateCollection ? openCollectionCreate : undefined
                        }
                        onEditCollection={
                          pendingCollectionScope === collectionScope
                            ? undefined
                            : editCollection
                        }
                        onDuplicateCollection={
                          pendingCollectionScope === collectionScope
                            ? undefined
                            : duplicateCollection
                        }
                        onUpdateEntry={handleUpdateEntry}
                        onUpdateFailures={skillUpdates.reportFailures}
                        workflowActions={workflowActions}
                        mcpRowActions={mcpRowActions}
                        onRetryInventory={() => {
                          void useAutomationsStore.getState().hydrate();
                          void reloadMarketplaces();
                          void refreshSkills();
                          void refreshServers();
                          void capabilityInventory.refreshPipelines();
                          void refreshCollectionList().catch(() => {
                            setCollectionActionError(
                              'Could not refresh the collection inventory.',
                            );
                          });
                          capabilityInventory.refreshOwnedShares();
                        }}
                        entryStatus={entryStatus}
                        renderSharedActions={renderRowUnshare}
                        installedStatusFilter={
                          installedStatusFilter ?? undefined
                        }
                        installedStatusInventory={
                          installedStatuses.state.kind === 'unsupported'
                            ? 'unavailable'
                            : installedStatuses.state.kind
                        }
                        installedStatusSnapshot={installedStatusSnapshot}
                        onInstalledStatusSnapshotChange={
                          setInstalledStatusSnapshot
                        }
                        installedExpanded={installedExpanded}
                        onInstalledExpandedChange={setInstalledExpanded}
                        focusSection={focusSection}
                        focusPending={
                          capabilityInventory.ownedSharesLoading ||
                          capabilityInventory.loading
                        }
                        onFocusSectionSettled={() => setFocusSection(null)}
                        browseActions={
                          <div className="flex flex-wrap items-center gap-3">
                            <PluginsPipelineFilters
                              values={pipelineFilterValues}
                              onChange={setPipelineFilterValues}
                            />
                            <RefreshButton
                              dataTestId="plugins-pipelines-refresh"
                              ariaLabel="Refresh workflows"
                              busy={pipelinesRefreshBusy}
                              onClick={handleRefreshPipelines}
                            />
                          </div>
                        }
                        emptyMessage="Nothing here yet. Use Add custom to bring in your own."
                        emptyState={
                          kindFilter === 'collection' ? (
                            <EmptyState
                              title="No collections yet"
                              subtitle="Group skills, plugins, and MCP servers so a chat or workflow can pick them up together."
                              action={
                                <Button
                                  size="compact"
                                  data-testid="plugins-collections-empty-create"
                                  disabled={!canCreateCollection}
                                  onClick={openCollectionCreate}
                                >
                                  Add collection
                                </Button>
                              }
                            />
                          ) : kindFilter === 'agent' &&
                            !showLocalAgentsError ? (
                            <EmptyState
                              title="No agents yet"
                              subtitle="Create an agent to reuse instructions and plugins from model pickers and workflows."
                              action={
                                <Button
                                  size="compact"
                                  data-testid="plugins-agents-empty-create"
                                  onClick={() =>
                                    openAgentDialog({ mode: 'create' })
                                  }
                                >
                                  New agent
                                </Button>
                              }
                            />
                          ) : kindFilter === 'workflow' && !inventoryError ? (
                            <EmptyState
                              title="No workflows yet"
                              subtitle="Run an agent or a workflow on a schedule. Workflows you create or add show up here."
                              action={
                                <Button
                                  size="compact"
                                  data-testid="plugins-automations-empty-open"
                                  onClick={() =>
                                    useNavigationStore
                                      .getState()
                                      .navigate('automations')
                                  }
                                >
                                  Open Workflows
                                </Button>
                              }
                            />
                          ) : undefined
                        }
                      />
                    </div>
                    {kindFilter === 'workflow' && (
                      <PipelineCatalogStatus
                        curated={
                          curatedEnabled
                            ? capabilityInventory.curated
                            : undefined
                        }
                        sharedNextCursor={
                          pipelineFilters.source === 'all' ||
                          pipelineFilters.source === 'shared'
                            ? capabilityInventory.sharedPipelineNextCursor
                            : null
                        }
                        sharedLoadingMore={
                          capabilityInventory.sharedPipelinesLoadingMore
                        }
                        onLoadMoreShared={() =>
                          void capabilityInventory.loadMoreSharedPipelines()
                        }
                      />
                    )}
                    {kindFilter === 'workflow' && (
                      <AutomationCatalogStatus
                        curated={capabilityInventory.curatedAutomations}
                        sharedNextCursor={
                          capabilityInventory.sharedAutomationNextCursor
                        }
                        sharedLoadingMore={
                          capabilityInventory.sharedAutomationsLoadingMore
                        }
                        onLoadMoreShared={() =>
                          void capabilityInventory.loadMoreSharedAutomations()
                        }
                      />
                    )}
                  </Stack>
                </Stack>
              )}
            </div>
          </Stack>
        )}
      </PageContent>
      {capabilityInventory.curated && (
        <CuratedPipelinePreview
          breadcrumbsGap="group"
          breadcrumbs={
            curatedPipelineBreadcrumbTitle ? (
              <div className="min-w-0">
                <CustomizeBreadcrumbs
                  testId="plugins-curated-pipeline-breadcrumbs"
                  items={[
                    {
                      key: 'root',
                      label: CUSTOMIZE_LABEL,
                      testId: 'plugins-curated-pipeline-breadcrumb-root',
                      onSelect: capabilityInventory.curated.onBack,
                    },
                    {
                      key: 'type',
                      label: 'Workflows',
                      testId: 'plugins-curated-pipeline-breadcrumb-type',
                      onSelect: openCuratedPipelineType,
                    },
                    {
                      key: 'current',
                      label: curatedPipelineBreadcrumbTitle,
                      testId: 'plugins-curated-pipeline-breadcrumb-current',
                    },
                  ]}
                />
              </div>
            ) : undefined
          }
          catalog={{
            ...capabilityInventory.curated,
            launchAvailability: curatedTemplateAvailability,
            onOpenImported: (id) =>
              useNavigationStore
                .getState()
                .openPipelineEdit({ pipelineId: id, source: 'user' }),
          }}
        />
      )}

      {addMarketplaceOpen &&
        canAddMarketplace &&
        sourceClient.marketplaceSources && (
          <MarketplaceSourceAddDialog
            client={sourceClient.marketplaceSources}
            initialInput={marketplaceInitialRepo}
            onClose={() => {
              setAddMarketplaceOpen(false);
              setMarketplaceInitialRepo('');
            }}
            onComplete={async (result, isCurrent) => {
              await marketplaceSources.reload();
              if (!isCurrent()) return;
              setAddMarketplaceOpen(false);
              setMarketplaceInitialRepo('');
              applyBrowseDestination({ query: '', tab: 'sources' });
              setSelectedSourceId(result.sourceId);
            }}
          />
        )}

      {mcpDialogOpen && (
        <McpServerDialog
          serverId={null}
          curatedEntries={curatedMcpServers}
          onClose={() => setMcpDialogOpen(false)}
          onSaved={async () => {
            setMcpDialogOpen(false);
            await refreshServers();
          }}
          onCreated={openCreatedCustomItem}
        />
      )}

      {mcpEditServerId !== null && (
        <McpServerDialog
          key={mcpEditServerId}
          serverId={mcpEditServerId}
          curatedEntries={curatedMcpServers}
          onClose={() => setMcpEditServerId(null)}
          onSaved={async () => {
            setMcpEditServerId(null);
            await refreshServers();
          }}
        />
      )}
      {mcpEditAccount !== null && (
        <McpServerDialog
          key={mcpEditAccount.id}
          serverId={null}
          accountConnection={mcpEditAccount}
          curatedEntries={curatedMcpServers}
          onClose={() => setMcpEditAccount(null)}
          onSaved={async () => {
            setMcpEditAccount(null);
            await refreshServers();
          }}
        />
      )}

      {accountRequests.dialogs}

      <AddSkillsModal
        isOpen={addSkillsOpen}
        onClose={() => setAddSkillsOpen(false)}
        onInstalled={refreshSkills}
        onAddMarketplace={handleAddMarketplaceFromSkills}
      />

      <CreateSkillModal
        isOpen={createSkillOpen}
        onClose={() => setCreateSkillOpen(false)}
        onSaved={async (savedName) => {
          setCreateSkillOpen(false);
          openCreatedCustomItem({
            kind: 'skill',
            sourceId: CUSTOM_SKILL_SOURCE_ID,
            name: savedName,
          });
          await refreshSkills();
        }}
      />
      {collectionEditor &&
        collectionEditor.context === collectionContextKey && (
          <CollectionModal
            key={`${collectionContextKey}/${collectionEditor.id}`}
            collectionId={collectionEditor.id}
            onClose={() => setCollectionEditor(null)}
            onSaved={async (): Promise<void> => {
              setCollectionEditor(null);
              await capabilityInventory.refreshLocalCollections();
            }}
            onUnknownCreate={(): void => {
              setUnknownCollectionCreates(
                (previous) =>
                  new Set([...Array.from(previous), collectionContextKey]),
              );
              if (currentCollectionContext.current === collectionScope)
                setCollectionActionError(
                  'The save outcome is unknown. Check the collection list on your desktop before creating another collection.',
                );
            }}
            onCreated={(collectionId): void =>
              openCreatedCustomItem({ kind: 'collection', collectionId })
            }
          />
        )}

      {sharedCustomAgentsEnabled &&
        (agentDialog?.mode === 'create' ||
          (agentDialog?.mode === 'edit' && agentDialogTarget)) && (
          <AgentModelModal
            agent={agentDialog.mode === 'edit' ? agentDialogTarget : null}
            existingAgents={localAgentDefinitions}
            onClose={() => setAgentDialog(null)}
            onSave={handleSaveAgent}
          />
        )}
      {sharedCustomAgentsEnabled &&
        agentDialog?.mode === 'delete' &&
        agentDialogTarget && (
          <DeleteConfirmModal
            title="Delete agent"
            message={`Existing chats and workflows that use ${agentDialogTarget.id} will fail until another model is selected.`}
            confirmLabel="Delete agent"
            pending={agentDeletePending}
            error={agentDeleteError}
            onCancel={() => {
              if (agentDeletePending) return;
              setAgentDialog(null);
            }}
            onConfirm={() => handleConfirmDeleteAgent(agentDialogTarget.id)}
          />
        )}
      {ownedShare.shareModal}
      {pluginShareTarget && (
        <SharePluginModal
          pluginRef={pluginShareTarget.pluginRef}
          name={pluginShareTarget.name}
          description={pluginShareTarget.description}
          onClose={() => setPluginShareTarget(null)}
        />
      )}
      {shareGateModal}
      {dispatchPipelineModal}
      {automationUpdate.pending && (
        <AutomationUpdateModal
          update={automationUpdate.pending}
          onClose={automationUpdate.clear}
        />
      )}

      {/* Dialog-owned branches remain over the browse/management surface. */}
      {selectedEntry &&
        !selectedEntryUsesDetailPage &&
        renderEntryDetail(selectedEntry, 'modal')}
    </div>
  );
}
