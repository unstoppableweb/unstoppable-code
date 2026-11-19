import { app } from 'electron';
import { hookClientPresence } from '../lib/hook-client-presence';
import type {
  HookDescriptor,
  ScriptRunResponse,
} from '@canopy/desktop-shared/types';
import type { HookAction } from '@canopy/desktop-shared/hooks';
import {
  parseInitiatedWorkRunRecord,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import type { RunShellScriptOptions } from '../lib/script-runner';
import type { InitiatedWorkRuntimeHelper } from './helpers/initiated-work-runtime';

jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): { initiatedWork: unknown } => ({
    initiatedWork: jest
      .requireActual<InitiatedWorkRuntimeHelper>(
        './helpers/initiated-work-runtime',
      )
      .testInitiatedWork().engine,
  }),
}));
jest.mock('../lib/hook-chat', () => ({ launchHookChat: jest.fn() }));
jest.mock('../lib/project-owner', () => ({
  resolveProjectSavedOwner: jest.fn(() =>
    Promise.resolve({ kind: 'organization', organizationId: 'org-1' }),
  ),
}));
jest.mock('../lib/workspace-persistence', () => {
  const readWorkspaceWorktrees = jest.fn(() => Promise.resolve([]));
  return {
    readWorkspaceWorktrees,
    // The pause reader needs the list's authority (CAN-7094).
    readWorkspaceWorktreesDetailed: jest.fn(async () => ({
      worktrees: await readWorkspaceWorktrees(),
      authority: 'ok',
    })),
  };
});
jest.mock('../lib/hook-pipeline', () => ({
  launchHookPipeline: jest.fn(() =>
    Promise.resolve({
      status: 'started',
      pipelineName: 'Review',
      executionId: 'exec-1',
    }),
  ),
  cancelQueuedHookPipeline: jest.fn(),
}));
jest.mock('../lib/worktree-data-env', () => ({
  buildWorktreeDataEnv: (
    _projectId: string,
    _worktreeId: string,
    env?: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv => ({ ...env }),
}));
jest.mock('../lib/hook-log-store', () => ({
  startHookRunLog: jest.fn((args: { hook: HookDescriptor }) =>
    Promise.resolve({
      projectId: 'p',
      worktreeId: 'w',
      hook: args.hook,
      runId: 'run-log-1',
    }),
  ),
  appendHookRunLogLines: jest.fn(() => Promise.resolve()),
  completeHookRunLog: jest.fn(() => Promise.resolve()),
}));

interface PendingShell {
  options: RunShellScriptOptions;
  finish: (response: Partial<ScriptRunResponse>) => void;
}
const mockShells: PendingShell[] = [];
jest.mock('../lib/script-runner', () => ({
  runShellScript: jest.fn(
    (options: RunShellScriptOptions) =>
      new Promise<ScriptRunResponse>((resolve) => {
        const finish = (response: Partial<ScriptRunResponse>): void =>
          resolve({
            success: true,
            exitCode: 0,
            output: '',
            timedOut: false,
            durationMs: 3,
            ...response,
          });
        options.signal?.addEventListener('abort', () =>
          finish({ success: false, exitCode: null }),
        );
        mockShells.push({ options, finish });
      }),
  ),
}));

import { launchHookChat } from '../lib/hook-chat';
import { runHook, stopAllRunningHooks } from '../lib/hook-runner';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import {
  closeTestInitiatedWork,
  readyTestInitiatedWork,
} from './helpers/initiated-work-runtime';

const mockedReadWorktrees = jest.mocked(readWorkspaceWorktrees);

function hook(actions: HookAction[]): HookDescriptor {
  return {
    hookKey: 'project:pr:create',
    triggerName: 'pr:create',
    label: 'PR created',
    actions,
    target: 'project',
  };
}

const COMMAND: HookAction[] = [{ type: 'command', command: 'notify' }];

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function runs(): Promise<OperationRecord[]> {
  const { operations } = await readyTestInitiatedWork();
  return (
    await operations.list({ kinds: ['core.initiatedWork.run'], limit: 50 })
  ).items;
}

async function latestRun(): Promise<OperationRecord> {
  const [latest] = await runs();
  if (!latest) throw new Error('no run recorded');
  return latest;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockedReadWorktrees.mockResolvedValue([]);
  mockShells.length = 0;
  closeTestInitiatedWork();
  await readyTestInitiatedWork();
});

afterEach(async () => {
  jest.restoreAllMocks();
  stopAllRunningHooks();
  await settle();
});

afterAll(() => {
  closeTestInitiatedWork();
});

describe('hooks on the initiated-work engine', () => {
  it('starts a chat hook without a connected client or app.on listener', async () => {
    const listenerRegistration = jest.spyOn(app, 'on');
    jest
      .mocked(launchHookChat)
      .mockResolvedValue({ status: 'started', chatId: 'chat-hook-x-0' });
    const run = runHook({
      projectId: 'p',
      worktreeId: 'w',
      hook: hook([{ type: 'chat', prompt: 'Review' }]),
      invocation: 'automatic',
      pause: 'enforce',
      cwd: '/w',
      getWindow: () => null,
      clientPresence: hookClientPresence(() => null),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deferred = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('deferred'), 1000);
    });
    try {
      await expect(Promise.race([run, deferred])).resolves.toMatchObject({
        success: true,
      });
    } finally {
      clearTimeout(timer);
    }
    expect(listenerRegistration).not.toHaveBeenCalledWith(
      'browser-window-created',
      expect.any(Function),
    );
    const operation = await latestRun();
    expect(launchHookChat).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { operationId: operation.operationId, actionIndex: 0 },
      }),
    );
    expect(
      parseInitiatedWorkRunRecord(operation.outcome)?.gates.some(
        (gate) => gate.gate === 'client',
      ),
    ).toBe(false);
  });
  it('records the hook chat as a run artifact', async () => {
    for (const removed of [false, true]) {
      const chatId = removed ? 'chat-hook-y-1' : 'chat-hook-x-1';
      jest
        .mocked(launchHookChat)
        .mockResolvedValue({ status: removed ? 'removed' : 'started', chatId });
      const run = runHook({
        projectId: 'p',
        worktreeId: 'w',
        hook: hook([...COMMAND, { type: 'chat', prompt: 'Review' }]),
        invocation: 'automatic',
        pause: 'enforce',
        cwd: '/w',
        getWindow: () => null,
      });
      await settle();
      mockShells.at(-1)?.finish({});
      await run;
      const artifacts =
        parseInitiatedWorkRunRecord((await latestRun()).outcome)?.artifacts ??
        [];
      if (removed)
        expect(artifacts.some((artifact) => artifact.kind === 'chat')).toBe(
          false,
        );
      else
        expect(artifacts).toContainEqual({
          kind: 'chat',
          id: chatId,
          actionIndex: 1,
        });
    }
  });
});
