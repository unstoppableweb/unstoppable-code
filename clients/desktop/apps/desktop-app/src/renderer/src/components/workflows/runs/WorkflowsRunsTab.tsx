import { useCallback, useMemo, type JSX } from 'react';
import {
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  selectRunsLibraryPreview,
  type WorkflowLibraryRow,
  type WorkflowsRunsLibraryPreview,
} from '@canopy/ui-app/workflows';
import { Notice } from '@canopy/ui-shared/components';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import type { WorkflowLibraryData } from '../library/useWorkflowLibraryRows';
import type { WorkflowRunFeed } from './useWorkflowRunFeed';
import { useWorkflowRunRowActions, WorkflowRunsList } from './WorkflowRunsList';

export interface WorkflowsRunsTabProps {
  readonly feed: WorkflowRunFeed;
  /** Each is omitted when the action is unavailable here. */
  /** Starts a run; absent when the Library has nothing to run. */
  readonly onRunWorkflow?: () => void;
  readonly onNewWorkflow?: () => void;
  /** The Library's rows, previewed while there are no runs (CAN-4311). */
  readonly library?: Pick<WorkflowLibraryData, 'rows' | 'targets'>;
}

/**
 * Workflows → Runs (CAN-3981): pipeline runs, automation runs and watchers in
 * one feed. Every action goes to the handler that already owns it, and always
 * carries the row's own id.
 */
export function WorkflowsRunsTab({
  feed,
  onRunWorkflow,
  onNewWorkflow,
  library,
}: WorkflowsRunsTabProps): JSX.Element {
  const query = useWorkflowsViewStore((state) => state.runsQuery);
  const filters = useWorkflowsViewStore((state) => state.runsFilters);
  const setQuery = useWorkflowsViewStore((state) => state.setRunsQuery);
  const setFilters = useWorkflowsViewStore((state) => state.setRunsFilters);
  const librarySort = useWorkflowsViewStore((state) => state.librarySort);
  const rowActions = useWorkflowRunRowActions(feed);

  // Older pages hold automation runs, and cloud runs while they are listed.
  const hasMore =
    (feed.hasMore &&
      (filters.kind === null || filters.kind === 'automation')) ||
    (feed.cloudHasMore &&
      (filters.kind === null || filters.kind === 'pipeline'));

  const targets = library?.targets;
  const openLibraryRow = useCallback(
    (row: WorkflowLibraryRow): void => {
      // A local pipeline is revealed: the Library clears its filters, pages
      // to the row and marks it. Anything else is found by its name.
      const target = targets?.get(row.key);
      if (target?.kind === 'pipeline' && target.pipeline.source !== 'project') {
        useNavigationStore
          .getState()
          .openPipelineReveal({ pipelineId: target.pipeline.id });
        return;
      }
      useWorkflowsViewStore.getState().setLibraryFilters({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        query: row.name,
      });
      useNavigationStore.getState().navigate('workflows-library');
    },
    [targets],
  );
  const libraryRows = library?.rows;
  const libraryPreview = useMemo(
    (): WorkflowsRunsLibraryPreview | undefined =>
      libraryRows === undefined
        ? undefined
        : {
            rows: selectRunsLibraryPreview(libraryRows, librarySort),
            onOpenRow: openLibraryRow,
            onSeeLibrary: (): void => {
              useWorkflowsViewStore.getState().clearLibraryFilters();
              useNavigationStore.getState().navigate('workflows-library');
            },
          },
    [libraryRows, librarySort, openLibraryRow],
  );

  return (
    <div
      ref={rowActions.dialogAnchorRef}
      className="flex flex-col gap-4 pt-4"
      data-testid="workflows-runs"
    >
      {feed.error !== null && (
        <Notice intent="destructive" data-testid="workflows-runs-error">
          On-demand workflow runs could not be loaded. Scheduled workflow runs
          and watchers are still listed.
        </Notice>
      )}
      {feed.cloudError !== null && (
        <Notice intent="attention" data-testid="workflows-runs-cloud-error">
          Cloud runs could not be loaded. Runs on this computer are still
          listed.
        </Notice>
      )}
      <WorkflowRunsList
        rows={feed.rows}
        loading={feed.loading}
        query={query}
        onQueryChange={setQuery}
        filters={filters}
        onFiltersChange={setFilters}
        onOpen={rowActions.openRow}
        onAction={rowActions.handleAction}
        busyKeys={rowActions.busyKeys}
        hasMore={hasMore}
        loadingMore={feed.loadingMore}
        onLoadMore={feed.loadMore}
        onRunWorkflow={onRunWorkflow}
        onNewWorkflow={onNewWorkflow}
        onBrowseMarketplace={(): void =>
          useNavigationStore.getState().navigate('plugins')
        }
        libraryPreview={libraryPreview}
      />
      {feed.loadMoreFailed && (
        <Notice intent="attention" data-testid="workflows-runs-load-more-error">
          Some older automation runs could not be loaded. Load more to try
          again.
        </Notice>
      )}
      {rowActions.dialogs}
    </div>
  );
}
