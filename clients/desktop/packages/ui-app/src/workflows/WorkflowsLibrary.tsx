'use client';

import type { ComponentType, JSX, ReactNode } from 'react';
import {
  Button,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  EmptyState,
  PageSearchControls,
  PageSearchFilters,
  PageSearchRow,
  SearchEmptyState,
  Skeleton,
  SortDropdown,
  TableActionButton,
  TableActionsCell,
  ToggleSwitch,
  Tooltip,
  WorkflowLastRunText,
  pageFilter,
} from '@canopy/ui-shared/components';
import {
  AppAdvisorIcon,
  ChatIcon,
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
  GlobeIcon,
  FolderIcon,
  CircleCheckIcon,
  CognitionIcon,
  CopyIcon,
  FilterIcon,
  HistoryIcon,
  InputIcon,
  MessageIcon,
  PencilIcon,
  PipelineIcon,
  PlansIcon,
  PlayIcon,
  PlusIcon,
  ScheduleIcon,
  ShareIcon,
  TaskIcon,
  TerminalIcon,
  TimeslotIcon,
  TrashIcon,
  WarningIcon,
  WorkflowIcon,
  type AppIconProps,
  type IconSize,
} from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  WORKFLOW_LIBRARY_ACTION_LABELS,
  WORKFLOW_LIBRARY_SORTS,
  WORKFLOW_LIBRARY_SORT_LABELS,
  WORKFLOW_LIBRARY_SOURCES,
  WORKFLOW_LIBRARY_SOURCE_LABELS,
  WORKFLOW_LIBRARY_STATUS_FILTERS,
  WORKFLOW_LIBRARY_STATUS_LABELS,
  WORKFLOW_NO_PROJECT,
  WORKFLOW_STEP_LABELS,
  WORKFLOW_TRIGGER_LABELS,
  describeClearLibraryFilters,
  describeNoLibraryMatches,
  menuWorkflowLibraryActions,
  truncateStepChain,
  workflowLibraryFiltersActive,
  type WorkflowLibraryAction,
  type WorkflowLibraryFacetCounts,
  type WorkflowLibraryFilters,
  type WorkflowLibraryPage,
  type WorkflowLibraryRow,
  type WorkflowLibrarySort,
  type WorkflowLibrarySource,
  type WorkflowLibraryStatusFilter,
  type WorkflowStepGlyph,
  type WorkflowTriggerKind,
} from './workflow-library-model';
import { formatNextRun } from './workflow-time';
import {
  WorkflowsRowMenu,
  type WorkflowsRowMenuItem,
  WorkflowsSearchField,
} from './workflows-controls';

type Glyph = ComponentType<AppIconProps>;

const TRIGGER_GLYPHS: Readonly<Record<WorkflowTriggerKind, Glyph>> = {
  schedule: ScheduleIcon,
  once: TimeslotIcon,
  manual: PlayIcon,
  'plan-approved': PlansIcon,
  'task-ready': TaskIcon,
  workflow: WorkflowIcon,
};

const STEP_GLYPHS: Readonly<Record<WorkflowStepGlyph, Glyph>> = {
  gate: FilterIcon,
  advisor: AppAdvisorIcon,
  chat: ChatIcon,
  message: MessageIcon,
  agent: CognitionIcon,
  script: TerminalIcon,
  input: InputIcon,
  pipeline: PipelineIcon,
  step: PipelineIcon,
};

function TriggerGlyph({
  trigger,
  size = 'sm',
}: {
  readonly trigger: WorkflowTriggerKind;
  readonly size?: IconSize;
}): JSX.Element {
  const Icon = TRIGGER_GLYPHS[trigger];
  return <Icon size={size} aria-hidden="true" />;
}

/**
 * Each library menu row's icon and group. Share… and Copy share link are one
 * action's two forms, so they share an icon; Delete closes the menu.
 * `toggle`, `run` and `add` are row buttons today, never menu rows; they keep
 * an entry so the map stays total over the action union.
 */
const LIBRARY_MENU_ROWS: Readonly<
  Record<
    WorkflowLibraryAction,
    Pick<WorkflowsRowMenuItem, 'icon' | 'group' | 'destructive'>
  >
> = {
  toggle: { icon: <PlayIcon />, group: 'manage' },
  run: { icon: <PlayIcon />, group: 'manage' },
  add: { icon: <PlusIcon />, group: 'manage' },
  edit: { icon: <PencilIcon />, group: 'manage' },
  'view-runs': { icon: <HistoryIcon />, group: 'manage' },
  duplicate: { icon: <CopyIcon />, group: 'manage' },
  share: { icon: <ShareIcon />, group: 'share' },
  'copy-link': { icon: <ShareIcon />, group: 'share' },
  delete: { icon: <TrashIcon />, destructive: true },
};

export interface WorkflowStepChainProps {
  readonly trigger: WorkflowTriggerKind;
  readonly steps: readonly WorkflowStepGlyph[];
}

/**
 * Trigger glyph, then the first three steps and `+N`: a quiet preview of the
 * workflow's shape. Decorative; the row's text carries the meaning.
 */
export function WorkflowStepChain({
  trigger,
  steps,
}: WorkflowStepChainProps): JSX.Element {
  const { shown, more } = truncateStepChain(steps);
  return (
    <span
      className="flex shrink-0 items-center gap-1 fg-tertiary"
      data-testid="workflows-step-chain"
      aria-hidden="true"
    >
      <span
        className="flex fg-secondary"
        title={WORKFLOW_TRIGGER_LABELS[trigger]}
      >
        <TriggerGlyph trigger={trigger} />
      </span>
      {shown.length > 0 ? (
        <ChevronRightMediumIcon
          size="sm"
          aria-hidden="true"
          className="fg-quaternary"
        />
      ) : null}
      {shown.map((step, index) => {
        const Icon = STEP_GLYPHS[step];
        return (
          <span
            // Steps repeat, so position is the only stable identity.
            key={`${step}-${String(index)}`}
            className="flex"
            title={WORKFLOW_STEP_LABELS[step]}
            data-step={step}
          >
            <Icon size="sm" aria-hidden="true" />
          </span>
        );
      })}
      {more > 0 ? (
        <span
          className="text-2xs tabular-nums fg-tertiary"
          data-testid="workflows-step-chain-more"
        >
          +{more}
        </span>
      ) : null}
    </span>
  );
}

export interface WorkflowsLibraryTableProps {
  /** One page of filtered, sorted rows. */
  readonly rows: readonly WorkflowLibraryRow[];
  /** Epoch milliseconds, so the Next run column is stable within a render. */
  readonly now: number;
  readonly locale?: string;
  /** Opens the row: its editor, or the read-only detail of a shared item. */
  readonly onOpen: (row: WorkflowLibraryRow) => void;
  readonly onAction: (
    row: WorkflowLibraryRow,
    action: WorkflowLibraryAction,
  ) => void;
  /** Rows with an action in flight; their switch and Run are disabled. */
  readonly busyKeys?: ReadonlySet<string>;
  /** The row a reveal is pointing at (an install that just finished). */
  readonly highlightKey?: string | null;
  /**
   * Fold Next run under the trigger. Hosts set it at narrow widths so the
   * table never scrolls sideways.
   */
  readonly compact?: boolean;
}

/**
 * The Library table (CAN-3981): automations and pipelines in one inventory.
 * A row click or Enter opens the row; the switch, Run, Add and the More menu
 * never do.
 */
export function WorkflowsLibraryTable({
  rows,
  now,
  locale,
  onOpen,
  onAction,
  busyKeys,
  highlightKey,
  compact = false,
}: WorkflowsLibraryTableProps): JSX.Element {
  return (
    <DataTableFrame
      layout="fixed"
      caption="Workflows"
      testId="workflows-library-table"
    >
      <WorkflowsLibraryTableHead compact={compact} />
      <DataTableBody>
        {rows.map((row) => (
          <WorkflowsLibraryTableRow
            key={row.key}
            row={row}
            now={now}
            locale={locale}
            compact={compact}
            busy={busyKeys?.has(row.key) === true}
            highlighted={highlightKey === row.key}
            onOpen={onOpen}
            onAction={onAction}
          />
        ))}
      </DataTableBody>
    </DataTableFrame>
  );
}

/** The Library table's column heads. */
function WorkflowsLibraryTableHead({
  compact,
}: {
  readonly compact: boolean;
}): JSX.Element {
  return (
    <DataTableHead>
      {/* A phone keeps the workflow and its actions; the Workflow cell
          names the trigger. */}
      <DataTableHeaderCell>Workflow</DataTableHeaderCell>
      <DataTableHeaderCell width={compact ? '11rem' : '13rem'} showFrom="sm">
        Trigger
      </DataTableHeaderCell>
      <DataTableHeaderCell width="12rem" showFrom="md">
        Last run
      </DataTableHeaderCell>
      {compact ? null : (
        <DataTableHeaderCell width="11rem">Next run</DataTableHeaderCell>
      )}
      <DataTableHeaderCell width="8rem" align="right" labelHidden>
        On or off, and actions
      </DataTableHeaderCell>
    </DataTableHead>
  );
}

export interface WorkflowsLibraryTableSkeletonProps {
  /** Body rows. Defaults to five. */
  readonly rows?: number;
  /** Match the table's narrow layout, without the Next run column. */
  readonly compact?: boolean;
}

/** A fixed clock, so the samples' Next run never depends on the real one. */
const SAMPLE_NOW = Date.UTC(2026, 0, 1, 12);
const SAMPLE_HOUR_MS = 3_600_000;

interface SampleWorkflow {
  readonly key: string;
  readonly name: string;
  readonly summary: string;
  readonly trigger: WorkflowTriggerKind;
  readonly triggerText: string;
  readonly lastRunHoursAgo: number;
  /** Absent for a workflow with no next run (a pipeline). */
  readonly nextRunInHours?: number;
}

function sampleWorkflowRow(sample: SampleWorkflow): WorkflowLibraryRow {
  return {
    key: sample.key,
    kind: sample.trigger === 'schedule' ? 'automation' : 'pipeline',
    name: sample.name,
    triggers: [sample.trigger],
    triggerText: sample.triggerText,
    steps: ['agent'],
    summary: sample.summary,
    source: 'built-in',
    sourceLabel: 'Built-in',
    lastRun: {
      state: 'success',
      at: SAMPLE_NOW - sample.lastRunHoursAgo * SAMPLE_HOUR_MS,
    },
    nextRunAt:
      sample.nextRunInHours === undefined
        ? undefined
        : SAMPLE_NOW + sample.nextRunInHours * SAMPLE_HOUR_MS,
    enabled: true,
    actions: ['toggle', 'run', 'edit'],
  };
}

/**
 * Plain sample workflows: a name, one summary line with its source, a
 * trigger, a last run and a switch, so each row stands at a loaded row's
 * height.
 */
const SAMPLE_WORKFLOW_VALUES: readonly SampleWorkflow[] = [
  {
    key: 'sample-review',
    name: 'Review pull requests',
    summary: '3 steps',
    trigger: 'plan-approved',
    triggerText: 'When a plan is approved',
    lastRunHoursAgo: 2,
  },
  {
    key: 'sample-digest',
    name: 'Morning digest',
    summary: 'Start chat',
    trigger: 'schedule',
    triggerText: 'Weekdays at 9:00 AM',
    lastRunHoursAgo: 20,
    nextRunInHours: 21,
  },
  {
    key: 'sample-release',
    name: 'Release notes',
    summary: '4 steps',
    trigger: 'manual',
    triggerText: 'Manual',
    lastRunHoursAgo: 48,
  },
  {
    key: 'sample-triage',
    name: 'Triage new issues',
    summary: 'Start chat',
    trigger: 'schedule',
    triggerText: 'Every hour',
    lastRunHoursAgo: 1,
    nextRunInHours: 1,
  },
  {
    key: 'sample-tests',
    name: 'Fix failing tests',
    summary: '2 steps',
    trigger: 'task-ready',
    triggerText: 'When a task is ready',
    lastRunHoursAgo: 6,
  },
];

const SAMPLE_WORKFLOWS: readonly WorkflowLibraryRow[] =
  SAMPLE_WORKFLOW_VALUES.map(sampleWorkflowRow);

const noop = (): void => undefined;

/**
 * The Library while its rows load: `WorkflowsLibraryTable` itself, rendered
 * from sample workflows inside the measured `Skeleton`, so the column heads
 * stay and the bars sit where the values will. The rows replace it in place.
 * Wrap it in `DelayedLoadingPlaceholder` so a fast load never flashes it.
 */
export function WorkflowsLibraryTableSkeleton({
  rows = SAMPLE_WORKFLOWS.length,
  compact = false,
}: WorkflowsLibraryTableSkeletonProps): JSX.Element {
  const shown = SAMPLE_WORKFLOWS.slice(
    0,
    Math.max(1, Math.min(SAMPLE_WORKFLOWS.length, Math.floor(rows))),
  );
  return (
    <Skeleton
      loading
      label="Loading workflows"
      testId="workflows-library-skeleton"
    >
      <WorkflowsLibraryTable
        rows={shown}
        now={SAMPLE_NOW}
        locale="en-US"
        onOpen={noop}
        onAction={noop}
        compact={compact}
      />
    </Skeleton>
  );
}

interface WorkflowsLibraryTableRowProps {
  readonly row: WorkflowLibraryRow;
  readonly now: number;
  readonly locale?: string;
  readonly compact: boolean;
  readonly busy: boolean;
  readonly highlighted: boolean;
  readonly onOpen: (row: WorkflowLibraryRow) => void;
  readonly onAction: (
    row: WorkflowLibraryRow,
    action: WorkflowLibraryAction,
  ) => void;
}

/** One Library row: two-line name cell, trigger, last and next run, row end. */
export function WorkflowsLibraryTableRow({
  row,
  now,
  locale,
  compact,
  busy,
  highlighted,
  onOpen,
  onAction,
}: WorkflowsLibraryTableRowProps): JSX.Element {
  const off = row.enabled === false;
  const leadTrigger = row.triggers[0] ?? 'manual';
  const nextRun =
    row.nextRunAt !== undefined && !off
      ? formatNextRun(row.nextRunAt, now, locale)
      : undefined;
  const canRun = row.actions.includes('run');
  const showRun = canRun || row.runUnavailableLabel !== undefined;
  return (
    <DataTableRow
      data-testid="workflows-library-row"
      data-row-key={row.key}
      data-row-kind={row.kind}
      data-highlighted={highlighted ? 'true' : undefined}
      selected={highlighted}
      onActivate={(): void => onOpen(row)}
    >
      <DataTableCell tone={off ? 'tertiary' : 'primary'}>
        <div className="flex min-w-0 flex-col gap-1">
          <span
            className={`truncate ${off ? 'fg-tertiary' : 'fg-primary'} ${REPLAY_MASK_CLASS}`}
            data-testid="workflows-library-name"
          >
            {row.name}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs fg-tertiary">
            <WorkflowStepChain trigger={leadTrigger} steps={row.steps} />
            <span className="truncate" data-testid="workflows-library-summary">
              <span className={REPLAY_MASK_CLASS}>{row.summary}</span>
              {row.sourceLabel ? (
                <>
                  {row.summary ? ' · ' : ''}
                  <span
                    className={row.sourceIsPerson ? REPLAY_MASK_CLASS : ''}
                    data-testid="workflows-library-source"
                  >
                    {row.sourceLabel}
                  </span>
                </>
              ) : null}
            </span>
          </span>
          <span
            className="truncate text-xs fg-tertiary sm:hidden"
            data-testid="workflows-library-trigger-folded"
          >
            {row.triggerText}
          </span>
          {row.attention ? (
            <span
              className="inline-flex min-w-0 items-center gap-1 text-xs fg-warning"
              data-testid="workflows-library-attention"
            >
              <WarningIcon size="sm" aria-hidden="true" className="shrink-0" />
              <span className="truncate">{row.attention}</span>
            </span>
          ) : null}
        </div>
      </DataTableCell>
      <DataTableCell showFrom="sm">
        <div className="flex min-w-0 flex-col gap-1">
          <span
            className="truncate fg-secondary"
            data-testid="workflows-library-trigger"
          >
            {row.triggerText}
          </span>
          {compact && nextRun ? (
            <span className="truncate text-xs tabular-nums fg-tertiary">
              Next: {nextRun}
            </span>
          ) : null}
        </div>
      </DataTableCell>
      <DataTableCell data-testid="workflows-library-last-run" showFrom="md">
        <WorkflowLastRunText lastRun={row.lastRun} />
      </DataTableCell>
      {compact ? null : (
        <DataTableCell
          overflow="truncate"
          data-testid="workflows-library-next-run"
        >
          <span className="tabular-nums">
            {nextRun ?? <span className="fg-quaternary">—</span>}
          </span>
        </DataTableCell>
      )}
      <DataTableCell align="right">
        <TableActionsCell testId="workflows-library-actions">
          <span className="flex items-center gap-2">
            {row.installable ? (
              <Button
                variant="secondary"
                size="compact"
                disabled={row.installing === true || busy}
                aria-busy={row.installing === true}
                data-testid="workflows-library-add"
                onClick={(): void => onAction(row, 'add')}
              >
                Add
              </Button>
            ) : (
              <>
                {row.enabled !== undefined && row.actions.includes('toggle') ? (
                  // The accessible name says the state; the tooltip says what
                  // a press does.
                  <Tooltip label={row.enabled ? 'Turn off' : 'Turn on'}>
                    <ToggleSwitch
                      checked={row.enabled}
                      disabled={busy}
                      label={`${row.name} is ${row.enabled ? 'on' : 'off'}`}
                      dataTestId="workflows-library-toggle"
                      onChange={(): void => onAction(row, 'toggle')}
                    />
                  </Tooltip>
                ) : row.scheduleCounts ? (
                  <span
                    className="shrink-0 whitespace-nowrap text-xs fg-secondary"
                    data-testid="workflows-library-schedule-counts"
                  >
                    {`${String(row.scheduleCounts.on)} of ${String(row.scheduleCounts.total)} on`}
                  </span>
                ) : (
                  // Quiet gap where the switch sits, so Run stays aligned.
                  <span className="w-8 shrink-0" aria-hidden="true" />
                )}
                {showRun ? (
                  <TableActionButton
                    label={
                      canRun
                        ? `Run ${row.name}`
                        : (row.runUnavailableLabel ?? `Run ${row.name}`)
                    }
                    disabled={!canRun || busy}
                    testId="workflows-library-run"
                    onClick={(): void => onAction(row, 'run')}
                  >
                    <PlayIcon size="sm" aria-hidden="true" />
                  </TableActionButton>
                ) : null}
              </>
            )}
            <WorkflowsRowMenu
              label={`More actions for ${row.name}`}
              testId="workflows-library-menu"
              items={menuWorkflowLibraryActions(row.actions).map((action) => ({
                id: action,
                label: WORKFLOW_LIBRARY_ACTION_LABELS[action],
                ...LIBRARY_MENU_ROWS[action],
                onSelect: (): void => onAction(row, action),
              }))}
            />
          </span>
        </TableActionsCell>
      </DataTableCell>
    </DataTableRow>
  );
}

export interface WorkflowsLibraryProjectOption {
  readonly id: string;
  readonly name: string;
}

export interface WorkflowsLibraryToolbarProps {
  readonly filters: WorkflowLibraryFilters;
  readonly onFiltersChange: (filters: WorkflowLibraryFilters) => void;
  readonly sort: WorkflowLibrarySort;
  readonly onSortChange: (sort: WorkflowLibrarySort) => void;
  /** Counts from the unfiltered rows of the current context. */
  readonly counts: WorkflowLibraryFacetCounts;
  /** Trigger kinds this host can show. */
  readonly triggers: readonly WorkflowTriggerKind[];
  /** Projects in the current context; "No project" is added here. */
  readonly projects: readonly WorkflowsLibraryProjectOption[];
  /**
   * Leave the Shared count out when the share list failed to load, rather
   * than showing a 0 that reads as "nothing is shared".
   */
  readonly sharedCountUnknown?: boolean;
  /** Rows in the unfiltered set and after filtering, for the result line. */
  readonly total: number;
  readonly matched: number;
}

/**
 * Library search. The Trigger / Status / Project / Source filters with
 * counts sit behind one Filter dropdown after the field (more than fit
 * inline), then the sort; while there is a query the field shows how many
 * workflows match.
 */
export function WorkflowsLibraryToolbar({
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  counts,
  triggers,
  projects,
  sharedCountUnknown = false,
  total,
  matched,
}: WorkflowsLibraryToolbarProps): JSX.Element {
  const pageFilters = [
    pageFilter<WorkflowTriggerKind>({
      key: 'trigger',
      title: 'Trigger',
      groupIcon: <PlayIcon />,
      anyLabel: 'Any trigger',
      multiple: true,
      options: triggers.map((trigger) => ({
        value: trigger,
        label: WORKFLOW_TRIGGER_LABELS[trigger],
        count: counts.triggers[trigger],
        icon: <TriggerGlyph trigger={trigger} />,
      })),
      selected: filters.triggers,
      onToggle: (trigger): void =>
        onFiltersChange({
          ...filters,
          triggers: filters.triggers.includes(trigger)
            ? filters.triggers.filter((value) => value !== trigger)
            : [...filters.triggers, trigger],
        }),
      onClear: (): void => onFiltersChange({ ...filters, triggers: [] }),
      testId: 'workflows-library-filter-trigger',
    }),
    pageFilter<WorkflowLibraryStatusFilter>({
      key: 'status',
      title: 'Status',
      groupIcon: <CircleCheckIcon />,
      anyLabel: 'Any status',
      options: WORKFLOW_LIBRARY_STATUS_FILTERS.map((status) => ({
        value: status,
        label: WORKFLOW_LIBRARY_STATUS_LABELS[status],
        count: counts.statuses[status],
      })),
      selected: filters.status === null ? [] : [filters.status],
      onToggle: (status): void =>
        onFiltersChange({
          ...filters,
          status: filters.status === status ? null : status,
        }),
      onClear: (): void => onFiltersChange({ ...filters, status: null }),
      testId: 'workflows-library-filter-status',
    }),
    pageFilter<string>({
      key: 'project',
      title: 'Project',
      groupIcon: <FolderIcon />,
      anyLabel: 'Any project',
      options: [
        ...projects.map((project) => ({
          value: project.id,
          label: project.name,
          count: counts.projects[project.id] ?? 0,
        })),
        {
          value: WORKFLOW_NO_PROJECT,
          label: 'No project',
          count: counts.projects[WORKFLOW_NO_PROJECT] ?? 0,
        },
      ],
      selected: filters.project === null ? [] : [filters.project],
      onToggle: (project): void =>
        onFiltersChange({
          ...filters,
          project: filters.project === project ? null : project,
        }),
      onClear: (): void => onFiltersChange({ ...filters, project: null }),
      testId: 'workflows-library-filter-project',
    }),
    pageFilter<WorkflowLibrarySource>({
      key: 'source',
      title: 'Source',
      groupIcon: <GlobeIcon />,
      anyLabel: 'Any source',
      options: WORKFLOW_LIBRARY_SOURCES.map((source) => ({
        value: source,
        label: WORKFLOW_LIBRARY_SOURCE_LABELS[source],
        count:
          source === 'shared' && sharedCountUnknown
            ? undefined
            : counts.sources[source],
      })),
      selected: filters.source === null ? [] : [filters.source],
      onToggle: (source): void =>
        onFiltersChange({
          ...filters,
          source: filters.source === source ? null : source,
        }),
      onClear: (): void => onFiltersChange({ ...filters, source: null }),
      testId: 'workflows-library-filter-source',
    }),
  ];
  return (
    <PageSearchRow testId="workflows-library-toolbar">
      <WorkflowsSearchField
        value={filters.query}
        onChange={(next): void => onFiltersChange({ ...filters, query: next })}
        placeholder="Search workflows"
        testId="workflows-library-search"
        count={`${String(matched)} of ${String(total)}`}
      />
      <PageSearchControls>
        <PageSearchFilters
          filters={pageFilters}
          onClearAll={(): void =>
            onFiltersChange({
              ...filters,
              triggers: [],
              status: null,
              project: null,
              source: null,
            })
          }
          testId="workflows-library-filter"
        />
        <SortDropdown<WorkflowLibrarySort>
          value={sort}
          options={WORKFLOW_LIBRARY_SORTS.map((value) => ({
            value,
            label: WORKFLOW_LIBRARY_SORT_LABELS[value],
          }))}
          onChange={onSortChange}
          testId="workflows-library-sort"
        />
      </PageSearchControls>
    </PageSearchRow>
  );
}

export interface WorkflowsLibraryPaginationProps {
  readonly page: WorkflowLibraryPage;
  readonly onPageChange: (page: number) => void;
}

/** `1–25 of 38 workflows` and the page buttons. */
export function WorkflowsLibraryPagination({
  page,
  onPageChange,
}: WorkflowsLibraryPaginationProps): JSX.Element {
  const numbers = Array.from({ length: page.pageCount }, (_, i) => i + 1);
  return (
    <div
      className="flex items-center justify-between gap-4 pt-3 text-xs fg-tertiary"
      data-testid="workflows-library-pagination"
    >
      <span className="tabular-nums" data-testid="workflows-library-range">
        {page.from}–{page.to} of {page.total}{' '}
        {page.total === 1 ? 'workflow' : 'workflows'}
      </span>
      {page.pageCount > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            aria-label="Previous page"
            disabled={page.page === 1}
            data-testid="workflows-library-page-previous"
            onClick={(): void => onPageChange(page.page - 1)}
          >
            <ChevronLeftMediumIcon size="sm" aria-hidden="true" />
          </Button>
          {numbers.map((number) => (
            <Button
              key={number}
              variant={number === page.page ? 'secondary' : 'ghost'}
              size="compact"
              aria-current={number === page.page ? 'page' : undefined}
              data-testid={`workflows-library-page-${String(number)}`}
              onClick={(): void => onPageChange(number)}
            >
              <span className="tabular-nums">{number}</span>
            </Button>
          ))}
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            aria-label="Next page"
            disabled={page.page === page.pageCount}
            data-testid="workflows-library-page-next"
            onClick={(): void => onPageChange(page.page + 1)}
          >
            <ChevronRightMediumIcon size="sm" aria-hidden="true" />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

export interface WorkflowsLibraryEmptyStateProps {
  readonly filters: WorkflowLibraryFilters;
  readonly onClearFilters: () => void;
  /**
   * The New workflow control for the first-use state; omitted when the host
   * cannot create one. A filtered Library offers Clear filters alone.
   */
  readonly newWorkflow?: ReactNode;
}

/**
 * The Library with nothing to show: `No workflows match …` with the one
 * action that clears it when a search or filter hides every row, otherwise
 * the first-use state.
 */
export function WorkflowsLibraryEmptyState({
  filters,
  onClearFilters,
  newWorkflow,
}: WorkflowsLibraryEmptyStateProps): JSX.Element {
  const filtered = workflowLibraryFiltersActive(filters);
  if (filtered) {
    return (
      <SearchEmptyState
        testId="workflows-library-no-matches"
        title={describeNoLibraryMatches(filters)}
        actionLabel={describeClearLibraryFilters(filters)}
        onAction={onClearFilters}
        actionTestId="workflows-library-empty-clear"
      />
    );
  }
  return (
    <EmptyState
      testId="workflows-library-empty"
      title="No workflows yet"
      subtitle="Workflows you create or add show up here, whether they run on a schedule or when you start them."
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {newWorkflow}
        </div>
      }
    />
  );
}
