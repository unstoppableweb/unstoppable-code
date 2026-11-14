import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type JSX,
} from 'react';
import { Stack, Notice, Surface } from '@canopy/ui-shared/components';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/execution-engine/types/pipeline';
import {
  useStepLogInterest,
  type PipelineDetailOwner,
} from '@/stores/pipelineDetailCoordinator';
import {
  buildAttemptViews,
  buildStepInstanceKey,
  findChildExecutionSummary,
  getCurrentAttemptNumber,
  isTerminalStepStatus,
  resolveSelectedStep,
  type SelectedStepRef,
} from '@/lib/pipelineAttemptTimeline';
import { Badge, Disclosure, StatusGlyph } from '@canopy/ui-shared/components';
import { LoadingSpinner } from '../../shared/loading/spinners/LoadingSpinner';
import { AnsiOutput } from '../AnsiOutput';
import { PipelineTimer } from '../PipelineTimer';
import { pipelineStatusBadge, pipelineStatusGlyphState } from '../utils';
import { ChevronIcon } from '@canopy/ui-shared/icons';
import { TerminalModeBanner } from './TerminalModeBanner';
import { KeyValueTable, TimingSummaryGrid } from './PipelineStepDetailParts';
import { PipelinePauseResumeContent } from './PipelinePauseResumeContent';
import { useArchivedStepLog } from './useArchivedStepLog';
import { usePipelineExecutionDetailData } from './usePipelineExecutionDetailData';
import type { ArchivedPipelineSource } from './pipelineDetailTypes';

function hasTimingData(
  startedAt: string | undefined,
  completedAt: string | undefined,
): boolean {
  return startedAt !== undefined || completedAt !== undefined;
}

/** Identity used only while an inline step has no resolved step. */
const UNRESOLVED_STEP_LOG = {
  executionId: '',
  jobId: '',
  stepId: '',
  attempt: 0,
};

function InlineStepDetail({
  executionId,
  stepRef,
  state,
  onViewWorker,
  archivedSource,
  logsEnabled,
}: {
  executionId: string;
  stepRef: SelectedStepRef;
  state: ExecutionState;
  onViewWorker?: (workerId: string) => void;
  archivedSource?: ArchivedPipelineSource;
  logsEnabled: boolean;
}): JSX.Element {
  const resolved = useMemo(
    () => resolveSelectedStep(state, stepRef),
    [state, stepRef],
  );
  const archived = archivedSource !== undefined;
  const jobId = resolved?.jobId;
  const stepId = resolved?.stepDef.id;
  const attempt = resolved?.attempt;
  const iteration = resolved?.attemptView?.iteration ?? 1;
  const recoveryCount = resolved?.stepResult?.recovery_count;
  const recovery = recoveryCount ?? 0;
  const logFilePath = resolved?.stepResult?.log_file;
  // Only a settled step is terminal. Pending, paused, and not-yet-started
  // steps are not: their direct move to a settled state must still produce
  // the terminal edge that triggers the final authoritative read.
  const isStepSettled = isTerminalStepStatus(resolved?.stepResult?.status);

  // Live runs read and follow the log through one shared interest; the
  // archived transport is a separate one-shot read.
  const liveLog = useStepLogInterest({
    identity:
      jobId !== undefined && stepId !== undefined && attempt !== undefined
        ? { executionId, jobId, stepId, attempt, iteration, recovery }
        : UNRESOLVED_STEP_LOG,
    logFilePath,
    terminal: isStepSettled,
    enabled: !archived && logsEnabled && resolved !== null,
  });
  const archivedLog = useArchivedStepLog(
    archivedSource,
    archived &&
      jobId !== undefined &&
      stepId !== undefined &&
      attempt !== undefined
      ? {
          executionId,
          jobId,
          stepId,
          attempt,
          iteration,
          recovery: recoveryCount,
          logFilePath,
        }
      : null,
  );

  if (!resolved) return <></>;

  const lines = archived ? archivedLog.lines : liveLog.lines;
  const loading = archived ? archivedLog.loading : liveLog.status === 'loading';
  const hasConfig =
    Object.keys(resolved.stepDef.with ?? {}).length > 0 ||
    Object.keys(resolved.stepDef.env ?? {}).length > 0;

  return (
    <Surface variant="group" size="small" className="overflow-hidden">
      {resolved.stepResult?.agentTerminalMode && (
        <Surface variant="section" boundary="bottom" padding="section-compact">
          <TerminalModeBanner
            agentTerminalMode={resolved.stepResult.agentTerminalMode}
            workerId={archived ? undefined : resolved.stepResult.workerId}
            workerQueued={resolved.stepResult.workerQueued}
            onViewWorker={onViewWorker}
          />
        </Surface>
      )}

      {resolved.stepResult?.error && (
        <div className="border-b bg-destructive-subtle px-3 py-2">
          <div className="mb-0.5 text-2xs font-medium fg-destructive-strong">
            Error
          </div>
          <div className="font-mono text-2xs fg-destructive-strong">
            {resolved.stepResult.error}
          </div>
        </div>
      )}

      {hasConfig && (
        <Surface
          variant="section"
          boundary="bottom"
          padding="section-compact"
          gap="tight"
        >
          <div className="text-2xs font-medium fg-secondary">Configuration</div>
          <div className="flex flex-col gap-0">
            <KeyValueTable values={resolved.stepDef.with} />
            <KeyValueTable values={resolved.stepDef.env} />
          </div>
        </Surface>
      )}

      <div className="flex flex-col px-3 py-2 gap-1">
        <div className="flex items-center gap-2 text-2xs font-medium fg-secondary">
          <span>Log output</span>
          {resolved.stepResult?.status === 'running' && (
            <LoadingSpinner tone="active" />
          )}
        </div>
        {loading ? (
          <div className="flex min-h-15 items-center justify-center text-2xs fg-secondary">
            Loading output…
          </div>
        ) : lines.length === 0 ? (
          <div className="flex min-h-15 items-center justify-center text-2xs fg-secondary">
            No output available.
          </div>
        ) : (
          <AnsiOutput lines={lines} className="max-h-62.5" />
        )}
      </div>
    </Surface>
  );
}

/**
 * Compact matrix summary for the inline nested-execution job list.
 */
function InlineMatrixJobSummary({
  state,
  jobId,
}: {
  state: ExecutionState;
  jobId: string;
}): JSX.Element {
  const group = state.job_groups[jobId];
  const variants = (group?.variant_job_ids ?? []).map((physicalJobId) => ({
    id: physicalJobId,
    definition: state.job_definitions[physicalJobId],
    result: state.jobs[physicalJobId],
  }));
  const complete = variants.filter(({ result }) =>
    ['success', 'failure', 'cancelled', 'skipped'].includes(result.status),
  ).length;

  if (variants.length === 0) {
    return (
      <div
        className="text-2xs fg-secondary"
        data-testid={`pipeline-inline-matrix-empty-${jobId}`}
      >
        No variants were generated for this job.
      </div>
    );
  }

  return (
    <Stack gap="tight" data-testid={`pipeline-inline-matrix-${jobId}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs fg-secondary">
        <span>{variants.length} variants</span>
        {group?.resolved_max_parallel !== undefined && (
          <span>Max parallel: {group.resolved_max_parallel}</span>
        )}
        <span>{complete} complete</span>
      </div>
      <ul className="flex flex-col max-h-45 overflow-y-auto gap-0.5 [&>*]:shrink-0">
        {variants.map(({ id, definition, result }) => (
          <li
            key={id}
            className="flex items-center gap-2 rounded px-1.5 py-0.5"
          >
            <StatusGlyph
              state={pipelineStatusGlyphState(result.status)}
              size={12}
            />
            <span className="min-w-0 flex-1 truncate text-2xs fg-primary/80">
              {definition.name}
            </span>
            <span className="shrink-0 font-mono text-3xs fg-secondary">
              {JSON.stringify(definition.matrix?.values ?? {})}
            </span>
          </li>
        ))}
      </ul>
    </Stack>
  );
}

/** What a nested inline child inherits from the detail that renders it. */
export interface PipelineInlineChildContext {
  owner: PipelineDetailOwner | null;
  detailEnabled: boolean;
  archivedSource?: ArchivedPipelineSource;
  onViewWorker?: (workerId: string) => void;
}

function ChildPipelineToggle({
  stepInstanceKey,
  stepUses,
  childSummaries,
  stepId,
  attempt,
  iteration,
  expandedChildSteps,
  onToggle,
  childContext,
}: {
  stepInstanceKey: string;
  stepUses: string | undefined;
  childSummaries: ExecutionSummary[];
  stepId: string;
  attempt: number;
  iteration?: number;
  expandedChildSteps: Set<string>;
  onToggle: (stepInstanceKey: string) => void;
  childContext: PipelineInlineChildContext;
}): JSX.Element | null {
  if (stepUses !== 'builtin/run-pipeline') return null;
  const child = findChildExecutionSummary(
    childSummaries,
    stepId,
    attempt,
    iteration,
  );
  if (!child) return null;

  return (
    <Disclosure
      open={expandedChildSteps.has(stepInstanceKey)}
      onOpenChange={(): void => onToggle(stepInstanceKey)}
      label={child.pipeline_name}
      dataTestId={`pipeline-inline-child-${stepId}`}
    >
      <ChildPipelineExpansion
        childExecutionId={child.id}
        childContext={childContext}
      />
    </Disclosure>
  );
}

/**
 * One nested child run rendered inline under its parent step. The archived
 * source is threaded through, so an archived child reads its state and logs
 * through the archive transport like its parent.
 */
export function ChildPipelineExpansion({
  childExecutionId,
  childContext,
}: {
  childExecutionId: string;
  childContext: PipelineInlineChildContext;
}): JSX.Element {
  return (
    <div className="pt-1 pl-2">
      <PipelineExecutionInlineDetail
        executionId={childExecutionId}
        owner={childContext.owner}
        detailEnabled={childContext.detailEnabled}
        archivedSource={childContext.archivedSource}
        onViewWorker={childContext.onViewWorker}
      />
    </div>
  );
}

export interface PipelineExecutionInlineDetailProps {
  executionId: string;
  /** Lease owner; inline children inherit their parent detail's owner. */
  owner: PipelineDetailOwner | null;
  /** Visibility gate for the lease and log interests. Defaults to true. */
  detailEnabled?: boolean;
  archivedSource?: ArchivedPipelineSource;
  /** Opens a terminal-mode step's worker. */
  onViewWorker?: (workerId: string) => void;
}

/**
 * The inline accordion for a child run nested under its parent's step: one
 * card per job with attempts and steps, each step expanding to its log. It
 * holds its own lease (under the parent's owner) and never reports current UI
 * state; the parent detail does.
 */
export function PipelineExecutionInlineDetail({
  executionId,
  owner,
  detailEnabled = true,
  archivedSource,
  onViewWorker,
}: PipelineExecutionInlineDetailProps): JSX.Element {
  const idScope = useId();
  const { state, loadFailed, childSummaries } = usePipelineExecutionDetailData({
    rootExecutionId: executionId,
    activeExecutionId: executionId,
    owner,
    enabled: detailEnabled,
    archivedSource,
  });
  const archived = archivedSource !== undefined;
  const [selectedStep, setSelectedStep] = useState<SelectedStepRef | null>(
    null,
  );
  const [expandedChildSteps, setExpandedChildSteps] = useState<Set<string>>(
    new Set(),
  );
  const toggleChildStep = useCallback((stepInstanceKey: string): void => {
    setExpandedChildSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepInstanceKey)) {
        next.delete(stepInstanceKey);
      } else {
        next.add(stepInstanceKey);
      }
      return next;
    });
  }, []);
  const childContext = useMemo<PipelineInlineChildContext>(
    () => ({ owner, detailEnabled, archivedSource, onViewWorker }),
    [archivedSource, detailEnabled, onViewWorker, owner],
  );

  useEffect(() => {
    setSelectedStep(null);
  }, [executionId]);

  // Follow the current attempt of the expanded step as retries and
  // iterations advance.
  useEffect(() => {
    if (!state || !selectedStep || selectedStep.source !== 'current') {
      return;
    }
    const currentJob = state.jobs[selectedStep.jobId];
    const currentAttempt = getCurrentAttemptNumber(currentJob);
    const currentIteration = currentJob?.iteration_count ?? 1;
    if (
      currentAttempt === selectedStep.attempt &&
      currentIteration === (selectedStep.iteration ?? 1)
    ) {
      return;
    }
    setSelectedStep({
      ...selectedStep,
      attempt: currentAttempt,
      iteration: currentIteration,
    });
  }, [selectedStep, state]);

  return (
    <div className="flex flex-col gap-2 border-l-2 border-line-accent pl-3">
      {state?.error && (
        <Notice
          errorSource="pipeline-execution-inline-detail"
          intent="destructive"
          title="Execution error"
        >
          <span className="whitespace-pre-wrap break-words font-mono">
            {state.error}
          </span>
        </Notice>
      )}
      {!state ? (
        <div className="flex min-h-30 items-center justify-center gap-3 text-s fg-secondary">
          {loadFailed ? (
            'Failed to load execution details.'
          ) : (
            <>
              <LoadingSpinner tone="active" />
              Loading execution details…
            </>
          )}
        </div>
      ) : (
        <Stack gap="group">
          {archived ? null : (
            <PipelinePauseResumeContent
              executionId={executionId}
              state={state}
              idScope={idScope}
            />
          )}
          <Stack gap="item">
            <div className="flex min-h-0 min-w-0 flex-col">
              <Stack gap="inline" className="min-h-0 min-w-0">
                {Object.entries(state.pipeline_snapshot.jobs).map(
                  ([jobId, jobDef]) => {
                    const group = state.job_groups[jobId];
                    const jobResult =
                      state.jobs[group?.variant_job_ids[0] ?? jobId];
                    const isMatrixJob = group?.kind === 'matrix';
                    const attempts = isMatrixJob
                      ? []
                      : buildAttemptViews(jobResult);
                    return (
                      <Surface
                        key={jobId}
                        variant="group"
                        gap="item"
                        padding="compact"
                      >
                        <Stack gap="inline">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-s font-medium fg-primary/80">
                                {jobDef.name}
                              </div>
                              <div className="font-mono text-2xs fg-secondary">
                                {jobId}
                              </div>
                            </div>
                            <Badge
                              {...pipelineStatusBadge(
                                group?.status ?? jobResult?.status ?? 'pending',
                              )}
                            >
                              {group?.status ?? jobResult?.status ?? 'pending'}
                            </Badge>
                          </div>

                          <div className="flex flex-wrap gap-2 text-2xs fg-secondary">
                            {jobDef.max_retries > 0 && (
                              <span>
                                Retries {jobResult?.retry_count ?? 0}/
                                {jobDef.max_retries}
                              </span>
                            )}
                            {jobDef.max_iterations !== undefined &&
                              jobDef.max_iterations > 0 && (
                                <span>
                                  Iteration {jobResult?.iteration_count ?? 1}/
                                  {jobDef.max_iterations}
                                </span>
                              )}
                          </div>
                        </Stack>

                        <Surface variant="inset" size="small" className="">
                          <div className="p-2.5">
                            <TimingSummaryGrid
                              identity={`job:${executionId}:${jobId}:current`}
                              kind="job"
                              status={
                                group?.status ?? jobResult?.status ?? 'pending'
                              }
                              startedAt={
                                group?.started_at ?? jobResult?.started_at
                              }
                              completedAt={
                                group?.completed_at ?? jobResult?.completed_at
                              }
                              compact
                            />
                          </div>
                        </Surface>

                        {isMatrixJob ? (
                          <div>
                            <InlineMatrixJobSummary
                              state={state}
                              jobId={jobId}
                            />
                          </div>
                        ) : null}

                        <Stack gap="item">
                          {attempts.map((attemptView) => (
                            <Stack
                              gap="tight"
                              key={`${jobId}-${attemptView.source}-${attemptView.attempt}-${attemptView.iteration ?? 1}`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-2xs font-medium fg-secondary">
                                  {attemptView.label}
                                </div>
                                {(attemptView.source === 'retry' ||
                                  attemptView.source === 'iteration') &&
                                  hasTimingData(
                                    attemptView.started_at,
                                    attemptView.completed_at,
                                  ) && (
                                    <div className="inline-flex items-baseline gap-1 text-2xs fg-secondary">
                                      <span className="fg-secondary">
                                        Duration
                                      </span>
                                      <PipelineTimer
                                        identity={`attempt:${executionId}:${jobId}:${attemptView.source}:${attemptView.attempt}:${attemptView.iteration ?? 1}`}
                                        kind="job"
                                        status={attemptView.status}
                                        startedAt={attemptView.started_at}
                                        completedAt={attemptView.completed_at}
                                        source={attemptView.source}
                                      />
                                    </div>
                                  )}
                              </div>
                              <Stack gap="tight">
                                {jobDef.steps.map((step) => {
                                  const stepResult = attemptView.steps[step.id];
                                  const isSelected =
                                    selectedStep?.jobId === jobId &&
                                    selectedStep.stepId === step.id &&
                                    selectedStep.attempt ===
                                      attemptView.attempt &&
                                    selectedStep.source ===
                                      attemptView.source &&
                                    selectedStep.iteration ===
                                      attemptView.iteration;
                                  const stepRef: SelectedStepRef = {
                                    jobId,
                                    stepId: step.id,
                                    attempt: attemptView.attempt,
                                    iteration: attemptView.iteration,
                                    source: attemptView.source,
                                  };
                                  return (
                                    <div
                                      key={`${jobId}-${attemptView.source}-${attemptView.attempt}-${attemptView.iteration ?? 1}-${step.id}`}
                                      className="flex flex-col gap-1"
                                    >
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (isSelected) {
                                            setSelectedStep(null);
                                          } else {
                                            setSelectedStep(stepRef);
                                          }
                                        }}
                                        className={`focus-ring flex w-full items-start justify-between gap-3 rounded-md border px-2.5 py-2 text-left transition-colors ${
                                          isSelected
                                            ? 'border-fg-info/50 bg-info-subtle'
                                            : 'bg-fg-primary/[0.02] hover:bg-fg-primary/[0.04]'
                                        }`}
                                      >
                                        <div className="min-w-0 flex items-center gap-1.5">
                                          <ChevronIcon open={isSelected} />
                                          <Stack gap="tight">
                                            <div className="flex flex-col gap-0">
                                              <div className="truncate text-s fg-primary/80">
                                                {step.name ?? step.id}
                                              </div>
                                              <div className="truncate font-mono text-2xs fg-secondary">
                                                {step.id}
                                              </div>
                                            </div>
                                            {hasTimingData(
                                              stepResult?.started_at,
                                              stepResult?.completed_at,
                                            ) && (
                                              <div className="inline-flex items-baseline gap-1 text-2xs fg-secondary">
                                                <span className="fg-secondary">
                                                  Duration
                                                </span>
                                                <PipelineTimer
                                                  identity={`step:${executionId}:${jobId}:${step.id}:${attemptView.source}:${attemptView.attempt}:${attemptView.iteration ?? 1}`}
                                                  kind="step"
                                                  status={
                                                    stepResult?.status ??
                                                    'pending'
                                                  }
                                                  startedAt={
                                                    stepResult?.started_at
                                                  }
                                                  completedAt={
                                                    stepResult?.completed_at
                                                  }
                                                  source={attemptView.source}
                                                />
                                              </div>
                                            )}
                                          </Stack>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {stepResult?.error && (
                                            <span className="text-2xs fg-destructive-strong">
                                              Error
                                            </span>
                                          )}
                                          <Badge
                                            {...pipelineStatusBadge(
                                              stepResult?.status ?? 'pending',
                                            )}
                                          >
                                            {stepResult?.status ?? 'pending'}
                                          </Badge>
                                        </div>
                                      </button>
                                      {isSelected && (
                                        <InlineStepDetail
                                          executionId={executionId}
                                          stepRef={stepRef}
                                          state={state}
                                          onViewWorker={onViewWorker}
                                          archivedSource={archivedSource}
                                          logsEnabled={detailEnabled}
                                        />
                                      )}
                                      <ChildPipelineToggle
                                        stepInstanceKey={buildStepInstanceKey(
                                          jobId,
                                          attemptView.source,
                                          attemptView.attempt,
                                          step.id,
                                          attemptView.iteration,
                                        )}
                                        stepUses={step.uses}
                                        childSummaries={childSummaries}
                                        stepId={step.id}
                                        attempt={attemptView.attempt}
                                        iteration={attemptView.iteration}
                                        expandedChildSteps={expandedChildSteps}
                                        onToggle={toggleChildStep}
                                        childContext={childContext}
                                      />
                                    </div>
                                  );
                                })}
                              </Stack>
                            </Stack>
                          ))}
                        </Stack>
                      </Surface>
                    );
                  },
                )}
              </Stack>
            </div>
          </Stack>
        </Stack>
      )}
    </div>
  );
}
