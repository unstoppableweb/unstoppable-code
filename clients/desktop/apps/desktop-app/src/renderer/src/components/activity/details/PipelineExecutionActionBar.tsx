import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type { JSX, ReactNode } from 'react';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/execution-engine/types/pipeline';
import {
  ChatIcon,
  PipelineIcon,
  PlanModeIcon,
  RerunIcon,
  RetryIcon,
} from '@canopy/ui-shared/icons';
import { FileIcon as AppCatalogFileIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  canRetryExecution,
  canRerunExecution,
  hasRerunReplayData,
} from '@/lib/execution-actions';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';
import { isPipelineExecutionActiveStatus } from '../utils';
import type { PipelineExecutionActions } from '../usePipelineExecutionActions';
import type { PipelineDetailDestination } from './pipelineDetailTypes';
import { Surface, Button } from '@canopy/ui-shared/components';

/**
 * Live run actions above the detail body: watchers, retry, start over,
 * debug, plan and report follow-ups, and cancel. Every command goes through
 * the shared execution-action controller for the run shown. Opening another
 * surface reports it through `onNavigatedAway`; closing is the host's call.
 * A host that shows the report inline handles View Report itself
 * (`onViewReport`), so it neither opens the dialog nor navigates away.
 * Archived runs never render this bar.
 *
 * `leading` is a full-height cell before the actions (a panel's job-list
 * toggle). With it, the bar always renders so the cell keeps its place, and
 * the actions wrap beside it at narrow widths. The leading cell draws its own
 * share of the bar's bottom rule, so a hover target it owns reaches the edge
 * of the content below with no gap.
 */
export function PipelineExecutionActionBar({
  executionId,
  state,
  summary,
  actions,
  watchers,
  onNavigatedAway,
  onViewReport,
  leading,
}: {
  executionId: string;
  state: ExecutionState;
  summary?: ExecutionSummary;
  actions: PipelineExecutionActions;
  watchers: AppAdvisorWatcherSummary[];
  onNavigatedAway?: (destination: PipelineDetailDestination) => void;
  /**
   * Shows the report in place of opening the report dialog. Hosts that
   * render the report inline (a panel's Summary) supply it; without it,
   * View Report opens the dialog through the controller.
   */
  onViewReport?: () => void;
  leading?: ReactNode;
}): JSX.Element | null {
  const canPlanFollowUp =
    summary?.has_plan === true || state.plan_hash_after !== undefined;
  const canOpenTrackedPlan = Boolean(state.planId ?? summary?.planId);
  const canReportFollowUp = Boolean(
    state.report_outputs?.report_file || state.report_outputs?.report_json_file,
  );
  const canRetry = canRetryExecution(state);
  const canRerun = canRerunExecution(state) && hasRerunReplayData(state);
  const debugVisible = state.status === 'failure';
  const cancelVisible = isPipelineExecutionActiveStatus(state.status);
  const isRetrying = actions.retryingIds.has(executionId);
  const isRerunning = actions.rerunningIds.has(executionId);
  const isCancelling = actions.cancellingId === executionId;
  const chatFollowUpDisabled = actions.chatFollowUpInProgress;

  const hasFollowUpActions =
    canRetry ||
    canRerun ||
    debugVisible ||
    canPlanFollowUp ||
    canReportFollowUp ||
    cancelVisible;
  const hasWatcherIndicator = watchers.length > 0;
  // Watchers count as a reason to render the bar so the watcher icon has a
  // stable far-left anchor even on watched executions with no other actions.
  if (!hasFollowUpActions && !hasWatcherIndicator && leading === undefined) {
    return null;
  }

  const content = (
    <>
      {hasWatcherIndicator && (
        // Watcher indicator stays anchored far-left; `mr-auto` pushes the
        // follow-up action buttons to the right.
        <div className="mr-auto">
          <WatcherManagementButton
            watchers={watchers}
            modalTitle="Workflow watchers"
            modalEmptyMessage="No active watchers for this workflow."
            ariaLabel="Manage workflow watchers"
            dataTestId={`pipeline-detail-watchers-${executionId}`}
          />
        </div>
      )}
      {canRetry && (
        <Button
          variant="secondary"
          size="compact"
          data-testid={`pipeline-detail-retry-${executionId}`}
          onClick={() => void actions.retry(executionId)}
          disabled={isRetrying}
        >
          <RetryIcon size="sm" />
          {isRetrying ? 'Trying again…' : 'Try again'}
        </Button>
      )}
      {canRerun && (
        <Button
          size="compact"
          data-testid={`pipeline-detail-rerun-${executionId}`}
          onClick={() => void actions.rerun(executionId)}
          disabled={isRerunning}
        >
          <RerunIcon size="sm" />
          {isRerunning ? 'Starting over…' : 'Start over'}
        </Button>
      )}
      {debugVisible && (
        <Button
          size="compact"
          data-testid={`pipeline-detail-debug-failure-${executionId}`}
          aria-label={`Debug failed workflow with ${ORCHESTRATOR_LABEL}`}
          onClick={() => {
            void actions.debugFailure(executionId).then((opened) => {
              if (opened) onNavigatedAway?.('debug');
            });
          }}
          disabled={actions.debuggingFailureId !== null}
        >
          <ChatIcon size="sm" />
          {actions.debuggingFailureId === executionId ? 'Opening…' : 'Debug'}
        </Button>
      )}
      {canPlanFollowUp && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-3xs font-medium fg-secondary">Plan</span>
          <Button
            size="compact"
            data-testid={`pipeline-detail-chat-follow-up-${executionId}`}
            disabled={chatFollowUpDisabled}
            onClick={() => {
              void actions.chatFollowUp(executionId).then((opened) => {
                if (opened) onNavigatedAway?.('chat');
              });
            }}
          >
            <ChatIcon size="sm" />
            Chat
          </Button>
          <Button
            size="compact"
            data-testid={`pipeline-detail-pipeline-follow-up-${executionId}`}
            onClick={() => {
              onNavigatedAway?.('pipeline-follow-up');
              void actions.pipelineFollowUp(executionId);
            }}
          >
            <PipelineIcon size="sm" />
            Workflow
          </Button>
          {canOpenTrackedPlan && (
            <Button
              size="compact"
              data-testid={`pipeline-detail-plan-${executionId}`}
              onClick={() => {
                void actions.openPlan(executionId).then((opened) => {
                  if (opened) onNavigatedAway?.('plan');
                });
              }}
            >
              <PlanModeIcon size="sm" />
              View plan
            </Button>
          )}
        </div>
      )}
      {canReportFollowUp && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-3xs font-medium fg-secondary">Report</span>
          <Button
            size="compact"
            data-testid={`pipeline-detail-report-chat-follow-up-${executionId}`}
            disabled={chatFollowUpDisabled}
            onClick={() => {
              void actions.reportChatFollowUp(executionId).then((opened) => {
                if (opened) onNavigatedAway?.('report-chat');
              });
            }}
          >
            Chat
          </Button>
          <Button
            size="compact"
            data-testid={`pipeline-detail-view-report-${executionId}`}
            onClick={() => {
              if (onViewReport !== undefined) {
                onViewReport();
                return;
              }
              onNavigatedAway?.('report');
              actions.openReport(executionId);
            }}
          >
            <AppCatalogFileIcon size="sm" aria-hidden="true" />
            View report
          </Button>
        </div>
      )}
      {cancelVisible && (
        <Button
          variant="ghost-destructive"
          size="compact"
          data-testid={`pipeline-detail-cancel-${executionId}`}
          onClick={() => void actions.cancel(executionId)}
          disabled={isCancelling}
        >
          {isCancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
      )}
    </>
  );

  if (leading === undefined) {
    return (
      <Surface variant="section" boundary="bottom" className="shrink-0">
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 py-2">
          {content}
        </div>
      </Surface>
    );
  }
  // The row's bottom rule is drawn by each cell rather than the row, so the
  // leading cell owns the rule beneath it (see `leading`).
  return (
    <div
      className="flex shrink-0 items-stretch"
      data-testid="pipeline-detail-toolbar"
    >
      {leading}
      <Surface
        variant="section"
        boundary="bottom"
        className="min-w-0 flex min-h-0 flex-1 flex-col"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 py-2 pl-2 pr-3">
          {content}
        </div>
      </Surface>
    </div>
  );
}
