/**
 * AutomationsPanel — the `automations` panel kind's surface, shown to people
 * as the Workflows panel: workflows and watchers scoped to the panel's
 * workspace, in three sections named after the Workflows page's tabs:
 *
 * - **Schedule** (`upcoming`) — scheduled workflow occurrences firing within
 *   the next 10 minutes, padded out to at least 5 entries with later fires.
 * - **Library** (`overview`) — a simplified table of the workspace's
 *   scheduled workflows, its own on-demand workflows (project pipelines) and
 *   its watchers, with type filtering and text search.
 * - **Runs** (`completed`) — the Workflows page's run feed for this
 *   workspace: scheduled and on-demand workflow runs and watchers, with a
 *   workflow's own pipeline run folded into its scheduled run.
 *
 * One component serves all four variants (`instance.variant`): `full` renders
 * every section with collapsible headers; `upcoming` / `overview` /
 * `completed` render exactly one section with no expand/collapse chrome.
 * Every variant shares the same toolbar: a worktree-scope icon toggle (code
 * workspaces only, on by default) and a New workflow button that opens a
 * scheduled workflow draft prefilled to this workspace (and worktree for
 * code).
 *
 * Entry clicks open the automation's runs in the Workflows edit shell
 * (CAN-4072), and the add button opens a new draft there, in the main window
 * even from a pop-out. A pipeline run opens its run panel. Watcher clicks open
 * the {@link WatcherManagementModal} scoped to the clicked watcher.
 */
import { Count, type BadgeTone } from '@canopy/ui-shared/components/Badge';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  AppAdvisorWatcherSummary,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getAutomationTriggerLabel } from '@canopy/desktop-shared/lib/automations';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import {
  Surface,
  Badge,
  Button,
  Notice,
  NoticeButton,
  DataTable,
  IconToggleButton,
  ListRow,
  SearchField,
  SegmentedControl,
  Tooltip,
  type DataTableColumn,
} from '@canopy/ui-shared/components';
import {
  BranchIcon,
  BulletListIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlayCircleIcon,
  PlusIcon,
  ScheduleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { WORKFLOW_KIND_LABELS } from '@canopy/ui-shared/lib/workflow-labels';
import {
  describePipelineTriggers,
  pipelineTriggerKinds,
  WORKFLOW_RUN_STATUS_LABELS,
  type WorkflowRunRow,
  type WorkflowRunStatus,
} from '@canopy/ui-app/workflows';
import { useAutomationScope } from '@/hooks/useAutomationScope';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { executionIdForWorkflowRunRow } from '@/components/workflows/runs/WorkflowRunsList';
import { useWorkflowRunFeed } from '@/components/workflows/runs/useWorkflowRunFeed';
import { useExecutionFeedStore } from '@/lib/workflows/execution-feed';
import { pipelineEditLinkFromLocator } from '@/lib/workflows/edit-target';
import { pipelineInfoToDocumentLocator } from '@/lib/pipelineDocument';
import { pipelineLibraryKey } from '@/lib/workflows/library-projection';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import { WatcherManagementModal } from '@/components/watchers/WatcherManagementModal';
import {
  triggerTitle,
  watcherStatusLabelWithFailure,
  watcherTargetDisplay,
} from '@/components/watchers/watcherDisplay';
import { visibleWatchers } from '@/components/watchers/watcherFilters';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useNowTick } from '@/components/automations/calendar/useNowTick';
import { type AutomationsPanelVariant } from '@/lib/panels/automations-variants';
import { bringMainWindowForward } from '@/lib/panels/main-window-focus';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  buildLibraryRows,
  buildUpcomingEntries,
  filterActivitiesForScope,
  filterWatchersForScope,
  formatTimeUntil,
  getAutomationNextRun,
  panelRunFeedPredicates,
  RUNS_MAX_ROWS,
  type AutomationsPanelScope,
  type LibraryRow,
  type LibraryTypeFilter,
  type UpcomingEntry,
} from './automations-panel-data';
import { useWorkspaceProjectPipelines } from './useWorkspaceProjectPipelines';

type SectionId = 'upcoming' | 'overview' | 'completed';

export interface AutomationsPanelProps {
  readonly panelId: string;
  readonly variant: AutomationsPanelVariant;
  readonly projectId: string;
  readonly worktreeId: string;
}

/** Collapsible header + body in the `full` variant; body-only in presets. */
function PanelSectionShell({
  id,
  title,
  icon,
  count,
  collapsible,
  collapsed,
  onToggle,
  children,
}: {
  id: SectionId;
  title: string;
  icon: ReactNode;
  count: number;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: (id: SectionId) => void;
  children: ReactNode;
}): JSX.Element {
  if (!collapsible) {
    return <div className="flex min-h-0 flex-col">{children}</div>;
  }
  return (
    <div className="flex min-h-0 flex-col">
      <button
        type="button"
        onClick={(): void => onToggle(id)}
        aria-expanded={!collapsed}
        data-testid={`automations-panel-section-${id}`}
        className="focus-ring flex w-full shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-medium fg-secondary transition-colors hover:fg-primary"
      >
        {collapsed ? (
          <ChevronRightIcon size="sm" aria-hidden="true" />
        ) : (
          <ChevronDownIcon size="sm" aria-hidden="true" />
        )}
        {icon}
        <span>{title}</span>
        <Count value={count} />
      </button>
      {!collapsed && children}
    </div>
  );
}

function EmptyRow({ label }: { label: string }): JSX.Element {
  return (
    <div className="px-3 py-3 text-xs fg-secondary">
      <span>{label}</span>
    </div>
  );
}

function UpcomingSection({
  entries,
  now,
  onOpen,
}: {
  entries: UpcomingEntry[];
  now: Date;
  onOpen: (activity: ScheduledActivity) => void;
}): JSX.Element {
  if (entries.length === 0) {
    return <EmptyRow label="No scheduled runs coming up." />;
  }
  return (
    <ul
      className="flex flex-col px-1"
      data-testid="automations-panel-upcoming-list"
    >
      {entries.map((entry) => (
        <li key={entry.key}>
          <ListRow
            onClick={(): void => onOpen(entry.activity)}
            data-testid={`automations-panel-upcoming-${entry.key}`}
            trailing={entry.occursAt.toLocaleString()}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Badge muted={!entry.withinSoonWindow}>
                {formatTimeUntil(now, entry.occursAt)}
              </Badge>
              <span className="min-w-0 truncate">
                {entry.activity.name || 'Untitled workflow'}
              </span>
            </span>
          </ListRow>
        </li>
      ))}
    </ul>
  );
}

const OVERVIEW_COLUMNS: ReadonlyArray<DataTableColumn<LibraryRow>> = [
  {
    key: 'name',
    header: 'Name',
    width: '45%',
    overflow: 'truncate',
    render: (row) => {
      if (row.kind === 'automation') {
        return row.activity.name || 'Untitled workflow';
      }
      if (row.kind === 'pipeline') {
        return row.pipeline.name || 'Untitled workflow';
      }
      return row.watcher.label;
    },
  },
  {
    key: 'type',
    header: 'Type',
    width: '15%',
    overflow: 'truncate',
    render: (row) => WORKFLOW_KIND_LABELS[row.kind],
  },
  {
    key: 'trigger',
    header: 'Trigger',
    width: '20%',
    overflow: 'truncate',
    render: (row) => {
      if (row.kind === 'automation') {
        return getAutomationTriggerLabel(row.activity.schedule);
      }
      if (row.kind === 'pipeline') {
        return describePipelineTriggers(
          pipelineTriggerKinds(row.pipeline.triggerTypes ?? []),
        );
      }
      return triggerTitle(row.watcher.trigger);
    },
  },
  {
    key: 'status',
    header: 'Status',
    width: '20%',
    overflow: 'truncate',
    render: (row) => {
      if (row.kind === 'pipeline') return '';
      if (row.kind === 'watcher') {
        return watcherStatusLabelWithFailure(
          row.watcher.status,
          row.watcher.failureKind,
        );
      }
      const activity = row.activity;
      if (activity.sharedPipelineReview) {
        return <span className="fg-warning">Review needed</span>;
      }
      if (!activity.enabled) return 'Disabled';
      const nextRun = getAutomationNextRun(activity, new Date());
      return nextRun ? nextRun.toLocaleString() : 'Enabled';
    },
  },
];

function OverviewSection({
  rows,
  typeFilter,
  onTypeFilterChange,
  search,
  onSearchChange,
  onOpenActivity,
  onOpenPipeline,
  onOpenWatcher,
}: {
  rows: LibraryRow[];
  typeFilter: LibraryTypeFilter;
  onTypeFilterChange: (filter: LibraryTypeFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onOpenActivity: (activity: ScheduledActivity) => void;
  onOpenPipeline: (pipeline: PipelineInfo) => void;
  onOpenWatcher: (watcher: AppAdvisorWatcherSummary) => void;
}): JSX.Element {
  const filters: Array<{ value: LibraryTypeFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'automations', label: WORKFLOW_KIND_LABELS.automation },
    { value: 'pipelines', label: WORKFLOW_KIND_LABELS.pipeline },
    { value: 'watchers', label: 'Watchers' },
  ];
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <SegmentedControl
          value={typeFilter}
          options={filters.map((filter) => ({
            value: filter.value,
            label: filter.label,
            dataTestId: `automations-panel-filter-${filter.value}`,
          }))}
          onChange={onTypeFilterChange}
          label="Library type filter"
          shape="capsule"
          width="content"
        />
        <SearchField
          value={search}
          onValueChange={onSearchChange}
          placeholder="Filter by name"
          aria-label="Filter by name"
          data-testid="automations-panel-search"
          className="min-w-0 flex-1"
        />
      </div>
      {rows.length === 0 ? (
        <EmptyRow label="No workflows or watchers match." />
      ) : (
        <div className="px-3">
          <DataTable
            layout="fixed"
            caption="Workflows and watchers"
            testId="automations-panel-overview-body"
            rows={rows}
            rowKey={(row) => {
              if (row.kind === 'automation') {
                return `automation-${row.activity.id}`;
              }
              if (row.kind === 'pipeline')
                return pipelineLibraryKey(row.pipeline);
              return `watcher-${row.watcher.id}`;
            }}
            rowAttributes={(row) => {
              if (row.kind === 'automation') {
                return {
                  'data-testid': `automations-panel-overview-automation-${row.activity.id}`,
                };
              }
              if (row.kind === 'pipeline') {
                return {
                  'data-testid': `automations-panel-overview-pipeline-${row.pipeline.id}`,
                };
              }
              const target = watcherTargetDisplay(row.watcher.target);
              return {
                'data-testid': `automations-panel-overview-watcher-${row.watcher.id}`,
                title: `${target.title} — ${target.subtitle}`,
              };
            }}
            onRowActivate={(row): void => {
              if (row.kind === 'automation') onOpenActivity(row.activity);
              else if (row.kind === 'pipeline') onOpenPipeline(row.pipeline);
              else onOpenWatcher(row.watcher);
            }}
            columns={OVERVIEW_COLUMNS}
          />
        </div>
      )}
    </div>
  );
}

/** The status chip's colors, by how the run stands. */
function runStatusTone(status: WorkflowRunStatus): BadgeTone {
  switch (status) {
    case 'failure':
    case 'delivery-failed':
      return 'danger';
    case 'skipped':
    case 'canceled':
    case 'missed':
      return 'neutral';
    case 'queued':
    case 'running':
    case 'waiting':
    case 'watching':
      return 'info';
    case 'success':
    case 'fired':
      return 'success';
  }
}

const RUN_COLUMNS: ReadonlyArray<DataTableColumn<WorkflowRunRow>> = [
  {
    key: 'name',
    header: 'Name',
    width: '40%',
    overflow: 'truncate',
    render: (row) => row.name,
  },
  {
    key: 'type',
    header: 'Type',
    width: '20%',
    overflow: 'truncate',
    render: (row) => WORKFLOW_KIND_LABELS[row.kind],
  },
  {
    key: 'result',
    header: 'Result',
    width: '15%',
    render: (row) => (
      <Badge tone={runStatusTone(row.status)}>
        {WORKFLOW_RUN_STATUS_LABELS[row.status]}
      </Badge>
    ),
  },
  {
    key: 'started',
    header: 'Started',
    width: '25%',
    overflow: 'truncate',
    // The feed sorts by when a run started, as the page does.
    render: (row) => {
      const at = row.startedAt ?? row.endedAt;
      return at !== undefined ? new Date(at).toLocaleString() : '';
    },
  },
];

function RunsSection({
  rows,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  rows: readonly WorkflowRunRow[];
  /** The run history has not loaded yet; an empty list says nothing. */
  loading: boolean;
  /** The run history could not be listed. */
  error: string | null;
  onRetry: () => void;
  onOpen: (row: WorkflowRunRow) => void;
}): JSX.Element {
  if (error !== null) {
    return (
      <div className="p-3">
        <Notice
          errorSource="automations-panel-runs-error"
          intent="destructive"
          data-testid="automations-panel-runs-error"
          title="Could not load workflow runs."
          actions={
            <NoticeButton
              variant="primary"
              data-testid="automations-panel-runs-retry"
              onClick={onRetry}
            >
              Try again
            </NoticeButton>
          }
        >
          {error}
        </Notice>
      </div>
    );
  }
  if (rows.length === 0 && loading) {
    return (
      <div
        data-testid="automations-panel-runs-loading"
        className="px-3 py-3 text-xs fg-secondary"
      >
        Loading runs…
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyRow label="No workflow runs or watcher fires yet." />;
  }
  return (
    <div className="px-3">
      <DataTable
        layout="fixed"
        caption="Workflow runs"
        testId="automations-panel-completed-body"
        rows={rows}
        rowKey={(row) => row.key}
        rowAttributes={(row) => ({
          'data-testid': `automations-panel-completed-${row.key}`,
        })}
        onRowActivate={onOpen}
        columns={RUN_COLUMNS}
      />
    </div>
  );
}

export const AutomationsPanel = memo(function AutomationsPanel({
  panelId,
  variant,
  projectId,
  worktreeId,
}: AutomationsPanelProps): JSX.Element {
  const {
    activities,
    recentRuns,
    loading: automationsLoading,
    hydrated: automationsHydrated,
    error: automationsError,
    clearMutationError,
  } = useAutomationsStore(
    useShallow((s) => ({
      activities: s.activities,
      recentRuns: s.recentRuns,
      loading: s.loading,
      hydrated: s.hydrated,
      error: s.error,
      clearMutationError: s.clearMutationError,
    })),
  );
  const {
    watchers,
    completedWatchers,
    loading: watchersLoading,
    hydrated: watchersHydrated,
    error: watchersError,
  } = useAppAdvisorWatchersStore(
    useShallow((s) => ({
      watchers: s.watchers,
      completedWatchers: s.completedWatchers,
      loading: s.loading,
      hydrated: s.hydrated,
      error: s.error,
    })),
  );
  const projects = useProjectsStore((s) => s.projects);

  useEffect(() => {
    const store = useAutomationsStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);

  const retryHydration = useCallback((): void => {
    const automationsStore = useAutomationsStore.getState();
    if (!automationsStore.hydrated || automationsStore.error) {
      void automationsStore.hydrate();
    }
    const watchersStore = useAppAdvisorWatchersStore.getState();
    if (!watchersStore.hydrated || watchersStore.error) {
      void watchersStore.hydrate();
    }
  }, []);

  const loadErrors = [automationsError, watchersError].filter(
    (message): message is string => Boolean(message),
  );
  const dataLoading =
    loadErrors.length === 0 &&
    (automationsLoading ||
      watchersLoading ||
      !automationsHydrated ||
      !watchersHydrated);
  useEffect(() => {
    const store = useAppAdvisorWatchersStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);

  const project = projects.find((entry) => entry.id === projectId);
  // Cowork-style surfaces (cowork workspaces, the standalone-chat sentinel,
  // and the App Advisor pseudo-workspace) have no git worktrees, so the
  // worktree-scope toggle is meaningless there. `isCoworkChatTarget` covers
  // the sentinels the projects store never lists.
  const isCowork = project?.type === 'cowork' || isCoworkChatTarget(projectId);
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find((entry) => entry.id === worktreeId)
      : undefined;
  const worktreeLabel = worktree
    ? getWorktreeBranchDisplayName({
        rawBranch: worktree.branchName,
        worktreeId: worktree.id,
        hasMultipleBranches: false,
        getBranchDisplayName: (branchName) => branchName,
      })
    : worktreeId;

  const [worktreeOnly, setWorktreeOnly] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<
    Record<SectionId, boolean>
  >({ upcoming: false, overview: false, completed: false });
  const [typeFilter, setTypeFilter] = useState<LibraryTypeFilter>('all');
  const [search, setSearch] = useState('');
  const [watcherDetailId, setWatcherDetailId] = useState<string | null>(null);
  const panelRootRef = useRef<HTMLDivElement | null>(null);

  const toggleSection = useCallback((id: SectionId): void => {
    setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const now = useNowTick();
  const scope = useMemo<AutomationsPanelScope>(
    () => ({
      projectId,
      worktreeId,
      worktreeOnly: isCowork ? false : worktreeOnly,
    }),
    [projectId, worktreeId, isCowork, worktreeOnly],
  );

  const scopedActivities = useMemo(
    () => filterActivitiesForScope(activities, scope),
    [activities, scope],
  );
  const scopedWatchers = useMemo(
    () => filterWatchersForScope(visibleWatchers(watchers), scope, activities),
    [watchers, scope, activities],
  );
  const scopedCompletedWatchers = useMemo(
    () => filterWatchersForScope(completedWatchers, scope, activities),
    [completedWatchers, scope, activities],
  );
  const watcherDetail = useMemo(
    () =>
      watcherDetailId === null
        ? null
        : ([...scopedWatchers, ...scopedCompletedWatchers].find(
            (watcher) => watcher.id === watcherDetailId,
          ) ?? null),
    [watcherDetailId, scopedWatchers, scopedCompletedWatchers],
  );
  useEffect(() => {
    if (watcherDetailId !== null && watcherDetail === null) {
      setWatcherDetailId(null);
    }
  }, [watcherDetailId, watcherDetail]);
  const upcomingEntries = useMemo(
    () => buildUpcomingEntries(scopedActivities, now),
    [scopedActivities, now],
  );
  // Runs is the Workflows page's run feed, narrowed to this panel's scope.
  const automationScope = useAutomationScope();
  const runFeedPredicates = useMemo(
    () => panelRunFeedPredicates(scope, activities),
    [scope, activities],
  );
  const runFeed = useWorkflowRunFeed({
    activities,
    recentRuns,
    scope: automationScope,
    automationsLoading: !automationsHydrated,
    predicates: runFeedPredicates,
  });
  const runRows = useMemo(
    () => runFeed.rows.slice(0, RUNS_MAX_ROWS),
    [runFeed.rows],
  );
  // A run history that failed to load is reported in Runs, never shown as an
  // empty list, and Try again lists it again.
  const retryRuns = useCallback((): void => {
    void useExecutionFeedStore.getState().load();
  }, []);
  // The workspace's own on-demand workflows live in its checkout.
  const projectPipelines = useWorkspaceProjectPipelines(projectId, worktreeId);
  const overviewRows = useMemo(
    () =>
      buildLibraryRows({
        activities: scopedActivities,
        pipelines: projectPipelines.pipelines,
        watchers: scopedWatchers,
        typeFilter,
        search,
      }),
    [
      projectPipelines.pipelines,
      scopedActivities,
      scopedWatchers,
      typeFilter,
      search,
    ],
  );

  // The edit shell lives in the main window, so a pop-out brings it forward.
  // When the shell holds unsaved edits on another item, its prompt asks
  // there; the panel has nothing to wait for.
  const openRuns = useCallback((activity: ScheduledActivity): void => {
    const ownerDocument = panelRootRef.current?.ownerDocument;
    useNavigationStore
      .getState()
      .openAutomationEdit({ activityId: activity.id, section: 'runs' });
    bringMainWindowForward(ownerDocument);
  }, []);

  const openCreate = useCallback((): void => {
    if (projectId === APP_ADVISOR_PROJECT_ID) return;
    const ownerDocument = panelRootRef.current?.ownerDocument;
    clearMutationError();
    // A code project's draft runs a new chat on this panel's worktree each
    // time, instead of provisioning a fresh one.
    useNavigationStore.getState().openAutomationDraft({
      projectId,
      isCowork,
      ...(!isCowork ? { existingWorktreeId: worktreeId } : {}),
    });
    bringMainWindowForward(ownerDocument);
  }, [clearMutationError, projectId, worktreeId, isCowork]);

  // A project pipeline opens in the Workflows edit shell, addressed by the
  // checkout it was read from, as a Library row on the page does.
  const { cwd: pipelinesCwd } = projectPipelines;
  const openPipeline = useCallback(
    (pipeline: PipelineInfo): void => {
      const ownerDocument = panelRootRef.current?.ownerDocument;
      useNavigationStore.getState().openPipelineEdit({
        ...pipelineEditLinkFromLocator(
          pipelineInfoToDocumentLocator(pipeline, pipelinesCwd),
        ),
        // This panel's checkout, which a pop-out's main window may not show.
        worktree: { projectId, worktreeId },
      });
      bringMainWindowForward(ownerDocument);
    },
    [pipelinesCwd, projectId, worktreeId],
  );

  const openWatcherDetail = useCallback(
    (watcher: AppAdvisorWatcherSummary): void => {
      setWatcherDetailId(watcher.id);
    },
    [],
  );

  // A run that has a pipeline opens its run panel, as on the Workflows page.
  // Any other scheduled run opens its workflow's runs, like the other
  // sections; a watcher keeps this panel's own modal.
  const { executionsById } = runFeed;
  const openRunRow = useCallback(
    (row: WorkflowRunRow): void => {
      if (row.kind === 'watcher') {
        setWatcherDetailId(row.watcherId);
        return;
      }
      const executionId = executionIdForWorkflowRunRow(row, executionsById);
      if (executionId !== undefined) {
        void openPipelineExecutionFromUi({ executionId });
        bringMainWindowForward(panelRootRef.current?.ownerDocument);
        return;
      }
      if (row.kind !== 'automation') return;
      const activity = activities.find(
        (candidate) => candidate.id === row.activityId,
      );
      if (activity) openRuns(activity);
    },
    [activities, executionsById, openRuns],
  );

  useCurrentUiStateReporter(`automations.panel.${panelId}`, {
    panelId,
    variant,
    projectId,
    worktreeId,
    // The panel opens no automation dialogs of its own any more: details,
    // the form and the review all open in the main window's edit shell.
    detailsModalOpen: false,
    sharedPipelineReviewModalOpen: false,
    watcherModalOpen: watcherDetail !== null,
    ...(watcherDetail ? { watcherModalWatcherId: watcherDetail.id } : {}),
    formOpen: false,
  });

  const showSection = useCallback(
    (id: SectionId): boolean => variant === 'full' || variant === id,
    [variant],
  );
  const collapsible = variant === 'full';

  const worktreeToggleLabel = worktreeOnly
    ? `Showing workflows for this ${WORKTREE_UNIT_LABEL.toLowerCase()} only — click to show the whole project`
    : `Showing all project workflows — click to show only this ${WORKTREE_UNIT_LABEL.toLowerCase()}`;

  return (
    <div
      ref={panelRootRef}
      data-testid="automations-panel"
      data-variant={variant}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <Surface variant="section" boundary="bottom" className="shrink-0">
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
          <div className="min-w-0 truncate text-xs fg-secondary">
            {project ? getWorkspaceDisplayName(project) : projectId}
            {!isCowork && worktreeOnly ? (
              <span className="fg-secondary"> · {worktreeLabel}</span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!isCowork && (
              <IconToggleButton
                pressed={worktreeOnly}
                label={worktreeToggleLabel}
                tooltip={worktreeToggleLabel}
                icon={<BranchIcon size="sm" aria-hidden="true" />}
                onClick={(): void => setWorktreeOnly((prev) => !prev)}
                testId="automations-panel-worktree-toggle"
              />
            )}
            {projectId !== APP_ADVISOR_PROJECT_ID && (
              <Tooltip label="New workflow">
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly
                  aria-label="New workflow"
                  onClick={openCreate}
                  data-testid="automations-panel-add"
                >
                  <PlusIcon size="sm" aria-hidden="true" />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
      </Surface>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loadErrors.length > 0 ? (
          <div className="shrink-0 p-3">
            <Notice
              errorSource="automations-panel-load-error"
              intent="destructive"
              data-testid="automations-panel-load-error"
              className=""
              title="Could not load workflows."
              actions={
                <NoticeButton
                  variant="primary"
                  data-testid="automations-panel-retry"
                  onClick={retryHydration}
                >
                  Try again
                </NoticeButton>
              }
            >
              {loadErrors.join(' ')}
            </Notice>
          </div>
        ) : dataLoading ? (
          <div
            data-testid="automations-panel-loading"
            className="flex h-full min-h-24 items-center justify-center px-3 py-6 text-xs fg-secondary"
          >
            Loading workflows…
          </div>
        ) : (
          <div className="divide-y">
            {showSection('upcoming') && (
              <PanelSectionShell
                id="upcoming"
                title="Schedule"
                icon={<ScheduleIcon size="sm" aria-hidden="true" />}
                count={upcomingEntries.length}
                collapsible={collapsible}
                collapsed={collapsedSections.upcoming}
                onToggle={toggleSection}
              >
                <UpcomingSection
                  entries={upcomingEntries}
                  now={now}
                  onOpen={openRuns}
                />
              </PanelSectionShell>
            )}
            {showSection('overview') && (
              <PanelSectionShell
                id="overview"
                title="Library"
                icon={<BulletListIcon size="sm" aria-hidden="true" />}
                count={overviewRows.length}
                collapsible={collapsible}
                collapsed={collapsedSections.overview}
                onToggle={toggleSection}
              >
                <OverviewSection
                  rows={overviewRows}
                  typeFilter={typeFilter}
                  onTypeFilterChange={setTypeFilter}
                  search={search}
                  onSearchChange={setSearch}
                  onOpenActivity={openRuns}
                  onOpenPipeline={openPipeline}
                  onOpenWatcher={openWatcherDetail}
                />
              </PanelSectionShell>
            )}
            {showSection('completed') && (
              <PanelSectionShell
                id="completed"
                title="Runs"
                icon={<PlayCircleIcon size="sm" aria-hidden="true" />}
                count={runRows.length}
                collapsible={collapsible}
                collapsed={collapsedSections.completed}
                onToggle={toggleSection}
              >
                <RunsSection
                  rows={runRows}
                  loading={runFeed.loading}
                  error={runFeed.error}
                  onRetry={retryRuns}
                  onOpen={openRunRow}
                />
              </PanelSectionShell>
            )}
          </div>
        )}
      </div>
      {watcherDetail && (
        <WatcherManagementModal
          title="Watcher"
          emptyMessage="This watcher is no longer available."
          watchers={[watcherDetail]}
          onClose={(): void => setWatcherDetailId(null)}
          ownerDocument={panelRootRef.current?.ownerDocument}
        />
      )}
    </div>
  );
});
