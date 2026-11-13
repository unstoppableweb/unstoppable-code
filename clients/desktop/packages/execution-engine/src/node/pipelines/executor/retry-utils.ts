import type {
  IterationSnapshot,
  JobResult,
  RetryAttempt,
  StepResult,
} from './types';

export function isStepTerminal(step: StepResult | undefined): boolean {
  return Boolean(
    step &&
    ['success', 'failure', 'cancelled', 'skipped'].includes(step.status),
  );
}

export function createPendingStep(): StepResult {
  return {
    status: 'pending',
    outputs: {},
    dynamic_env: {},
  };
}

function cloneStepResults(
  steps: Record<string, StepResult>,
): Record<string, StepResult> {
  return structuredClone(steps);
}

function cloneIterationSnapshots(
  snapshots: IterationSnapshot[],
): IterationSnapshot[] {
  return structuredClone(snapshots);
}

export function snapshotRetryAttempt(
  job: JobResult,
  attempt: number,
  attemptStartedAt?: string,
): RetryAttempt {
  return {
    attempt,
    status: job.status,
    conclusion: job.conclusion,
    outcome: job.outcome,
    steps: cloneStepResults(job.steps),
    started_at: attemptStartedAt ?? job.started_at,
    completed_at: job.completed_at,
    iteration_history: job.iteration_history
      ? cloneIterationSnapshots(job.iteration_history)
      : undefined,
  };
}

export function snapshotIterationAttempt(
  job: JobResult,
  iteration: number,
  iterationStartedAt?: string,
  iterationCompletedAt?: string,
): IterationSnapshot {
  return {
    iteration,
    status: job.status,
    conclusion: job.conclusion,
    outcome: job.outcome,
    steps: cloneStepResults(job.steps),
    started_at: iterationStartedAt ?? job.started_at,
    completed_at: iterationCompletedAt ?? job.completed_at,
  };
}
