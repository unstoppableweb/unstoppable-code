'use client';

import { useMemo, useState, type JSX } from 'react';
import type {
  RemoteControlPipelineRunJob,
  RemoteControlPipelineRunProjection,
} from '@canopy/protocol/remote-control/shell';
import {
  DagProgressBar,
  Disclosure,
  Badge,
  type DagJobMeta,
  type DagJobStatus,
  type BadgeTone,
} from '@canopy/ui-shared/components';
import { computeDagTiers } from '@canopy/ui-shared/lib/dag-tiers';
import { Surface } from '@canopy/ui-shared/components';

interface RichPipelineRun extends RemoteControlPipelineRunProjection {
  readonly progress?: { completedSteps: number; totalSteps: number };
  readonly jobs?: RemoteControlPipelineRunJob[];
}

export function isActivePipelineStatus(status: string): boolean {
  return status === 'running' || status === 'queued' || status === 'pending';
}

export function toDagJobStatus(
  status: string | undefined,
): DagJobStatus | undefined {
  switch (status) {
    case 'pending':
    case 'running':
    case 'restarting':
    case 'success':
    case 'failure':
    case 'paused':
    case 'cancelled':
    case 'skipped':
      return status;
    case 'queued':
      return 'pending';
    case 'completed':
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'timed_out':
      return 'failure';
    default:
      return undefined;
  }
}

function statusTone(status: string): BadgeTone {
  if (status === 'running') return 'info';
  if (status === 'queued' || status === 'pending') return 'warning';
  if (status === 'paused') return 'neutral';
  if (status === 'completed' || status === 'success' || status === 'succeeded')
    return 'success';
  if (status === 'failed' || status === 'failure') return 'danger';
  return 'neutral';
}

function isStepComplete(status: string): boolean {
  return [
    'success',
    'failure',
    'cancelled',
    'skipped',
    'completed',
    'succeeded',
    'failed',
    'timed_out',
  ].includes(status);
}

/**
 * Lay the run's jobs out in dependency tiers so the preview shows the same
 * concurrency grouping the desktop does — parallel jobs share a dot group,
 * dependent jobs start a new one (CAN-2511).
 *
 * Falls back to a single tier when the desktop projected no `needs` at all
 * (older host): with no dependency data, claiming everything runs in parallel
 * would be a guess, and one group is what this rendered before.
 */
function buildTiers(
  jobsList: readonly RemoteControlPipelineRunJob[],
): string[][] {
  const known = new Set(jobsList.map((job) => job.jobId));
  if (!jobsList.some((job) => job.needs !== undefined)) {
    return [jobsList.map((job) => job.jobId)];
  }
  const graph: Record<string, { needs: string[] }> = {};
  for (const job of jobsList) {
    graph[job.jobId] = {
      // Drop dependencies on jobs absent from this run (e.g. a job that never
      // expanded); `computeDagTiers` would otherwise treat the missing id as a
      // depth-0 node and inflate every dependent's tier.
      needs: (job.needs ?? []).filter(
        (id) => known.has(id) && id !== job.jobId,
      ),
    };
  }
  return computeDagTiers(graph).filter((tier) => tier.length > 0);
}

export function buildDagInputs(
  jobsList: readonly RemoteControlPipelineRunJob[] | undefined,
): {
  tiers: string[][];
  jobs: Record<string, DagJobMeta>;
} {
  if (!jobsList || jobsList.length === 0) return { tiers: [], jobs: {} };
  const tiers = buildTiers(jobsList);
  const jobs: Record<string, DagJobMeta> = {};
  for (const job of jobsList) {
    const completed = job.steps.filter((step) =>
      isStepComplete(step.status),
    ).length;
    jobs[job.jobId] = {
      jobId: job.jobId,
      name: job.name,
      status: toDagJobStatus(job.status),
      stepProgress:
        job.steps.length > 0 ? `${completed}/${job.steps.length}` : undefined,
    };
  }
  return { tiers, jobs };
}

function PipelineRunRow({
  run,
}: {
  readonly run: RichPipelineRun;
}): JSX.Element {
  const active = isActivePipelineStatus(run.status);
  const { tiers, jobs } = useMemo(() => buildDagInputs(run.jobs), [run.jobs]);
  const progress = run.progress;
  return (
    <Surface
      variant="group"
      interactive={!active}
      className={active ? undefined : 'group/pipeline-run relative'}
      data-testid={`pipeline-run-row-${run.localId ?? run.pipelineLocalId ?? run.pipelineName}`}
    >
      <div className={active ? 'p-3' : 'px-3 py-2.5'}>
        <div className="flex items-center gap-2">
          <Badge tone={statusTone(run.status)} muted={!active}>
            {run.status || 'unknown'}
          </Badge>
        </div>
        <div
          className={`pt-1 truncate text-xs ${active ? 'font-medium fg-primary/80' : 'fg-secondary'}`}
        >
          {run.pipelineName ?? run.pipelineLocalId}
        </div>
        {active && progress && progress.totalSteps > 0 && (
          <div
            className="pt-1 text-2xs fg-secondary"
            data-testid={`pipeline-run-progress-${run.localId ?? run.pipelineLocalId}`}
          >
            {progress.completedSteps}/{progress.totalSteps} steps complete
          </div>
        )}
        {tiers.length > 0 && (
          <DagProgressBar tiers={tiers} jobs={jobs} muted={!active} />
        )}
      </div>
    </Surface>
  );
}

/**
 * Display-only pipeline runs, for hosts whose `pipelines` capability is not
 * `execute`.
 *
 * This deliberately renders NO run controls. It previously drew permanently
 * disabled Retry / Start over chips with no-op handlers, which promised an
 * action that could never happen (CAN-2865). A host that can drive runs
 * supplies the shared `PipelineRunsSectionBody` rows through the panel's
 * `sectionOverrides` seam instead.
 */
export interface PipelineRunsSectionProps {
  readonly runs: readonly RemoteControlPipelineRunProjection[];
}

export function PipelineRunsSection({
  runs,
}: PipelineRunsSectionProps): JSX.Element {
  const [completedExpanded, setCompletedExpanded] = useState(false);
  if (runs.length === 0)
    return (
      <p
        className="text-xs fg-secondary"
        data-testid="activity-pipeline-runs-empty"
      >
        No workflow runs.
      </p>
    );
  const sorted = [...runs].sort((a, b) =>
    (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
  );
  const active = sorted.filter((run) => isActivePipelineStatus(run.status));
  const completed = sorted.filter((run) => !isActivePipelineStatus(run.status));
  return (
    <div
      className="grid grid-cols-1 content-start max-h-76 overflow-y-auto gap-2"
      data-testid="activity-pipeline-runs"
    >
      {active.map((run) => (
        <PipelineRunRow
          key={run.localId ?? `${run.pipelineName}-${run.startedAt ?? ''}`}
          run={run}
        />
      ))}
      {completed.length > 0 && (
        <Disclosure
          label={`Completed (${completed.length})`}
          open={completedExpanded}
          onOpenChange={setCompletedExpanded}
          dataTestId="activity-pipeline-runs-completed"
        >
          {completed.map((run) => (
            <PipelineRunRow
              key={run.localId ?? `${run.pipelineName}-${run.startedAt ?? ''}`}
              run={run}
            />
          ))}
        </Disclosure>
      )}
    </div>
  );
}
