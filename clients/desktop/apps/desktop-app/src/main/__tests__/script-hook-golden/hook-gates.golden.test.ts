import type * as SharedHooks from '@canopy/desktop-shared/hooks';
import type { ScriptRunResponse } from '@canopy/desktop-shared/types';
import type * as HookRunner from '../../lib/hook-runner';
import type { InitiatedWorkRuntimeHelper } from '../helpers/initiated-work-runtime';

// The core hook source decides pause and split lock for every firing
// (CAN-4146), over a real initiated-work engine.
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): { initiatedWork: unknown } => ({
    initiatedWork: jest
      .requireActual<InitiatedWorkRuntimeHelper>(
        '../helpers/initiated-work-runtime',
      )
      .testInitiatedWork().engine,
  }),
}));
jest.mock('../../lib/hook-log-store', () => ({
  startHookRunLog: jest.fn((args: { hook: unknown }) =>
    Promise.resolve({
      projectId: 'p-1',
      worktreeId: 'w-1',
      hook: args.hook,
      runId: 'run-1',
    }),
  ),
  appendHookRunLogLines: jest.fn(() => Promise.resolve()),
  completeHookRunLog: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../lib/worktree-data-env', () => ({
  buildWorktreeDataEnv: (
    _projectId: string,
    _worktreeId: string,
    env?: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv => ({ ...env }),
}));
jest.mock('../../lib/script-runner', () => ({
  runShellScript: jest.fn(
    (): Promise<ScriptRunResponse> =>
      Promise.resolve({
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 1,
      }),
  ),
}));

jest.mock('../../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));
jest.mock('../../lib/workspace-persistence', () => {
  const readWorkspaceWorktrees = jest.fn(() => Promise.resolve([]));
  return {
    readWorkspaceConfig: jest.fn(),
    readWorkspaceWorktrees,
    // The pause reader needs the list's authority (CAN-7094); a test's rows
    // come from `readWorkspaceWorktrees`, read as a complete list.
    readWorkspaceWorktreesDetailed: jest.fn(async () => ({
      worktrees: await readWorkspaceWorktrees(),
      authority: 'ok',
    })),
  };
});
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ scriptTimeoutMinutes: 7 }),
  ),
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: jest.fn(() => true),
}));
jest.mock('../../lib/hook-watcher-events', () => {
  const { createHookKey } = jest.requireActual<typeof SharedHooks>(
    '@canopy/desktop-shared/hooks',
  );
  return {
    hookKeyForScope: (args: {
      scope: 'project' | 'workspace-root' | 'workspace-repo';
      triggerName: string;
      repoId?: string;
    }): string => createHookKey(args.scope, args.triggerName, args.repoId),
    buildHookWatcherVariables: jest.fn(() => ({ VARIABLES: 'yes' })),
    fireHookTriggeredWatchers: jest.fn(),
  };
});
// A source's hand-off to the runner is captured by `runHook` and kept from
// running; tests that run it pass `actualRunHook`. A manual run is prepared
// by the core hook source (`fireHook`), whose prepared run reaches `runHook`.
jest.mock('../../lib/hook-runner', () => {
  const actual = jest.requireActual<typeof HookRunner>('../../lib/hook-runner');
  const runHook = jest.fn<
    ReturnType<typeof HookRunner.runHook>,
    Parameters<typeof HookRunner.runHook>
  >(() =>
    Promise.resolve({
      success: true,
      stopped: false,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 1,
    }),
  );
  return {
    ...actual,
    runHook,
    fireHook: jest.fn(
      (
        request: HookRunner.HookFiringRequest,
        prepare: () => Promise<HookRunner.HookRunPreparation>,
      ) =>
        actual.fireHook(request, async () => {
          const prepared = await prepare();
          if (prepared.kind !== 'ready') return prepared;
          return {
            kind: 'unconfigured' as const,
            response: await runHook(prepared.options),
          };
        }),
    ),
    actualRunHook: actual.runHook,
  };
});
jest.mock('../../lib/github-pr-hook-state', () => ({
  getProjectRepoStorageKey: (): string => 'project-storage',
  getWorkspaceRootRepoStorageKey: (): string => 'root-storage',
  getWorkspaceRepoStorageKey: (repoId: string): string =>
    `repo-storage:${repoId}`,
  readCurrentPrTrackingSnapshot: jest.fn(),
}));

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { HOOK_PAUSE_UNKNOWN_MESSAGE } from '@canopy/core-runtime/node/initiated-work';
import {
  getHookTriggerDisplayName,
  type HookAction,
} from '@canopy/desktop-shared/hooks';
import {
  IPC_CHANNELS,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { PersistedPrSnapshotFileV1 } from '@canopy/desktop-shared/types/github';
import { getProjectConfigFileCandidates } from '../../lib/canopy-json';
import { readCurrentPrTrackingSnapshot } from '../../lib/github-pr-hook-state';
import { createProjectHookDescriptor } from '../../lib/hook-events';
import {
  getResolvedHookActions,
  resolveProjectHooks,
} from '../../lib/hook-resolver';
import { runHook } from '../../lib/hook-runner';
import {
  buildHookWatcherVariables,
  fireHookTriggeredWatchers,
} from '../../lib/hook-watcher-events';
import { getWorktreeDir } from '../../lib/paths';
import { runShellScript } from '../../lib/script-runner';
import { sendToWindow } from '../../lib/window-send';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
} from '../../lib/workspace-persistence';
import { triggerWorktreePrecommitFailureHook } from '../../lib/worktree-precommit-failure-hook';
import { runHookCommand } from '../../services/hooks-service';
import {
  acquireSplitLock,
  releaseSplitLock,
  SplitLockError,
} from '../../services/split-lock-service';
import {
  closeTestInitiatedWork,
  readyTestInitiatedWork,
} from '../helpers/initiated-work-runtime';

const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedReadWorkspaceWorktreesDetailed = jest.mocked(
  readWorkspaceWorktreesDetailed,
);
const mockedRunShellScript = jest.mocked(runShellScript);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedFireWatchers = jest.mocked(fireHookTriggeredWatchers);
const mockedBuildVariables = jest.mocked(buildHookWatcherVariables);
const mockedRunHook = jest.mocked(runHook);
const { actualRunHook } = jest.requireMock<{
  actualRunHook: typeof HookRunner.runHook;
}>('../../lib/hook-runner');
const mockedReadSnapshot = jest.mocked(readCurrentPrTrackingSnapshot);

const TRIGGER = 'worktree:precommit:failure';
const ACTIONS: HookAction[] = [{ type: 'command', command: 'notify' }];

function config(
  hooks: WorkspaceConfigFile['hooks'],
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repoPath: '/does/not/exist',
    repos: [],
    hooks,
    ...overrides,
  };
}

function worktreesWithPaused(
  pausedHookKeys: string[],
): Awaited<ReturnType<typeof readWorkspaceWorktrees>> {
  return [{ id: 'w-1', pausedHookKeys }] as unknown as Awaited<
    ReturnType<typeof readWorkspaceWorktrees>
  >;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

beforeAll(async () => {
  await readyTestInitiatedWork();
});

afterAll(() => {
  closeTestInitiatedWork();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CAN-5062 golden: automatic hook paused gate', () => {
  const window = { id: 'window' };
  const trigger = (): Promise<void> =>
    triggerWorktreePrecommitFailureHook({
      projectId: 'p-1',
      worktreeId: 'w-1',
      repo: { repoPath: '/repo', repoName: 'Repo' },
      error: Object.assign(new Error('ignored'), { stderr: 'lint failed  \n' }),
      commitMessage: 'feat: x',
      getWindow: () => window as never,
    });

  it('skips a paused hook, tells the renderer, and still fires watchers', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: ACTIONS }));
    mockedReadWorkspaceWorktrees.mockResolvedValue(
      worktreesWithPaused(['project:worktree:precommit:failure']),
    );
    mockedRunHook.mockImplementationOnce(actualRunHook);

    await trigger();
    await mockedRunHook.mock.results[0]?.value;

    const hook = createProjectHookDescriptor(TRIGGER, ACTIONS);
    expect(hook.hookKey).toBe('project:worktree:precommit:failure');
    // The core hook source decides the pause (CAN-4146): nothing runs.
    expect(mockedRunHook.mock.calls[0]?.[0]).toMatchObject({
      invocation: 'automatic',
      pause: 'enforce',
    });
    expect(mockedRunShellScript).not.toHaveBeenCalled();
    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      window,
      IPC_CHANNELS.hookSkippedPaused,
      {
        projectId: 'p-1',
        worktreeId: 'w-1',
        hook,
        triggerDisplayName: getHookTriggerDisplayName(TRIGGER),
      },
    );
    expect(mockedBuildVariables).toHaveBeenCalledWith({
      projectId: 'p-1',
      worktreeId: 'w-1',
      scope: 'project',
      repoId: undefined,
      env: {
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR: 'lint failed',
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE: 'feat: x',
      },
    });
    expect(mockedFireWatchers).toHaveBeenCalledWith({
      projectId: 'p-1',
      worktreeId: 'w-1',
      triggerName: TRIGGER,
      scope: 'project',
      repoId: undefined,
      repoName: 'Repo',
      hook,
      configured: true,
      paused: true,
      variables: { VARIABLES: 'yes' },
    });
  });

  it('runs an unpaused hook automatically with the failure environment and timeout', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: ACTIONS }));
    mockedReadWorkspaceWorktrees.mockResolvedValue(
      worktreesWithPaused(['other']),
    );

    await trigger();
    await settle();

    expect(mockedRunHook).toHaveBeenCalledTimes(1);
    expect(mockedRunHook.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'p-1',
      worktreeId: 'w-1',
      hook: createProjectHookDescriptor(TRIGGER, ACTIONS),
      cwd: '/repo',
      invocation: 'automatic',
      pause: 'enforce',
      timeoutSeconds: 420,
      env: {
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR: 'lint failed',
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE: 'feat: x',
      },
    });
    expect(mockedFireWatchers).toHaveBeenCalledWith(
      expect.objectContaining({ configured: true, paused: false }),
    );
  });

  it('fires watchers for an unconfigured or disabled trigger and runs nothing', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: null }));
    mockedReadWorkspaceWorktrees.mockResolvedValue(
      worktreesWithPaused(['project:worktree:precommit:failure']),
    );

    await trigger();

    expect(mockedRunHook).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockedFireWatchers).toHaveBeenCalledWith(
      expect.objectContaining({
        hook: undefined,
        configured: false,
        paused: true,
      }),
    );
  });

  // CAN-7094: a pause state that can't be read fails closed. The firing is
  // recorded as skipped, nothing runs, and the renderer isn't told the hook
  // is paused, since it isn't known to be.
  it('skips the hook when the worktree list read fails', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: ACTIONS }));
    mockedReadWorkspaceWorktrees.mockRejectedValue(new Error('corrupt'));
    mockedRunHook.mockImplementationOnce(actualRunHook);

    await trigger();
    const response: unknown = await mockedRunHook.mock.results[0]?.value;

    expect(mockedRunHook).toHaveBeenCalledTimes(1);
    expect(mockedRunShellScript).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      success: false,
      stopped: true,
      output: HOOK_PAUSE_UNKNOWN_MESSAGE,
    });
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it('skips the hook when the worktree list is unreadable', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: ACTIONS }));
    mockedReadWorkspaceWorktreesDetailed.mockResolvedValueOnce({
      worktrees: [],
      authority: 'unreadable',
    });
    mockedRunHook.mockImplementationOnce(actualRunHook);

    await trigger();
    const response: unknown = await mockedRunHook.mock.results[0]?.value;

    expect(mockedRunShellScript).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      stopped: true,
      output: HOOK_PAUSE_UNKNOWN_MESSAGE,
    });
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  // Rows are stored as they were read: paused keys that are not a list of
  // strings must not read as nothing paused.
  it('skips the hook when the stored paused hooks are not a list of keys', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: ACTIONS }));
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      { id: 'w-1', pausedHookKeys: 'project:worktree:precommit:failure' },
    ] as unknown as Awaited<ReturnType<typeof readWorkspaceWorktrees>>);
    mockedRunHook.mockImplementationOnce(actualRunHook);

    await trigger();
    const response: unknown = await mockedRunHook.mock.results[0]?.value;

    expect(mockedRunShellScript).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      stopped: true,
      output: HOOK_PAUSE_UNKNOWN_MESSAGE,
    });
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });
});

describe('CAN-5062 golden: manual hook run gates', () => {
  const snapshot = {
    pr: { number: 1 },
  } as unknown as PersistedPrSnapshotFileV1;
  const request = {
    target: 'project',
    projectId: 'p-1',
    worktreeId: 'w-1',
    triggerName: 'pr:create',
  } as const;

  it('refuses a split-locked worktree before reading anything', async () => {
    acquireSplitLock('p-1', 'w-1');
    try {
      const refusal = runHookCommand(request);
      await expect(refusal).rejects.toThrow(SplitLockError);
      await expect(refusal).rejects.toThrow(
        'This worktree is locked while a Split PR is in progress; running a hook is unavailable until it finishes.',
      );
    } finally {
      releaseSplitLock('p-1', 'w-1');
    }
    expect(mockedReadWorkspaceConfig).not.toHaveBeenCalled();
    expect(mockedRunHook).not.toHaveBeenCalled();
  });

  it('succeeds as a no-op when the trigger has no actions, even without a PR', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({}));
    expect(await runHookCommand(request)).toEqual({
      success: true,
      stopped: false,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 0,
    });
    expect(mockedReadSnapshot).not.toHaveBeenCalled();
  });

  it('requires an active PR snapshot for a configured hook', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      config({ 'pr:create': ACTIONS }),
    );
    mockedReadSnapshot.mockResolvedValue({
      snapshot: null,
      currentSnapshotPath: '/current',
      previousSnapshotPath: '/previous',
    });
    await expect(runHookCommand(request)).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'No current PR snapshot exists for this worktree.',
    });
    expect(mockedReadSnapshot).toHaveBeenCalledWith({
      projectId: 'p-1',
      worktreeId: 'w-1',
      repoStorageKey: 'project-storage',
    });
    expect(mockedRunHook).not.toHaveBeenCalled();
  });

  it('runs a configured hook manually in the worktree with the PR snapshot', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      config({ 'pr:create': ACTIONS }),
    );
    mockedReadSnapshot.mockResolvedValue({
      snapshot,
      currentSnapshotPath: '/current',
      previousSnapshotPath: '/previous',
    });
    await runHookCommand(request);
    expect(mockedRunHook.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'p-1',
      worktreeId: 'w-1',
      hook: createProjectHookDescriptor('pr:create', ACTIONS),
      cwd: getWorktreeDir('p-1', 'w-1'),
      invocation: 'manual',
      pause: 'bypass',
      timeoutSeconds: 420,
      currentSnapshot: snapshot,
      currentSnapshotPath: '/current',
      previousSnapshotPath: '/previous',
    });
  });

  it('refuses an unknown workspace repo', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      config({}, { type: 'multi-repo', repos: [] }),
    );
    await expect(
      runHookCommand({
        target: 'workspace-repo',
        workspaceId: 'p-1',
        worktreeId: 'w-1',
        repoId: 'missing',
        triggerName: 'pr:create',
      }),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Repo not found.' });
  });
});

describe('CAN-5062 golden: owner gate on execution-context overlays', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'can-5062-hook-owner-'));
    const configName = basename(getProjectConfigFileCandidates(repo)[0] ?? '');
    await writeFile(
      join(repo, configName),
      JSON.stringify({
        version: 1,
        hooks: { 'pr:create': [{ type: 'chat', prompt: 'Review it' }] },
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function resolveWith(
    executionContext: string,
    owner: WorkspaceConfigFile['owner'],
  ): Promise<HookAction[] | null> {
    const resolved = await resolveProjectHooks({
      repoPath: repo,
      owner,
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: ' Review it ',
            executionContext,
            localExecutionContextOverlay: true,
          },
        ],
      },
    });
    return getResolvedHookActions(resolved, 'pr:create');
  }

  const owner = (organizationId: string): WorkspaceConfigFile['owner'] =>
    ({ type: 'organization', organizationId }) as WorkspaceConfigFile['owner'];

  it('applies an organization overlay only for the owning organization', async () => {
    expect(await resolveWith('org:org-1', owner('org-1'))).toEqual([
      { type: 'chat', prompt: 'Review it', executionContext: 'org:org-1' },
    ]);
    expect(await resolveWith('org:org-1', owner('org-2'))).toEqual([
      { type: 'chat', prompt: 'Review it' },
    ]);
    expect(await resolveWith('org:org-1', undefined)).toEqual([
      { type: 'chat', prompt: 'Review it' },
    ]);
  });

  it('applies a personal overlay regardless of owner', async () => {
    expect(await resolveWith('personal', undefined)).toEqual([
      { type: 'chat', prompt: 'Review it', executionContext: 'personal' },
    ]);
  });
});
