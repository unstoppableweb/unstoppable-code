import { memo, useState, type JSX } from 'react';
import {
  Stack,
  EmptyState,
  ErrorBanner,
  Heading,
  Surface,
} from '@canopy/ui-shared/components';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/execution-engine/types/pipeline';
import type { PipelineRunStepCost } from '@canopy/protocol/cost-view';
import {
  formatCostTotalIn,
  useCostCurrency,
} from '@canopy/ui-shared/components/cost';
import {
  buildAttemptViews,
  buildStepInstanceKey,
  findChildExecutionSummary,
} from '@/lib/pipelineAttemptTimeline';
import { Badge, StatusGlyph } from '@canopy/ui-shared/components';
import { pipelineStatusBadge, pipelineStatusGlyphState } from '../utils';
import { PipelineChildExecution } from './PipelineChildExecution';
import { TimingSummaryGrid } from './PipelineStepDetailParts';
import { PipelineStepRow } from './PipelineStepRow';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import type { ArchivedPipelineSource } from './pipelineDetailTypes';
import {
  canRetryAllMatrixVariants,
  canRetryFailedMatrixVariants,
  canRetryMatrixExpansion,
  canRetryMatrixJob,
  canRetryMatrixVariant,
} from '@/lib/execution-actions';
import { Button, ListRow } from '@canopy/ui-shared/components';

function isSettledJobStatus(status: string): boolean {
  return ['success', 'failure', 'cancelled', 'skipped'].includes(status);
}

interface PipelineJobViewProps {
  state: ExecutionState;
  jobId: string;
  executionId: string;
  childSummaries: ExecutionSummary[];
  expandedChildSteps: Set<string>;
  onToggleChildStep: (stepInstanceKey: string) => void;
  renderChildExecution: (executionId: string) => JSX.Element;
  /** Open the worker for a terminal-mode step. */
  onViewWorker?: (workerId: string) => void;
  /** Drill into a child pipeline as a new breadcrumb level of the detail. */
  onDrillIntoChild?: (childExecutionId: string, label: string) => void;
  /** Selected physical matrix variant, or undefined for the logical group. */
  selectedMatrixVariantId?: string;
  onSelectMatrixVariant?: (variantJobId: string | undefined) => void;
  /**
   * Read-only archived source. Step logs use the archive transport and the
   * live-only matrix retry and cancel controls are hidden.
   */
  archivedSource?: ArchivedPipelineSource;
  /** The detail's visibility gate for live step log interests. */
  logsEnabled?: boolean;
  /** Step costs for the run shown in this job view. */
  stepCosts?: readonly PipelineRunStepCost[];
}

/**
 * GitHub-Actions-style job view: a job header followed by a step accordion. Each
 * step is collapsed by default except running steps (auto-expanded), and
 * expanding a step reveals its full detail (timing/config/inputs/outputs) plus
 * the live or persisted log output.
 *
 * Memoized so streaming output ticks do not re-render the whole job view or its
 * collapsed step rows. Only expanded `PipelineStepDetail`s, which each hold and
 * subscribe to their own step log interest, re-render on a pure output tick.
 */
function PipelineJobViewComponent({
  state,
  jobId,
  executionId,
  childSummaries,
  expandedChildSteps,
  onToggleChildStep,
  renderChildExecution,
  onViewWorker,
  onDrillIntoChild,
  selectedMatrixVariantId,
  onSelectMatrixVariant,
  archivedSource,
  logsEnabled,
  stepCosts,
}: PipelineJobViewProps): JSX.Element {
  const costCurrency = useCostCurrency();
  const archived = archivedSource !== undefined;
  const retryMatrixJob = usePipelineRunsStore((store) => store.retryMatrixJob);
  const cancelMatrixVariant = usePipelineRunsStore(
    (store) => store.cancelMatrixVariant,
  );
  const [matrixBusy, setMatrixBusy] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const runMatrixAction = async (
    action: () => Promise<{ success: boolean; error?: string }>,
    fallbackError: string,
  ): Promise<void> => {
    setMatrixBusy(true);
    setMatrixError(null);
    try {
      const result = await action();
      setMatrixError(result.success ? null : (result.error ?? fallbackError));
    } catch (error) {
      setMatrixError(error instanceof Error ? error.message : fallbackError);
    } finally {
      setMatrixBusy(false);
    }
  };
  const group = state.job_groups[jobId];
  if (group?.kind === 'matrix' && !selectedMatrixVariantId) {
    const logicalJob = state.pipeline_snapshot.jobs[jobId];
    // Matrix retry and cancel mutate a live run; an archived run has none.
    const canRetryExpansion =
      !archived &&
      canRetryMatrixExpansion(
        state.status,
        group,
        logicalJob.strategy?.dynamic === true,
      );
    const canRetryAll =
      !archived && canRetryAllMatrixVariants(state.status, group);
    const canRetryFailed =
      !archived &&
      canRetryFailedMatrixVariants(state.status, group, state.jobs);
    return (
      <Stack gap="group" data-testid={`pipeline-matrix-view-${jobId}`}>
        <Surface variant="inset" gap="item" padding="default">
          <Stack gap="inline">
            <div className="flex items-center gap-2">
              <Heading level={2} variant="section">
                {logicalJob.name}
              </Heading>
              <Badge>matrix</Badge>
            </div>
            <Stack gap="tight">
              <div className="text-s fg-secondary">
                {group.variant_job_ids.length} variants
              </div>
              <div className="text-xs fg-secondary">
                Max parallel: {group.resolved_max_parallel ?? '—'} · Fail fast:{' '}
                {group.fail_fast ? 'On' : 'Off'}
              </div>
              {group.outcome === 'failure' && group.conclusion === 'success' ? (
                <p className="text-xs fg-warning">Continued after failures</p>
              ) : null}
            </Stack>
          </Stack>
          {group.expansion === 'pending' ? (
            <p className="text-s fg-secondary">Preparing variants…</p>
          ) : group.expansion === 'failure' ? (
            <div>
              <Heading level={3} variant="title" tone="destructive">
                Expansion failed
              </Heading>
              <p className="text-xs fg-secondary">{group.error}</p>
            </div>
          ) : group.variant_job_ids.length === 0 ? (
            <p className="text-s fg-secondary">
              No variants were generated for this job.
            </p>
          ) : null}
          {(canRetryExpansion ||
            canRetryAll ||
            canRetryFailed ||
            matrixError) && (
            <Stack gap="inline">
              {canRetryExpansion || canRetryAll || canRetryFailed ? (
                <div className="flex flex-wrap gap-2">
                  {canRetryExpansion || canRetryAll ? (
                    <Button
                      size="compact"
                      disabled={matrixBusy}
                      onClick={() => {
                        setMatrixBusy(true);
                        void retryMatrixJob({
                          executionId,
                          jobId,
                          mode: canRetryExpansion ? 'expansion' : 'all',
                        }).then((result) => {
                          setMatrixBusy(false);
                          setMatrixError(result.error ?? null);
                        });
                      }}
                    >
                      {matrixBusy
                        ? 'Trying again…'
                        : canRetryExpansion
                          ? 'Try expansion again'
                          : 'Try all variants again'}
                    </Button>
                  ) : null}
                  {canRetryFailed ? (
                    <Button
                      size="compact"
                      disabled={matrixBusy}
                      onClick={() => {
                        setMatrixBusy(true);
                        void retryMatrixJob({
                          executionId,
                          jobId,
                          mode: 'failed',
                        }).then((result) => {
                          setMatrixBusy(false);
                          setMatrixError(result.error ?? null);
                        });
                      }}
                    >
                      Try failed variants again
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <ErrorBanner
                errorSource="pipeline-job-component-matrix"
                className=""
                error={matrixError}
              />
            </Stack>
          )}
        </Surface>
        <Surface variant="inset" className="overflow-hidden">
          <div className="flex flex-col max-h-96 overflow-y-auto p-2 gap-1 [&>*]:shrink-0">
            {group.variant_job_ids.map((variantJobId) => {
              const definition = state.job_definitions[variantJobId];
              const result = state.jobs[variantJobId];
              return (
                <div key={variantJobId} className="flex items-center gap-2">
                  <ListRow
                    className="min-w-0 flex-1"
                    onClick={() => onSelectMatrixVariant?.(variantJobId)}
                    trailing={
                      <>
                        {JSON.stringify(definition.matrix?.values ?? {})} ·{' '}
                        {result.status}
                      </>
                    }
                  >
                    {definition.name}
                  </ListRow>
                  {archived ? null : !isSettledJobStatus(result.status) ? (
                    <Button
                      variant="ghost-destructive"
                      size="compact"
                      disabled={matrixBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void runMatrixAction(
                          () =>
                            cancelMatrixVariant({
                              executionId,
                              jobId,
                              variantJobId,
                            }),
                          'Failed to cancel matrix variant',
                        );
                      }}
                    >
                      Cancel variant
                    </Button>
                  ) : canRetryMatrixJob(state.status, group) &&
                    canRetryMatrixVariant({
                      job_id: variantJobId,
                      status: result.status,
                    }) ? (
                    <Button
                      variant="ghost"
                      size="compact"
                      disabled={matrixBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void runMatrixAction(
                          () =>
                            retryMatrixJob({
                              executionId,
                              jobId,
                              mode: 'variants',
                              variantJobIds: [variantJobId],
                            }),
                          'Failed to retry matrix variant',
                        );
                      }}
                    >
                      Try variant again
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Surface>
      </Stack>
    );
  }

  const displayJobId = selectedMatrixVariantId ?? jobId;
  const jobDef =
    state.job_definitions[displayJobId] ?? state.pipeline_snapshot.jobs[jobId];
  const jobResult = state.jobs[displayJobId];

  const jobName = jobDef?.name ?? displayJobId;
  const jobStatus = jobResult?.status ?? 'pending';
  const attemptViews = buildAttemptViews(jobResult);
  const steps = jobDef?.steps ?? [];
  const hasStartedSteps = attemptViews.some(
    (attemptView) => Object.keys(attemptView.steps).length > 0,
  );
  const showAttemptGroups =
    attemptViews.length > 1 ||
    (jobDef?.max_retries ?? 0) > 0 ||
    (jobDef?.max_iterations ?? 0) > 0;

  return (
    <Stack gap="group" data-testid={`pipeline-job-view-${displayJobId}`}>
      <Surface variant="inset" gap="item" padding="default">
        <div className="flex items-start justify-between gap-3">
          <Stack gap="tight" className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusGlyph
                state={pipelineStatusGlyphState(jobStatus)}
                size={20}
              />
              <Heading level={2} variant="section" truncate>
                {jobName}
              </Heading>
            </div>
            <div className="font-mono text-2xs fg-secondary">
              {displayJobId}
            </div>
          </Stack>
          <Badge {...pipelineStatusBadge(jobStatus)}>{jobStatus}</Badge>
        </div>

        {(jobDef?.max_retries ?? 0) > 0 || (jobDef?.max_iterations ?? 0) > 0 ? (
          <div className="flex flex-wrap gap-2 text-2xs fg-secondary">
            {(jobDef?.max_retries ?? 0) > 0 && (
              <span>
                Retries {jobResult?.retry_count ?? 0}/{jobDef?.max_retries}
              </span>
            )}
            {(jobDef?.max_iterations ?? 0) > 0 && (
              <span>
                Iteration {jobResult?.iteration_count ?? 1}/
                {jobDef?.max_iterations}
              </span>
            )}
          </div>
        ) : null}

        <Surface variant="group" size="small" className="">
          <div className="p-2.5">
            <TimingSummaryGrid
              identity={`job:${executionId}:${displayJobId}:current`}
              kind="job"
              status={jobStatus}
              startedAt={jobResult?.started_at}
              completedAt={jobResult?.completed_at}
              compact
            />
          </div>
        </Surface>
      </Surface>

      {!hasStartedSteps ? (
        <EmptyState title="No steps have started for this job yet." />
      ) : (
        <Stack gap="group">
          {attemptViews.map((attemptView, attemptViewIndex) => (
            <Stack
              key={`${displayJobId}-${attemptView.source}-${attemptView.attempt}-${attemptView.iteration ?? 1}`}
              gap="inline"
            >
              {showAttemptGroups && (
                <div className="flex items-center justify-between gap-3 text-2xs fg-secondary">
                  <div className="font-medium ">{attemptView.label}</div>
                  {(attemptView.source === 'retry' ||
                    attemptView.source === 'iteration') &&
                    (attemptView.started_at !== undefined ||
                      attemptView.completed_at !== undefined) && (
                      <TimingSummaryGrid
                        identity={`attempt:${executionId}:${displayJobId}:${attemptView.source}:${attemptView.attempt}:${attemptView.iteration ?? 1}`}
                        kind="job"
                        status={attemptView.status}
                        startedAt={attemptView.started_at}
                        completedAt={attemptView.completed_at}
                        source={attemptView.source}
                        compact
                      />
                    )}
                </div>
              )}
              {steps.map((stepDef) => {
                const stepResult = attemptView.steps[stepDef.id];
                const stepCost = stepCosts?.find(
                  (candidate) =>
                    candidate.executionId === executionId &&
                    candidate.jobId === displayJobId &&
                    candidate.stepId === stepDef.id,
                );
                // A retried step's combined cost sits on its latest attempt.
                const stepIsRenderedInALaterAttempt = attemptViews
                  .slice(attemptViewIndex + 1)
                  .some(
                    (laterAttempt) =>
                      laterAttempt.steps[stepDef.id] !== undefined,
                  );
                const iteration = attemptView.iteration ?? 1;
                const stepInstanceKey = buildStepInstanceKey(
                  displayJobId,
                  attemptView.source,
                  attemptView.attempt,
                  stepDef.id,
                  attemptView.iteration,
                );
                const child =
                  stepDef.uses === 'builtin/run-pipeline'
                    ? findChildExecutionSummary(
                        childSummaries,
                        stepDef.id,
                        attemptView.attempt,
                        attemptView.iteration,
                        stepResult?.child_execution_id,
                      )
                    : undefined;
                return (
                  <div key={stepInstanceKey} className="flex flex-col gap-1">
                    <PipelineStepRow
                      stepDef={stepDef}
                      stepResult={stepResult}
                      executionId={executionId}
                      jobId={displayJobId}
                      attempt={attemptView.attempt}
                      iteration={iteration}
                      source={attemptView.source}
                      onViewWorker={onViewWorker}
                      archivedSource={archivedSource}
                      logsEnabled={logsEnabled}
                      costAmount={
                        stepCost !== undefined && !stepIsRenderedInALaterAttempt
                          ? formatCostTotalIn(stepCost.totals, costCurrency)
                          : undefined
                      }
                    />
                    {child !== undefined && (
                      <PipelineChildExecution
                        child={child}
                        stepId={stepDef.id}
                        expanded={expandedChildSteps.has(stepInstanceKey)}
                        onToggle={(): void =>
                          onToggleChildStep(stepInstanceKey)
                        }
                        renderChildExecution={renderChildExecution}
                        onDrillIntoChild={onDrillIntoChild}
                      />
                    )}
                  </div>
                );
              })}
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export const PipelineJobView = memo(PipelineJobViewComponent);
