import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
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
import { desktopWorkerGitCommitPushHost } from '../worker-git-commit-push-adapter';
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
