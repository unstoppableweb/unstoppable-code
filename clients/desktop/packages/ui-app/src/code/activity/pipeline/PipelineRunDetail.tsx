'use client';

import { useMemo, type JSX, type ReactNode } from 'react';
import {
  AnsiOutput,
  Button,
  ExecutionActionButton,
  Notice,
  PauseResumeIcon,
} from '@canopy/ui-shared/components';
import {
  canRerunExecution,
  canResumeExecution,
  canRetryExecution,
  hasRerunReplayData,
} from '@canopy/ui-shared/lib';
import { RerunIcon, RetryIcon } from '@canopy/ui-shared/icons';
import {
  isPipelineExecutionActiveStatus,
  PipelineRunDagProgressBar,
  type PipelineRunExecutionState,
  type PipelineRunPauseResponse,
  type PipelineRunSummary,
} from './PipelineRunRows';
import {
  buildPipelineRunDetailJobs,
  flattenPipelineRunDetailSteps,
  pipelineRunStepKey,
  type PipelineRunDetailView,
} from './PipelineRunDetailModel';
import { PipelineRunPauseForm } from './PipelineRunPauseForm';
import { PipelineRunStepTree } from './PipelineRunStepTree';
import { Surface } from '@canopy/ui-shared/components';

export interface PipelineRunDetailLog {
  /**
   * Step output, oldest first. The Portal splits the bounded ~2 KB
   * `output_tail`; a cloud run's host reads the whole log by position.
   */
  readonly lines: readonly string[];
  /** Only the end of the output is shown. */
  readonly truncated?: boolean;
  /** The host is reading more of this step's log. */
  readonly loading?: boolean;
  /** More lines follow than are shown; the host reads them on request. */
  readonly onLoadMore?: () => void;
  /** Why the log could not be read, in the host's words. */
  readonly error?: string;
}

export interface PipelineRunDetailStepSelection {
  readonly job_id: string;
  readonly step_id: string;
}

export interface PipelineRunDetailProps {
  readonly run: PipelineRunDetailView;
  /** The host's row summary; drives the shared action guards. */
  readonly summary: PipelineRunSummary;
  /** Drives the DAG bar and the rerun-replay gate. Omit when the host has none. */
  readonly executionState?: PipelineRunExecutionState;

  readonly selectedStep: PipelineRunDetailStepSelection | null;
  readonly onSelectStep: (selection: PipelineRunDetailStepSelection) => void;
  readonly log: PipelineRunDetailLog;

  /**
   * Host geometry. `'overlay'` fills its dialog host with two independent
   * scroll panes; `'panel'` sits in normal flow. A typed flag rather than a
   * `className` override: both variants emit height and padding, so which one
   * won would come down to stylesheet order (see `PipelineReadDetail.flushTop`).
   */
  readonly layout?: 'overlay' | 'panel';

  /**
   * Each action renders ONLY when its handler is present AND its guard passes.
   * A host with no command behind an action renders no control rather than a
   * permanently disabled one (CAN-2865; see `PipelineRunRows.tsx`).
   */
  readonly onCancel?: (executionId: string) => void;
  readonly onRetry?: (executionId: string) => void;
  readonly onRerun?: (executionId: string) => void;
  readonly onResume?: (
    executionId: string,
    pauseResponses?: readonly PipelineRunPauseResponse[],
  ) => void;

  readonly cancelling?: boolean;
  readonly retrying?: boolean;
  readonly rerunning?: boolean;
  readonly resuming?: boolean;
  readonly mutationPending?: boolean;
  readonly errorMessage?: string;
  /**
   * Host facts drawn between the controls and the steps, such as who started
   * the run, where it ran, why it paused and what it saved.
   */
  readonly children?: ReactNode;
}

/**
 * The shared pipeline run detail surface (CAN-3020).
 *
 * Props-only and host-agnostic — no store, no fetch, no `window.api`. The web
 * portal mounts it inside a full-viewport `DialogModal`, and so does a cloud
 * run's detail (`CloudPipelineRunDetail`, CAN-6326) on desktop; desktop's own
 * runs keep their modal until CAN-1965 migrates it.
 *
 * The job tree and the log pane are two INDEPENDENT scrollers at `md` and up.
 * `min-w-0` on the log column is mandatory: without it the flex item floors at
 * the widest unwrapped log line and crushes the tree — the same defect this
 * ticket fixes, relocated.
 */
export function PipelineRunDetail({
  run,
  summary,
  executionState,
  selectedStep,
  onSelectStep,
  log,
  layout = 'overlay',
  onCancel,
  onRetry,
  onRerun,
  onResume,
  cancelling = false,
  retrying = false,
  rerunning = false,
  resuming = false,
  mutationPending = false,
  errorMessage,
  children,
}: PipelineRunDetailProps): JSX.Element {
  const groups = useMemo(
    () => buildPipelineRunDetailJobs(run.jobs),
    [run.jobs],
  );
  const steps = useMemo(() => flattenPipelineRunDetailSteps(groups), [groups]);
  const checkpoints = run.pending_pauses ?? [];

  const showCancel =
    onCancel !== undefined && isPipelineExecutionActiveStatus(summary.status);
  const canResume = onResume !== undefined && canResumeExecution(summary);
  // The pause form's submit IS the resume affordance; a second bare chip
  // beside it would discard typed answers.
  const showResume = canResume && checkpoints.length === 0;
  const showRetry = onRetry !== undefined && canRetryExecution(summary);
  const showRerun =
    onRerun !== undefined &&
    canRerunExecution(summary) &&
    hasRerunReplayData(executionState);
  const showPauseForm = canResume && checkpoints.length > 0;

  const containerClassName =
    layout === 'overlay'
      ? 'flex h-full min-h-0 flex-col gap-3 px-6 pb-6'
      : 'flex min-h-0 flex-col gap-3';

  return (
    <div className={containerClassName} data-testid="pipeline-run-detail">
      <div className="flex flex-wrap items-center gap-1.5">
        {showCancel && (
          <ExecutionActionButton
            label={cancelling ? 'Cancelling…' : 'Cancel'}
            ariaLabel="Cancel run"
            variant="destructive-chip"
            disabled={mutationPending || cancelling}
            // Every action inside the overlay must let Escape reach the
            // dialog's document-level close listener.
            stopKeyDownPropagation={false}
            dataTestId="pipeline-run-detail-cancel"
            onClick={(): void => onCancel(summary.id)}
          />
        )}
        {showResume && (
          <ExecutionActionButton
            label={resuming ? 'Resuming…' : 'Resume'}
            icon={<PauseResumeIcon paused />}
            ariaLabel="Resume run"
            variant="warning"
            disabled={mutationPending || resuming}
            stopKeyDownPropagation={false}
            dataTestId="pipeline-run-detail-resume"
            onClick={(): void => onResume(summary.id)}
          />
        )}
        {showRetry && (
          <ExecutionActionButton
            label={retrying ? 'Trying again…' : 'Try again'}
            icon={<RetryIcon />}
            ariaLabel="Try the run again"
            disabled={mutationPending || retrying}
            stopKeyDownPropagation={false}
            dataTestId="pipeline-run-detail-retry"
            onClick={(): void => onRetry(summary.id)}
          />
        )}
        {showRerun && (
          <ExecutionActionButton
            label={rerunning ? 'Starting…' : 'Start over'}
            icon={<RerunIcon />}
            ariaLabel="Start this run over"
            disabled={mutationPending || rerunning}
            stopKeyDownPropagation={false}
            dataTestId="pipeline-run-detail-rerun"
            onClick={(): void => onRerun(summary.id)}
          />
        )}
      </div>

      {executionState && (
        <PipelineRunDagProgressBar executionState={executionState} />
      )}

      {errorMessage !== undefined && (
        <Notice
          intent="destructive"
          role="status"
          data-testid="pipeline-run-detail-error"
        >
          {errorMessage}
        </Notice>
      )}

      {children}

      {showPauseForm && (
        <PipelineRunPauseForm
          checkpoints={checkpoints}
          submitting={mutationPending || resuming}
          onSubmit={(responses): void => onResume(summary.id, responses)}
        />
      )}

      {steps.length === 0 ? (
        <p
          className="text-xs fg-secondary"
          data-testid="pipeline-run-detail-empty"
        >
          This run has no steps yet.
        </p>
      ) : (
        // `md:` (768px), not `sm:`. At `sm` the log pane is ~420px after a
        // 12rem rail — still too narrow for wrapped shell output, which is
        // the complaint. On a phone this is a true single column: the tree on
        // top, capped with its own scroller, and the log taking the rest.
        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <Surface
            variant="outline"
            className="flex shrink-0 overflow-hidden md:w-72"
          >
            <div
              className="max-h-[32vh] min-w-0 flex-1 overflow-y-auto md:max-h-none"
              data-testid="pipeline-run-detail-steps"
            >
              <PipelineRunStepTree
                groups={groups}
                selected={selectedStep}
                onSelect={onSelectStep}
              />
            </div>
          </Surface>
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-1"
            // `portal-*` testids are preserved verbatim from the inline
            // detail this replaces so existing web and Electron coverage
            // keeps selecting the same surfaces.
            data-testid="portal-pipeline-step-log"
          >
            <AnsiOutput
              key={
                selectedStep === null
                  ? 'no-step'
                  : pipelineRunStepKey(
                      selectedStep.job_id,
                      selectedStep.step_id,
                    )
              }
              lines={log.lines}
              className="min-h-24 flex-1"
              placeholder={
                log.loading === true
                  ? 'Loading output…'
                  : 'This step has no output yet.'
              }
            />
            {log.truncated === true && (
              <p
                className="text-3xs fg-secondary"
                data-testid="pipeline-run-detail-log-truncated"
              >
                Showing the end of this step&apos;s output.
              </p>
            )}
            {log.error !== undefined && (
              <Notice
                intent="destructive"
                role="status"
                data-testid="pipeline-run-detail-log-error"
              >
                {log.error}
              </Notice>
            )}
            {log.loading === true && log.lines.length > 0 && (
              <p
                className="text-3xs fg-secondary"
                role="status"
                data-testid="pipeline-run-detail-log-loading"
              >
                Loading output…
              </p>
            )}
            {log.onLoadMore !== undefined && (
              <div className="flex justify-start">
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={log.loading === true}
                  data-testid="pipeline-run-detail-log-more"
                  onClick={log.onLoadMore}
                >
                  Load more output
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
