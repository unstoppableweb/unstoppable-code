import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { MARKETPLACE_SHARE_BLOCKED_REASONS } from '@canopy/protocol/sharing';
import { MCP_MANAGEMENT_REASONS } from '@canopy/ui-shared/lib/mcp-card-display';
import {
  type ComponentType,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { InstalledItemUninstallTarget } from '@canopy/protocol/installed-items';
import { useOptionalCanopyClient } from '@canopy/app-state';
import { isFeatureSurfaceAvailable } from '@canopy/app-core/gating';
import {
  Stack,
  CustomizeInstalledList,
  CustomizeInstalledRow,
  CustomizeInstalledUnavailable,
  CustomizeSection,
  Tooltip,
  InstalledItemStatusControl,
  InstalledItemStatusPicker,
  Button,
  InstalledItemStatusUnavailable,
  McpRowHealth,
  McpSignInPendingActions,
  McpSignInPendingStatus,
  Notice,
  NoticeButton,
  PluginsDiscoveryList,
  PluginsDiscoveryListLoading,
  SearchEmptyState,
  UninstallConfirmDialog,
  type CustomizeRowMenuItem,
  type PluginsEntryStatusBinding,
  type McpServerLogoProps,
  EmptyStateRow,
} from '@canopy/ui-shared/components';
import { DownloadIcon } from '@canopy/ui-shared/icons';
import { displayVersion } from '@canopy/ui-shared/lib/display-version';
import type { HostAction } from '@canopy/ui-shared/lib/host-action';
import {
  mcpHasMultipleTargets,
  mcpRowHealthModel,
} from '@canopy/ui-shared/lib/mcp-row-health';
import {
  CUSTOM_SKILL_EDIT_UNAVAILABLE_REASON,
  INSTALLED_ITEM_STATUS_DESCRIPTION_LINE,
  createdByViewer,
  formatDateOrEmpty,
  bundledSkillStatusReason,
  installedItemTargetKey,
  isBundledSkill,
  isPluginServerResult,
  installedStatusFilterEmptyText,
  type InstalledStatusFilterValue,
  mcpEntryPluginLink,
  pipelineFiltersActive,
  removalBusyLabel,
  removalConfirmTitle,
  removalFallbackError,
  removalMenuLabel,
  removalVerb,
  updateMenuLabel,
  type MarketplaceEntryShareStates,
  type MarketplaceCatalogTabId,
  type PipelineFilterValues,
  type PluginsDiscoverySection,
  type PluginsDiscoverySectionId,
  type UnifiedPluginEntry,
  type InstalledEntryStatusState,
} from '@canopy/ui-shared/lib';
import {
  buildCustomizeTabModel,
  customizeTabHasInstalledStatuses,
  effectiveInstalledStatusFilter,
  extendInstalledStatusSnapshot,
  NO_INSTALLED_STATUS_MEMBERS,
  statusEntryIdOf,
  type CustomizeBrowseGroup,
  type CustomizeInventoryState,
  type CustomizeSectionId,
  type CustomizeSectionModel,
  type CustomizeUpdateKind,
  type InstalledStatusMembership,
  type InstalledStatusSnapshot,
} from './customizeSections';
import { WORKFLOW_ROW_MENU_LABELS } from '../workflows/workflow-library-model';
import {
  customizeWorkflowAvailability,
  type CustomizeWorkflowActions,
} from './customizeWorkflowActions';
import { CustomizeWorkflowRowControls } from './CustomizeWorkflowRowControls';
import { bundledServerStandsBehindPlugin } from './unifiedPluginEntries';

export interface CustomizeUpdateFailure {
  readonly entry: UnifiedPluginEntry;
  readonly error: unknown;
}

export interface CustomizeInstalledUnavailableCopy {
  readonly title: string;
  readonly body: string;
  /** The host's existing pairing or sign-in control, when one applies. */
  readonly action?: ReactNode;
}

/**
 * What an installed MCP row can do on this host. Each action resolves one
 * concrete target, or says why it cannot; a card with several connections
 * goes through its details instead of picking one here.
 */
export interface CustomizeMcpRowActions {
  readonly test: (entry: UnifiedPluginEntry) => HostAction<() => Promise<void>>;
  readonly connect: (
    entry: UnifiedPluginEntry,
  ) => HostAction<() => void | Promise<void>>;
  /** Only the exact target currently signing in; other rows remain gated. */
  readonly pending?: (
    entry: UnifiedPluginEntry,
  ) =>
    | { readonly authorizationUrl?: string; readonly onCancel: () => void }
    | undefined;
  readonly edit: (entry: UnifiedPluginEntry) => HostAction<() => void>;
  readonly formatTimestamp?: (iso: string) => string;
  /** A failed action or the status refresh after it. */
  readonly onError?: (message: string) => void;
}

/** What an installed MCP row shows, and what its menu says about Connect. */
interface McpRowPresentation {
  readonly connectLabel: string;
  readonly connectReason?: string;
  readonly node: ReactNode;
  readonly inlineAction?: ReactNode;
  readonly connectRun?: () => void;
  readonly cancelSignIn?: () => void;
}

const MCP_ROW_ACTION_FAILED = "Couldn't finish that. Try again.";

export interface CustomizeTabSectionsProps {
  readonly tab: MarketplaceCatalogTabId;
  readonly entries: readonly UnifiedPluginEntry[];
  readonly query: string;
  readonly searchMatchedEntryIds?: readonly string[];
  readonly installedInventory: CustomizeInventoryState;
  /** Catalog-wide loading; renders the shared list skeleton. */
  readonly loading?: boolean;
  readonly ownershipAvailable?: boolean;
  /** Kinds whose Updates the host surfaces. Omitted: no Updates section. */
  readonly supportedUpdateKinds?: readonly CustomizeUpdateKind[];
  readonly pipelineFilters?: PipelineFilterValues;
  readonly pipelineCategory?: string | null;
  readonly suggestedNames?: readonly string[];
  readonly agentsAvailable?: boolean;
  readonly projectTemplatesAvailable?: boolean;
  /** Changes when the surrounding context (project, organization) does. */
  readonly contextKey?: string;

  readonly selectedEntryId?: string | null;
  readonly onSelectEntry: (entry: UnifiedPluginEntry) => void;
  readonly hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
  readonly onAddEntry?: (entry: UnifiedPluginEntry) => void;
  readonly onConnectEntry?: (entry: UnifiedPluginEntry) => void;
  readonly onOpenEntryId?: (entryId: string) => void;
  readonly entryShareStates?: MarketplaceEntryShareStates;
  /** Plugin shares eligible for Shared by me on the MCP servers tab. */
  readonly mcpSharedEntryIds?: ReadonlySet<string>;
  readonly entryStatus?: PluginsEntryStatusBinding;
  /**
   * Narrows Installed; ignored on tabs whose rows carry no status, and
   * `update-available` on tabs that do not offer it.
   */
  readonly installedStatusFilter?: InstalledStatusFilterValue;
  readonly installedStatusInventory?: CustomizeInventoryState;
  /**
   * Host-held membership snapshot. Without it the list keeps its own, which
   * an entry detail page discards by unmounting the list.
   */
  readonly installedStatusSnapshot?: InstalledStatusSnapshot;
  readonly onInstalledStatusSnapshotChange?: (
    snapshot: InstalledStatusSnapshot,
  ) => void;
  readonly installedExpanded?: boolean;
  readonly onInstalledExpandedChange?: (expanded: boolean) => void;
  readonly onShareEntry?: (entry: UnifiedPluginEntry) => void;
  readonly McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
  /** Opens a Browse group's full category page. */
  readonly onExpandBrowseGroup?: (groupId: string) => void;
  /** Browse heading controls, such as the Workflows pipeline filters. */
  readonly browseActions?: ReactNode;
  readonly installedActions?: ReactNode;
  readonly onCreateCollection?: () => void;
  readonly onEditCollection?: (entry: UnifiedPluginEntry) => void;
  readonly onDuplicateCollection?: (entry: UnifiedPluginEntry) => void;
  readonly collectionUpdateSummaries?: ReadonlyMap<string, string>;
  /** A surfaced update can be read-only without disabling other kinds. */
  readonly updateDisabledReason?: (
    entry: UnifiedPluginEntry,
  ) => string | undefined;

  readonly installedUnavailable?: CustomizeInstalledUnavailableCopy;
  readonly onRetryInventory?: () => void;

  /** Performs one update; rejects on failure. Hosts refresh in `onUpdatesSettled`. */
  readonly onUpdateEntry?: (entry: UnifiedPluginEntry) => Promise<void>;
  readonly onUpdateFailures?: (
    failures: readonly CustomizeUpdateFailure[],
  ) => void;
  readonly onUpdatesSettled?: () => void;

  /**
   * Opens a custom skill's editor. Edit is enabled only when the host also
   * reports `customSkillEdit`; otherwise it shows disabled with a reason.
   */
  readonly onEditEntry?: (entry: UnifiedPluginEntry) => void;
  /** Extension slots for sibling features; nothing renders when omitted. */
  readonly renderStatus?: (entry: UnifiedPluginEntry) => ReactNode;
  readonly renderSharedActions?: (
    entry: UnifiedPluginEntry,
    renderRow: (item: CustomizeRowMenuItem) => ReactNode,
  ) => ReactNode;
  /**
   * Run, on/off, Run now, Edit, View runs and Delete… on workflow rows
   * (CAN-4845). Omitted, workflow rows show no controls of their own.
   */
  readonly workflowActions?: CustomizeWorkflowActions;
  /** Health, one inline action and the full menu on installed MCP rows. */
  readonly mcpRowActions?: CustomizeMcpRowActions;

  /** Creation-oriented state for a genuinely empty, unfiltered tab. */
  readonly emptyState?: ReactNode;
  readonly emptyMessage?: string;
  readonly searchEmptyMessage?: string;
  /**
   * Clears the query: the search empty state's one action. Omitted, that
   * state has no action.
   */
  readonly onClearSearch?: () => void;

  /** One-shot scroll target, honored once data settles. */
  readonly focusSection?: CustomizeSectionId | null;
  /** True while the data that decides the focus target is still loading. */
  readonly focusPending?: boolean;
  readonly onFocusSectionSettled?: () => void;
}

const TYPE_TAB_SECTION_IDS: Record<
  Exclude<MarketplaceCatalogTabId, 'all'>,
  PluginsDiscoverySectionId
> = {
  plugin: 'marketplace',
  app: 'apps',
  skill: 'skills',
  workflow: 'workflows',
  collection: 'collections',
  agent: 'agents',
  blueprint: 'project-templates',
};

const KNOWN_GROUP_IDS: readonly PluginsDiscoverySectionId[] = [
  'featured',
  'suggested',
  'recommended',
  'curated',
  'apps',
  'marketplace',
  'shared-plugins',
  'skills',
  'workflows',
  'collections',
  'agents',
  'project-templates',
  'plugins-and-mcp',
];

function discoverySectionId(id: string): PluginsDiscoverySectionId {
  const known = KNOWN_GROUP_IDS.find((candidate) => candidate === id);
  if (known) return known;
  return `category-${id.startsWith('category-') ? id.slice(9) : id}`;
}

function groupSection(
  group: CustomizeBrowseGroup,
  showEntryTypes: boolean,
  onExpand: ((groupId: string) => void) | undefined,
): PluginsDiscoverySection {
  const collapsed =
    group.previewLimit !== undefined && onExpand !== undefined
      ? Math.max(0, group.entries.length - group.previewLimit)
      : 0;
  return {
    id: discoverySectionId(group.id),
    title: group.title,
    entries: [...group.entries],
    showEntryTypes,
    ...(group.previewLimit !== undefined && onExpand
      ? { collapsedCount: collapsed, onExpand: () => onExpand(group.id) }
      : {}),
  };
}

interface PendingRemoval {
  readonly entry: UnifiedPluginEntry;
  /** Captured when the item is chosen; the backend stays the guard. */
  readonly target: InstalledItemUninstallTarget;
  readonly description?: string;
  /** The host's `removalScope` when it opened; another scope never confirms it. */
  readonly scope: string | undefined;
}

/** Why an MCP row's Remove is off; loading or unknown states give no reason. */
function mcpRemoveDisabledReason(
  entry: UnifiedPluginEntry,
  state: InstalledEntryStatusState | undefined,
  removalAvailable: boolean,
): string | undefined {
  if (
    (entry.connection ?? entry.aggregateConnection)?.provider === true ||
    state?.kind === 'fixed'
  )
    return MCP_MANAGEMENT_REASONS.provider;
  if (state?.kind === 'read-only') return state.reason;
  if (state?.kind === 'ready' && !state.item.removable && state.item.reason)
    return state.item.reason;
  return removalAvailable ? undefined : MCP_MANAGEMENT_REASONS.desktopOnly;
}

const DEFAULT_UNAVAILABLE: CustomizeInstalledUnavailableCopy = {
  title: 'Installed items aren’t available here',
  body: 'Browse is still available. Installed items show up once this device can read them.',
};

/**
 * The Customize page body shared by desktop and web: Updates, Installed,
 * Shared by me and Browse, in that order. Hosts supply reads and actions.
 */
export function CustomizeTabSections(
  props: CustomizeTabSectionsProps,
): JSX.Element {
  const {
    tab,
    entries,
    query,
    searchMatchedEntryIds,
    installedInventory,
    loading = false,
    ownershipAvailable,
    supportedUpdateKinds,
    pipelineFilters,
    pipelineCategory,
    suggestedNames,
    agentsAvailable,
    projectTemplatesAvailable,
    contextKey = '',
    selectedEntryId = null,
    onSelectEntry,
    hrefForEntry,
    onAddEntry,
    onConnectEntry,
    onOpenEntryId,
    entryShareStates,
    mcpSharedEntryIds,
    entryStatus,
    installedStatusFilter,
    installedStatusInventory,
    installedStatusSnapshot,
    onInstalledStatusSnapshotChange,
    installedExpanded: controlledInstalledExpanded,
    onInstalledExpandedChange,
    onShareEntry,
    McpServerLogoComponent,
    onExpandBrowseGroup,
    browseActions,
    installedActions,
    onCreateCollection,
    onEditCollection,
    onDuplicateCollection,
    collectionUpdateSummaries,
    updateDisabledReason,
    installedUnavailable = DEFAULT_UNAVAILABLE,
    onRetryInventory,
    onUpdateEntry,
    onUpdateFailures,
    onUpdatesSettled,
    onEditEntry,
    renderStatus,
    renderSharedActions,
    workflowActions,
    mcpRowActions,
    emptyState,
    emptyMessage = 'Nothing here yet.',
    searchEmptyMessage = 'Nothing matches your search.',
    onClearSearch,
    focusSection,
    focusPending = false,
    onFocusSectionSettled,
  } = props;
  const searchActive = query.trim() !== '';
  // Default-deny: a host without a client provider (the Portal page) or one
  // that does not report the capability cannot edit skills (CAN-4844).
  const capabilities = useOptionalCanopyClient()?.capabilities;
  const canEditCustomSkill =
    capabilities !== undefined &&
    isFeatureSurfaceAvailable(capabilities, 'custom-skill-edit') &&
    onEditEntry !== undefined;
  // Expansion belongs to one tab/context/search mode; changing any resets it,
  // while inventory refreshes leave an expanded list expanded.
  const expansionScope = `${tab}|${contextKey}|${searchActive ? 'search' : 'browse'}`;
  const [expansion, setExpansion] = useState({
    scope: expansionScope,
    expanded: false,
  });
  if (expansion.scope !== expansionScope) {
    // Adjusting state during render resets before the stale value paints.
    setExpansion({ scope: expansionScope, expanded: false });
  }
  const installedExpanded =
    focusSection === 'installed' ||
    controlledInstalledExpanded === true ||
    (expansion.scope === expansionScope && expansion.expanded);

  const statusFilter = effectiveInstalledStatusFilter(
    tab,
    installedStatusFilter,
    supportedUpdateKinds,
  );
  // Applying a status filter expands Installed: a filter that only changed a
  // hidden count would not be discoverable (CAN-4838).
  const [appliedFilter, setAppliedFilter] = useState(statusFilter);
  if (appliedFilter !== statusFilter) {
    setAppliedFilter(statusFilter);
    if (statusFilter !== undefined)
      setExpansion({ scope: expansionScope, expanded: true });
  }
  // Hosts that persist expansion hear about it whenever a status applies.
  const notifiedFilterRef = useRef(statusFilter);
  useEffect(() => {
    const previous = notifiedFilterRef.current;
    notifiedFilterRef.current = statusFilter;
    if (previous !== statusFilter && statusFilter !== undefined)
      onInstalledExpandedChange?.(true);
  }, [statusFilter, onInstalledExpandedChange]);
  // Membership is a snapshot: a row whose status changes while filtered keeps
  // its place until the filter, tab or context changes. The query is not part
  // of the key, so searching never reshuffles membership.
  const snapshotScope = `${tab}|${statusFilter ?? ''}`;
  const snapshotKey = `${tab}|${contextKey}|${statusFilter ?? ''}`;
  const [localSnapshot, setLocalSnapshot] = useState<InstalledStatusSnapshot>({
    key: snapshotKey,
    scope: snapshotScope,
    members: NO_INSTALLED_STATUS_MEMBERS,
  });
  const snapshot = installedStatusSnapshot ?? localSnapshot;
  const baseMembers: InstalledStatusMembership =
    snapshot.key === snapshotKey
      ? snapshot.members
      : NO_INSTALLED_STATUS_MEMBERS;
  // Same reference when nothing was pinned, so these updates converge.
  const statusMembers = statusFilter
    ? extendInstalledStatusSnapshot(
        baseMembers,
        statusFilter,
        entries,
        entryStatus?.states,
        supportedUpdateKinds,
      )
    : baseMembers;
  const snapshotChanged =
    snapshot.key !== snapshotKey || statusMembers !== snapshot.members;
  if (installedStatusSnapshot === undefined && snapshotChanged)
    setLocalSnapshot({
      key: snapshotKey,
      scope: snapshotScope,
      members: statusMembers,
    });
  // A host-held snapshot is reported after render; this render already uses
  // `statusMembers`, so the list never waits for the host. A context-only
  // change reports once something is pinned: a remount whose context has not
  // resolved yet leaves the held snapshot for the context that follows.
  const reportSnapshot =
    snapshotChanged &&
    (snapshot.scope !== snapshotScope || Object.keys(statusMembers).length > 0);
  useEffect(() => {
    if (installedStatusSnapshot !== undefined && reportSnapshot)
      onInstalledStatusSnapshotChange?.({
        key: snapshotKey,
        scope: snapshotScope,
        members: statusMembers,
      });
  }, [
    installedStatusSnapshot,
    reportSnapshot,
    snapshotKey,
    snapshotScope,
    statusMembers,
    onInstalledStatusSnapshotChange,
  ]);

  const model = useMemo(
    () =>
      buildCustomizeTabModel({
        tab,
        entries,
        query,
        searchMatchedEntryIds,
        // Update available reads the entries alone, never the statuses.
        installedInventory:
          statusFilter !== undefined &&
          statusFilter !== 'update-available' &&
          installedInventory === 'ready'
            ? (installedStatusInventory ?? 'unavailable')
            : installedInventory,
        ownershipAvailable,
        supportedUpdateKinds,
        pipelineFilters,
        pipelineCategory,
        installedExpanded,
        keepInstalledVisible: installedExpanded,
        installedStatusFilter: statusFilter,
        installedStatusStates: entryStatus?.states,
        installedStatusSnapshot: statusMembers,
        suggestedNames,
        agentsAvailable,
        projectTemplatesAvailable,
        mcpSharedEntryIds,
      }),
    [
      tab,
      entries,
      query,
      searchMatchedEntryIds,
      installedInventory,
      ownershipAvailable,
      supportedUpdateKinds,
      pipelineFilters,
      pipelineCategory,
      installedExpanded,
      statusFilter,
      installedStatusInventory,
      entryStatus?.states,
      statusMembers,
      suggestedNames,
      agentsAvailable,
      projectTemplatesAvailable,
      mcpSharedEntryIds,
    ],
  );

  // Refs guard against double submission before React re-renders.
  const inFlight = useRef(new Set<string>());
  const batchRunningRef = useRef(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [removal, setRemoval] = useState<PendingRemoval | null>(null);
  // A pending confirmation belongs to the host scope it was opened in. When
  // the host withdraws removal (web consent turned off) or moves to another
  // desktop or project, it stops rendering at once, and the effect drops it
  // so it cannot reappear by itself later.
  const removalAvailable = entryStatus?.onUninstall !== undefined;
  const removalScope = entryStatus?.removalScope;
  const activeRemoval =
    removal !== null && removalAvailable && removal.scope === removalScope
      ? removal
      : null;
  useEffect(() => {
    if (removal !== null && activeRemoval === null) setRemoval(null);
  }, [removal, activeRemoval]);

  const runUpdate = useCallback(
    async (
      entry: UnifiedPluginEntry,
    ): Promise<CustomizeUpdateFailure | null> => {
      if (
        !onUpdateEntry ||
        updateDisabledReason?.(entry) ||
        inFlight.current.has(entry.id)
      )
        return null;
      inFlight.current.add(entry.id);
      setBusyIds(new Set(inFlight.current));
      try {
        await onUpdateEntry(entry);
        return null;
      } catch (error) {
        return { entry, error };
      } finally {
        inFlight.current.delete(entry.id);
        setBusyIds(new Set(inFlight.current));
      }
    },
    [onUpdateEntry, updateDisabledReason],
  );

  const updateOne = useCallback(
    async (entry: UnifiedPluginEntry): Promise<void> => {
      if (batchRunningRef.current || inFlight.current.has(entry.id)) return;
      const failure = await runUpdate(entry);
      if (failure) onUpdateFailures?.([failure]);
      onUpdatesSettled?.();
    },
    [onUpdateFailures, onUpdatesSettled, runUpdate],
  );

  const batchSnapshot = model.batchableUpdates;
  const updateAll = useCallback(async (): Promise<void> => {
    if (batchRunningRef.current || inFlight.current.size > 0 || !onUpdateEntry)
      return;
    batchRunningRef.current = true;
    setBatchRunning(true);
    const failures: CustomizeUpdateFailure[] = [];
    try {
      // Sequential, continuing past individual failures.
      for (const entry of batchSnapshot) {
        if (inFlight.current.has(entry.id)) continue;
        const failure = await runUpdate(entry);
        if (failure) failures.push(failure);
      }
    } finally {
      batchRunningRef.current = false;
      setBatchRunning(false);
    }
    if (failures.length > 0) onUpdateFailures?.(failures);
    onUpdatesSettled?.();
  }, [
    batchSnapshot,
    onUpdateEntry,
    onUpdateFailures,
    onUpdatesSettled,
    runUpdate,
  ]);

  // One busy set per workflow row covers its switch, Run, Run now and
  // Delete…, so a second activation while one is in flight is a no-op.
  const workflowInFlight = useRef(new Set<string>());
  const [workflowBusyIds, setWorkflowBusyIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [deleteTarget, setDeleteTarget] = useState<UnifiedPluginEntry | null>(
    null,
  );

  const runWorkflowAction = useCallback(
    async (
      entry: UnifiedPluginEntry,
      action: () => void | Promise<void>,
      failureMessage: string,
    ): Promise<void> => {
      if (workflowInFlight.current.has(entry.id)) return;
      workflowInFlight.current.add(entry.id);
      setWorkflowBusyIds(new Set(workflowInFlight.current));
      try {
        await action();
      } catch {
        workflowActions?.onActionError?.(failureMessage);
      } finally {
        workflowInFlight.current.delete(entry.id);
        setWorkflowBusyIds(new Set(workflowInFlight.current));
      }
    },
    [workflowActions],
  );

  const deleteWorkflow = useCallback(
    async (entry: UnifiedPluginEntry): Promise<string | null> => {
      const onDelete = workflowActions?.onDelete;
      if (!onDelete) return null;
      workflowInFlight.current.add(entry.id);
      setWorkflowBusyIds(new Set(workflowInFlight.current));
      try {
        return await onDelete(entry);
      } finally {
        workflowInFlight.current.delete(entry.id);
        setWorkflowBusyIds(new Set(workflowInFlight.current));
      }
    },
    [workflowActions],
  );

  const focusTargetDomId = focusSection
    ? (model.sections.find((section) => section.id === focusSection)?.domId ??
      null)
    : null;
  useEffect(() => {
    if (!focusSection || !onFocusSectionSettled || loading || focusPending)
      return;
    if (focusTargetDomId) {
      const target = document.getElementById(focusTargetDomId);
      target?.scrollIntoView?.({ block: 'start' });
      if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }
    if (focusSection === 'installed') {
      setExpansion({ scope: expansionScope, expanded: true });
      onInstalledExpandedChange?.(true);
    }
    // Absent or present, the intent is spent so a later render cannot scroll.
    onFocusSectionSettled();
  }, [
    focusSection,
    focusPending,
    focusTargetDomId,
    loading,
    onFocusSectionSettled,
    expansionScope,
    onInstalledExpandedChange,
  ]);

  // Preserve the bound callbacks when filtering leaves update membership unchanged.
  const updateIdKey = (
    model.sections
      .find((section) => section.id === 'updates')
      ?.entries.map((entry) => entry.id) ?? []
  ).join('\0');
  const updateIds = useMemo(
    () => new Set(updateIdKey ? updateIdKey.split('\0') : []),
    [updateIdKey],
  );

  /**
   * What Connect signs in to: the row itself when it needs sign-in, or for a
   * plugin standing in for bundled servers that wait for sign-in, the first
   * such server, so its chip and menu start that server's own sign-in. Any
   * other row with pending sign-ins (an integration card with one expired
   * connection beside a working one) connects itself.
   */
  const signInTarget = useCallback(
    function signInTarget(
      entry: UnifiedPluginEntry,
    ): UnifiedPluginEntry | undefined {
      if (entry.state === 'needs-auth') return entry;
      if ((entry.pendingSignIns ?? 0) === 0) return undefined;
      for (const row of entry.bundledServerRows ?? []) {
        const server = entries.find(
          (candidate) => candidate.id === row.entryId,
        );
        // A server that keeps its own row prompts there, not here.
        if (
          server &&
          bundledServerStandsBehindPlugin(server) &&
          (server.pendingSignIns ?? 0) > 0
        )
          return server;
      }
      return entry;
    },
    [entries],
  );

  // One pending action per row, shared by its inline button and its menu.
  const mcpRowInFlight = useRef(new Set<string>());
  const [mcpRowBusyIds, setMcpRowBusyIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const runMcpRowAction = useCallback(
    async (
      entry: UnifiedPluginEntry,
      action: () => void | Promise<void>,
    ): Promise<void> => {
      if (mcpRowInFlight.current.has(entry.id)) return;
      mcpRowInFlight.current.add(entry.id);
      setMcpRowBusyIds(new Set(mcpRowInFlight.current));
      try {
        await action();
      } catch (error) {
        mcpRowActions?.onError?.(
          error instanceof Error && error.message !== ''
            ? error.message
            : MCP_ROW_ACTION_FAILED,
        );
      } finally {
        mcpRowInFlight.current.delete(entry.id);
        setMcpRowBusyIds(new Set(mcpRowInFlight.current));
      }
    },
    [mcpRowActions],
  );

  /** The plugin entry an MCP row came with, when the catalog still lists it. */
  const providerPluginOf = useCallback(
    function providerPluginOf(
      entry: UnifiedPluginEntry,
    ): UnifiedPluginEntry | undefined {
      const link = mcpEntryPluginLink(entry);
      return link && entries.find((candidate) => candidate.id === link.entryId);
    },
    [entries],
  );

  /** Opens a plugin in place when the host can, or selects its real entry. */
  const openPlugin = useCallback(
    function openPlugin(plugin: UnifiedPluginEntry): void {
      if (onOpenEntryId) onOpenEntryId(plugin.id);
      else onSelectEntry(plugin);
    },
    [onOpenEntryId, onSelectEntry],
  );

  const removalMenuItem = useCallback(
    function removalMenuItem(
      entry: UnifiedPluginEntry,
    ): CustomizeRowMenuItem | null {
      if (!entryStatus?.onUninstall) return null;
      const state = entryStatus.states[entry.id];
      if (state?.kind !== 'ready') return null;
      const { item } = state;
      const target = item.uninstallTarget;
      if (!item.removable || target === undefined) return null;
      return {
        id: 'remove',
        label: removalMenuLabel(entry),
        destructive: true,
        disabled: entryStatus.pendingKeys.has(installedItemTargetKey(target)),
        onSelect: () =>
          setRemoval({
            entry,
            target,
            description: item.uninstallDescription,
            scope: removalScope,
          }),
      };
    },
    [entryStatus, removalScope],
  );

  const menuItems = useCallback(
    function menuItems(
      entry: UnifiedPluginEntry,
      sectionId: CustomizeSectionId,
      connect: (() => void) | undefined,
      mcpRow?: {
        readonly connectLabel?: string;
        readonly connectReason?: string;
        readonly connectRun?: () => void;
        readonly cancelSignIn?: () => void;
      },
    ): CustomizeRowMenuItem[] {
      const items: CustomizeRowMenuItem[] = [];
      const provider = providerPluginOf(entry);
      const openProvider: CustomizeRowMenuItem | undefined = provider && {
        id: 'open-plugin',
        label: `Open the ${provider.name} plugin`,
        onSelect: () => openPlugin(provider),
      };
      // A search result has nothing of its own to open, share or remove.
      if (isPluginServerResult(entry))
        return openProvider ? [openProvider] : [];
      if (connect)
        items.push({
          id: 'connect',
          label: 'Connect',
          onSelect: connect,
        });
      items.push({
        id: 'details',
        label: 'Open details',
        onSelect: () => onSelectEntry(entry),
      });
      if (mcpRow && mcpRowActions) {
        const test = mcpRowActions.test(entry);
        const edit = mcpRowActions.edit(entry);
        const busy =
          mcpRowBusyIds.has(entry.id) ||
          mcpRowActions.pending?.(entry) !== undefined;
        items.push(
          {
            id: 'test',
            label: 'Test connection',
            disabled: !test.available || busy,
            disabledReason: test.available ? undefined : test.reason,
            onSelect: () => {
              if (test.available) void runMcpRowAction(entry, test.run);
            },
          },
          {
            id: 'edit',
            label: 'Edit configuration…',
            disabled: !edit.available || busy,
            disabledReason: edit.available ? undefined : edit.reason,
            onSelect: () => {
              if (edit.available) edit.run();
            },
          },
        );
        if (mcpRow.cancelSignIn !== undefined)
          items.push({
            id: 'cancel-sign-in',
            label: 'Cancel sign-in',
            onSelect: mcpRow.cancelSignIn,
          });
        if (mcpRow.connectRun !== undefined)
          items.push({
            id: 'connect',
            label: mcpRow.connectLabel ?? 'Connect',
            disabled: busy,
            onSelect: mcpRow.connectRun,
          });
        else if (mcpRow.connectReason !== undefined)
          items.push({
            id: 'connect',
            label: mcpRow.connectLabel ?? 'Connect',
            disabled: true,
            disabledReason: mcpRow.connectReason,
            onSelect: () => undefined,
          });
      }
      if (onOpenEntryId)
        for (const requirement of entry.requirements ?? []) {
          items.push({
            id: `requirement-${requirement.key}`,
            label: `Open ${requirement.name}`,
            onSelect: () => onOpenEntryId(requirement.entryId),
          });
        }
      if (openProvider) items.push(openProvider);
      const workflow =
        workflowActions && entry.workflow ? workflowActions : undefined;
      const localCollection = entry.ref.type === 'local-collection';
      const createdCollection = localCollection && createdByViewer(entry);
      if (
        localCollection &&
        createdCollection &&
        onEditCollection &&
        sectionId === 'installed'
      )
        items.push({
          id: 'edit',
          label: 'Edit',
          onSelect: () => onEditCollection(entry),
        });
      if (
        updateIds.has(entry.id) &&
        (onUpdateEntry || updateDisabledReason?.(entry))
      )
        items.push({
          id: 'update',
          label: updateMenuLabel(entry.latestVersion),
          disabled:
            batchRunning ||
            busyIds.has(entry.id) ||
            !!updateDisabledReason?.(entry),
          disabledReason:
            updateDisabledReason?.(entry) ??
            (localCollection
              ? 'Updating replaces the items in this collection with the shared version. Resources you already use are kept.'
              : undefined),
          onSelect: () => void updateOne(entry),
        });
      if (
        localCollection &&
        !createdCollection &&
        onDuplicateCollection &&
        sectionId === 'installed'
      )
        items.push({
          id: 'duplicate',
          label: 'Duplicate to edit',
          onSelect: () => onDuplicateCollection(entry),
        });
      // A bundled skill follows its plugin: it is never updated, shared or
      // removed on its own (CAN-4844).
      if (isBundledSkill(entry)) return items;
      const availability = workflow
        ? customizeWorkflowAvailability(entry, workflow)
        : undefined;
      const workflowBusy = workflowBusyIds.has(entry.id);
      if (workflow && availability) {
        items.push(
          {
            id: 'edit',
            label: WORKFLOW_ROW_MENU_LABELS.edit,
            disabled: !availability.edit.available,
            disabledReason: availability.edit.reason,
            onSelect: () => workflow.onEdit?.(entry),
          },
          {
            id: 'view-runs',
            label: WORKFLOW_ROW_MENU_LABELS.viewRuns,
            disabled: !availability.viewRuns.available,
            disabledReason: availability.viewRuns.reason,
            onSelect: () => workflow.onViewRuns?.(entry),
          },
        );
        if (entry.kind === 'automation')
          items.push({
            id: 'run-now',
            label: WORKFLOW_ROW_MENU_LABELS.runNow,
            disabled: workflowBusy || !availability.runNow.available,
            disabledReason: availability.runNow.reason,
            onSelect: () => {
              const onRunNow = workflow.onRunNow;
              if (!onRunNow) return;
              void runWorkflowAction(
                entry,
                () => onRunNow(entry),
                `Couldn't start ${entry.name}`,
              );
            },
          });
      }
      const share = entryShareStates?.get(entry.id);
      if (share && onShareEntry)
        items.push({
          id: 'share',
          label: 'Share…',
          disabled: share.status === 'blocked',
          disabledReason: share.status === 'blocked' ? share.reason : undefined,
          onSelect: () => onShareEntry(entry),
        });
      else if (mcpRow)
        items.push({
          id: 'share',
          label: 'Share…',
          disabled: true,
          disabledReason:
            share?.status === 'blocked'
              ? share.reason
              : entry.ref.type === 'mcp-server'
                ? MARKETPLACE_SHARE_BLOCKED_REASONS.standaloneMcp
                : MARKETPLACE_SHARE_BLOCKED_REASONS.unavailable,
          onSelect: () => undefined,
        });
      if (
        sectionId === 'installed' &&
        entry.kind === 'skill' &&
        entry.ref.type === 'skill' &&
        entry.custom === true
      )
        items.push({
          id: 'edit',
          label: 'Edit',
          disabled: !canEditCustomSkill,
          disabledReason: canEditCustomSkill
            ? undefined
            : CUSTOM_SKILL_EDIT_UNAVAILABLE_REASON,
          onSelect: () => {
            if (canEditCustomSkill) onEditEntry?.(entry);
          },
        });
      if (workflow && availability)
        items.push({
          id: 'delete',
          label: WORKFLOW_ROW_MENU_LABELS.delete,
          destructive: true,
          disabled: workflowBusy || !availability.delete.available,
          disabledReason: availability.delete.reason,
          onSelect: () => setDeleteTarget(entry),
        });
      const removalItem =
        !workflow && sectionId !== 'shared-by-me'
          ? removalMenuItem(entry)
          : null;
      if (removalItem) items.push(removalItem);
      else if (mcpRow) {
        const state = entryStatus?.states[entry.id];
        const chooseTarget = mcpHasMultipleTargets(entry);
        items.push({
          id: 'remove',
          label: 'Remove…',
          destructive: true,
          disabled: !chooseTarget,
          disabledReason: chooseTarget
            ? undefined
            : mcpRemoveDisabledReason(
                entry,
                state,
                entryStatus?.onUninstall !== undefined,
              ),
          onSelect: () => {
            if (chooseTarget) onSelectEntry(entry);
          },
        });
      }
      return items;
    },
    [
      onSelectEntry,
      onOpenEntryId,
      providerPluginOf,
      openPlugin,
      mcpRowActions,
      mcpRowBusyIds,
      runMcpRowAction,
      workflowActions,
      onEditCollection,
      updateIds,
      onUpdateEntry,
      updateDisabledReason,
      batchRunning,
      busyIds,
      updateOne,
      onDuplicateCollection,
      workflowBusyIds,
      runWorkflowAction,
      entryShareStates,
      onShareEntry,
      canEditCustomSkill,
      onEditEntry,
      removalMenuItem,
      entryStatus?.states,
      entryStatus?.onUninstall,
    ],
  );

  const renderWorkflowControls = useCallback(
    function renderWorkflowControls(entry: UnifiedPluginEntry): ReactNode {
      if (!workflowActions || !entry.workflow) return null;
      const availability = customizeWorkflowAvailability(
        entry,
        workflowActions,
      );
      const enabled = entry.workflow.enabled;
      return (
        <CustomizeWorkflowRowControls
          entry={entry}
          availability={availability}
          busy={workflowBusyIds.has(entry.id)}
          onRun={() => {
            const onRun = workflowActions.onRun;
            if (!onRun || !availability.run.available) return;
            void runWorkflowAction(
              entry,
              () => onRun(entry),
              `Couldn't start ${entry.name}`,
            );
          }}
          onToggle={() => {
            const onSetEnabled = workflowActions.onSetEnabled;
            if (!onSetEnabled || enabled === undefined) return;
            // The switch never flips locally; it re-renders from `entries`.
            void runWorkflowAction(
              entry,
              () => onSetEnabled(entry, !enabled),
              `Couldn't turn ${enabled ? 'off' : 'on'} ${entry.name}`,
            );
          }}
        />
      );
    },
    [workflowActions, workflowBusyIds, runWorkflowAction],
  );

  // Only a ready, removable status with a target offers removal (CAN-4840).
  function renderRemovalDialog(): ReactNode {
    const onUninstall = entryStatus?.onUninstall;
    if (!activeRemoval || !onUninstall) return null;
    const { entry, target, description } = activeRemoval;
    const verb = removalVerb(entry);
    return (
      <UninstallConfirmDialog
        title={removalConfirmTitle(entry)}
        message={
          entry.kind === 'collection'
            ? 'This removes the collection grouping. Skills, plugins and MCP servers you already use are kept.'
            : (description ?? `This removes ${entry.name}.`)
        }
        confirmLabel={verb}
        busyLabel={removalBusyLabel(verb)}
        fallbackErrorMessage={removalFallbackError(verb)}
        dataTestId="customize-row-remove-dialog"
        confirmTestId="customize-row-remove-confirm"
        cancelTestId="customize-row-remove-cancel"
        onConfirm={async (): Promise<string | null> => {
          const outcome = await onUninstall(target);
          return outcome.ok
            ? null
            : (outcome.message ?? removalFallbackError(verb));
        }}
        onCancel={(): void => setRemoval(null)}
        onUninstalled={(): void => {
          setRemoval(null);
          entryStatus.onUninstalled?.(entry);
        }}
      />
    );
  }

  const renderUpdateAction = useCallback(
    function renderUpdateAction(entry: UnifiedPluginEntry): ReactNode {
      const updating = busyIds.has(entry.id);
      const version = displayVersion(entry.latestVersion);
      const reason = updateDisabledReason?.(entry);
      const explanation =
        reason ??
        (entry.ref.type === 'local-collection'
          ? 'Updating replaces the items in this collection with the shared version. Resources you already use are kept.'
          : undefined);
      const summary = collectionUpdateSummaries?.get(entry.id);
      const date = formatDateOrEmpty(entry.sharedSource?.updatedAt);
      const updateTooltip = [
        summary ?? (version ? `Update to ${version}` : 'Update available'),
        date,
        reason ?? 'Click to update',
        reason ? undefined : explanation,
      ]
        .filter(Boolean)
        .join(' · ');
      return (
        <Tooltip
          label={<span className={REPLAY_BLOCK_CLASS}>{updateTooltip}</span>}
          contentClassName="max-w-sm whitespace-normal break-words"
        >
          <Button
            iconOnly
            size="sm"
            variant="ghost-quiet"
            data-testid={`customize-update-${entry.id}`}
            aria-label={`Update ${entry.name}`}
            disabled={updating || batchRunning || !!reason}
            aria-disabled={!!reason || undefined}
            aria-description={explanation}
            aria-busy={updating}
            onClick={() => void updateOne(entry)}
          >
            <DownloadIcon size="sm" aria-hidden="true" />
          </Button>
        </Tooltip>
      );
    },
    [
      busyIds,
      updateDisabledReason,
      collectionUpdateSummaries,
      batchRunning,
      updateOne,
    ],
  );

  const renderRow = useCallback(
    function renderRow(
      entry: UnifiedPluginEntry,
      section: Pick<CustomizeSectionModel, 'id' | 'showEntryTypes'>,
    ): ReactNode {
      const signIn = onConnectEntry ? signInTarget(entry) : undefined;
      const connect =
        onConnectEntry && signIn
          ? (): void => onConnectEntry(signIn)
          : undefined;
      const statusState =
        entryStatus?.states[entry.installedEntryId ?? entry.id];
      // Dimming follows the live status, its plugin's for a bundled skill.
      const dimmingState = entryStatus?.states[statusEntryIdOf(entry)];
      // Real installed servers only: a server behind its plugin keeps the
      // plugin's flow, and a provider-managed one keeps its own wording.
      const mcpConnection =
        mcpRowActions &&
        section.id === 'installed' &&
        entry.kind === 'app' &&
        entry.bundledBy === undefined
          ? (entry.connection ?? entry.aggregateConnection)
          : undefined;
      const mcpHealth =
        mcpRowActions && mcpConnection && mcpConnection.provider !== true
          ? ((): McpRowPresentation => {
              const test = mcpRowActions.test(entry);
              const connectAction = mcpRowActions.connect(entry);
              const pending = mcpRowActions.pending?.(entry);
              const model = mcpRowHealthModel(mcpConnection, {
                disabled:
                  entry.aggregateConnection === undefined &&
                  dimmingState?.kind === 'ready' &&
                  dimmingState.item.status === 'disabled',
                canTest: test.available,
              });
              const busy = mcpRowBusyIds.has(entry.id) || pending !== undefined;
              const severalConnections = mcpHasMultipleTargets(entry);
              const signsIn =
                model.action === 'connect' || model.action === 'reconnect';
              const connectLabel =
                model.action === 'reconnect' ? 'Reconnect' : 'Connect';
              // Reserve inline actions for attention; routine tests live in
              // the menu so narrow grid rows keep their normal height.
              const attention = signsIn && model.tone === 'attention';
              const inline =
                !attention && pending === undefined
                  ? undefined
                  : severalConnections
                    ? {
                        label: 'Open details',
                        busyLabel: 'Open details',
                        accessibleName: `Open details for ${entry.name}`,
                        busy: false,
                        onClick: (): void => onSelectEntry(entry),
                      }
                    : connectAction.available || pending !== undefined
                      ? {
                          label: connectLabel,
                          busyLabel: 'Connecting…',
                          accessibleName: `${connectLabel} ${entry.name}`,
                          busy,
                          onClick: (): void => {
                            if (connectAction.available)
                              void runMcpRowAction(entry, connectAction.run);
                          },
                        }
                      : undefined;
              const checkedLabel =
                model.checkedAt !== undefined && mcpRowActions.formatTimestamp
                  ? `Checked ${mcpRowActions.formatTimestamp(model.checkedAt)}`
                  : undefined;
              return {
                connectLabel,
                cancelSignIn: pending?.onCancel,
                connectRun:
                  signsIn && inline === undefined && connectAction.available
                    ? (): void => {
                        if (severalConnections) onSelectEntry(entry);
                        else void runMcpRowAction(entry, connectAction.run);
                      }
                    : undefined,
                connectReason:
                  signsIn && !severalConnections && !connectAction.available
                    ? connectAction.reason
                    : undefined,
                node: pending?.authorizationUrl ? (
                  <McpSignInPendingStatus
                    serviceName={entry.name}
                    dataTestId={`customize-row-health-${entry.id}`}
                  />
                ) : (
                  <McpRowHealth
                    model={
                      busy
                        ? { ...model, text: 'Checking…', tone: 'neutral' }
                        : model
                    }
                    testId={`customize-row-health-${entry.id}`}
                    checkedLabel={checkedLabel}
                  />
                ),
                inlineAction: pending?.authorizationUrl ? (
                  <McpSignInPendingActions
                    variant="compact"
                    serviceName={entry.name}
                    authorizationUrl={pending.authorizationUrl}
                    onCancel={pending.onCancel}
                    dataTestId={`customize-row-sign-in-${entry.id}`}
                  />
                ) : (
                  inline && (
                    <Button
                      type="button"
                      size="compact"
                      variant="secondary"
                      disabled={inline.busy}
                      aria-label={inline.accessibleName}
                      aria-busy={inline.busy}
                      data-testid={`customize-row-health-${entry.id}-action`}
                      onClick={inline.onClick}
                    >
                      {inline.busy ? inline.busyLabel : inline.label}
                    </Button>
                  )
                ),
              };
            })()
          : undefined;
      // A row with a connection badge already shows its one status; a
      // read-only Unavailable beside "Connected" would contradict it. The
      // section's unavailable notice explains the missing desktop (CAN-4261).
      // A never-checked connection shows no badge, so it keeps the status.
      const showsConnectionBadge =
        mcpHealth !== undefined ||
        (entry.connection !== undefined &&
          entry.connection.status !== 'unknown');
      const showStatusControl =
        statusState !== undefined &&
        !(statusState.kind === 'read-only' && showsConnectionBadge);
      const collection = entry.kind === 'collection';
      const installed =
        entry.state !== 'available' ||
        entry.installedEntryId !== undefined ||
        statusState?.kind === 'ready' ||
        statusState?.kind === 'fixed' ||
        entry.installedVia !== undefined ||
        entry.bundledBy !== undefined;
      const updateEntry = entries.find(
        (candidate) =>
          candidate.id === (entry.installedEntryId ?? entry.id) &&
          updateIds.has(candidate.id),
      );
      const updateReason = updateDisabledReason?.(entry);
      // An MCP row a plugin provides opens that plugin, where it connects.
      const providerPlugin = providerPluginOf(entry);
      const missingProvider =
        mcpEntryPluginLink(entry) !== undefined && providerPlugin === undefined;
      const mcpMenu = mcpConnection ? (mcpHealth ?? {}) : undefined;
      const row = (unshareItem?: CustomizeRowMenuItem): ReactNode => (
        <CustomizeInstalledRow
          entry={entry}
          sectionId={section.id}
          primaryTestId={
            section.id === 'browse' ? `plugins-entry-${entry.id}` : undefined
          }
          menuTestId={
            section.id === 'browse'
              ? `plugins-entry-menu-${entry.id}`
              : undefined
          }
          selected={entry.id === selectedEntryId}
          showEntryType={section.showEntryTypes}
          onSelect={(selected) =>
            providerPlugin
              ? openPlugin(providerPlugin)
              : missingProvider
                ? undefined
                : onSelectEntry(selected)
          }
          href={
            missingProvider
              ? undefined
              : hrefForEntry?.(providerPlugin ?? entry)
          }
          menuItems={[
            ...menuItems(
              entry,
              section.id,
              mcpHealth ? undefined : connect,
              mcpMenu,
            ),
            ...(unshareItem ? [unshareItem] : []),
          ]}
          status={
            isBundledSkill(entry) ? (
              <span
                data-testid="customize-row-status-slot"
                className="flex min-w-28 shrink-0 justify-start"
              >
                {dimmingState?.kind === 'ready' &&
                dimmingState.item.status !== null ? (
                  <InstalledItemStatusPicker
                    itemName={entry.name}
                    status={dimmingState.item.status}
                    disabledReason={bundledSkillStatusReason(
                      entry.bundledBy.name,
                    )}
                    testId={`plugins-entry-status-${entry.id}`}
                  />
                ) : dimmingState?.kind === 'loading' && entryStatus ? (
                  <InstalledItemStatusControl
                    itemName={entry.name}
                    state={dimmingState}
                    pendingKeys={entryStatus.pendingKeys}
                    testId={`plugins-entry-status-${entry.id}`}
                  />
                ) : (
                  <InstalledItemStatusUnavailable
                    itemName={entry.name}
                    reason={bundledSkillStatusReason(entry.bundledBy.name)}
                    testId={`plugins-entry-status-${entry.id}-unavailable`}
                  />
                )}
              </span>
            ) : section.id === 'browse' && entry.installedVia ? (
              // Keep Open plugin short; Installed via <plugin> is in the subtitle.
              <span className="flex shrink-0 justify-end">
                <Button
                  size="compact"
                  type="button"
                  variant="secondary"
                  className="max-w-full"
                  data-testid={`plugins-entry-installed-via-${entry.id}`}
                  aria-label={`Open plugin ${entry.installedVia.name}`}
                  disabled={providerPlugin === undefined}
                  onClick={() => {
                    if (providerPlugin) openPlugin(providerPlugin);
                  }}
                >
                  Open plugin
                </Button>
              </span>
            ) : section.id === 'browse' && !installed && onAddEntry ? (
              <span className="flex w-36 shrink-0 justify-end">
                <Button
                  size="compact"
                  type="button"
                  data-testid={`plugins-entry-add-${entry.id}`}
                  aria-label={`${collection ? 'Add' : 'Install'} ${entry.name}`}
                  onClick={() => onAddEntry(entry)}
                >
                  {collection ? 'Add' : 'Install'}
                </Button>
              </span>
            ) : (
              (renderStatus?.(entry) ??
              renderWorkflowControls(entry) ??
              (entryStatus && showStatusControl ? (
                <span
                  data-testid="customize-row-status-slot"
                  className="flex min-w-28 shrink-0 justify-start"
                >
                  <InstalledItemStatusControl
                    itemName={entry.name}
                    state={statusState}
                    pendingKeys={entryStatus.pendingKeys}
                    onSetStatus={entryStatus.onSetStatus}
                    onError={entryStatus.onError}
                    testId={`plugins-entry-status-${entry.id}`}
                  />
                </span>
              ) : undefined))
            )
          }
          McpServerLogoComponent={McpServerLogoComponent}
          health={mcpHealth?.node}
          inlineAction={mcpHealth?.inlineAction}
          placement={mcpHealth ? entry.placement : undefined}
          onConnect={connect}
          connectName={signIn?.name}
          // Dimming follows the live status, not the filter snapshot.
          dimmed={
            section.id === 'installed' &&
            dimmingState?.kind === 'ready' &&
            dimmingState.item.status === 'disabled'
          }
          actions={
            section.id === 'browse' &&
            installed &&
            (updateEntry || (collection && entry.updateAvailable)) &&
            (onUpdateEntry || updateReason)
              ? renderUpdateAction(updateEntry ?? entry)
              : (section.id === 'updates' && (onUpdateEntry || updateReason)) ||
                  (section.id === 'installed' &&
                    updateIds.has(entry.id) &&
                    onUpdateEntry)
                ? renderUpdateAction(entry)
                : undefined
          }
        />
      );
      return section.id === 'shared-by-me'
        ? (renderSharedActions?.(entry, row) ?? row())
        : row();
    },
    [
      onConnectEntry,
      signInTarget,
      entryStatus,
      entries,
      updateIds,
      updateDisabledReason,
      selectedEntryId,
      onSelectEntry,
      providerPluginOf,
      openPlugin,
      mcpRowActions,
      mcpRowBusyIds,
      runMcpRowAction,
      hrefForEntry,
      menuItems,
      onAddEntry,
      renderStatus,
      renderWorkflowControls,
      McpServerLogoComponent,
      onUpdateEntry,
      renderUpdateAction,
      renderSharedActions,
    ],
  );

  function renderInstalled(section: CustomizeSectionModel): ReactNode {
    const state = section.inventoryState ?? 'ready';
    return (
      <>
        {customizeTabHasInstalledStatuses(tab) &&
          state === 'ready' &&
          // Rows carry no status control when the host cannot read statuses.
          installedStatusInventory !== 'unavailable' &&
          (section.entries.length > 0 || statusFilter !== undefined) && (
            <p
              data-testid="customize-installed-status-description"
              className="mt-3 text-xs fg-tertiary"
            >
              {INSTALLED_ITEM_STATUS_DESCRIPTION_LINE}
              {tab === 'app' && section.footnote ? ` ${section.footnote}` : ''}
            </p>
          )}
        {state === 'ready' &&
          section.entries.length === 0 &&
          (emptyState && !searchActive && !statusFilter ? (
            emptyState
          ) : (
            <EmptyStateRow
              testId="customize-installed-empty"
              title={
                statusFilter
                  ? searchActive
                    ? searchEmptyMessage
                    : installedStatusFilterEmptyText(statusFilter)
                  : tab === 'collection'
                    ? 'No collections yet. Add a collection to group items you use together.'
                    : 'Nothing is installed yet. Browse below to add an item.'
              }
            />
          ))}
        {section.entries.length > 0 && (
          <CustomizeInstalledList
            sectionId={section.id}
            entries={section.entries}
            previewLimit={section.previewLimit}
            onShowAll={() => {
              setExpansion({ scope: expansionScope, expanded: true });
              onInstalledExpandedChange?.(true);
            }}
            renderRow={(entry) => renderRow(entry, section)}
          />
        )}
        {section.installedFootnote !== undefined && (
          <p
            data-testid="customize-installed-footnote"
            className="mt-2 text-xs fg-tertiary"
          >
            {section.installedFootnote}
          </p>
        )}
        {section.footnote &&
          tab !== 'collection' &&
          (tab !== 'app' || installedStatusInventory === 'unavailable') &&
          state === 'ready' &&
          section.entries.length > 0 && (
            <p
              data-testid="customize-installed-footnote"
              className="mt-3 text-xs fg-tertiary"
            >
              {section.footnote}
            </p>
          )}
        {state === 'loading' && section.entries.length === 0 && (
          <p
            role="status"
            data-testid="customize-installed-loading"
            className="mt-3 px-0 py-3 text-s fg-secondary"
          >
            Loading installed items…
          </p>
        )}
        {state === 'error' && (
          <Notice
            intent="destructive"
            className="mt-3"
            data-testid="customize-installed-error"
            actions={
              onRetryInventory ? (
                <NoticeButton onClick={onRetryInventory}>
                  Try again
                </NoticeButton>
              ) : undefined
            }
          >
            Couldn’t load installed items.
          </Notice>
        )}
        {state === 'unavailable' && (
          <CustomizeInstalledUnavailable
            title={installedUnavailable.title}
            body={installedUnavailable.body}
            action={installedUnavailable.action}
          />
        )}
      </>
    );
  }

  const renderBrowseEntry = useCallback(
    (entry: UnifiedPluginEntry): ReactNode =>
      renderRow(entry, { id: 'browse', showEntryTypes: tab === 'all' }),
    [renderRow, tab],
  );

  function renderBrowse(section: CustomizeSectionModel): ReactNode {
    if (tab === 'collection') {
      return (
        <CustomizeInstalledList
          sectionId={section.id}
          entries={section.entries}
          renderRow={(entry) => renderRow(entry, section)}
        />
      );
    }
    const sections: PluginsDiscoverySection[] = section.groups
      ? section.groups.map((group) =>
          groupSection(group, section.showEntryTypes, onExpandBrowseGroup),
        )
      : [
          {
            id: tab === 'all' ? 'marketplace' : TYPE_TAB_SECTION_IDS[tab],
            title: '',
            entries: [...section.entries],
            showEntryTypes: section.showEntryTypes,
          },
        ];
    return (
      <div className={section.groups ? 'pt-1' : 'pt-3'}>
        <PluginsDiscoveryList
          nested={section.groups !== undefined}
          sections={sections}
          renderEntry={renderBrowseEntry}
          selectedEntryId={selectedEntryId}
          onSelectEntry={onSelectEntry}
          onAddEntry={onAddEntry}
          entryShareStates={entryShareStates}
          onShareEntry={onShareEntry}
          onConnectEntry={onConnectEntry}
          onOpenEntryId={onOpenEntryId}
          emptyMessage={
            section.emptyReason === 'pipeline-filters'
              ? 'No workflows match these filters.'
              : searchEmptyMessage
          }
          McpServerLogoComponent={McpServerLogoComponent}
          hrefForEntry={hrefForEntry}
          entryStatus={entryStatus}
        />
      </div>
    );
  }

  if (loading) return <PluginsDiscoveryListLoading />;

  const remainingBrowseActions =
    tab === 'workflow' &&
    !model.sections.some((section) => section.id === 'browse')
      ? browseActions
      : null;
  if (model.sections.length === 0) {
    const filtered =
      searchActive ||
      !!pipelineCategory ||
      (pipelineFilters !== undefined && pipelineFiltersActive(pipelineFilters));
    return (
      <div data-testid="customize-sections" data-result-count={0}>
        {remainingBrowseActions}
        {filtered ? (
          <SearchEmptyState
            testId="customize-sections-empty"
            title={searchEmptyMessage}
            actionLabel={searchActive ? 'Clear search' : undefined}
            onAction={searchActive ? onClearSearch : undefined}
            actionTestId="customize-sections-clear-search"
          />
        ) : !emptyState ? (
          <p
            data-testid="customize-sections-empty"
            className="py-10 text-center text-s fg-secondary"
          >
            {emptyMessage}
          </p>
        ) : (
          emptyState
        )}
      </div>
    );
  }

  return (
    <Stack
      data-testid="customize-sections"
      data-result-count={model.resultCount}
      gap="hero"
    >
      {searchActive && (
        <p
          data-testid="customize-result-count"
          aria-live="polite"
          className="sr-only"
        >
          {model.resultCount === 1
            ? '1 result'
            : `${model.resultCount} results`}
        </p>
      )}
      {model.sections.map((section) => (
        <CustomizeSection
          key={section.id}
          domId={section.domId}
          title={section.title}
          count={
            // An unread inventory is unknown, not zero.
            section.count === 0 &&
            (section.inventoryState ?? 'ready') !== 'ready'
              ? undefined
              : section.count
          }
          footnote={tab === 'collection' ? section.footnote : undefined}
          actions={
            section.id === 'updates' && model.showUpdateAll && onUpdateEntry ? (
              <Button
                type="button"
                size="compact"
                data-testid="customize-update-all"
                disabled={batchRunning || busyIds.size > 0}
                aria-busy={batchRunning}
                onClick={() => void updateAll()}
              >
                {batchRunning ? 'Updating…' : 'Update all'}
              </Button>
            ) : section.id === 'installed' ? (
              <div className="flex items-center gap-2">
                {installedActions}
                {tab === 'collection' && onCreateCollection && (
                  <Button
                    size="compact"
                    type="button"
                    data-testid="customize-add-collection"
                    onClick={onCreateCollection}
                    variant="secondary"
                  >
                    Add collection
                  </Button>
                )}
              </div>
            ) : section.id === 'browse' && tab === 'workflow' ? (
              browseActions
            ) : undefined
          }
        >
          {section.id === 'installed' ? (
            renderInstalled(section)
          ) : section.id === 'browse' ? (
            renderBrowse(section)
          ) : (
            <CustomizeInstalledList
              sectionId={section.id}
              entries={section.entries}
              renderRow={(entry) => renderRow(entry, section)}
            />
          )}
        </CustomizeSection>
      ))}
      {remainingBrowseActions}
      {deleteTarget && (
        <UninstallConfirmDialog
          title={`Delete "${deleteTarget.name}"?`}
          message="This cannot be undone."
          confirmLabel="Delete"
          busyLabel="Deleting…"
          fallbackErrorMessage={`Couldn't delete ${deleteTarget.name}`}
          dataTestId="customize-workflow-delete"
          confirmTestId="customize-workflow-delete-confirm"
          cancelTestId="customize-workflow-delete-cancel"
          onConfirm={() => deleteWorkflow(deleteTarget)}
          onUninstalled={() => setDeleteTarget(null)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {renderRemovalDialog()}
    </Stack>
  );
}
