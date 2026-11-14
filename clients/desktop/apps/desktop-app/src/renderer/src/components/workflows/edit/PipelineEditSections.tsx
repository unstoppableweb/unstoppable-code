import { useEffect, useMemo, useState, type JSX } from 'react';
import type {
  PipelineInfo,
  PipelineTriggerType,
} from '@canopy/execution-engine/types/pipeline';
import {
  EMPTY_WORKFLOW_RUN_FILTERS,
  PipelineTriggers,
  type PipelineTriggerSchedules,
  type WorkflowRunFilters,
} from '@canopy/ui-app/workflows';
import { Notice } from '@canopy/ui-shared/components';
import { useExecutionFeedStore } from '@/lib/workflows/execution-feed';
import { automationRunKey } from '@/lib/workflows/run-feed';
import {
  automationsRunningPipeline,
  hooksRunningPipeline,
  pipelineStartKinds,
  runsForPipeline,
} from '@/lib/workflows/pipeline-automations';
import type { WorkflowEditTarget } from '@/lib/workflows/edit-target';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
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

export interface PipelineTriggerSectionProps {
  readonly pipeline: PipelineInfo;
  /** Every pipeline the Library lists, for the automation-to-pipeline match. */
  readonly pipelines: readonly PipelineInfo[];
  readonly automations: AutomationsPageBodyApi;
  /** This pipeline's shell target; an opened automation's Back returns here. */
  readonly returnTo: WorkflowEditTarget;
  /** The triggers the pipeline declares, unsaved edits included. */
  readonly triggerTypes: readonly PipelineTriggerType[] | undefined;
  /** Opens where the declared triggers are edited; absent when read-only. */
  readonly onEditTriggers?: () => void;
  /** A workflow page's schedules, in place of its automations (CAN-5782). */
  readonly schedules?: PipelineTriggerSchedules;
}

/**
 * A pipeline's Trigger section (CAN-4072): what can start it. Its declared
 * triggers, the hooks in any project that run it, and the automations that
 * run it. Hook and automation rows open where each is configured; an opened
 * automation's Back returns to this section.
 */
export function PipelineTriggerSection({
  pipeline,
  pipelines,
  automations,
  returnTo,
  triggerTypes,
  onEditTriggers,
  schedules,
}: PipelineTriggerSectionProps): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);
  const hooks = useMemo(
    () => hooksRunningPipeline(projects, pipeline),
    [pipeline, projects],
  );
  const automationRows = useMemo(
    () =>
      automationsRunningPipeline(automations.activities, pipeline, {
        pipelines,
      }).map((row) => ({
        key: row.activity.id,
        name: row.activity.name,
        scheduleText: row.scheduleText,
        enabled: row.enabled,
      })),
    [automations.activities, pipeline, pipelines],
  );
  return (
    <PipelineTriggers
      starts={pipelineStartKinds(triggerTypes)}
      hooks={hooks}
      automations={automationRows}
      onOpenHook={(row): void => {
        const hook = hooks.find((entry) => entry.key === row.key);
        if (!hook) return;
        useNavigationStore.getState().openWorkspaceSettings({
          workspaceId: hook.projectId,
          initialTab: 'hooks',
        });
      }}
      onOpenAutomation={(row): void =>
        useNavigationStore.getState().openAutomationEdit({
          activityId: row.key,
          returnTo: { ...returnTo, section: 'trigger' },
        })
      }
      {...(onEditTriggers ? { onEditStarts: onEditTriggers } : {})}
      {...(schedules ? { schedules } : {})}
    />
  );
}

export interface PipelineRunsSectionProps {
  readonly pipeline: PipelineInfo;
  readonly pipelines: readonly PipelineInfo[];
  readonly automations: AutomationsPageBodyApi;
  /** A workflow page's schedule records, whose every run is listed. */
  readonly scheduleIds?: ReadonlySet<string>;
}

/**
 * A pipeline's Runs section (CAN-4072): the Workflows Runs feed narrowed to
 * this pipeline's runs and the automation runs that started them. Its search
 * and filters are its own, so the Runs tab keeps what it had.
 */
export function PipelineRunsSection({
  pipeline,
  pipelines,
  automations,
  scheduleIds,
}: PipelineRunsSectionProps): JSX.Element {
  // A run row's Open workflow asks for one of this page's runs (CAN-5782).
  const requested = useRequestedAutomationRun(
    (activityId) => scheduleIds?.has(activityId) === true,
  );
  const feed = useWorkflowRunFeed({
    activities: automations.activities,
    recentRuns: automations.recentRuns,
    scope: automations.scope,
    automationsLoading: automations.loading,
    ...(requested ? { historyActivityId: requested.activityId } : {}),
  });
  const executions = useExecutionFeedStore((state) => state.executions);
  const rows = useMemo(
    () =>
      runsForPipeline(feed.rows, pipeline, {
        pipelines,
        activities: automations.activities,
        executions,
        ...(scheduleIds ? { scheduleIds } : {}),
      }).map((row) =>
        // The Library is the page behind this shell, so Open in Library
        // would only reset its filters, and this is the workflow.
        row.actions.includes('open-library') ||
        row.actions.includes('open-workflow')
          ? {
              ...row,
              actions: row.actions.filter(
                (action) =>
                  action !== 'open-library' && action !== 'open-workflow',
              ),
            }
          : row,
      ),
    [
      automations.activities,
      executions,
      feed.rows,
      pipeline,
      pipelines,
      scheduleIds,
    ],
  );
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<WorkflowRunFilters>(
    EMPTY_WORKFLOW_RUN_FILTERS,
  );
  const rowActions = useWorkflowRunRowActions(feed);
  const hasMore =
    feed.hasMore && (filters.kind === null || filters.kind === 'automation');

  // A requested run may be older than the shared hot window: read its
  // schedule's history a page at a time until it is listed. A failed page
  // ends the search, as running out of history does.
  const { loadMore } = feed;
  const feedBusy = feed.loading || feed.loadingMore;
  const historyLeft = feed.hasMore && !feed.loadMoreFailed;
  const requestedKey =
    requested === undefined ? undefined : automationRunKey(requested.runId);
  // Each page that lands changes `rows`, so the search goes on from there.
  useEffect(() => {
    if (requestedKey === undefined || feedBusy || !historyLeft) return;
    if (rows.some((row) => row.key === requestedKey)) return;
    loadMore();
  }, [feedBusy, historyLeft, loadMore, requestedKey, rows]);
  const { highlightedKey, setSectionRef } = useAutomationRunHighlight({
    runId: requested?.runId,
    rows,
    feedBusy,
    hasMore: historyLeft,
    dialogAnchorRef: rowActions.dialogAnchorRef,
  });

  return (
    <div
      ref={setSectionRef}
      className="flex flex-col gap-4"
      data-testid="pipeline-runs-section"
    >
      {feed.error !== null && (
        <Notice
          errorSource="workflows-runs-error-pipeline-edit-sections"
          intent="destructive"
          data-testid="workflows-runs-error"
        >
          Workflow runs could not be loaded. Automation runs are still listed.
        </Notice>
      )}
      <WorkflowRunsList
        rows={rows}
        loading={feed.loading}
        query={query}
        onQueryChange={setQuery}
        filters={filters}
        onFiltersChange={setFilters}
        kinds={['pipeline', 'automation']}
        onOpen={rowActions.openRow}
        onAction={rowActions.handleAction}
        busyKeys={rowActions.busyKeys}
        hasMore={hasMore}
        loadingMore={feed.loadingMore}
        onLoadMore={feed.loadMore}
        highlightKey={highlightedKey}
        emptyState={
          <p className="text-s fg-tertiary" data-testid="workflow-edit-no-runs">
            {/* Older pages may still hold this pipeline's runs. */}
            {hasMore ? 'No recent runs' : 'No runs yet'}
          </p>
        }
      />
      {rowActions.dialogs}
    </div>
  );
}
