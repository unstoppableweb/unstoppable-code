import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkerPipelineHandlers,
  type PipelineExecutionWorker,
} from '@canopy/core-runtime/node/pipeline';
import { refusingExecutionSecretSource } from '@canopy/core-runtime/node/execution-secrets';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import {
  WorkerPipelineExecutionGetResultSchema,
  WorkerPipelineExecutionListResultSchema,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionDetail,
  type WorkerPipelineExecutionListParams,
  type WorkerPipelineExecutionView,
} from '@canopy/protocol/canopy-core';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  listExecutionSummaries,
  loadExecutionState,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import { createInitialState } from '@canopy/execution-engine/node/pipelines/executor/pipeline-executor';
import type { ExecutionState } from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  EXECUTION_ID,
  createRuntime,
  legacyFixture,
  pausedState,
} from '@canopy/execution-engine/node/pipelines/executor/__tests__/execution-state-fixtures';
import { listPipelineExecutionPage } from '@canopy/execution-engine/node/pipelines/execution-list';
import {
  projectPipelineExecution,
  projectPipelineExecutionDetail,
  projectPipelineExecutionView,
} from '@canopy/execution-engine/node/pipelines/execution-projection';

/*
 * CAN-6117: the worker detail projection carries everything the shared run
 * views render (`PipelineRunRows`, run detail and its pause form), for every
 * execution-state version the store loads, and `execution.list` pages and
 * filters the store. Each "rendered" model below is what those views read,
 * built once from the stored state and once from the wire.
 */

const iso = (value: string | undefined): string | null =>
  value === undefined ? null : new Date(value).toISOString();

/** What the shared run views read from an `ExecutionState`. */
function renderedFromState(state: ExecutionState): unknown {
  const replay = state.rerun_context?.event_data;
  return {
    summary: {
      id: state.id,
      pipelineId: state.pipeline_id,
      name: state.pipeline_snapshot.name,
      status: state.status,
      startedAt: iso(state.started_at),
      completedAt: iso(state.completed_at),
      pausedAt: iso(state.paused_at),
      pausedMs: state.paused_ms ?? 0,
      workspaceId: state.project_id ?? null,
      worktreeId: state.worktree_id ?? null,
      planId: state.planId ?? null,
      planModified:
        state.plan_hash_before !== undefined &&
        state.plan_hash_after !== undefined &&
        state.plan_hash_before !== state.plan_hash_after,
      hasPlan: state.plan_hash_after !== undefined,
      hasReport: Boolean(
        state.report_outputs?.report_file ||
        state.report_outputs?.report_json_file,
      ),
      rerunSourceId: state.rerun_source_id ?? null,
      parentExecutionId: state.parent_execution_id ?? null,
      hidden: state.hidden === true,
      hookLabel: state.trigger_source?.hook_label ?? null,
      hookTrigger: state.trigger_source?.trigger_name ?? null,
    },
    statusReasons: state.status_reasons.map((reason) => ({
      id: reason.id,
      kind: reason.kind,
      code: reason.code,
      provider: reason.provider ?? null,
      resetsAt: iso(reason.resets_at),
    })),
    rerun: {
      event: state.event_name ?? null,
      inputsPersisted: state.inputs_persisted !== false,
      planReady: Boolean(replay?.plan_ready?.plan_text),
      taskReady: Boolean(replay?.task_ready?.task_text),
    },
    jobs: Object.entries(state.pipeline_snapshot.jobs).map(
      ([logicalJobId, logical]) => {
        const group = state.job_groups[logicalJobId];
        return {
          jobId: logicalJobId,
          name: logical.name,
          needs: logical.needs,
          kind: group.kind,
          status: group.status,
          startedAt: iso(group.started_at),
          completedAt: iso(group.completed_at),
          maxParallel: group.resolved_max_parallel ?? null,
          variants: group.variant_job_ids.map((physicalJobId) => {
            const definition = state.job_definitions[physicalJobId];
            const result = state.jobs[physicalJobId];
            return {
              jobId: physicalJobId,
              name: definition.name,
              status: result?.status ?? 'pending',
              startedAt: iso(result?.started_at),
              completedAt: iso(result?.completed_at),
              steps: definition.steps.map((step) => ({
                stepId: step.id,
                name: step.name ?? step.id,
                status: result?.steps[step.id]?.status ?? 'pending',
              })),
            };
          }),
        };
      },
    ),
    pendingPauses: state.pending_pauses.map((checkpoint) => ({
      id: checkpoint.id,
      kind: checkpoint.kind,
      jobId: checkpoint.job_id,
      logicalJobId: checkpoint.logical_job_id,
      stepId: checkpoint.step_id,
      request: checkpoint.request
        ? {
            title: checkpoint.request.title ?? null,
            message: checkpoint.request.message ?? null,
            fields: checkpoint.request.fields,
          }
        : null,
    })),
  };
}

/** The same model, read from the wire projection. */
function renderedFromWire(
  execution: WorkerPipelineExecution,
  detail: WorkerPipelineExecutionDetail,
): unknown {
  const runReport = detail.artifacts.some(
    (artifact) => artifact.jobId === null && artifact.stepId === null,
  );
  return {
    summary: {
      id: execution.executionId,
      pipelineId: execution.pipelineId,
      name: execution.name,
      status: execution.status,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      pausedAt: detail.pausedAt,
      pausedMs: detail.pausedMs,
      workspaceId: execution.workspaceId,
      worktreeId: execution.worktreeId,
      planId: detail.plan?.planId ?? null,
      planModified: detail.plan?.modified ?? false,
      hasPlan: detail.plan?.saved ?? false,
      hasReport: runReport,
      rerunSourceId: detail.initiation.rerunSourceId,
      parentExecutionId: execution.parentExecutionId,
      hidden: detail.hidden,
      hookLabel: detail.initiation.hook?.hookLabel ?? null,
      hookTrigger: detail.initiation.hook?.triggerName ?? null,
    },
    statusReasons: detail.statusReasons.map((reason) => ({
      id: reason.id,
      kind: reason.kind,
      code: reason.code,
      provider: reason.provider ?? null,
      resetsAt: reason.resetsAt ?? null,
    })),
    rerun: {
      event: detail.initiation.event,
      inputsPersisted: detail.rerun.inputsPersisted,
      planReady: detail.rerun.planReadyText,
      taskReady: detail.rerun.taskReadyText,
    },
    jobs: detail.jobs.map((job) => ({
      jobId: job.jobId,
      name: job.name,
      needs: job.needs,
      kind: job.kind,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      maxParallel: job.maxParallel,
      variants: job.variants.map((variant) => ({
        jobId: variant.jobId,
        name: variant.name,
        status: variant.status,
        startedAt: variant.startedAt,
        completedAt: variant.completedAt,
        steps: variant.steps.map((step) => ({
          stepId: step.stepId,
          name: step.name,
          status: step.status,
        })),
      })),
    })),
    pendingPauses: detail.pendingPauses.map((pause) => ({
      id: pause.id,
      kind: pause.kind,
      jobId: pause.jobId,
      logicalJobId: pause.logicalJobId,
      stepId: pause.stepId,
      request: pause.request
        ? {
            title: pause.request.title ?? null,
            message: pause.request.message ?? null,
            fields: pause.request.fields,
          }
        : null,
    })),
  };
}

/** The wire view, validated exactly as the dispatcher validates a result. */
function wire(state: ExecutionState): {
  execution: WorkerPipelineExecution;
  detail: WorkerPipelineExecutionDetail;
} {
  const view = WorkerPipelineExecutionGetResultSchema.parse(
    projectPipelineExecutionView(state, { detail: true }),
  );
  if (!view.detail) throw new Error('Expected a detail.');
  return { execution: view.execution, detail: view.detail };
}

/** A finished matrix run with reports, a plan and every initiation field. */
function richState(dir: string): ExecutionState {
  const state = createInitialState(
    normalizePipeline({
      name: 'Rich run',
      on: 'dispatch',
      jobs: {
        setup: { steps: [{ id: 'prepare', name: 'Prepare', run: 'echo' }] },
        build: {
          needs: ['setup'],
          strategy: { matrix: { os: ['linux', 'mac'] } },
          steps: [{ id: 'compile', run: 'echo' }],
        },
      },
    }),
    { cwd: dir, pipelineId: 'rich', runtime: createRuntime(dir) },
    'rich-run',
  );
  // The matrix job expands at run time, so its variants are built here.
  const { strategy, ...buildDefinition } = state.pipeline_snapshot.jobs.build;
  void strategy;
  state.status = 'failure';
  state.started_at = '2026-01-02T00:00:00.000Z';
  state.completed_at = '2026-01-02T00:10:00.000Z';
  state.project_id = 'workspace-a';
  state.worktree_id = 'worktree-a';
  state.scope = 'worktree';
  state.execution_context = 'org:123e4567-e89b-42d3-a456-426614174999';
  state.error = 'Build failed';
  state.event_name = 'plan_ready';
  state.planId = 'plan-1';
  state.plan_hash_before = 'a';
  state.plan_hash_after = 'b';
  state.rerun_source_id = 'earlier-run';
  state.rerun_context = { event_data: { plan_ready: { plan_text: 'Plan' } } };
  state.paused_ms = 1500;
  state.hidden = true;
  state.report_outputs = { report_file: join(dir, 'rich-run', 'report.md') };
  state.initiation_source = 'automation';
  state.initiator = {
    kind: 'automation',
    automationId: 'automation-1',
    automationName: 'Nightly',
    ifCommandOutput: 'host-only gate output',
    background: true,
  };
  state.trigger_source = {
    kind: 'hook',
    hook_key: 'hook-1',
    hook_label: 'On PR',
    trigger_name: 'pr:create',
    target: 'project',
    action_index: 0,
    triggered_at: '2026-01-02T00:00:00.000Z',
  };
  state.curated_pipeline_source = {
    key: 'curated-rich',
    contentHash: 'sha256:content',
    revision: 7,
    cachedPipelinePath: join(dir, 'rich-run', 'pipeline.yaml'),
  };
  state.jobs.setup = {
    status: 'success',
    conclusion: 'success',
    outcome: 'success',
    started_at: '2026-01-02T00:00:01.000Z',
    completed_at: '2026-01-02T00:01:00.000Z',
    outputs: {},
    steps: {
      prepare: {
        status: 'success',
        conclusion: 'success',
        outcome: 'success',
        outputs: { secret: 'never crosses' },
        dynamic_env: { TOKEN: 'never crosses' },
        exit_code: 0,
        log_file: join(dir, 'rich-run', 'logs', 'setup--prepare.log'),
        agent_provider: 'claude',
        agent_harness: 'claude',
        agent_model: 'opus',
        report_outputs: {
          report_json_file: join(dir, 'rich-run', 'prepare.json'),
        },
      },
    },
  };
  state.job_groups.setup = {
    ...state.job_groups.setup,
    status: 'success',
    conclusion: 'success',
    started_at: '2026-01-02T00:00:01.000Z',
    completed_at: '2026-01-02T00:01:00.000Z',
  };
  const variants = ['build--linux', 'build--mac'];
  delete state.job_definitions.build;
  delete state.jobs.build;
  variants.forEach((physicalJobId, index) => {
    state.job_definitions[physicalJobId] = {
      ...buildDefinition,
      physical_job_id: physicalJobId,
      logical_job_id: 'build',
      name: `build (${index === 0 ? 'linux' : 'mac'})`,
      matrix: {
        index,
        total: 2,
        values: { os: index === 0 ? 'linux' : 'mac' },
      },
    };
    state.jobs[physicalJobId] = {
      status: index === 0 ? 'success' : 'failure',
      started_at: '2026-01-02T00:01:00.000Z',
      completed_at: '2026-01-02T00:10:00.000Z',
      outputs: {},
      retry_count: index,
      iteration_count: 1,
      steps: {
        compile: {
          status: index === 0 ? 'success' : 'failure',
          outputs: {},
          dynamic_env: {},
          exit_code: index,
          ...(index === 1 && { error: 'exit 1' }),
        },
      },
    };
  });
  state.job_groups.build = {
    job_id: 'build',
    kind: 'matrix',
    expansion: 'expanded',
    variant_job_ids: variants,
    status: 'failure',
    conclusion: 'failure',
    started_at: '2026-01-02T00:01:00.000Z',
    completed_at: '2026-01-02T00:10:00.000Z',
    resolved_max_parallel: 2,
  };
  return state;
}

describe('worker pipeline execution detail (CAN-6117)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'worker-pipeline-detail-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const)(
    'projects a v%s execution without losing anything the run views render',
    async (version) => {
      await writeFile(
        join(dir, `${EXECUTION_ID}.json`),
        JSON.stringify(legacyFixture(pausedState(dir), version)),
        'utf8',
      );
      const state = await loadExecutionState(EXECUTION_ID, dir);
      if (!state) throw new Error('Expected a loaded execution');

      const { execution, detail } = wire(state);

      expect(renderedFromWire(execution, detail)).toEqual(
        renderedFromState(state),
      );
      // The pause form can answer every checkpoint by its exact identity.
      expect(detail.pendingPauses.map((pause) => pause.id)).toEqual(
        state.pending_pauses.map((checkpoint) => checkpoint.id),
      );
      expect(execution.pendingPauseCount).toBe(detail.pendingPauses.length);
      // Host paths, diagnostics and auth attempts stay on the host.
      const serialized = JSON.stringify({ execution, detail });
      expect(serialized).not.toContain(dir);
      expect(serialized).not.toContain('Usage limit reached');
      expect(serialized).not.toContain('proxy-connection');
    },
  );

  it('projects a matrix run with its reports, plan, pin and initiation', () => {
    const state = richState(dir);
    const { execution, detail } = wire(state);

    expect(renderedFromWire(execution, detail)).toEqual(
      renderedFromState(state),
    );
    expect(execution).toMatchObject({
      runScope: 'worktree',
      definitionSource: 'inline',
      owner: 'org:123e4567-e89b-42d3-a456-426614174999',
      error: 'Build failed',
    });
    expect(detail.definition).toEqual({
      contentHash: 'sha256:content',
      revision: 7,
      packageDigest: null,
    });
    expect(detail.initiation).toEqual({
      source: 'hook',
      initiator: {
        kind: 'automation',
        automationId: 'automation-1',
        automationName: 'Nightly',
      },
      hook: {
        hookKey: 'hook-1',
        hookLabel: 'On PR',
        triggerName: 'pr:create',
        target: 'project',
        actionIndex: 0,
        triggeredAt: '2026-01-02T00:00:00.000Z',
      },
      event: 'plan_ready',
      rerunSourceId: 'earlier-run',
      parentStep: null,
    });
    expect(detail.artifacts).toEqual([
      { kind: 'report', jobId: null, stepId: null },
      { kind: 'report_json', jobId: 'setup', stepId: 'prepare' },
    ]);
    const [setup, build] = detail.jobs;
    expect(setup.variants[0].steps[0]).toEqual({
      stepId: 'prepare',
      name: 'Prepare',
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      startedAt: null,
      completedAt: null,
      exitCode: 0,
      error: null,
      recoveryCount: 0,
      childExecutionId: null,
      agent: { provider: 'claude', harness: 'claude', model: 'opus' },
    });
    expect(build.variants.map((variant) => variant.matrix)).toEqual([
      { os: 'linux' },
      { os: 'mac' },
    ]);
    expect(build.variants.map((variant) => variant.attempt)).toEqual([0, 1]);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain('never crosses');
    expect(serialized).not.toContain('host-only gate output');
  });

  it('keeps host paths out of run and step errors', () => {
    const state = richState(dir);
    state.error = 'spawn C:\\Users\\me\\bin\\tool.exe ENOENT';
    state.jobs['build--mac'].steps.compile.error =
      `ENOENT: no such file or directory, open '${join(dir, 'prompt.md')}'`;

    const { execution, detail } = wire(state);

    expect(execution.error).toBe('spawn <path> ENOENT');
    expect(detail.jobs[1].variants[1].steps[0].error).toBe(
      "ENOENT: no such file or directory, open '<path>'",
    );
    expect(JSON.stringify({ execution, detail })).not.toContain(dir);
  });

  it('carries a remote owner-loss pause as owner_lost (CAN-6102)', () => {
    const state = pausedState(dir);
    state.status_reasons = [
      {
        id: '123e4567-e89b-42d3-a456-426614174010',
        kind: 'owner_lost',
        code: 'owner_lost',
        detected_at: '2026-01-01T00:03:00.000Z',
        source: {
          job_id: 'ask',
          step_id: 'question',
          attempt: 0,
          iteration: 1,
        },
      },
    ];

    const { execution, detail } = wire(state);

    expect(execution.statusReasonKinds).toEqual(['owner_lost']);
    expect(detail.statusReasons).toEqual([
      {
        id: '123e4567-e89b-42d3-a456-426614174010',
        kind: 'owner_lost',
        code: 'owner_lost',
        detectedAt: '2026-01-01T00:03:00.000Z',
        source: { jobId: 'ask', stepId: 'question', attempt: 0, iteration: 1 },
      },
    ]);
  });

  it('drops matrix values the wire schema refuses and keeps the variant', () => {
    const state = richState(dir);
    const definition = state.job_definitions['build--mac'];
    if (!definition.matrix) throw new Error('Expected a matrix variant');
    // Small enough for the byte limit; longer than any JSON array may be.
    definition.matrix.values = {
      shards: Array.from({ length: 1001 }, () => 1),
    };

    const { detail } = wire(state);

    expect(
      detail.jobs[1].variants.map((variant) => [variant.jobId, variant.matrix]),
    ).toEqual([
      ['build--linux', { os: 'linux' }],
      ['build--mac', null],
    ]);
  });

  it('marks a pause request past the shared budget too large and keeps its identity', () => {
    const state = pausedState(dir);
    const [checkpoint] = state.pending_pauses;
    state.pending_pauses = [
      {
        ...checkpoint,
        request: {
          message: 'x'.repeat(300 * 1024),
          fields: checkpoint.request?.fields ?? [],
        },
      },
    ];

    const { detail } = wire(state);

    expect(detail.pendingPauses).toEqual([
      {
        id: checkpoint.id,
        kind: 'input',
        jobId: 'ask',
        logicalJobId: 'ask',
        stepId: 'question',
        attempt: 0,
        iteration: 1,
        detectedAt: '2026-01-01T00:01:00.000Z',
        requestUnavailableReason: 'too_large',
      },
    ]);
  });

  it('changes the revision exactly when the projection changes', () => {
    const state = pausedState(dir);
    const first = projectPipelineExecutionDetail(state).revision;

    expect(
      projectPipelineExecutionDetail(structuredClone(state)).revision,
    ).toBe(first);
    // Host-only fields don't reach the projection, so they don't move it.
    state.owner_pid = 4242;
    expect(projectPipelineExecutionDetail(state).revision).toBe(first);
    state.jobs.ask.steps.question.status = 'success';
    expect(projectPipelineExecutionDetail(state).revision).not.toBe(first);
  });
});

describe('worker pipeline execution list (CAN-6117)', () => {
  let dir: string;
  const context: CanopyHandlerContext = {
    requestId: 'list',
    caller: {
      principalId: 'client',
      clientInstanceId: 'client',
      authorityId: 'authority',
      interfaceKind: 'test',
      grants: ['worker.pipeline.read'],
    },
    metadata: {},
    signal: new AbortController().signal,
  };

  /** Only what list reads; the rest is never called. */
  function storeWorker(): PipelineExecutionWorker {
    const unused = (): never => {
      throw new Error('Not exercised.');
    };
    return {
      start: unused,
      control: unused,
      sweep: unused,
      checkpoint: unused,
      cancel: unused,
      observe: unused,
      get: async (executionId) => {
        const state = await loadExecutionState(executionId, dir);
        return state && projectPipelineExecution(state);
      },
      inspect: async (executionId) => {
        const state = await loadExecutionState(executionId, dir);
        return state && projectPipelineExecutionView(state, { detail: true });
      },
      list: async (query) =>
        listPipelineExecutionPage(
          await listExecutionSummaries(dir),
          (executionId) => loadExecutionState(executionId, dir),
          query,
        ),
    };
  }

  async function seed(
    id: string,
    startedAt: string,
    patch: Partial<ExecutionState>,
  ): Promise<void> {
    const state = createInitialState(
      normalizePipeline({
        name: id,
        on: 'dispatch',
        jobs: { only: { steps: [{ id: 'step', run: 'echo' }] } },
      }),
      { cwd: dir, pipelineId: 'pipeline-a', runtime: createRuntime(dir) },
      id,
    );
    await saveExecutionState(
      { ...state, started_at: startedAt, status: 'success', ...patch },
      dir,
    );
  }

  async function list(params: WorkerPipelineExecutionListParams): Promise<{
    executions: WorkerPipelineExecutionView[];
    nextCursor: string | null;
  }> {
    const handlers = createWorkerPipelineHandlers(storeWorker(), {
      secrets: refusingExecutionSecretSource,
    });
    return WorkerPipelineExecutionListResultSchema.parse(
      await handlers.queries['worker.pipeline.execution.list'](params, context),
    );
  }

  const ids = (result: {
    executions: WorkerPipelineExecutionView[];
  }): string[] => result.executions.map((view) => view.execution.executionId);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'worker-pipeline-list-'));
    await seed('global-run', '2026-01-05T00:00:00.000Z', {
      scope: 'global',
      execution_context: 'org:123e4567-e89b-42d3-a456-426614174999',
    });
    await seed('directory-run', '2026-01-04T00:00:00.000Z', {
      scope: 'directory',
    });
    await seed('worktree-b', '2026-01-03T00:00:00.000Z', {
      scope: 'worktree',
      project_id: 'workspace-a',
      worktree_id: 'worktree-b',
      status: 'failure',
    });
    // A Cowork or App Advisor run: directory scope that keeps its worktree.
    await seed('cowork-run', '2026-01-02T12:00:00.000Z', {
      scope: 'directory',
      project_id: 'workspace-a',
      worktree_id: 'worktree-a',
    });
    await seed('worktree-a2', '2026-01-02T00:00:00.000Z', {
      scope: 'worktree',
      project_id: 'workspace-a',
      worktree_id: 'worktree-a',
      pipeline_id: 'pipeline-b',
    });
    // Same start time: the id breaks the tie.
    await seed('worktree-a1', '2026-01-02T00:00:00.000Z', {
      scope: 'worktree',
      project_id: 'workspace-a',
      worktree_id: 'worktree-a',
    });
    // An older run that recorded no scope or owner.
    await seed('legacy', '2026-01-01T00:00:00.000Z', {});
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('pages every execution newest first, once each', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await list({ limit: 2, ...(cursor && { cursor }) });
      expect(result.executions.length).toBeLessThanOrEqual(2);
      expect(result.executions.every((view) => !view.detail)).toBe(true);
      seen.push(...ids(result));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual([
      'global-run',
      'directory-run',
      'worktree-b',
      'cowork-run',
      'worktree-a2',
      'worktree-a1',
      'legacy',
    ]);
  });

  it('filters by owner, workspace, worktree, pipeline, run scope and status', async () => {
    expect(
      ids(await list({ owner: 'org:123e4567-e89b-42d3-a456-426614174999' })),
    ).toEqual(['global-run']);
    // A run that recorded no owner is Personal.
    expect(ids(await list({ owner: 'personal' }))).toEqual([
      'directory-run',
      'worktree-b',
      'cowork-run',
      'worktree-a2',
      'worktree-a1',
      'legacy',
    ]);
    expect(ids(await list({ scope: { workspaceId: 'workspace-a' } }))).toEqual([
      'worktree-b',
      'cowork-run',
      'worktree-a2',
      'worktree-a1',
    ]);
    expect(
      ids(
        await list({
          scope: { workspaceId: 'workspace-a', worktreeId: 'worktree-a' },
        }),
      ),
    ).toEqual(['cowork-run', 'worktree-a2', 'worktree-a1']);
    expect(ids(await list({ pipelineId: 'pipeline-b' }))).toEqual([
      'worktree-a2',
    ]);
    // Only state tells a global run from a directory one, or a directory run
    // that keeps its worktree from a worktree run.
    expect(ids(await list({ runScopes: ['global'] }))).toEqual(['global-run']);
    expect(ids(await list({ runScopes: ['directory'] }))).toEqual([
      'directory-run',
      'cowork-run',
      'legacy',
    ]);
    expect(ids(await list({ runScopes: ['worktree'] }))).toEqual([
      'worktree-b',
      'worktree-a2',
      'worktree-a1',
    ]);
    expect(ids(await list({ statuses: ['failure'] }))).toEqual(['worktree-b']);
  });

  it('pages a run-scope filter that reads state without skipping a match', async () => {
    const first = await list({ runScopes: ['directory'], limit: 1 });
    expect(ids(first)).toEqual(['directory-run']);
    if (first.nextCursor === null) throw new Error('Expected another page');
    const second = await list({
      runScopes: ['directory'],
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(ids(second)).toEqual(['cowork-run']);
    if (second.nextCursor === null) throw new Error('Expected another page');
    const third = await list({
      runScopes: ['directory'],
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(ids(third)).toEqual(['legacy']);
    expect(third.nextCursor).toBeNull();
  });

  it('returns each detail when asked, as get does', async () => {
    const result = await list({
      detail: true,
      scope: { worktreeId: 'worktree-a', targetId: 'in_process_worker' },
    });
    const handlers = createWorkerPipelineHandlers(storeWorker(), {
      secrets: refusingExecutionSecretSource,
    });
    const got = await handlers.queries['worker.pipeline.execution.get'](
      { executionId: 'worktree-a1', detail: true },
      context,
    );
    expect(ids(result)).toEqual(['cowork-run', 'worktree-a2', 'worktree-a1']);
    expect(result.executions[2]).toEqual(got);
    expect(result.executions[2].detail?.jobs[0].variants[0].steps).toEqual([
      expect.objectContaining({ stepId: 'step', status: 'pending' }),
    ]);
  });

  it('refuses another target and a cursor it never issued', async () => {
    await expect(
      list({ scope: { targetId: 'cloud_sandbox_worker' } }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        code: 'worker.pipeline.targetUnavailable',
      },
    });
    await expect(list({ cursor: 'not-a-cursor' })).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'worker.pipeline.invalidCursor',
      },
    });
  });
});
