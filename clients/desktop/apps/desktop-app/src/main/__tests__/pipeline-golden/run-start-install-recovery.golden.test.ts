// CAN-7308 golden: a run never starts against a workflow whose interrupted
// update is still being undone. It drives the real desktop IPC, the real
// install intents and real shell steps in the CAN-5061 pipeline world. Each
// case leaves a real interrupted install (a `replaced` definition whose new
// document was written, then never finished), relaunches main with fresh
// modules, and holds that install's rollback on its final record removal.
// It asserts what a person or caller sees: whether a run started, what its
// step wrote, the start result and the automation run's recorded outcome.
// The CAN-7359 cases hold an install of this process before it finishes
// instead: a run of what it installs waits for it, up to 5 minutes.
import { randomUUID } from 'node:crypto';
import { windowAgentInterfacePort } from '../../agents/agent-interface-port';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { hashPipelinePackageYaml } from '@canopy/execution-engine/node/pipelines/package-contract';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { DesktopCanopyDispatcher } from '../../canopy-runtime/desktop-runtime';
import {
  forkGoldenUtilityProcess,
  invokeIpc,
  registerGoldenIpcHandler,
  type GoldenIpcHandler,
} from './harness';
import { waitForExecution } from './executions';
import {
  createPipelineGoldenWorld,
  GOLDEN_AUTOMATION_ENTRY_KEY,
  GOLDEN_AUTOMATION_REVISED_NOTES,
  GOLDEN_AUTOMATION_SHARE_ID,
  GOLDEN_AUTOMATION_WORKER_KEY,
  GOLDEN_WORKSPACE_ID,
  GOLDEN_WORKTREE_ID,
  type GoldenAutomationPackage,
  type GoldenWorld,
} from './world';

interface HeldRemoval {
  release: () => void;
  fail: (error: Error) => void;
}

const mockHold: {
  intentsDir: string;
  mode: 'off' | 'hold' | 'fail';
  held: HeldRemoval | null;
} = { intentsDir: '', mode: 'off', held: null };

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>): Promise<void> => {
      const target = String(args[0]);
      const isRecord =
        mockHold.intentsDir !== '' &&
        dirname(target) === mockHold.intentsDir &&
        target.endsWith('.json');
      if (!isRecord || mockHold.mode === 'off') return actual.rm(...args);
      if (mockHold.mode === 'fail') {
        mockHold.mode = 'off';
        return Promise.reject(
          Object.assign(new Error('EACCES: permission denied'), {
            code: 'EACCES',
          }),
        );
      }
      mockHold.mode = 'off';
      return new Promise<void>((resolve, reject) => {
        mockHold.held = {
          release: (): void => {
            actual.rm(...args).then(resolve, reject);
          },
          fail: (error): void => reject(error),
        };
      });
    },
  };
});
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

const BOUND_MS = 60_000;
const RESTORING =
  "An update to this workflow didn't finish and is still being undone. Try again in a moment.";
const UNCONFIRMED =
  "An update to this workflow didn't finish and couldn't be undone. Restart the app to try again.";
const REMOVED = 'Workflow not found.';
const REMOVED_REFUSAL = {
  success: false,
  error: REMOVED,
  errorCode: 'pipeline_definition_removed',
};
const LIVE_BOUND_MS = 300_000;
const INSTALLING =
  "Couldn't start this workflow because it's still being installed. Try again once the install finishes.";
const LIVE_WAIT_LOG =
  '[pipeline-install] A run is waiting for an install of its workflow to finish';

function versionYaml(name: string, text: string): string {
  return [
    'pipeline:',
    `  name: ${name}`,
    '  on:',
    '    dispatch:',
    '      inputs:',
    '        marker:',
    '          type: string',
    '          required: true',
    '  jobs:',
    '    write:',
    '      name: Write',
    '      steps:',
    '        - id: version',
    `          run: printf ${text} > "$MARKER"`,
    '          env:',
    '            MARKER: ${{ inputs.marker }}',
    '',
  ].join('\n');
}

const TARGET_V1 = versionYaml('Golden install target', 'v1');
const TARGET_V2 = versionYaml('Golden install target', 'v2');
const OTHER = versionYaml('Golden other workflow', 'other');
const CREATED = versionYaml('Golden created workflow', 'created');

let world: GoldenWorld;
let runtime: DesktopCanopyDispatcher;
let executionsDir: string;
let targetId: string;
let otherId: string;
let markerCount = 0;

async function composeMain(): Promise<void> {
  runtime = (
    await import('../../canopy-runtime/desktop-runtime')
  ).createDesktopRuntime();
  (
    await import('../../canopy-runtime/desktop-runtime-access')
  ).setDesktopCanopyRuntime(runtime);
  const handlers = await import('../../pipelines/pipeline-handlers');
  handlers.registerPipelineHandlers();
  handlers.registerExecutionHandlers(() => null);
}

/** A fresh main process over the same data, as after a quit and relaunch. */
async function relaunch(): Promise<void> {
  const { shutdownPipelineProcessHost } =
    await import('../../pipelines/process-host-runner');
  await shutdownPipelineProcessHost().catch(() => undefined);
  const previous = runtime;
  jest.resetModules();
  await composeMain();
  await previous.shutdown();
}

/**
 * An update of the target that wrote its new document and then never
 * finished, as when the app exits mid-install; then a relaunch.
 */
async function interruptTargetUpdate(): Promise<void> {
  const intents = await import('../../pipelines/pipeline-install-intents');
  const intent = await intents.beginPipelineInstallIntent('shared');
  await intent.noteDefinition({
    definitionId: targetId,
    change: 'replaced',
    contentHash: hashPipelinePackageYaml(TARGET_V2),
  });
  const { writeStoredPipeline } =
    await import('@canopy/execution-engine/pipelines/store');
  const written = writeStoredPipeline(
    {
      id: targetId,
      name: 'Golden install target',
      description: '',
      icon: '',
      content: parsePipelineText(TARGET_V2),
      rawContent: TARGET_V2,
    },
    { requireExisting: true },
  );
  if (!written.ok) throw new Error(written.message);
  await relaunch();
}

/**
 * An install that added a new workflow, wrote its document and then never
 * finished; `beforeExit` runs before the relaunch. The rollback removes the
 * workflow.
 */
async function interruptCreatingInstall(
  id: string,
  beforeExit: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  const intents = await import('../../pipelines/pipeline-install-intents');
  const intent = await intents.beginPipelineInstallIntent('shared');
  await intent.noteDefinition({
    definitionId: id,
    change: 'created',
    contentHash: hashPipelinePackageYaml(CREATED),
  });
  // As the automation package install saves a workflow it adds.
  const { savePipeline } = await import('../../pipelines/pipeline-service');
  const saved = savePipeline(
    {
      name: 'Golden created workflow',
      description: '',
      icon: '',
      content: parsePipelineText(CREATED),
      rawContent: CREATED,
    },
    { id },
  );
  if (!saved.success) throw new Error(saved.error);
  await beforeExit();
  await relaunch();
}

let deletableCount = 0;

/** A saved user workflow a case deletes, with the copy a caller keeps. */
async function saveDeletable(): Promise<{ id: string; yaml: string }> {
  deletableCount += 1;
  const yaml = versionYaml(`Golden deletable ${deletableCount}`, 'deletable');
  const id = await world.saveUserPipeline(
    yaml,
    `pipeline:deletable-${deletableCount}`,
  );
  return { id, yaml };
}

/** Deletes a workflow the way the person does, from the Workflows page. */
async function deleteWorkflow(id: string): Promise<void> {
  await expect(invokeIpc(PIPELINE_CHANNELS.DELETE, id)).resolves.toEqual({
    success: true,
  });
}

/**
 * Deletes the workflow after its caller has read it and just before the
 * start, as a delete can land between the two.
 */
async function deletedBeforeStart(id: string): Promise<() => void> {
  const handlers = await import('../../pipelines/pipeline-handlers');
  const start = handlers.startPipelineExecutionFromMain;
  const spy = jest
    .spyOn(handlers, 'startPipelineExecutionFromMain')
    .mockImplementationOnce(async (args) => {
      await deleteWorkflow(id);
      return start(args);
    });
  return () => spy.mockRestore();
}

/** Fires a hook that runs `pipelineId`; its outcome, as the queue sees it. */
async function launchHook(pipelineId: string, marker: string): Promise<string> {
  const queue = await import('../../lib/hook-pipeline');
  return runtime.initiatedWork
    .submit({
      origin: { kind: 'hook', sourceId: 'project:pr:create' },
      owner: { kind: 'principal', id: 'local' },
      scope: {
        workspaceId: GOLDEN_WORKSPACE_ID,
        worktreeId: GOLDEN_WORKTREE_ID,
      },
      targetKey: `can-7347-hook-${markerCount}`,
      gates: [],
      execute: async (control) => ({
        value: await queue.launchHookPipeline({
          identity: { operationId: control.operationId, actionIndex: 0 },
          action: {
            type: 'pipeline',
            source: 'local',
            id: pipelineId,
            inputs: { marker },
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
            triggered_at: '2026-11-19T00:00:00Z',
          },
          getWindow: () => null,
        }),
        result: { status: 'succeeded', exitCode: 0, durationMs: 0 },
      }),
    })
    .then(
      (value: unknown) => JSON.stringify(value),
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
}

function newMarker(): string {
  markerCount += 1;
  return join(world.root, 'markers', `marker-${markerCount}`);
}

function startRun(
  pipelineId: string,
  yaml: string,
  marker: string,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  return invokeIpc(PIPELINE_CHANNELS.EXECUTE, parsePipelineText(yaml), {
    ...extra,
    pipelineId,
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
    inputs: { marker },
  });
}

interface Tracked<T> {
  settled: () => boolean;
  promise: Promise<T>;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  let done = false;
  const settle = (): void => {
    done = true;
  };
  promise.then(settle, settle);
  return { settled: () => done, promise };
}

function executionIdOf(result: unknown): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'data' in result &&
    typeof result.data === 'object' &&
    result.data !== null &&
    'id' in result.data &&
    typeof result.data.id === 'string'
  )
    return result.data.id;
  throw new Error(`The run did not start: ${JSON.stringify(result)}`);
}

async function ranAndWrote(result: unknown, marker: string): Promise<string> {
  await waitForExecution(executionsDir, executionIdOf(result));
  return readFileSync(marker, 'utf8');
}

/** Distinct executions on disk; a run's later files don't count again. */
function recordedRuns(): number {
  if (!existsSync(executionsDir)) return 0;
  const ids = new Set<string>();
  for (const name of readdirSync(executionsDir)) {
    const id = /^[0-9a-f-]{36}/.exec(name)?.[0];
    if (id) ids.add(id);
  }
  return ids.size;
}

async function elapse(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

/**
 * Waits, through real I/O turns, until the rollback reaches its held record
 * removal. Fake timers don't move file I/O, so a bound elapsed before then
 * would measure nothing.
 */
async function untilRollbackHeld(): Promise<void> {
  for (let turn = 0; turn < 200_000; turn += 1) {
    if (mockHold.held) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('The rollback never reached its record removal');
}

function useFakeTimers(): void {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
}

/** Lets the held rollback finish, with real timers for the run it frees. */
function releaseRollback(): void {
  jest.useRealTimers();
  mockHold.held?.release();
  mockHold.held = null;
}

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
  mockHold.intentsDir = join(world.dataDir, 'pipeline-install-intents');
  mkdirSync(join(world.root, 'markers'), { recursive: true });
  targetId = await world.saveUserPipeline(TARGET_V1, 'pipeline:target');
  otherId = await world.saveUserPipeline(OTHER, 'pipeline:other');
  await composeMain();
  const { createElectronExecutionRuntime } =
    await import('../../pipelines/execution-runtime');
  executionsDir = createElectronExecutionRuntime().executionsDir;
});

afterEach(() => {
  releaseRollback();
  mockHold.mode = 'off';
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

describe('pipeline runs and interrupted workflow updates (CAN-7308)', () => {
  let finishedTargetRun = '';

  it('starts a run as before when no update was interrupted', async () => {
    const marker = newMarker();
    const result = await startRun(otherId, OTHER, marker);
    await expect(ranAndWrote(result, marker)).resolves.toBe('other');
  });

  it('waits for the interrupted update to be undone, then runs the restored workflow', async () => {
    await interruptTargetUpdate();
    mockHold.mode = 'hold';
    const before = recordedRuns();
    const marker = newMarker();
    useFakeTimers();
    const start = track(startRun(targetId, TARGET_V1, marker));
    await untilRollbackHeld();
    await elapse(BOUND_MS - 1);
    expect(start.settled()).toBe(false);
    expect(recordedRuns()).toBe(before);
    expect(existsSync(marker)).toBe(false);
    releaseRollback();
    const result = await start.promise;
    finishedTargetRun = executionIdOf(result);
    await expect(ranAndWrote(result, marker)).resolves.toBe('v1');
  });

  it('starts a run of another workflow at once while that update is undone', async () => {
    await interruptTargetUpdate();
    mockHold.mode = 'hold';
    const marker = newMarker();
    const result = await startRun(otherId, OTHER, marker);
    await expect(ranAndWrote(result, marker)).resolves.toBe('other');
    await untilRollbackHeld();
  });

  it('still makes an install wait for that update to be undone', async () => {
    await interruptTargetUpdate();
    mockHold.mode = 'hold';
    const intents = await import('../../pipelines/pipeline-install-intents');
    useFakeTimers();
    const install = track(intents.beginPipelineInstallIntent('shared'));
    await untilRollbackHeld();
    await elapse(BOUND_MS * 2);
    expect(install.settled()).toBe(false);
    releaseRollback();
    await expect(install.promise).resolves.toEqual(
      expect.objectContaining({ finish: expect.any(Function) as unknown }),
    );
  });

  it('refuses the run after 60 seconds if the update is still being undone', async () => {
    await interruptTargetUpdate();
    mockHold.mode = 'hold';
    const before = recordedRuns();
    const marker = newMarker();
    useFakeTimers();
    const start = track(startRun(targetId, TARGET_V1, marker));
    await untilRollbackHeld();
    await elapse(BOUND_MS - 1);
    expect(start.settled()).toBe(false);
    await elapse(1);
    await expect(start.promise).resolves.toEqual({
      success: false,
      error: RESTORING,
      errorCode: 'pipeline_definition_restoring',
    });
    expect(recordedRuns()).toBe(before);
    releaseRollback();
    const again = newMarker();
    const retried = await startRun(targetId, TARGET_V1, again);
    await expect(ranAndWrote(retried, again)).resolves.toBe('v1');
  });

  it('starts the run when the update is undone before the bound, and never refuses it later', async () => {
    await interruptTargetUpdate();
    mockHold.mode = 'hold';
    const marker = newMarker();
    useFakeTimers();
    const start = track(startRun(targetId, TARGET_V1, marker));
    await untilRollbackHeld();
    await elapse(5_000);
    expect(start.settled()).toBe(false);
    releaseRollback();
    const result = await start.promise;
    expect(result).toEqual(expect.objectContaining({ success: true }));
    await expect(ranAndWrote(result, marker)).resolves.toBe('v1');
  });

  it('makes a start-over of an earlier run wait for the update to be undone too', async () => {
    expect(finishedTargetRun).not.toBe('');
    await interruptTargetUpdate();
    mockHold.mode = 'hold';
    const before = recordedRuns();
    useFakeTimers();
    const rerun = track(
      invokeIpc(PIPELINE_CHANNELS.RERUN_EXECUTION, finishedTargetRun),
    );
    await untilRollbackHeld();
    await elapse(BOUND_MS - 1);
    expect(rerun.settled()).toBe(false);
    expect(recordedRuns()).toBe(before);
    releaseRollback();
    const result = await rerun.promise;
    expect(result).toEqual(expect.objectContaining({ success: true }));
    await waitForExecution(executionsDir, executionIdOf(result));
  });

  it('refuses a run when the update could not be undone, and tells the person to restart', async () => {
    await interruptTargetUpdate();
    mockHold.mode = 'fail';
    const before = recordedRuns();
    await expect(startRun(targetId, TARGET_V1, newMarker())).resolves.toEqual({
      success: false,
      error: UNCONFIRMED,
      errorCode: 'pipeline_definition_unconfirmed',
    });
    expect(recordedRuns()).toBe(before);
    // The record stays for the next start, which undoes it.
    await relaunch();
    const marker = newMarker();
    const result = await startRun(targetId, TARGET_V1, marker);
    await expect(ranAndWrote(result, marker)).resolves.toBe('v1');
  });

  it('refuses a run or start-over of a workflow the undone install had added, and never runs the copy it was sent', async () => {
    // An earlier run of the workflow, which was saved and deleted before the
    // install added it again. A run can't start while the install is live
    // (CAN-7359), so the earlier run comes first.
    const createdId = await world.saveUserPipeline(
      CREATED,
      'pipeline:created-earlier',
    );
    const earlierMarker = newMarker();
    const earlier = await startRun(createdId, CREATED, earlierMarker);
    await expect(ranAndWrote(earlier, earlierMarker)).resolves.toBe('created');
    const earlierRun = executionIdOf(earlier);
    await deleteWorkflow(createdId);
    await interruptCreatingInstall(createdId);
    mockHold.mode = 'hold';
    const before = recordedRuns();
    const marker = newMarker();
    const waiting = track(startRun(createdId, CREATED, marker));
    await untilRollbackHeld();
    expect(waiting.settled()).toBe(false);
    releaseRollback();
    const refused = {
      success: false,
      error: REMOVED,
      errorCode: 'pipeline_definition_removed',
    };
    await expect(waiting.promise).resolves.toEqual(refused);
    // A start after the rollback has finished is refused the same way, and
    // so is a start-over of the earlier run, which carries its own copy.
    await expect(startRun(createdId, CREATED, newMarker())).resolves.toEqual(
      refused,
    );
    await expect(
      invokeIpc(PIPELINE_CHANNELS.RERUN_EXECUTION, earlierRun),
    ).resolves.toEqual(refused);
    expect(recordedRuns()).toBe(before);
    expect(existsSync(marker)).toBe(false);
  });

  it('runs a workflow the undone install had added once a later install of it completes', async () => {
    const createdId = randomUUID();
    await interruptCreatingInstall(createdId);
    await expect(startRun(createdId, CREATED, newMarker())).resolves.toEqual(
      expect.objectContaining({ errorCode: 'pipeline_definition_removed' }),
    );
    const intents = await import('../../pipelines/pipeline-install-intents');
    const intent = await intents.beginPipelineInstallIntent('shared');
    await intent.noteDefinition({
      definitionId: createdId,
      change: 'created',
      contentHash: hashPipelinePackageYaml(CREATED),
    });
    const { savePipeline } = await import('../../pipelines/pipeline-service');
    const saved = savePipeline(
      {
        name: 'Golden created workflow',
        description: '',
        icon: '',
        content: parsePipelineText(CREATED),
        rawContent: CREATED,
      },
      { id: createdId },
    );
    if (!saved.success) throw new Error(saved.error);
    await intent.finish();
    const marker = newMarker();
    const result = await startRun(createdId, CREATED, marker);
    await expect(ranAndWrote(result, marker)).resolves.toBe('created');
  });

  // A residual, not fixed here: a hook reads its workflow when it fires, so
  // one that fires during a rollback was authorized for the half-installed
  // copy. The start's provenance check must refuse it, never run it.
  it('refuses a hook that fires during the wait, visibly and with the reason, and never runs the half-installed workflow', async () => {
    await interruptTargetUpdate();
    mockHold.mode = 'hold';
    const queue = await import('../../lib/hook-pipeline');
    const marker = newMarker();
    const launched = track(
      runtime.initiatedWork.submit({
        origin: { kind: 'hook', sourceId: 'project:pr:create' },
        owner: { kind: 'principal', id: 'local' },
        scope: {
          workspaceId: GOLDEN_WORKSPACE_ID,
          worktreeId: GOLDEN_WORKTREE_ID,
        },
        targetKey: `can-7308-hook-${markerCount}`,
        gates: [],
        execute: async (control) => ({
          value: await queue.launchHookPipeline({
            identity: { operationId: control.operationId, actionIndex: 0 },
            action: {
              type: 'pipeline',
              source: 'local',
              id: targetId,
              inputs: { marker },
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
              triggered_at: '2026-11-19T00:00:00Z',
            },
            getWindow: () => null,
          }),
          result: { status: 'succeeded', exitCode: 0, durationMs: 0 },
        }),
      }),
    );
    await untilRollbackHeld();
    expect(launched.settled()).toBe(false);
    releaseRollback();
    const outcome = await launched.promise.then(
      (value: unknown) => JSON.stringify(value),
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    expect(outcome).toContain(
      "Couldn't confirm where something this uses came from",
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(existsSync(marker)).toBe(false);
  });

  describe('automation starts', () => {
    async function automations(): Promise<{
      /** Creates the automation and starts Run now, which settles when its start does. */
      run: (
        pipelineId: string,
        name: string,
      ) => Promise<{ id: string; started: Promise<unknown> }>;
      /** Creates the automation without starting it. */
      create: (pipelineId: string, name: string) => Promise<string>;
      /** Starts Run now of an existing automation. */
      runNow: (id: string) => Promise<unknown>;
      outcome: (activityId: string) => Promise<{
        status: string;
        error?: string;
        runs: number;
      }>;
      /** Creates an enabled automation due once, `inMs` from now. */
      schedule: (
        pipelineId: string,
        name: string,
        inMs: number,
      ) => Promise<string>;
      /** Starts the service, whose due check fires what is due. */
      start: () => Promise<void>;
      stop: () => void;
    }> {
      const { AutomationsService } = await import('../../automations/service');
      const service = new AutomationsService();
      service.configure({
        getMainWindow: () => null,
        getAppAdvisorWindow: () => null,
        openAppAdvisorWindow: () =>
          Promise.resolve({ open: false, focused: false }),
        ensureAppAdvisorWindow: () =>
          Promise.resolve({ open: false, focused: false }),
        sendAppAdvisorWindowCommand: () => undefined,
      });
      const create = async (
        pipelineId: string,
        name: string,
      ): Promise<string> => {
        const created = await service.create({
          name,
          schedule: {
            kind: 'cron',
            expression: '0 9 * * 1-5',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'task', taskId: GOLDEN_WORKTREE_ID },
            workspaceId: GOLDEN_WORKSPACE_ID,
            pipelineId,
            pipelineSource: 'user',
            pipelineName: name,
            inputs: { marker: newMarker() },
          },
          enabled: false,
          executionContext: 'personal',
        });
        const id = created.ok ? (created.activity?.id ?? '') : '';
        if (!id)
          throw new Error(
            `Could not create ${name}: ${created.ok ? '' : created.error}`,
          );
        return id;
      };
      return {
        create,
        runNow: (id) => service.runNow({ id }),
        run: async (
          pipelineId,
          name,
        ): Promise<{ id: string; started: Promise<unknown> }> => {
          const id = await create(pipelineId, name);
          return { id, started: service.runNow({ id }) };
        },
        schedule: async (pipelineId, name, inMs): Promise<string> => {
          const created = await service.create({
            name,
            schedule: {
              kind: 'one_time',
              runAt: new Date(Date.now() + inMs).toISOString(),
              timezone: 'local',
            },
            action: {
              type: 'worktree_pipeline',
              target: { kind: 'task', taskId: GOLDEN_WORKTREE_ID },
              workspaceId: GOLDEN_WORKSPACE_ID,
              pipelineId,
              pipelineSource: 'user',
              pipelineName: name,
              inputs: { marker: newMarker() },
            },
            enabled: true,
            executionContext: 'personal',
          });
          const id = created.ok ? (created.activity?.id ?? '') : '';
          if (!id) throw new Error(`Could not schedule ${name}`);
          return id;
        },
        start: () => service.start(),
        stop: () => service.stop(),
        outcome: async (activityId) => {
          const history = await service.listRuns({ activityId });
          const runs = 'runs' in history ? history.runs : [];
          const latest = runs[0];
          return {
            status: latest?.status ?? 'none',
            ...(latest?.error === undefined ? {} : { error: latest.error }),
            runs: runs.length,
          };
        },
      };
    }

    async function settledOutcome(
      read: () => Promise<{ status: string; error?: string; runs: number }>,
    ): Promise<{ status: string; error?: string; runs: number }> {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const outcome = await read();
        if (outcome.status !== 'running' && outcome.status !== 'none')
          return outcome;
        if (Date.now() > deadline)
          throw new Error(`The automation run stayed ${outcome.status}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it('records a refused automation start as a failed run with the reason, and never starts it again', async () => {
      await interruptTargetUpdate();
      mockHold.mode = 'hold';
      const before = recordedRuns();
      const { run, outcome } = await automations();
      // The service keeps its own short timers, so fake time also follows
      // real time here; the bound is still jumped to below.
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate'],
        advanceTimers: true,
      });
      const held = await run(targetId, 'Golden held automation');
      const activityId = held.id;
      await untilRollbackHeld();
      await elapse(BOUND_MS);
      jest.useRealTimers();
      await held.started;
      await expect(settledOutcome(() => outcome(activityId))).resolves.toEqual({
        status: 'failure',
        error: RESTORING,
        runs: 1,
      });
      expect(recordedRuns()).toBe(before);
    });

    it('starts an unrelated automation at once while a scheduled one waits for its update to be undone, then runs the restored workflow', async () => {
      await interruptTargetUpdate();
      mockHold.mode = 'hold';
      const { run, schedule, start, stop, outcome } = await automations();
      const waiting = await schedule(
        targetId,
        'Golden scheduled automation',
        1_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // The due check fires the scheduled run in the background.
      await start();
      try {
        await untilRollbackHeld();
        const other = await run(otherId, 'Golden unrelated automation');
        await other.started;
        await expect(settledOutcome(() => outcome(other.id))).resolves.toEqual(
          expect.objectContaining({ status: 'success' }),
        );
        await expect(outcome(waiting)).resolves.toEqual(
          expect.objectContaining({ status: 'running' }),
        );
        releaseRollback();
        await expect(settledOutcome(() => outcome(waiting))).resolves.toEqual(
          expect.objectContaining({ status: 'success' }),
        );
      } finally {
        stop();
      }
    });

    it('refuses an automation run whose workflow an install changes after the wait, instead of running it half-installed', async () => {
      const { run, outcome } = await automations();
      const handlers = await import('../../pipelines/pipeline-handlers');
      const { writeStoredPipeline } =
        await import('@canopy/execution-engine/pipelines/store');
      const start = handlers.startPipelineExecutionFromMain;
      const fromV1 = writeStoredPipeline(
        {
          id: targetId,
          name: 'Golden install target',
          description: '',
          icon: '',
          content: parsePipelineText(TARGET_V1),
          rawContent: TARGET_V1,
        },
        { requireExisting: true },
      );
      if (!fromV1.ok) throw new Error(fromV1.message);
      // An install writes the target's new document after the automation
      // resolved the workflow it was authorized for, just before its start.
      const raced = jest
        .spyOn(handlers, 'startPipelineExecutionFromMain')
        .mockImplementationOnce((args) => {
          const written = writeStoredPipeline(
            {
              id: targetId,
              name: 'Golden install target',
              description: '',
              icon: '',
              content: parsePipelineText(TARGET_V2),
              rawContent: TARGET_V2,
            },
            { requireExisting: true },
          );
          if (!written.ok) throw new Error(written.message);
          return start(args);
        });
      let restoreFailure: string | undefined;
      try {
        const before = recordedRuns();
        const racing = await run(targetId, 'Golden raced automation');
        await racing.started;
        await expect(settledOutcome(() => outcome(racing.id))).resolves.toEqual(
          expect.objectContaining({
            status: 'failure',
            error:
              "Couldn't confirm where something this uses came from, so it didn't run.",
          }),
        );
        expect(recordedRuns()).toBe(before);
      } finally {
        raced.mockRestore();
        const restored = writeStoredPipeline(
          {
            id: targetId,
            name: 'Golden install target',
            description: '',
            icon: '',
            content: parsePipelineText(TARGET_V1),
            rawContent: TARGET_V1,
          },
          { requireExisting: true },
        );
        if (!restored.ok) restoreFailure = restored.message;
      }
      expect(restoreFailure).toBeUndefined();
    });

    it('records an automation run of a workflow the undone install had added as a failed run', async () => {
      const createdId = randomUUID();
      let activityId = '';
      // The automation was set up while the added workflow existed.
      await interruptCreatingInstall(createdId, async () => {
        activityId = await (
          await automations()
        ).create(createdId, 'Golden created automation');
      });
      mockHold.mode = 'hold';
      const before = recordedRuns();
      const { runNow, outcome } = await automations();
      const started = runNow(activityId);
      await untilRollbackHeld();
      releaseRollback();
      await started;
      await expect(settledOutcome(() => outcome(activityId))).resolves.toEqual({
        status: 'failure',
        error: REMOVED,
        runs: 1,
      });
      expect(recordedRuns()).toBe(before);
    });

    it('refuses an automation run whose workflow is deleted after the automation read it (CAN-7347)', async () => {
      const { id } = await saveDeletable();
      const { run, outcome } = await automations();
      const restore = await deletedBeforeStart(id);
      try {
        const before = recordedRuns();
        const racing = await run(id, 'Golden deleted automation');
        await racing.started;
        await expect(settledOutcome(() => outcome(racing.id))).resolves.toEqual(
          { status: 'failure', error: REMOVED, runs: 1 },
        );
        expect(recordedRuns()).toBe(before);
      } finally {
        restore();
      }
    });

    it('records an automation of a workflow deleted before it read it as a failed run, as before (CAN-7347)', async () => {
      const { id } = await saveDeletable();
      const { create, runNow, outcome } = await automations();
      const activityId = await create(
        id,
        'Golden automation of a deleted workflow',
      );
      await deleteWorkflow(id);
      const before = recordedRuns();
      await runNow(activityId);
      await expect(settledOutcome(() => outcome(activityId))).resolves.toEqual({
        status: 'failure',
        error: `Workflow not found: ${id}`,
        runs: 1,
      });
      expect(recordedRuns()).toBe(before);
    });

    it('records an automation run of a workflow an undone install had added as a failed run once recovery has settled (CAN-7359)', async () => {
      const createdId = randomUUID();
      let activityId = '';
      await interruptCreatingInstall(createdId, async () => {
        activityId = await (
          await automations()
        ).create(createdId, 'Golden settled automation');
      });
      const intents = await import('../../pipelines/pipeline-install-intents');
      await intents.whenPipelineInstallsRecovered();
      const before = recordedRuns();
      const { runNow, outcome } = await automations();
      await runNow(activityId);
      await expect(settledOutcome(() => outcome(activityId))).resolves.toEqual({
        status: 'failure',
        error: REMOVED,
        runs: 1,
      });
      expect(recordedRuns()).toBe(before);
    });
  });

  describe('deleted workflows (CAN-7347)', () => {
    it('refuses a run of a deleted workflow and never runs the copy the window still holds', async () => {
      const { id, yaml } = await saveDeletable();
      await deleteWorkflow(id);
      const before = recordedRuns();
      const marker = newMarker();
      await expect(startRun(id, yaml, marker)).resolves.toEqual(
        REMOVED_REFUSAL,
      );
      expect(recordedRuns()).toBe(before);
      expect(existsSync(marker)).toBe(false);
    });

    it('refuses a run whose workflow is deleted between the start check and admission', async () => {
      const { id, yaml } = await saveDeletable();
      const admission =
        await import('../../pipelines/run-definition-admission');
      const admit = admission.admitStoredRunDefinition;
      const spy = jest
        .spyOn(admission, 'admitStoredRunDefinition')
        .mockImplementationOnce(async (definitionId, scope) => {
          await deleteWorkflow(id);
          return admit(definitionId, scope);
        });
      try {
        const before = recordedRuns();
        const marker = newMarker();
        await expect(startRun(id, yaml, marker)).resolves.toEqual(
          REMOVED_REFUSAL,
        );
        expect(recordedRuns()).toBe(before);
        expect(existsSync(marker)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('refuses a hook whose workflow is deleted after the hook read it', async () => {
      const { id } = await saveDeletable();
      const restore = await deletedBeforeStart(id);
      try {
        const before = recordedRuns();
        const marker = newMarker();
        await expect(launchHook(id, marker)).resolves.toContain(REMOVED);
        expect(recordedRuns()).toBe(before);
        expect(existsSync(marker)).toBe(false);
      } finally {
        restore();
      }
    });

    it('refuses an agent run whose workflow is deleted after the agent loaded it', async () => {
      const { id } = await saveDeletable();
      const { desktopPipelinesPort } =
        await import('../../agent-actions/desktop-pipelines-port');
      const restore = await deletedBeforeStart(id);
      try {
        const before = recordedRuns();
        const marker = newMarker();
        await expect(
          desktopPipelinesPort.run(
            { type: 'pipeline.run', pipelineId: id, inputs: { marker } },
            {
              host: {
                requestUserAnswers: () => Promise.resolve([]),
                loadScriptOutput: () =>
                  Promise.resolve({ found: false, lines: [] }),
                worktreeActionRuntime: {
                  projectId: GOLDEN_WORKSPACE_ID,
                  worktreeId: GOLDEN_WORKTREE_ID,
                  chatId: 'golden-chat',
                  cwd: world.worktreePath,
                  getWindow: () => null,
                  interfacePort: windowAgentInterfacePort(() => null),
                },
              },
            },
          ),
        ).resolves.toEqual({
          status: 'rejected',
          reason: 'execution_failed',
          message: REMOVED,
        });
        expect(recordedRuns()).toBe(before);
        expect(existsSync(marker)).toBe(false);
      } finally {
        restore();
      }
    });

    it('refuses a Remote Control run whose workflow is deleted after it loaded it', async () => {
      const { id } = await saveDeletable();
      const { runPipeline } = await import('../../services/pipelines-service');
      const restore = await deletedBeforeStart(id);
      try {
        const before = recordedRuns();
        const marker = newMarker();
        await expect(
          runPipeline({
            pipelineId: id,
            projectId: GOLDEN_WORKSPACE_ID,
            worktreeId: GOLDEN_WORKTREE_ID,
            inputs: { marker },
          }),
        ).rejects.toThrow(REMOVED);
        expect(recordedRuns()).toBe(before);
        expect(existsSync(marker)).toBe(false);
      } finally {
        restore();
      }
    });

    it('refuses a start that names a saved workflow another process deleted', async () => {
      const { id, yaml } = await saveDeletable();
      const { inspectStoredPipelineDocument, removeStoredPipeline } =
        await import('@canopy/execution-engine/pipelines/store');
      const stored = inspectStoredPipelineDocument(id);
      if (stored.kind !== 'stored')
        throw new Error('The workflow was not saved');
      const removed = removeStoredPipeline(id, {
        expectedRevision: stored.revision,
      });
      if (!removed.ok) throw new Error(removed.message);
      const before = recordedRuns();
      const marker = newMarker();
      await expect(
        startRun(id, yaml, marker, {
          pipelinePreferenceLocator: {
            type: 'stored',
            source: 'user',
            value: id,
          },
        }),
      ).resolves.toEqual(REMOVED_REFUSAL);
      expect(recordedRuns()).toBe(before);
      // A residual, named in the PR: without that claim, this process can't
      // tell the copy from a definition that was never saved.
      const unclaimed = newMarker();
      const result = await startRun(id, yaml, unclaimed);
      await expect(ranAndWrote(result, unclaimed)).resolves.toBe('deletable');
    });

    it('still runs a definition that was never saved, as given', async () => {
      const yaml = versionYaml('Golden one-off workflow', 'one-off');
      const marker = newMarker();
      const result = await startRun(randomUUID(), yaml, marker);
      await expect(ranAndWrote(result, marker)).resolves.toBe('one-off');
    });

    it("refuses a start-over of a deleted workflow's earlier run", async () => {
      const { id, yaml } = await saveDeletable();
      const marker = newMarker();
      const earlier = await startRun(id, yaml, marker);
      await expect(ranAndWrote(earlier, marker)).resolves.toBe('deletable');
      await deleteWorkflow(id);
      const before = recordedRuns();
      await expect(
        invokeIpc(PIPELINE_CHANNELS.RERUN_EXECUTION, executionIdOf(earlier)),
      ).resolves.toEqual(REMOVED_REFUSAL);
      expect(recordedRuns()).toBe(before);
    });

    it("refuses a retry of a deleted workflow's failed run", async () => {
      deletableCount += 1;
      const yaml = [
        'pipeline:',
        `  name: Golden failing ${deletableCount}`,
        '  on:',
        '    dispatch:',
        '      inputs:',
        '        marker:',
        '          type: string',
        '          required: true',
        '  jobs:',
        '    write:',
        '      name: Write',
        '      steps:',
        '        - id: fail',
        '          run: exit 1',
        '',
      ].join('\n');
      const id = await world.saveUserPipeline(
        yaml,
        `pipeline:deletable-${deletableCount}`,
      );
      const failed = await startRun(id, yaml, newMarker());
      await waitForExecution(executionsDir, executionIdOf(failed));
      await deleteWorkflow(id);
      await expect(
        invokeIpc(PIPELINE_CHANNELS.RETRY_EXECUTION, executionIdOf(failed)),
      ).resolves.toEqual(REMOVED_REFUSAL);
    });

    it("refuses a start-over of a deleted workflow's run after a restart, from the run's own record", async () => {
      const { id, yaml } = await saveDeletable();
      const marker = newMarker();
      const earlier = await startRun(id, yaml, marker);
      await expect(ranAndWrote(earlier, marker)).resolves.toBe('deletable');
      await deleteWorkflow(id);
      await relaunch();
      const before = recordedRuns();
      await expect(
        invokeIpc(PIPELINE_CHANNELS.RERUN_EXECUTION, executionIdOf(earlier)),
      ).resolves.toEqual(REMOVED_REFUSAL);
      expect(recordedRuns()).toBe(before);
    });

    it('runs a deleted workflow again once it is saved again under the same id', async () => {
      const { id, yaml } = await saveDeletable();
      await deleteWorkflow(id);
      const { savePipeline } = await import('../../pipelines/pipeline-service');
      const saved = savePipeline(
        {
          name: 'Golden deletable again',
          description: '',
          icon: '',
          content: parsePipelineText(yaml),
          rawContent: yaml,
        },
        { id },
      );
      if (!saved.success) throw new Error(saved.error);
      const marker = newMarker();
      const result = await startRun(id, yaml, marker);
      await expect(ranAndWrote(result, marker)).resolves.toBe('deletable');
    });
  });

  describe('live installs (CAN-7359)', () => {
    let liveCount = 0;

    /** A saved workflow a live install updates, with both of its versions. */
    async function saveLiveTarget(): Promise<{
      id: string;
      v1: string;
      v2: string;
    }> {
      liveCount += 1;
      const name = `Golden live target ${liveCount}`;
      const v1 = versionYaml(name, 'v1');
      const id = await world.saveUserPipeline(v1, `pipeline:live-${liveCount}`);
      return { id, v1, v2: versionYaml(name, 'v2') };
    }

    /**
     * An install of this process that has journaled the workflow's update
     * and not yet finished, as one that is still moving its files.
     */
    async function liveUpdate(
      id: string,
      v2: string,
    ): Promise<{
      /** Saves the new document and finishes the install. */
      finish: () => Promise<void>;
      /** Finishes the install without changing the document. */
      finishUnchanged: () => Promise<void>;
    }> {
      const intents = await import('../../pipelines/pipeline-install-intents');
      const intent = await intents.beginPipelineInstallIntent('shared');
      await intent.noteDefinition({
        definitionId: id,
        change: 'replaced',
        contentHash: hashPipelinePackageYaml(v2),
      });
      return {
        finish: async (): Promise<void> => {
          const { writeStoredPipeline } =
            await import('@canopy/execution-engine/pipelines/store');
          const written = writeStoredPipeline(
            {
              id,
              name: parsePipelineText(v2).name,
              description: '',
              icon: '',
              content: parsePipelineText(v2),
              rawContent: v2,
            },
            { requireExisting: true },
          );
          if (!written.ok) throw new Error(written.message);
          await intent.finish();
        },
        finishUnchanged: () => intent.finish(),
      };
    }

    /** Records which workflows a start has waited on, from main's log. */
    async function liveWaits(): Promise<{
      seen: (id: string) => boolean;
      restore: () => void;
    }> {
      const logging = await import('../../lib/main-process-logging');
      const real = logging.logMainProcessWarn;
      const waited = new Set<string>();
      const spy = jest
        .spyOn(logging, 'logMainProcessWarn')
        .mockImplementation((message, context) => {
          if (
            message === LIVE_WAIT_LOG &&
            typeof context === 'object' &&
            context !== null &&
            'definitionId' in context &&
            typeof context.definitionId === 'string'
          )
            waited.add(context.definitionId);
          real(message, context);
        });
      return {
        seen: (id) => waited.has(id),
        restore: () => spy.mockRestore(),
      };
    }

    /**
     * Waits, through real I/O turns, until the start is waiting on the
     * install. A start that settles first never waited.
     */
    async function untilWaiting(
      start: Tracked<unknown>,
      waiting: () => boolean,
    ): Promise<void> {
      for (let turn = 0; turn < 200_000; turn += 1) {
        if (waiting()) return;
        if (start.settled())
          throw new Error(
            `The start did not wait for the install: ${JSON.stringify(
              await start.promise,
            )}`,
          );
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error('The start never reached the install wait');
    }

    /** Until no run is active, so a hook starts instead of queueing. */
    async function untilIdle(): Promise<void> {
      const registry =
        await import('../../pipelines/pipeline-execution-registry');
      const deadline = Date.now() + 60_000;
      while (registry.hasActivePipelineExecutions()) {
        if (Date.now() > deadline) throw new Error('A run stayed active');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    async function untilExists(path: string): Promise<void> {
      const deadline = Date.now() + 60_000;
      while (!existsSync(path)) {
        if (Date.now() > deadline) throw new Error(`${path} was never written`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it('makes a run that starts during an automation install wait, then runs the new workflow with its new files', async () => {
      const { installAutomationPipelines } =
        await import('../../pipelines/automation-pipeline-install');
      const { pipelineAssetEnvironment } =
        await import('../../pipelines/pipeline-asset-install');
      const { getPipelineAssetsDir } = await import('../../lib/paths');
      const { getStoredPipelineText } =
        await import('@canopy/execution-engine/pipelines/store');
      const { app } = await import('electron');
      const { v1, v3 } = world.automationPackages;
      const install = (
        automationPackage: GoldenAutomationPackage,
        existing?: { entry: string; worker: string },
      ): ReturnType<typeof installAutomationPipelines> =>
        installAutomationPipelines({
          remoteId: GOLDEN_AUTOMATION_SHARE_ID,
          packageRef: { version: 1, digest: automationPackage.digest },
          source: 'public',
          stage: 'pipelines',
          ...(existing
            ? {
                existingPipelines: [
                  {
                    key: GOLDEN_AUTOMATION_ENTRY_KEY,
                    localPipelineId: existing.entry,
                    expectedContentHash:
                      v1.contentHashes[GOLDEN_AUTOMATION_ENTRY_KEY] ?? '',
                  },
                  {
                    key: GOLDEN_AUTOMATION_WORKER_KEY,
                    localPipelineId: existing.worker,
                    expectedContentHash:
                      v1.contentHashes[GOLDEN_AUTOMATION_WORKER_KEY] ?? '',
                  },
                ],
              }
            : {}),
        });
      // Install effects keep state under userData, which the Electron mock
      // otherwise resolves to the checkout.
      const userData = jest.spyOn(app, 'getPath').mockReturnValue(world.root);
      let releaseMove = (): void => undefined;
      try {
        const installed = await install(v1);
        const idOf = (key: string): string =>
          installed.pipelines.find((pipeline) => pipeline.key === key)
            ?.localPipelineId ?? '';
        const entry = idOf(GOLDEN_AUTOMATION_ENTRY_KEY);
        const worker = idOf(GOLDEN_AUTOMATION_WORKER_KEY);
        // The window still holds the entry workflow as it was installed.
        const copy = getStoredPipelineText(entry);
        if (!copy.success || copy.data === undefined)
          throw new Error('The automation install saved no entry workflow');
        // The update holds before it moves its first file into place.
        const realMove = pipelineAssetEnvironment.moveAssetFile;
        let reached = (): void => undefined;
        const atMove = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const gate = new Promise<void>((release) => {
          releaseMove = release;
        });
        const move = jest
          .spyOn(pipelineAssetEnvironment, 'moveAssetFile')
          .mockImplementationOnce(async (id, from, to) => {
            reached();
            await gate;
            await realMove(id, from, to);
          });
        const waits = await liveWaits();
        try {
          const update = track(install(v3, { entry, worker }));
          await atMove;
          const before = recordedRuns();
          const start = track(
            invokeIpc(PIPELINE_CHANNELS.EXECUTE, parsePipelineText(copy.data), {
              pipelineId: entry,
              cwd: world.worktreePath,
              projectId: GOLDEN_WORKSPACE_ID,
              worktreeId: GOLDEN_WORKTREE_ID,
              scope: 'worktree',
            }),
          );
          await untilWaiting(start, () => waits.seen(entry));
          expect(recordedRuns()).toBe(before);
          releaseMove();
          await update.promise;
          const state = await waitForExecution(
            executionsDir,
            executionIdOf(await start.promise),
          );
          expect({
            status: state.status,
            revised: JSON.stringify(state.pipeline_snapshot).includes(
              'echo entry revised',
            ),
            notes: readFileSync(
              join(getPipelineAssetsDir(entry), 'specialists', 'notes.md'),
              'utf8',
            ),
          }).toEqual({
            status: 'success',
            revised: true,
            notes: GOLDEN_AUTOMATION_REVISED_NOTES,
          });
        } finally {
          waits.restore();
          move.mockRestore();
        }
      } finally {
        releaseMove();
        userData.mockRestore();
      }
    });

    it('refuses a run after 5 minutes if the install still has not finished, and runs it once it has', async () => {
      const { id, v1, v2 } = await saveLiveTarget();
      const live = await liveUpdate(id, v2);
      const waits = await liveWaits();
      try {
        const before = recordedRuns();
        const marker = newMarker();
        useFakeTimers();
        const start = track(startRun(id, v1, marker));
        await untilWaiting(start, () => waits.seen(id));
        await elapse(LIVE_BOUND_MS - 1);
        expect(start.settled()).toBe(false);
        await elapse(1);
        await expect(start.promise).resolves.toEqual({
          success: false,
          error: INSTALLING,
          errorCode: 'pipeline_definition_installing',
        });
        expect(recordedRuns()).toBe(before);
        expect(existsSync(marker)).toBe(false);
        jest.useRealTimers();
        await live.finish();
        const again = newMarker();
        const result = await startRun(id, v1, again);
        await expect(ranAndWrote(result, again)).resolves.toBe('v2');
      } finally {
        jest.useRealTimers();
        waits.restore();
      }
    });

    it('refuses a run of a workflow a live install added and then undid, without a restart', async () => {
      const createdId = randomUUID();
      const intents = await import('../../pipelines/pipeline-install-intents');
      const intent = await intents.beginPipelineInstallIntent('shared');
      await intent.noteDefinition({
        definitionId: createdId,
        change: 'created',
        contentHash: hashPipelinePackageYaml(CREATED),
      });
      const { savePipeline } = await import('../../pipelines/pipeline-service');
      const saved = savePipeline(
        {
          name: 'Golden created workflow',
          description: '',
          icon: '',
          content: parsePipelineText(CREATED),
          rawContent: CREATED,
        },
        { id: createdId },
      );
      if (!saved.success) throw new Error(saved.error);
      const waits = await liveWaits();
      try {
        const before = recordedRuns();
        const marker = newMarker();
        const waiting = track(startRun(createdId, CREATED, marker));
        await untilWaiting(waiting, () => waits.seen(createdId));
        // The install fails after saving the workflow, and is undone in place.
        await intent.rollBack();
        await expect(waiting.promise).resolves.toEqual(REMOVED_REFUSAL);
        // A start that still holds the copy is refused the same way.
        const later = newMarker();
        await expect(startRun(createdId, CREATED, later)).resolves.toEqual(
          REMOVED_REFUSAL,
        );
        expect(recordedRuns()).toBe(before);
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(later)).toBe(false);
      } finally {
        waits.restore();
      }
    });

    it('starts a run of another workflow at once while an install is live', async () => {
      const { id, v2 } = await saveLiveTarget();
      const live = await liveUpdate(id, v2);
      try {
        const marker = newMarker();
        const result = await startRun(otherId, OTHER, marker);
        await expect(ranAndWrote(result, marker)).resolves.toBe('other');
      } finally {
        await live.finishUnchanged();
      }
    });

    it('refuses a run when a live install could not be undone, and tells the person to restart', async () => {
      const { id, v1, v2 } = await saveLiveTarget();
      const intents = await import('../../pipelines/pipeline-install-intents');
      const intent = await intents.beginPipelineInstallIntent('shared');
      await intent.noteDefinition({
        definitionId: id,
        change: 'replaced',
        contentHash: hashPipelinePackageYaml(v2),
      });
      mockHold.mode = 'fail';
      await expect(intent.rollBack()).rejects.toThrow('EACCES');
      const before = recordedRuns();
      await expect(startRun(id, v1, newMarker())).resolves.toEqual({
        success: false,
        error: UNCONFIRMED,
        errorCode: 'pipeline_definition_unconfirmed',
      });
      expect(recordedRuns()).toBe(before);
      // The record stays for the next start, which undoes it.
      await relaunch();
      const marker = newMarker();
      const result = await startRun(id, v1, marker);
      await expect(ranAndWrote(result, marker)).resolves.toBe('v1');
    });

    it('holds only later hooks behind a hook that waits for an install, never a Run of another workflow', async () => {
      const { id, v2 } = await saveLiveTarget();
      const live = await liveUpdate(id, v2);
      const waits = await liveWaits();
      try {
        await untilIdle();
        const first = newMarker();
        const waiting = track(launchHook(id, first));
        await untilWaiting(waiting, () => waits.seen(id));
        // A later hook waits in line behind it.
        const second = newMarker();
        const queued = track(launchHook(otherId, second));
        // A Run of another workflow is not held up.
        const run = newMarker();
        const result = await startRun(otherId, OTHER, run);
        await expect(ranAndWrote(result, run)).resolves.toBe('other');
        expect(waiting.settled()).toBe(false);
        expect(existsSync(second)).toBe(false);
        await live.finishUnchanged();
        await expect(waiting.promise).resolves.toContain('"status":"started"');
        await untilExists(first);
        await untilExists(second);
        expect(readFileSync(first, 'utf8')).toBe('v1');
        expect(readFileSync(second, 'utf8')).toBe('other');
        await expect(queued.promise).resolves.toContain('"status":"queued"');
      } finally {
        waits.restore();
      }
    });

    it('refuses a hook that waited 5 minutes for an install, then runs the hook queued behind it', async () => {
      const { id, v2 } = await saveLiveTarget();
      const live = await liveUpdate(id, v2);
      const waits = await liveWaits();
      try {
        await untilIdle();
        const before = recordedRuns();
        const first = newMarker();
        useFakeTimers();
        const waiting = track(launchHook(id, first));
        await untilWaiting(waiting, () => waits.seen(id));
        const waitedFrom = Date.now();
        const second = newMarker();
        const queued = track(launchHook(otherId, second));
        // The later hook's admission keeps short timers of its own.
        for (let step = 0; step < 1_000 && !queued.settled(); step += 1)
          await elapse(10);
        await expect(queued.promise).resolves.toContain('"status":"queued"');
        expect(existsSync(second)).toBe(false);
        await elapse(LIVE_BOUND_MS - 1 - (Date.now() - waitedFrom));
        expect(waiting.settled()).toBe(false);
        expect(existsSync(second)).toBe(false);
        await elapse(1);
        await expect(waiting.promise).resolves.toContain(INSTALLING);
        expect(recordedRuns()).toBe(before);
        jest.useRealTimers();
        await untilExists(second);
        expect(readFileSync(second, 'utf8')).toBe('other');
        expect(existsSync(first)).toBe(false);
      } finally {
        jest.useRealTimers();
        waits.restore();
        await live.finishUnchanged();
      }
    });
  });
});
