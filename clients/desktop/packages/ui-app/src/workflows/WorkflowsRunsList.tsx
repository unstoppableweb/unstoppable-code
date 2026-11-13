'use client';

import { useCallback, useMemo, type JSX, type ReactNode } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { useMinuteClock } from '@canopy/ui-shared/lib';
import {
  EMPTY_WORKFLOW_RUN_FILTERS,
  filterWorkflowRunRows,
  workflowRunFiltersActive,
  type WorkflowRunFilters,
} from './run-search';
import {
  WORKFLOW_RUN_STATUSES,
  type WorkflowRunAction,
  type WorkflowRunKind,
  type WorkflowRunRow,
  type WorkflowRunStarter,
  type WorkflowRunStatus,
} from './workflow-run-model';
import {
  WorkflowsRunsEmptyState,
  WorkflowsRunsTable,
  WorkflowsRunsToolbar,
  type WorkflowsRunsLibraryPreview,
} from './WorkflowsRuns';

export interface WorkflowsRunsListProps {
  /** Every row the host lists, before the search and filters apply. */
  readonly rows: readonly WorkflowRunRow[];
  /** The first load has not finished; shown while there are no rows yet. */
  readonly loading: boolean;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly filters: WorkflowRunFilters;
  readonly onFiltersChange: (filters: WorkflowRunFilters) => void;
  /** Status filter values. Defaults to every status. */
  readonly statuses?: readonly WorkflowRunStatus[];
  /** Kind filter values; the Kind menu shows only with two or more. */
  readonly kinds: readonly WorkflowRunKind[];
  /** Started-by filter values: what this host's runs can record. */
  readonly starters: readonly WorkflowRunStarter[];
  readonly onOpen: (row: WorkflowRunRow) => void;
  readonly onAction: (row: WorkflowRunRow, action: WorkflowRunAction) => void;
  readonly busyKeys?: ReadonlySet<string>;
  /** An older page might hold more matching runs. */
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  /**
   * Shown instead of `No runs yet` when there are no rows at all. A search or
   * filter that hides every row still shows `No runs match`.
   */
  readonly emptyState?: ReactNode;
  readonly onRunWorkflow?: () => void;
  readonly onNewWorkflow?: () => void;
  readonly onBrowseMarketplace?: () => void;
  /** Library workflows `No runs yet` previews; omit to preview none. */
  readonly libraryPreview?: WorkflowsRunsLibraryPreview;
  /** A row to mark as selected. */
  readonly highlightKey?: string | null;
}

/**
 * A searchable, filterable runs list: toolbar, table and empty state. It is
 * controlled, so the host owns the rows, query, filters and actions, and
 * renders any dialogs its actions open.
 */
export function WorkflowsRunsList({
  rows,
  loading,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  statuses = WORKFLOW_RUN_STATUSES,
  kinds,
  starters,
  onOpen,
  onAction,
  busyKeys,
  hasMore,
  loadingMore,
  onLoadMore,
  emptyState,
  onRunWorkflow,
  onNewWorkflow,
  onBrowseMarketplace,
  libraryPreview,
  highlightKey,
}: WorkflowsRunsListProps): JSX.Element {
  // One clock for the table, advancing each minute.
  const now = useMinuteClock();

  const visible = useMemo(
    () => filterWorkflowRunRows(rows, query, filters),
    [rows, filters, query],
  );

  const clearFilters = useCallback((): void => {
    onQueryChange('');
    onFiltersChange(EMPTY_WORKFLOW_RUN_FILTERS);
  }, [onFiltersChange, onQueryChange]);

  const emptyQuery = rows.length === 0 ? '' : query;
  const emptyFilters = rows.length === 0 ? EMPTY_WORKFLOW_RUN_FILTERS : filters;

  return (
    <>
      {rows.length > 0 && (
        <WorkflowsRunsToolbar
          query={query}
          onQueryChange={onQueryChange}
          filters={filters}
          onFiltersChange={onFiltersChange}
          statuses={statuses}
          kinds={kinds}
          starters={starters}
        />
      )}
      {loading && rows.length === 0 ? (
        <p className="py-8 text-center text-s fg-secondary" role="status">
          Loading runs…
        </p>
      ) : visible.length === 0 ? (
        <>
          {emptyState !== undefined &&
          !workflowRunFiltersActive(emptyQuery, emptyFilters) ? (
            emptyState
          ) : (
            <WorkflowsRunsEmptyState
              query={emptyQuery}
              filters={emptyFilters}
              onClearFilters={clearFilters}
              onRunWorkflow={onRunWorkflow}
              onNewWorkflow={onNewWorkflow}
              onBrowseMarketplace={onBrowseMarketplace}
              libraryPreview={libraryPreview}
            />
          )}
          {/* No loaded run matches, but an older one still might, also
              when the rows are narrowed to one workflow. */}
          {hasMore && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="compact"
                disabled={loadingMore}
                aria-busy={loadingMore}
                data-testid="workflows-runs-load-more"
                onClick={onLoadMore}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      ) : (
        <WorkflowsRunsTable
          rows={visible}
          now={now}
          onOpen={onOpen}
          onAction={onAction}
          busyKeys={busyKeys}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
          highlightKey={highlightKey}
          showKind={kinds.length > 1}
        />
      )}
    </>
  );
}
