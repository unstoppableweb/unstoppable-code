import type { DagJobMeta, DagJobStatus } from '@canopy/ui-shared/components';

export interface DagProgressExecutionState {
  readonly pipeline_snapshot: {
    readonly jobs: Readonly<
      Record<
        string,
        {
          readonly name?: string;
          readonly needs: readonly string[];
          readonly steps: readonly { readonly id: string }[];
        }
      >
    >;
  };
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly status: string;
        readonly started_at?: string;
        readonly completed_at?: string;
        readonly steps: Readonly<Record<string, { readonly status: string }>>;
      }
    >
  >;
  readonly job_groups: Readonly<
    Record<
      string,
      {
        readonly kind: 'single' | 'matrix';
        readonly status: string;
        readonly variant_job_ids: readonly string[];
        readonly started_at?: string;
        readonly completed_at?: string;
        readonly resolved_max_parallel?: number;
      }
    >
  >;
}

export function buildDagJobs(
  executionState: DagProgressExecutionState,
): Record<string, DagJobMeta> {
  const out: Record<string, DagJobMeta> = {};
  for (const [jobId, jobDef] of Object.entries(
    executionState.pipeline_snapshot.jobs,
  )) {
    const group = executionState.job_groups[jobId];
    const physicalJobId = group?.variant_job_ids[0] ?? jobId;
    const result = executionState.jobs[physicalJobId];
    const executionStatus = group?.status ?? result?.status;
    // The portable DAG surface has no separate queued state; queued work is
    // pending from the presentation layer's perspective.
    const status = toDagJobStatus(executionStatus);
    const variants = (group?.variant_job_ids ?? []).map(
      (id) => executionState.jobs[id],
    );
    const completedVariants = variants.filter((variant) =>
      ['success', 'failure', 'cancelled', 'skipped'].includes(variant.status),
    ).length;
    const breakdown = variants.length
      ? ['success', 'failure', 'running', 'paused']
          .map((variantStatus) => ({
            status: variantStatus,
            count: variants.filter(
              (variant) => variant.status === variantStatus,
            ).length,
          }))
          .filter(({ count }) => count > 0)
          .map(
            ({ status: variantStatus, count }) =>
              `${String(count)} ${variantStatus}`,
          )
          .join(' · ')
      : '';
    out[jobId] = {
      jobId,
      name: jobDef.name ?? jobId,
      status,
      startedAt: group?.started_at ?? result?.started_at,
      // Matrix group completion is authoritative. While a group is active its
      // completed_at is intentionally absent, even if the first variant ended.
      completedAt: group ? group.completed_at : result?.completed_at,
      stepProgress:
        group?.kind === 'matrix'
          ? undefined
          : getStepProgress(result, jobDef ?? { steps: [] }),
      // One dot per authored logical job; physical variants stay grouped.
      ...(group?.kind === 'matrix'
        ? {
            variantProgress: `${String(completedVariants)} / ${String(variants.length)} complete`,
            ...(breakdown !== '' ? { variantBreakdown: breakdown } : {}),
            ...(group.resolved_max_parallel !== undefined
              ? { maxParallel: group.resolved_max_parallel }
              : {}),
          }
        : {}),
    };
  }
  return out;
}

function getStepProgress(
  jobResult: DagProgressExecutionState['jobs'][string] | undefined,
  jobDef: { readonly steps: readonly { readonly id: string }[] },
): string | undefined {
  if (!jobResult) return undefined;
  // Logical matrix groups have no steps of their own; variant progress is
  // reported separately.
  const total = jobDef.steps.length;
  if (total === 0) return undefined;
  let completed = 0;
  for (const step of jobDef.steps) {
    const stepResult = jobResult.steps[step.id];
    if (
      stepResult?.status === 'success' ||
      stepResult?.status === 'failure' ||
      stepResult?.status === 'cancelled' ||
      stepResult?.status === 'skipped'
    ) {
      completed++;
    }
  }
  return `${completed}/${total}`;
}

function toDagJobStatus(status: string | undefined): DagJobStatus | undefined {
  switch (status) {
    case 'queued':
    case 'waiting_for_capacity':
      return 'pending';
    case 'pending':
    case 'running':
    case 'restarting':
    case 'success':
    case 'failure':
    case 'paused':
    case 'cancelled':
    case 'skipped':
      return status;
    default:
      return undefined;
  }
}
