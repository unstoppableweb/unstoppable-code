import type { PipelineUsageIdentity } from '@canopy/desktop-shared/types';
import type { NormalizedStep } from '@canopy/execution-engine/types/pipeline';
import type { PipelineRunUsageEvent } from '@canopy/execution-engine/types/observability';
import type {
  ExecutionEvent,
  ExecutionState,
  JobResult,
  StepResult,
} from '@canopy/execution-engine/node/pipelines/executor';
import {
  getExecutionRunDurationMs,
  logicalJobIdForPhysicalJob,
} from '@canopy/execution-engine/node/pipelines/executor';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { emitPipelineRunCompletion } from '../lib/pipeline-run-completion-emitter';
import { resolveAction } from './action-resolver';

// Fast path for bundled agent actions during lifecycle event aggregation.
// Source of truth is packages/desktop-shared/resources/actions/*/action.yml.
const BUNDLED_AGENT_ACTION_REFS = new Set([
  'builtin/agent-loop',
  'builtin/agent-prompt',
  'builtin/agent-resume',
  'builtin/coder',
  'builtin/complexity-assessor',
  'builtin/context-discovery',
  'builtin/discovery',
  'builtin/greenfield-detection',
  'builtin/historical-context',
  'builtin/parallel-agents',
  'builtin/plan-validation',
  'builtin/plan-with-review',
  'builtin/planner',
  'builtin/qa-fixer',
  'builtin/qa-reviewer',
  'builtin/quality-gate',
  'builtin/requirements-from-task',
  'builtin/requirements-interactive',
  'builtin/router',
  'builtin/spec-critic',
  'builtin/spec-gatherer',
  'builtin/spec-quick',
  'builtin/spec-researcher',
  'builtin/spec-validation',
  'builtin/spec-writer',
]);

function buildPipelineUsageIdentity(
  state: ExecutionState,
): PipelineUsageIdentity {
  const pipelineId = state.pipeline_id;
  const name = state.pipeline_snapshot.name;
  const locator = state.pipeline_preference_locator;

  if (locator?.type === 'stored') {
    return {
      key: `stored:${locator.source}:${locator.value}`,
      id: pipelineId,
      name,
      source: locator.source,
    };
  }
  if (locator?.type === 'file') {
    return {
      key: `file:${locator.value}`,
      id: pipelineId,
      name,
      source: 'project',
    };
  }
  if (locator?.type === 'shared') {
    return {
      key: `shared:${locator.value}`,
      id: pipelineId,
      name,
      source: 'shared',
    };
  }
  if (state.shared_pipeline_source) {
    return {
      key: `shared:${state.shared_pipeline_source.serverId}:${state.shared_pipeline_source.remoteId}`,
      id: pipelineId,
      name,
      source: 'shared',
    };
  }
  return {
    key: `inline:${pipelineId}`,
    id: pipelineId,
    name,
    source: 'inline',
  };
}

const agentPipelineStepCache = new Map<string, boolean>();

function isAgentPipelineStep(step: NormalizedStep, repoPath?: string): boolean {
  if (step.log_format_hint === 'agent') return true;
  if (!step.uses) return false;
  if (BUNDLED_AGENT_ACTION_REFS.has(step.uses)) return true;
  if (step.uses.startsWith('builtin/')) return false;

  const cacheKey = `${repoPath ?? ''}\0${step.uses}`;
  const cached = agentPipelineStepCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const isAgent =
      resolveAction(step.uses, repoPath)?.log_format_hint === 'agent';
    agentPipelineStepCache.set(cacheKey, isAgent);
    return isAgent;
  } catch {
    // Deliberately NOT memoized: a throw here is a transient resolution
    // failure (action file mid-write, transient FS error), and caching `false`
    // would permanently misclassify a real agent action for the process
    // lifetime. The cost is that a persistently-failing `resolveAction` is
    // retried per step per retry per iteration; all bundled `builtin/` refs
    // short-circuit above, so this only affects project-local actions.
    return false;
  }
}

function isExecutedStep(result: StepResult): boolean {
  // `running` is counted intentionally: on a terminal execution event it means
  // the step started but the executor never finalized it (an abrupt cancel or
  // crash), and that step still did real agent work. Do not tighten this to
  // terminal statuses only.
  return (
    result.status !== 'pending' &&
    result.status !== 'skipped' &&
    result.started_at !== undefined
  );
}

/**
 * Upper bound on a single `parallel-agents` step's reported fan-out width, far
 * above any real prompt array. It bounds one step's contribution so a single
 * malformed output cannot dominate the total; the aggregate `agentStepCount`
 * stays inside the `Int` telemetry column because `MAX_ITERATIONS_LIMIT` and
 * realistic job/step counts keep the sum far below `Int32`.
 */
const MAX_PARALLEL_AGENT_WIDTH = 10_000;

/**
 * Fan-out width of a `builtin/parallel-agents` step.
 *
 * A step that reports two valid counts is taken at its word, including a
 * genuine `0/0` (an empty `prompts` array really did run zero agents, so
 * counting 1 would overstate a no-op). The floor of 1 applies only when the
 * counts are absent or unparseable — a step still running, or one that died
 * before writing its outputs — where the step demonstrably started and one is
 * the safest lower bound.
 *
 * The result is clamped to {@link MAX_PARALLEL_AGENT_WIDTH}: `agentStepCount`
 * lands in a 32-bit `Int?` column, so a malformed-but-finite output (`'1e12'`)
 * would otherwise fail the whole telemetry upsert. Degrading one step's metric
 * beats poisoning the batch.
 */
function parallelAgentWidth(result: StepResult): number {
  const parseCount = (value: string | undefined): number | undefined => {
    // Blank counts as absent, not as a valid zero: `Number('')` is `0`, so a
    // step that started and then died with empty outputs would otherwise report
    // width 0 and vanish from the count instead of getting the floor below.
    if (value === undefined || value.trim() === '') return undefined;
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, count) : undefined;
  };
  const successCount = parseCount(result.outputs.success_count);
  const failureCount = parseCount(result.outputs.failure_count);
  if (successCount === undefined || failureCount === undefined) {
    return 1;
  }
  return Math.min(
    MAX_PARALLEL_AGENT_WIDTH,
    Math.floor(successCount + failureCount),
  );
}

function countAgentStepsInMap(
  steps: NormalizedStep[],
  results: Record<string, StepResult>,
  repoPath?: string,
): number {
  let count = 0;
  for (const step of steps) {
    const result = results[step.id];
    if (!result || !isExecutedStep(result)) continue;

    const isAgent =
      result.log_format_hint === 'agent' ||
      result.agent_provider !== undefined ||
      isAgentPipelineStep(step, repoPath);
    if (!isAgent) continue;

    count +=
      step.uses === 'builtin/parallel-agents' ? parallelAgentWidth(result) : 1;
  }
  return count;
}

function countAgentStepsInJob(
  job: JobResult,
  steps: NormalizedStep[],
  repoPath?: string,
): number {
  let count = 0;
  for (const retry of job.retry_history ?? []) {
    for (const iteration of retry.iteration_history ?? []) {
      count += countAgentStepsInMap(steps, iteration.steps, repoPath);
    }
    count += countAgentStepsInMap(steps, retry.steps, repoPath);
  }
  for (const iteration of job.iteration_history ?? []) {
    count += countAgentStepsInMap(steps, iteration.steps, repoPath);
  }
  // `job.steps` and `iteration_history` are disjoint in the steady state, but
  // not at an iteration boundary: the executor persists `status: 'restarting'`
  // with `job.steps` still byte-identical to the snapshot it just pushed into
  // `iteration_history` (see `job-runner.ts`, and the matching guard in
  // `ObservabilityService.syncPipelineExecutionState`). A terminal execution
  // event landing on that state — a cancel at the boundary, or a run resumed
  // from it — would otherwise count that iteration's agent steps twice.
  //
  // This keys on the status string, so it depends on nothing rewriting a
  // `restarting` job's status while leaving the duplicated `job.steps` in
  // place. `markRemainingJobsCancelled` rewrites non-terminal jobs to
  // `cancelled`, but none of its call sites can observe a live `restarting`
  // job: the post-settle path runs after `resetJobForRestart` has already set
  // `pending`, and the recovery path normalizes `restarting` first. If that
  // ever changes, this guard and its twin must become structural (compare the
  // last `iteration_history` entry against `job.steps`) rather than
  // status-based.
  if (job.status === 'restarting') {
    return count;
  }
  return count + countAgentStepsInMap(steps, job.steps, repoPath);
}

function countPipelineAgentSteps(state: ExecutionState): number {
  let count = 0;
  for (const [physicalJobId, job] of Object.entries(state.jobs)) {
    const logicalJobId = logicalJobIdForPhysicalJob(state, physicalJobId);
    // `job_definitions` is authoritative. The snapshot lookup is a fallback for
    // states persisted before that field existed: there,
    // `logicalJobIdForPhysicalJob` returns the physical id, so matrix children
    // (`build_0`, `build_1`) are absent from `pipeline_snapshot.jobs` and hit
    // the `continue` below. Those legacy runs undercount their matrix jobs
    // rather than counting them once; this is accepted for the transition
    // window and needs no backfill.
    const definition =
      state.job_definitions?.[physicalJobId] ??
      state.pipeline_snapshot.jobs[logicalJobId];
    if (!definition) continue;
    count += countAgentStepsInJob(job, definition.steps, state.repo_path);
  }
  return count;
}

export function recordPipelineUsageEvent(event: ExecutionEvent): void {
  if (
    event.type !== 'execution.started' &&
    event.type !== 'execution.completed' &&
    event.type !== 'execution.cancelled' &&
    event.type !== 'execution.failed'
  ) {
    return;
  }

  const state = event.state;
  if (!state.project_id || state.hidden) return;

  const isStarted = event.type === 'execution.started';
  const completedAt = state.completed_at;
  const startedAt = state.started_at;
  const startedMs = Date.parse(startedAt);
  const completedMs = completedAt ? Date.parse(completedAt) : Number.NaN;
  const jobs = Object.values(state.jobs);
  const steps = jobs.flatMap((job) => Object.values(job.steps));
  const retryCount = jobs.reduce((sum, job) => sum + (job.retry_count ?? 0), 0);
  const pipeline = buildPipelineUsageIdentity(state);

  const usageEvent: PipelineRunUsageEvent = {
    version: 1,
    id: isStarted
      ? `pipeline-run-started:${state.id}`
      : `pipeline-run-completed:${state.id}`,
    type: isStarted ? 'pipeline_run_started' : 'pipeline_run_completed',
    timestamp: isStarted ? startedAt : (completedAt ?? event.timestamp),
    workspaceId: state.project_id,
    worktreeId: state.worktree_id,
    provider: 'pipeline',
    initiationSource:
      state.trigger_source?.kind === 'hook'
        ? 'hook'
        : (state.initiation_source ?? 'user'),
    pipelineExecutionId: state.id,
    pipeline,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    pipelineIdentityKey: pipeline.key,
    eventName: state.event_name,
    triggerSource: state.trigger_source?.kind,
    runStartedAt: startedAt,
    ...(isStarted ? {} : { runCompletedAt: completedAt }),
    // Working time, not wall clock: a run that sat paused for an hour waiting
    // on input did not take an hour, and every Usage/telemetry statistic
    // downstream inherits this number.
    ...(!isStarted &&
    completedAt &&
    Number.isFinite(startedMs) &&
    Number.isFinite(completedMs)
      ? { runDurationMs: getExecutionRunDurationMs(state) }
      : {}),
    status: isStarted
      ? 'running'
      : state.status === 'success' ||
          state.status === 'failure' ||
          state.status === 'cancelled'
        ? state.status
        : undefined,
    jobCount: jobs.length,
    stepCount: steps.length,
    // Agent steps are counted only once they have actually started, so a
    // `started` payload is structurally always 0. Emitting that 0 would let a
    // replayed/out-of-order RUNNING payload arriving after the terminal event
    // overwrite a completed run's real count with zero (the server refreshes
    // this field even on its status-downgrade guard path). Omit it instead and
    // let the terminal event be the only writer.
    ...(isStarted ? {} : { agentStepCount: countPipelineAgentSteps(state) }),
    retryCount,
    parentExecutionId: state.parent_execution_id,
    rerunSourceId: state.rerun_source_id,
    hidden: state.hidden,
  };

  getExecutionObservabilityIngest().recordUsageMetricEvent(usageEvent);
  if (!isStarted && state.worktree_id) {
    emitPipelineRunCompletion({
      projectId: state.project_id,
      worktreeId: state.worktree_id,
      event: usageEvent,
    });
  }
}
