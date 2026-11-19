import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
import { SINGLE_REPO_USAGE_REPO_ID } from '@canopy/desktop-shared/types';
import { runPrAction } from '../../services/pr-service';
import * as sidebarItems from '../../lib/sidebar-items';
import * as repoEntries from '../../lib/worktree-repo-entries';
import {
  initGitRepository,
  gitFreeEnvironment,
} from '../../../../../core-daemon/src/__tests__/filesystem-fixtures';
import { getWorkspaceWorktreeDir } from '../../lib/paths';
import { commitWorktreeRepository } from '../worker-git-commit-push-dispatch';
import {
  fetchWorktreeRepository,
  pullWorktreeRepository,
} from '../worker-git-sync-dispatch';
import {
  createRouteHarness,
  type RouteHarness,
} from './daemon-files-route-harness';
import {
  desktopGitCommitPushPort,
  desktopWorkerGitCommitPushHost,
} from '../worker-git-commit-push-adapter';
import type { GitCommitPushPort } from '@canopy/core-runtime/node/git';

jest.mock('../../lib/github-pr', () => ({
  fetchPrStatusForWorktree: jest.fn((): Promise<null> => Promise.resolve(null)),
}));
jest.mock('../../lib/github-poller', () => ({
  refreshNow: jest.fn((): Promise<null> => Promise.resolve(null)),
}));
jest.mock('../../lib/worktree-precommit-failure-hook', () => ({
  triggerWorktreePrecommitFailureHook: jest.fn(
    (): Promise<void> => Promise.resolve(),
  ),
}));
jest.mock('../../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleKnown: () => Promise<void>;
  } => ({ scheduleKnown: (): Promise<void> => Promise.resolve() }),
}));

let harness: RouteHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  jest.restoreAllMocks();
});

it('commit and push never contact the daemon even when the Files route is ready', async () => {
  const calls: string[] = [];
  const port: GitCommitPushPort = {
    currentBranch: () => Promise.resolve('topic'),
    head: () => Promise.resolve('a'.repeat(40)),
    trackingHead: () => Promise.resolve(null),
    stageAll: () => {
      calls.push('add');
      return Promise.resolve();
    },
    commit: () => {
      calls.push('commit');
      return Promise.resolve('b'.repeat(40));
    },
    push: (target) => {
      calls.push(`push ${target.headSha}:${target.branch}`);
      return Promise.resolve();
    },
  };
  jest
    .spyOn(desktopWorkerGitCommitPushHost, 'resolveCheckout')
    .mockResolvedValue('/unused');
  jest.spyOn(desktopWorkerGitCommitPushHost, 'port').mockReturnValue(port);
  harness = await createRouteHarness();
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'git',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['worker.git.write'],
  };
  const scope = { workspaceId: 'single', worktreeId: 'task' };
  await expect(
    harness.runtime.instruction(
      'worker.git.commit',
      { scope, message: 'message', expectedHeadSha: 'a'.repeat(40) },
      { caller, metadata: { idempotencyKey: 'commit' } },
    ),
  ).resolves.toMatchObject({ status: 'completed' });
  await expect(
    harness.runtime.instruction(
      'worker.git.push',
      {
        scope,
        remote: 'origin',
        branch: 'topic',
        expectedLocalHeadSha: 'a'.repeat(40),
        expectedRemoteHeadSha: null,
        setUpstream: true,
      },
      { caller, metadata: { idempotencyKey: 'push' } },
    ),
  ).resolves.toMatchObject({ status: 'completed' });
  // The checked commit, not HEAD as it stands at push time (CAN-6869).
  expect(calls).toEqual(['add', 'commit', `push ${'a'.repeat(40)}:topic`]);
  expect(harness.connectionsFactory).not.toHaveBeenCalled();
  expect(harness.daemon.queries).toEqual([]);
});

it('the registered-worktree IPC projection dispatches a fresh key and captures the real commit hash', async () => {
  harness = await createRouteHarness();
  const home = await initGitRepository(harness.dataRoot);
  const git = (args: string[]): string =>
    execFileSync('/usr/bin/git', args, {
      cwd: home,
      env: gitFreeEnvironment(),
      encoding: 'utf8',
    }).trim();
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);
  const instruction = jest.spyOn(harness.runtime, 'instruction');
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'git',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: [],
  };
  const request = { projectId: 'single', worktreeId: 'task' };
  const entry = { repoPath: getWorkspaceWorktreeDir('single', 'task') };
  await writeFile(join(home, 'new.txt'), 'one');
  const hash = await commitWorktreeRepository(
    harness.runtime,
    caller,
    request,
    entry,
    'one',
  );
  expect(hash).toBe(git(['rev-parse', 'HEAD']));
  const anyString: unknown = expect.any(String);
  expect(instruction).toHaveBeenCalledWith(
    'worker.git.commit',
    {
      scope: { workspaceId: 'single', worktreeId: 'task' },
      expectedHeadSha: anyString,
      message: 'one',
    },
    {
      caller: { ...caller, grants: ['worker.git.write'] },
      metadata: { idempotencyKey: anyString },
    },
  );
  await writeFile(join(home, 'new.txt'), 'two');
  await commitWorktreeRepository(
    harness.runtime,
    caller,
    request,
    entry,
    'two',
  );
  expect(instruction.mock.calls[0]?.[2]?.metadata?.idempotencyKey).not.toBe(
    instruction.mock.calls[1]?.[2]?.metadata?.idempotencyKey,
  );
  const origin = join(harness.dataRoot, 'origin.git');
  git(['init', '--bare', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-u', 'origin', 'HEAD']);
  await fetchWorktreeRepository(harness.runtime, caller, request, entry, {
    prune: false,
  });
  await pullWorktreeRepository(harness.runtime, caller, request, entry, {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    strategy: 'rebase',
  });
  expect(instruction).toHaveBeenCalledWith(
    'worker.git.fetch',
    {
      scope: { workspaceId: 'single', worktreeId: 'task' },
      prune: false,
    },
    { caller: { ...caller, grants: ['worker.git.write'] } },
  );
  expect(instruction).toHaveBeenCalledWith(
    'worker.git.pull',
    expect.objectContaining({
      scope: { workspaceId: 'single', worktreeId: 'task' },
      strategy: 'rebase',
    }),
    { caller: { ...caller, grants: ['worker.git.write'] } },
  );
  expect(harness.connectionsFactory).not.toHaveBeenCalled();
});

it('refuses relay and Portal callers, missing keys and same-tip branch changes before Git effects', async () => {
  const resolve = jest
    .spyOn(desktopWorkerGitCommitPushHost, 'resolveCheckout')
    .mockResolvedValue('/unused');
  harness = await createRouteHarness();
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'git',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['worker.git.write'],
  };
  const scope = { workspaceId: 'single', worktreeId: 'task' };
  const params = { scope, message: 'message', expectedHeadSha: 'a'.repeat(40) };
  for (const denied of [
    { ...caller, principalId: 'local-desktop-renderer:1' },
    { ...caller, interfaceKind: 'portal' } as const,
    { ...caller, principalId: 'untrusted' },
  ]) {
    await expect(
      harness.runtime.instruction('worker.git.commit', params, {
        caller: denied,
        metadata: { idempotencyKey: 'key' },
      }),
    ).rejects.toMatchObject({
      payload: {
        code: 'worker.git.commit.callerRefused',
        retry: { kind: 'never' },
      },
    });
  }
  await expect(
    harness.runtime.instruction('worker.git.commit', params, { caller }),
  ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  expect(resolve).not.toHaveBeenCalled();
  let branch = 'topic';
  const commits = jest.fn(
    (): Promise<string> => Promise.resolve('b'.repeat(40)),
  );
  const pushes = jest.fn((): Promise<void> => Promise.resolve());
  const port: GitCommitPushPort = {
    currentBranch: () => Promise.resolve(branch),
    head: () => Promise.resolve('a'.repeat(40)),
    trackingHead: () => Promise.resolve(null),
    stageAll: () => {
      branch = 'other-at-same-tip';
      return Promise.resolve();
    },
    commit: commits,
    push: pushes,
  };
  jest.spyOn(desktopWorkerGitCommitPushHost, 'port').mockReturnValue(port);
  await expect(
    harness.runtime.instruction('worker.git.commit', params, {
      caller,
      metadata: { idempotencyKey: 'commit' },
    }),
  ).rejects.toMatchObject({
    payload: {
      code: 'worker.git.commit.headChanged',
      retry: { kind: 'after_refresh' },
    },
  });
  await expect(
    harness.runtime.instruction(
      'worker.git.push',
      {
        scope,
        remote: 'origin',
        branch: 'topic',
        expectedLocalHeadSha: 'a'.repeat(40),
        expectedRemoteHeadSha: null,
        setUpstream: true,
      },
      { caller, metadata: { idempotencyKey: 'push' } },
    ),
  ).rejects.toMatchObject({
    payload: {
      code: 'worker.git.push.headChanged',
      retry: { kind: 'after_refresh' },
    },
  });
  expect(commits).not.toHaveBeenCalled();
  expect(pushes).not.toHaveBeenCalled();
  expect(harness.connectionsFactory).not.toHaveBeenCalled();
});

async function portalGitFixture(route: RouteHarness): Promise<{
  home: string;
  git: (args: string[]) => string;
}> {
  const home = await initGitRepository(route.dataRoot);
  jest.spyOn(sidebarItems, 'readAllSidebarItems').mockResolvedValue({
    version: 1,
    items: [
      {
        id: 'single',
        name: 'single',
        type: 'single-repo',
        repoPath: home,
        worktrees: [],
        color: '#fff',
        collapsed: false,
        order: 0,
      },
      {
        id: 'multi',
        name: 'multi',
        type: 'multi-repo',
        repos: [],
        worktrees: [],
        color: '#fff',
        collapsed: false,
        order: 1,
      },
    ],
  });
  const git = (args: string[]): string =>
    execFileSync('/usr/bin/git', args, {
      cwd: home,
      env: gitFreeEnvironment(),
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['checkout', '-b', 'topic']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);
  const origin = join(route.dataRoot, 'origin.git');
  git(['init', '--bare', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-u', 'origin', 'HEAD']);
  return { home, git };
}

it.each(['commit_and_push', 'push', 'pull'] as const)(
  'Portal single-repo %s reaches the desktop worker dispatcher',
  async (action): Promise<void> => {
    harness = await createRouteHarness();
    const { home, git } = await portalGitFixture(harness);
    if (action !== 'pull') {
      await writeFile(join(home, 'portal.txt'), 'Portal change');
      if (action === 'push') {
        git(['add', '-A']);
        git(['commit', '-m', 'ahead']);
      }
    }
    const instruction = jest.spyOn(harness.runtime, 'instruction');
    const result = await runPrAction({
      workspaceLocalId: 'single',
      worktreeLocalId: 'task',
      repoIds: ['single'],
      ...(action === 'commit_and_push'
        ? { action, commitMessage: 'Portal change' }
        : { action }),
    });
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        workspaceLocalId: 'single',
        worktreeLocalId: 'task',
        number: null,
        url: null,
      }),
    );
    const expected =
      action === 'commit_and_push'
        ? ['worker.git.commit', 'worker.git.push']
        : [`worker.git.${action}`];
    expect(instruction.mock.calls.map(([name]) => name)).toEqual(expected);
    for (const [, params, options] of instruction.mock.calls) {
      expect(params).toEqual(
        expect.objectContaining({
          scope: { workspaceId: 'single', worktreeId: 'task' },
        }),
      );
      expect(options?.caller).toMatchObject({
        principalId: 'core',
        clientInstanceId: 'electron-main-portal-git',
        interfaceKind: 'desktop',
        grants: ['worker.git.write'],
      });
    }
    if (action !== 'pull') {
      expect(git(['rev-parse', 'refs/remotes/origin/topic'])).toBe(
        git(['rev-parse', 'HEAD']),
      );
      expect(git(['status', '--porcelain'])).toBe('');
    }
    expect(harness.connectionsFactory).not.toHaveBeenCalled();
    expect(harness.daemon.queries).toEqual([]);
  },
);

it.each([
  { repoIds: undefined, selected: true },
  { repoIds: [], selected: true },
  { repoIds: ['not-selected'], selected: false },
  { repoIds: [SINGLE_REPO_USAGE_REPO_ID], selected: false },
])(
  'Portal filters on its original repo IDs ($repoIds)',
  async ({ repoIds, selected }): Promise<void> => {
    harness = await createRouteHarness();
    const { home, git } = await portalGitFixture(harness);
    const before = git(['rev-parse', 'HEAD']);
    await writeFile(join(home, 'portal.txt'), 'Portal change');
    const instruction = jest.spyOn(harness.runtime, 'instruction');
    await runPrAction({
      workspaceLocalId: 'single',
      worktreeLocalId: 'task',
      action: 'commit_and_push',
      commitMessage: 'Portal change',
      repoIds,
    });
    expect(instruction.mock.calls.map(([name]) => name)).toEqual(
      selected ? ['worker.git.commit', 'worker.git.push'] : [],
    );
    expect(git(['rev-parse', 'HEAD']) === before).toBe(!selected);
    expect(git(['status', '--porcelain'])).toBe(
      selected ? '' : '?? portal.txt',
    );
  },
);

it('Portal dispatches a single-repo checkout even when its sidebar item is absent', async (): Promise<void> => {
  harness = await createRouteHarness();
  await portalGitFixture(harness);
  jest.spyOn(sidebarItems, 'readAllSidebarItems').mockResolvedValue({
    version: 1,
    items: [],
  });
  const instruction = jest.spyOn(harness.runtime, 'instruction');
  await runPrAction({
    workspaceLocalId: 'single',
    worktreeLocalId: 'task',
    action: 'push',
    repoIds: ['single'],
  });
  expect(instruction).toHaveBeenCalledTimes(1);
  expect(instruction).toHaveBeenCalledWith(
    'worker.git.push',
    expect.objectContaining({
      scope: { workspaceId: 'single', worktreeId: 'task' },
    }),
    expect.anything(),
  );
});

it('Portal keeps a multi-repo member ID even when it equals the workspace ID', async (): Promise<void> => {
  harness = await createRouteHarness();
  const { home } = await portalGitFixture(harness);
  const member = join(
    getWorkspaceWorktreeDir('multi', 'task'),
    'repos',
    'multi',
  );
  await mkdir(join(member, '..'), { recursive: true });
  await rename(home, member);
  const instruction = jest.spyOn(harness.runtime, 'instruction');
  instruction.mockRejectedValue(new Error('worker refused'));
  jest
    .spyOn(repoEntries, 'listWorkspaceWorktreeRepoEntries')
    .mockResolvedValue([
      {
        repoId: 'multi',
        repoName: 'Member',
        repoPath: member,
      },
    ]);
  await expect(
    runPrAction({
      workspaceLocalId: 'multi',
      worktreeLocalId: 'task',
      action: 'pull',
      repoIds: ['multi'],
    }),
  ).rejects.toMatchObject({
    code: 'execution_failed',
    message: 'worker refused',
  });
  expect(instruction).toHaveBeenCalledTimes(1);
  expect(instruction).toHaveBeenCalledWith(
    'worker.git.pull',
    expect.objectContaining({
      scope: { workspaceId: 'multi', worktreeId: 'task', repoId: 'multi' },
    }),
    expect.anything(),
  );
});

it('Portal refuses a concurrent HEAD change after staging without committing or pushing', async (): Promise<void> => {
  harness = await createRouteHarness();
  const { home, git } = await portalGitFixture(harness);
  const before = git(['rev-parse', 'HEAD']);
  await writeFile(join(home, 'portal.txt'), 'Portal change');
  const commit = jest.fn((): Promise<string> => Promise.resolve('unused'));
  const push = jest.fn((): Promise<void> => Promise.resolve());
  jest
    .spyOn(desktopWorkerGitCommitPushHost, 'port')
    .mockImplementation((repoPath): GitCommitPushPort => {
      const port = desktopGitCommitPushPort(repoPath);
      return {
        ...port,
        stageAll: async (): Promise<void> => {
          await port.stageAll();
          git(['commit', '-m', 'concurrent change']);
        },
        commit,
        push,
      };
    });
  const instruction = jest.spyOn(harness.runtime, 'instruction');
  await expect(
    runPrAction({
      workspaceLocalId: 'single',
      worktreeLocalId: 'task',
      action: 'commit_and_push',
      commitMessage: 'Portal change',
    }),
  ).rejects.toMatchObject({
    code: 'execution_failed',
    message: 'The branch changed. Start a new push.',
  });
  expect(instruction.mock.calls.map(([name]) => name)).toEqual([
    'worker.git.commit',
  ]);
  expect(commit).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(git(['log', '-1', '--format=%s'])).toBe('concurrent change');
  expect(git(['rev-parse', 'HEAD'])).not.toBe(before);
  expect(git(['rev-parse', 'refs/remotes/origin/topic'])).toBe(before);
  expect(harness.connectionsFactory).not.toHaveBeenCalled();
});

it.each(['commit_and_push', 'push'] as const)(
  'Portal %s preserves both histories after a non-fast-forward rejection through the dispatcher',
  async (action): Promise<void> => {
    harness = await createRouteHarness();
    const { home, git } = await portalGitFixture(harness);
    const before = git(['rev-parse', 'HEAD']);
    const remote = git([
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      before,
      '-m',
      'remote change',
    ]);
    const origin = join(harness.dataRoot, 'origin.git');
    git(['push', 'origin', `${remote}:refs/heads/topic`]);
    await writeFile(join(home, 'portal.txt'), 'Portal change');
    if (action === 'push') {
      git(['add', '-A']);
      git(['commit', '-m', 'Portal change']);
    }
    const instruction = jest.spyOn(harness.runtime, 'instruction');
    const result = runPrAction({
      workspaceLocalId: 'single',
      worktreeLocalId: 'task',
      ...(action === 'commit_and_push'
        ? { action, commitMessage: 'Portal change' }
        : { action }),
    });
    await expect(result).rejects.toMatchObject({
      code: 'execution_failed',
    });
    await expect(result).rejects.toThrow(
      /\[rejected\].*(fetch first|non-fast-forward)/,
    );
    expect(instruction.mock.calls.map(([name]) => name)).toEqual(
      action === 'commit_and_push'
        ? ['worker.git.commit', 'worker.git.push']
        : ['worker.git.push'],
    );
    expect(git(['log', '-1', '--format=%s'])).toBe('Portal change');
    expect(git(['rev-parse', 'HEAD^'])).toBe(before);
    expect(git(['--git-dir', origin, 'rev-parse', 'refs/heads/topic'])).toBe(
      remote,
    );
    expect(git(['status', '--porcelain'])).toBe('');
    expect(harness.connectionsFactory).not.toHaveBeenCalled();
  },
);

it.each([
  'worker.git.worktree.add',
  'worker.git.worktree.remove',
  'worker.git.worktree.prune',
] as const)(
  '%s makes no daemon contact even with the Files connection ready',
  async (name) => {
    const { runtime } = (harness = await createRouteHarness({}));
    const scope = { workspaceId: 'absent', worktreeId: 'task' };
    const caller: CanopyCallerDescriptor = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'test',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop',
      // The grant source-change apply adds per call (CAN-7197).
      grants: ['worker.git.worktree.write'],
    };
    const call = (as: CanopyCallerDescriptor): Promise<unknown> =>
      name === 'worker.git.worktree.add'
        ? runtime.instruction(name, { scope, branch: 'topic' }, { caller: as })
        : runtime.instruction(
            name,
            {
              scope:
                name === 'worker.git.worktree.prune'
                  ? { workspaceId: 'absent' }
                  : scope,
            },
            { caller: as },
          );
    // Admitted: it reaches the desktop handler, which refuses the absent scope.
    await expect(call(caller)).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.worktree.scopeUnsupported',
      },
    });
    // worker.git.write alone no longer admits the worktree lifecycle.
    await expect(
      call({ ...caller, grants: ['worker.git.write'] }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(harness.daemon.names()).toEqual([]);
    expect(harness.connectionsFactory).not.toHaveBeenCalled();
    expect(harness.hostContext).not.toHaveBeenCalled();
  },
);

// CAN-7197: the local worker's core caller derives its grants from the
// worker instructions it carries, but never holds the worktree grant.
it('the desktop local worker caller is refused the worktree lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-worker-worktree-'));
  const operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  const runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
  try {
    expect(runtime.localWorker.operations).toContain('worker.git.worktree.add');
    const { operation: parent } = await operations.service.admit({
      kind: 'core.chat.turn.run',
      status: 'running',
      origin: { kind: 'client', sourceId: 'test' },
      owner: { kind: 'system', id: 'test' },
      scope: { workspaceId: 'absent', worktreeId: 'task', chatId: 'chat' },
    });
    const scope = { workspaceId: 'absent', worktreeId: 'task' };
    for (const [operation, params] of [
      ['worker.git.worktree.add', { scope, branch: 'topic' }],
      ['worker.git.worktree.remove', { scope }],
      ['worker.git.worktree.prune', { scope: { workspaceId: 'absent' } }],
    ] as const) {
      const dispatched = await runtime.localWorker.dispatch({
        parentOperationId: parent.operationId,
        operation,
        params,
        idempotencyKey: operation,
      });
      expect(dispatched.operation).toMatchObject({
        status: 'failed',
        error: { kind: 'permission_denied' },
      });
    }
  } finally {
    await runtime.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
