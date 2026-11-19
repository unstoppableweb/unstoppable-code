import {
  acquireSplitLock,
  releaseSplitLock,
} from '../services/split-lock-service';
import { useFakeSplitLockKeys } from './split-lock-key-fixture';
import { beginExclusiveGitAction } from '../services/git-action-exclusion';
import {
  finishGitActionCancellationScope,
  isGitActionActive,
} from '../ipc/git-action-cancellation';
// CAN-5884: unchanged-handler captures over real local Git worktrees.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import type { MergeLocalBranchesResponse } from '@canopy/desktop-shared/types/github';

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../lib/github-poller', () => ({
  refreshNow: jest.fn(() => Promise.resolve(null)),
  requestRefresh: jest.fn(),
  startPolling: jest.fn(),
  enqueueFastRefresh: jest.fn(),
  enqueueKnownPrFastRefresh: jest.fn(() => Promise.resolve(false)),
  setForegroundWorktree: jest.fn(),
  isPrHookActiveForRepo: jest.fn(() => false),
  suspendTrackingForE2e: jest.fn(),
}));
jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(() => ({})),
}));
jest.mock('../lib/rebase-resolution-chat', () => ({
  launchRebaseResolutionChat: jest.fn(() =>
    Promise.resolve({ chatId: 'chat-1' }),
  ),
}));
jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));

import { registerGitHubHandlers } from '../ipc/github';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { enqueueFastRefresh, requestRefresh } from '../lib/github-poller';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

jest.setTimeout(120_000);

const SINGLE = 'merge-ws';
let dir: string;
let dataDir: string;
let runtime: DesktopCanopyDispatcher;
let originalDataDir: string | undefined;
let originalGitEnv: [string, string | undefined][];
const sent: { channel: string; payload: unknown }[] = [];
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function commit(path: string, content: string): string {
  writeFileSync(join(path, 'file.txt'), content);
  git(path, ['add', '.']);
  git(path, ['commit', '-qm', content]);
  return git(path, ['rev-parse', 'HEAD']);
}
function fixture(
  id: string,
  temporary = false,
): { source: string; base: string; tip: string } {
  const base = join(dir, id);
  mkdirSync(base);
  git(base, ['init', '-q', '-b', 'main']);
  git(base, ['config', 'user.email', 'merge@example.com']);
  git(base, ['config', 'user.name', 'Merge']);
  commit(base, 'initial');
  const source = join(dataDir, 'workspaces', SINGLE, 'worktrees', id);
  git(base, ['worktree', 'add', '-qb', id, source]);
  const tip = commit(source, 'source');
  if (temporary) git(base, ['checkout', '-qb', 'other']);
  writeJson(join(dataDir, 'workspaces', SINGLE, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: base,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', SINGLE, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id,
        name: id,
        branchName: id,
        createdAt: 'now',
        trackedBaseBranch: 'main',
      },
    ],
  });
  return { source, base, tip };
}
async function merge(id: string): Promise<MergeLocalBranchesResponse> {
  const handler = mockHandlers.get(IPC_CHANNELS.githubMergeLocalBranches);
  if (!handler) throw new Error('merge handler missing');
  sent.length = 0;
  return (await handler(
    {},
    { projectId: SINGLE, worktreeId: id },
  )) as MergeLocalBranchesResponse;
}
const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};
function adoptHostRealmErrors(): () => void {
  const ordinary = Function.prototype[Symbol.hasInstance];
  Object.defineProperty(Error, Symbol.hasInstance, {
    configurable: true,
    value: function (this: unknown, value: unknown): boolean {
      return this === Error
        ? Object.prototype.toString.call(value) === '[object Error]'
        : ordinary.call(this, value);
    },
  });
  return () => {
    Reflect.deleteProperty(Error, Symbol.hasInstance);
  };
}
let restoreErrorRealm = (): void => undefined;

beforeAll(() => {
  restoreErrorRealm = adoptHostRealmErrors();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'merge-golden-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  originalGitEnv = Object.entries(process.env).filter(([key]) =>
    key.startsWith('GIT_'),
  );
  for (const [key] of originalGitEnv) delete process.env[key];
  const config = join(dir, 'gitconfig');
  writeFileSync(
    config,
    '[user]\n\temail = merge@example.com\n\tname = Merge\n',
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: SINGLE,
        name: SINGLE,
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  registerWorkspaceTypes(
    new Map<string, WorkspaceType>([[SINGLE, 'single-repo']]),
  );
  runtime = createDesktopRuntime();
  registerGitHubHandlers(
    () =>
      ({
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sent.push({ channel, payload });
          },
          isDestroyed: () => false,
          isCrashed: () => false,
          mainFrame: { isDestroyed: () => false, detached: false },
        },
      }) as unknown as BrowserWindow,
    { dispatcher: runtime, resolveCaller: () => caller },
  );
});
afterAll(async () => {
  await runtime.shutdown();
  restoreErrorRealm();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  for (const key of Object.keys(process.env))
    if (key.startsWith('GIT_')) delete process.env[key];
  for (const [key, value] of originalGitEnv) process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});
useFakeSplitLockKeys();
beforeEach(() => {
  jest.mocked(requestRefresh).mockClear();
  jest.mocked(enqueueFastRefresh).mockClear();
});
for (const temporary of [false, true]) {
  it(`merges source into ${temporary ? 'temporary' : 'existing'} base worktree, keeping source unchanged`, async () => {
    const id = temporary ? 'temp-success' : 'existing-success';
    const { source, base, tip } = fixture(id, temporary);
    const beforeWorktrees = git(base, ['worktree', 'list', '--porcelain']);
    expect(await merge(id)).toEqual({
      repos: [
        {
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoName: id,
          branchName: id,
          baseBranch: 'main',
          mergeCommitHash: tip,
          status: 'success',
        },
      ],
      skippedRepos: [],
      failedRepos: [],
    });
    expect(git(base, ['rev-parse', 'main'])).toBe(tip);
    expect(git(source, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(git(source, ['branch', '--show-current'])).toBe(id);
    expect(
      git(base, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree ')),
    ).toEqual(
      beforeWorktrees
        .split('\n')
        .filter((line) => line.startsWith('worktree ')),
    );
    expect(requestRefresh).toHaveBeenCalledWith(SINGLE, id, true);
    expect(enqueueFastRefresh).toHaveBeenCalledWith(SINGLE, id, false);
  });
  it(`aborts conflict in ${temporary ? 'temporary' : 'existing'} base without changing either head or refreshing`, async () => {
    const id = temporary ? 'temp-conflict' : 'existing-conflict';
    const { source, base, tip } = fixture(id);
    const baseTip = commit(base, 'base');
    if (temporary) git(base, ['checkout', '-qb', 'other']);
    const result = await merge(id);
    const anyString: unknown = expect.any(String);
    expect(result).toEqual({
      repos: [],
      skippedRepos: [],
      failedRepos: [
        {
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoName: id,
          branchName: id,
          baseBranch: 'main',
          error: anyString,
          status: 'failed',
        },
      ],
    });
    expect(
      result.failedRepos[0]?.error?.replace(
        /^Command failed: .+ (?=merge --no-edit )/,
        'Command failed: <git> ',
      ),
    ).toBe(`Command failed: <git> merge --no-edit ${id}\n`);
    expect(isGitActionActive({ projectId: SINGLE, worktreeId: id })).toBe(
      false,
    );
    expect(git(base, ['rev-parse', 'main'])).toBe(baseTip);
    expect(git(source, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(git(base, ['status', '--porcelain'])).toBe('');
    expect(
      git(base, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree ')),
    ).toHaveLength(2);
    expect(requestRefresh).not.toHaveBeenCalled();
    expect(enqueueFastRefresh).not.toHaveBeenCalled();
  });
}
it('refuses a dirty base without changing it', async () => {
  const { base } = fixture('dirty-base');
  writeFileSync(join(base, 'untracked.txt'), 'keep');
  expect(await merge('dirty-base')).toEqual({
    repos: [],
    skippedRepos: [],
    failedRepos: [
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'dirty-base',
        branchName: 'dirty-base',
        baseBranch: 'main',
        error:
          'Cannot merge into "main" because its worktree has uncommitted changes',
        status: 'failed',
      },
    ],
  });
  expect(readFileSync(join(base, 'untracked.txt'), 'utf8')).toBe('keep');
});
it('skips an uncommitted source', async () => {
  const { source } = fixture('dirty-source');
  writeFileSync(join(source, 'untracked.txt'), 'keep');
  expect(await merge('dirty-source')).toEqual({
    repos: [],
    failedRepos: [],
    skippedRepos: [
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'dirty-source',
        reason: 'uncommitted_changes',
      },
    ],
  });
});
it('refuses detached HEAD', async () => {
  const { source } = fixture('detached');
  git(source, ['checkout', '-q', '--detach']);
  expect(await merge('detached')).toEqual({
    repos: [],
    skippedRepos: [],
    failedRepos: [
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'detached',
        branchName: 'HEAD',
        error:
          'Cannot merge from detached HEAD. Check out a named branch first.',
        status: 'failed',
      },
    ],
  });
});
it('reports the all-remote refusal without refreshing', async () => {
  const { source } = fixture('remote');
  git(source, ['remote', 'add', 'origin', join(dir, 'absent.git')]);
  await expect(merge('remote')).rejects.toThrow(
    'No local-only repos had committed changes to merge.',
  );
  expect(requestRefresh).not.toHaveBeenCalled();
});
it('skips a source with no commits ahead', async () => {
  const { source } = fixture('no-ahead');
  git(source, ['reset', '--hard', 'main']);
  expect(await merge('no-ahead')).toEqual({
    repos: [],
    failedRepos: [],
    skippedRepos: [
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: 'no-ahead',
        reason: 'no_commits_ahead',
      },
    ],
  });
});

it('creates a real merge commit on divergent nonconflicting branches', async () => {
  const { source, base, tip } = fixture('merge-commit');
  writeFileSync(join(base, 'base-only'), 'base');
  git(base, ['add', '.']);
  git(base, ['commit', '-qm', 'base-only']);
  const baseTip = git(base, ['rev-parse', 'HEAD']);
  const result = await merge('merge-commit');
  const merged = git(base, ['rev-parse', 'HEAD']);
  expect(result.repos[0]?.mergeCommitHash).toBe(merged);
  expect(git(base, ['rev-parse', 'HEAD^1'])).toBe(baseTip);
  expect(git(base, ['rev-parse', 'HEAD^2'])).toBe(tip);
  expect(git(source, ['rev-parse', 'HEAD'])).toBe(tip);
});
it('skips same or missing tracked base without events', async () => {
  fixture('base-skips');
  for (const [base, reason] of [
    ['base-skips', 'same_branch'],
    ['missing', 'missing_base_branch'],
  ]) {
    writeJson(join(dataDir, 'workspaces', SINGLE, 'worktrees.json'), {
      version: 1,
      worktrees: [
        {
          id: 'base-skips',
          branchName: 'base-skips',
          createdAt: 'now',
          trackedBaseBranch: base,
        },
      ],
    });
    expect(await merge('base-skips')).toEqual({
      repos: [],
      failedRepos: [],
      skippedRepos: [
        { repoId: SINGLE_REPO_USAGE_REPO_ID, repoName: 'base-skips', reason },
      ],
    });
    expect(requestRefresh).not.toHaveBeenCalled();
    expect(enqueueFastRefresh).not.toHaveBeenCalled();
  }
});

it('keeps source Split exclusion and Git-action locking ahead of every merge', async () => {
  const { base } = fixture('locked');
  const tip = git(base, ['rev-parse', 'HEAD']);
  await acquireSplitLock(SINGLE, 'locked');
  try {
    await expect(merge('locked')).rejects.toThrow(
      'This worktree is locked while a Split PR is in progress; running a Git action is unavailable until it finishes.',
    );
  } finally {
    releaseSplitLock(SINGLE, 'locked');
  }
  const request = { projectId: SINGLE, worktreeId: 'locked' };
  const held = beginExclusiveGitAction(request);
  try {
    await expect(merge('locked')).rejects.toThrow();
  } finally {
    finishGitActionCancellationScope(request, held);
  }
  expect(git(base, ['rev-parse', 'HEAD'])).toBe(tip);
  expect(isGitActionActive(request)).toBe(false);
  expect(requestRefresh).not.toHaveBeenCalled();
});
