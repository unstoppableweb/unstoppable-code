// CAN-5061 execution golden helpers: shell-only pipelines, a stable state
// projection and waits on the persisted execution record.
import { readFile } from 'node:fs/promises';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';

function yaml(...rows: string[]): string {
  return `${rows.join('\n')}\n`;
}

export const SUCCESS_YAML = yaml(
  'pipeline:',
  '  name: Golden run success',
  '  on:',
  '    dispatch:',
  '      inputs:',
  '        greeting:',
  '          type: string',
  '          default: hello',
  '  jobs:',
  '    build:',
  '      name: Build',
  '      steps:',
  '        - id: greet',
  '          run: |',
  '            echo "$GREETING"',
  '            echo "said=$GREETING" >> "$CANOPY_OUTPUT"',
  '          env:',
  '            GREETING: ${{ inputs.greeting }}',
  '    report:',
  '      name: Report',
  '      needs: [build]',
  '      steps:',
  '        - id: done',
  '          run: echo "${{ needs.build.outputs.said }}"',
);

/** Fails until its marker file exists, so a retry succeeds. */
export const FLAKY_YAML = yaml(
  'pipeline:',
  '  name: Golden run flaky',
  '  on:',
  '    dispatch:',
  '      inputs:',
  '        marker:',
  '          type: string',
  '          required: true',
  '  jobs:',
  '    setup:',
  '      name: Setup',
  '      steps:',
  '        - id: ok',
  '          run: echo setup',
  '    flaky:',
  '      name: Flaky',
  '      needs: [setup]',
  '      steps:',
  '        - id: attempt',
  '          run: |',
  '            if [ -f "$MARKER" ]; then echo recovered; else touch "$MARKER"; echo first-failure; exit 4; fi',
  '          env:',
  '            MARKER: ${{ inputs.marker }}',
);

export const PAUSE_YAML = yaml(
  'pipeline:',
  '  name: Golden run pause',
  '  on: dispatch',
  '  jobs:',
  '    gate:',
  '      name: Gate',
  '      steps:',
  '        - id: ask',
  '          run: |',
  `            echo 'CANOPY_INPUT_REQUEST={"title":"Approve","fields":[{"key":"approved","label":"Approved","type":"boolean","required":true}]}' >> "$CANOPY_OUTPUT"`,
  '            echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
  '        - id: after',
  '          run: echo resumed',
);

/** Variant beta fails until its marker exists; alpha always succeeds. */
export const MATRIX_YAML = yaml(
  'pipeline:',
  '  name: Golden run matrix',
  '  on:',
  '    dispatch:',
  '      inputs:',
  '        marker:',
  '          type: string',
  '          required: true',
  '  jobs:',
  '    build:',
  '      name: Build',
  '      strategy:',
  '        matrix:',
  '          value: [alpha, beta]',
  '        max_parallel: 2',
  '      steps:',
  '        - id: variant',
  '          run: |',
  '            if [ "$VALUE" = beta ] && [ ! -f "$MARKER" ]; then touch "$MARKER"; exit 5; fi',
  '            echo "$VALUE"',
  '          env:',
  '            VALUE: ${{ matrix.value }}',
  '            MARKER: ${{ inputs.marker }}',
);

/** Variant beta pauses for input; alpha succeeds. */
export const MATRIX_PAUSE_YAML = yaml(
  'pipeline:',
  '  name: Golden run matrix pause',
  '  on: dispatch',
  '  jobs:',
  '    build:',
  '      name: Build',
  '      strategy:',
  '        matrix:',
  '          value: [alpha, beta]',
  '        max_parallel: 2',
  '      steps:',
  '        - id: variant',
  '          run: |',
  '            if [ "$VALUE" = beta ]; then echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"; fi',
  '            echo "$VALUE"',
  '          env:',
  '            VALUE: ${{ matrix.value }}',
);

/** Sleeps on its first attempt only, so a resumed run finishes at once. */
export const SLOW_ONCE_YAML = yaml(
  'pipeline:',
  '  name: Golden run slow once',
  '  on:',
  '    dispatch:',
  '      inputs:',
  '        marker:',
  '          type: string',
  '          required: true',
  '  jobs:',
  '    wait:',
  '      name: Wait',
  '      steps:',
  '        - id: first',
  '          run: echo first',
  '        - id: sleep',
  '          run: |',
  '            if [ -f "$MARKER" ]; then echo resumed; exit 0; fi',
  '            touch "$MARKER"',
  '            echo sleeping',
  '            sleep 30',
  '          env:',
  '            MARKER: ${{ inputs.marker }}',
);

/**
 * Starts only from the Workflows page (CAN-5782): its inputs live under
 * `on.workflow`, and it declares no `dispatch`.
 */
export const WORKFLOW_YAML = yaml(
  'pipeline:',
  '  name: Golden run workflow',
  '  on:',
  '    workflow:',
  '      inputs:',
  '        greeting:',
  '          type: string',
  '          default: hello',
  '  jobs:',
  '    build:',
  '      steps:',
  '        - id: greet',
  '          run: echo "$GREETING"',
  '          env:',
  '            GREETING: ${{ inputs.greeting }}',
);

/** Runs with no project, in a scratch folder. */
export const GLOBAL_YAML = yaml(
  'pipeline:',
  '  name: Golden run global',
  '  on: dispatch',
  '  scope: [global]',
  '  jobs:',
  '    digest:',
  '      steps:',
  '        - id: say',
  '          run: echo global',
);

const TERMINAL = ['success', 'failure', 'cancelled'];

/** Wait until the persisted record reaches one of `statuses`. */
export async function waitForExecution(
  executionsDir: string,
  executionId: string,
  statuses: readonly string[] = [...TERMINAL, 'paused'],
): Promise<ExecutionState> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const state = await loadExecutionState(executionId, executionsDir);
    if (state && statuses.includes(state.status)) return state;
    if (Date.now() > deadline)
      throw new Error(
        `Execution ${executionId} stayed ${state?.status ?? 'missing'}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Wait until a step of the persisted record is running and its log shows
 * `text`, so what a later cancel or checkpoint observes never depends on
 * output flush timing.
 */
export async function waitForRunningStep(
  executionsDir: string,
  executionId: string,
  jobId: string,
  stepId: string,
  text = 'sleeping',
): Promise<ExecutionState> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const state = await loadExecutionState(executionId, executionsDir);
    const step = state?.jobs[jobId]?.steps[stepId];
    if (
      state &&
      step?.status === 'running' &&
      step.log_file &&
      (await readFile(step.log_file, 'utf8').catch(() => '')).includes(text)
    )
      return state;
    if (Date.now() > deadline)
      throw new Error(`Step ${jobId}/${stepId} never started`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The orchestration a golden pins: run, job and step outcomes, outputs,
 * errors, blockers and pauses. Timings, pids, log paths and the pipeline
 * snapshot are left out; they are host facts, not behavior.
 */
export function projectExecution(state: ExecutionState | null): unknown {
  if (!state) return null;
  return {
    id: state.id,
    pipeline_id: state.pipeline_id,
    pipeline: state.pipeline_snapshot.name,
    status: state.status,
    event_name: state.event_name,
    initiation_source: state.initiation_source,
    initiator: state.initiator,
    inputs: state.inputs,
    error: state.error,
    status_reasons: state.status_reasons.map((reason) => ({
      kind: reason.kind,
      code: reason.code,
      source: reason.source,
    })),
    pending_pauses: state.pending_pauses.map((pause) => ({
      kind: pause.kind,
      job_id: pause.job_id,
      step_id: pause.step_id,
      attempt: pause.attempt,
      iteration: pause.iteration,
      request: pause.request,
    })),
    shutdown_checkpoint: state.shutdown_checkpoint ? true : undefined,
    rerun_source_id: state.rerun_source_id,
    jobs: Object.fromEntries(
      Object.entries(state.jobs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([jobId, job]) => [
          jobId,
          {
            status: job.status,
            conclusion: job.conclusion,
            retry_count: job.retry_count,
            outputs: job.outputs,
            steps: Object.fromEntries(
              Object.entries(job.steps).map(([stepId, step]) => [
                stepId,
                {
                  status: step.status,
                  conclusion: step.conclusion,
                  exit_code: step.exit_code,
                  error: step.error,
                  outputs: step.outputs,
                },
              ]),
            ),
          },
        ]),
    ),
  };
}
