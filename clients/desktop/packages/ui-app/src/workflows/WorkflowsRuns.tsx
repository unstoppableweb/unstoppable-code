'use client';

import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import { useState, type JSX, type ReactNode } from 'react';
import {
  Button,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  EmptyState,
  ListRow,
  PageSearchControls,
  SearchEmptyState,
  PageSearchFilters,
  PageSearchRow,
  StatusGlyph,
  TableActionsCell,
  Tooltip,
  pageFilter,
} from '@canopy/ui-shared/components';
import {
  ChatIcon,
  DocumentSearchIcon,
  EyeOffIcon,
  MessageIcon,
  RerunIcon,
  StopIcon,
  WorkflowIcon,
  WorkflowsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import {
  EMPTY_WORKFLOW_RUN_FILTERS,
  runSearchHint,
  workflowRunFiltersActive,
  type WorkflowRunFilters,
} from './run-search';
import type { WorkflowLibraryRow } from './workflow-library-model';
import { WorkflowStepChain } from './WorkflowsLibrary';
import {
  WORKFLOW_RUN_ACTION_LABELS,
  WORKFLOW_RUN_KIND_LABELS,
  WORKFLOW_RUN_LOCATION_LABELS,
  WORKFLOW_RUN_STARTER_LABELS,
  WORKFLOW_RUN_STATUS_LABELS,
  menuWorkflowRunActions,
  primaryWorkflowRunAction,
  workflowRunDurationLabel,
  workflowRunStatusGlyphState,
  workflowRunWhereLabel,
  type WorkflowRunAction,
  type WorkflowRunKind,
  type WorkflowRunRow,
  type WorkflowRunStarter,
  type WorkflowRunStatus,
} from './workflow-run-model';
import { formatRunStarted } from './workflow-time';
import {
  WorkflowsRowMenu,
  type WorkflowsRowMenuItem,
  WorkflowsSearchField,
} from './workflows-controls';
import { Surface } from '@canopy/ui-shared/components';

/** Rows drawn before the footer's Load more reveals the next batch. */
/**
 * Each run menu row's icon and group. Rerun and Retry are one action's two
 * forms, so they share an icon; Hide and Cancel close the menu as removals.
 */
const RUN_MENU_ROWS: Readonly<
  Record<
    WorkflowRunAction,
    Pick<WorkflowsRowMenuItem, 'icon' | 'group' | 'destructive' | 'removal'>
  >
> = {
  inspect: { icon: <DocumentSearchIcon />, group: 'open' },
  'open-library': { icon: <WorkflowsIcon />, group: 'open' },
  'open-workflow': { icon: <WorkflowIcon />, group: 'open' },
  rerun: { icon: <RerunIcon />, group: 'run' },
  retry: { icon: <RerunIcon />, group: 'run' },
  respond: { icon: <MessageIcon />, group: 'chat' },
  'go-to-chat': { icon: <ChatIcon />, group: 'chat' },
  hide: { icon: <EyeOffIcon />, removal: true },
  cancel: { icon: <StopIcon />, destructive: true },
};

export const WORKFLOWS_RUNS_RENDER_BATCH = 100;

/**
 * The status mark at the head of a run row: the shared status glyph, named
 * in a tooltip and for readers since the row says the status nowhere else.
 */
export function WorkflowRunStatusGlyph({
  status,
}: {
  readonly status: WorkflowRunStatus;
}): JSX.Element {
  const label = WORKFLOW_RUN_STATUS_LABELS[status];
  return (
    <Tooltip label={label}>
      <span
        className="flex h-5 w-4 shrink-0 items-center justify-center"
        data-status={status}
        data-testid="workflows-run-status"
      >
        <StatusGlyph state={workflowRunStatusGlyphState(status)} />
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}

export interface WorkflowsRunsToolbarProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly filters: WorkflowRunFilters;
  readonly onFiltersChange: (filters: WorkflowRunFilters) => void;
  /** Values offered by each menu; a host lists only what it can show. */
  readonly statuses: readonly WorkflowRunStatus[];
  readonly kinds: readonly WorkflowRunKind[];
  readonly starters: readonly WorkflowRunStarter[];
}

/**
 * Runs search with its Status, Kind and Started by filters, and the message
 * for an unrecognized token.
 */
export function WorkflowsRunsToolbar({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  statuses,
  kinds,
  starters,
}: WorkflowsRunsToolbarProps): JSX.Element {
  const hint = runSearchHint(query);
  const pageFilters = [
    pageFilter<WorkflowRunStatus>({
      key: 'status',
      title: 'Status',
      anyLabel: 'Any status',
      options: statuses.map((status) => ({
        value: status,
        label: WORKFLOW_RUN_STATUS_LABELS[status],
      })),
      selected: filters.status === null ? [] : [filters.status],
      onToggle: (status): void =>
        onFiltersChange({
          ...filters,
          status: filters.status === status ? null : status,
        }),
      onClear: (): void => onFiltersChange({ ...filters, status: null }),
      testId: 'workflows-runs-filter-status',
    }),
    ...(kinds.length > 1
      ? [
          pageFilter<WorkflowRunKind>({
            key: 'kind',
            title: 'Kind',
            anyLabel: 'Any kind',
            options: kinds.map((kind) => ({
              value: kind,
              label: WORKFLOW_RUN_KIND_LABELS[kind],
            })),
            selected: filters.kind === null ? [] : [filters.kind],
            onToggle: (kind): void =>
              onFiltersChange({
                ...filters,
                kind: filters.kind === kind ? null : kind,
              }),
            onClear: (): void => onFiltersChange({ ...filters, kind: null }),
            testId: 'workflows-runs-filter-kind',
          }),
        ]
      : []),
    pageFilter<WorkflowRunStarter>({
      key: 'starter',
      title: 'Started by',
      // The trigger names the filter until one is picked.
      label:
        filters.starter === null
          ? 'Started by'
          : WORKFLOW_RUN_STARTER_LABELS[filters.starter],
      anyLabel: 'Anything',
      options: starters.map((starter) => ({
        value: starter,
        label: WORKFLOW_RUN_STARTER_LABELS[starter],
      })),
      selected: filters.starter === null ? [] : [filters.starter],
      onToggle: (starter): void =>
        onFiltersChange({
          ...filters,
          starter: filters.starter === starter ? null : starter,
        }),
      onClear: (): void => onFiltersChange({ ...filters, starter: null }),
      testId: 'workflows-runs-filter-starter',
    }),
  ];
  return (
    <div className="flex flex-col gap-1.5" data-testid="workflows-runs-toolbar">
      <PageSearchRow>
        <WorkflowsSearchField
          value={query}
          onChange={onQueryChange}
          placeholder="Search runs"
          testId="workflows-runs-search"
        />
        <PageSearchControls>
          <PageSearchFilters
            filters={pageFilters}
            onClearAll={(): void => onFiltersChange(EMPTY_WORKFLOW_RUN_FILTERS)}
            testId="workflows-runs-filter"
          />
        </PageSearchControls>
      </PageSearchRow>
      {hint === null ? null : (
        <p className="text-xs fg-tertiary" data-testid="workflows-runs-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export interface WorkflowsRunsTableProps {
  /** Filtered and sorted by the host; drawn in this order. */
  readonly rows: readonly WorkflowRunRow[];
  /** Epoch milliseconds, so the Started column is stable within a render. */
  readonly now: number;
  readonly locale?: string;
  /** Opens a row's result. Only called for rows whose result is available. */
  readonly onOpen: (row: WorkflowRunRow) => void;
  readonly onAction: (row: WorkflowRunRow, action: WorkflowRunAction) => void;
  /** Rows with an action in flight; their buttons are disabled. */
  readonly busyKeys?: ReadonlySet<string>;
  /**
   * Host action buttons for a row, in place of the default button. The More
   * menu still follows them.
   */
  readonly renderActions?: (row: WorkflowRunRow) => ReactNode;
  /** More runs can be fetched from the host. */
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: () => void;
  /** A row to mark as selected, e.g. the run a chat linked to. */
  readonly highlightKey?: string | null;
  /**
   * Shows the Kind column. A host that lists one kind of run leaves it out,
   * as the toolbar leaves out its Kind menu.
   */
  readonly showKind?: boolean;
}

/**
 * The Runs feed table (CAN-3981): one row per automation run, pipeline run or
 * watcher. Rows are focusable; Enter or a click opens the result, and a row
 * without a result expands to show the output it recorded.
 */
export function WorkflowsRunsTable({
  rows,
  now,
  locale,
  onOpen,
  onAction,
  busyKeys,
  renderActions,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  highlightKey = null,
  showKind = true,
}: WorkflowsRunsTableProps): JSX.Element {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [renderLimit, setRenderLimit] = useState(WORKFLOWS_RUNS_RENDER_BATCH);
  // An explicit selection must be rendered before the host can focus it.
  const highlightedIndex =
    highlightKey === null
      ? -1
      : rows.findIndex((row) => row.key === highlightKey);
  const shown = rows.slice(0, Math.max(renderLimit, highlightedIndex + 1));
  const hiddenLoaded = rows.length - shown.length;

  const activate = (row: WorkflowRunRow): void => {
    if (row.result.available) {
      onOpen(row);
      return;
    }
    if (row.output !== undefined) {
      setExpandedKey((current) => (current === row.key ? null : row.key));
    }
  };

  return (
    <div className="flex min-h-0 flex-col" data-testid="workflows-runs-table">
      <DataTableFrame layout="fixed" caption="Workflow runs">
        <DataTableHead>
          <DataTableHeaderCell>Workflow</DataTableHeaderCell>
          {/* A phone keeps the workflow and its actions; the Workflow cell
              says when it started. */}
          {showKind && (
            <DataTableHeaderCell width="6rem" showFrom="md">
              Kind
            </DataTableHeaderCell>
          )}
          <DataTableHeaderCell width="7rem" showFrom="lg">
            Started by
          </DataTableHeaderCell>
          <DataTableHeaderCell width="12rem" showFrom="xl">
            Where
          </DataTableHeaderCell>
          <DataTableHeaderCell width="9rem" showFrom="sm">
            Started
          </DataTableHeaderCell>
          <DataTableHeaderCell width="6rem" showFrom="sm">
            Duration
          </DataTableHeaderCell>
          <DataTableHeaderCell width="8rem" align="right" labelHidden>
            Actions
          </DataTableHeaderCell>
        </DataTableHead>
        <DataTableBody>
          {shown.map((row) => {
            const interactive =
              row.result.available || row.output !== undefined;
            const expanded = expandedKey === row.key;
            const primary = primaryWorkflowRunAction(row.actions);
            const busy = busyKeys?.has(row.key) === true;
            const detail =
              row.detail ??
              (row.result.available ? undefined : row.result.reason);
            return (
              <DataTableRow
                key={row.key}
                data-testid="workflows-run-row"
                data-run-key={row.key}
                data-run-kind={row.kind}
                data-run-status={row.status}
                data-highlighted={highlightKey === row.key ? 'true' : undefined}
                selected={highlightKey === row.key}
                focusable={highlightKey === row.key}
                verticalAlign="top"
                aria-expanded={
                  !row.result.available && row.output !== undefined
                    ? expanded
                    : undefined
                }
                onActivate={interactive ? (): void => activate(row) : undefined}
              >
                <DataTableCell tone="primary">
                  <div className="flex min-w-0 gap-2">
                    <WorkflowRunStatusGlyph status={row.status} />
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={`truncate fg-primary ${REPLAY_MASK_CLASS}`}
                          data-testid="workflows-run-name"
                        >
                          {row.name}
                        </span>
                        {/* The Where column is hidden in narrow windows; a
                            cloud run still says where it ran. */}
                        {row.location === 'cloud' ? (
                          <span
                            className="shrink-0 text-xs fg-tertiary"
                            data-testid="workflows-run-location-cloud"
                          >
                            {WORKFLOW_RUN_LOCATION_LABELS.cloud}
                          </span>
                        ) : null}
                      </span>
                      {detail ? (
                        <span
                          className={`truncate text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
                          data-testid="workflows-run-detail"
                        >
                          {detail}
                        </span>
                      ) : null}
                      <span
                        className="truncate text-xs tabular-nums fg-tertiary sm:hidden"
                        data-testid="workflows-run-when"
                      >
                        {[
                          row.startedAt === undefined
                            ? ''
                            : formatRunStarted(row.startedAt, now, locale),
                          workflowRunDurationLabel(row),
                        ]
                          .filter((part) => part !== '')
                          .join(' · ')}
                      </span>
                      {expanded && row.output !== undefined ? (
                        <Surface
                          variant="group"
                          size="small"
                          className="mt-1 overflow-hidden"
                        >
                          <pre
                            className={`max-h-40 overflow-auto whitespace-pre-wrap p-2 font-mono text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
                            data-testid="workflows-run-output"
                          >
                            {row.output}
                          </pre>
                        </Surface>
                      ) : null}
                    </div>
                  </div>
                </DataTableCell>
                {showKind && (
                  <DataTableCell overflow="truncate" showFrom="md">
                    {WORKFLOW_RUN_KIND_LABELS[row.kind]}
                  </DataTableCell>
                )}
                <DataTableCell overflow="truncate" showFrom="lg">
                  {row.starter ? WORKFLOW_RUN_STARTER_LABELS[row.starter] : ''}
                </DataTableCell>
                <DataTableCell overflow="truncate" showFrom="xl" replay="mask">
                  {workflowRunWhereLabel(row)}
                </DataTableCell>
                <DataTableCell overflow="truncate" showFrom="sm">
                  {row.startedAt === undefined
                    ? ''
                    : formatRunStarted(row.startedAt, now, locale)}
                </DataTableCell>
                <DataTableCell overflow="truncate" showFrom="sm">
                  <span className="tabular-nums">
                    {workflowRunDurationLabel(row)}
                  </span>
                </DataTableCell>
                <DataTableCell align="right">
                  <TableActionsCell testId="workflows-run-actions">
                    {renderActions ? (
                      renderActions(row)
                    ) : primary ? (
                      <Button
                        variant="secondary"
                        size="compact"
                        disabled={busy}
                        data-testid={`workflows-run-action-${primary}`}
                        onClick={(): void => onAction(row, primary)}
                      >
                        {WORKFLOW_RUN_ACTION_LABELS[primary]}
                      </Button>
                    ) : null}
                    <WorkflowsRowMenu
                      label={`More actions for ${row.name}`}
                      testId="workflows-run-menu"
                      items={menuWorkflowRunActions(row.actions).map(
                        (action) => ({
                          id: action,
                          label: WORKFLOW_RUN_ACTION_LABELS[action],
                          ...RUN_MENU_ROWS[action],
                          onSelect: (): void => onAction(row, action),
                        }),
                      )}
                    />
                  </TableActionsCell>
                </DataTableCell>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTableFrame>
      {hiddenLoaded > 0 || hasMore ? (
        <div className="flex justify-end pt-3">
          <Button
            variant="secondary"
            size="compact"
            disabled={loadingMore}
            aria-busy={loadingMore}
            data-testid="workflows-runs-load-more"
            onClick={(): void => {
              // Rows already loaded are revealed first; the host is asked for
              // more only once every loaded row is drawn.
              setRenderLimit(
                (current) =>
                  Math.max(current, highlightedIndex + 1) +
                  WORKFLOWS_RUNS_RENDER_BATCH,
              );
              if (hiddenLoaded === 0) onLoadMore?.();
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Library workflows the empty Runs page points at (CAN-4311). */
export interface WorkflowsRunsLibraryPreview {
  /** At most a few rows; see `selectRunsLibraryPreview`. */
  readonly rows: readonly WorkflowLibraryRow[];
  /** Shows the row's workflow in the Library. */
  readonly onOpenRow: (row: WorkflowLibraryRow) => void;
  readonly onSeeLibrary: () => void;
}

export interface WorkflowsRunsEmptyStateProps {
  /** The search and filters hide every run, rather than there being none. */
  readonly query: string;
  readonly filters: WorkflowRunFilters;
  readonly onClearFilters: () => void;
  /**
   * Starts a run. Pass it when the Library has something to run: it then
   * leads the actions, or follows the Library preview.
   */
  readonly onRunWorkflow?: () => void;
  /** With nothing to run yet: create a workflow. */
  readonly onNewWorkflow?: () => void;
  /** Finds a workflow to add; offered last whenever it is passed. */
  readonly onBrowseMarketplace?: () => void;
  /**
   * Library workflows to preview with no runs. With rows, See your library
   * leads the actions.
   */
  readonly libraryPreview?: WorkflowsRunsLibraryPreview;
}

/**
 * Runs with nothing to show: `No runs yet` with a way forward, or `No runs
 * match` with Clear filters when a search or filter hides them all. With a
 * Library preview, it lists a few Library workflows and leads with See your
 * library, with Run a workflow behind it. Without one, it leads with Run a
 * workflow when there is one to run, otherwise New workflow. Browse
 * Customize comes last whenever the host offers it.
 */
export function WorkflowsRunsEmptyState({
  query,
  filters,
  onClearFilters,
  onRunWorkflow,
  onNewWorkflow,
  onBrowseMarketplace,
  libraryPreview,
}: WorkflowsRunsEmptyStateProps): JSX.Element {
  if (workflowRunFiltersActive(query, filters)) {
    const trimmed = query.trim();
    return (
      <SearchEmptyState
        testId="workflows-runs-no-matches"
        title={
          trimmed === ''
            ? 'No runs match these filters'
            : `No runs match "${trimmed}"`
        }
        actionLabel="Clear filters"
        onAction={onClearFilters}
        actionTestId="workflows-runs-clear-filters"
      />
    );
  }
  const preview =
    libraryPreview !== undefined && libraryPreview.rows.length > 0
      ? libraryPreview
      : undefined;
  const actions = (
    <WorkflowsRunsEmptyActions
      onSeeLibrary={preview?.onSeeLibrary}
      onRunWorkflow={onRunWorkflow}
      onNewWorkflow={onNewWorkflow}
      onBrowseMarketplace={onBrowseMarketplace}
    />
  );
  return (
    <EmptyState
      testId="workflows-runs-empty"
      title="No runs yet"
      subtitle="Workflow runs from your library show up here."
      action={
        preview ? (
          <div className="flex flex-col items-center gap-4">
            <WorkflowsRunsLibraryPreviewList
              rows={preview.rows}
              onOpenRow={preview.onOpenRow}
            />
            {actions}
          </div>
        ) : (
          actions
        )
      }
    />
  );
}

/**
 * The previewed Library workflows: one `ListRow` each, name over its summary
 * and source, the step chain at the end, as the Library row shows them.
 */
function WorkflowsRunsLibraryPreviewList({
  rows,
  onOpenRow,
}: Pick<WorkflowsRunsLibraryPreview, 'rows' | 'onOpenRow'>): JSX.Element {
  return (
    <ul
      className="flex w-full max-w-md flex-col"
      aria-label="From your library"
      data-testid="workflows-runs-library-preview"
    >
      {rows.map((row) => (
        <li key={row.key}>
          <ListRow
            data-testid="workflows-runs-library-preview-row"
            data-row-key={row.key}
            onClick={(): void => onOpenRow(row)}
            description={
              <>
                <span className={REPLAY_MASK_CLASS}>{row.summary}</span>
                {row.sourceLabel ? (
                  <>
                    {row.summary ? ' · ' : ''}
                    {/* A label naming a person is private as a whole: the
                        row model does not carry the name apart from its
                        `Shared by` copy, so the whole label is blocked. */}
                    <span
                      className={row.sourceIsPerson ? REPLAY_BLOCK_CLASS : ''}
                      data-testid="workflows-runs-library-preview-source"
                    >
                      {row.sourceLabel}
                    </span>
                  </>
                ) : null}
              </>
            }
            trailing={
              <WorkflowStepChain
                trigger={row.triggers[0] ?? 'manual'}
                steps={row.steps}
              />
            }
          >
            <span
              className={REPLAY_MASK_CLASS}
              data-testid="workflows-runs-library-preview-name"
            >
              {row.name}
            </span>
          </ListRow>
        </li>
      ))}
    </ul>
  );
}

function WorkflowsRunsEmptyActions({
  onSeeLibrary,
  onRunWorkflow,
  onNewWorkflow,
  onBrowseMarketplace,
}: Pick<
  WorkflowsRunsEmptyStateProps,
  'onRunWorkflow' | 'onNewWorkflow' | 'onBrowseMarketplace'
> & {
  /** Set with a Library preview: See your library then leads. */
  readonly onSeeLibrary?: () => void;
}): JSX.Element {
  const follower = onSeeLibrary ? 'secondary' : 'primary';
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {onSeeLibrary ? (
        <Button
          variant="primary"
          size="md"
          data-testid="workflows-runs-empty-library"
          onClick={onSeeLibrary}
        >
          See your library
        </Button>
      ) : null}
      {onRunWorkflow ? (
        <Button
          variant={follower}
          size="md"
          data-testid="workflows-runs-empty-run"
          onClick={onRunWorkflow}
        >
          Run a workflow
        </Button>
      ) : onNewWorkflow ? (
        <Button
          variant={follower}
          size="md"
          data-testid="workflows-runs-empty-new"
          onClick={onNewWorkflow}
        >
          New workflow
        </Button>
      ) : null}
      {/* Bundled workflows always fill the Library, so Customize stays
          offered beside Run a workflow rather than only with nothing to run. */}
      {onBrowseMarketplace ? (
        <Button
          variant="secondary"
          size="md"
          data-testid="workflows-runs-empty-marketplace"
          onClick={onBrowseMarketplace}
        >
          Browse {CUSTOMIZE_LABEL}
        </Button>
      ) : null}
    </div>
  );
}
