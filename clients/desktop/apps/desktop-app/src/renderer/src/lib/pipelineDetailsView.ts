import type {
  ExecutionState,
  JobResult,
  PipelineAdvisorHealthStatus,
  PipelineAdvisorSnapshot,
  StepResult,
} from '@canopy/execution-engine/types/pipeline';

/**
 * A job status as the details view shows it. A job held for memory
 * (`waiting_for_capacity`, CAN-6325) shows as queued until the view renders
 * the hold on its own.
 */
export type JobStatus = Exclude<JobResult['status'], 'waiting_for_capacity'>;

export function presentedJobStatus(
  status: JobResult['status'] | undefined,
): JobStatus | undefined {
  return status === 'waiting_for_capacity' ? 'queued' : status;
}

/**
 * Canonical display order for job statuses in the pipeline details view.
 * Active/in-progress states appear first, then terminal states.
 */
export const JOB_STATUS_ORDER = [
  'queued',
  'pending',
  'running',
  'restarting',
  'paused',
  'success',
  'failure',
  'cancelled',
  'skipped',
] as const satisfies readonly JobStatus[];

// Compile-time guard: errors if any JobStatus is missing from JOB_STATUS_ORDER.
type AllJobStatusesCovered = [JobStatus] extends [
  (typeof JOB_STATUS_ORDER)[number],
]
  ? true
  : never;
const _allJobStatusesCovered: AllJobStatusesCovered = true;
void _allJobStatusesCovered;

export interface JobStatusCount {
  status: JobStatus;
  count: number;
}

/**
 * Returns the set of job statuses present in the execution, with counts,
 * ordered by JOB_STATUS_ORDER. Statuses with zero jobs are omitted.
 *
 * Matrix variants are physical jobs, so their statuses are counted directly.
 */
export function getPresentJobStatuses(state: ExecutionState): JobStatusCount[] {
  const counts = new Map<JobStatus, number>();
  for (const job of Object.values(state.jobs)) {
    const status = presentedJobStatus(job.status) ?? 'pending';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  for (const group of Object.values(state.job_groups ?? {})) {
    if (group.expansion === 'failure') {
      counts.set('failure', (counts.get('failure') ?? 0) + 1);
    }
  }
  const result: JobStatusCount[] = [];
  for (const status of JOB_STATUS_ORDER) {
    const count = counts.get(status);
    if (count !== undefined) {
      result.push({ status, count });
    }
  }
  return result;
}

/**
 * Health statuses that warrant surfacing the advisor panel prominently. The
 * advisor is promoted (expanded) only when something needs attention, so
 * 'healthy', 'complete', and 'unknown' are intentionally excluded.
 */
const PROMOTE_ADVISOR_HEALTH: ReadonlySet<PipelineAdvisorHealthStatus> =
  new Set(['watch', 'degraded', 'blocked'] as const);

/**
 * Returns true when the pipeline advisor snapshot has a latest report whose
 * health status indicates the run needs attention ('watch', 'degraded', or
 * 'blocked'). Returns false when the snapshot or its report is absent, or when
 * health is 'healthy', 'complete', or 'unknown'.
 *
 * Used to decide whether to surface the advisor panel prominently.
 */
export function shouldPromoteAdvisor(
  snapshot: PipelineAdvisorSnapshot | undefined,
): boolean {
  const health = snapshot?.latestReport?.health?.status;
  if (health === undefined) {
    return false;
  }
  return PROMOTE_ADVISOR_HEALTH.has(health);
}

function stringifyEventInputValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Builds the flattened key/value map of event inputs surfaced in the pipeline
 * details view. Combines `state.inputs` with durable plan/task paths exposed by
 * `plan_ready` / `task_ready` event data.
 */
export function buildEventInputs(
  state: ExecutionState,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(state.inputs)) {
    result[key] = stringifyEventInputValue(value);
  }

  if (state.event_data?.plan_ready) {
    result['plan_path'] = state.event_data.plan_ready.plan_path;
  }

  if (state.event_data?.task_ready) {
    result['task_path'] = state.event_data.task_ready.task_path;
    result['plan_path'] = state.event_data.task_ready.plan_path;
  }

  return result;
}

/**
 * Returns true when the given step result should be expanded by default in
 * the pipeline details view. Only running steps are auto-expanded.
 */
export function isStepDefaultExpanded(
  stepResult: StepResult | undefined,
): boolean {
  return stepResult?.status === 'running';
}
