/**
 * CAN-5086 route seam: the real desktop runtime, local pipeline worker and
 * dispatch over an injected daemon connection and a spied executor. Real
 * daemon hosts are covered by pipelines.test.ts and pipeline-conformance.
 */
const mockGet = jest.fn<Promise<{ client: unknown }>, [unknown, unknown]>();
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonConnections: (): unknown => ({
    get: (caller: unknown, signal: unknown) => mockGet(caller, signal),
  }),
  getElectronDaemonFilesContext: (): Promise<unknown> =>
    Promise.resolve({ authorityId: 'local' }),
}));
// CAN-5771: whether this app spawned the daemon, and its owner settlement.
const mockOwnerPossible = jest.fn(() => false);
jest.mock('../../canopy-runtime/electron-daemon-owner', () => ({
  isDaemonPipelineOwnerPossible: (): boolean => mockOwnerPossible(),
}));
const mockCalls: string[] = [];
const mockEnsureOwner = jest.fn((): Promise<void> => Promise.resolve());
// CAN-5095: the owner request handler the model-step settlement installs.
let mockOwnerHandler:
  | ((request: unknown, signal: AbortSignal) => Promise<unknown>)
  | null = null;
jest.mock('../daemon-pipeline-owner', () => ({
  DAEMON_PIPELINE_NOT_STARTED_HERE_MESSAGE:
    'This app did not start this workflow run.',
  setDaemonPipelineOwnerRequestHandler: (
    handler: (request: unknown, signal: AbortSignal) => Promise<unknown>,
  ): void => {
    mockOwnerHandler = handler;
  },
  ensureDaemonPipelineOwnerSettlement: (): Promise<void> => {
    mockCalls.push('ensureDaemonPipelineOwnerSettlement');
    return mockEnsureOwner();
  },
  abortDaemonPipelineHostCalls: (): void => undefined,
  expectDaemonPipelineHostSteps: (): (() => void) => {
    mockCalls.push('expectDaemonPipelineHostSteps');
    return () => {
      mockCalls.push('released');
    };
  },
}));
const mockFallbacks: [string, string][] = [];
jest.mock('../../canopy-runtime/electron-daemon-health', () => ({
  getElectronDaemonHealth: (): unknown => ({
    setConsumerEnabled: (): void => undefined,
    isLatched: (): boolean => false,
    noteFallback: (consumer: string, reason: string): void => {
      mockFallbacks.push([consumer, reason]);
    },
  }),
}));
// CAN-5960: the route never reads Labs, so a snapshot that is never ready
// changes nothing.
const mockLabsSnapshot = jest.fn(() => ({ ready: false, experiments: [] }));
jest.mock('../../services/labs-experiments-runtime', () => ({
  getLabsExperimentsService: (): unknown => ({
    getSnapshot: (): unknown => mockLabsSnapshot(),
  }),
}));
const mockCodexEnvironment = jest.fn(() => ({
  environment: { CODEX_ROUTE_ENV: 'value' },
  logicalWorkspaceEnvironmentId: 'pipeline:default',
}));
jest.mock('../../lib/user-environment-runtime', () => ({
  ...jest.requireActual<object>('../../lib/user-environment-runtime'),
  resolveCodexRuntimeEnvironmentProfile: (): unknown => mockCodexEnvironment(),
}));
jest.mock('@canopy/core-platform', () => ({
  ...jest.requireActual<object>('@canopy/core-platform'),
  hostPlatformOperatingSystem: (): string => 'darwin',
}));
// CAN-5868: the desktop notification a daemon notify step asks for.
const mockShowOsNotification = jest.fn();
jest.mock('../../ipc/os-notifications', () => ({
  ...jest.requireActual<object>('../../ipc/os-notifications'),
  showOsNotification: (...args: unknown[]): unknown =>
    mockShowOsNotification(...args),
}));
const mockExecutePipeline = jest.fn();
jest.mock('@canopy/execution-engine/node/pipelines/executor', () => ({
  ...jest.requireActual<object>(
    '@canopy/execution-engine/node/pipelines/executor',
  ),
  executePipeline: (...args: unknown[]): unknown =>
    mockExecutePipeline(...args),
}));

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  DAEMON_COMMIT_HOOK_SKIP_OUTPUTS_UNAVAILABLE,
  DaemonCommitHookFollower,
  catchUpDaemonCommitHooks,
  daemonCommitHookKey,
  daemonCommitHooksDone,
  daemonCommitHookMarkerPath,
  daemonCommitHooksPendingPath,
  markDaemonCommitHooksPending,
  runDaemonCommitHooks,
} from '../daemon-pipeline-commit-hooks';
import { scanInterruptedWork } from '../../lib/interrupted-work-scan-worker';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import { createMatrixPhysicalJobId } from '@canopy/execution-engine/pipelines/matrix';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CanopyClientError } from '@canopy/core-client';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import {
  createInitialState,
  normalizePipeline,
  saveExecutionState,
  type ExecutionHandle,
  type ExecutionOptions,
} from '@canopy/execution-engine/node/pipelines/executor';
import { setLoginShellProbe } from '@canopy/execution-engine/node/pipelines/config-paths';
import { recoverOrphanedPipelineExecutions } from '@canopy/execution-engine/node/pipelines/executor/crash-recovery';
import type {
  ExecutionRuntime,
  PipelineAgentModelAliasResolution,
  PipelinePluginCollectionResolution,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  ExecutionState,
  Pipeline,
} from '@canopy/execution-engine/types/pipeline';
import type { UsageInitiationSource } from '@canopy/protocol/observability';
import { markUnreachable } from '../../canopy-runtime/electron-daemon-connection';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import {
  DAEMON_PIPELINE_CONTROL_REFUSED_MESSAGE,
  DaemonPipelineExecutionHandle,
  registerDaemonPipelineExecution,
} from '../daemon-pipeline-execution';
import {
  DAEMON_COMMIT_HOOK_TAKEOVER_REFUSED_MESSAGE,
  drainDaemonCommitHooksBeforeTakeover,
  followSurvivingDaemonRuns,
  isDaemonPipelineRouteEligible,
  selectDaemonPipeline,
} from '../daemon-pipeline-route';
import {
  isOwnRendererSender,
  withDaemonPipelineRoute,
} from '../daemon-pipeline-route-context';
import {
  getActivePipelineExecutionCount,
  getActivePipelineExecutionHandles,
  hasActivePipelineExecutions,
  pauseAllActivePipelineExecutions,
  subscribeToActiveCountChange,
} from '../pipeline-execution-registry';
import { collectActiveAutoArchiveTargetKeys } from '../../lib/auto-archive';
import { getExecutionAccounting } from '../../execution-accounting';
import {
  controlPipelineThroughLocalWorker,
  startPipelineThroughLocalWorker,
} from '../pipeline-worker-dispatch';
import { registerDesktopPipelineHostActions } from '../pipeline-host-requests';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  initClaudeModels,
  initCodexModels,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';

const BUNDLED_ACTIONS = resolve(
  __dirname,
  '../../../../../../packages/desktop-shared/resources/actions',
);

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
let executionRuntime: ExecutionRuntime;

/** One fake daemon session; each start writes the state the daemon would. */
interface FakeDaemon {
  readonly client: unknown;
  readonly instructions: {
    name: string;
    params: Record<string, unknown>;
    options: Record<string, unknown>;
  }[];
  readonly abort: AbortController;
  /** Each stream opened, with the frame callback the mirror gave it. */
  readonly streams: {
    name: string;
    params?: unknown;
    onFrame?: (frame: unknown) => void;
  }[];
}

function fakeDaemon(
  answer: (name: string) => Promise<unknown> | undefined = () => undefined,
  status: ExecutionState['status'] = 'running',
): FakeDaemon {
  const abort = new AbortController();
  const instructions: FakeDaemon['instructions'] = [];
  const streams: FakeDaemon['streams'] = [];
  return {
    abort,
    instructions,
    streams,
    client: {
      signal: abort.signal,
      instruction: async (
        name: string,
        params: Record<string, unknown>,
        options: Record<string, unknown>,
      ): Promise<unknown> => {
        mockCalls.push(name);
        instructions.push({ name, params, options });
        const answered = answer(name);
        if (answered) return answered;
        const executionId = String(params.executionId);
        const state = runningState(executionId);
        state.status = status;
        await saveExecutionState(state, executionRuntime.executionsDir);
        return { execution: { executionId, status: 'running' } };
      },
      openStream: (name: string, params?: unknown): Promise<unknown> => {
        const stream: FakeDaemon['streams'][number] = { name, params };
        streams.push(stream);
        return Promise.resolve({
          onFrame: (callback: (frame: unknown) => void): (() => void) => {
            stream.onFrame = callback;
            return () => undefined;
          },
          close: (): void => undefined,
        });
      },
    },
  };
}

const SHELL_PIPELINE: Pipeline = {
  name: 'Route',
  on: 'dispatch',
  jobs: { j: { steps: [{ id: 'echo', run: 'echo hi' }] } },
};
const HOST_PIPELINE: Pipeline = {
  name: 'Route',
  on: 'dispatch',
  jobs: {
    j: {
      steps: [
        {
          id: 'wt',
          uses: 'builtin/create-worktree',
          with: { project_id: 'project', branch: 'made' },
        },
        { id: 'echo', run: 'echo "${{ steps.wt.outputs.path }}"' },
      ],
    },
  },
};
const NOTIFY_PIPELINE: Pipeline = {
  name: 'Route',
  on: 'dispatch',
  jobs: {
    j: {
      steps: [
        {
          id: 'notify',
          uses: 'builtin/notify',
          with: { title: 'Daemon run', body: 'It finished.' },
        },
      ],
    },
  },
};
const ATTACHING_PIPELINE: Pipeline = {
  name: 'Route',
  on: 'dispatch',
  jobs: {
    j: {
      steps: [
        {
          id: 'send',
          uses: 'builtin/send-agent-message',
          with: {
            project_id: 'project',
            task_id: 'task',
            chat_id: 'chat',
            text: 'Hello',
            attachments: '[]',
          },
        },
      ],
    },
  },
};
const MODEL_PIPELINE: Pipeline = {
  name: 'Route',
  on: 'dispatch',
  jobs: { j: { steps: [{ id: 'ask', uses: 'builtin/agent-prompt' }] } },
};
const CODEX_PIPELINE: Pipeline = {
  name: 'Route',
  on: 'dispatch',
  jobs: {
    j: {
      steps: [
        {
          id: 'ask',
          uses: 'builtin/agent-prompt',
          with: { model: DEFAULT_CODEX_MODEL, permission_preset: 'read_only' },
        },
      ],
    },
  },
};

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

/** The host-local launch the fake daemon's first start carried. */
function sentLaunch(daemon: FakeDaemon): unknown {
  return readField(
    readField(daemon.instructions[0]?.options, 'execution'),
    'pipelineLaunch',
  );
}

/** The worktree the fake daemon records its runs against. */
let storedWorktreeId = 'task';

function runningState(executionId: string): ExecutionState {
  const state = createInitialState(
    normalizePipeline(SHELL_PIPELINE),
    { cwd: root, pipelineId: 'pipeline', runtime: executionRuntime },
    executionId,
  );
  state.status = 'running';
  state.project_id = 'project';
  state.worktree_id = storedWorktreeId;
  return state;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

function fakeHandle(executionId: string): ExecutionHandle {
  const state = runningState(executionId);
  return {
    id: executionId,
    cancel: () => Promise.resolve(state),
    getState: () => state,
    waitForCompletion: () => new Promise<ExecutionState>(() => undefined),
  };
}

function start(
  pipeline: Pipeline,
  initiationSource: UsageInitiationSource = 'user',
  trigger: Partial<ExecutionOptions> = {},
): Promise<ExecutionHandle> {
  const executionId = randomUUID();
  const options: ExecutionOptions & {
    executionId: string;
    executionContext: string;
    secretBindings: [];
  } = {
    executionId,
    executionContext: 'personal',
    secretBindings: [],
    pipelineId: 'pipeline',
    cwd: root,
    scope: 'worktree',
    projectId: 'project',
    worktreeId: 'task',
    target: {
      scope: 'worktree',
      workspace_id: 'project',
      worktree_id: 'task',
      path: root,
      created: false,
    },
    initiationSource,
    runtime: executionRuntime,
    ...trigger,
  };
  return startPipelineThroughLocalWorker(pipeline, options);
}

/** A start from the `pipelines:execute` handler for a local window. */
function routed(
  pipeline: Pipeline,
  initiationSource?: UsageInitiationSource,
  trigger?: Partial<ExecutionOptions>,
): Promise<ExecutionHandle> {
  return withDaemonPipelineRoute(
    selectDaemonPipeline({ localWindow: true }),
    () => start(pipeline, initiationSource, trigger),
  );
}

beforeAll(() => {
  // A routed start reads the login-shell PATH; don't run the user's shell.
  setLoginShellProbe(() => Promise.resolve(undefined));
});

afterAll(() => {
  setLoginShellProbe(undefined);
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-pipeline-route-'));
  executionRuntime = {
    executionsDir: join(root, 'pipeline-executions'),
    tempRootDir: join(root, 'tmp'),
    bundledActionsDir: BUNDLED_ACTIONS,
    getProjectActionsDir: (repoPath: string): string => repoPath,
    getProjectPipelinesDir: (repoPath: string): string => repoPath,
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
  };
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
  setDesktopCanopyRuntime(runtime);
  mockGet.mockReset();
  mockShowOsNotification.mockReset();
  mockExecutePipeline.mockReset();
  mockExecutePipeline.mockImplementation(
    (_pipeline, options: ExecutionOptions) =>
      Promise.resolve(fakeHandle(options.executionId ?? randomUUID())),
  );
  mockLabsSnapshot.mockClear();
  mockFallbacks.length = 0;
  mockOwnerPossible.mockReturnValue(false);
  mockEnsureOwner.mockReset();
  mockEnsureOwner.mockResolvedValue(undefined);
  mockCalls.length = 0;
  registerDesktopPipelineHostActions(executionRuntime, {
    run: () => Promise.reject(new Error('Not applied in this test.')),
  });
  storedWorktreeId = 'task';
});

afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('daemon pipeline route (CAN-5086)', () => {
  it('admits only local windows on macOS, Linux and Windows (CAN-5091)', () => {
    const platforms: (PlatformOperatingSystem | null)[] = [
      'darwin',
      'linux',
      'win32',
      null,
    ];
    for (const platform of platforms)
      for (const localWindow of [true, false, undefined])
        for (const daemonLatched of [false, true])
          expect(
            isDaemonPipelineRouteEligible({
              platform,
              daemonLatched,
              context: localWindow === undefined ? undefined : { localWindow },
            }),
          ).toBe(platform !== null && localWindow === true && !daemonLatched);
  });

  it("App Advisor's hosted view counts as a local window; its blank shell, a closed page and other senders do not", () => {
    const mainContents = {};
    const shellContents = {};
    const viewContents = {};
    const main = {
      webContents: mainContents,
      isDestroyed: (): boolean => false,
    };
    // App Advisor's renderer runs in a view its window hosts.
    const advisorView = {
      webContents: viewContents,
      isDestroyed: (): boolean => false,
    };
    expect(isOwnRendererSender(mainContents, [main, advisorView])).toBe(true);
    expect(isOwnRendererSender(viewContents, [main, advisorView])).toBe(true);
    expect(isOwnRendererSender(shellContents, [main, advisorView])).toBe(false);
    expect(isOwnRendererSender({}, [main, null])).toBe(false);
    expect(
      isOwnRendererSender(viewContents, [
        main,
        { webContents: viewContents, isDestroyed: (): boolean => true },
      ]),
    ).toBe(false);
  });

  it('Portal, agent, hook and automation starts never take the route', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    await start(SHELL_PIPELINE);
    for (const source of [
      'hook',
      'automation',
      'app_advisor',
      'portal',
    ] as const)
      await routed(SHELL_PIPELINE, source);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(5);
    expect(mockGet).not.toHaveBeenCalled();
    expect(daemon.instructions).toEqual([]);
  });

  it('a renderer dispatch takes the route and any other trigger runs in process', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    // The dispatch modal names the executor's default event and leaves the
    // source and scope for main and dispatch to derive.
    await routed(SHELL_PIPELINE, 'user', {
      initiationSource: undefined,
      scope: undefined,
      eventName: 'dispatch',
    });
    expect(daemon.instructions).toHaveLength(1);
    expect(daemon.instructions[0]?.params).toMatchObject({
      runScope: 'worktree',
    });
    expect(mockExecutePipeline).not.toHaveBeenCalled();
    const triggers: Partial<ExecutionOptions>[] = [
      { eventName: 'task_ready' },
      { eventName: 'plan_ready' },
      { eventName: 'dispatch', eventData: {} },
      { planId: 'plan' },
    ];
    for (const trigger of triggers)
      await routed(SHELL_PIPELINE, 'user', trigger);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(4);
    expect(daemon.instructions).toHaveLength(1);
  });

  it('a launch with a path outside the worktree and data root runs in process', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    const elsewhere = mkdtempSync(join(tmpdir(), 'daemon-pipeline-elsewhere-'));
    try {
      for (const assetPaths of [{ data: elsewhere }, { data: '' }])
        await routed(SHELL_PIPELINE, 'user', { assetPaths });
      await routed(SHELL_PIPELINE, 'user', { pipelineFileDir: elsewhere });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    expect(mockExecutePipeline).toHaveBeenCalledTimes(3);
    expect(mockGet).not.toHaveBeenCalled();
    // Paths in the worktree still take the route.
    await routed(SHELL_PIPELINE, 'user', { assetPaths: { data: root } });
    expect(daemon.instructions).toHaveLength(1);
  });

  it('a routed run ends with its lifecycle event and its output keeps its iteration', async () => {
    const events: string[] = [];
    const iterations: (number | undefined)[] = [];
    const observers: Partial<ExecutionOptions> = {
      onEvent: (event) => events.push(event.type),
      onStepOutput: (event) => iterations.push(event.iteration),
    };
    // A run that finished before main followed it.
    mockGet.mockResolvedValue({
      client: fakeDaemon(undefined, 'success').client,
    });
    await routed(SHELL_PIPELINE, 'user', observers);
    await waitFor(() => events.length === 2);
    expect(events).toEqual(['execution.started', 'execution.completed']);

    events.length = 0;
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    const handle = await routed(SHELL_PIPELINE, 'user', observers);
    await waitFor(() => daemon.streams.length === 1);
    const [stream] = daemon.streams;
    const frame = (item: Record<string, unknown>): void =>
      stream?.onFrame?.({ kind: 'item', item });
    const state = handle.getState();
    const job = state.jobs.j;
    if (!job) throw new Error('No job.');
    job.iteration_count = 2;
    await saveExecutionState(state, executionRuntime.executionsDir);
    // The stream's own start is the one main already delivered.
    frame({ kind: 'execution', event: 'execution.started', execution: {} });
    frame({ kind: 'execution', event: 'execution.updated', execution: {} });
    frame({
      kind: 'output',
      jobId: 'j',
      stepId: 'echo',
      stream: 'stdout',
      text: 'second\n',
      truncated: false,
    });
    // Output queued from iteration 1 keeps its own label after the job moved on.
    frame({
      kind: 'output',
      jobId: 'j',
      stepId: 'echo',
      attempt: 0,
      iteration: 1,
      stream: 'stdout',
      text: 'first\n',
      truncated: false,
    });
    await waitFor(() => iterations.length === 2);
    expect(iterations).toEqual([2, 1]);
    await saveExecutionState(
      { ...state, status: 'failure' },
      executionRuntime.executionsDir,
    );
    // The reload, not the item's own event, says how the run ended.
    frame({ kind: 'execution', event: 'execution.updated', execution: {} });
    await handle.waitForCompletion();
    expect(events).toEqual([
      'execution.started',
      'execution.updated',
      'execution.failed',
    ]);

    // A host lost after the run finished still ends it with its outcome.
    events.length = 0;
    const lost = fakeDaemon();
    mockGet.mockResolvedValue({ client: lost.client });
    const lostHandle = await routed(SHELL_PIPELINE, 'user', observers);
    await waitFor(() => lost.streams.length === 1);
    await saveExecutionState(
      { ...lostHandle.getState(), status: 'success' },
      executionRuntime.executionsDir,
    );
    lost.streams[0]?.onFrame?.({
      kind: 'end',
      outcome: 'error',
      error: { code: 'worker.pipeline.hostLost' },
    });
    await lostHandle.waitForCompletion();
    expect(events).toEqual(['execution.started', 'execution.completed']);
  });

  it("a workflow with a notify step runs in the daemon, and main shows its notification as an in-process run's", async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    const handle = await routed(NOTIFY_PIPELINE);
    expect(mockExecutePipeline).not.toHaveBeenCalled();
    expect(daemon.instructions.map(({ name }) => name)).toEqual([
      'worker.pipeline.execution.start',
    ]);
    await waitFor(() => daemon.streams.length === 1);
    daemon.streams[0]?.onFrame?.({
      kind: 'item',
      item: {
        kind: 'notification',
        stepId: 'notify',
        title: 'Daemon run',
        body: 'It finished.',
      },
    });
    await waitFor(() => mockShowOsNotification.mock.calls.length === 1);
    expect(mockShowOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Daemon run', body: 'It finished.' }),
      expect.any(Function),
    );
    expect(handle.getState().status).toBe('running');
  });

  // CAN-5868 review fix: the store can be ahead of the events stream.
  it('a notification behind the item that settled the run still shows', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    const handle = await routed(NOTIFY_PIPELINE);
    await waitFor(() => daemon.streams.length === 1);
    const [stream] = daemon.streams;
    await saveExecutionState(
      { ...handle.getState(), status: 'success' },
      executionRuntime.executionsDir,
    );
    // The stream still says running when the store already says success.
    stream?.onFrame?.({
      kind: 'item',
      item: {
        kind: 'execution',
        event: 'execution.updated',
        execution: { status: 'running' },
      },
    });
    stream?.onFrame?.({
      kind: 'item',
      item: {
        kind: 'notification',
        stepId: 'notify',
        title: 'Daemon run',
        body: 'It finished.',
      },
    });
    await handle.waitForCompletion();
    await waitFor(() => mockShowOsNotification.mock.calls.length === 1);
    expect(mockShowOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Daemon run', body: 'It finished.' }),
      expect.any(Function),
    );
  });

  // CAN-5868 review fix: the run can end while main's stream is down.
  it('a run that ended while its stream was down still shows the notifications sent meanwhile', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    const handle = await routed(NOTIFY_PIPELINE);
    await waitFor(() => daemon.streams.length === 1);
    await saveExecutionState(
      { ...handle.getState(), status: 'success' },
      executionRuntime.executionsDir,
    );
    daemon.streams[0]?.onFrame?.({
      kind: 'end',
      outcome: 'error',
      error: { code: 'transport.connectionLost' },
    });
    await handle.waitForCompletion();
    await waitFor(() => daemon.streams.length === 2);
    daemon.streams[1]?.onFrame?.({
      kind: 'item',
      item: {
        kind: 'notification',
        stepId: 'notify',
        title: 'Daemon run',
        body: 'It finished.',
      },
    });
    await waitFor(() => mockShowOsNotification.mock.calls.length === 1);
  });

  // CAN-5868 review fix: the stream that collects them can drop too.
  it('a collecting stream that drops with an error is opened once more', async () => {
    const daemon = fakeDaemon(undefined, 'success');
    mockGet.mockResolvedValue({ client: daemon.client });
    const handle = await routed(NOTIFY_PIPELINE);
    await handle.waitForCompletion();
    await waitFor(() => daemon.streams.length === 1);
    daemon.streams[0]?.onFrame?.({
      kind: 'end',
      outcome: 'error',
      error: { code: 'transport.connectionLost' },
    });
    await waitFor(() => daemon.streams.length === 2);
    daemon.streams[1]?.onFrame?.({
      kind: 'item',
      item: {
        kind: 'notification',
        stepId: 'notify',
        title: 'Daemon run',
        body: 'It finished.',
      },
    });
    await waitFor(() => mockShowOsNotification.mock.calls.length === 1);
  });

  // CAN-5868 review fix: a short run can settle before main follows it.
  it('a run that settled before main followed it still shows the notifications it sent', async () => {
    const events: string[] = [];
    const daemon = fakeDaemon(undefined, 'success');
    mockGet.mockResolvedValue({ client: daemon.client });
    await routed(NOTIFY_PIPELINE, 'user', {
      onEvent: (event) => events.push(event.type),
    });
    await waitFor(() => events.length === 2);
    expect(events).toEqual(['execution.started', 'execution.completed']);
    await waitFor(() => daemon.streams.length === 1);
    daemon.streams[0]?.onFrame?.({
      kind: 'item',
      item: {
        kind: 'notification',
        stepId: 'notify',
        title: 'Daemon run',
        body: 'It finished.',
      },
    });
    await waitFor(() => mockShowOsNotification.mock.calls.length === 1);
    expect(events).toEqual(['execution.started', 'execution.completed']);
  });

  it('a workflow with host steps takes the daemon route only when this app spawned the daemon', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    await routed(HOST_PIPELINE);
    // A host request the daemon raises before the start returns finds the
    // run's host steps: they are known from before the send until the
    // mirror is registered.
    expect(mockCalls).toEqual([
      'ensureDaemonPipelineOwnerSettlement',
      'expectDaemonPipelineHostSteps',
      'worker.pipeline.execution.start',
      'released',
    ]);
    expect(daemon.instructions[0]?.options).toMatchObject({
      execution: { pipelineLaunch: { ownerBound: true } },
    });
    expect(mockExecutePipeline).not.toHaveBeenCalled();

    mockGet.mockClear();
    mockOwnerPossible.mockReturnValue(false);
    await routed(HOST_PIPELINE);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
    expect(daemon.instructions).toHaveLength(1);
  });

  it('a workflow without host steps is never owner-bound', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    await routed(SHELL_PIPELINE);
    expect(mockEnsureOwner).not.toHaveBeenCalled();
    expect(daemon.instructions[0]?.options).not.toHaveProperty(
      'execution.pipelineLaunch.ownerBound',
    );
  });

  it('an owner settlement that cannot open runs the start in process with no warning', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    mockEnsureOwner.mockRejectedValue(new Error('Not the owner.'));
    await routed(HOST_PIPELINE);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(daemon.instructions).toHaveLength(0);
    expect(mockFallbacks).toEqual([]);
  });

  it('a daemon that answers ownerUnavailable runs the start in process', async () => {
    const refusing = fakeDaemon((name) =>
      name === 'worker.pipeline.execution.start'
        ? Promise.reject(
            new CanopyClientError({
              kind: 'failed_precondition',
              code: 'worker.pipeline.ownerUnavailable',
              message: 'No owner.',
              retry: { kind: 'never' },
            }),
          )
        : undefined,
    );
    mockGet.mockResolvedValue({ client: refusing.client });
    mockOwnerPossible.mockReturnValue(true);
    await routed(HOST_PIPELINE);
    expect(refusing.instructions).toHaveLength(1);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(mockFallbacks).toEqual([]);
  });

  it('a send-agent-message step with a named model runs in process', async () => {
    mockOwnerPossible.mockReturnValue(true);
    await routed({
      name: 'Route',
      on: 'dispatch',
      jobs: {
        j: {
          steps: [
            {
              id: 'send',
              uses: 'builtin/send-agent-message',
              with: {
                project_id: 'project',
                task_id: 'task',
                chat_id: 'chat',
                text: 'Hello',
                model: 'sonnet',
              },
            },
          ],
        },
      },
    });
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('a send-agent-message step with attachments runs in process', async () => {
    mockOwnerPossible.mockReturnValue(true);
    await routed(ATTACHING_PIPELINE);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockEnsureOwner).not.toHaveBeenCalled();
  });

  it('a pipeline with a model step runs in process and the daemon is never contacted', async () => {
    await routed(MODEL_PIPELINE);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('Claude model steps go to the daemon, owner-bound, when this app owns it (CAN-5095)', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    await routed(MODEL_PIPELINE, 'user', {
      modelConfig: { thinkingLevel: 'high' },
    });
    expect(mockExecutePipeline).not.toHaveBeenCalled();
    const [sent] = daemon.instructions;
    expect(sent?.name).toBe('worker.pipeline.execution.start');
    expect(sent?.params).not.toHaveProperty('secrets');
    const launch = sentLaunch(daemon);
    expect(launch).toMatchObject({
      ownerBound: true,
      modelConfig: { thinkingLevel: 'high' },
    });
    expect(
      typeof readField(readField(launch, 'providerBinaries'), 'claude'),
    ).toBe('string');
    expect(
      typeof readField(readField(launch, 'providerBinaries'), 'codex'),
    ).toBe('string');
    // The app's own bundled resources, for builtin skills (CAN-5832).
    expect(typeof readField(launch, 'bundledResourcesDir')).toBe('string');
    expect(
      typeof readField(readField(launch, 'modelCatalog'), 'MODEL_CATALOG'),
    ).toBe('string');
    expect(
      typeof readField(
        readField(launch, 'modelCatalog'),
        'MODEL_HARNESS_ASSIGNMENTS',
      ),
    ).toBe('string');
    expect(launch).not.toHaveProperty('codexEnvironment');
  });

  it('git-commit-push goes to the daemon saying Electron main runs its hook (CAN-6012 D3)', async () => {
    initClaudeModels([{ id: DEFAULT_CLAUDE_MODEL, label: 'Claude' }]);
    const commit: Pipeline = {
      name: 'Route',
      on: 'dispatch',
      jobs: {
        j: {
          steps: [
            {
              id: 'commit',
              uses: 'builtin/git-commit-push',
              with: { commit_model: DEFAULT_CLAUDE_MODEL },
            },
          ],
        },
      },
    };
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    await routed(commit);
    expect(mockExecutePipeline).not.toHaveBeenCalled();
    expect(sentLaunch(daemon)).toMatchObject({
      ownerBound: true,
      precommitHooks: 'owner',
    });
    // Startup catches up on this run's commit results if nothing follows it.
    const [sent] = daemon.instructions;
    const sentId = readField(sent?.params, 'executionId');
    if (typeof sentId !== 'string') throw new Error('No execution id.');
    expect(
      existsSync(
        daemonCommitHooksPendingPath(executionRuntime.executionsDir, sentId),
      ),
    ).toBe(true);

    // Without the owner, nothing runs the hook: the run stays in process,
    // with no mark for startup.
    mockExecutePipeline.mockClear();
    mockOwnerPossible.mockReturnValue(false);
    await routed(commit);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    const call: unknown = mockExecutePipeline.mock.calls[0];
    const options = readField(call, '1');
    const inAppId = readField(options, 'executionId');
    if (typeof inAppId !== 'string') throw new Error('No execution id.');
    expect(
      existsSync(
        daemonCommitHooksPendingPath(executionRuntime.executionsDir, inAppId),
      ),
    ).toBe(false);
  });

  it('catches up at startup on commit results of daemon runs nothing followed (CAN-6012 D3)', async () => {
    const executionsDir = executionRuntime.executionsDir;
    const pipeline: Pipeline = {
      name: 'Route',
      on: 'dispatch',
      jobs: {
        j: { steps: [{ id: 'commit', uses: 'builtin/git-commit-push' }] },
      },
    };
    const stored = async (
      executionId: string,
      status: 'paused' | 'success' | 'running',
      pending: boolean,
    ): Promise<void> => {
      const state = createInitialState(
        normalizePipeline(pipeline),
        { cwd: root, pipelineId: 'pipeline', runtime: executionRuntime },
        executionId,
      );
      state.status = status;
      state.project_id = 'project';
      state.worktree_id = 'task';
      Object.assign(state.jobs.j?.steps.commit ?? {}, {
        status: 'failure',
        outputs: {
          results_json: JSON.stringify([
            { repoName: executionId, repoPath: root, status: 'failed' },
          ]),
        },
        started_at: '2026-11-10T10:00:00.000Z',
        completed_at: '2026-11-10T10:01:00.000Z',
      });
      await saveExecutionState(state, executionsDir);
      if (pending)
        await markDaemonCommitHooksPending(executionsDir, executionId);
    };
    // Paused when the app quit before its follower's scan claimed the
    // result; ended with its result already claimed; still running in the
    // daemon, so its follower scans it; and a run that stayed in the app,
    // whose in-process hook already ran.
    await stored('run-paused', 'paused', true);
    await stored('run-claimed', 'success', true);
    await stored('run-running', 'running', true);
    await stored('run-in-app', 'success', false);
    const fired: string[] = [];
    const ports = {
      fire: ({
        results,
      }: {
        readonly results: readonly { readonly repoName?: string }[];
      }): Promise<void> => {
        fired.push(results[0]?.repoName ?? '');
        return Promise.resolve();
      },
      warn: (): void => undefined,
    };
    const claimed = await loadExecutionState('run-claimed', executionsDir);
    if (!claimed) throw new Error('No state.');
    await runDaemonCommitHooks({
      state: claimed,
      executionsDir,
      scope: { projectId: 'project', worktreeId: 'task' },
      handled: new Set(),
      ports,
    });
    expect(fired).toEqual(['run-claimed']);

    const scan = await scanInterruptedWork([], executionsDir);
    expect([...scan.daemonCommitHookIds].sort()).toEqual([
      'run-claimed',
      'run-paused',
      'run-running',
    ]);
    const catchUp = (): Promise<readonly string[]> =>
      catchUpDaemonCommitHooks({
        // A mark whose run left no state is only cleared.
        executionIds: [...scan.daemonCommitHookIds, 'run-gone'],
        executionsDir,
        load: (executionId) => loadExecutionState(executionId, executionsDir),
        scopeOf: (state) =>
          Promise.resolve(
            state.project_id && state.worktree_id
              ? {
                  scope: {
                    projectId: state.project_id,
                    worktreeId: state.worktree_id,
                  },
                }
              : undefined,
          ),
        ports,
      });
    await markDaemonCommitHooksPending(executionsDir, 'run-gone');
    await catchUp();
    await catchUp();
    expect(fired).toEqual(['run-claimed', 'run-paused']);
    const pending = (executionId: string): boolean =>
      existsSync(daemonCommitHooksPendingPath(executionsDir, executionId));
    expect(pending('run-paused')).toBe(false);
    expect(pending('run-claimed')).toBe(false);
    expect(pending('run-gone')).toBe(false);
    expect(pending('run-running')).toBe(true);

    // A state that cannot be read keeps its mark for the next start.
    await markDaemonCommitHooksPending(executionsDir, 'run-unreadable');
    const warnedIds: string[] = [];
    const undrained = await catchUpDaemonCommitHooks({
      executionIds: ['run-unreadable'],
      executionsDir,
      load: () =>
        Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
      scopeOf: () =>
        Promise.resolve({
          scope: { projectId: 'project', worktreeId: 'task' },
        }),
      ports: {
        ...ports,
        warn: (_message, details): void => {
          warnedIds.push(details.executionId ?? '');
        },
      },
    });
    expect(pending('run-unreadable')).toBe(true);
    expect(warnedIds).toEqual(['run-unreadable']);
    expect(undrained).toEqual(['run-unreadable']);

    // The app never takes over a run it could not drain: in-process hooks
    // would otherwise run beside the daemon's unclaimed ones.
    const drained: string[][] = [];
    const drain = (ids: readonly string[]): Promise<readonly string[]> => {
      drained.push([...ids]);
      return Promise.resolve(ids.filter((id) => id === 'run-unreadable'));
    };
    await expect(
      drainDaemonCommitHooksBeforeTakeover(
        'run-unreadable',
        executionsDir,
        drain,
      ),
    ).rejects.toThrow(DAEMON_COMMIT_HOOK_TAKEOVER_REFUSED_MESSAGE);
    await expect(
      drainDaemonCommitHooksBeforeTakeover('run-paused', executionsDir, drain),
    ).resolves.toBeUndefined();
    expect(drained).toEqual([['run-unreadable'], ['run-paused']]);
  });

  it("keeps a run's pending mark until every scan's claim and hook have finished (CAN-6012 D3)", async () => {
    const executionsDir = executionRuntime.executionsDir;
    const pipeline: Pipeline = {
      name: 'Route',
      on: 'dispatch',
      jobs: {
        j: { steps: [{ id: 'commit', uses: 'builtin/git-commit-push' }] },
      },
    };
    const state = createInitialState(
      normalizePipeline(pipeline),
      { cwd: root, pipelineId: 'pipeline', runtime: executionRuntime },
      'run-overlap',
    );
    state.status = 'failure';
    Object.assign(state.jobs.j?.steps.commit ?? {}, {
      status: 'failure',
      outputs: {
        results_json: JSON.stringify([
          { repoName: 'repo', repoPath: root, status: 'failed' },
        ]),
      },
      started_at: '2026-11-10T10:00:00.000Z',
      completed_at: '2026-11-10T10:00:30.000Z',
    });
    await markDaemonCommitHooksPending(executionsDir, state.id);
    const pending = (): boolean =>
      existsSync(daemonCommitHooksPendingPath(executionsDir, state.id));
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fired = 0;
    const warned: Record<string, string>[] = [];
    const follower = new DaemonCommitHookFollower({
      executionId: state.id,
      executionsDir,
      scope: { projectId: 'project', worktreeId: 'task' },
      ports: {
        fire: async (): Promise<void> => {
          fired += 1;
          await blocked;
        },
        warn: (_message, details): void => {
          warned.push(details);
        },
      },
    });
    // Two reloads of the ended state: the second waits for the first, so
    // the mark stays while the first hook is still running.
    const first = follower.scan(state);
    const second = follower.scan(state);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toBe(1);
    expect(pending()).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(fired).toBe(1);
    expect(pending()).toBe(false);
    expect(warned).toEqual([]);

    // A claim that fails is not remembered: the mark stays, and a later
    // scan claims the result and fires it.
    const retried = createInitialState(
      normalizePipeline(pipeline),
      { cwd: root, pipelineId: 'pipeline', runtime: executionRuntime },
      'run-claim-fails',
    );
    retried.status = 'failure';
    Object.assign(retried.jobs.j?.steps.commit ?? {}, {
      ...structuredClone(state.jobs.j?.steps.commit),
    });
    await markDaemonCommitHooksPending(executionsDir, retried.id);
    const markerDir = dirname(
      daemonCommitHookMarkerPath(
        executionsDir,
        retried.id,
        daemonCommitHookKey(retried.id, 'j', 'commit', {
          started_at: '2026-11-10T10:00:00.000Z',
          completed_at: '2026-11-10T10:00:30.000Z',
        }),
      ),
    );
    // A file where the claim's folder goes makes the claim fail.
    writeFileSync(markerDir, '');
    const retryFollower = new DaemonCommitHookFollower({
      executionId: retried.id,
      executionsDir,
      scope: { projectId: 'project', worktreeId: 'task' },
      ports: {
        fire: (): Promise<void> => {
          fired += 1;
          return Promise.resolve();
        },
        warn: (_message, details): void => {
          warned.push(details);
        },
      },
    });
    await retryFollower.scan(retried);
    expect(fired).toBe(1);
    expect(warned).toEqual([{ executionId: retried.id }]);
    expect(
      existsSync(daemonCommitHooksPendingPath(executionsDir, retried.id)),
    ).toBe(true);
    rmSync(markerDir);
    await retryFollower.scan(retried);
    expect(fired).toBe(2);
    expect(
      existsSync(daemonCommitHooksPendingPath(executionsDir, retried.id)),
    ).toBe(false);
  });

  it('never fires again for a run the app takes over (CAN-6012 D3)', async () => {
    // A paused daemon run resumes in the app, whose post-process fires its
    // later results with no marker. The daemon's results are claimed when
    // the follower's final scan sees the pause, or by the drain before the
    // takeover; then the mark is gone and no later start replays anything.
    const executionsDir = executionRuntime.executionsDir;
    const pipeline: Pipeline = {
      name: 'Route',
      on: 'dispatch',
      jobs: {
        j: { steps: [{ id: 'commit', uses: 'builtin/git-commit-push' }] },
      },
    };
    const state = createInitialState(
      normalizePipeline(pipeline),
      { cwd: root, pipelineId: 'pipeline', runtime: executionRuntime },
      'run-taken-over',
    );
    state.status = 'paused';
    state.project_id = 'project';
    state.worktree_id = 'task';
    const failed = (repoName: string, minute: string): object => ({
      status: 'failure',
      outputs: {
        results_json: JSON.stringify([
          { repoName, repoPath: root, status: 'failed' },
        ]),
      },
      started_at: `2026-11-10T10:${minute}:00.000Z`,
      completed_at: `2026-11-10T10:${minute}:30.000Z`,
    });
    Object.assign(state.jobs.j?.steps.commit ?? {}, failed('daemon', '00'));
    await saveExecutionState(state, executionsDir);
    await markDaemonCommitHooksPending(executionsDir, state.id);
    expect(daemonCommitHooksDone(state)).toBe(true);
    const fired: string[] = [];
    const catchUp = (
      executionIds: readonly string[],
    ): Promise<readonly string[]> =>
      catchUpDaemonCommitHooks({
        executionIds,
        executionsDir,
        load: (executionId) => loadExecutionState(executionId, executionsDir),
        scopeOf: () =>
          Promise.resolve({
            scope: { projectId: 'project', worktreeId: 'task' },
          }),
        ports: {
          fire: ({ results }): Promise<void> => {
            fired.push(results[0]?.repoName ?? '');
            return Promise.resolve();
          },
          warn: (): void => undefined,
        },
      });
    // The drain before the takeover claims the daemon's result.
    await catchUp([state.id]);
    expect(fired).toEqual(['daemon']);
    expect(
      existsSync(daemonCommitHooksPendingPath(executionsDir, state.id)),
    ).toBe(false);
    // The resumed run's own result, fired by the in-process post-process.
    Object.assign(state.jobs.j?.steps.commit ?? {}, failed('in-app', '05'));
    state.status = 'success';
    await saveExecutionState(state, executionsDir);
    // The next start, and a drain for any run that never left the app.
    await catchUp([state.id]);
    expect(fired).toEqual(['daemon']);
  });

  it('a production build never hands a daemon model step the mock LLM route, whatever its environment sets (CAN-5095)', async () => {
    // Jest compiles __CANOPY_E2E__ as release builds do: absent.
    process.env.CANOPY_MOCK_LLM_BASE_URL = 'http://127.0.0.1:4011';
    process.env.CANOPY_MOCK_API_KEY = 'mock-canary-5095';
    try {
      const daemon = fakeDaemon();
      mockGet.mockResolvedValue({ client: daemon.client });
      mockOwnerPossible.mockReturnValue(true);
      await routed(MODEL_PIPELINE);
      // The seam writes only the launch's env; the base environment is
      // CAN-5086's filtered inherited one.
      expect(readField(sentLaunch(daemon), 'env')).toEqual({});
      expect(JSON.stringify(daemon.instructions[0]?.options)).not.toContain(
        'mock-canary-5095',
      );
    } finally {
      delete process.env.CANOPY_MOCK_LLM_BASE_URL;
      delete process.env.CANOPY_MOCK_API_KEY;
    }
  });

  it('a run in Claude terminal mode runs in process (CAN-5095)', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    await routed(MODEL_PIPELINE, 'user', { agentTerminalMode: true });
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(daemon.instructions).toHaveLength(0);
  });

  it('plugin collection steps on Claude go to the daemon with the snapshots the executor would resolve (CAN-5832)', async () => {
    initClaudeModels([{ id: DEFAULT_CLAUDE_MODEL, label: 'Claude' }]);
    initCodexModels([{ id: DEFAULT_CODEX_MODEL, label: 'Codex' }]);
    const selections = (mcp: boolean): ChatTabPluginSelections => ({
      collectionIds: [],
      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
      pluginRefs: [],
      ...(mcp && { mcpServerRefs: [{ serverId: 'github', configId: 'd' }] }),
    });
    let mcp = false;
    let required = false;
    const resolverPreferences: unknown[] = [];
    executionRuntime.resolvePipelinePluginCollections = (
      collections,
      preferences,
    ): Promise<PipelinePluginCollectionResolution> => {
      resolverPreferences.push(preferences);
      return Promise.resolve({
        snapshots: Object.fromEntries(
          (collections ?? []).map(({ id }) => [
            id,
            {
              selections: selections(mcp),
              missingOptionalDefaults: [],
              unresolvedRequiredDefaults: required
                ? [{ defaultKey: 'plugin:x', error: 'X is required.' }]
                : [],
            },
          ]),
        ),
      });
    };
    const collectionPipeline = (model?: string): Pipeline => ({
      name: 'Route',
      on: 'dispatch',
      plugin_collections: [{ id: 'review', name: 'Review', defaults: [] }],
      jobs: {
        j: {
          steps: [
            {
              id: 'ask',
              uses: 'builtin/agent-prompt',
              with: {
                plugin_collection_id: 'review',
                permission_preset: 'read_only',
                ...(model !== undefined ? { model } : {}),
              },
            },
          ],
        },
      },
    });
    const draft = {
      pluginCollectionPreferences: {
        review: {
          disabledDefaultKeys: [],
          extraSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        },
      },
    };
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    await routed(collectionPipeline(), 'user', draft);
    expect(mockExecutePipeline).not.toHaveBeenCalled();
    expect(sentLaunch(daemon)).toMatchObject({
      ownerBound: true,
      pluginCollectionPreferences: draft.pluginCollectionPreferences,
      pluginCollectionSnapshots: {
        review: { selections: selections(false) },
      },
    });
    // The executor's own merge of stored and draft preferences resolved it.
    expect(resolverPreferences[0]).toMatchObject(
      draft.pluginCollectionPreferences,
    );
    // A snapshot that names a standalone MCP server goes as references: an
    // SDK step drops the server in process too (CAN-6011).
    mcp = true;
    await routed(collectionPipeline(), 'user', draft);
    expect(daemon.instructions).toHaveLength(2);
    expect(
      readField(
        readField(daemon.instructions[1]?.options, 'execution'),
        'pipelineLaunch',
      ),
    ).toMatchObject({
      pluginCollectionSnapshots: { review: { selections: selections(true) } },
    });
    mcp = false;
    // A Codex step with a collection, and a snapshot that misses a required
    // default, run in process.
    await routed(collectionPipeline(DEFAULT_CODEX_MODEL), 'user', draft);
    required = true;
    await routed(collectionPipeline(), 'user', draft);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(2);
    expect(daemon.instructions).toHaveLength(2);
    // A collection id with spaces around it, named through an alias, is
    // snapshotted under the trimmed id the executor looks it up by.
    required = false;
    await routed(
      {
        name: 'Route',
        on: 'dispatch',
        plugin_collections: [{ id: ' review ', name: 'Review', defaults: [] }],
        model_aliases: [
          {
            id: 'fast',
            name: 'Fast',
            defaults: {
              base: DEFAULT_CLAUDE_MODEL,
              plugin_collection_id: 'review',
            },
          },
        ],
        jobs: {
          j: {
            steps: [
              {
                id: 'ask',
                uses: 'builtin/agent-prompt',
                with: { model: 'fast', permission_preset: 'read_only' },
              },
            ],
          },
        },
      },
      'user',
      draft,
    );
    expect(mockExecutePipeline).toHaveBeenCalledTimes(2);
    expect(daemon.instructions).toHaveLength(3);
    expect(
      readField(
        readField(daemon.instructions[2]?.options, 'execution'),
        'pipelineLaunch',
      ),
    ).toMatchObject({
      pluginCollectionSnapshots: { review: { selections: selections(false) } },
    });
  });

  it("model alias steps go to the daemon with the run's merged preferences and what each alias names (CAN-5832)", async () => {
    initClaudeModels([{ id: DEFAULT_CLAUDE_MODEL, label: 'Claude' }]);
    const aliasPipeline = (agentId: string): Pipeline => ({
      name: 'Route',
      on: 'dispatch',
      model_aliases: [
        { id: 'fast', name: 'Fast', defaults: { base: 'unset-model' } },
        { id: 'reviewer', name: 'Reviewer', defaults: { agent_id: agentId } },
      ],
      jobs: {
        j: {
          steps: [
            {
              id: 'inline',
              uses: 'builtin/agent-prompt',
              with: { model: 'fast' },
            },
            {
              id: 'agent',
              uses: 'builtin/agent-prompt',
              with: { model: 'reviewer' },
            },
          ],
        },
      },
    });
    const agentScopes: unknown[] = [];
    executionRuntime.resolvePipelineAgentModelAlias = (
      agentId,
      scope,
    ): Promise<PipelineAgentModelAliasResolution | null> => {
      agentScopes.push(scope);
      return Promise.resolve(
        agentId === 'agent_model_missing'
          ? null
          : {
              agentId,
              name: 'Reviewer',
              base: DEFAULT_CLAUDE_MODEL,
              instructions: 'Review carefully.',
              // The Agent store gives every Agent selections, empty when it
              // adds no plugins (CAN-5832 review).
              pluginSelections: {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [],
                ...(agentId === 'agent_model_mcp' && {
                  mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
                }),
              },
            },
      );
    };
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    const preferences = {
      modelAliasPreferences: {
        fast: { mode: 'inline' as const, base: DEFAULT_CLAUDE_MODEL },
        gone: { mode: 'reset' as const },
      },
    };
    await routed(aliasPipeline('agent_model_reviewer'), 'user', preferences);
    expect(mockExecutePipeline).not.toHaveBeenCalled();
    expect(sentLaunch(daemon)).toMatchObject({
      ownerBound: true,
      // Filtered to the pipeline's aliases, as the executor stores them.
      modelAliasPreferences: {
        fast: { mode: 'inline', base: DEFAULT_CLAUDE_MODEL },
      },
      modelAliasResolutions: {
        fast: { base: DEFAULT_CLAUDE_MODEL, plugins: false },
        reviewer: { base: DEFAULT_CLAUDE_MODEL, plugins: false },
      },
    });
    expect(
      readField(readField(sentLaunch(daemon), 'modelAliasPreferences'), 'gone'),
    ).toBeUndefined();
    // Each step resolves its Agent again, so a Claude run with an Agent
    // alias carries the Codex environment the Agent may move to.
    expect(sentLaunch(daemon)).toMatchObject({
      codexEnvironment: {
        environment: { CODEX_ROUTE_ENV: 'value' },
        logicalWorkspaceEnvironmentId: 'pipeline:default',
      },
    });
    expect(agentScopes).toEqual([
      {
        projectId: 'project',
        worktreeId: 'task',
        executionContext: 'personal',
      },
    ]);
    // An Agent that names a standalone MCP server goes to the daemon, whose
    // step drops the server as an SDK step in process does (CAN-6011). One
    // that is not available runs in process.
    await routed(aliasPipeline('agent_model_mcp'), 'user', preferences);
    expect(daemon.instructions).toHaveLength(2);
    expect(
      readField(
        readField(daemon.instructions[1]?.options, 'execution'),
        'pipelineLaunch',
      ),
    ).toMatchObject({
      modelAliasResolutions: {
        reviewer: { base: DEFAULT_CLAUDE_MODEL, plugins: true },
      },
    });
    await routed(aliasPipeline('agent_model_missing'), 'user', preferences);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(daemon.instructions).toHaveLength(2);
  });

  it("a Codex step's launch carries the run's Codex environment (CAN-5095)", async () => {
    initCodexModels([{ id: DEFAULT_CODEX_MODEL, label: 'Codex' }]);
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    await routed(CODEX_PIPELINE);
    expect(daemon.instructions[0]?.options).toMatchObject({
      execution: {
        pipelineLaunch: {
          ownerBound: true,
          codexEnvironment: {
            environment: { CODEX_ROUTE_ENV: 'value' },
            logicalWorkspaceEnvironmentId: 'pipeline:default',
          },
        },
      },
    });
  });

  it('a step whose model names a run input goes to the daemon by the model the input names (CAN-6012)', async () => {
    initCodexModels([{ id: DEFAULT_CODEX_MODEL, label: 'Codex' }]);
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    const pipeline: Pipeline = {
      name: 'Route',
      on: { dispatch: { inputs: { model: { type: 'string' } } } },
      jobs: {
        j: {
          steps: [
            {
              id: 'ask',
              uses: 'builtin/agent-prompt',
              with: { prompt: 'x', model: '${{ inputs.model }}' },
            },
          ],
        },
      },
    };
    await routed(pipeline, 'user', { inputs: { model: DEFAULT_CODEX_MODEL } });
    expect(mockExecutePipeline).not.toHaveBeenCalled();
    expect(daemon.instructions[0]?.options).toMatchObject({
      execution: {
        pipelineLaunch: {
          ownerBound: true,
          inputs: { model: DEFAULT_CODEX_MODEL },
          codexEnvironment: {
            logicalWorkspaceEnvironmentId: 'pipeline:default',
          },
        },
      },
    });
    // A missing input, an undeclared one or a provider the daemon does not
    // run keeps the run in process.
    const refused: Record<string, string>[] = [
      {},
      { other: DEFAULT_CODEX_MODEL },
      { model: 'cursor-default' },
    ];
    for (const inputs of refused) await routed(pipeline, 'user', { inputs });
    expect(mockExecutePipeline).toHaveBeenCalledTimes(3);
    expect(daemon.instructions).toHaveLength(1);
  });

  it('runs a daemon git-commit-push hook once per step result, from the stored outputs (CAN-6012)', async () => {
    const pipeline: Pipeline = {
      name: 'Route',
      on: 'dispatch',
      jobs: {
        j: {
          steps: [
            { id: 'commit', uses: 'builtin/git-commit-push' },
            { id: 'unread', uses: 'builtin/git-commit-push' },
            { id: 'later', uses: 'builtin/git-commit-push' },
            { id: 'echo', run: 'echo out' },
          ],
        },
      },
    };
    const state = createInitialState(
      normalizePipeline(pipeline),
      { cwd: root, pipelineId: 'pipeline', runtime: executionRuntime },
      'run-hooks',
    );
    const job = state.jobs.j;
    if (!job) throw new Error('No job.');
    const failed = JSON.stringify([
      {
        repoName: 'repo',
        repoPath: root,
        status: 'failed',
        failurePhase: 'commit',
        precommitFailureError: 'lint failed',
        commitMessage: 'Fix',
      },
      { repoName: 'other', repoPath: root, status: 'committed' },
    ]);
    const first = {
      started_at: '2026-11-10T10:00:00.000Z',
      completed_at: '2026-11-10T10:01:00.000Z',
    };
    Object.assign(job.steps.commit ?? {}, {
      status: 'failure',
      outputs: { results_json: failed },
      ...first,
    });
    // Settled, but its outputs are gone: a fixed reason, never a guess.
    Object.assign(job.steps.unread ?? {}, { status: 'failure', outputs: {} });
    // Still running, and a step of another action: neither fires.
    Object.assign(job.steps.later ?? {}, {
      status: 'running',
      outputs: { results_json: failed },
    });
    Object.assign(job.steps.echo ?? {}, { status: 'success' });
    const fired: unknown[] = [];
    const warned: Record<string, string>[] = [];
    const ports = {
      fire: (args: unknown): Promise<void> => {
        fired.push(args);
        return Promise.resolve();
      },
      warn: (_message: string, details: Record<string, string>): void => {
        warned.push(details);
      },
    };
    const run = (handled: Set<string>): Promise<void> =>
      runDaemonCommitHooks({
        state,
        executionsDir: executionRuntime.executionsDir,
        scope: { projectId: 'project', worktreeId: 'task' },
        handled,
        ports,
      });
    const follower = new Set<string>();
    await run(follower);
    expect(fired).toEqual([
      {
        projectId: 'project',
        worktreeId: 'task',
        results: [
          expect.objectContaining({ repoName: 'repo', status: 'failed' }),
          expect.objectContaining({ repoName: 'other' }),
        ],
      },
    ]);
    expect(warned).toEqual([
      {
        code: DAEMON_COMMIT_HOOK_SKIP_OUTPUTS_UNAVAILABLE,
        executionId: state.id,
        jobId: 'j',
        stepId: 'unread',
      },
    ]);
    // The same follower, a re-followed run and an app restart (a new
    // follower) all find the attempt handled.
    await run(follower);
    await run(new Set());
    expect(fired).toHaveLength(1);
    expect(warned).toHaveLength(1);
    // A retry archives the attempt and runs the step again: the archived
    // copy keeps its key, and only the new result fires, once.
    job.retry_history = [
      { attempt: 0, status: 'failure', steps: structuredClone(job.steps) },
    ];
    job.retry_count = 1;
    Object.assign(job.steps.commit ?? {}, {
      started_at: '2026-11-10T10:05:00.000Z',
      completed_at: '2026-11-10T10:06:00.000Z',
    });
    await run(new Set());
    await run(new Set());
    expect(fired).toHaveLength(2);
    expect(warned).toHaveLength(1);
    // The marker lives in the run's main-owned host directory, keyed without user text.
    expect(
      existsSync(
        daemonCommitHookMarkerPath(
          executionRuntime.executionsDir,
          state.id,
          daemonCommitHookKey(state.id, 'j', 'commit', first),
        ),
      ),
    ).toBe(true);
  });

  it('finds daemon git-commit-push results a retry or iteration archived, and matrix variants (CAN-6012)', async () => {
    const pipeline: Pipeline = {
      name: 'Route',
      on: 'dispatch',
      jobs: {
        j: { steps: [{ id: 'commit', uses: 'builtin/git-commit-push' }] },
      },
    };
    const state = createInitialState(
      normalizePipeline(pipeline),
      { cwd: root, pipelineId: 'pipeline', runtime: executionRuntime },
      'run-archived',
    );
    const job = state.jobs.j;
    if (!job?.steps.commit) throw new Error('No job.');
    const failedAt = (minute: number): typeof job.steps.commit => ({
      ...structuredClone(job.steps.commit),
      status: 'failure',
      outputs: {
        results_json: JSON.stringify([
          {
            repoName: `repo-${String(minute)}`,
            repoPath: root,
            status: 'failed',
          },
        ]),
      },
      started_at: `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`,
      completed_at: `2026-11-10T10:${String(minute).padStart(2, '0')}:30.000Z`,
    });
    // The follower was away while the executor archived three results: an
    // iteration of the current attempt, and an earlier attempt with one of
    // its own iterations. The current attempt is still running.
    job.iteration_history = [
      { iteration: 1, status: 'restarting', steps: { commit: failedAt(3) } },
    ];
    job.retry_history = [
      {
        attempt: 0,
        status: 'failure',
        steps: { commit: failedAt(2) },
        iteration_history: [
          {
            iteration: 1,
            status: 'restarting',
            steps: { commit: failedAt(1) },
          },
        ],
      },
    ];
    // A matrix variant runs under its physical id, which only the
    // materialized definitions name.
    const variant = createMatrixPhysicalJobId('j', 0);
    const definition = state.job_definitions.j;
    if (!definition) throw new Error('No definition.');
    state.job_definitions[variant] = structuredClone(definition);
    state.jobs[variant] = {
      ...structuredClone(job),
      steps: { commit: failedAt(4) },
      retry_history: [],
      iteration_history: [],
    };
    expect(state.pipeline_snapshot.jobs[variant]).toBeUndefined();
    const fired: string[] = [];
    const run = (): Promise<void> =>
      runDaemonCommitHooks({
        state,
        executionsDir: executionRuntime.executionsDir,
        scope: { projectId: 'project', worktreeId: 'task' },
        handled: new Set(),
        ports: {
          fire: ({ results }): Promise<void> => {
            fired.push(results[0]?.repoName ?? '');
            return Promise.resolve();
          },
          warn: (): void => undefined,
        },
      });
    await run();
    await run();
    expect(fired.sort()).toEqual(['repo-1', 'repo-2', 'repo-3', 'repo-4']);
  });

  it("a run's owner requests are answered until it settles, and other runs' are refused (CAN-5095)", async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    mockOwnerPossible.mockReturnValue(true);
    const handle = await routed(MODEL_PIPELINE);
    const owner = mockOwnerHandler;
    if (!owner) throw new Error('No owner handler.');
    const ask = (executionId: string): Promise<unknown> =>
      owner(
        {
          requestId: `owner:${executionId}:1`,
          executionId,
          jobId: '_run',
          stepId: '_run',
          childExecutionId: null,
          attempt: 0,
          iteration: 0,
          owner: 'personal',
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          request: { action: 'owner.model.release', routeSessionId: 'none' },
        },
        new AbortController().signal,
      );
    const refused = {
      result: {
        status: 'failure',
        message: 'This app did not start this workflow run.',
      },
    };
    expect(await ask('another-run')).toMatchObject(refused);
    expect(await ask(handle.id)).toMatchObject({
      result: { status: 'owner', value: { kind: 'model.release' } },
    });
    await waitFor(() => daemon.streams.length === 1);
    await saveExecutionState(
      { ...handle.getState(), status: 'success' },
      executionRuntime.executionsDir,
    );
    daemon.streams[0]?.onFrame?.({
      kind: 'item',
      item: { kind: 'execution', event: 'execution.updated', execution: {} },
    });
    await handle.waitForCompletion();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await ask(handle.id)).toMatchObject(refused);
  });

  it('a routed start gives the daemon no inherited credential, as an in-process step gets none', async () => {
    process.env.DAEMON_ROUTE_CANARY_TOKEN = 'inherited-canary-5086';
    process.env.DAEMON_ROUTE_PLAIN = 'plain-5086';
    try {
      const daemon = fakeDaemon();
      mockGet.mockResolvedValue({ client: daemon.client });
      await routed(SHELL_PIPELINE);
      const [sent] = daemon.instructions;
      const launch = JSON.stringify(sent?.options);
      expect(launch).not.toContain('DAEMON_ROUTE_CANARY_TOKEN');
      expect(launch).not.toContain('inherited-canary-5086');
      expect(launch).toContain('"DAEMON_ROUTE_PLAIN":"plain-5086"');
    } finally {
      delete process.env.DAEMON_ROUTE_CANARY_TOKEN;
      delete process.env.DAEMON_ROUTE_PLAIN;
    }
  });

  it('routes without reading Labs, and a start no window opened runs in process', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    await routed(SHELL_PIPELINE);
    expect(daemon.instructions).toHaveLength(1);
    const [sent] = daemon.instructions;
    expect(sent?.name).toBe('worker.pipeline.execution.start');
    expect(sent?.params).not.toHaveProperty('secrets');
    expect(sent?.options).toMatchObject({
      execution: {
        pipelineLaunch: { pipeline: SHELL_PIPELINE, cwd: root },
      },
    });
    expect(mockExecutePipeline).not.toHaveBeenCalled();
    expect(mockLabsSnapshot).not.toHaveBeenCalled();

    await withDaemonPipelineRoute(selectDaemonPipeline(undefined), () =>
      start(SHELL_PIPELINE),
    );
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(daemon.instructions).toHaveLength(1);
  });

  it("an unreachable daemon runs the start in process with the background warning; a reached daemon's refusal is the answer", async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('offline'), 'connection_lost'),
    );
    await routed(SHELL_PIPELINE);
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(mockFallbacks).toEqual([['pipelines', 'connection_lost']]);

    mockExecutePipeline.mockClear();
    const refusing = fakeDaemon((name) =>
      name === 'worker.pipeline.execution.start'
        ? Promise.reject(
            new CanopyClientError({
              kind: 'invalid_argument',
              code: 'worker.pipeline.launchRefused',
              message: 'Refused.',
              retry: { kind: 'never' },
            }),
          )
        : undefined,
    );
    mockGet.mockResolvedValue({ client: refusing.client });
    await expect(routed(SHELL_PIPELINE)).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.launchRefused' },
    });
    expect(mockExecutePipeline).not.toHaveBeenCalled();
  });

  it('a dropped session after the start was sent resends it once and never runs in process', async () => {
    const dropped = fakeDaemon((name) => {
      if (name !== 'worker.pipeline.execution.start') return undefined;
      dropped.abort.abort();
      return Promise.reject(new Error('socket closed'));
    });
    const reconnected = fakeDaemon();
    mockGet
      .mockResolvedValueOnce({ client: dropped.client })
      .mockResolvedValue({ client: reconnected.client });
    const handle = await routed(SHELL_PIPELINE);
    expect(dropped.instructions).toHaveLength(1);
    expect(reconnected.instructions).toHaveLength(1);
    const [first] = dropped.instructions;
    const [second] = reconnected.instructions;
    expect(second?.options).toEqual(first?.options);
    expect(second?.params).toEqual(first?.params);
    expect(handle.id).toBe(first?.params.executionId);
    expect(mockExecutePipeline).not.toHaveBeenCalled();

    // The mirror follows the run on the new session; when its stream drops
    // under a running run it reopens worker.pipeline.execution.events.
    await waitFor(() => reconnected.streams.length === 1);
    const [events] = reconnected.streams;
    expect(events?.name).toBe('worker.pipeline.execution.events');
    events?.onFrame?.({ kind: 'end', outcome: 'error', error: null });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(reconnected.streams.map(({ name }) => name)).toEqual([
      'worker.pipeline.execution.events',
      'worker.pipeline.execution.events',
    ]);
  });

  it('a running daemon run is active work, and keeps its worktree from auto-archive, until it settles', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    storedWorktreeId = 'archive-task';
    const before = getActivePipelineExecutionCount();
    const counts: number[] = [];
    const unsubscribe = subscribeToActiveCountChange((count) =>
      counts.push(count),
    );
    const handle = await routed(SHELL_PIPELINE);
    expect(getActivePipelineExecutionCount()).toBe(before + 1);
    // Hook workflows queue behind it, as behind an in-process run.
    expect(hasActivePipelineExecutions()).toBe(true);
    expect(getActivePipelineExecutionHandles()).toContain(handle);
    expect(collectActiveAutoArchiveTargetKeys()).toContain(
      'project\0archive-task',
    );
    await waitFor(() => daemon.streams.length === 1);
    await saveExecutionState(
      { ...handle.getState(), status: 'success' },
      executionRuntime.executionsDir,
    );
    daemon.streams[0]?.onFrame?.({
      kind: 'item',
      item: { kind: 'execution', event: 'execution.completed', execution: {} },
    });
    await handle.waitForCompletion();
    unsubscribe();
    expect(getActivePipelineExecutionCount()).toBe(before);
    // Its settling is the count change that drains queued hooks.
    expect(counts[counts.length - 1]).toBe(before);
    expect(getActivePipelineExecutionHandles()).not.toContain(handle);
    expect(collectActiveAutoArchiveTargetKeys()).not.toContain(
      'project\0archive-task',
    );
  });

  it('a mirror that cannot reopen its stream keeps a running run active until the store settles it', async () => {
    const state = runningState(randomUUID());
    await saveExecutionState(state, executionRuntime.executionsDir);
    let opens = 0;
    let sweeps = 0;
    const lifecycle = {
      onExecutionStart: jest.fn(),
      onExecutionSettled: jest.fn(),
    };
    const handle = new DaemonPipelineExecutionHandle({
      executionId: state.id,
      initialState: state,
      executionsDir: executionRuntime.executionsDir,
      openEvents: (): Promise<never> => {
        opens += 1;
        return Promise.reject(new Error('unreachable'));
      },
      cancel: (): Promise<never> =>
        Promise.reject(new Error('Unexpected cancel')),
      deliverEvent: (): void => undefined,
      deliverOutput: (): void => undefined,
      sweep: (): Promise<void> => {
        sweeps += 1;
        return Promise.resolve();
      },
      lifecycle,
      reopenDelayMs: 5,
    });
    registerDaemonPipelineExecution(handle);
    handle.follow();
    await waitFor(() => opens >= 6);
    // Past the reopen budget the run is still the daemon's: followed,
    // counted and swept, with its lifecycle (and wake lock) still held.
    expect(handle.isFollowing()).toBe(true);
    expect(getActivePipelineExecutionHandles()).toContain(handle);
    expect(sweeps).toBeGreaterThan(0);
    expect(lifecycle.onExecutionStart).toHaveBeenCalledTimes(1);
    expect(lifecycle.onExecutionSettled).not.toHaveBeenCalled();

    await saveExecutionState(
      { ...state, status: 'success' },
      executionRuntime.executionsDir,
    );
    await expect(handle.waitForCompletion()).resolves.toMatchObject({
      status: 'success',
    });
    expect(lifecycle.onExecutionSettled).toHaveBeenCalledTimes(1);
    expect(getActivePipelineExecutionHandles()).not.toContain(handle);
  });

  it('a mirror backing off settles a run whose owner exited through the orphan sweep', async () => {
    const owner = spawn('sleep', ['30'], { stdio: 'ignore' });
    const ownerExited = new Promise((resolve) => owner.once('exit', resolve));
    const state = { ...runningState(randomUUID()), owner_pid: owner.pid };
    await saveExecutionState(state, executionRuntime.executionsDir);
    let sweeps = 0;
    const events: string[] = [];
    const handle = new DaemonPipelineExecutionHandle({
      executionId: state.id,
      initialState: state,
      executionsDir: executionRuntime.executionsDir,
      openEvents: (): Promise<never> =>
        Promise.reject(new Error('unreachable')),
      cancel: (): Promise<never> =>
        Promise.reject(new Error('Unexpected cancel')),
      deliverEvent: (event): void => {
        events.push(event.type);
      },
      deliverOutput: (): void => undefined,
      // Main's sweep: it settles only a run whose owner process is gone.
      sweep: async (id): Promise<void> => {
        sweeps += 1;
        await recoverOrphanedPipelineExecutions(
          [id],
          executionRuntime.executionsDir,
        );
      },
      reopenDelayMs: 5,
    });
    registerDaemonPipelineExecution(handle);
    handle.follow();
    await waitFor(() => sweeps >= 2);
    expect(handle.isFollowing()).toBe(true);
    owner.kill('SIGKILL');
    await ownerExited;
    await expect(handle.waitForCompletion()).resolves.toMatchObject({
      status: 'paused',
    });
    expect(events[events.length - 1]).toBe('execution.paused');
    expect(getActivePipelineExecutionHandles()).not.toContain(handle);
  });

  it('after a restart, a surviving daemon run keeps its worktree protected and counted until it settles', async () => {
    const owner = spawn('sleep', ['30'], { stdio: 'ignore' });
    const gone = spawn('true', [], { stdio: 'ignore' });
    await new Promise((resolve) => gone.once('exit', resolve));
    const releaseWakeLock = jest.fn();
    const keepAwake = jest
      .spyOn(getExecutionAccounting(), 'keepAwake')
      .mockReturnValue(releaseWakeLock);
    try {
      storedWorktreeId = 'restart-task';
      const surviving = { ...runningState(randomUUID()), owner_pid: owner.pid };
      const orphaned = { ...runningState(randomUUID()), owner_pid: gone.pid };
      for (const state of [surviving, orphaned])
        await saveExecutionState(state, executionRuntime.executionsDir);
      const before = getActivePipelineExecutionCount();
      const events: string[] = [];
      await followSurvivingDaemonRuns(
        [surviving.id, orphaned.id],
        executionRuntime.executionsDir,
      );
      expect(getActivePipelineExecutionCount()).toBe(before + 1);
      expect(collectActiveAutoArchiveTargetKeys()).toContain(
        'project\0restart-task',
      );
      // Main keeps the computer awake while it follows the run, as it does
      // for a run it started.
      expect(keepAwake).toHaveBeenCalledTimes(1);
      expect(keepAwake).toHaveBeenCalledWith('pipeline', surviving.id);
      expect(releaseWakeLock).not.toHaveBeenCalled();
      const handle = getActivePipelineExecutionHandles().find(
        (candidate) => candidate.id === surviving.id,
      );
      if (!handle) throw new Error('The surviving run was not followed.');
      handle.addObservers?.({ onEvent: (event) => events.push(event.type) });
      // The daemon's pipeline host, the run's owner, finishes it.
      writeFileSync(
        join(executionRuntime.executionsDir, `${surviving.id}.json`),
        JSON.stringify({ ...surviving, status: 'success' }),
      );
      await handle.waitForCompletion();
      expect(getActivePipelineExecutionCount()).toBe(before);
      expect(releaseWakeLock).toHaveBeenCalledTimes(1);
      expect(collectActiveAutoArchiveTargetKeys()).not.toContain(
        'project\0restart-task',
      );
      // Resumed, not restarted: only its outcome is delivered.
      expect(events).toEqual(['execution.completed']);
    } finally {
      keepAwake.mockRestore();
      owner.kill('SIGKILL');
    }
  }, 30_000);

  it('after a restart, hooks the commit results only of surviving daemon runs this app marked (CAN-6012 D3)', async () => {
    // A run another process owns (the CLI, say) has no mark: its results
    // are never this app's to hook, though its state names a worktree.
    const owner = spawn('sleep', ['30'], { stdio: 'ignore' });
    const keepAwake = jest
      .spyOn(getExecutionAccounting(), 'keepAwake')
      .mockReturnValue(() => undefined);
    const executionsDir = executionRuntime.executionsDir;
    const result = {
      started_at: '2026-11-10T10:00:00.000Z',
      completed_at: '2026-11-10T10:00:30.000Z',
    };
    const commitRun = (): ExecutionState => {
      const state = createInitialState(
        normalizePipeline({
          name: 'Route',
          on: 'dispatch',
          jobs: {
            j: { steps: [{ id: 'commit', uses: 'builtin/git-commit-push' }] },
          },
        }),
        { cwd: root, pipelineId: 'pipeline', runtime: executionRuntime },
        randomUUID(),
      );
      state.status = 'running';
      state.project_id = 'project';
      state.worktree_id = 'task';
      state.owner_pid = owner.pid;
      // Committed, so the hook itself has nothing to do; its claim shows
      // whether the result was taken as this app's.
      Object.assign(state.jobs.j?.steps.commit ?? {}, {
        status: 'success',
        outputs: {
          results_json: JSON.stringify([
            {
              repoName: 'repo',
              repoPath: root,
              status: 'committed_and_pushed',
            },
          ]),
        },
        ...result,
      });
      return state;
    };
    const claimed = (state: ExecutionState): boolean =>
      existsSync(
        daemonCommitHookMarkerPath(
          executionsDir,
          state.id,
          daemonCommitHookKey(state.id, 'j', 'commit', result),
        ),
      );
    try {
      const marked = commitRun();
      const unmarked = commitRun();
      for (const state of [marked, unmarked])
        await saveExecutionState(state, executionsDir);
      await markDaemonCommitHooksPending(executionsDir, marked.id);
      await followSurvivingDaemonRuns([marked.id, unmarked.id], executionsDir);
      for (const state of [marked, unmarked]) {
        const handle = getActivePipelineExecutionHandles().find(
          (candidate) => candidate.id === state.id,
        );
        if (!handle) throw new Error('The surviving run was not followed.');
        writeFileSync(
          join(executionsDir, `${state.id}.json`),
          JSON.stringify({ ...state, status: 'success' }),
        );
        await handle.waitForCompletion();
      }
      await waitFor(() => claimed(marked));
      expect(claimed(unmarked)).toBe(false);
      await waitFor(
        () =>
          !existsSync(daemonCommitHooksPendingPath(executionsDir, marked.id)),
      );
    } finally {
      keepAwake.mockRestore();
      owner.kill('SIGKILL');
    }
  }, 30_000);

  // CAN-5869: a run that outlived the app streams again in the relaunched one.
  it("after a restart, main reopens a surviving daemon run's events and streams its output and step events again", async () => {
    const owner = spawn('sleep', ['30'], { stdio: 'ignore' });
    const keepAwake = jest
      .spyOn(getExecutionAccounting(), 'keepAwake')
      .mockReturnValue(() => undefined);
    try {
      const daemon = fakeDaemon();
      mockGet.mockResolvedValue({ client: daemon.client });
      const surviving = { ...runningState(randomUUID()), owner_pid: owner.pid };
      await saveExecutionState(surviving, executionRuntime.executionsDir);
      await followSurvivingDaemonRuns(
        [surviving.id],
        executionRuntime.executionsDir,
      );
      const handle = getActivePipelineExecutionHandles().find(
        (candidate) => candidate.id === surviving.id,
      );
      if (!handle) throw new Error('The surviving run was not followed.');
      const events: string[] = [];
      const output: string[] = [];
      handle.addObservers?.({
        onEvent: (event) => events.push(event.type),
        onStepOutput: (event) => output.push(event.data),
      });
      await waitFor(() => daemon.streams.length === 1);
      expect(daemon.streams[0]).toMatchObject({
        name: 'worker.pipeline.execution.events',
        params: { executionId: surviving.id },
      });
      const frame = (item: Record<string, unknown>): void =>
        daemon.streams[0]?.onFrame?.({ kind: 'item', item });
      frame({ kind: 'execution', event: 'snapshot', execution: {} });
      frame({
        kind: 'output',
        jobId: 'j',
        stepId: 'echo',
        stream: 'stdout',
        text: 'after restart\n',
        truncated: false,
      });
      frame({ kind: 'execution', event: 'execution.updated', execution: {} });
      await waitFor(() => events.length === 2 && output.length === 1);
      // The daemon's pipeline host, the run's owner, finishes it.
      writeFileSync(
        join(executionRuntime.executionsDir, `${surviving.id}.json`),
        JSON.stringify({ ...surviving, status: 'success' }),
      );
      frame({ kind: 'execution', event: 'execution.completed', execution: {} });
      await expect(handle.waitForCompletion()).resolves.toMatchObject({
        status: 'success',
      });
      expect(events).toEqual([
        'execution.updated',
        'execution.updated',
        'execution.completed',
      ]);
      expect(output).toEqual(['after restart\n']);
      expect(daemon.streams).toHaveLength(1);
    } finally {
      keepAwake.mockRestore();
      owner.kill('SIGKILL');
    }
  });

  it('a surviving run the daemon does not run is followed through the store without reopening its events', async () => {
    const owner = spawn('sleep', ['30'], { stdio: 'ignore' });
    const keepAwake = jest
      .spyOn(getExecutionAccounting(), 'keepAwake')
      .mockReturnValue(() => undefined);
    try {
      const daemon = fakeDaemon();
      mockGet.mockResolvedValue({ client: daemon.client });
      // Another live process, such as the CLI, owns it.
      const surviving = { ...runningState(randomUUID()), owner_pid: owner.pid };
      await saveExecutionState(surviving, executionRuntime.executionsDir);
      await followSurvivingDaemonRuns(
        [surviving.id],
        executionRuntime.executionsDir,
      );
      const handle = getActivePipelineExecutionHandles().find(
        (candidate) => candidate.id === surviving.id,
      );
      if (!handle) throw new Error('The surviving run was not followed.');
      await waitFor(() => daemon.streams.length === 1);
      // The daemon's answer for a run its pipeline host is not running.
      daemon.streams[0]?.onFrame?.({
        kind: 'item',
        item: { kind: 'execution', event: 'snapshot', execution: {} },
      });
      daemon.streams[0]?.onFrame?.({
        kind: 'end',
        outcome: 'completed',
        error: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(daemon.streams).toHaveLength(1);
      expect(getActivePipelineExecutionHandles()).toContain(handle);
      writeFileSync(
        join(executionRuntime.executionsDir, `${surviving.id}.json`),
        JSON.stringify({ ...surviving, status: 'success' }),
      );
      await expect(handle.waitForCompletion()).resolves.toMatchObject({
        status: 'success',
      });
      expect(daemon.streams).toHaveLength(1);
    } finally {
      keepAwake.mockRestore();
      owner.kill('SIGKILL');
    }
  }, 15_000);

  it('a daemon run is not checkpointed at quit and refuses recovery controls', async () => {
    const daemon = fakeDaemon();
    mockGet.mockResolvedValue({ client: daemon.client });
    const handle = await routed(SHELL_PIPELINE);
    const active = getActivePipelineExecutionCount();
    await expect(pauseAllActivePipelineExecutions()).resolves.toBeUndefined();
    // Quit neither pauses it nor stops counting it.
    expect(getActivePipelineExecutionCount()).toBe(active);
    expect(getActivePipelineExecutionHandles()).toContain(handle);
    expect(daemon.instructions.map(({ name }) => name)).toEqual([
      'worker.pipeline.execution.start',
    ]);
    expect(handle.getState().status).toBe('running');
    await expect(
      controlPipelineThroughLocalWorker(
        {
          operation: 'worker.pipeline.execution.resume',
          params: {
            requestId: randomUUID(),
            executionId: handle.id,
            initiationSource: 'user',
          },
        },
        () => Promise.reject(new Error('Unexpected recovery launch')),
        'client',
        [],
      ),
    ).rejects.toThrow(DAEMON_PIPELINE_CONTROL_REFUSED_MESSAGE);
  });
});
