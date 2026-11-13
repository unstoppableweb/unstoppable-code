import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as OperationsModule from '@canopy/core-runtime/node/operations';
import type { OperationRecord } from '@canopy/protocol/canopy-core';
import type { PipelineData } from '@canopy/execution-engine/types/pipeline';
import type * as HookPipelineModule from '../lib/hook-pipeline';
import type * as RecoveryModule from '../lib/hook-recovery';
import type * as CarryoverModule from '../services/foreign-activity-carryover-service';
import { ForeignActivityLedger } from '../services/foreign-activity-ledger';
import {
  createTestInitiatedWork,
  type TestInitiatedWork,
} from './helpers/initiated-work-runtime';

jest.setTimeout(30_000);

let mockRuntime: TestInitiatedWork;
let mockActive = true;
let mockStored = true;
let mockExecutionState = false;
let mockBeforeAuthorization: (() => Promise<void>) | undefined;
const mockReservations = new Set<string>();
let mockBeforeStart: (() => Promise<void>) | undefined;
const mockStarts: Array<{
  options: {
    executionId: string;
    inputs?: Record<string, string>;
    modelConfig?: unknown;
  };
}> = [];
const mockListeners = new Set<(count: number) => void>();
const mockRevalidate = jest.fn<
  ReturnType<typeof RecoveryModule.revalidateQueuedHookWork>,
  Parameters<typeof RecoveryModule.revalidateQueuedHookWork>
>();
const mockPipeline: PipelineData = {
  info: {
    id: 'review',
    name: 'Review',
    icon: '',
    description: '',
    filename: 'review.yaml',
    createdAt: '2026-11-05T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
    source: 'user',
    readonly: false,
  },
  content: {
    name: 'Review',
    on: {
      dispatch: { inputs: { subject: { type: 'string', required: true } } },
    },
    jobs: { review: { steps: [{ run: 'true' }] } },
  },
};
jest.mock('@canopy/core-runtime/node/operations', () =>
  jest.requireActual<typeof OperationsModule>(
    '@canopy/core-runtime/node/operations',
  ),
);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({ isEnabled: (): boolean => true }),
}));
jest.mock('../lib/hook-pipeline', () => ({
  listQueuedHookPipelines: (): ReturnType<
    typeof HookPipelineModule.listQueuedHookPipelines
  > => mockPipelineQueue.listQueuedHookPipelines(),
  cancelQueuedHookPipeline: (queueId: string): Promise<boolean> =>
    mockPipelineQueue.cancelQueuedHookPipeline(queueId),
}));
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): unknown => ({
    initiatedWork: mockRuntime.engine,
    hookQueue: mockRuntime.hookQueue,
  }),
}));
jest.mock('../lib/hook-recovery', () => ({
  revalidateQueuedHookWork: (
    ...args: Parameters<typeof RecoveryModule.revalidateQueuedHookWork>
  ): ReturnType<typeof RecoveryModule.revalidateQueuedHookWork> =>
    mockRevalidate(...args),
}));
jest.mock('../pipelines/pipeline-handlers', () => ({
  startPipelineExecutionFromMain: async (args: {
    options: {
      executionId: string;
      inputs?: Record<string, string>;
      modelConfig?: unknown;
    };
  }): Promise<{ success: true }> => {
    mockReservations.delete(args.options.executionId);
    mockStarts.push(args);
    mockActive = true;
    await mockBeforeStart?.();
    return { success: true };
  },
  validateProjectPipelineAccess: jest.fn(),
}));
jest.mock('../pipelines/pipeline-execution-registry', () => ({
  hasActivePipelineExecutions: (): boolean =>
    mockActive || mockReservations.size > 0,
  subscribeToActiveCountChange: (listener: (count: number) => void): void => {
    mockListeners.add(listener);
  },
  reserveExecution: (executionId: string): void => {
    mockReservations.add(executionId);
  },
  releaseExecutionReservation: (executionId: string): void => {
    mockReservations.delete(executionId);
    for (const listener of mockListeners)
      listener(mockReservations.size + (mockActive ? 1 : 0));
  },
  isExecutionReservedBy: (executionId: string): boolean =>
    mockReservations.has(executionId),
  getActiveExecutionHandle: (): undefined => undefined,
}));
jest.mock('../pipelines/pipeline-service', () => ({
  getStoredPipelineBySource: (): unknown =>
    mockStored
      ? { success: true, data: mockPipeline }
      : { success: false, error: 'Workflow deleted' },
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: (): unknown => ({
    executionsDir: '/unused/executions',
  }),
}));
jest.mock('@canopy/execution-engine/node/pipelines/executor', () => ({
  ...jest.requireActual<object>(
    '@canopy/execution-engine/node/pipelines/executor',
  ),
  loadExecutionState: (): Promise<unknown> =>
    Promise.resolve(mockExecutionState ? { execution_id: 'saved' } : null),
}));
jest.mock('../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => false,
  authorizeBackgroundExecution: async (): Promise<unknown> => {
    await mockBeforeAuthorization?.();
    return { allow: true };
  },
}));
jest.mock('../services/foreign-activity-sources', () => ({
  publishForeignPipelineQueueActivity: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<unknown> => Promise.resolve({}),
}));

let dir: string;
let hookPipeline: typeof HookPipelineModule;
let mockPipelineQueue: typeof HookPipelineModule;
function loadPipeline(): void {
  mockListeners.clear();
  mockReservations.clear();
  jest.isolateModules(() => {
    hookPipeline = jest.requireActual<typeof HookPipelineModule>(
      '../lib/hook-pipeline',
    );
  });
  mockPipelineQueue = hookPipeline;
}
async function runIdentity(): Promise<{
  operationId: string;
  actionIndex: number;
}> {
  const run = await mockRuntime.operations.admit({
    kind: 'core.initiatedWork.run',
    status: 'running',
    origin: {
      kind: 'hook',
      sourceId: 'project:pr:create',
      context: {
        triggerName: 'pr:create',
        target: 'project',
        invocation: 'automatic',
        projectOwner: { kind: 'personal' },
      },
    },
    owner: { kind: 'principal', id: 'local' },
    scope: { workspaceId: 'p', worktreeId: 'w' },
  });
  return { operationId: run.operation.operationId, actionIndex: 0 };
}
function launch(identity: {
  operationId: string;
  actionIndex: number;
}): ReturnType<typeof HookPipelineModule.launchHookPipeline> {
  return hookPipeline.launchHookPipeline({
    identity,
    action: {
      type: 'pipeline',
      source: 'local',
      id: 'review',
      inputs: { subject: identity.operationId },
      codexFastMode: true,
    },
    cwd: '/workspace',
    projectId: 'p',
    worktreeId: 'w',
    env: { CANOPY_SUBJECT: identity.operationId },
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
  });
}
function queueId(identity: { operationId: string }): string {
  return `queued-pipeline-${identity.operationId}-0`;
}
async function queueOperation(id: string): Promise<OperationRecord> {
  const listed = await mockRuntime.operations.list({
    kinds: ['core.initiatedWork.queuedHookPipeline'],
    limit: 50,
  });
  const found = listed.items.find((op) => op.receipt.idempotencyKey === id);
  if (!found) throw new Error('Queue operation missing');
  return found;
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Hook pipeline queue did not settle');
}
async function restart(): Promise<void> {
  mockRuntime.operations.close();
  mockRuntime = createTestInitiatedWork(dir);
  loadPipeline();
  hookPipeline.registerHookPipelineQueueHost(() => null);
  await mockRuntime.operations.whenReconciled();
  await mockRuntime.hookQueue.sweep();
}
function clearActivity(): void {
  mockActive = false;
  for (const listener of mockListeners) listener(0);
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hook-pipeline-durability-'));
  mockRuntime = createTestInitiatedWork(dir);
  mockActive = true;
  mockStored = true;
  mockExecutionState = false;
  mockBeforeStart = undefined;
  mockBeforeAuthorization = undefined;
  mockReservations.clear();
  mockStarts.length = 0;
  mockRevalidate.mockReset();
  mockRevalidate.mockResolvedValue({
    status: 'valid',
    hook: {
      hookKey: 'project:pr:create',
      triggerName: 'pr:create',
      label: 'Review',
      target: 'project',
      actions: [{ type: 'pipeline', source: 'local', id: 'review' }],
    },
    action: { type: 'pipeline', source: 'local', id: 'review' },
    cwd: '/workspace',
  });
  loadPipeline();
  await mockRuntime.operations.ready();
});
afterEach(() => {
  mockRuntime.operations.close();
  rmSync(dir, { recursive: true, force: true });
});

it('starts a queued hook pipeline after a restart with its execution id', async () => {
  const identity = await runIdentity();
  const queued = await launch(identity);
  expect(queued.status).toBe('queued');
  const accepted = await queueOperation(queueId(identity));
  const executionId = accepted.scope.executionId;
  await restart();
  clearActivity();
  await until(
    async () =>
      (await queueOperation(queueId(identity))).status === 'completed',
  );
  expect(mockStarts).toHaveLength(1);
  expect(mockStarts[0]?.options).toMatchObject({
    executionId,
    inputs: { subject: identity.operationId },
    modelConfig: { speed: 'fast', fastMode: true },
  });
  expect(await queueOperation(queueId(identity))).toMatchObject({
    status: 'completed',
    outcome: { kind: 'pipeline', executionId, result: 'started' },
  });
});

it('drains recovered hook pipelines in their accepted order before new ones', async () => {
  const first = await runIdentity();
  const second = await runIdentity();
  await launch(first);
  await launch(second);
  await restart();
  const third = await runIdentity();
  await launch(third);
  for (let index = 0; index < 3; index++) {
    clearActivity();
    await until(() => mockStarts.length === index + 1);
  }
  expect(mockStarts.map((start) => start.options.inputs?.subject)).toEqual([
    first.operationId,
    second.operationId,
    third.operationId,
  ]);
  await until(
    async () => (await queueOperation(queueId(third))).status === 'completed',
  );
});

it.each([true, false])(
  'never starts a hook pipeline twice when its execution may have started (state exists: %s)',
  async (hasState) => {
    const identity = await runIdentity();
    await launch(identity);
    mockBeforeStart = (): Promise<void> => new Promise(() => {});
    clearActivity();
    await until(() => mockStarts.length === 1);
    mockExecutionState = hasState;
    await restart();
    clearActivity();
    const operation = await queueOperation(queueId(identity));
    expect(operation).toMatchObject(
      hasState
        ? {
            status: 'completed',
            outcome: { kind: 'pipeline', result: 'started' },
          }
        : { status: 'failed', error: { code: 'core.operation.interrupted' } },
    );
    expect(mockStarts).toHaveLength(1);
  },
);

it('ends a recovered hook pipeline invalidated when its workflow can no longer be loaded', async () => {
  const identity = await runIdentity();
  await launch(identity);
  mockStored = false;
  await restart();
  clearActivity();
  expect(await queueOperation(queueId(identity))).toMatchObject({
    status: 'failed',
    error: {
      code: 'core.initiatedWork.hookQueue.invalidated',
      message:
        "This hook's workflow can no longer be loaded, so it was not run.",
    },
  });
  expect(mockStarts).toHaveLength(0);
});

it('ends a recovered hook pipeline invalidated when its hook action changed', async () => {
  const identity = await runIdentity();
  await launch(identity);
  mockRevalidate.mockResolvedValue({
    status: 'valid',
    hook: {
      hookKey: 'project:pr:create',
      triggerName: 'pr:create',
      label: 'Review',
      target: 'project',
      actions: [{ type: 'pipeline', source: 'local', id: 'review' }],
    },
    action: { type: 'pipeline', source: 'local', id: 'another-workflow' },
    cwd: '/workspace',
  });
  await restart();
  clearActivity();
  expect(await queueOperation(queueId(identity))).toMatchObject({
    status: 'failed',
    error: {
      code: 'core.initiatedWork.hookQueue.invalidated',
      message: "This hook's action changed, so the queued work was not run.",
    },
  });
  expect(mockStarts).toHaveLength(0);
});

it('keeps a cancelled hook pipeline cancelled after a restart', async () => {
  const identity = await runIdentity();
  await launch(identity);
  expect(await hookPipeline.cancelQueuedHookPipeline(queueId(identity))).toBe(
    true,
  );
  await restart();
  expect(await launch(identity)).toMatchObject({
    status: 'ended',
    queueId: queueId(identity),
  });
  clearActivity();
  expect((await queueOperation(queueId(identity))).status).toBe('cancelled');
  expect(mockStarts).toHaveLength(0);
});

it.each(['authorization', 'transition'])(
  'refuses core cancellation while a queued hook pipeline is starting (%s)',
  async (stage) => {
    hookPipeline.registerHookPipelineQueueHost(() => null);
    const identity = await runIdentity();
    await launch(identity);
    let releaseAuthorization: () => void = () => {};
    let entered = false;
    const wait = (): Promise<void> =>
      new Promise((resolve) => {
        entered = true;
        releaseAuthorization = resolve;
      });
    if (stage === 'authorization') mockBeforeAuthorization = wait;
    else {
      const markStarting = mockRuntime.hookQueue.markStarting.bind(
        mockRuntime.hookQueue,
      );
      jest
        .spyOn(mockRuntime.hookQueue, 'markStarting')
        .mockImplementation(async (id) => {
          await wait();
          return markStarting(id);
        });
    }
    clearActivity();
    await until(() => entered);
    const operation = await queueOperation(queueId(identity));
    try {
      expect(
        await hookPipeline.cancelQueuedHookPipeline(queueId(identity)),
      ).toBe(false);
      await expect(
        mockRuntime.operations.cancel(operation.operationId, {
          requestedBy: 'portal-client',
          reason: 'stop',
        }),
      ).rejects.toThrow('This workflow already started; stop the run itself.');
    } finally {
      releaseAuthorization();
    }
    await until(() => mockStarts.length === 1);
    await until(
      async () =>
        (await queueOperation(queueId(identity))).status === 'completed',
    );
    expect((await queueOperation(queueId(identity))).cancellation).toBeNull();
  },
);

it('does not redrain immediately when a queued workflow running transition fails', async () => {
  const identity = await runIdentity();
  await launch(identity);
  let attempts = 0;
  const mark = jest
    .spyOn(mockRuntime.hookQueue, 'markStarting')
    .mockImplementation(() => {
      attempts++;
      return attempts < 4
        ? Promise.reject(new Error('Ledger unavailable'))
        : new Promise(() => {});
    });
  clearActivity();
  await until(() => attempts > 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const observedAttempts = attempts;
  mark.mockRestore();
  expect(observedAttempts).toBe(1);
  expect((await queueOperation(queueId(identity))).status).toBe('queued');
  hookPipeline.hookPipelineTestExports.scheduleDrain();
  await until(() => mockStarts.length === 1);
  await until(
    async () =>
      (await queueOperation(queueId(identity))).status === 'completed',
  );
});

it('keeps live and recovered hook pipelines in the same order when admissions overlap', async () => {
  const first = await runIdentity();
  const second = await runIdentity();
  const enqueue = mockRuntime.hookQueue.enqueue.bind(mockRuntime.hookQueue);
  let releaseFirst: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered = false;
  const admission = jest
    .spyOn(mockRuntime.hookQueue, 'enqueue')
    .mockImplementation(async (request) => {
      if (request.queueId === queueId(first)) {
        firstEntered = true;
        await held;
      }
      return enqueue(request);
    });
  const firstLaunch = launch(first);
  await until(() => firstEntered);
  const secondLaunch = launch(second);
  try {
    await Promise.race([
      secondLaunch,
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  } finally {
    releaseFirst();
  }
  await Promise.all([firstLaunch, secondLaunch]);
  admission.mockRestore();
  const before = hookPipeline
    .listQueuedHookPipelines()
    .map((entry) => entry.queueId);
  expect(before).toEqual([queueId(first), queueId(second)]);
  await restart();
  expect(
    hookPipeline.listQueuedHookPipelines().map((entry) => entry.queueId),
  ).toEqual(before);
  for (let index = 0; index < 2; index++) {
    clearActivity();
    await until(() => mockStarts.length === index + 1);
  }
  expect(mockStarts.map((start) => start.options.inputs?.subject)).toEqual([
    first.operationId,
    second.operationId,
  ]);
  await until(
    async () => (await queueOperation(queueId(second))).status === 'completed',
  );
});

it('reports a busy foreign stop when a queued hook workflow is reserved for startup', async () => {
  const { ForeignActivityCarryoverService, FOREIGN_ACTIVITY_BUSY_ERROR } =
    jest.requireActual<typeof CarryoverModule>(
      '../services/foreign-activity-carryover-service',
    );
  const identity = await runIdentity();
  await launch(identity);
  const operation = await queueOperation(queueId(identity));
  const executionId = operation.scope.executionId;
  if (!executionId) throw new Error('Execution identity missing');
  const target = {
    source: 'pipeline' as const,
    operationId: executionId,
    workspaceId: 'p',
    worktreeId: 'w',
    resultToken: null,
  };
  const file = jest
    .spyOn(ForeignActivityLedger.prototype, 'file')
    .mockReturnValue({
      version: 1,
      accountId: 'account',
      epoch: 'epoch',
      entries: [],
    });
  const entries = jest
    .spyOn(ForeignActivityLedger.prototype, 'entries')
    .mockReturnValue([
      {
        operation: {
          ...target,
          context: { kind: 'personal' },
          active: true,
          unreadToken: null,
        },
        baselineToken: null,
        state: 'FOREIGN_ACTIVE',
        changedAt: Date.now(),
      },
    ]);
  const service = new ForeignActivityCarryoverService();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const markStarting = mockRuntime.hookQueue.markStarting.bind(
    mockRuntime.hookQueue,
  );
  jest
    .spyOn(mockRuntime.hookQueue, 'markStarting')
    .mockImplementation(async (id) => {
      entered = true;
      await held;
      return markStarting(id);
    });
  clearActivity();
  await until(() => entered);
  try {
    await expect(service.stop({ epoch: 'epoch', target })).rejects.toThrow(
      FOREIGN_ACTIVITY_BUSY_ERROR,
    );
  } finally {
    release();
    service.dispose();
    file.mockRestore();
    entries.mockRestore();
  }
  await until(
    async () =>
      (await queueOperation(queueId(identity))).status === 'completed',
  );
});

it('ends a throwing queued workflow start as failed and runs the next entry', async () => {
  const first = await runIdentity();
  const second = await runIdentity();
  await launch(first);
  await launch(second);
  let failedAuthorization = false;
  mockBeforeAuthorization = (): Promise<void> => {
    mockBeforeAuthorization = undefined;
    failedAuthorization = true;
    return Promise.reject(new Error('Authorization unavailable'));
  };
  clearActivity();
  await until(() => failedAuthorization);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await queueOperation(queueId(first))).toMatchObject({
    status: 'failed',
    error: { code: 'core.initiatedWork.hookQueue.startFailed' },
  });
  await until(() => mockStarts.length === 1);
  expect(mockStarts[0]?.options.inputs?.subject).toBe(second.operationId);
  expect(mockReservations.size).toBe(0);
  await until(
    async () => (await queueOperation(queueId(second))).status === 'completed',
  );
});
