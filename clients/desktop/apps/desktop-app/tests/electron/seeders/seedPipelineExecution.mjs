import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeJson } from './fsHelpers.mjs';

/**
 * Harness primitive H4 — seed a persisted pipeline execution so the Pipeline
 * Execution Detail modal and the Pipeline Runs section render from seeded
 * state (no live pipeline run required).
 *
 * On-disk paths (all under `{userDataDir}/pipeline-executions/`):
 *   - `{executionId}.json`         — the `ExecutionState` file
 *   - `{executionId}/pipeline-advisor.json` — optional advisor snapshot
 *   - `{executionId}/logs/{job}--{step}.log` — optional per-step log/transcript
 *
 * Path sources:
 *   - executions dir: `apps/desktop-app/src/main/services/pipelines-service.ts`
 *     `getPipelineExecutionsDir()` → `join(getDataDir(), 'pipeline-executions')`.
 *   - state file: `packages/execution-engine/src/node/pipelines/executor/execution-state.ts`
 *     `getExecutionStatePath` → `{executionsDir}/{executionId}.json`. The reader
 *     `loadExecutionState` only hard-requires `version` ∈ {1..5}; it backfills
 *     `inputs`, normalizes a few optional fields, and migrates to v5.
 *     `listExecutionSummaries` reads every `*.json` in the dir (it is what
 *     `window.pipelines.listExecutions()` → the runs section consumes), and the
 *     detail modal consumes the full state via `window.pipelines.getExecution`.
 *   - advisor snapshot: `apps/desktop-app/src/main/pipelines/pipeline-advisor-store.ts`
 *     `getPipelineAdvisorSnapshotPath` →
 *     `{executionsDir}/{executionId}/pipeline-advisor.json`. The reader
 *     `readPipelineAdvisorSnapshot` → `normalizeSnapshot` requires
 *     `version === 1` plus non-empty `executionId`, `executionDataDir`,
 *     `stateFilePath`, `provider` ('claude'|'codex'), `model`, valid
 *     `thinkingLevel`, valid `status`, and `lastUpdatedAt`.
 *   - step log: `packages/execution-engine/src/node/pipelines/executor/step-runner.ts`
 *     `getStepLogFilePath` →
 *     `{executionsDir}/{executionId}/logs/{sanitize(jobId)}--{sanitize(stepId)}[--attemptN][--iterN].log`
 *     (sanitize collapses `[^A-Za-z0-9._-]+` to `_`). This is the "transcript
 *     sidecar" the detail modal's step output panel reads.
 *
 * Shapes (`packages/execution-engine/src/types/pipeline.ts`):
 *   - `ExecutionState` { version: 5, id, pipeline_id, pipeline_snapshot
 *       (NormalizedPipeline), status, jobs (Record<string, JobResult>),
 *       started_at, cwd, env, inputs, ... } — the detail modal reads
 *     `pipeline_snapshot.jobs[jobId].steps[]` and `jobs[jobId].steps[stepId]`,
 *     so the normalized snapshot and the job results must agree on job/step ids.
 *   - `JobResult` / `StepResult` / `PauseInputRequest` / `RetryAttempt`.
 *   - `PipelineAdvisorSnapshot` / `PipelineAdvisorReport`.
 *
 * The state-shape variants requested by the harness are produced from
 * `options.execution`:
 *   - `status: 'success'` with terminal steps         → completed run
 *   - `status: 'paused'` + `pendingInput` with no fields  → paused-formless
 *   - `status: 'paused'` + `pendingInput.request.fields` → paused-structured
 *     (a `request-input` pause; the modal renders the input form)
 *   - `retryActiveAdvisor: true`                       → a running job carrying
 *     `retry_history` plus a running advisor snapshot (retry-active-advisor)
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {string} [options.workspaceId] workspace id, persisted as `project_id`
 * @param {string} [options.worktreeId] worktree id, persisted as `worktree_id`
 * @param {object} [options.execution] execution overrides
 * @param {string} [options.execution.id] execution id; defaults to a seeded id
 * @param {string} [options.execution.pipelineId]
 * @param {string} [options.execution.pipelineName]
 * @param {import('@canopy/execution-engine/types/pipeline').ExecutionState['status']} [options.execution.status]
 *   defaults to `'success'`.
 * @param {string} [options.execution.startedAt] ISO timestamp
 * @param {string} [options.execution.completedAt] ISO timestamp
 * @param {string} [options.execution.cwd]
 * @param {Array<{ id?: string, name?: string, steps?: Array<{ id?: string, name?: string, run?: string }> }>} [options.execution.jobs]
 *   job/step skeleton; defaults to a single `build` job with one step.
 * @param {Record<string, Partial<import('@canopy/execution-engine/types/pipeline').StepResult>>} [options.execution.stepResults]
 *   per-step result overrides keyed by `"{jobId}.{stepId}"` (timestamps, status,
 *   exit codes, etc.). Merged over the status-derived defaults.
 * @param {{ jobId?: string, stepId?: string, title?: string, message?: string, fields?: import('@canopy/execution-engine/types/pipeline').PauseInputField[] }} [options.execution.pendingInput]
 *   when set, persists `state.pending_input` and marks the target step/job
 *   `paused`. Omit `fields` (or pass `[]`) for a formless pause.
 * @param {boolean} [options.execution.retryActiveAdvisor]
 *   convenience flag: produces a running job with one `retry_history` attempt
 *   and a default running advisor snapshot.
 * @param {Partial<import('@canopy/execution-engine/types/pipeline').ExecutionState>} [options.execution.stateOverrides]
 *   shallow overrides merged last onto the built `ExecutionState`.
 * @param {Partial<import('@canopy/execution-engine/types/pipeline').PipelineAdvisorSnapshot> | true} [options.advisorSnapshot]
 *   when truthy, writes `pipeline-advisor.json`. Pass `true` for defaults or an
 *   object to override fields.
 * @param {Array<{ jobId: string, stepId: string, attempt?: number, iteration?: number, lines: string[] }>} [options.stepLogs]
 *   optional per-step log/transcript sidecars to write.
 * @returns {{ executionsDir: string, stateFilePath: string, state: object,
 *   advisorSnapshotPath?: string, advisorSnapshot?: object,
 *   stepLogPaths: string[] }}
 */
export function seedPipelineExecution(options) {
  const {
    userDataDir,
    workspaceId,
    worktreeId,
    execution = {},
    advisorSnapshot,
    stepLogs = [],
  } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedPipelineExecution requires userDataDir');
  }

  const executionId = execution.id ?? 'seeded-execution-1';
  const pipelineId = execution.pipelineId ?? 'seeded-pipeline';
  const pipelineName = execution.pipelineName ?? 'Seeded Pipeline';
  const status = execution.status ?? 'success';
  const startedAt = execution.startedAt ?? '2026-04-10T12:00:00.000Z';
  const cwd = execution.cwd ?? '/seeded/worktree';

  const jobSkeletons = execution.jobs ?? [
    {
      id: 'build',
      name: 'Build',
      steps: [{ id: 'compile', name: 'Compile', run: 'npm run build' }],
    },
  ];

  const pendingInput = execution.pendingInput;
  const retryActiveAdvisor = execution.retryActiveAdvisor === true;
  const stepResultOverrides = execution.stepResults ?? {};

  const executionsDir = path.join(userDataDir, 'pipeline-executions');
  const stateFilePath = path.join(executionsDir, `${executionId}.json`);

  // Build the normalized pipeline snapshot and the per-job results in lockstep
  // so job/step ids agree (the detail modal indexes both by the same ids).
  const snapshotJobs = {};
  const jobResults = {};

  for (const jobSkeleton of jobSkeletons) {
    const jobId = jobSkeleton.id ?? 'build';
    const stepSkeletons =
      jobSkeleton.steps && jobSkeleton.steps.length > 0
        ? jobSkeleton.steps
        : [{ id: 'compile' }];

    const normalizedSteps = stepSkeletons.map((step, stepIndex) => ({
      id: step.id ?? `step-${stepIndex + 1}`,
      ...(step.name ? { name: step.name } : {}),
      ...(step.run ? { run: step.run } : { run: 'echo seeded' }),
      shell: 'bash',
      continue_on_error: false,
      timeout_minutes: 30,
      skip_on_missing_action: false,
    }));

    snapshotJobs[jobId] = {
      name: jobSkeleton.name ?? jobId,
      needs: [],
      timeout_minutes: 60,
      max_retries: retryActiveAdvisor ? 1 : 0,
      continue_on_error: false,
      steps: normalizedSteps,
    };

    const pausedStepId =
      pendingInput && (pendingInput.jobId ?? firstId(jobSkeletons)) === jobId
        ? (pendingInput.stepId ?? normalizedSteps[0].id)
        : undefined;

    const steps = {};
    for (const normalizedStep of normalizedSteps) {
      steps[normalizedStep.id] = buildStepResult({
        status,
        startedAt,
        completedAt: execution.completedAt,
        isPaused: normalizedStep.id === pausedStepId,
        pendingInput,
        override: stepResultOverrides[`${jobId}.${normalizedStep.id}`],
      });
    }

    jobResults[jobId] = buildJobResult({
      status,
      startedAt,
      completedAt: execution.completedAt,
      steps,
      isPaused: pausedStepId !== undefined,
      retryActiveAdvisor,
    });
  }

  /** @type {import('@canopy/execution-engine/types/pipeline').NormalizedPipeline} */
  const pipelineSnapshot = {
    name: pipelineName,
    jobs: snapshotJobs,
  };

  /** @type {import('@canopy/execution-engine/types/pipeline').ExecutionState} */
  const state = {
    version: 5,
    id: executionId,
    pipeline_id: pipelineId,
    pipeline_snapshot: pipelineSnapshot,
    status,
    status_reasons: [],
    // Loading migrates a v5 state and rebuilds its pause checkpoints, but
    // injected events carry this state as written, so mirror that checkpoint.
    pending_pauses: pendingInput
      ? [
          buildPauseCheckpoint(
            executionId,
            jobSkeletons,
            pendingInput,
            startedAt,
          ),
        ]
      : [],
    jobs: jobResults,
    started_at: startedAt,
    ...(execution.completedAt ? { completed_at: execution.completedAt } : {}),
    cwd,
    env: {},
    inputs: {},
    event_name: 'dispatch',
    ...(workspaceId ? { project_id: workspaceId } : {}),
    ...(worktreeId ? { worktree_id: worktreeId } : {}),
    ...(pendingInput
      ? {
          pending_input: {
            job_id: pendingInput.jobId ?? firstId(jobSkeletons),
            step_id:
              pendingInput.stepId ??
              firstStepId(jobSkeletons, pendingInput.jobId),
            request: buildPauseRequest(pendingInput),
          },
        }
      : {}),
    ...(execution.stateOverrides ?? {}),
  };

  writeJson(stateFilePath, state);

  const result = {
    executionsDir,
    stateFilePath,
    state,
    stepLogPaths: [],
  };

  // Optional advisor snapshot.
  if (advisorSnapshot || retryActiveAdvisor) {
    const overrides =
      advisorSnapshot && advisorSnapshot !== true ? advisorSnapshot : {};
    const snapshot = buildAdvisorSnapshot({
      executionId,
      executionsDir,
      stateFilePath,
      pipelineStartedAt: startedAt,
      retryActiveAdvisor,
      overrides,
    });
    const advisorSnapshotPath = path.join(
      executionsDir,
      executionId,
      'pipeline-advisor.json',
    );
    writeJson(advisorSnapshotPath, snapshot);
    result.advisorSnapshotPath = advisorSnapshotPath;
    result.advisorSnapshot = snapshot;
  }

  // Optional per-step log/transcript sidecars.
  for (const stepLog of stepLogs) {
    const logPath = buildStepLogPath(
      executionsDir,
      executionId,
      stepLog.jobId,
      stepLog.stepId,
      stepLog.attempt ?? 0,
      stepLog.iteration ?? 1,
    );
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${stepLog.lines.join('\n')}\n`, 'utf8');
    result.stepLogPaths.push(logPath);
  }

  return result;
}

function firstId(jobSkeletons) {
  return jobSkeletons[0]?.id ?? 'build';
}

function firstStepId(jobSkeletons, jobId) {
  const target =
    jobSkeletons.find((job) => (job.id ?? 'build') === jobId) ??
    jobSkeletons[0];
  return target?.steps?.[0]?.id ?? 'compile';
}

function buildStepResult({
  status,
  startedAt,
  completedAt,
  isPaused,
  pendingInput,
  override,
}) {
  const base = {
    status: 'pending',
    outputs: {},
    dynamic_env: {},
  };

  if (isPaused) {
    return {
      ...base,
      status: 'running',
      started_at: startedAt,
      ...(pendingInput
        ? { input_request: buildPauseRequest(pendingInput) }
        : {}),
      ...(override ?? {}),
    };
  }

  if (status === 'success') {
    return {
      ...base,
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      started_at: startedAt,
      completed_at: completedAt ?? '2026-04-10T12:01:00.000Z',
      exit_code: 0,
      ...(override ?? {}),
    };
  }

  if (status === 'failure') {
    return {
      ...base,
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      started_at: startedAt,
      completed_at: completedAt ?? '2026-04-10T12:01:00.000Z',
      exit_code: 1,
      ...(override ?? {}),
    };
  }

  if (status === 'running') {
    return {
      ...base,
      status: 'running',
      started_at: startedAt,
      ...(override ?? {}),
    };
  }

  // pending / cancelled / paused-without-pending-step fall through as pending.
  return { ...base, ...(override ?? {}) };
}

function buildJobResult({
  status,
  startedAt,
  completedAt,
  steps,
  isPaused,
  retryActiveAdvisor,
}) {
  if (isPaused) {
    return {
      status: 'paused',
      steps,
      outputs: {},
      started_at: startedAt,
      iteration_count: 1,
    };
  }

  if (retryActiveAdvisor) {
    return {
      status: 'running',
      steps,
      outputs: {},
      started_at: startedAt,
      retry_count: 1,
      iteration_count: 1,
      retry_history: [
        {
          attempt: 0,
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          steps: cloneStepsAsFailed(steps),
          started_at: startedAt,
          completed_at: '2026-04-10T12:00:45.000Z',
        },
      ],
    };
  }

  const jobStatus =
    status === 'success' || status === 'failure' || status === 'cancelled'
      ? status
      : status === 'running'
        ? 'running'
        : 'pending';

  return {
    status: jobStatus,
    steps,
    outputs: {},
    started_at: startedAt,
    iteration_count: 1,
    ...(jobStatus === 'success' || jobStatus === 'failure'
      ? {
          conclusion: jobStatus,
          outcome: jobStatus,
          completed_at: completedAt ?? '2026-04-10T12:01:00.000Z',
        }
      : {}),
  };
}

function cloneStepsAsFailed(steps) {
  const cloned = {};
  for (const [stepId, step] of Object.entries(steps)) {
    cloned[stepId] = {
      ...step,
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
    };
  }
  return cloned;
}

function buildPauseRequest(pendingInput) {
  return {
    ...(pendingInput.title ? { title: pendingInput.title } : {}),
    ...(pendingInput.message ? { message: pendingInput.message } : {}),
    fields: pendingInput.fields ?? [],
  };
}

/**
 * The `input` checkpoint the v7 → v8 load migration derives from a paused
 * step that carries an input request.
 */
function buildPauseCheckpoint(
  executionId,
  jobSkeletons,
  pendingInput,
  startedAt,
) {
  const jobId = pendingInput.jobId ?? firstId(jobSkeletons);
  const stepId = pendingInput.stepId ?? firstStepId(jobSkeletons, jobId);
  return {
    id: `${executionId}:pause:${jobId}:${stepId}`,
    kind: 'input',
    job_id: jobId,
    logical_job_id: jobId,
    step_id: stepId,
    attempt: 0,
    iteration: 1,
    detected_at: startedAt,
    request: buildPauseRequest(pendingInput),
  };
}

function buildAdvisorSnapshot({
  executionId,
  executionsDir,
  stateFilePath,
  pipelineStartedAt,
  retryActiveAdvisor,
  overrides,
}) {
  const lastUpdatedAt = '2026-04-10T12:00:30.000Z';
  const report = {
    version: 1,
    reportId: `${executionId}-report-1`,
    executionId,
    kind: 'periodic',
    generatedAt: lastUpdatedAt,
    pipelineStatus: retryActiveAdvisor ? 'running' : 'success',
    health: {
      status: retryActiveAdvisor ? 'watch' : 'complete',
      score: retryActiveAdvisor ? 60 : 100,
      summary: 'Seeded advisor report.',
      evidence: [],
      blockers: [],
    },
    eta: {
      status: retryActiveAdvisor ? 'available' : 'complete',
      confidence: 'medium',
      rationale: 'Seeded ETA rationale.',
      ...(retryActiveAdvisor ? { remainingSeconds: 120 } : {}),
    },
    inefficiencies: [],
    summary: 'Seeded advisor summary.',
    recommendations: [],
  };

  return {
    version: 1,
    executionId,
    executionDataDir: path.join(executionsDir, executionId),
    stateFilePath,
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    thinkingLevel: 'medium',
    status: retryActiveAdvisor ? 'running' : 'completed',
    turnCount: 1,
    backoffIndex: 0,
    lastUpdatedAt,
    pipelineStartedAt,
    reports: [report],
    latestReport: report,
    ...overrides,
  };
}

/**
 * Replicates `getStepLogFilePath` (step-runner.ts) including
 * `sanitizePathSegment` (`[^A-Za-z0-9._-]+` → `_`) and the attempt/iteration
 * suffixes.
 *
 * @param {string} executionsDir
 * @param {string} executionId
 * @param {string} jobId
 * @param {string} stepId
 * @param {number} attempt
 * @param {number} iteration
 * @returns {string}
 */
function buildStepLogPath(
  executionsDir,
  executionId,
  jobId,
  stepId,
  attempt,
  iteration,
) {
  const sanitize = (value) => value.replace(/[^A-Za-z0-9._-]+/g, '_');
  const attemptSuffix = attempt > 0 ? `--attempt${attempt}` : '';
  const iterationSuffix = iteration > 1 ? `--iter${iteration}` : '';
  return path.join(
    executionsDir,
    executionId,
    'logs',
    `${sanitize(jobId)}--${sanitize(stepId)}${attemptSuffix}${iterationSuffix}.log`,
  );
}
