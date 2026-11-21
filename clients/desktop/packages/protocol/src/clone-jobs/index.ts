/**
 * Add project clone jobs (`clone-jobs:*`). Desktop main owns each job in
 * memory; renderers and controllers only project it. `CloneJobSnapshot` is
 * the host wire shape; {@link PortableCloneJob} is what a `CanopyClient`
 * hands the shared UI (CAN-7433): the fields a pending sidebar row reads, with
 * no remote URL and no host path.
 */

/** Stage of a tracked clone, as reported by `git clone --progress`. */
export type CloneJobPhase =
  | 'starting'
  | 'counting'
  | 'compressing'
  | 'receiving'
  | 'resolving'
  | 'checkout'
  | 'finishing';

export const CLONE_JOB_STATUSES = [
  'running',
  'cancelling',
  'succeeded',
  'failed',
] as const;

export type CloneJobStatus = (typeof CLONE_JOB_STATUSES)[number];

export function isCloneJobStatus(value: unknown): value is CloneJobStatus {
  return CLONE_JOB_STATUSES.some((status) => status === value);
}

/**
 * Live state of one Add project clone. Main owns the job; the renderer only
 * projects it. Jobs are in-memory and do not survive an app restart.
 */
export interface CloneJobSnapshot {
  id: string;
  repoName: string;
  /** Remote URL with any embedded credentials removed. */
  remoteUrl: string;
  destinationPath: string | null;
  status: CloneJobStatus;
  phase: CloneJobPhase;
  /** Percent through the current phase when git reports one. */
  phasePercent: number | null;
  /** Estimated, monotonic percent through the whole clone (0-100). */
  percent: number;
  /** Objects or files processed in the current phase, when reported. */
  processedCount: number | null;
  totalCount: number | null;
  /** Human-readable amount received so far, e.g. `12.34 MiB`. */
  received: string | null;
  /** Human-readable transfer rate, e.g. `3.21 MiB/s`. */
  throughput: string | null;
  /** Epoch milliseconds. */
  startedAt: number;
  /** True once the Add project dialog handed the clone to the sidebar. */
  background: boolean;
  /** False once the checkout is complete and the project is being added. */
  cancellable: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
  error: string | null;
}

/**
 * One clone job as the shared UI reads it (`cloneJobs.list`,
 * `cloneJobs.changed`). Carries no `remoteUrl` and no `destinationPath`.
 */
export interface PortableCloneJob {
  readonly id: string;
  readonly repoName: string;
  readonly workspaceName: string | null;
  readonly status: CloneJobStatus;
  readonly error: string | null;
  readonly background: boolean;
  readonly cancellable: boolean;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Projects one host clone job to {@link PortableCloneJob}, or `null` when it
 * is malformed or has a status this build does not know (a newer host).
 */
export function toPortableCloneJob(value: unknown): PortableCloneJob | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const job: Record<string, unknown> = { ...value };
  const { id, repoName, workspaceName, status, error, background } = job;
  const { cancellable } = job;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof repoName !== 'string' ||
    !isNullableString(workspaceName) ||
    !isCloneJobStatus(status) ||
    !isNullableString(error) ||
    typeof background !== 'boolean' ||
    typeof cancellable !== 'boolean'
  ) {
    return null;
  }
  return {
    id,
    repoName,
    workspaceName,
    status,
    error,
    background,
    cancellable,
  };
}

/**
 * Projects a host clone job list. Returns `null` when the reply is not an
 * array; skips each job {@link toPortableCloneJob} rejects, so one job from a
 * newer host does not blank the whole list.
 */
export function toPortableCloneJobs(value: unknown): PortableCloneJob[] | null {
  if (!Array.isArray(value)) return null;
  const jobs: PortableCloneJob[] = [];
  for (const entry of value) {
    const job = toPortableCloneJob(entry);
    if (job) jobs.push(job);
  }
  return jobs;
}

/**
 * Clones handed off by the Add project dialog, including finished jobs until
 * the host removes them: a succeeded job is dismissed automatically once its
 * outcome is announced, a failed one when the user dismisses it.
 */
export function backgroundCloneJobs<J extends { readonly background: boolean }>(
  jobs: readonly J[],
): J[] {
  return jobs.filter((job) => job.background);
}
