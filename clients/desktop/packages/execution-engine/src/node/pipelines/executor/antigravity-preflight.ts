import { isAntigravityModel } from '@canopy/execution-engine/lib/antigravity-models';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import { isJobGroupTerminal } from './job-scheduler';
import type { ExecutionRuntime } from './types';

const GOOGLE_STEP_ACTIONS = new Set([
  'builtin/agent-prompt',
  'builtin/agent-resume',
]);
const DONE = new Set(['success', 'skipped']);
const INPUT_REFERENCE = /^\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/;

/**
 * The step's model when it is certainly known before the run: a literal, or
 * exactly one run input. Any other expression or alias is left to the step
 * runner, which refuses an unavailable Google model before inference.
 */
function knownStepModel(
  model: unknown,
  inputs: ExecutionState['inputs'],
): string | undefined {
  if (typeof model !== 'string') return undefined;
  const value = model.trim();
  const reference = INPUT_REFERENCE.exec(value);
  if (reference) {
    const input: unknown = inputs?.[reference[1] ?? ''];
    return typeof input === 'string' ? input.trim() : undefined;
  }
  return value.includes('${{') ? undefined : value;
}

/**
 * Whether a Google step of this run is expected to run and has not finished
 * in every variant yet. This is an early signal, not a schedule: work that may
 * be skipped or is allowed to fail is left to the step runner's own refusal,
 * as before. That covers steps and jobs with an `if:` condition or a literal
 * or expression `continue_on_error`, jobs with an iteration expression or a
 * dynamic matrix (which can expand to nothing), and every job that depends,
 * directly or not, on such a job. Groups that already
 * ended are ignored. An unexpanded group that has not ended has no results,
 * so its Google steps count as pending.
 */
export function runStillNeedsGoogle(state: ExecutionState): boolean {
  const pipeline = state.pipeline_snapshot;
  const jobs = Object.entries(pipeline.jobs);
  const mayNotRun = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [jobId, job] of jobs) {
      if (mayNotRun.has(jobId)) continue;
      if (
        job.if !== undefined ||
        job.continue_on_error ||
        job.continue_on_error_expression !== undefined ||
        job.max_iterations_expression !== undefined ||
        job.strategy?.dynamic === true ||
        job.needs.some((dependency) => mayNotRun.has(dependency))
      ) {
        mayNotRun.add(jobId);
        grew = true;
      }
    }
  }
  for (const [jobId, job] of jobs) {
    if (mayNotRun.has(jobId)) continue;
    const group = state.job_groups[jobId];
    if (isJobGroupTerminal(group)) continue;
    const variants =
      group && group.expansion === 'expanded'
        ? group.variant_job_ids.map((id) => state.jobs[id])
        : [undefined];
    for (const step of job.steps) {
      if (!step.uses || !GOOGLE_STEP_ACTIONS.has(step.uses)) continue;
      if (step.if !== undefined || step.continue_on_error) continue;
      const model = knownStepModel(step.with?.model, state.inputs);
      if (!model || !isAntigravityModel(model)) continue;
      const finished = variants.every((variant) => {
        const result = variant?.steps[step.id];
        return result !== undefined && DONE.has(result.status);
      });
      if (!finished) return true;
    }
  }
  return false;
}

/**
 * Refuses a run, before any job starts, when it still needs a Google step
 * that this host cannot run now. Covers start, resume, retry, rerun, child
 * and scheduled runs, which all start through the same executor.
 */
export async function assertGoogleAvailableForRun(
  state: ExecutionState,
  runtime: ExecutionRuntime,
  signal?: AbortSignal,
): Promise<void> {
  if (!runStillNeedsGoogle(state)) return;
  const runner = runtime.antigravityPromptRunner;
  // A run cancelled now takes the executor's cancelled path.
  if (signal?.aborted) return;
  if (!runner)
    throw new Error(
      'This workflow has Google steps, but Google workflows are not available on this host.',
    );
  try {
    await runner.preflight?.(signal);
  } catch (error) {
    // A run cancelled during the check takes the executor's cancelled path.
    if (signal?.aborted) return;
    throw error;
  }
}
