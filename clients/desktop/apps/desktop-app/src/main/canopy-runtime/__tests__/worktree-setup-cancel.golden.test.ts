import type { ScriptRunTracking } from '@canopy/core-runtime/node/script/execution';

const mockTracked: ScriptRunTracking[] = [];
const mockDrains: Array<{
  target: { projectId: string; worktreeId: string };
  drained: string[];
}> = [];
// Delegates lazily: the real module sits in an import cycle with the script
// service, so it cannot be loaded while this factory runs.
jest.mock('../../lib/script-runner', () => {
  const stubs: Record<string, unknown> = {
    __esModule: true,
    listTrackedShellScripts: (): ScriptRunTracking[] => [...mockTracked],
    drainTrackedShellScriptRunsForWorktree: mockDrain,
  };
  return new Proxy(stubs, {
    get: (target, property: string): unknown =>
      property in target
        ? target[property]
        : jest.requireActual<Record<string, unknown>>(
            '../../lib/script-runner',
          )[property],
  });
});
function mockDrain(
  target: { projectId: string; worktreeId: string },
  shouldDrain: (tracking: ScriptRunTracking) => boolean,
): Promise<unknown[]> {
  const drained = mockTracked.filter(
    (tracking) =>
      tracking.projectId === target.projectId &&
      tracking.worktreeId === target.worktreeId &&
      shouldDrain(tracking),
  );
  mockDrains.push({
    target,
    drained: drained.map((tracking) => tracking.runId ?? ''),
  });
  return Promise.resolve(
    drained.map((tracking) => ({
      tracking,
      response: {
        success: false,
        exitCode: null,
        output: 'stopped',
        timedOut: false,
        durationMs: 5,
      },
    })),
  );
}
// The latest run of each key, as the script service reads its tail.
const mockLatestRun = new Map<string, string>();
jest.mock('../../lib/script-execution', () => ({
  ...jest.requireActual<object>('../../lib/script-execution'),
  readScriptRun: (request: { scriptKey: string }): Promise<unknown> => {
    const runId = mockLatestRun.get(request.scriptKey);
    return Promise.resolve(
      runId === undefined
        ? {}
        : {
            run: {
              execution: {
                executionId: runId,
                script: descriptor(request.scriptKey),
                invocation: 'automatic-setup',
                status: 'success',
                startedAt: '2026-11-17T00:00:00.000Z',
                completedAt: '2026-11-17T00:00:01.000Z',
                exitCode: 0,
                timedOut: false,
                durationMs: 1_000,
              },
              lines: ['installing'],
            },
          },
    );
  },
}));
const mockScriptRunActivity: unknown[] = [];
jest.mock('../../services/foreign-activity-sources', () => ({
  ...jest.requireActual<object>('../../services/foreign-activity-sources'),
  publishForeignScriptActivity: (run: unknown): void => {
    mockScriptRunActivity.push(run);
  },
}));
const mockClosedTargets: unknown[] = [];
jest.mock('../../services/script-actions-lifecycle', () => ({
  ...jest.requireActual<object>('../../services/script-actions-lifecycle'),
  notifyScriptActionsTargetClosed: (target: unknown): void => {
    mockClosedTargets.push(target);
  },
}));

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { CORE_WORKTREE_SETUP_CANCEL_CALLER_REFUSED_MESSAGE } from '@canopy/core-runtime/node/worktree/setup-cancel';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { registerScriptHandlers } from '../../ipc/scripts';
import {
  assertWorkspaceTargetRuntimeStartAllowed,
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetRuntimePreparation,
} from '../../lib/workspace-target-exclusion';

function descriptor(scriptKey: string): ScriptRunTracking['script'] {
  return {
    scriptKey,
    scriptName: scriptKey.split(':').at(-1) ?? scriptKey,
    label: scriptKey,
    command: 'true',
    lifecycle: 'setup',
    target: 'project',
  };
}

function tracked(
  worktreeId: string,
  scriptKey: string,
  invocation: ScriptRunTracking['invocation'],
  runId: string,
): ScriptRunTracking {
  return {
    projectId: 'project',
    worktreeId,
    scriptKey,
    runId,
    invocation,
    script: descriptor(scriptKey),
  };
}

const LOCAL_USER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'renderer',
  authorityId: 'local',
  interfaceKind: 'desktop',
  grants: [],
};

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
let runtime: DesktopCanopyDispatcher;
let sent: Array<{ channel: string; payload: unknown }>;
let event: IpcMainInvokeEvent;
let ipcCaller: CanopyCallerDescriptor;

function invokeCancel(request: unknown): Promise<unknown> {
  const handler = handlers.get(IPC_CHANNELS.scriptCancelWorktreeSetup);
  if (!handler) throw new Error('script:cancel-worktree-setup is unregistered');
  return Promise.resolve(handler(event, request));
}

beforeEach(() => {
  mockTracked.splice(0);
  mockDrains.splice(0);
  mockLatestRun.clear();
  mockScriptRunActivity.splice(0);
  mockClosedTargets.splice(0);
  resetWorkspaceTargetExclusionsForTests();
  handlers.clear();
  ipcCaller = LOCAL_USER;
  sent = [];
  event = {
    sender: {
      isDestroyed: (): boolean => false,
      send: (channel: string, payload: unknown): void => {
        sent.push({ channel, payload });
      },
    },
  } as unknown as IpcMainInvokeEvent;
  jest.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    handlers.set(channel, handler as Handler);
  });
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  registerScriptHandlers({
    dispatcher: runtime,
    resolveCaller: () => ipcCaller,
  });
});

afterEach(async () => {
  await runtime.shutdown();
  jest.restoreAllMocks();
});

describe('worktree setup cancel (CAN-4097, CAN-3745 RC-15)', () => {
  it('fences preparation, drains only the setup runs and reports each cancelled run', async () => {
    mockTracked.push(
      tracked('task', 'project:setup', 'automatic-setup', 'run-setup'),
      tracked(
        'task',
        'project:before-setup',
        'workspace-lifecycle',
        'run-before',
      ),
      // A manual run of a setup script drains with it.
      tracked('task', 'project:setup', 'manual-run', 'run-setup-manual'),
      tracked('task', 'project:dev', 'manual-run', 'run-dev'),
      tracked('other', 'project:setup', 'automatic-setup', 'run-other'),
    );
    mockLatestRun.set('project:setup', 'run-setup-manual');
    mockLatestRun.set('project:before-setup', 'run-before');

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fenced = withWorkspaceTargetRuntimePreparation(
      'project',
      'task',
      async () => {
        await gate;
        assertWorkspaceTargetRuntimeStartAllowed('project', 'task');
      },
    );
    const sibling = withWorkspaceTargetRuntimePreparation(
      'project',
      'other',
      async () => {
        await gate;
        assertWorkspaceTargetRuntimeStartAllowed('project', 'other');
      },
    );

    await expect(
      invokeCancel({ projectId: 'project', worktreeId: 'task' }),
    ).resolves.toBeUndefined();
    release();
    await expect(fenced).rejects.toThrow();
    await expect(sibling).resolves.toBeUndefined();

    expect(mockClosedTargets).toEqual([
      { projectId: 'project', worktreeId: 'task' },
    ]);
    expect(mockDrains).toEqual([
      {
        target: { projectId: 'project', worktreeId: 'task' },
        drained: ['run-setup', 'run-before', 'run-setup-manual'],
      },
    ]);
    expect(
      sent.map(({ channel, payload }) => {
        const complete = payload as {
          runId?: string;
          invocation: string;
          worktreeId: string;
          result: { success: boolean; exitCode: number | null };
        };
        return [
          channel,
          complete.runId,
          complete.invocation,
          complete.worktreeId,
          complete.result.success,
          complete.result.exitCode,
        ];
      }),
    ).toEqual([
      [
        IPC_CHANNELS.scriptComplete,
        'run-setup',
        'automatic-setup',
        'task',
        false,
        null,
      ],
      [
        IPC_CHANNELS.scriptComplete,
        'run-before',
        'workspace-lifecycle',
        'task',
        false,
        null,
      ],
      [
        IPC_CHANNELS.scriptComplete,
        'run-setup-manual',
        'manual-run',
        'task',
        false,
        null,
      ],
    ]);
    // The tail is the latest run of its key: the superseded automatic run of
    // project:setup is not published as cancelled.
    expect(
      mockScriptRunActivity.map((activity) => {
        const run = activity as { localId: string; status: string };
        return [run.localId, run.status];
      }),
    ).toEqual(
      expect.arrayContaining([
        ['run-before', 'cancelled'],
        ['run-setup-manual', 'cancelled'],
      ]),
    );
    expect(mockScriptRunActivity).toHaveLength(2);
  });

  it('cancels nothing for a target with no setup runs', async () => {
    mockTracked.push(tracked('task', 'project:dev', 'manual-run', 'run-dev'));
    await expect(
      invokeCancel({ projectId: 'project', worktreeId: 'task' }),
    ).resolves.toBeUndefined();
    expect(mockDrains).toEqual([
      { target: { projectId: 'project', worktreeId: 'task' }, drained: [] },
    ]);
    expect(sent).toEqual([]);
    expect(mockScriptRunActivity).toEqual([]);
  });

  it('refuses an invalid id before any effect', async () => {
    await expect(
      invokeCancel({ projectId: '../project', worktreeId: 'task' }),
    ).rejects.toThrow();
    expect(mockClosedTargets).toEqual([]);
    expect(mockDrains).toEqual([]);
  });

  it('serves a core caller without a renderer, with the same drain and cancelled-run activity', async () => {
    mockTracked.push(
      tracked('task', 'project:setup', 'automatic-setup', 'run-setup'),
    );
    mockLatestRun.set('project:setup', 'run-setup');
    await expect(
      runtime.instruction(
        'core.worktree.setup.cancel',
        { workspaceId: 'project', worktreeId: 'task' },
        {
          caller: {
            ...LOCAL_USER,
            principalId: 'core',
            clientInstanceId: 'core',
            grants: ['core.worktree.write'],
          },
        },
      ),
    ).resolves.toEqual({});
    expect(mockClosedTargets).toEqual([
      { projectId: 'project', worktreeId: 'task' },
    ]);
    expect(mockDrains).toEqual([
      {
        target: { projectId: 'project', worktreeId: 'task' },
        drained: ['run-setup'],
      },
    ]);
    expect(sent).toEqual([]);
    expect(mockScriptRunActivity).toHaveLength(1);
  });

  it.each([
    [
      'a Portal session',
      { ...LOCAL_USER, clientInstanceId: 'portal-session:browser' },
    ],
    [
      'the renderer relay',
      { ...LOCAL_USER, principalId: 'local-desktop-renderer:main' },
    ],
  ])(
    'refuses %s before any effect, on the wire and through IPC',
    async (_name, caller) => {
      mockTracked.push(
        tracked('task', 'project:setup', 'automatic-setup', 'run-setup'),
      );
      await expect(
        runtime.instruction(
          'core.worktree.setup.cancel',
          { workspaceId: 'project', worktreeId: 'task' },
          { caller: { ...caller, grants: ['core.worktree.write'] } },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      ipcCaller = caller;
      await expect(
        invokeCancel({ projectId: 'project', worktreeId: 'task' }),
      ).rejects.toThrow(CORE_WORKTREE_SETUP_CANCEL_CALLER_REFUSED_MESSAGE);
      expect(mockClosedTargets).toEqual([]);
      expect(mockDrains).toEqual([]);
      expect(sent).toEqual([]);
    },
  );

  it('refuses a wire call without the worktree write grant', async () => {
    await expect(
      runtime.instruction(
        'core.worktree.setup.cancel',
        { workspaceId: 'project', worktreeId: 'task' },
        { caller: { ...LOCAL_USER, grants: [] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(mockDrains).toEqual([]);
  });
});
