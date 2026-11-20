import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { MARKETPLACE_SHARE_BLOCKED_REASONS } from '@canopy/protocol/sharing';
import { MCP_MANAGEMENT_REASONS } from '@canopy/ui-shared/lib/mcp-card-display';
import {
  type ComponentType,
  type JSX,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  InstalledItemStatus,
  InstalledItemUninstallTarget,
} from '@canopy/protocol/installed-items';
import { useOptionalCanopyClient } from '@canopy/app-state';
import { isFeatureSurfaceAvailable } from '@canopy/app-core/gating';
import {
  Stack,
  CustomizeInstalledList,
  CustomizeInstalledRow,
  type CustomizeInstalledRowProps,
  CustomizeInstalledUnavailable,
  CustomizeSection,
  Tooltip,
  InstalledItemStatusControl,
  InstalledItemStatusPicker,
  Button,
  CenteredLoadingSpinner,
  Count,
  DelayedLoadingPlaceholder,
  InstalledItemStatusUnavailable,
  McpRowHealth,
  McpRowCheckFeedback,
  McpSignInPendingActions,
  McpSignInPendingLine,
  McpSignInPendingStatus,
  Notice,
  NoticeButton,
  PluginsDiscoveryList,
  MarketplaceInstallButton,
  marketplaceListingMenuItems,
  marketplaceShareMenuItems,
  PluginsDiscoveryListLoading,
  SearchEmptyState,
  UninstallConfirmDialog,
  type CustomizeRowMenuItem,
  type CustomizeRowSplitAction,
  type CustomizeRowFailure,
  type CustomizeRowSignIn,
  type CustomizeRowUpdate,
  type PluginsEntryStatusBinding,
  type McpServerLogoProps,
  EmptyStateRow,
} from '@canopy/ui-shared/components';
import { DownloadIcon } from '@canopy/ui-shared/icons';
import { displayVersion } from '@canopy/ui-shared/lib/display-version';
import type { HostAction } from '@canopy/ui-shared/lib/host-action';
import {
  mcpHasMultipleTargets,
  mcpRowHasDeviceServer,
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
  customizeDiscoveryFilterCount,
  customizeDiscoveryFiltersForTab,
  customizeDiscoverySourceOptions,
  type CustomizeDefaultHarness,
  DEFAULT_CUSTOMIZE_DISCOVERY_FILTERS,
  LOADING_PLACEHOLDER_DELAY_MS,
  SLOW_LOAD_NOTE_DELAY_MS,
} from '@canopy/ui-shared/lib';
import {
  useCustomizeDiscoveryEnabled,
  useCustomizeDiscoveryFilters,
  useCustomizeSharedWithMe,
  usePublishCustomizeDiscoverySourceOptions,
  usePublishCustomizeSharedWithMe,
} from './CustomizeDiscoveryProvider';
import {
  buildCustomizeTabModel,
  entryHasUpdate,
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
import { customizeRowAction } from './customizeRowAction';
import { bundledServerStandsBehindPlugin } from './unifiedPluginEntries';
import { useCustomizeResultsTelemetry } from './customizeTelemetry';

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
  /**
   * Resolves `'opened'` when it only opened the row's details (several
   * targets to pick from) instead of testing a connection.
   */
  readonly test: (
    entry: UnifiedPluginEntry,
  ) => HostAction<() => Promise<void | 'opened'>>;
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
  /**
   * Whether a row with several configurations can be reconnected from its
   * details: a connection test, or a picker for the configuration to test.
   * Omitted: it can. A row whose details can't shows no Reconnect.
   */
  readonly reconnectsInDetails?: (entry: UnifiedPluginEntry) => boolean;
  /**
   * Whether the details a row's Delete… opens can delete its device server.
   * Omitted: they can. A row whose details only remove its account
   * connections says Remove… instead; a disabled item opens nothing and
   * keeps Delete….
   */
  readonly removesDeviceServer?: (entry: UnifiedPluginEntry) => boolean;
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
  /**
   * The attention sign-in the inline button runs, for New Customize's split
   * control (CAN-6813). Absent while a sign-in waits in the browser.
   */
  readonly signIn?: {
    readonly busy: boolean;
    readonly run: () => void;
  };
  readonly connectRun?: () => void;
  readonly cancelSignIn?: () => void;
  /** New Customize: "✕ Couldn't connect · Reconnect" on the status line. */
  readonly unreachable?: CustomizeRowFailure;
}

/** How long a passed Test connection reads "Connected" on the row. */
const MCP_TEST_CONNECTED_MS = 3000;

/** The longest New Customize's first-load spinner waits for the reads. */
const SETTLE_DEADLINE_MS = 15_000;

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
  /**
   * New Customize (CAN-6811): the harness whose copy an integration row
   * shows and installs. Claude Code when the host cannot read it.
   */
  readonly defaultHarness?: CustomizeDefaultHarness;

  readonly selectedEntryId?: string | null;
  readonly onSelectEntry: (entry: UnifiedPluginEntry) => void;
  readonly hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
  readonly onAddEntry?: (entry: UnifiedPluginEntry) => void;
  readonly onConnectEntry?: (entry: UnifiedPluginEntry) => void;
  /**
   * New Customize (CAN-6815): stage one harness that refused an MCP server
   * again. Hosts that cannot leave it out, and rows only say why.
   */
  readonly onRetryHarnessInstall?: CustomizeInstalledRowProps['onRetryHarnessInstall'];
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
  /**
   * True while a host read that adds installed rows outside
   * `installedInventory` (the web's account MCP connections) is on its way.
   * Only New Customize's first-load spinner waits on it.
   */
  readonly installedRowsPending?: boolean;
  /**
   * What follows the list (the web's Show more and pages). New Customize
   * holds it back with the list behind the first-load spinner.
   */
  readonly afterList?: ReactNode;
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

/**
 * A failed status change, named by where it was going: Active turns on,
 * Disabled turns off, and Available is neither. The retry repeats the
 * change, so it names the direction too.
 */
function statusFailureCopy(
  next: InstalledItemStatus,
): Pick<CustomizeRowFailure, 'label' | 'retryLabel'> {
  switch (next) {
    case 'active':
      return { label: "Couldn't turn on", retryLabel: 'Try turning on again' };
    case 'disabled':
      return {
        label: "Couldn't turn off",
        retryLabel: 'Try turning off again',
      };
    case 'available':
      return {
        label: "Couldn't make it available",
        retryLabel: 'Try making it available again',
      };
    default: {
      const unhandled: never = next;
      return unhandled;
    }
  }
}

/** Why an MCP row's Delete is off; loading or unknown states give no reason. */
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

/** When the first-load spinner on screen began, shared by the spinners. */
interface FirstLoadClock {
  /** How long the spinner on screen has waited; 0 with none mounted. */
  readonly elapsed: () => number;
  /** Counts a mounted spinner; returns its release. */
  readonly hold: () => () => void;
}

function createFirstLoadClock(): FirstLoadClock {
  let startedAt: number | null = null;
  let holders = 0;
  let reset: ReturnType<typeof setTimeout> | undefined;
  return {
    elapsed: () => (startedAt === null ? 0 : Date.now() - startedAt),
    hold: () => {
      clearTimeout(reset);
      startedAt ??= Date.now();
      holders += 1;
      return (): void => {
        holders -= 1;
        // A spinner mounted in the same commit keeps the start time.
        if (holders === 0)
          reset = setTimeout(() => {
            startedAt = null;
          }, 0);
      };
    },
  };
}

const FirstLoadClockContext = createContext<FirstLoadClock | null>(null);

/**
 * Lets a first-load spinner that replaces another one (the web's first-screen
 * placeholder handing over to the list) carry on from it: it waits out only
 * the rest of the delay, so the spinner never blinks off between them.
 */
export function CustomizeFirstLoadContinuity({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const [clock] = useState(createFirstLoadClock);
  return (
    <FirstLoadClockContext.Provider value={clock}>
      {children}
    </FirstLoadClockContext.Provider>
  );
}

/**
 * New Customize's first-load placeholder: one centered spinner in place of
 * the whole list. A host that renders its own placeholder before the list
 * mounts (the web's first-screen region) shows this one too.
 */
export function CustomizeFirstLoadSpinner(): JSX.Element {
  const clock = useContext(FirstLoadClockContext);
  const [elapsed] = useState(() => clock?.elapsed() ?? 0);
  useEffect(() => clock?.hold(), [clock]);
  return (
    <div data-testid="customize-installed-loading">
      <DelayedLoadingPlaceholder
        delayMs={Math.max(0, LOADING_PLACEHOLDER_DELAY_MS - elapsed)}
        slowNote="Still loading installed items…"
        slowAfterMs={Math.max(0, SLOW_LOAD_NOTE_DELAY_MS - elapsed)}
      >
        <CenteredLoadingSpinner spacing="section" />
      </DelayedLoadingPlaceholder>
    </div>
  );
}

/**
 * What an empty list says past the deadline while a first read is still
 * pending: the host's empty state would claim there is nothing yet.
 */
function CustomizeStillLoading(): JSX.Element {
  return (
    <p
      data-testid="customize-sections-pending"
      aria-live="polite"
      className="py-10 text-center text-s fg-secondary"
    >
      Still loading installed items…
    </p>
  );
}

interface CustomizeFirstLoadHold {
  /** A first read New Customize waits on is still on its way. */
  readonly readsPending: boolean;
  readonly deadlinePassed: boolean;
  /** The spinner shows in place of the list and what follows it. */
  readonly holdForSettle: boolean;
}

function useCustomizeFirstLoadHold({
  tab,
  loading = false,
  installedInventory,
  installedStatusInventory,
  focusPending = false,
  installedRowsPending = false,
}: CustomizeTabSectionsProps): CustomizeFirstLoadHold {
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  // Only the first inventory read holds; `installedRowsPending` is read live.
  const inventoryLoading =
    loading || installedInventory === 'loading' || focusPending;
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  if (!inventoryLoading && !inventoryLoaded) setInventoryLoaded(true);
  // The status read holds only tabs that show statuses, so it keeps its own
  // first-read latch: a tab without them can't use up a status tab's hold.
  const statusLoading = installedStatusInventory === 'loading';
  const [statusLoaded, setStatusLoaded] = useState(false);
  if (!statusLoading && !statusLoaded) setStatusLoaded(true);
  const readsPending =
    discoveryEnabled &&
    ((inventoryLoading && !inventoryLoaded) ||
      (customizeTabHasInstalledStatuses(tab) &&
        statusLoading &&
        !statusLoaded) ||
      installedRowsPending);
  // One deadline per mount, armed by the first hold and kept across tabs.
  const [deadlineArmed, setDeadlineArmed] = useState(false);
  const [deadlinePassed, setDeadlinePassed] = useState(false);
  const holdForSettle = readsPending && !deadlinePassed;
  if (holdForSettle && !deadlineArmed) setDeadlineArmed(true);
  useEffect(() => {
    if (!deadlineArmed) return undefined;
    const timer = setTimeout(() => setDeadlinePassed(true), SETTLE_DEADLINE_MS);
    return (): void => clearTimeout(timer);
  }, [deadlineArmed]);
  return { readsPending, deadlinePassed, holdForSettle };
}

/**
 * The Customize page body shared by desktop and web: Updates, Installed,
 * Shared by me and Browse, in that order. Hosts supply reads and actions.
 */
export function CustomizeTabSections({
  afterList,
  ...props
}: CustomizeTabSectionsProps): JSX.Element {
  const hold = useCustomizeFirstLoadHold(props);
  return (
    <>
      <CustomizeTabSectionsBody {...props} hold={hold} />
      {hold.holdForSettle ? null : afterList}
    </>
  );
}

function CustomizeTabSectionsBody(
  props: CustomizeTabSectionsProps & { readonly hold: CustomizeFirstLoadHold },
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
    defaultHarness,
    selectedEntryId = null,
    onSelectEntry,
    hrefForEntry,
    onAddEntry,
    onConnectEntry,
    onRetryHarnessInstall,
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
    browseActions: hostBrowseActions,
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
    hold: { readsPending, deadlinePassed, holdForSettle },
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

  // New Customize's funnel and pills narrow the list; its item-status pill
  // uses the host's Installed status filter. Off, both read as before.
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  // New Customize keeps the Workflows filters in the one filter menu and
  // drops the separate refresh, so the old filter row never shows (Sergii's
  // QA). Flag off keeps it.
  const browseActions = discoveryEnabled ? undefined : hostBrowseActions;
  const { filters: currentDiscoveryFilters, setFilters: setDiscoveryFilters } =
    useCustomizeDiscoveryFilters();
  const discoveryFilters = discoveryEnabled
    ? currentDiscoveryFilters
    : undefined;
  usePublishCustomizeDiscoverySourceOptions(
    useMemo(
      () =>
        discoveryEnabled ? customizeDiscoverySourceOptions(entries) : null,
      [discoveryEnabled, entries],
    ),
  );
  // Shared with me (CAN-6810): the toggle narrows the list, and the counter
  // reads every share from others, whatever the tab.
  const { active: sharedWithMeActive, setActive: setSharedWithMeActive } =
    useCustomizeSharedWithMe();
  const sharedWithMeOnly = discoveryEnabled && sharedWithMeActive;
  // The counter counts only kinds this host lists. Entries may be a search
  // result or one page of shares; the provider's registry only adds them.
  usePublishCustomizeSharedWithMe(
    useMemo(
      () =>
        discoveryEnabled
          ? entries.filter(
              (entry) =>
                (entry.kind !== 'agent' || agentsAvailable === true) &&
                (entry.kind !== 'blueprint' ||
                  projectTemplatesAvailable === true),
            )
          : null,
      [discoveryEnabled, entries, agentsAvailable, projectTemplatesAvailable],
    ),
    contextKey,
  );
  const effectiveStatusFilter = effectiveInstalledStatusFilter(
    tab,
    installedStatusFilter,
    supportedUpdateKinds,
  );
  // New Customize's Status pill sets Active, Available or Disabled through
  // this same filter; Update available has no pill, so a stored one is ignored.
  const statusFilter =
    discoveryEnabled && effectiveStatusFilter === 'update-available'
      ? undefined
      : effectiveStatusFilter;
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
        ...(discoveryFilters ? { discoveryFilters } : {}),
        ...(sharedWithMeOnly ? { sharedWithMeOnly } : {}),
        ...(defaultHarness ? { defaultHarness } : {}),
      }),
    [
      defaultHarness,
      discoveryFilters,
      sharedWithMeOnly,
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

  // Analytics only (CAN-6806): no visible effect.
  const { trackPick } = useCustomizeResultsTelemetry({
    tab,
    query,
    filters: {
      installedStatusFilter: statusFilter,
      pipelineCategory,
      pipelineFilters,
    },
    model,
    // A search counts only once the reads finished or failed, never on the
    // deadline, so it cannot report a partial count.
    loading: loading || readsPending,
    browseGroupsCollapse: onExpandBrowseGroup !== undefined,
  });
  const selectTrackedEntry = useCallback(
    (entry: UnifiedPluginEntry): void => {
      trackPick(entry, 'open');
      onSelectEntry(entry);
    },
    [trackPick, onSelectEntry],
  );
  const addTrackedEntry = useMemo(
    () =>
      onAddEntry
        ? (entry: UnifiedPluginEntry): void => {
            trackPick(entry, 'add');
            onAddEntry(entry);
          }
        : undefined,
    [trackPick, onAddEntry],
  );
  const connectTrackedEntry = useMemo(
    () =>
      onConnectEntry
        ? (entry: UnifiedPluginEntry): void => {
            trackPick(entry, 'connect');
            onConnectEntry(entry);
          }
        : undefined,
    [trackPick, onConnectEntry],
  );

  // New Customize (Sergii's QA): a failed status change shows on its own
  // tile, never in a page banner. Keyed by row id; a success clears it.
  // Failures belong to the host scope they happened in (the Portal's desktop
  // and project): a scope change drops them, and a late outcome or a Retry
  // from an older scope does nothing.
  const [statusFailures, setStatusFailures] = useState<
    ReadonlyMap<string, CustomizeRowFailure>
  >(() => new Map());
  const statusScope =
    entryStatus?.statusScope ?? entryStatus?.removalScope ?? '';
  const statusScopeRef = useRef(statusScope);
  statusScopeRef.current = statusScope;
  useEffect(() => {
    setStatusFailures((current) => (current.size === 0 ? current : new Map()));
  }, [statusScope]);
  const recordStatusOutcome = useCallback(
    (
      entryId: string,
      scope: string,
      outcome: Parameters<
        NonNullable<Parameters<typeof customizeRowAction>[0]['onStatusOutcome']>
      >[0],
    ): void => {
      if (scope !== statusScopeRef.current) return;
      setStatusFailures((current) => {
        if (outcome.ok && !current.has(entryId)) return current;
        const next = new Map(current);
        if (outcome.ok) next.delete(entryId);
        else
          next.set(entryId, {
            ...statusFailureCopy(outcome.next),
            reason: outcome.message,
            tone: 'attention',
            retry: (): void => {
              if (scope !== statusScopeRef.current) return;
              setStatusFailures((latest) => {
                const without = new Map(latest);
                without.delete(entryId);
                return without;
              });
              outcome.retry();
            },
          });
        return next;
      });
    },
    [],
  );

  // Refs guard against double submission before React re-renders.
  const inFlight = useRef(new Set<string>());
  const batchRunningRef = useRef(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  // Sections the person folded, by id; the host keeps it for the visit.
  const [foldedSections, setFoldedSections] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const toggleFoldedSection = (id: string): void =>
    setFoldedSections((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
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
  const batchableIds = useMemo(
    () => new Set(model.batchableUpdates.map((entry) => entry.id)),
    [model.batchableUpdates],
  );
  const runBatch = useCallback(
    async (batch: readonly UnifiedPluginEntry[]): Promise<void> => {
      if (
        batchRunningRef.current ||
        inFlight.current.size > 0 ||
        !onUpdateEntry
      )
        return;
      batchRunningRef.current = true;
      setBatchRunning(true);
      const failures: CustomizeUpdateFailure[] = [];
      try {
        // Sequential, continuing past individual failures.
        for (const entry of batch) {
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
    },
    [onUpdateEntry, onUpdateFailures, onUpdatesSettled, runUpdate],
  );
  const updateAll = useCallback(
    (): Promise<void> => runBatch(batchSnapshot),
    [batchSnapshot, runBatch],
  );

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
    // Behind the settle spinner no section exists, so the request waits.
    if (
      !focusSection ||
      !onFocusSectionSettled ||
      loading ||
      focusPending ||
      holdForSettle
    )
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
    holdForSettle,
    focusTargetDomId,
    loading,
    onFocusSectionSettled,
    expansionScope,
    onInstalledExpandedChange,
  ]);

  // Preserve the bound callbacks when filtering leaves update membership unchanged.
  const updateIdKey = model.updateEntryIds.join('\0');
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
      // An integration row signs in to the hidden copy that needs it
      // (CAN-6811), never to its own healthy copy.
      const attentionId = entry.integrationCopies?.attentionCopyId;
      if (attentionId !== undefined) {
        const copy = entries.find((candidate) => candidate.id === attentionId);
        if (
          copy !== undefined &&
          (copy.state === 'needs-auth' || (copy.pendingSignIns ?? 0) > 0)
        )
          return signInTarget(copy);
        return undefined;
      }
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
  /** Runs a row action; true only when it finished without an error. */
  const runMcpRowAction = useCallback(
    async (
      entry: UnifiedPluginEntry,
      action: () => unknown,
    ): Promise<boolean> => {
      if (mcpRowInFlight.current.has(entry.id)) return false;
      mcpRowInFlight.current.add(entry.id);
      setMcpRowBusyIds(new Set(mcpRowInFlight.current));
      try {
        await action();
        return true;
      } catch (error) {
        mcpRowActions?.onError?.(
          error instanceof Error && error.message !== ''
            ? error.message
            : MCP_ROW_ACTION_FAILED,
        );
        return false;
      } finally {
        mcpRowInFlight.current.delete(entry.id);
        setMcpRowBusyIds(new Set(mcpRowInFlight.current));
      }
    },
    [mcpRowActions],
  );

  // New Customize (Sergii's QA): a Test connection the person starts shows
  // "Checking…" on the row, then "Connected" for a few seconds on success.
  // Background checks never touch the row.
  const [mcpUserTests, setMcpUserTests] = useState<
    ReadonlyMap<string, 'checking' | 'done'>
  >(new Map());
  const runUserMcpTest = useCallback(
    async (
      entry: UnifiedPluginEntry,
      run: () => Promise<void | 'opened'>,
    ): Promise<void> => {
      setMcpUserTests((current) => new Map(current).set(entry.id, 'checking'));
      let opened = false;
      const ok = await runMcpRowAction(entry, async () => {
        opened = (await run()) === 'opened';
      });
      // "Connected" only follows a test that ran and finished; a failure
      // shows the row's error state, and opening details tests nothing.
      if (!ok || opened) {
        setMcpUserTests((current) => {
          if (!current.has(entry.id)) return current;
          const next = new Map(current);
          next.delete(entry.id);
          return next;
        });
        return;
      }
      setMcpUserTests((current) => new Map(current).set(entry.id, 'done'));
      window.setTimeout(() => {
        setMcpUserTests((current) => {
          if (current.get(entry.id) !== 'done') return current;
          const next = new Map(current);
          next.delete(entry.id);
          return next;
        });
      }, MCP_TEST_CONNECTED_MS);
    },
    [runMcpRowAction],
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
        label: removalMenuLabel(entry, target),
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
              if (!test.available) return;
              if (discoveryEnabled) void runUserMcpTest(entry, test.run);
              else void runMcpRowAction(entry, test.run);
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
      const shares = marketplaceShareMenuItems(
        entry,
        entryShareStates,
        onShareEntry,
      );
      items.push(...shares);
      if (shares.length === 0 && mcpRow) {
        const share = entryShareStates?.get(entry.id);
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
      }
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
      const removals =
        !workflow && sectionId !== 'shared-by-me'
          ? marketplaceListingMenuItems(entry, removalMenuItem)
          : [];
      items.push(...removals);
      if (removals.length === 0 && mcpRow) {
        const state = entryStatus?.states[entry.id];
        const chooseTarget = mcpHasMultipleTargets(entry);
        items.push({
          id: 'remove',
          // Delete for a device server, as its detail page and dialog say;
          // an account-only row, or one whose details can't delete the
          // device server, only removes the account its details pick.
          label:
            mcpRowHasDeviceServer(entry) &&
            (!chooseTarget ||
              mcpRowActions?.removesDeviceServer?.(entry) !== false)
              ? 'Delete…'
              : 'Remove…',
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
      runUserMcpTest,
      mcpUserTests,
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

  const workflowControls = useCallback(
    function workflowControls(entry: UnifiedPluginEntry) {
      if (!workflowActions || !entry.workflow) return undefined;
      const availability = customizeWorkflowAvailability(
        entry,
        workflowActions,
      );
      const enabled = entry.workflow.enabled;
      return {
        availability,
        busy: workflowBusyIds.has(entry.id),
        onRun: (): void => {
          const onRun = workflowActions.onRun;
          if (!onRun || !availability.run.available) return;
          void runWorkflowAction(
            entry,
            () => onRun(entry),
            `Couldn't start ${entry.name}`,
          );
        },
        onToggle: (): void => {
          const onSetEnabled = workflowActions.onSetEnabled;
          if (!onSetEnabled || enabled === undefined) return;
          // The switch never flips locally; it re-renders from `entries`.
          void runWorkflowAction(
            entry,
            () => onSetEnabled(entry, !enabled),
            `Couldn't turn ${enabled ? 'off' : 'on'} ${entry.name}`,
          );
        },
      };
    },
    [workflowActions, workflowBusyIds, runWorkflowAction],
  );

  const renderWorkflowControls = useCallback(
    function renderWorkflowControls(entry: UnifiedPluginEntry): ReactNode {
      const controls = workflowControls(entry);
      if (!controls) return null;
      return <CustomizeWorkflowRowControls entry={entry} {...controls} />;
    },
    [workflowControls],
  );

  // Only a ready, removable status with a target offers removal (CAN-4840).
  function renderRemovalDialog(): ReactNode {
    const onUninstall = entryStatus?.onUninstall;
    if (!activeRemoval || !onUninstall) return null;
    const { entry, target, description } = activeRemoval;
    const verb = removalVerb(entry, target);
    return (
      <UninstallConfirmDialog
        title={removalConfirmTitle(entry, target)}
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
            variant="ghost"
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
          ? (): void => {
              trackPick(entry, 'connect');
              onConnectEntry(signIn);
            }
          : undefined;
      const statusState =
        entryStatus?.states[entry.installedEntryId ?? entry.id];
      const providerListings = entry.marketplaceListings;
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
              const disabled =
                entry.aggregateConnection === undefined &&
                dimmingState?.kind === 'ready' &&
                dimmingState.item.status === 'disabled';
              const model = mcpRowHealthModel(mcpConnection, {
                disabled,
                canTest: test.available,
              });
              // New Customize: a disabled item shows no health line; its
              // Disabled state says enough (Sergii's QA, item 1).
              // New Customize's line 2 names a connection only when the person
              // must act or something is wrong (Sergii's QA): sign-in and
              // Couldn't connect. Not checked yet, Checking and Connected show
              // the publisher; the detail page keeps the full health.
              const userTest = discoveryEnabled
                ? mcpUserTests.get(entry.id)
                : undefined;
              const unreachable: CustomizeRowFailure | undefined =
                discoveryEnabled &&
                !disabled &&
                mcpConnection.disabled !== true &&
                model.tone === 'destructive' &&
                pending === undefined
                  ? {
                      label: model.text,
                      reason: `${model.text} to ${entry.name}.${
                        model.checkedAt !== undefined &&
                        mcpRowActions.formatTimestamp
                          ? ` Checked ${mcpRowActions.formatTimestamp(model.checkedAt)}.`
                          : ''
                      }`,
                      tone: 'destructive',
                      alongsideSignIn: true,
                      retryLabel: 'Reconnect',
                      retryBusyLabel: 'Reconnecting…',
                      retryBusy:
                        mcpRowBusyIds.has(entry.id) || userTest === 'checking',
                      ...(mcpHasMultipleTargets(entry)
                        ? mcpRowActions.reconnectsInDetails?.(entry) === false
                          ? {}
                          : { retry: (): void => onSelectEntry(entry) }
                        : test.available
                          ? {
                              retry: (): void =>
                                void runUserMcpTest(entry, test.run),
                            }
                          : {}),
                    }
                  : undefined;
              const hideHealth =
                discoveryEnabled &&
                (disabled ||
                  mcpConnection.disabled === true ||
                  unreachable !== undefined ||
                  (model.tone !== 'attention' && model.tone !== 'destructive'));
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
                ...(unreachable ? { unreachable } : {}),
                ...(inline && !pending?.authorizationUrl
                  ? { signIn: { busy: inline.busy, run: inline.onClick } }
                  : {}),
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
                node:
                  userTest === 'checking' ? (
                    <McpRowCheckFeedback
                      kind="checking"
                      testId={`customize-row-health-${entry.id}`}
                    />
                  ) : userTest === 'done' && model.tone === 'positive' ? (
                    <McpRowCheckFeedback
                      kind="connected"
                      testId={`customize-row-health-${entry.id}`}
                    />
                  ) : hideHealth &&
                    !(
                      discoveryEnabled && pending?.authorizationUrl
                    ) ? null : pending?.authorizationUrl ? (
                    discoveryEnabled ? (
                      // One line: spinner, "Signing in…" link and cancel.
                      <McpSignInPendingLine
                        serviceName={entry.name}
                        authorizationUrl={pending.authorizationUrl}
                        onCancel={pending.onCancel}
                        dataTestId={`customize-row-sign-in-${entry.id}`}
                      />
                    ) : (
                      <McpSignInPendingStatus
                        variant="row"
                        serviceName={entry.name}
                        dataTestId={`customize-row-health-${entry.id}`}
                      />
                    )
                  ) : (
                    <McpRowHealth
                      name={entry.name}
                      model={
                        busy && !discoveryEnabled
                          ? { ...model, text: 'Checking…', tone: 'neutral' }
                          : model
                      }
                      testId={`customize-row-health-${entry.id}`}
                      checkedLabel={checkedLabel}
                    />
                  ),
                inlineAction: pending?.authorizationUrl ? (
                  discoveryEnabled ? null : (
                    <McpSignInPendingActions
                      variant="compact"
                      serviceName={entry.name}
                      authorizationUrl={pending.authorizationUrl}
                      onCancel={pending.onCancel}
                      dataTestId={`customize-row-sign-in-${entry.id}`}
                    />
                  )
                ) : (
                  // New Customize's split control runs it (CAN-6813).
                  !discoveryEnabled &&
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
      const statusListings =
        providerListings ?? (showStatusControl ? [entry] : []);
      const installedStatusControls =
        entryStatus &&
        statusListings.flatMap((listing) => {
          const state =
            entryStatus.states[listing.installedEntryId ?? listing.id];
          if (!state) return [];
          const provider = providerListings
            ? listing.marketplaceProvider
            : undefined;
          return (
            <span
              key={listing.id}
              data-testid="customize-row-status-slot"
              className={
                provider
                  ? 'flex shrink-0 items-center gap-1'
                  : 'flex min-w-28 shrink-0 justify-start'
              }
            >
              {provider && (
                <span className="text-xs fg-secondary">{provider}</span>
              )}
              <InstalledItemStatusControl
                itemName={
                  provider ? `${listing.name} (${provider})` : listing.name
                }
                state={state}
                pendingKeys={entryStatus.pendingKeys}
                onSetStatus={entryStatus.onSetStatus}
                onError={entryStatus.onError}
                testId={`plugins-entry-status-${listing.id}`}
              />
            </span>
          );
        });
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
      // New Customize (CAN-6813): one split control for the row's state, its
      // caret holding the row's existing actions.
      // New Customize (Sergii's QA, items 4 and 5): sign-in and updates are
      // said on the row's own lines, never in its split control.
      const updateTarget =
        section.id === 'browse'
          ? installed &&
            (updateEntry ??
              (entry.kind === 'collection' && entry.updateAvailable
                ? entry
                : undefined))
          : section.id === 'installed' && updateIds.has(entry.id)
            ? entry
            : undefined;
      const rowUpdate: CustomizeRowUpdate | undefined = !discoveryEnabled
        ? undefined
        : updateTarget
          ? {
              busy: batchRunning || busyIds.has(updateTarget.id),
              ...(onUpdateEntry &&
              updateDisabledReason?.(updateTarget) === undefined
                ? { run: (): void => void updateOne(updateTarget) }
                : {}),
            }
          : section.id === 'installed' &&
              entryHasUpdate(entry, supportedUpdateKinds)
            ? {}
            : undefined;
      const mcpSignIn = mcpHealth?.signIn;
      const rowSignIn: CustomizeRowSignIn | undefined = !discoveryEnabled
        ? undefined
        : mcpSignIn
          ? {
              accessibleName: `Sign in to ${entry.name}`,
              busy: mcpSignIn.busy,
              run: mcpSignIn.run,
            }
          : !mcpHealth && connect
            ? {
                accessibleName: `Sign in to ${signIn?.name ?? entry.name}`,
                run: connect,
              }
            : undefined;
      const splitAction = ((): CustomizeRowSplitAction | undefined => {
        if (!discoveryEnabled) return undefined;
        return customizeRowAction({
          entry,
          workflow: workflowControls(entry),
          bundledSkill: isBundledSkill(entry)
            ? {
                state:
                  dimmingState?.kind === 'loading' ||
                  (dimmingState?.kind === 'ready' &&
                    dimmingState.item.status !== null)
                    ? dimmingState
                    : undefined,
                reason: bundledSkillStatusReason(entry.bundledBy.name),
              }
            : undefined,
          installedVia:
            section.id === 'browse' && entry.installedVia
              ? {
                  pluginName: entry.installedVia.name,
                  open: providerPlugin
                    ? (): void => openPlugin(providerPlugin)
                    : undefined,
                }
              : undefined,
          add: onAddEntry ? (addTrackedEntry ?? onAddEntry) : undefined,
          installed: installed || section.id !== 'browse',
          statuses: entryStatus
            ? statusListings.flatMap((listing) => {
                const state =
                  entryStatus.states[listing.installedEntryId ?? listing.id];
                return state
                  ? [
                      {
                        listing,
                        state,
                        ...(providerListings && listing.marketplaceProvider
                          ? { provider: listing.marketplaceProvider }
                          : {}),
                      },
                    ]
                  : [];
              })
            : [],
          pendingKeys: entryStatus?.pendingKeys ?? new Set(),
          onSetStatus: entryStatus?.onSetStatus,
          onError: entryStatus?.onError,
          ...(discoveryEnabled
            ? {
                onStatusOutcome: (outcome): void =>
                  recordStatusOutcome(entry.id, statusScope, outcome),
              }
            : {}),
        });
      })();
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
          onSelect={(selected) => {
            if (!missingProvider) trackPick(selected, 'open');
            if (providerPlugin) openPlugin(providerPlugin);
            else if (!missingProvider) onSelectEntry(selected);
          }}
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
                <MarketplaceInstallButton
                  entry={entry}
                  onAdd={addTrackedEntry ?? onAddEntry}
                />
              </span>
            ) : (
              (renderStatus?.(entry) ??
              renderWorkflowControls(entry) ??
              installedStatusControls)
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
          skillMatch={model.skillMatches.get(entry.id)}
          discovery={discoveryEnabled}
          onRetryHarnessInstall={onRetryHarnessInstall}
          splitAction={splitAction}
          signIn={rowSignIn}
          update={rowUpdate}
          failure={
            discoveryEnabled
              ? (statusFailures.get(entry.id) ?? mcpHealth?.unreachable)
              : undefined
          }
          actions={
            section.id === 'browse' &&
            installed &&
            (updateEntry ||
              (entry.kind === 'collection' && entry.updateAvailable)) &&
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
      onRetryHarnessInstall,
      trackPick,
      addTrackedEntry,
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
      runUserMcpTest,
      mcpUserTests,
      hrefForEntry,
      menuItems,
      onAddEntry,
      renderStatus,
      renderWorkflowControls,
      workflowControls,
      batchRunning,
      busyIds,
      updateOne,
      McpServerLogoComponent,
      onUpdateEntry,
      renderUpdateAction,
      renderSharedActions,
      discoveryEnabled,
      statusFailures,
      recordStatusOutcome,
      statusScope,
      supportedUpdateKinds,
      model.skillMatches,
    ],
  );

  function renderInstalled(section: CustomizeSectionModel): ReactNode {
    const state = section.inventoryState ?? 'ready';
    return (
      <>
        {/* New Customize says this under the page title instead. */}
        {!discoveryEnabled &&
          customizeTabHasInstalledStatuses(tab) &&
          state === 'ready' &&
          // Rows carry no status control when the host cannot read statuses.
          installedStatusInventory !== 'unavailable' &&
          (section.entries.length > 0 || statusFilter !== undefined) && (
            <p
              data-testid="customize-installed-status-description"
              className="pt-3 text-xs fg-tertiary"
            >
              {INSTALLED_ITEM_STATUS_DESCRIPTION_LINE}
              {tab === 'app' && section.footnote ? ` ${section.footnote}` : ''}
            </p>
          )}
        {state === 'ready' &&
          section.entries.length === 0 &&
          (readsPending && !searchActive && !statusFilter ? (
            <CustomizeStillLoading />
          ) : emptyState && !searchActive && !statusFilter ? (
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
            className="pt-2 text-xs fg-tertiary"
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
              className="pt-3 text-xs fg-tertiary"
            >
              {section.footnote}
            </p>
          )}
        {state === 'loading' && section.entries.length === 0 && (
          <p
            role="status"
            data-testid="customize-installed-loading"
            className="px-0 pb-3 pt-6 text-s fg-secondary"
          >
            Loading installed items…
          </p>
        )}
        {state === 'error' && (
          <div className="pt-3">
            <Notice
              errorSource="customize-installed-error"
              intent="destructive"
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
          </div>
        )}
        {state === 'unavailable' && (
          <CustomizeInstalledUnavailable
            title={installedUnavailable.title}
            body={installedUnavailable.body}
            action={installedUnavailable.action}
          />
        )}
        {/* The notice covers this device only; account rows may still come. */}
        {(state === 'unavailable' || state === 'error') &&
          section.entries.length === 0 &&
          readsPending &&
          !searchActive &&
          !statusFilter && <CustomizeStillLoading />}
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
          onSelectEntry={selectTrackedEntry}
          onAddEntry={addTrackedEntry}
          entryShareStates={entryShareStates}
          onShareEntry={onShareEntry}
          onConnectEntry={connectTrackedEntry}
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

  // New Customize shows one centered spinner while the first reads are
  // pending, so the page appears whole; past the deadline it renders what has
  // arrived, never the skeleton.
  if (holdForSettle) return <CustomizeFirstLoadSpinner />;

  if (loading && !(readsPending && deadlinePassed))
    return <PluginsDiscoveryListLoading />;

  const remainingBrowseActions =
    tab === 'workflow' &&
    !model.sections.some((section) => section.id === 'browse')
      ? browseActions
      : null;
  if (model.sections.length === 0) {
    const discoveryFiltered =
      discoveryFilters !== undefined &&
      customizeDiscoveryFilterCount(
        customizeDiscoveryFiltersForTab(discoveryFilters, tab),
      ) > 0;
    if (sharedWithMeOnly && !searchActive && !discoveryFiltered)
      return (
        <div data-testid="customize-sections" data-result-count={0}>
          {remainingBrowseActions}
          <SearchEmptyState
            testId="customize-sections-empty"
            title={
              tab === 'all'
                ? 'Nothing has been shared with you yet.'
                : 'Nothing on this tab has been shared with you.'
            }
            actionLabel="Show everything"
            onAction={(): void => setSharedWithMeActive(false)}
            actionTestId="customize-sections-clear-shared"
          />
        </div>
      );
    if (discoveryFiltered && !searchActive)
      return (
        <div data-testid="customize-sections" data-result-count={0}>
          {remainingBrowseActions}
          <SearchEmptyState
            testId="customize-sections-empty"
            title="Nothing matches these filters."
            actionLabel="Clear filters"
            onAction={(): void =>
              setDiscoveryFilters(DEFAULT_CUSTOMIZE_DISCOVERY_FILTERS)
            }
            actionTestId="customize-sections-clear-filters"
          />
        </div>
      );
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
        ) : readsPending ? (
          // Past the deadline (the hold returned above until then).
          <CustomizeStillLoading />
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
          // New Customize lists can run long, so Installed and Browse fold.
          // A search shows everything, so nothing hides a result.
          collapsible={
            discoveryEnabled &&
            !searchActive &&
            (section.id === 'installed' || section.id === 'browse')
              ? {
                  collapsed: foldedSections.has(section.id),
                  onToggle: (): void => toggleFoldedSection(section.id),
                }
              : undefined
          }
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
                {discoveryEnabled && (
                  <CustomizeUpdateAllLink
                    // Only updates that finish when they apply (skills) run
                    // in a batch; an automation's opens its wizard instead.
                    entries={section.entries.filter((entry) =>
                      batchableIds.has(entry.id),
                    )}
                    updateIds={updateIds}
                    canUpdate={(entry) =>
                      onUpdateEntry !== undefined &&
                      updateDisabledReason?.(entry) === undefined
                    }
                    busy={batchRunning || busyIds.size > 0}
                    onUpdateAll={(entries) => void runBatch(entries)}
                  />
                )}
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
      {discoveryEnabled &&
        searchActive &&
        model.skillMatches.size > 0 &&
        model.skillMatches.size === model.resultCount && (
          // The Customize search design (CAN-6812): every result is a plugin a
          // skill matched, so say where the skills went.
          <p
            data-testid="customize-skill-match-hint"
            className="text-s fg-tertiary"
          >
            No other matches. Skills inside plugins are shown with their plugin.
          </p>
        )}
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

/**
 * New Customize's bulk update (Sergii's QA, item 5): a compact secondary
 * button styled like "Add collection", "Update all" with a plain count, on
 * the Installed heading. It batches the skills this Installed list shows, so
 * it appears on tabs that list skills and only while they can update now. It
 * reuses each row's existing update.
 */
function CustomizeUpdateAllLink({
  entries,
  updateIds,
  canUpdate,
  busy,
  onUpdateAll,
}: {
  readonly entries: readonly UnifiedPluginEntry[];
  readonly updateIds: ReadonlySet<string>;
  readonly canUpdate: (entry: UnifiedPluginEntry) => boolean;
  readonly busy: boolean;
  readonly onUpdateAll: (entries: readonly UnifiedPluginEntry[]) => void;
}): JSX.Element | null {
  const updatable = entries.filter(
    (entry) => updateIds.has(entry.id) && canUpdate(entry),
  );
  if (updatable.length === 0) return null;
  return (
    <Button
      type="button"
      size="compact"
      variant="secondary"
      data-testid="customize-update-all"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => onUpdateAll(updatable)}
    >
      {busy ? (
        'Updating…'
      ) : (
        <span className="inline-flex items-center gap-1.5">
          Update all
          <Count value={updatable.length} />
        </span>
      )}
    </Button>
  );
}
