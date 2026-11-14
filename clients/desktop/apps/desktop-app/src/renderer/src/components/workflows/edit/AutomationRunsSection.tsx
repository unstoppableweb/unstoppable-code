import { useEffect, useMemo, useState, type JSX } from 'react';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  EMPTY_WORKFLOW_RUN_FILTERS,
  type WorkflowRunFilters,
} from '@canopy/ui-app/workflows';
import { Notice } from '@canopy/ui-shared/components';
import { runsForAutomation } from '@/lib/workflows/run-feed';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import {
  useAutomationRunHighlight,
  useRequestedAutomationRun,
} from '../runs/useAutomationRunFocus';
import { useWorkflowRunFeed } from '../runs/useWorkflowRunFeed';
import {
  useWorkflowRunRowActions,
  WorkflowRunsList,
} from '../runs/WorkflowRunsList';

export interface AutomationRunsSectionProps {
  readonly activity: ScheduledActivity;
  readonly automations: AutomationsPageBodyApi;
}

/**
 * An automation's Runs section (CAN-4072): the Workflows Runs feed narrowed to
 * this automation's runs, as a pipeline's Runs section is. Its search and
 * filters are its own, so the Runs tab keeps what it had.
 */
export function AutomationRunsSection({
  activity,
  automations,
}: AutomationRunsSectionProps): JSX.Element {
  const feed = useWorkflowRunFeed({
    activities: automations.activities,
    recentRuns: automations.recentRuns,
    scope: automations.scope,
    automationsLoading: automations.loading,
    historyActivityId: activity.id,
  });
  const rows = useMemo(
    () =>
      runsForAutomation(feed.rows, activity.id).map((row) =>
        // The Library is the page behind this shell, so Open in Library
        // would only reset its filters.
        row.actions.includes('open-library')
          ? {
              ...row,
              actions: row.actions.filter(
                (action) => action !== 'open-library',
              ),
            }
          : row,
      ),
    [activity.id, feed.rows],
  );
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<WorkflowRunFilters>(
    EMPTY_WORKFLOW_RUN_FILTERS,
  );
  const rowActions = useWorkflowRunRowActions(feed);

  // The hot window is shared by every automation, so a busy one can push
  // this one's runs out of it. Read its own history once on open.
  const { hasMore, loadMore } = feed;
  // Keep this in render state: a ref updated by this effect would make the
  // focus effect see a started request alongside the old idle feed flags.
  const [historyRequested, setHistoryRequested] = useState(false);
  useEffect(() => {
    if (historyRequested || !hasMore) return;
    setHistoryRequested(true);
    loadMore();
  }, [hasMore, historyRequested, loadMore]);

  // A chat's run tile asks for one run; it is selected once listed.
  const focusRunId = useRequestedAutomationRun(
    (activityId) => activityId === activity.id,
  )?.runId;
  const { highlightedKey, setSectionRef } = useAutomationRunHighlight({
    runId: focusRunId,
    rows,
    feedBusy: feed.loading || feed.loadingMore,
    hasMore,
    dialogAnchorRef: rowActions.dialogAnchorRef,
  });

  const runsPipeline =
    activity.action.type === 'worktree_pipeline' ||
    activity.action.type === 'pipeline_execution_resume';

  return (
    <div
      ref={setSectionRef}
      className="flex flex-col gap-4"
      data-testid="automation-runs-section"
    >
      {feed.error !== null && runsPipeline && (
        <Notice
          errorSource="workflows-runs-error-automation-section"
          intent="destructive"
          data-testid="workflows-runs-error"
        >
          Workflow runs could not be loaded, so a run&apos;s workflow status may
          be out of date.
        </Notice>
      )}
      <WorkflowRunsList
        rows={rows}
        // Until its history is read, an empty list says nothing yet.
        loading={feed.loading || feed.loadingMore}
        query={query}
        onQueryChange={setQuery}
        filters={filters}
        onFiltersChange={setFilters}
        kinds={['automation']}
        onOpen={rowActions.openRow}
        onAction={rowActions.handleAction}
        busyKeys={rowActions.busyKeys}
        hasMore={hasMore}
        loadingMore={feed.loadingMore}
        onLoadMore={loadMore}
        highlightKey={highlightedKey}
        emptyState={
          <p className="text-s fg-tertiary" data-testid="workflow-edit-no-runs">
            {/* Older pages may still hold this automation's runs. */}
            {hasMore ? 'No recent runs' : 'No runs yet'}
          </p>
        }
      />
      {feed.loadMoreFailed && (
        <Notice intent="attention" data-testid="workflows-runs-load-more-error">
          Some older runs could not be loaded. Load more to try again.
        </Notice>
      )}
      {rowActions.dialogs}
    </div>
  );
}
