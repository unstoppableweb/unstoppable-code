'use client';

import {
  statusBadgeClassName,
  type StatusBadgeTone,
} from '@canopy/ui-shared/lib';

/**
 * View model for the shared pipeline run detail surface (CAN-3020).
 *
 * Deliberately snake_case, matching `PipelineRunRows.tsx`'s existing
 * `PipelineRunSummary` / `PipelineRunExecutionState` vocabulary, so a desktop
 * host can feed `ExecutionState`-shaped data at CAN-1965 without an adapter
 * rewrite. The web portal adapts its camelCase wire entities into these in
 * `pipeline-projection.ts`.
 */

export interface PipelineRunDetailStep {
  readonly step_id: string;
  readonly name: string;
  readonly status: string;
  /**
   * Bounded step output as the host has it. The portal carries a ~2 KB tail
   * per step; desktop reads the whole file.
   */
  readonly output_tail?: string;
}

/** One physical matrix variant of a logical job. */
export interface PipelineRunDetailVariant {
  readonly job_id: string;
  readonly name: string;
  readonly status: string;
  readonly steps: readonly PipelineRunDetailStep[];
}

export interface PipelineRunDetailJob {
  readonly job_id: string;
  readonly name: string;
  readonly status: string;
  readonly steps: readonly PipelineRunDetailStep[];
  readonly variants?: readonly PipelineRunDetailVariant[];
}

export interface PipelineRunDetailPauseField {
  readonly key: string;
  readonly label: string;
  readonly type: 'string' | 'number' | 'boolean' | 'choice';
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: string | number | boolean;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly multiline?: boolean;
}

export interface PipelineRunDetailPauseCheckpoint {
  readonly id: string;
  readonly kind: 'input' | 'action';
  readonly job_id: string;
  readonly logical_job_id: string;
  readonly step_id: string;
  /** Why this checkpoint cannot be answered from the current host. */
  readonly request_unavailable_reason?: 'too_large';
  readonly request?: {
    readonly title?: string;
    readonly message?: string;
    readonly fields: readonly PipelineRunDetailPauseField[];
  };
}

export interface PipelineRunDetailView {
  readonly id: string;
  readonly pipeline_name: string;
  readonly jobs: readonly PipelineRunDetailJob[];
  readonly pending_pauses?: readonly PipelineRunDetailPauseCheckpoint[];
}

/**
 * One selectable step, carrying the PHYSICAL job id the host needs to request
 * its log (a matrix variant's own id, not its logical parent's).
 */
export interface PipelineRunDetailStepEntry {
  readonly job_id: string;
  readonly step: PipelineRunDetailStep;
}

export interface PipelineRunDetailVariantGroup {
  readonly job_id: string;
  readonly name: string;
  readonly status: string;
  readonly steps: readonly PipelineRunDetailStepEntry[];
}

export interface PipelineRunDetailJobGroup {
  readonly job_id: string;
  readonly name: string;
  readonly status: string;
  readonly steps: readonly PipelineRunDetailStepEntry[];
  readonly variants: readonly PipelineRunDetailVariantGroup[];
}

/** Stable key/testid suffix for one step within one physical job. */
export function pipelineRunStepKey(jobId: string, stepId: string): string {
  return `${jobId}:${stepId}`;
}

/**
 * Group a run's steps under their job, nesting matrix variants exactly one
 * level deep.
 *
 * One level of grouping is the honest ceiling for the data the portal
 * projection actually carries. There are no attempts, iterations, timings,
 * `with`, or `env` here because the projection has none of them — this is a
 * deliberate limit, not an oversight. The flat list this replaces made a
 * `Build` step from two different jobs indistinguishable, which is the part
 * of CAN-3020 that width alone does not fix.
 */
export function buildPipelineRunDetailJobs(
  jobs: readonly PipelineRunDetailJob[],
): readonly PipelineRunDetailJobGroup[] {
  return jobs.map((job) => ({
    job_id: job.job_id,
    name: job.name,
    status: job.status,
    steps: job.steps.map((step) => ({ job_id: job.job_id, step })),
    variants: (job.variants ?? []).map((variant) => ({
      job_id: variant.job_id,
      name: variant.name,
      status: variant.status,
      steps: variant.steps.map((step) => ({ job_id: variant.job_id, step })),
    })),
  }));
}

/** Every selectable step, in render order (job steps, then variant steps). */
export function flattenPipelineRunDetailSteps(
  groups: readonly PipelineRunDetailJobGroup[],
): readonly PipelineRunDetailStepEntry[] {
  return groups.flatMap((group) => [
    ...group.steps,
    ...group.variants.flatMap((variant) => variant.steps),
  ]);
}

/**
 * Free-form executor status → the shared status-badge vocabulary. Unknown
 * statuses read `neutral` rather than being dropped: a step whose status this
 * surface cannot classify is still a step that ran.
 */
export function pipelineRunDetailStatusTone(status: string): {
  readonly tone: StatusBadgeTone;
  readonly muted: boolean;
} {
  switch (status) {
    case 'running':
    case 'restarting':
      return { tone: 'active', muted: false };
    case 'success':
    case 'completed':
      return { tone: 'success', muted: false };
    case 'failure':
    case 'failed':
    case 'timed_out':
      return { tone: 'failed', muted: false };
    case 'paused':
      return { tone: 'paused', muted: false };
    case 'cancelled':
      return { tone: 'paused', muted: true };
    case 'skipped':
    case 'pending':
    case 'queued':
    case 'waiting_for_capacity':
      return { tone: 'neutral', muted: true };
    default:
      return { tone: 'neutral', muted: false };
  }
}

/** Full status-badge class string for a job, variant, or step status. */
export function pipelineRunDetailStatusClassName(status: string): string {
  const { tone, muted } = pipelineRunDetailStatusTone(status);
  return statusBadgeClassName(tone, { muted });
}
