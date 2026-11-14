import { memo, useEffect, useRef, useState, type JSX } from 'react';
import type {
  NormalizedStep,
  StepResult,
} from '@canopy/execution-engine/types/pipeline';
import { MATRIX_JOB_ID_PREFIX } from '@canopy/execution-engine/pipelines/matrix';
import { isStepDefaultExpanded } from '@/lib/pipelineDetailsView';
import type { SelectedStepSource } from '@/lib/pipelineAttemptTimeline';
import { pipelineStatusBadge, pipelineStatusGlyphState } from '../utils';
import { Badge, StatusGlyph, Surface } from '@canopy/ui-shared/components';
import { PipelineTimer } from '../PipelineTimer';
import { ChevronIcon } from '@canopy/ui-shared/icons';
import { PipelineStepDetail } from './PipelineStepDetail';
import type { ArchivedPipelineSource } from './pipelineDetailTypes';
import {
  stepSessionKey,
  useRetainedSessionValue,
  useSessionWriter,
} from './pipelineDetailSession';

interface PipelineStepRowProps {
  stepDef: NormalizedStep;
  stepResult: StepResult | undefined;
  executionId: string;
  jobId: string;
  attempt: number;
  iteration: number;
  source: SelectedStepSource;
  onViewWorker?: (workerId: string) => void;
  /** Read-only archived source; the expanded detail reads its archive log. */
  archivedSource?: ArchivedPipelineSource;
  /** The detail's visibility gate for live log interests. */
  logsEnabled?: boolean;
  /** Aggregate cost for this agent step, including all retry attempts. */
  costAmount?: string;
}

function hasTimingData(
  startedAt: string | undefined,
  completedAt: string | undefined,
): boolean {
  return startedAt !== undefined || completedAt !== undefined;
}

/**
 * One row in the GitHub-Actions-style job-view step accordion. Collapsed by
 * default unless the step is running (`isStepDefaultExpanded`); a user click
 * toggles and overrides the default. When expanded, the row renders its own
 * `PipelineStepDetail` so collapsed rows allocate no detail element and the
 * memoized row only re-renders when its own stable data props change. The
 * expanded detail subscribes to the streaming output buffer itself, so buffer
 * ticks do not re-render this row.
 */
function PipelineStepRowComponent({
  stepDef,
  stepResult,
  executionId,
  jobId,
  attempt,
  iteration,
  source,
  onViewWorker,
  archivedSource,
  logsEnabled,
  costAmount,
}: PipelineStepRowProps): JSX.Element {
  const sessionKey = stepSessionKey({
    executionId,
    jobId,
    stepId: stepDef.id,
    source,
    attempt,
    iteration,
  });
  // A panel keeps the user's own expand/collapse choice across remounts;
  // without one, running steps expand by default.
  const retainedExpanded = useRetainedSessionValue(
    (session) => session.stepExpanded[sessionKey],
  );
  const writeSession = useSessionWriter();
  const [expanded, setExpanded] = useState<boolean>(
    retainedExpanded ?? isStepDefaultExpanded(stepResult),
  );
  const userToggledRef = useRef(retainedExpanded !== undefined);
  const status = stepResult?.status ?? 'pending';
  const isRunning = status === 'running';

  useEffect(() => {
    if (!userToggledRef.current && status === 'running') {
      setExpanded(true);
    }
  }, [status]);

  return (
    <Surface
      variant="group"
      className="overflow-hidden"
      data-testid={
        jobId.startsWith(MATRIX_JOB_ID_PREFIX)
          ? `pipeline-step-${jobId}-${stepDef.id}`
          : `pipeline-step-${stepDef.id}`
      }
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={(): void => {
          userToggledRef.current = true;
          const next = !expanded;
          setExpanded(next);
          writeSession((previous) => ({
            ...previous,
            stepExpanded: { ...previous.stepExpanded, [sessionKey]: next },
          }));
        }}
        className="focus-ring flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-fg-primary/[0.04]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronIcon open={expanded} />
          <StatusGlyph state={pipelineStatusGlyphState(status)} />
          <div className="min-w-0">
            <div className="truncate text-s fg-primary/80">
              {stepDef.name ?? stepDef.id}
            </div>
            <div className="truncate font-mono text-2xs fg-secondary">
              {stepDef.id}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isRunning && <Badge tone="info">Live</Badge>}
          {hasTimingData(stepResult?.started_at, stepResult?.completed_at) && (
            <span className="text-2xs fg-secondary">
              <PipelineTimer
                identity={`step-row:${executionId}:${jobId}:${stepDef.id}:${attempt}:${iteration}`}
                kind="step"
                status={status}
                startedAt={stepResult?.started_at}
                completedAt={stepResult?.completed_at}
              />
            </span>
          )}
          {costAmount !== undefined ? (
            <span
              className="text-2xs tabular-nums fg-secondary"
              data-testid={`pipeline-step-cost-${stepDef.id}`}
            >
              {costAmount}
            </span>
          ) : null}
          <Badge {...pipelineStatusBadge(status)}>{status}</Badge>
        </div>
      </button>
      {expanded && (
        <Surface variant="pane" boundary="top">
          <PipelineStepDetail
            executionId={executionId}
            jobId={jobId}
            stepDef={stepDef}
            stepResult={stepResult}
            attempt={attempt}
            iteration={iteration}
            source={source}
            onViewWorker={onViewWorker}
            archivedSource={archivedSource}
            logsEnabled={logsEnabled}
          />
        </Surface>
      )}
    </Surface>
  );
}

export const PipelineStepRow = memo(PipelineStepRowComponent);
