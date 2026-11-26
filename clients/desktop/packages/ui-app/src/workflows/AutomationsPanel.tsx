'use client';

import {
  memo,
  useCallback,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { AutomationsPanelVariant } from '@canopy/protocol/panels';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import type {
  WorkflowsPanelScope,
  WorkflowsPanelIntent,
  WorkflowsPanelUpcomingEntry as UpcomingEntry,
  WorkflowsPanelLibraryRow as LibraryRow,
  WorkflowsPanelRunRow as WorkflowRunRow,
  WorkflowsPanelRunStatus as WorkflowRunStatus,
  WorkflowsPanelTypeFilter as LibraryTypeFilter,
} from '@canopy/app-core';
import { useCanopyClient, useWorkflowsPanelFeed } from '@canopy/app-state';
import {
  Surface,
  Badge,
  Button,
  Notice,
  NoticeButton,
  DataTable,
  ListRow,
  SearchField,
  SegmentedControl,
  Tooltip,
  ControlButton,
  Count,
  EmptyState,
  type DataTableColumn,
  type BadgeTone,
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
import { WORKFLOW_RUN_STATUS_LABELS } from './workflow-run-model';

type SectionId = 'upcoming' | 'overview' | 'completed';

export interface AutomationsPanelProps {
  readonly panelId: string;
  readonly variant: AutomationsPanelVariant;
  readonly projectId: string;
  readonly worktreeId: string;
  /** Host presentation intent, e.g. focus the main window after popout navigation. */
  readonly onNavigate?: () => void;
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
      <ControlButton
        type="button"
        onClick={(): void => onToggle(id)}
        aria-expanded={!collapsed}
        data-testid={`automations-panel-section-${id}`}
        presentation="automation-section-toggle"
      >
        {collapsed ? (
          <ChevronRightIcon size="sm" aria-hidden="true" />
        ) : (
          <ChevronDownIcon size="sm" aria-hidden="true" />
        )}
        {icon}
        <span>{title}</span>
        <Count value={count} />
      </ControlButton>
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
  entries: readonly UpcomingEntry[];
  now: Date;
  onOpen: (activityId: string) => void;
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
            onClick={(): void => onOpen(entry.activityId)}
            data-testid={`automations-panel-upcoming-${entry.key}`}
            trailing={new Date(entry.occursAt).toLocaleString()}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Badge muted={!entry.withinSoonWindow}>
                {formatTimeUntil(now, new Date(entry.occursAt))}
              </Badge>
              <span className="min-w-0 truncate">{entry.name}</span>
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
    render: (row) => row.name,
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
    render: (row) => row.trigger,
  },
  {
    key: 'status',
    header: 'Status',
    width: '20%',
    overflow: 'truncate',
    render: (row) =>
      row.reviewNeeded ? (
        <span className="fg-warning">{row.status}</span>
      ) : (
        row.status
      ),
  },
];

function OverviewSection({
  rows,
  typeFilter,
  onTypeFilterChange,
  search,
  onSearchChange,
  onOpen,
}: {
  rows: LibraryRow[];
  typeFilter: LibraryTypeFilter;
  onTypeFilterChange: (filter: LibraryTypeFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onOpen: (row: LibraryRow) => void;
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
            rowKey={(row) => row.key}
            rowAttributes={(row) => ({
              'data-testid': `automations-panel-overview-${row.kind}-${row.id}`,
              ...(row.title ? { title: row.title } : {}),
            })}
            onRowActivate={onOpen}
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
          title="Couldn't load workflow runs."
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

/** Shared workspace panel. Hosts supply their data and navigation through the client. */
export const AutomationsPanel = memo(function AutomationsPanel({
  panelId,
  variant,
  projectId,
  worktreeId,
  onNavigate,
}: AutomationsPanelProps): JSX.Element {
  const client = useCanopyClient();
  const [worktreeOnly, setWorktreeOnly] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<
    Record<SectionId, boolean>
  >({ upcoming: false, overview: false, completed: false });
  const [typeFilter, setTypeFilter] = useState<LibraryTypeFilter>('all');
  const [search, setSearch] = useState('');
  const scope: WorkflowsPanelScope = {
    panelId,
    projectId,
    worktreeId,
    worktreeOnly,
  };
  const { available, header, snapshot } = useWorkflowsPanelFeed(scope);
  const overviewRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (snapshot?.library ?? []).filter(
      (row) =>
        (typeFilter === 'all' ||
          row.kind ===
            (typeFilter === 'automations'
              ? 'automation'
              : typeFilter === 'pipelines'
                ? 'pipeline'
                : 'watcher')) &&
        row.searchName.toLowerCase().includes(needle),
    );
  }, [snapshot, typeFilter, search]);
  const toggleSection = useCallback(
    (id: SectionId): void =>
      setCollapsedSections((previous) => ({
        ...previous,
        [id]: !previous[id],
      })),
    [],
  );
  const dispatch = (intent: WorkflowsPanelIntent, navigate = false): void => {
    client.workflowsPanel?.dispatch(scope, intent);
    if (navigate) onNavigate?.();
  };
  const openRuns = (id: string): void =>
    dispatch({ kind: 'activity', id }, true);
  const openCreate = (): void => dispatch({ kind: 'create' }, true);
  const openRunRow = (row: WorkflowRunRow): void =>
    dispatch({ kind: 'run', key: row.key }, row.kind !== 'watcher');
  const retryHydration = (): void => dispatch({ kind: 'retry' });
  const retryRuns = (): void => dispatch({ kind: 'retry-runs' });
  const loadErrors = snapshot?.loadErrors ?? [];
  const dataLoading = snapshot === null || snapshot.loading;
  const upcomingEntries = snapshot?.upcoming ?? [];
  const runRows = snapshot?.runs ?? [];
  const now = new Date(snapshot?.now ?? Date.now());
  const isCowork = header?.hasWorktrees !== true;
  const worktreeLabel = header?.worktreeLabel ?? worktreeId;

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
      data-testid="automations-panel"
      data-variant={variant}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {!available ? (
        <EmptyState
          testId="automations-panel-unavailable"
          title="Workflows aren't available in this workspace yet"
        />
      ) : (
        <>
          <Surface variant="section" boundary="bottom" className="shrink-0">
            <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0 truncate text-xs fg-secondary">
                {header?.workspaceLabel ?? projectId}
                {!isCowork && worktreeOnly ? (
                  <span className="fg-secondary"> · {worktreeLabel}</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!isCowork && (
                  <Tooltip label={worktreeToggleLabel} delay="long">
                    <ControlButton
                      presentation="icon-toggle"
                      appearance={{ pressed: worktreeOnly }}
                      aria-pressed={worktreeOnly}
                      aria-label={worktreeToggleLabel}
                      onClick={(): void => setWorktreeOnly((prev) => !prev)}
                      data-testid="automations-panel-worktree-toggle"
                    >
                      {<BranchIcon size="sm" aria-hidden="true" />}
                    </ControlButton>
                  </Tooltip>
                )}
                {header?.canCreate && (
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
                  title="Couldn't load workflows."
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
                      onOpen={(row): void =>
                        dispatch(
                          { kind: 'library', key: row.key },
                          row.kind !== 'watcher',
                        )
                      }
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
                      loading={snapshot?.runsLoading ?? true}
                      error={snapshot?.runsError ?? null}
                      onRetry={retryRuns}
                      onOpen={openRunRow}
                    />
                  </PanelSectionShell>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
});

/** Same minute-rounded Schedule labels as the desktop panel. */
function formatTimeUntil(now: Date, occursAt: Date): string {
  const deltaMs = occursAt.getTime() - now.getTime();
  if (deltaMs <= 30_000) return 'now';
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder > 0 ? `in ${hours}h ${remainder}m` : `in ${hours}h`;
  }
  return `in ${Math.floor(hours / 24)}d`;
}
