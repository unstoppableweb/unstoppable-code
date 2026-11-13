// CAN-5061 golden: pipeline execution behavior through desktop IPC, Portal
// commands and agent actions, captured on unchanged code before CAN-4140,
// CAN-4141 and CAN-4142 move execution behind core. Covers start, cancel,
// resume, retry, start-over, matrix retry and variant cancel, chaining,
// typed and global-run owner refusals, the shutdown checkpoint pause and the
// startup orphan sweep. Steps are real shell commands run by the real
// pipeline process host; only IPC registration, Electron's utility process
// (served in process, see ./harness.ts) and `fetch` are replaced. States are
// pinned through `projectExecution`. Re-record deliberately with
// `pnpm test apps/desktop-app/src/main/__tests__/pipeline-golden -u`
// and review the snapshot diff as a behavior change.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { OperationRecord } from '@canopy/protocol/canopy-core';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import { GOLDEN_INVALID_PIPELINE_YAML } from '@canopy/execution-engine/node/pipelines/__tests__/golden-fixtures';
import { getStoredPipelinePath } from '@canopy/execution-engine/pipelines/store';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import {
  dispatchAgentAction,
  forkGoldenUtilityProcess,
  goldenWorktreeActionRuntime,
  invokeIpc,
  registerGoldenIpcHandler,
  runPortalCommand,
  type GoldenIpcHandler,
} from './harness';
import {
  FLAKY_YAML,
  GLOBAL_YAML,
  MATRIX_PAUSE_YAML,
  MATRIX_YAML,
  PAUSE_YAML,
  projectExecution,
  SLOW_ONCE_YAML,
  SUCCESS_YAML,
  WORKFLOW_YAML,
  waitForExecution as waitForPersistedExecution,
  waitForRunningStep,
} from './executions';
import {
  createPipelineGoldenWorld,
  GOLDEN_CURATED_KEY,
  GOLDEN_CURATED_YAML,
  GOLDEN_SHARED_DISPATCH_REMOTE_ID,
  GOLDEN_WORKSPACE_ID,
  GOLDEN_WORKTREE_ID,
  type GoldenWorld,
} from './world';

const mockRegisterIpcHandler = (
  channel: string,
  handler: GoldenIpcHandler,
): void => registerGoldenIpcHandler(channel, handler);
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: GoldenIpcHandler): void =>
    mockRegisterIpcHandler(channel, handler),
}));
const mockForkUtilityProcess = (): unknown => forkGoldenUtilityProcess();
jest.mock('electron', () => ({
  ...jest.requireActual<object>('electron'),
  utilityProcess: { fork: (): unknown => mockForkUtilityProcess() },
}));

jest.setTimeout(180_000);

const ORG = 'org:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let world: GoldenWorld;
let runtime: DesktopCanopyDispatcher;
let executionsDir: string;
const pipelineIds: Record<string, string> = {};

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
  // Run admission reads definitions through the desktop dispatcher.
  runtime = createDesktopRuntime();
  setDesktopCanopyRuntime(runtime);
  mkdirSync(join(world.root, 'markers'), { recursive: true });
  for (const [name, yaml] of Object.entries({
    success: SUCCESS_YAML,
    flaky: FLAKY_YAML,
    pause: PAUSE_YAML,
    matrix: MATRIX_YAML,
    matrixPause: MATRIX_PAUSE_YAML,
    slowOnce: SLOW_ONCE_YAML,
    global: GLOBAL_YAML,
    workflow: WORKFLOW_YAML,
  }))
    pipelineIds[name] = await world.saveUserPipeline(yaml, `pipeline:${name}`);
  const handlers = await import('../../pipelines/pipeline-handlers');
  handlers.registerPipelineHandlers();
  handlers.registerExecutionHandlers(() => null);
  const { createElectronExecutionRuntime } =
    await import('../../pipelines/execution-runtime');
  executionsDir = createElectronExecutionRuntime().executionsDir;
});

afterAll(async () => {
  const { shutdownPipelineProcessHost } =
    await import('../../pipelines/process-host-runner');
  await shutdownPipelineProcessHost().catch(() => undefined);
  (
    await import('../../canopy-runtime/desktop-runtime-access')
  ).setDesktopCanopyRuntime(null);
  await runtime.shutdown();
  await world.dispose();
});

const marker = (name: string): string => join(world.root, 'markers', name);

/** Give an execution id a stable token in every later golden. */
function nameRun(executionId: string | undefined, name: string): void {
  if (!executionId) return;
  world.replacements.push({ value: executionId, token: `<run:${name}>` });
}

function isState(value: unknown): value is ExecutionState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pipeline_snapshot' in value &&
    'jobs' in value
  );
}

/** Project every execution state inside a caller's result. */
function projectStates(value: unknown): unknown {
  if (isState(value)) return projectExecution(value);
  if (Array.isArray(value)) return value.map(projectStates);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, projectStates(entry)]),
    );
  return value;
}

const HOST_FACT_KEY = /(^pid$|Pid$|_pid$|[dD]uration|_ms$|Ms$|elapsed)/;

/** Normalize, then blank host facts such as pids and durations. */
/**
 * A retried or rerun execution starts asynchronously, so its command response
 * projects the run at any point of its progress: pending, running or already
 * finished. Keep what identifies the started run; the settled projections pin
 * how it ended.
 */
function startedRun(response: unknown): unknown {
  const started = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(started);
    if (typeof entry !== 'object' || entry === null) return entry;
    return Object.fromEntries(
      Object.entries(entry).flatMap(([key, inner]): [string, unknown][] => {
        if (key === 'finishedAt' || key === 'outputTail') return [];
        if (key !== 'status') return [[key, started(inner)]];
        expect(['pending', 'running', 'success']).toContain(inner);
        return [[key, '<started>']];
      }),
    );
  };
  if (typeof response !== 'object' || response === null) return response;
  if (!('payload' in response)) return response;
  const { payload } = response;
  if (typeof payload !== 'object' || payload === null) return response;
  if (!('result' in payload)) return response;
  return {
    ...response,
    payload: { ...payload, result: started(payload.result) },
  };
}

function golden(value: unknown): unknown {
  const scrub = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(scrub);
    if (typeof entry === 'object' && entry !== null)
      return Object.fromEntries(
        Object.entries(entry).map(([key, inner]) => [
          key,
          HOST_FACT_KEY.test(key) && typeof inner === 'number'
            ? '<number>'
            : scrub(inner),
        ]),
      );
    return entry;
  };
  return scrub(world.normalize(projectStates(value)));
}

function executionIdOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ['data', 'result', 'execution', 'payload']) {
    const found = executionIdOf(record[key]);
    if (found) return found;
  }
  for (const key of ['executionId', 'id']) {
    const value = record[key];
    if (typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value))
      return value;
  }
  return undefined;
}

const worktreeTarget = (): Record<string, unknown> => ({
  cwd: world.worktreePath,
  projectId: GOLDEN_WORKSPACE_ID,
  worktreeId: GOLDEN_WORKTREE_ID,
  scope: 'worktree',
  target: {
    scope: 'worktree',
    workspace_id: GOLDEN_WORKSPACE_ID,
    worktree_id: GOLDEN_WORKTREE_ID,
    path: world.worktreePath,
    created: false,
  },
});

/** A global start and, when it started, its settled run. */
async function startGlobal(
  label: string,
  options: Record<string, unknown>,
): Promise<unknown> {
  const { result, executionId } = await start(label, () =>
    invokeIpc(PIPELINE_CHANNELS.EXECUTE, parsePipelineText(GLOBAL_YAML), {
      pipelineId: pipelineIds.global,
      scope: 'global',
      ...options,
    }),
  );
  return { result, settled: await settled(executionId) };
}

function executeIpc(
  name: keyof typeof pipelineIds,
  yaml: string,
  options: Record<string, unknown> = {},
): Promise<unknown> {
  return invokeIpc(PIPELINE_CHANNELS.EXECUTE, parsePipelineText(yaml), {
    pipelineId: pipelineIds[name],
    ...worktreeTarget(),
    ...options,
  });
}

async function start(
  label: string,
  run: () => Promise<unknown>,
): Promise<{ result: unknown; executionId: string | undefined }> {
  const result = await run();
  const executionId = executionIdOf(result);
  nameRun(executionId, label);
  return { result, executionId };
}

async function settled(executionId: string | undefined): Promise<unknown> {
  if (!executionId) return null;
  return projectExecution(await waitForExecution(executionsDir, executionId));
}

async function waitForExecution(
  directory: string,
  executionId: string,
  statuses?: readonly string[],
): Promise<ExecutionState> {
  const state = await waitForPersistedExecution(
    directory,
    executionId,
    statuses,
  );
  // The shutdown golden resets modules to simulate a relaunch. Resolve the
  // current registry so later tests still await the live handle's cleanup
  // before retrying an execution whose terminal state is already persisted.
  // Handles started before the reset stay in the old registry and are not
  // awaited; only the shutdown checkpoint's paused execution is left there.
  const { getActiveExecutionHandle } =
    await import('../../pipelines/pipeline-execution-registry');
  await getActiveExecutionHandle(executionId)
    ?.waitForCompletion()
    .catch(() => undefined);
  return state;
}

function pauseResponse(
  state: ExecutionState,
  answers: Record<string, boolean> | undefined,
): Record<string, unknown> {
  const pause = state.pending_pauses[0];
  return {
    checkpoint_id: pause?.id,
    job_id: pause?.job_id,
    step_id: pause?.step_id,
    ...(answers ? { answers } : {}),
  };
}

async function loadState(executionId: string): Promise<ExecutionState> {
  const state = await loadExecutionState(executionId, executionsDir);
  if (!state) throw new Error(`Missing execution ${executionId}`);
  return state;
}

describe('desktop IPC', () => {
  it('starts, gets and lists runs and refuses invalid starts', async () => {
    const success = await start('ipc-success', () =>
      executeIpc('success', SUCCESS_YAML, { inputs: { greeting: 'golden' } }),
    );
    const flaky = await start('ipc-flaky', () =>
      executeIpc('flaky', FLAKY_YAML, {
        inputs: { marker: marker('ipc-flaky') },
      }),
    );
    const results = {
      success: success.result,
      successSettled: await settled(success.executionId),
      failureSettled: await settled(flaky.executionId),
      get: await invokeIpc(
        PIPELINE_CHANNELS.GET_EXECUTION,
        success.executionId,
      ),
      getMissing: await invokeIpc(
        PIPELINE_CHANNELS.GET_EXECUTION,
        'missing-execution',
      ),
      list: await invokeIpc(PIPELINE_CHANNELS.LIST_EXECUTIONS),
      undeclaredInput: await executeIpc('success', SUCCESS_YAML, {
        inputs: { unknown: 'x' },
      }),
      missingRequiredInput: await executeIpc('flaky', FLAKY_YAML),
      globalWithWorktreeTarget: await executeIpc('success', SUCCESS_YAML, {
        scope: 'global',
      }),
      globalNotDeclared: await invokeIpc(
        PIPELINE_CHANNELS.EXECUTE,
        parsePipelineText(SUCCESS_YAML),
        { pipelineId: pipelineIds.success, scope: 'global' },
      ),
      globalPersonal: await startGlobal('ipc-global-personal', {}),
      globalForeignOrganization: await startGlobal('ipc-global-foreign', {
        requestedOwner: ORG,
      }),
      globalInvalidOwner: await startGlobal('ipc-global-invalid', {
        requestedOwner: 'nobody',
      }),
      globalWithTarget: await startGlobal('ipc-global-target', {
        ...worktreeTarget(),
        scope: 'global',
      }),
      ultraFast: await executeIpc('success', SUCCESS_YAML, {
        modelConfig: { fastMode: true, speed: 'ultra' },
      }),
    };
    expect(golden(results)).toMatchSnapshot();
  });

  it('retries, starts over, resumes and cancels', async () => {
    const flaky = await start('ipc-retry-source', () =>
      executeIpc('flaky', FLAKY_YAML, {
        inputs: { marker: marker('ipc-retry') },
      }),
    );
    const failed = await settled(flaky.executionId);
    const retry = await invokeIpc(
      PIPELINE_CHANNELS.RETRY_EXECUTION,
      flaky.executionId,
    );
    const retried = await settled(flaky.executionId);
    const retryFinished = await invokeIpc(
      PIPELINE_CHANNELS.RETRY_EXECUTION,
      flaky.executionId,
    );
    const rerun = await start('ipc-rerun', () =>
      invokeIpc(PIPELINE_CHANNELS.RERUN_EXECUTION, flaky.executionId),
    );
    const rerunSettled = await settled(rerun.executionId);

    const paused = await start('ipc-pause', () =>
      executeIpc('pause', PAUSE_YAML),
    );
    const pausedState = await waitForExecution(
      executionsDir,
      paused.executionId ?? '',
      ['paused'],
    );
    const resumeMissingAnswer = await invokeIpc(
      PIPELINE_CHANNELS.RESUME,
      paused.executionId,
      { pauseResponses: [pauseResponse(pausedState, undefined)] },
    );
    const resumeWrongCheckpoint = await invokeIpc(
      PIPELINE_CHANNELS.RESUME,
      paused.executionId,
      {
        pauseResponses: [
          {
            ...pauseResponse(pausedState, { approved: true }),
            checkpoint_id: 'nope',
          },
        ],
      },
    );
    const resume = await invokeIpc(
      PIPELINE_CHANNELS.RESUME,
      paused.executionId,
      { pauseResponses: [pauseResponse(pausedState, { approved: true })] },
    );
    const resumed = await settled(paused.executionId);
    const resumeFinished = await invokeIpc(
      PIPELINE_CHANNELS.RESUME,
      paused.executionId,
      {},
    );
    const cancelFinished = await invokeIpc(
      PIPELINE_CHANNELS.CANCEL_EXECUTION,
      paused.executionId,
    );

    const toCancel = await start('ipc-cancel-paused', () =>
      executeIpc('pause', PAUSE_YAML),
    );
    await waitForExecution(executionsDir, toCancel.executionId ?? '', [
      'paused',
    ]);
    const cancelPaused = await invokeIpc(
      PIPELINE_CHANNELS.CANCEL_EXECUTION,
      toCancel.executionId,
    );

    const running = await start('ipc-cancel-running', () =>
      executeIpc('slowOnce', SLOW_ONCE_YAML, {
        inputs: { marker: marker('ipc-cancel-running') },
      }),
    );
    await waitForRunningStep(
      executionsDir,
      running.executionId ?? '',
      'wait',
      'sleep',
    );
    const cancelRunning = await invokeIpc(
      PIPELINE_CHANNELS.CANCEL_EXECUTION,
      running.executionId,
    );
    const cancelledRunning = await settled(running.executionId);
    const resumeCancelled = await invokeIpc(
      PIPELINE_CHANNELS.RESUME,
      running.executionId,
      {},
    );
    const cancelMissing = await invokeIpc(
      PIPELINE_CHANNELS.CANCEL_EXECUTION,
      'missing-execution',
    );

    expect(
      golden({
        failed,
        retry,
        retried,
        retryFinished,
        rerun: rerun.result,
        rerunSettled,
        resumeMissingAnswer,
        resumeWrongCheckpoint,
        resume,
        resumed,
        resumeFinished,
        cancelFinished,
        cancelPaused,
        cancelRunning,
        cancelledRunning,
        resumeCancelled,
        cancelMissing,
      }),
    ).toMatchSnapshot();
  });

  it('retries a failed matrix variant and cancels a paused one', async () => {
    const matrix = await start('ipc-matrix', () =>
      executeIpc('matrix', MATRIX_YAML, {
        inputs: { marker: marker('ipc-matrix') },
      }),
    );
    const failed = await settled(matrix.executionId);
    const retryMissing = await invokeIpc(PIPELINE_CHANNELS.RETRY_MATRIX_JOB, {
      executionId: 'missing-execution',
      jobId: 'build',
      mode: 'failed',
    }).catch((error: unknown) => ({ thrown: String(error) }));
    const retryUnknownJob = await invokeIpc(
      PIPELINE_CHANNELS.RETRY_MATRIX_JOB,
      { executionId: matrix.executionId, jobId: 'nope', mode: 'failed' },
    ).catch((error: unknown) => ({ thrown: String(error) }));
    const retry = await invokeIpc(PIPELINE_CHANNELS.RETRY_MATRIX_JOB, {
      executionId: matrix.executionId,
      jobId: 'build',
      mode: 'failed',
    }).catch((error: unknown) => ({ thrown: String(error) }));
    const retried = await settled(matrix.executionId);

    const pausing = await start('ipc-matrix-pause', () =>
      executeIpc('matrixPause', MATRIX_PAUSE_YAML),
    );
    const paused = await waitForExecution(
      executionsDir,
      pausing.executionId ?? '',
      ['paused'],
    );
    const pausedVariant =
      Object.keys(paused.jobs).find(
        (jobId) => paused.jobs[jobId]?.status === 'paused',
      ) ?? '';
    const cancelVariant = await invokeIpc(
      PIPELINE_CHANNELS.CANCEL_MATRIX_VARIANT,
      {
        executionId: pausing.executionId,
        jobId: 'build',
        variantJobId: pausedVariant,
      },
    ).catch((error: unknown) => ({ thrown: String(error) }));
    const afterCancel = await settled(pausing.executionId);

    expect(
      golden({
        failed,
        retryMissing,
        retryUnknownJob,
        retry,
        retried,
        paused: projectExecution(paused),
        pausedVariant,
        cancelVariant,
        afterCancel,
      }),
    ).toMatchSnapshot();
  });

  it('pauses an orphaned run at startup and resumes it', async () => {
    const running = await start('ipc-orphan', () =>
      executeIpc('slowOnce', SLOW_ONCE_YAML, {
        inputs: { marker: marker('ipc-orphan') },
      }),
    );
    const id = running.executionId ?? '';
    await waitForRunningStep(executionsDir, id, 'wait', 'sleep');
    // The record a crash leaves: the mid-run state, owned by a process that
    // no longer exists.
    const statePath = join(executionsDir, `${id}.json`);
    const midRun = readFileSync(statePath, 'utf8');
    await invokeIpc(PIPELINE_CHANNELS.CANCEL_EXECUTION, id);
    await waitForExecution(executionsDir, id, ['cancelled']);
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const crashed: unknown = JSON.parse(midRun);
    writeFileSync(
      statePath,
      JSON.stringify({ ...(crashed as object), owner_pid: deadPid }),
    );
    const before = projectExecution(await loadState(id));
    // CAN-4141: the startup sweep runs through core and the local worker.
    const { sweepOrphanedPipelinesThroughLocalWorker } =
      await import('../../pipelines/pipeline-worker-dispatch');
    const sweepOwnLiveRun = await sweepOrphanedPipelinesThroughLocalWorker([
      'missing-execution',
    ]);
    const sweep = await sweepOrphanedPipelinesThroughLocalWorker([id]);
    const recovered = await loadState(id);
    const resume = await invokeIpc(PIPELINE_CHANNELS.RESUME, id, {
      statusReasonIds: recovered.status_reasons.map((reason) => reason.id),
    });
    const resumed = await settled(id);
    expect(
      golden({
        before,
        sweepOwnLiveRun,
        sweep,
        recovered: projectExecution(recovered),
        resume,
        resumed,
      }),
    ).toMatchSnapshot();
  });

  // The daemon's pipeline host records canonical paths, while main reads the
  // store through the data root it was given, which can be a symlink (CAN-5958).
  it('reads a step log named by realpath and refuses one a symlink takes outside', async () => {
    const logs = join(executionsDir, 'can-5958-probe', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'emit.log'), 'marker\n');
    const alias = `${executionsDir}-alias`;
    symlinkSync(executionsDir, alias);
    const outside = join(world.root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.log'), 'secret\n');
    const escape = join(world.root, 'escape');
    symlinkSync(outside, escape);

    await expect(
      invokeIpc(
        PIPELINE_CHANNELS.READ_STEP_LOG,
        join(alias, 'can-5958-probe', 'logs', 'emit.log'),
      ),
    ).resolves.toMatchObject({
      success: true,
      data: { lines: ['marker'] },
    });
    await expect(
      invokeIpc(PIPELINE_CHANNELS.READ_STEP_LOG, join(escape, 'secret.log')),
    ).resolves.toEqual({ success: false, error: 'Invalid log file path' });
  });
});

describe('Portal', () => {
  const run = (
    pipelineId: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ event: string; payload: unknown; updates: unknown[] }> =>
    runPortalCommand('portal.pipeline.run', {
      pipelineId,
      projectId: GOLDEN_WORKSPACE_ID,
      worktreeId: GOLDEN_WORKTREE_ID,
      ...payload,
    });
  const scoped = (
    executionId: string | undefined,
  ): Record<string, unknown> => ({
    executionId,
    projectId: GOLDEN_WORKSPACE_ID,
    worktreeId: GOLDEN_WORKTREE_ID,
  });

  it('runs, gets, lists, resumes, retries, starts over and cancels', async () => {
    const success = await start('portal-success', () =>
      run(pipelineIds.success, { inputs: { greeting: 'portal' } }),
    );
    const successSettled = await settled(success.executionId);
    const flaky = await start('portal-flaky', () =>
      run(pipelineIds.flaky, { inputs: { marker: marker('portal-flaky') } }),
    );
    await settled(flaky.executionId);
    const retry = await runPortalCommand(
      'portal.pipeline.retry',
      scoped(flaky.executionId),
    );
    const retried = await settled(flaky.executionId);
    const rerun = await start('portal-rerun', () =>
      runPortalCommand('portal.pipeline.rerun', scoped(success.executionId)),
    );
    const rerunSettled = await settled(rerun.executionId);

    const paused = await start('portal-pause', () => run(pipelineIds.pause));
    const pausedState = await waitForExecution(
      executionsDir,
      paused.executionId ?? '',
      ['paused'],
    );
    const pause = pausedState.pending_pauses[0];
    const resumeMissingAnswer = await runPortalCommand(
      'portal.pipeline.resume',
      {
        ...scoped(paused.executionId),
        pauseResponses: [
          {
            checkpointId: pause?.id,
            jobId: pause?.job_id,
            stepId: pause?.step_id,
          },
        ],
      },
    );
    const resume = await runPortalCommand('portal.pipeline.resume', {
      ...scoped(paused.executionId),
      pauseResponses: [
        {
          checkpointId: pause?.id,
          jobId: pause?.job_id,
          stepId: pause?.step_id,
          answers: { approved: true },
        },
      ],
    });
    const resumed = await settled(paused.executionId);

    const toCancel = await start('portal-cancel', () => run(pipelineIds.pause));
    await waitForExecution(executionsDir, toCancel.executionId ?? '', [
      'paused',
    ]);
    const cancel = await runPortalCommand(
      'portal.pipeline.cancel',
      scoped(toCancel.executionId),
    );

    expect(
      golden({
        success,
        successSettled,
        get: await runPortalCommand(
          'portal.pipeline.execution.get',
          scoped(success.executionId),
        ),
        list: await runPortalCommand('portal.pipeline.execution_list', {
          projectId: GOLDEN_WORKSPACE_ID,
          worktreeId: GOLDEN_WORKTREE_ID,
        }),
        retry: startedRun(retry),
        retried,
        rerun: startedRun(rerun.result),
        rerunSettled,
        resumeMissingAnswer,
        resume,
        resumed,
        cancel,
      }),
    ).toMatchSnapshot();
  });

  it('refuses invalid runs and foreign executions', async () => {
    expect(
      golden({
        missingPipeline: await run('missing-pipeline'),
        invalidLocator: await run('../escape'),
        missingTarget: await runPortalCommand('portal.pipeline.run', {
          pipelineId: pipelineIds.success,
        }),
        unknownWorktree: await run(pipelineIds.success, {
          worktreeId: 'missing-wt',
        }),
        undeclaredInput: await run(pipelineIds.success, {
          inputs: { unknown: 'x' },
        }),
        unsupportedEvent: await run(pipelineIds.success, {
          eventName: 'task_ready',
        }),
        ultraFast: await run(pipelineIds.success, {
          modelConfig: { speed: 'ultra' },
        }),
        getMissing: await runPortalCommand(
          'portal.pipeline.execution.get',
          scoped('missing-execution'),
        ),
        cancelOtherWorktree: await runPortalCommand('portal.pipeline.cancel', {
          ...scoped('missing-execution'),
          worktreeId: 'other-wt',
        }),
        retryMissing: await runPortalCommand(
          'portal.pipeline.retry',
          scoped('missing-execution'),
        ),
      }),
    ).toMatchSnapshot();
  });
});

describe('agent actions', () => {
  it('runs through pipeline.run and controls runs through legacy actions', async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    const dispatch = (action: Record<string, unknown>): Promise<unknown> =>
      dispatchAgentAction(action, runtime);

    const success = await start('agent-success', () =>
      dispatch({
        type: 'pipeline.run',
        pipelineId: pipelineIds.success,
        inputs: { greeting: 'agent' },
      }),
    );
    const successSettled = await settled(success.executionId);
    const flaky = await start('agent-flaky', () =>
      dispatch({
        type: 'pipeline.run',
        pipelineId: pipelineIds.flaky,
        inputs: { marker: marker('agent-flaky') },
      }),
    );
    await settled(flaky.executionId);
    const retry = await dispatch({
      type: 'pipeline.execution_retry',
      executionId: flaky.executionId,
    });
    const retried = await settled(flaky.executionId);

    const paused = await start('agent-pause', () =>
      dispatch({ type: 'pipeline.run', pipelineId: pipelineIds.pause }),
    );
    const pausedState = await waitForExecution(
      executionsDir,
      paused.executionId ?? '',
      ['paused'],
    );
    const pause = pausedState.pending_pauses[0];
    const resume = await dispatch({
      type: 'pipeline.execution_resume',
      executionId: paused.executionId,
      pauseResponses: [
        {
          checkpointId: pause?.id,
          jobId: pause?.job_id,
          stepId: pause?.step_id,
          answers: { approved: true },
        },
      ],
    });
    const resumed = await settled(paused.executionId);

    const toCancel = await start('agent-cancel', () =>
      dispatch({ type: 'pipeline.run', pipelineId: pipelineIds.pause }),
    );
    await waitForExecution(executionsDir, toCancel.executionId ?? '', [
      'paused',
    ]);
    const cancel = await dispatch({
      type: 'pipeline.execution_cancel',
      executionId: toCancel.executionId,
    });

    const matrix = await start('agent-matrix', () =>
      dispatch({
        type: 'pipeline.run',
        pipelineId: pipelineIds.matrix,
        inputs: { marker: marker('agent-matrix') },
      }),
    );
    await settled(matrix.executionId);
    const retryMatrix = await dispatch({
      type: 'pipeline.execution_retry_matrix_job',
      executionId: matrix.executionId,
      jobId: 'build',
      mode: 'failed',
    });
    const matrixRetried = await settled(matrix.executionId);

    const matrixPause = await start('agent-matrix-pause', () =>
      dispatch({ type: 'pipeline.run', pipelineId: pipelineIds.matrixPause }),
    );
    const matrixPaused = await waitForExecution(
      executionsDir,
      matrixPause.executionId ?? '',
      ['paused'],
    );
    const cancelVariant = await dispatch({
      type: 'pipeline.execution_cancel_matrix_variant',
      executionId: matrixPause.executionId,
      jobId: 'build',
      variantJobId:
        Object.keys(matrixPaused.jobs).find(
          (jobId) => matrixPaused.jobs[jobId]?.status === 'paused',
        ) ?? '',
    });

    expect(
      golden({
        success,
        successSettled,
        get: await dispatch({
          type: 'pipeline.execution_get',
          executionId: success.executionId,
        }),
        list: await dispatch({
          type: 'pipeline.execution_list_for_worktree',
          pipelineId: pipelineIds.success,
        }),
        retry,
        retried,
        resume,
        resumed,
        cancel,
        retryMatrix,
        matrixRetried,
        cancelVariant,
        chainWithoutPlan: await dispatch({
          type: 'pipeline.execution_chain',
          executionId: success.executionId,
          pipelineId: pipelineIds.success,
        }),
      }),
    ).toMatchSnapshot();
  });

  it('refuses invalid runs and unknown executions', async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    const dispatch = (action: Record<string, unknown>): Promise<unknown> =>
      dispatchAgentAction(action, runtime);
    expect(
      golden({
        missingPipeline: await dispatch({
          type: 'pipeline.run',
          pipelineId: 'missing-pipeline',
        }),
        missingRequiredInput: await dispatch({
          type: 'pipeline.run',
          pipelineId: pipelineIds.flaky,
        }),
        unsupportedRunMode: await dispatch({
          type: 'pipeline.run',
          pipelineId: pipelineIds.success,
          runMode: 'task_ready',
        }),
        planReadyWithoutPlan: await dispatch({
          type: 'pipeline.run',
          pipelineId: world.userPipelineId,
          runMode: 'plan_ready',
        }),
        globalNotDeclared: await dispatch({
          type: 'pipeline.run',
          pipelineId: pipelineIds.success,
          scope: 'global',
        }),
        globalWithInputs: await dispatch({
          type: 'pipeline.run',
          pipelineId: pipelineIds.global,
          scope: 'global',
          runMode: 'plan_ready',
        }),
        getMissing: await dispatch({
          type: 'pipeline.execution_get',
          executionId: 'missing-execution',
        }),
        cancelMissing: await dispatch({
          type: 'pipeline.execution_cancel',
          executionId: 'missing-execution',
        }),
        resumeMissing: await dispatch({
          type: 'pipeline.execution_resume',
          executionId: 'missing-execution',
        }),
        chainMissing: await dispatch({
          type: 'pipeline.execution_chain',
          executionId: 'missing-execution',
          pipelineId: pipelineIds.success,
        }),
      }),
    ).toMatchSnapshot();
  });
});

// The shutdown checkpoint closes admission. The simulated relaunch below
// gives the remaining goldens fresh main-process modules for later starts.
describe('desktop shutdown', () => {
  it('checkpoints running work at shutdown and resumes it', async () => {
    const running = await start('ipc-shutdown', () =>
      executeIpc('slowOnce', SLOW_ONCE_YAML, {
        inputs: { marker: marker('ipc-shutdown') },
      }),
    );
    await waitForRunningStep(
      executionsDir,
      running.executionId ?? '',
      'wait',
      'sleep',
    );
    // CAN-4141: the shutdown checkpoint runs through core and the local worker.
    const { checkpointPipelinesThroughLocalWorker } =
      await import('../../pipelines/pipeline-worker-dispatch');
    await checkpointPipelinesThroughLocalWorker();
    const checkpointed = await waitForExecution(
      executionsDir,
      running.executionId ?? '',
      ['paused'],
    );
    const resumeOptions = {
      statusReasonIds: checkpointed.status_reasons.map((reason) => reason.id),
    };
    const resumeDuringShutdown = await invokeIpc(
      PIPELINE_CHANNELS.RESUME,
      running.executionId,
      resumeOptions,
    );
    // A relaunch: fresh main-process modules, so nothing is draining.
    jest.resetModules();
    // The relaunched main composes its own dispatcher.
    const previous = runtime;
    runtime = (
      await import('../../canopy-runtime/desktop-runtime')
    ).createDesktopRuntime();
    (
      await import('../../canopy-runtime/desktop-runtime-access')
    ).setDesktopCanopyRuntime(runtime);
    await previous.shutdown();
    const relaunched = await import('../../pipelines/pipeline-handlers');
    relaunched.registerPipelineHandlers();
    relaunched.registerExecutionHandlers(() => null);
    const resume = await invokeIpc(
      PIPELINE_CHANNELS.RESUME,
      running.executionId,
      resumeOptions,
    );
    const resumed = await settled(running.executionId);
    expect(
      golden({
        checkpointed: projectExecution(checkpointed),
        resumeDuringShutdown,
        resume,
        resumed,
      }),
    ).toMatchSnapshot();
  });
});

// CAN-4140: each run is a core operation that follows its execution across
// the pause and the resume's new handle.
describe('core run records', () => {
  const waitFor = async (
    executionId: string | undefined,
    check: () => Promise<boolean>,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Tell a slow run record from one left behind its settled execution.
    const runs = await runRecords(executionId)
      .then((items) =>
        items.map(({ status, revision, updatedAt }) => ({
          status,
          revision,
          updatedAt,
        })),
      )
      .catch((error: unknown) => String(error));
    const execution = await loadExecutionState(executionId ?? '', executionsDir)
      .then((state) =>
        state === null
          ? 'missing'
          : { status: state.status, completedAt: state.completed_at },
      )
      .catch((error: unknown) => String(error));
    throw new Error(
      `The run record never reached the expected status. Runs: ${JSON.stringify(
        runs,
      )}; execution: ${JSON.stringify(execution)}`,
    );
  };
  const runRecords = async (
    executionId: string | undefined,
  ): Promise<OperationRecord[]> => {
    const { items } = await runtime.query(
      'core.operation.list',
      {
        kinds: ['core.pipeline.run'],
        scope: { executionId: executionId ?? '' },
      },
      {
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: 'golden',
          authorityId: 'local-desktop',
          interfaceKind: 'test',
          grants: ['core.operation.read'],
        },
      },
    );
    return items;
  };
  const runStatuses = async (
    executionId: string | undefined,
  ): Promise<string[]> =>
    (await runRecords(executionId)).map((item) => item.status);
  const runRecord = async (
    executionId: string | undefined,
  ): Promise<string | undefined> => (await runRecords(executionId))[0]?.status;

  it('pauses, resumes and finishes the run with its execution', async () => {
    const run = await start('record-pause', () =>
      executeIpc('pause', PAUSE_YAML),
    );
    const pausedState = await waitForExecution(
      executionsDir,
      run.executionId ?? '',
      ['paused'],
    );
    await waitFor(
      run.executionId,
      async () => (await runRecord(run.executionId)) === 'paused',
    );
    await invokeIpc(PIPELINE_CHANNELS.RESUME, run.executionId, {
      pauseResponses: [pauseResponse(pausedState, { approved: true })],
    });
    await settled(run.executionId);
    await waitFor(
      run.executionId,
      async () => (await runRecord(run.executionId)) === 'completed',
    );
    // The resume ran under the run it resumed.
    expect(await runStatuses(run.executionId)).toEqual(['completed']);
  });

  // CAN-4141: a startup scan may find more executions than one sweep takes.
  it('sweeps a large startup scan in recorded batches', async () => {
    const recoveries = async (): Promise<number> =>
      (
        await runtime.query(
          'core.operation.list',
          { kinds: ['core.pipeline.recovery'] },
          {
            caller: {
              principalId: 'local-desktop-user',
              clientInstanceId: 'golden',
              authorityId: 'local-desktop',
              interfaceKind: 'test',
              grants: ['core.operation.read'],
            },
          },
        )
      ).items.length;
    const before = await recoveries();
    const { sweepOrphanedPipelinesThroughLocalWorker } =
      await import('../../pipelines/pipeline-worker-dispatch');
    const ids = Array.from(
      { length: 10_001 },
      (_unused, index) => `missing-${index}`,
    );
    await expect(
      sweepOrphanedPipelinesThroughLocalWorker(ids),
    ).resolves.toEqual([]);
    expect((await recoveries()) - before).toBe(2);
  });

  // CAN-4141: recovery controls are recorded as runs of the executions they
  // run; one that runs nothing finishes with its outcome.
  it('records retries, start overs and stale resumes as runs', async () => {
    const flaky = await start('record-retry', () =>
      executeIpc('flaky', FLAKY_YAML, {
        inputs: { marker: marker('record-retry') },
      }),
    );
    await settled(flaky.executionId);
    await waitFor(
      flaky.executionId,
      async () => (await runRecord(flaky.executionId)) === 'failed',
    );
    await expect(
      invokeIpc(PIPELINE_CHANNELS.RETRY_EXECUTION, flaky.executionId),
    ).resolves.toMatchObject({ success: true });
    await settled(flaky.executionId);
    await waitFor(
      flaky.executionId,
      async () =>
        (await runStatuses(flaky.executionId)).join() === 'completed,failed',
    );
    const rerun = await start('record-rerun', () =>
      invokeIpc(PIPELINE_CHANNELS.RERUN_EXECUTION, flaky.executionId),
    );
    expect(rerun.result).toMatchObject({ success: true });
    await settled(rerun.executionId);
    await waitFor(
      rerun.executionId,
      async () => (await runStatuses(rerun.executionId)).join() === 'completed',
    );
    await invokeIpc(PIPELINE_CHANNELS.RESUME, flaky.executionId, {
      statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
    });
    expect(await runStatuses(flaky.executionId)).toHaveLength(3);
  });
});

// CAN-4139: a stored run executes the definition core validates, never the
// copy its caller sent.
describe('run admission', () => {
  it('runs the stored definition rather than the caller copy', async () => {
    const sent = parsePipelineText(SUCCESS_YAML);
    const run = await start('admission-stored', () =>
      invokeIpc(
        PIPELINE_CHANNELS.EXECUTE,
        { ...sent, name: 'Caller copy' },
        { pipelineId: pipelineIds.success, ...worktreeTarget() },
      ),
    );
    const state = await waitForExecution(executionsDir, run.executionId ?? '');
    expect(state.pipeline_snapshot.name).toBe(sent.name);
  });

  it('admits a stored run whose caller names a file it did not send', async () => {
    const sent = parsePipelineText(SUCCESS_YAML);
    const run = await start('admission-file-locator', () =>
      invokeIpc(
        PIPELINE_CHANNELS.EXECUTE,
        { ...sent, name: 'Caller copy' },
        {
          pipelineId: pipelineIds.success,
          pipelinePreferenceLocator: { type: 'file', value: '/elsewhere.yaml' },
          ...worktreeTarget(),
        },
      ),
    );
    const state = await waitForExecution(executionsDir, run.executionId ?? '');
    expect(state.pipeline_snapshot.name).toBe(sent.name);
  });

  it('admits a stored run whose caller sends a stray shared locator', async () => {
    const sent = parsePipelineText(SUCCESS_YAML);
    const run = await start('admission-shared-locator', () =>
      invokeIpc(
        PIPELINE_CHANNELS.EXECUTE,
        { ...sent, name: 'Caller copy' },
        {
          pipelineId: pipelineIds.success,
          pipelinePreferenceLocator: { type: 'shared', value: 'x:y' },
          ...worktreeTarget(),
        },
      ),
    );
    const state = await waitForExecution(executionsDir, run.executionId ?? '');
    expect(state.pipeline_snapshot.name).toBe(sent.name);
  });

  it('refuses a stored definition that no longer validates', async () => {
    const id = await world.saveUserPipeline(SUCCESS_YAML, 'pipeline:broken');
    const file = getStoredPipelinePath(id).data ?? '';
    writeFileSync(file, GOLDEN_INVALID_PIPELINE_YAML);
    expect(
      await invokeIpc(
        PIPELINE_CHANNELS.EXECUTE,
        parsePipelineText(SUCCESS_YAML),
        { pipelineId: id, ...worktreeTarget() },
      ),
    ).toEqual({
      success: false,
      error: 'Unknown job dependency "missing"',
    });
  });
});

// CAN-5076: curated and shared runs, captured before they resolve through
// core definition ownership. Each executes its catalog revision or share,
// never the caller's copy.
describe('curated and shared runs', () => {
  const curatedHash = createHash('sha256')
    .update(GOLDEN_CURATED_YAML)
    .digest('hex');
  const callerCopy = {
    ...parsePipelineText(SUCCESS_YAML),
    name: 'Caller copy',
  };
  const curated = (
    options: Record<string, unknown>,
    label: string,
  ): Promise<unknown> =>
    (async (): Promise<unknown> => {
      const { result, executionId } = await start(label, () =>
        invokeIpc(PIPELINE_CHANNELS.EXECUTE, callerCopy, {
          ...worktreeTarget(),
          ...options,
        }),
      );
      return golden({ result, settled: await settled(executionId) });
    })();

  it('runs the reviewed curated revision and refuses a changed or missing one', async () => {
    expect({
      byId: await curated(
        { pipelineId: `curated:${GOLDEN_CURATED_KEY}` },
        'curated-by-id',
      ),
      byLocator: await curated(
        {
          pipelineId: `curated:${GOLDEN_CURATED_KEY}`,
          pipelinePreferenceLocator: {
            type: 'stored',
            source: 'curated',
            value: `curated:${GOLDEN_CURATED_KEY}`,
            contentHash: curatedHash,
          },
        },
        'curated-by-locator',
      ),
      changed: await curated(
        {
          pipelineId: `curated:${GOLDEN_CURATED_KEY}`,
          pipelinePreferenceLocator: {
            type: 'stored',
            source: 'curated',
            value: `curated:${GOLDEN_CURATED_KEY}`,
            contentHash: '0'.repeat(64),
          },
        },
        'curated-changed',
      ),
      missing: await curated(
        { pipelineId: 'curated:missing-curated' },
        'curated-missing',
      ),
      planReady: await curated(
        {
          pipelineId: `curated:${GOLDEN_CURATED_KEY}`,
          eventName: 'plan_ready',
        },
        'curated-plan-ready',
      ),
    }).toMatchSnapshot();
  });

  it('runs the share rather than the caller copy and refuses a missing one', async () => {
    const shared = (remoteId: string, label: string): Promise<unknown> =>
      curated(
        {
          pipelineId: `shared:canopy-cloud:${remoteId}`,
          sharedPipeline: { serverId: 'canopy-cloud', remoteId },
        },
        label,
      );
    expect({
      share: await shared(GOLDEN_SHARED_DISPATCH_REMOTE_ID, 'shared-run'),
      missing: await shared('shared-missing', 'shared-missing'),
    }).toMatchSnapshot();
  });
});

it('refuses queued workflow IPC cancellation while startup authorization is pending', async () => {
  const queue = await import('../../lib/hook-pipeline');
  const registry = await import('../../pipelines/pipeline-execution-registry');
  const authorization =
    await import('../../services/background-execution-context');
  let releaseAuthorization: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseAuthorization = resolve;
  });
  let enteredAuthorization: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enteredAuthorization = resolve;
  });
  const authorize = jest
    .spyOn(authorization, 'authorizeBackgroundExecution')
    .mockImplementation(async () => {
      enteredAuthorization();
      await held;
      return { allow: true };
    });
  const blocker = 'queued-hook-ipc-authorization-blocker';
  registry.reserveExecution(blocker);
  let executionId: string | undefined;
  try {
    const submitted = await runtime.initiatedWork.submit({
      origin: { kind: 'hook', sourceId: 'project:pr:create' },
      owner: { kind: 'principal', id: 'local' },
      scope: {
        workspaceId: GOLDEN_WORKSPACE_ID,
        worktreeId: GOLDEN_WORKTREE_ID,
      },
      targetKey: 'queued-hook-ipc-authorization',
      gates: [],
      execute: async (control) => ({
        value: await queue.launchHookPipeline({
          identity: { operationId: control.operationId, actionIndex: 0 },
          action: {
            type: 'pipeline',
            source: 'local',
            id: pipelineIds.success ?? '',
          },
          cwd: world.worktreePath,
          projectId: GOLDEN_WORKSPACE_ID,
          worktreeId: GOLDEN_WORKTREE_ID,
          env: {},
          triggerSource: {
            kind: 'hook',
            hook_key: 'project:pr:create',
            hook_label: 'Review',
            trigger_name: 'pr:create',
            target: 'project',
            action_index: 0,
            triggered_at: '2026-11-05T00:00:00Z',
          },
          getWindow: () => null,
        }),
        result: { status: 'succeeded', exitCode: 0, durationMs: 0 },
      }),
    });
    if (submitted.disposition !== 'ran' || submitted.value.status !== 'queued')
      throw new Error('Hook workflow was not queued');
    const { queueId } = submitted.value;
    executionId = queue
      .listQueuedHookPipelines()
      .find((entry) => entry.queueId === queueId)?.executionId;
    if (!executionId) throw new Error('Queued execution id missing');
    registry.releaseExecutionReservation(blocker);
    await entered;
    expect(registry.isExecutionReservedBy(executionId, 'pipeline-start')).toBe(
      true,
    );
    const response = await invokeIpc(
      PIPELINE_CHANNELS.CANCEL_QUEUED_EXECUTION,
      queueId,
    );
    releaseAuthorization();
    await waitForExecution(executionsDir, executionId, ['success']);
    expect(response).toEqual({
      success: false,
      error: 'Error: This workflow already started; stop the run itself.',
    });
    expect(
      await invokeIpc(PIPELINE_CHANNELS.CANCEL_QUEUED_EXECUTION, queueId),
    ).toEqual({ success: true });
  } finally {
    releaseAuthorization();
    registry.releaseExecutionReservation(blocker);
    authorize.mockRestore();
  }
});

it('refuses a queued workflow IPC cancellation during startup and keeps absent cancellation idempotent', async () => {
  const queue = await import('../../lib/hook-pipeline');
  const registry = await import('../../pipelines/pipeline-execution-registry');
  const executionId = 'queued-hook-ipc-start';
  const queueId = 'queued-pipeline-ipc-start';
  const queued: ReturnType<typeof queue.listQueuedHookPipelines>[number] = {
    queueId,
    executionId,
    projectId: GOLDEN_WORKSPACE_ID,
    worktreeId: GOLDEN_WORKTREE_ID,
    pipelineId: pipelineIds.success ?? 'success',
    pipelineName: 'Queued workflow',
    reason: 'pipeline-concurrency',
    reasonLabel: 'Waiting for active pipeline runs to finish',
    enqueuedAt: '2026-11-05T00:00:00Z',
    trigger_source: {
      kind: 'hook',
      hook_key: 'project:pr:create',
      hook_label: 'Review',
      trigger_name: 'pr:create',
      target: 'project',
      action_index: 0,
      triggered_at: '2026-11-05T00:00:00Z',
    },
  };
  const list = jest
    .spyOn(queue, 'listQueuedHookPipelines')
    .mockReturnValue([queued]);
  const cancel = jest
    .spyOn(queue, 'cancelQueuedHookPipeline')
    .mockResolvedValue(false);
  registry.reserveExecution(executionId);
  try {
    expect(registry.isExecutionReservedBy(executionId, 'pipeline-start')).toBe(
      true,
    );
    expect(
      await invokeIpc(PIPELINE_CHANNELS.CANCEL_QUEUED_EXECUTION, queueId),
    ).toEqual({
      success: false,
      error: 'Error: This workflow already started; stop the run itself.',
    });
    list.mockReturnValue([]);
    expect(
      await invokeIpc(PIPELINE_CHANNELS.CANCEL_QUEUED_EXECUTION, queueId),
    ).toEqual({ success: true });
    list.mockReturnValue([queued]);
    cancel.mockResolvedValue(true);
    expect(
      await invokeIpc(PIPELINE_CHANNELS.CANCEL_QUEUED_EXECUTION, queueId),
    ).toEqual({ success: true });
  } finally {
    registry.releaseExecutionReservation(executionId);
    list.mockRestore();
    cancel.mockRestore();
  }
});

describe('workflow trigger (CAN-5782)', () => {
  it('runs a workflow pipeline as workflow and starts it nowhere else', async () => {
    const run = await start('ipc-workflow', () =>
      executeIpc('workflow', WORKFLOW_YAML, {
        eventName: 'workflow',
        inputs: { greeting: 'golden' },
      }),
    );
    expect(
      golden({
        run: run.result,
        settled: await settled(run.executionId),
        portalWithoutEvent: await runPortalCommand('portal.pipeline.run', {
          pipelineId: pipelineIds.workflow,
          projectId: GOLDEN_WORKSPACE_ID,
          worktreeId: GOLDEN_WORKTREE_ID,
        }),
        agentRun: await dispatchAgentAction(
          { type: 'pipeline.run', pipelineId: pipelineIds.workflow },
          goldenWorktreeActionRuntime(world.worktreePath),
        ),
      }),
    ).toMatchSnapshot();
  });
});
