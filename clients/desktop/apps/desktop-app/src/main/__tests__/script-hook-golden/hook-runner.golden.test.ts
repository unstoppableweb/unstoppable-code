import type {
  HookDescriptor,
  HookRunResponse,
  ScriptRunResponse,
} from '@canopy/desktop-shared/types';
import type { HookAction } from '@canopy/desktop-shared/hooks';
import type { RunShellScriptOptions } from '../../lib/script-runner';
import type { InitiatedWorkRuntimeHelper } from '../helpers/initiated-work-runtime';

// Hook runs go through the initiated-work engine (CAN-4144).
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): { initiatedWork: unknown } => ({
    initiatedWork: jest
      .requireActual<InitiatedWorkRuntimeHelper>(
        '../helpers/initiated-work-runtime',
      )
      .testInitiatedWork().engine,
  }),
}));

// The core hook source reads the worktree's paused hooks and the project's
// saved owner when a hook fires (CAN-4146).
jest.mock('../../lib/workspace-persistence', () => {
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
jest.mock('../../lib/project-owner', () => ({
  resolveProjectSavedOwner: jest.fn(() =>
    Promise.resolve({ kind: 'personal' }),
  ),
}));

jest.mock('../../lib/worktree-data-env', () => ({
  buildWorktreeDataEnv: (
    _projectId: string,
    _worktreeId: string,
    env?: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv => ({ ...env }),
}));

let mockRunCounter = 0;
const mockLog: string[] = [];
jest.mock('../../lib/hook-log-store', () => ({
  startHookRunLog: jest.fn((args: { hook: { hookKey: string } }) => {
    mockRunCounter += 1;
    return Promise.resolve({
      projectId: 'p',
      worktreeId: 'w',
      hook: args.hook,
      runId: `run-${mockRunCounter}`,
    });
  }),
  appendHookRunLogLines: jest.fn(
    (args: { ref: { runId: string }; lines: string[] }) => {
      for (const line of args.lines) mockLog.push(`${args.ref.runId}| ${line}`);
      return Promise.resolve();
    },
  ),
  completeHookRunLog: jest.fn(() => Promise.resolve()),
}));

interface PendingShell {
  options: RunShellScriptOptions;
  finish: (response: Partial<ScriptRunResponse>) => void;
}
const mockShells: PendingShell[] = [];
jest.mock('../../lib/script-runner', () => ({
  runShellScript: jest.fn(
    (options: RunShellScriptOptions) =>
      new Promise<ScriptRunResponse>((resolve) => {
        const finish = (response: Partial<ScriptRunResponse>): void =>
          resolve({
            success: true,
            exitCode: 0,
            output: '',
            timedOut: false,
            durationMs: 1,
            ...response,
          });
        options.signal?.addEventListener('abort', () =>
          finish({ success: false, exitCode: null }),
        );
        mockShells.push({ options, finish });
      }),
  ),
}));
jest.mock('../../lib/hook-chat', () => ({
  launchHookChat: jest.fn(() =>
    Promise.resolve({ status: 'started', chatId: 'chat-hook-mock-0' }),
  ),
}));
jest.mock('../../lib/hook-pipeline', () => ({
  launchHookPipeline: jest.fn(() =>
    Promise.resolve({
      status: 'started',
      pipelineName: 'Review',
      executionId: 'exec-1',
    }),
  ),
}));

import { launchHookChat } from '../../lib/hook-chat';
import { launchHookPipeline } from '../../lib/hook-pipeline';
import {
  listActiveHookRunTargets,
  runHook,
  stopAllRunningHooks,
  stopHooksForRepoTarget,
  stopHooksForWorktree,
  stopRunningHook,
  type RunHookOptions,
} from '../../lib/hook-runner';
import { withWorkspaceTargetArchiveDrain } from '../../lib/workspace-target-exclusion';
import {
  closeTestInitiatedWork,
  readyTestInitiatedWork,
} from '../helpers/initiated-work-runtime';

const mockedLaunchHookChat = jest.mocked(launchHookChat);
const mockedLaunchHookPipeline = jest.mocked(launchHookPipeline);

function hook(
  target: HookDescriptor['target'],
  triggerName: string,
  actions: HookAction[] = [{ type: 'command', command: `run ${triggerName}` }],
  repoId?: string,
): HookDescriptor {
  const key =
    target === 'workspace-repo'
      ? `${target}:${repoId ?? ''}:${triggerName}`
      : `${target}:${triggerName}`;
  return {
    hookKey: key,
    triggerName,
    label: key,
    actions,
    target,
    ...(repoId ? { repoId, repoName: repoId.toUpperCase() } : {}),
  };
}

const trace: string[] = [];

function start(
  descriptor: HookDescriptor,
  overrides: Partial<RunHookOptions> = {},
): Promise<HookRunResponse> {
  const name = descriptor.hookKey;
  return runHook({
    projectId: 'p',
    worktreeId: 'w',
    hook: descriptor,
    cwd: '/w',
    invocation: 'automatic',
    pause: 'enforce',
    timeoutSeconds: 60,
    getWindow: () => null,
    onEnqueued: () => trace.push(`enqueued ${name}`),
    onStarted: () => trace.push(`started ${name}`),
    onComplete: (_hook, result) =>
      trace.push(
        `complete ${name} success=${result.success} stopped=${result.stopped} exit=${result.exitCode}`,
      ),
    ...overrides,
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function shellFor(script: string): PendingShell {
  const shell = mockShells.find((entry) => entry.options.script === script);
  if (!shell) throw new Error(`no shell for ${script}`);
  return shell;
}

beforeAll(async () => {
  await readyTestInitiatedWork();
});

afterAll(() => {
  closeTestInitiatedWork();
});

beforeEach(() => {
  jest.clearAllMocks();
  trace.length = 0;
  mockRunCounter = 0;
  mockLog.length = 0;
  mockShells.length = 0;
});

afterEach(async () => {
  stopAllRunningHooks();
  await settle();
});

describe('CAN-5062 golden: per-target hook queues', () => {
  it('runs hooks for one target in arrival order and other targets alongside', async () => {
    const first = start(hook('project', 'pr:create'));
    const second = start(hook('project', 'pr:checks-failed'));
    const repoA = start(hook('workspace-repo', 'pr:create', undefined, 'a'));
    const repoB = start(hook('workspace-repo', 'pr:create', undefined, 'b'));
    await settle();

    expect(trace).toEqual([
      'enqueued project:pr:create',
      'enqueued project:pr:checks-failed',
      'enqueued workspace-repo:a:pr:create',
      'enqueued workspace-repo:b:pr:create',
      'started project:pr:create',
      'started workspace-repo:a:pr:create',
      'started workspace-repo:b:pr:create',
    ]);
    expect(listActiveHookRunTargets()).toEqual([
      { projectId: 'p', worktreeId: 'w' },
      { projectId: 'p', worktreeId: 'w' },
      { projectId: 'p', worktreeId: 'w' },
    ]);

    shellFor('run pr:create').finish({ success: false, exitCode: 7 });
    await settle();
    expect(await first).toEqual({
      success: false,
      stopped: false,
      exitCode: 7,
      output: '',
      timedOut: false,
      durationMs: 1,
    });
    expect(trace.slice(7)).toEqual([
      'complete project:pr:create success=false stopped=false exit=7',
      'started project:pr:checks-failed',
    ]);

    for (const shell of [...mockShells]) shell.finish({});
    await Promise.all([second, repoA, repoB]);
    expect(listActiveHookRunTargets()).toEqual([]);
  });

  it('records each action boundary and stops at the first failed action', async () => {
    const run = start(
      hook('project', 'pr:create', [
        { type: 'command', command: 'one' },
        { type: 'command', command: 'two' },
        { type: 'command', command: 'three' },
      ]),
    );
    await settle();
    shellFor('one').finish({});
    await settle();
    shellFor('two').finish({ success: false, exitCode: 2, output: 'boom' });
    expect(await run).toEqual({
      success: false,
      stopped: false,
      exitCode: 2,
      output: 'boom',
      timedOut: false,
      durationMs: 1,
    });
    expect(mockShells.map((shell) => shell.options.script)).toEqual([
      'one',
      'two',
    ]);
    expect(mockLog).toEqual(['run-1| $ [1/3] one', 'run-1| $ [2/3] two']);
    expect(mockShells[0]?.options).toMatchObject({
      cwd: '/w',
      timeoutSeconds: 60,
      interactive: false,
      focusOnSpawn: false,
      tracking: {
        projectId: 'p',
        worktreeId: 'w',
        scriptKey: 'project:pr:create',
        kind: 'hook',
      },
    });
  });

  it('maps a chat if-command: exit 2 stops, other failures fail, success launches the chat', async () => {
    const chat = (ifCommand: string): HookAction => ({
      type: 'chat',
      prompt: 'Review it',
      'if-command': ifCommand,
    });

    const stopped = start(hook('project', 'pr:create', [chat('gate-2')]));
    await settle();
    shellFor('gate-2').finish({ success: false, exitCode: 2 });
    const { durationMs, ...stoppedResult } = await stopped;
    expect(typeof durationMs).toBe('number');
    expect(stoppedResult).toEqual({
      success: false,
      stopped: true,
      exitCode: 2,
      output:
        'Chat if-command exited with code 2 and intentionally stopped the hook.',
      timedOut: false,
    });
    expect(shellFor('gate-2').options.tracking).toEqual({
      projectId: 'p',
      worktreeId: 'w',
      scriptKey: 'project:pr:create',
    });

    const failed = start(hook('project', 'pr:create', [chat('gate-1')]));
    await settle();
    shellFor('gate-1').finish({ success: false, exitCode: 1 });
    expect(await failed).toMatchObject({
      success: false,
      stopped: false,
      exitCode: 1,
      output: 'Chat if-command failed with exit code 1.',
    });

    const timed = start(hook('project', 'pr:create', [chat('gate-t')]));
    await settle();
    shellFor('gate-t').finish({
      success: false,
      exitCode: null,
      timedOut: true,
    });
    expect(await timed).toMatchObject({
      stopped: false,
      timedOut: true,
      output: 'Chat if-command timed out.',
    });
    expect(mockedLaunchHookChat).not.toHaveBeenCalled();

    const launched = start(
      hook('workspace-repo', 'pr:create', [chat('gate-0')], 'a'),
    );
    await settle();
    shellFor('gate-0').finish({});
    expect(await launched).toMatchObject({ success: true, exitCode: 0 });
    expect(mockedLaunchHookChat).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p',
        worktreeId: 'w',
        prompt: 'Review it',
        triggerName: 'pr:create',
        selectedRepoId: 'a',
      }),
    );
    expect(mockLog.filter((line) => line.startsWith('run-4|'))).toEqual([
      'run-4| $ [1/1] Chat action [if-command]',
      'run-4| Running chat if-command gate.',
    ]);
  });

  it('logs a started or queued workflow and fails on a thrown launch', async () => {
    const pipeline: HookAction = {
      type: 'pipeline',
      source: 'project',
      id: 'review',
    };
    mockedLaunchHookPipeline.mockResolvedValueOnce({
      status: 'queued',
      pipelineName: 'Review',
    } as Awaited<ReturnType<typeof launchHookPipeline>>);
    expect(await start(hook('project', 'pr:create', [pipeline]))).toMatchObject(
      {
        success: true,
        exitCode: 0,
      },
    );
    expect(mockLog).toEqual([
      'run-1| $ [1/1] Workflow action (project/review)',
      'run-1| Queued workflow "Review" — waiting for active workflow runs to finish.',
    ]);

    mockedLaunchHookPipeline.mockRejectedValueOnce(new Error('bad pipeline'));
    expect(await start(hook('project', 'pr:create', [pipeline]))).toEqual({
      success: false,
      stopped: false,
      exitCode: 1,
      output: 'bad pipeline',
      timedOut: false,
      durationMs: 0,
    });
    expect(mockLog.at(-1)).toBe('run-2| bad pipeline');
  });

  it('refuses a hook while its worktree is being archived', async () => {
    await withWorkspaceTargetArchiveDrain('p', 'w', async () => {
      await expect(start(hook('project', 'pr:create'))).rejects.toThrow(
        'This worktree is being archived. Retry after archiving finishes.',
      );
    });
    expect(trace).toEqual([]);
  });
});

describe('CAN-5062 golden: hook cancellation generations', () => {
  const cancelledBeforeStart = {
    success: false,
    stopped: true,
    exitCode: null,
    output: 'Hook run cancelled before start.',
    timedOut: false,
    durationMs: 0,
  };

  it('cancels a repo target queue and aborts its running hook, and later hooks run', async () => {
    const running = start(hook('workspace-repo', 'pr:create', undefined, 'a'));
    const queued = start(hook('workspace-repo', 'pr:merged', undefined, 'a'));
    const otherRepo = start(
      hook('workspace-repo', 'pr:merged', undefined, 'b'),
    );
    await settle();

    await stopHooksForRepoTarget({
      projectId: 'p',
      worktreeId: 'w',
      repoId: 'a',
    });

    expect(await running).toEqual({
      success: false,
      stopped: true,
      exitCode: null,
      output: '',
      timedOut: false,
      durationMs: 1,
    });
    expect(await queued).toEqual(cancelledBeforeStart);
    expect(trace).not.toContain('started workspace-repo:a:pr:merged');

    const later = start(hook('workspace-repo', 'pr:closed', undefined, 'a'));
    await settle();
    expect(trace).toContain('started workspace-repo:a:pr:closed');
    shellFor('run pr:closed').finish({});
    expect((await later).success).toBe(true);

    shellFor('run pr:merged').finish({});
    expect((await otherRepo).success).toBe(true);
  });

  it('cancels every queued target of a worktree and leaves other worktrees alone', async () => {
    const running = start(hook('project', 'pr:create'));
    const queued = start(hook('project', 'pr:merged'));
    const elsewhere = start(hook('project', 'pr:closed'), {
      worktreeId: 'w-2',
    });
    await settle();

    await stopHooksForWorktree({ projectId: 'p', worktreeId: 'w' });

    expect((await running).stopped).toBe(true);
    expect(await queued).toEqual(cancelledBeforeStart);
    shellFor('run pr:closed').finish({});
    expect((await elsewhere).success).toBe(true);
  });

  it('stops every registered run of one hook key and returns the last result', async () => {
    const descriptor = hook('project', 'pr:create');
    const first = start(descriptor);
    const second = start(descriptor);
    await settle();

    const result = await stopRunningHook({
      projectId: 'p',
      worktreeId: 'w',
      hookKey: descriptor.hookKey,
    });

    expect(await first).toMatchObject({ stopped: true, exitCode: null });
    expect(await second).toEqual(cancelledBeforeStart);
    expect(result).toEqual(cancelledBeforeStart);
    expect(
      await stopRunningHook({ projectId: 'p', worktreeId: 'w', hookKey: 'x' }),
    ).toBeNull();
  });

  it('stopAllRunningHooks cancels queues and aborts runs everywhere', async () => {
    const running = start(hook('workspace-root', 'pr:create'));
    const queued = start(hook('workspace-root', 'pr:merged'));
    await settle();
    stopAllRunningHooks();
    expect((await running).stopped).toBe(true);
    expect(await queued).toEqual(cancelledBeforeStart);
  });
});
